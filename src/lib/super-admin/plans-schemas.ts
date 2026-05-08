/**
 * super_admin プラン定義 API 用 Zod スキーマ
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.1 準拠
 *
 * route.ts には inline 定義しない (family/02 §15.6.1 確定ルール)。
 * このファイルから import して使用する。
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

/** 9 種公式 plan_key (operator/01-data-model.md §3.2 seed) */
export const OFFICIAL_PLAN_KEYS = [
  'free',
  'pro',
  'family_basic',
  'family_pro',
  'family_addon',
  'org_starter',
  'org_standard',
  'org_pro',
  'org_enterprise',
] as const;

export const PLAN_TYPES = ['personal', 'family', 'org'] as const;
export const PLAN_STATUSES = ['draft', 'public', 'private', 'deprecated'] as const;
export const PRICE_APPLIES_TO = ['new_only', 'on_renewal', 'immediately'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// スキーマ定義
// ─────────────────────────────────────────────────────────────────────────────

/** プラン新規作成リクエスト */
export const PlanCreateSchema = z.object({
  plan_key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, '英小文字・数字・アンダースコアのみ'),
  display_name: z.string().min(1).max(200),
  plan_type: z.enum(PLAN_TYPES),
  description: z.string().max(5000).optional(),
  monthly_price_jpy: z.number().int().min(0).nullable().optional(),
  yearly_price_jpy: z.number().int().min(0).nullable().optional(),
  max_members: z.number().int().min(1).nullable().optional(),
  max_family_seats: z.number().int().min(0).nullable().optional(),
  feature_package_ids: z.array(z.string().uuid()).optional().default([]),
  display_order: z.number().int().min(0).optional().default(0),
  trial_days: z.number().int().min(0).optional().default(0),
  min_contract_months: z.number().int().min(1).optional().default(1),
  auto_renew_default: z.boolean().optional().default(true),
  banner_url: z.string().url().nullable().optional(),
}).refine((data) => {
  // 組織プランは trial_days = 0 を強制
  if (data.plan_type === 'org' && (data.trial_days ?? 0) > 0) {
    return false;
  }
  return true;
}, { message: '組織プランには試用期間を設定できません', path: ['trial_days'] });

export type PlanCreateInput = z.infer<typeof PlanCreateSchema>;

/** プラン更新リクエスト (status 別制限は API で適用) */
export const PlanUpdateSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  banner_url: z.string().url().nullable().optional(),
  feature_package_ids: z.array(z.string().uuid()).optional(),
  display_order: z.number().int().min(0).optional(),
  max_members: z.number().int().min(1).nullable().optional(),
  max_family_seats: z.number().int().min(0).nullable().optional(),
  trial_days: z.number().int().min(0).optional(),
  min_contract_months: z.number().int().min(1).optional(),
  auto_renew_default: z.boolean().optional(),
  stripe_product_id: z.string().max(255).nullable().optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  ends_at: z.string().datetime().nullable().optional(),
});

export type PlanUpdateInput = z.infer<typeof PlanUpdateSchema>;

/** 価格変更リクエスト */
export const PriceChangeSchema = z.object({
  new_monthly_price_jpy: z.number().int().min(0).nullable().optional(),
  new_yearly_price_jpy: z.number().int().min(0).nullable().optional(),
  applies_to: z.enum(PRICE_APPLIES_TO),
  reason: z.string().min(1).max(1000),
  effective_at: z.string().datetime(),
}).refine((data) => {
  // 少なくとも月額か年額のどちらかを指定
  return data.new_monthly_price_jpy != null || data.new_yearly_price_jpy != null;
}, { message: '月額または年額のいずれかを指定してください' });

export type PriceChangeInput = z.infer<typeof PriceChangeSchema>;

/** deprecate リクエスト */
export const PlanDeprecateSchema = z.object({
  superseded_by_plan_id: z.string().uuid().nullable().optional(),
  ends_at: z.string().datetime(),
  migration_message: z.string().min(1).max(2000),
});

export type PlanDeprecateInput = z.infer<typeof PlanDeprecateSchema>;

/** 一覧クエリパラメータ */
export const PlansQuerySchema = z.object({
  type: z.enum(PLAN_TYPES).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type PlansQueryInput = z.infer<typeof PlansQuerySchema>;

/** 価格影響シミュレーション クエリパラメータ */
export const PriceImpactQuerySchema = z.object({
  new_monthly_price_jpy: z.coerce.number().int().min(0).optional(),
  applies_to: z.enum(PRICE_APPLIES_TO).optional(),
});

export type PriceImpactQueryInput = z.infer<typeof PriceImpactQuerySchema>;
