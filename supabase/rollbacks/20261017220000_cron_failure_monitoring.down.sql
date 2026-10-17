-- rollback: 20261017220000_cron_failure_monitoring.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 先に Web のデプロイ (GET /api/cron/app-log-alerts の cron_failure / pg_cron_stalled の確認。段 B) を戻すこと。
-- 先にこのロールバックを当てると、段 B の route が関数 (cron_failure_counts など) を見つけられず、OPS_ALERT_EMAIL が設定されているあいだ 500 を返し続ける。
--
-- 消えるもの: 関数 5 本と台帳 public.cron_failure_alerts (知らせた失敗の記録。戻らない。消えると、7 日以内の失敗が次の回でもう一度知らされるだけで、害は無い)。
-- 触れないもの: pg_cron のジョブ (この migration は登録しない)・ops_alert_state の cron_failure / pg_cron_stalled の行 (次の claim_ops_alert で上書きされるだけ)・
--   cron.job_run_details と app_logs の行 (読むだけで、変えていない)。
-- 段 D (cleanup_cron_run_history) が当たっている DB では、段 D の down.sql を先に流す (段 D の関数が台帳を参照するため)。
--
-- 何度流しても同じ結果になる (冪等)。表のポリシー・索引・権限・コメントは表と一緒に消えるので、個別には消さない。

DROP FUNCTION IF EXISTS public.pg_cron_last_run_at();
DROP FUNCTION IF EXISTS public.unmark_cron_failures_alerted(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.mark_cron_failures_alerted(TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.cron_failure_counts(INTEGER);
DROP FUNCTION IF EXISTS public.cron_failure_candidates();
DROP TABLE IF EXISTS public.cron_failure_alerts;
