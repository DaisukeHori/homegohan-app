import { generateGeminiJson } from '../../../../lib/ai/gemini-json';
import {
  countExtractedHealthFields,
  healthCheckupSchema,
  normalizeHealthCheckupExtractedData,
  type HealthCheckupExtractedData,
} from '../../../../lib/ai/image-recognition';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

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

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { imageBase64, mimeType } = body;

    if (!imageBase64) {
      return NextResponse.json({ error: 'Image Base64 is required' }, { status: 400 });
    }

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
    console.error('Health Checkup Analysis Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
