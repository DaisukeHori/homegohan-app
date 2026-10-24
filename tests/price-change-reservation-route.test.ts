/**
 * #1917 の続き: POST /api/super-admin/plans/[id]/price-change の同時の変更
 *
 * 以前は route がプランをロックも条件も無く読み、その値を plan_price_history と監査の old_* に書き、価格を .eq(id) だけで UPDATE していた。
 * 2 人の運営がほぼ同時に同じプランの価格を変えると、後の記録の old_* が実際の直前の値と食い違った。
 * いまは route が次の順に動く (src/lib/super-admin/plan-price-change-reservation.ts):
 *   1. begin_plan_price_change で予約を取る (別の運営の価格の変更が進行中なら 409 CONFLICT_STALE_DATA で、Stripe も DB も触らない)
 *   2. Stripe の同期 (予約を取った 1 本だけ)
 *   3. apply_plan_price_change で履歴と価格を書く (予約を失っていたら 409 で何も書かない)
 *   4. 監査の old_* (old_monthly_price_jpy・old_yearly_price_jpy・old_stripe_price_id・old_stripe_yearly_price_id) は、
 *      apply がロックの下で読んで返した previous で書く (begin のときに読んだ値ではない)
 *   apply まで行かなかったときは release_plan_price_change で予約を消す。
 * ここでは DB の関数を偽の client で答え、route の分岐を確かめる。関数の中身 (ロック・予約の期限・履歴の old_*) は
 * tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts が実 DB で確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeSupabase } from './helpers/fake-supabase';
import {
  PLAN_ID,
  RESERVATION_TOKEN,
  actor,
  applied,
  applyArgs,
  auditDetails,
  edgeOk,
  existingPlan,
  priceChangeRequest,
  priceChangeSupabase,
  rpcArgs,
  rpcOrder,
  stubEdge,
} from './helpers/price-change-route-world';
import {
  PLAN_PRICE_CHANGE_RPC,
  PRICE_CHANGE_IN_PROGRESS_MESSAGE,
  PRICE_CHANGE_RESERVATION_LOST_MESSAGE,
  PRICE_CHANGE_RESERVATION_STALE_SECONDS,
  STRIPE_PRICE_MAY_EXIST_NOTE,
} from '@/lib/super-admin/plan-price-change-reservation';

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

// 構造化ログ (app_logs への書き込み) は、呼ばれた中身だけ確かめる
const mockLogError = vi.fn();
const mockWithUser = vi.fn((_userId: string) => ({ error: mockLogError }));
vi.mock('@/lib/db-logger', () => ({
  generateRequestId: () => 'req-test',
  createLogger: () => ({ withUser: mockWithUser, error: mockLogError }),
}));

let fakeSupabase: FakeSupabase;
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  getSupabaseAdmin: () => fakeSupabase,
}));

const { POST } = await import('@/app/api/super-admin/plans/[id]/price-change/route');

const ORIGINAL_ENV = { ...process.env };
const RELEASE_ARGS = { p_plan_id: PLAN_ID, p_token: RESERVATION_TOKEN };

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

describe('1. 予約 (begin_plan_price_change)', () => {
  it('Stripe を呼ぶ前に、プランの id と予約の期限 (PRICE_CHANGE_RESERVATION_STALE_SECONDS) で予約を取る', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const order: string[] = [];
    const fetchMock = vi.fn(async () => {
      order.push('stripe');
      return edgeOk({ month: { new_stripe_price_id: 'price_new', deactivated: true } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const rpc = fakeSupabase.rpc.getMockImplementation()!;
    fakeSupabase.rpc.mockImplementation((fn: string, args: unknown) => {
      order.push(fn);
      return rpc(fn, args);
    });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(200);
    expect(rpcArgs(fakeSupabase, PLAN_PRICE_CHANGE_RPC.begin)).toEqual([
      { p_plan_id: PLAN_ID, p_stale_after_seconds: PRICE_CHANGE_RESERVATION_STALE_SECONDS },
    ]);
    expect(order).toEqual([PLAN_PRICE_CHANGE_RPC.begin, 'stripe', PLAN_PRICE_CHANGE_RPC.apply]);
    // apply は begin の token で呼ぶ。成功したら release は呼ばない (apply が予約を消す)
    expect(applyArgs(fakeSupabase)).toMatchObject({ p_plan_id: PLAN_ID, p_token: RESERVATION_TOKEN });
  });

  it('別の運営の価格の変更が進行中 (in_progress) なら 409 CONFLICT_STALE_DATA。Stripe も apply も release も呼ばず、監査も書かない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ begin: { data: { result: 'in_progress' }, error: null } });
    const fetchMock = stubEdge(edgeOk({}));

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT_STALE_DATA', message: PRICE_CHANGE_IN_PROGRESS_MESSAGE } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin]);
    expect(auditDetails(fakeSupabase)).toBeUndefined();
  });

  it('プランが無ければ 404 OP_PLAN_NOT_FOUND、draft なら 422 OP_PLAN_DRAFT_USE_PATCH (どちらも Stripe を呼ばない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const fetchMock = stubEdge(edgeOk({}));

    fakeSupabase = priceChangeSupabase({ begin: { data: { result: 'not_found' }, error: null } });
    const notFound = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } });
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin]);

    fakeSupabase = priceChangeSupabase({ begin: { data: { result: 'draft' }, error: null } });
    const draft = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    expect(draft.status).toBe(422);
    expect(((await draft.json()) as { error: { code: string } }).error.code).toBe('OP_PLAN_DRAFT_USE_PATCH');
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('UUID の形でない id は予約を取らずに 404 OP_PLAN_NOT_FOUND (uuid の引数に渡すと 22P02 の失敗になり 500 に入るため。#1917)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(edgeOk({}));

    const res = await POST(priceChangeRequest({}), { params: { id: 'not-a-uuid' } });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } });
    expect(rpcOrder(fakeSupabase)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['DB の失敗', { data: null, error: { message: 'relation "plan_price_change_reservations" does not exist', code: '42P01' } }],
    ['戻り値の形が違う', { data: { result: 'reserved' }, error: null }],
  ])('予約が %s なら汎用の 500 (生の文を出さない)。Stripe を呼ばない', async (_label, beginResult) => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ begin: beginResult });
    const fetchMock = stubEdge(edgeOk({}));

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    expect(text).not.toContain('plan_price_change_reservations');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin]);
  });
});

describe('3. 書き込み (apply_plan_price_change) と 4. 監査の old_*', () => {
  it('監査の old_* は apply がロックの下で読んだ previous で書く (begin のときに読んだ値ではない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    // begin のときの値 (1000 / 10000 / price_old / price_year_old) と、apply が読んだ直前の値をわざと違える
    fakeSupabase = priceChangeSupabase({
      apply: applied({
        monthly_price_jpy: 1100,
        yearly_price_jpy: 11000,
        stripe_price_id: 'price_mid',
        stripe_yearly_price_id: 'price_year_mid',
      }),
    });
    stubEdge(
      edgeOk({
        month: { new_stripe_price_id: 'price_month_new', deactivated: true },
        year: { new_stripe_price_id: 'price_year_new', deactivated: true },
      }),
    );

    const res = await POST(priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }), { params: { id: PLAN_ID } });

    expect(res.status).toBe(200);
    expect(auditDetails(fakeSupabase)).toMatchObject({
      old_monthly_price_jpy: 1100,
      new_monthly_price_jpy: 1200,
      old_yearly_price_jpy: 11000,
      new_yearly_price_jpy: 12000,
      old_stripe_price_id: 'price_mid',
      new_stripe_price_id: 'price_month_new',
      old_stripe_yearly_price_id: 'price_year_mid',
      new_stripe_yearly_price_id: 'price_year_new',
    });
    expect(existingPlan().monthly_price_jpy).not.toBe(1100);
  });

  it('予約を失っていた (lost) なら 409 CONFLICT_STALE_DATA で、監査を書かず、release も呼ばない (予約はもう自分のものではない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ apply: { data: { result: 'lost' }, error: null } });
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_new', deactivated: true } }));

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(409);
    // Stripe の同期の後なので、新しい Price が Stripe に作られている旨を添える
    expect(await res.json()).toEqual({
      error: { code: 'CONFLICT_STALE_DATA', message: PRICE_CHANGE_RESERVATION_LOST_MESSAGE + STRIPE_PRICE_MAY_EXIST_NOTE },
    });
    expect(auditDetails(fakeSupabase)).toBeUndefined();
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.apply]);
  });

  it('mock モードで予約を失っていたら、Stripe の注記は付けない', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase({ apply: { data: { result: 'lost' }, error: null } });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT_STALE_DATA', message: PRICE_CHANGE_RESERVATION_LOST_MESSAGE } });
  });

  it('apply のときにプランが無ければ (not_found) 404 で、監査を書かず、release も呼ばない (予約はプランと一緒に消えている)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase({ apply: { data: { result: 'not_found' }, error: null } });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(404);
    expect(auditDetails(fakeSupabase)).toBeUndefined();
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.apply]);
  });

  it('apply の戻り値の形が違えば 500 OP_DB_ERROR で、予約を消す', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase({ apply: { data: { result: 'applied' }, error: null } });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OP_DB_ERROR');
    expect(rpcArgs(fakeSupabase, PLAN_PRICE_CHANGE_RPC.release)).toEqual([RELEASE_ARGS]);
    expect(auditDetails(fakeSupabase)).toBeUndefined();
  });
});

describe('apply まで行かなかったときの予約の後片付け (release_plan_price_change)', () => {
  it('Stripe の同期に失敗したら、その要求の token で予約を消してから 502 を返す', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge({ ok: false, status: 500, text: () => Promise.resolve('edge failed') });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(502);
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.release]);
    expect(rpcArgs(fakeSupabase, PLAN_PRICE_CHANGE_RPC.release)).toEqual([RELEASE_ARGS]);
  });

  it.each([
    ['DB の失敗', { data: null, error: { message: 'connection reset', code: '08006' } }],
    ['戻り値の形が違う', { data: 'yes', error: null }],
  ])('予約を消すのが %s でも、応答 (502) は変えずにログに残す (予約は期限の後に取り直される)', async (_label, releaseResult) => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ release: releaseResult });
    stubEdge({ ok: false, status: 500, text: () => Promise.resolve('edge failed') });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OP_STRIPE_SYNC_FAILED');
    expect(mockWithUser).toHaveBeenCalledWith('sa-1');
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('予約を消せませんでした'), expect.any(Error), { plan_id: PLAN_ID });
  });

  it('予約の後に例外が出ても (接続情報が無い)、予約を消してから 500 を返す', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(edgeOk({}));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    consoleError.mockRestore();

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcOrder(fakeSupabase)).toEqual([PLAN_PRICE_CHANGE_RPC.begin, PLAN_PRICE_CHANGE_RPC.release]);
  });
});
