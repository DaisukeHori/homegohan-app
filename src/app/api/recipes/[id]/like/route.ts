import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';

/**
 * like_count を共通で再集計するヘルパー。
 * #258: TEXT-only legacy の recipe_id に対しても recipes.like_count を直接 UPDATE して
 * トリガーが発火しないケースを補完する。
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

  // recipe_id はレシピ名 (TEXT) であるため、recipes.name で照合して like_count を同期する
  // #258: TEXT-only legacy の recipe_id に対して recipes.like_count を直接 UPDATE する
  await supabase
    .from('recipes')
    .update({ like_count: likeCount })
    .eq('name', recipeId)
    .then(() => {/* 失敗しても無視 — 名前未登録レシピは対象外 */});

  return likeCount;
}

// いいね状態取得
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data } = await supabase
    .from('recipe_likes')
    .select('user_id')
    .eq('recipe_id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  return NextResponse.json({ liked: !!data });
}

// いいね追加
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // UPSERT で冪等化（重複 insert を防ぐ）
    const { error: insertError } = await supabase
      .from('recipe_likes')
      .upsert(
        { recipe_id: params.id, user_id: user.id },
        { onConflict: 'user_id,recipe_id', ignoreDuplicates: true },
      );

    if (insertError) throw insertError;

    const likeCount = await refreshLikeCount(supabase, params.id);

    return NextResponse.json({ success: true, liked: true, likeCount });

  } catch (error: any) {
    return internalError('POST /api/recipes/[id]/like', error, { userId: user.id });
  }
}

// いいね削除 (#106: DELETE 時も like_count を更新)
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

