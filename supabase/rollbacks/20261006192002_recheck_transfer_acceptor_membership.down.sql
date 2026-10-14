-- rollback: 20261006192002_recheck_transfer_acceptor_membership.sql
-- ⚠️ セキュリティ後退: 承諾時点の当事者性再検証 (#1236 / #1237) と TOCTOU 対策を外し、
--    脱退済みユーザーによるオーナー / 代表者の奪取 (組織の削除・家族の CASCADE 削除) を再び可能にする。
--    正当な移譲が壊れた等の緊急時に、明示的な承認を得た場合に限って使う。
--
-- 内容: 20260711120000_fix_ownership_transfer_accept_return.sql の関数本体へ戻す。
--       REVOKE / GRANT は明示シグネチャ形式を維持する (前進的ロールバック)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

CREATE OR REPLACE FUNCTION public.accept_org_owner_transfer(p_proposal_id UUID)
RETURNS organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_org_id UUID;
  v_old_owner_id UUID;
  v_result organizations%ROWTYPE;
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

  v_org_id := v_proposal.scope_id;
  v_old_owner_id := v_proposal.from_user_id;

  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id;

  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = auth.uid();
  UPDATE organizations SET owner_id = auth.uid() WHERE id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_org_id, 'owner_transferred', auth.uid(), v_old_owner_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM organizations WHERE id = v_org_id;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_org_owner_transfer(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.accept_org_owner_transfer(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_family_representative_transfer(p_proposal_id UUID)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_family_id UUID;
  v_old_rep_id UUID;
  v_result family_groups%ROWTYPE;
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

  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id;

  UPDATE family_members SET role = 'adult' WHERE family_id = v_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative' WHERE family_id = v_family_id AND user_id = auth.uid() AND status = 'active';
  UPDATE family_groups SET representative_id = auth.uid() WHERE id = v_family_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_family_id, 'representative_transferred', auth.uid(), v_old_rep_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM family_groups WHERE id = v_family_id;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_family_representative_transfer(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.accept_family_representative_transfer(uuid) TO authenticated;
