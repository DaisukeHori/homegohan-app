-- rollback: 20261015110000_paste_meal_reject_missing_source.sql
-- public.paste_meal_to_family(uuid, uuid[]) を、20261015100000_paste_meal_reject_sandbox.sql の定義
-- (持ち主の確認が IF v_source.user_id <> auth.uid() の形。MEAL_HIDDEN と MEAL_SANDBOX は断る) に戻す (#1634)。
-- ⛔ 20261015100000 より前の定義 (MEAL_SANDBOX や MEAL_HIDDEN の確認が無い形) には戻さない (#1627・#1101 の巻き戻しになるため)。
-- 表のデータには触れない。関数は消さない (POST /api/meals/paste が呼ぶため)。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、存在しない source_meal_id を渡したときにまた断らなくなり、家族の側の行は 0 件のまま監査の行 (paste_executed) が書かれ、
--     新しい paste_group_id が返る (POST /api/meals/paste は 200) (#1634 の前の状態)。
--   - POST /api/meals/paste の例外の語の判定 (#1634) は DB の定義によらないので、API を先に戻す必要は無い。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE と REVOKE / GRANT)。

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
