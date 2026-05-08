/**
 * RLS 4 テーブル policy smoke test (PR #911 証跡)
 *
 * 対象テーブル:
 *   - moderation_flags  : admin/super_admin のみ全操作
 *   - organizations     : org_admin は自組織のみ SELECT、admin/super_admin は全操作
 *   - sport_presets     : 全ユーザー (anon 含む) SELECT 可、super_admin のみ書き込み
 *   - experiment_assignments : super_admin のみ SELECT/DELETE
 *
 * 実行:
 *   SUPABASE_INTEGRATION_TEST=1 npm run test:integration -- tests/integration/rls/
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ---------------------------------------------------------------
// クライアントファクトリ
// ---------------------------------------------------------------
function anonClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function serviceRoleClient(): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

// service_role client のシングルトン (setup/cleanup 用)
const srAdmin = serviceRoleClient();

/** JWT 付き認証済みクライアントを返す */
function authedClient(accessToken: string): SupabaseClient {
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  return client;
}

// ---------------------------------------------------------------
// テスト専用ユーザー作成ヘルパー
// user_profiles の必須カラムのみ設定する最小実装
// (既存 helpers は display_name を使うが prod スキーマにそのカラムはない)
// ---------------------------------------------------------------
interface RlsTestUser {
  userId: string;
  email: string;
  jwt: string;
}

async function createRlsTestUser(params: {
  email: string;
  roles: string[];
  organizationId?: string;
}): Promise<RlsTestUser> {
  const password = 'TestPass!2026-rls';

  // Step 1: auth ユーザーを admin API で作成
  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email: params.email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user ${params.email}: ${authError?.message}`);
  }
  const userId = authData.user.id;

  // Step 2: サインインして JWT を取得
  const signInResult = await srAdmin.auth.signInWithPassword({
    email: params.email,
    password,
  });
  if (signInResult.error || !signInResult.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${params.email}: ${signInResult.error?.message}`);
  }
  const jwt = signInResult.data.session.access_token;

  // Step 3: ユーザー自身の JWT で user_profiles を INSERT
  // (policy: "Users can insert own profile" = WITH CHECK (auth.uid() = id))
  const userClient = authedClient(jwt);
  const { error: insertError } = await userClient.from('user_profiles').insert({
    id: userId,
    nickname: `rls-test-${userId.slice(0, 8)}`,
    age_group: '30s',
    gender: 'other',
  });

  if (insertError) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to insert profile for ${params.email}: ${insertError.message}`);
  }

  // Step 4: ユーザー自身の JWT で roles と organization_id を UPDATE
  // (policy: "Users can update own profile" = USING (auth.uid() = id))
  const updatePayload: Record<string, unknown> = { roles: params.roles };
  if (params.organizationId) {
    updatePayload.organization_id = params.organizationId;
  }
  const { error: updateError } = await userClient
    .from('user_profiles')
    .update(updatePayload)
    .eq('id', userId);

  if (updateError) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to update profile roles for ${params.email}: ${updateError.message}`);
  }

  return { userId, email: params.email, jwt };
}

async function deleteRlsTestUser(userId: string): Promise<void> {
  await srAdmin.from('user_profiles').delete().eq('id', userId);
  await srAdmin.auth.admin.deleteUser(userId);
}

// ---------------------------------------------------------------
// テストユーザー & 組織のセットアップ
// ---------------------------------------------------------------
const TS = Date.now();

let regularUser: RlsTestUser;
let adminUser: RlsTestUser;
let testOrgId: string;

beforeAll(async () => {
  // テスト用 organization を service_role で作成 (cleanup 用に ID 保持)
  const { data: orgData, error: orgError } = await srAdmin
    .from('organizations')
    .insert({ name: `RLS Smoke Test Org ${TS}`, plan: 'standard' })
    .select('id')
    .single();

  if (orgError || !orgData) {
    throw new Error(`Failed to create test organization: ${orgError?.message}`);
  }
  testOrgId = orgData.id;

  // 一般ユーザー (roles: ['user'])
  regularUser = await createRlsTestUser({
    email: `rls-regular-${TS}@homegohan.test`,
    roles: ['user'],
  });

  // admin ユーザー (roles: ['admin'])
  adminUser = await createRlsTestUser({
    email: `rls-admin-${TS}@homegohan.test`,
    roles: ['admin'],
  });
}, 60_000);

afterAll(async () => {
  // テストユーザーを削除
  if (regularUser?.userId) {
    await deleteRlsTestUser(regularUser.userId);
  }
  if (adminUser?.userId) {
    await deleteRlsTestUser(adminUser.userId);
  }
  // テスト組織を削除
  if (testOrgId) {
    await srAdmin.from('organizations').delete().eq('id', testOrgId);
  }
}, 30_000);

// ================================================================
// 1. anon クライアント: RLS 拒否確認
//    sport_presets は USING (true) のため anon でも SELECT 可
// ================================================================
describe('anon: RLS 拒否確認', () => {
  const anon = anonClient();

  it('anon: moderation_flags SELECT → 0 行 (RLS 拒否)', async () => {
    const { data, error } = await anon.from('moderation_flags').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('anon: organizations SELECT → 0 行 (RLS 拒否)', async () => {
    const { data, error } = await anon.from('organizations').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('anon: sport_presets SELECT → 全件返却 (USING true で anon 許可)', async () => {
    const { data, error } = await anon.from('sport_presets').select('id');
    // sport_presets_select_all は USING (true) — anon も通る
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    // マスタデータが存在するはずなので 1 件以上
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('anon: experiment_assignments SELECT → 0 行 (RLS 拒否)', async () => {
    const { data, error } = await anon.from('experiment_assignments').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ================================================================
// 2. authenticated 一般ユーザー (role: user)
// ================================================================
describe('authenticated(user): role なしユーザーの RLS 確認', () => {
  it('sport_presets SELECT 可 (全認証ユーザー許可)', async () => {
    const client = authedClient(regularUser.jwt);
    const { data, error } = await client.from('sport_presets').select('id');
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('sport_presets INSERT 拒否 (super_admin 以外)', async () => {
    const client = authedClient(regularUser.jwt);
    const { error } = await client.from('sport_presets').insert({
      id: `rls-smoke-test-${TS}`,
      name_ja: 'テスト競技',
      name_en: 'Test Sport',
      category: 'test',
      demand_vector: {},
    });
    // RLS 違反: error が返るはず
    expect(error).not.toBeNull();
  });

  it('moderation_flags SELECT → 0 行 (admin 以外は見えない)', async () => {
    const client = authedClient(regularUser.jwt);
    const { data, error } = await client.from('moderation_flags').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('organizations SELECT → 0 行 (org_admin / admin 以外は見えない)', async () => {
    const client = authedClient(regularUser.jwt);
    const { data, error } = await client.from('organizations').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('experiment_assignments SELECT → 0 行 (super_admin 以外は見えない)', async () => {
    const client = authedClient(regularUser.jwt);
    const { data, error } = await client.from('experiment_assignments').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ================================================================
// 3. authenticated admin ユーザー (role: admin)
//    organizations と moderation_flags は SELECT 可
// ================================================================
describe('authenticated(admin): admin ロールの RLS 確認', () => {
  it('moderation_flags SELECT 可 (admin は全件)', async () => {
    const client = authedClient(adminUser.jwt);
    const { data, error } = await client.from('moderation_flags').select('*');
    // admin は全件 SELECT できる (0 件でもエラーなし)
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it('organizations SELECT 可 (admin は全件)', async () => {
    const client = authedClient(adminUser.jwt);
    const { data, error } = await client.from('organizations').select('id').eq('id', testOrgId);
    expect(error).toBeNull();
    // admin は作成したテスト org が見える
    expect(Array.isArray(data)).toBe(true);
    expect((data ?? []).length).toBe(1);
  });

  it('experiment_assignments SELECT → 0 行 (super_admin のみ許可、admin は不可)', async () => {
    const client = authedClient(adminUser.jwt);
    const { data, error } = await client.from('experiment_assignments').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ================================================================
// 4. org_admin ユーザー: 自組織のみ SELECT
// ================================================================
describe('authenticated(org_admin): 自組織のみ SELECT', () => {
  let orgAdminUser: RlsTestUser;

  beforeAll(async () => {
    // org_admin ユーザーを作成し、テスト組織に所属させる
    orgAdminUser = await createRlsTestUser({
      email: `rls-orgadmin-${TS}@homegohan.test`,
      roles: ['org_admin'],
      organizationId: testOrgId,
    });
  }, 30_000);

  afterAll(async () => {
    if (orgAdminUser?.userId) {
      await deleteRlsTestUser(orgAdminUser.userId);
    }
  }, 15_000);

  it('自組織の organizations SELECT 可', async () => {
    const client = authedClient(orgAdminUser.jwt);
    const { data, error } = await client.from('organizations').select('id').eq('id', testOrgId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);
    expect(data![0].id).toBe(testOrgId);
  });

  it('非所属組織の organizations SELECT → 0 行', async () => {
    // 別のテスト組織を作成
    const { data: otherOrg } = await srAdmin
      .from('organizations')
      .insert({ name: `Other Org ${TS}`, plan: 'standard' })
      .select('id')
      .single();

    const otherOrgId = otherOrg?.id;

    try {
      const client = authedClient(orgAdminUser.jwt);
      const { data, error } = await client
        .from('organizations')
        .select('id')
        .eq('id', otherOrgId);
      expect(error).toBeNull();
      // 自分が所属しない組織は見えない
      expect(data).toEqual([]);
    } finally {
      if (otherOrgId) {
        await srAdmin.from('organizations').delete().eq('id', otherOrgId);
      }
    }
  });
});

// ================================================================
// 5. service_role: RLS バイパス確認
// ================================================================
describe('service_role: RLS バイパス (全テーブル SELECT 可)', () => {
  const srClient = serviceRoleClient();

  it('moderation_flags SELECT 可 (service_role はバイパス)', async () => {
    const { data, error } = await srClient.from('moderation_flags').select('*').limit(1);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it('organizations SELECT 可 (service_role はバイパス)', async () => {
    const { data, error } = await srClient
      .from('organizations')
      .select('id')
      .eq('id', testOrgId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);
  });

  it('sport_presets SELECT 可 (service_role はバイパス)', async () => {
    const { data, error } = await srClient.from('sport_presets').select('id').limit(1);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('experiment_assignments SELECT 可 (service_role はバイパス、0 件でもエラーなし)', async () => {
    const { data, error } = await srClient.from('experiment_assignments').select('*').limit(1);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});
