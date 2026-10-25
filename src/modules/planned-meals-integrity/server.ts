// src/modules/planned-meals-integrity/server.ts
// 献立の完了の切り替え (RPC planned_meals_set_completed の呼び出し)。RLS の効く利用者の client を受け取る (service_role は使わない)。
// 失敗は固定の形で返し、DB の生のエラーは呼び出し側 (route) が internalError で構造化ログにだけ残す。
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PLANNED_MEALS_SET_COMPLETED_RPC,
  isPlannedMealNotFoundRpcError,
  plannedMealsSetCompletedArgs,
} from '@homegohan/shared';
import { isUuid } from '@/lib/http-params';
import {
  PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE,
  PlannedMealsSetCompletedRowSchema,
  type PlannedMealCompletionRow,
} from './core';

/** route・executor が渡す、利用者のセッションの Supabase クライアント (rpc だけを使う) */
export type PlannedMealsIntegrityDb = Pick<SupabaseClient, 'rpc'>;

export type SetPlannedMealCompletedResult =
  | { ok: true; row: PlannedMealCompletionRow }
  /** 本人の行として無い (他人の行・消えた行・UUID の形でない id)。route は 404、AI 相談は '権限がありません' */
  | { ok: false; reason: 'not_found' }
  /** DB の失敗 (RPC が無い・接続の失敗・行の形が違う)。route は 500 */
  | { ok: false; reason: 'db'; error: unknown };

/**
 * 献立を完了 / 未完了にする。completed_at は DB が決める (完了なら既存の時刻か now()、未完了なら NULL)。
 * UUID の形でない id は DB に渡さず not_found (uuid 型の引数に渡すと 22P02 になるため)。
 */
export async function setPlannedMealCompleted(
  db: PlannedMealsIntegrityDb,
  params: { mealId: string; completed: boolean },
): Promise<SetPlannedMealCompletedResult> {
  if (!isUuid(params.mealId)) return { ok: false, reason: 'not_found' };
  const { data, error } = await db.rpc(
    PLANNED_MEALS_SET_COMPLETED_RPC,
    plannedMealsSetCompletedArgs(params.mealId, params.completed),
  );
  if (error) {
    if (isPlannedMealNotFoundRpcError(error)) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'db', error };
  }
  // RETURNS TABLE は配列で届く (supabase-js の型の都合で単体のこともあるので両方を受ける)
  const rows: unknown[] = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
  const parsed = PlannedMealsSetCompletedRowSchema.safeParse(rows[0]);
  if (!parsed.success) {
    return { ok: false, reason: 'db', error: new Error(PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE) };
  }
  return { ok: true, row: parsed.data };
}
