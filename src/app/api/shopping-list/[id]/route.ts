import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { toShoppingListItem } from '@/lib/converter';

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const { isChecked, selectedVariantIndex } = json;

    // 更新対象フィールドを動的に構築
    const updateFields: Record<string, any> = {};
    
    if (typeof isChecked === 'boolean') {
      updateFields.is_checked = isChecked;
    }

    if (typeof selectedVariantIndex === 'number') {
      // 現在のアイテムを取得してバリデーション
      const { data: currentItem, error: fetchError } = await supabase
        .from('shopping_list_items')
        .select('quantity_variants')
        .eq('id', params.id)
        .single();

      if (fetchError) throw fetchError;

      const variants = currentItem?.quantity_variants || [];
      if (selectedVariantIndex < 0 || selectedVariantIndex >= variants.length) {
        return NextResponse.json({ error: 'Invalid selectedVariantIndex' }, { status: 400 });
      }

      updateFields.selected_variant_index = selectedVariantIndex;
      // quantityも同期（後方互換）
      updateFields.quantity = variants[selectedVariantIndex]?.display || null;
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('shopping_list_items')
      .update(updateFields)
      .eq('id', params.id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, item: toShoppingListItem(data) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase
    .from('shopping_list_items')
    .delete()
    .eq('id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}


