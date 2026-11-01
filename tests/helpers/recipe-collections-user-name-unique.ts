/**
 * #2178 Y3-b: recipe_collections の一意の索引 (user_id, name) を足す migration の値。
 * tests/recipe-collections-user-name-unique-migration-contract.test.ts (静的) と
 * tests/integration/rls/recipe-collections-user-name-unique.test.ts (実 DB) が同じ値を見る。
 * 索引の名前と列はアプリのコードと同じ定数 (src/lib/recipes/collections.ts) から作る。
 */
import {
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_COLUMNS,
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX,
} from '@/lib/recipes/collections';

/** 対象の表 */
export const RECIPE_COLLECTIONS_TABLE = 'recipe_collections';
/** migration のファイル名の、番号の後ろの名前 */
export const RECIPE_COLLECTIONS_USER_NAME_UNIQUE_MIGRATION_NAME = 'recipe_collections_user_name_unique';
/** 本冊の直前に main に入っていた migration の番号 (本冊の番号はこれより大きい) */
export const PRECEDING_MIGRATION_VERSION = '20261101100000';
/** migration の文面の規律: ロックの待ちの上限 (20261023100000 以後の migration と同じ) */
export const MIGRATION_LOCK_TIMEOUT_STATEMENT = "SET LOCAL lock_timeout = '10s';";
/** migration の CREATE UNIQUE INDEX の文 (空白を畳んだ形・逐語) */
export const CREATE_UNIQUE_INDEX_STATEMENT = `CREATE UNIQUE INDEX IF NOT EXISTS ${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX} ON public.${RECIPE_COLLECTIONS_TABLE} (${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_COLUMNS.join(', ')});`;
/** 戻し口の DROP INDEX の文 (逐語) */
export const DROP_UNIQUE_INDEX_STATEMENT = `DROP INDEX IF EXISTS public.${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX};`;
/** PostgreSQL の一意の違反の SQLSTATE */
export const UNIQUE_VIOLATION_SQLSTATE = '23505';

/** SQL の行コメント (-- ...) を取り除く */
export function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

/** SQL を文 (; で終わる) に分け、空白を 1 つに畳む (括弧の内側の空白は残す) */
export function sqlStatementsOf(sql: string): string[] {
  return stripSqlComments(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .map((s) => `${s};`);
}
