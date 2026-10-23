/**
 * 退会の findBlocker (オーナー / 代表者なら 409) のあとに、譲渡の承諾・運営の強制譲渡でオーナーになった人の所属を
 * release_user_membership が外し、organizations.owner_id が所属の無い人を指す組織が残りうる既存の欠陥の回帰テスト (実 DB)。
 * CLAUDE.md の「組織 (organizations) を変える関数のロック順 (DB)」・docs/design/family/11-self-dissolve.md §11.3。
 *
 * 修正前 (release_user_membership の最新の定義は 20251126124224_create_meal_planner_tables.sql :2803-2832):
 *   - release_user_membership は組織の行を取らず、本人の user_profiles の行だけをロックし、本人がオーナーかを判定しなかった。
 *     譲渡の承諾・運営の強制譲渡が本人をオーナーにしている (コミット前) 間に呼ぶと、譲渡の commit を本人の行で待ち、
 *     commit のあとにオーナーになった本人の所属を外した (owner_id が所属の無い人を指す。RM-1・RM-2)。
 *   - 運営の強制譲渡 (operator_force_owner_transfer。最新の定義は 20261022140000_org_transfer_toctou.sql) は、旧オーナーの行へ在籍を見ずに
 *     org_role = 'admin' を書いたので、上の状態の組織に強制譲渡すると CHECK user_profiles_org_consistency (23514) で止まった (RM-7)。
 *
 * 修正後 (supabase/migrations/20261022160000_release_membership_owner_race.sql):
 *   - release_user_membership は 組織の行 → 本人の user_profiles の順に取ってから判定する。本人が組織の行の owner_id なら IS_ORG_OWNER で
 *     止まって所属を外さない。所属が途中で外れていれば何もしない。別の組織に入っていれば CONFLICT_RETRY。
 *   - 運営の強制譲渡は、旧オーナーの行がその組織に在籍しているときだけ org_role を書く。
 *
 * 呼び出しは本物の経路 (PostgREST)。release_user_membership は service_role だけが呼べる (退会の本体と同じ)。
 * 先の処理をコミット前のまま開いておくのは、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う
 * (org-transfer-toctou.test.ts と同じ道具)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-transfer-toctou-release-membership.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import ws from 'ws';
import { actAsAuthenticatedSql, createLockHolderKit, type Holder } from '../helpers/lock-holder';
import { promoteToAal2 } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kong → PostgREST の使い回しの接続の 502 (リクエストが PostgREST に届いていない) を数回だけやり直す (org-transfer-toctou.test.ts と同じ) */
const GATEWAY_RETRIES = 3;
/** 502 をやり直すまでの待ちの単位 (ミリ秒) */
const GATEWAY_RETRY_WAIT_MS = 150;
/** postgres-meta の 502 をやり直すのは、この時間 (ミリ秒) 以内に返ったときだけ (pg_sleep で待たせた後の応答ではない) */
const GATEWAY_FAST_FAIL_MS = 1500;
const HTTP_BAD_GATEWAY = 502;

const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== HTTP_BAD_GATEWAY || attempt >= GATEWAY_RETRIES) return res;
    await sleep(GATEWAY_RETRY_WAIT_MS * (attempt + 1));
  }
};

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: {
      fetch: fetchRetryingGateway502,
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === HTTP_BAD_GATEWAY && attempt < GATEWAY_RETRIES && Date.now() - startedAt < GATEWAY_FAST_FAIL_MS) {
      await sleep(GATEWAY_RETRY_WAIT_MS * (attempt + 1));
      continue;
    }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  }
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

type OrgRole = 'owner' | 'admin' | 'member';

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
/** 成人の生年月日 (18 歳未満は譲渡を引き受けられない。#1173) */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 組織の席数 (テストで足りる数。席数の上限で断られる経路と混ざらないように) */
const ORG_TOTAL_LICENSES = 20;
/** 組織にすでにいるメンバーの数として置く席数 (オーナーと admin) */
const SEEDED_USED_LICENSES = 2;
/** 席数を 1 つ減らす (所属を外したとき) */
const ONE_SEAT = 1;
/** 本物の経路で同時に呼ぶ回数 (org-transfer-toctou.test.ts と同じ) */
const ITERATIONS = 8;
/** 招待のトークンのバイト数 (hex で 64 文字。create_org_invite と同じ形) */
const TOKEN_BYTES = 32;
/** 招待の期限 (14 日。create_org_invite と同じ) */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TEST_TIMEOUT_MS = 120_000;
const RACE_TIMEOUT_MS = 240_000;
/** CHECK 違反の SQLSTATE (修正前の強制譲渡が返していたもの) */
const PG_CHECK_VIOLATION = '23514';

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-release-owner-race-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `release-owner-race-${label}`,
        age_group: '30s',
        gender: 'other',
        birth_date: ADULT_BIRTH_DATE,
        ...(roles ? { roles } : {}),
      },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const { jwt } = await signIn(email);
  return { id: data.user.id, email, jwt };
}

async function createUsers(prefix: string, count: number): Promise<TestUser[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => createUser(`${prefix}-${i + 1}`)));
}

async function setOrgMembership(user: TestUser, orgId: string, role: OrgRole): Promise<void> {
  const roles = role === 'member' ? ['user'] : ['user', 'org_admin'];
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: true, joined_org_at: new Date().toISOString(), roles })
    .eq('id', user.id);
  if (error) throw new Error(`membership: ${error.message}`);
}

/** 組織を作り、オーナーを owner・admin を admin として所属させる (席数は SEEDED_USED_LICENSES) */
async function createOrg(owner: TestUser, admin: TestUser, label: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `release-owner-race ${label} ${TS}`, owner_id: owner.id })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = data.id as string;
  createdOrgIds.push(orgId);
  const { error: poolError } = await retryIdempotentSetup(srAdmin, 'createOrg: org_license_pools の upsert', (db) =>
    db.from('org_license_pools').upsert(
      { organization_id: orgId, total_licenses: ORG_TOTAL_LICENSES, used_licenses: SEEDED_USED_LICENSES },
      { onConflict: 'organization_id' },
    ));
  if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  await setOrgMembership(owner, orgId, 'owner');
  await setOrgMembership(admin, orgId, 'admin');
  return orgId;
}

async function proposeOrgTransfer(owner: TestUser, orgId: string, toUserId: string): Promise<string> {
  const { data, error } = await asUser(owner.jwt).rpc('propose_org_owner_transfer', { p_organization_id: orgId, p_to_user_id: toUserId });
  if (error || !data) throw new Error(`propose_org_owner_transfer: ${error?.message}`);
  return data as string;
}

/** 組織の pending の招待を service_role で入れる (create_org_invite の 24 時間の上限に当たらないように) */
async function insertPendingOrgInvite(orgId: string, email: string, invitedBy: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const { error } = await srAdmin.from('organization_invites').insert({
    organization_id: orgId,
    email: email.toLowerCase(),
    token,
    invited_role: 'member',
    status: 'pending',
    expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    invited_by: invitedBy,
  });
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return token;
}

/** オーナー・admin・提案 (オーナー → admin) をそろえる */
async function setupTransfer(label: string): Promise<{ owner: TestUser; admin: TestUser; orgId: string; proposalId: string }> {
  const [owner, admin] = await createUsers(label, 2);
  const orgId = await createOrg(owner, admin, label);
  const proposalId = await proposeOrgTransfer(owner, orgId, admin.id);
  return { owner, admin, orgId, proposalId };
}

interface OrgProfile {
  organization_id: string | null;
  org_role: string | null;
}

async function orgProfile(userId: string): Promise<OrgProfile> {
  const { data, error } = await srAdmin.from('user_profiles').select('organization_id, org_role').eq('id', userId).single();
  if (error || !data) throw new Error(`user_profiles: ${error?.message}`);
  return data as OrgProfile;
}

async function orgRow(orgId: string): Promise<{ status: string; owner_id: string | null } | null> {
  const { data, error } = await srAdmin.from('organizations').select('status, owner_id').eq('id', orgId).maybeSingle();
  if (error) throw new Error(`organizations: ${error.message}`);
  return data as { status: string; owner_id: string | null } | null;
}

async function orgMemberCount(orgId: string): Promise<number> {
  const { count, error } = await srAdmin.from('user_profiles').select('id', { count: 'exact', head: true }).eq('organization_id', orgId);
  if (error) throw new Error(`user_profiles count: ${error.message}`);
  return count ?? 0;
}

async function usedLicenses(orgId: string): Promise<number> {
  const { data, error } = await srAdmin.from('org_license_pools').select('used_licenses').eq('organization_id', orgId).single();
  if (error || !data) throw new Error(`org_license_pools: ${error?.message}`);
  return (data as { used_licenses: number }).used_licenses;
}

/** 退会の所属の解放 (release_user_membership) が残した監査 (member_left・reason account_delete) の数 */
async function accountDeleteLeftAudits(orgId: string, userId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'organization')
    .eq('scope_id', orgId)
    .eq('action', 'member_left')
    .eq('target_user_id', userId)
    .eq('metadata->>reason', 'account_delete');
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

/**
 * 組織の不変条件: active な組織の owner_id の人は、その組織に所属していて、org_role = 'owner' の人はその 1 人だけ。
 * 修正前は、所属の無い人を owner_id が指す組織が残った
 */
async function ownerInvariantProblems(orgId: string): Promise<string[]> {
  const row = await orgRow(orgId);
  if (!row || row.status !== 'active') return [];
  const problems: string[] = [];
  if (!row.owner_id) return ['active なのに owner_id が無い'];
  const owner = await orgProfile(row.owner_id);
  if (owner.organization_id !== orgId) problems.push(`owner_id の人が所属していない: ${JSON.stringify(owner)}`);
  const { data, error } = await srAdmin.from('user_profiles').select('id').eq('organization_id', orgId).eq('org_role', 'owner');
  if (error) throw new Error(`user_profiles owners: ${error.message}`);
  const holders = (data ?? []).map((r) => (r as { id: string }).id);
  if (holders.length !== 1 || holders[0] !== row.owner_id) problems.push(`オーナーの役割の人: ${JSON.stringify(holders)}`);
  return problems;
}

interface Outcome {
  ok: boolean;
  data: unknown;
  message: string | null;
  code: string | null;
}

function toOutcome(data: unknown, error: { message?: string; code?: string } | null): Outcome {
  return { ok: !error, data: error ? null : data, message: error?.message ?? null, code: error?.code ?? null };
}

function isDeadlock(outcome: Outcome): boolean {
  return outcome.code === '40P01' || /deadlock detected/i.test(outcome.message ?? '');
}

/** 退会の本体 (src/lib/account-deletion.ts) と同じく service_role で所属を解放する */
async function releaseMembership(userId: string): Promise<Outcome> {
  const { data, error } = await srAdmin.rpc('release_user_membership', { p_user_id: userId });
  return toOutcome(data, error);
}

async function acceptTransfer(user: TestUser, proposalId: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('accept_org_owner_transfer', { p_proposal_id: proposalId });
  return toOutcome(data, error);
}

async function dissolveOrg(user: TestUser, orgId: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('dissolve_org_by_owner', { p_organization_id: orgId });
  return toOutcome(data, error);
}

async function operatorTransfer(operatorJwt: string, orgId: string, newOwnerId: string): Promise<Outcome> {
  const { data, error } = await asUser(operatorJwt).rpc('operator_force_owner_transfer', {
    p_organization_id: orgId,
    p_new_owner_id: newOwnerId,
    p_reason: 'release-owner-race',
  });
  return toOutcome(data, error);
}

/** RPC が RAISE した P0001 のコード (例外の文がそのコード) */
function expectRaised(outcome: Outcome, code: string): void {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
  expect(outcome.code).toBe('P0001');
  expect(outcome.message).toBe(code);
}

/** 失敗していれば、それが決まった P0001 のコードのどれかであること (23514・40P01 などの生の DB のエラーでない) */
function failedOnlyWith(outcome: Outcome, allowed: readonly string[]): boolean {
  return outcome.ok || (outcome.code === 'P0001' && allowed.includes(outcome.message ?? ''));
}

/** 運営 (super_admin・aal2) */
interface Operator {
  user: TestUser;
  jwt: string;
}
let operatorCache: Operator | null = null;
async function operator(): Promise<Operator> {
  if (operatorCache) return operatorCache;
  const user = await createUser('operator', ['user', 'super_admin']);
  const { client: sessionClient } = await signIn(user.email);
  operatorCache = { user, jwt: await promoteToAal2(sessionClient) };
  return operatorCache;
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (tests/integration/helpers/lock-holder.ts。後から呼んだ処理が行のロックの待ちに
// 並んだのを確かめてから放す。決まった秒数の窓で「並んだはず」と仮定しない。#1917)
// ---------------------------------------------------------------------------------------------

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'release-owner-race' });

const AAL2_CLAIMS = { aal: 'aal2' } as const;

/** 本人 (actor) の JWT のクレームで callSql を呼び、コミット前のまま開いておく */
function holdCall(actor: TestUser, callSql: string, extraClaims: Record<string, string> = {}): Holder {
  return holders.startHolder(callSql, `${actAsAuthenticatedSql(actor.id, extraClaims)}
    SELECT * FROM ${callSql};`);
}

/** 退会の所属の解放 (release_user_membership) をコミット前のまま開いておく (pg/query の権限。service_role と同じく関数を呼べる) */
function holdRelease(userId: string): Holder {
  return holders.startHolder('所属の解放 (release_user_membership)', `SELECT public.release_user_membership('${userId}'::uuid);`);
}

/**
 * 組織の行だけを FOR NO KEY UPDATE で持つ接続 (pg/query の権限。user_profiles の行は 1 つも持たない)。そのあいだに所属の解放を
 * 組織の行の待ちに並ばせ、脱退と別の組織の招待の承諾を済ませてから放す
 */
function holdOrgRow(orgId: string): Holder {
  return holders.startHolder('組織の行を持つ接続', `SELECT 1 FROM public.organizations WHERE id = '${orgId}'::uuid FOR NO KEY UPDATE;`);
}

// テストが途中で落ちたときに残った接続を、作った順に放す (通ったテストでは全部放し終わっているので何もしない)
afterEach(() => holders.releaseOpenHolders(), RACE_TIMEOUT_MS);

afterAll(async () => {
  await holders.settle();
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin.from('ownership_transfer_proposals').delete().in('from_user_id', createdUserIds);
    await srAdmin.from('user_profiles').update({ organization_id: null, org_role: null, is_active_in_org: false }).in('id', createdUserIds);
  }
  if (createdOrgIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdOrgIds);
    await srAdmin.from('organization_invites').delete().in('organization_id', createdOrgIds);
    await srAdmin.from('org_license_pools').delete().in('organization_id', createdOrgIds);
    // organizations.owner_id は ON DELETE RESTRICT なので、利用者より先に組織を消す
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, RACE_TIMEOUT_MS);

// ---------------------------------------------------------------------------------------------
// 順番に呼ぶ (所属の解放の判定)
// ---------------------------------------------------------------------------------------------

describe('release_user_membership: 組織のオーナーの所属は外さない', () => {
  it('RM-5: オーナー本人の所属の解放は IS_ORG_OWNER。所属・席数・監査は変わらない', async () => {
    const [owner, admin] = await createUsers('rm5', 2);
    const orgId = await createOrg(owner, admin, 'rm5');

    expectRaised(await releaseMembership(owner.id), 'IS_ORG_OWNER');

    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: owner.id });
    expect(await orgProfile(owner.id)).toMatchObject({ organization_id: orgId, org_role: 'owner' });
    expect(await usedLicenses(orgId)).toBe(SEEDED_USED_LICENSES);
    expect(await accountDeleteLeftAudits(orgId, owner.id)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('RM-6: オーナーでないメンバーの所属は従来どおり外れ、席数が 1 減り、監査 member_left (account_delete) が 1 件。もう一度呼んでも何も変わらない (冪等)', async () => {
    const [owner, admin] = await createUsers('rm6', 2);
    const orgId = await createOrg(owner, admin, 'rm6');

    const first = await releaseMembership(admin.id);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await usedLicenses(orgId)).toBe(SEEDED_USED_LICENSES - ONE_SEAT);
    expect(await accountDeleteLeftAudits(orgId, admin.id)).toBe(1);

    const second = await releaseMembership(admin.id);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(await usedLicenses(orgId)).toBe(SEEDED_USED_LICENSES - ONE_SEAT);
    expect(await accountDeleteLeftAudits(orgId, admin.id)).toBe(1);
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: owner.id });
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 譲渡 (承諾・運営の強制譲渡) をコミット前のまま開いている間の所属の解放 (修正前は所属が外れた)
// ---------------------------------------------------------------------------------------------

describe('譲渡と所属の解放が同時に走っても、所属の無い人を owner_id が指す組織が残らない', () => {
  it('RM-1: 譲渡の承諾をコミット前のまま開いている間に承諾者の所属を解放すると、解放は承諾の commit を待ってから IS_ORG_OWNER (修正前は所属が外れ、owner_id が所属の無い人を指した)', async () => {
    const { owner, admin, orgId, proposalId } = await setupTransfer('rm1');

    const holder = holdCall(admin, `public.accept_org_owner_transfer('${proposalId}'::uuid)`);
    const [held, released] = await holders.runBehindHolder(holder, {
      fn: 'release_user_membership',
      call: () => releaseMembership(admin.id),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(released, 'IS_ORG_OWNER');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: admin.id });
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: orgId, org_role: 'owner' });
    expect(await orgProfile(owner.id)).toMatchObject({ organization_id: orgId, org_role: 'admin' });
    expect(await usedLicenses(orgId)).toBe(SEEDED_USED_LICENSES);
    expect(await accountDeleteLeftAudits(orgId, admin.id)).toBe(0);
    expect(await ownerInvariantProblems(orgId)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('RM-2: 運営の強制譲渡をコミット前のまま開いている間に新しいオーナーの所属を解放すると、解放は強制譲渡の commit を待ってから IS_ORG_OWNER (修正前は所属が外れた)', async () => {
    const op = await operator();
    const [owner, admin, member] = await createUsers('rm2', 3);
    const orgId = await createOrg(owner, admin, 'rm2');
    await setOrgMembership(member, orgId, 'member');

    const holder = holdCall(op.user, `public.operator_force_owner_transfer('${orgId}'::uuid, '${member.id}'::uuid, 'rm2')`, AAL2_CLAIMS);
    const [held, released] = await holders.runBehindHolder(holder, {
      fn: 'release_user_membership',
      call: () => releaseMembership(member.id),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(released, 'IS_ORG_OWNER');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: member.id });
    expect(await orgProfile(member.id)).toMatchObject({ organization_id: orgId, org_role: 'owner' });
    expect(await ownerInvariantProblems(orgId)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('RM-3: 承諾者の所属の解放をコミット前のまま開いている間に承諾すると、承諾は解放の commit を待ってから TRANSFER_ACCEPTOR_NOT_IN_ORG (23514 にならない)。オーナーは元のまま', async () => {
    const { owner, admin, orgId, proposalId } = await setupTransfer('rm3');

    const holder = holdRelease(admin.id);
    const [held, accept] = await holders.runBehindHolder(holder, {
      fn: 'accept_org_owner_transfer',
      call: () => acceptTransfer(admin, proposalId),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(accept.code, JSON.stringify(accept)).not.toBe(PG_CHECK_VIOLATION);
    expectRaised(accept, 'TRANSFER_ACCEPTOR_NOT_IN_ORG');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: owner.id });
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await usedLicenses(orgId)).toBe(SEEDED_USED_LICENSES - ONE_SEAT);
    expect(await ownerInvariantProblems(orgId)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('RM-4: 所属の解放をコミット前のまま開いている間に運営がその人へ強制譲渡すると、強制譲渡は解放の commit を待ってから TARGET_NOT_IN_ORG (23514 にならない)', async () => {
    const op = await operator();
    const [owner, admin, member] = await createUsers('rm4', 3);
    const orgId = await createOrg(owner, admin, 'rm4');
    await setOrgMembership(member, orgId, 'member');

    const holder = holdRelease(member.id);
    const [held, forced] = await holders.runBehindHolder(holder, {
      fn: 'operator_force_owner_transfer',
      call: () => operatorTransfer(op.jwt, orgId, member.id),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(forced.code, JSON.stringify(forced)).not.toBe(PG_CHECK_VIOLATION);
    expectRaised(forced, 'TARGET_NOT_IN_ORG');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: owner.id });
    expect(await orgProfile(member.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await ownerInvariantProblems(orgId)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('RM-8: 承諾者の所属の解放と譲渡の承諾を本物の経路で 8 回ずつ同時に呼んでも、デッドロック・23514 にならず、どちらか一方だけが通り、所属の無い人を owner_id が指す組織が残らない', async () => {
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const { owner, admin, orgId, proposalId } = await setupTransfer(`rm8-${i}`);

      const [released, accept] = await Promise.all([releaseMembership(admin.id), acceptTransfer(admin, proposalId)]);

      if (isDeadlock(released) || isDeadlock(accept)) problems.push(`#${i} デッドロック: ${JSON.stringify({ released, accept })}`);
      if (!failedOnlyWith(released, ['IS_ORG_OWNER'])) problems.push(`#${i} 解放が決まったエラー以外で失敗: ${JSON.stringify(released)}`);
      if (!failedOnlyWith(accept, ['TRANSFER_ACCEPTOR_NOT_IN_ORG'])) problems.push(`#${i} 承諾が決まったエラー以外で失敗: ${JSON.stringify(accept)}`);
      if (released.ok === accept.ok) problems.push(`#${i} どちらか一方だけが通るはず: ${JSON.stringify({ released, accept })}`);
      const row = await orgRow(orgId);
      const expectedOwner = accept.ok ? admin.id : owner.id;
      if (row?.status !== 'active' || row.owner_id !== expectedOwner) problems.push(`#${i} オーナーが違う: ${JSON.stringify({ row, released, accept })}`);
      problems.push(...(await ownerInvariantProblems(orgId)).map((p) => `#${i} ${p}`));
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('RM-9: 所属の解放と運営の強制譲渡 (その人へ) を本物の経路で 8 回ずつ同時に呼んでも、デッドロック・23514 にならず、どちらか一方だけが通り、所属の無い人を owner_id が指す組織が残らない', async () => {
    const op = await operator();
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [owner, admin] = await createUsers(`rm9-${i}`, 2);
      const orgId = await createOrg(owner, admin, `rm9-${i}`);

      const [released, forced] = await Promise.all([releaseMembership(admin.id), operatorTransfer(op.jwt, orgId, admin.id)]);

      if (isDeadlock(released) || isDeadlock(forced)) problems.push(`#${i} デッドロック: ${JSON.stringify({ released, forced })}`);
      if (!failedOnlyWith(released, ['IS_ORG_OWNER'])) problems.push(`#${i} 解放が決まったエラー以外で失敗: ${JSON.stringify(released)}`);
      if (!failedOnlyWith(forced, ['TARGET_NOT_IN_ORG'])) problems.push(`#${i} 強制譲渡が決まったエラー以外で失敗: ${JSON.stringify(forced)}`);
      if (released.ok === forced.ok) problems.push(`#${i} どちらか一方だけが通るはず: ${JSON.stringify({ released, forced })}`);
      problems.push(...(await ownerInvariantProblems(orgId)).map((p) => `#${i} ${p}`));
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 所属が途中で変わったとき (ロックの外で読んだ組織と、ロックの下で読み直した組織が違う)
// ---------------------------------------------------------------------------------------------

describe('所属の解放が組織の行を待つ間に所属が変わっても、ロックの下で読み直した所属で判定する', () => {
  it('RM-10: オーナーの解散をコミット前のまま開いている間にメンバーの所属を解放すると、解放は解散の commit を待ってから所属が無いのを読み、何もせずに通る (席数を二重に減らさない)', async () => {
    const [owner, admin] = await createUsers('rm10', 2);
    const orgId = await createOrg(owner, admin, 'rm10');

    const holder = holdCall(owner, `public.dissolve_org_by_owner('${orgId}'::uuid)`);
    const [held, released] = await holders.runBehindHolder(holder, {
      fn: 'release_user_membership',
      call: () => releaseMembership(admin.id),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(released.ok, JSON.stringify(released)).toBe(true);
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await usedLicenses(orgId)).toBe(0);
    expect(await accountDeleteLeftAudits(orgId, admin.id)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('RM-12: 解放が組織 A の行を待つ間に、本人が A を脱退して別の組織 B の招待を承諾すると、解放は CONFLICT_RETRY で止まり、B の所属を外さない (B の行を取っていないので)', async () => {
    const [ownerA, adminA, ownerB, adminB, mover] = await createUsers('rm12', 5);
    const orgA = await createOrg(ownerA, adminA, 'rm12-a');
    const orgB = await createOrg(ownerB, adminB, 'rm12-b');
    await setOrgMembership(mover, orgA, 'member');
    const token = await insertPendingOrgInvite(orgB, mover.email, ownerB.id);

    const holder = holdOrgRow(orgA);
    await holder.sleeping;
    const releaseDone = releaseMembership(mover.id);
    await holders.waitForLockWaiters('release_user_membership', 1, { step: '所属の解放が組織 A の行の手前に並ぶ', blockedBy: holder });

    const { data: leftData, error: leftError } = await asUser(mover.jwt).rpc('leave_org');
    const left = toOutcome(leftData, leftError);
    expect(left.ok, JSON.stringify(left)).toBe(true);
    const { data: acceptedData, error: acceptedError } = await asUser(mover.jwt).rpc('accept_org_invite', { p_token: token });
    const accepted = toOutcome(acceptedData, acceptedError);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(holder.finished(), '脱退と招待の承諾が済む前に、組織 A の行を持つ接続が終わりました').toBe(false);
    // 脱退と招待の承諾が済んだのを確かめてから組織 A の行を放す (放す前に接続が終わっていれば release() が失敗する)
    await holder.release();

    const [held, released] = await Promise.all([holder.done, releaseDone]);
    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(released, 'CONFLICT_RETRY');
    expect(await orgProfile(mover.id)).toMatchObject({ organization_id: orgB, org_role: 'member' });
    expect(await accountDeleteLeftAudits(orgB, mover.id)).toBe(0);
    expect(await accountDeleteLeftAudits(orgA, mover.id)).toBe(0);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// すでに残っている「所属の無い人を owner_id が指す組織」への運営の強制譲渡 (修正前は 23514)
// ---------------------------------------------------------------------------------------------

describe('運営の強制譲渡は、所属の外れた旧オーナーの行に org_role を書かない', () => {
  it('RM-7: owner_id が所属の無い人を指す組織に強制譲渡すると、23514 にならずに通り、新しいオーナーに立て直せる。旧オーナーの行は変わらない', async () => {
    const op = await operator();
    const [owner, admin] = await createUsers('rm7', 2);
    const orgId = await createOrg(owner, admin, 'rm7');
    // 修正前の欠陥で残りうる状態を作る (owner_id は owner のまま、owner の所属だけが外れている)
    const { error } = await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, joined_org_at: null, roles: ['user'] })
      .eq('id', owner.id);
    if (error) throw new Error(`orphan owner: ${error.message}`);
    expect(await ownerInvariantProblems(orgId)).not.toEqual([]);

    const forced = await operatorTransfer(op.jwt, orgId, admin.id);

    expect(forced.code, JSON.stringify(forced)).not.toBe(PG_CHECK_VIOLATION);
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: admin.id });
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: orgId, org_role: 'owner' });
    expect(await orgProfile(owner.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await ownerInvariantProblems(orgId)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('RM-11: 旧オーナーが在籍している組織への強制譲渡は従来どおり (旧オーナーは admin・新しいオーナーは owner)', async () => {
    const op = await operator();
    const [owner, admin] = await createUsers('rm11', 2);
    const orgId = await createOrg(owner, admin, 'rm11');

    const forced = await operatorTransfer(op.jwt, orgId, admin.id);

    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(await orgProfile(owner.id)).toMatchObject({ organization_id: orgId, org_role: 'admin' });
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: orgId, org_role: 'owner' });
    expect(await ownerInvariantProblems(orgId)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 関数の属性・権限 (CREATE OR REPLACE で変えていない)
// ---------------------------------------------------------------------------------------------

describe('関数の属性と権限は変えていない', () => {
  it('RM-13: release_user_membership は SECURITY DEFINER・search_path=public のまま、service_role だけが呼べる。operator_force_owner_transfer は authenticated が呼べ anon は呼べない', async () => {
    const rows = await pgQuery<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      anon_exec: boolean;
      auth_exec: boolean;
      service_exec: boolean;
    }>(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('operator_force_owner_transfer', 'release_user_membership')
       ORDER BY p.proname`);
    expect(rows.map((r) => r.proname)).toEqual(['operator_force_owner_transfer', 'release_user_membership']);
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.proconfig ?? [], row.proname).toContain('search_path=public');
      expect(row.anon_exec, row.proname).toBe(false);
      expect(row.service_exec, row.proname).toBe(true);
    }
    expect(rows.find((r) => r.proname === 'release_user_membership')?.auth_exec).toBe(false);
    expect(rows.find((r) => r.proname === 'operator_force_owner_transfer')?.auth_exec).toBe(true);
  }, TEST_TIMEOUT_MS);
});
