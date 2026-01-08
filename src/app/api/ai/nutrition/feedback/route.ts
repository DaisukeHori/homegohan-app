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

    // 全ての重要な栄養素の達成率を計算（より詳細な分析のため）
    const mainNutrients = [
      'caloriesKcal', 'proteinG', 'fatG', 'carbsG', 'fiberG', 
      'sodiumG', 'vitaminCMg', 'calciumMg', 'ironMg', 'vitaminAUg',
      'vitaminB1Mg', 'vitaminB2Mg', 'vitaminDUg', 'zincMg', 'magnesiumMg'
    ];
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

    // 不足・過剰な栄養素を抽出
    const deficient = nutrientAnalysis.filter(n => n.percentage < 50);
    const excess = nutrientAnalysis.filter(n => n.percentage > 150);
    const good = nutrientAnalysis.filter(n => n.percentage >= 80 && n.percentage <= 120);

    // 週間の献立サマリー（より詳細に）
    const weekSummary = weekData?.map((d: any) => {
      const dayMeals = d.meals?.map((m: any) => `${m.title}(${m.calories || '?'}kcal)`).join(', ') || '献立なし';
      return `${d.date}: ${dayMeals}`;
    }).join('\n') || '';

    // LLMプロンプト（より詳細な分析を促す）
    const prompt = `あなたはベテランの管理栄養士です。以下の1日の栄養データと1週間の献立を詳細に分析し、具体的で実践的なアドバイスをしてください。

## 対象日: ${date}
## 食事数: ${mealCount}食

## 主要栄養素の摂取状況:
${nutrientAnalysis.map(n => `- ${n.name}: ${n.value}${n.unit} (推奨量の${n.percentage}% - ${n.status})`).join('\n')}

## 栄養バランスサマリー:
- 適正範囲(80-120%): ${good.length}項目 (${good.map(n => n.name).join('、') || 'なし'})
- 不足傾向(<50%): ${deficient.length}項目 (${deficient.map(n => n.name).join('、') || 'なし'})  
- 過剰傾向(>150%): ${excess.length}項目 (${excess.map(n => n.name).join('、') || 'なし'})

## 今週の献立（前後含む）:
${weekSummary}

## 出力形式:
- 3〜4文で簡潔に
- 良い点を1つ挙げる
- 具体的な改善提案を1〜2つ（食材名や料理名を含めて）
- 絵文字は使わない
- 専門用語は避けてわかりやすく
- 週間の献立傾向も考慮してコメント`;

    // GPT-5.2を使用（栄養士コメントのみ高品質モデル）
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: 'あなたは親しみやすく経験豊富な管理栄養士です。ユーザーの食生活を優しく、前向きに、かつ具体的にアドバイスします。週間の食事傾向も見ながら、実践しやすいアドバイスを心がけてください。',
          },
          { role: 'user', content: prompt },
        ],
        max_completion_tokens: 500,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('OpenAI API error:', errorData);
      return NextResponse.json({ error: 'AI分析に失敗しました', details: errorData }, { status: 500 });
    }

    const data = await response.json();
    const feedback = data.choices?.[0]?.message?.content?.trim() || '分析結果を取得できませんでした。';

    return NextResponse.json({ feedback });
  } catch (error: any) {
    console.error('Nutrition feedback error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
