/**
 * super_admin クーポン API 用 Zod スキーマ
 * operator/01-data-model.md §3.5-3.6 / operator/04-plan-management.md §4.1 準拠
 *
 * route.ts には inline 定義しない (family/02 §15.6.1 確定ルール)。
 */

import { z } from 'zod';
import { CalendarDateSchema } from '@/lib/calendar-date-schema';

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

export const DISCOUNT_TYPES = ['fixed', 'percentage'] as const;
export const COUPON_APPLICABLE_TO = ['all', 'personal', 'family', 'org'] as const;
export const COUPON_STATUSES = ['active', 'paused', 'expired'] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

/** クーポンの状態の画面の名前 (クーポン詳細の状態のバッジと同じ) */
export const COUPON_STATUS_LABELS: Readonly<Record<CouponStatus, string>> = {
  active: '有効',
  paused: '停止中',
  expired: '期限切れ',
};

/**
 * クーポンの状態の遷移表 (#2064)。画面のボタンと同じ 2 つだけを許す:
 *   active → paused (詳細の「一時停止」)・paused → active (詳細の「再開する」)。expired からはどこへも変えない (終端)
 * ここに無い変更 (同じ状態への変更・期限切れからの再開・expired への変更) は PATCH が 409 で断る。
 * DB には遷移を止めるトリガーが無い (CHECK coupons_status_check は値の範囲だけ) ので、守りは PATCH の route だけ
 */
export const COUPON_STATUS_TRANSITIONS: Readonly<Record<CouponStatus, readonly CouponStatus[]>> = {
  active: ['paused'],
  paused: ['active'],
  expired: [],
};

export function isCouponStatus(value: unknown): value is CouponStatus {
  return typeof value === 'string' && (COUPON_STATUSES as readonly string[]).includes(value);
}

/** from (今の状態) から to へ変えてよいか。from が知らない値なら、どこへも変えない */
export function isAllowedCouponStatusTransition(from: string, to: CouponStatus): boolean {
  return isCouponStatus(from) && COUPON_STATUS_TRANSITIONS[from].includes(to);
}

/** 遷移表に無い状態の変更を断るときのエラーの code (HTTP は 409) */
export const COUPON_INVALID_TRANSITION_ERROR_CODE = 'OP_COUPON_INVALID_TRANSITION';

/** 状態の値を「画面の名前 (値)」にする (表に無い値は「不明な状態 (値)」。英字の値を括弧の外に出さない) */
function couponStatusLabel(status: string): string {
  const label = isCouponStatus(status) ? COUPON_STATUS_LABELS[status] : '不明な状態';
  return `${label} (${status})`;
}

/** 遷移表にある遷移を「a → b」の形で並べた文 (断るときの文に添える) */
const ALLOWED_COUPON_TRANSITIONS_TEXT = COUPON_STATUSES.flatMap((from) =>
  COUPON_STATUS_TRANSITIONS[from].map((to) => `${couponStatusLabel(from)} → ${couponStatusLabel(to)}`),
).join('・');

/** 遷移表に無い状態の変更を断るときの文。変えられる遷移も添える */
export function couponStatusTransitionMessage(from: string, to: CouponStatus): string {
  return `クーポンの状態は ${couponStatusLabel(from)} から ${couponStatusLabel(to)} へは変えられません (変えられるのは ${ALLOWED_COUPON_TRANSITIONS_TEXT} だけです)`;
}

/**
 * 有効期限の日が有効開始日より前のときの 400 OP_INVALID_INPUT の文。
 * POST (CouponCreateSchema の refine) と PATCH (/api/super-admin/coupons/[id] が保存済みの valid_from と比べる。#1510) で同じ文を返す
 */
export const COUPON_VALID_UNTIL_BEFORE_FROM_MESSAGE = '有効終了日は有効開始日と同じ日かそれより後にしてください';

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
  // #1483: 有効開始日・有効期限は JST の暦日 (YYYY-MM-DD の実在する日付) で受け取る。
  // DB には src/lib/super-admin/coupon-validity.ts で、開始日の JST 0:00 と期限の日の JST 23:59:59.999999 にして書く
  valid_from: CalendarDateSchema,
  valid_until: CalendarDateSchema,
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
    // 開始日 <= 期限の日 (同じ日なら、その日の JST 0:00〜23:59:59 の 1 日だけ使える)。
    // どちらも CalendarDateSchema を通った YYYY-MM-DD (年は 4 桁) なので、文字列の大小が日付の前後と同じ
    return data.valid_from <= data.valid_until;
  }, { message: COUPON_VALID_UNTIL_BEFORE_FROM_MESSAGE, path: ['valid_until'] });

export type CouponCreateInput = z.infer<typeof CouponCreateSchema>;

/** クーポン更新リクエスト */
export const CouponUpdateSchema = z.object({
  display_name: z.string().max(200).nullable().optional(),
  status: z.enum(COUPON_STATUSES).optional(),
  // #1483: 有効期限は JST の暦日で受け取り、その日の JST 23:59:59.999999 にして書く (CouponCreateSchema と同じ)。
  // #1510: 保存済みの有効開始日より前の日は 400 (valid_from は本文に無いので、ルートが DB の値と比べる)
  valid_until: CalendarDateSchema.optional(),
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
