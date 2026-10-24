import { generateGeminiJson } from '../../../../lib/ai/gemini-json';
import {
  countExtractedHealthFields,
  healthCheckupSchema,
  normalizeHealthCheckupExtractedData,
  type HealthCheckupExtractedData,
} from '../../../../lib/ai/image-recognition';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, AI_USAGE_COVERED_BY_GRANT, redeemAiUsageGrant } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_IMAGE_REQUIRED_MESSAGE, AI_PHOTO_MODE_MISMATCH_CODE } from '@/lib/ai/ai-api-messages';

function buildPrompt(): string {
  return `この健康診断結果の画像から、読み取れる検査値を抽出してください。

方針:
- 読み取れた項目だけを返してください
- 数値は単位を含めず純粋な数値にしてください
- 不明確な値は null にしてください
- 日付は読み取れた場合のみ YYYY-MM-DD 形式にしてください
- notes は不明瞭な点や注意点を50文字程度で簡潔に書いてください
- confidence は画像全体の読み取り確実性を 0.0 から 1.0 で返してください`;
}

/** 422: 健康診断の結果票の写真から項目が読み取れなかった */
const HEALTH_CHECKUP_NOT_READABLE_MESSAGE = '健康診断結果が読み取れませんでした。健康診断書がはっきり写った写真を撮り直してください。';

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
    const { imageBase64, mimeType } = body;

    if (!imageBase64) {
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

    const { data, model } = await generateGeminiJson<HealthCheckupExtractedData>({
      prompt: buildPrompt(),
      schema: healthCheckupSchema as unknown as Record<string, unknown>,
      images: [{ base64: imageBase64, mimeType: mimeType || 'image/jpeg' }],
      temperature: 0.1,
      maxOutputTokens: 4096,
      signal: AbortSignal.timeout(25_000),
    });

    const extractedData = normalizeHealthCheckupExtractedData(data);
    const fieldCount = countExtractedHealthFields(extractedData);

    if (fieldCount === 0) {
      return NextResponse.json(
        { error: HEALTH_CHECKUP_NOT_READABLE_MESSAGE, code: AI_PHOTO_MODE_MISMATCH_CODE, message: HEALTH_CHECKUP_NOT_READABLE_MESSAGE },
        { status: 422 },
      );
    }

    return NextResponse.json({
      extractedData,
      fieldCount,
      confidence: extractedData.confidence,
      notes: extractedData.notes,
      modelUsed: model,
    });
  } catch (error: any) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (isTimeout) {
      console.error('Health Checkup Analysis: AI timeout after 25s');
      return NextResponse.json(
        { error: 'AI が応答しませんでした、もう一度お試しください' },
        { status: 504 },
      );
    }
    return internalError('POST /api/ai/analyze-health-checkup', error, { userId: user.id });
  }
}
