/**
 * billing/04 (ストアの購読の定期の取り直し) 段 A: 候補を読む関数 billing_iap_reconcile_candidates と、
 * 試した印を書く関数 billing_iap_reconcile_mark_attempted と、印の表 iap_reconcile_attempts の結合テスト
 * (設計: docs/design/billing/04-iap-reconcile.md §6.2・§12.3 の 38〜45)
 *
 * 段 A のテストなので、段 B の src/lib/billing/iap-reconcile-*.ts を import しない (段 B の定数も使わない。ここで同じ値をリテラルの定数で書く)。
 * 写像 billing_apply_store_subscription (43) には、関数の本体が p_snapshot->>'…' で読むキーの JSON をこのファイルで組んで渡す。
 *
 * 候補を読む関数は personal_subscriptions の全体を読むので、「候補に出るのは、いま走っている it が作った利用者だけ」を次の 3 つで保つ
 * (設計 §12.3。時刻と片付けの型は tests/integration/rls/org-challenge-diff-privacy.test.ts と同じ):
 *   1. 時刻は固定の過去の年 (2000 年。at(hours)): ほかの結合テストのファイルが作る行の期限 (Date.now() からの相対) は、どれもこのファイルの p_now より後
 *   2. it ごとの片付け (afterEach)。印の表は service_role が SELECT しかできないので、印の行は auth.users の ON DELETE CASCADE で消す
 *   3. it ごとに新しい利用者 (describe の beforeAll で共有しない)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/billing-iap-reconcile-candidates-rpc.test.ts
 * 本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import ws from 'ws';
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
// 時刻 (どれも固定の過去の年。設計 §12.3 の 1.)
// ---------------------------------------------------------------------------------------------

/** 候補の判定の「いま」の起点。ほかの結合テストのファイルの行の期限 (Date.now() からの相対) より十分に前の、固定の過去の時刻 */
const RECONCILE_NOW_MS = Date.parse('2000-01-01T00:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
/** p_now・p_attempted_at に渡す値の、起点からの幅 (時間)。この中なら、ほかのファイルの行の期限は必ず p_now より後 */
const P_NOW_SPREAD_HOURS = 24;
/** 39 などで渡す p_recheck_after (時間)。述語の検査に使うだけの値 (段 A のテストなので、段 B の IAP_RECONCILE_RECHECK_HOURS を import しない) */
const RECHECK_HOURS = 6;
/** 月額の 1 か月 (時間。写像の snapshot の購入日から期限までの長さ) */
const MONTH_HOURS = 30 * 24;
/** migration の関数 2 本の c_max_users (1 回の呼び出しで扱う利用者の数の安全の上限) と同じ値 */
const C_MAX_USERS = 200;

const at = (hours: number): string => new Date(RECONCILE_NOW_MS + hours * HOUR_MS).toISOString();
const ms = (value: string | null): number | null => (value === null ? null : new Date(value).getTime());

// ---------------------------------------------------------------------------------------------
// 利用者・行
// ---------------------------------------------------------------------------------------------

const TS = Date.now();
const RUN = `${TS}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const SUB_PREFIX = `sub_it_iap_reconcile_${RUN}_`;
let seq = 0;

const PRODUCT_MONTH = `it.iap-reconcile.${RUN}.pro.month`;
/** 同じ利用者に 2 本目のストアの行を置く 41 だけが使う (同じ利用者・ストア・商品は 1 行の一意の索引があるため) */
const PRODUCT_YEAR = `it.iap-reconcile.${RUN}.pro.year`;

const profileBase = { age_group: '30s', gender: 'other' };

/** 作った利用者の全部 (afterAll の安全網) と、いま走っている it の分。createUser が両方に積む */
const createdUserIds: string[] = [];
const currentTestUserIds: string[] = [];

interface TestUser {
  id: string;
  /** JWT が要るテスト (42 の authenticated) だけサインインする */
  jwt: string | null;
}

async function createUser(label: string, options: { jwt?: boolean } = {}): Promise<TestUser> {
  const email = `rls-billing-iap-reconcile-${label}-${++seq}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  currentTestUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `iap-reconcile-${label}`, ...profileBase }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  if (!options.jwt) return { id: data.user.id, jwt: null };
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function deleteTestUsers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const audits = await srAdmin.from('admin_audit_logs').delete().in('target_id', ids); // 43 の写像が監査を書く
  if (audits.error) throw new Error(`admin_audit_logs: ${audits.error.message}`);
  const subscriptions = await srAdmin.from('personal_subscriptions').delete().in('user_id', ids);
  if (subscriptions.error) throw new Error(`personal_subscriptions: ${subscriptions.error.message}`);
  for (const id of ids) {
    // iap_reconcile_attempts と user_profiles は auth.users の ON DELETE CASCADE で消える
    const { error } = await srAdmin.auth.admin.deleteUser(id);
    if (error) throw new Error(`deleteUser: ${error.message}`);
    const index = createdUserIds.indexOf(id);
    if (index >= 0) createdUserIds.splice(index, 1);
  }
  for (const table of ['personal_subscriptions', 'iap_reconcile_attempts'] as const) {
    const left = await srAdmin.from(table).select('user_id').in('user_id', ids);
    if (left.error) throw new Error(`${table}: ${left.error.message}`);
    if ((left.data ?? []).length > 0) throw new Error(`${table} にこの it の利用者の行が残った`);
  }
}

afterEach(async () => {
  await deleteTestUsers(currentTestUserIds.splice(0));
});

afterAll(async () => {
  await deleteTestUsers([...createdUserIds]);
});

type StoreStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';

interface StoreRowInput {
  status: StoreStatus;
  periodEnd: string | null;
  syncedAt: string | null;
  product?: string;
  interval?: 'month' | 'year';
}

/** service_role でストアの行 (iap_store = 'app_store') を直接置く */
async function insertStoreRow(userId: string, input: StoreRowInput): Promise<void> {
  const { error } = await srAdmin.from('personal_subscriptions').insert({
    user_id: userId,
    plan_key: 'pro',
    status: input.status,
    iap_store: 'app_store',
    iap_product_id: input.product ?? PRODUCT_MONTH,
    billing_interval: input.interval ?? 'month',
    starts_at: at(-2 * MONTH_HOURS),
    current_period_start: at(-2 * MONTH_HOURS),
    current_period_end: input.periodEnd,
    iap_synced_at: input.syncedAt,
  });
  if (error) throw new Error(`personal_subscriptions (store): ${error.message}`);
}

/** Stripe の行 (iap_store が無い。期限は過ぎている) */
async function insertStripeRow(userId: string, periodEnd: string): Promise<void> {
  const { error } = await srAdmin.from('personal_subscriptions').insert({
    user_id: userId,
    plan_key: 'pro',
    status: 'active',
    stripe_subscription_id: `${SUB_PREFIX}${++seq}`,
    stripe_status: 'active',
    billing_interval: 'month',
    starts_at: at(-2 * MONTH_HOURS),
    current_period_start: at(-2 * MONTH_HOURS),
    current_period_end: periodEnd,
  });
  if (error) throw new Error(`personal_subscriptions (stripe): ${error.message}`);
}

/** 手動付与の行 (iap_store も stripe_subscription_id も無い。billing_grant_manual_subscription が INSERT する形) */
async function insertManualRow(userId: string, periodEnd: string): Promise<void> {
  const { error } = await srAdmin.from('personal_subscriptions').insert({
    user_id: userId,
    plan_key: 'pro',
    status: 'active',
    starts_at: at(-2 * MONTH_HOURS),
    current_period_start: at(-2 * MONTH_HOURS),
    current_period_end: periodEnd,
  });
  if (error) throw new Error(`personal_subscriptions (manual): ${error.message}`);
}

// ---------------------------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------------------------

interface CandidateRow {
  user_id: string;
  period_end: string;
  synced_at: string | null;
}

/** 返った行を比べやすい形 (時刻はミリ秒) にしたもの */
interface Candidate {
  userId: string;
  periodEndMs: number | null;
  syncedAtMs: number | null;
}

interface RpcError {
  message: string;
  code: string;
}

const toRpcError = (error: { message: string; code: string } | null): RpcError | null =>
  error ? { message: error.message, code: error.code } : null;

interface CandidateArgs {
  now?: string | null;
  recheckAfter?: string | null;
  limit?: number | null;
}

function candidateParams(args: CandidateArgs): Record<string, unknown> {
  return {
    p_now: args.now === undefined ? at(0) : args.now,
    p_recheck_after: args.recheckAfter === undefined ? `${RECHECK_HOURS} hours` : args.recheckAfter,
    p_limit: args.limit === undefined ? C_MAX_USERS : args.limit,
  };
}

async function tryCandidates(args: CandidateArgs = {}, db: SupabaseClient = srAdmin): Promise<{ rows: Candidate[]; error: RpcError | null }> {
  const { data, error } = await db.rpc('billing_iap_reconcile_candidates', candidateParams(args));
  const rows = ((data as CandidateRow[] | null) ?? []).map((row) => ({
    userId: row.user_id,
    periodEndMs: ms(row.period_end),
    syncedAtMs: ms(row.synced_at),
  }));
  return { rows, error: toRpcError(error) };
}

async function candidates(args: CandidateArgs = {}): Promise<Candidate[]> {
  const { rows, error } = await tryCandidates(args);
  if (error) throw new Error(`billing_iap_reconcile_candidates: ${JSON.stringify(error)}`);
  return rows;
}

/** 期待の形 (利用者・期限・最後の取り直しの時刻) */
const expected = (userId: string, periodEnd: string, syncedAt: string | null = null): Candidate => ({
  userId,
  periodEndMs: ms(periodEnd),
  syncedAtMs: ms(syncedAt),
});

async function tryMarkAttempted(
  userIds: string[] | null,
  attemptedAt: string | null,
  db: SupabaseClient = srAdmin,
): Promise<{ error: RpcError | null }> {
  const { error } = await db.rpc('billing_iap_reconcile_mark_attempted', { p_user_ids: userIds, p_attempted_at: attemptedAt });
  return { error: toRpcError(error) };
}

async function markAttempted(userIds: string[], attemptedAt: string): Promise<void> {
  const { error } = await tryMarkAttempted(userIds, attemptedAt);
  if (error) throw new Error(`billing_iap_reconcile_mark_attempted: ${JSON.stringify(error)}`);
}

/** 印の表の行 (service_role は SELECT だけできる) */
async function attemptsOf(userIds: string[]): Promise<Array<{ userId: string; attemptedAtMs: number | null }>> {
  const { data, error } = await srAdmin
    .from('iap_reconcile_attempts')
    .select('user_id, attempted_at')
    .in('user_id', userIds)
    .order('user_id', { ascending: true });
  if (error) throw new Error(`iap_reconcile_attempts: ${error.message}`);
  return ((data ?? []) as Array<{ user_id: string; attempted_at: string }>).map((row) => ({
    userId: row.user_id,
    attemptedAtMs: ms(row.attempted_at),
  }));
}

/** 写像 billing_apply_store_subscription の p_snapshot (関数の本体が ->> で読むキー。billing/03 §8.1 の StoreSubscriptionSnapshot と同じ名前) */
function storeSnapshot(userId: string, status: StoreStatus, expiresAt: string): Record<string, unknown> {
  return {
    user_id: userId,
    iap_store: 'app_store',
    iap_product_id: PRODUCT_MONTH,
    plan_key: 'pro',
    billing_interval: 'month',
    iap_status: status,
    cancel_at_period_end: false,
    purchase_date: at(-MONTH_HOURS - 2),
    original_purchase_date: at(-MONTH_HOURS - 2),
    expires_date: expiresAt,
    refunded_at: null,
    is_sandbox: false,
  };
}

async function applyStore(userId: string, status: StoreStatus, expiresAt: string, fetchedAt: string): Promise<void> {
  const { error } = await srAdmin.rpc('billing_apply_store_subscription', {
    p_snapshot: storeSnapshot(userId, status, expiresAt),
    p_fetched_at: fetchedAt,
    p_source: 'iap_reconcile',
  });
  if (error) throw new Error(`billing_apply_store_subscription: ${error.message}`);
}

const byUserId = <T extends { userId: string }>(a: T, b: T): number => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// 38〜45
// ---------------------------------------------------------------------------------------------

describe('billing/04 段 A: billing_iap_reconcile_candidates (候補を読む関数)', () => {
  // 38
  it('returns one row per user for live store rows past current_period_end whose iap_synced_at is null or earlier than current_period_end, ordered by period_end then user_id among never-attempted users, limited by p_limit', async () => {
    const u1 = await createUser('c38-u1');
    const u2 = await createUser('c38-u2');
    const u3 = await createUser('c38-u3');
    const t1 = await createUser('c38-t1');
    const t2 = await createUser('c38-t2');
    // 期限の早い順に u1 → u2 → u3。t1・t2 は同じ期限 (同じ期限は user_id の順)
    await insertStoreRow(u1.id, { status: 'active', periodEnd: at(-6), syncedAt: null });
    // 取り直した時刻が期限より前 (期限の後の姿をまだ取り直していない)
    await insertStoreRow(u2.id, { status: 'trialing', periodEnd: at(-5), syncedAt: at(-10) });
    await insertStoreRow(u3.id, { status: 'past_due', periodEnd: at(-4), syncedAt: null });
    await insertStoreRow(t1.id, { status: 'active', periodEnd: at(-3), syncedAt: null });
    await insertStoreRow(t2.id, { status: 'active', periodEnd: at(-3), syncedAt: null });

    const ties = [expected(t1.id, at(-3)), expected(t2.id, at(-3))].sort(byUserId);
    const all = [expected(u1.id, at(-6)), expected(u2.id, at(-5), at(-10)), expected(u3.id, at(-4)), ...ties];

    expect(await candidates({ limit: C_MAX_USERS })).toEqual(all);
    // p_limit で打ち切る (期限の早い順の先頭から)
    expect(await candidates({ limit: 2 })).toEqual(all.slice(0, 2));
    expect(await candidates({ limit: 4 })).toEqual(all.slice(0, 4));
  });

  // 39
  it('excludes a row synced after its current_period_end within p_recheck_after and includes it once iap_synced_at <= p_now - p_recheck_after', async () => {
    const user = await createUser('c39');
    // 期限の後 (期限の 7 時間後) に取り直して live のまま
    await insertStoreRow(user.id, { status: 'active', periodEnd: at(-RECHECK_HOURS - 2), syncedAt: at(-1) });

    // p_now = at(0): iap_synced_at (at(-1)) は p_now - 6 時間 (at(-6)) より新しい = 間隔の中
    expect(await candidates({ now: at(0) })).toEqual([]);
    // p_now = at(RECHECK_HOURS - 2): p_now - 6 時間 = at(-2) で、まだ iap_synced_at (at(-1)) の方が新しい
    expect(await candidates({ now: at(RECHECK_HOURS - 2) })).toEqual([]);
    // p_now = at(RECHECK_HOURS - 1): p_now - 6 時間 = at(-1) = iap_synced_at (等号で候補に戻る)
    expect(await candidates({ now: at(RECHECK_HOURS - 1) })).toEqual([
      expected(user.id, at(-RECHECK_HOURS - 2), at(-1)),
    ]);
  });

  // 40
  it('excludes Stripe rows, manual rows, expired / cancelled store rows, rows with current_period_end NULL and rows whose period has not ended', async () => {
    const control = await createUser('c40-control');
    const stripe = await createUser('c40-stripe');
    const manual = await createUser('c40-manual');
    const expiredRow = await createUser('c40-expired');
    const cancelledRow = await createUser('c40-cancelled');
    const noEnd = await createUser('c40-noend');
    const notEnded = await createUser('c40-notended');
    // 番兵: 対象の行 (live なストアの行で期限を過ぎている) は拾える
    await insertStoreRow(control.id, { status: 'active', periodEnd: at(-3), syncedAt: null });
    await insertStripeRow(stripe.id, at(-3));
    await insertManualRow(manual.id, at(-3));
    await insertStoreRow(expiredRow.id, { status: 'expired', periodEnd: at(-3), syncedAt: null });
    await insertStoreRow(cancelledRow.id, { status: 'cancelled', periodEnd: at(-3), syncedAt: null });
    await insertStoreRow(noEnd.id, { status: 'active', periodEnd: null, syncedAt: null });
    // 期限が p_now (at(0)) より後
    await insertStoreRow(notEnded.id, { status: 'active', periodEnd: at(1), syncedAt: null });

    expect(await candidates()).toEqual([expected(control.id, at(-3))]);
  });

  // 41
  it('a user with an expired store row and a live store row past its end appears once with the live row period_end', async () => {
    const user = await createUser('c41');
    // 期限の早い expired の行 (対象外) と、期限を過ぎた live の行 (2 本目の商品。同じ利用者・ストア・商品は 1 行の一意の索引がある)
    await insertStoreRow(user.id, { status: 'expired', periodEnd: at(-10), syncedAt: null });
    await insertStoreRow(user.id, { status: 'active', periodEnd: at(-2), syncedAt: null, product: PRODUCT_YEAR, interval: 'year' });

    expect(await candidates()).toEqual([expected(user.id, at(-2))]);
  });

  // 42
  it('billing_iap_reconcile_candidates raises 22023 for p_limit 0 and 201, for a zero or negative p_recheck_after and for NULL arguments; anon and authenticated cannot execute it or select iap_reconcile_attempts (42501)', async () => {
    const authenticatedUser = await createUser('c42-auth', { jwt: true });

    expect((await tryCandidates({ limit: 0 })).error?.code).toBe('22023');
    expect((await tryCandidates({ limit: C_MAX_USERS + 1 })).error?.code).toBe('22023');
    expect((await tryCandidates({ recheckAfter: '0 hours' })).error?.code).toBe('22023');
    expect((await tryCandidates({ recheckAfter: '-1 hours' })).error?.code).toBe('22023');
    expect((await tryCandidates({ now: null })).error?.code).toBe('22023');
    expect((await tryCandidates({ recheckAfter: null })).error?.code).toBe('22023');
    expect((await tryCandidates({ limit: null })).error?.code).toBe('22023');
    // 境界 (1 と c_max_users) は通る
    expect((await tryCandidates({ limit: 1 })).error).toBeNull();
    expect((await tryCandidates({ limit: C_MAX_USERS })).error).toBeNull();

    // anon・authenticated は関数を実行できず、印の表も読めない
    const anonExec = await tryCandidates({}, anon());
    expect(anonExec.error?.code).toBe('42501');
    const authExec = await tryCandidates({}, asUser(authenticatedUser.jwt!));
    expect(authExec.error?.code).toBe('42501');
    for (const db of [anon(), asUser(authenticatedUser.jwt!)]) {
      const { error } = await db.from('iap_reconcile_attempts').select('user_id').limit(1);
      expect(error?.code).toBe('42501');
    }
  });

  // 43
  it('after billing_apply_store_subscription writes an expired snapshot with p_fetched_at after current_period_end, the user is no longer returned; after a renewed snapshot (expires_date in the future) it is no longer returned either', async () => {
    const expiredUser = await createUser('c43-expired');
    const renewedUser = await createUser('c43-renewed');
    await insertStoreRow(expiredUser.id, { status: 'active', periodEnd: at(-2), syncedAt: null });
    await insertStoreRow(renewedUser.id, { status: 'active', periodEnd: at(-2), syncedAt: null });
    // 写す前は 2 人とも候補 (期限の順 → user_id)
    expect(await candidates()).toEqual(
      [expected(expiredUser.id, at(-2)), expected(renewedUser.id, at(-2))].sort(byUserId),
    );

    // 期限の後に取り直した結果: 失効 (expired・期限は変わらず) / 更新 (active・期限は未来)
    await applyStore(expiredUser.id, 'expired', at(-2), at(-1));
    expect(await candidates()).toEqual([expected(renewedUser.id, at(-2))]);
    await applyStore(renewedUser.id, 'active', at(MONTH_HOURS), at(-1));
    expect(await candidates()).toEqual([]);
  });

  // 44
  it('billing_iap_reconcile_candidates writes no iap_reconcile_attempts row; with due users A, B, C (A oldest) and p_limit 3, after billing_iap_reconcile_mark_attempted marks only A (B and C returned but not tried), the next call returns B and C before A; after marking B and C later than A, the next call returns A first again (a user that stays due is not returned first every time)', async () => {
    const a = await createUser('c44-a');
    const b = await createUser('c44-b');
    const c = await createUser('c44-c');
    await insertStoreRow(a.id, { status: 'active', periodEnd: at(-6), syncedAt: null });
    await insertStoreRow(b.id, { status: 'active', periodEnd: at(-5), syncedAt: null });
    await insertStoreRow(c.id, { status: 'active', periodEnd: at(-4), syncedAt: null });
    const rowA = expected(a.id, at(-6));
    const rowB = expected(b.id, at(-5));
    const rowC = expected(c.id, at(-4));

    // 1 回目: 印が無いので期限の早い順。候補を読む関数は何も書かない
    expect(await candidates({ limit: 3 })).toEqual([rowA, rowB, rowC]);
    expect(await attemptsOf([a.id, b.id, c.id])).toEqual([]);

    // A だけ試した (B と C は選ばれたが試していない = 印を渡さない)。次は印の無い B・C が先、A が後
    await markAttempted([a.id], at(-3));
    expect(await attemptsOf([a.id, b.id, c.id])).toEqual([{ userId: a.id, attemptedAtMs: ms(at(-3)) }]);
    expect(await candidates({ limit: 3 })).toEqual([rowB, rowC, rowA]);

    // B と C を A より後に試した。次は印の古い A が先に戻る (残り続ける利用者が毎回先頭にならない)
    await markAttempted([b.id, c.id], at(-2));
    expect(await candidates({ limit: 3 })).toEqual([rowA, rowB, rowC]);
  });

  // 45
  it('billing_iap_reconcile_mark_attempted sets attempted_at = p_attempted_at, keeps the later time when called again with an earlier one (GREATEST), writes a duplicated id once, skips ids that are not in auth.users without error, raises 22023 for NULL arguments and for 201 ids, and anon and authenticated cannot execute it (42501)', async () => {
    const u1 = await createUser('m45-u1');
    const u2 = await createUser('m45-u2');
    const authenticatedUser = await createUser('m45-auth', { jwt: true });
    const ids = [u1.id, u2.id];
    const ghost = randomUUID(); // auth.users に無い利用者 (取り直しの最中に退会した利用者)

    // 同じ ID が 2 度あっても 1 回だけ書く。auth.users に無い利用者は飛ばす (外部キーの違反にしない)
    await markAttempted([u1.id, u1.id, u2.id, ghost], at(-3));
    expect(await attemptsOf(ids)).toEqual(
      [{ userId: u1.id, attemptedAtMs: ms(at(-3)) }, { userId: u2.id, attemptedAtMs: ms(at(-3)) }].sort(byUserId),
    );
    const ghostRows = await attemptsOf([ghost]);
    expect(ghostRows).toEqual([]);

    // 早い時刻で呼び直しても、新しい方 (at(-3)) を残す (GREATEST)
    await markAttempted([u1.id], at(-5));
    expect((await attemptsOf([u1.id]))[0]?.attemptedAtMs).toBe(ms(at(-3)));
    // 新しい時刻なら進む
    await markAttempted([u1.id], at(-1));
    expect((await attemptsOf([u1.id]))[0]?.attemptedAtMs).toBe(ms(at(-1)));
    expect((await attemptsOf([u2.id]))[0]?.attemptedAtMs).toBe(ms(at(-3)));

    // 空の配列は何も書かず、エラーにもしない
    expect((await tryMarkAttempted([], at(0))).error).toBeNull();

    // 引数の検査 (22023)
    expect((await tryMarkAttempted(null, at(0))).error?.code).toBe('22023');
    expect((await tryMarkAttempted([u1.id], null)).error?.code).toBe('22023');
    const tooMany = Array.from({ length: C_MAX_USERS + 1 }, () => randomUUID());
    expect((await tryMarkAttempted(tooMany, at(0))).error?.code).toBe('22023');
    // 境界 (c_max_users 件) は通る (どれも auth.users に無いので何も書かれない)
    expect((await tryMarkAttempted(tooMany.slice(0, C_MAX_USERS), at(0))).error).toBeNull();

    // anon・authenticated は実行できない。service_role も表へ直接は書けない (SELECT だけ)
    expect((await tryMarkAttempted([u1.id], at(0), anon())).error?.code).toBe('42501');
    expect((await tryMarkAttempted([u1.id], at(0), asUser(authenticatedUser.jwt!))).error?.code).toBe('42501');
    const direct = await srAdmin.from('iap_reconcile_attempts').insert({ user_id: u1.id, attempted_at: at(0) });
    expect(direct.error?.code).toBe('42501');
    const directUpdate = await srAdmin.from('iap_reconcile_attempts').update({ attempted_at: at(0) }).eq('user_id', u1.id);
    expect(directUpdate.error?.code).toBe('42501');
    // 書き込みが拒まれた後も、印は変わっていない
    expect((await attemptsOf([u1.id]))[0]?.attemptedAtMs).toBe(ms(at(-1)));
  });
});
