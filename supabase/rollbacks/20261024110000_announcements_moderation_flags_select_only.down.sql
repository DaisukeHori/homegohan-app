-- rollback: 20261024110000_announcements_moderation_flags_select_only.sql
-- #1917 の続きで SELECT だけにした announcements と moderation_flags の運営のポリシーと、外した書き込みの権限を、元に戻す。
-- ポリシーは 20261017130000_operator_mfa_db_gate.sql の :379 (announcements) と :402 (moderation_flags) の後の形
-- (FOR ALL・TO authenticated・運営の MFA の判定つき) に作り直す (名前・式はそのまま。FOR の無い形 = FOR ALL)。
-- 権限は、本番のベースライン (20251126124224_create_meal_planner_tables.sql の :13460-13461 と :13726-13727) が
-- anon / authenticated に付けていた INSERT / UPDATE / DELETE だけを付け直す。TRUNCATE は付け直さない: 本冊の適用の直前の時点で、
-- 20261022190000_db_privilege_hardening.sql が anon / authenticated から外してある (本冊は TRUNCATE に触れていない)。
-- (tests/announcements-moderation-flags-select-only-migration-contract.test.ts が、流した後の状態が本冊の直前の状態と同じことを見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、運営 (admin / super_admin・MFA 済み) が PostgREST からお知らせと通報を直接書けるようになり、運営の API と監査ログを
--     通らない穴が再び開く。
--   - アプリ (POST /api/announcements と運営の通報の API は service_role で書く) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する。GRANT は何度流しても同じ)。

SET LOCAL lock_timeout = '10s';

GRANT INSERT, UPDATE, DELETE ON TABLE public.announcements TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.moderation_flags TO anon, authenticated;

DROP POLICY IF EXISTS "Admins can view announcements" ON public.announcements;
DROP POLICY IF EXISTS "Admins can manage announcements" ON public.announcements;
CREATE POLICY "Admins can manage announcements" ON public.announcements TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS moderation_flags_admin_select ON public.moderation_flags;
DROP POLICY IF EXISTS moderation_flags_admin_all ON public.moderation_flags;
CREATE POLICY moderation_flags_admin_all ON public.moderation_flags TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));
