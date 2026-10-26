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
import { claimPhotoAnalysis, isPhotoAnalysisCurrent, parseInvokedAt } from '../_shared/meal-photo-cas.ts'
import { createLogger } from '../_shared/db-logger.ts'
import { getCorsHeaders } from '../_shared/cors.ts'
import { aiDailyLimitEdgeResponse, consumeEdgeAiUsage } from '../_shared/ai-usage.ts'
import { requireAiConsentForUser } from '../_shared/ai-consent-guard.ts'

/**
 * 写真の解析の対象の献立が、本人の行として見つからない (他人の mealId・消えた献立)。#2025。
 * 値は packages/shared/src/planned-meals-integrity.ts の PLANNED_MEAL_NOT_FOUND_CODE と同じ
 * (Edge は packages/shared を import しない。一致は tests/veg-score-scale-contract.test.ts が見る)
 */
const PLANNED_MEAL_NOT_FOUND_CODE = 'PLANNED_MEAL_NOT_FOUND'

/** 400: 本文の invokedAt (Next.js の route が Edge を呼ぶ直前に付けた要求の印の時刻) が日時として読めない */
const INVALID_INVOKED_AT_MESSAGE = 'invokedAt must be an ISO 8601 date-time'

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
    const { images, imageBase64, mimeType, mealId, mealType, prefetchedGeminiResult, invokedAt } = body as {
      images?: ImageInput[];
      imageBase64?: string;
      mimeType?: string;
      mealId?: string;
      mealType?: string;
      prefetchedGeminiResult?: GeminiAnalysisResult;
      invokedAt?: unknown;
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

    // mealId の経路の invokedAt (#121。route が付けた要求の印 = DB の updated_at。#2050)。書き込みの順序の守り (_shared/meal-photo-cas.ts) に使う。
    // マイクロ秒まで読む。読めなければ数える前に 400
    const parsedInvokedAt = parseInvokedAt(mealId ? invokedAt : undefined)
    if (!parsedInvokedAt.ok) {
      return new Response(JSON.stringify({ error: INVALID_INVOKED_AT_MESSAGE }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // #1149 AI の利用回数の上限の判定と記録 (#1177)。AI へ送る直前 (入力の検証・同意などの判定のあと) に数える。
    // Next.js を経由せず JWT で直接呼ばれた場合だけ数える (Next.js が数え済みの印があれば数えない)。
    // 上限に達していれば数えずに 429 AI_DAILY_LIMIT (判定に失敗したときは止めない)
    const aiUsage = await consumeEdgeAiUsage(req, user.id, 'photo_analysis')
    if (!aiUsage.allowed) return aiDailyLimitEdgeResponse(aiUsage, corsHeaders)

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
    // mealId の経路は planned_meals (veg_score を含む) に書くので、利用者が送った解析の結果 (prefetchedGeminiResult) を使わず、
    // 写真から解析し直す。料理と材料の g を利用者が指定できると veg_score を好きな値にできる (#2025)
    const backgroundPromise = analyzeMealPhotoBackgroundTask({
      images: imageDataArray,
      mealId,
      mealType,
      userId: user.id,
      authHeader,
      invokedAt: parsedInvokedAt.invokedAt,
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
  userId,
  authHeader,
  invokedAt,
}: {
  images: ImageInput[];
  mealId: string;
  mealType?: string;
  userId: string;
  authHeader: string;
  /** Next.js の route が Edge を呼ぶ直前に付けた要求の印 (DB の updated_at。ISO 8601・マイクロ秒まで。#2050)。利用者の JWT で直接呼んだときは null */
  invokedAt: string | null;
}) {
  console.log(`Starting photo analysis v2 for mealId: ${mealId}, user: ${userId}`)
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  )

  try {
    // planned_meals の書き込みは service_role の client (queueDb) で行う。利用者の権限では veg_score を書けない (#2025)。
    // service_role は RLS を通らないので、印を付ける前・書く前に本人の行であることを必ず確かめる (save-meal.ts の「最終防衛線」と同じ考え)。
    // 鍵が無いと createClient が投げ、外側の catch がログに残す (解析も書き込みもしない)。
    // 変数名 queueDb は今の取り消しの client と同じ (tests/ai-queue-writes-contract.test.ts がこの名前で取り消しの client を見る)
    const queueDb = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SERVICE_ROLE_JWT') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // 本人の行か (user_daily_meals.user_id = userId)。無ければ印も付けずに終える (他人の mealId・消えた献立)
    const { data: owned, error: ownedError } = await queueDb
      .from('planned_meals')
      .select('id, user_daily_meals!inner(user_id)')
      .eq('id', mealId)
      .eq('user_daily_meals.user_id', userId)
      .maybeSingle()
    if (ownedError) throw ownedError
    if (!owned) throw new Error(PLANNED_MEAL_NOT_FOUND_CODE)

    // 書き込みの順序の守り (#121 の CAS。_shared/meal-photo-cas.ts)。解析の前に行に印を付ける (updated_at を進める)。
    // invokedAt は Next.js の route が Edge を呼ぶ直前に付けた要求の印 (DB の updated_at)。後から送った要求の印・後から送った解析の印が
    // この印を消す (または付けさせない) ので、終わる順番・Edge の動き出す順番によらず、最後に送った写真の結果だけが残る (#2050)。
    // invokedAt のあとに行が書かれていたら、この要求は古いので解析せずに終える
    const claim = await claimPhotoAnalysis(queueDb, { mealId, invokedAt })
    if (claim.status === 'superseded') {
      console.warn('Photo analysis skipped: the meal was updated after this request was invoked', { mealId, invokedAt })
      return
    }

    // v2パイプラインで解析 (mealId の経路は Gemini で認識する。利用者が送った解析の結果を使わない。#2025)
    const result = await analyzeWithEvidence(images, mealType || 'lunch', supabase)
    console.log('Analysis result:', {
      dishes: result.dishes.length,
      totalCalories: result.totalCalories,
      confidenceScore: result.evidence.confidenceScore,
    })

    // 解析のあいだに、後から送った解析が印を付けた・ほかの書き手が行を書いたなら、アップロードも取り消しも書き込みもしない
    if (!(await isPhotoAnalysisCurrent(queueDb, { mealId, token: claim.token }))) {
      console.warn('Photo analysis result discarded: the meal was updated during the analysis', { mealId, invokedAt })
      return
    }

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
    
    try {
      // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。本人 (JWT で確かめた userId) の行に絞って service role で取り消す。
      // 取り消しの失敗は今までどおり警告だけにして、写真の上書きは続ける
      await cancelPendingMealImageJobs({
        supabase: queueDb,
        userId,
        plannedMealId: mealId,
        reason: 'photo overwrite',
      })
    } catch (cancelError) {
      console.warn('Failed to cancel pending meal image jobs for photo update:', cancelError)
    }

    // updated_at が印のままの行にだけ書く (確かめてから書くまでのあいだに書かれた場合も、ここで止まる)。本人の行は上で確かめてある
    const { data: written, error: updateError } = await queueDb
      .from('planned_meals')
      .update({
        dish_name: dishName || '写真から入力',
        dishes: photoDishes,
        image_url: imageUrl,
        description: result.praiseComment,
        // 栄養素 (基本・拡張・糖質)。書く列は meal-photo-update.ts に集約している。
        // 糖質 (sugar_g) を炭水化物・食物繊維と一緒に上書きしないと、上書き前の AI 献立の古い糖質が残る (#1146)
        ...buildPhotoOverwriteNutrition(result),
        // 野菜スコア (0〜100。_shared/veg-score.ts の尺度。#2025 の正本)
        veg_score: result.vegScore,
        // メタデータ
        is_simple: result.dishes.length <= 1,
        mode: 'cook',
        updated_at: new Date().toISOString(),
      })
      .eq('id', mealId)
      .eq('updated_at', claim.token)
      .select('id')

    if (updateError) throw updateError
    if (!written || written.length === 0) {
      console.warn('Photo analysis result discarded: the meal was updated before the write', { mealId, invokedAt })
      return
    }

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
