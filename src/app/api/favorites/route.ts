import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * GET /api/favorites
 * ログインユーザーのお気に入りレシピ一覧を返す (#109)
 * recipe_likes テーブルから recipe_id (dish name) を取得する
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit') ?? '100'), 200);
  const offset = Number(searchParams.get('offset') ?? '0');
  const query = searchParams.get('q')?.trim() ?? '';
  const sort = searchParams.get('sort') ?? 'newest'; // newest | oldest | name

  try {
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

    const { data, error, count } = await dbQuery;
    if (error) throw error;

    return NextResponse.json({
      favorites: (data ?? []).map((row: any) => ({
        id: row.id,
        recipeName: row.recipe_id,
        recipeUuid: row.recipe_uuid ?? null,
        likedAt: row.created_at,
      })),
      total: count ?? 0,
    });
  } catch (error: any) {
    console.error('Favorites fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
