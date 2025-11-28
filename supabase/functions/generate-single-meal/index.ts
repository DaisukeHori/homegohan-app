import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("Generate Single Meal Function loaded (Personalized)")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { 
      dayDate,
      mealType, 
      userId,
      preferences = {},
      note = '',
      requestId = null
    } = await req.json()

    // 非同期でバックグラウンドタスクを実行
    generateSingleMealBackgroundTask({ 
      dayDate,
      mealType, 
      userId,
      preferences,
      note,
      requestId
    }).catch((error) => {
      console.error('Background task error:', error)
    })

    return new Response(
      JSON.stringify({ message: 'Single meal generation started in background' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

async function generateSingleMealBackgroundTask({ 
  dayDate,
  mealType, 
  userId,
  preferences,
  note,
  requestId
}: any) {
  console.log(`Starting personalized single meal generation for user: ${userId}, date: ${dayDate}, meal: ${mealType}, requestId: ${requestId}`)
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // リクエストステータスを processing に更新
  if (requestId) {
    await supabase
      .from('weekly_menu_requests')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', requestId)
  }

  try {
    // 1. ユーザープロファイルを取得（拡張版）
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    // プロファイルからパーソナライズ情報を構築
    const profileSummary = buildProfileSummary(profile)
    const nutritionTarget = calculateNutritionTarget(profile)
    const healthConstraints = buildHealthConstraints(profile)

    // 2. OpenAI APIで料理を生成
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
    if (!OPENAI_API_KEY) throw new Error('OpenAI API Key is missing')

    const mealTypeJa = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : mealType === 'dinner' ? '夕食' : mealType === 'snack' ? 'おやつ' : '夜食'
    const dayOfWeek = new Date(dayDate).toLocaleDateString('ja-JP', { weekday: 'long' })
    
    // 食事タイプごとのカロリー配分
    const mealCalorieRatio: Record<string, number> = {
      breakfast: 0.25,
      lunch: 0.35,
      dinner: 0.35,
      snack: 0.05,
      midnight_snack: 0.05
    }
    const targetMealCalories = Math.round(nutritionTarget.dailyCalories * (mealCalorieRatio[mealType] || 0.30))
    
    const prompt = `
あなたは一流の管理栄養士です。以下のユーザー情報に基づき、完全にパーソナライズされた${mealTypeJa}の献立を1食分生成してください。

【日付】${dayDate} (${dayOfWeek})
【食事タイプ】${mealTypeJa}

${profileSummary}

【この食事の栄養目標】
- カロリー: 約${targetMealCalories}kcal
- タンパク質: 約${Math.round(nutritionTarget.protein * (mealCalorieRatio[mealType] || 0.30))}g
${nutritionTarget.sodium < 2300 ? '- 塩分控えめ（減塩）' : ''}

【健康上の配慮事項】
${healthConstraints.length > 0 ? healthConstraints.map(c => `- ${c}`).join('\n') : '- 特になし'}

【調理条件】
- 調理時間: ${profile?.weekday_cooking_minutes || 30}分以内
- 料理経験: ${translateCookingExperience(profile?.cooking_experience)}

【ユーザーからのリクエスト】
${note || '特になし'}

【献立スタイルの指定】
${preferences.quickMeals ? '- 時短メニュー（15-20分以内）' : ''}
${preferences.japaneseStyle ? '- 和食中心' : ''}
${preferences.healthy ? '- ヘルシー志向（低カロリー・高タンパク）' : ''}
${preferences.useFridgeFirst ? '- 冷蔵庫の食材を優先' : ''}

【出力形式】
以下のJSON形式で出力してください。**各料理ごとに材料とレシピと栄養素(calories, protein, fat, carbs)を含めてください**：
{
  "dishes": [
    { 
      "name": "主菜名", 
      "role": "main", 
      "calories": 300, 
      "protein": 25,
      "fat": 12,
      "carbs": 10,
      "description": "簡潔な説明",
      "ingredients": ["鶏むね肉 200g", "玉ねぎ 1/2個", "塩 少々"],
      "recipeSteps": ["1. 鶏肉を一口大に切る", "2. フライパンで焼く", "3. 野菜と炒める"]
    },
    { 
      "name": "副菜名", 
      "role": "side", 
      "calories": 80, 
      "protein": 3,
      "fat": 4,
      "carbs": 8,
      "ingredients": ["ブロッコリー 1/2株", "オリーブオイル 小さじ1"],
      "recipeSteps": ["1. ブロッコリーを小房に分ける", "2. 茹でる", "3. オイルをかける"]
    },
    { 
      "name": "汁物名", 
      "role": "soup", 
      "calories": 40, 
      "protein": 2,
      "fat": 1,
      "carbs": 5,
      "ingredients": ["豆腐 50g", "わかめ 適量", "味噌 大さじ1"],
      "recipeSteps": ["1. 出汁をとる", "2. 具材を入れる", "3. 味噌を溶く"]
    },
    { 
      "name": "ご飯", 
      "role": "rice", 
      "calories": 240, 
      "protein": 4,
      "fat": 0,
      "carbs": 55,
      "ingredients": ["白米 150g（1膳）"],
      "recipeSteps": ["1. 炊飯器で炊く"]
    }
  ],
  "totalCalories": ${targetMealCalories},
  "totalProtein": 34,
  "totalFat": 17,
  "totalCarbs": 78,
  "cookingTime": "20分",
  "nutritionalAdvice": "この食事の栄養ポイント（健康状態を考慮したアドバイス）"
}

**重要:
- 健康状態に応じた除外食材は絶対に使用しないでください
- アレルギー食材は絶対に使用しないでください
- 目標カロリー${targetMealCalories}kcal前後になるよう調整してください
- 各料理にcalories、role、ingredients、recipeStepsを必ず含めてください
- roleは main（主菜）, side（副菜）, soup（汁物）, rice（主食：ご飯・パン・麺等）のいずれか
- 和食には必ずご飯（rice）を含め、洋食にはパン、中華には麺やご飯を含めてください
- 各料理のingredientsには「食材名 分量」形式で材料を含めてください
- 各料理のrecipeStepsには番号付きで3〜5ステップの調理手順を含めてください

【献立のバランスルール】
- 同じ役割（role）の料理を複数入れない（例：味噌汁と豚汁を両方入れない、ご飯とパンを両方入れない）
- 似たような調理法や味付けの料理を複数入れない（例：炒め物が2品、煮物が2品など）
- 食事全体で味・食感・温度にバリエーションを持たせる
- 例外：中華セット（ラーメン＋チャーハン）や定食スタイル（丼＋小鉢＋汁物）は食文化として自然な組み合わせ**
`

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    
    const response = await fetch(`${SUPABASE_URL}/functions/v1/knowledge-gpt`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'あなたは一流の管理栄養士です。健康状態と食事制限を厳守し、パーソナライズされた献立を提案します。JSONのみを出力してください。ナレッジベースにある献立サンプルとレシピを参照して回答してください。' },
          { role: 'user', content: prompt }
        ],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI API error: ${errorText}`)
    }

    const aiResult = await response.json()
    // Markdownコードブロックを除去してからJSONパース
    let content = aiResult.choices[0].message.content.trim()
    if (content.startsWith('```')) {
      const firstNewline = content.indexOf('\n')
      if (firstNewline !== -1) content = content.substring(firstNewline + 1)
      if (content.endsWith('```')) content = content.substring(0, content.length - 3)
      content = content.trim()
    }
    const newMealData = JSON.parse(content)

    // 3. 画像生成（メイン料理のみ）
    let imageUrl = null
    if (newMealData.dishes && newMealData.dishes.length > 0) {
      const mainDish = newMealData.dishes.find((d: any) => d.role === 'main') || newMealData.dishes[0]
      try {
        imageUrl = await generateMealImage(mainDish.name, userId, supabase)
        console.log(`✅ Image generated for ${mainDish.name}`)
      } catch (imgError: any) {
        console.warn(`⚠️ Image generation skipped: ${imgError.message}`)
      }
    }

    // 4. meal_plan_days と planned_meals に保存
    let mealPlanId: string | null = null
    
    // 既存のmeal_planを探す（その週のもの）
    const weekStart = getWeekStart(new Date(dayDate))
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekEnd.getDate() + 6)
    
    const { data: existingPlan } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', userId)
      .gte('start_date', weekStart.toISOString().split('T')[0])
      .lte('start_date', weekEnd.toISOString().split('T')[0])
      .single()

    if (existingPlan) {
      mealPlanId = existingPlan.id
    } else {
      // 新しいmeal_planを作成
      const { data: newPlan, error: planError } = await supabase
        .from('meal_plans')
        .insert({
          user_id: userId,
          title: `${weekStart.getMonth() + 1}月${weekStart.getDate()}日〜の献立`,
          start_date: weekStart.toISOString().split('T')[0],
          end_date: weekEnd.toISOString().split('T')[0],
          status: 'active',
          is_active: true,
        })
        .select('id')
        .single()
      
      if (planError) throw planError
      mealPlanId = newPlan.id
    }

    // meal_plan_dayを探すか作成
    let dayId: string | null = null
    const { data: existingDay } = await supabase
      .from('meal_plan_days')
      .select('id')
      .eq('meal_plan_id', mealPlanId)
      .eq('day_date', dayDate)
      .single()

    if (existingDay) {
      dayId = existingDay.id
    } else {
      const dayOfWeekEn = new Date(dayDate).toLocaleDateString('en-US', { weekday: 'long' })
      const { data: newDay, error: dayError } = await supabase
        .from('meal_plan_days')
        .insert({
          meal_plan_id: mealPlanId,
          day_date: dayDate,
          day_of_week: dayOfWeekEn,
          is_cheat_day: false,
          nutritional_focus: newMealData.nutritionalAdvice || null
        })
        .select('id')
        .single()
      
      if (dayError) throw dayError
      dayId = newDay.id
    }

    // 新しいplanned_mealを挿入（既存を削除せず追加）
    const aiDishes = newMealData.dishes || []
    
    // 配列形式でdishesを保存（各料理のingredients/recipeStepsを含む）
    const dishesArray = aiDishes.map((d: any) => ({
      name: d.name,
      cal: d.calories || 0,
      protein: d.protein || 0,
      fat: d.fat || 0,
      carbs: d.carbs || 0,
      role: mapRole(d.role) || 'side',
      ingredient: d.description || '',
      ingredients: d.ingredients || [],
      recipeSteps: d.recipeSteps || []
    }))
    
    const mainDish = aiDishes.find((d: any) => d.role === 'main') || aiDishes[0] || { name: '献立', calories: 0 }
    const allDishNames = aiDishes.map((d: any) => d.name).join('、') || mainDish.name
    
    // 総栄養素を計算
    const totalProtein = newMealData.totalProtein || dishesArray.reduce((sum: number, d: any) => sum + (d.protein || 0), 0)
    const totalFat = newMealData.totalFat || dishesArray.reduce((sum: number, d: any) => sum + (d.fat || 0), 0)
    const totalCarbs = newMealData.totalCarbs || dishesArray.reduce((sum: number, d: any) => sum + (d.carbs || 0), 0)
    
    // 全料理の材料を統合（買い物リスト用）
    const allIngredients = aiDishes.flatMap((d: any) => d.ingredients || [])
    
    const { error: mealError } = await supabase
      .from('planned_meals')
      .insert({
        meal_plan_day_id: dayId,
        meal_type: mealType,
        mode: 'cook',
        dish_name: allDishNames,
        description: newMealData.nutritionalAdvice || `調理時間: ${newMealData.cookingTime || ''}`,
        calories_kcal: newMealData.totalCalories || null,
        protein_g: totalProtein || null,
        fat_g: totalFat || null,
        carbs_g: totalCarbs || null,
        image_url: imageUrl,
        is_completed: false,
        dishes: dishesArray.length > 0 ? dishesArray : null,
        is_simple: dishesArray.length <= 1,
        ingredients: allIngredients.length > 0 ? allIngredients : null,
        recipe_steps: null, // 各料理ごとのレシピはdishes内に保存
      })

    if (mealError) throw mealError

    // リクエストステータスを completed に更新
    if (requestId) {
      await supabase
        .from('weekly_menu_requests')
        .update({ 
          status: 'completed', 
          updated_at: new Date().toISOString(),
          result_json: newMealData
        })
        .eq('id', requestId)
    }

    console.log(`✅ Single meal generation completed for ${mealTypeJa} on ${dayDate} (${newMealData.totalCalories}kcal)`)

  } catch (error: any) {
    console.error(`❌ Single meal generation failed:`, error.message)
    
    // リクエストステータスを failed に更新
    if (requestId) {
      await supabase
        .from('weekly_menu_requests')
        .update({ 
          status: 'failed', 
          error_message: error.message,
          updated_at: new Date().toISOString()
        })
        .eq('id', requestId)
    }
  }
}

// ==============================
// ヘルパー関数
// ==============================

function buildProfileSummary(profile: any): string {
  if (!profile) return '【ユーザー情報】なし'
  
  const allergies = profile.diet_flags?.allergies?.join(', ') || 'なし'
  const dislikes = profile.diet_flags?.dislikes?.join(', ') || 'なし'
  const favoriteIngredients = profile.favorite_ingredients?.join(', ') || '特になし'
  const fitnessGoals = profile.fitness_goals?.map((g: string) => translateGoal(g)).join(', ') || '健康維持'
  const healthConditions = profile.health_conditions?.join(', ') || 'なし'

  return `
【ユーザー基本情報】
- 年齢: ${profile.age || '不明'}歳
- 性別: ${profile.gender === 'male' ? '男性' : profile.gender === 'female' ? '女性' : '不明'}
- 身長: ${profile.height || '不明'}cm / 体重: ${profile.weight || '不明'}kg
${profile.target_weight ? `- 目標体重: ${profile.target_weight}kg` : ''}
- 目標: ${fitnessGoals}

【健康状態】
${healthConditions !== 'なし' ? `- 持病・注意点: ${healthConditions}` : '- 特になし'}
${profile.cold_sensitivity ? '- 冷え性あり' : ''}
${profile.swelling_prone ? '- むくみやすい' : ''}

【食事制限（厳守）】
- アレルギー（絶対除外）: ${allergies}
- 苦手なもの（避ける）: ${dislikes}
- 食事スタイル: ${translateDietStyle(profile.diet_style)}

【嗜好】
- 好きな食材: ${favoriteIngredients}
${formatCuisinePreferences(profile.cuisine_preferences)}
`
}

function calculateNutritionTarget(profile: any): any {
  if (!profile) {
    return { dailyCalories: 1800, protein: 60, fat: 50, carbs: 250, fiber: 18, sodium: 2300 }
  }

  // 基礎代謝計算
  let bmr = 1800
  if (profile.weight && profile.height && profile.age) {
    if (profile.gender === 'male') {
      bmr = Math.round(10 * profile.weight + 6.25 * profile.height - 5 * profile.age + 5)
    } else {
      bmr = Math.round(10 * profile.weight + 6.25 * profile.height - 5 * profile.age - 161)
    }
  }

  // 活動係数
  let activityMultiplier = 1.2
  const weeklyExercise = profile.weekly_exercise_minutes || 0
  if (weeklyExercise > 300) activityMultiplier = 1.7
  else if (weeklyExercise > 150) activityMultiplier = 1.5
  else if (weeklyExercise > 60) activityMultiplier = 1.4

  let tdee = bmr * activityMultiplier

  // 目標による調整
  const goals = profile.fitness_goals || []
  if (goals.includes('lose_weight')) {
    tdee -= 500
  } else if (goals.includes('gain_weight') || goals.includes('build_muscle')) {
    tdee += 300
  }

  // PFCバランス
  let proteinRatio = 0.20
  let fatRatio = 0.25
  let carbsRatio = 0.55

  if (goals.includes('build_muscle')) {
    proteinRatio = 0.30
    carbsRatio = 0.45
  }

  const dailyCalories = Math.max(Math.round(tdee), 1200)
  const conditions = profile.health_conditions || []

  return {
    dailyCalories,
    protein: Math.round((dailyCalories * proteinRatio) / 4),
    fat: Math.round((dailyCalories * fatRatio) / 9),
    carbs: Math.round((dailyCalories * carbsRatio) / 4),
    fiber: profile.gender === 'male' ? 21 : 18,
    sodium: conditions.includes('高血圧') ? 1500 : 2300
  }
}

function buildHealthConstraints(profile: any): string[] {
  if (!profile) return []
  
  const constraints: string[] = []
  const conditions = profile.health_conditions || []
  const goals = profile.fitness_goals || []

  if (conditions.includes('高血圧')) {
    constraints.push('【高血圧】塩分控えめ、カリウム豊富な食材推奨')
  }
  if (conditions.includes('糖尿病')) {
    constraints.push('【糖尿病】低GI食品、糖質控えめ')
  }
  if (conditions.includes('脂質異常症')) {
    constraints.push('【脂質異常症】飽和脂肪酸を減らし、オメガ3を増やす')
  }
  if (conditions.includes('貧血')) {
    constraints.push('【貧血】鉄分とビタミンC豊富な食材')
  }

  if (goals.includes('improve_skin')) {
    constraints.push('【美肌】ビタミンA/C/E豊富な食材')
  }
  if (goals.includes('gut_health')) {
    constraints.push('【腸活】食物繊維と発酵食品')
  }
  if (goals.includes('build_muscle')) {
    constraints.push('【筋肉増加】高タンパク食材')
  }

  if (profile.cold_sensitivity) {
    constraints.push('【冷え性】体を温める食材')
  }

  return constraints
}

function mapRole(role: string | undefined): string {
  if (!role) return 'side'
  const roleMap: Record<string, string> = {
    'main': 'main', '主菜': 'main', '主食': 'main',
    'side': 'side', '副菜': 'side',
    'soup': 'soup', '汁物': 'soup', '味噌汁': 'soup',
    'rice': 'rice', 'ご飯': 'rice',
    'salad': 'salad', 'サラダ': 'salad',
    'dessert': 'dessert', 'デザート': 'dessert'
  }
  return roleMap[role] || 'side'
}

function translateGoal(goal: string): string {
  const map: Record<string, string> = {
    lose_weight: '減量', gain_weight: '増量', build_muscle: '筋肉増加',
    improve_energy: 'エネルギーUP', improve_skin: '美肌', gut_health: '腸活',
    immunity: '免疫力向上', focus: '集中力向上'
  }
  return map[goal] || goal
}

function translateDietStyle(style: string | null): string {
  const map: Record<string, string> = {
    normal: '通常', vegetarian: 'ベジタリアン', vegan: 'ヴィーガン',
    pescatarian: 'ペスカタリアン', gluten_free: 'グルテンフリー', keto: 'ケトジェニック'
  }
  return map[style || ''] || '通常'
}

function translateCookingExperience(exp: string | null): string {
  const map: Record<string, string> = { beginner: '初心者', intermediate: '中級者', advanced: '上級者' }
  return map[exp || ''] || '初心者'
}

function formatCuisinePreferences(prefs: any): string {
  if (!prefs) return ''
  const labels: Record<string, string> = {
    japanese: '和食', western: '洋食', chinese: '中華',
    italian: 'イタリアン', ethnic: 'エスニック', korean: '韓国料理'
  }
  const items = Object.entries(prefs)
    .filter(([_, v]) => typeof v === 'number' && (v as number) >= 4)
    .map(([k]) => labels[k] || k)
  if (items.length === 0) return ''
  return `- 好きなジャンル: ${items.join(', ')}`
}

// 週の開始日を取得（月曜日）
function getWeekStart(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// 画像生成関数（Gemini API）
async function generateMealImage(dishName: string, userId: string, supabase: any): Promise<string> {
  const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
  const GEMINI_IMAGE_MODEL = Deno.env.get('GEMINI_IMAGE_MODEL') || 'gemini-2.5-flash-preview-image'
  
  if (!GOOGLE_AI_API_KEY) {
    throw new Error('Google AI API Key is missing')
  }

  const enhancedPrompt = `A delicious, appetizing, professional food photography shot of ${dishName}. Natural lighting, high resolution, minimalist plating, Japanese cuisine style.`

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GOOGLE_AI_API_KEY}`
  
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: enhancedPrompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '1:1' }
      }
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    if (response.status === 429) {
      throw new Error('QUOTA_EXCEEDED')
    }
    throw new Error(`Gemini API error: ${errorText}`)
  }

  const data = await response.json()
  const parts = data.candidates?.[0]?.content?.parts || []
  let imageBase64 = ''
  
  for (const part of parts) {
    if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
      imageBase64 = part.inlineData.data
      break
    }
  }

  if (!imageBase64) {
    throw new Error('No image data in response')
  }

  // Supabase Storageへアップロード
  const binaryString = atob(imageBase64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  
  const fileName = `generated/${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.png`
  
  const { error: uploadError } = await supabase.storage
    .from('fridge-images')
    .upload(fileName, bytes, { contentType: 'image/png', upsert: false })

  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`)

  const { data: { publicUrl } } = supabase.storage.from('fridge-images').getPublicUrl(fileName)
  return publicUrl
}
