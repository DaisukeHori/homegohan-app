import { fetchImageAsBase64, generateGeminiJson, type GeminiImageInput } from '../../../../lib/ai/gemini-json';
import {
  fridgeAnalysisSchema,
  normalizeFridgeAnalysisResult,
  type FridgeAnalysisResult,
} from '../../../../lib/ai/image-recognition';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { resolvePhotoUrlForOwnerRead } from '@/lib/photo-storage-signing';
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, AI_USAGE_COVERED_BY_GRANT, redeemAiUsageGrant } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_IMAGE_REQUIRED_MESSAGE, AI_PHOTO_MODE_MISMATCH_CODE } from '@/lib/ai/ai-api-messages';

/** 送られた写真の URL が、本人の写真として読めないとき (他人の写真・消えた写真) の文面 (#1365) */
/** 422: 冷蔵庫の写真から食材が読み取れなかった */
const FRIDGE_NOT_READABLE_MESSAGE = '食材が読み取れませんでした。冷蔵庫の中身が見える写真を撮り直してください。';
const PHOTO_NOT_READABLE_MESSAGE = '写真を読み込めませんでした。もう一度撮影するか、写真を選び直してください。';

function buildPrompt(imageCount: number): string {
  const imageCountText = imageCount > 1 ? `${imageCount}枚の` : '';

  return `この${imageCountText}冷蔵庫写真を分析してください。

写っている食材を特定し、以下の方針で JSON を返してください:
- 同じ食材が複数枚に写っていても重複登録しない
- 鮮度は見た目から推定する
- quantity は「1本」「1パック」「200g」など概算でよい
- suggestions はこの食材群で作れそうな料理を最大3件
- summary は50文字程度で簡潔にする`;
}

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
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    // inventoryImageUrl は imageUrl の別名として受け付ける (App / WEB 統一)
    const { imageBase64, mimeType } = body;
    const imageUrl: string | undefined = body.imageUrl ?? body.inventoryImageUrl;

    let images: GeminiImageInput[];
    if (Array.isArray(body.images) && body.images.length > 0) {
      images = body.images;
    } else if (imageBase64) {
      images = [{ base64: imageBase64, mimeType: mimeType || 'image/jpeg' }];
    } else if (typeof imageUrl === 'string' && imageUrl.length > 0) {
      // 冷蔵庫写真のバケットの URL は、公開 URL のまま取りに行かず、本人の写真であることを確かめて署名した URL で読む (#1365)。
      // 他人の写真の URL は AI に渡さない
      const readable = await resolvePhotoUrlForOwnerRead(getSupabaseAdmin(), user.id, imageUrl);
      if (!readable.ok) {
        return NextResponse.json({ error: PHOTO_NOT_READABLE_MESSAGE, code: 'PHOTO_NOT_READABLE' }, { status: 403 });
      }
      images = [await fetchImageAsBase64(readable.url)];
    } else {
      images = [];
    }

    if (images.length === 0) {
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

    const { data, model } = await generateGeminiJson<FridgeAnalysisResult>({
      prompt: buildPrompt(images.length),
      schema: fridgeAnalysisSchema as unknown as Record<string, unknown>,
      images,
      temperature: 0.2,
      maxOutputTokens: 4096,
      signal: AbortSignal.timeout(25_000),
    });

    const analysisResult = normalizeFridgeAnalysisResult(data);

    if (!analysisResult.ingredients?.length) {
      return NextResponse.json(
        { error: FRIDGE_NOT_READABLE_MESSAGE, code: AI_PHOTO_MODE_MISMATCH_CODE, message: FRIDGE_NOT_READABLE_MESSAGE },
        { status: 422 },
      );
    }

    return NextResponse.json({
      ingredients: analysisResult.ingredients.map((ingredient) => ingredient.name),
      detailedIngredients: analysisResult.ingredients,
      summary: analysisResult.summary,
      suggestions: analysisResult.suggestions,
      modelUsed: model,
    });
  } catch (error: any) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (isTimeout) {
      console.error('Fridge Analysis: AI timeout after 25s');
      return NextResponse.json(
        { error: 'AI が応答しませんでした、もう一度お試しください' },
        { status: 504 },
      );
    }
    return internalError('POST /api/ai/analyze-fridge', error, { userId: user.id });
  }
}
