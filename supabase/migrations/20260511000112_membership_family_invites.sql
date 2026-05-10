-- migration: 20260511000112_membership_family_invites.sql
-- (設計書 01-data-model.md §3.3)
-- 番号: 設計書指定 000012 → 000112 にシフト

CREATE TABLE IF NOT EXISTS family_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  invited_role family_role_enum NOT NULL DEFAULT 'adult'
    CHECK (invited_role IN ('adult')),  -- ★ 招待で child は不可 (子は親が直接追加)
  custom_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','expired','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_family_invites_pending
  ON family_invites(family_id, lower(email))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_family_invites_token ON family_invites(token);
