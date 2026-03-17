import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildCatalogSelectionUpdate } from "../../../../lib/catalog-products";
import { buildPhotoDishList } from "../../../../lib/meal-image";
import { cancelPendingMealImageJobs } from "../../../../lib/meal-image-jobs";

export async function POST(request: Request) {
  const supabase = await createClient();
  
  try {
    const {
      dayDate,
      mealType,
      dishes,
      totalCalories,
      imageUrl,
      nutritionalAdvice,
      catalogProductId,
    } = await request.json();
    
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // 1. user_daily_meals を取得または作成
    let dailyMealId: string;
    
    const { data: existingDay } = await supabase
      .from('user_daily_meals')
      .select('id')
      .eq('user_id', user.id)
      .eq('day_date', dayDate)
      .single();
    
    if (existingDay) {
      dailyMealId = existingDay.id;
    } else {
      const { data: newDay, error: dayError } = await supabase
        .from('user_daily_meals')
        .insert({
          user_id: user.id,
          day_date: dayDate,
          is_cheat_day: false,
        })
        .select('id')
        .single();
      
      if (dayError || !newDay) {
        console.error('Failed to create user_daily_meals:', dayError);
        return NextResponse.json({ error: 'Failed to create daily meal' }, { status: 500 });
      }
      dailyMealId = newDay.id;
    }
    
    // 2. 既存の同じ meal_type の planned_meal を削除（上書き）および画像ジョブを止める
    const { data: existingMeals, error: existingMealsError } = await supabase
      .from('planned_meals')
      .select('id')
      .eq('daily_meal_id', dailyMealId)
      .eq('meal_type', mealType);

    if (existingMealsError) {
      console.error('Failed to load existing meal for photo insert:', existingMealsError);
      return NextResponse.json({ error: 'Failed to replace existing meal' }, { status: 500 });
    }

    if (Array.isArray(existingMeals) && existingMeals.length > 0) {
      await Promise.all(
        existingMeals.map((meal) =>
          cancelPendingMealImageJobs({ supabase, plannedMealId: meal.id, reason: 'photo overwrite' }).catch(
            (cancelError) => {
              console.warn('Failed to cancel meal image jobs for overwritten photo:', cancelError);
            },
          ),
        ),
      );
    }

    await supabase
      .from('planned_meals')
      .delete()
      .eq('daily_meal_id', dailyMealId)
      .eq('meal_type', mealType);
    
    // 3. planned_meal を作成
    const dishesArray = dishes || [];
    const allDishNames = dishesArray.map((d: any) => d.name).join('、') || '写真から入力';
    
    // dishes を配列形式で保存（統一形式）
    const dishesJson = dishesArray.map((d: any) => ({
      name: d.name,
      calories_kcal: d.cal || d.calories_kcal || 0,
      role: d.role || 'side',
      ingredient: d.ingredient || ''
    }));
    const photoDishes = buildPhotoDishList(dishesJson, imageUrl ?? null);
    
    const insertData: Record<string, any> = {
      daily_meal_id: dailyMealId,
      meal_type: mealType,
      mode: 'cook',
      dish_name: allDishNames,
      description: nutritionalAdvice || null,
      calories_kcal: totalCalories || null,
      image_url: imageUrl,
      is_completed: false,
      dishes: photoDishes.length > 0 ? photoDishes : null,
      is_simple: photoDishes.length <= 1,
      source_type: 'manual',
    };

    if (catalogProductId) {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase,
        catalogProductId,
        mode: 'buy',
        imageUrl: imageUrl ?? undefined,
        description: nutritionalAdvice || null,
        selectedFrom: 'photo_match',
      });
      Object.assign(insertData, fields);
    }

    const { data: newMeal, error: mealError } = await supabase
      .from('planned_meals')
      .insert(insertData)
      .select()
      .single();
    
    if (mealError) {
      console.error('Failed to create planned_meal:', mealError);
      return NextResponse.json({ error: 'Failed to create planned meal' }, { status: 500 });
    }
    
    return NextResponse.json({ 
      success: true, 
      dailyMealId,
      mealId: newMeal.id 
    });
    
  } catch (error: any) {
    console.error('Add from photo API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
