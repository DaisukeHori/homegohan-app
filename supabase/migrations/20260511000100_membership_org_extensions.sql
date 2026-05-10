-- migration: 20260511000100_membership_org_extensions.sql
-- (設計書 01-data-model.md §2.1)
-- 番号: 設計書指定 000000 は既存 health_checkups migration と衝突するため 000100 にシフト

-- owner 列 (canonical な single owner)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT;

-- DB 不変条件: owner は必ず存在 (NOT NULL は backfill 後に付与)
-- backfill: 既存 organizations.user_profiles で org_admin role を持つ最古のユーザを owner として設定
UPDATE organizations o
SET owner_id = (
  SELECT up.id FROM user_profiles up
  WHERE up.organization_id = o.id
    AND 'org_admin' = ANY(up.roles)
  ORDER BY up.created_at ASC
  LIMIT 1
)
WHERE owner_id IS NULL;

ALTER TABLE organizations
  ALTER COLUMN owner_id SET NOT NULL;

-- 検索用 index
CREATE INDEX IF NOT EXISTS idx_organizations_owner_id ON organizations(owner_id);
