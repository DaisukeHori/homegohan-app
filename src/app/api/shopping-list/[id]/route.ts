import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { toShoppingListItem } from '@/lib/converter';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { isUuid } from '@/lib/http-params';
import { NO_FIELDS_TO_UPDATE_MESSAGE } from '@/lib/api/user-api-error-messages';

/** 400: 選んだ分量の候補 (selectedVariantIndex) が候補の一覧の外 */
const VARIANT_INDEX_INVALID_MESSAGE = '選んだ分量の候補が見つかりません';

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const json = await request.json().catch(() => null);
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { isChecked, selectedVariantIndex } = json;

    // 更新対象フィールドを動的に構築
    const updateFields: Record<string, any> = {};
    
    if (typeof isChecked === 'boolean') {
      updateFields.is_checked = isChecked;
    }

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    if (typeof selectedVariantIndex === 'number') {
      // 現在のアイテムを取得してバリデーション。他人の行・消された行は 0 行なので 404 (#1917。.single() は 0 行を失敗にして 500 にしていた)
      const { data: currentItem, error: fetchError } = await supabase
        .from('shopping_list_items')
        .select('quantity_variants')
        .eq('id', params.id)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!currentItem) {
        return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
      }

      const variants = currentItem?.quantity_variants || [];
      if (selectedVariantIndex < 0 || selectedVariantIndex >= variants.length) {
        return NextResponse.json({ error: VARIANT_INDEX_INVALID_MESSAGE }, { status: 400 });
      }

      updateFields.selected_variant_index = selectedVariantIndex;
      // quantityも同期（後方互換）
      updateFields.quantity = variants[selectedVariantIndex]?.display || null;
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: NO_FIELDS_TO_UPDATE_MESSAGE }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('shopping_list_items')
      .update(updateFields)
      .eq('id', params.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    // 他人の行・消された行は更新した行が無い (#1917)
    if (!data) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    return NextResponse.json({ success: true, item: toShoppingListItem(data) });
  } catch (error: any) {
    return internalError('PATCH /api/shopping-list/[id]', error, { userId: user.id });
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // UUID の形でない id は DB に渡さず 404 (PATCH と同じ。uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る。#1917)
  if (!isUuid(params.id)) {
    return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  const { error } = await supabase
    .from('shopping_list_items')
    .delete()
    .eq('id', params.id);

  if (error) return internalError('DELETE /api/shopping-list/[id]', error, { userId: user.id });

  return NextResponse.json({ success: true });
}


