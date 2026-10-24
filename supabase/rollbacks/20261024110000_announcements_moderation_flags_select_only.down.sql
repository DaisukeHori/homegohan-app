-- rollback: 20261024110000_announcements_moderation_flags_select_only.sql
-- #1917 の続きで SELECT だけにした announcements と moderation_flags の運営のポリシーと、消した recipe_flags の運営の UPDATE の
-- ポリシーと、消した personal_subscriptions の運営の INSERT / UPDATE のポリシーと、外した書き込みの権限を、元に戻す。
-- ポリシーは 20261017130000_operator_mfa_db_gate.sql の :379 (announcements)・:402 (moderation_flags)・:413 (recipe_flags)・
-- :409 / :411 (personal_subscriptions) の後の形 (TO authenticated・運営の MFA の判定つき) に作り直す (名前・式はそのまま。
-- announcements と moderation_flags は FOR の無い形 = FOR ALL、recipe_flags はベースライン :9536 の FOR UPDATE、
-- personal_subscriptions は 20261016210000_billing_core.sql:51・:55 の FOR INSERT・FOR UPDATE)。
-- 権限は、本冊の直前に anon / authenticated が持っていた INSERT / UPDATE / DELETE だけを付け直す:
--   announcements・moderation_flags・recipe_flags は、本番のベースライン (20251126124224_create_meal_planner_tables.sql の
--   :13460-13461・:13726-13727・:13814-13815) が付けていたとおり anon と authenticated に付け直す (recipe_flags の authenticated の
--   INSERT は本冊が外していないが、GRANT は何度流しても同じなので 3 つとも同じ形で付け直す)。
--   personal_subscriptions は authenticated だけに付け直す (anon の INSERT / UPDATE / DELETE は本冊の前に 20261016210000:63 が
--   外してある)。
-- TRUNCATE は付け直さない: 本冊の適用の直前の時点で、20261022190000_db_privilege_hardening.sql が anon / authenticated から外してある
-- (本冊は TRUNCATE に触れていない)。
-- (tests/announcements-moderation-flags-select-only-migration-contract.test.ts が、流した後の状態が本冊の直前の状態と同じことを見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、運営 (admin / super_admin・MFA 済み) が PostgREST からお知らせと通報 (食事・レシピ) と個人の契約を直接書けるように
--     なり、運営の API と監査ログ (と契約の関数の不変条件) を通らない穴が再び開く。
--   - アプリ (POST /api/announcements と運営の通報の API は service_role で書く。契約はサーバーが service_role で SECURITY DEFINER の
--     関数を呼ぶ) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する。GRANT は何度流しても同じ)。

SET LOCAL lock_timeout = '10s';

GRANT INSERT, UPDATE, DELETE ON TABLE public.announcements TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.moderation_flags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.recipe_flags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.personal_subscriptions TO authenticated;

DROP POLICY IF EXISTS "Admins can view announcements" ON public.announcements;
DROP POLICY IF EXISTS "Admins can manage announcements" ON public.announcements;
CREATE POLICY "Admins can manage announcements" ON public.announcements TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS moderation_flags_admin_select ON public.moderation_flags;
DROP POLICY IF EXISTS moderation_flags_admin_all ON public.moderation_flags;
CREATE POLICY moderation_flags_admin_all ON public.moderation_flags TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS "Admins can update recipe flags" ON public.recipe_flags;
CREATE POLICY "Admins can update recipe flags" ON public.recipe_flags FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS personal_subscriptions_insert_admin ON public.personal_subscriptions;
CREATE POLICY personal_subscriptions_insert_admin ON public.personal_subscriptions FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));
DROP POLICY IF EXISTS personal_subscriptions_update_admin ON public.personal_subscriptions;
CREATE POLICY personal_subscriptions_update_admin ON public.personal_subscriptions FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));
