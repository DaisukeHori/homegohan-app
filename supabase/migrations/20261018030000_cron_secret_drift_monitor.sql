-- migration: 20261018030000_cron_secret_drift_monitor.sql
-- 戻し方: supabase/rollbacks/20261018030000_cron_secret_drift_monitor.down.sql
-- #1560 (項目 8) cron の共有シークレットのずれの自動・定期の検知の DB 側の部品。設計 docs/design/operator/12-cron-secret-drift-monitor.md §5。
-- 表 1 つ (送った確認の記録) + 関数 3 本。pg_cron のジョブは登録しない・既存の行を変えない・消さない (消すのは自分の表の 24 時間より古い行だけ)。
-- 注意: このファイルのコメントに、pg_net の呼び出しの形 (関数名に開きかっこを続けた形) と Edge Function の URL の途中の経路
--       (functions のあとの v1) を書かない。tests/edge-function-verify-jwt.test.ts が生の文字列で数え、宣言の数 (2) と突き合わせるため。
CREATE TABLE IF NOT EXISTS public.cron_secret_probes (
  id           BIGSERIAL   PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),   -- 送った (または送れなかった) 時刻
  send_state   TEXT        NOT NULL CHECK (send_state IN ('sent', 'vault_missing', 'vault_empty', 'vault_unreadable', 'vault_unavailable', 'net_unavailable')),
  request_id   BIGINT      NULL UNIQUE                           -- pg_net の要求 ID (send_state = 'sent' のときだけ)。net._http_response.id と同じ値
);
CREATE INDEX IF NOT EXISTS idx_cron_secret_probes_requested_at ON public.cron_secret_probes (requested_at);

ALTER TABLE public.cron_secret_probes ENABLE ROW LEVEL SECURITY;
-- 入口は RPC (SECURITY DEFINER・所有者 postgres) だけ。どのロールにも表の権限を付けない (cron_failure_alerts と同じ)
REVOKE ALL ON public.cron_secret_probes FROM PUBLIC, anon, authenticated, service_role;
DROP POLICY IF EXISTS cron_secret_probes_deny_client_access ON public.cron_secret_probes;
CREATE POLICY cron_secret_probes_deny_client_access ON public.cron_secret_probes
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.cron_secret_probes IS
  '#1560: cron の共有シークレットの確認 (Vault の app_cron_secret で Edge Function cron-secret-probe を呼ぶ) の記録 (1 確認 = 1 行)。値もダイジェストも持たない (時刻・送れたか・pg_net の要求 ID だけ)。入口は send_cron_secret_probe / cron_secret_probe_results だけ。24 時間より古い行は send_cron_secret_probe が消す。';

-- (1) 確認を送る。GET /api/cron/app-log-alerts が毎回 1 回呼ぶ (service_role)。
--     24 時間より古い記録を消す → 送れる状態かを見る → 記録を 1 行書く → 送れるなら pg_net で Edge Function を呼び、要求 ID を記録に書く。
--     値 (v_secret) は Authorization ヘッダーに付けるだけで、戻り値・記録・例外の文に入れない。
CREATE OR REPLACE FUNCTION public.send_cron_secret_probe()
RETURNS TABLE (probe_id BIGINT, send_state TEXT, request_id BIGINT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  -- 呼び先。既存の invoke_calculate_segment_stats と同じく本番のプロジェクトの Edge Function に固定する (引数で差し替えられない。秘密を任意の宛先へ送らせない #1020)
  c_url CONSTANT text := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/cron-secret-probe';
  -- pg_net が応答を待つ上限 (ミリ秒)。確認の Edge Function は照合しか行わないので、既定の 5 秒より少し長い 15 秒で足りる
  -- (アプリ側の猶予 CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES = 5 分より十分短いこと。契約テストが突き合わせる)
  c_timeout_ms CONSTANT integer := 15000;
  -- 記録の保持。見る範囲 (アプリの CRON_SECRET_PROBE_LOOKBACK_MINUTES = 60 分) と pg_net の応答の保持 (既定 6 時間) より長く、表を小さく保つ
  c_retention CONSTANT pg_catalog.interval := interval '24 hours';
  -- pg_cron の関数が読む Vault の名前 (scripts/lib/cron-secret-drift.mjs の VAULT_SECRET_NAME と同じ)
  c_vault_secret_name CONSTANT text := 'app_cron_secret';
  v_secret text;
  v_state text;
  v_probe_id bigint;
  v_request_id bigint;
BEGIN
  DELETE FROM public.cron_secret_probes AS p WHERE p.requested_at < pg_catalog.now() - c_retention;

  IF pg_catalog.to_regclass('net._http_response') IS NULL THEN
    -- pg_net の無い DB (ローカルの一部・CI)。送れないことを記録して返す (例外にしない)
    v_state := 'net_unavailable';
  ELSIF pg_catalog.to_regclass('vault.decrypted_secrets') IS NULL THEN
    v_state := 'vault_unavailable';
  ELSE
    -- 本番の Vault (supabase_vault 0.3.1) の decrypted_secrets は C の関数 vault._crypto_aead_det_decrypt で復号するので、復号の失敗は NULL ではなく例外になりうる (設計 §16 の 5)。
    -- 例外にしない (R-16) ため、読み取りだけを内側のブロックで受けて vault_unreadable にする。例外の文 (SQLERRM) は使わない・残さない
    BEGIN
      SELECT s.decrypted_secret INTO v_secret
        FROM vault.decrypted_secrets AS s
       WHERE s.name = c_vault_secret_name
       LIMIT 1;
      IF NOT FOUND THEN
        v_state := 'vault_missing';
      ELSIF v_secret IS NULL THEN
        v_state := 'vault_unreadable';   -- 行はあるが復号の結果が無い
      ELSIF v_secret = '' THEN
        v_state := 'vault_empty';
      ELSE
        v_state := 'sent';
      END IF;
    EXCEPTION WHEN others THEN
      v_secret := NULL;
      v_state := 'vault_unreadable';     -- 行はあるが復号できない (例外)
    END;
  END IF;

  INSERT INTO public.cron_secret_probes (send_state) VALUES (v_state) RETURNING id INTO v_probe_id;

  IF v_state = 'sent' THEN
    SELECT net.http_post(
      url := c_url,
      headers := pg_catalog.jsonb_build_object(
        'Authorization', 'Bearer ' || v_secret,
        'Content-Type', 'application/json'
      ),
      body := pg_catalog.jsonb_build_object('probe_id', v_probe_id),
      timeout_milliseconds := c_timeout_ms
    ) INTO v_request_id;
    UPDATE public.cron_secret_probes AS p SET request_id = v_request_id WHERE p.id = v_probe_id;
  END IF;

  RETURN QUERY SELECT v_probe_id, v_state, v_request_id;
END $$;

-- (3) 応答の本文を JSON として読む補助。JSON でなければ NULL (例外にしない)。(2) だけが使う
CREATE OR REPLACE FUNCTION public.cron_secret_probe_body_json(p_content TEXT)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_content IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN p_content::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- (2) 確認の結果。見る範囲 (p_lookback_minutes) の記録に net._http_response を要求 ID で突き合わせ、判定に要る項目だけを新しい順に返す。
--     応答の本文は matched / previous_configured / alias_used / error / code の 5 項目だけを、各 64 字までで返す。headers と error_msg の本文は返さない。
--     応答の無い行は、answered が false で、応答に由来する項目 (http_status / timed_out / has_error / 本文の 5 項目) はすべて NULL (「エラーなし」とは区別する)。
CREATE OR REPLACE FUNCTION public.cron_secret_probe_results(p_lookback_minutes INTEGER DEFAULT 60, p_limit INTEGER DEFAULT 8)
RETURNS TABLE (
  probe_id BIGINT, requested_at TIMESTAMPTZ, send_state TEXT, answered BOOLEAN,
  http_status INTEGER, timed_out BOOLEAN, has_error BOOLEAN,
  matched TEXT, previous_configured BOOLEAN, alias_used BOOLEAN, body_error TEXT, body_code TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  -- 見る範囲の下限と上限 (分)。下限は app-log-alerts の間隔 (15 分)、上限は pg_net の応答の保持 (既定 6 時間 = 360 分)
  c_lookback_min CONSTANT integer := 15;
  c_lookback_max CONSTANT integer := 360;
  c_limit_max CONSTANT integer := 50;
  -- 本文の項目を返す長さの上限。想定の値 (current / previous / service_role_key / Unauthorized / Service not configured / UNAUTHORIZED_INVALID_JWT_FORMAT) はどれも 64 字より短い
  c_body_field_max_length CONSTANT integer := 64;
BEGIN
  IF p_lookback_minutes IS NULL OR p_lookback_minutes < c_lookback_min OR p_lookback_minutes > c_lookback_max THEN
    RAISE EXCEPTION 'cron_secret_probe_results: invalid lookback' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > c_limit_max THEN
    RAISE EXCEPTION 'cron_secret_probe_results: invalid limit' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.to_regclass('net._http_response') IS NOT NULL THEN
    RETURN QUERY
    SELECT p.id, p.requested_at, p.send_state,
           (r.id IS NOT NULL),
           r.status_code, r.timed_out, CASE WHEN r.id IS NOT NULL THEN (r.error_msg IS NOT NULL) END,
           pg_catalog.left(b.body ->> 'matched', c_body_field_max_length),
           CASE WHEN pg_catalog.jsonb_typeof(b.body -> 'previous_configured') = 'boolean' THEN (b.body ->> 'previous_configured')::boolean END,
           CASE WHEN pg_catalog.jsonb_typeof(b.body -> 'alias_used') = 'boolean' THEN (b.body ->> 'alias_used')::boolean END,
           pg_catalog.left(b.body ->> 'error', c_body_field_max_length),
           pg_catalog.left(b.body ->> 'code', c_body_field_max_length)
      FROM public.cron_secret_probes AS p
      LEFT JOIN net._http_response AS r ON r.id = p.request_id
      LEFT JOIN LATERAL (SELECT public.cron_secret_probe_body_json(r.content) AS body) AS b ON true
     WHERE p.requested_at >= pg_catalog.now() - pg_catalog.make_interval(mins => p_lookback_minutes)
     ORDER BY p.requested_at DESC, p.id DESC
     LIMIT p_limit;
  ELSE
    -- pg_net の無い DB: 記録だけを返す (応答は無い)
    RETURN QUERY
    SELECT p.id, p.requested_at, p.send_state, false,
           NULL::integer, NULL::boolean, NULL::boolean,
           NULL::text, NULL::boolean, NULL::boolean, NULL::text, NULL::text
      FROM public.cron_secret_probes AS p
     WHERE p.requested_at >= pg_catalog.now() - pg_catalog.make_interval(mins => p_lookback_minutes)
     ORDER BY p.requested_at DESC, p.id DESC
     LIMIT p_limit;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.send_cron_secret_probe() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_cron_secret_probe() TO service_role;
REVOKE ALL ON FUNCTION public.cron_secret_probe_results(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cron_secret_probe_results(INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.cron_secret_probe_body_json(TEXT) FROM PUBLIC, anon, authenticated, service_role;
-- GRANT は付けない。所有者 (postgres) と、所有者として動く定義者関数 (2) だけが呼ぶ

COMMENT ON FUNCTION public.send_cron_secret_probe() IS
  '#1560: cron の共有シークレットの確認を 1 回送る。24 時間より古い記録を消し、Vault の app_cron_secret を Authorization ヘッダーに付けて Edge Function cron-secret-probe を pg_net で呼び、記録に要求 ID を書く。戻り値は (probe_id, send_state, request_id) だけ。値もダイジェストも返さない・記録しない。呼ぶのは GET /api/cron/app-log-alerts (service_role) だけ。';

COMMENT ON FUNCTION public.cron_secret_probe_results(INTEGER, INTEGER) IS
  '#1560: cron の共有シークレットの確認の結果。見る範囲の記録に net._http_response を要求 ID で突き合わせ、判定に要る項目 (状態コード・時間切れ・エラーの有無・本文の matched / previous_configured / alias_used / error / code を 64 字まで) だけを新しい順に返す。headers と error_msg の本文は返さない。呼ぶのは GET /api/cron/app-log-alerts (service_role) だけ。';

COMMENT ON FUNCTION public.cron_secret_probe_body_json(TEXT) IS
  '#1560: 確認の応答の本文を JSON として読む補助。JSON でなければ NULL (例外にしない)。cron_secret_probe_results だけが使う。どのロールにも EXECUTE を付けない。値もダイジェストも返さない。';
