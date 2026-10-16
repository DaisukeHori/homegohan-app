/**
 * #1707 運営ロールの MFA 段 E: DB を本人の JWT で直接呼ぶ経路の判定
 * (supabase/migrations/<番号>_operator_mfa_db_gate.sql) の文面の検査 (DB 無し)。
 * docs/design/cross/12-operator-mfa.md §11.4・§21.8・付録 A
 *
 * 確かめること:
 *   - public.operator_mfa_satisfied() が LANGUAGE sql・STABLE・SECURITY DEFINER・SET search_path = ''、REVOKE / GRANT の 2 行
 *   - 判定の関数の ARRAY[...]::text[] が MFA_REQUIRED_ROLES (src/lib/auth/mfa/policy.ts) と同じ集合
 *   - 7 本の関数: 判定 (IF NOT public.operator_mfa_satisfied() THEN) が 1 回だけ、役割の判定の RAISE より後・最初の更新 / ロックより前。
 *     判定の 4 行を取り除くと .down.sql の同じ関数と一致する (判定のほかに本文を変えていない)
 *   - ポリシー: 付録 A.1 の 55 文が 1 回ずつ (どれも TO authenticated と判定つき)・subscription_plans の 3 文・
 *     付録 A より後にできた運営の枝のポリシー (parental_consents) の 1 文。migration の ALTER / CREATE POLICY はこれで全部
 *   - down: 付録 A.2 の 56 文の式と TO の役割から作る指紋が付録 A.4 の digest / digest_full と一致する (設計書から写した文が
 *     2026-10-16 の本番の式のまま)。subscription_plans_select_operator の DROP・parental_consents を元に戻す 1 文・
 *     7 本の関数に判定が無い・最後の文が DROP FUNCTION IF EXISTS public.operator_mfa_satisfied();
 *   - 型の生成物 2 ファイルの Functions に operator_mfa_satisfied (Args never・Returns boolean)
 *   - 冒頭のコメントの参照先が実在する
 * 実 DB での確認は tests/integration/security/operator-mfa-db-gate.test.ts (DB-1〜DB-11)。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';

const ROOT = path.resolve(__dirname, '..');
const STEM = 'operator_mfa_db_gate';
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;

/** 付録 A.4 の本番の指紋 (2026-10-16)。A.2 の 56 文の (表|ポリシー|roles|md5(qual)|md5(with_check)) を表・ポリシーのバイト順に改行でつないだ md5 */
const APPENDIX_A4_DIGEST = 'c5c09b156d8a3c552d9c139ec66d9f99';
/** 付録 A.4 の digest_full (md5 をとらない式そのものをつないだ md5) */
const APPENDIX_A4_DIGEST_FULL = '7a5d88795aeff336494a5e066bf9ca1c';
/** 付録 A.4: 母集合の数・TO public の数・TO authenticated の数 */
const APPENDIX_A_POLICY_COUNT = 56;
const APPENDIX_A_PUBLIC_COUNT = 53;
const APPENDIX_A_AUTHENTICATED_COUNT = 3;

/** 判定の 4 行 (§11.4 の 3。字下げは 2 つの空白) */
const GATE_LINES = [
  '  -- #1176 (docs/design/cross/12-operator-mfa.md §11.4): TOTP を登録済みの必須ロールの呼び出し元は、aal2 のセッションでなければ止める',
  '  IF NOT public.operator_mfa_satisfied() THEN',
  "    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED' USING ERRCODE = 'P0001';",
  '  END IF;',
] as const;

/** §11.4 の表: 関数の名前と、役割の判定のエラー (4 列目) */
const GATED_FUNCTIONS = [
  { name: 'admin_set_user_roles', roleError: 'FORBIDDEN' },
  { name: 'list_families_with_inactive_representative', roleError: 'INSUFFICIENT_PERMISSION' },
  { name: 'list_orgs_with_inactive_owner', roleError: 'INSUFFICIENT_PERMISSION' },
  { name: 'operator_force_dissolve_org', roleError: 'OPERATOR_PERMISSION_REQUIRED' },
  { name: 'operator_force_owner_transfer', roleError: 'NOT_OPERATOR' },
  { name: 'operator_force_dissolve_family', roleError: 'NOT_OPERATOR' },
  { name: 'operator_force_representative_transfer', roleError: 'NOT_OPERATOR' },
] as const;

/** 付録 A.1 の 55 文 (設計書から写したもの。1 行 = 1 文) */
const EXPECTED_DB_GATE_POLICY_STATEMENTS = [
  "ALTER POLICY \"Admins can view audit logs\" ON public.admin_audit_logs TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY audit_logs_insert_admins ON public.admin_audit_logs TO authenticated WITH CHECK (((actor_id = auth.uid()) AND (action_type !~~ 'system.%'::text) AND (actor_email_snapshot IS NULL) AND (actor_role_snapshot IS NULL) AND (impersonated_by IS NULL) AND (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text, 'support'::text, 'sales'::text, 'finance'::text, 'content_moderator'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY audit_logs_select_super_admin ON public.admin_audit_logs TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Admins can manage user notes\" ON public.admin_user_notes TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text]) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Users and admins can view ai logs\" ON public.ai_content_logs TO authenticated USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY \"Admins can manage announcements\" ON public.announcements TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY coupon_redemptions_select ON public.coupon_redemptions TO authenticated USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['finance'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY coupons_mutate_sales_or_above ON public.coupons TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY coupons_select_sales_or_above ON public.coupons TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'finance'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY csat_access ON public.csat_feedbacks TO authenticated USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY dau_select_admin ON public.daily_active_users TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text, 'finance'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY data_subject_requests_select_operator ON public.data_subject_requests TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = ( SELECT auth.uid() AS uid)) AND ((ARRAY['admin'::text, 'super_admin'::text] && up.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Org admins can manage departments\" ON public.departments TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = departments.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY email_blacklist_admin ON public.email_blacklist TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY email_logs_admin ON public.email_delivery_logs TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Super admin can view\" ON public.embedding_jobs TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY experiment_assignments_delete_super_admin ON public.experiment_assignments TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY experiment_assignments_select_super_admin ON public.experiment_assignments TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY experiments_select_super_admin ON public.experiments TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY feature_flags_super_admin_all ON public.feature_flags TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY feature_packages_mutate_super_admin ON public.feature_packages TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY help_articles_manage ON public.help_articles TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text, 'support'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY infra_alerts_access ON public.infra_alerts TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY infra_select_super_admin ON public.infra_metrics TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Admins can update inquiries\" ON public.inquiries TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text]) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Admins can view all inquiries\" ON public.inquiries TO authenticated USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text]) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY llm_usage_logs_select_super_admin ON public.llm_usage_logs TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY membership_audit_select_operator ON public.membership_audit TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY moderation_flags_admin_all ON public.moderation_flags TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY nps_select_admin ON public.nps_surveys TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text, 'support'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Org admins can view own stats\" ON public.org_daily_stats TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = org_daily_stats.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY \"Org admins can manage challenges\" ON public.organization_challenges TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_challenges.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY \"Org admins can manage invites\" ON public.organization_invites TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_invites.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY \"Org admins can manage reports\" ON public.organization_reports TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_reports.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY organizations_delete_super_admin ON public.organizations TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY personal_subscriptions_insert_admin ON public.personal_subscriptions TO authenticated WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY personal_subscriptions_select ON public.personal_subscriptions TO authenticated USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text, 'finance'::text, 'support'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY personal_subscriptions_update_admin ON public.personal_subscriptions TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY plan_price_history_select ON public.plan_price_history TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text, 'finance'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Admins can update recipe flags\" ON public.recipe_flags TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Users and admins can view recipe flags\" ON public.recipe_flags TO authenticated USING (((reporter_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY referral_rewards_select ON public.referral_rewards TO authenticated USING (((referrer_id = auth.uid()) OR (referred_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY revenue_snapshots_select ON public.revenue_snapshots TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['finance'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY sales_activities_access ON public.sales_lead_activities TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY sales_leads_access ON public.sales_leads TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY sport_presets_mutate_super_admin ON public.sport_presets TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY subscription_plans_mutate_super_admin ON public.subscription_plans TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied())))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY ticket_messages_insert ON public.support_ticket_messages TO authenticated WITH CHECK (((sender_id = auth.uid()) AND (((NOT is_internal) AND (EXISTS ( SELECT 1 FROM support_tickets t WHERE ((t.id = support_ticket_messages.ticket_id) AND (t.user_id = auth.uid()))))) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))))));",
  "ALTER POLICY ticket_messages_select ON public.support_ticket_messages TO authenticated USING ((((NOT is_internal) AND (EXISTS ( SELECT 1 FROM support_tickets t WHERE ((t.id = support_ticket_messages.ticket_id) AND (t.user_id = auth.uid()))))) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY tickets_insert_staff ON public.support_tickets TO authenticated WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY tickets_select ON public.support_tickets TO authenticated USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied())))))));",
  "ALTER POLICY tickets_update_support ON public.support_tickets TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Admins can view system stats\" ON public.system_daily_stats TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Admins can view system settings\" ON public.system_settings TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));",
  "ALTER POLICY \"Super admins can update system settings\" ON public.system_settings TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));",
] as const;

/** 付録 A.1 の subscription_plans の 3 文 (公開の枝だけ残す・運営の枝を新しいポリシーに分ける) */
const EXPECTED_SUBSCRIPTION_PLANS_STATEMENTS = [
  "ALTER POLICY subscription_plans_select_public ON public.subscription_plans TO PUBLIC USING (((status)::text = ANY ((ARRAY['public'::character varying, 'private'::character varying])::text[])));",
  "DROP POLICY IF EXISTS subscription_plans_select_operator ON public.subscription_plans;",
  "CREATE POLICY subscription_plans_select_operator ON public.subscription_plans FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM public.user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));",
] as const;

/**
 * 付録 A (2026-10-16 の本番) より後の migration が作った運営の枝のポリシー。付録 A.3 と同じ見つけ方に当たるので、同じ規則で判定を足す。
 * parental_consents_select_signer_family_adult_or_operator: supabase/migrations/20261017030000_parental_consent_and_birth_date.sql (#1173)
 */
const POST_APPENDIX_POLICY_UP =
  "ALTER POLICY parental_consents_select_signer_family_adult_or_operator ON public.parental_consents TO authenticated USING (((parent_user_id = ( SELECT auth.uid() AS uid)) OR public.is_active_family_adult(family_id) OR (EXISTS ( SELECT 1 FROM public.user_profiles up WHERE ((up.id = auth.uid()) AND ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));";
const POST_APPENDIX_POLICY_DOWN =
  "ALTER POLICY parental_consents_select_signer_family_adult_or_operator ON public.parental_consents TO authenticated USING (((parent_user_id = ( SELECT auth.uid() AS uid)) OR public.is_active_family_adult(family_id) OR (EXISTS ( SELECT 1 FROM public.user_profiles up WHERE ((up.id = auth.uid()) AND (up.roles && ARRAY['admin'::text, 'super_admin'::text]))))));";

const GATE_CALL = '(SELECT public.operator_mfa_satisfied())';

function migrationFile(): string {
  const files = fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).filter((f) => new RegExp(`^\\d{14}_${STEM}\\.sql$`).test(f));
  expect(files).toHaveLength(1);
  return files[0];
}

const MIGRATION_FILE = migrationFile();
const ROLLBACK_FILE = MIGRATION_FILE.replace(/\.sql$/, '.down.sql');
const rawMigration = fs.readFileSync(path.join(ROOT, MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
const rawRollback = fs.readFileSync(path.join(ROOT, ROLLBACKS_DIR, ROLLBACK_FILE), 'utf8');

/** SQL のコメント (-- から行末) を外す。文字列の中の -- は扱わない (この migration の文字列に -- は無い) */
function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

/** 空白をまとめる */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** 行の一覧 (前後の空白を落とした、空でない行) */
function statementLines(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 関数の CREATE OR REPLACE の文 (宣言から本体の閉じ $$; まで) をすべて返す。名前は "public"."x" と public.x の両方の書き方を受ける */
function createFunctionStatements(sql: string, name: string): string[] {
  const head = new RegExp(`CREATE OR REPLACE FUNCTION (?:"public"\\."${escapeRegExp(name)}"|public\\.${escapeRegExp(name)})\\(`, 'g');
  const found: string[] = [];
  for (const match of sql.matchAll(head)) {
    const start = match.index ?? 0;
    const bodyOpen = sql.indexOf('$$', start);
    const bodyClose = sql.indexOf('$$;', bodyOpen + 2);
    expect(bodyOpen, `${name} の本体の始まり`).toBeGreaterThan(start);
    expect(bodyClose, `${name} の本体の終わり`).toBeGreaterThan(bodyOpen);
    found.push(sql.slice(start, bodyClose + '$$;'.length));
  }
  return found;
}

/** ( の位置から、対になる ) の位置を返す ('...' の中の括弧は数えない) */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`括弧が閉じていない: ${text.slice(open, open + 80)}`);
}

interface PolicyFingerprintRow {
  readonly tablename: string;
  readonly policyname: string;
  readonly roles: string;
  readonly qual: string;
  readonly withCheck: string;
}

/** ALTER POLICY の 1 行を、pg_policies の (表・ポリシー・roles・qual・with_check) に分ける (付録 A.4 の指紋の材料) */
function parseAlterPolicy(line: string): PolicyFingerprintRow {
  const match = /^ALTER POLICY ("[^"]+"|\w+) ON public\.(\w+) TO (PUBLIC|authenticated)( .*);$/.exec(line);
  if (!match) throw new Error(`ALTER POLICY の形でない: ${line}`);
  let rest = match[4];
  let qual = '';
  let withCheck = '';
  const using = /^ USING \(/.exec(rest);
  if (using) {
    const open = using[0].length - 1;
    const close = closingParen(rest, open);
    qual = rest.slice(open + 1, close);
    rest = rest.slice(close + 1);
  }
  const check = /^ WITH CHECK \(/.exec(rest);
  if (check) {
    const open = check[0].length - 1;
    const close = closingParen(rest, open);
    withCheck = rest.slice(open + 1, close);
    rest = rest.slice(close + 1);
  }
  expect(rest, line).toBe('');
  return {
    tablename: match[2],
    policyname: match[1].replace(/^"|"$/g, ''),
    roles: match[3] === 'PUBLIC' ? '{public}' : '{authenticated}',
    qual,
    withCheck,
  };
}

function md5(text: string): string {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/** COLLATE "C" (バイト順) の比較。表とポリシーの名前は ASCII だけなので、UTF-16 の比較と同じ */
function byteOrder(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const migrationCode = stripSqlComments(rawMigration);
const rollbackCode = stripSqlComments(rawRollback);
const migrationPolicyLines = statementLines(migrationCode).filter((line) => /^(ALTER|CREATE|DROP) POLICY /.test(line));
const rollbackPolicyLines = statementLines(rollbackCode).filter((line) => /^(ALTER|CREATE|DROP) POLICY /.test(line));

describe('operator_mfa_db_gate の migration: 判定の関数', () => {
  it("operator_mfa_satisfied: CREATE OR REPLACE FUNCTION public.operator_mfa_satisfied() が LANGUAGE sql・STABLE・SECURITY DEFINER・SET search_path = '' で、REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role と GRANT EXECUTE ... TO authenticated, service_role の 2 行がある", () => {
    const statements = createFunctionStatements(rawMigration, 'operator_mfa_satisfied');
    expect(statements).toHaveLength(1);
    expect(squash(statements[0])).toMatch(
      /^CREATE OR REPLACE FUNCTION public\.operator_mfa_satisfied\(\) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS \$\$/,
    );
    const flat = squash(migrationCode);
    const revoke = 'REVOKE ALL ON FUNCTION public.operator_mfa_satisfied() FROM PUBLIC, anon, authenticated, service_role;';
    const grant = 'GRANT EXECUTE ON FUNCTION public.operator_mfa_satisfied() TO authenticated, service_role;';
    expect(flat).toContain(revoke);
    expect(flat).toContain(grant);
    expect(flat.indexOf(revoke)).toBeLessThan(flat.indexOf(grant));
    // 判定の関数に効く GRANT はこの 1 行だけ (anon には付けない)
    expect(flat.match(/GRANT [A-Z ,]+ ON FUNCTION public\.operator_mfa_satisfied\(\)/g)).toHaveLength(1);
    // 本体: aal2・必須ロール・verified な totp の 3 つの枝 (§11.4 の 2 の逐語)
    const body = squash(statements[0]);
    expect(body).toContain("COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2'");
    expect(body).toContain('FROM public.user_profiles up WHERE up.id = auth.uid()');
    expect(body).toContain("FROM auth.mfa_factors f WHERE f.user_id = auth.uid() AND f.factor_type = 'totp' AND f.status = 'verified'");
  });

  it('operator_mfa_satisfied の ARRAY[...]::text[] の要素が src/lib/auth/mfa/policy.ts の MFA_REQUIRED_ROLES と同じ集合', () => {
    const [statement] = createFunctionStatements(rawMigration, 'operator_mfa_satisfied');
    const arrays = [...statement.matchAll(/ARRAY\[([^\]]*)\]::text\[\]/g)];
    expect(arrays).toHaveLength(1);
    const roles = [...arrays[0][1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(roles)).toEqual(new Set(MFA_REQUIRED_ROLES));
    expect(roles).toHaveLength(MFA_REQUIRED_ROLES.length);
  });
});

describe('operator_mfa_db_gate の migration: 運営ロールを確かめる関数 7 本', () => {
  it.each(GATED_FUNCTIONS)(
    '$name: CREATE OR REPLACE がちょうど 1 つで、判定がちょうど 1 回、役割の判定の RAISE ($roleError) より後・最初の PERFORM / UPDATE / RETURN QUERY / INSERT より前',
    ({ name, roleError }) => {
      const statements = createFunctionStatements(rawMigration, name);
      expect(statements).toHaveLength(1);
      const code = stripSqlComments(statements[0]);
      expect(code.match(/IF NOT public\.operator_mfa_satisfied\(\) THEN/g)).toHaveLength(1);
      const gateAt = code.indexOf('IF NOT public.operator_mfa_satisfied() THEN');
      const roleRaiseAt = code.indexOf(`RAISE EXCEPTION '${roleError}'`);
      expect(roleRaiseAt, roleError).toBeGreaterThan(0);
      expect(roleRaiseAt).toBeLessThan(gateAt);
      // 役割の判定の END IF; の直後の行に判定がある (間に別の文を挟まない)
      expect(code.slice(roleRaiseAt, gateAt)).toMatch(/^RAISE EXCEPTION '[A-Z_]+' USING ERRCODE = 'P0001';\s+END IF;\s+$/);
      const firstWrite = code.slice(gateAt).search(/\b(PERFORM|UPDATE|RETURN QUERY|INSERT)\b/);
      const before = code.slice(0, gateAt);
      expect(before, '判定より前に更新・ロックが無い').not.toMatch(/\b(PERFORM|UPDATE|RETURN QUERY|INSERT)\b/);
      expect(firstWrite, '判定の後に本文の更新・ロック・結果がある').toBeGreaterThan(0);
      // 判定の 4 行は §11.4 の逐語 (字下げを含む)
      expect(statements[0]).toContain(GATE_LINES.join('\n'));
    },
  );

  it.each(GATED_FUNCTIONS)(
    '$name: migration の CREATE OR REPLACE から判定の 4 行を取り除いた文が、.down.sql の同じ関数の CREATE OR REPLACE と、空白をまとめたうえで一致する',
    ({ name }) => {
      const [gated] = createFunctionStatements(rawMigration, name);
      const restored = createFunctionStatements(rawRollback, name);
      expect(restored).toHaveLength(1);
      const withoutGate = gated.replace(`${GATE_LINES.join('\n')}\n`, '');
      expect(withoutGate).not.toContain('operator_mfa_satisfied');
      expect(squash(withoutGate)).toBe(squash(restored[0]));
    },
  );
});

describe('operator_mfa_db_gate の migration: RLS のポリシー', () => {
  it(`ポリシー: 付録 A.1 の 55 文が migration にそのまま 1 回ずつあり、どれも TO authenticated と ${GATE_CALL} を含む`, () => {
    expect(EXPECTED_DB_GATE_POLICY_STATEMENTS).toHaveLength(APPENDIX_A_POLICY_COUNT - 1);
    for (const statement of EXPECTED_DB_GATE_POLICY_STATEMENTS) {
      expect(migrationPolicyLines.filter((line) => line === statement), statement).toHaveLength(1);
      expect(statement).toContain(' TO authenticated ');
      expect(statement).toContain(GATE_CALL);
    }
    // USING と WITH CHECK を両方持つ 5 本は、どちらにも判定がある
    const both = EXPECTED_DB_GATE_POLICY_STATEMENTS.filter((s) => s.includes(' USING (') && s.includes(' WITH CHECK ('));
    expect(both).toHaveLength(5);
    for (const statement of both) {
      expect(statement.split(GATE_CALL).length - 1, statement).toBe(2);
    }
  });

  it('subscription_plans の 3 文がある (公開の枝は TO PUBLIC のまま判定を持たず、運営の枝は subscription_plans_select_operator (TO authenticated・判定つき))', () => {
    expect(EXPECTED_SUBSCRIPTION_PLANS_STATEMENTS).toHaveLength(3);
    for (const statement of EXPECTED_SUBSCRIPTION_PLANS_STATEMENTS) {
      expect(migrationPolicyLines.filter((line) => line === statement), statement).toHaveLength(1);
    }
    const [selectPublic, dropOperator, createOperator] = EXPECTED_SUBSCRIPTION_PLANS_STATEMENTS;
    expect(selectPublic).not.toContain('operator_mfa_satisfied');
    expect(selectPublic).toContain(' TO PUBLIC ');
    // DROP POLICY IF EXISTS は CREATE POLICY より前 (冪等)
    expect(migrationPolicyLines.indexOf(dropOperator)).toBeLessThan(migrationPolicyLines.indexOf(createOperator));
    expect(createOperator).toContain('FOR SELECT TO authenticated');
    expect(createOperator).toContain(GATE_CALL);
  });

  it('付録 A より後にできた運営の枝のポリシー (parental_consents_select_signer_family_adult_or_operator) にも同じ規則で判定を足す', () => {
    expect(migrationPolicyLines.filter((line) => line === POST_APPENDIX_POLICY_UP)).toHaveLength(1);
    // 本人の行の枝・家族の大人の枝は判定を通さない (運営の枝だけを置き換える)
    const operatorTerm = "(up.roles && ARRAY['admin'::text, 'super_admin'::text])";
    expect(POST_APPENDIX_POLICY_UP.split(GATE_CALL)).toHaveLength(2);
    expect(POST_APPENDIX_POLICY_UP.replace(`(${operatorTerm} AND ${GATE_CALL})`, operatorTerm)).toBe(POST_APPENDIX_POLICY_DOWN);
  });

  it('migration のポリシーの文は 55 + 3 + 1 の 59 行だけ (ほかのポリシーに触れない)', () => {
    const expected = [...EXPECTED_DB_GATE_POLICY_STATEMENTS, ...EXPECTED_SUBSCRIPTION_PLANS_STATEMENTS, POST_APPENDIX_POLICY_UP];
    expect([...migrationPolicyLines].sort()).toEqual([...expected].sort());
  });
});

describe('operator_mfa_db_gate のロールバック', () => {
  const appendixRows = rollbackPolicyLines
    .filter((line) => line.startsWith('ALTER POLICY ') && line !== POST_APPENDIX_POLICY_DOWN)
    .map(parseAlterPolicy)
    .sort((a, b) => byteOrder(a.tablename, b.tablename) || byteOrder(a.policyname, b.policyname));

  it('down の 56 文の式 (USING / WITH CHECK) と TO の役割から作った指紋が、付録 A.4 の digest・digest_full と一致する (設計書から写した文が本番の式のまま)', () => {
    expect(appendixRows).toHaveLength(APPENDIX_A_POLICY_COUNT);
    expect(appendixRows.filter((r) => r.roles === '{public}')).toHaveLength(APPENDIX_A_PUBLIC_COUNT);
    expect(appendixRows.filter((r) => r.roles === '{authenticated}')).toHaveLength(APPENDIX_A_AUTHENTICATED_COUNT);
    const digest = md5(appendixRows.map((r) => `${r.tablename}|${r.policyname}|${r.roles}|${md5(r.qual)}|${md5(r.withCheck)}`).join('\n'));
    const digestFull = md5(appendixRows.map((r) => `${r.tablename}|${r.policyname}|${r.roles}|${r.qual}|${r.withCheck}`).join('\n'));
    expect(digest).toBe(APPENDIX_A4_DIGEST);
    expect(digestFull).toBe(APPENDIX_A4_DIGEST_FULL);
  });

  it('down の 56 文は up の 55 文 + subscription_plans_select_public と同じポリシーを、判定の無い式に戻す', () => {
    const upNames = [...EXPECTED_DB_GATE_POLICY_STATEMENTS, EXPECTED_SUBSCRIPTION_PLANS_STATEMENTS[0]].map((s) => {
      const row = parseAlterPolicy(s);
      return `${row.tablename}|${row.policyname}`;
    });
    expect(appendixRows.map((r) => `${r.tablename}|${r.policyname}`).sort()).toEqual([...upNames].sort());
    for (const row of appendixRows) {
      expect(`${row.qual} ${row.withCheck}`, row.policyname).not.toContain('operator_mfa_satisfied');
    }
  });

  it('down: DROP POLICY IF EXISTS subscription_plans_select_operator と parental_consents を元に戻す 1 文があり、7 本の関数の CREATE OR REPLACE に operator_mfa_satisfied が出てこず、最後の文が DROP FUNCTION IF EXISTS public.operator_mfa_satisfied(); である', () => {
    expect(rollbackPolicyLines).toContain('DROP POLICY IF EXISTS subscription_plans_select_operator ON public.subscription_plans;');
    expect(rollbackPolicyLines.filter((line) => line === POST_APPENDIX_POLICY_DOWN)).toHaveLength(1);
    expect(rollbackPolicyLines).toHaveLength(APPENDIX_A_POLICY_COUNT + 2);
    for (const { name } of GATED_FUNCTIONS) {
      const statements = createFunctionStatements(rawRollback, name);
      expect(statements, name).toHaveLength(1);
      expect(statements[0], name).not.toContain('operator_mfa_satisfied');
    }
    const lines = statementLines(rollbackCode);
    expect(lines[lines.length - 1]).toBe('DROP FUNCTION IF EXISTS public.operator_mfa_satisfied();');
    // 判定の関数を落とすのは、ポリシーと 7 本の関数を戻した後 (ポリシーは判定の関数への依存が pg_depend に記録される)
    const flat = squash(rollbackCode);
    const dropAt = flat.indexOf('DROP FUNCTION IF EXISTS public.operator_mfa_satisfied();');
    expect(flat.lastIndexOf('ALTER POLICY ')).toBeLessThan(dropAt);
    expect(flat.lastIndexOf('CREATE OR REPLACE FUNCTION ')).toBeLessThan(dropAt);
  });

  it("migration と down の先頭に SET LOCAL lock_timeout = '10s'; がある", () => {
    expect(statementLines(migrationCode)[0]).toBe("SET LOCAL lock_timeout = '10s';");
    expect(statementLines(rollbackCode)[0]).toBe("SET LOCAL lock_timeout = '10s';");
  });
});

describe('operator_mfa_db_gate: 型と参照', () => {
  it('型の生成物 2 ファイルの Functions に operator_mfa_satisfied (Args never・Returns boolean) がある', () => {
    for (const file of TYPE_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const functionsAt = source.indexOf('\n    Functions: {');
      expect(functionsAt, file).toBeGreaterThan(0);
      expect(source.slice(functionsAt), file).toContain('\n      operator_mfa_satisfied: { Args: never; Returns: boolean }\n');
    }
  });

  it('冒頭のコメントの参照先が実在する', () => {
    const referenced = new Set(
      [...rawMigration.matchAll(/((?:supabase|tests|docs|src)\/[\w./-]+\.(?:sql|ts|md))/g)].map((m) => m[1]),
    );
    const rollbackRefs = [...rawRollback.matchAll(/^-- rollback: (\S+)$/gm)].map((m) => m[1]);
    expect(rollbackRefs).toEqual([MIGRATION_FILE]);
    expect(rawMigration).toContain(`-- migration: ${MIGRATION_FILE}`);
    expect(referenced).toContain(`${ROLLBACKS_DIR}/${ROLLBACK_FILE}`);
    expect(referenced).toContain('tests/operator-mfa-db-gate-migration-contract.test.ts');
    expect(referenced).toContain('tests/integration/security/operator-mfa-db-gate.test.ts');
    expect(referenced).toContain('tests/integration/security/anon-definer-execute.test.ts');
    expect(referenced).toContain('docs/design/cross/12-operator-mfa.md');
    for (const ref of referenced) {
      expect(fs.existsSync(path.join(ROOT, ref)), ref).toBe(true);
    }
  });
});
