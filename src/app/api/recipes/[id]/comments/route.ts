import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { recipeAuthorName } from '@/lib/recipes/author-name';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { isUuid } from '@/lib/http-params';
import { loadRecipeViewerLookups } from '@/lib/recipes/viewer-lookups';

/** Postgres の外部キー違反 (insert の参照先の行が無い) */
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';
/** recipe_comments.recipe_id → recipes.id の外部キーの名前 (supabase/migrations/20251126124224_create_meal_planner_tables.sql) */
const RECIPE_COMMENTS_RECIPE_FK = 'recipe_comments_recipe_id_fkey';

// コメント一覧取得 (user_id は公開しない)
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();

  // 未認証は 401
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る。#1917)
  if (!isUuid(params.id)) {
    return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  // 書いた人の名前 (user_profiles) は埋め込まずに別のクエリで引く (recipe_comments.user_id の外部キーは auth.users 宛で、
  // `user_profiles(nickname)` の埋め込みは PostgREST が解決できず、この API はいつも 500 になっていた。#1917。src/lib/recipes/viewer-lookups.ts)
  const { data, error } = await supabase
    .from('recipe_comments')
    .select('id, content, rating, created_at, user_id')
    .eq('recipe_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return internalError('GET /api/recipes/[id]/comments', error, { userId: user.id });

  const rows = data || [];
  const lookups = await loadRecipeViewerLookups(supabase, user.id, {
    authorIds: rows.map((c: { user_id: string | null }) => c.user_id),
    recipeIds: [],
  });
  if (!lookups.ok) {
    return internalError('GET /api/recipes/[id]/comments', lookups.error, { userId: user.id, table: lookups.table });
  }

  // 書いた人の user_id は返さない (#168。名前だけ)
  const comments = rows.map((c: any) => ({
    id: c.id,
    content: c.content,
    rating: c.rating,
    authorName: recipeAuthorName(lookups.nicknames.get(c.user_id)),
    createdAt: c.created_at,
  }));

  return NextResponse.json({ comments });
}

// コメント追加
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // UUID の形でない id は DB に渡さず 404 (レシピが無いときと同じ。uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る。#1917)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }

    // #259: content 長さ制限 (1〜5000文字)
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (content.length === 0) {
      return NextResponse.json({ error: 'コメントを入力してください' }, { status: 400 });
    }
    if (content.length > 5000) {
      return NextResponse.json({ error: 'コメントは5000文字以内で入力してください' }, { status: 400 });
    }

    // #260: rating validation (1〜5の整数のみ許可)
    let rating: number | null = null;
    if (body.rating !== undefined && body.rating !== null) {
      const r = Number(body.rating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        return NextResponse.json({ error: '評価 (rating) は 1〜5 の整数で入力してください' }, { status: 400 });
      }
      rating = r;
    }

    // 返す名前 (自分の user_profiles.nickname) は、埋め込まずに (PostgREST が解決できず、この API はいつも 500 になっていた。#1917)、
    // コメントを保存する前に引く。引けなかったときは何も保存せずに 500 にする (保存したあとで失敗すると、保存できたのに失敗に見える)
    const lookups = await loadRecipeViewerLookups(supabase, user.id, { authorIds: [user.id], recipeIds: [] });
    if (!lookups.ok) {
      return internalError('POST /api/recipes/[id]/comments', lookups.error, { userId: user.id, table: lookups.table });
    }

    const { data, error } = await supabase
      .from('recipe_comments')
      .insert({
        recipe_id: params.id,
        user_id: user.id,
        content,
        rating,
      })
      .select('id, content, rating, created_at')
      .single();

    // レシピが無い (消された) ときは recipe_id の外部キー違反になる。500 にせず、レシピが無いときの 404 にする (#1917)。
    // ほかの外部キー (user_id) の違反は含めない (今までどおり 500)
    if (error?.code === POSTGRES_FOREIGN_KEY_VIOLATION && error.message.includes(RECIPE_COMMENTS_RECIPE_FK)) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }
    if (error) throw error;

    return NextResponse.json({
      success: true,
      comment: {
        id: data.id,
        content: data.content,
        rating: data.rating,
        authorName: recipeAuthorName(lookups.nicknames.get(user.id)),
        createdAt: data.created_at,
      }
    });

  } catch (error: any) {
    return internalError('POST /api/recipes/[id]/comments', error, { userId: user.id });
  }
}

