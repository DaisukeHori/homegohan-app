import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeServiceRole, type FakeServiceRole, type Row } from '../../operator/membership/fake-service-role';
import { ORG_API_FORBIDDEN_MESSAGE, ORG_API_INTERNAL_ERROR_MESSAGE, ORG_API_UNAUTHENTICATED_MESSAGE } from '@/lib/org-api-errors';

// GET /api/org/owner-transfer/candidates — オーナーの譲渡の候補 (#2073 S4)。
//
// user_profiles の SELECT の RLS は本人の行だけなので、以前はオーナーの譲渡の画面が候補を直接読み、1 人も返らなかった。
// いまは、JWT の本人・所属組織・役割 (owner) を確かめてから、確かめた組織のメンバーのうち自分とオーナーを除いた人を
// service_role で読み、id・表示名・組織内の役割・参加した日の 4 つだけを返す。

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

const { GET } = await import('@/app/api/org/owner-transfer/candidates/route');

const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const OWNER_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '20000000-0000-4000-8000-000000000002';
const MEMBER_ID = '30000000-0000-4000-8000-000000000003';
const EARLY_MEMBER_ID = '40000000-0000-4000-8000-000000000004';
const OTHER_ORG_OWNER_ID = '50000000-0000-4000-8000-000000000005';
const OTHER_ORG_MEMBER_ID = '60000000-0000-4000-8000-000000000006';
/** 自分とは別に org_role = owner が付いた行 (ふつうは 1 組織 1 人。候補の条件「オーナーを除く」を確かめるための行) */
const SECOND_OWNER_ID = '70000000-0000-4000-8000-000000000007';

/** 返してはならない列 (アイコン・メールアドレス・年齢・健康・全体の役割など) */
const SECRET_COLUMNS = {
  avatar_url: 'https://example.test/avatar.png',
  email: 'secret@example.test',
  birth_date: '1990-01-01',
  weight: 60,
  roles: ['user'],
};

/** 返す列 (ORG_MEMBER_NAME_COLUMNS と同じ集合) */
const RETURNED_KEYS = ['id', 'joined_org_at', 'nickname', 'org_role'];

function profileRow(id: string, nickname: string, organizationId: string | null, orgRole: string | null, joinedOrgAt: string | null): Row {
  return { id, nickname, organization_id: organizationId, org_role: orgRole, joined_org_at: joinedOrgAt, ...SECRET_COLUMNS };
}

const BASE_PROFILES: Row[] = [
  profileRow(OWNER_ID, 'オーナー', ORG_A, 'owner', '2026-10-01T00:00:00.000Z'),
  profileRow(ADMIN_ID, '管理者', ORG_A, 'admin', '2026-10-02T00:00:00.000Z'),
  profileRow(MEMBER_ID, 'メンバー', ORG_A, 'member', '2026-10-03T00:00:00.000Z'),
  profileRow(EARLY_MEMBER_ID, '古参', ORG_A, 'member', '2026-09-01T00:00:00.000Z'),
  profileRow(OTHER_ORG_OWNER_ID, '別の組織のオーナー', ORG_B, 'owner', '2026-10-01T00:00:00.000Z'),
  profileRow(OTHER_ORG_MEMBER_ID, '別の組織の人', ORG_B, 'member', '2026-10-02T00:00:00.000Z'),
];

let user: FakeServiceRole;
let admin: FakeServiceRole;

function setProfiles(profiles: Row[]) {
  admin = createFakeServiceRole({ tables: { user_profiles: profiles }, users: [] });
  mocks.adminClient.mockReturnValue(admin.client);
}

/** 呼び出す人を決める。利用者のクライアントで読めるのは、その人の行だけ (RLS) */
function callAs(userId: string | null) {
  mocks.getUser.mockResolvedValue(
    userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: { message: 'no session' } },
  );
  user = createFakeServiceRole({
    tables: { user_profiles: BASE_PROFILES.filter((row) => row.id === userId) },
    users: [],
  });
  mocks.userFrom.mockImplementation(user.from);
}

async function callGet() {
  const res = await GET(new Request('http://localhost/api/org/owner-transfer/candidates'));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function candidatesOf(body: Record<string, unknown>) {
  return body.candidates as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  setProfiles(BASE_PROFILES);
});

describe('GET /api/org/owner-transfer/candidates: オーナーには自分とオーナーを除いた同じ組織のメンバーを返す (#2073 S4)', () => {
  it('オーナーは、自分以外の同じ組織のメンバー (管理者と一般メンバー) を、参加した日の古い順で読める', async () => {
    callAs(OWNER_ID);
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(candidatesOf(body).map((m) => m.id)).toEqual([EARLY_MEMBER_ID, ADMIN_ID, MEMBER_ID]);
    expect(candidatesOf(body).map((m) => m.nickname)).toEqual(['古参', '管理者', 'メンバー']);
  });

  it('自分は候補に入らない', async () => {
    callAs(OWNER_ID);
    const { body } = await callGet();

    expect(candidatesOf(body).map((m) => m.id)).not.toContain(OWNER_ID);
  });

  it('確かめたあとの読みの時点で自分の役割が owner でなくなっていても (譲渡の承諾と重なったなど)、自分は候補に入らない', async () => {
    // 利用者のクライアント (確かめる側) ではオーナー、service_role の読みの時点では admin になっている
    setProfiles(BASE_PROFILES.map((row) => (row.id === OWNER_ID ? { ...row, org_role: 'admin' } : row)));
    callAs(OWNER_ID);
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(candidatesOf(body).map((m) => m.id)).toEqual([EARLY_MEMBER_ID, ADMIN_ID, MEMBER_ID]);
  });

  it('自分とは別に owner の役割の行があっても、候補に入れない', async () => {
    setProfiles([...BASE_PROFILES, profileRow(SECOND_OWNER_ID, '2 人目のオーナー', ORG_A, 'owner', '2026-08-01T00:00:00.000Z')]);
    callAs(OWNER_ID);
    const { body } = await callGet();

    expect(candidatesOf(body).map((m) => m.id)).toEqual([EARLY_MEMBER_ID, ADMIN_ID, MEMBER_ID]);
  });

  it('ほかの組織の人は返らない', async () => {
    callAs(OWNER_ID);
    const { body } = await callGet();

    const ids = candidatesOf(body).map((m) => m.id);
    expect(ids).not.toContain(OTHER_ORG_OWNER_ID);
    expect(ids).not.toContain(OTHER_ORG_MEMBER_ID);
  });

  it('返す列は id・表示名・組織内の役割・参加した日の 4 つだけ (service_role の select もこの 4 つだけ)', async () => {
    callAs(OWNER_ID);
    const { body } = await callGet();

    expect(Object.keys(body)).toEqual(['candidates']);
    for (const candidate of candidatesOf(body)) {
      expect(Object.keys(candidate).sort()).toEqual(RETURNED_KEYS);
    }
    expect(candidatesOf(body).find((m) => m.id === ADMIN_ID)).toEqual({
      id: ADMIN_ID,
      nickname: '管理者',
      org_role: 'admin',
      joined_org_at: '2026-10-02T00:00:00.000Z',
    });
    expect(admin.selects).toEqual([{ table: 'user_profiles', columns: 'id, nickname, org_role, joined_org_at' }]);
  });

  it('service_role の読みが 4 つ以外の列を返しても、応答には 4 つだけを出す', async () => {
    callAs(OWNER_ID);
    const leakyResult = {
      data: BASE_PROFILES.filter((row) => row.organization_id === ORG_A && row.org_role !== 'owner'),
      error: null,
    };
    // order は重ねて呼ばれる (#2128 V3) ので、order も自分を返し、await で結果を返す
    const leaky = {
      select: () => leaky,
      eq: () => leaky,
      neq: () => leaky,
      order: () => leaky,
      then: (onFulfilled: (value: typeof leakyResult) => unknown) => Promise.resolve(leakyResult).then(onFulfilled),
    };
    mocks.adminClient.mockReturnValue({ from: () => leaky });
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(candidatesOf(body)).toHaveLength(3);
    for (const candidate of candidatesOf(body)) {
      expect(Object.keys(candidate).sort()).toEqual(RETURNED_KEYS);
    }
    expect(JSON.stringify(body)).not.toContain('secret@example.test');
  });

  it('service_role のクライアントは、本人の行を読んでオーナーだと確かめたあとに作る', async () => {
    callAs(OWNER_ID);
    await callGet();

    expect(mocks.order).toEqual(['user:user_profiles', 'admin']);
  });
});

describe('GET /api/org/owner-transfer/candidates: 同じ日に参加した人の並びは決まっている (#2128 V3)', () => {
  // メンバーの一覧と同じ並び (参加した日の古い順・同じ日は管理者 → メンバー・その中は id の順・参加した日が空の人は最後)。
  // id の順は、役割の順とも表の行の順とも違うようにしてある
  const SAME_DAY = '2026-10-20';
  const EARLIER_DAY = '2026-10-19';
  const ORG_C = 'c0000000-0000-4000-8000-00000000000c';
  const C_OWNER_ID = '05000000-0000-4000-8000-000000000005';
  const SAME_DAY_ADMIN_ID = '90000000-0000-4000-8000-000000000009';
  const SAME_DAY_ADMIN_LOW_ID = '13000000-0000-4000-8000-000000000013';
  const SAME_DAY_MEMBER_LOW_ID = '14000000-0000-4000-8000-000000000014';
  const SAME_DAY_MEMBER_HIGH_ID = 'b1000000-0000-4000-8000-0000000000b1';
  const EARLIER_MEMBER_ID = 'f0000000-0000-4000-8000-0000000000f0';
  const PENDING_HIGH_ID = 'e0000000-0000-4000-8000-0000000000e0';
  const PENDING_LOW_ID = '12000000-0000-4000-8000-000000000012';

  const SAME_DAY_PROFILES: Row[] = [
    profileRow(SAME_DAY_MEMBER_HIGH_ID, 'メンバー (id が大きい)', ORG_C, 'member', SAME_DAY),
    profileRow(PENDING_HIGH_ID, '承認待ち (id が大きい)', ORG_C, 'member', null),
    profileRow(SAME_DAY_MEMBER_LOW_ID, 'メンバー (id が小さい)', ORG_C, 'member', SAME_DAY),
    profileRow(SAME_DAY_ADMIN_ID, '管理者', ORG_C, 'admin', SAME_DAY),
    profileRow(EARLIER_MEMBER_ID, '前の日のメンバー', ORG_C, 'member', EARLIER_DAY),
    profileRow(C_OWNER_ID, 'オーナー', ORG_C, 'owner', SAME_DAY),
    profileRow(PENDING_LOW_ID, '承認待ち (id が小さい)', ORG_C, 'member', null),
    profileRow(SAME_DAY_ADMIN_LOW_ID, '管理者 (id が小さい)', ORG_C, 'admin', SAME_DAY),
  ];

  /** 前の日の人 → 同じ日の管理者 (id の順) → メンバー (id の順) → 参加した日が空の人 (id の順)。オーナー (自分) は入らない */
  const EXPECTED_IDS = [
    EARLIER_MEMBER_ID,
    SAME_DAY_ADMIN_LOW_ID,
    SAME_DAY_ADMIN_ID,
    SAME_DAY_MEMBER_LOW_ID,
    SAME_DAY_MEMBER_HIGH_ID,
    PENDING_LOW_ID,
    PENDING_HIGH_ID,
  ];

  function useSameDayOrg(profiles: Row[]) {
    setProfiles(profiles);
    mocks.getUser.mockResolvedValue({ data: { user: { id: C_OWNER_ID } }, error: null });
    user = createFakeServiceRole({ tables: { user_profiles: profiles.filter((row) => row.id === C_OWNER_ID) }, users: [] });
    mocks.userFrom.mockImplementation(user.from);
  }

  it('同じ日に参加した人は、管理者 → メンバーの順で、その中は id の順。参加した日が空の人は最後', async () => {
    useSameDayOrg(SAME_DAY_PROFILES);
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(candidatesOf(body).map((m) => m.id)).toEqual(EXPECTED_IDS);
  });

  it('DB の行の順が変わっても、返る順は同じ (読み込みのたびに入れ替わらない)', async () => {
    useSameDayOrg([...SAME_DAY_PROFILES].reverse());
    const reversed = await callGet();
    useSameDayOrg([...SAME_DAY_PROFILES.slice(3), ...SAME_DAY_PROFILES.slice(0, 3)]);
    const rotated = await callGet();

    expect(candidatesOf(reversed.body).map((m) => m.id)).toEqual(EXPECTED_IDS);
    expect(candidatesOf(rotated.body).map((m) => m.id)).toEqual(EXPECTED_IDS);
  });

  it('並びは DB に任せる: 参加した日の昇順 (空は最後)・役割の昇順 (enum の宣言の順)・id の昇順の 3 つの order を、この順に送る', async () => {
    useSameDayOrg(SAME_DAY_PROFILES);
    await callGet();

    expect(admin.orders).toEqual([
      { table: 'user_profiles', column: 'joined_org_at', ascending: true, nullsFirst: false },
      { table: 'user_profiles', column: 'org_role', ascending: true, nullsFirst: false },
      { table: 'user_profiles', column: 'id', ascending: true, nullsFirst: false },
    ]);
  });
});

describe('GET /api/org/owner-transfer/candidates: 呼べるのはその組織のオーナーだけ (#2073 S4)', () => {
  it('管理者 (admin) は 403 で、service_role のクライアントを作らない', async () => {
    callAs(ADMIN_ID);
    const { status, body } = await callGet();

    expect(status).toBe(403);
    expect(body).toEqual({ error: ORG_API_FORBIDDEN_MESSAGE });
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it('一般メンバーは 403 で、service_role のクライアントを作らない', async () => {
    callAs(MEMBER_ID);
    const { status, body } = await callGet();

    expect(status).toBe(403);
    expect(body).toEqual({ error: ORG_API_FORBIDDEN_MESSAGE });
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it('ほかの組織のオーナーは 200 だが、自分の組織の候補だけが返る (組織 A の人は返らない)', async () => {
    callAs(OTHER_ORG_OWNER_ID);
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(candidatesOf(body).map((m) => m.id)).toEqual([OTHER_ORG_MEMBER_ID]);
  });

  it('未ログインは 401 で、service_role のクライアントを作らない', async () => {
    callAs(null);
    const { status, body } = await callGet();

    expect(status).toBe(401);
    expect(body).toEqual({ error: ORG_API_UNAUTHENTICATED_MESSAGE });
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });
});

describe('GET /api/org/owner-transfer/candidates: 読みの失敗', () => {
  it('service_role の読みが失敗したら 500 と汎用の文だけを返し、DB の文は本文に出さない', async () => {
    callAs(OWNER_ID);
    admin.readErrors.user_profiles = { code: '42P01', message: 'relation "user_profiles" does not exist' };
    const { status, body } = await callGet();

    expect(status).toBe(500);
    expect(body).toEqual({ error: ORG_API_INTERNAL_ERROR_MESSAGE });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });
});
