import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("Regenerate Meal Direct Function loaded")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { 
      mealId,
      dayDate,
      mealType, 
      userId,
      preferences = {},
      note = '',
      requestId = null
    } = await req.json()

    // 非同期でバックグラウンドタスクを実行
    regenerateMealBackgroundTask({ 
      mealId,
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
  mealId,
  dayDate,
  mealType, 
  userId,
  preferences,
  note,
  requestId
}: any) {
  console.log(`Starting meal regeneration for mealId: ${mealId}, user: ${userId}, requestId: ${requestId}`)
  
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
    // 1. 既存の食事データを取得
    const { data: existingMeal, error: mealFetchError } = await supabase
      .from('planned_meals')
      .select('*')
      .eq('id', mealId)
      .single()

    if (mealFetchError || !existingMeal) {
      throw new Error('Meal not found')
    }

    // 2. ユーザープロファイルを取得
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    const allergies = profile?.diet_flags?.allergies?.join(', ') || 'なし'
    const dislikes = profile?.diet_flags?.dislikes?.join(', ') || 'なし'

    // 3. OpenAI APIで新しい料理を生成
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
    if (!OPENAI_API_KEY) throw new Error('OpenAI API Key is missing')

    const mealTypeJa = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : '夕食'
    const dayOfWeek = dayDate ? new Date(dayDate).toLocaleDateString('ja-JP', { weekday: 'long' }) : ''
    
    const prompt = `
あなたは一流の管理栄養士です。以下の条件で${mealTypeJa}の献立を1食分生成してください。

【重要】現在の献立「${existingMeal.dish_name}」とは異なる料理を提案してください。

【条件】
${dayDate ? `- 日付: ${dayDate} (${dayOfWeek})` : ''}
- 食事タイプ: ${mealTypeJa}
- アレルギー: ${allergies}
- 苦手なもの: ${dislikes}
${note ? `- ユーザーからのリクエスト: ${note}` : ''}
${preferences.quickMeals ? '- 時短メニュー（15-20分以内）' : ''}
${preferences.japaneseStyle ? '- 和食中心' : ''}
${preferences.healthy ? '- ヘルシー志向（低カロリー・高タンパク）' : ''}
${preferences.useFridgeFirst ? '- 冷蔵庫の食材を優先' : ''}

【出力形式】
以下のJSON形式で出力してください。**各料理ごとに材料とレシピを含めてください**：
{
  "dishes": [
    { 
      "name": "主菜名", 
      "role": "main", 
      "calories": 300, 
      "protein": 20, 
      "description": "簡潔な説明",
      "ingredients": ["鶏むね肉 200g", "玉ねぎ 1/2個", "塩 少々"],
      "recipeSteps": ["1. 鶏肉を一口大に切る", "2. フライパンで焼く", "3. 野菜と炒める"]
    },
    { 
      "name": "副菜名", 
      "role": "side", 
      "calories": 50, 
      "protein": 3,
      "ingredients": ["ブロッコリー 1/2株", "オリーブオイル 小さじ1"],
      "recipeSteps": ["1. ブロッコリーを小房に分ける", "2. 茹でる", "3. オイルをかける"]
    },
    { 
      "name": "汁物名", 
      "role": "soup", 
      "calories": 30, 
      "protein": 2,
      "ingredients": ["しめじ 50g", "牛乳 100ml", "コンソメ 小さじ1/2"],
      "recipeSteps": ["1. しめじをほぐす", "2. 鍋で煮る", "3. 牛乳を加える"]
    },
    { 
      "name": "ご飯", 
      "role": "rice", 
      "calories": 240, 
      "protein": 4,
      "ingredients": ["白米 150g（1膳）"],
      "recipeSteps": ["1. 炊飯器で炊く"]
    }
  ],
  "totalCalories": 620,
  "totalProtein": 29,
  "cookingTime": "20分",
  "nutritionalAdvice": "この食事のポイント"
}

**重要: 
- 各dishに必ずingredients（「食材名 分量」形式の配列）とrecipeSteps（番号付き手順の配列）を含めてください
- 各料理のレシピは3〜5ステップ程度で具体的に記載してください
- roleは main（主菜）, side（副菜）, soup（汁物）, rice（主食：ご飯・パン・麺等）のいずれか
- 和食には必ずご飯（rice）を含め、洋食にはパン、中華には麺やご飯を含めてください**
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
          { role: 'system', content: 'あなたは一流の管理栄養士です。JSONのみを出力してください。ナレッジベースにある献立サンプルとレシピを参照して回答してください。' },
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

    // 4. 画像生成（メイン料理のみ）
    let imageUrl = existingMeal.image_url // デフォルトは既存の画像
    if (newMealData.dishes && newMealData.dishes.length > 0) {
      const mainDish = newMealData.dishes.find((d: any) => d.role === 'main') || newMealData.dishes[0]
      try {
        imageUrl = await generateMealImage(mainDish.name, userId, supabase)
        console.log(`✅ Image generated for ${mainDish.name}`)
      } catch (imgError: any) {
        console.warn(`⚠️ Image generation skipped: ${imgError.message}`)
      }
    }

    // 5. dishes配列を作成（可変数対応・各料理にingredients/recipeSteps含む）
    const aiDishes = newMealData.dishes || []
    
    // 配列形式でdishesを保存（各料理の材料・レシピも含む）
    const dishesArray = aiDishes.map((d: any) => ({
      name: d.name,
      cal: d.calories || 0,
      protein: d.protein || 0,
      role: d.role || 'side',
      ingredient: d.description || '',
      ingredients: d.ingredients || [],
      recipeSteps: d.recipeSteps || []
    }))
    
    const mainDish = aiDishes.find((d: any) => d.role === 'main') || aiDishes[0] || { name: '献立', calories: 0 }
    const allDishNames = aiDishes.map((d: any) => d.name).join('、') || mainDish.name
    
    // 総タンパク質を計算
    const totalProtein = newMealData.totalProtein || dishesArray.reduce((sum: number, d: any) => sum + (d.protein || 0), 0)
    
    // 全料理の材料を統合（買い物リスト用）
    const allIngredients = aiDishes.flatMap((d: any) => d.ingredients || [])

    // 6. planned_mealsを更新
    const { error: updateError } = await supabase
      .from('planned_meals')
      .update({
        dish_name: allDishNames,
        description: newMealData.nutritionalAdvice || `調理時間: ${newMealData.cookingTime || ''}`,
        ingredients: allIngredients.length > 0 ? allIngredients : null,
        recipe_steps: null, // 各料理ごとのレシピはdishes内に保存
        calories_kcal: newMealData.totalCalories || mainDish.calories || null,
        protein_g: totalProtein || null,
        image_url: imageUrl,
        dishes: dishesArray.length > 0 ? dishesArray : null,
        is_simple: dishesArray.length <= 1,
        mode: 'cook',
        updated_at: new Date().toISOString(),
      })
      .eq('id', mealId)

    if (updateError) throw updateError

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

    console.log(`✅ Meal regeneration completed for ${mealTypeJa}`)

  } catch (error: any) {
    console.error(`❌ Meal regeneration failed:`, error.message)
    
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

