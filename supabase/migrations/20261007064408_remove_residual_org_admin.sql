-- migration: 20261007064408_remove_residual_org_admin.sql
-- Issue #1235 (第2段 ⑥): 残っている roles の 'org_admin' を外し、所属を外す RPC でも外すようにする
--
-- 背景:
--   'org_admin' はどの組織で付与されたかを区別しないロールで、#1252 (20261007022126) 以降は
--   組織の管理者判定 (UI・API・RLS) に使っていない。組織の管理者 = 同じ組織に所属し、org_role が owner / admin。
--   ただし脱退・除名などで所属を外しても roles に残り続け、体験ツアーの対象外判定 (ADMIN_ROLES) などに影響していた。
--   設計 v2 の実測 (2026-07-14) では 22 名が 'org_admin' を持ち、うち 20 名は org_role が member / NULL の残りだった。
--
-- 変更 (2026-10-07 のオーナー判断「⑥ だけ実施」。③ 運営のグローバルロールの扱いは現状維持):
--   1. データ: 'org_admin' を持つユーザーのうち、所属組織の owner / admin でないユーザーの roles から外す。
--      所属組織の owner / admin (正当な管理者) の 'org_admin' はそのまま (設計 v2 §5 どおり)。
--   2. RPC: 所属を外す 4 本で、所属と一緒に roles の 'org_admin' も外す (ほかのロールはそのまま)。
--        leave_org                    本人の脱退
--        remove_org_member            owner / admin による除名
--        operator_force_dissolve_org  運営による組織の強制解散 (全メンバーの所属を外す)
--        release_user_membership      アカウント削除時の所属解除
--      4 本とも本文は本番 (= 2026-10-06 のスナップショット、migration と一致) と同じで、
--      所属を外す UPDATE に `roles = array_remove(roles, 'org_admin')` を足しただけ。
--      CREATE OR REPLACE のため、所有者と EXECUTE 権限はそのまま。
--
-- 冪等: データの UPDATE は対象が無ければ 0 行。関数は CREATE OR REPLACE。
-- ロールバック: supabase/rollbacks/20261007064408_remove_residual_org_admin.down.sql (関数のみ。データは戻さない)

-- ---------------------------------------------------------------
-- 1. 残っている 'org_admin' を外す
-- ---------------------------------------------------------------
DO $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.user_profiles
    SET roles = array_remove(roles, 'org_admin')
    WHERE 'org_admin' = ANY(roles)
      AND NOT (organization_id IS NOT NULL AND COALESCE(org_role IN ('owner', 'admin'), false));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '#1235: roles から org_admin を外したユーザー: % 名', v_count;
END $$;

-- ---------------------------------------------------------------
-- 2. 所属を外す RPC で 'org_admin' も外す
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leave_org() RETURNS public.user_profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_user user_profiles; v_org_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_user FROM user_profiles WHERE id = auth.uid();
  IF v_user.organization_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  IF v_user.org_role = 'owner' THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_user.organization_id;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin')  -- #1235: 所属と一緒に外す
    WHERE id = auth.uid()
    RETURNING * INTO v_user;

  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', v_org_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION public.remove_org_member(p_organization_id uuid, p_user_id uuid) RETURNS public.user_profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller_role org_role_enum;
  v_target user_profiles;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target FROM user_profiles WHERE id = p_user_id;
  IF NOT FOUND OR v_target.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'USER_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.org_role = 'owner' THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_OWNER' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.org_role = 'admin' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin')  -- #1235: 所属と一緒に外す
    WHERE id = p_user_id
    RETURNING * INTO v_target;

  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = p_organization_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', p_organization_id, 'member_removed', auth.uid(), p_user_id);

  RETURN v_target;
END $$;

CREATE OR REPLACE FUNCTION public.operator_force_dissolve_org(p_organization_id uuid, p_reason text DEFAULT NULL::text) RETURNS public.organizations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
BEGIN
  SELECT roles INTO v_caller_roles
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_roles IS NULL
     OR NOT (
       'super_admin' = ANY(v_caller_roles)
       OR 'operator' = ANY(v_caller_roles)
     ) THEN
    RAISE EXCEPTION 'OPERATOR_PERMISSION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_org FROM organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL,
        org_role = NULL,
        is_active_in_org = FALSE,
        joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin')  -- #1235: 所属と一緒に外す
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

CREATE OR REPLACE FUNCTION public.release_user_membership(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_org_id UUID;
BEGIN
  SELECT organization_id INTO v_org_id FROM user_profiles WHERE id = p_user_id FOR UPDATE;

  IF v_org_id IS NOT NULL THEN
    -- 対象を無効化してからカウントを減らす (leave_org と同じ冪等パターン)。
    -- WHERE organization_id = v_org_id が不成立 (=既に無効化済み) なら
    -- 0行 UPDATE となり、以降の decrement/監査ログもスキップされる。
    UPDATE user_profiles
      SET organization_id = NULL, org_role = NULL,
          is_active_in_org = FALSE, joined_org_at = NULL,
          roles = array_remove(roles, 'org_admin')  -- #1235: 所属と一緒に外す
      WHERE id = p_user_id AND organization_id = v_org_id;

    IF FOUND THEN
      UPDATE org_license_pools
        SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
        WHERE organization_id = v_org_id;

      INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
      VALUES ('organization', v_org_id, 'member_left', p_user_id, p_user_id,
              jsonb_build_object('reason', 'account_delete'));
    END IF;
  END IF;
END $$;
