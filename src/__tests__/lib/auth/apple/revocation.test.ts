// @vitest-environment node
/**
 * 退会の段階 apple_revoke (createAccountDeletionAppleRevocation。docs/design/mobile/08-sign-in-with-apple.md §9.3・§11.4)
 * Apple には繋がない (fetch は引数)、表は from の偽物、時計は偽物。鍵はテストの中で作った P-256 の使い捨て。
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 環境変数が無いときの警告 (src/lib/env.ts) を DB に書かせない
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  APPLE_API_TIMEOUT_MS,
  APPLE_REVOKE_ATTEMPTS,
  APPLE_REVOKE_ENDPOINT,
  APPLE_REVOKE_TOTAL_BUDGET_MS,
} from '@/lib/auth/apple/config';
import type { FetchLike } from '@/lib/auth/apple/rest';
import { createAccountDeletionAppleRevocation, type AppleRevocationLogger } from '@/lib/auth/apple/revocation';
import type { AppleTokenStore } from '@/lib/auth/apple/tokens';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MS_PER_SECOND = 1000;
const LONG_BUDGET_MS = 10_000;
const USER = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = 'req_apple_1';
const NATIVE = 'com.homegohan.app';
const SERVICES = 'com.homegohan.web';
const TEAM_ID = 'TEAMID1234';
const KEY_ID = 'KEYID12345';
const START = new Date('2026-10-24T01:00:00.000Z');

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM_ONE_LINE = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim().replace(/\n/g, '\\n');

function stubConfig(pem: string = PEM_ONE_LINE): void {
  vi.stubEnv('APPLE_SIGN_IN_TEAM_ID', TEAM_ID);
  vi.stubEnv('APPLE_SIGN_IN_KEY_ID', KEY_ID);
  vi.stubEnv('APPLE_SIGN_IN_PRIVATE_KEY', pem);
}

type Row = { client_id: string; refresh_token: string };

function makeAdmin(result: { data: Row[] | null; error: unknown }) {
  const eq = vi.fn(async () => result);
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { admin: { from } as unknown as AppleTokenStore, from, eq };
}

function makeLog() {
  const warn = vi.fn();
  const info = vi.fn();
  const log: AppleRevocationLogger = { warn, info };
  return { log, warn, info };
}

/** 偽の時計。fetch の中でだけ進める (now は呼ぶたびに同じ値を返す) */
function makeClock() {
  let offsetMs = 0;
  return {
    now: () => new Date(START.getTime() + offsetMs),
    advance: (ms: number) => {
      offsetMs += ms;
    },
  };
}

interface FetchCall {
  url: string;
  body: Record<string, string>;
}

function makeFetch(respond: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, body: Object.fromEntries(new URLSearchParams(String(init.body))) };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

const ok = () => new Response('', { status: HTTP_OK });
const unavailable = () => new Response('', { status: HTTP_SERVICE_UNAVAILABLE });

function claimsOf(secret: string): { iss: string; sub: string; iat: number } {
  return JSON.parse(Buffer.from(secret.split('.')[1], 'base64url').toString('utf8')) as { iss: string; sub: string; iat: number };
}

beforeEach(() => {
  stubConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createAccountDeletionAppleRevocation: revokeForAccountDeletion', () => {
  it('行が無ければ Apple を呼ばず tokens 0 (warn も出さない)', async () => {
    const { admin, eq } = makeAdmin({ data: [], error: null });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(ok);

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 0, revoked: 0, failed: 0, skipped: null });
    expect(eq).toHaveBeenCalledWith('user_id', USER);
    expect(calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('秘密が無ければ Apple を呼ばず skipped not_configured と warn (行数つき。token はログに出さない)', async () => {
    vi.stubEnv('APPLE_SIGN_IN_KEY_ID', '');
    const { admin } = makeAdmin({ data: [{ client_id: NATIVE, refresh_token: 'rt-SECRET' }], error: null });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(ok);

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 1, revoked: 0, failed: 0, skipped: 'not_configured' });
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ request_id: REQUEST_ID, step: 'apple_revoke', tokens: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('rt-SECRET');
  });

  it('行ごとに client_id を sub にした secret で revoke する (iOS の bundle ID と Web の Services ID)', async () => {
    const { admin } = makeAdmin({
      data: [
        { client_id: NATIVE, refresh_token: 'rt-native' },
        { client_id: SERVICES, refresh_token: 'rt-web' },
      ],
      error: null,
    });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(ok);

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 2, revoked: 2, failed: 0, skipped: null });
    expect(calls.map((call) => call.url)).toEqual([APPLE_REVOKE_ENDPOINT, APPLE_REVOKE_ENDPOINT]);
    expect(calls.map((call) => [call.body.client_id, call.body.token, call.body.token_type_hint])).toEqual([
      [NATIVE, 'rt-native', 'refresh_token'],
      [SERVICES, 'rt-web', 'refresh_token'],
    ]);
    expect(calls.map((call) => claimsOf(call.body.client_secret).sub)).toEqual([NATIVE, SERVICES]);
    expect(claimsOf(calls[0].body.client_secret)).toMatchObject({ iss: TEAM_ID, iat: Math.floor(START.getTime() / MS_PER_SECOND) });
    expect(warn).not.toHaveBeenCalled();
  });

  it('締め切りの前なら失敗は 2 回まで試し、2 回目も失敗なら failed に数えて warn (attempts 2。投げない)', async () => {
    const { admin } = makeAdmin({ data: [{ client_id: NATIVE, refresh_token: 'rt-1' }], error: null });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(unavailable);

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 1, revoked: 0, failed: 1, skipped: null });
    expect(calls).toHaveLength(APPLE_REVOKE_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      request_id: REQUEST_ID,
      step: 'apple_revoke',
      client_id: NATIVE,
      attempts: APPLE_REVOKE_ATTEMPTS,
      apple_status: HTTP_SERVICE_UNAVAILABLE,
      apple_error: null,
      budget_exhausted: false,
    });
  });

  it('1 回目が失敗しても 2 回目が成功すれば revoked (warn なし)', async () => {
    const { admin } = makeAdmin({ data: [{ client_id: NATIVE, refresh_token: 'rt-1' }], error: null });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch((_call, index) => (index === 0 ? unavailable() : ok()));

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 1, revoked: 1, failed: 0, skipped: null });
    expect(calls).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Apple の 4xx の本文の error は warn の apple_error に載る (error_description は載せない)', async () => {
    const { admin } = makeAdmin({ data: [{ client_id: NATIVE, refresh_token: 'rt-1' }], error: null });
    const { log, warn } = makeLog();
    const { fetchImpl } = makeFetch(
      () =>
        new Response(JSON.stringify({ error: 'invalid_client', error_description: 'DESCRIPTION_SECRET' }), {
          status: HTTP_BAD_REQUEST,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(warn.mock.calls[0][1]).toMatchObject({ apple_status: HTTP_BAD_REQUEST, apple_error: 'invalid_client' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('DESCRIPTION_SECRET');
  });

  it('秘密鍵が壊れていても投げず、行ごとに failed に数えて warn (Apple を呼ばない。PEM を warn に出さない)', async () => {
    stubConfig('broken-pem-SECRET_PEM_BODY');
    const { admin } = makeAdmin({
      data: [
        { client_id: NATIVE, refresh_token: 'rt-native-SECRET' },
        { client_id: SERVICES, refresh_token: 'rt-web-SECRET' },
      ],
      error: null,
    });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(ok);

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 2, revoked: 0, failed: 2, skipped: null });
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call) => (call[1] as { client_id: string }).client_id)).toEqual([NATIVE, SERVICES]);
    expect(warn.mock.calls[0][1]).toMatchObject({ step: 'apple_revoke', error_name: expect.any(String) });
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain('SECRET_PEM_BODY');
    expect(serialized).not.toContain('SECRET');
  });

  it('表の読み取りの失敗は warn して tokens 0 (投げない・Apple を呼ばない)', async () => {
    const { admin } = makeAdmin({ data: null, error: new Error('db down') });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(ok);

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 0, revoked: 0, failed: 0, skipped: null });
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ request_id: REQUEST_ID, step: 'apple_revoke', error_name: 'Error' });
  });

  it.each([
    ['42P01 (migration がまだ当たっていない窓)', { message: 'relation "public.apple_sign_in_tokens" does not exist', code: '42P01' }],
    ['PGRST205 (PostgREST のスキーマキャッシュに表が無い)', { message: "Could not find the table 'public.apple_sign_in_tokens' in the schema cache", code: 'PGRST205' }],
  ])('表がまだ無い (%s) ときも投げず、warn して tokens 0 で退会を止めない', async (_label, error) => {
    const { admin } = makeAdmin({ data: null, error });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(ok);

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 0, revoked: 0, failed: 0, skipped: null });
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ step: 'apple_revoke', request_id: REQUEST_ID });
  });

  it('admin() を作る処理が投げても (表の読み取りの一部として) 投げない', async () => {
    const { log, warn } = makeLog();
    const { fetchImpl } = makeFetch(ok);
    const report = await createAccountDeletionAppleRevocation({
      admin: () => {
        throw new Error('no admin');
      },
      fetchImpl,
      now: () => START,
    }).revokeForAccountDeletion(USER, log, REQUEST_ID);
    expect(report).toEqual({ tokens: 0, revoked: 0, failed: 0, skipped: null });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('予算を超えたら残りの行を呼ばずに failed にして投げない: 2 行・偽の fetch が偽の時計を budgetMs 進めて時間切れ (例外) を返す → fetch は 1 回だけ・2 行目は呼ばない・{ tokens: 2, revoked: 0, failed: 2 }・warn は 1 行目 (attempts 1・budget_exhausted true) と締め切り (not_attempted 1・budget_ms) の 2 つ', async () => {
    const budgetMs = APPLE_REVOKE_TOTAL_BUDGET_MS;
    const clock = makeClock();
    const { admin } = makeAdmin({
      data: [
        { client_id: NATIVE, refresh_token: 'rt-native' },
        { client_id: SERVICES, refresh_token: 'rt-web' },
      ],
      error: null,
    });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(() => {
      clock.advance(budgetMs);
      throw new DOMException('timeout', 'TimeoutError');
    });

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: clock.now, budgetMs }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 2, revoked: 0, failed: 2, skipped: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.client_id).toBe(NATIVE);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][1]).toMatchObject({ client_id: NATIVE, attempts: 1, budget_exhausted: true });
    expect(warn.mock.calls[1][1]).toMatchObject({ step: 'apple_revoke', not_attempted: 1, budget_ms: budgetMs });
  });

  it('1 回目の失敗で締め切りを過ぎたらやり直さない (1 行・fetch 1 回・attempts 1)', async () => {
    const budgetMs = APPLE_REVOKE_TOTAL_BUDGET_MS;
    const clock = makeClock();
    const { admin } = makeAdmin({ data: [{ client_id: NATIVE, refresh_token: 'rt-1' }], error: null });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(() => {
      clock.advance(budgetMs);
      return unavailable();
    });

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: clock.now, budgetMs }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 1, revoked: 0, failed: 1, skipped: null });
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ attempts: 1, budget_exhausted: true });
  });

  it('入口の時点で予算が 0 以下なら Apple を呼ばず client_secret も作らず、全行を failed に数えて warn を 1 回 (not_attempted)', async () => {
    stubConfig('broken-pem-would-throw-if-used');
    const { admin } = makeAdmin({ data: [{ client_id: NATIVE, refresh_token: 'rt-1' }], error: null });
    const { log, warn } = makeLog();
    const { fetchImpl, calls } = makeFetch(ok);

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: () => START, budgetMs: 0 }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(report).toEqual({ tokens: 1, revoked: 0, failed: 1, skipped: null });
    expect(calls).toHaveLength(0);
    // client_secret を作ろうとしていたら壊れた鍵で別の warn (could not revoke) が出る。出ていないので作っていない
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ not_attempted: 1, budget_ms: 0 });
  });

  it('試行の待ちは APPLE_API_TIMEOUT_MS と締め切りまでの残りの短いほう (budgetMs 3000 で 1 回目は 3000、budgetMs 10000 で 1 回目は 5000)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const row = { client_id: NATIVE, refresh_token: 'rt-1' };

    const short = makeAdmin({ data: [row], error: null });
    await createAccountDeletionAppleRevocation({ admin: () => short.admin, fetchImpl: makeFetch(ok).fetchImpl, now: () => START, budgetMs: APPLE_REVOKE_TOTAL_BUDGET_MS }).revokeForAccountDeletion(USER, makeLog().log, REQUEST_ID);
    expect(timeoutSpy).toHaveBeenLastCalledWith(APPLE_REVOKE_TOTAL_BUDGET_MS);

    const long = makeAdmin({ data: [row], error: null });
    await createAccountDeletionAppleRevocation({ admin: () => long.admin, fetchImpl: makeFetch(ok).fetchImpl, now: () => START, budgetMs: LONG_BUDGET_MS }).revokeForAccountDeletion(USER, makeLog().log, REQUEST_ID);
    expect(timeoutSpy).toHaveBeenLastCalledWith(APPLE_API_TIMEOUT_MS);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
  });

  it('budgetMs を省略すると APPLE_REVOKE_TOTAL_BUDGET_MS (偽の時計を APPLE_REVOKE_TOTAL_BUDGET_MS 進める fetch で、2 行目を呼ばない)', async () => {
    const clock = makeClock();
    const { admin } = makeAdmin({
      data: [
        { client_id: NATIVE, refresh_token: 'rt-native' },
        { client_id: SERVICES, refresh_token: 'rt-web' },
      ],
      error: null,
    });
    const { log } = makeLog();
    const { fetchImpl, calls } = makeFetch(() => {
      clock.advance(APPLE_REVOKE_TOTAL_BUDGET_MS);
      return ok();
    });

    const report = await createAccountDeletionAppleRevocation({ admin: () => admin, fetchImpl, now: clock.now }).revokeForAccountDeletion(USER, log, REQUEST_ID);

    expect(calls).toHaveLength(1);
    expect(report).toEqual({ tokens: 2, revoked: 1, failed: 1, skipped: null });
  });
});
