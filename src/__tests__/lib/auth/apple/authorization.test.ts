// @vitest-environment node
/**
 * route の本体 (registerAppleAuthorization・hasAppleIdentity。docs/design/mobile/08-sign-in-with-apple.md §11.4)
 * Apple には繋がない (fetch は引数)、表は from の偽物。鍵はテストの中で作った P-256 の使い捨て。
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 環境変数が無いときの警告 (src/lib/env.ts) を DB に書かせない
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { hasAppleIdentity, registerAppleAuthorization } from '@/lib/auth/apple/authorization';
import { APPLE_SIGN_IN_NATIVE_CLIENT_ID, APPLE_TOKEN_ENDPOINT } from '@/lib/auth/apple/config';
import type { FetchLike } from '@/lib/auth/apple/rest';
import type { AppleTokenStore } from '@/lib/auth/apple/tokens';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MS_PER_SECOND = 1000;
const USER = '11111111-1111-4111-8111-111111111111';
const AUTH_CODE = 'auth-code-value-SECRET';
const TEAM_ID = 'TEAMID1234';
const KEY_ID = 'KEYID12345';
const FIXED_NOW = new Date('2026-10-24T01:02:03.000Z');

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM_ONE_LINE = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim().replace(/\n/g, '\\n');

function stubConfig(pem: string = PEM_ONE_LINE): void {
  vi.stubEnv('APPLE_SIGN_IN_TEAM_ID', TEAM_ID);
  vi.stubEnv('APPLE_SIGN_IN_KEY_ID', KEY_ID);
  vi.stubEnv('APPLE_SIGN_IN_PRIVATE_KEY', pem);
}

function makeStore(upsertResult: { error: unknown } = { error: null }) {
  const upsert = vi.fn(async () => upsertResult);
  const store = { from: vi.fn(() => ({ upsert })) } as unknown as AppleTokenStore;
  return { store, upsert };
}

function makeFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(String(init.body))) });
    return respond();
  };
  return { fetchImpl, calls };
}

const okExchange = () =>
  new Response(JSON.stringify({ refresh_token: 'rt-new-SECRET' }), { status: HTTP_OK, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  stubConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function run(input: { store: AppleTokenStore; fetchImpl: FetchLike }) {
  return registerAppleAuthorization({
    admin: input.store,
    userId: USER,
    authorizationCode: AUTH_CODE,
    now: () => FIXED_NOW,
    fetchImpl: input.fetchImpl,
  });
}

describe('registerAppleAuthorization', () => {
  it('not_configured なら Apple を呼ばない (表にも書かない)', async () => {
    vi.stubEnv('APPLE_SIGN_IN_TEAM_ID', '');
    const { store, upsert } = makeStore();
    const { fetchImpl, calls } = makeFetch(okExchange);

    expect(await run({ store, fetchImpl })).toEqual({ status: 'not_configured' });
    expect(calls).toHaveLength(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('secret の sub と client_id は bundle ID。code は認可コード。iat は now の秒', async () => {
    const { store } = makeStore();
    const { fetchImpl, calls } = makeFetch(okExchange);
    await run({ store, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(APPLE_TOKEN_ENDPOINT);
    expect(calls[0].body.client_id).toBe(APPLE_SIGN_IN_NATIVE_CLIENT_ID);
    expect(calls[0].body.code).toBe(AUTH_CODE);
    expect(calls[0].body.grant_type).toBe('authorization_code');
    const claims = JSON.parse(Buffer.from(calls[0].body.client_secret.split('.')[1], 'base64url').toString('utf8')) as {
      sub: string;
      iss: string;
      iat: number;
    };
    expect(claims.sub).toBe(APPLE_SIGN_IN_NATIVE_CLIENT_ID);
    expect(claims.iss).toBe(TEAM_ID);
    expect(claims.iat).toBe(Math.floor(FIXED_NOW.getTime() / MS_PER_SECOND));
  });

  it('invalid_code → status invalid_code (Apple の status と error を持つ。表に書かない)', async () => {
    const { store, upsert } = makeStore();
    const { fetchImpl } = makeFetch(
      () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: HTTP_BAD_REQUEST, headers: { 'content-type': 'application/json' } }),
    );
    expect(await run({ store, fetchImpl })).toEqual({ status: 'invalid_code', appleStatus: HTTP_BAD_REQUEST, appleError: 'invalid_grant' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('unavailable → unavailable (5xx も例外も。表に書かない)', async () => {
    const { store, upsert } = makeStore();
    const serverError = makeFetch(() => new Response('', { status: HTTP_SERVICE_UNAVAILABLE }));
    expect(await run({ store, fetchImpl: serverError.fetchImpl })).toEqual({ status: 'unavailable', appleStatus: HTTP_SERVICE_UNAVAILABLE, appleError: null });

    const thrown = makeFetch(() => {
      throw new Error('network down');
    });
    expect(await run({ store, fetchImpl: thrown.fetchImpl })).toEqual({ status: 'unavailable', appleStatus: null, appleError: null });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('store の失敗 → store_failed (error を持つ。投げない)', async () => {
    const failure = { message: 'relation does not exist', code: '42P01' };
    const { store } = makeStore({ error: failure });
    const { fetchImpl } = makeFetch(okExchange);
    const result = await run({ store, fetchImpl });
    expect(result).toEqual({ status: 'store_failed', error: failure });
  });

  it('秘密鍵が壊れていれば secret_failed (投げない・Apple を呼ばない・表に書かない)', async () => {
    stubConfig('broken-pem-SECRET_PEM_BODY');
    const { store, upsert } = makeStore();
    const { fetchImpl, calls } = makeFetch(okExchange);

    const result = await run({ store, fetchImpl });

    expect(result.status).toBe('secret_failed');
    expect(calls).toHaveLength(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('成功 → stored (upsert の行は user_id・bundle ID・refresh_token・updated_at)', async () => {
    const { store, upsert } = makeStore();
    const { fetchImpl } = makeFetch(okExchange);

    expect(await run({ store, fetchImpl })).toEqual({ status: 'stored' });
    expect(upsert).toHaveBeenCalledWith(
      { user_id: USER, client_id: APPLE_SIGN_IN_NATIVE_CLIENT_ID, refresh_token: 'rt-new-SECRET', updated_at: FIXED_NOW.toISOString() },
      { onConflict: 'user_id,client_id' },
    );
  });
});

describe('hasAppleIdentity', () => {
  it('provider apple があれば true。無い・identities が無い・null なら false', () => {
    expect(hasAppleIdentity({ identities: [{ provider: 'email' }, { provider: 'apple' }] } as never)).toBe(true);
    expect(hasAppleIdentity({ identities: [{ provider: 'google' }] } as never)).toBe(false);
    expect(hasAppleIdentity({ identities: [] } as never)).toBe(false);
    expect(hasAppleIdentity({ identities: undefined } as never)).toBe(false);
  });
});
