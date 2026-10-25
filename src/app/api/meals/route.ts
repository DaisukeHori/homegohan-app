import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { jstToday } from '@/lib/jst-day-ranges';
import { NextResponse } from 'next/server';
import { buildCatalogSelectionUpdate } from '../../../lib/catalog-products';
import {
  buildDishImagePayload,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../lib/meal-image-jobs';
import { countMealImageJobsToProcess, markDishImagesSkipped, mealImageSkipReasonOf } from '../../../lib/meal-image';
import { checkRateLimit } from '@/lib/rate-limit';
import { aiDailyLimitSkippedField, consumeAiUsage, refundAiUsage, type AiUsageResult } from '@/lib/plan/entitlements';
import { checkUserAiConsent } from '@/lib/ai/consent-guard';
import { createLogger } from '@/lib/db-logger';
import { plannedMealValidationErrorBody, validatePlannedMealInput } from '@/lib/planned-meal-validation';
import { internalError } from '@/lib/api/errors';
import { uuidOrNull } from '@/lib/http-params';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { REQUIRED_FIELDS_MISSING_MESSAGE } from '@/lib/api/user-api-error-messages';

/**
 * 食事一覧取得（日付ベースモデル: user_daily_meals → planned_meals）
 * 今日の献立または指定日の献立を取得
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');

    // 日付が指定されていない場合は今日 (JST の暦日。#1433)
    const targetDate = date || jstToday();

    // user_daily_mealsとplanned_mealsをJOINして取得
    const { data: dailyMeal, error: dayError } = await supabase
      .from('user_daily_meals')
      .select(`
        id,
        day_date,
        theme,
        nutritional_focus,
        is_cheat_day,
        planned_meals(*)
      `)
      .eq('day_date', targetDate)
      .eq('user_id', user.id)
      .maybeSingle();

    if (dayError) {
      return internalError('GET /api/meals', dayError, { userId: user.id });
    }

    if (!dailyMeal) {
      return NextResponse.json({ meals: [] });
    }

    // display_orderでソート
    const meals = (dailyMeal.planned_meals || []).sort(
      (a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0)
    );

    return NextResponse.json({ meals });

  } catch (error: any) {
    return internalError('GET /api/meals', error);
  }
}

/**
 * 新しい食事を追加（日付ベースモデル: user_daily_meals upsert → planned_meals insert）
 */
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { 
      date, 
      mealType, 
      dishName, 
      mode = 'cook',
      description,
      imageUrl,
      caloriesKcal,
      ingredients,
      dishes,
      catalogProductId,
      sourceType,
    } = body;

    if (!date || !mealType || !dishName) {
      return NextResponse.json({ error: REQUIRED_FIELDS_MISSING_MESSAGE }, { status: 400 });
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
    const triggerSource = 'nextjs:meals:POST';
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
          dishes: dishes ?? null,
          jobs: [],
          mealCoverImageUrl: imageUrl ?? null,
        };

    // 料理画像のジョブを積むかを、料理 (dishes) を保存する前に決める (#1487)。
    // 見送るなら、対象の料理を見送りの状態 ('failed' + 理由) にしてから保存する
    // ('pending' のまま保存すると、処理するジョブが無いので「料理画像を生成中です」のまま残る)。
    let imageDishes = dishImagePayload.dishes;
    let imageJobs = dishImagePayload.jobs;
    let imageGenerationThrottled = false;
    // #1149 AI の利用回数の上限の判定の結果 (画像を付けない・同意が無い・レート制限で止めたときは判定しないので null)
    let imageUsage: AiUsageResult | null = null;
    let imageAllowed = false;
    if (imageJobs.length > 0) {
      // #1022 画像副作用（enqueue + trigger）は meal 本体の成否から独立させる。
      // - rate 超過時は enqueue 自体もスキップし、孤児 pending ジョブ（掃かれず永久欠落する行）を作らない。
      // - checkRateLimit が例外（Upstash 到達不能等）を投げても、ここではローカルで握りつぶし
      //   画像生成をスキップするだけに留める。meal 作成自体の成否（200）には波及させない。
      //   ※ この緩和は画像副作用サイト限定。主目的が AI 呼び出しの route は fail-close を維持する。
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
        createLogger('api/meals').warn('Image rate-limit check failed; skipping image generation', {
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
          console.warn('[meals] Image generation skipped due to rate limit', { userId: user.id });
        }
        imageDishes = markDishImagesSkipped(imageDishes, imageJobs, skipReason);
        imageJobs = [];
      }
    }

    // 料理画像の 1 回を数えたあと、献立を保存できなかったときは数え戻す (AI へは何も送っていない。#1149 の数え戻し)
    const refundImageUsage = async () => {
      if (imageUsage?.allowed) await refundAiUsage(user.id, 'meal_image_auto', imageUsage);
    };

    // 1. user_daily_mealsをupsert
    const { data: dailyMeal, error: dailyMealError } = await supabase
      .from('user_daily_meals')
      .upsert(
        { 
          user_id: user.id, 
          day_date: date,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id,day_date' }
      )
      .select('id')
      .single();

    if (dailyMealError || !dailyMeal) {
      await refundImageUsage();
      throw dailyMealError || new Error('Failed to create daily meal');
    }

    // 2. planned_mealを追加
    const insertData: Record<string, any> = {
      daily_meal_id: dailyMeal.id,
      meal_type: mealType,
      dish_name: dishName,
      mode: mode,
      description: description,
      // 検証済みの値（整数に丸め済み。未送信なら undefined のまま列を書かない）
      calories_kcal: validation.nutrients.calories_kcal,
      ingredients: ingredients,
      image_url: dishImagePayload.mealCoverImageUrl,
      dishes: imageDishes,
      source_type: sourceType || 'manual',
    };

    let meal;
    try {
      if (catalogProductId) {
        const { fields } = await buildCatalogSelectionUpdate({
          supabase,
          catalogProductId,
          mode: mode || 'buy',
          imageUrl: imageUrl ?? undefined,
          description: description ?? undefined,
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
      meal = inserted;
    } catch (saveError) {
      await refundImageUsage();
      throw saveError;
    }

    if (imageAllowed && imageJobs.length > 0) {
      // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。service role で積む。
      // 1 行も積めなかったとき (重複・書き込みの失敗) は、enqueueMealImageJobs が数えた 1 回を戻す (#1487)
      const queueDb = getAiQueueWriter();
      const enqueued = await enqueueMealImageJobs({
        supabase: queueDb,
        plannedMealId: meal.id,
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
        await triggerMealImageJobProcessing({ plannedMealId: meal.id, limit: jobsToProcess });
      }
    }

    return NextResponse.json({
      meal,
      // #1022 (Suggestion): 画像生成がスロットルされた場合のみ additive にフラグを付与する
      ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
      // #1149 今日の AI の利用回数の上限に達して、料理画像だけを見送ったとき
      ...aiDailyLimitSkippedField(imageUsage),
    });

  } catch (error: any) {
    return internalError('POST /api/meals', error);
  }
}
