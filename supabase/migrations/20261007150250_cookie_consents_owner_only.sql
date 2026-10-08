-- migration: 20261007150250_cookie_consents_owner_only.sql
-- cookie_consents (Cookie 同意記録) の RLS を「本人の行だけ」に絞る (#1171 の調査中に見つかった。専用の issue は無い)
--
-- 背景:
--   2026-10-07 13:41 UTC の本番スナップショット (supabase/baseline/catalog/catalog_policies.csv) では、cookie_consents のポリシーは 1 本だけ。
--     cookie_consents_self  FOR ALL  TO public  USING ((auth.uid() = user_id) OR (user_id IS NULL))  (WITH CHECK 無し)
--   定義元は 20260508120000_operator_phase_4_5_foundation.sql §3.20-1。「未ログイン時は user_id = NULL」の行を扱うための条件だが、
--   `OR (user_id IS NULL)` が anon を含む全ロールに効くため、次のことができる。
--     - anon キー (公開鍵) だけで、user_id が NULL のすべての行を SELECT・UPDATE・DELETE できる。
--       行には ip_address (INET)・user_agent・session_id が入るので、訪問者の IP アドレスなどが誰にでも読め、書き換えも消去もできる。
--     - anon でもログインユーザーでも、user_id が NULL の行を INSERT できる (同意記録の偽造、書き込み領域の悪用)。
--     - WITH CHECK が無いと USING の式が使われるため、ログインユーザーは自分の行の user_id を NULL に書き換えて、誰でも触れる行にできる。
--   anon / authenticated にはテーブルの GRANT ALL があるため、防いでいるのは RLS だけ。
--   2026-10-07 にローカル (本番スキーマのベースライン) で、anon の公開鍵だけで ip_address '203.0.113.7' の行を読めること、
--   更新・削除・INSERT ができることを再現した (tests/integration/rls/cookie-consents-scope.test.ts の 12 件が修正前に失敗する)。
--
-- 変更:
--   cookie_consents_self を DROP し、本人の行だけを対象にするポリシーを 4 本 (TO authenticated) に分けて作る。
--     cookie_consents_self_select  SELECT  USING (auth.uid() = user_id)
--     cookie_consents_self_insert  INSERT  WITH CHECK (auth.uid() = user_id)
--     cookie_consents_self_update  UPDATE  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)
--     cookie_consents_self_delete  DELETE  USING (auth.uid() = user_id)
--   結果:
--     - anon: どの操作もできない (SELECT・UPDATE・DELETE は 0 件、INSERT は 42501)。
--     - ログインユーザー: 自分の行 (user_id = 自分) だけ読み書きできる。user_id が NULL の行と他人の行は見えず、変更もできない。
--       INSERT は user_id = 自分 の行だけ。UPDATE で user_id を NULL や他人に書き換えることもできない (WITH CHECK)。
--     - user_id が NULL の行 (未ログインの同意記録) は、service role (RLS の対象外) だけが読み書きする。
--   ⚠ 今後、未ログインの訪問者の同意をサーバーに残す場合は、anon に INSERT を許すポリシーを足さず、サーバー側のルート
--     (Next.js の API Route や Edge Function) から service role で書くこと。ip_address や user_agent は、クライアントの申告ではなく
--     サーバーがリクエストから取る。
--
-- 既存の正当な利用経路への影響: なし。
--   アプリ (Web・モバイル・Edge Function・scripts) はこのテーブルを読み書きしていない。v1 の Cookie 同意は localStorage
--   (src/lib/posthog.ts の ANALYTICS_CONSENT_KEY) に保存していて、cookie_consents に触れるのは生成型
--   (src/types/database.types.ts / packages/shared/src/database.types.ts) とドキュメントだけ。
--   アカウント削除時の行の削除は user_id の外部キー (ON DELETE CASCADE) で、RLS の影響を受けない。
--
-- 冪等: 各ポリシーを DROP POLICY IF EXISTS してから CREATE POLICY する。2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/rls/cookie-consents-scope.test.ts (24 件)。修正前は 12 件が失敗し、この migration の後は全件成功する。
-- ロールバック: supabase/rollbacks/20261007150250_cookie_consents_owner_only.down.sql

DROP POLICY IF EXISTS "cookie_consents_self" ON "public"."cookie_consents";

DROP POLICY IF EXISTS "cookie_consents_self_select" ON "public"."cookie_consents";
CREATE POLICY "cookie_consents_self_select" ON "public"."cookie_consents"
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "cookie_consents_self_insert" ON "public"."cookie_consents";
CREATE POLICY "cookie_consents_self_insert" ON "public"."cookie_consents"
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "cookie_consents_self_update" ON "public"."cookie_consents";
CREATE POLICY "cookie_consents_self_update" ON "public"."cookie_consents"
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "cookie_consents_self_delete" ON "public"."cookie_consents";
CREATE POLICY "cookie_consents_self_delete" ON "public"."cookie_consents"
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
