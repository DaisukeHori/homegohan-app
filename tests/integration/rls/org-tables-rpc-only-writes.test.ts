/**
 * #1917: 組織の席数 (org_license_pools) と招待 (organization_invites) への、利用者の直接の書き込みを外す
 * (migration 20261022180000_org_tables_rpc_only_writes.sql)。
 *
 * 修正前は、組織の owner / admin が PostgREST の直接の書き込みで
 *   - org_license_pools の total_licenses / used_licenses を UPDATE でき (ポリシー org_license_pools_update_admin)、
 *     create_org_invite と accept_org_invite の席数の上限 (SEAT_LIMIT_EXCEEDED) を外せた
 *   - organization_invites の行を INSERT / UPDATE でき (org_invites_insert_admin / org_invites_update_admin と FOR ALL の
 *     "Org admins can manage invites")、create_org_invite の門 (ALREADY_IN_ORG・SEAT_LIMIT_EXCEEDED・RATE_LIMITED) を通らずに
 *     invited_role = 'owner' の招待なども作れた
 *   - create_org_invite を直接呼べば、p_role = 'owner' の招待を作れた (route の Zod だけが断っていた)
 *
 * 確かめること:
 *   - 直接の INSERT / UPDATE / DELETE (席数) と INSERT / UPDATE (招待) は、owner・admin・一般メンバー・未認証のだれでも 42501 で止まり、
 *     行は作られず・変わらない
 *   - 招待の直接の DELETE (DELETE /api/org/invites の経路) は、今までどおり同じ組織の owner / admin だけができる
 *   - SELECT (組織の画面が読む) は今までどおり
 *   - RPC 経由の招待の作成 (create_org_invite)・作り直しの取り消し・取り消し (revoke_org_invite)・拒否 (reject_org_invite)・
 *     承諾 (accept_org_invite)・脱退 (leave_org) と、席数の上限は今までどおり
 *   - create_org_invite に 'owner' を渡すと INSUFFICIENT_PERMISSION (組織の管理者でない人には先に NOT_ORG_ADMIN)
 *   - カタログ: 2 つの表の書き込みの権限とポリシー、create_org_invite の属性と EXECUTE の権限
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/org-tables-rpc-only-writes.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
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

/** ローカルスタックの postgres-meta で SQL を実行する (カタログの確認だけに使う。読み取り専用) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

/** 権限が無い書き込み (permission denied) の SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** RPC の RAISE EXCEPTION ... USING ERRCODE = 'P0001' */
const RAISED = 'P0001';
/** 成人の生年月日 (承諾の年齢の判定に掛からない値) */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 組織の席数 (このテストで足りる数。席数の上限の確認は専用の組織で行う) */
const ORG_TOTAL_LICENSES = 20;
/** 直接の INSERT で入れようとする招待の期限 (create_org_invite と同じ 14 日。値そのものは判定に関わらない) */
const DIRECT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** 直接の UPDATE で書こうとする、先へ延ばした期限 (今から 1 年) */
const EXTENDED_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
/** 招待のトークンのバイト数 (hex で 64 文字。create_org_invite と同じ形) */
const TOKEN_BYTES = 32;
/** 直接の UPDATE で席数の上限を外そうとする値 (大きな上限) */
const TAMPERED_TOTAL_LICENSES = 100_000;
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒。利用者・組織を複数作る) */
const SETUP_TIMEOUT_MS = 180_000;

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  token: string;
  status: string;
  invited_role: string;
  expires_at: string;
  invited_by: string | null;
  revoked_by: string | null;
}

interface PoolRow {
  total_licenses: number | null;
  used_licenses: number;
}

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
let seq = 0;

const address = (label: string) => `rls-org-rpc-only-${label}-${RUN}-${++seq}@homegohan.test`;

async function createUser(label: string): Promise<TestUser> {
  const email = address(`user-${label}`);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      { id: data.user.id, nickname: `org-rpc-only-${label}`, age_group: '30s', gender: 'other', birth_date: ADULT_BIRTH_DATE },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

/**
 * 組織を service_role で作り、オーナーを owner として所属させる。pool を渡したときだけ席数の行を作る
 * (used_licenses はオーナーの 1 席から始める)
 */
async function createOrg(owner: TestUser, label: string, pool: { total: number | null } | null): Promise<string> {
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `org-rpc-only ${label} ${RUN}`, owner_id: owner.id })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = (data as { id: string }).id;
  createdOrgIds.push(orgId);
  if (pool) {
    const { error: poolError } = await retryIdempotentSetup(srAdmin, 'createOrg: org_license_pools の upsert', (db) =>
      db.from('org_license_pools').upsert(
        { organization_id: orgId, total_licenses: pool.total, used_licenses: 1 },
        { onConflict: 'organization_id' },
      ));
    if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  }
  const { error: memberError } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: 'owner', is_active_in_org: true, joined_org_at: new Date().toISOString() })
    .eq('id', owner.id);
  if (memberError) throw new Error(`membership ${label}: ${memberError.message}`);
  return orgId;
}

async function createInvite(inviter: TestUser, orgId: string, email: string, role: 'admin' | 'member' | 'owner' = 'member') {
  return asUser(inviter.jwt).rpc('create_org_invite', { p_organization_id: orgId, p_email: email, p_role: role });
}

async function inviteViaRpc(inviter: TestUser, orgId: string, email: string, role: 'admin' | 'member' = 'member'): Promise<InviteRow> {
  const { data, error } = await createInvite(inviter, orgId, email, role);
  if (error || !data) throw new Error(`create_org_invite: ${error?.message}`);
  return data as InviteRow;
}

async function joinViaRpc(inviter: TestUser, orgId: string, user: TestUser, role: 'admin' | 'member'): Promise<void> {
  const invite = await inviteViaRpc(inviter, orgId, user.email, role);
  const { error } = await asUser(user.jwt).rpc('accept_org_invite', { p_token: invite.token });
  if (error) throw new Error(`accept_org_invite (${role}): ${error.message}`);
}

async function inviteRowById(id: string): Promise<InviteRow | null> {
  const { data, error } = await srAdmin.from('organization_invites').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return (data as InviteRow | null) ?? null;
}

async function inviteRowsFor(orgId: string, email: string): Promise<InviteRow[]> {
  const { data, error } = await srAdmin
    .from('organization_invites')
    .select('*')
    .eq('organization_id', orgId)
    .eq('email', email.toLowerCase());
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return (data ?? []) as InviteRow[];
}

async function poolOf(orgId: string): Promise<PoolRow | null> {
  const { data, error } = await srAdmin
    .from('org_license_pools')
    .select('total_licenses, used_licenses')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw new Error(`org_license_pools: ${error.message}`);
  return (data as PoolRow | null) ?? null;
}

async function setPool(orgId: string, pool: PoolRow): Promise<void> {
  const { error } = await srAdmin.from('org_license_pools').update(pool).eq('organization_id', orgId);
  if (error) throw new Error(`org_license_pools (service_role): ${error.message}`);
}

/** PostgREST に直接送る招待の行 (RPC を通らない作成。token・status・期限・役割を呼び出し元が決める) */
function directInviteRow(orgId: string, inviter: TestUser, email: string, role: 'owner' | 'admin' | 'member') {
  return {
    organization_id: orgId,
    email,
    token: randomBytes(TOKEN_BYTES).toString('hex'),
    invited_role: role,
    status: 'pending',
    expires_at: new Date(Date.now() + DIRECT_INVITE_TTL_MS).toISOString(),
    invited_by: inviter.id,
  };
}

function expectRaised(error: { code?: string; message?: string } | null, code: string): void {
  expect(error, `${code} で断られること`).not.toBeNull();
  expect(error!.code).toBe(RAISED);
  expect(error!.message).toBe(code);
}

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let otherOwner: TestUser;
/** owner の組織 (席数 ORG_TOTAL_LICENSES。admin と member が RPC の招待で入っている) */
let orgA: string;
/** 別の組織 */
let orgB: string;
/** 席数の行がまだ無い組織 (直接の INSERT の対象) */
let orgNoPool: string;
let orgNoPoolOwner: TestUser;
/** orgA の pending の招待 (RPC で作る。直接の UPDATE / DELETE の対象) */
let pendingInvite: InviteRow;

beforeAll(async () => {
  owner = await createUser('owner');
  admin = await createUser('admin');
  member = await createUser('member');
  otherOwner = await createUser('other-owner');
  orgNoPoolOwner = await createUser('no-pool-owner');
  orgA = await createOrg(owner, 'A', { total: ORG_TOTAL_LICENSES });
  orgB = await createOrg(otherOwner, 'B', { total: ORG_TOTAL_LICENSES });
  orgNoPool = await createOrg(orgNoPoolOwner, 'no-pool', null);

  // admin と member は、RPC の招待の作成 → 承諾で入れる (今までどおりの経路)
  await joinViaRpc(owner, orgA, admin, 'admin');
  await joinViaRpc(owner, orgA, member, 'member');

  pendingInvite = await inviteViaRpc(owner, orgA, address('pending'));
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  // organization_invites / org_license_pools は organizations の削除で CASCADE
  if (createdOrgIds.length > 0) await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, SETUP_TIMEOUT_MS);

describe('#1917 org_license_pools の直接の書き込みは、だれでも 42501 で止まり、席数は変わらない', () => {
  it('P-1: owner は total_licenses を直接 UPDATE できない (席数の上限を外せない)', async () => {
    const before = await poolOf(orgA);
    const { error } = await asUser(owner.jwt)
      .from('org_license_pools')
      .update({ total_licenses: null })
      .eq('organization_id', orgA)
      .select('organization_id');
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await poolOf(orgA)).toEqual(before);
  });

  it('P-2: admin は used_licenses と total_licenses を直接 UPDATE できない', async () => {
    const before = await poolOf(orgA);
    const { error } = await asUser(admin.jwt)
      .from('org_license_pools')
      .update({ used_licenses: 0, total_licenses: TAMPERED_TOTAL_LICENSES })
      .eq('organization_id', orgA)
      .select('organization_id');
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await poolOf(orgA)).toEqual(before);
  });

  it('P-3: 一般メンバー・別の組織のオーナー・未認証も直接 UPDATE できない', async () => {
    const before = await poolOf(orgA);
    for (const db of [asUser(member.jwt), asUser(otherOwner.jwt), anon()]) {
      const { error } = await db.from('org_license_pools').update({ total_licenses: null }).eq('organization_id', orgA);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await poolOf(orgA)).toEqual(before);
  });

  it('P-4: 席数の行が無い組織のオーナーは、席数の行を直接 INSERT できない', async () => {
    const { error } = await asUser(orgNoPoolOwner.jwt)
      .from('org_license_pools')
      .insert({ organization_id: orgNoPool, total_licenses: TAMPERED_TOTAL_LICENSES, used_licenses: 0 });
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await poolOf(orgNoPool)).toBeNull();
  });

  it('P-5: owner は席数の行を直接 DELETE できない (行が残る)', async () => {
    const before = await poolOf(orgA);
    const { error } = await asUser(owner.jwt).from('org_license_pools').delete().eq('organization_id', orgA);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await poolOf(orgA)).toEqual(before);
  });

  it('P-6: 同じ組織のメンバーは、今までどおり席数を読める (別の組織の行は読めない)', async () => {
    const own = await asUser(member.jwt).from('org_license_pools').select('organization_id, used_licenses').eq('organization_id', orgA);
    expect(own.error).toBeNull();
    expect(own.data).toHaveLength(1);
    const other = await asUser(member.jwt).from('org_license_pools').select('organization_id').eq('organization_id', orgB);
    expect(other.error).toBeNull();
    expect(other.data ?? []).toHaveLength(0);
  });
});

describe('#1917 organization_invites の直接の INSERT / UPDATE は、だれでも 42501 で止まる', () => {
  it('I-1: owner は owner の役割の招待を直接 INSERT できない (行は作られない)', async () => {
    const email = address('direct-owner');
    const { error } = await asUser(owner.jwt).from('organization_invites').insert(directInviteRow(orgA, owner, email, 'owner'));
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await inviteRowsFor(orgA, email)).toEqual([]);
  });

  it('I-2: admin は、すでに在籍している人宛ての招待も直接 INSERT できない (ALREADY_IN_ORG の門を迂回できない)', async () => {
    const { error } = await asUser(admin.jwt).from('organization_invites').insert(directInviteRow(orgA, admin, member.email, 'admin'));
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    // member の招待は承諾済みの 1 件だけ (直接の INSERT の pending の行は無い)
    expect((await inviteRowsFor(orgA, member.email)).map((row) => row.status)).toEqual(['accepted']);
  });

  it('I-3: 一般メンバー・別の組織のオーナー・未認証も直接 INSERT できない', async () => {
    const email = address('direct-others');
    for (const [label, db, inviter] of [
      ['member', asUser(member.jwt), member],
      ['other-owner', asUser(otherOwner.jwt), otherOwner],
      ['anon', anon(), owner],
    ] as const) {
      const { error } = await db.from('organization_invites').insert(directInviteRow(orgA, inviter, email, 'member'));
      expect(error?.code, label).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await inviteRowsFor(orgA, email)).toEqual([]);
  });

  it('I-4: owner / admin は pending の招待を直接 UPDATE できない (役割・期限・状態を書き換えられない)', async () => {
    const before = await inviteRowById(pendingInvite.id);
    for (const actor of [owner, admin]) {
      const { error } = await asUser(actor.jwt)
        .from('organization_invites')
        .update({ invited_role: 'owner', expires_at: new Date(Date.now() + EXTENDED_EXPIRY_MS).toISOString(), status: 'pending' })
        .eq('id', pendingInvite.id)
        .select('id');
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await inviteRowById(pendingInvite.id)).toEqual(before);
  });

  it('I-5: 未認証の直接の DELETE は 42501。一般メンバー・別の組織のオーナーの DELETE は 0 行 (行が残る)', async () => {
    const anonDelete = await anon().from('organization_invites').delete().eq('id', pendingInvite.id);
    expect(anonDelete.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    for (const actor of [member, otherOwner]) {
      const { error, data } = await asUser(actor.jwt).from('organization_invites').delete().eq('id', pendingInvite.id).select('id');
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
    expect((await inviteRowById(pendingInvite.id))?.status).toBe('pending');
  });

  it('I-6: SELECT は今までどおり。owner / admin は自分の組織の招待を読め、一般メンバーは読めない', async () => {
    for (const actor of [owner, admin]) {
      const { data, error } = await asUser(actor.jwt).from('organization_invites').select('id').eq('id', pendingInvite.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    }
    const { data, error } = await asUser(member.jwt).from('organization_invites').select('id').eq('organization_id', orgA);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('I-7: 招待の直接の DELETE (DELETE /api/org/invites の経路) は、今までどおり同じ組織の owner / admin ができる', async () => {
    for (const actor of [owner, admin]) {
      const invite = await inviteViaRpc(owner, orgA, address('delete-by-admin'));
      const { error, data } = await asUser(actor.jwt)
        .from('organization_invites')
        .delete()
        .eq('id', invite.id)
        .eq('organization_id', orgA)
        .select('id');
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(await inviteRowById(invite.id)).toBeNull();
    }
  });
});

describe('#1917 RPC の経路は今までどおり', () => {
  it('R-1: owner の create_org_invite は招待を作り、同じ宛先へ作り直すと前の pending を取り消す (監査行はトリガーが書く)', async () => {
    const email = address('rpc-create');
    const first = await inviteViaRpc(owner, orgA, email);
    expect(first).toMatchObject({ organization_id: orgA, email: email.toLowerCase(), status: 'pending', invited_role: 'member', invited_by: owner.id });

    const second = await inviteViaRpc(owner, orgA, email);
    expect(second.id).not.toBe(first.id);
    expect(await inviteRowById(first.id)).toMatchObject({ status: 'revoked', revoked_by: owner.id });
    expect(await inviteRowById(second.id)).toMatchObject({ status: 'pending' });

    const { data: audits, error } = await srAdmin
      .from('membership_audit')
      .select('actor_id, scope, scope_id')
      .eq('action', 'invite_created')
      .contains('metadata', { invite_id: second.id });
    expect(error).toBeNull();
    expect(audits).toEqual([{ actor_id: owner.id, scope: 'organization', scope_id: orgA }]);
  });

  it('R-2: admin の create_org_invite は admin の役割の招待も作れる', async () => {
    const invite = await inviteViaRpc(admin, orgA, address('rpc-admin-role'), 'admin');
    expect(invite).toMatchObject({ status: 'pending', invited_role: 'admin', invited_by: admin.id });
  });

  it('R-3: create_org_invite に owner を渡すと、owner / admin でも INSUFFICIENT_PERMISSION で断られ、招待は作られない', async () => {
    const email = address('rpc-owner-role');
    for (const actor of [owner, admin]) {
      const { error } = await createInvite(actor, orgA, email, 'owner');
      expectRaised(error, 'INSUFFICIENT_PERMISSION');
    }
    expect(await inviteRowsFor(orgA, email)).toEqual([]);
  });

  it('R-4: 組織の管理者でない人は、owner を渡しても先に NOT_ORG_ADMIN (エラーの順番は今までどおり)', async () => {
    const email = address('rpc-not-admin');
    for (const [actor, role] of [
      [member, 'owner'],
      [member, 'member'],
      [otherOwner, 'owner'],
      [otherOwner, 'member'],
    ] as const) {
      const { error } = await createInvite(actor, orgA, email, role);
      expectRaised(error, 'NOT_ORG_ADMIN');
    }
    expect(await inviteRowsFor(orgA, email)).toEqual([]);
  });

  it('R-5: 宛先がすでに在籍している人なら、今までどおり ALREADY_IN_ORG', async () => {
    const { error } = await createInvite(owner, orgA, member.email, 'member');
    expectRaised(error, 'ALREADY_IN_ORG');
  });

  it('R-6: revoke_org_invite (取り消し) と reject_org_invite (拒否) は今までどおり', async () => {
    const toRevoke = await inviteViaRpc(owner, orgA, address('rpc-revoke'));
    const revoked = await asUser(admin.jwt).rpc('revoke_org_invite', { p_invite_id: toRevoke.id });
    expect(revoked.error).toBeNull();
    expect(await inviteRowById(toRevoke.id)).toMatchObject({ status: 'revoked', revoked_by: admin.id });

    const invitee = await createUser('rejecter');
    const toReject = await inviteViaRpc(owner, orgA, invitee.email);
    const rejected = await asUser(invitee.jwt).rpc('reject_org_invite', { p_token: toReject.token });
    expect(rejected.error).toBeNull();
    expect((await inviteRowById(toReject.id))?.status).toBe('rejected');
  });

  it('R-7: 席数の上限: 満席なら create_org_invite は SEAT_LIMIT_EXCEEDED。空きがあれば承諾で +1、承諾の前に満席になれば承諾も断られる', async () => {
    const seatOwner = await createUser('seat-owner');
    const orgSeat = await createOrg(seatOwner, 'seat', { total: 1 });
    expect(await poolOf(orgSeat)).toEqual({ total_licenses: 1, used_licenses: 1 });

    const fullEmail = address('seat-full');
    expectRaised((await createInvite(seatOwner, orgSeat, fullEmail)).error, 'SEAT_LIMIT_EXCEEDED');
    expect(await inviteRowsFor(orgSeat, fullEmail)).toEqual([]);

    // 空きを 1 つ作る (service_role。運営の作業と同じ経路) → 招待 → 承諾で +1
    await setPool(orgSeat, { total_licenses: 2, used_licenses: 1 });
    const joiner = await createUser('seat-joiner');
    await joinViaRpc(seatOwner, orgSeat, joiner, 'member');
    expect(await poolOf(orgSeat)).toEqual({ total_licenses: 2, used_licenses: 2 });

    // 空きがあるうちに招待を作り、承諾の前に満席にすると、承諾は SEAT_LIMIT_EXCEEDED で断られ、招待は pending のまま
    await setPool(orgSeat, { total_licenses: 3, used_licenses: 2 });
    const late = await createUser('seat-late');
    const lateInvite = await inviteViaRpc(seatOwner, orgSeat, late.email);
    await setPool(orgSeat, { total_licenses: 2, used_licenses: 2 });
    const accepted = await asUser(late.jwt).rpc('accept_org_invite', { p_token: lateInvite.token });
    expectRaised(accepted.error, 'SEAT_LIMIT_EXCEEDED');
    expect((await inviteRowById(lateInvite.id))?.status).toBe('pending');
    expect(await poolOf(orgSeat)).toEqual({ total_licenses: 2, used_licenses: 2 });
  });

  it('R-8: 脱退 (leave_org・SECURITY DEFINER) は今までどおり席数を 1 減らす', async () => {
    const leaver = await createUser('leaver');
    await joinViaRpc(owner, orgA, leaver, 'member');
    const before = await poolOf(orgA);
    const { error } = await asUser(leaver.jwt).rpc('leave_org');
    expect(error).toBeNull();
    expect(await poolOf(orgA)).toEqual({ total_licenses: before!.total_licenses, used_licenses: before!.used_licenses - 1 });
  });
});

describe('#1917 カタログ', () => {
  it('C-1: anon / authenticated は 2 つの表に INSERT・UPDATE・TRUNCATE できない。DELETE は招待の表の authenticated だけ。SELECT は残る', async () => {
    const rows = await pgQuery<{ role: string; tbl: string; priv: string; granted: boolean }>(`
      SELECT r.role, t.tbl, p.priv, has_table_privilege(r.role, t.tbl, p.priv) AS granted
      FROM (VALUES ('anon'), ('authenticated')) AS r(role)
      CROSS JOIN (VALUES ('public.org_license_pools'), ('public.organization_invites')) AS t(tbl)
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
      ORDER BY 1, 2, 3
    `);
    const granted = rows.filter((r) => r.granted).map((r) => `${r.role} ${r.tbl} ${r.priv}`).sort();
    expect(granted).toEqual(
      [
        'anon public.org_license_pools SELECT',
        'anon public.organization_invites SELECT',
        'authenticated public.org_license_pools SELECT',
        'authenticated public.organization_invites DELETE',
        'authenticated public.organization_invites SELECT',
      ].sort(),
    );
  });

  it('C-2: 2 つの表に、INSERT / UPDATE を許すポリシー (FOR ALL を含む) が無い。招待の DELETE のポリシーは TO authenticated の 1 本', async () => {
    const rows = await pgQuery<{ tablename: string; policyname: string; cmd: string; roles: string }>(`
      SELECT tablename, policyname, cmd, roles::text AS roles
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('org_license_pools', 'organization_invites')
      ORDER BY tablename COLLATE "C", policyname COLLATE "C"
    `);
    expect(rows.filter((r) => ['INSERT', 'UPDATE', 'ALL'].includes(r.cmd))).toEqual([]);
    expect(rows.filter((r) => r.cmd === 'DELETE')).toEqual([
      { tablename: 'organization_invites', policyname: 'Org admins can delete invites', cmd: 'DELETE', roles: '{authenticated}' },
    ]);
    expect(rows.filter((r) => r.tablename === 'org_license_pools').map((r) => r.cmd)).toEqual(['SELECT']);
  });

  it('C-3: create_org_invite は SECURITY DEFINER・search_path = public。EXECUTE は authenticated と service_role だけ', async () => {
    const rows = await pgQuery<{ secdef: boolean; config: string[] | null; anon_exec: boolean; auth_exec: boolean; sr_exec: boolean }>(`
      SELECT p.prosecdef AS secdef, p.proconfig AS config,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'create_org_invite'
    `);
    expect(rows).toEqual([{ secdef: true, config: ['search_path=public'], anon_exec: false, auth_exec: true, sr_exec: true }]);
  });
});
