import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("Generate Single Meal Function loaded")

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
      note = ''
    } = await req.json()

    // 非同期でバックグラウンドタスクを実行
    generateSingleMealBackgroundTask({ 
      dayDate,
      mealType, 
      userId,
      preferences,
      note
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
  note
}: any) {
  console.log(`Starting single meal generation for user: ${userId}, date: ${dayDate}, meal: ${mealType}`)
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    // 1. ユーザープロファイルを取得
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    const allergies = profile?.diet_flags?.allergies?.join(', ') || 'なし'
    const dislikes = profile?.diet_flags?.dislikes?.join(', ') || 'なし'

    // 2. OpenAI APIで料理を生成
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
    if (!OPENAI_API_KEY) throw new Error('OpenAI API Key is missing')

    const mealTypeJa = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : '夕食'
    const dayOfWeek = new Date(dayDate).toLocaleDateString('ja-JP', { weekday: 'long' })
    
    const prompt = `
あなたは一流の管理栄養士です。以下の条件で${mealTypeJa}の献立を1食分生成してください。

【条件】
- 日付: ${dayDate} (${dayOfWeek})
- 食事タイプ: ${mealTypeJa}
- アレルギー: ${allergies}
- 苦手なもの: ${dislikes}
${note ? `- ユーザーからのリクエスト: ${note}` : ''}
${preferences.quickMeals ? '- 時短メニュー（15-20分以内）' : ''}
${preferences.japaneseStyle ? '- 和食中心' : ''}
${preferences.healthy ? '- ヘルシー志向（低カロリー・高タンパク）' : ''}
${preferences.useFridgeFirst ? '- 冷蔵庫の食材を優先' : ''}

【出力形式】
以下のJSON形式で出力してください：
{
  "dishes": [
    { "name": "料理名", "role": "main", "calories": 300, "description": "簡潔な説明" },
    { "name": "副菜名", "role": "side", "calories": 50 },
    { "name": "汁物名", "role": "soup", "calories": 30 }
  ],
  "totalCalories": 380,
  "cookingTime": "20分",
  "nutritionalAdvice": "この食事のポイント"
}
`

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'あなたは一流の管理栄養士です。JSONのみを出力してください。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        response_format: { type: 'json_object' }
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI API error: ${errorText}`)
    }

    const aiResult = await response.json()
    const newMealData = JSON.parse(aiResult.choices[0].message.content)

    // 3. 画像生成（メイン料理のみ）
    let imageUrl = null
    if (newMealData.dishes && newMealData.dishes.length > 0) {
      const mainDish = newMealData.dishes[0]
      try {
        imageUrl = await generateMealImage(mainDish.name, userId, supabase)
        console.log(`✅ Image generated for ${mainDish.name}`)
      } catch (imgError: any) {
        console.warn(`⚠️ Image generation skipped: ${imgError.message}`)
      }
    }

    // 4. meal_plan_days と planned_meals に保存
    // まず、該当日のmeal_planを探すか作成
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
        })
        .select('id')
        .single()
      
      if (dayError) throw dayError
      dayId = newDay.id
    }

    // 既存のplanned_mealがあれば削除
    await supabase
      .from('planned_meals')
      .delete()
      .eq('meal_plan_day_id', dayId)
      .eq('meal_type', mealType)

    // 新しいplanned_mealを挿入（テーブル構造に合わせる）
    // planned_meals: dish_name, description, ingredients, calories_kcal, image_url, is_completed
    const mainDish = newMealData.dishes?.[0] || { name: '献立', calories: 0 }
    const allDishNames = newMealData.dishes?.map((d: any) => d.name).join('、') || mainDish.name
    const allIngredients = newMealData.dishes?.flatMap((d: any) => d.ingredients || []) || []
    
    const { error: mealError } = await supabase
      .from('planned_meals')
      .insert({
        meal_plan_day_id: dayId,
        meal_type: mealType,
        dish_name: allDishNames,
        description: newMealData.nutritionalAdvice || `${newMealData.cookingTime || ''}で作れます`,
        ingredients: allIngredients.length > 0 ? allIngredients : null,
        calories_kcal: newMealData.totalCalories || mainDish.calories || null,
        image_url: imageUrl,
        is_completed: false,
      })

    if (mealError) throw mealError

    console.log(`✅ Single meal generation completed for ${mealTypeJa} on ${dayDate}`)

  } catch (error: any) {
    console.error(`❌ Single meal generation failed:`, error.message)
  }
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
  
  console.log(`[Image Gen] Starting generation for: ${dishName}`)
  
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

