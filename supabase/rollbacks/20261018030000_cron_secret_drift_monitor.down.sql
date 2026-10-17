-- rollback: 20261018030000_cron_secret_drift_monitor.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
-- 先に Web のデプロイ (GET /api/cron/app-log-alerts の cron_secret_drift / cron_secret_rotation の確認。段 C) を戻すこと。
-- 先にこのロールバックを当てると、段 C の route が関数 (cron_secret_probe_results など) を見つけられず、OPS_ALERT_EMAIL が設定されているあいだ 500 を返し続ける。
-- 消えるもの: 関数 3 本と表 public.cron_secret_probes (確認の記録。戻らない。消えても、次の回が「確認をまだ送っていない」から始め直すだけで、害は無い)。
-- 触れないもの: Edge Function cron-secret-probe (段 A)・ops_alert_state の cron_secret_drift / cron_secret_rotation の行 (次の claim_ops_alert で上書きされるだけ)・
--   net._http_response の行 (読むだけで、変えていない)・pg_cron のジョブ (この migration は登録しない)。
-- 何度流しても同じ結果になる (冪等)。表のポリシー・索引・権限・コメントは表と一緒に消えるので、個別には消さない。
DROP FUNCTION IF EXISTS public.cron_secret_probe_results(INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.cron_secret_probe_body_json(TEXT);
DROP FUNCTION IF EXISTS public.send_cron_secret_probe();
DROP TABLE IF EXISTS public.cron_secret_probes;
