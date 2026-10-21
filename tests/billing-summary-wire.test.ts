/**
 * 契約の要約 (GET /api/billing/subscription の data) の形が、モバイルが読む JSON の形 (@homegohan/shared の BillingSummaryWire) と
 * 同じであること (billing/03 §14.1 のテスト 94。§8.6)。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseBillingSummaryWire, type BillingSummaryWire } from '@homegohan/shared';
import { EMPTY_PLAN_FEATURES, summarizeSubscription, type BillingSummary, type PlanFeatures, type SubscriptionRowView } from '@/lib/billing/core';

function row(overrides: Partial<SubscriptionRowView> = {}): SubscriptionRowView {
  return {
    id: 'row-1',
    plan_key: 'pro',
    status: 'active',
    stripe_subscription_id: 'sub_1',
    billing_interval: 'month',
    current_period_end: '2026-11-20T15:00:00.000Z',
    trial_ends_at: null,
    cancel_at_period_end: false,
    cancel_at: null,
    iap_store: null,
    iap_synced_at: null,
    ...overrides,
  };
}

const FREE_FEATURES: PlanFeatures = {
  ai_daily_limit: 3,
  ai_feature_caps: { menu_generation_ultimate: 0, image_generation: 0, meal_image_auto: 0, menu_generation: 3 },
};

describe('billing/03 §8.6 BillingSummary と BillingSummaryWire', () => {
  it('summarizeSubscription results are assignable to BillingSummaryWire (type) and parseBillingSummaryWire returns them unchanged for S / M / I / no-row cases, and returns null for a missing features field', () => {
    // 型: BillingSummary は BillingSummaryWire に代入できる (モバイルが読む形と食い違わない)
    expectTypeOf<BillingSummary>().toMatchTypeOf<BillingSummaryWire>();
    const cases: Array<[string, BillingSummary]> = [
      ['S (Stripe)', summarizeSubscription(row(), true, 'pro', { ai_daily_limit: 30, ai_feature_caps: { menu_generation_ultimate: 2 } })],
      ['M (手動付与)', summarizeSubscription(row({ stripe_subscription_id: null, billing_interval: null }), false, 'pro', EMPTY_PLAN_FEATURES)],
      ['I (App Store)', summarizeSubscription(row({ stripe_subscription_id: null, iap_store: 'app_store', status: 'trialing', trial_ends_at: '2026-10-28T00:00:00Z' }), false, 'pro', EMPTY_PLAN_FEATURES)],
      ['I (Google Play・解約の予約)', summarizeSubscription(row({ stripe_subscription_id: null, iap_store: 'play_store', billing_interval: 'year', cancel_at_period_end: true, cancel_at: '2027-10-01T00:00:00Z' }), false, 'family_pro', EMPTY_PLAN_FEATURES)],
      ['行なし (無料)', summarizeSubscription(null, false, 'free', FREE_FEATURES)],
      ['期限切れのストアの行', summarizeSubscription(row({ stripe_subscription_id: null, iap_store: 'app_store', status: 'expired' }), false, 'free', FREE_FEATURES)],
    ];
    for (const [name, summary] of cases) {
      const asWire: BillingSummaryWire = summary;
      // JSON を通した形 (API の応答) も同じに読める
      expect(parseBillingSummaryWire(JSON.parse(JSON.stringify(asWire))), name).toEqual(summary);
    }
    // features が無い・形が違う要約は読まない (画面は「契約の状態を読み込めませんでした」)
    const withoutFeatures = Object.fromEntries(Object.entries(cases[0][1]).filter(([key]) => key !== 'features'));
    expect(parseBillingSummaryWire(withoutFeatures)).toBeNull();
    expect(parseBillingSummaryWire({ ...cases[0][1], features: { ai_daily_limit: '3', ai_feature_caps: {} } })).toBeNull();
    expect(parseBillingSummaryWire({ ...cases[0][1], manage_in_store: 'amazon' })).toBeNull();
    expect(parseBillingSummaryWire(null)).toBeNull();
  });
});
