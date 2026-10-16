-- rollback: 20261017130000_operator_mfa_db_gate.sql
-- 運営ロールの MFA の DB の判定 (段 E) を戻す。docs/design/cross/12-operator-mfa.md §11.4 のロールバックの順:
--   (a) ポリシー 56 本 (付録 A.2。2026-10-16 の本番の式と TO の役割) と subscription_plans_select_operator の DROP、付録 A より後の 1 本 (parental_consents)
--   (b) 7 本の関数を最新の定義のまま (判定の 4 行を足さずに) 写す
--   (c) 判定の関数を消す (ポリシーは判定の関数への依存が pg_depend に記録されるので、(a) より前には落とせない)
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- (a) ポリシー
-- ─────────────────────────────────────────────────────────
ALTER POLICY "Admins can view audit logs" ON public.admin_audit_logs TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text])))));
ALTER POLICY audit_logs_insert_admins ON public.admin_audit_logs TO authenticated WITH CHECK (((actor_id = auth.uid()) AND (action_type !~~ 'system.%'::text) AND (actor_email_snapshot IS NULL) AND (actor_role_snapshot IS NULL) AND (impersonated_by IS NULL) AND (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text, 'support'::text, 'sales'::text, 'finance'::text, 'content_moderator'::text] && user_profiles.roles))))));
ALTER POLICY audit_logs_select_super_admin ON public.admin_audit_logs TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY "Admins can manage user notes" ON public.admin_user_notes TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text])))));
ALTER POLICY "Users and admins can view ai logs" ON public.ai_content_logs TO PUBLIC USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]))))));
ALTER POLICY "Admins can manage announcements" ON public.announcements TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text])))));
ALTER POLICY coupon_redemptions_select ON public.coupon_redemptions TO PUBLIC USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['finance'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles))))));
ALTER POLICY coupons_mutate_sales_or_above ON public.coupons TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY coupons_select_sales_or_above ON public.coupons TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['sales'::text, 'finance'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY csat_access ON public.csat_feedbacks TO PUBLIC USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles))))));
ALTER POLICY dau_select_admin ON public.daily_active_users TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text, 'finance'::text] && user_profiles.roles)))));
ALTER POLICY data_subject_requests_select_operator ON public.data_subject_requests TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = ( SELECT auth.uid() AS uid)) AND (ARRAY['admin'::text, 'super_admin'::text] && up.roles)))));
ALTER POLICY "Org admins can manage departments" ON public.departments TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = departments.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR (up.roles && ARRAY['admin'::text, 'super_admin'::text]))))));
ALTER POLICY email_blacklist_admin ON public.email_blacklist TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY email_logs_admin ON public.email_delivery_logs TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY "Super admin can view" ON public.embedding_jobs TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY experiment_assignments_delete_super_admin ON public.experiment_assignments TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY experiment_assignments_select_super_admin ON public.experiment_assignments TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY experiments_select_super_admin ON public.experiments TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY feature_flags_super_admin_all ON public.feature_flags TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles)))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY feature_packages_mutate_super_admin ON public.feature_packages TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY help_articles_manage ON public.help_articles TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text, 'support'::text] && user_profiles.roles)))));
ALTER POLICY infra_alerts_access ON public.infra_alerts TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY infra_select_super_admin ON public.infra_metrics TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY "Admins can update inquiries" ON public.inquiries TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text])))));
ALTER POLICY "Admins can view all inquiries" ON public.inquiries TO PUBLIC USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text]))))));
ALTER POLICY llm_usage_logs_select_super_admin ON public.llm_usage_logs TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY membership_audit_select_operator ON public.membership_audit TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY moderation_flags_admin_all ON public.moderation_flags TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY nps_select_admin ON public.nps_surveys TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text, 'support'::text] && user_profiles.roles)))));
ALTER POLICY "Org admins can view own stats" ON public.org_daily_stats TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = org_daily_stats.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR (up.roles && ARRAY['admin'::text, 'super_admin'::text]))))));
ALTER POLICY "Org admins can manage challenges" ON public.organization_challenges TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_challenges.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR (up.roles && ARRAY['admin'::text, 'super_admin'::text]))))));
ALTER POLICY "Org admins can manage invites" ON public.organization_invites TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_invites.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR (up.roles && ARRAY['admin'::text, 'super_admin'::text]))))));
ALTER POLICY "Org admins can manage reports" ON public.organization_reports TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_reports.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR (up.roles && ARRAY['admin'::text, 'super_admin'::text]))))));
ALTER POLICY organizations_delete_super_admin ON public.organizations TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY personal_subscriptions_insert_admin ON public.personal_subscriptions TO PUBLIC WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY personal_subscriptions_select ON public.personal_subscriptions TO PUBLIC USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text, 'finance'::text, 'support'::text] && user_profiles.roles))))));
ALTER POLICY personal_subscriptions_update_admin ON public.personal_subscriptions TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY plan_price_history_select ON public.plan_price_history TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text, 'finance'::text] && user_profiles.roles)))));
ALTER POLICY "Admins can update recipe flags" ON public.recipe_flags TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text])))));
ALTER POLICY "Users and admins can view recipe flags" ON public.recipe_flags TO PUBLIC USING (((reporter_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]))))));
ALTER POLICY referral_rewards_select ON public.referral_rewards TO PUBLIC USING (((referrer_id = auth.uid()) OR (referred_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles))))));
ALTER POLICY revenue_snapshots_select ON public.revenue_snapshots TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['finance'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY sales_activities_access ON public.sales_lead_activities TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY sales_leads_access ON public.sales_leads TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY sport_presets_mutate_super_admin ON public.sport_presets TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles)))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY subscription_plans_mutate_super_admin ON public.subscription_plans TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles)))))) WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
ALTER POLICY subscription_plans_select_public ON public.subscription_plans TO PUBLIC USING ((((status)::text = ANY ((ARRAY['public'::character varying, 'private'::character varying])::text[])) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles))))));
ALTER POLICY ticket_messages_insert ON public.support_ticket_messages TO PUBLIC WITH CHECK (((sender_id = auth.uid()) AND (((NOT is_internal) AND (EXISTS ( SELECT 1 FROM support_tickets t WHERE ((t.id = support_ticket_messages.ticket_id) AND (t.user_id = auth.uid()))))) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))))));
ALTER POLICY ticket_messages_select ON public.support_ticket_messages TO PUBLIC USING ((((NOT is_internal) AND (EXISTS ( SELECT 1 FROM support_tickets t WHERE ((t.id = support_ticket_messages.ticket_id) AND (t.user_id = auth.uid()))))) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles))))));
ALTER POLICY tickets_insert_staff ON public.support_tickets TO authenticated WITH CHECK ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY tickets_select ON public.support_tickets TO PUBLIC USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles))))));
ALTER POLICY tickets_update_support ON public.support_tickets TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles)))));
ALTER POLICY "Admins can view system stats" ON public.system_daily_stats TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text])))));
ALTER POLICY "Admins can view system settings" ON public.system_settings TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text])))));
ALTER POLICY "Super admins can update system settings" ON public.system_settings TO PUBLIC USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles))))));
DROP POLICY IF EXISTS subscription_plans_select_operator ON public.subscription_plans;
ALTER POLICY parental_consents_select_signer_family_adult_or_operator ON public.parental_consents TO authenticated USING (((parent_user_id = ( SELECT auth.uid() AS uid)) OR public.is_active_family_adult(family_id) OR (EXISTS ( SELECT 1 FROM public.user_profiles up WHERE ((up.id = auth.uid()) AND (up.roles && ARRAY['admin'::text, 'super_admin'::text]))))));

-- ─────────────────────────────────────────────────────────
-- (b) 7 本の関数
-- ─────────────────────────────────────────────────────────
-- admin_set_user_roles: 最新の定義 supabase/baseline/prod_schema.sql:893-918 の写し (判定の 4 行を足さない)
CREATE OR REPLACE FUNCTION "public"."admin_set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) RETURNS TABLE("id" "uuid", "roles" "text"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_new_roles TEXT[];
BEGIN
  SELECT up.roles INTO v_caller_roles FROM user_profiles up WHERE up.id = auth.uid();
  IF v_caller_roles IS NULL OR NOT (v_caller_roles && ARRAY['super_admin']) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_OWN_ROLES' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_new_roles := COALESCE(p_roles, ARRAY[]::TEXT[]);

  UPDATE user_profiles up SET roles = v_new_roles WHERE up.id = p_user_id;

  RETURN QUERY SELECT p_user_id, v_new_roles;
END $$;

-- list_families_with_inactive_representative: 最新の定義 supabase/baseline/prod_schema.sql:2110-2141 の写し (判定の 4 行を足さない)
CREATE OR REPLACE FUNCTION "public"."list_families_with_inactive_representative"() RETURNS TABLE("family_id" "uuid", "family_name" "text", "representative_user_id" "uuid", "representative_email" "text", "member_count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- super_admin チェック
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    fg.id                         AS family_id,
    fg.name                       AS family_name,
    fm.user_id                    AS representative_user_id,
    au.email                      AS representative_email,
    (SELECT COUNT(*)
       FROM family_members mc
       WHERE mc.family_id = fg.id AND mc.status = 'active'
    )                             AS member_count
  FROM family_groups fg
  JOIN family_members fm ON fm.family_id = fg.id
                         AND fm.role = 'representative'
                         AND fm.status = 'active'
  JOIN auth.users au ON au.id = fm.user_id
  WHERE fg.status = 'active'
    AND (au.last_sign_in_at IS NULL
         OR au.last_sign_in_at < NOW() - INTERVAL '30 days');
END $$;

-- list_orgs_with_inactive_owner: 最新の定義 supabase/baseline/prod_schema.sql:2147-2177 の写し (判定の 4 行を足さない)
CREATE OR REPLACE FUNCTION "public"."list_orgs_with_inactive_owner"() RETURNS TABLE("organization_id" "uuid", "organization_name" "text", "owner_user_id" "uuid", "owner_email" "text", "owner_last_sign_in" timestamp with time zone, "member_count" bigint, "dissolved" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- super_admin チェック
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    o.id                          AS organization_id,
    o.name                        AS organization_name,
    up.id                         AS owner_user_id,
    au.email                      AS owner_email,
    au.last_sign_in_at            AS owner_last_sign_in,
    (SELECT COUNT(*)
       FROM user_profiles mp
       WHERE mp.organization_id = o.id
    )                             AS member_count,
    (o.status = 'dissolved')      AS dissolved
  FROM organizations o
  JOIN user_profiles up ON up.organization_id = o.id AND up.org_role = 'owner'
  JOIN auth.users au ON au.id = up.id
  WHERE au.last_sign_in_at IS NULL
     OR au.last_sign_in_at < NOW() - INTERVAL '30 days';
END $$;

-- operator_force_dissolve_org: 最新の定義 supabase/baseline/prod_schema.sql:2241-2306 の写し (判定の 4 行を足さない)
CREATE OR REPLACE FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
BEGIN
  SELECT roles INTO v_caller_roles
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_roles IS NULL
     OR NOT (
       'super_admin' = ANY(v_caller_roles)
       OR 'operator' = ANY(v_caller_roles)
     ) THEN
    RAISE EXCEPTION 'OPERATOR_PERMISSION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_org FROM organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL,
        org_role = NULL,
        is_active_in_org = FALSE,
        joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE organization_id = p_organization_id;

  -- Round 3 C-4: org_license_pools の used_licenses をリセット
  UPDATE org_license_pools
    SET used_licenses = 0, updated_at = NOW()
    WHERE organization_id = p_organization_id;

  -- organizations.status を dissolved に更新 (000126 で追加したカラム)
  UPDATE organizations
    SET status = 'dissolved',
        dissolved_at = NOW(),
        updated_at = NOW()
    WHERE id = p_organization_id
    RETURNING * INTO v_org;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES (
    'organization',
    p_organization_id,
    'operator_force_dissolve',
    auth.uid(),
    NULL,
    jsonb_build_object(
      'reason', p_reason,
      'dissolved_at', NOW()
    )
  );

  RETURN v_org;
END;
$$;

-- operator_force_owner_transfer: 最新の定義 supabase/baseline/prod_schema.sql:2312-2348 の写し (判定の 4 行を足さない)
CREATE OR REPLACE FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_org organizations;
  v_old_owner_id UUID;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM user_profiles WHERE id = p_new_owner_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  SELECT owner_id INTO v_old_owner_id FROM organizations WHERE id = p_organization_id;

  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = p_new_owner_id;
  UPDATE organizations SET owner_id = p_new_owner_id WHERE id = p_organization_id RETURNING * INTO v_org;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'operator_force_owner_transfer',
          NULL, p_new_owner_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_owner_id', v_old_owner_id,
            'reason', p_reason
          ));

  RETURN v_org;
END $$;

-- operator_force_dissolve_family: 最新の定義 supabase/migrations/20261008090100_family_lock_order.sql:188-222 の写し (判定の 4 行を足さない)
CREATE OR REPLACE FUNCTION public.operator_force_dissolve_family(p_family_id UUID, p_reason TEXT)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam family_groups;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_members -> user_profiles。
  -- 最初に家族の行をロックする (従来は最後に更新するだけだった)。承諾・子供の追加など、家族の行を先に取った処理が
  -- 途中であれば、その完了を待ってから以降のメンバーの更新を始めるので、コミット済みのメンバーも全員 left にできる。
  -- 家族の行が無ければ何もせず、従来どおり以降の UPDATE は 0 行のまま v_fam が NULL で返る。
  PERFORM 1 FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

  UPDATE family_members SET status = 'left' WHERE family_id = p_family_id AND status = 'active';
  UPDATE user_profiles SET family_id = NULL WHERE family_id = p_family_id;

  UPDATE family_groups
    SET status = 'dissolved', dissolved_at = NOW()
    WHERE id = p_family_id
    RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_dissolve', NULL,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;

-- operator_force_representative_transfer: 最新の定義 supabase/migrations/20261008090100_family_lock_order.sql:224-267 の写し (判定の 4 行を足さない)
CREATE OR REPLACE FUNCTION public.operator_force_representative_transfer(p_family_id UUID, p_new_rep_id UUID, p_reason TEXT)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam family_groups;
  v_old_rep_id UUID;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_members。
  -- 最初に家族の行をロックし、旧代表者もこのロック下で読む (従来は新代表者の確認と旧代表者の取得がロックより前で、
  -- 家族の行は最後に更新するだけだった)。家族の行が無ければ v_old_rep_id は NULL のままで、次の確認が TARGET_NOT_IN_FAMILY になる。
  SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE family_id = p_family_id AND user_id = p_new_rep_id
      AND status = 'active' AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members SET role = 'adult'
    WHERE family_id = p_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = p_family_id AND user_id = p_new_rep_id AND status = 'active';
  UPDATE family_groups SET representative_id = p_new_rep_id
    WHERE id = p_family_id RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_representative_transfer',
          NULL, p_new_rep_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_rep_id', v_old_rep_id,
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;

-- ─────────────────────────────────────────────────────────
-- (c) 判定の関数
-- ─────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.operator_mfa_satisfied();
