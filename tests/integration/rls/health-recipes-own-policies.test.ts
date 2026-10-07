/**
 * 本番ドリフト D-1〜D-12 (docs/operations/rls-drift-20261006.md) の「own」ポリシーの挙動テスト
 *
 * 対象 (本人の行だけを操作できるポリシー):
 *   - health_goals   : view / insert / update / delete
 *   - health_records : view / insert / update / delete
 *   - health_streaks : view / insert / update / delete
 *   - recipes        : "Users can manage own recipes" (ALL)
 *
 * 本番の定義は migration と書き方が違う (TO public、UPDATE / ALL に WITH CHECK が無い) が、
 * 条件が auth.uid() = user_id のため未ログインは一致せず、WITH CHECK を省略すると USING が使われるため、
 * 挙動は migration の定義 (TO authenticated、WITH CHECK (auth.uid() = user_id)) と同じはず。
 * このテストは、本番の定義のまま (ベースライン) でも、migration の定義に揃えた後でも同じ結果になることを確かめる。
 *
 * 期待する認可:
 *   - 本人は自分の行を作成・閲覧・更新・削除できる
 *   - 本人でも、自分の行の user_id を他人に書き換えることはできない (WITH CHECK)
 *   - 他人は本人の行を閲覧・更新・削除できず、本人の user_id で行を作れない
 *   - 未認証 (anon) は閲覧も作成もできない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/health-recipes-own-policies.test.ts
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
// テストユーザー (support-ticket-messages-rls.test.ts と同型)
// ---------------------------------------------------------------
interface RlsTestUser {
  userId: string;
  email: string;
  jwt: string;
}

async function createRlsTestUser(params: { email: string; roles: string[] }): Promise<RlsTestUser> {
  const password = 'TestPass!2026-rls';

  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email: params.email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user ${params.email}: ${authError?.message}`);
  }
  const userId = authData.user.id;

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signInResult = await anonClient().auth.signInWithPassword({ email: params.email, password });
  if (signInResult.error || !signInResult.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${params.email}: ${signInResult.error?.message}`);
  }
  const jwt = signInResult.data.session.access_token;

  // 本人の JWT で自分のプロフィールを作成 (Users can insert own profile)
  const { error: insertError } = await authedClient(jwt).from('user_profiles').insert({
    id: userId,
    nickname: `rls-test-${userId.slice(0, 8)}`,
    age_group: '30s',
    gender: 'other',
  });
  if (insertError) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to insert profile for ${params.email}: ${insertError.message}`);
  }

  // roles は特権列ガードにより本人では変更できないため service_role で設定する
  const { error: updateError } = await srAdmin
    .from('user_profiles')
    .update({ roles: params.roles })
    .eq('id', userId);
  if (updateError) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to set roles for ${params.email}: ${updateError.message}`);
  }

  return { userId, email: params.email, jwt };
}

async function deleteRlsTestUser(userId: string): Promise<void> {
  await srAdmin.from('user_profiles').delete().eq('id', userId);
  await srAdmin.auth.admin.deleteUser(userId);
}

// ---------------------------------------------------------------
// 対象テーブル
//   row(userId, variant): INSERT する行 (variant ごとに一意制約がぶつからない値にする)
//   update: 本人が書き換える列と値 / read: その列の値を読む
// ---------------------------------------------------------------
interface OwnTableCase {
  table: string;
  row: (userId: string, variant: number) => Record<string, unknown>;
  update: Record<string, unknown>;
  read: (row: Record<string, unknown>) => unknown;
}

const TS = Date.now();

const CASES: OwnTableCase[] = [
  {
    table: 'health_goals',
    row: (userId, variant) => ({
      user_id: userId,
      goal_type: `rls-drift-${TS}-${variant}`,
      target_value: 60,
      target_unit: 'kg',
    }),
    update: { target_value: 61 },
    read: (r) => Number(r.target_value),
  },
  {
    table: 'health_records',
    row: (userId, variant) => ({
      user_id: userId,
      record_date: `2026-01-${String(variant).padStart(2, '0')}`,
    }),
    update: { mood_score: 3 },
    read: (r) => r.mood_score,
  },
  {
    table: 'health_streaks',
    row: (userId, variant) => ({
      user_id: userId,
      streak_type: `rls-drift-${TS}-${variant}`,
    }),
    update: { current_streak: 5 },
    read: (r) => r.current_streak,
  },
  {
    table: 'recipes',
    row: (userId, variant) => ({
      user_id: userId,
      name: `rls-drift-${TS}-${variant}`,
    }),
    update: { description: `rls-drift-${TS} updated` },
    read: (r) => r.description,
  },
];

let owner: RlsTestUser;
let other: RlsTestUser;

beforeAll(async () => {
  [owner, other] = await Promise.all([
    createRlsTestUser({ email: `rls-drift-owner-${TS}@homegohan.test`, roles: ['user'] }),
    createRlsTestUser({ email: `rls-drift-other-${TS}@homegohan.test`, roles: ['user'] }),
  ]);
}, 60_000);

afterAll(async () => {
  const userIds = [owner, other].filter((u) => u?.userId).map((u) => u.userId);
  // health_* は user_id の FK が ON DELETE CASCADE、recipes は ON DELETE SET NULL のため、行を先に消す
  for (const c of CASES) {
    await srAdmin.from(c.table).delete().in('user_id', userIds);
  }
  for (const userId of userIds) {
    await deleteRlsTestUser(userId);
  }
}, 30_000);

describe.each(CASES)('$table の own ポリシー', (c) => {
  let rowId: string;

  /** service_role で行を読む (RLS の影響を受けない) */
  async function readAsService(): Promise<Record<string, unknown> | null> {
    const { data, error } = await srAdmin.from(c.table).select('*').eq('id', rowId).maybeSingle();
    if (error) throw new Error(`Failed to read ${c.table}: ${error.message}`);
    return data as Record<string, unknown> | null;
  }

  it('O-1: 本人は自分の行を作成できる', async () => {
    const { data, error } = await authedClient(owner.jwt)
      .from(c.table)
      .insert(c.row(owner.userId, 1))
      .select('id, user_id')
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(owner.userId);
    rowId = data!.id as string;
  });

  it('O-2: 本人は自分の行を読める', async () => {
    const { data, error } = await authedClient(owner.jwt).from(c.table).select('id').eq('id', rowId);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([rowId]);
  });

  it('O-3: 本人は自分の行を更新できる', async () => {
    const { data, error } = await authedClient(owner.jwt)
      .from(c.table)
      .update(c.update)
      .eq('id', rowId)
      .select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([rowId]);
    const row = await readAsService();
    expect(c.read(row!)).toEqual(Object.values(c.update)[0]);
  });

  it('O-4: 本人でも自分の行の user_id を他人に書き換えられない (42501・行は本人のまま)', async () => {
    const { error } = await authedClient(owner.jwt)
      .from(c.table)
      .update({ user_id: other.userId })
      .eq('id', rowId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    const row = await readAsService();
    expect(row?.user_id).toBe(owner.userId);
  });

  it('X-1: 他人は本人の行を読めない (0 行)', async () => {
    const { data, error } = await authedClient(other.jwt).from(c.table).select('id').eq('id', rowId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('X-2: 他人は本人の行を更新できない (0 行・値は変わらない)', async () => {
    const before = await readAsService();
    const { data, error } = await authedClient(other.jwt)
      .from(c.table)
      .update({ user_id: other.userId })
      .eq('id', rowId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const after = await readAsService();
    expect(after).toEqual(before);
  });

  it('X-3: 他人は本人の行を削除できない (0 行・行は残る)', async () => {
    const { data, error } = await authedClient(other.jwt)
      .from(c.table)
      .delete()
      .eq('id', rowId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await readAsService()).not.toBeNull();
  });

  it('X-4: 他人は本人の user_id で行を作れない (42501)', async () => {
    const { error } = await authedClient(other.jwt).from(c.table).insert(c.row(owner.userId, 2));
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('N-1: 未認証 (anon) は本人の行を読めない (0 行)', async () => {
    const { data, error } = await anonClient().from(c.table).select('id').eq('id', rowId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('N-2: 未認証 (anon) は行を作れない (42501)', async () => {
    const { error } = await anonClient().from(c.table).insert(c.row(owner.userId, 3));
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('O-5: 本人は自分の行を削除できる', async () => {
    const { data, error } = await authedClient(owner.jwt)
      .from(c.table)
      .delete()
      .eq('id', rowId)
      .select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([rowId]);
    expect(await readAsService()).toBeNull();
  });
});
