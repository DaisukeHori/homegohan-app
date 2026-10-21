/**
 * organizations.plan に書ける値 (#1912 段 A の整合ゲートの指摘)
 *
 * 書き手は 2 つ: 運営の組織の作成 (POST /api/admin/organizations。運営の画面 src/app/admin/organizations/OrganizationsManager.tsx の選択肢) と、
 * 組織の設定 (PUT /api/org/settings。owner / admin。src/lib/org-settings-api.ts の ORG_SETTINGS_PLANS)。どちらもこの一覧を使う。
 * DB の列 (organizations.plan) は自由な文字列で CHECK は無いので、書ける値はこの一覧が決める。
 *
 * AI の 1 日の上限: get_effective_plan は、個人の契約も家族も無い組織の利用者に organizations.plan をそのまま返し、
 * consume_ai_usage_at は ai_daily_limits に行の無いプランを free の行で判定する。そのため、この一覧のすべての値に
 * ai_daily_limits の行 (組織の上限) が要る ('standard' = 20261021100000_billing_paid_plans_iap.sql の (5a)、
 * 'premium' / 'enterprise' = 20261021110000_org_plan_ai_daily_limits.sql)。
 * 値を足すときは、同じ PR で ai_daily_limits の行を足す migration も足す
 * (tests/org-plan-ai-daily-limits-contract.test.ts と tests/integration/rls/ai-plan-feature-caps-rpc.test.ts が突き合わせる)。
 */
export const ORG_PLAN_VALUES = ['standard', 'premium', 'enterprise'] as const;

export type OrgPlanValue = (typeof ORG_PLAN_VALUES)[number];

/** organizations.plan の列の既定 (運営が作るときにプランを指定しなければこれ) */
export const ORG_PLAN_DEFAULT: OrgPlanValue = 'standard';
