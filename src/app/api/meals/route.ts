import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 食事一覧取得（日付ベースモデル: user_daily_meals → planned_meals）
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

    // user_daily_mealsとplanned_mealsをJOINして取得
    const { data: dailyMeal, error: dayError } = await supabase
      .from('user_daily_meals')
      .select(`
        id,
        day_date,
        theme,
        nutritional_focus,
        is_cheat_day,
        planned_meals(*)
      `)
      .eq('day_date', targetDate)
      .eq('user_id', user.id)
      .maybeSingle();

    if (dayError) {
      return NextResponse.json({ error: dayError.message }, { status: 500 });
    }

    if (!dailyMeal) {
      return NextResponse.json({ meals: [] });
    }

    // display_orderでソート
    const meals = (dailyMeal.planned_meals || []).sort(
      (a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0)
    );

    return NextResponse.json({ meals });

  } catch (error: any) {
    console.error('Error fetching meals:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 新しい食事を追加（日付ベースモデル: user_daily_meals upsert → planned_meals insert）
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

    // 1. user_daily_mealsをupsert
    const { data: dailyMeal, error: dailyMealError } = await supabase
      .from('user_daily_meals')
      .upsert(
        { 
          user_id: user.id, 
          day_date: date,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id,day_date' }
      )
      .select('id')
      .single();

    if (dailyMealError || !dailyMeal) {
      throw dailyMealError || new Error('Failed to create daily meal');
    }

    // 2. planned_mealを追加
    const { data: meal, error: mealError } = await supabase
      .from('planned_meals')
      .insert({
        daily_meal_id: dailyMeal.id,
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
