-- rollback: 20261007022126_org_role_tenant_scoped_org_admin.sql
-- ⚠️ セキュリティ後退: 組織テーブルの管理者判定を roles 配列の 'org_admin' に戻す (#1235)。
--    別組織で org_admin だったユーザーが、無関係な組織で部署・チャレンジ・招待 (admin 招待の発行を含む)・
--    レポート・統計を操作でき、運営の監査ログにも書き込める状態に戻る。
--    また、招待で org_role = owner / admin になったユーザー ('org_admin' なし) は再び操作できなくなる。
--    正当な管理者が操作できなくなった等の緊急時に、明示的な承認を得た場合に限って使う。
--
-- 内容: 20260511000137_backfill_oob_remaining.sql の定義 (= 2026-10-06 時点の本番) へ戻す。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "Org admins can manage departments" ON "public"."departments";
CREATE POLICY "Org admins can manage departments" ON "public"."departments" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "departments"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Org admins can manage challenges" ON "public"."organization_challenges";
CREATE POLICY "Org admins can manage challenges" ON "public"."organization_challenges" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_challenges"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Org admins can manage invites" ON "public"."organization_invites";
CREATE POLICY "Org admins can manage invites" ON "public"."organization_invites" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_invites"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Org admins can manage reports" ON "public"."organization_reports";
CREATE POLICY "Org admins can manage reports" ON "public"."organization_reports" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_reports"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Org admins can view own stats" ON "public"."org_daily_stats";
CREATE POLICY "Org admins can view own stats" ON "public"."org_daily_stats" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "org_daily_stats"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Admins can create audit logs" ON "public"."admin_audit_logs";
CREATE POLICY "Admins can create audit logs" ON "public"."admin_audit_logs" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text", 'org_admin'::"text"])))));
