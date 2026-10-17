-- rollback: 20261018020000_cleanup_cron_run_history.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 消えるもの: pg_cron のジョブ cleanup-cron-run-history の登録と、関数 public.cleanup_cron_run_history()。
-- 触れないもの: 台帳 public.cron_failure_alerts と cron.job_run_details の行 (この rollback は行を消さない・変えない)。
--   ジョブがすでに消した古い実行履歴と台帳の行は戻らない。ジョブを外したあとは、実行履歴と台帳が再び消えずに増える。
-- 段 A (20261017220000_cron_failure_monitoring) の rollback より先に流す (この関数が台帳を参照するため。この rollback のあとなら、段 A の rollback は台帳を消せる)。
--
-- 何度流しても同じ結果になる (冪等)。

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  PERFORM cron.unschedule(j.jobid)
     FROM cron.job AS j
    WHERE j.jobname = 'cleanup-cron-run-history';
END
$$;

DROP FUNCTION IF EXISTS public.cleanup_cron_run_history();
