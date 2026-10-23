import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import {
  buildCatalogSelectionUpdate,
  clearCatalogSelectionMetadata,
} from '../../../../../lib/catalog-products';
import { isCatalogProductMeal, countMealImageJobsToProcess, markDishImagesSkipped, mealImageSkipReasonOf, type MealImageJobSeed } from '../../../../../lib/meal-image';
import {
  buildDishImagePayload,
  cancelPendingMealImageJobs,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../../../lib/meal-image-jobs';
import { checkRateLimit } from '@/lib/rate-limit';
import { aiDailyLimitSkippedField, consumeAiUsage, refundAiUsage, type AiUsageResult } from '@/lib/plan/entitlements';
import { checkUserAiConsent } from '@/lib/ai/consent-guard';
import { createLogger } from '@/lib/db-logger';
import { plannedMealValidationErrorBody, validatePlannedMealInput } from '@/lib/planned-meal-validation';
import { internalError } from '@/lib/api/errors';
import { uuidOrNull } from '@/lib/http-params';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const {
      isCompleted,
      dishName,
      mode,
      dishes,
      isSimple,
      caloriesKcal,
      description,
      imageUrl,
      catalogProductId,
      sourceType,
    } = json;

    // #1205: 栄養素の型・範囲を、DB に触れる前に確認する（不正なら 400）
    const validation = validatePlannedMealInput({
      nutrients: { calories_kcal: caloriesKcal },
    });
    if (!validation.ok) {
      return NextResponse.json(plannedMealValidationErrorBody(validation), { status: 400 });
    }

    const { data: existingMeal, error: existingMealError } = await supabase
      .from('planned_meals')
      .select(`
        id,
        mode,
        catalog_product_id,
        source_type,
        generation_metadata,
        dishes,
        image_url,
        user_daily_meals!inner(user_id)
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .single();

    if (existingMealError || !existingMeal) {
      return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 });
    }

    const updateData: Record<string, any> = {};
    
    if (isCompleted !== undefined) {
      updateData.is_completed = isCompleted;
      updateData.completed_at = isCompleted ? new Date().toISOString() : null;
    }
    if (dishName !== undefined) updateData.dish_name = dishName;
    if (mode !== undefined) updateData.mode = mode;
    if (dishes !== undefined) updateData.dishes = dishes;
    if (isSimple !== undefined) updateData.is_simple = isSimple;
    // 検証済みの値（整数に丸め済み。null は値なし）
    if (caloriesKcal !== undefined) updateData.calories_kcal = validation.nutrients.calories_kcal;
    if (description !== undefined) updateData.description = description;
    const manualImageUrl = typeof imageUrl === 'string' ? imageUrl : undefined;

    if (catalogProductId) {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase,
        catalogProductId,
        existingMetadata: existingMeal.generation_metadata,
        mode: mode ?? existingMeal.mode ?? 'buy',
        imageUrl: imageUrl ?? undefined,
        description: description ?? undefined,
        selectedFrom: 'manual_search',
      });
      Object.assign(updateData, fields);
    } else {
      const manualContentChanged =
        dishName !== undefined ||
        dishes !== undefined ||
        isSimple !== undefined ||
        caloriesKcal !== undefined ||
        description !== undefined ||
        imageUrl !== undefined;

      if ((catalogProductId === null || manualContentChanged) && existingMeal.catalog_product_id) {
        updateData.catalog_product_id = null;
        updateData.source_type = sourceType ?? 'manual';
        updateData.generation_metadata = clearCatalogSelectionMetadata(
          existingMeal.generation_metadata,
          catalogProductId === null ? 'catalog_selection_removed' : 'manual_override',
        );
      } else if (sourceType !== undefined) {
        updateData.source_type = sourceType;
      }
    }

    const imageModel = process.env.GEMINI_IMAGE_MODEL ?? undefined;
    const triggerSource = `nextjs:meal-plans/meals/${params.id}:PATCH`;
    const requestId = request.headers.get('x-request-id') ?? null;
    const hasImageManagedDishes =
      (Array.isArray(existingMeal.dishes) && existingMeal.dishes.length > 0) ||
      (Array.isArray(dishes) && dishes.length > 0);
    let jobs: MealImageJobSeed[] = [];

    // 商品を選んだとき (catalogProductId) は、料理と画像を商品のもの (上の buildCatalogSelectionUpdate の dishes / image_url) にし、
    // 前回の料理から AI の画像のジョブを作らない (#1487 の整合ゲート。前回の料理の名前を商品名に変えたものを料理の変更とみなして、
    // 商品の料理を AI の画像で置き換えてしまうため)
    if (catalogProductId) {
      // 料理と画像は buildCatalogSelectionUpdate の fields で設定済み
    } else if (hasImageManagedDishes) {
      const { dishes: reconciledDishes, jobs: nextJobs, mealCoverImageUrl } = await buildDishImagePayload({
        previousDishes: existingMeal.dishes ?? null,
        nextDishes: dishes ?? undefined,
        dishName: updateData.dish_name ?? undefined,
        triggerSource,
        imageUrlOverride: manualImageUrl,
        // 利用者がカバーを外した (imageUrl: null)。料理が 2 品以上なら、カバーを外して料理の画像 (AI の画像があれば) に戻す (#1553)
        clearCover: imageUrl === null,
        imageModel,
        existingCover: existingMeal.image_url ?? null,
        fallbackMealImageUrl: existingMeal.image_url ?? null,
        // 保存する前の献立で見る (料理を変えると、上で商品とのつながりを外すが、前回の料理は商品の料理のまま。#1487 の整合ゲート)
        previousMealIsCatalog: isCatalogProductMeal(existingMeal),
      });
      updateData.dishes = reconciledDishes;
      updateData.image_url = mealCoverImageUrl;
      jobs = nextJobs;
    } else if (imageUrl !== undefined) {
      updateData.image_url = imageUrl;
    }

    // 料理画像のジョブを積むかを、料理 (dishes) を保存する前に決める (#1487)。
    // 見送るなら、対象の料理を見送りの状態 ('failed' + 理由) にしてから保存する
    // ('pending' のまま保存すると、処理するジョブが無いので「料理画像を生成中です」のまま残る)
    let imageGenerationThrottled = false;
    // #1149 AI の利用回数の上限の判定の結果 (画像を付けない・同意が無い・レート制限で止めたときは判定しないので null)
    let imageUsage: AiUsageResult | null = null;
    let imageAllowed = false;
    if (jobs.length > 0) {
      // #1022 画像副作用（enqueue + trigger）は献立更新の成否から独立させる（詳細は meals/route.ts 参照）
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
        createLogger('api/meal-plans/meals/[id]').warn('Image rate-limit check failed; skipping image generation', {
          userId: user.id,
          plannedMealId: existingMeal.id,
          error: rlError instanceof Error ? rlError.message : String(rlError),
        });
        imageAllowed = false;
      }

      if (!imageAllowed) {
        const skipReason = mealImageSkipReasonOf(imageUsage);
        if (skipReason === 'rate_limit') {
          // レート制限で見送った (上限 #1149 で見送ったときは、下の aiSkipped で知らせる)
          imageGenerationThrottled = true;
          console.warn('[meal-plans/meals/[id]] Image generation skipped due to rate limit', {
            userId: user.id,
            plannedMealId: existingMeal.id,
          });
        }
        updateData.dishes = markDishImagesSkipped(updateData.dishes, jobs, skipReason);
        jobs = [];
      }
    }

    const { data, error } = await supabase
      .from('planned_meals')
      .update(updateData)
      .eq('id', existingMeal.id)
      .select()
      .single();

    if (error) {
      // 料理画像の 1 回を数えたあと、献立を保存できなかった (AI へは何も送っていない) ので数え戻す (#1149 の数え戻し)
      if (imageUsage?.allowed) await refundAiUsage(user.id, 'meal_image_auto', imageUsage);
      throw error;
    }

    if (imageAllowed && jobs.length > 0) {
      // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。service role で積む。
      // 1 行も積めなかったとき (重複・書き込みの失敗) は、enqueueMealImageJobs が数えた 1 回を戻す (#1487)
      const queueDb = getAiQueueWriter();
      const enqueued = await enqueueMealImageJobs({
        supabase: queueDb,
        plannedMealId: data.id,
        userId: user.id,
        triggerSource,
        jobSeeds: jobs,
        // uuid の形式でない x-request-id は入れない (request_id は uuid の列で、入れると 22P02 で積めない。#1532)
        requestId: uuidOrNull(requestId),
        usage: imageUsage,
      });
      // 積めた行と、同じ料理の待ちのジョブがあるときだけ処理を起こす (書き込みの失敗だけなら空振りの呼び出しを出さない。#1532)
      const jobsToProcess = countMealImageJobsToProcess(enqueued);
      if (jobsToProcess > 0) {
        await triggerMealImageJobProcessing({ plannedMealId: data.id, limit: jobsToProcess });
      }
    }

    return NextResponse.json({
      success: true,
      meal: data,
      // #1022 (Suggestion): 画像生成がスロットルされた場合のみ additive にフラグを付与する
      ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
      // #1149 今日の AI の利用回数の上限に達して、料理画像だけを見送ったとき
      ...aiDailyLimitSkippedField(imageUsage),
    });
  } catch (error: any) {
    return internalError('PATCH /api/meal-plans/meals/[id]', error, { userId: user.id });
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。本人の行に絞って service role で取り消す
    const queueDb = getAiQueueWriter();
    await cancelPendingMealImageJobs({
      supabase: queueDb,
      userId: user.id,
      plannedMealId: params.id,
      reason: 'meal deleted',
    });

    const { error } = await supabase
      .from('planned_meals')
      .delete()
      .eq('id', params.id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return internalError('DELETE /api/meal-plans/meals/[id]', error, { userId: user.id });
  }
}
