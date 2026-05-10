-- migration: 20260511000115_membership_family_rpc.sql
-- (設計書 01-data-model.md §3.6)
-- 番号: 設計書指定 000015 → 000115 にシフト
-- 設計書で「org と同パターンで省略」とされた RPC も全て実装する:
--   create_family_invite, accept_family_invite, reject_family_invite,
--   remove_family_member, leave_family,
--   propose_family_representative_transfer, accept_family_representative_transfer

-- 家族グループ作成 (作成者が自動的に representative)
CREATE OR REPLACE FUNCTION public.create_family_group(p_name TEXT, p_plan_key TEXT DEFAULT 'free')
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_group family_groups;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_groups (name, representative_id, plan_key)
  VALUES (p_name, auth.uid(), p_plan_key)
  RETURNING * INTO v_group;

  INSERT INTO family_members (family_id, user_id, role, display_name)
  VALUES (v_group.id, auth.uid(), 'representative',
          (SELECT nickname FROM user_profiles WHERE id = auth.uid()));

  UPDATE user_profiles SET family_id = v_group.id WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_group.id, 'group_created', auth.uid(), auth.uid());

  RETURN v_group;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_family_group FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_family_group TO authenticated;

-- 子供メンバ追加 (auth account なし)
CREATE OR REPLACE FUNCTION public.add_family_child(
  p_family_id UUID,
  p_display_name TEXT,
  p_child_profile JSONB
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_member family_members; v_count INT; v_limit INT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  -- ★ P0 Fix F8: IS NULL チェックを明示 (NULL ロールバイパス防止)
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = p_family_id;
  SELECT COUNT(*) INTO v_count FROM family_members
    WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (family_id, user_id, role, display_name, child_profile)
  VALUES (p_family_id, NULL, 'child', p_display_name, p_child_profile)
  RETURNING * INTO v_member;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'child_added', auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'display_name', p_display_name));

  RETURN v_member;
END $$;

REVOKE EXECUTE ON FUNCTION public.add_family_child FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_family_child TO authenticated;

-- 子供を実 user に promote
CREATE OR REPLACE FUNCTION public.promote_child_to_user(p_member_id UUID, p_user_id UUID)
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_member family_members;
BEGIN
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  -- ★ P0 Fix F8: IS NULL チェックを明示 (NULL ロールバイパス防止)
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = p_user_id AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members SET user_id = p_user_id, child_profile = NULL WHERE id = p_member_id
    RETURNING * INTO v_member;
  UPDATE user_profiles SET family_id = v_member.family_id WHERE id = p_user_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promoted', auth.uid(), p_user_id,
          jsonb_build_object('member_id', p_member_id));

  RETURN v_member;
END $$;

REVOKE EXECUTE ON FUNCTION public.promote_child_to_user FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_child_to_user TO authenticated;

-- 家族招待発行 (representative/adult のみ)
CREATE OR REPLACE FUNCTION public.create_family_invite(
  p_family_id UUID,
  p_email TEXT,
  p_custom_message TEXT DEFAULT NULL
) RETURNS family_invites
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_token TEXT;
  v_caller_role family_role_enum;
  v_count INT;
  v_limit INT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  -- ★ P0 Fix F8: IS NULL チェックを明示 (NULL ロールバイパス防止)
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = p_family_id;
  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  v_token := encode(gen_random_bytes(32), 'hex');

  -- 既存 pending を revoke
  UPDATE family_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE family_id = p_family_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO family_invites (
    family_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_family_id, lower(p_email), v_token, 'adult', p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'invite_created', auth.uid(),
          jsonb_build_object('invite_id', v_invite.id, 'email', lower(p_email)));

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_family_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_family_invite TO authenticated;

-- 家族招待受諾
CREATE OR REPLACE FUNCTION public.accept_family_invite(
  p_token TEXT,
  p_share_meals BOOLEAN DEFAULT TRUE,
  p_share_health BOOLEAN DEFAULT FALSE,
  p_share_menu BOOLEAN DEFAULT TRUE
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_member family_members;
  v_caller_email TEXT;
  v_count INT;
  v_limit INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite FROM family_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE family_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = v_invite.family_id;
  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = v_invite.family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (
    family_id, user_id, role, share_meals, share_health, share_menu
  ) VALUES (
    v_invite.family_id, auth.uid(), 'adult', p_share_meals, p_share_health, p_share_menu
  ) RETURNING * INTO v_member;

  UPDATE user_profiles SET family_id = v_invite.family_id WHERE id = auth.uid();

  UPDATE family_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_member;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_family_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_family_invite TO authenticated;

-- 家族招待拒否
CREATE OR REPLACE FUNCTION public.reject_family_invite(p_token TEXT)
RETURNS family_invites
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_invite family_invites; v_caller_email TEXT;
BEGIN
  SELECT * INTO v_invite FROM family_invites WHERE token = p_token;
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

  UPDATE family_invites
    SET status = 'rejected', rejected_at = NOW()
    WHERE id = v_invite.id
    RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_rejected', auth.uid(), NULL,
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.reject_family_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_family_invite TO anon, authenticated;

-- 家族メンバ除名 (representative/adult のみ)
CREATE OR REPLACE FUNCTION public.remove_family_member(p_family_id UUID, p_member_id UUID)
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_target family_members;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  -- ★ P0 Fix F8: IS NULL チェックを明示 (NULL ロールバイパス防止)
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target FROM family_members WHERE id = p_member_id AND family_id = p_family_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- representative は除名不可
  IF v_target.role = 'representative' THEN
    RAISE EXCEPTION 'IS_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members
    SET status = 'removed', removed_at = NOW()
    WHERE id = p_member_id
    RETURNING * INTO v_target;

  IF v_target.user_id IS NOT NULL THEN
    UPDATE user_profiles SET family_id = NULL WHERE id = v_target.user_id;
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', p_family_id, 'member_removed', auth.uid(), v_target.user_id);

  RETURN v_target;
END $$;

REVOKE EXECUTE ON FUNCTION public.remove_family_member FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_family_member TO authenticated;

-- 家族からの自発脱退
CREATE OR REPLACE FUNCTION public.leave_family()
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member family_members;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_member FROM family_members WHERE user_id = auth.uid() AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  IF v_member.role = 'representative' THEN
    RAISE EXCEPTION 'IS_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members
    SET status = 'left', removed_at = NOW()
    WHERE id = v_member.id
    RETURNING * INTO v_member;

  UPDATE user_profiles SET family_id = NULL WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_member.family_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_member;
END $$;

REVOKE EXECUTE ON FUNCTION public.leave_family FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_family TO authenticated;

-- 代表者譲渡 propose
-- P0 Critical Fix F8+F9: NULL ロールバイパス防止 + ownership_transfer_proposals テーブル経由
CREATE OR REPLACE FUNCTION public.propose_family_representative_transfer(
  p_family_id UUID,
  p_to_user_id UUID
) RETURNS UUID  -- proposal id
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_target_role family_role_enum; v_proposal_id UUID;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  -- ★ P0 Fix F8: IS NULL チェックを明示 (NULL ロールバイパス防止)
  IF v_caller_role IS NULL OR v_caller_role <> 'representative' THEN
    RAISE EXCEPTION 'NOT_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  SELECT role INTO v_target_role FROM family_members
    WHERE family_id = p_family_id AND user_id = p_to_user_id AND status = 'active';
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_target_role = 'child' THEN
    RAISE EXCEPTION 'CANNOT_TRANSFER_TO_CHILD' USING ERRCODE = 'P0001';
  END IF;

  -- ★ P0 Fix F9: ownership_transfer_proposals テーブルで二重実行防止
  -- 既存 pending proposal を expired に更新してから新規作成
  UPDATE ownership_transfer_proposals
    SET status = 'expired', resolved_at = NOW()
    WHERE scope = 'family' AND scope_id = p_family_id AND status = 'pending';

  INSERT INTO ownership_transfer_proposals (scope, scope_id, from_user_id, to_user_id)
  VALUES ('family', p_family_id, auth.uid(), p_to_user_id)
  RETURNING id INTO v_proposal_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'representative_transfer_proposed',
          auth.uid(), p_to_user_id,
          jsonb_build_object('proposal_id', v_proposal_id));

  RETURN v_proposal_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.propose_family_representative_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propose_family_representative_transfer TO authenticated;

-- 代表者譲渡 accept
-- P0 Critical Fix F9: ownership_transfer_proposals テーブル経由で参照 (二重実行防止)
CREATE OR REPLACE FUNCTION public.accept_family_representative_transfer(p_proposal_id UUID)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_proposal ownership_transfer_proposals; v_family_id UUID; v_old_rep_id UUID;
BEGIN
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals SET status = 'expired', resolved_at = NOW() WHERE id = p_proposal_id;
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_family_id := v_proposal.scope_id;
  v_old_rep_id := v_proposal.from_user_id;

  -- proposal を accepted に更新 (UNIQUE 制約で二重受諾防止)
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id;

  -- role swap
  UPDATE family_members SET role = 'adult' WHERE family_id = v_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative' WHERE family_id = v_family_id AND user_id = auth.uid() AND status = 'active';
  UPDATE family_groups SET representative_id = auth.uid() WHERE id = v_family_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_family_id, 'representative_transferred', auth.uid(), v_old_rep_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  RETURN (SELECT * FROM family_groups WHERE id = v_family_id);
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_family_representative_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_family_representative_transfer TO authenticated;
