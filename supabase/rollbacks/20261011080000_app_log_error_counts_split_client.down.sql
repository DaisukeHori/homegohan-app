-- rollback: 20261011080000_app_log_error_counts_split_client.sql
-- 次の 2 つを元に戻す (#1493)。
--   1. public.app_log_error_counts を 20261010123500_ops_alert_state.sql の中身に戻す (source で絞らず、level='error' を全部数える)
--   2. public.app_log_client_error_counts を削除する
--
-- 先に Web のデプロイ (GET /api/cron/app-log-alerts が app_log_client_error_counts を呼ぶ版) を戻すこと。
-- 先にこのロールバックを当てると、15 分おきの cron が app_log_client_error_counts を見つけられず、
-- OPS_ALERT_EMAIL が設定されているあいだ 500 を返し続ける (サーバーの判定と通知は、その前に済む)。
--
-- 戻したあとの動き: ブラウザ・端末から POST /api/log で届いた error も、サーバーの障害の通知 (キー app_logs_error_spike) に
--   数えられる (#1493 の前の状態)。ops_alert_state に残る app_logs_client_error_spike の行は、使われなくなるだけで害は無い
--   (消したいときは DELETE FROM public.ops_alert_state WHERE alert_key = 'app_logs_client_error_spike')。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (冪等)。

-- 1. app_log_error_counts を 20261010123500 の中身に戻す (引数・戻り値・権限は同じなので、CREATE OR REPLACE で足りる)
CREATE OR REPLACE FUNCTION public.app_log_error_counts(
  p_window_minutes INTEGER DEFAULT 15,
  p_limit          INTEGER DEFAULT 10
) RETURNS TABLE (
  function_name TEXT,
  error_count   BIGINT,
  total_count   BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_window_minutes IS NULL OR p_window_minutes < 1 OR p_window_minutes > 1440 THEN
    RAISE EXCEPTION 'app_log_error_counts: invalid window' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'app_log_error_counts: invalid limit' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT g.function_name,
         g.error_count,
         (pg_catalog.sum(g.error_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT l.function_name,
             pg_catalog.count(*)::BIGINT AS error_count
        FROM public.app_logs l
       WHERE l.level = 'error'
         AND l.created_at >= pg_catalog.now() - pg_catalog.make_interval(mins => p_window_minutes)
       GROUP BY l.function_name
    ) g
   ORDER BY g.error_count DESC, g.function_name ASC
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER) IS
  '#1157: 直近 p_window_minutes 分の app_logs.level=error を function_name ごとに数え、多い順に p_limit 行まで返す (全体の件数 total_count 付き)。関数名と件数だけを返し、ログの本文・ユーザー ID は読まない。service_role のみ。';

-- 2. クライアントの error を数える関数を消す
DROP FUNCTION IF EXISTS public.app_log_client_error_counts(INTEGER, INTEGER);
