// @vitest-environment node
/**
 * アプリ内課金の API (billing/03 §9.2〜§9.4) の route のテスト (§14.1 のテスト 31〜33・117〜120)。
 * GET /api/billing/iap/catalog・POST /api/billing/iap/sync・GET /api/billing/subscription の遅延の再同期。
 * 認証・DB・RevenueCat の gateway の生成と、契約の要約 (getBillingSummary) をモックし、アプリ内課金のユースケース (iap-service) は本物を通す。
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireUserAllowingFrozen: vi.fn(),
  checkRateLimit: vi.fn(),
  createClient: vi.fn(),
  listPublicPlans: vi.fn(),
  createRevenueCatGateway: vi.fn(),
  getSubscriber: vi.fn(),
  listStoreProducts: vi.fn(),
  listStoreSubscriptions: vi.fn(),
  applyStoreSubscription: vi.fn(),
  findLiveSubscription: vi.fn(),
  getBillingSummary: vi.fn(),
  planStoreProductsQueries: [] as Array<{ method: string; args: unknown[] }>,
  planStoreProductsResult: { data: [] as unknown[] | null, error: null as unknown },
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: () => logger };
  return { createLogger: () => logger, generateRequestId: () => 'req-test' };
});
vi.mock('@/lib/auth/helpers', () => ({ requireUser: () => mocks.requireUser() }));
vi.mock('@/lib/billing/auth', () => ({ requireUserAllowingFrozen: () => mocks.requireUserAllowingFrozen() }));
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...actual, checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args) };
});
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mocks.createClient(),
  getSupabaseAdmin: () => {
    throw new Error('the route test must not reach the real Supabase admin client');
  },
}));
vi.mock('@/lib/billing/public-plans', () => ({ listPublicPlans: () => mocks.listPublicPlans() }));
vi.mock('@/lib/billing/revenuecat-gateway', () => ({ createRevenueCatGateway: () => mocks.createRevenueCatGateway() }));
vi.mock('@/lib/billing/iap-repository', () => ({
  createIapRepository: () => ({
    listStoreProducts: (...args: unknown[]) => mocks.listStoreProducts(...args),
    listStoreSubscriptions: (...args: unknown[]) => mocks.listStoreSubscriptions(...args),
    applyStoreSubscription: (...args: unknown[]) => mocks.applyStoreSubscription(...args),
    claimRevenueCatEvent: vi.fn(),
    finishRevenueCatEvent: vi.fn(),
    recordIapAudit: vi.fn(),
  }),
}));
vi.mock('@/lib/billing/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/repository')>();
  return { ...actual, createBillingRepository: () => ({ kind: 'repository', findLiveSubscription: (...args: unknown[]) => mocks.findLiveSubscription(...args) }) };
});
vi.mock('@/lib/billing/service', () => ({ getBillingSummary: (...args: unknown[]) => mocks.getBillingSummary(...args) }));

import { GET as catalogGET } from '@/app/api/billing/iap/catalog/route';
import { POST as syncPOST } from '@/app/api/billing/iap/sync/route';
import { GET as subscriptionGET } from '@/app/api/billing/subscription/route';
import { ForbiddenError } from '@/lib/auth/errors';
import { FROZEN_ALLOWED_API_PATHS } from '@/lib/auth/frozen';
import { BillingRpcError } from '@/lib/billing/repository';
import { IAP_ERROR_MESSAGES, RevenueCatApiError, RevenueCatNotConfiguredError } from '@/lib/billing/iap-core';
import { isLegalConsentExemptApiPath } from '@homegohan/shared';
import { reachesAi, ROOT } from '../helpers/ai-reach';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'person@example.com' };
const SUMMARY = { plan_key: 'pro', effective_plan_key: 'pro', status: 'active', source: 'app_store', manage_in_store: 'app_store' };
const RAW_RC_TEXT = 'raw revenuecat text sk_secret_value (person@example.com)';
const FUTURE = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = '2026-01-01T00:00:00.000Z';

const PLANS = [
  { plan_key: 'pro', display_name: '個人 Pro', max_members: null, plan_type: 'personal', status: 'public' },
  { plan_key: 'family_pro', display_name: '家族 Pro', max_members: 8, plan_type: 'family', status: 'public' },
];

/** plan_store_products の公開の SELECT の偽物 (呼ばれた条件を記録する) */
function planStoreProductsClient() {
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['from', 'select']) {
    builder[method] = (...args: unknown[]) => {
      mocks.planStoreProductsQueries.push({ method, args });
      return builder;
    };
  }
  let eqCount = 0;
  builder.eq = (...args: unknown[]) => {
    mocks.planStoreProductsQueries.push({ method: 'eq', args });
    eqCount += 1;
    // 2 つ目の eq (offered) で結果を返す
    return eqCount >= 2 ? Promise.resolve(mocks.planStoreProductsResult) : builder;
  };
  return builder;
}

function catalogRequest(query: string): Request {
  return new Request(`http://localhost/api/billing/iap/catalog${query}`);
}

function subscriberWith(subscriptions: Record<string, unknown>) {
  return { request_date: new Date().toISOString(), subscriber: { original_app_user_id: USER.id, subscriptions } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planStoreProductsQueries.length = 0;
  mocks.planStoreProductsResult.data = [
    { plan_key: 'pro', store: 'app_store', billing_interval: 'year', product_id: 'homegohan_pro_year', offered: true },
    { plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month', offered: true },
  ];
  mocks.planStoreProductsResult.error = null;
  mocks.requireUser.mockResolvedValue(USER);
  mocks.requireUserAllowingFrozen.mockResolvedValue(USER);
  mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000, windowSec: 60 });
  mocks.createClient.mockImplementation(async () => planStoreProductsClient());
  mocks.listPublicPlans.mockResolvedValue(PLANS);
  mocks.getSubscriber.mockResolvedValue(
    subscriberWith({ homegohan_pro_month: { expires_date: FUTURE(), purchase_date: new Date().toISOString(), period_type: 'normal', store: 'app_store' } }),
  );
  mocks.createRevenueCatGateway.mockReturnValue({ getSubscriber: (...args: unknown[]) => mocks.getSubscriber(...args) });
  mocks.listStoreProducts.mockResolvedValue([{ plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month', offered: true }]);
  mocks.listStoreSubscriptions.mockResolvedValue([]);
  mocks.applyStoreSubscription.mockResolvedValue({ applied: true, subscription_id: 'row-1', user_id: USER.id, status_from: null, status_to: 'active', plan_key: 'pro' });
  mocks.findLiveSubscription.mockResolvedValue(null);
  mocks.getBillingSummary.mockResolvedValue(SUMMARY);
});

describe('GET /api/billing/iap/catalog (§9.2)', () => {
  it('GET catalog requires a valid store query, returns plans with products for that store and never reads env', async () => {
    const res = await catalogGET(catalogRequest('?store=app_store'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      data: {
        store: 'app_store',
        plans: [
          {
            plan_key: 'pro',
            display_name: '個人 Pro',
            max_members: null,
            products: [
              { billing_interval: 'month', product_id: 'homegohan_pro_month' },
              { billing_interval: 'year', product_id: 'homegohan_pro_year' },
            ],
          },
        ],
      },
    });
    // 読むのは公開の SELECT (そのストア・売る行だけ)
    expect(mocks.planStoreProductsQueries).toEqual([
      { method: 'from', args: ['plan_store_products'] },
      { method: 'select', args: ['plan_key, store, billing_interval, product_id, offered'] },
      { method: 'eq', args: ['store', 'app_store'] },
      { method: 'eq', args: ['offered', true] },
    ]);
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(mocks.createRevenueCatGateway).not.toHaveBeenCalled();
    // 環境変数の一覧 (AI の印) に届かない
    expect(reachesAi(path.join(ROOT, 'src/app/api/billing/iap/catalog/route.ts'))).toBe(false);
    // 売る行の無いストアは空
    mocks.planStoreProductsResult.data = [];
    const empty = await catalogGET(catalogRequest('?store=play_store'));
    expect(await empty.json()).toEqual({ data: { store: 'play_store', plans: [] } });
  });

  it('GET catalog returns 400 BILL_IAP_INVALID_INPUT with 入力値が不正です for a missing store, store=stripe and store=APP_STORE, and reads neither plan_store_products nor listPublicPlans', async () => {
    for (const query of ['', '?store=stripe', '?store=APP_STORE']) {
      const res = await catalogGET(catalogRequest(query));
      expect(res.status, query).toBe(400);
      const json = await res.json();
      expect(json.error.code, query).toBe('BILL_IAP_INVALID_INPUT');
      expect(json.error.message, query).toBe('入力値が不正です');
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.listPublicPlans).not.toHaveBeenCalled();
  });
});

describe('POST /api/billing/iap/sync (§9.3)', () => {
  it('POST sync returns the summary after syncing, 409 BILL_IAP_SYNC_CONFLICT on BILL_LIVE_ROW_CONFLICT, 503 when the key is missing', async () => {
    const ok = await syncPOST();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(await ok.json()).toEqual({ data: SUMMARY });
    expect(mocks.getSubscriber).toHaveBeenCalledWith(USER.id);
    expect(mocks.applyStoreSubscription.mock.calls[0][0]).toMatchObject({ source: 'iap_sync' });
    expect(mocks.getBillingSummary).toHaveBeenCalledWith({ repository: expect.objectContaining({ kind: 'repository' }) }, USER.id);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(USER.id, 'billing');

    mocks.applyStoreSubscription.mockRejectedValueOnce(new BillingRpcError('BILL_LIVE_ROW_CONFLICT', 'row-stripe'));
    const conflict = await syncPOST();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: 'BILL_IAP_SYNC_CONFLICT', message: IAP_ERROR_MESSAGES.BILL_IAP_SYNC_CONFLICT } });

    // 対応の行も利用者の行も無い live な商品は 422
    mocks.getSubscriber.mockResolvedValueOnce(
      subscriberWith({ unknown_product: { expires_date: FUTURE(), purchase_date: new Date().toISOString(), period_type: 'normal', store: 'app_store' } }),
    );
    const unknown = await syncPOST();
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({ error: { code: 'BILL_IAP_UNKNOWN_PRODUCT', message: IAP_ERROR_MESSAGES.BILL_IAP_UNKNOWN_PRODUCT } });

    mocks.createRevenueCatGateway.mockImplementationOnce(() => {
      throw new RevenueCatNotConfiguredError();
    });
    mocks.getBillingSummary.mockClear();
    const notConfigured = await syncPOST();
    expect(notConfigured.status).toBe(503);
    expect(await notConfigured.json()).toEqual({ error: { code: 'EXT_REVENUECAT_NOT_CONFIGURED', message: IAP_ERROR_MESSAGES.EXT_REVENUECAT_NOT_CONFIGURED } });
    expect(mocks.getBillingSummary).not.toHaveBeenCalled();

    // レート制限
    mocks.checkRateLimit.mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: Date.now() + 30_000, windowSec: 60 });
    const limited = await syncPOST();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('POST sync returns 502 EXT_REVENUECAT_API_FAILED with the fixed text (no raw RevenueCat text) and writes nothing when the gateway throws RevenueCatApiError, and GET subscription still returns the summary of the current row when the lazy resync gets the same error', async () => {
    mocks.getSubscriber.mockRejectedValueOnce(new RevenueCatApiError({ status: 500, rawMessage: RAW_RC_TEXT }));
    const res = await syncPOST();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'EXT_REVENUECAT_API_FAILED', message: IAP_ERROR_MESSAGES.EXT_REVENUECAT_API_FAILED } });
    expect(text).not.toContain('sk_secret_value');
    expect(mocks.applyStoreSubscription).not.toHaveBeenCalled();
    expect(mocks.getBillingSummary).not.toHaveBeenCalled();

    // 遅延の再同期が同じ失敗をしても、いまの行で要約を返す
    mocks.findLiveSubscription.mockResolvedValueOnce({ plan_key: 'pro', status: 'active', iap_store: 'app_store', current_period_end: PAST, iap_synced_at: null });
    mocks.getSubscriber.mockRejectedValueOnce(new RevenueCatApiError({ status: null, rawMessage: 'TimeoutError' }));
    const summary = await subscriptionGET();
    expect(summary.status).toBe(200);
    expect(await summary.json()).toEqual({ data: SUMMARY });
    expect(mocks.applyStoreSubscription).not.toHaveBeenCalled();
  });
});

describe('GET /api/billing/subscription の遅延の再同期 (§9.4)', () => {
  it('GET subscription lazily resyncs expired store rows and still returns the summary when RevenueCat is not configured', async () => {
    mocks.findLiveSubscription.mockResolvedValue({ plan_key: 'pro', status: 'active', iap_store: 'app_store', current_period_end: PAST, iap_synced_at: null });
    const res = await subscriptionGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: SUMMARY });
    expect(mocks.createRevenueCatGateway).toHaveBeenCalledTimes(1);
    expect(mocks.getSubscriber).toHaveBeenCalledWith(USER.id);
    expect(mocks.applyStoreSubscription.mock.calls[0][0]).toMatchObject({ source: 'iap_lazy_resync' });
    // 要約は取り直しのあとに読む
    expect(mocks.applyStoreSubscription.mock.invocationCallOrder[0]).toBeLessThan(mocks.getBillingSummary.mock.invocationCallOrder[0]);

    // 鍵が無いときは取り直さずに要約を返す
    vi.clearAllMocks();
    mocks.requireUserAllowingFrozen.mockResolvedValue(USER);
    mocks.getBillingSummary.mockResolvedValue(SUMMARY);
    mocks.createRevenueCatGateway.mockImplementation(() => {
      throw new RevenueCatNotConfiguredError();
    });
    const notConfigured = await subscriptionGET();
    expect(notConfigured.status).toBe(200);
    expect(await notConfigured.json()).toEqual({ data: SUMMARY });
    expect(mocks.applyStoreSubscription).not.toHaveBeenCalled();
    expect(mocks.getBillingSummary).toHaveBeenCalledTimes(1);
  });
});

describe('凍結と同意 (S21・S22)', () => {
  it('GET catalog and POST sync return 403 { code: AUTH_ACCOUNT_FROZEN, message: 権限がありません } when requireUser throws the frozen ForbiddenError, without reading plan_store_products or creating the RevenueCat gateway', async () => {
    mocks.requireUser.mockRejectedValue(new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています (内部の文)'));
    for (const call of [() => catalogGET(catalogRequest('?store=app_store')), () => syncPOST()]) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'AUTH_ACCOUNT_FROZEN', message: '権限がありません' } });
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.listPublicPlans).not.toHaveBeenCalled();
    expect(mocks.createRevenueCatGateway).not.toHaveBeenCalled();
    expect(mocks.getSubscriber).not.toHaveBeenCalled();
  });

  it('/api/billing/iap/catalog and /api/billing/iap/sync are in neither FROZEN_ALLOWED_API_PATHS (src/lib/auth/frozen.ts) nor the legal consent exemption (isLegalConsentExemptApiPath of @homegohan/shared is false for both)', () => {
    for (const apiPath of ['/api/billing/iap/catalog', '/api/billing/iap/sync']) {
      expect(FROZEN_ALLOWED_API_PATHS, apiPath).not.toContain(apiPath);
      expect(isLegalConsentExemptApiPath(apiPath), apiPath).toBe(false);
    }
    // 参照: Webhook は同意の許可リストの /api/webhooks (prefix) が通し、要約は leave_service の許可リスト
    expect(isLegalConsentExemptApiPath('/api/webhooks/revenuecat')).toBe(true);
    expect(isLegalConsentExemptApiPath('/api/billing/subscription')).toBe(true);
  });
});
