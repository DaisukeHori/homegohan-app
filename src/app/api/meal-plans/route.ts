import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { DailyMeal, PlannedMeal, ShoppingListItem } from '@/types/domain';
import { toDailyMeal, toPlannedMeal, toShoppingListItem } from '@/lib/converter';
import type { Tables } from '@homegohan/shared';
import { isCalendarDate, todayLocal } from '@/lib/date-utils';
import { CALENDAR_DATE_PARAM_LABELS, invalidCalendarDateMessage } from '@/lib/api/user-api-error-messages';
import { mondayWeekRange } from '@/lib/jst-day-ranges';
import { internalError } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

/**
 * Get meals for a date range (日付ベースモデル対応)
 * Query params:
 * - startDate: 開始日 (YYYY-MM-DD)
 * - endDate: 終了日 (YYYY-MM-DD)
 * - date: 特定の日付 (YYYY-MM-DD) - startDate/endDateの代わりに使用可能
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const date = searchParams.get('date');

  // 日付は YYYY-MM-DD の実在する日付 (isCalendarDate の範囲の中) だけを受け付ける (#1482)。
  // 形を見ずに渡すと、2026-02-30 のような日付が DB の date 型への変換で失敗して 500 になる。空欄 (?date=) は以前どおり「指定なし」
  for (const [name, value] of [['date', date], ['startDate', startDate], ['endDate', endDate]] as const) {
    if (value && !isCalendarDate(value)) {
      return NextResponse.json({ error: invalidCalendarDateMessage(CALENDAR_DATE_PARAM_LABELS[name]) }, { status: 400 });
    }
  }

  // 単一日付指定の場合
  if (date) {
    const { data, error } = await supabase
      .from('user_daily_meals')
      .select(`
        *,
        planned_meals (*)
      `)
      .eq('user_id', user.id)
      .eq('day_date', date)
      .maybeSingle();

    if (error) {
      return internalError('GET /api/meal-plans', error, { userId: user.id });
    }

    if (!data) {
      return NextResponse.json({ dailyMeal: null, meals: [] });
    }

    const dailyMeal = toDailyMeal(data);
    const dataWithJoin = data as Tables<"user_daily_meals"> & { planned_meals: Tables<"planned_meals">[] };
    const meals = (dataWithJoin.planned_meals || []).map(toPlannedMeal);

    return NextResponse.json({ dailyMeal, meals });
  }

  // 日付範囲指定の場合（デフォルトは今週 = JST の今日を含む月曜〜日曜）。
  // 週は暦の計算だけで求める (#1463。以前の parseLocalDate + setDate (ローカル時刻) + formatLocalDate (JST) は、
  // JST より東のタイムゾーンで動くと 1 日前の日付になった)
  const thisWeek = mondayWeekRange(todayLocal());

  const queryStartDate = startDate || thisWeek.startDate;
  const queryEndDate = endDate || thisWeek.endDate;

  const { data, error } = await supabase
    .from('user_daily_meals')
    .select(`
      *,
      planned_meals (*)
    `)
    .eq('user_id', user.id)
    .gte('day_date', queryStartDate)
    .lte('day_date', queryEndDate)
    .order('day_date', { ascending: true });

  if (error) {
    return internalError('GET /api/meal-plans', error, { userId: user.id });
  }

  const dailyMeals = (data || []).map((day: any) => ({
    ...toDailyMeal(day),
    meals: (day.planned_meals || []).map(toPlannedMeal),
  }));

  // アクティブな買い物リストを取得
  const { data: shoppingListData } = await supabase
    .from('shopping_lists')
    .select(`
      *,
      shopping_list_items (*)
    `)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const shoppingList = shoppingListData ? {
    id: shoppingListData.id,
    status: shoppingListData.status,
    items: ((shoppingListData as Tables<"shopping_lists"> & { shopping_list_items: Tables<"shopping_list_items">[] }).shopping_list_items || []).map(toShoppingListItem),
  } : null;

  return NextResponse.json({ 
    dailyMeals,
    startDate: queryStartDate,
    endDate: queryEndDate,
    shoppingList,
  });
}
