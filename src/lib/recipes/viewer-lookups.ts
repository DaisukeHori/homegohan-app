// src/lib/recipes/viewer-lookups.ts
// レシピの API (GET /api/recipes・GET /api/recipes/[id]・GET / POST /api/recipes/[id]/comments) が、作者の表示名と、
// 見ている人のいいね (recipe_likes) を、レシピ・コメントとは別のクエリで引く (#1917。docs/design/cross/21-recipe-author-display-name.md)。
//
// select の埋め込み (`user_profiles(nickname)`・`recipe_likes(user_id)`) を使わない理由 (supabase/baseline/prod_schema.sql):
//   - recipes.user_id・recipe_comments.user_id の外部キーは auth.users 宛で、public のどのテーブルも user_profiles への外部キーを
//     持たない。PostgREST は関係を外部キーで見つけるので、`user_profiles(...)` の埋め込みは解決できず PGRST200 の失敗になる
//   - recipe_likes は recipes への外部キーを 2 本 (recipe_id・recipe_uuid) 持つので、`recipe_likes(...)` の埋め込みは
//     どちらの関係か決まらず PGRST201 の失敗になる
// 解決できない埋め込みは tests/postgrest-embed-relationship-scan.test.ts が src の全域で見張る。
//
// 作者の表示名は、RLS の効くクライアントで SECURITY DEFINER の関数 recipe_author_display_names を呼んで引く
// (user_profiles の SELECT の RLS は本人の行だけなので、表を直接読むと他人の名前はいつも既定の呼称になる)。
// 関数は、本人と、公開の作者 (名前を出す設定・凍結中でない・18 歳以上) の表示名だけを返す。返らなかった作者は
// recipeAuthorName の既定の呼称になる。未ログインでも呼ぶ (公開レシピは未ログインでも読める。関数は anon も呼べる)。
// いいねは、ログイン中だけ自分の recipe_likes を引く (未ログインにはいいねが無い)。
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

/** レシピの API が使う、RLS の効く Supabase クライアント (from と rpc だけを使う) */
export type RecipeViewerDb = Pick<SupabaseClient, 'from' | 'rpc'>;

/** 作者の表示名を返す関数の名前 (supabase/migrations/*_recipe_author_display_names.sql) */
export const RECIPE_AUTHOR_DISPLAY_NAMES_RPC = 'recipe_author_display_names';

/** 引いたものを、作者の表示名といいねに分けて持つ */
export interface RecipeViewerLookups {
  /** 作者の id → 表示名 (関数が返した作者だけ。返らなかった作者は入らない = 既定の呼称になる) */
  authorNames: ReadonlyMap<string, string>;
  /** 見ている人がいいねしたレシピの id */
  likedRecipeIds: ReadonlySet<string>;
}

/** 失敗したら、どの読み込みが失敗したかと DB のエラーを返す (route が 500 にする) */
export type RecipeViewerLookupResult =
  | ({ ok: true } & RecipeViewerLookups)
  | { ok: false; table: typeof RECIPE_AUTHOR_DISPLAY_NAMES_RPC | 'recipe_likes'; error: PostgrestError };

/** recipe_author_display_names の 1 行 (RETURNS TABLE (author_id uuid, display_name text)) */
interface AuthorNameRow {
  author_id: string;
  display_name: string;
}

interface LikeRow {
  recipe_id: string;
}

/** 無い値 (作者のいないシステムのレシピの user_id は NULL) と重複を除く */
function distinctIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

/**
 * 見ている人 (viewerId。未ログインは null) から見た、作者の表示名と、自分のいいね。
 * authorIds が空なら関数を呼ばない。recipeIds が空か未ログインなら、いいねを引かない。
 * いいねは recipe_likes.recipe_id で照らす (いいねの API (src/app/api/recipes/[id]/like/route.ts) と
 * AI 相談の like_recipe が書く列。recipe_uuid はどちらも書かない)。
 */
export async function loadRecipeViewerLookups(
  supabase: RecipeViewerDb,
  viewerId: string | null,
  targets: { authorIds: ReadonlyArray<string | null | undefined>; recipeIds: ReadonlyArray<string | null | undefined> },
): Promise<RecipeViewerLookupResult> {
  const authorIds = distinctIds(targets.authorIds);
  const recipeIds = viewerId === null ? [] : distinctIds(targets.recipeIds);

  const [names, likes] = await Promise.all([
    authorIds.length > 0
      ? supabase.rpc(RECIPE_AUTHOR_DISPLAY_NAMES_RPC, { p_user_ids: authorIds })
      : Promise.resolve({ data: [] as AuthorNameRow[], error: null }),
    viewerId !== null && recipeIds.length > 0
      ? supabase.from('recipe_likes').select('recipe_id').eq('user_id', viewerId).in('recipe_id', recipeIds)
      : Promise.resolve({ data: [] as LikeRow[], error: null }),
  ]);

  if (names.error) return { ok: false, table: RECIPE_AUTHOR_DISPLAY_NAMES_RPC, error: names.error };
  if (likes.error) return { ok: false, table: 'recipe_likes', error: likes.error };

  const nameRows: AuthorNameRow[] = names.data ?? [];
  const likeRows: LikeRow[] = likes.data ?? [];
  return {
    ok: true,
    authorNames: new Map(nameRows.map((row) => [row.author_id, row.display_name])),
    likedRecipeIds: new Set(likeRows.map((row) => row.recipe_id)),
  };
}
