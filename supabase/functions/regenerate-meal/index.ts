import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

console.log("Regenerate Meal Function loaded")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { 
      weeklyMenuRequestId, 
      dayIndex, 
      mealType, 
      userId,
      preferences = {}
    } = await req.json()

    // 非同期でバックグラウンドタスクを実行
    regenerateMealBackgroundTask({ 
      weeklyMenuRequestId, 
      dayIndex, 
      mealType, 
      userId,
      preferences 
    }).catch((error) => {
      console.error('Background task error:', error)
    })

    return new Response(
      JSON.stringify({ message: 'Meal regeneration started in background' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

async function regenerateMealBackgroundTask({ 
  weeklyMenuRequestId, 
  dayIndex, 
  mealType, 
  userId,
  preferences 
}: any) {
  console.log(`Starting meal regeneration for request: ${weeklyMenuRequestId}, day: ${dayIndex}, meal: ${mealType}`)
  
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

    // 3. 現在の献立を取得
    const resultJson = menuRequest.result_json as any
    if (!resultJson?.days?.[dayIndex]) {
      throw new Error('Invalid menu structure')
    }

    const day = resultJson.days[dayIndex]
    const currentMeal = day.meals.find((m: any) => m.mealType === mealType)
    const currentDishes = currentMeal?.dishes?.map((d: any) => d.name).join(', ') || ''

    // 4. OpenAI APIで新しい料理を生成
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
    if (!OPENAI_API_KEY) throw new Error('OpenAI API Key is missing')

    const mealTypeJa = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : '夕食'
    
    const prompt = `
あなたは一流の管理栄養士です。以下の条件で${mealTypeJa}の献立を1食分生成してください。

【条件】
- 日付: ${day.date} (${day.dayOfWeek})
- 食事タイプ: ${mealTypeJa}
- アレルギー: ${allergies}
- 苦手なもの: ${dislikes}
- 現在の料理（これとは違うものを提案）: ${currentDishes}
${preferences.quickMeals ? '- 時短メニュー（15-20分以内）' : ''}
${preferences.japaneseStyle ? '- 和食中心' : ''}
${preferences.healthy ? '- ヘルシー志向（低カロリー・高タンパク）' : ''}

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

    // 5. 週献立を更新
    const meal = day.meals.find((m: any) => m.mealType === mealType)
    if (meal) {
      meal.dishes = newMealData.dishes
      meal.totalCalories = newMealData.totalCalories
      meal.cookingTime = newMealData.cookingTime
      meal.nutritionalAdvice = newMealData.nutritionalAdvice
      
      // 画像生成（メイン料理のみ）
      if (newMealData.dishes && newMealData.dishes.length > 0) {
        const mainDish = newMealData.dishes[0]
        try {
          const imageUrl = await generateMealImage(mainDish.name, userId, supabase)
          meal.imageUrl = imageUrl
          console.log(`✅ Image generated for ${mainDish.name}`)
        } catch (imgError: any) {
          console.warn(`⚠️ Image generation skipped: ${imgError.message}`)
        }
      }
    }

    // 6. データベースを更新
    const { error: updateError } = await supabase
      .from('weekly_menu_requests')
      .update({ 
        result_json: resultJson,
        updated_at: new Date().toISOString()
      })
      .eq('id', weeklyMenuRequestId)

    if (updateError) throw updateError

    console.log(`✅ Meal regeneration completed for ${mealTypeJa} on ${day.date}`)

  } catch (error: any) {
    console.error(`❌ Meal regeneration failed:`, error.message)
  }
}

// 画像生成関数（Gemini API - generate-weekly-menuと同じ方式）
async function generateMealImage(dishName: string, userId: string, supabase: any): Promise<string> {
  const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
  const GEMINI_IMAGE_MODEL = Deno.env.get('GEMINI_IMAGE_MODEL') || 'gemini-2.5-flash-preview-image'
  
  console.log(`[Image Gen] Starting generation for: ${dishName}`)
  console.log(`[Image Gen] API Key present: ${GOOGLE_AI_API_KEY ? 'Yes' : 'No'}`)
  console.log(`[Image Gen] Model: ${GEMINI_IMAGE_MODEL}`)
  
  if (!GOOGLE_AI_API_KEY) {
    console.error(`[Image Gen] ERROR: Google AI API Key is missing for ${dishName}`)
    throw new Error('Google AI API Key is missing in Edge Function environment')
  }

  // プロンプトの構築（generate-weekly-menuと同じ）
  const enhancedPrompt = `A delicious, appetizing, professional food photography shot of ${dishName}. Natural lighting, high resolution, minimalist plating, Japanese cuisine style.`

  try {
    // Gemini REST APIを直接呼び出し
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GOOGLE_AI_API_KEY}`
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: enhancedPrompt
          }]
        }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: '1:1'
          }
        }
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      // 429エラー（クォータ超過）の場合はスキップ
      if (response.status === 429) {
        console.warn(`Quota exceeded for image generation, skipping: ${dishName}`)
        throw new Error('QUOTA_EXCEEDED')
      }
      throw new Error(`Gemini API returned ${response.status}: ${errorText}`)
    }

    const data = await response.json()
    
    // レスポンスから画像データを抽出
    const parts = data.candidates?.[0]?.content?.parts || []
    let imageBase64 = ''
    
    for (const part of parts) {
      if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
        imageBase64 = part.inlineData.data
        break
      }
    }

    if (!imageBase64) {
      console.error(`[Image Gen] ERROR: No image data in response for ${dishName}`)
      console.error(`[Image Gen] Response structure:`, JSON.stringify(data, null, 2))
      throw new Error('No image data in response')
    }

    console.log(`[Image Gen] Image data received (${imageBase64.length} chars), uploading to Storage...`)

    // Supabase Storage へアップロード
    // base64をバイナリに変換（Deno環境用）
    const binaryString = atob(imageBase64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    
    const fileName = `generated/${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.png`
    const bucketName = 'fridge-images'
    
    console.log(`[Image Gen] Uploading to: ${bucketName}/${fileName}`)
    
    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(fileName, bytes, {
        contentType: 'image/png',
        upsert: false
      })

    if (uploadError) {
      console.error(`[Image Gen] Storage upload failed for ${dishName}:`, uploadError)
      throw new Error(`Storage upload failed: ${uploadError.message}`)
    }

    // 公開URLの取得
    const { data: { publicUrl } } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName)

    console.log(`[Image Gen] ✅ Successfully generated and uploaded image for ${dishName}: ${publicUrl}`)

    return publicUrl

  } catch (error: any) {
    console.error(`[Image Gen] ❌ Error generating image for ${dishName}:`, error.message || error)
    // エラーを再スロー（呼び出し元で処理）
    throw error
  }
}

