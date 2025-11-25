import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

console.log("Hello from Functions!")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // request param に familySize, cheatDay を追加
    const { recordId, userId, startDate, note, familySize, cheatDay } = await req.json()

    // 非同期でバックグラウンドタスクを実行（レスポンスをブロックしない）
    generateMenuBackgroundTask({ recordId, userId, startDate, note, familySize, cheatDay }).catch((error) => {
      console.error('Background task error:', error)
    })

    return new Response(
      JSON.stringify({ message: 'Menu generation started in background' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

async function generateMenuBackgroundTask({ recordId, userId, startDate, note, familySize = 1, cheatDay }: any) {
  console.log(`Starting generation for request: ${recordId}`)
  
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

    // 直近データの取得（省略可能だが精度向上のため維持）
    const oneWeekAgo = new Date()
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
    const { data: recentMeals } = await supabase
      .from('meals')
      .select('memo')
      .eq('user_id', userId)
      .gte('created_at', oneWeekAgo.toISOString())
      .limit(20)
    const recentMenus = recentMeals?.map(m => m.memo).filter(Boolean).join(', ') || '特になし';

    const allergies = profile.diet_flags?.allergies?.join(', ') || 'なし';
    const dislikes = profile.diet_flags?.dislikes?.join(', ') || 'なし';

    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
    if (!OPENAI_API_KEY) throw new Error('OpenAI API Key is missing')

    // startDateから7日分の日付を生成
    const start = new Date(startDate)
    const weekDates: string[] = []
    const weekDays: string[] = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日']
    const weekDaysEn: string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(start)
      date.setDate(start.getDate() + i)
      const dateStr = date.toISOString().split('T')[0]
      const dayIndex = date.getDay()
      weekDates.push(`${dateStr} (${weekDays[dayIndex]})`)
    }

    const prompt = `
      あなたはトップアスリートや経営者を支える超一流の「AI管理栄養士」です。
      以下のユーザー情報に基づき、**必ず7日分（1週間）の献立**、買い物リスト、そして未来予測レポートをJSON形式で生成してください。

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
      - 家族人数: ${familySize}人分 (買い物リストはこの人数分で計算)
      - アレルギー（絶対除去）: ${allergies}
      - 苦手なもの（避ける）: ${dislikes}
      - チートデイ希望: ${cheatDay ? cheatDay + '曜日' : 'なし'} (この日は好きなものを食べて良い設定とし、前後で調整)
      
      【直近の状況】
      - 最近食べたもの: ${recentMenus} (被りを避ける)
      - 今週のリクエスト: ${note || '特になし'}
      
      【生成要件 - 重要】
      1. 献立 (days): **必ず7日分（上記の7日すべて）を生成してください**
         - 各日に朝食(breakfast)、昼食(lunch)、夕食(dinner)を含める
         - 一汁三菜ベース。チートデイ以外はPFCバランス重視。
         - チートデイは「ストレス解消」をテーマに少し豪華またはジャンキーでも可。
         - 各日のdateフィールドは "YYYY-MM-DD" 形式で、dayOfWeekは英語（Monday, Tuesday等）で記載
      
      2. 買い物リスト (shoppingList):
         - ${familySize}人分の分量を概算して記載 (例: "鶏もも肉 2枚(600g)")。
         - カテゴリ別に分類。

      3. 未来予測 (projectedImpact):
         - この献立を1週間続けた場合の「期待される効果」をシミュレーション。
         - 体重変化予測、肌質、集中力、睡眠の質などへの影響をポジティブに記述。

      【JSON出力スキーマ - 必ず7日分を含めること】
      {
        "days": [
          {
            "date": "YYYY-MM-DD",
            "dayOfWeek": "Monday",
            "isCheatDay": false,
            "meals": [
              { "mealType": "breakfast", "dishes": [{"name": "料理名", "role": "主食"}, {"name": "味噌汁", "role": "汁物"}] },
              { "mealType": "lunch", "dishes": [{"name": "料理名", "role": "主菜"}] },
              { "mealType": "dinner", "dishes": [{"name": "料理名", "role": "主菜"}] }
            ],
            "nutritionalAdvice": "アドバイス"
          },
          ... (必ず7日分すべてを含める)
        ],
        "shoppingList": [
          { "category": "野菜", "items": ["キャベツ 1玉", "..."] }
        ],
        "projectedImpact": {
          "weightChange": "-0.5kg",
          "energyLevel": "High",
          "skinCondition": "Improved",
          "comment": "ビタミンB群が豊富で、週末には疲労回復が実感できるでしょう。"
        }
      }
      
      **重要: days配列には必ず7つのオブジェクト（7日分）を含めてください。**
    `

    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
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
      throw new Error(`Invalid response: Expected 7 days, but got ${resultJson.days?.length || 0} days. Please regenerate.`)
    }

    // 各日に必要なmealTypeが含まれているか確認
    const requiredMealTypes = ['breakfast', 'lunch', 'dinner']
    for (let i = 0; i < resultJson.days.length; i++) {
      const day = resultJson.days[i]
      if (!day.meals || !Array.isArray(day.meals)) {
        throw new Error(`Day ${i + 1} is missing meals array`)
      }
      const mealTypes = day.meals.map((m: any) => m.mealType)
      for (const required of requiredMealTypes) {
        if (!mealTypes.includes(required)) {
          console.warn(`Day ${i + 1} is missing ${required} meal`)
        }
      }
    }

    // 画像生成: 各日の各食事のメイン料理の画像を生成
    console.log('Starting image generation for meals...')
    const imageGenerationPromises: Promise<void>[] = []
    let imageCount = 0
    let failedCount = 0
    const totalMeals = resultJson.days.reduce((sum: number, day: any) => sum + (day.meals?.length || 0), 0)
    
    console.log(`Total meals to generate images for: ${totalMeals}`)
    
    // 環境変数の確認
    const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
    if (!GOOGLE_AI_API_KEY) {
      console.warn('WARNING: Google AI API Key not found in Edge Function environment variables. Image generation will be skipped.')
      console.warn('Please set GOOGLE_AI_STUDIO_API_KEY in Supabase Dashboard → Edge Functions → Settings → Secrets')
    } else {
      console.log('Google AI API Key found, proceeding with image generation...')
    }
    
    for (const day of resultJson.days) {
      for (const meal of day.meals) {
        if (meal.dishes && meal.dishes.length > 0) {
          const dishName = meal.dishes[0].name
          // 画像生成を非同期で実行（並列処理）
          imageGenerationPromises.push(
            generateMealImage(dishName, userId, supabase)
              .then((imageUrl) => {
                // 画像URLをmealオブジェクトに追加
                meal.imageUrl = imageUrl
                imageCount++
                console.log(`[${imageCount}/${totalMeals}] ✅ Generated image for "${dishName}": ${imageUrl}`)
              })
              .catch((error) => {
                failedCount++
                const errorMsg = error.message || String(error)
                console.error(`[${failedCount} failed] ❌ Failed to generate image for "${dishName}": ${errorMsg}`)
                // 画像生成に失敗しても献立生成は続行（画像なしで保存）
                // meal.imageUrl は undefined のまま
              })
          )
        }
      }
    }
    
    // すべての画像生成が完了するまで待つ
    if (imageGenerationPromises.length > 0) {
      console.log(`Waiting for ${imageGenerationPromises.length} image generations...`)
      await Promise.allSettled(imageGenerationPromises)
      console.log(`Image generation summary: ${imageCount} succeeded, ${failedCount} failed out of ${totalMeals} total`)
    } else {
      console.log('No images to generate (no meals found)')
    }

    const { error: updateError } = await supabase
      .from('weekly_menu_requests')
      .update({
        status: 'completed',
        result_json: resultJson,
        updated_at: new Date().toISOString(),
      })
      .eq('id', recordId)

    if (updateError) throw updateError
    
  } catch (error: any) {
    console.error(`Error: ${error.message}`)
    await supabase
      .from('weekly_menu_requests')
      .update({ status: 'failed', error_message: error.message })
      .eq('id', recordId)
  }
}

// 画像生成関数
async function generateMealImage(dishName: string, userId: string, supabase: any): Promise<string> {
  const GOOGLE_AI_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
  
  // 正しいモデル名: 画像生成をサポートしているモデルを使用
  // エラー: gemini-2.5-flash-preview-image は存在しない
  // 実際には、Gemini APIの画像生成機能は限定的で、Imagen APIを使用する必要がある可能性があります
  // 一時的に画像生成をスキップし、プレースホルダー画像を使用するか、
  // Imagen APIに切り替える必要があります
  // デフォルトモデル名を空にして、エラー時にスキップする
  const GEMINI_IMAGE_MODEL = Deno.env.get('GEMINI_IMAGE_MODEL') || ''
  
  console.log(`[Image Gen] Starting generation for: ${dishName}`)
  console.log(`[Image Gen] API Key present: ${GOOGLE_AI_API_KEY ? 'Yes' : 'No'}`)
  console.log(`[Image Gen] Model: ${GEMINI_IMAGE_MODEL || 'NOT_SET'}`)
  
  // モデル名が設定されていない場合、画像生成をスキップ
  if (!GEMINI_IMAGE_MODEL) {
    console.warn(`[Image Gen] WARNING: GEMINI_IMAGE_MODEL not set. Image generation will be skipped.`)
    console.warn(`[Image Gen] Please set GEMINI_IMAGE_MODEL environment variable to a valid image generation model name.`)
    console.warn(`[Image Gen] Note: Gemini API may not support image generation. Consider using Imagen API instead.`)
    throw new Error('IMAGE_GENERATION_SKIPPED: Model not configured. Please set GEMINI_IMAGE_MODEL or use Imagen API.')
  }
  
  if (!GOOGLE_AI_API_KEY) {
    console.error(`[Image Gen] ERROR: Google AI API Key is missing for ${dishName}`)
    throw new Error('Google AI API Key is missing in Edge Function environment')
  }

  // プロンプトの構築
  const enhancedPrompt = `A delicious, appetizing, professional food photography shot of ${dishName}. Natural lighting, high resolution, minimalist plating, Japanese cuisine style.`

  try {
    // まず、利用可能なモデルをリストアップして確認（デバッグ用）
    // 実際の画像生成には、Imagen APIまたは画像生成をサポートしているモデルが必要です
    // 一時的に画像生成をスキップし、プレースホルダー画像を使用するか、
    // Imagen APIに切り替える必要があります
    
    // Gemini REST APIを直接呼び出し（画像生成をサポートしているモデルの場合）
    // 注意: 現在のGemini APIでは画像生成がサポートされていない可能性が高いです
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
      // 404エラー（モデルが見つからない）の場合
      if (response.status === 404) {
        console.error(`[Image Gen] Model not found: ${GEMINI_IMAGE_MODEL}`)
        console.error(`[Image Gen] Error details: ${errorText}`)
        // 画像生成をスキップし、プレースホルダー画像URLを返す
        // または、Imagen APIに切り替える必要があります
        throw new Error(`MODEL_NOT_FOUND: ${GEMINI_IMAGE_MODEL} does not support image generation. Please use Imagen API or a model that supports image generation.`)
      }
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
