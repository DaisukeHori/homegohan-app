-- rollback: 20261007063110_fix_family_rls_recursion.sql
-- ⚠️ 不具合の再発: 戻すと、ログインユーザーのセッションで family_members / family_groups / family_invites を
--    読むと再び 42P17 (infinite recursion detected in policy for relation "family_members") になる (#1257)。
--    家族の画面がデータを読めなくなるため、明示的な承認を得た場合に限って使う。
--
-- 内容: 20260511000114_membership_family_rls.sql の定義 (= 2026-10-06 時点の本番) へ戻し、ヘルパー関数を削除する。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "family_members_select_self_or_family" ON "public"."family_members";
CREATE POLICY "family_members_select_self_or_family" ON "public"."family_members" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."family_members" "fm"
  WHERE (("fm"."family_id" = "family_members"."family_id") AND ("fm"."user_id" = "auth"."uid"()) AND ("fm"."status" = 'active'::"text"))))));

DROP POLICY IF EXISTS "family_members_update_self_or_adult" ON "public"."family_members";
CREATE POLICY "family_members_update_self_or_adult" ON "public"."family_members" FOR UPDATE USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."family_members" "fm"
  WHERE (("fm"."family_id" = "family_members"."family_id") AND ("fm"."user_id" = "auth"."uid"()) AND ("fm"."role" = ANY (ARRAY['representative'::"public"."family_role_enum", 'adult'::"public"."family_role_enum"])) AND ("fm"."status" = 'active'::"text"))))));

DROP POLICY IF EXISTS "family_groups_select_member" ON "public"."family_groups";
CREATE POLICY "family_groups_select_member" ON "public"."family_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."family_members" "fm"
  WHERE (("fm"."family_id" = "family_groups"."id") AND ("fm"."user_id" = "auth"."uid"()) AND ("fm"."status" = 'active'::"text")))));

DROP POLICY IF EXISTS "family_groups_update_adult" ON "public"."family_groups";
CREATE POLICY "family_groups_update_adult" ON "public"."family_groups" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."family_members" "fm"
  WHERE (("fm"."family_id" = "family_groups"."id") AND ("fm"."user_id" = "auth"."uid"()) AND ("fm"."role" = ANY (ARRAY['representative'::"public"."family_role_enum", 'adult'::"public"."family_role_enum"])) AND ("fm"."status" = 'active'::"text")))));

DROP POLICY IF EXISTS "family_invites_select_adult" ON "public"."family_invites";
CREATE POLICY "family_invites_select_adult" ON "public"."family_invites" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."family_members" "fm"
  WHERE (("fm"."family_id" = "family_invites"."family_id") AND ("fm"."user_id" = "auth"."uid"()) AND ("fm"."role" = ANY (ARRAY['representative'::"public"."family_role_enum", 'adult'::"public"."family_role_enum"])) AND ("fm"."status" = 'active'::"text")))));

DROP POLICY IF EXISTS "family_invites_insert_adult" ON "public"."family_invites";
CREATE POLICY "family_invites_insert_adult" ON "public"."family_invites" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."family_members" "fm"
  WHERE (("fm"."family_id" = "family_invites"."family_id") AND ("fm"."user_id" = "auth"."uid"()) AND ("fm"."role" = ANY (ARRAY['representative'::"public"."family_role_enum", 'adult'::"public"."family_role_enum"])) AND ("fm"."status" = 'active'::"text")))));

DROP POLICY IF EXISTS "family_invites_update_adult" ON "public"."family_invites";
CREATE POLICY "family_invites_update_adult" ON "public"."family_invites" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."family_members" "fm"
  WHERE (("fm"."family_id" = "family_invites"."family_id") AND ("fm"."user_id" = "auth"."uid"()) AND ("fm"."role" = ANY (ARRAY['representative'::"public"."family_role_enum", 'adult'::"public"."family_role_enum"])) AND ("fm"."status" = 'active'::"text")))));

DROP FUNCTION IF EXISTS public.is_active_family_member(uuid);
DROP FUNCTION IF EXISTS public.is_active_family_adult(uuid);
