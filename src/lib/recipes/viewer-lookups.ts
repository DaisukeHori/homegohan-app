// src/lib/recipes/viewer-lookups.ts
// レシピの API (GET /api/recipes・GET /api/recipes/[id]・GET / POST /api/recipes/[id]/comments) が、作者の名前
// (user_profiles.nickname) と、見ている人のいいね (recipe_likes) を、レシピ・コメントとは別のクエリで引く (#1917)。
//
// select の埋め込み (`user_profiles(nickname)`・`recipe_likes(user_id)`) を使わない理由 (supabase/baseline/prod_schema.sql):
//   - recipes.user_id・recipe_comments.user_id の外部キーは auth.users 宛で、public のどのテーブルも user_profiles への外部キーを
//     持たない。PostgREST は関係を外部キーで見つけるので、`user_profiles(...)` の埋め込みは解決できず PGRST200 の失敗になる
//     (#211 の migration 20260430150000 が足そうとした recipes → user_profiles の外部キーは、本番には入っていない)
//   - recipe_likes は recipes への外部キーを 2 本 (recipe_id・recipe_uuid) 持つので、`recipe_likes(...)` の埋め込みは
//     どちらの関係か決まらず PGRST201 の失敗になる
// 以前の GET /api/recipes は、ログイン中に限ってこの埋め込みを使い、失敗を 200 の空の一覧で隠していた (ログイン中の一覧はいつも空)。
// レシピの詳細とコメントの API は、いつも 500 になっていた。
// 解決できない埋め込みは tests/postgrest-embed-relationship-scan.test.ts が src の全域で見張る。
//
// 名前が引けるのは、RLS (user_profiles の "Users can view own profile") で見ている人が読める行だけ (いまは本人の行だけ)。
// 引けなかった作者は recipeAuthorName の既定の呼称になる。未ログインのときは、どちらも DB に問い合わせない
// (RLS で 1 行も読めず、いいねも無いので、結果が変わらない)。
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

/** レシピの API が使う、RLS の効く Supabase クライアント (from だけを使う) */
export type RecipeViewerDb = Pick<SupabaseClient, 'from'>;

/** 引いたものを、作者の名前といいねに分けて持つ */
export interface RecipeViewerLookups {
  /** 作者の id → user_profiles.nickname (引けなかった作者は入らない) */
  nicknames: ReadonlyMap<string, unknown>;
  /** 見ている人がいいねしたレシピの id */
  likedRecipeIds: ReadonlySet<string>;
}

/** 失敗したら、どのテーブルの読み込みが失敗したかと DB のエラーを返す (route が 500 にする) */
export type RecipeViewerLookupResult =
  | ({ ok: true } & RecipeViewerLookups)
  | { ok: false; table: 'user_profiles' | 'recipe_likes'; error: PostgrestError };

interface ProfileRow {
  id: string;
  nickname: unknown;
}

interface LikeRow {
  recipe_id: string;
}

/** 空の値・重複を除く */
function distinctIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/**
 * 見ている人 (viewerId。未ログインは null) から見た、作者の名前と、自分のいいね。
 * authorIds・recipeIds が空なら、その問い合わせはしない。
 * いいねは recipe_likes.recipe_id で照らす (いいねの API (src/app/api/recipes/[id]/like/route.ts) と
 * AI 相談の like_recipe が書く列。recipe_uuid はどちらも書かない)。
 */
export async function loadRecipeViewerLookups(
  supabase: RecipeViewerDb,
  viewerId: string | null,
  targets: { authorIds: ReadonlyArray<string | null | undefined>; recipeIds: ReadonlyArray<string | null | undefined> },
): Promise<RecipeViewerLookupResult> {
  const authorIds = distinctIds(targets.authorIds);
  const recipeIds = distinctIds(targets.recipeIds);
  if (viewerId === null) return { ok: true, nicknames: new Map(), likedRecipeIds: new Set() };

  const [profiles, likes] = await Promise.all([
    authorIds.length > 0
      ? supabase.from('user_profiles').select('id, nickname').in('id', authorIds)
      : Promise.resolve({ data: [] as ProfileRow[], error: null }),
    recipeIds.length > 0
      ? supabase.from('recipe_likes').select('recipe_id').eq('user_id', viewerId).in('recipe_id', recipeIds)
      : Promise.resolve({ data: [] as LikeRow[], error: null }),
  ]);

  if (profiles.error) return { ok: false, table: 'user_profiles', error: profiles.error };
  if (likes.error) return { ok: false, table: 'recipe_likes', error: likes.error };

  const profileRows: ProfileRow[] = profiles.data ?? [];
  const likeRows: LikeRow[] = likes.data ?? [];
  return {
    ok: true,
    nicknames: new Map(profileRows.map((row) => [row.id, row.nickname])),
    likedRecipeIds: new Set(likeRows.map((row) => row.recipe_id)),
  };
}
