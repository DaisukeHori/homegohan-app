/**
 * 運営画面の AI の 1 日の利用回数の上限 (#1149) の、一覧の組み立て (GET /api/super-admin/llm/quotas が使う)
 *
 * 上限の値は DB の ai_daily_limits (プランごと)。自分の行が無いプランは free の行の値を使う
 * (DB の consume_ai_usage_at と同じ規則。free の行も無ければ無制限)。
 */
import { AI_DAILY_LIMIT_DEFAULT_PLAN_KEY, AI_DAILY_LIMIT_MAX, type AiDailyLimitRow } from '@/lib/super-admin/llm-schemas';

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

/** プランの一覧と上限の行から、画面の 1 行ずつを作る (プランの表の順。プランの表に無いキーの行も最後に出す) */
export function buildAiDailyLimitRows(
  plans: readonly SubscriptionPlanRecord[],
  limits: readonly AiDailyLimitRecord[],
): AiDailyLimitRow[] {
  const limitByPlan = new Map(limits.map((row) => [row.plan_key, row]));
  const defaultLimit = limitByPlan.get(AI_DAILY_LIMIT_DEFAULT_PLAN_KEY);
  const toRow = (planKey: string, plan: SubscriptionPlanRecord | null): AiDailyLimitRow => {
    const own = limitByPlan.get(planKey);
    return {
      plan_key: planKey,
      display_name: plan?.display_name ?? null,
      plan_type: plan?.plan_type ?? null,
      daily_limit: own ? own.daily_limit : null,
      configured: Boolean(own),
      effective_daily_limit: own ? own.daily_limit : (defaultLimit?.daily_limit ?? null),
      updated_at: own?.updated_at ?? null,
    };
  };
  const knownKeys = new Set(plans.map((plan) => plan.plan_key));
  return [
    ...plans.map((plan) => toRow(plan.plan_key, plan)),
    ...limits.filter((row) => !knownKeys.has(row.plan_key)).map((row) => toRow(row.plan_key, null)),
  ];
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
