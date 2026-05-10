-- migration: 20260511000100_membership_org_extensions.sql
-- (設計書 01-data-model.md §2.1)
-- 番号: 設計書指定 000000 は既存 health_checkups migration と衝突するため 000100 にシフト
-- P0 Critical Fix F5: backfill 安全化 (org_admin 不在 org の fallback 追加 + NULL 残留検出)

-- owner 列 (canonical な single owner)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT;

-- DB 不変条件: owner は必ず存在 (NOT NULL は backfill 後に付与)
-- backfill step 1: 既存 organizations.user_profiles で org_admin role を持つ最古のユーザを owner として設定
UPDATE organizations o
SET owner_id = (
  SELECT up.id FROM user_profiles up
  WHERE up.organization_id = o.id
    AND 'org_admin' = ANY(up.roles)
  ORDER BY up.created_at ASC
  LIMIT 1
)
WHERE owner_id IS NULL;

-- ★ backfill step 2: org_admin 不在の org は最古メンバを owner に (fallback)
UPDATE organizations o
SET owner_id = (
  SELECT up.id FROM user_profiles up
  WHERE up.organization_id = o.id
  ORDER BY up.created_at ASC
  LIMIT 1
)
WHERE owner_id IS NULL;

-- ★ 検出: メンバ皆無 org があれば明示エラー (運用判断必要)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM organizations WHERE owner_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill owner_id for orgs: % (no members exist)',
      (SELECT array_agg(name) FROM organizations WHERE owner_id IS NULL);
  END IF;
END $$;

ALTER TABLE organizations
  ALTER COLUMN owner_id SET NOT NULL;

-- 検索用 index
CREATE INDEX IF NOT EXISTS idx_organizations_owner_id ON organizations(owner_id);
