-- migration: 20260511000096_ownership_transfer_proposals.sql
-- P0 Critical Fix F9
-- owner/representative 譲渡の 2-step フローを専用テーブルで管理
-- (membership_audit の JSONB 経由だと二重実行防止が不確実なため)

CREATE TABLE IF NOT EXISTS ownership_transfer_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('organization','family')),
  scope_id UUID NOT NULL,
  from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','expired')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- 同一 scope/scope_id で pending の proposal は 1 件まで (二重実行防止)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ownership_transfer_pending
  ON ownership_transfer_proposals(scope, scope_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ownership_transfer_to_user
  ON ownership_transfer_proposals(to_user_id, status);

CREATE INDEX IF NOT EXISTS idx_ownership_transfer_from_user
  ON ownership_transfer_proposals(from_user_id, status);

-- RLS: from_user と to_user のみ参照可能
ALTER TABLE ownership_transfer_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ownership_transfer_select ON ownership_transfer_proposals;
CREATE POLICY ownership_transfer_select ON ownership_transfer_proposals
  FOR SELECT USING (
    from_user_id = auth.uid() OR to_user_id = auth.uid()
  );

-- INSERT は from_user 本人のみ (RPC 経由で SECURITY DEFINER から行う)
DROP POLICY IF EXISTS ownership_transfer_insert ON ownership_transfer_proposals;
CREATE POLICY ownership_transfer_insert ON ownership_transfer_proposals
  FOR INSERT WITH CHECK (from_user_id = auth.uid());
