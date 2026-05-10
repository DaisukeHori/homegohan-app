-- migration: 20260511000125_operator_force_rpcs.sql
-- (設計書 05-operator-emergency-ui.md §3-4)
-- 運営管理者向け強制操作 RPC (SECURITY DEFINER, super_admin のみ実行可)
-- Critical 7-B: operator_force_dissolve_org / operator_force_dissolve_family
--               operator_force_owner_transfer / operator_force_representative_transfer

-- ---------------------------------------------------------------------------
-- 組織 owner 強制譲渡
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_force_owner_transfer(
  p_organization_id UUID,
  p_new_owner_id UUID,
  p_reason TEXT
) RETURNS organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org organizations;
  v_old_owner_id UUID;
  v_caller_roles TEXT[];
BEGIN
  -- 認可: super_admin のみ
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- 整合性: new_owner が同 org メンバであること
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles WHERE id = p_new_owner_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  SELECT owner_id INTO v_old_owner_id FROM organizations WHERE id = p_organization_id;

  -- role swap
  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = p_new_owner_id;
  UPDATE organizations SET owner_id = p_new_owner_id WHERE id = p_organization_id RETURNING * INTO v_org;

  -- 監査ログ (actor_id = NULL で system, metadata.operator_id = auth.uid())
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'operator_force_owner_transfer',
          NULL, p_new_owner_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_owner_id', v_old_owner_id,
            'reason', p_reason
          ));

  RETURN v_org;
END $$;

REVOKE EXECUTE ON FUNCTION public.operator_force_owner_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_force_owner_transfer TO authenticated;

-- ---------------------------------------------------------------------------
-- 組織強制解散
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_force_dissolve_org(
  p_organization_id UUID,
  p_reason TEXT
) RETURNS organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org organizations;
  v_caller_roles TEXT[];
BEGIN
  -- 認可: super_admin のみ
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- 全メンバを組織から離脱
  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL
    WHERE organization_id = p_organization_id;

  -- 組織を論理削除 (status='dissolved')
  UPDATE organizations
    SET status = 'dissolved'
    WHERE id = p_organization_id
    RETURNING * INTO v_org;

  -- 監査ログ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('organization', p_organization_id, 'operator_force_dissolve', NULL,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'reason', p_reason
          ));

  RETURN v_org;
END $$;

REVOKE EXECUTE ON FUNCTION public.operator_force_dissolve_org FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_force_dissolve_org TO authenticated;

-- ---------------------------------------------------------------------------
-- 家族代表者強制譲渡
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_force_representative_transfer(
  p_family_id UUID,
  p_new_rep_id UUID,
  p_reason TEXT
) RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam family_groups;
  v_old_rep_id UUID;
  v_caller_roles TEXT[];
BEGIN
  -- 認可: super_admin のみ
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- 整合性: new_rep が同 family の adult/representative であること
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE family_id = p_family_id AND user_id = p_new_rep_id
      AND status = 'active' AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id;

  -- role swap
  UPDATE family_members SET role = 'adult'
    WHERE family_id = p_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = p_family_id AND user_id = p_new_rep_id AND status = 'active';
  UPDATE family_groups SET representative_id = p_new_rep_id
    WHERE id = p_family_id RETURNING * INTO v_fam;

  -- 監査ログ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_representative_transfer',
          NULL, p_new_rep_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_rep_id', v_old_rep_id,
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;

REVOKE EXECUTE ON FUNCTION public.operator_force_representative_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_force_representative_transfer TO authenticated;

-- ---------------------------------------------------------------------------
-- 家族強制解散
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_force_dissolve_family(
  p_family_id UUID,
  p_reason TEXT
) RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam family_groups;
  v_caller_roles TEXT[];
BEGIN
  -- 認可: super_admin のみ
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- 全メンバを離脱状態に
  UPDATE family_members SET status = 'left' WHERE family_id = p_family_id AND status = 'active';
  UPDATE user_profiles SET family_id = NULL WHERE family_id = p_family_id;

  -- 家族グループを論理削除 (status='dissolved')
  UPDATE family_groups
    SET status = 'dissolved', dissolved_at = NOW()
    WHERE id = p_family_id
    RETURNING * INTO v_fam;

  -- 監査ログ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_dissolve', NULL,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;

REVOKE EXECUTE ON FUNCTION public.operator_force_dissolve_family FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_force_dissolve_family TO authenticated;
