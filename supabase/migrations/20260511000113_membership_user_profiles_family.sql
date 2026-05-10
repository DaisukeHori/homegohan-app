-- migration: 20260511000113_membership_user_profiles_family.sql
-- (設計書 01-data-model.md §3.4)
-- 番号: 設計書指定 000013 → 000113 にシフト

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS family_id UUID REFERENCES family_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_family ON user_profiles(family_id) WHERE family_id IS NOT NULL;
