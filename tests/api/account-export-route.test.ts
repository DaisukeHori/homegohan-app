/**
 * #1131 GET /api/account/export の route テスト
 *
 *   - 未ログインは 401 (DB には触れない)
 *   - 本人のデータだけが、ダウンロード用のヘッダー付きの JSON ストリームで返る
 *   - 連打は 429 (10 分に 5 回まで)。レート制限の基盤が落ちているときは通さない
 *   - 最初のテーブルの取得に失敗したら 500、ストリームの途中で失敗したら受け取り側を失敗させる
 *   - ログには件数などの要約だけを残し、データそのものは残さない
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_EXPORT_TABLES } from '@/lib/account-export-tables';
import { createFakePostgrest, type FakePostgrestOptions, type FakeRow } from '../helpers/fake-postgrest';

const mocks = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    getUser: vi.fn(),
    from: vi.fn(),
    logger,
    createLogger: vi.fn(),
    withUser: vi.fn(),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: (...args: unknown[]) => {
    mocks.createLogger(...args);
    return { ...mocks.logger, withUser: (id: string) => (mocks.withUser(id), mocks.logger) };
  },
  generateRequestId: () => 'req_test',
}));

// 実物のレート制限 (Upstash 未設定 = in-memory) を使い、基盤の障害だけ差し替えられるようにする
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...actual, checkRateLimit: vi.fn(actual.checkRateLimit) };
});

import { GET } from '@/app/api/account/export/route';
import { checkRateLimit } from '@/lib/rate-limit';

let userCounter = 0;
const newUserId = () => `00000000-0000-4000-8000-${String(++userCounter).padStart(12, '0')}`;
const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const RELATIONS: NonNullable<FakePostgrestOptions['relations']> = { user_badges: { badges: 'badge_id' } };
for (const t of ACCOUNT_EXPORT_TABLES) {
  if (t.scope.kind === 'parent') RELATIONS[t.table] = { [t.scope.parent]: t.scope.fk };
}

function setUpDb(userId: string, extra: Partial<FakePostgrestOptions> = {}) {
  const tables: Record<string, FakeRow[]> = {
    user_profiles: [
      { id: userId, nickname: 'テスト', roles: ['user'] },
      { id: OTHER, nickname: 'OTHER-secret-nickname', roles: ['user'] },
    ],
    meals: [
      { id: 'm-1', user_id: userId, memo: 'my-meal' },
      { id: 'm-2', user_id: OTHER, memo: 'OTHER-secret-meal' },
    ],
  };
  const db = createFakePostgrest({ tables, relations: RELATIONS, ...extra });
  mocks.from.mockImplementation(db.from);
  return db;
}

function loginAs(userId: string | null) {
  mocks.getUser.mockResolvedValue(
    userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: { message: 'Auth session missing' } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockClear();
});

describe('GET /api/account/export', () => {
  it('未ログインは 401。DB にもレート制限にも触れない', async () => {
    loginAs(null);
    const db = setUpDb(newUserId());

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(db.queries).toHaveLength(0);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('本人のデータだけを、ダウンロード用ヘッダー付きの JSON で返す', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb(userId);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="homegohan-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const text = await res.text();
    const json = JSON.parse(text);
    expect(json.user_id).toBe(userId);
    expect(json.data.user_profiles).toEqual([{ id: userId, nickname: 'テスト' }]);
    expect(json.data.meals).toEqual([{ id: 'm-1', user_id: userId, memo: 'my-meal' }]);
    expect(json.summary.complete).toBe(true);
    expect(text).not.toContain('OTHER');
  });

  it('レート制限は export カテゴリでユーザー ID を単位に判定する', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb(userId);

    await (await GET()).text();

    expect(checkRateLimit).toHaveBeenCalledWith(userId, 'export');
  });

  it('完了時に件数などの要約をログに残す。データそのもの (本文・ニックネーム等) は残さない', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb(userId);

    await (await GET()).text();

    expect(mocks.createLogger).toHaveBeenCalledWith('GET /api/account/export', 'req_test');
    expect(mocks.withUser).toHaveBeenCalledWith(userId);
    const completed = mocks.logger.info.mock.calls.find(([message]) => message === 'Account export completed');
    expect(completed).toBeDefined();
    const metadata = completed![1] as Record<string, unknown>;
    expect(metadata).toMatchObject({ complete: true, tables: ACCOUNT_EXPORT_TABLES.length, rows: 2, truncated_tables: [], skipped_tables: [] });
    expect(metadata.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain('my-meal');
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain('テスト');
  });

  it('10 分に 5 回まで。6 回目は 429 + Retry-After で、DB には触れない', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb(userId);

    for (let i = 0; i < 5; i++) {
      const ok = await GET();
      expect(ok.status).toBe(200);
      await ok.text();
    }
    const queriesBefore = db.queries.length;

    const limited = await GET();

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(db.queries.length).toBe(queriesBefore);
    expect(mocks.logger.warn).toHaveBeenCalledWith('Account export rate limited', expect.anything());
  });

  it('export カテゴリの上限は 10 分あたり 5 回 (ウィンドウは約 600 秒)', async () => {
    const userId = newUserId();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await checkRateLimit(userId, 'export'));

    expect(results.map((r) => r.success)).toEqual([true, true, true, true, true, false]);
    expect(results[5].limit).toBe(5);
    const waitSec = (results[5].reset - Date.now()) / 1000;
    expect(waitSec).toBeGreaterThan(590);
    expect(waitSec).toBeLessThanOrEqual(600);
  });

  it('レート制限はユーザーごとに独立している (他人が連打しても影響しない)', async () => {
    const heavy = newUserId();
    const light = newUserId();
    setUpDb(heavy);
    loginAs(heavy);
    for (let i = 0; i < 6; i++) await (await GET()).text();

    setUpDb(light);
    loginAs(light);
    const res = await GET();
    expect(res.status).toBe(200);
    await res.text();
  });

  it('レート制限の基盤が落ちていて判定できないときは、エクスポートせず 503 (fail-close)', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb(userId);
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('ECONNREFUSED: upstash'));

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
    expect(db.queries).toHaveLength(0);
    expect(mocks.logger.error).toHaveBeenCalledWith('Account export rate limit check failed', expect.any(Error));
  });

  it('最初のテーブルの取得に失敗したら、ストリームを始めず 500 を返す', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb(userId, { errors: { user_profiles: { message: 'permission denied for table user_profiles', code: '42501' } } });

    const res = await GET();

    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Disposition')).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ code: 'EXPORT_FAILED' });
    // DB のエラー本文は利用者に返さない (ログにだけ残す)
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(mocks.logger.error).toHaveBeenCalledWith('Account export failed before streaming', expect.any(Error));
  });

  it('ストリームの途中で失敗したら、受け取り側を失敗させる (欠けた JSON を完成品にしない)', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb(userId, { errors: { meals: { message: 'statement timeout', code: '57014' } } });

    const res = await GET();
    expect(res.status).toBe(200);

    await expect(res.text()).rejects.toThrow(/meals/);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Account export failed while streaming',
      expect.any(Error),
      expect.objectContaining({ bytes: expect.any(Number) }),
    );
  });

  it('途中で本人以外の行が混ざったら (絞り込みの不具合) ストリームを中止し、データは渡らない', async () => {
    const userId = newUserId();
    loginAs(userId);
    setUpDb(userId, { ignoreFilters: true });

    // 最初のテーブルで検知されるため、ヘッダー付きの 200 にもならない
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('OTHER');
    expect(mocks.logger.error).toHaveBeenCalledWith('Account export failed before streaming', expect.objectContaining({ name: 'ExportScopeViolationError' }));
  });

  it('受け取り側が途中で切断したら、以降のテーブルは取得しない', async () => {
    const userId = newUserId();
    loginAs(userId);
    const db = setUpDb(userId);

    const res = await GET();
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(db.queries.length).toBeLessThan(ACCOUNT_EXPORT_TABLES.length);
    expect(mocks.logger.warn).toHaveBeenCalledWith('Account export cancelled by the client', expect.anything());
  });
});
