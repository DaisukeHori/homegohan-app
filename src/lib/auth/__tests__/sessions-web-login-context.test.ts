/**
 * src/lib/auth/sessions/web-login-context.ts (recordWebLoginContextFromRequest) の単体テスト
 * (#1190。設計 docs/design/cross/16-auth-history-sessions.md §13.5・§13.6・§20.1)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetSupabaseAdmin, mockRecordWebLoginContext, mockWarn, mockCreateLogger, ADMIN_CLIENT } = vi.hoisted(() => {
  const ADMIN_CLIENT = { name: 'service-role-client' };
  const mockWarn = vi.fn();
  return {
    ADMIN_CLIENT,
    mockGetSupabaseAdmin: vi.fn(() => ADMIN_CLIENT),
    mockRecordWebLoginContext: vi.fn(async () => true),
    mockWarn,
    mockCreateLogger: vi.fn(() => ({ warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  };
});

vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: mockGetSupabaseAdmin }));
vi.mock('@/lib/db-logger', () => ({ createLogger: mockCreateLogger }));
vi.mock('@/lib/auth/sessions/store', () => ({ recordWebLoginContext: mockRecordWebLoginContext }));

import { recordWebLoginContextFromRequest } from '@/lib/auth/sessions/web-login-context';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ACCESS_TOKEN = 'secret.access.token';
const CLIENT_IP = '203.0.113.10';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36';
const SECRET_ERROR_TEXT = 'duplicate key value violates "user_sessions_metadata_pkey" 203.0.113.10';

function makeAuth(options: { claimsError?: boolean; throws?: Error } = {}) {
  return {
    getSession: vi.fn(async () => ({ data: { session: null } })),
    getClaims: vi.fn(async (_jwt?: string) => {
      if (options.throws) throw options.throws;
      return options.claimsError
        ? { data: null, error: { message: 'invalid jwt' } }
        : { data: { claims: { sub: USER_ID, session_id: SESSION_ID } }, error: null };
    }),
  };
}
const HEADERS = new Headers({ 'x-forwarded-for': `${CLIENT_IP}, 10.0.0.1`, 'user-agent': USER_AGENT, 'x-vercel-ip-country': 'JP' });
const SESSION = { access_token: ACCESS_TOKEN };

beforeEach(() => {
  mockGetSupabaseAdmin.mockReset().mockReturnValue(ADMIN_CLIENT);
  mockRecordWebLoginContext.mockReset().mockResolvedValue(true);
  mockWarn.mockReset();
  mockCreateLogger.mockClear();
});

describe('recordWebLoginContextFromRequest', () => {
  it('session が null・undefined なら getClaims も getSupabaseAdmin も recordWebLoginContext も呼ばず、warn も出さない', async () => {
    for (const session of [null, undefined]) {
      const auth = makeAuth();
      await recordWebLoginContextFromRequest(auth, HEADERS, session);
      expect(auth.getClaims).not.toHaveBeenCalled();
    }
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockRecordWebLoginContext).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('getClaims の sub / session_id と extractClientIp(headers)・user-agent・countryCodeOf(headers) で、getSupabaseAdmin() の client を渡して recordWebLoginContext を 1 回呼ぶ', async () => {
    const auth = makeAuth();
    await recordWebLoginContextFromRequest(auth, HEADERS, SESSION);
    expect(auth.getClaims).toHaveBeenCalledWith(ACCESS_TOKEN);
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(mockRecordWebLoginContext).toHaveBeenCalledTimes(1);
    expect(mockRecordWebLoginContext).toHaveBeenCalledWith(ADMIN_CLIENT, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      ipAddress: CLIENT_IP,
      userAgent: USER_AGENT,
      countryCode: 'JP',
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('readSessionAuth が null (getClaims が error) なら recordWebLoginContext を呼ばず、warn を stage claims で 1 回出す', async () => {
    await recordWebLoginContextFromRequest(makeAuth({ claimsError: true }), HEADERS, SESSION);
    expect(mockRecordWebLoginContext).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), { stage: 'claims' });
  });

  it('recordWebLoginContext が false なら warn を stage record で 1 回出す', async () => {
    mockRecordWebLoginContext.mockResolvedValue(false);
    await recordWebLoginContextFromRequest(makeAuth(), HEADERS, SESSION);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), { stage: 'record' });
  });

  it('getClaims・getSupabaseAdmin・recordWebLoginContext が投げても reject せず、warn を stage exception で 1 回出す', async () => {
    const failure = new Error(SECRET_ERROR_TEXT);
    await expect(recordWebLoginContextFromRequest(makeAuth({ throws: failure }), HEADERS, SESSION)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenLastCalledWith(expect.any(String), { stage: 'exception', error_name: 'Error' });

    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new TypeError(SECRET_ERROR_TEXT);
    });
    await expect(recordWebLoginContextFromRequest(makeAuth(), HEADERS, SESSION)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenLastCalledWith(expect.any(String), { stage: 'exception', error_name: 'TypeError' });

    mockGetSupabaseAdmin.mockReturnValue(ADMIN_CLIENT);
    mockRecordWebLoginContext.mockRejectedValue('not an error object');
    await expect(recordWebLoginContextFromRequest(makeAuth(), HEADERS, SESSION)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenLastCalledWith(expect.any(String), { stage: 'exception', error_name: 'string' });
    // 1 回の呼び出しで warn は 1 回だけ
    expect(mockWarn).toHaveBeenCalledTimes(3);
  });

  it('warn の metadata は stage (と error_name) だけで、token・IP・UA・利用者 ID・session_id・error の message を含まない', async () => {
    await recordWebLoginContextFromRequest(makeAuth({ claimsError: true }), HEADERS, SESSION);
    mockRecordWebLoginContext.mockResolvedValue(false);
    await recordWebLoginContextFromRequest(makeAuth(), HEADERS, SESSION);
    await recordWebLoginContextFromRequest(makeAuth({ throws: new Error(SECRET_ERROR_TEXT) }), HEADERS, SESSION);
    expect(mockWarn).toHaveBeenCalledTimes(3);
    for (const [message, metadata] of mockWarn.mock.calls) {
      expect(Object.keys(metadata as Record<string, unknown>).every((key) => key === 'stage' || key === 'error_name')).toBe(true);
      const text = `${String(message)} ${JSON.stringify(metadata)}`;
      for (const secret of [ACCESS_TOKEN, CLIENT_IP, USER_AGENT, USER_ID, SESSION_ID, SECRET_ERROR_TEXT, 'duplicate key']) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
