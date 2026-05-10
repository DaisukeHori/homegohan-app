-- migration: 20260511000105_membership_org_rpc.sql
-- (設計書 01-data-model.md §2.5)
-- 番号: 設計書指定 000004 → 000104 にシフト
-- SECURITY DEFINER/INVOKER 使い分け: 設計書通り
--   - create_org_invite: SECURITY INVOKER (呼び出し元権限でadmin/ownerチェック)
--   - accept_org_invite: SECURITY DEFINER (user_profiles を SET するため)
--   - reject_org_invite: SECURITY DEFINER
--   - remove_org_member: SECURITY DEFINER
--   - leave_org: SECURITY DEFINER
--   - propose_org_owner_transfer: SECURITY DEFINER
--   - accept_org_owner_transfer: SECURITY DEFINER

-- 招待発行 (server-side でのみ呼ぶ前提、SECURITY INVOKER)
CREATE OR REPLACE FUNCTION public.create_org_invite(
  p_organization_id UUID,
  p_email TEXT,
  p_role org_role_enum DEFAULT 'member',
  p_custom_message TEXT DEFAULT NULL
) RETURNS organization_invites
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_token TEXT;
  v_caller_org_id UUID;
  v_caller_role org_role_enum;
  v_seat_limit INT;
  v_used_seats INT;
BEGIN
  -- 呼び出し元が同 org の admin/owner か検証
  SELECT organization_id, org_role INTO v_caller_org_id, v_caller_role
    FROM user_profiles WHERE id = auth.uid();

  -- ★ P0 Fix F7: IS NULL チェックを明示 (NULL ロールバイパス防止)
  IF v_caller_org_id IS DISTINCT FROM p_organization_id OR v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- seat 上限チェック (org_license_pools)
  SELECT total_licenses, used_licenses INTO v_seat_limit, v_used_seats
    FROM org_license_pools WHERE organization_id = p_organization_id;

  IF v_seat_limit IS NOT NULL AND v_used_seats >= v_seat_limit THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- token 生成
  v_token := encode(gen_random_bytes(32), 'hex');

  -- 既存 pending を invalidate (revoke)
  UPDATE organization_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE organization_id = p_organization_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO organization_invites (
    organization_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_organization_id, lower(p_email), v_token, p_role, p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_org_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_org_invite TO authenticated;

-- 招待受諾 (token 持ちユーザが呼ぶ)
CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token TEXT)
RETURNS user_profiles
LANGUAGE plpgsql
SECURITY DEFINER  -- ★ 受諾は user_profiles を SET するため DEFINER 必須
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_user_profile user_profiles;
  v_caller_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 招待 fetch (★ Warning 2: SELECT FOR UPDATE で二重受諾防止)
  SELECT * INTO v_invite FROM organization_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 状態チェック
  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE organization_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- email 一致チェック (auth.users から caller の email 取得)
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- 既に他組織所属チェック
  SELECT * INTO v_user_profile FROM user_profiles WHERE id = auth.uid();
  IF v_user_profile.organization_id IS NOT NULL
     AND v_user_profile.organization_id <> v_invite.organization_id THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- 自身が別 org の owner か (owner は脱退不可)
  IF EXISTS (SELECT 1 FROM organizations WHERE owner_id = auth.uid()
             AND id <> v_invite.organization_id) THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  -- メンバ化
  UPDATE user_profiles
    SET organization_id = v_invite.organization_id,
        org_role = v_invite.invited_role,
        joined_org_at = CURRENT_DATE,
        is_active_in_org = TRUE
    WHERE id = auth.uid()
    RETURNING * INTO v_user_profile;

  -- 招待消化
  UPDATE organization_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  -- ライセンス使用数 increment
  UPDATE org_license_pools
    SET used_licenses = used_licenses + 1, updated_at = NOW()
    WHERE organization_id = v_invite.organization_id;

  -- 監査ログ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id, 'role', v_invite.invited_role));

  RETURN v_user_profile;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_org_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_org_invite TO authenticated;

-- 招待拒否
CREATE OR REPLACE FUNCTION public.reject_org_invite(p_token TEXT)
RETURNS organization_invites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_caller_email TEXT;
BEGIN
  SELECT * INTO v_invite FROM organization_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status NOT IN ('pending') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
    IF lower(v_caller_email) <> lower(v_invite.email) THEN
      RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE organization_invites
    SET status = 'rejected', rejected_at = NOW()
    WHERE id = v_invite.id
    RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_rejected', auth.uid(), NULL,
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.reject_org_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_org_invite TO anon, authenticated;

-- メンバ除名 (admin/owner のみ)
CREATE OR REPLACE FUNCTION public.remove_org_member(p_organization_id UUID, p_user_id UUID)
RETURNS user_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_caller_role org_role_enum;
  v_target user_profiles;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  -- ★ P0 Fix F7: IS NULL チェックを明示 (NULL ロールバイパス防止)
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target FROM user_profiles WHERE id = p_user_id;
  -- ★ Round 3 C-2: NOT FOUND チェック追加 (NULL dereference 防止)
  IF NOT FOUND OR v_target.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'USER_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- owner は除名不可 (まず譲渡)
  IF v_target.org_role = 'owner' THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_OWNER' USING ERRCODE = 'P0001';
  END IF;

  -- admin → admin の除名は禁止 (owner のみが admin を除名可)
  IF v_target.org_role = 'admin' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL
    WHERE id = p_user_id
    RETURNING * INTO v_target;

  -- ライセンス使用数 decrement
  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = p_organization_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', p_organization_id, 'member_removed', auth.uid(), p_user_id);

  RETURN v_target;
END $$;

REVOKE EXECUTE ON FUNCTION public.remove_org_member FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_org_member TO authenticated;

-- 自発脱退
CREATE OR REPLACE FUNCTION public.leave_org()
RETURNS user_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
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
        is_active_in_org = FALSE, joined_org_at = NULL
    WHERE id = auth.uid()
    RETURNING * INTO v_user;

  -- ライセンス使用数 decrement
  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', v_org_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_user;
END $$;

REVOKE EXECUTE ON FUNCTION public.leave_org FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_org TO authenticated;

-- owner 譲渡 (2 step: propose → accept)
-- P0 Critical Fix F9: ownership_transfer_proposals テーブル経由で二重実行防止
CREATE OR REPLACE FUNCTION public.propose_org_owner_transfer(p_organization_id UUID, p_to_user_id UUID)
RETURNS UUID  -- proposal id
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role org_role_enum; v_target_role org_role_enum; v_proposal_id UUID;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  -- ★ P0 Fix F7: IS NULL チェックを明示 (NULL ロールバイパス防止)
  IF v_caller_role IS NULL OR v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT org_role INTO v_target_role FROM user_profiles
    WHERE id = p_to_user_id AND organization_id = p_organization_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- 既存 pending proposal を expired に更新してから新規作成
  UPDATE ownership_transfer_proposals
    SET status = 'expired', resolved_at = NOW()
    WHERE scope = 'organization' AND scope_id = p_organization_id AND status = 'pending';

  INSERT INTO ownership_transfer_proposals (scope, scope_id, from_user_id, to_user_id)
  VALUES ('organization', p_organization_id, auth.uid(), p_to_user_id)
  RETURNING id INTO v_proposal_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'owner_transfer_proposed',
          auth.uid(), p_to_user_id,
          jsonb_build_object('proposal_id', v_proposal_id));

  RETURN v_proposal_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.propose_org_owner_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propose_org_owner_transfer TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_org_owner_transfer(p_proposal_id UUID)
RETURNS organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_proposal ownership_transfer_proposals; v_org_id UUID; v_old_owner_id UUID;
BEGIN
  -- ★ P0 Fix F9: ownership_transfer_proposals テーブル経由で参照 (二重実行防止)
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals SET status = 'expired', resolved_at = NOW() WHERE id = p_proposal_id;
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_proposal.scope_id;
  v_old_owner_id := v_proposal.from_user_id;

  -- proposal を accepted に更新 (UNIQUE 制約で二重受諾防止)
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id;

  -- role swap
  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = auth.uid();
  UPDATE organizations SET owner_id = auth.uid() WHERE id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_org_id, 'owner_transferred', auth.uid(), v_old_owner_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  RETURN (SELECT * FROM organizations WHERE id = v_org_id);
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_org_owner_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_org_owner_transfer TO authenticated;
