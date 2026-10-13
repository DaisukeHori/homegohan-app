-- migration: 20261011110000_llm_usage_summary.sql
-- #1498 (#1482 の続き): 運営の LLM 使用量 (GET /api/super-admin/llm/usage) を DB の中で集計する関数 public.llm_usage_summary を足す
--
-- 背景:
--   GET /api/super-admin/llm/usage は llm_usage_logs の行を 5,000 行 (route の MAX_ROWS) まで読み、関数の中で集計していた。
--   さらに PostgREST の max_rows (Supabase の既定 1,000) でも黙って打ち切られるので、1 回の応答で集計される行は 1,000 行まで。
--   そのため、
--     - 異常使用の判定 (1 人・JST の 1 日に 5,000 回を超える。src/lib/super-admin/llm-usage-anomaly.ts) は、
--       1 人の 1 日分の行すら読み切れず、事実上成り立たなかった (異常のバナーは出ない)。
--     - 期間の合計 (リクエスト数・トークン・コスト)、モデル別・機能別・ユーザー別・日次の系列も、
--       行が 1,000 行を超える期間では実際より小さく出ていた (落ちるのは古い行)。
--
-- 変更 (追加だけ。表・列・行・索引には触れない):
--   public.llm_usage_summary(p_from, p_to_exclusive, p_model, p_function_name, p_provider, p_top_users_limit, p_anomaly_daily_requests)
--   を作る。route の条件 (is_summary = false・created_at の期間・model / function_name / provider の絞り込み) で絞った行を DB の中で集計し、
--   1 つの JSONB で返す (行の集合を返さないので、PostgREST の max_rows で打ち切られない)。
--     total_requests / total_tokens / total_cost_usd   : 期間の合計 (トークン・コストの NULL は 0 として足す。route の以前の集計と同じ)
--     by_model     : モデルごとの requests / tokens / cost_usd (requests の多い順、同数ならモデル名の順)
--     by_function  : 機能 (function_name) ごとの requests / cost_usd (requests の多い順、同数なら名前の順)
--     top_users    : ユーザーごとの requests / cost_usd の上位 p_top_users_limit 人 (requests の多い順、同数なら user_id の順。
--                    user_id が NULL の行は 1 人としてまとめ、最後に並べる)
--     timeseries   : JST の暦日ごとの requests / cost_usd (日付の昇順)
--     anomalous_users : JST の暦日の 1 日に p_anomaly_daily_requests 回を「超えて」呼んだ日があるユーザー全員
--                    (max_daily_requests = その人の 1 日あたりの最大の回数。requests / cost_usd = 期間の合計)。
--                    top_users に入らない人も返す (上位の人数で異常を取りこぼさない)
--   JST の暦日は (created_at AT TIME ZONE 'Asia/Tokyo')::date (JST 0 時が日の区切り。夏時間は無い)。
--   しきい値は route が src/lib/super-admin/llm-usage-anomaly.ts の LLM_USAGE_ANOMALY_DAILY_REQUESTS (5,000) を渡す
--   (値を 2 か所に書かない)。異常かどうかの最終の判定は findLlmUsageAnomalousUsers が同じ定数で行う。
--
-- 引数の検査 (呼び出し側の誤りなので拒否する。ERRCODE 22023 = invalid_parameter_value):
--   p_from / p_to_exclusive が NULL、または p_from >= p_to_exclusive
--   p_top_users_limit が 1〜1000 の外 (route は 50 を渡す)
--   p_anomaly_daily_requests が NULL または負
--
-- 権限 (20261011060000_count_meals_per_user.sql・20261011080000 と同じ。service_role だけ):
--   - SECURITY INVOKER・search_path = ''・参照はすべてスキーマ付き。呼ぶのは route の service role のクライアント
--     (requireRole(['super_admin']) を通ったあと) だけで、RLS を通らないので所有者の権限は要らない。
--   - 全利用者の使用量を返すので、利用者・未ログインからは呼べないようにする。Supabase は関数を作ると anon / authenticated /
--     service_role に EXECUTE を自動で付け、PostgreSQL は PUBLIC にも付ける。そのため REVOKE は FROM PUBLIC, anon, authenticated,
--     service_role の完全形で書き、service_role にだけ GRANT し直す。
--
-- 既存データへの影響: なし。llm_usage_logs は SELECT するだけ。期間の条件は既存の索引 (created_at・(model, created_at)・
--   (function_name, created_at)) が使える。新しい索引は足さない。
-- 適用順: 単独で適用できる。Web (route) より先に適用されても、以前の route は呼ばないので影響は無い。
--   Web が先にデプロイされたときは、関数が無いあいだ LLM 使用量の画面は 500 になる (以前も数字は打ち切られていた)。
-- 冪等: CREATE OR REPLACE FUNCTION / REVOKE・GRANT / COMMENT のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/llm-usage-summary.test.ts (実 DB。打ち切りの無い数え方・JST の日の区切り・しきい値の境界・権限)、
--   tests/super-admin-llm-usage-route.test.ts (route の呼び方と応答の形)、tests/llm-usage-summary-contract.test.ts (この SQL の定義)
-- ロールバック: supabase/rollbacks/20261011110000_llm_usage_summary.down.sql

CREATE OR REPLACE FUNCTION public.llm_usage_summary(
  p_from                   TIMESTAMPTZ,
  p_to_exclusive           TIMESTAMPTZ,
  p_model                  TEXT    DEFAULT NULL,
  p_function_name          TEXT    DEFAULT NULL,
  p_provider               TEXT    DEFAULT NULL,
  p_top_users_limit        INTEGER DEFAULT 50,
  p_anomaly_daily_requests INTEGER DEFAULT 5000
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_from IS NULL OR p_to_exclusive IS NULL OR p_from >= p_to_exclusive THEN
    RAISE EXCEPTION 'llm_usage_summary: invalid period' USING ERRCODE = '22023';
  END IF;
  -- 上位の人数は 1〜1000 (route は 50。応答の大きさを抑える)
  IF p_top_users_limit IS NULL OR p_top_users_limit < 1 OR p_top_users_limit > 1000 THEN
    RAISE EXCEPTION 'llm_usage_summary: invalid top users limit' USING ERRCODE = '22023';
  END IF;
  IF p_anomaly_daily_requests IS NULL OR p_anomaly_daily_requests < 0 THEN
    RAISE EXCEPTION 'llm_usage_summary: invalid anomaly threshold' USING ERRCODE = '22023';
  END IF;

  WITH base AS MATERIALIZED (
    -- Edge Function は LLM 呼び出しごとの行に加えて、1 回の実行ごとの合計行 (is_summary = true, model = 'mixed') を入れる。
    -- 合計行まで足すと二重に数えるので、呼び出しごとの行だけを集計する (route の以前の条件と同じ)
    SELECT l.model,
           l.function_name,
           l.user_id,
           (l.created_at AT TIME ZONE 'Asia/Tokyo')::DATE         AS jst_day,
           COALESCE(l.total_tokens, 0)::BIGINT                    AS tokens,
           COALESCE(l.estimated_cost_usd, 0)::NUMERIC             AS cost_usd
      FROM public.llm_usage_logs l
     WHERE l.is_summary = false
       AND l.created_at >= p_from
       AND l.created_at <  p_to_exclusive
       AND (p_model IS NULL OR l.model = p_model)
       AND (p_function_name IS NULL OR l.function_name = p_function_name)
       AND (p_provider IS NULL OR l.provider = p_provider)
  ),
  per_user AS (
    SELECT b.user_id,
           pg_catalog.count(*)::BIGINT AS requests,
           pg_catalog.sum(b.cost_usd)  AS cost_usd
      FROM base b
     GROUP BY b.user_id
  ),
  per_user_day AS (
    SELECT b.user_id,
           b.jst_day,
           pg_catalog.count(*)::BIGINT AS requests
      FROM base b
     GROUP BY b.user_id, b.jst_day
  ),
  anomalous AS (
    -- 1 日あたりの回数がしきい値を「超えた」日があるユーザー (ちょうどしきい値の日は異常にしない)
    SELECT d.user_id,
           pg_catalog.max(d.requests) AS max_daily_requests
      FROM per_user_day d
     GROUP BY d.user_id
    HAVING pg_catalog.max(d.requests) > p_anomaly_daily_requests
  ),
  top_users AS (
    SELECT u.user_id, u.requests, u.cost_usd
      FROM per_user u
     ORDER BY u.requests DESC, u.user_id ASC NULLS LAST
     LIMIT p_top_users_limit
  )
  SELECT pg_catalog.jsonb_build_object(
    'total_requests', (SELECT pg_catalog.count(*) FROM base),
    'total_tokens',   (SELECT COALESCE(pg_catalog.sum(b.tokens), 0) FROM base b),
    'total_cost_usd', (SELECT COALESCE(pg_catalog.sum(b.cost_usd), 0) FROM base b),
    'by_model', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('model', m.model, 'requests', m.requests, 'tokens', m.tokens, 'cost_usd', m.cost_usd)
               ORDER BY m.requests DESC, m.model ASC)
        FROM (
          SELECT b.model,
                 pg_catalog.count(*)::BIGINT AS requests,
                 pg_catalog.sum(b.tokens)    AS tokens,
                 pg_catalog.sum(b.cost_usd)  AS cost_usd
            FROM base b
           GROUP BY b.model
        ) m
    ), '[]'::JSONB),
    'by_function', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('function_name', f.function_name, 'requests', f.requests, 'cost_usd', f.cost_usd)
               ORDER BY f.requests DESC, f.function_name ASC)
        FROM (
          SELECT b.function_name,
                 pg_catalog.count(*)::BIGINT AS requests,
                 pg_catalog.sum(b.cost_usd)  AS cost_usd
            FROM base b
           GROUP BY b.function_name
        ) f
    ), '[]'::JSONB),
    'top_users', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('user_id', t.user_id, 'requests', t.requests, 'cost_usd', t.cost_usd)
               ORDER BY t.requests DESC, t.user_id ASC NULLS LAST)
        FROM top_users t
    ), '[]'::JSONB),
    'timeseries', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('date', s.jst_day, 'requests', s.requests, 'cost_usd', s.cost_usd)
               ORDER BY s.jst_day ASC)
        FROM (
          SELECT b.jst_day,
                 pg_catalog.count(*)::BIGINT AS requests,
                 pg_catalog.sum(b.cost_usd)  AS cost_usd
            FROM base b
           GROUP BY b.jst_day
        ) s
    ), '[]'::JSONB),
    'anomalous_users', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'user_id', a.user_id,
                 'max_daily_requests', a.max_daily_requests,
                 'requests', u.requests,
                 'cost_usd', u.cost_usd)
               ORDER BY u.requests DESC, a.user_id ASC NULLS LAST)
        FROM anomalous a
        JOIN per_user u ON u.user_id IS NOT DISTINCT FROM a.user_id
    ), '[]'::JSONB)
  )
  INTO v_result;

  RETURN v_result;
END $$;

ALTER FUNCTION public.llm_usage_summary(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER, INTEGER) OWNER TO postgres;

COMMENT ON FUNCTION public.llm_usage_summary(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER, INTEGER) IS
  '運営の LLM 使用量 (GET /api/super-admin/llm/usage) の集計を DB の中で行い、1 つの JSONB で返す (行を返さないので PostgREST の max_rows で打ち切られない)。異常使用 (JST の 1 日に p_anomaly_daily_requests 回超) のユーザーも返す。service_role だけが実行できる (#1498)。';

REVOKE ALL ON FUNCTION public.llm_usage_summary(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.llm_usage_summary(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER, INTEGER) TO service_role;
