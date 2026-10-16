-- migration: 20261016237000_push_outbox.sql
-- #1136: Push 通知の送信待ち (push_outbox)。1 端末 (user_push_tokens の行) × 1 通知 = 1 行。
-- 登録は enqueue_push_notification (weekly_menu_requests のトリガーが呼ぶ)。送るのは GET /api/cron/push-outbox (Vercel Cron・毎分) だけ。
-- 再試行は最大 PUSH_OUTBOX_MAX_ATTEMPTS 回 (既定 3)、使い切ったら dead。Expo の receipt は送信の 15 分後から worker が確認し、行に残す。
-- 権限の考え方は 20261010123500_ops_alert_state.sql と同じ (表は service_role だけ。RPC は SECURITY INVOKER・search_path ''・EXECUTE は service_role だけ)。
-- トリガー関数だけ SECURITY DEFINER (weekly_menu_requests の書き手の権限に依らず登録する)。EXECUTE は誰にも付けない。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS / CREATE INDEX IF NOT EXISTS / DROP TRIGGER IF EXISTS。
-- 既存の行・表には触れない (user_push_tokens は参照するだけ。weekly_menu_requests にはトリガーを足すだけ)。
-- 確認: tests/integration/rls/push-outbox.test.ts / ロールバック: supabase/rollbacks/20261016237000_push_outbox.down.sql

CREATE TABLE IF NOT EXISTS public.push_outbox (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'dead')),
  -- 通知の種類 (packages/shared/src/push-notification-kinds.ts の PUSH_NOTIFICATION_KINDS)。worker が文面を作る
  kind               TEXT        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  user_id            UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- 端末の行。ログアウト・claim・release・DeviceNotRegistered で端末の行が消えたら、この行も消える
  push_token_id      UUID        NOT NULL REFERENCES public.user_push_tokens (id) ON DELETE CASCADE,
  expo_push_token    TEXT        NOT NULL CHECK (char_length(expo_push_token) BETWEEN 1 AND 256),
  -- 文面の材料 (ID と日付だけ。個人を特定する文字列は入れない)。Expo の上限 4 KiB の半分に抑える
  payload            JSONB       NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 2048),
  -- 同じ出来事で同じ端末に 2 行作らないための鍵 ('<出来事>:<端末の token>')。NULL なら重複を見ない
  dedupe_key         TEXT        CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 512),
  attempts           INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at   TIMESTAMPTZ,
  worker_id          TEXT,
  last_error_code    TEXT,
  last_error_message TEXT,
  last_status_code   INTEGER,
  sent_at            TIMESTAMPTZ,
  -- Expo の ticket の id (= receipt の id)。sent のときだけ
  receipt_id         TEXT,
  receipt_checked_at TIMESTAMPTZ,
  receipt_status     TEXT        CHECK (receipt_status IS NULL OR receipt_status IN ('ok', 'error', 'missing')),
  receipt_error      TEXT,
  dead_at            TIMESTAMPTZ,
  CONSTRAINT push_outbox_status_times CHECK (
       (status = 'queued' AND sent_at IS NULL AND dead_at IS NULL AND receipt_id IS NULL)
    OR (status = 'sent'   AND sent_at IS NOT NULL AND dead_at IS NULL AND receipt_id IS NOT NULL)
    OR (status = 'dead'   AND dead_at IS NOT NULL AND sent_at IS NULL)
  ),
  CONSTRAINT push_outbox_receipt_consistency CHECK (
    (receipt_checked_at IS NULL AND receipt_status IS NULL) OR (receipt_checked_at IS NOT NULL AND receipt_status IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_push_outbox_claim
  ON public.push_outbox (next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_push_outbox_receipt_pending
  ON public.push_outbox (sent_at) WHERE status = 'sent' AND receipt_checked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_push_outbox_sent_at
  ON public.push_outbox (sent_at) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_push_outbox_dead_at ON public.push_outbox (dead_at) WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS idx_push_outbox_user_id ON public.push_outbox (user_id);
CREATE INDEX IF NOT EXISTS idx_push_outbox_push_token_id ON public.push_outbox (push_token_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_outbox_dedupe_key
  ON public.push_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_outbox FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_outbox TO service_role;
DROP POLICY IF EXISTS push_outbox_deny_client_access ON public.push_outbox;
CREATE POLICY push_outbox_deny_client_access ON public.push_outbox
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.push_outbox IS
  '#1136: Push 通知の送信待ち。1 端末 × 1 通知 = 1 行。queued → sent / dead。service_role のみ。文面は持たず、worker が kind と payload から作る。';

-- =====================================================================
-- RPC 8 本 (すべて SECURITY INVOKER・search_path = ''・EXECUTE は service_role だけ)
-- 引数の範囲外は SQLSTATE 22023 で拒む (app_log_error_counts と同じ)。attempts は worker がその行を処理した回数 (Expo を呼ばずに dead にした回も 1 回と数える)。
-- =====================================================================

-- (1) 登録: 利用者の端末の行ごとに 1 行。端末が無ければ 0。dedupe_key は '<出来事>:<token>' にして同じ端末の重複を防ぐ
--     token の長さが push_outbox の CHECK を外れる端末の行は飛ばす (user_push_tokens はクライアントが書き、長さの CHECK が無い。
--     1 行の CHECK 違反で INSERT 全体を失敗させ、同じ利用者のほかの端末まで積めなくしない。R-24)。形の判定は worker (invalid_token)
CREATE OR REPLACE FUNCTION public.enqueue_push_notification(p_user_id uuid, p_kind text, p_payload jsonb, p_dedupe_key text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  -- push_outbox.expo_push_token の CHECK の上限と同じ (src/lib/push-tokens.ts の MAX_EXPO_PUSH_TOKEN_LENGTH。契約テストが突き合わせる)
  c_max_token_chars CONSTANT integer := 256;
  v_count integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = '22023'; END IF;
  IF p_kind IS NULL OR p_kind !~ '^[a-z][a-z0-9_]{0,63}$' THEN RAISE EXCEPTION 'p_kind must match ^[a-z][a-z0-9_]{0,63}$' USING ERRCODE = '22023'; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 2048 THEN RAISE EXCEPTION 'p_payload must be a JSON object of at most 2048 bytes' USING ERRCODE = '22023'; END IF;
  IF p_dedupe_key IS NOT NULL AND char_length(p_dedupe_key) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'p_dedupe_key must be 1..255 chars' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.push_outbox (user_id, push_token_id, expo_push_token, kind, payload, dedupe_key)
  SELECT t.user_id, t.id, t.expo_push_token, p_kind, p_payload,
         CASE WHEN p_dedupe_key IS NULL THEN NULL ELSE p_dedupe_key || ':' || t.expo_push_token END
  FROM public.user_push_tokens t
  WHERE t.user_id = p_user_id
    AND char_length(t.expo_push_token) BETWEEN 1 AND c_max_token_chars
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- (2) 取る: 送る時刻が来た queued をリースつきで取る。同時に何本来ても同じ行は 1 本だけ (SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_push_outbox(p_worker_id text, p_limit integer, p_lease_seconds integer)
RETURNS SETOF public.push_outbox LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF p_worker_id IS NULL OR char_length(p_worker_id) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'p_worker_id must be 1..128 chars' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN RAISE EXCEPTION 'p_limit must be 1..500' USING ERRCODE = '22023'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'p_lease_seconds must be 1..3600' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
    FROM public.push_outbox o
    WHERE o.status = 'queued'
      AND o.next_attempt_at <= now()
      AND (o.lease_expires_at IS NULL OR o.lease_expires_at < now())
    ORDER BY o.next_attempt_at, o.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.push_outbox o
  SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      worker_id        = p_worker_id,
      updated_at       = now()
  FROM picked
  WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

-- (3) 送れた (ticket ok): sent にして receipt の id を残す。取った worker の行で queued のときだけ (それ以外は false = ignored)
CREATE OR REPLACE FUNCTION public.complete_push_outbox(p_id uuid, p_worker_id text, p_receipt_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_receipt_id IS NULL OR char_length(p_receipt_id) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'p_receipt_id must be 1..256 chars' USING ERRCODE = '22023'; END IF;
  UPDATE public.push_outbox
  SET status = 'sent', sent_at = now(), receipt_id = p_receipt_id, attempts = attempts + 1,
      lease_expires_at = NULL, worker_id = NULL,
      last_error_code = NULL, last_error_message = NULL, last_status_code = NULL, updated_at = now()
  WHERE id = p_id AND worker_id = p_worker_id AND status = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- (4) 送れなかった: retryable かつ回数が残っていれば queued に戻して次の時刻を決める。そうでなければ dead。
--     戻り値 'requeued' / 'dead' / 'ignored' (取った worker の queued の行でない)
CREATE OR REPLACE FUNCTION public.fail_push_outbox(p_id uuid, p_worker_id text, p_error_code text, p_error_message text, p_status_code integer, p_retryable boolean, p_max_attempts integer, p_retry_after_seconds integer)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_attempts integer;
  v_dead     boolean;
BEGIN
  IF p_error_code IS NULL OR char_length(p_error_code) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'p_error_code must be 1..64 chars' USING ERRCODE = '22023'; END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 10 THEN RAISE EXCEPTION 'p_max_attempts must be 1..10' USING ERRCODE = '22023'; END IF;
  IF p_retry_after_seconds IS NULL OR p_retry_after_seconds < 0 OR p_retry_after_seconds > 86400 THEN RAISE EXCEPTION 'p_retry_after_seconds must be 0..86400' USING ERRCODE = '22023'; END IF;
  SELECT attempts + 1 INTO v_attempts
  FROM public.push_outbox
  WHERE id = p_id AND worker_id = p_worker_id AND status = 'queued'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'ignored'; END IF;
  v_dead := (NOT COALESCE(p_retryable, false)) OR v_attempts >= p_max_attempts;
  UPDATE public.push_outbox
  SET attempts = v_attempts,
      last_error_code = p_error_code,
      last_error_message = left(p_error_message, 500),
      last_status_code = p_status_code,
      lease_expires_at = NULL, worker_id = NULL, updated_at = now(),
      status = CASE WHEN v_dead THEN 'dead' ELSE 'queued' END,
      dead_at = CASE WHEN v_dead THEN now() ELSE NULL END,
      next_attempt_at = CASE WHEN v_dead THEN next_attempt_at ELSE now() + make_interval(secs => p_retry_after_seconds) END
  WHERE id = p_id;
  RETURN CASE WHEN v_dead THEN 'dead' ELSE 'requeued' END;
END;
$$;

-- (5) 延期 (夜間): queued のまま次の時刻だけを動かす。attempts は増えない。p_until は今より後・2 日以内
CREATE OR REPLACE FUNCTION public.defer_push_outbox(p_id uuid, p_worker_id text, p_until timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_until IS NULL OR p_until <= now() OR p_until > now() + interval '2 days' THEN RAISE EXCEPTION 'p_until must be in the future and within 2 days' USING ERRCODE = '22023'; END IF;
  UPDATE public.push_outbox
  SET next_attempt_at = p_until, lease_expires_at = NULL, worker_id = NULL, updated_at = now()
  WHERE id = p_id AND worker_id = p_worker_id AND status = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- (6) receipt を確かめる行を取る: sent で、まだ確かめておらず、送ってから p_min_age_seconds 以上たった行。リースつき (SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_push_receipts(p_worker_id text, p_limit integer, p_min_age_seconds integer, p_lease_seconds integer)
RETURNS SETOF public.push_outbox LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF p_worker_id IS NULL OR char_length(p_worker_id) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'p_worker_id must be 1..128 chars' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000' USING ERRCODE = '22023'; END IF;
  IF p_min_age_seconds IS NULL OR p_min_age_seconds < 0 OR p_min_age_seconds > 86400 THEN RAISE EXCEPTION 'p_min_age_seconds must be 0..86400' USING ERRCODE = '22023'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'p_lease_seconds must be 1..3600' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
    FROM public.push_outbox o
    WHERE o.status = 'sent'
      AND o.receipt_checked_at IS NULL
      AND o.sent_at <= now() - make_interval(secs => p_min_age_seconds)
      AND (o.lease_expires_at IS NULL OR o.lease_expires_at < now())
    ORDER BY o.sent_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.push_outbox o
  SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      worker_id        = p_worker_id,
      updated_at       = now()
  FROM picked
  WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

-- (7) receipt の結果を残す。p_status が NULL なら「まだ無い」(リースだけ外し、次の回でまた確かめる)
CREATE OR REPLACE FUNCTION public.record_push_receipt(p_id uuid, p_worker_id text, p_status text, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('ok', 'error', 'missing') THEN RAISE EXCEPTION 'p_status must be ok / error / missing / NULL' USING ERRCODE = '22023'; END IF;
  UPDATE public.push_outbox
  SET receipt_checked_at = CASE WHEN p_status IS NULL THEN NULL ELSE now() END,
      receipt_status = p_status,
      receipt_error = CASE WHEN p_status IS NULL THEN NULL ELSE left(p_error, 128) END,
      lease_expires_at = NULL, worker_id = NULL, updated_at = now()
  WHERE id = p_id AND worker_id = p_worker_id AND status = 'sent' AND receipt_checked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- (8) 掃除: 24 時間を超えた queued (リースの無い行) を expired の dead にし、sent は 7 日・dead は 30 日で消す。
--     worker は EXPO_ACCESS_TOKEN が無い回もこれだけは呼ぶ (R-12。鍵の無い環境で行が増え続けない)
CREATE OR REPLACE FUNCTION public.cleanup_push_outbox()
RETURNS TABLE (expired integer, sent_deleted integer, dead_deleted integer) LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  c_queued_max_age CONSTANT interval := interval '24 hours'; -- PUSH_OUTBOX_QUEUED_MAX_AGE_MS と同じ (1 日たった通知は届けても意味が薄い。契約テストが突き合わせる)
  c_sent_retention CONSTANT interval := interval '7 days';   -- receipt の確認 (24 時間) を終えた後も、数日は結果を見られるように
  c_dead_retention CONSTANT interval := interval '30 days';  -- app_logs の保持 (30 日) と同じ
  v_expired integer;
  v_sent integer;
  v_dead integer;
BEGIN
  -- リース中の行 (worker が送っている最中) には触らない。その行は worker の decideEligibility が expired にする
  UPDATE public.push_outbox
  SET status = 'dead', dead_at = now(), last_error_code = 'expired', last_error_message = 'expired',
      lease_expires_at = NULL, worker_id = NULL, updated_at = now()
  WHERE status = 'queued'
    AND created_at < now() - c_queued_max_age
    AND (lease_expires_at IS NULL OR lease_expires_at < now());
  GET DIAGNOSTICS v_expired = ROW_COUNT;
  DELETE FROM public.push_outbox WHERE status = 'sent' AND sent_at < now() - c_sent_retention;
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  DELETE FROM public.push_outbox WHERE status = 'dead' AND dead_at < now() - c_dead_retention;
  GET DIAGNOSTICS v_dead = ROW_COUNT;
  RETURN QUERY SELECT v_expired, v_sent, v_dead;
END;
$$;

-- 権限 (8 本とも同じ書き方。20261010123500_ops_alert_state.sql と同じ理由で完全形の REVOKE)
REVOKE ALL ON FUNCTION public.enqueue_push_notification(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_push_notification(uuid, text, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.claim_push_outbox(text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_push_outbox(text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.complete_push_outbox(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_push_outbox(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.fail_push_outbox(uuid, text, text, text, integer, boolean, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_push_outbox(uuid, text, text, text, integer, boolean, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.defer_push_outbox(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.defer_push_outbox(uuid, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.claim_push_receipts(text, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_push_receipts(text, integer, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.record_push_receipt(uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_push_receipt(uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_push_outbox() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_push_outbox() TO service_role;

-- =====================================================================
-- トリガー: weekly_menu_requests の最終の status → 登録
-- =====================================================================

-- 献立の依頼の最終の status (completed / failed) で、その利用者の端末に通知を積む (#1136 第 1 段の発火元)。
-- 書き手は 8 経路 (設計書 mobile/06-push-send.md §3.2.1: Edge Function generate-menu-v4 / v5・markWeeklyMenuRequestFailed・
-- process-menu-queue・claim_menu_request・止まった行の掃除・利用者の中止・手動の追加)。書き手は見分けず、行の列だけで決める:
--   積まない = failed で error_message が中止 / 止まった行の印、または target_slots の異なる date が c_min_days 日未満 (NULL を含む)。
-- 書き手の権限に依らず登録できるよう SECURITY DEFINER にする (所有者 = migration を流す postgres)。
-- 登録の失敗で献立の最終の書き込みを止めない (R-02): 例外は WARNING にして NEW を返す。
-- トリガー関数は呼び出しの権限を見ないので、EXECUTE は誰にも付けない (anon-definer-execute の番兵の対象)。
CREATE OR REPLACE FUNCTION public.enqueue_weekly_menu_result_push()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  -- 通知するのは 2 日以上にまたがる生成だけ (1 食・1 日の生成と作り直しは画面で結果を待つ操作。R-23)
  c_min_days CONSTANT integer := 2;
  -- supabase/functions/_shared/stored-failure-messages.ts の MENU_REQUEST_CANCELLED_MESSAGE / MENU_REQUEST_STALE_MESSAGE と同じ値
  -- (tests/push-outbox-migration-contract.test.ts が突き合わせる)。中止は本人の操作、止まった行の印は画面を開いたときにだけ書かれる
  c_cancelled_message CONSTANT text := '中止しました';
  c_stale_message CONSTANT text := 'stale_request_timeout';
  v_days integer;
BEGIN
  -- WHEN 句で絞ってあるが、関数だけでも同じ条件を守る
  IF NEW.status NOT IN ('completed', 'failed') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'failed' AND NEW.error_message IN (c_cancelled_message, c_stale_message) THEN RETURN NEW; END IF;
  IF NEW.target_slots IS NULL OR jsonb_typeof(NEW.target_slots) <> 'array' THEN RETURN NEW; END IF;
  SELECT count(DISTINCT s.slot ->> 'date') INTO v_days
  FROM jsonb_array_elements(NEW.target_slots) AS s(slot)
  WHERE jsonb_typeof(s.slot) = 'object';
  IF v_days < c_min_days THEN RETURN NEW; END IF;
  PERFORM public.enqueue_push_notification(
    NEW.user_id,
    CASE WHEN NEW.status = 'completed' THEN 'weekly_menu_completed' ELSE 'weekly_menu_failed' END,
    jsonb_build_object('request_id', NEW.id, 'start_date', NEW.start_date, 'mode', NEW.mode),
    'weekly_menu_result:' || NEW.id::text
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'enqueue_weekly_menu_result_push: % (request %)', SQLERRM, NEW.id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_weekly_menu_result_push() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS weekly_menu_requests_enqueue_push ON public.weekly_menu_requests;
CREATE TRIGGER weekly_menu_requests_enqueue_push
  AFTER UPDATE OF status ON public.weekly_menu_requests FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'failed'))
  EXECUTE FUNCTION public.enqueue_weekly_menu_result_push();
