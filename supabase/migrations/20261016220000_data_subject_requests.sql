-- migration: 20261016220000_data_subject_requests.sql
-- #1178: 開示・訂正・利用停止・消去の請求 (data subject requests) の表。設計: docs/design/cross/15-data-subject-requests.md
--
-- 権限の考え方:
--   - 書き込み (INSERT / UPDATE) はサーバー (service_role。認証・認可のあと) だけ。anon / authenticated には書き込みのポリシーも権限も付けない
--     (本人に INSERT を許すと、盗んだセッションから PostgREST を直接叩いて verified_at 入りの行を作れるため)。
--   - 読み取りは RLS: 本人は自分の行、運営 (admin / super_admin) は全行。
--     authenticated には列の GRANT で 15 列だけを付ける (admin_notes と verification_token_hash を付けない)。
--     内部メモは本人に見せないため。運営が admin_notes を読む詳細・更新は service_role (requireRole のあと) で読む。
--     15 列は src/lib/data-subject-requests/core.ts の DSR_OWN_COLUMNS と同じ (契約テストで突き合わせる)。
--   - DELETE は誰にも付けない (行は消さない。退会では user_id が外れて行が残る)。
-- 既存データへの影響: なし (新しい表を足すだけ。既存の表・関数・ポリシーには触れない)。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP ... IF EXISTS → CREATE。
-- 確認: tests/integration/rls/data-subject-requests.test.ts / tests/data-subject-requests-migration-contract.test.ts
-- ロールバック: supabase/rollbacks/20261016220000_data_subject_requests.down.sql

CREATE TABLE IF NOT EXISTS public.data_subject_requests (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 請求した本人。退会すると NULL になり、行は残る (サポートの記録と同じ扱い。20261010000100 の方針)
  user_id                  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  request_type             TEXT        NOT NULL,
  status                   TEXT        NOT NULL DEFAULT 'pending_verification',
  -- 本人が書いた請求の内容 (1〜2000 字。上限は src/lib/data-subject-requests/core.ts の DSR_DETAILS_MAX_LENGTH と同じ値)
  details                  TEXT        NOT NULL,
  verification_method      TEXT        NOT NULL DEFAULT 'email_link',
  -- 本人確認トークンの sha256 (16 進)。確認が済んだら NULL。生のトークンは保存しない
  verification_token_hash  TEXT,
  verification_sent_at     TIMESTAMPTZ,
  verification_expires_at  TIMESTAMPTZ,
  verification_send_count  INTEGER     NOT NULL DEFAULT 0,
  verified_at              TIMESTAMPTZ,
  -- 応答期限。本人確認の時点 + DSR_RESPONSE_DUE_DAYS 日 (§12)
  due_at                   TIMESTAMPTZ,
  -- 本人への応答 (本人が設定画面で読む)。対応済み / 却下にするとき必須
  response_note            TEXT,
  -- 運営の内部メモ (本人には見せない)
  admin_notes              TEXT,
  resolved_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT data_subject_requests_request_type_check
    CHECK (request_type IN ('disclosure', 'correction', 'suspension', 'erasure')),
  CONSTRAINT data_subject_requests_status_check
    CHECK (status IN ('pending_verification', 'received', 'in_progress', 'fulfilled', 'rejected', 'withdrawn')),
  CONSTRAINT data_subject_requests_verification_method_check
    CHECK (verification_method IN ('email_link')),
  CONSTRAINT data_subject_requests_details_length_check
    CHECK (char_length(details) BETWEEN 1 AND 2000),
  CONSTRAINT data_subject_requests_response_note_length_check
    CHECK (response_note IS NULL OR char_length(response_note) <= 5000),
  CONSTRAINT data_subject_requests_admin_notes_length_check
    CHECK (admin_notes IS NULL OR char_length(admin_notes) <= 5000),
  CONSTRAINT data_subject_requests_send_count_check
    CHECK (verification_send_count >= 0),
  -- 本人確認待ちは未確認、受付済み以降は確認済み (期限つき)。取り下げはどちらの途中でも起きる
  CONSTRAINT data_subject_requests_verified_consistency_check CHECK (
    (status = 'pending_verification' AND verified_at IS NULL AND due_at IS NULL)
    OR (status IN ('received', 'in_progress', 'fulfilled', 'rejected') AND verified_at IS NOT NULL AND due_at IS NOT NULL)
    OR status = 'withdrawn'
  ),
  -- 終わった請求にだけ resolved_at が入る
  CONSTRAINT data_subject_requests_resolved_consistency_check CHECK (
    (status IN ('fulfilled', 'rejected', 'withdrawn')) = (resolved_at IS NOT NULL)
  )
);

-- 同じ人・同じ種類の開いている請求は 1 つだけ (S-4。user_id が NULL の行は対象外)
CREATE UNIQUE INDEX IF NOT EXISTS data_subject_requests_one_open_per_type
  ON public.data_subject_requests (user_id, request_type)
  WHERE status IN ('pending_verification', 'received', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_data_subject_requests_user_created
  ON public.data_subject_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_subject_requests_status_due
  ON public.data_subject_requests (status, due_at);
CREATE INDEX IF NOT EXISTS idx_data_subject_requests_created
  ON public.data_subject_requests (created_at DESC, id DESC);

-- updated_at は既存のトリガー関数 (public.update_updated_at_column) で更新する
DROP TRIGGER IF EXISTS trigger_data_subject_requests_updated_at ON public.data_subject_requests;
CREATE TRIGGER trigger_data_subject_requests_updated_at
  BEFORE UPDATE ON public.data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.data_subject_requests ENABLE ROW LEVEL SECURITY;

-- Supabase の default privileges が付ける権限を完全形で外してから、必要なものだけ付け直す (20261010123500 と同じ書き方)
REVOKE ALL ON public.data_subject_requests FROM PUBLIC, anon, authenticated, service_role;
-- authenticated は列の GRANT (admin_notes・verification_token_hash を除く 15 列)。select=* や select=admin_notes は 42501 になる
GRANT SELECT (
  id, user_id, request_type, status, details, verification_method, verification_sent_at, verification_expires_at,
  verification_send_count, verified_at, due_at, response_note, resolved_at, created_at, updated_at
) ON public.data_subject_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.data_subject_requests TO service_role;

DROP POLICY IF EXISTS data_subject_requests_select_self ON public.data_subject_requests;
CREATE POLICY data_subject_requests_select_self ON public.data_subject_requests
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS data_subject_requests_select_operator ON public.data_subject_requests;
CREATE POLICY data_subject_requests_select_operator ON public.data_subject_requests
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND ARRAY['admin', 'super_admin']::TEXT[] && up.roles
    )
  );

COMMENT ON TABLE public.data_subject_requests IS
  '#1178: 本人からの開示・訂正・利用停止・消去の請求。書き込みはサーバー (service_role) だけ。本人は自分の行、admin / super_admin は全行を読める (authenticated は admin_notes と verification_token_hash を除く列だけ)。設計: docs/design/cross/15-data-subject-requests.md';
COMMENT ON COLUMN public.data_subject_requests.verification_token_hash IS
  '本人確認リンクのトークンの sha256 (16 進)。確認が済んだら・取り下げたら NULL。生のトークンは保存しない。authenticated には GRANT しない';
COMMENT ON COLUMN public.data_subject_requests.due_at IS
  '応答期限。本人確認の時点から DSR_RESPONSE_DUE_DAYS 日 (既定 30。環境変数で上書き)。超過は due_at < now() で判定する';
COMMENT ON COLUMN public.data_subject_requests.response_note IS
  '本人への応答 (設定画面で本人が読む)。対応済み / 却下にするとき必須';
COMMENT ON COLUMN public.data_subject_requests.admin_notes IS
  '運営の内部メモ。本人には見せない: authenticated に GRANT しない (列の GRANT)。運営は service_role の経路 (requireRole のあと) で読み書きする';
