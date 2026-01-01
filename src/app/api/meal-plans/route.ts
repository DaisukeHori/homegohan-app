import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { toMealPlan } from '@/lib/converter';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode'); // 'latest', 'active', 'date'
  const date = searchParams.get('date'); // YYYY-MM-DD

  let query = supabase
    .from('meal_plans')
    .select(`
      *,
      meal_plan_days (
        *,
        planned_meals (*)
      ),
      shopping_list_items (*)
    `)
    .eq('user_id', user.id);

  if (mode === 'active') {
    // 現在アクティブな、または今日の日付を含む献立
    const today = new Date().toISOString().split('T')[0];
    query = query
      .lte('start_date', today)
      .gte('end_date', today)
      .order('is_active', { ascending: false }) // is_active: true を優先
      .order('updated_at', { ascending: false }) // 次に更新日時が新しいもの
      .limit(1);
  } else if (mode === 'latest') {
    // 最新のもの
    query = query
      .order('is_active', { ascending: false }) // is_active: true を優先
      .order('start_date', { ascending: false })
      .limit(1);
  } else if (date) {
    // 指定した日付を含む献立（is_active: true を優先）
    query = query
      .lte('start_date', date)
      .gte('end_date', date)
      .order('is_active', { ascending: false }) // is_active: true を優先
      .order('updated_at', { ascending: false }) // 次に更新日時が新しいもの
      .limit(1);
  } else {
    // デフォルト: 最新かつアクティブなもの
    query = query
      .order('is_active', { ascending: false }) // is_active: true を優先
      .order('start_date', { ascending: false })
      .limit(1);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const mealPlan = data && data.length > 0 ? toMealPlan(data[0]) : null;

  return NextResponse.json({ mealPlan });
}


