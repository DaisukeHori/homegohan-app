/**
 * user_profiles の特権列を、本人が自分の行を作る (INSERT) ときにも入れられないことの回帰テスト
 *
 * 特権列ガード guard_user_profiles_privileged は BEFORE UPDATE のトリガーで、INSERT には掛かっていなかった。
 * INSERT のポリシーは WITH CHECK (auth.uid() = id) だけのため、プロフィールの行をまだ持っていない本人
 * (新規登録して初期設定を保存する前) は、自分の行を作るときに roles などの特権列へ任意の値を入れられた。
 *
 * 修正 (20261007111000): BEFORE INSERT のトリガーで、authenticated / anon が作る行の特権列が既定値のままであることを求める。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/user-profiles-insert-guard.test.ts
 */

import { randomBytes } from 'node:crypto';
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
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
let userSeq = 0;
let orgId = '';
let familyId = '';

/** プロフィール行を持たない (新規登録しただけの) ユーザーを作る */
async function createUserWithoutProfile(label: string): Promise<TestUser> {
  userSeq += 1;
  const email = `rls-profile-insert-${label}-${userSeq}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function getProfile(userId: string) {
  const { data } = await srAdmin
    .from('user_profiles')
    .select('id, nickname, roles, org_role, organization_id, family_id, is_active_in_org, frozen_at, department_id')
    .eq('id', userId)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

const base = { nickname: 'insert-guard', age_group: 'unspecified', gender: 'unspecified' };

beforeAll(async () => {
  const { data: org, error: orgError } = await srAdmin
    .from('organizations')
    .insert({ name: `profile insert guard org ${TS}` })
    .select('id')
    .single();
  if (orgError || !org) throw new Error(`organizations: ${orgError?.message}`);
  orgId = (org as { id: string }).id;

  // 家族は別のユーザーが作る (create_family_group は SECURITY DEFINER のため、このガードの対象外)
  const owner = await createUserWithoutProfile('family-owner');
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .insert({ id: owner.id, ...base });
  if (profileError) throw new Error(`owner profile: ${profileError.message}`);
  const { data: group, error: groupError } = await asUser(owner.jwt).rpc('create_family_group', {
    p_name: `profile insert guard family ${TS}`,
    p_plan_key: 'free',
  });
  if (groupError || !group) throw new Error(`create_family_group: ${groupError?.message}`);
  familyId = (group as { id: string }).id;
}, 60_000);

afterAll(async () => {
  if (familyId) await srAdmin.from('family_groups').delete().eq('id', familyId);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
  if (orgId) await srAdmin.from('organizations').delete().eq('id', orgId);
}, 60_000);

describe('user_profiles: 本人が自分の行を作るときに特権列を入れられない', () => {
  const privileged: Array<{ name: string; values: () => Record<string, unknown> }> = [
    { name: 'roles に super_admin', values: () => ({ roles: ['user', 'super_admin'] }) },
    { name: 'roles に admin', values: () => ({ roles: ['admin'] }) },
    { name: 'roles に support', values: () => ({ roles: ['support'] }) },
    {
      name: '組織の owner (organization_id + org_role)',
      values: () => ({ organization_id: orgId, org_role: 'owner', is_active_in_org: true }),
    },
    { name: '他人の家族 (family_id)', values: () => ({ family_id: familyId }) },
    { name: 'is_active_in_org = true', values: () => ({ is_active_in_org: true }) },
    { name: 'joined_org_at', values: () => ({ joined_org_at: '2026-01-01' }) },
    { name: 'frozen_reason', values: () => ({ frozen_reason: 'x' }) },
    { name: 'unban_at', values: () => ({ unban_at: new Date().toISOString() }) },
  ];

  for (const c of privileged) {
    it(`★${c.name} を入れた INSERT は 42501 で拒否され、行は作られない`, async () => {
      const user = await createUserWithoutProfile('attacker');
      const { error } = await asUser(user.jwt)
        .from('user_profiles')
        .insert({ id: user.id, ...base, ...c.values() });
      expect(error).not.toBeNull();
      expect(error!.code).toBe('42501');
      expect(error!.message).toContain('CANNOT_MODIFY_PRIVILEGED_COLUMN');
      expect(await getProfile(user.id)).toBeNull();
    });
  }

  it('★upsert (INSERT ... ON CONFLICT DO UPDATE) で特権列を入れても拒否される', async () => {
    const user = await createUserWithoutProfile('upsert-attacker');
    const { error } = await asUser(user.jwt)
      .from('user_profiles')
      .upsert({ id: user.id, ...base, roles: ['super_admin'] });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await getProfile(user.id)).toBeNull();
  });

  it('アプリの初期設定と同じ保存 (特権列なし) は今までどおり作れる。roles は既定の [user]', async () => {
    const user = await createUserWithoutProfile('normal');
    const { error } = await asUser(user.jwt).from('user_profiles').upsert({ id: user.id, ...base });
    expect(error).toBeNull();
    const profile = await getProfile(user.id);
    expect(profile).toMatchObject({
      roles: ['user'],
      org_role: null,
      organization_id: null,
      family_id: null,
      is_active_in_org: false,
      frozen_at: null,
      department_id: null,
    });
  });

  it('roles に既定値 [user] を明示した INSERT は通る', async () => {
    const user = await createUserWithoutProfile('explicit-default');
    const { error } = await asUser(user.jwt)
      .from('user_profiles')
      .insert({ id: user.id, ...base, roles: ['user'], is_active_in_org: false });
    expect(error).toBeNull();
    expect((await getProfile(user.id))?.roles).toEqual(['user']);
  });

  it('既に行を持つ本人の upsert (初期設定の保存) は通り、service_role が設定した特権列は変わらない', async () => {
    const user = await createUserWithoutProfile('existing');
    const { error: createError } = await asUser(user.jwt).from('user_profiles').insert({ id: user.id, ...base });
    expect(createError).toBeNull();
    const { error: adminError } = await srAdmin
      .from('user_profiles')
      .update({ organization_id: orgId, org_role: 'member', is_active_in_org: true })
      .eq('id', user.id);
    expect(adminError).toBeNull();

    const { error } = await asUser(user.jwt)
      .from('user_profiles')
      .upsert({ id: user.id, nickname: 'renamed', age_group: '30s', gender: 'other' });
    expect(error).toBeNull();
    expect(await getProfile(user.id)).toMatchObject({
      nickname: 'renamed',
      organization_id: orgId,
      org_role: 'member',
      is_active_in_org: true,
    });
  });

  it('service_role (管理 API) は特権列付きで行を作れる (対象外)', async () => {
    const user = await createUserWithoutProfile('by-admin');
    const { error } = await srAdmin
      .from('user_profiles')
      .insert({ id: user.id, ...base, roles: ['user', 'support'] });
    expect(error).toBeNull();
    expect((await getProfile(user.id))?.roles).toEqual(['user', 'support']);
  });
});
