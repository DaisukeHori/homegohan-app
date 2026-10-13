-- migration: 20261011070000_schedule_login_failure_and_grant_claim_cleanup.sql
-- #1492: ログイン失敗の記録 (auth_login_failures) と、数え済みの印の使用済みの記録 (ai_usage_grant_claims) の古い行を、毎日消す
--
-- 背景 (統合スイープの所見):
--   (1) auth_login_failures (20261010130000) の行が消えるのは、ログインの成功時の auth_login_clear_failures だけだった。
--       存在しないメールアドレスで 1 回失敗するたびに、成功で消えることの無い行が 1 行でき、永久に残る (表が際限なく増える)。
--       回数の判定 (20261010160000 の auth_login_failure_count / auth_login_count_failure) は、最後の失敗 (last_failed_at) から
--       アプリが渡す間隔 (src/lib/auth/login-failures.ts。既定 24 時間・上限 LOGIN_FAILURE_RESET_MINUTES_MAX = 7 日) が経った行を
--       0 回として扱うので、上限を過ぎた行は判定に使われない。
--   (2) ai_usage_grant_claims (20261011030000) の古い行は、claim_ai_usage_grant の中で「同じ利用者が次に claim したとき」にしか消えない。
--       claim しなくなった利用者の行は残り、src/lib/account-export-tables.ts の「1 日で消す」と食い違っていた。
--
-- 変更 (追加だけ。既存のテーブル・列・関数には触れない):
--   1. public.cleanup_stale_auth_login_failures() -> integer (消した行数)
--        coalesce(last_failed_at, updated_at) が保持期間 (stale_after = 8 日) より古い行を消す。
--   2. public.cleanup_expired_ai_usage_grant_claims() -> integer (消した行数)
--        利用者を問わず、claimed_at が保持期間 (claim_retention = 1 日) より古い行を消す。
--   3. pg_cron のジョブを 1 つ登録する (時刻は UTC。pg_cron の cron.timezone は GMT)。
--        cleanup-stale-login-failures-and-grant-claims   45 18 * * *   毎日 03:45 JST
--          SELECT public.cleanup_stale_auth_login_failures(), public.cleanup_expired_ai_usage_grant_claims();
--      登録の前に、同じ処理を呼ぶ既存のジョブ (名前は問わない) と同じ名前のジョブを登録解除するので、何度流しても 1 つだけになる
--      (20261010150000_schedule_log_cleanup_and_dau_snapshot.sql と同じ形。登録解除できるのは postgres が作ったジョブだけ)。
--
-- 保持期間:
--   - auth_login_failures の stale_after = 8 日。
--     アプリの上限 LOGIN_FAILURE_RESET_MINUTES_MAX (7 日。環境変数 AUTH_LOGIN_FAILURE_RESET_MINUTES はこれより長くできない) より 1 日長くする。
--     7 日を過ぎた行は、どの設定でも回数の判定に使われない (0 回として扱われ、次の失敗では 1 からやり直す) ので、消しても挙動は変わらない。
--     1 日の余裕は、ジョブの時刻と判定の時刻のずれと、上限を少し延ばす将来の変更を吸収するため
--     (上限ちょうどにすると、環境変数を 7 日にしたときに、数えている途中の行を消しうる)。
--     アプリの上限以上であることは tests/login-failure-grant-claim-cleanup-contract.test.ts が突き合わせる。
--     last_failed_at が NULL の行 (ロックがあったころの関数で作られ、失敗の時刻を持たない行) は、updated_at で判定する。
--     失敗の時刻が無い行は回数の判定でも 0 回として扱われる (20261010160000)。
--   - ai_usage_grant_claims の claim_retention = 1 日。claim_ai_usage_grant (20261011030000) の c_claim_retention と同じ値。
--     印の有効期限 (supabase/functions/_shared/ai-usage-core.ts の AI_USAGE_GRANT_MAX_AGE_SEC = 10 分) より十分長いので、
--     期限内の印の使用済みの記録 (二度目の使用を断るための記録) は消さない。同じ値であることは contract テストが突き合わせる。
--   - どちらの値も、アプリの定数から決まる値で、運用で変える値ではない (変えるときは新しい migration で関数を差し替える)。
--
-- 設計上の判断:
--   - LANGUAGE sql で書く。列名の誤りは CREATE FUNCTION の時点 (= migration の適用時) でエラーになる (20261010150000 と同じ理由)。
--     保持期間は、関数の中の CTE (params) に名前を付けて 1 か所に置く。
--   - SECURITY INVOKER・SET search_path = ''・参照は完全修飾。EXECUTE は service_role と所有者 (postgres) だけ
--     (PUBLIC / anon / authenticated から完全形で REVOKE する。20261010150000 と同じ理屈)。
--     ジョブは所有者 postgres として動く。postgres は 2 つの表の所有者なので RLS を通り抜けて消せる。
--     service_role は 2 つの表に DELETE の権限を持ち、RLS を通り抜ける (BYPASSRLS)。
--   - 消す条件は「保持期間より古い」だけ。引数は無く、消す範囲は呼び出し元から変えられない。動的 SQL は無い。返すのは行数だけ。
--   - ジョブの command には秘密は入らないが、既存のジョブを探して消すときに見える command は NOTICE に載せない (20261010150000 と同じ)。
--
-- 触らないもの:
--   - ロックがあったころの関数 (auth_login_lock_status など 4 本) と列 auth_login_failures.locked_until は、使わないまま残す
--     (docs/operations/auth-protection.md §2.1 と 20261010160000 の冒頭のとおり、消すかは別に決める)。
--     locked_until に値が残る行も、保持期間を過ぎれば行ごと消える (アプリは locked_until を読まないので、ログインには影響しない)。
--   - claim_ai_usage_grant の中の、同じ利用者の古い記録の削除は残す (このジョブと重なっても、消す条件は同じ)。
--
-- 本番のデータへの影響:
--   - 適用時は、関数の追加・権限の設定・ジョブの登録だけで、行は 1 行も変えず、消さない。
--   - ジョブが動くと、最初の実行 (適用後の次の 03:45 JST) で、保持期間を過ぎた行がまとめて消える。以降は毎日、その日に過ぎた分が消える。
--     どちらの表も、消える行は判定・照合に使われない行だけなので、ログインと AI の回数の数え方は変わらない。
--   - ジョブの失敗は cron.job_run_details に残る。通知は出ない。
--
-- 冪等: CREATE OR REPLACE FUNCTION / REVOKE / GRANT / COMMENT は何度流しても同じ結果になる。ジョブは、流すたびに登録解除して登録し直す (jobid は変わる)。
-- 適用順: 20261010160000_auth_login_failure_window.sql と 20261011030000_ai_usage_unmetered_caps_and_grants.sql のあと。コードの変更は無い。
-- ロールバック: supabase/rollbacks/20261011070000_schedule_login_failure_and_grant_claim_cleanup.down.sql
-- 確認: tests/integration/security/login-failure-grant-claim-cleanup.test.ts / tests/login-failure-grant-claim-cleanup-contract.test.ts

-- ─────────────────────────────────────────────────────────
-- 1. ログイン失敗の記録の掃除
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_stale_auth_login_failures()
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH params AS (
    -- 保持期間: アプリの上限 LOGIN_FAILURE_RESET_MINUTES_MAX (7 日) + 余裕 1 日。理由は migration の冒頭
    SELECT INTERVAL '8 days' AS stale_after
  ),
  deleted AS (
    DELETE FROM public.auth_login_failures AS f
     USING params AS p
     WHERE coalesce(f.last_failed_at, f.updated_at) < pg_catalog.now() - p.stale_after
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;

-- ─────────────────────────────────────────────────────────
-- 2. 数え済みの印の使用済みの記録の掃除
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_expired_ai_usage_grant_claims()
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH params AS (
    -- 保持期間: claim_ai_usage_grant (20261011030000) の c_claim_retention と同じ 1 日。
    -- 印の有効期限 (AI_USAGE_GRANT_MAX_AGE_SEC = 10 分) より十分長いので、期限内の印の記録は消さない
    SELECT INTERVAL '1 day' AS claim_retention
  ),
  deleted AS (
    DELETE FROM public.ai_usage_grant_claims AS g
     USING params AS p
     WHERE g.claimed_at < pg_catalog.now() - p.claim_retention
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;

-- ─────────────────────────────────────────────────────────
-- 3. 関数の権限 (service_role と所有者 postgres だけ)
-- ─────────────────────────────────────────────────────────
-- 新しい関数は Supabase の既定権限で anon / authenticated / service_role に EXECUTE が自動付与され、PUBLIC にも付く。
-- 引数の型まで含めた完全形で REVOKE する。
REVOKE ALL ON FUNCTION public.cleanup_stale_auth_login_failures()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_auth_login_failures()
  TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_expired_ai_usage_grant_claims()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_ai_usage_grant_claims()
  TO service_role;

COMMENT ON FUNCTION public.cleanup_stale_auth_login_failures() IS
  '#1492: auth_login_failures のうち、最後の失敗 (last_failed_at。無ければ updated_at) が 8 日より古い行を消し、消した行数を返す。8 日 = アプリの上限 LOGIN_FAILURE_RESET_MINUTES_MAX (7 日) + 余裕 1 日 (これより古い行は回数の判定に使われない)。pg_cron のジョブ cleanup-stale-login-failures-and-grant-claims が毎日 03:45 JST (18:45 UTC) に呼ぶ。service_role と所有者だけが実行できる。';
COMMENT ON FUNCTION public.cleanup_expired_ai_usage_grant_claims() IS
  '#1492: ai_usage_grant_claims のうち、claimed_at が 1 日より古い行を、利用者を問わず消し、消した行数を返す。1 日 = claim_ai_usage_grant の c_claim_retention と同じ (印の有効期限 10 分より十分長い)。pg_cron のジョブ cleanup-stale-login-failures-and-grant-claims が毎日 03:45 JST (18:45 UTC) に呼ぶ。service_role と所有者だけが実行できる。';

-- ─────────────────────────────────────────────────────────
-- 4. pg_cron のジョブ
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
  -- 関数名は単語として探す (似た名前の別の関数を呼ぶジョブは対象にしない)。
  -- 登録解除できるのは postgres 自身が作ったジョブだけ (20261010150000 の「設計上の判断」を参照)。
  -- command は NOTICE に載せない (既存のジョブの command には秘密が入っていることがある)。
  FOR v_job IN
    SELECT jobid, jobname, schedule
    FROM cron.job
    WHERE jobname = 'cleanup-stale-login-failures-and-grant-claims'
       OR command ~* '[[:<:]]cleanup_stale_auth_login_failures[[:>:]]'
       OR command ~* '[[:<:]]cleanup_expired_ai_usage_grant_claims[[:>:]]'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
    RAISE NOTICE '登録済みの pg_cron のジョブを登録解除しました (同じ処理は、このあと登録するジョブが引き継ぎます): jobid=%, jobname=%, schedule=%',
      v_job.jobid, v_job.jobname, v_job.schedule;
  END LOOP;

  -- 毎日 03:45 JST (18:45 UTC): 保持期間を過ぎたログイン失敗の記録と、数え済みの印の使用済みの記録を消す。
  -- 時刻は、ほかのジョブ (cleanup-old-app-logs の 03:15 JST・snapshot-daily-active-users の 01:30 JST) と重ならない、利用の少ない時間帯
  PERFORM cron.schedule(
    'cleanup-stale-login-failures-and-grant-claims',
    '45 18 * * *',
    'SELECT public.cleanup_stale_auth_login_failures(), public.cleanup_expired_ai_usage_grant_claims();'
  );
END
$$;
