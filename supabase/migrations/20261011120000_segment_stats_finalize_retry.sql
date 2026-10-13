-- migration: 20261011120000_segment_stats_finalize_retry.sql
-- 比較ランキングの集計 (Edge Function calculate-segment-stats) の残り (#1500。#1491 の続き)
--
-- 背景:
--   1. ハンズオン (チュートリアル) のお試しの記録 (meals.is_sandbox = true) を、指標 total_meals の件数
--      (public.count_meals_per_user) が数えていた。planned_meals (user_daily_meals.is_sandbox = false で絞る) や
--      GET /api/badges (お試しの記録を数えない) と扱いが食い違い、お試しの記録 1 件だけで total_meals が 0 を超える。
--      ほかの人が全員 0 なら、その人に取り消されないバッジ (1 位など) が付く筋道があった。
--      (Edge Function の期間内の meals の読み込みも同じく絞っていなかった。こちらは Edge Function の側で直す)
--   2. 確定の回 (期間が切り替わった直後の JST 0:05 の回。previousPeriod: true) は 1 期間に 1 回だけで、
--      pg_net の待ち時間切れや Edge Function の 500 で失敗すると、その期間のバッジが一度も判定されず、
--      最終の値も入らない (#1491 までは、毎時の回が代わりにバッジを判定していた)。
--
-- 変更:
--   1. public.count_meals_per_user() を作り直す (CREATE OR REPLACE。引数・戻り値の形は同じ)。
--      meals のうち is_sandbox = false の行だけを数える。お試しの記録だけを持つ利用者の行は返らない (= total_meals は 0)。
--      絞り込みは既存の部分索引 idx_meals_user_non_sandbox (user_id, eaten_at DESC) WHERE is_sandbox = false と同じ条件。
--   2. 表 public.segment_stats_finalized_periods を足す。確定の回をやり終えた期間 (種類・開始日) を 1 行ずつ覚える。
--      Edge Function は、確定の回の最後 (バッジの判定のあと) にここへ書き、確定の回の最初にここを見て、
--      行があれば何も読まず何も書かずに 200 を返す (二度目以降の確定の回は何もしない)。service_role だけが読み書きできる。
--      行は 1 日に 1〜3 行 (日は毎日、週は月曜、月は 1 日) しか増えないので、消す仕組みは置かない。
--   3. public.calculate_segment_stats_finalize_retry_bodies(p_at) を足す。
--      public.calculate_segment_stats_request_bodies(p_at) のうち、確定の回の本文 ({ periodType, previousPeriod: true }) だけを返す
--      (期間が切り替わってから 1 時間以内の種類だけ。それ以外の時刻は空)。
--   4. public.invoke_calculate_segment_stats_finalize_retry() を足す。上の本文 (時刻は now()) ごとに、
--      public.invoke_calculate_segment_stats() と同じ呼び先・同じ秘密の読み方 (Vault の app_cron_secret を Bearer に付ける)・
--      同じ待ち時間の上限で Edge Function を呼ぶ。今の期間の本文は送らない (毎時の回がすでに送っている)。
--   5. pg_cron のジョブ calculate-segment-stats-finalize-retry を、JST 0:20 と 0:35 (UTC 15:20 と 15:35) に登録する。
--      確定の回 (JST 0:05) を、同じ窓の中で 2 回まで再試行する。0:05 の回が成功していれば、Edge Function は 2 の記録を見て何もしない。
--      時刻の決め方:
--        - 間隔 15 分 = Edge Function の実行時間の上限 (wall clock 400 秒。呼び出しの待ち時間の上限 c_timeout_ms と同じ) より長くする。
--          前の試みがまだ動いている間に次の試みを始めない (同じ期間を 2 本並行して集計しない)
--        - 最後の試み (0:35) も、期間が切り替わってから 1 時間 (c_finalize_window) の窓の中。窓の外では
--          calculate_segment_stats_finalize_retry_bodies が空を返し、何も送らない
--        - 毎時 5 分の回 (ジョブ calculate-segment-stats) と、カタログ取り込みの回 (UTC 3:00〜4:00) に重ならない
--
-- 3 回とも失敗したときの知らせ:
--   この migration では新しい通知の仕組みを作らない。運用メール (#1157 の app_logs のエラー急増) は、15 分の窓で
--   error が 20 件を超えたときだけ送るので、この 3 回の失敗だけでは届かない。失敗は、Edge Function の 500 なら
--   app_logs (function_name = calculate-segment-stats) に、待ち時間切れなら net._http_response に残る
--   (確かめ方は ENV_SETUP.md の「比較ランキングの集計が動いているかの確かめ方」)。
--
-- 権限:
--   - count_meals_per_user: 変えない (SECURITY INVOKER。PUBLIC / anon / authenticated から EXECUTE を外し、service_role にだけ付ける。
--     CREATE OR REPLACE は権限を保つが、何度流しても同じになるよう付け直す)。
--   - segment_stats_finalized_periods: RLS を有効にし、anon / authenticated には権限を付けず、全拒否のポリシーも置く
--     (20261010123500_ops_alert_state.sql と同じ形)。service_role に SELECT / INSERT / UPDATE / DELETE だけ付ける。
--   - calculate_segment_stats_finalize_retry_bodies: 時刻から本文を組み立てるだけで、表を読まないので SECURITY INVOKER (既定)。
--   - invoke_calculate_segment_stats_finalize_retry: SECURITY DEFINER (所有者 postgres の権限で Vault を読む)。
--   - 2 つの関数とも、アプリ・PostgREST から呼ばれないよう、PUBLIC / anon / authenticated / service_role の EXECUTE をすべて外す
--     (Supabase は public の関数に anon / authenticated / service_role の EXECUTE を自動で付けるため、明示的に外す。#1103)。
--     呼べるのは所有者の postgres (= pg_cron のジョブ) だけ。
--
-- 既存データへの影響: 表のデータの更新・削除はしない。total_meals の値は、次の集計の回から、お試しの記録を数えない値になる。
-- 適用の順: 新しい表を読む Edge Function calculate-segment-stats は、この migration を流したあとにデプロイする
--   (先にデプロイすると、確定の回が「表が無い」で 500 になる。毎時の今の期間の回は表を読まないので影響しない)。
--   この migration だけを先に流しても、古い Edge Function は表を読まず、再試行の回 (0:20・0:35) で同じ期間を集計し直すだけ
--   (バッジは ignoreDuplicates なので 2 つは付かない)。
-- 冪等: CREATE OR REPLACE / CREATE TABLE IF NOT EXISTS / DROP POLICY IF EXISTS → CREATE POLICY / REVOKE・GRANT、
--   ジョブは同じ名前のジョブを外してから登録するので、何度流しても同じ結果になる。
-- 確かめるテスト:
--   tests/segment-stats-finalize-retry-contract.test.ts (ファイルどうしの突き合わせ。DB 無し)
--   tests/integration/security/segment-stats-finalize-retry.test.ts (実 DB: ジョブ・本文・権限・表)
--   tests/integration/security/count-meals-per-user.test.ts (実 DB: お試しの記録を数えない)
--   tests/integration/rls/stats-edge-functions-user-daily-meals.test.ts (実 DB で Edge Function: お試しの記録だけの人にバッジが付かない・確定の回の 2 回目は何もしない)
-- ロールバック: supabase/rollbacks/20261011120000_segment_stats_finalize_retry.down.sql

-- ----------------------------------------------------------------
-- (1) total_meals の件数: お試しの記録 (is_sandbox = true) を数えない
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.count_meals_per_user()
RETURNS TABLE (user_id uuid, meal_count bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.user_id, count(*)::bigint AS meal_count
  FROM public.meals AS m
  WHERE m.is_sandbox = false
  GROUP BY m.user_id
$$;

ALTER FUNCTION public.count_meals_per_user() OWNER TO postgres;

COMMENT ON FUNCTION public.count_meals_per_user() IS
  '利用者ごとの meals の件数 (全期間。ハンズオンのお試しの記録 is_sandbox = true は数えない) を (user_id, meal_count) で返す。比較ランキングの集計 (Edge Function calculate-segment-stats) が指標 total_meals のために呼ぶ。service_role だけが実行できる (#1491 / #1500)。';

REVOKE ALL ON FUNCTION public.count_meals_per_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_meals_per_user() TO service_role;

-- ----------------------------------------------------------------
-- (2) 確定の回をやり終えた期間
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.segment_stats_finalized_periods (
  period_type  TEXT        NOT NULL,
  period_start DATE        NOT NULL,
  period_end   DATE        NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (period_type, period_start)
);

ALTER TABLE public.segment_stats_finalized_periods ENABLE ROW LEVEL SECURITY;

-- Supabase の default privileges は CREATE TABLE の時点で anon / authenticated / service_role にテーブル権限を自動で付ける。
-- REVOKE FROM PUBLIC だけでは外れないので、ロール個別に完全形で REVOKE してから service_role にだけ付け直す。
REVOKE ALL ON public.segment_stats_finalized_periods FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.segment_stats_finalized_periods TO service_role;

-- 上の REVOKE で anon / authenticated は 42501 (権限エラー) になる。多層防御として、ポリシーでも全拒否を明示する
-- (service_role は BYPASSRLS のため影響を受けない)。
DROP POLICY IF EXISTS segment_stats_finalized_periods_deny_client_access ON public.segment_stats_finalized_periods;
CREATE POLICY segment_stats_finalized_periods_deny_client_access ON public.segment_stats_finalized_periods
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.segment_stats_finalized_periods IS
  '#1500: 比較ランキングの確定の回 (Edge Function calculate-segment-stats の previousPeriod: true) をやり終えた期間。行がある期間への確定の回の再試行は、何も読まず何も書かない。service_role のみ。';
COMMENT ON COLUMN public.segment_stats_finalized_periods.period_type IS
  '期間の種類 (daily / weekly / monthly)。segment_stats.period_type と同じ値';
COMMENT ON COLUMN public.segment_stats_finalized_periods.period_start IS
  '期間の開始日 (JST の暦日)。segment_stats.period_start と同じ値';
COMMENT ON COLUMN public.segment_stats_finalized_periods.period_end IS
  '期間の終了日 (JST の暦日。この日を含む)';
COMMENT ON COLUMN public.segment_stats_finalized_periods.finalized_at IS
  '確定の回を最初にやり終えた時刻。やり直したいときは、この行を消してから確定の回を呼ぶ (ENV_SETUP.md)';

-- ----------------------------------------------------------------
-- (3) 再試行の回に送る本文 (確定の回の本文だけ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_segment_stats_finalize_retry_bodies(p_at timestamptz)
RETURNS jsonb[]
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_body jsonb;
  v_bodies jsonb[] := ARRAY[]::jsonb[];
BEGIN
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'p_at must not be null';
  END IF;

  -- 毎時の回と同じ本文の配列から、確定の回 (previousPeriod: true) の本文だけを残す。
  -- 期間が切り替わってから c_finalize_window (1 時間) を過ぎた時刻では、確定の回の本文が無いので空になる
  FOREACH v_body IN ARRAY public.calculate_segment_stats_request_bodies(p_at) LOOP
    IF (v_body ->> 'previousPeriod')::boolean IS TRUE THEN
      v_bodies := v_bodies || v_body;
    END IF;
  END LOOP;

  RETURN v_bodies;
END;
$$;

ALTER FUNCTION public.calculate_segment_stats_finalize_retry_bodies(timestamptz) OWNER TO postgres;

COMMENT ON FUNCTION public.calculate_segment_stats_finalize_retry_bodies(timestamptz) IS
  '時刻 p_at に、確定の回の再試行として Edge Function calculate-segment-stats へ送る本文の配列。public.calculate_segment_stats_request_bodies(p_at) のうち { periodType, previousPeriod: true } だけ。public.invoke_calculate_segment_stats_finalize_retry() が使う (#1500)。';

REVOKE ALL ON FUNCTION public.calculate_segment_stats_finalize_retry_bodies(timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- ----------------------------------------------------------------
-- (4) 再試行の回の呼び出し
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoke_calculate_segment_stats_finalize_retry()
RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 呼び先。public.invoke_calculate_segment_stats と同じ (本番のプロジェクトの Edge Function)。
  -- pg_cron のジョブから呼ぶ先を、引数で差し替えられないようにする (秘密を任意の宛先へ送らせないため #1020)
  c_url CONSTANT text := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/calculate-segment-stats';
  -- pg_net が応答を待つ上限 (ミリ秒)。public.invoke_calculate_segment_stats と同じ。
  -- Edge Function の実行時間の上限 (有料プランの wall clock 400 秒) に合わせる。再試行の間隔 (15 分) より短い
  c_timeout_ms CONSTANT integer := 400000;
  v_secret text;
  v_body jsonb;
  v_request_id bigint;
  v_request_ids bigint[] := ARRAY[]::bigint[];
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'app_cron_secret'
  LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'app_cron_secret not found in Vault. Run: SELECT vault.create_secret(...) once.';
  END IF;

  -- now() はトランザクションの開始時刻 (= ジョブが動いた時刻)
  FOREACH v_body IN ARRAY public.calculate_segment_stats_finalize_retry_bodies(now()) LOOP
    SELECT net.http_post(
      url := c_url,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_secret,
        'Content-Type', 'application/json'
      ),
      body := v_body,
      timeout_milliseconds := c_timeout_ms
    ) INTO v_request_id;
    v_request_ids := v_request_ids || v_request_id;
  END LOOP;

  RETURN v_request_ids;
END;
$$;

ALTER FUNCTION public.invoke_calculate_segment_stats_finalize_retry() OWNER TO postgres;

COMMENT ON FUNCTION public.invoke_calculate_segment_stats_finalize_retry() IS
  '確定の回 (期間が切り替わった直後の JST 0:05) の再試行。public.calculate_segment_stats_finalize_retry_bodies(now()) の本文ごとに Edge Function calculate-segment-stats を呼ぶ。Vault の app_cron_secret を Bearer に付ける。pg_cron のジョブ calculate-segment-stats-finalize-retry が JST 0:20 と 0:35 に実行する。確定の回をやり終えた期間なら、Edge Function は何もしない (#1500)。戻り値は pg_net の要求 ID。';

REVOKE ALL ON FUNCTION public.invoke_calculate_segment_stats_finalize_retry() FROM PUBLIC, anon, authenticated, service_role;

-- ----------------------------------------------------------------
-- (5) pg_cron のジョブ
-- ----------------------------------------------------------------
-- 同じ名前のジョブがあれば外してから登録する (何度流しても 1 つだけになる)
SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN ('calculate-segment-stats-finalize-retry');

-- UTC 15:20 と 15:35 = JST 0:20 と 0:35 (日本は夏時間が無いので、JST は常に UTC+9)。
-- 確定の回 (毎時 5 分のジョブの JST 0:05 の回) から 15 分おきに 2 回。理由は冒頭の「時刻の決め方」
SELECT cron.schedule(
  'calculate-segment-stats-finalize-retry',
  '20,35 15 * * *',
  $$ SELECT public.invoke_calculate_segment_stats_finalize_retry() $$
);
