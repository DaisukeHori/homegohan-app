-- migration: 20261015100000_paste_meal_reject_sandbox.sql
-- ハンズオンのお試しの記録 (meals.is_sandbox = true) を、家族への貼り付け (paste_meal_to_family) の元にさせない (#1627)
--
-- 背景:
--   paste_meal_to_family は元の行の eaten_at / meal_type / photo_url / memo だけを写して家族のメンバーの行を作り、
--   is_sandbox は写さない (新しい行は列の既定値の is_sandbox = false になる)。
--   そのため、お試しの記録 (#1604 から add-from-photo が meals に is_sandbox = true の行を作り、応答で mealId を返す) を
--   家族に貼ると、家族の側では本物の食事の記録になってしまう (件数・バッジ・健康の分析など、is_sandbox = false で絞る読み手に入る)。
--
-- 変更:
--   public.paste_meal_to_family(uuid, uuid[]) を CREATE OR REPLACE する。定義は 20261009000500_hide_moderated_content.sql の
--   定義 (MEAL_HIDDEN の確認まで入ったもの) を土台にし、元の行が is_sandbox = true なら RAISE EXCEPTION 'MEAL_SANDBOX' で断る確認だけを足す。
--   確認の順番は 持ち主 (NOT_MEAL_OWNER) → 隠した食事 (MEAL_HIDDEN) → お試しの記録 (MEAL_SANDBOX)。
--   持ち主でない人には、お試しの記録かどうかを教えない (NOT_MEAL_OWNER のまま)。
--   断るのは家族の側に行を作る前・元の行の paste_group_id を書く前なので、断ったときは何も書かない。
--   ⛔ MEAL_HIDDEN の確認を落とさない (落とすと #1101 の巻き戻しになり、運営が隠した内容を家族に見せ直せる)。
--   返す型 (uuid)・引数・SECURITY DEFINER・search_path の固定・持ち主 (postgres) は変えない。
--
-- 権限:
--   CREATE OR REPLACE は既存の EXECUTE の権限を保つが、何度流しても同じになるよう、本番の権限
--   (supabase/baseline/prod_function_acl.sql: PUBLIC / anon から外し、authenticated と service_role に EXECUTE) を流し直す。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE と REVOKE / GRANT)。表のデータには触れない。
-- 戻し方: supabase/rollbacks/20261015100000_paste_meal_reject_sandbox.down.sql
--   (20261009000500_hide_moderated_content.sql の定義 = MEAL_HIDDEN の確認だけがある形に戻す)
-- 確かめるテスト:
--   tests/integration/rls/paste-meal-sandbox.test.ts (実 DB: お試しの記録は断られ、家族の側に行ができない。普通の行は貼れる)
--   tests/paste-meal-sandbox-migration-contract.test.ts (ファイルどうしの突き合わせ。DB 無し)
--   tests/meals-paste-sandbox.test.ts (POST /api/meals/paste が 403 MEAL_SANDBOX を返す)

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

  -- #1101: 運営が隠した食事は、貼り付けの元にできない (写した新しい行は隠れていないので、隠した内容を家族に見せ直せてしまう)
  IF v_source.hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'MEAL_HIDDEN' USING ERRCODE = 'P0001';
  END IF;

  -- #1627: ハンズオンのお試しの記録は、貼り付けの元にできない (写した新しい行は is_sandbox = false になり、家族の側で本物の記録になってしまう)
  IF v_source.is_sandbox THEN
    RAISE EXCEPTION 'MEAL_SANDBOX' USING ERRCODE = 'P0001';
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

ALTER FUNCTION public.paste_meal_to_family(uuid, uuid[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) TO service_role;
