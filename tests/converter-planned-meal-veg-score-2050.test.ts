/**
 * #2050 (P8) の同じ型: lib/converter.ts の toPlannedMeal は planned_meals.veg_score を `|| null` で受けていたため、
 * 野菜スコア 0 (野菜が無い食事。supabase/functions/_shared/veg-score.ts) が null (未計算) に変わっていた。
 * 0 は 0 のまま、値が無いときだけ null にすることを確かめる。
 */

import { describe, expect, it } from 'vitest';

import { toPlannedMeal } from '@/lib/converter';

/** 0 より大きい野菜スコアの例 */
const SOME_VEG_SCORE = 35;

/** toPlannedMeal に渡す planned_meals の行 (veg_score 以外は変換に要る最小限) */
function plannedMealRow(vegScore: unknown): Record<string, unknown> {
  return {
    id: 'pm-1',
    meal_type: 'lunch',
    dish_name: '白ごはん',
    is_completed: false,
    created_at: '2026-10-26T00:00:00Z',
    updated_at: '2026-10-26T00:00:00Z',
    veg_score: vegScore,
  };
}

describe('#2050 toPlannedMeal の vegScore', () => {
  it('veg_score が 0: 0 のまま (null にしない)', () => {
    expect(toPlannedMeal(plannedMealRow(0)).vegScore).toBe(0);
  });

  it('veg_score が 0 より大きい: その値', () => {
    expect(toPlannedMeal(plannedMealRow(SOME_VEG_SCORE)).vegScore).toBe(SOME_VEG_SCORE);
  });

  it('veg_score が null / 列が無い: null', () => {
    expect(toPlannedMeal(plannedMealRow(null)).vegScore).toBeNull();
    const { veg_score: _omitted, ...withoutVegScore } = plannedMealRow(undefined);
    expect(toPlannedMeal(withoutVegScore).vegScore).toBeNull();
  });
});
