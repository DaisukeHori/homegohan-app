import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
// MealType (食事の区分 5 値) は @homegohan/shared が正本 (#1631。手書きしない)
import type { MealType } from '@homegohan/shared';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { isUuid, normalizeUuid } from '@/lib/http-params';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { MEAL_NOT_FOUND_MESSAGE, REQUIRED_FIELDS_MISSING_MESSAGE } from '@/lib/api/user-api-error-messages';

// 食事タイプのカテゴリ（順序変更の制約用）
const MEAL_CATEGORIES: Record<MealType, number> = {
  breakfast: 1,
  lunch: 2,
  dinner: 3,
  snack: 0,  // おやつは特別（どこにでも移動可能）
  midnight_snack: 4,
};

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const requestBody = await request.json().catch(() => null);
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { mealId: rawMealId, direction, dayId: rawDayId } = requestBody;
    
    if (!rawMealId || !direction || !rawDayId) {
      return NextResponse.json({ error: REQUIRED_FIELDS_MISSING_MESSAGE }, { status: 400 });
    }
    // DB の id は小文字。大文字・混在で送られた mealId が findIndex の === で 404 にならないよう、受け取った直後にそろえ、
    // 以後 (照合・DB) はそろえた値だけを使う (#1793。文字列でない値はそのまま = 今までどおり見つからない)
    const mealId = typeof rawMealId === 'string' ? normalizeUuid(rawMealId) : rawMealId;
    const dayId = typeof rawDayId === 'string' ? normalizeUuid(rawDayId) : rawDayId;
    // UUID の形でない dayId は DB に渡さず 404 (その日の食事が無いときと同じ。uuid 型の列に渡すと 22P02 で失敗し、下の catch の 500 に入っていた。#1917 の続き)
    if (!isUuid(dayId)) {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // その日の全ての食事を取得（display_order順）
    const { data: meals, error: fetchError } = await supabase
      .from('planned_meals')
      .select('id, meal_type, display_order')
      .eq('daily_meal_id', dayId)
      .order('display_order', { ascending: true });

    if (fetchError) throw fetchError;
    if (!meals || meals.length === 0) {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // 現在の食事を見つける
    const currentIndex = meals.findIndex(m => m.id === mealId);
    if (currentIndex === -1) {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
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
    return internalError('POST /api/meal-plans/meals/reorder', error, { userId: user.id });
  }
}

