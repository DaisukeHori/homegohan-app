// @vitest-environment node
/**
 * #2025: 献立の完了の RPC の入出力の Zod の正典 (src/modules/planned-meals-integrity/core.ts)。
 * 設計: docs/design/cross/23-planned-meals-score-integrity.md §7.7・§12.1
 */
import { describe, expect, it } from 'vitest';
import {
  PLANNED_MEAL_COMPLETION_INVALID_MESSAGE,
  PlannedMealCompletionInputSchema,
  PlannedMealsSetCompletedRowSchema,
} from '@/modules/planned-meals-integrity/core';

const MEAL_ID = '11111111-1111-4111-8111-111111111111';
const COMPLETED_AT = '2026-01-10T03:00:00+00:00';
const UPDATED_AT = '2026-01-10T03:00:01+00:00';

describe('#2025 PlannedMealCompletionInputSchema', () => {
  it("PlannedMealCompletionInputSchema: true / false は通る。'true'・1・null・undefined は通らない", () => {
    expect(PlannedMealCompletionInputSchema.safeParse(true)).toEqual({ success: true, data: true });
    expect(PlannedMealCompletionInputSchema.safeParse(false)).toEqual({ success: true, data: false });
    for (const value of ['true', 'false', 1, 0, null, undefined, {}, []]) {
      expect(PlannedMealCompletionInputSchema.safeParse(value).success, JSON.stringify(value) ?? 'undefined').toBe(false);
    }
    // 400 の文は値を載せない固定の日本語
    expect(PLANNED_MEAL_COMPLETION_INVALID_MESSAGE).toBe('完了の指定は true か false で送ってください');
  });
});

describe('#2025 PlannedMealsSetCompletedRowSchema', () => {
  it('PlannedMealsSetCompletedRowSchema: RPC の行 (completed_at が null でも) は通る。uuid でない id・boolean でない is_completed は通らない', () => {
    const done = { id: MEAL_ID, is_completed: true, completed_at: COMPLETED_AT, updated_at: UPDATED_AT };
    expect(PlannedMealsSetCompletedRowSchema.parse(done)).toEqual(done);
    const undone = { id: MEAL_ID, is_completed: false, completed_at: null, updated_at: null };
    expect(PlannedMealsSetCompletedRowSchema.parse(undone)).toEqual(undone);

    expect(PlannedMealsSetCompletedRowSchema.safeParse({ ...done, id: 'not-a-uuid' }).success).toBe(false);
    expect(PlannedMealsSetCompletedRowSchema.safeParse({ ...done, is_completed: 'true' }).success).toBe(false);
    expect(PlannedMealsSetCompletedRowSchema.safeParse({ ...done, is_completed: null }).success).toBe(false);
    expect(PlannedMealsSetCompletedRowSchema.safeParse({ ...done, completed_at: 0 }).success).toBe(false);
    const { updated_at: _omitted, ...withoutUpdatedAt } = done;
    expect(PlannedMealsSetCompletedRowSchema.safeParse(withoutUpdatedAt).success).toBe(false);
    expect(PlannedMealsSetCompletedRowSchema.safeParse(undefined).success).toBe(false);
  });
});
