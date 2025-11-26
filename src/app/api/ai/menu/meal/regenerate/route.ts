import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    const { mealName, mealType, dayIndex, weeklyMenuRequestId } = await request.json();

    if (!mealName || dayIndex === undefined || !weeklyMenuRequestId) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. 週献立リクエストを取得してユーザー所有を確認
    const { data: menuRequest, error: menuError } = await supabase
      .from('weekly_menu_requests')
      .select('*')
      .eq('id', weeklyMenuRequestId)
      .eq('user_id', user.id)
      .single();

    if (menuError || !menuRequest) {
      return NextResponse.json({ error: 'Weekly menu request not found' }, { status: 404 });
    }

    if (menuRequest.status !== 'completed') {
      return NextResponse.json({ error: 'Weekly menu must be completed before regenerating meals' }, { status: 400 });
    }

    // 3. ユーザープロファイルを取得（制約条件のため）
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', user.id)
      .single();

    // 4. Gemini API で新しい料理を生成
    const API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
    
    if (!API_KEY) {
      return NextResponse.json({ error: 'Google AI API Key is missing' }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    // プロンプト構築
    const constraints = menuRequest.constraints || {};
    const prompt = `Generate a single Japanese meal dish for ${mealType} that is:
- Suitable for ${mealName || 'a meal'}
- Appropriate for the meal type: ${mealType}
- Healthy and balanced
- Japanese cuisine style

${profile?.dietary_restrictions ? `Dietary restrictions: ${profile.dietary_restrictions}` : ''}
${constraints.familySize ? `Family size: ${constraints.familySize}` : ''}

Return ONLY a JSON object with this exact structure:
{
  "name": "料理名",
  "description": "簡潔な説明",
  "role": "main" | "side" | "soup" | "rice",
  "ingredients": ["材料1", "材料2"],
  "cookingTime": "15分",
  "calories": 350
}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // JSONを抽出（```json で囲まれている可能性がある）
    let jsonText = responseText.trim();
    if (jsonText.includes('```json')) {
      jsonText = jsonText.split('```json')[1].split('```')[0].trim();
    } else if (jsonText.includes('```')) {
      jsonText = jsonText.split('```')[1].split('```')[0].trim();
    }

    const newDish = JSON.parse(jsonText);

    // 5. 週献立の該当日の該当食事を更新
    const resultJson = menuRequest.result_json as any;
    if (!resultJson || !resultJson.days || !resultJson.days[dayIndex]) {
      return NextResponse.json({ error: 'Invalid menu structure' }, { status: 400 });
    }

    const day = resultJson.days[dayIndex];
    const meal = day.meals.find((m: any) => m.mealType === mealType);
    
    if (!meal) {
      return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
    }

    // 最初の料理を新しいものに置き換え
    meal.dishes[0] = {
      role: newDish.role || 'main',
      name: newDish.name,
      description: newDish.description || '',
    };

    // データベースを更新
    const { error: updateError } = await supabase
      .from('weekly_menu_requests')
      .update({ 
        result_json: resultJson,
        updated_at: new Date().toISOString()
      })
      .eq('id', weeklyMenuRequestId);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({ 
      success: true,
      dish: newDish,
      updatedMenu: resultJson
    });

  } catch (error: any) {
    console.error("Meal Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}



