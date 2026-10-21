/**
 * billing/03 (有料プランの販売) 段 A: AI のプラン × 機能の上限 (ai_plan_feature_caps) と 1 日の上限の行 (ai_daily_limits) の結合テスト
 * (設計: docs/design/billing/03-paid-plans-and-iap.md §6.5・§14.2 の 74〜76・91・107・112)
 *
 * migration *_billing_paid_plans_iap.sql が足すもの・変えるもの:
 *   - ai_daily_limits: free = 3・pro = 30・family_basic = 30・family_pro = 50。組織の plan の値 (organizations.plan・standard・
 *     plan_type = org の行) には、free を書き換える前の free の値を写す (組織の利用者の上限は変えない)
 *   - (#1912 段 A の整合ゲートの指摘) migration *_org_plan_ai_daily_limits.sql: アプリが organizations.plan に書ける値
 *     (ORG_PLAN_VALUES) のうち (5a) の写す先に入らなかった 'premium'・'enterprise' に、組織の上限 (10) の行を足す。
 *     トリガー guard_organizations_plan_value で、owner / admin の JWT が organizations.plan を ORG_PLAN_VALUES の外
 *     (有料の plan_key・行の無い値・NULL) へ変えるのを拒む (service_role の書き込みは止めない)
 *   - ai_plan_feature_caps: free は究極モード 0・画像の作成 0・自動の料理画像 0・献立の作成 3。有料は究極モード 2 / 2 / 3・献立の作成 10 / 10 / 15
 *   - consume_ai_usage_at: 上限に数えない機能の枝より前に、プラン × 機能の行を見る (0 = そのプランでは使えない = plan_locked)
 *   - consume_ai_usage_capped_at: 行のあるプランは引数の上限 (環境変数の既定) を使わず行の値で判定する
 *   - ai_plan_feature_daily_cap(p_user_id, p_feature): 数えない読み取り (料理画像のジョブの処理の門が使う)
 *
 * 利用者のプランは、手動付与 (billing_grant_manual_subscription。service_role) と、組織のメンバー (user_profiles.organization_id)・
 * 家族のメンバー (家族プランの代表者のグループ) で作る。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-plan-feature-caps-rpc.test.ts
 * 本番には接続しない。ai_daily_limits・ai_plan_feature_caps・ai_unmetered_daily_caps の行は変えない (読むだけ)。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { grantFamilyPlan, type FamilyPlanKey } from '../helpers/family-plan';
import { createPlaceholderOrgOwner, deletePlaceholderOrgOwner } from '../helpers/org-owner';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { ORG_PLAN_VALUES, type OrgPlanValue } from '@/lib/org-plans';

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

// ---------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls';

/** 究極モードの機能名 (_shared/ai-usage-core.ts の AI_ULTIMATE_MODE_FEATURE) */
const ULTIMATE = 'menu_generation_ultimate';
/** 究極モードの 1 日の上限の既定 (_shared/ai-usage-core.ts の AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT。呼び出し側が引数で渡す値) */
const ENV_ULTIMATE_CAP = 1;

/** migration の確定値 (設計 §0.6 の表。Q-2・Q-3) */
const DAILY_LIMIT = { free: 3, pro: 30, family_basic: 30, family_pro: 50 } as const;
const ULTIMATE_CAP = { free: 0, pro: 2, family_basic: 2, family_pro: 3 } as const;
const MENU_GENERATION_CAP = { free: 3, pro: 10, family_basic: 10, family_pro: 15 } as const;
/** migration が free を 3 にする前の free の 1 日の上限 (20261011020000_ai_daily_limits.sql の既定の行)。組織の plan の行に写る */
const PRE_MIGRATION_FREE_LIMIT = 10;
/** 組織の plan の値: organizations.plan の列の既定と、subscription_plans の plan_type = org の行 */
const ORG_PLAN_KEYS = ['standard', 'org_starter', 'org_standard', 'org_pro', 'org_enterprise'] as const;
/** 組織のメンバーに使う organizations.plan の値 (列の既定。本番の 2 組織も同じ) */
const ORG_PLAN = 'standard';

const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
let seq = 0;
let orgId: string | null = null;
/** organizations.plan に書ける値ごとの組織 (ORG_PLAN 以外。同じ持ち主の組織。後片付けで持ち主より先に消す) */
const orgIdByPlan = new Map<OrgPlanValue, string>();
let orgOwnerId: string | null = null;
/** owner / admin の JWT で plan を書き換えてみる組織 (ほかのテストの組織の plan を動かさないため別にする) */
let planGuardOrgId: string | null = null;

interface TestUser {
  userId: string;
  jwt: string | null;
}

async function createUser(label: string, options: { withJwt?: boolean } = {}): Promise<TestUser> {
  const email = `rls-plan-caps-${label}-${TS}-${++seq}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: userId, nickname: `caps-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  if (!options.withJwt) return { userId, jwt: null };
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { userId, jwt: signIn.data.session.access_token };
}

/** 手動付与 (期限なし) で個人のプランを入れた利用者 */
async function createPlanUser(label: string, planKey: 'pro' | FamilyPlanKey, options: { withJwt?: boolean } = {}): Promise<TestUser> {
  const user = await createUser(label, options);
  const { error } = await srAdmin.rpc('billing_grant_manual_subscription', { p_user_id: user.userId, p_plan_key: planKey, p_expires_at: null });
  if (error) throw new Error(`billing_grant_manual_subscription ${label}: ${error.message}`);
  return user;
}

/** 家族プランの代表者のグループの大人のメンバー (個人の契約は無い。get_effective_plan は家族のグループの plan_key を返す) */
async function createFamilyMember(label: string, planKey: FamilyPlanKey): Promise<TestUser> {
  const rep = await createUser(`${label}-rep`, { withJwt: true });
  await grantFamilyPlan(srAdmin, rep.userId, planKey);
  const { data, error } = await asUser(rep.jwt!).rpc('create_family_group', { p_name: `plan-caps ${label} ${TS}`, p_plan_key: 'free' });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string; plan_key: string }).id;
  createdFamilyIds.push(familyId);
  const member = await createUser(`${label}-member`);
  const { error: memberError } = await srAdmin
    .from('family_members')
    .insert({ family_id: familyId, user_id: member.userId, role: 'adult', status: 'active' });
  if (memberError) throw new Error(`family_members ${label}: ${memberError.message}`);
  return member;
}

async function createOrgMember(label: string, organizationId: string | null = orgId): Promise<TestUser> {
  const user = await createUser(label);
  const { error } = await srAdmin.from('user_profiles').update({ organization_id: organizationId, org_role: 'member' }).eq('id', user.userId);
  if (error) throw new Error(`user_profiles.organization_id ${label}: ${error.message}`);
  return user;
}

interface ConsumeResult {
  allowed: boolean;
  metered: boolean;
  plan: string | null;
  limit: number | null;
  used: number | null;
  usage_date: string;
  capped_feature?: string;
  plan_locked?: boolean;
}

async function consume(userId: string, feature: string): Promise<ConsumeResult> {
  const { data, error } = await srAdmin.rpc('consume_ai_usage', { p_user_id: userId, p_feature: feature });
  if (error) throw new Error(`consume_ai_usage ${feature}: ${error.code} ${error.message}`);
  return data as ConsumeResult;
}

async function consumeCapped(userId: string, feature: string = ULTIMATE, cap: number = ENV_ULTIMATE_CAP): Promise<ConsumeResult> {
  const { data, error } = await srAdmin.rpc('consume_ai_usage_capped', { p_user_id: userId, p_feature: feature, p_feature_daily_cap: cap });
  if (error) throw new Error(`consume_ai_usage_capped ${feature}: ${error.code} ${error.message}`);
  return data as ConsumeResult;
}

async function featureDailyCap(userId: string, feature: string): Promise<number | null> {
  const { data, error } = await srAdmin.rpc('ai_plan_feature_daily_cap', { p_user_id: userId, p_feature: feature });
  if (error) throw new Error(`ai_plan_feature_daily_cap ${feature}: ${error.code} ${error.message}`);
  return data as number | null;
}

async function countersOf(userId: string): Promise<Array<{ feature: string; count: number }>> {
  const { data, error } = await srAdmin.from('ai_usage_counters').select('feature, count').eq('user_id', userId).order('feature');
  if (error) throw new Error(`ai_usage_counters: ${error.message}`);
  return (data ?? []) as Array<{ feature: string; count: number }>;
}

const countOf = async (userId: string, feature: string) => (await countersOf(userId)).find((r) => r.feature === feature)?.count ?? 0;

beforeAll(async () => {
  orgOwnerId = await createPlaceholderOrgOwner(srAdmin, 'plan-caps');
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `plan-caps org ${TS}`, plan: ORG_PLAN, owner_id: orgOwnerId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organizations: ${error?.message}`);
  orgId = data.id as string;
  // アプリが organizations.plan に書ける値のうち ORG_PLAN 以外の値の組織 (#1912 段 A の整合ゲートの指摘: 'premium' / 'enterprise')
  for (const plan of ORG_PLAN_VALUES) {
    if (plan === ORG_PLAN) continue;
    const { data: planOrg, error: planOrgError } = await srAdmin
      .from('organizations')
      .insert({ name: `plan-caps org ${plan} ${TS}`, plan, owner_id: orgOwnerId })
      .select('id')
      .single();
    if (planOrgError || !planOrg) throw new Error(`organizations (${plan}): ${planOrgError?.message}`);
    orgIdByPlan.set(plan, planOrg.id as string);
  }
  const { data: guardOrg, error: guardOrgError } = await srAdmin
    .from('organizations')
    .insert({ name: `plan-caps guard org ${TS}`, plan: ORG_PLAN, owner_id: orgOwnerId })
    .select('id')
    .single();
  if (guardOrgError || !guardOrg) throw new Error(`organizations (plan guard): ${guardOrgError?.message}`);
  planGuardOrgId = guardOrg.id as string;
});

afterAll(async () => {
  const failures: string[] = [];
  // family_groups.representative_id は ON DELETE RESTRICT なので、家族を先に消す (メンバーは CASCADE)
  if (createdFamilyIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdFamilyIds);
    const { error } = await srAdmin.from('family_groups').delete().in('id', createdFamilyIds);
    if (error) failures.push(`family_groups: ${error.message}`);
  }
  // ユーザーを消すと、記録 (ai_usage_counters)・契約 (personal_subscriptions)・プロフィールは CASCADE で消える
  for (const id of createdUserIds) {
    const { error } = await srAdmin.auth.admin.deleteUser(id);
    if (error) failures.push(`auth.users ${id}: ${error.message}`);
  }
  if (orgId) {
    const { error } = await srAdmin.from('organizations').delete().eq('id', orgId);
    if (error) failures.push(`organizations: ${error.message}`);
  }
  if (orgIdByPlan.size > 0) {
    const { error } = await srAdmin.from('organizations').delete().in('id', [...orgIdByPlan.values()]);
    if (error) failures.push(`organizations (plan ごと): ${error.message}`);
  }
  if (planGuardOrgId) {
    const { error } = await srAdmin.from('organizations').delete().eq('id', planGuardOrgId);
    if (error) failures.push(`organizations (plan guard): ${error.message}`);
  }
  if (orgOwnerId) {
    try {
      await deletePlaceholderOrgOwner(srAdmin, orgOwnerId);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failures.length > 0) throw new Error(`テストが作った行を消せませんでした: ${failures.join(' / ')}`);
}, 120_000);

describe('billing/03 §6.5: プラン × 機能の上限 (consume_ai_usage)', () => {
  // 74
  it('consume_ai_usage denies with plan_locked for a 0 cap, with capped_feature for a reached cap, and counts normally otherwise', async () => {
    // 0 = そのプランでは使えない: 1 回目から止め、記録しない
    const free = await createUser('free-locked');
    for (const feature of [ULTIMATE, 'image_generation']) {
      expect(await consume(free.userId, feature), feature).toMatchObject({
        allowed: false,
        metered: true,
        plan: 'free',
        limit: 0,
        used: 0,
        capped_feature: feature,
        plan_locked: true,
      });
    }
    expect(await countersOf(free.userId)).toEqual([]);

    // 上限に達した: 献立の作成は free で 1 日 3 回 (1 日の合計と同じ値なので、先に見る機能ごとの上限で止まる)
    const freeMenu = await createUser('free-menu');
    for (let used = 1; used <= MENU_GENERATION_CAP.free; used++) {
      expect(await consume(freeMenu.userId, 'menu_generation'), `${used} 回目`).toMatchObject({ allowed: true, limit: DAILY_LIMIT.free, used });
    }
    expect(await consume(freeMenu.userId, 'menu_generation')).toMatchObject({
      allowed: false,
      metered: true,
      plan: 'free',
      limit: MENU_GENERATION_CAP.free,
      used: MENU_GENERATION_CAP.free,
      capped_feature: 'menu_generation',
      plan_locked: false,
    });
    expect(await countOf(freeMenu.userId, 'menu_generation')).toBe(MENU_GENERATION_CAP.free);

    // pro の献立の作成: 機能ごとの上限 10 まで。1 日の上限 30 の中で数える
    const pro = await createPlanUser('pro-menu', 'pro');
    for (let used = 1; used <= MENU_GENERATION_CAP.pro; used++) {
      expect(await consume(pro.userId, 'menu_generation'), `${used} 回目`).toMatchObject({ allowed: true, plan: 'pro', limit: DAILY_LIMIT.pro, used });
    }
    expect(await consume(pro.userId, 'menu_generation')).toMatchObject({
      allowed: false,
      limit: MENU_GENERATION_CAP.pro,
      used: MENU_GENERATION_CAP.pro,
      capped_feature: 'menu_generation',
      plan_locked: false,
    });
    // 行の無い機能 (写真の記録・画像の作成 (有料は行なし)) は 1 日の上限だけで数える (止めた献立の作成は記録しない)
    const photo = await consume(pro.userId, 'photo_analysis');
    expect(photo).toMatchObject({ allowed: true, metered: true, plan: 'pro', limit: DAILY_LIMIT.pro, used: MENU_GENERATION_CAP.pro + 1 });
    expect(photo).not.toHaveProperty('capped_feature');
    expect(await consume(pro.userId, 'image_generation')).toMatchObject({ allowed: true, used: MENU_GENERATION_CAP.pro + 2 });
  });

  // 75
  it('consume_ai_usage_capped uses the plan row when present and the env cap otherwise', async () => {
    // 行のあるプラン (pro = 2): 引数の上限 (1) を使わず、行の値で判定する
    const pro = await createPlanUser('capped-pro', 'pro');
    expect(await consumeCapped(pro.userId)).toMatchObject({ allowed: true, plan: 'pro', used: 1 });
    expect(await consumeCapped(pro.userId)).toMatchObject({ allowed: true, plan: 'pro', used: 2 });
    expect(await consumeCapped(pro.userId)).toMatchObject({
      allowed: false,
      plan: 'pro',
      limit: ULTIMATE_CAP.pro,
      used: ULTIMATE_CAP.pro,
      capped_feature: ULTIMATE,
      plan_locked: false,
    });
    expect(await countOf(pro.userId, ULTIMATE)).toBe(ULTIMATE_CAP.pro);

    // 行のあるプラン (free = 0): 引数で大きな上限を渡しても使えない
    const free = await createUser('capped-free');
    expect(await consumeCapped(free.userId, ULTIMATE, ULTIMATE_CAP.family_pro)).toMatchObject({
      allowed: false,
      limit: 0,
      capped_feature: ULTIMATE,
      plan_locked: true,
    });

    // 行の無いプラン (組織の plan): 引数の上限 (環境変数の既定 1) で判定する (従来どおり。plan は返さない)
    const orgMember = await createOrgMember('capped-org');
    expect(await consumeCapped(orgMember.userId)).toMatchObject({ allowed: true, plan: ORG_PLAN, used: 1 });
    const second = await consumeCapped(orgMember.userId);
    expect(second).toMatchObject({ allowed: false, plan: null, limit: ENV_ULTIMATE_CAP, used: ENV_ULTIMATE_CAP, capped_feature: ULTIMATE });
    expect(second).not.toHaveProperty('plan_locked');
  });

  // 76
  it('family plan members inherit the family plan limits via get_effective_plan', async () => {
    const member = await createFamilyMember('family-pro', 'family_pro');
    for (let used = 1; used <= ULTIMATE_CAP.family_pro; used++) {
      expect(await consumeCapped(member.userId), `${used} 回目`).toMatchObject({ allowed: true, plan: 'family_pro', limit: DAILY_LIMIT.family_pro, used });
    }
    expect(await consumeCapped(member.userId)).toMatchObject({
      allowed: false,
      plan: 'family_pro',
      limit: ULTIMATE_CAP.family_pro,
      capped_feature: ULTIMATE,
    });
    const basicMember = await createFamilyMember('family-basic', 'family_basic');
    expect(await consume(basicMember.userId, 'consultation')).toMatchObject({ allowed: true, plan: 'family_basic', limit: DAILY_LIMIT.family_basic });
  });

  // 91
  it('meal_image_auto is denied with plan_locked for free before the unmetered branch (no counter row), while a paid plan without a row still uses the ai_unmetered_daily_caps safety cap', async () => {
    const free = await createUser('meal-image-free');
    const denied = await consume(free.userId, 'meal_image_auto');
    // 止めたときは metered: true (安全弁の止め (metered: false) と区別する)
    expect(denied).toMatchObject({ allowed: false, metered: true, plan: 'free', limit: 0, used: 0, capped_feature: 'meal_image_auto', plan_locked: true });
    expect(await countersOf(free.userId)).toEqual([]);

    const { data: capRow, error } = await srAdmin.from('ai_unmetered_daily_caps').select('daily_cap').eq('feature', 'meal_image_auto').single();
    if (error || !capRow) throw new Error(`ai_unmetered_daily_caps: ${error?.message}`);
    const safetyCap = (capRow as { daily_cap: number }).daily_cap;
    const pro = await createPlanUser('meal-image-pro', 'pro');
    for (let i = 1; i <= safetyCap; i++) {
      expect(await consume(pro.userId, 'meal_image_auto'), `${i} 回目`).toMatchObject({ allowed: true, metered: false });
    }
    const over = await consume(pro.userId, 'meal_image_auto');
    expect(over).toMatchObject({ allowed: false, metered: false, plan: null, limit: safetyCap, used: safetyCap });
    expect(over).not.toHaveProperty('capped_feature');
    expect(await countOf(pro.userId, 'meal_image_auto')).toBe(safetyCap);
  });

  // 107
  it('an organization member without a personal or family plan keeps the pre-migration daily limit (the standard and org_* rows hold the old free value) while a free user is limited to 3', async () => {
    const { data, error } = await srAdmin.from('ai_daily_limits').select('plan_key, daily_limit').in('plan_key', [...ORG_PLAN_KEYS, 'free']);
    if (error) throw new Error(`ai_daily_limits: ${error.message}`);
    const limits = Object.fromEntries(((data ?? []) as Array<{ plan_key: string; daily_limit: number | null }>).map((r) => [r.plan_key, r.daily_limit]));
    for (const planKey of ORG_PLAN_KEYS) expect(limits[planKey], planKey).toBe(PRE_MIGRATION_FREE_LIMIT);
    expect(limits.free).toBe(DAILY_LIMIT.free);

    const orgMember = await createOrgMember('org-limit');
    for (let used = 1; used <= PRE_MIGRATION_FREE_LIMIT; used++) {
      expect(await consume(orgMember.userId, 'photo_analysis'), `${used} 回目`).toMatchObject({ allowed: true, plan: ORG_PLAN, limit: PRE_MIGRATION_FREE_LIMIT, used });
    }
    expect(await consume(orgMember.userId, 'photo_analysis')).toMatchObject({ allowed: false, plan: ORG_PLAN, limit: PRE_MIGRATION_FREE_LIMIT });

    const free = await createUser('free-limit');
    for (let used = 1; used <= DAILY_LIMIT.free; used++) {
      expect(await consume(free.userId, 'photo_analysis'), `${used} 回目`).toMatchObject({ allowed: true, plan: 'free', limit: DAILY_LIMIT.free, used });
    }
    expect(await consume(free.userId, 'photo_analysis')).toMatchObject({ allowed: false, plan: 'free', limit: DAILY_LIMIT.free, used: DAILY_LIMIT.free });
  });

  // #1912 段 A の整合ゲートの指摘 (組織の plan の値 'premium'・'enterprise' に行が無く、free の 3 で判定されていた)
  it('every value the app can write to organizations.plan (ORG_PLAN_VALUES) has an ai_daily_limits row holding the organization limit, and a member of each such organization is judged by it, not by free', async () => {
    const { data, error } = await srAdmin.from('ai_daily_limits').select('plan_key, daily_limit').in('plan_key', [...ORG_PLAN_VALUES]);
    if (error) throw new Error(`ai_daily_limits: ${error.message}`);
    const limits = new Map(((data ?? []) as Array<{ plan_key: string; daily_limit: number | null }>).map((r) => [r.plan_key, r.daily_limit]));
    for (const plan of ORG_PLAN_VALUES) {
      expect(limits.has(plan), `${plan} の行`).toBe(true);
      expect(limits.get(plan), plan).toBe(PRE_MIGRATION_FREE_LIMIT);
    }

    for (const [plan, organizationId] of orgIdByPlan) {
      const member = await createOrgMember(`org-limit-${plan}`, organizationId);
      for (let used = 1; used <= PRE_MIGRATION_FREE_LIMIT; used++) {
        expect(await consume(member.userId, 'photo_analysis'), `${plan} ${used} 回目`).toMatchObject({ allowed: true, plan, limit: PRE_MIGRATION_FREE_LIMIT, used });
      }
      expect(await consume(member.userId, 'photo_analysis'), plan).toMatchObject({ allowed: false, plan, limit: PRE_MIGRATION_FREE_LIMIT, used: PRE_MIGRATION_FREE_LIMIT });
    }
    // ORG_PLAN 以外の値の組織を作れていること (空の Map で上のループが素通りしない)
    expect([...orgIdByPlan.keys()].sort()).toEqual(ORG_PLAN_VALUES.filter((plan) => plan !== ORG_PLAN).sort());
  });
});

describe('billing/03 §6.5: ai_plan_feature_daily_cap (数えない読み取り)', () => {
  // 112
  it('ai_plan_feature_daily_cap returns 0 for meal_image_auto of a free user, NULL for a pro user (no row) and the family plan value for a member of a family plan group, and does not write ai_usage_counters', async () => {
    const free = await createUser('daily-cap-free');
    const pro = await createPlanUser('daily-cap-pro', 'pro');
    const member = await createFamilyMember('daily-cap-family', 'family_pro');

    expect(await featureDailyCap(free.userId, 'meal_image_auto')).toBe(0);
    expect(await featureDailyCap(pro.userId, 'meal_image_auto')).toBeNull();
    expect(await featureDailyCap(member.userId, ULTIMATE)).toBe(ULTIMATE_CAP.family_pro);
    expect(await featureDailyCap(member.userId, 'menu_generation')).toBe(MENU_GENERATION_CAP.family_pro);
    expect(await featureDailyCap(pro.userId, ULTIMATE)).toBe(ULTIMATE_CAP.pro);
    // 行の無い機能は NULL
    expect(await featureDailyCap(free.userId, 'photo_analysis')).toBeNull();

    for (const user of [free, pro, member]) expect(await countersOf(user.userId)).toEqual([]);

    // service_role だけ (anon / authenticated は呼べない)
    const { error } = await anon().rpc('ai_plan_feature_daily_cap', { p_user_id: free.userId, p_feature: 'meal_image_auto' });
    expect(error?.code).toBe('42501');
  });

  it('ai_plan_feature_caps is service_role only (RLS on, no policy) and rejects a feature outside the 4 and a negative cap', async () => {
    const { error: readError } = await anon().from('ai_plan_feature_caps').select('plan_key').limit(1);
    expect(readError?.code).toBe('42501');
    expect((await srAdmin.from('ai_plan_feature_caps').insert({ plan_key: 'pro', feature: 'photo_analysis', daily_cap: 1 })).error?.code).toBe('23514');
    expect((await srAdmin.from('ai_plan_feature_caps').insert({ plan_key: 'org_standard', feature: 'image_generation', daily_cap: -1 })).error?.code).toBe('23514');
    // 番兵: 既定の行は service_role で読める
    const { data, error } = await srAdmin.from('ai_plan_feature_caps').select('plan_key, feature, daily_cap').eq('plan_key', 'free').order('feature');
    expect(error).toBeNull();
    expect(data).toEqual([
      { plan_key: 'free', feature: 'image_generation', daily_cap: 0 },
      { plan_key: 'free', feature: 'meal_image_auto', daily_cap: 0 },
      { plan_key: 'free', feature: 'menu_generation', daily_cap: MENU_GENERATION_CAP.free },
      { plan_key: 'free', feature: 'menu_generation_ultimate', daily_cap: ULTIMATE_CAP.free },
    ]);
  });
});

describe('#1912 段 A の整合ゲートの指摘: owner / admin の JWT による organizations.plan の直接の書き込み', () => {
  /** ORG_PLAN_VALUES の外の値: 有料の plan_key (支払い無しで有料の上限になる)・free・組織の plan_key (アプリは書かない)・行の無い値 */
  const NOT_ALLOWED: ReadonlyArray<string | null> = ['pro', 'family_basic', 'family_pro', 'free', 'org_pro', 'not-a-plan', null];

  async function createOrgStaff(label: string, role: 'owner' | 'admin'): Promise<TestUser> {
    const user = await createUser(label, { withJwt: true });
    const { error } = await srAdmin.from('user_profiles').update({ organization_id: planGuardOrgId, org_role: role }).eq('id', user.userId);
    if (error) throw new Error(`user_profiles.org_role ${label}: ${error.message}`);
    return user;
  }

  async function planOf(organizationId: string): Promise<string | null> {
    const { data, error } = await srAdmin.from('organizations').select('plan').eq('id', organizationId).single();
    if (error || !data) throw new Error(`organizations.plan: ${error?.message}`);
    return (data as { plan: string | null }).plan;
  }

  async function setPlanAsService(plan: string): Promise<void> {
    const { error } = await srAdmin.from('organizations').update({ plan }).eq('id', planGuardOrgId!);
    if (error) throw new Error(`organizations.plan (service_role) ${plan}: ${error.message}`);
  }

  it('an owner or admin cannot PATCH organizations.plan to a value outside ORG_PLAN_VALUES (ORG_PLAN_NOT_ALLOWED, 42501), the plan stays, and a member is still judged by the organization limit', async () => {
    await setPlanAsService(ORG_PLAN);
    const owner = await createOrgStaff('guard-owner', 'owner');
    const admin = await createOrgStaff('guard-admin', 'admin');
    for (const staff of [owner, admin]) {
      for (const plan of NOT_ALLOWED) {
        const { data, error } = await asUser(staff.jwt!).from('organizations').update({ plan }).eq('id', planGuardOrgId!).select('plan');
        expect(error?.code, String(plan)).toBe('42501');
        expect(error?.message, String(plan)).toBe('ORG_PLAN_NOT_ALLOWED');
        expect(data, String(plan)).toBeNull();
        expect(await planOf(planGuardOrgId!), String(plan)).toBe(ORG_PLAN);
      }
    }

    // 拒んだあとも、メンバーは組織の上限 (有料の 30 / 50 でも free の 3 でもない) で判定される
    const member = await createOrgMember('guard-member', planGuardOrgId);
    expect(await consume(member.userId, 'photo_analysis')).toMatchObject({ allowed: true, plan: ORG_PLAN, limit: PRE_MIGRATION_FREE_LIMIT, used: 1 });
  });

  it('an owner or admin can still PATCH organizations.plan to every value in ORG_PLAN_VALUES (the org settings path), and an UPDATE that keeps the plan is not stopped', async () => {
    await setPlanAsService(ORG_PLAN);
    const owner = await createOrgStaff('allow-owner', 'owner');
    const admin = await createOrgStaff('allow-admin', 'admin');
    for (const staff of [owner, admin]) {
      // 今の値と違う値から順に書く (同じ値だとトリガーの枝を通らない)。最後に ORG_PLAN に戻す
      const order = [...ORG_PLAN_VALUES.filter((plan) => plan !== ORG_PLAN), ORG_PLAN];
      for (const plan of order) {
        const { data, error } = await asUser(staff.jwt!).from('organizations').update({ plan }).eq('id', planGuardOrgId!).select('plan');
        expect(error, plan).toBeNull();
        expect(data, plan).toEqual([{ plan }]);
      }
    }

    // service_role はトリガーに止められない (運営の作業・フィクスチャ)。その値のまま plan を書く UPDATE と、plan を書かない UPDATE は
    // ログインした利用者でも通る (値を変えていないので)
    await setPlanAsService('org_pro');
    expect(await planOf(planGuardOrgId!)).toBe('org_pro');
    const same = await asUser(owner.jwt!).from('organizations').update({ plan: 'org_pro' }).eq('id', planGuardOrgId!).select('plan');
    expect(same.error).toBeNull();
    expect(same.data).toEqual([{ plan: 'org_pro' }]);
    const rename = await asUser(owner.jwt!).from('organizations').update({ name: `plan-caps guard org renamed ${TS}` }).eq('id', planGuardOrgId!).select('plan');
    expect(rename.error).toBeNull();
    expect(rename.data).toEqual([{ plan: 'org_pro' }]);
    await setPlanAsService(ORG_PLAN);
  });

  it('a signed-in user cannot INSERT an organization with a paid plan (no INSERT policy for authenticated)', async () => {
    const user = await createUser('guard-insert', { withJwt: true });
    const { data, error } = await asUser(user.jwt!)
      .from('organizations')
      .insert({ name: `plan-caps guard insert ${TS}`, plan: 'pro', owner_id: user.userId })
      .select('id');
    expect(error?.code).toBe('42501');
    expect(data).toBeNull();
  });
});
