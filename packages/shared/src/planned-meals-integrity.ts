// packages/shared/src/planned-meals-integrity.ts
// 献立 (planned_meals) の、サーバだけが書く 3 列と完了の RPC (docs/design/cross/23-planned-meals-score-integrity.md)。
// Web (src) とモバイル (apps/mobile) の両方から読むので、zod も supabase-js も import しない。
// Edge Function は packages/shared を import できないので、尺度の値は supabase/functions/_shared/veg-score.ts にも置く
// (値の一致は tests/veg-score-scale-contract.test.ts が見る)。

/**
 * 利用者 (authenticated) のセッションからは INSERT / UPDATE できない列。
 * 比較ランキング (calculate-segment-stats) と組織のチャレンジ (update_org_challenge_progress) が指標に使う 2 列と、
 * 完了の時刻 (完了の RPC だけが書く)。migration 20261026010000_planned_meals_score_columns_server_only.sql が
 * 列の権限から外す。
 */
export const PLANNED_MEALS_SERVER_ONLY_COLUMNS = ['is_completed', 'completed_at', 'veg_score'] as const;

export type PlannedMealsServerOnlyColumn = (typeof PLANNED_MEALS_SERVER_ONLY_COLUMNS)[number];

/** 完了の切り替えの RPC (SECURITY DEFINER。本人の行だけ。migration 20261025130000_planned_meals_set_completed_rpc.sql) */
export const PLANNED_MEALS_SET_COMPLETED_RPC = 'planned_meals_set_completed';

/** RPC の引数 (DB の関数の引数名と同じ) */
export interface PlannedMealsSetCompletedArgs {
  p_meal_id: string;
  p_completed: boolean;
}

/** RPC の引数を組み立てる (hook・route・テストで引数名を手書きしない) */
export function plannedMealsSetCompletedArgs(mealId: string, completed: boolean): PlannedMealsSetCompletedArgs {
  return { p_meal_id: mealId, p_completed: completed };
}

/** RPC が返す 1 行 (RETURNS TABLE)。completed_at / updated_at は ISO 8601 の文字列か null */
export interface PlannedMealsSetCompletedRow {
  id: string;
  is_completed: boolean;
  completed_at: string | null;
  updated_at: string | null;
}

/**
 * RPC が「本人の行として見つからない」ときに RAISE する文 (他人の行・無い行)。SQLSTATE は P0002 (no_data_found)。
 * supabase-js の error は { code: 'P0002', message: 'PLANNED_MEAL_NOT_FOUND' } の形で届く
 */
export const PLANNED_MEAL_NOT_FOUND_CODE = 'PLANNED_MEAL_NOT_FOUND';
export const PLANNED_MEAL_NOT_FOUND_SQLSTATE = 'P0002';

/** supabase-js / PostgREST のエラーが、RPC の PLANNED_MEAL_NOT_FOUND か */
export function isPlannedMealNotFoundRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === PLANNED_MEAL_NOT_FOUND_SQLSTATE) return true;
  return typeof message === 'string' && message.includes(PLANNED_MEAL_NOT_FOUND_CODE);
}

/**
 * 野菜スコアの尺度 (写真の解析 supabase/functions/_shared/nutrition-pipeline.ts の estimateVegetableScore が書く値の範囲)。
 * 計算の正本は supabase/functions/_shared/veg-score.ts (ここは Web / モバイル用の写し)。
 * 組織のチャレンジ (src/lib/org-challenges.ts) の目標値の範囲と、比較ランキングの nutrition_score の正規化がこの値を使う
 */
export const VEG_SCORE_MIN = 0;
export const VEG_SCORE_MAX = 100;

/** 野菜スコアとして DB に入ってよい値 (0〜100 の整数) か。null は「未計算」で、ここでは false */
export function isVegScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= VEG_SCORE_MIN && value <= VEG_SCORE_MAX;
}
