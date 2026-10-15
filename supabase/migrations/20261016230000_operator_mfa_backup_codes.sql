-- migration: 20261016230000_operator_mfa_backup_codes.sql
-- 運営ロールの MFA (二段階認証) のバックアップコード (#1176。docs/design/cross/12-operator-mfa.md §11)
--
-- 1 行 = 1 個のコード。値そのものは持たず、SHA-256 (hex 64 文字。前像は "<user_id>:<正規化したコード>") だけを持つ。
-- 使ったコードは used_at を書く (行は残す)。再発行・回復・解除ではその利用者の行を全部消す
-- (コードを使えるのは verified な TOTP factor があるときだけ。削除に失敗して残った行は、回復が verified な factor を
-- 先に確かめるので使われず、次の発行が先に消す。docs/design/cross/12-operator-mfa.md §10・§17.2)。
-- 読み書きは service_role だけ (RLS 有効・ポリシー無し。anon / authenticated は何もできない)。
-- 何度流しても同じ結果になる (IF NOT EXISTS)。既存の表・列・関数には触れない。
-- 戻し方: supabase/rollbacks/20261016230000_operator_mfa_backup_codes.down.sql
-- 確かめるテスト: tests/operator-mfa-backup-codes-migration-contract.test.ts (文面)・tests/integration/security/operator-mfa.test.ts (実 DB)

CREATE TABLE IF NOT EXISTS public.operator_mfa_backup_codes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id    uuid        NOT NULL,
  code_hash   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  CONSTRAINT operator_mfa_backup_codes_user_hash_key UNIQUE (user_id, code_hash),
  CONSTRAINT operator_mfa_backup_codes_code_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS operator_mfa_backup_codes_user_unused_idx
  ON public.operator_mfa_backup_codes (user_id)
  WHERE used_at IS NULL;

ALTER TABLE public.operator_mfa_backup_codes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.operator_mfa_backup_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.operator_mfa_backup_codes TO service_role;

COMMENT ON TABLE public.operator_mfa_backup_codes IS
  '運営ロールの MFA のバックアップコード (SHA-256 のみ)。service_role 専用。docs/design/cross/12-operator-mfa.md §11';
COMMENT ON COLUMN public.operator_mfa_backup_codes.code_hash IS 'sha256("<user_id>:<正規化したコード>") の hex';
COMMENT ON COLUMN public.operator_mfa_backup_codes.batch_id IS '同時に発行した 10 個を束ねる id';
COMMENT ON COLUMN public.operator_mfa_backup_codes.used_at IS '使った日時。NULL = 未使用';
