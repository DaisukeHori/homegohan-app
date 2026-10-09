/**
 * 派生レシピの栄養合計 (create-derived-recipe)
 *
 * index.ts は Deno.serve を直接呼ぶため単体テストから読み込めない。
 * 栄養の積算だけをここに分け、tests/create-derived-recipe-nutrition.test.ts から確かめられるようにしてある。
 */

import { calcSugarG } from "../_shared/nutrition-sugar.ts";

export type NutritionTotals = {
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  sugar_g: number; // 糖質 = 炭水化物 − 食物繊維 (食材ごとに 0 で下限をとって合算)。#1146
  sodium_g: number; // 食塩相当量(g)
  potassium_mg: number;
  calcium_mg: number;
  phosphorus_mg: number;
  iron_mg: number;
  zinc_mg: number;
  iodine_ug: number;
  cholesterol_mg: number;
  vitamin_b1_mg: number;
  vitamin_b2_mg: number;
  vitamin_b6_mg: number;
  vitamin_b12_ug: number;
  folic_acid_ug: number;
  vitamin_c_mg: number;
  vitamin_a_ug: number;
  vitamin_d_ug: number;
  vitamin_k_ug: number;
  vitamin_e_mg: number;
};

/** dataset_ingredients から引いた 1 食材の栄養 (100g あたり)。index.ts の IngredientMatch["matched"] の栄養部分。 */
export type MatchedIngredientNutrients = {
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fiber_g: number | null;
  salt_eq_g: number | null;
  potassium_mg: number | null;
  calcium_mg: number | null;
  phosphorus_mg: number | null;
  iron_mg: number | null;
  zinc_mg: number | null;
  iodine_ug: number | null;
  cholesterol_mg: number | null;
  vitamin_b1_mg: number | null;
  vitamin_b2_mg: number | null;
  vitamin_b6_mg: number | null;
  vitamin_b12_ug: number | null;
  folic_acid_ug: number | null;
  vitamin_c_mg: number | null;
  vitamin_a_ug: number | null;
  vitamin_d_ug: number | null;
  vitamin_k_ug: number | null;
  vitamin_e_alpha_mg: number | null;
};

export function addScaled(totals: NutritionTotals, m: MatchedIngredientNutrients | null, amount_g: number) {
  if (!m) return;
  const f = amount_g / 100.0;
  const add = (key: keyof NutritionTotals, v: number | null | undefined) => {
    if (v == null) return;
    totals[key] += v * f;
  };

  add("calories_kcal", m.calories_kcal);
  add("protein_g", m.protein_g);
  add("fat_g", m.fat_g);
  add("carbs_g", m.carbs_g);
  add("fiber_g", m.fiber_g);
  // 糖質 = 炭水化物 − 食物繊維。食材ごとに計算してから合算する (#1146)。
  // 炭水化物のデータが無い食材は加算しない。食物繊維だけ無い食材は 0 として扱い、炭水化物をそのまま糖質にする。
  if (m.carbs_g != null) add("sugar_g", calcSugarG(m.carbs_g, m.fiber_g));
  add("sodium_g", m.salt_eq_g);

  add("potassium_mg", m.potassium_mg);
  add("calcium_mg", m.calcium_mg);
  add("phosphorus_mg", m.phosphorus_mg);
  add("iron_mg", m.iron_mg);
  add("zinc_mg", m.zinc_mg);
  add("iodine_ug", m.iodine_ug);
  add("cholesterol_mg", m.cholesterol_mg);

  add("vitamin_b1_mg", m.vitamin_b1_mg);
  add("vitamin_b2_mg", m.vitamin_b2_mg);
  add("vitamin_b6_mg", m.vitamin_b6_mg);
  add("vitamin_b12_ug", m.vitamin_b12_ug);
  add("folic_acid_ug", m.folic_acid_ug);
  add("vitamin_c_mg", m.vitamin_c_mg);
  add("vitamin_a_ug", m.vitamin_a_ug);
  add("vitamin_d_ug", m.vitamin_d_ug);
  add("vitamin_k_ug", m.vitamin_k_ug);

  // vitamin_e: dataset_ingredients は alpha/beta/gamma/delta を持つが、derived_recipes は合算を入れる
  if (m.vitamin_e_alpha_mg != null) totals.vitamin_e_mg += m.vitamin_e_alpha_mg * f;
}

export function emptyTotals(): NutritionTotals {
  return {
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    fiber_g: 0,
    sugar_g: 0,
    sodium_g: 0,
    potassium_mg: 0,
    calcium_mg: 0,
    phosphorus_mg: 0,
    iron_mg: 0,
    zinc_mg: 0,
    iodine_ug: 0,
    cholesterol_mg: 0,
    vitamin_b1_mg: 0,
    vitamin_b2_mg: 0,
    vitamin_b6_mg: 0,
    vitamin_b12_ug: 0,
    folic_acid_ug: 0,
    vitamin_c_mg: 0,
    vitamin_a_ug: 0,
    vitamin_d_ug: 0,
    vitamin_k_ug: 0,
    vitamin_e_mg: 0,
  };
}

/**
 * 糖質を保存できるか。炭水化物のデータがある食材が 1 つも当たらなかったときは、
 * 糖質を 0g と保存せず null (不明) にするために使う (#1146)。
 * skip は水など栄養計算の対象外にした食材。
 */
export function hasSugarData(
  matches: ReadonlyArray<{ skip: boolean; matched: { carbs_g: number | null } | null }>,
): boolean {
  return matches.some((m) => !m.skip && m.matched != null && m.matched.carbs_g != null);
}
