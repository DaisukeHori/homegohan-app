import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    // 複数枚対応: images配列または従来のimageBase64を受け付ける
    const { images, imageBase64, mimeType, mealType, mealId } = body;
    
    // images配列がある場合は複数枚、なければ従来の単一画像
    const imageDataArray: { base64: string; mimeType: string }[] = images || 
      (imageBase64 ? [{ base64: imageBase64, mimeType: mimeType || 'image/jpeg' }] : []);

    if (imageDataArray.length === 0) {
      return NextResponse.json({ error: 'Image is required' }, { status: 400 });
    }

    // mealId がある場合は非同期でEdge Functionを呼び出す（既存の献立更新）
    if (mealId) {
      const { error: invokeError } = await supabase.functions.invoke('analyze-meal-photo', {
        body: {
          images: imageDataArray,
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

    const mealTypeJa = mealType === 'breakfast' ? '朝食' 
      : mealType === 'lunch' ? '昼食' 
      : mealType === 'dinner' ? '夕食'
      : mealType === 'snack' ? 'おやつ'
      : mealType === 'midnight_snack' ? '夜食'
      : '食事';

    const imageCountText = imageDataArray.length > 1 ? `${imageDataArray.length}枚の` : '';
    const prompt = `あなたは「ほめゴハン」という食事管理アプリのAIアシスタントです。
ユーザーの食事を分析し、**良いところを見つけて褒める**ことが最も重要な役割です。

この${imageCountText}${mealTypeJa}の写真を分析してください。

以下のJSON形式で回答してください：

{
  "dishes": [
    {
      "name": "料理名",
      "role": "main または side または soup または rice または salad または dessert",
      "cal": 推定カロリー（数値）,
      "protein": 推定タンパク質（g、数値）,
      "carbs": 推定炭水化物（g、数値）,
      "fat": 推定脂質（g、数値）,
      "ingredient": "主な食材"
    }
  ],
  "totalCalories": 合計カロリー（数値）,
  "totalProtein": 合計タンパク質（g、数値）,
  "totalCarbs": 合計炭水化物（g、数値）,
  "totalFat": 合計脂質（g、数値）,
  "overallScore": 総合スコア（0-100の数値、栄養バランス・彩り・食材の多様性を考慮）,
  "vegScore": 野菜スコア（0-100の数値、野菜の量と種類を考慮）,
  "praiseComment": "【重要】この食事の良いところを見つけて、温かく褒めるコメント（80-120文字程度）。絵文字を1-2個使用。ダメ出しは絶対にしない。例：「わぁ、すごい彩り！アボカドの良質な脂質と、たっぷりの野菜でビタミンもバッチリですね。見た目も美しくて、食べるのがもったいないくらい✨」",
  "nutritionTip": "この食事に関連する豆知識（40-60文字程度）。例：「アボカドは「森のバター」と呼ばれるほど栄養豊富。ビタミンEで美肌効果も期待できます！」"
}

注意：
- 全ての写真に写っている全ての料理を含めてください
- カロリー・栄養素は1人前として推定してください
- roleは料理の種類に応じて適切に設定してください（主菜=main, 副菜=side, 汁物=soup, ご飯類=rice, サラダ=salad, デザート/おやつ=dessert）
- praiseCommentは必ずポジティブな内容にしてください。批判や改善提案は含めないでください
- overallScoreは厳しすぎず、70-95の範囲で評価してください（普通の食事でも75以上）
- JSONのみを出力してください`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_AI_API_KEY}`;
    
    // 複数枚の画像をpartsに追加
    const parts: any[] = imageDataArray.map(img => ({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64
      }
    }));
    parts.push({ text: prompt });
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: parts
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
      totalProtein: analysisResult.totalProtein || 0,
      totalCarbs: analysisResult.totalCarbs || 0,
      totalFat: analysisResult.totalFat || 0,
      overallScore: analysisResult.overallScore || 75,
      vegScore: analysisResult.vegScore || 50,
      praiseComment: analysisResult.praiseComment || 'おいしそうな食事ですね！',
      nutritionTip: analysisResult.nutritionTip || '',
      // 後方互換性のため
      nutritionalAdvice: analysisResult.praiseComment || analysisResult.nutritionalAdvice || '',
    });

  } catch (error: any) {
    console.error("Photo Analysis Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
