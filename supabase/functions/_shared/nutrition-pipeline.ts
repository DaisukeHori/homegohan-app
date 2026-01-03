/**
 * 栄養分析パイプライン（nutrition-pipeline.ts）
 * 
 * 食事写真分析の全ステップを統合:
 * 1. Gemini 3 Pro で画像認識
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
}

// ============================================
// Gemini 3 Pro 画像認識
// ============================================

async function analyzeImageWithGemini(
  images: ImageInput[],
  mealType: string
): Promise<GeminiAnalysisResult> {
  const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
  
  if (!GOOGLE_AI_API_KEY) {
    throw new Error('Google AI API Key is missing')
  }

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
- JSONのみを出力してください`

  // Gemini 3 Pro を使用
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${GOOGLE_AI_API_KEY}`

  const parts: any[] = images.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.base64 }
  }))
  parts.push({ text: prompt })

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini API error: ${errorText}`)
  }

  const data = await response.json()
  const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const jsonMatch = textContent.match(/\{[\s\S]*\}/)
  
  if (!jsonMatch) {
    throw new Error('Failed to parse Gemini response')
  }

  return JSON.parse(jsonMatch[0])
}

// ============================================
// 褒めコメント・豆知識生成
// ============================================

async function generatePraiseAndTip(
  dishes: AnalyzedDish[],
  totalNutrition: NutritionTotals,
  mealType: string
): Promise<{ praiseComment: string; nutritionTip: string; overallScore: number; vegScore: number }> {
  const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
  
  if (!GOOGLE_AI_API_KEY) {
    // フォールバック
    return {
      praiseComment: 'おいしそうな食事ですね！バランスの良い食事を心がけていて素晴らしいです✨',
      nutritionTip: '食事を楽しむことも健康の大切な要素です。',
      overallScore: 80,
      vegScore: 50,
    }
  }

  const dishNames = dishes.map(d => d.name).join('、')
  const mealTypeJa = mealType === 'breakfast' ? '朝食'
    : mealType === 'lunch' ? '昼食'
    : mealType === 'dinner' ? '夕食'
    : '食事'

  const prompt = `あなたは「ほめゴハン」の褒め上手なAIです。
この${mealTypeJa}を分析して、褒めコメントと豆知識を生成してください。

料理: ${dishNames}
カロリー: ${totalNutrition.calories_kcal}kcal
タンパク質: ${totalNutrition.protein_g}g
脂質: ${totalNutrition.fat_g}g
炭水化物: ${totalNutrition.carbs_g}g
食物繊維: ${totalNutrition.fiber_g}g
ビタミンC: ${totalNutrition.vitamin_c_mg}mg

以下のJSON形式で回答：
{
  "praiseComment": "良いところを見つけて褒めるコメント（80-120文字、絵文字1-2個使用）",
  "nutritionTip": "この食事に関連する豆知識（40-60文字）",
  "overallScore": 総合スコア（70-95の数値）,
  "vegScore": 野菜スコア（0-100の数値）
}

注意：
- praiseCommentは必ずポジティブ。批判や改善提案は含めない
- overallScoreは厳しすぎず、普通の食事でも75以上
- JSONのみを出力`

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${GOOGLE_AI_API_KEY}`

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
      })
    })

    if (!response.ok) {
      throw new Error('Gemini API error')
    }

    const data = await response.json()
    const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const jsonMatch = textContent.match(/\{[\s\S]*\}/)
    
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0])
      return {
        praiseComment: result.praiseComment || 'おいしそうな食事ですね！',
        nutritionTip: result.nutritionTip || '',
        overallScore: result.overallScore || 80,
        vegScore: result.vegScore || 50,
      }
    }
  } catch (error) {
    console.error('Praise generation error:', error)
  }

  // フォールバック
  return {
    praiseComment: 'おいしそうな食事ですね！バランスの良い食事を心がけていて素晴らしいです✨',
    nutritionTip: '食事を楽しむことも健康の大切な要素です。',
    overallScore: 80,
    vegScore: 50,
  }
}

// ============================================
// メインパイプライン
// ============================================

export async function analyzeWithEvidence(
  images: ImageInput[],
  mealType: string,
  supabase: SupabaseClient
): Promise<NutritionPipelineResult> {
  console.log('Step 1: Image recognition with Gemini 3 Pro...')
  
  // Step 1: 画像認識
  const geminiResult = await analyzeImageWithGemini(images, mealType)
  console.log(`Recognized ${geminiResult.dishes.length} dishes`)

  // Step 2-4: 各料理を処理
  const analyzedDishes: AnalyzedDish[] = []
  let mealTotals = initNutritionTotals()
  const allMatchedIngredients: MatchedIngredientInfo[] = []
  let totalIngredientCount = 0
  let matchedIngredientCount = 0

  for (const dish of geminiResult.dishes) {
    console.log(`Step 2: Matching ingredients for "${dish.name}"...`)
    
    // Step 2: 材料マッチング
    const matchResults = await matchIngredients(supabase, dish.estimatedIngredients)
    const stats = calculateMatchingStats(matchResults)
    console.log(`Matched ${stats.matched}/${stats.total} ingredients`)

    totalIngredientCount += stats.total
    matchedIngredientCount += stats.matched

    // Step 3: 栄養計算
    console.log(`Step 3: Calculating nutrition for "${dish.name}"...`)
    const dishNutrition = calculateDishNutrition(dish.name, dish.role, matchResults)

    // 材料情報を収集
    for (const ing of dishNutrition.ingredients) {
      allMatchedIngredients.push({
        input: ing.name,
        matchedName: ing.matchedName,
        matchedId: ing.matchedId,
        similarity: ing.similarity,
        amount_g: ing.amount_g,
      })
    }

    // 料理を構築
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
    analyzedDishes.push(analyzedDish)

    // 合計に加算
    mealTotals.calories_kcal += dishNutrition.totals.calories_kcal
    mealTotals.protein_g += dishNutrition.totals.protein_g
    mealTotals.fat_g += dishNutrition.totals.fat_g
    mealTotals.carbs_g += dishNutrition.totals.carbs_g
    mealTotals.fiber_g += dishNutrition.totals.fiber_g
    mealTotals.sodium_mg += dishNutrition.totals.sodium_mg
    mealTotals.potassium_mg += dishNutrition.totals.potassium_mg
    mealTotals.calcium_mg += dishNutrition.totals.calcium_mg
    mealTotals.magnesium_mg += dishNutrition.totals.magnesium_mg
    mealTotals.phosphorus_mg += dishNutrition.totals.phosphorus_mg
    mealTotals.iron_mg += dishNutrition.totals.iron_mg
    mealTotals.zinc_mg += dishNutrition.totals.zinc_mg
    mealTotals.iodine_ug += dishNutrition.totals.iodine_ug
    mealTotals.cholesterol_mg += dishNutrition.totals.cholesterol_mg
    mealTotals.vitamin_a_ug += dishNutrition.totals.vitamin_a_ug
    mealTotals.vitamin_d_ug += dishNutrition.totals.vitamin_d_ug
    mealTotals.vitamin_e_mg += dishNutrition.totals.vitamin_e_mg
    mealTotals.vitamin_k_ug += dishNutrition.totals.vitamin_k_ug
    mealTotals.vitamin_b1_mg += dishNutrition.totals.vitamin_b1_mg
    mealTotals.vitamin_b2_mg += dishNutrition.totals.vitamin_b2_mg
    mealTotals.niacin_mg += dishNutrition.totals.niacin_mg
    mealTotals.vitamin_b6_mg += dishNutrition.totals.vitamin_b6_mg
    mealTotals.vitamin_b12_ug += dishNutrition.totals.vitamin_b12_ug
    mealTotals.folic_acid_ug += dishNutrition.totals.folic_acid_ug
    mealTotals.pantothenic_acid_mg += dishNutrition.totals.pantothenic_acid_mg
    mealTotals.biotin_ug += dishNutrition.totals.biotin_ug
    mealTotals.vitamin_c_mg += dishNutrition.totals.vitamin_c_mg
    mealTotals.salt_eq_g += dishNutrition.totals.salt_eq_g
  }

  mealTotals = roundNutrition(mealTotals)

  // Step 4: エビデンス検証（代表料理で）
  console.log('Step 4: Verifying with reference recipes...')
  const mainDish = analyzedDishes.find(d => d.role === 'main') || analyzedDishes[0]
  const verification = await verifyNutrition(supabase, mainDish?.name || '食事', mealTotals)
  
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

  // Step 5: 褒めコメント・豆知識生成
  console.log('Step 5: Generating praise and tips...')
  const { praiseComment, nutritionTip, overallScore, vegScore } = await generatePraiseAndTip(
    analyzedDishes,
    mealTotals,
    mealType
  )

  console.log('Pipeline completed successfully')

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
  }
}
