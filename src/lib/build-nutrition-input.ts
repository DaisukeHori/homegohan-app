/**
 * 栄養目標計算入力の共通ヘルパー
 *
 * 4 つの API ルート（profile, nutrition-targets/calculate, nutrition/targets, onboarding/complete）が
 * calculateNutritionTargets() に渡す NutritionCalculatorInput を同一の shape で組み立てるための
 * Single Source of Truth。
 *
 * Bug-fix: #17 / #42 — ルート間で PAL の計算入力が微妙に異なっていたことを防ぐ。
 */

import type { NutritionCalculatorInput } from "@homegohan/core";

/**
 * DB の user_profiles 行（スネークケース）から NutritionCalculatorInput を組み立てる。
 *
 * @param profile  supabase から取得した user_profiles 行（any が許容される server-side コード用）
 * @param userId   計算結果の targetData.user_id に使う ID（profile.id と同じことが多い）
 * @param extra    ルート固有の追加フィールド（onboarding/complete のみ performance_profile を渡す）
 */
export function buildNutritionCalculatorInput(
  profile: Record<string, unknown>,
  userId: string,
  extra?: { performance_profile?: unknown }
): NutritionCalculatorInput {
  return {
    id: userId,
    age: profile.age as number | null | undefined,
    gender: profile.gender as string | null | undefined,
    height: profile.height as number | null | undefined,
    weight: profile.weight as number | null | undefined,
    work_style: profile.work_style as string | null | undefined,
    exercise_intensity: profile.exercise_intensity as string | null | undefined,
    exercise_frequency: profile.exercise_frequency as number | null | undefined,
    exercise_duration_per_session: profile.exercise_duration_per_session as number | null | undefined,
    nutrition_goal: profile.nutrition_goal as string | null | undefined,
    weight_change_rate: profile.weight_change_rate as string | null | undefined,
    health_conditions: (profile.health_conditions as string[] | null | undefined) ?? [],
    medications: (profile.medications as string[] | null | undefined) ?? [],
    pregnancy_status: profile.pregnancy_status as string | null | undefined,
    ...(extra?.performance_profile !== undefined
      ? { performance_profile: extra.performance_profile as NutritionCalculatorInput["performance_profile"] }
      : {}),
  };
}
