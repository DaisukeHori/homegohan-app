import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { toShoppingListItem } from '@/lib/converter';

/**
 * 買い物リスト取得API
 */
export async function GET(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const mealPlanId = searchParams.get('mealPlanId');

  if (!mealPlanId) {
    return NextResponse.json({ error: 'mealPlanId is required' }, { status: 400 });
  }

  try {
    const { data, error } = await supabase
      .from('shopping_list_items')
      .select('*')
      .eq('meal_plan_id', mealPlanId)
      .order('category')
      .order('created_at');

    if (error) throw error;

    return NextResponse.json({ 
      items: (data || []).map(toShoppingListItem) 
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 買い物リストアイテム追加API
 */
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



