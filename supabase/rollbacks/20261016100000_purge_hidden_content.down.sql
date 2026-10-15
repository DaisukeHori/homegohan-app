-- rollback: 20261016100000_purge_hidden_content.sql
-- 戻すと #1538 より前の状態 (運営が隠したコンテンツを完全に消すジョブが無い状態) に戻る。
--
-- 内容: pg_cron のジョブ purge-hidden-content の登録を外し、
--       関数 public.invoke_purge_hidden_content() と public.hidden_content_purge_referenced_needles(text[], timestamptz) を消す。
-- データへの影響: 行には触れない。すでにジョブが消した行と画像は戻らない。
--       戻したあとは、隠した行と画像が残り続ける。Edge Function purge-hidden-content は、関数を消すと画像の確認 (RPC) で失敗し、
--       何も消さずに 500 を返す (呼ぶジョブも無くなる)。不要になった関数は Supabase のダッシュボードから消す。
--       Vault の app_cron_secret はほかのジョブと共用なので、消さない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname = 'purge-hidden-content';

DROP FUNCTION IF EXISTS public.invoke_purge_hidden_content();
DROP FUNCTION IF EXISTS public.hidden_content_purge_referenced_needles(text[], timestamptz);
