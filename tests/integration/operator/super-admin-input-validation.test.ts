/**
 * Integration tests: super-admin API の入力検証と業務ルールによる拒否 (400 / 404 / 409 / 422) (#850)
 *
 * 各エンドポイントのテストファイル (super-admin-*.test.ts) は、正常系と認可 (401 / 403) を中心に確かめている。
 * ここには、入力の検証や業務ルールで「拒否される」ことを確かめるケースのうち、他のファイルにまだ無いものをまとめた。
 *   - 不正な入力 (形式・範囲・必須項目) は 400 とエラーコードで返り、DB を変更しない
 *   - 存在しない対象は 404
 *   - 既に使われているコードなどは 409、状態の制約に反する操作は 422
 *
 * 対象は plans (price-change / price-impact を含む) / coupons (apply を含む) / flags / feature-packages /
 * experiments / audit-logs / infra / llm usage。
 * 多くの API は検証を DB に触れる前に行うため、拒否されるはずのリクエストは対象の行が無くても 400 になる
 * (plans の PATCH だけは先に行を引くので、実在する draft のプランを使う)。
 * 拒否のあとに行が変わっていないことは、課金や公開状態に関わる箇所だけ DB を読んで確かめる。
 *
 * 成功する経路 (200 / 201 / 204) と認可は、エンドポイントごとの super-admin-*.test.ts にある。
 * 各 API の仕様は operator/02-api-spec.md、エラーコードは各 route の実装に合わせてある。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { supabaseAdmin } from '../helpers/supabase';
import { TestUserPool, dataOf, expectError, randomUuid } from '../helpers/admin-test-utils';
import type { TestUser } from '../helpers/users';

const TS = Date.now();
const pool = new TestUserPool(TS, 'sa-valid');

const DAY_MS = 24 * 60 * 60 * 1000;

/** [ケースの説明, 正しい本文に上書きする項目]。値が undefined の項目は本文から外れる (JSON にならない) */
type Case = [label: string, override: Record<string, unknown>];

let superAdminUser: TestUser;
let adminUser: TestUser;

/** 公開中のプラン (status ロック・価格変更の検証用) と draft のプラン。どちらも service_role で作る */
let publicPlanId: string;
let draftPlanId: string;
const PUBLIC_PLAN_PRICE = 1500;

/** 利用実績が無いクーポン (有効期間内) と、利用実績があるクーポン (uses_count = 1) */
let couponId: string;
let usedCouponId: string;
const COUPON_CODE = `VALFIX${TS}`;
const USED_COUPON_CODE = `VALUSED${TS}`;

/** 既存の機能フラグ */
const FLAG_KEY = `val_flag_${TS}`;

/**
 * POST の検証で「通ってしまった」場合に取り残さないよう、作られうる行のキーを固定しておき、afterAll で消す。
 * (検証が正しく働いていれば、これらの行は作られない)
 */
const POST_PLAN_KEY = `val_post_plan_${TS}`;
const POST_COUPON_CODE = `VALPOST${TS}`;
const POST_FLAG_KEY = `val_post_flag_${TS}`;
const POST_PACKAGE_KEY = `val_post_pkg_${TS}`;
const POST_EXPERIMENT_KEY = `val_post_exp_${TS}`;

beforeAll(async () => {
  const users = await pool.createMany({ sa: ['super_admin'], admin: ['admin'] });
  superAdminUser = users.sa;
  adminUser = users.admin;

  // INSERT の error は必ず確認する (握りつぶすと、行が入らないまま検証が空振りで通る)
  const planBase = {
    plan_type: 'personal',
    monthly_price_jpy: PUBLIC_PLAN_PRICE,
    yearly_price_jpy: 15000,
    version: 1,
  };
  const { data: plans, error: planErr } = await supabaseAdmin
    .from('subscription_plans')
    .insert([
      { ...planBase, plan_key: `val_public_${TS}`, display_name: `Validation Public Plan ${TS}`, status: 'public' },
      { ...planBase, plan_key: `val_draft_${TS}`, display_name: `Validation Draft Plan ${TS}`, status: 'draft' },
    ])
    .select('id, plan_key');
  if (planErr || !plans) throw new Error(`Failed to create plans: ${planErr?.message}`);
  publicPlanId = plans.find((p) => p.plan_key === `val_public_${TS}`)!.id;
  draftPlanId = plans.find((p) => p.plan_key === `val_draft_${TS}`)!.id;

  const couponBase = {
    discount_type: 'percentage',
    discount_value: 10,
    applicable_to: 'all',
    valid_from: new Date(Date.now() - DAY_MS).toISOString(),
    valid_until: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    status: 'active',
    created_by: superAdminUser.userId,
  };
  const { data: coupons, error: couponErr } = await supabaseAdmin
    .from('coupons')
    .insert([
      { ...couponBase, code: COUPON_CODE, display_name: `Validation Coupon ${TS}`, uses_count: 0 },
      { ...couponBase, code: USED_COUPON_CODE, display_name: `Validation Used Coupon ${TS}`, uses_count: 1 },
    ])
    .select('id, code');
  if (couponErr || !coupons) throw new Error(`Failed to create coupons: ${couponErr?.message}`);
  couponId = coupons.find((c) => c.code === COUPON_CODE)!.id;
  usedCouponId = coupons.find((c) => c.code === USED_COUPON_CODE)!.id;

  const { error: flagErr } = await supabaseAdmin
    .from('feature_flags')
    .insert({ key: FLAG_KEY, description: 'validation fixture', enabled: false, created_by: superAdminUser.userId });
  if (flagErr) throw new Error(`Failed to create feature flag: ${flagErr.message}`);
}, 60000);

afterAll(async () => {
  // 後片付けは、固定のキーか、このファイルが作った id だけを対象にする
  const planIds = [publicPlanId, draftPlanId].filter(Boolean);
  if (planIds.length > 0) {
    // 公開中のプランは draft に戻してから消す (他のテストの後片付けと同じ手順)
    await supabaseAdmin.from('subscription_plans').update({ status: 'draft' }).in('id', planIds);
    await supabaseAdmin.from('plan_price_history').delete().in('plan_id', planIds);
    await supabaseAdmin.from('subscription_plans').delete().in('id', planIds);
  }
  await supabaseAdmin.from('subscription_plans').delete().eq('plan_key', POST_PLAN_KEY).eq('status', 'draft');
  await supabaseAdmin.from('coupons').delete().in('code', [COUPON_CODE, USED_COUPON_CODE, POST_COUPON_CODE]);
  await supabaseAdmin.from('feature_flags').delete().in('key', [FLAG_KEY, POST_FLAG_KEY]);
  await supabaseAdmin.from('feature_packages').delete().eq('package_key', POST_PACKAGE_KEY);
  await supabaseAdmin.from('experiments').delete().eq('key', POST_EXPERIMENT_KEY);

  await pool.cleanup();
}, 30000);

// ─────────────────────────────────────────
// plans
// ─────────────────────────────────────────

describe('GET /api/super-admin/plans: query validation', () => {
  it.each<[string, string]>([
    ['type が不正', 'type=enterprise'],
    ['status が不正', 'status=archived'],
    ['page が 0', 'page=0'],
    ['per_page が 0', 'per_page=0'],
    ['per_page が上限 (200) を超える', 'per_page=201'],
  ])('400 OP_INVALID_QUERY: %s', async (_label, query) => {
    const res = await apiCall('GET', `/api/super-admin/plans?${query}`, superAdminUser.jwt);
    expectError(res, 400, 'OP_INVALID_QUERY');
  });
});

describe('POST /api/super-admin/plans: input validation', () => {
  const base = { plan_key: POST_PLAN_KEY, display_name: 'Validation Plan', plan_type: 'personal' };

  it.each<Case>([
    ['plan_key に大文字を含む', { plan_key: 'Bad_Key' }],
    ['plan_key が空', { plan_key: '' }],
    ['display_name が無い', { display_name: undefined }],
    ['plan_type が不正', { plan_type: 'enterprise' }],
    ['monthly_price_jpy が負', { monthly_price_jpy: -1 }],
    ['monthly_price_jpy が整数でない', { monthly_price_jpy: 980.5 }],
    ['組織プランに試用期間 (trial_days) を付けた', { plan_type: 'org', trial_days: 7 }],
  ])('400 OP_INVALID_INPUT: %s', async (_label, override) => {
    const res = await apiCall('POST', '/api/super-admin/plans', superAdminUser.jwt, { ...base, ...override });
    expectError(res, 400, 'OP_INVALID_INPUT');
  });
});

describe('PATCH /api/super-admin/plans/[id]: validation and business rules', () => {
  async function planRow(id: string) {
    const { data, error } = await supabaseAdmin
      .from('subscription_plans')
      .select('status, trial_days, display_name, ends_at')
      .eq('id', id)
      .single();
    if (error || !data) throw new Error(`Failed to read plan ${id}: ${error?.message}`);
    return data;
  }

  it('404 OP_PLAN_NOT_FOUND for a plan that does not exist', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/plans/${randomUuid()}`, superAdminUser.jwt, {
      display_name: 'Nobody',
    });
    expectError(res, 404, 'OP_PLAN_NOT_FOUND');
  });

  it.each<Case>([
    ['status が不正', { status: 'archived' }],
    ['display_name が空', { display_name: '' }],
    ['display_order が負', { display_order: -1 }],
    ['ends_at が日時の形でない', { ends_at: '2026-12-31' }],
    ['feature_package_ids が UUID でない', { feature_package_ids: ['not-a-uuid'] }],
  ])('400 OP_INVALID_INPUT: %s', async (_label, override) => {
    const res = await apiCall('PATCH', `/api/super-admin/plans/${draftPlanId}`, superAdminUser.jwt, override);
    expectError(res, 400, 'OP_INVALID_INPUT');
  });

  it('422 OP_PLAN_STATUS_LOCKED: 公開中のプランでは試用期間を変えられず、行は変わらない', async () => {
    const before = await planRow(publicPlanId);
    const res = await apiCall('PATCH', `/api/super-admin/plans/${publicPlanId}`, superAdminUser.jwt, {
      trial_days: 14,
    });
    expectError(res, 422, 'OP_PLAN_STATUS_LOCKED');
    expect(await planRow(publicPlanId)).toEqual(before);
  });

  it('422 OP_PLAN_INVALID_TRANSITION: draft から deprecated へは変えられず、行は変わらない', async () => {
    const before = await planRow(draftPlanId);
    const res = await apiCall('PATCH', `/api/super-admin/plans/${draftPlanId}`, superAdminUser.jwt, {
      status: 'deprecated',
      ends_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    expectError(res, 422, 'OP_PLAN_INVALID_TRANSITION');
    expect(await planRow(draftPlanId)).toEqual(before);
  });

  it('400 OP_PLAN_DEPRECATE_ENDS_AT_REQUIRED: ends_at なしでは deprecated にできず、行は変わらない', async () => {
    const before = await planRow(publicPlanId);
    const res = await apiCall('PATCH', `/api/super-admin/plans/${publicPlanId}`, superAdminUser.jwt, {
      status: 'deprecated',
    });
    expectError(res, 400, 'OP_PLAN_DEPRECATE_ENDS_AT_REQUIRED');
    expect(await planRow(publicPlanId)).toEqual(before);
  });
});

describe('DELETE /api/super-admin/plans/[id]: 404', () => {
  it('404 OP_PLAN_NOT_FOUND for a plan that does not exist', async () => {
    const res = await apiCall('DELETE', `/api/super-admin/plans/${randomUuid()}`, superAdminUser.jwt);
    expectError(res, 404, 'OP_PLAN_NOT_FOUND');
  });
});

describe('POST /api/super-admin/plans/[id]/price-change: input validation', () => {
  const base = {
    new_monthly_price_jpy: 1800,
    applies_to: 'new_only',
    reason: 'Validation test',
    effective_at: new Date().toISOString(),
  };

  // 検証は対象のプランを引く前に行うため、存在しない id でも 400 になる
  it.each<Case>([
    ['reason が無い', { reason: undefined }],
    ['reason が空', { reason: '' }],
    ['reason が 1000 文字を超える', { reason: 'x'.repeat(1001) }],
    ['月額も年額も指定していない', { new_monthly_price_jpy: null, new_yearly_price_jpy: null }],
    ['月額が負', { new_monthly_price_jpy: -1 }],
    ['月額が整数でない', { new_monthly_price_jpy: 1800.5 }],
    ['年額が負', { new_yearly_price_jpy: -100 }],
    ['effective_at が日時の形でない', { effective_at: '2026-10-08' }],
    ['applies_to が不正', { applies_to: 'everyone' }],
  ])('400 OP_INVALID_INPUT: %s', async (_label, override) => {
    const res = await apiCall(
      'POST',
      `/api/super-admin/plans/${randomUuid()}/price-change`,
      superAdminUser.jwt,
      { ...base, ...override },
    );
    expectError(res, 400, 'OP_INVALID_INPUT');
  });

  it('400 は公開中のプランの価格を変えず、価格変更履歴も残さない', async () => {
    const res = await apiCall(
      'POST',
      `/api/super-admin/plans/${publicPlanId}/price-change`,
      superAdminUser.jwt,
      { ...base, new_monthly_price_jpy: 9999, reason: '' },
    );
    expectError(res, 400, 'OP_INVALID_INPUT');

    const { data: plan, error } = await supabaseAdmin
      .from('subscription_plans')
      .select('monthly_price_jpy')
      .eq('id', publicPlanId)
      .single();
    expect(error).toBeNull();
    expect(plan?.monthly_price_jpy).toBe(PUBLIC_PLAN_PRICE);

    const { count, error: historyErr } = await supabaseAdmin
      .from('plan_price_history')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', publicPlanId);
    expect(historyErr).toBeNull();
    expect(count).toBe(0);
  });

  it('404 OP_PLAN_NOT_FOUND for a plan that does not exist (valid body)', async () => {
    const res = await apiCall(
      'POST',
      `/api/super-admin/plans/${randomUuid()}/price-change`,
      superAdminUser.jwt,
      base,
    );
    expectError(res, 404, 'OP_PLAN_NOT_FOUND');
  });
});

describe('GET /api/super-admin/plans/[id]/price-impact: query validation', () => {
  it.each<[string, string]>([
    ['new_monthly_price_jpy が負', 'new_monthly_price_jpy=-1'],
    ['new_monthly_price_jpy が数値でない', 'new_monthly_price_jpy=abc'],
    ['new_monthly_price_jpy が整数でない', 'new_monthly_price_jpy=1.5'],
  ])('400 OP_INVALID_QUERY: %s', async (_label, query) => {
    const res = await apiCall(
      'GET',
      `/api/super-admin/plans/${randomUuid()}/price-impact?${query}`,
      superAdminUser.jwt,
    );
    expectError(res, 400, 'OP_INVALID_QUERY');
  });
});

// ─────────────────────────────────────────
// coupons
// ─────────────────────────────────────────

describe('GET /api/super-admin/coupons: query validation', () => {
  it.each<[string, string]>([
    ['status が不正', 'status=archived'],
    ['applicable_to が不正', 'applicable_to=everyone'],
    ['page が 0', 'page=0'],
    ['per_page が 0', 'per_page=0'],
    ['per_page が上限 (200) を超える', 'per_page=201'],
  ])('400 OP_INVALID_QUERY: %s', async (_label, query) => {
    const res = await apiCall('GET', `/api/super-admin/coupons?${query}`, superAdminUser.jwt);
    expectError(res, 400, 'OP_INVALID_QUERY');
  });
});

describe('POST /api/super-admin/coupons: input validation', () => {
  const base = {
    code: POST_COUPON_CODE,
    display_name: 'Validation Coupon',
    discount_type: 'percentage',
    discount_value: 10,
    valid_from: new Date(Date.now() + DAY_MS).toISOString(),
    valid_until: new Date(Date.now() + 30 * DAY_MS).toISOString(),
  };

  it.each<Case>([
    ['code に小文字を含む', { code: `val${TS}` }],
    ['code が空', { code: '' }],
    ['code が 50 文字を超える', { code: 'A'.repeat(51) }],
    ['discount_type が不正', { discount_type: 'bogo' }],
    ['割引額が 0', { discount_value: 0 }],
    ['割引額が負', { discount_value: -5 }],
    ['パーセント割引が 100 を超える', { discount_value: 101 }],
    ['有効開始が有効終了より後', { valid_from: base.valid_until, valid_until: base.valid_from }],
    ['valid_until が無い', { valid_until: undefined }],
    ['valid_from が日時の形でない', { valid_from: '2026-10-08' }],
    ['max_uses が 0', { max_uses: 0 }],
    ['applicable_to が不正', { applicable_to: 'everyone' }],
  ])('400 OP_INVALID_INPUT: %s', async (_label, override) => {
    const res = await apiCall('POST', '/api/super-admin/coupons', superAdminUser.jwt, { ...base, ...override });
    expectError(res, 400, 'OP_INVALID_INPUT');
  });

  it('409 OP_COUPON_CODE_DUPLICATE for a code that already exists', async () => {
    const res = await apiCall('POST', '/api/super-admin/coupons', superAdminUser.jwt, {
      ...base,
      code: COUPON_CODE,
    });
    expectError(res, 409, 'OP_COUPON_CODE_DUPLICATE');
  });
});

describe('GET /api/super-admin/coupons/[id]', () => {
  it('200 for super_admin fetching a coupon', async () => {
    const res = await apiCall('GET', `/api/super-admin/coupons/${couponId}`, superAdminUser.jwt);
    const coupon = dataOf<{ id: string; code: string }>(res);
    expect(coupon.id).toBe(couponId);
    expect(coupon.code).toBe(COUPON_CODE);
  });

  it('404 OP_COUPON_NOT_FOUND for a coupon that does not exist', async () => {
    const res = await apiCall('GET', `/api/super-admin/coupons/${randomUuid()}`, superAdminUser.jwt);
    expectError(res, 404, 'OP_COUPON_NOT_FOUND');
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', `/api/super-admin/coupons/${couponId}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', `/api/super-admin/coupons/${couponId}`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/super-admin/coupons/[id]: validation', () => {
  it('404 OP_COUPON_NOT_FOUND for a coupon that does not exist', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/coupons/${randomUuid()}`, superAdminUser.jwt, {
      status: 'paused',
    });
    expectError(res, 404, 'OP_COUPON_NOT_FOUND');
  });

  it('400 OP_NO_UPDATE for an empty body (nothing to update)', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/coupons/${couponId}`, superAdminUser.jwt, {});
    expectError(res, 400, 'OP_NO_UPDATE');
  });

  it.each<Case>([
    ['status が不正', { status: 'archived' }],
    ['max_uses が 0', { max_uses: 0 }],
    ['valid_until が日時の形でない', { valid_until: 'tomorrow' }],
    ['applicable_plans が UUID でない', { applicable_plans: ['not-a-uuid'] }],
    ['applicable_to が不正', { applicable_to: 'everyone' }],
    ['display_name が 200 文字を超える', { display_name: 'x'.repeat(201) }],
  ])('400 OP_INVALID_INPUT: %s', async (_label, override) => {
    const res = await apiCall('PATCH', `/api/super-admin/coupons/${couponId}`, superAdminUser.jwt, override);
    expectError(res, 400, 'OP_INVALID_INPUT');
  });
});

describe('DELETE /api/super-admin/coupons/[id]: 409', () => {
  it('409 OP_COUPON_IN_USE for a coupon that has been used, and the coupon stays', async () => {
    const res = await apiCall('DELETE', `/api/super-admin/coupons/${usedCouponId}`, superAdminUser.jwt);
    expectError(res, 409, 'OP_COUPON_IN_USE');

    const { data, error } = await supabaseAdmin.from('coupons').select('id').eq('id', usedCouponId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});

describe('GET /api/super-admin/coupons/[id]/redemptions: query validation', () => {
  it.each<[string, string]>([
    ['page が 0', 'page=0'],
    ['per_page が上限 (200) を超える', 'per_page=201'],
  ])('400 OP_INVALID_QUERY: %s', async (_label, query) => {
    const res = await apiCall(
      'GET',
      `/api/super-admin/coupons/${couponId}/redemptions?${query}`,
      superAdminUser.jwt,
    );
    expectError(res, 400, 'OP_INVALID_QUERY');
  });
});

describe('POST /api/super-admin/coupons/[id]/apply', () => {
  const validBody = { subscription_target: 'personal', subscription_id: randomUuid() };

  it.each<Case>([
    ['subscription_target が不正', { subscription_target: 'family' }],
    ['subscription_target が無い', { subscription_target: undefined }],
    ['subscription_id が UUID でない', { subscription_id: 'not-a-uuid' }],
    ['subscription_id が無い', { subscription_id: undefined }],
    ['reason が空', { reason: '' }],
    ['reason が 1000 文字を超える', { reason: 'x'.repeat(1001) }],
  ])('400 OP_INVALID_INPUT: %s', async (_label, override) => {
    const res = await apiCall('POST', `/api/super-admin/coupons/${couponId}/apply`, superAdminUser.jwt, {
      ...validBody,
      ...override,
    });
    expectError(res, 400, 'OP_INVALID_INPUT');
  });

  it('404 OP_COUPON_NOT_FOUND for a coupon that does not exist (valid body)', async () => {
    const res = await apiCall('POST', `/api/super-admin/coupons/${randomUuid()}/apply`, superAdminUser.jwt, validBody);
    expectError(res, 404, 'OP_COUPON_NOT_FOUND');
  });

  it('404 OP_SUBSCRIPTION_NOT_FOUND for a subscription that does not exist (valid coupon)', async () => {
    const res = await apiCall('POST', `/api/super-admin/coupons/${couponId}/apply`, superAdminUser.jwt, validBody);
    expectError(res, 404, 'OP_SUBSCRIPTION_NOT_FOUND');
  });

  it('403 for admin', async () => {
    const res = await apiCall('POST', `/api/super-admin/coupons/${couponId}/apply`, adminUser.jwt, validBody);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', `/api/super-admin/coupons/${couponId}/apply`, validBody);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// flags
// ─────────────────────────────────────────

describe('POST /api/super-admin/flags: input validation', () => {
  const base = { key: POST_FLAG_KEY, description: 'Validation flag', enabled: false };

  it.each<Case>([
    ['key が無い', { key: undefined }],
    ['key が空', { key: '' }],
    ['key が 100 文字を超える', { key: 'a'.repeat(101) }],
    ['description が 500 文字を超える', { description: 'x'.repeat(501) }],
    ['enabled が真偽値でない', { enabled: 'yes' }],
    ['rollout_strategy.type が不正', { rollout_strategy: { type: 'bogus' } }],
    ['rollout_strategy.value が 100 を超える', { rollout_strategy: { type: 'percentage', value: 101 } }],
    ['rollout_strategy.org_ids が UUID でない', { rollout_strategy: { type: 'org', org_ids: ['x'] } }],
    ['constraints.min_user_age_days が負', { constraints: { min_user_age_days: -1 } }],
  ])('400 VALIDATION_ERROR: %s', async (_label, override) => {
    const res = await apiCall('POST', '/api/super-admin/flags', superAdminUser.jwt, { ...base, ...override });
    expectError(res, 400, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/super-admin/flags/[key]: input validation', () => {
  it.each<Case>([
    ['enabled が真偽値でない', { enabled: 'yes' }],
    ['description が 500 文字を超える', { description: 'x'.repeat(501) }],
    ['rollout_strategy.value が 100 を超える', { rollout_strategy: { type: 'percentage', value: 150 } }],
    ['rollout_strategy.value が負', { rollout_strategy: { type: 'percentage', value: -1 } }],
    ['rollout_strategy.org_ids が UUID でない', { rollout_strategy: { type: 'org', org_ids: ['x'] } }],
    ['constraints.min_user_age_days が負', { constraints: { min_user_age_days: -1 } }],
    ['constraints.include_org_ids が UUID でない', { constraints: { include_org_ids: ['x'] } }],
  ])('400 VALIDATION_ERROR: %s', async (_label, override) => {
    const res = await apiCall('PATCH', `/api/super-admin/flags/${FLAG_KEY}`, superAdminUser.jwt, override);
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('400 は一部だけ正しい本文でも何も保存しない (enabled は変わらない)', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/flags/${FLAG_KEY}`, superAdminUser.jwt, {
      enabled: true,
      rollout_strategy: { type: 'percentage', value: 150 },
    });
    expectError(res, 400, 'VALIDATION_ERROR');

    const { data, error } = await supabaseAdmin
      .from('feature_flags')
      .select('enabled, rollout_strategy')
      .eq('key', FLAG_KEY)
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ enabled: false, rollout_strategy: null });
  });
});

// ─────────────────────────────────────────
// feature-packages
// ─────────────────────────────────────────

describe('GET /api/super-admin/feature-packages: query validation', () => {
  it.each<[string, string]>([
    ['status が不正', 'status=archived'],
    ['page が 0', 'page=0'],
    ['per_page が上限 (200) を超える', 'per_page=201'],
  ])('400 OP_INVALID_QUERY: %s', async (_label, query) => {
    const res = await apiCall('GET', `/api/super-admin/feature-packages?${query}`, superAdminUser.jwt);
    expectError(res, 400, 'OP_INVALID_QUERY');
  });
});

describe('POST /api/super-admin/feature-packages: input validation', () => {
  const base = {
    package_key: POST_PACKAGE_KEY,
    display_name: 'Validation Package',
    feature_flags: ['val_feature'],
  };

  it.each<Case>([
    ['feature_flags が空 (1 つ以上が必要)', { feature_flags: [] }],
    ['feature_flags が無い', { feature_flags: undefined }],
    ['package_key に大文字を含む', { package_key: 'Bad_Key' }],
    ['package_key が空', { package_key: '' }],
    ['display_name が無い', { display_name: undefined }],
    ['display_order が負', { display_order: -1 }],
    ['description が 2000 文字を超える', { description: 'x'.repeat(2001) }],
  ])('400 OP_INVALID_INPUT: %s', async (_label, override) => {
    const res = await apiCall('POST', '/api/super-admin/feature-packages', superAdminUser.jwt, {
      ...base,
      ...override,
    });
    expectError(res, 400, 'OP_INVALID_INPUT');
  });
});

describe('PATCH /api/super-admin/feature-packages/[id]: validation', () => {
  // 検証は対象の行を引く前に行うため、存在しない id でも 400 になる
  it.each<Case>([
    ['feature_flags が空 (1 つ以上が必要)', { feature_flags: [] }],
    ['display_name が空', { display_name: '' }],
    ['display_order が負', { display_order: -1 }],
  ])('400 OP_INVALID_INPUT: %s', async (_label, override) => {
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/feature-packages/${randomUuid()}`,
      superAdminUser.jwt,
      override,
    );
    expectError(res, 400, 'OP_INVALID_INPUT');
  });

  it('404 OP_PACKAGE_NOT_FOUND for a package that does not exist (valid body)', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/feature-packages/${randomUuid()}`,
      superAdminUser.jwt,
      { display_name: 'Nobody' },
    );
    expectError(res, 404, 'OP_PACKAGE_NOT_FOUND');
  });
});

// ─────────────────────────────────────────
// experiments
// ─────────────────────────────────────────

describe('POST /api/super-admin/experiments: input validation', () => {
  const base = {
    key: POST_EXPERIMENT_KEY,
    name: 'Validation Experiment',
    variants: [
      { key: 'control', weight: 50 },
      { key: 'variant_b', weight: 50 },
    ],
  };

  it.each<Case>([
    ['key に大文字を含む', { key: 'Bad_Key' }],
    ['key が空', { key: '' }],
    ['name が無い', { name: undefined }],
    ['name が空', { name: '' }],
    ['variants が 1 件だけ (2 件以上が必要)', { variants: [{ key: 'control', weight: 100 }] }],
    ['variants の weight が範囲外 (合計は 100)', { variants: [{ key: 'a', weight: 101 }, { key: 'b', weight: -1 }] }],
    ['variants の weight が整数でない (合計は 100)', { variants: [{ key: 'a', weight: 50.5 }, { key: 'b', weight: 49.5 }] }],
    ['variants の key が空', { variants: [{ key: '', weight: 50 }, { key: 'b', weight: 50 }] }],
    ['start_date が日付の形でない', { start_date: '2026/10/01' }],
    ['hypothesis が 1000 文字を超える', { hypothesis: 'x'.repeat(1001) }],
  ])('400 VALIDATION_ERROR: %s', async (_label, override) => {
    const res = await apiCall('POST', '/api/super-admin/experiments', superAdminUser.jwt, { ...base, ...override });
    expectError(res, 400, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/super-admin/experiments/[id]: validation', () => {
  // 検証は対象の行を引く前に行うため、存在しない id でも 400 になる
  it.each<Case>([
    ['name が空', { name: '' }],
    ['end_date が日付の形でない', { end_date: '2026/12/31' }],
    ['hypothesis が 1000 文字を超える', { hypothesis: 'x'.repeat(1001) }],
    ['result がオブジェクトでない', { result: 'done' }],
  ])('400 VALIDATION_ERROR: %s', async (_label, override) => {
    const res = await apiCall('PATCH', `/api/super-admin/experiments/${randomUuid()}`, superAdminUser.jwt, override);
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('404 NOT_FOUND for an experiment that does not exist (valid body)', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/experiments/${randomUuid()}`, superAdminUser.jwt, {
      name: 'Nobody',
    });
    expectError(res, 404, 'NOT_FOUND');
  });
});

describe('DELETE /api/super-admin/experiments/[id]: 404', () => {
  it('404 NOT_FOUND for an experiment that does not exist', async () => {
    const res = await apiCall('DELETE', `/api/super-admin/experiments/${randomUuid()}`, superAdminUser.jwt);
    expectError(res, 404, 'NOT_FOUND');
  });
});

// ─────────────────────────────────────────
// audit-logs / infra / llm usage: query validation
// ─────────────────────────────────────────

describe('GET /api/super-admin/audit-logs: query validation', () => {
  it.each<[string, string]>([
    ['severity が不正', 'severity=fatal'],
    ['actor_id が UUID でない', 'actor_id=not-a-uuid'],
    ['target_id が UUID でない', 'target_id=123'],
    ['from が日付の形でない', 'from=2026/01/01'],
    ['to が日付の形でない', 'to=tomorrow'],
    ['page が 0', 'page=0'],
    ['per_page が上限 (200) を超える', 'per_page=201'],
  ])('400 VALIDATION_ERROR: %s', async (_label, query) => {
    const res = await apiCall('GET', `/api/super-admin/audit-logs?${query}`, superAdminUser.jwt);
    expectError(res, 400, 'VALIDATION_ERROR');
  });
});

describe('GET /api/super-admin/infra/metrics: query validation', () => {
  it.each<[string, string]>([
    ['source が不正', 'source=azure'],
    ['limit が 0', 'limit=0'],
    ['limit が上限 (1000) を超える', 'limit=1001'],
    ['limit が数値でない', 'limit=abc'],
    ['from が日時の形でない', 'from=yesterday'],
    ['to が日時の形でない (日付だけ)', 'to=2026-10-08'],
  ])('400 VALIDATION_ERROR: %s', async (_label, query) => {
    const res = await apiCall('GET', `/api/super-admin/infra/metrics?${query}`, superAdminUser.jwt);
    expectError(res, 400, 'VALIDATION_ERROR');
  });
});

describe('GET /api/super-admin/infra/alerts: query validation', () => {
  it.each<[string, string]>([
    ['resolved が true / false でない', 'resolved=maybe'],
    ['page が 0', 'page=0'],
    ['per_page が 0', 'per_page=0'],
    ['per_page が上限 (100) を超える', 'per_page=101'],
  ])('400 VALIDATION_ERROR: %s', async (_label, query) => {
    const res = await apiCall('GET', `/api/super-admin/infra/alerts?${query}`, superAdminUser.jwt);
    expectError(res, 400, 'VALIDATION_ERROR');
  });
});

describe('GET /api/super-admin/llm/usage: query validation', () => {
  it.each<[string, string]>([
    ['period が不正', 'period=1y'],
    ['from が日付の形でない', 'period=custom&from=2026/05/01&to=2026-05-08'],
    ['to が日付の形でない', 'period=custom&from=2026-05-01&to=05-08'],
    ['provider が不正', 'provider=azure'],
  ])('400 VALIDATION_ERROR: %s', async (_label, query) => {
    const res = await apiCall('GET', `/api/super-admin/llm/usage?${query}`, superAdminUser.jwt);
    expectError(res, 400, 'VALIDATION_ERROR');
  });
});
