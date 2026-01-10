import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getNutrientDefinition, calculateDriPercentage } from '@/lib/nutrition-constants';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 栄養データと週間データからハッシュを生成（変更検知用）
function generateHash(nutrition: any, weekData: any): string {
  const nutritionStr = JSON.stringify({
    cal: Math.round(nutrition.caloriesKcal || 0),
    prot: Math.round(nutrition.proteinG || 0),
    fat: Math.round(nutrition.fatG || 0),
    carb: Math.round(nutrition.carbsG || 0),
  });
  
  const weekStr = (weekData || [])
    .map((d: any) => `${d.date}:${d.meals?.map((m: any) => m.title).join(',') || ''}`)
    .join('|');
  
  return crypto.createHash('md5').update(nutritionStr + weekStr).digest('hex');
}

// LLMで褒めコメント＋アドバイスを生成する関数
interface NutritionFeedbackResult {
  praiseComment: string;  // 褒めコメント（絵文字あり、ポジティブ）
  advice: string;         // 改善アドバイス
  nutritionTip: string;   // 栄養豆知識
}

async function generateFeedbackWithLLM(
  date: string,
  nutrition: any,
  mealCount: number,
  weekData: any[]
): Promise<NutritionFeedbackResult> {
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

  const deficient = nutrientAnalysis.filter(n => n.percentage < 50);
  const excess = nutrientAnalysis.filter(n => n.percentage > 150);
  const good = nutrientAnalysis.filter(n => n.percentage >= 80 && n.percentage <= 120);

  const weekSummary = weekData?.map((d: any) => {
    const dayMeals = d.meals?.map((m: any) => `${m.title}(${m.calories || '?'}kcal)`).join(', ') || '献立なし';
    return `${d.date}: ${dayMeals}`;
  }).join('\n') || '';

  // 今日の献立を抽出
  const todayMeals = weekData?.find((d: any) => d.date === date)?.meals || [];
  const todayDishes = todayMeals.flatMap((m: any) => m.dishes || [m.title]).filter(Boolean).join('、');

  const prompt = `あなたは「ほめゴハン」のAI栄養士です。ユーザーの1日の栄養データを分析し、以下の3つを生成してください。

## 対象日: ${date}
## 食事数: ${mealCount}食
## 今日の献立: ${todayDishes || '献立情報なし'}

## 主要栄養素の摂取状況:
${nutrientAnalysis.map(n => `- ${n.name}: ${n.value}${n.unit} (推奨量の${n.percentage}% - ${n.status})`).join('\n')}

## 栄養バランスサマリー:
- 適正範囲(80-120%): ${good.length}項目 (${good.map(n => n.name).join('、') || 'なし'})
- 不足傾向(<50%): ${deficient.length}項目 (${deficient.map(n => n.name).join('、') || 'なし'})
- 過剰傾向(>150%): ${excess.length}項目 (${excess.map(n => n.name).join('、') || 'なし'})

## 今週の献立:
${weekSummary}

## 出力形式（必ず以下のJSON形式で出力）:
\`\`\`json
{
  "praiseComment": "褒めコメント（80-120文字）。良い点を見つけて褒める。絵文字1-2個使用。批判は含めない。",
  "advice": "改善アドバイス（200-300文字）。不足栄養素を補う具体的な食材・料理名を挙げ、どの食事（朝食/昼食/夕食）で取り入れるべきかを提案。例：「カルシウム不足を補うため、朝食にヨーグルト、夕食に小松菜の炒め物を追加しましょう」のように実践的に。",
  "nutritionTip": "栄養豆知識（40-60文字）。今日の献立や不足栄養素に関連したミニ知識。"
}
\`\`\`

## 重要なルール:
- praiseCommentは**必ず褒める**。どんな献立でも良い点を見つける
- adviceは**具体的な食材名・料理名・タイミング**を含める（献立改善AIへの指示として使用される）
- JSONのみを出力（説明文は不要）`;

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
          content: 'あなたは「ほめゴハン」のAI栄養士です。ユーザーの食事を褒めて、やる気を引き出すことが大切です。必ずJSON形式で出力してください。',
        },
        { role: 'user', content: prompt },
      ],
      max_completion_tokens: 800,
      reasoning_effort: 'none',
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('OpenAI API error:', errorData);
    throw new Error('AI分析に失敗しました');
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';

  // JSONをパース
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        praiseComment: parsed.praiseComment || 'バランスの良い食事を心がけていますね✨',
        advice: parsed.advice || '',
        nutritionTip: parsed.nutritionTip || '',
      };
    } catch (e) {
      console.warn('Failed to parse feedback JSON:', e);
    }
  }

  // フォールバック
  return {
    praiseComment: 'お食事の記録ありがとうございます！毎日の食事管理、素晴らしいですね✨',
    advice: content || '',
    nutritionTip: '',
  };
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { date, nutrition, mealCount, weekData, forceRefresh } = body;

    if (!nutrition || !date) {
      return NextResponse.json({ error: 'Nutrition data and date required' }, { status: 400 });
    }

    const nutritionHash = generateHash(nutrition, weekData);

    // キャッシュを確認（forceRefreshでない場合）
    if (!forceRefresh) {
      const { data: cached } = await supabase
        .from('nutrition_feedback_cache')
        .select('id, feedback, nutrition_hash, status')
        .eq('user_id', user.id)
        .eq('target_date', date)
        .single();

      // キャッシュがあり、ハッシュが一致し、完了状態ならキャッシュを返す
      if (cached && cached.nutrition_hash === nutritionHash && cached.status === 'completed') {
        // JSONとしてパースを試みる（新形式）、失敗したら旧形式として扱う
        let feedbackData;
        try {
          feedbackData = JSON.parse(cached.feedback);
        } catch {
          // 旧形式の文字列フィードバック
          feedbackData = {
            praiseComment: '',
            advice: cached.feedback,
            nutritionTip: '',
          };
        }
        return NextResponse.json({
          ...feedbackData,
          feedback: feedbackData.advice || cached.feedback, // 後方互換性
          cached: true,
          status: 'completed'
        });
      }

      // 生成中の場合はステータスのみ返す
      if (cached && cached.status === 'generating') {
        return NextResponse.json({ 
          feedback: null, 
          cached: false,
          status: 'generating',
          cacheId: cached.id
        });
      }
    }

    // 新規生成または再生成が必要
    // まずpendingステータスでレコードを作成/更新
    const { data: cacheRecord, error: upsertError } = await supabase
      .from('nutrition_feedback_cache')
      .upsert({
        user_id: user.id,
        target_date: date,
        feedback: '',
        nutrition_hash: nutritionHash,
        week_hash: nutritionHash,
        status: 'generating',
      }, {
        onConflict: 'user_id,target_date'
      })
      .select('id')
      .single();

    if (upsertError) {
      console.error('Failed to create cache record:', upsertError);
      return NextResponse.json({ error: 'キャッシュの作成に失敗しました' }, { status: 500 });
    }

    const cacheId = cacheRecord.id;

    // バックグラウンドでLLM処理を実行（レスポンスは先に返す）
    // Next.jsのwaitUntilを使用
    const backgroundTask = (async () => {
      try {
        const feedbackResult = await generateFeedbackWithLLM(date, nutrition, mealCount, weekData);

        // 完了したらDBを更新（Realtimeで自動通知される）
        // 新形式: JSONとして保存
        await supabase
          .from('nutrition_feedback_cache')
          .update({
            feedback: JSON.stringify(feedbackResult),
            status: 'completed',
          })
          .eq('id', cacheId);

        console.log(`Nutrition feedback generated for ${date}`);
      } catch (error) {
        console.error('Background LLM task failed:', error);

        // エラー時もDBを更新
        const errorFeedback = {
          praiseComment: '',
          advice: '分析中にエラーが発生しました。再分析をお試しください。',
          nutritionTip: '',
        };
        await supabase
          .from('nutrition_feedback_cache')
          .update({
            feedback: JSON.stringify(errorFeedback),
            status: 'error',
          })
          .eq('id', cacheId);
      }
    })();

    // waitUntilが利用可能な場合はバックグラウンドで実行
    // @ts-ignore - Next.js edge runtime specific
    if (typeof globalThis.waitUntil === 'function') {
      // @ts-ignore
      globalThis.waitUntil(backgroundTask);
    } else {
      // waitUntilが使えない場合は同期的に実行
      await backgroundTask;
    }

    // 即座にレスポンスを返す（フロントエンドはRealtimeで更新を受け取る）
    return NextResponse.json({ 
      feedback: null, 
      cached: false,
      status: 'generating',
      cacheId
    });
  } catch (error: any) {
    console.error('Nutrition feedback error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// キャッシュのステータスを確認するGETエンドポイント
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');
    const cacheId = searchParams.get('cacheId');

    if (!date && !cacheId) {
      return NextResponse.json({ error: 'date or cacheId required' }, { status: 400 });
    }

    let query = supabase
      .from('nutrition_feedback_cache')
      .select('id, feedback, status, nutrition_hash')
      .eq('user_id', user.id);

    if (cacheId) {
      query = query.eq('id', cacheId);
    } else if (date) {
      query = query.eq('target_date', date);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return NextResponse.json({ status: 'not_found' });
    }

    if (data.status === 'completed' && data.feedback) {
      // JSONとしてパースを試みる（新形式）
      let feedbackData;
      try {
        feedbackData = JSON.parse(data.feedback);
      } catch {
        // 旧形式の文字列フィードバック
        feedbackData = {
          praiseComment: '',
          advice: data.feedback,
          nutritionTip: '',
        };
      }
      return NextResponse.json({
        ...feedbackData,
        feedback: feedbackData.advice || data.feedback, // 後方互換性
        status: data.status,
        cacheId: data.id
      });
    }

    return NextResponse.json({
      feedback: null,
      praiseComment: null,
      advice: null,
      nutritionTip: null,
      status: data.status,
      cacheId: data.id
    });
  } catch (error: any) {
    console.error('Nutrition feedback GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
