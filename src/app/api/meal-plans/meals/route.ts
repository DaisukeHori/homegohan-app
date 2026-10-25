import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import { buildCatalogSelectionUpdate } from '../../../../lib/catalog-products';
import {
  buildDishImagePayload,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../../lib/meal-image-jobs';
import { countMealImageJobsToProcess, markDishImagesSkipped, mealImageSkipReasonOf } from '../../../../lib/meal-image';
import { checkRateLimit } from '@/lib/rate-limit';
import { aiDailyLimitSkippedField, consumeAiUsage, refundAiUsage, type AiUsageResult } from '@/lib/plan/entitlements';
import { checkUserAiConsent } from '@/lib/ai/consent-guard';
import { createLogger } from '@/lib/db-logger';
import { plannedMealValidationErrorBody, validatePlannedMealInput } from '@/lib/planned-meal-validation';
import { internalError } from '@/lib/api/errors';
import { uuidOrNull } from '@/lib/http-params';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

/** 400: 日付 (dayDate) と食事の種類 (mealType) が無い */
const DAY_DATE_AND_MEAL_TYPE_REQUIRED_MESSAGE = '日付 (dayDate) と食事の種類 (mealType) を指定してください';

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const requestBody = await request.json().catch(() => null);
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const {
      dayDate,
      mealType,
      mode,
      dishName,
      isSimple,
      dishes,
      caloriesKcal,
      description,
      ingredients,
      catalogProductId,
      sourceType,
      imageUrl,
    } = requestBody;

    if (!dayDate || !mealType) {
      return NextResponse.json({ error: DAY_DATE_AND_MEAL_TYPE_REQUIRED_MESSAGE }, { status: 400 });
    }

    // #1205: meal_type と栄養素の型・範囲を、DB に触れる前に確認する（不正なら 400）
    const validation = validatePlannedMealInput({
      mealType,
      nutrients: { calories_kcal: caloriesKcal },
    });
    if (!validation.ok) {
      return NextResponse.json(plannedMealValidationErrorBody(validation), { status: 400 });
    }

    const manualImageUrl = typeof imageUrl === 'string' ? imageUrl : undefined;
    const imageModel = process.env.GEMINI_IMAGE_MODEL ?? undefined;
    const triggerSource = 'nextjs:meal-plans/meals:POST';
    const requestId = request.headers.get('x-request-id') ?? null;
    // 商品を選んだとき (catalogProductId) は、料理を商品の料理 (画像は商品の画像。buildCatalogSelectionUpdate の dishes / image_url) で
    // 保存するので、送られた料理から AI の画像のジョブを作らない (#1487 の整合ゲート。作ると、保存しない料理のために安全弁の 1 回を数え、
    // ジョブを積んでしまう)
    const hasImageManagedDishes = !catalogProductId && Array.isArray(dishes) && dishes.length > 0;
    const dishImagePayload = hasImageManagedDishes
      ? await buildDishImagePayload({
          previousDishes: null,
          nextDishes: dishes ?? undefined,
          dishName: dishName ?? undefined,
          triggerSource,
          imageUrlOverride: manualImageUrl,
          imageModel,
          existingCover: null,
          fallbackMealImageUrl: imageUrl ?? null,
          // 送られた写真・商品・手の画像の料理 (image_source が meal_photo / catalog / manual_override) は、
          // AI の画像の料理にせず、画像と状態を保持する (#1487 の整合ゲート)
          preserveSubmittedDishImages: true,
        })
      : {
          dishes: dishes || null,
          jobs: [],
          mealCoverImageUrl: imageUrl ?? null,
        };

    // 料理画像のジョブを積むかを、料理 (dishes) を保存する前に決める (#1487)。
    // 見送るなら、対象の料理を見送りの状態 ('failed' + 理由) にしてから保存する
    // ('pending' のまま保存すると、処理するジョブが無いので「料理画像を生成中です」のまま残る)
    let imageDishes = dishImagePayload.dishes;
    let imageJobs = dishImagePayload.jobs;
    let imageGenerationThrottled = false;
    // #1149 AI の利用回数の上限の判定の結果 (画像を付けない・同意が無い・レート制限で止めたときは判定しないので null)
    let imageUsage: AiUsageResult | null = null;
    let imageAllowed = false;
    if (imageJobs.length > 0) {
      // #1022 画像副作用（enqueue + trigger）は献立作成の成否から独立させる（詳細は meals/route.ts 参照）
      try {
        const rl = await checkRateLimit(user.id, 'image');
        imageAllowed = rl.success;
        if (imageAllowed) {
          // 同意が無ければ (判定に失敗した場合も)、画像の生成ジョブを処理する Edge Function (process-meal-image-jobs) が
          // AI へ送らずに止める (T15 / #1154。料理は 'failed' + 同意の理由になる)。AI へ送らない操作は記録しない
          // (同意の判定 → 利用回数の記録 → AI への送信の順)。ジョブを積むかどうかは、同意の有無では変えない (止めるのは処理する側)
          const imageConsent = await checkUserAiConsent(supabase, user.id);
          if (imageConsent.allowed) {
            // #1149 料理画像は保存の自動の副作用なので、明示の 1 日の上限には数えない ('meal_image_auto'。記録だけ。
            // 食事を記録するだけで AI 相談や写真の解析が止まらないように)。そのかわり料理画像だけの安全弁 (DB の ai_unmetered_daily_caps。
            // 既定は 1 日 20 回) があり、達していれば画像だけ見送る (ジョブを積まない。献立の保存はそのまま。応答の aiSkipped: AI_DAILY_LIMIT)。
            // 操作 1 回で 1 回 (積む画像のジョブの数によらない)。判定に失敗したときは止めない
            imageUsage = await consumeAiUsage(user.id, 'meal_image_auto');
            if (!imageUsage.allowed) imageAllowed = false;
          }
        }
      } catch (rlError) {
        createLogger('api/meal-plans/meals').warn('Image rate-limit check failed; skipping image generation', {
          userId: user.id,
          error: rlError instanceof Error ? rlError.message : String(rlError),
        });
        imageAllowed = false;
      }

      if (!imageAllowed) {
        const skipReason = mealImageSkipReasonOf(imageUsage);
        if (skipReason === 'rate_limit') {
          // レート制限で見送った (上限 #1149 で見送ったときは、下の aiSkipped で知らせる)
          imageGenerationThrottled = true;
          console.warn('[meal-plans/meals] Image generation skipped due to rate limit', { userId: user.id });
        }
        imageDishes = markDishImagesSkipped(imageDishes, imageJobs, skipReason);
        imageJobs = [];
      }
    }

    let newMeal;
    try {
      // Get or create user_daily_meals for the target date
      let { data: existingDay } = await supabase
        .from('user_daily_meals')
        .select('id')
        .eq('user_id', user.id)
        .eq('day_date', dayDate)
        .single();

      let dailyMealId: string;

      if (existingDay) {
        dailyMealId = existingDay.id;
      } else {
        const { data: newDay, error: dayError } = await supabase
          .from('user_daily_meals')
          .insert({
            user_id: user.id,
            day_date: dayDate,
            is_cheat_day: false
          })
          .select('id')
          .single();

        if (dayError) throw dayError;
        dailyMealId = newDay.id;
      }

      // 同じタイプの食事を複数追加可能にするため、削除はしない
      // Create new planned meal
      const insertData: Record<string, any> = {
        daily_meal_id: dailyMealId,
        meal_type: mealType,
        mode: mode || 'cook',
        dish_name: dishName || '未設定',
        is_simple: isSimple ?? true,
        dishes: imageDishes,
        // 検証済みの値（整数に丸め済み）。0 と未入力は従来どおり null にする
        calories_kcal: validation.nutrients.calories_kcal || null,
        description: description || null,
        ingredients: ingredients || null,
        image_url: dishImagePayload.mealCoverImageUrl,
        is_completed: false,
        source_type: sourceType || 'manual',
      };

      if (catalogProductId) {
        const { fields } = await buildCatalogSelectionUpdate({
          supabase,
          catalogProductId,
          mode: mode || 'buy',
          description: description || null,
          selectedFrom: 'manual_search',
        });
        Object.assign(insertData, fields);
      }

      const { data: inserted, error: mealError } = await supabase
        .from('planned_meals')
        .insert(insertData)
        .select()
        .single();

      if (mealError) throw mealError;
      newMeal = inserted;
    } catch (saveError) {
      // 料理画像の 1 回を数えたあと、献立を保存できなかった (AI へは何も送っていない) ので数え戻す (#1149 の数え戻し)
      if (imageUsage?.allowed) await refundAiUsage(user.id, 'meal_image_auto', imageUsage);
      throw saveError;
    }

    if (imageAllowed && imageJobs.length > 0) {
      // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。service role で積む。
      // 1 行も積めなかったとき (重複・書き込みの失敗) は、enqueueMealImageJobs が数えた 1 回を戻す (#1487)
      const queueDb = getAiQueueWriter();
      const enqueued = await enqueueMealImageJobs({
        supabase: queueDb,
        plannedMealId: newMeal.id,
        userId: user.id,
        triggerSource,
        jobSeeds: imageJobs,
        // uuid の形式でない x-request-id は入れない (request_id は uuid の列で、入れると 22P02 で積めない。#1532)
        requestId: uuidOrNull(requestId),
        usage: imageUsage,
      });
      // 積めた行と、同じ料理の待ちのジョブがあるときだけ処理を起こす (書き込みの失敗だけなら空振りの呼び出しを出さない。#1532)
      const jobsToProcess = countMealImageJobsToProcess(enqueued);
      if (jobsToProcess > 0) {
        await triggerMealImageJobProcessing({ plannedMealId: newMeal.id, limit: jobsToProcess });
      }
    }

    return NextResponse.json({
      success: true,
      meal: {
        id: newMeal.id,
        dailyMealId: newMeal.daily_meal_id,
        mealType: newMeal.meal_type,
        mode: newMeal.mode,
        dishName: newMeal.dish_name,
        isSimple: newMeal.is_simple,
        dishes: newMeal.dishes,
        caloriesKcal: newMeal.calories_kcal,
        description: newMeal.description,
        ingredients: newMeal.ingredients,
        isCompleted: newMeal.is_completed,
        createdAt: newMeal.created_at,
        updatedAt: newMeal.updated_at
      },
      // #1022 (Suggestion): 画像生成がスロットルされた場合のみ additive にフラグを付与する
      ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
      // #1149 今日の AI の利用回数の上限に達して、料理画像だけを見送ったとき
      ...aiDailyLimitSkippedField(imageUsage),
    });
  } catch (error: any) {
    return internalError('POST /api/meal-plans/meals', error, { userId: user.id });
  }
}
