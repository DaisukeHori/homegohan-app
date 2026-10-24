/**
 * #1041 (F4-06) 回帰防止 contract テスト + #1102 (価格変更は新規契約のみ / 年額用の Stripe Price ID)
 * POST /api/super-admin/plans/[id]/price-change
 *
 * 従来は STRIPE_SECRET_KEY 設定時に Edge Function (stripe-price-sync) 呼び出しが
 * 失敗しても warn ログのみで DB のみ更新を続行し 200 を返す偽成功だった。
 * 修正後は Stripe 同期が期待される状況 (STRIPE_SECRET_KEY 設定済み) での
 * 同期失敗を 502 として扱い、DB を更新しない。
 *
 * #1102 (オーナー判断 2026-10-08):
 *   - 価格変更は新規契約だけに適用する。applies_to は new_only だけ (省略時も new_only)。
 *     on_renewal / immediately は 400 で拒否し、DB にも Stripe にも触れない
 *   - subscription_plans.stripe_price_id は月額、stripe_yearly_price_id は年額の Stripe Price ID。
 *     月額・年額を同時に変えるリクエストも受け付ける (従来の 422 OP_STRIPE_SYNC_BOTH_INTERVALS_UNSUPPORTED は廃止)。
 *     Edge Function stripe-price-sync は { month, year } を返し、route は変えた interval の列だけを更新する
 *
 * #1917: 履歴と価格は DB の関数 apply_plan_price_change が 1 つのトランザクションで書く (予約 begin_plan_price_change の後)。
 * 「DB を更新しない」は apply を呼ばないこと、「変えた interval の列だけを更新する」は apply に渡す引数 (変えなかった方は null。
 * 関数は NULL の列を今の値のまま残す) で確かめる。予約と変える前の値の扱いは tests/price-change-reservation-route.test.ts、
 * DB の関数の中身は tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeSupabase } from './helpers/fake-supabase';
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
  rpcArgs,
  stubEdge,
} from './helpers/price-change-route-world';
import { PLAN_PRICE_CHANGE_RPC, PRICE_CHANGE_SAVE_FAILED_MESSAGE, STRIPE_PRICE_MAY_EXIST_NOTE } from '@/lib/super-admin/plan-price-change-reservation';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

// 構造化ログ (app_logs への書き込み) は、呼ばれた中身だけ確かめる (本物はテストの fetch の偽物に通信してしまう)
const mockLogError = vi.fn();
const mockWithUser = vi.fn((_userId: string) => ({ error: mockLogError }));
vi.mock('@/lib/db-logger', () => ({
  generateRequestId: () => 'req-test',
  createLogger: () => ({ withUser: mockWithUser, error: mockLogError }),
}));

let fakeSupabase: FakeSupabase;
const mockGetSupabaseAdmin = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  // #1041 round-3 (C1) / #1917: 予約・履歴・価格の書き込みは service-role (`getSupabaseAdmin()`) の DB の関数で行う
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { POST } = await import('@/app/api/super-admin/plans/[id]/price-change/route');

const ORIGINAL_ENV = { ...process.env };

/** DB を更新していない (apply を呼んでいない) こと。予約を取ったあとなら予約を消している */
function expectNoDbWrite(fake: FakeSupabase, { reservedFirst }: { reservedFirst: boolean }) {
  expect(applyArgs(fake)).toBeUndefined();
  expect(rpcArgs(fake, PLAN_PRICE_CHANGE_RPC.release)).toHaveLength(reservedFirst ? 1 : 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
  mockGetSupabaseAdmin.mockImplementation(() => fakeSupabase);
  process.env = { ...ORIGINAL_ENV };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('POST /api/super-admin/plans/[id]/price-change: 接続情報と DB のエラー文 (#1434)', () => {
  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', undefined],
    ['NEXT_PUBLIC_SUPABASE_URL', '   '],
    ['SUPABASE_SERVICE_ROLE_KEY', ''],
  ])(
    'Stripe 同期が要るのに %s が %j なら、`undefined/functions/v1/...` へ通信せず汎用の 500 で止め、DB を更新しない',
    async (name, value) => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_x';
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      fakeSupabase = priceChangeSupabase();
      // getSupabaseAdmin も接続情報を読むので、この it では偽の client を返すだけにする (route が Edge Function の URL を組み立てる段で止まることを見る)
      const fetchMock = stubEdge(edgeOk({}));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
      const text = await res.text();
      consoleError.mockRestore();

      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } });
      expect(text).not.toContain(name);
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoDbWrite(fakeSupabase, { reservedFirst: true });
    },
  );

  it('履歴と価格の書き込み (apply) に失敗したら、DB の生のエラー文を本文に出さず固定の文の 500 (OP_DB_ERROR) を返し、予約を消す (#1172)', async () => {
    const rawDbError = 'duplicate key value violates unique constraint "subscription_plans_pkey"';
    fakeSupabase = priceChangeSupabase({ apply: { data: null, error: { message: rawDbError, code: '23505' } } });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    const text = await res.text();

    expect(res.status).toBe(500);
    // mock モード (STRIPE_SECRET_KEY 無し) なので、Stripe の Price の注記は付けない
    expect(JSON.parse(text)).toEqual({ error: { code: 'OP_DB_ERROR', message: PRICE_CHANGE_SAVE_FAILED_MESSAGE } });
    expect(text).not.toContain('subscription_plans_pkey');
    // 生の文はログにだけ残す
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('apply_plan_price_change'),
      expect.objectContaining({ message: expect.stringContaining('subscription_plans_pkey') }),
      { plan_id: PLAN_ID },
    );
    expect(rpcArgs(fakeSupabase, PLAN_PRICE_CHANGE_RPC.release)).toEqual([{ p_plan_id: PLAN_ID, p_token: reservedToken() }]);
    expect(auditDetails(fakeSupabase)).toBeUndefined();
  });

  it('Stripe の同期の後に apply が失敗したら、Stripe に新しい Price が作られている旨を文に添える', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ apply: { data: null, error: { message: 'boom', code: 'XX000' } } });
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_new', deactivated: true } }));

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(500);
    expect(json.error).toEqual({ code: 'OP_DB_ERROR', message: PRICE_CHANGE_SAVE_FAILED_MESSAGE + STRIPE_PRICE_MAY_EXIST_NOTE });
  });
});

/** 偽の client の予約の token */
function reservedToken(): string {
  return (reserved().data as { token: string }).token;
}

describe('POST /api/super-admin/plans/[id]/price-change (#1041 F4-06)', () => {
  it('STRIPE_SECRET_KEY 設定時、Edge Function 呼び出しが例外を投げたら 502 を返し DB を更新しない (予約は消す)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_STRIPE_SYNC_FAILED');
    expectNoDbWrite(fakeSupabase, { reservedFirst: true });
  });

  it('#1041 round-2 (C): Edge Function が 404 を返したら OP_STRIPE_SYNC_UNAVAILABLE で 503 (未デプロイ検知、OP_STRIPE_SYNC_FAILED とは区別する)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge({ ok: false, status: 404, text: () => Promise.resolve('function not found') });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_STRIPE_SYNC_UNAVAILABLE');
    expectNoDbWrite(fakeSupabase, { reservedFirst: true });
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function が非 200 を返したら 502 を返す (偽成功にしない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge({ ok: false, status: 500, text: () => Promise.resolve('edge failed') });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    expect(res.status).toBe(502);
    expectNoDbWrite(fakeSupabase, { reservedFirst: true });
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function が ok でも新しい Price ID が無ければ 502', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge({ ok: true, json: () => Promise.resolve({}) });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_STRIPE_SYNC_FAILED');
    expectNoDbWrite(fakeSupabase, { reservedFirst: true });
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function の応答が JSON として読めなくても 502 (DB は更新しない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge({ ok: true, json: () => Promise.reject(new Error('invalid json')) });

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    expect(res.status).toBe(502);
    expectNoDbWrite(fakeSupabase, { reservedFirst: true });
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function 成功なら 200 で新価格 ID を反映する', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_new', deactivated: true } }));

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { new_stripe_price_id: string; new_stripe_yearly_price_id: string | null; stripe_mock: boolean };
    };
    expect(json.data.new_stripe_price_id).toBe('price_new');
    // 年額は変えていないので、年額の Price ID は無い
    expect(json.data.new_stripe_yearly_price_id).toBeNull();
    expect(json.data.stripe_mock).toBe(false);
    expect(applyArgs(fakeSupabase)).toMatchObject({ p_new_stripe_price_id: 'price_new', p_new_stripe_yearly_price_id: null });
  });

  it('STRIPE_SECRET_KEY 未設定時は意図された mock モードとして 200 (stripe_mock: true)。Edge Function は呼ばない', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { stripe_mock: boolean; new_stripe_price_id: string | null; new_stripe_yearly_price_id: string | null };
    };
    expect(json.data.stripe_mock).toBe(true);
    expect(json.data.new_stripe_price_id).toBeNull();
    expect(json.data.new_stripe_yearly_price_id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/super-admin/plans/[id]/price-change (#1041 round-3 C1 / #1917: 履歴と価格は 1 つの DB の関数で書く)', () => {
  it('予約・書き込みは service-role (getSupabaseAdmin) の DB の関数で行い、履歴の表・プランの表を route から直接書かない', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase();

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(200);
    expect(mockGetSupabaseAdmin).toHaveBeenCalled();
    const tables = fakeSupabase.from.mock.calls.map((c) => c[0]);
    expect(tables).not.toContain('plan_price_history');
    expect(tables).not.toContain('subscription_plans');
    expect(rpcArgs(fakeSupabase, PLAN_PRICE_CHANGE_RPC.apply)).toHaveLength(1);
  });

  it('apply には履歴の列 (理由・適用日・適用範囲・実行者) と価格を 1 回で渡す', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase();

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });

    expect(res.status).toBe(200);
    expect(applyArgs(fakeSupabase)).toEqual({
      p_plan_id: PLAN_ID,
      p_token: reservedToken(),
      p_new_monthly_price_jpy: 1200,
      p_new_yearly_price_jpy: null,
      p_new_stripe_price_id: null,
      p_new_stripe_yearly_price_id: null,
      p_changed_by: 'sa-1',
      p_reason: 'price update',
      p_effective_at: '2026-08-01T00:00:00.000Z',
      p_applies_to: 'new_only',
    });
  });
});

describe('POST /api/super-admin/plans/[id]/price-change (#1102: 月額・年額を同時に変えられる)', () => {
  it('Stripe 同期が必須な状況で月額・年額を同時に送ると、Edge Function を 1 回だけ呼び、両方の金額を渡して 200 を返す (旧: 422)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(
      edgeOk({
        month: { new_stripe_price_id: 'price_month_new', deactivated: true },
        year: { new_stripe_price_id: 'price_year_new', deactivated: true },
      }),
    );

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        new_stripe_price_id: string;
        new_stripe_yearly_price_id: string;
        new_monthly_price_jpy: number;
        new_yearly_price_jpy: number;
        applies_to: string;
        stripe_mock: boolean;
      };
    };
    expect(json.data).toMatchObject({
      new_monthly_price_jpy: 1200,
      new_yearly_price_jpy: 12000,
      new_stripe_price_id: 'price_month_new',
      new_stripe_yearly_price_id: 'price_year_new',
      applies_to: 'new_only',
      stripe_mock: false,
    });

    // Edge Function は 1 回の呼び出しで両方の金額を受け取る (プランの値は予約のときにロックの下で読んだもの)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://example.supabase.co/functions/v1/stripe-price-sync');
    expect(edgeRequestBody(fetchMock)).toMatchObject({
      plan_id: PLAN_ID,
      plan_key: 'pro',
      stripe_product_id: 'prod_123',
      new_monthly_price_jpy: 1200,
      new_yearly_price_jpy: 12000,
      applies_to: 'new_only',
      actor_id: 'sa-1',
      reason: 'price update',
    });

    // apply: 月額は stripe_price_id、年額は stripe_yearly_price_id に、それぞれ新しい Price ID を書く。
    // 履歴の new_stripe_price_id は月額の Price ID (DB の関数が p_new_stripe_price_id を書く)
    expect(applyArgs(fakeSupabase)).toMatchObject({
      p_new_monthly_price_jpy: 1200,
      p_new_yearly_price_jpy: 12000,
      p_new_stripe_price_id: 'price_month_new',
      p_new_stripe_yearly_price_id: 'price_year_new',
      p_applies_to: 'new_only',
    });
  });

  it('年額だけ変える場合は、年額の金額と stripe_yearly_price_id だけを渡し、月額の金額・stripe_price_id は null (DB の関数は NULL の列を変えない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(
      edgeOk({ year: { new_stripe_price_id: 'price_year_new', deactivated: false, deactivation_skipped_reason: 'no_old_price' } }),
    );

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: null, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { new_stripe_price_id: string | null; new_stripe_yearly_price_id: string } };
    expect(json.data.new_stripe_price_id).toBeNull();
    expect(json.data.new_stripe_yearly_price_id).toBe('price_year_new');

    // 月額は渡さない (Edge Function は年額の Price だけを作る)
    const sent = edgeRequestBody(fetchMock);
    expect(sent.new_yearly_price_jpy).toBe(12000);
    expect(sent.new_monthly_price_jpy ?? null).toBeNull();

    // 月額の価格・月額の Price ID は null (月額の Price への参照を失わせない。履歴の new_stripe_price_id も null)
    expect(applyArgs(fakeSupabase)).toMatchObject({
      p_new_monthly_price_jpy: null,
      p_new_yearly_price_jpy: 12000,
      p_new_stripe_price_id: null,
      p_new_stripe_yearly_price_id: 'price_year_new',
    });
  });

  it('月額だけ変える場合は、月額の金額と stripe_price_id だけを渡し、年額は null', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_month_new', deactivated: true } }));

    const res = await POST(priceChangeRequest({ new_monthly_price_jpy: 1200 }), { params: { id: PLAN_ID } });

    expect(res.status).toBe(200);
    expect(applyArgs(fakeSupabase)).toMatchObject({
      p_new_monthly_price_jpy: 1200,
      p_new_yearly_price_jpy: null,
      p_new_stripe_price_id: 'price_month_new',
      p_new_stripe_yearly_price_id: null,
    });
  });

  it('月額・年額を両方変えたのに Edge Function が月額の Price ID しか返さなければ 502 (年額を黙って無視しない)。DB は更新しない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_month_new', deactivated: true }, year: null }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('OP_STRIPE_SYNC_FAILED');
    expect(json.error.message).toContain('年額');
    // 履歴にも価格にも進まない (月額だけ更新される中途半端な状態を作らない)
    expectNoDbWrite(fakeSupabase, { reservedFirst: true });
  });

  it('月額・年額を両方変えたのに Edge Function が年額の Price ID しか返さなければ 502。DB は更新しない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge(edgeOk({ month: null, year: { new_stripe_price_id: 'price_year_new', deactivated: true } }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('月額');
    expectNoDbWrite(fakeSupabase, { reservedFirst: true });
  });

  it('年額だけ変えたとき、Edge Function が（変えていない）月額の結果だけを返しても 502 (年額の Price ID が無い)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_month_unexpected', deactivated: false } }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: null, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(502);
    expectNoDbWrite(fakeSupabase, { reservedFirst: true });
  });

  it('Stripe 同期が不要な状況 (STRIPE_SECRET_KEY 未設定/mock モード) で同時変更しても 200。Stripe の Price ID は渡さない (null)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyArgs(fakeSupabase)).toMatchObject({
      p_new_monthly_price_jpy: 1200,
      p_new_yearly_price_jpy: 12000,
      p_new_stripe_price_id: null,
      p_new_stripe_yearly_price_id: null,
    });
  });

  it('stripe_product_id が無いプランは、STRIPE_SECRET_KEY があっても Stripe 同期の対象外 (mock 扱い)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase({ begin: reserved({ ...existingPlan(), stripe_product_id: null }) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const json = (await res.json()) as { data: { stripe_mock: boolean } };
    expect(json.data.stripe_mock).toBe(true);
  });
});

describe('POST /api/super-admin/plans/[id]/price-change (#1102: 価格変更は新規契約のみ)', () => {
  it.each(['on_renewal', 'immediately'])(
    'applies_to=%s は 400 (OP_INVALID_INPUT) で拒否し、DB にも Stripe にも触れない',
    async (appliesTo) => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_x';
      fakeSupabase = priceChangeSupabase();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const res = await POST(priceChangeRequest({ applies_to: appliesTo }), { params: { id: PLAN_ID } });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string; message: string; details: unknown } };
      expect(json.error.code).toBe('OP_INVALID_INPUT');
      // 理由が読める message (issues 配列の生 JSON ではない)
      expect(json.error.message).toContain('new_only');
      expect(json.error.message).toContain('新規契約');
      expect(json.error.message.startsWith('[')).toBe(false);
      expect(Array.isArray(json.error.details)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fakeSupabase.from).not.toHaveBeenCalled();
      // 予約も取らない
      expect(fakeSupabase.rpc).not.toHaveBeenCalled();
    },
  );

  it('不正な applies_to (new_only 以外) や null も 400', async () => {
    fakeSupabase = priceChangeSupabase();

    for (const bad of ['everyone', '', null]) {
      const res = await POST(priceChangeRequest({ applies_to: bad }), { params: { id: PLAN_ID } });
      expect(res.status).toBe(400);
    }
    expect(fakeSupabase.from).not.toHaveBeenCalled();
    expect(fakeSupabase.rpc).not.toHaveBeenCalled();
  });

  it('applies_to を省略した場合は new_only として扱い、履歴 (apply)・監査ログ・Edge Function にも new_only を渡す', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    const fetchMock = stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_month_new', deactivated: true } }));

    // priceChangeRequest は applies_to を既定で入れるので、本文を直接組み立てる
    const request = new Request(`http://localhost/api/super-admin/plans/${PLAN_ID}/price-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        new_monthly_price_jpy: 1200,
        reason: 'price update',
        effective_at: '2026-08-01T00:00:00.000Z',
      }),
    }) as never;
    const res = await POST(request, { params: { id: PLAN_ID } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { applies_to: string } };
    expect(json.data.applies_to).toBe('new_only');
    expect(edgeRequestBody(fetchMock).applies_to).toBe('new_only');
    expect(applyArgs(fakeSupabase)).toMatchObject({ p_applies_to: 'new_only' });
    expect(auditDetails(fakeSupabase)!.applies_to).toBe('new_only');
  });
});

describe('POST /api/super-admin/plans/[id]/price-change (#1041 round-4 W1: OP_INVALID_INPUT メッセージ)', () => {
  it('バリデーション失敗時、message は最初の issue の message であり issues 配列の生 JSON ダンプではない', async () => {
    fakeSupabase = priceChangeSupabase();

    // 月額・年額どちらも null → refine エラー (「月額または年額のいずれかを指定してください」)
    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: null, new_yearly_price_jpy: null }),
      { params: { id: PLAN_ID } },
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string; details: unknown } };
    expect(json.error.code).toBe('OP_INVALID_INPUT');
    expect(json.error.message).toBe('月額または年額のいずれかを指定してください');
    // 生 JSON ダンプ (issues 配列を JSON.stringify したもの) になっていないこと
    expect(json.error.message.startsWith('[')).toBe(false);
    // details には引き続き全 issues を含める
    expect(Array.isArray(json.error.details)).toBe(true);
  });
});

describe('POST /api/super-admin/plans/[id]/price-change (#1041 round-4 C / #1102: 旧 Price deactivate 結果の監査ログ記録)', () => {
  it('Edge Function が deactivated:true を返した場合、監査ログに old_stripe_price_deactivated:true が記録される', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_new', deactivated: true } }));

    const res = await POST(priceChangeRequest({}), { params: { id: PLAN_ID } });
    expect(res.status).toBe(200);

    const details = auditDetails(fakeSupabase)!;
    expect(details.old_stripe_price_deactivated).toBe(true);
    expect(details.old_stripe_price_deactivation_skipped_reason).toBeNull();
    expect(details.old_stripe_price_id).toBe('price_old');
    expect(details.new_stripe_price_id).toBe('price_new');
    // 年額は変えていない
    expect(details.new_stripe_yearly_price_id).toBeNull();
    expect(details.old_stripe_yearly_price_deactivated).toBe(false);
    expect(details.old_stripe_yearly_price_deactivation_skipped_reason).toBeNull();
  });

  it('Edge Function が interval 不一致で deactivate をスキップした場合、監査ログに理由が記録される (年額)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge(
      edgeOk({
        year: {
          new_stripe_price_id: 'price_year_new',
          deactivated: false,
          deactivation_skipped_reason: 'interval_mismatch',
        },
      }),
    );

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: null, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );
    expect(res.status).toBe(200);

    const details = auditDetails(fakeSupabase)!;
    expect(details.old_stripe_yearly_price_deactivated).toBe(false);
    expect(details.old_stripe_yearly_price_deactivation_skipped_reason).toBe('interval_mismatch');
    expect(details.old_stripe_yearly_price_id).toBe('price_year_old');
    expect(details.new_stripe_yearly_price_id).toBe('price_year_new');
    // 月額は変えていない
    expect(details.new_stripe_price_id).toBeNull();
    expect(details.old_stripe_price_deactivated).toBe(false);
    expect(details.old_stripe_price_deactivation_skipped_reason).toBeNull();
  });

  it('月額・年額を同時に変えた場合、interval ごとの旧 Price の無効化結果が別々に記録される', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = priceChangeSupabase();
    stubEdge(
      edgeOk({
        month: { new_stripe_price_id: 'price_month_new', deactivated: true },
        year: {
          new_stripe_price_id: 'price_year_new',
          deactivated: false,
          deactivation_skipped_reason: 'no_old_price',
        },
      }),
    );

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );
    expect(res.status).toBe(200);

    expect(auditDetails(fakeSupabase)).toMatchObject({
      applies_to: 'new_only',
      stripe_mock: false,
      old_stripe_price_id: 'price_old',
      new_stripe_price_id: 'price_month_new',
      old_stripe_price_deactivated: true,
      old_stripe_price_deactivation_skipped_reason: null,
      old_stripe_yearly_price_id: 'price_year_old',
      new_stripe_yearly_price_id: 'price_year_new',
      old_stripe_yearly_price_deactivated: false,
      old_stripe_yearly_price_deactivation_skipped_reason: 'no_old_price',
    });
  });

  it('mock モード (Stripe 同期なし) の監査ログは stripe_mock:true で、Price ID は記録しない (null)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = priceChangeSupabase();

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: PLAN_ID } },
    );
    expect(res.status).toBe(200);

    const details = auditDetails(fakeSupabase)!;
    expect(details.stripe_mock).toBe(true);
    expect(details.new_stripe_price_id).toBeNull();
    expect(details.new_stripe_yearly_price_id).toBeNull();
    expect(details.old_stripe_price_deactivated).toBe(false);
    expect(details.old_stripe_yearly_price_deactivated).toBe(false);
  });
});
