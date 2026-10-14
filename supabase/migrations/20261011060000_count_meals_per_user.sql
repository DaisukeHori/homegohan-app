-- migration: 20261011060000_count_meals_per_user.sql
-- 利用者ごとの食事の記録 (meals) の件数を DB の中で数える関数 public.count_meals_per_user() を足す (#1491)
--
-- 背景:
--   比較ランキングの集計 (Edge Function calculate-segment-stats) は、指標 total_meals (全期間の食事の記録の件数) のために、
--   meals を全期間・全件 (user_id だけ) 読み、関数の中で利用者ごとに数えていた。API は 1 回の応答を 1000 行で打ち切るので、
--   記録が増えるほど 1000 行ずつの往復が増える。集計は pg_cron が 1 時間ごとに daily / weekly / monthly の 3 本を並行して呼ぶ
--   (20261009100000_schedule_calculate_segment_stats.sql。JST 0 時台は最大 6 本) ので、そのたびに全件を読み直していた。
--   (20261009100000 の冒頭の「負荷」の説明は、この全件の読み込みを数えていない。適用済みの migration なので書き換えず、
--    ENV_SETUP.md の「比較ランキングの集計の間隔」を実装に合わせて直す)
--
-- 変更:
--   public.count_meals_per_user() を作る。meals を user_id でまとめた件数を、利用者ごとに 1 行 (user_id, meal_count) で返す。
--   Edge Function は total_meals が有効な指標のときだけ、これを呼ぶ (返る行数は記録の件数ではなく、記録のある利用者の数)。
--   数え方は以前の Edge Function と同じ (meals の全行。is_sandbox で絞らない。total_meals の値は変えない)。
--
-- 権限:
--   SECURITY INVOKER (既定)。呼ぶのは service role (RLS を通らない) だけなので、所有者の権限は要らない。
--   全利用者の件数を返すので、利用者・未ログインからは呼べないようにする:
--   PUBLIC / anon / authenticated の EXECUTE を外し、service_role にだけ EXECUTE を付ける
--   (Supabase は public の関数に anon / authenticated / service_role の EXECUTE を自動で付けるため、明示的に外す。#1103)。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE と REVOKE / GRANT)。表のデータには触れない。
-- 戻し方: supabase/rollbacks/20261011060000_count_meals_per_user.down.sql
--   (戻す前に、この関数を呼ばない版の Edge Function calculate-segment-stats をデプロイしておくこと。
--    そうしないと、total_meals が有効なときの集計が「関数が無い」で毎回失敗する)
-- 確かめるテスト: tests/integration/security/count-meals-per-user.test.ts (実 DB) と
--   tests/calculate-segment-stats-planned-meals.test.ts (Edge Function の呼び方)

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
