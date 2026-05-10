-- migration: 20260511000102_membership_org_invites.sql
-- (設計書 01-data-model.md §2.3)
-- 番号: 設計書指定 000002 → 000102 にシフト
-- P0 Critical Fix F3: status/invited_by 不在カラムを ADD COLUMN IF NOT EXISTS で補完

-- ★ Warning 4: fresh install 時にテーブルが存在しない場合に備えて CREATE TABLE IF NOT EXISTS
-- リモート DB に既存であれば no-op、fresh install 時に有効
CREATE TABLE IF NOT EXISTS organization_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- 他カラムは下の ALTER TABLE で追加
);

-- ★ status カラムが存在しない場合に追加 (既存テーブルの状況によっては必要)
ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

-- ★ invited_by カラムが存在しない場合に追加
ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- status CHECK 制約を標準化 (既存制約を先に DROP)
ALTER TABLE organization_invites
  DROP CONSTRAINT IF EXISTS organization_invites_status_check;

ALTER TABLE organization_invites
  ADD CONSTRAINT organization_invites_status_check
  CHECK (status IN ('pending','accepted','rejected','expired','revoked'));

-- 招待時に決定する役割
ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS invited_role org_role_enum NOT NULL DEFAULT 'member';

-- 招待者から受領者へのカスタムメッセージ (任意)
ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS custom_message TEXT;

-- 受領者が確定したタイミング
ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 同一 email の pending 招待は 1 organization 1 件まで
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_invites_pending
  ON organization_invites(organization_id, lower(email))
  WHERE status = 'pending';

-- token は当然 UNIQUE
-- 既存 schema にあれば skip、無ければ:
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_invites_token
  ON organization_invites(token);
