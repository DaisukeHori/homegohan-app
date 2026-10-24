-- migration: 20261024150000_recipe_author_display_names.sql
-- 戻し方: supabase/rollbacks/20261024150000_recipe_author_display_names.down.sql
-- #1917 の続き (docs/design/cross/21-recipe-author-display-name.md): 公開レシピの一覧・詳細・コメントの作者名を、本人以外にも表示名で出す。
--
-- 背景:
--   user_profiles の SELECT の RLS は "Users can view own profile" (本人の行だけ)。レシピの API (src/lib/recipes/viewer-lookups.ts) は
--   RLS の効くクライアントで作者の user_profiles.nickname を引くので、他人の作者名はいつも既定の呼称 '匿名' になっていた。
--   Next.js の API では service_role を使わない (docs/design/cross/02-rls-patterns.md §3.3)。RLS のポリシーを足すと行の全列が読めてしまう。
--
-- 変更:
--   1. 列 user_profiles.show_recipe_author_name boolean NOT NULL DEFAULT true: 本人が「公開したレシピとコメントに作者名を出す」を選ぶ。
--      特権列ではない (本人が PUT /api/profile で書く)。既存の 65 行には既定値 true が入る。
--   2. 索引 idx_recipe_comments_user_id (recipe_comments.user_id): 下の関数のコメントの EXISTS 用。recipes.user_id は idx_recipes_user_id が既にある。
--   3. 関数 public.recipe_author_display_names(p_user_ids uuid[]) RETURNS TABLE (author_id uuid, display_name text):
--      渡された id のうち、(a) 呼び出した本人 (auth.uid()) か、(b) 公開の作者 (is_public かつ hidden_at IS NULL のレシピの user_id、
--      またはそのレシピへのコメントの user_id) で、名前を出す設定・作者名の表示を書いた版 (以後の版) のプライバシーポリシーに同意済み・
--      凍結中でない・生年月日があり 18 歳以上 の人だけ、
--      (id, normalize_profile_name(nickname)) を返す。名前が無い人 (NULL) は返さない。返らなかった人は route が '匿名' にする。
--      読むのは user_profiles の判定に要る列だけで、返すのは id と表示名だけ。RLS のポリシーは足さない・変えない。
--      同意済みの判定: privacy_version_accepted (accept_legal_documents だけが書く同意の版) が NULL でなく、
--      作者名の表示を書く前の版の一覧 c_privacy_versions_without_author_name に無いこと。DB はどの版が「いま有効」かを知らない
--      (20261008200700) ので、増えない過去の版の一覧を持つ。一覧は旧版の控え docs/legal/archive/ と突き合わせる
--      (tests/recipe-author-display-names-migration-contract.test.ts の C-10)。プライバシーポリシー第8条 1 項・4 項 (第三者提供) と両立させるための条件。
--      凍結中の判定は src/lib/auth/frozen.ts の isAccountFrozen と同じ (frozen_at があり、unban_at が無いか今より未来)。
--      年齢は public.age_years_jst (JST の暦日。20261017030000) で、境は @homegohan/shared の ADULT_AGE_YEARS と同じ 18。
--
-- 権限の定型 (#1039/#1020): 新しい関数には既定で anon / authenticated / service_role と PUBLIC に EXECUTE が付くので、
--   引数の型まで含めた完全形で REVOKE し、anon と authenticated にだけ GRANT する (未ログインの一覧・詳細も名前を出す。
--   service_role には付けない: 表を直接読めるので呼ぶ所が無い)。anon の許可一覧 (tests/integration/security/anon-definer-execute.test.ts) に載せる。
--   関数は SET search_path = ''、参照は完全修飾。normalize_profile_name と age_years_jst は所有者 postgres の権限で本文から呼ぶ。
-- 既存データへの影響: 列の既定値が入るだけ。既存の行の値は書き換えない。
-- ロック: ADD COLUMN は user_profiles に ACCESS EXCLUSIVE ロックを短く取る (既定値は PG 11 以降の fast default で行を書き換えない)。
--   lock_timeout を 10 秒にし、待ちが長ければ失敗させる (再実行で直る)。
-- 冪等: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION / REVOKE / GRANT。2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/recipe-author-display-names.test.ts (実 DB)
--       tests/recipe-author-display-names-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. 本人の選択: 公開したレシピとコメントに作者名を出す
-- ----------------------------------------------------------------
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS show_recipe_author_name boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_profiles.show_recipe_author_name IS
  'cross/21: 公開したレシピとコメントに、ニックネームを作者名として他の人に表示するか (既定 true)。false なら他の人には ''匿名''。本人には自分の名前が出る。本人が PUT /api/profile で書く (特権列ではない)。読むのは recipe_author_display_names だけ';

-- ----------------------------------------------------------------
-- 2. コメントの作者の EXISTS 用の索引
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_recipe_comments_user_id
  ON public.recipe_comments (user_id);

-- ----------------------------------------------------------------
-- 3. 公開の作者の表示名
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recipe_author_display_names(p_user_ids uuid[])
RETURNS TABLE (author_id uuid, display_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- 名前を出す作者の年齢の下限 (歳)。@homegohan/shared の ADULT_AGE_YEARS (packages/shared/src/parental-consent.ts) と同じ値。
  -- 18 歳未満の本人のアカウント (保護者の同意の経路) の名前は公開の場に出さない (cross/21 §6.1 (4))
  c_adult_age_years CONSTANT pg_catalog.int4 := 18;
  -- 作者名の表示を書く前のプライバシーポリシーの版 (packages/shared/src/legal-versions.ts の LEGAL_DOCUMENTS.privacy_policy.version の過去の値)。
  -- ここにある版にだけ同意した人と、同意の記録が無い人の名前は、他の人に返さない (第8条 1 項・4 項。cross/21 §6.4)。
  -- 過去の版は増えないので、作者名の表示を書いた版より後の版は足さない。旧版の控え (docs/legal/archive/) と
  -- いまの文面との突き合わせは C-10 が行う。オーナーの選択 (cross/21 §21 Q-1) が (b) なら 'v2026.4' も足す
  c_privacy_versions_without_author_name CONSTANT pg_catalog.text[] := ARRAY['v2025.1', 'v2026.1', 'v2026.2', 'v2026.3']::pg_catalog.text[];
  -- 呼び出した本人。未ログイン (anon) は NULL
  v_viewer pg_catalog.uuid := auth.uid();
BEGIN
  RETURN QUERY
  WITH ids AS (
    SELECT DISTINCT t.u AS id
      FROM pg_catalog.unnest(COALESCE(p_user_ids, '{}'::pg_catalog.uuid[])) AS t(u)
     WHERE t.u IS NOT NULL
  )
  SELECT p.id, public.normalize_profile_name(p.nickname)
    FROM ids
    JOIN public.user_profiles AS p ON p.id = ids.id
   WHERE public.normalize_profile_name(p.nickname) IS NOT NULL
     AND (
       -- (a) 本人には自分の名前をいつも返す (非公開のレシピ・名前を出さない設定でも)
       p.id = v_viewer
       OR (
         -- (b) 公開の作者で、出す設定・作者名の表示を書いた版 (以後の版) に同意済み・凍結中でない・18 歳以上
         p.show_recipe_author_name
         AND p.privacy_version_accepted IS NOT NULL
         AND p.privacy_version_accepted::pg_catalog.text <> ALL (c_privacy_versions_without_author_name)
         AND (p.frozen_at IS NULL OR (p.unban_at IS NOT NULL AND p.unban_at <= pg_catalog.now()))
         AND p.birth_date IS NOT NULL
         AND public.age_years_jst(p.birth_date) >= c_adult_age_years
         AND (
           EXISTS (
             SELECT 1 FROM public.recipes AS r
              WHERE r.user_id = p.id AND r.is_public = true AND r.hidden_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM public.recipe_comments AS c
               JOIN public.recipes AS r ON r.id = c.recipe_id
              WHERE c.user_id = p.id AND r.is_public = true AND r.hidden_at IS NULL
           )
         )
       )
     );
END
$function$;

REVOKE ALL ON FUNCTION public.recipe_author_display_names(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recipe_author_display_names(uuid[]) TO anon, authenticated;

COMMENT ON FUNCTION public.recipe_author_display_names(uuid[]) IS
  'cross/21: 公開レシピの作者・コメントの書き手の表示名。渡した id のうち、本人か、公開の作者 (出す設定・作者名の表示を書いた版のプライバシーポリシーに同意済み・凍結中でない・18 歳以上) だけを (author_id, display_name) で返す。名前の無い人は返さない。レシピの API (src/lib/recipes/viewer-lookups.ts) が RLS のクライアントで呼ぶ。anon / authenticated';
