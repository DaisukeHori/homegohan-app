-- migration: 20261016234000_email_outbox.sql
-- #1193 / #1157: メールの送信待ち (outbox)。sendEmail は Resend を呼ばず、この表に 1 行入れる。
-- 送るのは GET /api/cron/email-outbox (Vercel Cron・毎分) だけ。再試行は最大 EMAIL_OUTBOX_MAX_ATTEMPTS 回 (既定 6)、
-- 使い切ったら dead。super_admin は /super-admin/email-outbox で dead を再送 (requeue) できる。
-- 権限の考え方は 20261010123500_ops_alert_state.sql と同じ (service_role だけ。関数は SECURITY INVOKER・search_path '')。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS / CREATE INDEX IF NOT EXISTS。
-- 既存の行・表には触れない。prepare_account_deletion は 20261010000100 の定義を土台に、email_outbox の段 (1b・1c) を足す (§5.3)。
--
-- 番号: 20261016234000 (origin/main の supabase/migrations の最大より大きい値。マージ直前にオーケストレーターが確かめ直す)。
-- 正典: docs/design/operator/10-logs-and-mail-retry.md §5 (表 §5.1・RPC 8 本 §5.2・prepare_account_deletion の段 1b・1c §5.3・
--       pg_cron の登録 §5.4・ロールバック §5.5)。段 A (#1708): 表と関数を足すだけで、アプリのコードはまだ何も使わない
--       (sendEmail の登録・worker・通知は段 B)。段 B は、この migration の本番適用の後にデプロイする。
--
-- 追加するもの:
--   1. public.email_outbox (1 通 = 1 行。queued → sent / dead) と索引 5 本・RLS・全拒否のポリシー
--   2. RPC 8 本 (claim / complete / fail / requeue / dead_counts / cleanup / mark_dead_alerted / unmark_dead_alerted)。
--      すべて SECURITY INVOKER・SET search_path = ''・EXECUTE は service_role だけ (REVOKE は PUBLIC, anon, authenticated, service_role の完全形)
--   3. public.prepare_account_deletion(uuid) を 20261010000100_auth_users_fk_on_delete.sql の定義に、email_outbox の段 1b・1c と
--      戻り値のキー email_outbox を足して作り直す (それ以外の本体は逐語。REVOKE / GRANT は同じ形)
--   4. pg_cron のジョブ cleanup-email-outbox (毎日 03:20 JST = 20 18 * * * UTC。cleanup_email_outbox() を呼ぶ)
--
-- 既存データへの影響: なし (新しい表を作るだけ。prepare_account_deletion は呼ばれたときにだけ新しい表を更新する)。
-- 確認: tests/integration/rls/email-outbox.test.ts / ロールバック: supabase/rollbacks/20261016234000_email_outbox.down.sql

CREATE TABLE IF NOT EXISTS public.email_outbox (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'dead')),
  -- 文面の名前 (EmailEnvelope.template。無ければ 'unknown')。運用メールは 'ops_' で始まる (§8.3 で数えない)
  template           TEXT        NOT NULL CHECK (char_length(template) BETWEEN 1 AND 100),
  to_email           TEXT        NOT NULL CHECK (char_length(to_email) BETWEEN 3 AND 320),
  from_email         TEXT        NOT NULL CHECK (char_length(from_email) BETWEEN 3 AND 320),
  reply_to           TEXT        CHECK (reply_to IS NULL OR char_length(reply_to) BETWEEN 3 AND 320),
  subject            TEXT        NOT NULL,
  text_body          TEXT        NOT NULL,
  html_body          TEXT,
  -- 誰についてのメールか (任意。退会時の伏せ字と画面の絞り込みに使う)。退会で NULL になる
  user_id            UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
  -- Resend の Idempotency-Key。再試行・再送でも同じ値 (1 回目が届いていても 2 通にならない)
  idempotency_key    TEXT        NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  -- true なら、送れたとき (sent) と届けられなかったとき (dead) に宛先・件名・本文を伏せる (退会の完了メール。cross/08 §16.2 手順 6)
  redact_after_send  BOOLEAN     NOT NULL DEFAULT false,
  attempts           INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requeue_count      INTEGER     NOT NULL DEFAULT 0 CHECK (requeue_count >= 0),
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at   TIMESTAMPTZ,
  worker_id          TEXT,
  last_error_code    TEXT,
  last_error_message TEXT,
  last_status_code   INTEGER,
  sent_at            TIMESTAMPTZ,
  resend_message_id  TEXT,
  dead_at            TIMESTAMPTZ,
  requeued_at        TIMESTAMPTZ,
  -- 届けられなかったメールの運用メール (§8) でこの行を知らせた印。値は app-log-alerts が取った権利の時刻 (claim_ops_alert の戻り値)。
  -- NULL = まだ知らせていない。mark_email_outbox_dead_alerted が付け、送れなかったときは unmark_email_outbox_dead_alerted が外す。
  -- 再送 (requeue_email_outbox) で NULL に戻す (もう一度 dead になれば、また知らせる)
  dead_alerted_at    TIMESTAMPTZ,
  CONSTRAINT email_outbox_status_times CHECK (
       (status = 'queued' AND sent_at IS NULL AND dead_at IS NULL)
    OR (status = 'sent'   AND sent_at IS NOT NULL AND dead_at IS NULL)
    OR (status = 'dead'   AND dead_at IS NOT NULL AND sent_at IS NULL)
  ),
  -- 知らせた印は dead の行にだけ付く (queued / sent に印が残ると、再び dead になったときに知らせなくなる)
  CONSTRAINT email_outbox_dead_alerted_only_dead CHECK (dead_alerted_at IS NULL OR status = 'dead')
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_claim
  ON public.email_outbox (next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_email_outbox_status_created
  ON public.email_outbox (status, created_at DESC, id DESC);
-- dead の行だけの部分索引。掃除 (cleanup_email_outbox の dead_at < now − 30 日) と、通知の数える・印を付ける (§5.2 (5)(7)。dead の行だけを見る) に使う。
-- dead の行は 30 日で消えるので、印の無い行を探すための索引は別に作らない
CREATE INDEX IF NOT EXISTS idx_email_outbox_dead_at
  ON public.email_outbox (dead_at) WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS idx_email_outbox_sent_at
  ON public.email_outbox (sent_at) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_email_outbox_user_id
  ON public.email_outbox (user_id);

ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_outbox FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_outbox TO service_role;
DROP POLICY IF EXISTS email_outbox_deny_client_access ON public.email_outbox;
CREATE POLICY email_outbox_deny_client_access ON public.email_outbox
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.email_outbox IS
  '#1193: メールの送信待ち (outbox)。1 通 = 1 行。queued → sent / dead。service_role のみ。本文を含むので画面には宛先をマスクして件名・本文を出さない。';

-- ─────────────────────────────────────────────────────────
-- RPC 8 本 (§5.2)
-- ─────────────────────────────────────────────────────────
-- (1) 送る行を取る (リース付き・取り合いは SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_email_outbox(
  p_worker_id     TEXT,
  p_limit         INTEGER DEFAULT 20,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF public.email_outbox
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_worker_id IS NULL OR pg_catalog.btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'claim_email_outbox: invalid worker_id' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'claim_email_outbox: invalid limit' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 10 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'claim_email_outbox: invalid lease' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
      FROM public.email_outbox AS o
     WHERE o.status = 'queued'
       AND o.next_attempt_at <= pg_catalog.now()
       AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= pg_catalog.now())
     ORDER BY o.next_attempt_at ASC, o.created_at ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.email_outbox AS o
     SET lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
         worker_id        = p_worker_id,
         updated_at       = pg_catalog.now()
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*;
END $$;

-- (2) 送れた。redact_after_send の行は宛先・件名・本文を伏せる
CREATE OR REPLACE FUNCTION public.complete_email_outbox(
  p_id                UUID,
  p_worker_id         TEXT,
  p_resend_message_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  c_masked_email CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  c_masked_text  CONSTANT pg_catalog.text := '[redacted]';
  v_updated INTEGER;
BEGIN
  UPDATE public.email_outbox AS o
     SET status            = 'sent',
         sent_at           = pg_catalog.now(),
         attempts          = o.attempts + 1,
         resend_message_id = pg_catalog.left(p_resend_message_id, 256),
         lease_expires_at  = NULL,
         worker_id         = NULL,
         updated_at        = pg_catalog.now(),
         to_email  = CASE WHEN o.redact_after_send THEN c_masked_email ELSE o.to_email END,
         subject   = CASE WHEN o.redact_after_send THEN c_masked_text  ELSE o.subject  END,
         text_body = CASE WHEN o.redact_after_send THEN c_masked_text  ELSE o.text_body END,
         html_body = CASE WHEN o.redact_after_send THEN NULL           ELSE o.html_body END
   WHERE o.id = p_id AND o.worker_id = p_worker_id AND o.status = 'queued';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END $$;

-- (3) 送れなかった。再試行するか dead にするかを DB で決める。戻り値は新しい status ('queued' / 'dead')、
--     行が無い・worker が違う・queued でないときは 'ignored'。
--     dead にする行が redact_after_send (退会の完了メール) なら、宛先・件名・本文を伏せる (R-10。再送は 'redacted' で断られる)
CREATE OR REPLACE FUNCTION public.fail_email_outbox(
  p_id                  UUID,
  p_worker_id           TEXT,
  p_error_code          TEXT,
  p_error_message       TEXT,
  p_status_code         INTEGER,
  p_retryable           BOOLEAN,
  p_max_attempts        INTEGER,
  p_retry_after_seconds INTEGER
) RETURNS TEXT
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  c_masked_email CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  c_masked_text  CONSTANT pg_catalog.text := '[redacted]';
  v_status TEXT;
BEGIN
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'fail_email_outbox: invalid max_attempts' USING ERRCODE = '22023';
  END IF;
  IF p_retry_after_seconds IS NULL OR p_retry_after_seconds < 1 OR p_retry_after_seconds > 604800 THEN
    RAISE EXCEPTION 'fail_email_outbox: invalid retry_after' USING ERRCODE = '22023';
  END IF;
  -- NULL だと status (dead) と伏せ字の判定 (伏せない) が食い違うので受け付けない
  IF p_retryable IS NULL THEN
    RAISE EXCEPTION 'fail_email_outbox: invalid retryable' USING ERRCODE = '22023';
  END IF;
  UPDATE public.email_outbox AS o
     SET attempts = o.attempts + 1,
         status   = CASE WHEN p_retryable AND o.attempts + 1 < p_max_attempts THEN 'queued' ELSE 'dead' END,
         dead_at  = CASE WHEN p_retryable AND o.attempts + 1 < p_max_attempts THEN NULL ELSE pg_catalog.now() END,
         next_attempt_at = CASE WHEN p_retryable AND o.attempts + 1 < p_max_attempts
                                THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_after_seconds)
                                ELSE o.next_attempt_at END,
         -- 下の 4 列: dead にする (再試行しない) ときだけ、redact_after_send の行を伏せる。SET の右辺の o.* は更新前の値
         to_email  = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts)
                          THEN c_masked_email ELSE o.to_email END,
         subject   = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts)
                          THEN c_masked_text ELSE o.subject END,
         text_body = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts)
                          THEN c_masked_text ELSE o.text_body END,
         html_body = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts)
                          THEN NULL ELSE o.html_body END,
         last_error_code    = pg_catalog.left(p_error_code, 100),
         last_error_message = pg_catalog.left(p_error_message, 500),
         last_status_code   = p_status_code,
         lease_expires_at   = NULL,
         worker_id          = NULL,
         updated_at         = pg_catalog.now()
   WHERE o.id = p_id AND o.worker_id = p_worker_id AND o.status = 'queued'
  RETURNING o.status INTO v_status;
  RETURN COALESCE(v_status, 'ignored');
END $$;

-- (4) 再送 (dead → queued)。戻り値: 'requeued' / 'not_found' / 'not_dead' / 'redacted' (宛先を伏せた行は送り先が無い)。
--     知らせた印 (dead_alerted_at) は NULL に戻す (もう一度 dead になれば、また知らせる。CHECK email_outbox_dead_alerted_only_dead)
CREATE OR REPLACE FUNCTION public.requeue_email_outbox(p_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  c_masked_email CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  v_status TEXT;
  v_to     TEXT;
BEGIN
  SELECT o.status, o.to_email INTO v_status, v_to FROM public.email_outbox AS o WHERE o.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_status <> 'dead' THEN RETURN 'not_dead'; END IF;
  IF v_to = c_masked_email THEN RETURN 'redacted'; END IF;
  UPDATE public.email_outbox AS o
     SET status = 'queued', attempts = 0, dead_at = NULL, dead_alerted_at = NULL, next_attempt_at = pg_catalog.now(),
         lease_expires_at = NULL, worker_id = NULL,
         requeue_count = o.requeue_count + 1, requeued_at = pg_catalog.now(), updated_at = pg_catalog.now()
   WHERE o.id = p_id;
  RETURN 'requeued';
END $$;

-- (5) まだ知らせていない (dead_alerted_at が NULL の) dead を template ごとに数える (運用メールの通知用。§8)。
--     窓は持たない: 抑止 (claim_ops_alert のクールダウン) の間や cron の発火の遅れの間に dead になった行も、次の回で数える。
--     宛先停止 (suppressed)・退会 (recipient_deleted)・運用メール自身 (template が ops_ で始まる) は数えない。
--     下の WHERE の 5 行 (status から template まで) は (7) mark_email_outbox_dead_alerted の WHERE と同じ条件にする (数えた行 = 印を付けられる行)
CREATE OR REPLACE FUNCTION public.email_outbox_dead_counts(
  p_limit INTEGER DEFAULT 10
) RETURNS TABLE (template TEXT, dead_count BIGINT, total_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'email_outbox_dead_counts: invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT g.template, g.dead_count, (pg_catalog.sum(g.dead_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT o.template, pg_catalog.count(*)::BIGINT AS dead_count
        FROM public.email_outbox AS o
       WHERE o.status = 'dead'
         AND o.dead_alerted_at IS NULL
         AND o.last_error_code IS DISTINCT FROM 'suppressed'
         AND o.last_error_code IS DISTINCT FROM 'recipient_deleted'
         AND o.template NOT LIKE 'ops\_%'
       GROUP BY o.template
    ) AS g
   ORDER BY g.dead_count DESC, g.template ASC
   LIMIT p_limit;
END $$;

-- (6) 掃除 (pg_cron が毎日呼ぶ)。sent は 7 日、dead は 30 日で消す。queued は消さない (worker が 7 日で dead にする)
CREATE OR REPLACE FUNCTION public.cleanup_email_outbox() RETURNS INTEGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  c_sent_retention CONSTANT pg_catalog.interval := interval '7 days';   -- 送れた記録は Resend 側にもある。宛先を長く残さない
  c_dead_retention CONSTANT pg_catalog.interval := interval '30 days';  -- app_logs の保持 (30 日) と同じ
  v_sent INTEGER; v_dead INTEGER;
BEGIN
  DELETE FROM public.email_outbox AS o WHERE o.status = 'sent' AND o.sent_at < pg_catalog.now() - c_sent_retention;
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  DELETE FROM public.email_outbox AS o WHERE o.status = 'dead' AND o.dead_at < pg_catalog.now() - c_dead_retention;
  GET DIAGNOSTICS v_dead = ROW_COUNT;
  RETURN v_sent + v_dead;
END $$;

-- (7) 知らせる行に印を付ける (app-log-alerts が claim_ops_alert で権利を取ったあとに 1 回だけ呼ぶ。§8.2)。
--     まだ印の無い dead (数える条件は (5) と同じ) のすべてに dead_alerted_at = p_alerted_at を付け、
--     印を付けた行だけを template ごとに数えて返す (形は (5) と同じ)。運用メールの件数はこの戻り値で作る
--     (数えたあと印を付けるまでに dead になった行も、印が付けばこの通知に入る。印の付いた行は次の回の (5) に入らない)。
--     p_alerted_at は claim_ops_alert が返した時刻 (権利ごとに違う値)。送れなかったときは (8) がこの値で印を外す
CREATE OR REPLACE FUNCTION public.mark_email_outbox_dead_alerted(
  p_alerted_at TIMESTAMPTZ,
  p_limit      INTEGER DEFAULT 10
) RETURNS TABLE (template TEXT, dead_count BIGINT, total_count BIGINT)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_alerted_at IS NULL THEN
    RAISE EXCEPTION 'mark_email_outbox_dead_alerted: invalid alerted_at' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'mark_email_outbox_dead_alerted: invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH marked AS (
    UPDATE public.email_outbox AS o
       SET dead_alerted_at = p_alerted_at,
           updated_at      = pg_catalog.now()
     WHERE o.status = 'dead'
       AND o.dead_alerted_at IS NULL
       AND o.last_error_code IS DISTINCT FROM 'suppressed'
       AND o.last_error_code IS DISTINCT FROM 'recipient_deleted'
       AND o.template NOT LIKE 'ops\_%'
    RETURNING o.template AS marked_template
  )
  SELECT g.marked_template, g.dead_count, (pg_catalog.sum(g.dead_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT m.marked_template, pg_catalog.count(*)::BIGINT AS dead_count
        FROM marked AS m
       GROUP BY m.marked_template
    ) AS g
   ORDER BY g.dead_count DESC, g.marked_template ASC
   LIMIT p_limit;
END $$;

-- (8) 印を外す (運用メールを送れずに権利を返すとき。§8.3)。p_alerted_at と同じ印の行だけを「まだ知らせていない」に戻し、戻した行数を返す。
--     別の回の印 (時刻が違う) は外さない (release_ops_alert と同じ考え方)
CREATE OR REPLACE FUNCTION public.unmark_email_outbox_dead_alerted(
  p_alerted_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF p_alerted_at IS NULL THEN
    RAISE EXCEPTION 'unmark_email_outbox_dead_alerted: invalid alerted_at' USING ERRCODE = '22023';
  END IF;
  UPDATE public.email_outbox AS o
     SET dead_alerted_at = NULL,
         updated_at      = pg_catalog.now()
   WHERE o.dead_alerted_at = p_alerted_at;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END $$;

REVOKE ALL ON FUNCTION public.claim_email_outbox(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_email_outbox(TEXT, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.complete_email_outbox(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_email_outbox(UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.fail_email_outbox(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_email_outbox(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.requeue_email_outbox(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.requeue_email_outbox(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.email_outbox_dead_counts(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.email_outbox_dead_counts(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_email_outbox() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_email_outbox() TO service_role;
REVOKE ALL ON FUNCTION public.mark_email_outbox_dead_alerted(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_email_outbox_dead_alerted(TIMESTAMPTZ, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.unmark_email_outbox_dead_alerted(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unmark_email_outbox_dead_alerted(TIMESTAMPTZ) TO service_role;

-- 関数の説明 (§5.2 の見出しの説明)
COMMENT ON FUNCTION public.claim_email_outbox(TEXT, INTEGER, INTEGER) IS
  '#1193: 送る行を取る (リース付き・取り合いは SKIP LOCKED)。queued で next_attempt_at を過ぎ、リースの無い (切れた) 行を p_limit 行まで取り、lease_expires_at と worker_id を付けて返す。service_role のみ。';
COMMENT ON FUNCTION public.complete_email_outbox(UUID, TEXT, TEXT) IS
  '#1193: 送れた。worker_id が一致する queued の行を sent にする。redact_after_send の行は宛先・件名・本文を伏せる。更新できたら true。service_role のみ。';
COMMENT ON FUNCTION public.fail_email_outbox(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, INTEGER) IS
  '#1193: 送れなかった。再試行するか dead にするかを DB で決める。戻り値は新しい status (queued / dead)、行が無い・worker が違う・queued でないときは ignored。dead にする行が redact_after_send (退会の完了メール) なら、宛先・件名・本文を伏せる。service_role のみ。';
COMMENT ON FUNCTION public.requeue_email_outbox(UUID) IS
  '#1193: 再送 (dead → queued)。戻り値: requeued / not_found / not_dead / redacted (宛先を伏せた行は送り先が無い)。知らせた印 (dead_alerted_at) は NULL に戻す。service_role のみ。';
COMMENT ON FUNCTION public.email_outbox_dead_counts(INTEGER) IS
  '#1193: まだ知らせていない (dead_alerted_at が NULL の) dead を template ごとに数える (運用メールの通知用)。窓は持たない。宛先停止 (suppressed)・退会 (recipient_deleted)・運用メール自身 (template が ops_ で始まる) は数えない。service_role のみ。';
COMMENT ON FUNCTION public.cleanup_email_outbox() IS
  '#1193: 掃除 (pg_cron のジョブ cleanup-email-outbox が毎日 03:20 JST に呼ぶ)。sent は 7 日、dead は 30 日で消す。queued は消さない (worker が 7 日で dead にする)。消した行数を返す。service_role のみ。';
COMMENT ON FUNCTION public.mark_email_outbox_dead_alerted(TIMESTAMPTZ, INTEGER) IS
  '#1193: 知らせる行に印を付ける (app-log-alerts が claim_ops_alert で権利を取ったあとに 1 回だけ呼ぶ)。まだ印の無い dead (数える条件は email_outbox_dead_counts と同じ) のすべてに dead_alerted_at = p_alerted_at を付け、印を付けた行だけを template ごとに数えて返す。service_role のみ。';
COMMENT ON FUNCTION public.unmark_email_outbox_dead_alerted(TIMESTAMPTZ) IS
  '#1193: 印を外す (運用メールを送れずに権利を返すとき)。p_alerted_at と同じ印の行だけを「まだ知らせていない」に戻し、戻した行数を返す。別の回の印 (時刻が違う) は外さない。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 退会の直前に呼ぶ: prepare_account_deletion に email_outbox の段 1b・1c を足す (§5.3)。
-- 本体は 20261010000100_auth_users_fk_on_delete.sql の定義の逐語に、DECLARE の 3 行・1b・1c・戻り値のキー email_outbox を足したもの
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- 生のメールアドレスの代わりに入れる固定の文字列。.invalid は RFC 2606 の予約済みで、実在するアドレスにならない
  c_masked_email   CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  v_emails         pg_catalog.text[];
  v_delivery_logs  pg_catalog.int4 := 0;
  v_outbox          pg_catalog.int4 := 0;   -- 1b で伏せた行 (本人の行) と 1c で伏せた行 (他人宛の行) の数の和
  v_outbox_mentions pg_catalog.int4 := 0;   -- 1c で伏せた行の数 (v_outbox に足す)
  v_email_pattern   pg_catalog.text;        -- 1c の照合に使う正規表現 (本人のアドレスを | でつないだもの。アドレスが無ければ NULL)
  v_inquiries      pg_catalog.int4 := 0;
  v_org_invites    pg_catalog.int4 := 0;
  v_family_invites pg_catalog.int4 := 0;
  v_promotions     pg_catalog.int4 := 0;
  v_private_recipes pg_catalog.int4 := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'prepare_account_deletion: p_user_id is required' USING ERRCODE = '22023';
  END IF;

  -- 本人のメールアドレス (小文字)。ログイン用のメールと、外部ログイン (Google など) の identity に入っているメール
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT s.email), ARRAY[]::pg_catalog.text[])
    INTO v_emails
    FROM (
      SELECT pg_catalog.lower(u.email) AS email
        FROM auth.users AS u
       WHERE u.id = p_user_id
      UNION
      SELECT pg_catalog.lower(i.identity_data ->> 'email')
        FROM auth.identities AS i
       WHERE i.user_id = p_user_id
    ) AS s
   WHERE s.email IS NOT NULL AND s.email <> '';

  -- 1) メール配信ログ: 本人宛のログの宛先を伏せる (行は残す)
  UPDATE public.email_delivery_logs AS l
     SET email = c_masked_email
   WHERE (l.user_id = p_user_id OR pg_catalog.lower(l.email) = ANY (v_emails))
     AND l.email <> c_masked_email;
  GET DIAGNOSTICS v_delivery_logs = ROW_COUNT;

  -- 1b) 送信待ち (email_outbox): 本人の行 (user_id が本人、または宛先が本人のアドレス) の宛先・件名・本文を伏せる。
  --     まだ送っていない行 (queued) は送り先が無くなるので dead (recipient_deleted) にする。sent / dead は状態のまま伏せるだけ
  UPDATE public.email_outbox AS o
     SET to_email  = c_masked_email,
         subject   = '[redacted]',
         text_body = '[redacted]',
         html_body = NULL,
         status    = CASE WHEN o.status = 'queued' THEN 'dead' ELSE o.status END,
         dead_at   = CASE WHEN o.status = 'queued' THEN pg_catalog.now() ELSE o.dead_at END,
         last_error_code = CASE WHEN o.status = 'queued' THEN 'recipient_deleted' ELSE o.last_error_code END,
         lease_expires_at = NULL,
         worker_id = NULL,
         updated_at = pg_catalog.now()
   WHERE (o.user_id = p_user_id OR pg_catalog.lower(o.to_email) = ANY (v_emails))
     AND o.to_email <> c_masked_email;
  GET DIAGNOSTICS v_outbox = ROW_COUNT;

  -- 1c) 送信待ち (email_outbox): 他人宛の行 (1b で伏せなかった行) の件名・本文・返信先に入った本人のアドレスを、
  --     その部分だけ伏せ字にする (大文字小文字を区別しない)。他人へのメールなので送るのはやめない:
  --     status・attempts・next_attempt_at・リース (worker_id / lease_expires_at)・idempotency_key・to_email は変えない。
  --     例: 運営の強制譲渡の通知 (新オーナー宛の本文の旧オーナーのアドレス)・家族の昇格の依頼と招待 (表示名が無い代表者・招待者のアドレス)
  --     照合の正規表現: 本人のアドレスの英数字以外の文字を \ で文字どおりにし (. や + を任意の文字・繰り返しにしない)、| でつなぐ
  SELECT pg_catalog.string_agg(pg_catalog.regexp_replace(e.addr, '([^[:alnum:]])', '\\\1', 'g'), '|')
    INTO v_email_pattern
    FROM pg_catalog.unnest(v_emails) AS e(addr);
  IF v_email_pattern IS NOT NULL THEN
    UPDATE public.email_outbox AS o
       SET subject    = pg_catalog.regexp_replace(o.subject, v_email_pattern, c_masked_email, 'gi'),
           text_body  = pg_catalog.regexp_replace(o.text_body, v_email_pattern, c_masked_email, 'gi'),
           html_body  = pg_catalog.regexp_replace(o.html_body, v_email_pattern, c_masked_email, 'gi'),
           reply_to   = pg_catalog.regexp_replace(o.reply_to, v_email_pattern, c_masked_email, 'gi'),
           updated_at = pg_catalog.now()
     WHERE o.to_email <> c_masked_email
       AND (o.subject ~* v_email_pattern
            OR o.text_body ~* v_email_pattern
            OR o.html_body ~* v_email_pattern
            OR o.reply_to ~* v_email_pattern);
    GET DIAGNOSTICS v_outbox_mentions = ROW_COUNT;
    v_outbox := v_outbox + v_outbox_mentions;
  END IF;

  -- 2) 問い合わせ: 本人の問い合わせの連絡先メールを伏せる (本文は残す。ログイン前に同じアドレスで送った分も含む)
  UPDATE public.inquiries AS q
     SET email = c_masked_email
   WHERE (q.user_id = p_user_id OR pg_catalog.lower(q.email) = ANY (v_emails))
     AND q.email <> c_masked_email;
  GET DIAGNOSTICS v_inquiries = ROW_COUNT;

  -- 3) 組織の招待: 本人のアドレス宛、または本人が受諾した招待の宛先を伏せ、まだ pending のものは revoked にする
  --    (伏せたアドレスは誰も受諾できない。revoked にしないと、受諾できない pending の招待が残り続ける)
  UPDATE public.organization_invites AS oi
     SET email      = c_masked_email,
         status     = CASE WHEN oi.status = 'pending' THEN 'revoked' ELSE oi.status END,
         revoked_at = CASE WHEN oi.status = 'pending' THEN pg_catalog.now() ELSE oi.revoked_at END
   WHERE (pg_catalog.lower(oi.email) = ANY (v_emails) OR oi.accepted_by = p_user_id)
     AND oi.email <> c_masked_email;
  GET DIAGNOSTICS v_org_invites = ROW_COUNT;

  -- 4) 家族の招待・昇格リクエスト: 同じく伏せる。先に関係する家族グループの行をロックする
  --    (CLAUDE.md「家族 (family_*) を変える関数のロック順」: 最初に family_groups、そのあとで子の行)
  PERFORM 1
     FROM public.family_groups AS g
    WHERE g.id IN (
            SELECT fi.family_id
              FROM public.family_invites AS fi
             WHERE (pg_catalog.lower(fi.email) = ANY (v_emails) OR fi.accepted_by = p_user_id)
               AND fi.email <> c_masked_email
            UNION
            SELECT fp.family_id
              FROM public.family_promotion_requests AS fp
             WHERE pg_catalog.lower(fp.email) = ANY (v_emails)
               AND fp.email <> c_masked_email
          )
    ORDER BY g.id
      FOR NO KEY UPDATE;

  UPDATE public.family_invites AS fi
     SET email      = c_masked_email,
         status     = CASE WHEN fi.status = 'pending' THEN 'revoked' ELSE fi.status END,
         revoked_at = CASE WHEN fi.status = 'pending' THEN pg_catalog.now() ELSE fi.revoked_at END
   WHERE (pg_catalog.lower(fi.email) = ANY (v_emails) OR fi.accepted_by = p_user_id)
     AND fi.email <> c_masked_email;
  GET DIAGNOSTICS v_family_invites = ROW_COUNT;

  UPDATE public.family_promotion_requests AS fp
     SET email       = c_masked_email,
         status      = CASE WHEN fp.status = 'pending' THEN 'revoked' ELSE fp.status END,
         resolved_at = CASE WHEN fp.status = 'pending' THEN pg_catalog.now() ELSE fp.resolved_at END
   WHERE pg_catalog.lower(fp.email) = ANY (v_emails)
     AND fp.email <> c_masked_email;
  GET DIAGNOSTICS v_promotions = ROW_COUNT;

  -- 5) 非公開のレシピ: 本人のものを消す。
  --    recipes.user_id は ON DELETE SET NULL で、user_id が NULL の行は RLS ("Users can view public recipes":
  --    user_id IS NULL OR is_public OR 本人) で全員に見える。退会で user_id が外れると、非公開のレシピまで全員に公開されてしまう。
  --    公開レシピ (is_public = true) は、本人が公開したもので、他の利用者のコレクション・いいね・コメントが付いていることがあるので
  --    残す (user_id だけが外れる)。recipes を指す外部キーはすべて ON DELETE CASCADE なので、消して詰まることは無い
  --    (tests/integration/security/auth-users-fk-on-delete.test.ts の E が、ここで DELETE する表を削除の起点に含めて検査する)。
  DELETE FROM public.recipes AS r
   WHERE r.user_id = p_user_id
     AND r.is_public IS NOT TRUE;
  GET DIAGNOSTICS v_private_recipes = ROW_COUNT;

  -- 件数だけを返す (メールアドレスは返さない)
  RETURN pg_catalog.jsonb_build_object(
    'email_delivery_logs', v_delivery_logs,
    'email_outbox', v_outbox,
    'inquiries', v_inquiries,
    'organization_invites', v_org_invites,
    'family_invites', v_family_invites,
    'family_promotion_requests', v_promotions,
    'private_recipes', v_private_recipes
  );
END
$function$;

REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid) TO service_role;

COMMENT ON FUNCTION public.prepare_account_deletion(uuid) IS
  '#1175: 退会の直前に呼ぶ。本人の生のメールアドレスを残す記録 (email_delivery_logs / inquiries / 組織・家族の招待 / 家族の昇格リクエスト) の宛先を伏せ、pending の招待を revoked にする。本人の非公開レシピを消す (user_id が NULL の行は全員に見えるため)。件数だけの jsonb を返す。service_role のみ。 #1193: 送信待ち (email_outbox) の本人の行 (user_id・宛先が一致) の宛先・件名・本文を伏せて queued を dead (recipient_deleted) にし (1b)、他人宛の行の件名・本文・返信先に入った本人のアドレスをその部分だけ伏せる (1c。状態は変えない)。戻り値の email_outbox は 1b と 1c の行数の和。';

-- ─────────────────────────────────────────────────────────
-- pg_cron のジョブ (§5.4。20261010150000_schedule_log_cleanup_and_dau_snapshot.sql と同じ形)
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_job RECORD;
BEGIN
  -- pg_cron が入っていない DB には cron.job が無い。ジョブは登録できないので、何もしない
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron が入っていないため、ジョブの登録を飛ばしました';
    RETURN;
  END IF;

  -- 同じ処理を呼ぶ既存のジョブ (名前は問わない) と、これから登録する名前のジョブを、先に登録解除する。
  -- command は NOTICE に載せない (秘密が入っていることがある)。
  FOR v_job IN
    SELECT jobid, jobname, schedule
    FROM cron.job
    WHERE jobname = 'cleanup-email-outbox'
       OR command ~* '[[:<:]]cleanup_email_outbox[[:>:]]'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
    RAISE NOTICE '登録済みの pg_cron のジョブを登録解除しました (同じ処理は、このあと登録するジョブが引き継ぎます): jobid=%, jobname=%, schedule=%',
      v_job.jobid, v_job.jobname, v_job.schedule;
  END LOOP;

  -- 毎日 03:20 JST (18:20 UTC。cleanup-old-app-logs の 03:15 の直後): sent は 7 日、dead は 30 日より古い email_outbox の行を消す
  PERFORM cron.schedule(
    'cleanup-email-outbox',
    '20 18 * * *',
    'SELECT public.cleanup_email_outbox();'
  );
END
$$;
