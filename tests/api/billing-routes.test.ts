// @vitest-environment node
/**
 * 課金の API 7 本 (src/app/api/billing/**) の route のテスト (billing/01 §14.1 のテスト 34〜36・93・94・114・115)。
 * ユースケース (@/lib/billing/service) と認証 (requireUser・requireUserAllowingFrozen) と Stripe / DB の生成をモックする。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireUserAllowingFrozen: vi.fn(),
  checkRateLimit: vi.fn(),
  createStripeGateway: vi.fn(),
  createBillingRepository: vi.fn(),
  startCheckout: vi.fn(),
  previewCheckout: vi.fn(),
  syncCheckoutSession: vi.fn(),
  getBillingSummary: vi.fn(),
  createPortalSession: vi.fn(),
  scheduleCancellation: vi.fn(),
  revokeCancellation: vi.fn(),
  // billing/03 §8.5: GET /api/billing/subscription の遅延の再同期
  findLiveSubscription: vi.fn(),
  createRevenueCatGateway: vi.fn(),
  lazyResyncStoreSubscription: vi.fn(),
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
vi.mock('@/lib/billing/stripe-gateway', () => ({ createStripeGateway: () => mocks.createStripeGateway() }));
vi.mock('@/lib/billing/repository', () => ({ createBillingRepository: () => mocks.createBillingRepository() }));
vi.mock('@/lib/billing/revenuecat-gateway', () => ({ createRevenueCatGateway: () => mocks.createRevenueCatGateway() }));
vi.mock('@/lib/billing/iap-repository', () => ({ createIapRepository: () => ({ kind: 'iap-repository' }) }));
vi.mock('@/lib/billing/iap-service', () => ({
  lazyResyncStoreSubscription: (...args: unknown[]) => mocks.lazyResyncStoreSubscription(...args),
}));
vi.mock('@/lib/billing/service', () => ({
  startCheckout: (...args: unknown[]) => mocks.startCheckout(...args),
  previewCheckout: (...args: unknown[]) => mocks.previewCheckout(...args),
  syncCheckoutSession: (...args: unknown[]) => mocks.syncCheckoutSession(...args),
  getBillingSummary: (...args: unknown[]) => mocks.getBillingSummary(...args),
  createPortalSession: (...args: unknown[]) => mocks.createPortalSession(...args),
  scheduleCancellation: (...args: unknown[]) => mocks.scheduleCancellation(...args),
  revokeCancellation: (...args: unknown[]) => mocks.revokeCancellation(...args),
}));

import { POST as checkoutPOST } from '@/app/api/billing/checkout/route';
import { GET as previewGET } from '@/app/api/billing/checkout/preview/route';
import { POST as syncPOST } from '@/app/api/billing/checkout/sync/route';
import { GET as subscriptionGET } from '@/app/api/billing/subscription/route';
import { POST as cancelPOST } from '@/app/api/billing/subscription/cancel/route';
import { POST as resumePOST } from '@/app/api/billing/subscription/resume/route';
import { POST as portalPOST } from '@/app/api/billing/portal/route';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { BILLING_ERROR_HTTP_STATUS, BILLING_ERROR_MESSAGES, BillingError, StripeApiError, StripeNotConfiguredError, type BillingErrorCode } from '@/lib/billing/core';
import { FROZEN_ALLOWED_API_PATHS } from '@/lib/auth/frozen';
import { reachesAi, ROOT } from '../helpers/ai-reach';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'person@example.com' };
const SUMMARY = { plan_key: 'pro', effective_plan_key: 'pro', status: 'active', can_cancel: true };
const RAW = 'raw stripe message cus_secret (person@example.com)';
const GATEWAY = { mode: 'test' };
const REPOSITORY = { kind: 'repository', findLiveSubscription: (...args: unknown[]) => mocks.findLiveSubscription(...args) };

type Call = () => Promise<Response>;

function jsonPost(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** 7 本の route と、それぞれが呼ぶユースケースのモック */
const ROUTES: Array<{ name: string; call: Call; usecase: ReturnType<typeof vi.fn>; frozenAllowed: boolean; callsStripe: boolean; rateLimited: boolean }> = [
  {
    name: 'POST /api/billing/checkout',
    call: () => checkoutPOST(jsonPost('/api/billing/checkout', { plan_key: 'pro', interval: 'month' })),
    usecase: mocks.startCheckout,
    frozenAllowed: false,
    callsStripe: true,
    rateLimited: true,
  },
  {
    name: 'GET /api/billing/checkout/preview',
    call: () => previewGET(new NextRequest('http://localhost/api/billing/checkout/preview?plan_key=pro&interval=year')),
    usecase: mocks.previewCheckout,
    frozenAllowed: false,
    callsStripe: false,
    rateLimited: false,
  },
  {
    name: 'POST /api/billing/checkout/sync',
    call: () => syncPOST(jsonPost('/api/billing/checkout/sync', { session_id: 'cs_test_1' })),
    usecase: mocks.syncCheckoutSession,
    frozenAllowed: false,
    callsStripe: true,
    rateLimited: true,
  },
  { name: 'GET /api/billing/subscription', call: () => subscriptionGET(), usecase: mocks.getBillingSummary, frozenAllowed: true, callsStripe: false, rateLimited: false },
  { name: 'POST /api/billing/subscription/cancel', call: () => cancelPOST(), usecase: mocks.scheduleCancellation, frozenAllowed: true, callsStripe: true, rateLimited: true },
  { name: 'POST /api/billing/subscription/resume', call: () => resumePOST(), usecase: mocks.revokeCancellation, frozenAllowed: false, callsStripe: true, rateLimited: true },
  { name: 'POST /api/billing/portal', call: () => portalPOST(), usecase: mocks.createPortalSession, frozenAllowed: true, callsStripe: true, rateLimited: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.requireUserAllowingFrozen.mockResolvedValue({ id: USER.id, email: USER.email });
  mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000, windowSec: 60 });
  mocks.createStripeGateway.mockReturnValue(GATEWAY);
  mocks.createBillingRepository.mockReturnValue(REPOSITORY);
  mocks.startCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/cs_1', session_id: 'cs_1' });
  mocks.previewCheckout.mockResolvedValue({ plan_key: 'pro', display_name: 'Pro', interval: 'year', amount_jpy: 9800, trial_days: 7, can_purchase: true });
  mocks.syncCheckoutSession.mockResolvedValue(SUMMARY);
  mocks.getBillingSummary.mockResolvedValue(SUMMARY);
  mocks.createPortalSession.mockResolvedValue({ url: 'https://billing.stripe.test/p' });
  mocks.scheduleCancellation.mockResolvedValue(SUMMARY);
  mocks.revokeCancellation.mockResolvedValue(SUMMARY);
  mocks.findLiveSubscription.mockResolvedValue(null);
});

describe('POST /api/billing/checkout', () => {
  it('POST /api/billing/checkout: 401 unauthenticated, 403 frozen, 429 rate limited, 400 invalid body, 200 url', async () => {
    mocks.requireUser.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    const unauth = await checkoutPOST(jsonPost('/api/billing/checkout', { plan_key: 'pro', interval: 'month' }));
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } });

    mocks.requireUser.mockRejectedValueOnce(new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています (内部の文)'));
    const frozen = await checkoutPOST(jsonPost('/api/billing/checkout', { plan_key: 'pro', interval: 'month' }));
    expect(frozen.status).toBe(403);
    expect(await frozen.json()).toEqual({ error: { code: 'AUTH_ACCOUNT_FROZEN', message: '権限がありません' } });

    mocks.checkRateLimit.mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: Date.now() + 30_000, windowSec: 60 });
    const limited = await checkoutPOST(jsonPost('/api/billing/checkout', { plan_key: 'pro', interval: 'month' }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(USER.id, 'billing');

    for (const body of [{ plan_key: 'pro', interval: 'week' }, { interval: 'month' }, { plan_key: '', interval: 'month' }, null]) {
      const bad = await checkoutPOST(jsonPost('/api/billing/checkout', body));
      expect(bad.status, JSON.stringify(body)).toBe(400);
      const json = await bad.json();
      expect(json.error.code).toBe('BILL_INVALID_INPUT');
      expect(Array.isArray(json.error.details)).toBe(true);
    }
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.createStripeGateway).not.toHaveBeenCalled();

    const ok = await checkoutPOST(jsonPost('/api/billing/checkout', { plan_key: 'pro', interval: 'month' }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(await ok.json()).toEqual({ data: { url: 'https://checkout.stripe.test/cs_1', session_id: 'cs_1' } });
    expect(mocks.startCheckout).toHaveBeenCalledWith({ gateway: GATEWAY, repository: REPOSITORY }, { id: USER.id, email: USER.email }, 'pro', 'month');

    // 本文の NULL 文字は認証より前に 400 (#1657)
    mocks.requireUser.mockClear();
    const nul = await checkoutPOST(jsonPost('/api/billing/checkout', { plan_key: 'pro\u0000', interval: 'month' }));
    expect(nul.status).toBe(400);
    expect(await nul.json()).toMatchObject({ code: 'INVALID_CHARACTER' });
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });
});

describe('課金の route 共通', () => {
  it('every billing route maps BillingError/StripeApiError/StripeNotConfiguredError to the table and returns fixed messages', async () => {
    const codes = Object.keys(BILLING_ERROR_HTTP_STATUS) as BillingErrorCode[];
    for (const route of ROUTES) {
      for (const code of codes) {
        route.usecase.mockRejectedValueOnce(new BillingError(code));
        const res = await route.call();
        expect(res.status, `${route.name} ${code}`).toBe(BILLING_ERROR_HTTP_STATUS[code]);
        expect(await res.json()).toEqual({ error: { code, message: BILLING_ERROR_MESSAGES[code] } });
        expect(res.headers.get('Cache-Control')).toBe('no-store');
      }
      route.usecase.mockRejectedValueOnce(new StripeApiError({ status: 402, stripeCode: 'card_declined', rawMessage: RAW }));
      const apiFailed = await route.call();
      expect(apiFailed.status, route.name).toBe(502);
      const apiFailedText = await apiFailed.text();
      expect(JSON.parse(apiFailedText)).toEqual({ error: { code: 'EXT_STRIPE_API_FAILED', message: BILLING_ERROR_MESSAGES.EXT_STRIPE_API_FAILED } });
      expect(apiFailedText).not.toContain('cus_secret');

      route.usecase.mockRejectedValueOnce(new StripeNotConfiguredError());
      const notConfigured = await route.call();
      expect(notConfigured.status, route.name).toBe(503);
      expect(await notConfigured.json()).toEqual({ error: { code: 'EXT_STRIPE_NOT_CONFIGURED', message: 'お支払いを受け付けていません' } });

      route.usecase.mockRejectedValueOnce(new Error(RAW));
      const internal = await route.call();
      expect(internal.status, route.name).toBe(500);
      const internalText = await internal.text();
      expect(JSON.parse(internalText)).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
      expect(internalText).not.toContain('cus_secret');
    }

    // Stripe を呼ぶ route は、鍵が無ければ gateway の生成で 503 (ユースケースに届かない)
    mocks.createStripeGateway.mockImplementation(() => {
      throw new StripeNotConfiguredError();
    });
    for (const route of ROUTES.filter((item) => item.callsStripe)) {
      route.usecase.mockClear();
      const res = await route.call();
      expect(res.status, route.name).toBe(503);
      expect(route.usecase).not.toHaveBeenCalled();
    }
  });

  it('GET /api/billing/subscription returns the summary with Cache-Control: no-store', async () => {
    const res = await subscriptionGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ data: SUMMARY });
    expect(mocks.getBillingSummary).toHaveBeenCalledWith({ repository: REPOSITORY }, USER.id);
    // 未認証は 401
    mocks.requireUserAllowingFrozen.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await subscriptionGET()).status).toBe(401);
    // レート制限は掛けない
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('GET /api/billing/subscription reads findLiveSubscription and neither creates the RevenueCat gateway nor calls lazyResyncStoreSubscription for a null row, a Stripe row (iap_store null) or a store row whose current_period_end is in the future', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const rows = [
      null,
      { plan_key: 'pro', status: 'active', stripe_subscription_id: 'sub_1', iap_store: null, current_period_end: '2020-01-01T00:00:00.000Z', iap_synced_at: null },
      { plan_key: 'pro', status: 'active', stripe_subscription_id: null, iap_store: 'app_store', current_period_end: future, iap_synced_at: null },
    ];
    for (const row of rows) {
      vi.clearAllMocks();
      mocks.requireUserAllowingFrozen.mockResolvedValue({ id: USER.id, email: USER.email });
      mocks.createBillingRepository.mockReturnValue(REPOSITORY);
      mocks.getBillingSummary.mockResolvedValue(SUMMARY);
      mocks.findLiveSubscription.mockResolvedValue(row);
      const res = await subscriptionGET();
      expect(res.status, JSON.stringify(row)).toBe(200);
      expect(await res.json()).toEqual({ data: SUMMARY });
      expect(mocks.findLiveSubscription).toHaveBeenCalledWith(USER.id);
      expect(mocks.createRevenueCatGateway, JSON.stringify(row)).not.toHaveBeenCalled();
      expect(mocks.lazyResyncStoreSubscription, JSON.stringify(row)).not.toHaveBeenCalled();
      expect(mocks.getBillingSummary).toHaveBeenCalledWith({ repository: REPOSITORY }, USER.id);
    }
  });

  it('GET /api/billing/subscription and GET /api/billing/checkout/preview return 200 without STRIPE_SECRET_KEY: they pass only the repository to the service and never call createStripeGateway', async () => {
    mocks.createStripeGateway.mockImplementation(() => {
      throw new StripeNotConfiguredError();
    });
    const summary = await subscriptionGET();
    expect(summary.status).toBe(200);
    const preview = await previewGET(new NextRequest('http://localhost/api/billing/checkout/preview?plan_key=pro&interval=year'));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ data: { plan_key: 'pro', interval: 'year', amount_jpy: 9800 } });
    expect(mocks.createStripeGateway).not.toHaveBeenCalled();
    expect(mocks.getBillingSummary.mock.calls[0][0]).toEqual({ repository: REPOSITORY });
    expect(mocks.previewCheckout).toHaveBeenCalledWith({ repository: REPOSITORY }, USER.id, 'pro', 'year');
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    // 確認画面の入力の誤りは 400
    const bad = await previewGET(new NextRequest('http://localhost/api/billing/checkout/preview?plan_key=pro'));
    expect(bad.status).toBe(400);
    // 2 本のソースは stripe-gateway を import しない
    for (const file of ['src/app/api/billing/subscription/route.ts', 'src/app/api/billing/checkout/preview/route.ts']) {
      const specifiers = [...fs.readFileSync(path.join(process.cwd(), file), 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
      expect(specifiers.length, file).toBeGreaterThan(0);
      expect(specifiers, file).not.toContain('@/lib/billing/stripe-gateway');
      expect(specifiers, file).not.toContain('@/lib/env');
    }
  });

  it('AI reach inventory: the 5 Stripe-calling billing routes, GET /api/billing/subscription (lazy RevenueCat resync), the Stripe webhook route and account/delete reach the AI markers only through src/lib/env.ts, and GET /api/billing/checkout/preview does not reach them', () => {
    const envFile = path.join(ROOT, 'src/lib/env.ts');
    const reaching = [
      'src/app/api/billing/checkout/route.ts',
      'src/app/api/billing/checkout/sync/route.ts',
      'src/app/api/billing/portal/route.ts',
      'src/app/api/billing/subscription/cancel/route.ts',
      'src/app/api/billing/subscription/resume/route.ts',
      'src/app/api/billing/subscription/route.ts',
      'src/app/api/webhooks/stripe/route.ts',
      'src/app/api/account/delete/route.ts',
    ];
    for (const file of reaching) {
      const full = path.join(ROOT, file);
      expect(reachesAi(full), file).toBe(true);
      expect(reachesAi(full, new Set([envFile])), `${file} は env.ts を辿らなければ届かない`).toBe(false);
    }
    for (const file of ['src/app/api/billing/checkout/preview/route.ts']) {
      expect(reachesAi(path.join(ROOT, file)), file).toBe(false);
    }
  });
});

describe('凍結 (BAN) 中の利用者 (billing/01 §9.8)', () => {
  it('GET /api/billing/subscription, POST /api/billing/subscription/cancel and POST /api/billing/portal authenticate with requireUserAllowingFrozen and return 200 for a frozen user without calling requireUser; POST checkout / checkout/sync / subscription/resume and GET checkout/preview call requireUser and return 403 AUTH_ACCOUNT_FROZEN when it throws ForbiddenError', async () => {
    // 凍結中: requireUser は 403 を投げる。requireUserAllowingFrozen は凍結を見ずに利用者を返す
    mocks.requireUser.mockRejectedValue(new ForbiddenError('AUTH_ACCOUNT_FROZEN'));
    for (const route of ROUTES) {
      mocks.requireUser.mockClear();
      mocks.requireUserAllowingFrozen.mockClear();
      route.usecase.mockClear();
      const res = await route.call();
      if (route.frozenAllowed) {
        expect(res.status, route.name).toBe(200);
        expect(mocks.requireUserAllowingFrozen, route.name).toHaveBeenCalledTimes(1);
        expect(mocks.requireUser, route.name).not.toHaveBeenCalled();
        expect(route.usecase, route.name).toHaveBeenCalledTimes(1);
        expect(route.usecase.mock.calls[0][1], route.name).toBe(USER.id);
      } else {
        expect(res.status, route.name).toBe(403);
        expect(await res.json()).toEqual({ error: { code: 'AUTH_ACCOUNT_FROZEN', message: '権限がありません' } });
        expect(mocks.requireUser, route.name).toHaveBeenCalledTimes(1);
        expect(mocks.requireUserAllowingFrozen, route.name).not.toHaveBeenCalled();
        expect(route.usecase, route.name).not.toHaveBeenCalled();
      }
    }
  });

  it('the billing routes whose URL path is in FROZEN_ALLOWED_API_PATHS call requireUserAllowingFrozen and not requireUser, and every other billing route calls requireUser and not requireUserAllowingFrozen', () => {
    const apiRoot = path.join(process.cwd(), 'src/app/api/billing');
    const list = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return list(full);
        return entry.name === 'route.ts' ? [full] : [];
      });
    const files = list(apiRoot);
    // 走査の道が変わって 0 本で緑にならないように、本数を固定する
    expect(files).toHaveLength(9);
    const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const urls: string[] = [];
    for (const file of files) {
      const url = `/api/billing${path.dirname(path.relative(apiRoot, file)) === '.' ? '' : `/${path.dirname(path.relative(apiRoot, file)).split(path.sep).join('/')}`}`;
      urls.push(url);
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      const callsAllowingFrozen = /\brequireUserAllowingFrozen\(/.test(source);
      const callsRequireUser = /\brequireUser\(/.test(source);
      if (FROZEN_ALLOWED_API_PATHS.includes(url)) {
        expect(callsAllowingFrozen, url).toBe(true);
        expect(callsRequireUser, url).toBe(false);
      } else {
        expect(callsRequireUser, url).toBe(true);
        expect(callsAllowingFrozen, url).toBe(false);
      }
    }
    const billingAllowed = FROZEN_ALLOWED_API_PATHS.filter((item) => item.startsWith('/api/billing/'));
    expect([...billingAllowed].sort()).toEqual(['/api/billing/portal', '/api/billing/subscription', '/api/billing/subscription/cancel']);
    for (const allowed of billingAllowed) expect(urls, allowed).toContain(allowed);
  });
});
