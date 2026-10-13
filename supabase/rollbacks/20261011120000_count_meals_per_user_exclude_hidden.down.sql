-- rollback: 20261011120000_count_meals_per_user_exclude_hidden.sql
-- public.count_meals_per_user() を、運営が隠した行も数える 20261011060000_count_meals_per_user.sql の定義に戻す (#1445)。
-- 表のデータには触れない。関数は消さない (Edge Function calculate-segment-stats が指標 total_meals のために呼ぶため)。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、指標 total_meals の件数に、運営が隠した食事がまた入る。
--     Edge Function の期間内の meals の読み込み (hidden_at IS NULL で絞る) はそのままなので、ほかの指標には影響しない。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE と REVOKE / GRANT)。

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
