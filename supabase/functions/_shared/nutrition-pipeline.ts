/**
 * 栄養分析パイプライン（nutrition-pipeline.ts）
 * 
 * 食事写真分析の全ステップを統合:
 * 1. Gemini 3.1 Flash-Lite Preview で画像認識
 * 2. 材料マッチング
 * 3. 栄養計算
 * 4. エビデンス検証
 * 5. 結果統合
 */

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { 
  matchIngredients, 
  EstimatedIngredient, 
  IngredientMatchResult,
  calculateMatchingStats 
} from './ingredient-matcher.ts'
import { 
  calculateDishNutrition, 
  DishNutrition,
  IngredientNutrition,
  NutritionTotals,
  initNutritionTotals,
  roundNutrition
} from './nutrition-calculator-v2.ts'
import { 
  verifyNutrition, 
  createEvidenceInfo, 
  EvidenceInfo,
  MatchedIngredientInfo
} from './evidence-verifier.ts'
import { generateGeminiJson } from './gemini-json.ts'
import {
  estimateNutritionWithPerplexity,
  isPerplexityNutritionCandidate,
} from './perplexity-nutrition.ts'

// ============================================
// 型定義
// ============================================

export interface ImageInput {
  base64: string
  mimeType: string
}

export interface GeminiDish {
  name: string
  role: string
  cookingMethod: MealCookingMethod
  visiblePortionWeightG: number
  visibleIngredients: EstimatedIngredient[]
  estimatedIngredients: EstimatedIngredient[]
  estimatedNutrition?: MealNutritionEstimate
}

export interface GeminiAnalysisResult {
  dishes: GeminiDish[]
}

export type MealNutritionConfidence = 'high' | 'medium' | 'low'

export interface MealNutritionEstimate {
  calories_kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
  fiber_g: number
  salt_eq_g: number
  confidence: MealNutritionConfidence
}

export type MealCookingMethod =
  | 'fried'
  | 'grilled'
  | 'stir_fried'
  | 'simmered'
  | 'steamed'
  | 'boiled'
  | 'raw'
  | 'rice'
  | 'soup'
  | 'baked'
  | 'other'

export interface AnalyzedDish {
  name: string
  role: string
  cookingMethod: MealCookingMethod
  visiblePortionWeightG: number
  calories_kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
  nutritionAdjustmentFactor: number
  ingredient: string
  ingredients: {
    name: string
    amount_g: number
    matched: {
      id: string | null
      name: string | null
      similarity: number
    } | null
  }[]
}

export interface NutritionPipelineResult {
  dishes: AnalyzedDish[]
  totalCalories: number
  totalProtein: number
  totalCarbs: number
  totalFat: number
  nutrition: {
    sodiumG: number
    fiberG: number
    potassiumMg: number
    calciumMg: number
    magnesiumMg: number
    phosphorusMg: number
    ironMg: number
    zincMg: number
    iodineUg: number
    cholesterolMg: number
    vitaminAUg: number
    vitaminDUg: number
    vitaminEMg: number
    vitaminKUg: number
    vitaminB1Mg: number
    vitaminB2Mg: number
    niacinMg: number
    vitaminB6Mg: number
    vitaminB12Ug: number
    folicAcidUg: number
    pantothenicAcidMg: number
    biotinUg: number
    vitaminCMg: number
    saltEqG: number
  }
  evidence: EvidenceInfo
  overallScore: number
  vegScore: number
  praiseComment: string
  nutritionTip: string
  imageUrl?: string | null
  timings?: {
    imageRecognitionMs: number
    ingredientMatchingMs: number
    nutritionCalculationMs: number
    evidenceVerificationMs: number
    praiseGenerationMs: number
    totalMs: number
  }
}

// ============================================
// Gemini 3.1 Flash-Lite Preview 画像認識
// ============================================

const GEMINI_MEAL_ANALYSIS_MODEL = Deno.env.get('GEMINI_MEAL_ANALYSIS_MODEL') || 'gemini-3.1-flash-lite-preview'

const mealRecognitionSchema = {
  type: 'object',
  required: ['dishes'],
  properties: {
    dishes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'role', 'cookingMethod', 'visiblePortionWeightG', 'visibleIngredients', 'estimatedNutrition'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['main', 'side', 'soup', 'rice', 'salad', 'dessert'] },
          cookingMethod: {
            type: 'string',
            enum: ['fried', 'grilled', 'stir_fried', 'simmered', 'steamed', 'boiled', 'raw', 'rice', 'soup', 'baked', 'other'],
          },
          visiblePortionWeightG: { type: 'number' },
          visibleIngredients: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'amount_g'],
              properties: {
                name: { type: 'string' },
                amount_g: { type: 'number' },
              },
            },
          },
          estimatedNutrition: {
            type: 'object',
            required: ['calories_kcal', 'protein_g', 'fat_g', 'carbs_g', 'fiber_g', 'salt_eq_g', 'confidence'],
            properties: {
              calories_kcal: { type: 'number' },
              protein_g: { type: 'number' },
              fat_g: { type: 'number' },
              carbs_g: { type: 'number' },
              fiber_g: { type: 'number' },
              salt_eq_g: { type: 'number' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
          },
        },
      },
    },
  },
} as const

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeIngredientName(name: string): string {
  return String(name ?? '').replace(/[\s　]+/g, '').trim()
}

function isKaraageDishName(name: string): boolean {
  const normalized = normalizeIngredientName(name)
  return /唐揚げ|から揚げ|竜田揚げ|竜田あげ/.test(normalized)
}

function isMisoSoupDishName(name: string): boolean {
  const normalized = normalizeIngredientName(name)
  return /味噌汁|みそ汁/.test(normalized)
}

function getDefaultCookingMethodForRole(role: string): MealCookingMethod {
  switch (role) {
    case 'rice':
      return 'rice'
    case 'soup':
      return 'soup'
    case 'salad':
      return 'raw'
    default:
      return 'other'
  }
}

function normalizeCookingMethod(method: unknown, role: string): MealCookingMethod {
  if (typeof method === 'string' && [
    'fried',
    'grilled',
    'stir_fried',
    'simmered',
    'steamed',
    'boiled',
    'raw',
    'rice',
    'soup',
    'baked',
    'other',
  ].includes(method)) {
    return method as MealCookingMethod
  }

  return getDefaultCookingMethodForRole(role)
}

function normalizeMealNutritionConfidence(value: unknown): MealNutritionConfidence {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low'
}

function normalizeMealNutritionEstimate(raw: unknown): MealNutritionEstimate | undefined {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const calories_kcal = toOptionalNumber(input.calories_kcal)
  const protein_g = toOptionalNumber(input.protein_g)
  const fat_g = toOptionalNumber(input.fat_g)
  const carbs_g = toOptionalNumber(input.carbs_g)
  const fiber_g = toOptionalNumber(input.fiber_g)
  const salt_eq_g = toOptionalNumber(input.salt_eq_g)

  if (
    calories_kcal === undefined ||
    protein_g === undefined ||
    fat_g === undefined ||
    carbs_g === undefined ||
    fiber_g === undefined ||
    salt_eq_g === undefined
  ) {
    return undefined
  }

  return {
    calories_kcal: Math.max(0, calories_kcal),
    protein_g: Math.max(0, protein_g),
    fat_g: Math.max(0, fat_g),
    carbs_g: Math.max(0, carbs_g),
    fiber_g: Math.max(0, fiber_g),
    salt_eq_g: Math.max(0, salt_eq_g),
    confidence: normalizeMealNutritionConfidence(input.confidence),
  }
}

function getIngredientAmountCap(name: string, role: string): number {
  const normalized = normalizeIngredientName(name)

  if (/ご飯|白米|白ご飯|ライス|米飯|麦ご飯|玄米ご飯/.test(normalized)) return 220
  if (/うどん|そば|パスタ|ラーメン|中華麺|焼きそば/.test(normalized)) return 240
  if (/味噌汁|みそ汁|スープ|汁|だし|出汁/.test(normalized) || role === 'soup') return 220
  if (/味噌|みそ/.test(normalized)) return role === 'soup' ? 18 : 25
  if (/ドレッシング|マヨネーズ|ソース|たれ|タレ|ケチャップ/.test(normalized)) return 25
  if (/油|オイル|バター/.test(normalized)) return 18
  if (/片栗粉|小麦粉|薄力粉|強力粉|パン粉|衣/.test(normalized)) return 35
  if (/鶏|牛|豚|ひき肉|挽肉|ハム|ベーコン|ソーセージ|魚|鮭|さば|ぶり|まぐろ|えび|海老|いか|イカ|たこ|タコ|卵|豆腐/.test(normalized)) {
    return role === 'main' ? 220 : 120
  }
  if (/キャベツ|レタス|サラダ菜|きゅうり|胡瓜|トマト|ブロッコリー|にんじん|人参|もやし|ほうれん草|小松菜|白菜|玉ねぎ|たまねぎ|ねぎ|ネギ|しめじ|きのこ|舞茸|まいたけ|えのき|ピーマン/.test(normalized)) {
    return role === 'salad' ? 120 : 90
  }

  return role === 'main' ? 160 : role === 'rice' ? 220 : role === 'soup' ? 180 : 120
}

function getDishTotalCap(role: string): number {
  switch (role) {
    case 'rice':
      return 240
    case 'soup':
      return 220
    case 'salad':
      return 140
    case 'side':
      return 160
    case 'dessert':
      return 140
    case 'main':
    default:
      return 280
  }
}

function getDefaultVisiblePortionWeightG(role: string, cookingMethod: MealCookingMethod): number {
  switch (role) {
    case 'rice':
      return 160
    case 'soup':
      return 160
    case 'salad':
      return 70
    case 'side':
      return 90
    case 'dessert':
      return 100
    case 'main':
    default:
      return cookingMethod === 'fried' ? 180 : 160
  }
}

function getVisiblePortionWeightG(
  dish: GeminiDish,
  visibleIngredientWeightG: number,
): number {
  const fallback = Math.max(
    visibleIngredientWeightG,
    getDefaultVisiblePortionWeightG(dish.role, dish.cookingMethod),
  )

  return clamp(
    dish.visiblePortionWeightG || fallback,
    Math.max(40, Math.min(fallback, 120)),
    getDishTotalCap(dish.role),
  )
}

function getDishCalorieDensityRange(dish: GeminiDish): { min: number; max: number } {
  if (dish.role === 'rice') return { min: 130, max: 210 }
  if (dish.role === 'soup') {
    if (isMisoSoupDishName(dish.name)) return { min: 15, max: 45 }
    return { min: 15, max: 70 }
  }
  if (dish.role === 'salad') return { min: 15, max: 120 }
  if (dish.role === 'dessert') return { min: 120, max: 360 }

  if (dish.cookingMethod === 'fried') {
    return isKaraageDishName(dish.name) ? { min: 220, max: 340 } : { min: 180, max: 320 }
  }
  if (dish.cookingMethod === 'grilled') return { min: 120, max: 280 }
  if (dish.cookingMethod === 'stir_fried') return { min: 110, max: 240 }
  if (dish.cookingMethod === 'simmered') return { min: 80, max: 220 }
  if (dish.cookingMethod === 'steamed' || dish.cookingMethod === 'boiled') return { min: 60, max: 200 }

  return dish.role === 'main' ? { min: 100, max: 260 } : { min: 40, max: 200 }
}

function normalizeDishForNutrition(dish: GeminiDish): GeminiDish {
  const merged = new Map<string, EstimatedIngredient>()

  for (const ingredient of dish.visibleIngredients) {
    const normalizedName = normalizeIngredientName(ingredient.name)
    if (!normalizedName) continue
    if (dish.role === 'soup' && /^(味噌汁|みそ汁|汁物|汁|スープ|お吸い物|吸い物)$/.test(normalizedName)) {
      continue
    }

    const cappedAmount = clamp(
      ingredient.amount_g,
      1,
      getIngredientAmountCap(normalizedName, dish.role),
    )

    const existing = merged.get(normalizedName)
    if (existing) {
      existing.amount_g += cappedAmount
    } else {
      merged.set(normalizedName, {
        name: normalizedName,
        amount_g: cappedAmount,
      })
    }
  }

  let estimatedIngredients = [...merged.values()]
  const totalAmount = estimatedIngredients.reduce((sum, ingredient) => sum + ingredient.amount_g, 0)
  const totalCap = getDishTotalCap(dish.role)

  if (totalAmount > totalCap && totalAmount > 0) {
    const scale = totalCap / totalAmount
    estimatedIngredients = estimatedIngredients.map((ingredient) => ({
      ...ingredient,
      amount_g: Math.max(1, Math.round(ingredient.amount_g * scale)),
    }))
  } else {
    estimatedIngredients = estimatedIngredients.map((ingredient) => ({
      ...ingredient,
      amount_g: Math.max(1, Math.round(ingredient.amount_g)),
    }))
  }

  const normalizedVisibleIngredientWeight = estimatedIngredients.reduce(
    (sum, ingredient) => sum + ingredient.amount_g,
    0,
  )

  return {
    ...dish,
    visiblePortionWeightG: getVisiblePortionWeightG(dish, normalizedVisibleIngredientWeight),
    visibleIngredients: estimatedIngredients,
    estimatedIngredients,
  }
}

function scaleNutritionTotals(totals: NutritionTotals, factor: number): NutritionTotals {
  return roundNutrition({
    calories_kcal: totals.calories_kcal * factor,
    protein_g: totals.protein_g * factor,
    fat_g: totals.fat_g * factor,
    carbs_g: totals.carbs_g * factor,
    fiber_g: totals.fiber_g * factor,
    sodium_mg: totals.sodium_mg * factor,
    potassium_mg: totals.potassium_mg * factor,
    calcium_mg: totals.calcium_mg * factor,
    magnesium_mg: totals.magnesium_mg * factor,
    phosphorus_mg: totals.phosphorus_mg * factor,
    iron_mg: totals.iron_mg * factor,
    zinc_mg: totals.zinc_mg * factor,
    iodine_ug: totals.iodine_ug * factor,
    cholesterol_mg: totals.cholesterol_mg * factor,
    vitamin_a_ug: totals.vitamin_a_ug * factor,
    vitamin_d_ug: totals.vitamin_d_ug * factor,
    vitamin_e_mg: totals.vitamin_e_mg * factor,
    vitamin_k_ug: totals.vitamin_k_ug * factor,
    vitamin_b1_mg: totals.vitamin_b1_mg * factor,
    vitamin_b2_mg: totals.vitamin_b2_mg * factor,
    niacin_mg: totals.niacin_mg * factor,
    vitamin_b6_mg: totals.vitamin_b6_mg * factor,
    vitamin_b12_ug: totals.vitamin_b12_ug * factor,
    folic_acid_ug: totals.folic_acid_ug * factor,
    pantothenic_acid_mg: totals.pantothenic_acid_mg * factor,
    biotin_ug: totals.biotin_ug * factor,
    vitamin_c_mg: totals.vitamin_c_mg * factor,
    salt_eq_g: totals.salt_eq_g * factor,
  })
}

function applyDishNutritionCalibration(
  dish: GeminiDish,
  dishNutrition: DishNutrition,
): { dishNutrition: DishNutrition; factor: number } {
  const portionWeight = Math.max(dish.visiblePortionWeightG, 1)
  if (dishNutrition.totals.calories_kcal <= 0) {
    return { dishNutrition, factor: 1 }
  }

  const currentDensity = (dishNutrition.totals.calories_kcal / portionWeight) * 100
  const { min, max } = getDishCalorieDensityRange(dish)

  let factor = 1
  if (currentDensity < min) {
    factor = min / currentDensity
  } else if (currentDensity > max) {
    factor = max / currentDensity
  }

  const minFactor = dish.role === 'soup' ? 0.2 : 0.5
  const maxFactor = dish.role === 'main' && dish.cookingMethod === 'fried' ? 1.9 : 1.6
  factor = clamp(factor, minFactor, maxFactor)
  if (Math.abs(factor - 1) < 0.05) {
    return { dishNutrition, factor: 1 }
  }

  console.log('[nutrition-pipeline] dish nutrition calibration', {
    dish: dish.name,
    role: dish.role,
    cookingMethod: dish.cookingMethod,
    visiblePortionWeightG: dish.visiblePortionWeightG,
    currentDensity,
    targetMinDensity: min,
    targetMaxDensity: max,
    factor,
    caloriesBefore: dishNutrition.totals.calories_kcal,
    caloriesAfter: Math.round(dishNutrition.totals.calories_kcal * factor),
  })

  return {
    dishNutrition: {
      ...dishNutrition,
      totals: scaleNutritionTotals(dishNutrition.totals, factor),
    },
    factor,
  }
}

function shouldUseEstimatedNutrition(dish: GeminiDish): boolean {
  const confidence = dish.estimatedNutrition?.confidence
  if (!confidence) return false
  if (confidence === 'high') return true
  return confidence === 'medium' && ['soup', 'rice', 'salad'].includes(dish.role)
}

function totalsFromEstimatedNutrition(estimate: MealNutritionEstimate): NutritionTotals {
  return roundNutrition({
    ...initNutritionTotals(),
    calories_kcal: estimate.calories_kcal,
    protein_g: estimate.protein_g,
    fat_g: estimate.fat_g,
    carbs_g: estimate.carbs_g,
    fiber_g: estimate.fiber_g,
    salt_eq_g: estimate.salt_eq_g,
    sodium_mg: estimate.salt_eq_g * 393.4,
  })
}

function buildEstimatedDishNutrition(dish: GeminiDish, estimate: MealNutritionEstimate): DishNutrition {
  const ingredients: IngredientNutrition[] = dish.visibleIngredients.map((ingredient) => ({
    name: ingredient.name,
    amount_g: ingredient.amount_g,
    matchedName: null,
    matchedId: null,
    similarity: 0,
    confidence: estimate.confidence,
    nutrition: initNutritionTotals(),
  }))

  return {
    name: dish.name,
    role: dish.role,
    ingredients,
    totals: totalsFromEstimatedNutrition(estimate),
  }
}

function isVegetableIngredient(name: string, matchedName?: string | null): boolean {
  const text = `${name} ${matchedName ?? ''}`
  return /キャベツ|レタス|サラダ菜|きゅうり|胡瓜|トマト|ブロッコリー|にんじん|人参|もやし|ほうれん草|小松菜|白菜|玉ねぎ|たまねぎ|ねぎ|ネギ|しめじ|きのこ|舞茸|まいたけ|えのき|ピーマン|なす|茄子|大根|ごぼう|れんこん|蓮根/.test(text)
}

function estimateVegetableScore(dishes: AnalyzedDish[]): number {
  const vegetableGrams = dishes.reduce((sum, dish) => (
    sum + dish.ingredients.reduce((dishSum, ingredient) => (
      dishSum + (isVegetableIngredient(ingredient.name, ingredient.matched?.name) ? ingredient.amount_g : 0)
    ), 0)
  ), 0)

  return clamp(Math.round((vegetableGrams / 120) * 100), 0, 100)
}

function normalizeGeminiAnalysisResult(raw: unknown): GeminiAnalysisResult {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const dishesInput = Array.isArray(input.dishes) ? input.dishes : []

  return {
    dishes: dishesInput.map((dish) => {
      const item = typeof dish === 'object' && dish !== null ? dish as Record<string, unknown> : {}
      const visibleIngredientsInput = Array.isArray(item.visibleIngredients)
        ? item.visibleIngredients
        : Array.isArray(item.estimatedIngredients)
          ? item.estimatedIngredients
          : []

      return {
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '不明な料理',
        role: typeof item.role === 'string' && item.role.trim() ? item.role.trim() : 'main',
        cookingMethod: normalizeCookingMethod(item.cookingMethod, typeof item.role === 'string' ? item.role : 'main'),
        visiblePortionWeightG: Math.max(0, toOptionalNumber(item.visiblePortionWeightG) ?? 0),
        visibleIngredients: visibleIngredientsInput
          .map((ingredient) => {
            const candidate = typeof ingredient === 'object' && ingredient !== null ? ingredient as Record<string, unknown> : {}
            const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : null
            const amount = toOptionalNumber(candidate.amount_g)
            if (!name || amount === undefined) return null
            return { name, amount_g: Math.max(0, amount) }
          })
          .filter((ingredient): ingredient is EstimatedIngredient => ingredient !== null),
        estimatedIngredients: visibleIngredientsInput
          .map((ingredient) => {
            const candidate = typeof ingredient === 'object' && ingredient !== null ? ingredient as Record<string, unknown> : {}
            const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : null
            const amount = toOptionalNumber(candidate.amount_g)
            if (!name || amount === undefined) return null
            return { name, amount_g: Math.max(0, amount) }
          })
          .filter((ingredient): ingredient is EstimatedIngredient => ingredient !== null),
        estimatedNutrition: normalizeMealNutritionEstimate(item.estimatedNutrition),
      }
    }).filter((dish) => dish.visibleIngredients.length > 0),
  }
}

async function analyzeImageWithGemini(
  images: ImageInput[],
  mealType: string
): Promise<GeminiAnalysisResult> {
  const mealTypeJa = mealType === 'breakfast' ? '朝食'
    : mealType === 'lunch' ? '昼食'
    : mealType === 'dinner' ? '夕食'
    : mealType === 'snack' ? 'おやつ'
    : mealType === 'midnight_snack' ? '夜食'
    : '食事'

  const imageCountText = images.length > 1 ? `${images.length}枚の` : ''

  const prompt = `あなたは「ほめゴハン」という食事管理アプリのAIアシスタントです。
この${imageCountText}${mealTypeJa}の写真を分析してください。

各料理について、見えている料理の名前・見えている量・調理法・見えている主要材料に加えて、
その皿全体の推定栄養も返してください。

以下のJSON形式で回答してください：

{
  "dishes": [
    {
      "name": "料理名",
      "role": "main または side または soup または rice または salad または dessert",
      "cookingMethod": "fried / grilled / stir_fried / simmered / steamed / boiled / raw / rice / soup / baked / other",
      "visiblePortionWeightG": 皿全体の見た目量(g),
      "visibleIngredients": [
        { "name": "写真から見える主要材料名", "amount_g": 推定量(g) }
      ],
      "estimatedNutrition": {
        "calories_kcal": 推定カロリー,
        "protein_g": 推定たんぱく質,
        "fat_g": 推定脂質,
        "carbs_g": 推定炭水化物,
        "fiber_g": 推定食物繊維,
        "salt_eq_g": 推定食塩相当量,
        "confidence": "high / medium / low"
      }
    }
  ]
}

注意：
- 写っている料理だけを数えてください。見えていない小鉢や調味料を想像で増やさないでください
- 材料名は「鶏もも肉」「白米」「味噌」など一般的な食材名で記載してください
- 油、衣、吸油、隠れた調味料など、写真から明確に見えない要素は visibleIngredients に含めないでください
- ただし estimatedNutrition には、調理法から自然に想定される油・衣・汁の塩分・ルーなどを含めてください
- visiblePortionWeightG は、その皿全体の見た目量を1人前として推定してください
- 分量は見た目から無理のない保守的な量にしてください
- estimatedNutrition.confidence は、その皿の栄養推定にどれだけ自信があるかを high / medium / low で返してください
- 定食なら、ご飯・汁物・主菜・副菜/サラダを分けてください
- ご飯は炊いた後の量として見積もり、通常は80g〜220gの範囲で考えてください
- 汁物は器1杯として見積もり、通常は120g〜220gの範囲で考えてください
- 千切りキャベツなど付け合わせ野菜は、通常20g〜100gの範囲で考えてください
- role は料理の種類に応じて設定してください（主菜=main, 副菜=side, 汁物=soup, ご飯類=rice, サラダ=salad, デザート=dessert）
- 構造化 JSON で返してください`

  const { data } = await generateGeminiJson<GeminiAnalysisResult>({
    prompt,
    schema: mealRecognitionSchema as unknown as Record<string, unknown>,
    images,
    temperature: 0.4,
    maxOutputTokens: 4096,
    model: GEMINI_MEAL_ANALYSIS_MODEL,
  })

  return normalizeGeminiAnalysisResult(data)
}

// ============================================
// 褒めコメント・豆知識生成
// ============================================

function toMealTypeLabel(mealType: string): string {
  return mealType === 'breakfast' ? '朝食'
    : mealType === 'lunch' ? '昼食'
    : mealType === 'dinner' ? '夕食'
    : mealType === 'snack' ? 'おやつ'
    : mealType === 'midnight_snack' ? '夜食'
    : '食事'
}

function buildTemplatePraiseAndTip(
  dishes: AnalyzedDish[],
  totalNutrition: NutritionTotals,
  mealType: string
): { praiseComment: string; nutritionTip: string; overallScore: number } {
  const mealTypeJa = toMealTypeLabel(mealType)
  const topDishes = dishes
    .map((dish) => dish.name.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('、')

  const dishPhrase = topDishes ? `${topDishes}の記録` : `${mealTypeJa}の記録`
  const proteinScore = Math.min(10, totalNutrition.protein_g / 3)
  const fiberScore = Math.min(8, totalNutrition.fiber_g * 1.6)
  const caloriesScore = totalNutrition.calories_kcal >= 250 && totalNutrition.calories_kcal <= 900 ? 5 : 2
  const overallScore = Math.max(70, Math.min(95, Math.round(70 + proteinScore + fiberScore + caloriesScore)))

  let nutritionTip = '食事を記録して振り返ること自体が、バランス改善の近道です。'
  if (totalNutrition.protein_g >= 25) {
    nutritionTip = 'たんぱく質がしっかり取れる食事は、満足感の維持や体づくりに役立ちます。'
  } else if (totalNutrition.fiber_g >= 6) {
    nutritionTip = '食物繊維を含む食事は、食生活のリズムづくりや満足感の維持に役立ちます。'
  }

  return {
    praiseComment: `${dishPhrase}がしっかりできていて素晴らしいです。${mealTypeJa}を丁寧に残せていて、とても良い流れです✨`,
    nutritionTip,
    overallScore,
  }
}

// ============================================
// メインパイプライン
// ============================================

export async function analyzeWithEvidence(
  images: ImageInput[],
  mealType: string,
  supabase: SupabaseClient,
  prefetchedGeminiResult?: GeminiAnalysisResult
): Promise<NutritionPipelineResult> {
  const pipelineStartedAt = Date.now()
  let imageRecognitionMs = 0
  let ingredientMatchingMs = 0
  let nutritionCalculationMs = 0
  let evidenceVerificationMs = 0
  let praiseGenerationMs = 0
  console.log('Step 1: Image recognition with Gemini 3.1 Flash-Lite Preview...', {
    model: GEMINI_MEAL_ANALYSIS_MODEL,
    prefetched: Boolean(prefetchedGeminiResult),
  })

  const step1StartedAt = Date.now()
  const geminiResult = prefetchedGeminiResult
    ? normalizeGeminiAnalysisResult(prefetchedGeminiResult)
    : await analyzeImageWithGemini(images, mealType)
  const normalizedDishes = geminiResult.dishes.map(normalizeDishForNutrition)
  imageRecognitionMs = prefetchedGeminiResult ? 0 : (Date.now() - step1StartedAt)
  console.log(`Recognized ${normalizedDishes.length} dishes`, {
    elapsedMs: imageRecognitionMs,
    prefetched: Boolean(prefetchedGeminiResult),
  })

  // Step 2-4: 各料理を処理
  const processedDishes = await Promise.all(
    normalizedDishes.map(async (dish) => {
      const useEstimatedNutrition = Boolean(dish.estimatedNutrition && shouldUseEstimatedNutrition(dish))
      const shouldUsePerplexityNutrition = Boolean(
        !useEstimatedNutrition &&
        dish.estimatedNutrition &&
        isPerplexityNutritionCandidate(dish, dish.estimatedNutrition.confidence),
      )
      let matchResults: IngredientMatchResult[] = []
      let stats = {
        total: dish.visibleIngredients.length,
        matched: 0,
        highConfidence: 0,
        mediumConfidence: 0,
        lowConfidence: 0,
        noMatch: dish.visibleIngredients.length,
        matchRate: 0,
      }
      let dishIngredientMatchingMs = 0
      let perplexityEstimate: MealNutritionEstimate | null = null

      if (useEstimatedNutrition) {
        console.log(`Step 2: Skipping ingredient search for "${dish.name}"`, {
          confidence: dish.estimatedNutrition?.confidence,
          role: dish.role,
        })
        stats = {
          total: dish.visibleIngredients.length,
          matched: dish.visibleIngredients.length,
          highConfidence: dish.estimatedNutrition?.confidence === 'high' ? dish.visibleIngredients.length : 0,
          mediumConfidence: dish.estimatedNutrition?.confidence === 'medium' ? dish.visibleIngredients.length : 0,
          lowConfidence: dish.estimatedNutrition?.confidence === 'low' ? dish.visibleIngredients.length : 0,
          noMatch: 0,
          matchRate: dish.visibleIngredients.length > 0 ? 1 : 0,
        }
      } else if (shouldUsePerplexityNutrition) {
        const perplexityStartedAt = Date.now()
        perplexityEstimate = await estimateNutritionWithPerplexity({
          name: dish.name,
          role: dish.role,
          cookingMethod: dish.cookingMethod,
          visiblePortionWeightG: dish.visiblePortionWeightG,
          visibleIngredients: dish.visibleIngredients,
        })
        dishIngredientMatchingMs = Date.now() - perplexityStartedAt

        if (perplexityEstimate) {
          console.log(`Step 2: Using Perplexity nutrition fallback for "${dish.name}"`, {
            confidence: dish.estimatedNutrition?.confidence,
            fallbackConfidence: perplexityEstimate.confidence,
            role: dish.role,
            elapsedMs: dishIngredientMatchingMs,
          })
          stats = {
            total: dish.visibleIngredients.length,
            matched: dish.visibleIngredients.length,
            highConfidence: perplexityEstimate.confidence === 'high' ? dish.visibleIngredients.length : 0,
            mediumConfidence: perplexityEstimate.confidence === 'medium' ? dish.visibleIngredients.length : 0,
            lowConfidence: perplexityEstimate.confidence === 'low' ? dish.visibleIngredients.length : 0,
            noMatch: 0,
            matchRate: dish.visibleIngredients.length > 0 ? 1 : 0,
          }
        } else {
          console.log(`Step 2: Perplexity fallback unavailable for "${dish.name}", using ingredient search`, {
            confidence: dish.estimatedNutrition?.confidence,
            role: dish.role,
            elapsedMs: dishIngredientMatchingMs,
          })
        }
      } else {
        console.log(`Step 2: Matching ingredients for "${dish.name}"...`)
        const matchStartedAt = Date.now()
        matchResults = await matchIngredients(supabase, dish.estimatedIngredients)
        stats = calculateMatchingStats(matchResults)
        dishIngredientMatchingMs = Date.now() - matchStartedAt
        console.log(`Matched ${stats.matched}/${stats.total} ingredients`, {
          dish: dish.name,
          elapsedMs: dishIngredientMatchingMs,
        })
      }

      if (shouldUsePerplexityNutrition && !perplexityEstimate) {
        console.log(`Step 2: Matching ingredients for "${dish.name}" after Perplexity miss...`)
        const matchStartedAt = Date.now()
        matchResults = await matchIngredients(supabase, dish.estimatedIngredients)
        stats = calculateMatchingStats(matchResults)
        dishIngredientMatchingMs += Date.now() - matchStartedAt
        console.log(`Matched ${stats.matched}/${stats.total} ingredients`, {
          dish: dish.name,
          elapsedMs: dishIngredientMatchingMs,
        })
      }

      console.log(`Step 3: Calculating nutrition for "${dish.name}"...`)
      const nutritionStartedAt = Date.now()
      const rawDishNutrition = useEstimatedNutrition && dish.estimatedNutrition
        ? buildEstimatedDishNutrition(dish, dish.estimatedNutrition)
        : perplexityEstimate
          ? buildEstimatedDishNutrition(dish, perplexityEstimate)
        : calculateDishNutrition(dish.name, dish.role, matchResults)
      const {
        dishNutrition,
        factor: nutritionAdjustmentFactor,
      } = applyDishNutritionCalibration(dish, rawDishNutrition)
      const dishNutritionCalculationMs = Date.now() - nutritionStartedAt

      const matchedIngredients: MatchedIngredientInfo[] = dish.visibleIngredients.map((ingredient, index) => ({
        input: ingredient.name,
        matchedName: useEstimatedNutrition || perplexityEstimate ? null : (dishNutrition.ingredients[index]?.matchedName ?? null),
        matchedId: useEstimatedNutrition || perplexityEstimate ? null : (dishNutrition.ingredients[index]?.matchedId ?? null),
        similarity: useEstimatedNutrition || perplexityEstimate ? 0 : (dishNutrition.ingredients[index]?.similarity ?? 0),
        amount_g: ingredient.amount_g,
      }))

      const analyzedDish: AnalyzedDish = {
        name: dish.name,
        role: dish.role,
        cookingMethod: dish.cookingMethod,
        visiblePortionWeightG: dish.visiblePortionWeightG,
        calories_kcal: dishNutrition.totals.calories_kcal,
        protein_g: dishNutrition.totals.protein_g,
        fat_g: dishNutrition.totals.fat_g,
        carbs_g: dishNutrition.totals.carbs_g,
        nutritionAdjustmentFactor,
        ingredient: dish.visibleIngredients.map((ingredient) => ingredient.name).slice(0, 3).join('、'),
        ingredients: dish.visibleIngredients.map((ingredient, index) => ({
          name: ingredient.name,
          amount_g: ingredient.amount_g,
          matched: useEstimatedNutrition
            ? null
            : perplexityEstimate
            ? null
            : (matchResults[index]?.matched ? {
                id: matchResults[index].matched!.id,
                name: matchResults[index].matched!.name,
                similarity: matchResults[index].matched!.similarity,
              } : null),
        })),
      }

      return {
        analyzedDish,
        stats,
        totals: dishNutrition.totals,
        matchedIngredients,
        ingredientMatchingMs: dishIngredientMatchingMs,
        nutritionCalculationMs: dishNutritionCalculationMs,
        usedEstimatedNutrition: useEstimatedNutrition || Boolean(perplexityEstimate),
      }
    }),
  )

  const analyzedDishes: AnalyzedDish[] = []
  let mealTotals = initNutritionTotals()
  const allMatchedIngredients: MatchedIngredientInfo[] = []
  let totalIngredientCount = 0
  let matchedIngredientCount = 0
  let usedLlmEstimatedNutrition = false

  for (const processed of processedDishes) {
    analyzedDishes.push(processed.analyzedDish)
    ingredientMatchingMs += processed.ingredientMatchingMs
    nutritionCalculationMs += processed.nutritionCalculationMs
    totalIngredientCount += processed.stats.total
    matchedIngredientCount += processed.stats.matched
    usedLlmEstimatedNutrition = usedLlmEstimatedNutrition || processed.usedEstimatedNutrition
    allMatchedIngredients.push(...processed.matchedIngredients)

    mealTotals.calories_kcal += processed.totals.calories_kcal
    mealTotals.protein_g += processed.totals.protein_g
    mealTotals.fat_g += processed.totals.fat_g
    mealTotals.carbs_g += processed.totals.carbs_g
    mealTotals.fiber_g += processed.totals.fiber_g
    mealTotals.sodium_mg += processed.totals.sodium_mg
    mealTotals.potassium_mg += processed.totals.potassium_mg
    mealTotals.calcium_mg += processed.totals.calcium_mg
    mealTotals.magnesium_mg += processed.totals.magnesium_mg
    mealTotals.phosphorus_mg += processed.totals.phosphorus_mg
    mealTotals.iron_mg += processed.totals.iron_mg
    mealTotals.zinc_mg += processed.totals.zinc_mg
    mealTotals.iodine_ug += processed.totals.iodine_ug
    mealTotals.cholesterol_mg += processed.totals.cholesterol_mg
    mealTotals.vitamin_a_ug += processed.totals.vitamin_a_ug
    mealTotals.vitamin_d_ug += processed.totals.vitamin_d_ug
    mealTotals.vitamin_e_mg += processed.totals.vitamin_e_mg
    mealTotals.vitamin_k_ug += processed.totals.vitamin_k_ug
    mealTotals.vitamin_b1_mg += processed.totals.vitamin_b1_mg
    mealTotals.vitamin_b2_mg += processed.totals.vitamin_b2_mg
    mealTotals.niacin_mg += processed.totals.niacin_mg
    mealTotals.vitamin_b6_mg += processed.totals.vitamin_b6_mg
    mealTotals.vitamin_b12_ug += processed.totals.vitamin_b12_ug
    mealTotals.folic_acid_ug += processed.totals.folic_acid_ug
    mealTotals.pantothenic_acid_mg += processed.totals.pantothenic_acid_mg
    mealTotals.biotin_ug += processed.totals.biotin_ug
    mealTotals.vitamin_c_mg += processed.totals.vitamin_c_mg
    mealTotals.salt_eq_g += processed.totals.salt_eq_g
  }

  mealTotals = roundNutrition(mealTotals)

  // Step 4: エビデンス検証（代表料理で）
  console.log('Step 4: Verifying with reference recipes...')
  const verificationStartedAt = Date.now()
  const mainDish = analyzedDishes.find(d => d.role === 'main') || analyzedDishes[0]
  const verification = await verifyNutrition(supabase, mainDish?.name || '食事', mealTotals)
  evidenceVerificationMs = Date.now() - verificationStartedAt
  console.log('Step 4 completed', {
    elapsedMs: evidenceVerificationMs,
    referenceCount: verification.allReferences.length,
  })
  
  // 全料理の参照レシピを収集
  const allReferences = verification.allReferences

  const matchRate = totalIngredientCount > 0 ? matchedIngredientCount / totalIngredientCount : 0
  const evidence = createEvidenceInfo(
    allMatchedIngredients,
    allReferences,
    verification,
    matchRate,
    usedLlmEstimatedNutrition
  )

  // Step 5: テンプレート文言生成
  console.log('Step 5: Building template praise and tips...')
  const praiseStartedAt = Date.now()
  const vegScore = estimateVegetableScore(analyzedDishes)
  const { praiseComment, nutritionTip, overallScore } = buildTemplatePraiseAndTip(
    analyzedDishes,
    mealTotals,
    mealType
  )
  praiseGenerationMs = Date.now() - praiseStartedAt
  console.log('Step 5 completed', {
    elapsedMs: praiseGenerationMs,
  })

  const totalMs = Date.now() - pipelineStartedAt
  console.log('Pipeline completed successfully', {
    totalElapsedMs: totalMs,
    dishCount: analyzedDishes.length,
    ingredientCount: totalIngredientCount,
  })

  return {
    dishes: analyzedDishes,
    totalCalories: mealTotals.calories_kcal,
    totalProtein: mealTotals.protein_g,
    totalCarbs: mealTotals.carbs_g,
    totalFat: mealTotals.fat_g,
    nutrition: {
      sodiumG: mealTotals.sodium_mg / 1000, // mg → g
      fiberG: mealTotals.fiber_g,
      potassiumMg: mealTotals.potassium_mg,
      calciumMg: mealTotals.calcium_mg,
      magnesiumMg: mealTotals.magnesium_mg,
      phosphorusMg: mealTotals.phosphorus_mg,
      ironMg: mealTotals.iron_mg,
      zincMg: mealTotals.zinc_mg,
      iodineUg: mealTotals.iodine_ug,
      cholesterolMg: mealTotals.cholesterol_mg,
      vitaminAUg: mealTotals.vitamin_a_ug,
      vitaminDUg: mealTotals.vitamin_d_ug,
      vitaminEMg: mealTotals.vitamin_e_mg,
      vitaminKUg: mealTotals.vitamin_k_ug,
      vitaminB1Mg: mealTotals.vitamin_b1_mg,
      vitaminB2Mg: mealTotals.vitamin_b2_mg,
      niacinMg: mealTotals.niacin_mg,
      vitaminB6Mg: mealTotals.vitamin_b6_mg,
      vitaminB12Ug: mealTotals.vitamin_b12_ug,
      folicAcidUg: mealTotals.folic_acid_ug,
      pantothenicAcidMg: mealTotals.pantothenic_acid_mg,
      biotinUg: mealTotals.biotin_ug,
      vitaminCMg: mealTotals.vitamin_c_mg,
      saltEqG: mealTotals.salt_eq_g,
    },
    evidence,
    overallScore,
    vegScore,
    praiseComment,
    nutritionTip,
    timings: {
      imageRecognitionMs,
      ingredientMatchingMs,
      nutritionCalculationMs,
      evidenceVerificationMs,
      praiseGenerationMs,
      totalMs,
    },
  }
}
