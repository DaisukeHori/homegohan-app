/**
 * T15 (#1154) 外国の AI 事業者への提供の同意 API の route テスト
 *
 *   GET  /api/ai/consent         本人の同意の状況
 *   POST /api/ai/consent         全事業者について、現行の版への同意を記録する
 *   POST /api/ai/consent/revoke  本人の有効な同意を撤回する
 *
 * 確認すること:
 *   - 未ログインは 401 (DB にもレート制限にも触れない)
 *   - 同意の記録は service role のクライアントで書く (本人のクライアントでは書かない)。対象は常に認証で確定した本人で、
 *     body の user_id / ip_address などは使わない。IP アドレスは x-forwarded-for の先頭の値、User-Agent はヘッダーから取る
 *   - 画面に出した文面の版が必須。古い版は 409 で、何も書かない
 *   - 連打は 429。レート制限の基盤が落ちているときは通さない (503)
 *   - 撤回は revoked_at を入れるだけで行を消さず、回数制限をかけない
 *   - 500 の本文は汎用メッセージだけで、DB の生のエラー文を返さない。詳細はログへ
 *   - 「同意しない」の行は作らない (POST が作る行は、すべて consented = true)
 * DB は本番スキーマの列を知っているフェイク (tests/helpers/schema-checked-supabase.ts)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaCheckedDb, pgError, type SchemaCheckedDb } from '../helpers/schema-checked-supabase';

const mocks = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    getUser: vi.fn(),
    userFrom: vi.fn(),
    adminFrom: vi.fn(),
    logger,
    withUser: vi.fn(),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser }, from: mocks.userFrom }),
  getSupabaseAdmin: () => ({ from: mocks.adminFrom }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ ...mocks.logger, withUser: (id: string) => (mocks.withUser(id), mocks.logger) }),
  generateRequestId: () => 'req_test',
}));

// 実物のレート制限 (Upstash 未設定 = in-memory) を使い、基盤の障害だけ差し替えられるようにする
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...actual, checkRateLimit: vi.fn(actual.checkRateLimit) };
});

import { GET, POST } from '@/app/api/ai/consent/route';
import { POST as REVOKE } from '@/app/api/ai/consent/revoke/route';
import { checkRateLimit } from '@/lib/rate-limit';
import { AI_CONSENT_PROVIDERS, AI_CONSENT_VERSION } from '@/lib/ai/consent';

const TABLE = 'external_data_consents';
let userCounter = 0;
const newUserId = () => `00000000-0000-4000-8000-${String(++userCounter).padStart(12, '0')}`;
const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type Row = Record<string, unknown>;

function grantedRows(userId: string, overrides: Row = {}): Row[] {
  return AI_CONSENT_PROVIDERS.map((provider) => ({
    id: crypto.randomUUID(),
    user_id: userId,
    provider,
    consented: true,
    consented_at: '2026-10-01T00:00:00.000Z',
    ip_address: '203.0.113.1',
    user_agent: 'old-ua',
    revoked_at: null,
    policy_version: AI_CONSENT_VERSION,
    ...overrides,
  }));
}

function setUpDb(rows: Row[]): SchemaCheckedDb {
  const db = createSchemaCheckedDb({ [TABLE]: rows });
  mocks.userFrom.mockImplementation(db.supabase.from);
  mocks.adminFrom.mockImplementation(db.supabase.from);
  return db;
}

function loginAs(userId: string | null) {
  mocks.getUser.mockResolvedValue(
    userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: { message: 'Auth session missing' } },
  );
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/ai/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = () => ({ version: AI_CONSENT_VERSION });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockClear();
});

describe('GET /api/ai/consent', () => {
  it('未ログインは 401。DB には触れない', async () => {
    loginAs(null);
    const db = setUpDb([]);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(db.calls).toHaveLength(0);
  });

  it('本人の同意の状況だけを返す。他人の行は混ざらず、IP アドレスと User-Agent は返さない', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb([...grantedRows(userId), ...grantedRows(OTHER, { ip_address: '198.51.100.99' })]);

    const res = await GET();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const json = JSON.parse(text);
    expect(json).toMatchObject({ version: AI_CONSENT_VERSION, consented: true, revokedAt: null });
    expect(json.providers.map((p: { provider: string; state: string }) => [p.provider, p.state])).toEqual(
      AI_CONSENT_PROVIDERS.map((p) => [p, 'granted']),
    );
    expect(text).not.toContain('198.51.100.99');
    expect(text).not.toContain('203.0.113.1');
    expect(text).not.toContain('old-ua');
  });

  it('同意の行が無ければ consented = false', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb([]);

    const json = await (await GET()).json();

    expect(json.consented).toBe(false);
    expect(json.providers.every((p: { state: string }) => p.state === 'none')).toBe(true);
  });

  it('読み取りは本人のクライアントで行う (service role は使わない)', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb(grantedRows(userId));

    await GET();

    expect(mocks.userFrom).toHaveBeenCalledWith(TABLE);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it('DB の失敗は 500。本文は汎用メッセージだけで、DB の生のエラー文は返さず、ログに残す', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);
    db.failNext(TABLE, 'select', pgError('XX000', 'relation "secret_internal_detail" exploded'));

    const res = await GET();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text).code).toBe('AI_CONSENT_STATUS_FAILED');
    expect(text).not.toContain('secret_internal_detail');
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/ai/consent', () => {
  it('未ログインは 401。DB にもレート制限にも触れない', async () => {
    loginAs(null);
    const db = setUpDb([]);

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(401);
    expect(db.calls).toHaveLength(0);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('3 事業者ぶんの同意を、現行の版・x-forwarded-for の先頭の IP・User-Agent つきで記録し、consented = true を返す', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);

    const res = await POST(
      postRequest(validBody(), { 'x-forwarded-for': '203.0.113.5, 10.0.0.1', 'user-agent': 'Mozilla/5.0 route-test' }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(json).toMatchObject({ version: AI_CONSENT_VERSION, consented: true });
    expect(db.tables[TABLE]).toHaveLength(3);
    for (const provider of AI_CONSENT_PROVIDERS) {
      expect(db.tables[TABLE].find((r) => r.provider === provider)).toMatchObject({
        user_id: userId,
        consented: true,
        ip_address: '203.0.113.5',
        user_agent: 'Mozilla/5.0 route-test',
        policy_version: AI_CONSENT_VERSION,
      });
    }
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'AI consent granted',
      expect.objectContaining({ version: AI_CONSENT_VERSION, consented: true }),
    );
  });

  it('書き込みは service role のクライアントで行い、本人のクライアントでは書かない', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb([]);

    await POST(postRequest(validBody()));

    expect(mocks.adminFrom).toHaveBeenCalledWith(TABLE);
    expect(mocks.userFrom).not.toHaveBeenCalled();
  });

  it('body の user_id / ip_address / user_agent / consented は無視する。対象は認証で確定した本人、IP と UA はヘッダーから取る', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);

    await POST(
      postRequest(
        { ...validBody(), user_id: OTHER, ip_address: '1.2.3.4', user_agent: 'forged', consented: false, provider: 'anthropic' },
        { 'x-forwarded-for': '203.0.113.6', 'user-agent': 'real-ua' },
      ),
    );

    expect(db.tables[TABLE]).toHaveLength(3);
    expect(db.tables[TABLE].every((r) => r.user_id === userId)).toBe(true);
    expect(db.tables[TABLE].every((r) => r.ip_address === '203.0.113.6' && r.user_agent === 'real-ua')).toBe(true);
    expect(db.tables[TABLE].every((r) => r.consented === true)).toBe(true);
    expect(db.tables[TABLE].map((r) => r.provider).sort()).toEqual([...AI_CONSENT_PROVIDERS].sort());
  });

  it('x-forwarded-for が不正な値でも、同意は記録する (IP アドレスは null)', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);

    const res = await POST(postRequest(validBody(), { 'x-forwarded-for': 'not an ip' }));

    expect(res.status).toBe(200);
    expect(db.tables[TABLE]).toHaveLength(3);
    expect(db.tables[TABLE].every((r) => r.ip_address === null)).toBe(true);
  });

  it('2 回押しても行は増えない (冪等)。最初の同意の日時と IP が残る', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);

    await POST(postRequest(validBody(), { 'x-forwarded-for': '203.0.113.7' }));
    const first = JSON.stringify(db.tables[TABLE]);
    const res = await POST(postRequest(validBody(), { 'x-forwarded-for': '198.51.100.7' }));

    expect(res.status).toBe(200);
    expect(JSON.stringify(db.tables[TABLE])).toBe(first);
  });

  it('古い版への同意が残っているときは、閉じて現行の版の行を作る', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb(grantedRows(userId, { policy_version: 'older-version' }));

    const json = await (await POST(postRequest(validBody()))).json();

    expect(json.consented).toBe(true);
    expect(db.tables[TABLE]).toHaveLength(6);
    expect(db.tables[TABLE].filter((r) => r.policy_version === 'older-version').every((r) => r.revoked_at)).toBe(true);
  });

  it('レート制限は ai-consent カテゴリでユーザー ID を単位に判定する', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb([]);

    await POST(postRequest(validBody()));

    expect(checkRateLimit).toHaveBeenCalledWith(userId, 'ai-consent');
  });

  it('連打は 429。何も書かない', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: Date.now() + 30_000, windowSec: 60 });

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
    expect(db.calls).toHaveLength(0);
  });

  it('レート制限の基盤が落ちているときは通さない (503)。何も書かない', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('ECONNREFUSED: upstash'));

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('AI_CONSENT_UNAVAILABLE');
    expect(db.calls).toHaveLength(0);
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it.each([
    ['本文なし', ''],
    ['JSON でない本文', 'version=x'],
    ['version なし', JSON.stringify({})],
    ['version が文字列でない', JSON.stringify({ version: 1 })],
    ['version が空', JSON.stringify({ version: '' })],
  ])('文面の版が指定されていなければ 400 (%s)。何も書かない', async (_label, body) => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);

    const res = await POST(postRequest(body));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('AI_CONSENT_BAD_REQUEST');
    expect(db.tables[TABLE]).toHaveLength(0);
  });

  it('画面に出した文面の版が古いときは 409 (現行の版を返す)。何も書かない', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);

    const res = await POST(postRequest({ version: 'older-version' }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ code: 'AI_CONSENT_VERSION_MISMATCH', currentVersion: AI_CONSENT_VERSION });
    expect(db.tables[TABLE]).toHaveLength(0);
  });

  it('DB の失敗は 500。本文は汎用メッセージだけで、DB の生のエラー文は返さず、ログに残す', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([]);
    db.failNext(TABLE, 'insert', pgError('XX000', 'password authentication failed for user "postgres_secret"'));

    const res = await POST(postRequest(validBody()));
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text).code).toBe('AI_CONSENT_GRANT_FAILED');
    expect(text).not.toContain('postgres_secret');
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/ai/consent/revoke', () => {
  it('未ログインは 401。DB には触れない', async () => {
    loginAs(null);
    const db = setUpDb([]);

    const res = await REVOKE();

    expect(res.status).toBe(401);
    expect(db.calls).toHaveLength(0);
  });

  it('本人の有効な同意だけに revoked_at を入れる。行は消さず、他人の行には触れない', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb([...grantedRows(userId), ...grantedRows(OTHER)]);

    const res = await REVOKE();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ consented: false, revokedCount: 3 });
    expect(json.revokedAt).toEqual(expect.any(String));
    expect(db.tables[TABLE]).toHaveLength(6);
    expect(db.tables[TABLE].filter((r) => r.user_id === userId).every((r) => typeof r.revoked_at === 'string')).toBe(true);
    expect(db.tables[TABLE].filter((r) => r.user_id === OTHER).every((r) => r.revoked_at === null)).toBe(true);
  });

  it('書き込みは service role のクライアントで行う。対象は認証で確定した本人で、回数制限はかけない', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb(grantedRows(userId));

    await REVOKE();

    expect(mocks.adminFrom).toHaveBeenCalledWith(TABLE);
    const update = db.calls.find((c) => c.op === 'update');
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        { kind: 'eq', column: 'user_id', value: userId },
        { kind: 'is', column: 'revoked_at', value: null },
      ]),
    );
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('有効な同意が無くても成功 (revokedCount = 0)。何も変えない', async () => {
    const userId = newUserId();
    loginAs(userId);
    const earlier = '2026-09-30T00:00:00.000Z';
    const db = setUpDb(grantedRows(userId, { revoked_at: earlier }));

    const res = await REVOKE();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.revokedCount).toBe(0);
    expect(db.tables[TABLE].every((r) => r.revoked_at === earlier)).toBe(true);
  });

  it('撤回のあとに GET すると consented = false。もう一度 POST すると同意できる', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb(grantedRows(userId));

    await REVOKE();
    expect((await (await GET()).json()).consented).toBe(false);
    const res = await POST(postRequest(validBody(), { 'x-forwarded-for': '203.0.113.9' }));

    expect((await res.json()).consented).toBe(true);
    expect(db.tables[TABLE]).toHaveLength(6);
  });

  it('DB の失敗は 500。本文は汎用メッセージだけで、DB の生のエラー文は返さず、ログに残す', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb(grantedRows(userId));
    db.failNext(TABLE, 'update', pgError('XX000', 'deadlock detected near "internal_table_xyz"'));

    const res = await REVOKE();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text).code).toBe('AI_CONSENT_REVOKE_FAILED');
    expect(text).not.toContain('internal_table_xyz');
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });
});
