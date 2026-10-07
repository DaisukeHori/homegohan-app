/**
 * #1235 (第2段 ⑥) 組織の所属を外す RPC が roles の 'org_admin' も外すことの回帰テスト
 *
 * 'org_admin' はどの組織で付与されたかを区別しないロールで、#1252 以降は組織の管理者判定には使っていない
 * (組織の管理者 = 同じ組織に所属し、org_role が owner / admin)。
 * ただし脱退・除名などで所属を外しても roles に残り続け、体験ツアーの対象外判定 (ADMIN_ROLES) などに影響していた。
 *
 * 期待する挙動 (修正後):
 *   - leave_org / remove_org_member / operator_force_dissolve_org / release_user_membership で所属を外すと、
 *     そのユーザーの roles から 'org_admin' も外れる
 *   - ほかのロール ('user' / 'support' など) はそのまま
 *   - 所属を外さないユーザー (別組織のメンバーなど) の roles は変わらない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-admin-residual-cleanup.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-orgadmin-cleanup-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `cleanup-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function createOrg(label: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `#1235 cleanup ${label} ${TS}` })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organizations: ${error?.message}`);
  createdOrgIds.push(data.id as string);
  return data.id as string;
}

/** 所属と roles を service_role で設定する (特権列は本人の JWT では変更できない) */
async function setMembership(
  userId: string,
  orgId: string | null,
  orgRole: 'owner' | 'admin' | 'member' | null,
  roles: string[],
) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: orgId !== null, roles })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

async function profileOf(userId: string): Promise<{ organization_id: string | null; org_role: string | null; roles: string[] }> {
  const { data, error } = await srAdmin
    .from('user_profiles')
    .select('organization_id, org_role, roles')
    .eq('id', userId)
    .single();
  if (error || !data) throw new Error(`profile: ${error?.message}`);
  return data as { organization_id: string | null; org_role: string | null; roles: string[] };
}

let orgA = '';
let orgB = '';
let orgC = '';

let ownerA: TestUser; // 組織 A の owner (除名する側)
let leaver: TestUser; // 組織 A の一般メンバー。roles に 'org_admin' が残っている (脱退する)
let removedAdmin: TestUser; // 組織 A の admin。roles に 'org_admin' と 'support' (除名される)
let dissolvedMember: TestUser; // 組織 B の一般メンバー。roles に 'org_admin' (組織 B を運営が強制解散)
let deletedAccount: TestUser; // 組織 C の一般メンバー。roles に 'org_admin' (アカウント削除で所属解除)
let bystander: TestUser; // 組織 C の admin。roles に 'org_admin' (所属はそのまま)
let superAdmin: TestUser; // 運営の super_admin

beforeAll(async () => {
  [orgA, orgB, orgC] = await Promise.all([createOrg('A'), createOrg('B'), createOrg('C')]);
  [ownerA, leaver, removedAdmin, dissolvedMember, deletedAccount, bystander, superAdmin] = await Promise.all([
    createUser('owner-a'),
    createUser('leaver'),
    createUser('removed-admin'),
    createUser('dissolved-member'),
    createUser('deleted-account'),
    createUser('bystander'),
    createUser('super-admin'),
  ]);

  await setMembership(ownerA.id, orgA, 'owner', ['user']);
  await setMembership(leaver.id, orgA, 'member', ['user', 'org_admin']);
  await setMembership(removedAdmin.id, orgA, 'admin', ['user', 'org_admin', 'support']);
  await setMembership(dissolvedMember.id, orgB, 'member', ['user', 'org_admin']);
  await setMembership(deletedAccount.id, orgC, 'member', ['user', 'org_admin']);
  await setMembership(bystander.id, orgC, 'admin', ['user', 'org_admin']);
  await setMembership(superAdmin.id, null, null, ['user', 'super_admin']);
}, 60_000);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  if (createdOrgIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdOrgIds);
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

describe('#1235 ⑥ 所属を外す RPC は roles の org_admin も外す', () => {
  it('R-1: leave_org で脱退すると、所属と一緒に org_admin も外れる', async () => {
    const { error } = await asUser(leaver.jwt).rpc('leave_org');
    expect(error).toBeNull();
    const p = await profileOf(leaver.id);
    expect(p.organization_id).toBeNull();
    expect(p.org_role).toBeNull();
    expect(p.roles).toEqual(['user']);
  });

  it('R-2: remove_org_member で除名されると org_admin は外れ、ほかのロール (support) は残る', async () => {
    const { error } = await asUser(ownerA.jwt).rpc('remove_org_member', {
      p_organization_id: orgA,
      p_user_id: removedAdmin.id,
    });
    expect(error).toBeNull();
    const p = await profileOf(removedAdmin.id);
    expect(p.organization_id).toBeNull();
    expect(p.roles).toEqual(['user', 'support']);
  });

  it('R-3: operator_force_dissolve_org で組織が解散されると、メンバーの org_admin も外れる', async () => {
    const { error } = await asUser(superAdmin.jwt).rpc('operator_force_dissolve_org', {
      p_organization_id: orgB,
      p_reason: `#1235 cleanup test ${TS}`,
    });
    expect(error).toBeNull();
    const p = await profileOf(dissolvedMember.id);
    expect(p.organization_id).toBeNull();
    expect(p.roles).toEqual(['user']);
  });

  it('R-4: release_user_membership (アカウント削除) で所属を外すと org_admin も外れる', async () => {
    const { error } = await srAdmin.rpc('release_user_membership', { p_user_id: deletedAccount.id });
    expect(error).toBeNull();
    const p = await profileOf(deletedAccount.id);
    expect(p.organization_id).toBeNull();
    expect(p.roles).toEqual(['user']);
  });

  it('R-5: 所属を外していないユーザー (組織 C の admin) の roles は変わらない', async () => {
    const p = await profileOf(bystander.id);
    expect(p.organization_id).toBe(orgC);
    expect(p.org_role).toBe('admin');
    expect(p.roles).toEqual(['user', 'org_admin']);
  });

  it('R-6: 組織の owner (除名した側) の roles も変わらない', async () => {
    const p = await profileOf(ownerA.id);
    expect(p.organization_id).toBe(orgA);
    expect(p.roles).toEqual(['user']);
  });
});
