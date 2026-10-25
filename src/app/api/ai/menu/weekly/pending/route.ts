import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import { restoreOwnPlannedMealsSnapshot, extractPlannedMealsSnapshot } from '@/lib/planned-meals-snapshot';
import { internalError } from '@/lib/api/errors';
import { isWeeklyMenuRequestStale, markWeeklyMenuRequestStaleIfUnchanged } from '@/lib/weekly-menu-request-stale';
import { WEEKLY_MENU_REQUEST_ULTIMATE_MODE_SELECT } from '@/lib/ai/weekly-menu-request-ultimate';
// 究極モードの判定は Web とモバイルで同じ基準にするため @homegohan/shared に置く (#1609)
import { isUltimateModeWeeklyMenuRequest } from '@homegohan/shared';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { aiRequiredFieldMessage } from '@/lib/ai/ai-api-messages';

// #1203: stale 判定時の復元（スナップショットの書き戻し）が打ち切られないよう、実行時間の上限を明示する。
export const maxDuration = 60; // Vercel Pro: 60s OK

// 週間生成中のリクエストがあるか確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');
  if (!date) {
    return NextResponse.json({ error: aiRequiredFieldMessage('日付') }, { status: 400 });
  }

  try {
    console.log('🔍 Pending check - input date:', date);
    console.log('🔍 Pending check - user_id:', user.id);

    // ユーザーの最新の queued / pending / processing の週間生成リクエストを確認
    // start_date に関係なく、最新のリクエストを返す（リロード時の復元を確実にするため）
    // mode='weekly', mode='v4', mode='v5', mode=null のすべてを対象
    // #1042: 通常ポーリング（3秒間隔）では生成中に肥大化する generated_data(jsonb) を
    // select しない。止まった行を failed にしたときだけ、更新の戻り値で受け取る。
    // 止まったかの判定は cleanup と同じ生存信号 (created_at・updated_at・worker_acquired_at) で行う (#1507)
    // 究極モードの生成かは generated_data.ultimateMode だけを取り出して読む (#1582。mode は v4 / v5 のエンジンで、究極モードを表さない)
    const { data: pendingRequest, error } = await supabase
      .from('weekly_menu_requests')
      .select(`id, status, mode, start_date, created_at, updated_at, worker_acquired_at, ${WEEKLY_MENU_REQUEST_ULTIMATE_MODE_SELECT}`)
      .eq('user_id', user.id)
      .or('mode.eq.weekly,mode.eq.v4,mode.eq.v5,mode.is.null')
      .in('status', ['queued', 'pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    console.log('🔍 Pending check - query result:', pendingRequest);
    console.log('🔍 Pending check - query error:', error);
    
    if (error && error.code !== 'PGRST116') {
      // PGRST116 = no rows returned
      throw error;
    }

    if (pendingRequest) {
      // 止まったかの判定・failed への書き換えは src/lib/weekly-menu-request-stale.ts に寄せる (cleanup と同じ。#1494・#1507)。
      // queued (cron の順番待ち)・生存信号が新しい行 (claim_menu_request が取り直した直後の行を含む)・
      // 時刻が読めない行は止まっていない (以前は時刻が読めない行を止まったと扱っていた)
      const nowMs = Date.now();
      if (isWeeklyMenuRequestStale(pendingRequest, nowMs)) {
        // weekly_menu_requests は利用者 (authenticated) から書けない (#1465)。本人の行に絞って service role で書く
        const queueDb = getAiQueueWriter();
        // 読んだときから状態・生存信号が変わっていない行だけを書き換える (読んでから書くまでに進んだ行は failed にしない)
        const { rows: failedRows, error: staleError } = await markWeeklyMenuRequestStaleIfUnchanged({
          supabase: queueDb,
          userId: user.id,
          row: pendingRequest,
          failedAt: new Date(nowMs).toISOString(),
        });
        if (staleError) {
          // 更新が拒まれた行は書き換わっていない。生成中の行として返し、次の確認でやり直す
          console.error('Failed to mark stale weekly request as failed:', staleError);
        }

        const failedRow = failedRows.find((row) => row.id === pendingRequest.id);
        if (failedRow) {
          // プレースホルダーは使用しないので、is_generating のクリアは不要

          // #1042: waitUntil 消失等で生成コールバックが実行されず stale になったケースでも、
          // 削除済み献立のスナップショットが残っていれば復元する（sweeper 経由の救済ロールバック）。
          // 復元するのは、実際に failed にした行 (読んでから書くまでに進んだ行を除く) だけ (#1507)。
          const snapshot = extractPlannedMealsSnapshot(failedRow.generated_data);
          let restoreResult: { restored: number; skipped: number; failed: number } | null = null;
          if (snapshot.length > 0) {
            // planned_meals の 3 列は利用者から INSERT できない (#2025)。本人の日を確かめてから service role で戻す
            restoreResult = await restoreOwnPlannedMealsSnapshot({ userDb: supabase, writer: getSupabaseAdmin(), snapshot });
            console.log(
              `🔁 [stale sweeper/pending] Restored meals for request ${pendingRequest.id}: restored=${restoreResult.restored} skipped=${restoreResult.skipped} failed=${restoreResult.failed}`,
            );
          }

          return NextResponse.json({
            hasPending: false,
            ...(restoreResult ? { restore: restoreResult } : {}),
          });
        }
        // 書き換わらなかった行は、読んでから書くまでに進んだ行か、更新が拒まれた行。止まったとは扱わず、生成中の行として返す
      }

      if (pendingRequest.start_date && pendingRequest.start_date !== date) {
        // 他週の生成中は復元しない（自動で週が切り替わるのを防ぐ）
        return NextResponse.json({ hasPending: false });
      }

      console.log('✅ Found pending request:', pendingRequest.id, pendingRequest.status, 'for start_date:', pendingRequest.start_date);
      return NextResponse.json({
        hasPending: true,
        requestId: pendingRequest.id,
        status: pendingRequest.status,
        mode: pendingRequest.mode,
        // 究極モードの生成か (#1582)。Web の週間献立画面は、画面に入り直したときの進捗カードの種類をこれで決める
        // (モバイルの週間献立のネイティブの画面も同じだったが、#1598 で消した)
        ultimateMode: isUltimateModeWeeklyMenuRequest(pendingRequest.ultimate_mode),
        startDate: pendingRequest.start_date,
        createdAt: pendingRequest.created_at,
      });
    }

    console.log('❌ No pending request found for user');
    return NextResponse.json({ hasPending: false });

  } catch (error: any) {
    return internalError('GET /api/ai/menu/weekly/pending', error, { userId: user.id });
  }
}
