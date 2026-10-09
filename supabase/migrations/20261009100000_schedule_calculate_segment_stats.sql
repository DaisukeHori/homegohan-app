-- migration: 20261009100000_schedule_calculate_segment_stats.sql
-- セグメント統計 (比較ランキング) の集計 calculate-segment-stats を、pg_cron で毎日 JST 4:00 (UTC 19:00) に呼ぶ (#1406)
--
-- 背景:
--   比較ランキング (Web の /comparison・モバイルの比較画面) の元データ (segment_stats / user_segment_rankings /
--   user_metrics) は、Edge Function calculate-segment-stats だけが作る。ところが、この関数を定期的に呼ぶ設定が
--   どこにも無かった (vercel.json の crons・pg_cron・GitHub Actions のどれにも無い)。手動のトリガー API
--   (POST /api/comparison/trigger) も利用者の JWT で呼んでいたため、関数の認証 (requireServiceRole) で必ず 401 になっていた。
--   そのため本番では一度も集計されていない。
--
-- 変更:
--   1. public.invoke_calculate_segment_stats() を作る。既存の public.invoke_catalog_import() と同じ形:
--      Vault の app_cron_secret を読み、Authorization: Bearer に付けて、net.http_post で Edge Function を呼ぶ。
--      - app_cron_secret が Vault に無いときは RAISE EXCEPTION で失敗させる。pg_cron の実行履歴
--        (cron.job_run_details) に status = 'failed' と、このメッセージが残る (秘密の値は載せない)
--      - 呼び出しの応答 (HTTP の状態・本文・待ち時間切れ) は pg_net の net._http_response に残る
--      - 集計する期間の種類は、比較画面が出す 3 つ (daily / weekly / monthly)。1 種類ごとに 1 回呼ぶ
--        (関数は 1 回の呼び出しで 1 種類だけを集計する)
--      - 本文に渡すのは periodType だけ。関数は、実行した時刻 (JST) が属する直近の 1 期間だけを集計する
--        (supabase/functions/_shared/jst-date.ts の calculateJstPeriod)。過去の期間の埋め戻しはしない
--   2. pg_cron のジョブ calculate-segment-stats-daily を、毎日 UTC 19:00 (= JST 4:00) に登録する。
--      同じ名前のジョブが既にあれば、登録し直す (何度流しても 1 つだけになる)。
--
-- 権限:
--   関数は SECURITY DEFINER (所有者 postgres の権限で Vault を読む)。pg_cron のジョブは、登録したロール (postgres) で動く。
--   アプリ・PostgREST から呼ばれないよう、PUBLIC / anon / authenticated / service_role の EXECUTE をすべて外す
--   (Supabase は public の関数に anon / authenticated / service_role の EXECUTE を自動で付けるため、明示的に外す。#1103)。
--   呼べるのは所有者の postgres (= pg_cron のジョブ) だけ。
--
-- 本番で必要な準備 (オーナー作業。この migration は Vault に書き込まない):
--   - Vault の app_cron_secret と、Edge Function secrets の CRON_SECRET が同じ値で登録されていること
--     (ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」。コンビニカタログの取り込みと共用)
--   - Edge Function calculate-segment-stats がデプロイされていること
--
-- ロールバック: supabase/rollbacks/20261009100000_schedule_calculate_segment_stats.down.sql
--   (ジョブの登録を外し、関数を消す。集計済みの行には触れない)

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
  -- 集計する期間の種類。比較画面の選択肢と同じ (モバイル: 日・週・月、Web: 週・月)。
  -- 関数は 1 回の呼び出しで 1 種類だけを集計し、その種類の「いまの期間」1 つだけを書く
  c_period_types CONSTANT text[] := ARRAY['daily', 'weekly', 'monthly'];
  -- pg_net が応答を待つ上限 (ミリ秒)。Edge Function の実行時間の上限 (有料プランの wall clock 400 秒) に合わせる。
  -- 既定の 5 秒では、集計が終わる前に「待ち時間切れ」として net._http_response に記録され、成否が分からなくなる
  c_timeout_ms CONSTANT integer := 400000;
  v_secret text;
  v_period_type text;
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

  FOREACH v_period_type IN ARRAY c_period_types LOOP
    SELECT net.http_post(
      url := c_url,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_secret,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('periodType', v_period_type),
      timeout_milliseconds := c_timeout_ms
    ) INTO v_request_id;
    v_request_ids := v_request_ids || v_request_id;
  END LOOP;

  RETURN v_request_ids;
END;
$$;

ALTER FUNCTION public.invoke_calculate_segment_stats() OWNER TO postgres;

COMMENT ON FUNCTION public.invoke_calculate_segment_stats() IS
  'セグメント統計の集計 (Edge Function calculate-segment-stats) を、daily / weekly / monthly の 3 種類について呼ぶ。Vault の app_cron_secret を Bearer に付ける。pg_cron のジョブ calculate-segment-stats-daily が毎日 UTC 19:00 (JST 4:00) に実行する (#1406)。戻り値は pg_net の要求 ID。';

REVOKE ALL ON FUNCTION public.invoke_calculate_segment_stats() FROM PUBLIC, anon, authenticated, service_role;

-- 同じ名前のジョブがあれば外してから登録する (何度流しても 1 つだけになる)
SELECT cron.unschedule('calculate-segment-stats-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'calculate-segment-stats-daily');

-- 毎日 UTC 19:00 = JST 4:00 (日本は夏時間が無いので、JST は常に UTC+9)
SELECT cron.schedule(
  'calculate-segment-stats-daily',
  '0 19 * * *',
  $$ SELECT public.invoke_calculate_segment_stats() $$
);
