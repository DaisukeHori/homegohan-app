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
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- ★ Critical 4: NOT NULL 削除, ON DELETE SET NULL に変更
  accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- ★ Critical 4: 既存テーブルへの反映 (fresh install では上記 CREATE TABLE が適用される)
-- 既存 RESTRICT 制約を DROP して SET NULL に変更
ALTER TABLE family_invites DROP CONSTRAINT IF EXISTS family_invites_invited_by_fkey;
ALTER TABLE family_invites ADD CONSTRAINT family_invites_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE family_invites ALTER COLUMN invited_by DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_family_invites_pending
  ON family_invites(family_id, lower(email))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_family_invites_token ON family_invites(token);
