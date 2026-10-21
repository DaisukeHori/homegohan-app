/**
 * organizations.plan に書ける値 (#1912 段 A の整合ゲートの指摘)
 *
 * organizations.plan を書く経路は 3 つ:
 *   a. 運営の組織の作成 (POST /api/admin/organizations。service_role。運営の画面 src/app/admin/organizations/OrganizationsManager.tsx の選択肢)
 *   b. 組織の設定 (PUT /api/org/settings。owner / admin の JWT。src/lib/org-settings-api.ts の ORG_SETTINGS_PLANS)
 *   c. owner / admin の JWT で PostgREST から直接 UPDATE (RLS organizations_update_admin。アプリの Zod を通らない)
 * a・b は Zod でこの一覧に限る。b・c (ログインした利用者の書き込み) は DB のトリガー guard_organizations_plan_value
 * (supabase/migrations/20261021110000_org_plan_ai_daily_limits.sql) がこの一覧と同じ値に限る (有料の plan_key や行の無い値を拒む)。
 * 列 (organizations.plan) そのものは CHECK の無い text で、service_role の書き込みは DB では限られない。
 *
 * AI の 1 日の上限: get_effective_plan は、個人の契約も家族も無い組織の利用者に organizations.plan をそのまま返し、
 * consume_ai_usage_at は ai_daily_limits に行の無いプランを free の行で判定する。そのため、この一覧のすべての値に
 * ai_daily_limits の行 (組織の上限) が要る ('standard' = 20261021100000_billing_paid_plans_iap.sql の (5a)、
 * 'premium' / 'enterprise' = 20261021110000_org_plan_ai_daily_limits.sql)。
 * 値を足すときは、同じ PR で ai_daily_limits の行を足し、トリガー関数の許す値を同じにする migration も足す
 * (tests/org-plan-ai-daily-limits-contract.test.ts と tests/integration/rls/ai-plan-feature-caps-rpc.test.ts が突き合わせる)。
 */
export const ORG_PLAN_VALUES = ['standard', 'premium', 'enterprise'] as const;

export type OrgPlanValue = (typeof ORG_PLAN_VALUES)[number];

/** organizations.plan の列の既定 (運営が作るときにプランを指定しなければこれ) */
export const ORG_PLAN_DEFAULT: OrgPlanValue = 'standard';
