import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { DailyMeal, PlannedMeal, ShoppingListItem } from '@/types/domain';
import { toDailyMeal, toPlannedMeal, toShoppingListItem } from '@/lib/converter';
import type { Tables } from '@homegohan/shared';
import { todayLocal, parseLocalDate, formatLocalDate } from '@/lib/date-utils';

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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const date = searchParams.get('date');

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
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ dailyMeal: null, meals: [] });
    }

    const dailyMeal = toDailyMeal(data);
    const dataWithJoin = data as Tables<"user_daily_meals"> & { planned_meals: Tables<"planned_meals">[] };
    const meals = (dataWithJoin.planned_meals || []).map(toPlannedMeal);

    return NextResponse.json({ dailyMeal, meals });
  }

  // 日付範囲指定の場合（デフォルトは今週、JST基準）
  const today = parseLocalDate(todayLocal());
  const defaultStart = new Date(today);
  defaultStart.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));
  const defaultEnd = new Date(defaultStart);
  defaultEnd.setDate(defaultStart.getDate() + 6);

  const queryStartDate = startDate || formatLocalDate(defaultStart);
  const queryEndDate = endDate || formatLocalDate(defaultEnd);

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
    return NextResponse.json({ error: error.message }, { status: 500 });
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
