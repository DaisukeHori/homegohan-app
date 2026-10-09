-- rollback: 20261009000500_hide_moderated_content.sql
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
--   2. paste_meal_to_family を、この migration の直前の定義 (MEAL_HIDDEN の確認が無いもの) へ戻す。
--      列を消す前に戻すこと (plpgsql は実行時に列を解決するので、先に列を消すと、戻すまでの間の貼り付けが hidden_at の参照で失敗する)。
--      CREATE OR REPLACE なので実行権限 (ACL) は変わらない
--   3. 守りのトリガー 3 本 (hidden_* の 2 本と paste_group_id の 1 本) と関数 2 つを消す
--   4. 部分索引 4 本を消す
--   5. 列 3 本 (+ hidden_by の外部キー) を meals / recipes から消す。列の COMMENT は列と一緒に消える
-- 実行権限 (ACL)・RLS の有効状態・ほかのポリシー・ほかのトリガーには触れない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SET LOCAL lock_timeout = '10s';

-- 1. ポリシーを元の式へ
ALTER POLICY meals_select_owner_or_family ON public.meals
  USING (public.can_view_user_meals(user_id));

ALTER POLICY "Users can view public recipes" ON public.recipes
  USING (user_id IS NULL OR is_public = true OR auth.uid() = user_id);

-- 2. 家族への貼り付けの関数を、この migration の直前の定義へ (supabase/baseline/prod_schema.sql と同じ)
CREATE OR REPLACE FUNCTION public.paste_meal_to_family(p_source_meal_id uuid, p_target_user_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_source meals;
  v_paste_group_id UUID;
  v_target UUID;
  v_caller_family_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_source FROM meals WHERE id = p_source_meal_id;
  IF v_source.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'NOT_MEAL_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT family_id INTO v_caller_family_id FROM user_profiles WHERE id = auth.uid();
  IF v_caller_family_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  v_paste_group_id := COALESCE(v_source.paste_group_id, gen_random_uuid());

  IF v_source.paste_group_id IS NULL THEN
    UPDATE meals SET paste_group_id = v_paste_group_id WHERE id = p_source_meal_id;
  END IF;

  FOREACH v_target IN ARRAY p_target_user_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM family_members
      WHERE family_id = v_caller_family_id AND user_id = v_target AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO meals (
      user_id, paste_group_id, eaten_at, meal_type, photo_url, memo
    )
    SELECT
      v_target, v_paste_group_id, eaten_at, meal_type, photo_url, memo
    FROM meals WHERE id = p_source_meal_id;
  END LOOP;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', v_caller_family_id, 'paste_executed', auth.uid(),
          jsonb_build_object('source_meal_id', p_source_meal_id,
                             'paste_group_id', v_paste_group_id,
                             'target_count', array_length(p_target_user_ids, 1)));

  RETURN v_paste_group_id;
END $$;

-- 3. 守りのトリガーと関数
DROP TRIGGER IF EXISTS trg_meals_guard_hidden_columns ON public.meals;
DROP TRIGGER IF EXISTS trg_recipes_guard_hidden_columns ON public.recipes;
DROP FUNCTION IF EXISTS public.guard_hidden_content_columns();
DROP TRIGGER IF EXISTS trg_meals_guard_paste_group_id ON public.meals;
DROP FUNCTION IF EXISTS public.guard_meal_paste_group_id();

-- 4. 部分索引 (列を消すと一緒に消えるが、意図が分かるよう先に消す)
DROP INDEX IF EXISTS public.idx_meals_hidden_at;
DROP INDEX IF EXISTS public.idx_meals_hidden_by;
DROP INDEX IF EXISTS public.idx_recipes_hidden_at;
DROP INDEX IF EXISTS public.idx_recipes_hidden_by;

-- 5. 列 (hidden_by の外部キー meals_hidden_by_fkey / recipes_hidden_by_fkey は列と一緒に消える)
ALTER TABLE public.meals
  DROP COLUMN IF EXISTS hidden_reason,
  DROP COLUMN IF EXISTS hidden_by,
  DROP COLUMN IF EXISTS hidden_at;

ALTER TABLE public.recipes
  DROP COLUMN IF EXISTS hidden_reason,
  DROP COLUMN IF EXISTS hidden_by,
  DROP COLUMN IF EXISTS hidden_at;
