/**
 * #1239 is_inactive_user RPC の EXECUTE 権限の回帰テスト
 *
 * 修正前: public.is_inactive_user(p_user_id uuid) は SECURITY DEFINER で auth.users.last_sign_in_at を読み、
 * 呼び出し元の権限を確認しないまま authenticated に EXECUTE が開いていた。
 * ログインユーザーなら誰でも、他人の user_id (家族メンバー一覧などで得られる) を渡して
 *   - そのアカウントが実在するか (存在しない UUID は true、実在してサインイン済みは false)
 *   - 直近 30 日にログインしたか
 * を調べられた (オラクル)。
 *
 * 期待する認可 (修正後):
 *   - authenticated: 自分・他人・存在しない UUID のいずれでも EXECUTE 不可 (permission denied, SQLSTATE 42501)
 *   - anon: 修正前後とも EXECUTE 不可
 *   - service_role: 呼べて boolean が返る (正当な経路)
 *   - 兄弟関数 list_orgs_with_inactive_owner / list_families_with_inactive_representative は
 *     関数内で super_admin を確認しており、一般ユーザーはエラー (今の挙動の確認。この修正では変えない)
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/is-inactive-user-rpc.test.ts
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
// クライアントファクトリ (support-ticket-messages-rls.test.ts と同型)
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

function authedClient(accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const srAdmin = serviceRoleClient();

// ---------------------------------------------------------------
// テストユーザー
//   attacker: 一般ユーザー (呼び出し元) / victim: 狙われるユーザー (サインイン済み = 休眠ではない)
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls';
// 実在しない UUID (v4 形式。auth.users に無い)
const MISSING_USER_ID = '00000000-0000-4000-8000-000000001239';

let attacker: TestUser;
let victim: TestUser;

async function createTestUser(email: string): Promise<TestUser> {
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;

  // サインインで last_sign_in_at が現在時刻になる (= is_inactive_user は false を返すはず)
  const signIn = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${email}: ${signIn.error?.message}`);
  }
  return { userId, email, jwt: signIn.data.session.access_token };
}

beforeAll(async () => {
  attacker = await createTestUser(`rls-1239-attacker-${TS}@homegohan.test`);
  victim = await createTestUser(`rls-1239-victim-${TS}@homegohan.test`);
}, 60_000);

afterAll(async () => {
  for (const u of [attacker, victim]) {
    if (u?.userId) await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

// ================================================================
// authenticated (一般ユーザー)
// ================================================================
describe('#1239 is_inactive_user: authenticated は呼べない', () => {
  it('S-1: 他人の実在 UUID を渡しても permission denied (休眠状態を読み取れない)', async () => {
    const { data, error } = await authedClient(attacker.jwt).rpc('is_inactive_user', { p_user_id: victim.userId });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('S-2: 存在しない UUID でも permission denied (実在確認のオラクルにならない)', async () => {
    const { data, error } = await authedClient(attacker.jwt).rpc('is_inactive_user', { p_user_id: MISSING_USER_ID });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('S-3: 自分自身の UUID でも permission denied (正当な利用経路が無いため全員閉じる)', async () => {
    const { data, error } = await authedClient(attacker.jwt).rpc('is_inactive_user', { p_user_id: attacker.userId });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });
});

// ================================================================
// anon
// ================================================================
describe('#1239 is_inactive_user: anon は呼べない (修正前後とも)', () => {
  it('S-4: anon は permission denied', async () => {
    const { data, error } = await anonClient().rpc('is_inactive_user', { p_user_id: victim.userId });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });
});

// ================================================================
// service_role
// ================================================================
describe('#1239 is_inactive_user: service_role は呼べる (修正後も)', () => {
  it('S-5: サインイン済みの実在ユーザーは false (休眠ではない)', async () => {
    const { data, error } = await srAdmin.rpc('is_inactive_user', { p_user_id: victim.userId });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it('S-6: 存在しない UUID は true (従来どおり「休眠扱い」)', async () => {
    const { data, error } = await srAdmin.rpc('is_inactive_user', { p_user_id: MISSING_USER_ID });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });
});

// ================================================================
// 兄弟関数 (現状の挙動の確認。この修正では変えない)
// ================================================================
describe('#1239 兄弟関数は一般ユーザーにはエラー (super_admin のみ)', () => {
  it('S-7: list_orgs_with_inactive_owner は一般ユーザーだとエラー', async () => {
    const { data, error } = await authedClient(attacker.jwt).rpc('list_orgs_with_inactive_owner');
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it('S-8: list_families_with_inactive_representative は一般ユーザーだとエラー', async () => {
    const { data, error } = await authedClient(attacker.jwt).rpc('list_families_with_inactive_representative');
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});
