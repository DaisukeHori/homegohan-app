// @vitest-environment node
/**
 * Apple の交換 (/auth/token) と失効 (/auth/revoke) の呼び出し (docs/design/mobile/08-sign-in-with-apple.md §11.3)
 * 本物の Apple には繋がない (fetch は引数で差し替える)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPLE_API_TIMEOUT_MS, APPLE_REVOKE_ENDPOINT, APPLE_TOKEN_ENDPOINT } from '@/lib/auth/apple/config';
import { exchangeAppleAuthorizationCode, revokeAppleRefreshToken, type FetchLike } from '@/lib/auth/apple/rest';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;
const CUSTOM_TIMEOUT_MS = 1234;

const EXCHANGE_INPUT = { clientId: 'com.homegohan.app', clientSecret: 'client-secret-value', code: 'auth-code-value' };
const REVOKE_INPUT = { clientId: 'com.homegohan.app', clientSecret: 'client-secret-value', refreshToken: 'refresh-token-value' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Recorded {
  url: string;
  init: RequestInit;
}

function recordingFetch(respond: () => Response | Promise<Response>): { fetchImpl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fetchImpl, calls };
}

function formOf(call: Recorded): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call.init.body)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exchangeAppleAuthorizationCode', () => {
  it('form (client_id・client_secret・code・grant_type=authorization_code) を /auth/token へ POST し、200 の refresh_token を返す', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(HTTP_OK, { refresh_token: 'rt-1', access_token: 'at-1' }));
    const result = await exchangeAppleAuthorizationCode(EXCHANGE_INPUT, fetchImpl);

    expect(result).toEqual({ ok: true, refreshToken: 'rt-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(APPLE_TOKEN_ENDPOINT);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(formOf(calls[0])).toEqual({
      client_id: EXCHANGE_INPUT.clientId,
      client_secret: EXCHANGE_INPUT.clientSecret,
      code: EXCHANGE_INPUT.code,
      grant_type: 'authorization_code',
    });
  });

  it('redirect_uri を送らない (ネイティブの認可コードは redirect_uri を渡さない)', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(HTTP_OK, { refresh_token: 'rt-1' }));
    await exchangeAppleAuthorizationCode(EXCHANGE_INPUT, fetchImpl);
    expect(Object.keys(formOf(calls[0]))).not.toContain('redirect_uri');
  });

  it('400 invalid_grant は invalid_code', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(HTTP_BAD_REQUEST, { error: 'invalid_grant', error_description: 'secret description' }));
    const result = await exchangeAppleAuthorizationCode(EXCHANGE_INPUT, fetchImpl);
    expect(result).toEqual({ ok: false, reason: 'invalid_code', status: HTTP_BAD_REQUEST, error: 'invalid_grant' });
  });

  it('ほかの 4xx・5xx・壊れた本文・例外 (時間切れ) は unavailable (error_description は結果に入れない)', async () => {
    const cases: Array<[string, () => Response | Promise<Response>, unknown]> = [
      ['400 invalid_client', () => jsonResponse(HTTP_BAD_REQUEST, { error: 'invalid_client', error_description: 'DESCRIPTION_SECRET' }), { status: HTTP_BAD_REQUEST, error: 'invalid_client' }],
      ['401', () => jsonResponse(HTTP_UNAUTHORIZED, { error: 'invalid_client' }), { status: HTTP_UNAUTHORIZED, error: 'invalid_client' }],
      ['503', () => jsonResponse(HTTP_SERVICE_UNAVAILABLE, {}), { status: HTTP_SERVICE_UNAVAILABLE, error: null }],
      ['200 だが refresh_token が無い', () => jsonResponse(HTTP_OK, { access_token: 'a' }), { status: HTTP_OK, error: null }],
      ['200 だが本文が JSON でない', () => new Response('<html>', { status: HTTP_OK }), { status: HTTP_OK, error: null }],
      [
        '例外 (時間切れ)',
        () => {
          throw new DOMException('timeout', 'TimeoutError');
        },
        { status: null, error: null },
      ],
    ];
    for (const [label, respond, expected] of cases) {
      const { fetchImpl } = recordingFetch(respond);
      const result = await exchangeAppleAuthorizationCode(EXCHANGE_INPUT, fetchImpl);
      expect(result, label).toEqual({ ok: false, reason: 'unavailable', ...(expected as object) });
      expect(JSON.stringify(result), label).not.toContain('DESCRIPTION_SECRET');
    }
  });

  it('AbortSignal.timeout(APPLE_API_TIMEOUT_MS) を付ける', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(HTTP_OK, { refresh_token: 'rt' }));
    await exchangeAppleAuthorizationCode(EXCHANGE_INPUT, fetchImpl);
    expect(timeoutSpy).toHaveBeenCalledWith(APPLE_API_TIMEOUT_MS);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('revokeAppleRefreshToken', () => {
  it('token_type_hint=refresh_token で /auth/revoke へ POST。200 は ok', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response('', { status: HTTP_OK }));
    const result = await revokeAppleRefreshToken(REVOKE_INPUT, fetchImpl);

    expect(result).toEqual({ ok: true });
    expect(calls[0].url).toBe(APPLE_REVOKE_ENDPOINT);
    expect(calls[0].init.method).toBe('POST');
    expect(formOf(calls[0])).toEqual({
      client_id: REVOKE_INPUT.clientId,
      client_secret: REVOKE_INPUT.clientSecret,
      token: REVOKE_INPUT.refreshToken,
      token_type_hint: 'refresh_token',
    });
  });

  it('失敗は status と error (error_description は入れない)。例外は status null / error null', async () => {
    const withBody = recordingFetch(() => jsonResponse(HTTP_BAD_REQUEST, { error: 'invalid_request', error_description: 'DESCRIPTION_SECRET' }));
    const failed = await revokeAppleRefreshToken(REVOKE_INPUT, withBody.fetchImpl);
    expect(failed).toEqual({ ok: false, status: HTTP_BAD_REQUEST, error: 'invalid_request' });
    expect(JSON.stringify(failed)).not.toContain('DESCRIPTION_SECRET');

    const noBody = recordingFetch(() => new Response('', { status: HTTP_SERVICE_UNAVAILABLE }));
    expect(await revokeAppleRefreshToken(REVOKE_INPUT, noBody.fetchImpl)).toEqual({ ok: false, status: HTTP_SERVICE_UNAVAILABLE, error: null });

    const thrown = recordingFetch(() => {
      throw new Error('network down');
    });
    expect(await revokeAppleRefreshToken(REVOKE_INPUT, thrown.fetchImpl)).toEqual({ ok: false, status: null, error: null });
  });

  it('timeoutMs を渡さない revoke は AbortSignal.timeout(APPLE_API_TIMEOUT_MS) を付ける', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { fetchImpl } = recordingFetch(() => new Response('', { status: HTTP_OK }));
    await revokeAppleRefreshToken(REVOKE_INPUT, fetchImpl);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(APPLE_API_TIMEOUT_MS);
  });

  it('revoke に timeoutMs を渡すと AbortSignal.timeout(timeoutMs) を付ける', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { fetchImpl } = recordingFetch(() => new Response('', { status: HTTP_OK }));
    await revokeAppleRefreshToken({ ...REVOKE_INPUT, timeoutMs: CUSTOM_TIMEOUT_MS }, fetchImpl);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(CUSTOM_TIMEOUT_MS);
  });
});
