import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { toShoppingListItem, toShoppingList } from '@/lib/converter';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { isUuid } from '@/lib/http-params';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';


/** 400: 追加先の買い物リスト (shoppingListId) が無い */
const SHOPPING_LIST_ID_REQUIRED_MESSAGE = '買い物リスト (shoppingListId) を指定してください';
/** 400: 品目の名前 (itemName) が無い */
const ITEM_NAME_REQUIRED_MESSAGE = '品目の名前を入力してください';
/** 400: 対象の品目 (itemIds) が無い・空 */
const ITEM_IDS_REQUIRED_MESSAGE = '対象の品目 (itemIds) を 1 つ以上指定してください';
/** 400: 追加先の買い物リスト (shoppingListId) が UUID の形でない */
const SHOPPING_LIST_ID_INVALID_MESSAGE = '買い物リスト (shoppingListId) の形式が正しくありません';
/** 400: 対象の品目 (itemIds) に UUID の形でない値がある */
const ITEM_IDS_INVALID_MESSAGE = '対象の品目 (itemIds) の形式が正しくありません';

/**
 * 買い物リスト取得API（日付ベースモデル: shopping_lists → shopping_list_items）
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const shoppingListId = searchParams.get('shoppingListId');
  const status = searchParams.get('status') || 'active';

  try {
    if (shoppingListId) {
      // UUID の形でない id は DB に渡さず 404 (リストが無い id と同じ。uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る。#1917 の続き)
      if (!isUuid(shoppingListId)) {
        return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
      }
      // 特定の買い物リストを取得。DB の失敗は 500、他人のリスト・消えたリストは 404 (#1917 の続き。.single() は 0 行を失敗にして 500 にしていた)
      const { data, error } = await supabase
        .from('shopping_lists')
        .select(`
          *,
          shopping_list_items(*)
        `)
        .eq('id', shoppingListId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
      }

      return NextResponse.json({ 
        shoppingList: toShoppingList(data)
      });
    } else {
      // アクティブな買い物リストを取得
      // 最後に作ったリスト 1 行。同じ日時のリストが 2 つあっても、どちらを取るかは id の順で決まる (#2139 T1)
      const { data, error } = await orderListBy(
        supabase
          .from('shopping_lists')
          .select(`
          *,
          shopping_list_items(*)
        `)
          .eq('user_id', user.id)
          .eq('status', status),
        LIST_ORDERS.shoppingListLatest,
      )
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      return NextResponse.json({ 
        shoppingList: data ? toShoppingList(data) : null
      });
    }
  } catch (error: any) {
    return internalError('GET /api/shopping-list', error, { userId: user.id });
  }
}

/**
 * 買い物リストアイテム追加API
 */
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const json = await request.json().catch(() => null);
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { shoppingListId, itemName, category, quantity } = json;

    if (!shoppingListId) {
      return NextResponse.json({ error: SHOPPING_LIST_ID_REQUIRED_MESSAGE }, { status: 400 });
    }
    // UUID の形でない shoppingListId は DB に渡さず 400 (uuid 型の列に渡すと 22P02 で失敗し、下の catch の 500 に入っていた。#1917 の続き)
    if (!isUuid(shoppingListId)) {
      return NextResponse.json({ error: SHOPPING_LIST_ID_INVALID_MESSAGE }, { status: 400 });
    }

    // #262: itemName が null/undefined/空文字の場合は 400
    const name = (itemName ?? '').trim();
    if (!name) {
      return NextResponse.json({ error: ITEM_NAME_REQUIRED_MESSAGE }, { status: 400 });
    }

    // 追加先は本人の買い物リストだけ (shopping_list_items の RLS「Users can manage own shopping list」と同じ条件)。
    // 他人のリスト・消えたリストに insert すると RLS の違反の DB の失敗になり 500 になっていたので、先に確かめて 404 にする (#1917 の続き)。
    // 確かめられなかった (DB の失敗) ときは 500
    const { data: shoppingList, error: shoppingListError } = await supabase
      .from('shopping_lists')
      .select('id')
      .eq('id', shoppingListId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (shoppingListError) throw shoppingListError;
    if (!shoppingList) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('shopping_list_items')
      .insert({
        shopping_list_id: shoppingListId,
        item_name: name,
        normalized_name: name, // 手動追加は item_name をそのまま使用
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
    return internalError('POST /api/shopping-list', error, { userId: user.id });
  }
}

/**
 * 買い物リストアイテム一括削除API
 */
export async function DELETE(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const json = await request.json().catch(() => null);
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { itemIds } = json;

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return NextResponse.json({ error: ITEM_IDS_REQUIRED_MESSAGE }, { status: 400 });
    }
    // UUID の形でない値が 1 つでもあれば DB に渡さず 400 (uuid 型の列に .in で渡すと 22P02 で失敗し、下の catch の 500 に入っていた。#1917 の続き)
    if (!itemIds.every(isUuid)) {
      return NextResponse.json({ error: ITEM_IDS_INVALID_MESSAGE }, { status: 400 });
    }

    const { error } = await supabase
      .from('shopping_list_items')
      .delete()
      .in('id', itemIds);

    if (error) throw error;

    return NextResponse.json({ success: true, deletedCount: itemIds.length });
  } catch (error: any) {
    return internalError('DELETE /api/shopping-list', error, { userId: user.id });
  }
}
