/**
 * billing/03 (有料プランの販売) 段 A: ストアの商品の対応表 plan_store_products の RLS・権限・制約の結合テスト
 * (設計: docs/design/billing/03-paid-plans-and-iap.md §6.3・§14.2 の 80・114)
 *
 *   80. anon と authenticated は、公開のプラン (subscription_plans.status が public / private) の商品だけを読める (下書きのプランの商品は
 *       読めない)。書けるのは super_admin と service_role だけ (super_admin の項に operator_mfa_satisfied() を付けた形は、
 *       tests/integration/security/operator-mfa-db-gate.test.ts の DB-1 と migration の契約テスト 61 が見る)
 *  114. 同じプラン・ストア・間隔に、売る行 (offered = true) は 1 つだけ (idx_plan_store_products_offered)。売らない行 (offered = false) は
 *       並べて持てる。同じ (store, product_id) を 2 つのプランに結び付けられない (主キー)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/plan-store-products-rls.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { signInForIntegration } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ローカルスタックの Kong -> PostgREST は、使い回した最初の 1 回が 502 になることがある。データベースの結果ではないので数回やり直す */
const GATEWAY_RETRIES = 3;
/** 502 のやり直しの間隔 (ミリ秒。回数ごとに伸ばす) */
const GATEWAY_RETRY_BASE_MS = 150;
const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 502 || attempt >= GATEWAY_RETRIES) return res;
    await sleep(GATEWAY_RETRY_BASE_MS * (attempt + 1));
  }
};

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: {
      fetch: fetchRetryingGateway502,
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

const TS = Date.now();
const RUN = `${TS}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
/** このファイルが作る商品 ID の頭 (後片付けで消す) */
const PRODUCT_PREFIX = `it.psp.${RUN}.`;
/** 下書きのプラン (公開されていないプランの商品は読めないことを見る) */
const DRAFT_PLAN_KEY = `it_psp_draft_${RUN}`;
/** RLS で断られたとき・権限が無いときの PostgreSQL のエラーコード */
const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';

const createdUserIds: string[] = [];
let seq = 0;
const nextProduct = (label: string) => `${PRODUCT_PREFIX}${label}.${++seq}`;

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

/** 利用者を作り、roles を入れてからサインインする (必須ロールなら aal2) */
async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `sec-psp-${label}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `psp-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  return { id: data.user.id, email, jwt: await signInForIntegration({ email, password: PASSWORD, roles }) };
}

interface ProductRow {
  store: string;
  product_id: string;
  plan_key: string;
  billing_interval: string;
  offered: boolean;
}

async function insertAsService(row: ProductRow): Promise<void> {
  const { error } = await srAdmin.from('plan_store_products').insert(row);
  if (error) throw new Error(`plan_store_products (service_role): ${error.message}`);
}

let superAdmin: TestUser;
let ordinary: TestUser;

beforeAll(async () => {
  [superAdmin, ordinary] = await Promise.all([
    createUser('super', ['user', 'super_admin']),
    createUser('ordinary', ['user']),
  ]);
  const { error } = await srAdmin
    .from('subscription_plans')
    .insert({ plan_key: DRAFT_PLAN_KEY, display_name: `psp draft ${RUN}`, plan_type: 'personal', status: 'draft', monthly_price_jpy: 0 });
  if (error) throw new Error(`subscription_plans draft: ${error.message}`);
}, 120_000);

afterAll(async () => {
  await srAdmin.from('plan_store_products').delete().like('product_id', `${PRODUCT_PREFIX}%`);
  await srAdmin.from('subscription_plans').delete().eq('plan_key', DRAFT_PLAN_KEY);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 120_000);

describe('billing/03 §6.3: plan_store_products の RLS と権限', () => {
  // 80
  it('anon and authenticated can read public plan products, only super_admin can write, service_role can write', async () => {
    const publicProduct = nextProduct('pro-month');
    const draftProduct = nextProduct('draft-month');
    await insertAsService({ store: 'app_store', product_id: publicProduct, plan_key: 'pro', billing_interval: 'month', offered: true });
    await insertAsService({ store: 'app_store', product_id: draftProduct, plan_key: DRAFT_PLAN_KEY, billing_interval: 'month', offered: true });

    // 読む: 公開のプランの商品だけ
    for (const [label, db] of [
      ['anon', anon()],
      ['authenticated', asUser(ordinary.jwt)],
    ] as const) {
      const { data, error } = await db.from('plan_store_products').select('product_id, plan_key, offered').like('product_id', `${PRODUCT_PREFIX}%`);
      expect(error, label).toBeNull();
      expect(data, label).toEqual([{ product_id: publicProduct, plan_key: 'pro', offered: true }]);
    }

    // 書けない: anon (権限なし)・ふつうの利用者 (RLS)
    for (const [label, db] of [
      ['anon', anon()],
      ['authenticated', asUser(ordinary.jwt)],
    ] as const) {
      const product = nextProduct(`refused-${label.replace(/\W+/g, '-')}`);
      const inserted = await db.from('plan_store_products').insert({ store: 'play_store', product_id: product, plan_key: 'pro', billing_interval: 'year', offered: false });
      expect(inserted.error?.code, `${label}: insert`).toBe(INSUFFICIENT_PRIVILEGE);
      const updated = await db.from('plan_store_products').update({ offered: false }).eq('product_id', publicProduct).select('product_id');
      // UPDATE / DELETE は、anon は権限で 42501、authenticated は RLS で 0 行 (エラーにならない)
      if (label === 'anon') expect(updated.error?.code, `${label}: update`).toBe(INSUFFICIENT_PRIVILEGE);
      else expect(updated.data ?? [], `${label}: update`).toEqual([]);
      const deleted = await db.from('plan_store_products').delete().eq('product_id', publicProduct).select('product_id');
      if (label === 'anon') expect(deleted.error?.code, `${label}: delete`).toBe(INSUFFICIENT_PRIVILEGE);
      else expect(deleted.data ?? [], `${label}: delete`).toEqual([]);
    }
    const { data: unchanged } = await srAdmin.from('plan_store_products').select('offered').eq('product_id', publicProduct).single();
    expect(unchanged).toEqual({ offered: true });

    // 書ける: super_admin
    const adminProduct = nextProduct('admin-year');
    const db = asUser(superAdmin.jwt);
    expect((await db.from('plan_store_products').insert({ store: 'play_store', product_id: adminProduct, plan_key: 'pro', billing_interval: 'year', offered: true })).error).toBeNull();
    const updated = await db.from('plan_store_products').update({ offered: false }).eq('product_id', adminProduct).select('offered');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ offered: false }]);
    const deleted = await db.from('plan_store_products').delete().eq('product_id', adminProduct).select('product_id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ product_id: adminProduct }]);

    // service_role も書ける (UPDATE で updated_at が進む)
    const { data: before } = await srAdmin.from('plan_store_products').select('updated_at').eq('product_id', publicProduct).single();
    const serviceUpdate = await srAdmin.from('plan_store_products').update({ offered: false }).eq('product_id', publicProduct).select('offered, updated_at');
    expect(serviceUpdate.error).toBeNull();
    expect(serviceUpdate.data?.[0]?.offered).toBe(false);
    expect(new Date((serviceUpdate.data?.[0] as { updated_at: string }).updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date((before as { updated_at: string }).updated_at).getTime(),
    );
  });

  // 114
  it('plan_store_products accepts an offered = false row for the same plan, store and interval as the offered row, rejects a second offered row (idx_plan_store_products_offered) and rejects the same (store, product_id) for two plans', async () => {
    const offered = nextProduct('family-basic-month');
    await insertAsService({ store: 'app_store', product_id: offered, plan_key: 'family_basic', billing_interval: 'month', offered: true });
    // 古い商品 (売らない) は同じプラン・ストア・間隔に並べて持てる
    const legacy = nextProduct('family-basic-month-legacy');
    expect(
      (await srAdmin.from('plan_store_products').insert({ store: 'app_store', product_id: legacy, plan_key: 'family_basic', billing_interval: 'month', offered: false })).error,
    ).toBeNull();
    // 売る行は 1 つだけ
    const second = await srAdmin
      .from('plan_store_products')
      .insert({ store: 'app_store', product_id: nextProduct('family-basic-month-second'), plan_key: 'family_basic', billing_interval: 'month', offered: true });
    expect(second.error?.code).toBe(UNIQUE_VIOLATION);
    expect(second.error?.message).toContain('idx_plan_store_products_offered');
    // 別のストア・別の間隔なら売る行を持てる
    expect(
      (await srAdmin.from('plan_store_products').insert({ store: 'play_store', product_id: nextProduct('family-basic-month-play'), plan_key: 'family_basic', billing_interval: 'month', offered: true })).error,
    ).toBeNull();
    // 同じ (store, product_id) は 1 つのプランだけ
    const samePair = await srAdmin
      .from('plan_store_products')
      .insert({ store: 'app_store', product_id: offered, plan_key: 'family_pro', billing_interval: 'month', offered: false });
    expect(samePair.error?.code).toBe(UNIQUE_VIOLATION);
    expect(samePair.error?.message).toContain('plan_store_products_pkey');
    // CHECK: ストア・間隔・空の商品 ID
    const checkViolation = '23514';
    for (const row of [
      { store: 'web', product_id: nextProduct('bad-store'), plan_key: 'pro', billing_interval: 'month', offered: false },
      { store: 'app_store', product_id: nextProduct('bad-interval'), plan_key: 'pro', billing_interval: 'week', offered: false },
      { store: 'app_store', product_id: '   ', plan_key: 'pro', billing_interval: 'month', offered: false },
    ]) {
      expect((await srAdmin.from('plan_store_products').insert(row)).error?.code, JSON.stringify(row)).toBe(checkViolation);
    }
  });
});
