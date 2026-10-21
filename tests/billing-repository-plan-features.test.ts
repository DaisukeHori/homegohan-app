/**
 * 課金の repository の findPlanFeatures (src/lib/billing/repository.ts。billing/03 §8.6) の単体テスト (§14.1 のテスト 138)。
 * getSupabaseAdmin を偽の client に差し替え、ai_daily_limits と ai_plan_feature_caps の表の行を返す。
 */
import { describe, expect, it, vi } from 'vitest';

/** 表の行 (DB の本冊の migration の後の値と、組織の plan の写し・行の無いプラン・NULL の行) */
const TABLES = vi.hoisted(() => ({
  ai_daily_limits: [
    { plan_key: 'free', daily_limit: 3 },
    { plan_key: 'pro', daily_limit: 30 },
    { plan_key: 'family_pro', daily_limit: 50 },
    { plan_key: 'standard', daily_limit: 10 },
    { plan_key: 'unlimited_plan', daily_limit: null },
  ] as Array<{ plan_key: string; daily_limit: number | null }>,
  ai_plan_feature_caps: [
    { plan_key: 'free', feature: 'menu_generation_ultimate', daily_cap: 0 },
    { plan_key: 'free', feature: 'image_generation', daily_cap: 0 },
    { plan_key: 'free', feature: 'meal_image_auto', daily_cap: 0 },
    { plan_key: 'free', feature: 'menu_generation', daily_cap: 3 },
    { plan_key: 'pro', feature: 'menu_generation_ultimate', daily_cap: 2 },
    { plan_key: 'pro', feature: 'menu_generation', daily_cap: 10 },
  ] as Array<{ plan_key: string; feature: string; daily_cap: number | null }>,
}));

/** from(table).select(...).in('plan_key', keys) / .eq('plan_key', key) だけを受ける偽の client */
const fakeAdmin = vi.hoisted(() => ({
  from(table: 'ai_daily_limits' | 'ai_plan_feature_caps') {
    const rows = TABLES[table] as Array<Record<string, unknown>>;
    return {
      select(_columns: string) {
        return {
          in: async (column: string, values: unknown[]) => ({ data: rows.filter((row) => values.includes(row[column])), error: null }),
          eq: async (column: string, value: unknown) => ({ data: rows.filter((row) => row[column] === value), error: null }),
        };
      },
    };
  },
}));

vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => fakeAdmin }));

import { createBillingRepository } from '@/lib/billing/repository';

describe('billing/03 §8.6 findPlanFeatures', () => {
  it('findPlanFeatures falls back to the free ai_daily_limits row only for the daily limit and never for ai_feature_caps: an organization plan (standard) with its own daily limit row and no ai_plan_feature_caps rows returns that limit and {}, a plan without an ai_daily_limits row returns the free limit and {}, a row whose daily_limit is NULL stays NULL, and free returns its 4 caps', async () => {
    const repository = createBillingRepository();
    // 組織の plan: 写した 1 日の上限と、機能ごとの上限なし (free の行に倒さない。S26)
    expect(await repository.findPlanFeatures('standard')).toEqual({ ai_daily_limit: 10, ai_feature_caps: {} });
    // 行の無いプラン: 1 日の上限は free の行、機能ごとの上限は無し
    expect(await repository.findPlanFeatures('org_enterprise')).toEqual({ ai_daily_limit: 3, ai_feature_caps: {} });
    // daily_limit が NULL の行は無制限のまま (free に倒さない)
    expect(await repository.findPlanFeatures('unlimited_plan')).toEqual({ ai_daily_limit: null, ai_feature_caps: {} });
    // free: 1 日 3 回と 4 つの機能ごとの上限
    expect(await repository.findPlanFeatures('free')).toEqual({
      ai_daily_limit: 3,
      ai_feature_caps: { menu_generation_ultimate: 0, image_generation: 0, meal_image_auto: 0, menu_generation: 3 },
    });
    // 有料: そのプランの行だけ (行の無い機能は入らない)
    expect(await repository.findPlanFeatures('pro')).toEqual({ ai_daily_limit: 30, ai_feature_caps: { menu_generation_ultimate: 2, menu_generation: 10 } });
    expect(await repository.findPlanFeatures('family_pro')).toEqual({ ai_daily_limit: 50, ai_feature_caps: {} });
  });
});
