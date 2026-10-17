-- migration: 20261018020000_cleanup_cron_run_history.sql
-- 戻し方: supabase/rollbacks/20261018020000_cleanup_cron_run_history.down.sql
-- #1125 (B) pg_cron の実行履歴 (cron.job_run_details) と、失敗の監視の台帳 (cron_failure_alerts) を 30 日で消す。設計 docs/design/operator/11-ops-batches-non-billing.md §5.3 (段 D)。
-- この migration を当てた後の最初の 03:35 JST の実行で、30 日より古い既存の実行履歴 (本番には 2026-05-01 からの行が残っている) が消える。消した行は戻らない。
--
-- 背景:
--   Supabase は cron.job_run_details を自動では消さない (5 分おきのジョブ 2 本 (#1561) だけで 1 日に約 576 行増える)。
--   失敗の監視 (20261017220000_cron_failure_monitoring.sql) の台帳 cron_failure_alerts も、掃除する仕組みを持たない (この migration の関数が受け持つ)。
--
-- 変更:
--   1. public.cleanup_cron_run_history() を新設する。30 日より古い cron.job_run_details の行と、alerted_at が 30 日より古い台帳の行を消し、
--      消した件数 (run_details_deleted, alerts_deleted) を返す。
--   2. pg_cron のジョブ cleanup-cron-run-history を登録する (時刻は UTC。pg_cron の cron.timezone は GMT)。
--        cleanup-cron-run-history   35 18 * * *   毎日 03:35 JST   SELECT public.cleanup_cron_run_history();
--      登録の前に、同じ名前のジョブと、同じ関数を呼ぶジョブを登録解除するので、何度流しても同じ結果になる。
--
-- 設計上の判断:
--   - 保持 30 日は app_logs と同じ (オーナーの確認 (2026-10-17))。失敗の監視が見る範囲 (cron_failure_candidates の c_lookback = 7 日) より長いので、
--     失敗を数え終える前に実行履歴が消えることは無い (tests/cron-run-history-cleanup-contract.test.ts が 2 つの値を突き合わせる)。
--   - 終わっていない行 (end_time が NULL のまま worker が落ちた) は start_time で判断する。
--   - SECURITY DEFINER (所有者 postgres)。cron スキーマと台帳に表の権限があるのは所有者だけ (service_role には無い)。SET search_path = ''、参照は完全修飾、動的 SQL なし。
--     引数は無い。返すのは件数だけ (個人情報は返さない)。
--   - EXECUTE は誰にも付けない (所有者 postgres = pg_cron だけが呼ぶ。20261015180000 の invoke_process_meal_image_jobs と同じ形)。
--     Supabase は関数を作ると anon / authenticated / service_role に EXECUTE を自動で付け、PostgreSQL は PUBLIC にも付けるので、
--     FROM PUBLIC, anon, authenticated, service_role の完全形で外す。
--   - pg_cron が入っていない DB (cron スキーマが無い) では、実行履歴の掃除を飛ばし、台帳だけ掃除する。ジョブの登録も飛ばす。
--   - ジョブの command に秘密は入らないが、既存のジョブを探して消すときに command が見えるので、実行ログ (NOTICE) には載せない。載せるのは jobid / jobname / schedule だけ。
--
-- 既存データへの影響:
--   - この migration を流しただけでは、行は 1 行も消えない (関数の追加とジョブの登録だけ)。
--   - 登録したジョブの最初の実行 (適用後の次の 03:35 JST) で、30 日より古い cron.job_run_details の行と、30 日より古い台帳の行が消える。以降は毎日、その日に 30 日を超えた分が消える。
--   - 登録解除するのは、同じ名前か同じ関数を呼ぶジョブだけ (通常は無い)。
--
-- 冪等: CREATE OR REPLACE FUNCTION / REVOKE / COMMENT は何度流しても同じ結果になる。ジョブは、流すたびに登録解除して登録し直す (jobid は変わる)。
-- 適用順: 失敗の監視 (20261017220000) の後 (台帳 cron_failure_alerts を参照する)。コードの変更は無い。
-- 確認: tests/cron-run-history-cleanup-contract.test.ts / tests/integration/security/cron-run-history-cleanup.test.ts

-- ----------------------------------------------------------------
-- 1. 30 日より古い実行履歴と台帳を消す。pg_cron が毎日呼ぶ
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_cron_run_history()
RETURNS TABLE (run_details_deleted INTEGER, alerts_deleted INTEGER)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  -- 保持。app_logs の 30 日と同じ。失敗の監視が見る範囲 (cron_failure_candidates の c_lookback = 7 日) より長い (消す前に数え終える)
  c_retention CONSTANT pg_catalog.interval := interval '30 days';
  v_runs   INTEGER := 0;
  v_alerts INTEGER := 0;
BEGIN
  IF pg_catalog.to_regclass('cron.job_run_details') IS NOT NULL THEN
    -- 終わっていない行 (end_time が NULL のまま worker が落ちた) は start_time で判断する
    DELETE FROM cron.job_run_details AS d
     WHERE COALESCE(d.end_time, d.start_time) < pg_catalog.now() - c_retention;
    GET DIAGNOSTICS v_runs = ROW_COUNT;
  END IF;
  DELETE FROM public.cron_failure_alerts AS a WHERE a.alerted_at < pg_catalog.now() - c_retention;
  GET DIAGNOSTICS v_alerts = ROW_COUNT;
  RETURN QUERY SELECT v_runs, v_alerts;
END $$;

REVOKE ALL ON FUNCTION public.cleanup_cron_run_history() FROM PUBLIC, anon, authenticated, service_role;
-- GRANT は付けない。所有者 (postgres = pg_cron) だけが呼ぶ

COMMENT ON FUNCTION public.cleanup_cron_run_history() IS
  '#1125 (B): 30 日より古い pg_cron の実行履歴 (cron.job_run_details。end_time が無い行は start_time で判断) と、失敗の監視の台帳 (cron_failure_alerts。alerted_at が 30 日より古い行) を消し、消した件数 (run_details_deleted, alerts_deleted) を返す。pg_cron のジョブ cleanup-cron-run-history が毎日 03:35 JST (18:35 UTC) に呼ぶ。EXECUTE は誰にも付けない (所有者 postgres = pg_cron だけ)。個人情報は返さない。設計 operator/11 §5.3。';

-- ----------------------------------------------------------------
-- 2. pg_cron のジョブ
-- ----------------------------------------------------------------
DO $$
DECLARE
  v_job RECORD;
BEGIN
  -- pg_cron が入っていない DB には cron.job が無い。ジョブは登録できないので、何もしない
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron が入っていないため、ジョブの登録を飛ばしました';
    RETURN;
  END IF;

  -- 同じ名前のジョブと、同じ関数を呼ぶジョブ (名前は問わない) を先に登録解除する。登録解除できるのは postgres が作ったジョブだけ。
  -- command は NOTICE に載せない (秘密が入っていることがある)。
  FOR v_job IN
    SELECT jobid, jobname, schedule
    FROM cron.job
    WHERE jobname = 'cleanup-cron-run-history'
       OR command ~* '[[:<:]]cleanup_cron_run_history[[:>:]]'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
    RAISE NOTICE '登録済みの pg_cron のジョブを登録解除しました: jobid=%, jobname=%, schedule=%', v_job.jobid, v_job.jobname, v_job.schedule;
  END LOOP;

  -- 毎日 03:35 JST (18:35 UTC): 30 日より古い実行履歴と台帳を消す。03:35 は既存の夜間のジョブ (03:10・03:15・03:20・03:25・03:45・03:55 JST) と重ならない
  PERFORM cron.schedule(
    'cleanup-cron-run-history',
    '35 18 * * *',
    'SELECT public.cleanup_cron_run_history();'
  );
END
$$;
