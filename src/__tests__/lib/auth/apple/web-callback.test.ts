// @vitest-environment node
/**
 * Web の OAuth のコールバックでの Apple の refresh token の保管と、?error= の固定の文
 * (docs/design/mobile/08-sign-in-with-apple.md §9.5・§11.6・§14.2)。
 */
import type { Session, User } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSupabaseAdmin: vi.fn(),
  storeAppleRefreshToken: vi.fn(),
  readAppleSignInServerConfig: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/auth/apple/tokens', () => ({ storeAppleRefreshToken: mocks.storeAppleRefreshToken }));
vi.mock('@/lib/auth/apple/config', () => ({ readAppleSignInServerConfig: mocks.readAppleSignInServerConfig }));

const {
  APPLE_CALLBACK_PROVIDER,
  APPLE_WEB_CALLBACK_ERROR_MESSAGE,
  appleCallbackErrorMessage,
  storeAppleRefreshTokenFromWebCallback,
} = await import('@/lib/auth/apple/web-callback');

const SERVICES_ID = 'com.homegohan.app.web';
const REQUEST_ID = 'req_test';
const ADMIN = { from: vi.fn() };

function userWith(providers: string[]): User {
  return { id: 'user-1', identities: providers.map((provider) => ({ provider })) } as unknown as User;
}
function sessionWith(providerRefreshToken: string | null | undefined): Session {
  return { access_token: 'a', refresh_token: 'r', provider_refresh_token: providerRefreshToken } as unknown as Session;
}
function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSupabaseAdmin.mockReturnValue(ADMIN);
  mocks.storeAppleRefreshToken.mockResolvedValue(undefined);
  mocks.readAppleSignInServerConfig.mockReturnValue({ teamId: 't', keyId: 'k', privateKeyPem: 'p', servicesId: SERVICES_ID });
});

describe('storeAppleRefreshTokenFromWebCallback', () => {
  it('provider が apple でなければ skipped (何も読まない)', async () => {
    const log = makeLog();
    for (const provider of [null, 'google', '']) {
      const result = await storeAppleRefreshTokenFromWebCallback({
        provider,
        user: userWith(['apple']),
        session: sessionWith('rt'),
        log,
        requestId: REQUEST_ID,
      });
      expect(result).toBe('skipped');
    }
    expect(mocks.readAppleSignInServerConfig).not.toHaveBeenCalled();
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.storeAppleRefreshToken).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('user が無い・identities に apple が無ければ skipped', async () => {
    const log = makeLog();
    expect(
      await storeAppleRefreshTokenFromWebCallback({ provider: 'apple', user: null, session: sessionWith('rt'), log, requestId: REQUEST_ID }),
    ).toBe('skipped');
    expect(
      await storeAppleRefreshTokenFromWebCallback({
        provider: 'apple',
        user: userWith(['google', 'email']),
        session: sessionWith('rt'),
        log,
        requestId: REQUEST_ID,
      }),
    ).toBe('skipped');
    expect(mocks.storeAppleRefreshToken).not.toHaveBeenCalled();
  });

  it('provider_refresh_token が無ければ info で skipped (token は保管もログにも出さない)', async () => {
    for (const token of [null, undefined, '']) {
      const log = makeLog();
      const result = await storeAppleRefreshTokenFromWebCallback({
        provider: 'apple',
        user: userWith(['apple']),
        session: sessionWith(token),
        log,
        requestId: REQUEST_ID,
      });
      expect(result).toBe('skipped');
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info.mock.calls[0][1]).toEqual({ request_id: REQUEST_ID });
    }
    const log = makeLog();
    expect(
      await storeAppleRefreshTokenFromWebCallback({ provider: 'apple', user: userWith(['apple']), session: null, log, requestId: REQUEST_ID }),
    ).toBe('skipped');
    expect(mocks.storeAppleRefreshToken).not.toHaveBeenCalled();
  });

  it('Services ID が無ければ skipped (設定そのものが無いときも)', async () => {
    for (const config of [{ teamId: 't', keyId: 'k', privateKeyPem: 'p', servicesId: null }, null]) {
      mocks.readAppleSignInServerConfig.mockReturnValue(config);
      const log = makeLog();
      const result = await storeAppleRefreshTokenFromWebCallback({
        provider: 'apple',
        user: userWith(['apple']),
        session: sessionWith('rt'),
        log,
        requestId: REQUEST_ID,
      });
      expect(result).toBe('skipped');
      expect(log.info).toHaveBeenCalledTimes(1);
    }
    expect(mocks.storeAppleRefreshToken).not.toHaveBeenCalled();
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('そろえば Services ID の行として store', async () => {
    const log = makeLog();
    const result = await storeAppleRefreshTokenFromWebCallback({
      provider: 'apple',
      user: userWith(['email', 'apple']),
      session: sessionWith('rt-web'),
      log,
      requestId: REQUEST_ID,
    });
    expect(result).toBe('stored');
    expect(mocks.storeAppleRefreshToken).toHaveBeenCalledTimes(1);
    expect(mocks.storeAppleRefreshToken).toHaveBeenCalledWith(ADMIN, { userId: 'user-1', clientId: SERVICES_ID, refreshToken: 'rt-web' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('store の失敗は warn で skipped (投げない・token をログに出さない)', async () => {
    mocks.storeAppleRefreshToken.mockRejectedValue(new Error('relation "apple_sign_in_tokens" does not exist rt-secret'));
    const log = makeLog();
    const result = await storeAppleRefreshTokenFromWebCallback({
      provider: 'apple',
      user: userWith(['apple']),
      session: sessionWith('rt-secret'),
      log,
      requestId: REQUEST_ID,
    });
    expect(result).toBe('skipped');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('rt-secret');
    expect(log.warn.mock.calls[0][1]).toEqual({ request_id: REQUEST_ID, error_name: 'Error' });
  });

  it('getSupabaseAdmin が投げても投げない (warn で skipped)', async () => {
    mocks.getSupabaseAdmin.mockImplementation(() => {
      throw 'not an Error';
    });
    const log = makeLog();
    const result = await storeAppleRefreshTokenFromWebCallback({
      provider: 'apple',
      user: userWith(['apple']),
      session: sessionWith('rt'),
      log,
      requestId: REQUEST_ID,
    });
    expect(result).toBe('skipped');
    expect(log.warn.mock.calls[0][1]).toEqual({ request_id: REQUEST_ID, error_name: 'unknown' });
  });
});

describe('appleCallbackErrorMessage', () => {
  it("'apple' なら APPLE_WEB_CALLBACK_ERROR_MESSAGE、null・'google'・'' なら null", () => {
    expect(APPLE_CALLBACK_PROVIDER).toBe('apple');
    expect(appleCallbackErrorMessage('apple')).toBe(APPLE_WEB_CALLBACK_ERROR_MESSAGE);
    expect(appleCallbackErrorMessage(null)).toBeNull();
    expect(appleCallbackErrorMessage('google')).toBeNull();
    expect(appleCallbackErrorMessage('')).toBeNull();
  });
});

describe('APPLE_WEB_CALLBACK_ERROR_MESSAGE', () => {
  it('空でなく日本語を含み、英文だけの文ではなく、% を含まない (decodeURIComponent しても同じ文)', () => {
    expect(APPLE_WEB_CALLBACK_ERROR_MESSAGE.length).toBeGreaterThan(0);
    expect(APPLE_WEB_CALLBACK_ERROR_MESSAGE).toMatch(/[぀-ヿ一-鿿]/);
    expect(APPLE_WEB_CALLBACK_ERROR_MESSAGE).not.toMatch(/^[\x00-\x7f]+$/);
    expect(APPLE_WEB_CALLBACK_ERROR_MESSAGE).not.toContain('%');
    expect(decodeURIComponent(APPLE_WEB_CALLBACK_ERROR_MESSAGE)).toBe(APPLE_WEB_CALLBACK_ERROR_MESSAGE);
    expect(APPLE_WEB_CALLBACK_ERROR_MESSAGE).toBe('Apple でのログインを完了できませんでした。もう一度お試しください。');
  });
});
