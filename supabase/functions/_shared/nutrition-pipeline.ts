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
  calculateMealNutrition,
  NutritionTotals,
  initNutritionTotals,
  roundNutrition
} from './nutrition-calculator-v2.ts'
import { 
  verifyNutrition, 
  createEvidenceInfo, 
  EvidenceInfo,
  MatchedIngredientInfo,
  searchSimilarRecipes
} from './evidence-verifier.ts'
import { generateGeminiJson } from './gemini-json.ts'

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
  estimatedIngredients: EstimatedIngredient[]
}

export interface GeminiAnalysisResult {
  dishes: GeminiDish[]
}

export interface AnalyzedDish {
  name: string
  role: string
  calories_kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
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
        required: ['name', 'role', 'estimatedIngredients'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['main', 'side', 'soup', 'rice', 'salad', 'dessert'] },
          estimatedIngredients: {
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

function normalizeGeminiAnalysisResult(raw: unknown): GeminiAnalysisResult {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const dishesInput = Array.isArray(input.dishes) ? input.dishes : []

  return {
    dishes: dishesInput.map((dish) => {
      const item = typeof dish === 'object' && dish !== null ? dish as Record<string, unknown> : {}
      const estimatedIngredientsInput = Array.isArray(item.estimatedIngredients) ? item.estimatedIngredients : []

      return {
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '不明な料理',
        role: typeof item.role === 'string' && item.role.trim() ? item.role.trim() : 'main',
        estimatedIngredients: estimatedIngredientsInput
          .map((ingredient) => {
            const candidate = typeof ingredient === 'object' && ingredient !== null ? ingredient as Record<string, unknown> : {}
            const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : null
            const amount = toOptionalNumber(candidate.amount_g)
            if (!name || amount === undefined) return null
            return { name, amount_g: Math.max(0, amount) }
          })
          .filter((ingredient): ingredient is EstimatedIngredient => ingredient !== null),
      }
    }).filter((dish) => dish.estimatedIngredients.length > 0),
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

各料理について、**材料と分量を推定**してください。

以下のJSON形式で回答してください：

{
  "dishes": [
    {
      "name": "料理名",
      "role": "main または side または soup または rice または salad または dessert",
      "estimatedIngredients": [
        { "name": "材料名（一般的な食材名で）", "amount_g": 推定量(g) }
      ]
    }
  ]
}

注意：
- 全ての写真に写っている全ての料理を含めてください
- 材料名は「鶏もも肉」「白米」「味噌」など一般的な食材名で記載
- 分量は1人前として推定してください
- 調味料（塩、砂糖、しょうゆ等）も含めてください
- roleは料理の種類に応じて設定（主菜=main, 副菜=side, 汁物=soup, ご飯類=rice, サラダ=salad, デザート=dessert）
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
): { praiseComment: string; nutritionTip: string; overallScore: number; vegScore: number } {
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
  const vegScore = Math.max(0, Math.min(100, Math.round(Math.min(100, totalNutrition.fiber_g * 12 + dishes.length * 6))))

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
    vegScore,
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
  imageRecognitionMs = prefetchedGeminiResult ? 0 : (Date.now() - step1StartedAt)
  console.log(`Recognized ${geminiResult.dishes.length} dishes`, {
    elapsedMs: imageRecognitionMs,
    prefetched: Boolean(prefetchedGeminiResult),
  })

  // Step 2-4: 各料理を処理
  const processedDishes = await Promise.all(
    geminiResult.dishes.map(async (dish) => {
      console.log(`Step 2: Matching ingredients for "${dish.name}"...`)

      const matchStartedAt = Date.now()
      const matchResults = await matchIngredients(supabase, dish.estimatedIngredients)
      const stats = calculateMatchingStats(matchResults)
      const dishIngredientMatchingMs = Date.now() - matchStartedAt
      console.log(`Matched ${stats.matched}/${stats.total} ingredients`, {
        dish: dish.name,
        elapsedMs: dishIngredientMatchingMs,
      })

      console.log(`Step 3: Calculating nutrition for "${dish.name}"...`)
      const nutritionStartedAt = Date.now()
      const dishNutrition = calculateDishNutrition(dish.name, dish.role, matchResults)
      const dishNutritionCalculationMs = Date.now() - nutritionStartedAt

      const matchedIngredients: MatchedIngredientInfo[] = dishNutrition.ingredients.map((ing) => ({
        input: ing.name,
        matchedName: ing.matchedName,
        matchedId: ing.matchedId,
        similarity: ing.similarity,
        amount_g: ing.amount_g,
      }))

      const analyzedDish: AnalyzedDish = {
        name: dish.name,
        role: dish.role,
        calories_kcal: dishNutrition.totals.calories_kcal,
        protein_g: dishNutrition.totals.protein_g,
        fat_g: dishNutrition.totals.fat_g,
        carbs_g: dishNutrition.totals.carbs_g,
        ingredient: dish.estimatedIngredients.map(i => i.name).slice(0, 3).join('、'),
        ingredients: matchResults.map((mr: IngredientMatchResult) => ({
          name: mr.input.name,
          amount_g: mr.input.amount_g,
          matched: mr.matched ? {
            id: mr.matched.id,
            name: mr.matched.name,
            similarity: mr.matched.similarity,
          } : null,
        })),
      }

      return {
        analyzedDish,
        stats,
        totals: dishNutrition.totals,
        matchedIngredients,
        ingredientMatchingMs: dishIngredientMatchingMs,
        nutritionCalculationMs: dishNutritionCalculationMs,
      }
    }),
  )

  const analyzedDishes: AnalyzedDish[] = []
  let mealTotals = initNutritionTotals()
  const allMatchedIngredients: MatchedIngredientInfo[] = []
  let totalIngredientCount = 0
  let matchedIngredientCount = 0

  for (const processed of processedDishes) {
    analyzedDishes.push(processed.analyzedDish)
    ingredientMatchingMs += processed.ingredientMatchingMs
    nutritionCalculationMs += processed.nutritionCalculationMs
    totalIngredientCount += processed.stats.total
    matchedIngredientCount += processed.stats.matched
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
    false
  )

  // Step 5: テンプレート文言生成
  console.log('Step 5: Building template praise and tips...')
  const praiseStartedAt = Date.now()
  const { praiseComment, nutritionTip, overallScore, vegScore } = buildTemplatePraiseAndTip(
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
