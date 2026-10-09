-- rollback: 20261009100000_schedule_calculate_segment_stats.sql
-- 戻すと #1406 より前の状態 (セグメント統計の集計を定期的に呼ぶ設定が無い状態) に戻る。
--
-- 内容: pg_cron のジョブ calculate-segment-stats-daily の登録を外し、関数 public.invoke_calculate_segment_stats() を消す。
-- データへの影響: 集計済みの行 (segment_stats / user_segment_rankings / user_metrics / user_badges) には触れない (消さない)。
--       戻したあとは、比較ランキングが更新されなくなる (画面は最後に集計した期間のまま、新しい期間は空になる)。
--       Vault の app_cron_secret はコンビニカタログの取り込みと共用なので、消さない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SELECT cron.unschedule('calculate-segment-stats-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'calculate-segment-stats-daily');

DROP FUNCTION IF EXISTS public.invoke_calculate_segment_stats();
