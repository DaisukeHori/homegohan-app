import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import { restorePlannedMealsSnapshot, extractPlannedMealsSnapshot } from '@/lib/planned-meals-snapshot';
import { internalError } from '@/lib/api/errors';
import { isWeeklyMenuRequestStale, markWeeklyMenuRequestStaleIfUnchanged } from '@/lib/weekly-menu-request-stale';
import {
  WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE,
  WEEKLY_MENU_REQUEST_STALE_DISPLAY_MESSAGE,
  weeklyMenuRequestErrorMessageForResponse,
} from '@/lib/weekly-menu-request-error';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { awardBadge } from '@/lib/badges/awardBadge';
import {
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT,
  isWeeklyMenuRequestWeeklyOrigin,
} from '@/lib/ai/weekly-menu-request-origin';

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
    // AI で複数の日の献立をまとめて作った生成 (src/lib/ai/weekly-menu-request-origin.ts) の行かは、generated_data の印だけを取り出して読む (#1867。planner の付与に使う)
    const { data: request, error } = await supabase
      .from('weekly_menu_requests')
      .select(`id, status, error_message, created_at, updated_at, worker_acquired_at, mode, start_date, target_meal_id, progress, ${WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT}`)
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

        // 行には英語の印 (WEEKLY_MENU_REQUEST_STALE_MESSAGE) を書いたが、本文には日本語の文を返す
        // (行を読み直した次のポーリングも weeklyMenuRequestErrorMessageForResponse で同じ文になる。#1576)
        return NextResponse.json({
          status: 'failed',
          errorMessage: WEEKLY_MENU_REQUEST_STALE_DISPLAY_MESSAGE,
          error_message: WEEKLY_MENU_REQUEST_STALE_DISPLAY_MESSAGE,
          updatedAt: failedAt,
          ...(restoreResult ? { restore: restoreResult } : {}),
        });
      }
      // 書き換わらなかった行は、読んでから書くまでに進んだ (進捗を書いた・取り直された・終わった) 行か、更新が拒まれた行。
      // 止まったとは扱わず、読んだ状態を返す (次のポーリングで新しい状態を読む)
    }

    // error_message には、この変更より前に書かれた行や Edge Function が自分で書いた行の、生のエラー文
    // (DB・例外・Edge Function の応答の本文) が入っていることがある。こちらで書いた文 (同意・stale・中止) だけを
    // そのまま返し (stale の英語の印は日本語の文にする。#1576)、それ以外は固定の文にする (#1172)
    const errorMessage = weeklyMenuRequestErrorMessageForResponse(request.error_message);

    // #1867 「計画上手」(planner) は、AI で複数の日 (2 日以上) の献立を初めてまとめて作ったときにも付ける。
    // 週の献立の生成は Edge Function (generate-menu-v4 / v5) が裏で進め、献立を保存し終えると行を completed にする
    // (1 食も保存できなかったとき・利用者が中止したとき・止まったときは failed)。付与の本体は、行が completed になった時点で付ける
    // DB のトリガー weekly_menu_requests_award_planner (supabase/migrations/20261018060000_planner_badge_award_on_weekly_menu_completed.sql)。
    // 画面は完了を主に行の変化 (Realtime) で知り (モバイルはこの状態の確認を呼ばない)、ここは Web の代替の経路なので、ここでの付与はトリガーが付け損ねたときの保険:
    // 本人が完了 (completed) を読んだときに、週の献立の生成の行 (印あり) なら本人に付ける。印を書くのは複数の日の生成
    // (POST /api/ai/menu/v4/generate・/v5/generate で対象が複数の日 (2 日以上) にわたるとき・AI 相談の 1 週間分の生成・POST /api/ai/menu/weekly/request)
    //   - 付けるのは行の持ち主 (上の読み取りを user.id の行に絞っている) で、家族の人数分の献立でも依頼した本人だけ
    //   - awardBadge は冪等 (付与済みなら何もしない)。トリガーや使い方ガイドのお試し (POST /api/menu-plans/add) で付いていても、
    //     完了の後のポーリングが続いても、user_badges は 1 行のまま
    //   - 1 食・1 日の生成、献立の改善の行 (印なし) では付けない
    //   - 付与は副次処理。失敗しても状態の確認の応答は変えない (awardBadge が構造化ログに残す。付け損ねた分は GET /api/badges が拾う)
    // user_badges には利用者の INSERT ポリシーが無いので、service role で付ける (POST /api/menu-plans/add と同じ)
    if (request.status === 'completed' && isWeeklyMenuRequestWeeklyOrigin(request.weekly_request)) {
      try {
        const supabaseAdmin = getSupabaseAdmin();
        await awardBadge(supabaseAdmin, user.id, 'planner');
      } catch (badgeError) {
        console.error('planner badge award after weekly menu generation failed (non-fatal):', badgeError);
      }
    }

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
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
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
