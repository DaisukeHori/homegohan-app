import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 食事一覧取得（planned_mealsベース）
 * 今日の献立または指定日の献立を取得
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');
    
    // 日付が指定されていない場合は今日
    const targetDate = date || new Date().toISOString().split('T')[0];

    // meal_plan_daysとplanned_mealsをJOINして取得
    const { data: dayData, error: dayError } = await supabase
      .from('meal_plan_days')
      .select(`
        id,
        day_date,
        meal_plans!inner(user_id)
      `)
      .eq('day_date', targetDate)
      .eq('meal_plans.user_id', user.id)
      .single();

    if (dayError || !dayData) {
      return NextResponse.json({ meals: [] });
    }

    const { data: meals, error: mealsError } = await supabase
      .from('planned_meals')
      .select('*')
      .eq('meal_plan_day_id', dayData.id)
      .order('meal_type');

    if (mealsError) {
      return NextResponse.json({ error: mealsError.message }, { status: 500 });
    }

    return NextResponse.json({ meals: meals || [] });

  } catch (error: any) {
    console.error('Error fetching meals:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 新しい食事を追加（planned_mealsに追加）
 * 指定日のmeal_plan_dayが存在しない場合は作成
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { 
      date, 
      mealType, 
      dishName, 
      mode = 'cook',
      description,
      imageUrl,
      caloriesKcal,
      ingredients,
      dishes,
    } = body;

    if (!date || !mealType || !dishName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 1. 該当日のmeal_plan_dayを探す or 作成
    let { data: dayData } = await supabase
      .from('meal_plan_days')
      .select(`
        id,
        meal_plan_id,
        meal_plans!inner(user_id)
      `)
      .eq('day_date', date)
      .eq('meal_plans.user_id', user.id)
      .single();

    if (!dayData) {
      // meal_planを探す or 作成
      const weekStart = getWeekStart(new Date(date));
      const weekEnd = getWeekEnd(new Date(date));

      let { data: planData } = await supabase
        .from('meal_plans')
        .select('id')
        .eq('user_id', user.id)
        .lte('start_date', date)
        .gte('end_date', date)
        .single();

      if (!planData) {
        const { data: newPlan, error: planError } = await supabase
          .from('meal_plans')
          .insert({
            user_id: user.id,
            title: '週間献立',
            start_date: weekStart,
            end_date: weekEnd,
            status: 'active',
            is_active: true,
          })
          .select()
          .single();

        if (planError) throw planError;
        planData = newPlan;
      }

      // meal_plan_dayを作成
      const { data: newDay, error: dayError } = await supabase
        .from('meal_plan_days')
        .insert({
          meal_plan_id: planData.id,
          day_date: date,
          day_of_week: getDayOfWeek(new Date(date)),
        })
        .select()
        .single();

      if (dayError) throw dayError;
      dayData = { ...newDay, meal_plans: { user_id: user.id } };
    }

    // 2. planned_mealを追加
    const { data: meal, error: mealError } = await supabase
      .from('planned_meals')
      .insert({
        meal_plan_day_id: dayData.id,
        meal_type: mealType,
        dish_name: dishName,
        mode: mode,
        description: description,
        image_url: imageUrl,
        calories_kcal: caloriesKcal,
        ingredients: ingredients,
        dishes: dishes,
        is_completed: false,
      })
      .select()
      .single();

    if (mealError) throw mealError;

    return NextResponse.json({ meal });

  } catch (error: any) {
    console.error('Error creating meal:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Helper: 週の開始日（月曜日）を取得
function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

// Helper: 週の終了日（日曜日）を取得
function getWeekEnd(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? 0 : 7);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

// Helper: 曜日を取得
function getDayOfWeek(date: Date): string {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return days[date.getDay()];
}
