// @vitest-environment node
/**
 * POST /api/webhooks/revenuecat (src/app/api/webhooks/revenuecat/route.ts) のテスト (billing/03 §14.1 のテスト 25〜30・122)。
 * 署名の確認は本物 (verifyRevenueCatWebhook。秘密は環境変数で与える)。RevenueCat と DB は偽物 (gateway と repository の生成をモック)。
 * ユースケース (iap-service) は本物を通し、偽の gateway・repository で取り直しと写像を見る。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRevenueCatGateway: vi.fn(),
  getSubscriber: vi.fn(),
  listStoreProducts: vi.fn(),
  listStoreSubscriptions: vi.fn(),
  applyStoreSubscription: vi.fn(),
  claimRevenueCatEvent: vi.fn(),
  finishRevenueCatEvent: vi.fn(),
  recordIapAudit: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: mocks.loggerInfo, warn: mocks.loggerWarn, error: mocks.loggerError, withUser: () => logger };
  return { createLogger: () => logger, generateRequestId: () => 'req-test' };
});
vi.mock('@/lib/billing/revenuecat-gateway', () => ({ createRevenueCatGateway: () => mocks.createRevenueCatGateway() }));
vi.mock('@/lib/billing/iap-repository', () => ({
  createIapRepository: () => ({
    listStoreProducts: (...args: unknown[]) => mocks.listStoreProducts(...args),
    listStoreSubscriptions: (...args: unknown[]) => mocks.listStoreSubscriptions(...args),
    applyStoreSubscription: (...args: unknown[]) => mocks.applyStoreSubscription(...args),
    claimRevenueCatEvent: (...args: unknown[]) => mocks.claimRevenueCatEvent(...args),
    finishRevenueCatEvent: (...args: unknown[]) => mocks.finishRevenueCatEvent(...args),
    recordIapAudit: (...args: unknown[]) => mocks.recordIapAudit(...args),
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => {
    throw new Error('the route test must not reach the real Supabase client');
  },
}));

import * as route from '@/app/api/webhooks/revenuecat/route';
import { BillingRpcError } from '@/lib/billing/repository';
import {
  IapError,
  REVENUECAT_WEBHOOK_MAX_BODY_BYTES,
  REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS,
  RevenueCatApiError,
  RevenueCatNotConfiguredError,
} from '@/lib/billing/iap-core';

/** 署名の秘密 (テスト用のダミー。本物の書式にしない) */
const SECRET = 'rc-route-unit-test-secret'; // gitleaks:allow
const MS_PER_SECOND = 1000;
const USER = '11111111-1111-4111-8111-111111111111';
const RAW_RC_TEXT = 'raw revenuecat error text sk_secret_value (person@example.com)';

function eventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_version: '1.0',
    event: {
      id: 'evt_rc_1',
      type: 'RENEWAL',
      event_timestamp_ms: 1_760_000_000_000,
      app_user_id: USER,
      product_id: 'homegohan_pro_month',
      store: 'APP_STORE',
      environment: 'PRODUCTION',
      subscriber_attributes: { $email: { value: 'person@example.com' } },
      ...overrides,
    },
  };
}

function sign(payload: string, secret = SECRET, nowMs = Date.now()): string {
  const t = String(Math.floor(nowMs / MS_PER_SECOND));
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

function request(payload: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/webhooks/revenuecat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
}

function signed(body: Record<string, unknown> = eventBody()): Request {
  const payload = JSON.stringify(body);
  return request(payload, { 'x-revenuecat-webhook-signature': sign(payload) });
}

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('REVENUECAT_WEBHOOK_SECRET', SECRET);
  mocks.getSubscriber.mockResolvedValue({
    request_date: new Date().toISOString(),
    subscriber: {
      original_app_user_id: USER,
      subscriptions: { homegohan_pro_month: { expires_date: FUTURE, purchase_date: new Date().toISOString(), period_type: 'normal', store: 'app_store' } },
    },
  });
  mocks.createRevenueCatGateway.mockReturnValue({ getSubscriber: (...args: unknown[]) => mocks.getSubscriber(...args) });
  mocks.listStoreProducts.mockResolvedValue([
    { plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month', offered: true },
  ]);
  mocks.listStoreSubscriptions.mockResolvedValue([]);
  mocks.applyStoreSubscription.mockResolvedValue({ applied: true, subscription_id: 'row-1', user_id: USER, status_from: null, status_to: 'active', plan_key: 'pro' });
  mocks.claimRevenueCatEvent.mockResolvedValue('claimed');
  mocks.finishRevenueCatEvent.mockResolvedValue(undefined);
  mocks.recordIapAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/webhooks/revenuecat: 入口', () => {
  it('returns 413 { error: payload_too_large } for a content-length header or a body over REVENUECAT_WEBHOOK_MAX_BODY_BYTES (256 KiB) before verifying the signature, 401 for a bad signature, 400 for malformed JSON or envelope', async () => {
    expect(REVENUECAT_WEBHOOK_MAX_BODY_BYTES).toBe(256 * 1024);
    const declared = await route.POST(request('{}', { 'content-length': String(REVENUECAT_WEBHOOK_MAX_BODY_BYTES + 1) }));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: 'payload_too_large' });
    const big = JSON.stringify({ pad: 'x'.repeat(REVENUECAT_WEBHOOK_MAX_BODY_BYTES) });
    const actual = await route.POST(request(big, { 'x-revenuecat-webhook-signature': sign(big) }));
    expect(actual.status).toBe(413);
    expect(await actual.json()).toEqual({ error: 'payload_too_large' });
    expect(mocks.loggerWarn).not.toHaveBeenCalled();

    const payload = JSON.stringify(eventBody());
    for (const header of [undefined, sign(payload, 'other-secret'), sign(`${payload} `), sign(payload, SECRET, Date.now() - 10 * 60 * MS_PER_SECOND)]) {
      const res = await route.POST(request(payload, header ? { 'x-revenuecat-webhook-signature': header } : {}));
      expect(res.status, String(header)).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }

    for (const bad of ['not json', JSON.stringify({ api_version: '1.0' }), JSON.stringify({ api_version: '1.0', event: { type: 'RENEWAL', event_timestamp_ms: 1 } })]) {
      const res = await route.POST(request(bad, { 'x-revenuecat-webhook-signature': sign(bad) }));
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_payload' });
    }
    expect(mocks.createRevenueCatGateway).not.toHaveBeenCalled();
    expect(mocks.claimRevenueCatEvent).not.toHaveBeenCalled();
  });

  it('returns 503 { error: webhook_not_configured } when REVENUECAT_WEBHOOK_SECRET is missing and 503 { error: revenuecat_not_configured } when REVENUECAT_SECRET_API_KEY is missing, without claiming the event', async () => {
    vi.stubEnv('REVENUECAT_WEBHOOK_SECRET', '');
    const missingSecret = await route.POST(signed());
    expect(missingSecret.status).toBe(503);
    expect(await missingSecret.json()).toEqual({ error: 'webhook_not_configured' });
    expect(mocks.createRevenueCatGateway).not.toHaveBeenCalled();

    vi.stubEnv('REVENUECAT_WEBHOOK_SECRET', SECRET);
    mocks.createRevenueCatGateway.mockImplementation(() => {
      throw new RevenueCatNotConfiguredError();
    });
    const missingKey = await route.POST(signed());
    expect(missingKey.status).toBe(503);
    expect(await missingKey.json()).toEqual({ error: 'revenuecat_not_configured' });
    expect(mocks.claimRevenueCatEvent).not.toHaveBeenCalled();
    expect(mocks.finishRevenueCatEvent).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/revenuecat: claim と処理', () => {
  it('returns 200 duplicate for completed claims, 409 for in_progress, and 200 synced after handling', async () => {
    mocks.claimRevenueCatEvent.mockResolvedValueOnce('completed');
    const duplicate = await route.POST(signed());
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
    expect(mocks.getSubscriber).not.toHaveBeenCalled();

    mocks.claimRevenueCatEvent.mockResolvedValueOnce('in_progress');
    const inProgress = await route.POST(signed());
    expect(inProgress.status).toBe(409);
    expect(await inProgress.json()).toEqual({ error: 'event_in_progress' });
    expect(mocks.getSubscriber).not.toHaveBeenCalled();

    const ok = await route.POST(signed());
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(await ok.json()).toEqual({ received: true, action: 'synced', detail: '1/0/0/0' });
    // claim の payload は最小化した写し (個人情報の subscriber_attributes を残さない)
    const claimed = mocks.claimRevenueCatEvent.mock.calls.at(-1)?.[0];
    expect(claimed).toMatchObject({ id: 'evt_rc_1', type: 'RENEWAL', app_user_id: USER });
    expect(JSON.stringify(claimed)).not.toContain('person@example.com');
    expect(mocks.getSubscriber).toHaveBeenCalledWith(USER);
    expect(mocks.applyStoreSubscription.mock.calls[0][0]).toMatchObject({ source: 'revenuecat:evt_rc_1' });
    expect(mocks.finishRevenueCatEvent).toHaveBeenLastCalledWith('evt_rc_1', { ok: true });

    // 対象外の種類 (TEST) は取り直さずに 200 ignored
    const test = await route.POST(signed(eventBody({ type: 'TEST' })));
    expect(await test.json()).toEqual({ received: true, action: 'ignored', detail: 'TEST' });
  });

  it('returns 500 and records failure with the BillingRpcError / IapError code when handling throws', async () => {
    const cases: Array<[unknown, string]> = [
      [new BillingRpcError('BILL_LIVE_ROW_CONFLICT', 'row-stripe'), 'BILL_LIVE_ROW_CONFLICT'],
      [new BillingRpcError('BILL_UNKNOWN_IAP_STATUS', 'bogus'), 'BILL_UNKNOWN_IAP_STATUS'],
      [new IapError('BILL_IAP_UNKNOWN_PRODUCT'), 'BILL_IAP_UNKNOWN_PRODUCT'],
      [new Error(RAW_RC_TEXT), 'SYS_INTERNAL_ERROR'],
    ];
    for (const [error, code] of cases) {
      mocks.finishRevenueCatEvent.mockClear();
      mocks.recordIapAudit.mockClear();
      mocks.applyStoreSubscription.mockRejectedValueOnce(error);
      const res = await route.POST(signed());
      expect(res.status, code).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(text).not.toContain('sk_secret_value');
      expect(mocks.finishRevenueCatEvent).toHaveBeenCalledWith('evt_rc_1', { ok: false, errorCode: code });
      expect(mocks.recordIapAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action_type: 'system.revenuecat.event_failed', details: { event_id: 'evt_rc_1', event_type: 'RENEWAL', error_code: code } }),
      );
    }
    // 失敗の記録が失敗しても 500 (ログに残す)
    mocks.applyStoreSubscription.mockRejectedValueOnce(new IapError('BILL_IAP_UNKNOWN_PRODUCT'));
    mocks.finishRevenueCatEvent.mockRejectedValueOnce(new Error('db down'));
    expect((await route.POST(signed())).status).toBe(500);
  });

  it('returns 500 and records the event failed with EXT_REVENUECAT_API_FAILED when the RevenueCat fetch throws RevenueCatApiError, without the raw RevenueCat text in the body', async () => {
    mocks.getSubscriber.mockRejectedValueOnce(new RevenueCatApiError({ status: 503, rawMessage: RAW_RC_TEXT }));
    const res = await route.POST(signed());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('sk_secret_value');
    expect(text).not.toContain('person@example.com');
    expect(mocks.finishRevenueCatEvent).toHaveBeenCalledWith('evt_rc_1', { ok: false, errorCode: 'EXT_REVENUECAT_API_FAILED' });
    expect(mocks.applyStoreSubscription).not.toHaveBeenCalled();
    // 時間切れ・接続の失敗 (status null) も同じコード
    mocks.finishRevenueCatEvent.mockClear();
    mocks.getSubscriber.mockRejectedValueOnce(new RevenueCatApiError({ status: null, rawMessage: 'TimeoutError' }));
    expect((await route.POST(signed())).status).toBe(500);
    expect(mocks.finishRevenueCatEvent).toHaveBeenCalledWith('evt_rc_1', { ok: false, errorCode: 'EXT_REVENUECAT_API_FAILED' });
  });

  it('handles SANDBOX events exactly like PRODUCTION events (no environment branch): the sync is called and the response is 200 synced', async () => {
    const results: unknown[] = [];
    for (const environment of ['SANDBOX', 'PRODUCTION']) {
      mocks.getSubscriber.mockClear();
      mocks.applyStoreSubscription.mockClear();
      const res = await route.POST(signed(eventBody({ environment })));
      expect(res.status, environment).toBe(200);
      results.push(await res.json());
      expect(mocks.getSubscriber, environment).toHaveBeenCalledWith(USER);
      expect(mocks.applyStoreSubscription, environment).toHaveBeenCalledTimes(1);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({ received: true, action: 'synced', detail: '1/0/0/0' });
    // route・ユースケースのソースに環境の分岐が無い
    for (const file of ['src/app/api/webhooks/revenuecat/route.ts', 'src/lib/billing/iap-service.ts']) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(/SANDBOX|PRODUCTION|\.environment\b/);
    }
  });

  it('maxDuration literal equals REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS', () => {
    expect(route.maxDuration).toBe(REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS);
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/api/webhooks/revenuecat/route.ts'), 'utf8');
    expect(source).toMatch(/^export const maxDuration = \d+;/m);
    expect(route.runtime).toBe('nodejs');
  });
});
