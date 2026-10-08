/**
 * #1132 組織チャレンジの API (参加・順位表・管理者向けの集計) の権限と最小人数の回帰テスト
 *
 * 修正前は、参加する API も、進み具合・順位を見せる画面も無かった。さらに管理者向けの一覧は、参加者の行を
 * 利用者の権限で数えており、同じ組織の全員が全参加者の user_id・current_value・rank を読める状態だった。
 *
 * オーナー判断 (2026-10-08): 参加は任意。順位は参加者どうしにだけ見せ、管理者には集計だけ (人数と平均) を見せる。
 * 少人数だと誰が参加しているか・誰の値かが分かってしまうため、最小人数 (5) に満たない間は人数も平均も出さない。
 * 歩数・体重のチャレンジは、健康データの同意の仕組みができるまで作成も参加もできない。
 *
 * 確認すること (実際の DB と Next の API ルートを通す。RLS・#1238 の INSERT ポリシー・DB 関数を含む):
 *   A. 認可: 未ログイン 401。組織に所属していない人は 403。管理者向けの API は一般のメンバーには 403。
 *      管理者 (owner / admin) もメンバー向けの API を使える
 *   B. 参加 / やめる: 開催中のチャレンジにだけ参加できる (下書き・終了・中止・終了日を過ぎたもの・歩数は 409。他組織は 404。
 *      別の部署向けは 403)。二重の参加は 200。参加行は進捗 0・順位なしで作られる。やめると本人の行だけ消える
 *   C. 順位表: 参加者本人にだけ返る (参加していない人・管理者には返らない)。他人の ID・ニックネームは応答に現れない
 *   D. 管理者向けの集計: 参加者が 5 人に満たない間は人数も平均も null。5 人になると出る。個人の値・ID は出ない。
 *      管理者がメンバー向けの API を呼んでも、参加者数は同じ規則で隠される。RLS で管理者も他人の参加行を読めない
 *   E. 作成の制限: 歩数・体重・カスタムは作成も開始もできない (400)
 *
 * 実行 (ローカル Supabase + dev サーバー。tests/integration/security/org-departments-api.test.ts と同じ):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-challenges-api.test.ts
 * 先に DB の関数を使う migration (supabase/migrations/*_org_challenge_progress.sql) が当たっていること。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { todayJst } from '../../../src/lib/org-challenges';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

interface TestUser {
  id: string;
  jwt: string;
  nickname: string;
}

const RUN = randomBytes(4).toString('hex');
const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-chal-${label}-${RUN}-${TS}@homegohan.test`;
  const nickname = `chal-${label}-${RUN}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token, nickname };
}

/** 所属は特権列のため service_role で設定する */
async function setMembership(userId: string, orgId: string, orgRole: 'owner' | 'admin' | 'member', departmentId: string | null = null) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: true, department_id: departmentId })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY = todayJst();
const START = addDays(TODAY, -3);
const END = addDays(TODAY, 20);

interface ChallengeSeed {
  org?: string;
  type?: string;
  status?: string;
  start?: string;
  end?: string;
  departmentId?: string | null;
  title?: string;
}

async function createChallenge(seed: ChallengeSeed = {}): Promise<string> {
  const { data, error } = await srAdmin
    .from('organization_challenges')
    .insert({
      organization_id: seed.org ?? orgA,
      title: seed.title ?? `sec-chal ${seed.type ?? 'breakfast_rate'} ${RUN}`,
      challenge_type: seed.type ?? 'breakfast_rate',
      start_date: seed.start ?? START,
      end_date: seed.end ?? END,
      status: seed.status ?? 'active',
      department_id: seed.departmentId ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organization_challenges: ${error?.message}`);
  return data.id as string;
}

/** 参加行を service_role で作る (集計済みの値を入れられる) */
async function seedParticipant(challengeId: string, user: TestUser, value?: number, rank?: number) {
  const row: Record<string, unknown> = { challenge_id: challengeId, user_id: user.id };
  if (value !== undefined) row.current_value = value;
  if (rank !== undefined) row.rank = rank;
  const { error } = await srAdmin.from('organization_challenge_participants').insert(row);
  if (error) throw new Error(`participant: ${error.message}`);
}

async function participantRow(challengeId: string, userId: string) {
  const { data, error } = await srAdmin
    .from('organization_challenge_participants')
    .select('current_value, rank')
    .eq('challenge_id', challengeId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`participantRow: ${error.message}`);
  return data as { current_value: number | string | null; rank: number | null } | null;
}

async function participantCount(challengeId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('organization_challenge_participants')
    .select('id', { count: 'exact', head: true })
    .eq('challenge_id', challengeId);
  if (error) throw new Error(`participantCount: ${error.message}`);
  return count ?? 0;
}

let orgA = '';
let orgB = '';
let deptX = ''; // 組織 A の部署
let owner: TestUser; // 組織 A の owner
let admin: TestUser; // 組織 A の admin
let m1: TestUser; // 組織 A の一般メンバー (部署 X)
let m2: TestUser;
let m3: TestUser;
let m4: TestUser;
let m5: TestUser;
let m6: TestUser; // 組織 A の一般メンバー。部署なし
let loner: TestUser; // どの組織にも所属しない
let b1: TestUser; // 組織 B の一般メンバー
const createdChallengeIds: string[] = [];

async function newChallenge(seed: ChallengeSeed = {}): Promise<string> {
  const id = await createChallenge(seed);
  createdChallengeIds.push(id);
  return id;
}

beforeAll(async () => {
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([{ name: `#1132 api Org A ${RUN}` }, { name: `#1132 api Org B ${RUN}` }])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('#1132 api Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('#1132 api Org B'))!.id;

  const { data: dept, error: deptError } = await srAdmin
    .from('departments')
    .insert({ organization_id: orgA, name: `chal dept ${RUN}` })
    .select('id')
    .single();
  if (deptError || !dept) throw new Error(`departments: ${deptError?.message}`);
  deptX = dept.id as string;

  [owner, admin, m1, m2, m3, m4, m5, m6, loner, b1] = await Promise.all([
    createUser('owner'),
    createUser('admin'),
    createUser('m1'),
    createUser('m2'),
    createUser('m3'),
    createUser('m4'),
    createUser('m5'),
    createUser('m6'),
    createUser('loner'),
    createUser('b1'),
  ]);
  await setMembership(owner.id, orgA, 'owner');
  await setMembership(admin.id, orgA, 'admin');
  await setMembership(m1.id, orgA, 'member', deptX);
  for (const u of [m2, m3, m4, m5, m6]) await setMembership(u.id, orgA, 'member');
  await setMembership(b1.id, orgB, 'member');
}, 120_000);

afterAll(async () => {
  if (createdChallengeIds.length > 0) {
    // 参加行は CASCADE で消える
    await srAdmin.from('organization_challenges').delete().in('id', createdChallengeIds);
  }
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await srAdmin.from('organization_challenges').delete().eq('organization_id', orgId);
  }
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, department_id: null })
      .in('id', createdUserIds);
  }
  if (deptX) await srAdmin.from('departments').delete().eq('id', deptX);
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await srAdmin.from('organizations').delete().eq('id', orgId);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

// ================================================================
// A. 認可
// ================================================================
describe('#1132 A. 認可', () => {
  it('A-1: 未ログインはメンバー向けの API も管理者向けの API も 401', async () => {
    const challenge = await newChallenge();
    const calls = [
      apiCall('GET', '/api/org/my-challenges', null),
      apiCall('GET', `/api/org/challenges/${challenge}`, null),
      apiCall('POST', `/api/org/challenges/${challenge}/join`, null),
      apiCall('DELETE', `/api/org/challenges/${challenge}/join`, null),
      apiCall('GET', '/api/org/challenges', null),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
    expect(await participantCount(challenge)).toBe(0);
  });

  it('A-2: 組織に所属していない人は、メンバー向けの API が 403 (参加行も作られない)', async () => {
    const challenge = await newChallenge();

    expect((await apiCall('GET', '/api/org/my-challenges', loner.jwt)).status).toBe(403);
    expect((await apiCall('GET', `/api/org/challenges/${challenge}`, loner.jwt)).status).toBe(403);
    expect((await apiCall('POST', `/api/org/challenges/${challenge}/join`, loner.jwt)).status).toBe(403);
    expect((await apiCall('DELETE', `/api/org/challenges/${challenge}/join`, loner.jwt)).status).toBe(403);
    expect(await participantCount(challenge)).toBe(0);
  });

  it('A-3: 一般のメンバーは管理者向けの API (一覧・作成・更新) が 403', async () => {
    const challenge = await newChallenge({ status: 'draft' });

    expect((await apiCall('GET', '/api/org/challenges', m1.jwt)).status).toBe(403);
    const create = await apiCall('POST', '/api/org/challenges', m1.jwt, {
      title: 'member tries',
      challengeType: 'breakfast_rate',
      startDate: START,
      endDate: END,
    });
    expect(create.status).toBe(403);
    expect((await apiCall('PUT', '/api/org/challenges', m1.jwt, { id: challenge, status: 'active' })).status).toBe(403);
    const { data } = await srAdmin.from('organization_challenges').select('status').eq('id', challenge).single();
    expect(data?.status).toBe('draft');
  });

  it('A-4: 管理者 (owner / admin) も、メンバー向けの API を使える', async () => {
    const challenge = await newChallenge();
    for (const user of [owner, admin]) {
      const list = await apiCall<{ challenges: Array<{ id: string }> }>('GET', '/api/org/my-challenges', user.jwt);
      expect(list.status).toBe(200);
      expect(list.body.challenges.map((c) => c.id)).toContain(challenge);
      expect((await apiCall('GET', `/api/org/challenges/${challenge}`, user.jwt)).status).toBe(200);
    }
  });
});

// ================================================================
// B. 参加 / やめる
// ================================================================
describe('#1132 B. 参加とやめる', () => {
  it('B-1: 開催中のチャレンジに参加できる。参加行は進捗 0・順位なしで作られる。もう一度押しても 200', async () => {
    const challenge = await newChallenge();

    const first = await apiCall('POST', `/api/org/challenges/${challenge}/join`, m2.jwt);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ joined: true, alreadyJoined: false });
    const row = await participantRow(challenge, m2.id);
    expect(row).not.toBeNull();
    expect(Number(row!.current_value)).toBe(0);
    expect(row!.rank).toBeNull();

    const second = await apiCall('POST', `/api/org/challenges/${challenge}/join`, m2.jwt);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ joined: true, alreadyJoined: true });
    expect(await participantCount(challenge)).toBe(1);
  });

  it('B-2: 参加できる種類は 3 つだけ。歩数・体重・カスタムは 409 CHALLENGE_TYPE_DISABLED', async () => {
    for (const type of ['steps', 'weight_loss', 'custom']) {
      const challenge = await newChallenge({ type });

      const res = await apiCall<{ error: { code: string } }>('POST', `/api/org/challenges/${challenge}/join`, m2.jwt);

      expect(res.status, type).toBe(409);
      expect(res.body.error.code).toBe('CHALLENGE_TYPE_DISABLED');
      expect(await participantCount(challenge)).toBe(0);
    }
    for (const type of ['veg_score', 'cooking_rate']) {
      const challenge = await newChallenge({ type });
      expect((await apiCall('POST', `/api/org/challenges/${challenge}/join`, m2.jwt)).status, type).toBe(200);
    }
  });

  it('B-3: 下書き・終了・中止のチャレンジには参加できない (409 CHALLENGE_NOT_ACTIVE)。終了日を過ぎたものも 409 CHALLENGE_ENDED', async () => {
    for (const status of ['draft', 'completed', 'cancelled']) {
      const challenge = await newChallenge({ status });
      const res = await apiCall<{ error: { code: string } }>('POST', `/api/org/challenges/${challenge}/join`, m2.jwt);
      expect(res.status, status).toBe(409);
      expect(res.body.error.code).toBe('CHALLENGE_NOT_ACTIVE');
      expect(await participantCount(challenge)).toBe(0);
    }

    // 状態はまだ開催中だが、終了日 (JST) が昨日 (毎日の集計で終了になるまでの間)
    const ended = await newChallenge({ start: addDays(TODAY, -10), end: addDays(TODAY, -1) });
    const endedRes = await apiCall<{ error: { code: string } }>('POST', `/api/org/challenges/${ended}/join`, m2.jwt);
    expect(endedRes.status).toBe(409);
    expect(endedRes.body.error.code).toBe('CHALLENGE_ENDED');
    expect(await participantCount(ended)).toBe(0);

    // 終了日の当日 (JST) は、まだ参加できる
    const lastDay = await newChallenge({ start: addDays(TODAY, -10), end: TODAY });
    expect((await apiCall('POST', `/api/org/challenges/${lastDay}/join`, m2.jwt)).status).toBe(200);
  });

  it('B-4: 他組織のチャレンジ・存在しないチャレンジ・UUID でない id は 404 (存在を知らせない)', async () => {
    const other = await newChallenge({ org: orgB });

    for (const id of [other, '00000000-0000-4000-8000-00000000dead', 'not-a-uuid']) {
      const res = await apiCall<{ error: { code: string } }>('POST', `/api/org/challenges/${id}/join`, m2.jwt);
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe('CHALLENGE_NOT_FOUND');
    }
    expect(await participantCount(other)).toBe(0);
    // 他組織のチャレンジの詳細も 404
    expect((await apiCall('GET', `/api/org/challenges/${other}`, m2.jwt)).status).toBe(404);
  });

  it('B-5: 部署を限定したチャレンジは、その部署のメンバーだけ参加できる (別の部署・部署なしは 403 PERM_DEPARTMENT_MISMATCH)', async () => {
    const challenge = await newChallenge({ departmentId: deptX });

    const outsider = await apiCall<{ error: { code: string } }>('POST', `/api/org/challenges/${challenge}/join`, m2.jwt);
    expect(outsider.status).toBe(403);
    expect(outsider.body.error.code).toBe('PERM_DEPARTMENT_MISMATCH');
    expect(await participantCount(challenge)).toBe(0);
    // 部署が違う人には、詳細も一覧も見せない
    expect((await apiCall('GET', `/api/org/challenges/${challenge}`, m2.jwt)).status).toBe(404);
    const list = await apiCall<{ challenges: Array<{ id: string }> }>('GET', '/api/org/my-challenges', m2.jwt);
    expect(list.body.challenges.map((c) => c.id)).not.toContain(challenge);

    expect((await apiCall('POST', `/api/org/challenges/${challenge}/join`, m1.jwt)).status).toBe(200);
    expect((await apiCall('GET', `/api/org/challenges/${challenge}`, m1.jwt)).status).toBe(200);
  });

  it('B-6: 参加をやめると本人の行だけが消える。何度やめても 200。終了したチャレンジでもやめられる', async () => {
    const challenge = await newChallenge();
    await seedParticipant(challenge, m3, 40, 2);
    await seedParticipant(challenge, m4, 60, 1);

    const left = await apiCall('DELETE', `/api/org/challenges/${challenge}/join`, m3.jwt);
    expect(left.status).toBe(200);
    expect(left.body).toEqual({ joined: false });
    expect(await participantRow(challenge, m3.id)).toBeNull();
    expect(await participantRow(challenge, m4.id)).not.toBeNull(); // 他人の行は残る

    expect((await apiCall('DELETE', `/api/org/challenges/${challenge}/join`, m3.jwt)).status).toBe(200);
    expect((await apiCall('DELETE', '/api/org/challenges/not-a-uuid/join', m3.jwt)).status).toBe(200);

    // 終了したチャレンジでも
    const done = await newChallenge({ status: 'completed' });
    await seedParticipant(done, m3, 10, 1);
    expect((await apiCall('DELETE', `/api/org/challenges/${done}/join`, m3.jwt)).status).toBe(200);
    expect(await participantRow(done, m3.id)).toBeNull();
  });

  it('B-7: 他人の行は、やめる API でも消せない (条件は認可で確定した本人の ID)', async () => {
    const challenge = await newChallenge();
    await seedParticipant(challenge, m4, 60, 1);

    // m5 は参加していない。m5 が DELETE しても、m4 の行は残る
    expect((await apiCall('DELETE', `/api/org/challenges/${challenge}/join`, m5.jwt)).status).toBe(200);
    expect(await participantRow(challenge, m4.id)).not.toBeNull();
  });
});

// ================================================================
// C. 順位表
// ================================================================
describe('#1132 C. 順位表は参加者本人にだけ', () => {
  async function seedRanking(): Promise<string> {
    const challenge = await newChallenge();
    await seedParticipant(challenge, m2, 80, 1);
    await seedParticipant(challenge, m1, 50, 2);
    await seedParticipant(challenge, m3, 20, 3);
    return challenge;
  }

  interface DetailBody {
    challenge: { id: string; status: string };
    participantCount: number | null;
    minParticipants: number;
    joined: boolean;
    me: { currentValue: number; rank: number | null } | null;
    ranking: {
      available: boolean;
      showNames: boolean;
      rankedCount?: number;
      entries?: Array<{ rank: number; value: number; isMe: boolean; label: string }>;
    };
  }

  it('C-1: 参加者には、自分の記録と順位表が返る。本人は「あなた」、ほかの人は「参加者」。他人の ID・ニックネームは応答に現れない', async () => {
    const challenge = await seedRanking();

    const res = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, m1.jwt);

    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(true);
    expect(res.body.me).toMatchObject({ currentValue: 50, rank: 2 });
    expect(res.body.ranking.available).toBe(true);
    expect(res.body.ranking.rankedCount).toBe(3);
    expect(res.body.ranking.entries).toEqual([
      { rank: 1, value: 80, isMe: false, label: '参加者' },
      { rank: 2, value: 50, isMe: true, label: 'あなた' },
      { rank: 3, value: 20, isMe: false, label: '参加者' },
    ]);
    // 表示名を出す設定 (ORG_CHALLENGE_SHOW_NAMES) は、このテストを動かすサーバーでは未設定が前提
    expect(res.body.ranking.showNames).toBe(false);
    const text = JSON.stringify(res.body);
    for (const other of [m2, m3, owner, admin, b1]) {
      expect(text).not.toContain(other.id);
      expect(text).not.toContain(other.nickname);
    }
    expect(text).not.toContain(m1.nickname);
  });

  it('C-2: 参加していない人には、順位表を返さない (同じ組織のメンバーにも、管理者にも)', async () => {
    const challenge = await seedRanking();

    for (const user of [m5, owner, admin]) {
      const res = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, user.jwt);
      expect(res.status).toBe(200);
      expect(res.body.joined).toBe(false);
      expect(res.body.me).toBeNull();
      expect(res.body.ranking).toEqual({ available: false, showNames: false });
      const text = JSON.stringify(res.body);
      for (const participant of [m1, m2, m3]) expect(text).not.toContain(participant.id);
      expect(text).not.toContain('"entries"');
    }
  });

  it('C-3: 参加した管理者は、一般のメンバーと同じく順位表を見られる。やめると見られなくなる', async () => {
    const challenge = await seedRanking();
    expect((await apiCall('POST', `/api/org/challenges/${challenge}/join`, admin.jwt)).status).toBe(200);

    const joined = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, admin.jwt);
    expect(joined.body.joined).toBe(true);
    expect(joined.body.ranking.available).toBe(true);
    // 参加したばかりで、まだ集計されていない: 順位は無いが、順位表は見られる
    expect(joined.body.me).toMatchObject({ currentValue: 0, rank: null });
    expect(joined.body.ranking.entries).toHaveLength(3);
    expect(joined.body.ranking.entries!.some((e) => e.isMe)).toBe(false);

    expect((await apiCall('DELETE', `/api/org/challenges/${challenge}/join`, admin.jwt)).status).toBe(200);
    const left = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, admin.jwt);
    expect(left.body.ranking).toEqual({ available: false, showNames: false });
  });

  it('C-4: 一覧 (my-challenges) は、自分の参加状況だけ。他の参加者の値・順位・ID は含まない', async () => {
    const challenge = await seedRanking();

    const res = await apiCall<{ challenges: Array<{ id: string; joined: boolean; me: { rank: number | null } | null }> }>(
      'GET',
      '/api/org/my-challenges',
      m1.jwt,
    );

    expect(res.status).toBe(200);
    const mine = res.body.challenges.find((c) => c.id === challenge)!;
    expect(mine.joined).toBe(true);
    expect(mine.me).toMatchObject({ rank: 2, currentValue: 50 });
    const text = JSON.stringify(res.body);
    for (const other of [m2, m3]) expect(text).not.toContain(other.id);
    expect(text).not.toContain('"currentValue":80');
  });
});

// ================================================================
// D. 管理者向けの集計 (最小人数)
// ================================================================
describe('#1132 D. 管理者向けの集計は、5 人に満たない間は人数も平均も出さない', () => {
  interface AdminChallenge {
    id: string;
    challengeType: string;
    participantCount: number | null;
    aggregate: { minParticipants: number; visible: boolean; averageValue: number | null };
  }

  async function adminView(jwt: string, challengeId: string): Promise<{ raw: string; challenge: AdminChallenge }> {
    const res = await apiCall<{ challenges: AdminChallenge[] }>('GET', '/api/org/challenges', jwt);
    expect(res.status).toBe(200);
    return { raw: JSON.stringify(res.body), challenge: res.body.challenges.find((c) => c.id === challengeId)! };
  }

  it('D-1: 参加者が 4 人のとき、人数も平均も null。個人の ID・値・順位は応答に現れない', async () => {
    const challenge = await newChallenge();
    await seedParticipant(challenge, m1, 90, 1);
    await seedParticipant(challenge, m2, 70, 2);
    await seedParticipant(challenge, m3, 50, 3);
    await seedParticipant(challenge, m4, 10, 4);

    const { raw, challenge: view } = await adminView(owner.jwt, challenge);

    expect(view.participantCount).toBeNull();
    expect(view.aggregate).toEqual({ minParticipants: 5, visible: false, averageValue: null });
    for (const user of [m1, m2, m3, m4]) {
      expect(raw).not.toContain(user.id);
      expect(raw).not.toContain(user.nickname);
    }
  });

  it('D-2: 参加者が 5 人になると、人数と平均 (集計済みの人の平均) が出る。個人の値は出ない', async () => {
    const challenge = await newChallenge();
    const values: Array<[TestUser, number]> = [
      [m1, 90],
      [m2, 70],
      [m3, 50],
      [m4, 10],
      [m5, 30],
    ];
    let rank = 1;
    for (const [user, value] of values) await seedParticipant(challenge, user, value, rank++);

    const { raw, challenge: view } = await adminView(admin.jwt, challenge);

    expect(view.participantCount).toBe(5);
    expect(view.aggregate.visible).toBe(true);
    expect(view.aggregate.averageValue).toBe(50); // (90 + 70 + 50 + 10 + 30) / 5
    for (const user of [m1, m2, m3, m4, m5]) expect(raw).not.toContain(user.id);
    expect(raw).not.toContain('"rank"');
  });

  it('D-3: 参加者は 5 人いるが、集計が済んだ人が 4 人のとき、人数は出て、平均は null', async () => {
    const challenge = await newChallenge();
    for (const [i, user] of [m1, m2, m3, m4].entries()) await seedParticipant(challenge, user, 50, i + 1);
    await seedParticipant(challenge, m5); // 参加したばかり (rank なし)

    const { challenge: view } = await adminView(owner.jwt, challenge);

    expect(view.participantCount).toBe(5);
    expect(view.aggregate).toEqual({ minParticipants: 5, visible: false, averageValue: null });
  });

  it('D-4: 管理者がメンバー向けの API を呼んでも、参加者数は同じ規則で隠される (制限を迂回できない)', async () => {
    const challenge = await newChallenge();
    await seedParticipant(challenge, m1, 90, 1);
    await seedParticipant(challenge, m2, 70, 2);

    const list = await apiCall<{ challenges: Array<{ id: string; participantCount: number | null }>; minParticipants: number }>(
      'GET',
      '/api/org/my-challenges',
      owner.jwt,
    );
    const detail = await apiCall<{ participantCount: number | null; minParticipants: number }>(
      'GET',
      `/api/org/challenges/${challenge}`,
      owner.jwt,
    );

    expect(list.body.challenges.find((c) => c.id === challenge)!.participantCount).toBeNull();
    expect(list.body.minParticipants).toBe(5);
    expect(detail.body.participantCount).toBeNull();
    expect(detail.body.minParticipants).toBe(5);
  });

  it('D-5: 他組織の管理者には、この組織のチャレンジの集計は見えない', async () => {
    const challenge = await newChallenge();
    await setMembership(b1.id, orgB, 'admin');
    try {
      const res = await apiCall<{ challenges: AdminChallenge[] }>('GET', '/api/org/challenges', b1.jwt);
      expect(res.status).toBe(200);
      expect(res.body.challenges.map((c) => c.id)).not.toContain(challenge);
    } finally {
      await setMembership(b1.id, orgB, 'member');
    }
  });

  it('D-6: 管理者も、参加者の行は RLS で読めない (自分の参加行だけ)。PostgREST を直接叩いても同じ', async () => {
    const challenge = await newChallenge();
    await seedParticipant(challenge, m1, 90, 1);
    await seedParticipant(challenge, m2, 70, 2);
    await seedParticipant(challenge, owner, 40, 3);

    for (const user of [admin, m3]) {
      const { data, error } = await asUser(user.jwt)
        .from('organization_challenge_participants')
        .select('user_id, current_value, rank')
        .eq('challenge_id', challenge);
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    }
    const ownerRows = await asUser(owner.jwt)
      .from('organization_challenge_participants')
      .select('user_id')
      .eq('challenge_id', challenge);
    expect((ownerRows.data ?? []).map((r) => r.user_id)).toEqual([owner.id]);
  });

  it('D-7: 集計の DB 関数も順位表の DB 関数も、利用者の JWT では呼べない (service_role だけ)', async () => {
    const challenge = await newChallenge();
    for (const user of [owner, m1]) {
      const aggregates = await asUser(user.jwt).rpc('get_org_challenge_aggregates', { p_organization_id: orgA });
      expect(aggregates.error?.code, 'get_org_challenge_aggregates').toBe('42501');
      const ranking = await asUser(user.jwt).rpc('get_org_challenge_ranking', { p_challenge_id: challenge, p_user_id: user.id });
      expect(ranking.error?.code, 'get_org_challenge_ranking').toBe('42501');
    }
  });
});

// ================================================================
// E. 作成の制限
// ================================================================
describe('#1132 E. 歩数・体重・カスタムは作成も開始もできない', () => {
  it('E-1: 使える 3 種類は作成できる (下書きで作られる)。歩数・体重・カスタムは 400 CHALLENGE_TYPE_DISABLED', async () => {
    for (const challengeType of ['breakfast_rate', 'veg_score', 'cooking_rate']) {
      const res = await apiCall<{ success: boolean; challenge: { id: string; status: string } }>('POST', '/api/org/challenges', owner.jwt, {
        title: `sec-chal create ${challengeType} ${RUN}`,
        challengeType,
        targetValue: 50,
        startDate: START,
        endDate: END,
      });
      expect(res.status, challengeType).toBe(200);
      expect(res.body.challenge.status).toBe('draft');
      createdChallengeIds.push(res.body.challenge.id);
    }

    for (const challengeType of ['steps', 'weight_loss', 'custom']) {
      const res = await apiCall<{ code: string }>('POST', '/api/org/challenges', owner.jwt, {
        title: `sec-chal disabled ${challengeType} ${RUN}`,
        challengeType,
        startDate: START,
        endDate: END,
      });
      expect(res.status, challengeType).toBe(400);
      expect(res.body.code).toBe('CHALLENGE_TYPE_DISABLED');
    }
    const { data } = await srAdmin
      .from('organization_challenges')
      .select('id')
      .eq('organization_id', orgA)
      .like('title', `sec-chal disabled %${RUN}`);
    expect(data ?? []).toHaveLength(0);
  });

  it('E-2: 下書きの歩数チャレンジ (以前に作られたもの) は開始できない (400)。終了や中止にはできる', async () => {
    const steps = await newChallenge({ type: 'steps', status: 'draft' });
    const start = await apiCall<{ code: string }>('PUT', '/api/org/challenges', owner.jwt, { id: steps, status: 'active' });
    expect(start.status).toBe(400);
    expect(start.body.code).toBe('CHALLENGE_TYPE_DISABLED');
    const { data } = await srAdmin.from('organization_challenges').select('status').eq('id', steps).single();
    expect(data?.status).toBe('draft');

    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: steps, status: 'cancelled' })).status).toBe(200);
  });

  it('E-3: 食事の記録から計算できるチャレンジは、開始 (active) にできる。DB が受け付けない状態は 400', async () => {
    const draft = await newChallenge({ status: 'draft' });

    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: draft, status: 'finished' })).status).toBe(400);
    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: draft, status: 'active' })).status).toBe(200);
    const { data } = await srAdmin.from('organization_challenges').select('status').eq('id', draft).single();
    expect(data?.status).toBe('active');
  });

  it('E-4: 他組織のチャレンジは、管理者でも更新できない', async () => {
    const other = await newChallenge({ org: orgB, status: 'draft' });

    await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: other, status: 'active', title: 'tampered' });

    const { data } = await srAdmin.from('organization_challenges').select('status, title').eq('id', other).single();
    expect(data?.status).toBe('draft');
    expect(data?.title).not.toBe('tampered');
  });
});
