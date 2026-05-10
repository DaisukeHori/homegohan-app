-- migration: 20260511000131_membership_audit_super_admin_only.sql
-- Round 4 監査 C-5
-- membership_audit_select_operator policy を super_admin のみに絞る
-- (000104 では 'super_admin' OR 'admin' が参照可能だったため admin が全ログ閲覧できてしまう)

DROP POLICY IF EXISTS membership_audit_select_operator ON membership_audit;

CREATE POLICY membership_audit_select_operator ON membership_audit
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND 'super_admin' = ANY(roles)
    )
  );
