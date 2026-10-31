-- migration: 20261101100000_recipe_comments_select_scope.sql
-- 戻し方: supabase/rollbacks/20261101100000_recipe_comments_select_scope.down.sql
-- #2166 X1 (docs/design/cross/25-recipe-comments-select-scope.md): 公開レシピのコメントの読み取りの範囲を、
-- 「そのコメントのレシピを読める人」と「そのコメントを書いた本人」に絞る。
--
-- 背景:
--   recipe_comments の SELECT のポリシーは本番のベースライン (20251126124224_create_meal_planner_tables.sql の
--   "Anyone can view comments" FOR SELECT TO authenticated USING (true)) のままで、ログインした利用者は PostgREST を直接呼ぶと、
--   非公開に戻したレシピや運営が隠したレシピへのコメントの本文・user_id・recipe_id を読めた。レシピの API
--   (GET /api/recipes/[id]/comments・GET /api/recipes/[id] の埋め込み) は RLS の上で動くので、コメントの API も見えないレシピの
--   コメントをそのまま返していた。プライバシーポリシー第9条 (公開の状態のレシピへのコメントには、ログインしているユーザーに対して、
--   ニックネームが作者名として表示されます) より広い。recipe_comments のポリシーを変えた migration はほかに無い
--   (20261101090000 は索引 idx_recipe_comments_user_id を足しただけ)。
--
-- 変更 (表の行・列・権限 (GRANT)・ほかのポリシーには触れない):
--   1. "Anyone can view comments" を消し、recipe_comments_select_own_or_visible_recipe (FOR SELECT TO authenticated) を作る。
--        USING ((user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM public.recipes r WHERE r.id = recipe_comments.recipe_id)))
--      - EXISTS の中の recipes は、呼んだ人の権限で読む (recipes の RLS "Users can view public recipes" が公開・本人・隠しを判定する:
--        (hidden_at IS NULL OR auth.uid() = user_id) AND (user_id IS NULL OR is_public = true OR auth.uid() = user_id)。20261009000500。
--        作者には "Users can manage own recipes" (ALL) も当たる)。レシピを読める人 = ログインした誰でも (作者のいる公開で隠されて
--        いないレシピと、作者のいない隠されていないレシピ。作者のいないレシピは is_public を見ない)・作者本人 (非公開・隠した自分のレシピ)。
--      - user_id = auth.uid() は、コメントを書いた本人の行をレシピの見え方に関わらず残す (非公開に戻された・隠されたレシピへの
--        自分のコメントを、本人が読む・書き出す (GET /api/account/export)・消す・直すため。INSERT ... RETURNING は新しい行に
--        SELECT のポリシーを当てるので、この句が無いと見えないレシピへの POST /api/recipes/[id]/comments が 42501 → 500 になる)。
--      - TO authenticated は変えない (未ログインは今までどおり 0 行。第9条の「ログインしているユーザーに対して」)。
--   影響を受けない読み手: 作者名の関数 recipe_author_display_names (SECURITY DEFINER・所有者 postgres。20261101090000) と
--   service_role (運営の道具・テストの準備と後片付け) は RLS を通らない (recipe_comments は FORCE ROW LEVEL SECURITY ではない)。
--   外部キー recipe_comments_recipe_id_fkey・recipe_comments_user_id_fkey (ON DELETE CASCADE) の動きも RLS を通らない。
--   INSERT ("Users can create comments")・UPDATE ("Users can update own comments")・DELETE ("Users can delete own comments") の
--   ポリシーと、表の権限 (anon / authenticated / service_role) は変えない。
-- 既存データへの影響: なし (ポリシーだけの変更。行は消さない・変えない。本番の読み取り 2026-11-01: recipe_comments 0 行・recipes 0 行)。
-- 冪等: DROP POLICY IF EXISTS のあとに CREATE POLICY。2 回続けて適用してもエラーにならない。
-- ロック: DROP / CREATE POLICY は recipe_comments に ACCESS EXCLUSIVE を取る。表は小さく、一瞬で終わる。lock_timeout を 10 秒にし、
--   待ちが長ければ失敗させる (再実行で直る)。
-- 確認: tests/integration/rls/recipe-comments-select-scope.test.ts (実 DB)
--       tests/recipe-comments-select-scope-migration-contract.test.ts (静的)
--       tests/integration/security/recipes-api-logged-in.test.ts の A-1・A-2 (API)

SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS "Anyone can view comments" ON public.recipe_comments;
DROP POLICY IF EXISTS recipe_comments_select_own_or_visible_recipe ON public.recipe_comments;
CREATE POLICY recipe_comments_select_own_or_visible_recipe ON public.recipe_comments FOR SELECT TO authenticated USING ((user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM public.recipes r WHERE r.id = recipe_comments.recipe_id)));
