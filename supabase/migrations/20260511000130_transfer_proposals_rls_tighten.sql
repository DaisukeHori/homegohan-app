-- migration: 20260511000130_transfer_proposals_rls_tighten.sql
-- Round 4 監査 C-4
-- ownership_transfer_proposals の直接 INSERT を禁止し
-- SECURITY DEFINER RPC 経由のみ作成可能にする

-- 既存の INSERT policy (ownership_transfer_insert) を削除
-- 000096 で定義: CREATE POLICY ownership_transfer_insert ON ownership_transfer_proposals
--   FOR INSERT WITH CHECK (from_user_id = auth.uid());
-- → authenticated ユーザが直接 INSERT できてしまうため削除
DROP POLICY IF EXISTS ownership_transfer_insert ON ownership_transfer_proposals;

-- INSERT policy を作成しない = Supabase の暗黙 DENY により直接 INSERT は全ロールで不可
-- SECURITY DEFINER の propose_org_owner_transfer / propose_family_representative_transfer のみが
-- service_role 相当で INSERT できる設計

COMMENT ON TABLE ownership_transfer_proposals IS
  'INSERT は SECURITY DEFINER RPC (propose_org_owner_transfer / propose_family_representative_transfer) 経由のみ。'
  '直接 INSERT は authenticated/anon ともに不可 (C-4 Round 4 監査対応)';
