import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { NextResponse } from 'next/server';

/**
 * GET /api/favorites
 * ログインユーザーのお気に入りレシピ一覧を返す (#109)
 * recipe_likes テーブルから recipe_id (dish name) を取得する
 * #302: recipe_uuid カラムが存在しない場合の 500 を修正
 */
export async function GET(request: Request) {
  const requestId = generateRequestId();
  const logger = createLogger('GET /api/favorites', requestId);

  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userLogger = logger.withUser(user.id);

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit') ?? '100'), 200);
  const offset = Number(searchParams.get('offset') ?? '0');
  const query = searchParams.get('q')?.trim() ?? '';
  const sort = searchParams.get('sort') ?? 'newest'; // newest | oldest | name

  try {
    // recipe_uuid は ADD COLUMN IF NOT EXISTS で追加済みだが、
    // 本番 DB に未適用の場合でも id/recipe_id/created_at は必ず存在するため
    // recipe_uuid を別途フォールバック付きで取得する (#302)
    let dbQuery = supabase
      .from('recipe_likes')
      .select('id, recipe_id, recipe_uuid, created_at', { count: 'exact' })
      .eq('user_id', user.id);

    // テキスト検索
    if (query) {
      dbQuery = dbQuery.ilike('recipe_id', `%${query}%`);
    }

    // ソート
    switch (sort) {
      case 'oldest':
        dbQuery = dbQuery.order('created_at', { ascending: true });
        break;
      case 'name':
        dbQuery = dbQuery.order('recipe_id', { ascending: true });
        break;
      default: // newest
        dbQuery = dbQuery.order('created_at', { ascending: false });
    }

    dbQuery = dbQuery.range(offset, offset + limit - 1);

    let result = await dbQuery;

    // recipe_uuid カラムが存在しない場合 (column not found) は
    // recipe_uuid を除いたクエリでリトライして 500 を回避する (#302)
    if (result.error && (result.error.message?.includes('recipe_uuid') || result.error.code === '42703')) {
      userLogger.warn('recipe_uuid column not found, retrying without it', { error: result.error.message });
      let fallbackQuery = supabase
        .from('recipe_likes')
        .select('id, recipe_id, created_at', { count: 'exact' })
        .eq('user_id', user.id);

      if (query) {
        fallbackQuery = fallbackQuery.ilike('recipe_id', `%${query}%`);
      }

      switch (sort) {
        case 'oldest':
          fallbackQuery = fallbackQuery.order('created_at', { ascending: true });
          break;
        case 'name':
          fallbackQuery = fallbackQuery.order('recipe_id', { ascending: true });
          break;
        default:
          fallbackQuery = fallbackQuery.order('created_at', { ascending: false });
      }

      fallbackQuery = fallbackQuery.range(offset, offset + limit - 1);
      result = await fallbackQuery as typeof result;
    }

    if (result.error) throw result.error;

    return NextResponse.json({
      favorites: (result.data ?? []).map((row: any) => ({
        id: row.id,
        recipeName: row.recipe_id,
        recipeUuid: row.recipe_uuid ?? null,
        likedAt: row.created_at,
      })),
      total: result.count ?? 0,
    });
  } catch (error: any) {
    userLogger.error('Favorites fetch error', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
