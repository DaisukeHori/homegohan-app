-- migration: 20261008200000_schedule_log_cleanup_and_dau_snapshot.sql
-- #1125 / #1157: 古いログの定期削除と、日次のアクティブ利用者 (DAU / WAU / MAU) の集計を pg_cron で動かす
--
-- 背景:
--   (1) app_logs は書き込まれる一方で、消す処理が動いていなかった (#1157)。
--       本番には「created_at が 30 日より古い行を消す」関数 public.cleanup_old_logs() があるが、
--       これを定期的に呼ぶジョブが、リポジトリのどこにも無い。
--       この関数は SECURITY INVOKER で、PUBLIC / anon / authenticated にも EXECUTE が付いている
--       (supabase/baseline/prod_function_acl.sql)。app_logs には RLS があるため、実際に消えるのは service_role と所有者が呼んだときだけだが、
--       ログインしていない人が呼べること自体が不要。
--   (2) 管理画面の財務ダッシュボードの MAU カードは、daily_active_users の最新行を読む
--       (src/app/api/admin/finance/dashboard/route.ts。plan_type = 'all' かつ plan_key = '' の行)。
--       この表に書き込む処理が無く、MAU は常に 0 だった (#1125)。
--   オーナー判断 (2026-10-08, #1125): 課金系の定期処理 (収益スナップショット・Stripe Webhook・ライセンス期限切れなど) は作らない。
--   この migration は、上の 2 つ (ログの削除と、MAU の元データ) だけを動かす。revenue_snapshots には触れない。
--
-- 変更:
--   1. public.snapshot_daily_active_users(p_date date) を新設する。JST (Asia/Tokyo) の日付 p_date の DAU / WAU / MAU を数えて、
--      daily_active_users の (p_date, 'all', '') の行に upsert し、その行 (snapshot_date, dau, wau, mau) を返す。
--      EXECUTE は service_role のみ (anon / authenticated / PUBLIC は 42501)。
--   2. public.cleanup_old_logs() の EXECUTE を、PUBLIC / anon / authenticated から外す (service_role と所有者は残す)。関数の中身は変えない。
--   3. pg_cron のジョブを 2 つ登録する (時刻は UTC。pg_cron の cron.timezone は GMT)。
--        cleanup-old-app-logs          15 18 * * *   毎日 03:15 JST   SELECT public.cleanup_old_logs();
--        snapshot-daily-active-users   30 16 * * *   毎日 01:30 JST   SELECT public.snapshot_daily_active_users(前日 (JST));
--      登録の前に、同じ処理を呼ぶ既存のジョブ (名前は問わない。名前なしも含む) と同じ名前のジョブを登録解除するので、
--      本番に手作業で作られたジョブがあっても二重にならず、何度流しても同じ結果になる
--      (登録解除できるのは postgres が作ったジョブだけ。「設計上の判断」の最後を参照)。
--
-- 「アクティブ」の数え方 (活動の元データ):
--   Supabase Auth (GoTrue) の次の 3 つの時刻のどれかが、その日 (JST) の中にある利用者を、その日のアクティブ利用者とする。
--     auth.sessions.created_at     サインインでセッションが作られた時刻
--     auth.sessions.updated_at     セッションが更新された時刻 (アクセストークンの更新。アプリを開いている間に起きる。
--                                  ローカルの GoTrue (v2.183.0) で確認した動き。本番の GoTrue では未確認で、確かめる SQL は設計書 08-cron-batches.md §3.0.3)
--     auth.users.last_sign_in_at   最後にサインインした時刻
--   - 日付は Asia/Tokyo の暦日。範囲は [その日の 0:00, 翌日の 0:00) (0:00 ちょうどはその日に含め、翌日の 0:00 ちょうどは含めない)。
--   - DAU = その日 / WAU = その日を最後の日とする 7 日間 / MAU = その日を最後の日とする 30 日間 (どれも JST の暦日)。
--   - auth.users.deleted_at が入っている利用者 (削除済み) は数えない。運営・テスト用のアカウントも、サインインしていれば数える。
--   - 使う列は user_id / created_at / updated_at / last_sign_in_at / deleted_at / id だけ。GoTrue の版によらず存在する列に限る。
--     auth.sessions.refreshed_at と auth.users.is_anonymous は、古い版には無い。
--     本番の GoTrue の版は、リポジトリの supabase/.temp/gotrue-version では v2.183.0 (supabase link をした時点の版。
--     scripts/supabase-local.sh が、ローカル / CI のスタックをこの版に合わせる)。その後に本番が更新されたかは、リポジトリからは分からない。
--     そのため、版を問わず存在する列だけを使う。
--
-- 数字は概算で、実際より小さめに出る:
--   - セッションはサインアウトや期限切れで消える。消えたセッションの活動は数えられない。
--   - auth.users.last_sign_in_at は利用者ごとに最後の 1 回分だけ。auth.sessions.updated_at も 1 セッションにつき最後の 1 回分だけ。
--     あとからサインイン・更新されると、前の日の分は上書きされて見えなくなる (集計時刻の 01:30 JST までに更新された分も含む)。
--   - このため、集計は「その日が終わった直後」に 1 度だけ行って固定する (ジョブは翌日 01:30 JST に前日分を数える)。
--     過去の日を後から数え直すと、そのあいだに消えたセッションの分だけ小さくなることがある (再実行は上書きになる)。
--
-- 設計上の判断:
--   - LANGUAGE sql で書く。列名の誤りや、ほかの版にしか無い列の参照は、CREATE FUNCTION の時点 (= migration の適用時) でエラーになり、
--     migration が止まる。plpgsql だと最初の cron の実行 (翌日 01:30 JST) まで気付かない。
--   - 関数を作った直後に、1 回だけ試し実行する (日付は 2000-01-01)。auth の表を読む権限が無い・daily_active_users に書けない、といった
--     「作れるが動かない」状態も、最初の cron の実行ではなく、適用時にここで migration を止める。
--     試し実行は、書いた行ごと必ず取り消すので、daily_active_users には何も残らない (取り消しは、内側のブロックを例外で抜けて行う)。
--   - SECURITY DEFINER (所有者 postgres)。auth の表を読み、RLS のある daily_active_users に書くため。SET search_path = ''、関数内の参照は全て完全修飾。
--     引数は日付 1 つだけで、書く先は (p_date, 'all', '') の 1 行に固定。動的 SQL は無い。返すのは件数だけ (個人情報は返さない)。
--   - 関数の中では呼び出し元を確認しない。EXECUTE 権限 (service_role のみ) が境界になる。pg_cron のジョブは所有者 postgres として動くので影響しない。
--   - p_date が NULL のときは、日付の NOT NULL 制約でエラーになる (黙って何もしないことはしない)。
--   - cleanup_old_logs() の権限は PUBLIC からも外す。anon / authenticated は PUBLIC から EXECUTE を継承するため、
--     anon / authenticated だけを外しても効かない。
--   - ジョブの command には認証の鍵が入っていることがある (今回のジョブには無いが、既存のジョブを探して消すときに見える)。
--     実行ログ (NOTICE) には command を載せない。載せるのは jobid / jobname / schedule だけ。
--   - cleanup_old_logs を呼ぶ既存のジョブは、command に関数名が「単語として」入っているものを探す
--     (cleanup_old_logs_v2 のような別の関数を呼ぶジョブは対象にしない)。
--   - 既存のジョブを登録解除できるのは、postgres 自身が作ったジョブだけ。postgres 以外のロールが持つジョブが見つかると、
--     cron.job の DELETE 権限が無いため、この migration は「permission denied for table job」で止まる (ローカルで確認)。
--     Supabase で postgres 以外のロールがジョブを持つことは通常ない。
--     適用前に設計書 08-cron-batches.md §3.0.3 の SQL で username を確かめる。
--
-- 本番のデータへの影響:
--   - アプリのデータ (public の表の行) は、この migration では 1 行も変えず、消さない (関数の追加・権限の変更・ジョブの登録だけ)。
--     適用時の試し実行は daily_active_users に 1 行書くが、その場で取り消すので残らない。
--     pg_cron の登録 (cron.job) だけは、同じ処理を呼ぶ既存のジョブがあれば、登録解除して登録し直す。
--   - 登録したジョブが動くと、次のことが起きる (どちらも意図した動き)。
--       cleanup-old-app-logs          最初の実行 (適用後の次の 03:15 JST) で、30 日より古い app_logs の行がまとめて消える。以降は毎日、その日に 30 日を超えた分が消える。
--       snapshot-daily-active-users   最初の実行 (適用後の次の 01:30 JST) で、前日の行が daily_active_users に 1 行入る。以降は毎日 1 行ずつ増える。
--   - ジョブの失敗は cron.job_run_details に残る。通知は出ない。
--
-- 冪等: CREATE OR REPLACE FUNCTION / REVOKE / GRANT / COMMENT は何度流しても同じ結果になる。ジョブは、流すたびに登録解除して登録し直す (jobid は変わる)。
-- 適用順: migration は version 順にマージする。コードの変更は無い (財務ダッシュボードは、行があれば MAU を出し、無ければ 0 を出す)。
-- ロールバック: supabase/rollbacks/20261008200000_schedule_log_cleanup_and_dau_snapshot.down.sql
--   (この migration が登録解除した、本番に手作業で作られていた既存のジョブは、定義を保存しないので戻らない。rollback の冒頭を参照)
-- 確認: tests/integration/security/log-cleanup-and-dau-snapshot.test.ts / tests/log-cleanup-dau-snapshot-contract.test.ts

-- ─────────────────────────────────────────────────────────
-- 1. 日次のアクティブ利用者の集計
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.snapshot_daily_active_users(p_date date)
RETURNS TABLE (snapshot_date date, dau integer, wau integer, mau integer)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH bounds AS (
    -- JST (Asia/Tokyo) の暦日の 0:00 を、timestamptz にしたもの。範囲は [開始, range_end)
    SELECT
      p_date::timestamp AT TIME ZONE 'Asia/Tokyo'        AS day_start,
      (p_date - 6)::timestamp AT TIME ZONE 'Asia/Tokyo'  AS week_start,
      (p_date - 29)::timestamp AT TIME ZONE 'Asia/Tokyo' AS month_start,
      (p_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo'  AS range_end
  ),
  signals AS (
    -- 活動の元データ (利用者, 活動の時刻)
    SELECT s.user_id, s.created_at AS active_at FROM auth.sessions AS s
    UNION ALL
    SELECT s.user_id, s.updated_at FROM auth.sessions AS s
    UNION ALL
    SELECT u.id, u.last_sign_in_at FROM auth.users AS u
  ),
  active AS (
    -- 30 日間の範囲に入るものだけ。削除済みの利用者は除く
    SELECT g.user_id, g.active_at
      FROM signals AS g
      JOIN auth.users AS u ON u.id = g.user_id AND u.deleted_at IS NULL
      CROSS JOIN bounds AS b
     WHERE g.active_at >= b.month_start
       AND g.active_at <  b.range_end
  ),
  counts AS (
    SELECT
      (count(DISTINCT a.user_id) FILTER (WHERE a.active_at >= b.day_start))::integer  AS dau,
      (count(DISTINCT a.user_id) FILTER (WHERE a.active_at >= b.week_start))::integer AS wau,
      (count(DISTINCT a.user_id))::integer                                             AS mau
      FROM active AS a
      CROSS JOIN bounds AS b
  )
  INSERT INTO public.daily_active_users AS d (date, plan_type, plan_key, dau, wau, mau, computed_at)
  SELECT p_date, 'all', '', c.dau, c.wau, c.mau, now()
    FROM counts AS c
  ON CONFLICT (date, plan_type, plan_key) DO UPDATE
     SET dau         = EXCLUDED.dau,
         wau         = EXCLUDED.wau,
         mau         = EXCLUDED.mau,
         computed_at = EXCLUDED.computed_at
  RETURNING d.date, d.dau, d.wau, d.mau
$$;

-- 試し実行。この関数が実際に動くこと (auth の表を読める・daily_active_users に書ける) を、適用時に確かめる。
-- 動かなければ、翌日 01:30 JST のジョブが黙って失敗するのではなく、ここで migration を止める (関数の本来のエラーがそのまま出る)。
-- 動いたら、内側のブロックを専用の SQLSTATE (P0T24) の例外で抜けて、書いた行を取り消す。この SQLSTATE だけを受け止め、ほかのエラーは外に出す。
-- 日付は 2000-01-01 (本物の行と重ならない昔の日付)。
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.snapshot_daily_active_users(DATE '2000-01-01');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'snapshot_daily_active_users: 試し実行で結果の行が返りませんでした';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0T24', MESSAGE = 'snapshot_daily_active_users の試し実行は成功しました (書いた行を取り消すための例外です)';
  EXCEPTION
    WHEN SQLSTATE 'P0T24' THEN
      NULL;
  END;
END
$$;

-- ─────────────────────────────────────────────────────────
-- 2. 関数の権限
-- ─────────────────────────────────────────────────────────
-- 新しい関数は Supabase の既定権限で anon / authenticated / service_role に EXECUTE が自動付与され、PUBLIC にも付く。
-- 引数の型まで含めた完全形で REVOKE する (20261007160800_admin_user_email_lookup.sql と同じ理屈)。
REVOKE ALL ON FUNCTION public.snapshot_daily_active_users(date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_daily_active_users(date)
  TO service_role;

-- cleanup_old_logs(): 本番では PUBLIC / anon / authenticated / service_role のすべてに EXECUTE がある。
-- ジョブは所有者 postgres として動くので、service_role 以外を外しても止まらない。中身は変えない。
REVOKE ALL ON FUNCTION public.cleanup_old_logs()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_logs()
  TO service_role;

COMMENT ON FUNCTION public.snapshot_daily_active_users(date) IS
  '#1125: JST (Asia/Tokyo) の暦日 p_date のアクティブ利用者数 (DAU / WAU / MAU) を数え、daily_active_users の (p_date, plan_type=all, plan_key=空文字) の行に upsert して、その行 (snapshot_date, dau, wau, mau) を返す。service_role のみ実行できる。pg_cron のジョブ snapshot-daily-active-users が、毎日 01:30 JST (16:30 UTC) に前日 (JST) の分を呼ぶ。活動の元データ: auth.sessions.created_at / auth.sessions.updated_at / auth.users.last_sign_in_at のどれかがその日 (JST の 0:00 以上、翌日 0:00 未満) にある利用者 (auth.users.deleted_at が入っている利用者は除く)。WAU はその日までの 7 日間、MAU はその日までの 30 日間 (どちらも JST の暦日)。数字は概算で、実際より小さめに出る: セッションはサインアウトや期限切れで消え、last_sign_in_at と updated_at は最後の 1 回分しか残らないため。そのため、日が終わった直後に 1 度だけ数えて固定する。過去の日を後から数え直すと、消えたセッションの分だけ小さくなることがある。auth.sessions.refreshed_at と auth.users.is_anonymous は、GoTrue の古い版に無いため使わない。';

COMMENT ON FUNCTION public.cleanup_old_logs() IS
  '#1157: app_logs の created_at が 30 日より古い行を削除する (SECURITY INVOKER)。pg_cron のジョブ cleanup-old-app-logs が、毎日 03:15 JST (18:15 UTC) に呼ぶ。EXECUTE は service_role と所有者だけ (PUBLIC / anon / authenticated からは外した)。';

-- ─────────────────────────────────────────────────────────
-- 3. pg_cron のジョブ
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_job RECORD;
BEGIN
  -- pg_cron が入っていない DB には cron.job が無い。ジョブは登録できないので、何もしない
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron が入っていないため、ジョブの登録を飛ばしました';
    RETURN;
  END IF;

  -- 同じ処理を呼ぶ既存のジョブ (名前は問わない。名前なしも含む) と、これから登録する名前のジョブを、先に登録解除する。
  -- cron.job を見られるのは postgres ロールで、本番の migration もこのロールで流れる。
  -- postgres は cron.job の行の RLS (username = current_user) を BYPASSRLS で通り抜けるので、別のロールが作ったジョブも探せる。
  -- ただし、登録解除 (cron.unschedule) できるのは postgres 自身が作ったジョブだけ。postgres には cron.job の DELETE 権限が無く、
  -- 別のロールのジョブを消そうとすると「permission denied for table job」で、この migration が止まる (ローカルで確認)。
  -- Supabase で postgres 以外のロールがジョブを作ることは通常ない。念のため、適用前に設計書 08-cron-batches.md §3.0.3 の SQL で
  -- username を確かめる (postgres 以外のジョブがあれば、先に知らせてもらう)。
  -- command は NOTICE に載せない (秘密が入っていることがある)。
  FOR v_job IN
    SELECT jobid, jobname, schedule
    FROM cron.job
    WHERE jobname IN ('cleanup-old-app-logs', 'snapshot-daily-active-users')
       OR command ~* '[[:<:]]cleanup_old_logs[[:>:]]'
       OR command ~* '[[:<:]]snapshot_daily_active_users[[:>:]]'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
    RAISE NOTICE '登録済みの pg_cron のジョブを登録解除しました (同じ処理は、このあと登録する 2 つのジョブが引き継ぎます): jobid=%, jobname=%, schedule=%',
      v_job.jobid, v_job.jobname, v_job.schedule;
  END LOOP;

  -- 毎日 03:15 JST (18:15 UTC): 30 日より古い app_logs を消す
  PERFORM cron.schedule(
    'cleanup-old-app-logs',
    '15 18 * * *',
    'SELECT public.cleanup_old_logs();'
  );

  -- 毎日 01:30 JST (16:30 UTC): 前日 (JST) の DAU / WAU / MAU を数える。
  -- 実行時刻の JST の日付から 1 を引く: 16:30 UTC は翌日の 01:30 JST なので、数えるのは前日の 1 日分 (終わったばかりの日)
  PERFORM cron.schedule(
    'snapshot-daily-active-users',
    '30 16 * * *',
    'SELECT public.snapshot_daily_active_users((now() AT TIME ZONE ''Asia/Tokyo'')::date - 1);'
  );
END
$$;
