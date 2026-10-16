/**
 * #1132 組織チャレンジの API (参加・順位表・管理者向けの集計) の権限と最小人数の回帰テスト
 *
 * 修正前は、参加する API も、進み具合・順位を見せる画面も無かった。さらに管理者向けの一覧は、参加者の行を
 * 利用者の権限で数えており、同じ組織の全員が全参加者の user_id・current_value・rank を読める状態だった。
 *
 * #1132 の方針: 参加は任意。順位は参加者どうしにだけ見せ、管理者には集計だけ (人数と平均) を見せる。
 * 少人数だと誰が参加しているか・誰の値かが分かってしまうため、最小人数 (10。#1600 で 5 → 10 人) に満たない間は人数も平均も出さない。
 * 歩数・体重のチャレンジは、健康データの同意の仕組みができるまで作成も参加もできない。
 *
 * 確認すること (実際の DB と Next の API ルートを通す。RLS・#1238 の INSERT ポリシー・DB 関数を含む):
 *   A. 認可: 未ログイン 401。組織に所属していない人は 403。管理者向けの API は一般のメンバーには 403。
 *      管理者 (owner / admin) もメンバー向けの API を使える
 *   B. 参加 / やめる: 開催中のチャレンジにだけ参加できる (下書き・終了・中止・終了日を過ぎたもの・歩数は 409。他組織は 404。
 *      別の部署向けは 403)。二重の参加は 200。参加行は進捗 0・順位なしで作られる。やめると本人の行だけ消える
 *   C. 順位表: 参加者本人にだけ返る (参加していない人には reason: not_joined)。#1688: 参加した管理者 (owner / admin) と、
 *      管理者だった印のある人 (招待の承諾で管理者になって member に戻った人) にも返さない (reason: org_admin)。
 *      やめた人の行は、ほかの参加者の順位表からその場で消える。他人の ID・ニックネームは応答に現れない
 *   D. 管理者向けの集計 (#1688): 人数は参加した人の延べ数 (10 人未満は null)。平均は終了時に 1 回だけ確定した値で、開催中は null。
 *      確定後に参加をやめても・メンバーを外しても変わらない。同じ種類で期間が重なるチャレンジは、先に終了した 1 本だけに平均が出る。
 *      終了したチャレンジは開催中に戻せない (409)。個人の値・ID は出ない。
 *      管理者がメンバー向けの API を呼んでも、参加者数は同じ値。RLS で管理者も他人の参加行を読めない
 *   E. 作成の制限: 歩数・体重・カスタムは作成も開始もできない (400)。開催中 → 下書きは 409。終了後もタイトル・説明・報酬は更新できる
 *
 * 後片付け: チャレンジは it ごとに消す (afterEach)。#1688 の「同じ種類で期間が重なり先に確定したチャレンジがあれば平均を出さない」が
 * it をまたいで効かないようにするため (このファイルのチャレンジは既定で組織 A・朝食・同じ期間)。
 *
 * 実行 (ローカル Supabase + dev サーバー。tests/integration/security/org-departments-api.test.ts と同じ):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-challenges-api.test.ts
 * 先に DB の関数を使う migration (supabase/migrations/*_org_challenge_progress.sql) が当たっていること。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { createPlaceholderOrgOwner, deletePlaceholderOrgOwner } from '../helpers/org-owner';
import { jstDaysAgo } from '../helpers/jst-days';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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
  /** 招待の宛先 (C-6 で、同じ組織の招待を本人が承諾する) */
  email: string;
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
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token, nickname, email };
}

/** 所属は特権列のため service_role で設定する */
async function setMembership(userId: string, orgId: string, orgRole: 'owner' | 'admin' | 'member', departmentId: string | null = null) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: true, department_id: departmentId })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

// 日付はサーバー (参加の API ルートの todayJst) と同じ JST の暦日で作る (#1545 の jstDaysAgo)。
// UTC の暦日 (toISOString の日付部分) で作ると、JST の 0:00〜8:59 にサーバーの「昨日」を「今日」として入れてしまう。
// jstDaysAgo(n) はサーバーの JST の今日から n 日前 (負の値は n 日後)
const TODAY = jstDaysAgo(0);
const START = jstDaysAgo(3);
const END = jstDaysAgo(-20);

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
/** 組織の持ち主 (owner_id は NOT NULL。#1103 項目 10)。どの組織のメンバーでもない作り物。テストの利用者を owner_id に入れない
 * (検査の前提を変えない)。afterAll で組織の後に消す (owner_id → auth.users は ON DELETE RESTRICT) */
let orgOwnerId = '';
let deptX = ''; // 組織 A の部署
let owner: TestUser; // 組織 A の owner
let admin: TestUser; // 組織 A の admin
let m1: TestUser; // 組織 A の一般メンバー (部署 X)
let m2: TestUser;
let m3: TestUser;
let m4: TestUser;
let m5: TestUser;
let m6: TestUser; // 組織 A の一般メンバー。部署なし
// m7〜m10: 組織 A の一般メンバー (部署なし)。管理者向けの集計の最小人数 (10 人。#1600) の人数をそろえる (D でだけ参加する)
let m7: TestUser;
let m8: TestUser;
let m9: TestUser;
let m10: TestUser;
let loner: TestUser; // どの組織にも所属しない
let b1: TestUser; // 組織 B の一般メンバー
const createdChallengeIds: string[] = [];

async function newChallenge(seed: ChallengeSeed = {}): Promise<string> {
  const id = await createChallenge(seed);
  createdChallengeIds.push(id);
  return id;
}

beforeAll(async () => {
  orgOwnerId = await createPlaceholderOrgOwner(srAdmin, '1132-api');
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([
      { name: `#1132 api Org A ${RUN}`, owner_id: orgOwnerId },
      { name: `#1132 api Org B ${RUN}`, owner_id: orgOwnerId },
    ])
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

  [owner, admin, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, loner, b1] = await Promise.all([
    createUser('owner'),
    createUser('admin'),
    createUser('m1'),
    createUser('m2'),
    createUser('m3'),
    createUser('m4'),
    createUser('m5'),
    createUser('m6'),
    createUser('m7'),
    createUser('m8'),
    createUser('m9'),
    createUser('m10'),
    createUser('loner'),
    createUser('b1'),
  ]);
  await setMembership(owner.id, orgA, 'owner');
  await setMembership(admin.id, orgA, 'admin');
  await setMembership(m1.id, orgA, 'member', deptX);
  for (const u of [m2, m3, m4, m5, m6, m7, m8, m9, m10]) await setMembership(u.id, orgA, 'member');
  await setMembership(b1.id, orgB, 'member');
}, 120_000);

afterEach(async () => {
  // その it で作ったチャレンジを消す (参加行・集計の控え・印は CASCADE で消える。service_role の DELETE は
  // RESTRICTIVE の削除のポリシー (authenticated だけに掛かる) を通らない)
  if (createdChallengeIds.length > 0) {
    await srAdmin.from('organization_challenges').delete().in('id', createdChallengeIds);
    createdChallengeIds.length = 0;
  }
}, 60_000);

afterAll(async () => {
  if (createdChallengeIds.length > 0) {
    // 参加行は CASCADE で消える
    await srAdmin.from('organization_challenges').delete().in('id', createdChallengeIds);
  }
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await srAdmin.from('organization_challenges').delete().eq('organization_id', orgId);
    // C-6 の招待 (組織を消す前に消す)
    await srAdmin.from('organization_invites').delete().eq('organization_id', orgId);
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
  // 持ち主は組織を消した後に消す (owner_id → auth.users は ON DELETE RESTRICT)
  if (orgOwnerId) await deletePlaceholderOrgOwner(srAdmin, orgOwnerId);
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
    const ended = await newChallenge({ start: jstDaysAgo(10), end: jstDaysAgo(1) });
    const endedRes = await apiCall<{ error: { code: string } }>('POST', `/api/org/challenges/${ended}/join`, m2.jwt);
    expect(endedRes.status).toBe(409);
    expect(endedRes.body.error.code).toBe('CHALLENGE_ENDED');
    expect(await participantCount(ended)).toBe(0);

    // 終了日の当日 (JST) は、まだ参加できる
    const lastDay = await newChallenge({ start: jstDaysAgo(10), end: TODAY });
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
      reason?: string;
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
      expect(res.body.ranking).toEqual({ available: false, showNames: false, reason: 'not_joined' });
      const text = JSON.stringify(res.body);
      for (const participant of [m1, m2, m3]) expect(text).not.toContain(participant.id);
      expect(text).not.toContain('"entries"');
    }
  });

  it('C-3: 参加した管理者 (owner / admin) には順位表を返さない。自分の記録と順位は返る。やめると not_joined', async () => {
    const challenge = await seedRanking();

    for (const user of [admin, owner]) {
      expect((await apiCall('POST', `/api/org/challenges/${challenge}/join`, user.jwt)).status).toBe(200);

      const joined = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, user.jwt);
      expect(joined.status).toBe(200);
      expect(joined.body.joined).toBe(true);
      // 参加したばかりで、まだ集計されていない
      expect(joined.body.me).toMatchObject({ currentValue: 0, rank: null });
      expect(joined.body.ranking).toEqual({ available: false, showNames: false, reason: 'org_admin' });
      expect(JSON.stringify(joined.body)).not.toContain('"entries"');

      expect((await apiCall('DELETE', `/api/org/challenges/${challenge}/join`, user.jwt)).status).toBe(200);
      const left = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, user.jwt);
      expect(left.body.ranking).toEqual({ available: false, showNames: false, reason: 'not_joined' });
    }
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

  it('C-5: 順位がついた参加者の 1 人がやめると、ほかの参加者の順位表から、夜の集計を待たずにその行が消える。管理者の集計は前後で同じ', async () => {
    const challenge = await newChallenge();
    const ten = [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10];
    // 値は 10〜100。順位は値の大きい順
    for (const [i, user] of ten.entries()) await seedParticipant(challenge, user, (i + 1) * 10, ten.length - i);

    const adminBefore = await apiCall<{ challenges: Array<{ id: string; participantCount: number | null; aggregate: unknown }> }>(
      'GET',
      '/api/org/challenges',
      owner.jwt,
    );
    const before = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, m1.jwt);
    expect(before.body.ranking.rankedCount).toBe(10);

    expect((await apiCall('DELETE', `/api/org/challenges/${challenge}/join`, m10.jwt)).status).toBe(200);

    const after = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, m1.jwt);
    expect(after.body.ranking.rankedCount).toBe(9);
    const adminAfter = await apiCall<{ challenges: Array<{ id: string; participantCount: number | null; aggregate: unknown }> }>(
      'GET',
      '/api/org/challenges',
      owner.jwt,
    );
    for (const view of [adminBefore, adminAfter]) {
      const row = view.body.challenges.find((c) => c.id === challenge)!;
      expect(row.participantCount).toBe(10);
      expect(row.aggregate).toEqual({ minParticipants: 10, visible: false, averageValue: null }); // 開催中
    }
  });

  it('C-6: 参加中の member が admin の招待を承諾したあと member の招待で戻ると、順位表は返らない (管理者だった印)', async () => {
    const challenge = await seedRanking();
    // m6 は部署なし (accept_org_invite は所属と役割を書き換え、部署を変えない)
    expect((await apiCall('POST', `/api/org/challenges/${challenge}/join`, m6.jwt)).status).toBe(200);
    const before = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, m6.jwt);
    expect(before.body.ranking.available).toBe(true);
    expect(before.body.ranking.entries).toHaveLength(3);

    /** 組織 A の owner が招待を作り、m6 が本人の JWT で承諾する */
    async function acceptInvite(role: 'admin' | 'member') {
      const { data, error } = await asUser(owner.jwt).rpc('create_org_invite', {
        p_organization_id: orgA,
        p_email: m6.email,
        p_role: role,
      });
      if (error || !data) throw new Error(`create_org_invite ${role}: ${error?.message}`);
      const accepted = await asUser(m6.jwt).rpc('accept_org_invite', { p_token: (data as { token: string }).token });
      if (accepted.error) throw new Error(`accept_org_invite ${role}: ${accepted.error.message}`);
    }

    try {
      await acceptInvite('admin');
      await acceptInvite('member');
      const { data: profile } = await srAdmin.from('user_profiles').select('org_role').eq('id', m6.id).single();
      expect(profile?.org_role).toBe('member');

      const after = await apiCall<DetailBody>('GET', `/api/org/challenges/${challenge}`, m6.jwt);
      expect(after.status).toBe(200);
      expect(after.body.joined).toBe(true);
      expect(after.body.me).not.toBeNull();
      expect(after.body.ranking).toEqual({ available: false, showNames: false, reason: 'org_admin' });
      expect(JSON.stringify(after.body)).not.toContain('"entries"');
    } finally {
      await setMembership(m6.id, orgA, 'member');
    }
  });
});

// ================================================================
// D. 管理者向けの集計 (最小人数)
// ================================================================
describe('#1132 / #1600 / #1688 D. 管理者向けの集計は、参加した人の延べ数と終了時に確定した平均だけ。10 人に満たない間は出さない', () => {
  /** 集計の最小人数 (#1600 で 5 → 10 人) */
  const MIN = 10;

  interface AdminChallenge {
    id: string;
    challengeType: string;
    participantCount: number | null;
    aggregate: { minParticipants: number; visible: boolean; averageValue: number | null };
  }

  /** 組織 A の一般メンバー 10 人 (m1 は部署 X。部署を限定しないチャレンジなので全員が参加者になれる) */
  const members = () => [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10];

  async function adminView(jwt: string, challengeId: string): Promise<{ raw: string; challenge: AdminChallenge }> {
    const res = await apiCall<{ challenges: AdminChallenge[] }>('GET', '/api/org/challenges', jwt);
    expect(res.status).toBe(200);
    return { raw: JSON.stringify(res.body), challenge: res.body.challenges.find((c) => c.id === challengeId)! };
  }

  it('D-1: 参加者が 9 人のとき、人数も平均も null。個人の ID・値・順位は応答に現れない', async () => {
    const challenge = await newChallenge();
    const nine = members().slice(0, MIN - 1);
    for (const [i, user] of nine.entries()) await seedParticipant(challenge, user, (i + 1) * 10, i + 1);

    const { raw, challenge: view } = await adminView(owner.jwt, challenge);

    expect(view.participantCount).toBeNull();
    expect(view.aggregate).toEqual({ minParticipants: MIN, visible: false, averageValue: null });
    for (const user of nine) {
      expect(raw).not.toContain(user.id);
      expect(raw).not.toContain(user.nickname);
    }
  });

  it('D-2: 開催中は、順位がついた人が 10 人いても平均は出さない。参加した人数 (延べ) は 10 で出る。個人の値は出ない', async () => {
    const challenge = await newChallenge();
    // 値は 10, 20, ..., 100
    for (const [i, user] of members().entries()) await seedParticipant(challenge, user, (i + 1) * 10, MIN - i);

    const { raw, challenge: view } = await adminView(admin.jwt, challenge);

    expect(view.participantCount).toBe(10);
    expect(view.aggregate).toEqual({ minParticipants: MIN, visible: false, averageValue: null });
    for (const user of members()) expect(raw).not.toContain(user.id);
    expect(raw).not.toContain('"rank"');
  });

  it('D-3: 終了時点の順位がついた人が 9 人なら、終了しても平均は null', async () => {
    const challenge = await newChallenge();
    for (const [i, user] of members().slice(0, MIN - 1).entries()) await seedParticipant(challenge, user, 50, i + 1);
    await seedParticipant(challenge, members()[MIN - 1]); // 参加したばかり (rank なし)

    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: challenge, status: 'completed' })).status).toBe(200);
    const { challenge: view } = await adminView(owner.jwt, challenge);

    expect(view.participantCount).toBe(10);
    expect(view.aggregate).toEqual({ minParticipants: MIN, visible: false, averageValue: null });
  });

  it('D-11: 終了すると終了時点の平均が出る。そのあと参加をやめても変わらない', async () => {
    const challenge = await newChallenge();
    for (const [i, user] of members().entries()) await seedParticipant(challenge, user, (i + 1) * 10, MIN - i);

    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: challenge, status: 'completed' })).status).toBe(200);
    let view = (await adminView(owner.jwt, challenge)).challenge;
    expect(view.aggregate).toEqual({ minParticipants: MIN, visible: true, averageValue: 55 }); // (10 + 20 + ... + 100) / 10

    expect((await apiCall('DELETE', `/api/org/challenges/${challenge}/join`, m1.jwt)).status).toBe(200);
    view = (await adminView(owner.jwt, challenge)).challenge;
    expect(view.participantCount).toBe(10);
    expect(view.aggregate).toEqual({ minParticipants: MIN, visible: true, averageValue: 55 });
  });

  it('D-4: 管理者の一覧とメンバー向けの API (my-challenges・詳細) の参加者数は同じ値 (延べ数。10 未満は null)。メンバー向けの応答に平均の項目は無い', async () => {
    const challenge = await newChallenge();
    await seedParticipant(challenge, m1, 90, 1);
    await seedParticipant(challenge, m2, 70, 2);

    async function counts() {
      const adminList = await adminView(owner.jwt, challenge);
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
      expect(list.body.minParticipants).toBe(MIN);
      expect(detail.body.minParticipants).toBe(MIN);
      // 管理者がメンバー向けの API を呼んでも、平均の項目は返らない (迂回できない)
      for (const raw of [JSON.stringify(list.body), JSON.stringify(detail.body)]) {
        expect(raw).not.toContain('averageValue');
        expect(raw).not.toContain('"aggregate"');
      }
      return [
        adminList.challenge.participantCount,
        list.body.challenges.find((c) => c.id === challenge)!.participantCount,
        detail.body.participantCount,
      ];
    }

    expect(await counts()).toEqual([null, null, null]);
    for (const [i, user] of members().slice(2).entries()) await seedParticipant(challenge, user, 50, i + 3);
    expect(await counts()).toEqual([MIN, MIN, MIN]);
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

  it('D-8: 管理者がメンバーを外しても、参加した人数も確定した平均も変わらない', async () => {
    const challenge = await newChallenge();
    for (const [i, user] of members().entries()) await seedParticipant(challenge, user, (i + 1) * 10, MIN - i);
    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: challenge, status: 'completed' })).status).toBe(200);
    expect((await adminView(owner.jwt, challenge)).challenge.aggregate.averageValue).toBe(55);

    try {
      // route POST /api/org/members/[user_id]/remove が呼ぶのと同じ関数 (通知メールの経路は通さない)
      const removed = await asUser(owner.jwt).rpc('remove_org_member', { p_organization_id: orgA, p_user_id: m10.id });
      expect(removed.error).toBeNull();

      const { challenge: view } = await adminView(owner.jwt, challenge);
      expect(view.participantCount).toBe(10);
      expect(view.aggregate).toEqual({ minParticipants: MIN, visible: true, averageValue: 55 });
    } finally {
      await setMembership(m10.id, orgA, 'member');
    }
  });

  it('D-9: 終了したチャレンジは PUT で開催中に戻せない (409 CHALLENGE_STATUS_LOCKED)。PostgREST を直接叩いても戻らない', async () => {
    const challenge = await newChallenge();
    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: challenge, status: 'completed' })).status).toBe(200);

    const reopen = await apiCall<{ error: string; code: string }>('PUT', '/api/org/challenges', owner.jwt, { id: challenge, status: 'active' });
    expect(reopen.status).toBe(409);
    expect(reopen.body).toEqual({ error: 'このチャレンジの状態は変えられません', code: 'CHALLENGE_STATUS_LOCKED' });

    const direct = await asUser(owner.jwt).from('organization_challenges').update({ status: 'active' }).eq('id', challenge);
    expect(direct.error?.code).toBe('P0001');
    expect(direct.error?.message).toContain('CHALLENGE_STATUS_LOCKED');
    const { data } = await srAdmin.from('organization_challenges').select('status').eq('id', challenge).single();
    expect(data?.status).toBe('completed');
  });

  it('D-10: 同じ種類で期間が重なるチャレンジを 2 本 PUT で終了すると、平均は先に終了した 1 本だけ', async () => {
    const a = await newChallenge();
    const b = await newChallenge();
    for (const id of [a, b]) {
      for (const [i, user] of members().entries()) await seedParticipant(id, user, (i + 1) * 10, MIN - i);
    }

    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: a, status: 'completed' })).status).toBe(200);
    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: b, status: 'completed' })).status).toBe(200);

    const viewA = (await adminView(owner.jwt, a)).challenge;
    const viewB = (await adminView(owner.jwt, b)).challenge;
    expect(viewA.participantCount).toBe(MIN);
    expect(viewB.participantCount).toBe(MIN);
    expect(viewA.aggregate).toEqual({ minParticipants: MIN, visible: true, averageValue: 55 });
    expect(viewB.aggregate).toEqual({ minParticipants: MIN, visible: false, averageValue: null });
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

  it('E-5: PUT は開催中 → 下書きを 409 にし、終了後もタイトル・説明・報酬は更新できる', async () => {
    const challenge = await newChallenge();

    const back = await apiCall<{ code: string }>('PUT', '/api/org/challenges', owner.jwt, { id: challenge, status: 'draft' });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('CHALLENGE_STATUS_LOCKED');
    const { data: afterBack } = await srAdmin.from('organization_challenges').select('status').eq('id', challenge).single();
    expect(afterBack?.status).toBe('active');

    expect((await apiCall('PUT', '/api/org/challenges', owner.jwt, { id: challenge, status: 'completed' })).status).toBe(200);
    const edit = await apiCall('PUT', '/api/org/challenges', owner.jwt, {
      id: challenge,
      title: `sec-chal renamed ${RUN}`,
      description: '終了後の説明',
      rewardDescription: '終了後の報酬',
    });
    expect(edit.status).toBe(200);
    const { data: afterEdit } = await srAdmin
      .from('organization_challenges')
      .select('status, title, description, reward_description')
      .eq('id', challenge)
      .single();
    expect(afterEdit).toEqual({
      status: 'completed',
      title: `sec-chal renamed ${RUN}`,
      description: '終了後の説明',
      reward_description: '終了後の報酬',
    });
  });
});
