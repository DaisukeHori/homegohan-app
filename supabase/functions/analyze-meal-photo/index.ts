import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("Analyze Meal Photo Function loaded")

type ImageInput = { base64: string; mimeType: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 認証（verify_jwt=true だが、Authorizationヘッダは以降の処理でも使うため明示的に必須化）
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Authorization header required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }

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

    const body = await req.json()
    const { images, imageBase64, mimeType, mealId, mealType } = body as {
      images?: ImageInput[];
      imageBase64?: string;
      mimeType?: string;
      mealId?: string;
      mealType?: string;
    }

    const imageDataArray: ImageInput[] =
      (Array.isArray(images) && images.length > 0)
        ? images
        : (imageBase64 ? [{ base64: imageBase64, mimeType: mimeType || 'image/jpeg' }] : [])

    if (imageDataArray.length === 0) {
      return new Response(JSON.stringify({ error: 'Image is required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // mealId が無い場合: 同期的に解析して結果を返す（モバイル/カメラ入力用）
    if (!mealId) {
      const result = await analyzeMealPhotoSync({
        images: imageDataArray,
        mealType,
        userId: user.id,
        authHeader,
      })

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // 非同期でバックグラウンドタスクを実行
    analyzeMealPhotoBackgroundTask({ 
      images: imageDataArray,
      mealId,
      mealType,
      userId: user.id,
      authHeader
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

async function analyzeMealPhotoSync({
  images,
  mealType,
  userId,
  authHeader,
}: {
  images: ImageInput[];
  mealType?: string;
  userId: string;
  authHeader: string;
}) {
  // ユーザーJWTで動作（RLSでユーザー自身のデータのみアクセス）
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  )

  const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
  if (!GOOGLE_AI_API_KEY) throw new Error('Google AI API Key is missing')

  const mealTypeJa = mealType === 'breakfast' ? '朝食'
    : mealType === 'lunch' ? '昼食'
    : mealType === 'dinner' ? '夕食'
    : mealType === 'snack' ? 'おやつ'
    : mealType === 'midnight_snack' ? '夜食'
    : '食事'

  const imageCountText = images.length > 1 ? `${images.length}枚の` : ''
  const prompt = `あなたは「ほめゴハン」という食事管理アプリのAIアシスタントです。
ユーザーの食事を分析し、**良いところを見つけて褒める**ことが最も重要な役割です。

この${imageCountText}${mealTypeJa}の写真を分析してください。

以下のJSON形式で回答してください：

{
  "dishes": [
    {
      "name": "料理名",
      "role": "main または side または soup または rice または salad または dessert",
      "cal": 推定カロリー（数値）,
      "protein": 推定タンパク質（g、数値）,
      "carbs": 推定炭水化物（g、数値）,
      "fat": 推定脂質（g、数値）,
      "ingredient": "主な食材"
    }
  ],
  "totalCalories": 合計カロリー（数値）,
  "totalProtein": 合計タンパク質（g、数値）,
  "totalCarbs": 合計炭水化物（g、数値）,
  "totalFat": 合計脂質（g、数値）,
  "nutrition": {
    "sodium_g": ナトリウム（塩分）g,
    "amino_acid_g": アミノ酸 g（タンパク質とほぼ同等）,
    "sugar_g": 糖質 g,
    "fiber_g": 食物繊維 g,
    "fiber_soluble_g": 水溶性食物繊維 g,
    "fiber_insoluble_g": 不溶性食物繊維 g,
    "potassium_mg": カリウム mg,
    "calcium_mg": カルシウム mg,
    "phosphorus_mg": リン mg,
    "iron_mg": 鉄分 mg,
    "zinc_mg": 亜鉛 mg,
    "iodine_ug": ヨウ素 µg,
    "cholesterol_mg": コレステロール mg,
    "vitamin_b1_mg": ビタミンB1 mg,
    "vitamin_b2_mg": ビタミンB2 mg,
    "vitamin_c_mg": ビタミンC mg,
    "vitamin_b6_mg": ビタミンB6 mg,
    "vitamin_b12_ug": ビタミンB12 µg,
    "folic_acid_ug": 葉酸 µg,
    "vitamin_a_ug": ビタミンA µg,
    "vitamin_d_ug": ビタミンD µg,
    "vitamin_k_ug": ビタミンK µg,
    "vitamin_e_mg": ビタミンE mg,
    "saturated_fat_g": 飽和脂肪酸 g,
    "monounsaturated_fat_g": 一価不飽和脂肪酸 g,
    "polyunsaturated_fat_g": 多価不飽和脂肪酸 g
  },
  "overallScore": 総合スコア（0-100の数値）,
  "vegScore": 野菜スコア（0-100の数値）,
  "praiseComment": "この食事の良いところを見つけて褒めるコメント（80-120文字程度）",
  "nutritionTip": "この食事に関連する豆知識（40-60文字程度）"
}

注意：
- 全ての写真に写っている全ての料理を含めてください
- カロリー・栄養素は1人前として推定してください
- roleは適切に設定してください（主菜=main, 副菜=side, 汁物=soup, ご飯類=rice, サラダ=salad, デザート/おやつ=dessert）
- praiseCommentは必ずポジティブ。批判や改善提案は含めない
- overallScoreは厳しすぎず、70-95の範囲で評価（普通の食事でも75以上）
- JSONのみを出力してください`

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_AI_API_KEY}`

  const parts: any[] = images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } }))
  parts.push({ text: prompt })

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini API error: ${errorText}`)
  }

  const data = await response.json()
  const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const jsonMatch = textContent.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse AI response')
  const analysisResult = JSON.parse(jsonMatch[0])

  // 画像をStorageへアップロード（最初の1枚）
  let imageUrl: string | null = null
  const first = images?.[0]
  if (first?.base64) {
    const binaryString = atob(first.base64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i)

    const fileName = `meals/${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`
    const { error: uploadError } = await supabase.storage
      .from('fridge-images')
      .upload(fileName, bytes, { contentType: first.mimeType || 'image/jpeg', upsert: false })

    if (!uploadError) {
      const { data: { publicUrl } } = supabase.storage.from('fridge-images').getPublicUrl(fileName)
      imageUrl = publicUrl
    } else {
      console.warn('Image upload failed:', uploadError.message)
    }
  }

  const nutrition = analysisResult.nutrition || {}

  return {
    dishes: analysisResult.dishes || [],
    totalCalories: analysisResult.totalCalories || 0,
    totalProtein: analysisResult.totalProtein || 0,
    totalCarbs: analysisResult.totalCarbs || 0,
    totalFat: analysisResult.totalFat || 0,
    nutrition: {
      sodiumG: nutrition.sodium_g || 0,
      aminoAcidG: nutrition.amino_acid_g || 0,
      sugarG: nutrition.sugar_g || 0,
      fiberG: nutrition.fiber_g || 0,
      fiberSolubleG: nutrition.fiber_soluble_g || 0,
      fiberInsolubleG: nutrition.fiber_insoluble_g || 0,
      potassiumMg: nutrition.potassium_mg || 0,
      calciumMg: nutrition.calcium_mg || 0,
      phosphorusMg: nutrition.phosphorus_mg || 0,
      ironMg: nutrition.iron_mg || 0,
      zincMg: nutrition.zinc_mg || 0,
      iodineUg: nutrition.iodine_ug || 0,
      cholesterolMg: nutrition.cholesterol_mg || 0,
      vitaminB1Mg: nutrition.vitamin_b1_mg || 0,
      vitaminB2Mg: nutrition.vitamin_b2_mg || 0,
      vitaminCMg: nutrition.vitamin_c_mg || 0,
      vitaminB6Mg: nutrition.vitamin_b6_mg || 0,
      vitaminB12Ug: nutrition.vitamin_b12_ug || 0,
      folicAcidUg: nutrition.folic_acid_ug || 0,
      vitaminAUg: nutrition.vitamin_a_ug || 0,
      vitaminDUg: nutrition.vitamin_d_ug || 0,
      vitaminKUg: nutrition.vitamin_k_ug || 0,
      vitaminEMg: nutrition.vitamin_e_mg || 0,
      saturatedFatG: nutrition.saturated_fat_g || 0,
      monounsaturatedFatG: nutrition.monounsaturated_fat_g || 0,
      polyunsaturatedFatG: nutrition.polyunsaturated_fat_g || 0,
    },
    overallScore: analysisResult.overallScore || 75,
    vegScore: analysisResult.vegScore || 50,
    praiseComment: analysisResult.praiseComment || 'おいしそうな食事ですね！',
    nutritionTip: analysisResult.nutritionTip || '',
    nutritionalAdvice: analysisResult.praiseComment || analysisResult.nutritionalAdvice || '',
    imageUrl,
  }
}

async function analyzeMealPhotoBackgroundTask({ 
  images,
  mealId,
  mealType,
  userId,
  authHeader
}: any) {
  console.log(`Starting photo analysis for mealId: ${mealId}, user: ${userId}`)
  
  // ユーザーJWTで動作（RLSでユーザー自身のデータ以外は更新できない）
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
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
    
    const parts: any[] = (images || []).map((img: any) => ({
      inlineData: { mimeType: img.mimeType, data: img.base64 }
    }))
    parts.push({ text: prompt })

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts
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
    const first = images?.[0]
    const imageBase64 = first?.base64
    const mimeType = first?.mimeType || 'image/jpeg'
    if (!imageBase64) throw new Error('Image is required')

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

