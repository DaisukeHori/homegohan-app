/**
 * #1041 (F4-06) 回帰防止 contract テスト
 * POST /api/super-admin/plans/[id]/price-change
 *
 * 従来は STRIPE_SECRET_KEY 設定時に Edge Function (stripe-price-sync) 呼び出しが
 * 失敗しても warn ログのみで DB のみ更新を続行し 200 を返す偽成功だった。
 * 修正後は Stripe 同期が期待される状況 (STRIPE_SECRET_KEY 設定済み) での
 * 同期失敗を 502 として扱い、DB を更新しない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
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
    stripe_price_id: 'price_old',
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

  it('STRIPE_SECRET_KEY 設定時、Edge Function が非 200 を返したら 502 を返す (偽成功にしない)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('edge failed') }),
    );

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(502);
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function が ok でも new_stripe_price_id が無ければ 502', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(502);
  });

  it('STRIPE_SECRET_KEY 設定時、Edge Function 成功なら 200 で新価格 ID を反映する', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
      plan_price_history: [{ data: null, error: null }],
      admin_audit_logs: [{ data: null, error: null }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ new_stripe_price_id: 'price_new' }) }),
    );

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { new_stripe_price_id: string; stripe_mock: boolean } };
    expect(json.data.new_stripe_price_id).toBe('price_new');
    expect(json.data.stripe_mock).toBe(false);
  });

  it('STRIPE_SECRET_KEY 未設定時は意図された mock モードとして 200 (stripe_mock: true)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan(), error: null }],
      plan_price_history: [{ data: null, error: null }],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await POST(priceChangeRequest({}), { params: { id: 'plan-1' } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { stripe_mock: boolean } };
    expect(json.data.stripe_mock).toBe(true);
  });
});
