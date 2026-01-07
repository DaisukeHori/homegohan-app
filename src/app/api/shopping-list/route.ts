import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { toShoppingListItem } from '@/lib/converter';

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const { mealPlanId, itemName, category, quantity } = json;

    const { data, error } = await supabase
      .from('shopping_list_items')
      .insert({
        meal_plan_id: mealPlanId,
        item_name: itemName,
        normalized_name: itemName, // 手動追加は item_name をそのまま使用
        category: category || 'その他',
        quantity: quantity,
        quantity_variants: quantity ? [{ display: quantity, unit: '', value: null }] : [],
        selected_variant_index: 0,
        source: 'manual',
        is_checked: false
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ item: toShoppingListItem(data) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}



