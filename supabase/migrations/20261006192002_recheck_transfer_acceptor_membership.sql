-- migration: 20261006192002_recheck_transfer_acceptor_membership.sql
-- Issue #1236 [Crit] 組織オーナー移譲の承諾で当事者性を再検証しない権限昇格
-- Issue #1237 [Crit] 家族代表者移譲の承諾で同上 (DELETE CASCADE で配下データ全消滅)
--
-- 脆弱性:
--   accept_org_owner_transfer(uuid) / accept_family_representative_transfer(uuid)
--   (現行 20260711120000。2026-10-06 の本番スナップショットでも本体は同一) は
--   pending proposal の to_user_id = auth.uid() のみ確認し、承諾時点で承諾者が今もその
--   組織 / 家族に所属しているかを再検証しない。脱退・他所属したユーザーが過去に受領した
--   pending proposal を後から承諾すると owner_id / representative_id を奪取でき、
--   RLS (organizations_delete_owner / family_groups_delete_representative) 経由で
--   対象を DELETE できる (family は CASCADE)。
--
--   BEFORE UPDATE トリガー (20260511000136 / 20260711100030) も RLS WITH CHECK
--   (20260710210014) も SECURITY DEFINER (current_user = 'postgres') をバイパスするため、
--   修正は RPC 本体でしか行えない。
--
-- 追加する 2 防御 (シグネチャ・戻り値型・監査 INSERT・role swap 順序・%ROWTYPE RETURN は不変):
--   (A) proposal 取得 & 期限確認の後・role swap の前に、承諾者 auth.uid() が今も
--       対象 org / family の active メンバであることを再検証し TRANSFER_ACCEPTOR_NOT_IN_ORG /
--       TRANSFER_ACCEPTOR_NOT_IN_FAMILY を RAISE。
--       移植元: operator_force_owner_transfer / operator_force_representative_transfer
--       (20260511000125) の TARGET_NOT_IN_ORG / TARGET_NOT_IN_FAMILY 検査。
--   (B) accepted への UPDATE を「AND status = 'pending' RETURNING ... INTO / IF NOT FOUND
--       RAISE 'TRANSFER_NOT_PENDING'」に変更して二重受諾 / 競合 (TOCTOU) を閉じる。
--       移植元: decline_org_owner_transfer / decline_family_representative_transfer
--       (20260710210039) の同型イディオム。TRANSFER_NOT_PENDING は登録済みコード (409)。
--   期限切れ時の UPDATE にも AND status = 'pending' を付ける (競合で accepted を expired に戻さない)。
--
-- REVOKE / GRANT は明示シグネチャ (uuid) 形式 (20260711130000 の作法)。
-- service_role の EXECUTE は本番の現状 (2026-10-06 スナップショット) どおり維持する。
-- CREATE OR REPLACE のため冪等。ロールバックは supabase/rollbacks/20261006192002_recheck_transfer_acceptor_membership.down.sql。

-- ============================================================================
-- (#1236) 組織オーナー移譲の承諾
-- ============================================================================
CREATE OR REPLACE FUNCTION public.accept_org_owner_transfer(p_proposal_id UUID)
RETURNS organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_org_id UUID;
  v_old_owner_id UUID;
  v_result organizations%ROWTYPE;
BEGIN
  -- pending かつ宛先が呼び出し元である proposal を取得 (既存挙動不変)
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals
      SET status = 'expired', resolved_at = NOW()
      WHERE id = p_proposal_id AND status = 'pending';
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_proposal.scope_id;
  v_old_owner_id := v_proposal.from_user_id;

  -- ★(A) #1236 Fix: 承諾者が今も対象組織のメンバであることを再検証。
  -- leave_org / remove_org_member / release_user_membership は organization_id を NULL に、
  -- 他組織 accept_org_invite は別 org 値に、いずれもアトミックに設定するため、
  -- organization_id = v_org_id の一致確認だけで「今も対象組織に所属」を判定できる。
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'TRANSFER_ACCEPTOR_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- ★(B) #1236 Fix: status = 'pending' 条件つき UPDATE で二重受諾 / 競合 (TOCTOU) を閉じる。
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  -- role swap (順序・意味は現行 20260711120000 と完全同一)
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

-- ============================================================================
-- (#1237) 家族代表者移譲の承諾
-- ============================================================================
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
    UPDATE ownership_transfer_proposals
      SET status = 'expired', resolved_at = NOW()
      WHERE id = p_proposal_id AND status = 'pending';
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_family_id := v_proposal.scope_id;
  v_old_rep_id := v_proposal.from_user_id;

  -- ★(A) #1237 Fix: 承諾者が今も対象家族の active adult / representative であることを再検証。
  -- leave_family / remove_family_member は family_members.status を 'left' / 'removed' に、
  -- user_profiles.family_id を NULL に同一トランザクションで設定するため、
  -- status = 'active' 行の存在確認で「今も対象家族に所属」を判定できる。
  -- role IN ('representative','adult') は operator_force_representative_transfer
  -- (20260511000125) と対称の防御多層化。propose 側で child は既に
  -- CANNOT_TRANSFER_TO_CHILD で遮断されるため happy path には無影響。
  IF NOT EXISTS (
    SELECT 1 FROM family_members
      WHERE family_id = v_family_id
        AND user_id = auth.uid()
        AND status = 'active'
        AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TRANSFER_ACCEPTOR_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- ★(B) TOCTOU close
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  -- role swap (現行 20260711120000 と完全同一)
  UPDATE family_members SET role = 'adult'
    WHERE family_id = v_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = v_family_id AND user_id = auth.uid() AND status = 'active';
  UPDATE family_groups SET representative_id = auth.uid() WHERE id = v_family_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_family_id, 'representative_transferred', auth.uid(), v_old_rep_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM family_groups WHERE id = v_family_id;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_family_representative_transfer(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.accept_family_representative_transfer(uuid) TO authenticated;
