/**
 * LLM 使用量 スキーマ定義
 * operator/06-ai-llm.md §4 + operator/02-api-spec.md §8 準拠
 */
import { z } from 'zod';

export const LLMProvider = ['gemini', 'xai', 'anthropic', 'openai'] as const;
export type LLMProvider = typeof LLMProvider[number];

export const LLMUsageQuerySchema = z.object({
  period: z.enum(['1d', '7d', '30d', 'custom']).default('7d'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  model: z.string().optional(),
  function: z.string().optional(),
  provider: z.enum(LLMProvider).optional(),
});

/**
 * LLM 利用クォータの変更 (PATCH /api/super-admin/llm/quotas) の入力。
 * 注意 (#1149): クォータ管理は準備中 (未対応) で、PATCH は 501 を返すため、いまはどの API からも使っていない。
 * 機能を作るときの設計 (入力の形) を残してある。
 */
export const UpdateLLMQuotaSchema = z.object({
  target_type: z.enum(['user', 'org']),
  target_id: z.string().uuid(),
  daily_limit: z.number().int().min(0).optional(),
  monthly_limit: z.number().int().min(0).optional(),
  reason: z.string().min(1).max(500),
});

/** GET /api/super-admin/llm/quotas の `note`。値は目安で、AI の呼び出しには適用されない (#1149) */
export const LLM_QUOTAS_NOT_ENFORCED_NOTE =
  'この値は設計上の目安です。AI の呼び出しにはまだ適用されておらず、どの AI 機能もこの値では制限されません（準備中）。';

/** PATCH /api/super-admin/llm/quotas (501) の本文 (#1149) */
export const LLM_QUOTA_UPDATE_NOT_SUPPORTED_MESSAGE =
  'LLM 利用クォータの変更は準備中（未対応）です。クォータは AI の呼び出しにまだ適用されておらず、変更しても何も制限されません。';

export type LLMUsageQuery = z.infer<typeof LLMUsageQuerySchema>;
export type UpdateLLMQuotaInput = z.infer<typeof UpdateLLMQuotaSchema>;

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

export interface LLMQuota {
  id: string;
  target_type: 'user' | 'org';
  target_id: string;
  daily_limit: number | null;
  monthly_limit: number | null;
  updated_at: string;
  updated_by: string;
}
