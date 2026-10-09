-- rollback: 20261008200500_hide_moderated_content.sql
-- meals / recipes の「隠す」仕組み (#1101) を、この migration の直前の状態へ戻す。
-- ⚠️ 戻すと hidden_at / hidden_by / hidden_reason の列ごと「隠した状態」が消える。運営が隠していた食事・レシピは、すべて元どおり
--    他のユーザー (家族・ほかのログインユーザー・未ログイン) に見えるようになる。緊急時の切り戻し専用。
--    戻す前に、隠している行を控えておくこと (読み取り専用):
--      SELECT 'meals' AS kind, id, user_id, hidden_at, hidden_by, hidden_reason FROM public.meals WHERE hidden_at IS NOT NULL
--      UNION ALL
--      SELECT 'recipes', id, user_id, hidden_at, hidden_by, hidden_reason FROM public.recipes WHERE hidden_at IS NOT NULL;
--
-- 内容 (流す順番は、依存の少ない順):
--   1. SELECT ポリシーを、この migration の直前の式へ戻す (対象ロールは変えていないので触らない)
--        meals_select_owner_or_family      : can_view_user_meals(user_id)   (TO authenticated は 20261008160000 で付いたもの)
--        "Users can view public recipes"   : (user_id IS NULL) OR (is_public = true) OR (auth.uid() = user_id)
--   2. 守りのトリガー 2 本と関数を消す
--   3. 部分索引 4 本を消す
--   4. 列 3 本 (+ hidden_by の外部キー) を meals / recipes から消す。列の COMMENT は列と一緒に消える
-- 実行権限 (ACL)・RLS の有効状態・ほかのポリシー・ほかのトリガーには触れない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SET LOCAL lock_timeout = '10s';

-- 1. ポリシーを元の式へ
ALTER POLICY meals_select_owner_or_family ON public.meals
  USING (public.can_view_user_meals(user_id));

ALTER POLICY "Users can view public recipes" ON public.recipes
  USING (user_id IS NULL OR is_public = true OR auth.uid() = user_id);

-- 2. 守りのトリガーと関数
DROP TRIGGER IF EXISTS trg_meals_guard_hidden_columns ON public.meals;
DROP TRIGGER IF EXISTS trg_recipes_guard_hidden_columns ON public.recipes;
DROP FUNCTION IF EXISTS public.guard_hidden_content_columns();

-- 3. 部分索引 (列を消すと一緒に消えるが、意図が分かるよう先に消す)
DROP INDEX IF EXISTS public.idx_meals_hidden_at;
DROP INDEX IF EXISTS public.idx_meals_hidden_by;
DROP INDEX IF EXISTS public.idx_recipes_hidden_at;
DROP INDEX IF EXISTS public.idx_recipes_hidden_by;

-- 4. 列 (hidden_by の外部キー meals_hidden_by_fkey / recipes_hidden_by_fkey は列と一緒に消える)
ALTER TABLE public.meals
  DROP COLUMN IF EXISTS hidden_reason,
  DROP COLUMN IF EXISTS hidden_by,
  DROP COLUMN IF EXISTS hidden_at;

ALTER TABLE public.recipes
  DROP COLUMN IF EXISTS hidden_reason,
  DROP COLUMN IF EXISTS hidden_by,
  DROP COLUMN IF EXISTS hidden_at;
