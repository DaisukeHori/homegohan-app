-- #1023: promote_child_to_user を p_email 受けに変更（email→user_id を関数内で解決）
-- 呼び出し側 route は既に { p_member_id, p_email } を送っているため route は不変。
-- 認可チェック(NOT_FAMILY_ADULT/ALREADY_PROMOTED)を email 解決より先に行い、ユーザー列挙を防ぐ。
DROP FUNCTION IF EXISTS public.promote_child_to_user(UUID, UUID);

CREATE OR REPLACE FUNCTION public.promote_child_to_user(p_member_id UUID, p_email TEXT)
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role family_role_enum;
  v_member family_members;
  v_user_id UUID;
BEGIN
  -- 1) 認可を先に（元関数の順序を維持）
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;

  -- 2) 認可後に email → 既存 auth ユーザーを解決
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = v_user_id AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members SET user_id = v_user_id, child_profile = NULL, role = 'adult' WHERE id = p_member_id
    RETURNING * INTO v_member;
  UPDATE user_profiles SET family_id = v_member.family_id WHERE id = v_user_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promoted', auth.uid(), v_user_id,
          jsonb_build_object('member_id', p_member_id, 'email', lower(p_email)));

  RETURN v_member;
END $$;

REVOKE EXECUTE ON FUNCTION public.promote_child_to_user(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_child_to_user(UUID, TEXT) TO authenticated;
