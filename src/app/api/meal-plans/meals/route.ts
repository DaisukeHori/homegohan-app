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

    // Get or create meal_plan for the week
    const targetDate = new Date(dayDate);
    const dayOfWeek = targetDate.getDay();
    const weekStart = new Date(targetDate);
    weekStart.setDate(targetDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const formatDate = (d: Date) => d.toISOString().split('T')[0];

    // Find existing meal plan for this week
    let { data: existingPlan } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', user.id)
      .lte('start_date', dayDate)
      .gte('end_date', dayDate)
      .single();

    let mealPlanId: string;

    if (existingPlan) {
      mealPlanId = existingPlan.id;
    } else {
      // Create new meal plan
      const { data: newPlan, error: planError } = await supabase
        .from('meal_plans')
        .insert({
          user_id: user.id,
          title: '週間献立',
          start_date: formatDate(weekStart),
          end_date: formatDate(weekEnd),
          status: 'active',
          is_active: true
        })
        .select('id')
        .single();

      if (planError) throw planError;
      mealPlanId = newPlan.id;
    }

    // Get or create meal_plan_day
    let { data: existingDay } = await supabase
      .from('meal_plan_days')
      .select('id')
      .eq('meal_plan_id', mealPlanId)
      .eq('day_date', dayDate)
      .single();

    let dayId: string;

    if (existingDay) {
      dayId = existingDay.id;
    } else {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const { data: newDay, error: dayError } = await supabase
        .from('meal_plan_days')
        .insert({
          meal_plan_id: mealPlanId,
          day_date: dayDate,
          day_of_week: dayNames[targetDate.getDay()],
          is_cheat_day: false
        })
        .select('id')
        .single();

      if (dayError) throw dayError;
      dayId = newDay.id;
    }

    // 同じタイプの食事を複数追加可能にするため、削除はしない
    // Create new planned meal
    const { data: newMeal, error: mealError } = await supabase
      .from('planned_meals')
      .insert({
        meal_plan_day_id: dayId,
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
        mealPlanDayId: newMeal.meal_plan_day_id,
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

