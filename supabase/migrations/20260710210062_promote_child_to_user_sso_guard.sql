-- #1062: promote_child_to_user の email lookup を堅牢化 (Suggestion-1)
-- 20260511000135 で追加された p_email → auth.users 解決の SELECT に、SSO 併用時の
-- 非決定性回避として is_sso_user = false / deleted_at IS NULL の条件を追加する。
-- 現状はアプリが hard-delete + 非 SSO 運用のため実害はないが、将来の保険として対応する。
-- 関数シグネチャ(p_member_id UUID, p_email TEXT)・認可順序(認可を email 解決より先に行う)は不変。
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
  -- #1062: SSO ユーザー/削除済みユーザーは対象外とし、email 重複時の非決定的な
  -- マッチ (LIMIT 1 がどの行を返すか不定) を避ける。
  SELECT id INTO v_user_id FROM auth.users
    WHERE lower(email) = lower(p_email)
      AND is_sso_user = false
      AND deleted_at IS NULL
    LIMIT 1;
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
