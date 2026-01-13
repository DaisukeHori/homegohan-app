import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export type PhotoType = 'meal' | 'fridge' | 'health_checkup' | 'weight_scale' | 'unknown';

interface ClassifyResult {
  type: PhotoType;
  confidence: number;
  description: string;
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

    const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;

    if (!GOOGLE_AI_API_KEY) {
      return NextResponse.json({ error: 'AI API key not configured' }, { status: 500 });
    }

    const prompt = `この画像の種類を判別してください。

以下の4つのカテゴリから最も適切なものを選んでください：

1. "meal" - 食事・料理の写真（お皿に盛られた料理、調理済みの食べ物、レストランでの食事など）
2. "fridge" - 冷蔵庫の中身の写真（冷蔵庫内部、食材が並んでいる棚、買い物した食材など）
3. "health_checkup" - 健康診断結果の写真（血液検査結果、健康診断票、検査数値が記載された書類など紙の書類）
4. "weight_scale" - 体重計・体組成計の写真（体重計のディスプレイ、デジタル表示の数値、体脂肪率表示など）

以下のJSON形式で回答してください：
{
  "type": "meal" または "fridge" または "health_checkup" または "weight_scale" または "unknown",
  "confidence": 0.0〜1.0の信頼度,
  "description": "判別理由を20文字程度で"
}

注意：
- 上記4つに明らかに該当しない場合は "unknown" としてください
- 体重計のディスプレイ写真は必ず "weight_scale" としてください
- 紙の健康診断結果と体重計ディスプレイを区別してください
- JSONのみを出力してください`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GOOGLE_AI_API_KEY}`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inlineData: {
                mimeType: mimeType || 'image/jpeg',
                data: imageBase64
              }
            },
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.1, // 低温で安定した分類
          maxOutputTokens: 256,
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', errorText);
      return NextResponse.json({ error: 'AI classification failed' }, { status: 500 });
    }

    const data = await response.json();
    const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // JSONを抽出
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse AI response:', textContent);
      return NextResponse.json({
        type: 'unknown' as PhotoType,
        confidence: 0,
        description: 'Failed to parse AI response'
      });
    }

    const result: ClassifyResult = JSON.parse(jsonMatch[0]);

    // typeのバリデーション
    const validTypes: PhotoType[] = ['meal', 'fridge', 'health_checkup', 'weight_scale', 'unknown'];
    if (!validTypes.includes(result.type)) {
      result.type = 'unknown';
    }

    return NextResponse.json(result);

  } catch (error: any) {
    console.error("Photo Classification Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
