-- migration: 20260511000103_membership_org_rls.sql
-- (設計書 01-data-model.md §2.4)
-- 番号: 設計書指定 000003 → 000103 にシフト

-- organizations: メンバ自身は SELECT 可、owner/admin は UPDATE 可、owner だけ DELETE 可
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_select_member ON organizations;
CREATE POLICY organizations_select_member ON organizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid() AND up.organization_id = organizations.id
    )
  );

DROP POLICY IF EXISTS organizations_update_admin ON organizations;
CREATE POLICY organizations_update_admin ON organizations
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organizations.id
        AND up.org_role IN ('owner','admin')
    )
  );

DROP POLICY IF EXISTS organizations_delete_owner ON organizations;
CREATE POLICY organizations_delete_owner ON organizations
  FOR DELETE USING (organizations.owner_id = auth.uid());

-- organization_invites: pending 確認は token 持ちなら誰でも (受諾画面で表示するため)
-- 一覧は admin/owner のみ
ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_invites_select_admin ON organization_invites;
CREATE POLICY org_invites_select_admin ON organization_invites
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_invites.organization_id
        AND up.org_role IN ('owner','admin')
    )
  );

DROP POLICY IF EXISTS org_invites_insert_admin ON organization_invites;
CREATE POLICY org_invites_insert_admin ON organization_invites
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_invites.organization_id
        AND up.org_role IN ('owner','admin')
    )
  );

-- DELETE/UPDATE は admin/owner のみ (revoke 用)
DROP POLICY IF EXISTS org_invites_update_admin ON organization_invites;
CREATE POLICY org_invites_update_admin ON organization_invites
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_invites.organization_id
        AND up.org_role IN ('owner','admin')
    )
  );
