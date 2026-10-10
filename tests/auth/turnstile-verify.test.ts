/**
 * #1165 サーバーでの Turnstile のトークンの確認 (src/lib/auth/turnstile-verify.ts) の単体テスト
 *
 * | 秘密キー | サイトキー | トークン | Cloudflare の応答        | 結果          | ログ                                  |
 * |----------|------------|----------|--------------------------|---------------|---------------------------------------|
 * | なし     | (どちらも) | (どれも) | (呼ばない)               | disabled      | 秘密キーが無い旨をプロセスで 1 回だけ |
 * | あり     | なし       | (どれも) | (呼ばない)               | disabled      | 組になっていない旨を 1 回だけ         |
 * | あり     | あり       | なし     | (呼ばない)               | failed        |                                       |
 * | あり     | あり       | 長すぎる | (呼ばない)               | failed        |                                       |
 * | あり     | あり       | あり     | success: true            | passed        |                                       |
 * | あり     | あり       | あり     | success: false + codes   | failed(codes) |                                       |
 * | あり     | あり       | あり     | 5xx / 通信失敗 / 壊れた  | unavailable   | warn                                  |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

import { resetEnvWarningsForTest } from '@/lib/env';
import {
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TOKEN_MAX_LENGTH,
  isTurnstileVerificationEnabled,
  resetTurnstileVerifyWarningsForTest,
  verifyTurnstileToken,
} from '@/lib/auth/turnstile-verify';

const SECRET = '1x0000000000000000000000000000000AA';
const SITE_KEY = '1x00000000000000000000AA';

function siteverifyResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** db-logger の警告 (getOptionalEnv の警告は動的 import の先で出るので、少し待つ) */
async function flushWarnings() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEnvWarningsForTest();
  resetTurnstileVerifyWarningsForTest();
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('無効 (キーが未設定) なら、確かめずに通す', () => {
  it('秘密キーが無ければ disabled。Cloudflare を呼ばない。警告はプロセスで 1 回だけ', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);

    expect(await verifyTurnstileToken('tok', '203.0.113.1')).toEqual({ status: 'disabled' });
    expect(await verifyTurnstileToken(undefined, null)).toEqual({ status: 'disabled' });
    expect(isTurnstileVerificationEnabled()).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();

    await flushWarnings();
    // getOptionalEnv の警告。サーバーでは db-logger へ、ブラウザ相当の環境 (このテストの DOM 環境) では console.warn へ出る
    const secretWarnings = [...mocks.warn.mock.calls, ...consoleWarn.mock.calls].filter(([message]) =>
      String(message).includes('TURNSTILE_SECRET_KEY'),
    );
    expect(secretWarnings).toHaveLength(1);
  });

  it('秘密キーだけあってサイトキーが無ければ disabled (トークンを取る手段が無いため)。警告は 1 回だけ', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', SECRET);
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');

    expect(await verifyTurnstileToken('tok', null)).toEqual({ status: 'disabled' });
    expect(await verifyTurnstileToken('tok', null)).toEqual({ status: 'disabled' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    const pairWarnings = mocks.warn.mock.calls.filter(([message]) => String(message).includes('NEXT_PUBLIC_TURNSTILE_SITE_KEY が無い'));
    expect(pairWarnings).toHaveLength(1);
  });
});

describe('有効 (キーが両方ある)', () => {
  beforeEach(() => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', SECRET);
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
  });

  it('トークンが無ければ Cloudflare を呼ばずに failed', async () => {
    expect(isTurnstileVerificationEnabled()).toBe(true);
    expect(await verifyTurnstileToken(undefined, null)).toEqual({ status: 'failed', errorCodes: ['missing-input-response'] });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('長すぎるトークンは Cloudflare を呼ばずに failed', async () => {
    const result = await verifyTurnstileToken('x'.repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1), null);
    expect(result).toEqual({ status: 'failed', errorCodes: ['invalid-input-response'] });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('秘密キー・トークン・IP アドレスを siteverify へ送り、success: true なら passed', async () => {
    mocks.fetch.mockResolvedValue(siteverifyResponse(200, { success: true, 'error-codes': [] }));

    expect(await verifyTurnstileToken('tok-1', '203.0.113.9')).toEqual({ status: 'passed' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(init.method).toBe('POST');
    const body = init.body as URLSearchParams;
    expect(body.get('secret')).toBe(SECRET);
    expect(body.get('response')).toBe('tok-1');
    expect(body.get('remoteip')).toBe('203.0.113.9');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('IP アドレスが無ければ remoteip を送らない', async () => {
    mocks.fetch.mockResolvedValue(siteverifyResponse(200, { success: true }));
    await verifyTurnstileToken('tok-1', null);
    const body = (mocks.fetch.mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(body.has('remoteip')).toBe(false);
  });

  it('success: false なら failed (Cloudflare のエラーコードつき)', async () => {
    mocks.fetch.mockResolvedValue(siteverifyResponse(200, { success: false, 'error-codes': ['timeout-or-duplicate'] }));
    expect(await verifyTurnstileToken('used', null)).toEqual({ status: 'failed', errorCodes: ['timeout-or-duplicate'] });
  });

  it.each([
    ['5xx', async () => siteverifyResponse(503, { success: false })],
    ['通信の失敗', async () => Promise.reject(new TypeError('fetch failed'))],
    ['時間切れ', async () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['壊れた応答', async () => siteverifyResponse(200, { unexpected: true })],
    ['JSON でない応答', async () => new Response('<html>', { status: 200 })],
  ])('%s なら unavailable (通さない側に倒す)・警告を残す', async (_label, impl) => {
    mocks.fetch.mockImplementation(impl);
    expect(await verifyTurnstileToken('tok', null)).toEqual({ status: 'unavailable' });
    expect(mocks.warn).toHaveBeenCalled();
  });
});
