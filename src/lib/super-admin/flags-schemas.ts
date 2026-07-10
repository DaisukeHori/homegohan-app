/**
 * 機能フラグ スキーマ定義
 * operator/02-api-spec.md §7 準拠
 */
import { z } from 'zod';

export const RolloutStrategySchema = z.object({
  type: z.enum(['all', 'percentage', 'plan', 'role', 'org']),
  value: z.number().min(0).max(100).optional(),
  plans: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  org_ids: z.array(z.string().uuid()).optional(),
});

export const FeatureFlagConstraintsSchema = z.object({
  min_user_age_days: z.number().int().min(0).optional(),
  exclude_plans: z.array(z.string()).optional(),
  include_plans: z.array(z.string()).optional(),
  include_roles: z.array(z.string()).optional(),
  include_org_ids: z.array(z.string().uuid()).optional(),
}).optional();

export const CreateFeatureFlagSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/, 'key は小文字英数字とアンダースコアのみ使用可能').min(1).max(100),
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(false),
  rollout_strategy: RolloutStrategySchema.optional(),
  constraints: FeatureFlagConstraintsSchema,
});

export const UpdateFeatureFlagSchema = z.object({
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  rollout_strategy: RolloutStrategySchema.optional(),
  constraints: FeatureFlagConstraintsSchema,
});

export type CreateFeatureFlagInput = z.infer<typeof CreateFeatureFlagSchema>;
export type UpdateFeatureFlagInput = z.infer<typeof UpdateFeatureFlagSchema>;
export type RolloutStrategy = z.infer<typeof RolloutStrategySchema>;
export type FeatureFlagConstraints = z.infer<typeof FeatureFlagConstraintsSchema>;

export interface FeatureFlag {
  id: string;
  key: string;
  description: string | null;
  enabled: boolean;
  rollout_strategy: RolloutStrategy | null;
  constraints: Record<string, unknown> | null;
  active_user_count: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
