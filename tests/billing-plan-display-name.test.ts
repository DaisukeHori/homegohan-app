/**
 * planDisplayName (packages/shared/src/billing-plans.ts) は内部の plan_key を利用者向けの名前として返さない (#1912)。
 *
 * 組織の利用者 (自分の契約も家族も無い人) の effective_plan_key は organizations.plan の値 (ORG_PLAN_VALUES =
 * standard / premium / enterprise) か、subscription_plans の plan_type = 'org' の行の org_* になる (get_effective_plan)。
 * 組織のプランの値 (isOrgPlanKey) は固定の名前 ORG_PLAN_DISPLAY_NAME (組織のプラン) を返す。
 * PLAN_CATALOG にも free にも無く、組織のプランの値でもない key (private の家族の追加枠 family_addon・運営の画面で新しく作った
 * 個人・家族のプラン・未知の値) は、汎用の名前 PAID_PLAN_GENERIC_DISPLAY_NAME (有料プラン) を返す (「組織のプラン」と出さない)。
 */
import { describe, expect, it } from 'vitest';
import {
  FAMILY_PLAN_STATUS_SUFFIX,
  FREE_PLAN_DISPLAY_NAME,
  SUBSCRIPTION_STATUSES_WIRE,
  currentPlanDisplay,
  subscriptionStatusLines,
  ORG_PLAN_DISPLAY_NAME,
  ORG_PLAN_VALUES_WIRE,
  ORG_SUBSCRIPTION_PLAN_KEY_PREFIX,
  PAID_PLAN_GENERIC_DISPLAY_NAME,
  PAID_PLAN_KEYS,
  PLAN_CATALOG,
  isCatalogPlanKey,
  isOrgPlanKey,
  planDisplayName,
} from '@homegohan/shared';
import { ORG_PLAN_VALUES } from '../src/lib/org-plans';

/** subscription_plans の plan_type = 'org' の行の plan_key (20251126124224_create_meal_planner_tables.sql のシード) */
const ORG_SUBSCRIPTION_PLAN_KEYS = ['org_starter', 'org_standard', 'org_pro', 'org_enterprise'] as const;
/**
 * PLAN_CATALOG にも free にも無く、組織のプランの値でもない値: private の家族の追加枠の行 (family_addon)・運営の画面で新しく作った
 * 個人・家族のプランを想定した値 (personal_lite・family_max)・未知の値・空文字
 */
const NON_ORG_UNKNOWN_PLAN_KEYS = ['family_addon', 'personal_lite', 'family_max', 'unknown_plan_value', ''] as const;

describe('#1912 planDisplayName は内部の plan_key を返さない', () => {
  it('free returns FREE_PLAN_DISPLAY_NAME and every PLAN_CATALOG key returns its display_name', () => {
    expect(planDisplayName('free')).toBe(FREE_PLAN_DISPLAY_NAME);
    expect(PLAN_CATALOG.map((plan) => plan.plan_key)).toEqual([...PAID_PLAN_KEYS]);
    for (const plan of PLAN_CATALOG) {
      expect(planDisplayName(plan.plan_key)).toBe(plan.display_name);
      expect(isCatalogPlanKey(plan.plan_key)).toBe(true);
      expect(isOrgPlanKey(plan.plan_key)).toBe(false);
    }
    expect(isCatalogPlanKey('free')).toBe(false);
    expect(isOrgPlanKey('free')).toBe(false);
  });

  it.each([...ORG_PLAN_VALUES, ...ORG_SUBSCRIPTION_PLAN_KEYS])(
    'organization plan value %j returns ORG_PLAN_DISPLAY_NAME, never the internal value',
    (planKey) => {
      expect(isCatalogPlanKey(planKey)).toBe(false);
      expect(isOrgPlanKey(planKey)).toBe(true);
      const name = planDisplayName(planKey);
      expect(name).toBe(ORG_PLAN_DISPLAY_NAME);
      expect(name).not.toContain(planKey);
    },
  );

  it.each(NON_ORG_UNKNOWN_PLAN_KEYS)(
    'plan_key %j that is neither free, in PLAN_CATALOG nor an organization plan value returns the generic PAID_PLAN_GENERIC_DISPLAY_NAME (not 組織のプラン), never the internal value',
    (planKey) => {
      expect(isCatalogPlanKey(planKey)).toBe(false);
      expect(isOrgPlanKey(planKey)).toBe(false);
      const name = planDisplayName(planKey);
      expect(name).toBe(PAID_PLAN_GENERIC_DISPLAY_NAME);
      expect(name).not.toBe(ORG_PLAN_DISPLAY_NAME);
      expect(name).not.toContain('組織');
      if (planKey !== '') expect(name).not.toContain(planKey);
    },
  );

  it('ORG_PLAN_VALUES_WIRE (the shared copy) equals ORG_PLAN_VALUES (src/lib/org-plans.ts), and the org_ prefix is the prefix of every org row seeded in subscription_plans', () => {
    // shared は src を import できないので写しを持つ。正本の値を変えたら写しも同じ PR で変える
    expect([...ORG_PLAN_VALUES_WIRE]).toEqual([...ORG_PLAN_VALUES]);
    expect([...ORG_PLAN_VALUES]).toEqual(['standard', 'premium', 'enterprise']);
    expect(ORG_SUBSCRIPTION_PLAN_KEY_PREFIX).toBe('org_');
    for (const key of ORG_SUBSCRIPTION_PLAN_KEYS) expect(key.startsWith(ORG_SUBSCRIPTION_PLAN_KEY_PREFIX)).toBe(true);
    // 組織の値と PLAN_CATALOG の key は重ならない
    for (const plan of PLAN_CATALOG) expect(isOrgPlanKey(plan.plan_key)).toBe(false);
  });

  it('ORG_PLAN_DISPLAY_NAME is the fixed 組織のプラン and PAID_PLAN_GENERIC_DISPLAY_NAME is the fixed 有料プラン, distinct from every other plan name', () => {
    expect(ORG_PLAN_DISPLAY_NAME).toBe('組織のプラン');
    expect(PAID_PLAN_GENERIC_DISPLAY_NAME).toBe('有料プラン');
    const others = [FREE_PLAN_DISPLAY_NAME, ...PLAN_CATALOG.map((plan) => plan.display_name)];
    for (const name of others) {
      expect(ORG_PLAN_DISPLAY_NAME).not.toBe(name);
      expect(PAID_PLAN_GENERIC_DISPLAY_NAME).not.toBe(name);
    }
    expect(ORG_PLAN_DISPLAY_NAME).not.toBe(PAID_PLAN_GENERIC_DISPLAY_NAME);
  });
});

// #1912: Web の契約の画面とモバイルの購入の画面が共有する現在のプランの分岐 (billing/03 §10.6 の 2)
describe('#1912 currentPlanDisplay は自分の契約・家族・組織・汎用・無料を分ける', () => {
  /** 自分の契約が live でない要約 (status = null) */
  const notLive = (effectivePlanKey: string) => ({ plan_key: 'free', effective_plan_key: effectivePlanKey, status: null });

  it('a live own contract shows the name of its own plan_key (source own), even when the effective plan differs', () => {
    expect(currentPlanDisplay({ plan_key: 'pro', effective_plan_key: 'pro', status: 'active' })).toEqual({ source: 'own', name: '個人 Pro' });
    expect(currentPlanDisplay({ plan_key: 'family_basic', effective_plan_key: 'family_basic', status: 'trialing' })).toEqual({ source: 'own', name: '家族 Basic' });
    // paused の自分の契約は get_effective_plan では効かず家族のプランが効くが、画面の主の表示は自分の契約の名前 (モバイルと同じ)
    expect(currentPlanDisplay({ plan_key: 'pro', effective_plan_key: 'family_pro', status: 'paused' })).toEqual({ source: 'own', name: '個人 Pro' });
    // live な契約の plan_key が PLAN_CATALOG に無くても内部の値を出さない
    expect(currentPlanDisplay({ plan_key: 'family_addon', effective_plan_key: 'family_addon', status: 'active' })).toEqual({ source: 'own', name: PAID_PLAN_GENERIC_DISPLAY_NAME });
    expect(currentPlanDisplay({ plan_key: 'org_standard', effective_plan_key: 'org_standard', status: 'active' })).toEqual({ source: 'own', name: ORG_PLAN_DISPLAY_NAME });
  });

  it('without a live own contract: free → 無料プラン / organization values → 組織のプラン / PLAN_CATALOG keys → the family plan name / any other key → 有料プラン', () => {
    expect(currentPlanDisplay(notLive('free'))).toEqual({ source: 'free', name: FREE_PLAN_DISPLAY_NAME });
    for (const key of [...ORG_PLAN_VALUES, ...ORG_SUBSCRIPTION_PLAN_KEYS]) {
      expect(currentPlanDisplay(notLive(key)), key).toEqual({ source: 'org', name: ORG_PLAN_DISPLAY_NAME });
    }
    for (const plan of PLAN_CATALOG) {
      expect(currentPlanDisplay(notLive(plan.plan_key)), plan.plan_key).toEqual({ source: 'family', name: plan.display_name });
    }
    for (const key of NON_ORG_UNKNOWN_PLAN_KEYS) {
      expect(currentPlanDisplay(notLive(key)), key).toEqual({ source: 'generic', name: PAID_PLAN_GENERIC_DISPLAY_NAME });
    }
  });

  it('the live test is the same as subscriptionStatusLines (non-empty exactly for the live statuses): a non-live status falls back to the effective plan', () => {
    for (const status of [null, ...SUBSCRIPTION_STATUSES_WIRE]) {
      const summary = { plan_key: 'pro', effective_plan_key: 'family_pro', status, trial_ends_at: null, current_period_end: null, cancel_at_period_end: false, cancel_at: null };
      const live = subscriptionStatusLines(summary).length > 0;
      expect(currentPlanDisplay(summary).source, String(status)).toBe(live ? 'own' : 'family');
    }
  });

  it('FAMILY_PLAN_STATUS_SUFFIX is the fixed (ご家族のプラン) wording and never names an organization', () => {
    expect(FAMILY_PLAN_STATUS_SUFFIX).toBe(' (ご家族のプラン)');
    expect(FAMILY_PLAN_STATUS_SUFFIX).not.toContain('組織');
  });
});
