-- migration: 20261016100000_purge_hidden_content.sql
-- #1538: 運営が隠したコンテンツ (#1101) を、隠してから 90 日を過ぎたら完全に消す定期のジョブ
--
-- オーナーの選択 (2026-10-15、Issue #1538 のコメント): 運営が隠したコンテンツは、90 日後に完全削除します (定期のジョブ)。
--
-- 背景:
--   運営のモデレーションの delete_* は、通報された食事 (meals) とレシピ (recipes) を消さずに「隠す」(hidden_at / hidden_by / hidden_reason。
--   migration 20261009000500_hide_moderated_content.sql)。隠した行と画像は残り続けていた。完全削除は保管期間が決まるまで作っていなかった。
--
-- 仕組み (DB だけでは消せない理由):
--   隠した行の画像 (meals.photo_url・recipes.image_url) は Storage にある。本番の storage.objects には protect_objects_delete トリガー
--   (storage.protect_delete()。supabase/baseline/catalog/catalog_auth_storage_triggers.csv) があり、SQL で行を消そうとすると拒否される。
--   画像のファイルは Storage API でしか消せないので、pg_cron から Edge Function purge-hidden-content を起こし、その中で
--   「画像を Storage API で消す → 行を消す」を行う (既存の calculate-segment-stats のジョブと同じ形)。
--   何を消し、何を消さないかは supabase/functions/_shared/hidden-content-purge.ts の冒頭に書いた。
--
-- 変更:
--   1. public.hidden_content_purge_referenced_needles(p_needles text[], p_cutoff timestamptz) を作る。
--      Edge Function が、画像を消す前に「同じオブジェクトをまだ使っている行があるか」を確かめるのに使う。
--      p_needles は、オブジェクトを指す URL に必ず含まれる部分 ('/<バケット>/<パス>') の配列。返すのは、そのうち
--      次のどれかの列の値に部分文字列として含まれているもの (含まれていれば、そのオブジェクトは消さない):
--        - meals.photo_url / recipes.image_url。ただし hidden_at が p_cutoff より前の行 (= 今回の完全削除で消える行) は数えない
--        - planned_meals.image_url と planned_meals.dishes (料理ごとの画像の URL が入る jsonb を文字列にしたもの)
--        - health_checkups.image_url・blood_test_results.report_image_url・weekly_menu_requests.inventory_image_url・
--          meal_image_jobs.result_image_url と meal_image_jobs.reference_image_urls (jsonb を文字列にしたもの)
--          (退会の Storage の掃除 src/lib/account-deletion-storage.ts が URL を集める列と同じもの + 料理の画像・参考画像)
--      部分文字列の一致なので、取りこぼすより多めに「使われている」と答える (多めに答えたときは、画像を消さずに残すだけ)。
--      表を順に全部読む (列に索引は無い)。呼ぶのは 1 日 1 回の完全削除の、対象の画像がある回だけなので、負荷は小さい。
--      SECURITY INVOKER。呼べるのは service_role (Edge Function) だけ (RLS を通らずに全員の行を見るため)。
--   2. public.invoke_purge_hidden_content() を作る。public.invoke_calculate_segment_stats() と同じ形:
--      Vault の app_cron_secret を読み、Authorization: Bearer に付けて、Edge Function purge-hidden-content を net.http_post で呼ぶ。
--      本文は空の JSON ({})。Edge Function は本文を読まず、実行した時刻から期限 (90 日前) を決める。
--      - app_cron_secret が Vault に無いときは RAISE EXCEPTION で失敗させる (cron.job_run_details に failed と、このメッセージが残る)
--      - 呼び出しの応答 (状態・本文・待ち時間切れ) は pg_net の net._http_response に残る (既定で約 6 時間)
--      SECURITY DEFINER (所有者 postgres の権限で Vault を読む)。PUBLIC / anon / authenticated / service_role の EXECUTE は外す
--      (呼べるのは所有者の postgres = pg_cron のジョブだけ。#1103)。
--   3. pg_cron のジョブ purge-hidden-content を、毎日 03:25 JST (18:25 UTC) に登録する。同じ名前のジョブがあれば外してから登録する
--      (何度流しても 1 つだけになる)。ほかの毎日のジョブ (03:10・03:15・03:45 JST) と重ならない時刻にする。
--
-- 消える行と、残る行 (外部キーの ON DELETE のとおり。退会 #1175 で食事・レシピが消えるときと同じ動き):
--   - 通報 (moderation_flags.meal_id・recipe_flags.recipe_id) は CASCADE でコンテンツと一緒に消える (誰が通報したかも消える)。
--     運営の判断の記録は admin_audit_logs (通報の ID・コンテンツの持ち主・コンテンツの ID・隠した行の ID。7 年保管) に残る。
--     外部キーは変えない: 変えると、持ち主の削除・退会でコンテンツが消えたときの動きまで変わる。
--   - 食事の AI の評価 (meal_ai_feedbacks)・栄養の推定 (meal_nutrition_estimates)・レシピのコレクションの項目・コメント・いいねは CASCADE で消える。
--   - 献立の実績 (planned_meals.actual_meal_id)・レシピの依頼 (recipe_requests.base_meal_id) は SET NULL で行が残る。
--   退会の CASCADE と矛盾しない: 持ち主が退会すると、隠した食事は auth.users の CASCADE で先に消え (画像は退会の Storage の掃除が消す)、
--   このジョブの対象から外れる。公開のまま隠したレシピは退会で user_id が外れて残り (隠したままなので誰にも見えない)、
--   90 日後にこのジョブが行を消す (持ち主の無い行の画像は消さない。本人のフォルダは退会のときに消えている)。
--
-- やらないこと (#1538 の残り):
--   - 画像ファイルを隠す (非公開にする) こと (#1365 で扱う)。
--   - #1430 より前の通報で rejected になったコンテンツを、さかのぼって隠すこと。
--   - 隠した行を元に戻す操作 (必要なときは service_role で hidden_* を NULL に戻す。戻した行は完全削除の対象から外れる)。
--
-- 本番で必要な準備 (オーナー作業。この migration は Vault に書き込まない):
--   - Vault の app_cron_secret と、Edge Function secrets の CRON_SECRET が同じ値で登録されていること (calculate-segment-stats と共用)
--   - Edge Function purge-hidden-content がデプロイされていること (GitHub Actions の Deploy Supabase Functions。
--     supabase/config.toml で verify_jwt = false)。デプロイ前にジョブが動いても、呼び出しが失敗するだけで何も消えない
--
-- 本番のデータへの影響: migration の適用では行に触れない。最初のジョブの実行 (適用の後の 03:25 JST) で、
--   隠してから 90 日を過ぎた行と画像が消える (隠した行が 90 日を過ぎるまでは、毎日のジョブは何も消さずに終わる)。
--
-- 冪等: CREATE OR REPLACE FUNCTION / REVOKE / GRANT / 同じ名前のジョブを外してから登録、なので何度流しても同じ結果になる。
-- 確認: tests/integration/security/purge-hidden-content.test.ts (89 日では消さない・91 日で消える・隠していない行は消さない・
--   画像も消える・ほかの行が使う画像と他人の画像は消さない・ジョブと権限の定義)、tests/hidden-content-purge.test.ts (単体)、
--   tests/purge-hidden-content-migration-contract.test.ts (この migration と Edge Function の突き合わせ)。
-- ロールバック: supabase/rollbacks/20261016100000_purge_hidden_content.down.sql
--   (ジョブの登録を外し、関数を消す。消えた行と画像は戻らない)
-- マージ順: migration は version の順にマージすること (この version: 20261016100000)。

-- 1. 画像のオブジェクトをまだ使っている行があるか (Edge Function purge-hidden-content が呼ぶ)
CREATE OR REPLACE FUNCTION public.hidden_content_purge_referenced_needles(p_needles text[], p_cutoff timestamptz)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(n.needle ORDER BY n.needle), ARRAY[]::text[])
  FROM (SELECT DISTINCT needle FROM unnest(p_needles) AS u(needle) WHERE needle IS NOT NULL AND needle <> '') AS n
  WHERE EXISTS (
          SELECT 1 FROM public.meals m
          WHERE (m.hidden_at IS NULL OR m.hidden_at >= p_cutoff)
            AND strpos(m.photo_url, n.needle) > 0
        )
     OR EXISTS (
          SELECT 1 FROM public.recipes r
          WHERE (r.hidden_at IS NULL OR r.hidden_at >= p_cutoff)
            AND strpos(r.image_url, n.needle) > 0
        )
     OR EXISTS (
          SELECT 1 FROM public.planned_meals pm
          WHERE strpos(pm.image_url, n.needle) > 0 OR strpos(pm.dishes::text, n.needle) > 0
        )
     OR EXISTS (SELECT 1 FROM public.health_checkups hc WHERE strpos(hc.image_url, n.needle) > 0)
     OR EXISTS (SELECT 1 FROM public.blood_test_results bt WHERE strpos(bt.report_image_url, n.needle) > 0)
     OR EXISTS (SELECT 1 FROM public.weekly_menu_requests wr WHERE strpos(wr.inventory_image_url, n.needle) > 0)
     OR EXISTS (
          SELECT 1 FROM public.meal_image_jobs mj
          WHERE strpos(mj.result_image_url, n.needle) > 0 OR strpos(mj.reference_image_urls::text, n.needle) > 0
        );
$$;

ALTER FUNCTION public.hidden_content_purge_referenced_needles(text[], timestamptz) OWNER TO postgres;

COMMENT ON FUNCTION public.hidden_content_purge_referenced_needles(text[], timestamptz) IS
  '運営が隠したコンテンツの完全削除 (#1538) が、画像を消す前に使う。p_needles (''/<バケット>/<パス>'') のうち、まだ使っている行 (隠していない行・hidden_at が p_cutoff 以後の行・献立・健診・血液検査・献立の依頼・画像生成ジョブ) の画像の URL に含まれるものを返す。Edge Function purge-hidden-content (service_role) だけが呼ぶ。';

REVOKE ALL ON FUNCTION public.hidden_content_purge_referenced_needles(text[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hidden_content_purge_referenced_needles(text[], timestamptz) TO service_role;

-- 2. Edge Function purge-hidden-content を呼ぶ (pg_cron のジョブが実行する)
CREATE OR REPLACE FUNCTION public.invoke_purge_hidden_content()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 呼び先。invoke_calculate_segment_stats と同じく、本番のプロジェクトの Edge Function に固定する
  -- (pg_cron のジョブから呼ぶ先を、引数で差し替えられないようにする。秘密を任意の宛先へ送らせないため #1020)
  c_url CONSTANT text := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/purge-hidden-content';
  -- pg_net が応答を待つ上限 (ミリ秒)。Edge Function の実行時間の上限 (有料プランの wall clock 400 秒) に合わせる。
  -- 関数は 300 秒 (HIDDEN_CONTENT_PURGE_MAX_DURATION_MS) で切り上げて結果を返すので、この上限の中で応答が届く
  c_timeout_ms CONSTANT integer := 400000;
  v_secret text;
  v_request_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'app_cron_secret'
  LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'app_cron_secret not found in Vault. Run: SELECT vault.create_secret(...) once.';
  END IF;

  SELECT net.http_post(
    url := c_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := c_timeout_ms
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

ALTER FUNCTION public.invoke_purge_hidden_content() OWNER TO postgres;

COMMENT ON FUNCTION public.invoke_purge_hidden_content() IS
  '運営が隠したコンテンツの完全削除 (Edge Function purge-hidden-content) を呼ぶ。Vault の app_cron_secret を Bearer に付ける。pg_cron のジョブ purge-hidden-content が毎日 03:25 JST に実行する (#1538)。戻り値は pg_net の要求 ID。';

REVOKE ALL ON FUNCTION public.invoke_purge_hidden_content() FROM PUBLIC, anon, authenticated, service_role;

-- 3. 同じ名前のジョブがあれば外してから登録する (何度流しても 1 つだけになる)
SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname = 'purge-hidden-content';

-- 毎日 03:25 JST (18:25 UTC。pg_cron は UTC で解釈する。日本は夏時間が無いので、JST は常に UTC+9)
SELECT cron.schedule(
  'purge-hidden-content',
  '25 18 * * *',
  $$ SELECT public.invoke_purge_hidden_content() $$
);
