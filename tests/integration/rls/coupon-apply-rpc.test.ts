/**
 * #1224 クーポン適用 (public.apply_coupon RPC / applyCoupon) の競合・原子性・権限の回帰テスト
 *
 * 背景 (修正前):
 *   applyCoupon() は coupons.max_uses だけを楽観ロック (CAS) で原子化していた。per_user_limit と組織単位の上限は
 *   「redemption を COUNT -> JS で比較 -> INSERT」という check-then-act で、同じクーポン・同じユーザー
 *   (別々の契約宛) への適用が同時に来ると、どちらも COUNT を通って per_user_limit=1 でも 2 件できた。
 *   また「旧 redemption の終了 -> 新規 INSERT」が別々の HTTP 呼び出しで、INSERT が失敗すると
 *   旧 redemption だけが終了したまま、新しいものが無い状態が残った。
 *
 * 修正後:
 *   検証 -> uses_count 加算 -> 旧 redemption の終了 -> 新規 INSERT -> personal_subscriptions 更新を、
 *   DB 関数 apply_coupon の 1 トランザクションで行う。coupons 行を FOR UPDATE でロックして同じクーポンの適用を直列化し、
 *   対象の契約行もロックして「同じ契約への別クーポンの同時適用」も直列化する。
 *   EXECUTE は service_role だけ (anon / authenticated は 42501)。
 *
 * このテストが固定するもの:
 *   - 競合: 残り 1 回のところへ同時に来ても成功は 1 件だけ (per_user_limit / 組織上限 / max_uses の 3 種類)
 *   - 同じ契約への別クーポンの同時適用は、どちらも成功し、有効な redemption は 1 件だけ残る (UNIQUE 違反を漏らさない)
 *   - 原子性: INSERT が失敗したら、uses_count も旧 redemption の終了も契約の参照も全部なかったことになる
 *   - 従来の API の挙動 (エラーコード・メッセージ・検証の順序・redemption の中身・割引額) を変えていない
 *     (applyCoupon を経由して検証するので、修正前の実装でも同じ期待値で通る部分は「挙動を変えていない」ことの確認になる)
 *   - anon / authenticated は RPC を呼べない (42501)。引数が不正なら 22023
 *
 * 契約の「live」状態 (trialing / active / paused / past_due / grace) は 1 ユーザー 1 件の部分 UNIQUE があるため、
 * 同じユーザーに複数の契約を持たせる箇所では cancelled / expired を使う (applyCoupon は契約の状態を見ない)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/coupon-apply-rpc.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { applyCoupon, CouponApplyError, type ApplyCouponResult } from '@/lib/plan/coupon';

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
// クライアントファクトリ (native-bridge-codes.test.ts と同型)
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
// フィクスチャ
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls';
/** 同時に投げる本数。残り 1 回の枠を取り合う */
const CONCURRENCY = 8;

interface TestUser {
  userId: string;
  jwt: string;
}

interface PlanRow {
  id: string;
  plan_key: string;
  monthly_price_jpy: number | null;
}

const createdUserIds: string[] = [];
const createdCouponIds: string[] = [];
const createdSubscriptionIds: string[] = [];
const createdOrgIds: string[] = [];
let seq = 0;

async function createTestUser(label: string): Promise<TestUser> {
  const email = `rls-1224-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signIn = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`Failed to sign in ${email}: ${signIn.error?.message}`);
  }
  return { userId, jwt: signIn.data.session.access_token };
}

async function getPlan(planKey: string): Promise<PlanRow> {
  const { data, error } = await srAdmin
    .from('subscription_plans')
    .select('id, plan_key, monthly_price_jpy')
    .eq('plan_key', planKey)
    .single();
  if (error || !data) throw new Error(`subscription_plans.${planKey} が無い (ベースラインの参照データが必要): ${error?.message}`);
  return data as PlanRow;
}

let approver: TestUser; // approved_by / created_by
let userA: TestUser;
let userB: TestUser;
let proPlan: PlanRow; // personal, 月額 980 円 (参照データ)
let freePlan: PlanRow; // personal, 月額 0 円
let orgStandardPlan: PlanRow; // org, 月額 980 円
let orgEnterprisePlan: PlanRow; // org, 月額 NULL

interface CouponOverrides {
  discount_type?: 'fixed' | 'percentage';
  discount_value?: number;
  applicable_to?: 'all' | 'personal' | 'family' | 'org';
  applicable_plans?: string[];
  valid_from?: string;
  valid_until?: string;
  max_uses?: number | null;
  per_user_limit?: number;
  duration_months?: number | null;
  status?: 'active' | 'paused' | 'expired';
}

interface CouponRow {
  id: string;
  code: string;
}

async function createCoupon(overrides: CouponOverrides = {}): Promise<CouponRow> {
  const code = `T1224-${TS}-${++seq}`;
  const { data, error } = await srAdmin
    .from('coupons')
    .insert({
      code,
      display_name: `#1224 test ${code}`,
      discount_type: 'fixed',
      discount_value: 300,
      applicable_to: 'all',
      applicable_plans: [],
      valid_from: new Date(Date.now() - 86_400_000).toISOString(),
      valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      max_uses: null,
      per_user_limit: 1,
      duration_months: null,
      status: 'active',
      created_by: approver.userId,
      ...overrides,
    })
    .select('id, code')
    .single();
  if (error || !data) throw new Error(`failed to create coupon: ${error?.message}`);
  createdCouponIds.push(data.id);
  return data as CouponRow;
}

async function createSubscription(
  userId: string,
  planKey: string = 'pro',
  status: 'cancelled' | 'expired' = 'expired',
): Promise<string> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .insert({ user_id: userId, plan_key: planKey, status })
    .select('id')
    .single();
  if (error || !data) throw new Error(`failed to create personal_subscriptions: ${error?.message}`);
  createdSubscriptionIds.push(data.id);
  return data.id as string;
}

async function createOrg(plan: string | null): Promise<string> {
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `T1224 org ${TS}-${++seq}`, plan })
    .select('id')
    .single();
  if (error || !data) throw new Error(`failed to create organizations: ${error?.message}`);
  createdOrgIds.push(data.id);
  return data.id as string;
}

async function usesCount(couponId: string): Promise<number> {
  const { data, error } = await srAdmin.from('coupons').select('uses_count').eq('id', couponId).single();
  if (error || !data) throw new Error(`select coupons.uses_count: ${error?.message}`);
  return data.uses_count as number;
}

interface RedemptionRow {
  id: string;
  coupon_id: string;
  user_id: string | null;
  organization_id: string | null;
  subscription_target: string;
  applied_to_subscription_id: string;
  discount_amount_jpy: number;
  duration_months: number | null;
  ended_at: string | null;
  end_reason: string | null;
  applied_retroactively: boolean;
  approved_by: string | null;
}

async function redemptionRows(couponId: string): Promise<RedemptionRow[]> {
  const { data, error } = await srAdmin
    .from('coupon_redemptions')
    .select('*')
    .eq('coupon_id', couponId)
    .order('redeemed_at', { ascending: true });
  if (error) throw new Error(`select coupon_redemptions: ${error.message}`);
  return (data ?? []) as RedemptionRow[];
}

async function activePointer(subscriptionId: string): Promise<string | null> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .select('active_coupon_redemption_id')
    .eq('id', subscriptionId)
    .single();
  if (error || !data) throw new Error(`select personal_subscriptions: ${error?.message}`);
  return data.active_coupon_redemption_id as string | null;
}

function apply(
  couponId: string,
  target: 'personal' | 'org',
  subscriptionId: string,
  approvedBy: string = approver.userId,
): Promise<ApplyCouponResult> {
  return applyCoupon(srAdmin, { couponId, subscriptionTarget: target, subscriptionId, approvedBy });
}

/** 失敗の種類を文字列にする。業務エラーは code、それ以外は生のエラー (SQLSTATE かメッセージ) */
function describeRejection(reason: unknown): string {
  if (reason instanceof CouponApplyError) return reason.code;
  const raw = reason as { code?: string; message?: string } | null;
  return `raw:${raw?.code ?? raw?.message ?? String(reason)}`;
}

function summarize(results: PromiseSettledResult<ApplyCouponResult>[]) {
  const fulfilled = results.filter((r): r is PromiseFulfilledResult<ApplyCouponResult> => r.status === 'fulfilled');
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  return { fulfilled, rejectedKinds: rejected.map((r) => describeRejection(r.reason)) };
}

beforeAll(async () => {
  [approver, userA, userB] = await Promise.all([
    createTestUser('approver'),
    createTestUser('a'),
    createTestUser('b'),
  ]);
  [proPlan, freePlan, orgStandardPlan, orgEnterprisePlan] = await Promise.all([
    getPlan('pro'),
    getPlan('free'),
    getPlan('org_standard'),
    getPlan('org_enterprise'),
  ]);
}, 60_000);

afterAll(async () => {
  // 子 -> 親の順に消す。coupon_redemptions.user_id / approved_by は auth.users を NO ACTION で参照するため、
  // ユーザーを消す前に redemption とクーポンを消す。契約は active_coupon_redemption_id で redemption を参照するので先に消す。
  if (createdSubscriptionIds.length > 0) {
    await srAdmin.from('personal_subscriptions').delete().in('id', createdSubscriptionIds);
  }
  if (createdCouponIds.length > 0) {
    await srAdmin.from('coupon_redemptions').delete().in('coupon_id', createdCouponIds);
    await srAdmin.from('coupons').delete().in('id', createdCouponIds);
  }
  if (createdOrgIds.length > 0) {
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

// ================================================================
// 競合: 残り 1 回のところへ同時に来ても、成功は 1 件だけ
// ================================================================
describe('#1224 競合: 上限の残りが 1 回のとき、同時に適用しても成功は 1 件だけ', () => {
  it('C-1: per_user_limit=1 のクーポンを、同じユーザーの別々の契約 8 件宛に同時に適用しても、成功は 1 本だけ (issue の再現)', async () => {
    const coupon = await createCoupon({ per_user_limit: 1 });
    // 旧契約 (解約済み) と新契約のように、同じユーザーが複数の契約を持つ。
    // 別々の契約宛は idx_coupon_redemptions_active_per_subscription では弾かれず、契約行のロックでも直列化されない
    const subs = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => createSubscription(userA.userId, 'pro', i % 2 === 0 ? 'cancelled' : 'expired')),
    );

    const results = await Promise.allSettled(subs.map((subscriptionId) => apply(coupon.id, 'personal', subscriptionId)));
    const { fulfilled, rejectedKinds } = summarize(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejectedKinds).toEqual(Array(CONCURRENCY - 1).fill('OP_COUPON_LIMIT_REACHED'));
    // DB に残っているのも 1 件だけ。失敗した分の uses_count は戻る
    expect(await redemptionRows(coupon.id)).toHaveLength(1);
    expect(await usesCount(coupon.id)).toBe(1);
  });

  it('C-2: per_user_limit=3 で 2 回使用済み (残り 1 回) のとき、別々の契約 8 件宛に同時に適用しても成功は 1 本だけ', async () => {
    const coupon = await createCoupon({ per_user_limit: 3 });
    const subs = await Promise.all(Array.from({ length: CONCURRENCY }, () => createSubscription(userA.userId)));
    // 同じ契約へ 2 回。1 回目の redemption は 2 回目で置き換えられて終了するが、利用回数には数える
    await apply(coupon.id, 'personal', subs[0]);
    await apply(coupon.id, 'personal', subs[0]);
    expect(await usesCount(coupon.id)).toBe(2);

    // 使用済みの契約 (subs[0]) も含めて 8 件宛に同時に投げる
    const results = await Promise.allSettled(subs.map((subscriptionId) => apply(coupon.id, 'personal', subscriptionId)));
    const { fulfilled, rejectedKinds } = summarize(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejectedKinds).toEqual(Array(CONCURRENCY - 1).fill('OP_COUPON_LIMIT_REACHED'));
    expect(await redemptionRows(coupon.id)).toHaveLength(3);
    expect(await usesCount(coupon.id)).toBe(3);
  });

  it('C-3: 組織の上限 (per_user_limit=1) のクーポンを、同じ組織へ 8 本同時に適用しても、成功は 1 本だけ', async () => {
    const coupon = await createCoupon({ per_user_limit: 1, applicable_to: 'org' });
    const orgId = await createOrg(orgStandardPlan.plan_key);

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => apply(coupon.id, 'org', orgId)),
    );
    const { fulfilled, rejectedKinds } = summarize(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejectedKinds).toEqual(Array(CONCURRENCY - 1).fill('OP_COUPON_LIMIT_REACHED'));
    expect(await redemptionRows(coupon.id)).toHaveLength(1);
    expect(await usesCount(coupon.id)).toBe(1);
  });

  it('C-4: max_uses=3 で 2 回使用済み (残り 1 回) のとき、別々の契約へ 8 本同時に適用しても成功は 1 本だけ', async () => {
    // per_user_limit は大きくして、max_uses だけが効く状態にする
    const coupon = await createCoupon({ max_uses: 3, per_user_limit: 100 });
    const subs = await Promise.all(Array.from({ length: CONCURRENCY + 2 }, () => createSubscription(userA.userId)));
    await apply(coupon.id, 'personal', subs[0]);
    await apply(coupon.id, 'personal', subs[1]);
    expect(await usesCount(coupon.id)).toBe(2);

    const results = await Promise.allSettled(
      subs.slice(2).map((subscriptionId) => apply(coupon.id, 'personal', subscriptionId)),
    );
    const { fulfilled, rejectedKinds } = summarize(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejectedKinds).toEqual(Array(CONCURRENCY - 1).fill('OP_COUPON_LIMIT_REACHED'));
    expect(await usesCount(coupon.id)).toBe(3);
    expect(await redemptionRows(coupon.id)).toHaveLength(3);
  });

  it('C-5: 異なるユーザー同士なら per_user_limit=1 でも並列に成功する (直列化は同じクーポンの範囲だけで、ユーザーごとの枠は別)', async () => {
    const coupon = await createCoupon({ per_user_limit: 1 });
    const subA = await createSubscription(userA.userId);
    const subB = await createSubscription(userB.userId);

    const results = await Promise.allSettled([
      apply(coupon.id, 'personal', subA),
      apply(coupon.id, 'personal', subB),
      apply(coupon.id, 'personal', subA),
      apply(coupon.id, 'personal', subB),
    ]);
    const { fulfilled, rejectedKinds } = summarize(results);

    // A と B で 1 件ずつ。残りの 2 本は各ユーザーの枠が埋まっているので上限エラー
    expect(fulfilled).toHaveLength(2);
    expect(rejectedKinds).toEqual(['OP_COUPON_LIMIT_REACHED', 'OP_COUPON_LIMIT_REACHED']);
    const rows = await redemptionRows(coupon.id);
    expect(rows.map((r) => r.user_id).sort()).toEqual([userA.userId, userB.userId].sort());
    expect(await usesCount(coupon.id)).toBe(2);
  });

  it('C-6: 同じクーポンを同じ契約宛に 8 本同時に適用しても、成功は 1 本だけ。負けた側は UNIQUE 違反 (23505) ではなく上限エラー', async () => {
    const coupon = await createCoupon({ per_user_limit: 1 });
    const subscriptionId = await createSubscription(userA.userId);

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => apply(coupon.id, 'personal', subscriptionId)),
    );
    const { fulfilled, rejectedKinds } = summarize(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejectedKinds).toEqual(Array(CONCURRENCY - 1).fill('OP_COUPON_LIMIT_REACHED'));
    const rows = await redemptionRows(coupon.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].ended_at).toBeNull();
    expect(await activePointer(subscriptionId)).toBe(rows[0].id);
    expect(await usesCount(coupon.id)).toBe(1);
  });

  it('C-7: 同じ契約へ別々のクーポン 8 件を同時に適用すると、全部成功し、有効な redemption は 1 件だけ残る (UNIQUE 違反を漏らさない)', async () => {
    const coupons = await Promise.all(Array.from({ length: CONCURRENCY }, () => createCoupon({ per_user_limit: 1 })));
    const subscriptionId = await createSubscription(userA.userId);

    const results = await Promise.allSettled(coupons.map((coupon) => apply(coupon.id, 'personal', subscriptionId)));
    const { fulfilled, rejectedKinds } = summarize(results);

    // idx_coupon_redemptions_active_per_subscription (23505) が表に出ず、後から来た方が先の方を置き換える
    expect(rejectedKinds).toEqual([]);
    expect(fulfilled).toHaveLength(CONCURRENCY);

    const rows = (await Promise.all(coupons.map((coupon) => redemptionRows(coupon.id)))).flat();
    expect(rows).toHaveLength(CONCURRENCY);
    const active = rows.filter((r) => r.ended_at === null);
    const ended = rows.filter((r) => r.ended_at !== null);
    expect(active).toHaveLength(1);
    expect(ended).toHaveLength(CONCURRENCY - 1);
    expect(ended.every((r) => r.end_reason === 'replaced_by_other_coupon')).toBe(true);
    expect(await activePointer(subscriptionId)).toBe(active[0].id);
    for (const coupon of coupons) expect(await usesCount(coupon.id)).toBe(1);
  });
});

// ================================================================
// 原子性: 途中で失敗したら全部なかったことになる
// ================================================================
describe('#1224 原子性: 新規 redemption の INSERT が失敗したら、ほかの変更も全部なかったことになる', () => {
  it('T-1: 存在しない承認者 (approved_by の外部キー違反 23503) で失敗しても、uses_count・旧 redemption・契約の参照は変わらない', async () => {
    const coupon = await createCoupon({ per_user_limit: 5 });
    const subscriptionId = await createSubscription(userA.userId);
    const first = await apply(coupon.id, 'personal', subscriptionId);
    expect(await usesCount(coupon.id)).toBe(1);

    // 修正前は「旧 redemption を終了 -> INSERT 失敗」の順に別呼び出しで走るため、旧 redemption だけが終了したままになった
    await expect(
      apply(coupon.id, 'personal', subscriptionId, '00000000-0000-4000-8000-000000001224'),
    ).rejects.toMatchObject({ code: '23503' });

    expect(await usesCount(coupon.id)).toBe(1);
    const rows = await redemptionRows(coupon.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.redemptionId, ended_at: null, end_reason: null });
    expect(await activePointer(subscriptionId)).toBe(first.redemptionId);
  });
});

// ================================================================
// 従来の API の挙動 (エラーコード・メッセージ・検証の順序) を変えていない
// ================================================================
describe('#1224 業務エラー: エラーコードとメッセージは従来どおり', () => {
  interface Arranged {
    couponId: string;
    target: 'personal' | 'org';
    subscriptionId: string;
  }
  interface ErrorCase {
    name: string;
    arrange: () => Promise<Arranged>;
    code: string;
    message: string;
  }

  const personalCoupon = async (overrides: CouponOverrides = {}): Promise<Arranged> => {
    const coupon = await createCoupon(overrides);
    return { couponId: coupon.id, target: 'personal', subscriptionId: await createSubscription(userA.userId) };
  };
  const orgCoupon = async (overrides: CouponOverrides = {}, orgPlan: string | null = 'org_standard'): Promise<Arranged> => {
    const coupon = await createCoupon({ applicable_to: 'org', ...overrides });
    return { couponId: coupon.id, target: 'org', subscriptionId: await createOrg(orgPlan) };
  };

  const cases: ErrorCase[] = [
    {
      name: '存在しないクーポン',
      arrange: async () => ({ couponId: randomUUID(), target: 'personal', subscriptionId: await createSubscription(userA.userId) }),
      code: 'OP_COUPON_NOT_FOUND',
      message: 'クーポンが見つかりません',
    },
    {
      name: 'status が active でない (paused)',
      arrange: () => personalCoupon({ status: 'paused' }),
      code: 'OP_COUPON_INVALID',
      message: 'クーポンが有効な状態ではありません',
    },
    {
      name: '有効開始日の前',
      arrange: () => personalCoupon({ valid_from: new Date(Date.now() + 86_400_000).toISOString() }),
      code: 'OP_COUPON_NOT_YET_VALID',
      message: 'クーポンの有効開始日前です',
    },
    {
      name: '有効期限切れ',
      arrange: () =>
        personalCoupon({
          valid_from: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          valid_until: new Date(Date.now() - 86_400_000).toISOString(),
        }),
      code: 'OP_COUPON_EXPIRED',
      message: 'クーポンの有効期限が切れています',
    },
    {
      name: 'org 専用のクーポンを personal 契約へ',
      arrange: () => personalCoupon({ applicable_to: 'org' }),
      code: 'OP_COUPON_NOT_APPLICABLE',
      message: 'このクーポンは指定の契約種別には適用できません',
    },
    {
      name: 'personal 専用のクーポンを組織へ',
      arrange: () => orgCoupon({ applicable_to: 'personal' }),
      code: 'OP_COUPON_NOT_APPLICABLE',
      message: 'このクーポンは指定の契約種別には適用できません',
    },
    {
      name: 'family 専用のクーポンを組織へ',
      arrange: () => orgCoupon({ applicable_to: 'family' }),
      code: 'OP_COUPON_NOT_APPLICABLE',
      message: 'このクーポンは指定の契約種別には適用できません',
    },
    {
      name: 'applicable_plans に契約のプランが含まれない',
      arrange: () => personalCoupon({ applicable_plans: [orgStandardPlan.id] }),
      code: 'OP_COUPON_NOT_APPLICABLE',
      message: 'このクーポンは対象プランに適用できません',
    },
    {
      name: '存在しない個人契約',
      arrange: async () => ({ couponId: (await createCoupon()).id, target: 'personal', subscriptionId: randomUUID() }),
      code: 'OP_SUBSCRIPTION_NOT_FOUND',
      message: '契約が見つかりません',
    },
    {
      name: '存在しない組織',
      arrange: async () => ({
        couponId: (await createCoupon({ applicable_to: 'org' })).id,
        target: 'org',
        subscriptionId: randomUUID(),
      }),
      code: 'OP_SUBSCRIPTION_NOT_FOUND',
      message: '契約 (組織) が見つかりません',
    },
    {
      name: '組織に契約プランが設定されていない (plan が NULL)',
      arrange: () => orgCoupon({}, null),
      code: 'OP_PLAN_NOT_FOUND',
      message: '組織に契約プランが設定されていません',
    },
    {
      name: '組織のプランが subscription_plans に無い',
      arrange: () => orgCoupon({}, 'no_such_plan_1224'),
      code: 'OP_PLAN_NOT_FOUND',
      message: '契約先プランが見つかりません',
    },
    {
      name: '検証の順序: 期限切れと適用対象外が重なったら期限切れが先',
      arrange: () =>
        personalCoupon({
          applicable_to: 'org',
          valid_from: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          valid_until: new Date(Date.now() - 86_400_000).toISOString(),
        }),
      code: 'OP_COUPON_EXPIRED',
      message: 'クーポンの有効期限が切れています',
    },
    {
      name: '検証の順序: 存在しない契約と applicable_plans 不一致が重なったら契約なしが先',
      arrange: async () => ({
        couponId: (await createCoupon({ applicable_plans: [orgStandardPlan.id] })).id,
        target: 'personal',
        subscriptionId: randomUUID(),
      }),
      code: 'OP_SUBSCRIPTION_NOT_FOUND',
      message: '契約が見つかりません',
    },
  ];

  for (const c of cases) {
    it(`B-1: ${c.name} -> ${c.code}。何も書き込まない`, async () => {
      const arranged = await c.arrange();
      const before = await usesCount(arranged.couponId).catch(() => null);

      const promise = apply(arranged.couponId, arranged.target, arranged.subscriptionId);
      await expect(promise).rejects.toBeInstanceOf(CouponApplyError);
      await expect(promise).rejects.toMatchObject({ code: c.code, message: c.message });

      // 失敗では uses_count も redemption も契約の参照も動かない
      expect(await usesCount(arranged.couponId).catch(() => null)).toBe(before);
      expect(await redemptionRows(arranged.couponId)).toEqual([]);
      if (arranged.target === 'personal') {
        const { data } = await srAdmin
          .from('personal_subscriptions')
          .select('active_coupon_redemption_id')
          .eq('id', arranged.subscriptionId)
          .maybeSingle();
        if (data) expect(data.active_coupon_redemption_id).toBeNull();
      }
    });
  }

  it('B-2: per_user_limit に達したユーザーは OP_COUPON_LIMIT_REACHED (ユーザー向けのメッセージ)。uses_count は増えない', async () => {
    const coupon = await createCoupon({ per_user_limit: 1 });
    const sub1 = await createSubscription(userA.userId, 'pro', 'cancelled');
    const sub2 = await createSubscription(userA.userId);
    await apply(coupon.id, 'personal', sub1);

    await expect(apply(coupon.id, 'personal', sub2)).rejects.toMatchObject({
      code: 'OP_COUPON_LIMIT_REACHED',
      message: 'このユーザーはクーポンの利用上限に達しています',
    });
    expect(await usesCount(coupon.id)).toBe(1);
    expect(await redemptionRows(coupon.id)).toHaveLength(1);
    expect(await activePointer(sub2)).toBeNull();
  });

  it('B-3: 利用回数は終了した (置き換えられた) redemption も数える', async () => {
    const coupon = await createCoupon({ per_user_limit: 1 });
    const subscriptionId = await createSubscription(userA.userId);
    await apply(coupon.id, 'personal', subscriptionId);
    // 同じ契約への 2 回目: 1 件目は置き換えで終了済みでも、利用回数は 1 回と数えるので上限
    await expect(apply(coupon.id, 'personal', subscriptionId)).rejects.toMatchObject({
      code: 'OP_COUPON_LIMIT_REACHED',
    });
    const rows = await redemptionRows(coupon.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].ended_at).toBeNull();
  });

  it('B-4: 組織の上限に達した組織は OP_COUPON_LIMIT_REACHED (組織向けのメッセージ)', async () => {
    const coupon = await createCoupon({ per_user_limit: 1, applicable_to: 'org' });
    const orgId = await createOrg(orgStandardPlan.plan_key);
    await apply(coupon.id, 'org', orgId);

    await expect(apply(coupon.id, 'org', orgId)).rejects.toMatchObject({
      code: 'OP_COUPON_LIMIT_REACHED',
      message: 'この組織はクーポンの利用上限に達しています',
    });
    expect(await usesCount(coupon.id)).toBe(1);
  });

  it('B-5: max_uses に達したクーポンは OP_COUPON_LIMIT_REACHED (クーポン向けのメッセージ)。uses_count は増えない', async () => {
    const coupon = await createCoupon({ max_uses: 1, per_user_limit: 100 });
    await apply(coupon.id, 'personal', await createSubscription(userA.userId));

    await expect(apply(coupon.id, 'personal', await createSubscription(userB.userId))).rejects.toMatchObject({
      code: 'OP_COUPON_LIMIT_REACHED',
      message: 'クーポンの利用上限に達しています',
    });
    expect(await usesCount(coupon.id)).toBe(1);
  });

  it('B-6: 検証の順序: ユーザーの上限と max_uses が両方埋まっているときは、ユーザーの上限が先', async () => {
    const coupon = await createCoupon({ max_uses: 1, per_user_limit: 1 });
    const sub1 = await createSubscription(userA.userId, 'pro', 'cancelled');
    const sub2 = await createSubscription(userA.userId);
    await apply(coupon.id, 'personal', sub1);

    await expect(apply(coupon.id, 'personal', sub2)).rejects.toMatchObject({
      code: 'OP_COUPON_LIMIT_REACHED',
      message: 'このユーザーはクーポンの利用上限に達しています',
    });
  });
});

// ================================================================
// 成功時の中身: redemption・契約の参照・割引額
// ================================================================
describe('#1224 成功時: redemption の中身・契約の参照・割引額は従来どおり', () => {
  it('S-1: personal 契約へ適用すると、redemption が 1 件でき、契約の active_coupon_redemption_id と uses_count が更新される', async () => {
    const coupon = await createCoupon({ discount_value: 300, duration_months: 3 });
    const subscriptionId = await createSubscription(userA.userId);

    const result = await apply(coupon.id, 'personal', subscriptionId);

    expect(result).toEqual({ redemptionId: expect.any(String), discountAmountJpy: 300, durationMonths: 3 });
    const rows = await redemptionRows(coupon.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.redemptionId,
      coupon_id: coupon.id,
      user_id: userA.userId,
      organization_id: null,
      subscription_target: 'personal',
      applied_to_subscription_id: subscriptionId,
      discount_amount_jpy: 300,
      duration_months: 3,
      ended_at: null,
      end_reason: null,
      applied_retroactively: true,
      approved_by: approver.userId,
    });
    expect(await activePointer(subscriptionId)).toBe(result.redemptionId);
    expect(await usesCount(coupon.id)).toBe(1);
  });

  it('S-2: 組織へ適用すると、organization_id に組織が入り user_id は NULL。applied_to_subscription_id は組織の ID', async () => {
    const coupon = await createCoupon({ applicable_to: 'org', discount_value: 100 });
    const orgId = await createOrg(orgStandardPlan.plan_key);

    const result = await apply(coupon.id, 'org', orgId);

    expect(result).toEqual({ redemptionId: expect.any(String), discountAmountJpy: 100, durationMonths: null });
    const rows = await redemptionRows(coupon.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.redemptionId,
      user_id: null,
      organization_id: orgId,
      subscription_target: 'org',
      applied_to_subscription_id: orgId,
      applied_retroactively: true,
      approved_by: approver.userId,
      ended_at: null,
    });
    expect(await usesCount(coupon.id)).toBe(1);
  });

  it('S-3: applicable_to=family のクーポンは個人契約に適用できる。applicable_to=all は組織にも個人にも適用できる', async () => {
    const familyCoupon = await createCoupon({ applicable_to: 'family' });
    const personalCoupon = await createCoupon({ applicable_to: 'personal' });
    const allCoupon = await createCoupon({ applicable_to: 'all' });
    const sub = await createSubscription(userA.userId);
    const org = await createOrg(orgStandardPlan.plan_key);

    await expect(apply(familyCoupon.id, 'personal', sub)).resolves.toMatchObject({ discountAmountJpy: 300 });
    await expect(apply(personalCoupon.id, 'personal', await createSubscription(userA.userId))).resolves.toBeDefined();
    await expect(apply(allCoupon.id, 'org', org)).resolves.toBeDefined();
    await expect(apply(allCoupon.id, 'personal', await createSubscription(userB.userId))).resolves.toBeDefined();
  });

  it('S-4: applicable_plans に契約のプランが含まれていれば適用できる', async () => {
    const coupon = await createCoupon({ applicable_plans: [proPlan.id, orgStandardPlan.id] });
    await expect(apply(coupon.id, 'personal', await createSubscription(userA.userId))).resolves.toBeDefined();
  });

  const discountCases: Array<{
    name: string;
    coupon: CouponOverrides;
    planKey: string;
    expected: (price: number) => number;
  }> = [
    { name: '定額: 価格より小さい', coupon: { discount_type: 'fixed', discount_value: 300 }, planKey: 'pro', expected: () => 300 },
    { name: '定額: 価格を超える額は価格まで', coupon: { discount_type: 'fixed', discount_value: 5000 }, planKey: 'pro', expected: (p) => p },
    { name: '定率: 小数は切り捨て (980 円の 33% = 323.4 -> 323)', coupon: { discount_type: 'percentage', discount_value: 33 }, planKey: 'pro', expected: (p) => Math.floor((p * 33) / 100) },
    { name: '定率: 10%', coupon: { discount_type: 'percentage', discount_value: 10 }, planKey: 'pro', expected: (p) => Math.floor((p * 10) / 100) },
    { name: '定率: 100% は価格まで', coupon: { discount_type: 'percentage', discount_value: 100 }, planKey: 'pro', expected: (p) => p },
    { name: '価格が 0 円のプランは 0 円', coupon: { discount_type: 'fixed', discount_value: 100 }, planKey: 'free', expected: () => 0 },
  ];

  for (const c of discountCases) {
    it(`S-5: 割引額 (${c.name})`, async () => {
      const coupon = await createCoupon(c.coupon);
      const subscriptionId = await createSubscription(userA.userId, c.planKey);
      const price = (c.planKey === 'free' ? freePlan : proPlan).monthly_price_jpy ?? 0;

      const result = await apply(coupon.id, 'personal', subscriptionId);

      expect(result.discountAmountJpy).toBe(c.expected(price));
      expect((await redemptionRows(coupon.id))[0].discount_amount_jpy).toBe(c.expected(price));
    });
  }

  it('S-6: 月額が NULL のプラン (org_enterprise) の組織は割引額 0 円', async () => {
    expect(orgEnterprisePlan.monthly_price_jpy).toBeNull();
    const coupon = await createCoupon({ applicable_to: 'org', discount_type: 'fixed', discount_value: 500 });
    const orgId = await createOrg(orgEnterprisePlan.plan_key);

    const result = await apply(coupon.id, 'org', orgId);

    expect(result.discountAmountJpy).toBe(0);
  });

  it('S-7: 同じ契約へ別のクーポンを適用すると、旧 redemption が replaced_by_other_coupon で終了し、契約の参照が新しい方に移る', async () => {
    const couponX = await createCoupon();
    const couponY = await createCoupon({ discount_value: 500 });
    const subscriptionId = await createSubscription(userA.userId);

    const first = await apply(couponX.id, 'personal', subscriptionId);
    expect(await activePointer(subscriptionId)).toBe(first.redemptionId);
    const second = await apply(couponY.id, 'personal', subscriptionId);

    const [rowX] = await redemptionRows(couponX.id);
    const [rowY] = await redemptionRows(couponY.id);
    expect(rowX).toMatchObject({ id: first.redemptionId, end_reason: 'replaced_by_other_coupon' });
    expect(rowX.ended_at).not.toBeNull();
    expect(rowY).toMatchObject({ id: second.redemptionId, ended_at: null, end_reason: null });
    expect(await activePointer(subscriptionId)).toBe(second.redemptionId);
    // 置き換えられた側の uses_count は戻さない (従来どおり)
    expect(await usesCount(couponX.id)).toBe(1);
    expect(await usesCount(couponY.id)).toBe(1);
  });

  it('S-8: 別の契約の redemption は終了させない', async () => {
    const coupon = await createCoupon({ per_user_limit: 5 });
    const subA = await createSubscription(userA.userId);
    const subB = await createSubscription(userA.userId);

    await apply(coupon.id, 'personal', subA);
    await apply(coupon.id, 'personal', subB);

    const rows = await redemptionRows(coupon.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ended_at === null)).toBe(true);
  });
});

// ================================================================
// 権限と引数の検証 (RPC を直接呼ぶ)
// ================================================================
describe('#1224 apply_coupon RPC: 権限と引数の検証', () => {
  it('P-1: anon は apply_coupon を呼べない (42501)。何も書き込まれない', async () => {
    const coupon = await createCoupon();
    const subscriptionId = await createSubscription(userA.userId);

    const res = await anonClient().rpc('apply_coupon', {
      p_coupon_id: coupon.id,
      p_target: 'personal',
      p_subscription_id: subscriptionId,
      p_approved_by: approver.userId,
    });

    expect(res.error?.code).toBe('42501');
    expect(await redemptionRows(coupon.id)).toEqual([]);
    expect(await usesCount(coupon.id)).toBe(0);
  });

  it('P-2: authenticated (ログイン済みの一般ユーザー) も apply_coupon を呼べない (42501)。自分の契約でも同じ', async () => {
    const coupon = await createCoupon();
    const subscriptionId = await createSubscription(userA.userId);

    const res = await authedClient(userA.jwt).rpc('apply_coupon', {
      p_coupon_id: coupon.id,
      p_target: 'personal',
      p_subscription_id: subscriptionId,
      p_approved_by: userA.userId,
    });

    expect(res.error?.code).toBe('42501');
    expect(await redemptionRows(coupon.id)).toEqual([]);
    expect(await usesCount(coupon.id)).toBe(0);
    expect(await activePointer(subscriptionId)).toBeNull();
  });

  it('P-3: service_role は呼べて、redemption_id / discount_amount_jpy / duration_months を返す', async () => {
    const coupon = await createCoupon({ duration_months: 2 });
    const subscriptionId = await createSubscription(userA.userId);

    const res = await srAdmin.rpc('apply_coupon', {
      p_coupon_id: coupon.id,
      p_target: 'personal',
      p_subscription_id: subscriptionId,
      p_approved_by: approver.userId,
    });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      redemption_id: (await redemptionRows(coupon.id))[0].id,
      discount_amount_jpy: 300,
      duration_months: 2,
    });
  });

  it('P-4: p_target が personal / org 以外なら 22023。何も書き込まれない', async () => {
    const coupon = await createCoupon();
    const subscriptionId = await createSubscription(userA.userId);

    for (const badTarget of ['family', '', 'PERSONAL', null]) {
      const res = await srAdmin.rpc('apply_coupon', {
        p_coupon_id: coupon.id,
        p_target: badTarget,
        p_subscription_id: subscriptionId,
        p_approved_by: approver.userId,
      });
      expect(res.error?.code).toBe('22023');
    }
    expect(await redemptionRows(coupon.id)).toEqual([]);
    expect(await usesCount(coupon.id)).toBe(0);
  });

  it('P-5: p_approved_by が NULL なら 22023 (遡及適用は承認者が必須)。何も書き込まれない', async () => {
    const coupon = await createCoupon();
    const subscriptionId = await createSubscription(userA.userId);

    const res = await srAdmin.rpc('apply_coupon', {
      p_coupon_id: coupon.id,
      p_target: 'personal',
      p_subscription_id: subscriptionId,
      p_approved_by: null,
    });

    expect(res.error?.code).toBe('22023');
    expect(await redemptionRows(coupon.id)).toEqual([]);
    expect(await usesCount(coupon.id)).toBe(0);
  });

  it('P-6: 業務エラーは SQLSTATE P0001 + メッセージ=エラーコード、文言が分かれるものは DETAIL に種別が入る', async () => {
    const coupon = await createCoupon({ per_user_limit: 1, applicable_to: 'org' });
    const orgId = await createOrg(orgStandardPlan.plan_key);
    await apply(coupon.id, 'org', orgId);

    const limit = await srAdmin.rpc('apply_coupon', {
      p_coupon_id: coupon.id,
      p_target: 'org',
      p_subscription_id: orgId,
      p_approved_by: approver.userId,
    });
    expect(limit.error).toMatchObject({ code: 'P0001', message: 'OP_COUPON_LIMIT_REACHED', details: 'per_organization' });

    const notFound = await srAdmin.rpc('apply_coupon', {
      p_coupon_id: randomUUID(),
      p_target: 'personal',
      p_subscription_id: randomUUID(),
      p_approved_by: approver.userId,
    });
    expect(notFound.error).toMatchObject({ code: 'P0001', message: 'OP_COUPON_NOT_FOUND' });
  });
});
