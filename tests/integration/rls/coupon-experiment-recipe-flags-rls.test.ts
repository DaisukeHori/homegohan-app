/**
 * #1103 (項目 3・4): coupon_redemptions / experiment_assignments / recipe_flags の RLS の回帰テスト
 *
 * 3 つのテーブルとも、RLS のポリシーは supabase/migrations の最初のファイル (20251126124224。本番スキーマを
 * 統合したもの。#1281) に定義がある。このテストは「いまの定義がどの経路で何を許し、何を拒むか」を固定する。
 *
 * coupon_redemptions (クーポンの適用履歴):
 *   - SELECT: 本人の行 (user_id = auth.uid()) と、運営の finance / admin / super_admin は全行。
 *   - INSERT / UPDATE / DELETE のポリシーは無い。書き込みは service_role 専用の RPC apply_coupon (#1224) だけ。
 *     運営ロール (super_admin を含む) も PostgREST から直接は書けない (上限の検査を飛ばした適用を作らせない)。
 * experiment_assignments (A/B テストの割り当て):
 *   - SELECT / DELETE は super_admin だけ。INSERT / UPDATE のポリシーは無い。
 *   - 割り当ては GET /api/experiments/[key]/assignment が service_role で、ログインした本人の user_id に絞って作る
 *     (#1041)。本人に自分の variant を選ばせない・書き換えさせないため、本人向けのポリシーは足さない。
 * recipe_flags (レシピの通報):
 *   - INSERT: ログインした本人が reporter_id = 自分 の行だけ。anon と、他人を reporter にした行は拒否。
 *   - SELECT: 通報した本人の行と、admin / super_admin は全行。UPDATE: admin / super_admin。DELETE のポリシーは無い。
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/coupon-experiment-recipe-flags-rls.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ---------------------------------------------------------------
// クライアントファクトリ (user-badges-insert.test.ts と同型)
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
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls';
/** RLS で拒否されたときの SQLSTATE (insufficient_privilege) */
const RLS_DENIED = '42501';
/** クーポンの有効期間 (テスト中に切れなければよい) */
const COUPON_VALID_MS = 24 * 60 * 60 * 1000;

async function createTestUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `rls-1103-${label}-${TS}@homegohan.test`;
  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user ${email}: ${authError?.message}`);
  }
  const userId = authData.user.id;

  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: `rls-1103-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' });
  if (profileError) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to create profile ${email}: ${profileError.message}`);
  }

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signInResult = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (signInResult.error || !signInResult.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${email}: ${signInResult.error?.message}`);
  }
  return { userId, jwt: signInResult.data.session.access_token };
}

async function must<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as T;
}

// ---------------------------------------------------------------
// フィクスチャ
//   alice / bob: 一般ユーザー。finance / admin / superAdmin: 運営ロール
// ---------------------------------------------------------------
let alice: TestUser;
let bob: TestUser;
let finance: TestUser;
let admin: TestUser;
let superAdmin: TestUser;

let couponId = '';
let aliceRedemptionId = '';
let bobRedemptionId = '';
let experimentId = '';
let aliceFlagId = '';
let bobFlagId = '';

/** 割り当ての variant (テスト用の実験の variants と同じ値) */
const VARIANT_CONTROL = 'control';
const VARIANT_TREATMENT = 'treatment';
/** redemption の初期の割引額 (書き換えられていないことの確認に使う) */
const DISCOUNT_JPY = 100;

beforeAll(async () => {
  [alice, bob, finance, admin, superAdmin] = await Promise.all([
    createTestUser('alice', ['user']),
    createTestUser('bob', ['user']),
    createTestUser('finance', ['finance']),
    createTestUser('admin', ['admin']),
    createTestUser('superadmin', ['super_admin']),
  ]);

  const coupon = await must<{ id: string }>(
    'insert coupons',
    srAdmin
      .from('coupons')
      .insert({
        code: `RLS1103-${TS}`,
        discount_type: 'fixed',
        discount_value: DISCOUNT_JPY,
        valid_from: new Date().toISOString(),
        valid_until: new Date(Date.now() + COUPON_VALID_MS).toISOString(),
        created_by: superAdmin.userId,
      })
      .select('id')
      .single(),
  );
  couponId = coupon.id;

  const redemption = (userId: string) => ({
    coupon_id: couponId,
    user_id: userId,
    subscription_target: 'personal',
    applied_to_subscription_id: crypto.randomUUID(),
    discount_amount_jpy: DISCOUNT_JPY,
  });
  aliceRedemptionId = (await must<{ id: string }>('insert alice redemption', srAdmin.from('coupon_redemptions').insert(redemption(alice.userId)).select('id').single())).id;
  bobRedemptionId = (await must<{ id: string }>('insert bob redemption', srAdmin.from('coupon_redemptions').insert(redemption(bob.userId)).select('id').single())).id;

  const experiment = await must<{ id: string }>(
    'insert experiments',
    srAdmin
      .from('experiments')
      .insert({
        key: `rls-1103-${TS}`,
        name: 'RLS 1103',
        variants: [
          { key: VARIANT_CONTROL, weight: 50 },
          { key: VARIANT_TREATMENT, weight: 50 },
        ],
        status: 'running',
        created_by: superAdmin.userId,
      })
      .select('id')
      .single(),
  );
  experimentId = experiment.id;
  await must(
    'insert experiment_assignments',
    srAdmin.from('experiment_assignments').insert([
      { experiment_id: experimentId, user_id: alice.userId, variant_key: VARIANT_CONTROL },
      { experiment_id: experimentId, user_id: bob.userId, variant_key: VARIANT_CONTROL },
    ]),
  );

  aliceFlagId = (await must<{ id: string }>('insert alice flag', srAdmin.from('recipe_flags').insert({ reporter_id: alice.userId, reason: 'alice' }).select('id').single())).id;
  bobFlagId = (await must<{ id: string }>('insert bob flag', srAdmin.from('recipe_flags').insert({ reporter_id: bob.userId, reason: 'bob' }).select('id').single())).id;
}, 60_000);

afterAll(async () => {
  const users = [alice, bob, finance, admin, superAdmin].filter(Boolean);
  const userIds = users.map((u) => u.userId);
  if (couponId) await srAdmin.from('coupon_redemptions').delete().eq('coupon_id', couponId);
  if (couponId) await srAdmin.from('coupons').delete().eq('id', couponId);
  if (experimentId) await srAdmin.from('experiment_assignments').delete().eq('experiment_id', experimentId);
  if (experimentId) await srAdmin.from('experiments').delete().eq('id', experimentId);
  if (userIds.length > 0) await srAdmin.from('recipe_flags').delete().in('reporter_id', userIds);
  for (const u of users) {
    await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

/** service role で行を読む (RLS の影響を受けない確認用) */
async function rowOf(table: string, column: string, value: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(table).select('*').eq(column, value).maybeSingle();
  if (error) throw new Error(`rowOf ${table}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function idsVisibleTo(client: SupabaseClient, table: string, column: string, values: string[]): Promise<string[]> {
  const { data, error } = await client.from(table).select(column).in(column, values);
  expect(error).toBeNull();
  return ((data ?? []) as unknown as Array<Record<string, string>>).map((r) => r[column]).sort();
}

// ================================================================
// coupon_redemptions (#1103 項目 3)
// ================================================================
describe('#1103 coupon_redemptions: 読めるのは本人の行と運営 (finance / admin / super_admin)', () => {
  it('R-1: 本人は自分の行だけ読める (他人の行は見えない)', async () => {
    const ids = await idsVisibleTo(authedClient(alice.jwt), 'coupon_redemptions', 'id', [aliceRedemptionId, bobRedemptionId]);
    expect(ids).toEqual([aliceRedemptionId]);
  });

  it.each([
    ['finance', () => finance],
    ['admin', () => admin],
    ['super_admin', () => superAdmin],
  ])('R-2: %s は全員の行を読める', async (_role, who) => {
    const ids = await idsVisibleTo(authedClient(who().jwt), 'coupon_redemptions', 'id', [aliceRedemptionId, bobRedemptionId]);
    expect(ids).toEqual([aliceRedemptionId, bobRedemptionId].sort());
  });

  it('R-3: anon は読めない', async () => {
    const ids = await idsVisibleTo(anonClient(), 'coupon_redemptions', 'id', [aliceRedemptionId, bobRedemptionId]);
    expect(ids).toEqual([]);
  });
});

describe('#1103 coupon_redemptions: PostgREST から直接は書けない (書き込みは apply_coupon RPC だけ)', () => {
  it.each([
    ['anon', () => anonClient()],
    ['本人', () => authedClient(alice.jwt)],
    ['super_admin', () => authedClient(superAdmin.jwt)],
  ])('R-4: %s は INSERT できない (42501)。行は増えない', async (_who, client) => {
    const marker = crypto.randomUUID();
    const { error } = await client()
      .from('coupon_redemptions')
      .insert({
        coupon_id: couponId,
        user_id: alice.userId,
        subscription_target: 'personal',
        applied_to_subscription_id: marker,
        discount_amount_jpy: 0,
      });
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowOf('coupon_redemptions', 'applied_to_subscription_id', marker)).toBeNull();
  });

  it.each([
    ['本人', () => alice],
    ['super_admin', () => superAdmin],
  ])('R-5: %s は UPDATE / DELETE できない (0 行。割引額も行も変わらない)', async (_who, who) => {
    const client = authedClient(who().jwt);
    const updated = await client.from('coupon_redemptions').update({ discount_amount_jpy: 0 }).eq('id', aliceRedemptionId).select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([]);
    const deleted = await client.from('coupon_redemptions').delete().eq('id', aliceRedemptionId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([]);
    expect(await rowOf('coupon_redemptions', 'id', aliceRedemptionId)).toMatchObject({ discount_amount_jpy: DISCOUNT_JPY });
  });
});

// ================================================================
// experiment_assignments (#1103 項目 3)
// ================================================================
describe('#1103 experiment_assignments: 本人は自分の割り当てを読めず、選べず、書き換えられない', () => {
  it('E-1: 本人も自分の割り当てを読めない (super_admin 以外には見えない)', async () => {
    const ids = await idsVisibleTo(authedClient(alice.jwt), 'experiment_assignments', 'user_id', [alice.userId, bob.userId]);
    expect(ids).toEqual([]);
  });

  it('E-2: admin も読めない (super_admin だけ)', async () => {
    const ids = await idsVisibleTo(authedClient(admin.jwt), 'experiment_assignments', 'user_id', [alice.userId, bob.userId]);
    expect(ids).toEqual([]);
  });

  it('E-3: super_admin は全員の割り当てを読める', async () => {
    const ids = await idsVisibleTo(authedClient(superAdmin.jwt), 'experiment_assignments', 'user_id', [alice.userId, bob.userId]);
    expect(ids).toEqual([alice.userId, bob.userId].sort());
  });

  it.each([
    ['anon', () => anonClient()],
    ['本人', () => authedClient(alice.jwt)],
    ['super_admin', () => authedClient(superAdmin.jwt)],
  ])('E-4: %s は INSERT できない (42501)。割り当ては service_role の割り当て処理だけが作る', async (_who, client) => {
    const { error } = await client()
      .from('experiment_assignments')
      .insert({ experiment_id: experimentId, user_id: finance.userId, variant_key: VARIANT_TREATMENT });
    expect(error?.code).toBe(RLS_DENIED);
    const { data } = await srAdmin.from('experiment_assignments').select('user_id').eq('experiment_id', experimentId).eq('user_id', finance.userId);
    expect(data).toEqual([]);
  });

  it('E-5: 本人は自分の variant を UPDATE で書き換えられず、DELETE で引き直すこともできない', async () => {
    const client = authedClient(alice.jwt);
    const updated = await client
      .from('experiment_assignments')
      .update({ variant_key: VARIANT_TREATMENT })
      .eq('experiment_id', experimentId)
      .eq('user_id', alice.userId)
      .select('user_id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([]);
    const deleted = await client
      .from('experiment_assignments')
      .delete()
      .eq('experiment_id', experimentId)
      .eq('user_id', alice.userId)
      .select('user_id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([]);

    const { data } = await srAdmin
      .from('experiment_assignments')
      .select('variant_key')
      .eq('experiment_id', experimentId)
      .eq('user_id', alice.userId);
    expect(data).toEqual([{ variant_key: VARIANT_CONTROL }]);
  });

  it('E-6: super_admin も UPDATE はできない (0 行)。DELETE はできる', async () => {
    const client = authedClient(superAdmin.jwt);
    const updated = await client
      .from('experiment_assignments')
      .update({ variant_key: VARIANT_TREATMENT })
      .eq('experiment_id', experimentId)
      .eq('user_id', bob.userId)
      .select('user_id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([]);

    const deleted = await client
      .from('experiment_assignments')
      .delete()
      .eq('experiment_id', experimentId)
      .eq('user_id', bob.userId)
      .select('user_id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ user_id: bob.userId }]);
  });
});

// ================================================================
// recipe_flags (#1103 項目 4)
// ================================================================
describe('#1103 recipe_flags: 通報は本人として作り、読めるのは本人と admin / super_admin', () => {
  it('F-1: ログインユーザーは reporter_id = 自分 で通報できる', async () => {
    const { data, error } = await authedClient(alice.jwt)
      .from('recipe_flags')
      .insert({ reporter_id: alice.userId, reason: 'alice-self' })
      .select('id, reporter_id, status');
    expect(error).toBeNull();
    expect(data).toEqual([expect.objectContaining({ reporter_id: alice.userId, status: 'pending' })]);
  });

  it('F-2: 他人を reporter にした通報は作れない (42501)', async () => {
    const { error } = await authedClient(alice.jwt).from('recipe_flags').insert({ reporter_id: bob.userId, reason: 'spoof' });
    expect(error?.code).toBe(RLS_DENIED);
    const { data } = await srAdmin.from('recipe_flags').select('id').eq('reason', 'spoof');
    expect(data).toEqual([]);
  });

  it('F-3: anon は通報できない (42501)', async () => {
    const { error } = await anonClient().from('recipe_flags').insert({ reporter_id: alice.userId, reason: 'anon' });
    expect(error?.code).toBe(RLS_DENIED);
  });

  it('F-4: 本人は自分の通報だけ読める (他人の通報は見えない)', async () => {
    const ids = await idsVisibleTo(authedClient(bob.jwt), 'recipe_flags', 'id', [aliceFlagId, bobFlagId]);
    expect(ids).toEqual([bobFlagId]);
  });

  it.each([
    ['admin', () => admin],
    ['super_admin', () => superAdmin],
  ])('F-5: %s は全員の通報を読める', async (_role, who) => {
    const ids = await idsVisibleTo(authedClient(who().jwt), 'recipe_flags', 'id', [aliceFlagId, bobFlagId]);
    expect(ids).toEqual([aliceFlagId, bobFlagId].sort());
  });

  it('F-6: finance は読めない (通報を扱うのは admin / super_admin)', async () => {
    const ids = await idsVisibleTo(authedClient(finance.jwt), 'recipe_flags', 'id', [aliceFlagId, bobFlagId]);
    expect(ids).toEqual([]);
  });

  it('F-7: 通報した本人は自分の通報の status を書き換えられず、消すこともできない', async () => {
    const client = authedClient(alice.jwt);
    const updated = await client.from('recipe_flags').update({ status: 'dismissed' }).eq('id', aliceFlagId).select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([]);
    const deleted = await client.from('recipe_flags').delete().eq('id', aliceFlagId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([]);
    expect(await rowOf('recipe_flags', 'id', aliceFlagId)).toMatchObject({ status: 'pending' });
  });

  it('F-8: admin は status を更新できるが、DELETE のポリシーは無いので消せない', async () => {
    const client = authedClient(admin.jwt);
    const updated = await client
      .from('recipe_flags')
      .update({ status: 'reviewed', reviewed_by: admin.userId })
      .eq('id', bobFlagId)
      .select('id, status');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ id: bobFlagId, status: 'reviewed' }]);

    const deleted = await client.from('recipe_flags').delete().eq('id', bobFlagId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([]);
    expect(await rowOf('recipe_flags', 'id', bobFlagId)).toMatchObject({ status: 'reviewed' });
  });
});
