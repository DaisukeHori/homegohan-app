/**
 * #1103 項目 10: e2e の後片付け (tests/e2e/helpers/membership.ts の cleanup) が、本物の DB の制約の下で組織と持ち主を残さないこと。
 *
 * organizations.owner_id は NOT NULL で、外部キー organizations_owner_id_fkey は auth.users への ON DELETE RESTRICT。
 * そのため持ち主のユーザーは組織を消した後でないと消せない。ところが組織の DELETE は
 * user_profiles.organization_id だけを ON DELETE SET NULL で外し org_role は残すので、所属している利用者が残っていると
 * CHECK user_profiles_org_consistency (両方 NULL か両方あり) に反して組織の DELETE が失敗する。
 * cleanup は所属を外してから組織を消し、そのあとユーザーを消す。
 *
 * ここで確かめること:
 *   - (前提の確認) 所属が残ったままの組織は、そのままでは DELETE できない (CHECK に反する) — cleanup が所属を外す理由
 *   - 持ち主 (org_role = 'owner') とメンバーが所属したままの組織を cleanup で消すと、組織と両方のユーザーが消える
 *     (e2e の setupFreshOrgWithMembers / operatorUser の形)
 *   - 持ち主が自分の組織に org_role = 'member' で所属したまま (e2e の 03 の α-5 の形) でも、cleanup の後に持ち主を消せる
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。本番には接続しない。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/e2e-org-cleanup-helper.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';
import { cleanup, createFreshOrg, setUserOrgRole } from '../../e2e/helpers/membership';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const srAdmin: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

/** CHECK 制約に反したときの PostgreSQL のエラーコード (check_violation) */
const PG_CHECK_VIOLATION = '23514';
/** パスワードの乱数部分のバイト数 (base64url で 24 文字) */
const PASSWORD_RANDOM_BYTES = 18;
/** パスワードの規則 (英大文字・小文字・数字・記号) を満たすための固定の末尾 */
const PASSWORD_SUFFIX = 'Aa1!';

/** テストが失敗したときに残りを片付けるための控え */
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const email = `e2e-cleanup-${label}-${randomUUID()}@homegohan.test`;
  const password = `${randomBytes(PASSWORD_RANDOM_BYTES).toString('base64url')}${PASSWORD_SUFFIX}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser(${label}): ${error?.message ?? 'user が返らない'}`);
  createdUserIds.push(data.user.id);
  return data.user.id;
}

/** 利用者を組織のメンバーにする (user_profiles を作る。特権列なので service_role で) */
async function joinOrg(userId: string, orgId: string, role: 'admin' | 'member'): Promise<void> {
  const { error } = await srAdmin
    .from('user_profiles')
    .upsert(
      { id: userId, nickname: `e2e-cleanup-${role}`, age_group: '30s', gender: 'other', organization_id: orgId, org_role: role },
      { onConflict: 'id' },
    );
  if (error) throw new Error(`joinOrg(${role}): ${error.message}`);
}

async function orgExists(orgId: string): Promise<boolean> {
  const { data, error } = await srAdmin.from('organizations').select('id').eq('id', orgId);
  if (error) throw new Error(`orgExists: ${error.message}`);
  return (data ?? []).length > 0;
}

async function userExists(userId: string): Promise<boolean> {
  const { data, error } = await srAdmin.auth.admin.getUserById(userId);
  if (error) return false;
  return data.user !== null;
}

afterAll(async () => {
  // 失敗で残ったものだけを片付ける (成功していれば何も残っていない)。所属を外す → 組織 → ユーザーの順
  if (createdOrgIds.length > 0) {
    await srAdmin.from('user_profiles').update({ organization_id: null, org_role: null }).in('organization_id', createdOrgIds);
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
});

describe('e2e の後片付け (helpers/membership.ts の cleanup) — 所属を外してから組織、その後ユーザー', () => {
  it('所属が残ったままの組織は、そのままでは DELETE できない (CHECK user_profiles_org_consistency)', async () => {
    const owner = await createUser('precheck-owner');
    const orgId = await createFreshOrg({ ownerUserId: owner, name: `E2E Cleanup Precheck ${randomUUID()}` });
    createdOrgIds.push(orgId);

    const { error } = await srAdmin.from('organizations').delete().eq('id', orgId);

    expect(error?.code).toBe(PG_CHECK_VIOLATION);
    expect(error?.message).toContain('user_profiles_org_consistency');
    expect(await orgExists(orgId)).toBe(true);

    await cleanup({ orgIds: [orgId], userIds: [owner] });
    expect(await orgExists(orgId)).toBe(false);
    expect(await userExists(owner)).toBe(false);
  });

  it('持ち主とメンバーが所属したままの組織を消すと、組織も両方のユーザーも残らない', async () => {
    const owner = await createUser('owner');
    const member = await createUser('member');
    const admin = await createUser('admin');
    const orgId = await createFreshOrg({ ownerUserId: owner, name: `E2E Cleanup Members ${randomUUID()}` });
    createdOrgIds.push(orgId);
    await joinOrg(member, orgId, 'member');
    await joinOrg(admin, orgId, 'admin');

    await expect(cleanup({ orgIds: [orgId], userIds: [owner, member, admin] })).resolves.toBeUndefined();

    expect(await orgExists(orgId)).toBe(false);
    expect(await userExists(owner)).toBe(false);
    expect(await userExists(member)).toBe(false);
    expect(await userExists(admin)).toBe(false);
  });

  it('持ち主が自分の組織に member で所属したままでも (α-5 の形)、cleanup の後に持ち主を消せる', async () => {
    const owner = await createUser('alpha5-owner');
    const orgId = await createFreshOrg({ ownerUserId: owner, name: `E2E Cleanup Alpha5 ${randomUUID()}` });
    createdOrgIds.push(orgId);
    await setUserOrgRole({ userId: owner, orgId, orgRole: 'member' });

    await cleanup({ orgIds: [orgId] });
    expect(await orgExists(orgId)).toBe(false);
    // 持ち主の user_profiles は残り、所属は両方 NULL になっている
    const { data: profile, error: profileError } = await srAdmin
      .from('user_profiles')
      .select('organization_id, org_role')
      .eq('id', owner)
      .single();
    expect(profileError).toBeNull();
    expect(profile).toEqual({ organization_id: null, org_role: null });

    const { error } = await srAdmin.auth.admin.deleteUser(owner);
    expect(error).toBeNull();
    expect(await userExists(owner)).toBe(false);
  });
});
