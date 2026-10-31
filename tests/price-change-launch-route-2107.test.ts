/**
 * #2107 Y2・Y6・Y8: 価格の変更の route と、販売開始の Price の登録を画面から行うための判定の部品
 *
 * Y8 (以前): Stripe の同期が要るプランで、片方の間隔だけ Stripe Price ID が無いときに両方の間隔へ今と同じ価格を送ると、
 *   route は「送った間隔のどれかの ID が無い」ので全体を続け、input 全体を Edge Function に渡した。ID のある間隔にも新しい Price が作られ、
 *   使っていた Price が無効化され、履歴・監査に余計な値が残った。
 * 直したあと (不変条件):
 *   - 今と同じ価格で、Stripe の同期が要らないか Price ID が入っている間隔は、送られても外す (Stripe・apply・監査・応答に渡さない)
 *   - 外した結果どちらの間隔も残らなければ 409 OP_PRICE_UNCHANGED (これまでどおり Stripe も DB も触らず、監査も書かない)
 * Y6 (以前): 予約が取れない (進行中) ときの 409 の文が「別の運営がこのプランの価格を変更しています」で、504 のあとの自分の押し直しを
 *   別の運営の操作と見せた。いまは「このプランの価格の変更が進行中です (直前のあなたの操作かもしれません)」
 * Y2: 画面が「Stripe の同期が要るか」を知るため、GET /api/super-admin/plans/{id} は stripe_price_sync_expected を返す
 *   (route の判定と同じ: Stripe の鍵があり、プランに stripe_product_id がある)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeSupabase, type FakeSupabase } from './helpers/fake-supabase';
import {
  PLAN_ID,
  actor,
  applyArgs,
  auditDetails,
  edgeOk,
  edgeRequestBody,
  existingPlan,
  priceChangeRequest,
  priceChangeSupabase,
  reserved,
  rpcOrder,
  stubEdge,
} from './helpers/price-change-route-world';
import { PLAN_PRICE_CHANGE_RPC, PRICE_CHANGE_IN_PROGRESS_MESSAGE } from '@/lib/super-admin/plan-price-change-reservation';
import {
  PRICE_UNCHANGED_CODE,
  isStripePriceSyncExpected,
  pendingPriceChange,
  priceChangeAlreadyApplied,
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
const { GET } = await import('@/app/api/super-admin/plans/[id]/route');

const ORIGINAL_ENV = { ...process.env };
/** existingPlan() の今の価格 (月額 1000・年額 10000) */
const CURRENT = existingPlan();
/** Edge Function が作る新しい Price の ID */
const NEW_MONTH_PRICE = 'price_new';
const NEW_YEAR_PRICE = 'price_year_new';

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

describe('Y8: 今と同じ価格で Price ID のある間隔は外し、ID の無い間隔だけを同期する (#2107)', () => {
  it('月額の ID はあり年額の ID が無いプランに両方を今と同じ価格で送ると、年額だけを Stripe で作り、月額の Price は作り直さない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ begin: reserved({ ...existingPlan(), stripe_yearly_price_id: null }) });
    const fetchMock = stubEdge(edgeOk({ month: { new_stripe_price_id: NEW_MONTH_PRICE }, year: { new_stripe_price_id: NEW_YEAR_PRICE } }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: CURRENT.monthly_price_jpy, new_yearly_price_jpy: CURRENT.yearly_price_jpy }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Edge Function に月額を渡さない (渡すと月額の新しい Price が作られ、使っていた月額の Price が無効化される)
    const edgeBody = edgeRequestBody(fetchMock);
    expect(edgeBody.new_monthly_price_jpy ?? null).toBeNull();
    expect(edgeBody.new_yearly_price_jpy).toBe(CURRENT.yearly_price_jpy);
    // 履歴と価格: 月額は書かない (null)・年額は同じ価格と新しい年額の Price
    const args = applyArgs(fakeSupabase)!;
    expect(args.p_new_monthly_price_jpy).toBeNull();
    expect(args.p_new_stripe_price_id).toBeNull();
    expect(args.p_new_yearly_price_jpy).toBe(CURRENT.yearly_price_jpy);
    expect(args.p_new_stripe_yearly_price_id).toBe(NEW_YEAR_PRICE);
    // 監査と応答も外した月額を「変えた」と書かない
    const details = auditDetails(fakeSupabase)!;
    expect(details.new_monthly_price_jpy ?? null).toBeNull();
    expect(details.new_stripe_price_id).toBeNull();
    expect(details.new_yearly_price_jpy).toBe(CURRENT.yearly_price_jpy);
    expect(details.new_stripe_yearly_price_id).toBe(NEW_YEAR_PRICE);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.new_monthly_price_jpy ?? null).toBeNull();
    expect(body.data.new_stripe_price_id).toBeNull();
    expect(body.data.new_stripe_yearly_price_id).toBe(NEW_YEAR_PRICE);
  });

  it('年額の ID はあり月額の ID が無いプランに両方を今と同じ価格で送ると、月額だけを Stripe で作る', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ begin: reserved({ ...existingPlan(), stripe_price_id: null }) });
    const fetchMock = stubEdge(edgeOk({ month: { new_stripe_price_id: NEW_MONTH_PRICE }, year: { new_stripe_price_id: NEW_YEAR_PRICE } }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: CURRENT.monthly_price_jpy, new_yearly_price_jpy: CURRENT.yearly_price_jpy }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(200);
    const edgeBody = edgeRequestBody(fetchMock);
    expect(edgeBody.new_monthly_price_jpy).toBe(CURRENT.monthly_price_jpy);
    expect(edgeBody.new_yearly_price_jpy ?? null).toBeNull();
    const args = applyArgs(fakeSupabase)!;
    expect(args.p_new_stripe_price_id).toBe(NEW_MONTH_PRICE);
    expect(args.p_new_yearly_price_jpy).toBeNull();
    expect(args.p_new_stripe_yearly_price_id).toBeNull();
  });

  it('月額は今と同じ (ID あり) で年額だけ今と違うときも、月額の Price は作り直さず年額だけを同期する', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const NEW_YEARLY = 12000;
    const fetchMock = stubEdge(edgeOk({ month: { new_stripe_price_id: NEW_MONTH_PRICE }, year: { new_stripe_price_id: NEW_YEAR_PRICE } }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: CURRENT.monthly_price_jpy, new_yearly_price_jpy: NEW_YEARLY }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(200);
    const edgeBody = edgeRequestBody(fetchMock);
    expect(edgeBody.new_monthly_price_jpy ?? null).toBeNull();
    expect(edgeBody.new_yearly_price_jpy).toBe(NEW_YEARLY);
    const args = applyArgs(fakeSupabase)!;
    expect(args.p_new_monthly_price_jpy).toBeNull();
    expect(args.p_new_stripe_price_id).toBeNull();
    expect(args.p_new_yearly_price_jpy).toBe(NEW_YEARLY);
  });

  it('両方の ID が入っていて両方を今と同じ価格で送ると、これまでどおり 409 OP_PRICE_UNCHANGED (Stripe も apply も呼ばない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(edgeOk({}));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: CURRENT.monthly_price_jpy, new_yearly_price_jpy: CURRENT.yearly_price_jpy }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(PRICE_UNCHANGED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.release]);
  });

  it('Stripe の同期が要らない環境 (mock) で月額は今と同じ・年額だけ違うときは、月額を履歴に「変えた」と書かない', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase();
    const NEW_YEARLY = 12000;
    const fetchMock = stubEdge(edgeOk({}));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: CURRENT.monthly_price_jpy, new_yearly_price_jpy: NEW_YEARLY }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const args = applyArgs(fakeSupabase)!;
    expect(args.p_new_monthly_price_jpy).toBeNull();
    expect(args.p_new_yearly_price_jpy).toBe(NEW_YEARLY);
  });
});

describe('Y6: 予約が取れない (進行中) ときの 409 の文は、自分の直前の操作のことがあると伝える (#2107)', () => {
  it('409 CONFLICT_STALE_DATA の文は「進行中」で、「別の運営」と言わず、履歴で確かめさせる', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ begin: { data: { result: 'in_progress' }, error: null } });
    const fetchMock = stubEdge(edgeOk({}));

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT_STALE_DATA');
    expect(body.error.message).toBe(PRICE_CHANGE_IN_PROGRESS_MESSAGE);
    expect(PRICE_CHANGE_IN_PROGRESS_MESSAGE).toBe(
      'このプランの価格の変更が進行中です (直前のあなたの操作かもしれません)。しばらくしてから読み込み直して履歴で確かめてください',
    );
    expect(body.error.message).not.toContain('別の運営');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Y2: GET /api/super-admin/plans/{id} は stripe_price_sync_expected を返す (#2107)', () => {
  const planRow = (stripeProductId: string | null) => ({ ...existingPlan(), stripe_product_id: stripeProductId, stripe_yearly_price_id: null });

  async function getPlan(stripeProductId: string | null) {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: planRow(stripeProductId), error: null }],
      plan_price_history: [{ data: [], error: null }],
    });
    const res = await GET(new NextRequest(`http://localhost/api/super-admin/plans/${PLAN_ID}`), { params: Promise.resolve({ id: PLAN_ID }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  }

  it('Stripe の鍵があり、プランに stripe_product_id があれば true', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const data = await getPlan('prod_123');
    expect(data.stripe_price_sync_expected).toBe(true);
    // 鍵の値そのものは返さない
    expect(JSON.stringify(data)).not.toContain('sk_test_x');
  });

  it('Stripe の鍵が無ければ false', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect((await getPlan('prod_123')).stripe_price_sync_expected).toBe(false);
  });

  it('プランに stripe_product_id が無ければ false', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    expect((await getPlan(null)).stripe_price_sync_expected).toBe(false);
  });
});

describe('isStripePriceSyncExpected / pendingPriceChange / priceChangeAlreadyApplied (#2107)', () => {
  const withIds = { monthly_price_jpy: 1000, yearly_price_jpy: 10000, stripe_price_id: 'price_m', stripe_yearly_price_id: 'price_y' };

  it('isStripePriceSyncExpected: 鍵と stripe_product_id の両方があるときだけ true', () => {
    expect(isStripePriceSyncExpected('sk_test_x', 'prod_1')).toBe(true);
    expect(isStripePriceSyncExpected(undefined, 'prod_1')).toBe(false);
    expect(isStripePriceSyncExpected('', 'prod_1')).toBe(false);
    expect(isStripePriceSyncExpected('sk_test_x', null)).toBe(false);
    expect(isStripePriceSyncExpected('sk_test_x', '')).toBe(false);
  });

  it('pendingPriceChange: 今と違う価格の間隔は残す', () => {
    expect(pendingPriceChange(withIds, { new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }, true)).toEqual({
      new_monthly_price_jpy: 1200,
      new_yearly_price_jpy: 12000,
    });
  });

  it('pendingPriceChange: 今と同じ価格で、Stripe の同期が要り Price ID が無い間隔は残す (販売開始の Price の登録)', () => {
    const noYearly = { ...withIds, stripe_yearly_price_id: null };
    expect(pendingPriceChange(noYearly, { new_monthly_price_jpy: 1000, new_yearly_price_jpy: 10000 }, true)).toEqual({
      new_monthly_price_jpy: null,
      new_yearly_price_jpy: 10000,
    });
    const noIds = { ...withIds, stripe_price_id: '', stripe_yearly_price_id: null };
    expect(pendingPriceChange(noIds, { new_monthly_price_jpy: 1000, new_yearly_price_jpy: 10000 }, true)).toEqual({
      new_monthly_price_jpy: 1000,
      new_yearly_price_jpy: 10000,
    });
  });

  it('pendingPriceChange: 今と同じ価格で Stripe の同期が要らなければ、ID が無くても外す', () => {
    const noIds = { ...withIds, stripe_price_id: null, stripe_yearly_price_id: null };
    expect(pendingPriceChange(noIds, { new_monthly_price_jpy: 1000, new_yearly_price_jpy: 10000 }, false)).toEqual({
      new_monthly_price_jpy: null,
      new_yearly_price_jpy: null,
    });
  });

  it('pendingPriceChange: 送っていない間隔は null のまま (Price ID が無くても足さない)', () => {
    const noIds = { ...withIds, stripe_price_id: null, stripe_yearly_price_id: null };
    expect(pendingPriceChange(noIds, { new_monthly_price_jpy: 1000 }, true)).toEqual({
      new_monthly_price_jpy: 1000,
      new_yearly_price_jpy: null,
    });
    expect(pendingPriceChange(noIds, {}, true)).toEqual({ new_monthly_price_jpy: null, new_yearly_price_jpy: null });
  });

  it('priceChangeAlreadyApplied は「送った間隔がすべて外れる」と同じ。何も送っていなければ false', () => {
    const noYearly = { ...withIds, stripe_yearly_price_id: null };
    expect(priceChangeAlreadyApplied(noYearly, { new_monthly_price_jpy: 1000, new_yearly_price_jpy: 10000 }, true)).toBe(false);
    expect(priceChangeAlreadyApplied(noYearly, { new_monthly_price_jpy: 1000 }, true)).toBe(true);
    expect(priceChangeAlreadyApplied(withIds, { new_monthly_price_jpy: 1000, new_yearly_price_jpy: 10000 }, true)).toBe(true);
    expect(priceChangeAlreadyApplied(withIds, {}, true)).toBe(false);
    expect(priceChangeAlreadyApplied(withIds, {}, false)).toBe(false);
  });
});
