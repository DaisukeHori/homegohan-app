import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

console.log("Generate Weekly Menu Function loaded (Personalized)")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { userId, startDate, note, familySize, cheatDay, preferences, requestId = null } = await req.json()

    // 非同期でバックグラウンドタスクを実行（レスポンスをブロックしない）
    generateMenuBackgroundTask({ userId, startDate, note, familySize, cheatDay, preferences, requestId }).catch((error) => {
      console.error('Background task error:', error)
    })

    return new Response(
      JSON.stringify({ message: 'Menu generation started in background' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

async function generateMenuBackgroundTask({ userId, startDate, note, familySize = 1, cheatDay, preferences = {}, requestId = null }: any) {
  console.log(`Starting personalized generation for user: ${userId}, startDate: ${startDate}, requestId: ${requestId}`)
  
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
    // ユーザープロファイルを取得（拡張版）
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (profileError) throw new Error(`Profile not found: ${profileError.message}`)

    // 最新の健康記録を取得（過去7日間）
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const { data: healthRecords } = await supabase
      .from('health_records')
      .select('*')
      .eq('user_id', userId)
      .gte('record_date', weekAgo.toISOString().split('T')[0])
      .order('record_date', { ascending: false })
      .limit(7)

    // 最新のAI分析結果を取得
    const { data: healthInsights } = await supabase
      .from('health_insights')
      .select('*')
      .eq('user_id', userId)
      .eq('is_alert', true)
      .eq('is_dismissed', false)
      .order('created_at', { ascending: false })
      .limit(3)

    // 健康目標を取得
    const { data: healthGoals } = await supabase
      .from('health_goals')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')

    // プロファイルからパーソナライズ情報を構築
    const profileSummary = buildProfileSummary(profile)
    const nutritionTarget = calculateNutritionTarget(profile, healthRecords, healthGoals)
    const healthConstraints = buildHealthConstraints(profile, healthRecords, healthInsights)
    const cookingConstraints = buildCookingConstraints(profile)

    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
    if (!OPENAI_API_KEY) throw new Error('OpenAI API Key is missing')

    // startDateから7日分の日付を生成
    const start = new Date(startDate)
    const weekDates: string[] = []
    const weekDays: string[] = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日']
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(start)
      date.setDate(start.getDate() + i)
      const dateStr = date.toISOString().split('T')[0]
      const dayIndex = date.getDay()
      weekDates.push(`${dateStr} (${weekDays[dayIndex]})`)
    }

    // 超パーソナライズされたプロンプト
    const prompt = `
あなたはトップアスリートや経営者を支える超一流の「AI管理栄養士」です。
以下のユーザー情報に基づき、**完全にパーソナライズされた7日分の献立**をJSON形式で生成してください。

【開始日と期間】
- 開始日: ${startDate}
- 以下の7日分の献立を生成してください:
  ${weekDates.map((d, i) => `${i + 1}. ${d}`).join('\n  ')}

${profileSummary}

【栄養目標（1日）】
- カロリー: ${nutritionTarget.dailyCalories}kcal
- タンパク質: ${nutritionTarget.protein}g
- 脂質: ${nutritionTarget.fat}g
- 炭水化物: ${nutritionTarget.carbs}g
- 食物繊維: ${nutritionTarget.fiber}g以上
${nutritionTarget.sodium < 2300 ? `- 塩分: ${nutritionTarget.sodium / 1000}g以下（減塩必須）` : ''}

【健康上の配慮事項】
${healthConstraints.length > 0 ? healthConstraints.map(c => `- ${c}`).join('\n') : '- 特になし'}

【調理条件】
${cookingConstraints.map(c => `- ${c}`).join('\n')}

【今週のリクエスト】
${note || '特になし'}

【献立スタイルの指定】
${preferences.useFridgeFirst ? '- 【重要】冷蔵庫にある食材を優先的に使用してください' : ''}
${preferences.quickMeals ? '- 【重要】時短メニュー中心（調理時間15-20分以内）で構成してください' : ''}
${preferences.japaneseStyle ? '- 【重要】和食を中心に構成してください（洋食・中華は控えめに）' : ''}
${preferences.healthy ? '- 【重要】ヘルシー志向（低カロリー・高タンパク・野菜多め）で構成してください' : ''}

【生成要件】
1. 献立は**必ず7日分**を生成
2. 各日に朝食(breakfast)、昼食(lunch)、夕食(dinner)を含める
3. 栄養目標を満たすようPFCバランスを考慮
4. 健康状態に応じた食材選定（除外食材は絶対に使用しない）
5. 調理時間の制約を守る
6. 家族${familySize || profile.family_size || 1}人分の分量を考慮
7. 食材の使い回しで効率的に
8. 各料理に正確なカロリーを付与

【JSON出力スキーマ】
{
  "days": [
    {
      "date": "YYYY-MM-DD",
      "meals": [
        { 
          "mealType": "breakfast", 
          "dishes": [
            {
              "name": "料理名", 
              "role": "主菜", 
              "nutrition": {
                "cal": 200, "protein": 10, "fat": 8, "carbs": 5, "sodium": 0.8, "sugar": 2,
                "fiber": 2, "fiberSoluble": 0.5, "fiberInsoluble": 1.5,
                "potassium": 300, "calcium": 20, "phosphorus": 150, "iron": 1.5, "zinc": 2.0, "iodine": 10,
                "cholesterol": 180, "vitaminB1": 0.1, "vitaminB2": 0.2, "vitaminC": 5, "vitaminB6": 0.2,
                "vitaminB12": 0.5, "folicAcid": 30, "vitaminA": 100, "vitaminD": 1.0, "vitaminK": 10, "vitaminE": 1.0,
                "saturatedFat": 2.5, "monounsaturatedFat": 3.0, "polyunsaturatedFat": 1.5
              },
              "ingredients": ["卵 2個", "バター 10g", "塩 少々"],
              "recipeSteps": ["1. 卵を溶く", "2. バターを熱する", "3. 焼く"]
            },
            {
              "name": "味噌汁", 
              "role": "汁物", 
              "nutrition": {
                "cal": 50, "protein": 3, "fat": 1, "carbs": 5, "sodium": 1.2, "sugar": 1,
                "fiber": 1, "fiberSoluble": 0.3, "fiberInsoluble": 0.7,
                "potassium": 200, "calcium": 40, "phosphorus": 50, "iron": 0.5, "zinc": 0.3, "iodine": 50,
                "cholesterol": 0, "vitaminB1": 0.05, "vitaminB2": 0.05, "vitaminC": 0, "vitaminB6": 0.05,
                "vitaminB12": 0, "folicAcid": 10, "vitaminA": 5, "vitaminD": 0, "vitaminK": 5, "vitaminE": 0.2,
                "saturatedFat": 0.2, "monounsaturatedFat": 0.3, "polyunsaturatedFat": 0.4
              },
              "ingredients": ["豆腐 50g", "わかめ 適量", "味噌 大さじ1"],
              "recipeSteps": ["1. 出汁をとる", "2. 具材を入れる", "3. 味噌を溶く"]
            },
            {
              "name": "ご飯", 
              "role": "主食", 
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
            "cal": 490, "protein": 17, "fat": 9, "carbs": 65, "sodium": 2.0, "sugar": 3,
            "fiber": 3.5, "fiberSoluble": 0.8, "fiberInsoluble": 2.7,
            "potassium": 550, "calcium": 65, "phosphorus": 250, "iron": 2.2, "zinc": 3.1, "iodine": 60,
            "cholesterol": 180, "vitaminB1": 0.2, "vitaminB2": 0.27, "vitaminC": 5, "vitaminB6": 0.3,
            "vitaminB12": 0.5, "folicAcid": 45, "vitaminA": 105, "vitaminD": 1.0, "vitaminK": 15, "vitaminE": 1.2,
            "saturatedFat": 2.7, "monounsaturatedFat": 3.3, "polyunsaturatedFat": 1.9
          },
          "cookingTime": "15分"
        },
        { "mealType": "lunch", "dishes": [...], "totalCalories": 500, "cookingTime": "20分" },
        { "mealType": "dinner", "dishes": [...], "totalCalories": 600, "cookingTime": "30分" }
      ],
      "dailyTotalCalories": 1590,
      "nutritionalAdvice": "この日の栄養ポイント"
    }
  ],
  "weeklyAdvice": "1週間の総評とアドバイス",
  "shoppingList": [
    {"category": "肉類", "items": ["鶏むね肉 500g", "豚ロース 300g"]},
    {"category": "野菜", "items": ["キャベツ 1玉", "にんじん 3本"]}
  ]
}

**重要: 
- days配列には必ず7つのオブジェクト（7日分）を含めてください
- **各料理（dish）にcal、role、ingredients（材料配列）、recipeSteps（手順配列）を必ず含めてください**
- roleは 主菜, 副菜, 汁物, 主食（ご飯・パン・麺等）のいずれか
- 和食の食事には必ずご飯（主食）を含め、洋食にはパン、中華には麺やご飯を含めてください
- 各料理のingredientsは「食材名 分量」形式の配列にしてください
- 各料理のrecipeStepsは番号付き手順（3〜5ステップ）の配列にしてください
- 健康状態に応じた除外食材は絶対に使用しないでください
- 調理時間は平日${profile.weekday_cooking_minutes || 30}分、休日${profile.weekend_cooking_minutes || 60}分を目安に

【各食事のバランスルール】
- 同じ役割（role）の料理を1食に複数入れない（例：味噌汁と豚汁を両方入れない、ご飯とパンを両方入れない）
- 似たような調理法や味付けの料理を1食に複数入れない（例：炒め物が2品、煮物が2品など）
- 1食の中で味・食感・温度にバリエーションを持たせる
- 例外：中華セット（ラーメン＋チャーハン）や定食スタイル（丼＋小鉢＋汁物）は食文化として自然な組み合わせ**
`

    console.log('Sending personalized prompt to knowledge-gpt...')

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    
    const aiResponse = await fetch(`${SUPABASE_URL}/functions/v1/knowledge-gpt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You are an elite nutritionist AI specialized in personalized meal planning. Respond only in valid JSON. Consider all health conditions and dietary restrictions carefully. ナレッジベースにある献立サンプルとレシピを参照して回答してください。" },
          { role: "user", content: prompt }
        ],
      }),
    })

    if (!aiResponse.ok) throw new Error(await aiResponse.text())

    const aiData = await aiResponse.json()
    // Markdownコードブロックを除去してからJSONパース
    let content = aiData.choices[0].message.content.trim()
    if (content.startsWith('```')) {
      const firstNewline = content.indexOf('\n')
      if (firstNewline !== -1) content = content.substring(firstNewline + 1)
      if (content.endsWith('```')) content = content.substring(0, content.length - 3)
      content = content.trim()
    }
    const resultJson = JSON.parse(content)

    // 7日分の献立が生成されているか検証
    if (!resultJson.days || !Array.isArray(resultJson.days) || resultJson.days.length !== 7) {
      throw new Error(`Invalid response: Expected 7 days, but got ${resultJson.days?.length || 0} days.`)
    }

    console.log('AI response validated. Saving to planned_meals table...')
    
    // === planned_mealsテーブルにデータを保存 ===
    
    // 1. meal_planを作成または取得
    const { data: existingPlan } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', userId)
      .eq('start_date', startDate)
      .single()
    
    let mealPlanId: string
    
    if (existingPlan) {
      mealPlanId = existingPlan.id
      console.log(`Using existing meal_plan: ${mealPlanId}`)
    } else {
      const endDate = new Date(startDate)
      endDate.setDate(endDate.getDate() + 6)
      const endDateStr = endDate.toISOString().split('T')[0]
      
      const { data: newPlan, error: planError } = await supabase
        .from('meal_plans')
        .insert({
          user_id: userId,
          start_date: startDate,
          end_date: endDateStr,
          status: 'active'
        })
        .select()
        .single()
      
      if (planError) throw new Error(`Failed to create meal_plan: ${planError.message}`)
      mealPlanId = newPlan.id
      console.log(`Created new meal_plan: ${mealPlanId}`)
    }
    
    // 2. 各日のmeal_plan_daysとplanned_mealsを作成
    for (const day of resultJson.days) {
      const dayDate = day.date
      
      // meal_plan_dayを作成または取得
      const { data: existingDay } = await supabase
        .from('meal_plan_days')
        .select('id')
        .eq('meal_plan_id', mealPlanId)
        .eq('day_date', dayDate)
        .single()
      
      let mealPlanDayId: string
      
      if (existingDay) {
        mealPlanDayId = existingDay.id
        // 既存の献立を削除
        await supabase
          .from('planned_meals')
          .delete()
          .eq('meal_plan_day_id', mealPlanDayId)
        console.log(`Cleared existing meals for ${dayDate}`)
      } else {
        const { data: newDay, error: dayError } = await supabase
          .from('meal_plan_days')
          .insert({
            meal_plan_id: mealPlanId,
            day_date: dayDate,
            nutritional_focus: day.nutritionalAdvice || null
          })
          .select()
          .single()
        
        if (dayError) throw new Error(`Failed to create meal_plan_day: ${dayError.message}`)
        mealPlanDayId = newDay.id
      }
      
      // 3. 各食事をplanned_mealsに保存
      for (const meal of day.meals) {
        const mealType = meal.mealType
        const dishes = meal.dishes || []
        const mainDish = dishes.find((d: any) => 
          d.role === '主菜' || d.role === '主食' || d.role === 'main' || d.role === '主'
        ) || dishes[0]
        const dishName = mainDish?.name || '献立'
        
        // dishesをDishDetail[]形式に変換（各料理のingredients/recipeSteps/nutritionを含む）
        const dishDetails = dishes.map((d: any, index: number) => {
          const n = d.nutrition || {}
          return {
            name: d.name,
            role: mapRole(d.role) || (index === 0 ? 'main' : `side${index}`),
            cal: n.cal || d.cal || 0,
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
        
        // totalNutritionから取得、なければ各料理から計算
        const tn = meal.totalNutrition || {}
        const sum = (key: string) => dishDetails.reduce((s: number, d: any) => s + (d[key] || 0), 0)
        
        const totalCalories = tn.cal || sum('cal')
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
        const allIngredients = dishes.flatMap((d: any) => d.ingredients || [])
        
        const { error: mealError } = await supabase
          .from('planned_meals')
          .insert({
            meal_plan_day_id: mealPlanDayId,
            meal_type: mealType,
            mode: 'cook',
            dish_name: dishName,
            description: meal.cookingTime ? `調理時間: ${meal.cookingTime}` : null,
            dishes: dishDetails,
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
            is_simple: dishDetails.length <= 1,
            is_completed: false,
            ingredients: allIngredients.length > 0 ? allIngredients : null,
            recipe_steps: null, // 各料理ごとのレシピはdishes内に保存
          })
        
        if (mealError) {
          console.error(`Failed to insert planned_meal for ${dayDate} ${mealType}:`, mealError)
        } else {
          console.log(`✅ Saved: ${dayDate} ${mealType} - ${dishName} (${totalCalories}kcal, P:${totalProtein}g F:${totalFat}g C:${totalCarbs}g)`)
        }
      }
    }
    
    // 画像生成（オプション）
    const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
    if (GOOGLE_AI_API_KEY) {
      console.log('Starting image generation...')
      for (const day of resultJson.days) {
        for (const meal of day.meals) {
          if (meal.dishes && meal.dishes.length > 0) {
            try {
              const imageUrl = await generateMealImage(meal.dishes[0].name, userId, supabase)
              
              // 画像URLを更新
              const { data: dayData } = await supabase
                .from('meal_plan_days')
                .select('id')
                .eq('meal_plan_id', mealPlanId)
                .eq('day_date', day.date)
                .single()
              
              if (dayData) {
                await supabase
                  .from('planned_meals')
                  .update({ image_url: imageUrl })
                  .eq('meal_plan_day_id', dayData.id)
                  .eq('meal_type', meal.mealType)
                
                console.log(`✅ Image added for ${day.date} ${meal.mealType}`)
              }
            } catch (e: any) {
              console.error(`Image generation failed for ${meal.dishes[0].name}: ${e.message}`)
            }
          }
        }
      }
    }
    
    // リクエストステータスを completed に更新
    if (requestId) {
      await supabase
        .from('weekly_menu_requests')
        .update({ 
          status: 'completed', 
          updated_at: new Date().toISOString()
        })
        .eq('id', requestId)
    }
    
    console.log('✅ All meals saved to planned_meals table')
    
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`)
    
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

【仕事・生活】
- 職種: ${profile.occupation || '未設定'}
${profile.industry ? `- 業界: ${profile.industry}` : ''}
- 勤務形態: ${translateWorkStyle(profile.work_style)}
- 運動: 週${profile.weekly_exercise_minutes || 0}分
${profile.sports_activities?.length ? `- スポーツ: ${profile.sports_activities.map((s: any) => s.name).join(', ')}` : ''}

【健康状態】
${healthConditions !== 'なし' ? `- 持病・注意点: ${healthConditions}` : '- 特になし'}
${profile.sleep_quality ? `- 睡眠の質: ${translateQuality(profile.sleep_quality)}` : ''}
${profile.stress_level ? `- ストレスレベル: ${translateStress(profile.stress_level)}` : ''}
${profile.cold_sensitivity ? '- 冷え性あり' : ''}
${profile.swelling_prone ? '- むくみやすい' : ''}

【食事制限（厳守）】
- アレルギー（絶対除外）: ${allergies}
- 苦手なもの（避ける）: ${dislikes}
- 食事スタイル: ${translateDietStyle(profile.diet_style)}
${profile.religious_restrictions && profile.religious_restrictions !== 'none' ? `- 宗教的制限: ${profile.religious_restrictions}` : ''}

【嗜好】
- 好きな食材: ${favoriteIngredients}
${profile.favorite_dishes?.length ? `- 好きな料理: ${profile.favorite_dishes.join(', ')}` : ''}
${formatCuisinePreferences(profile.cuisine_preferences)}
`
}

function calculateNutritionTarget(profile: any, healthRecords?: any[], healthGoals?: any[]): any {
  // 最新の健康記録から体重を取得（あれば）
  const latestWeight = healthRecords?.find(r => r.weight)?.weight || profile.weight

  // 基礎代謝計算（Mifflin-St Jeor式）
  let bmr = 1800
  if (latestWeight && profile.height && profile.age) {
    if (profile.gender === 'male') {
      bmr = Math.round(10 * latestWeight + 6.25 * profile.height - 5 * profile.age + 5)
    } else {
      bmr = Math.round(10 * latestWeight + 6.25 * profile.height - 5 * profile.age - 161)
    }
  }

  // 活動係数（健康記録の歩数も考慮）
  let activityMultiplier = 1.2
  const weeklyExercise = profile.weekly_exercise_minutes || 0
  
  // 最近の平均歩数を計算
  const avgSteps = healthRecords?.filter(r => r.step_count)
    .reduce((sum, r, _, arr) => sum + r.step_count / arr.length, 0) || 0
  
  if (weeklyExercise > 300 || avgSteps > 12000) activityMultiplier = 1.7
  else if (weeklyExercise > 150 || avgSteps > 8000) activityMultiplier = 1.5
  else if (weeklyExercise > 60 || avgSteps > 5000) activityMultiplier = 1.4

  let tdee = bmr * activityMultiplier

  // 目標による調整
  const goals = profile.fitness_goals || []
  
  // 健康目標から体重目標を取得
  const weightGoal = healthGoals?.find(g => g.goal_type === 'weight')
  if (weightGoal && latestWeight) {
    const weightDiff = latestWeight - weightGoal.target_value
    if (weightDiff > 0) {
      // 減量が必要
      tdee -= Math.min(500, weightDiff * 50) // 最大500kcal減
    } else if (weightDiff < 0) {
      // 増量が必要
      tdee += Math.min(300, Math.abs(weightDiff) * 50)
    }
  } else if (goals.includes('lose_weight')) {
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
  } else if (goals.includes('lose_weight')) {
    proteinRatio = 0.25
    fatRatio = 0.30
    carbsRatio = 0.45
  }

  // 健康状態による調整
  const conditions = profile.health_conditions || []
  if (conditions.includes('糖尿病')) {
    carbsRatio = 0.40
    proteinRatio = 0.25
    fatRatio = 0.35
  }

  const dailyCalories = Math.max(Math.round(tdee), 1200)

  // 減塩が必要かどうかを健康記録から判断
  const avgBP = healthRecords?.filter(r => r.systolic_bp)
    .reduce((sum, r, _, arr) => sum + r.systolic_bp / arr.length, 0) || 0
  const needsLowSodium = conditions.includes('高血圧') || avgBP > 130

  return {
    dailyCalories,
    protein: Math.round((dailyCalories * proteinRatio) / 4),
    fat: Math.round((dailyCalories * fatRatio) / 9),
    carbs: Math.round((dailyCalories * carbsRatio) / 4),
    fiber: profile.gender === 'male' ? 21 : 18,
    sodium: needsLowSodium ? 1500 : 2300,
    currentWeight: latestWeight,
    targetWeight: weightGoal?.target_value,
    avgSteps,
    avgBP
  }
}

function buildHealthConstraints(profile: any, healthRecords?: any[], healthInsights?: any[]): string[] {
  const constraints: string[] = []
  const conditions = profile.health_conditions || []
  const goals = profile.fitness_goals || []

  // 既存の健康状態に基づく制約
  if (conditions.includes('高血圧')) {
    constraints.push('【高血圧】塩分6g以下、カリウム豊富な食材（バナナ、ほうれん草）を積極的に。漬物・ラーメン・カップ麺は避ける')
  }
  if (conditions.includes('糖尿病')) {
    constraints.push('【糖尿病】低GI食品中心、糖質控えめ。白米は玄米に、砂糖・ジュース・菓子パンは避ける')
  }
  if (conditions.includes('脂質異常症')) {
    constraints.push('【脂質異常症】飽和脂肪酸を減らし、オメガ3を増やす。青魚・オリーブオイル推奨。バター・生クリーム・脂身は避ける')
  }
  if (conditions.includes('貧血')) {
    constraints.push('【貧血】鉄分豊富な食材（レバー、赤身肉、ほうれん草）とビタミンCを組み合わせる')
  }
  if (conditions.includes('痛風')) {
    constraints.push('【痛風】プリン体を制限。レバー・白子・あん肝・ビールは避ける')
  }

  // 健康記録からの動的な制約
  if (healthRecords && healthRecords.length > 0) {
    // 血圧が高めの場合
    const avgSystolic = healthRecords.filter(r => r.systolic_bp)
      .reduce((sum, r, _, arr) => sum + r.systolic_bp / arr.length, 0)
    if (avgSystolic > 130 && !conditions.includes('高血圧')) {
      constraints.push('【血圧注意】最近の血圧が高めです。塩分控えめ、野菜多めの献立を心がけてください')
    }

    // 睡眠の質が低い場合
    const avgSleepQuality = healthRecords.filter(r => r.sleep_quality)
      .reduce((sum, r, _, arr) => sum + r.sleep_quality / arr.length, 0)
    if (avgSleepQuality < 3) {
      constraints.push('【睡眠サポート】睡眠の質を上げる食材（トリプトファン含有: 牛乳、バナナ、鶏肉）を夕食に取り入れてください')
    }

    // ストレスレベルが高い場合
    const avgStress = healthRecords.filter(r => r.stress_level)
      .reduce((sum, r, _, arr) => sum + r.stress_level / arr.length, 0)
    if (avgStress > 3.5) {
      constraints.push('【ストレス緩和】ビタミンB群、マグネシウム豊富な食材（玄米、ナッツ、緑黄色野菜）を積極的に')
    }

    // 体調が優れない場合
    const avgCondition = healthRecords.filter(r => r.overall_condition)
      .reduce((sum, r, _, arr) => sum + r.overall_condition / arr.length, 0)
    if (avgCondition < 3) {
      constraints.push('【体調回復】消化に優しく栄養価の高い食事を心がけてください。温かいスープや煮込み料理がおすすめ')
    }
  }

  // AI分析結果からの推奨事項を追加
  if (healthInsights && healthInsights.length > 0) {
    for (const insight of healthInsights) {
      if (insight.recommendations && insight.recommendations.length > 0) {
        const foodRelated = insight.recommendations.find((r: string) => 
          r.includes('食') || r.includes('栄養') || r.includes('塩分') || r.includes('カロリー')
        )
        if (foodRelated) {
          constraints.push(`【AI推奨】${foodRelated}`)
        }
      }
    }
  }

  // 目標に基づく制約
  if (goals.includes('improve_skin')) {
    constraints.push('【美肌】ビタミンA/C/E、コラーゲン豊富な食材（にんじん、トマト、鶏手羽）を積極的に')
  }
  if (goals.includes('gut_health')) {
    constraints.push('【腸活】食物繊維と発酵食品（ヨーグルト、納豆、キムチ、味噌）を毎食取り入れる')
  }
  if (goals.includes('build_muscle')) {
    constraints.push('【筋肉増加】高タンパク食材（鶏むね肉、卵、豆腐）を毎食。運動後は特にタンパク質を意識')
  }

  if (profile.cold_sensitivity) {
    constraints.push('【冷え性】体を温める食材（生姜、ねぎ、にんにく、根菜）を積極的に')
  }
  if (profile.swelling_prone) {
    constraints.push('【むくみ】カリウム豊富な食材（きゅうり、バナナ、アボカド）を取り入れ、塩分控えめに')
  }

  return constraints
}

function buildCookingConstraints(profile: any): string[] {
  const constraints: string[] = []
  
  constraints.push(`平日の調理時間: ${profile.weekday_cooking_minutes || 30}分以内`)
  constraints.push(`休日の調理時間: ${profile.weekend_cooking_minutes || 60}分以内`)
  constraints.push(`料理経験: ${translateCookingExperience(profile.cooking_experience)}`)
  
  if (profile.kitchen_appliances?.length) {
    constraints.push(`使用可能な調理器具: ${profile.kitchen_appliances.join(', ')}`)
  }
  
  if (profile.meal_prep_ok) {
    constraints.push('作り置きOK（週末に作り置きして平日に活用）')
  }

  return constraints
}

function mapRole(role: string | undefined): string {
  if (!role) return 'side'
  const roleMap: Record<string, string> = {
    '主菜': 'main',
    '主食': 'main',
    '主': 'main',
    'main': 'main',
    '副菜': 'side',
    '副食': 'side',
    'side': 'side',
    '汁物': 'soup',
    '味噌汁': 'soup',
    'soup': 'soup',
    'ご飯': 'rice',
    '白飯': 'rice',
    'rice': 'rice',
    'サラダ': 'salad',
    'salad': 'salad',
    'デザート': 'dessert',
    'dessert': 'dessert',
    'フルーツ': 'fruit',
    'fruit': 'fruit'
  }
  return roleMap[role] || 'side'
}

function translateGoal(goal: string): string {
  const map: Record<string, string> = {
    lose_weight: '減量',
    gain_weight: '増量',
    build_muscle: '筋肉増加',
    improve_energy: 'エネルギーUP',
    improve_skin: '美肌',
    gut_health: '腸活',
    immunity: '免疫力向上',
    focus: '集中力向上',
    anti_aging: 'アンチエイジング'
  }
  return map[goal] || goal
}

function translateWorkStyle(style: string | null): string {
  const map: Record<string, string> = {
    fulltime: 'フルタイム勤務',
    parttime: 'パートタイム',
    freelance: 'フリーランス',
    remote: 'リモートワーク',
    shift: 'シフト勤務',
    student: '学生',
    homemaker: '主婦/主夫',
    retired: '退職者'
  }
  return map[style || ''] || '未設定'
}

function translateQuality(quality: string | null): string {
  const map: Record<string, string> = { good: '良好', average: '普通', poor: '悪い' }
  return map[quality || ''] || '未設定'
}

function translateStress(stress: string | null): string {
  const map: Record<string, string> = { low: '低い', medium: '普通', high: '高い' }
  return map[stress || ''] || '未設定'
}

function translateDietStyle(style: string | null): string {
  const map: Record<string, string> = {
    normal: '通常',
    vegetarian: 'ベジタリアン',
    vegan: 'ヴィーガン',
    pescatarian: 'ペスカタリアン',
    gluten_free: 'グルテンフリー',
    keto: 'ケトジェニック'
  }
  return map[style || ''] || '通常'
}

function translateCookingExperience(exp: string | null): string {
  const map: Record<string, string> = {
    beginner: '初心者',
    intermediate: '中級者',
    advanced: '上級者'
  }
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

// 画像生成関数
async function generateMealImage(dishName: string, userId: string, supabase: any): Promise<string> {
  const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
  const GEMINI_IMAGE_MODEL = Deno.env.get('GEMINI_IMAGE_MODEL') || 'gemini-2.0-flash-exp'
  
  if (!GOOGLE_AI_API_KEY) throw new Error('Google AI API Key is missing')

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
    throw new Error(`Gemini API returned ${response.status}: ${errorText}`)
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

  if (!imageBase64) throw new Error('No image data in response')

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

  const { data: { publicUrl } } = supabase.storage
    .from('fridge-images')
    .getPublicUrl(fileName)

  return publicUrl
}
