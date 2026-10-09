-- rollback: 20261008200000_schedule_log_cleanup_and_dau_snapshot.sql
-- 次の 3 つを元に戻す (#1125 / #1157)。
--   1. pg_cron のジョブ 2 つ (cleanup-old-app-logs / snapshot-daily-active-users) を登録解除する
--   2. public.snapshot_daily_active_users(date) を削除する
--   3. public.cleanup_old_logs() の EXECUTE 権限とコメントを、本番の元の状態 (supabase/baseline/prod_function_acl.sql, prod_schema.sql) に戻す
--        PUBLIC / anon / authenticated / service_role のすべてに EXECUTE。コメントは無し (この migration が付けたコメントを外す)
--
-- 消えないもの (消さない):
--   - daily_active_users の行 (ジョブが書いた日次の集計)。実際の数字なので、ロールバックでは消さない。
--
-- 戻らないもの:
--   - app_logs から消えた行 (cleanup-old-app-logs が消した 30 日より古いログ)。
--   - migration が登録解除した、本番に手作業で作られていた既存のジョブ (cleanup_old_logs / snapshot_daily_active_users を呼ぶもの)。
--     migration は、登録解除するジョブの定義 (時刻・command) を保存していないので、ロールバックでは元に戻せない。
--     戻す必要がありそうなときは、migration を適用する前に、SQL エディタで cron.job のそのジョブの jobname / schedule / command を控えておく
--     (command には秘密が入っていることがあるので、控えは安全な場所に置く。設計書 08-cron-batches.md §3.0.3 の SQL は command を表示しない)。
--
-- 注意:
--   - 3. を戻すと、ログインしていない人 (anon) も cleanup_old_logs() を呼べる状態に戻る。
--     app_logs の RLS により anon / authenticated が呼んでも実際には何も消えないが、ジョブを止めるだけなら 3. は流さなくてよい
--     (3. を除いても、ジョブは postgres として動くので影響しない)。
--   - ジョブだけを止めたいときは、1. だけを流す。または SELECT cron.unschedule('cleanup-old-app-logs') のように名前で登録解除する。
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
    WHERE jobname IN ('cleanup-old-app-logs', 'snapshot-daily-active-users')
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END
$$;

-- 2. 集計の関数を削除
DROP FUNCTION IF EXISTS public.snapshot_daily_active_users(date);

-- 3. cleanup_old_logs() の権限とコメントを本番の元の状態に戻す (関数が無い DB では何もしない)
DO $$
BEGIN
  IF to_regprocedure('public.cleanup_old_logs()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO PUBLIC;
    GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO anon;
    GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO authenticated;
    GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO service_role;
    -- 本番の元の関数にはコメントが無い。この migration が付けたコメント (権限は service_role だけ、と書いてある) を外す
    COMMENT ON FUNCTION public.cleanup_old_logs() IS NULL;
  END IF;
END
$$;
