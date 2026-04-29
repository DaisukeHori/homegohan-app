import { fetchImageAsBase64, generateGeminiJson } from '../../../../lib/ai/gemini-json';
import {
  fridgeAnalysisSchema,
  normalizeFridgeAnalysisResult,
  type FridgeAnalysisResult,
} from '../../../../lib/ai/image-recognition';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

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
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { imageUrl, imageBase64, mimeType } = body;

    if (!imageUrl && !imageBase64) {
      return NextResponse.json({ error: 'Image URL or Base64 is required' }, { status: 400 });
    }

    const images = imageBase64
      ? [{ base64: imageBase64, mimeType: mimeType || 'image/jpeg' }]
      : [await fetchImageAsBase64(imageUrl)];

    const { data, model } = await generateGeminiJson<FridgeAnalysisResult>({
      prompt: buildPrompt(images.length),
      schema: fridgeAnalysisSchema as unknown as Record<string, unknown>,
      images,
      temperature: 0.2,
      maxOutputTokens: 4096,
      signal: AbortSignal.timeout(25_000),
    });

    const analysisResult = normalizeFridgeAnalysisResult(data);

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
    console.error('Fridge Analysis Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
