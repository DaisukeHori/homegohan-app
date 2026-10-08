/**
 * GET /api/org/members: 組織の管理者に、自組織の全メンバーを返す
 *
 * 不具合: user_profiles の SELECT ポリシーは「本人の行だけ」(Users can view own profile) で、組織の管理者が使える
 * 他のメンバーの行を読むポリシーは無い。以前の route は利用者本人のセッションで読んでいたため、
 * 組織に何人いても管理者自身の 1 行しか返らなかった (メンバー一覧が「自分だけ」になる)。
 * 修正後は、認可 (requireOrgAdmin) を通したあとに service_role で、呼び出した管理者の所属組織だけを読む。
 *
 * このテストの DB は RLS の結果を再現する (tests/helpers/route-world.ts の考え方):
 *   - 本人のセッションの client (createClient) には、本人の user_profiles の行だけを入れる
 *   - service_role の client (getSupabaseAdmin) には、全ての行を入れる
 *   -> route が他人の行をセッションの client で読むと、1 行しか返らずテストが失敗する。
 *
 * 確認すること:
 *  1. 自組織のメンバー全員 (2 人以上) が返り、他組織の人は混ざらない。返す列は限定されている
 *  2. service_role の client は、認可 (プロフィールの確認) のあとでだけ作る。401 / 403 では作らない・読まない
 *  3. 読む範囲は、認可で確定した自分の organization_id だけ (リクエストの値は使わない)
 *  4. 500 の本文は汎用メッセージだけ。DB の生のエラー文は db-logger にだけ残す (#1172)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type Row, type SchemaDb } from './helpers/schema-checked-db';
import { makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';

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

/** 呼び出しの順序 ('session' = 本人のセッションの client を作った / 'admin' = service_role の client を作った / 'テーブル' = 読んだ) */
const events: string[] = [];
let sessionUser: FakeUser | null = null;
let sessionDb: SchemaDb;
let adminDb: SchemaDb;

function tracked(label: 'session' | 'admin', client: ReturnType<typeof makeClient>) {
  return {
    ...client,
    from: (table: string) => {
      events.push(`${label}:${table}`);
      return client.from(table);
    },
  };
}

const mockCreateClient = vi.fn(() => {
  events.push('session');
  return tracked('session', makeClient(sessionDb, sessionUser));
});
const mockGetSupabaseAdmin = vi.fn(() => {
  events.push('admin');
  return tracked('admin', makeClient(adminDb, null));
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}));

const members = await import('@/app/api/org/members/route');

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ORG_A = uuid(100);
const ORG_B = uuid(200);

const OWNER_A = uuid(1);
const ADMIN_A = uuid(2);
const MEMBER_A1 = uuid(3);
const MEMBER_A2 = uuid(4);
const RESIDUAL_IN_ORG = uuid(5); // 別の組織で org_admin だった名残が roles に残り、この組織には一般メンバーとして所属 (#1235)
const OUTSIDER = uuid(6); // 組織に所属していない一般ユーザー
const OWNER_B = uuid(7);
const MEMBER_B1 = uuid(8);

const ORG_A_MEMBERS = [OWNER_A, ADMIN_A, MEMBER_A1, MEMBER_A2, RESIDUAL_IN_ORG];

function worldProfiles(): Row[] {
  const base = { updated_at: '2026-10-01T00:00:00Z' };
  return [
    profileRow(OWNER_A, { ...base, nickname: '山田オーナー', organization_id: ORG_A, org_role: 'owner', joined_org_at: '2026-01-01', created_at: '2026-01-01T00:00:00Z' }),
    profileRow(ADMIN_A, { ...base, nickname: '佐藤管理者', organization_id: ORG_A, org_role: 'admin', joined_org_at: '2026-02-01', created_at: '2026-02-01T00:00:00Z' }),
    profileRow(MEMBER_A1, { ...base, nickname: '鈴木メンバー', organization_id: ORG_A, org_role: 'member', joined_org_at: '2026-03-01', created_at: '2026-03-01T00:00:00Z' }),
    profileRow(MEMBER_A2, { ...base, nickname: '田中メンバー', organization_id: ORG_A, org_role: 'member', joined_org_at: null, created_at: '2026-04-01T00:00:00Z' }),
    profileRow(RESIDUAL_IN_ORG, { ...base, nickname: '高橋', organization_id: ORG_A, org_role: 'member', roles: ['user', 'org_admin'], joined_org_at: '2026-05-01', created_at: '2026-05-01T00:00:00Z' }),
    profileRow(OUTSIDER, { ...base, nickname: '伊藤', created_at: '2026-06-01T00:00:00Z' }),
    profileRow(OWNER_B, { ...base, nickname: '渡辺他組織', organization_id: ORG_B, org_role: 'owner', joined_org_at: '2026-01-15', created_at: '2026-01-15T00:00:00Z' }),
    profileRow(MEMBER_B1, { ...base, nickname: '小林他組織', organization_id: ORG_B, org_role: 'member', joined_org_at: '2026-02-15', created_at: '2026-02-15T00:00:00Z' }),
  ];
}

/** 本人のセッションからは、本人の行だけが見える (user_profiles の SELECT ポリシーは auth.uid() = id のみ)。service_role は全部見える */
function setup(options: { actor?: string | null; adminErrors?: Record<string, DbError> } = {}) {
  const actor = options.actor === undefined ? OWNER_A : options.actor;
  const profiles = worldProfiles();
  sessionUser = actor === null ? null : { id: actor, email: 'actor@example.com' };
  sessionDb = createSchemaDb({ tables: { user_profiles: profiles.filter((p) => p.id === actor) } });
  adminDb = createSchemaDb({ tables: { user_profiles: profiles }, errors: options.adminErrors });
}

const get = (url = 'http://localhost/api/org/members') => members.GET(new Request(url));
const json = (res: Response) => res.json() as Promise<any>;

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  setup();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 自組織のメンバー全員が返る
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/org/members: 自組織のメンバー全員を返す', () => {
  it.each([
    ['owner', OWNER_A],
    ['admin', ADMIN_A],
  ])('組織の %s には、自組織のメンバー全員 (5 人) が返る。他組織の人は混ざらない', async (_label, actor) => {
    setup({ actor });

    const res = await get();
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.members.map((m: Row) => m.id).sort()).toEqual([...ORG_A_MEMBERS].sort());
    expect(body.members.length).toBeGreaterThanOrEqual(2);
    const ids = body.members.map((m: Row) => m.id);
    expect(ids).not.toContain(OWNER_B);
    expect(ids).not.toContain(MEMBER_B1);
    expect(ids).not.toContain(OUTSIDER);
  });

  it('別の組織 B のオーナーには、組織 B のメンバーだけが返る (組織 A の人は混ざらない)', async () => {
    setup({ actor: OWNER_B });

    const body = await json(await get());

    expect(body.members.map((m: Row) => m.id).sort()).toEqual([OWNER_B, MEMBER_B1].sort());
  });

  it('新しい順 (created_at の降順) に並ぶ', async () => {
    const body = await json(await get());

    expect(body.members.map((m: Row) => m.id)).toEqual([RESIDUAL_IN_ORG, MEMBER_A2, MEMBER_A1, ADMIN_A, OWNER_A]);
  });

  it('返す列は、Web の組織メンバー一覧とモバイルのメンバー画面が使うものだけ (他の個人情報の列は返さない)', async () => {
    const body = await json(await get());

    for (const member of body.members) {
      expect(Object.keys(member).sort()).toEqual(['created_at', 'id', 'joined_org_at', 'nickname', 'org_role', 'roles']);
    }
    const admin = body.members.find((m: Row) => m.id === ADMIN_A);
    expect(admin).toEqual({
      id: ADMIN_A,
      nickname: '佐藤管理者',
      roles: ['user'],
      org_role: 'admin',
      joined_org_at: '2026-02-01',
      created_at: '2026-02-01T00:00:00Z',
    });
  });

  it('前提の確認: 本人のセッションでは、組織に何人いても自分の行しか読めない (これが不具合の原因)', async () => {
    expect(sessionDb.rows('user_profiles').map((r) => r.id)).toEqual([OWNER_A]);
    expect(adminDb.rows('user_profiles').filter((r) => r.organization_id === ORG_A)).toHaveLength(ORG_A_MEMBERS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 認可のあとにだけ service_role を使う
// ─────────────────────────────────────────────────────────────────────────────

describe('service_role の client は、認可のあとでだけ作る', () => {
  it('成功時: 本人のセッションで自分のプロフィールを読んだ (認可した) あとに、service_role の client を 1 回だけ作る', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1);
    const authorized = events.indexOf('session:user_profiles');
    const adminCreated = events.indexOf('admin');
    expect(authorized).toBeGreaterThanOrEqual(0);
    expect(adminCreated).toBeGreaterThan(authorized);
    // 認可の前には、service_role の client を作らず、何も読んでいない
    expect(events.slice(0, adminCreated).some((e) => e.startsWith('admin'))).toBe(false);
  });

  it('401 (未ログイン): service_role の client を作らず、何も読まない。本文は従来の形のまま', async () => {
    setup({ actor: null });

    const res = await get();

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'Unauthorized' });
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(adminDb.queries).toHaveLength(0);
  });

  it.each([
    ['組織の一般メンバー (org_role = member)', MEMBER_A1],
    ['別の組織の管理者だった名残の org_admin が roles に残る一般メンバー (#1235)', RESIDUAL_IN_ORG],
    ['組織に所属していない一般ユーザー', OUTSIDER],
    ['プロフィールを読めない (行が無い) ユーザー', uuid(777)],
  ])('403: %s。service_role の client を作らず、何も読まない。本文は従来の形のまま', async (_label, actor) => {
    setup({ actor });

    const res = await get();

    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'Forbidden' });
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(adminDb.queries).toHaveLength(0);
    // 認可のためにセッションで読んだのは、自分のプロフィールだけ
    expect(sessionDb.queries.every((q) => q.table === 'user_profiles' && q.op === 'select')).toBe(true);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 読む範囲は、認可で確定した自分の organization_id だけ
// ─────────────────────────────────────────────────────────────────────────────

describe('読む範囲は、呼び出した管理者の所属組織だけ', () => {
  it('service_role での読み出しは user_profiles の 1 回だけ。絞り込みは自分の organization_id だけ', async () => {
    await get();

    expect(adminDb.queries).toHaveLength(1);
    const query = adminDb.recorded('user_profiles', 'select')[0];
    expect(query.eq).toEqual([['organization_id', ORG_A]]);
    expect(query.in).toEqual([]);
    expect(query.count).toBe(false);
    expect(query.select).toBe('id, nickname, roles, org_role, joined_org_at, created_at');
  });

  it('別の組織の管理者なら、絞り込みもその人の組織になる', async () => {
    setup({ actor: OWNER_B });

    await get();

    expect(adminDb.recorded('user_profiles', 'select')[0].eq).toEqual([['organization_id', ORG_B]]);
  });

  it('リクエストのクエリに別の組織の id を入れても使わない', async () => {
    const body = await json(await get(`http://localhost/api/org/members?organization_id=${ORG_B}&org=${ORG_B}`));

    expect(body.members.map((m: Row) => m.id).sort()).toEqual([...ORG_A_MEMBERS].sort());
    expect(adminDb.recorded('user_profiles', 'select')[0].eq).toEqual([['organization_id', ORG_A]]);
  });

  it('メンバーが管理者 1 人だけの組織でも、その 1 人が返る (空にはならない)', async () => {
    setup({ actor: OWNER_B });
    adminDb = createSchemaDb({ tables: { user_profiles: worldProfiles().filter((p) => p.id !== MEMBER_B1) } });

    const body = await json(await get());

    expect(body.members.map((m: Row) => m.id)).toEqual([OWNER_B]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 500 は汎用メッセージだけ
// ─────────────────────────────────────────────────────────────────────────────

describe('500 の本文は汎用メッセージだけ (生のエラー文は db-logger にだけ残す)', () => {
  const RAW = 'duplicate key value violates unique constraint "x_pkey": Key (email)=(secret@example.com) already exists';

  async function expectGeneric(res: Response) {
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('secret@example.com');
    expect(text).not.toContain('x_pkey');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('GET /api/org/members');
    expect((mockLoggerError.mock.calls[0][2] as { message: string }).message).toBe(RAW);
  }

  it('一覧の読み出し (service_role) が失敗したとき', async () => {
    setup({ adminErrors: { user_profiles: { message: RAW, code: '23505' } } });

    await expectGeneric(await get());
  });

  it('service_role の client を作れないとき (環境変数の不足など)', async () => {
    mockGetSupabaseAdmin.mockImplementationOnce(() => {
      throw new Error(RAW);
    });

    await expectGeneric(await get());
  });
});
