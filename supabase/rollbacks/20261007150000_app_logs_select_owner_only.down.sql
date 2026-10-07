-- rollback: 20261007150000_app_logs_select_owner_only.sql
-- ⚠️ 権限が広がる: 戻すと #1171 の漏洩が復活する。user_id IS NULL の行 (.withUser() を付けないロガー呼び出し・cron・
--    アカウント削除後の行) を、公開の anon キーだけで誰でも読める (message / error_message / error_stack に生の DB エラーやスタックトレース)。
--    緊急時の切り戻し専用。明示的な承認を得た場合に限って使う。
--
-- 内容: 2 本の SELECT ポリシーを、本番の定義 (supabase/baseline/catalog/catalog_policies.csv と同じ:
--       FOR SELECT, roles=public) に戻す。GRANT はもともと変えていないため触らない。
--   "Users can read own logs": USING ((auth.uid() = user_id) OR (user_id IS NULL))
--   "Users can view own logs": USING (auth.uid() = user_id)
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "Users can read own logs" ON "public"."app_logs";
CREATE POLICY "Users can read own logs" ON "public"."app_logs"
  FOR SELECT TO public USING ((("auth"."uid"() = "user_id") OR ("user_id" IS NULL)));

DROP POLICY IF EXISTS "Users can view own logs" ON "public"."app_logs";
CREATE POLICY "Users can view own logs" ON "public"."app_logs"
  FOR SELECT TO public USING (("auth"."uid"() = "user_id"));
