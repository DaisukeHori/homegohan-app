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
  
  "nutrition": {
    "sodium_g": ナトリウム（塩分）g,
    "amino_acid_g": アミノ酸 g（タンパク質とほぼ同等）,
    "sugar_g": 糖質 g,
    "fiber_g": 食物繊維 g,
    "fiber_soluble_g": 水溶性食物繊維 g,
    "fiber_insoluble_g": 不溶性食物繊維 g,
    "potassium_mg": カリウム mg,
    "calcium_mg": カルシウム mg,
    "phosphorus_mg": リン mg,
    "iron_mg": 鉄分 mg,
    "zinc_mg": 亜鉛 mg,
    "iodine_ug": ヨウ素 µg,
    "cholesterol_mg": コレステロール mg,
    "vitamin_b1_mg": ビタミンB1 mg,
    "vitamin_b2_mg": ビタミンB2 mg,
    "vitamin_c_mg": ビタミンC mg,
    "vitamin_b6_mg": ビタミンB6 mg,
    "vitamin_b12_ug": ビタミンB12 µg,
    "folic_acid_ug": 葉酸 µg,
    "vitamin_a_ug": ビタミンA µg,
    "vitamin_d_ug": ビタミンD µg,
    "vitamin_k_ug": ビタミンK µg,
    "vitamin_e_mg": ビタミンE mg,
    "saturated_fat_g": 飽和脂肪酸 g,
    "monounsaturated_fat_g": 一価不飽和脂肪酸 g,
    "polyunsaturated_fat_g": 多価不飽和脂肪酸 g
  },
  
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
- nutritionオブジェクト内の全ての栄養素を推定してください（日本食品標準成分表を参考に）
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
    
    const nutrition = analysisResult.nutrition || {};
    
    return NextResponse.json({
      dishes: analysisResult.dishes || [],
      totalCalories: analysisResult.totalCalories || 0,
      totalProtein: analysisResult.totalProtein || 0,
      totalCarbs: analysisResult.totalCarbs || 0,
      totalFat: analysisResult.totalFat || 0,
      
      // 拡張栄養素
      nutrition: {
        sodiumG: nutrition.sodium_g || 0,
        aminoAcidG: nutrition.amino_acid_g || 0,
        sugarG: nutrition.sugar_g || 0,
        fiberG: nutrition.fiber_g || 0,
        fiberSolubleG: nutrition.fiber_soluble_g || 0,
        fiberInsolubleG: nutrition.fiber_insoluble_g || 0,
        potassiumMg: nutrition.potassium_mg || 0,
        calciumMg: nutrition.calcium_mg || 0,
        phosphorusMg: nutrition.phosphorus_mg || 0,
        ironMg: nutrition.iron_mg || 0,
        zincMg: nutrition.zinc_mg || 0,
        iodineUg: nutrition.iodine_ug || 0,
        cholesterolMg: nutrition.cholesterol_mg || 0,
        vitaminB1Mg: nutrition.vitamin_b1_mg || 0,
        vitaminB2Mg: nutrition.vitamin_b2_mg || 0,
        vitaminCMg: nutrition.vitamin_c_mg || 0,
        vitaminB6Mg: nutrition.vitamin_b6_mg || 0,
        vitaminB12Ug: nutrition.vitamin_b12_ug || 0,
        folicAcidUg: nutrition.folic_acid_ug || 0,
        vitaminAUg: nutrition.vitamin_a_ug || 0,
        vitaminDUg: nutrition.vitamin_d_ug || 0,
        vitaminKUg: nutrition.vitamin_k_ug || 0,
        vitaminEMg: nutrition.vitamin_e_mg || 0,
        saturatedFatG: nutrition.saturated_fat_g || 0,
        monounsaturatedFatG: nutrition.monounsaturated_fat_g || 0,
        polyunsaturatedFatG: nutrition.polyunsaturated_fat_g || 0,
      },
      
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
