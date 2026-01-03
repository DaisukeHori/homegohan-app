/**
 * 栄養計算v2（nutrition-calculator-v2.ts）
 * 
 * 材料マッチング結果を基に、栄養素を積算する
 * 計算式: 材料の栄養 = (栄養/100g) × 使用量(g) × (1 - 廃棄率)
 */

import { IngredientMatchResult } from './ingredient-matcher.ts'

// ============================================
// 型定義
// ============================================

export interface NutritionTotals {
  // 基本
  calories_kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
  fiber_g: number
  // ミネラル
  sodium_mg: number
  potassium_mg: number
  calcium_mg: number
  magnesium_mg: number
  phosphorus_mg: number
  iron_mg: number
  zinc_mg: number
  iodine_ug: number
  cholesterol_mg: number
  // ビタミン
  vitamin_a_ug: number
  vitamin_d_ug: number
  vitamin_e_mg: number
  vitamin_k_ug: number
  vitamin_b1_mg: number
  vitamin_b2_mg: number
  niacin_mg: number
  vitamin_b6_mg: number
  vitamin_b12_ug: number
  folic_acid_ug: number
  pantothenic_acid_mg: number
  biotin_ug: number
  vitamin_c_mg: number
  // その他
  salt_eq_g: number
}

export interface DishNutrition {
  name: string
  role: string
  ingredients: IngredientNutrition[]
  totals: NutritionTotals
}

export interface IngredientNutrition {
  name: string
  amount_g: number
  matchedName: string | null
  matchedId: string | null
  similarity: number
  confidence: string
  nutrition: NutritionTotals
}

export interface MealNutrition {
  dishes: DishNutrition[]
  totals: NutritionTotals
  matchedCount: number
  totalIngredients: number
  matchRate: number
}

// ============================================
// 初期化
// ============================================

export function initNutritionTotals(): NutritionTotals {
  return {
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    fiber_g: 0,
    sodium_mg: 0,
    potassium_mg: 0,
    calcium_mg: 0,
    magnesium_mg: 0,
    phosphorus_mg: 0,
    iron_mg: 0,
    zinc_mg: 0,
    iodine_ug: 0,
    cholesterol_mg: 0,
    vitamin_a_ug: 0,
    vitamin_d_ug: 0,
    vitamin_e_mg: 0,
    vitamin_k_ug: 0,
    vitamin_b1_mg: 0,
    vitamin_b2_mg: 0,
    niacin_mg: 0,
    vitamin_b6_mg: 0,
    vitamin_b12_ug: 0,
    folic_acid_ug: 0,
    pantothenic_acid_mg: 0,
    biotin_ug: 0,
    vitamin_c_mg: 0,
    salt_eq_g: 0,
  }
}

// ============================================
// 栄養計算（単一材料）
// ============================================

export function calculateIngredientNutrition(
  matchResult: IngredientMatchResult
): IngredientNutrition {
  const { input, matched, confidence } = matchResult
  const nutrition = initNutritionTotals()

  if (!matched) {
    return {
      name: input.name,
      amount_g: input.amount_g,
      matchedName: null,
      matchedId: null,
      similarity: 0,
      confidence,
      nutrition,
    }
  }

  const amount = input.amount_g
  const discardRate = matched.discard_rate_percent || 0
  const effectiveAmount = amount * (1 - discardRate / 100)
  const factor = effectiveAmount / 100 // 100gあたりの値を換算

  // 栄養素を計算
  nutrition.calories_kcal = (matched.calories_kcal || 0) * factor
  nutrition.protein_g = (matched.protein_g || 0) * factor
  nutrition.fat_g = (matched.fat_g || 0) * factor
  nutrition.carbs_g = (matched.carbs_g || 0) * factor
  nutrition.fiber_g = (matched.fiber_g || 0) * factor
  nutrition.sodium_mg = (matched.sodium_mg || 0) * factor
  nutrition.potassium_mg = (matched.potassium_mg || 0) * factor
  nutrition.calcium_mg = (matched.calcium_mg || 0) * factor
  nutrition.magnesium_mg = (matched.magnesium_mg || 0) * factor
  nutrition.phosphorus_mg = (matched.phosphorus_mg || 0) * factor
  nutrition.iron_mg = (matched.iron_mg || 0) * factor
  nutrition.zinc_mg = (matched.zinc_mg || 0) * factor
  nutrition.iodine_ug = (matched.iodine_ug || 0) * factor
  nutrition.cholesterol_mg = (matched.cholesterol_mg || 0) * factor
  nutrition.vitamin_a_ug = (matched.vitamin_a_ug || 0) * factor
  nutrition.vitamin_d_ug = (matched.vitamin_d_ug || 0) * factor
  nutrition.vitamin_e_mg = (matched.vitamin_e_alpha_mg || 0) * factor
  nutrition.vitamin_k_ug = (matched.vitamin_k_ug || 0) * factor
  nutrition.vitamin_b1_mg = (matched.vitamin_b1_mg || 0) * factor
  nutrition.vitamin_b2_mg = (matched.vitamin_b2_mg || 0) * factor
  nutrition.niacin_mg = (matched.niacin_mg || 0) * factor
  nutrition.vitamin_b6_mg = (matched.vitamin_b6_mg || 0) * factor
  nutrition.vitamin_b12_ug = (matched.vitamin_b12_ug || 0) * factor
  nutrition.folic_acid_ug = (matched.folic_acid_ug || 0) * factor
  nutrition.pantothenic_acid_mg = (matched.pantothenic_acid_mg || 0) * factor
  nutrition.biotin_ug = (matched.biotin_ug || 0) * factor
  nutrition.vitamin_c_mg = (matched.vitamin_c_mg || 0) * factor
  nutrition.salt_eq_g = (matched.salt_eq_g || 0) * factor

  return {
    name: input.name,
    amount_g: input.amount_g,
    matchedName: matched.name,
    matchedId: matched.id,
    similarity: matched.similarity,
    confidence,
    nutrition,
  }
}

// ============================================
// 栄養合算
// ============================================

export function sumNutrition(a: NutritionTotals, b: NutritionTotals): NutritionTotals {
  return {
    calories_kcal: a.calories_kcal + b.calories_kcal,
    protein_g: a.protein_g + b.protein_g,
    fat_g: a.fat_g + b.fat_g,
    carbs_g: a.carbs_g + b.carbs_g,
    fiber_g: a.fiber_g + b.fiber_g,
    sodium_mg: a.sodium_mg + b.sodium_mg,
    potassium_mg: a.potassium_mg + b.potassium_mg,
    calcium_mg: a.calcium_mg + b.calcium_mg,
    magnesium_mg: a.magnesium_mg + b.magnesium_mg,
    phosphorus_mg: a.phosphorus_mg + b.phosphorus_mg,
    iron_mg: a.iron_mg + b.iron_mg,
    zinc_mg: a.zinc_mg + b.zinc_mg,
    iodine_ug: a.iodine_ug + b.iodine_ug,
    cholesterol_mg: a.cholesterol_mg + b.cholesterol_mg,
    vitamin_a_ug: a.vitamin_a_ug + b.vitamin_a_ug,
    vitamin_d_ug: a.vitamin_d_ug + b.vitamin_d_ug,
    vitamin_e_mg: a.vitamin_e_mg + b.vitamin_e_mg,
    vitamin_k_ug: a.vitamin_k_ug + b.vitamin_k_ug,
    vitamin_b1_mg: a.vitamin_b1_mg + b.vitamin_b1_mg,
    vitamin_b2_mg: a.vitamin_b2_mg + b.vitamin_b2_mg,
    niacin_mg: a.niacin_mg + b.niacin_mg,
    vitamin_b6_mg: a.vitamin_b6_mg + b.vitamin_b6_mg,
    vitamin_b12_ug: a.vitamin_b12_ug + b.vitamin_b12_ug,
    folic_acid_ug: a.folic_acid_ug + b.folic_acid_ug,
    pantothenic_acid_mg: a.pantothenic_acid_mg + b.pantothenic_acid_mg,
    biotin_ug: a.biotin_ug + b.biotin_ug,
    vitamin_c_mg: a.vitamin_c_mg + b.vitamin_c_mg,
    salt_eq_g: a.salt_eq_g + b.salt_eq_g,
  }
}

// ============================================
// 数値丸め
// ============================================

export function roundNutrition(n: NutritionTotals): NutritionTotals {
  const round1 = (v: number) => Math.round(v * 10) / 10
  const round2 = (v: number) => Math.round(v * 100) / 100

  return {
    calories_kcal: Math.round(n.calories_kcal),
    protein_g: round1(n.protein_g),
    fat_g: round1(n.fat_g),
    carbs_g: round1(n.carbs_g),
    fiber_g: round1(n.fiber_g),
    sodium_mg: round1(n.sodium_mg),
    potassium_mg: round1(n.potassium_mg),
    calcium_mg: round1(n.calcium_mg),
    magnesium_mg: round1(n.magnesium_mg),
    phosphorus_mg: round1(n.phosphorus_mg),
    iron_mg: round2(n.iron_mg),
    zinc_mg: round2(n.zinc_mg),
    iodine_ug: round1(n.iodine_ug),
    cholesterol_mg: round1(n.cholesterol_mg),
    vitamin_a_ug: round1(n.vitamin_a_ug),
    vitamin_d_ug: round2(n.vitamin_d_ug),
    vitamin_e_mg: round2(n.vitamin_e_mg),
    vitamin_k_ug: round1(n.vitamin_k_ug),
    vitamin_b1_mg: round2(n.vitamin_b1_mg),
    vitamin_b2_mg: round2(n.vitamin_b2_mg),
    niacin_mg: round2(n.niacin_mg),
    vitamin_b6_mg: round2(n.vitamin_b6_mg),
    vitamin_b12_ug: round2(n.vitamin_b12_ug),
    folic_acid_ug: round1(n.folic_acid_ug),
    pantothenic_acid_mg: round2(n.pantothenic_acid_mg),
    biotin_ug: round2(n.biotin_ug),
    vitamin_c_mg: round1(n.vitamin_c_mg),
    salt_eq_g: round2(n.salt_eq_g),
  }
}

// ============================================
// 料理ごとの栄養計算
// ============================================

export function calculateDishNutrition(
  dishName: string,
  dishRole: string,
  matchResults: IngredientMatchResult[]
): DishNutrition {
  const ingredients: IngredientNutrition[] = []
  let totals = initNutritionTotals()

  for (const matchResult of matchResults) {
    const ingredientNutrition = calculateIngredientNutrition(matchResult)
    ingredients.push(ingredientNutrition)
    totals = sumNutrition(totals, ingredientNutrition.nutrition)
  }

  return {
    name: dishName,
    role: dishRole,
    ingredients,
    totals: roundNutrition(totals),
  }
}

// ============================================
// 食事全体の栄養計算
// ============================================

export function calculateMealNutrition(dishes: DishNutrition[]): MealNutrition {
  let totals = initNutritionTotals()
  let matchedCount = 0
  let totalIngredients = 0

  for (const dish of dishes) {
    totals = sumNutrition(totals, dish.totals)
    
    for (const ingredient of dish.ingredients) {
      totalIngredients++
      if (ingredient.matchedId) {
        matchedCount++
      }
    }
  }

  return {
    dishes,
    totals: roundNutrition(totals),
    matchedCount,
    totalIngredients,
    matchRate: totalIngredients > 0 ? matchedCount / totalIngredients : 0,
  }
}
