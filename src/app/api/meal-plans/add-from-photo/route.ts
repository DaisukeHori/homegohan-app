import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";

// Helper: 週の開始日（月曜日）を取得
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  
  try {
    const { dayDate, mealType, dishes, totalCalories, imageUrl, nutritionalAdvice } = await request.json();
    
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // 1. meal_plan を取得または作成
    const targetDate = new Date(dayDate);
    const weekStart = getWeekStart(targetDate);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];
    
    let mealPlanId: string;
    
    // 既存のmeal_planを検索
    const { data: existingPlan } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', user.id)
      .gte('start_date', weekStartStr)
      .lte('start_date', weekEndStr)
      .single();
    
    if (existingPlan) {
      mealPlanId = existingPlan.id;
    } else {
      // 新規作成
      const { data: newPlan, error: planError } = await supabase
        .from('meal_plans')
        .insert({
          user_id: user.id,
          title: `${weekStart.getMonth() + 1}月${weekStart.getDate()}日〜の献立`,
          start_date: weekStartStr,
          end_date: weekEndStr,
          status: 'active',
          is_active: true,
        })
        .select('id')
        .single();
      
      if (planError || !newPlan) {
        console.error('Failed to create meal_plan:', planError);
        return NextResponse.json({ error: 'Failed to create meal plan' }, { status: 500 });
      }
      mealPlanId = newPlan.id;
    }
    
    // 2. meal_plan_day を取得または作成
    let dayId: string;
    
    const { data: existingDay } = await supabase
      .from('meal_plan_days')
      .select('id')
      .eq('meal_plan_id', mealPlanId)
      .eq('day_date', dayDate)
      .single();
    
    if (existingDay) {
      dayId = existingDay.id;
    } else {
      const dayOfWeek = new Date(dayDate).toLocaleDateString('en-US', { weekday: 'long' });
      const { data: newDay, error: dayError } = await supabase
        .from('meal_plan_days')
        .insert({
          meal_plan_id: mealPlanId,
          day_date: dayDate,
          day_of_week: dayOfWeek,
          is_cheat_day: false,
        })
        .select('id')
        .single();
      
      if (dayError || !newDay) {
        console.error('Failed to create meal_plan_day:', dayError);
        return NextResponse.json({ error: 'Failed to create meal plan day' }, { status: 500 });
      }
      dayId = newDay.id;
    }
    
    // 3. 既存の同じ meal_type の planned_meal を削除（上書き）
    await supabase
      .from('planned_meals')
      .delete()
      .eq('meal_plan_day_id', dayId)
      .eq('meal_type', mealType);
    
    // 4. planned_meal を作成
    const dishesArray = dishes || [];
    const mainDish = dishesArray.find((d: any) => d.role === 'main') || dishesArray[0];
    const allDishNames = dishesArray.map((d: any) => d.name).join('、') || '写真から入力';
    
    // dishes を配列形式で保存
    const dishesJson = dishesArray.map((d: any) => ({
      name: d.name,
      cal: d.cal || 0,
      role: d.role || 'side',
      ingredient: d.ingredient || ''
    }));
    
    const { data: newMeal, error: mealError } = await supabase
      .from('planned_meals')
      .insert({
        meal_plan_day_id: dayId,
        meal_type: mealType,
        mode: 'cook',
        dish_name: allDishNames,
        description: nutritionalAdvice || null,
        calories_kcal: totalCalories || null,
        image_url: imageUrl,
        is_completed: false,
        dishes: dishesJson.length > 0 ? dishesJson : null,
        is_simple: dishesJson.length <= 1,
      })
      .select()
      .single();
    
    if (mealError) {
      console.error('Failed to create planned_meal:', mealError);
      return NextResponse.json({ error: 'Failed to create planned meal' }, { status: 500 });
    }
    
    return NextResponse.json({ 
      success: true, 
      mealPlanId,
      dayId,
      mealId: newMeal.id 
    });
    
  } catch (error: any) {
    console.error('Add from photo API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

