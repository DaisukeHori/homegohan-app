-- migration: 20260511000098_membership_user_profiles_org_attrs.sql
-- P0 Critical Fix F2
-- user_profiles に joined_org_at / is_active_in_org を追加
-- 000101 より先に apply する必要があるため 000098 で作成
-- (000105_membership_org_rpc が accept_org_invite で両カラムを SET するため)

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS joined_org_at DATE,
  ADD COLUMN IF NOT EXISTS is_active_in_org BOOLEAN NOT NULL DEFAULT FALSE;

-- 既に organization_id を持つ既存ユーザの is_active_in_org を TRUE に backfill
UPDATE user_profiles
SET is_active_in_org = TRUE
WHERE organization_id IS NOT NULL
  AND is_active_in_org IS DISTINCT FROM TRUE;
