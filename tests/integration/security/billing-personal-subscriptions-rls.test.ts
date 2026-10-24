/**
 * billing/01 (課金の核) 段 A: 契約の行 (personal_subscriptions) と顧客の対応表 (billing_customers) の権限、
 * plan_key_cached の特権列ガードの結合テスト (設計: docs/design/billing/01-billing-core.md §6.2・§6.3・§6.4 (11)・§14.2 の 67〜70・88)
 *
 * 修正前の穴 (§2.2 F6・F21): 利用者本人が PostgREST から自分の契約の行 (status / plan_key / stripe_*) と
 * user_profiles.plan_key_cached を書けた。migration *_billing_core.sql が本人の INSERT / UPDATE のポリシーを外し、
 * 特権列ガードに plan_key_cached を足した。
 *
 * 確認すること:
 *   67. 本人は自分の契約の行を INSERT / UPDATE できない (RLS と権限) が、SELECT はできる
 *   68. admin も契約の行を直接 INSERT / UPDATE / DELETE できない (42501)。anon と authenticated には INSERT / UPDATE / DELETE の権限が無い
 *       (migration 20261024110000_announcements_moderation_flags_select_only.sql が運営の INSERT / UPDATE のポリシー
 *       personal_subscriptions_insert_admin / _update_admin と authenticated の書き込みの権限を外した。#1917 の続き。
 *       契約を書くのは、サーバーが service_role で呼ぶ SECURITY DEFINER の関数 (写像・手動付与・クーポンの適用) だけ)
 *   69. billing_customers は anon / authenticated から見えず書けない。service_role は読み書きできる
 *   70. personal_subscriptions の UPDATE で updated_at が進む
 *   88. 本人は user_profiles.plan_key_cached を UPDATE でも INSERT でも変えられない (CANNOT_MODIFY_PRIVILEGED_COLUMN)。service_role は書ける
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/billing-personal-subscriptions-rls.test.ts
 * 権限の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で行う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
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

/** ローカルスタックの postgres-meta で読み取りの SQL を実行する (権限の確認だけ) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const RUN = `${TS}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
let userSeq = 0;
const CUSTOMER_PREFIX = `cus_it_rls_${RUN}_`;
/** updated_at の比較のために、2 つの UPDATE の間を空ける時間 (ミリ秒)。now() はトランザクションの開始時刻なので、別のリクエストなら進む */
const UPDATED_AT_GAP_MS = 20;

const base = { nickname: 'billing-rls', age_group: 'unspecified', gender: 'unspecified' };

async function createAuthUser(label: string): Promise<TestUser> {
  userSeq += 1;
  const email = `rls-billing-${label}-${userSeq}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** プロフィールつきのユーザー (roles は service_role で入れる) */
async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const user = await createAuthUser(label);
  const { error } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: user.id, ...base, ...(roles ? { roles } : {}) }, { onConflict: 'id' }));
  if (error) throw new Error(`profile ${label}: ${error.message}`);
  return user;
}

async function insertSubscription(userId: string, status: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .insert({ user_id: userId, plan_key: 'pro', status })
    .select('id')
    .single();
  if (error || !data) throw new Error(`personal_subscriptions insert: ${error?.message}`);
  return (data as { id: string }).id;
}

async function subscriptionRow(id: string): Promise<{ status: string; plan_key: string; updated_at: string } | null> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .select('status, plan_key, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`personal_subscriptions: ${error.message}`);
  return data as { status: string; plan_key: string; updated_at: string } | null;
}

let owner: TestUser;
let admin: TestUser;

beforeAll(async () => {
  [owner, admin] = await Promise.all([createUser('owner'), createUser('admin', ['user', 'admin'])]);
}, 60_000);

afterAll(async () => {
  await srAdmin.from('billing_customers').delete().like('stripe_customer_id', `${CUSTOMER_PREFIX}%`);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles・personal_subscriptions は CASCADE
  }
}, 60_000);

describe('billing/01 §6.2: personal_subscriptions の RLS', () => {
  it('authenticated user cannot INSERT or UPDATE own personal_subscriptions row (RLS) but can SELECT it', async () => {
    const id = await insertSubscription(owner.id, 'expired');

    // INSERT: 本人の行でも拒否 (WITH CHECK の本人の枝を外した)
    const { error: insertError } = await asUser(owner.jwt)
      .from('personal_subscriptions')
      .insert({ user_id: owner.id, plan_key: 'family_pro', status: 'active' });
    expect(insertError?.code).toBe('42501');
    const { count } = await srAdmin
      .from('personal_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', owner.id);
    expect(count).toBe(1);

    // UPDATE: authenticated に UPDATE の権限が無い (20261024110000 で外した) ので 42501。値は変わらない
    // (権限を外す前は、本人の行は USING に当たらず 0 行で黙って終わっていた)
    const { error: updateError } = await asUser(owner.jwt)
      .from('personal_subscriptions')
      .update({ status: 'active', plan_key: 'family_pro' })
      .eq('id', id);
    expect(updateError?.code).toBe('42501');
    expect(await subscriptionRow(id)).toMatchObject({ status: 'expired', plan_key: 'pro' });

    // SELECT: 本人の行は読める
    const { data: own, error: selectError } = await asUser(owner.jwt).from('personal_subscriptions').select('id').eq('id', id);
    expect(selectError).toBeNull();
    expect(own).toEqual([{ id }]);
  });

  it('admin cannot INSERT/UPDATE/DELETE directly (42501); anon and authenticated have no INSERT/UPDATE/DELETE privilege', async () => {
    // 運営の直接の書き込みは、監査 (admin.billing.manual_grant) も手動付与の関数の不変条件 (live な行の衝突・plan_key_cached と
    // family_groups の同期) も通らないので塞いだ (20261024110000。#1917 の続き)。admin は TOTP を登録していない (MFA の判定は真) ので、
    // 修正前はこのセッションで書けた
    const target = await createUser('admin-target');
    const id = await insertSubscription(target.id, 'expired');
    const { error: insertError } = await asUser(admin.jwt)
      .from('personal_subscriptions')
      .insert({ user_id: target.id, plan_key: 'pro', status: 'active' });
    expect(insertError?.code).toBe('42501');
    const { error: updateError } = await asUser(admin.jwt)
      .from('personal_subscriptions')
      .update({ status: 'active', notes: 'admin note' })
      .eq('id', id);
    expect(updateError?.code).toBe('42501');
    const { error: deleteError } = await asUser(admin.jwt).from('personal_subscriptions').delete().eq('id', id);
    expect(deleteError?.code).toBe('42501');
    // 行は service_role で作った 1 行のまま (増えていない・書き換わっていない・消えていない)
    const { data: rows } = await srAdmin.from('personal_subscriptions').select('id, status, notes').eq('user_id', target.id);
    expect(rows).toEqual([{ id, status: 'expired', notes: null }]);

    const privileges = await pgQuery<{ role: string; privilege: string; granted: boolean }>(`
      SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.personal_subscriptions', p) AS granted
        FROM unnest(ARRAY['anon', 'authenticated']) AS r,
             unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p
       ORDER BY r, p`);
    expect(privileges).toEqual([
      { role: 'anon', privilege: 'DELETE', granted: false },
      { role: 'anon', privilege: 'INSERT', granted: false },
      { role: 'anon', privilege: 'UPDATE', granted: false },
      { role: 'authenticated', privilege: 'DELETE', granted: false },
      { role: 'authenticated', privilege: 'INSERT', granted: false },
      { role: 'authenticated', privilege: 'UPDATE', granted: false },
    ]);
    const { error: anonInsert } = await anon()
      .from('personal_subscriptions')
      .insert({ user_id: target.id, plan_key: 'pro', status: 'active' });
    expect(anonInsert?.code).toBe('42501');
  });

  it('updated_at advances on UPDATE of personal_subscriptions', async () => {
    const user = await createUser('updated-at');
    const id = await insertSubscription(user.id, 'expired');
    const before = (await subscriptionRow(id))!.updated_at;
    await new Promise((resolve) => setTimeout(resolve, UPDATED_AT_GAP_MS));
    const { error } = await srAdmin.from('personal_subscriptions').update({ notes: 'touched' }).eq('id', id);
    expect(error).toBeNull();
    const after = (await subscriptionRow(id))!.updated_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});

describe('billing/01 §6.3: billing_customers', () => {
  it('billing_customers is invisible to anon/authenticated and readable/writable by service_role', async () => {
    const customerId = `${CUSTOMER_PREFIX}1`;
    const { error: insertError } = await srAdmin.from('billing_customers').insert({ stripe_customer_id: customerId, user_id: owner.id });
    expect(insertError).toBeNull();
    const { data: read, error: readError } = await srAdmin
      .from('billing_customers')
      .select('stripe_customer_id, user_id, anonymized_at')
      .eq('stripe_customer_id', customerId);
    expect(readError).toBeNull();
    expect(read).toEqual([{ stripe_customer_id: customerId, user_id: owner.id, anonymized_at: null }]);
    const { error: updateError } = await srAdmin
      .from('billing_customers')
      .update({ anonymized_at: new Date().toISOString() })
      .eq('stripe_customer_id', customerId);
    expect(updateError).toBeNull();

    // 本人 (user_id が自分の行) でも読めない・書けない (表の権限が無い)
    for (const [who, c] of [
      ['authenticated', asUser(owner.jwt)],
      ['anon', anon()],
    ] as const) {
      const { data, error } = await c.from('billing_customers').select('stripe_customer_id').eq('stripe_customer_id', customerId);
      expect(error?.code, who).toBe('42501');
      expect(data, who).toBeNull();
      const { error: writeError } = await c
        .from('billing_customers')
        .insert({ stripe_customer_id: `${CUSTOMER_PREFIX}${who}`, user_id: owner.id });
      expect(writeError?.code, who).toBe('42501');
    }

    const privileges = await pgQuery<{ role: string; privilege: string; granted: boolean }>(`
      SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.billing_customers', p) AS granted
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r,
             unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p
       ORDER BY r, p`);
    for (const row of privileges) {
      expect(row.granted, `${row.role} ${row.privilege}`).toBe(row.role === 'service_role');
    }
    const rls = await pgQuery<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.billing_customers'::regclass`,
    );
    expect(rls).toEqual([{ relrowsecurity: true }]);
  });
});

describe('billing/01 §6.4 (11): plan_key_cached の特権列ガード', () => {
  it('authenticated user cannot change own user_profiles.plan_key_cached by UPDATE nor set it on INSERT (CANNOT_MODIFY_PRIVILEGED_COLUMN), while service_role can', async () => {
    const user = await createUser('cached');
    const { error: updateError } = await asUser(user.jwt)
      .from('user_profiles')
      .update({ plan_key_cached: 'family_pro' })
      .eq('id', user.id);
    expect(updateError?.code).toBe('42501');
    expect(updateError?.message).toContain('CANNOT_MODIFY_PRIVILEGED_COLUMN');

    // 本人が自分の行を作るときも入れられない (プロフィールの行をまだ持っていない利用者)
    const fresh = await createAuthUser('cached-insert');
    const { error: insertError } = await asUser(fresh.jwt)
      .from('user_profiles')
      .insert({ id: fresh.id, ...base, plan_key_cached: 'family_pro' });
    expect(insertError?.code).toBe('42501');
    expect(insertError?.message).toContain('CANNOT_MODIFY_PRIVILEGED_COLUMN');
    const { data: notCreated } = await srAdmin.from('user_profiles').select('id').eq('id', fresh.id);
    expect(notCreated).toEqual([]);

    // ほかの列の本人の更新は通る (ガードは plan_key_cached を変えたときだけ)
    const { error: nicknameError } = await asUser(user.jwt).from('user_profiles').update({ nickname: 'renamed' }).eq('id', user.id);
    expect(nicknameError).toBeNull();

    // service_role は書ける (写像の関数と同じく、ガードに当たらない)
    const { error: serviceError } = await srAdmin.from('user_profiles').update({ plan_key_cached: 'pro' }).eq('id', user.id);
    expect(serviceError).toBeNull();
    const { data: cached } = await srAdmin.from('user_profiles').select('plan_key_cached').eq('id', user.id).single();
    expect(cached).toEqual({ plan_key_cached: 'pro' });
  });
});
