-- rollback: 20261011120000_segment_stats_finalize_retry.sql
-- #1500 で足したもの (確定の回の再試行のジョブ・関数 2 本・表) を外し、public.count_meals_per_user() を
-- 20261011060000_count_meals_per_user.sql の定義 (meals の全行を数える。is_sandbox で絞らない) に戻す。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - Edge Function calculate-segment-stats (#1500 の版) は、確定の回 (previousPeriod: true) で表
--     public.segment_stats_finalized_periods を読み書きする。先に、この表を使わない版の Edge Function をデプロイしてから戻すこと。
--     先に表だけを消すと、確定の回が毎回「表が無い」で 500 になり、バッジが判定されず最終の値も入らない。
--     毎時の今の期間の回は表を使わないので影響しない。
--   - 表を消すと、確定の回をやり終えた期間の記録も消える (集計の結果の表 segment_stats / user_metrics /
--     user_segment_rankings / user_badges には触れない)。
--   - total_meals は、次の集計の回から、お試しの記録 (is_sandbox = true) も数える値に戻る。
--
-- 何度流しても同じ結果になる (cron.unschedule は登録があるときだけ・DROP ... IF EXISTS・CREATE OR REPLACE)。

SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN ('calculate-segment-stats-finalize-retry');

DROP FUNCTION IF EXISTS public.invoke_calculate_segment_stats_finalize_retry();
DROP FUNCTION IF EXISTS public.calculate_segment_stats_finalize_retry_bodies(timestamptz);

-- 表を消すと、表のポリシー (segment_stats_finalized_periods_deny_client_access) も一緒に消える
DROP TABLE IF EXISTS public.segment_stats_finalized_periods;

-- 20261011060000_count_meals_per_user.sql の定義に戻す (引数・戻り値の形は同じなので CREATE OR REPLACE で置き換えられる)
CREATE OR REPLACE FUNCTION public.count_meals_per_user()
RETURNS TABLE (user_id uuid, meal_count bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.user_id, count(*)::bigint AS meal_count
  FROM public.meals AS m
  GROUP BY m.user_id
$$;

ALTER FUNCTION public.count_meals_per_user() OWNER TO postgres;

COMMENT ON FUNCTION public.count_meals_per_user() IS
  '利用者ごとの meals の件数 (全期間・全行) を (user_id, meal_count) で返す。比較ランキングの集計 (Edge Function calculate-segment-stats) が指標 total_meals のために呼ぶ。service_role だけが実行できる (#1491)。';

REVOKE ALL ON FUNCTION public.count_meals_per_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_meals_per_user() TO service_role;
