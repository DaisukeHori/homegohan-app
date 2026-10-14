/**
 * 本番ドリフト D-13 (docs/operations/rls-drift-20261006.md): membership_audit の閲覧範囲の挙動テスト
 *
 * membership_audit (組織・家族の所属変更の監査ログ) の SELECT ポリシーは 3 本:
 *   - membership_audit_select_admin   : 組織スコープの行を、その組織の owner / admin が読める
 *   - membership_audit_select_operator: super_admin は全件読める
 *   - membership_audit_select_self    : 自分が操作者 (actor_id) か対象者 (target_user_id) の行は読める
 *
 * 2026-10-07 のオーナー判断で、membership_audit_select_admin は本番どおり「組織スコープだけ」とする。
 * 家族スコープの行は、家族の代表者・大人でも select_admin では読めない (自分が操作者・対象者の行は select_self で読める)。
 * migration (20260511000104) には家族スコープも読める定義があったが、本番には無く、読む画面も無い。
 *
 * 期待する認可:
 *   - 組織の owner / admin: 自組織の組織スコープの行を全部読める
 *   - 組織の一般メンバー: 自分が対象者の行だけ読める
 *   - 別組織の admin: 読めない
 *   - 家族の代表者・大人: 自分が操作者・対象者の行だけ読める (家族スコープの行を家族単位では読めない)
 *   - super_admin: 全件読める
 *   - 未認証 (anon): 読めない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/membership-audit-select.test.ts
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

async function createUser(label: string, roles: string[] = ['user']): Promise<TestUser> {
  const email = `rls-audit-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-rls';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `audit-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** 組織の所属を service_role で設定する (特権列は本人の JWT では変更できない) */
async function setOrgMembership(userId: string, orgId: string, orgRole: 'owner' | 'admin' | 'member') {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: true })
    .eq('id', userId);
  if (error) throw new Error(`setOrgMembership: ${error.message}`);
}

let orgA = '';
let orgB = '';
let familyId = '';

let orgOwner: TestUser; // A の owner
let orgAdmin: TestUser; // A の admin
let orgMember: TestUser; // A の一般メンバー
let otherOrgAdmin: TestUser; // B の admin (A に対しては部外者)
let famRep: TestUser; // 家族 F の代表者
let famAdult: TestUser; // 家族 F の大人
let outsider: TestUser; // どこにも所属しない
let superAdmin: TestUser; // 運営の super_admin

// 監査ログの行
let orgRow1 = ''; // 組織 A: owner が member を追加 (対象者 = orgMember)
let orgRow2 = ''; // 組織 A: admin が招待を作成 (対象者なし)
let famRow1 = ''; // 家族 F: 代表者が大人を追加 (操作者 = famRep、対象者 = famAdult)
let famRow2 = ''; // 家族 F: 招待の期限切れ (操作者・対象者なし)

async function insertAudit(row: {
  scope: 'organization' | 'family';
  scope_id: string;
  action: string;
  actor_id: string | null;
  target_user_id: string | null;
}): Promise<string> {
  const { data, error } = await srAdmin
    .from('membership_audit')
    .insert({ ...row, metadata: { test: `rls-audit-${TS}` } })
    .select('id')
    .single();
  if (error || !data) throw new Error(`membership_audit: ${error?.message}`);
  return data.id as string;
}

async function visibleRows(c: SupabaseClient): Promise<string[]> {
  const { data, error } = await c
    .from('membership_audit')
    .select('id')
    .in('id', [orgRow1, orgRow2, famRow1, famRow2]);
  expect(error).toBeNull();
  return (data ?? []).map((r) => r.id as string).sort();
}

beforeAll(async () => {
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([{ name: `rls-audit Org A ${TS}` }, { name: `rls-audit Org B ${TS}` }])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('rls-audit Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('rls-audit Org B'))!.id;

  [orgOwner, orgAdmin, orgMember, otherOrgAdmin, famRep, famAdult, outsider, superAdmin] = await Promise.all([
    createUser('org-owner'),
    createUser('org-admin'),
    createUser('org-member'),
    createUser('other-org-admin'),
    createUser('fam-rep'),
    createUser('fam-adult'),
    createUser('outsider'),
    createUser('super-admin', ['user', 'super_admin']),
  ]);

  await setOrgMembership(orgOwner.id, orgA, 'owner');
  await setOrgMembership(orgAdmin.id, orgA, 'admin');
  await setOrgMembership(orgMember.id, orgA, 'member');
  await setOrgMembership(otherOrgAdmin.id, orgB, 'admin');

  const { data: family, error: familyError } = await srAdmin
    .from('family_groups')
    .insert({ name: `rls-audit family ${TS}`, representative_id: famRep.id })
    .select('id')
    .single();
  if (familyError || !family) throw new Error(`family_groups: ${familyError?.message}`);
  familyId = family.id as string;
  const { error: membersError } = await srAdmin.from('family_members').insert([
    { family_id: familyId, user_id: famRep.id, role: 'representative', status: 'active' },
    { family_id: familyId, user_id: famAdult.id, role: 'adult', status: 'active' },
  ]);
  if (membersError) throw new Error(`family_members: ${membersError.message}`);

  orgRow1 = await insertAudit({
    scope: 'organization',
    scope_id: orgA,
    action: 'member_added',
    actor_id: orgOwner.id,
    target_user_id: orgMember.id,
  });
  orgRow2 = await insertAudit({
    scope: 'organization',
    scope_id: orgA,
    action: 'invite_created',
    actor_id: orgAdmin.id,
    target_user_id: null,
  });
  famRow1 = await insertAudit({
    scope: 'family',
    scope_id: familyId,
    action: 'member_added',
    actor_id: famRep.id,
    target_user_id: famAdult.id,
  });
  famRow2 = await insertAudit({
    scope: 'family',
    scope_id: familyId,
    action: 'invite_expired',
    actor_id: null,
    target_user_id: null,
  });
}, 60_000);

afterAll(async () => {
  const auditIds = [orgRow1, orgRow2, famRow1, famRow2].filter(Boolean);
  if (auditIds.length > 0) await srAdmin.from('membership_audit').delete().in('id', auditIds);
  // family_groups.representative_id は ON DELETE RESTRICT のため、家族を先に消す (family_members は CASCADE)
  if (familyId) await srAdmin.from('family_groups').delete().eq('id', familyId);
  if (createdUserIds.length > 0) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  if (orgA || orgB) await srAdmin.from('organizations').delete().in('id', [orgA, orgB].filter(Boolean));
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

describe('D-13 membership_audit の閲覧範囲 (本番どおり、組織分だけ)', () => {
  it('A-1: 組織の owner は自組織の組織スコープの行を全部読める', async () => {
    expect(await visibleRows(asUser(orgOwner.jwt))).toEqual([orgRow1, orgRow2].sort());
  });

  it('A-2: 組織の admin も自組織の組織スコープの行を全部読める', async () => {
    expect(await visibleRows(asUser(orgAdmin.jwt))).toEqual([orgRow1, orgRow2].sort());
  });

  it('A-3: 組織の一般メンバーは自分が対象者の行だけ読める', async () => {
    expect(await visibleRows(asUser(orgMember.jwt))).toEqual([orgRow1]);
  });

  it('A-4: 別組織の admin は読めない', async () => {
    expect(await visibleRows(asUser(otherOrgAdmin.jwt))).toEqual([]);
  });

  it('F-1: 家族の代表者は自分が操作者の行だけ読める (家族スコープの行を家族単位では読めない)', async () => {
    expect(await visibleRows(asUser(famRep.jwt))).toEqual([famRow1]);
  });

  it('F-2: 家族の大人は自分が対象者の行だけ読める (家族スコープの行を家族単位では読めない)', async () => {
    expect(await visibleRows(asUser(famAdult.jwt))).toEqual([famRow1]);
  });

  it('X-1: どこにも所属しないユーザーは読めない', async () => {
    expect(await visibleRows(asUser(outsider.jwt))).toEqual([]);
  });

  it('S-1: super_admin は全件読める', async () => {
    expect(await visibleRows(asUser(superAdmin.jwt))).toEqual([orgRow1, orgRow2, famRow1, famRow2].sort());
  });

  it('N-1: 未認証 (anon) は読めない', async () => {
    expect(await visibleRows(anon())).toEqual([]);
  });
});
