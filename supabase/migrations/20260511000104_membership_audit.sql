-- migration: 20260511000104_membership_audit.sql
-- (設計書 01-data-model.md §5)
-- 設計書指定は 000030 だが、org_rpc (000105) / family_rpc (000115) が
-- membership_audit テーブルを INSERT するため、RPC より前に apply が必要。
-- → 000104 に前倒し (org_rls=000103 の直後、org_rpc=000105 の直前)

CREATE TABLE membership_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('organization','family')),
  scope_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'group_created','group_dissolved',
    'invite_created','invite_accepted','invite_rejected','invite_revoked','invite_expired',
    'member_added','member_removed','member_left','child_added','child_promoted',
    'role_changed',
    'owner_transfer_proposed','owner_transferred',
    'representative_transfer_proposed','representative_transferred',
    'operator_force_owner_transfer','operator_force_representative_transfer',
    'operator_force_dissolve',
    'paste_executed'
  )),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- NULL = system / operator
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_membership_audit_scope ON membership_audit(scope, scope_id);
CREATE INDEX idx_membership_audit_actor ON membership_audit(actor_id);
CREATE INDEX idx_membership_audit_target ON membership_audit(target_user_id);
CREATE INDEX idx_membership_audit_action ON membership_audit(action);
CREATE INDEX idx_membership_audit_created_at ON membership_audit(created_at DESC);

ALTER TABLE membership_audit ENABLE ROW LEVEL SECURITY;

-- メンバ自身は自身に関するログのみ閲覧可
CREATE POLICY membership_audit_select_self ON membership_audit
  FOR SELECT USING (actor_id = auth.uid() OR target_user_id = auth.uid());

-- admin/owner は自 scope の全ログ閲覧可
CREATE POLICY membership_audit_select_admin ON membership_audit
  FOR SELECT USING (
    (scope = 'organization' AND EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid()
        AND organization_id = scope_id AND org_role IN ('owner','admin')
    ))
    OR (scope = 'family' AND EXISTS (
      SELECT 1 FROM family_members WHERE family_id = scope_id AND user_id = auth.uid()
        AND role IN ('representative','adult') AND status = 'active'
    ))
  );

-- 運営管理者は全ログ閲覧可 (super_admin role)
CREATE POLICY membership_audit_select_operator ON membership_audit
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid()
        AND ('super_admin' = ANY(roles) OR 'admin' = ANY(roles))
    )
  );

-- INSERT は SECURITY DEFINER 経由のみ (直接 INSERT は service_role のみ)
-- 通常のユーザは INSERT 不可
