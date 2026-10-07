-- migration: 20261007094200_close_open_insert_on_log_tables.sql
-- ログ系 3 テーブル (app_logs / ai_content_logs / system_daily_stats) の開いている INSERT ポリシーを削除する (#1241)
--
-- 背景:
--   2026-10-06 の本番スナップショット (supabase/baseline/catalog/catalog_policies.csv) では、3 テーブルに
--   WITH CHECK (true) の INSERT ポリシーが残っている。名前は「service role / system」だが、実際には service role 以外も書ける。
--     app_logs           "Allow service role insert": INSERT TO public (anon を含む)  WITH CHECK (true)
--     ai_content_logs    "System can insert ai logs": INSERT TO authenticated          WITH CHECK (true)
--     system_daily_stats "System can insert stats":   INSERT TO authenticated          WITH CHECK (true)
--   anon キーだけで app_logs に任意の user_id / error_stack / metadata を書ける。ログインユーザーは他人の user_id で
--   ai_content_logs (flagged / cost_usd など) や system_daily_stats を書ける。監査ログの偽造、管理画面の数値の汚染、
--   他人への濡れ衣につながる。3 テーブルとも anon / authenticated に GRANT ALL があるため、防いでいるのは RLS だけ。
--   定義元: 20260102000001_create_app_logs.sql (app_logs)、20260511000137_backfill_oob_remaining.sql (3 テーブル)。
--
-- 変更:
--   3 つの INSERT ポリシーを DROP する。INSERT ポリシーが無くなるため、anon / authenticated の INSERT は
--   RLS により拒否される (42501)。service role は RLS の対象外なので、書き込めるのは service role だけになる。
--   次は変更しない: app_logs の "Service role can do everything" (ALL、auth.role() = 'service_role') と SELECT ポリシー 2 本
--   ("Users can read own logs" の user_id IS NULL の読み取りは別 issue #1171)、ai_content_logs / system_daily_stats の SELECT ポリシー。
--
-- 既存の正当な利用経路への影響: なし (すべて service role で書いている)。
--   app_logs: src/lib/db-logger.ts / supabase/functions/_shared/db-logger.ts / src/app/api/log/route.ts
--             (いずれも service role のクライアントで insert。api/log は認証済みユーザーのみ受け付け、service role で書く)
--   ai_content_logs / system_daily_stats: 書き込む経路が無い (src/app/api/account/delete/route.ts が service role で DELETE するのみ)
--   anon / ユーザーのセッションで書く経路は、Web・モバイル・Edge Function・scripts のいずれにも無い。
--
-- 冪等: DROP POLICY IF EXISTS。2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/rls/log-tables-insert.test.ts (13 件)。修正前は 6 件が失敗し、この migration の後は全件成功する。
-- ロールバック: supabase/rollbacks/20261007094200_close_open_insert_on_log_tables.down.sql

DROP POLICY IF EXISTS "Allow service role insert" ON "public"."app_logs";

DROP POLICY IF EXISTS "System can insert ai logs" ON "public"."ai_content_logs";

DROP POLICY IF EXISTS "System can insert stats" ON "public"."system_daily_stats";
