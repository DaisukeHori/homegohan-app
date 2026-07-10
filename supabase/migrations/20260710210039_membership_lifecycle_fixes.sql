-- migration: 20260710210039_membership_lifecycle_fixes.sql
-- Issue #1039 [High] メンバーシップのライフサイクル不具合（辞退/席数超過/ライセンスリーク）
--
-- F3-06/F3-07: ownership_transfer_proposals の「辞退」が両経路とも機能しない
--   - family/org 双方の decline route が RLS の効かない直接 UPDATE を行っており
--     (RLS に UPDATE policy が無いため 0 行に潰れる)、family 側は偽装成功・org 側は
--     存在しない列 responded_at を SET して常時500だった。
--   - 修正: decline を SECURITY DEFINER RPC (decline_org_owner_transfer /
--     decline_family_representative_transfer) に統一する。
--   - ★ 000130 (transfer_proposals_rls_tighten) と同じ設計方針: UPDATE policy は
--     追加しない (暗黙 DENY のまま)。ownership_transfer_proposals への状態遷移は
--     propose/accept/decline のいずれも SECURITY DEFINER RPC 経由のみに統一し、
--     authenticated ロールからの直接 UPDATE は今後も一切許可しない。
--
-- F3-08: accept_org_invite に席数チェックが無く座席超過
--   - create_org_invite は発行時に used_licenses >= total を見るが、
--     used_licenses は accept 時にしか増えないため、複数招待を先に発行して
--     全員が accept すると座席超過が発生していた。
--   - 修正: accept_org_invite の increment 直前に SELECT ... FOR UPDATE で
--     上限を再チェックし、超過なら SEAT_LIMIT_EXCEEDED を RAISE する。
--
-- F3-09: 退会でライセンスシートが解放されずリーク
--   - account/delete が leave_org/remove_org_member を経由せず
--     auth.admin.deleteUser を直接呼ぶため、org_license_pools.used_licenses が
--     減らず退会のたびに1席リークしていた。
--   - 修正: release_user_membership(p_user_id) SECURITY DEFINER RPC を新設し、
--     account/delete がユーザー削除の直前に service_role で呼び出す。
--
-- ★ 権限まわりの追加知見 (ローカル検証で実測):
--   Supabase 本番は `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"
--   GRANT ALL ON FUNCTIONS TO "anon"/"authenticated"/"service_role"` が設定されており、
--   新規関数は CREATE 時点で anon/authenticated/service_role に自動で EXECUTE が
--   付与される。この自動付与は "FROM PUBLIC" への REVOKE では取り消せない
--   (PUBLIC への付与ではなく各ロールへの個別付与のため)。
--   → 本 migration の全関数は REVOKE を PUBLIC だけでなく anon/authenticated/
--   service_role にも明示し、GRANT で必要なロールのみ復元する。

-- membership_audit.action の CHECK 制約に decline 系アクションを追加
-- (元制約 20260511000104_membership_audit.sql の action CHECK を拡張)
ALTER TABLE membership_audit DROP CONSTRAINT IF EXISTS membership_audit_action_check;
ALTER TABLE membership_audit ADD CONSTRAINT membership_audit_action_check CHECK (action IN (
  'group_created','group_dissolved',
  'invite_created','invite_accepted','invite_rejected','invite_revoked','invite_expired',
  'member_added','member_removed','member_left','child_added','child_promoted',
  'role_changed',
  'owner_transfer_proposed','owner_transferred','owner_transfer_declined',
  'representative_transfer_proposed','representative_transferred','representative_transfer_declined',
  'operator_force_owner_transfer','operator_force_representative_transfer',
  'operator_force_dissolve',
  'paste_executed'
));

COMMENT ON TABLE ownership_transfer_proposals IS
  'INSERT/UPDATE は SECURITY DEFINER RPC (propose_org_owner_transfer / propose_family_representative_transfer / '
  'accept_org_owner_transfer / accept_family_representative_transfer / decline_org_owner_transfer / '
  'decline_family_representative_transfer) 経由のみ。直接 INSERT/UPDATE は authenticated/anon ともに不可 '
  '(#1039 F3-06/F3-07 対応。000130 の設計方針を UPDATE にも適用)';

-- F3-06/F3-07: org owner 譲渡の辞退
CREATE OR REPLACE FUNCTION public.decline_org_owner_transfer(p_proposal_id UUID)
RETURNS ownership_transfer_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_proposal ownership_transfer_proposals;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND scope = 'organization';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.to_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- status='pending' を条件に含めた UPDATE で二重処理/競合を防止
  UPDATE ownership_transfer_proposals
    SET status = 'rejected', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_proposal.scope_id, 'owner_transfer_declined',
          auth.uid(), v_proposal.from_user_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  RETURN v_proposal;
END $$;

-- anon/service_role にも default privileges 経由で自動付与されるため明示的に revoke
REVOKE EXECUTE ON FUNCTION public.decline_org_owner_transfer FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decline_org_owner_transfer TO authenticated;

-- F3-06/F3-07: family representative 譲渡の辞退
CREATE OR REPLACE FUNCTION public.decline_family_representative_transfer(p_proposal_id UUID)
RETURNS ownership_transfer_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_proposal ownership_transfer_proposals;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND scope = 'family';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.to_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- status='pending' を条件に含めた UPDATE で二重処理/競合を防止
  UPDATE ownership_transfer_proposals
    SET status = 'rejected', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_proposal.scope_id, 'representative_transfer_declined',
          auth.uid(), v_proposal.from_user_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  RETURN v_proposal;
END $$;

-- anon/service_role にも default privileges 経由で自動付与されるため明示的に revoke
REVOKE EXECUTE ON FUNCTION public.decline_family_representative_transfer FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decline_family_representative_transfer TO authenticated;

-- F3-08: accept_org_invite に座席上限の再チェックを追加
-- (20260511000105_membership_org_rpc.sql の accept_org_invite を全文差し替え。
--  ライセンス使用数 increment 直前に SELECT ... FOR UPDATE で上限を再検証する点のみ変更)
CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token TEXT)
RETURNS user_profiles
LANGUAGE plpgsql
SECURITY DEFINER  -- ★ 受諾は user_profiles を SET するため DEFINER 必須
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_user_profile user_profiles;
  v_caller_email TEXT;
  v_total_licenses INT;
  v_used_licenses INT;
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

  -- ★ F3-08: ライセンス使用数 increment 直前に上限を再チェック (座席超過防止)
  -- create_org_invite は発行時にしか上限を見ないため、複数招待の先行発行 →
  -- 全員 accept で座席超過するのを防ぐ。FOR UPDATE で同時実行時の競合も防止。
  SELECT total_licenses, used_licenses INTO v_total_licenses, v_used_licenses
    FROM org_license_pools WHERE organization_id = v_invite.organization_id FOR UPDATE;

  IF v_total_licenses IS NOT NULL AND v_used_licenses >= v_total_licenses THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

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

-- ★ #1039 で判明: 本番実測で anon/service_role にも default privileges 経由で
-- EXECUTE が自動付与されたまま残っていた (REVOKE FROM PUBLIC だけでは取り消されない)。
-- ここで明示的に revoke してドリフトを是正する。
REVOKE EXECUTE ON FUNCTION public.accept_org_invite FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_org_invite TO authenticated;

-- F3-09: 退会 (account/delete 経由の auth.admin.deleteUser) で org ライセンス席を解放する。
-- account/delete は service_role で deleteUser 直前に本 RPC を呼ぶ想定
-- (leave_org/remove_org_member を経由しない削除フローのため専用 RPC を用意)。
CREATE OR REPLACE FUNCTION public.release_user_membership(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org_id UUID;
BEGIN
  SELECT organization_id INTO v_org_id FROM user_profiles WHERE id = p_user_id;

  IF v_org_id IS NOT NULL THEN
    UPDATE org_license_pools
      SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
      WHERE organization_id = v_org_id;

    INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
    VALUES ('organization', v_org_id, 'member_left', p_user_id, p_user_id,
            jsonb_build_object('reason', 'account_delete'));
  END IF;
END $$;

-- anon/authenticated にも default privileges 経由で自動付与されるため明示的に revoke
-- (本 RPC は service_role 専用。authenticated からの直接呼び出しは不可)
REVOKE EXECUTE ON FUNCTION public.release_user_membership FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_user_membership TO service_role;
