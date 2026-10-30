/**
 * #2101 X1: 価格の変更の POST は、送られた価格が今の価格と同じなら Stripe も DB も触らず、監査も書かずに 409 OP_PRICE_UNCHANGED
 *
 * 以前は、価格の変更の応答が切れた (fetch の reject・本文の無い 502 / 504) あとに運営が押し直すと、1 回目で済んでいても
 * 同じ金額でもう一度 Stripe に新しい Price を作り (Edge Function stripe-price-sync)、1 回目に作った Price を無効化し、
 * plan_price_history と監査に 2 行目が入った。route は予約 (:293-312) で同時の実行だけを断り、新しい価格が今の価格と同じかを見る箇所が無かった。
 * 直したあと (不変条件):
 *   - 予約 (begin_plan_price_change) がロックの下で読んだ今の価格と、送られた価格 (送った方だけ) がすべて同じなら 409 OP_PRICE_UNCHANGED。
 *     Stripe (Edge Function) を呼ばず、apply を呼ばず (履歴と価格を書かない)、監査を書かず、予約は release で消す
 *   - Stripe の同期が要らない環境 (mock) でも同じ (履歴と監査の 2 行目を作らない)
 *   - 送った価格のどれかが今の価格と違えば、これまでどおり変更する
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeSupabase } from './helpers/fake-supabase';
import {
  PLAN_ID,
  RESERVATION_TOKEN,
  actor,
  auditDetails,
  edgeOk,
  existingPlan,
  priceChangeRequest,
  priceChangeSupabase,
  reserved,
  rpcArgs,
  rpcOrder,
  stubEdge,
} from './helpers/price-change-route-world';
import { PLAN_PRICE_CHANGE_RPC } from '@/lib/super-admin/plan-price-change-reservation';
import {
  PRICE_UNCHANGED_CODE,
  PRICE_UNCHANGED_MESSAGE,
  isPriceUnchangedBody,
  sentPricesMatchPlan,
} from '@/lib/super-admin/price-change-unchanged';

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/db-logger', () => ({
  generateRequestId: () => 'req-test',
  createLogger: () => ({ withUser: () => ({ error: vi.fn() }), error: vi.fn() }),
}));

let fakeSupabase: FakeSupabase;
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  getSupabaseAdmin: () => fakeSupabase,
}));

const { POST } = await import('@/app/api/super-admin/plans/[id]/price-change/route');

const ORIGINAL_ENV = { ...process.env };
const RELEASE_ARGS = { p_plan_id: PLAN_ID, p_token: RESERVATION_TOKEN };
/** existingPlan() の今の価格 (月額 1000・年額 10000) */
const CURRENT = existingPlan();

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
  process.env = { ...ORIGINAL_ENV };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('送られた価格が今の価格と同じなら 409 OP_PRICE_UNCHANGED (Stripe も DB も触らず、監査も書かない。#2101 X1)', () => {
  it.each([
    ['月額だけを送り、今の月額と同じ', { new_monthly_price_jpy: CURRENT.monthly_price_jpy }],
    ['年額だけを送り、今の年額と同じ', { new_monthly_price_jpy: null, new_yearly_price_jpy: CURRENT.yearly_price_jpy }],
    ['月額と年額を送り、どちらも今と同じ', { new_monthly_price_jpy: CURRENT.monthly_price_jpy, new_yearly_price_jpy: CURRENT.yearly_price_jpy }],
  ])('%s: Stripe の同期を呼ばず、apply を呼ばず、予約を消して 409', async (_label, body) => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_dup' }, year: { new_stripe_price_id: 'price_year_dup' } }));

    const res = await POST(priceChangeRequest(body), { params: { id: PLAN_ID } });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: PRICE_UNCHANGED_CODE, message: PRICE_UNCHANGED_MESSAGE } });
    // Stripe に 2 つ目の Price を作らない (1 回目の Price を無効化しない)
    expect(fetchMock).not.toHaveBeenCalled();
    // 履歴と価格を書かない (apply を呼ばない)。予約は消す
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.release]);
    expect(rpcArgs(fakeSupabase, PLAN_PRICE_CHANGE_RPC.release)).toEqual([RELEASE_ARGS]);
    // 監査の 2 行目を書かない
    expect(auditDetails(fakeSupabase)).toBeUndefined();
  });

  it('Stripe の同期が要らない環境 (mock) でも、同じ価格なら 409 で履歴と監査を書かない', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(edgeOk({}));

    const res = await POST(priceChangeRequest({ new_monthly_price_jpy: CURRENT.monthly_price_jpy }), { params: { id: PLAN_ID } });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(PRICE_UNCHANGED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.release]);
    expect(auditDetails(fakeSupabase)).toBeUndefined();
  });

  it('比べるのは予約がロックの下で読んだ今の価格 (1 回目で変わったあとの値と同じなら 409)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    // 1 回目の変更で月額が 1200 になったあと
    fakeSupabase = priceChangeSupabase({ begin: reserved({ ...existingPlan(), monthly_price_jpy: 1200, stripe_price_id: 'price_first' }) });
    const fetchMock = stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_dup' } }));

    const res = await POST(priceChangeRequest({ new_monthly_price_jpy: 1200 }), { params: { id: PLAN_ID } });

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.release]);
  });

  it.each([
    ['月額が今と違う', { new_monthly_price_jpy: 1200 }],
    ['月額は今と同じだが年額が今と違う', { new_monthly_price_jpy: CURRENT.monthly_price_jpy, new_yearly_price_jpy: 12000 }],
    ['年額だけを送り、今と違う', { new_monthly_price_jpy: null, new_yearly_price_jpy: 12000 }],
  ])('%s: これまでどおり Stripe を同期して apply し、200', async (_label, body) => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_new' }, year: { new_stripe_price_id: 'price_year_new' } }));

    const res = await POST(priceChangeRequest(body), { params: { id: PLAN_ID } });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.apply]);
    expect(auditDetails(fakeSupabase)).toBeDefined();
  });
});

describe('sentPricesMatchPlan / isPriceUnchangedBody (#2101 X1)', () => {
  const plan = { monthly_price_jpy: 1000, yearly_price_jpy: 10000 };

  it('送った方だけを比べる', () => {
    expect(sentPricesMatchPlan(plan, { new_monthly_price_jpy: 1000 })).toBe(true);
    expect(sentPricesMatchPlan(plan, { new_monthly_price_jpy: 1000, new_yearly_price_jpy: null })).toBe(true);
    expect(sentPricesMatchPlan(plan, { new_monthly_price_jpy: null, new_yearly_price_jpy: 10000 })).toBe(true);
    expect(sentPricesMatchPlan(plan, { new_monthly_price_jpy: 1000, new_yearly_price_jpy: 10000 })).toBe(true);
    expect(sentPricesMatchPlan(plan, { new_monthly_price_jpy: 1200 })).toBe(false);
    expect(sentPricesMatchPlan(plan, { new_yearly_price_jpy: 12000 })).toBe(false);
    expect(sentPricesMatchPlan(plan, { new_monthly_price_jpy: 1000, new_yearly_price_jpy: 12000 })).toBe(false);
    expect(sentPricesMatchPlan(plan, { new_monthly_price_jpy: 1200, new_yearly_price_jpy: 10000 })).toBe(false);
  });

  it('どちらも送っていなければ false (変更が無いものを済んだとは言わない)', () => {
    expect(sentPricesMatchPlan(plan, {})).toBe(false);
    expect(sentPricesMatchPlan(plan, { new_monthly_price_jpy: null, new_yearly_price_jpy: null })).toBe(false);
  });

  it('今の価格が未設定 (null) のときは、送った値と同じにならない', () => {
    expect(sentPricesMatchPlan({ monthly_price_jpy: null, yearly_price_jpy: null }, { new_monthly_price_jpy: 0 })).toBe(false);
    expect(sentPricesMatchPlan({ monthly_price_jpy: 0, yearly_price_jpy: null }, { new_monthly_price_jpy: 0 })).toBe(true);
  });

  it('409 の本文の code が OP_PRICE_UNCHANGED のときだけ true', () => {
    expect(isPriceUnchangedBody({ error: { code: PRICE_UNCHANGED_CODE, message: PRICE_UNCHANGED_MESSAGE } })).toBe(true);
    expect(isPriceUnchangedBody({ error: { code: 'CONFLICT_STALE_DATA', message: '別の運営が…' } })).toBe(false);
    expect(isPriceUnchangedBody({ error: PRICE_UNCHANGED_CODE })).toBe(false);
    expect(isPriceUnchangedBody(null)).toBe(false);
    expect(isPriceUnchangedBody('<html>')).toBe(false);
  });
});
