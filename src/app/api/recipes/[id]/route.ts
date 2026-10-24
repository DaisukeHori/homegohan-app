import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { recipeAuthorName } from '@/lib/recipes/author-name';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_FORBIDDEN_MESSAGE, API_INVALID_JSON_MESSAGE, API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { isUuid } from '@/lib/http-params';
import { loadRecipeViewerLookups } from '@/lib/recipes/viewer-lookups';

// レシピ詳細取得
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // UUID の形でない id は DB に渡さず、行が無い id と同じ 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る。#1917)
  if (!isUuid(params.id)) {
    return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // 閲覧数インクリメントは認証ユーザーのみ (未認証アクセスによる水増しを防ぐ)
  // #257: SELECT+UPDATE の race を排除するため単一アトミック UPDATE で実施
  if (user) {
    try {
      await supabase.rpc('increment_recipe_view_count', { recipe_id: params.id });
    } catch (e) {
      // 閲覧数更新エラーは無視
    }
  }

  // 作者の名前 (user_profiles) と自分のいいね (recipe_likes) は埋め込まない (どちらの埋め込みも PostgREST が解決できず、
  // この API はいつも 500 になっていた。#1917。src/lib/recipes/viewer-lookups.ts)。コメントは recipes への外部キーが 1 本なので埋め込める
  const { data, error } = await supabase
    .from('recipes')
    .select(`
      *,
      recipe_comments(
        id,
        content,
        rating,
        created_at,
        user_id
      )
    `)
    .eq('id', params.id)
    // #1445: 行が見えない (存在しない・本人以外から見た非公開や運営が隠したレシピは RLS で 0 行になる) ときは 404。
    // .single() だと 0 行が PGRST116 のエラーになり、500 を返していた
    .maybeSingle();

  if (error) return internalError('GET /api/recipes/[id]', error, { userId: user?.id });
  if (!data) return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });

  // 非公開レシピは作成者のみ閲覧可能
  if (!data.is_public && data.user_id !== user?.id) {
    return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  const comments = data.recipe_comments || [];
  // 作者 (レシピとコメント) の名前と自分のいいねを別のクエリで引く。読めなかったときも 500 (名前が無い・いいねしていないように見せない)
  const lookups = await loadRecipeViewerLookups(supabase, user?.id ?? null, {
    authorIds: [data.user_id, ...comments.map((c: { user_id: string | null }) => c.user_id)],
    recipeIds: [data.id],
  });
  if (!lookups.ok) {
    return internalError('GET /api/recipes/[id]', lookups.error, { userId: user?.id, table: lookups.table });
  }

  const recipe = {
    id: data.id,
    userId: data.user_id,
    authorName: recipeAuthorName(lookups.nicknames.get(data.user_id)),
    name: data.name,
    description: data.description,
    caloriesKcal: data.calories_kcal,
    cookingTimeMinutes: data.cooking_time_minutes,
    servings: data.servings,
    imageUrl: data.image_url,
    ingredients: data.ingredients,
    steps: data.steps,
    isPublic: data.is_public,
    category: data.category,
    cuisineType: data.cuisine_type,
    difficulty: data.difficulty,
    tags: data.tags || [],
    nutrition: data.nutrition,
    tips: data.tips,
    videoUrl: data.video_url,
    sourceUrl: data.source_url,
    viewCount: data.view_count || 0,
    likeCount: data.like_count || 0,
    isLiked: lookups.likedRecipeIds.has(data.id),
    isOwner: user?.id === data.user_id,
    // コメントを書いた人の user_id は返さない (#168。名前だけ)
    comments: comments.map((c: any) => ({
      id: c.id,
      content: c.content,
      rating: c.rating,
      authorName: recipeAuthorName(lookups.nicknames.get(c.user_id)),
      createdAt: c.created_at,
    })),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };

  return NextResponse.json({ recipe });
}

// レシピ更新
export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // UUID の形でない id は DB に渡さない (行が無い id と同じ 403。uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: API_FORBIDDEN_MESSAGE }, { status: 403 });
    }

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400 (DB に触れる前に断る)。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }

    // 所有者確認。読めなかったときは 403 にしない (DB の失敗は 500。行が無い・他人のレシピのときだけ 403。#1917)
    const { data: existing, error: existingError } = await supabase
      .from('recipes')
      .select('user_id')
      .eq('id', params.id)
      .maybeSingle();

    if (existingError) {
      return internalError('PUT /api/recipes/[id]', existingError, { userId: user.id, table: 'recipes' });
    }
    if (!existing || existing.user_id !== user.id) {
      return NextResponse.json({ error: API_FORBIDDEN_MESSAGE }, { status: 403 });
    }

    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.caloriesKcal !== undefined) updateData.calories_kcal = body.caloriesKcal;
    if (body.cookingTimeMinutes !== undefined) updateData.cooking_time_minutes = body.cookingTimeMinutes;
    if (body.servings !== undefined) updateData.servings = body.servings;
    if (body.imageUrl !== undefined) updateData.image_url = body.imageUrl;
    if (body.ingredients !== undefined) updateData.ingredients = body.ingredients;
    if (body.steps !== undefined) updateData.steps = body.steps;
    if (body.isPublic !== undefined) updateData.is_public = body.isPublic;
    if (body.category !== undefined) updateData.category = body.category;
    if (body.cuisineType !== undefined) updateData.cuisine_type = body.cuisineType;
    if (body.difficulty !== undefined) updateData.difficulty = body.difficulty;
    if (body.tags !== undefined) updateData.tags = body.tags;
    if (body.nutrition !== undefined) updateData.nutrition = body.nutrition;
    if (body.tips !== undefined) updateData.tips = body.tips;
    if (body.videoUrl !== undefined) updateData.video_url = body.videoUrl;

    const { data, error } = await supabase
      .from('recipes')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, recipe: data });

  } catch (error: any) {
    return internalError('PUT /api/recipes/[id]', error, { userId: user.id });
  }
}

// レシピ削除
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // UUID の形でない id は DB に渡さない (行が無い id と同じ 403。uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: API_FORBIDDEN_MESSAGE }, { status: 403 });
    }

    // 所有者確認。読めなかったときは 403 にしない (DB の失敗は 500。行が無い・他人のレシピのときだけ 403。#1917)
    const { data: existing, error: existingError } = await supabase
      .from('recipes')
      .select('user_id')
      .eq('id', params.id)
      .maybeSingle();

    if (existingError) {
      return internalError('DELETE /api/recipes/[id]', existingError, { userId: user.id, table: 'recipes' });
    }
    if (!existing || existing.user_id !== user.id) {
      return NextResponse.json({ error: API_FORBIDDEN_MESSAGE }, { status: 403 });
    }

    const { error } = await supabase
      .from('recipes')
      .delete()
      .eq('id', params.id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return internalError('DELETE /api/recipes/[id]', error, { userId: user.id });
  }
}
