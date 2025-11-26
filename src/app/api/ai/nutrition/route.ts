import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 献立の栄養情報を更新
 * planned_mealsベース
 * 
 * 写真解析やAI推定結果をplanned_mealsに保存
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { plannedMealId, imageUrl, nutritionData } = await request.json();

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!plannedMealId) {
      return NextResponse.json({ error: 'plannedMealId is required' }, { status: 400 });
    }

    // 2. 所有権確認
    const { data: existing, error: existError } = await supabase
      .from('planned_meals')
      .select(`
        id,
        meal_plan_days!inner(
          meal_plans!inner(user_id)
        )
      `)
      .eq('id', plannedMealId)
      .eq('meal_plan_days.meal_plans.user_id', user.id)
      .single();

    if (existError || !existing) {
      return NextResponse.json({ error: 'Meal not found or unauthorized' }, { status: 404 });
    }

    // 3. 栄養データが直接提供された場合はそれを使用
    if (nutritionData) {
      const { error: updateError } = await supabase
        .from('planned_meals')
        .update({
          calories_kcal: nutritionData.calories_kcal,
          protein_g: nutritionData.protein_g,
          fat_g: nutritionData.fat_g,
          carbs_g: nutritionData.carbs_g,
          veg_score: nutritionData.veg_score,
          quality_tags: nutritionData.quality_tags,
          updated_at: new Date().toISOString(),
        })
        .eq('id', plannedMealId);

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, nutritionData });
    }

    // 4. 画像URLが提供された場合はAI解析を実行
    if (imageUrl) {
      // OpenAI Vision APIで解析
      if (!process.env.OPENAI_API_KEY) {
        return NextResponse.json({ error: 'OpenAI API Key is not configured' }, { status: 500 });
      }

      const prompt = `
        この食事の写真を栄養士の視点で分析し、以下のJSON形式で出力してください。
        数値は概算で構いません。
        
        {
          "calories_kcal": number,
          "protein_g": number,
          "fat_g": number,
          "carbs_g": number,
          "veg_score": number (1-5),
          "quality_tags": ["タグ1", "タグ2"],
          "dishes": [{ "name": "料理名", "role": "main/side/soup" }]
        }
      `;

      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
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
        const content = aiData.choices?.[0]?.message?.content;
        
        if (!content) {
          return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
        }

        // JSONを抽出してパース
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

        if (!result) {
          return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 });
        }

        // DBを更新
        const { error: updateError } = await supabase
          .from('planned_meals')
          .update({
            calories_kcal: result.calories_kcal,
            protein_g: result.protein_g,
            fat_g: result.fat_g,
            carbs_g: result.carbs_g,
            veg_score: result.veg_score,
            quality_tags: result.quality_tags,
            dishes: result.dishes,
            updated_at: new Date().toISOString(),
          })
          .eq('id', plannedMealId);

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, nutritionData: result });

      } catch (aiError: any) {
        console.error('AI Analysis Error:', aiError);
        return NextResponse.json({ error: 'AI analysis failed: ' + aiError.message }, { status: 500 });
      }
    }

    return NextResponse.json({ error: 'Either nutritionData or imageUrl is required' }, { status: 400 });

  } catch (error: any) {
    console.error('Nutrition API Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
