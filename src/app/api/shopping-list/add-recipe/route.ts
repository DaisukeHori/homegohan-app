import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { mealPlanId, ingredients } = await request.json();
    
    if (!mealPlanId) {
      return NextResponse.json({ error: 'mealPlanId is required' }, { status: 400 });
    }

    if (!ingredients || !Array.isArray(ingredients)) {
      return NextResponse.json({ error: 'ingredients must be an array' }, { status: 400 });
    }

    // Verify the meal plan belongs to the user
    const { data: mealPlan, error: planError } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('id', mealPlanId)
      .eq('user_id', user.id)
      .single();

    if (planError || !mealPlan) {
      return NextResponse.json({ error: 'Meal plan not found' }, { status: 404 });
    }

    // Create shopping list items from ingredients
    const newItems = ingredients.map((ing: { name: string; amount?: string }) => ({
      meal_plan_id: mealPlanId,
      item_name: ing.name,
      quantity: ing.amount || null,
      category: categorizeIngredient(ing.name),
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
    console.error('Add recipe to shopping list error:', error);
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

