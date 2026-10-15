import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeServiceRole, type FakeServiceRole } from '../../operator/membership/fake-service-role';

// GET /api/family/members/names — 家族の画面に出すメンバーの名前 (#1584)。
//
// 招待を承諾したメンバーは family_members.display_name が NULL のままで、以前は家族の画面に「名前未設定」と出ていた。
// 承諾のときは本人のプロフィールの名前を display_name に写す (supabase/migrations/20261015120000_accept_copies_profile_name.sql。
// 仮置きの 'Guest'・空白だけは写さない)。それより前に承諾した人や、承諾のときに名前が無かった人は NULL のままなので、
// display_name → 本人のプロフィールの今の名前 (user_profiles.nickname。仮置きの 'Guest' は名前とみなさない) → null の順に決める。
// 他の家族の user_profiles は RLS で読めないので、名前だけを service_role で引く。
//
// 利用者のクライアント (RLS つき) と service_role のクライアントを別の偽物にする。利用者の偽物には、RLS で読める行
// (自分のプロフィールと、自分の家族のメンバーの行) だけを置く。service_role の偽物には全員のプロフィール
// (名前以外の列も) を置き、応答に名前以外が漏れないことを確かめる。

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  userFrom: vi.fn(),
  adminClient: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.userFrom,
  })),
  getSupabaseAdmin: () => mocks.adminClient(),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
  };
  return {
    createLogger: () => ({ ...logger, withUser: () => logger }),
    generateRequestId: () => 'req_test',
  };
});

import { GET } from '@/app/api/family/members/names/route';

const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'; // 代表者 (自分)
const INVITED_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'; // 名前を写す migration より前に招待を承諾した大人 (display_name が NULL)
const NAMED_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'; // display_name のある大人
const NO_NAME_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44'; // display_name もプロフィールの名前も無い大人
const LEFT_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55'; // 脱退した大人
const GUEST_ID = 'f1eebc99-9c0b-4ef8-bb6d-6bb9bd380a77'; // 初期設定より前に招待を承諾した大人 (プロフィールの名前が仮置きの 'Guest')

const M_REP = '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01';
const M_INVITED = '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a02';
const M_NAMED = '30eebc99-9c0b-4ef8-bb6d-6bb9bd380a03';
const M_NO_NAME = '40eebc99-9c0b-4ef8-bb6d-6bb9bd380a04';
const M_CHILD = '50eebc99-9c0b-4ef8-bb6d-6bb9bd380a05';
const M_LEFT = '60eebc99-9c0b-4ef8-bb6d-6bb9bd380a06';
const M_GUEST = '70eebc99-9c0b-4ef8-bb6d-6bb9bd380a07';

/** プロフィールの名前以外の列 (応答に漏れてはならない) */
const SECRET_COLUMNS = {
  roles: ['user'],
  family_id: FAMILY_ID,
  birth_date: '1990-01-01',
  weight: 60,
};

function profileRow(id: string, nickname: string) {
  return { id, nickname, ...SECRET_COLUMNS };
}

let user: FakeServiceRole;
let admin: FakeServiceRole;

function setup(memberOverrides: Array<Record<string, unknown>> | null = null) {
  const members = memberOverrides ?? [
    { id: M_REP, family_id: FAMILY_ID, user_id: REP_ID, role: 'representative', display_name: 'ママ', status: 'active' },
    { id: M_INVITED, family_id: FAMILY_ID, user_id: INVITED_ID, role: 'adult', display_name: null, status: 'active' },
    { id: M_NAMED, family_id: FAMILY_ID, user_id: NAMED_ID, role: 'adult', display_name: 'パパ', status: 'active' },
    { id: M_NO_NAME, family_id: FAMILY_ID, user_id: NO_NAME_ID, role: 'adult', display_name: null, status: 'active' },
    { id: M_CHILD, family_id: FAMILY_ID, user_id: null, role: 'child', display_name: null, status: 'active' },
    { id: M_LEFT, family_id: FAMILY_ID, user_id: LEFT_ID, role: 'adult', display_name: null, status: 'left' },
  ];
  // 利用者のクライアントで読めるのは、自分のプロフィールと自分の家族のメンバーの行だけ (RLS)
  user = createFakeServiceRole({
    tables: {
      user_profiles: [profileRow(REP_ID, '花子')],
      family_members: members,
    },
    users: [],
  });
  admin = createFakeServiceRole({
    tables: {
      user_profiles: [
        profileRow(REP_ID, '花子'),
        profileRow(INVITED_ID, '太郎'),
        profileRow(NAMED_ID, '次郎'),
        profileRow(NO_NAME_ID, '   '),
        profileRow(LEFT_ID, '去った人'),
        profileRow(GUEST_ID, 'Guest'),
      ],
    },
    users: [],
  });
  mocks.userFrom.mockImplementation(user.from);
  mocks.adminClient.mockReturnValue(admin.client);
}

async function callGet() {
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

function nameOf(body: { data: { members: Array<{ id: string; name: string | null }> } }, memberId: string) {
  return body.data.members.find((member) => member.id === memberId)?.name;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: REP_ID } }, error: null });
  setup();
});

describe('GET /api/family/members/names (#1584)', () => {
  it('display_name が NULL で、プロフィールに名前がある承諾済みのメンバー (名前を写す migration より前に承諾した人) は、プロフィールの名前で返る', async () => {
    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(nameOf(body, M_INVITED)).toBe('太郎');
  });

  it('display_name があれば、プロフィールの名前より優先する', async () => {
    const { body } = await callGet();

    expect(nameOf(body, M_NAMED)).toBe('パパ');
    expect(nameOf(body, M_REP)).toBe('ママ');
  });

  it('display_name もプロフィールの名前も無い (空白だけを含む) メンバー・アカウントの無い子供は null (画面は「名前未設定」)', async () => {
    const { body } = await callGet();

    expect(nameOf(body, M_NO_NAME)).toBeNull();
    expect(nameOf(body, M_CHILD)).toBeNull();
  });

  it("初期設定より前に招待を承諾した人 (display_name が NULL・プロフィールの名前が仮置きの 'Guest') は null (画面は「名前未設定」)", async () => {
    setup([
      { id: M_REP, family_id: FAMILY_ID, user_id: REP_ID, role: 'representative', display_name: 'ママ', status: 'active' },
      { id: M_GUEST, family_id: FAMILY_ID, user_id: GUEST_ID, role: 'adult', display_name: null, status: 'active' },
      { id: M_INVITED, family_id: FAMILY_ID, user_id: INVITED_ID, role: 'adult', display_name: null, status: 'active' },
    ]);

    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(nameOf(body, M_GUEST)).toBeNull();
    expect(JSON.stringify(body)).not.toContain('Guest');
    // 同じ応答の中で、実名のあるメンバーはその名前のまま
    expect(nameOf(body, M_INVITED)).toBe('太郎');
  });

  it('返すのは member id と名前だけ (プロフィールのほかの列・user_id・役割を返さない)', async () => {
    const { body } = await callGet();

    expect(Object.keys(body)).toEqual(['data']);
    expect(Object.keys(body.data)).toEqual(['members']);
    expect(body.data.members.length).toBeGreaterThan(0);
    for (const member of body.data.members) {
      expect(Object.keys(member).sort()).toEqual(['id', 'name']);
    }
    const text = JSON.stringify(body);
    for (const leaked of [INVITED_ID, NAMED_ID, '1990-01-01', 'representative']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('service_role では、display_name の無い active なメンバーの user_id の分だけ、名前の列だけを引く', async () => {
    // service_role の .in(...) に渡した相手を記録する
    const inArgs: Array<[string, unknown[]]> = [];
    mocks.adminClient.mockReturnValue({
      from: (table: string) => {
        const query = admin.from(table);
        const originalIn = query.in;
        query.in = (column: string, values: unknown[]) => {
          inArgs.push([column, values]);
          return originalIn(column, values);
        };
        return query;
      },
    });

    await callGet();

    expect(admin.selects).toEqual([{ table: 'user_profiles', columns: 'id, nickname' }]);
    // 引いた相手: 招待を承諾した人と、名前の無い人だけ (display_name のある人・子供・脱退した人は引かない)
    expect(inArgs).toHaveLength(1);
    expect(inArgs[0][0]).toBe('id');
    expect([...inArgs[0][1]].sort()).toEqual([INVITED_ID, NO_NAME_ID].sort());
  });

  it('脱退・除外されたメンバーは返さない (その後のプロフィールの名前を元の家族に出さない)', async () => {
    const { body } = await callGet();

    expect(body.data.members.map((member: { id: string }) => member.id)).not.toContain(M_LEFT);
    expect(JSON.stringify(body)).not.toContain('去った人');
  });

  it('全員に display_name があれば、service_role を使わない', async () => {
    setup([
      { id: M_REP, family_id: FAMILY_ID, user_id: REP_ID, role: 'representative', display_name: 'ママ', status: 'active' },
      { id: M_NAMED, family_id: FAMILY_ID, user_id: NAMED_ID, role: 'adult', display_name: 'パパ', status: 'active' },
    ]);

    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(body.data.members).toEqual([
      { id: M_REP, name: 'ママ' },
      { id: M_NAMED, name: 'パパ' },
    ]);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it('プロフィールの名前を引けなくても 200 で返し、その人は null (display_name のある人はそのまま)', async () => {
    admin.readErrors.user_profiles = { code: 'XX000', message: 'boom' };

    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(nameOf(body, M_INVITED)).toBeNull();
    expect(nameOf(body, M_NAMED)).toBe('パパ');
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it('service_role のクライアントを作れなくても (環境変数が無いなど) 200 で返す', async () => {
    mocks.adminClient.mockImplementation(() => {
      throw new Error('missing env');
    });

    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(nameOf(body, M_INVITED)).toBeNull();
    expect(nameOf(body, M_REP)).toBe('ママ');
  });

  it('家族に入っていなければ空の一覧を返し、service_role を使わない', async () => {
    user.tables.user_profiles = [{ ...profileRow(REP_ID, '花子'), family_id: null }];

    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(body).toEqual({ data: { members: [] } });
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it('ログインしていなければ 401 で、どのテーブルも読まない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const { status, body } = await callGet();

    expect(status).toBe(401);
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
    expect(mocks.userFrom).not.toHaveBeenCalled();
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it('メンバーの行を読めなければ 500 で、service_role を使わない', async () => {
    user.readErrors.family_members = { code: 'XX000', message: 'boom' };

    const { status, body } = await callGet();

    expect(status).toBe(500);
    expect(body.error.code).toBe('RPC_FAILED');
    expect(JSON.stringify(body)).not.toContain('boom');
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });
});
