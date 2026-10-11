-- migration: 20261011080000_app_log_error_counts_split_client.sql
-- #1493: エラー急増の運用メール (#1157) で、サーバーの error と、ブラウザ・端末から届いた error を別々に数える
--
-- 背景 (統合スイープの所見):
--   20261010123500_ops_alert_state.sql の app_log_error_counts は、app_logs を level='error' と期間だけで数え、source では絞らなかった。
--   POST /api/log (src/app/api/log/route.ts) は、ログインしていれば誰でも source='client' の error を書ける。
--   そのため、利用者が 15 分に 21 回 error を書くだけで、サーバーの障害の通知 (キー app_logs_error_spike) が鳴り、
--   その 60 分のクールダウンのあいだ、本物の障害で error が増えても同じキーの通知は送られなかった。
--
-- 変更 (追加だけ。表・列・行・索引には触れない):
--   1. public.app_log_error_counts(p_window_minutes, p_limit) を CREATE OR REPLACE で差し替える。
--      引数・戻り値・権限は同じ。数える対象に「AND l.source <> 'client'」を足し、サーバーが書いた error だけを数える
--      (app_logs.source は NOT NULL なので、<> で NULL の行を取りこぼすことは無い)。
--   2. public.app_log_client_error_counts(p_window_minutes, p_limit) を新しく作る。
--      app_log_error_counts と同じ形で、source = 'client' の error だけを数える。
--      cron (src/app/api/cron/app-log-alerts/route.ts) は、こちらを別のキー (app_logs_client_error_spike) と、
--      より高いしきい値 (src/lib/ops-alerts/app-log-error-spike.ts の APP_LOG_CLIENT_ALERT_ERROR_THRESHOLD) で判定する。
--      キーが別なので、クライアントの通知を送っても、サーバーの通知のクールダウンは始まらない。
--
-- 権限の考え方 (20261010123500 と同じ。すべて service_role だけ):
--   - SECURITY INVOKER・search_path = ''・参照はすべてスキーマ付き。
--   - Supabase は関数を作ると anon / authenticated / service_role に EXECUTE を自動で付け、PostgreSQL は PUBLIC にも付ける。
--     そのため REVOKE は FROM PUBLIC, anon, authenticated, service_role の完全形で書き、service_role にだけ GRANT し直す。
--     CREATE OR REPLACE は既存の権限を保つが、念のため差し替えた関数にも同じ REVOKE / GRANT を流し直す (冪等)。
--
-- 既存データへの影響: なし。app_logs は SELECT するだけ。使う索引は既存の idx_app_logs_created_at で、新しい索引は足さない
--   (15 分の窓は、直近の少数の行だけを読む)。
-- 適用順: 20261010123500 のあと。Web (cron の route) より先に適用されても、route は app_log_error_counts の結果が
--   クライアントの分だけ減るだけで動き続ける。Web が先にデプロイされたときは、app_log_client_error_counts が無いあいだ
--   cron は 500 を返すが、サーバーの判定 (と通知) はその前に済んでいる。
-- 冪等: CREATE OR REPLACE FUNCTION / REVOKE・GRANT / COMMENT のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/rls/ops-alert-state.test.ts (E. の節)、tests/app-log-error-counts-split-contract.test.ts
-- ロールバック: supabase/rollbacks/20261011080000_app_log_error_counts_split_client.down.sql

-- ----------------------------------------------------------------
-- (1) サーバーの error だけを数える (source <> 'client')
-- ----------------------------------------------------------------
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
  -- 窓は 1 分〜1 日、返す行数は 1〜100。範囲外は呼び出し側の誤りなので拒否する
  IF p_window_minutes IS NULL OR p_window_minutes < 1 OR p_window_minutes > 1440 THEN
    RAISE EXCEPTION 'app_log_error_counts: invalid window' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'app_log_error_counts: invalid limit' USING ERRCODE = '22023';
  END IF;

  -- total_count は LIMIT の前に全グループを合計した値 (ウィンドウ関数は LIMIT より先に評価される)。
  -- ブラウザ・端末から POST /api/log で届いたログ (source = 'client') は数えない (#1493。app_log_client_error_counts で別に数える)
  RETURN QUERY
  SELECT g.function_name,
         g.error_count,
         (pg_catalog.sum(g.error_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT l.function_name,
             pg_catalog.count(*)::BIGINT AS error_count
        FROM public.app_logs l
       WHERE l.level = 'error'
         AND l.source <> 'client'
         AND l.created_at >= pg_catalog.now() - pg_catalog.make_interval(mins => p_window_minutes)
       GROUP BY l.function_name
    ) g
   ORDER BY g.error_count DESC, g.function_name ASC
   LIMIT p_limit;
END $$;

-- ----------------------------------------------------------------
-- (2) ブラウザ・端末から届いた error だけを数える (source = 'client')
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_log_client_error_counts(
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
  -- 範囲は app_log_error_counts と同じ (窓は 1 分〜1 日、返す行数は 1〜100)
  IF p_window_minutes IS NULL OR p_window_minutes < 1 OR p_window_minutes > 1440 THEN
    RAISE EXCEPTION 'app_log_client_error_counts: invalid window' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'app_log_client_error_counts: invalid limit' USING ERRCODE = '22023';
  END IF;

  -- POST /api/log は function_name を書かないので、ふつうは NULL の 1 グループになる。
  -- 形を app_log_error_counts とそろえ、cron が同じ読み取り (parseErrorCountRows) を使えるようにしている
  RETURN QUERY
  SELECT g.function_name,
         g.error_count,
         (pg_catalog.sum(g.error_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT l.function_name,
             pg_catalog.count(*)::BIGINT AS error_count
        FROM public.app_logs l
       WHERE l.level = 'error'
         AND l.source = 'client'
         AND l.created_at >= pg_catalog.now() - pg_catalog.make_interval(mins => p_window_minutes)
       GROUP BY l.function_name
    ) g
   ORDER BY g.error_count DESC, g.function_name ASC
   LIMIT p_limit;
END $$;

-- ----------------------------------------------------------------
-- 関数の権限: service_role だけ (完全形で REVOKE してから GRANT し直す)
-- ----------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.app_log_client_error_counts(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_log_client_error_counts(INTEGER, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER) IS
  '#1157 / #1493: 直近 p_window_minutes 分の app_logs.level=error のうち、サーバーが書いたもの (source <> client) を function_name ごとに数え、多い順に p_limit 行まで返す (全体の件数 total_count 付き)。関数名と件数だけを返し、ログの本文・ユーザー ID は読まない。service_role のみ。';
COMMENT ON FUNCTION public.app_log_client_error_counts(INTEGER, INTEGER) IS
  '#1493: 直近 p_window_minutes 分の app_logs.level=error のうち、ブラウザ・端末から POST /api/log で届いたもの (source = client) を function_name ごとに数え、多い順に p_limit 行まで返す (全体の件数 total_count 付き)。関数名と件数だけを返し、ログの本文・ユーザー ID は読まない。service_role のみ。';
