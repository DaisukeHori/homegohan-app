import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { isCalendarDate, sundayWeekRange } from '@/lib/jst-day-ranges';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { isWeeklyMenuRequestStale, markWeeklyMenuRequestStaleIfUnchanged } from '@/lib/weekly-menu-request-stale';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { aiInvalidDateMessage } from '@/lib/ai/ai-api-messages';

// 単一食事の生成中リクエストがあるか確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const weekStartDate = searchParams.get('date'); // 週の開始日
  const mealType = searchParams.get('mealType');
  try {
    // 週の日付範囲を計算
    let startDate: string | null = null;
    let endDate: string | null = null;
    
    if (weekStartDate) {
      // 日曜日から土曜日までの週を、暦の計算だけで求める (#1433。実行環境のタイムゾーンに左右されない)
      if (!isCalendarDate(weekStartDate)) {
        return NextResponse.json({ error: aiInvalidDateMessage('日付') }, { status: 400 });
      }
      ({ startDate, endDate } = sundayWeekRange(weekStartDate));
    }

    // pending または processing の単一食事リクエストを確認
    // (止まったかの判定に使う生存信号 created_at・updated_at・worker_acquired_at も読む。cleanup と同じ判定。#1507)
    let query = supabase
      .from('weekly_menu_requests')
      .select('id, status, target_date, target_meal_type, target_meal_id, mode, created_at, updated_at, worker_acquired_at')
      .eq('user_id', user.id)
      .in('mode', ['single', 'regenerate'])
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false });

    // 週の範囲でフィルタ
    if (startDate && endDate) {
      query = query.gte('target_date', startDate).lte('target_date', endDate);
    }
    if (mealType) {
      query = query.eq('target_meal_type', mealType);
    }

    const { data: pendingRequests, error } = await query.limit(10);

    if (error) throw error;

    if (pendingRequests && pendingRequests.length > 0) {
      // 止まったかの判定・failed への書き換えは src/lib/weekly-menu-request-stale.ts に寄せる (cleanup と同じ。#1494・#1507)。
      // 生存信号が新しい行 (claim_menu_request が取り直した直後の行を含む)・時刻が読めない行は止まっていない
      // (以前は時刻が読めない行を止まったと扱っていた)
      const nowMs = Date.now();
      const staleRequests = pendingRequests.filter((r) => isWeeklyMenuRequestStale(r, nowMs));
      // 実際に failed にした行の id。読んでから書くまでに進んだ行・更新が拒まれた行は含めない (生成中の行として返す)
      const failedIds = new Set<string>();

      if (staleRequests.length > 0) {
        // weekly_menu_requests は利用者 (authenticated) から書けない (#1465)。本人の行に絞って service role で書く
        const queueDb = getAiQueueWriter();
        const failedAt = new Date(nowMs).toISOString();
        for (const staleRequest of staleRequests) {
          // 読んだときから状態・生存信号が変わっていない行だけを書き換える (読んでから書くまでに進んだ行は failed にしない)
          const { rows: failedRows, error: staleError } = await markWeeklyMenuRequestStaleIfUnchanged({
            supabase: queueDb,
            userId: user.id,
            row: staleRequest,
            failedAt,
          });
          if (staleError) {
            // 更新が拒まれた行は書き換わっていない。生成中の行として返し、次の確認でやり直す
            console.error('Failed to mark stale meal request as failed:', staleError);
            continue;
          }
          for (const failedRow of failedRows) failedIds.add(failedRow.id);
        }

        // プレースホルダーは使用しないので、is_generating のクリアは不要
      }

      const active = pendingRequests.filter((r) => !failedIds.has(r.id));

      if (active.length === 0) {
        return NextResponse.json({ hasPending: false, requests: [] });
      }

      return NextResponse.json({
        hasPending: true,
        requests: active.map(r => ({
          requestId: r.id,
          status: r.status,
          targetDate: r.target_date,
          targetMealType: r.target_meal_type,
          targetMealId: r.target_meal_id,
          mode: r.mode,
          createdAt: r.created_at,
        })),
      });
    }

    return NextResponse.json({ hasPending: false, requests: [] });

  } catch (error: any) {
    return internalError('GET /api/ai/menu/meal/pending', error, { userId: user.id });
  }
}
