import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { dayDate, mealType, mode, dishName, isSimple, dishes, caloriesKcal, description, ingredients } = await request.json();

    if (!dayDate || !mealType) {
      return NextResponse.json({ error: 'dayDate and mealType are required' }, { status: 400 });
    }

    // Get or create user_daily_meals for the target date
    let { data: existingDay } = await supabase
      .from('user_daily_meals')
      .select('id')
      .eq('user_id', user.id)
      .eq('day_date', dayDate)
      .single();

    let dailyMealId: string;

    if (existingDay) {
      dailyMealId = existingDay.id;
    } else {
      const { data: newDay, error: dayError } = await supabase
        .from('user_daily_meals')
        .insert({
          user_id: user.id,
          day_date: dayDate,
          is_cheat_day: false
        })
        .select('id')
        .single();

      if (dayError) throw dayError;
      dailyMealId = newDay.id;
    }

    // 同じタイプの食事を複数追加可能にするため、削除はしない
    // Create new planned meal
    const { data: newMeal, error: mealError } = await supabase
      .from('planned_meals')
      .insert({
        daily_meal_id: dailyMealId,
        meal_type: mealType,
        mode: mode || 'cook',
        dish_name: dishName || '未設定',
        is_simple: isSimple ?? true,
        dishes: dishes || null,
        calories_kcal: caloriesKcal || null,
        description: description || null,
        ingredients: ingredients || null,
        is_completed: false
      })
      .select()
      .single();

    if (mealError) throw mealError;

    return NextResponse.json({ 
      success: true,
      meal: {
        id: newMeal.id,
        dailyMealId: newMeal.daily_meal_id,
        mealType: newMeal.meal_type,
        mode: newMeal.mode,
        dishName: newMeal.dish_name,
        isSimple: newMeal.is_simple,
        dishes: newMeal.dishes,
        caloriesKcal: newMeal.calories_kcal,
        description: newMeal.description,
        ingredients: newMeal.ingredients,
        isCompleted: newMeal.is_completed,
        createdAt: newMeal.created_at,
        updatedAt: newMeal.updated_at
      }
    });
  } catch (error: any) {
    console.error('Add meal error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
