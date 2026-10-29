-- rollback: 20261025120000_operator_session_writes_select_only.sql
-- #1917 の続きで消した・SELECT だけにした運営の書き込みのポリシー 17 本と、条件を足した利用者の INSERT のポリシー 3 本と、
-- 外した書き込みの権限を、元に戻す。
-- 運営の書き込みのポリシーは、本冊の直前の形に作り直す (名前・種類 (FOR)・TO・式はそのまま):
--   20261017130000_operator_mfa_db_gate.sql の ALTER POLICY (:377・:381・:386・:390・:392・:393・:394・:398・:405・:417・:418・:420・
--   :421・:423・:425・:428) の後の形 (TO authenticated・運営の MFA の判定つき)。organization_invites の "Org admins can delete invites" は
--   20261022180000_org_tables_rpc_only_writes.sql:191 の形。FOR ALL のポリシーは FOR を書かない (ベースラインの形)。
--   組織の 3 本と ticket_messages_insert は消していない (運営の枝を外しただけ) ので、ALTER POLICY で元の式に戻す。
-- 利用者の INSERT のポリシー 3 本は、ベースライン (20251126124224_create_meal_planner_tables.sql) の式と TO に ALTER POLICY で戻す:
--   :9594 "Anyone can create recipe flags" (TO authenticated)・:9590 "Anyone can create inquiries" (TO authenticated, anon)・
--   :10979 tickets_insert_user (TO なし = public)。
-- 権限は、本冊の直前に anon / authenticated が持っていた INSERT / UPDATE / DELETE だけを付け直す (どれもベースラインの GRANT ALL の
-- 残り。本冊の前に外した migration は無い)。TRUNCATE は付け直さない (本冊の適用の直前の時点で、
-- 20261022190000_db_privilege_hardening.sql が anon / authenticated から外してある。本冊は TRUNCATE に触れていない)。
-- (tests/operator-session-writes-select-only-migration-contract.test.ts が、流した後の状態が本冊の直前の状態と同じことを見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、運営 (MFA 済み) が PostgREST からクーポン・実験・機能フラグ・機能パッケージ・プラン (価格の列を含む)・システム設定・
--     営業リード・問い合わせ・サポートのチケット・管理ノートを直接書けるようになり、運営の API と監査ログを通らない穴が再び開く。
--     利用者は、判定済みの通報・対応済みの問い合わせ・担当の付いたチケットを自分で作れるようになる。
--   - アプリ (運営の API は service_role で書く) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する。ALTER POLICY と GRANT は何度流しても同じ)。

SET LOCAL lock_timeout = '10s';

GRANT INSERT, UPDATE, DELETE ON TABLE public.admin_user_notes TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.coupons TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.experiment_assignments TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.experiments TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.feature_flags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.feature_packages TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.sales_lead_activities TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.sales_leads TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.subscription_plans TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.system_settings TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.inquiries TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.support_tickets TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.support_ticket_messages TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.departments TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.organization_challenges TO anon, authenticated;

DROP POLICY IF EXISTS "Admins can view user notes" ON public.admin_user_notes;
DROP POLICY IF EXISTS "Admins can manage user notes" ON public.admin_user_notes;
CREATE POLICY "Admins can manage user notes" ON public.admin_user_notes TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text]) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS coupons_mutate_sales_or_above ON public.coupons;
CREATE POLICY coupons_mutate_sales_or_above ON public.coupons TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS experiment_assignments_delete_super_admin ON public.experiment_assignments;
CREATE POLICY experiment_assignments_delete_super_admin ON public.experiment_assignments FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS experiments_select_super_admin ON public.experiments;
CREATE POLICY experiments_select_super_admin ON public.experiments TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS feature_flags_select_super_admin ON public.feature_flags;
DROP POLICY IF EXISTS feature_flags_super_admin_all ON public.feature_flags;
CREATE POLICY feature_flags_super_admin_all ON public.feature_flags TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS feature_packages_select_super_admin ON public.feature_packages;
DROP POLICY IF EXISTS feature_packages_mutate_super_admin ON public.feature_packages;
CREATE POLICY feature_packages_mutate_super_admin ON public.feature_packages TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS "Admins can update inquiries" ON public.inquiries;
CREATE POLICY "Admins can update inquiries" ON public.inquiries FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text]) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS sales_activities_select ON public.sales_lead_activities;
DROP POLICY IF EXISTS sales_activities_access ON public.sales_lead_activities;
CREATE POLICY sales_activities_access ON public.sales_lead_activities TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS sales_leads_select ON public.sales_leads;
DROP POLICY IF EXISTS sales_leads_access ON public.sales_leads;
CREATE POLICY sales_leads_access ON public.sales_leads TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS subscription_plans_mutate_super_admin ON public.subscription_plans;
CREATE POLICY subscription_plans_mutate_super_admin ON public.subscription_plans TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS tickets_insert_staff ON public.support_tickets;
CREATE POLICY tickets_insert_staff ON public.support_tickets FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));
DROP POLICY IF EXISTS tickets_update_support ON public.support_tickets;
CREATE POLICY tickets_update_support ON public.support_tickets FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS "Super admins can update system settings" ON public.system_settings;
CREATE POLICY "Super admins can update system settings" ON public.system_settings TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

ALTER POLICY "Org admins can manage departments" ON public.departments TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = departments.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));
ALTER POLICY "Org admins can manage challenges" ON public.organization_challenges TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_challenges.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));
ALTER POLICY "Org admins can delete invites" ON public.organization_invites TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_invites.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));
ALTER POLICY ticket_messages_insert ON public.support_ticket_messages TO authenticated WITH CHECK (((sender_id = auth.uid()) AND (((NOT is_internal) AND (EXISTS ( SELECT 1 FROM support_tickets t WHERE ((t.id = support_ticket_messages.ticket_id) AND (t.user_id = auth.uid()))))) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))))));

ALTER POLICY "Anyone can create recipe flags" ON public.recipe_flags TO authenticated WITH CHECK ((reporter_id = auth.uid()));
ALTER POLICY "Anyone can create inquiries" ON public.inquiries TO authenticated, anon WITH CHECK (true);
ALTER POLICY tickets_insert_user ON public.support_tickets TO public WITH CHECK ((user_id = auth.uid()));
