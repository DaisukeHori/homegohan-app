import { generateGeminiJson } from '../../../../lib/ai/gemini-json';
import {
  aggregateClassifyPhotoResults,
  classifyPhotoSchema,
  normalizeClassifyPhotoResult,
  resolveClassifyPhotoType,
  DEFAULT_GEMINI_CLASSIFY_MODEL,
  type ClassifyPhotoResult,
  type PhotoType,
} from '../../../../lib/ai/image-recognition';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

interface ImageInput {
  base64: string;
  mimeType?: string;
}

const CLASSIFY_MODEL = process.env.GEMINI_CLASSIFY_MODEL || DEFAULT_GEMINI_CLASSIFY_MODEL;

export type { PhotoType };

function recoverClassificationFromRawText(rawText: string): ClassifyPhotoResult | null {
  const pairRegex = /"type"\s*:\s*"(meal|fridge|health_checkup|weight_scale|unknown)"[\s\S]{0,120}?"confidence"\s*:\s*([01](?:\.\d+)?)/;
  const pair = rawText.match(pairRegex);

  if (pair) {
    return normalizeClassifyPhotoResult({
      type: pair[1] as PhotoType,
      confidence: Number(pair[2]),
    });
  }

  const typeOnly = rawText.match(/"type"\s*:\s*"(meal|fridge|health_checkup|weight_scale|unknown)"/);
  if (!typeOnly) {
    return null;
  }

  return normalizeClassifyPhotoResult({
    type: typeOnly[1] as PhotoType,
    confidence: 0.7,
  });
}

function buildPrompt(imageCount: number): string {
  const imageCountText = imageCount > 1 ? `${imageCount}枚の` : '';

  return `この${imageCountText}画像セットの主な用途を判別してください。

以下の4つのカテゴリから最も適切なものを選んでください：

1. "meal" - 食事・料理の写真
2. "fridge" - 冷蔵庫の中身や買い物食材の写真
3. "health_checkup" - 健康診断結果や検査票など紙の書類
4. "weight_scale" - 体重計や体組成計のディスプレイ写真

判定ルール:
- 複数枚ある場合は、画像全体を見て最も一貫したカテゴリを選んでください
- 体重計ディスプレイ写真は必ず "weight_scale" を最優先で判定してください
- 紙の健康診断結果と体重計ディスプレイは厳密に区別してください
- 判断が難しい場合のみ "unknown" を選んでください

JSON では次の2項目だけ返してください:
- "type": 上記4カテゴリのいずれか
- "confidence": 0.0 から 1.0 の小数

説明文や候補配列は返さないでください。`;
}

async function requestClassification(images: ImageInput[]): Promise<{ result: ClassifyPhotoResult; model: string }> {
  const { data, model } = await generateGeminiJson<ClassifyPhotoResult>({
    prompt: buildPrompt(images.length),
    schema: classifyPhotoSchema as unknown as Record<string, unknown>,
    images,
    temperature: 0.1,
    maxOutputTokens: 96,
    model: CLASSIFY_MODEL,
    retryOnParseFailure: false,
  });

  return {
    result: normalizeClassifyPhotoResult(data),
    model,
  };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const startedAt = Date.now();
    const body = await request.json();
    const images: ImageInput[] = Array.isArray(body.images) && body.images.length > 0
      ? body.images
      : body.imageBase64
        ? [{ base64: body.imageBase64, mimeType: body.mimeType || 'image/jpeg' }]
        : [];

    if (images.length === 0) {
      return NextResponse.json({ error: 'Image Base64 is required' }, { status: 400 });
    }

    const classifyStartedAt = Date.now();
    const { result: initialResult, model } = await requestClassification(images);
    const classifyElapsedMs = Date.now() - classifyStartedAt;
    let result = initialResult;

    if (images.length > 1 && !resolveClassifyPhotoType(initialResult).type) {
      const fallbackStartedAt = Date.now();
      const perImageResults = await Promise.all(
        images.map(async (image) => (await requestClassification([image])).result),
      );
      const aggregatedResult = aggregateClassifyPhotoResults(perImageResults);
      console.info('Photo Classification: fell back to per-image aggregation', {
        imageCount: images.length,
        initial: initialResult,
        aggregated: aggregatedResult,
        fallbackElapsedMs: Date.now() - fallbackStartedAt,
      });
      result = aggregatedResult;
    }

    console.info('Photo Classification: completed', {
      imageCount: images.length,
      resolvedType: result.type,
      model,
      classifyElapsedMs,
      totalElapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ...result,
      modelUsed: model,
    });
  } catch (error: any) {
    const rawTexts = [
      typeof error?.rawText === 'string' ? error.rawText : '',
      typeof error?.firstRawText === 'string' ? error.firstRawText : '',
    ].filter(Boolean);

    for (const rawText of rawTexts) {
      const recovered = recoverClassificationFromRawText(rawText);
      if (recovered) {
        console.warn('Photo Classification: recovered from malformed JSON', {
          recovered,
          preview: rawText.slice(0, 160),
        });
        return NextResponse.json({
          ...recovered,
          modelUsed: CLASSIFY_MODEL,
          recovered: true,
        });
      }
    }

    console.error('Photo Classification Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
