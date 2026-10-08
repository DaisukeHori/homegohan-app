/**
 * #1132 組織チャレンジのメンバー向け API (route) のテスト
 *
 * 対象:
 *   GET    /api/org/my-challenges           自分の組織のチャレンジと、自分の参加状況
 *   GET    /api/org/challenges/[id]         チャレンジ 1 件の詳細。参加者本人にだけ順位表を返す
 *   POST   /api/org/challenges/[id]/join    参加する (任意参加)。本人の権限で #1238 の INSERT ポリシーを通す
 *   DELETE /api/org/challenges/[id]/join    参加をやめる
 *
 * 確認すること:
 *  1. 認可: 未ログインは 401、組織に所属していない人は 403。認可の前に DB も service_role も使わない。
 *     管理者 (owner / admin) も、一般のメンバーと同じ扱い (参加するかを選べる。参加しなければ順位表は見えない)。
 *  2. 組織の絞り込み: 呼び出した人の所属組織のチャレンジだけ。他組織・下書き・中止・使えない種類・別の部署向けは、存在を知らせず 404。
 *     service_role の DB 関数には、認可で確定した組織 ID・本人の ID だけを渡す。
 *  3. 参加: 開催中で、使える種類で、終了日 (JST) を過ぎていないチャレンジだけ。本人の権限 (service_role ではない) で、
 *     チャレンジ ID と本人の ID だけを INSERT する。二重の参加は 200 (alreadyJoined)、RLS の拒否は 403。
 *  4. 順位表: 参加者本人にだけ。参加していない人には DB の関数も呼ばない。表示名は環境変数 ORG_CHALLENGE_SHOW_NAMES が
 *     有効なときだけ (未設定は「あなた」「参加者」)。他人の ID は応答のどこにも現れない。
 *  5. 参加者数は、最小人数に満たないとき null (管理者もメンバーとして呼べるので、管理者向けの API と同じ規則)。
 *  6. 500 の本文は汎用メッセージだけ。DB の生のエラー文は db-logger にだけ残す (#1172)。
 *
 * DB のモックは tests/helpers/schema-checked-db.ts (存在しない列は本物の PostgREST と同じエラーになる)。
 * RLS は再現しないので、本人のセッションの DB には「RLS で本人に見える行」だけを入れて再現する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// service_role の rpc (集計・順位表の DB 関数)
const mockAdminRpc = vi.fn();
const mockGetSupabaseAdmin = vi.fn();
let sessionUser: FakeUser | null = null;
let sessionDb: SchemaDb;
const adminDb = createSchemaDb({ tables: {} });

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}));

const myChallenges = await import('@/app/api/org/my-challenges/route');
const detail = await import('@/app/api/org/challenges/[id]/route');
const joinRoute = await import('@/app/api/org/challenges/[id]/join/route');

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ORG_A = uuid(100);
const ORG_B = uuid(200);
const DEPT_1 = uuid(301);
const DEPT_2 = uuid(302);

const OWNER_A = uuid(1); // 組織 A の owner (部署なし)
const ADMIN_A = uuid(2); // 組織 A の admin (部署 1)
const MEMBER_A1 = uuid(3); // 部署 1
const MEMBER_A2 = uuid(4); // 部署 2
const MEMBER_A3 = uuid(5); // 部署なし
const OUTSIDER = uuid(6); // 組織に所属していない
const MEMBER_B = uuid(7); // 組織 B

const FAR_FUTURE = '2099-12-31';

const C_BREAKFAST = uuid(401); // 開催中 (全員向け)
const C_VEG = uuid(402); // 開催中 (全員向け)
const C_COOKING_DONE = uuid(403); // 終了
const C_DRAFT = uuid(404);
const C_CANCELLED = uuid(405);
const C_STEPS = uuid(406); // 使えない種類
const C_CUSTOM = uuid(407); // 使えない種類
const C_DEPT_1 = uuid(408); // 部署 1 向け
const C_ENDED = uuid(409); // 開催中のままだが、終了日 (JST) を過ぎている
const C_OTHER_ORG = uuid(410); // 組織 B

function challengeRow(id: string, extra: Row = {}): Row {
  return {
    id,
    organization_id: ORG_A,
    title: `チャレンジ ${id.slice(-3)}`,
    description: null,
    challenge_type: 'breakfast_rate',
    target_value: 80,
    target_unit: '%',
    start_date: '2026-10-01',
    end_date: FAR_FUTURE,
    reward_description: null,
    status: 'active',
    department_id: null,
    created_at: '2026-09-01T00:00:00Z',
    ...extra,
  };
}

function worldTables(): Record<string, Row[]> {
  return {
    user_profiles: [
      profileRow(OWNER_A, { nickname: '山田オーナー', organization_id: ORG_A, org_role: 'owner' }),
      profileRow(ADMIN_A, { nickname: '佐藤管理者', organization_id: ORG_A, org_role: 'admin', department_id: DEPT_1 }),
      profileRow(MEMBER_A1, { nickname: '鈴木一郎', organization_id: ORG_A, org_role: 'member', department_id: DEPT_1 }),
      profileRow(MEMBER_A2, { nickname: '高橋二郎', organization_id: ORG_A, org_role: 'member', department_id: DEPT_2 }),
      profileRow(MEMBER_A3, { nickname: '田中三郎', organization_id: ORG_A, org_role: 'member' }),
      profileRow(OUTSIDER, { nickname: '伊藤' }),
      profileRow(MEMBER_B, { nickname: '渡辺他組織', organization_id: ORG_B, org_role: 'member' }),
    ],
    departments: [
      { id: DEPT_1, organization_id: ORG_A, name: '営業部', parent_id: null, manager_id: null, display_order: 1, created_at: '2026-02-01T00:00:00Z' },
      { id: DEPT_2, organization_id: ORG_A, name: '開発部', parent_id: null, manager_id: null, display_order: 2, created_at: '2026-02-02T00:00:00Z' },
    ],
    organization_challenges: [
      challengeRow(C_BREAKFAST, { title: '朝食チャレンジ', created_at: '2026-09-05T00:00:00Z' }),
      challengeRow(C_VEG, { title: '野菜チャレンジ', challenge_type: 'veg_score', target_value: 70, target_unit: '点', start_date: '2026-10-05' }),
      challengeRow(C_COOKING_DONE, { title: '終わった自炊チャレンジ', challenge_type: 'cooking_rate', status: 'completed', start_date: '2026-08-01', end_date: '2026-08-31' }),
      challengeRow(C_DRAFT, { title: '下書き', status: 'draft' }),
      challengeRow(C_CANCELLED, { title: '中止', status: 'cancelled' }),
      challengeRow(C_STEPS, { title: '歩数', challenge_type: 'steps', target_unit: '歩' }),
      challengeRow(C_CUSTOM, { title: 'カスタム', challenge_type: 'custom' }),
      challengeRow(C_DEPT_1, { title: '営業部だけの朝食チャレンジ', department_id: DEPT_1, start_date: '2026-10-02' }),
      challengeRow(C_ENDED, { title: '終了日を過ぎた開催中', start_date: '2020-01-01', end_date: '2020-01-31' }),
      challengeRow(C_OTHER_ORG, { organization_id: ORG_B, title: '他組織のチャレンジ' }),
    ],
    organization_challenge_participants: [
      // 他の参加者の行 (本人以外には、RLS で見えない)
      { id: 'p1', challenge_id: C_BREAKFAST, user_id: MEMBER_A1, current_value: 50, rank: 2, joined_at: '2026-10-02T00:00:00Z' },
      { id: 'p2', challenge_id: C_BREAKFAST, user_id: MEMBER_A2, current_value: 80, rank: 1, joined_at: '2026-10-03T00:00:00Z' },
      { id: 'p3', challenge_id: C_VEG, user_id: ADMIN_A, current_value: 0, rank: null, joined_at: '2026-10-06T00:00:00Z' },
      { id: 'p4', challenge_id: C_COOKING_DONE, user_id: MEMBER_A1, current_value: 33.3, rank: 1, joined_at: '2026-08-02T00:00:00Z' },
      { id: 'p5', challenge_id: C_OTHER_ORG, user_id: MEMBER_B, current_value: 10, rank: 1, joined_at: '2026-10-02T00:00:00Z' },
    ],
  };
}

/** 本人のセッションの DB: RLS で本人に見える行だけ (自分のプロフィール、自分の組織のチャレンジ、自分の参加行) */
function sessionTablesFor(actorId: string, errors?: Record<string, DbError>) {
  const world = worldTables();
  const profile = world.user_profiles.find((p) => p.id === actorId);
  return createSchemaDb({
    tables: {
      user_profiles: profile ? [profile] : [],
      organization_challenges: profile?.organization_id
        ? world.organization_challenges.filter((c) => c.organization_id === profile.organization_id)
        : [],
      organization_challenge_participants: world.organization_challenge_participants.filter((p) => p.user_id === actorId),
    },
    errors,
  });
}

function setup(options: { actor?: string | null; errors?: Record<string, DbError> } = {}) {
  const actor = options.actor === undefined ? MEMBER_A1 : options.actor;
  sessionUser = actor === null ? null : { id: actor, email: 'actor@example.com' };
  sessionDb = sessionTablesFor(actor ?? uuid(999), options.errors);
}

const json = (res: Response) => res.json() as Promise<any>;
const url = (path: string) => `http://localhost${path}`;

/** DB の関数 get_org_challenge_aggregates の応答 (チャレンジごとの人数・最小人数・平均) */
function aggregateRows(rows: Array<[string, number | null]>) {
  return rows.map(([challenge_id, participant_count]) => ({
    challenge_id,
    participant_count,
    min_participants: 5,
    average_value: null,
  }));
}

/** DB の関数 get_org_challenge_ranking の応答 (他人の user_id を含まない) */
const RANKING_ROWS = [
  { rank: 1, current_value: 80, is_me: false, nickname: '高橋二郎', ranked_count: 2 },
  { rank: 2, current_value: 50, is_me: true, nickname: '鈴木一郎', ranked_count: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSupabaseAdmin.mockImplementation(() => makeClient(adminDb, null, mockAdminRpc));
  mockAdminRpc.mockImplementation(async (name: string) => {
    if (name === 'get_org_challenge_aggregates') return { data: aggregateRows([[C_BREAKFAST, 7]]), error: null };
    if (name === 'get_org_challenge_ranking') return { data: RANKING_ROWS, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
  setup();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const idParams = (id: string) => ({ params: { id } });

// ─────────────────────────────────────────────────────────────────────────────
// 1. 認可
// ─────────────────────────────────────────────────────────────────────────────

interface Endpoint {
  name: string;
  call: () => Promise<Response>;
}

const endpoints: Endpoint[] = [
  { name: 'GET /api/org/my-challenges', call: () => myChallenges.GET() },
  { name: 'GET /api/org/challenges/[id]', call: () => detail.GET(new Request(url('/x')), idParams(C_BREAKFAST)) },
  { name: 'POST /api/org/challenges/[id]/join', call: () => joinRoute.POST(jsonRequest(url('/x'), 'POST'), idParams(C_BREAKFAST)) },
  { name: 'DELETE /api/org/challenges/[id]/join', call: () => joinRoute.DELETE(jsonRequest(url('/x'), 'DELETE'), idParams(C_BREAKFAST)) },
];

describe.each(endpoints)('認可: $name', (endpoint) => {
  it('401: 未ログイン。DB も service_role も使わない', async () => {
    setup({ actor: null });

    const res = await endpoint.call();

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: { code: 'UNAUTHORIZED', message: 'ログインが必要です' } });
    expect(sessionDb.queries).toHaveLength(0);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['組織に所属していない一般ユーザー', OUTSIDER],
    ['プロフィールの行が無いユーザー', uuid(777)],
  ])('403: %s。認可のためのプロフィールの確認のほかは DB を読み書きせず、service_role も使わない', async (_label, actor) => {
    setup({ actor });

    const res = await endpoint.call();

    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('FORBIDDEN');
    expect(sessionDb.queries.filter((q) => q.table !== 'user_profiles')).toHaveLength(0);
    expect(sessionDb.queries.filter((q) => q.op !== 'select')).toHaveLength(0);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['一般のメンバー', MEMBER_A1],
    ['組織の admin', ADMIN_A],
    ['組織の owner', OWNER_A],
  ])('%s は使える (役割は問わない。管理者も、参加するかどうかを選べるメンバーのひとり)', async (_label, actor) => {
    setup({ actor });

    const res = await endpoint.call();

    expect(res.status).toBeLessThan(400);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/org/my-challenges
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/org/my-challenges', () => {
  it('食事の記録から計算できる種類で、開催中か終了したチャレンジだけ。開催中が先。同じ状態の中では開始日が新しい順', async () => {
    const body = await json(await myChallenges.GET());

    // 下書き・中止・歩数・カスタム・他組織・別の部署向けは出ない。MEMBER_A1 は部署 1 なので、部署 1 向けは出る
    expect(body.challenges.map((c: Row) => c.id)).toEqual([C_VEG, C_DEPT_1, C_BREAKFAST, C_COOKING_DONE, C_ENDED]);
    expect(body.challenges.map((c: Row) => c.status)).toEqual(['active', 'active', 'active', 'completed', 'completed']);
  });

  it('DB の状態が開催中のままでも、終了日 (JST) を過ぎていれば「終了」として返す (画面が参加ボタンを出して 409 で断られないように)', async () => {
    const body = await json(await myChallenges.GET());

    expect(body.challenges.find((c: Row) => c.id === C_ENDED)).toMatchObject({ endDate: '2020-01-31', status: 'completed' });
    // 終了日がこれからのチャレンジは、開催中のまま
    expect(body.challenges.find((c: Row) => c.id === C_BREAKFAST).status).toBe('active');
  });

  it('部署を限定したチャレンジは、その部署のメンバーにだけ出る', async () => {
    setup({ actor: MEMBER_A2 }); // 部署 2
    const other = await json(await myChallenges.GET());
    setup({ actor: MEMBER_A3 }); // 部署なし
    const none = await json(await myChallenges.GET());

    expect(other.challenges.map((c: Row) => c.id)).not.toContain(C_DEPT_1);
    expect(none.challenges.map((c: Row) => c.id)).not.toContain(C_DEPT_1);
  });

  it('メンバー向けの形で返す。部署 ID など管理用の項目は含めない', async () => {
    const body = await json(await myChallenges.GET());

    const breakfast = body.challenges.find((c: Row) => c.id === C_BREAKFAST);
    expect(breakfast).toEqual({
      id: C_BREAKFAST,
      title: '朝食チャレンジ',
      description: null,
      challengeType: 'breakfast_rate',
      targetValue: 80,
      targetUnit: '%',
      startDate: '2026-10-01',
      endDate: FAR_FUTURE,
      rewardDescription: null,
      status: 'active',
      participantCount: 7,
      joined: true,
      me: { currentValue: 50, rank: 2, joinedAt: '2026-10-02T00:00:00Z' },
    });
    expect(JSON.stringify(body)).not.toContain(DEPT_1);
  });

  it('自分の参加状況だけを返す。参加していなければ joined = false・me = null。順位がまだ無ければ rank は null', async () => {
    const body = await json(await myChallenges.GET());

    const veg = body.challenges.find((c: Row) => c.id === C_VEG);
    expect(veg).toMatchObject({ joined: false, me: null });
    // ADMIN_A は C_VEG に参加している (まだ集計されていない)
    setup({ actor: ADMIN_A });
    const asAdmin = await json(await myChallenges.GET());
    expect(asAdmin.challenges.find((c: Row) => c.id === C_VEG)).toMatchObject({
      joined: true,
      me: { currentValue: 0, rank: null },
    });
  });

  it('他の参加者の ID・値・順位は応答のどこにも現れない', async () => {
    const text = await (await myChallenges.GET()).text();

    for (const other of [MEMBER_A2, MEMBER_A3, ADMIN_A, OWNER_A, MEMBER_B]) expect(text).not.toContain(other);
    expect(text).not.toContain('高橋二郎');
    expect(text).not.toContain('"currentValue":80');
  });

  it('呼び出した人の組織だけを読む。自分の参加行だけを、自分の ID で絞って読む', async () => {
    await myChallenges.GET();

    const challengeQuery = sessionDb.recorded('organization_challenges', 'select')[0];
    expect(challengeQuery.eq).toContainEqual(['organization_id', ORG_A]);
    expect(challengeQuery.in).toContainEqual(['status', ['active', 'completed']]);
    expect(challengeQuery.in).toContainEqual(['challenge_type', ['breakfast_rate', 'veg_score', 'cooking_rate']]);
    const participationQuery = sessionDb.recorded('organization_challenge_participants', 'select')[0];
    expect(participationQuery.eq).toContainEqual(['user_id', MEMBER_A1]);
    expect(participationQuery.select).toBe('challenge_id, current_value, rank, joined_at');
  });

  it('参加者数は、認可で確定した自分の組織の分だけ service_role の DB 関数で取る (参加者の行は読まない)', async () => {
    await myChallenges.GET();

    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    expect(mockAdminRpc).toHaveBeenCalledWith('get_org_challenge_aggregates', { p_organization_id: ORG_A });
    expect(adminDb.queries).toHaveLength(0);
  });

  it('参加者が最小人数に満たないチャレンジの参加者数は null。最小人数 (minParticipants) を一緒に返す', async () => {
    mockAdminRpc.mockResolvedValue({ data: aggregateRows([[C_BREAKFAST, null], [C_VEG, 12]]), error: null });

    const body = await json(await myChallenges.GET());

    expect(body.minParticipants).toBe(5);
    expect(body.challenges.find((c: Row) => c.id === C_BREAKFAST).participantCount).toBeNull();
    expect(body.challenges.find((c: Row) => c.id === C_VEG).participantCount).toBe(12);
    // 集計の行が無いチャレンジも、0 人とは偽らない
    expect(body.challenges.find((c: Row) => c.id === C_ENDED).participantCount).toBeNull();
  });

  it('管理者がメンバーとして呼んでも、参加者数は同じ規則で隠される (管理者向けの制限を迂回できない)', async () => {
    setup({ actor: ADMIN_A });
    mockAdminRpc.mockResolvedValue({ data: aggregateRows([[C_BREAKFAST, null]]), error: null });

    const body = await json(await myChallenges.GET());

    expect(body.challenges.find((c: Row) => c.id === C_BREAKFAST).participantCount).toBeNull();
  });

  it('見せるチャレンジが 1 件も無いときは、DB の関数を呼ばない', async () => {
    setup({ actor: MEMBER_B }); // 組織 B には開催中のチャレンジがある…ので、チャレンジを消した DB に差し替える
    sessionDb = createSchemaDb({
      tables: {
        user_profiles: [profileRow(MEMBER_B, { organization_id: ORG_B, org_role: 'member' })],
        organization_challenges: [],
        organization_challenge_participants: [],
      },
    });

    const res = await myChallenges.GET();

    expect(res.status).toBe(200);
    expect((await json(res)).challenges).toEqual([]);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('500: DB の失敗は汎用メッセージだけ。生のエラー文は返さず、記録にだけ残す', async () => {
    const RAW = 'relation "organization_challenges" is broken; password=hunter2';
    setup({ errors: { organization_challenges: { message: RAW, code: 'XX000' } } });

    const res = await myChallenges.GET();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(text).not.toContain('hunter2');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('GET /api/org/my-challenges');
  });

  it('500: 参加者数の DB 関数の失敗は、人数なしで返さず 500', async () => {
    mockAdminRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied; token=abc' } });

    const res = await myChallenges.GET();

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('abc');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/org/challenges/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/org/challenges/[id]', () => {
  const get = (id: string) => detail.GET(new Request(url(`/api/org/challenges/${id}`)), idParams(id));

  it.each([
    ['UUID でない文字列 (DB に渡さない)', 'not-a-uuid'],
    ['存在しないチャレンジ', uuid(999)],
    ['他組織のチャレンジ', C_OTHER_ORG],
    ['下書き', C_DRAFT],
    ['中止', C_CANCELLED],
    ['歩数 (使えない種類)', C_STEPS],
    ['カスタム (使えない種類)', C_CUSTOM],
    ['別の部署向けのチャレンジ', C_DEPT_1, MEMBER_A2],
  ])('404: %s。存在を知らせない', async (_label, id, actor) => {
    if (actor) setup({ actor });

    const res = await get(id);

    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: 'CHALLENGE_NOT_FOUND', message: 'チャレンジが見つかりません' } });
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it('参加していない人: チャレンジと人数は見えるが、順位表は返さない (DB の順位表の関数も呼ばない)', async () => {
    setup({ actor: MEMBER_A3 });

    const body = await json(await get(C_BREAKFAST));

    expect(body.challenge).toMatchObject({ id: C_BREAKFAST, title: '朝食チャレンジ', challengeType: 'breakfast_rate' });
    expect(body.joined).toBe(false);
    expect(body.me).toBeNull();
    expect(body.ranking).toEqual({ available: false, showNames: false });
    expect(mockAdminRpc.mock.calls.map((c) => c[0])).toEqual(['get_org_challenge_aggregates']);
    expect(JSON.stringify(body)).not.toContain('"entries"');
  });

  it('参加していない管理者にも、順位表は返さない (管理者には集計だけ)', async () => {
    setup({ actor: OWNER_A });

    const body = await json(await get(C_BREAKFAST));

    expect(body.joined).toBe(false);
    expect(body.ranking.available).toBe(false);
    expect(mockAdminRpc.mock.calls.map((c) => c[0])).not.toContain('get_org_challenge_ranking');
  });

  it('参加者本人には、自分の記録と順位表を返す。表示名は出さない (未設定の既定)', async () => {
    const body = await json(await get(C_BREAKFAST));

    expect(body.joined).toBe(true);
    expect(body.me).toEqual({ currentValue: 50, rank: 2, joinedAt: '2026-10-02T00:00:00Z' });
    expect(body.ranking).toEqual({
      available: true,
      showNames: false,
      rankedCount: 2,
      truncated: false,
      entries: [
        { rank: 1, value: 80, isMe: false, label: '参加者' },
        { rank: 2, value: 50, isMe: true, label: 'あなた' },
      ],
    });
    // DB の関数には、本人の ID と、表示名を求めない指定を渡す
    expect(mockAdminRpc).toHaveBeenCalledWith('get_org_challenge_ranking', {
      p_challenge_id: C_BREAKFAST,
      p_user_id: MEMBER_A1,
      p_limit: 20,
      p_with_names: false,
    });
  });

  it('表示名を出さない設定のとき、他人のニックネーム・ID は応答のどこにも現れない', async () => {
    const text = await (await get(C_BREAKFAST)).text();

    expect(text).not.toContain('高橋二郎');
    expect(text).not.toContain('鈴木一郎');
    for (const other of [MEMBER_A2, MEMBER_A3, ADMIN_A, OWNER_A, MEMBER_B]) expect(text).not.toContain(other);
  });

  it.each(['1', 'true', 'on', 'yes', 'ON'])('ORG_CHALLENGE_SHOW_NAMES=%s: ほかの参加者はニックネーム、本人は「あなた」', async (value) => {
    vi.stubEnv('ORG_CHALLENGE_SHOW_NAMES', value);

    const body = await json(await get(C_BREAKFAST));

    expect(body.ranking.showNames).toBe(true);
    expect(body.ranking.entries.map((e: Row) => e.label)).toEqual(['高橋二郎', 'あなた']);
    expect(mockAdminRpc).toHaveBeenCalledWith('get_org_challenge_ranking', expect.objectContaining({ p_with_names: true }));
    // 本人のニックネームを出さない。ID も出さない
    const text = JSON.stringify(body);
    expect(text).not.toContain('鈴木一郎');
    expect(text).not.toContain(MEMBER_A2);
  });

  it.each(['', '0', 'false', 'off', 'no'])('ORG_CHALLENGE_SHOW_NAMES=%j: 表示名は出さない', async (value) => {
    vi.stubEnv('ORG_CHALLENGE_SHOW_NAMES', value);

    const body = await json(await get(C_BREAKFAST));

    expect(body.ranking.showNames).toBe(false);
    expect(mockAdminRpc).toHaveBeenCalledWith('get_org_challenge_ranking', expect.objectContaining({ p_with_names: false }));
  });

  it('参加していない人にも、表示名を出すかどうか (showNames) は伝える (参加を決める前の説明用)', async () => {
    vi.stubEnv('ORG_CHALLENGE_SHOW_NAMES', 'on');
    setup({ actor: MEMBER_A3 });

    const body = await json(await get(C_BREAKFAST));

    expect(body.ranking).toEqual({ available: false, showNames: true });
  });

  it('参加している管理者は、一般のメンバーと同じく順位表を見られる', async () => {
    setup({ actor: ADMIN_A });
    const res = await get(C_VEG);
    const body = await json(res);

    expect(body.joined).toBe(true);
    expect(body.ranking.available).toBe(true);
  });

  it('順位表は上位と本人の行だけ。全員の人数より少ない行数のとき truncated = true', async () => {
    mockAdminRpc.mockImplementation(async (name: string) =>
      name === 'get_org_challenge_ranking'
        ? { data: RANKING_ROWS.map((r) => ({ ...r, ranked_count: 30 })), error: null }
        : { data: aggregateRows([[C_BREAKFAST, 30]]), error: null },
    );

    const body = await json(await get(C_BREAKFAST));

    expect(body.ranking.rankedCount).toBe(30);
    expect(body.ranking.truncated).toBe(true);
    expect(body.ranking.entries).toHaveLength(2);
  });

  it('終了したチャレンジも、見られる (最終の結果)。参加者の記録・順位表つき', async () => {
    const body = await json(await get(C_COOKING_DONE));

    expect(body.challenge.status).toBe('completed');
    expect(body.me).toMatchObject({ currentValue: 33.3, rank: 1 });
    expect(body.ranking.available).toBe(true);
  });

  it('自分の参加行だけを、自分の ID で絞って読む。呼び出した人の組織のチャレンジだけを読む', async () => {
    await get(C_BREAKFAST);

    const challengeQuery = sessionDb.recorded('organization_challenges', 'select')[0];
    expect(challengeQuery.eq).toContainEqual(['id', C_BREAKFAST]);
    expect(challengeQuery.eq).toContainEqual(['organization_id', ORG_A]);
    const participation = sessionDb.recorded('organization_challenge_participants', 'select')[0];
    expect(participation.eq).toContainEqual(['challenge_id', C_BREAKFAST]);
    expect(participation.eq).toContainEqual(['user_id', MEMBER_A1]);
    expect(mockAdminRpc).toHaveBeenCalledWith('get_org_challenge_aggregates', { p_organization_id: ORG_A });
  });

  it('参加者数は最小人数に満たないとき null。最小人数 (minParticipants) を一緒に返す', async () => {
    mockAdminRpc.mockImplementation(async (name: string) =>
      name === 'get_org_challenge_ranking'
        ? { data: RANKING_ROWS, error: null }
        : { data: aggregateRows([[C_BREAKFAST, null]]), error: null },
    );

    const body = await json(await get(C_BREAKFAST));

    expect(body.participantCount).toBeNull();
    expect(body.minParticipants).toBe(5);
  });

  it('500: 順位表の DB 関数の失敗は汎用メッセージだけ。生のエラー文は返さない', async () => {
    mockAdminRpc.mockImplementation(async (name: string) =>
      name === 'get_org_challenge_ranking'
        ? { data: null, error: { code: 'XX000', message: 'boom; secret=abc123' } }
        : { data: aggregateRows([[C_BREAKFAST, 7]]), error: null },
    );

    const res = await get(C_BREAKFAST);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(text).not.toContain('abc123');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('GET /api/org/challenges/[id]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /api/org/challenges/[id]/join
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/org/challenges/[id]/join (参加する)', () => {
  const post = (id: string, body?: unknown) => joinRoute.POST(jsonRequest(url(`/api/org/challenges/${id}/join`), 'POST', body), idParams(id));
  const inserts = () => sessionDb.recorded('organization_challenge_participants', 'insert');

  beforeEach(() => {
    setup({ actor: MEMBER_A3 }); // どのチャレンジにも参加していない、部署なしのメンバー
  });

  it('開催中のチャレンジに参加できる。本人の権限 (service_role ではない) で、チャレンジ ID と本人の ID だけを書く', async () => {
    const res = await post(C_BREAKFAST);

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ joined: true, alreadyJoined: false });
    expect(inserts()).toHaveLength(1);
    // current_value / rank / 組織 ID などは書かない (#1238 のポリシーが「進捗 0・順位なし」を確かめる)
    expect(inserts()[0].values).toEqual({ challenge_id: C_BREAKFAST, user_id: MEMBER_A3 });
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(adminDb.queries).toHaveLength(0);
  });

  it('本文に user_id などを付けても使わない。書かれるのは認可で確定した本人の ID', async () => {
    const res = await post(C_BREAKFAST, { user_id: MEMBER_A1, challenge_id: C_VEG, current_value: 100, rank: 1 });

    expect(res.status).toBe(200);
    expect(inserts()[0].values).toEqual({ challenge_id: C_BREAKFAST, user_id: MEMBER_A3 });
  });

  it.each([
    ['全体向けの朝食チャレンジ', C_BREAKFAST],
    ['野菜スコア', C_VEG],
  ])('%s に、組織の管理者 (owner) も参加できる', async (_label, id) => {
    setup({ actor: OWNER_A });

    expect((await post(id)).status).toBe(200);
    expect(inserts()[0].values).toEqual({ challenge_id: id, user_id: OWNER_A });
  });

  it('自分の部署向けのチャレンジに参加できる', async () => {
    setup({ actor: MEMBER_A1 }); // 部署 1

    expect((await post(C_DEPT_1)).status).toBe(200);
  });

  it('403 PERM_DEPARTMENT_MISMATCH: 別の部署(または部署なし)向けのチャレンジには参加できない。何も書かない', async () => {
    for (const actor of [MEMBER_A2, MEMBER_A3]) {
      setup({ actor });

      const res = await post(C_DEPT_1);

      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe('PERM_DEPARTMENT_MISMATCH');
      expect(inserts()).toHaveLength(0);
    }
  });

  it.each([
    ['UUID でない文字列', 'not-a-uuid'],
    ['存在しないチャレンジ', uuid(999)],
    ['他組織のチャレンジ', C_OTHER_ORG],
  ])('404: %s。存在を知らせない。何も書かない', async (_label, id) => {
    const res = await post(id);

    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('CHALLENGE_NOT_FOUND');
    expect(inserts()).toHaveLength(0);
  });

  it.each([
    ['歩数', C_STEPS],
    ['カスタム', C_CUSTOM],
  ])('409 CHALLENGE_TYPE_DISABLED: %s は、まだ参加できない種類。何も書かない', async (_label, id) => {
    const res = await post(id);

    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('CHALLENGE_TYPE_DISABLED');
    expect(inserts()).toHaveLength(0);
  });

  it.each([
    ['下書き', C_DRAFT],
    ['中止', C_CANCELLED],
    ['終了', C_COOKING_DONE],
  ])('409 CHALLENGE_NOT_ACTIVE: %s のチャレンジには参加できない。何も書かない', async (_label, id) => {
    const res = await post(id);

    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('CHALLENGE_NOT_ACTIVE');
    expect(inserts()).toHaveLength(0);
  });

  it('409 CHALLENGE_ENDED: 状態がまだ開催中でも、終了日 (JST) を過ぎていれば参加できない (毎日の集計で終了になるまでの間)', async () => {
    const res = await post(C_ENDED);

    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('CHALLENGE_ENDED');
    expect(inserts()).toHaveLength(0);
  });

  it('終了日の当日 (JST) は、まだ参加できる', async () => {
    // 終了日 = JST の今日。UTC の日付で比べると、JST の 0:00〜8:59 に取りこぼす
    const { todayJst } = await import('@/lib/org-challenges');
    sessionDb = createSchemaDb({
      tables: {
        ...worldTables(),
        organization_challenges: [challengeRow(C_BREAKFAST, { end_date: todayJst() })],
        organization_challenge_participants: [],
      },
    });
    sessionUser = { id: MEMBER_A3 };

    const res = await post(C_BREAKFAST);

    expect(res.status).toBe(200);
  });

  it('すでに参加している (一意制約 23505) ときは、何度押しても 200 (alreadyJoined)。エラーにしない', async () => {
    setup({ actor: MEMBER_A3, errors: { organization_challenge_participants: { code: '23505', message: 'duplicate key value' } } });

    const res = await post(C_BREAKFAST);

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ joined: true, alreadyJoined: true });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('RLS が拒否した (42501。確認のあとに所属が変わった場合など) ときは 403。記録しない', async () => {
    setup({ actor: MEMBER_A3, errors: { organization_challenge_participants: { code: '42501', message: 'new row violates row-level security policy' } } });

    const res = await post(C_BREAKFAST);

    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('FORBIDDEN');
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('500: 想定外の DB の失敗は汎用メッセージだけ。生のエラー文は返さず、記録にだけ残す', async () => {
    const RAW = 'deadlock detected; password=hunter2';
    setup({ actor: MEMBER_A3, errors: { organization_challenge_participants: { code: '40P01', message: RAW } } });

    const res = await post(C_BREAKFAST);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(text).not.toContain('hunter2');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('POST /api/org/challenges/[id]/join');
  });

  it('自分の組織のチャレンジだけを調べる (組織の絞り込みは認可で確定した値)', async () => {
    await post(C_BREAKFAST);

    const query = sessionDb.recorded('organization_challenges', 'select')[0];
    expect(query.eq).toContainEqual(['id', C_BREAKFAST]);
    expect(query.eq).toContainEqual(['organization_id', ORG_A]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DELETE /api/org/challenges/[id]/join
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/org/challenges/[id]/join (参加をやめる)', () => {
  const del = (id: string) => joinRoute.DELETE(jsonRequest(url(`/api/org/challenges/${id}/join`), 'DELETE'), idParams(id));
  const deletes = () => sessionDb.recorded('organization_challenge_participants', 'delete');

  it('本人の参加行だけを消す。条件は チャレンジ ID と 認可で確定した本人の ID', async () => {
    const res = await del(C_BREAKFAST);

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ joined: false });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].eq).toEqual([
      ['challenge_id', C_BREAKFAST],
      ['user_id', MEMBER_A1],
    ]);
    expect(sessionDb.rows('organization_challenge_participants').find((p) => p.challenge_id === C_BREAKFAST)).toBeUndefined();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('参加していなくても 200 (何度押しても同じ結果)', async () => {
    setup({ actor: MEMBER_A3 });

    const res = await del(C_BREAKFAST);

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ joined: false });
  });

  it('UUID でない id は DB に渡さず、参加していないのと同じ扱い (200)', async () => {
    const res = await del('not-a-uuid');

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ joined: false });
    expect(deletes()).toHaveLength(0);
  });

  it('チャレンジが終了していても、参加をやめられる (状態は調べない)', async () => {
    const res = await del(C_COOKING_DONE);

    expect(res.status).toBe(200);
    expect(deletes()[0].eq).toContainEqual(['challenge_id', C_COOKING_DONE]);
  });

  it('500: DB の失敗は汎用メッセージだけ。生のエラー文は返さず、記録にだけ残す', async () => {
    const RAW = 'connection refused; password=hunter2';
    setup({ errors: { organization_challenge_participants: { code: '08006', message: RAW } } });

    const res = await del(C_BREAKFAST);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(text).not.toContain('hunter2');
    expect(mockLoggerError.mock.calls[0][0]).toBe('DELETE /api/org/challenges/[id]/join');
  });
});
