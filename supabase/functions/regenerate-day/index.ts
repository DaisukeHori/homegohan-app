import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

console.log("Regenerate Day Function loaded")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { 
      weeklyMenuRequestId, 
      dayIndex, 
      userId,
      preferences = {}
    } = await req.json()

    // 非同期でバックグラウンドタスクを実行
    regenerateDayBackgroundTask({ 
      weeklyMenuRequestId, 
      dayIndex, 
      userId,
      preferences 
    }).catch((error) => {
      console.error('Background task error:', error)
    })

    return new Response(
      JSON.stringify({ message: 'Day regeneration started in background' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

async function regenerateDayBackgroundTask({ 
  weeklyMenuRequestId, 
  dayIndex, 
  userId,
  preferences 
}: any) {
  console.log(`Starting day regeneration for request: ${weeklyMenuRequestId}, day: ${dayIndex}`)
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    // 1. 週献立リクエストを取得
    const { data: menuRequest, error: menuError } = await supabase
      .from('weekly_menu_requests')
      .select('*')
      .eq('id', weeklyMenuRequestId)
      .eq('user_id', userId)
      .single()

    if (menuError || !menuRequest) {
      throw new Error('Weekly menu request not found')
    }

    // 2. ユーザープロファイルを取得
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    const allergies = profile?.diet_flags?.allergies?.join(', ') || 'なし'
    const dislikes = profile?.diet_flags?.dislikes?.join(', ') || 'なし'
    const goal = profile?.goal_text || '健康維持'

    // 3. 現在の献立を取得
    const resultJson = menuRequest.result_json as any
    if (!resultJson?.days?.[dayIndex]) {
      throw new Error('Invalid menu structure')
    }

    const day = resultJson.days[dayIndex]
    const currentMeals = day.meals.map((m: any) => 
      `${m.mealType}: ${m.dishes?.map((d: any) => d.name).join(', ')}`
    ).join('\n')

    // 4. OpenAI APIで1日分の新しい献立を生成
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
    if (!OPENAI_API_KEY) throw new Error('OpenAI API Key is missing')

    const prompt = `
あなたは一流の管理栄養士です。以下の条件で1日分の献立（朝食・昼食・夕食）を生成してください。

【条件】
- 日付: ${day.date} (${day.dayOfWeek})
- 目標: ${goal}
- アレルギー: ${allergies}
- 苦手なもの: ${dislikes}
- 現在の献立（これとは違うものを提案）:
${currentMeals}
${preferences.quickMeals ? '- 時短メニュー中心（調理時間15-20分以内）' : ''}
${preferences.japaneseStyle ? '- 和食中心' : ''}
${preferences.healthy ? '- ヘルシー志向（低カロリー・高タンパク・野菜多め）' : ''}
${preferences.useFridgeFirst ? '- 冷蔵庫の食材を優先' : ''}

【出力形式】
以下のJSON形式で出力してください：
{
  "meals": [
    {
      "mealType": "breakfast",
      "dishes": [
        { "name": "料理名", "role": "main", "calories": 200 }
      ],
      "totalCalories": 350,
      "cookingTime": "10分"
    },
    {
      "mealType": "lunch",
      "dishes": [
        { "name": "料理名", "role": "main", "calories": 400 },
        { "name": "副菜", "role": "side", "calories": 80 }
      ],
      "totalCalories": 550,
      "cookingTime": "15分"
    },
    {
      "mealType": "dinner",
      "dishes": [
        { "name": "主菜", "role": "main", "calories": 350 },
        { "name": "副菜1", "role": "side", "calories": 60 },
        { "name": "副菜2", "role": "side", "calories": 50 },
        { "name": "汁物", "role": "soup", "calories": 40 }
      ],
      "totalCalories": 500,
      "cookingTime": "30分"
    }
  ],
  "nutritionalAdvice": "この日の献立のポイント",
  "totalDayCalories": 1400
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
    const newDayData = JSON.parse(aiResult.choices[0].message.content)

    // 5. 週献立を更新
    resultJson.days[dayIndex].meals = newDayData.meals
    resultJson.days[dayIndex].nutritionalAdvice = newDayData.nutritionalAdvice

    // 6. データベースを更新
    const { error: updateError } = await supabase
      .from('weekly_menu_requests')
      .update({ 
        result_json: resultJson,
        updated_at: new Date().toISOString()
      })
      .eq('id', weeklyMenuRequestId)

    if (updateError) throw updateError

    console.log(`✅ Day regeneration completed for ${day.date}`)

  } catch (error: any) {
    console.error(`❌ Day regeneration failed:`, error.message)
  }
}

