import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import { restoreOwnPlannedMealsSnapshot, extractPlannedMealsSnapshot } from '@/lib/planned-meals-snapshot';
import { internalError } from '@/lib/api/errors';
import {
  WEEKLY_MENU_REQUEST_STALE_TARGET_STATUSES,
  isWeeklyMenuRequestStale,
  markWeeklyMenuRequestStaleIfUnchanged,
} from '@/lib/weekly-menu-request-stale';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_MENU_NO_STUCK_REQUESTS_MESSAGE, AI_MENU_STUCK_REQUESTS_CLEANED_MESSAGE } from '@/lib/ai/ai-api-messages';

// #1203: 復元（スナップショットの書き戻し）が途中で打ち切られないよう、実行時間の上限を明示する。
// 復元は 1 リクエストあたり DB 2 往復前後だが、failed 確定後に復元へ入る順序のため余裕を持たせる。
export const maxDuration = 60; // Vercel Pro: 60s OK

/**
 * 止まった生成のリクエストを failed にする (週間ページ weekly/page.tsx を開くたびに呼ばれる)。
 *
 * #1494: 以前は作成から 5 分を過ぎた queued / pending / processing をすべて failed にしていた。
 *   - queued は cron (process-menu-queue) の順番待ちで、混んでいると 5 分を超えて待つ。v5/generate は積んだ時点で
 *     AI の 1 回を数える (#1149) ので、順番待ちの行を failed にすると数えた 1 回が成果なしで消えていた。
 *   - 生成中 (processing) の行も、進捗を書き続けていても作成から 5 分で failed になっていた。
 * いまは src/lib/weekly-menu-request-stale.ts の判定 (queued は対象外・生存信号から 20 分。status / pending の route と同じ判定)
 * で止まった行だけを failed にする。
 *
 * 【数え戻しはしない】(#1149 の方針: AI へ送る前の失敗は戻す、送ったあとは戻さない)
 * ここで failed にするのは pending / processing の行だけ。processing の行は、キューが取って Edge Function を呼んだ行
 * (worker_acquired_at がある) か、route が Edge Function を呼ぶ前提で processing で作った行で、AI へ送ったかどうかは
 * 行の状態から判定できない。送ったあとかもしれない失敗を戻すと、失敗を繰り返して上限を超えて使えるので戻さない。
 * (行には数えた日 (usageDate) も残っていないので、refundAiUsage に渡す材料も無い。AI へ送る前の queued の行は対象外にした)
 *
 * 【読んでから書くまでのあいだに進んだ行は failed にしない】
 * 読んだときの状態・updated_at・worker_acquired_at がそのままの行だけを書き換える (行ごとの比較つきの更新。
 * src/lib/weekly-menu-request-stale.ts の markWeeklyMenuRequestStaleIfUnchanged。status / pending の route と同じ)。
 * そのあいだに Edge Function が進捗を書いた・cron が取り直した・生成が終わった行は、書き換えずに残す。
 *
 * 【更新が途中の行で失敗しても、failed にできた行の復元は済ませる】
 * 行ごとの更新なので、1 行目は failed にできて 2 行目の更新だけが失敗することがある。そのときも途中で 500 を返して
 * 抜けず、残りの行の更新と、failed にできた行のスナップショットの復元 (#1042) を済ませてから 500 を返す。
 */
export async function POST() {
  const supabase = await createClient();
  
  // 認証チェック
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  // 自分の生成中の行を読む (止まったかの判定は生存信号で行うので、ここでは時刻で絞らない。
  // generated_data は生成中に大きくなるので読まず、failed にした行の分だけ更新の戻り値で受け取る。#1042)
  const { data: inFlightRequests, error: fetchError } = await supabase
    .from('weekly_menu_requests')
    .select('id, status, created_at, updated_at, worker_acquired_at')
    .eq('user_id', user.id)
    .in('status', [...WEEKLY_MENU_REQUEST_STALE_TARGET_STATUSES]);

  if (fetchError) {
    return internalError('POST /api/ai/menu/weekly/cleanup', fetchError, { userId: user.id });
  }

  const nowMs = Date.now();
  const stuckRequests = (inFlightRequests ?? []).filter((row) => isWeeklyMenuRequestStale(row, nowMs));

  if (stuckRequests.length === 0) {
    return NextResponse.json({ message: AI_MENU_NO_STUCK_REQUESTS_MESSAGE, cleaned: 0 });
  }

  // スタックしているリクエストをfailedに更新
  // weekly_menu_requests は利用者 (authenticated) から書けない (#1465)。本人の行に絞って service role で書く
  const queueDb = getAiQueueWriter();
  const failedAt = new Date(nowMs).toISOString();
  const cleanedRequests: Array<{ id: string; generated_data: unknown }> = [];
  // 更新に失敗した行のエラー。1 行の更新が失敗しても途中で抜けずに残りの行へ進み、failed にできた行の復元を
  // 済ませてから 500 を返す。途中で抜けると、それまでに failed にした行の復元 (#1042) が行われない。failed の行は
  // cleanup・status・pending のどれにも二度と拾われないので、生成の Step2 で消した献立が戻らなくなる。
  // DB が更新を拒んだ行は (1 つの UPDATE 文なので) 書き換わっておらず pending / processing のままなので、次に週間ページを
  // 開いたときにやり直せる (応答だけが届かずに書き換わっていた行は救えない。これは 1 本の UPDATE だった以前も同じ)。
  const updateErrors: unknown[] = [];
  for (const stuckRequest of stuckRequests) {
    // 読んだときから状態・生存信号が変わっていない行だけを書き換える (比較つきの更新。#1494・#1507)
    const { rows: updatedRows, error: updateError } = await markWeeklyMenuRequestStaleIfUnchanged({
      supabase: queueDb,
      userId: user.id,
      row: stuckRequest,
      failedAt,
    });

    if (updateError) {
      updateErrors.push(updateError);
      continue;
    }
    cleanedRequests.push(...updatedRows);
  }

  // #1042: waitUntil 消失等で生成コールバックが実行されず stuck になったリクエストについて、
  // 削除済み献立のスナップショットが残っていれば復元する（sweeper 経由の救済ロールバック）。
  // #1203: 復元は 1 リクエストあたり 2 往復前後に減ったので、リクエスト間は直列のままにしている。
  // 並列にすると、同じ週に stuck が複数あるとき（snapshot が同じスロットを指す）に
  // 「空きスロット確認」が互いの書き込み前に行われ、同じスロットへ二重に復元してしまう。
  // #1494: 復元するのは、実際に failed にした行 (読んでから書くまでに進んだ行を除く) だけ。
  let restoredMeals = 0;
  let skippedMeals = 0;
  let failedMeals = 0;
  for (const cleanedRequest of cleanedRequests) {
    const snapshot = extractPlannedMealsSnapshot(cleanedRequest.generated_data);
    if (snapshot.length === 0) continue;
    // planned_meals の 3 列は利用者から INSERT できない (#2025)。本人の日を確かめてから service role で戻す
    const restoreResult = await restoreOwnPlannedMealsSnapshot({ userDb: supabase, writer: getSupabaseAdmin(), snapshot });
    restoredMeals += restoreResult.restored;
    skippedMeals += restoreResult.skipped;
    failedMeals += restoreResult.failed;
    console.log(
      `🔁 [stale sweeper/cleanup] Restored meals for request ${cleanedRequest.id}: restored=${restoreResult.restored} skipped=${restoreResult.skipped} failed=${restoreResult.failed}`,
    );
  }

  const cleanedIds = cleanedRequests.map((r) => r.id);
  if (updateErrors.length > 0) {
    // 復元を済ませたうえで、更新に失敗した行があったことを 500 で返す (ログには最初のエラーと件数を残す)
    return internalError('POST /api/ai/menu/weekly/cleanup', updateErrors[0], {
      userId: user.id,
      failedUpdates: updateErrors.length,
      cleaned: cleanedIds.length,
      restoredMeals,
      skippedMeals,
      failedMeals,
    });
  }
  return NextResponse.json({
    message: cleanedIds.length > 0 ? AI_MENU_STUCK_REQUESTS_CLEANED_MESSAGE : AI_MENU_NO_STUCK_REQUESTS_MESSAGE,
    cleaned: cleanedIds.length,
    ids: cleanedIds,
    restoredMeals,
    skippedMeals,
    failedMeals,
  });
}

// GETでステータス確認
export async function GET() {
  const supabase = await createClient();
  
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { data: requests, error } = await supabase
    .from('weekly_menu_requests')
    .select('id, mode, status, created_at, updated_at')
    .eq('user_id', user.id)
    .in('status', ['queued', 'pending', 'processing'])
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    return internalError('GET /api/ai/menu/weekly/cleanup', error, { userId: user.id });
  }

  return NextResponse.json({ 
    stuckRequests: requests,
    count: requests?.length ?? 0
  });
}
