import { generateGeminiJson } from '../../../../lib/ai/gemini-json';
import {
  classifyPhotoSchema,
  normalizeClassifyPhotoResult,
  type ClassifyPhotoResult,
  type PhotoType,
} from '../../../../lib/ai/image-recognition';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

interface ImageInput {
  base64: string;
  mimeType?: string;
}

export type { PhotoType };

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

JSONで返してください。candidates には有力候補を高い順に最大3件まで入れてください。description は20文字程度で簡潔にしてください。`;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const images: ImageInput[] = Array.isArray(body.images) && body.images.length > 0
      ? body.images
      : body.imageBase64
        ? [{ base64: body.imageBase64, mimeType: body.mimeType || 'image/jpeg' }]
        : [];

    if (images.length === 0) {
      return NextResponse.json({ error: 'Image Base64 is required' }, { status: 400 });
    }

    const { data, model } = await generateGeminiJson<ClassifyPhotoResult>({
      prompt: buildPrompt(images.length),
      schema: classifyPhotoSchema as unknown as Record<string, unknown>,
      images,
      temperature: 0.1,
      maxOutputTokens: 512,
    });

    const result = normalizeClassifyPhotoResult(data);

    return NextResponse.json({
      ...result,
      modelUsed: model,
    });
  } catch (error: any) {
    console.error('Photo Classification Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
