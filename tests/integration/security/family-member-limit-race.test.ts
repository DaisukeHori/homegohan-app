/**
 * #1213 家族グループの人数上限 (member_limit) の確認が競合し、同時に参加すると上限を超えて入れてしまう問題の回帰テスト
 *
 * accept_family_invite (招待の承諾) と add_family_child (子供の追加) は、「active なメンバー数を数える → 上限未満なら
 * family_members に INSERT」を家族の行をロックせずに行っていた。承諾がロックするのは自分の招待の行だけなので、
 * 同じ家族宛でも招待が別なら互いを待たず、上限 4 人・現在 3 人の家族に 2 人が同時に入れてしまう (承諾と子供の追加でも同じ)。
 *
 * 修正後 (20261007160000_family_member_limit_row_lock.sql):
 *   - 人数を数える前に family_groups の行を SELECT ... FOR UPDATE でロックする。同じ家族への承諾・子供の追加は
 *     1 件ずつ順に処理され、待たされた側は先の処理が入れたメンバーを数えて MEMBER_LIMIT_EXCEEDED になる
 *   - ロックは家族ごと。別の家族どうしは待ち合わない
 *   - 解散済み (status <> 'active') の家族には承諾も子供の追加もできない (FAMILY_NOT_FOUND)
 *   - 関数の属性と実行権限は変わらない
 *
 * 競合の再現のしかた (タイミングに頼らない):
 *   postgres-meta (/pg/query) で「本人になりすまして RPC を呼び、そのあと pg_sleep でトランザクションを開いたままにする」
 *   接続を 1 本作る (= 人数を数えて INSERT したが、まだコミットしていない状態を作る)。pg_sleep に入ったのを
 *   pg_stat_activity で確かめてから、もう 1 件を本物の経路 (PostgREST + 本人の JWT) で呼ぶ。
 *   修正前: 後から呼んだ側は何も待たず、先の INSERT が見えないまま人数を数えて上限を通過する (両方成功する)。
 *   修正後: 後から呼んだ側は家族の行のロックで待たされ、先のコミット後に数え直して MEMBER_LIMIT_EXCEEDED になる。
 *   これとは別に、PostgREST で複数を一斉に呼ぶ素直な並行テストも置く (R5 / R6)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/family-member-limit-race.test.ts
 *
 * 関数定義・権限の確認 (has_function_privilege など) と、競合の再現用の接続は、ローカルスタックの postgres-meta
 * (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';

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

/** ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る */
async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

/** カタログの確認や競合の観測に使う (読み取りだけ) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const pendingHolders: Array<Promise<unknown>> = [];
const TOKEN_RE = /^[a-f0-9]{64}$/;

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-limit-race-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `race-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function createUsers(prefix: string, count: number): Promise<TestUser[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => createUser(`${prefix}${i + 1}`)));
}

/** 代表者 rep の家族を作り、人数の上限を memberLimit にする (service_role は上限の列を直接変えられる) */
async function createFamily(rep: TestUser, label: string, memberLimit: number): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1213 ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  await setMemberLimit(familyId, memberLimit);
  return familyId;
}

async function setMemberLimit(familyId: string, memberLimit: number): Promise<void> {
  const { error } = await srAdmin.from('family_groups').update({ member_limit: memberLimit }).eq('id', familyId);
  if (error) throw new Error(`member_limit: ${error.message}`);
}

/** 招待を出す。create_family_invite は発行時にも上限を見るため、人数が上限に届く前に出しておく */
async function inviteToken(rep: TestUser, familyId: string, email: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: email });
  if (error || !data) throw new Error(`create_family_invite: ${error?.message}`);
  const token = (data as { token: string }).token;
  expect(token).toMatch(TOKEN_RE);
  return token;
}

interface ActiveMember {
  user_id: string | null;
  role: string;
  display_name: string | null;
}

async function activeMembers(familyId: string): Promise<ActiveMember[]> {
  const { data, error } = await srAdmin
    .from('family_members')
    .select('user_id, role, display_name')
    .eq('family_id', familyId)
    .eq('status', 'active');
  if (error) throw new Error(`family_members: ${error.message}`);
  return (data ?? []) as ActiveMember[];
}

async function inviteStatus(token: string): Promise<string> {
  const { data, error } = await srAdmin.from('family_invites').select('status').eq('token', token).single();
  if (error) throw new Error(`family_invites: ${error.message}`);
  return (data as { status: string }).status;
}

async function profileFamilyId(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('family_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return data ? ((data as { family_id: string | null }).family_id ?? null) : null;
}

async function auditCount(familyId: string, action: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'family')
    .eq('scope_id', familyId)
    .eq('action', action);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

/** RPC を 1 回呼んだ結果。ok は成功、message はエラーメッセージ (RAISE EXCEPTION の文字列) */
interface Outcome {
  ok: boolean;
  message: string | null;
}

type Call =
  | { kind: 'accept'; user: TestUser; token: string }
  | { kind: 'child'; user: TestUser; familyId: string; name: string };

/** 本物の経路 (PostgREST + 本人の JWT) で呼ぶ */
async function callViaApi(call: Call): Promise<Outcome> {
  const api = asUser(call.user.jwt);
  const { error } =
    call.kind === 'accept'
      ? await api.rpc('accept_family_invite', { p_token: call.token })
      : await api.rpc('add_family_child', {
          p_family_id: call.familyId,
          p_display_name: call.name,
          p_child_profile: { note: '#1213' },
        });
  return { ok: !error, message: error?.message ?? null };
}

function callSql(call: Call): string {
  return call.kind === 'accept'
    ? `public.accept_family_invite('${call.token}')`
    : `public.add_family_child('${call.familyId}'::uuid, '${call.name}', '{"note":"#1213"}'::jsonb)`;
}

/**
 * 別の接続で call を実行し、そのあと holdSeconds 秒 pg_sleep してトランザクションを開いたままにする。
 * sleeping は「call の実行が済み、pg_sleep に入った」(= 人数を数えて INSERT したがコミット前の) 状態になると解決する。
 * done はトランザクションが終わった (コミットされた) ときに解決する。
 */
function holdOpen(call: Call, holdSeconds: number): { sleeping: Promise<void>; done: Promise<Outcome> } {
  const marker = `race-holder-${randomBytes(6).toString('hex')}`;
  const claims = JSON.stringify({ sub: call.user.id, role: 'authenticated' });
  const sql = `/* ${marker} */
    SELECT set_config('request.jwt.claims', '${claims}', true);
    SET LOCAL ROLE authenticated;
    SELECT * FROM ${callSql(call)};
    SELECT pg_sleep(${holdSeconds});
    SELECT 'held' AS result;`;

  const state: { outcome: Outcome | null } = { outcome: null };
  const done = pgRequest(sql).then((res): Outcome => {
    const body = res.body as { error?: unknown } | null;
    const outcome: Outcome = res.ok
      ? { ok: true, message: null }
      : { ok: false, message: typeof body?.error === 'string' ? body.error : JSON.stringify(body) };
    state.outcome = outcome;
    return outcome;
  });
  pendingHolders.push(done);

  const sleeping = (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (state.outcome) {
        // pg_sleep に入る前に終わった = 先の RPC が失敗している (競合の再現にならないので、理由を示して止める)
        throw new Error(`先に呼んだ接続が pg_sleep に入る前に終わりました: ${JSON.stringify(state.outcome)}`);
      }
      const rows = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      if (rows[0]?.n === 1) return;
      await sleep(50);
    }
    throw new Error('先に呼んだ接続が pg_sleep に入りませんでした (遅すぎます)');
  })();

  return { sleeping, done };
}

/** 先に first を呼んでトランザクションを開いたままにし、その間に second を本物の経路で呼ぶ */
async function race(first: Call, second: Call, holdSeconds = 3): Promise<{ first: Outcome; second: Outcome }> {
  const holder = holdOpen(first, holdSeconds);
  await holder.sleeping;
  const secondOutcome = await callViaApi(second);
  return { first: await holder.done, second: secondOutcome };
}

function expectLimitExceeded(outcome: Outcome) {
  expect(outcome.ok).toBe(false);
  expect(outcome.message).toContain('MEMBER_LIMIT_EXCEEDED');
}

afterAll(async () => {
  await Promise.allSettled(pendingHolders);
  for (const id of createdFamilyIds) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('family_groups').delete().eq('id', id); // family_members / family_invites は CASCADE
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}, 120_000);

describe('#1213 人数の上限まであと 1 人の家族に、2 つの処理が同時に入ろうとする (先の処理はコミット前)', () => {
  // どの組み合わせでも、成功するのは 1 件だけ。もう 1 件は MEMBER_LIMIT_EXCEEDED で、何も残さない。
  // 上限 2 人の家族に代表者 1 人 = あと 1 人入れる。

  it('R1: 別々の招待を持つ 2 人の承諾', async () => {
    const [rep, x, y] = await createUsers('r1-', 3);
    const familyId = await createFamily(rep, 'r1', 2);
    const tokenX = await inviteToken(rep, familyId, x.email);
    const tokenY = await inviteToken(rep, familyId, y.email);

    const result = await race(
      { kind: 'accept', user: x, token: tokenX },
      { kind: 'accept', user: y, token: tokenY },
    );

    expect(result.first.ok).toBe(true);
    expectLimitExceeded(result.second);

    // 上限 2 人のまま。後から来た y は入れず、招待も使われないまま、所属もプロフィールにも入らない
    const members = await activeMembers(familyId);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.user_id).sort()).toEqual([rep.id, x.id].sort());
    expect(await inviteStatus(tokenX)).toBe('accepted');
    expect(await inviteStatus(tokenY)).toBe('pending');
    expect(await profileFamilyId(x.id)).toBe(familyId);
    expect(await profileFamilyId(y.id)).toBeNull();
    expect(await auditCount(familyId, 'invite_accepted')).toBe(1);
  });

  it('R2: 承諾が先、子供の追加が後', async () => {
    const [rep, x] = await createUsers('r2-', 2);
    const familyId = await createFamily(rep, 'r2', 2);
    const tokenX = await inviteToken(rep, familyId, x.email);

    const result = await race(
      { kind: 'accept', user: x, token: tokenX },
      { kind: 'child', user: rep, familyId, name: 'r2-child' },
    );

    expect(result.first.ok).toBe(true);
    expectLimitExceeded(result.second);

    const members = await activeMembers(familyId);
    expect(members).toHaveLength(2);
    expect(members.some((m) => m.role === 'child')).toBe(false);
    expect(await auditCount(familyId, 'child_added')).toBe(0);
  });

  it('R3: 子供の追加が先、承諾が後', async () => {
    const [rep, x] = await createUsers('r3-', 2);
    const familyId = await createFamily(rep, 'r3', 2);
    const tokenX = await inviteToken(rep, familyId, x.email);

    const result = await race(
      { kind: 'child', user: rep, familyId, name: 'r3-child' },
      { kind: 'accept', user: x, token: tokenX },
    );

    expect(result.first.ok).toBe(true);
    expectLimitExceeded(result.second);

    const members = await activeMembers(familyId);
    expect(members).toHaveLength(2);
    expect(members.filter((m) => m.role === 'child').map((m) => m.display_name)).toEqual(['r3-child']);
    expect(await inviteStatus(tokenX)).toBe('pending');
    expect(await profileFamilyId(x.id)).toBeNull();
    expect(await auditCount(familyId, 'invite_accepted')).toBe(0);
  });

  it('R4: 子供の追加どうし', async () => {
    const [rep] = await createUsers('r4-', 1);
    const familyId = await createFamily(rep, 'r4', 2);

    const result = await race(
      { kind: 'child', user: rep, familyId, name: 'r4-child-1' },
      { kind: 'child', user: rep, familyId, name: 'r4-child-2' },
    );

    expect(result.first.ok).toBe(true);
    expectLimitExceeded(result.second);

    const members = await activeMembers(familyId);
    expect(members).toHaveLength(2);
    expect(members.filter((m) => m.role === 'child').map((m) => m.display_name)).toEqual(['r4-child-1']);
    expect(await auditCount(familyId, 'child_added')).toBe(1);
  });
});

describe('#1213 PostgREST から複数を一斉に呼ぶ場合と、ロックの範囲', () => {
  it('R5: 上限 3 人 (代表者 + 空き 2) の家族に 5 人が一斉に承諾すると、成功は 2 人だけで上限を超えない', async () => {
    const [rep, ...invitees] = await createUsers('r5-', 6);
    const familyId = await createFamily(rep, 'r5', 3);
    const calls: Call[] = [];
    for (const invitee of invitees) {
      calls.push({ kind: 'accept', user: invitee, token: await inviteToken(rep, familyId, invitee.email) });
    }

    const outcomes = await Promise.all(calls.map(callViaApi));

    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
    for (const failed of outcomes.filter((o) => !o.ok)) expectLimitExceeded(failed);
    expect(await activeMembers(familyId)).toHaveLength(3);
    expect(await auditCount(familyId, 'invite_accepted')).toBe(2);
  });

  it('R6: 空きが十分あるときは、一斉に承諾しても全員入れる (ロックで失敗やデッドロックにならない)', async () => {
    const [rep, ...invitees] = await createUsers('r6-', 5);
    const familyId = await createFamily(rep, 'r6', 20);
    const calls: Call[] = [];
    for (const invitee of invitees) {
      calls.push({ kind: 'accept', user: invitee, token: await inviteToken(rep, familyId, invitee.email) });
    }

    // 承諾 4 件と子供の追加 1 件を同時に走らせる
    const outcomes = await Promise.all([
      ...calls.map(callViaApi),
      callViaApi({ kind: 'child', user: rep, familyId, name: 'r6-child' }),
    ]);

    expect(outcomes.map((o) => o.message).filter((m) => m !== null)).toEqual([]);
    expect(await activeMembers(familyId)).toHaveLength(1 + 4 + 1);
  });

  it('R7: ロックは家族ごと。別の家族の処理が開いたままでも、待たされずに入れる', async () => {
    const [repA, a, repB, b] = await createUsers('r7-', 4);
    const familyA = await createFamily(repA, 'r7-a', 5);
    const familyB = await createFamily(repB, 'r7-b', 5);
    const tokenA = await inviteToken(repA, familyA, a.email);
    const tokenB = await inviteToken(repB, familyB, b.email);

    // 家族 A の承諾を 4 秒間コミットしないで開いておく
    const holder = holdOpen({ kind: 'accept', user: a, token: tokenA }, 4);
    let holderSettled = false;
    void holder.done.then(() => {
      holderSettled = true;
    });
    await holder.sleeping;

    const second = await callViaApi({ kind: 'accept', user: b, token: tokenB });
    expect(second.ok).toBe(true);
    // 家族 A のトランザクションはまだ開いている (= 家族 B の承諾は、それを待たずに終わった)
    expect(holderSettled).toBe(false);

    expect((await holder.done).ok).toBe(true);
    expect(await activeMembers(familyA)).toHaveLength(2);
    expect(await activeMembers(familyB)).toHaveLength(2);
  });
});

describe('#1213 上限と解散済みの家族 (順番に呼ぶ)', () => {
  it('S1: 上限に達するまでは入れ、達したあとの承諾・子供の追加は MEMBER_LIMIT_EXCEEDED で何も残さない', async () => {
    const [rep, x, y] = await createUsers('s1-', 3);
    const familyId = await createFamily(rep, 's1', 2);
    // 招待は上限に届く前に出す (create_family_invite も発行時に上限を見る)
    const tokenX = await inviteToken(rep, familyId, x.email);
    const tokenY = await inviteToken(rep, familyId, y.email);

    // 空きがあるうちは今までどおり入れる
    const accepted = await asUser(x.jwt).rpc('accept_family_invite', { p_token: tokenX });
    expect(accepted.error).toBeNull();
    expect(accepted.data).toMatchObject({ family_id: familyId, user_id: x.id, role: 'adult', status: 'active' });
    expect(await profileFamilyId(x.id)).toBe(familyId);
    expect(await auditCount(familyId, 'invite_accepted')).toBe(1);

    // 上限に達した
    const full = await asUser(y.jwt).rpc('accept_family_invite', { p_token: tokenY });
    expect(full.data).toBeNull();
    expect(full.error?.code).toBe('P0001');
    expect(full.error?.message).toBe('MEMBER_LIMIT_EXCEEDED');
    expect(await inviteStatus(tokenY)).toBe('pending');
    expect(await profileFamilyId(y.id)).toBeNull();

    const fullChild = await asUser(rep.jwt).rpc('add_family_child', {
      p_family_id: familyId,
      p_display_name: 's1-child',
      p_child_profile: { note: '#1213' },
    });
    expect(fullChild.data).toBeNull();
    expect(fullChild.error?.code).toBe('P0001');
    expect(fullChild.error?.message).toBe('MEMBER_LIMIT_EXCEEDED');
    expect(await activeMembers(familyId)).toHaveLength(2);
    expect(await auditCount(familyId, 'child_added')).toBe(0);

    // 上限を 1 人増やすと、子供を追加できる (add_family_child の通常の動作は変わらない)
    await setMemberLimit(familyId, 3);
    const child = await asUser(rep.jwt).rpc('add_family_child', {
      p_family_id: familyId,
      p_display_name: 's1-child',
      p_child_profile: { note: '#1213' },
    });
    expect(child.error).toBeNull();
    expect(child.data).toMatchObject({
      family_id: familyId,
      user_id: null,
      role: 'child',
      display_name: 's1-child',
      status: 'active',
    });
    expect(await activeMembers(familyId)).toHaveLength(3);
    expect(await auditCount(familyId, 'child_added')).toBe(1);
  });

  it('S2: 家族の外の人は、子供の追加で NOT_FAMILY_ADULT になる (家族の有無も分からない)', async () => {
    const [rep, outsider] = await createUsers('s2-', 2);
    const familyId = await createFamily(rep, 's2', 4);
    const missingFamilyId = '00000000-0000-4000-8000-000000001213';

    for (const target of [familyId, missingFamilyId]) {
      const res = await asUser(outsider.jwt).rpc('add_family_child', {
        p_family_id: target,
        p_display_name: 's2-child',
        p_child_profile: { note: '#1213' },
      });
      expect(res.data).toBeNull();
      expect(res.error?.message).toBe('NOT_FAMILY_ADULT');
    }
    expect(await activeMembers(familyId)).toHaveLength(1);
  });

  it('D1: 解散済み (status = dissolved) の家族には、未使用の招待があっても承諾できず、子供も追加できない', async () => {
    const [rep, x] = await createUsers('d1-', 2);
    const familyId = await createFamily(rep, 'd1', 4);
    const tokenX = await inviteToken(rep, familyId, x.email);

    // 運営による強制解散 (operator_force_dissolve_family) は招待を失効させない。ここでは家族の status だけを dissolved にする
    const { error: dissolveError } = await srAdmin
      .from('family_groups')
      .update({ status: 'dissolved', dissolved_at: new Date().toISOString() })
      .eq('id', familyId);
    expect(dissolveError).toBeNull();

    const accept = await asUser(x.jwt).rpc('accept_family_invite', { p_token: tokenX });
    expect(accept.data).toBeNull();
    expect(accept.error?.code).toBe('P0001');
    expect(accept.error?.message).toBe('FAMILY_NOT_FOUND');
    expect(await inviteStatus(tokenX)).toBe('pending');
    expect(await profileFamilyId(x.id)).toBeNull();
    expect(await auditCount(familyId, 'invite_accepted')).toBe(0);

    // 代表者の行は active のまま (解散処理の途中を想定した状態)。それでも解散済みの家族には追加させない
    const child = await asUser(rep.jwt).rpc('add_family_child', {
      p_family_id: familyId,
      p_display_name: 'd1-child',
      p_child_profile: { note: '#1213' },
    });
    expect(child.data).toBeNull();
    expect(child.error?.message).toBe('FAMILY_NOT_FOUND');

    const members = await activeMembers(familyId);
    expect(members).toHaveLength(1);
    expect(members[0]?.user_id).toBe(rep.id);
    expect(await auditCount(familyId, 'child_added')).toBe(0);
  });
});

describe('#1213 関数の属性と権限 (CREATE OR REPLACE で変わらない)', () => {
  it('A1: SECURITY DEFINER・search_path 固定・所有者 postgres。anon・PUBLIC は実行できず、authenticated と service_role は実行できる', async () => {
    const rows = await pgQuery<{
      sig: string;
      secdef: boolean;
      config: string[] | null;
      owner: string;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
      public_exec: boolean;
    }>(`
      SELECT p.oid::regprocedure::text AS sig,
             p.prosecdef AS secdef,
             p.proconfig AS config,
             pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0
             ) AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('accept_family_invite', 'add_family_child')
      ORDER BY 1
    `);
    expect(rows.map((r) => r.sig)).toEqual([
      'accept_family_invite(text,boolean,boolean,boolean)',
      'add_family_child(uuid,text,jsonb)',
    ]);
    for (const row of rows) {
      expect(row.secdef).toBe(true);
      expect(row.config).toContain('search_path=public');
      expect(row.owner).toBe('postgres');
      expect(row.anon_exec).toBe(false);
      expect(row.public_exec).toBe(false);
      expect(row.auth_exec).toBe(true);
      expect(row.sr_exec).toBe(true);
    }
  });

  it('A2: anon は 2 つの RPC を呼べない', async () => {
    const accept = await anon().rpc('accept_family_invite', { p_token: randomBytes(32).toString('hex') });
    expect(accept.error?.code).toBe('42501');
    const child = await anon().rpc('add_family_child', {
      p_family_id: '00000000-0000-4000-8000-000000001213',
      p_display_name: 'a2-child',
      p_child_profile: {},
    });
    expect(child.error?.code).toBe('42501');
  });
});
