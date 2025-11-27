import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { imageUrl, imageBase64, mimeType } = body;

    // imageUrlまたはimageBase64が必要
    if (!imageUrl && !imageBase64) {
      return NextResponse.json({ error: 'Image URL or Base64 is required' }, { status: 400 });
    }

    const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
    
    if (!GOOGLE_AI_API_KEY) {
      return NextResponse.json({ error: 'AI API key not configured' }, { status: 500 });
    }

    const prompt = `この冷蔵庫の中身の写真を分析してください。

以下のJSON形式で、写真に写っている食材を特定してください：

{
  "ingredients": [
    {
      "name": "食材名",
      "category": "野菜 または 肉類 または 魚介類 または 乳製品 または 卵 または 調味料 または 飲料 または その他",
      "quantity": "おおよその量（例：1本、200g、1パック）",
      "freshness": "fresh または good または expiring_soon または expired",
      "daysRemaining": 推定残り日数（数値、不明な場合は-1）
    }
  ],
  "summary": "冷蔵庫の中身の概要（50文字程度）",
  "suggestions": ["この食材で作れそうな料理の提案1", "提案2", "提案3"]
}

注意：
- 見えている全ての食材を含めてください
- 鮮度は見た目から推測してください（fresh=新鮮、good=良好、expiring_soon=早めに使った方が良い、expired=期限切れの可能性）
- 量は見た目からおおよそで推定してください
- JSONのみを出力してください`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_AI_API_KEY}`;
    
    // 画像データの準備
    let imagePart: any;
    
    if (imageBase64) {
      // Base64形式の場合
      imagePart = {
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: imageBase64
        }
      };
    } else if (imageUrl) {
      // URL形式の場合 - 画像をダウンロードしてBase64に変換
      try {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          throw new Error('Failed to fetch image');
        }
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64 = Buffer.from(imageBuffer).toString('base64');
        const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
        
        imagePart = {
          inlineData: {
            mimeType: contentType,
            data: base64
          }
        };
      } catch (fetchError) {
        console.error('Failed to fetch image from URL:', fetchError);
        return NextResponse.json({ error: 'Failed to fetch image from URL' }, { status: 400 });
      }
    }
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            imagePart,
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096,
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', errorText);
      return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
    }

    const data = await response.json();
    const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // JSONを抽出
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse AI response:', textContent);
      return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 });
    }
    
    const analysisResult = JSON.parse(jsonMatch[0]);
    
    // 食材名のリストを抽出（献立リクエストページで使用）
    const ingredientNames = (analysisResult.ingredients || []).map((i: any) => i.name);
    
    return NextResponse.json({
      ingredients: ingredientNames,
      detailedIngredients: analysisResult.ingredients || [],
      summary: analysisResult.summary || '',
      suggestions: analysisResult.suggestions || [],
    });

  } catch (error: any) {
    console.error("Fridge Analysis Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

