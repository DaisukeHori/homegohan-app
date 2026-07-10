/**
 * #1041 (F4-07) 回帰防止テスト
 * src/lib/plan/coupon.ts — クーポン適用ロジック (作成のみで適用・上限強制が
 * 存在しなかった問題への対応)
 */
import { describe, expect, it } from 'vitest';
import { applyCoupon, calculateDiscountAmount, CouponApplyError } from '@/lib/plan/coupon';
import { createFakeSupabase } from './helpers/fake-supabase';

describe('calculateDiscountAmount', () => {
  it('fixed: discount_value をそのまま (価格を超えない)', () => {
    expect(calculateDiscountAmount({ discount_type: 'fixed', discount_value: 300 }, 1000)).toBe(300);
    expect(calculateDiscountAmount({ discount_type: 'fixed', discount_value: 3000 }, 1000)).toBe(1000);
  });

  it('percentage: 整数 floor で計算する (JPY は小数を持たない)', () => {
    // 1000 * 33% = 330
    expect(calculateDiscountAmount({ discount_type: 'percentage', discount_value: 33 }, 1000)).toBe(330);
    // 999 * 10% = 99.9 -> floor 99
    expect(calculateDiscountAmount({ discount_type: 'percentage', discount_value: 10 }, 999)).toBe(99);
  });

  it('価格が 0 以下なら 0', () => {
    expect(calculateDiscountAmount({ discount_type: 'fixed', discount_value: 100 }, 0)).toBe(0);
  });
});

function baseCoupon(overrides: Record<string, unknown> = {}) {
  return {
    id: 'coupon-1',
    code: 'WELCOME',
    status: 'active',
    discount_type: 'fixed',
    discount_value: 300,
    applicable_to: 'all',
    applicable_plans: [],
    valid_from: '2020-01-01T00:00:00.000Z',
    valid_until: '2099-01-01T00:00:00.000Z',
    max_uses: null,
    uses_count: 0,
    per_user_limit: 1,
    duration_months: null,
    ...overrides,
  };
}

function baseSub(overrides: Record<string, unknown> = {}) {
  return { id: 'sub-1', user_id: 'user-1', plan_key: 'pro', ...overrides };
}

function basePlan(overrides: Record<string, unknown> = {}) {
  return { id: 'plan-uuid-1', monthly_price_jpy: 1000, ...overrides };
}

describe('applyCoupon', () => {
  it('正常系: personal 契約に適用し、redemption を作成 + uses_count を increment する', async () => {
    const supabase = createFakeSupabase({
      coupons: [
        { data: baseCoupon(), error: null }, // 1. クーポン取得
        { data: { uses_count: 0 }, error: null }, // incrementCouponUsesCount: 現在値取得
        { data: [{ id: 'coupon-1' }], error: null }, // incrementCouponUsesCount: CAS update
      ],
      personal_subscriptions: [
        { data: baseSub(), error: null }, // 契約取得
        { data: null, error: null }, // active_coupon_redemption_id 更新
      ],
      subscription_plans: [{ data: basePlan(), error: null }],
      coupon_redemptions: [
        { data: null, error: null, count: 0 }, // per_user_limit カウント
        { data: null, error: null }, // 既存 redemption の終了処理
        { data: { id: 'redemption-1' }, error: null }, // insert
      ],
    });

    const result = await applyCoupon(supabase as never, {
      couponId: 'coupon-1',
      subscriptionTarget: 'personal',
      subscriptionId: 'sub-1',
      approvedBy: 'admin-1',
    });

    expect(result.redemptionId).toBe('redemption-1');
    expect(result.discountAmountJpy).toBe(300);
  });

  it('status が active でないクーポンは CouponApplyError(OP_COUPON_INVALID)', async () => {
    const supabase = createFakeSupabase({
      coupons: [{ data: baseCoupon({ status: 'paused' }), error: null }],
    });

    await expect(
      applyCoupon(supabase as never, {
        couponId: 'coupon-1',
        subscriptionTarget: 'personal',
        subscriptionId: 'sub-1',
        approvedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'OP_COUPON_INVALID' });
  });

  it('有効期限切れのクーポンは OP_COUPON_EXPIRED', async () => {
    const supabase = createFakeSupabase({
      coupons: [{ data: baseCoupon({ valid_until: '2000-01-01T00:00:00.000Z' }), error: null }],
    });

    await expect(
      applyCoupon(supabase as never, {
        couponId: 'coupon-1',
        subscriptionTarget: 'personal',
        subscriptionId: 'sub-1',
        approvedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'OP_COUPON_EXPIRED' });
  });

  it('per_user_limit に達している場合は OP_COUPON_LIMIT_REACHED (uses_count を increment しない)', async () => {
    const supabase = createFakeSupabase({
      coupons: [{ data: baseCoupon({ per_user_limit: 1 }), error: null }],
      personal_subscriptions: [{ data: baseSub(), error: null }],
      subscription_plans: [{ data: basePlan(), error: null }],
      coupon_redemptions: [{ data: null, error: null, count: 1 }], // 既に 1 回使用済み
    });

    await expect(
      applyCoupon(supabase as never, {
        couponId: 'coupon-1',
        subscriptionTarget: 'personal',
        subscriptionId: 'sub-1',
        approvedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'OP_COUPON_LIMIT_REACHED' });
  });

  it('max_uses に既に達している場合は原子的 increment が false を返し OP_COUPON_LIMIT_REACHED', async () => {
    const supabase = createFakeSupabase({
      coupons: [
        { data: baseCoupon({ max_uses: 5, uses_count: 5 }), error: null },
        { data: { uses_count: 5 }, error: null }, // increment 時の現在値取得 (既に上限)
      ],
      personal_subscriptions: [{ data: baseSub(), error: null }],
      subscription_plans: [{ data: basePlan(), error: null }],
      coupon_redemptions: [{ data: null, error: null, count: 0 }],
    });

    await expect(
      applyCoupon(supabase as never, {
        couponId: 'coupon-1',
        subscriptionTarget: 'personal',
        subscriptionId: 'sub-1',
        approvedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'OP_COUPON_LIMIT_REACHED' });
  });

  it('applicable_to が一致しない場合は OP_COUPON_NOT_APPLICABLE', async () => {
    const supabase = createFakeSupabase({
      coupons: [{ data: baseCoupon({ applicable_to: 'org' }), error: null }],
    });

    await expect(
      applyCoupon(supabase as never, {
        couponId: 'coupon-1',
        subscriptionTarget: 'personal',
        subscriptionId: 'sub-1',
        approvedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'OP_COUPON_NOT_APPLICABLE' });
  });

  it('存在しないクーポンは OP_COUPON_NOT_FOUND', async () => {
    const supabase = createFakeSupabase({ coupons: [{ data: null, error: null }] });

    await expect(
      applyCoupon(supabase as never, {
        couponId: 'missing',
        subscriptionTarget: 'personal',
        subscriptionId: 'sub-1',
        approvedBy: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(CouponApplyError);
  });
});
