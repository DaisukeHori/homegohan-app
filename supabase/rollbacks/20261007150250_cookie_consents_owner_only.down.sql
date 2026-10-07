-- rollback: 20261007150250_cookie_consents_owner_only.sql
-- ⚠️ 戻すと脆弱性が復活する (anon の公開鍵だけで、user_id が NULL の行の ip_address / user_agent を読み書きでき、
--    anon でもログインユーザーでも user_id が NULL の行を INSERT できる)。緊急時の切り戻し専用。
--
-- 内容: 2026-10-07 13:41 UTC 時点の本番の定義 (supabase/baseline/catalog/catalog_policies.csv) へ戻す。
--   cookie_consents_self  FOR ALL  TO public  USING ((auth.uid() = user_id) OR (user_id IS NULL))  (WITH CHECK 無し)
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "cookie_consents_self_select" ON "public"."cookie_consents";
DROP POLICY IF EXISTS "cookie_consents_self_insert" ON "public"."cookie_consents";
DROP POLICY IF EXISTS "cookie_consents_self_update" ON "public"."cookie_consents";
DROP POLICY IF EXISTS "cookie_consents_self_delete" ON "public"."cookie_consents";

DROP POLICY IF EXISTS "cookie_consents_self" ON "public"."cookie_consents";
CREATE POLICY "cookie_consents_self" ON "public"."cookie_consents"
  FOR ALL
  USING ((auth.uid() = user_id) OR (user_id IS NULL));
