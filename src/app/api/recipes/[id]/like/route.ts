import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { isUuid } from '@/lib/http-params';

/** Postgres の外部キー違反 (insert の参照先の行が無い) */
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';
/** recipe_likes.recipe_id → recipes.id の外部キーの名前 (supabase/baseline/prod_schema.sql の recipe_likes の制約) */
const RECIPE_LIKES_RECIPE_FK = 'recipe_likes_recipe_id_fkey';

/**
 * like_count を共通で再集計するヘルパー。
 * recipe_likes.recipe_id は uuid の列 (recipes.id への外部キー。supabase/baseline/prod_schema.sql)。
 * 下の recipes.name での UPDATE は #258 (recipe_id がレシピの名前の文字列だった頃) の名残で、uuid の値は名前と一致しないので、
 * 今は何も更新しない (like_count の同期は別に扱う。#1917 の続き)。
 */
async function refreshLikeCount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  recipeId: string,
): Promise<number> {
  const { count } = await supabase
    .from('recipe_likes')
    .select('*', { count: 'exact', head: true })
    .eq('recipe_id', recipeId);

  const likeCount = count ?? 0;

  // #258 の名残: recipe_id がレシピの名前の文字列だった頃に recipes.name で照合して like_count を同期していた。
  // 今の recipe_id は uuid なので、ここで一致する行は無い
  await supabase
    .from('recipes')
    .update({ like_count: likeCount })
    .eq('name', recipeId)
    .then(() => {/* 失敗しても無視 — 名前未登録レシピは対象外 */});

  return likeCount;
}

// いいね状態取得
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // UUID の形でない id は DB に渡さず、いいねの行が無いときと同じ { liked: false } (recipe_likes.recipe_id は uuid の列。#1917 の続き)。
  // 404 にしない: 献立の画面 (src/app/(main)/menus/weekly/page.tsx) は失敗の応答では印を更新せず、前のレシピの印が残る
  if (!isUuid(params.id)) return NextResponse.json({ liked: false });

  const { data } = await supabase
    .from('recipe_likes')
    .select('user_id')
    .eq('recipe_id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  return NextResponse.json({ liked: !!data });
}

// いいね追加
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // UUID の形でない id は DB に渡さず 404 (レシピが無いときと同じ。uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る。#1917 の続き)
  if (!isUuid(params.id)) return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });

  try {
    // UPSERT で冪等化（重複 insert を防ぐ）
    const { error: insertError } = await supabase
      .from('recipe_likes')
      .upsert(
        { recipe_id: params.id, user_id: user.id },
        { onConflict: 'user_id,recipe_id', ignoreDuplicates: true },
      );

    // レシピが無い (消された) ときは recipe_id の外部キー違反になる。500 にせず、レシピが無いときの 404 にする (#1917 の続き。コメントの POST と同じ)。
    // ほかの外部キー (user_id) の違反は含めない (今までどおり 500)
    if (insertError?.code === POSTGRES_FOREIGN_KEY_VIOLATION && insertError.message.includes(RECIPE_LIKES_RECIPE_FK)) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }
    if (insertError) throw insertError;

    const likeCount = await refreshLikeCount(supabase, params.id);

    return NextResponse.json({ success: true, liked: true, likeCount });

  } catch (error: any) {
    return internalError('POST /api/recipes/[id]/like', error, { userId: user.id });
  }
}

// いいね削除 (#106: DELETE 時も like_count を更新)
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // UUID の形でない id は DB に渡さず 404 (POST と同じ。uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る。#1917 の続き)。
  // 200 にしない: 呼び出し側は成功の応答を「消えた」と読むので、何も消していないのに消えたように見える
  // (お気に入りの画面と献立の ♥ は #2011 から dish_favorites の DELETE /api/favorites/{id} を使い、この route を呼ばない)
  if (!isUuid(params.id)) return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });

  try {
    const { error } = await supabase
      .from('recipe_likes')
      .delete()
      .eq('recipe_id', params.id)
      .eq('user_id', user.id);

    if (error) throw error;

    const likeCount = await refreshLikeCount(supabase, params.id);

    return NextResponse.json({ success: true, liked: false, likeCount });

  } catch (error: any) {
    return internalError('DELETE /api/recipes/[id]/like', error, { userId: user.id });
  }
}

