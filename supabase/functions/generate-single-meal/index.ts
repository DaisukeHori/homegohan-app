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
    // 認証: service role または user JWT を許可（verify_jwt=false を補完）
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Authorization header required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }

    const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] ?? authHeader
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const body = await req.json()
    const {
      dayDate,
      mealType,
      userId: bodyUserId,
      preferences = {},
      note = '',
      requestId = null,
    } = body

    if (!dayDate || !mealType) {
      return new Response(JSON.stringify({ error: 'dayDate and mealType are required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    let userId: string
    if (token === serviceRoleKey) {
      // 内部呼び出し（サーバー側想定）
      if (!bodyUserId) {
        return new Response(JSON.stringify({ error: 'userId is required for service role calls' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      userId = bodyUserId
    } else {
      // ユーザーJWTで検証
      const supabaseAuth = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      )
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 401,
        })
      }
      if (bodyUserId && bodyUserId !== user.id) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 403,
        })
      }
      userId = user.id
    }

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
      .eq('user_id', userId)
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
以下のJSON形式で出力してください。**各料理ごとに材料とレシピと詳細栄養素(nutrition)を含めてください**：
{
  "dishes": [
    { 
      "name": "主菜名", 
      "role": "main", 
      "nutrition": {
        "cal": 300, "protein": 25, "fat": 12, "carbs": 10, "sodium": 0.8, "sugar": 2,
        "fiber": 2, "fiberSoluble": 0.5, "fiberInsoluble": 1.5,
        "potassium": 400, "calcium": 30, "phosphorus": 200, "iron": 2.0, "zinc": 2.5, "iodine": 10,
        "cholesterol": 60, "vitaminB1": 0.15, "vitaminB2": 0.2, "vitaminC": 10, "vitaminB6": 0.3,
        "vitaminB12": 0.3, "folicAcid": 20, "vitaminA": 50, "vitaminD": 0.5, "vitaminK": 5, "vitaminE": 0.8,
        "saturatedFat": 2.5, "monounsaturatedFat": 4.0, "polyunsaturatedFat": 2.0
      },
      "ingredients": ["鶏むね肉 200g", "玉ねぎ 1/2個", "塩 少々"],
      "recipeSteps": ["1. 鶏肉を一口大に切る", "2. フライパンで焼く", "3. 野菜と炒める"]
    },
    { 
      "name": "副菜名", 
      "role": "side", 
      "nutrition": {
        "cal": 80, "protein": 3, "fat": 4, "carbs": 8, "sodium": 0.3, "sugar": 2,
        "fiber": 3, "fiberSoluble": 1.0, "fiberInsoluble": 2.0,
        "potassium": 300, "calcium": 50, "phosphorus": 60, "iron": 1.0, "zinc": 0.5, "iodine": 5,
        "cholesterol": 0, "vitaminB1": 0.1, "vitaminB2": 0.15, "vitaminC": 60, "vitaminB6": 0.2,
        "vitaminB12": 0, "folicAcid": 100, "vitaminA": 80, "vitaminD": 0, "vitaminK": 150, "vitaminE": 1.5,
        "saturatedFat": 0.5, "monounsaturatedFat": 2.0, "polyunsaturatedFat": 1.0
      },
      "ingredients": ["ブロッコリー 1/2株", "オリーブオイル 小さじ1"],
      "recipeSteps": ["1. ブロッコリーを小房に分ける", "2. 茹でる", "3. オイルをかける"]
    },
    { 
      "name": "汁物名", 
      "role": "soup", 
      "nutrition": {
        "cal": 40, "protein": 2, "fat": 1, "carbs": 5, "sodium": 1.0, "sugar": 1,
        "fiber": 1, "fiberSoluble": 0.3, "fiberInsoluble": 0.7,
        "potassium": 150, "calcium": 40, "phosphorus": 50, "iron": 0.5, "zinc": 0.3, "iodine": 30,
        "cholesterol": 0, "vitaminB1": 0.05, "vitaminB2": 0.05, "vitaminC": 0, "vitaminB6": 0.05,
        "vitaminB12": 0, "folicAcid": 15, "vitaminA": 5, "vitaminD": 0, "vitaminK": 10, "vitaminE": 0.2,
        "saturatedFat": 0.2, "monounsaturatedFat": 0.3, "polyunsaturatedFat": 0.4
      },
      "ingredients": ["豆腐 50g", "わかめ 適量", "味噌 大さじ1"],
      "recipeSteps": ["1. 出汁をとる", "2. 具材を入れる", "3. 味噌を溶く"]
    },
    { 
      "name": "ご飯", 
      "role": "rice", 
      "nutrition": {
        "cal": 240, "protein": 4, "fat": 0, "carbs": 55, "sodium": 0, "sugar": 0,
        "fiber": 0.5, "fiberSoluble": 0, "fiberInsoluble": 0.5,
        "potassium": 50, "calcium": 5, "phosphorus": 50, "iron": 0.2, "zinc": 0.8, "iodine": 0,
        "cholesterol": 0, "vitaminB1": 0.05, "vitaminB2": 0.02, "vitaminC": 0, "vitaminB6": 0.05,
        "vitaminB12": 0, "folicAcid": 5, "vitaminA": 0, "vitaminD": 0, "vitaminK": 0, "vitaminE": 0,
        "saturatedFat": 0, "monounsaturatedFat": 0, "polyunsaturatedFat": 0
      },
      "ingredients": ["白米 150g（1膳）"],
      "recipeSteps": ["1. 炊飯器で炊く"]
    }
  ],
  "totalNutrition": {
    "cal": ${targetMealCalories}, "protein": 34, "fat": 17, "carbs": 78, "sodium": 2.1, "sugar": 5,
    "fiber": 6.5, "fiberSoluble": 1.8, "fiberInsoluble": 4.7,
    "potassium": 900, "calcium": 125, "phosphorus": 360, "iron": 3.7, "zinc": 4.1, "iodine": 45,
    "cholesterol": 60, "vitaminB1": 0.35, "vitaminB2": 0.42, "vitaminC": 70, "vitaminB6": 0.6,
    "vitaminB12": 0.3, "folicAcid": 140, "vitaminA": 135, "vitaminD": 0.5, "vitaminK": 165, "vitaminE": 2.5,
    "saturatedFat": 3.2, "monounsaturatedFat": 6.3, "polyunsaturatedFat": 3.4
  },
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
    
    // ストリーミングモードでリクエスト（内部でストリーミング処理、レスポンスはJSON）
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
    
    // 配列形式でdishesを保存（各料理のingredients/recipeSteps/nutritionを含む）
    const dishesArray = aiDishes.map((d: any) => {
      const n = d.nutrition || {}
      return {
        name: d.name,
        role: mapRole(d.role) || 'side',
        cal: n.cal || d.calories || 0,
        protein: n.protein || d.protein || 0,
        fat: n.fat || d.fat || 0,
        carbs: n.carbs || d.carbs || 0,
        sodium: n.sodium || 0,
        sugar: n.sugar || 0,
        fiber: n.fiber || 0,
        fiberSoluble: n.fiberSoluble || 0,
        fiberInsoluble: n.fiberInsoluble || 0,
        potassium: n.potassium || 0,
        calcium: n.calcium || 0,
        phosphorus: n.phosphorus || 0,
        iron: n.iron || 0,
        zinc: n.zinc || 0,
        iodine: n.iodine || 0,
        cholesterol: n.cholesterol || 0,
        vitaminB1: n.vitaminB1 || 0,
        vitaminB2: n.vitaminB2 || 0,
        vitaminC: n.vitaminC || 0,
        vitaminB6: n.vitaminB6 || 0,
        vitaminB12: n.vitaminB12 || 0,
        folicAcid: n.folicAcid || 0,
        vitaminA: n.vitaminA || 0,
        vitaminD: n.vitaminD || 0,
        vitaminK: n.vitaminK || 0,
        vitaminE: n.vitaminE || 0,
        saturatedFat: n.saturatedFat || 0,
        monounsaturatedFat: n.monounsaturatedFat || 0,
        polyunsaturatedFat: n.polyunsaturatedFat || 0,
        ingredient: d.description || '',
        ingredients: d.ingredients || [],
        recipeSteps: d.recipeSteps || []
      }
    })
    
    const mainDish = aiDishes.find((d: any) => d.role === 'main') || aiDishes[0] || { name: '献立', calories: 0 }
    const allDishNames = aiDishes.map((d: any) => d.name).join('、') || mainDish.name
    
    // totalNutritionから取得、なければ各料理から計算
    const tn = newMealData.totalNutrition || {}
    const sum = (key: string) => dishesArray.reduce((s: number, d: any) => s + (d[key] || 0), 0)
    
    const totalCalories = tn.cal || newMealData.totalCalories || sum('cal')
    const totalProtein = tn.protein || sum('protein')
    const totalFat = tn.fat || sum('fat')
    const totalCarbs = tn.carbs || sum('carbs')
    const totalSodium = tn.sodium || sum('sodium')
    const totalSugar = tn.sugar || sum('sugar')
    const totalFiber = tn.fiber || sum('fiber')
    const totalFiberSoluble = tn.fiberSoluble || sum('fiberSoluble')
    const totalFiberInsoluble = tn.fiberInsoluble || sum('fiberInsoluble')
    const totalPotassium = tn.potassium || sum('potassium')
    const totalCalcium = tn.calcium || sum('calcium')
    const totalPhosphorus = tn.phosphorus || sum('phosphorus')
    const totalIron = tn.iron || sum('iron')
    const totalZinc = tn.zinc || sum('zinc')
    const totalIodine = tn.iodine || sum('iodine')
    const totalCholesterol = tn.cholesterol || sum('cholesterol')
    const totalVitaminB1 = tn.vitaminB1 || sum('vitaminB1')
    const totalVitaminB2 = tn.vitaminB2 || sum('vitaminB2')
    const totalVitaminC = tn.vitaminC || sum('vitaminC')
    const totalVitaminB6 = tn.vitaminB6 || sum('vitaminB6')
    const totalVitaminB12 = tn.vitaminB12 || sum('vitaminB12')
    const totalFolicAcid = tn.folicAcid || sum('folicAcid')
    const totalVitaminA = tn.vitaminA || sum('vitaminA')
    const totalVitaminD = tn.vitaminD || sum('vitaminD')
    const totalVitaminK = tn.vitaminK || sum('vitaminK')
    const totalVitaminE = tn.vitaminE || sum('vitaminE')
    const totalSaturatedFat = tn.saturatedFat || sum('saturatedFat')
    const totalMonounsaturatedFat = tn.monounsaturatedFat || sum('monounsaturatedFat')
    const totalPolyunsaturatedFat = tn.polyunsaturatedFat || sum('polyunsaturatedFat')
    
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
        // 基本栄養素
        calories_kcal: totalCalories || null,
        protein_g: totalProtein || null,
        fat_g: totalFat || null,
        carbs_g: totalCarbs || null,
        // 塩分・糖質・食物繊維
        sodium_g: totalSodium || null,
        sugar_g: totalSugar || null,
        fiber_g: totalFiber || null,
        fiber_soluble_g: totalFiberSoluble || null,
        fiber_insoluble_g: totalFiberInsoluble || null,
        // ミネラル
        potassium_mg: totalPotassium || null,
        calcium_mg: totalCalcium || null,
        phosphorus_mg: totalPhosphorus || null,
        iron_mg: totalIron || null,
        zinc_mg: totalZinc || null,
        iodine_ug: totalIodine || null,
        cholesterol_mg: totalCholesterol || null,
        // ビタミン
        vitamin_b1_mg: totalVitaminB1 || null,
        vitamin_b2_mg: totalVitaminB2 || null,
        vitamin_c_mg: totalVitaminC || null,
        vitamin_b6_mg: totalVitaminB6 || null,
        vitamin_b12_ug: totalVitaminB12 || null,
        folic_acid_ug: totalFolicAcid || null,
        vitamin_a_ug: totalVitaminA || null,
        vitamin_d_ug: totalVitaminD || null,
        vitamin_k_ug: totalVitaminK || null,
        vitamin_e_mg: totalVitaminE || null,
        // 脂肪酸
        saturated_fat_g: totalSaturatedFat || null,
        monounsaturated_fat_g: totalMonounsaturatedFat || null,
        polyunsaturated_fat_g: totalPolyunsaturatedFat || null,
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
        .eq('user_id', userId)
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
        .eq('user_id', userId)
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
  // デフォルトは Nano Banana Pro（高品質）
  const GEMINI_IMAGE_MODEL = Deno.env.get('GEMINI_IMAGE_MODEL') || 'gemini-3-pro-image-preview'
  
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
