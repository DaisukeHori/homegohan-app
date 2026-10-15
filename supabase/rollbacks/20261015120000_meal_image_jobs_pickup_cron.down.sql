-- rollback: 20261015120000_meal_image_jobs_pickup_cron.sql
-- 戻すと #1561 より前の状態 (料理画像の待ちのジョブを定期に拾う仕組みも、止まったジョブを取り戻す仕組みも無い状態) に戻る。
--
-- 内容:
--   1. pg_cron のジョブ requeue-stale-meal-image-jobs と process-pending-meal-image-jobs を登録解除する
--      (無ければ何もしない。pg_cron が無い DB でも何もしない)
--   2. 関数 public.invoke_process_meal_image_jobs() と public.requeue_stale_meal_image_jobs(timestamptz) を削除する
-- データへの影響: 関数が取り戻したジョブ (pending に戻した・failed にした) と、失敗の印をつけた料理は、そのまま残す (元に戻さない)。
--       戻したあとは、入口が積んだ直後に起こす処理が失敗したジョブは pending のまま、止まったジョブは processing のまま残る。
--       Vault の app_cron_secret はほかの定期実行と共用なので、消さない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。
--
-- 何度流しても同じ結果になる (冪等)。

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  PERFORM cron.unschedule(j.jobid)
     FROM cron.job AS j
    WHERE j.jobname IN ('requeue-stale-meal-image-jobs', 'process-pending-meal-image-jobs');
END
$$;

DROP FUNCTION IF EXISTS public.invoke_process_meal_image_jobs();
DROP FUNCTION IF EXISTS public.requeue_stale_meal_image_jobs(timestamptz);
