/**
 * 契約の状態の文の Web (src/lib/billing/core.ts の billingStatusLines) とモバイル (@homegohan/shared の subscriptionStatusLines) の一致
 * (billing/03 §14.1 のテスト 93)。モバイルは Web の src を import しないので、同じ規則を 2 か所に持つ。その一致をここで固定する。
 */
import { describe, expect, it } from 'vitest';
import { subscriptionStatusLines, SUBSCRIPTION_STATUS_TEXT_WIRE, CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE } from '@homegohan/shared';
import { BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT, BILLING_STATUS_TEXT, billingStatusLines, type SubscriptionStatus } from '@/lib/billing/core';

const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'grace', 'paused'] as const satisfies readonly SubscriptionStatus[];

/** 日本時間の 0 時の前後 (UTC の 15 時の前後) と、日中・読めない値 */
const DATES: Array<string | null> = [
  null,
  '2026-10-20T14:59:59Z',
  '2026-10-20T15:00:00Z',
  '2026-10-20T15:00:01Z',
  '2026-12-31T15:00:00Z',
  '2026-11-21T03:00:00Z',
  'not a date',
];

describe('billing/03 §8.9 契約の状態の文 (Web とモバイル)', () => {
  it('subscriptionStatusLines (@homegohan/shared) equals billingStatusLines (core.ts) for the 5 live statuses × cancel_at_period_end × trial_ends_at / cancel_at present or null, including dates near JST midnight', () => {
    expect({ ...SUBSCRIPTION_STATUS_TEXT_WIRE }).toEqual({ ...BILLING_STATUS_TEXT });
    expect(CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE).toBe(BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT);
    let compared = 0;
    for (const status of [...LIVE_STATUSES, 'cancelled', 'expired', 'incomplete', null] as const) {
      for (const cancelAtPeriodEnd of [false, true]) {
        for (const trialEndsAt of DATES) {
          for (const cancelAt of DATES) {
            for (const currentPeriodEnd of [null, '2026-11-20T15:30:00Z']) {
              const summary = { status, trial_ends_at: trialEndsAt, current_period_end: currentPeriodEnd, cancel_at_period_end: cancelAtPeriodEnd, cancel_at: cancelAt };
              expect(subscriptionStatusLines(summary), JSON.stringify(summary)).toEqual(billingStatusLines(summary));
              compared += 1;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
    // 日本時間の 0 時をまたぐ日付 (UTC の 15 時ちょうどは日本の翌日)
    expect(subscriptionStatusLines({ status: 'trialing', trial_ends_at: '2026-10-20T15:00:00Z', current_period_end: null, cancel_at_period_end: false, cancel_at: null })).toEqual([
      '無料期間中（2026年10月21日まで）',
    ]);
    expect(subscriptionStatusLines({ status: 'trialing', trial_ends_at: '2026-10-20T14:59:59Z', current_period_end: null, cancel_at_period_end: false, cancel_at: null })).toEqual([
      '無料期間中（2026年10月20日まで）',
    ]);
  });
});
