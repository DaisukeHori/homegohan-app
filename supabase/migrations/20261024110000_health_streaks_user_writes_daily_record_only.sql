-- migration: 20261024110000_health_streaks_user_writes_daily_record_only.sql
-- 戻し方: supabase/rollbacks/20261024110000_health_streaks_user_writes_daily_record_only.down.sql
-- #1917: 利用者が PostgREST から health_streaks の自分の行を直接 INSERT / UPDATE でき、比較ランキングの指標
-- record_streak / breakfast_streak (連続日数) に任意の値を入れられる既存の欠陥を直す。
--
-- 背景:
--   本番のベースライン (20251126124224_create_meal_planner_tables.sql) の
--     :9783 "Users can insert own health streaks"  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)
--     :9980 "Users can update own health streaks"  FOR UPDATE TO authenticated USING / WITH CHECK (auth.uid() = user_id)
--   は streak_type を絞らない。これより後の migration で health_streaks のポリシーを変えたものは無い。
--   比較ランキングの集計 (supabase/functions/calculate-segment-stats/index.ts の fetchBulkData) は service_role で
--   streak_type = 'meal_record' / 'breakfast' の行の current_streak を全員分読み、指標 record_streak / breakfast_streak にする。
--   この 2 種類の行を書くアプリの処理は無い (同じファイルの #1528 のコメント・tests/health-streaks-sandbox-1802.test.ts)ので、
--   利用者が自分の meal_record / breakfast の行を INSERT し (または daily_record の行の streak_type を書き換え)、current_streak に
--   好きな値を入れると、その値がそのまま比較ランキングに載っていた。
--
--   health_streaks を書くアプリの処理 (origin/main で git grep した):
--     - src/lib/health-streaks.ts の updateHealthStreak だけ。利用者のセッションのクライアント (RLS が効く) で、
--       streak_type = 'daily_record' (健康の記録 health_records の連続日数) の行だけを INSERT / UPDATE する。
--       呼ぶのは POST /api/health/records・POST /api/health/records/quick・AI の相談のアクションの 3 か所
--     - DELETE /api/health/streaks: 利用者が自分の行を消す (数は進まない)。DELETE のポリシーは変えない
--     - モバイル (apps/mobile)・Edge Function は health_streaks を読むだけ
--
-- 変更 (daily_record の書き手はそのまま動き、それ以外の種類は利用者が作れず・変えられない):
--   1. INSERT のポリシー "Users can insert own health streaks" を、WITH CHECK に streak_type = 'daily_record' を足して作り直す。
--   2. UPDATE のポリシー "Users can update own health streaks" を、USING と WITH CHECK の両方に streak_type = 'daily_record' を
--      足して作り直す (USING で daily_record 以外の既存の行を対象から外し、WITH CHECK で daily_record の行の streak_type を
--      ほかの種類へ書き換えることを止める)。
--   名前・コマンド・対象のロールはベースラインと同じ。SELECT・DELETE のポリシー、表の権限、service_role は変えない
--   (service_role は RLS を通らないので、運営・集計の処理が meal_record / breakfast を書くことは今後もできる)。
--
-- 残るもの (このファイルの範囲の外):
--   - daily_record の行は、今までどおり利用者が自分で書ける (updateHealthStreak が利用者のセッションで書くため)。
--     daily_record は本人の画面 (ホーム・/health・/health/streaks・アカウントの書き出し) にだけ出て、他人の画面・比較ランキング・
--     バッジの付与には使われない。
--   - この migration より前に利用者が入れた meal_record / breakfast の行は消さない (行は変えない)。
--
-- 既存データへの影響: なし (ポリシーだけの変更。行は消さない・変えない)。
-- 冪等: DROP POLICY IF EXISTS してから作るので、2 回続けて適用してもエラーにならない。
-- ロック: DROP / CREATE POLICY は health_streaks に ACCESS EXCLUSIVE を取る。表は小さく、長い処理が走っていなければ一瞬で終わる。
-- 確認: tests/integration/rls/health-streaks-user-writes.test.ts (実 DB)
--       tests/health-streaks-user-writes-migration-contract.test.ts (静的)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261022200000 と同じ)
SET LOCAL lock_timeout = '10s';

-- 1. INSERT のポリシー
DROP POLICY IF EXISTS "Users can insert own health streaks" ON public.health_streaks;
CREATE POLICY "Users can insert own health streaks" ON public.health_streaks
  FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id) AND (streak_type = 'daily_record'));

-- 2. UPDATE のポリシー
DROP POLICY IF EXISTS "Users can update own health streaks" ON public.health_streaks;
CREATE POLICY "Users can update own health streaks" ON public.health_streaks
  FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id) AND (streak_type = 'daily_record'))
  WITH CHECK ((auth.uid() = user_id) AND (streak_type = 'daily_record'));
