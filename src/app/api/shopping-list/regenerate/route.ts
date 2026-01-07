import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { toShoppingListItem } from '@/lib/converter';
import { dbLog } from '@/lib/db-logger';

interface InputIngredient {
  name: string;
  amount?: string | null;
  count: number;
}

interface QuantityVariant {
  display: string;
  unit: string;
  value: number | null;
}

interface NormalizedItem {
  itemName: string;
  normalizedName: string;
  quantityVariants: QuantityVariant[];
  category: string;
}

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { mealPlanId } = await request.json();
    
    if (!mealPlanId) {
      return NextResponse.json({ error: 'mealPlanId is required' }, { status: 400 });
    }

    await dbLog({
      level: 'info',
      source: 'api-route',
      functionName: 'shopping-list/regenerate',
      userId: user.id,
      message: 'Starting shopping list regeneration',
      metadata: { mealPlanId }
    });

    // Get all planned meals for this meal plan (dishes優先、ingredientsフォールバック)
    const { data: mealPlan, error: planError } = await supabase
      .from('meal_plans')
      .select(`
        id,
        meal_plan_days (
          id,
          planned_meals (
            id,
            ingredients,
            dishes
          )
        )
      `)
      .eq('id', mealPlanId)
      .eq('user_id', user.id)
      .single();

    if (planError) throw planError;

    // 材料を抽出（dishes優先）
    const ingredientsMap = new Map<string, InputIngredient>();
    
    mealPlan.meal_plan_days?.forEach((day: any) => {
      day.planned_meals?.forEach((meal: any) => {
        // v2/v3/v4形式: dishes から抽出
        if (meal.dishes && Array.isArray(meal.dishes)) {
          meal.dishes.forEach((dish: any) => {
            if (dish.ingredients && Array.isArray(dish.ingredients)) {
              dish.ingredients.forEach((ing: any) => {
                const name = typeof ing === 'string' ? ing : ing.name;
                const amount = typeof ing === 'object' ? (ing.amount || (ing.amount_g ? `${ing.amount_g}g` : null)) : null;
                
                if (name) {
                  const key = `${name}|${amount || ''}`;
                  const existing = ingredientsMap.get(key);
                  if (existing) {
                    existing.count++;
                  } else {
                    ingredientsMap.set(key, { name: name.trim(), amount, count: 1 });
                  }
                }
              });
            }
          });
        }
        
        // 旧形式: ingredients から抽出（dishesがない場合のフォールバック）
        else if (meal.ingredients && Array.isArray(meal.ingredients)) {
          meal.ingredients.forEach((ingredient: string) => {
            const trimmed = ingredient.trim();
            if (trimmed) {
              const existing = ingredientsMap.get(trimmed);
              if (existing) {
                existing.count++;
              } else {
                ingredientsMap.set(trimmed, { name: trimmed, amount: null, count: 1 });
              }
            }
          });
        }
      });
    });

    const rawIngredients = Array.from(ingredientsMap.values());

    if (rawIngredients.length === 0) {
      // 材料がない場合はgenerated分のみ削除して終了
      await supabase
        .from('shopping_list_items')
        .delete()
        .eq('meal_plan_id', mealPlanId)
        .eq('source', 'generated');

      const { data: remainingItems } = await supabase
        .from('shopping_list_items')
        .select('*')
        .eq('meal_plan_id', mealPlanId)
        .order('category')
        .order('created_at');

      return NextResponse.json({ 
        items: (remainingItems || []).map(toShoppingListItem),
        stats: { inputCount: 0, outputCount: 0, mergedCount: 0 }
      });
    }

    // Edge Functionで正規化
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Missing Supabase configuration');
    }

    const normalizeRes = await fetch(`${supabaseUrl}/functions/v1/normalize-shopping-list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ ingredients: rawIngredients }),
    });

    if (!normalizeRes.ok) {
      const errText = await normalizeRes.text();
      throw new Error(`Normalize Edge Function error: ${errText}`);
    }

    const { items: normalizedItems, stats } = await normalizeRes.json() as {
      items: NormalizedItem[];
      stats: { inputCount: number; outputCount: number; mergedCount: number };
    };

    // 既存アイテムを取得
    const { data: existingItems } = await supabase
      .from('shopping_list_items')
      .select('*')
      .eq('meal_plan_id', mealPlanId);

    // 手動追加の材料名を集合化
    const manualNames = new Set(
      (existingItems || [])
        .filter((item: any) => item.source !== 'generated')
        .map((item: any) => item.normalized_name || item.item_name)
    );

    // 以前のgenerated項目のis_checked状態を保持
    const prevCheckedMap = new Map(
      (existingItems || [])
        .filter((item: any) => item.source === 'generated')
        .map((item: any) => [item.normalized_name || item.item_name, item.is_checked])
    );

    // 以前のgenerated項目の選択中単位を保持
    const prevSelectedUnitMap = new Map(
      (existingItems || [])
        .filter((item: any) => item.source === 'generated')
        .map((item: any) => {
          const variants = item.quantity_variants || [];
          const idx = item.selected_variant_index || 0;
          const unit = variants[idx]?.unit || null;
          return [item.normalized_name || item.item_name, unit];
        })
    );

    // 手動と重複するgeneratedは除外して新規アイテムを作成
    const newItems = normalizedItems
      .filter((item: NormalizedItem) => !manualNames.has(item.normalizedName))
      .map((item: NormalizedItem) => {
        // 以前選択していた unit があれば、それに合わせて初期インデックスを決める
        const prevUnit = prevSelectedUnitMap.get(item.normalizedName);
        let selectedIdx = 0;
        if (prevUnit) {
          const idx = item.quantityVariants.findIndex(v => v.unit === prevUnit);
          if (idx >= 0) selectedIdx = idx;
        }

        return {
          meal_plan_id: mealPlanId,
          item_name: item.itemName,
          normalized_name: item.normalizedName,
          quantity: item.quantityVariants[selectedIdx]?.display || item.quantityVariants[0]?.display || null,
          quantity_variants: item.quantityVariants,
          selected_variant_index: selectedIdx,
          category: item.category,
          source: 'generated',
          is_checked: prevCheckedMap.get(item.normalizedName) || false,
        };
      });

    // generated分だけ削除
    await supabase
      .from('shopping_list_items')
      .delete()
      .eq('meal_plan_id', mealPlanId)
      .eq('source', 'generated');

    // 新規generated挿入
    if (newItems.length > 0) {
      const { error: insertError } = await supabase
        .from('shopping_list_items')
        .insert(newItems);

      if (insertError) throw insertError;
    }

    // 全件取得して返す
    const { data: allItems, error: fetchError } = await supabase
      .from('shopping_list_items')
      .select('*')
      .eq('meal_plan_id', mealPlanId)
      .order('category')
      .order('created_at');

    if (fetchError) throw fetchError;

    await dbLog({
      level: 'info',
      source: 'api-route',
      functionName: 'shopping-list/regenerate',
      userId: user.id,
      message: 'Shopping list regeneration completed',
      metadata: { mealPlanId, stats, newItemsCount: newItems.length }
    });

    return NextResponse.json({ 
      items: (allItems || []).map(toShoppingListItem),
      stats
    });
  } catch (error: any) {
    console.error('Regenerate shopping list error:', error);
    
    await dbLog({
      level: 'error',
      source: 'api-route',
      functionName: 'shopping-list/regenerate',
      userId: user.id,
      message: 'Shopping list regeneration failed',
      errorMessage: error.message,
      errorStack: error.stack,
    });

    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
