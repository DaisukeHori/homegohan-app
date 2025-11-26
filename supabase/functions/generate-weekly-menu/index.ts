import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

console.log("Hello from Functions!")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { userId, startDate, note, familySize, cheatDay, preferences } = await req.json()

    // 非同期でバックグラウンドタスクを実行（レスポンスをブロックしない）
    generateMenuBackgroundTask({ userId, startDate, note, familySize, cheatDay, preferences }).catch((error) => {
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

async function generateMenuBackgroundTask({ userId, startDate, note, familySize = 1, cheatDay, preferences = {} }: any) {
  console.log(`Starting generation for user: ${userId}, startDate: ${startDate}`)
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (profileError) throw new Error(`Profile not found: ${profileError.message}`)

    // 直近データの取得（planned_mealsから）
    const oneWeekAgo = new Date()
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
    const oneWeekAgoStr = oneWeekAgo.toISOString().split('T')[0]
    
    const { data: recentMeals } = await supabase
      .from('planned_meals')
      .select(`
        dish_name,
        meal_plan_days!inner(
          day_date,
          meal_plans!inner(user_id)
        )
      `)
      .eq('meal_plan_days.meal_plans.user_id', userId)
      .gte('meal_plan_days.day_date', oneWeekAgoStr)
      .limit(20)
    const recentMenus = recentMeals?.map(m => m.dish_name).filter(Boolean).join(', ') || '特になし';

    const allergies = profile.diet_flags?.allergies?.join(', ') || 'なし';
    const dislikes = profile.diet_flags?.dislikes?.join(', ') || 'なし';

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

    const prompt = `
      あなたはトップアスリートや経営者を支える超一流の「AI管理栄養士」です。
      以下のユーザー情報に基づき、**必ず7日分（1週間）の献立**をJSON形式で生成してください。

      【開始日と期間】
      - 開始日: ${startDate}
      - 以下の7日分の献立を生成してください:
        ${weekDates.map((d, i) => `${i + 1}. ${d}`).join('\n        ')}

      【ユーザー情報】
      - 年齢: ${profile.age || '不明'}歳
      - 職業: ${profile.occupation || '不明'}
      - 身長: ${profile.height || '不明'}cm
      - 体重: ${profile.weight || '不明'}kg
      - 年代/性別: ${profile.age_group} / ${profile.gender || '不明'}
      - 目標: ${profile.goal_text || '健康維持'}
      - 家族人数: ${familySize}人分
      - アレルギー（絶対除去）: ${allergies}
      - 苦手なもの（避ける）: ${dislikes}
      - チートデイ希望: ${cheatDay ? cheatDay + '曜日' : 'なし'}
      
      【直近の状況】
      - 最近食べたもの: ${recentMenus} (被りを避ける)
      - 今週のリクエスト: ${note || '特になし'}
      
      【献立スタイルの指定】
      ${preferences.useFridgeFirst ? '- 【重要】冷蔵庫にある食材を優先的に使用してください' : ''}
      ${preferences.quickMeals ? '- 【重要】時短メニュー中心（調理時間15-20分以内）で構成してください' : ''}
      ${preferences.japaneseStyle ? '- 【重要】和食を中心に構成してください（洋食・中華は控えめに）' : ''}
      ${preferences.healthy ? '- 【重要】ヘルシー志向（低カロリー・高タンパク・野菜多め）で構成してください' : ''}
      
      【生成要件 - 重要】
      1. 献立 (days): **必ず7日分（上記の7日すべて）を生成してください**
         - 各日に朝食(breakfast)、昼食(lunch)、夕食(dinner)を含める
         - 一汁三菜ベース。チートデイ以外はPFCバランス重視。
         - 各日のdateフィールドは "YYYY-MM-DD" 形式で記載

      【JSON出力スキーマ - 必ず7日分を含めること】
      {
        "days": [
          {
            "date": "YYYY-MM-DD",
            "meals": [
              { "mealType": "breakfast", "dishes": [{"name": "料理名", "role": "主食", "cal": 200}, {"name": "味噌汁", "role": "汁物", "cal": 50}] },
              { "mealType": "lunch", "dishes": [{"name": "料理名", "role": "主菜", "cal": 400}] },
              { "mealType": "dinner", "dishes": [{"name": "料理名", "role": "主菜", "cal": 500}, {"name": "副菜", "role": "副菜", "cal": 100}] }
            ]
          }
        ]
      }
      
      **重要: days配列には必ず7つのオブジェクト（7日分）を含めてください。各料理にはcal（カロリー）を含めてください。**
    `

    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are an elite nutritionist AI. Respond only in valid JSON." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
      }),
    })

    if (!aiResponse.ok) throw new Error(await aiResponse.text())

    const aiData = await aiResponse.json()
    const resultJson = JSON.parse(aiData.choices[0].message.content)

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
      .eq('week_start_date', startDate)
      .single()
    
    let mealPlanId: string
    
    if (existingPlan) {
      mealPlanId = existingPlan.id
      console.log(`Using existing meal_plan: ${mealPlanId}`)
    } else {
      const { data: newPlan, error: planError } = await supabase
        .from('meal_plans')
        .insert({
          user_id: userId,
          week_start_date: startDate,
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
            day_date: dayDate
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
        const mainDish = dishes.find((d: any) => d.role === '主菜' || d.role === '主食' || d.role === 'main') || dishes[0]
        const dishName = mainDish?.name || '献立'
        
        // dishesをDishDetail[]形式に変換
        const dishDetails = dishes.map((d: any, index: number) => ({
          name: d.name,
          role: d.role || (index === 0 ? 'main' : `side${index}`),
          cal: d.cal || 0
        }))
        
        // 総カロリーを計算
        const totalCalories = dishDetails.reduce((sum: number, d: any) => sum + (d.cal || 0), 0)
        
        const { error: mealError } = await supabase
          .from('planned_meals')
          .insert({
            meal_plan_day_id: mealPlanDayId,
            meal_type: mealType,
            mode: 'cook',
            dish_name: dishName,
            dishes: dishDetails,
            calories_kcal: totalCalories,
            is_simple: false,
            is_completed: false
          })
        
        if (mealError) {
          console.error(`Failed to insert planned_meal for ${dayDate} ${mealType}:`, mealError)
        } else {
          console.log(`✅ Saved: ${dayDate} ${mealType} - ${dishName} (${totalCalories}kcal)`)
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
              const { error: updateError } = await supabase
                .from('planned_meals')
                .update({ image_url: imageUrl })
                .eq('meal_plan_day_id', (await supabase
                  .from('meal_plan_days')
                  .select('id')
                  .eq('meal_plan_id', mealPlanId)
                  .eq('day_date', day.date)
                  .single()).data?.id)
                .eq('meal_type', meal.mealType)
              
              if (!updateError) {
                console.log(`✅ Image added for ${day.date} ${meal.mealType}`)
              }
            } catch (e: any) {
              console.error(`Image generation failed for ${meal.dishes[0].name}: ${e.message}`)
            }
          }
        }
      }
    }
    
    console.log('✅ All meals saved to planned_meals table')
    
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`)
  }
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
