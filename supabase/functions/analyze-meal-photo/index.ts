import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("Analyze Meal Photo Function loaded")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { 
      imageBase64,
      mimeType,
      mealId,
      mealType,
      userId
    } = await req.json()

    // 非同期でバックグラウンドタスクを実行
    analyzeMealPhotoBackgroundTask({ 
      imageBase64,
      mimeType,
      mealId,
      mealType,
      userId
    }).catch((error) => {
      console.error('Background task error:', error)
    })

    return new Response(
      JSON.stringify({ message: 'Photo analysis started in background' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

async function analyzeMealPhotoBackgroundTask({ 
  imageBase64,
  mimeType,
  mealId,
  mealType,
  userId
}: any) {
  console.log(`Starting photo analysis for mealId: ${mealId}, user: ${userId}`)
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    // 1. Gemini Vision APIで写真を解析
    const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
    
    if (!GOOGLE_AI_API_KEY) {
      throw new Error('Google AI API Key is missing')
    }

    const mealTypeJa = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : '夕食'

    const prompt = `この${mealTypeJa}の写真を分析してください。

以下のJSON形式で、写真に写っている全ての料理を特定し、それぞれの栄養情報を推定してください：

{
  "dishes": [
    {
      "name": "料理名",
      "role": "main または side または soup または rice または salad",
      "cal": 推定カロリー（数値）,
      "ingredient": "主な食材"
    }
  ],
  "totalCalories": 合計カロリー（数値）,
  "nutritionalAdvice": "この食事についての簡単なコメント"
}

注意：
- 写真に写っている全ての料理を含めてください
- カロリーは1人前として推定してください
- roleは料理の種類に応じて適切に設定してください
- JSONのみを出力してください`

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_AI_API_KEY}`
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: imageBase64
              }
            },
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 2048,
        }
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini API error: ${errorText}`)
    }

    const data = await response.json()
    const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    
    // JSONを抽出
    const jsonMatch = textContent.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('Failed to parse AI response')
    }
    
    const analysisResult = JSON.parse(jsonMatch[0])
    console.log('Analysis result:', analysisResult)

    // 2. 写真をSupabase Storageにアップロード
    const binaryString = atob(imageBase64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    
    const fileName = `meals/${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`
    
    const { error: uploadError } = await supabase.storage
      .from('fridge-images')
      .upload(fileName, bytes, { contentType: mimeType, upsert: false })

    let imageUrl = null
    if (!uploadError) {
      const { data: { publicUrl } } = supabase.storage.from('fridge-images').getPublicUrl(fileName)
      imageUrl = publicUrl
    } else {
      console.warn('Image upload failed:', uploadError.message)
    }

    // 3. dishes配列を整形
    const dishes = analysisResult.dishes || []
    const dishName = dishes.map((d: any) => d.name).join('、')
    
    // 4. planned_mealsを更新
    const { error: updateError } = await supabase
      .from('planned_meals')
      .update({
        dish_name: dishName || '写真から入力',
        dishes: dishes,
        calories_kcal: analysisResult.totalCalories || null,
        description: analysisResult.nutritionalAdvice || null,
        image_url: imageUrl,
        is_simple: dishes.length <= 1,
        mode: 'cook',
        updated_at: new Date().toISOString(),
      })
      .eq('id', mealId)

    if (updateError) throw updateError

    console.log(`✅ Photo analysis completed for ${mealTypeJa}`)

  } catch (error: any) {
    console.error(`❌ Photo analysis failed:`, error.message)
  }
}

