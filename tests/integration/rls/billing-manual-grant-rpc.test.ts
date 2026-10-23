/**
 * billing/02 (手動のプラン付与) 段 A: DB 関数 billing_grant_manual_subscription / billing_revoke_manual_subscription /
 * billing_expire_manual_subscription_for_user / billing_manual_subscription_sync_after_end と、期限切れのプロシージャ
 * billing_expire_manual_subscriptions の結合テスト
 * (設計: docs/design/billing/02-manual-plan-grant.md §6・§13.2 の 39〜47・50〜54・57)
 *
 * 段 A のテストなので、段 B の src/lib/billing/* を import しない (§13.2 の冒頭)。写像に渡す p_snapshot は、関数の本体が
 * p_snapshot->>'…' で読むキーの JSON をこのファイルで組み、期待値はリテラルで書く。
 *
 * 競合の再現のしかた (47・57。tests/integration/rls/billing-apply-subscription-rpc.test.ts と同じ考え方):
 *   postgres-meta (/pg/query) で「先に処理を流し、放されるまでトランザクションを開いたままにする」接続を 1 本作り、
 *   pg_sleep に入ったのを pg_stat_activity で確かめてから、もう 1 件を呼ぶ。後の処理が先の接続に待たされてロックの待ちに入ったのを
 *   pg_stat_activity / pg_blocking_pids で確かめてから先の接続を放す (tests/integration/helpers/lock-holder.ts。
 *   決まった秒数の窓に頼らない。#1917)。
 *
 * 期限切れのプロシージャ (CALL) は、1 つの要求に 1 文だけで送る: 複数の文は 1 つのトランザクションのブロックになり、
 * プロシージャの COMMIT が 2D000 になる (§6.4・F26)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/billing-manual-grant-rpc.test.ts
 * 本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import ws from 'ws';
import { createLockHolderKit, type Holder } from '../helpers/lock-holder';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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
 * 使い回した最初の 1 回が 502 になる。データベースの結果ではないので、数回だけやり直す (billing-apply-subscription-rpc と同じ)
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

/** ローカルスタックの postgres-meta で SQL を実行する。502 の速い失敗だけやり直す */
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
  /** JWT が要るテスト (create_family_group・運営の JWT での EXECUTE の確認) だけサインインする */
  jwt: string | null;
}

const TS = Date.now();
const RUN = `${TS}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const SUB_PREFIX = `sub_it_mg_${RUN}_`;
const CUSTOMER_PREFIX = `cus_it_mg_${RUN}_`;
const createdUserIds: string[] = [];
const createdPlanKeys: string[] = [];
const createdCouponIds: string[] = [];
let seq = 0;

const nextSub = () => `${SUB_PREFIX}${++seq}`;
const nextCustomer = () => `${CUSTOMER_PREFIX}${++seq}`;

/** Stripe から取り直した時刻 (p_fetched_at)。呼ぶたびに進む */
const FETCHED_AT_BASE_MS = TS - 60 * 60 * 1000;
const FETCHED_AT_STEP_MS = 1000;
let fetchedSeq = 0;
const nextFetchedAt = () => new Date(FETCHED_AT_BASE_MS + ++fetchedSeq * FETCHED_AT_STEP_MS).toISOString();

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** 期限を「先」にするときの日数・「過去」にするときの時間。値そのものは関数の結果を見るための入力 */
const FUTURE_DAYS = 30;
const PAST_HOURS = 1;
/** 契約の期間の日数 (Stripe の写像に渡す入力) */
const PERIOD_DAYS = 30;
const iso = (offsetDays: number) => new Date(TS + offsetDays * DAY_MS).toISOString();
const ms = (value: string | null) => (value === null ? null : new Date(value).getTime());
const futureExpiry = () => new Date(Date.now() + FUTURE_DAYS * DAY_MS).toISOString();
const pastExpiry = () => new Date(Date.now() - PAST_HOURS * HOUR_MS).toISOString();

/** 写像の取り直しの時刻の許容 (starts_at / current_period_start が「いま」であることの確認。ミリ秒) */
const NOW_TOLERANCE_MS = 60_000;

const profileBase = { age_group: '30s', gender: 'other' };

/**
 * 利用者を作る。profile: false は auth.users だけを作り、user_profiles を作らない (プロフィール未作成の利用者。
 * このリポジトリの migration に、auth.users の INSERT でプロフィールを作るトリガーは無い)
 */
async function createUser(label: string, options: { jwt?: boolean; roles?: string[]; profile?: boolean } = {}): Promise<TestUser> {
  const email = `rls-billing-manual-${label}-${++seq}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (options.profile === false) return { id: data.user.id, email, jwt: null };
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert(
        { id: data.user.id, nickname: `manual-${label}`, ...profileBase, ...(options.roles ? { roles: options.roles } : {}) },
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
// 手動付与の関数
// ---------------------------------------------------------------------------------------------

interface RpcError {
  message: string;
  code: string;
  details: string | null;
}

interface RpcResult<T> {
  data: T | null;
  error: RpcError | null;
}

const toRpcError = (error: { message: string; code: string; details?: string | null } | null): RpcError | null =>
  error ? { message: error.message, code: error.code, details: error.details ?? null } : null;

interface GrantResult {
  subscription_id: string;
  user_id: string;
  plan_key: string;
  status: 'active';
  expires_at: string | null;
}

interface RevokeResult {
  subscription_id: string;
  user_id: string;
  plan_key: string;
  status_from: string;
  status_to: 'cancelled';
}

async function tryGrant(userId: string, planKey: string, expiresAt: string | null = null): Promise<RpcResult<GrantResult>> {
  const { data, error } = await srAdmin.rpc('billing_grant_manual_subscription', {
    p_user_id: userId,
    p_plan_key: planKey,
    p_expires_at: expiresAt,
  });
  return { data: (data as GrantResult | null) ?? null, error: toRpcError(error) };
}

async function grant(userId: string, planKey: string, expiresAt: string | null = null): Promise<GrantResult> {
  const { data, error } = await tryGrant(userId, planKey, expiresAt);
  if (error || !data) throw new Error(`billing_grant_manual_subscription: ${JSON.stringify(error)}`);
  return data;
}

async function tryRevoke(userId: string): Promise<RpcResult<RevokeResult>> {
  const { data, error } = await srAdmin.rpc('billing_revoke_manual_subscription', { p_user_id: userId });
  return { data: (data as RevokeResult | null) ?? null, error: toRpcError(error) };
}

async function tryExpireForUser(userId: string): Promise<RpcResult<number>> {
  const { data, error } = await srAdmin.rpc('billing_expire_manual_subscription_for_user', { p_user_id: userId });
  return { data: typeof data === 'number' ? data : null, error: toRpcError(error) };
}

async function expireForUser(userId: string): Promise<number> {
  const { data, error } = await tryExpireForUser(userId);
  if (error || data === null) throw new Error(`billing_expire_manual_subscription_for_user: ${JSON.stringify(error)}`);
  return data;
}

/** live の 5 値 (部分 UNIQUE idx_personal_subscriptions_active_per_user と同じ集合。利用者ごとに live な行は最大 1 行) */
const LIVE_STATUSES = ['trialing', 'active', 'paused', 'past_due', 'grace'];
/**
 * live のうち active 以外の 4 値。M 行は本冊の経路では active でしか生まれないが、service_role の直接の UPDATE で入っても
 * live として同じ扱い (§7.1)。付与・取り消し・期限切れの関数が status を一覧で見るので、4 値それぞれの行を setLiveStatus で用意して見る
 */
const NON_ACTIVE_LIVE_STATUSES = LIVE_STATUSES.filter((status) => status !== 'active');
/** SQL の IN (…) に書く live の一覧 */
const LIVE_STATUSES_SQL = LIVE_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * 期限を過ぎた状態にする (関数は p_expires_at が過去の付与を拒むので、付与のあとに postgres で current_period_end を書き換える)。
 * 対象はその利用者の live な M 行 (setLiveStatus で active 以外の live にした行も含む)
 */
async function makeDue(userId: string): Promise<void> {
  await pgQuery(
    `UPDATE public.personal_subscriptions SET current_period_end = now() - interval '${PAST_HOURS} hour'
      WHERE user_id = '${userId}'::uuid AND status IN (${LIVE_STATUSES_SQL}) AND stripe_subscription_id IS NULL;`,
  );
}

/**
 * 契約の行の status を postgres で live の別の値に書き換える (写像・本冊の関数の経路では作れない組み合わせを用意する)。
 * paused は paused_until が要る (ps_paused_until_required)
 */
async function setLiveStatus(rowId: string, status: string): Promise<void> {
  await pgQuery(
    `UPDATE public.personal_subscriptions
        SET status = '${status}',
            paused_until = CASE WHEN '${status}' = 'paused' THEN now() + interval '${FUTURE_DAYS} day' ELSE paused_until END
      WHERE id = '${rowId}'::uuid;`,
  );
}

/** makeCreatedLater が created_at を先へ動かす日数 (付与のトランザクションの now() より必ず後になる幅) */
const LATER_CREATED_DAYS = FUTURE_DAYS;

/**
 * 契約の行の created_at を先の時刻に書き換える。plan_key_cached の式 (§6.2 の 7.・§6.3 = 写像 (9) の 10. と同じ) は
 * ORDER BY s.created_at DESC で 1 行を選ぶ。created_at は行を作ったトランザクションの now() (= 開始の時刻) なので、
 * 付与が鍵を待つ間に、後から始まったトランザクションが先にコミットした行は、付与の行より created_at が後になる。その並びをこれで作る
 */
async function makeCreatedLater(rowId: string): Promise<void> {
  await pgQuery(
    `UPDATE public.personal_subscriptions SET created_at = now() + interval '${LATER_CREATED_DAYS} day' WHERE id = '${rowId}'::uuid;`,
  );
}

// ---------------------------------------------------------------------------------------------
// 写像 (billing_apply_stripe_subscription。S 行を作る)
// ---------------------------------------------------------------------------------------------

type StripeStatus = 'incomplete' | 'trialing' | 'active' | 'past_due' | 'canceled';

interface SnapshotInput {
  sub: string;
  customer: string;
  status: StripeStatus;
  userId: string;
  planKey: string;
}

/** 写像の p_snapshot (関数の本体が ->> で読むキー) */
function snapshot(input: SnapshotInput): Record<string, unknown> {
  return {
    stripe_subscription_id: input.sub,
    stripe_customer_id: input.customer,
    user_id: input.userId,
    plan_key: input.planKey,
    stripe_status: input.status,
    pause_collection: false,
    stripe_price_id: 'price_it_mg_monthly',
    billing_interval: 'month',
    start_date: iso(0),
    current_period_start: iso(0),
    current_period_end: iso(PERIOD_DAYS),
    trial_start: null,
    trial_end: null,
    cancel_at: null,
    cancel_at_period_end: false,
    ended_at: input.status === 'canceled' ? iso(0) : null,
    canceled_at: input.status === 'canceled' ? iso(0) : null,
  };
}

async function tryApply(input: SnapshotInput, fetchedAt: string = nextFetchedAt()): Promise<RpcResult<Record<string, unknown>>> {
  const { data, error } = await srAdmin.rpc('billing_apply_stripe_subscription', {
    p_snapshot: snapshot(input),
    p_fetched_at: fetchedAt,
    p_source: 'webhook:evt_it_mg',
  });
  return { data: (data as Record<string, unknown> | null) ?? null, error: toRpcError(error) };
}

async function apply(input: SnapshotInput): Promise<Record<string, unknown>> {
  const { data, error } = await tryApply(input);
  if (error || !data) throw new Error(`billing_apply_stripe_subscription: ${JSON.stringify(error)}`);
  return data;
}

/** 写像を呼ぶ SQL の式 (postgres-meta の接続で流すとき) */
const applySql = (input: SnapshotInput, fetchedAt: string) =>
  `public.billing_apply_stripe_subscription('${JSON.stringify(snapshot(input))}'::jsonb, '${fetchedAt}'::timestamptz, 'test:hold')`;

/** 付与を呼ぶ SQL の式 (postgres-meta の接続で流すとき) */
const grantSql = (userId: string, planKey: string) =>
  `public.billing_grant_manual_subscription('${userId}'::uuid, '${planKey}', NULL)`;

// ---------------------------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------------------------

interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_key: string;
  status: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  stripe_status: string | null;
  billing_interval: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  starts_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  notes: string | null;
  active_coupon_redemption_id: string | null;
}

const SUBSCRIPTION_COLUMNS =
  'id, user_id, plan_key, status, stripe_subscription_id, stripe_customer_id, stripe_price_id, stripe_status, billing_interval, trial_started_at, trial_ends_at, starts_at, current_period_start, current_period_end, cancel_at, cancel_at_period_end, cancelled_at, notes, active_coupon_redemption_id';

async function rowsOf(userId: string): Promise<SubscriptionRow[]> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .select(SUBSCRIPTION_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`personal_subscriptions: ${error.message}`);
  return (data ?? []) as SubscriptionRow[];
}

async function mustRowById(id: string): Promise<SubscriptionRow> {
  const { data, error } = await srAdmin.from('personal_subscriptions').select(SUBSCRIPTION_COLUMNS).eq('id', id).single();
  if (error || !data) throw new Error(`契約の行が無い: ${id} ${error?.message}`);
  return data as SubscriptionRow;
}

const liveRowsOf = async (userId: string): Promise<SubscriptionRow[]> => (await rowsOf(userId)).filter((r) => LIVE_STATUSES.includes(r.status));

async function planKeyCached(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('plan_key_cached').eq('id', userId).single();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return (data as { plan_key_cached: string | null }).plan_key_cached;
}

async function effectivePlan(userId: string): Promise<string> {
  const { data, error } = await srAdmin.rpc('get_effective_plan', { p_user_id: userId });
  if (error) throw new Error(`get_effective_plan: ${error.message}`);
  return data as string;
}

interface AuditRow {
  action_type: string;
  actor_id: string | null;
  target_id: string | null;
  target_type: string | null;
  severity: string;
  details: Record<string, unknown>;
}

async function auditsOf(userId: string, like: string): Promise<AuditRow[]> {
  const { data, error } = await srAdmin
    .from('admin_audit_logs')
    .select('action_type, actor_id, target_id, target_type, severity, details, created_at')
    .eq('target_id', userId)
    .like('action_type', like)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`admin_audit_logs: ${error.message}`);
  return (data ?? []) as AuditRow[];
}

// ---------------------------------------------------------------------------------------------
// ほかの利用者 (付与・取り消し・期限切れの対象でない人)
// ---------------------------------------------------------------------------------------------

/** ほかの利用者の live な S 行のプラン (対象に付与する最初のプラン family_pro と違う値にして、全員の書き換えを見分ける) */
const OTHER_USER_PLAN = 'family_basic';

/**
 * 付与・取り消し・期限切れの書き込みが、対象の利用者 1 人分に絞られていることを見るための 2 人。
 *   idle: 契約の行が無い (plan_key_cached は NULL)
 *   subscriber: live な S 行 (OTHER_USER_PLAN) を持つ (plan_key_cached は OTHER_USER_PLAN)。その行の created_at は先の時刻 (makeCreatedLater)
 */
interface OtherUsers {
  idle: TestUser;
  subscriber: TestUser;
  subscriberRowId: string;
}

/**
 * ほかの利用者が、用意したときのまま (plan_key_cached・契約の行) であることを見る。
 * UPDATE の WHERE が対象の利用者以外の行にも当たる (条件の誤り・常に真の条件) と、この断言で見分けるもの:
 *   user_profiles の UPDATE (付与・同期。WHERE p.id = p_user_id) → 全員の plan_key_cached が対象と同じ値に書き換わる
 *     (付与では idle が NULL でなくなり、取り消し・期限切れの同期では subscriber が OTHER_USER_PLAN でなくなる)
 *   契約の行の UPDATE (取り消し・1 人分の期限切れ。WHERE id = v_row.id) → 全員の行が cancelled / expired になる (subscriber の S 行)
 * (WHERE そのものを消した UPDATE は、ローカルの Supabase では PostgREST の接続で 21000 (UPDATE requires a WHERE clause) になり、
 *  関数の呼び出しが失敗する。全員に当たる WHERE はそこを通るので、この断言で見る)
 */
async function expectOtherUsersUntouched(others: OtherUsers, label: string): Promise<void> {
  expect(await planKeyCached(others.idle.id), `${label}: idle の plan_key_cached`).toBeNull();
  expect(await rowsOf(others.idle.id), `${label}: idle の契約の行`).toEqual([]);
  expect(await planKeyCached(others.subscriber.id), `${label}: subscriber の plan_key_cached`).toBe(OTHER_USER_PLAN);
  expect(await mustRowById(others.subscriberRowId), `${label}: subscriber の S 行`).toMatchObject({
    user_id: others.subscriber.id,
    plan_key: OTHER_USER_PLAN,
    status: 'active',
    cancelled_at: null,
  });
}

/**
 * ほかの利用者を用意する。subscriber の S 行の created_at を先の時刻にしておくと、plan_key_cached の式の SELECT から
 * s.user_id = p_user_id を外す変異では、どの利用者のキャッシュもこの行のプラン (OTHER_USER_PLAN) になる (いちばん新しい live な行)
 */
async function prepareOtherUsers(label: string): Promise<OtherUsers> {
  const idle = await createUser(`${label}-idle`);
  const subscriber = await createUser(`${label}-subscriber`);
  await apply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: subscriber.id, planKey: OTHER_USER_PLAN });
  const [row, ...rest] = await liveRowsOf(subscriber.id);
  expect(rest).toEqual([]);
  await makeCreatedLater(row.id);
  const others: OtherUsers = { idle, subscriber, subscriberRowId: row.id };
  await expectOtherUsersUntouched(others, `${label}: 用意`);
  return others;
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

async function mustFamily(id: string): Promise<FamilyRow> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .select('plan_key, member_limit, status, representative_id')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`family_groups: ${error?.message}`);
  return data as FamilyRow;
}

/** service_role で家族のグループを直接作る (作成のトリガーが代表者の契約から plan_key を決める) */
async function insertFamily(representativeId: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .insert({ name: `manual ${RUN} ${++seq}`, representative_id: representativeId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`family_groups insert: ${error?.message}`);
  return (data as { id: string }).id;
}

/** 代表者として家族を作る (RPC。代表者の active なメンバー行と user_profiles.family_id も作る) */
async function createFamilyViaRpc(rep: TestUser): Promise<{ id: string; plan_key: string; member_limit: number }> {
  const { data, error } = await asUser(jwtOf(rep)).rpc('create_family_group', {
    p_name: `manual ${RUN} ${++seq}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group: ${error?.message}`);
  return data as { id: string; plan_key: string; member_limit: number };
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (postgres-meta)
// ---------------------------------------------------------------------------------------------

interface Outcome {
  ok: boolean;
  message: string | null;
  code: string | null;
}

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'manual-grant' });

/** postgres-meta の接続で before を実行し、放されるまで開いておいてから after を実行して、コミットする */
function startHolder(before: string, after: string): Holder {
  return holders.startHolder('先の処理を開いておく接続', before, after);
}

/**
 * 後の処理 (queryLike を含む SQL の接続) が holder に待たされてロックの待ち (wait_event_type = 'Lock') に入ったのを確かめてから
 * holder を放す。waitEvent を渡すと、その待ちの種類 (advisory / transactionid / tuple) に絞る
 */
async function releaseAfterWaiter(holder: Holder, queryLike: string, waitEvent?: string): Promise<void> {
  await holders.waitForLockWaiters(queryLike, 1, { step: `${queryLike} の接続が ${holder.label} の commit を待つ`, blockedBy: holder, waitEvent });
  await holder.release();
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
// プランの用意・クーポン
// ---------------------------------------------------------------------------------------------

/** 試験で作るプランの月額 (円) と版。値そのものは付与の関数の結果に関わらない */
const TEST_PLAN_MONTHLY_PRICE_JPY = 100;
const TEST_PLAN_VERSION = 1;

/** status が public でないプランを作る (draft / deprecated)。plan_type は personal */
async function createPlan(status: 'draft' | 'deprecated'): Promise<string> {
  const planKey = `it_mg_${status}_${++seq}_${TS}`;
  const { error } = await srAdmin.from('subscription_plans').insert({
    plan_key: planKey,
    display_name: `manual grant ${status} ${TS}`,
    plan_type: 'personal',
    status,
    monthly_price_jpy: TEST_PLAN_MONTHLY_PRICE_JPY,
    version: TEST_PLAN_VERSION,
  });
  if (error) throw new Error(`subscription_plans insert (${status}): ${error.message}`);
  createdPlanKeys.push(planKey);
  return planKey;
}

/** family_groups_member_limit_check の上限 (1〜20) と、member_limit の DDL の既定値 (付与の丸め・既定の期待値) */
const MEMBER_LIMIT_CAP = 20;
const MEMBER_LIMIT_DEFAULT = 4;
/** 上限 (MEMBER_LIMIT_CAP) を超える max_members。プラン管理の入力 (plans-schemas の max_members) に上限が無いので作れる */
const MAX_MEMBERS_OVER_CAP = 25;

/** observeRolledBack の DO ブロックが最後に RAISE する印 (観測した値の JSON を運ぶ) */
const ROLLED_BACK_MARKER = 'MG_ROLLED_BACK';

/**
 * postgres-meta の 1 回の要求で DO ブロックを流し、ブロックが観測した値 (jsonb) を例外の文で持ち帰る。
 * ブロックは最後に RAISE EXCEPTION '<ROLLED_BACK_MARKER> %', <jsonb>::text; で終わるので、中の INSERT・付与・取り消しは
 * すべてロールバックされる。一時的な public の family プランは一度もコミットされないので、途中で落ちて afterAll の掃除が
 * 走らなくても、公開プランの一覧を見るほかの結合テストに残らない。
 * 印の無い失敗 (途中の例外。例: member_limit の CHECK の 23514) は、その文のまま投げる
 */
async function observeRolledBack(declarations: string, statements: string): Promise<Record<string, unknown>> {
  const res = await pgRequest(`DO $observe$
    DECLARE
      v_out jsonb := '{}'::jsonb;
      ${declarations}
    BEGIN
      ${statements}
      RAISE EXCEPTION '${ROLLED_BACK_MARKER} %', v_out::text;
    END
    $observe$;`);
  const body = res.body as { error?: unknown } | null;
  const message = typeof body?.error === 'string' ? body.error : JSON.stringify(body);
  const match = new RegExp(`${ROLLED_BACK_MARKER} (\\{[^\\n]*\\})`).exec(message);
  if (res.ok || !match) throw new Error(`DO ブロックが観測の印で終わらなかった (${res.status}): ${message}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/** 承認者 (coupons.created_by / coupon_redemptions.approved_by) */
let approver: TestUser;
/** 運営 (admin JWT)。EXECUTE が付いていないことの確認に使う */
let operator: TestUser;

async function applyCoupon(subscriptionId: string): Promise<string> {
  const code = `IT-MG-${TS}-${++seq}`;
  const { data: coupon, error } = await srAdmin
    .from('coupons')
    .insert({
      code,
      display_name: `manual grant ${code}`,
      discount_type: 'fixed',
      discount_value: 300,
      applicable_to: 'all',
      applicable_plans: [],
      valid_from: new Date(Date.now() - DAY_MS).toISOString(),
      valid_until: new Date(Date.now() + FUTURE_DAYS * DAY_MS).toISOString(),
      max_uses: null,
      per_user_limit: 1,
      duration_months: null,
      status: 'active',
      created_by: approver.id,
    })
    .select('id')
    .single();
  if (error || !coupon) throw new Error(`coupons insert: ${error?.message}`);
  createdCouponIds.push((coupon as { id: string }).id);
  const res = await srAdmin.rpc('apply_coupon', {
    p_coupon_id: (coupon as { id: string }).id,
    p_target: 'personal',
    p_subscription_id: subscriptionId,
    p_approved_by: approver.id,
  });
  if (res.error) throw new Error(`apply_coupon: ${res.error.message}`);
  const row = await mustRowById(subscriptionId);
  if (!row.active_coupon_redemption_id) throw new Error('apply_coupon が active_coupon_redemption_id を書かなかった');
  return row.active_coupon_redemption_id;
}

beforeAll(async () => {
  approver = await createUser('approver');
  operator = await createUser('operator', { jwt: true, roles: ['user', 'super_admin'] });
}, 60_000);

// テストが途中で落ちたときに残った接続を、作った順に放す (通ったテストでは全部放し終わっているので何もしない)
afterEach(() => holders.releaseOpenHolders());

afterAll(async () => {
  await holders.settle();
  if (createdUserIds.length > 0) {
    const { data: families } = await srAdmin.from('family_groups').select('id').in('representative_id', createdUserIds);
    const familyIds = ((families ?? []) as Array<{ id: string }>).map((f) => f.id);
    if (familyIds.length > 0) {
      await srAdmin.from('membership_audit').delete().in('scope_id', familyIds);
      await srAdmin.from('family_groups').delete().in('id', familyIds);
    }
    await srAdmin.from('admin_audit_logs').delete().in('target_id', createdUserIds);
    // 契約は active_coupon_redemption_id で redemption を参照するので、redemption より先に消す
    await srAdmin.from('personal_subscriptions').delete().in('user_id', createdUserIds);
  }
  if (createdCouponIds.length > 0) {
    await srAdmin.from('coupon_redemptions').delete().in('coupon_id', createdCouponIds);
    await srAdmin.from('coupons').delete().in('id', createdCouponIds);
  }
  await srAdmin.from('billing_customers').delete().like('stripe_customer_id', `${CUSTOMER_PREFIX}%`);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
  if (createdPlanKeys.length > 0) {
    await srAdmin.from('subscription_plans').delete().in('plan_key', createdPlanKeys);
  }
}, 180_000);

// ---------------------------------------------------------------------------------------------
// 1. 付与
// ---------------------------------------------------------------------------------------------

describe('billing/02 §6.2: 付与 billing_grant_manual_subscription', () => {
  // 39
  it('grant inserts an active row with stripe_subscription_id NULL, starts_at/current_period_start now, current_period_end = p_expires_at (or NULL) and sets plan_key_cached', async () => {
    const withExpiry = await createUser('grant-expiry');
    const expiresAt = futureExpiry();
    const result = await grant(withExpiry.id, 'pro', expiresAt);
    const [row, ...others] = await rowsOf(withExpiry.id);
    expect(others).toEqual([]);
    expect(result).toEqual({
      subscription_id: row.id,
      user_id: withExpiry.id,
      plan_key: 'pro',
      status: 'active',
      expires_at: expect.any(String),
    });
    expect(ms(result.expires_at)).toBe(ms(expiresAt));
    expect(row).toMatchObject({
      user_id: withExpiry.id,
      plan_key: 'pro',
      status: 'active',
      stripe_subscription_id: null,
      stripe_customer_id: null,
      stripe_price_id: null,
      stripe_status: null,
      billing_interval: null,
      trial_started_at: null,
      trial_ends_at: null,
      cancel_at: null,
      cancel_at_period_end: false,
      cancelled_at: null,
      notes: null,
      active_coupon_redemption_id: null,
    });
    expect(ms(row.current_period_end)).toBe(ms(expiresAt));
    // starts_at と current_period_start は同じ now() (同じトランザクション)
    expect(row.starts_at).not.toBeNull();
    expect(ms(row.starts_at)).toBe(ms(row.current_period_start));
    expect(Math.abs((ms(row.starts_at) ?? 0) - Date.now())).toBeLessThan(NOW_TOLERANCE_MS);
    expect(await planKeyCached(withExpiry.id)).toBe('pro');

    // 期限なし (NULL) は current_period_end も NULL
    const noExpiry = await createUser('grant-no-expiry');
    const noExpiryResult = await grant(noExpiry.id, 'pro');
    expect(noExpiryResult.expires_at).toBeNull();
    const [noExpiryRow] = await rowsOf(noExpiry.id);
    expect(noExpiryRow).toMatchObject({ status: 'active', stripe_subscription_id: null, current_period_end: null });
    expect(await planKeyCached(noExpiry.id)).toBe('pro');

    // plan_key_cached は、この利用者の live な行だけから決める (§6.2 の 7.)。同じ利用者の非 live な行 (incomplete の S 行) の
    // created_at が付与の行より後のとき (makeCreatedLater の注記の並び)、live の条件を外すとキャッシュがその行のプラン (family_basic) になる
    const laterIncomplete = await createUser('grant-later-incomplete');
    await apply({ sub: nextSub(), customer: nextCustomer(), status: 'incomplete', userId: laterIncomplete.id, planKey: 'family_basic' });
    const [incompleteRow, ...moreRows] = await rowsOf(laterIncomplete.id);
    expect(moreRows).toEqual([]);
    expect(incompleteRow.status).toBe('incomplete');
    expect(await planKeyCached(laterIncomplete.id)).toBeNull();
    await makeCreatedLater(incompleteRow.id);
    await grant(laterIncomplete.id, 'pro');
    expect(await planKeyCached(laterIncomplete.id)).toBe('pro');

    // 引数の不足は 22023 (業務エラーではない)。利用者・プラン (NULL と空文字) のどれが欠けても同じで、行は書かれない。
    // 入口の検査を外すと、NULL は後の業務エラーの DETAIL が NULL になって 22004、空文字は BILL_PLAN_NOT_GRANTABLE (P0001) になるので、
    // コードで区別できる
    const missingArgsUser = await createUser('grant-missing-args');
    const missingArgs: Array<[string, Record<string, unknown>]> = [
      ['p_user_id NULL', { p_user_id: null, p_plan_key: 'pro', p_expires_at: null }],
      ['p_plan_key NULL', { p_user_id: missingArgsUser.id, p_plan_key: null, p_expires_at: null }],
      ['p_plan_key empty', { p_user_id: missingArgsUser.id, p_plan_key: '', p_expires_at: null }],
    ];
    for (const [label, params] of missingArgs) {
      const missing = await srAdmin.rpc('billing_grant_manual_subscription', params);
      expect(missing.data, label).toBeNull();
      expect(missing.error?.code, label).toBe('22023');
    }
    expect(await rowsOf(missingArgsUser.id)).toEqual([]);
    expect(await planKeyCached(missingArgsUser.id)).toBeNull();
  });

  // 40
  it('grant raises BILL_LIVE_ROW_CONFLICT when a live stripe-backed row or a live manual row exists, and BILL_PLAN_NOT_GRANTABLE for free / org / private (family_addon) / draft / deprecated / unknown, and BILL_UNKNOWN_USER for a missing user, and BILL_MANUAL_EXPIRES_AT_PAST for a past expiry', async () => {
    // live な S 行
    const stripeUser = await createUser('conflict-stripe');
    await apply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: stripeUser.id, planKey: 'pro' });
    const [stripeRow] = await liveRowsOf(stripeUser.id);
    const onStripe = await tryGrant(stripeUser.id, 'family_basic');
    expect(onStripe.data).toBeNull();
    expect(onStripe.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT', details: stripeRow.id });
    expect(await rowsOf(stripeUser.id)).toHaveLength(1);
    // live の 5 値 (trialing / active / paused / past_due / grace。部分 UNIQUE idx_personal_subscriptions_active_per_user と同じ集合) の
    // どれでも衝突する。どれかが衝突の検査から抜けると、業務エラーとして名指しされず、INSERT が部分 UNIQUE の違反 (23505) になる。
    // active 以外は、同じ S 行の status を postgres で書き換えて用意する (setLiveStatus。paused は paused_until も入れる)
    for (const status of NON_ACTIVE_LIVE_STATUSES) {
      await setLiveStatus(stripeRow.id, status);
      expect((await mustRowById(stripeRow.id)).status, status).toBe(status);
      const onLive = await tryGrant(stripeUser.id, 'family_basic');
      expect(onLive.data, status).toBeNull();
      expect(onLive.error, status).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT', details: stripeRow.id });
    }
    expect(await rowsOf(stripeUser.id)).toHaveLength(1);

    // live な M 行 (同じプランでも別のプランでも)
    const manualUser = await createUser('conflict-manual');
    const first = await grant(manualUser.id, 'pro');
    for (const planKey of ['pro', 'family_basic']) {
      const again = await tryGrant(manualUser.id, planKey);
      expect(again.data, planKey).toBeNull();
      expect(again.error, planKey).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT', details: first.subscription_id });
    }
    expect(await rowsOf(manualUser.id)).toHaveLength(1);

    // 付与できないプラン (何も書かれない)
    const planUser = await createUser('not-grantable');
    const draftPlan = await createPlan('draft');
    const deprecatedPlan = await createPlan('deprecated');
    for (const planKey of ['free', 'org_standard', 'family_addon', draftPlan, deprecatedPlan, `no_such_plan_${TS}`]) {
      const res = await tryGrant(planUser.id, planKey);
      expect(res.data, planKey).toBeNull();
      expect(res.error, planKey).toMatchObject({ code: 'P0001', message: 'BILL_PLAN_NOT_GRANTABLE', details: planKey });
    }
    expect(await rowsOf(planUser.id)).toEqual([]);
    expect(await planKeyCached(planUser.id)).toBeNull();

    // 利用者が無い
    const missingId = randomUUID();
    const unknown = await tryGrant(missingId, 'pro');
    expect(unknown.error).toMatchObject({ code: 'P0001', message: 'BILL_UNKNOWN_USER', details: missingId });
    // auth.users にはいるがプロフィールが無い利用者も BILL_UNKNOWN_USER (§6.2 の 1.。personal_subscriptions.user_id の FK は auth.users
    // なので、プロフィールの検査が抜けると行が INSERT されてしまう)
    const noProfile = await createUser('no-profile', { profile: false });
    const { data: noProfileRows, error: noProfileReadError } = await srAdmin.from('user_profiles').select('id').eq('id', noProfile.id);
    expect(noProfileReadError).toBeNull();
    expect(noProfileRows).toEqual([]);
    const onNoProfile = await tryGrant(noProfile.id, 'pro');
    expect(onNoProfile.data).toBeNull();
    expect(onNoProfile.error).toMatchObject({ code: 'P0001', message: 'BILL_UNKNOWN_USER', details: noProfile.id });
    expect(await rowsOf(noProfile.id)).toEqual([]);

    // 過去の期限 (now() 以前)
    const pastUser = await createUser('past-expiry');
    const past = await tryGrant(pastUser.id, 'pro', pastExpiry());
    expect(past.data).toBeNull();
    expect(past.error).toMatchObject({ code: 'P0001', message: 'BILL_MANUAL_EXPIRES_AT_PAST' });
    expect(await rowsOf(pastUser.id)).toEqual([]);
    expect(await planKeyCached(pastUser.id)).toBeNull();
  });

  // 41
  it('grant with a family plan sets the representative active group plan_key/member_limit (LEAST(max_members,20)); revoke reverts to free/4 only when no other live row has that plan; a non-representative grant touches no group; a group of the user whose status is dissolved (set by service_role) keeps its plan_key/member_limit through grant and revoke', async () => {
    // 付与・取り消し・期限切れの書き込みは対象の利用者 1 人分だけ (§6.2 の 7.・§6.3・§6.4。写像 (9) の 10. と同じ式)。
    // ほかの利用者 2 人 (契約なし・live な S 行あり) を先に用意し、このテストの付与・取り消し・期限切れの後で、用意したときのままであることを見る。
    // 鍵や行のロックは利用者 1 人分しか取らないので、全員の行を書き換えると、ほかの利用者の処理と直列にならないまま他人の権利を変える
    const others = await prepareOtherUsers('family-others');

    // 代表者: family_pro (max_members 8) → グループは family_pro / 8。取り消しで free / 4
    const rep = await createUser('family-rep');
    const familyId = await insertFamily(rep.id);
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'free', member_limit: 4 });
    await grant(rep.id, 'family_pro');
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
    // キャッシュは rep の live な行から決まる (subscriber の S 行のほうが created_at は後でも、そのプランにならない)
    expect(await planKeyCached(rep.id)).toBe('family_pro');
    await expectOtherUsersUntouched(others, '付与の後');
    const revoked = await tryRevoke(rep.id);
    expect(revoked.error).toBeNull();
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'free', member_limit: 4 });
    // 取り消しの同期も rep の live な行だけから決める (ほかの利用者の live な行があっても NULL)
    expect(await planKeyCached(rep.id)).toBeNull();
    await expectOtherUsersUntouched(others, '取り消しの後');

    // family_basic (max_members 4) → 4。ほかの経路で入ったプランは取り消しで触らない
    await grant(rep.id, 'family_basic');
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });
    const { error: viaOtherPath } = await srAdmin.from('family_groups').update({ plan_key: 'family_pro', member_limit: 8 }).eq('id', familyId);
    expect(viaOtherPath).toBeNull();
    await tryRevoke(rep.id);
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });

    // member_limit = LEAST(COALESCE(max_members, 4), 20): 上限を超える max_members は 20 に丸め、max_members の無いプランは 4。
    // seed の family プラン (4・8) では丸めも既定も効かないので、max_members が 25 と NULL の public な family プランを作って付与する。
    // 公開プランの一覧を見るほかの結合テストに残さないよう、プランの作成から付与・取り消しまでを 1 つの DO ブロックで流してロールバックする
    const capRep = await createUser('family-cap');
    const capFamily = await insertFamily(capRep.id);
    const overCapPlan = `it_mg_family_over_cap_${++seq}_${TS}`;
    const noMaxPlan = `it_mg_family_no_max_${++seq}_${TS}`;
    const groupOf = `(SELECT jsonb_build_object('plan_key', g.plan_key, 'member_limit', g.member_limit) FROM public.family_groups AS g WHERE g.id = v_family)`;
    const observed = await observeRolledBack(
      `v_rep uuid := '${capRep.id}'::uuid;
       v_family uuid := '${capFamily}'::uuid;`,
      `INSERT INTO public.subscription_plans (plan_key, display_name, plan_type, status, monthly_price_jpy, version, max_members)
       VALUES ('${overCapPlan}', 'manual grant over cap ${TS}', 'family', 'public', ${TEST_PLAN_MONTHLY_PRICE_JPY}, ${TEST_PLAN_VERSION}, ${MAX_MEMBERS_OVER_CAP}),
              ('${noMaxPlan}', 'manual grant no max ${TS}', 'family', 'public', ${TEST_PLAN_MONTHLY_PRICE_JPY}, ${TEST_PLAN_VERSION}, NULL);
       PERFORM public.billing_grant_manual_subscription(v_rep, '${overCapPlan}', NULL);
       v_out := v_out || jsonb_build_object('overCap', ${groupOf});
       PERFORM public.billing_revoke_manual_subscription(v_rep);
       v_out := v_out || jsonb_build_object('overCapRevoked', ${groupOf});
       PERFORM public.billing_grant_manual_subscription(v_rep, '${noMaxPlan}', NULL);
       v_out := v_out || jsonb_build_object('noMax', ${groupOf});
       PERFORM public.billing_revoke_manual_subscription(v_rep);
       v_out := v_out || jsonb_build_object('noMaxRevoked', ${groupOf});`,
    );
    expect(observed).toEqual({
      overCap: { plan_key: overCapPlan, member_limit: MEMBER_LIMIT_CAP },
      overCapRevoked: { plan_key: 'free', member_limit: MEMBER_LIMIT_DEFAULT },
      noMax: { plan_key: noMaxPlan, member_limit: MEMBER_LIMIT_DEFAULT },
      noMaxRevoked: { plan_key: 'free', member_limit: MEMBER_LIMIT_DEFAULT },
    });
    // ロールバックされている (プランも契約の行も残らず、グループは作ったときの free / 4 のまま)
    const { data: leftoverPlans, error: leftoverError } = await srAdmin
      .from('subscription_plans')
      .select('plan_key')
      .in('plan_key', [overCapPlan, noMaxPlan]);
    expect(leftoverError).toBeNull();
    expect(leftoverPlans).toEqual([]);
    expect(await rowsOf(capRep.id)).toEqual([]);
    expect(await mustFamily(capFamily)).toMatchObject({ status: 'active', plan_key: 'free', member_limit: MEMBER_LIMIT_DEFAULT });

    // 個人プラン (pro) の付与・取り消し・期限切れは、代表者の active なグループに触れない (§6.2 の 6. は「家族プランなら」。
    // §7.3 の付与の行も家族プランのときだけグループを合わせる)
    const personalRep = await createUser('family-personal-rep');
    const personalFamily = await insertFamily(personalRep.id);
    await grant(personalRep.id, 'pro');
    expect(await mustFamily(personalFamily)).toMatchObject({ status: 'active', plan_key: 'free', member_limit: 4 });
    expect(await planKeyCached(personalRep.id)).toBe('pro');
    expect((await tryRevoke(personalRep.id)).error).toBeNull();
    expect(await mustFamily(personalFamily)).toMatchObject({ status: 'active', plan_key: 'free', member_limit: 4 });
    await grant(personalRep.id, 'pro', futureExpiry());
    await makeDue(personalRep.id);
    expect(await expireForUser(personalRep.id)).toBe(1);
    expect(await mustFamily(personalFamily)).toMatchObject({ status: 'active', plan_key: 'free', member_limit: 4 });
    // 1 人分の期限切れも、ほかの利用者の行・キャッシュに触れない (契約の行の UPDATE は鍵の後で読んだ 1 行だけ・同期は personalRep だけ)
    expect(await planKeyCached(personalRep.id)).toBeNull();
    await expectOtherUsersUntouched(others, '期限切れの後');
    // 取り消し・期限切れの同期も家族プランのときだけ (§6.3)。グループが free のままだと、同期の条件 (plan_type = 'family') を外しても
    // g.plan_key = 'pro' の行が無く結果が変わらない。ほかの経路 (service_role) でグループを pro / 4 にしておき、条件が効いていることを見る
    const { error: personalPlanError } = await srAdmin
      .from('family_groups')
      .update({ plan_key: 'pro', member_limit: MEMBER_LIMIT_DEFAULT })
      .eq('id', personalFamily);
    expect(personalPlanError).toBeNull();
    await grant(personalRep.id, 'pro');
    expect((await tryRevoke(personalRep.id)).error).toBeNull();
    expect(await mustFamily(personalFamily)).toMatchObject({ status: 'active', plan_key: 'pro', member_limit: 4 });
    await grant(personalRep.id, 'pro', futureExpiry());
    await makeDue(personalRep.id);
    expect(await expireForUser(personalRep.id)).toBe(1);
    expect(await mustFamily(personalFamily)).toMatchObject({ status: 'active', plan_key: 'pro', member_limit: 4 });
    expect(await planKeyCached(personalRep.id)).toBeNull();

    // 同じ利用者に同じプランの live な行があるときは戻さない (内部の同期を postgres で直接呼ぶ。部分 UNIQUE で live は 1 行)
    const keeper = await createUser('family-keeper');
    const keeperFamily = await insertFamily(keeper.id);
    await grant(keeper.id, 'family_pro');
    expect(await mustFamily(keeperFamily)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
    await pgQuery(`SELECT public.billing_manual_subscription_sync_after_end('${keeper.id}'::uuid, 'family_pro');`);
    expect(await mustFamily(keeperFamily)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
    expect(await planKeyCached(keeper.id)).toBe('family_pro');

    // 戻さない条件の live な行は「同じ利用者」の「同じプラン」のものだけ:
    // (1) ほかの利用者 (keeper) が family_pro の live な行を持っていても、rep2 の取り消しで rep2 のグループは free / 4 に戻る
    const rep2 = await createUser('family-rep2');
    const rep2Family = await insertFamily(rep2.id);
    await grant(rep2.id, 'family_pro');
    expect(await mustFamily(rep2Family)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
    expect((await liveRowsOf(keeper.id)).map((r) => r.plan_key)).toEqual(['family_pro']);
    expect((await tryRevoke(rep2.id)).error).toBeNull();
    expect(await mustFamily(rep2Family)).toMatchObject({ status: 'active', plan_key: 'free', member_limit: 4 });
    // (2) 同じ利用者の別のプラン (pro) の live な行は数えない。公開の経路では終わった行のほかに live な行は無い
    //     (部分 UNIQUE で live は 1 行) ので、keeper と同じく内部の同期を postgres で直接呼ぶ。グループはほかの経路で family_basic / 4 にしておく
    await grant(rep2.id, 'pro');
    const { error: rep2PlanError } = await srAdmin
      .from('family_groups')
      .update({ plan_key: 'family_basic', member_limit: MEMBER_LIMIT_DEFAULT })
      .eq('id', rep2Family);
    expect(rep2PlanError).toBeNull();
    await pgQuery(`SELECT public.billing_manual_subscription_sync_after_end('${rep2.id}'::uuid, 'family_basic');`);
    expect(await mustFamily(rep2Family)).toMatchObject({ status: 'active', plan_key: 'free', member_limit: 4 });
    expect(await planKeyCached(rep2.id)).toBe('pro');

    // 代表者でない利用者の付与・取り消し・期限切れは、どのグループにも触れない
    const outsider = await createUser('family-outsider');
    const bystanderRep = await createUser('family-bystander');
    const bystanderFamily = await insertFamily(bystanderRep.id);
    await grant(outsider.id, 'family_basic');
    expect(await mustFamily(bystanderFamily)).toMatchObject({ plan_key: 'free', member_limit: 4 });
    expect(await planKeyCached(outsider.id)).toBe('family_basic');
    // 取り消し・期限切れの同期は「この行のプランを持つグループ」だけを free / 4 に戻すので、他人のグループが
    // 取り消すプラン (family_basic) を持っていないと、代表者の条件 (g.representative_id = p_user_id) を外しても
    // 結果が変わらない。他人のグループを先に family_basic / 4 にしておき、条件が効いていることを見る
    const { error: bystanderPlanError } = await srAdmin
      .from('family_groups')
      .update({ plan_key: 'family_basic', member_limit: 4 })
      .eq('id', bystanderFamily);
    expect(bystanderPlanError).toBeNull();
    const outsiderRevoked = await tryRevoke(outsider.id);
    expect(outsiderRevoked.error).toBeNull();
    expect(outsiderRevoked.data).toMatchObject({ plan_key: 'family_basic', status_to: 'cancelled' });
    expect(await mustFamily(bystanderFamily)).toMatchObject({ status: 'active', plan_key: 'family_basic', member_limit: 4 });
    // 期限切れの経路 (§6.4) も同じ同期を通る
    await grant(outsider.id, 'family_basic');
    await makeDue(outsider.id);
    expect(await expireForUser(outsider.id)).toBe(1);
    expect(await liveRowsOf(outsider.id)).toEqual([]);
    expect(await mustFamily(bystanderFamily)).toMatchObject({ status: 'active', plan_key: 'family_basic', member_limit: 4 });

    // 解散したグループは、付与でも取り消しでも期限切れでも plan_key / member_limit を変えない
    const dissolvedRep = await createUser('family-dissolved');
    const dissolvedFamily = await insertFamily(dissolvedRep.id);
    const { error: dissolveError } = await srAdmin
      .from('family_groups')
      .update({ status: 'dissolved', dissolved_at: new Date().toISOString(), plan_key: 'family_basic', member_limit: 3 })
      .eq('id', dissolvedFamily);
    expect(dissolveError).toBeNull();
    await grant(dissolvedRep.id, 'family_pro');
    expect(await mustFamily(dissolvedFamily)).toMatchObject({ status: 'dissolved', plan_key: 'family_basic', member_limit: 3 });
    // 取り消し・期限切れの同期は g.plan_key = 取り消すプラン の行だけを見るので、解散したグループが取り消すプラン (family_pro) を
    // 持っていないと、status の条件 (g.status = 'active') を外しても結果が変わらない。先に family_pro / 8 にしておく (§7.3 の M 行代表者)
    const { error: dissolvedPlanError } = await srAdmin
      .from('family_groups')
      .update({ plan_key: 'family_pro', member_limit: 8 })
      .eq('id', dissolvedFamily);
    expect(dissolvedPlanError).toBeNull();
    const dissolvedRevoked = await tryRevoke(dissolvedRep.id);
    expect(dissolvedRevoked.error).toBeNull();
    expect(dissolvedRevoked.data).toMatchObject({ plan_key: 'family_pro', status_to: 'cancelled' });
    expect(await mustFamily(dissolvedFamily)).toMatchObject({ status: 'dissolved', plan_key: 'family_pro', member_limit: 8 });
    await grant(dissolvedRep.id, 'family_pro');
    await makeDue(dissolvedRep.id);
    expect(await expireForUser(dissolvedRep.id)).toBe(1);
    expect(await liveRowsOf(dissolvedRep.id)).toEqual([]);
    expect(await mustFamily(dissolvedFamily)).toMatchObject({ status: 'dissolved', plan_key: 'family_pro', member_limit: 8 });

    // 解散した代表者の取り消し・期限切れ (family_pro) は、同じ family_pro / 8 を持つ他人の active なグループ
    // (rep のグループ = ほかの経路で入ったプラン・keeper のグループ = keeper の live な行) にも触れない
    expect(await mustFamily(familyId)).toMatchObject({ status: 'active', plan_key: 'family_pro', member_limit: 8 });
    expect(await mustFamily(keeperFamily)).toMatchObject({ status: 'active', plan_key: 'family_pro', member_limit: 8 });

    // このテストの付与・取り消し・期限切れ・内部の同期の直接の呼び出しをすべて通った後も、ほかの利用者は用意したときのまま
    await expectOtherUsersUntouched(others, '最後');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. 取り消し・期限切れ
// ---------------------------------------------------------------------------------------------

describe('billing/02 §6.3・§6.4: 取り消しと期限切れ', () => {
  // 42
  it('revoke sets cancelled + cancelled_at, recomputes plan_key_cached (NULL), raises BILL_MANUAL_ROW_NOT_FOUND when only a stripe-backed live row or no live row exists, and leaves active_coupon_redemption_id untouched', async () => {
    const user = await createUser('revoke');
    const granted = await grant(user.id, 'pro');
    const redemptionId = await applyCoupon(granted.subscription_id);
    const revoked = await tryRevoke(user.id);
    expect(revoked.error).toBeNull();
    expect(revoked.data).toEqual({
      subscription_id: granted.subscription_id,
      user_id: user.id,
      plan_key: 'pro',
      status_from: 'active',
      status_to: 'cancelled',
    });
    const row = await mustRowById(granted.subscription_id);
    expect(row).toMatchObject({ status: 'cancelled', cancel_at: null, active_coupon_redemption_id: redemptionId });
    expect(row.cancelled_at).not.toBeNull();
    expect(Math.abs((ms(row.cancelled_at) ?? 0) - Date.now())).toBeLessThan(NOW_TOLERANCE_MS);
    expect(await planKeyCached(user.id)).toBeNull();
    expect(await liveRowsOf(user.id)).toEqual([]);
    // 2 回目は live な M 行が無い
    expect((await tryRevoke(user.id)).error).toMatchObject({ code: 'P0001', message: 'BILL_MANUAL_ROW_NOT_FOUND', details: user.id });

    // live な S 行だけ → M 行が無い。S 行には触れない
    const stripeUser = await createUser('revoke-stripe');
    await apply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: stripeUser.id, planKey: 'pro' });
    const [stripeRow] = await liveRowsOf(stripeUser.id);
    const onStripe = await tryRevoke(stripeUser.id);
    expect(onStripe.data).toBeNull();
    expect(onStripe.error).toMatchObject({ code: 'P0001', message: 'BILL_MANUAL_ROW_NOT_FOUND' });
    expect(await mustRowById(stripeRow.id)).toMatchObject({ status: 'active', cancelled_at: null });
    expect(await planKeyCached(stripeUser.id)).toBe('pro');

    // 行が無い利用者
    const none = await createUser('revoke-none');
    expect((await tryRevoke(none.id)).error).toMatchObject({ code: 'P0001', message: 'BILL_MANUAL_ROW_NOT_FOUND' });

    // 引数の不足は 22023 (業務エラーではない)。入口の検査を外すと、鍵 (hashtext(NULL)) も行も無いまま BILL_MANUAL_ROW_NOT_FOUND の
    // DETAIL が NULL になって 22004 になるので、コードで区別できる
    const missing = await srAdmin.rpc('billing_revoke_manual_subscription', { p_user_id: null });
    expect(missing.data).toBeNull();
    expect(missing.error?.code).toBe('22023');

    // live の 5 値のどれの M 行も取り消せる (§7.1: active 以外の M 行は本冊の経路では生まれないが、service_role の直接の UPDATE で
    // 入っても live として同じ扱い。組織ライセンス受領による一時停止 (paused) は配線の残りの冊が扱う)。取り消しの SELECT の一覧から
    // どれかの値が抜けると、その M 行は BILL_MANUAL_ROW_NOT_FOUND で取り消せないまま live に残り、付与の衝突 (BILL_LIVE_ROW_CONFLICT) を出し続ける。
    // 家族プランで付与し、取り消しの同期 (グループを free / 4・plan_key_cached を NULL) まで通ったことを、4 値それぞれで見る (active は上で見た)
    for (const status of NON_ACTIVE_LIVE_STATUSES) {
      const statusUser = await createUser(`revoke-${status}`);
      const statusFamily = await insertFamily(statusUser.id);
      const statusGrant = await grant(statusUser.id, 'family_pro');
      await setLiveStatus(statusGrant.subscription_id, status);
      expect(await mustRowById(statusGrant.subscription_id), status).toMatchObject({ status, stripe_subscription_id: null });
      expect(await mustFamily(statusFamily), status).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
      expect(await planKeyCached(statusUser.id), status).toBe('family_pro');
      const statusRevoked = await tryRevoke(statusUser.id);
      expect(statusRevoked.error, status).toBeNull();
      expect(statusRevoked.data, status).toEqual({
        subscription_id: statusGrant.subscription_id,
        user_id: statusUser.id,
        plan_key: 'family_pro',
        status_from: status,
        status_to: 'cancelled',
      });
      const statusRow = await mustRowById(statusGrant.subscription_id);
      expect(statusRow.status, status).toBe('cancelled');
      expect(statusRow.cancelled_at, status).not.toBeNull();
      expect(await liveRowsOf(statusUser.id), status).toEqual([]);
      expect(await mustFamily(statusFamily), status).toMatchObject({ status: 'active', plan_key: 'free', member_limit: 4 });
      expect(await planKeyCached(statusUser.id), status).toBeNull();
    }
  });

  // 43
  it('expire_for_user (srAdmin.rpc billing_expire_manual_subscription_for_user) marks the user live manual row with current_period_end <= now() as expired and returns 1 (0 for a row without expiry, a future expiry, a stripe-backed row), syncs family/plan_key_cached and writes one system.billing.manual_grant_expired audit row with actor_id NULL; CALL public.billing_expire_manual_subscriptions() sent alone through pg/query expires the due rows of two users and leaves the others', async () => {
    // 期限を過ぎた M 行 → 1。expired・cancelled_at は NULL のまま・family と plan_key_cached を合わせ、監査を 1 行
    const user = await createUser('expire');
    const familyId = await insertFamily(user.id);
    const granted = await grant(user.id, 'family_pro', futureExpiry());
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
    // 期限がまだ先の行は 0
    expect(await expireForUser(user.id)).toBe(0);
    expect(await mustRowById(granted.subscription_id)).toMatchObject({ status: 'active' });
    await makeDue(user.id);
    const dueExpiry = (await mustRowById(granted.subscription_id)).current_period_end;
    expect(await expireForUser(user.id)).toBe(1);
    expect(await mustRowById(granted.subscription_id)).toMatchObject({ status: 'expired', cancelled_at: null });
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'free', member_limit: 4 });
    expect(await planKeyCached(user.id)).toBeNull();
    const audits = await auditsOf(user.id, 'system.billing.manual_grant_expired');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: null, target_id: user.id, target_type: 'user', severity: 'info' });
    expect(audits[0].details).toMatchObject({ subscription_id: granted.subscription_id, plan_key: 'family_pro' });
    expect(ms(audits[0].details.expires_at as string)).toBe(ms(dueExpiry));
    // 2 回目は live な行が無い → 0・監査は増えない
    expect(await expireForUser(user.id)).toBe(0);
    expect(await auditsOf(user.id, 'system.billing.manual_grant_expired')).toHaveLength(1);

    // 期限なしの行・S 行は、期限を過ぎていても 0
    const noExpiry = await createUser('expire-none');
    const noExpiryGrant = await grant(noExpiry.id, 'pro');
    expect(await expireForUser(noExpiry.id)).toBe(0);
    expect(await mustRowById(noExpiryGrant.subscription_id)).toMatchObject({ status: 'active' });
    const stripeUser = await createUser('expire-stripe');
    await apply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: stripeUser.id, planKey: 'pro' });
    await pgQuery(
      `UPDATE public.personal_subscriptions SET current_period_end = now() - interval '${PAST_HOURS} hour' WHERE user_id = '${stripeUser.id}'::uuid;`,
    );
    expect(await expireForUser(stripeUser.id)).toBe(0);
    expect((await liveRowsOf(stripeUser.id))[0]).toMatchObject({ status: 'active' });
    expect(await auditsOf(stripeUser.id, 'system.billing.manual_grant_expired')).toEqual([]);

    // 引数の不足は 22023 (業務エラーではない)。入口の検査を外すと、鍵 (hashtext(NULL)) も行も無いまま 0 を返す (エラーにならない)
    const missing = await srAdmin.rpc('billing_expire_manual_subscription_for_user', { p_user_id: null });
    expect(missing.data).toBeNull();
    expect(missing.error?.code).toBe('22023');

    // live の 5 値のどれの M 行も、期限を過ぎていれば expired にする (§7.1。取り消しと同じ理由)。1 人分の関数の SELECT の一覧から
    // どれかの値が抜けると、その status の M 行は期限を過ぎても live のまま残り、権利・家族のプラン・plan_key_cached が戻らない。
    // 家族プランで付与し、同期 (free / 4・NULL) と監査まで、4 値それぞれで見る (active は上で見た)
    for (const status of NON_ACTIVE_LIVE_STATUSES) {
      const statusUser = await createUser(`expire-${status}`);
      const statusFamily = await insertFamily(statusUser.id);
      const statusGrant = await grant(statusUser.id, 'family_pro', futureExpiry());
      await setLiveStatus(statusGrant.subscription_id, status);
      expect(await mustRowById(statusGrant.subscription_id), status).toMatchObject({ status, stripe_subscription_id: null });
      // 期限がまだ先なら 0
      expect(await expireForUser(statusUser.id), status).toBe(0);
      await makeDue(statusUser.id);
      expect(await expireForUser(statusUser.id), status).toBe(1);
      expect(await mustRowById(statusGrant.subscription_id), status).toMatchObject({ status: 'expired', cancelled_at: null });
      expect(await liveRowsOf(statusUser.id), status).toEqual([]);
      expect(await mustFamily(statusFamily), status).toMatchObject({ status: 'active', plan_key: 'free', member_limit: 4 });
      expect(await planKeyCached(statusUser.id), status).toBeNull();
      const statusAudits = await auditsOf(statusUser.id, 'system.billing.manual_grant_expired');
      expect(statusAudits, status).toHaveLength(1);
      expect(statusAudits[0].details, status).toMatchObject({ subscription_id: statusGrant.subscription_id, plan_key: 'family_pro' });
    }

    // CALL (1 つの要求に 1 文だけ): 期限を過ぎた 2 人を expired にし、ほかは残す
    const dueA = await createUser('call-due-a');
    const dueB = await createUser('call-due-b');
    const notDue = await createUser('call-not-due');
    const forever = await createUser('call-forever');
    const grantA = await grant(dueA.id, 'pro', futureExpiry());
    const grantB = await grant(dueB.id, 'family_basic', futureExpiry());
    const grantNotDue = await grant(notDue.id, 'pro', futureExpiry());
    const grantForever = await grant(forever.id, 'pro');
    await makeDue(dueA.id);
    await makeDue(dueB.id);
    // プロシージャの一覧も live の 5 値のどれの M 行も拾う。一覧からどれかの値が抜けると、その status の M 行は 1 人分の関数なら
    // expired にできる行でも、毎日のジョブから呼ばれないまま残る。active 以外の 4 値の期限を過ぎた M 行を 1 人ずつ、同じ CALL で見る
    const callDueByStatus: Array<{ status: string; userId: string; subscriptionId: string }> = [];
    for (const status of NON_ACTIVE_LIVE_STATUSES) {
      const statusUser = await createUser(`call-due-${status}`);
      const statusGrant = await grant(statusUser.id, 'pro', futureExpiry());
      await setLiveStatus(statusGrant.subscription_id, status);
      await makeDue(statusUser.id);
      expect(await mustRowById(statusGrant.subscription_id), status).toMatchObject({ status, stripe_subscription_id: null });
      callDueByStatus.push({ status, userId: statusUser.id, subscriptionId: statusGrant.subscription_id });
    }
    const called = await pgRequest('CALL public.billing_expire_manual_subscriptions();');
    expect(called.ok, JSON.stringify(called.body)).toBe(true);
    expect((await mustRowById(grantA.subscription_id)).status).toBe('expired');
    expect((await mustRowById(grantB.subscription_id)).status).toBe('expired');
    expect((await mustRowById(grantNotDue.subscription_id)).status).toBe('active');
    expect((await mustRowById(grantForever.subscription_id)).status).toBe('active');
    expect(await planKeyCached(dueA.id)).toBeNull();
    expect(await planKeyCached(dueB.id)).toBeNull();
    expect(await planKeyCached(notDue.id)).toBe('pro');
    expect(await auditsOf(dueA.id, 'system.billing.manual_grant_expired')).toHaveLength(1);
    expect(await auditsOf(dueB.id, 'system.billing.manual_grant_expired')).toHaveLength(1);
    expect(await auditsOf(notDue.id, 'system.billing.manual_grant_expired')).toEqual([]);
    for (const { status, userId, subscriptionId } of callDueByStatus) {
      expect((await mustRowById(subscriptionId)).status, status).toBe('expired');
      expect(await planKeyCached(userId), status).toBeNull();
      expect(await auditsOf(userId, 'system.billing.manual_grant_expired'), status).toHaveLength(1);
    }
  });

  // 54
  it('apply_coupon on a live manual row sets active_coupon_redemption_id, and a later expire (billing_expire_manual_subscription_for_user) leaves it unchanged (S18)', async () => {
    const user = await createUser('coupon');
    const granted = await grant(user.id, 'pro', futureExpiry());
    expect((await mustRowById(granted.subscription_id)).active_coupon_redemption_id).toBeNull();
    const redemptionId = await applyCoupon(granted.subscription_id);
    expect(await mustRowById(granted.subscription_id)).toMatchObject({ status: 'active', active_coupon_redemption_id: redemptionId });
    await makeDue(user.id);
    expect(await expireForUser(user.id)).toBe(1);
    expect(await mustRowById(granted.subscription_id)).toMatchObject({ status: 'expired', active_coupon_redemption_id: redemptionId });
  });
});

// ---------------------------------------------------------------------------------------------
// 3. 家族のトリガー・権限・権利の判定
// ---------------------------------------------------------------------------------------------

describe('billing/02 §6.2・§7: 家族のトリガー・権限・get_effective_plan', () => {
  // 44
  it('billing_family_plan_follow_representative picks up a manual family row on group creation and representative transfer (S7, S8)', async () => {
    // S7: グループ無しで family_basic を付与 → その後の作成のトリガーが family_basic / 4 にする
    const creator = await createUser('trigger-create', { jwt: true });
    await grant(creator.id, 'family_basic');
    const created = await createFamilyViaRpc(creator);
    expect(created).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });
    expect(await mustFamily(created.id)).toMatchObject({ plan_key: 'family_basic', member_limit: 4 });

    // S8: 代表者の交代。新しい代表者に家族プランの M 行があればそれ、無ければ free / 4。旧代表者の M 行はそのまま
    const [oldRep, newWithPlan, newWithout] = await Promise.all(
      ['trigger-old', 'trigger-new-with', 'trigger-new-without'].map((label) => createUser(label)),
    );
    const familyId = await insertFamily(oldRep.id);
    const oldGrant = await grant(oldRep.id, 'family_pro');
    expect(await mustFamily(familyId)).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });
    await grant(newWithPlan.id, 'family_basic');
    const toNewWithPlan = await srAdmin.from('family_groups').update({ representative_id: newWithPlan.id }).eq('id', familyId);
    expect(toNewWithPlan.error).toBeNull();
    expect(await mustFamily(familyId)).toMatchObject({ representative_id: newWithPlan.id, plan_key: 'family_basic', member_limit: 4 });
    expect((await mustRowById(oldGrant.subscription_id)).status).toBe('active');

    const toNewWithout = await srAdmin.from('family_groups').update({ representative_id: newWithout.id }).eq('id', familyId);
    expect(toNewWithout.error).toBeNull();
    expect(await mustFamily(familyId)).toMatchObject({ representative_id: newWithout.id, plan_key: 'free', member_limit: 4 });
    // 旧々代表者 (oldRep) の M 行は個人の権利としてそのまま
    expect(await effectivePlan(oldRep.id)).toBe('family_pro');
  });

  // 45
  it('anon / authenticated (incl. an admin JWT) cannot execute the 4 functions; service_role can execute grant/revoke/expire_for_user but not billing_manual_subscription_sync_after_end; has_function_privilege is false for anon/authenticated/service_role on the procedure billing_expire_manual_subscriptions()', async () => {
    const functions: Array<[string, string, boolean]> = [
      ['billing_grant_manual_subscription(uuid, text, timestamptz)', 'billing_grant_manual_subscription', true],
      ['billing_revoke_manual_subscription(uuid)', 'billing_revoke_manual_subscription', true],
      ['billing_expire_manual_subscription_for_user(uuid)', 'billing_expire_manual_subscription_for_user', true],
      ['billing_manual_subscription_sync_after_end(uuid, text)', 'billing_manual_subscription_sync_after_end', false],
    ];
    for (const [signature, , serviceAllowed] of functions) {
      const rows = await pgQuery<{ role: string; allowed: boolean }>(`
        SELECT r AS role, has_function_privilege(r, to_regprocedure('public.${signature}')::oid, 'EXECUTE') AS allowed
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;`);
      expect(Object.fromEntries(rows.map((r) => [r.role, r.allowed])), signature).toEqual({
        anon: false,
        authenticated: false,
        service_role: serviceAllowed,
      });
    }
    // プロシージャは誰にも EXECUTE が無い (所有者 postgres = pg_cron だけ)
    const procedureRows = await pgQuery<{ role: string; allowed: boolean }>(`
      SELECT r AS role, has_function_privilege(r, to_regprocedure('public.billing_expire_manual_subscriptions()')::oid, 'EXECUTE') AS allowed
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;`);
    expect(Object.fromEntries(procedureRows.map((r) => [r.role, r.allowed]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: false,
    });
    const procedureKind = await pgQuery<{ prokind: string }>(
      `SELECT prokind FROM pg_proc WHERE oid = to_regprocedure('public.billing_expire_manual_subscriptions()')::oid;`,
    );
    expect(procedureKind).toEqual([{ prokind: 'p' }]);

    // 実際に呼んでも 42501 (運営の JWT でも)。service_role も内部の関数は呼べない
    const target = await createUser('no-exec');
    const general = await createUser('no-exec-general', { jwt: true });
    const args: Array<[string, Record<string, unknown>]> = [
      ['billing_grant_manual_subscription', { p_user_id: target.id, p_plan_key: 'pro', p_expires_at: null }],
      ['billing_revoke_manual_subscription', { p_user_id: target.id }],
      ['billing_expire_manual_subscription_for_user', { p_user_id: target.id }],
      ['billing_manual_subscription_sync_after_end', { p_user_id: target.id, p_plan_key: 'pro' }],
    ];
    for (const [fn, params] of args) {
      for (const [who, c] of [
        ['anon', anon()],
        ['authenticated (general user)', asUser(jwtOf(general))],
        ['authenticated (super_admin JWT)', asUser(jwtOf(operator))],
      ] as const) {
        const { error } = await c.rpc(fn, params);
        expect(error?.code, `${who} ${fn}`).toBe('42501');
      }
    }
    const internal = await srAdmin.rpc('billing_manual_subscription_sync_after_end', { p_user_id: target.id, p_plan_key: 'pro' });
    expect(internal.error?.code).toBe('42501');
    expect(await rowsOf(target.id)).toEqual([]);
  });

  // 46
  it('get_effective_plan returns the granted plan while active and free after revoke/expire', async () => {
    const revokeUser = await createUser('effective-revoke');
    expect(await effectivePlan(revokeUser.id)).toBe('free');
    await grant(revokeUser.id, 'pro');
    expect(await effectivePlan(revokeUser.id)).toBe('pro');
    await tryRevoke(revokeUser.id);
    expect(await effectivePlan(revokeUser.id)).toBe('free');

    const expireUser = await createUser('effective-expire');
    await grant(expireUser.id, 'pro', futureExpiry());
    expect(await effectivePlan(expireUser.id)).toBe('pro');
    await makeDue(expireUser.id);
    await expireForUser(expireUser.id);
    expect(await effectivePlan(expireUser.id)).toBe('free');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. 写像・競合
// ---------------------------------------------------------------------------------------------

describe('billing/02 §7.3・§4.2: 写像との衝突と同時の処理', () => {
  // 47
  it('two concurrent grants for the same user (two connections) serialize on billing-user and the second raises BILL_LIVE_ROW_CONFLICT; a grant concurrent with billing_apply_stripe_subscription yields exactly one live row', async () => {
    // 付与 2 本: 先の接続が鍵とコミット前の行を持ったまま、後の付与が advisory の待ちに入る
    const user = await createUser('race-grant');
    const holder = startHolder(`SELECT ${grantSql(user.id, 'pro')};`, '');
    await holder.sleeping;
    const second = tryGrant(user.id, 'family_basic');
    await releaseAfterWaiter(holder, 'billing_grant_manual_subscription', 'advisory');
    const [held, secondResult] = await Promise.all([holder.done, second]);
    expect(held.ok).toBe(true);
    expect(secondResult.data).toBeNull();
    const [firstRow] = await liveRowsOf(user.id);
    expect(secondResult.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT', details: firstRow.id });
    expect(await liveRowsOf(user.id)).toHaveLength(1);
    expect(firstRow.plan_key).toBe('pro');

    // 付与が先・写像が後: 写像が BILL_LIVE_ROW_CONFLICT
    const grantFirst = await createUser('race-grant-first');
    const grantHolder = startHolder(`SELECT ${grantSql(grantFirst.id, 'pro')};`, '');
    await grantHolder.sleeping;
    const lateApply = tryApply({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: grantFirst.id, planKey: 'pro' });
    await releaseAfterWaiter(grantHolder, 'billing_apply_stripe_subscription', 'advisory');
    const [grantHeld, applied] = await Promise.all([grantHolder.done, lateApply]);
    expect(grantHeld.ok).toBe(true);
    expect(applied.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT' });
    const grantFirstLive = await liveRowsOf(grantFirst.id);
    expect(grantFirstLive).toHaveLength(1);
    expect(grantFirstLive[0].stripe_subscription_id).toBeNull();

    // 写像が先・付与が後: 付与が BILL_LIVE_ROW_CONFLICT
    const applyFirst = await createUser('race-apply-first');
    const applyHolder = startHolder(
      `SELECT ${applySql({ sub: nextSub(), customer: nextCustomer(), status: 'active', userId: applyFirst.id, planKey: 'pro' }, nextFetchedAt())};`,
      '',
    );
    await applyHolder.sleeping;
    const lateGrant = tryGrant(applyFirst.id, 'pro');
    await releaseAfterWaiter(applyHolder, 'billing_grant_manual_subscription', 'advisory');
    const [applyHeld, lateGrantResult] = await Promise.all([applyHolder.done, lateGrant]);
    expect(applyHeld.ok).toBe(true);
    expect(lateGrantResult.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT' });
    const applyFirstLive = await liveRowsOf(applyFirst.id);
    expect(applyFirstLive).toHaveLength(1);
    expect(applyFirstLive[0].stripe_subscription_id).not.toBeNull();
  });

  // 50
  it('billing_apply_stripe_subscription for a user with a live manual row raises BILL_LIVE_ROW_CONFLICT and leaves the manual row and plan_key_cached unchanged (S9)', async () => {
    const user = await createUser('s9');
    const granted = await grant(user.id, 'pro');
    const sub = nextSub();
    const { data, error } = await tryApply({ sub, customer: nextCustomer(), status: 'active', userId: user.id, planKey: 'family_basic' });
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT', details: granted.subscription_id });
    const rows = await rowsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: granted.subscription_id, status: 'active', plan_key: 'pro', stripe_subscription_id: null });
    expect(await planKeyCached(user.id)).toBe('pro');
  });

  // 51
  it('grant succeeds over an incomplete stripe-backed row; a later billing_apply_stripe_subscription that would make that row active raises BILL_LIVE_ROW_CONFLICT and the stripe row stays incomplete (S10)', async () => {
    const user = await createUser('s10');
    const sub = nextSub();
    const customer = nextCustomer();
    await apply({ sub, customer, status: 'incomplete', userId: user.id, planKey: 'pro' });
    const granted = await tryGrant(user.id, 'pro');
    expect(granted.error).toBeNull();
    expect(await planKeyCached(user.id)).toBe('pro');
    const completed = await tryApply({ sub, customer, status: 'active', userId: user.id, planKey: 'pro' });
    expect(completed.data).toBeNull();
    expect(completed.error).toMatchObject({ code: 'P0001', message: 'BILL_LIVE_ROW_CONFLICT', details: granted.data?.subscription_id });
    const rows = await rowsOf(user.id);
    expect(rows.map((r) => [r.stripe_subscription_id, r.status]).sort()).toEqual(
      [
        [sub, 'incomplete'],
        [null, 'active'],
      ].sort(),
    );
    expect(await planKeyCached(user.id)).toBe('pro');
  });
});

// ---------------------------------------------------------------------------------------------
// 5. 凍結・退会
// ---------------------------------------------------------------------------------------------

describe('billing/02 §3.2: 凍結中・退会', () => {
  // 52
  it('grant succeeds for a frozen user (user_profiles.frozen_at set by service_role) and leaves frozen_at unchanged (S16)', async () => {
    const user = await createUser('frozen');
    const frozenAt = new Date(Date.now() - HOUR_MS).toISOString();
    const { error: freezeError } = await srAdmin.from('user_profiles').update({ frozen_at: frozenAt }).eq('id', user.id);
    expect(freezeError).toBeNull();
    const granted = await tryGrant(user.id, 'pro');
    expect(granted.error).toBeNull();
    const { data, error } = await srAdmin.from('user_profiles').select('frozen_at, plan_key_cached').eq('id', user.id).single();
    expect(error).toBeNull();
    expect(ms((data as { frozen_at: string }).frozen_at)).toBe(ms(frozenAt));
    expect((data as { plan_key_cached: string }).plan_key_cached).toBe('pro');
  });

  // 53
  it('deleting the auth user (srAdmin.auth.admin.deleteUser) removes the manual row by CASCADE, and an admin_audit_logs row whose target_id is that user remains with the same target_id (S17)', async () => {
    const user = await createUser('delete');
    const granted = await grant(user.id, 'pro');
    // 監査の行は route が書く。ここでは service_role で admin.billing.manual_grant を 1 行入れて用意する
    const { error: auditError } = await srAdmin.from('admin_audit_logs').insert({
      actor_id: operator.id,
      action_type: 'admin.billing.manual_grant',
      target_id: user.id,
      target_type: 'user',
      severity: 'warn',
      details: { subscription_id: granted.subscription_id, plan_key: 'pro', expires_at: null, reason: 'it' },
    });
    expect(auditError).toBeNull();
    const { error: deleteError } = await srAdmin.auth.admin.deleteUser(user.id);
    expect(deleteError).toBeNull();
    const { data: rows } = await srAdmin.from('personal_subscriptions').select('id').eq('user_id', user.id);
    expect(rows).toEqual([]);
    const audits = await auditsOf(user.id, 'admin.billing.manual_grant');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target_id: user.id, action_type: 'admin.billing.manual_grant' });
  });
});

// ---------------------------------------------------------------------------------------------
// 6. 期限切れのプロシージャと、家族の関数・代表者の交代のデッドロック
// ---------------------------------------------------------------------------------------------

describe('billing/02 §6.4: 利用者ごとに COMMIT するプロシージャ', () => {
  /**
   * 利用者を 2 人作り、user_id の小さい方をメンバー U1・大きい方を代表者 U2 にする (プロシージャは ORDER BY user_id で U1 を先に処理する)。
   * U2 を代表者とするグループ G を作り、U1 をそのメンバーにする (user_profiles.family_id = G)。
   * U1 に pro・U2 に family_basic を付与し、両方の current_period_end を過去にする
   */
  async function prepareDueMembers(label: string): Promise<{ u1: TestUser; u2: TestUser; groupId: string; grant1: string; grant2: string }> {
    const created = await Promise.all([createUser(`${label}-a`), createUser(`${label}-b`)]);
    const [u1, u2] = [...created].sort((a, b) => (a.id < b.id ? -1 : 1));
    const groupId = await insertFamily(u2.id);
    await pgQuery(`UPDATE public.user_profiles SET family_id = '${groupId}'::uuid WHERE id IN ('${u1.id}'::uuid, '${u2.id}'::uuid);`);
    const grant1 = await grant(u1.id, 'pro', futureExpiry());
    const grant2 = await grant(u2.id, 'family_basic', futureExpiry());
    await makeDue(u1.id);
    await makeDue(u2.id);
    return { u1, u2, groupId, grant1: grant1.subscription_id, grant2: grant2.subscription_id };
  }

  // 57
  it('CALL billing_expire_manual_subscriptions does not deadlock (40P01) with a family operation that holds the family_groups row and then touches a member user_profiles row, nor with a representative transfer to that member that holds the family_groups row and then takes billing-user of the member; both due manual rows end up expired', async () => {
    // (a) 解散・脱退の形: family_groups の行を持ってから、メンバーの user_profiles の行に触る
    const a = await prepareDueMembers('deadlock-a');
    const holderA = startHolder(
      `SELECT 1 FROM public.family_groups WHERE id = '${a.groupId}' FOR NO KEY UPDATE;`,
      `UPDATE public.user_profiles SET updated_at = now() WHERE family_id = '${a.groupId}';`,
    );
    await holderA.sleeping;
    const callA = pgRequest('CALL public.billing_expire_manual_subscriptions();');
    await releaseAfterWaiter(holderA, 'billing_expire_manual_subscriptions');
    const [heldA, calledA] = await Promise.all([holderA.done, callA]);
    const calledAOutcome: Outcome = { ok: calledA.ok, message: calledA.ok ? null : JSON.stringify(calledA.body), code: null };
    expectNoDeadlock(heldA, calledAOutcome);
    expect(heldA.ok, JSON.stringify(heldA)).toBe(true);
    expect(calledA.ok, JSON.stringify(calledA.body)).toBe(true);
    expect((await mustRowById(a.grant1)).status).toBe('expired');
    expect((await mustRowById(a.grant2)).status).toBe('expired');

    // (b) 代表者の交代の形: family_groups の行を持ってから、メンバー (U1) への交代のトリガーが billing-user:<U1> を取る
    const b = await prepareDueMembers('deadlock-b');
    const holderB = startHolder(
      `SELECT 1 FROM public.family_groups WHERE id = '${b.groupId}' FOR NO KEY UPDATE;`,
      `UPDATE public.family_groups SET representative_id = '${b.u1.id}' WHERE id = '${b.groupId}';`,
    );
    await holderB.sleeping;
    const callB = pgRequest('CALL public.billing_expire_manual_subscriptions();');
    await releaseAfterWaiter(holderB, 'billing_expire_manual_subscriptions');
    const [heldB, calledB] = await Promise.all([holderB.done, callB]);
    const calledBOutcome: Outcome = { ok: calledB.ok, message: calledB.ok ? null : JSON.stringify(calledB.body), code: null };
    expectNoDeadlock(heldB, calledBOutcome);
    expect(heldB.ok, JSON.stringify(heldB)).toBe(true);
    expect(calledB.ok, JSON.stringify(calledB.body)).toBe(true);
    expect((await mustRowById(b.grant1)).status).toBe('expired');
    expect((await mustRowById(b.grant2)).status).toBe('expired');
    // 交代は通っている (グループの代表者は U1)
    expect((await mustFamily(b.groupId)).representative_id).toBe(b.u1.id);
  });
});
