/**
 * #2183 Z3: レシピのコレクションにレシピを 1 つ足す関数 append_recipe_to_collection を足す migration の値。
 * tests/recipe-collections-append-recipe-rpc-migration-contract.test.ts (静的) と
 * tests/integration/rls/recipe-collections-append-recipe-rpc.test.ts (実 DB) が同じ値を見る。
 * 関数の名前・引数・結果の値はアプリのコードと同じ定数 (src/lib/recipes/collection-append.ts) から作る。
 */
import {
  RECIPE_COLLECTIONS_APPEND_RECIPE_RPC,
  RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ARGS,
} from '@/lib/recipes/collection-append';

/** migration のファイル名の、番号の後ろの名前 */
export const RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_MIGRATION_NAME = 'recipe_collections_append_recipe_rpc';
/** 本冊の直前に main に入っていた migration の番号 (本冊の番号はこれより大きい) */
export const PRECEDING_MIGRATION_VERSION = '20261101110000';
/** 関数の引数の型 (どちらも uuid。並びは RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ARGS と同じ) */
export const APPEND_RECIPE_RPC_ARG_TYPES = ['uuid', 'uuid'] as const;
/** カタログ (regprocedure) での関数の署名 (schema を除いた形) */
export const APPEND_RECIPE_RPC_SIGNATURE = `${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC}(${APPEND_RECIPE_RPC_ARG_TYPES.join(',')})`;
/** migration・戻し口の文で使う、schema つきで引数の型まで書いた関数の名前 */
export const APPEND_RECIPE_RPC_QUALIFIED = `public.${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC}(${APPEND_RECIPE_RPC_ARG_TYPES.join(', ')})`;
/** CREATE FUNCTION の引数の並び (名前 型) */
export const APPEND_RECIPE_RPC_PARAMS = RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ARGS.map(
  (name, i) => `${name} ${APPEND_RECIPE_RPC_ARG_TYPES[i]}`,
).join(', ');
/** EXECUTE を外す文 (逐語) */
export const APPEND_RECIPE_RPC_REVOKE_STATEMENT = `REVOKE ALL ON FUNCTION ${APPEND_RECIPE_RPC_QUALIFIED} FROM PUBLIC, anon, authenticated, service_role;`;
/** EXECUTE を付ける文 (逐語。authenticated だけ) */
export const APPEND_RECIPE_RPC_GRANT_STATEMENT = `GRANT EXECUTE ON FUNCTION ${APPEND_RECIPE_RPC_QUALIFIED} TO authenticated;`;
/** 戻し口の DROP FUNCTION の文 (逐語) */
export const APPEND_RECIPE_RPC_DROP_STATEMENT = `DROP FUNCTION IF EXISTS ${APPEND_RECIPE_RPC_QUALIFIED};`;
