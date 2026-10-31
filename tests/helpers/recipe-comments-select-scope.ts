// tests/helpers/recipe-comments-select-scope.ts
/**
 * cross/25 (#2166 X1): recipe_comments の SELECT の範囲を絞る migration の正典の値。
 * tests/recipe-comments-select-scope-migration-contract.test.ts (静的) と
 * tests/integration/rls/recipe-comments-select-scope.test.ts (実 DB) が同じ値を見る (何も import しない)。
 * 値は docs/design/cross/25-recipe-comments-select-scope.md §7.1・§7.2・§13 と同じ。実装の枝では設計書を編集しない。
 * 値を変えたときは、設計書の訂正を design-doc.patch に出し、報告の deviations に書く (訂正はオーケストレーターが当てる)。
 */

/** 対象の表 */
export const RECIPE_COMMENTS_TABLE = 'recipe_comments';
/** migration のファイル名の、番号の後ろの名前 (`<番号>_recipe_comments_select_scope.sql`) */
export const RECIPE_COMMENTS_SELECT_SCOPE_MIGRATION_NAME = 'recipe_comments_select_scope';
/** 本書の直前の SELECT のポリシー (本番のベースライン。USING (true)) */
export const RECIPE_COMMENTS_LEGACY_SELECT_POLICY = 'Anyone can view comments';
/** 本書が作る SELECT のポリシー */
export const RECIPE_COMMENTS_SELECT_POLICY = 'recipe_comments_select_own_or_visible_recipe';
/** 本書が作る SELECT のポリシーの USING の式 (migration に書く形) */
export const RECIPE_COMMENTS_SELECT_USING =
  '((user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM public.recipes r WHERE r.id = recipe_comments.recipe_id)))';
/** migration の CREATE POLICY の文 (1 行・逐語) */
export const RECIPE_COMMENTS_SELECT_POLICY_STATEMENT =
  `CREATE POLICY ${RECIPE_COMMENTS_SELECT_POLICY} ON public.${RECIPE_COMMENTS_TABLE} FOR SELECT TO authenticated USING ${RECIPE_COMMENTS_SELECT_USING};`;
/** 戻し口の CREATE POLICY の文 (1 行・逐語。ベースライン :9602 の定義を引用符を外した形で) */
export const RECIPE_COMMENTS_LEGACY_SELECT_POLICY_STATEMENT =
  `CREATE POLICY "${RECIPE_COMMENTS_LEGACY_SELECT_POLICY}" ON public.${RECIPE_COMMENTS_TABLE} FOR SELECT TO authenticated USING (true);`;
/**
 * pg_policies.qual に出る形 (PostgreSQL が式を整形し直したもの: public. が落ち、括弧と改行が足される)。
 * 実測の qual を foldSql に通した形と比べる (この定数は foldSql を通した後の形で書いてある)。
 * 実装で実測と違えば (意味の同じ整形の差)、実測に合わせてこの定数だけを直す。設計書 §7.3 の訂正は design-doc.patch に出し、
 * deviations で報告する (実装の枝では設計書を編集しない)
 */
export const RECIPE_COMMENTS_SELECT_QUAL =
  '((user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM recipes r WHERE (r.id = recipe_comments.recipe_id))))';
/** 本書が触らない recipe_comments のほかのポリシー (名前 → 種類。pg_policies.cmd の値) */
export const RECIPE_COMMENTS_OTHER_POLICIES: ReadonlyArray<readonly [name: string, command: 'INSERT' | 'UPDATE' | 'DELETE']> = [
  ['Users can create comments', 'INSERT'],
  ['Users can delete own comments', 'DELETE'],
  ['Users can update own comments', 'UPDATE'],
];
/** 本書の判定の土台: recipes の SELECT のポリシーと、その最新の定義を持つ migration */
export const RECIPES_PUBLIC_SELECT_POLICY = 'Users can view public recipes';
export const RECIPES_PUBLIC_SELECT_MIGRATION = '20261009000500_hide_moderated_content.sql';
/** recipes の SELECT のポリシーの USING (20261009000500 の ALTER POLICY。空白を畳んだ形) */
export const RECIPES_PUBLIC_SELECT_USING =
  '((hidden_at IS NULL OR auth.uid() = user_id) AND (user_id IS NULL OR is_public = true OR auth.uid() = user_id))';
/** 本番のベースライン (ポリシーを最初に作ったファイル) と、その中の SELECT のポリシーの文 */
export const BASELINE_MIGRATION = '20251126124224_create_meal_planner_tables.sql';
/** migration の文面の規律: ロックの待ちの上限 (20261023100000 以後の migration と同じ) */
export const MIGRATION_LOCK_TIMEOUT_STATEMENT = "SET LOCAL lock_timeout = '10s';";
/** PostgreSQL の権限不足 (RLS の WITH CHECK・SELECT のポリシーに通らない RETURNING) */
export const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';

/** 空白 (改行を含む) を 1 つに畳み、括弧の内側の空白を除く (式の比較用) */
export function foldSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
}

/** 二重引用符の識別子を外す (ベースラインの `"public"."recipe_comments"`・`"authenticated"` と、本書の書き方を比べるため) */
export function unquoteIdentifiers(sql: string): string {
  return sql.replace(/"/g, '');
}

/** RegExp に埋めるときに特殊文字を逃がす (CodeQL js/incomplete-sanitization の形) */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
