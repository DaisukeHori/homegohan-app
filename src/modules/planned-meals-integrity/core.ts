// src/modules/planned-meals-integrity/core.ts
// 献立の完了の RPC の入出力の Zod の正典と文言 (docs/design/cross/23-planned-meals-score-integrity.md §7.7)。
// route と server.ts から使う。DB の操作は ./server.ts。
import { z } from 'zod';
import type { PlannedMealsSetCompletedRow } from '@homegohan/shared';

/**
 * route の本文の完了の指定 (PATCH /api/meals/[id] の is_completed・PATCH /api/meal-plans/meals/[id] の isCompleted)。
 * boolean だけ。undefined は「指定なし」(route が safeParse の前に見分ける)。文字列の 'true' や 1 は通さない
 */
export const PlannedMealCompletionInputSchema = z.boolean();

/** RPC planned_meals_set_completed が返す 1 行 (RETURNS TABLE)。PostgREST は配列で返す */
export const PlannedMealsSetCompletedRowSchema = z.object({
  id: z.string().uuid(),
  is_completed: z.boolean(),
  completed_at: z.string().nullable(),
  updated_at: z.string().nullable(),
}) satisfies z.ZodType<PlannedMealsSetCompletedRow>;

export type PlannedMealCompletionRow = z.infer<typeof PlannedMealsSetCompletedRowSchema>;

/** 本文の is_completed / isCompleted が boolean でないときの 400 の文 (固定。値は載せない) */
export const PLANNED_MEAL_COMPLETION_INVALID_MESSAGE = '完了の指定は true か false で送ってください';

/** RPC の返す行の形が正典と違うときの失敗の文 (ログ用。本文には出ない) */
export const PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE =
  'planned_meals_set_completed の返す行の形が正典 (PlannedMealsSetCompletedRowSchema) と違います';
