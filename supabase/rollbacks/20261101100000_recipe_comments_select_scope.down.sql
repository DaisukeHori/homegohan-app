-- rollback: 20261101100000_recipe_comments_select_scope.sql
-- #2166 X1 (docs/design/cross/25-recipe-comments-select-scope.md) で絞った recipe_comments の SELECT のポリシーを、この migration の
-- 直前の形 (本番のベースライン 20251126124224_create_meal_planner_tables.sql の "Anyone can view comments" FOR SELECT TO authenticated
-- USING (true)) に戻す。
-- 影響: 戻すと、ログインした利用者が PostgREST から非公開・隠したレシピへの他人のコメントを再び読める (第9条より広い状態に戻る)。
--   アプリ (レシピの API は RLS の上で読み、作者名の関数は DEFINER) は、戻しても戻さなくても動く。先にコードを戻す必要は無い。
-- 表の権限 (GRANT) には触れない (本冊の migration も触れていない。20261022190000 より後の戻し口の規律: TRUNCATE / ALL を付け直さない)。
-- 冪等: 作り直す前に DROP POLICY IF EXISTS する。2 回流しても同じ結果になる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS recipe_comments_select_own_or_visible_recipe ON public.recipe_comments;
DROP POLICY IF EXISTS "Anyone can view comments" ON public.recipe_comments;
CREATE POLICY "Anyone can view comments" ON public.recipe_comments FOR SELECT TO authenticated USING (true);
