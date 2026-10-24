import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { GoogleGenAI, createUserContent } from '@google/genai';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage } from '@/lib/plan/entitlements';
import { userScopedStoragePath } from '@/lib/storage-paths';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { MissingEnvError } from '@/lib/env-required';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_IMAGE_PROMPT_REQUIRED_MESSAGE } from '@/lib/ai/ai-api-messages';

interface ReferenceImageInput {
  base64: string;
  mimeType?: string;
}

const DEFAULT_IMAGE_GENERATION_MODEL = 'gemini-3.1-flash-image-preview';

function normalizeReferenceImages(raw: unknown): ReferenceImageInput[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map<ReferenceImageInput | null>((item) => {
      const image = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
      const base64 = typeof image.base64 === 'string' && image.base64.trim() ? image.base64.trim() : null;
      if (!base64) return null;

      return {
        base64: base64.replace(/^data:image\/\w+;base64,/, ''),
        mimeType: typeof image.mimeType === 'string' && image.mimeType.trim() ? image.mimeType.trim() : 'image/png',
      };
    })
    .filter((image): image is ReferenceImageInput => image !== null);
}

/**
 * 画像生成の回数の上限 (Gemini の 429) に当たったときの文面。
 * Gemini が返した生のエラー文は本文に出さない (#1172。サーバーのログにだけ残す)
 */
const QUOTA_EXCEEDED_MESSAGE = '画像生成のクォータが超過しました。しばらく待ってから再度お試しください。';

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const requestBody = await request.json().catch(() => null);
    if (!requestBody || typeof requestBody !== 'object') {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { prompt, images } = requestBody;

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: AI_IMAGE_PROMPT_REQUIRED_MESSAGE }, { status: 400 });
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)
    const aiConsentDenied = await requireAiConsent(supabase, user.id);
    if (aiConsentDenied) return aiConsentDenied;

    const rateLimitResult = await checkRateLimit(user.id, 'image');
    if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

    const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
    if (!apiKey) {
      // 鍵が無い: 本文は汎用の文。変数名は MissingEnvError の envName として構造化ログにだけ残す (#1182・#1490)
      return internalError('POST /api/ai/image/generate', new MissingEnvError('GOOGLE_AI_STUDIO_API_KEY'), { userId: user.id });
    }

    const modelName = process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_GENERATION_MODEL;
    const ai = new GoogleGenAI({ apiKey });

    const enhancedPrompt = `Create a delicious, appetizing, professional food photography shot of ${prompt}. Natural lighting, high resolution, minimalist plating, Japanese cuisine style.`;
    const referenceImages = normalizeReferenceImages(images);

    // #1149 AI の利用回数の上限の判定と記録 (#1177)。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回数える。
    // 上限に達していれば数えずに 429 AI_DAILY_LIMIT (判定に失敗したときは止めない)
    const aiUsage = await consumeAiUsage(user.id, 'image_generation');
    if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

    let imageBase64 = '';
    let textResponse = '';

    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: createUserContent([
          enhancedPrompt,
          ...referenceImages.map((image) => ({
            inlineData: {
              mimeType: image.mimeType || 'image/png',
              data: image.base64,
            },
          })),
        ]),
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: '1:1',
          },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          textResponse += part.text;
        }
        if (part.inlineData?.mimeType?.startsWith('image/') && part.inlineData.data) {
          imageBase64 = part.inlineData.data;
          break;
        }
      }

      if (!imageBase64) {
        throw new Error('No image data in response. The model may not support image generation.');
      }
    } catch (genError: any) {
      console.error('Gemini Generation Error:', genError);

      const status = genError?.status || genError?.code;
      const rawMessage = typeof genError?.message === 'string' ? genError.message : '';
      if (status === 429 || rawMessage.includes('429')) {
        return NextResponse.json({
          error: QUOTA_EXCEEDED_MESSAGE,
          code: 'QUOTA_EXCEEDED',
          suggestion: 'Google AI Studioで Nano Banana 2 のクォータを確認してください: https://ai.google.dev/gemini-api/docs/image-generation',
        }, { status: 429 });
      }

      throw new Error(`Failed to generate image: ${rawMessage || 'Unknown error'}`);
    }

    const buffer = Buffer.from(imageBase64, 'base64');
    const bucketName = 'fridge-images';
    // 本人のフォルダ <user_id>/generated/ の下に保存する (storage.objects の RLS が本人のフォルダだけを許可する)
    const fileName = userScopedStoragePath(user.id, 'generated', `${Date.now()}.png`);

    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(fileName, buffer, {
        contentType: 'image/png',
        upsert: true,
        cacheControl: '3600',
      });

    if (uploadError) {
      // バケットが無い・Storage のポリシーで弾かれた、はどちらもサーバー側の設定の問題。
      // 生のエラー文・バケット名・設定の手順は本文に出さず (#1172)、構造化ログにだけ残す
      return internalError('POST /api/ai/image/generate', uploadError, { userId: user.id });
    }

    // 保存形 (公開 URL と同じ形の識別子。バケットは非公開なので、そのままでは読めない。表示は署名付き URL)
    const { data: { publicUrl } } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return NextResponse.json({
      imageUrl: publicUrl,
      modelUsed: modelName,
      referenceImageCount: referenceImages.length,
      text: textResponse.trim(),
    });
  } catch (error: any) {
    return internalError('POST /api/ai/image/generate', error);
  }
}
