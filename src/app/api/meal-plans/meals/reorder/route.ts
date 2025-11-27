import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

// 食事タイプのカテゴリ（順序変更の制約用）
const MEAL_CATEGORIES: Record<MealType, number> = {
  breakfast: 1,
  lunch: 2,
  dinner: 3,
  snack: 0,  // おやつは特別（どこにでも移動可能）
  midnight_snack: 4,
};

// 基本の食事タイプの順序（おやつ以外）
const BASE_MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'midnight_snack'];

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { mealId, direction, dayId } = await request.json();
    
    if (!mealId || !direction || !dayId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // その日の全ての食事を取得（display_order順）
    const { data: meals, error: fetchError } = await supabase
      .from('planned_meals')
      .select('id, meal_type, display_order')
      .eq('meal_plan_day_id', dayId)
      .order('display_order', { ascending: true });

    if (fetchError) throw fetchError;
    if (!meals || meals.length === 0) {
      return NextResponse.json({ error: 'No meals found' }, { status: 404 });
    }

    // 現在の食事を見つける
    const currentIndex = meals.findIndex(m => m.id === mealId);
    if (currentIndex === -1) {
      return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
    }

    const currentMeal = meals[currentIndex];
    const currentMealType = currentMeal.meal_type as MealType;
    const isSnack = currentMealType === 'snack';

    // 移動先のインデックスを計算
    let targetIndex: number;
    
    if (isSnack) {
      // おやつはどこにでも移動可能
      if (direction === 'up') {
        targetIndex = currentIndex - 1;
      } else {
        targetIndex = currentIndex + 1;
      }
    } else {
      // 他の食事タイプは同じカテゴリ内でのみ移動可能
      // 同じmeal_typeの食事を探す
      const sameMealTypeIndices = meals
        .map((m, i) => ({ meal: m, index: i }))
        .filter(item => item.meal.meal_type === currentMealType);
      
      const currentPositionInType = sameMealTypeIndices.findIndex(item => item.meal.id === mealId);
      
      if (direction === 'up' && currentPositionInType > 0) {
        // 同じタイプ内で上に移動
        targetIndex = sameMealTypeIndices[currentPositionInType - 1].index;
      } else if (direction === 'down' && currentPositionInType < sameMealTypeIndices.length - 1) {
        // 同じタイプ内で下に移動
        targetIndex = sameMealTypeIndices[currentPositionInType + 1].index;
      } else {
        // 移動できない場合
        return NextResponse.json({ 
          success: false, 
          message: '同じ食事タイプ内でのみ移動できます' 
        });
      }
    }

    // 範囲チェック
    if (targetIndex < 0 || targetIndex >= meals.length) {
      return NextResponse.json({ 
        success: false, 
        message: 'これ以上移動できません' 
      });
    }

    // おやつの場合、基本食事タイプのカテゴリを超えないようにする追加チェック
    // （朝食の前に夕食が来るなどを防ぐ）
    if (!isSnack) {
      const targetMeal = meals[targetIndex];
      if (targetMeal.meal_type !== currentMealType && targetMeal.meal_type !== 'snack') {
        return NextResponse.json({ 
          success: false, 
          message: '異なる食事タイプとは入れ替えできません' 
        });
      }
    }

    // display_orderを入れ替える
    const targetMeal = meals[targetIndex];
    const currentOrder = currentMeal.display_order;
    const targetOrder = targetMeal.display_order;

    // 2つの食事のdisplay_orderを入れ替え
    const { error: updateError1 } = await supabase
      .from('planned_meals')
      .update({ display_order: targetOrder })
      .eq('id', currentMeal.id);

    if (updateError1) throw updateError1;

    const { error: updateError2 } = await supabase
      .from('planned_meals')
      .update({ display_order: currentOrder })
      .eq('id', targetMeal.id);

    if (updateError2) throw updateError2;

    return NextResponse.json({ 
      success: true, 
      message: '順序を変更しました',
      swapped: {
        meal1: { id: currentMeal.id, newOrder: targetOrder },
        meal2: { id: targetMeal.id, newOrder: currentOrder }
      }
    });

  } catch (error: any) {
    console.error('Reorder error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

