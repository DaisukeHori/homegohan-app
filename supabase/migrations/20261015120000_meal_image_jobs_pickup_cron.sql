-- migration: 20261015120000_meal_image_jobs_pickup_cron.sql
-- #1561: 料理画像のジョブ (meal_image_jobs) の、待ちのまま残ったジョブと処理中のまま止まったジョブを、pg_cron で定期に拾い直す
--
-- 背景 (#1532 の整合ゲートの残り):
--   1. ジョブを積んだ入口 (Next.js の API ルート・Edge の saveMealToDb・積み直しの道具) は、積んだ直後に
--      Edge Function process-meal-image-jobs を起こす (triggerMealImageJobProcessing)。この呼び出しが失敗すると
--      (送れない・401・503 など)、ジョブは pending のまま残り、定期的に拾う仕組みが無かった。
--   2. process-meal-image-jobs はジョブを processing にして貸し出し (lease_token・leased_until。2 分) をつけてから処理する。
--      途中で関数の実行が打ち切られると、ジョブは processing のまま残り、取り戻す処理が無かった。
--      冪等キーの一意な索引 meal_image_jobs_idempotency_pending_idx は pending と processing の行が対象の部分索引なので、
--      同じ料理を保存し直しても、積み直しの道具を流しても、重複 (23505) になって積み直せなかった。
--
-- 変更 (表・列・索引は変えない):
--   1. public.requeue_stale_meal_image_jobs(p_now timestamptz DEFAULT now())  SECURITY DEFINER / service_role と所有者だけが実行できる
--        processing のまま、貸し出しの期限 (leased_until。無ければ updated_at) から c_stale_grace (5 分) より長く過ぎたジョブを取り戻す。
--        取り戻すたびに attempt_count を 1 足す (止まった試みを 1 回と数える)。足した回数が c_max_attempts (3 回) に届いたら failed、
--        届かなければ pending に戻す (貸し出しは外す)。last_error に 'lease expired' で始まる理由を書く。
--        failed にしたジョブの料理は、献立の上でまだ生成中 (image_status = 'pending') で、同じ料理 (image_subject_hash がジョブと同じ) の
--        ときだけ、image_status = 'failed' + image_error = ジョブの last_error にする (画面に「生成中」のまま残さない。
--        画像の処理が失敗にしたときと同じ形。process-meal-image-jobs の markDishFailure)。
--   2. public.invoke_process_meal_image_jobs()  SECURITY DEFINER / 所有者 (postgres = pg_cron のジョブ) だけが実行できる
--        待ち (pending) のジョブのうち、最後の更新から c_min_pending_age (1 分) を過ぎたものが 1 件でもあれば、
--        Vault の app_cron_secret を Authorization: Bearer に付けて、process-meal-image-jobs を 1 回呼ぶ (本文 { "limit": 5 })。
--        既存の public.invoke_calculate_segment_stats と同じ形 (呼び先は本番の URL に固定。pg_net の net 拡張で送る)。
--        - 待ちのジョブが無ければ何も送らない (Vault も読まない)。数分ごとに空の呼び出しを出さない
--        - 積んだ直後のジョブ (1 分以内) は数えない。入口が積んだ直後に起こす処理と取り合わないようにする
--        - app_cron_secret が Vault に無いときは RAISE EXCEPTION で失敗させる。pg_cron の実行履歴 (cron.job_run_details) に
--          status = 'failed' とこのメッセージが残る (秘密の値は載せない)
--        - Edge Function secrets の CRON_SECRET が未設定のあいだ (#1406 のオーナー作業) は、関数が 503 (Service not configured) を
--          返し、ジョブは pending のまま残る (呼び出しの応答は pg_net の net._http_response に残る)。設定されれば動く
--   3. pg_cron のジョブ 2 つ (pg_cron が無い DB では登録しない):
--        requeue-stale-meal-image-jobs    5 分ごと (毎時 0, 5, 10, ... 分)  SELECT public.requeue_stale_meal_image_jobs()
--        process-pending-meal-image-jobs  5 分ごと (毎時 2, 7, 12, ... 分)  SELECT public.invoke_process_meal_image_jobs()
--      取り戻し (秘密を使わない SQL だけの処理) と呼び出し (Vault の秘密が要る) を別のジョブにするのは、秘密が無くて呼び出しが例外で
--      失敗しても、取り戻しのほうはロールバックされずに動くようにするため (1 つのジョブの command は 1 つのトランザクションになる)。
--      呼び出しは取り戻しの 2 分後に動く。取り戻して pending に戻したジョブ (updated_at = 取り戻した時刻) が、c_min_pending_age を過ぎて拾われる。
--      同じ名前のジョブがあれば外してから登録する (何度流しても 1 つずつになる)。
--
-- 時間の決め方:
--   - c_stale_grace (5 分): process-meal-image-jobs はジョブを取るときに 2 分の貸し出しをつける (index.ts の JOB_LEASE_MS)。
--     関数は 1 回の実行の中でジョブを 1 件ずつ取るので、生きているワーカーがジョブを持ち続けられるのは、取ってから
--     Edge Function の実行時間の上限 (有料プランの wall clock 400 秒) まで。貸し出しの期限 (取ってから 120 秒) から 5 分 (300 秒) 待てば、
--     取ってから 420 秒で、生きているワーカーのジョブを取り戻すことは無い (tests/meal-image-jobs-pickup-cron-contract.test.ts が数を突き合わせる)。
--   - c_max_attempts (3 回): 止まった試みを 2 回までやり直す。同じジョブが毎回打ち切られる (画像の生成が重すぎる等) なら、3 回で諦めて failed にし、
--     料理を失敗の印にする (いつまでも生成中のまま・画像の生成に送り続けることをしない)。
--   - c_batch_limit (5 件): 1 回の呼び出しで処理する件数。process-meal-image-jobs の既定の件数と同じ。1 件ずつ順に画像を作るので、
--     5 件 × 数十秒が実行時間の上限 (400 秒) に収まる。5 分ごとなら 1 時間に 60 件まで拾える (入口が積んだ直後に起こす分は別)。
--   - c_timeout_ms (60 秒): pg_net が応答を待つ上限。process-meal-image-jobs はジョブを読んだあとすぐ 202 を返し、処理は裏で続ける
--     (EdgeRuntime.waitUntil) ので、起動の遅れを含めても 60 秒で足りる。ジョブの間隔 (5 分) より短く、前の回と重ならない。
--   間隔を変えたいときは、SQL Editor で cron.alter_job を使う (migration を足さなくてよい)。例: 呼び出しを 10 分ごとに
--     SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'process-pending-meal-image-jobs'),
--                           schedule := '2-59/10 * * * *');
--
-- 冪等の部分索引 (meal_image_jobs_idempotency_pending_idx) は変えない:
--   処理中のジョブを索引から外すと、同じ料理のジョブを 2 つ同時に処理して、画像を 2 回作れてしまう (処理中の行が重複を止めている)。
--   止まったジョブがいつまでも processing で索引をふさいでいたのが詰まりの原因なので、それを取り戻せば (pending に戻せば、
--   保存し直しは重複として数えられ、待ちのジョブとして拾われる。failed にすれば索引から外れ、保存し直しで積み直せる) 解ける。
--
-- 同時に動いたとき:
--   - 取り戻しは pg_advisory_xact_lock で 1 本ずつにし、行は FOR UPDATE SKIP LOCKED で取る (ワーカーが同じ行を書いている最中なら飛ばす)。
--   - 取り戻すときに lease_token を外すので、万一まだ生きていたワーカーが後で終わらせようとしても (finalizeJob は lease_token が同じ行にだけ書く)、
--     その書き込みは 0 行になり、取り戻した状態を上書きしない。
--   - 料理の失敗の印は、1 件ずつ別の UPDATE で書く (同じ献立の料理が 2 つ以上同時に failed になっても、どれも書かれる)。
--     料理がすでに ready (画像ができた) なら書かない。
--
-- 権限:
--   requeue_stale_meal_image_jobs は、PUBLIC / anon / authenticated の EXECUTE を外し、service_role にだけ付ける (手で流す・試験のため)。
--   invoke_process_meal_image_jobs は Vault の秘密を読むので、PUBLIC / anon / authenticated / service_role の EXECUTE をすべて外す
--   (Supabase は public の関数にこれらの EXECUTE を自動で付けるため、明示的に外す。#1103)。呼べるのは所有者の postgres (= pg_cron のジョブ) だけ。
--   pg_cron のジョブは、登録したロール (postgres) で動く。
--
-- 本番のデータへの影響:
--   - この migration は、既存の行を 1 件も書き換えない (関数とジョブの登録だけ。関数もここでは呼ばない)。
--   - 最初のジョブの実行で、止まっている processing のジョブが pending に戻るか failed になり、failed になったジョブの料理が失敗の印になる。
--     待ちのジョブがあれば (Vault と Edge Function secrets の秘密がそろっていれば)、process-meal-image-jobs が画像を作り始める
--     (画像の生成の費用がかかる。docs/operations/meal-image-pipeline.md)。
--
-- 本番で必要な準備 (オーナー作業。この migration は Vault に書き込まない):
--   - Vault の app_cron_secret と、Edge Function secrets の CRON_SECRET が同じ値で登録されていること (ENV_SETUP.md。#1406)
--   - Edge Function process-meal-image-jobs (CRON_SECRET を受け付ける版。verify_jwt = false) がデプロイされていること
--
-- 冪等: CREATE OR REPLACE FUNCTION / 同じ名前のジョブの登録解除 → 登録。何度流しても同じ結果になる。
-- 確認: tests/integration/security/meal-image-jobs-pickup-cron.test.ts / tests/meal-image-jobs-pickup-cron-contract.test.ts
-- ロールバック: supabase/rollbacks/20261015120000_meal_image_jobs_pickup_cron.down.sql
--   (ジョブの登録を外し、関数を消す。取り戻したジョブ・失敗の印をつけた料理は元に戻さない)

-- ─────────────────────────────────────────────────────────
-- 1. 止まった processing のジョブを取り戻す
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.requeue_stale_meal_image_jobs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 貸し出しの期限 (leased_until) から、さらにこの時間が過ぎた processing を止まったとみなす。
  -- 貸し出し (2 分) + この時間 が、Edge Function の実行時間の上限 (400 秒) より長いこと (生きているワーカーのジョブを取らない)
  c_stale_grace CONSTANT interval := interval '5 minutes';
  -- 止まった試みを数えて、この回数に届いたら諦めて failed にする (2 回までやり直す)
  c_max_attempts CONSTANT integer := 3;
  -- 取り戻したジョブの last_error の頭。運用では last_error LIKE 'lease expired%' で探す (docs/operations/meal-image-pipeline.md)
  c_error_prefix CONSTANT text := 'lease expired';
  v_now timestamptz;
  v_requeued integer := 0;
  v_failed integer := 0;
  v_dishes integer := 0;
  v_rows integer;
  r record;
BEGIN
  v_now := COALESCE(p_now, now());

  -- 同時に 2 回走らせない (同じジョブを 2 回数えない)
  PERFORM pg_advisory_xact_lock(hashtextextended('public.requeue_stale_meal_image_jobs', 0));

  FOR r IN
    WITH stale AS (
      SELECT j.id,
             j.attempt_count + 1 AS next_attempt
        FROM public.meal_image_jobs AS j
       WHERE j.status = 'processing'
         AND COALESCE(j.leased_until, j.updated_at) < v_now - c_stale_grace
       FOR UPDATE SKIP LOCKED
    )
    UPDATE public.meal_image_jobs AS j
       SET status        = CASE WHEN s.next_attempt >= c_max_attempts THEN 'failed' ELSE 'pending' END,
           attempt_count = s.next_attempt,
           last_error    = format(
                             '%s (attempt %s of %s): %s',
                             c_error_prefix,
                             s.next_attempt,
                             c_max_attempts,
                             CASE WHEN s.next_attempt >= c_max_attempts THEN 'gave up' ELSE 'requeued' END
                           ),
           lease_token   = NULL,
           leased_until  = NULL,
           updated_at    = now()
      FROM stale AS s
     WHERE j.id = s.id
    RETURNING j.id, j.status, j.planned_meal_id, j.dish_index, j.subject_hash, j.last_error
  LOOP
    IF r.status = 'pending' THEN
      v_requeued := v_requeued + 1;
      CONTINUE;
    END IF;

    v_failed := v_failed + 1;

    -- 諦めたジョブの料理を失敗の印にする。まだ生成中で、同じ料理 (subject_hash が同じ) のときだけ。
    -- 負の位置は jsonb の -> が後ろから数えるので、0 以上のときだけ書く
    IF r.dish_index >= 0 THEN
      UPDATE public.planned_meals AS pm
         SET dishes = jsonb_set(
                        pm.dishes,
                        ARRAY[r.dish_index::text],
                        (pm.dishes -> r.dish_index) || jsonb_build_object('image_status', 'failed', 'image_error', r.last_error)
                      )
       WHERE pm.id = r.planned_meal_id
         AND jsonb_typeof(pm.dishes) = 'array'
         AND jsonb_typeof(pm.dishes -> r.dish_index) = 'object'
         AND pm.dishes -> r.dish_index ->> 'image_subject_hash' = r.subject_hash
         AND pm.dishes -> r.dish_index ->> 'image_status' = 'pending';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_dishes := v_dishes + v_rows;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'requeued',             v_requeued,
    'failed',               v_failed,
    'dishes_marked_failed', v_dishes
  );
END
$$;

ALTER FUNCTION public.requeue_stale_meal_image_jobs(timestamptz) OWNER TO postgres;

COMMENT ON FUNCTION public.requeue_stale_meal_image_jobs(timestamptz) IS
  '#1561: processing のまま、貸し出しの期限 (leased_until。無ければ updated_at) から 5 分より長く過ぎた料理画像のジョブを取り戻す。attempt_count を 1 足し、3 回に届いたら failed (料理が生成中で同じ料理なら image_status = failed にする)、届かなければ pending に戻す。last_error は lease expired で始まる。p_now は試験用。pg_cron のジョブ requeue-stale-meal-image-jobs が 5 分ごとに呼ぶ。service_role のみ。';

REVOKE ALL ON FUNCTION public.requeue_stale_meal_image_jobs(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_stale_meal_image_jobs(timestamptz) TO service_role;

-- ─────────────────────────────────────────────────────────
-- 2. 待ちのジョブがあれば、画像の処理 (Edge Function) を起こす
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invoke_process_meal_image_jobs()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 呼び先。既存の invoke_calculate_segment_stats と同じく、本番のプロジェクトの Edge Function に固定する
  -- (pg_cron のジョブから呼ぶ先を、引数で差し替えられないようにする。秘密を任意の宛先へ送らせないため #1020)
  c_url CONSTANT text := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/process-meal-image-jobs';
  -- 1 回の呼び出しで処理する件数 (process-meal-image-jobs の既定と同じ。5 件 × 数十秒が実行時間の上限 400 秒に収まる)
  c_batch_limit CONSTANT integer := 5;
  -- 最後の更新からこの時間を過ぎた待ちのジョブだけを数える (入口が積んだ直後に起こす処理と取り合わない)
  c_min_pending_age CONSTANT interval := interval '1 minute';
  -- pg_net が応答を待つ上限 (ミリ秒)。関数はジョブを読んだあとすぐ 202 を返すので、起動の遅れを含めても足りる
  c_timeout_ms CONSTANT integer := 60000;
  v_secret text;
  v_request_id bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.meal_image_jobs AS j
     WHERE j.status = 'pending'
       AND j.updated_at < now() - c_min_pending_age
  ) THEN
    RETURN NULL;
  END IF;

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
    body := jsonb_build_object('limit', c_batch_limit),
    timeout_milliseconds := c_timeout_ms
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

ALTER FUNCTION public.invoke_process_meal_image_jobs() OWNER TO postgres;

COMMENT ON FUNCTION public.invoke_process_meal_image_jobs() IS
  '#1561: 待ち (pending) の料理画像のジョブのうち、最後の更新から 1 分を過ぎたものがあれば、Edge Function process-meal-image-jobs を 1 回呼ぶ (本文 { limit: 5 })。Vault の app_cron_secret を Bearer に付ける。無ければ何も送らず NULL を返す。pg_cron のジョブ process-pending-meal-image-jobs が 5 分ごとに実行する。戻り値は pg_net の要求 ID。';

REVOKE ALL ON FUNCTION public.invoke_process_meal_image_jobs() FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────
-- 3. 5 分ごとの定時実行 (pg_cron が無い DB では何もしない)
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  -- 止まったジョブの取り戻し。5 分ごと (毎時 0, 5, 10, ... 分。UTC と JST で分は同じ)
  c_requeue_job      CONSTANT text := 'requeue-stale-meal-image-jobs';
  c_requeue_schedule CONSTANT text := '*/5 * * * *';
  c_requeue_command  CONSTANT text := 'SELECT public.requeue_stale_meal_image_jobs()';
  -- 待ちのジョブの処理を起こす。取り戻しの 2 分後 (毎時 2, 7, 12, ... 分)。取り戻したジョブを同じ 5 分の中で拾う
  c_pickup_job       CONSTANT text := 'process-pending-meal-image-jobs';
  c_pickup_schedule  CONSTANT text := '2-59/5 * * * *';
  c_pickup_command   CONSTANT text := 'SELECT public.invoke_process_meal_image_jobs()';
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron が無いため、料理画像のジョブの定期実行は登録しません';
    RETURN;
  END IF;

  -- 同じ名前のジョブがあれば登録解除してから登録し直す (何度流しても 1 つずつになる)
  PERFORM cron.unschedule(j.jobid)
     FROM cron.job AS j
    WHERE j.jobname IN (c_requeue_job, c_pickup_job);

  PERFORM cron.schedule(c_requeue_job, c_requeue_schedule, c_requeue_command);
  PERFORM cron.schedule(c_pickup_job, c_pickup_schedule, c_pickup_command);
END
$$;
