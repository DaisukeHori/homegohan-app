import { createClient } from '@/lib/supabase/server';
import { generateRequestId } from '@/lib/db-logger';
import { clampIntParam } from '@/lib/http-params';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { recipeAuthorName } from '@/lib/recipes/author-name';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { escapeLikePattern, quotePostgrestValue } from '@/lib/admin/users-search';
import { loadRecipeViewerLookups } from '@/lib/recipes/viewer-lookups';
import { RECIPE_NAME_REQUIRED_MESSAGE, RecipeCreateBodySchema } from '@/lib/recipes/recipe-body';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/recipes';

// レシピ一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const category = searchParams.get('category');
  const cuisineType = searchParams.get('cuisine_type');
  const difficulty = searchParams.get('difficulty');
  // #1220: ?limit=100000 のような値で 1 リクエストが大量行を要求できた（公開レシピは未認証でも
  // 取れる）ため clampIntParam で丸める。数字でない値は既定値へ（以前は NaN になり、
  // DB エラー→空の 200 になっていた）。limit の上限 100 は呼び出し元のモバイル（limit=30 固定）に十分。
  const page = clampIntParam(searchParams.get('page'), { min: 1, max: 1000, default: 1 });
  const limit = clampIntParam(searchParams.get('limit'), { min: 1, max: 100, default: 20 });
  const offset = (page - 1) * limit;
  // max_time は数字として読めるときだけ 1〜1440 分に丸めて絞り込む（数字でない値・空は無視）。
  // clampIntParam は無効な値を default に倒すので、min より小さい 0 を「指定なし」の目印にしている。
  const maxTime = clampIntParam(searchParams.get('max_time'), { min: 1, max: 1440, default: 0 });

  // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectRecipes) から作る
  const selectRecipes = (options: { head?: boolean } = {}) => {
    let dbQuery = supabase
      .from('recipes')
      .select('*', listCountOptions(options.head));

    // 公開レシピ、または自分のレシピ
    if (user) {
      dbQuery = dbQuery.or(`is_public.eq.true,user_id.eq.${user.id}`);
    } else {
      dbQuery = dbQuery.eq('is_public', true);
    }

    // フィルター。検索語は引用符と LIKE のワイルドカードをエスケープして or=(...) に入れる
    // ("," ")" を含む検索語が or=(...) の構文を壊して DB の失敗 (500) にならないように。"%" "_" も文字どおりに一致させる)
    if (query) {
      const pattern = quotePostgrestValue(`%${escapeLikePattern(query)}%`);
      dbQuery = dbQuery.or(`name.ilike.${pattern},description.ilike.${pattern}`);
    }
    if (category) {
      dbQuery = dbQuery.eq('category', category);
    }
    if (cuisineType) {
      dbQuery = dbQuery.eq('cuisine_type', cuisineType);
    }
    if (difficulty) {
      dbQuery = dbQuery.eq('difficulty', difficulty);
    }
    if (maxTime > 0) {
      dbQuery = dbQuery.lte('cooking_time_minutes', maxTime);
    }
    return dbQuery;
  };

  const { data, error, count } = await resolveBeyondLastPage(
    // 作った日時の新しい順。同じ日時は id の順で、ページの境目でも順が変わらない (#2139 T1)
    await orderListBy(selectRecipes(), LIST_ORDERS.recipes).range(offset, offset + limit - 1),
    () => selectRecipes({ head: true }),
    LIST_ROUTE_NAME,
  );

  // DB の失敗は 200 の空の一覧にしない (「0 件」と失敗を見分けられるように 500。DB の生の文面は本文に出さない)。
  // 件数より後ろのページは、上で空のページと本当の件数にしてある
  if (error) {
    return internalError(LIST_ROUTE_NAME, error, { userId: user?.id });
  }

  const rows = data || [];
  // 作者の名前と自分のいいねは、埋め込まずに別のクエリで引く (どちらの埋め込みも PostgREST が解決できない。
  // src/lib/recipes/viewer-lookups.ts)。読めなかったときも 500 (名前が無い・いいねしていないように見せない)
  const lookups = await loadRecipeViewerLookups(supabase, user?.id ?? null, {
    authorIds: rows.map((item) => item.user_id),
    recipeIds: rows.map((item) => item.id),
  });
  if (!lookups.ok) {
    return internalError(LIST_ROUTE_NAME, lookups.error, { userId: user?.id, table: lookups.table });
  }

  // キャメルケース変換
  const recipes = rows.map((item: any) => ({
    id: item.id,
    userId: item.user_id,
    authorName: recipeAuthorName(lookups.nicknames.get(item.user_id)),
    name: item.name,
    description: item.description,
    caloriesKcal: item.calories_kcal,
    cookingTimeMinutes: item.cooking_time_minutes,
    servings: item.servings,
    imageUrl: item.image_url,
    ingredients: item.ingredients,
    steps: item.steps,
    isPublic: item.is_public,
    category: item.category,
    cuisineType: item.cuisine_type,
    difficulty: item.difficulty,
    tags: item.tags || [],
    nutrition: item.nutrition,
    tips: item.tips,
    videoUrl: item.video_url,
    viewCount: item.view_count || 0,
    likeCount: item.like_count || 0,
    isLiked: lookups.likedRecipeIds.has(item.id),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));

  return NextResponse.json({ 
    recipes,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    }
  });
}

// レシピ作成
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const requestId = generateRequestId();
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない・配列) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    // 名前 (recipes.name は NOT NULL) の無い本文は DB に渡さず 400。以前は name: undefined のまま insert し、NOT NULL 違反で 500 になっていた (#1917 の続き)
    if (!RecipeCreateBodySchema.safeParse(body).success) {
      return NextResponse.json({ error: RECIPE_NAME_REQUIRED_MESSAGE }, { status: 400 });
    }

    const recipeData = {
      user_id: user.id,
      name: body.name,
      description: body.description || null,
      calories_kcal: body.caloriesKcal || null,
      cooking_time_minutes: body.cookingTimeMinutes || null,
      servings: body.servings || 2,
      image_url: body.imageUrl || null,
      ingredients: body.ingredients || [],
      steps: body.steps || [],
      is_public: body.isPublic ?? false,
      category: body.category || 'main',
      cuisine_type: body.cuisineType || 'japanese',
      difficulty: body.difficulty || 'easy',
      tags: body.tags || [],
      nutrition: body.nutrition || null,
      tips: body.tips || null,
      video_url: body.videoUrl || null,
      source_url: body.sourceUrl || null,
    };

    const { data, error } = await supabase
      .from('recipes')
      .insert(recipeData)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ 
      success: true, 
      recipe: {
        id: data.id,
        name: data.name,
        createdAt: data.created_at,
      }
    });

  } catch (error: any) {
    return internalError('POST /api/recipes', error, { userId: user.id, requestId });
  }
}


