/**
 * 運営画面の AI の 1 日の利用回数の上限 (#1149) の、一覧の組み立て (GET /api/super-admin/llm/quotas が使う)
 *
 * 上限の値は DB の ai_daily_limits (プランごと)。自分の行が無いプランは free の行の値を使う
 * (DB の consume_ai_usage_at と同じ規則。free の行も無ければ無制限)。
 *
 * #1912: 組織の利用者のプランは organizations.plan の値 (standard / premium / enterprise。src/lib/org-plans.ts の ORG_PLAN_VALUES) で、
 * subscription_plans の org_* とは別のキー。この値の行も一覧に出し、PATCH で保存できる (以前は一覧に出るのに 404 で保存できなかった)。
 */
import {
  AI_DAILY_LIMIT_DEFAULT_PLAN_KEY,
  AI_DAILY_LIMIT_MAX,
  ORG_PLAN_DISPLAY_SUFFIX,
  type AiDailyLimitPlanSource,
  type AiDailyLimitRow,
} from '@/lib/super-admin/llm-schemas';
import { ORG_PLAN_VALUES } from '@/lib/org-plans';

/** 監査ログの action_type (operator/07-audit-monitoring.md の命名 super_admin.<対象>.<操作>) */
export const LLM_QUOTA_AUDIT_ACTION = 'super_admin.llm_quota.update';

/** ai_daily_limits の 1 行 */
export interface AiDailyLimitRecord {
  plan_key: string;
  daily_limit: number | null;
  updated_at: string;
}

/** subscription_plans の 1 行 (一覧に使う列だけ) */
export interface SubscriptionPlanRecord {
  plan_key: string;
  display_name: string | null;
  plan_type: string | null;
}

/**
 * プランの一覧と上限の行から、画面の 1 行ずつを作る。順は
 *   1. プランの表 (subscription_plans) の順
 *   2. 組織のプランの値 (ORG_PLAN_VALUES の順。プランの表に無いもの。ai_daily_limits に行が無くても出す — 保存すると行を作る。#1912)
 *   3. どちらにも無いキーの ai_daily_limits の行 (plan_source: 'unknown'。保存できない)
 */
export function buildAiDailyLimitRows(
  plans: readonly SubscriptionPlanRecord[],
  limits: readonly AiDailyLimitRecord[],
): AiDailyLimitRow[] {
  const limitByPlan = new Map(limits.map((row) => [row.plan_key, row]));
  const defaultLimit = limitByPlan.get(AI_DAILY_LIMIT_DEFAULT_PLAN_KEY);
  const toRow = (
    planKey: string,
    source: AiDailyLimitPlanSource,
    plan: SubscriptionPlanRecord | null,
  ): AiDailyLimitRow => {
    const own = limitByPlan.get(planKey);
    return {
      plan_key: planKey,
      plan_source: source,
      display_name: source === 'org_plan' ? orgPlanDisplayName(planKey) : (plan?.display_name ?? null),
      plan_type: plan?.plan_type ?? null,
      daily_limit: own ? own.daily_limit : null,
      configured: Boolean(own),
      effective_daily_limit: own ? own.daily_limit : (defaultLimit?.daily_limit ?? null),
      updated_at: own?.updated_at ?? null,
    };
  };
  const knownKeys = new Set(plans.map((plan) => plan.plan_key));
  const orgKeys = ORG_PLAN_VALUES.filter((value) => !knownKeys.has(value));
  const listedKeys = new Set<string>([...knownKeys, ...orgKeys]);
  return [
    ...plans.map((plan) => toRow(plan.plan_key, 'subscription_plan', plan)),
    ...orgKeys.map((value) => toRow(value, 'org_plan', null)),
    ...limits.filter((row) => !listedKeys.has(row.plan_key)).map((row) => toRow(row.plan_key, 'unknown', null)),
  ];
}

/** 組織のプランの値の行の表示名 (例: 「standard（組織のプラン）」) */
export function orgPlanDisplayName(planKey: string): string {
  return `${planKey}${ORG_PLAN_DISPLAY_SUFFIX}`;
}

/** 運営の画面でその行の上限を保存できるか (PATCH が受け付けるキーか。unknown は 404 PLAN_NOT_FOUND で断られる) */
export function isAiDailyLimitRowEditable(row: Pick<AiDailyLimitRow, 'plan_source'>): boolean {
  return row.plan_source !== 'unknown';
}

/**
 * 運営画面の入力欄の文字を、保存する値にする。空欄は無制限 (null)。0 以上 AI_DAILY_LIMIT_MAX 以下の整数でなければ undefined (保存しない)
 */
export function parseLimitInput(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const limit = Number(trimmed);
  return limit <= AI_DAILY_LIMIT_MAX ? limit : undefined;
}
