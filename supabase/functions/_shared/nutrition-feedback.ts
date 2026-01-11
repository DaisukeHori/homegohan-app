/**
 * 栄養フィードバック生成モジュール（Edge Functions用）
 *
 * 栄養データを分析し、褒めコメント・改善アドバイス・栄養豆知識を生成
 */

// ============================================
// 栄養素定義（nutrition-constants.tsからポート）
// ============================================

export interface NutrientDefinition {
  key: string;
  label: string;
  unit: string;
  dri: number;
  decimals: number;
  category: 'basic' | 'mineral' | 'vitamin' | 'fat';
}

export const NUTRIENT_DEFINITIONS: NutrientDefinition[] = [
  // 基本栄養素
  { key: 'caloriesKcal', label: 'エネルギー', unit: 'kcal', dri: 2000, decimals: 0, category: 'basic' },
  { key: 'proteinG', label: 'タンパク質', unit: 'g', dri: 60, decimals: 1, category: 'basic' },
  { key: 'fatG', label: '脂質', unit: 'g', dri: 55, decimals: 1, category: 'basic' },
  { key: 'carbsG', label: '炭水化物', unit: 'g', dri: 300, decimals: 1, category: 'basic' },
  { key: 'fiberG', label: '食物繊維', unit: 'g', dri: 21, decimals: 1, category: 'basic' },
  // ミネラル
  { key: 'sodiumG', label: '塩分', unit: 'g', dri: 7.5, decimals: 1, category: 'mineral' },
  { key: 'potassiumMg', label: 'カリウム', unit: 'mg', dri: 2500, decimals: 0, category: 'mineral' },
  { key: 'calciumMg', label: 'カルシウム', unit: 'mg', dri: 700, decimals: 0, category: 'mineral' },
  { key: 'magnesiumMg', label: 'マグネシウム', unit: 'mg', dri: 340, decimals: 0, category: 'mineral' },
  { key: 'ironMg', label: '鉄分', unit: 'mg', dri: 7.5, decimals: 1, category: 'mineral' },
  { key: 'zincMg', label: '亜鉛', unit: 'mg', dri: 10, decimals: 1, category: 'mineral' },
  // ビタミン
  { key: 'vitaminAUg', label: 'ビタミンA', unit: 'µg', dri: 850, decimals: 0, category: 'vitamin' },
  { key: 'vitaminB1Mg', label: 'ビタミンB1', unit: 'mg', dri: 1.3, decimals: 2, category: 'vitamin' },
  { key: 'vitaminB2Mg', label: 'ビタミンB2', unit: 'mg', dri: 1.5, decimals: 2, category: 'vitamin' },
  { key: 'vitaminCMg', label: 'ビタミンC', unit: 'mg', dri: 100, decimals: 0, category: 'vitamin' },
  { key: 'vitaminDUg', label: 'ビタミンD', unit: 'µg', dri: 8.5, decimals: 1, category: 'vitamin' },
];

export function getNutrientDefinition(key: string): NutrientDefinition | undefined {
  return NUTRIENT_DEFINITIONS.find(n => n.key === key);
}

export function calculateDriPercentage(key: string, value: number | null | undefined): number {
  if (value == null) return 0;
  const def = getNutrientDefinition(key);
  if (!def) return 0;
  return Math.round((value / def.dri) * 100);
}

// ============================================
// フィードバック生成
// ============================================

export interface NutritionReplacement {
  meal: 'breakfast' | 'lunch' | 'dinner';
  target: string;
  replacement: string;
  nutrientGain: string;
}

export interface NutritionFeedbackResult {
  praiseComment: string;
  advice: string;
  nutritionTip: string;
  replacements?: NutritionReplacement[];
}

export interface NutritionData {
  caloriesKcal?: number;
  proteinG?: number;
  fatG?: number;
  carbsG?: number;
  fiberG?: number;
  sodiumG?: number;
  vitaminCMg?: number;
  calciumMg?: number;
  ironMg?: number;
  vitaminAUg?: number;
  vitaminB1Mg?: number;
  vitaminB2Mg?: number;
  vitaminDUg?: number;
  zincMg?: number;
  magnesiumMg?: number;
  [key: string]: number | undefined;
}

export interface DayMealData {
  date: string;
  meals?: Array<{
    title?: string;
    calories?: number;
    dishes?: string[];
  }>;
}

/**
 * 栄養データを分析してフィードバックを生成
 */
export async function generateNutritionFeedback(
  date: string,
  nutrition: NutritionData,
  mealCount: number,
  weekData: DayMealData[],
  userSummary?: string
): Promise<NutritionFeedbackResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

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

  const weekSummary = weekData?.map((d) => {
    const dayMeals = d.meals?.map((m) => `${m.title}(${m.calories || '?'}kcal)`).join(', ') || '献立なし';
    return `${d.date}: ${dayMeals}`;
  }).join('\n') || '';

  // 今日の献立を抽出
  const todayMeals = weekData?.find((d) => d.date === date)?.meals || [];
  const todayDishes = todayMeals.flatMap((m) => m.dishes || [m.title]).filter(Boolean).join('、');

  const prompt = `あなたは「ほめゴハン」のAI栄養士です。ユーザーの1日の栄養データを分析し、以下の3つを生成してください。

## 対象日: ${date}
## 食事数: ${mealCount}食
## 今日の献立: ${todayDishes || '献立情報なし'}
${userSummary ? `## ユーザー情報:\n${userSummary}\n` : ''}

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
  "advice": "改善アドバイス（100-150文字）。カロリーを増やさずに不足栄養素を補う方法を簡潔に説明。",
  "nutritionTip": "栄養豆知識（40-60文字）。今日の献立や不足栄養素に関連したミニ知識。",
  "replacements": [
    {"meal": "breakfast|lunch|dinner", "target": "置換対象の食材・料理", "replacement": "置換後の食材・料理", "nutrientGain": "改善される栄養素"}
  ]
}
\`\`\`

## 重要なルール:
- praiseCommentは**必ず褒める**。どんな献立でも良い点を見つける
- replacementsは**必ず1-3個**の置換提案を含める（献立改善AIが使用）
- 置換提案のルール:
  - カロリーを増やさない置換のみ（例: 白米→玄米、豚バラ→豚もも）
  - 「追加」ではなく「置換」で栄養改善する（例: ×「ヨーグルトを追加」→ ○「デザートをヨーグルトに置換」）
  - 汁物の具材追加のみ例外的に許可（例: 味噌汁に小松菜を追加）
- JSONのみを出力（説明文は不要）`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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
      // replacementsの型チェックとバリデーション
      const validReplacements: NutritionReplacement[] = [];
      if (Array.isArray(parsed.replacements)) {
        for (const r of parsed.replacements) {
          if (r.meal && r.target && r.replacement) {
            validReplacements.push({
              meal: r.meal as 'breakfast' | 'lunch' | 'dinner',
              target: r.target,
              replacement: r.replacement,
              nutrientGain: r.nutrientGain || '',
            });
          }
        }
      }
      return {
        praiseComment: parsed.praiseComment || 'バランスの良い食事を心がけていますね✨',
        advice: parsed.advice || '',
        nutritionTip: parsed.nutritionTip || '',
        replacements: validReplacements.length > 0 ? validReplacements : undefined,
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

/**
 * 生成済み献立から日ごとの栄養データを集計
 */
export function aggregateDayNutrition(
  generatedMeals: Record<string, any>,
  date: string
): NutritionData {
  const result: NutritionData = {
    caloriesKcal: 0,
    proteinG: 0,
    fatG: 0,
    carbsG: 0,
    fiberG: 0,
    sodiumG: 0,
    calciumMg: 0,
    ironMg: 0,
    zincMg: 0,
    magnesiumMg: 0,
    vitaminAUg: 0,
    vitaminB1Mg: 0,
    vitaminB2Mg: 0,
    vitaminCMg: 0,
    vitaminDUg: 0,
  };

  // date:mealType 形式のキーをフィルタリング
  const dayMeals = Object.entries(generatedMeals).filter(([key]) => key.startsWith(`${date}:`));

  for (const [, meal] of dayMeals) {
    if (!meal) continue;

    // 栄養素を集計（snake_caseとcamelCase両対応）
    result.caloriesKcal! += meal.calories_kcal || meal.caloriesKcal || 0;
    result.proteinG! += meal.protein_g || meal.proteinG || 0;
    result.fatG! += meal.fat_g || meal.fatG || 0;
    result.carbsG! += meal.carbs_g || meal.carbsG || 0;
    result.fiberG! += meal.fiber_g || meal.fiberG || 0;
    result.sodiumG! += meal.sodium_g || meal.sodiumG || 0;
    result.calciumMg! += meal.calcium_mg || meal.calciumMg || 0;
    result.ironMg! += meal.iron_mg || meal.ironMg || 0;
    result.zincMg! += meal.zinc_mg || meal.zincMg || 0;
    result.magnesiumMg! += meal.magnesium_mg || meal.magnesiumMg || 0;
    result.vitaminAUg! += meal.vitamin_a_ug || meal.vitaminAUg || 0;
    result.vitaminB1Mg! += meal.vitamin_b1_mg || meal.vitaminB1Mg || 0;
    result.vitaminB2Mg! += meal.vitamin_b2_mg || meal.vitaminB2Mg || 0;
    result.vitaminCMg! += meal.vitamin_c_mg || meal.vitaminCMg || 0;
    result.vitaminDUg! += meal.vitamin_d_ug || meal.vitaminDUg || 0;
  }

  return result;
}

/**
 * 週間データを生成済み献立から構築
 */
export function buildWeekDataFromMeals(
  generatedMeals: Record<string, any>,
  dates: string[]
): DayMealData[] {
  return dates.map(date => {
    const dayMeals = Object.entries(generatedMeals)
      .filter(([key]) => key.startsWith(`${date}:`))
      .map(([key, meal]) => {
        const mealType = key.split(':')[1];
        return {
          title: meal?.dishes?.[0]?.name || meal?.dishName || `${mealType}`,
          calories: meal?.calories_kcal || meal?.caloriesKcal || 0,
          dishes: meal?.dishes?.map((d: any) => d.name) || [],
        };
      });

    return {
      date,
      meals: dayMeals,
    };
  });
}
