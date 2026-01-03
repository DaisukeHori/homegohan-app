/**
 * analyze-meal-photo Edge Function (v2 - エビデンスベース)
 * 
 * Gemini 3 Pro で画像認識 → 材料マッチング → 栄養計算 → エビデンス検証
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { analyzeWithEvidence, ImageInput } from '../_shared/nutrition-pipeline.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("Analyze Meal Photo Function v2 loaded")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 認証
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

    // mealId が無い場合: 同期的に解析して結果を返す
    if (!mealId) {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      )

      // v2パイプラインで解析
      const result = await analyzeWithEvidence(imageDataArray, mealType || 'lunch', supabase)

      // 画像をStorageへアップロード
      let imageUrl: string | null = null
      const first = imageDataArray?.[0]
      if (first?.base64) {
        const binaryString = atob(first.base64)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i)

        const fileName = `meals/${user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`
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

      return new Response(JSON.stringify({ ...result, imageUrl }), {
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
    console.error('Edge function error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

async function analyzeMealPhotoBackgroundTask({ 
  images,
  mealId,
  mealType,
  userId,
  authHeader
}: {
  images: ImageInput[];
  mealId: string;
  mealType?: string;
  userId: string;
  authHeader: string;
}) {
  console.log(`Starting photo analysis v2 for mealId: ${mealId}, user: ${userId}`)
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  )

  try {
    // v2パイプラインで解析
    const result = await analyzeWithEvidence(images, mealType || 'lunch', supabase)
    console.log('Analysis result:', {
      dishes: result.dishes.length,
      totalCalories: result.totalCalories,
      confidenceScore: result.evidence.confidenceScore,
    })

    // 画像をSupabase Storageにアップロード
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

    // dishes配列を整形（v1互換 + v2拡張）
    const dishes = result.dishes.map(d => ({
      name: d.name,
      role: d.role,
      cal: d.calories_kcal,
      calories_kcal: d.calories_kcal,
      protein_g: d.protein_g,
      carbs_g: d.carbs_g,
      fat_g: d.fat_g,
      ingredient: d.ingredient,
      ingredients: d.ingredients,
    }))
    const dishName = result.dishes.map(d => d.name).join('、')
    
    // planned_mealsを更新（全栄養素）
    const { error: updateError } = await supabase
      .from('planned_meals')
      .update({
        dish_name: dishName || '写真から入力',
        dishes: dishes,
        image_url: imageUrl,
        description: result.praiseComment,
        // 基本栄養素
        calories_kcal: result.totalCalories,
        protein_g: result.totalProtein,
        fat_g: result.totalFat,
        carbs_g: result.totalCarbs,
        // 拡張栄養素
        sodium_g: result.nutrition.sodiumG,
        fiber_g: result.nutrition.fiberG,
        potassium_mg: result.nutrition.potassiumMg,
        calcium_mg: result.nutrition.calciumMg,
        phosphorus_mg: result.nutrition.phosphorusMg,
        iron_mg: result.nutrition.ironMg,
        zinc_mg: result.nutrition.zincMg,
        iodine_ug: result.nutrition.iodineUg,
        cholesterol_mg: result.nutrition.cholesterolMg,
        vitamin_a_ug: result.nutrition.vitaminAUg,
        vitamin_d_ug: result.nutrition.vitaminDUg,
        vitamin_e_mg: result.nutrition.vitaminEMg,
        vitamin_k_ug: result.nutrition.vitaminKUg,
        vitamin_b1_mg: result.nutrition.vitaminB1Mg,
        vitamin_b2_mg: result.nutrition.vitaminB2Mg,
        vitamin_b6_mg: result.nutrition.vitaminB6Mg,
        vitamin_b12_ug: result.nutrition.vitaminB12Ug,
        folic_acid_ug: result.nutrition.folicAcidUg,
        vitamin_c_mg: result.nutrition.vitaminCMg,
        magnesium_mg: result.nutrition.magnesiumMg,
        // スコア
        veg_score: result.vegScore,
        // メタデータ
        is_simple: result.dishes.length <= 1,
        mode: 'cook',
        updated_at: new Date().toISOString(),
      })
      .eq('id', mealId)

    if (updateError) throw updateError

    console.log(`✅ Photo analysis v2 completed for ${dishName}`)
    console.log(`   Confidence: ${result.evidence.confidenceScore}, Verification: ${result.evidence.verification.reason}`)

  } catch (error: any) {
    console.error(`❌ Photo analysis v2 failed:`, error.message)
  }
}
