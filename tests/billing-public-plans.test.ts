/**
 * billing/01 §10.1 (#1701 段 C): /pricing が読む「買えるプラン」の一覧 (src/lib/billing/public-plans.ts)。
 *
 * - 読み取りに失敗したら例外を投げずに空を返し、error ログに残す (/pricing はエラーページにせず「準備中」を描く)
 * - 成功したら行をそのまま返す。条件は public・個人/家族・free でない・月額の Price がある・display_order 順
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchasablePlan } from '@/lib/billing/core';

const mocks = vi.hoisted(() => {
  const calls: { method: string; args: unknown[] }[] = [];
  const result: { data: unknown; error: unknown } = { data: [], error: null };
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['from', 'select', 'eq', 'in', 'neq', 'not']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.order = async (...args: unknown[]) => {
    calls.push({ method: 'order', args });
    return result;
  };
  return { calls, result, builder, loggerError: vi.fn() };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.builder }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ error: mocks.loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { listPurchasablePlans } from '@/lib/billing/public-plans';

const ROW: PurchasablePlan = {
  plan_key: 'pro',
  display_name: 'プロ',
  plan_type: 'personal',
  status: 'public',
  monthly_price_jpy: 1234,
  yearly_price_jpy: 12340,
  trial_days: 7,
  stripe_price_id: 'price_month',
  stripe_yearly_price_id: null,
};

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.result.data = [];
  mocks.result.error = null;
  mocks.loggerError.mockReset();
});

describe('billing/01 §10.1 listPurchasablePlans', () => {
  it('listPurchasablePlans returns [] and logs an error when the query fails (the page shows 準備中 instead of an error page), and returns the rows on success', async () => {
    // 失敗: 投げずに空を返し、error ログに残す
    const failure = { message: 'permission denied', code: '42501' };
    mocks.result.data = null;
    mocks.result.error = failure;
    await expect(listPurchasablePlans()).resolves.toEqual([]);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0][1]).toBe(failure);

    // 成功: 行をそのまま返す (ログは書かない)
    mocks.loggerError.mockReset();
    mocks.calls.length = 0;
    mocks.result.data = [ROW];
    mocks.result.error = null;
    await expect(listPurchasablePlans()).resolves.toEqual([ROW]);
    expect(mocks.loggerError).not.toHaveBeenCalled();

    // 問い合わせの条件 (§10.1): public・個人/家族・free でない・月額の Price がある・display_order 順
    expect(mocks.calls).toEqual([
      { method: 'from', args: ['subscription_plans'] },
      {
        method: 'select',
        args: ['plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id'],
      },
      { method: 'eq', args: ['status', 'public'] },
      { method: 'in', args: ['plan_type', ['personal', 'family']] },
      { method: 'neq', args: ['plan_key', 'free'] },
      { method: 'not', args: ['stripe_price_id', 'is', null] },
      { method: 'order', args: ['display_order', { ascending: true }] },
    ]);

    // data が null でも空を返す
    mocks.result.data = null;
    await expect(listPurchasablePlans()).resolves.toEqual([]);
  });
});
