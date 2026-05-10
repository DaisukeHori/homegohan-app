-- migration: 20260511000126_organizations_status_columns.sql
-- Round 3 監査 C-1: organizations に status / dissolved_at 列追加
-- operator 緊急解散時の状態追跡

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'dissolved')),
  ADD COLUMN IF NOT EXISTS dissolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status) WHERE status = 'dissolved';

COMMENT ON COLUMN organizations.status IS '組織状態: active / dissolved (operator が緊急解散時に dissolved)';
COMMENT ON COLUMN organizations.dissolved_at IS '解散実施時刻 (status = dissolved 時のみ NOT NULL)';
