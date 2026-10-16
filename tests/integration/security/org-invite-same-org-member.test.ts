/**
 * #1799 組織の招待を承諾すると、同じ組織にすでに在籍している人の org_role が招待の役割で上書きされる問題の回帰テスト (実 DB)
 *
 * 修正前:
 *   - accept_org_invite は、別の組織の在籍者だけを ALREADY_IN_ORG で断り、同じ組織の在籍者は通していた。
 *     そのあとの INSERT ... ON CONFLICT DO UPDATE が org_role = invited_role に上書きするため、
 *     持ち主 (owner) 宛ての member の招待を承諾すると持ち主が member になった (組織から owner がいなくなる)。
 *   - create_org_invite は、宛先が同じ組織の在籍者かを見ていなかった。
 *
 * 修正後 (supabase/migrations/20261017160000_org_invite_same_org_member.sql):
 *   - accept_org_invite: どこかの組織に在籍している人の承諾は、宛先の組織が同じでも ALREADY_IN_ORG。
 *     招待の組織の持ち主本人 (所属の列が空でも) も ALREADY_IN_ORG。役割・所属・席数・招待 (pending のまま)・監査ログは変わらない
 *   - create_org_invite: 宛先がこの組織の在籍者・持ち主なら ALREADY_IN_ORG で招待を作らない (既存の pending も取り消さない)
 *   - 別の組織の在籍者・未所属の人は従来どおり (承諾は ALREADY_IN_ORG / 入れる、招待は作れる)
 *   - 判定の helper (assert_org_invite_recipient_not_in_org) は所属組織の owner / admin にしか答えない。anon は呼べない
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next の開発サーバー (API ルートの検証に使う)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-invite-same-org-member.test.ts
 * 関数の属性・権限の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { createPlaceholderOrgOwner, deletePlaceholderOrgOwner } from '../helpers/org-owner';
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

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

type OrgRole = 'owner' | 'admin' | 'member';

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
/** 招待のトークンの形 (create_org_invite と同じ 64 文字の 16 進数) */
const TOKEN_BYTES = 32;
/** 招待の有効期限 (create_org_invite と同じ 14 日) */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** 組織 A の席数 (余裕を持たせる。席数の上限で断られる経路と混ざらないように) */
const ORG_A_LICENSES = 20;
const ORG_B_LICENSES = 5;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const placeholderOwnerIds: string[] = [];

async function createUser(label: string, options: { withProfile?: boolean } = {}): Promise<TestUser> {
  const email = `sec-org-same-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (options.withProfile !== false) {
    const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
      db.from('user_profiles')
        .upsert({ id: data.user.id, nickname: `same-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

/** 組織を作る。持ち主 (owner_id) は ownerId (省略時は、どの組織のメンバーでもない作り物) */
async function createOrg(label: string, totalLicenses: number, ownerId?: string): Promise<string> {
  let owner = ownerId;
  if (!owner) {
    owner = await createPlaceholderOrgOwner(srAdmin, `1799-${label}`);
    placeholderOwnerIds.push(owner);
  }
  const { data: org, error } = await srAdmin
    .from('organizations')
    .insert({ name: `#1799 ${label} ${TS}`, owner_id: owner })
    .select('id')
    .single();
  if (error || !org) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = org.id as string;
  createdOrgIds.push(orgId);
  const { error: poolError } = await retryIdempotentSetup(srAdmin, 'createOrg: org_license_pools の upsert', (db) =>
    db.from('org_license_pools')
      .upsert({ organization_id: orgId, total_licenses: totalLicenses, used_licenses: 0 }, { onConflict: 'organization_id' }));
  if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  return orgId;
}

async function setOrgMembership(user: TestUser, orgId: string, role: OrgRole) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: true })
    .eq('id', user.id);
  if (error) throw new Error(`membership: ${error.message}`);
}

/** 承諾の確認に使うプロフィールの列 */
const COLS = 'organization_id, org_role, is_active_in_org, joined_org_at, department_id';

async function profileOf(id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from('user_profiles').select(COLS).eq('id', id).maybeSingle();
  if (error) throw new Error(`profileOf: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function usedLicenses(orgId: string): Promise<number> {
  const { data, error } = await srAdmin.from('org_license_pools').select('used_licenses').eq('organization_id', orgId).single();
  if (error) throw new Error(`org_license_pools: ${error.message}`);
  return (data as { used_licenses: number }).used_licenses;
}

async function ownerIdOf(orgId: string): Promise<string> {
  const { data, error } = await srAdmin.from('organizations').select('owner_id').eq('id', orgId).single();
  if (error) throw new Error(`organizations: ${error.message}`);
  return (data as { owner_id: string }).owner_id;
}

async function inviteStatus(token: string): Promise<string> {
  const { data, error } = await srAdmin.from('organization_invites').select('status').eq('token', token).single();
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return (data as { status: string }).status;
}

/** 組織の、宛先 (小文字) への招待の行 (状態ごと) */
async function invitesTo(orgId: string, email: string): Promise<Array<{ status: string; token: string }>> {
  const { data, error } = await srAdmin
    .from('organization_invites')
    .select('status, token')
    .eq('organization_id', orgId)
    .eq('email', email.toLowerCase());
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return (data ?? []) as Array<{ status: string; token: string }>;
}

async function acceptedAuditCount(orgId: string, userId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'organization')
    .eq('scope_id', orgId)
    .eq('action', 'invite_accepted')
    .eq('target_user_id', userId);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

async function createdAuditCount(orgId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'organization')
    .eq('scope_id', orgId)
    .eq('action', 'invite_created');
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

/**
 * 承諾の経路を確かめるための pending の招待を、service_role で直接作る。
 * 修正後の create_org_invite は同じ組織の在籍者宛ての招待を作らないので、修正前に作られた招待 (本番に残りうる) を再現する
 */
async function insertPendingInvite(orgId: string, email: string, role: 'admin' | 'member', invitedBy: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const { error } = await srAdmin.from('organization_invites').insert({
    organization_id: orgId,
    email: email.toLowerCase(),
    token,
    invited_role: role,
    status: 'pending',
    expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    invited_by: invitedBy,
  });
  if (error) throw new Error(`insertPendingInvite: ${error.message}`);
  return token;
}

/** 本人の JWT で create_org_invite を呼ぶ */
async function createInvite(caller: TestUser, orgId: string, email: string, role: 'admin' | 'member') {
  return asUser(caller.jwt).rpc('create_org_invite', { p_organization_id: orgId, p_email: email, p_role: role });
}

// 組織 A: owner (持ち主・所属あり) / admin / member の 3 人が在籍
// 組織 B: otherMember が在籍 (別の組織の在籍者)
// 組織 C: 持ち主 orphanOwner は所属の列が空 (持ち主と所属がずれた状態)
let orgA = '';
let orgB = '';
let orgC = '';
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let otherMember: TestUser;
let outsider: TestUser;
let outsider2: TestUser;
let orphanOwner: TestUser;

beforeAll(async () => {
  [owner, admin, member, otherMember] = await Promise.all([
    createUser('owner'),
    createUser('admin'),
    createUser('member'),
    createUser('other-member'),
  ]);
  [outsider, outsider2, orphanOwner] = await Promise.all([
    createUser('outsider'),
    createUser('outsider2', { withProfile: false }),
    createUser('orphan-owner'),
  ]);
  orgA = await createOrg('org-a', ORG_A_LICENSES, owner.id);
  orgB = await createOrg('org-b', ORG_B_LICENSES);
  orgC = await createOrg('org-c', ORG_B_LICENSES, orphanOwner.id);
  await setOrgMembership(owner, orgA, 'owner');
  await setOrgMembership(admin, orgA, 'admin');
  await setOrgMembership(member, orgA, 'member');
  await setOrgMembership(otherMember, orgB, 'member');
}, 120_000);

afterAll(async () => {
  // 先に所属の列を空にする (組織を消すと FK で organization_id だけ NULL になり、user_profiles_org_consistency に違反するため)
  if (createdUserIds.length > 0) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  for (const id of createdOrgIds) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('organization_invites').delete().eq('organization_id', id);
    await srAdmin.from('org_license_pools').delete().eq('organization_id', id);
    await srAdmin.from('organizations').delete().eq('id', id);
  }
  // 持ち主は組織を消した後に消す (owner_id → auth.users は ON DELETE RESTRICT)
  for (const id of placeholderOwnerIds) await deletePlaceholderOrgOwner(srAdmin, id);
  for (const id of createdUserIds) await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
}, 60_000);

describe('#1799 承諾 (accept_org_invite): 同じ組織の在籍者は役割を変えずに断る', () => {
  it.each([
    ['owner', 'member'],
    ['admin', 'member'],
    ['member', 'admin'],
  ] as const)(
    'A1: 組織 A の %s が、組織 A の %s の招待を承諾しても ALREADY_IN_ORG。役割・所属・席数・招待 (pending)・監査ログは変わらない',
    async (who, invitedRole) => {
      const user = { owner, admin, member }[who];
      const before = await profileOf(user.id);
      expect(before).toMatchObject({ organization_id: orgA, org_role: who });
      const usedBefore = await usedLicenses(orgA);
      const token = await insertPendingInvite(orgA, user.email, invitedRole, owner.id);

      const { data, error } = await asUser(user.jwt).rpc('accept_org_invite', { p_token: token });

      expect(data).toBeNull();
      expect(error?.message).toContain('ALREADY_IN_ORG');
      expect(await profileOf(user.id)).toEqual(before);
      expect(await usedLicenses(orgA)).toBe(usedBefore);
      expect(await inviteStatus(token)).toBe('pending');
      expect(await acceptedAuditCount(orgA, user.id)).toBe(0);
      // 持ち主は変わらない (organizations.owner_id と org_role = 'owner' がそろったまま)
      expect(await ownerIdOf(orgA)).toBe(owner.id);
      expect((await profileOf(owner.id))?.org_role).toBe('owner');

      // 断られた招待は、本人が拒否できる (設計 membership/02-flow-spec.md §1.3)
      const rejected = await asUser(user.jwt).rpc('reject_org_invite', { p_token: token });
      expect(rejected.error).toBeNull();
      expect(await inviteStatus(token)).toBe('rejected');
    },
  );

  it('A2: POST /api/org/invites/{token}/accept は 409 ALREADY_IN_ORG を返し、持ち主は owner のまま', async () => {
    const token = await insertPendingInvite(orgA, owner.email, 'member', admin.id);

    const res = await apiCall<{ error?: { code: string; message: string } }>(
      'POST',
      `/api/org/invites/${token}/accept`,
      owner.jwt,
    );

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('ALREADY_IN_ORG');
    expect(await profileOf(owner.id)).toMatchObject({ organization_id: orgA, org_role: 'owner' });
    expect(await inviteStatus(token)).toBe('pending');
    await srAdmin.from('organization_invites').update({ status: 'revoked' }).eq('token', token);
  }, 60_000);

  it('A3: 招待の組織の持ち主本人は、所属の列が空でも承諾できない (ALREADY_IN_ORG)。プロフィールも席数も変わらない', async () => {
    const before = await profileOf(orphanOwner.id);
    expect(before).toMatchObject({ organization_id: null, org_role: null });
    const usedBefore = await usedLicenses(orgC);
    const token = await insertPendingInvite(orgC, orphanOwner.email, 'member', orphanOwner.id);

    const { error } = await asUser(orphanOwner.jwt).rpc('accept_org_invite', { p_token: token });

    expect(error?.message).toContain('ALREADY_IN_ORG');
    expect(await profileOf(orphanOwner.id)).toEqual(before);
    expect(await usedLicenses(orgC)).toBe(usedBefore);
    expect(await inviteStatus(token)).toBe('pending');
    expect(await acceptedAuditCount(orgC, orphanOwner.id)).toBe(0);
    await srAdmin.from('organization_invites').update({ status: 'revoked' }).eq('token', token);
  });

  it('A4: 別の組織の在籍者は従来どおり ALREADY_IN_ORG (元の所属・役割は変わらない)', async () => {
    const before = await profileOf(otherMember.id);
    const token = await insertPendingInvite(orgA, otherMember.email, 'admin', owner.id);

    const { error } = await asUser(otherMember.jwt).rpc('accept_org_invite', { p_token: token });

    expect(error?.message).toContain('ALREADY_IN_ORG');
    expect(await profileOf(otherMember.id)).toEqual(before);
    expect(await inviteStatus(token)).toBe('pending');
    await srAdmin.from('organization_invites').update({ status: 'revoked' }).eq('token', token);
  });

  it('A5: 未所属の人は従来どおり入れる (招待の役割・席数 +1・招待は accepted・監査ログ 1 件)。プロフィール行が無い人も同じ', async () => {
    for (const [user, role] of [
      [outsider, 'admin'],
      [outsider2, 'member'],
    ] as const) {
      const usedBefore = await usedLicenses(orgA);
      const { data: invite, error: createError } = await createInvite(owner, orgA, user.email, role);
      expect(createError).toBeNull();
      const token = (invite as { token: string }).token;

      const { data, error } = await asUser(user.jwt).rpc('accept_org_invite', { p_token: token });

      expect(error).toBeNull();
      expect(data).toMatchObject({ id: user.id, organization_id: orgA, org_role: role, is_active_in_org: true });
      expect(await profileOf(user.id)).toMatchObject({ organization_id: orgA, org_role: role });
      expect(await usedLicenses(orgA)).toBe(usedBefore + 1);
      expect(await inviteStatus(token)).toBe('accepted');
      expect(await acceptedAuditCount(orgA, user.id)).toBe(1);
    }
  });

  it('A6: 入ったあとに、同じ組織の別の役割の招待 (修正前に作られたもの) を承諾しても役割は変わらない', async () => {
    // A5 で admin として入った outsider に、member の招待
    expect((await profileOf(outsider.id))?.org_role).toBe('admin');
    const usedBefore = await usedLicenses(orgA);
    const token = await insertPendingInvite(orgA, outsider.email, 'member', owner.id);

    const { error } = await asUser(outsider.jwt).rpc('accept_org_invite', { p_token: token });

    expect(error?.message).toContain('ALREADY_IN_ORG');
    expect((await profileOf(outsider.id))?.org_role).toBe('admin');
    expect(await usedLicenses(orgA)).toBe(usedBefore);
    expect(await acceptedAuditCount(orgA, outsider.id)).toBe(1); // A5 の 1 件だけ
    await srAdmin.from('organization_invites').update({ status: 'revoked' }).eq('token', token);
  });
});

describe('#1799 招待の作成 (create_org_invite): 同じ組織の在籍者・持ち主には作らない', () => {
  it.each([
    ['owner', 'admin', 'member'],
    ['owner', 'member', 'admin'],
    ['admin', 'owner', 'member'],
    ['admin', 'member', 'admin'],
  ] as const)(
    'C1: 組織 A の %s が、組織 A の %s 宛てに %s の招待を作ろうとすると ALREADY_IN_ORG。招待の行も監査行も増えない',
    async (callerRole, targetRole, role) => {
      const caller = { owner, admin }[callerRole];
      const target = { owner, admin, member }[targetRole];
      const invitesBefore = await invitesTo(orgA, target.email);
      const auditBefore = await createdAuditCount(orgA);

      const { data, error } = await createInvite(caller, orgA, target.email, role);

      expect(data).toBeNull();
      expect(error?.message).toContain('ALREADY_IN_ORG');
      expect(await invitesTo(orgA, target.email)).toEqual(invitesBefore);
      expect(await createdAuditCount(orgA)).toBe(auditBefore);
      expect((await profileOf(target.id))?.org_role).toBe(targetRole);
    },
  );

  it('C2: 宛先のアドレスの大文字・小文字が違っても ALREADY_IN_ORG', async () => {
    const { error } = await createInvite(owner, orgA, member.email.toUpperCase(), 'admin');
    expect(error?.message).toContain('ALREADY_IN_ORG');
  });

  it('C3: 修正前に作られた在籍者宛ての pending の招待は、作り直そうとしても取り消されない (pending のまま)', async () => {
    const token = await insertPendingInvite(orgA, member.email, 'admin', owner.id);

    const { error } = await createInvite(owner, orgA, member.email, 'admin');

    expect(error?.message).toContain('ALREADY_IN_ORG');
    expect(await inviteStatus(token)).toBe('pending');
    await srAdmin.from('organization_invites').update({ status: 'revoked' }).eq('token', token);
  });

  it('C4: 組織の持ち主 (所属の列が空) 宛ての招待も作らない', async () => {
    // 組織 C の持ち主 orphanOwner の招待を、組織 C の管理者が作ろうとする
    const cAdmin = await createUser('c-admin');
    await setOrgMembership(cAdmin, orgC, 'admin');

    const { error } = await createInvite(cAdmin, orgC, orphanOwner.email, 'member');

    expect(error?.message).toContain('ALREADY_IN_ORG');
    expect((await invitesTo(orgC, orphanOwner.email)).filter((i) => i.status === 'pending')).toHaveLength(0);
  });

  it('C5: 別の組織の在籍者・未所属の人には従来どおり作れる', async () => {
    const other = await createInvite(owner, orgA, otherMember.email, 'member');
    expect(other.error).toBeNull();
    expect(other.data).toMatchObject({ organization_id: orgA, email: otherMember.email.toLowerCase(), status: 'pending' });

    const freshEmail = `sec-org-same-fresh-${randomUUID()}@homegohan.test`;
    const fresh = await createInvite(admin, orgA, freshEmail, 'admin');
    expect(fresh.error).toBeNull();
    expect(fresh.data).toMatchObject({ organization_id: orgA, invited_role: 'admin', status: 'pending' });
  });

  it('C6: POST /api/org/invites は 409 ALREADY_IN_ORG と固定の文を返す', async () => {
    const res = await apiCall<{ error?: { code: string; message: string } }>('POST', '/api/org/invites', owner.jwt, {
      email: admin.email,
      role: 'member',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'ALREADY_IN_ORG', message: 'このメールアドレスの人は、すでにこの組織のメンバーです' });
    expect((await profileOf(admin.id))?.org_role).toBe('admin');
  }, 60_000);

  it('C7: 認可は従来どおり先 (member が在籍者宛てに作ろうとしても NOT_ORG_ADMIN。在籍の有無を答えない)', async () => {
    const { error } = await createInvite(member, orgA, owner.email, 'member');
    expect(error?.message).toContain('NOT_ORG_ADMIN');
  });
});

describe('#1799 判定の helper (assert_org_invite_recipient_not_in_org) の属性と権限', () => {
  it('H1: SECURITY DEFINER・search_path は空・所有者 postgres。EXECUTE は authenticated だけ (anon・service_role・PUBLIC には無い)', async () => {
    const rows = await pgQuery<{
      sig: string;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
      public_exec: boolean;
      secdef: boolean;
      config: string[] | null;
      owner: string;
    }>(`
      SELECT p.oid::regprocedure::text AS sig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec,
             p.prosecdef AS secdef,
             p.proconfig AS config,
             pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'assert_org_invite_recipient_not_in_org'
    `);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.sig).toBe('assert_org_invite_recipient_not_in_org(uuid,text)');
    expect(row.secdef).toBe(true);
    expect(row.config).toEqual(['search_path=""']);
    expect(row.owner).toBe('postgres');
    expect(row.anon_exec).toBe(false);
    expect(row.auth_exec).toBe(true);
    expect(row.sr_exec).toBe(false);
    expect(row.public_exec).toBe(false);
  });

  it('H2: anon は呼べない。所属組織の owner / admin 以外 (member・別の組織の管理者) には NOT_ORG_ADMIN で答えない', async () => {
    const anonCall = await anon().rpc('assert_org_invite_recipient_not_in_org', {
      p_organization_id: orgA,
      p_email: owner.email,
    });
    expect(anonCall.error?.code).toBe('42501');

    const byMember = await asUser(member.jwt).rpc('assert_org_invite_recipient_not_in_org', {
      p_organization_id: orgA,
      p_email: owner.email,
    });
    expect(byMember.error?.message).toContain('NOT_ORG_ADMIN');

    const otherAdmin = await createUser('other-admin');
    await setOrgMembership(otherAdmin, orgB, 'admin');
    const byOtherAdmin = await asUser(otherAdmin.jwt).rpc('assert_org_invite_recipient_not_in_org', {
      p_organization_id: orgA,
      p_email: owner.email,
    });
    expect(byOtherAdmin.error?.message).toContain('NOT_ORG_ADMIN');
  });

  it('H3: 所属組織の管理者には、在籍者なら ALREADY_IN_ORG・それ以外なら何も返さない', async () => {
    const inOrg = await asUser(admin.jwt).rpc('assert_org_invite_recipient_not_in_org', {
      p_organization_id: orgA,
      p_email: member.email,
    });
    expect(inOrg.error?.message).toContain('ALREADY_IN_ORG');

    const notInOrg = await asUser(admin.jwt).rpc('assert_org_invite_recipient_not_in_org', {
      p_organization_id: orgA,
      p_email: otherMember.email,
    });
    expect(notInOrg.error).toBeNull();
  });
});
