/**
 * LLM 使用量 スキーマ定義
 * operator/06-ai-llm.md §4 + operator/02-api-spec.md §8 準拠
 */
import { z } from 'zod';
// 期間の開始日・終了日 (YYYY-MM-DD の実在する日付)。使用量の API は JST 0 時の時刻に直して絞る (#1433) ので、
// 存在しない日付は入口で 400 にする (通すと時刻に直すところで例外になり 500 になる)
import { CalendarDateSchema } from '@/lib/calendar-date-schema';

export const LLMProvider = ['gemini', 'xai', 'anthropic', 'openai'] as const;
export type LLMProvider = typeof LLMProvider[number];

export const LLMUsageQuerySchema = z.object({
  period: z.enum(['1d', '7d', '30d', 'custom']).default('7d'),
  from: CalendarDateSchema.optional(),
  to: CalendarDateSchema.optional(),
  model: z.string().optional(),
  function: z.string().optional(),
  provider: z.enum(LLMProvider).optional(),
});

/** 1 日の上限に保存できる最大の回数。運営の入力の打ち間違い (桁の誤り) を止めるための上限 (DB の INTEGER の範囲より十分小さい) */
export const AI_DAILY_LIMIT_MAX = 10_000;
/** プランのキーの最大の長さ (subscription_plans.plan_key の実際の値より十分長い) */
const PLAN_KEY_MAX_LENGTH = 100;
/** 変更の理由の最大の長さ (監査ログに残す) */
const QUOTA_REASON_MAX_LENGTH = 500;

/**
 * AI の 1 日の上限の変更 (PATCH /api/super-admin/llm/quotas) の入力 (#1149)。
 *   - plan_key   : 変えるプラン (subscription_plans にあるもの)
 *   - daily_limit: 1 日の上限の回数 (全機能の合計。0 以上 AI_DAILY_LIMIT_MAX 以下の整数)。null は無制限
 *   - reason     : 変更の理由 (監査ログに残す)
 * 保存先は DB の ai_daily_limits。保存した値は、次の AI の利用の判定 (consume_ai_usage) から効く。
 */
export const UpdateAiDailyLimitSchema = z.object({
  plan_key: z.string().trim().min(1).max(PLAN_KEY_MAX_LENGTH),
  daily_limit: z.number().int().min(0).max(AI_DAILY_LIMIT_MAX).nullable(),
  reason: z.string().trim().min(1).max(QUOTA_REASON_MAX_LENGTH),
});

/** 行の無いプランが使う上限のプラン (DB の consume_ai_usage_at の c_default_plan と同じ) */
export const AI_DAILY_LIMIT_DEFAULT_PLAN_KEY = 'free';

/** GET /api/super-admin/llm/quotas の `note` (#1149)。値は AI の利用の判定に使われている */
export const LLM_QUOTAS_ENFORCED_NOTE =
  'AI の 1 日の利用回数の上限です（全機能の合計・日本時間の 0 時に戻ります）。値を保存すると、次の AI の利用から効きます。' +
  '自分の行が無いプランは free の値を使います。空欄（無制限）にすると、そのプランは上限なしになります。';

export type LLMUsageQuery = z.infer<typeof LLMUsageQuerySchema>;
export type UpdateAiDailyLimitInput = z.infer<typeof UpdateAiDailyLimitSchema>;

export interface LLMUsageSummary {
  total_cost_usd: number;
  total_cost_jpy: number;
  total_requests: number;
  total_tokens: number;
  by_model: Array<{
    model: string;
    provider: string;
    requests: number;
    tokens: number;
    cost_usd: number;
  }>;
  by_function: Array<{
    function: string;
    requests: number;
    cost_usd: number;
  }>;
  top_users: Array<{
    user_id: string;
    email: string | null;
    requests: number;
    cost_usd: number;
    is_anomaly: boolean;
  }>;
  timeseries: Array<{
    date: string;
    cost_usd: number;
    requests: number;
  }>;
  anomalies: Array<{
    user_id: string;
    email: string | null;
    daily_requests: number;
    detected_at: string;
  }>;
}

/** GET /api/super-admin/llm/quotas の 1 行 (プランごとの AI の 1 日の上限。#1149) */
export interface AiDailyLimitRow {
  plan_key: string;
  /** subscription_plans の表示名 (プランの表に無いキーは null) */
  display_name: string | null;
  /** subscription_plans の種類 (personal / family / org。プランの表に無いキーは null) */
  plan_type: string | null;
  /** そのプランの行の値 (行が無ければ null。無制限も null なので、configured と一緒に読む) */
  daily_limit: number | null;
  /** そのプランの行が ai_daily_limits にあるか (無ければ free の値を使う) */
  configured: boolean;
  /** 実際に効いている上限 (行の値、行が無ければ free の行の値)。null は無制限 */
  effective_daily_limit: number | null;
  /** 行を最後に保存した時刻 (行が無ければ null) */
  updated_at: string | null;
}
