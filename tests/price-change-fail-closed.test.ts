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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;
const mockGetSupabaseAdmin = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  // #1041 round-3 (C1): plan_price_history への INSERT は service-role
  // (`getSupabaseAdmin()`) 経由になったため、テスト用フェイクも提供する。
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { POST } = await import('@/app/api/super-admin/plans/[id]/price-change/route');

const ORIGINAL_ENV = { ...process.env };
const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

function existingPlan() {
  return {
    id: 'plan-1',
    plan_key: 'pro',
    status: 'public',
    stripe_product_id: 'prod_123',
    // 月額の Price ID (#1102: stripe_price_id は月額)
    stripe_price_id: 'price_old',
    // 年額の Price ID (#1102)
    stripe_yearly_price_id: 'price_year_old',
    monthly_price_jpy: 1000,
    yearly_price_jpy: 10000,
  };
}

function priceChangeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/super-admin/plans/plan-1/price-change', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      new_monthly_price_jpy: 1200,
      applies_to: 'new_only',
      reason: 'price update',
      effective_at: '2026-08-01T00:00:00.000Z',
      ...body,
    }),
  }) as never;
}

/** Edge Function (stripe-price-sync) の 200 応答。{ month, year } を返す (変えなかった interval は null) */
function edgeOk(body: { month?: unknown; year?: unknown }) {
  return {
    ok: true,
    json: () => Promise.resolve({ success: true, month: null, year: null, ...body }),
  };
}

function stubEdge(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Edge Function へ送ったリクエストボディ */
function edgeRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

type Builder = { update: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };

/** テーブルへの `.from()` 呼び出しで返った builder のうち、指定のメソッドが呼ばれたものの 1 回目の引数 */
function firstCallArg(fake: ReturnType<typeof createFakeSupabase>, table: string, method: 'update' | 'insert') {
  for (let i = 0; i < fake.from.mock.calls.length; i++) {
    if (fake.from.mock.calls[i]![0] !== table) continue;
    const builder = fake.from.mock.results[i]!.value as Builder;
    if (builder[method].mock.calls.length > 0) return builder[method].mock.calls[0]![0] as Record<string, unknown>;
  }
  return undefined;
}

const planUpdatePayload = (fake: ReturnType<typeof createFakeSupabase>) => firstCallArg(fake, 'subscription_plans', 'update');
const historyInsertPayload = (fake: ReturnType<typeof createFakeSupabase>) => firstCallArg(fake, 'plan_price_history', 'insert');
const auditLogInsertPayload = (fake: ReturnType<typeof createFakeSupabase>) => firstCallArg(fake, 'admin_audit_logs', 'insert');

/** 成功系のテストが使う、DB の結果 (プラン取得 / 履歴 INSERT / 監査ログ INSERT) */
function successSupabase() {
  return createFakeSupabase({
    subscription_plans: [{ data: existingPlan(), error: null }],
    plan_price_history: [{ data: null, error: null }],
    admin_audit_logs: [{ data: null, error: null }],
  });
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

describe('POST /api/super-admin/plans/[id]/price-change (#1041 F4-06)', () => {
  it('STRIPE_SECRET_KEY 設定時、Edge Function 呼び出しが例外を投げたら 502 を返し DB を更新しない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_STRIPE_SYNC_FAILED');
    // subscription_plans は初回の select 1 回のみ呼ばれ、update には進まないこと
    expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('#1041 round-2 (C): Edge Function が 404 を返したら OP_STRIPE_SYNC_UNAVAILABLE で 503 (未デプロイ検知、OP_STRIPE_SYNC_FAILED とは区別する)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    stubEdge({ ok: false, status: 404, text: () => Promise.resolve('function not found') });

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });

    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_STRIPE_SYNC_UNAVAILABLE');
    // subscription_plans は初回の select 1 回のみ呼ばれ、update には進まないこと
    expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function が非 200 を返したら 502 を返す (偽成功にしない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    stubEdge({ ok: false, status: 500, text: () => Promise.resolve('edge failed') });

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(502);
    expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function が ok でも新しい Price ID が無ければ 502', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    stubEdge({ ok: true, json: () => Promise.resolve({}) });

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_STRIPE_SYNC_FAILED');
    expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function の応答が JSON として読めなくても 502 (DB は更新しない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    stubEdge({ ok: true, json: () => Promise.reject(new Error('invalid json')) });

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(502);
    expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function 成功なら 200 で新価格 ID を反映する', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = successSupabase();
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_new', deactivated: true } }));

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { new_stripe_price_id: string; new_stripe_yearly_price_id: string | null; stripe_mock: boolean };
    };
    expect(json.data.new_stripe_price_id).toBe('price_new');
    // 年額は変えていないので、年額の Price ID は無い
    expect(json.data.new_stripe_yearly_price_id).toBeNull();
    expect(json.data.stripe_mock).toBe(false);
  });

  it('STRIPE_SECRET_KEY 未設定時は意図された mock モードとして 200 (stripe_mock: true)。Edge Function は呼ばない', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = successSupabase();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
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

describe('POST /api/super-admin/plans/[id]/price-change (#1041 round-3 C1: plan_price_history INSERT)', () => {
  it('plan_price_history への INSERT が失敗したら 500 を返し、service-role (getSupabaseAdmin) を使用し、subscription_plans の価格 UPDATE には進まない', async () => {
    delete process.env.STRIPE_SECRET_KEY; // mock モード (Stripe 呼び出し無し) で検証を単純化
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
      plan_price_history: [{ data: null, error: { message: 'permission denied for table plan_price_history' } }],
    });

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PRICE_HISTORY_INSERT_FAILED');

    // service-role (getSupabaseAdmin) が使われること (#1041 round-3 C1)
    expect(mockGetSupabaseAdmin).toHaveBeenCalled();

    // subscription_plans は初回の select 1 回のみ呼ばれ、価格 UPDATE には進まないこと
    // (履歴 INSERT 失敗時に「価格は変更されたが監査証跡が無い」状態を作らない)
    expect(planUpdatePayload(fakeSupabase)).toBeUndefined();
  });

  it('plan_price_history への INSERT が成功したら、その後に subscription_plans の価格 UPDATE が実行される', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = successSupabase();

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });

    expect(res.status).toBe(200);
    expect(mockGetSupabaseAdmin).toHaveBeenCalled();

    // 履歴 INSERT → 価格 UPDATE の順に実行される
    const tables = fakeSupabase.from.mock.calls.map((c) => c[0]);
    expect(tables.indexOf('plan_price_history')).toBeGreaterThan(-1);
    expect(tables.lastIndexOf('subscription_plans')).toBeGreaterThan(tables.indexOf('plan_price_history'));
    expect(planUpdatePayload(fakeSupabase)).toMatchObject({ monthly_price_jpy: 1200 });
  });
});

describe('POST /api/super-admin/plans/[id]/price-change (#1102: 月額・年額を同時に変えられる)', () => {
  it('Stripe 同期が必須な状況で月額・年額を同時に送ると、Edge Function を 1 回だけ呼び、両方の金額を渡して 200 を返す (旧: 422)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = successSupabase();
    const fetchMock = stubEdge(
      edgeOk({
        month: { new_stripe_price_id: 'price_month_new', deactivated: true },
        year: { new_stripe_price_id: 'price_year_new', deactivated: true },
      }),
    );

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: 'plan-1' } },
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

    // Edge Function は 1 回の呼び出しで両方の金額を受け取る
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://example.supabase.co/functions/v1/stripe-price-sync');
    expect(edgeRequestBody(fetchMock)).toMatchObject({
      plan_id: 'plan-1',
      plan_key: 'pro',
      stripe_product_id: 'prod_123',
      new_monthly_price_jpy: 1200,
      new_yearly_price_jpy: 12000,
      applies_to: 'new_only',
      actor_id: 'sa-1',
      reason: 'price update',
    });

    // subscription_plans: 月額は stripe_price_id、年額は stripe_yearly_price_id に、それぞれ新しい Price ID を書く
    expect(planUpdatePayload(fakeSupabase)).toMatchObject({
      monthly_price_jpy: 1200,
      yearly_price_jpy: 12000,
      stripe_price_id: 'price_month_new',
      stripe_yearly_price_id: 'price_year_new',
    });

    // 履歴: old/new_stripe_price_id は月額の Price ID
    expect(historyInsertPayload(fakeSupabase)).toMatchObject({
      plan_id: 'plan-1',
      old_monthly_price_jpy: 1000,
      new_monthly_price_jpy: 1200,
      old_yearly_price_jpy: 10000,
      new_yearly_price_jpy: 12000,
      old_stripe_price_id: 'price_old',
      new_stripe_price_id: 'price_month_new',
      applies_to: 'new_only',
    });
  });

  it('年額だけ変える場合は、stripe_yearly_price_id だけを更新し、月額の stripe_price_id には触れない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = successSupabase();
    const fetchMock = stubEdge(
      edgeOk({ year: { new_stripe_price_id: 'price_year_new', deactivated: false, deactivation_skipped_reason: 'no_old_price' } }),
    );

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: null, new_yearly_price_jpy: 12000 }),
      { params: { id: 'plan-1' } },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { new_stripe_price_id: string | null; new_stripe_yearly_price_id: string } };
    expect(json.data.new_stripe_price_id).toBeNull();
    expect(json.data.new_stripe_yearly_price_id).toBe('price_year_new');

    // 月額は渡さない (Edge Function は年額の Price だけを作る)
    const sent = edgeRequestBody(fetchMock);
    expect(sent.new_yearly_price_jpy).toBe(12000);
    expect(sent.new_monthly_price_jpy ?? null).toBeNull();

    const update = planUpdatePayload(fakeSupabase)!;
    expect(update).toMatchObject({ yearly_price_jpy: 12000, stripe_yearly_price_id: 'price_year_new' });
    // 月額の価格・月額の Price ID の列は更新しない (月額の Price への参照を失わせない)
    expect(update).not.toHaveProperty('stripe_price_id');
    expect(update).not.toHaveProperty('monthly_price_jpy');

    // 履歴の new_stripe_price_id (月額) は、月額の Price を作っていないので null。old は現在の月額 Price
    expect(historyInsertPayload(fakeSupabase)).toMatchObject({
      old_stripe_price_id: 'price_old',
      new_stripe_price_id: null,
      new_yearly_price_jpy: 12000,
    });
  });

  it('月額だけ変える場合は、stripe_price_id だけを更新し、年額の stripe_yearly_price_id には触れない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = successSupabase();
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_month_new', deactivated: true } }));

    const res = await POST(priceChangeRequest({ new_monthly_price_jpy: 1200 }), { params: { id: 'plan-1' } });

    expect(res.status).toBe(200);
    const update = planUpdatePayload(fakeSupabase)!;
    expect(update).toMatchObject({ monthly_price_jpy: 1200, stripe_price_id: 'price_month_new' });
    expect(update).not.toHaveProperty('stripe_yearly_price_id');
    expect(update).not.toHaveProperty('yearly_price_jpy');
  });

  it('月額・年額を両方変えたのに Edge Function が月額の Price ID しか返さなければ 502 (年額を黙って無視しない)。DB は更新しない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_month_new', deactivated: true }, year: null }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: 'plan-1' } },
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('OP_STRIPE_SYNC_FAILED');
    expect(json.error.message).toContain('年額');
    // プラン取得の 1 回だけ。履歴 INSERT にも価格 UPDATE にも進まない (月額だけ更新される中途半端な状態を作らない)
    expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('月額・年額を両方変えたのに Edge Function が年額の Price ID しか返さなければ 502。DB は更新しない', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    stubEdge(edgeOk({ month: null, year: { new_stripe_price_id: 'price_year_new', deactivated: true } }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: 'plan-1' } },
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('月額');
    expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('年額だけ変えたとき、Edge Function が（変えていない）月額の結果だけを返しても 502 (年額の Price ID が無い)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_month_unexpected', deactivated: false } }));

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: null, new_yearly_price_jpy: 12000 }),
      { params: { id: 'plan-1' } },
    );

    expect(res.status).toBe(502);
    expect(fakeSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('Stripe 同期が不要な状況 (STRIPE_SECRET_KEY 未設定/mock モード) で同時変更しても 200。Stripe の Price ID の列は更新しない', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = successSupabase();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: 'plan-1' } },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const update = planUpdatePayload(fakeSupabase)!;
    expect(update).toMatchObject({ monthly_price_jpy: 1200, yearly_price_jpy: 12000 });
    expect(update).not.toHaveProperty('stripe_price_id');
    expect(update).not.toHaveProperty('stripe_yearly_price_id');
  });

  it('stripe_product_id が無いプランは、STRIPE_SECRET_KEY があっても Stripe 同期の対象外 (mock 扱い)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: { ...existingPlan(), stripe_product_id: null }, error: null }],
      plan_price_history: [{ data: null, error: null }],
      admin_audit_logs: [{ data: null, error: null }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: 'plan-1' } },
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
      fakeSupabase = successSupabase();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const res = await POST(priceChangeRequest({ applies_to: appliesTo }), { params: { id: 'plan-1' } });

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
    },
  );

  it('不正な applies_to (new_only 以外) や null も 400', async () => {
    fakeSupabase = successSupabase();

    for (const bad of ['everyone', '', null]) {
      const res = await POST(priceChangeRequest({ applies_to: bad }), { params: { id: 'plan-1' } });
      expect(res.status).toBe(400);
    }
    expect(fakeSupabase.from).not.toHaveBeenCalled();
  });

  it('applies_to を省略した場合は new_only として扱い、履歴・監査ログ・Edge Function にも new_only を渡す', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = successSupabase();
    const fetchMock = stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_month_new', deactivated: true } }));

    // priceChangeRequest は applies_to を既定で入れるので、本文を直接組み立てる
    const request = new Request('http://localhost/api/super-admin/plans/plan-1/price-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        new_monthly_price_jpy: 1200,
        reason: 'price update',
        effective_at: '2026-08-01T00:00:00.000Z',
      }),
    }) as never;
    const res = await POST(request, { params: { id: 'plan-1' } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { applies_to: string } };
    expect(json.data.applies_to).toBe('new_only');
    expect(edgeRequestBody(fetchMock).applies_to).toBe('new_only');
    expect(historyInsertPayload(fakeSupabase)).toMatchObject({ applies_to: 'new_only' });
    expect((auditLogInsertPayload(fakeSupabase)!.details as Record<string, unknown>).applies_to).toBe('new_only');
  });
});

describe('POST /api/super-admin/plans/[id]/price-change (#1041 round-4 W1: OP_INVALID_INPUT メッセージ)', () => {
  it('バリデーション失敗時、message は最初の issue の message であり issues 配列の生 JSON ダンプではない', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });

    // 月額・年額どちらも null → refine エラー (「月額または年額のいずれかを指定してください」)
    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: null, new_yearly_price_jpy: null }),
      { params: { id: 'plan-1' } },
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
    fakeSupabase = successSupabase();
    stubEdge(edgeOk({ month: { new_stripe_price_id: 'price_new', deactivated: true } }));

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(200);

    const details = auditLogInsertPayload(fakeSupabase)!.details as Record<string, unknown>;
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
    fakeSupabase = successSupabase();
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
      { params: { id: 'plan-1' } },
    );
    expect(res.status).toBe(200);

    const details = auditLogInsertPayload(fakeSupabase)!.details as Record<string, unknown>;
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
    fakeSupabase = successSupabase();
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
      { params: { id: 'plan-1' } },
    );
    expect(res.status).toBe(200);

    const details = auditLogInsertPayload(fakeSupabase)!.details as Record<string, unknown>;
    expect(details).toMatchObject({
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
    fakeSupabase = successSupabase();

    const res = await POST(
      priceChangeRequest({ new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 }),
      { params: { id: 'plan-1' } },
    );
    expect(res.status).toBe(200);

    const details = auditLogInsertPayload(fakeSupabase)!.details as Record<string, unknown>;
    expect(details.stripe_mock).toBe(true);
    expect(details.new_stripe_price_id).toBeNull();
    expect(details.new_stripe_yearly_price_id).toBeNull();
    expect(details.old_stripe_price_deactivated).toBe(false);
    expect(details.old_stripe_yearly_price_deactivated).toBe(false);
  });
});
