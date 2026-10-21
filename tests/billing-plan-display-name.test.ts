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
  FREE_PLAN_DISPLAY_NAME,
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
