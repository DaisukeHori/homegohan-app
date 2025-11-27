import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { mealPlanId } = await request.json();
    
    if (!mealPlanId) {
      return NextResponse.json({ error: 'mealPlanId is required' }, { status: 400 });
    }

    // Get all planned meals for this meal plan
    const { data: mealPlan, error: planError } = await supabase
      .from('meal_plans')
      .select(`
        id,
        meal_plan_days (
          id,
          planned_meals (
            id,
            ingredients
          )
        )
      `)
      .eq('id', mealPlanId)
      .eq('user_id', user.id)
      .single();

    if (planError) throw planError;

    // Collect all ingredients from all meals
    const ingredientsMap = new Map<string, { name: string; count: number }>();
    
    mealPlan.meal_plan_days?.forEach((day: any) => {
      day.planned_meals?.forEach((meal: any) => {
        if (meal.ingredients && Array.isArray(meal.ingredients)) {
          meal.ingredients.forEach((ingredient: string) => {
            const normalized = ingredient.trim();
            if (normalized) {
              const existing = ingredientsMap.get(normalized);
              if (existing) {
                existing.count++;
              } else {
                ingredientsMap.set(normalized, { name: normalized, count: 1 });
              }
            }
          });
        }
      });
    });

    // Delete existing shopping list items
    await supabase
      .from('shopping_list_items')
      .delete()
      .eq('meal_plan_id', mealPlanId);

    // Create new shopping list items
    const newItems = Array.from(ingredientsMap.values()).map(item => ({
      meal_plan_id: mealPlanId,
      item_name: item.name,
      quantity: item.count > 1 ? `${item.count}回分` : null,
      category: categorizeIngredient(item.name),
      is_checked: false
    }));

    if (newItems.length > 0) {
      const { data: insertedItems, error: insertError } = await supabase
        .from('shopping_list_items')
        .insert(newItems)
        .select();

      if (insertError) throw insertError;

      return NextResponse.json({ 
        items: insertedItems.map((item: any) => ({
          id: item.id,
          mealPlanId: item.meal_plan_id,
          itemName: item.item_name,
          category: item.category,
          quantity: item.quantity,
          isChecked: item.is_checked,
          createdAt: item.created_at,
          updatedAt: item.updated_at
        }))
      });
    }

    return NextResponse.json({ items: [] });
  } catch (error: any) {
    console.error('Regenerate shopping list error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Simple categorization based on ingredient name
function categorizeIngredient(name: string): string {
  const categories: Record<string, string[]> = {
    '野菜': ['キャベツ', 'にんじん', '玉ねぎ', 'ほうれん草', 'もやし', 'トマト', 'レタス', 'きゅうり', 'なす', 'ピーマン', 'ねぎ', '大根', 'じゃがいも', 'ごぼう', 'れんこん', 'ブロッコリー', 'アスパラ'],
    '肉': ['鶏', '豚', '牛', 'ひき肉', 'ベーコン', 'ハム', 'ソーセージ', 'ウインナー'],
    '魚': ['鮭', 'さば', 'あじ', 'いわし', 'まぐろ', 'えび', 'いか', 'たこ', 'かに', '貝'],
    '乳製品': ['牛乳', 'チーズ', 'ヨーグルト', 'バター', '生クリーム'],
    '調味料': ['醤油', '味噌', '塩', '砂糖', '酢', '酒', 'みりん', 'だし', 'ソース', 'ケチャップ', 'マヨネーズ', '油', 'オリーブオイル', 'ごま油'],
    '乾物': ['わかめ', 'ひじき', '昆布', '干ししいたけ', '切り干し大根', 'のり', 'かつお節'],
    '豆腐・大豆': ['豆腐', '油揚げ', '厚揚げ', '納豆', '豆乳'],
    '卵': ['卵', 'たまご'],
    '麺・米': ['米', 'パスタ', 'うどん', 'そば', 'ラーメン', '中華麺']
  };

  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some(keyword => name.includes(keyword))) {
      return category;
    }
  }
  return 'その他';
}

