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
以下のJSON形式で出力してください。**各料理ごとに材料とレシピと栄養素(calories, protein, fat, carbs)を含めてください**：
{
  "dishes": [
    { 
      "name": "主菜名", 
      "role": "main", 
      "nutrition": {
        "cal": 300, "protein": 20, "fat": 10, "carbs": 10, "sodium": 0.8, "sugar": 2,
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
        "cal": 50, "protein": 3, "fat": 2, "carbs": 5, "sodium": 0.3, "sugar": 1,
        "fiber": 3, "fiberSoluble": 1.0, "fiberInsoluble": 2.0,
        "potassium": 300, "calcium": 50, "phosphorus": 60, "iron": 1.0, "zinc": 0.5, "iodine": 5,
        "cholesterol": 0, "vitaminB1": 0.1, "vitaminB2": 0.15, "vitaminC": 60, "vitaminB6": 0.2,
        "vitaminB12": 0, "folicAcid": 100, "vitaminA": 80, "vitaminD": 0, "vitaminK": 150, "vitaminE": 1.5,
        "saturatedFat": 0.3, "monounsaturatedFat": 1.0, "polyunsaturatedFat": 0.5
      },
      "ingredients": ["ブロッコリー 1/2株", "オリーブオイル 小さじ1"],
      "recipeSteps": ["1. ブロッコリーを小房に分ける", "2. 茹でる", "3. オイルをかける"]
    },
    { 
      "name": "汁物名", 
      "role": "soup", 
      "nutrition": {
        "cal": 30, "protein": 2, "fat": 1, "carbs": 3, "sodium": 1.0, "sugar": 1,
        "fiber": 1, "fiberSoluble": 0.3, "fiberInsoluble": 0.7,
        "potassium": 150, "calcium": 100, "phosphorus": 80, "iron": 0.3, "zinc": 0.3, "iodine": 3,
        "cholesterol": 5, "vitaminB1": 0.05, "vitaminB2": 0.1, "vitaminC": 0, "vitaminB6": 0.05,
        "vitaminB12": 0.2, "folicAcid": 10, "vitaminA": 20, "vitaminD": 0.3, "vitaminK": 2, "vitaminE": 0.2,
        "saturatedFat": 0.5, "monounsaturatedFat": 0.3, "polyunsaturatedFat": 0.1
      },
      "ingredients": ["しめじ 50g", "牛乳 100ml", "コンソメ 小さじ1/2"],
      "recipeSteps": ["1. しめじをほぐす", "2. 鍋で煮る", "3. 牛乳を加える"]
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
    "cal": 620, "protein": 29, "fat": 13, "carbs": 73, "sodium": 2.1, "sugar": 4,
    "fiber": 6.5, "fiberSoluble": 1.8, "fiberInsoluble": 4.7,
    "potassium": 900, "calcium": 185, "phosphorus": 390, "iron": 3.5, "zinc": 4.1, "iodine": 18,
    "cholesterol": 65, "vitaminB1": 0.35, "vitaminB2": 0.47, "vitaminC": 70, "vitaminB6": 0.6,
    "vitaminB12": 0.5, "folicAcid": 135, "vitaminA": 150, "vitaminD": 0.8, "vitaminK": 157, "vitaminE": 2.5,
    "saturatedFat": 3.3, "monounsaturatedFat": 5.3, "polyunsaturatedFat": 2.6
  },
  "cookingTime": "20分",
  "nutritionalAdvice": "この食事のポイント"
}

**重要: 
- 各dishに必ずingredients（「食材名 分量」形式の配列）とrecipeSteps（番号付き手順の配列）を含めてください
- 各料理のレシピは3〜5ステップ程度で具体的に記載してください
- roleは main（主菜）, side（副菜）, soup（汁物）, rice（主食：ご飯・パン・麺等）のいずれか
- 和食には必ずご飯（rice）を含め、洋食にはパン、中華には麺やご飯を含めてください

【献立のバランスルール】
- 同じ役割（role）の料理を複数入れない（例：味噌汁と豚汁を両方入れない、ご飯とパンを両方入れない）
- 似たような調理法や味付けの料理を複数入れない（例：炒め物が2品、煮物が2品など）
- 食事全体で味・食感・温度にバリエーションを持たせる
- 例外：中華セット（ラーメン＋チャーハン）や定食スタイル（丼＋小鉢＋汁物）は食文化として自然な組み合わせ**
`

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    
    // ストリーミングモードでリクエスト
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
        stream: true,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI API error: ${errorText}`)
    }

    // ストリーミングレスポンスを読み取って結合
    let content = ""
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        
        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue
            
            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta?.content
              if (delta) {
                content += delta
              }
            } catch {
              // JSON解析エラーは無視
            }
          }
        }
      }
    }
    
    console.log('Streaming completed, content length:', content.length)
    
    // Markdownコードブロックを除去してからJSONパース
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
    
    // 配列形式でdishesを保存（各料理の材料・レシピ・栄養素を含む）
    const dishesArray = aiDishes.map((d: any) => {
      const n = d.nutrition || {}
      return {
        name: d.name,
        role: d.role || 'side',
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

    // 6. planned_mealsを更新
    const { error: updateError } = await supabase
      .from('planned_meals')
      .update({
        dish_name: allDishNames,
        description: newMealData.nutritionalAdvice || `調理時間: ${newMealData.cookingTime || ''}`,
        ingredients: allIngredients.length > 0 ? allIngredients : null,
        recipe_steps: null, // 各料理ごとのレシピはdishes内に保存
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

