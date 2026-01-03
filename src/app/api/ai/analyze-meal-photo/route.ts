import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 食事写真分析 API Route (v2 - エビデンスベース)
 * 
 * Gemini 3 Pro で画像認識 → 材料マッチング → 栄養計算 → エビデンス検証
 */

// 型定義
interface ImageInput {
  base64: string;
  mimeType: string;
}

interface EstimatedIngredient {
  name: string;
  amount_g: number;
}

interface GeminiDish {
  name: string;
  role: string;
  estimatedIngredients: EstimatedIngredient[];
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { images, imageBase64, mimeType, mealType, mealId } = body;
    
    const imageDataArray: ImageInput[] = images || 
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
    
    // mealId がない場合は同期的に解析
    const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    
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
    
    // Step 1: Gemini 3 Pro で画像認識（材料・分量推定）
    const geminiPrompt = `あなたは「ほめゴハン」という食事管理アプリのAIアシスタントです。
この${imageCountText}${mealTypeJa}の写真を分析してください。

各料理について、**材料と分量を推定**してください。

以下のJSON形式で回答してください：

{
  "dishes": [
    {
      "name": "料理名",
      "role": "main または side または soup または rice または salad または dessert",
      "estimatedIngredients": [
        { "name": "材料名（一般的な食材名で）", "amount_g": 推定量(g) }
      ]
    }
  ]
}

注意：
- 全ての写真に写っている全ての料理を含めてください
- 材料名は「鶏もも肉」「白米」「味噌」など一般的な食材名で記載
- 分量は1人前として推定してください
- 調味料（塩、砂糖、しょうゆ等）も含めてください
- roleは料理の種類に応じて設定
- JSONのみを出力してください`;

    // Gemini 3 Pro を使用
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${GOOGLE_AI_API_KEY}`;
    
    const parts: any[] = imageDataArray.map(img => ({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64
      }
    }));
    parts.push({ text: geminiPrompt });
    
    const geminiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096,
        }
      })
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error('Gemini API error:', errorText);
      return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
    }

    const geminiData = await geminiResponse.json();
    const textContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse AI response:', textContent);
      return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 });
    }
    
    const geminiResult: { dishes: GeminiDish[] } = JSON.parse(jsonMatch[0]);

    // Step 2-4: 材料マッチング → 栄養計算 → エビデンス検証
    // Note: API Routeでは簡易版を実行（フル版はEdge Functionで）
    const analyzedDishes: any[] = [];
    let totalCalories = 0;
    let totalProtein = 0;
    let totalCarbs = 0;
    let totalFat = 0;
    const matchedIngredients: any[] = [];

    for (const dish of geminiResult.dishes) {
      // 材料マッチング（ベクトル検索）
      const dishIngredients: any[] = [];
      let dishCalories = 0;
      let dishProtein = 0;
      let dishCarbs = 0;
      let dishFat = 0;

      for (const ingredient of dish.estimatedIngredients) {
        // OpenAI Embedding生成
        let matched = null;
        if (OPENAI_API_KEY) {
          try {
            const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'text-embedding-3-large',
                input: ingredient.name,
                dimensions: 1536,
              }),
            });

            if (embeddingResponse.ok) {
              const embeddingData = await embeddingResponse.json();
              const embedding = embeddingData.data[0].embedding;

              // ベクトル検索
              const { data: searchResults } = await supabase.rpc('search_ingredients_full_by_embedding', {
                query_embedding: embedding,
                match_count: 1,
              });

              if (searchResults && searchResults.length > 0) {
                const best = searchResults[0];
                const factor = ingredient.amount_g / 100;
                const discardRate = best.discard_rate_percent || 0;
                const effectiveFactor = factor * (1 - discardRate / 100);

                dishCalories += (best.calories_kcal || 0) * effectiveFactor;
                dishProtein += (best.protein_g || 0) * effectiveFactor;
                dishCarbs += (best.carbs_g || 0) * effectiveFactor;
                dishFat += (best.fat_g || 0) * effectiveFactor;

                matched = {
                  id: best.id,
                  name: best.name,
                  similarity: best.similarity,
                };

                matchedIngredients.push({
                  input: ingredient.name,
                  matchedName: best.name,
                  matchedId: best.id,
                  similarity: best.similarity,
                  amount_g: ingredient.amount_g,
                });
              }
            }
          } catch (e) {
            console.warn('Ingredient matching failed:', e);
          }
        }

        dishIngredients.push({
          name: ingredient.name,
          amount_g: ingredient.amount_g,
          matched,
        });
      }

      analyzedDishes.push({
        name: dish.name,
        role: dish.role,
        calories_kcal: Math.round(dishCalories),
        protein_g: Math.round(dishProtein * 10) / 10,
        carbs_g: Math.round(dishCarbs * 10) / 10,
        fat_g: Math.round(dishFat * 10) / 10,
        ingredient: dish.estimatedIngredients.map(i => i.name).slice(0, 3).join('、'),
        ingredients: dishIngredients,
      });

      totalCalories += dishCalories;
      totalProtein += dishProtein;
      totalCarbs += dishCarbs;
      totalFat += dishFat;
    }

    // Step 4: エビデンス検証（代表料理で）
    const mainDish = analyzedDishes.find(d => d.role === 'main') || analyzedDishes[0];
    let referenceRecipes: any[] = [];
    let verification = {
      isVerified: false,
      calculatedCalories: Math.round(totalCalories),
      referenceCalories: null as number | null,
      deviationPercent: null as number | null,
      reason: 'no_reference' as string,
    };

    if (mainDish) {
      const { data: recipes } = await supabase.rpc('search_recipes_with_nutrition', {
        query_name: mainDish.name,
        similarity_threshold: 0.3,
        result_limit: 3,
      });

      if (recipes && recipes.length > 0) {
        referenceRecipes = recipes.map((r: any) => ({
          id: r.id,
          name: r.name,
          calories_kcal: r.calories_kcal,
          similarity: r.similarity,
        }));

        const ref = recipes[0];
        if (ref.calories_kcal) {
          const deviation = Math.abs((totalCalories - ref.calories_kcal) / ref.calories_kcal) * 100;
          verification = {
            isVerified: deviation <= 50,
            calculatedCalories: Math.round(totalCalories),
            referenceCalories: ref.calories_kcal,
            deviationPercent: Math.round(deviation * 10) / 10,
            reason: deviation <= 20 ? 'ok' : deviation <= 50 ? 'high_deviation' : 'excessive_deviation',
          };
        }
      }
    }

    // 信頼度スコア計算
    const matchRate = matchedIngredients.length / Math.max(1, geminiResult.dishes.reduce((sum, d) => sum + d.estimatedIngredients.length, 0));
    let confidenceScore = matchRate;
    if (verification.isVerified) {
      confidenceScore = verification.reason === 'ok' ? Math.min(confidenceScore * 1.1, 1.0) : confidenceScore * 0.85;
    } else {
      confidenceScore = verification.reason === 'no_reference' ? confidenceScore * 0.7 : confidenceScore * 0.5;
    }
    confidenceScore = Math.max(0.1, Math.min(1.0, Math.round(confidenceScore * 100) / 100));

    // Step 5: 褒めコメント生成
    const praisePrompt = `料理: ${analyzedDishes.map(d => d.name).join('、')}
カロリー: ${Math.round(totalCalories)}kcal

以下のJSON形式で回答：
{
  "praiseComment": "良いところを見つけて褒めるコメント（80-120文字、絵文字1-2個使用）",
  "nutritionTip": "この食事に関連する豆知識（40-60文字）",
  "overallScore": 総合スコア（70-95の数値）,
  "vegScore": 野菜スコア（0-100の数値）
}`;

    let praiseResult = {
      praiseComment: 'おいしそうな食事ですね！バランスの良い食事を心がけていて素晴らしいです✨',
      nutritionTip: '食事を楽しむことも健康の大切な要素です。',
      overallScore: 80,
      vegScore: 50,
    };

    try {
      const praiseResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: praisePrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
        })
      });

      if (praiseResponse.ok) {
        const praiseData = await praiseResponse.json();
        const praiseText = praiseData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const praiseMatch = praiseText.match(/\{[\s\S]*\}/);
        if (praiseMatch) {
          const parsed = JSON.parse(praiseMatch[0]);
          praiseResult = {
            praiseComment: parsed.praiseComment || praiseResult.praiseComment,
            nutritionTip: parsed.nutritionTip || praiseResult.nutritionTip,
            overallScore: parsed.overallScore || praiseResult.overallScore,
            vegScore: parsed.vegScore || praiseResult.vegScore,
          };
        }
      }
    } catch (e) {
      console.warn('Praise generation failed:', e);
    }

    return NextResponse.json({
      dishes: analyzedDishes,
      totalCalories: Math.round(totalCalories),
      totalProtein: Math.round(totalProtein * 10) / 10,
      totalCarbs: Math.round(totalCarbs * 10) / 10,
      totalFat: Math.round(totalFat * 10) / 10,
      
      nutrition: {
        sodiumG: 0, // 簡易版では省略
        fiberG: 0,
        potassiumMg: 0,
        calciumMg: 0,
        ironMg: 0,
        vitaminCMg: 0,
      },
      
      evidence: {
        calculationMethod: 'ingredient_based',
        matchedIngredients,
        referenceRecipes,
        verification,
        confidenceScore,
      },
      
      overallScore: praiseResult.overallScore,
      vegScore: praiseResult.vegScore,
      praiseComment: praiseResult.praiseComment,
      nutritionTip: praiseResult.nutritionTip,
      nutritionalAdvice: praiseResult.praiseComment, // 後方互換性
    });

  } catch (error: any) {
    console.error("Photo Analysis Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
