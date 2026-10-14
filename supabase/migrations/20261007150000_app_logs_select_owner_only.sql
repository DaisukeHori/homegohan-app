-- migration: 20261007150000_app_logs_select_owner_only.sql
-- #1171: app_logs の SELECT から user_id IS NULL の例外を外し、本人の行だけ読めるようにする
--
-- 背景 (本番の現状: supabase/baseline/catalog/catalog_policies.csv の SELECT ポリシー。INSERT 側は #1241 / 20261007094200 で閉じたが、SELECT 側は手つかず):
--   app_logs の SELECT ポリシーは 2 本あり、どちらも roles=public。permissive ポリシーは OR で合成されるため、
--   実際に効くのは両者の和集合になる。
--     "Users can read own logs"  USING ((auth.uid() = user_id) OR (user_id IS NULL))  ← 20260511000137_backfill_oob_remaining.sql:2087-2088
--     "Users can view own logs"  USING (auth.uid() = user_id)                          ← 20260102000001_create_app_logs.sql:60-62
--   前者の `OR user_id IS NULL` が穴。user_id = NULL の行は、公開の anon キーだけ (ログイン不要) を含む全員が
--   GET /rest/v1/app_logs?user_id=is.null で読める。app_logs は anon / authenticated に GRANT ALL があるため
--   (catalog_tables.csv)、防いでいるのは RLS だけ。行の message / error_message / error_stack には、
--   生の DB エラーやスタックトレースが入る。
--   user_id が NULL になる行:
--     - .withUser() を付けないロガー呼び出し (src/lib/db-logger.ts / supabase/functions/_shared/db-logger.ts。cron・バッチ・レート制限など)
--     - アカウント削除。app_logs.user_id は REFERENCES auth.users ON DELETE SET NULL で、
--       src/app/api/account/delete/route.ts は app_logs に触れないため、削除後その人の行は全員に公開される NULL 行になる
--   20260102000001 のコメントは「service_roleのみアクセス可能」で、読めるのは本人の行だけという意図だった。
--   IS NULL 付きのポリシーは本番で migration の外から作られ、20260511000137 のバックフィルで migration に取り込まれた。
--
-- 変更:
--   1. "Users can read own logs" を削除する (`OR user_id IS NULL` の例外ごと)。
--   2. "Users can view own logs" を TO authenticated で作り直す (条件は同じ。履歴に依存せず最終状態をここで固定する)。
--   結果: user_id IS NULL の行は service_role 専用になり、anon は app_logs を 0 件しか読めない
--   (SELECT ポリシーが無くなるため 42501 ではなく空の結果)。本人は従来どおり自分の行だけ読める
--   (log-tables-insert.test.ts S-5 の挙動は変わらない)。
--   次は変更しない: "Service role can do everything" (ALL、auth.role() = 'service_role')、GRANT (#1241 / #1242 と同じく RLS で足りる)。
--   ログ本文のマスキング (db-logger 側) はこの migration の対象外で、別 PR で行う (#1171 の 2/2)。
--
-- 既存の正当な利用経路への影響: なし。
--   - app_logs を読むのは scripts/read-logs.mjs だけで、service role で読む (RLS の対象外)。
--     運用で使う SQL コンソール・Supabase MCP も postgres ロールで、同じく RLS の対象外
--   - 書き込みはすべて service role (src/lib/db-logger.ts / supabase/functions/_shared/db-logger.ts / src/app/api/log/route.ts)
--   - ユーザーのセッションで app_logs を読むコードは、Web・モバイル・Edge Function・scripts のいずれにも無い
--
-- 冪等: DROP POLICY IF EXISTS → CREATE POLICY のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/rls/app-logs-select-scope.test.ts (7 件)。修正前は 5 件 (S-1〜S-4 と S-7) が失敗し、この migration の後は全件成功する。
-- ロールバック: supabase/rollbacks/20261007150000_app_logs_select_owner_only.down.sql

DROP POLICY IF EXISTS "Users can read own logs" ON "public"."app_logs";

DROP POLICY IF EXISTS "Users can view own logs" ON "public"."app_logs";
CREATE POLICY "Users can view own logs" ON "public"."app_logs"
  FOR SELECT TO authenticated USING (("auth"."uid"() = "user_id"));
