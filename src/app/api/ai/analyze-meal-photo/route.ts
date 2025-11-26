import { createClient } from '@/lib/supabase/server';

import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { imageBase64, mimeType, mealType, mealId } = body;

    if (!imageBase64) {
      return NextResponse.json({ error: 'Image is required' }, { status: 400 });
    }

    // mealId がある場合は非同期でEdge Functionを呼び出す（既存の献立更新）
    if (mealId) {
      const { error: invokeError } = await supabase.functions.invoke('analyze-meal-photo', {
        body: {
          imageBase64,
          mimeType: mimeType || 'image/jpeg',
          mealId,
          mealType,
          userId: user.id,
        },
      });

      if (invokeError) {
        throw new Error(`Edge Function invoke failed: ${invokeError.message}`);
      }

      return NextResponse.json({ 
        success: true,
        message: 'Photo analysis started in background',
        status: 'processing'
      });
    }
    
    // mealId がない場合は同期的にGemini APIで解析して結果を返す（カメラボタンからの新規入力）
    const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
    
    if (!GOOGLE_AI_API_KEY) {
      return NextResponse.json({ error: 'AI API key not configured' }, { status: 500 });
    }

    const mealTypeJa = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : '夕食';

    const prompt = `この${mealTypeJa}の写真を分析してください。

以下のJSON形式で、写真に写っている全ての料理を特定し、それぞれの栄養情報を推定してください：

{
  "dishes": [
    {
      "name": "料理名",
      "role": "main または side または soup または rice または salad",
      "cal": 推定カロリー（数値）,
      "ingredient": "主な食材"
    }
  ],
  "totalCalories": 合計カロリー（数値）,
  "nutritionalAdvice": "この食事についての簡単なコメント（30文字程度）"
}

注意：
- 写真に写っている全ての料理を含めてください
- カロリーは1人前として推定してください
- roleは料理の種類に応じて適切に設定してください（主菜=main, 副菜=side, 汁物=soup, ご飯類=rice, サラダ=salad）
- JSONのみを出力してください`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_AI_API_KEY}`;
    
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
          temperature: 0.4,
          maxOutputTokens: 2048,
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
    
    return NextResponse.json({
      dishes: analysisResult.dishes || [],
      totalCalories: analysisResult.totalCalories || 0,
      nutritionalAdvice: analysisResult.nutritionalAdvice || '',
    });

  } catch (error: any) {
    console.error("Photo Analysis Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
