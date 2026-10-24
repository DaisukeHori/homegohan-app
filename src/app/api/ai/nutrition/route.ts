import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { resolvePhotoUrlForOwnerRead } from '@/lib/photo-storage-signing';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { getFastLLMClient, getFastLLMModel } from '@/lib/ai/fast-llm';
import { NextResponse } from 'next/server';
import { buildPhotoDishList } from '../../../../lib/meal-image';
import { cancelPendingMealImageJobs } from '../../../../lib/meal-image-jobs';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage } from '@/lib/plan/entitlements';
import {
  PLANNED_MEAL_NUTRIENT_FIELDS,
  plannedMealValidationErrorBody,
  sanitizeAiNutrient,
  validatePlannedMealInput,
  type PlannedMealNutrientValues,
} from '@/lib/planned-meal-validation';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { isUuid } from '@/lib/http-params';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { aiRequiredFieldMessage, AI_MENU_MEAL_NOT_FOUND_MESSAGE, AI_IMAGE_URL_INVALID_MESSAGE, AI_NUTRITION_ESTIMATE_FAILED_MESSAGE, AI_NUTRITION_INPUT_REQUIRED_MESSAGE } from '@/lib/ai/ai-api-messages';

/**
 * 献立の栄養情報を更新
 * planned_mealsベース
 * 
 * 写真解析やAI推定結果をplanned_mealsに保存
 */
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const requestBody = await request.json().catch(() => null);
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { plannedMealId, imageUrl, nutritionData } = requestBody;

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    const rateLimitResult = await checkRateLimit(user.id, 'analysis');
    if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

    if (!plannedMealId) {
      return NextResponse.json({ error: aiRequiredFieldMessage('献立') }, { status: 400 });
    }

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(plannedMealId)) {
      return NextResponse.json({ error: AI_MENU_MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // 2. 所有権確認（日付ベースモデル）。読めなかったときは 404 にしない (行が無いときだけ 404。#1917)
    const { data: existing, error: existError } = await supabase
      .from('planned_meals')
      .select(`
        id,
        dishes,
        is_simple,
        user_daily_meals!inner(user_id)
      `)
      .eq('id', plannedMealId)
      .eq('user_daily_meals.user_id', user.id)
      .maybeSingle();

    if (existError) {
      return internalError('POST /api/ai/nutrition', existError, { userId: user.id, table: 'planned_meals' });
    }
    if (!existing) {
      return NextResponse.json({ error: AI_MENU_MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // 3. 栄養データが直接提供された場合はそれを使用
    if (nutritionData) {
      // #1205: クライアントから直接渡された栄養素は型・範囲を確認する（不正なら 400）
      const validation = validatePlannedMealInput({
        nutrients: {
          calories_kcal: nutritionData.calories_kcal,
          protein_g: nutritionData.protein_g,
          fat_g: nutritionData.fat_g,
          carbs_g: nutritionData.carbs_g,
        },
      });
      if (!validation.ok) {
        return NextResponse.json(plannedMealValidationErrorBody(validation), { status: 400 });
      }

      const { error: updateError } = await supabase
        .from('planned_meals')
        .update({
          // 検証済みの値（送られていない項目は含まれず、既存の値を残す）
          ...validation.nutrients,
          veg_score: nutritionData.veg_score,
          quality_tags: nutritionData.quality_tags,
          updated_at: new Date().toISOString(),
        })
        .eq('id', plannedMealId);

      if (updateError) {
        return internalError('POST /api/ai/nutrition', updateError, { userId: user.id });
      }

      return NextResponse.json({ success: true, nutritionData });
    }

    // 4. 画像URLが提供された場合はAI解析を実行
    if (imageUrl) {
      // 写真の URL を外国の AI 事業者へ送って栄養を推定する。同意が無ければ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)。
      // 栄養の数値をそのまま渡す保存 (上の nutritionData) は AI へ送らないので止めない
      const aiConsentDenied = await requireAiConsent(supabase, user.id);
      if (aiConsentDenied) return aiConsentDenied;

      // 食事写真・冷蔵庫写真のバケットの URL は、公開 URL のまま AI 事業者に渡さず、本人の写真であることを確かめて
      // 署名した URL を渡す (#1365)。他人の写真の URL は AI に渡さない (回数も数えない)。保存するのは送られた URL のまま
      if (typeof imageUrl !== 'string') {
        return NextResponse.json({ error: AI_IMAGE_URL_INVALID_MESSAGE }, { status: 400 });
      }
      const readable = await resolvePhotoUrlForOwnerRead(getSupabaseAdmin(), user.id, imageUrl);
      if (!readable.ok) {
        return NextResponse.json(
          { error: '写真を読み込めませんでした。写真を選び直してください。', code: 'PHOTO_NOT_READABLE' },
          { status: 403 },
        );
      }

      // nutritionData を直接渡す経路 (上) と、同意が無く止めた経路は AI を呼ばないので、数えるのは AI で解析するここだけ
      // #1149 AI の利用回数の上限の判定と記録 (#1177)。上限に達していれば数えずに 429 AI_DAILY_LIMIT (判定に失敗したときは止めない)
      const aiUsage = await consumeAiUsage(user.id, 'photo_analysis');
      if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

      const prompt = `
        この食事の写真を栄養士の視点で分析し、以下のJSON形式で出力してください。
        数値は概算で構いません。
        
        {
          "calories_kcal": number,
          "protein_g": number,
          "fat_g": number,
          "carbs_g": number,
          "veg_score": number (1-5),
          "quality_tags": ["タグ1", "タグ2"],
          "dishes": [{ "name": "料理名", "role": "main/side/soup" }]
        }
      `;

      try {
        const completion = await getFastLLMClient().chat.completions.create({
          model: getFastLLMModel(),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: readable.url } }
              ]
            }
          ],
          response_format: { type: "json_object" },
          max_tokens: 1000,
        } as any);

        const content = completion.choices?.[0]?.message?.content;
        
        if (!content) {
          return NextResponse.json({ error: AI_NUTRITION_ESTIMATE_FAILED_MESSAGE }, { status: 500 });
        }

        // JSONを抽出してパース
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

        if (!result) {
          return NextResponse.json({ error: AI_NUTRITION_ESTIMATE_FAILED_MESSAGE }, { status: 500 });
        }

        // DBを更新
        const baseDishes = Array.isArray(result.dishes)
          ? result.dishes.map((dish: any) => ({
              name: dish?.name ?? '料理',
              role: dish?.role ?? 'main',
            }))
          : [];
        const photoDishes = buildPhotoDishList(baseDishes, imageUrl);

        // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。本人の行に絞って service role で取り消す
        const queueDb = getAiQueueWriter();
        await cancelPendingMealImageJobs({
          supabase: queueDb,
          userId: user.id,
          plannedMealId,
          reason: 'nutrition photo overwrite',
        });

        // #1205: AI の推定値は桁を間違えることがあるため、範囲内に整えてから保存する
        // （数値でない・負 → null、上限超え → 上限、小数 → 四捨五入。応答に含まれない項目は書かない）
        const aiNutrients: PlannedMealNutrientValues = {};
        for (const field of PLANNED_MEAL_NUTRIENT_FIELDS) {
          const value = sanitizeAiNutrient(field, result[field]);
          if (value !== undefined) aiNutrients[field] = value;
        }

        const updatePayload: Record<string, unknown> = {
          ...aiNutrients,
          veg_score: result.veg_score,
          quality_tags: result.quality_tags,
          dishes: photoDishes.length > 0 ? photoDishes : existing.dishes ?? null,
          image_url: imageUrl,
          updated_at: new Date().toISOString(),
        };
        if (photoDishes.length > 0) {
          updatePayload.is_simple = photoDishes.length <= 1;
        } else {
          updatePayload.is_simple = existing.is_simple ?? null;
        }

        const { error: updateError } = await supabase
          .from('planned_meals')
          .update(updatePayload)
          .eq('id', plannedMealId);

        if (updateError) {
          return internalError('POST /api/ai/nutrition', updateError, { userId: user.id });
        }

        return NextResponse.json({ success: true, nutritionData: result });

      } catch (aiError: any) {
        return internalError('POST /api/ai/nutrition', aiError, { userId: user.id });
      }
    }

    return NextResponse.json({ error: AI_NUTRITION_INPUT_REQUIRED_MESSAGE }, { status: 400 });

  } catch (error: any) {
    return internalError('POST /api/ai/nutrition', error);
  }
}
