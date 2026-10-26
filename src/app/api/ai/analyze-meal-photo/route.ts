import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { findCatalogCandidatesForDishes } from '../../../../lib/catalog-products';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiUsageRecordedHeaders, aiDailyLimitResponse, consumeAiUsage, AI_USAGE_COVERED_BY_GRANT, redeemAiUsageGrant } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_IMAGE_REQUIRED_MESSAGE, AI_MENU_MEAL_ID_INVALID_MESSAGE, AI_PHOTO_ANALYSIS_STARTED_MESSAGE, AI_PHOTO_MODE_MISMATCH_CODE } from '@/lib/ai/ai-api-messages';
import { isUuid } from '@/lib/http-params';
import { markPhotoAnalysisRequest } from '../../../../../supabase/functions/_shared/meal-photo-cas';

interface ImageInput {
  base64: string;
  mimeType: string;
}

interface PrefetchedGeminiResult {
  dishes: Array<{
    name: string;
    role: 'main' | 'side' | 'soup' | 'rice' | 'salad' | 'dessert';
    cookingMethod?: 'fried' | 'grilled' | 'stir_fried' | 'simmered' | 'steamed' | 'boiled' | 'raw' | 'rice' | 'soup' | 'baked' | 'other';
    visiblePortionWeightG?: number;
    visibleIngredients?: Array<{
      name: string;
      amount_g: number;
    }>;
    estimatedIngredients?: Array<{
      name: string;
      amount_g: number;
    }>;
    estimatedNutrition?: {
      calories_kcal: number;
      protein_g: number;
      fat_g: number;
      carbs_g: number;
      fiber_g: number;
      salt_eq_g: number;
      confidence: 'high' | 'medium' | 'low';
    };
  }>;
}

/** 422: 食事の写真から料理が読み取れなかった */
const MEAL_PHOTO_NOT_READABLE_MESSAGE = '料理が読み取れませんでした。食事が鮮明に写った写真を撮り直してください。';

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)
  const aiConsentDenied = await requireAiConsent(supabase, user.id);
  if (aiConsentDenied) return aiConsentDenied;

  const rateLimitResult = await checkRateLimit(user.id, 'analysis');
  if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

  try {
    const startedAt = Date.now();
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { images, imageBase64, mimeType, mealType, mealId: requestedMealId, prefetchedGeminiResult } = body as {
      images?: ImageInput[];
      imageBase64?: string;
      mimeType?: string;
      mealType?: string;
      mealId?: unknown;
      prefetchedGeminiResult?: PrefetchedGeminiResult;
    };
    // mealId (planned_meals.id。uuid の列) は、UUID の形でなければ数える前に 400。DB に渡すと PostgREST が 22P02 で失敗し、
    // 要求の印 (markPhotoAnalysisRequest の .eq('id', mealId)) で 500 になる (#2050)。無い (偽の値) ときは今までどおり同期の解析
    if (requestedMealId && !isUuid(requestedMealId)) {
      return NextResponse.json({ error: AI_MENU_MEAL_ID_INVALID_MESSAGE }, { status: 400 });
    }
    const mealId = isUuid(requestedMealId) ? requestedMealId : undefined;
    // mealId の経路 (Edge の背景の処理が planned_meals の veg_score を書く) では、画面から来た解析の結果を Edge へ渡さない。
    // 利用者が料理と材料の g を指定できると veg_score を好きな値にできる (#2025)。Edge の側でも使わない (二重に閉じる。cross/23 §7.15)
    const forwardedPrefetchedGeminiResult = mealId ? undefined : prefetchedGeminiResult;

    const imageDataArray: ImageInput[] = Array.isArray(images) && images.length > 0
      ? images
      : imageBase64
        ? [{ base64: imageBase64, mimeType: mimeType || 'image/jpeg' }]
        : [];

    if (imageDataArray.length === 0) {
      return NextResponse.json({ error: AI_IMAGE_REQUIRED_MESSAGE }, { status: 400 });
    }

    // #1149 AI の利用回数の上限の判定と記録 (#1177)。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回数える。
    // 上限に達していれば数えずに 429 AI_DAILY_LIMIT (判定に失敗したときは止めない)。
    // 写真の「オート」は、判別 (classify-photo) が 1 回数えて「数え済みの印」を返し、画面がこの本文の aiUsageGrant に入れて送る。
    // 印が本物で、はじめて使うものなら数えない (1 回の操作を 1 回)。印が無い・偽物・期限切れ・他人の印・使用済みなら数える
    const aiUsage = (await redeemAiUsageGrant(user.id, 'photo_analysis', body?.aiUsageGrant))
      ? AI_USAGE_COVERED_BY_GRANT
      : await consumeAiUsage(user.id, 'photo_analysis');
    if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

    // #121: 古い解析の結果で新しい結果を上書きしない (CAS)。mealId がある非同期モードでは、Edge を呼ぶ直前に行に要求の印を付け
    // (updated_at を進める。利用者の client なので本人の行だけ)、進んだ updated_at を invokedAt として Edge Function に渡す。
    // Edge Function は解析の前に、planned_meals.updated_at が invokedAt 以前のときだけ行に印を付け (updated_at を進める)、
    // 書くときは updated_at が印のままの行にだけ書く。後から送った要求の印・後から送った解析の印・ほかの書き込みがあれば書かない。
    // 要求の印が行に残るので、先に送った解析の Edge が遅れて動いても、後に送った写真の結果が残る (#2050)
    // (supabase/functions/_shared/meal-photo-cas.ts。挙動は tests/analyze-meal-photo-cas.test.ts・analyze-meal-photo-cas-request-order.test.ts)
    const invokedAt = mealId ? await photoAnalysisInvokedAt(supabase, mealId) : undefined;

    const invokePromise = supabase.functions.invoke('analyze-meal-photo', {
      body: {
        images: imageDataArray,
        mealId,
        mealType,
        prefetchedGeminiResult: forwardedPrefetchedGeminiResult,
        userId: user.id,
        invokedAt,
      },
      // #1177 Edge Function はユーザーの JWT で呼ばれたときに利用回数を記録する。この API ルートが記録済みなので、
      // 二重に記録しないよう、署名つきの印を付ける
      headers: await aiUsageRecordedHeaders(user.id),
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AI タイムアウト')), 25_000),
    );

    const { data, error } = await Promise.race([invokePromise, timeoutPromise]) as Awaited<typeof invokePromise>;

    if (error) {
      throw new Error(`Edge Function invoke failed: ${error.message}`);
    }

    console.info('Analyze Meal Photo: completed', {
      imageCount: imageDataArray.length,
      mealId: mealId ?? null,
      mealType: mealType ?? null,
      sync: !mealId,
      usedPrefetchedGeminiResult: Boolean(forwardedPrefetchedGeminiResult?.dishes?.length),
      elapsedMs: Date.now() - startedAt,
      timings: data?.timings ?? null,
    });

    if (mealId) {
      return NextResponse.json({
        success: true,
        message: AI_PHOTO_ANALYSIS_STARTED_MESSAGE,
        status: 'processing',
      });
    }

    const dishNames = Array.isArray(data?.dishes)
      ? data.dishes
          .map((dish: any) => typeof dish?.name === 'string' ? dish.name.trim() : '')
          .filter((name: string) => name.length > 0)
      : [];

    if (!dishNames.length) {
      return NextResponse.json(
        { error: MEAL_PHOTO_NOT_READABLE_MESSAGE, code: AI_PHOTO_MODE_MISMATCH_CODE, message: MEAL_PHOTO_NOT_READABLE_MESSAGE },
        { status: 422 },
      );
    }

    let catalogMatches: Awaited<ReturnType<typeof findCatalogCandidatesForDishes>> = [];
    try {
      catalogMatches = await findCatalogCandidatesForDishes(supabase, dishNames, { limitPerDish: 3 });
    } catch (catalogError) {
      console.warn('Analyze Meal Photo: catalog lookup skipped', catalogError);
    }

    return NextResponse.json({
      ...data,
      catalogMatches,
    });
  } catch (error: any) {
    const isTimeout = error instanceof Error && error.message === 'AI タイムアウト';
    if (isTimeout) {
      console.error('Analyze Meal Photo: AI timeout after 25s');
      return NextResponse.json(
        { error: 'AI が応答しませんでした、もう一度お試しください' },
        { status: 504 },
      );
    }
    return internalError('POST /api/ai/analyze-meal-photo', error, { userId: user.id });
  }
}

/**
 * mealId の経路で Edge へ送る invokedAt。行に要求の印を付け (markPhotoAnalysisRequest)、進んだ updated_at (DB の時刻) を返す。
 * 本人の行が見つからない (他人の献立・消えた献立) ときは行を変えずに route の時計を返す (今までどおり。Edge の背景の処理が
 * 本人の行の確認で止める)。印を付ける update が失敗したら投げる (route の catch が 500 にする。順序を守れない解析を始めない)
 */
async function photoAnalysisInvokedAt(
  supabase: Awaited<ReturnType<typeof createClient>>,
  mealId: string,
): Promise<string> {
  const mark = await markPhotoAnalysisRequest(supabase, { mealId });
  if (mark.status === 'marked') return mark.requestedAt;
  return new Date().toISOString();
}
