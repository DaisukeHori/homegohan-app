/**
 * 機能フラグ スキーマ定義
 * operator/02-api-spec.md §7 準拠
 */
import { z } from 'zod';
import { labelOrRaw } from '@/lib/admin/value-labels';

/** 公開の範囲の種類 (feature_flags.rollout_strategy.type) */
export const ROLLOUT_STRATEGY_TYPES = ['all', 'percentage', 'plan', 'role', 'org'] as const;
export type RolloutStrategyType = (typeof ROLLOUT_STRATEGY_TYPES)[number];

/**
 * 公開の範囲の種類の表示名 (#2112 Z3。フラグの作成の画面 src/app/super-admin/flags/new/page.tsx の選択肢と同じ語)。
 * 以前、フラグの一覧 (src/app/super-admin/flags/page.tsx) は種類を英字の内部の値 (percentage など) のまま出していた。
 * Record なので、ROLLOUT_STRATEGY_TYPES に値を足すと表示名の漏れが型の誤りになる
 */
export const ROLLOUT_STRATEGY_TYPE_LABELS: Readonly<Record<RolloutStrategyType, string>> = {
  all: '全ユーザー',
  percentage: '段階公開',
  plan: 'プラン別',
  role: 'ロール別',
  org: '組織別',
};

/** 公開の範囲の種類の表示名。表に無い値 (将来の値・壊れた応答) はそのまま */
export function rolloutStrategyTypeLabel(value: string): string {
  return labelOrRaw(ROLLOUT_STRATEGY_TYPE_LABELS, value);
}

export const RolloutStrategySchema = z.object({
  type: z.enum(ROLLOUT_STRATEGY_TYPES),
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
  key: z.string().regex(/^[a-z0-9_]+$/, 'キー (key) は小文字英数字とアンダースコアのみ使用可能').min(1).max(100),
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
