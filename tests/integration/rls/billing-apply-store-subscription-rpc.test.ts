/**
 * billing/03 (有料プランの販売) 段 A: ストアの契約の写像 billing_apply_store_subscription の結合テスト
 * (設計: docs/design/billing/03-paid-plans-and-iap.md §6.4・§7.3・§13.3・§14.2 の 66〜72・83・84・86・90・109・123・124・126・137)
 *
 * 段 A のテストなので、段 B の src/lib/billing/iap-*.ts を import しない。写像に渡す p_snapshot は、関数の本体が
 * p_snapshot->>'…' で読むキー (§8.1 の StoreSubscriptionSnapshot と同じ名前) の JSON をこのファイルで組み、期待値はリテラルで書く。
 * テスト 84 だけは、Web の既存の hasUsedTrial (src/lib/billing/repository.ts の createBillingRepository。段 A の前から main にある)
 * をローカル Supabase の service_role の client で呼ぶ。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/billing-apply-store-subscription-rpc.test.ts
 * 本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { createBillingRepository } from '@/lib/billing/repository';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ローカルスタックの Kong → PostgREST は、使い回した最初の 1 回が 502 になることがある。データベースの結果ではないので数回やり直す */
const GATEWAY_RETRIES = 3;
/** 502 のやり直しの間隔の単位 (ミリ秒。n 回目は n 倍) */
const GATEWAY_RETRY_UNIT_MS = 150;
const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 502 || attempt >= GATEWAY_RETRIES) return res;
    await sleep(GATEWAY_RETRY_UNIT_MS * (attempt + 1));
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

// ---------------------------------------------------------------------------------------------
// 利用者・識別子・時刻
// ---------------------------------------------------------------------------------------------

interface TestUser {
  id: string;
  email: string;
  /** JWT が要るテスト (create_family_group) だけサインインする */
  jwt: string | null;
}

const TS = Date.now();
const RUN = `${TS}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const SUB_PREFIX = `sub_it_iap_${RUN}_`;
const CUSTOMER_PREFIX = `cus_it_iap_${RUN}_`;
const createdUserIds: string[] = [];
let seq = 0;

/** ストアの商品 ID (テストの値。写像は plan_store_products を読まず、snapshot の plan_key を使う) */
const PRODUCT = {
  proMonth: `it.iap.${RUN}.pro.month`,
  proYear: `it.iap.${RUN}.pro.year`,
  familyBasicMonth: `it.iap.${RUN}.family_basic.month`,
  familyProMonth: `it.iap.${RUN}.family_pro.month`,
} as const;

/** RevenueCat から取り直した時刻 (p_fetched_at)。呼ぶたびに進む */
const FETCHED_AT_BASE_MS = TS - 60 * 60 * 1000;
const FETCHED_AT_STEP_MS = 1000;
let fetchedSeq = 0;
const nextFetchedAt = () => new Date(FETCHED_AT_BASE_MS + ++fetchedSeq * FETCHED_AT_STEP_MS).toISOString();

const DAY_MS = 24 * 60 * 60 * 1000;
/** 期間の日数 (月額の 1 か月・無料体験の 7 日・年額の 1 年。値は写像の入力) */
const MONTH_DAYS = 30;
const TRIAL_DAYS = 7;
const YEAR_DAYS = 365;
/** 期限を過ぎた契約の、期限から今までの日数 */
const PAST_DAYS = 2;
const iso = (offsetDays: number) => new Date(TS + offsetDays * DAY_MS).toISOString();
const ms = (value: string | null) => (value === null ? null : new Date(value).getTime());

/** family_groups.member_limit の DDL の既定値 (契約の無いグループ・family_basic の人数) と family_pro の人数 (subscription_plans.max_members) */
const DEFAULT_MEMBER_LIMIT = 4;
const FAMILY_PRO_MEMBER_LIMIT = 8;

const profileBase = { age_group: '30s', gender: 'other' };

async function createUser(label: string, options: { jwt?: boolean } = {}): Promise<TestUser> {
  const email = `rls-billing-iap-${label}-${++seq}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `iap-${label}`, ...profileBase }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  if (!options.jwt) return { id: data.user.id, email, jwt: null };
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

// ---------------------------------------------------------------------------------------------
// ストアの写像 (billing_apply_store_subscription)
// ---------------------------------------------------------------------------------------------

type StoreStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';

interface StoreInput {
  userId: string;
  productId: string;
  planKey: string | null;
  /** 写像が受ける 5 値。BILL_UNKNOWN_IAP_STATUS を見るときだけ、ほかの文字列を渡す */
  status: StoreStatus | string;
  store?: 'app_store' | 'play_store';
  billingInterval?: 'month' | 'year' | null;
  purchaseDate?: string;
  originalPurchaseDate?: string | null;
  expiresDate?: string | null;
  cancelAtPeriodEnd?: boolean;
  refundedAt?: string | null;
  isSandbox?: boolean;
}

/** 写像の p_snapshot (関数の本体が ->> で読むキー。§8.1 の StoreSubscriptionSnapshot) */
function storeSnapshot(input: StoreInput): Record<string, unknown> {
  return {
    user_id: input.userId,
    iap_store: input.store ?? 'app_store',
    iap_product_id: input.productId,
    plan_key: input.planKey,
    billing_interval: input.billingInterval === undefined ? 'month' : input.billingInterval,
    iap_status: input.status,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    purchase_date: input.purchaseDate ?? iso(0),
    original_purchase_date: input.originalPurchaseDate === undefined ? iso(0) : input.originalPurchaseDate,
    expires_date: input.expiresDate === undefined ? iso(MONTH_DAYS) : input.expiresDate,
    refunded_at: input.refundedAt ?? null,
    is_sandbox: input.isSandbox ?? false,
  };
}

interface RpcError {
  message: string;
  code: string;
  details: string | null;
}

interface StoreApplyResult {
  applied: boolean;
  skipped?: 'stale' | 'user_deleted';
  subscription_id?: string;
  user_id?: string;
  status_from?: string | null;
  status_to?: string;
  plan_key?: string;
}

const toRpcError = (error: { message: string; code: string; details?: string | null } | null): RpcError | null =>
  error ? { message: error.message, code: error.code, details: error.details ?? null } : null;

async function tryApplyStore(
  input: StoreInput,
  fetchedAt: string = nextFetchedAt(),
  source = 'revenuecat:evt_it_iap',
): Promise<{ data: StoreApplyResult | null; error: RpcError | null }> {
  const { data, error } = await srAdmin.rpc('billing_apply_store_subscription', {
    p_snapshot: storeSnapshot(input),
    p_fetched_at: fetchedAt,
    p_source: source,
  });
  return { data: (data as StoreApplyResult | null) ?? null, error: toRpcError(error) };
}

async function applyStore(input: StoreInput, fetchedAt: string = nextFetchedAt(), source?: string): Promise<StoreApplyResult> {
  const { data, error } = await tryApplyStore(input, fetchedAt, source);
  if (error || !data) throw new Error(`billing_apply_store_subscription: ${JSON.stringify(error)}`);
  return data;
}

// ---------------------------------------------------------------------------------------------
// Stripe の写像と手動付与 (二重購読の防止を見るために、別の出どころの live な行を作る)
// ---------------------------------------------------------------------------------------------

function stripeSnapshot(userId: string, planKey: string, status: 'active' | 'canceled'): Record<string, unknown> {
  return {
    stripe_subscription_id: `${SUB_PREFIX}${++seq}`,
    stripe_customer_id: `${CUSTOMER_PREFIX}${++seq}`,
    user_id: userId,
    plan_key: planKey,
    stripe_status: status,
    pause_collection: false,
    stripe_price_id: 'price_it_iap_monthly',
    billing_interval: 'month',
    start_date: iso(0),
    current_period_start: iso(0),
    current_period_end: iso(MONTH_DAYS),
    trial_start: null,
    trial_end: null,
    cancel_at: null,
    cancel_at_period_end: false,
    ended_at: status === 'canceled' ? iso(0) : null,
    canceled_at: status === 'canceled' ? iso(0) : null,
  };
}

async function tryApplyStripe(userId: string, planKey: string): Promise<{ data: unknown; error: RpcError | null }> {
  const { data, error } = await srAdmin.rpc('billing_apply_stripe_subscription', {
    p_snapshot: stripeSnapshot(userId, planKey, 'active'),
    p_fetched_at: nextFetchedAt(),
    p_source: 'webhook:evt_it_iap',
  });
  return { data, error: toRpcError(error) };
}

async function grantManual(userId: string, planKey: string): Promise<void> {
  const { error } = await srAdmin.rpc('billing_grant_manual_subscription', { p_user_id: userId, p_plan_key: planKey, p_expires_at: null });
  if (error) throw new Error(`billing_grant_manual_subscription: ${error.message}`);
}

// ---------------------------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------------------------

interface StoreRow {
  id: string;
  user_id: string;
  plan_key: string;
  status: string;
  iap_store: string | null;
  iap_product_id: string | null;
  iap_synced_at: string | null;
  iap_is_sandbox: boolean;
  stripe_subscription_id: string | null;
  billing_interval: string | null;
  starts_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_source: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  past_due_since: string | null;
  created_at: string;
}

const STORE_COLUMNS =
  'id, user_id, plan_key, status, iap_store, iap_product_id, iap_synced_at, iap_is_sandbox, stripe_subscription_id, billing_interval, starts_at, current_period_start, current_period_end, trial_started_at, trial_ends_at, trial_source, cancel_at, cancel_at_period_end, cancelled_at, past_due_since, created_at';

async function rowsOf(userId: string): Promise<StoreRow[]> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .select(STORE_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`personal_subscriptions: ${error.message}`);
  return (data ?? []) as StoreRow[];
}

async function storeRowOf(userId: string, productId: string): Promise<StoreRow> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .select(STORE_COLUMNS)
    .eq('user_id', userId)
    .eq('iap_product_id', productId)
    .single();
  if (error || !data) throw new Error(`ストアの行が無い: ${productId} ${error?.message}`);
  return data as StoreRow;
}

async function planKeyCached(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('plan_key_cached').eq('id', userId).single();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return (data as { plan_key_cached: string | null }).plan_key_cached;
}

interface AuditRow {
  action_type: string;
  actor_id: string | null;
  target_id: string | null;
  target_type: string | null;
  severity: string;
  details: Record<string, unknown>;
}

async function billingAuditsOf(userId: string): Promise<AuditRow[]> {
  const { data, error } = await srAdmin
    .from('admin_audit_logs')
    .select('action_type, actor_id, target_id, target_type, severity, details, created_at')
    .eq('target_id', userId)
    .like('action_type', 'system.billing.%')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`admin_audit_logs: ${error.message}`);
  return (data ?? []) as AuditRow[];
}

interface FamilyRow {
  plan_key: string;
  member_limit: number;
}

/** service_role で家族のグループを直接作る (作成のトリガーが代表者の契約から plan_key を決める。契約が無ければ free / 4) */
async function insertFamily(representativeId: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .insert({ name: `billing-iap ${RUN} ${++seq}`, representative_id: representativeId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`family_groups insert: ${error?.message}`);
  return (data as { id: string }).id;
}

async function mustFamily(id: string): Promise<FamilyRow> {
  const { data, error } = await srAdmin.from('family_groups').select('plan_key, member_limit').eq('id', id).single();
  if (error || !data) throw new Error(`family_groups: ${error?.message}`);
  return data as FamilyRow;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const { data: families } = await srAdmin.from('family_groups').select('id').in('representative_id', createdUserIds);
    const familyIds = ((families ?? []) as Array<{ id: string }>).map((f) => f.id);
    if (familyIds.length > 0) {
      await srAdmin.from('membership_audit').delete().in('scope_id', familyIds);
      await srAdmin.from('family_groups').delete().in('id', familyIds);
    }
    await srAdmin.from('admin_audit_logs').delete().in('target_id', createdUserIds);
    await srAdmin.from('personal_subscriptions').delete().in('user_id', createdUserIds);
  }
  await srAdmin.from('billing_customers').delete().like('stripe_customer_id', `${CUSTOMER_PREFIX}%`);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}, 180_000);

// ---------------------------------------------------------------------------------------------
// 1. 行を作る・写しを合わせる・監査
// ---------------------------------------------------------------------------------------------

describe('billing/03 §6.4: ストアの契約の写像 billing_apply_store_subscription', () => {
  // 66
  it('inserts a trialing store row, syncs plan_key_cached and the family group, and audits subscription_created', async () => {
    const user = await createUser('insert');
    const familyId = await insertFamily(user.id);
    expect(await mustFamily(familyId)).toEqual({ plan_key: 'free', member_limit: DEFAULT_MEMBER_LIMIT });

    const fetchedAt = nextFetchedAt();
    const result = await applyStore(
      { userId: user.id, productId: PRODUCT.familyBasicMonth, planKey: 'family_basic', status: 'trialing', expiresDate: iso(TRIAL_DAYS) },
      fetchedAt,
      'revenuecat:evt_insert',
    );
    expect(result).toMatchObject({ applied: true, user_id: user.id, status_from: null, status_to: 'trialing', plan_key: 'family_basic' });

    const row = await storeRowOf(user.id, PRODUCT.familyBasicMonth);
    expect(row).toMatchObject({
      id: result.subscription_id,
      plan_key: 'family_basic',
      status: 'trialing',
      iap_store: 'app_store',
      stripe_subscription_id: null,
      billing_interval: 'month',
      trial_source: 'app_store',
      cancel_at: null,
      cancel_at_period_end: false,
      cancelled_at: null,
      past_due_since: null,
      iap_is_sandbox: false,
    });
    expect(ms(row.iap_synced_at)).toBe(ms(fetchedAt));
    expect(ms(row.current_period_end)).toBe(ms(iso(TRIAL_DAYS)));
    expect(await planKeyCached(user.id)).toBe('family_basic');
    expect(await mustFamily(familyId)).toEqual({ plan_key: 'family_basic', member_limit: DEFAULT_MEMBER_LIMIT });

    const audits = await billingAuditsOf(user.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action_type: 'system.billing.subscription_created',
      actor_id: null,
      target_id: user.id,
      target_type: 'user',
      severity: 'info',
      details: {
        iap_store: 'app_store',
        iap_product_id: PRODUCT.familyBasicMonth,
        plan_key: 'family_basic',
        from: null,
        to: 'trialing',
        source: 'revenuecat:evt_insert',
        is_sandbox: false,
      },
    });
  });

  // 67
  it('is monotonic by p_fetched_at (older fetch is stale) and idempotent for the same snapshot', async () => {
    const user = await createUser('monotonic');
    const older = nextFetchedAt();
    const newer = nextFetchedAt();
    const first = await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active' }, newer);
    expect(first).toMatchObject({ applied: true, status_to: 'active' });

    // 古い取り直し (expired) は適用しない
    const stale = await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'expired' }, older);
    expect(stale).toEqual({ applied: false, skipped: 'stale', subscription_id: first.subscription_id, user_id: user.id });
    // 同じ時刻の同じ取り直しも適用しない (iap_synced_at >= p_fetched_at)
    const same = await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active' }, newer);
    expect(same).toMatchObject({ applied: false, skipped: 'stale' });
    const row = await storeRowOf(user.id, PRODUCT.proMonth);
    expect(row.status).toBe('active');
    expect(ms(row.iap_synced_at)).toBe(ms(newer));

    // 新しい時刻で同じ姿をもう一度: 適用するが、状態は変わらず監査は増えない
    const again = await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active' });
    expect(again).toMatchObject({ applied: true, subscription_id: first.subscription_id, status_from: 'active', status_to: 'active' });
    expect(await rowsOf(user.id)).toHaveLength(1);
    expect((await billingAuditsOf(user.id)).map((a) => a.action_type)).toEqual(['system.billing.subscription_created']);
  });

  // 68
  it('raises BILL_LIVE_ROW_CONFLICT when a Stripe or manual live row exists, and the Stripe mapping raises the same when a store row is live', async () => {
    // (a) Stripe の live な行がある利用者のストアの購入
    const withStripe = await createUser('conflict-stripe');
    const stripe = await tryApplyStripe(withStripe.id, 'pro');
    expect(stripe.error).toBeNull();
    const conflictStripe = await tryApplyStore({ userId: withStripe.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active' });
    expect(conflictStripe.data).toBeNull();
    expect(conflictStripe.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT' });
    expect((await rowsOf(withStripe.id)).filter((r) => r.iap_store !== null)).toEqual([]);

    // (b) 手動付与の live な行がある利用者のストアの購入
    const withManual = await createUser('conflict-manual');
    await grantManual(withManual.id, 'pro');
    const conflictManual = await tryApplyStore({ userId: withManual.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'trialing' });
    expect(conflictManual.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT' });
    expect((await rowsOf(withManual.id)).filter((r) => r.iap_store !== null)).toEqual([]);

    // (c) ストアの live な行がある利用者の Stripe の購入 (Stripe の写像の 6. は stripe_subscription_id IS DISTINCT FROM で見る)
    const withStore = await createUser('conflict-store');
    await applyStore({ userId: withStore.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active' });
    const conflictFromStripe = await tryApplyStripe(withStore.id, 'pro');
    expect(conflictFromStripe.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT' });
    expect((await rowsOf(withStore.id)).map((r) => [r.iap_store, r.status])).toEqual([['app_store', 'active']]);

    // 終わった (live でない) 行の写しは衝突の検査をしない: 同じ利用者のストアの expired の姿は、Stripe の行があっても入る
    const historyOnly = await tryApplyStore({ userId: withStripe.id, productId: PRODUCT.proYear, planKey: 'pro', status: 'expired', expiresDate: iso(-PAST_DAYS) });
    expect(historyOnly.error).toBeNull();
    expect(historyOnly.data).toMatchObject({ applied: true, status_to: 'expired' });
  });

  // 69
  it('transitions active → expired on a past expires_date and clears plan_key_cached and the family plan', async () => {
    const user = await createUser('expire');
    const familyId = await insertFamily(user.id);
    await applyStore({ userId: user.id, productId: PRODUCT.familyProMonth, planKey: 'family_pro', status: 'active' });
    expect(await planKeyCached(user.id)).toBe('family_pro');
    expect(await mustFamily(familyId)).toEqual({ plan_key: 'family_pro', member_limit: FAMILY_PRO_MEMBER_LIMIT });

    const ended = await applyStore({
      userId: user.id,
      productId: PRODUCT.familyProMonth,
      planKey: 'family_pro',
      status: 'expired',
      purchaseDate: iso(-MONTH_DAYS - PAST_DAYS),
      expiresDate: iso(-PAST_DAYS),
    });
    expect(ended).toMatchObject({ applied: true, status_from: 'active', status_to: 'expired', plan_key: 'family_pro' });
    const row = await storeRowOf(user.id, PRODUCT.familyProMonth);
    expect(row.status).toBe('expired');
    expect(ms(row.current_period_end)).toBe(ms(iso(-PAST_DAYS)));
    expect(row.cancelled_at).toBeNull();
    expect(await planKeyCached(user.id)).toBeNull();
    expect(await mustFamily(familyId)).toEqual({ plan_key: 'free', member_limit: DEFAULT_MEMBER_LIMIT });
    expect((await billingAuditsOf(user.id)).map((a) => [a.action_type, a.details.from, a.details.to])).toEqual([
      ['system.billing.subscription_created', null, 'active'],
      ['system.billing.subscription_status_changed', 'active', 'expired'],
    ]);
  });

  // 70
  it('reuses the same (user, store, product) row on repurchase and keeps trial_started_at', async () => {
    const user = await createUser('repurchase');
    const first = await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'trialing', expiresDate: iso(TRIAL_DAYS) });
    const trialStartedAt = (await storeRowOf(user.id, PRODUCT.proMonth)).trial_started_at;
    expect(ms(trialStartedAt)).toBe(ms(iso(0)));
    await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'expired', expiresDate: iso(-PAST_DAYS) });
    expect(await planKeyCached(user.id)).toBeNull();

    // 同じ商品の買い直し: 新しい行を作らず、同じ行を active に戻す
    const repurchase = await applyStore({
      userId: user.id,
      productId: PRODUCT.proMonth,
      planKey: 'pro',
      status: 'active',
      purchaseDate: iso(1),
      expiresDate: iso(1 + MONTH_DAYS),
    });
    expect(repurchase).toMatchObject({ applied: true, subscription_id: first.subscription_id, status_from: 'expired', status_to: 'active' });
    const rows = await rowsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(ms(rows[0].trial_started_at)).toBe(ms(trialStartedAt));
    expect(ms(rows[0].current_period_start)).toBe(ms(iso(1)));
    expect(await planKeyCached(user.id)).toBe('pro');
  });

  // 71
  it('applies PRODUCT_CHANGE in order: month row expired first, then the yearly row inserted', async () => {
    const user = await createUser('product-change');
    const month = await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active' });
    // 年額の行を先に写すと、月額の live な行と衝突する (順を守らないと入らないことの確認)
    const outOfOrder = await tryApplyStore({ userId: user.id, productId: PRODUCT.proYear, planKey: 'pro', status: 'active', billingInterval: 'year' });
    expect(outOfOrder.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT' });

    // TS の selectStoreSubscriptions の順: 古い月額を先に expired で写し、それから年額
    await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'expired', expiresDate: iso(0) });
    const year = await applyStore({
      userId: user.id,
      productId: PRODUCT.proYear,
      planKey: 'pro',
      status: 'active',
      billingInterval: 'year',
      expiresDate: iso(YEAR_DAYS),
    });
    expect(year).toMatchObject({ applied: true, status_from: null, status_to: 'active', plan_key: 'pro' });
    expect(year.subscription_id).not.toBe(month.subscription_id);
    const rows = await rowsOf(user.id);
    expect(rows.map((r) => [r.iap_product_id, r.status, r.billing_interval])).toEqual([
      [PRODUCT.proMonth, 'expired', 'month'],
      [PRODUCT.proYear, 'active', 'year'],
    ]);
    expect(await planKeyCached(user.id)).toBe('pro');
  });

  // 72
  it('returns user_deleted without writing for a missing auth user', async () => {
    const missing = randomUUID();
    const result = await applyStore({ userId: missing, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active' });
    expect(result).toEqual({ applied: false, skipped: 'user_deleted' });
    const { data, error } = await srAdmin.from('personal_subscriptions').select('id').eq('user_id', missing);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // 123
  it('raises BILL_UNKNOWN_IAP_STATUS (P0001, DETAIL = the status) for a snapshot status outside the 5 values and writes no row, no plan_key_cached and no audit', async () => {
    const user = await createUser('unknown-status');
    for (const status of ['paused', 'grace', 'incomplete', 'refunded']) {
      const result = await tryApplyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status });
      expect(result.data, status).toBeNull();
      expect(result.error, status).toEqual({ code: 'P0001', message: 'BILL_UNKNOWN_IAP_STATUS', details: status });
    }
    expect(await rowsOf(user.id)).toEqual([]);
    expect(await planKeyCached(user.id)).toBeNull();
    expect(await billingAuditsOf(user.id)).toEqual([]);
  });

  // 124
  it('UNCANCELLATION: a newer snapshot without unsubscribe_detected_at sets cancel_at_period_end = false and cancel_at = NULL on a trialing or active row that had them set, keeps the status and writes no audit', async () => {
    for (const status of ['trialing', 'active'] as const) {
      const user = await createUser(`uncancel-${status}`);
      const expiresDate = iso(status === 'trialing' ? TRIAL_DAYS : MONTH_DAYS);
      await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status, expiresDate, cancelAtPeriodEnd: true });
      const scheduled = await storeRowOf(user.id, PRODUCT.proMonth);
      expect(scheduled.cancel_at_period_end, status).toBe(true);
      expect(ms(scheduled.cancel_at), status).toBe(ms(expiresDate));

      const result = await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status, expiresDate, cancelAtPeriodEnd: false });
      expect(result, status).toMatchObject({ applied: true, status_from: status, status_to: status });
      const row = await storeRowOf(user.id, PRODUCT.proMonth);
      expect(row, status).toMatchObject({ status, cancel_at_period_end: false, cancel_at: null });
      expect((await billingAuditsOf(user.id)).map((a) => a.action_type), status).toEqual(['system.billing.subscription_created']);
    }
  });

  // 126
  it('a family_pro month store row sets the representative group to family_pro / 8 and a family_basic month store row sets it to family_basic / 4', async () => {
    const proRep = await createUser('family-pro-rep');
    const proFamily = await insertFamily(proRep.id);
    await applyStore({ userId: proRep.id, productId: PRODUCT.familyProMonth, planKey: 'family_pro', status: 'active' });
    expect(await mustFamily(proFamily)).toEqual({ plan_key: 'family_pro', member_limit: FAMILY_PRO_MEMBER_LIMIT });
    expect(await planKeyCached(proRep.id)).toBe('family_pro');

    const basicRep = await createUser('family-basic-rep');
    const basicFamily = await insertFamily(basicRep.id);
    await applyStore({ userId: basicRep.id, productId: PRODUCT.familyBasicMonth, planKey: 'family_basic', status: 'active' });
    expect(await mustFamily(basicFamily)).toEqual({ plan_key: 'family_basic', member_limit: DEFAULT_MEMBER_LIMIT });
    expect(await planKeyCached(basicRep.id)).toBe('family_basic');
  });

  // 109
  it('inserts a past_due row with past_due_since and a warn subscription_created audit when the first fetch already has a billing issue, inserts cancel_at_period_end = true and cancel_at = expires_date when the first fetch already has unsubscribe_detected_at, and keeps billing_interval and iap_is_sandbox when a later snapshot has billing_interval null', async () => {
    const pastDue = await createUser('first-past-due');
    await applyStore({ userId: pastDue.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'past_due' });
    const pastDueRow = await storeRowOf(pastDue.id, PRODUCT.proMonth);
    expect(pastDueRow.status).toBe('past_due');
    expect(pastDueRow.past_due_since).not.toBeNull();
    const pastDueAudits = await billingAuditsOf(pastDue.id);
    expect(pastDueAudits.map((a) => [a.action_type, a.severity, a.details.to])).toEqual([['system.billing.subscription_created', 'warn', 'past_due']]);
    expect(await planKeyCached(pastDue.id)).toBe('pro');

    const cancelling = await createUser('first-cancel-scheduled');
    const expiresDate = iso(MONTH_DAYS);
    await applyStore({ userId: cancelling.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active', expiresDate, cancelAtPeriodEnd: true });
    const cancellingRow = await storeRowOf(cancelling.id, PRODUCT.proMonth);
    expect(cancellingRow).toMatchObject({ status: 'active', cancel_at_period_end: true });
    expect(ms(cancellingRow.cancel_at)).toBe(ms(expiresDate));

    // 後の姿に billing_interval が無い (対応の行が無い商品・取り直しに無くなった行): 間隔は既存の値、iap_is_sandbox は姿の値 (既存と同じ)
    const sandbox = await createUser('keep-interval');
    await applyStore({ userId: sandbox.id, productId: PRODUCT.proYear, planKey: 'pro', status: 'active', billingInterval: 'year', isSandbox: true });
    await applyStore({ userId: sandbox.id, productId: PRODUCT.proYear, planKey: null, status: 'expired', billingInterval: null, isSandbox: true, expiresDate: iso(-PAST_DAYS) });
    expect(await storeRowOf(sandbox.id, PRODUCT.proYear)).toMatchObject({ status: 'expired', billing_interval: 'year', iap_is_sandbox: true, plan_key: 'pro' });
  });

  // 90
  it('writes iap_is_sandbox from the snapshot (true for sandbox, false otherwise) and records is_sandbox in the audit details, with the same status and plan_key_cached as a production purchase', async () => {
    const results: Array<{ sandbox: boolean; status: string; cached: string | null; audit: unknown }> = [];
    for (const isSandbox of [true, false]) {
      const user = await createUser(`sandbox-${isSandbox}`);
      await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'active', isSandbox, store: 'play_store' });
      const row = await storeRowOf(user.id, PRODUCT.proMonth);
      const audits = await billingAuditsOf(user.id);
      results.push({ sandbox: row.iap_is_sandbox, status: row.status, cached: await planKeyCached(user.id), audit: audits[0]?.details.is_sandbox });
    }
    expect(results).toEqual([
      { sandbox: true, status: 'active', cached: 'pro', audit: true },
      { sandbox: false, status: 'active', cached: 'pro', audit: false },
    ]);
  });

  // 83
  it('writes trial_started_at / trial_ends_at / trial_source = store on a trialing store row and keeps them after the row expires', async () => {
    const user = await createUser('trial-fields');
    await applyStore({
      userId: user.id,
      productId: PRODUCT.proMonth,
      planKey: 'pro',
      status: 'trialing',
      store: 'play_store',
      expiresDate: iso(TRIAL_DAYS),
    });
    const trialing = await storeRowOf(user.id, PRODUCT.proMonth);
    expect(trialing.trial_source).toBe('play_store');
    expect(ms(trialing.trial_started_at)).toBe(ms(iso(0)));
    expect(ms(trialing.trial_ends_at)).toBe(ms(iso(TRIAL_DAYS)));

    await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'expired', store: 'play_store', expiresDate: iso(TRIAL_DAYS) });
    const expired = await storeRowOf(user.id, PRODUCT.proMonth);
    expect(expired.status).toBe('expired');
    expect(expired.trial_source).toBe('play_store');
    expect(ms(expired.trial_started_at)).toBe(ms(iso(0)));
    expect(ms(expired.trial_ends_at)).toBe(ms(iso(TRIAL_DAYS)));
  });

  // 84
  it('Web repository hasUsedTrial counts a store trial row for the same plan_key and not for another plan_key', async () => {
    const user = await createUser('has-used-trial');
    const repository = createBillingRepository(srAdmin);
    expect(await repository.hasUsedTrial(user.id, 'pro')).toBe(false);
    await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'trialing', expiresDate: iso(TRIAL_DAYS) });
    await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'expired', expiresDate: iso(TRIAL_DAYS) });
    expect(await repository.hasUsedTrial(user.id, 'pro')).toBe(true);
    expect(await repository.hasUsedTrial(user.id, 'family_basic')).toBe(false);
  });

  // 86
  it('applies PRODUCT_CHANGE from a trialing month row: month row expired with trial_started_at kept, then the yearly row inserted with the status from its own period_type', async () => {
    const user = await createUser('product-change-trial');
    await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'trialing', expiresDate: iso(TRIAL_DAYS) });
    await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'expired', expiresDate: iso(0) });
    await applyStore({ userId: user.id, productId: PRODUCT.proYear, planKey: 'pro', status: 'active', billingInterval: 'year', expiresDate: iso(YEAR_DAYS) });

    const month = await storeRowOf(user.id, PRODUCT.proMonth);
    expect(month.status).toBe('expired');
    expect(ms(month.trial_started_at)).toBe(ms(iso(0)));
    const year = await storeRowOf(user.id, PRODUCT.proYear);
    expect(year).toMatchObject({ status: 'active', billing_interval: 'year', trial_started_at: null, trial_ends_at: null, trial_source: null });
    expect(await planKeyCached(user.id)).toBe('pro');
  });

  // 137
  it('an App Store upgrade during a trial: a superseded expired snapshot ends the trialing pro row (trial_started_at kept, audit details.source ends with :superseded), then the family_pro row inserts without BILL_LIVE_ROW_CONFLICT and sets plan_key_cached to family_pro, after which create_family_group succeeds with family_pro / 8', async () => {
    const user = await createUser('upgrade-during-trial', { jwt: true });
    await applyStore({ userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'trialing', expiresDate: iso(TRIAL_DAYS) });
    expect(await planKeyCached(user.id)).toBe('pro');

    // 同じグループの上位への変更は、古い方を先に expired で写す (TS の supersededAt。source は '<event>:superseded')
    await applyStore(
      { userId: user.id, productId: PRODUCT.proMonth, planKey: 'pro', status: 'expired', expiresDate: iso(0) },
      nextFetchedAt(),
      'revenuecat:evt_upgrade:superseded',
    );
    const inserted = await tryApplyStore(
      { userId: user.id, productId: PRODUCT.familyProMonth, planKey: 'family_pro', status: 'trialing', expiresDate: iso(TRIAL_DAYS) },
      nextFetchedAt(),
      'revenuecat:evt_upgrade',
    );
    expect(inserted.error).toBeNull();
    expect(inserted.data).toMatchObject({ applied: true, status_to: 'trialing', plan_key: 'family_pro' });

    const pro = await storeRowOf(user.id, PRODUCT.proMonth);
    expect(pro.status).toBe('expired');
    expect(ms(pro.trial_started_at)).toBe(ms(iso(0)));
    const changed = (await billingAuditsOf(user.id)).find((a) => a.action_type === 'system.billing.subscription_status_changed');
    expect(changed?.details).toMatchObject({ iap_product_id: PRODUCT.proMonth, from: 'trialing', to: 'expired' });
    expect(String(changed?.details.source)).toMatch(/:superseded$/);
    expect(await planKeyCached(user.id)).toBe('family_pro');

    const { data: group, error } = await asUser(user.jwt!).rpc('create_family_group', { p_name: `billing-iap ${RUN} upgrade`, p_plan_key: 'free' });
    expect(error).toBeNull();
    expect(group).toMatchObject({ plan_key: 'family_pro', member_limit: FAMILY_PRO_MEMBER_LIMIT });
  });
});
