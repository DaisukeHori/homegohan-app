/**
 * billing/01 §10.1 (#1701 段 C)・billing/03 §8.6: /pricing とアプリ内課金のカタログが読む「公開のプラン」の一覧
 * (src/lib/billing/public-plans.ts の listPublicPlans。listPurchasablePlans を置き換えた)。
 *
 * - 読み取りに失敗したら例外を投げずに空を返し、error ログに残す (/pricing はエラーページにせずフリーのカードだけを描く)
 * - 成功したら行をそのまま返す。条件は public・個人/家族・free でない・月額の金額が正・display_order 順 → id 順 (Stripe の Price では絞らない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicPlan } from '@/lib/billing/core';

const mocks = vi.hoisted(() => {
  const calls: { method: string; args: unknown[] }[] = [];
  const result: { data: unknown; error: unknown } = { data: [], error: null };
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['from', 'select', 'eq', 'in', 'neq', 'gt']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  // order は重ねて呼べて (表示の順のあとに id を重ねる。#2144 S3)、await すると結果を返す
  const ordered = {
    order: (...args: unknown[]) => {
      calls.push({ method: 'order', args });
      return ordered;
    },
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  builder.order = (...args: unknown[]) => ordered.order(...args);
  return { calls, result, builder, loggerError: vi.fn() };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.builder }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ error: mocks.loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { listPublicPlans } from '@/lib/billing/public-plans';

const ROW: PublicPlan = {
  plan_key: 'pro',
  display_name: 'プロ',
  plan_type: 'personal',
  status: 'public',
  monthly_price_jpy: 1234,
  yearly_price_jpy: 12340,
  trial_days: 7,
  stripe_price_id: 'price_month',
  stripe_yearly_price_id: null,
  max_members: null,
};

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.result.data = [];
  mocks.result.error = null;
  mocks.loggerError.mockReset();
});

describe('billing/01 §10.1・billing/03 §8.6 listPublicPlans', () => {
  it('listPublicPlans returns [] and logs an error when the query fails (the page shows only the free card instead of an error page), and returns the rows on success', async () => {
    // 失敗: 投げずに空を返し、error ログに残す
    const failure = { message: 'permission denied', code: '42501' };
    mocks.result.data = null;
    mocks.result.error = failure;
    await expect(listPublicPlans()).resolves.toEqual([]);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0][1]).toBe(failure);

    // 成功: 行をそのまま返す (ログは書かない)
    mocks.loggerError.mockReset();
    mocks.calls.length = 0;
    mocks.result.data = [ROW];
    mocks.result.error = null;
    await expect(listPublicPlans()).resolves.toEqual([ROW]);
    expect(mocks.loggerError).not.toHaveBeenCalled();

    // 問い合わせの条件 (billing/03 §8.6): public・個人/家族・free でない・月額の金額が正・display_order 順 (Price では絞らない)
    expect(mocks.calls).toEqual([
      { method: 'from', args: ['subscription_plans'] },
      {
        method: 'select',
        args: ['plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id, max_members'],
      },
      { method: 'eq', args: ['status', 'public'] },
      { method: 'in', args: ['plan_type', ['personal', 'family']] },
      { method: 'neq', args: ['plan_key', 'free'] },
      { method: 'gt', args: ['monthly_price_jpy', 0] },
      { method: 'order', args: ['display_order', { ascending: true, nullsFirst: false }] },
      // 同じ表示の順のプランは id の順 (#2144 S3。LIST_ORDERS.billingPublicPlans)
      { method: 'order', args: ['id', { ascending: true, nullsFirst: false }] },
    ]);

    // data が null でも空を返す
    mocks.result.data = null;
    await expect(listPublicPlans()).resolves.toEqual([]);
  });
});
