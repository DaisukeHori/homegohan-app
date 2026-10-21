/**
 * planDisplayName (packages/shared/src/billing-plans.ts) は内部の plan_key を利用者向けの名前として返さない (#1912)。
 *
 * 組織の利用者 (自分の契約も家族も無い人) の effective_plan_key は organizations.plan の値 (ORG_PLAN_VALUES =
 * standard / premium / enterprise) か、subscription_plans の plan_type = 'org' の行の org_* になる (get_effective_plan)。
 * PLAN_CATALOG にも free にも無い key は、固定の名前 ORG_PLAN_DISPLAY_NAME (組織のプラン) を返す。
 */
import { describe, expect, it } from 'vitest';
import {
  FREE_PLAN_DISPLAY_NAME,
  ORG_PLAN_DISPLAY_NAME,
  PAID_PLAN_KEYS,
  PLAN_CATALOG,
  isCatalogPlanKey,
  planDisplayName,
} from '@homegohan/shared';
import { ORG_PLAN_VALUES } from '../src/lib/org-plans';

/** subscription_plans の plan_type = 'org' の行の plan_key (20251126124224_create_meal_planner_tables.sql のシード) */
const ORG_SUBSCRIPTION_PLAN_KEYS = ['org_starter', 'org_standard', 'org_pro', 'org_enterprise'] as const;
/** PLAN_CATALOG にも free にも無い、それ以外の値 (家族の追加枠の行・未知の値・空文字) */
const OTHER_UNKNOWN_PLAN_KEYS = ['family_addon', 'unknown_plan_value', ''] as const;

describe('#1912 planDisplayName は内部の plan_key を返さない', () => {
  it('free returns FREE_PLAN_DISPLAY_NAME and every PLAN_CATALOG key returns its display_name', () => {
    expect(planDisplayName('free')).toBe(FREE_PLAN_DISPLAY_NAME);
    expect(PLAN_CATALOG.map((plan) => plan.plan_key)).toEqual([...PAID_PLAN_KEYS]);
    for (const plan of PLAN_CATALOG) {
      expect(planDisplayName(plan.plan_key)).toBe(plan.display_name);
      expect(isCatalogPlanKey(plan.plan_key)).toBe(true);
    }
    expect(isCatalogPlanKey('free')).toBe(false);
  });

  it.each([...ORG_PLAN_VALUES, ...ORG_SUBSCRIPTION_PLAN_KEYS, ...OTHER_UNKNOWN_PLAN_KEYS])(
    'plan_key %j that is neither free nor in PLAN_CATALOG returns ORG_PLAN_DISPLAY_NAME, never the internal value',
    (planKey) => {
      expect(isCatalogPlanKey(planKey)).toBe(false);
      const name = planDisplayName(planKey);
      expect(name).toBe(ORG_PLAN_DISPLAY_NAME);
      if (planKey !== '') expect(name).not.toContain(planKey);
    },
  );

  it('ORG_PLAN_VALUES has exactly standard / premium / enterprise (the values organizations.plan can hold) and ORG_PLAN_DISPLAY_NAME is the fixed 組織のプラン', () => {
    expect([...ORG_PLAN_VALUES]).toEqual(['standard', 'premium', 'enterprise']);
    expect(ORG_PLAN_DISPLAY_NAME).toBe('組織のプラン');
    expect(ORG_PLAN_DISPLAY_NAME).not.toBe(FREE_PLAN_DISPLAY_NAME);
    for (const plan of PLAN_CATALOG) expect(ORG_PLAN_DISPLAY_NAME).not.toBe(plan.display_name);
  });
});
