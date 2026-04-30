import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { NextResponse } from 'next/server';

/**
 * GET /api/favorites
 * ログインユーザーのお気に入りレシピ一覧を返す (#109)
 * recipe_likes テーブルから recipe_id (dish name) を取得する
 * #302: id / recipe_uuid カラムが本番 DB に存在しない場合の 500 を修正
 */

/** フィルタ・ソート・ページングを適用したクエリを実行する (any 型で柔軟に処理) */
async function queryFavorites(
  supabase: Awaited<ReturnType<typeof createClient>>,
  columns: string,
  params: { userId: string; query: string; sort: string; offset: number; limit: number },
) {
  let q: any = supabase
    .from('recipe_likes')
    .select(columns, { count: 'exact' })
    .eq('user_id', params.userId);

  if (params.query) q = q.ilike('recipe_id', `%${params.query}%`);

  switch (params.sort) {
    case 'oldest': q = q.order('created_at', { ascending: true }); break;
    case 'name':   q = q.order('recipe_id',   { ascending: true }); break;
    default:       q = q.order('created_at',   { ascending: false });
  }

  return (await q.range(params.offset, params.offset + params.limit - 1)) as {
    data: any[] | null;
    error: { code: string; message: string } | null;
    count: number | null;
  };
}

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
  const params = { userId: user.id, query, sort, offset, limit };

  // カラムリスト: フル → id なし → 最小セット の順でフォールバック
  // 本番 DB で id / recipe_uuid が CREATE TABLE IF NOT EXISTS のスキップで
  // 追加されていない場合に 500 を回避する (#302)
  const columnSets = [
    'id, recipe_id, recipe_uuid, created_at',
    'user_id, recipe_id, recipe_uuid, created_at',
    'user_id, recipe_id, created_at',
  ];

  try {
    let lastError: { code: string; message: string } | null = null;

    for (const columns of columnSets) {
      const r = await queryFavorites(supabase, columns, params);
      if (!r.error) {
        return NextResponse.json({
          favorites: (r.data ?? []).map((row: any) => ({
            id: row.id ?? `${row.user_id}:${row.recipe_id}`,
            recipeName: row.recipe_id,
            recipeUuid: row.recipe_uuid ?? null,
            likedAt: row.created_at,
          })),
          total: r.count ?? 0,
        });
      }
      // 42703 = column not found → 次の columns セットを試す
      if (r.error.code !== '42703') throw r.error;
      lastError = r.error;
      userLogger.warn(`column not found (${r.error.message}), retrying with narrower select`);
    }

    throw lastError ?? new Error('Failed to query recipe_likes');
  } catch (error: any) {
    userLogger.error('Favorites fetch error', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
