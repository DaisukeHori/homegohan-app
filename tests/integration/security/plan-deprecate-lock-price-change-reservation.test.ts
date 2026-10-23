/**
 * #1917 の続き: 運営のプランの操作で、ロックの外で読んだ値に頼っていた 2 か所の直し (実 DB)
 * (supabase/migrations/20261024110000_plan_deprecate_lock_and_price_change_reservation.sql)
 *
 * (1) 廃止の安全弁のトリガー guard_plan_deprecate_subscribers
 *   DL-1 契約の作成 (personal_subscriptions の INSERT) をコミット前のまま開いておくと、廃止の UPDATE はその後ろで待ち、
 *        コミットの後に数え直して OP_PLAN_HAS_SUBSCRIBERS (P0001。DETAIL は内訳の JSON) で止める。プランは公開中のまま
 *        (route は数えてから書くまでの間のこの契約を見落としていた)
 *   DL-2 家族のグループのプランの付け替え (family_groups.plan_key の UPDATE) をコミット前のまま開いておいても同じく止める
 *   DL-3 廃止の UPDATE をコミット前のまま開いておくと、契約の作成は外部キーの確認でその後ろに並ぶ (数えた後に「間に」入れない)
 *   DL-4 契約者がいなければ廃止できる。公開 → 非公開・廃止の取り消し (deprecated → private) は、契約者がいても止めない
 *   DL-5 組織のプランの行 (plan_type = 'org' の org_*) では組織を数えない (active の組織がいても止めない)。個人契約がいれば止め、
 *        DETAIL に organizations のキーが無い。個人のプランでは organizations を数える
 *   DL-6 トリガーの関数は、利用者 (anon / authenticated / PUBLIC) から EXECUTE できない
 *   DL-7 plan_key を変えずに status だけを live にする個人契約の UPDATE (incomplete / expired → active。外部キーの確認が走らない) を
 *        コミット前のまま開いておいても、廃止の UPDATE は契約者が増える書き込みのロック trg_subscriber_plan_key_share で待ってから止める
 *   DL-8 家族のグループの dissolved → active (plan_key はそのまま) も同じく止める
 *   DL-9 組織の作成 (organizations には subscription_plans への外部キーが無い) も同じく止める
 *   DL-10 契約者が増える書き込みのロック (FOR KEY SHARE) は、価格の変更の予約 (FOR NO KEY UPDATE) を待たせない
 *   DL-11 trg_subscriber_plan_key_share の関数 3 本は利用者から EXECUTE できず、トリガーは 3 表とも BEFORE の行トリガーの最後に並ぶ
 *         (ほかのトリガーが変えた後の NEW を見る)
 * (2) 価格の変更の予約 begin / apply / release_plan_price_change
 *   PR-1 begin は予約を取ってロックの下で読んだプランの値を返す。予約中のもう 1 本は in_progress。期限より古い予約は取り直せ、
 *        取り直された元の token の apply は lost で何も書かない
 *   PR-2 apply は履歴の old_* をロックの下で読んだ値 (begin の後に変わっていれば変わった後の値) で書き、変えた列だけを更新し、予約を消す
 *   PR-3 begin をコミット前のまま開いておくと、もう 1 本の begin はプランの行のロックで待ち、コミットの後に in_progress を返す
 *   PR-4 release は自分の token の予約だけを消す。無いプランは not_found、draft は draft、期限が 0 以下は 22023
 *   PR-5 関数 3 本は service_role だけが EXECUTE でき、予約の表は利用者が読み書きできない (RLS 有効・権限なし)
 *
 * 競合の再現はタイミングに頼らない (tests/integration/helpers/lock-holder.ts): postgres-meta (/pg/query) で先の処理を流して
 * 放されるまで開いたままにする接続を作り、後の処理を service_role の PostgREST で呼んで、それが先の接続に待たされて
 * 行のロックの待ちに並んだのを pg_stat_activity / pg_blocking_pids で確かめてから先の接続を放す。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (表と DB の関数を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts
 * 本番には接続しない。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { createLockHolderKit } from '../helpers/lock-holder';
import { cleanupTestUser, createTestUserWithRoles, testEmail, type TestUser } from '../helpers/users';
import { PLAN_HAS_SUBSCRIBERS_DB_ERROR, parsePlanSubscriberCountsDetail } from '@/lib/super-admin/plan-subscribers';
import { PLAN_PRICE_CHANGE_RPC } from '@/lib/super-admin/plan-price-change-reservation';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

/** 準備と後片付けの時間の上限 (利用者の作成・削除) */
const SETUP_TIMEOUT_MS = 120_000;
/** 競合のテストの時間の上限 (先の接続を開いておき、後の処理が並んだのを確かめてから放す) */
const RACE_TIMEOUT_MS = 60_000;
/** ローカルスタックの Kong → PostgREST の接続が切られていたときの 502 のやり直しの回数 (admin-set-user-roles-previous-roles.test.ts と同じ) */
const GATEWAY_RETRIES = 3;
/** 502 のやり直しの待ちの単位 */
const GATEWAY_RETRY_BASE_MS = 150;
/** これより遅く返った 502 は、pg_sleep で待たせた後の応答なのでやり直さない */
const GATEWAY_FAST_FAILURE_MS = 1_500;
/** 予約の期限 (テストでは、予約を古くした行が期限を過ぎていることだけが要る) */
const STALE_AFTER_SECONDS = 60;
const MS_PER_SECOND = 1000;
/** 期限を過ぎた予約にするために reserved_at を戻す時間 (期限の 2 倍) */
const STALE_RESERVATION_AGE_MS = 2 * STALE_AFTER_SECONDS * MS_PER_SECOND;
const ENDS_AT = '2099-01-01T00:00:00.000Z';
const EFFECTIVE_AT = '2026-11-01T00:00:00.000Z';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る */
async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 502 && attempt < GATEWAY_RETRIES && Date.now() - startedAt < GATEWAY_FAST_FAILURE_MS) {
      await sleep(GATEWAY_RETRY_BASE_MS * (attempt + 1));
      continue;
    }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  }
}

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'plan1917' });

const TS = Date.now();
let superAdmin: TestUser;
/** 個人契約・家族グループ・組織の持ち主 */
let subscriber: TestUser;
const planKeys: string[] = [];
let planSeq = 0;

interface Plan {
  id: string;
  planKey: string;
}

async function createPlan(label: string, options: { planType?: 'personal' | 'org'; status?: string } = {}): Promise<Plan> {
  const planType = options.planType ?? 'personal';
  planSeq += 1;
  const planKey = `${planType === 'org' ? 'org_' : ''}it_1917_${label}_${planSeq}_${TS}`;
  const { data, error } = await srAdmin
    .from('subscription_plans')
    .insert({
      plan_key: planKey,
      display_name: `#1917 ${label} ${TS}`,
      plan_type: planType,
      status: options.status ?? 'public',
      monthly_price_jpy: 1000,
      yearly_price_jpy: 10000,
      stripe_price_id: `price_month_${planSeq}_${TS}`,
      stripe_yearly_price_id: `price_year_${planSeq}_${TS}`,
      version: 1,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`subscription_plans insert: ${error?.message}`);
  planKeys.push(planKey);
  return { id: data.id as string, planKey };
}

async function planRow(planId: string) {
  const { data, error } = await srAdmin
    .from('subscription_plans')
    .select('status, monthly_price_jpy, yearly_price_jpy, stripe_price_id, stripe_yearly_price_id')
    .eq('id', planId)
    .single();
  if (error || !data) throw new Error(`subscription_plans select: ${error?.message}`);
  return data as {
    status: string;
    monthly_price_jpy: number | null;
    yearly_price_jpy: number | null;
    stripe_price_id: string | null;
    stripe_yearly_price_id: string | null;
  };
}

/** 廃止の UPDATE (route の条件つきの UPDATE と同じく status を書く) */
function deprecateDirect(planId: string) {
  return srAdmin.from('subscription_plans').update({ status: 'deprecated', ends_at: ENDS_AT }).eq('id', planId).select('id').maybeSingle();
}

/** 家族グループ (active) を作る (作成のトリガーが plan_key を決めるので、プランは付けずに作る) */
async function createFamily(): Promise<string> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .insert({ name: `it-1917 ${TS}`, representative_id: subscriber.userId, status: 'active' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`family_groups insert: ${error?.message}`);
  return data.id as string;
}

async function addOrganization(planKey: string): Promise<void> {
  const { error } = await srAdmin
    .from('organizations')
    .insert({ name: `it-1917 ${TS}`, owner_id: subscriber.userId, plan: planKey, status: 'active' });
  if (error) throw new Error(`organizations insert: ${error.message}`);
}

async function addPersonalSubscription(planKey: string): Promise<void> {
  const { error } = await srAdmin.from('personal_subscriptions').insert({ user_id: subscriber.userId, plan_key: planKey, status: 'active' });
  if (error) throw new Error(`personal_subscriptions insert: ${error.message}`);
}

type BeginResult =
  | { result: 'reserved'; token: string; plan: Record<string, unknown> }
  | { result: 'not_found' | 'draft' | 'in_progress' };
type ApplyResult = { result: 'applied'; previous: Record<string, unknown> } | { result: 'not_found' | 'lost' };

async function begin(planId: string, staleAfterSeconds = STALE_AFTER_SECONDS): Promise<BeginResult> {
  const { data, error } = await srAdmin.rpc(PLAN_PRICE_CHANGE_RPC.begin, { p_plan_id: planId, p_stale_after_seconds: staleAfterSeconds });
  if (error) throw new Error(`begin: ${error.message}`);
  return data as BeginResult;
}

function applyArgs(planId: string, token: string, change: { monthly?: number | null; yearly?: number | null; monthlyPrice?: string | null; yearlyPrice?: string | null }) {
  return {
    p_plan_id: planId,
    p_token: token,
    p_new_monthly_price_jpy: change.monthly ?? null,
    p_new_yearly_price_jpy: change.yearly ?? null,
    p_new_stripe_price_id: change.monthlyPrice ?? null,
    p_new_stripe_yearly_price_id: change.yearlyPrice ?? null,
    p_changed_by: superAdmin.userId,
    p_reason: '#1917 の結合テスト',
    p_effective_at: EFFECTIVE_AT,
    p_applies_to: 'new_only',
  };
}

async function apply(planId: string, token: string, change: Parameters<typeof applyArgs>[2]): Promise<ApplyResult> {
  const { data, error } = await srAdmin.rpc(PLAN_PRICE_CHANGE_RPC.apply, applyArgs(planId, token, change));
  if (error) throw new Error(`apply: ${error.message}`);
  return data as ApplyResult;
}

async function reservationsOf(planId: string): Promise<Array<{ token: string }>> {
  const { data, error } = await srAdmin.from('plan_price_change_reservations').select('token').eq('plan_id', planId);
  if (error) throw new Error(`plan_price_change_reservations select: ${error.message}`);
  return (data ?? []) as Array<{ token: string }>;
}

async function historyOf(planId: string) {
  const { data, error } = await srAdmin
    .from('plan_price_history')
    .select('old_monthly_price_jpy, new_monthly_price_jpy, old_yearly_price_jpy, new_yearly_price_jpy, old_stripe_price_id, new_stripe_price_id, changed_by, applies_to')
    .eq('plan_id', planId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`plan_price_history select: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  [superAdmin, subscriber] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('plan1917-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('plan1917-sub', TS), roles: ['user'] }),
  ]);
}, SETUP_TIMEOUT_MS);

// テストが途中で落ちたときに残った接続を、作った順に放す。1 人が持てる「終わっていない個人契約」は 1 件までなので、シナリオごとに片付ける
afterEach(async () => {
  await holders.releaseOpenHolders();
  await holders.settle();
  await srAdmin.from('personal_subscriptions').delete().eq('user_id', subscriber.userId);
}, RACE_TIMEOUT_MS);

afterAll(async () => {
  await holders.settle();
  for (const planKey of planKeys) {
    // 外部キー (family_groups.plan_key / personal_subscriptions.plan_key / 履歴 / 予約) があるので、プランより先に消す
    await srAdmin.from('personal_subscriptions').delete().eq('plan_key', planKey);
    await srAdmin.from('family_groups').delete().eq('plan_key', planKey);
    await srAdmin.from('organizations').delete().eq('plan', planKey);
    const { data } = await srAdmin.from('subscription_plans').select('id').eq('plan_key', planKey).maybeSingle();
    if (data?.id) await srAdmin.from('plan_price_history').delete().eq('plan_id', data.id);
    await srAdmin.from('subscription_plans').delete().eq('plan_key', planKey);
  }
  await srAdmin.from('family_groups').delete().eq('representative_id', subscriber.userId);
  await srAdmin.from('admin_audit_logs').delete().eq('actor_id', superAdmin.userId);
  await Promise.all([cleanupTestUser(superAdmin.userId), cleanupTestUser(subscriber.userId)]);
}, SETUP_TIMEOUT_MS);

describe('(1) 廃止の安全弁のトリガー guard_plan_deprecate_subscribers', () => {
  it(
    'DL-1: 契約の作成がコミット前の間、廃止の UPDATE はその後ろで待ち、コミットの後に数え直して止める',
    async () => {
      const plan = await createPlan('dl1');

      const holder = holders.startHolder(
        '契約の作成 (personal_subscriptions の INSERT)',
        `INSERT INTO public.personal_subscriptions (user_id, plan_key, status) VALUES ('${subscriber.userId}'::uuid, '${plan.planKey}', 'active');`,
      );
      await holder.sleeping;

      const [held, deprecated] = await holders.runBehindHolder(holder, {
        fn: 'subscription_plans',
        step: '廃止の UPDATE が契約の作成のコミットを待つ',
        call: async () => deprecateDirect(plan.id),
      });

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      expect(deprecated.error?.message).toBe(PLAN_HAS_SUBSCRIBERS_DB_ERROR);
      expect(deprecated.error?.code).toBe('P0001');
      expect(parsePlanSubscriberCountsDetail(deprecated.error?.details)).toEqual({
        personal_subscriptions: 1,
        family_groups: 0,
        organizations: 0,
      });
      expect((await planRow(plan.id)).status).toBe('public');
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'DL-2: 家族のグループのプランの付け替えがコミット前の間も、廃止の UPDATE は待ってから止める',
    async () => {
      const plan = await createPlan('dl2');
      const familyId = await createFamily();

      const holder = holders.startHolder(
        '家族のグループのプランの付け替え (family_groups.plan_key の UPDATE)',
        `UPDATE public.family_groups SET plan_key = '${plan.planKey}' WHERE id = '${familyId}'::uuid;`,
      );
      await holder.sleeping;

      const [held, deprecated] = await holders.runBehindHolder(holder, {
        fn: 'subscription_plans',
        step: '廃止の UPDATE が家族のプランの付け替えのコミットを待つ',
        call: async () => deprecateDirect(plan.id),
      });

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      expect(deprecated.error?.message).toBe(PLAN_HAS_SUBSCRIBERS_DB_ERROR);
      expect(parsePlanSubscriberCountsDetail(deprecated.error?.details)).toEqual({
        personal_subscriptions: 0,
        family_groups: 1,
        organizations: 0,
      });
      expect((await planRow(plan.id)).status).toBe('public');

      await srAdmin.from('family_groups').delete().eq('id', familyId);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'DL-3: 廃止の UPDATE がコミット前の間、契約の作成は外部キーの確認でその後ろに並ぶ',
    async () => {
      const plan = await createPlan('dl3');

      const holder = holders.startHolder(
        '廃止の UPDATE',
        `UPDATE public.subscription_plans SET status = 'deprecated', ends_at = '${ENDS_AT}'::timestamptz WHERE id = '${plan.id}'::uuid;`,
      );
      await holder.sleeping;

      const [held, inserted] = await holders.runBehindHolder(holder, {
        fn: 'personal_subscriptions',
        step: '契約の作成が廃止のコミットを待つ',
        call: async () => srAdmin.from('personal_subscriptions').insert({ user_id: subscriber.userId, plan_key: plan.planKey, status: 'active' }),
      });

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      // 廃止は契約者 0 件で通り、契約はその commit の後に作られる (数えた後に「間に」入ることは無い)
      expect(inserted.error).toBeNull();
      expect((await planRow(plan.id)).status).toBe('deprecated');
    },
    RACE_TIMEOUT_MS,
  );

  it('DL-4: 契約者がいなければ廃止できる。公開 → 非公開と廃止の取り消しは、契約者がいても止めない', async () => {
    const empty = await createPlan('dl4-empty');
    const { data, error } = await deprecateDirect(empty.id);
    expect(error).toBeNull();
    expect(data).toEqual({ id: empty.id });
    expect((await planRow(empty.id)).status).toBe('deprecated');

    const withSubscriber = await createPlan('dl4-sub');
    await addPersonalSubscription(withSubscriber.planKey);
    const unpublish = await srAdmin.from('subscription_plans').update({ status: 'private' }).eq('id', withSubscriber.id);
    expect(unpublish.error).toBeNull();
    expect((await planRow(withSubscriber.id)).status).toBe('private');

    // 廃止済み (契約者がいる状態を、トリガーの外で作る) → 非公開への取り消し
    const deprecatedWithSubscriber = await createPlan('dl4-undeprecate', { status: 'deprecated' });
    await srAdmin.from('personal_subscriptions').delete().eq('user_id', subscriber.userId);
    await addPersonalSubscription(deprecatedWithSubscriber.planKey);
    const undeprecate = await srAdmin.from('subscription_plans').update({ status: 'private' }).eq('id', deprecatedWithSubscriber.id);
    expect(undeprecate.error).toBeNull();
    expect((await planRow(deprecatedWithSubscriber.id)).status).toBe('private');
  });

  it('DL-5: 組織のプランの行 (org_*) では組織を数えず、個人契約がいれば止めて DETAIL に organizations を入れない。個人のプランでは組織を数える', async () => {
    const orgRow = await createPlan('dl5-org', { planType: 'org' });
    await addOrganization(orgRow.planKey);
    const allowed = await deprecateDirect(orgRow.id);
    expect(allowed.error).toBeNull();
    expect((await planRow(orgRow.id)).status).toBe('deprecated');

    const orgRowWithPersonal = await createPlan('dl5-org-personal', { planType: 'org' });
    await addPersonalSubscription(orgRowWithPersonal.planKey);
    const refused = await deprecateDirect(orgRowWithPersonal.id);
    expect(refused.error?.message).toBe(PLAN_HAS_SUBSCRIBERS_DB_ERROR);
    expect(parsePlanSubscriberCountsDetail(refused.error?.details)).toEqual({ personal_subscriptions: 1, family_groups: 0 });

    const personalRow = await createPlan('dl5-personal');
    await addOrganization(personalRow.planKey);
    const orgCounted = await deprecateDirect(personalRow.id);
    expect(orgCounted.error?.message).toBe(PLAN_HAS_SUBSCRIBERS_DB_ERROR);
    expect(parsePlanSubscriberCountsDetail(orgCounted.error?.details)).toEqual({
      personal_subscriptions: 0,
      family_groups: 0,
      organizations: 1,
    });
  });

  it('DL-6: トリガーの関数は、利用者 (anon / authenticated / PUBLIC) から EXECUTE できない。トリガーは BEFORE UPDATE OF status', async () => {
    const grants = await holders.pgQuery<{ grantee: string }>(`
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE n.nspname = 'public' AND p.proname = 'guard_plan_deprecate_subscribers' AND a.privilege_type = 'EXECUTE'`);
    const grantees = grants.map((row) => row.grantee);
    expect(grantees).not.toContain('PUBLIC');
    expect(grantees).not.toContain('anon');
    expect(grantees).not.toContain('authenticated');

    const triggers = await holders.pgQuery<{ definition: string }>(`
      SELECT pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
      WHERE t.tgrelid = 'public.subscription_plans'::regclass AND t.tgname = 'trg_guard_plan_deprecate_subscribers'`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].definition).toContain('BEFORE UPDATE OF status ON public.subscription_plans');
  });

  it.each(['incomplete', 'expired'] as const)(
    'DL-7: plan_key を変えずに status だけを %s → active にする個人契約の UPDATE がコミット前の間も、廃止の UPDATE は待ってから止める',
    async (fromStatus) => {
      const plan = await createPlan(`dl7-${fromStatus}`);
      const { data: row, error } = await srAdmin
        .from('personal_subscriptions')
        .insert({ user_id: subscriber.userId, plan_key: plan.planKey, status: fromStatus })
        .select('id')
        .single();
      if (error || !row) throw new Error(`personal_subscriptions insert: ${error?.message}`);

      const holder = holders.startHolder(
        `個人契約の ${fromStatus} → active (plan_key はそのまま)`,
        `UPDATE public.personal_subscriptions SET status = 'active' WHERE id = '${row.id as string}'::uuid;`,
      );
      await holder.sleeping;

      const [held, deprecated] = await holders.runBehindHolder(holder, {
        fn: 'subscription_plans',
        step: '廃止の UPDATE が個人契約の live への切り替えのコミットを待つ',
        call: async () => deprecateDirect(plan.id),
      });

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      expect(deprecated.error?.message).toBe(PLAN_HAS_SUBSCRIBERS_DB_ERROR);
      expect(parsePlanSubscriberCountsDetail(deprecated.error?.details)).toEqual({
        personal_subscriptions: 1,
        family_groups: 0,
        organizations: 0,
      });
      expect((await planRow(plan.id)).status).toBe('public');
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'DL-8: 家族のグループの dissolved → active (plan_key はそのまま) がコミット前の間も、廃止の UPDATE は待ってから止める',
    async () => {
      const plan = await createPlan('dl8');
      const familyId = await createFamily();
      // プランを付けてから解散の状態にする (代表者は残す。dissolved の行は代表者が無くてもよいだけ)
      const { error: planError } = await srAdmin.from('family_groups').update({ plan_key: plan.planKey }).eq('id', familyId);
      expect(planError).toBeNull();
      const { error: dissolveError } = await srAdmin.from('family_groups').update({ status: 'dissolved' }).eq('id', familyId);
      expect(dissolveError).toBeNull();

      const holder = holders.startHolder(
        '家族のグループの dissolved → active (plan_key はそのまま)',
        `UPDATE public.family_groups SET status = 'active' WHERE id = '${familyId}'::uuid;`,
      );
      await holder.sleeping;

      const [held, deprecated] = await holders.runBehindHolder(holder, {
        fn: 'subscription_plans',
        step: '廃止の UPDATE が家族のグループの active への切り替えのコミットを待つ',
        call: async () => deprecateDirect(plan.id),
      });

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      expect(deprecated.error?.message).toBe(PLAN_HAS_SUBSCRIBERS_DB_ERROR);
      expect(parsePlanSubscriberCountsDetail(deprecated.error?.details)).toEqual({
        personal_subscriptions: 0,
        family_groups: 1,
        organizations: 0,
      });
      expect((await planRow(plan.id)).status).toBe('public');

      await srAdmin.from('family_groups').delete().eq('id', familyId);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'DL-9: 組織の作成 (プランへの外部キーが無い) がコミット前の間も、廃止の UPDATE は待ってから止める',
    async () => {
      const plan = await createPlan('dl9');

      const holder = holders.startHolder(
        '組織の作成 (organizations の INSERT)',
        `INSERT INTO public.organizations (name, owner_id, plan, status) VALUES ('it-1917 dl9 ${TS}', '${subscriber.userId}'::uuid, '${plan.planKey}', 'active');`,
      );
      await holder.sleeping;

      const [held, deprecated] = await holders.runBehindHolder(holder, {
        fn: 'subscription_plans',
        step: '廃止の UPDATE が組織の作成のコミットを待つ',
        call: async () => deprecateDirect(plan.id),
      });

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      expect(deprecated.error?.message).toBe(PLAN_HAS_SUBSCRIBERS_DB_ERROR);
      expect(parsePlanSubscriberCountsDetail(deprecated.error?.details)).toEqual({
        personal_subscriptions: 0,
        family_groups: 0,
        organizations: 1,
      });
      expect((await planRow(plan.id)).status).toBe('public');
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'DL-10: 契約者が増える書き込みのロック (FOR KEY SHARE) がコミット前の間も、価格の変更の予約 (FOR NO KEY UPDATE) は待たずに取れる',
    async () => {
      const plan = await createPlan('dl10');
      const { data: row, error } = await srAdmin
        .from('personal_subscriptions')
        .insert({ user_id: subscriber.userId, plan_key: plan.planKey, status: 'incomplete' })
        .select('id')
        .single();
      if (error || !row) throw new Error(`personal_subscriptions insert: ${error?.message}`);

      const holder = holders.startHolder(
        '個人契約の incomplete → active (プランの行に FOR KEY SHARE)',
        `UPDATE public.personal_subscriptions SET status = 'active' WHERE id = '${row.id as string}'::uuid;`,
      );

      const [held, reservation] = await holders.whileHolding(holder, async () => begin(plan.id));

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      expect(reservation.result).toBe('reserved');
      if (reservation.result === 'reserved') {
        await srAdmin.rpc(PLAN_PRICE_CHANGE_RPC.release, { p_plan_id: plan.id, p_token: reservation.token });
      }
    },
    RACE_TIMEOUT_MS,
  );

  it('DL-11: trg_subscriber_plan_key_share の関数は利用者から EXECUTE できず、トリガーは 3 表とも BEFORE の行トリガーの最後に並ぶ', async () => {
    const holdersByTable = [
      ['personal_subscriptions', 'personal_subscription_hold_plan_key_share'],
      ['family_groups', 'family_group_hold_plan_key_share'],
      ['organizations', 'organization_hold_plan_key_share'],
    ] as const;
    for (const [table, fn] of holdersByTable) {
      const grants = await holders.pgQuery<{ grantee: string }>(`
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE n.nspname = 'public' AND p.proname = '${fn}' AND a.privilege_type = 'EXECUTE'`);
      const grantees = grants.map((row) => row.grantee);
      expect(grantees, fn).not.toContain('PUBLIC');
      expect(grantees, fn).not.toContain('anon');
      expect(grantees, fn).not.toContain('authenticated');

      // 同じ時機の行トリガーは名前の順 (バイト順) に動く。BEFORE (tgtype の 2) かつ行 (1) のものを並べる
      const beforeRowTriggers = await holders.pgQuery<{ tgname: string; definition: string }>(`
        SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
        WHERE t.tgrelid = 'public.${table}'::regclass AND NOT t.tgisinternal AND (t.tgtype & 3) = 3
        ORDER BY t.tgname COLLATE "C"`);
      const last = beforeRowTriggers[beforeRowTriggers.length - 1];
      expect(last?.tgname, table).toBe('trg_subscriber_plan_key_share');
      expect(last?.definition, table).toContain(`BEFORE INSERT OR UPDATE ON public.${table} FOR EACH ROW`);
      // 関数の名前は search_path に public があれば修飾されない
      expect(last?.definition, table).toMatch(new RegExp(`EXECUTE FUNCTION (public\\.)?${fn}\\(\\)`));
    }
  });
});

describe('(2) 価格の変更の予約', () => {
  it('PR-1: 予約中のもう 1 本は in_progress。期限より古い予約は取り直せ、取り直された元の token の apply は lost で何も書かない', async () => {
    const plan = await createPlan('pr1');

    const first = await begin(plan.id);
    expect(first.result).toBe('reserved');
    if (first.result !== 'reserved') return;
    expect(first.plan).toMatchObject({
      id: plan.id,
      plan_key: plan.planKey,
      status: 'public',
      monthly_price_jpy: 1000,
      yearly_price_jpy: 10000,
    });
    expect(await begin(plan.id)).toEqual({ result: 'in_progress' });

    // 予約を期限より古くする (route の途中で落ちて消えなかった予約)
    const { error: ageError } = await srAdmin
      .from('plan_price_change_reservations')
      .update({ reserved_at: new Date(Date.now() - STALE_RESERVATION_AGE_MS).toISOString() })
      .eq('plan_id', plan.id);
    expect(ageError).toBeNull();
    const second = await begin(plan.id);
    expect(second.result).toBe('reserved');
    if (second.result !== 'reserved') return;
    expect(second.token).not.toBe(first.token);

    expect(await apply(plan.id, first.token, { monthly: 1500 })).toEqual({ result: 'lost' });
    expect((await planRow(plan.id)).monthly_price_jpy).toBe(1000);
    expect(await historyOf(plan.id)).toEqual([]);
    expect(await reservationsOf(plan.id)).toEqual([{ token: second.token }]);

    await srAdmin.rpc(PLAN_PRICE_CHANGE_RPC.release, { p_plan_id: plan.id, p_token: second.token });
  });

  it('PR-2: apply は履歴の old_* をロックの下で読んだ値 (begin の後に変わっていれば変わった後の値) で書き、変えた列だけを更新し、予約を消す', async () => {
    const plan = await createPlan('pr2');
    const reservation = await begin(plan.id);
    if (reservation.result !== 'reserved') throw new Error(`予約できませんでした: ${JSON.stringify(reservation)}`);

    // begin の後に月額が変わった (route を通らない書き込み)。履歴の old_* はこの値になる
    const { error: midError } = await srAdmin.from('subscription_plans').update({ monthly_price_jpy: 1100 }).eq('id', plan.id);
    expect(midError).toBeNull();
    const before = await planRow(plan.id);

    const result = await apply(plan.id, reservation.token, { monthly: 1200, monthlyPrice: 'price_month_new' });

    expect(result).toEqual({
      result: 'applied',
      previous: {
        monthly_price_jpy: 1100,
        yearly_price_jpy: 10000,
        stripe_price_id: before.stripe_price_id,
        stripe_yearly_price_id: before.stripe_yearly_price_id,
      },
    });
    expect(await planRow(plan.id)).toEqual({
      status: 'public',
      monthly_price_jpy: 1200,
      // 年額は変えていないので、金額も Price ID もそのまま
      yearly_price_jpy: 10000,
      stripe_price_id: 'price_month_new',
      stripe_yearly_price_id: before.stripe_yearly_price_id,
    });
    expect(await historyOf(plan.id)).toEqual([
      {
        old_monthly_price_jpy: 1100,
        new_monthly_price_jpy: 1200,
        old_yearly_price_jpy: 10000,
        new_yearly_price_jpy: 10000,
        old_stripe_price_id: before.stripe_price_id,
        new_stripe_price_id: 'price_month_new',
        changed_by: superAdmin.userId,
        applies_to: 'new_only',
      },
    ]);
    expect(await reservationsOf(plan.id)).toEqual([]);
  });

  it(
    'PR-3: begin がコミット前の間、もう 1 本の begin はプランの行のロックで待ち、コミットの後に in_progress を返す',
    async () => {
      const plan = await createPlan('pr3');

      const holder = holders.startHolder(
        '先の運営の予約 (begin_plan_price_change)',
        `SELECT public.${PLAN_PRICE_CHANGE_RPC.begin}('${plan.id}'::uuid, ${STALE_AFTER_SECONDS});`,
      );
      await holder.sleeping;

      const [held, second] = await holders.runBehindHolder(holder, {
        fn: PLAN_PRICE_CHANGE_RPC.begin,
        step: '後の運営の予約が先の予約のコミットを待つ',
        call: async () => begin(plan.id),
      });

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      expect(second).toEqual({ result: 'in_progress' });
      expect(await reservationsOf(plan.id)).toHaveLength(1);
    },
    RACE_TIMEOUT_MS,
  );

  it('PR-4: release は自分の token の予約だけを消す。無いプランは not_found、draft は draft、期限が 0 以下は 22023', async () => {
    const plan = await createPlan('pr4');
    const reservation = await begin(plan.id);
    if (reservation.result !== 'reserved') throw new Error(`予約できませんでした: ${JSON.stringify(reservation)}`);

    const otherToken = '00000000-0000-4000-8000-000000001917';
    const wrong = await srAdmin.rpc(PLAN_PRICE_CHANGE_RPC.release, { p_plan_id: plan.id, p_token: otherToken });
    expect(wrong).toMatchObject({ data: false, error: null });
    expect(await reservationsOf(plan.id)).toHaveLength(1);

    const released = await srAdmin.rpc(PLAN_PRICE_CHANGE_RPC.release, { p_plan_id: plan.id, p_token: reservation.token });
    expect(released).toMatchObject({ data: true, error: null });
    expect(await reservationsOf(plan.id)).toEqual([]);

    expect(await begin('00000000-0000-4000-8000-00000000f917')).toEqual({ result: 'not_found' });
    const draft = await createPlan('pr4-draft', { status: 'draft' });
    expect(await begin(draft.id)).toEqual({ result: 'draft' });
    expect(await reservationsOf(draft.id)).toEqual([]);

    const invalid = await srAdmin.rpc(PLAN_PRICE_CHANGE_RPC.begin, { p_plan_id: plan.id, p_stale_after_seconds: 0 });
    expect(invalid.error?.code).toBe('22023');
  });

  it('PR-5: 関数 3 本は service_role だけが EXECUTE でき、予約の表は利用者が読み書きできない', async () => {
    const plan = await createPlan('pr5');
    for (const fn of Object.values(PLAN_PRICE_CHANGE_RPC)) {
      const grants = await holders.pgQuery<{ grantee: string }>(`
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE n.nspname = 'public' AND p.proname = '${fn}' AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
        ORDER BY 1`);
      // 関数の持ち主 (migration を流すロール) を除くと service_role だけ
      expect(grants.map((row) => row.grantee), fn).toEqual(['service_role']);
    }

    const asAnon = await anon().rpc(PLAN_PRICE_CHANGE_RPC.begin, { p_plan_id: plan.id, p_stale_after_seconds: STALE_AFTER_SECONDS });
    expect(asAnon.error).not.toBeNull();
    const asOperator = await asUser(superAdmin.jwt).rpc(PLAN_PRICE_CHANGE_RPC.begin, {
      p_plan_id: plan.id,
      p_stale_after_seconds: STALE_AFTER_SECONDS,
    });
    expect(asOperator.error).not.toBeNull();
    expect(await reservationsOf(plan.id)).toEqual([]);

    const privileges = await holders.pgQuery<{ role: string; any_privilege: boolean }>(`
      SELECT r AS role,
             has_table_privilege(r, 'public.plan_price_change_reservations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS any_privilege
      FROM unnest(ARRAY['anon', 'authenticated']) AS r`);
    expect(privileges).toEqual([
      { role: 'anon', any_privilege: false },
      { role: 'authenticated', any_privilege: false },
    ]);
    const rls = await holders.pgQuery<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.plan_price_change_reservations'::regclass`,
    );
    expect(rls).toEqual([{ relrowsecurity: true }]);
  });
});
