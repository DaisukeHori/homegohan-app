// @vitest-environment node
/**
 * RevenueCat の REST v1 の gateway (src/lib/billing/revenuecat-gateway.ts) の単体テスト (billing/03 §14.1 のテスト 121)。
 * createRevenueCatGateway(fetchImpl) に偽の fetch を渡す。秘密の鍵は getOptionalEnv の偽物で与える (本物の RevenueCat を呼ばない)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getOptionalEnv: vi.fn(), loggerError: vi.fn() }));
vi.mock('@/lib/env', () => ({ getOptionalEnv: (name: string) => mocks.getOptionalEnv(name) }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.loggerError }),
  generateRequestId: () => 'req-test',
}));

import { createRevenueCatGateway } from '@/lib/billing/revenuecat-gateway';
import { REVENUECAT_API_BASE_URL, RevenueCatApiError, RevenueCatNotConfiguredError } from '@/lib/billing/iap-core';

/** テスト用のダミーの鍵 (本物の書式にしない) */
const KEY = 'rc-gateway-unit-test-key'; // gitleaks:allow
const USER = '11111111-1111-4111-8111-111111111111';
const SUBSCRIBER = {
  request_date: '2026-10-21T00:00:00Z',
  subscriber: {
    original_app_user_id: USER,
    subscriptions: { homegohan_pro_month: { expires_date: '2026-11-21T00:00:00Z', purchase_date: '2026-10-21T00:00:00Z', period_type: 'normal', store: 'app_store' } },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function rejectionOf(promise: Promise<unknown>): Promise<RevenueCatApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RevenueCatApiError);
    return error as RevenueCatApiError;
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOptionalEnv.mockImplementation((name: string) => (name === 'REVENUECAT_SECRET_API_KEY' ? `  ${KEY}  ` : undefined));
});

describe('billing/03 §8.3 createRevenueCatGateway', () => {
  it('getSubscriber throws RevenueCatApiError with the status for a non-2xx response, with the status for an unexpected response shape, and with status null for a TimeoutError and a network TypeError, and returns the parsed subscriber for a 2xx response', async () => {
    // 2xx: 解析した subscriber を返す。URL・認証のヘッダー (前後の空白を除いた鍵)・時間切れの signal
    const ok = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(SUBSCRIBER));
    const parsed = await createRevenueCatGateway(ok as unknown as typeof fetch).getSubscriber(USER);
    expect(parsed.subscriber.original_app_user_id).toBe(USER);
    expect(Object.keys(parsed.subscriber.subscriptions)).toEqual(['homegohan_pro_month']);
    expect(ok.mock.calls[0][0]).toBe(`${REVENUECAT_API_BASE_URL}/subscribers/${USER}`);
    const init = ok.mock.calls[0][1];
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Authorization: `Bearer ${KEY}`, Accept: 'application/json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // app_user_id は URL のパスとして符号化する
    await createRevenueCatGateway(ok as unknown as typeof fetch).getSubscriber('a/b c');
    expect(ok.mock.calls[1][0]).toBe(`${REVENUECAT_API_BASE_URL}/subscribers/a%2Fb%20c`);

    // 2xx 以外: status 付き。生の文面は rawMessage にだけ (message は固定)
    const notOk = await rejectionOf(
      createRevenueCatGateway((async () => jsonResponse({ code: 7225, message: 'raw text sk_secret' }, 500)) as unknown as typeof fetch).getSubscriber(USER),
    );
    expect(notOk.status).toBe(500);
    expect(notOk.message).not.toContain('sk_secret');
    expect(notOk.rawMessage).toContain('raw text');

    // 応答の形が違う: status 付き
    const badShape = await rejectionOf(
      createRevenueCatGateway((async () => jsonResponse({ subscriber: { subscriptions: {} } })) as unknown as typeof fetch).getSubscriber(USER),
    );
    expect(badShape.status).toBe(200);
    expect(badShape.rawMessage).toBe('unexpected response shape');

    // 時間切れ (TimeoutError) と接続の失敗 (TypeError): status null・名前だけを残す
    const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const timedOut = await rejectionOf(
      createRevenueCatGateway((async () => Promise.reject(timeoutError)) as unknown as typeof fetch).getSubscriber(USER),
    );
    expect(timedOut.status).toBeNull();
    expect(timedOut.rawMessage).toBe('TimeoutError');
    const network = await rejectionOf(
      createRevenueCatGateway((async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch).getSubscriber(USER),
    );
    expect(network.status).toBeNull();
    expect(network.rawMessage).toBe('TypeError');
    expect(mocks.loggerError).toHaveBeenCalledTimes(4);
  });

  it('createRevenueCatGateway throws RevenueCatNotConfiguredError when REVENUECAT_SECRET_API_KEY is missing or blank', () => {
    for (const value of [undefined, '', '   ']) {
      mocks.getOptionalEnv.mockImplementation(() => value);
      expect(() => createRevenueCatGateway(vi.fn() as unknown as typeof fetch)).toThrow(RevenueCatNotConfiguredError);
    }
  });
});
