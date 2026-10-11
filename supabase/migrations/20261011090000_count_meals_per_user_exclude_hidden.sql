-- migration: 20261011090000_count_meals_per_user_exclude_hidden.sql
-- 比較ランキングの集計 (指標 total_meals) で、運営が隠した食事 (meals.hidden_at が入った行) を数えないようにする (#1445)
--
-- 背景:
--   #1101 (migration 20261009000500_hide_moderated_content.sql) で、運営が違反コンテンツを「隠す」ようになった
--   (行は消さず hidden_at を入れ、本人以外には RLS で見えなくする)。
--   public.count_meals_per_user() (migration 20261011060000) は service role が呼ぶ集計用の関数で、RLS を通らないため、
--   隠した食事も件数に数えていた。隠した食事が他の利用者と比べるランキングの件数に入るのは、隠した趣旨に合わない。
--   Edge Function calculate-segment-stats の期間内の meals の読み込みも、同じ変更で hidden_at IS NULL に絞る。
--
-- 変更:
--   public.count_meals_per_user() を CREATE OR REPLACE し、meals のうち hidden_at IS NULL の行だけを数える。
--   返す形 (user_id, meal_count) と、並び・権限 (service_role だけが EXECUTE) は変えない。
--   隠した食事しかない利用者の行は返らない (記録の無い利用者と同じ扱い。集計側は 0 として扱う)。
--
-- 権限:
--   CREATE OR REPLACE は既存の EXECUTE の権限を保つが、念のため 20261011060000 と同じ REVOKE / GRANT を流し直す。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE と REVOKE / GRANT)。表のデータには触れない。
-- 戻し方: supabase/rollbacks/20261011090000_count_meals_per_user_exclude_hidden.down.sql
--   (隠した行も数える 20261011060000 の定義に戻す)
-- 確かめるテスト: tests/integration/security/count-meals-per-user.test.ts (実 DB)

CREATE OR REPLACE FUNCTION public.count_meals_per_user()
RETURNS TABLE (user_id uuid, meal_count bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.user_id, count(*)::bigint AS meal_count
  FROM public.meals AS m
  WHERE m.hidden_at IS NULL
  GROUP BY m.user_id
$$;

ALTER FUNCTION public.count_meals_per_user() OWNER TO postgres;

COMMENT ON FUNCTION public.count_meals_per_user() IS
  '利用者ごとの meals の件数 (全期間。運営が隠した行 (hidden_at が入った行) は数えない) を (user_id, meal_count) で返す。比較ランキングの集計 (Edge Function calculate-segment-stats) が指標 total_meals のために呼ぶ。service_role だけが実行できる (#1491 / #1445)。';

REVOKE ALL ON FUNCTION public.count_meals_per_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_meals_per_user() TO service_role;
