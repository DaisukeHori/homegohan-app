import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeServiceRole, type FakeServiceRole, type Row } from '../../operator/membership/fake-service-role';
import { ORG_API_FORBIDDEN_MESSAGE, ORG_API_INTERNAL_ERROR_MESSAGE, ORG_API_UNAUTHENTICATED_MESSAGE } from '@/lib/org-api-errors';

// GET /api/org/members — 組織のメンバーの一覧 (#2073 S4)。
//
// user_profiles の SELECT の RLS は本人の行だけなので、以前はログイン中の利用者のクライアントで読み、自分の行しか返らなかった
// (組織のメンバーの画面に他のメンバーが出なかった)。いまは、JWT の本人・所属組織・役割 (owner / admin) を確かめてから、
// 確かめた組織のメンバーだけを service_role で読み、id・表示名・組織内の役割・参加した日の 4 つだけを返す。
//
// 利用者のクライアント (RLS つき) と service_role のクライアントを別の偽物にする。利用者の偽物には、RLS で読める行
// (自分のプロフィール) だけを置く。service_role の偽物には全員のプロフィール (4 つ以外の列も) を置き、
// 応答に 4 つ以外が漏れないこと・ほかの組織の人が混ざらないことを確かめる。

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  userFrom: vi.fn(),
  adminClient: vi.fn(),
  logError: vi.fn(),
  /** 利用者のクライアントの読みと、service_role のクライアントを作った順 */
  order: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => {
      mocks.order.push(`user:${table}`);
      return mocks.userFrom(table);
    },
  })),
  getSupabaseAdmin: () => {
    mocks.order.push('admin');
    return mocks.adminClient();
  },
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError };
  return {
    createLogger: () => ({ ...logger, withUser: () => logger }),
    generateRequestId: () => 'req_test',
  };
});

const { GET } = await import('@/app/api/org/members/route');

const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const OWNER_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '20000000-0000-4000-8000-000000000002';
const MEMBER_ID = '30000000-0000-4000-8000-000000000003';
const EARLY_MEMBER_ID = '40000000-0000-4000-8000-000000000004';
const OTHER_ORG_MEMBER_ID = '50000000-0000-4000-8000-000000000005';
const NO_ORG_ID = '60000000-0000-4000-8000-000000000006';

/** 返してはならない列 (アイコン・メールアドレス・年齢・健康・全体の役割など) */
const SECRET_COLUMNS = {
  avatar_url: 'https://example.test/avatar.png',
  email: 'secret@example.test',
  birth_date: '1990-01-01',
  weight: 60,
  roles: ['user'],
  department_id: null,
  is_active_in_org: true,
};

/** 返す列 (ORG_MEMBER_NAME_COLUMNS と同じ集合) */
const RETURNED_KEYS = ['id', 'joined_org_at', 'nickname', 'org_role'];

function profileRow(id: string, nickname: string, organizationId: string | null, orgRole: string | null, joinedOrgAt: string | null): Row {
  return { id, nickname, organization_id: organizationId, org_role: orgRole, joined_org_at: joinedOrgAt, ...SECRET_COLUMNS };
}

const ALL_PROFILES: Row[] = [
  profileRow(OWNER_ID, 'オーナー', ORG_A, 'owner', '2026-10-01T00:00:00.000Z'),
  profileRow(ADMIN_ID, '管理者', ORG_A, 'admin', '2026-10-02T00:00:00.000Z'),
  profileRow(MEMBER_ID, 'メンバー', ORG_A, 'member', '2026-10-03T00:00:00.000Z'),
  profileRow(EARLY_MEMBER_ID, '古参', ORG_A, 'member', '2026-09-01T00:00:00.000Z'),
  profileRow(OTHER_ORG_MEMBER_ID, '別の組織の人', ORG_B, 'admin', '2026-10-01T00:00:00.000Z'),
  profileRow(NO_ORG_ID, '組織なし', null, null, null),
];

let user: FakeServiceRole;
let admin: FakeServiceRole;

/** 呼び出す人を決める。利用者のクライアントで読めるのは、その人の行だけ (RLS) */
function callAs(userId: string | null) {
  mocks.getUser.mockResolvedValue(
    userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: { message: 'no session' } },
  );
  user = createFakeServiceRole({
    tables: { user_profiles: ALL_PROFILES.filter((row) => row.id === userId) },
    users: [],
  });
  mocks.userFrom.mockImplementation(user.from);
}

async function callGet() {
  const res = await GET(new Request('http://localhost/api/org/members'));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function membersOf(body: Record<string, unknown>) {
  return body.members as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  admin = createFakeServiceRole({ tables: { user_profiles: ALL_PROFILES }, users: [] });
  mocks.adminClient.mockReturnValue(admin.client);
});

describe('GET /api/org/members: 管理者には同じ組織のメンバーの名前を返す (#2073 S4)', () => {
  it('管理者 (admin) は、同じ組織のほかのメンバーを含む全員を、参加した日の古い順で読める', async () => {
    callAs(ADMIN_ID);
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(membersOf(body).map((m) => m.id)).toEqual([EARLY_MEMBER_ID, OWNER_ID, ADMIN_ID, MEMBER_ID]);
    expect(membersOf(body).map((m) => m.nickname)).toEqual(['古参', 'オーナー', '管理者', 'メンバー']);
  });

  it('オーナーも読める', async () => {
    callAs(OWNER_ID);
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(membersOf(body).map((m) => m.id)).toEqual([EARLY_MEMBER_ID, OWNER_ID, ADMIN_ID, MEMBER_ID]);
  });

  it('ほかの組織のメンバー・組織に属していない人は返らない', async () => {
    callAs(ADMIN_ID);
    const { body } = await callGet();

    const ids = membersOf(body).map((m) => m.id);
    expect(ids).not.toContain(OTHER_ORG_MEMBER_ID);
    expect(ids).not.toContain(NO_ORG_ID);
  });

  it('返す列は id・表示名・組織内の役割・参加した日の 4 つだけ (service_role の select もこの 4 つだけ)', async () => {
    callAs(ADMIN_ID);
    const { body } = await callGet();

    expect(Object.keys(body)).toEqual(['members']);
    for (const member of membersOf(body)) {
      expect(Object.keys(member).sort()).toEqual(RETURNED_KEYS);
    }
    expect(membersOf(body).find((m) => m.id === MEMBER_ID)).toEqual({
      id: MEMBER_ID,
      nickname: 'メンバー',
      org_role: 'member',
      joined_org_at: '2026-10-03T00:00:00.000Z',
    });
    expect(admin.selects).toEqual([{ table: 'user_profiles', columns: 'id, nickname, org_role, joined_org_at' }]);
  });

  it('service_role の読みが 4 つ以外の列を返しても、応答には 4 つだけを出す', async () => {
    callAs(ADMIN_ID);
    const leaky = {
      select: () => leaky,
      eq: () => leaky,
      order: async () => ({
        data: ALL_PROFILES.filter((row) => row.organization_id === ORG_A),
        error: null,
      }),
    };
    mocks.adminClient.mockReturnValue({ from: () => leaky });
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(membersOf(body)).toHaveLength(4);
    for (const member of membersOf(body)) {
      expect(Object.keys(member).sort()).toEqual(RETURNED_KEYS);
    }
    expect(JSON.stringify(body)).not.toContain('secret@example.test');
  });

  it('service_role のクライアントは、本人の行を読んで管理者だと確かめたあとに作る', async () => {
    callAs(ADMIN_ID);
    await callGet();

    expect(mocks.order).toEqual(['user:user_profiles', 'admin']);
  });
});

describe('GET /api/org/members: 呼べるのは同じ組織の管理者だけ (#2073 S4)', () => {
  it('一般メンバーは 403 で、service_role のクライアントを作らない', async () => {
    callAs(MEMBER_ID);
    const { status, body } = await callGet();

    expect(status).toBe(403);
    expect(body).toEqual({ error: ORG_API_FORBIDDEN_MESSAGE });
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it('組織に属していない人は 403 で、service_role のクライアントを作らない', async () => {
    callAs(NO_ORG_ID);
    const { status } = await callGet();

    expect(status).toBe(403);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it('ほかの組織の管理者は 200 だが、自分の組織のメンバーだけが返る (組織 A の人は返らない)', async () => {
    callAs(OTHER_ORG_MEMBER_ID);
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(membersOf(body).map((m) => m.id)).toEqual([OTHER_ORG_MEMBER_ID]);
  });

  it('未ログインは 401 で、service_role のクライアントを作らない', async () => {
    callAs(null);
    const { status, body } = await callGet();

    expect(status).toBe(401);
    expect(body).toEqual({ error: ORG_API_UNAUTHENTICATED_MESSAGE });
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it('本人の行を読めなかったときは 403 で、service_role のクライアントを作らない', async () => {
    callAs(ADMIN_ID);
    user.readErrors.user_profiles = { code: 'PGRST301', message: 'JWT expired' };
    const { status } = await callGet();

    expect(status).toBe(403);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });
});

describe('GET /api/org/members: 読みの失敗', () => {
  it('service_role の読みが失敗したら 500 と汎用の文だけを返し、DB の文は本文に出さない', async () => {
    callAs(ADMIN_ID);
    admin.readErrors.user_profiles = { code: '42P01', message: 'relation "user_profiles" does not exist' };
    const { status, body } = await callGet();

    expect(status).toBe(500);
    expect(body).toEqual({ error: ORG_API_INTERNAL_ERROR_MESSAGE });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });
});
