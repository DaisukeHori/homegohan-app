import { createClient } from '@/lib/supabase/server';
import { extractWeightScaleResult } from '../../../../lib/ai/image-recognition';
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiUsageRecordedHeaders, aiDailyLimitResponse, consumeAiUsage, AI_USAGE_COVERED_BY_GRANT, redeemAiUsageGrant } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_IMAGE_REQUIRED_MESSAGE, AI_PHOTO_ANALYSIS_FAILED_MESSAGE, AI_PHOTO_MODE_MISMATCH_CODE } from '@/lib/ai/ai-api-messages';

/** 422: 体重計の写真から体重が読み取れなかった */
const WEIGHT_SCALE_NOT_READABLE_MESSAGE = '体重計の表示が読み取れませんでした。数値が鮮明に写った写真を撮り直してください。';

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)
  const aiConsentDenied = await requireAiConsent(supabase, user.id);
  if (aiConsentDenied) return aiConsentDenied;

  const rateLimitResult = await checkRateLimit(user.id, 'analysis');
  if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { image, mimeType } = body;

    if (!image) {
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

    // Edge Function を呼び出し（25秒タイムアウト）
    const formData = new FormData();
    formData.append('image_base64', image);
    formData.append('device_type', 'weight_scale');
    if (mimeType) {
      formData.append('mime_type', mimeType);
    }

    const invokePromise = supabase.functions.invoke('analyze-health-photo', {
      body: formData,
      // #1177 Edge Function はユーザーの JWT で呼ばれたときに利用回数を記録する。この API ルートが記録済みなので、
      // 二重に記録しないよう、署名つきの印を付ける
      headers: await aiUsageRecordedHeaders(user.id),
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AI タイムアウト')), 25_000),
    );

    const { data, error } = await Promise.race([invokePromise, timeoutPromise]) as Awaited<typeof invokePromise>;

    if (error) {
      console.error('Edge Function error:', error);
      return NextResponse.json({ error: AI_PHOTO_ANALYSIS_FAILED_MESSAGE }, { status: 500 });
    }

    // 結果を整形
    const result = extractWeightScaleResult(data);

    // 体重が取得できなかった場合
    if (!result.weight || result.weight <= 0) {
      return NextResponse.json(
        { error: WEIGHT_SCALE_NOT_READABLE_MESSAGE, code: AI_PHOTO_MODE_MISMATCH_CODE, message: WEIGHT_SCALE_NOT_READABLE_MESSAGE },
        { status: 422 },
      );
    }

    return NextResponse.json(result);

  } catch (error: any) {
    const isTimeout = error instanceof Error && error.message === 'AI タイムアウト';
    if (isTimeout) {
      console.error('Weight Scale Analysis: AI timeout after 25s');
      return NextResponse.json(
        { error: 'AI が応答しませんでした、もう一度お試しください' },
        { status: 504 },
      );
    }
    return internalError('POST /api/ai/analyze-weight-scale', error, { userId: user.id });
  }
}
