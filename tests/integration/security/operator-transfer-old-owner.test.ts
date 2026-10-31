/**
 * #1917 の続き: 運営の強制譲渡の監査 (admin_audit_logs の from_user_id) と旧オーナー / 旧代表者への知らせの宛先を、
 * RPC が組織 / 家族の行のロックの下で読んだ値にする修正の回帰テスト (実 DB)。
 *
 * 修正前: route (src/app/api/operator/membership/org/[id]/transfer/route.ts・family/[id]/transfer/route.ts) は RPC の前に
 *   ロックを取らずに owner_id / representative_id を読み、その値を監査の from_user_id と知らせの宛先に使った。RPC
 *   (operator_force_owner_transfer / operator_force_representative_transfer) は更新した後の行だけを返した。
 *   運営 2 人がほぼ同時に同じ組織 / 家族を譲渡すると、後の譲渡の直前のオーナーは先の譲渡の相手なのに、後の route は
 *   先に読んだ (先の譲渡の前の) 人を from_user_id に残した (membership_audit の old_owner_id / old_rep_id とも食い違う)。
 * 修正後 (supabase/migrations/20261023140000_operator_transfer_return_old_owner.sql): RPC は jsonb で、更新した後の行と、
 *   ロックの下で読んだ旧オーナー / 旧代表者 (membership_audit に書くのと同じ値) を返し、route はその値で監査と知らせを出す。
 *
 *   OTO-1 / OTO-4: 戻り値の形と値 (旧オーナー / 旧代表者は membership_audit の値と同じ)
 *   OTO-2 / OTO-5: 先の譲渡をコミット前のまま開いている間に後の譲渡を呼ぶと、後の譲渡は先の commit を待ち、先の譲渡の相手を旧オーナー / 旧代表者として返す
 *   OTO-3 / OTO-6: 同じ並びを route (本物の API) で通すと、監査の from_user_id は先の譲渡の相手 (route が RPC の前に読んだ人ではない)
 *   OTO-7: DROP して作り直した 2 つの関数の権限は本番と同じ (anon・PUBLIC は呼べない。authenticated・service_role は呼べる)
 *   OTO-8 / OTO-9: #2093 W5 (supabase/migrations/20261030120000_operator_force_transfer_reject_same.sql): 譲渡先がすでに今のオーナー /
 *     代表者なら、RPC は ALREADY_OWNER / ALREADY_REPRESENTATIVE で断り、membership_audit に旧 = 新の行を書かず、役割も変えない。
 *     ふつうの譲渡は今までどおり書く
 *   OTO-10 / OTO-11: 同じ人への譲渡が先に開いている間に route を呼ぶと (route の RPC の前の控えは先の譲渡の前のオーナー / 代表者)、
 *     route の RPC は先の commit を待ってから断り、route は 409 で admin_audit_logs を書かない。membership_audit は先の譲渡の 1 行だけ
 *
 * 先の譲渡をコミット前のまま開いておくのは、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う
 * (org-transfer-toctou.test.ts と同じ道具)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。OTO-3・OTO-6 は Next の開発サーバーも要る
 * (tests/integration/helpers/api.ts の apiCall。INTEGRATION_BASE_URL。scripts/local-ci.sh の integration は立てる)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/operator-transfer-old-owner.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { actAsAuthenticatedSql, createLockHolderKit, type Holder } from '../helpers/lock-holder';
import { promoteToAal2 } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { grantFamilyPlan } from '../helpers/family-plan';

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
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
/** 関数の実行権限が無いときの SQLSTATE (insufficient_privilege) */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

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
/** 成人の生年月日 (18 歳未満は家族・組織の役割を引き受けられない。#1173) */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 組織の席数 (テストで足りる数。席数の上限で断られる経路と混ざらないように) */
const ORG_TOTAL_LICENSES = 20;
/** 家族の人数の上限 (テストで足りる数。family-lock-order-race.test.ts と同じ) */
const FAMILY_MEMBER_LIMIT = 8;
const TEST_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 180_000;
const AAL2_CLAIMS = { aal: 'aal2' } as const;
const ORG_ACTION = 'super_admin.organization.transfer_admin';
const FAMILY_ACTION = 'super_admin.family.transfer_representative';

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdFamilyIds: string[] = [];

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-op-transfer-old-owner-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `op-transfer-${label}`,
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

/** 運営 (super_admin・aal2)。route は aal2 のセッションだけを通す */
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
// 組織と家族の用意
// ---------------------------------------------------------------------------------------------

/** 組織を作り、owner をオーナー、admins を admin として所属させる */
async function createOrg(owner: TestUser, admins: TestUser[], label: string): Promise<string> {
  const { data, error } = await srAdmin.from('organizations').insert({ name: `op-transfer ${label} ${TS}`, owner_id: owner.id }).select('id').single();
  if (error || !data) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = data.id as string;
  createdOrgIds.push(orgId);
  const { error: poolError } = await retryIdempotentSetup(srAdmin, 'createOrg: org_license_pools の upsert', (db) =>
    db.from('org_license_pools').upsert(
      { organization_id: orgId, total_licenses: ORG_TOTAL_LICENSES, used_licenses: 1 + admins.length },
      { onConflict: 'organization_id' },
    ));
  if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  const join = async (user: TestUser, role: 'owner' | 'admin') => {
    const { error: memberError } = await srAdmin
      .from('user_profiles')
      .update({ organization_id: orgId, org_role: role, is_active_in_org: true, joined_org_at: new Date().toISOString(), roles: ['user', 'org_admin'] })
      .eq('id', user.id);
    if (memberError) throw new Error(`membership ${label}: ${memberError.message}`);
  };
  await join(owner, 'owner');
  for (const admin of admins) await join(admin, 'admin');
  return orgId;
}

/** 代表者 rep の家族を作り、adults を招待 → 承諾で大人として入れる */
async function createFamily(rep: TestUser, adults: TestUser[], label: string): Promise<string> {
  // billing/03 §6.6: 家族グループは家族プランの契約者だけが作れるので、作る前に家族プランを手動付与する
  await grantFamilyPlan(srAdmin, rep.id);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', { p_name: `op-transfer ${label} ${TS}`, p_plan_key: 'free' });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  // 人数の上限で断られる経路と混ざらないよう、上限を広げる (service_role は上限の列を直接変えられる)
  const { error: limitError } = await srAdmin.from('family_groups').update({ member_limit: FAMILY_MEMBER_LIMIT }).eq('id', familyId);
  if (limitError) throw new Error(`member_limit ${label}: ${limitError.message}`);
  for (const adult of adults) {
    const invite = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: adult.email });
    if (invite.error || !invite.data) throw new Error(`create_family_invite ${label}: ${invite.error?.message}`);
    const { error: acceptError } = await asUser(adult.jwt).rpc('accept_family_invite', { p_token: (invite.data as { token: string }).token });
    if (acceptError) throw new Error(`accept_family_invite ${label}: ${acceptError.message}`);
  }
  return familyId;
}

async function orgOwnerId(orgId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('organizations').select('owner_id').eq('id', orgId).single();
  if (error || !data) throw new Error(`organizations: ${error?.message}`);
  return (data as { owner_id: string | null }).owner_id;
}

async function orgRoleOf(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('org_role').eq('id', userId).single();
  if (error || !data) throw new Error(`user_profiles: ${error?.message}`);
  return (data as { org_role: string | null }).org_role;
}

/** 家族の active なメンバーの役割 (user_id → role) */
async function familyRoles(familyId: string): Promise<Record<string, string>> {
  const { data, error } = await srAdmin.from('family_members').select('user_id, role').eq('family_id', familyId).eq('status', 'active');
  if (error) throw new Error(`family_members: ${error.message}`);
  return Object.fromEntries((data ?? []).map((row) => [(row as { user_id: string }).user_id, (row as { role: string }).role]));
}

async function familyRepresentativeId(familyId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('family_groups').select('representative_id').eq('id', familyId).single();
  if (error || !data) throw new Error(`family_groups: ${error?.message}`);
  return (data as { representative_id: string | null }).representative_id;
}

/** membership_audit の運営の強制譲渡の行の metadata の、旧オーナー / 旧代表者 (書いた順) */
async function membershipAuditPriors(scopeId: string, action: string, key: 'old_owner_id' | 'old_rep_id'): Promise<unknown[]> {
  const { data, error } = await srAdmin
    .from('membership_audit')
    .select('metadata, created_at')
    .eq('scope_id', scopeId)
    .eq('action', action)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return (data ?? []).map((row) => (row as { metadata: Record<string, unknown> }).metadata[key]);
}

/** admin_audit_logs の route の監査の details */
async function adminAuditDetails(targetId: string, actionType: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await srAdmin.from('admin_audit_logs').select('details').eq('target_id', targetId).eq('action_type', actionType);
  if (error) throw new Error(`admin_audit_logs: ${error.message}`);
  return (data ?? []).map((row) => (row as { details: Record<string, unknown> }).details);
}

// ---------------------------------------------------------------------------------------------
// RPC と、先の譲渡をコミット前のまま開いておく接続
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

async function transferOrg(jwt: string, orgId: string, newOwnerId: string): Promise<Outcome> {
  const { data, error } = await asUser(jwt).rpc('operator_force_owner_transfer', {
    p_organization_id: orgId,
    p_new_owner_id: newOwnerId,
    p_reason: 'op-transfer-old-owner',
  });
  return toOutcome(data, error);
}

async function transferFamily(jwt: string, familyId: string, newRepId: string): Promise<Outcome> {
  const { data, error } = await asUser(jwt).rpc('operator_force_representative_transfer', {
    p_family_id: familyId,
    p_new_rep_id: newRepId,
    p_reason: 'op-transfer-old-owner',
  });
  return toOutcome(data, error);
}

const orgTransferSql = (orgId: string, newOwnerId: string) =>
  `public.operator_force_owner_transfer('${orgId}'::uuid, '${newOwnerId}'::uuid, 'op-transfer-old-owner hold')`;
const familyTransferSql = (familyId: string, newRepId: string) =>
  `public.operator_force_representative_transfer('${familyId}'::uuid, '${newRepId}'::uuid, 'op-transfer-old-owner hold')`;

/**
 * 運営 actor (aal2) として callSql を呼び、コミット前のまま開いておく接続 (終わりを待たない。tests/integration/helpers/lock-holder.ts)。
 * 後の譲渡が行のロックの待ちに並んだのを確かめてから放す (決まった秒数の窓で「並んだはず」と仮定しない。#1917)
 */
const holders = createLockHolderKit({ pgRequest, markerPrefix: 'op-transfer-old-owner' });

function holdCall(actor: TestUser, callSql: string): Holder {
  return holders.startHolder(callSql, `${actAsAuthenticatedSql(actor.id, AAL2_CLAIMS)}
    SELECT * FROM ${callSql};`);
}

// テストが途中で落ちたときに残った接続を、作った順に放す (通ったテストでは全部放し終わっているので何もしない)
afterEach(() => holders.releaseOpenHolders(), CLEANUP_TIMEOUT_MS);

afterAll(async () => {
  await holders.settle();
  if (createdUserIds.length > 0) {
    // admin_audit_logs.actor_id には ON DELETE の指定が無い外部キーもあるので、利用者より先に消す
    await srAdmin.from('admin_audit_logs').delete().in('actor_id', createdUserIds);
    await srAdmin.from('user_profiles').update({ organization_id: null, org_role: null, is_active_in_org: false }).in('id', createdUserIds);
  }
  const scopeIds = [...createdOrgIds, ...createdFamilyIds];
  if (scopeIds.length > 0) await srAdmin.from('membership_audit').delete().in('scope_id', scopeIds);
  if (createdOrgIds.length > 0) {
    await srAdmin.from('org_license_pools').delete().in('organization_id', createdOrgIds);
    // organizations.owner_id は ON DELETE RESTRICT なので、利用者より先に組織を消す
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  // family_members / family_invites は CASCADE。family_groups.representative_id も ON DELETE RESTRICT なので利用者より先に消す
  if (createdFamilyIds.length > 0) await srAdmin.from('family_groups').delete().in('id', createdFamilyIds);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, CLEANUP_TIMEOUT_MS);

// ---------------------------------------------------------------------------------------------
// 組織 (operator_force_owner_transfer)
// ---------------------------------------------------------------------------------------------

describe('operator_force_owner_transfer: 戻り値の旧オーナーは、組織の行のロックの下で読んだ owner_id', () => {
  it('OTO-1: 戻り値は {organization: 更新した後の行, old_owner_id: 旧オーナー}。old_owner_id は membership_audit の old_owner_id と同じ', async () => {
    const op = await operator();
    const [owner, next] = await createUsers('oto1', 2);
    const orgId = await createOrg(owner, [next], 'oto1');

    const result = await transferOrg(op.jwt, orgId, next.id);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ organization: { id: orgId, owner_id: next.id, name: `op-transfer oto1 ${TS}` }, old_owner_id: owner.id });
    expect(Object.keys(result.data as object).sort()).toEqual(['old_owner_id', 'organization']);
    expect(await membershipAuditPriors(orgId, 'operator_force_owner_transfer', 'old_owner_id')).toEqual([owner.id]);
  }, TEST_TIMEOUT_MS);

  it('OTO-2: 先の譲渡 (A → B) をコミット前のまま開いている間に後の譲渡 (→ C) を呼ぶと、後の譲渡は先の commit を待ち、旧オーナーとして B を返す', async () => {
    const op = await operator();
    const [a, b, c] = await createUsers('oto2', 3);
    const orgId = await createOrg(a, [b, c], 'oto2');

    const holder = holdCall(op.user, orgTransferSql(orgId, b.id));
    const [held, later] = await holders.runBehindHolder(holder, {
      fn: 'operator_force_owner_transfer',
      call: () => transferOrg(op.jwt, orgId, c.id),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(later.ok, JSON.stringify(later)).toBe(true);
    expect(later.data).toMatchObject({ organization: { owner_id: c.id }, old_owner_id: b.id });
    expect(await orgOwnerId(orgId)).toBe(c.id);
    expect(await membershipAuditPriors(orgId, 'operator_force_owner_transfer', 'old_owner_id')).toEqual([a.id, b.id]);
  }, TEST_TIMEOUT_MS);

  it('OTO-3: route (POST /api/operator/membership/org/{id}/transfer) を同じ並びで通すと、監査の from_user_id は先の譲渡の相手 B (route が RPC の前に読んだ A ではない)', async () => {
    const op = await operator();
    const [a, b, c] = await createUsers('oto3', 3);
    const orgId = await createOrg(a, [b, c], 'oto3');
    const routePath = `/api/operator/membership/org/${orgId}/transfer`;
    // route を先に一度呼んでおき (入力の誤りで 400。何も書かない)、開発サーバーの初回のコンパイルを先の譲渡を開く前に済ませる
    expect((await apiCall('POST', routePath, op.jwt, {})).status).toBe(HTTP_BAD_REQUEST);

    const holder = holdCall(op.user, orgTransferSql(orgId, b.id));
    // route の RPC が先の譲渡に待たされて組織の行のロックの待ちに入った = route の RPC の前の読み取りは、先の譲渡の commit より前
    // (owner_id = A を読んだ)。待ちに入ったのを確かめてから先の譲渡を放す
    const [held, res] = await holders.runBehindHolder(holder, {
      fn: 'operator_force_owner_transfer',
      call: () => apiCall<{ data: Record<string, unknown> }>('POST', routePath, op.jwt, { to_user_id: c.id, reason: 'oto3' }),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(HTTP_OK);
    expect(res.body.data).toMatchObject({ id: orgId, owner_id: c.id });
    expect(res.body.data).not.toHaveProperty('old_owner_id');
    expect(await orgOwnerId(orgId)).toBe(c.id);
    expect(await adminAuditDetails(orgId, ORG_ACTION)).toEqual([{ reason: 'oto3', to_user_id: c.id, from_user_id: b.id }]);
    expect(await membershipAuditPriors(orgId, 'operator_force_owner_transfer', 'old_owner_id')).toEqual([a.id, b.id]);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 家族 (operator_force_representative_transfer)
// ---------------------------------------------------------------------------------------------

describe('operator_force_representative_transfer: 戻り値の旧代表者は、家族の行のロックの下で読んだ representative_id', () => {
  it('OTO-4: 戻り値は {family_group: 更新した後の行, old_rep_id: 旧代表者}。old_rep_id は membership_audit の old_rep_id と同じ', async () => {
    const op = await operator();
    const [rep, adult] = await createUsers('oto4', 2);
    const familyId = await createFamily(rep, [adult], 'oto4');

    const result = await transferFamily(op.jwt, familyId, adult.id);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ family_group: { id: familyId, representative_id: adult.id, name: `op-transfer oto4 ${TS}` }, old_rep_id: rep.id });
    expect(Object.keys(result.data as object).sort()).toEqual(['family_group', 'old_rep_id']);
    expect(await membershipAuditPriors(familyId, 'operator_force_representative_transfer', 'old_rep_id')).toEqual([rep.id]);
  }, TEST_TIMEOUT_MS);

  it('OTO-5: 先の譲渡 (A → B) をコミット前のまま開いている間に後の譲渡 (→ C) を呼ぶと、後の譲渡は先の commit を待ち、旧代表者として B を返す', async () => {
    const op = await operator();
    const [a, b, c] = await createUsers('oto5', 3);
    const familyId = await createFamily(a, [b, c], 'oto5');

    const holder = holdCall(op.user, familyTransferSql(familyId, b.id));
    const [held, later] = await holders.runBehindHolder(holder, {
      fn: 'operator_force_representative_transfer',
      call: () => transferFamily(op.jwt, familyId, c.id),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(later.ok, JSON.stringify(later)).toBe(true);
    expect(later.data).toMatchObject({ family_group: { representative_id: c.id }, old_rep_id: b.id });
    expect(await familyRepresentativeId(familyId)).toBe(c.id);
    expect(await membershipAuditPriors(familyId, 'operator_force_representative_transfer', 'old_rep_id')).toEqual([a.id, b.id]);
  }, TEST_TIMEOUT_MS);

  it('OTO-6: route (POST /api/operator/membership/family/{id}/transfer) を同じ並びで通すと、監査の from_user_id は先の譲渡の相手 B (route が RPC の前に読んだ A ではない)', async () => {
    const op = await operator();
    const [a, b, c] = await createUsers('oto6', 3);
    const familyId = await createFamily(a, [b, c], 'oto6');
    const routePath = `/api/operator/membership/family/${familyId}/transfer`;
    // route を先に一度呼んでおき (入力の誤りで 400。何も書かない)、開発サーバーの初回のコンパイルを先の譲渡を開く前に済ませる
    expect((await apiCall('POST', routePath, op.jwt, {})).status).toBe(HTTP_BAD_REQUEST);

    const holder = holdCall(op.user, familyTransferSql(familyId, b.id));
    // route の RPC が先の譲渡に待たされて家族の行のロックの待ちに入った = route の RPC の前の読み取りは、先の譲渡の commit より前
    // (representative_id = A を読んだ)。待ちに入ったのを確かめてから先の譲渡を放す
    const [held, res] = await holders.runBehindHolder(holder, {
      fn: 'operator_force_representative_transfer',
      call: () => apiCall<{ data: Record<string, unknown> }>('POST', routePath, op.jwt, { to_user_id: c.id, reason: 'oto6' }),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(HTTP_OK);
    expect(res.body.data).toMatchObject({ id: familyId, representative_id: c.id });
    expect(res.body.data).not.toHaveProperty('old_rep_id');
    expect(await familyRepresentativeId(familyId)).toBe(c.id);
    expect(await adminAuditDetails(familyId, FAMILY_ACTION)).toEqual([{ reason: 'oto6', to_user_id: c.id, from_user_id: b.id }]);
    expect(await membershipAuditPriors(familyId, 'operator_force_representative_transfer', 'old_rep_id')).toEqual([a.id, b.id]);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 権限 (DROP して作り直したので、付け直した権限が本番と同じこと)
// ---------------------------------------------------------------------------------------------

describe('OTO-7: 作り直した 2 つの関数の権限と戻り値の型', () => {
  const SIGNATURES = [
    'public.operator_force_owner_transfer(uuid, uuid, text)',
    'public.operator_force_representative_transfer(uuid, uuid, text)',
  ] as const;

  it.each(SIGNATURES)('%s: 戻り値は jsonb・SECURITY DEFINER。EXECUTE は authenticated と service_role だけ (anon・PUBLIC は無い)', async (signature) => {
    const [row] = await pgQuery<{
      result: string;
      secdef: boolean;
      anon: boolean;
      authenticated: boolean;
      service_role: boolean;
      public_grant: boolean;
    }>(`
      SELECT pg_get_function_result(p.oid) AS result,
             p.prosecdef AS secdef,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
             (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_grant
      FROM pg_proc p WHERE p.oid = '${signature}'::regprocedure`);
    expect(row).toEqual({ result: 'jsonb', secdef: true, anon: false, authenticated: true, service_role: true, public_grant: false });
  }, TEST_TIMEOUT_MS);

  it('anon は呼べず (42501)、super_admin でない人は NOT_OPERATOR で止まる (どちらも何も変えない)', async () => {
    const [owner, next, plain] = await createUsers('oto7', 3);
    const orgId = await createOrg(owner, [next], 'oto7');

    const byAnon = await anon().rpc('operator_force_owner_transfer', { p_organization_id: orgId, p_new_owner_id: next.id, p_reason: 'x' });
    expect(byAnon.error?.code, JSON.stringify(byAnon.error)).toBe(PG_INSUFFICIENT_PRIVILEGE);
    const byPlain = await transferOrg(plain.jwt, orgId, next.id);
    expect(byPlain).toMatchObject({ ok: false, code: 'P0001', message: 'NOT_OPERATOR' });
    expect(await orgOwnerId(orgId)).toBe(owner.id);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// #2093 W5: 譲渡先がすでに今のオーナー / 代表者なら、RPC は書く前に断る
// ---------------------------------------------------------------------------------------------

describe('#2093 W5: 新 = 旧の強制譲渡は、RPC が membership_audit を書く前に断る (20261030120000_operator_force_transfer_reject_same.sql)', () => {
  it('OTO-8: 組織: 今のオーナーへの譲渡は ALREADY_OWNER (P0001) で断り、オーナー・役割・membership_audit を変えない。ふつうの譲渡は今までどおり書く', async () => {
    const op = await operator();
    const [owner, next] = await createUsers('oto8', 2);
    const orgId = await createOrg(owner, [next], 'oto8');

    const same = await transferOrg(op.jwt, orgId, owner.id);

    expect(same).toMatchObject({ ok: false, code: 'P0001', message: 'ALREADY_OWNER' });
    expect(await orgOwnerId(orgId)).toBe(owner.id);
    expect(await orgRoleOf(owner.id)).toBe('owner');
    expect(await orgRoleOf(next.id)).toBe('admin');
    expect(await membershipAuditPriors(orgId, 'operator_force_owner_transfer', 'old_owner_id')).toEqual([]);

    const normal = await transferOrg(op.jwt, orgId, next.id);

    expect(normal.ok, JSON.stringify(normal)).toBe(true);
    expect(normal.data).toMatchObject({ organization: { owner_id: next.id }, old_owner_id: owner.id });
    expect(await membershipAuditPriors(orgId, 'operator_force_owner_transfer', 'old_owner_id')).toEqual([owner.id]);

    // 譲渡した後に同じ人へもう一度 (押し直し) も断り、2 行目を書かない
    const again = await transferOrg(op.jwt, orgId, next.id);

    expect(again).toMatchObject({ ok: false, code: 'P0001', message: 'ALREADY_OWNER' });
    expect(await membershipAuditPriors(orgId, 'operator_force_owner_transfer', 'old_owner_id')).toEqual([owner.id]);
  }, TEST_TIMEOUT_MS);

  it('OTO-9: 家族: 今の代表者への譲渡は ALREADY_REPRESENTATIVE (P0001) で断り、代表者・役割・membership_audit を変えない。ふつうの譲渡は今までどおり書く', async () => {
    const op = await operator();
    const [rep, adult] = await createUsers('oto9', 2);
    const familyId = await createFamily(rep, [adult], 'oto9');

    const same = await transferFamily(op.jwt, familyId, rep.id);

    expect(same).toMatchObject({ ok: false, code: 'P0001', message: 'ALREADY_REPRESENTATIVE' });
    expect(await familyRepresentativeId(familyId)).toBe(rep.id);
    expect(await familyRoles(familyId)).toEqual({ [rep.id]: 'representative', [adult.id]: 'adult' });
    expect(await membershipAuditPriors(familyId, 'operator_force_representative_transfer', 'old_rep_id')).toEqual([]);

    const normal = await transferFamily(op.jwt, familyId, adult.id);

    expect(normal.ok, JSON.stringify(normal)).toBe(true);
    expect(normal.data).toMatchObject({ family_group: { representative_id: adult.id }, old_rep_id: rep.id });
    expect(await membershipAuditPriors(familyId, 'operator_force_representative_transfer', 'old_rep_id')).toEqual([rep.id]);

    const again = await transferFamily(op.jwt, familyId, adult.id);

    expect(again).toMatchObject({ ok: false, code: 'P0001', message: 'ALREADY_REPRESENTATIVE' });
    expect(await membershipAuditPriors(familyId, 'operator_force_representative_transfer', 'old_rep_id')).toEqual([rep.id]);
  }, TEST_TIMEOUT_MS);

  it('OTO-10: 組織: 先の譲渡 (A → B) を開いている間に route で B へ譲渡すると、route の RPC は先の commit を待って断り、route は 409 ALREADY_OWNER。admin_audit_logs は無く、membership_audit は先の 1 行だけ', async () => {
    const op = await operator();
    const [a, b] = await createUsers('oto10', 2);
    const orgId = await createOrg(a, [b], 'oto10');
    const routePath = `/api/operator/membership/org/${orgId}/transfer`;
    // 開発サーバーの初回のコンパイルを先の譲渡を開く前に済ませる (入力の誤りで 400。何も書かない)
    expect((await apiCall('POST', routePath, op.jwt, {})).status).toBe(HTTP_BAD_REQUEST);

    const holder = holdCall(op.user, orgTransferSql(orgId, b.id));
    // route の RPC が組織の行のロックの待ちに入った = route の RPC の前の控えは先の commit より前 (owner_id = A を読み、1 つ目の判定を通った)
    const [held, res] = await holders.runBehindHolder(holder, {
      fn: 'operator_force_owner_transfer',
      call: () => apiCall<{ error?: { code?: string } }>('POST', routePath, op.jwt, { to_user_id: b.id, reason: 'oto10' }),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(HTTP_CONFLICT);
    expect(res.body.error?.code).toBe('ALREADY_OWNER');
    expect(await orgOwnerId(orgId)).toBe(b.id);
    expect(await adminAuditDetails(orgId, ORG_ACTION)).toEqual([]);
    expect(await membershipAuditPriors(orgId, 'operator_force_owner_transfer', 'old_owner_id')).toEqual([a.id]);
  }, TEST_TIMEOUT_MS);

  it('OTO-11: 家族: 先の譲渡 (A → B) を開いている間に route で B へ譲渡すると、route の RPC は先の commit を待って断り、route は 409 ALREADY_REPRESENTATIVE。admin_audit_logs は無く、membership_audit は先の 1 行だけ', async () => {
    const op = await operator();
    const [a, b] = await createUsers('oto11', 2);
    const familyId = await createFamily(a, [b], 'oto11');
    const routePath = `/api/operator/membership/family/${familyId}/transfer`;
    expect((await apiCall('POST', routePath, op.jwt, {})).status).toBe(HTTP_BAD_REQUEST);

    const holder = holdCall(op.user, familyTransferSql(familyId, b.id));
    const [held, res] = await holders.runBehindHolder(holder, {
      fn: 'operator_force_representative_transfer',
      call: () => apiCall<{ error?: { code?: string } }>('POST', routePath, op.jwt, { to_user_id: b.id, reason: 'oto11' }),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(HTTP_CONFLICT);
    expect(res.body.error?.code).toBe('ALREADY_REPRESENTATIVE');
    expect(await familyRepresentativeId(familyId)).toBe(b.id);
    expect(await adminAuditDetails(familyId, FAMILY_ACTION)).toEqual([]);
    expect(await membershipAuditPriors(familyId, 'operator_force_representative_transfer', 'old_rep_id')).toEqual([a.id]);
  }, TEST_TIMEOUT_MS);
});
