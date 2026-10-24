/**
 * #1161 お知らせ API (GET / POST /api/announcements) の route テスト (これまでテストが無かった)
 *
 *  - GET ?mode=public は認証不要で、公開済み (is_public = true) のお知らせだけを返す
 *  - GET (管理用: mode=public 以外) と POST は、共通の requireRole(['admin', 'super_admin']) を通る。
 *    未ログインは 401、それ以外 (support を含む) は 403
 *  - POST は created_by に操作した人を入れ、公開するときだけ published_at を入れる。壊れた入力は 400
 *  - 500 の本文は汎用メッセージだけ。DB の生のエラー文は db-logger にだけ残す (#1172)
 *  - #1571: POST で作成できたときだけ、監査ログ (admin_audit_logs) に admin.announcement.create を本人の権限の client で 1 行残す
 *    (対象はお知らせ・details はお知らせの id と公開の状態だけで、タイトル・本文は入れない・ip_address は利用者の IP)。
 *    401 / 403 / 400 / 500 は記録しない。記録に失敗しても作成の応答は変えない (fail-open。失敗は db-logger に残る)
 *  - #1917: お知らせの INSERT は requireRole を通った後に service_role の client で書く (運営の直接の書き込みを塞いだ
 *    migration 20261024140000 の後は、本人のセッションでは書けない)。一覧は本人のセッションの client で読む
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

/**
 * どの client がどの表に触れたか (client の種類, 表)。
 * お知らせの書き込みは service_role だけ (運営の FOR ALL のポリシーを SELECT に絞った。migration 20261024140000。#1917)。
 * 監査ログは本人のセッションの client で書き (RLS の audit_logs_insert_admins)、管理用の一覧は本人のセッションの client で読む
 * (運営の SELECT のポリシー "Admins can view announcements")
 */
let tableAccesses: Array<['session' | 'service', string]> = [];

function recordingClient(kind: 'session' | 'service', user: FakeUser | null) {
  const client = makeClient(db, user);
  return {
    ...client,
    from: (table: string) => {
      tableAccesses.push([kind, table]);
      return client.from(table);
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => recordingClient('session', sessionUser),
  getSupabaseAdmin: () => recordingClient('service', null),
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
  tableAccesses = [];
  db = createSchemaDb({
    tables: {
      user_profiles: roles === null ? [] : [profileRow(ACTOR_ID, { roles })],
      announcements: options.announcements ?? [PUBLIC_ANNOUNCEMENT, DRAFT_ANNOUNCEMENT],
      admin_audit_logs: [],
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
    expect(await json(res)).toEqual({ error: 'ログインが必要です' });
    expect(db.recorded('announcements')).toHaveLength(0);
  });

  it.each(DENIED_ROLES)('403: %s ロールだけのユーザー。お知らせは読まない', async (role) => {
    setup({ roles: [role] });

    const res = await get();

    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'この操作を行う権限がありません' });
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
    expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました' });
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
    expect(await json(res)).toEqual({ error: 'ログインが必要です' });
    expect(db.recorded('announcements')).toHaveLength(0);
  });

  it.each(DENIED_ROLES)('403: %s ロールだけのユーザー。何も書かない', async (role) => {
    setup({ roles: [role] });

    const res = await post(body);

    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'この操作を行う権限がありません' });
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
    expect(await json(res)).toEqual({ error: 'タイトルと本文を入力してください' });
    expect(db.recorded('announcements', 'insert')).toHaveLength(0);
  });

  it('400: isPublic が真偽値でない', async () => {
    const res = await post({ title: 't', content: 'c', isPublic: 'yes' });

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: '公開の設定が正しくありません' });
    expect(db.recorded('announcements', 'insert')).toHaveLength(0);
  });

  it('400: JSON が壊れているときは 500 にしない', async () => {
    const res = await post('{ not json');

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'リクエストボディが不正です' });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('500: 保存に失敗したら汎用メッセージだけを返す', async () => {
    const raw = 'new row for relation "announcements" violates check constraint (secret detail)';
    setup({ errors: { announcements: { message: raw, code: '23514' } } });

    const res = await post(body);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました' });
    expect(text).not.toContain('secret detail');
    expect(mockLoggerError.mock.calls[0][0]).toBe('POST /api/announcements');
    expect((mockLoggerError.mock.calls[0][2] as Error).message).toBe(raw);
  });
});

describe('POST /api/announcements: 監査ログ (admin.announcement.create) (#1571)', () => {
  const CLIENT_IP = '203.0.113.15';
  const PROXY_IP = '10.0.0.1';
  const USER_AGENT = 'vitest-announcement-admin';
  const TITLE = 'audit-title-1571-do-not-log';
  const CONTENT = 'audit-content-1571-do-not-log';

  const postWithClient = (body: unknown) =>
    route.POST(
      jsonRequest('http://localhost/api/announcements', 'POST', body, {
        'x-forwarded-for': `${CLIENT_IP}, ${PROXY_IP}`,
        'user-agent': USER_AGENT,
      }),
    );
  const auditRows = () => db.rows('admin_audit_logs');

  it.each(ALLOWED_ROLES)('%s ロールで作成できたら、本人を actor にして 1 行だけ記録する (公開)', async (role) => {
    setup({ roles: [role] });

    const res = await postWithClient({ title: TITLE, content: CONTENT, isPublic: true });
    const created = (await json(res)).announcement;

    expect(res.status).toBe(200);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.announcement.create',
      target_id: created.id,
      target_type: 'announcement',
      severity: 'info',
      ip_address: CLIENT_IP,
      user_agent: USER_AGENT,
    });
    expect(auditRows()[0].details).toEqual({
      announcement_id: created.id,
      is_public: true,
      published_at: created.published_at,
    });
    expect(created.published_at).toEqual(expect.any(String));
  });

  it('公開しないお知らせは is_public: false・published_at: null で記録する', async () => {
    const res = await postWithClient({ title: TITLE, content: CONTENT, isPublic: false });
    const created = (await json(res)).announcement;

    expect(res.status).toBe(200);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].details).toEqual({ announcement_id: created.id, is_public: false, published_at: null });
  });

  it('タイトル・本文の中身は監査ログに入れない', async () => {
    await postWithClient({ title: TITLE, content: CONTENT, isPublic: true });

    const serialized = JSON.stringify(auditRows());
    expect(serialized).not.toContain(TITLE);
    expect(serialized).not.toContain(CONTENT);
  });

  it('401: 未ログインは記録しない', async () => {
    setup({ roles: null });

    const res = await postWithClient({ title: TITLE, content: CONTENT });

    expect(res.status).toBe(401);
    expect(auditRows()).toHaveLength(0);
  });

  it.each(DENIED_ROLES)('403: %s ロールは記録しない', async (role) => {
    setup({ roles: [role] });

    const res = await postWithClient({ title: TITLE, content: CONTENT });

    expect(res.status).toBe(403);
    expect(auditRows()).toHaveLength(0);
  });

  it.each([
    ['必須項目が足りない', { title: TITLE }],
    ['isPublic が真偽値でない', { title: TITLE, content: CONTENT, isPublic: 'yes' }],
    ['JSON が壊れている', '{ not json'],
  ])('400: %s ときは記録しない', async (_label, invalid) => {
    const res = await postWithClient(invalid);

    expect(res.status).toBe(400);
    expect(auditRows()).toHaveLength(0);
  });

  it('500: お知らせの保存に失敗したら記録しない', async () => {
    setup({ errors: { announcements: { message: 'insert failed', code: '23514' } } });

    const res = await postWithClient({ title: TITLE, content: CONTENT });

    expect(res.status).toBe(500);
    expect(db.recorded('admin_audit_logs', 'insert')).toHaveLength(0);
  });

  it('記録に失敗しても作成の応答は変えない (fail-open)。失敗は db-logger に残る', async () => {
    setup({ errors: { admin_audit_logs: { message: 'audit insert failed', code: '42501' } } });

    const res = await postWithClient({ title: TITLE, content: CONTENT, isPublic: true });
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.announcement).toMatchObject({ title: TITLE, content: CONTENT, created_by: ACTOR_ID });
    expect(db.rows('announcements')).toHaveLength(3);
    expect(db.recorded('admin_audit_logs', 'insert')).toHaveLength(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('POST /api/announcements');
    expect(mockLoggerError.mock.calls[0][1]).toBe('監査ログ (admin_audit_logs) への記録に失敗しました');
  });
});

describe('お知らせの書き込みは service_role だけ (運営の直接の書き込みを塞いだ。migration 20261024140000。#1917)', () => {
  const body = { title: '新機能のお知らせ', content: '本文です', isPublic: true };
  const accessesOf = (kind: 'session' | 'service') => tableAccesses.filter(([k]) => k === kind).map(([, table]) => table);

  it.each(ALLOWED_ROLES)('%s ロールの作成: お知らせは service_role の client で 1 回だけ書き、監査ログは本人のセッションの client で書く', async (role) => {
    setup({ roles: [role] });

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(accessesOf('service')).toEqual(['announcements']);
    expect(accessesOf('session')).not.toContain('announcements');
    expect(accessesOf('session')).toContain('admin_audit_logs');
    expect(db.recorded('announcements', 'insert')).toHaveLength(1);
    expect(db.recorded('admin_audit_logs', 'insert')).toHaveLength(1);
  });

  it.each([
    ['未ログイン', null, 401],
    ['support ロール', ['support'], 403],
    ['user ロール', ['user'], 403],
  ] as const)('%s (%#): service_role の client を使わない (認可の前に書かない)', async (_label, roles, status) => {
    setup({ roles: roles === null ? null : [...roles] });

    const res = await post(body);

    expect(res.status).toBe(status);
    expect(accessesOf('service')).toEqual([]);
    expect(db.recorded('announcements', 'insert')).toHaveLength(0);
  });

  it('400 (必須項目が足りない): service_role の client を使わない', async () => {
    const res = await post({ title: 't' });

    expect(res.status).toBe(400);
    expect(accessesOf('service')).toEqual([]);
  });

  it.each(ALLOWED_ROLES)('%s ロールの管理用の一覧は、本人のセッションの client で読む (service_role を使わない)', async (role) => {
    setup({ roles: [role] });

    const res = await get();

    expect(res.status).toBe(200);
    expect(accessesOf('session')).toContain('announcements');
    expect(accessesOf('service')).toEqual([]);
  });

  it('公開の一覧は、本人のセッションの client で読む (service_role を使わない)', async () => {
    setup({ roles: null });

    const res = await get('?mode=public');

    expect(res.status).toBe(200);
    expect(accessesOf('session')).toEqual(['announcements']);
    expect(accessesOf('service')).toEqual([]);
  });
});
