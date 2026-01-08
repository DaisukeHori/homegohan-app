import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getNutrientDefinition, calculateDriPercentage } from '@/lib/nutrition-constants';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { date, nutrition, mealCount, weekData } = body;

    if (!nutrition) {
      return NextResponse.json({ error: 'Nutrition data required' }, { status: 400 });
    }

    // 主要栄養素の達成率を計算
    const mainNutrients = ['caloriesKcal', 'proteinG', 'fatG', 'carbsG', 'fiberG', 'sodiumG', 'vitaminCMg', 'calciumMg', 'ironMg'];
    const nutrientAnalysis = mainNutrients.map(key => {
      const def = getNutrientDefinition(key);
      const value = nutrition[key] ?? 0;
      const percentage = calculateDriPercentage(key, value);
      return {
        name: def?.label ?? key,
        value: value.toFixed(def?.decimals ?? 1),
        unit: def?.unit ?? '',
        percentage,
        status: percentage >= 80 && percentage <= 120 ? '適正' : percentage < 50 ? '不足' : percentage > 150 ? '過剰' : '目標に近い',
      };
    });

    // 週間の献立サマリー
    const weekSummary = weekData?.map((d: any) => `${d.date}: ${d.meals?.map((m: any) => m.title).join(', ') || '献立なし'}`).join('\n') || '';

    // LLMプロンプト
    const prompt = `あなたは管理栄養士です。以下の1日の栄養データを分析し、改善点や良い点を簡潔にコメントしてください。

## 対象日: ${date}
## 食事数: ${mealCount}食

## 主要栄養素の摂取状況:
${nutrientAnalysis.map(n => `- ${n.name}: ${n.value}${n.unit} (推奨量の${n.percentage}% - ${n.status})`).join('\n')}

## 今週の献立:
${weekSummary}

## 出力形式:
- 2〜3文で簡潔に
- 具体的な改善提案があれば1つ
- 絵文字は使わない
- 専門用語は避けてわかりやすく`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'system',
            content: 'あなたは親しみやすい管理栄養士です。ユーザーの食生活を優しく、前向きにアドバイスします。',
          },
          { role: 'user', content: prompt },
        ],
        max_completion_tokens: 300,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('OpenAI API error:', errorData);
      return NextResponse.json({ error: 'AI分析に失敗しました' }, { status: 500 });
    }

    const data = await response.json();
    const feedback = data.choices?.[0]?.message?.content?.trim() || '分析結果を取得できませんでした。';

    return NextResponse.json({ feedback });
  } catch (error: any) {
    console.error('Nutrition feedback error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
