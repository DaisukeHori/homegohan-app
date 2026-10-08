/**
 * #1161 組織 (/api/org/*) の管理系 API が、共通の requireOrgAdmin() だけで認可していることの route テスト
 *
 * 対象 (どれも「所属組織の org_role が owner / admin」のユーザーだけが使える):
 *   departments (GET / POST / PUT / DELETE)、members (GET / POST)、settings (GET / PUT)、stats (GET)、
 *   challenges (GET / POST / PUT)、invites (GET / POST / DELETE)、invites/[id]/revoke、members/[user_id]/remove
 *
 * 確認すること:
 *  1. 全ての handler で、未ログインは 401、組織に所属していない人・一般メンバー・
 *     roles 配列に org_admin が残っているだけの人 (#1235) は 403、owner / admin は成功する。
 *     401 / 403 の本文は route ごとの従来の形のまま (画面が読んでいる)。403 のときは DB の読み書きも RPC もしない。
 *  2. 組織の絞り込みは、呼び出した人のプロフィールの organization_id だけを使う (他組織の行は読めず・触れない)。
 *  3. 500 の本文は汎用メッセージだけ。DB の生のエラー文は db-logger にだけ残す (#1172)。壊れた JSON は 400。
 *
 * DB のモックは tests/helpers/schema-checked-db.ts (存在しない列・外部キーは本物の PostgREST と同じエラーになる)。
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

const mockRpc = vi.fn();
let sessionUser: FakeUser | null = null;
let sessionDb: SchemaDb;
let adminDb: SchemaDb;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser, mockRpc),
  getSupabaseAdmin: () => makeClient(adminDb, null),
}));

// 招待の作成 (RPC + メール送信 + 送信回数制限) は tests の別ファイルで確かめている。ここでは入口の認可だけを見る
const mockCreateOrgInvite = vi.fn();

vi.mock('@/lib/membership/org-invite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/membership/org-invite')>()),
  createOrgInviteWithEmail: (...args: unknown[]) => mockCreateOrgInvite(...args),
}));

const departments = await import('@/app/api/org/departments/route');
const members = await import('@/app/api/org/members/route');
const settings = await import('@/app/api/org/settings/route');
const stats = await import('@/app/api/org/stats/route');
const challenges = await import('@/app/api/org/challenges/route');
const invites = await import('@/app/api/org/invites/route');
const revoke = await import('@/app/api/org/invites/[id]/revoke/route');
const removeMember = await import('@/app/api/org/members/[user_id]/remove/route');

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ORG_A = uuid(100);
const ORG_B = uuid(200);

const OWNER_A = uuid(1);
const ADMIN_A = uuid(2);
const MEMBER_A = uuid(3);
const RESIDUAL_IN_ORG = uuid(4); // 別の組織で org_admin だった名残が roles に残り、この組織には一般メンバーとして所属
const RESIDUAL_NO_ORG = uuid(5); // roles に org_admin が残っているだけで、どの組織にも所属していない
const OUTSIDER = uuid(6); // 組織に所属していない一般ユーザー
const OWNER_B = uuid(7);

const DEPT_A = uuid(301);
const DEPT_B = uuid(302);
const CHALLENGE_A = uuid(401);
const CHALLENGE_B = uuid(402);
const INVITE_A = uuid(501);
const INVITE_B = uuid(502);

function worldTables(): Record<string, Row[]> {
  return {
    user_profiles: [
      profileRow(OWNER_A, { nickname: '山田オーナー', organization_id: ORG_A, org_role: 'owner', roles: ['user'] }),
      profileRow(ADMIN_A, { nickname: '佐藤管理者', organization_id: ORG_A, org_role: 'admin', roles: ['user'], department_id: DEPT_A }),
      profileRow(MEMBER_A, { nickname: '鈴木メンバー', organization_id: ORG_A, org_role: 'member', roles: ['user'], department_id: DEPT_A }),
      profileRow(RESIDUAL_IN_ORG, { nickname: '高橋', organization_id: ORG_A, org_role: 'member', roles: ['user', 'org_admin'] }),
      profileRow(RESIDUAL_NO_ORG, { nickname: '田中', roles: ['user', 'org_admin'] }),
      profileRow(OUTSIDER, { nickname: '伊藤' }),
      profileRow(OWNER_B, { nickname: '渡辺他組織', organization_id: ORG_B, org_role: 'owner', roles: ['user'] }),
    ],
    organizations: [
      { id: ORG_A, name: 'A 株式会社', plan: 'standard', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      { id: ORG_B, name: 'B 株式会社', plan: 'premium', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
    ],
    departments: [
      { id: DEPT_A, organization_id: ORG_A, name: 'A の営業部', parent_id: null, manager_id: null, display_order: 1, created_at: '2026-02-01T00:00:00Z' },
      { id: DEPT_B, organization_id: ORG_B, name: 'B の開発部', parent_id: null, manager_id: null, display_order: 1, created_at: '2026-02-02T00:00:00Z' },
    ],
    organization_challenges: [
      { id: CHALLENGE_A, organization_id: ORG_A, title: 'A の歩数チャレンジ', description: null, challenge_type: 'steps', target_value: 10000, target_unit: 'steps', start_date: '2026-10-01', end_date: '2026-10-31', reward_description: null, status: 'active', department_id: DEPT_A, created_at: '2026-09-01T00:00:00Z' },
      { id: CHALLENGE_B, organization_id: ORG_B, title: 'B のチャレンジ', description: null, challenge_type: 'steps', target_value: 1, target_unit: 'steps', start_date: '2026-10-01', end_date: '2026-10-31', reward_description: null, status: 'active', department_id: null, created_at: '2026-09-02T00:00:00Z' },
    ],
    organization_challenge_participants: [
      { id: 'p1', challenge_id: CHALLENGE_A, user_id: MEMBER_A },
      { id: 'p2', challenge_id: CHALLENGE_A, user_id: ADMIN_A },
      { id: 'p3', challenge_id: CHALLENGE_B, user_id: OWNER_B },
    ],
    organization_invites: [
      { id: INVITE_A, organization_id: ORG_A, email: 'a-invitee@example.com', role: 'member', department_id: null, token: 'token-a', expires_at: '2099-01-01T00:00:00Z', accepted_at: null, created_at: '2026-10-01T00:00:00Z' },
      { id: INVITE_B, organization_id: ORG_B, email: 'b-invitee@example.com', role: 'member', department_id: null, token: 'token-b', expires_at: '2099-01-01T00:00:00Z', accepted_at: null, created_at: '2026-10-02T00:00:00Z' },
    ],
  };
}

function setup(options: { actor?: string | null; errors?: Record<string, DbError> } = {}) {
  const actor = options.actor === undefined ? OWNER_A : options.actor;
  sessionUser = actor === null ? null : { id: actor, email: 'actor@example.com' };
  sessionDb = createSchemaDb({ tables: worldTables(), errors: options.errors });
  adminDb = createSchemaDb({ tables: worldTables() });
}

/**
 * 認可 (プロフィールの確認 = 最初の DB 読み出し) の後の、最初の DB 呼び出しで例外を投げる。
 * 認可は通り、その後の処理で想定外の失敗が起きた状況の再現
 */
function failAfterAuthorization(message: string) {
  const original = sessionDb.from;
  let calls = 0;
  sessionDb = {
    ...sessionDb,
    from: vi.fn((table: string) => {
      if (++calls > 1) throw new Error(message);
      return original(table);
    }) as unknown as SchemaDb['from'],
  };
}

/**
 * service_role の client (認可のあとで使う) の最初の DB 呼び出しで例外を投げる。
 * 認可は通り、service_role での読み出しで想定外の失敗が起きた状況の再現
 */
function failAdminAfterAuthorization(message: string) {
  adminDb = {
    ...adminDb,
    from: vi.fn(() => {
      throw new Error(message);
    }) as unknown as SchemaDb['from'],
  };
}

const json = (res: Response) => res.json() as Promise<any>;
const url = (path: string) => `http://localhost${path}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockCreateOrgInvite.mockImplementation(async (params: { email: string; role: string }) => ({
    ok: true,
    invite: { id: uuid(900), email: params.email, role: params.role, status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: 'http://localhost/invite/x' },
  }));
  setup();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 認可 (全ての handler)
// ─────────────────────────────────────────────────────────────────────────────

type Flavor = 'plain' | 'coded' | 'invite';

interface Endpoint {
  name: string;
  call: () => Promise<Response>;
  /** 成功時のステータス */
  success: number;
  /** 401 / 403 の本文の形 (route ごとに従来の形のまま) */
  flavor: Flavor;
  /** flavor が invite のときの 403 のメッセージ */
  forbiddenMessage?: string;
}

const endpoints: Endpoint[] = [
  { name: 'GET /api/org/departments', call: () => departments.GET(), success: 200, flavor: 'coded' },
  {
    name: 'POST /api/org/departments',
    call: () => departments.POST(jsonRequest(url('/api/org/departments'), 'POST', { name: '新しい部署' }) as never),
    success: 201,
    flavor: 'coded',
  },
  {
    name: 'PUT /api/org/departments',
    call: () => departments.PUT(jsonRequest(url('/api/org/departments'), 'PUT', { id: DEPT_A, name: '改名' }) as never),
    success: 200,
    flavor: 'coded',
  },
  {
    name: 'DELETE /api/org/departments',
    call: () => departments.DELETE(jsonRequest(url(`/api/org/departments?id=${DEPT_A}`), 'DELETE') as never),
    success: 200,
    flavor: 'coded',
  },
  { name: 'GET /api/org/members', call: () => members.GET(new Request(url('/api/org/members'))), success: 200, flavor: 'plain' },
  {
    name: 'POST /api/org/members',
    call: () => members.POST(jsonRequest(url('/api/org/members'), 'POST', { email: 'new@example.com' })),
    success: 201,
    flavor: 'invite',
    forbiddenMessage: 'owner/admin のみ招待可能です',
  },
  { name: 'GET /api/org/settings', call: () => settings.GET(), success: 200, flavor: 'coded' },
  {
    name: 'PUT /api/org/settings',
    call: () => settings.PUT(jsonRequest(url('/api/org/settings'), 'PUT', { name: '新しい組織名' })),
    success: 200,
    flavor: 'coded',
  },
  { name: 'GET /api/org/stats', call: () => stats.GET(), success: 200, flavor: 'coded' },
  { name: 'GET /api/org/challenges', call: () => challenges.GET(new Request(url('/api/org/challenges'))), success: 200, flavor: 'plain' },
  {
    name: 'POST /api/org/challenges',
    call: () =>
      challenges.POST(
        jsonRequest(url('/api/org/challenges'), 'POST', {
          title: '新チャレンジ',
          challengeType: 'steps',
          startDate: '2026-11-01',
          endDate: '2026-11-30',
        }),
      ),
    success: 200,
    flavor: 'plain',
  },
  {
    name: 'PUT /api/org/challenges',
    call: () => challenges.PUT(jsonRequest(url('/api/org/challenges'), 'PUT', { id: CHALLENGE_A, title: '改名' })),
    success: 200,
    flavor: 'plain',
  },
  { name: 'GET /api/org/invites', call: () => invites.GET(new Request(url('/api/org/invites'))), success: 200, flavor: 'plain' },
  {
    name: 'POST /api/org/invites',
    call: () => invites.POST(jsonRequest(url('/api/org/invites'), 'POST', { email: 'new@example.com', role: 'member' })),
    success: 200,
    flavor: 'invite',
    forbiddenMessage: 'owner/admin のみ招待可能です',
  },
  {
    name: 'DELETE /api/org/invites',
    call: () => invites.DELETE(jsonRequest(url(`/api/org/invites?id=${INVITE_A}`), 'DELETE')),
    success: 200,
    flavor: 'plain',
  },
  {
    name: 'POST /api/org/invites/[id]/revoke',
    call: () => revoke.POST(jsonRequest(url(`/api/org/invites/${INVITE_A}/revoke`), 'POST'), { params: Promise.resolve({ id: INVITE_A }) }),
    success: 200,
    flavor: 'invite',
    forbiddenMessage: 'owner/admin のみ取消可能です',
  },
  {
    name: 'POST /api/org/members/[user_id]/remove',
    call: () =>
      removeMember.POST(jsonRequest(url(`/api/org/members/${MEMBER_A}/remove`), 'POST'), { params: { user_id: MEMBER_A } }),
    success: 200,
    flavor: 'invite',
    forbiddenMessage: 'owner/admin のみ除名可能です',
  },
];

function expectedUnauthenticatedBody(endpoint: Endpoint) {
  switch (endpoint.flavor) {
    case 'plain':
      return { error: 'Unauthorized' };
    case 'coded':
      return { error: { code: 'UNAUTHORIZED', message: 'AUTH_UNAUTHENTICATED' } };
    case 'invite':
      return { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } };
  }
}

function expectedForbiddenBody(endpoint: Endpoint) {
  switch (endpoint.flavor) {
    case 'plain':
      return { error: 'Forbidden' };
    case 'coded':
      return { error: { code: 'FORBIDDEN', message: 'owner/admin role required' } };
    case 'invite':
      return { error: { code: 'INSUFFICIENT_PERMISSION', message: endpoint.forbiddenMessage } };
  }
}

/** 認可を通っていないので、プロフィールの確認以外は DB を読み書きせず、RPC・招待の作成も呼ばない */
function expectNothingDone() {
  expect(sessionDb.queries.filter((q) => q.table !== 'user_profiles')).toHaveLength(0);
  expect(sessionDb.queries.filter((q) => q.table === 'user_profiles' && q.op !== 'select')).toHaveLength(0);
  expect(adminDb.queries).toHaveLength(0);
  expect(mockRpc).not.toHaveBeenCalled();
  expect(mockCreateOrgInvite).not.toHaveBeenCalled();
}

describe.each(endpoints)('認可: $name', (endpoint) => {
  it('401: 未ログイン。本文は従来の形のまま', async () => {
    setup({ actor: null });

    const res = await endpoint.call();

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual(expectedUnauthenticatedBody(endpoint));
    expect(sessionDb.queries).toHaveLength(0);
    expectNothingDone();
  });

  it.each([
    ['組織の一般メンバー (org_role = member)', MEMBER_A],
    ['別の組織の管理者だった名残の org_admin が roles に残る一般メンバー (#1235)', RESIDUAL_IN_ORG],
    ['どの組織にも所属しない org_admin (roles だけ)', RESIDUAL_NO_ORG],
    ['組織に所属していない一般ユーザー', OUTSIDER],
  ])('403: %s', async (_label, actor) => {
    setup({ actor });

    const res = await endpoint.call();

    expect(res.status).toBe(403);
    expect(await json(res)).toEqual(expectedForbiddenBody(endpoint));
    expectNothingDone();
  });

  it('403: プロフィールを読めない (行が無い) ユーザー', async () => {
    setup({ actor: uuid(777) });

    const res = await endpoint.call();

    expect(res.status).toBe(403);
    expectNothingDone();
  });

  it.each([
    ['owner', OWNER_A],
    ['admin', ADMIN_A],
  ])('成功: 組織の %s', async (_label, actor) => {
    setup({ actor });

    const res = await endpoint.call();

    expect(res.status).toBe(endpoint.success);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

describe('認可の判定は org_role だけで行う (roles 配列の org_admin は見ない)', () => {
  it('roles に org_admin が無くても、org_role が admin なら使える', async () => {
    setup({ actor: ADMIN_A });

    expect((await settings.GET()).status).toBe(200);
  });

  it('roles に org_admin があっても、org_role が member なら使えない', async () => {
    setup({ actor: RESIDUAL_IN_ORG });

    expect((await settings.GET()).status).toBe(403);
  });

  it('org_role が admin でも organization_id が空なら使えない (所属の無い行)', async () => {
    setup();
    sessionDb = createSchemaDb({ tables: { user_profiles: [profileRow(OWNER_A, { organization_id: null, org_role: 'admin' })] } });

    expect((await settings.GET()).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 組織の絞り込み: 呼び出した人の所属組織だけ
// ─────────────────────────────────────────────────────────────────────────────

describe('組織の絞り込み: 呼び出した人の organization_id だけを使う', () => {
  it('departments GET: 自組織の部署だけを返す。人数は service_role で集計した自組織のメンバー数', async () => {
    const res = await departments.GET();
    const body = await json(res);

    expect(body.departments).toEqual([
      { id: DEPT_A, name: 'A の営業部', parentId: null, managerId: null, displayOrder: 1, memberCount: 2, createdAt: expect.any(String) },
    ]);

    setup({ actor: OWNER_B });
    const other = await json(await departments.GET());
    expect(other.departments.map((d: Row) => d.id)).toEqual([DEPT_B]);
    expect(other.departments[0].memberCount).toBe(0);
  });

  it('departments PUT / DELETE: 他組織の部署 id を指定しても変更・削除できない (404)', async () => {
    const put = await departments.PUT(jsonRequest(url('/api/org/departments'), 'PUT', { id: DEPT_B, name: '乗っ取り' }) as never);
    const del = await departments.DELETE(jsonRequest(url(`/api/org/departments?id=${DEPT_B}`), 'DELETE') as never);

    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
    expect(sessionDb.rows('departments').find((d) => d.id === DEPT_B)?.name).toBe('B の開発部');
  });

  it('departments POST: 作成する部署は呼び出した人の組織に属す (リクエストの organization_id は使わない)', async () => {
    const res = await departments.POST(
      jsonRequest(url('/api/org/departments'), 'POST', { name: '新部署', organization_id: ORG_B }) as never,
    );

    expect(res.status).toBe(201);
    const inserted = sessionDb.recorded('departments', 'insert')[0];
    expect(inserted.values).toEqual({ name: '新部署', organization_id: ORG_A });
  });

  it('members GET: 自組織のメンバーだけを返し、読む列は限定されている。読むのは認可のあとの service_role', async () => {
    const body = await json(await members.GET(new Request(url('/api/org/members'))));

    expect(body.members.map((m: Row) => m.id).sort()).toEqual([OWNER_A, ADMIN_A, MEMBER_A, RESIDUAL_IN_ORG].sort());
    // user_profiles は RLS で本人の行しか見えない。利用者の権限で読むと組織に何人いても管理者 1 人になるため、
    // 認可のあとに service_role で、呼び出した管理者の組織だけを読む (詳しくは tests/org-members-list-route.test.ts)
    const listed = adminDb.recorded('user_profiles', 'select');
    expect(listed).toHaveLength(1);
    expect(listed[0].eq).toEqual([['organization_id', ORG_A]]);
    expect(listed[0].select).toBe('id, nickname, roles, org_role, joined_org_at, created_at');
    // 利用者の権限で読んだのは、認可のための自分のプロフィールだけ
    expect(sessionDb.recorded('user_profiles', 'select').every((q) => q.eq.some(([column, value]) => column === 'id' && value === OWNER_A))).toBe(true);
  });

  it('members POST: 招待の組織・差出人は認可で確定した値 (本文の organization_id や nickname は使わない)', async () => {
    setup({ actor: ADMIN_A });

    const res = await members.POST(
      jsonRequest(url('/api/org/members'), 'POST', { email: 'new@example.com', organization_id: ORG_B, password: 'ignored' }),
    );

    expect(res.status).toBe(201);
    expect(mockCreateOrgInvite).toHaveBeenCalledTimes(1);
    const params = mockCreateOrgInvite.mock.calls[0][0];
    expect(params).toMatchObject({
      organizationId: ORG_A,
      email: 'new@example.com',
      role: 'member',
      inviter: { id: ADMIN_A, email: 'actor@example.com', nickname: '佐藤管理者' },
    });
    expect(JSON.stringify(params)).not.toContain(ORG_B);
    expect(JSON.stringify(params)).not.toContain('ignored');
  });

  it('settings GET / PUT: 自組織だけを読み・更新する', async () => {
    const got = await json(await settings.GET());
    const put = await settings.PUT(jsonRequest(url('/api/org/settings'), 'PUT', { name: '新しい組織名', id: ORG_B }));

    expect(got.data).toMatchObject({ id: ORG_A, name: 'A 株式会社' });
    expect(put.status).toBe(200);
    expect(sessionDb.rows('organizations').find((o) => o.id === ORG_A)?.name).toBe('新しい組織名');
    expect(sessionDb.rows('organizations').find((o) => o.id === ORG_B)?.name).toBe('B 株式会社');
  });

  it('stats GET: 自組織のメンバー数。人数は認可のあとに service_role で、呼び出した管理者の組織だけを数える', async () => {
    const body = await json(await stats.GET());

    expect(body.stats).toEqual({ member_count: 4, organization_id: ORG_A });
    // user_profiles は RLS で本人の行しか見えない。利用者の権限で数えると、組織の人数に関わらず常に 1 になってしまう
    const counted = adminDb.recorded('user_profiles', 'select');
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ select: 'id', count: true, head: true });
    expect(counted[0].eq).toEqual([['organization_id', ORG_A]]);
    // 利用者の権限で読んだのは、認可のためのプロフィールだけ (件数は数えていない)
    expect(sessionDb.recorded('user_profiles', 'select').filter((q) => q.count)).toHaveLength(0);
  });

  it('challenges GET: 自組織のチャレンジだけ。参加者数と部署名つき', async () => {
    const body = await json(await challenges.GET(new Request(url('/api/org/challenges'))));

    expect(body.challenges).toHaveLength(1);
    expect(body.challenges[0]).toMatchObject({
      id: CHALLENGE_A,
      title: 'A の歩数チャレンジ',
      participantCount: 2,
      departmentName: 'A の営業部',
    });
  });

  it('challenges POST / PUT: 作成は自組織・操作した人で、他組織のチャレンジは更新できない', async () => {
    const created = await challenges.POST(
      jsonRequest(url('/api/org/challenges'), 'POST', {
        title: '新チャレンジ',
        challengeType: 'steps',
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        organization_id: ORG_B,
      }),
    );
    const updated = await challenges.PUT(jsonRequest(url('/api/org/challenges'), 'PUT', { id: CHALLENGE_B, title: '乗っ取り' }));

    expect(created.status).toBe(200);
    expect(sessionDb.recorded('organization_challenges', 'insert')[0].values).toMatchObject({
      organization_id: ORG_A,
      created_by: OWNER_A,
      status: 'draft',
    });
    expect(updated.status).toBe(200);
    expect(sessionDb.rows('organization_challenges').find((c) => c.id === CHALLENGE_B)?.title).toBe('B のチャレンジ');
  });

  it('invites GET / DELETE: 自組織の招待だけ。他組織の招待は消せない', async () => {
    const list = await json(await invites.GET(new Request(url('/api/org/invites'))));
    const del = await invites.DELETE(jsonRequest(url(`/api/org/invites?id=${INVITE_B}`), 'DELETE'));

    expect(list.invites.map((i: Row) => i.id)).toEqual([INVITE_A]);
    expect(del.status).toBe(200);
    expect(sessionDb.rows('organization_invites').map((i) => i.id).sort()).toEqual([INVITE_A, INVITE_B].sort());
  });

  it('invites POST: 招待の組織・差出人は認可で確定した値', async () => {
    setup({ actor: ADMIN_A });

    await invites.POST(jsonRequest(url('/api/org/invites'), 'POST', { email: 'new@example.com', role: 'admin', organization_id: ORG_B }));

    const params = mockCreateOrgInvite.mock.calls[0][0];
    expect(params).toMatchObject({ organizationId: ORG_A, role: 'admin', inviter: { id: ADMIN_A, nickname: '佐藤管理者' } });
    expect(JSON.stringify(params)).not.toContain(ORG_B);
  });

  it('members/[user_id]/remove: 自組織の id で RPC を呼ぶ', async () => {
    await removeMember.POST(jsonRequest(url(`/api/org/members/${MEMBER_A}/remove`), 'POST'), { params: { user_id: MEMBER_A } });

    expect(mockRpc).toHaveBeenCalledWith('remove_org_member', { p_organization_id: ORG_A, p_user_id: MEMBER_A });
  });

  it('invites/[id]/revoke: RPC を呼ぶ。RPC の失敗は従来どおりエラーコード付きで返す', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'INVITE_NOT_FOUND' } });

    const res = await revoke.POST(jsonRequest(url(`/api/org/invites/${INVITE_A}/revoke`), 'POST'), {
      params: Promise.resolve({ id: INVITE_A }),
    });

    expect(mockRpc).toHaveBeenCalledWith('revoke_org_invite', { p_invite_id: INVITE_A });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await json(res)).error.code).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 500 は汎用メッセージ / 壊れた JSON は 400
// ─────────────────────────────────────────────────────────────────────────────

describe('500 の本文は汎用メッセージだけ (生のエラー文は db-logger にだけ残す)', () => {
  const RAW = 'duplicate key value violates unique constraint "x_pkey": Key (email)=(secret@example.com) already exists';
  const GENERIC_CODED = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };

  async function expectGeneric(res: Response, shape: unknown, routeName: string) {
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual(shape);
    expect(text).not.toContain('secret@example.com');
    expect(text).not.toContain('x_pkey');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe(routeName);
    const logged = mockLoggerError.mock.calls[0][2] as Error;
    expect(logged.message).toBe(RAW);
  }

  it.each([
    ['GET', () => departments.GET(), 'GET /api/org/departments'],
    ['POST', () => departments.POST(jsonRequest(url('/api/org/departments'), 'POST', { name: '新部署' }) as never), 'POST /api/org/departments'],
    ['PUT', () => departments.PUT(jsonRequest(url('/api/org/departments'), 'PUT', { id: DEPT_A, name: '改名' }) as never), 'PUT /api/org/departments'],
    ['DELETE', () => departments.DELETE(jsonRequest(url(`/api/org/departments?id=${DEPT_A}`), 'DELETE') as never), 'DELETE /api/org/departments'],
  ])('departments %s: DB の失敗', async (_method, run, routeName) => {
    setup({ errors: { departments: { message: RAW, code: '23505' } } });

    await expectGeneric(await run(), GENERIC_CODED, routeName);
  });

  it('departments GET: 人数の集計 (service_role) の失敗', async () => {
    setup();
    adminDb = createSchemaDb({ tables: worldTables(), errors: { user_profiles: { message: RAW } } });

    await expectGeneric(await departments.GET(), GENERIC_CODED, 'GET /api/org/departments');
  });

  it('settings PUT: 更新の失敗 (従来から汎用メッセージ。ログは db-logger へ)', async () => {
    setup({ errors: { organizations: { message: RAW } } });

    const res = await settings.PUT(jsonRequest(url('/api/org/settings'), 'PUT', { name: '改名' }));
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: '設定の更新に失敗しました' } });
    expect(text).not.toContain('secret@example.com');
    expect(mockLoggerError.mock.calls[0][0]).toBe('PUT /api/org/settings');
  });

  it('settings GET: 認可の後の想定外の例外', async () => {
    failAfterAuthorization(RAW);

    await expectGeneric(await settings.GET(), GENERIC_CODED, 'GET /api/org/settings');
  });

  it('stats GET: 人数の集計 (service_role) の失敗は、人数 0 と偽らず 500', async () => {
    setup();
    adminDb = createSchemaDb({ tables: worldTables(), errors: { user_profiles: { message: RAW } } });

    await expectGeneric(await stats.GET(), GENERIC_CODED, 'GET /api/org/stats');
  });

  it.each([
    ['GET', () => challenges.GET(new Request(url('/api/org/challenges'))), 'GET /api/org/challenges'],
    [
      'POST',
      () =>
        challenges.POST(
          jsonRequest(url('/api/org/challenges'), 'POST', { title: 't', challengeType: 'steps', startDate: '2026-11-01', endDate: '2026-11-30' }),
        ),
      'POST /api/org/challenges',
    ],
    ['PUT', () => challenges.PUT(jsonRequest(url('/api/org/challenges'), 'PUT', { id: CHALLENGE_A, title: '改名' })), 'PUT /api/org/challenges'],
  ])('challenges %s: DB の失敗', async (_method, run, routeName) => {
    setup({ errors: { organization_challenges: { message: RAW, code: '23505' } } });

    await expectGeneric(await run(), { error: 'Internal server error' }, routeName);
  });

  it('members GET: 一覧の取得 (service_role) の失敗', async () => {
    setup();
    adminDb = createSchemaDb({ tables: worldTables(), errors: { user_profiles: { message: RAW } } });

    await expectGeneric(await members.GET(new Request(url('/api/org/members'))), { error: 'Internal server error' }, 'GET /api/org/members');
  });

  it('members GET: 認可の後の想定外の例外', async () => {
    failAdminAfterAuthorization(RAW);

    await expectGeneric(await members.GET(new Request(url('/api/org/members'))), { error: 'Internal server error' }, 'GET /api/org/members');
  });

  it.each([
    ['GET', () => invites.GET(new Request(url('/api/org/invites'))), 'GET /api/org/invites'],
    ['DELETE', () => invites.DELETE(jsonRequest(url(`/api/org/invites?id=${INVITE_A}`), 'DELETE')), 'DELETE /api/org/invites'],
  ])('invites %s: DB の失敗', async (_method, run, routeName) => {
    setup({ errors: { organization_invites: { message: RAW, code: '23505' } } });

    await expectGeneric(await run(), { error: 'Internal server error' }, routeName);
  });

  it('401 / 403 の本文に内部のエラー文は混ざらない (認可の失敗は 500 にしない)', async () => {
    setup({ actor: MEMBER_A });

    const res = await stats.GET();

    expect(res.status).toBe(403);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

describe('壊れた JSON は 500 ではなく 400', () => {
  it.each([
    ['POST /api/org/departments', () => departments.POST(jsonRequest(url('/api/org/departments'), 'POST', '{ not json') as never), 'INVALID_JSON'],
    ['PUT /api/org/departments', () => departments.PUT(jsonRequest(url('/api/org/departments'), 'PUT', '{ not json') as never), 'INVALID_JSON'],
    ['PUT /api/org/settings', () => settings.PUT(jsonRequest(url('/api/org/settings'), 'PUT', '{ not json')), 'INVALID_JSON'],
    ['POST /api/org/members', () => members.POST(jsonRequest(url('/api/org/members'), 'POST', '{ not json')), 'INVALID_BODY'],
    ['POST /api/org/invites', () => invites.POST(jsonRequest(url('/api/org/invites'), 'POST', '{ not json')), 'INVALID_BODY'],
  ])('%s', async (_name, run, code) => {
    const res = await run();

    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe(code);
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockCreateOrgInvite).not.toHaveBeenCalled();
  });

  it.each([
    ['POST /api/org/challenges', () => challenges.POST(jsonRequest(url('/api/org/challenges'), 'POST', '{ not json'))],
    ['PUT /api/org/challenges', () => challenges.PUT(jsonRequest(url('/api/org/challenges'), 'PUT', '{ not json'))],
  ])('%s', async (_name, run) => {
    const res = await run();

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'Invalid JSON' });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
