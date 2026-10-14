/**
 * #1163 招待メール・参加リクエストメールの送信回数制限 (実際の API と DB での回帰テスト)
 *
 * 修正前は、組織の owner / admin や家族の大人が、任意のアドレスへ何通でも招待メールを送れた
 * (迷惑メールの踏み台、Resend のクォータ枯渇)。修正後は、API ごとに次の上限を超えると 429 を返し、
 * 招待の行も作らない (RPC より前に止める)。
 *   - 組織の招待: 招待者ごと 10/分 + 200/日、組織全体 500/日 (POST /api/org/invites と POST /api/org/members は共通の枠)
 *   - 子供メンバーの昇格リクエスト: 依頼者ごと 5/分 + 10/日
 *   - 同じ範囲 (組織・依頼者) から同じ宛先へは 3/日
 * 429 の本文は UI が読む { error: { code: 'RATE_LIMITED', message, retryAfter } } で、Retry-After ヘッダーを付ける。
 * 他の家族の子供の ID (member_id) をリクエストで指定しても、被害側の枠は使えない (未検証の ID を鍵にしない)。
 *
 * ここで確かめるのは、実際の Next サーバー (in-memory のカウンタ) と実 DB の組み合わせ。
 * 日次の上限の数値や分岐の網羅は tests/ai-rate-limit-contracts.test.ts と
 * src/__tests__/lib/membership/invite-throttle*.test.ts の単体テストで見る。
 * 家族の招待 (POST /api/family/invites) の上限は、この結合テストでは扱わず、
 * src/__tests__/api/family/invites/create.test.ts の単体テストで確かめる。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/invite-email-throttle.test.ts
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';

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
  email: string;
  jwt: string;
}

interface RateLimitedBody {
  error?: { code?: string; message?: string; retryAfter?: number };
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdFamilyIds: string[] = [];

/** 宛先ごとに一意なメールアドレス (実行ごとに変わるので、前回の実行のカウンタとも混ざらない) */
const recipient = (label: string) => `throttle-${label}-${TS}@homegohan.test`;

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-throttle-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `throttle-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

interface TestOrg {
  orgId: string;
  owner: TestUser;
}

async function createOrg(label: string): Promise<TestOrg> {
  const { data: org, error } = await srAdmin
    .from('organizations')
    .insert({ name: `#1163 throttle ${label} ${TS}` })
    .select('id')
    .single();
  if (error || !org) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = org.id as string;
  createdOrgIds.push(orgId);
  const owner = await createUser(`owner-${label}`);
  const { error: membershipError } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: 'owner', is_active_in_org: true })
    .eq('id', owner.id);
  if (membershipError) throw new Error(`membership ${label}: ${membershipError.message}`);
  return { orgId, owner };
}

interface TestFamily {
  rep: TestUser;
  familyId: string;
}

async function createFamily(label: string): Promise<TestFamily> {
  const rep = await createUser(`rep-${label}`);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1163 throttle ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return { rep, familyId };
}

async function orgInviteRows(orgId: string, email: string) {
  const { data, error } = await srAdmin
    .from('organization_invites')
    .select('id, token, email, status')
    .eq('organization_id', orgId)
    .eq('email', email.toLowerCase());
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return (data ?? []) as Array<{ id: string; token: string; email: string; status: string }>;
}

async function promotionRows(memberId: string, email: string) {
  const { data, error } = await srAdmin
    .from('family_promotion_requests')
    .select('id, email, status')
    .eq('member_id', memberId)
    .eq('email', email.toLowerCase());
  if (error) throw new Error(`family_promotion_requests: ${error.message}`);
  return (data ?? []) as Array<{ id: string; email: string; status: string }>;
}

/** 429 の応答が、UI が読む入れ子の本文と Retry-After ヘッダーを持つことを確かめる */
function expectRateLimited(res: { status: number; body: unknown; headers: Record<string, string> }) {
  expect(res.status).toBe(429);
  const body = res.body as RateLimitedBody;
  expect(body.error?.code).toBe('RATE_LIMITED');
  expect(typeof body.error?.message).toBe('string');
  expect(body.error!.message!.length).toBeGreaterThan(0);
  expect(Number.isInteger(body.error?.retryAfter)).toBe(true);
  expect(body.error!.retryAfter!).toBeGreaterThanOrEqual(1);
  expect(res.headers['retry-after']).toBe(String(body.error!.retryAfter));
}

let orgA: TestOrg; // 分あたりの上限 (members と invites が同じ枠)
let orgB: TestOrg; // 別の組織 (影響を受けない)
let orgC: TestOrg; // 宛先ごとの上限
let famA: TestFamily; // 被害側の家族 (子供の枠を他人に指定される)
let famB: TestFamily; // 同じ宛先への繰り返し
let famD: TestFamily; // 昇格リクエストの分あたり上限
let outsider: TestUser; // どの家族にも組織にも所属しない
let childD1 = '';
let childA1 = '';

beforeAll(async () => {
  orgA = await createOrg('a');
  orgB = await createOrg('b');
  orgC = await createOrg('c');
  famA = await createFamily('a');
  famB = await createFamily('b');
  famD = await createFamily('d');
  outsider = await createUser('outsider');

  const addChild = async (family: TestFamily, name: string) => {
    const { data, error } = await asUser(family.rep.jwt).rpc('add_family_child', {
      p_family_id: family.familyId,
      p_display_name: name,
      p_child_profile: { age: 12 },
    });
    if (error || !data) throw new Error(`add_family_child ${name}: ${error?.message}`);
    return (data as { id: string }).id;
  };
  childD1 = await addChild(famD, 'D1');
  childA1 = await addChild(famA, 'A1');

  // dev サーバーが各 route を初めてコンパイルする時間で「1 分」の枠が過ぎないよう、先に未認証で 1 回ずつ叩いておく
  // (401 は上限の判定より前に返るので、カウンタは進まない)
  for (const path of ['/api/org/members', '/api/org/invites', `/api/family/members/${childD1}/promote`]) {
    await apiCall('POST', path, null, { email: recipient('warmup') });
  }
}, 180_000);

afterAll(async () => {
  for (const id of createdOrgIds) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('organization_invites').delete().eq('organization_id', id);
  }
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  for (const id of createdOrgIds) {
    await srAdmin.from('organizations').delete().eq('id', id);
  }
  for (const id of createdFamilyIds) {
    await srAdmin.from('family_groups').delete().eq('id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('#1163 組織の招待: POST /api/org/members と POST /api/org/invites は同じ枠 (招待者ごと 10/分)', () => {
  it('T-1: 1 分に 10 通までは成功し、11 通目は 429。2 つの入口のどちらからも同じ枠で止まる', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      // 偶数回は /api/org/members (201)、奇数回は /api/org/invites (200) で交互に送る
      const path = i % 2 === 0 ? '/api/org/members' : '/api/org/invites';
      const res = await apiCall('POST', path, orgA.owner.jwt, { email: recipient(`a-${i}`) });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 200, 201, 200, 201, 200, 201, 200, 201, 200]);

    const eleventh = await apiCall('POST', '/api/org/members', orgA.owner.jwt, { email: recipient('a-over-members') });
    expectRateLimited(eleventh);

    const twelfth = await apiCall('POST', '/api/org/invites', orgA.owner.jwt, { email: recipient('a-over-invites') });
    expectRateLimited(twelfth);
  }, 60_000);

  it('T-2: 429 で止まった宛先には招待の行が作られない (RPC の前に止まっている)', async () => {
    expect(await orgInviteRows(orgA.orgId, recipient('a-over-members'))).toHaveLength(0);
    expect(await orgInviteRows(orgA.orgId, recipient('a-over-invites'))).toHaveLength(0);
    // 通った宛先には pending の招待がある
    expect(await orgInviteRows(orgA.orgId, recipient('a-0'))).toHaveLength(1);
  });

  it('T-3: 別の組織の owner は影響を受けない', async () => {
    const res = await apiCall('POST', '/api/org/members', orgB.owner.jwt, { email: recipient('b-0') });

    expect(res.status).toBe(201);
    expect(await orgInviteRows(orgB.orgId, recipient('b-0'))).toHaveLength(1);
  });
});

describe('#1163 組織の招待: 同じ組織から同じ宛先へは 1 日 3 回まで', () => {
  it('T-4: 3 回目までは成功し (再送は前の招待を取り消して作り直す)、4 回目は 429 で行も増えない', async () => {
    const email = recipient('c-same');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await apiCall('POST', '/api/org/members', orgC.owner.jwt, { email })).status);
    }
    expect(statuses).toEqual([201, 201, 201]);

    const fourth = await apiCall('POST', '/api/org/members', orgC.owner.jwt, { email });
    expectRateLimited(fourth);

    const rows = await orgInviteRows(orgC.orgId, email);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'revoked')).toHaveLength(2);
  }, 60_000);

  it('T-5: 同じ owner でも別の宛先へは引き続き送れる', async () => {
    const res = await apiCall('POST', '/api/org/members', orgC.owner.jwt, { email: recipient('c-other') });

    expect(res.status).toBe(201);
  });

  it('T-6: 宛先の大文字小文字・前後の空白は区別しない (小文字に正規化して 1 行にそろう)', async () => {
    const res = await apiCall('POST', '/api/org/invites', orgB.owner.jwt, {
      email: `  THROTTLE-B-MIXED-${TS}@HOMEGOHAN.TEST `,
    });

    expect(res.status).toBe(200);
    const rows = await orgInviteRows(orgB.orgId, recipient('b-mixed'));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(recipient('b-mixed'));
  });
});

describe('#1163 組織の招待: 入力の検証 (不正なアドレスでは招待を作らない)', () => {
  it('T-7: 形式が不正な宛先・owner への役割・長すぎるメッセージは 400 INVALID_BODY で、招待の行は作られない', async () => {
    const bad = recipient('b-bad');
    const cases: Array<[string, unknown]> = [
      ['宛先の形式が不正', { email: 'not-an-email' }],
      ['role に owner', { email: bad, role: 'owner' }],
      ['custom_message が 501 文字', { email: bad, custom_message: 'あ'.repeat(501) }],
    ];
    for (const [label, body] of cases) {
      const res = await apiCall('POST', '/api/org/invites', orgB.owner.jwt, body);
      expect(res.status, label).toBe(400);
      expect((res.body as RateLimitedBody).error?.code, label).toBe('INVALID_BODY');
    }
    const members = await apiCall('POST', '/api/org/members', orgB.owner.jwt, { email: bad, nickname: 'あ'.repeat(51) });
    expect(members.status).toBe(400);

    expect(await orgInviteRows(orgB.orgId, bad)).toHaveLength(0);
  });

  it('T-8: password など未知のキーは無視され、招待は作られる (古いモバイルアプリとの互換)', async () => {
    const res = await apiCall('POST', '/api/org/members', orgB.owner.jwt, {
      email: recipient('b-legacy'),
      password: 'Chosen-by-admin-2026!',
      nickname: '旧アプリ',
    });

    expect(res.status).toBe(201);
    expect(await orgInviteRows(orgB.orgId, recipient('b-legacy'))).toHaveLength(1);
  });
});

describe('#1163 子供メンバーの昇格リクエスト: POST /api/family/members/[id]/promote (依頼者ごと 5/分)', () => {
  it('T-9: 5 通までは成功し、6 通目は 429 で、リクエストの行は作られない', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await apiCall('POST', `/api/family/members/${childD1}/promote`, famD.rep.jwt, { email: recipient(`p-${i}`) })).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200]);

    const sixth = await apiCall('POST', `/api/family/members/${childD1}/promote`, famD.rep.jwt, {
      email: recipient('p-over'),
    });
    expectRateLimited(sixth);
    expect(await promotionRows(childD1, recipient('p-over'))).toHaveLength(0);
    expect(await promotionRows(childD1, recipient('p-4'))).toHaveLength(1);
  }, 60_000);

  it('T-10: ★他の家族の子供の枠 (member_id) を指定しても、枠を使い切るのはその依頼者自身だけで、被害側の代表者には影響しない', async () => {
    // 家族に所属しない人が家族 A の子供の ID を指定して叩く: RPC が NOT_FAMILY_ADULT で拒否する (5 回まで)。6 回目はその人自身の枠が尽きる
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await apiCall('POST', `/api/family/members/${childA1}/promote`, outsider.jwt, { email: recipient(`p-out-${i}`) })).status,
      );
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);

    // 家族 A の代表者は影響を受けず、自分の子供の昇格リクエストを送れる
    const own = await apiCall('POST', `/api/family/members/${childA1}/promote`, famA.rep.jwt, {
      email: recipient('p-a-0'),
    });
    expect(own.status).toBe(200);
  }, 60_000);

  it('T-11: 同じ依頼者から同じ宛先へは 1 日 3 回まで (4 回目は 429)', async () => {
    // 家族 B の代表者 (昇格リクエストの枠は未使用) が、自分の子供へ同じ宛先で繰り返す
    const { data, error } = await asUser(famB.rep.jwt).rpc('add_family_child', {
      p_family_id: famB.familyId,
      p_display_name: 'B1',
      p_child_profile: { age: 11 },
    });
    if (error || !data) throw new Error(`add_family_child B1: ${error?.message}`);
    const childB1 = (data as { id: string }).id;

    const email = recipient('p-same');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await apiCall('POST', `/api/family/members/${childB1}/promote`, famB.rep.jwt, { email })).status);
    }
    expect(statuses).toEqual([200, 200, 200]);

    expectRateLimited(await apiCall('POST', `/api/family/members/${childB1}/promote`, famB.rep.jwt, { email }));
    // 3 回の再送で前のリクエストは取り消され、有効 (pending) なのは最後の 1 件だけ
    const rows = await promotionRows(childB1, email);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
  }, 60_000);
});
