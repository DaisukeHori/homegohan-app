import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { clampIntParam } from '@/lib/http-params';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';

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
    status: number;
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
  // #1226: limit / offset は clampIntParam で丸める。以前は limit が Math.min(Number(...), 200) で
  // 上限しか見ておらず、offset は無加工だったため、?limit=abc・?offset=abc (NaN) は空の一覧になり、
  // ?limit=-50 や桁あふれする offset は不正な範囲が .range() に渡って
  // PostgREST のエラー → 生のメッセージ付きの 500 になっていた。
  // 数字でない値・空は既定値へ、範囲外の値は端に寄せる。
  const limit = clampIntParam(searchParams.get('limit'), { min: 1, max: 200, default: 100 });
  const offset = clampIntParam(searchParams.get('offset'), { min: 0, max: 100000, default: 0 });
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
      // offset が件数より先だと PostgREST は 416 (Range Not Satisfiable) を返す (#1226)。
      // 上限までに丸めても、お気に入りの数より大きい offset はこの形で残る。
      // 500 にはせず、空のページと本当の total を返す (total は先頭 1 件の問い合わせで取り直す)。
      if (r.status === 416) {
        const firstRow = await queryFavorites(supabase, columns, { ...params, offset: 0, limit: 1 });
        if (!firstRow.error) return NextResponse.json({ favorites: [], total: firstRow.count ?? 0 });
      }
      // 42703 = column not found → 次の columns セットを試す
      if (r.error.code !== '42703') throw r.error;
      lastError = r.error;
      userLogger.warn(`column not found (${r.error.message}), retrying with narrower select`);
    }

    throw lastError ?? new Error('Failed to query recipe_likes');
  } catch (error: any) {
    return internalError('GET /api/favorites', error, { userId: user.id, requestId });
  }
}
