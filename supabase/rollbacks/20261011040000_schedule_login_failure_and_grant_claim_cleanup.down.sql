-- rollback: 20261011040000_schedule_login_failure_and_grant_claim_cleanup.sql
-- 次の 2 つを元に戻す (#1492)。
--   1. pg_cron のジョブ cleanup-stale-login-failures-and-grant-claims を登録解除する
--   2. public.cleanup_stale_auth_login_failures() と public.cleanup_expired_ai_usage_grant_claims() を削除する
--
-- 戻らないもの:
--   - ジョブが消した行 (保持期間を過ぎた auth_login_failures と ai_usage_grant_claims の行)。
--     どちらも判定・照合に使われなくなった行なので、戻す必要は無い。
--   - migration が登録解除した、本番に手作業で作られていた既存のジョブ (同じ関数を呼ぶもの)。
--     この migration で初めて作る関数なので、通常は存在しない。
--
-- 戻したあとの動き:
--   - auth_login_failures の行は、ログインの成功時にしか消えなくなる (#1492 の前の状態)。
--   - ai_usage_grant_claims の古い行は、同じ利用者が次に claim したときにしか消えなくなる (#1492 の前の状態)。
--   - ジョブだけを止めたいときは、1. だけを流す。または SELECT cron.unschedule('cleanup-stale-login-failures-and-grant-claims') で名前で登録解除する。
--   - 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (冪等)。

-- 1. ジョブの登録解除 (pg_cron が無い DB では何もしない)
DO $$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'cleanup-stale-login-failures-and-grant-claims'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END
$$;

-- 2. 掃除の関数を削除
DROP FUNCTION IF EXISTS public.cleanup_stale_auth_login_failures();
DROP FUNCTION IF EXISTS public.cleanup_expired_ai_usage_grant_claims();
