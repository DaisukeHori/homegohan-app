/**
 * billing/01 (課金の核) 段 A: Stripe の Subscription の写像 billing_apply_stripe_subscription と、
 * 家族のグループのプランを代表者の契約に合わせるトリガー billing_family_plan_follow_representative の結合テスト
 * (設計: docs/design/billing/01-billing-core.md §6.4 (9)・(10)・§7.3・§14.2 の 52〜64・80・84・87・91・92・98・99・102〜106)
 *
 * 段 A のテストなので、段 B の src/lib/billing/* を import しない (§14.2 の冒頭)。写像に渡す p_snapshot は、関数の本体が
 * p_snapshot->>'…' で読むキーの JSON をこのファイルで組み、期待値 (status の写像の 8 組など) はリテラルで書く。
 *
 * 競合の再現のしかた (98・102・106。tests/integration/security/family-lock-order-race.test.ts と同じ考え方):
 *   postgres-meta (/pg/query) で「先に処理を流し、pg_sleep でトランザクションを開いたままにする」接続を 1 本作り、
 *   pg_sleep に入ったのを pg_stat_activity で確かめてから、もう 1 件を本物の経路 (PostgREST) で呼ぶ。
 *   後の処理がロックの待ちに入ったことも pg_stat_activity で確かめる (タイミングに頼らない)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/billing-apply-subscription-rpc.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { grantFamilyPlan } from '../helpers/family-plan';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ローカルスタックの Kong → PostgREST の接続は、しばらく使っていないと切られていることがあり、
 * 使い回した最初の 1 回が 502 になる。データベースの結果ではないので、数回だけやり直す (family-lock-order-race と同じ)
 */
const GATEWAY_RETRIES = 3;
/** 502 のやり直しの間隔の単位 (ミリ秒。n 回目は n 倍) */
const GATEWAY_RETRY_UNIT_MS = 150;
/** これより遅く返った 502 は、pg_sleep で待たせた後の応答の可能性があるので、やり直さない (ミリ秒) */
const GATEWAY_FAST_FAILURE_MS = 1500;
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

/** ローカルスタックの postgres-meta で SQL を実行する (postgres として 1 つのトランザクション)。502 の速い失敗だけやり直す */
async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 502 && attempt < GATEWAY_RETRIES && Date.now() - startedAt < GATEWAY_FAST_FAILURE_MS) {
      await sleep(GATEWAY_RETRY_UNIT_MS * (attempt + 1));
      continue;
    }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  }
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

// ---------------------------------------------------------------------------------------------
// 利用者・識別子
// ---------------------------------------------------------------------------------------------

interface TestUser {
  id: string;
  email: string;
  /** JWT が要るテスト (create_family_group・本人の DELETE・運営の RPC) だけサインインする */
  jwt: string | null;
}

const TS = Date.now();
const RUN = `${TS}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const SUB_PREFIX = `sub_it_${RUN}_`;
const CUSTOMER_PREFIX = `cus_it_${RUN}_`;
const createdUserIds: string[] = [];
const pendingHolders: Array<Promise<unknown>> = [];
let seq = 0;

const nextSub = () => `${SUB_PREFIX}${++seq}`;
const nextCustomer = () => `${CUSTOMER_PREFIX}${++seq}`;

/** Stripe から取り直した時刻 (p_fetched_at)。呼ぶたびに進む (写像は stripe_synced_at より新しいものだけを適用する) */
const FETCHED_AT_BASE_MS = TS - 60 * 60 * 1000;
const FETCHED_AT_STEP_MS = 1000;
let fetchedSeq = 0;
const nextFetchedAt = () => new Date(FETCHED_AT_BASE_MS + ++fetchedSeq * FETCHED_AT_STEP_MS).toISOString();

const DAY_MS = 24 * 60 * 60 * 1000;
/** 契約の期間・試用の長さ (日)。値そのものは写像の結果を見るための入力 */
const PERIOD_DAYS = 30;
const TRIAL_DAYS = 7;
const iso = (offsetDays: number) => new Date(TS + offsetDays * DAY_MS).toISOString();
const ms = (value: string | null) => (value === null ? null : new Date(value).getTime());

/** pg_sleep でトランザクションを開いたままにする秒数 */
const HOLD_SECONDS = 4;
/** pg_stat_activity を見に行く間隔と上限 (ミリ秒) */
const POLL_INTERVAL_MS = 50;
const POLL_DEADLINE_MS = 20_000;
/** 同じ契約に同時に流す写像の本数 (64) */
const CONCURRENT_APPLIES = 8;

const profileBase = { age_group: '30s', gender: 'other' };

async function createUser(label: string, options: { jwt?: boolean; roles?: string[] } = {}): Promise<TestUser> {
  const email = `rls-billing-apply-${label}-${++seq}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert(
        { id: data.user.id, nickname: `billing-${label}`, ...profileBase, ...(options.roles ? { roles: options.roles } : {}) },
        { onConflict: 'id' },
      ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  if (!options.jwt) return { id: data.user.id, email, jwt: null };
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

const jwtOf = (user: TestUser): string => {
  if (!user.jwt) throw new Error('JWT の無い利用者');
  return user.jwt;
};

// ---------------------------------------------------------------------------------------------
// 写像 (billing_apply_stripe_subscription)
// ---------------------------------------------------------------------------------------------

type StripeStatus = 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'paused';

interface SnapshotInput {
  sub: string;
  customer: string;
  status: StripeStatus;
  /** Checkout の metadata.user_id。省けば NULL (顧客の対応表・既存の行で解決する) */
  userId?: string | null;
  /** metadata.plan_key。省けば NULL */
  planKey?: string | null;
  pause?: boolean;
  priceId?: string;
  interval?: 'month' | 'year';
  cancelAtPeriodEnd?: boolean;
  cancelAt?: string | null;
  trialStart?: string | null;
  trialEnd?: string | null;
  endedAt?: string | null;
  canceledAt?: string | null;
  periodStart?: string;
  periodEnd?: string;
}

/** §8.1 の SubscriptionSnapshot と同じキー (関数の本体が ->> で読むもの) */
function snapshot(input: SnapshotInput): Record<string, unknown> {
  return {
    stripe_subscription_id: input.sub,
    stripe_customer_id: input.customer,
    user_id: input.userId ?? null,
    plan_key: input.planKey ?? null,
    stripe_status: input.status,
    pause_collection: input.pause ?? false,
    stripe_price_id: input.priceId ?? 'price_it_monthly',
    billing_interval: input.interval ?? 'month',
    start_date: iso(0),
    current_period_start: input.periodStart ?? iso(0),
    current_period_end: input.periodEnd ?? iso(PERIOD_DAYS),
    trial_start: input.trialStart ?? null,
    trial_end: input.trialEnd ?? null,
    cancel_at: input.cancelAt ?? null,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    ended_at: input.endedAt ?? null,
    canceled_at: input.canceledAt ?? null,
  };
}

interface ApplyResult {
  applied: boolean;
  skipped?: 'stale' | 'user_deleted';
  subscription_id?: string;
  user_id?: string;
  status_from?: string | null;
  status_to?: string;
  plan_key?: string;
  customer_closed?: boolean;
}

interface RpcError {
  message: string;
  code: string;
  details: string | null;
}

async function tryApply(
  input: SnapshotInput,
  fetchedAt: string = nextFetchedAt(),
  source = 'webhook:evt_it',
): Promise<{ data: ApplyResult | null; error: RpcError | null }> {
  const { data, error } = await srAdmin.rpc('billing_apply_stripe_subscription', {
    p_snapshot: snapshot(input),
    p_fetched_at: fetchedAt,
    p_source: source,
  });
  return {
    data: (data as ApplyResult | null) ?? null,
    error: error ? { message: error.message, code: error.code, details: error.details ?? null } : null,
  };
}

async function apply(input: SnapshotInput, fetchedAt?: string, source?: string): Promise<ApplyResult> {
  const { data, error } = await tryApply(input, fetchedAt, source);
  if (error || !data) throw new Error(`billing_apply_stripe_subscription: ${JSON.stringify(error)}`);
  return data;
}

/** 写像を呼ぶ SQL の式 (postgres-meta の接続で流すとき) */
const applySql = (input: SnapshotInput, fetchedAt: string) =>
  `public.billing_apply_stripe_subscription('${JSON.stringify(snapshot(input))}'::jsonb, '${fetchedAt}'::timestamptz, 'test:hold')`;

// ---------------------------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------------------------

interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_key: string;
  status: string;
  stripe_status: string | null;
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  billing_interval: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_source: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  past_due_since: string | null;
  grace_started_at: string | null;
  stripe_synced_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
}

const SUBSCRIPTION_COLUMNS =
  'id, user_id, plan_key, status, stripe_status, stripe_customer_id, stripe_price_id, billing_interval, trial_started_at, trial_ends_at, trial_source, cancel_at, cancel_at_period_end, cancelled_at, past_due_since, grace_started_at, stripe_synced_at, current_period_start, current_period_end';

async function rowBySub(sub: string): Promise<SubscriptionRow | null> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .select(SUBSCRIPTION_COLUMNS)
    .eq('stripe_subscription_id', sub)
    .maybeSingle();
  if (error) throw new Error(`personal_subscriptions: ${error.message}`);
  return data as SubscriptionRow | null;
}

async function mustRow(sub: string): Promise<SubscriptionRow> {
  const row = await rowBySub(sub);
  if (!row) throw new Error(`契約の行が無い: ${sub}`);
  return row;
}

async function planKeyCached(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('plan_key_cached').eq('id', userId).single();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return (data as { plan_key_cached: string | null }).plan_key_cached;
}

interface AuditRow {
  action_type: string;
  actor_id: string | null;
  target_type: string | null;
  severity: string;
  details: Record<string, unknown>;
}

async function audits(userId: string): Promise<AuditRow[]> {
  const { data, error } = await srAdmin
    .from('admin_audit_logs')
    .select('action_type, actor_id, target_type, severity, details, created_at')
    .eq('target_id', userId)
    .like('action_type', 'system.billing.%')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`admin_audit_logs: ${error.message}`);
  return (data ?? []) as AuditRow[];
}

async function customerRow(customer: string): Promise<{ user_id: string | null; anonymized_at: string | null } | null> {
  const { data, error } = await srAdmin
    .from('billing_customers')
    .select('user_id, anonymized_at')
    .eq('stripe_customer_id', customer)
    .maybeSingle();
  if (error) throw new Error(`billing_customers: ${error.message}`);
  return data as { user_id: string | null; anonymized_at: string | null } | null;
}

// ---------------------------------------------------------------------------------------------
// 家族のグループ
// ---------------------------------------------------------------------------------------------

interface FamilyRow {
  plan_key: string;
  member_limit: number;
  status: string;
  representative_id: string;
}

async function familyRow(id: string): Promise<FamilyRow | null> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .select('plan_key, member_limit, status, representative_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`family_groups: ${error.message}`);
  return data as FamilyRow | null;
}

async function mustFamily(id: string): Promise<FamilyRow> {
  const row = await familyRow(id);
  if (!row) throw new Error(`家族のグループが無い: ${id}`);
  return row;
}

/** service_role で家族のグループを直接作る (作成のトリガーが代表者の契約から plan_key を決める) */
async function insertFamily(representativeId: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .insert({ name: `billing ${RUN} ${++seq}`, representative_id: representativeId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`family_groups insert: ${error?.message}`);
  return (data as { id: string }).id;
}

/** service_role で家族のグループのプランを直接入れる (UPDATE OF plan_key はトリガーに当たらない。契約なしの家族プラン) */
async function setFamilyPlan(familyId: string, planKey: string, memberLimit: number): Promise<void> {
  const { error } = await srAdmin.from('family_groups').update({ plan_key: planKey, member_limit: memberLimit }).eq('id', familyId);
  if (error) throw new Error(`family_groups plan: ${error.message}`);
}

/** 代表者として家族を作る (RPC。代表者の active なメンバー行と user_profiles.family_id も作る) */
async function createFamilyViaRpc(rep: TestUser, planKey: string): Promise<{ id: string; plan_key: string; member_limit: number }> {
  const { data, error } = await asUser(jwtOf(rep)).rpc('create_family_group', {
    p_name: `billing ${RUN} ${++seq}`,
    p_plan_key: planKey,
  });
  if (error || !data) throw new Error(`create_family_group: ${error?.message}`);
  return data as { id: string; plan_key: string; member_limit: number };
}

/**
 * 契約の無い代表者の家族 (グループは free / 4) を RPC で作る。billing/03 §6.6 から create_family_group は家族プランの契約者だけが
 * 作れるので、家族プランを手動付与してから作り、すぐに取り消す (billing_revoke_manual_subscription。グループは free / 4 に戻り、
 * 代表者に live な契約は残らない)。そのあとの Stripe の写像は、live な行の衝突なしに代表者の契約として入る
 */
async function createFamilyViaRpcBeforeContract(rep: TestUser): Promise<string> {
  await grantFamilyPlan(srAdmin, rep.id);
  const created = await createFamilyViaRpc(rep, 'free');
  const { error } = await srAdmin.rpc('billing_revoke_manual_subscription', { p_user_id: rep.id });
  if (error) throw new Error(`billing_revoke_manual_subscription: ${error.message}`);
  const family = await mustFamily(created.id);
  if (family.plan_key !== 'free' || family.member_limit !== 4) {
    throw new Error(`取り消しの後のグループが free / 4 でない: ${JSON.stringify(family)}`);
  }
  return created.id;
}

/** 手動付与の行 (stripe_subscription_id が NULL) を service_role で作る */
async function insertManualRow(userId: string, planKey: string, status: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .insert({ user_id: userId, plan_key: planKey, status })
    .select('id')
    .single();
  if (error || !data) throw new Error(`personal_subscriptions insert: ${error?.message}`);
  return (data as { id: string }).id;
}

/** 配線のジョブの直接の UPDATE (past_due → grace) を service_role で流す */
async function moveToGrace(rowId: string): Promise<string> {
  const startedAt = new Date().toISOString();
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .update({ status: 'grace', grace_started_at: startedAt })
    .eq('id', rowId)
    .eq('status', 'past_due')
    .select('grace_started_at')
    .single();
  if (error || !data) throw new Error(`grace: ${error?.message}`);
  return (data as { grace_started_at: string }).grace_started_at;
}

/** 配線の直接の UPDATE (active → paused) を service_role で流す (paused は paused_until が必須) */
async function moveToPaused(rowId: string): Promise<void> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .update({ status: 'paused', paused_at: new Date().toISOString(), paused_until: iso(PERIOD_DAYS) })
    .eq('id', rowId)
    .eq('status', 'active')
    .select('id');
  if (error || !data || data.length !== 1) throw new Error(`paused: ${error?.message}`);
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (postgres-meta)
// ---------------------------------------------------------------------------------------------

interface Outcome {
  ok: boolean;
  message: string | null;
  code: string | null;
}

interface Holder {
  /** 先の処理が済み、pg_sleep に入った (= ロックを持ったままコミット前の) 状態になると解決する */
  sleeping: Promise<void>;
  /** トランザクションが終わったときに解決する */
  done: Promise<Outcome>;
}

/** postgres として before を実行し、holdSeconds 秒 pg_sleep してから after を実行して、コミットする */
function startHolder(before: string, after: string, holdSeconds = HOLD_SECONDS): Holder {
  const marker = `billing-holder-${randomBytes(6).toString('hex')}`;
  const sql = `/* ${marker} */
    ${before}
    SELECT pg_sleep(${holdSeconds});
    ${after}
    SELECT 'held' AS result;`;
  const state: { outcome: Outcome | null } = { outcome: null };
  const done = pgRequest(sql).then((res): Outcome => {
    const body = res.body as { error?: unknown; code?: unknown } | null;
    const outcome: Outcome = res.ok
      ? { ok: true, message: null, code: null }
      : {
          ok: false,
          message: typeof body?.error === 'string' ? body.error : JSON.stringify(body),
          code: typeof body?.code === 'string' ? body.code : null,
        };
    state.outcome = outcome;
    return outcome;
  });
  pendingHolders.push(done);
  const sleeping = (async () => {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (state.outcome) {
        throw new Error(`先に呼んだ接続が pg_sleep に入る前に終わりました: ${JSON.stringify(state.outcome)}`);
      }
      const rows = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      if (rows[0]?.n === 1) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('先に呼んだ接続が pg_sleep に入りませんでした');
  })();
  return { sleeping, done };
}

/**
 * ほかの接続が、ロックの待ち (wait_event_type = 'Lock') に入ったのを確かめる。queryLike はその接続の SQL に含まれる語。
 * waitEvent を渡すと、その待ちの種類 (advisory / transactionid / tuple) に絞る
 */
async function waitForLockWaiter(queryLike: string, waitEvent?: string): Promise<void> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    const rows = await pgQuery<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' ${waitEvent ? `AND wait_event = '${waitEvent}'` : ''}
        AND query ILIKE '%${queryLike}%' AND pid <> pg_backend_pid()`);
    if ((rows[0]?.n ?? 0) >= 1) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`ロックの待ちに入った接続が見つかりません: ${queryLike}`);
}

function toOutcome(error: { message?: string; code?: string } | null): Outcome {
  return { ok: !error, message: error?.message ?? null, code: error?.code ?? null };
}

/** デッドロック (40P01) */
function expectNoDeadlock(...outcomes: Outcome[]) {
  for (const outcome of outcomes) {
    expect(outcome.code === '40P01' || /deadlock detected/i.test(outcome.message ?? ''), `デッドロック: ${JSON.stringify(outcome)}`).toBe(
      false,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 後片付け
// ---------------------------------------------------------------------------------------------

/** 運営 (super_admin)。operator_force_dissolve_family を呼ぶ */
let operator: TestUser;

beforeAll(async () => {
  operator = await createUser('operator', { jwt: true, roles: ['user', 'super_admin'] });
}, 60_000);

afterAll(async () => {
  await Promise.allSettled(pendingHolders);
  if (createdUserIds.length > 0) {
    const { data: families } = await srAdmin.from('family_groups').select('id').in('representative_id', createdUserIds);
    const familyIds = ((families ?? []) as Array<{ id: string }>).map((f) => f.id);
    if (familyIds.length > 0) {
      await srAdmin.from('membership_audit').delete().in('scope_id', familyIds);
      await srAdmin.from('family_groups').delete().in('id', familyIds);
    }
    await srAdmin.from('admin_audit_logs').delete().in('target_id', createdUserIds);
  }
  await srAdmin.from('billing_customers').delete().like('stripe_customer_id', `${CUSTOMER_PREFIX}%`);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles・personal_subscriptions は CASCADE
  }
}, 180_000);

// ---------------------------------------------------------------------------------------------
// 1. 写像の基本
// ---------------------------------------------------------------------------------------------

describe('billing/01 §6.4 (9): 写像の基本', () => {
  it('inserts a trialing row from a snapshot with metadata.user_id and sets plan_key_cached', async () => {
    const user = await createUser('trialing');
    const sub = nextSub();
    const customer = nextCustomer();
    const fetchedAt = nextFetchedAt();
    const result = await apply(
      {
        sub,
        customer,
        status: 'trialing',
        userId: user.id,
        planKey: 'pro',
        priceId: 'price_it_pro_month',
        trialStart: iso(0),
        trialEnd: iso(TRIAL_DAYS),
      },
      fetchedAt,
    );
    const row = await mustRow(sub);
    expect(result).toEqual({
      applied: true,
      subscription_id: row.id,
      user_id: user.id,
      status_from: null,
      status_to: 'trialing',
      plan_key: 'pro',
    });
    expect(row).toMatchObject({
      user_id: user.id,
      plan_key: 'pro',
      status: 'trialing',
      stripe_status: 'trialing',
      stripe_customer_id: customer,
      stripe_price_id: 'price_it_pro_month',
      billing_interval: 'month',
      trial_source: 'checkout',
      cancel_at_period_end: false,
      cancelled_at: null,
      past_due_since: null,
    });
    expect(ms(row.trial_ends_at)).toBe(ms(iso(TRIAL_DAYS)));
    expect(ms(row.stripe_synced_at)).toBe(ms(fetchedAt));
    expect(await planKeyCached(user.id)).toBe('pro');
    expect(await customerRow(customer)).toEqual({ user_id: user.id, anonymized_at: null });
  });

  it('maps all 8 Stripe statuses to the DB status: incomplete→incomplete, incomplete_expired→expired, trialing→trialing, active→active, past_due→past_due, unpaid→past_due, canceled→cancelled, paused→expired', async () => {
    const pairs: Array<[StripeStatus, string]> = [
      ['incomplete', 'incomplete'],
      ['incomplete_expired', 'expired'],
      ['trialing', 'trialing'],
      ['active', 'active'],
      ['past_due', 'past_due'],
      ['unpaid', 'past_due'],
      ['canceled', 'cancelled'],
      ['paused', 'expired'],
    ];
    expect(pairs).toHaveLength(8);
    const users = await Promise.all(pairs.map(([stripe]) => createUser(`map-${stripe}`)));
    for (const [index, [stripe, expected]] of pairs.entries()) {
      const sub = nextSub();
      const result = await apply({ sub, customer: nextCustomer(), status: stripe, userId: users[index].id, planKey: 'pro', endedAt: iso(0) });
      expect(result.status_to, stripe).toBe(expected);
      const row = await mustRow(sub);
      expect(row.status, stripe).toBe(expected);
      expect(row.stripe_status, stripe).toBe(stripe);
    }
  });

  it('skips stale snapshots (fetched_at <= stripe_synced_at) and applies newer ones', async () => {
    const user = await createUser('stale');
    const sub = nextSub();
    const customer = nextCustomer();
    const older = nextFetchedAt();
    const current = nextFetchedAt();
    const newer = nextFetchedAt();
    await apply({ sub, customer, status: 'active', userId: user.id, planKey: 'pro' }, current);
    const row = await mustRow(sub);

    for (const fetchedAt of [older, current]) {
      const result = await apply({ sub, customer, status: 'past_due', userId: user.id, planKey: 'pro' }, fetchedAt);
      expect(result).toEqual({ applied: false, skipped: 'stale', subscription_id: row.id, user_id: user.id });
      expect((await mustRow(sub)).status).toBe('active');
    }
    const applied = await apply({ sub, customer, status: 'past_due', userId: user.id, planKey: 'pro' }, newer);
    expect(applied).toMatchObject({ applied: true, status_from: 'active', status_to: 'past_due' });
    const after = await mustRow(sub);
    expect(after.status).toBe('past_due');
    expect(ms(after.stripe_synced_at)).toBe(ms(newer));
  });

  it('raises BILL_LIVE_ROW_CONFLICT when another live row (manual) exists for the user', async () => {
    const user = await createUser('conflict');
    const manualId = await insertManualRow(user.id, 'pro', 'active');
    const sub = nextSub();
    const { data, error } = await tryApply({ sub, customer: nextCustomer(), status: 'active', userId: user.id, planKey: 'pro' });
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT', details: manualId });
    expect(await rowBySub(sub)).toBeNull();
  });

  it('raises BILL_UNKNOWN_PLAN when neither metadata nor existing row gives a plan', async () => {
    const user = await createUser('unknown-plan');
    const sub = nextSub();
    const missing = await tryApply({ sub, customer: nextCustomer(), status: 'active', userId: user.id });
    expect(missing.error).toMatchObject({ code: 'P0001', message: 'BILL_UNKNOWN_PLAN', details: sub });
    const unknown = await tryApply({ sub, customer: nextCustomer(), status: 'active', userId: user.id, planKey: 'no_such_plan_it' });
    expect(unknown.error).toMatchObject({ code: 'P0001', message: 'BILL_UNKNOWN_PLAN', details: 'no_such_plan_it' });
    expect(await rowBySub(sub)).toBeNull();
  });

  it('resolves the user from billing_customers when metadata.user_id is missing and inserts the mapping when missing', async () => {
    const [mapped, unmapped] = await Promise.all([createUser('mapped'), createUser('unmapped')]);
    const mappedCustomer = nextCustomer();
    const { error: mapError } = await srAdmin.from('billing_customers').insert({ stripe_customer_id: mappedCustomer, user_id: mapped.id });
    if (mapError) throw new Error(`billing_customers: ${mapError.message}`);
    const sub = nextSub();
    const result = await apply({ sub, customer: mappedCustomer, status: 'active', planKey: 'pro' });
    expect(result).toMatchObject({ applied: true, user_id: mapped.id, status_to: 'active' });
    expect((await mustRow(sub)).user_id).toBe(mapped.id);

    // 対応表に無い顧客は、写像が足す
    const newCustomer = nextCustomer();
    expect(await customerRow(newCustomer)).toBeNull();
    await apply({ sub: nextSub(), customer: newCustomer, status: 'active', userId: unmapped.id, planKey: 'pro' });
    expect(await customerRow(newCustomer)).toEqual({ user_id: unmapped.id, anonymized_at: null });
  });

  it('returns skipped user_deleted for a user that no longer exists, and for a subscription without metadata.user_id whose billing_customers row was anonymized by account deletion (user_id NULL, anonymized_at set); a customer row with user_id NULL and no anonymized_at still raises BILL_UNKNOWN_USER; customer_closed is true only when the subscription customer has a billing_customers row with user_id NULL (false for a customer unknown to this database)', async () => {
    const [withCustomer, withoutCustomer, anonymized, notAnonymized] = await Promise.all([
      createUser('deleted-with-customer'),
      createUser('deleted-without-customer'),
      createUser('deleted-anonymized'),
      createUser('deleted-not-anonymized'),
    ]);
    const customers = { withCustomer: nextCustomer(), anonymized: nextCustomer(), notAnonymized: nextCustomer() };
    const { error: mapError } = await srAdmin.from('billing_customers').insert([
      { stripe_customer_id: customers.withCustomer, user_id: withCustomer.id },
      { stripe_customer_id: customers.anonymized, user_id: anonymized.id },
      { stripe_customer_id: customers.notAnonymized, user_id: notAnonymized.id },
    ]);
    if (mapError) throw new Error(`billing_customers: ${mapError.message}`);
    // 退会 (auth.users の削除。billing_customers.user_id は SET NULL)
    for (const user of [withCustomer, withoutCustomer, anonymized, notAnonymized]) {
      const { error } = await srAdmin.auth.admin.deleteUser(user.id);
      if (error) throw new Error(`deleteUser: ${error.message}`);
    }
    // 退会の段階 billing が入れる匿名化の印
    await srAdmin.from('billing_customers').update({ anonymized_at: new Date().toISOString() }).eq('stripe_customer_id', customers.anonymized);
    expect(await customerRow(customers.withCustomer)).toEqual({ user_id: null, anonymized_at: null });

    // metadata.user_id が消えた利用者で、顧客の対応表の行あり → customer_closed: true
    const subA = nextSub();
    expect(await apply({ sub: subA, customer: customers.withCustomer, status: 'active', userId: withCustomer.id, planKey: 'pro' })).toEqual({
      applied: false,
      skipped: 'user_deleted',
      customer_closed: true,
    });
    // 対応表に無い顧客 → customer_closed: false
    const subB = nextSub();
    expect(await apply({ sub: subB, customer: nextCustomer(), status: 'active', userId: withoutCustomer.id, planKey: 'pro' })).toEqual({
      applied: false,
      skipped: 'user_deleted',
      customer_closed: false,
    });
    // metadata の無い契約で、顧客は退会で匿名化済み → customer_closed: true
    const subC = nextSub();
    expect(await apply({ sub: subC, customer: customers.anonymized, status: 'active', planKey: 'pro' })).toEqual({
      applied: false,
      skipped: 'user_deleted',
      customer_closed: true,
    });
    // metadata の無い契約で、user_id が NULL だが anonymized_at の無い顧客 (退会の手順を通らずに消えた) → BILL_UNKNOWN_USER
    const subD = nextSub();
    const unknown = await tryApply({ sub: subD, customer: customers.notAnonymized, status: 'active', planKey: 'pro' });
    expect(unknown.error).toMatchObject({ code: 'P0001', message: 'BILL_UNKNOWN_USER', details: subD });

    for (const sub of [subA, subB, subC, subD]) expect(await rowBySub(sub)).toBeNull();
    for (const user of [withCustomer, withoutCustomer, anonymized]) expect(await audits(user.id)).toEqual([]);
  });

  it('writes one admin_audit_logs row per status change with actor_id NULL', async () => {
    const user = await createUser('audit');
    const sub = nextSub();
    const customer = nextCustomer();
    const base = { sub, customer, userId: user.id, planKey: 'pro' };
    await apply({ ...base, status: 'trialing', trialStart: iso(0), trialEnd: iso(TRIAL_DAYS) }, nextFetchedAt(), 'checkout_sync');
    // 同じ status の取り直しは書かない
    await apply({ ...base, status: 'trialing', trialStart: iso(0), trialEnd: iso(TRIAL_DAYS) }, nextFetchedAt(), 'webhook:evt_it_2');
    await apply({ ...base, status: 'past_due' }, nextFetchedAt(), 'webhook:evt_it_3');
    await apply({ ...base, status: 'active' }, nextFetchedAt(), 'webhook:evt_it_4');

    const rows = await audits(user.id);
    expect(rows.map((r) => [r.action_type, r.details.from, r.details.to, r.severity])).toEqual([
      ['system.billing.subscription_created', null, 'trialing', 'info'],
      ['system.billing.subscription_status_changed', 'trialing', 'past_due', 'warn'],
      ['system.billing.subscription_status_changed', 'past_due', 'active', 'info'],
    ]);
    for (const row of rows) {
      expect(row.actor_id).toBeNull();
      expect(row.target_type).toBe('user');
      expect(row.details).toMatchObject({ stripe_subscription_id: sub, plan_key: 'pro' });
    }
    expect(rows[0].details).toMatchObject({ stripe_status: 'trialing', source: 'checkout_sync' });
    expect(rows[2].details).toMatchObject({ stripe_status: 'active', source: 'webhook:evt_it_4' });
  });

  it('is not executable by anon/authenticated (42501)', async () => {
    const user = await createUser('no-exec', { jwt: true });
    const calls: Array<[string, Record<string, unknown>]> = [
      [
        'billing_apply_stripe_subscription',
        {
          p_snapshot: snapshot({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: user.id, planKey: 'pro' }),
          p_fetched_at: nextFetchedAt(),
          p_source: 'test',
        },
      ],
      ['billing_claim_stripe_event', { p_event_id: `evt_it_${RUN}_noexec`, p_event_type: 'x', p_payload: {} }],
      ['billing_finish_stripe_event', { p_event_id: `evt_it_${RUN}_noexec`, p_ok: true }],
    ];
    for (const [fn, args] of calls) {
      for (const [who, c] of [
        ['anon', anon()],
        ['authenticated', asUser(jwtOf(user))],
      ] as const) {
        const { error } = await c.rpc(fn, args);
        expect(error?.code, `${who} ${fn}`).toBe('42501');
      }
    }
    expect(await planKeyCached(user.id)).toBeNull();
  });

  it('serializes concurrent applies for the same subscription (advisory lock)', async () => {
    const user = await createUser('concurrent');
    const sub = nextSub();
    const customer = nextCustomer();
    const fetchedAts = Array.from({ length: CONCURRENT_APPLIES }, () => nextFetchedAt());
    const results = await Promise.all(
      fetchedAts.map((fetchedAt) => tryApply({ sub, customer, status: 'active', userId: user.id, planKey: 'pro' }, fetchedAt)),
    );
    // どれも失敗しない (同時の INSERT が stripe_subscription_id の UNIQUE に当たらない)
    for (const result of results) expect(result.error).toBeNull();
    // 行は 1 本で、最後に適用されたのは最も新しい取り直し
    const { count } = await srAdmin
      .from('personal_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('stripe_subscription_id', sub);
    expect(count).toBe(1);
    expect(ms((await mustRow(sub)).stripe_synced_at)).toBe(Math.max(...fetchedAts.map((f) => new Date(f).getTime())));
    expect(results.filter((r) => r.data?.applied && r.data.status_from === null)).toHaveLength(1);
    expect((await audits(user.id)).map((a) => a.action_type)).toEqual(['system.billing.subscription_created']);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. 保持の規則と時刻の列 (§7.3)
// ---------------------------------------------------------------------------------------------

describe('billing/01 §7.3: 保持の規則と時刻の列', () => {
  it('keeps grace while Stripe says past_due/unpaid and clears it on active', async () => {
    const user = await createUser('grace');
    const sub = nextSub();
    const base = { sub, customer: nextCustomer(), userId: user.id, planKey: 'pro' };
    await apply({ ...base, status: 'active' });
    await apply({ ...base, status: 'past_due' });
    const pastDue = await mustRow(sub);
    expect(pastDue.past_due_since).not.toBeNull();
    const graceStartedAt = await moveToGrace(pastDue.id);

    for (const status of ['past_due', 'unpaid'] as const) {
      const result = await apply({ ...base, status });
      expect(result.status_to, status).toBe('grace');
      const row = await mustRow(sub);
      expect(row.status, status).toBe('grace');
      expect(row.stripe_status, status).toBe(status);
      expect(ms(row.grace_started_at), status).toBe(ms(graceStartedAt));
      expect(ms(row.past_due_since), status).toBe(ms(pastDue.past_due_since));
    }
    expect(await planKeyCached(user.id)).toBe('pro');

    const recovered = await apply({ ...base, status: 'active' });
    expect(recovered).toMatchObject({ status_from: 'grace', status_to: 'active' });
    const row = await mustRow(sub);
    expect(row).toMatchObject({ status: 'active', past_due_since: null, grace_started_at: null });
  });

  it('keeps paused while Stripe is active with pause_collection, also when cancel_at_period_end is set or cleared (API / Portal reservation on a paused row)', async () => {
    const user = await createUser('paused');
    const sub = nextSub();
    const base = { sub, customer: nextCustomer(), userId: user.id, planKey: 'pro' };
    await apply({ ...base, status: 'active' });
    await moveToPaused((await mustRow(sub)).id);
    const auditsBefore = (await audits(user.id)).length;

    const kept = await apply({ ...base, status: 'active', pause: true });
    expect(kept.status_to).toBe('paused');
    // 解約の予約を付ける / 外す
    await apply({ ...base, status: 'active', pause: true, cancelAtPeriodEnd: true, cancelAt: iso(PERIOD_DAYS) });
    const reserved = await mustRow(sub);
    expect(reserved).toMatchObject({ status: 'paused', cancel_at_period_end: true });
    expect(ms(reserved.cancel_at)).toBe(ms(iso(PERIOD_DAYS)));
    await apply({ ...base, status: 'active', pause: true, cancelAtPeriodEnd: false, cancelAt: null });
    expect(await mustRow(sub)).toMatchObject({ status: 'paused', cancel_at_period_end: false, cancel_at: null });
    expect((await audits(user.id)).length).toBe(auditsBefore);
    expect(await planKeyCached(user.id)).toBe('pro');
  });

  it('active → Stripe unpaid becomes past_due with past_due_since set; past_due → unpaid keeps past_due_since and writes no audit', async () => {
    const user = await createUser('unpaid');
    const sub = nextSub();
    const base = { sub, customer: nextCustomer(), userId: user.id, planKey: 'pro' };
    await apply({ ...base, status: 'active' });
    const toUnpaid = await apply({ ...base, status: 'unpaid' });
    expect(toUnpaid).toMatchObject({ status_from: 'active', status_to: 'past_due' });
    const first = await mustRow(sub);
    expect(first).toMatchObject({ status: 'past_due', stripe_status: 'unpaid' });
    expect(first.past_due_since).not.toBeNull();
    const auditsAfterFirst = await audits(user.id);
    expect(auditsAfterFirst.at(-1)).toMatchObject({ action_type: 'system.billing.subscription_status_changed', severity: 'warn' });

    await apply({ ...base, status: 'past_due' });
    await apply({ ...base, status: 'unpaid' });
    const later = await mustRow(sub);
    expect(later).toMatchObject({ status: 'past_due', stripe_status: 'unpaid' });
    expect(ms(later.past_due_since)).toBe(ms(first.past_due_since));
    expect((await audits(user.id)).length).toBe(auditsAfterFirst.length);
  });

  it('moves a live row to expired on Stripe paused and back to active on resumed, auditing both; a resumed row raises BILL_LIVE_ROW_CONFLICT when another live row exists', async () => {
    const user = await createUser('stripe-paused');
    const sub = nextSub();
    const base = { sub, customer: nextCustomer(), userId: user.id, planKey: 'pro' };
    await apply({ ...base, status: 'active' });
    expect(await apply({ ...base, status: 'paused' })).toMatchObject({ status_from: 'active', status_to: 'expired' });
    expect(await planKeyCached(user.id)).toBeNull();
    expect(await apply({ ...base, status: 'active' })).toMatchObject({ status_from: 'expired', status_to: 'active' });
    expect(await planKeyCached(user.id)).toBe('pro');
    const transitions = (await audits(user.id)).map((a) => [a.details.from, a.details.to]);
    expect(transitions).toEqual([
      [null, 'active'],
      ['active', 'expired'],
      ['expired', 'active'],
    ]);

    // 一時停止の間に別の live な行 (手動付与) ができていれば、再開は写せない
    await apply({ ...base, status: 'paused' });
    const manualId = await insertManualRow(user.id, 'pro', 'active');
    const resumed = await tryApply({ ...base, status: 'active' });
    expect(resumed.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT', details: manualId });
    expect((await mustRow(sub)).status).toBe('expired');
  });

  it('the first apply of a subscription with no row inserts a cancelled / expired row without the live-row conflict check, keeps plan_key_cached, resets the family group only when no live row of the same plan remains, and audits subscription_created with to = cancelled', async () => {
    // 同じ利用者に live な 1 本目 (family_basic) がある状態で、2 本目を canceled で初めて写す
    const rep = await createUser('first-cancelled');
    const familyId = await insertFamily(rep.id);
    const first = nextSub();
    await apply({ sub: first, customer: nextCustomer(), status: 'active', userId: rep.id, planKey: 'family_basic' });
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });

    const second = nextSub();
    const endedAt = iso(-1);
    const result = await apply({ sub: second, customer: nextCustomer(), status: 'canceled', userId: rep.id, planKey: 'family_basic', endedAt });
    expect(result).toMatchObject({ applied: true, status_from: null, status_to: 'cancelled', plan_key: 'family_basic' });
    const row = await mustRow(second);
    expect(row.status).toBe('cancelled');
    expect(ms(row.cancelled_at)).toBe(ms(endedAt));
    expect(await planKeyCached(rep.id)).toBe('family_basic');
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });
    const created = (await audits(rep.id)).filter((a) => a.details.stripe_subscription_id === second);
    expect(created).toEqual([
      expect.objectContaining({ action_type: 'system.billing.subscription_created', severity: 'info', details: expect.objectContaining({ from: null, to: 'cancelled' }) }),
    ]);

    // 同じプランの live な行が無ければ戻す (グループのプランが契約なしで family_pro。初めての写像が expired)
    const rep2 = await createUser('first-expired');
    const family2 = await insertFamily(rep2.id);
    await setFamilyPlan(family2, 'family_pro', 8);
    const expired = await apply({ sub: nextSub(), customer: nextCustomer(), status: 'incomplete_expired', userId: rep2.id, planKey: 'family_pro' });
    expect(expired).toMatchObject({ status_from: null, status_to: 'expired' });
    expect(await mustFamily(family2)).toMatchObject({ plan_key: 'free', member_limit: 4 });
    expect(await planKeyCached(rep2.id)).toBeNull();
  });

  it('a Portal-style updated snapshot that only sets / clears cancel_at_period_end on an active (also trialing / past_due / grace) row updates cancel_at_period_end and cancel_at, keeps the status, writes no admin_audit_logs row, and the read-back row has cancel_at_period_end true with cancel_at set, then false with cancel_at null', async () => {
    const cases: Array<{ db: string; stripe: StripeStatus }> = [
      { db: 'active', stripe: 'active' },
      { db: 'trialing', stripe: 'trialing' },
      { db: 'past_due', stripe: 'past_due' },
      { db: 'grace', stripe: 'past_due' },
    ];
    for (const c of cases) {
      const user = await createUser(`portal-${c.db}`);
      const sub = nextSub();
      const base = { sub, customer: nextCustomer(), userId: user.id, planKey: 'pro' };
      await apply({ ...base, status: c.db === 'grace' ? 'past_due' : c.stripe });
      if (c.db === 'grace') await moveToGrace((await mustRow(sub)).id);
      const auditsBefore = (await audits(user.id)).length;

      await apply({ ...base, status: c.stripe, cancelAtPeriodEnd: true, cancelAt: iso(PERIOD_DAYS) }, nextFetchedAt(), `webhook:evt_it_portal_${c.db}_1`);
      const reserved = await mustRow(sub);
      expect(reserved.status, c.db).toBe(c.db);
      expect(reserved.cancel_at_period_end, c.db).toBe(true);
      expect(ms(reserved.cancel_at), c.db).toBe(ms(iso(PERIOD_DAYS)));

      await apply({ ...base, status: c.stripe, cancelAtPeriodEnd: false, cancelAt: null }, nextFetchedAt(), `webhook:evt_it_portal_${c.db}_2`);
      const cleared = await mustRow(sub);
      expect(cleared.status, c.db).toBe(c.db);
      expect(cleared.cancel_at_period_end, c.db).toBe(false);
      expect(cleared.cancel_at, c.db).toBeNull();
      expect((await audits(user.id)).length, c.db).toBe(auditsBefore);
    }
  });

  it('an updated snapshot that keeps Stripe incomplete leaves the row incomplete, updates cancel_at_period_end / current_period_*, writes no status_changed audit and leaves plan_key_cached NULL', async () => {
    const user = await createUser('incomplete');
    const sub = nextSub();
    const base = { sub, customer: nextCustomer(), userId: user.id, planKey: 'pro' };
    await apply({ ...base, status: 'incomplete' });
    expect(await planKeyCached(user.id)).toBeNull();
    const periodStart = iso(1);
    const periodEnd = iso(1 + PERIOD_DAYS);
    const result = await apply({ ...base, status: 'incomplete', cancelAtPeriodEnd: true, cancelAt: periodEnd, periodStart, periodEnd });
    expect(result).toMatchObject({ applied: true, status_from: 'incomplete', status_to: 'incomplete' });
    const row = await mustRow(sub);
    expect(row).toMatchObject({ status: 'incomplete', stripe_status: 'incomplete', cancel_at_period_end: true });
    expect(ms(row.current_period_start)).toBe(ms(periodStart));
    expect(ms(row.current_period_end)).toBe(ms(periodEnd));
    expect((await audits(user.id)).map((a) => a.action_type)).toEqual(['system.billing.subscription_created']);
    expect(await planKeyCached(user.id)).toBeNull();
  });

  it('keeps plan_key of an existing row when a later snapshot carries another plan (price swapped in the Dashboard, with and without metadata.plan_key): stripe_price_id / billing_interval follow Stripe, plan_key / plan_key_cached / family_groups.plan_key and member_limit stay, no audit', async () => {
    const rep = await createUser('price-swap');
    const familyId = await insertFamily(rep.id);
    const sub = nextSub();
    const customer = nextCustomer();
    await apply({ sub, customer, status: 'active', userId: rep.id, planKey: 'family_basic', priceId: 'price_it_family_basic' });
    const auditsBefore = (await audits(rep.id)).length;

    for (const [label, planKey] of [
      ['with metadata.plan_key', 'pro'],
      ['without metadata.plan_key', null],
    ] as const) {
      const priceId = `price_it_pro_year_${label.length}`;
      const result = await apply({ sub, customer, status: 'active', userId: rep.id, planKey, priceId, interval: 'year' });
      expect(result.plan_key, label).toBe('family_basic');
      const row = await mustRow(sub);
      expect(row, label).toMatchObject({ plan_key: 'family_basic', stripe_price_id: priceId, billing_interval: 'year', status: 'active' });
      expect(await planKeyCached(rep.id), label).toBe('family_basic');
      expect(await mustFamily(familyId), label).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });
    }
    expect((await audits(rep.id)).length).toBe(auditsBefore);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. 家族のグループ (§6.4 (9) の 10.・(10))
// ---------------------------------------------------------------------------------------------

describe('billing/01 §6.4 (9)(10): 家族のグループ', () => {
  it('syncs family_groups.plan_key and member_limit for the representative on live and resets to free on cancel', async () => {
    const rep = await createUser('family-sync');
    const familyId = await insertFamily(rep.id);
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'free', member_limit: 4 });
    const sub = nextSub();
    const base = { sub, customer: nextCustomer(), userId: rep.id, planKey: 'family_pro' };
    await apply({ ...base, status: 'active' });
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
    expect(await planKeyCached(rep.id)).toBe('family_pro');
    await apply({ ...base, status: 'canceled', endedAt: iso(0) });
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'free', member_limit: 4 });
    expect(await planKeyCached(rep.id)).toBeNull();
  });

  it('does not reset the family group to free when a non-live row ends while another live row of the same plan exists', async () => {
    const rep = await createUser('family-two-rows');
    const familyId = await insertFamily(rep.id);
    const first = nextSub();
    const firstCustomer = nextCustomer();
    await apply({ sub: first, customer: firstCustomer, status: 'incomplete', userId: rep.id, planKey: 'family_basic' });
    // incomplete は live でないので、グループは変わらない
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'free', member_limit: 4 });
    await apply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: rep.id, planKey: 'family_basic' });
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });
    // 1 本目の未完了が期限切れになっても、2 本目が live なので戻さない
    expect(await apply({ sub: first, customer: firstCustomer, status: 'incomplete_expired', userId: rep.id, planKey: 'family_basic' })).toMatchObject(
      { status_to: 'expired' },
    );
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });
    expect(await planKeyCached(rep.id)).toBe('family_basic');
  });

  it('follows the representative on family_groups.representative_id change: new representative with a live family contract → that plan and limit; otherwise free/4 only when the old representative owned the plan; untouched otherwise', async () => {
    const [oldA, newA, oldB, newB, oldC, newC] = await Promise.all(
      ['old-a', 'new-a', 'old-b', 'new-b', 'old-c', 'new-c'].map((label) => createUser(`rep-${label}`)),
    );
    const changeRepresentative = async (familyId: string, to: string) => {
      const { error } = await srAdmin.from('family_groups').update({ representative_id: to }).eq('id', familyId);
      if (error) throw new Error(`representative_id: ${error.message}`);
    };

    // A: 新しい代表者に live な家族プランの契約がある → そのプランと上限
    const familyA = await insertFamily(oldA.id);
    await apply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: newA.id, planKey: 'family_pro' });
    await changeRepresentative(familyA, newA.id);
    expect(await mustFamily(familyA)).toMatchObject({ representative_id: newA.id, plan_key: 'family_pro', member_limit: 8 });

    // B: 旧代表者の契約から来たプランで、新しい代表者に契約が無い → free / 4
    const familyB = await insertFamily(oldB.id);
    await apply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: oldB.id, planKey: 'family_basic' });
    expect(await mustFamily(familyB)).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });
    await setFamilyPlan(familyB, 'family_basic', 3);
    await changeRepresentative(familyB, newB.id);
    expect(await mustFamily(familyB)).toMatchObject({ representative_id: newB.id, plan_key: 'free', member_limit: 4 });

    // C: ほかの経路 (service_role の直接の UPDATE) で入ったプランで、どちらにも契約が無い → 触らない
    const familyC = await insertFamily(oldC.id);
    await setFamilyPlan(familyC, 'family_pro', 8);
    await changeRepresentative(familyC, newC.id);
    expect(await mustFamily(familyC)).toMatchObject({ representative_id: newC.id, plan_key: 'family_pro', member_limit: 8 });
  });

  it('create_family_group ignores p_plan_key: the new group gets the representative live family plan and limit; without a live family plan it raises FAMILY_PLAN_REQUIRED (billing/03 §6.6) and creates no group', async () => {
    const [withContract, withoutContract] = await Promise.all([
      createUser('create-with', { jwt: true }),
      createUser('create-without', { jwt: true }),
    ]);
    await apply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: withContract.id, planKey: 'family_basic' });

    const created = await createFamilyViaRpc(withContract, 'family_pro');
    expect(created).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });
    expect(await mustFamily(created.id)).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });

    const refused = await asUser(jwtOf(withoutContract)).rpc('create_family_group', { p_name: `billing ${RUN} ${++seq}`, p_plan_key: 'family_pro' });
    expect(refused.data).toBeNull();
    expect(refused.error).toMatchObject({ code: 'P0001', message: 'FAMILY_PLAN_REQUIRED' });
    const { data: groups, error: groupsError } = await srAdmin.from('family_groups').select('id').eq('representative_id', withoutContract.id);
    expect(groupsError).toBeNull();
    expect(groups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. 同時に走る処理 (行ロック・advisory lock・ロックの順)
// ---------------------------------------------------------------------------------------------

describe('billing/01 §6.4 (9) の 3.・(10)・§7.1: 同時に走る処理', () => {
  it('an apply that runs while a direct UPDATE (past_due → grace, or active → paused) holds the row waits for it and keeps grace with grace_started_at / paused; a direct UPDATE that waits for an apply re-evaluates its WHERE on the applied row', async () => {
    // (a) 配線の past_due → grace がコミット前のところへ、写像 (Stripe は past_due のまま) が来る
    const graceUser = await createUser('race-grace');
    const graceSub = nextSub();
    const graceBase = { sub: graceSub, customer: nextCustomer(), userId: graceUser.id, planKey: 'pro' };
    await apply({ ...graceBase, status: 'past_due' });
    const pastDue = await mustRow(graceSub);
    const graceHolder = startHolder(
      `UPDATE public.personal_subscriptions SET status = 'grace', grace_started_at = now() WHERE id = '${pastDue.id}'::uuid AND status = 'past_due';`,
      '',
    );
    await graceHolder.sleeping;
    const graceApply = tryApply({ ...graceBase, status: 'past_due' });
    await waitForLockWaiter('billing_apply_stripe_subscription');
    const [graceHeld, graceApplied] = await Promise.all([graceHolder.done, graceApply]);
    expect(graceHeld.ok).toBe(true);
    expect(graceApplied.error).toBeNull();
    expect(graceApplied.data).toMatchObject({ applied: true, status_from: 'grace', status_to: 'grace' });
    const graceRow = await mustRow(graceSub);
    expect(graceRow.status).toBe('grace');
    expect(graceRow.grace_started_at).not.toBeNull();
    expect(ms(graceRow.past_due_since)).toBe(ms(pastDue.past_due_since));

    // (a') 配線の active → paused がコミット前のところへ、写像 (Stripe は active + pause_collection) が来る
    const pausedUser = await createUser('race-paused');
    const pausedSub = nextSub();
    const pausedBase = { sub: pausedSub, customer: nextCustomer(), userId: pausedUser.id, planKey: 'pro' };
    await apply({ ...pausedBase, status: 'active' });
    const active = await mustRow(pausedSub);
    const pausedHolder = startHolder(
      `UPDATE public.personal_subscriptions SET status = 'paused', paused_at = now(), paused_until = now() + interval '${PERIOD_DAYS} days' WHERE id = '${active.id}'::uuid AND status = 'active';`,
      '',
    );
    await pausedHolder.sleeping;
    const pausedApply = tryApply({ ...pausedBase, status: 'active', pause: true });
    await waitForLockWaiter('billing_apply_stripe_subscription');
    const [pausedHeld, pausedApplied] = await Promise.all([pausedHolder.done, pausedApply]);
    expect(pausedHeld.ok).toBe(true);
    expect(pausedApplied.error).toBeNull();
    expect((await mustRow(pausedSub)).status).toBe('paused');

    // (b) 逆の順: 写像 (past_due → active) がコミット前のところへ、配線の past_due → grace が来る → WHERE が写像の書いた行で評価し直され 0 行
    const reverseUser = await createUser('race-reverse');
    const reverseSub = nextSub();
    const reverseBase = { sub: reverseSub, customer: nextCustomer(), userId: reverseUser.id, planKey: 'pro' };
    await apply({ ...reverseBase, status: 'past_due' });
    const reverseRow = await mustRow(reverseSub);
    const applyHolder = startHolder(`SELECT ${applySql({ ...reverseBase, status: 'active' }, nextFetchedAt())};`, '');
    await applyHolder.sleeping;
    const directUpdate = srAdmin
      .from('personal_subscriptions')
      .update({ status: 'grace', grace_started_at: new Date().toISOString() })
      .eq('id', reverseRow.id)
      .eq('status', 'past_due')
      .select('id');
    const directPromise = Promise.resolve(directUpdate);
    await waitForLockWaiter('personal_subscriptions');
    const [applyHeld, direct] = await Promise.all([applyHolder.done, directPromise]);
    expect(applyHeld.ok).toBe(true);
    expect(direct.error).toBeNull();
    expect(direct.data).toEqual([]);
    expect(await mustRow(reverseSub)).toMatchObject({ status: 'active', grace_started_at: null, past_due_since: null });
  });

  it('a representative change or group creation that runs while the new representative apply is in progress waits on the billing-user advisory lock and follows the committed contract', async () => {
    // 代表者の交代
    const [oldRep, newRep] = await Promise.all([createUser('lock-old'), createUser('lock-new')]);
    const familyId = await insertFamily(oldRep.id);
    const holder = startHolder(
      `SELECT ${applySql({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: newRep.id, planKey: 'family_basic' }, nextFetchedAt())};`,
      '',
    );
    await holder.sleeping;
    const change = Promise.resolve(
      srAdmin.from('family_groups').update({ representative_id: newRep.id }).eq('id', familyId).select('plan_key, member_limit'),
    );
    await waitForLockWaiter('family_groups', 'advisory');
    const [held, changed] = await Promise.all([holder.done, change]);
    expect(held.ok).toBe(true);
    expect(changed.error).toBeNull();
    expect(await mustFamily(familyId)).toMatchObject({ representative_id: newRep.id, plan_key: 'family_basic', member_limit: 4 });

    // グループの作成
    const creator = await createUser('lock-create');
    const createHolder = startHolder(
      `SELECT ${applySql({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: creator.id, planKey: 'family_pro' }, nextFetchedAt())};`,
      '',
    );
    await createHolder.sleeping;
    const insert = Promise.resolve(
      srAdmin.from('family_groups').insert({ name: `billing ${RUN} lock-create`, representative_id: creator.id }).select('id').single(),
    );
    await waitForLockWaiter('family_groups', 'advisory');
    const [createHeld, inserted] = await Promise.all([createHolder.done, insert]);
    expect(createHeld.ok).toBe(true);
    expect(inserted.error).toBeNull();
    expect(await mustFamily((inserted.data as { id: string }).id)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
  });

  it('the apply for a family-plan representative locks family_groups before user_profiles: with a connection that holds the family row (FOR NO KEY UPDATE) and then updates user_profiles by family_id like operator_force_dissolve_family, and with operator_force_dissolve_family / the representative DELETE of the group running while the apply transaction is held open, nothing fails with 40P01 and the group ends dissolved / deleted with plan_key_cached synced', async () => {
    // (a) 家族の行を持った接続 (強制解散と同じ順: family_groups → family_members → user_profiles) の途中に、写像が来る
    const repA = await createUser('order-a', { jwt: true });
    const familyA = await createFamilyViaRpcBeforeContract(repA);
    const holderA = startHolder(
      `SELECT 1 FROM public.family_groups WHERE id = '${familyA}'::uuid FOR NO KEY UPDATE;`,
      `UPDATE public.family_members SET status = 'left' WHERE family_id = '${familyA}'::uuid AND status = 'active';
       UPDATE public.user_profiles SET family_id = NULL WHERE family_id = '${familyA}'::uuid;
       UPDATE public.family_groups SET status = 'dissolved', dissolved_at = now() WHERE id = '${familyA}'::uuid;`,
    );
    await holderA.sleeping;
    const applyA = tryApply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: repA.id, planKey: 'family_basic' });
    await waitForLockWaiter('billing_apply_stripe_subscription');
    const [heldA, appliedA] = await Promise.all([holderA.done, applyA]);
    expectNoDeadlock(heldA, toOutcome(appliedA.error));
    expect(heldA.ok).toBe(true);
    expect(appliedA.error).toBeNull();
    expect((await mustFamily(familyA)).status).toBe('dissolved');
    expect(await planKeyCached(repA.id)).toBe('family_basic');

    // (b) 写像がコミット前のところへ、運営の強制解散が来る
    const repB = await createUser('order-b', { jwt: true });
    const familyB = await createFamilyViaRpcBeforeContract(repB);
    const holderB = startHolder(
      `SELECT ${applySql({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: repB.id, planKey: 'family_basic' }, nextFetchedAt())};`,
      '',
    );
    await holderB.sleeping;
    const dissolve = Promise.resolve(
      asUser(jwtOf(operator)).rpc('operator_force_dissolve_family', { p_family_id: familyB, p_reason: 'billing/01 test 106' }),
    );
    await waitForLockWaiter('operator_force_dissolve_family');
    const [heldB, dissolved] = await Promise.all([holderB.done, dissolve]);
    expectNoDeadlock(heldB, toOutcome(dissolved.error));
    expect(heldB.ok).toBe(true);
    expect(dissolved.error).toBeNull();
    expect((await mustFamily(familyB)).status).toBe('dissolved');
    expect(await planKeyCached(repB.id)).toBe('family_basic');

    // (b') 写像がコミット前のところへ、家族の行の削除が来る (#1917 から利用者は直接消せないので、purge と同じく service_role で消す)
    const repC = await createUser('order-c', { jwt: true });
    const familyC = await createFamilyViaRpcBeforeContract(repC);
    const holderC = startHolder(
      `SELECT ${applySql({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: repC.id, planKey: 'family_basic' }, nextFetchedAt())};`,
      '',
    );
    await holderC.sleeping;
    const deletion = Promise.resolve(srAdmin.from('family_groups').delete().eq('id', familyC).select('id'));
    await waitForLockWaiter('family_groups');
    const [heldC, deleted] = await Promise.all([holderC.done, deletion]);
    expectNoDeadlock(heldC, toOutcome(deleted.error));
    expect(heldC.ok).toBe(true);
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id: familyC }]);
    expect(await familyRow(familyC)).toBeNull();
    expect(await planKeyCached(repC.id)).toBe('family_basic');
  });
});
