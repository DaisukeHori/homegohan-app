-- migration: 20261015110000_paste_meal_reject_missing_source.sql
-- 家族への貼り付け (paste_meal_to_family) で、元の meals の行が存在しないときに断る (#1634)
--
-- 背景:
--   paste_meal_to_family は SELECT * INTO v_source FROM meals WHERE id = p_source_meal_id のあと、
--   IF v_source.user_id <> auth.uid() で持ち主を確かめていた。元の行が無いと v_source の列はすべて NULL になり、
--   NULL <> auth.uid() も NULL (真でない) なので NOT_MEAL_OWNER を投げず、そのまま先へ進んでいた。
--   その結果、家族の側には 1 行も写らない (INSERT ... SELECT ... FROM meals WHERE id = p_source_meal_id が 0 行) のに、
--   監査の行 (membership_audit の paste_executed) が書かれ、新しい paste_group_id が返っていた
--   (POST /api/meals/paste は 200 で inserted_count = 指定した人数を返す)。
--
-- 変更:
--   public.paste_meal_to_family(uuid, uuid[]) を CREATE OR REPLACE する。定義は 20261015100000_paste_meal_reject_sandbox.sql の
--   定義 (MEAL_HIDDEN と MEAL_SANDBOX の確認まで入ったもの) を土台にし、持ち主の確認だけを
--     IF NOT FOUND OR v_source.user_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'NOT_MEAL_OWNER'
--   に変える (元の行が無いときも、持ち主の列が NULL のときも断る)。
--   元の行が無いときと他人の行のときは、同じ NOT_MEAL_OWNER で断る (持ち主でない人に、その id の行が在るかどうかを教えない)。
--   確認の順番は 持ち主 (NOT_MEAL_OWNER) → 隠した食事 (MEAL_HIDDEN) → お試しの記録 (MEAL_SANDBOX) のまま。
--   断るのは家族の側に行を作る前・元の行の paste_group_id を書く前・監査の行を書く前なので、断ったときは何も書かない。
--   ⛔ MEAL_HIDDEN (#1101) と MEAL_SANDBOX (#1627) の確認を落とさない。
--   返す型 (uuid)・引数・SECURITY DEFINER・search_path の固定・持ち主 (postgres) は変えない。
--
-- 権限:
--   CREATE OR REPLACE は既存の EXECUTE の権限を保つが、何度流しても同じになるよう、本番の権限
--   (supabase/baseline/prod_function_acl.sql: PUBLIC / anon から外し、authenticated と service_role に EXECUTE) を流し直す。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE と REVOKE / GRANT)。表のデータには触れない。
-- 戻し方: supabase/rollbacks/20261015110000_paste_meal_reject_missing_source.down.sql
--   (20261015100000_paste_meal_reject_sandbox.sql の定義 = 元の行が無いときに断らない形に戻す)
-- 確かめるテスト:
--   tests/integration/rls/paste-meal-errors.test.ts (実 DB: 存在しない元の行は NOT_MEAL_OWNER で断られ、監査の行も家族の側の行もできない。
--     POST /api/meals/paste の 400 USER_NOT_IN_FAMILY / 403 NOT_IN_FAMILY)
--   tests/paste-meal-missing-source-migration-contract.test.ts (ファイルどうしの突き合わせ。DB 無し)
--   tests/meals-paste-error-codes.test.ts (POST /api/meals/paste が DB の例外の語を取り違えない)

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
  -- #1634: 元の行が無いとき (NOT FOUND) も断る。v_source の列が NULL だと「NULL <> auth.uid()」は真にならず、確認をすり抜けていた。
  -- 元の行が無いときと他人の行のときは同じ NOT_MEAL_OWNER (持ち主でない人に、その id の行が在るかどうかを教えない)
  IF NOT FOUND OR v_source.user_id IS DISTINCT FROM auth.uid() THEN
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
