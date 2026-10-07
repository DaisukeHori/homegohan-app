-- rollback: 20261007062143_codify_membership_audit_select_admin.sql
-- 本番での挙動は変わらない (この migration は本番の定義を明文化しただけ)。通常は戻す必要は無い。
--
-- 内容: 2026-10-06 時点の本番の定義 (supabase/baseline/catalog/catalog_policies.csv) へ戻す。
--       この migration と同じ定義のため、戻しても認可は変わらない。
-- ⚠️ 20260511000104_membership_audit.sql の家族スコープ付きの定義へは戻さないこと。
--    family_members の SELECT ポリシーが自分自身を参照しているため、membership_audit の SELECT が
--    全員 42P17 (infinite recursion detected in policy for relation "family_members") になる。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "membership_audit_select_admin" ON "public"."membership_audit";
CREATE POLICY "membership_audit_select_admin" ON "public"."membership_audit" FOR SELECT USING ((("scope" = 'organization'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "membership_audit"."scope_id") AND ("user_profiles"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"])))))));
