-- migration: 20261009100000_schedule_calculate_segment_stats.sql
-- セグメント統計 (比較ランキング) の集計 calculate-segment-stats を、pg_cron で 1 時間ごと (毎時 5 分) に呼ぶ (#1406)
--
-- 背景:
--   比較ランキング (Web の /comparison・モバイルの比較画面) の元データ (segment_stats / user_segment_rankings /
--   user_metrics) は、Edge Function calculate-segment-stats だけが作る。ところが、この関数を定期的に呼ぶ設定が
--   どこにも無かった (vercel.json の crons・pg_cron・GitHub Actions のどれにも無い)。手動のトリガー API
--   (POST /api/comparison/trigger) も利用者の JWT で呼んでいたため、関数の認証 (requireServiceRole) で必ず 401 になっていた。
--   そのため本番では一度も集計されていない。
--
--   毎日 1 回の集計だと、「日」のランキングが集計した時刻までの記録だけで 1 日中固定されるため、1 時間ごとに集計する。
--
-- 変更:
--   1. public.calculate_segment_stats_request_bodies(p_at) を作る。時刻 p_at に送る要求の本文 (jsonb の配列) を返す:
--      - 比較画面が出す 3 つの期間の種類 (daily / weekly / monthly) について、それぞれ { periodType } を 1 つ。
--        関数は、実行した時刻 (JST) が属する直近の 1 期間だけを集計する
--        (supabase/functions/_shared/jst-date.ts の calculateJstPeriod)。過去の期間の埋め戻しはしない
--      - p_at (JST) がその種類の期間の始まりから 1 時間以内 (= 期間が切り替わった直後の回) なら、
--        { periodType, previousPeriod: true } をもう 1 つ。関数は 1 つ前の期間を集計し直す (calculateJstPreviousPeriod)。
--        1 時間ごとの集計では、期間の最後の 1 時間 (例: 日曜 23:05〜23:59) の記録が、その期間の最終の値に入らないため。
--        日・週・月の切り替わりはどれも JST 0:00 なので、JST 0 時台の回 (0:05) がこれを担う
--   2. public.invoke_calculate_segment_stats() を作る。既存の public.invoke_catalog_import() と同じ形:
--      Vault の app_cron_secret を読み、Authorization: Bearer に付けて、上の本文ごとに net.http_post で Edge Function を呼ぶ。
--      - app_cron_secret が Vault に無いときは RAISE EXCEPTION で失敗させる。pg_cron の実行履歴
--        (cron.job_run_details) に status = 'failed' と、このメッセージが残る (秘密の値は載せない)
--      - 呼び出しの応答 (HTTP の状態・本文・待ち時間切れ) は pg_net の net._http_response に残る (既定で約 6 時間)
--   3. pg_cron のジョブ calculate-segment-stats を、毎時 5 分 (UTC。JST も毎時 5 分) に登録する。
--      同じ名前のジョブと、以前の名前 calculate-segment-stats-daily (毎日 1 回だったころの名前) のジョブが
--      あれば外してから登録する (何度流しても 1 つだけになる)。
--
-- 負荷 (1 時間ごとになることを前提に):
--   - 毎時 3 つの要求 (daily / weekly / monthly) が、pg_net から並行して出る。どれも meals を自分の期間の分だけ全件読む
--     (monthly は 1 か月分)。JST 0 時台の回は、直前の期間の分が 1〜3 つ増える (日の切り替わりは毎日、週は月曜、月は 1 日)
--   - 要求ごとの書き込み先は (period_type, period_start) で分かれ、すべて upsert なので、並行しても、同じ期間を 2 回集計しても結果は同じ
--   - 応答を待つ上限 (c_timeout_ms) は 400 秒。間隔 (1 時間) より十分短いので、前の回の呼び出しと重ならない
--
-- 間隔の変え方 (利用者が増えて毎時の集計が重くなったとき):
--   SQL Editor で cron.alter_job を使う (migration を足さなくてよい)。例: 3 時間ごと
--     SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'calculate-segment-stats'),
--                           schedule := '5 */3 * * *');
--   直前の期間の集計し直しは JST 0 時台 (= UTC 15 時台) の回だけが行うので、新しい間隔にも UTC 15 時台の回を必ず含める
--   (例: '5 */3 * * *' は UTC 0,3,…,15,18,21 時なので含む。'5 */2 * * *' は含まないので不可)。
--   あわせて、モバイルの比較画面の案内 (apps/mobile/app/comparison/index.tsx の RANKING_UPDATE_INTERVAL_HOURS) も直す。
--   詳しくは ENV_SETUP.md の「比較ランキングの集計の間隔」。
--
-- 権限:
--   invoke_calculate_segment_stats は SECURITY DEFINER (所有者 postgres の権限で Vault を読む)。
--   calculate_segment_stats_request_bodies は時刻から本文を組み立てるだけで、表を読まないので SECURITY INVOKER (既定)。
--   pg_cron のジョブは、登録したロール (postgres) で動く。
--   アプリ・PostgREST から呼ばれないよう、2 つの関数とも PUBLIC / anon / authenticated / service_role の EXECUTE をすべて外す
--   (Supabase は public の関数に anon / authenticated / service_role の EXECUTE を自動で付けるため、明示的に外す。#1103)。
--   呼べるのは所有者の postgres (= pg_cron のジョブ) だけ。
--
-- 本番で必要な準備 (オーナー作業。この migration は Vault に書き込まない):
--   - Vault の app_cron_secret と、Edge Function secrets の CRON_SECRET が同じ値で登録されていること
--     (ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」。コンビニカタログの取り込みと共用)
--   - Edge Function calculate-segment-stats (previousPeriod を受け付ける版) がデプロイされていること
--
-- ロールバック: supabase/rollbacks/20261009100000_schedule_calculate_segment_stats.down.sql
--   (ジョブの登録を外し、関数を消す。集計済みの行には触れない)

CREATE OR REPLACE FUNCTION public.calculate_segment_stats_request_bodies(p_at timestamptz)
RETURNS jsonb[]
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  -- 集計する期間の種類。比較画面の選択肢と同じ (モバイル: 日・週・月、Web: 週・月)。
  -- 関数は 1 回の呼び出しで 1 種類だけを集計し、その種類の「いまの期間」(または直前の期間) 1 つだけを書く
  c_period_types CONSTANT text[] := ARRAY['daily', 'weekly', 'monthly'];
  -- 上の種類の期間の区切り (date_trunc の単位。c_period_types と同じ順)。週は月曜始まり (date_trunc の week は ISO 週)。
  -- Edge Function の calculateJstPeriod と同じ区切り
  c_period_units CONSTANT text[] := ARRAY['day', 'week', 'month'];
  -- 期間の始まりからこの時間内に動いた回が、直前の期間も集計し直す。ジョブの間隔 (1 時間) と同じにする:
  -- 短いと、期間が切り替わった直後の回がこの範囲に入らず、直前の期間の最後の記録が最終の値に入らない。
  -- 長いと、同じ直前の期間を 2 回以上集計し直す (結果は同じで、負荷が増えるだけ)
  c_finalize_window CONSTANT interval := interval '1 hour';
  -- 期間は JST の暦で区切る (Edge Function と同じ)。日本は夏時間が無いので、JST は常に UTC+9
  c_time_zone CONSTANT text := 'Asia/Tokyo';
  v_at_jst timestamp;
  v_bodies jsonb[] := ARRAY[]::jsonb[];
BEGIN
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'p_at must not be null';
  END IF;

  v_at_jst := p_at AT TIME ZONE c_time_zone;

  FOR i IN 1 .. array_length(c_period_types, 1) LOOP
    v_bodies := v_bodies || jsonb_build_object('periodType', c_period_types[i]);
    IF v_at_jst - date_trunc(c_period_units[i], v_at_jst) < c_finalize_window THEN
      v_bodies := v_bodies || jsonb_build_object('periodType', c_period_types[i], 'previousPeriod', true);
    END IF;
  END LOOP;

  RETURN v_bodies;
END;
$$;

ALTER FUNCTION public.calculate_segment_stats_request_bodies(timestamptz) OWNER TO postgres;

COMMENT ON FUNCTION public.calculate_segment_stats_request_bodies(timestamptz) IS
  '時刻 p_at に Edge Function calculate-segment-stats へ送る要求の本文の配列。daily / weekly / monthly の { periodType } と、期間が切り替わってから 1 時間以内 (JST) の種類だけ { periodType, previousPeriod: true } を足す。public.invoke_calculate_segment_stats() が使う (#1406)。';

REVOKE ALL ON FUNCTION public.calculate_segment_stats_request_bodies(timestamptz) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.invoke_calculate_segment_stats()
RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 呼び先。既存の invoke_catalog_import と同じく、本番のプロジェクトの Edge Function を指す
  -- (pg_cron のジョブから呼ぶ先を、引数で差し替えられないようにする。秘密を任意の宛先へ送らせないため #1020)
  c_url CONSTANT text := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/calculate-segment-stats';
  -- pg_net が応答を待つ上限 (ミリ秒)。Edge Function の実行時間の上限 (有料プランの wall clock 400 秒) に合わせる。
  -- 既定の 5 秒では、集計が終わる前に「待ち時間切れ」として net._http_response に記録され、成否が分からなくなる。
  -- ジョブの間隔 (1 時間) より十分短いので、前の回の呼び出しと重ならない
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
  FOREACH v_body IN ARRAY public.calculate_segment_stats_request_bodies(now()) LOOP
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

ALTER FUNCTION public.invoke_calculate_segment_stats() OWNER TO postgres;

COMMENT ON FUNCTION public.invoke_calculate_segment_stats() IS
  'セグメント統計の集計 (Edge Function calculate-segment-stats) を、public.calculate_segment_stats_request_bodies(now()) の本文ごとに呼ぶ (daily / weekly / monthly と、期間が切り替わった直後は直前の期間)。Vault の app_cron_secret を Bearer に付ける。pg_cron のジョブ calculate-segment-stats が毎時 5 分に実行する (#1406)。戻り値は pg_net の要求 ID。';

REVOKE ALL ON FUNCTION public.invoke_calculate_segment_stats() FROM PUBLIC, anon, authenticated, service_role;

-- 以前の名前 (毎日 1 回だったころ) のジョブと、同じ名前のジョブがあれば外してから登録する (何度流しても 1 つだけになる)
SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN ('calculate-segment-stats-daily', 'calculate-segment-stats');

-- 毎時 5 分 (UTC。JST も毎時 5 分。日本は夏時間が無いので、JST は常に UTC+9)。
-- 0 分ちょうどは、他の定期実行と重なりやすいので避ける。JST 0:05 の回が直前の期間も集計し直す
SELECT cron.schedule(
  'calculate-segment-stats',
  '5 * * * *',
  $$ SELECT public.invoke_calculate_segment_stats() $$
);
