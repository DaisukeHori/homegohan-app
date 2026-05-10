-- migration: 20260511000132_org_license_pools_backfill.sql
-- Round 4 監査 C-7
-- org_license_pools の used_licenses を実メンバ数 (is_active_in_org = TRUE) で再計算
-- accept_org_invite RPC が used_licenses を +1 する前に既存データが 0 のままなので backfill が必要

UPDATE org_license_pools lp
SET used_licenses = (
  SELECT COUNT(*)
  FROM user_profiles up
  WHERE up.organization_id = lp.organization_id
    AND up.is_active_in_org = TRUE
),
updated_at = NOW()
WHERE TRUE;
