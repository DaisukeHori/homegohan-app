import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import { restorePlannedMealsSnapshot, extractPlannedMealsSnapshot } from '@/lib/planned-meals-snapshot';
import { internalError } from '@/lib/api/errors';
import { isWeeklyMenuRequestStale, markWeeklyMenuRequestStaleIfUnchanged } from '@/lib/weekly-menu-request-stale';
import {
  WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE,
  WEEKLY_MENU_REQUEST_STALE_MESSAGE,
  weeklyMenuRequestErrorMessageForResponse,
} from '@/lib/weekly-menu-request-error';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

// #1203: stale 判定時の復元（スナップショットの書き戻し）が打ち切られないよう、実行時間の上限を明示する。
export const maxDuration = 60; // Vercel Pro: 60s OK

// リクエストのステータスを確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get('requestId');
  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  try {
    // #1042: 通常ポーリング（3秒間隔）では生成中に肥大化する generated_data(jsonb) を
    // select しない。止まった行を failed にしたときだけ、更新の戻り値で受け取る。
    // 止まったかの判定は cleanup と同じ生存信号 (created_at・updated_at・worker_acquired_at) で行う (#1507)
    const { data: request, error } = await supabase
      .from('weekly_menu_requests')
      .select('id, status, error_message, created_at, updated_at, worker_acquired_at, mode, start_date, target_meal_id, progress')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) throw error;

    if (!request) {
      return NextResponse.json({
        status: 'not_found',
        requestId,
      });
    }

    // 止まったかの判定・failed への書き換えは src/lib/weekly-menu-request-stale.ts に寄せる (cleanup と同じ。#1494・#1507)。
    // queued (cron の順番待ち)・生存信号が新しい行 (claim_menu_request が取り直した直後の行を含む)・時刻が読めない行は止まっていない
    const nowMs = Date.now();
    if (isWeeklyMenuRequestStale(request, nowMs)) {
      // weekly_menu_requests は利用者 (authenticated) から書けない (#1465)。本人の行に絞って service role で書く
      const queueDb = getAiQueueWriter();
      const failedAt = new Date(nowMs).toISOString();
      // 読んだときから状態・生存信号が変わっていない行だけを書き換える (読んでから書くまでに進んだ行は failed にしない)
      const { rows: failedRows, error: staleError } = await markWeeklyMenuRequestStaleIfUnchanged({
        supabase: queueDb,
        userId: user.id,
        row: request,
        failedAt,
      });
      if (staleError) {
        // 更新が拒まれた行は書き換わっていない。読んだ状態をそのまま返し、次のポーリングでやり直す
        console.error('Failed to mark stale request as failed:', staleError);
      }

      const failedRow = failedRows.find((row) => row.id === request.id);
      if (failedRow) {
        // プレースホルダーは使用しないので、is_generating のクリアは不要

        // #1042: waitUntil 消失等で生成コールバックが実行されず stale になったケースでも、
        // 削除済み献立のスナップショットが残っていれば復元する（sweeper 経由の救済ロールバック）。
        // 復元するのは、実際に failed にした行 (読んでから書くまでに進んだ行を除く) だけ (#1507)。
        const snapshot = extractPlannedMealsSnapshot(failedRow.generated_data);
        let restoreResult: { restored: number; skipped: number; failed: number } | null = null;
        if (snapshot.length > 0) {
          restoreResult = await restorePlannedMealsSnapshot(supabase, snapshot);
          console.log(
            `🔁 [stale sweeper/status] Restored meals for request ${requestId}: restored=${restoreResult.restored} skipped=${restoreResult.skipped} failed=${restoreResult.failed}`,
          );
        }

        return NextResponse.json({
          status: 'failed',
          errorMessage: WEEKLY_MENU_REQUEST_STALE_MESSAGE,
          updatedAt: failedAt,
          ...(restoreResult ? { restore: restoreResult } : {}),
        });
      }
      // 書き換わらなかった行は、読んでから書くまでに進んだ (進捗を書いた・取り直された・終わった) 行か、更新が拒まれた行。
      // 止まったとは扱わず、読んだ状態を返す (次のポーリングで新しい状態を読む)
    }

    // error_message には、この変更より前に書かれた行や Edge Function が自分で書いた行の、生のエラー文
    // (DB・例外・Edge Function の応答の本文) が入っていることがある。こちらで書いた文 (同意・stale・中止) だけを
    // そのまま返し、それ以外は固定の文にする (#1172)
    const errorMessage = weeklyMenuRequestErrorMessageForResponse(request.error_message);
    return NextResponse.json({
      status: request.status,
      errorMessage,
      error_message: errorMessage,
      updatedAt: request.updated_at,
      progress: request.progress,
    });

  } catch (error: any) {
    return internalError('GET /api/ai/menu/weekly/status', error, { userId: user.id, requestId });
  }
}

// UX2-11: AI 生成の中止。weekly_menu_requests.status の CHECK 制約に 'cancelled' は
// 存在しない（migration 追加は本 Issue のスコープ外のため報告のみ）。既存の 'failed' + 判別可能な
// error_message で「ユーザーによる中止」を表現する。既に completed/failed の場合は上書きしない。
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) が拒んで 500 になる。認証・DB に触れる前に 400 で断る (#1657)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { requestId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { requestId } = body;
  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('weekly_menu_requests')
      .select('id, status')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // 既に確定済み（completed/failed）の場合は上書きしない
    if (existing.status === 'completed' || existing.status === 'failed') {
      return NextResponse.json({ status: existing.status, cancelled: false });
    }

    // weekly_menu_requests は利用者 (authenticated) から書けない (#1465)。本人の行に絞って service role で書く
    const queueDb = getAiQueueWriter();
    const { error: updateError } = await queueDb
      .from('weekly_menu_requests')
      .update({
        status: 'failed',
        error_message: WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE,
        updated_at: new Date().toISOString(),
      })
      .eq('id', requestId)
      .eq('user_id', user.id);

    if (updateError) throw updateError;

    return NextResponse.json({ status: 'failed', cancelled: true });
  } catch (error: any) {
    return internalError('POST /api/ai/menu/weekly/status', error, { userId: user.id, requestId });
  }
}
