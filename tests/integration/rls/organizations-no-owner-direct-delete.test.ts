/**
 * #1917 の続き: organizations へのオーナーの直接の DELETE を塞ぎ、組織をやめるのを解散の仕組み
 * (オーナーの解散の RPC・運営の強制解散) だけにする (migration 20261023100000_organizations_no_owner_direct_delete.sql)。
 * 家族の同じ欠陥は 20261022200000 で塞いだ (tests/integration/rls/family-groups-no-direct-delete.test.ts)。
 *
 * 修正前は、ポリシー organizations_delete_owner と anon / authenticated の DELETE の権限により、組織のオーナーが
 * PostgREST の直接の DELETE で組織の行を消せた (所属の列を持つ人が残っている組織は、user_profiles.organization_id の SET NULL が
 * CHECK user_profiles_org_consistency (23514) に当たって止まる。所属の列を持つ人がいない組織は消えた)。そのとき部署・招待・
 * チャレンジ・席数などの子の記録が外部キーの CASCADE で物理削除され、解散の RPC (監査 group_dissolved・解散の知らせ) も通らなかった。
 *
 * 直接の DELETE の結果 (この表で固定する):
 *   | 呼び出し元                                   | 結果                        | 理由                                                         |
 *   |----------------------------------------------|-----------------------------|--------------------------------------------------------------|
 *   | オーナー (所属あり・所属の列を持つ人がいない) | 0 行 (エラーなし)・行は残る | authenticated の DELETE の権限は運営のポリシーのため残す。当たるポリシーが無い |
 *   | 管理者・メンバー・別の組織のオーナー         | 0 行 (エラーなし)・行は残る | 同上                                                         |
 *   | 解散した組織の元のオーナー                   | 0 行 (エラーなし)・行は残る | 同上                                                         |
 *   | 未認証 (anon)                                | 42501                       | anon の DELETE の権限を外した                                |
 *   | 運営 (super_admin・MFA 済み)                 | 消える (今までどおり)       | organizations_delete_super_admin は残す                      |
 *   | 運営 (super_admin・MFA 前)                   | 0 行 (今までどおり)         | operator_mfa_satisfied() が偽                                |
 *   | service_role                                 | 消える (今までどおり)       | RLS を通らない                                               |
 *
 * 確かめること:
 *   - O-1: 所属の列を持つ人がいない組織のオーナーの直接の DELETE は 0 行で、組織の行・部署・招待・チャレンジ・席数は残る
 *          (修正前はこの組織が CASCADE ごと消えた)
 *   - O-2: 所属のある組織のオーナー・管理者・メンバー・別の組織のオーナーの直接の DELETE も 0 行で、行と所属は残る
 *   - O-3: 未認証の直接の DELETE は 42501 で、行は残る
 *   - O-4: カタログ: ポリシーは SELECT・UPDATE と運営の DELETE だけ。anon は DELETE・TRUNCATE を持たず、authenticated は
 *          SELECT・UPDATE・DELETE を持ち TRUNCATE を持たない。service_role の DELETE は残る
 *   - O-5: オーナーの解散の RPC (dissolve_org_by_owner) は今までどおり通り、子の記録は残る。解散のあとも元のオーナーは直接 DELETE できない
 *   - O-6: 運営の強制解散 (operator_force_dissolve_org) は今までどおり通る (組織の行は dissolved になり、消えない)
 *   - O-7: 運営 (super_admin・MFA 済み) の直接の DELETE は今までどおり通る (子の記録は CASCADE)。MFA 前は 0 行
 *   - O-8: service_role の直接の DELETE (テストと e2e の後片付け) は今までどおり通る
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/organizations-no-owner-direct-delete.test.ts
 * カタログの確認と TRUNCATE の試しは、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { jstDaysAgo } from '../helpers/jst-days';
import { promoteToAal2 } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
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

/** 権限が無い書き込み (permission denied) の SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 成人の生年月日 */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 組織の席数 (テストで足りる数) */
const ORG_TOTAL_LICENSES = 10;
/** 招待のトークンのバイト数 (hex で 64 文字。create_*_invite と同じ形) */
const TOKEN_BYTES = 32;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 招待の期限 (日) */
const INVITE_TTL_DAYS = 14;
/** 下書きのチャレンジの期間 (今日から何日後に始まり、何日後に終わるか) */
const CHALLENGE_START_IN_DAYS = 7;
const CHALLENGE_END_IN_DAYS = 37;
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒。利用者・組織を複数作る) */
const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;

type OrgRole = 'owner' | 'admin' | 'member';

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
let seq = 0;

const emailOf = (label: string) => `rls-org-no-direct-delete-${label}-${RUN}-${++seq}@homegohan.test`;

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = emailOf(`user-${label}`);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `org-no-direct-delete-${label}`,
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

async function setOrgMembership(user: TestUser, orgId: string, role: OrgRole, roles: string[] = ['user']): Promise<void> {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: true, joined_org_at: new Date().toISOString(), roles })
    .eq('id', user.id);
  if (error) throw new Error(`membership: ${error.message}`);
}

interface OrgChildren {
  departmentId: string;
  inviteId: string;
  challengeId: string;
}

/**
 * 組織 (service_role) と子の記録 (席数・部署・招待・下書きのチャレンジ) を作る。
 * attachOwner が偽なら、オーナーの所属の列を入れない (所属の列を持つ人がいない組織 = 修正前にオーナーが直接消せた組織)
 */
async function createOrg(owner: TestUser, label: string, attachOwner: boolean): Promise<{ orgId: string; children: OrgChildren }> {
  const { data, error } = await srAdmin.from('organizations').insert({ name: `#1917 nd ${label} ${RUN}`, owner_id: owner.id }).select('id').single();
  if (error || !data) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = data.id as string;
  createdOrgIds.push(orgId);
  const { error: poolError } = await retryIdempotentSetup(srAdmin, 'createOrg: org_license_pools の upsert', (db) =>
    db.from('org_license_pools').upsert({ organization_id: orgId, total_licenses: ORG_TOTAL_LICENSES, used_licenses: 0 }, { onConflict: 'organization_id' }));
  if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  if (attachOwner) await setOrgMembership(owner, orgId, 'owner');

  const { data: dept, error: deptError } = await srAdmin
    .from('departments')
    .insert({ organization_id: orgId, name: `#1917 nd dept ${label} ${RUN}` })
    .select('id')
    .single();
  if (deptError || !dept) throw new Error(`departments ${label}: ${deptError?.message}`);
  const { data: invite, error: inviteError } = await srAdmin
    .from('organization_invites')
    .insert({
      organization_id: orgId,
      email: emailOf(`invite-${label}`).toLowerCase(),
      token: randomBytes(TOKEN_BYTES).toString('hex'),
      invited_role: 'member',
      status: 'pending',
      expires_at: new Date(Date.now() + INVITE_TTL_DAYS * MS_PER_DAY).toISOString(),
      invited_by: owner.id,
    })
    .select('id')
    .single();
  if (inviteError || !invite) throw new Error(`organization_invites ${label}: ${inviteError?.message}`);
  const { data: challenge, error: challengeError } = await srAdmin
    .from('organization_challenges')
    .insert({
      organization_id: orgId,
      title: `#1917 nd challenge ${label} ${RUN}`,
      challenge_type: 'breakfast_rate',
      status: 'draft',
      start_date: jstDaysAgo(-CHALLENGE_START_IN_DAYS), // jstDaysAgo は負の値で n 日後 (JST の暦日)
      end_date: jstDaysAgo(-CHALLENGE_END_IN_DAYS),
    })
    .select('id')
    .single();
  if (challengeError || !challenge) throw new Error(`organization_challenges ${label}: ${challengeError?.message}`);
  return { orgId, children: { departmentId: dept.id as string, inviteId: invite.id as string, challengeId: challenge.id as string } };
}

interface OrgRow {
  status: string;
  owner_id: string | null;
  dissolved_at: string | null;
}

async function orgRow(orgId: string): Promise<OrgRow | null> {
  const { data, error } = await srAdmin.from('organizations').select('status, owner_id, dissolved_at').eq('id', orgId).maybeSingle();
  if (error) throw new Error(`organizations: ${error.message}`);
  return data as OrgRow | null;
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await srAdmin.from(table).select('*', { count: 'exact', head: true }).eq(column, value);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

/** 組織の子の記録 (部署・招待・チャレンジ・席数) の行数 */
async function childCounts(orgId: string, children: OrgChildren) {
  return {
    departments: await countRows('departments', 'id', children.departmentId),
    organization_invites: await countRows('organization_invites', 'id', children.inviteId),
    organization_challenges: await countRows('organization_challenges', 'id', children.challengeId),
    org_license_pools: await countRows('org_license_pools', 'organization_id', orgId),
  };
}

const ALL_CHILDREN_PRESENT = { departments: 1, organization_invites: 1, organization_challenges: 1, org_license_pools: 1 };
const ALL_CHILDREN_GONE = { departments: 0, organization_invites: 0, organization_challenges: 0, org_license_pools: 0 };

async function auditCount(orgId: string, action: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'organization')
    .eq('scope_id', orgId)
    .eq('action', action);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

/** PostgREST で organizations の行を直接 DELETE する (消えた行の id を返させる) */
async function directDelete(c: SupabaseClient, orgId: string) {
  return c.from('organizations').delete().eq('id', orgId).select('id');
}

/** 直接の DELETE がエラーなしの 0 行で終わり、行が残っていること (当たる DELETE のポリシーが無い) */
async function expectDeleteNoRows(c: SupabaseClient, orgId: string, who: string): Promise<void> {
  const { data, error } = await directDelete(c, orgId);
  expect(error, `${who}: ${JSON.stringify(error)}`).toBeNull();
  expect(data ?? [], who).toEqual([]);
  expect(await orgRow(orgId), who).not.toBeNull();
}

/** 直接の DELETE が権限で止まり、行が残っていること */
async function expectDeleteDenied(c: SupabaseClient, orgId: string, who: string): Promise<void> {
  const { data, error } = await directDelete(c, orgId);
  expect(error?.code, `${who}: ${JSON.stringify(error)}`).toBe(INSUFFICIENT_PRIVILEGE);
  expect(data ?? [], who).toEqual([]);
  expect(await orgRow(orgId), who).not.toBeNull();
}

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let otherOwner: TestUser;
let loneOwner: TestUser;
let org: { orgId: string; children: OrgChildren };
let otherOrg: { orgId: string; children: OrgChildren };
let loneOrg: { orgId: string; children: OrgChildren };

beforeAll(async () => {
  owner = await createUser('owner');
  admin = await createUser('admin');
  member = await createUser('member');
  otherOwner = await createUser('other-owner');
  loneOwner = await createUser('lone-owner');
  org = await createOrg(owner, 'main', true);
  await setOrgMembership(admin, org.orgId, 'admin', ['user', 'org_admin']);
  await setOrgMembership(member, org.orgId, 'member');
  otherOrg = await createOrg(otherOwner, 'other', true);
  loneOrg = await createOrg(loneOwner, 'lone', false);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    // 所属を外してから組織を消す (所属の列を持つ人が残ると、組織の DELETE が CHECK user_profiles_org_consistency で止まる)
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, joined_org_at: null, department_id: null })
      .in('id', createdUserIds);
  }
  if (createdOrgIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdOrgIds);
    // 部署・招待・チャレンジ・席数は organizations の削除で CASCADE。owner_id は RESTRICT のため組織を先に消す
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, SETUP_TIMEOUT_MS);

describe('#1917 の続き: organizations のオーナーの直接の DELETE は行を消さない', () => {
  it('O-1: 所属の列を持つ人がいない組織のオーナーの直接の DELETE は 0 行。組織の行・部署・招待・チャレンジ・席数は残る', async () => {
    // 番兵: 所属の列を持つ人がいない (修正前は、この組織をオーナーが CASCADE ごと消せた)
    expect(await countRows('user_profiles', 'organization_id', loneOrg.orgId)).toBe(0);
    expect(await childCounts(loneOrg.orgId, loneOrg.children)).toEqual(ALL_CHILDREN_PRESENT);

    await expectDeleteNoRows(asUser(loneOwner.jwt), loneOrg.orgId, '所属の列を持つ人がいない組織のオーナー');

    expect(await orgRow(loneOrg.orgId)).toMatchObject({ status: 'active', owner_id: loneOwner.id, dissolved_at: null });
    expect(await childCounts(loneOrg.orgId, loneOrg.children)).toEqual(ALL_CHILDREN_PRESENT);
  }, TEST_TIMEOUT_MS);

  it('O-2: 所属のある組織のオーナー・管理者・メンバー・別の組織のオーナーの直接の DELETE も 0 行で、行と所属は残る', async () => {
    await expectDeleteNoRows(asUser(owner.jwt), org.orgId, 'オーナー');
    await expectDeleteNoRows(asUser(admin.jwt), org.orgId, '管理者');
    await expectDeleteNoRows(asUser(member.jwt), org.orgId, 'メンバー');
    await expectDeleteNoRows(asUser(otherOwner.jwt), org.orgId, '別の組織のオーナー');
    await expectDeleteNoRows(asUser(otherOwner.jwt), otherOrg.orgId, '別の組織のオーナー (自分の組織)');

    expect(await orgRow(org.orgId)).toMatchObject({ status: 'active', owner_id: owner.id });
    expect(await countRows('user_profiles', 'organization_id', org.orgId)).toBe(3);
    expect(await childCounts(org.orgId, org.children)).toEqual(ALL_CHILDREN_PRESENT);
    expect(await childCounts(otherOrg.orgId, otherOrg.children)).toEqual(ALL_CHILDREN_PRESENT);
  }, TEST_TIMEOUT_MS);

  it('O-3: 未認証の直接の DELETE は 42501 で、行は残る', async () => {
    await expectDeleteDenied(anon(), org.orgId, '未認証');
    await expectDeleteDenied(anon(), loneOrg.orgId, '未認証 (所属の列を持つ人がいない組織)');
    expect(await childCounts(loneOrg.orgId, loneOrg.children)).toEqual(ALL_CHILDREN_PRESENT);
  }, TEST_TIMEOUT_MS);

  it('O-4: ポリシーは SELECT・UPDATE と運営の DELETE だけ。anon は DELETE・TRUNCATE を持たず、authenticated は TRUNCATE を持たない', async () => {
    const policies = await pgQuery<{ policyname: string; cmd: string; roles: string }>(
      `SELECT policyname, cmd, roles::text AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organizations' ORDER BY policyname;`,
    );
    expect(policies).toEqual([
      { policyname: 'organizations_delete_super_admin', cmd: 'DELETE', roles: '{authenticated}' },
      { policyname: 'organizations_select_member', cmd: 'SELECT', roles: expect.any(String) },
      { policyname: 'organizations_update_admin', cmd: 'UPDATE', roles: '{authenticated}' },
    ]);

    const privileges = await pgQuery<{ role: string; privilege: string; allowed: boolean }>(`
      SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.organizations', p) AS allowed
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r,
             unnest(ARRAY['SELECT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
       ORDER BY r, p;`);
    const allowed = (role: string, privilege: string) => privileges.find((row) => row.role === role && row.privilege === privilege)?.allowed;
    expect(allowed('anon', 'DELETE')).toBe(false);
    expect(allowed('anon', 'TRUNCATE')).toBe(false);
    expect(allowed('authenticated', 'SELECT')).toBe(true);
    expect(allowed('authenticated', 'UPDATE')).toBe(true);
    // 運営の削除のポリシー (TO authenticated) のために残す
    expect(allowed('authenticated', 'DELETE')).toBe(true);
    expect(allowed('authenticated', 'TRUNCATE')).toBe(false);
    expect(allowed('service_role', 'DELETE')).toBe(true);

    // TRUNCATE は RLS が効かない。権限の確認は外部キーの確認 (参照されている表は CASCADE なしでは消せない) より先に行われる
    const claims = JSON.stringify({ sub: owner.id, role: 'authenticated' });
    const truncate = await pgRequest(`
      SELECT set_config('request.jwt.claims', '${claims}', true);
      SET LOCAL ROLE authenticated;
      TRUNCATE public.organizations;`);
    expect(truncate.ok, JSON.stringify(truncate.body)).toBe(false);
    expect((truncate.body as { code?: unknown } | null)?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await orgRow(org.orgId)).not.toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('#1917 の続き: 解散の仕組みと運営・service_role の削除は今までどおり動く', () => {
  it('O-5: オーナーの解散の RPC は通り、子の記録は残る。解散のあとも元のオーナーは直接 DELETE できない', async () => {
    const dissolveOwner = await createUser('o5-owner');
    const dissolveMember = await createUser('o5-member');
    const dissolving = await createOrg(dissolveOwner, 'o5', true);
    await setOrgMembership(dissolveMember, dissolving.orgId, 'member');

    const { error } = await asUser(dissolveOwner.jwt).rpc('dissolve_org_by_owner', { p_organization_id: dissolving.orgId });
    expect(error, JSON.stringify(error)).toBeNull();

    expect(await orgRow(dissolving.orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await auditCount(dissolving.orgId, 'group_dissolved')).toBe(1);
    expect(await countRows('user_profiles', 'organization_id', dissolving.orgId)).toBe(0);
    expect(await childCounts(dissolving.orgId, dissolving.children)).toEqual(ALL_CHILDREN_PRESENT);

    await expectDeleteNoRows(asUser(dissolveOwner.jwt), dissolving.orgId, '解散した組織の元のオーナー');
    expect(await childCounts(dissolving.orgId, dissolving.children)).toEqual(ALL_CHILDREN_PRESENT);
  }, TEST_TIMEOUT_MS);

  it('O-6: 運営の強制解散は今までどおり通る (組織の行は dissolved になり、消えない)', async () => {
    const operator = await createUser('o6-operator', ['user', 'super_admin']);
    const { client: sessionClient } = await signIn(operator.email);
    const aal2 = await promoteToAal2(sessionClient);
    const forcedOwner = await createUser('o6-owner');
    const forced = await createOrg(forcedOwner, 'o6', true);

    const { error } = await asUser(aal2).rpc('operator_force_dissolve_org', { p_organization_id: forced.orgId, p_reason: '#1917 org-no-direct-delete O-6' });
    expect(error, JSON.stringify(error)).toBeNull();
    expect(await orgRow(forced.orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await auditCount(forced.orgId, 'operator_force_dissolve')).toBe(1);
    expect(await childCounts(forced.orgId, forced.children)).toEqual(ALL_CHILDREN_PRESENT);
  }, TEST_TIMEOUT_MS);

  it('O-7: 運営 (super_admin・MFA 済み) の直接の DELETE は今までどおり通り、子の記録は CASCADE。MFA 前は 0 行', async () => {
    const operator = await createUser('o7-operator', ['user', 'super_admin']);
    const { client: sessionClient, jwt: aal1 } = await signIn(operator.email);
    const targetOwner = await createUser('o7-owner');
    // 所属の列を持つ人がいない組織 (所属が残ると SET NULL が CHECK user_profiles_org_consistency に当たる。修正の前後で同じ)
    const target = await createOrg(targetOwner, 'o7', false);

    await expectDeleteNoRows(asUser(aal1), target.orgId, '運営 (MFA 前)');
    expect(await childCounts(target.orgId, target.children)).toEqual(ALL_CHILDREN_PRESENT);

    const aal2 = await promoteToAal2(sessionClient);
    const { data, error } = await directDelete(asUser(aal2), target.orgId);
    expect(error, JSON.stringify(error)).toBeNull();
    expect(data).toEqual([{ id: target.orgId }]);
    expect(await orgRow(target.orgId)).toBeNull();
    expect(await childCounts(target.orgId, target.children)).toEqual(ALL_CHILDREN_GONE);
  }, TEST_TIMEOUT_MS);

  it('O-8: service_role の直接の DELETE (テストと e2e の後片付け) は今までどおり通る', async () => {
    const srOwner = await createUser('o8-owner');
    const srOrg = await createOrg(srOwner, 'o8', false);
    const { data, error } = await directDelete(srAdmin, srOrg.orgId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: srOrg.orgId }]);
    expect(await orgRow(srOrg.orgId)).toBeNull();
    expect(await childCounts(srOrg.orgId, srOrg.children)).toEqual(ALL_CHILDREN_GONE);
  }, TEST_TIMEOUT_MS);
});
