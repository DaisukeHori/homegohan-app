import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }
  return new OpenAI({ apiKey });
}

/**
 * 栄養分析API
 * 
 * ユーザーの食事データを集計し、目標との比較、AIによるアドバイスを生成
 * 
 * Query params:
 * - period: 'today' | 'week' | 'month'
 * - includeAdvice: 'true' | 'false' (AIアドバイスを含めるか)
 * - includeSuggestion: 'true' | 'false' (献立変更提案を含めるか)
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period') || 'today';
  const includeAdvice = searchParams.get('includeAdvice') === 'true';
  const includeSuggestion = searchParams.get('includeSuggestion') === 'true';

  try {
    // 1. ユーザープロフィールと栄養目標を取得
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    const { data: targets } = await supabase
      .from('nutrition_targets')
      .select('*')
      .eq('user_id', user.id)
      .single();

    // 2. 期間に応じた日付範囲を計算
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    let startDate: string;
    let endDate: string = todayStr;

    switch (period) {
      case 'week':
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 6);
        startDate = weekAgo.toISOString().split('T')[0];
        break;
      case 'month':
        const monthAgo = new Date(today);
        monthAgo.setDate(monthAgo.getDate() - 29);
        startDate = monthAgo.toISOString().split('T')[0];
        break;
      default: // today
        startDate = todayStr;
    }

    // 3. 食事データを取得（日付ベースで直接取得）
    const { data: meals } = await supabase
      .from('planned_meals')
      .select(`
        *,
        user_daily_meals!inner(day_date, user_id)
      `)
      .eq('user_daily_meals.user_id', user.id)
      .gte('user_daily_meals.day_date', startDate)
      .lte('user_daily_meals.day_date', endDate)
      .eq('is_completed', true);

    const completedMeals = meals || [];
    
    if (completedMeals.length === 0) {
      return NextResponse.json({
        success: true,
        period,
        analysis: null,
        message: '献立データがありません',
      });
    }

    // 5. 栄養素を集計
    const aggregated: Record<string, number> = {
      calories: 0,
      protein: 0,
      fat: 0,
      carbs: 0,
      fiber: 0,
      sodium: 0,
      sugar: 0,
      potassium: 0,
      calcium: 0,
      iron: 0,
      vitaminC: 0,
      vitaminD: 0,
      cholesterol: 0,
    };

    const daysWithData = new Set<string>();

    for (const meal of completedMeals) {
      const dayDate = meal.user_daily_meals?.day_date;
      if (dayDate) daysWithData.add(dayDate);

      aggregated.calories += meal.calories_kcal || 0;
      aggregated.protein += meal.protein_g || 0;
      aggregated.fat += meal.fat_g || 0;
      aggregated.carbs += meal.carbs_g || 0;
      aggregated.fiber += meal.fiber_g || 0;
      aggregated.sodium += meal.sodium_g || 0;
      aggregated.sugar += meal.sugar_g || 0;
      aggregated.potassium += meal.potassium_mg || 0;
      aggregated.calcium += meal.calcium_mg || 0;
      aggregated.iron += meal.iron_mg || 0;
      aggregated.vitaminC += meal.vitamin_c_mg || 0;
      aggregated.vitaminD += meal.vitamin_d_ug || 0;
      aggregated.cholesterol += meal.cholesterol_mg || 0;
    }

    const daysCount = Math.max(daysWithData.size, 1);

    // 6. 1日あたりの平均を計算
    const dailyAverage: Record<string, number> = {};
    for (const [key, value] of Object.entries(aggregated)) {
      dailyAverage[key] = Math.round((value / daysCount) * 10) / 10;
    }

    // 7. 目標との比較
    const comparison: Record<string, { actual: number; target: number; percentage: number; status: string }> = {};
    
    if (targets) {
      const targetMap: Record<string, number> = {
        calories: targets.daily_calories || 2000,
        protein: targets.protein_g || 60,
        fat: targets.fat_g || 60,
        carbs: targets.carbs_g || 300,
        fiber: targets.fiber_g || 21,
        sodium: targets.sodium_g || 7,
        sugar: targets.sugar_g || 50,
        potassium: targets.potassium_mg || 2500,
        calcium: targets.calcium_mg || 650,
        iron: targets.iron_mg || 10,
        vitaminC: targets.vitamin_c_mg || 100,
        vitaminD: targets.vitamin_d_ug || 8.5,
        cholesterol: targets.cholesterol_mg || 300,
      };

      for (const [key, target] of Object.entries(targetMap)) {
        const actual = dailyAverage[key] || 0;
        const percentage = Math.round((actual / target) * 100);
        let status = 'ok';
        
        // 過剰・不足の判定
        if (key === 'sodium' || key === 'sugar' || key === 'cholesterol') {
          // 制限すべき栄養素
          if (percentage > 120) status = 'excess';
          else if (percentage > 100) status = 'warning';
        } else {
          // 摂取推奨の栄養素
          if (percentage < 70) status = 'deficient';
          else if (percentage < 90) status = 'warning';
          else if (percentage > 150) status = 'excess';
        }

        comparison[key] = { actual, target, percentage, status };
      }
    }

    // 8. 栄養スコアを計算（100点満点）
    let score = 100;
    const issues: string[] = [];

    for (const [key, data] of Object.entries(comparison)) {
      if (data.status === 'deficient') {
        score -= 10;
        const labels: Record<string, string> = {
          calories: 'カロリー', protein: 'タンパク質', fat: '脂質', carbs: '炭水化物',
          fiber: '食物繊維', calcium: 'カルシウム', iron: '鉄分', vitaminC: 'ビタミンC', vitaminD: 'ビタミンD'
        };
        issues.push(`${labels[key] || key}が不足しています（${data.percentage}%）`);
      } else if (data.status === 'excess') {
        score -= 5;
        const labels: Record<string, string> = {
          sodium: '塩分', sugar: '糖質', cholesterol: 'コレステロール'
        };
        if (labels[key]) {
          issues.push(`${labels[key]}が過剰です（${data.percentage}%）`);
        }
      } else if (data.status === 'warning') {
        score -= 3;
      }
    }

    score = Math.max(0, Math.min(100, score));

    // 9. AIアドバイスを生成（オプション）
    let advice: string | null = null;
    let suggestion: any = null;

    if (includeAdvice || includeSuggestion) {
      const healthConditions = profile?.health_conditions || [];
      const medications = profile?.medications || [];
      const nutritionGoal = profile?.nutrition_goal || 'maintain';

      const prompt = `あなたは専門の管理栄養士です。以下のユーザーの栄養データを分析し、アドバイスを提供してください。

【ユーザー情報】
- 年齢: ${profile?.age || '不明'}歳
- 性別: ${profile?.gender === 'male' ? '男性' : profile?.gender === 'female' ? '女性' : '不明'}
- 目標: ${nutritionGoal === 'lose_weight' ? '減量' : nutritionGoal === 'gain_muscle' ? '筋肉増量' : nutritionGoal === 'athlete_performance' ? '競技パフォーマンス' : '健康維持'}
- 持病: ${healthConditions.length > 0 ? healthConditions.join(', ') : 'なし'}
- 服用薬: ${medications.length > 0 ? medications.join(', ') : 'なし'}

【${period === 'today' ? '本日' : period === 'week' ? '過去1週間' : '過去1ヶ月'}の栄養摂取状況（1日平均）】
- カロリー: ${dailyAverage.calories}kcal（目標: ${comparison.calories?.target || 2000}kcal）
- タンパク質: ${dailyAverage.protein}g（目標: ${comparison.protein?.target || 60}g）
- 脂質: ${dailyAverage.fat}g（目標: ${comparison.fat?.target || 60}g）
- 炭水化物: ${dailyAverage.carbs}g（目標: ${comparison.carbs?.target || 300}g）
- 食物繊維: ${dailyAverage.fiber}g（目標: ${comparison.fiber?.target || 21}g）
- 塩分: ${dailyAverage.sodium}g（目標: ${comparison.sodium?.target || 7}g）
- 糖質: ${dailyAverage.sugar}g（目標: ${comparison.sugar?.target || 50}g）
- カルシウム: ${dailyAverage.calcium}mg（目標: ${comparison.calcium?.target || 650}mg）
- 鉄分: ${dailyAverage.iron}mg（目標: ${comparison.iron?.target || 10}mg）
- ビタミンC: ${dailyAverage.vitaminC}mg（目標: ${comparison.vitaminC?.target || 100}mg）

【課題】
${issues.length > 0 ? issues.join('\n') : '特になし'}

${includeAdvice ? `
【依頼1: アドバイス】
上記の情報を基に、具体的で実践的なアドバイスを2-3行で簡潔に提供してください。
ユーザーの持病や目標を考慮し、今日から実践できる内容にしてください。
` : ''}

${includeSuggestion ? `
【依頼2: 献立変更提案】
不足している栄養素を補うための具体的な献立変更を提案してください。
JSON形式で出力してください：

\`\`\`json
{
  "targetMeal": "次に変更すべき食事（breakfast/lunch/dinner）",
  "targetDate": "対象日（YYYY-MM-DD形式、今日または明日）",
  "currentIssue": "解決したい課題（1行で）",
  "suggestedDishes": [
    {
      "name": "料理名",
      "role": "main/side/soup",
      "benefit": "この料理を追加する理由（栄養面）"
    }
  ],
  "expectedImprovement": "この変更による期待効果"
}
\`\`\`
` : ''}
`;

      const openai = getOpenAI();
      const completion = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 1000,
      } as any);

      const response = completion.choices[0]?.message?.content || '';

      if (includeAdvice) {
        // アドバイス部分を抽出
        const adviceMatch = response.match(/(?:アドバイス[：:】]?\s*\n?)([\s\S]*?)(?=\n\n|```|$)/);
        advice = adviceMatch ? adviceMatch[1].trim() : response.split('```')[0].trim();
      }

      if (includeSuggestion) {
        // JSON部分を抽出
        const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            suggestion = JSON.parse(jsonMatch[1]);
          } catch (e) {
            console.error('Failed to parse suggestion JSON:', e);
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      period,
      daysCount,
      mealsCount: completedMeals.length,
      analysis: {
        aggregated,
        dailyAverage,
        comparison,
        score,
        issues,
      },
      advice,
      suggestion,
      profile: {
        nutritionGoal: profile?.nutrition_goal,
        healthConditions: profile?.health_conditions,
      },
    });

  } catch (error: any) {
    console.error('Nutrition analysis error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * AIが提案した献立変更を実行するAPI
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { targetDate, targetMealType, prompt } = body;

    if (!targetDate || !targetMealType || !prompt) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 該当の食事を取得（is_active=trueか、なければ最新のプラン）
    let activePlan = null;
    const { data: activePlanData } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();

    if (activePlanData) {
      activePlan = activePlanData;
    } else {
      // is_active=trueがなければ最新のプランを使用
      const { data: latestPlan } = await supabase
        .from('meal_plans')
        .select('id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      activePlan = latestPlan;
    }

    if (!activePlan) {
      return NextResponse.json({ error: 'No meal plan found' }, { status: 404 });
    }

    // meal_plan_dayを取得
    const { data: day } = await supabase
      .from('meal_plan_days')
      .select('id')
      .eq('meal_plan_id', activePlan.id)
      .eq('day_date', targetDate)
      .single();

    if (!day) {
      return NextResponse.json({ error: 'Day not found' }, { status: 404 });
    }

    // 対象の食事を取得
    const { data: meal } = await supabase
      .from('planned_meals')
      .select('id')
      .eq('meal_plan_day_id', day.id)
      .eq('meal_type', targetMealType)
      .single();

    if (!meal) {
      return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
    }

    // regenerate-meal-directを呼び出す
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    // NOTE:
    // - `/functions/v1/...` の "v1" は Supabase Edge Functions のHTTPパスのバージョンであり、
    //   献立生成ロジックの v1/v2（legacy/dataset）とは無関係です。
    // - 当アプリの献立再生成は `regenerate-meal-direct-v3`（LLM Creative）を使用します。
    const regenerateRes = await fetch(`${supabaseUrl}/functions/v1/regenerate-meal-direct-v3`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        mealId: meal.id,
        prompt,
        userId: user.id,
      }),
    });

    if (!regenerateRes.ok) {
      const errorText = await regenerateRes.text();
      console.error('Regenerate error:', errorText);
      return NextResponse.json({ error: 'Failed to regenerate meal' }, { status: 500 });
    }

    const result = await regenerateRes.json();

    return NextResponse.json({
      success: true,
      message: '献立を変更しました',
      mealId: meal.id,
      result,
    });

  } catch (error: any) {
    console.error('Meal update error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

