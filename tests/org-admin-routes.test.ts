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
 *  4. 組織チャレンジ (#1132): 管理者に返すのは集計 (参加者数・平均) だけで、最小人数に満たない間は値を返さない。
 *     作成・開始できる種類は食事の記録から計算できる 3 つだけ (歩数・体重・カスタムは、健康データの同意の仕組みができるまで止める)。
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
// service_role (getSupabaseAdmin) の rpc。チャレンジの集計 (get_org_challenge_aggregates) を返す
const mockAdminRpc = vi.fn();
let sessionUser: FakeUser | null = null;
let sessionDb: SchemaDb;
let adminDb: SchemaDb;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser, mockRpc),
  getSupabaseAdmin: () => makeClient(adminDb, null, mockAdminRpc),
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
const CHALLENGE_A_STEPS = uuid(403); // 組織 A の下書き (歩数。作成・開始できない種類)
const INVITE_A = uuid(501);
const INVITE_B = uuid(502);

function worldTables(): Record<string, Row[]> {
  return {
    user_profiles: [
      // 所属している行は参加した日 (joined_org_at。date 型) を持つ (メンバーの一覧の GET が返す 4 つの項目の 1 つ。#2073 S4)
      profileRow(OWNER_A, { nickname: '山田オーナー', organization_id: ORG_A, org_role: 'owner', roles: ['user'], joined_org_at: '2026-01-01' }),
      profileRow(ADMIN_A, { nickname: '佐藤管理者', organization_id: ORG_A, org_role: 'admin', roles: ['user'], department_id: DEPT_A, joined_org_at: '2026-01-02' }),
      profileRow(MEMBER_A, { nickname: '鈴木メンバー', organization_id: ORG_A, org_role: 'member', roles: ['user'], department_id: DEPT_A, joined_org_at: '2026-01-03' }),
      profileRow(RESIDUAL_IN_ORG, { nickname: '高橋', organization_id: ORG_A, org_role: 'member', roles: ['user', 'org_admin'], joined_org_at: '2026-01-04' }),
      profileRow(RESIDUAL_NO_ORG, { nickname: '田中', roles: ['user', 'org_admin'] }),
      profileRow(OUTSIDER, { nickname: '伊藤' }),
      profileRow(OWNER_B, { nickname: '渡辺他組織', organization_id: ORG_B, org_role: 'owner', roles: ['user'], joined_org_at: '2026-01-01' }),
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
      { id: CHALLENGE_A, organization_id: ORG_A, title: 'A の朝食チャレンジ', description: null, challenge_type: 'breakfast_rate', target_value: 80, target_unit: '%', start_date: '2026-10-01', end_date: '2026-10-31', reward_description: null, status: 'active', department_id: DEPT_A, created_at: '2026-09-01T00:00:00Z' },
      { id: CHALLENGE_B, organization_id: ORG_B, title: 'B のチャレンジ', description: null, challenge_type: 'breakfast_rate', target_value: 1, target_unit: '%', start_date: '2026-10-01', end_date: '2026-10-31', reward_description: null, status: 'active', department_id: null, created_at: '2026-09-02T00:00:00Z' },
      { id: CHALLENGE_A_STEPS, organization_id: ORG_A, title: 'A の歩数チャレンジ', description: null, challenge_type: 'steps', target_value: 10000, target_unit: 'steps', start_date: '2026-10-01', end_date: '2026-10-31', reward_description: null, status: 'draft', department_id: null, created_at: '2026-08-01T00:00:00Z' },
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

const json = (res: Response) => res.json() as Promise<any>;
const url = (path: string) => `http://localhost${path}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockAdminRpc.mockResolvedValue({ data: [], error: null });
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
    forbiddenMessage: 'オーナー・管理者だけが招待できます',
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
          challengeType: 'breakfast_rate',
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
    forbiddenMessage: 'オーナー・管理者だけが招待できます',
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
    forbiddenMessage: 'オーナー・管理者だけが招待を取り消せます',
  },
  {
    name: 'POST /api/org/members/[user_id]/remove',
    call: () =>
      removeMember.POST(jsonRequest(url(`/api/org/members/${MEMBER_A}/remove`), 'POST'), { params: { user_id: MEMBER_A } }),
    success: 200,
    flavor: 'invite',
    forbiddenMessage: 'オーナー・管理者だけがメンバーを除名できます',
  },
];

function expectedUnauthenticatedBody(endpoint: Endpoint) {
  switch (endpoint.flavor) {
    case 'plain':
      return { error: 'ログインが必要です' };
    case 'coded':
      return { error: { code: 'UNAUTHORIZED', message: 'ログインが必要です' } };
    case 'invite':
      return { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } };
  }
}

function expectedForbiddenBody(endpoint: Endpoint) {
  switch (endpoint.flavor) {
    case 'plain':
      return { error: 'この操作を行う権限がありません' };
    case 'coded':
      return { error: { code: 'FORBIDDEN', message: 'この操作を行う権限がありません' } };
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
  expect(mockAdminRpc).not.toHaveBeenCalled();
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

  // #1790・#1793: 人数の Map (fetchMemberCounts) の鍵は DB の小文字の department_id。本文の id を大文字・混在のまま使うと、
  // 更新は DB (uuid の比較は大文字小文字を区別しない) で通るのに人数の照合が外れ、memberCount が 0 で返っていた
  // (#1790 が足した「大文字の id」のケースは、下の it.each の「大文字」が同じ確かめ (200・id/name/memberCount・更新された行) を含む)
  describe('departments PUT: 部署の id を大文字・混在で送っても、更新する部署と返す人数がずれない (#1790・#1793)', () => {
    // 16 進の英字を含む id (DB の id は小文字)。所属は ADMIN_A と MEMBER_A の 2 人
    const DEPT_HEX = 'abcdef12-3456-4abc-8def-0123456789ab';
    /** 英字を 1 文字おきに大文字にする (大文字・小文字の混在) */
    const mixedCase = (id: string) => id.replace(/[a-f]/g, (c, i: number) => (i % 2 === 0 ? c.toUpperCase() : c));

    function worldWithHexDepartment(): Record<string, Row[]> {
      const tables = worldTables();
      tables.departments.push({
        id: DEPT_HEX, organization_id: ORG_A, name: 'A の企画部', parent_id: null, manager_id: null, display_order: 2, created_at: '2026-02-03T00:00:00Z',
      });
      tables.user_profiles = tables.user_profiles.map((row) =>
        row.id === ADMIN_A || row.id === MEMBER_A ? { ...row, department_id: DEPT_HEX } : row,
      );
      return tables;
    }

    /**
     * 本物の Postgres と同じく、departments の id の比較だけ大文字小文字を区別しない DB にする
     * (ここが === のままだと、そろえ忘れは 404 になり「更新は通るのに人数が 0」の症状を再現できない)。route が渡した値は控える
     */
    function compareDepartmentIdLikePostgres(): unknown[] {
      const passedIds: unknown[] = [];
      const original = sessionDb.from;
      sessionDb = {
        ...sessionDb,
        from: vi.fn((table: string) => {
          const query = original(table);
          if (table !== 'departments') return query;
          const eq = query.eq.bind(query);
          query.eq = (column: string, value: unknown) => {
            if (column !== 'id') return eq(column, value);
            passedIds.push(value);
            return eq(column, typeof value === 'string' ? value.toLowerCase() : value);
          };
          return query;
        }) as unknown as SchemaDb['from'],
      };
      return passedIds;
    }

    beforeEach(() => {
      sessionUser = { id: OWNER_A, email: 'actor@example.com' };
      sessionDb = createSchemaDb({ tables: worldWithHexDepartment() });
      adminDb = createSchemaDb({ tables: worldWithHexDepartment() });
    });

    it.each([
      ['大文字', DEPT_HEX.toUpperCase()],
      ['大文字・小文字の混在', mixedCase(DEPT_HEX)],
    ])('%s: 更新でき、memberCount は所属している実際の人数 (2 人)。DB にはそろえた小文字の id を渡す', async (_label, sentId) => {
      expect(sentId).not.toBe(DEPT_HEX); // そろえる前と後で値が違う (英字を含む) こと
      expect(sentId.toLowerCase()).toBe(DEPT_HEX); // 小文字にそろえると DB の id になる
      const passedIds = compareDepartmentIdLikePostgres();

      const res = await departments.PUT(jsonRequest(url('/api/org/departments'), 'PUT', { id: sentId, name: '改名' }) as never);
      const body = await json(res);

      expect(res.status).toBe(200);
      expect(body.department).toMatchObject({ id: DEPT_HEX, name: '改名', memberCount: 2 });
      expect(passedIds).toEqual([DEPT_HEX]);
      expect(sessionDb.rows('departments').find((d) => d.id === DEPT_HEX)?.name).toBe('改名');
    });

    it('小文字で送ったときも同じ人数 (そろえても今までの結果は変わらない)', async () => {
      const res = await departments.PUT(jsonRequest(url('/api/org/departments'), 'PUT', { id: DEPT_HEX, name: '改名' }) as never);

      expect(res.status).toBe(200);
      expect((await json(res)).department.memberCount).toBe(2);
    });
  });

  it('members GET: 自組織のメンバーだけを返し、読む列は限定されている', async () => {
    const body = await json(await members.GET(new Request(url('/api/org/members'))));

    expect(body.members.map((m: Row) => m.id).sort()).toEqual([OWNER_A, ADMIN_A, MEMBER_A, RESIDUAL_IN_ORG].sort());
    // ほかのメンバーの行は RLS で読めないので、認可のあとに service_role で読む (#2073 S4)。列は id・表示名・組織内の役割・参加した日だけ
    const query = adminDb.recorded('user_profiles', 'select').at(-1)!;
    expect(query.eq).toContainEqual(['organization_id', ORG_A]);
    expect(query.select).toBe('id, nickname, org_role, joined_org_at');
    for (const member of body.members as Row[]) {
      expect(Object.keys(member).sort()).toEqual(['id', 'joined_org_at', 'nickname', 'org_role']);
    }
    // 利用者のクライアントで読むのは、認可のための自分の行だけ
    expect(sessionDb.recorded('user_profiles', 'select').map((q) => q.eq)).toEqual([[['id', OWNER_A]]]);
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

  it('challenges GET: 自組織のチャレンジだけ。部署名つき。集計は認可で確定した自組織の分だけ service_role の DB 関数で取る', async () => {
    mockAdminRpc.mockResolvedValue({
      data: [{ challenge_id: CHALLENGE_A, participant_count: 12, min_participants: 10, average_value: '63.2' }],
      error: null,
    });

    const body = await json(await challenges.GET(new Request(url('/api/org/challenges'))));

    expect(body.challenges.map((c: Row) => c.id).sort()).toEqual([CHALLENGE_A, CHALLENGE_A_STEPS].sort());
    expect(body.challenges.find((c: Row) => c.id === CHALLENGE_A)).toMatchObject({
      title: 'A の朝食チャレンジ',
      departmentName: 'A の営業部',
      participantCount: 12,
      aggregate: { minParticipants: 10, visible: true, averageValue: 63.2 },
    });
    // 集計は、呼び出した管理者の組織 (リクエストに組織 ID を渡す口は無い) だけ。参加者の行を直接読まない
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    expect(mockAdminRpc).toHaveBeenCalledWith('get_org_challenge_aggregates', { p_organization_id: ORG_A });
    expect(adminDb.recorded('organization_challenge_participants', 'select')).toHaveLength(0);
    expect(sessionDb.recorded('organization_challenge_participants', 'select')).toHaveLength(0);
  });

  it('challenges GET: 管理者に返すのは集計だけ。参加者の ID・個人の値・順位は返さない', async () => {
    mockAdminRpc.mockResolvedValue({
      data: [{ challenge_id: CHALLENGE_A, participant_count: 12, min_participants: 10, average_value: 63.2 }],
      error: null,
    });

    const text = await (await challenges.GET(new Request(url('/api/org/challenges')))).text();

    // テストデータの参加者 (MEMBER_A / ADMIN_A) の ID は、どこにも現れない
    expect(text).not.toContain(MEMBER_A);
    expect(text).not.toContain(ADMIN_A);
    const body = JSON.parse(text);
    for (const challenge of body.challenges) {
      expect(Object.keys(challenge.aggregate).sort()).toEqual(['averageValue', 'minParticipants', 'visible']);
      expect(challenge).not.toHaveProperty('participants');
      expect(challenge).not.toHaveProperty('rank');
      expect(challenge).not.toHaveProperty('ranking');
    }
  });

  it('challenges GET: 最小人数に満たない間は、参加者数も平均も返さない (DB の関数が返した null をそのまま通す)', async () => {
    mockAdminRpc.mockResolvedValue({
      data: [
        { challenge_id: CHALLENGE_A, participant_count: null, min_participants: 10, average_value: null },
        // 参加者は 10 人以上いるが、集計が済んだ人が 10 人に満たない: 人数は出て、平均は出ない
        { challenge_id: CHALLENGE_A_STEPS, participant_count: 11, min_participants: 10, average_value: null },
      ],
      error: null,
    });

    const body = await json(await challenges.GET(new Request(url('/api/org/challenges'))));

    const a = body.challenges.find((c: Row) => c.id === CHALLENGE_A);
    expect(a.participantCount).toBeNull();
    expect(a.aggregate).toEqual({ minParticipants: 10, visible: false, averageValue: null });
    const steps = body.challenges.find((c: Row) => c.id === CHALLENGE_A_STEPS);
    expect(steps.participantCount).toBe(11);
    expect(steps.aggregate).toEqual({ minParticipants: 10, visible: false, averageValue: null });
  });

  it('challenges GET: 集計の行が無いチャレンジも、0 人とは偽らず null (「10 人未満」) にする。平均 0 は 0 のまま出る', async () => {
    mockAdminRpc.mockResolvedValue({
      data: [{ challenge_id: CHALLENGE_A, participant_count: 10, min_participants: 10, average_value: 0 }],
      error: null,
    });

    const body = await json(await challenges.GET(new Request(url('/api/org/challenges'))));

    const a = body.challenges.find((c: Row) => c.id === CHALLENGE_A);
    expect(a.participantCount).toBe(10);
    expect(a.aggregate).toEqual({ minParticipants: 10, visible: true, averageValue: 0 });
    const noRow = body.challenges.find((c: Row) => c.id === CHALLENGE_A_STEPS);
    expect(noRow.participantCount).toBeNull();
    expect(noRow.aggregate).toEqual({ minParticipants: 10, visible: false, averageValue: null });
  });

  it('challenges GET: 計算できない種類 (歩数) には、DB の関数が平均を返しても出さない', async () => {
    mockAdminRpc.mockResolvedValue({
      data: [{ challenge_id: CHALLENGE_A_STEPS, participant_count: 11, min_participants: 10, average_value: 1234 }],
      error: null,
    });

    const body = await json(await challenges.GET(new Request(url('/api/org/challenges'))));

    const steps = body.challenges.find((c: Row) => c.id === CHALLENGE_A_STEPS);
    expect(steps.aggregate).toEqual({ minParticipants: 10, visible: false, averageValue: null });
  });

  it('challenges POST / PUT: 作成は自組織・操作した人で、他組織のチャレンジは更新できない', async () => {
    const created = await challenges.POST(
      jsonRequest(url('/api/org/challenges'), 'POST', {
        title: '新チャレンジ',
        challengeType: 'breakfast_rate',
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
// 組織チャレンジ (#1132): 作成・開始できる種類と、入力の確認
// ─────────────────────────────────────────────────────────────────────────────

describe('組織チャレンジ (#1132): 作成・開始できるのは食事の記録から計算できる種類だけ', () => {
  const createBody = (extra: Record<string, unknown> = {}) => ({
    title: '新チャレンジ',
    challengeType: 'breakfast_rate',
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    ...extra,
  });
  const create = (extra: Record<string, unknown> = {}) =>
    challenges.POST(jsonRequest(url('/api/org/challenges'), 'POST', createBody(extra)));
  const update = (body: Record<string, unknown>) => challenges.PUT(jsonRequest(url('/api/org/challenges'), 'PUT', body));
  const inserts = () => sessionDb.recorded('organization_challenges', 'insert');
  const updates = () => sessionDb.recorded('organization_challenges', 'update');

  it.each(['breakfast_rate', 'veg_score', 'cooking_rate'])('POST: %s は作成できる', async (challengeType) => {
    const res = await create({ challengeType });

    expect(res.status).toBe(200);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].values).toMatchObject({ challenge_type: challengeType, organization_id: ORG_A, status: 'draft' });
  });

  it.each(['steps', 'weight_loss', 'custom', 'veggie_score', 'homecook_rate', 'unknown'])(
    'POST: %s は作成できない (400 CHALLENGE_TYPE_DISABLED)。何も書き込まない',
    async (challengeType) => {
      const res = await create({ challengeType });

      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('CHALLENGE_TYPE_DISABLED');
      expect(inserts()).toHaveLength(0);
      expect(mockLoggerError).not.toHaveBeenCalled();
    },
  );

  it('POST: 種類・タイトル・日付が欠けていれば 400 (タイトル・種類・開始日・終了日を入力してください)', async () => {
    for (const missing of ['title', 'challengeType', 'startDate', 'endDate']) {
      const res = await create({ [missing]: undefined });
      expect(res.status, missing).toBe(400);
      expect(await json(res)).toEqual({ error: 'タイトル・種類・開始日・終了日を入力してください' });
    }
    expect(inserts()).toHaveLength(0);
  });

  it.each([
    ['開始日が終了日より後', { startDate: '2026-12-01', endDate: '2026-11-30' }],
    ['実在しない日付', { startDate: '2026-02-30' }],
    ['日付の形式が違う', { startDate: '2026/11/01' }],
    ['日時の文字列', { endDate: '2026-11-30T00:00:00Z' }],
    ['日付が文字列でない', { startDate: 20261101 }],
    ['タイトルが文字列でない', { title: 123 }],
  ])('POST: %s は 400 INVALID_PERIOD。何も書き込まない', async (_label, extra) => {
    const res = await create(extra);

    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('INVALID_PERIOD');
    expect(inserts()).toHaveLength(0);
  });

  it('POST: 開始日と終了日が同じ日 (1 日だけのチャレンジ) は作成できる', async () => {
    const res = await create({ startDate: '2026-11-01', endDate: '2026-11-01' });

    expect(res.status).toBe(200);
  });

  it.each([
    ['breakfast_rate', 100],
    ['breakfast_rate', 0],
    ['cooking_rate', 60.5],
    ['veg_score', 100],
    ['veg_score', 4],
  ])('POST: %s の目標値 %s は受け付ける。null / 省略もよい', async (challengeType, targetValue) => {
    expect((await create({ challengeType, targetValue })).status).toBe(200);
    expect((await create({ challengeType, targetValue: null })).status).toBe(200);
    expect((await create({ challengeType, targetValue: undefined })).status).toBe(200);
  });

  it.each([
    ['breakfast_rate', 101],
    ['breakfast_rate', -1],
    ['cooking_rate', 1000],
    ['veg_score', 101],
    ['breakfast_rate', '80'],
    ['breakfast_rate', 'abc'],
    ['breakfast_rate', true],
  ])('POST: %s の目標値 %j は 400 INVALID_TARGET。何も書き込まない', async (challengeType, targetValue) => {
    const res = await create({ challengeType, targetValue });

    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('INVALID_TARGET');
    expect(inserts()).toHaveLength(0);
  });

  it('PUT: 状態に DB が受け付けない値を指定したら 400 INVALID_STATUS。何も更新しない', async () => {
    const res = await update({ id: CHALLENGE_A, status: 'finished' });

    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('INVALID_STATUS');
    expect(updates()).toHaveLength(0);
  });

  it('PUT: id が UUID でなければ 400 (DB に渡さない)', async () => {
    const res = await update({ id: 'not-a-uuid', status: 'active' });

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'チャレンジの ID の形式が正しくありません' });
    expect(updates()).toHaveLength(0);
  });

  it('PUT: 食事の記録から計算できる種類のチャレンジは、開始 (active) にできる', async () => {
    const res = await update({ id: CHALLENGE_A, status: 'active' });

    expect(res.status).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].values).toEqual({ status: 'active' });
    expect(updates()[0].eq).toContainEqual(['id', CHALLENGE_A]);
    expect(updates()[0].eq).toContainEqual(['organization_id', ORG_A]);
  });

  it('PUT: 歩数のチャレンジは開始できない (400 CHALLENGE_TYPE_DISABLED)。何も更新しない', async () => {
    const res = await update({ id: CHALLENGE_A_STEPS, status: 'active' });

    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('CHALLENGE_TYPE_DISABLED');
    expect(updates()).toHaveLength(0);
    expect(sessionDb.rows('organization_challenges').find((c) => c.id === CHALLENGE_A_STEPS)?.status).toBe('draft');
  });

  it.each(['completed', 'cancelled'])('PUT: 歩数の下書きのチャレンジでも、%s にはできる (開始だけを止める)', async (status) => {
    const res = await update({ id: CHALLENGE_A_STEPS, status });

    expect(res.status).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(sessionDb.rows('organization_challenges').find((c) => c.id === CHALLENGE_A_STEPS)?.status).toBe(status);
  });

  // #1688: 状態の遷移表 (src/lib/org-challenge-privacy.ts。DB のトリガー org_challenge_guard_update と同じ) に無い変更は 409
  /** CHALLENGE_A の状態を、本人のセッションの DB で書き換えておく (終わった状態のチャレンジを作る) */
  function setChallengeAStatus(status: string) {
    sessionDb = createSchemaDb({
      tables: {
        ...worldTables(),
        organization_challenges: worldTables().organization_challenges.map((c) => (c.id === CHALLENGE_A ? { ...c, status } : c)),
      },
    });
  }

  it.each([
    ['completed', 'active'],
    ['completed', 'draft'],
    ['completed', 'cancelled'],
    ['cancelled', 'active'],
    ['cancelled', 'draft'],
    ['cancelled', 'completed'],
  ])('PUT: 現在の状態が %s で status を %s に変えると 409 CHALLENGE_STATUS_LOCKED。何も更新しない', async (from, to) => {
    setChallengeAStatus(from);

    const res = await update({ id: CHALLENGE_A, status: to, title: '改名' });

    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'このチャレンジの状態は変えられません', code: 'CHALLENGE_STATUS_LOCKED' });
    expect(updates()).toHaveLength(0);
    expect(sessionDb.rows('organization_challenges').find((c) => c.id === CHALLENGE_A)).toMatchObject({ status: from, title: 'A の朝食チャレンジ' });
  });

  it('PUT: 開催中 → 下書きは 409 CHALLENGE_STATUS_LOCKED。何も更新しない', async () => {
    const res = await update({ id: CHALLENGE_A, status: 'draft' });

    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('CHALLENGE_STATUS_LOCKED');
    expect(updates()).toHaveLength(0);
    expect(sessionDb.rows('organization_challenges').find((c) => c.id === CHALLENGE_A)?.status).toBe('active');
  });

  it.each(['completed', 'cancelled'])('PUT: 開催中 → %s はできる', async (to) => {
    const res = await update({ id: CHALLENGE_A, status: to });

    expect(res.status).toBe(200);
    expect(sessionDb.rows('organization_challenges').find((c) => c.id === CHALLENGE_A)?.status).toBe(to);
  });

  it.each(['completed', 'cancelled'])('PUT: 終わった状態 (%s) でも、同じ状態の指定とタイトル・説明・報酬の更新はできる', async (status) => {
    setChallengeAStatus(status);

    const res = await update({ id: CHALLENGE_A, status, title: '改名', description: '説明', rewardDescription: '景品' });

    expect(res.status).toBe(200);
    expect(sessionDb.rows('organization_challenges').find((c) => c.id === CHALLENGE_A)).toMatchObject({
      status,
      title: '改名',
      description: '説明',
      reward_description: '景品',
    });
  });

  it('PUT: 現在の行の読み取りは status があるときだけ 1 回 (種類の確認と統合)', async () => {
    await update({ id: CHALLENGE_A, status: 'active' });
    const withStatus = sessionDb.recorded('organization_challenges', 'select');
    expect(withStatus).toHaveLength(1);
    expect(withStatus[0].select).toBe('status, challenge_type');
    expect(withStatus[0].eq).toContainEqual(['id', CHALLENGE_A]);
    expect(withStatus[0].eq).toContainEqual(['organization_id', ORG_A]);

    setup();
    await update({ id: CHALLENGE_A, title: '改名' });
    expect(sessionDb.recorded('organization_challenges', 'select')).toHaveLength(0);
  });

  /** 現在の行の読み取りは通し、UPDATE だけ DB のエラーを返す (読んでから書くまでに状態が変わった場合の再現) */
  function failChallengeUpdate(dbError: { code: string; message: string }) {
    const original = sessionDb.from;
    sessionDb = {
      ...sessionDb,
      from: vi.fn((table: string) => {
        const query = original(table);
        if (table !== 'organization_challenges') return query;
        return Object.assign(query, {
          update: () => ({ eq: () => ({ eq: async () => ({ data: null, error: dbError }) }) }),
        });
      }) as unknown as SchemaDb['from'],
    };
  }

  it.each([
    ['CHALLENGE_STATUS_LOCKED', 'CHALLENGE_STATUS_LOCKED'],
    ['CHALLENGE_PERIOD_LOCKED', 'CHALLENGE_PERIOD_LOCKED'],
  ])('PUT: DB のガードの RAISE (P0001 %s) を 409 に写す', async (message, code) => {
    failChallengeUpdate({ code: 'P0001', message });

    const res = await update({ id: CHALLENGE_A, status: 'completed' });

    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'このチャレンジの状態は変えられません', code });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('PUT: ガード由来でない P0001 は従来どおり 500 (汎用メッセージ)', async () => {
    failChallengeUpdate({ code: 'P0001', message: 'some other raise; secret=abc123' });

    const res = await update({ id: CHALLENGE_A, status: 'completed' });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました' });
    expect(text).not.toContain('abc123');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it('PUT: 他組織のチャレンジの種類は調べない・更新もしない (自組織の絞り込み)', async () => {
    const res = await update({ id: CHALLENGE_B, status: 'active', title: '乗っ取り' });

    expect(res.status).toBe(200); // 従来どおり、該当する行が無いだけ (存在を知らせない)
    expect(sessionDb.rows('organization_challenges').find((c) => c.id === CHALLENGE_B)?.title).toBe('B のチャレンジ');
    for (const query of sessionDb.queries.filter((q) => q.table === 'organization_challenges')) {
      expect(query.eq).toContainEqual(['organization_id', ORG_A]);
    }
  });

  it('GET: 集計 (service_role の DB 関数) の失敗は、集計なしで返さず 500 の汎用メッセージ。生のエラー文は記録にだけ残す', async () => {
    const RAW = 'permission denied for function get_org_challenge_aggregates; token=abc123';
    mockAdminRpc.mockResolvedValue({ data: null, error: { code: '42501', message: RAW } });

    const res = await challenges.GET(new Request(url('/api/org/challenges')));
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました' });
    expect(text).not.toContain('abc123');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('GET /api/org/challenges');
    expect((mockLoggerError.mock.calls[0][2] as Error).message).toContain(RAW);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 500 は汎用メッセージ / 壊れた JSON は 400
// ─────────────────────────────────────────────────────────────────────────────

describe('500 の本文は汎用メッセージだけ (生のエラー文は db-logger にだけ残す)', () => {
  const RAW = 'duplicate key value violates unique constraint "x_pkey": Key (email)=(secret@example.com) already exists';
  const GENERIC_CODED = { error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } };

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
          jsonRequest(url('/api/org/challenges'), 'POST', { title: 't', challengeType: 'breakfast_rate', startDate: '2026-11-01', endDate: '2026-11-30' }),
        ),
      'POST /api/org/challenges',
    ],
    ['PUT', () => challenges.PUT(jsonRequest(url('/api/org/challenges'), 'PUT', { id: CHALLENGE_A, title: '改名' })), 'PUT /api/org/challenges'],
  ])('challenges %s: DB の失敗', async (_method, run, routeName) => {
    setup({ errors: { organization_challenges: { message: RAW, code: '23505' } } });

    await expectGeneric(await run(), { error: '処理中にエラーが発生しました' }, routeName);
  });

  it('members GET: 認可の後の想定外の例外', async () => {
    // 認可のあとの読みは service_role (#2073 S4)。その読みで例外を投げる
    adminDb = {
      ...adminDb,
      from: vi.fn(() => {
        throw new Error(RAW);
      }) as unknown as SchemaDb['from'],
    };

    await expectGeneric(await members.GET(new Request(url('/api/org/members'))), { error: '処理中にエラーが発生しました' }, 'GET /api/org/members');
  });

  it.each([
    ['GET', () => invites.GET(new Request(url('/api/org/invites'))), 'GET /api/org/invites'],
    ['DELETE', () => invites.DELETE(jsonRequest(url(`/api/org/invites?id=${INVITE_A}`), 'DELETE')), 'DELETE /api/org/invites'],
  ])('invites %s: DB の失敗', async (_method, run, routeName) => {
    setup({ errors: { organization_invites: { message: RAW, code: '23505' } } });

    await expectGeneric(await run(), { error: '処理中にエラーが発生しました' }, routeName);
  });

  it('401 / 403 の本文に内部のエラー文は混ざらない (認可の失敗は 500 にしない)', async () => {
    setup({ actor: MEMBER_A });

    const res = await stats.GET();

    expect(res.status).toBe(403);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

describe('入力の誤りの 400 の文は日本語 (英字の項目名 name / id / user_id を出さない。#1917)', () => {
  it.each([
    ['POST: 名前が空', () => departments.POST(jsonRequest(url('/api/org/departments'), 'POST', { name: '' }) as never)],
    ['PUT: 名前が空', () => departments.PUT(jsonRequest(url('/api/org/departments'), 'PUT', { id: DEPT_A, name: '   ' }) as never)],
  ])('departments %s: 「部署の名前を入力してください (… 文字以内)」。何も書き込まない', async (_label, run) => {
    const before = sessionDb.rows('departments').length;
    const res = await run();

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toMatch(/^部署の名前を入力してください \(\d+ 文字以内\)$/);
    expect(sessionDb.rows('departments').length).toBe(before);
    expect(sessionDb.rows('departments').find((d) => d.id === DEPT_A)?.name).not.toBe('   ');
  });

  it.each([
    ['PUT', () => departments.PUT(jsonRequest(url('/api/org/departments'), 'PUT', { name: '改名' }) as never)],
    ['DELETE', () => departments.DELETE(jsonRequest(url('/api/org/departments'), 'DELETE') as never)],
  ])('departments %s: 部署の id が無ければ「部署を指定してください」', async (_label, run) => {
    const res = await run();

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: { code: 'VALIDATION_ERROR', message: '部署を指定してください' } });
    expect(sessionDb.rows('departments').some((d) => d.id === DEPT_A)).toBe(true);
  });

  it('members/[user_id]/remove: 除名する人の id が空なら「除名するメンバーを指定してください」。RPC は呼ばない', async () => {
    const res = await removeMember.POST(jsonRequest(url('/api/org/members//remove'), 'POST'), { params: { user_id: '' } });

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: { code: 'INVALID_BODY', message: '除名するメンバーを指定してください' } });
    expect(mockRpc).not.toHaveBeenCalled();
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
    expect(await json(res)).toEqual({ error: 'リクエストボディが不正です' });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
