-- migration: 20261017220000_cron_failure_monitoring.sql
-- 戻し方: supabase/rollbacks/20261017220000_cron_failure_monitoring.down.sql
-- #1125 (B) 定期処理の失敗の監視 (pg_cron の失敗した実行・Vercel Cron の route の 500) と pg_cron の停止の検知の DB 側の部品。
-- 表 1 つ (知らせた失敗の台帳) + 関数 5 本。pg_cron のジョブは登録しない・既存の行を変えない (実行履歴の掃除は別の migration: 設計 §5.3・段 D)。設計 docs/design/operator/11-ops-batches-non-billing.md §5。
-- 範囲: #1125 の (B)。課金系のバッチ (Stripe・収益・ライセンス) は、オーナーの選択「課金は無料のまま計測」により、この段では足さない (#1125 の残り)。
--
-- 背景:
--   GET /api/cron/app-log-alerts (15 分おき) に 4 つ目の種類 cron_failure と 5 つ目の種類 pg_cron_stalled を足すための DB 側の部品。
--   失敗は「まだ知らせていないもの」を数える (窓で数えない)。知らせた失敗は台帳 cron_failure_alerts に 1 失敗 = 1 行で残す
--   (operator/10 §8 の email_outbox.dead_alerted_at と同じ考え方。cron.job_run_details には列を足せないので、印を別の表に置く)。
--
-- 権限の考え方:
--   - 台帳: RLS を有効にし、どのロールにも表の権限を付けない (ops_alert_state より狭い)。入口は下の関数だけ。
--   - 関数 5 本はすべて SECURITY DEFINER (所有者 postgres)・search_path 空・参照は完全修飾・動的 SQL なし。
--     cron スキーマの権限は service_role に無いため、cron を読む関数は定義者の権限で動かす。台帳も同じ理由。
--     引数は上限つきの整数と時刻だけで、SQL に文字列を渡す引数は無い。
--   - EXECUTE: counts / mark / unmark / pg_cron_last_run_at は service_role だけ。candidates は誰にも付けない (所有者と定義者関数だけが呼ぶ)。
--     Supabase は関数を作ると anon / authenticated / service_role に EXECUTE を自動で付け、PostgreSQL は PUBLIC にも付けるので、
--     FROM PUBLIC, anon, authenticated, service_role の完全形で外してから付け直す (20261010123500 と同じ)。
--
-- 既存データへの影響: なし。表と関数の新設だけで、既存の行を変えない・消さない。pg_cron のジョブは登録しない。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS → CREATE POLICY / REVOKE・GRANT のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/cron-failure-monitoring-contract.test.ts / tests/integration/security/cron-failure-monitoring.test.ts

-- ----------------------------------------------------------------
-- (0) 台帳: 運用メールで知らせた定期処理の失敗
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cron_failure_alerts (
  source     TEXT        NOT NULL CHECK (source IN ('pg_cron', 'vercel_cron')),
  item_id    TEXT        NOT NULL,   -- pg_cron: cron.job_run_details.runid / vercel_cron: app_logs.id (uuid)
  job_name   TEXT        NOT NULL,   -- pg_cron: cron.job.jobname (無ければ 'jobid:<n>') / vercel_cron: app_logs.function_name
  failed_at  TIMESTAMPTZ NOT NULL,   -- 失敗の時刻 (start_time / created_at)
  alerted_at TIMESTAMPTZ NOT NULL,   -- 知らせた回の権利の時刻 (claim_ops_alert の戻り値)。unmark はこの値で消す
  PRIMARY KEY (source, item_id)
);
CREATE INDEX IF NOT EXISTS idx_cron_failure_alerts_alerted_at ON public.cron_failure_alerts (alerted_at);

ALTER TABLE public.cron_failure_alerts ENABLE ROW LEVEL SECURITY;
-- 入口は RPC (SECURITY DEFINER・所有者 postgres) だけ。どのロールにも表の権限を付けない (ops_alert_state より狭い)
REVOKE ALL ON public.cron_failure_alerts FROM PUBLIC, anon, authenticated, service_role;
DROP POLICY IF EXISTS cron_failure_alerts_deny_client_access ON public.cron_failure_alerts;
CREATE POLICY cron_failure_alerts_deny_client_access ON public.cron_failure_alerts
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.cron_failure_alerts IS
  '#1125 (B): 運用メールで知らせた定期処理の失敗の台帳 (1 失敗 = 1 行)。source = pg_cron は cron.job_run_details.runid、vercel_cron は app_logs.id。入口は cron_failure_counts / mark_cron_failures_alerted / unmark_cron_failures_alerted だけ。古い行の掃除は operator/11 §5.3 (段 D) の関数が受け持つ。';

-- ----------------------------------------------------------------
-- (1) 候補: 直近 7 日の失敗した実行のうち、台帳に無いもの。所有者だけが呼ぶ (2)(3) の共通部分
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cron_failure_candidates()
RETURNS TABLE (source TEXT, job_name TEXT, item_id TEXT, failed_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  -- 見る範囲。初回の適用で古い失敗をまとめて知らせない・索引の無い走査を短くする (app-log-alerts は 15 分おきに呼ぶ)。
  -- 段 D の cleanup_cron_run_history の保持 (30 日) より短いこと (消す前に数え終える。突き合わせは段 D の契約テスト)
  c_lookback CONSTANT pg_catalog.interval := interval '7 days';
  -- src/lib/api/errors.ts の INTERNAL_ERROR_LOG_MESSAGE と同じ文 (tests/cron-failure-monitoring-contract.test.ts が突き合わせる)
  c_internal_error_message CONSTANT text := '内部エラーのため 500 を返しました';
BEGIN
  IF pg_catalog.to_regclass('cron.job_run_details') IS NOT NULL THEN
    RETURN QUERY
    SELECT f.source, f.job_name, f.item_id, f.failed_at
      FROM (
        SELECT 'pg_cron'::text AS source,
               COALESCE(j.jobname::text, 'jobid:' || d.jobid::text) AS job_name,
               d.runid::text AS item_id,
               d.start_time AS failed_at
          FROM cron.job_run_details AS d
          LEFT JOIN cron.job AS j ON j.jobid = d.jobid
         WHERE d.status = 'failed'
           AND d.start_time >= pg_catalog.now() - c_lookback
        UNION ALL
        SELECT 'vercel_cron'::text, l.function_name, l.id::text, l.created_at
          FROM public.app_logs AS l
         WHERE l.level = 'error'
           AND l.source <> 'client'
           AND l.message = c_internal_error_message
           AND (l.function_name LIKE 'cron/%' OR l.function_name LIKE '% /api/cron/%')
           AND l.created_at >= pg_catalog.now() - c_lookback
      ) AS f
     WHERE NOT EXISTS (
       SELECT 1 FROM public.cron_failure_alerts AS a WHERE a.source = f.source AND a.item_id = f.item_id
     );
  ELSE
    -- pg_cron の無い DB (ローカルの一部・CI): Vercel Cron の分だけ
    RETURN QUERY
    SELECT 'vercel_cron'::text, l.function_name, l.id::text, l.created_at
      FROM public.app_logs AS l
     WHERE l.level = 'error'
       AND l.source <> 'client'
       AND l.message = c_internal_error_message
       AND (l.function_name LIKE 'cron/%' OR l.function_name LIKE '% /api/cron/%')
       AND l.created_at >= pg_catalog.now() - c_lookback
       AND NOT EXISTS (
         SELECT 1 FROM public.cron_failure_alerts AS a WHERE a.source = 'vercel_cron' AND a.item_id = l.id::text
       );
  END IF;
END $$;

-- ----------------------------------------------------------------
-- (2) 数える (名前と件数だけ。command / return_message / ログの本文は読まない)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cron_failure_counts(p_limit INTEGER DEFAULT 10)
RETURNS TABLE (source TEXT, job_name TEXT, failed_count BIGINT, total_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'cron_failure_counts: invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT g.source, g.job_name, g.failed_count, (pg_catalog.sum(g.failed_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT c.source, c.job_name, pg_catalog.count(*)::BIGINT AS failed_count
        FROM public.cron_failure_candidates() AS c
       GROUP BY c.source, c.job_name
    ) AS g
   ORDER BY g.failed_count DESC, g.source ASC, g.job_name ASC
   LIMIT p_limit;
END $$;

-- ----------------------------------------------------------------
-- (3) 知らせる失敗に印を付ける (権利を取れた回だけ呼ぶ)。候補の全部を台帳に書き、書けた行の件数を (2) と同じ形で返す
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_cron_failures_alerted(p_alerted_at TIMESTAMPTZ, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (source TEXT, job_name TEXT, failed_count BIGINT, total_count BIGINT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_alerted_at IS NULL THEN
    RAISE EXCEPTION 'mark_cron_failures_alerted: invalid alerted_at' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'mark_cron_failures_alerted: invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH ins AS (
    INSERT INTO public.cron_failure_alerts AS a (source, item_id, job_name, failed_at, alerted_at)
    SELECT c.source, c.item_id, c.job_name, c.failed_at, p_alerted_at
      FROM public.cron_failure_candidates() AS c
    ON CONFLICT (source, item_id) DO NOTHING
    RETURNING a.source, a.job_name
  ), g AS (
    SELECT ins.source, ins.job_name, pg_catalog.count(*)::BIGINT AS failed_count
      FROM ins GROUP BY ins.source, ins.job_name
  )
  SELECT g.source, g.job_name, g.failed_count, (pg_catalog.sum(g.failed_count) OVER ())::BIGINT
    FROM g
   ORDER BY g.failed_count DESC, g.source ASC, g.job_name ASC
   LIMIT p_limit;
END $$;

-- ----------------------------------------------------------------
-- (4) 送れなかったときに印を外す (p_alerted_at の行だけ)。消した行数を返す
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unmark_cron_failures_alerted(p_alerted_at TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF p_alerted_at IS NULL THEN
    RAISE EXCEPTION 'unmark_cron_failures_alerted: invalid alerted_at' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.cron_failure_alerts AS a WHERE a.alerted_at = p_alerted_at;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

-- ----------------------------------------------------------------
-- (5) pg_cron が動いているかの材料: cron スキーマの有無・有効なジョブ数・最新の実行の時刻
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pg_cron_last_run_at()
RETURNS TABLE (cron_available BOOLEAN, active_jobs INTEGER, last_run_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF pg_catalog.to_regclass('cron.job_run_details') IS NULL THEN
    RETURN QUERY SELECT false, 0, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT true,
         (SELECT pg_catalog.count(*)::INTEGER FROM cron.job AS j WHERE j.active),
         (SELECT pg_catalog.max(d.start_time) FROM cron.job_run_details AS d);
END $$;

-- ----------------------------------------------------------------
-- 権限
-- ----------------------------------------------------------------
REVOKE ALL ON FUNCTION public.cron_failure_candidates() FROM PUBLIC, anon, authenticated, service_role;
-- GRANT は付けない。所有者 (postgres) と、所有者として動く定義者関数 (2)(3) だけが呼ぶ
REVOKE ALL ON FUNCTION public.cron_failure_counts(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cron_failure_counts(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.mark_cron_failures_alerted(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_cron_failures_alerted(TIMESTAMPTZ, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.unmark_cron_failures_alerted(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unmark_cron_failures_alerted(TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.pg_cron_last_run_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pg_cron_last_run_at() TO service_role;

-- ----------------------------------------------------------------
-- コメント (何を返すか・誰が呼ぶか・個人情報を返さないこと)
-- ----------------------------------------------------------------
COMMENT ON FUNCTION public.cron_failure_candidates() IS
  '#1125 (B): 直近 7 日の定期処理の失敗 (pg_cron の failed の実行 + cron の route の 500 の app_logs) のうち、台帳に無いものを (source, job_name, item_id, failed_at) で返す。cron スキーマが無い DB では Vercel Cron の分だけ。EXECUTE はどのロールにも付けない (cron_failure_counts / mark_cron_failures_alerted が所有者として呼ぶ)。command・return_message・ログの本文・利用者の ID は返さない。';
COMMENT ON FUNCTION public.cron_failure_counts(INTEGER) IS
  '#1125 (B): 台帳に無い失敗を (source, job_name) ごとに数えて多い順に p_limit 行まで返す。どの行にも全体の件数 total_count を付ける。service_role だけが呼ぶ (GET /api/cron/app-log-alerts)。名前と件数だけを返し、command・return_message・ログの本文・利用者の ID は読み出さない。';
COMMENT ON FUNCTION public.mark_cron_failures_alerted(TIMESTAMPTZ, INTEGER) IS
  '#1125 (B): 権利 (claim_ops_alert) を取れた回に、台帳に無い失敗の全部を alerted_at = p_alerted_at で台帳に書き、書けた行を cron_failure_counts と同じ形 (件数の多い順に p_limit 行・total_count 付き) で返す。service_role だけが呼ぶ。名前と件数だけを返し、利用者の情報は扱わない。';
COMMENT ON FUNCTION public.unmark_cron_failures_alerted(TIMESTAMPTZ) IS
  '#1125 (B): メールを送れなかったときに、alerted_at = p_alerted_at の台帳の行だけを消して消した行数を返す (次の回でもう一度知らせるため)。service_role だけが呼ぶ。利用者の情報は扱わない。';
COMMENT ON FUNCTION public.pg_cron_last_run_at() IS
  '#1125 (B): pg_cron が動いているかの材料 (cron スキーマの有無 cron_available・有効なジョブ数 active_jobs・実行履歴の最新の start_time last_run_at) を 1 行で返す。cron スキーマが無ければ (false, 0, NULL)。service_role だけが呼ぶ。ジョブの command・実行の本文・利用者の情報は返さない。';
