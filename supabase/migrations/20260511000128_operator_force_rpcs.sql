-- migration: 20260511000128_operator_force_rpcs.sql
-- operator 緊急操作 RPC 群
-- Round 3 監査 C-4: operator_force_dissolve_org で used_licenses リセット +
--   organizations.status = 'dissolved' / dissolved_at = NOW() を更新

-- operator_force_dissolve_org: 組織を強制解散する (super_admin/operator のみ)
CREATE OR REPLACE FUNCTION public.operator_force_dissolve_org(
  p_organization_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
BEGIN
  -- 呼び出し元が super_admin または operator ロールを持つか確認
  SELECT roles INTO v_caller_roles
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_roles IS NULL
     OR NOT (
       'super_admin' = ANY(v_caller_roles)
       OR 'operator' = ANY(v_caller_roles)
     ) THEN
    RAISE EXCEPTION 'OPERATOR_PERMISSION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 対象 org の存在確認
  SELECT * INTO v_org FROM organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 既に解散済みか確認
  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;

  -- 全メンバを org から解放
  UPDATE user_profiles
    SET organization_id = NULL,
        org_role = NULL,
        is_active_in_org = FALSE,
        joined_org_at = NULL
    WHERE organization_id = p_organization_id;

  -- Round 3 C-4: org_license_pools の used_licenses をリセット
  UPDATE org_license_pools
    SET used_licenses = 0, updated_at = NOW()
    WHERE organization_id = p_organization_id;

  -- organizations.status を dissolved に更新 (000126 で追加したカラム)
  UPDATE organizations
    SET status = 'dissolved',
        dissolved_at = NOW(),
        updated_at = NOW()
    WHERE id = p_organization_id
    RETURNING * INTO v_org;

  -- 監査ログ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES (
    'organization',
    p_organization_id,
    'operator_force_dissolve',
    auth.uid(),
    NULL,
    jsonb_build_object(
      'reason', p_reason,
      'dissolved_at', NOW()
    )
  );

  RETURN v_org;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_force_dissolve_org(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_force_dissolve_org(UUID, TEXT) TO authenticated;
