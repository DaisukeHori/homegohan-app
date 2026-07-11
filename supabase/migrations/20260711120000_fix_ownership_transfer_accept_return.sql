-- migration: 20260711120000_fix_ownership_transfer_accept_return.sql
-- Issue #1100 [Crit] オーナー/代表者移譲の承認 RPC が複数列 RETURN で常時失敗する
--
-- 原因:
--   accept_org_owner_transfer (20260511000105_membership_org_rpc.sql, RETURNS organizations) と
--   accept_family_representative_transfer (20260511000115_membership_family_rpc.sql, RETURNS family_groups)
--   がともに関数末尾で
--     RETURN (SELECT * FROM organizations WHERE id = v_org_id);
--     RETURN (SELECT * FROM family_groups WHERE id = v_family_id);
--   のように、複合型 (record) を返す関数でスカラサブクエリ文脈を使っている。
--   `SELECT *` は複数列を返すため、この文脈では PostgreSQL が
--   `subquery must return only one column` で実行時エラーとなり、
--   オーナー/代表者移譲の承認が常に失敗する (本番稼働中の重大バグ)。
--
-- 修正方針:
--   ロジック (認可チェック・proposal 状態更新・role swap・監査ログ等) は一切変更せず、
--   RETURN 機構のみを `%ROWTYPE` 変数への SELECT INTO 経由に置き換える。
--   CREATE OR REPLACE FUNCTION による冪等な差し替えのため、シグネチャ・SECURITY DEFINER・
--   SET search_path・REVOKE/GRANT は現行 (20260511000105 / 20260511000115) と完全に一致させる。

CREATE OR REPLACE FUNCTION public.accept_org_owner_transfer(p_proposal_id UUID)
RETURNS organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_org_id UUID;
  v_old_owner_id UUID;
  v_result organizations%ROWTYPE;
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

  -- ★ #1100 Fix: 複合型を返す関数でのスカラサブクエリ `RETURN (SELECT * FROM ...)` は
  -- 複数列のため `subquery must return only one column` で必ず失敗する。
  -- %ROWTYPE 変数への SELECT INTO 経由で単一 composite 値として返す。
  SELECT * INTO v_result FROM organizations WHERE id = v_org_id;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_org_owner_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_org_owner_transfer TO authenticated;

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

  -- ★ #1100 Fix: 複合型を返す関数でのスカラサブクエリ `RETURN (SELECT * FROM ...)` は
  -- 複数列のため `subquery must return only one column` で必ず失敗する。
  -- %ROWTYPE 変数への SELECT INTO 経由で単一 composite 値として返す。
  SELECT * INTO v_result FROM family_groups WHERE id = v_family_id;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_family_representative_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_family_representative_transfer TO authenticated;
