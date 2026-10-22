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

/** 値が organizations.plan に書ける値 (ORG_PLAN_VALUES) のどれかか */
export function isOrgPlanValue(value: string): value is OrgPlanValue {
  return (ORG_PLAN_VALUES as readonly string[]).includes(value);
}

/** organizations.plan の列の既定 (運営が作るときにプランを指定しなければこれ) */
export const ORG_PLAN_DEFAULT: OrgPlanValue = 'standard';

/**
 * 組織のプランの値 (organizations.plan) の利用者向けの表示名。組織の設定の画面 (/org/settings。owner / admin が見る) と、
 * 組織の管理画面のサイドバーの見出し (src/app/(org)/layout.tsx。src/lib/org-sidebar.ts の readOrgSidebarInfo 経由) が使う。
 * キーは ORG_PLAN_VALUES と同じ (satisfies で足りない・余るキーを型で止め、tests/org-plan-labels.test.tsx が値でも突き合わせる)。
 * 運営の画面は内部の値をそのまま出す (この表を通さない)
 */
export const ORG_PLAN_LABELS = {
  standard: 'スタンダード',
  premium: 'プレミアム',
  enterprise: 'エンタープライズ',
} as const satisfies Record<OrgPlanValue, string>;

/** 値が無い・表に無い値のときに出す文字 (内部の値を利用者の画面に出さない。組織の管理画面の招待の一覧の状態の札も使う) */
export const ORG_UNKNOWN_VALUE_LABEL = '-';

/** organizations.plan の表示名。null・表に無い値は ORG_UNKNOWN_VALUE_LABEL */
export function orgPlanLabel(value: string | null | undefined): string {
  if (value == null || !isOrgPlanValue(value)) return ORG_UNKNOWN_VALUE_LABEL;
  return ORG_PLAN_LABELS[value];
}

/**
 * organizations.subscription_status に入りうる値。列は CHECK の無い text で、アプリにも migration にもこの列へ書く経路は無い
 * (読むのは組織の設定の GET だけ)。そのため次の出どころの値を全部並べる:
 *   - 'trial': 列の既定 (supabase/migrations/20251126124224_create_meal_planner_tables.sql の organizations)
 *   - 'trialing' / 'active' / 'past_due' / 'suspended' / 'cancelled': 組織のデータモデルの設計 (docs/design/org/01-data-model.md の CHECK 案)
 *     と要件 (docs/requirements/02-organization-management.md)
 *   - 'expired': supabase/migrations/20261010140000_ai_usage_foundation.sql の注記 (trial / expired など)
 * 解約の予約 (期間の終わりで解約) を表す列は organizations に無いので、「解約予定」に当たる値は無い
 */
export const ORG_SUBSCRIPTION_STATUS_VALUES = ['trial', 'trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired'] as const;

export type OrgSubscriptionStatusValue = (typeof ORG_SUBSCRIPTION_STATUS_VALUES)[number];

/** 値が ORG_SUBSCRIPTION_STATUS_VALUES のどれかか */
export function isOrgSubscriptionStatusValue(value: string): value is OrgSubscriptionStatusValue {
  return (ORG_SUBSCRIPTION_STATUS_VALUES as readonly string[]).includes(value);
}

/** organizations.subscription_status の利用者向けの表示名 (キーは ORG_SUBSCRIPTION_STATUS_VALUES と同じ) */
export const ORG_SUBSCRIPTION_STATUS_LABELS = {
  trial: '無料体験中',
  trialing: '無料体験中',
  active: '有効',
  past_due: 'お支払い待ち',
  suspended: '停止中',
  cancelled: '解約済み',
  expired: '期限切れ',
} as const satisfies Record<OrgSubscriptionStatusValue, string>;

/** organizations.subscription_status の表示名。null・表に無い値は ORG_UNKNOWN_VALUE_LABEL */
export function orgSubscriptionStatusLabel(value: string | null | undefined): string {
  if (value == null || !isOrgSubscriptionStatusValue(value)) return ORG_UNKNOWN_VALUE_LABEL;
  return ORG_SUBSCRIPTION_STATUS_LABELS[value];
}
