-- migration: 20261008130000_stop_aggregate_org_stats_cron.sql
-- 組織統計の集計 (Edge Function aggregate-org-stats) を呼ぶ pg_cron のジョブを登録解除する (#1325)
--
-- 背景:
--   オーナー判断 (2026-10-08, #1325): 組織の統計の集計は「止める」。夜間バッチは作らず、組織の画面には「準備中」を出す。
--   aggregate-org-stats は、すでに削除された表 (meal_plan_days / meal_plans) を読むため、本番では何も書き込めない状態だった。
--   これを直すと、止めると決めた集計が動き出してしまう。そのため、直さずに止める。
--   同じ PR で、関数は認証のあとに 410 (DISABLED) を返すだけにした。画面と API ルートからも呼ばない。
--   この migration は、その関数を定期的に呼ぶ pg_cron のジョブが本番に残っていた場合に、ジョブを登録解除する。
--   (このリポジトリには、ジョブを登録する migration が無い。本番にジョブがあるかどうかは、リポジトリからは分からない。)
--
-- 変更:
--   cron.job の中から、command に 'aggregate-org-stats' を含むジョブを探し、cron.unschedule(jobid) で登録解除する。
--   - 該当するジョブが無ければ何もしない (何度流しても同じ結果になる)
--   - pg_cron が入っていない DB (cron.job が存在しない環境) では何もしない
--   - command には認証の鍵が入っていることがある。実行ログ (NOTICE) には載せない。載せるのは jobid / jobname / schedule だけ
--   - 登録解除するのはジョブの登録だけ。org_daily_stats の表と、すでにある行には一切触れない (消さない)
--
-- 本番のデータへの影響:
--   該当するジョブがあれば、cron.job のその行が消える (= そのジョブは二度と動かない)。ジョブの定義はここに残さないので、
--   自動では元に戻せない (rollback はコメントだけ)。ただし、元に戻す必要はない: 関数は 410 を返すだけで、何も集計しない。
--   cron.job を見られるのは postgres ロールで、本番の migration もこのロールで流れる。postgres は cron.job の行の
--   RLS (username = current_user) を通り抜けるので、別のロールが作ったジョブも対象になる。
--
-- 冪等: 流すたびに、そのときに残っている該当ジョブを消すだけ。

DO $$
DECLARE
  v_job RECORD;
BEGIN
  -- pg_cron が入っていない DB には cron.job が無い。何もしない
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  FOR v_job IN
    SELECT jobid, jobname, schedule
    FROM cron.job
    WHERE command ILIKE '%aggregate-org-stats%'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
    RAISE NOTICE 'aggregate-org-stats を呼ぶ pg_cron のジョブを登録解除しました: jobid=%, jobname=%, schedule=%',
      v_job.jobid, v_job.jobname, v_job.schedule;
  END LOOP;
END
$$;
