import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import {
  buildCatalogSelectionUpdate,
  clearCatalogSelectionMetadata,
} from '../../../../lib/catalog-products';
import { isCatalogProductMeal, countMealImageJobsToProcess, markDishImagesSkipped, mealImageSkipReasonOf, type MealImageJobSeed } from '../../../../lib/meal-image';
import {
  buildDishImagePayload,
  cancelPendingMealImageJobs,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../../lib/meal-image-jobs';
import { checkRateLimit } from '@/lib/rate-limit';
import { aiDailyLimitSkippedField, consumeAiUsage, refundAiUsage, type AiUsageResult } from '@/lib/plan/entitlements';
import { checkUserAiConsent } from '@/lib/ai/consent-guard';
import { createLogger } from '@/lib/db-logger';
import { plannedMealValidationErrorBody, validatePlannedMealInput } from '@/lib/planned-meal-validation';
import { internalError } from '@/lib/api/errors';
import { isUuid, uuidOrNull } from '@/lib/http-params';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { MEAL_NOT_FOUND_MESSAGE } from '@/lib/api/user-api-error-messages';

/**
 * 特定の食事を取得（planned_mealsベース）
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // planned_mealsとuser_daily_mealsをJOINして取得
    const { data, error } = await supabase
      .from('planned_meals')
      .select(`
        *,
        user_daily_meals!inner(
          day_date,
          user_id
        )
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .maybeSingle();

    // 他人の食事・消された食事は行が無い。DB の失敗だけを 500 にし、行が無いときは 404 (#1917。.single() は行が無いと PGRST116 の失敗で 500 になっていた)
    if (error) {
      return internalError('GET /api/meals/[id]', error, { userId: user.id });
    }

    if (!data) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error: any) {
    return internalError('GET /api/meals/[id]', error);
  }
}

/**
 * 食事を更新（planned_mealsベース）
 */
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }

    // #1205: 栄養素の型・範囲を、DB に触れる前に確認する（不正なら 400）。
    // 下の allowlist はキー名を絞るだけで値は見ないため、ここで値を確認する。
    const validation = validatePlannedMealInput({
      nutrients: {
        calories_kcal: body.calories_kcal,
        protein_g: body.protein_g,
        fat_g: body.fat_g,
        carbs_g: body.carbs_g,
      },
    });
    if (!validation.ok) {
      return NextResponse.json(plannedMealValidationErrorBody(validation), { status: 400 });
    }
    
    // 許可されたフィールドのみ更新
    const allowedFields = [
      'dish_name', 'mode', 'description', 'image_url', 'ingredients',
      'calories_kcal', 'protein_g', 'fat_g', 'carbs_g',
      'is_completed', 'completed_at', 'dishes', 'is_simple', 'cooking_time_minutes', 'source_type'
    ];
    
    const updateData: Record<string, any> = {};
    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updateData[key] = body[key];
      }
    }
    // 栄養素は検証済みの値で上書きする（calories_kcal は整数に丸め済み。null は値なし）
    Object.assign(updateData, validation.nutrients);
    updateData.updated_at = new Date().toISOString();
    const manualImageUrl = typeof body.image_url === 'string' ? body.image_url : undefined;

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // まずユーザーの所有確認。読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で食事が消えたように見せない。#1917)
    const { data: existing, error: existingError } = await supabase
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
      .maybeSingle();

    if (existingError) {
      return internalError('PATCH /api/meals/[id]', existingError, { userId: user.id });
    }
    if (!existing) {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    if (body.catalogProductId) {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase,
        catalogProductId: body.catalogProductId,
        existingMetadata: existing.generation_metadata,
        mode: body.mode ?? existing.mode ?? 'buy',
        imageUrl: body.image_url ?? undefined,
        description: body.description ?? undefined,
        selectedFrom: 'manual_search',
      });
      Object.assign(updateData, fields);
    } else {
      const manualContentChanged =
        body.dish_name !== undefined ||
        body.dishes !== undefined ||
        body.calories_kcal !== undefined ||
        body.description !== undefined ||
        body.image_url !== undefined;

      if ((body.catalogProductId === null || manualContentChanged) && existing.catalog_product_id) {
        updateData.catalog_product_id = null;
        updateData.source_type = body.source_type ?? 'manual';
        updateData.generation_metadata = clearCatalogSelectionMetadata(
          existing.generation_metadata,
          body.catalogProductId === null ? 'catalog_selection_removed' : 'manual_override',
        );
      }
    }

    const imageModel = process.env.GEMINI_IMAGE_MODEL ?? undefined;
    const triggerSource = `nextjs:meals/${params.id}:PATCH`;
    const requestId = request.headers.get('x-request-id') ?? null;
    const hasImageManagedDishes =
      (Array.isArray(existing.dishes) && existing.dishes.length > 0) ||
      (Array.isArray(body.dishes) && body.dishes.length > 0);
    let jobs: MealImageJobSeed[] = [];

    // 商品を選んだとき (catalogProductId) は、料理と画像を商品のもの (上の buildCatalogSelectionUpdate の dishes / image_url) にし、
    // 前回の料理から AI の画像のジョブを作らない (#1487 の整合ゲート。前回の料理の名前を商品名に変えたものを料理の変更とみなして、
    // 商品の料理を AI の画像で置き換えてしまうため)
    if (body.catalogProductId) {
      // 料理と画像は buildCatalogSelectionUpdate の fields で設定済み
    } else if (hasImageManagedDishes) {
      const { dishes: reconciledDishes, jobs: nextJobs, mealCoverImageUrl } = await buildDishImagePayload({
        previousDishes: existing.dishes ?? null,
        nextDishes: body.dishes ?? undefined,
        dishName: updateData.dish_name ?? undefined,
        triggerSource,
        imageUrlOverride: manualImageUrl,
        // 利用者がカバーを外した (image_url: null)。料理が 2 品以上なら、カバーを外して料理の画像 (AI の画像があれば) に戻す (#1553)
        clearCover: body.image_url === null,
        imageModel,
        existingCover: existing.image_url ?? null,
        fallbackMealImageUrl: existing.image_url ?? null,
        // 保存する前の献立で見る (料理を変えると、上で商品とのつながりを外すが、前回の料理は商品の料理のまま。#1487 の整合ゲート)
        previousMealIsCatalog: isCatalogProductMeal(existing),
      });
      updateData.dishes = reconciledDishes;
      updateData.image_url = mealCoverImageUrl;
      jobs = nextJobs;
    } else if (body.image_url !== undefined) {
      updateData.image_url = body.image_url;
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
        createLogger('api/meals/[id]').warn('Image rate-limit check failed; skipping image generation', {
          userId: user.id,
          plannedMealId: params.id,
          error: rlError instanceof Error ? rlError.message : String(rlError),
        });
        imageAllowed = false;
      }

      if (!imageAllowed) {
        const skipReason = mealImageSkipReasonOf(imageUsage);
        if (skipReason === 'rate_limit') {
          // レート制限で見送った (上限 #1149 で見送ったときは、下の aiSkipped で知らせる)
          imageGenerationThrottled = true;
          console.warn('[meals/[id]] Image generation skipped due to rate limit', {
            userId: user.id,
            plannedMealId: params.id,
          });
        }
        updateData.dishes = markDishImagesSkipped(updateData.dishes, jobs, skipReason);
        jobs = [];
      }
    }

    const { data, error } = await supabase
      .from('planned_meals')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      // 料理画像の 1 回を数えたあと、献立を保存できなかった (AI へは何も送っていない) ので数え戻す (#1149 の数え戻し)
      if (imageUsage?.allowed) await refundAiUsage(user.id, 'meal_image_auto', imageUsage);
      return internalError('PATCH /api/meals/[id]', error, { userId: user.id, requestId: requestId ?? undefined });
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

    // #1022 (Suggestion): 画像生成がスロットルされた場合のみ additive にフラグを付与する
    return NextResponse.json(
      // #1149 今日の AI の利用回数の上限に達して、料理画像だけを見送ったときは aiSkipped (AI_DAILY_LIMIT) を足す
      {
        ...data,
        ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
        ...aiDailyLimitSkippedField(imageUsage),
      },
    );
  } catch (error: any) {
    return internalError('PATCH /api/meals/[id]', error);
  }
}

/**
 * 食事を削除（planned_mealsベース）
 */
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // まずユーザーの所有確認。読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で食事が消えたように見せない。#1917)
    const { data: existing, error: existingError } = await supabase
      .from('planned_meals')
      .select(`
        id,
        user_daily_meals!inner(user_id)
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .maybeSingle();

    if (existingError) {
      return internalError('DELETE /api/meals/[id]', existingError, { userId: user.id });
    }
    if (!existing) {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

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

    if (error) {
      return internalError('DELETE /api/meals/[id]', error, { userId: user.id });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return internalError('DELETE /api/meals/[id]', error);
  }
}
