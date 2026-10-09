-- rollback: 20261008200900_ops_alert_state.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 先に Web のデプロイ (GET /api/cron/app-log-alerts と vercel.json の cron) を戻すこと。
-- 先にこのロールバックを当てると、15 分おきの cron が関数 (app_log_error_counts など) を見つけられず、
-- OPS_ALERT_EMAIL が設定されているあいだ 500 を返し続ける (OPS_ALERT_EMAIL が未設定なら、DB に触れず何も起きない)。
--
-- 消えるもの: ops_alert_state の行 (「最後にアラートを送った時刻」だけ。業務のデータは無い)。
--   消えると、次にしきい値を超えたときにクールダウン (60 分) を待たずに 1 通送られるだけで、害は無い。
-- 触れないもの: app_logs (SELECT しかしていないので、戻すものは無い)。
--
-- 何度流しても同じ結果になる (冪等)。表のポリシー・権限・コメントは表と一緒に消えるので、個別には消さない
-- (表が無い状態で DROP POLICY IF EXISTS ... ON <表> を流すとエラーになるため)。

DROP FUNCTION IF EXISTS public.release_ops_alert(TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.claim_ops_alert(TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.app_log_error_counts(INTEGER, INTEGER);
DROP TABLE IF EXISTS public.ops_alert_state;
