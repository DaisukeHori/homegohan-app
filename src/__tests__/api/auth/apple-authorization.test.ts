// @vitest-environment node
/**
 * POST /api/auth/apple/authorization の route テスト (docs/design/mobile/08-sign-in-with-apple.md §9.2・§11.4・§12.2)
 *
 * 本物の Supabase・Apple には繋がない。requireSessionUser・回数制限・registerAppleAuthorization は差し替え、
 * 最後の it だけ registerAppleAuthorization・Zod・route を本物のまま通して (global fetch だけ偽物)、認可コードが応答にもログにも出ないことを確かめる。
 */
import { generateKeyPairSync } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLE_AUTHORIZATION_CODE_MAX_LENGTH } from '@homegohan/shared';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AUTH_CODE = 'authorization-code-value-SECRET';
const REFRESH_TOKEN = 'refresh-token-value-SECRET';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
const NO_STORE = 'private, no-store';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  requireSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  registerAppleAuthorization: vi.fn(),
  logCalls: [] as Array<{ level: string; args: unknown[] }>,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));
vi.mock('@/lib/auth/sessions/session-claims', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/sessions/session-claims')>('@/lib/auth/sessions/session-claims');
  return { ...actual, requireSessionUser: mocks.requireSessionUser };
});
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit');
  return { ...actual, checkRateLimit: mocks.checkRateLimit };
});
vi.mock('@/lib/auth/apple/authorization', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/apple/authorization')>('@/lib/auth/apple/authorization');
  return { ...actual, registerAppleAuthorization: mocks.registerAppleAuthorization };
});
vi.mock('@/lib/db-logger', () => {
  const make = () => {
    const record = (level: string) => (...args: unknown[]) => {
      mocks.logCalls.push({ level, args });
    };
    return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  };
  return {
    createLogger: () => ({ ...make(), withUser: () => make() }),
    generateRequestId: () => 'req_apple_test',
  };
});

import { POST } from '@/app/api/auth/apple/authorization/route';

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/auth/apple/authorization', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer access.token', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const validRequest = () => makeRequest({ authorization_code: AUTH_CODE });

const userWithApple = { id: USER_ID, identities: [{ provider: 'apple' }] };
const userWithoutApple = { id: USER_ID, identities: [{ provider: 'email' }] };

/** 通常の経路: 認証 OK・回数制限 OK・Apple の identity あり */
function arrangeAuthenticated(user: unknown = userWithApple): void {
  mocks.createClient.mockResolvedValue({ marker: 'supabase' });
  mocks.requireSessionUser.mockResolvedValue({ user, session: {}, roles: [] });
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.getSupabaseAdmin.mockReturnValue({ marker: 'admin' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/auth/apple/authorization', () => {
  it('本文の形が違えば 400 VALIDATION_ERROR (Supabase を作らない)', async () => {
    for (const body of [{}, { authorization_code: '' }, { authorization_code: 123 }, 'not json']) {
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect(await res.json()).toEqual({ error: '入力の形が正しくありません。', code: 'VALIDATION_ERROR' });
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.registerAppleAuthorization).not.toHaveBeenCalled();
  });

  it('本文に NULL 文字があれば 400 INVALID_CHARACTER (Supabase を作らない)', async () => {
    const res = await POST(makeRequest(`{"authorization_code":"abc${String.fromCharCode(0)}def"}`));
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect((await res.json()).code).toBe('INVALID_CHARACTER');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('認可コードが APPLE_AUTHORIZATION_CODE_MAX_LENGTH + 1 文字 (1,025 文字) は 400。ちょうど上限の長さは先へ進む', async () => {
    arrangeAuthenticated();
    mocks.registerAppleAuthorization.mockResolvedValue({ status: 'stored' });

    const tooLong = await POST(makeRequest({ authorization_code: 'a'.repeat(APPLE_AUTHORIZATION_CODE_MAX_LENGTH + 1) }));
    expect(tooLong.status).toBe(HTTP_BAD_REQUEST);
    expect((await tooLong.json()).code).toBe('VALIDATION_ERROR');
    expect(mocks.createClient).not.toHaveBeenCalled();

    const exact = await POST(makeRequest({ authorization_code: 'a'.repeat(APPLE_AUTHORIZATION_CODE_MAX_LENGTH) }));
    expect(exact.status).toBe(HTTP_OK);
  });

  it('未認証は 401 (AuthError の code をそのまま出し、文は固定)', async () => {
    mocks.createClient.mockResolvedValue({});
    mocks.requireSessionUser.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await POST(validRequest());
    expect(res.status).toBe(HTTP_UNAUTHORIZED);
    const body = await res.json();
    expect(body.code).toBe('AUTH_UNAUTHENTICATED');
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    expect(mocks.registerAppleAuthorization).not.toHaveBeenCalled();
  });

  it('凍結は 403 AUTH_ACCOUNT_FROZEN', async () => {
    mocks.createClient.mockResolvedValue({});
    mocks.requireSessionUser.mockRejectedValue(new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'frozen'));
    const res = await POST(validRequest());
    expect(res.status).toBe(HTTP_FORBIDDEN);
    expect((await res.json()).code).toBe('AUTH_ACCOUNT_FROZEN');
    expect(mocks.registerAppleAuthorization).not.toHaveBeenCalled();
  });

  it('レート制限は 429 RATE_LIMITED (キーは利用者 ID・種類は auth-apple-authorization。Apple を呼ばない)', async () => {
    arrangeAuthenticated();
    mocks.checkRateLimit.mockResolvedValue({ success: false, reset: Date.now() + 60_000 });
    const res = await POST(validRequest());
    expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
    expect((await res.json()).code).toBe('RATE_LIMITED');
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(USER_ID, 'auth-apple-authorization');
    expect(mocks.registerAppleAuthorization).not.toHaveBeenCalled();
  });

  it('apple の identity が無ければ 409 APPLE_IDENTITY_NOT_LINKED (Apple を呼ばない)', async () => {
    arrangeAuthenticated(userWithoutApple);
    const res = await POST(validRequest());
    expect(res.status).toBe(HTTP_CONFLICT);
    expect(await res.json()).toEqual({ error: 'このアカウントは Apple でログインしていません。', code: 'APPLE_IDENTITY_NOT_LINKED' });
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    expect(mocks.registerAppleAuthorization).not.toHaveBeenCalled();
  });

  it('not_configured は 200 { stored: false, reason } (info のログ。warn・error は出さない)', async () => {
    arrangeAuthenticated();
    mocks.registerAppleAuthorization.mockResolvedValue({ status: 'not_configured' });
    const res = await POST(validRequest());
    expect(res.status).toBe(HTTP_OK);
    expect(await res.json()).toEqual({ stored: false, reason: 'not_configured' });
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    expect(mocks.logCalls.map((call) => call.level)).toEqual(['info']);
  });

  it('invalid_code は 400 APPLE_AUTHORIZATION_CODE_INVALID (warn に Apple の status と error)', async () => {
    arrangeAuthenticated();
    mocks.registerAppleAuthorization.mockResolvedValue({ status: 'invalid_code', appleStatus: HTTP_BAD_REQUEST, appleError: 'invalid_grant' });
    const res = await POST(validRequest());
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(await res.json()).toEqual({
      error: 'Apple の認可の情報が有効ではありません。もう一度ログインしてください。',
      code: 'APPLE_AUTHORIZATION_CODE_INVALID',
    });
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    const warn = mocks.logCalls.find((call) => call.level === 'warn');
    expect(warn?.args[1]).toMatchObject({ apple_status: HTTP_BAD_REQUEST, apple_error: 'invalid_grant' });
  });

  it.each([
    ['unavailable', { status: 'unavailable', appleStatus: HTTP_SERVICE_UNAVAILABLE, appleError: null }, 'exchange'],
    ['secret_failed', { status: 'secret_failed', error: new Error('PEM_BODY_SECRET unreadable') }, 'client_secret'],
    ['store_failed', { status: 'store_failed', error: { message: 'relation does not exist', code: '42P01' } }, 'store'],
  ])('%s は 500 (本文は固定の文。ログに step %s)', async (_name, result, step) => {
    arrangeAuthenticated();
    mocks.registerAppleAuthorization.mockResolvedValue(result);
    const res = await POST(validRequest());
    expect(res.status).toBe(HTTP_INTERNAL_ERROR);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(text).not.toContain('PEM_BODY_SECRET');
    expect(text).not.toContain('42P01');
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    const logged = mocks.logCalls.find((call) => call.level === 'error');
    expect(logged?.args[2]).toMatchObject({ step });
  });

  it('stored は 200 { stored: true }。registerAppleAuthorization には service_role の client・利用者 ID・認可コードを渡す', async () => {
    arrangeAuthenticated();
    mocks.registerAppleAuthorization.mockResolvedValue({ status: 'stored' });
    const res = await POST(validRequest());
    expect(res.status).toBe(HTTP_OK);
    expect(await res.json()).toEqual({ stored: true });
    expect(mocks.registerAppleAuthorization).toHaveBeenCalledWith({
      admin: { marker: 'admin' },
      userId: USER_ID,
      authorizationCode: AUTH_CODE,
    });
  });

  it('Cache-Control: private, no-store (200)', async () => {
    arrangeAuthenticated();
    mocks.registerAppleAuthorization.mockResolvedValue({ status: 'stored' });
    const res = await POST(validRequest());
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
  });

  it('認可コードと refresh token が応答にもログにも出ない (registerAppleAuthorization・Zod・route は本物。global fetch だけ偽物)', async () => {
    const actual = await vi.importActual<typeof import('@/lib/auth/apple/authorization')>('@/lib/auth/apple/authorization');
    mocks.registerAppleAuthorization.mockImplementation(actual.registerAppleAuthorization);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    vi.stubEnv('APPLE_SIGN_IN_TEAM_ID', 'TEAMID1234');
    vi.stubEnv('APPLE_SIGN_IN_KEY_ID', 'KEYID12345');
    vi.stubEnv('APPLE_SIGN_IN_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim().replace(/\n/g, '\\n'));
    const upsert = vi.fn(async () => ({ error: null }));
    arrangeAuthenticated();
    mocks.getSupabaseAdmin.mockReturnValue({ from: () => ({ upsert }) });
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ refresh_token: REFRESH_TOKEN }), { status: HTTP_OK, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const res = await POST(validRequest());
    const text = await res.text();

    expect(res.status).toBe(HTTP_OK);
    expect(JSON.parse(text)).toEqual({ stored: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(text).not.toContain(AUTH_CODE);
    expect(text).not.toContain(REFRESH_TOKEN);
    const logged = JSON.stringify(mocks.logCalls);
    expect(logged).not.toContain(AUTH_CODE);
    expect(logged).not.toContain(REFRESH_TOKEN);
  });
});
