/**
 * #1571 運営の監査ログ (admin_audit_logs.ip_address) に、利用者の IP が残ること
 *
 * 本番の監査ログ 261 行のうち 226 行の ip_address が NULL で、サーバーコンポーネント経由 (adminFetch) の呼び出しは
 * そもそも利用者の IP を内部 API へ届けられない作りだった:
 *   adminFetch は元のリクエストの x-forwarded-for を転送するが、Vercel は外から来たリクエストの
 *   x-forwarded-for / x-real-ip を自分で付け直す。内部 API が受け取るのは「問い合わせたサーバー」の IP になる。
 *
 * 確かめること:
 *   (a) 直接の呼び出し (ブラウザ → API): x-forwarded-for の先頭 (無ければ x-real-ip) が記録される
 *   (b) サーバーコンポーネント経由 (ブラウザ → ページ → adminFetch → API): Vercel が x-forwarded-for を
 *       サーバーの IP に付け直しても、adminFetch が署名して転送した利用者の IP が記録される
 *   (c) 署名の無い・合わない・古い・先すぎる・IP を書き換えた転送ヘッダーは無視する (利用者がブラウザから付けても偽装できない)
 *   (d) 署名の鍵 (service_role キー) が無い環境では署名せず、従来どおり x-forwarded-for を読む
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let incomingHeaders: Record<string, string> = {};

vi.mock('next/headers', () => ({
  headers: async () => new Headers(incomingHeaders),
  cookies: async () => ({ getAll: () => [{ name: 'sb-access-token', value: 'session-value' }] }),
}));

const mockLoggerError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLoggerError(...args) }),
  generateRequestId: () => 'req_test',
}));

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}'));

const { adminFetch } = await import('@/lib/admin/fetch');
const { recordAdminAudit, extractClientIp } = await import('@/lib/admin/audit');
const {
  FORWARDED_CLIENT_IP_HEADER,
  FORWARDED_CLIENT_IP_ISSUED_AT_HEADER,
  FORWARDED_CLIENT_IP_MAX_AGE_MS,
  FORWARDED_CLIENT_IP_SIGNATURE_HEADER,
  readForwardedClientIp,
  signForwardedClientIp,
} = await import('@/lib/admin/client-ip');

/** 管理者のブラウザの IP (Vercel がページへのリクエストの x-forwarded-for に入れる値) */
const ADMIN_CLIENT_IP = '203.0.113.7';
/** 管理者のブラウザの IPv6 */
const ADMIN_CLIENT_IPV6 = '2001:db8::1571';
/** adminFetch を実行したサーバー (Vercel の関数) の IP。Vercel が内部 API へのリクエストの x-forwarded-for に入れる値 */
const SERVER_EGRESS_IP = '198.51.100.20';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SERVICE_ROLE_KEY_FOR_TEST = 'test-service-role-key-1571';

type InsertedRow = Record<string, unknown>;

/** admin_audit_logs への insert を記録する最小の Supabase client */
function makeAuditClient() {
  const rows: InsertedRow[] = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: InsertedRow) => {
        if (table === 'admin_audit_logs') rows.push(row);
        return { error: null };
      },
    }),
  };
  return { client, rows };
}

/** adminFetch が内部 API へ送ったヘッダー */
function sentHeaders(): Record<string, string> {
  const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
  return init.headers;
}

/**
 * Vercel が内部 API へのリクエストに付け直したあとのヘッダー (内部 API の route が受け取るもの)。
 * x-forwarded-for / x-real-ip は問い合わせたサーバーの IP に置き換わり、ほかのヘッダーはそのまま届く。
 */
function asReceivedOnVercel(sent: Record<string, string>): Headers {
  const received = new Headers(sent);
  received.set('x-forwarded-for', SERVER_EGRESS_IP);
  received.set('x-real-ip', SERVER_EGRESS_IP);
  return received;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY_FOR_TEST);
  incomingHeaders = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('(a) 直接の呼び出し (ブラウザ → API)', () => {
  it('x-forwarded-for の先頭を ip_address に、User-Agent も残す', async () => {
    const { client, rows } = makeAuditClient();
    const request = new Request('http://localhost/api/admin/users/x', {
      headers: { 'x-forwarded-for': `${ADMIN_CLIENT_IP}, 10.0.0.1`, 'user-agent': 'AdminBrowser' },
    });

    const result = await recordAdminAudit({ supabase: client, actorId: ACTOR_ID, actionType: 'admin.user.view', request });

    expect(result).toEqual({ ok: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip_address: ADMIN_CLIENT_IP, user_agent: 'AdminBrowser' });
  });

  it('x-forwarded-for が無ければ x-real-ip を使う', async () => {
    const { client, rows } = makeAuditClient();
    const request = new Request('http://localhost/api/admin/users/x', { headers: { 'x-real-ip': ADMIN_CLIENT_IPV6 } });

    await recordAdminAudit({ supabase: client, actorId: ACTOR_ID, actionType: 'admin.user.view', request });

    expect(rows[0].ip_address).toBe(ADMIN_CLIENT_IPV6);
  });

  it('request を渡さないと ip_address は null になる (呼び出し側は必ず渡す。見張りは admin-mutation-audit-coverage-1571)', async () => {
    const { client, rows } = makeAuditClient();

    await recordAdminAudit({ supabase: client, actorId: ACTOR_ID, actionType: 'admin.user.view' });

    expect(rows[0].ip_address).toBeNull();
  });
});

describe('(b) サーバーコンポーネント経由 (ブラウザ → ページ → adminFetch → API)', () => {
  it('Vercel が x-forwarded-for をサーバーの IP に付け直しても、管理者の IP が記録される', async () => {
    incomingHeaders = { 'x-forwarded-for': ADMIN_CLIENT_IP, 'user-agent': 'AdminBrowser', host: 'app.example.com' };

    await adminFetch('/api/admin/users/abc');

    const sent = sentHeaders();
    expect(sent[FORWARDED_CLIENT_IP_HEADER]).toBe(ADMIN_CLIENT_IP);
    expect(sent[FORWARDED_CLIENT_IP_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    // 署名の鍵 (service_role キー) そのものは送らない
    expect(Object.values(sent).join('\n')).not.toContain(SERVICE_ROLE_KEY_FOR_TEST);

    const { client, rows } = makeAuditClient();
    await recordAdminAudit({
      supabase: client,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
      request: { headers: asReceivedOnVercel(sent) },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip_address: ADMIN_CLIENT_IP, user_agent: 'AdminBrowser' });
    expect(rows[0].ip_address).not.toBe(SERVER_EGRESS_IP);
  });

  it('IPv6 の利用者でも同じ (x-forwarded-for の先頭を取る)', async () => {
    incomingHeaders = { 'x-forwarded-for': `${ADMIN_CLIENT_IPV6}, 10.0.0.1` };

    await adminFetch('/api/admin/moderation/meal/x');

    expect(extractClientIp(asReceivedOnVercel(sentHeaders()))).toBe(ADMIN_CLIENT_IPV6);
  });

  it('修正前の転送 (x-forwarded-for だけ) では、Vercel の付け直しでサーバーの IP になる (このテストが守る欠陥)', async () => {
    incomingHeaders = { 'x-forwarded-for': ADMIN_CLIENT_IP };
    await adminFetch('/api/admin/users/abc');
    const received = asReceivedOnVercel(sentHeaders());
    for (const name of [FORWARDED_CLIENT_IP_HEADER, FORWARDED_CLIENT_IP_ISSUED_AT_HEADER, FORWARDED_CLIENT_IP_SIGNATURE_HEADER]) {
      received.delete(name);
    }

    expect(extractClientIp(received)).toBe(SERVER_EGRESS_IP);
  });

  it('呼び出し側の extraHeaders では利用者の IP を書き換えられない', async () => {
    incomingHeaders = { 'x-forwarded-for': ADMIN_CLIENT_IP };

    await adminFetch('/api/admin/users/abc', { extraHeaders: { [FORWARDED_CLIENT_IP_HEADER]: '192.0.2.99' } });

    expect(sentHeaders()[FORWARDED_CLIENT_IP_HEADER]).toBe(ADMIN_CLIENT_IP);
  });

  it('元のリクエストに利用者の IP が無いとき (Vercel の外) は転送ヘッダーを付けない', async () => {
    incomingHeaders = { 'user-agent': 'AdminBrowser' };

    await adminFetch('/api/admin/users/abc');

    expect(sentHeaders()).not.toHaveProperty(FORWARDED_CLIENT_IP_HEADER);
    expect(sentHeaders()).not.toHaveProperty(FORWARDED_CLIENT_IP_SIGNATURE_HEADER);
  });
});

describe('(c) 署名の確認 (偽装・使い回しを受け付けない)', () => {
  const NOW_MS = Date.UTC(2026, 9, 15, 12, 0, 0);

  function signedHeaders(ip: string, issuedAtMs: number): Headers {
    const signed = signForwardedClientIp(ip, issuedAtMs);
    expect(signed).not.toBeNull();
    const headers = new Headers(signed ?? {});
    headers.set('x-forwarded-for', SERVER_EGRESS_IP);
    return headers;
  }

  it('正しい署名なら転送された IP を返す', () => {
    expect(readForwardedClientIp(signedHeaders(ADMIN_CLIENT_IP, NOW_MS), NOW_MS)).toBe(ADMIN_CLIENT_IP);
  });

  it('署名が無い・合わない転送ヘッダーは無視して x-forwarded-for に戻る (ブラウザから付けても偽装できない)', () => {
    const forged = new Headers({
      'x-forwarded-for': ADMIN_CLIENT_IP,
      [FORWARDED_CLIENT_IP_HEADER]: '192.0.2.99',
      [FORWARDED_CLIENT_IP_ISSUED_AT_HEADER]: String(NOW_MS),
      [FORWARDED_CLIENT_IP_SIGNATURE_HEADER]: 'f'.repeat(64),
    });
    expect(readForwardedClientIp(forged, NOW_MS)).toBeNull();
    expect(extractClientIp(forged)).toBe(ADMIN_CLIENT_IP);

    const unsigned = new Headers({ 'x-forwarded-for': ADMIN_CLIENT_IP, [FORWARDED_CLIENT_IP_HEADER]: '192.0.2.99' });
    expect(extractClientIp(unsigned)).toBe(ADMIN_CLIENT_IP);
  });

  it('署名したあとで IP を書き換えたら無視する', () => {
    const headers = signedHeaders(ADMIN_CLIENT_IP, NOW_MS);
    headers.set(FORWARDED_CLIENT_IP_HEADER, '192.0.2.99');
    expect(readForwardedClientIp(headers, NOW_MS)).toBeNull();
  });

  it('時刻を書き換えたら無視する', () => {
    const headers = signedHeaders(ADMIN_CLIENT_IP, NOW_MS);
    headers.set(FORWARDED_CLIENT_IP_ISSUED_AT_HEADER, String(NOW_MS + 1));
    expect(readForwardedClientIp(headers, NOW_MS)).toBeNull();
  });

  it('有効期間の境目: ちょうど上限までは受け付け、それより古い・先すぎる署名は無視する', () => {
    const headers = signedHeaders(ADMIN_CLIENT_IP, NOW_MS);
    expect(readForwardedClientIp(headers, NOW_MS + FORWARDED_CLIENT_IP_MAX_AGE_MS)).toBe(ADMIN_CLIENT_IP);
    expect(readForwardedClientIp(headers, NOW_MS - FORWARDED_CLIENT_IP_MAX_AGE_MS)).toBe(ADMIN_CLIENT_IP);
    expect(readForwardedClientIp(headers, NOW_MS + FORWARDED_CLIENT_IP_MAX_AGE_MS + 1)).toBeNull();
    expect(readForwardedClientIp(headers, NOW_MS - FORWARDED_CLIENT_IP_MAX_AGE_MS - 1)).toBeNull();
  });

  it('鍵が変われば (別の環境の署名は) 無視する', () => {
    const headers = signedHeaders(ADMIN_CLIENT_IP, NOW_MS);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'another-environment-key');
    expect(readForwardedClientIp(headers, NOW_MS)).toBeNull();
  });

  it('inet に入らない値 (複数 IP・ゾーン ID 付き・IP でない文字列) には署名しない', () => {
    expect(signForwardedClientIp(`${ADMIN_CLIENT_IP}, 10.0.0.1`, NOW_MS)).toBeNull();
    expect(signForwardedClientIp('fe80::1%eth0', NOW_MS)).toBeNull();
    expect(signForwardedClientIp('not-an-ip', NOW_MS)).toBeNull();
    expect(signForwardedClientIp(null, NOW_MS)).toBeNull();
  });
});

describe('(d) 署名の鍵が無い環境', () => {
  it('service_role キーが無ければ署名せず、受け取った側も転送ヘッダーを使わない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    incomingHeaders = { 'x-forwarded-for': ADMIN_CLIENT_IP };

    await adminFetch('/api/admin/users/abc');

    expect(sentHeaders()).not.toHaveProperty(FORWARDED_CLIENT_IP_HEADER);
    // 従来どおり x-forwarded-for は転送する (Vercel の外では、これで利用者の IP が届く)
    expect(sentHeaders()['x-forwarded-for']).toBe(ADMIN_CLIENT_IP);
    expect(extractClientIp(new Headers(sentHeaders()))).toBe(ADMIN_CLIENT_IP);
    consoleError.mockRestore();
  });
});
