/**
 * health_goals (健康目標) の値の制約 (#1229) の回帰テスト
 *
 * 修正前の health_goals (本番スナップショット supabase/baseline/prod_schema.sql):
 *   target_value  numeric(10,2) NOT NULL  ← 桁あふれは防げるが、-50 や 0 が入る
 *   current_value numeric(10,2)           ← 負の値が入る
 *   goal_type     text NOT NULL           ← '' や 'x y'、日本語、長大な文字列でも入る
 *   status        text                    ← 本番には health_goals_status_check がある (リポジトリの旧 migration には無かった)
 * RLS は本人の行だけに絞っているが、アプリ (POST /api/health/goals) の入力検証は PostgREST を直接叩けば迂回できる。
 * このテストは「ログインユーザーが PostgREST で自分の行を直接 INSERT / UPDATE する」経路で、DB の制約が効くことを確かめる。
 *
 * 修正後 (20261007160600_health_goals_value_constraints.sql):
 *   health_goals_target_value_positive       CHECK (target_value > 0)
 *   health_goals_current_value_nonnegative   CHECK (current_value IS NULL OR current_value >= 0)
 *   health_goals_goal_type_format            CHECK (goal_type ~ '^[a-z][a-z0-9_-]{0,63}$')   ← 列挙ではなく形式だけ
 *   health_goals_status_check                本番にあるものを migration に明文化 (挙動は修正前から同じ)
 * 違反は SQLSTATE 23514 (check_violation) で、メッセージに制約名が入る。
 * goal_type を列挙にしないのは、種類を足すたびに migration を要さないため。種類ごとの値の範囲はアプリ層で検証する。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/health-goals-constraints.test.ts
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
// クライアントファクトリ (health-recipes-own-policies.test.ts と同型)
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
// テストユーザー (使い捨て。ローカル専用のパスワード)
//   health_goals の user_id は auth.users への外部キーなので、プロフィール行は要らない。
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  jwt: string;
}

const TS = Date.now();
/** note に入れる印。後片付けと「行が残っていないこと」の確認で、このテストが入れた行だけを特定する */
const MARK = `gc-${TS}`;

async function createTestUser(label: string): Promise<TestUser> {
  const email = `rls-health-goals-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-rls';

  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user ${email}: ${authError?.message}`);
  }
  const userId = authData.user.id;

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signInResult = await anonClient().auth.signInWithPassword({ email, password });
  if (signInResult.error || !signInResult.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${email}: ${signInResult.error?.message}`);
  }
  return { userId, jwt: signInResult.data.session.access_token };
}

let owner: TestUser;

beforeAll(async () => {
  owner = await createTestUser('owner');
}, 60_000);

afterAll(async () => {
  // service role で、このテストが入れた行だけを消す
  await srAdmin.from('health_goals').delete().like('note', `${MARK}%`);

  // 後片付けの確認 (残っていれば失敗させる)
  const { data: left } = await srAdmin.from('health_goals').select('id').like('note', `${MARK}%`);
  expect(left ?? []).toEqual([]);

  // ユーザーを消すと、user_id の外部キー (ON DELETE CASCADE) でそのユーザーの行も消える
  if (owner?.userId) await srAdmin.auth.admin.deleteUser(owner.userId);
}, 30_000);

// ---------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------
/** 本人の JWT で自分の行を INSERT する (RLS は通る。DB の制約だけを確かめる) */
async function insertGoal(overrides: Record<string, unknown> = {}) {
  return authedClient(owner.jwt)
    .from('health_goals')
    .insert({
      user_id: owner.userId,
      goal_type: 'weight',
      target_value: 60,
      target_unit: 'kg',
      note: MARK,
      ...overrides,
    })
    .select('id, goal_type, target_value, current_value, status')
    .single();
}

/** service role で、このテストが入れた行の件数を数える (拒否された INSERT が行を残していないことの確認) */
async function countMarked(): Promise<number> {
  const { count, error } = await srAdmin
    .from('health_goals')
    .select('id', { count: 'exact', head: true })
    .like('note', `${MARK}%`);
  if (error) throw new Error(`countMarked: ${error.message}`);
  return count ?? 0;
}

/** check_violation (23514) で、期待する制約名が出ていること */
function expectCheckViolation(error: { code?: string; message?: string } | null, constraint: string) {
  expect(error).not.toBeNull();
  expect(error!.code).toBe('23514');
  expect(error!.message).toContain(`"${constraint}"`);
}

// ---------------------------------------------------------------
// target_value: 正の数だけ
// ---------------------------------------------------------------
describe('health_goals.target_value', () => {
  it.each([
    ['負の値 (-50)', -50],
    ['0', 0],
    ['numeric(10,2) で 0.00 に丸まる値 (0.004)', 0.004],
  ])('T-1: %s の INSERT は拒否される (23514・行は残らない)', async (_label, value) => {
    const before = await countMarked();
    const { error } = await insertGoal({ target_value: value });
    expectCheckViolation(error, 'health_goals_target_value_positive');
    expect(await countMarked()).toBe(before);
  });

  it('T-2: 正の値 (0.01 / 60 / 100000) は INSERT できる', async () => {
    for (const value of [0.01, 60, 100000]) {
      const { data, error } = await insertGoal({ target_value: value });
      expect(error).toBeNull();
      expect(Number(data?.target_value)).toBe(value);
    }
  });
});

// ---------------------------------------------------------------
// current_value: NULL か 0 以上
// ---------------------------------------------------------------
describe('health_goals.current_value', () => {
  it('C-1: 負の値の INSERT は拒否される (23514・行は残らない)', async () => {
    const before = await countMarked();
    const { error } = await insertGoal({ current_value: -0.01 });
    expectCheckViolation(error, 'health_goals_current_value_nonnegative');
    expect(await countMarked()).toBe(before);
  });

  it('C-2: 0 (例: 今日の歩数 0 歩) と NULL (未計測) と正の値は INSERT できる', async () => {
    for (const value of [0, null, 61.2]) {
      const { data, error } = await insertGoal({ goal_type: 'steps', target_unit: '歩', target_value: 8000, current_value: value });
      expect(error).toBeNull();
      expect(data?.current_value === null ? null : Number(data?.current_value)).toBe(value);
    }
  });
});

// ---------------------------------------------------------------
// goal_type: 形式だけ (列挙にはしない)
// ---------------------------------------------------------------
describe('health_goals.goal_type', () => {
  it.each([
    ['空文字', ''],
    ['大文字を含む', 'Weight'],
    ['日本語', '体重'],
    ['数字で始まる', '1weight'],
    ['空白を含む', 'weight loss'],
    ['記号を含む', "weight';drop"],
    ['ハイフンで始まる', '-weight'],
    ['アンダースコアで始まる', '_weight'],
    ['末尾に改行', 'weight\n'],
    ['65 文字', 'a'.repeat(65)],
  ])('G-1: %s の goal_type の INSERT は拒否される (23514・行は残らない)', async (_label, goalType) => {
    const before = await countMarked();
    const { error } = await insertGoal({ goal_type: goalType });
    expectCheckViolation(error, 'health_goals_goal_type_format');
    expect(await countMarked()).toBe(before);
  });

  it.each([
    // アプリが受け付ける種類 (Web は weight / body_fat / steps、現行モバイルは step_count / sleep_hours も送る)
    'weight',
    'body_fat',
    'steps',
    'step_count',
    'sleep_hours',
    // 形式に合えば、DB はまだ知らない種類も通す (種類を足すたびに migration を要さないため)
    'a',
    'muscle-mass_2',
    'a'.repeat(64),
    `rls-drift-${TS}-1`,
  ])('G-2: goal_type %s は INSERT できる', async (goalType) => {
    const { data, error } = await insertGoal({ goal_type: goalType });
    expect(error).toBeNull();
    expect(data?.goal_type).toBe(goalType);
  });
});

// ---------------------------------------------------------------
// UPDATE でも制約が効く (本人が自分の行を PostgREST で書き換える経路)
// ---------------------------------------------------------------
describe('health_goals の UPDATE', () => {
  let rowId: string;

  /** service role で行を読む (RLS の影響を受けない) */
  async function readRow() {
    const { data, error } = await srAdmin
      .from('health_goals')
      .select('goal_type, target_value, current_value, status, note')
      .eq('id', rowId)
      .single();
    if (error) throw new Error(`readRow: ${error.message}`);
    return data;
  }

  it('U-0: 準備: 正常な行を作る', async () => {
    const { data, error } = await insertGoal({ target_value: 60, current_value: 65 });
    expect(error).toBeNull();
    rowId = data!.id as string;
  });

  it.each([
    ['target_value を負にする', { target_value: -1 }, 'health_goals_target_value_positive'],
    ['target_value を 0 にする', { target_value: 0 }, 'health_goals_target_value_positive'],
    ['current_value を負にする', { current_value: -5 }, 'health_goals_current_value_nonnegative'],
    ['goal_type を形式に合わない値にする', { goal_type: 'Bad Type' }, 'health_goals_goal_type_format'],
  ])('U-1: %s UPDATE は拒否される (23514・値は変わらない)', async (_label, patch, constraint) => {
    const before = await readRow();
    const { error } = await authedClient(owner.jwt).from('health_goals').update(patch).eq('id', rowId);
    expectCheckViolation(error, constraint);
    expect(await readRow()).toEqual(before);
  });

  it('U-2: 正常な値への UPDATE は通る (current_value を 0 や NULL に戻すことも、範囲内の target_value への変更も)', async () => {
    const client = authedClient(owner.jwt);
    for (const patch of [{ target_value: 58.5 }, { current_value: 0 }, { current_value: null }, { note: MARK }]) {
      const { data, error } = await client.from('health_goals').update(patch).eq('id', rowId).select('id');
      expect(error).toBeNull();
      expect((data ?? []).map((r) => r.id)).toEqual([rowId]);
    }
    const row = await readRow();
    expect(Number(row.target_value)).toBe(58.5);
    expect(row.current_value).toBeNull();
  });
});

// ---------------------------------------------------------------
// status: 本番には元からある制約。migration に明文化しただけで、挙動は修正前から変わらない
// ---------------------------------------------------------------
describe('health_goals.status', () => {
  it('S-1: 想定外の status の INSERT は拒否される (23514・health_goals_status_check)', async () => {
    const before = await countMarked();
    const { error } = await insertGoal({ status: 'bogus' });
    expectCheckViolation(error, 'health_goals_status_check');
    expect(await countMarked()).toBe(before);
  });

  it.each(['active', 'achieved', 'paused', 'cancelled'])('S-2: status %s は INSERT できる', async (status) => {
    const { data, error } = await insertGoal({ status });
    expect(error).toBeNull();
    expect(data?.status).toBe(status);
  });
});
