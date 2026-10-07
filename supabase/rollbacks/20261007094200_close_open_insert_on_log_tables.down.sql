-- rollback: 20261007094200_close_open_insert_on_log_tables.sql
-- ⚠️ 戻すと #1241 の脆弱性が復活する (anon で app_logs に、ログインユーザーで ai_content_logs / system_daily_stats に偽の行を書ける)。
--    緊急時の切り戻し専用。
--
-- 内容: 2026-10-06 時点の本番の定義 (supabase/baseline/catalog/catalog_policies.csv) へ戻す。
--   app_logs           "Allow service role insert": INSERT TO public         WITH CHECK (true)
--   ai_content_logs    "System can insert ai logs": INSERT TO authenticated  WITH CHECK (true)
--   system_daily_stats "System can insert stats":   INSERT TO authenticated  WITH CHECK (true)
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "Allow service role insert" ON "public"."app_logs";
CREATE POLICY "Allow service role insert" ON "public"."app_logs" FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "System can insert ai logs" ON "public"."ai_content_logs";
CREATE POLICY "System can insert ai logs" ON "public"."ai_content_logs" FOR INSERT TO "authenticated" WITH CHECK (true);

DROP POLICY IF EXISTS "System can insert stats" ON "public"."system_daily_stats";
CREATE POLICY "System can insert stats" ON "public"."system_daily_stats" FOR INSERT TO "authenticated" WITH CHECK (true);
