/**
 * #1917 家族の代表者・組織のオーナーが自分で家族グループ・組織を解散する RPC (migration 20261019120000_self_dissolve.sql) を、
 * 本物の DB (ローカルの Supabase) で確かめる (設計書 docs/design/family/11-self-dissolve.md §21.2 の D-1〜D-16)。
 *
 * 呼び出しは本物の経路 (PostgREST + 本人の JWT)。競合の再現 (先の処理をコミット前のまま開いておく) とカタログの確認は、
 * ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う (family-lock-order-race.test.ts と同じ道具)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/self-dissolve.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';
import { PARENTAL_CONSENT_DOCUMENT, todayLocal } from '@homegohan/shared';
import { deleteAccount } from '../../../src/lib/account-deletion';
import { grantFamilyPlan } from '../helpers/family-plan';
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

/** Kong → PostgREST の使い回しの接続の 502 (リクエストが PostgREST に届いていない) を数回だけやり直す (family-lock-order-race.test.ts と同じ) */
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
/** 成人の生年月日 (譲渡の承諾は 18 歳以上。#1173) */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 保護者の同意が要る子供の年齢 (歳) */
const CHILD_AGE_YEARS = 8;
const SIGNED_NAME = 'テスト 保護者';
/** 組織の席数 (テストで足りる数) */
const ORG_TOTAL_LICENSES = 20;
/** 招待のトークンのバイト数 (hex で 64 文字。create_*_invite と同じ形) */
const TOKEN_BYTES = 32;
/** 招待の期限 (14 日) */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** 本物の経路で同時に呼ぶ回数 (設計 §21.2 D-8・D-9・D-15) */
const ITERATIONS = 8;
/** 先の処理をコミット前のまま開いておく秒数 */
const HOLD_SECONDS = 3;
/** pg_sleep に入るのを待つ上限 (ミリ秒) と確かめる間隔 */
const HOLDER_DEADLINE_MS = 20_000;
const HOLDER_POLL_MS = 50;
const TEST_TIMEOUT_MS = 120_000;
const RACE_TIMEOUT_MS = 240_000;

const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const createdOrgIds: string[] = [];
const pendingHolders: Array<Promise<unknown>> = [];

function yearsAgo(years: number): string {
  const today = todayLocal();
  const monthDay = today.slice(4) === '-02-29' ? '-02-28' : today.slice(4);
  return `${String(Number(today.slice(0, 4)) - years).padStart(4, '0')}${monthDay}`;
}

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-self-dissolve-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `self-dissolve-${label}`,
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

// ---------------------------------------------------------------------------------------------
// 家族
// ---------------------------------------------------------------------------------------------

/** 家族プランを付与済みの利用者 (同じ利用者に 2 回付与すると BILL_LIVE_ROW_CONFLICT になるので、付与は 1 人 1 回) */
const familyPlanGrantedUserIds = new Set<string>();

/**
 * billing/03 §6.6: 家族グループは家族プランの契約者だけが作れ (create_family_group の FAMILY_PLAN_REQUIRED)、
 * free のグループには代表者以外のメンバーを足せない (トリガー family_members_billing_plan_gate)。
 * 家族を作る前に代表者に家族プランを手動付与する。付与は利用者に付くので、解散のあとに同じ代表者が作り直す (D-4) ときは付与し直さない
 */
async function ensureFamilyPlan(rep: TestUser): Promise<void> {
  if (familyPlanGrantedUserIds.has(rep.id)) return;
  await grantFamilyPlan(srAdmin, rep.id);
  familyPlanGrantedUserIds.add(rep.id);
}

async function createFamily(rep: TestUser, label: string): Promise<string> {
  await ensureFamilyPlan(rep);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', { p_name: `#1917 ${label} ${TS}`, p_plan_key: 'free' });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return familyId;
}

async function inviteToken(rep: TestUser, familyId: string, email: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: email });
  if (error || !data) throw new Error(`create_family_invite: ${error?.message}`);
  return (data as { token: string }).token;
}

async function join(rep: TestUser, familyId: string, user: TestUser): Promise<void> {
  const token = await inviteToken(rep, familyId, user.email);
  const { error } = await asUser(user.jwt).rpc('accept_family_invite', { p_token: token });
  if (error) throw new Error(`accept_family_invite: ${error.message}`);
}

/** アカウントの無い子供 (保護者の同意あり) を代表者が足す。メンバーの id を返す */
async function addConsentedChild(rep: TestUser, familyId: string, name: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: name,
    p_child_profile: { note: '#1917' },
    p_birth_date: yearsAgo(CHILD_AGE_YEARS),
    p_consent_version: PARENTAL_CONSENT_DOCUMENT.version,
    p_signed_name: SIGNED_NAME,
    p_guardian_attested: true,
  });
  if (error || !data) throw new Error(`add_family_child ${name}: ${error?.message}`);
  return (data as { id: string }).id;
}

interface FamilyRow {
  status: string;
  representative_id: string | null;
  dissolved_at: string | null;
  name: string;
}

async function familyRow(familyId: string): Promise<FamilyRow | null> {
  const { data, error } = await srAdmin.from('family_groups').select('status, representative_id, dissolved_at, name').eq('id', familyId).maybeSingle();
  if (error) throw new Error(`family_groups: ${error.message}`);
  return data as FamilyRow | null;
}

async function memberStatuses(familyId: string): Promise<Array<{ user_id: string | null; status: string }>> {
  const { data, error } = await srAdmin.from('family_members').select('user_id, status').eq('family_id', familyId);
  if (error) throw new Error(`family_members: ${error.message}`);
  return (data ?? []) as Array<{ user_id: string | null; status: string }>;
}

async function profileFamilyId(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('family_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return data ? ((data as { family_id: string | null }).family_id ?? null) : null;
}

interface AuditRow {
  action: string;
  actor_id: string | null;
  target_user_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditRows(scope: 'family' | 'organization', scopeId: string, action: string): Promise<AuditRow[]> {
  const { data, error } = await srAdmin
    .from('membership_audit')
    .select('action, actor_id, target_user_id, metadata')
    .eq('scope', scope)
    .eq('scope_id', scopeId)
    .eq('action', action);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return (data ?? []) as AuditRow[];
}

// ---------------------------------------------------------------------------------------------
// 組織
// ---------------------------------------------------------------------------------------------

type OrgRole = 'owner' | 'admin' | 'member';

async function createOrg(owner: TestUser, label: string): Promise<string> {
  const { data, error } = await srAdmin.from('organizations').insert({ name: `#1917 ${label} ${TS}`, owner_id: owner.id }).select('id').single();
  if (error || !data) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = data.id as string;
  createdOrgIds.push(orgId);
  const { error: poolError } = await retryIdempotentSetup(srAdmin, 'createOrg: org_license_pools の upsert', (db) =>
    db.from('org_license_pools').upsert({ organization_id: orgId, total_licenses: ORG_TOTAL_LICENSES, used_licenses: 0 }, { onConflict: 'organization_id' }));
  if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  await setOrgMembership(owner, orgId, 'owner');
  return orgId;
}

async function setOrgMembership(user: TestUser, orgId: string, role: OrgRole, roles: string[] = ['user']): Promise<void> {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: true, joined_org_at: new Date().toISOString(), roles })
    .eq('id', user.id);
  if (error) throw new Error(`membership: ${error.message}`);
}

async function setUsedLicenses(orgId: string, used: number): Promise<void> {
  const { error } = await srAdmin.from('org_license_pools').update({ used_licenses: used }).eq('organization_id', orgId);
  if (error) throw new Error(`org_license_pools: ${error.message}`);
}

interface OrgProfile {
  organization_id: string | null;
  org_role: string | null;
  is_active_in_org: boolean | null;
  joined_org_at: string | null;
  department_id: string | null;
  roles: string[];
}

async function orgProfile(userId: string): Promise<OrgProfile> {
  const { data, error } = await srAdmin
    .from('user_profiles')
    .select('organization_id, org_role, is_active_in_org, joined_org_at, department_id, roles')
    .eq('id', userId)
    .single();
  if (error || !data) throw new Error(`user_profiles: ${error?.message}`);
  return data as OrgProfile;
}

async function orgRow(orgId: string): Promise<{ status: string; owner_id: string | null; dissolved_at: string | null } | null> {
  const { data, error } = await srAdmin.from('organizations').select('status, owner_id, dissolved_at').eq('id', orgId).maybeSingle();
  if (error) throw new Error(`organizations: ${error.message}`);
  return data as { status: string; owner_id: string | null; dissolved_at: string | null } | null;
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

async function proposeOrgTransfer(owner: TestUser, orgId: string, toUserId: string): Promise<string> {
  const { data, error } = await asUser(owner.jwt).rpc('propose_org_owner_transfer', { p_organization_id: orgId, p_to_user_id: toUserId });
  if (error || !data) throw new Error(`propose_org_owner_transfer: ${error?.message}`);
  return data as string;
}

// ---------------------------------------------------------------------------------------------
// 呼び出しの結果
// ---------------------------------------------------------------------------------------------

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

async function dissolveFamily(user: TestUser, familyId: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('dissolve_family_by_representative', { p_family_id: familyId });
  return toOutcome(data, error);
}

async function dissolveOrg(user: TestUser, orgId: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('dissolve_org_by_owner', { p_organization_id: orgId });
  return toOutcome(data, error);
}

/** RPC が RAISE した P0001 のコード (例外の文がそのコード) */
function expectRaised(outcome: Outcome, code: string): void {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
  expect(outcome.message).toBe(code);
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (family-lock-order-race.test.ts と同じ形)
// ---------------------------------------------------------------------------------------------

interface Holder {
  sleeping: Promise<void>;
  done: Promise<Outcome>;
}

function holdCall(actor: TestUser, callSql: string): Holder {
  const marker = `self-dissolve-holder-${randomBytes(6).toString('hex')}`;
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
    await srAdmin.from('user_profiles').update({ organization_id: null, org_role: null, is_active_in_org: false, family_id: null }).in('id', createdUserIds);
  }
  if (createdFamilyIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdFamilyIds);
    await srAdmin.from('parental_consents').delete().in('family_id', createdFamilyIds);
    await srAdmin.from('ownership_transfer_proposals').delete().in('scope_id', createdFamilyIds);
    // family_groups.representative_id は ON DELETE RESTRICT なので、家族を先に消す
    await srAdmin.from('family_groups').delete().in('id', createdFamilyIds);
  }
  if (createdOrgIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdOrgIds);
    await srAdmin.from('ownership_transfer_proposals').delete().in('scope_id', createdOrgIds);
    await srAdmin.from('organization_invites').delete().in('organization_id', createdOrgIds);
    await srAdmin.from('org_license_pools').delete().in('organization_id', createdOrgIds);
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, RACE_TIMEOUT_MS);

// ---------------------------------------------------------------------------------------------
// 家族
// ---------------------------------------------------------------------------------------------

describe('#1917 家族の代表者が自分で解散する (dissolve_family_by_representative)', () => {
  it('D-1: 代表者が解散すると、行は dissolved・representative_id NULL、active の 4 行が left、3 人の family_id が NULL、子供の同意が member_left で取り消され、group_dissolved が 1 行。戻り値の member_user_ids は 3 人', async () => {
    const [rep, adult, teen] = await createUsers('d1', 3);
    const familyId = await createFamily(rep, 'd1');
    await join(rep, familyId, adult);
    await join(rep, familyId, teen);
    // アカウントを持つ子供 (役割だけを child にする)
    const { error: demoteError } = await srAdmin.from('family_members').update({ role: 'child' }).eq('family_id', familyId).eq('user_id', teen.id);
    expect(demoteError).toBeNull();
    const childMemberId = await addConsentedChild(rep, familyId, 'd1-child');
    const { data: consentsBefore } = await srAdmin.from('parental_consents').select('id, revoked_at').eq('family_member_id', childMemberId);
    expect((consentsBefore ?? []).length).toBe(1);

    const result = await dissolveFamily(rep, familyId);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const data = result.data as { scope_id: string; scope_name: string; dissolved_at: string; member_user_ids: string[] };
    expect(data.scope_id).toBe(familyId);
    expect(data.scope_name).toBe(`#1917 d1 ${TS}`);
    expect(typeof data.dissolved_at).toBe('string');
    expect([...data.member_user_ids].sort()).toEqual([rep.id, adult.id, teen.id].sort());

    const row = await familyRow(familyId);
    expect(row?.status).toBe('dissolved');
    expect(row?.dissolved_at).not.toBeNull();
    expect(row?.representative_id).toBeNull();
    const statuses = await memberStatuses(familyId);
    expect(statuses).toHaveLength(4);
    expect(statuses.every((m) => m.status === 'left')).toBe(true);
    for (const user of [rep, adult, teen]) expect(await profileFamilyId(user.id)).toBeNull();

    const { data: consentsAfter } = await srAdmin
      .from('parental_consents')
      .select('revoked_at, revoked_reason')
      .eq('family_id', familyId);
    expect(consentsAfter).toHaveLength(1);
    expect((consentsAfter as Array<{ revoked_at: string | null; revoked_reason: string | null }>)[0]).toMatchObject({ revoked_reason: 'member_left' });
    expect((consentsAfter as Array<{ revoked_at: string | null }>)[0].revoked_at).not.toBeNull();

    const audits = await auditRows('family', familyId, 'group_dissolved');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: rep.id,
      target_user_id: null,
      metadata: { dissolved_by: 'representative', previous_representative_id: rep.id, member_count: 4 },
    });
  }, TEST_TIMEOUT_MS);

  it('D-2: 大人・別の家族の代表者は NOT_FAMILY_REPRESENTATIVE、無い id は FAMILY_NOT_FOUND で何も変わらない。解散済みの家族にもう一度呼ぶと FAMILY_ALREADY_DISSOLVED', async () => {
    const [rep, adult, other] = await createUsers('d2', 3);
    const familyId = await createFamily(rep, 'd2');
    await createFamily(other, 'd2-other');
    await join(rep, familyId, adult);

    expectRaised(await dissolveFamily(adult, familyId), 'NOT_FAMILY_REPRESENTATIVE');
    expectRaised(await dissolveFamily(other, familyId), 'NOT_FAMILY_REPRESENTATIVE');
    expectRaised(await dissolveFamily(rep, '00000000-0000-4000-8000-000000000000'), 'FAMILY_NOT_FOUND');
    expect(await familyRow(familyId)).toMatchObject({ status: 'active', representative_id: rep.id, dissolved_at: null });
    expect((await memberStatuses(familyId)).every((m) => m.status === 'active')).toBe(true);
    expect(await auditRows('family', familyId, 'group_dissolved')).toEqual([]);

    expect((await dissolveFamily(rep, familyId)).ok).toBe(true);
    expectRaised(await dissolveFamily(rep, familyId), 'FAMILY_ALREADY_DISSOLVED');
    expect(await auditRows('family', familyId, 'group_dissolved')).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it('D-3: 解散のあと、元代表者は deleteAccount で退会できる。family_groups の行は残り、representative_id は NULL のまま。元代表者の family_members の行は CASCADE で消える', async () => {
    const [rep] = await createUsers('d3', 1);
    const familyId = await createFamily(rep, 'd3');
    const blocked = await deleteAccount({ userId: rep.id, admin: srAdmin });
    expect(blocked).toMatchObject({ ok: false, status: 409, error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE' });

    expect((await dissolveFamily(rep, familyId)).ok).toBe(true);
    const result = await deleteAccount({ userId: rep.id, admin: srAdmin });

    expect(result).toMatchObject({ ok: true });
    const { data } = await srAdmin.auth.admin.getUserById(rep.id);
    expect(data.user).toBeNull();
    expect(await familyRow(familyId)).toMatchObject({ status: 'dissolved', representative_id: null });
    expect(await memberStatuses(familyId)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('D-4: 解散のあと、元代表者は create_family_group で新しい家族を作れる (ALREADY_IN_FAMILY にならない)', async () => {
    const [rep] = await createUsers('d4', 1);
    const familyId = await createFamily(rep, 'd4');
    expect((await dissolveFamily(rep, familyId)).ok).toBe(true);

    const next = await createFamily(rep, 'd4-next');
    expect(await familyRow(next)).toMatchObject({ status: 'active', representative_id: rep.id });
  }, TEST_TIMEOUT_MS);

  it('D-8: 自己解散と招待の承諾を本物の経路で 8 回ずつ同時に呼んでも、デッドロックせず、解散済みの家族に active が残らない', async () => {
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [rep, invitee] = await createUsers(`d8-${i}`, 2);
      const familyId = await createFamily(rep, `d8-${i}`);
      const token = await inviteToken(rep, familyId, invitee.email);

      const [accept, dissolve] = await Promise.all([
        asUser(invitee.jwt).rpc('accept_family_invite', { p_token: token }).then(({ data, error }) => toOutcome(data, error)),
        dissolveFamily(rep, familyId),
      ]);

      if (isDeadlock(accept) || isDeadlock(dissolve)) problems.push(`#${i} デッドロック: ${JSON.stringify({ accept, dissolve })}`);
      if (!dissolve.ok) problems.push(`#${i} 解散が失敗: ${JSON.stringify(dissolve)}`);
      if (!accept.ok && !/FAMILY_NOT_FOUND/.test(accept.message ?? '')) problems.push(`#${i} 承諾が想定外の失敗: ${JSON.stringify(accept)}`);
      const active = (await memberStatuses(familyId)).filter((m) => m.status === 'active');
      if (active.length > 0) problems.push(`#${i} 解散済みの家族に active が残った: ${active.length} 人`);
      if ((await profileFamilyId(invitee.id)) !== null) problems.push(`#${i} 承諾した人のプロフィールに family_id が残った`);
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('D-8: 自己解散と代表者の譲渡の承諾: 承諾が先なら解散は NOT_FAMILY_REPRESENTATIVE、解散が先なら承諾は TRANSFER_ACCEPTOR_NOT_IN_FAMILY', async () => {
    // 承諾が先 (コミット前のまま開いておく) → 解散
    {
      const [rep, adult] = await createUsers('d8t-a', 2);
      const familyId = await createFamily(rep, 'd8t-a');
      await join(rep, familyId, adult);
      const { data: proposalId, error } = await asUser(rep.jwt).rpc('propose_family_representative_transfer', { p_family_id: familyId, p_to_user_id: adult.id });
      expect(error).toBeNull();
      const holder = holdCall(adult, `public.accept_family_representative_transfer('${String(proposalId)}'::uuid)`);
      await holder.sleeping;
      const dissolve = await dissolveFamily(rep, familyId);
      expect((await holder.done).ok).toBe(true);
      expectRaised(dissolve, 'NOT_FAMILY_REPRESENTATIVE');
      expect(await familyRow(familyId)).toMatchObject({ status: 'active', representative_id: adult.id });
    }
    // 解散が先 (コミット前のまま開いておく) → 承諾
    {
      const [rep, adult] = await createUsers('d8t-b', 2);
      const familyId = await createFamily(rep, 'd8t-b');
      await join(rep, familyId, adult);
      const { data: proposalId, error } = await asUser(rep.jwt).rpc('propose_family_representative_transfer', { p_family_id: familyId, p_to_user_id: adult.id });
      expect(error).toBeNull();
      const holder = holdCall(rep, `public.dissolve_family_by_representative('${familyId}'::uuid)`);
      await holder.sleeping;
      const { error: acceptError } = await asUser(adult.jwt).rpc('accept_family_representative_transfer', { p_proposal_id: proposalId });
      expect((await holder.done).ok).toBe(true);
      expect(acceptError?.message ?? '').toContain('TRANSFER_ACCEPTOR_NOT_IN_FAMILY');
      expect(await familyRow(familyId)).toMatchObject({ status: 'dissolved', representative_id: null });
    }
  }, RACE_TIMEOUT_MS);

  it('D-14: 凍結中 (frozen_at) の代表者でも RPC は通る (RPC は凍結を見ない)', async () => {
    const [rep] = await createUsers('d14', 1);
    const familyId = await createFamily(rep, 'd14');
    const { error } = await srAdmin
      .from('user_profiles')
      .update({ frozen_at: new Date().toISOString(), frozen_reason: '#1917 integration test' })
      .eq('id', rep.id);
    expect(error).toBeNull();

    expect((await dissolveFamily(rep, familyId)).ok).toBe(true);
    expect(await familyRow(familyId)).toMatchObject({ status: 'dissolved', representative_id: null });
  }, TEST_TIMEOUT_MS);

  it('D-16: 家族の行の特権列のガード: 大人と代表者が本人のセッションで status / dissolved_at を変える UPDATE は 42501。同じ値の送り直しと name の変更は通る。そのあと解散も退会もできる。service_role は書ける', async () => {
    const [hrep, hadult] = await createUsers('d16', 2);
    const familyId = await createFamily(hrep, 'd16');
    await join(hrep, familyId, hadult);

    for (const user of [hadult, hrep]) {
      for (const patch of [{ status: 'dissolved' }, { dissolved_at: new Date().toISOString() }]) {
        const { data, error } = await asUser(user.jwt).from('family_groups').update(patch).eq('id', familyId).select('id');
        expect(error, JSON.stringify(patch)).not.toBeNull();
        expect(error?.code).toBe('42501');
        expect(error?.message ?? '').toContain('CANNOT_MODIFY_PRIVILEGED_COLUMN');
        expect(data ?? []).toEqual([]);
      }
    }
    expect(await familyRow(familyId)).toMatchObject({ status: 'active', dissolved_at: null, representative_id: hrep.id });
    expect((await memberStatuses(familyId)).find((m) => m.user_id === hadult.id)?.status).toBe('active');

    const sameStatus = await asUser(hadult.jwt).from('family_groups').update({ status: 'active' }).eq('id', familyId).select('id');
    expect(sameStatus.error).toBeNull();
    expect(sameStatus.data).toHaveLength(1);
    const renamed = await asUser(hadult.jwt).from('family_groups').update({ name: `#1917 d16 renamed ${TS}` }).eq('id', familyId).select('id');
    expect(renamed.error).toBeNull();
    expect(renamed.data).toHaveLength(1);

    expect((await dissolveFamily(hrep, familyId)).ok).toBe(true);
    expect(await deleteAccount({ userId: hrep.id, admin: srAdmin })).toMatchObject({ ok: true });

    // service_role はガードの対象外 (解散した行の dissolved_at を書き直せる)
    const { error: srError } = await srAdmin.from('family_groups').update({ dissolved_at: new Date().toISOString() }).eq('id', familyId);
    expect(srError).toBeNull();
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 組織
// ---------------------------------------------------------------------------------------------

describe('#1917 組織のオーナーが自分で解散する (dissolve_org_by_owner)', () => {
  it('D-5: オーナーが解散すると、organizations は dissolved・owner_id NULL、3 人の所属の列が外れ org_admin も外れ、used_licenses が 0、group_dissolved が 1 行。戻り値の member_user_ids は 3 人', async () => {
    const [owner, admin, member] = await createUsers('d5', 3);
    const orgId = await createOrg(owner, 'd5');
    await setOrgMembership(admin, orgId, 'admin', ['user', 'org_admin']);
    await setOrgMembership(member, orgId, 'member');
    await setUsedLicenses(orgId, 3);

    const result = await dissolveOrg(owner, orgId);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const data = result.data as { scope_id: string; member_user_ids: string[] };
    expect(data.scope_id).toBe(orgId);
    expect([...data.member_user_ids].sort()).toEqual([owner.id, admin.id, member.id].sort());
    const row = await orgRow(orgId);
    expect(row).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(row?.dissolved_at).not.toBeNull();
    for (const user of [owner, admin, member]) {
      expect(await orgProfile(user.id)).toMatchObject({
        organization_id: null,
        org_role: null,
        is_active_in_org: false,
        joined_org_at: null,
        department_id: null,
      });
      expect((await orgProfile(user.id)).roles).not.toContain('org_admin');
    }
    expect(await usedLicenses(orgId)).toBe(0);
    const audits = await auditRows('organization', orgId, 'group_dissolved');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: owner.id,
      target_user_id: null,
      metadata: { dissolved_by: 'owner', previous_owner_id: owner.id, member_count: 3 },
    });
  }, TEST_TIMEOUT_MS);

  it('D-6: admin・別の組織のオーナーは NOT_ORG_OWNER、無い id は ORG_NOT_FOUND。2 回目は ORG_ALREADY_DISSOLVED', async () => {
    const [owner, admin, otherOwner] = await createUsers('d6', 3);
    const orgId = await createOrg(owner, 'd6');
    await createOrg(otherOwner, 'd6-other');
    await setOrgMembership(admin, orgId, 'admin', ['user', 'org_admin']);

    expectRaised(await dissolveOrg(admin, orgId), 'NOT_ORG_OWNER');
    expectRaised(await dissolveOrg(otherOwner, orgId), 'NOT_ORG_OWNER');
    expectRaised(await dissolveOrg(owner, '00000000-0000-4000-8000-000000000000'), 'ORG_NOT_FOUND');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: owner.id });
    expect(await orgMemberCount(orgId)).toBe(2);

    expect((await dissolveOrg(owner, orgId)).ok).toBe(true);
    expectRaised(await dissolveOrg(owner, orgId), 'ORG_ALREADY_DISSOLVED');
  }, TEST_TIMEOUT_MS);

  it('D-7: 解散のあと、元オーナーは別の組織 P の招待を承諾できる (IS_ORG_OWNER にならない)。そのあと退会できる', async () => {
    const [owner, ownerP] = await createUsers('d7', 2);
    const orgId = await createOrg(owner, 'd7');
    const orgP = await createOrg(ownerP, 'd7-p');
    const token = await insertPendingOrgInvite(orgP, owner.email, ownerP.id);

    const before = await asUser(owner.jwt).rpc('accept_org_invite', { p_token: token });
    expect(before.error?.message ?? '').toMatch(/IS_ORG_OWNER|ALREADY_IN_ORG/);

    expect((await dissolveOrg(owner, orgId)).ok).toBe(true);
    const accepted = await asUser(owner.jwt).rpc('accept_org_invite', { p_token: token });
    expect(accepted.error, JSON.stringify(accepted.error)).toBeNull();
    expect(await orgProfile(owner.id)).toMatchObject({ organization_id: orgP, org_role: 'member' });

    const result = await deleteAccount({ userId: owner.id, admin: srAdmin });
    expect(result).toMatchObject({ ok: true });
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
  }, TEST_TIMEOUT_MS);

  it('D-9: 自己解散とオーナーの譲渡の承諾を同時に 8 回呼んでも、デッドロックせず、終わったあとは「dissolved で所属 0 人」か「active で owner が新オーナー」のどちらか', async () => {
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [owner, admin] = await createUsers(`d9-${i}`, 2);
      const orgId = await createOrg(owner, `d9-${i}`);
      await setOrgMembership(admin, orgId, 'admin', ['user', 'org_admin']);
      const proposalId = await proposeOrgTransfer(owner, orgId, admin.id);

      const [dissolve, accept] = await Promise.all([
        dissolveOrg(owner, orgId),
        asUser(admin.jwt).rpc('accept_org_owner_transfer', { p_proposal_id: proposalId }).then(({ data, error }) => toOutcome(data, error)),
      ]);

      if (isDeadlock(dissolve) || isDeadlock(accept)) problems.push(`#${i} デッドロック: ${JSON.stringify({ dissolve, accept })}`);
      const row = await orgRow(orgId);
      const members = await orgMemberCount(orgId);
      const dissolvedEnd = row?.status === 'dissolved' && row.owner_id === null && members === 0;
      const transferredEnd = row?.status === 'active' && row.owner_id === admin.id;
      if (!dissolvedEnd && !transferredEnd) problems.push(`#${i} 中間の状態: ${JSON.stringify({ row, members, dissolve, accept })}`);
      if (dissolvedEnd && accept.ok) problems.push(`#${i} 解散したのに承諾が成功した: ${JSON.stringify(accept)}`);
      if (transferredEnd && dissolve.ok) problems.push(`#${i} 譲渡したのに解散が成功した: ${JSON.stringify(dissolve)}`);
      if (transferredEnd && dissolve.message !== 'NOT_ORG_OWNER') problems.push(`#${i} 承諾が先なのに解散が NOT_ORG_OWNER でない: ${JSON.stringify(dissolve)}`);
      // 解散が先なら、承諾は ORG_ALREADY_DISSOLVED で止まる (20261022140000_org_transfer_toctou.sql。修正前は CHECK 23514 のことがあった)
      if (dissolvedEnd && !(accept.code === 'P0001' && accept.message === 'ORG_ALREADY_DISSOLVED')) {
        problems.push(`#${i} 解散が先なのに承諾が ORG_ALREADY_DISSOLVED でない: ${JSON.stringify(accept)}`);
      }
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('D-15: 組織の招待の承諾が commit したあとに解散すると、承諾した人の所属も外れ、member_user_ids に入る。同時に 8 回ずつ呼んでもデッドロックせず、P0001 以外で失敗しない', async () => {
    {
      const [owner, invitee] = await createUsers('d15', 2);
      const orgId = await createOrg(owner, 'd15');
      const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);
      const accepted = await asUser(invitee.jwt).rpc('accept_org_invite', { p_token: token });
      expect(accepted.error, JSON.stringify(accepted.error)).toBeNull();

      const result = await dissolveOrg(owner, orgId);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect((result.data as { member_user_ids: string[] }).member_user_ids).toContain(invitee.id);
      expect(await orgProfile(invitee.id)).toMatchObject({ organization_id: null, org_role: null });
    }

    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [owner, invitee] = await createUsers(`d15-${i}`, 2);
      const orgId = await createOrg(owner, `d15-${i}`);
      const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);

      const [dissolve, accept] = await Promise.all([
        dissolveOrg(owner, orgId),
        asUser(invitee.jwt).rpc('accept_org_invite', { p_token: token }).then(({ data, error }) => toOutcome(data, error)),
      ]);

      if (isDeadlock(dissolve) || isDeadlock(accept)) problems.push(`#${i} デッドロック: ${JSON.stringify({ dissolve, accept })}`);
      if (!dissolve.ok) problems.push(`#${i} 解散が失敗: ${JSON.stringify(dissolve)}`);
      if (!accept.ok && accept.code !== 'P0001') problems.push(`#${i} 承諾が P0001 以外で失敗: ${JSON.stringify(accept)}`);
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 権限・列の制約・外部キー・運営の強制解散
// ---------------------------------------------------------------------------------------------

describe('#1917 権限・列の制約・外部キー・運営の強制解散', () => {
  it('D-10: anon は dissolve_family_by_representative / dissolve_org_by_owner を呼べない (42501)。ログインユーザーは family_dissolve_apply / org_dissolve_apply を呼べない (42501)', async () => {
    const [user] = await createUsers('d10', 1);
    const familyId = await createFamily(user, 'd10');

    const anonFamily = await anon().rpc('dissolve_family_by_representative', { p_family_id: familyId });
    expect(anonFamily.error?.code).toBe('42501');
    const anonOrg = await anon().rpc('dissolve_org_by_owner', { p_organization_id: familyId });
    expect(anonOrg.error?.code).toBe('42501');
    const applyFamily = await asUser(user.jwt).rpc('family_dissolve_apply', { p_family_id: familyId });
    expect(applyFamily.error?.code).toBe('42501');
    const applyOrg = await asUser(user.jwt).rpc('org_dissolve_apply', { p_organization_id: familyId });
    expect(applyOrg.error?.code).toBe('42501');
    expect(await familyRow(familyId)).toMatchObject({ status: 'active', representative_id: user.id });
  }, TEST_TIMEOUT_MS);

  it('D-11: active の行の representative_id / owner_id を service_role で NULL にすると CHECK (23514) で止まる。dissolved の行は NULL にできる', async () => {
    const [rep, owner] = await createUsers('d11', 2);
    const familyId = await createFamily(rep, 'd11');
    const orgId = await createOrg(owner, 'd11');

    const family = await srAdmin.from('family_groups').update({ representative_id: null }).eq('id', familyId);
    expect(family.error?.code).toBe('23514');
    expect(family.error?.message ?? '').toContain('family_groups_active_has_representative');
    const org = await srAdmin.from('organizations').update({ owner_id: null }).eq('id', orgId);
    expect(org.error?.code).toBe('23514');
    expect(org.error?.message ?? '').toContain('organizations_active_has_owner');

    const dissolvedFamily = await srAdmin.from('family_groups').update({ status: 'dissolved', representative_id: null }).eq('id', familyId);
    expect(dissolvedFamily.error).toBeNull();
    const dissolvedOrg = await srAdmin.from('organizations').update({ status: 'dissolved', owner_id: null }).eq('id', orgId);
    expect(dissolvedOrg.error).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('D-12: active な家族の代表者 / 組織のオーナーの auth.users を消すと 23503 (RESTRICT は残っている)', async () => {
    const [rep, owner] = await createUsers('d12', 2);
    await createFamily(rep, 'd12');
    await createOrg(owner, 'd12');

    for (const userId of [rep.id, owner.id]) {
      // 消せてしまったときも巻き戻すよう、最後に必ず失敗する文を置く (先の DELETE が 23503 なら、そちらが返る)
      const res = await pgRequest(`DELETE FROM auth.users WHERE id = '${userId}'::uuid; SELECT 1 / 0;`);
      expect(res.ok).toBe(false);
      expect((res.body as { code?: unknown } | null)?.code).toBe('23503');
    }
    const { data } = await srAdmin.auth.admin.getUserById(rep.id);
    expect(data.user?.id).toBe(rep.id);
  }, TEST_TIMEOUT_MS);

  it('D-13: 運営の強制解散 (置き換え後) は今までどおり。加えて representative_id / owner_id が NULL になり、監査の metadata に previous_* が入る', async () => {
    const operator = await createUser('d13-operator', ['user', 'super_admin']);
    const { client: sessionClient } = await signIn(operator.email);
    const aal2 = await promoteToAal2(sessionClient);

    // 家族
    const [rep, adult] = await createUsers('d13-family', 2);
    const familyId = await createFamily(rep, 'd13');
    await join(rep, familyId, adult);
    const familyResult = await asUser(aal2).rpc('operator_force_dissolve_family', { p_family_id: familyId, p_reason: '#1917 D-13' });
    expect(familyResult.error, JSON.stringify(familyResult.error)).toBeNull();
    expect(await familyRow(familyId)).toMatchObject({ status: 'dissolved', representative_id: null });
    expect((await memberStatuses(familyId)).every((m) => m.status === 'left')).toBe(true);
    for (const user of [rep, adult]) expect(await profileFamilyId(user.id)).toBeNull();
    const familyAudits = await auditRows('family', familyId, 'operator_force_dissolve');
    expect(familyAudits).toHaveLength(1);
    expect(familyAudits[0]).toMatchObject({
      actor_id: null,
      metadata: { operator_id: operator.id, reason: '#1917 D-13', previous_representative_id: rep.id },
    });
    expect(await auditRows('family', familyId, 'group_dissolved')).toEqual([]);

    // 組織
    const [owner, admin, member] = await createUsers('d13-org', 3);
    const orgId = await createOrg(owner, 'd13');
    await setOrgMembership(admin, orgId, 'admin', ['user', 'org_admin']);
    await setOrgMembership(member, orgId, 'member');
    await setUsedLicenses(orgId, 3);
    const orgResult = await asUser(aal2).rpc('operator_force_dissolve_org', { p_organization_id: orgId, p_reason: '#1917 D-13' });
    expect(orgResult.error, JSON.stringify(orgResult.error)).toBeNull();
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    for (const user of [owner, admin, member]) {
      const p = await orgProfile(user.id);
      expect(p).toMatchObject({ organization_id: null, org_role: null, is_active_in_org: false, joined_org_at: null, department_id: null });
      expect(p.roles).not.toContain('org_admin');
    }
    expect(await usedLicenses(orgId)).toBe(0);
    const orgAudits = await auditRows('organization', orgId, 'operator_force_dissolve');
    expect(orgAudits).toHaveLength(1);
    expect(orgAudits[0]).toMatchObject({ actor_id: operator.id, metadata: { reason: '#1917 D-13', previous_owner_id: owner.id } });
  }, TEST_TIMEOUT_MS);
});
