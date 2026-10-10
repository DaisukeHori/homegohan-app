/**
 * analyze-meal-photo Edge Function (v2 - エビデンスベース)
 * 
 * Gemini 3 Pro で画像認識 → 材料マッチング → 栄養計算 → エビデンス検証
 */

import { createClient } from "@supabase/supabase-js";
import { analyzeWithEvidence, ImageInput, GeminiAnalysisResult } from '../_shared/nutrition-pipeline.ts'
import { buildPhotoDishList } from '../_shared/meal-image.ts'
import { cancelPendingMealImageJobs } from '../_shared/meal-image-jobs.ts'
import { buildPhotoOverwriteNutrition } from '../_shared/meal-photo-update.ts'
import { createLogger } from '../_shared/db-logger.ts'
import { getCorsHeaders } from '../_shared/cors.ts'
import { recordEdgeAiUsage } from '../_shared/ai-usage.ts'
import { requireAiConsentForUser } from '../_shared/ai-consent-guard.ts'

console.log("Analyze Meal Photo Function v2 loaded")

Deno.serve(async (req) => {
  // 許可したオリジンにだけ CORS ヘッダーを付ける (#1167)
  const corsHeaders = getCorsHeaders(req)

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

    // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)。
    // この関数は利用者の JWT で直接呼べるので、Next.js の API Route とは別にここでも止める
    const aiConsentDenied = await requireAiConsentForUser(user.id, corsHeaders)
    if (aiConsentDenied) return aiConsentDenied

    const body = await req.json()
    const { images, imageBase64, mimeType, mealId, mealType, prefetchedGeminiResult } = body as {
      images?: ImageInput[];
      imageBase64?: string;
      mimeType?: string;
      mealId?: string;
      mealType?: string;
      prefetchedGeminiResult?: GeminiAnalysisResult;
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

    // #1177 AI 利用回数の記録。AI へ送る直前 (入力の検証・同意などの判定のあと) に記録する。
    // Next.js を経由せず JWT で直接呼ばれた場合だけ記録する (Next.js が記録済みの印があれば記録しない。失敗しても止めない)
    await recordEdgeAiUsage(req, user.id, 'photo_analysis')

    // mealId が無い場合: 同期的に解析して結果を返す
    if (!mealId) {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      )

      // v2パイプラインで解析
      const result = await analyzeWithEvidence(imageDataArray, mealType || 'lunch', supabase, prefetchedGeminiResult)

      // 画像をStorageへアップロード
      let imageUrl: string | null = null
      const first = imageDataArray?.[0]
      if (first?.base64) {
        const binaryString = atob(first.base64)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i)

        // 本人のフォルダ <user_id>/meals/ の下に保存する (storage.objects の RLS が本人のフォルダだけを許可する)
        const fileName = `${user.id}/meals/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`
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

    // 非同期でバックグラウンドタスクを実行（EdgeRuntime.waitUntil で Edge が早期終了しないよう登録）
    const backgroundPromise = analyzeMealPhotoBackgroundTask({
      images: imageDataArray,
      mealId,
      mealType,
      prefetchedGeminiResult,
      userId: user.id,
      authHeader
    }).catch((error) => {
      console.error('Background task error:', error)
    })

    // @ts-ignore EdgeRuntime
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(backgroundPromise)
    }

    return new Response(
      JSON.stringify({ message: 'Photo analysis started in background' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Edge function error:', error)
    createLogger('analyze-meal-photo').error('ハンドラでエラーが発生しました', error)
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
  prefetchedGeminiResult,
  userId,
  authHeader
}: {
  images: ImageInput[];
  mealId: string;
  mealType?: string;
  prefetchedGeminiResult?: GeminiAnalysisResult;
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
    const result = await analyzeWithEvidence(images, mealType || 'lunch', supabase, prefetchedGeminiResult)
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
    
    // 本人のフォルダ <user_id>/meals/ の下に保存する (storage.objects の RLS が本人のフォルダだけを許可する)
    const fileName = `${userId}/meals/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`
    
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
    const photoDishes = buildPhotoDishList(dishes, imageUrl)
    const dishName = result.dishes.map(d => d.name).join('、')
    
    // planned_mealsを更新（全栄養素）
    try {
      await cancelPendingMealImageJobs({
        supabase,
        plannedMealId: mealId,
        reason: 'photo overwrite',
      })
    } catch (cancelError) {
      console.warn('Failed to cancel pending meal image jobs for photo update:', cancelError)
    }

    const { error: updateError } = await supabase
      .from('planned_meals')
      .update({
      dish_name: dishName || '写真から入力',
      dishes: photoDishes,
        image_url: imageUrl,
        description: result.praiseComment,
        // 栄養素 (基本・拡張・糖質)。書く列は meal-photo-update.ts に集約している。
        // 糖質 (sugar_g) を炭水化物・食物繊維と一緒に上書きしないと、上書き前の AI 献立の古い糖質が残る (#1146)
        ...buildPhotoOverwriteNutrition(result),
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
    createLogger('analyze-meal-photo').withUser(userId).error(
      '写真解析バックグラウンドタスクでエラーが発生しました',
      error,
      { mealId, mealType },
    )
  }
}
