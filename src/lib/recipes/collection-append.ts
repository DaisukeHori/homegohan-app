/**
 * レシピのコレクション (recipe_collections) にレシピを 1 つ足す DB の関数の名前と、関数が返す結果の値 (#2183 Z3)。
 *
 * 足す所 (AI 相談のアクション add_recipe_to_collection。src/lib/ai/consultation-action-executor.ts) は、
 * recipe_ids を読んでから書くのをやめ、この関数を呼ぶ (supabase/migrations の *_recipe_collections_append_recipe_rpc.sql)。
 * 関数の中身は 1 文の条件つき UPDATE (array_append。まだ入っていないときだけ書く) なので、同じコレクションへほぼ同時に
 * 2 つのレシピを足しても、後から書いた方が先の追加を上書きしない (行のロックを待った方が、相手の書いた後の値に足す)。
 * 関数の名前・引数の名前・結果の値は tests/recipe-collections-append-recipe-rpc-migration-contract.test.ts が migration と突き合わせる。
 */

/** DB の関数の名前 (supabase.rpc に渡す) */
export const RECIPE_COLLECTIONS_APPEND_RECIPE_RPC = 'append_recipe_to_collection';

/** DB の関数の引数の名前 (並びは関数の定義と同じ) */
export const RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ARGS = ['p_collection_id', 'p_recipe_id'] as const;

/**
 * DB の関数が返す結果の値。
 *   - added: このレシピを recipe_ids の末尾に足した
 *   - already_present: 本人のコレクションに、このレシピが既に入っていた (何も書かない)
 *   - not_found: 本人のコレクションに、この id の行が無い (消えた・他人の行。RLS で見えない行も含む)
 * 引数に NULL を渡すと、関数は STRICT なので NULL を返す (どの値でもない = 失敗として扱う)。
 */
export const RECIPE_COLLECTION_APPEND_OUTCOME = {
  added: 'added',
  alreadyPresent: 'already_present',
  notFound: 'not_found',
} as const;

export type RecipeCollectionAppendOutcome =
  (typeof RECIPE_COLLECTION_APPEND_OUTCOME)[keyof typeof RECIPE_COLLECTION_APPEND_OUTCOME];

const APPEND_OUTCOME_VALUES: ReadonlySet<string> = new Set(Object.values(RECIPE_COLLECTION_APPEND_OUTCOME));

/** DB の関数の戻り値が、結果の値のどれかか (NULL・想定外の値は false) */
export function isRecipeCollectionAppendOutcome(value: unknown): value is RecipeCollectionAppendOutcome {
  return typeof value === 'string' && APPEND_OUTCOME_VALUES.has(value);
}
