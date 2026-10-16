-- rollback: 20261016238000_admin_audit_logs_insert_actor_only.sql
-- ⚠️ 権限が広がる: 戻すと #1736 の穴が復活する。運営のロールの人が、自分の JWT で
--    他人・NULL を actor にした行、system.* の行、snapshot / impersonated_by に他人を書いた行を admin_audit_logs に作れる。
--    緊急時の切り戻し専用。明示的な承認を得た場合に限って使う。
--
-- 内容: 2 本の INSERT ポリシーを、本番の定義 (supabase/baseline/catalog/catalog_policies.csv と同じ:
--       FOR INSERT, roles=public) に戻す。GRANT はもともと変えていないため触らない。
--   "Admins can create audit logs": WITH CHECK (本人のロールが admin / super_admin / support のどれか)
--   "audit_logs_insert_admins":     WITH CHECK (actor_id = auth.uid() かつ 運営の 6 ロールのどれか)
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "audit_logs_insert_admins" ON "public"."admin_audit_logs";
CREATE POLICY "audit_logs_insert_admins" ON "public"."admin_audit_logs"
  FOR INSERT TO public
  WITH CHECK ((("actor_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text", 'sales'::"text", 'finance'::"text", 'content_moderator'::"text"] && "user_profiles"."roles"))))));

DROP POLICY IF EXISTS "Admins can create audit logs" ON "public"."admin_audit_logs";
CREATE POLICY "Admins can create audit logs" ON "public"."admin_audit_logs"
  FOR INSERT TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"])))));
