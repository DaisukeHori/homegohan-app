-- migration: 20260511000110_membership_family_groups.sql
-- (設計書 01-data-model.md §3.1)
-- 番号: 設計書指定 000010 → 000110 にシフト

CREATE TABLE IF NOT EXISTS family_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  representative_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  plan_key TEXT NOT NULL DEFAULT 'free' REFERENCES subscription_plans(plan_key),
  member_limit INT NOT NULL DEFAULT 4 CHECK (member_limit > 0 AND member_limit <= 20),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dissolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dissolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_family_groups_representative ON family_groups(representative_id);
CREATE INDEX IF NOT EXISTS idx_family_groups_status ON family_groups(status);
