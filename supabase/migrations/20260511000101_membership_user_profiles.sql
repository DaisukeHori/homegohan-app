-- migration: 20260511000101_membership_user_profiles.sql
-- (設計書 01-data-model.md §2.2)
-- 番号: 設計書指定 000001 → 000101 にシフト
-- P0 Critical Fix F6: CHECK 制約を NOT VALID で追加し、backfill 後に VALIDATE

-- CREATE TYPE は冪等にするため DO block でラップ
DO $$ BEGIN
  CREATE TYPE org_role_enum AS ENUM ('owner', 'admin', 'member');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS org_role org_role_enum;

-- ★ CHECK 制約を NOT VALID で追加 (既存行を validate しない)
-- 先に DROP して重複防止
ALTER TABLE user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_org_consistency;
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_org_consistency CHECK (
    (organization_id IS NULL AND org_role IS NULL)
    OR (organization_id IS NOT NULL AND org_role IS NOT NULL)
  ) NOT VALID;

-- backfill: 既存 organization_id 持ちは role='member' でデフォルト
UPDATE user_profiles
SET org_role = 'member'
WHERE organization_id IS NOT NULL AND org_role IS NULL;

-- owner backfill: organizations.owner_id と一致する user は role='owner' に上書き
UPDATE user_profiles up
SET org_role = 'owner'
FROM organizations o
WHERE up.id = o.owner_id;

-- ★ 全行 validate (backfill 完了後)
ALTER TABLE user_profiles VALIDATE CONSTRAINT user_profiles_org_consistency;

CREATE INDEX IF NOT EXISTS idx_user_profiles_org ON user_profiles(organization_id) WHERE organization_id IS NOT NULL;
