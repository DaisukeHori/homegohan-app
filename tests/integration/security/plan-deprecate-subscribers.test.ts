/**
 * 契約者がいるプランを廃止できないことの回帰テスト (#1127)
 *   PATCH /api/super-admin/plans/[id]   { status: 'deprecated', ends_at }
 *
 * 契約者への移行案内・自動更新の停止・廃止前の通知はまだ無い (課金開始までは作らない)。
 * 契約者がいるまま廃止すると、廃止したプランで課金だけが続くおそれがあるため、
 * 廃止の前に、契約が終わっていない契約者を service_role で数えて、1 件でもいれば 409 で止める。
 *
 * 単体テストは Supabase をモックするので、数えるときの列名 (organizations は plan_key ではなく plan)・
 * status の値・テーブルの制約 (paused は paused_until が必須) までは確かめられない。
 * ここでは実際の Next サーバーと実 DB (ローカル Supabase) の組み合わせで確かめる。
 *
 *   P-1: 契約者のいないプランは 200 で廃止できる
 *   P-2: 個人契約 (trialing / active / paused / past_due / grace) があるプランは 409。プランは公開中のまま
 *   P-3: 終了済み (cancelled / expired) の個人契約だけなら 200
 *   F-1: 家族グループ (active) があるプランは 409
 *   F-2: 解散済み (dissolved) の家族グループだけなら 200
 *   O-1: 組織 (plan が plan_key と一致する active) があるプランは 409
 *   O-2: 解散済みの組織だけなら 200 (解散しても plan は残るので、status で絞らないと止め続ける)
 *   M-1: 3 種類がそろっているときは、409 の counts にテーブルごとの内訳が返る
 *   M-2: 別プランの契約者は数えない
 *   A-1: 公開 --> 非公開 は、契約者がいても 200 (新しい申込だけを止める操作は妨げない)
 *   G-1: 組織のプランの行 (plan_type = 'org' の org_*) は組織の件数を数えない。plan が一致する active の組織があっても 200 (#1912)
 *   G-2: 組織のプランの行に個人契約があれば 409。counts に組織の欄 (organizations) を出さず、注記 (organizations_note) を返す (#1912)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/plan-deprecate-subscribers.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { supabaseAdmin as srAdmin } from '../helpers/supabase';
import { apiCall } from '../helpers/api';
import { cleanupAuditLogs, cleanupTestUser, createTestUserWithRoles, testEmail, type TestUser } from '../helpers/users';

const TS = Date.now();
const ENDS_AT = '2099-01-01T00:00:00.000Z';

let superAdmin: TestUser;
/** 個人契約・家族グループの持ち主 (契約者) */
let subscriber: TestUser;
/** この実行で作ったプランの plan_key (後片付け用) */
const planKeys: string[] = [];
let planSeq = 0;

interface PatchBody {
  data?: { id: string; status: string };
  error?: {
    code?: string;
    message?: string;
    counts?: { personal_subscriptions: number; family_groups: number; organizations?: number };
    organizations_note?: string;
  };
}

/**
 * 公開中のプランを 1 つ作る (シナリオごとに別のプランを使い、状態を引きずらない)。
 * planType = 'org' なら、組織のプランの行 (plan_key は org_ で始まる。#1912) を作る
 */
async function createPlan(label: string, planType: 'personal' | 'org' = 'personal'): Promise<{ id: string; planKey: string }> {
  planSeq += 1;
  const planKey = `${planType === 'org' ? 'org_' : ''}it_1127_${label}_${planSeq}_${TS}`;
  const { data, error } = await srAdmin
    .from('subscription_plans')
    .insert({
      plan_key: planKey,
      display_name: `#1127 ${label} ${TS}`,
      plan_type: planType,
      status: 'public',
      monthly_price_jpy: 100,
      version: 1,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`subscription_plans insert: ${error?.message}`);
  planKeys.push(planKey);
  return { id: data.id as string, planKey };
}

async function addPersonalSubscription(planKey: string, status: string) {
  const { error } = await srAdmin.from('personal_subscriptions').insert({
    user_id: subscriber.userId,
    plan_key: planKey,
    status,
    // paused は paused_until が必須 (ps_paused_until_required)
    ...(status === 'paused' ? { paused_until: new Date(Date.now() + 86_400_000).toISOString() } : {}),
  });
  if (error) throw new Error(`personal_subscriptions insert (${status}): ${error.message}`);
}

// billing/01 §6.4 (10): active なグループの INSERT はトリガーが代表者の契約から plan_key を決めるので、
// プランの付いたグループは INSERT のあと service_role の UPDATE で作る (UPDATE OF plan_key はトリガーに当たらない)
async function addFamily(planKey: string, status: 'active' | 'dissolved') {
  const { data, error } = await srAdmin
    .from('family_groups')
    .insert({
      name: `it-1127 ${status} ${TS}`,
      representative_id: subscriber.userId,
      plan_key: planKey,
      status,
      ...(status === 'dissolved' ? { dissolved_at: new Date().toISOString() } : {}),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`family_groups insert (${status}): ${error?.message}`);
  const { error: planError } = await srAdmin.from('family_groups').update({ plan_key: planKey }).eq('id', data.id);
  if (planError) throw new Error(`family_groups.plan_key (${status}): ${planError.message}`);
}

async function addOrganization(planKey: string, status: 'active' | 'dissolved') {
  const { error } = await srAdmin.from('organizations').insert({
    name: `it-1127 ${status} ${TS}`,
    // owner_id は NOT NULL (#1103 項目 10)。家族の代表者と同じく契約者にする (afterAll で組織を消してからユーザーを消す)
    owner_id: subscriber.userId,
    plan: planKey,
    status,
    ...(status === 'dissolved' ? { dissolved_at: new Date().toISOString() } : {}),
  });
  if (error) throw new Error(`organizations insert (${status}): ${error.message}`);
}

function deprecate(planId: string) {
  return apiCall<PatchBody>('PATCH', `/api/super-admin/plans/${planId}`, superAdmin.jwt, {
    status: 'deprecated',
    ends_at: ENDS_AT,
  });
}

async function statusOf(planId: string): Promise<string | undefined> {
  const { data } = await srAdmin.from('subscription_plans').select('status').eq('id', planId).single();
  return data?.status as string | undefined;
}

beforeAll(async () => {
  [superAdmin, subscriber] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('plan-dep-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('plan-dep-sub', TS), roles: ['user'] }),
  ]);
}, 60_000);

// 1 人が持てる「終わっていない個人契約」は 1 件まで (idx_personal_subscriptions_active_per_user) なので、シナリオごとに片付ける
afterEach(async () => {
  await srAdmin.from('personal_subscriptions').delete().eq('user_id', subscriber.userId);
});

afterAll(async () => {
  for (const planKey of planKeys) {
    // 外部キー (family_groups.plan_key / personal_subscriptions.plan_key) があるので、プランより先に契約者を消す
    await srAdmin.from('personal_subscriptions').delete().eq('plan_key', planKey);
    await srAdmin.from('family_groups').delete().eq('plan_key', planKey);
    await srAdmin.from('organizations').delete().eq('plan', planKey);
    await srAdmin.from('subscription_plans').delete().eq('plan_key', planKey);
  }
  await cleanupAuditLogs(superAdmin.userId);
  // family_groups.representative_id と organizations.owner_id は ON DELETE RESTRICT なので、家族グループ・組織を消したあとにユーザーを消す
  await Promise.all([cleanupTestUser(superAdmin.userId), cleanupTestUser(subscriber.userId)]);
}, 60_000);

describe('P: 個人契約 (personal_subscriptions) (#1127)', () => {
  it('P-1: 契約者のいないプランは 200 で廃止できる', async () => {
    const plan = await createPlan('p1');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe('deprecated');
    expect(await statusOf(plan.id)).toBe('deprecated');
  });

  it.each(['trialing', 'active', 'paused', 'past_due', 'grace'])(
    'P-2: 個人契約 (%s) があるプランは 409 OP_PLAN_HAS_SUBSCRIBERS。プランは公開中のまま',
    async (status) => {
      const plan = await createPlan(`p2_${status}`);
      await addPersonalSubscription(plan.planKey, status);

      const res = await deprecate(plan.id);

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('OP_PLAN_HAS_SUBSCRIBERS');
      expect(res.body.error?.counts).toEqual({ personal_subscriptions: 1, family_groups: 0, organizations: 0 });
      expect(res.body.error?.message).toContain('個人契約 1 件');
      expect(await statusOf(plan.id)).toBe('public');
    },
  );

  it('P-3: 終了済み (cancelled / expired) の個人契約だけなら 200 で廃止できる', async () => {
    const plan = await createPlan('p3');
    await addPersonalSubscription(plan.planKey, 'cancelled');
    await addPersonalSubscription(plan.planKey, 'expired');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(200);
    expect(await statusOf(plan.id)).toBe('deprecated');
  });
});

describe('F: 家族グループ (family_groups) (#1127)', () => {
  it('F-1: 家族グループ (active) があるプランは 409。プランは公開中のまま', async () => {
    const plan = await createPlan('f1');
    await addFamily(plan.planKey, 'active');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('OP_PLAN_HAS_SUBSCRIBERS');
    expect(res.body.error?.counts).toEqual({ personal_subscriptions: 0, family_groups: 1, organizations: 0 });
    expect(await statusOf(plan.id)).toBe('public');
  });

  it('F-2: 解散済み (dissolved) の家族グループだけなら 200 で廃止できる', async () => {
    const plan = await createPlan('f2');
    await addFamily(plan.planKey, 'dissolved');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(200);
    expect(await statusOf(plan.id)).toBe('deprecated');
  });
});

describe('O: 組織 (organizations) (#1127)', () => {
  it('O-1: 組織 (plan が plan_key と一致する active) があるプランは 409。プランは公開中のまま', async () => {
    const plan = await createPlan('o1');
    await addOrganization(plan.planKey, 'active');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('OP_PLAN_HAS_SUBSCRIBERS');
    expect(res.body.error?.counts).toEqual({ personal_subscriptions: 0, family_groups: 0, organizations: 1 });
    expect(await statusOf(plan.id)).toBe('public');
  });

  it('O-2: 解散済みの組織だけなら 200 で廃止できる (解散しても plan は残る)', async () => {
    const plan = await createPlan('o2');
    await addOrganization(plan.planKey, 'dissolved');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(200);
    expect(await statusOf(plan.id)).toBe('deprecated');
  });
});

describe('M: 組み合わせと範囲 (#1127)', () => {
  it('M-1: 3 種類の契約者がそろっているときは、counts にテーブルごとの内訳が返る', async () => {
    const plan = await createPlan('m1');
    await addPersonalSubscription(plan.planKey, 'active');
    await addFamily(plan.planKey, 'active');
    await addOrganization(plan.planKey, 'active');
    await addOrganization(plan.planKey, 'active');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(409);
    expect(res.body.error?.counts).toEqual({ personal_subscriptions: 1, family_groups: 1, organizations: 2 });
    expect(res.body.error?.message).toContain('個人契約 1 件・家族グループ 1 件・組織 2 件');
    expect(await statusOf(plan.id)).toBe('public');
  });

  it('M-2: 別プランの契約者は数えない', async () => {
    const target = await createPlan('m2_target');
    const other = await createPlan('m2_other');
    await addPersonalSubscription(other.planKey, 'active');
    await addFamily(other.planKey, 'active');
    await addOrganization(other.planKey, 'active');

    const res = await deprecate(target.id);

    expect(res.status).toBe(200);
    expect(await statusOf(target.id)).toBe('deprecated');
    expect(await statusOf(other.id)).toBe('public');
  });

  it('A-1: 公開 --> 非公開 は、契約者がいても 200 (新しい申込だけを止める操作は妨げない)', async () => {
    const plan = await createPlan('a1');
    await addPersonalSubscription(plan.planKey, 'active');

    const res = await apiCall<PatchBody>('PATCH', `/api/super-admin/plans/${plan.id}`, superAdmin.jwt, { status: 'private' });

    expect(res.status).toBe(200);
    expect(await statusOf(plan.id)).toBe('private');
  });
});

describe('G: 組織のプランの行 (org_*) は組織の件数を数えない (#1912)', () => {
  it('G-1: plan が一致する active の組織があっても数えず、個人・家族がいなければ 200 で廃止できる', async () => {
    const plan = await createPlan('g1', 'org');
    // 運営の経路では organizations.plan に org_* は入らない (standard / premium / enterprise だけ)。service_role で直接入れても数えない
    await addOrganization(plan.planKey, 'active');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(200);
    expect(await statusOf(plan.id)).toBe('deprecated');
  });

  it('G-2: 個人契約があれば 409。counts に組織の欄を出さず、注記を返す', async () => {
    const plan = await createPlan('g2', 'org');
    await addPersonalSubscription(plan.planKey, 'active');

    const res = await deprecate(plan.id);

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('OP_PLAN_HAS_SUBSCRIBERS');
    expect(res.body.error?.counts).toEqual({ personal_subscriptions: 1, family_groups: 0 });
    expect(typeof res.body.error?.organizations_note).toBe('string');
    expect(res.body.error?.message).toContain(res.body.error?.organizations_note);
    expect(await statusOf(plan.id)).toBe('public');
  });
});
