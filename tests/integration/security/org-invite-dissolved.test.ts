/**
 * Q-4 (docs/design/family/11-self-dissolve.md の Q-4・S-22・S-30): 解散した組織の招待を承諾できる欠陥の回帰テスト (実 DB)
 *
 * 修正前 (accept_org_invite の最新の定義は 20261017160000_org_invite_same_org_member.sql):
 *   - accept_org_invite は organizations.status を読まず、組織の行もロックしなかった。解散した組織の pending の招待を承諾すると、
 *     解散した組織に所属したまま残り、席数も +1 された。
 *   - 解散と承諾が同時に走ると、解散の後始末の UPDATE (所属を外す) は承諾の commit 前の版を見て承諾した人を外さず、
 *     承諾が後から commit して、解散した組織に所属が残った (オーナーの解散・運営の強制解散のどちらでも)。
 *
 * 修正後 (supabase/migrations/20261022100000_org_invite_dissolved.sql):
 *   - accept_org_invite は招待の組織の行を FOR NO KEY UPDATE で取り、active でなければ ORG_ALREADY_DISSOLVED。
 *     招待は pending のまま・所属・席数・監査ログは変わらない。
 *   - 解散 (dissolve_org_by_owner / operator_force_dissolve_org) は後始末の前に組織の行を取るので、承諾と組織の行で直列になる。
 *     承諾が先なら解散がその人の所属も外し、解散が先なら承諾は ORG_ALREADY_DISSOLVED。どの順でもデッドロックしない。
 *
 * 呼び出しは本物の経路 (PostgREST + 本人の JWT)。先の処理をコミット前のまま開いておくのは、ローカルスタックの
 * postgres-meta (/pg/query、service_role キーが必要) を使う (family-lock-order-race.test.ts・self-dissolve.test.ts と同じ道具)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-invite-dissolved.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';
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

/** Kong → PostgREST の使い回しの接続の 502 (リクエストが PostgREST に届いていない) を数回だけやり直す (self-dissolve.test.ts と同じ) */
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

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
/** 成人の生年月日 */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 組織の席数 (テストで足りる数。席数の上限で断られる経路と混ざらないように) */
const ORG_TOTAL_LICENSES = 20;
/** 組織にすでにいるメンバーの数として置く席数 (解散で 0 になること・承諾で +1 されないことを見る) */
const SEEDED_USED_LICENSES = 1;
/** 招待のトークンのバイト数 (hex で 64 文字。create_org_invite と同じ形) */
const TOKEN_BYTES = 32;
/** 招待の期限 (14 日。create_org_invite と同じ) */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** 本物の経路で同時に呼ぶ回数 (self-dissolve.test.ts の D-15 と同じ) */
const ITERATIONS = 8;
/** 先の処理をコミット前のまま開いておく秒数 */
const HOLD_SECONDS = 3;
/** pg_sleep に入るのを待つ上限 (ミリ秒) と確かめる間隔 */
const HOLDER_DEADLINE_MS = 20_000;
const HOLDER_POLL_MS = 50;
const TEST_TIMEOUT_MS = 120_000;
const RACE_TIMEOUT_MS = 240_000;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const pendingHolders: Array<Promise<unknown>> = [];

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-org-invite-dissolved-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `org-invite-dissolved-${label}`,
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

/** 組織を作り、オーナーを owner として所属させ、席数を SEEDED_USED_LICENSES にする */
async function createOrg(owner: TestUser, label: string): Promise<string> {
  const { data, error } = await srAdmin.from('organizations').insert({ name: `Q-4 ${label} ${TS}`, owner_id: owner.id }).select('id').single();
  if (error || !data) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = data.id as string;
  createdOrgIds.push(orgId);
  const { error: poolError } = await retryIdempotentSetup(srAdmin, 'createOrg: org_license_pools の upsert', (db) =>
    db.from('org_license_pools').upsert(
      { organization_id: orgId, total_licenses: ORG_TOTAL_LICENSES, used_licenses: SEEDED_USED_LICENSES },
      { onConflict: 'organization_id' },
    ));
  if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  const { error: memberError } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: 'owner', is_active_in_org: true, joined_org_at: new Date().toISOString() })
    .eq('id', owner.id);
  if (memberError) throw new Error(`membership: ${memberError.message}`);
  return orgId;
}

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

interface OrgProfile {
  organization_id: string | null;
  org_role: string | null;
  is_active_in_org: boolean | null;
}

async function orgProfile(userId: string): Promise<OrgProfile> {
  const { data, error } = await srAdmin.from('user_profiles').select('organization_id, org_role, is_active_in_org').eq('id', userId).single();
  if (error || !data) throw new Error(`user_profiles: ${error?.message}`);
  return data as OrgProfile;
}

async function orgRow(orgId: string): Promise<{ status: string; owner_id: string | null } | null> {
  const { data, error } = await srAdmin.from('organizations').select('status, owner_id').eq('id', orgId).maybeSingle();
  if (error) throw new Error(`organizations: ${error.message}`);
  return data as { status: string; owner_id: string | null } | null;
}

async function usedLicenses(orgId: string): Promise<number> {
  const { data, error } = await srAdmin.from('org_license_pools').select('used_licenses').eq('organization_id', orgId).single();
  if (error || !data) throw new Error(`org_license_pools: ${error?.message}`);
  return (data as { used_licenses: number }).used_licenses;
}

async function orgMemberCount(orgId: string): Promise<number> {
  const { count, error } = await srAdmin.from('user_profiles').select('id', { count: 'exact', head: true }).eq('organization_id', orgId);
  if (error) throw new Error(`user_profiles count: ${error.message}`);
  return count ?? 0;
}

async function inviteStatus(token: string): Promise<string> {
  const { data, error } = await srAdmin.from('organization_invites').select('status').eq('token', token).single();
  if (error || !data) throw new Error(`organization_invites: ${error?.message}`);
  return (data as { status: string }).status;
}

async function inviteAcceptedAudits(orgId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'organization')
    .eq('scope_id', orgId)
    .eq('action', 'invite_accepted');
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
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
  return outcome.code === '40P01' || /deadlock detected|CONFLICT_RETRY/i.test(outcome.message ?? '');
}

async function acceptInvite(user: TestUser, token: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('accept_org_invite', { p_token: token });
  return toOutcome(data, error);
}

async function dissolveOrg(user: TestUser, orgId: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('dissolve_org_by_owner', { p_organization_id: orgId });
  return toOutcome(data, error);
}

async function operatorDissolveOrg(operatorJwt: string, orgId: string): Promise<Outcome> {
  const { data, error } = await asUser(operatorJwt).rpc('operator_force_dissolve_org', { p_organization_id: orgId, p_reason: 'Q-4' });
  return toOutcome(data, error);
}

/** RPC が RAISE した P0001 のコード (例外の文がそのコード) */
function expectRaised(outcome: Outcome, code: string): void {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
  expect(outcome.code).toBe('P0001');
  expect(outcome.message).toBe(code);
}

/** 運営 (super_admin・aal2) の JWT。運営の強制解散は aal2 のセッションでしか通らない (#1176) */
let operatorJwtCache: string | null = null;
async function operatorJwt(): Promise<string> {
  if (operatorJwtCache) return operatorJwtCache;
  const operator = await createUser('operator', ['user', 'super_admin']);
  const { client: sessionClient } = await signIn(operator.email);
  operatorJwtCache = await promoteToAal2(sessionClient);
  return operatorJwtCache;
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (self-dissolve.test.ts と同じ形)
// ---------------------------------------------------------------------------------------------

interface Holder {
  sleeping: Promise<void>;
  done: Promise<Outcome>;
}

function holdCall(actor: TestUser, callSql: string): Holder {
  const marker = `org-invite-dissolved-holder-${randomBytes(6).toString('hex')}`;
  const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' });
  const sql = `/* ${marker} */
    SELECT set_config('request.jwt.claims', '${claims}', true);
    SET LOCAL ROLE authenticated;
    SELECT * FROM ${callSql};
    SELECT pg_sleep(${HOLD_SECONDS});
    SELECT 'held' AS result;`;

  const state: { outcome: Outcome | null } = { outcome: null };
  const done = pgRequest(sql).then((res): Outcome => {
    const body = res.body as { error?: unknown; code?: unknown } | null;
    const outcome: Outcome = res.ok
      ? { ok: true, data: null, message: null, code: null }
      : {
          ok: false,
          data: null,
          message: typeof body?.error === 'string' ? body.error : JSON.stringify(body),
          code: typeof body?.code === 'string' ? body.code : null,
        };
    state.outcome = outcome;
    return outcome;
  });
  pendingHolders.push(done);

  const sleeping = (async () => {
    const deadline = Date.now() + HOLDER_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (state.outcome) throw new Error(`先に呼んだ接続が pg_sleep に入る前に終わりました: ${JSON.stringify(state.outcome)}`);
      const rows = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      if (rows[0]?.n === 1) return;
      await sleep(HOLDER_POLL_MS);
    }
    throw new Error('先に呼んだ接続が pg_sleep に入りませんでした (遅すぎます)');
  })();

  return { sleeping, done };
}

afterAll(async () => {
  await Promise.allSettled(pendingHolders);
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
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
// 解散した組織の招待の承諾
// ---------------------------------------------------------------------------------------------

describe('Q-4 解散した組織の招待は承諾できない (accept_org_invite)', () => {
  it('Q4-1: オーナーが解散した組織の pending の招待を承諾すると ORG_ALREADY_DISSOLVED。所属・席数・招待 (pending のまま)・監査ログは変わらない', async () => {
    const [owner, invitee] = await createUsers('q4-1', 2);
    const orgId = await createOrg(owner, 'q4-1');
    const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);
    expect((await dissolveOrg(owner, orgId)).ok).toBe(true);
    expect(await usedLicenses(orgId)).toBe(0);

    expectRaised(await acceptInvite(invitee, token), 'ORG_ALREADY_DISSOLVED');

    expect(await orgProfile(invitee.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await usedLicenses(orgId)).toBe(0);
    expect(await inviteStatus(token)).toBe('pending');
    expect(await inviteAcceptedAudits(orgId)).toBe(0);

    // 断られた招待は、本人が拒否できる (pending のまま残る招待の出口)
    const rejected = await asUser(invitee.jwt).rpc('reject_org_invite', { p_token: token });
    expect(rejected.error, JSON.stringify(rejected.error)).toBeNull();
    expect(await inviteStatus(token)).toBe('rejected');
  }, TEST_TIMEOUT_MS);

  it('Q4-2: 運営が強制解散した組織の pending の招待も ORG_ALREADY_DISSOLVED で、所属は作られない', async () => {
    const jwt = await operatorJwt();
    const [owner, invitee] = await createUsers('q4-2', 2);
    const orgId = await createOrg(owner, 'q4-2');
    const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);
    const dissolved = await operatorDissolveOrg(jwt, orgId);
    expect(dissolved.ok, JSON.stringify(dissolved)).toBe(true);

    expectRaised(await acceptInvite(invitee, token), 'ORG_ALREADY_DISSOLVED');

    expect(await orgProfile(invitee.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await inviteStatus(token)).toBe('pending');
  }, TEST_TIMEOUT_MS);

  it('Q4-3: 招待の判定 (期限切れ・宛先の不一致) は、組織の判定より先に返る (これまでのエラーの順番のまま)', async () => {
    const [owner, invitee, stranger] = await createUsers('q4-3', 3);
    const orgId = await createOrg(owner, 'q4-3');
    const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);
    expect((await dissolveOrg(owner, orgId)).ok).toBe(true);

    expectRaised(await acceptInvite(stranger, token), 'INVITE_EMAIL_MISMATCH');
    const { error } = await srAdmin.from('organization_invites').update({ expires_at: new Date(Date.now() - INVITE_TTL_MS).toISOString() }).eq('token', token);
    expect(error).toBeNull();
    expectRaised(await acceptInvite(invitee, token), 'INVITE_EXPIRED');
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 解散と承諾の同時の実行
// ---------------------------------------------------------------------------------------------

describe('Q-4 解散と招待の承諾が同時に走っても、解散した組織に所属が残らない', () => {
  it('Q4-4: 承諾をコミット前のまま開いている間にオーナーが解散すると、解散は承諾の commit を待ち、承諾した人の所属も外す (member_user_ids に入る)', async () => {
    const [owner, invitee] = await createUsers('q4-4', 2);
    const orgId = await createOrg(owner, 'q4-4');
    const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);

    const holder = holdCall(invitee, `public.accept_org_invite('${token}')`);
    await holder.sleeping;
    const dissolve = await dissolveOrg(owner, orgId);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(dissolve.ok, JSON.stringify(dissolve)).toBe(true);
    expect((dissolve.data as { member_user_ids: string[] }).member_user_ids).toContain(invitee.id);
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgProfile(invitee.id)).toMatchObject({ organization_id: null, org_role: null, is_active_in_org: false });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await usedLicenses(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('Q4-5: オーナーの解散をコミット前のまま開いている間に承諾すると、承諾は解散の commit を待ってから ORG_ALREADY_DISSOLVED', async () => {
    const [owner, invitee] = await createUsers('q4-5', 2);
    const orgId = await createOrg(owner, 'q4-5');
    const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);

    const holder = holdCall(owner, `public.dissolve_org_by_owner('${orgId}'::uuid)`);
    await holder.sleeping;
    const accept = await acceptInvite(invitee, token);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(accept, 'ORG_ALREADY_DISSOLVED');
    expect(await orgProfile(invitee.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await usedLicenses(orgId)).toBe(0);
    expect(await inviteStatus(token)).toBe('pending');
  }, TEST_TIMEOUT_MS);

  it('Q4-6: 承諾をコミット前のまま開いている間に運営が強制解散しても、デッドロックせず、承諾した人の所属も外れる', async () => {
    const jwt = await operatorJwt();
    const [owner, invitee] = await createUsers('q4-6', 2);
    const orgId = await createOrg(owner, 'q4-6');
    const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);

    const holder = holdCall(invitee, `public.accept_org_invite('${token}')`);
    await holder.sleeping;
    const dissolve = await operatorDissolveOrg(jwt, orgId);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(dissolve.ok, JSON.stringify(dissolve)).toBe(true);
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgProfile(invitee.id)).toMatchObject({ organization_id: null, org_role: null, is_active_in_org: false });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await usedLicenses(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('Q4-7: オーナーの解散と承諾を本物の経路で 8 回ずつ同時に呼んでも、デッドロックせず、終わったあとは解散した組織に所属 0 人・席数 0', async () => {
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [owner, invitee] = await createUsers(`q4-7-${i}`, 2);
      const orgId = await createOrg(owner, `q4-7-${i}`);
      const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);

      const [dissolve, accept] = await Promise.all([dissolveOrg(owner, orgId), acceptInvite(invitee, token)]);

      if (isDeadlock(dissolve) || isDeadlock(accept)) problems.push(`#${i} デッドロック: ${JSON.stringify({ dissolve, accept })}`);
      if (!dissolve.ok) problems.push(`#${i} 解散が失敗: ${JSON.stringify(dissolve)}`);
      if (!accept.ok && accept.message !== 'ORG_ALREADY_DISSOLVED') problems.push(`#${i} 承諾が ORG_ALREADY_DISSOLVED 以外で失敗: ${JSON.stringify(accept)}`);
      const row = await orgRow(orgId);
      const members = await orgMemberCount(orgId);
      const used = await usedLicenses(orgId);
      const invitee_ = await orgProfile(invitee.id);
      if (row?.status !== 'dissolved' || members !== 0 || used !== 0 || invitee_.organization_id !== null) {
        problems.push(`#${i} 解散した組織に所属・席数が残った: ${JSON.stringify({ row, members, used, invitee: invitee_, dissolve, accept })}`);
      }
      if (accept.ok && !(dissolve.data as { member_user_ids?: string[] } | null)?.member_user_ids?.includes(invitee.id)) {
        problems.push(`#${i} 承諾が先なのに解散の宛先に入っていない: ${JSON.stringify({ dissolve, accept })}`);
      }
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('Q4-8: 運営の強制解散と承諾を本物の経路で 8 回ずつ同時に呼んでも、デッドロックせず、終わったあとは解散した組織に所属 0 人・席数 0', async () => {
    const jwt = await operatorJwt();
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [owner, invitee] = await createUsers(`q4-8-${i}`, 2);
      const orgId = await createOrg(owner, `q4-8-${i}`);
      const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);

      const [dissolve, accept] = await Promise.all([operatorDissolveOrg(jwt, orgId), acceptInvite(invitee, token)]);

      if (isDeadlock(dissolve) || isDeadlock(accept)) problems.push(`#${i} デッドロック: ${JSON.stringify({ dissolve, accept })}`);
      if (!dissolve.ok) problems.push(`#${i} 強制解散が失敗: ${JSON.stringify(dissolve)}`);
      if (!accept.ok && accept.message !== 'ORG_ALREADY_DISSOLVED') problems.push(`#${i} 承諾が ORG_ALREADY_DISSOLVED 以外で失敗: ${JSON.stringify(accept)}`);
      const row = await orgRow(orgId);
      const members = await orgMemberCount(orgId);
      const used = await usedLicenses(orgId);
      const invitee_ = await orgProfile(invitee.id);
      if (row?.status !== 'dissolved' || members !== 0 || used !== 0 || invitee_.organization_id !== null) {
        problems.push(`#${i} 解散した組織に所属・席数が残った: ${JSON.stringify({ row, members, used, invitee: invitee_, dissolve, accept })}`);
      }
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('Q4-9: 運営の強制解散とオーナーの譲渡の承諾を同時に 8 回呼んでも、デッドロックせず、強制解散は成功し、終わったあとは「dissolved で所属 0 人」(強制解散はオーナーの行を取り直して直列になる)', async () => {
    const jwt = await operatorJwt();
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [owner, admin] = await createUsers(`q4-9-${i}`, 2);
      const orgId = await createOrg(owner, `q4-9-${i}`);
      const { error: adminError } = await srAdmin
        .from('user_profiles')
        .update({ organization_id: orgId, org_role: 'admin', is_active_in_org: true, roles: ['user', 'org_admin'] })
        .eq('id', admin.id);
      if (adminError) throw new Error(`admin membership: ${adminError.message}`);
      const { data: proposalId, error: proposeError } = await asUser(owner.jwt).rpc('propose_org_owner_transfer', {
        p_organization_id: orgId,
        p_to_user_id: admin.id,
      });
      if (proposeError || !proposalId) throw new Error(`propose_org_owner_transfer: ${proposeError?.message}`);

      const [dissolve, accept] = await Promise.all([
        operatorDissolveOrg(jwt, orgId),
        asUser(admin.jwt).rpc('accept_org_owner_transfer', { p_proposal_id: proposalId }).then(({ data, error }) => toOutcome(data, error)),
      ]);

      if (isDeadlock(dissolve) || isDeadlock(accept)) problems.push(`#${i} デッドロック: ${JSON.stringify({ dissolve, accept })}`);
      if (!dissolve.ok) problems.push(`#${i} 強制解散が失敗: ${JSON.stringify(dissolve)}`);
      // 承諾はオーナーの行 → 組織の行をロックしてから判定し直すので (20261022110000_org_transfer_toctou.sql)、強制解散が先なら
      // ORG_ALREADY_DISSOLVED で止まる (修正前は CHECK user_profiles_org_consistency (23514) で止まることがあった)
      if (!accept.ok && !(accept.code === 'P0001' && accept.message === 'ORG_ALREADY_DISSOLVED')) {
        problems.push(`#${i} 承諾が ORG_ALREADY_DISSOLVED 以外で失敗: ${JSON.stringify(accept)}`);
      }
      const row = await orgRow(orgId);
      const members = await orgMemberCount(orgId);
      if (row?.status !== 'dissolved' || row.owner_id !== null || members !== 0) {
        problems.push(`#${i} 中間の状態: ${JSON.stringify({ row, members, dissolve, accept })}`);
      }
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 関数の属性・権限 (CREATE OR REPLACE で変えていない)
// ---------------------------------------------------------------------------------------------

describe('Q-4 関数の属性と権限は変えていない', () => {
  it('Q4-10: accept_org_invite / operator_force_dissolve_org は SECURITY DEFINER・search_path=public のまま、anon は呼べない (42501)', async () => {
    const rows = await pgQuery<{ proname: string; prosecdef: boolean; proconfig: string[] | null; anon_exec: boolean; auth_exec: boolean }>(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('accept_org_invite', 'operator_force_dissolve_org')
       ORDER BY p.proname`);
    expect(rows.map((r) => r.proname)).toEqual(['accept_org_invite', 'operator_force_dissolve_org']);
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.proconfig ?? [], row.proname).toContain('search_path=public');
      expect(row.anon_exec, row.proname).toBe(false);
      expect(row.auth_exec, row.proname).toBe(true);
    }
    const anonAccept = await anon().rpc('accept_org_invite', { p_token: 'x' });
    expect(anonAccept.error?.code).toBe('42501');
  }, TEST_TIMEOUT_MS);
});
