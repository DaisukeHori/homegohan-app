/**
 * #1161 お知らせ API (GET / POST /api/announcements) の route テスト (これまでテストが無かった)
 *
 *  - GET ?mode=public は認証不要で、公開済み (is_public = true) のお知らせだけを返す
 *  - GET (管理用: mode=public 以外) と POST は、共通の requireRole(['admin', 'super_admin']) を通る。
 *    未ログインは 401、それ以外 (support を含む) は 403
 *  - POST は created_by に操作した人を入れ、公開するときだけ published_at を入れる。壊れた入力は 400
 *  - 500 の本文は汎用メッセージだけ。DB の生のエラー文は db-logger にだけ残す (#1172)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type Row, type SchemaDb } from './helpers/schema-checked-db';
import { jsonRequest, makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';

const mockLoggerError = vi.fn();

vi.mock('@/lib/db-logger', () => ({
  createLogger: (routeName: string) => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(routeName, ...args),
    withUser: vi.fn(),
  }),
  generateRequestId: () => 'req_test',
}));

let sessionUser: FakeUser | null = null;
let db: SchemaDb;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(db, sessionUser),
  // お知らせは RLS (admin / super_admin は ALL、公開済みは誰でも SELECT) と同じ判定なので、service_role は使わない
  getSupabaseAdmin: () => {
    throw new Error('announcements route must not use the service role client');
  },
}));

const route = await import('@/app/api/announcements/route');

const ACTOR_ID = uuid(1);

const ALLOWED_ROLES = ['admin', 'super_admin'] as const;
// support は運営ロールだが、お知らせの管理はできない。org_admin は組織のロール
const DENIED_ROLES = ['user', 'support', 'sales', 'finance', 'content_moderator', 'org_admin'] as const;

const PUBLIC_ANNOUNCEMENT = { id: 'ann-public', title: '公開のお知らせ', content: '本文', is_public: true, created_at: '2026-10-02T00:00:00Z' };
const DRAFT_ANNOUNCEMENT = { id: 'ann-draft', title: '下書き', content: '社内向け', is_public: false, created_at: '2026-10-01T00:00:00Z' };

function setup(options: { roles?: string[] | null; errors?: Record<string, DbError>; announcements?: Row[] } = {}) {
  const roles = options.roles === undefined ? ['admin'] : options.roles;
  sessionUser = roles === null ? null : { id: ACTOR_ID };
  db = createSchemaDb({
    tables: {
      user_profiles: roles === null ? [] : [profileRow(ACTOR_ID, { roles })],
      announcements: options.announcements ?? [PUBLIC_ANNOUNCEMENT, DRAFT_ANNOUNCEMENT],
    },
    errors: options.errors,
  });
}

const get = (query = '') => route.GET(new Request(`http://localhost/api/announcements${query}`));
const post = (body: unknown) => route.POST(jsonRequest('http://localhost/api/announcements', 'POST', body));
const json = (res: Response) => res.json() as Promise<Record<string, any>>;

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

describe('GET /api/announcements?mode=public (一般公開用)', () => {
  it('未ログインでも 200。公開済みのお知らせだけを返す', async () => {
    setup({ roles: null });

    const res = await get('?mode=public');
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.announcements.map((a: Row) => a.id)).toEqual(['ann-public']);
    // ロールの確認 (user_profiles の読み出し) もしない
    expect(db.recorded('user_profiles')).toHaveLength(0);
  });

  it.each([...ALLOWED_ROLES, ...DENIED_ROLES])('%s ロールでも、公開済みのお知らせだけを返す', async (role) => {
    setup({ roles: [role] });

    const body = await json(await get('?mode=public'));

    expect(body.announcements.map((a: Row) => a.id)).toEqual(['ann-public']);
  });
});

describe('GET /api/announcements (管理用)', () => {
  it.each([['mode 指定なし', ''], ['mode=admin', '?mode=admin']])('401: 未ログイン (%s)', async (_label, query) => {
    setup({ roles: null });

    const res = await get(query);

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'Unauthorized' });
    expect(db.recorded('announcements')).toHaveLength(0);
  });

  it.each(DENIED_ROLES)('403: %s ロールだけのユーザー。お知らせは読まない', async (role) => {
    setup({ roles: [role] });

    const res = await get();

    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'Forbidden' });
    expect(db.recorded('announcements')).toHaveLength(0);
  });

  it.each(ALLOWED_ROLES)('200: %s ロールは、非公開を含む全てのお知らせを新しい順に読める', async (role) => {
    setup({ roles: [role] });

    const res = await get();
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.announcements.map((a: Row) => a.id)).toEqual(['ann-public', 'ann-draft']);
  });

  it('mode=public 以外の値 (PUBLIC など) は管理用として扱い、権限が要る', async () => {
    setup({ roles: ['user'] });

    const res = await get('?mode=PUBLIC');

    expect(res.status).toBe(403);
  });

  it('500: 取得に失敗したら汎用メッセージだけを返し、生のエラー文は db-logger にだけ残す', async () => {
    const raw = 'permission denied for table announcements (secret detail)';
    setup({ errors: { announcements: { message: raw, code: '42501' } } });

    const res = await get();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('secret detail');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('GET /api/announcements');
    expect((mockLoggerError.mock.calls[0][2] as Error).message).toBe(raw);
  });
});

describe('POST /api/announcements', () => {
  const body = { title: '新機能のお知らせ', content: '本文です', isPublic: true };

  it('401: 未ログイン。何も書かない', async () => {
    setup({ roles: null });

    const res = await post(body);

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'Unauthorized' });
    expect(db.recorded('announcements')).toHaveLength(0);
  });

  it.each(DENIED_ROLES)('403: %s ロールだけのユーザー。何も書かない', async (role) => {
    setup({ roles: [role] });

    const res = await post(body);

    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'Forbidden' });
    expect(db.recorded('announcements')).toHaveLength(0);
  });

  it.each(ALLOWED_ROLES)('200: %s ロールは作成できる。created_by は操作した人', async (role) => {
    setup({ roles: [role] });

    const res = await post(body);
    const json_ = await json(res);

    expect(res.status).toBe(200);
    expect(json_.announcement).toMatchObject({ title: body.title, content: body.content, is_public: true, created_by: ACTOR_ID });
    expect(json_.announcement.published_at).toEqual(expect.any(String));
    expect(db.rows('announcements')).toHaveLength(3);
  });

  it('公開しない (isPublic: false / 省略) お知らせには published_at を入れない', async () => {
    const draft = await json(await post({ title: 't', content: 'c', isPublic: false }));
    const omitted = await json(await post({ title: 't2', content: 'c2' }));

    expect(draft.announcement.is_public).toBe(false);
    expect(draft.announcement.published_at).toBeNull();
    // isPublic を省略すると is_public 列は DB の既定値 (false) に任せる
    expect(omitted.announcement.published_at).toBeNull();
  });

  it.each([
    ['title が無い', { content: 'c' }],
    ['title が空白', { title: '   ', content: 'c' }],
    ['content が無い', { title: 't' }],
    ['content が空', { title: 't', content: '' }],
    ['title が文字列でない', { title: 1, content: 'c' }],
    ['JSON が null', null],
  ])('400: 必須項目が足りない (%s)。何も書かない', async (_label, invalid) => {
    const res = await post(invalid);

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'title and content are required' });
    expect(db.recorded('announcements', 'insert')).toHaveLength(0);
  });

  it('400: isPublic が真偽値でない', async () => {
    const res = await post({ title: 't', content: 'c', isPublic: 'yes' });

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'isPublic must be a boolean' });
    expect(db.recorded('announcements', 'insert')).toHaveLength(0);
  });

  it('400: JSON が壊れているときは 500 にしない', async () => {
    const res = await post('{ not json');

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'Invalid JSON' });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('500: 保存に失敗したら汎用メッセージだけを返す', async () => {
    const raw = 'new row for relation "announcements" violates check constraint (secret detail)';
    setup({ errors: { announcements: { message: raw, code: '23514' } } });

    const res = await post(body);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('secret detail');
    expect(mockLoggerError.mock.calls[0][0]).toBe('POST /api/announcements');
    expect((mockLoggerError.mock.calls[0][2] as Error).message).toBe(raw);
  });
});
