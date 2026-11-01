/**
 * レシピのコレクション (recipe_collections) の一意の索引と、作るときの ON CONFLICT の対象 (#2178 Y3-b)。
 *
 * recipe_collections には、利用者ごとに同じ名前のコレクションを 1 件だけにする一意の索引 (user_id, name) がある
 * (supabase/migrations の *_recipe_collections_user_name_unique.sql)。コレクションを作る所 (AI 相談のアクション
 * add_recipe_to_collection。src/lib/ai/consultation-action-executor.ts) は、作るときに同じ名前の行が既にあれば
 * その行を使う (PostgREST の upsert の onConflict にこの列を渡す)。
 * 索引の列とこの列は tests/recipe-collections-user-name-unique-migration-contract.test.ts が突き合わせる。
 */

/** 一意の索引の名前 (migration と戻し口が作る・消す名前と同じ) */
export const RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX = 'recipe_collections_user_id_name_key';

/** 一意の索引の列 (並びは索引の定義と同じ) */
export const RECIPE_COLLECTIONS_USER_NAME_UNIQUE_COLUMNS = ['user_id', 'name'] as const;

/** PostgREST の upsert の onConflict に渡す文字列 (一意の索引の列をカンマでつないだもの) */
export const RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET = RECIPE_COLLECTIONS_USER_NAME_UNIQUE_COLUMNS.join(',');
