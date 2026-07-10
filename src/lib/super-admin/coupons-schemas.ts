/**
 * super_admin クーポン API 用 Zod スキーマ
 * operator/01-data-model.md §3.5-3.6 / operator/04-plan-management.md §4.1 準拠
 *
 * route.ts には inline 定義しない (family/02 §15.6.1 確定ルール)。
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

export const DISCOUNT_TYPES = ['fixed', 'percentage'] as const;
export const COUPON_APPLICABLE_TO = ['all', 'personal', 'family', 'org'] as const;
export const COUPON_STATUSES = ['active', 'paused', 'expired'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// スキーマ定義
// ─────────────────────────────────────────────────────────────────────────────

/** クーポン新規作成リクエスト */
export const CouponCreateSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/, '英大文字・数字・アンダースコア・ハイフンのみ'),
  display_name: z.string().max(200).optional(),
  discount_type: z.enum(DISCOUNT_TYPES),
  discount_value: z.number().positive('0より大きい値を指定してください'),
  applicable_plans: z.array(z.string().uuid()).optional().default([]),
  applicable_to: z.enum(COUPON_APPLICABLE_TO).optional().default('all'),
  valid_from: z.string().datetime(),
  valid_until: z.string().datetime(),
  max_uses: z.number().int().min(1).nullable().optional(),
  per_user_limit: z.number().int().min(1).optional().default(1),
  duration_months: z.number().int().min(1).nullable().optional(),
  gross_margin_preview_jpy: z.number().int().nullable().optional(),
}).refine((data) => {
  // パーセントは 0〜100
  if (data.discount_type === 'percentage' && data.discount_value > 100) {
    return false;
  }
  return true;
}, { message: 'パーセント割引は 100% 以下にしてください', path: ['discount_value'] })
  .refine((data) => {
    // valid_from < valid_until
    return new Date(data.valid_from) < new Date(data.valid_until);
  }, { message: '有効開始日は終了日より前にしてください', path: ['valid_until'] });

export type CouponCreateInput = z.infer<typeof CouponCreateSchema>;

/** クーポン更新リクエスト */
export const CouponUpdateSchema = z.object({
  display_name: z.string().max(200).nullable().optional(),
  status: z.enum(COUPON_STATUSES).optional(),
  valid_until: z.string().datetime().optional(),
  max_uses: z.number().int().min(1).nullable().optional(),
  applicable_plans: z.array(z.string().uuid()).optional(),
  applicable_to: z.enum(COUPON_APPLICABLE_TO).optional(),
  gross_margin_preview_jpy: z.number().int().nullable().optional(),
});

export type CouponUpdateInput = z.infer<typeof CouponUpdateSchema>;

/** クーポン一覧クエリパラメータ */
export const CouponsQuerySchema = z.object({
  status: z.enum(COUPON_STATUSES).optional(),
  applicable_to: z.enum(COUPON_APPLICABLE_TO).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type CouponsQueryInput = z.infer<typeof CouponsQuerySchema>;

/** クーポン適用履歴クエリパラメータ */
export const CouponRedemptionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type CouponRedemptionsQueryInput = z.infer<typeof CouponRedemptionsQuerySchema>;

/**
 * クーポン適用 (遡及適用、super_admin 承認) リクエスト
 * #1041 (F4-07) 修正: クーポン作成のみで償却・適用ロジックが存在しなかった問題への対応。
 * operator/04-plan-management.md §4.1 「新クーポン適用フロー」準拠。
 */
export const CouponApplySchema = z.object({
  subscription_target: z.enum(['personal', 'org']),
  subscription_id: z.string().uuid(),
  reason: z.string().min(1).max(1000).optional(),
});

export type CouponApplyInput = z.infer<typeof CouponApplySchema>;
