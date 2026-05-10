-- migration: 20260511000097_membership_org_license_pools.sql
-- P0 Critical Fix F4
-- org_license_pools テーブルを 000105_membership_org_rpc.sql より先に作成
-- (org_rpc が org_license_pools を参照するため)

CREATE TABLE IF NOT EXISTS org_license_pools (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  total_licenses INTEGER,  -- NULL = 無制限
  used_licenses INTEGER NOT NULL DEFAULT 0,
  available_licenses INTEGER GENERATED ALWAYS AS (COALESCE(total_licenses, 99999) - used_licenses) STORED,
  family_addon_seats INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 既存 organizations については空 row を seed (total_licenses=NULL=無制限)
INSERT INTO org_license_pools (organization_id, total_licenses, used_licenses)
SELECT o.id, NULL, 0 FROM organizations o
ON CONFLICT (organization_id) DO NOTHING;

-- RLS: org メンバ (admin/owner) のみ参照・更新可
ALTER TABLE org_license_pools ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_license_pools_select_member ON org_license_pools;
CREATE POLICY org_license_pools_select_member ON org_license_pools
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid() AND up.organization_id = org_license_pools.organization_id
    )
  );

DROP POLICY IF EXISTS org_license_pools_update_admin ON org_license_pools;
CREATE POLICY org_license_pools_update_admin ON org_license_pools
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = org_license_pools.organization_id
        AND up.org_role IN ('owner','admin')
    )
  );
