// supabase/functions/_shared/veg-score.ts
// 野菜スコア (planned_meals.veg_score) の尺度と計算の正本 (docs/design/cross/23-planned-meals-score-integrity.md §6.3)。
// 書くのは analyze-meal-photo の背景の処理 (service_role) だけ。読むのは calculate-segment-stats (nutrition_score の正規化)。
// Web / モバイルは packages/shared/src/planned-meals-integrity.ts の写し (VEG_SCORE_MIN / VEG_SCORE_MAX) を読む。
// 値の一致は tests/veg-score-scale-contract.test.ts が見る。

/** 野菜スコアの下限・上限 (整数の点)。DB の列は integer */
export const VEG_SCORE_MIN = 0;
export const VEG_SCORE_MAX = 100;

/**
 * 満点 (VEG_SCORE_MAX) に当たる 1 食の野菜の量 (g)。
 * 以前の estimateVegetableScore の式 `round(vegetableGrams / 120 * 100)` の 120 を名前にしたもの。尺度の定義そのもので、
 * 変えると過去の値と比べられなくなるので、環境変数では変えない (変えるときは設計書を改定する)
 */
export const VEG_SCORE_FULL_MARK_GRAMS = 120;

/**
 * 比較ランキングの nutrition_score (0〜100 の整数) を veg_score_avg から求める係数。
 * 尺度が 0〜100 なので 1 (以前は 1〜5 点を前提に 20 を掛けていた)
 */
export const NUTRITION_SCORE_PER_VEG_SCORE = 100 / VEG_SCORE_MAX;

function clampVegScore(value: number): number {
  return Math.min(VEG_SCORE_MAX, Math.max(VEG_SCORE_MIN, value));
}

/**
 * 1 食の野菜の量 (g の合計) から野菜スコア (0〜100 の整数) を求める。
 * 有限でない・負の量は 0 (以前は NaN が通り抜けた)。
 */
export function vegScoreOfVegetableGrams(vegetableGrams: number): number {
  if (!Number.isFinite(vegetableGrams) || vegetableGrams <= 0) return VEG_SCORE_MIN;
  return clampVegScore(Math.round((vegetableGrams / VEG_SCORE_FULL_MARK_GRAMS) * VEG_SCORE_MAX));
}

/** 比較ランキングの nutrition_score: veg_score_avg (0〜100) を 0〜100 の整数に正規化する。平均が無い (0 件) ときは 0 */
export function nutritionScoreOfVegScoreAverage(vegScoreAverage: number): number {
  if (!Number.isFinite(vegScoreAverage)) return VEG_SCORE_MIN;
  return clampVegScore(Math.round(vegScoreAverage * NUTRITION_SCORE_PER_VEG_SCORE));
}
