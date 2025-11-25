import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    const { mealId, imageUrl } = await request.json();

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. OpenAI API呼び出し (Vision)
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API Key is not set');
    }

    const prompt = `
      この食事の写真を栄養士の視点で分析し、以下のJSON形式で出力してください。
      数値は概算で構いません。
      
      {
        "energy_kcal": number,
        "protein_g": number,
        "fat_g": number,
        "carbs_g": number,
        "veg_score": number (1-5),
        "dishes": [{ "name": string, "category": string }],
        "feedback": string (100文字程度のポジティブなコメント),
        "advice": string (50文字程度の改善アドバイス)
      }
    `;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4-vision-preview", // または gpt-4o
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } }
            ]
          }
        ],
        max_tokens: 1000,
      }),
    });

    const aiData = await response.json();
    
    // レスポンス解析（エラーハンドリング省略）
    const content = aiData.choices[0].message.content;
    // JSONブロックを探してパースする簡易実装
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!result) throw new Error('Failed to parse AI response');

    // 3. DB保存 (Nutrition Estimate)
    const { error: nutError } = await supabase
      .from('meal_nutrition_estimates')
      .insert({
        meal_id: mealId,
        energy_kcal: result.energy_kcal,
        protein_g: result.protein_g,
        fat_g: result.fat_g,
        carbs_g: result.carbs_g,
        veg_score: result.veg_score,
        raw_json: result,
      });

    // 4. DB保存 (Feedback)
    const { error: feedError } = await supabase
      .from('meal_ai_feedbacks')
      .insert({
        meal_id: mealId,
        feedback_text: result.feedback,
        advice_text: result.advice,
        model_name: 'gpt-4-vision',
      });

    return NextResponse.json({ success: true, result });

  } catch (error: any) {
    console.error('AI Analysis Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
