/**
 * #1161 サポート画面の API (統計・ユーザー詳細・管理ノート) の route テスト
 *
 *   GET  /api/support/stats
 *   GET  /api/support/users/[id]
 *   GET  /api/support/users/[id]/notes
 *   POST /api/support/users/[id]/notes
 *
 * 確認すること:
 *  1. 認可: 共通の requireRole(['support', 'admin', 'super_admin']) を通る。未ログインは 401、
 *     それ以外のロール (user / sales / finance / content_moderator / org_admin …) は 403。
 *     401 / 403 のときは DB を一切読まず、監査ログも残さない。
 *  2. 認可の後は service_role で他ユーザーの行を読む。本人のセッションの client は RLS で自分の行しか見えず、
 *     サポート担当が他のユーザーを開くと 0 行 (= 500) になっていた。モックでも同じ状況にするため、
 *     セッションの client には「RLS で見える行」だけを、service_role の client には全ての行を入れている。
 *  3. mealCount は対象ユーザーが完了した食事だけ。planned_meals に user_id 列は無く、user_daily_meals!inner で絞る。
 *     絞らないと service_role では全ユーザー分を数える (以前は RLS のおかげで閲覧者本人の分が返っていた)。
 *  4. 監査ログは recordAdminAudit() 経由で、正しい列 (actor_id など) に 1 行入る。存在しない列 admin_id は使わない。
 *     stats の myResolvedThisWeek も actor_id で数える。
 *  5. 外部キーが無い関係 (inquiries -> user_profiles、admin_user_notes -> user_profiles) は埋め込まず、別クエリで引く。
 *  6. 500 の本文は汎用メッセージだけ。DB の生のエラー文は db-logger にだけ残す (#1172)。
 *
 * DB のモックは tests/helpers/schema-checked-db.ts。存在しない列・外部キーが無い埋め込みは、本物の PostgREST と
 * 同じエラーになるので、モックのテストをすり抜ける種類の不具合 (このチケットの対象) を検出できる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type Row, type SchemaDb } from './helpers/schema-checked-db';
import { jsonRequest, makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

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
let sessionDb: SchemaDb;
let adminDb: SchemaDb;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
  getSupabaseAdmin: () => makeClient(adminDb, null),
}));

const statsRoute = await import('@/app/api/support/stats/route');
const userRoute = await import('@/app/api/support/users/[id]/route');
const notesRoute = await import('@/app/api/support/users/[id]/notes/route');

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = uuid(1); // ログイン中のサポート担当 (または admin など)
const OTHER_STAFF_ID = uuid(2); // もう 1 人の運営スタッフ (ノートの書き手)
const TARGET_ID = uuid(3); // 閲覧される側のユーザー
const OTHER_USER_ID = uuid(4); // 無関係な別のユーザー
const MISSING_ID = uuid(99); // 存在しないユーザー

const SECRET_NICKNAME = '秘密のニックネーム太郎';
const SECRET_NOTE = '本人から電話あり、住所変更を希望';
const SECRET_SUBJECT = '持病のことで相談です';

const ALLOWED_ROLES = ['support', 'admin', 'super_admin'] as const;
// 運営系のロールでも、サポート画面は使えない。org_admin / org_* は組織のロールで、運営ではない
const DENIED_ROLES = ['user', 'sales', 'finance', 'content_moderator', 'org_admin', 'org_member', 'org_manager'] as const;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function worldTables(actorRoles: string[]): Record<string, Row[]> {
  return {
    user_profiles: [
      profileRow(ACTOR_ID, { nickname: '担当者A', roles: actorRoles }),
      profileRow(OTHER_STAFF_ID, { nickname: '担当者B', roles: ['support'] }),
      profileRow(TARGET_ID, {
        nickname: SECRET_NICKNAME,
        age_group: '30s',
        gender: 'female',
        is_banned: false,
        banned_at: null,
        banned_reason: null,
        last_login_at: '2026-10-01T00:00:00Z',
        login_count: 12,
        profile_completeness: 80,
        updated_at: '2026-10-02T00:00:00Z',
      }),
      profileRow(OTHER_USER_ID, { nickname: '別のユーザー' }),
    ],
    // 完了した食事: 対象 2 件 (+ 未完了 1 件)、別ユーザー 4 件、閲覧者本人 3 件。数がすべて違うので、誰の分を数えたかが分かる
    user_daily_meals: [
      { id: 'day-target-1', user_id: TARGET_ID },
      { id: 'day-target-2', user_id: TARGET_ID },
      { id: 'day-other', user_id: OTHER_USER_ID },
      { id: 'day-actor', user_id: ACTOR_ID },
    ],
    planned_meals: [
      { id: 'pm-t1', daily_meal_id: 'day-target-1', is_completed: true },
      { id: 'pm-t2', daily_meal_id: 'day-target-2', is_completed: true },
      { id: 'pm-t3', daily_meal_id: 'day-target-2', is_completed: false },
      ...[1, 2, 3, 4].map((n) => ({ id: `pm-o${n}`, daily_meal_id: 'day-other', is_completed: true })),
      ...[1, 2, 3].map((n) => ({ id: `pm-a${n}`, daily_meal_id: 'day-actor', is_completed: true })),
    ],
    ai_consultation_sessions: [
      { id: 'ai-t1', user_id: TARGET_ID, created_at: daysAgo(1) },
      { id: 'ai-t2', user_id: TARGET_ID, created_at: daysAgo(29) },
      { id: 'ai-t-old', user_id: TARGET_ID, created_at: daysAgo(45) },
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `ai-o${n}`, user_id: OTHER_USER_ID, created_at: daysAgo(1) })),
    ],
    inquiries: [
      { id: 'inq-1', user_id: TARGET_ID, inquiry_type: 'support', subject: SECRET_SUBJECT, status: 'pending', created_at: daysAgo(1), resolved_at: null },
      { id: 'inq-2', user_id: TARGET_ID, inquiry_type: 'bug', subject: '不具合', status: 'resolved', created_at: daysAgo(3), resolved_at: new Date().toISOString() },
      { id: 'inq-3', user_id: OTHER_USER_ID, inquiry_type: 'general', subject: '別の人の問い合わせ', status: 'in_progress', created_at: daysAgo(2), resolved_at: null },
      { id: 'inq-4', user_id: null, inquiry_type: 'feature', subject: 'ログインせずに送信', status: 'pending', created_at: daysAgo(4), resolved_at: null },
    ],
    admin_user_notes: [
      { id: 'note-1', user_id: TARGET_ID, admin_id: ACTOR_ID, note: SECRET_NOTE, created_at: daysAgo(2) },
      { id: 'note-2', user_id: TARGET_ID, admin_id: OTHER_STAFF_ID, note: '2 件目のノート', created_at: daysAgo(1) },
      { id: 'note-3', user_id: OTHER_USER_ID, admin_id: ACTOR_ID, note: '別のユーザーのノート', created_at: daysAgo(1) },
    ],
    admin_audit_logs: [],
  };
}

interface SetupOptions {
  /** ログイン中のユーザーのロール。null は未ログイン */
  roles?: string[] | null;
  /** service_role の client が返すエラー (テーブル名 -> エラー) */
  adminErrors?: Record<string, DbError>;
  /** 本人のセッションの client が返すエラー (テーブル名 -> エラー) */
  sessionErrors?: Record<string, DbError>;
  /** service_role の DB に足す行 (テーブル名 -> 行) */
  extraAdminRows?: Record<string, Row[]>;
}

function setup(options: SetupOptions = {}) {
  const roles = options.roles === undefined ? ['support'] : options.roles;
  const all = worldTables(roles ?? ['user']);
  for (const [table, rows] of Object.entries(options.extraAdminRows ?? {})) {
    all[table] = [...(all[table] ?? []), ...rows];
  }

  sessionUser = roles === null ? null : { id: ACTOR_ID, email: 'actor@example.com' };
  adminDb = createSchemaDb({ tables: all, errors: options.adminErrors });

  // 本人のセッションの client に見える行 (RLS):
  //  - user_profiles / 食事 / AI 相談: 本人の行だけ
  //  - inquiries / admin_user_notes: 運営ロールには全件を見せるポリシーがある
  //  - admin_audit_logs: INSERT は actor_id = auth.uid() の運営ロールだけ。SELECT は admin / super_admin だけ (support は何も見えない)
  const own = (table: string, column: string) => all[table].filter((row) => row[column] === ACTOR_ID);
  const ownDailyIds = new Set(all.user_daily_meals.filter((d) => d.user_id === ACTOR_ID).map((d) => d.id));
  sessionDb = createSchemaDb({
    tables: {
      user_profiles: own('user_profiles', 'id'),
      user_daily_meals: own('user_daily_meals', 'user_id'),
      planned_meals: all.planned_meals.filter((m) => ownDailyIds.has(m.daily_meal_id)),
      ai_consultation_sessions: own('ai_consultation_sessions', 'user_id'),
      inquiries: all.inquiries,
      admin_user_notes: all.admin_user_notes,
      admin_audit_logs: [],
    },
    errors: options.sessionErrors,
  });
}

const call = {
  stats: () => statsRoute.GET(new Request('http://localhost/api/support/stats')),
  user: (id = TARGET_ID, headers: Record<string, string> = {}) =>
    userRoute.GET(jsonRequest(`http://localhost/api/support/users/${id}`, 'GET', undefined, headers), { params: { id } }),
  notesGet: (id = TARGET_ID, headers: Record<string, string> = {}) =>
    notesRoute.GET(jsonRequest(`http://localhost/api/support/users/${id}/notes`, 'GET', undefined, headers), { params: { id } }),
  notesPost: (body: unknown, id = TARGET_ID, headers: Record<string, string> = {}) =>
    notesRoute.POST(jsonRequest(`http://localhost/api/support/users/${id}/notes`, 'POST', body, headers), { params: { id } }),
};

const json = (res: Response) => res.json() as Promise<Record<string, any>>;

/** どのテーブルも一度も読まれていない (401 / 403 / 入力エラーのとき) */
function expectNothingRead() {
  expect(adminDb.queries).toHaveLength(0);
  // 認可 (requireRole) は本人の user_profiles を読むだけ。それ以外のテーブルは触らない
  expect(sessionDb.queries.filter((q) => q.table !== 'user_profiles')).toHaveLength(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

// ─────────────────────────────────────────────────────────────────────────────
// 認可 (4 つの handler 共通)
// ─────────────────────────────────────────────────────────────────────────────

const handlers: Array<{ name: string; run: () => Promise<Response> }> = [
  { name: 'GET /api/support/stats', run: () => call.stats() },
  { name: 'GET /api/support/users/[id]', run: () => call.user() },
  { name: 'GET /api/support/users/[id]/notes', run: () => call.notesGet() },
  { name: 'POST /api/support/users/[id]/notes', run: () => call.notesPost({ note: 'メモ' }) },
];

describe.each(handlers)('認可: $name', ({ run }) => {
  it('401: 未ログイン。DB は何も読まない', async () => {
    setup({ roles: null });

    const res = await run();

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'Unauthorized' });
    expectNothingRead();
  });

  it.each(DENIED_ROLES)('403: %s ロールだけのユーザー。DB は何も読まず、監査ログも残さない', async (role) => {
    setup({ roles: [role] });

    const res = await run();

    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'Forbidden' });
    expectNothingRead();
    expect(sessionDb.rows('admin_audit_logs')).toHaveLength(0);
    expect(sessionDb.rows('admin_user_notes')).toHaveLength(3);
  });

  it.each(ALLOWED_ROLES)('許可: %s ロール', async (role) => {
    setup({ roles: [role] });

    const res = await run();

    expect(res.status).toBe(200);
  });

  it('許可: 複数のロールのうち 1 つが運営ロールなら通る (user + support)', async () => {
    setup({ roles: ['user', 'org_member', 'support'] });

    const res = await run();

    expect(res.status).toBe(200);
  });

  it('403: 凍結中のアカウントは、運営ロールを持っていても拒否する (requireRole の凍結判定)', async () => {
    setup({ roles: ['support'] });
    const frozen = profileRow(ACTOR_ID, { roles: ['support'], frozen_at: daysAgo(1), unban_at: null });
    sessionDb = createSchemaDb({ tables: { user_profiles: [frozen] } });

    const res = await run();

    expect(res.status).toBe(403);
    expect(adminDb.queries).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/support/users/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/support/users/[id]', () => {
  it('他のユーザーの詳細を返す (本人のセッションの client には対象が見えない状況でも)', async () => {
    // 前提の確認: セッションの client では、対象ユーザーは 0 行 (RLS)
    const rls = (await sessionDb.from('user_profiles').select('id').eq('id', TARGET_ID)) as { data: unknown[] };
    expect(rls.data).toEqual([]);

    const res = await call.user();
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.user).toMatchObject({
      id: TARGET_ID,
      nickname: SECRET_NICKNAME,
      ageGroup: '30s',
      gender: 'female',
      loginCount: 12,
      profileCompleteness: 80,
    });
    // 認可の後に service_role で読んでいる
    expect(adminDb.recorded('user_profiles')[0].eq).toContainEqual(['id', TARGET_ID]);
  });

  it('mealCount: 対象ユーザーが完了した食事だけを数える (閲覧者本人・別ユーザー・未完了は混ぜない)', async () => {
    const res = await call.user();
    const body = await json(res);

    // 対象 2 件。閲覧者本人の分 (3 件) でも、全ユーザーの完了分 (9 件) でも、未完了を含めた 3 件でもない
    expect(body.stats.mealCount).toBe(2);

    const query = adminDb.recorded('planned_meals')[0];
    expect(query.select).toContain('user_daily_meals!inner(user_id)');
    expect(query.eq).toContainEqual(['user_daily_meals.user_id', TARGET_ID]);
    expect(query.eq).toContainEqual(['is_completed', true]);
    expect(query.count).toBe(true);
    expect(query.head).toBe(true);
  });

  it('mealCount: 別のユーザーが食事を記録しても、対象の数は変わらない', async () => {
    setup({
      extraAdminRows: {
        user_daily_meals: [{ id: 'day-other-2', user_id: OTHER_USER_ID }],
        planned_meals: Array.from({ length: 10 }, (_, i) => ({
          id: `pm-extra-${i}`,
          daily_meal_id: 'day-other-2',
          is_completed: true,
        })),
      },
    });

    const body = await json(await call.user());

    expect(body.stats.mealCount).toBe(2);
  });

  it('対象が完了した食事が無ければ 0', async () => {
    const body = await json(await call.user(OTHER_STAFF_ID));

    expect(body.stats.mealCount).toBe(0);
    expect(body.stats.aiSessionCount).toBe(0);
  });

  it('aiSessionCount: 対象ユーザーの直近 30 日の相談だけ (別ユーザー・30 日より前は数えない)', async () => {
    const body = await json(await call.user());

    expect(body.stats.aiSessionCount).toBe(2);
  });

  it('問い合わせ履歴とノートは対象ユーザーのものだけ。レスポンスの形は従来どおり', async () => {
    const body = await json(await call.user());

    expect(body.inquiries.map((i: Row) => i.id)).toEqual(['inq-1', 'inq-2']);
    expect(body.inquiries[0]).toEqual({
      id: 'inq-1',
      inquiry_type: 'support',
      subject: SECRET_SUBJECT,
      status: 'pending',
      created_at: expect.any(String),
    });
    expect(body.notes.map((n: Row) => n.id)).toEqual(['note-2', 'note-1']); // 新しい順
    expect(body.notes[0]).toEqual({
      id: 'note-2',
      note: '2 件目のノート',
      created_at: expect.any(String),
      admin_id: OTHER_STAFF_ID,
    });
  });

  it('監査ログ: recordAdminAudit で正しい列に 1 行入る (actor_id・target_id・IP・User-Agent。admin_id は使わない)', async () => {
    const res = await call.user(TARGET_ID, { 'x-forwarded-for': '198.51.100.20, 10.0.0.1', 'user-agent': 'SupportApp/2.0' });

    expect(res.status).toBe(200);
    const rows = sessionDb.rows('admin_audit_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.user.view_support',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      ip_address: '198.51.100.20',
      user_agent: 'SupportApp/2.0',
    });
    expect(rows[0]).not.toHaveProperty('admin_id');
    // 監査ログは RLS (actor_id = auth.uid()) を通すため、本人のセッションの client で書く。service_role では書かない
    expect(adminDb.recorded('admin_audit_logs')).toHaveLength(0);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('監査ログの details は項目名だけ (ニックネーム・問い合わせ件名・ノート本文の値は入れない)', async () => {
    await call.user();

    const [row] = sessionDb.rows('admin_audit_logs');
    const serialized = JSON.stringify(row.details);
    expect(row.details.viewed_fields).toEqual(
      expect.arrayContaining(['user.nickname', 'user.ageGroup', 'stats', 'inquiries', 'notes']),
    );
    for (const secret of [SECRET_NICKNAME, SECRET_SUBJECT, SECRET_NOTE]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('監査ログの記録に失敗しても 200 のまま返し、db-logger に残す', async () => {
    setup({ sessionErrors: { admin_audit_logs: { message: 'permission denied for table admin_audit_logs', code: '42501' } } });

    const res = await call.user();

    expect(res.status).toBe(200);
    expect((await json(res)).user.id).toBe(TARGET_ID);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('api/support/users/[id] GET');
  });

  it('404: 存在しないユーザー (500 にしない)。監査ログは残さない', async () => {
    const res = await call.user(MISSING_ID);

    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'User not found' });
    expect(sessionDb.rows('admin_audit_logs')).toHaveLength(0);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('404: id が UUID の形式でないときは DB に問い合わせない (22P02 で 500 にしない)', async () => {
    const res = await call.user('not-a-uuid');

    expect(res.status).toBe(404);
    expectNothingRead();
  });

  it('500: DB の取得に失敗したら汎用メッセージだけを返し、生のエラー文は db-logger にだけ残す。監査ログは残さない', async () => {
    const raw = 'relation "ai_consultation_sessions" is broken: key (user_id)=(secret) conflicts';
    setup({ adminErrors: { ai_consultation_sessions: { message: raw, code: 'XX000' } } });

    const res = await call.user();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('ai_consultation_sessions');
    expect(text).not.toContain('secret');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [routeName, , error, metadata] = mockLoggerError.mock.calls[0];
    expect(routeName).toBe('GET /api/support/users/[id]');
    expect((error as Error).message).toBe(raw);
    expect(metadata).toMatchObject({ failed_queries: ['ai_consultation_sessions (count)'], error_code: 'XX000' });
    expect(sessionDb.rows('admin_audit_logs')).toHaveLength(0);
  });

  it('500: 対象ユーザーの取得に失敗したときも汎用メッセージ (404 にはしない)', async () => {
    setup({ adminErrors: { user_profiles: { message: 'connection reset by peer', code: '08006' } } });

    const res = await call.user();

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: 'Internal server error' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/support/users/[id]/notes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/support/users/[id]/notes', () => {
  it('対象ユーザーのノートを新しい順に返し、書いた人のニックネームを別クエリで引く', async () => {
    const res = await call.notesGet();
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.notes).toEqual([
      { id: 'note-2', note: '2 件目のノート', createdAt: expect.any(String), adminId: OTHER_STAFF_ID, adminName: '担当者B' },
      { id: 'note-1', note: SECRET_NOTE, createdAt: expect.any(String), adminId: ACTOR_ID, adminName: '担当者A' },
    ]);
  });

  it('user_profiles は埋め込まない (admin_user_notes.admin_id の外部キーは auth.users 宛で、PostgREST が解決できない)', async () => {
    await call.notesGet();

    for (const query of adminDb.recorded('admin_user_notes', 'select')) {
      expect(query.select).not.toContain('user_profiles');
    }
    // ニックネームは user_profiles を別に、書き手の id でまとめて引く (service_role。RLS では本人の行しか見えない)
    const authors = adminDb.recorded('user_profiles', 'select');
    expect(authors).toHaveLength(1);
    expect(authors[0].in).toEqual([['id', expect.arrayContaining([ACTOR_ID, OTHER_STAFF_ID])]]);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('書き手のプロフィールが無い (削除済み) ノートは Unknown 表示', async () => {
    setup({ extraAdminRows: { admin_user_notes: [{ id: 'note-4', user_id: TARGET_ID, admin_id: uuid(50), note: 'x', created_at: daysAgo(0) }] } });

    const body = await json(await call.notesGet());

    expect(body.notes[0]).toMatchObject({ id: 'note-4', adminName: 'Unknown' });
  });

  it('ノートを返したとき、閲覧を 1 行記録する (details は項目名だけでノート本文を含まない)', async () => {
    await call.notesGet(TARGET_ID, { 'x-forwarded-for': '198.51.100.30' });

    const rows = sessionDb.rows('admin_audit_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.user.view_notes',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      ip_address: '198.51.100.30',
    });
    expect(rows[0].details).toEqual({ viewed_fields: ['id', 'note', 'createdAt', 'adminId', 'adminName'] });
    expect(JSON.stringify(rows[0].details)).not.toContain(SECRET_NOTE);
  });

  it('ノートが 0 件のときは何も開示していないので記録しない', async () => {
    const body = await json(await call.notesGet(OTHER_STAFF_ID));

    expect(body.notes).toEqual([]);
    expect(sessionDb.rows('admin_audit_logs')).toHaveLength(0);
  });

  it('404: id が UUID の形式でないときは DB に問い合わせない', async () => {
    const res = await call.notesGet('not-a-uuid');

    expect(res.status).toBe(404);
    expectNothingRead();
  });

  it('500: 取得に失敗したら汎用メッセージだけを返す', async () => {
    const raw = 'duplicate key value violates unique constraint "admin_user_notes_pkey"';
    setup({ adminErrors: { admin_user_notes: { message: raw, code: '23505' } } });

    const res = await call.notesGet();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('admin_user_notes_pkey');
    expect((mockLoggerError.mock.calls[0][2] as Error).message).toBe(raw);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/support/users/[id]/notes
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/support/users/[id]/notes', () => {
  it('ノートを追加する: 前後の空白は除き、admin_id には操作した人を入れる', async () => {
    const res = await call.notesPost({ note: `  ${SECRET_NOTE}  ` });
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      note: { id: expect.any(String), note: SECRET_NOTE, createdAt: expect.any(String) },
    });
    const inserted = sessionDb.recorded('admin_user_notes', 'insert');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].values).toEqual({ user_id: TARGET_ID, admin_id: ACTOR_ID, note: SECRET_NOTE });
  });

  it('対象の存在確認は service_role で行う (セッションの client は RLS で他人の user_profiles が見えない)', async () => {
    await call.notesPost({ note: 'メモ' });

    expect(adminDb.recorded('user_profiles')[0].eq).toContainEqual(['id', TARGET_ID]);
    expect(sessionDb.recorded('user_profiles').filter((q) => q.eq.some(([, v]) => v === TARGET_ID))).toHaveLength(0);
  });

  it('監査ログ: actor_id・target_id・note_id を正しい列に 1 行記録する (存在しない列 admin_id は使わない)', async () => {
    const res = await call.notesPost({ note: SECRET_NOTE }, TARGET_ID, { 'x-forwarded-for': '198.51.100.40, 10.0.0.1' });
    const body = await json(res);

    const rows = sessionDb.rows('admin_audit_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.user.note_add',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      details: { note_id: body.note.id },
      // 複数 IP のまま渡すと inet 列への INSERT が失敗する
      ip_address: '198.51.100.40',
    });
    expect(rows[0]).not.toHaveProperty('admin_id');
    expect(JSON.stringify(rows[0].details)).not.toContain(SECRET_NOTE);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('監査ログの記録に失敗してもノート追加は成功のまま、失敗を db-logger に残す', async () => {
    setup({ sessionErrors: { admin_audit_logs: { message: 'permission denied for table admin_audit_logs', code: '42501' } } });

    const res = await call.notesPost({ note: 'メモ' });

    expect(res.status).toBe(200);
    expect((await json(res)).success).toBe(true);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('api/support/users/[id]/notes POST');
  });

  it.each([
    ['空文字', { note: '' }],
    ['空白だけ', { note: '   ' }],
    ['note が無い', {}],
    ['文字列でない', { note: 123 }],
    ['JSON が null', null],
  ])('400: ノートが空・不正 (%s)。何も書かない', async (_label, body) => {
    const res = await call.notesPost(body);

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'Note content is required' });
    expect(sessionDb.recorded('admin_user_notes')).toHaveLength(0);
    expect(sessionDb.rows('admin_audit_logs')).toHaveLength(0);
  });

  it('400: JSON が壊れているときは 500 にしない', async () => {
    const res = await call.notesPost('{ not json');

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'Invalid JSON' });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('404: 存在しないユーザーにはノートを書かない', async () => {
    const res = await call.notesPost({ note: 'メモ' }, MISSING_ID);

    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'User not found' });
    expect(sessionDb.recorded('admin_user_notes')).toHaveLength(0);
    expect(sessionDb.rows('admin_audit_logs')).toHaveLength(0);
  });

  it('404: id が UUID の形式でないときは DB に問い合わせない', async () => {
    const res = await call.notesPost({ note: 'メモ' }, 'not-a-uuid');

    expect(res.status).toBe(404);
    expectNothingRead();
  });

  it('500: ノートの保存に失敗したら汎用メッセージだけを返し、監査ログは残さない', async () => {
    const raw = 'insert or update on table "admin_user_notes" violates foreign key constraint';
    setup({ sessionErrors: { admin_user_notes: { message: raw, code: '23503' } } });

    const res = await call.notesPost({ note: 'メモ' });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('foreign key');
    expect((mockLoggerError.mock.calls[0][2] as Error).message).toBe(raw);
    expect(sessionDb.rows('admin_audit_logs')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/support/stats
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/support/stats', () => {
  it('問い合わせの件数と種別を集計する', async () => {
    const body = await json(await call.stats());

    expect(body.overview).toMatchObject({
      pendingInquiries: 2, // inq-1, inq-4
      inProgressInquiries: 1, // inq-3
      resolvedToday: 1, // inq-2
      totalInquiries: 4,
    });
    expect(body.inquiriesByType).toEqual({ support: 1, feature: 1 });
  });

  it('myResolvedThisWeek: 操作した人 (actor_id) が自分で、直近 7 日の resolve_inquiry だけを数える', async () => {
    setup({
      extraAdminRows: {
        admin_audit_logs: [
          { id: 'a1', actor_id: ACTOR_ID, action_type: 'resolve_inquiry', created_at: daysAgo(1) },
          { id: 'a2', actor_id: ACTOR_ID, action_type: 'resolve_inquiry', created_at: daysAgo(6) },
          { id: 'a3', actor_id: ACTOR_ID, action_type: 'resolve_inquiry', created_at: daysAgo(10) }, // 7 日より前
          { id: 'a4', actor_id: OTHER_STAFF_ID, action_type: 'resolve_inquiry', created_at: daysAgo(1) }, // 別の人
          { id: 'a5', actor_id: ACTOR_ID, action_type: 'admin.user.view_support', created_at: daysAgo(1) }, // 別の操作
        ],
      },
    });

    const res = await call.stats();
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.overview.myResolvedThisWeek).toBe(2);
    const query = adminDb.recorded('admin_audit_logs')[0];
    expect(query.eq).toContainEqual(['actor_id', ACTOR_ID]);
    expect(query.eq).toContainEqual(['action_type', 'resolve_inquiry']);
    // 存在しない列 admin_id は使わない (使うと PostgREST が 42703 で失敗し、以前は黙って 0 になっていた)
    expect(query.eq.map(([column]) => column)).not.toContain('admin_id');
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('myResolvedThisWeek: support ロールは admin_audit_logs を SELECT できない (RLS) ので service_role で数える', async () => {
    setup({
      extraAdminRows: { admin_audit_logs: [{ id: 'a1', actor_id: ACTOR_ID, action_type: 'resolve_inquiry', created_at: daysAgo(1) }] },
    });
    // 前提の確認: セッションの client では 0 件
    const rls = (await sessionDb.from('admin_audit_logs').select('*', { count: 'exact', head: true }).eq('actor_id', ACTOR_ID)) as {
      count: number;
    };
    expect(rls.count).toBe(0);

    const body = await json(await call.stats());

    expect(body.overview.myResolvedThisWeek).toBe(1);
  });

  it('recentInquiries: 投稿者のニックネームは user_profiles を別に引く (埋め込みは解決できない)。ログイン外は Guest', async () => {
    const res = await call.stats();
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.recentInquiries.map((i: Row) => [i.id, i.userName])).toEqual([
      ['inq-1', SECRET_NICKNAME],
      ['inq-3', '別のユーザー'],
      ['inq-2', SECRET_NICKNAME],
      ['inq-4', 'Guest'],
    ]);
    expect(body.recentInquiries[0]).toEqual({
      id: 'inq-1',
      inquiryType: 'support',
      subject: SECRET_SUBJECT,
      status: 'pending',
      createdAt: expect.any(String),
      userName: SECRET_NICKNAME,
    });
    for (const query of adminDb.recorded('inquiries', 'select')) {
      expect(query.select ?? '').not.toContain('user_profiles');
    }
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('500: 取得に失敗したら汎用メッセージだけを返す (以前は失敗を握りつぶして 0 件・空の一覧を返していた)', async () => {
    const raw = 'canceling statement due to statement timeout';
    setup({ adminErrors: { inquiries: { message: raw, code: '57014' } } });

    const res = await call.stats();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('statement timeout');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [routeName, , error, metadata] = mockLoggerError.mock.calls[0];
    expect(routeName).toBe('GET /api/support/stats');
    expect((error as Error).message).toBe(raw);
    expect(metadata.failed_queries).toContain('inquiries (pending count)');
  });

  it('500: 投稿者のニックネームの取得に失敗したときも汎用メッセージ', async () => {
    setup({ adminErrors: { user_profiles: { message: 'connection reset by peer', code: '08006' } } });

    const res = await call.stats();

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: 'Internal server error' });
  });
});
