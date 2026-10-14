// @vitest-environment node
/**
 * tests/smoke-script.test.ts
 *
 * #1181: `npm run test:smoke` (scripts/smoke.mjs → scripts/lib/smoke.mjs) の契約テスト。
 *
 *   - 引数・環境変数の解釈 (--base-url / PLAYWRIGHT_BASE_URL / --with-auth / --timeout-ms)
 *   - 4 項目 (health?deep=1 / login / faq / 未認証 API=401) の合否判定
 *   - 失敗の出し方 (例外にせず FAIL として報告。終了コード 0 / 1 / 2)
 *   - --with-auth のログイン手順 (#1547: パスワードのログインを使わず、e2e と共通の補助関数 tests/e2e/helpers/test-session.mjs を
 *     import して、管理用の鍵で発行したトークンをセッションに換える。手順・やり直しの規則は補助関数のもの) と、
 *     パスワード・トークン・鍵・応答の本文を出力に出さないこと
 *   - 実際の CLI (node scripts/smoke.mjs) をローカルの HTTP サーバに向けて動かした結果
 *
 * fetch は差し替える。実際のネットワーク・本番には接続しない (CLI のテストは 127.0.0.1 のみ)。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import {
  AUTH_ENV_NAMES,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  UsageError,
  main,
  parseArgs,
  runSmoke,
} from '../scripts/lib/smoke.mjs';
import {
  TEST_SESSION_DEFAULT_MAX_ATTEMPTS,
  TEST_SESSION_ENV_NAMES,
  TEST_SESSION_LINK_TYPE,
  TEST_SESSION_MAX_ATTEMPTS_ENV,
  TEST_SESSION_RETRY_BASE_DELAY_MS,
} from './e2e/helpers/test-session.mjs';

// ───────────────────────────────────────────────────────────────────────────
// fetch の差し替え
// ───────────────────────────────────────────────────────────────────────────

const BASE = 'https://smoke-test.example.com';
const SUPABASE_URL = 'https://smoke-test-project.supabase.co';
const EMAIL = 'smoke-user@example.com';
const PASSWORD = 'smoke-password-should-never-be-printed';
const ANON_KEY = 'smoke-anon-key-should-never-be-printed';
const SERVICE_ROLE_KEY = 'smoke-service-role-key-should-never-be-printed';
const TOKEN_HASH = 'smoke-token-hash-should-never-be-printed';
const ACCESS_TOKEN = 'smoke-access-token-should-never-be-printed';

const AUTH_ENV = {
  E2E_USER_EMAIL: EMAIL,
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
};

const GENERATE_LINK = `POST ${SUPABASE_URL}/auth/v1/admin/generate_link`;
const VERIFY = `POST ${SUPABASE_URL}/auth/v1/verify`;

const healthyBody = {
  status: 'ok',
  version: 'v0.1.0',
  time: '2026-10-07T00:00:00.000Z',
  checks: { database: 'ok' },
};

type Overrides = Partial<Record<string, (init: RequestInit) => Response | Promise<Response>>>;

/** `METHOD url` をキーに応答を返す fetch。overrides のキーは `GET /login` のように path まで */
function makeFetch(overrides: Overrides = {}) {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(input), init });
    const key = `${method} ${url.origin === BASE ? '' : url.origin}${url.pathname}${url.search}`;
    const handler = overrides[key];
    if (handler) return handler(init);

    switch (key) {
      case 'GET /api/health?deep=1':
        return Response.json(healthyBody);
      case 'GET /login':
      case 'GET /faq':
        return new Response('<html></html>', { status: 200 });
      case 'GET /api/profile': {
        const authorization = new Headers(init.headers).get('authorization');
        return authorization
          ? Response.json({ id: 'user-1' }, { status: 200 })
          : Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      case GENERATE_LINK:
        return Response.json({ id: 'user-1', hashed_token: TOKEN_HASH, verification_type: TEST_SESSION_LINK_TYPE });
      case VERIFY:
        return Response.json({ access_token: ACCESS_TOKEN, token_type: 'bearer' });
      default:
        return new Response('not found', { status: 404 });
    }
  });
  return { fetchImpl, calls };
}

const byName = (results: Awaited<ReturnType<typeof runSmoke>>, name: string) => {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`結果に ${name} がありません: ${results.map((r) => r.name).join(', ')}`);
  return found;
};

// CLI のテストは node の子プロセスを起動するため、CPU が混んでいても落ちないよう余裕を持たせる
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// 引数の解釈
// ───────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('何も指定しなければローカルの dev サーバ (http://localhost:3000)', () => {
    expect(parseArgs([], {})).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      withAuth: false,
      help: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    expect(DEFAULT_BASE_URL).toBe('http://localhost:3000');
  });

  it('環境変数 PLAYWRIGHT_BASE_URL を既定にし、--base-url が優先される', () => {
    const env = { PLAYWRIGHT_BASE_URL: 'https://from-env.example.com' };
    expect(parseArgs([], env).baseUrl).toBe('https://from-env.example.com');
    expect(parseArgs(['--base-url=https://from-flag.example.com'], env).baseUrl).toBe('https://from-flag.example.com');
  });

  it('PLAYWRIGHT_BASE_URL が空文字なら既定に戻る', () => {
    expect(parseArgs([], { PLAYWRIGHT_BASE_URL: '' }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('--base-url=URL と --base-url URL の両方の書き方を受け付ける', () => {
    expect(parseArgs(['--base-url=https://a.example.com'], {}).baseUrl).toBe('https://a.example.com');
    expect(parseArgs(['--base-url', 'https://b.example.com'], {}).baseUrl).toBe('https://b.example.com');
  });

  it('URL は origin に正規化する (末尾スラッシュ・パス・クエリは落とす)', () => {
    expect(parseArgs(['--base-url=https://a.example.com/'], {}).baseUrl).toBe('https://a.example.com');
    expect(parseArgs(['--base-url=https://a.example.com/login?x=1'], {}).baseUrl).toBe('https://a.example.com');
    expect(parseArgs(['--base-url=http://127.0.0.1:3140/'], {}).baseUrl).toBe('http://127.0.0.1:3140');
  });

  it('URL として読めない・http(s) 以外・値が無い場合は UsageError', () => {
    expect(() => parseArgs(['--base-url=not a url'], {})).toThrow(UsageError);
    expect(() => parseArgs(['--base-url='], {})).toThrow(UsageError);
    expect(() => parseArgs(['--base-url=ftp://example.com'], {})).toThrow(UsageError);
    expect(() => parseArgs(['--base-url'], {})).toThrow(UsageError);
    expect(() => parseArgs(['--base-url', '--with-auth'], {})).toThrow(UsageError);
    expect(() => parseArgs([], { PLAYWRIGHT_BASE_URL: 'garbage' })).toThrow(UsageError);
  });

  it('URL に認証情報 (user:pass@) が入っていたら拒否し、メッセージにも出さない', () => {
    try {
      parseArgs(['--base-url=https://admin:hunter2@example.com'], {});
      throw new Error('UsageError が投げられませんでした');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).not.toContain('hunter2');
      expect((error as Error).message).not.toContain('admin');
    }
  });

  it('不明な引数は UsageError', () => {
    expect(() => parseArgs(['--bogus'], {})).toThrow(UsageError);
    expect(() => parseArgs(['https://example.com'], {})).toThrow(UsageError);
  });

  it('--with-auth / --help / -h / --timeout-ms を解釈する', () => {
    expect(parseArgs(['--with-auth'], {}).withAuth).toBe(true);
    expect(parseArgs(['--help'], {}).help).toBe(true);
    expect(parseArgs(['-h'], {}).help).toBe(true);
    expect(parseArgs(['--timeout-ms=2500'], {}).timeoutMs).toBe(2500);
  });

  it('--timeout-ms は 1 以上の整数のみ', () => {
    for (const bad of ['abc', '0', '-5', '1.5', '', '99999999']) {
      expect(() => parseArgs([`--timeout-ms=${bad}`], {})).toThrow(UsageError);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4 項目の判定
// ───────────────────────────────────────────────────────────────────────────

describe('runSmoke (未ログインの 4 項目)', () => {
  it('すべて期待どおりなら全項目 PASS', async () => {
    const { fetchImpl } = makeFetch();

    const results = await runSmoke({ baseUrl: BASE, env: {}, fetchImpl });

    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['GET /api/health?deep=1', true],
      ['GET /login', true],
      ['GET /faq', true],
      ['GET /api/profile (未認証)', true],
    ]);
    expect(byName(results, 'GET /api/health?deep=1').detail).toBe('HTTP 200 status=ok database=ok version=v0.1.0');
  });

  it('確認先は /api/health?deep=1, /login, /faq, /api/profile の GET だけ。データを書き換えるメソッドは使わない', async () => {
    const { fetchImpl, calls } = makeFetch();

    await runSmoke({ baseUrl: BASE, env: {}, fetchImpl });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/api/health?deep=1`,
      `GET ${BASE}/login`,
      `GET ${BASE}/faq`,
      `GET ${BASE}/api/profile`,
    ]);
  });

  it('リダイレクトは追わず (manual)、待ち時間の打ち切り (signal) を付け、認証情報は送らない', async () => {
    const { fetchImpl, calls } = makeFetch();

    await runSmoke({ baseUrl: BASE, env: {}, fetchImpl });

    for (const { init } of calls) {
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
    }
  });

  it('/api/health が 503 (DB に届かない) なら FAIL。他の項目は続けて確認する', async () => {
    const { fetchImpl } = makeFetch({
      'GET /api/health?deep=1': () => Response.json({ status: 'degraded' }, { status: 503 }),
    });

    const results = await runSmoke({ baseUrl: BASE, env: {}, fetchImpl });

    const health = byName(results, 'GET /api/health?deep=1');
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('HTTP 503');
    expect(health.detail).toContain('DB');
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  it('/api/health が 404 (古いデプロイ) なら FAIL。ヘルスチェックが無いことが分かる', async () => {
    const { fetchImpl } = makeFetch({ 'GET /api/health?deep=1': () => new Response('nf', { status: 404 }) });

    const health = byName(await runSmoke({ baseUrl: BASE, env: {}, fetchImpl }), 'GET /api/health?deep=1');

    expect(health.ok).toBe(false);
    expect(health.detail).toContain('HTTP 404');
    expect(health.detail).toContain('ヘルスチェックがありません');
  });

  it('/api/health が 200 でも status が ok でない・DB 確認の結果が無い・JSON でないなら FAIL', async () => {
    const cases: Array<[string, () => Response]> = [
      ['status が degraded', () => Response.json({ ...healthyBody, status: 'degraded' })],
      ['checks.database が fail', () => Response.json({ ...healthyBody, checks: { database: 'fail' } })],
      ['deep が効いていない (checks が無い)', () => Response.json({ status: 'ok', version: 'v0.1.0', time: 'x' })],
      ['JSON でない', () => new Response('<html>cached</html>', { status: 200 })],
    ];

    for (const [label, handler] of cases) {
      const { fetchImpl } = makeFetch({ 'GET /api/health?deep=1': handler });
      const health = byName(await runSmoke({ baseUrl: BASE, env: {}, fetchImpl }), 'GET /api/health?deep=1');
      expect(health.ok, label).toBe(false);
    }
  });

  it('version が英数字と . - _ + 以外を含むときは出力に出さない (端末への制御文字の混入を防ぐ)', async () => {
    const { fetchImpl } = makeFetch({
      'GET /api/health?deep=1': () => Response.json({ ...healthyBody, version: 'v1\u001b[31m evil' }),
    });

    const health = byName(await runSmoke({ baseUrl: BASE, env: {}, fetchImpl }), 'GET /api/health?deep=1');

    expect(health.ok).toBe(true);
    expect(health.detail).toBe('HTTP 200 status=ok database=ok');
  });

  it('/login・/faq が 200 以外 (500 やリダイレクト) なら FAIL', async () => {
    const { fetchImpl } = makeFetch({
      'GET /login': () => new Response('err', { status: 500 }),
      'GET /faq': () => new Response(null, { status: 307, headers: { location: '/somewhere' } }),
    });

    const results = await runSmoke({ baseUrl: BASE, env: {}, fetchImpl });

    expect(byName(results, 'GET /login')).toMatchObject({ ok: false, detail: expect.stringContaining('HTTP 500') });
    expect(byName(results, 'GET /faq')).toMatchObject({ ok: false, detail: expect.stringContaining('HTTP 307') });
  });

  it('未認証の /api/profile が 401 でなければ FAIL (500 は API / 認証基盤の故障、200 は認可漏れ)', async () => {
    for (const status of [500, 200, 403, 404]) {
      const { fetchImpl } = makeFetch({
        'GET /api/profile': () => new Response('{}', { status }),
      });
      const result = byName(await runSmoke({ baseUrl: BASE, env: {}, fetchImpl }), 'GET /api/profile (未認証)');
      expect(result.ok, `status ${status}`).toBe(false);
      expect(result.detail).toContain(`HTTP ${status}`);
    }
  });

  it('接続できない (fetch が reject) 場合も例外にせず FAIL として全項目を報告し、原因コードを添える', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    });

    const results = await runSmoke({ baseUrl: BASE, env: {}, fetchImpl });

    expect(results).toHaveLength(4);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0].detail).toContain('fetch failed');
    expect(results[0].detail).toContain('ECONNREFUSED');
  });

  it('待ち時間切れ (TimeoutError) は何 ms で切れたかを報告する', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const results = await runSmoke({ baseUrl: BASE, env: {}, fetchImpl, timeoutMs: 1234 });

    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toContain('1234ms');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// --with-auth
// ───────────────────────────────────────────────────────────────────────────

describe('runSmoke --with-auth', () => {
  const AUTH_CHECK = 'ログイン → GET /api/profile (--with-auth)';

  it('管理用の鍵でトークンを発行し、それをセッションに換え、その Bearer トークンで /api/profile が 200 になることを確認する', async () => {
    const { fetchImpl, calls } = makeFetch();

    const results = await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl });

    expect(byName(results, AUTH_CHECK)).toMatchObject({ ok: true });
    expect(results).toHaveLength(5);

    // 未ログインの 4 項目のあとに、発行 → 確認 → /api/profile の順で呼ぶ
    expect(calls.slice(4).map((c) => `${c.method} ${c.url}`)).toEqual([
      GENERATE_LINK,
      VERIFY,
      `GET ${BASE}/api/profile`,
    ]);

    const [link, verify, profile] = calls.slice(4);
    const linkHeaders = new Headers(link.init.headers);
    expect(linkHeaders.get('apikey')).toBe(SERVICE_ROLE_KEY);
    expect(linkHeaders.get('authorization')).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    expect(JSON.parse(String(link.init.body))).toEqual({ type: 'recovery', email: EMAIL });

    // 確認 (/verify) には公開用の anon key だけを付け、管理用の鍵は送らない。メールアドレスは送らない (token_hash だけ)
    const verifyHeaders = new Headers(verify.init.headers);
    expect(verifyHeaders.get('apikey')).toBe(ANON_KEY);
    expect(verifyHeaders.get('authorization')).toBeNull();
    expect(JSON.parse(String(verify.init.body))).toEqual({ type: 'recovery', token_hash: TOKEN_HASH });

    expect(new Headers(profile.init.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('パスワードのログイン (grant_type=password) は呼ばない。E2E_USER_PASSWORD があっても送らない (#1547)', async () => {
    const { fetchImpl, calls } = makeFetch();

    await runSmoke({ baseUrl: BASE, withAuth: true, env: { ...AUTH_ENV, E2E_USER_PASSWORD: PASSWORD }, fetchImpl });

    expect(calls.some((c) => c.url.includes('/auth/v1/token'))).toBe(false);
    expect(calls.some((c) => String(c.init.body ?? '').includes(PASSWORD))).toBe(false);
    expect(AUTH_ENV_NAMES).not.toContain('E2E_USER_PASSWORD');
  });

  it('要る環境変数は、メールアドレスと、共通の補助関数がセッションを作るのに読む 3 つ (名前を写さない)', () => {
    expect(AUTH_ENV_NAMES).toEqual(['E2E_USER_EMAIL', ...Object.values(TEST_SESSION_ENV_NAMES)]);
    expect(AUTH_ENV_NAMES).toEqual([
      'E2E_USER_EMAIL',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
  });

  it('どの環境にログインしたか分かるよう Supabase のホスト名だけを出す', async () => {
    const { fetchImpl } = makeFetch();

    const results = await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl });

    expect(byName(results, AUTH_CHECK).detail).toContain('smoke-test-project.supabase.co');
  });

  it('トークンの発行に失敗したら FAIL (ステータスだけ報告し、応答本文は出さない)。確認・/api/profile には進まない', async () => {
    const { fetchImpl, calls } = makeFetch({
      [GENERATE_LINK]: () =>
        Response.json({ code: 404, error_code: 'user_not_found', msg: `User with this email not found ${EMAIL}` }, { status: 404 }),
    });

    const result = byName(await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl }), AUTH_CHECK);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HTTP 404');
    expect(result.detail).not.toContain(EMAIL);
    expect(calls.some((c) => `${c.method} ${c.url}` === VERIFY)).toBe(false);
    expect(calls.filter((c) => c.url === `${BASE}/api/profile`)).toHaveLength(1);
  });

  it('発行の応答に hashed_token が無ければ FAIL', async () => {
    const { fetchImpl } = makeFetch({ [GENERATE_LINK]: () => Response.json({ id: 'user-1' }) });

    const result = byName(await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl }), AUTH_CHECK);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('hashed_token');
  });

  it('トークンの確認に失敗したら FAIL (ステータスだけ報告し、応答本文は出さない)。403 は共通の補助関数の規則で、待ってから発行からやり直す', async () => {
    const { fetchImpl, calls } = makeFetch({
      [VERIFY]: () => Response.json({ error_code: 'otp_expired', msg: `expired ${TOKEN_HASH}` }, { status: 403 }),
    });
    const sleeps: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleeps.push(ms);
    };

    const result = byName(
      await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl, sleepImpl }),
      AUTH_CHECK,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('トークンの確認');
    expect(result.detail).toContain('HTTP 403');
    expect(result.detail).toContain(`${TEST_SESSION_DEFAULT_MAX_ATTEMPTS} 回`);
    expect(result.detail).not.toContain(TOKEN_HASH);
    expect(result.detail).not.toContain('otp_expired');
    // 403 は発行からやり直し、補助関数の既定の上限 (環境変数が無いとき) で止める。やり直しの前には待つ (補助関数の待ち方)
    expect(calls.filter((c) => `${c.method} ${c.url}` === GENERATE_LINK)).toHaveLength(TEST_SESSION_DEFAULT_MAX_ATTEMPTS);
    expect(calls.filter((c) => `${c.method} ${c.url}` === VERIFY)).toHaveLength(TEST_SESSION_DEFAULT_MAX_ATTEMPTS);
    expect(sleeps).toHaveLength(TEST_SESSION_DEFAULT_MAX_ATTEMPTS - 1);
    sleeps.forEach((ms, index) => {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(TEST_SESSION_RETRY_BASE_DELAY_MS * (index + 1));
    });
  });

  it('確認の 401 などの応答の本文は出さない (段とステータスだけ)', async () => {
    const marker = 'auth-body-should-not-be-printed';
    const { fetchImpl } = makeFetch({ [VERIFY]: () => new Response(`${marker} ${TOKEN_HASH}`, { status: 401 }) });

    const result = byName(await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl }), AUTH_CHECK);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('ログインに失敗しました (smoke-test-project.supabase.co): トークンの確認: HTTP 401');
    expect(result.detail).not.toContain(marker);
    expect(result.detail).not.toContain(TOKEN_HASH);
  });

  it('発行・確認で通信できなければ、ほかの項目と同じく「リクエストに失敗しました」と時間切れなどの理由を出す。やり直さない', async () => {
    for (const route of [GENERATE_LINK, VERIFY]) {
      const { fetchImpl, calls } = makeFetch({
        [route]: () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
      });
      const sleepImpl = vi.fn(async () => {});

      const result = byName(
        await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl, sleepImpl }),
        AUTH_CHECK,
      );

      expect(result.ok, route).toBe(false);
      expect(result.detail, route).toBe(`リクエストに失敗しました: ${DEFAULT_TIMEOUT_MS}ms 以内に応答がありませんでした`);
      expect(calls.filter((c) => `${c.method} ${c.url}` === GENERATE_LINK), route).toHaveLength(1);
      expect(sleepImpl, route).not.toHaveBeenCalled();
      // /api/profile (認証つき) には進まない
      expect(calls.filter((c) => c.url === `${BASE}/api/profile`), route).toHaveLength(1);
    }
  });

  it('確認が 403 (同時に作った相手にトークンを消された) なら、発行からやり直して新しいトークンでログインする', async () => {
    let issued = 0;
    let verified = 0;
    const { fetchImpl, calls } = makeFetch({
      [GENERATE_LINK]: () => Response.json({ hashed_token: `${TOKEN_HASH}-${++issued}` }),
      [VERIFY]: () =>
        ++verified === 1
          ? Response.json({ code: 403, error_code: 'otp_expired' }, { status: 403 })
          : Response.json({ access_token: ACCESS_TOKEN, token_type: 'bearer' }),
    });

    const sleepImpl = vi.fn(async () => {});

    const result = byName(
      await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl, sleepImpl }),
      AUTH_CHECK,
    );

    expect(result).toMatchObject({ ok: true });
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(calls.slice(4).map((c) => `${c.method} ${c.url}`)).toEqual([
      GENERATE_LINK,
      VERIFY,
      GENERATE_LINK,
      VERIFY,
      `GET ${BASE}/api/profile`,
    ]);
    expect(JSON.parse(String(calls[7].init.body))).toEqual({ type: 'recovery', token_hash: `${TOKEN_HASH}-2` });
  });

  it('やり直すのは確認の 403 だけ。確認の 401・429・500 はやり直さない', async () => {
    for (const status of [401, 429, 500]) {
      const { fetchImpl, calls } = makeFetch({ [VERIFY]: () => new Response('x', { status }) });

      const result = byName(await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl }), AUTH_CHECK);

      expect(result.ok, String(status)).toBe(false);
      expect(result.detail, String(status)).toContain(`HTTP ${status}`);
      expect(calls.filter((c) => `${c.method} ${c.url}` === GENERATE_LINK), String(status)).toHaveLength(1);
    }
  });

  it('やり直す回数の上限は、runSmoke に渡した env の共通の環境変数 (TEST_SESSION_MAX_ATTEMPTS_ENV) で上書きでき、不正な値は補助関数の既定に戻る', async () => {
    // process.env 側の値は使わない (確認したい環境の値は env で渡す。.env.local や手元のシェルの値を混ぜない)
    vi.stubEnv(TEST_SESSION_MAX_ATTEMPTS_ENV, '4');
    try {
      for (const [raw, expected] of [
        ['1', 1],
        ['2', 2],
        [' 3 ', 3],
        ['', TEST_SESSION_DEFAULT_MAX_ATTEMPTS],
        ['0', TEST_SESSION_DEFAULT_MAX_ATTEMPTS],
        ['2.5', TEST_SESSION_DEFAULT_MAX_ATTEMPTS],
        ['x', TEST_SESSION_DEFAULT_MAX_ATTEMPTS],
      ] as const) {
        const { fetchImpl, calls } = makeFetch({
          [VERIFY]: () => Response.json({ error_code: 'otp_expired' }, { status: 403 }),
        });
        const result = byName(
          await runSmoke({
            baseUrl: BASE,
            withAuth: true,
            env: { ...AUTH_ENV, [TEST_SESSION_MAX_ATTEMPTS_ENV]: raw },
            fetchImpl,
            sleepImpl: async () => {},
          }),
          AUTH_CHECK,
        );
        expect(calls.filter((c) => `${c.method} ${c.url}` === GENERATE_LINK), raw).toHaveLength(expected);
        expect(result.detail, raw).toContain(`${expected} 回`);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('確認の応答に access_token が無ければ FAIL', async () => {
    const { fetchImpl } = makeFetch({ [VERIFY]: () => Response.json({}) });

    const result = byName(await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl }), AUTH_CHECK);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('access_token');
  });

  it('ログインできても、そのトークンで /api/profile が 200 にならなければ FAIL', async () => {
    const { fetchImpl } = makeFetch({
      'GET /api/profile': () => new Response('{}', { status: 401 }),
    });

    const result = byName(await runSmoke({ baseUrl: BASE, withAuth: true, env: AUTH_ENV, fetchImpl }), AUTH_CHECK);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HTTP 401');
  });

  it('環境変数が足りなければ FAIL として名前だけを報告する (値は出さない)', async () => {
    const { fetchImpl, calls } = makeFetch();

    const result = byName(
      await runSmoke({ baseUrl: BASE, withAuth: true, env: { E2E_USER_EMAIL: EMAIL }, fetchImpl }),
      AUTH_CHECK,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(result.detail).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(result.detail).not.toContain(EMAIL);
    expect(calls.some((c) => c.url.startsWith(SUPABASE_URL))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// main (終了コードと出力)
// ───────────────────────────────────────────────────────────────────────────

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { log: (line: string) => out.push(line), errorLog: (line: string) => err.push(line) },
    text: () => [...out, ...err].join('\n'),
  };
}

describe('main', () => {
  it('全項目 OK なら終了コード 0', async () => {
    const { fetchImpl } = makeFetch();
    const cap = capture();

    const code = await main([`--base-url=${BASE}`], {}, { ...cap.io, fetchImpl });

    expect(code).toBe(0);
    expect(cap.out[0]).toBe(`smoke test: ${BASE}`);
    expect(cap.out.filter((line) => line.startsWith('[PASS]'))).toHaveLength(4);
    expect(cap.out.at(-1)).toBe('smoke test OK (4/4)');
  });

  it('1 項目でも失敗なら終了コード 1 で、失敗した項目と件数を出す', async () => {
    const { fetchImpl } = makeFetch({ 'GET /faq': () => new Response('err', { status: 500 }) });
    const cap = capture();

    const code = await main([`--base-url=${BASE}`], {}, { ...cap.io, fetchImpl });

    expect(code).toBe(1);
    expect(cap.out.some((line) => line.startsWith('[FAIL] GET /faq'))).toBe(true);
    expect(cap.out.at(-1)).toContain('1/4');
  });

  it('引数の誤りは終了コード 2。ネットワークには出ない', async () => {
    const { fetchImpl } = makeFetch();
    const cap = capture();

    const code = await main(['--bogus'], {}, { ...cap.io, fetchImpl });

    expect(code).toBe(2);
    expect(cap.err.join('\n')).toContain('--bogus');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('--help は使い方を表示して終了コード 0。ネットワークには出ない', async () => {
    const { fetchImpl } = makeFetch();
    const cap = capture();

    const code = await main(['--help'], {}, { ...cap.io, fetchImpl });

    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('--base-url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('--help は、--with-auth に管理用の鍵 (SUPABASE_SERVICE_ROLE_KEY) が要ることと、本番では使わないことを案内する (#1547)', async () => {
    const cap = capture();

    await main(['--help'], {}, cap.io);

    const text = cap.out.join('\n');
    expect(text).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(text).toContain('本番では使わない');
    expect(text).not.toContain('E2E_USER_PASSWORD');
  });

  it('--with-auth で環境変数が足りなければ終了コード 2。足りない変数の名前だけを出し、ネットワークには出ない', async () => {
    const { fetchImpl } = makeFetch();
    const cap = capture();

    const code = await main(['--with-auth', `--base-url=${BASE}`], { E2E_USER_EMAIL: EMAIL }, { ...cap.io, fetchImpl });

    expect(code).toBe(2);
    const text = cap.text();
    for (const name of AUTH_ENV_NAMES.filter((n) => n !== 'E2E_USER_EMAIL')) expect(text).toContain(name);
    expect(text).not.toContain(EMAIL);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('--with-auth の実行でも、メールアドレス・パスワード・鍵・トークンを出力に出さない', async () => {
    const { fetchImpl } = makeFetch();
    const cap = capture();

    const code = await main(['--with-auth', `--base-url=${BASE}`], AUTH_ENV, { ...cap.io, fetchImpl });

    expect(code).toBe(0);
    const text = cap.text();
    for (const secret of [EMAIL, ANON_KEY, SERVICE_ROLE_KEY, TOKEN_HASH, ACCESS_TOKEN]) expect(text).not.toContain(secret);
  });

  it('PLAYWRIGHT_BASE_URL を確認先にする', async () => {
    const { fetchImpl, calls } = makeFetch();
    const cap = capture();

    await main([], { PLAYWRIGHT_BASE_URL: BASE }, { ...cap.io, fetchImpl });

    expect(calls[0].url).toBe(`${BASE}/api/health?deep=1`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 実際の CLI を、ローカルの HTTP サーバに向けて動かす
// ───────────────────────────────────────────────────────────────────────────

const CLI = path.join(process.cwd(), 'scripts/smoke.mjs');

interface FakeApp {
  origin: string;
  close: () => Promise<void>;
}

/**
 * healthStatus が 200 なら正常、503 なら DB 不通を装うアプリ。
 * --with-auth 用に、同じ origin で Supabase Auth の発行 (/auth/v1/admin/generate_link) と確認 (/auth/v1/verify) も装う
 * (管理用の鍵と anon key が届いたときだけ応じる)。/api/profile は、確認で渡したトークンの Bearer なら 200
 */
async function startFakeApp(healthStatus: number): Promise<FakeApp> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/auth/v1/admin/generate_link') {
      return req.headers.apikey === SERVICE_ROLE_KEY
        ? json(200, { hashed_token: TOKEN_HASH, verification_type: TEST_SESSION_LINK_TYPE })
        : json(401, { error_code: 'no_authorization' });
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/verify') {
      return req.headers.apikey === ANON_KEY
        ? json(200, { access_token: ACCESS_TOKEN, token_type: 'bearer' })
        : json(401, { error_code: 'no_authorization' });
    }
    if (url.pathname === '/api/profile' && req.headers.authorization === `Bearer ${ACCESS_TOKEN}`) {
      return json(200, { id: 'user-1' });
    }
    if (url.pathname === '/api/health' && url.searchParams.get('deep') === '1') {
      return healthStatus === 200
        ? json(200, healthyBody)
        : json(healthStatus, { status: 'degraded', version: 'v0.1.0', time: 'x', checks: { database: 'fail' } });
    }
    if (url.pathname === '/login' || url.pathname === '/faq') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html></html>');
    }
    if (url.pathname === '/api/profile') return json(401, { error: 'Unauthorized' });
    return json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** spawn (非同期) で動かす。同じプロセスで HTTP サーバを動かしているため、同期実行だとデッドロックする */
function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // ホストの環境変数 (E2E_USER_* や PLAYWRIGHT_BASE_URL など) が紛れ込まないよう最小限だけ渡す
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI (node scripts/smoke.mjs)', () => {
  it('正常なアプリに向けると終了コード 0 で全項目 PASS', async () => {
    const app = await startFakeApp(200);
    try {
      const { code, stdout } = await runCli([`--base-url=${app.origin}`]);

      expect(code).toBe(0);
      expect(stdout).toContain(`smoke test: ${app.origin}`);
      expect(stdout).toContain('[PASS] GET /api/health?deep=1');
      expect(stdout).toContain('smoke test OK (4/4)');
    } finally {
      await app.close();
    }
  });

  it('ヘルスチェックが 503 を返すアプリに向けると終了コード 1 で FAIL を出す', async () => {
    const app = await startFakeApp(503);
    try {
      const { code, stdout } = await runCli([`--base-url=${app.origin}`]);

      expect(code).toBe(1);
      expect(stdout).toContain('[FAIL] GET /api/health?deep=1');
      expect(stdout).toContain('[PASS] GET /login');
      expect(stdout).toContain('smoke test FAILED (1/4');
    } finally {
      await app.close();
    }
  });

  it('PLAYWRIGHT_BASE_URL で確認先を渡せる', async () => {
    const app = await startFakeApp(200);
    try {
      const { code, stdout } = await runCli([], { PLAYWRIGHT_BASE_URL: app.origin });

      expect(code).toBe(0);
      expect(stdout).toContain(`smoke test: ${app.origin}`);
    } finally {
      await app.close();
    }
  });

  it('接続できない確認先でも固まらず、終了コード 1 で終わる', async () => {
    // 一度 listen して閉じたポートは、直後はどこも待ち受けていない
    const app = await startFakeApp(200);
    await app.close();

    const { code, stdout } = await runCli([`--base-url=${app.origin}`, '--timeout-ms=3000']);

    expect(code).toBe(1);
    expect(stdout).toContain('[FAIL] GET /api/health?deep=1');
  });

  it('--with-auth は、node でそのまま動かしても共通の補助関数 (tests/e2e/helpers/test-session.mjs) を読み込み、発行 → 確認 → /api/profile まで通る', async () => {
    const app = await startFakeApp(200);
    try {
      const { code, stdout, stderr } = await runCli([`--base-url=${app.origin}`, '--with-auth'], {
        E2E_USER_EMAIL: EMAIL,
        NEXT_PUBLIC_SUPABASE_URL: app.origin,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      });

      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(stdout).toContain('[PASS] ログイン → GET /api/profile (--with-auth)');
      expect(stdout).toContain('smoke test OK (5/5)');
      for (const secret of [EMAIL, ANON_KEY, SERVICE_ROLE_KEY, TOKEN_HASH, ACCESS_TOKEN]) expect(stdout).not.toContain(secret);
    } finally {
      await app.close();
    }
  });

  it('引数が誤っていれば終了コード 2', async () => {
    const { code, stderr } = await runCli(['--bogus']);

    expect(code).toBe(2);
    expect(stderr).toContain('不明な引数です: --bogus');
  });
});
