import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { toShoppingListItem, toShoppingList } from '@/lib/converter';

/**
 * 買い物リスト取得API（日付ベースモデル: shopping_lists → shopping_list_items）
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const shoppingListId = searchParams.get('shoppingListId');
  const status = searchParams.get('status') || 'active';

  try {
    if (shoppingListId) {
      // 特定の買い物リストを取得
      const { data, error } = await supabase
        .from('shopping_lists')
        .select(`
          *,
          shopping_list_items(*)
        `)
        .eq('id', shoppingListId)
        .eq('user_id', user.id)
        .single();

      if (error) throw error;

      return NextResponse.json({ 
        shoppingList: data ? toShoppingList(data) : null
      });
    } else {
      // アクティブな買い物リストを取得
      const { data, error } = await supabase
        .from('shopping_lists')
        .select(`
          *,
          shopping_list_items(*)
        `)
        .eq('user_id', user.id)
        .eq('status', status)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      return NextResponse.json({ 
        shoppingList: data ? toShoppingList(data) : null
      });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 買い物リストアイテム追加API
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const { shoppingListId, itemName, category, quantity } = json;

    if (!shoppingListId) {
      return NextResponse.json({ error: 'shoppingListId is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('shopping_list_items')
      .insert({
        shopping_list_id: shoppingListId,
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

/**
 * 買い物リストアイテム一括削除API
 */
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const { itemIds } = json;

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return NextResponse.json({ error: 'itemIds is required and must be a non-empty array' }, { status: 400 });
    }

    const { error } = await supabase
      .from('shopping_list_items')
      .delete()
      .in('id', itemIds);

    if (error) throw error;

    return NextResponse.json({ success: true, deletedCount: itemIds.length });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
