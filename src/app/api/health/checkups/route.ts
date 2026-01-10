import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import OpenAI from 'openai';

// Lazy initialization to avoid build-time errors
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

// 健康診断一覧を取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '20');

  const { data, error } = await supabase
    .from('health_checkups')
    .select('*')
    .eq('user_id', user.id)
    .order('checkup_date', { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 経年レビューも取得
  const { data: longitudinalReview } = await supabase
    .from('health_checkup_longitudinal_reviews')
    .select('*')
    .eq('user_id', user.id)
    .single();

  return NextResponse.json({
    checkups: data,
    longitudinalReview,
  });
}

// 健康診断を新規作成（画像解析 → 個別レビュー → 経年レビュー自動更新）
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const {
    checkup_date,
    image_url,
    facility_name,
    checkup_type,
    // 手動入力データ（画像解析結果を上書き可能）
    ...manualData
  } = body;

  if (!checkup_date) {
    return NextResponse.json({ error: 'checkup_date is required' }, { status: 400 });
  }

  let extractedData = {};

  // 画像がある場合、GPT-5.2 Visionでデータを抽出
  if (image_url) {
    try {
      extractedData = await extractDataFromImage(image_url);
    } catch (err) {
      console.error('Image extraction failed:', err);
      // エラーでも続行（手動データがあれば使用）
    }
  }

  // 手動データで上書き（nullや未定義は除外）
  const checkupData = {
    ...extractedData,
    ...Object.fromEntries(
      Object.entries(manualData).filter(([_, v]) => v !== null && v !== undefined)
    ),
  };

  // 健康診断を保存
  const { data: checkup, error: insertError } = await supabase
    .from('health_checkups')
    .insert({
      user_id: user.id,
      checkup_date,
      image_url,
      facility_name,
      checkup_type,
      ...checkupData,
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // 個別レビューを生成
  let individualReview = null;
  try {
    individualReview = await generateIndividualReview(checkup);

    // 個別レビューを保存
    await supabase
      .from('health_checkups')
      .update({ individual_review: individualReview })
      .eq('id', checkup.id);
  } catch (err) {
    console.error('Individual review generation failed:', err);
  }

  // 経年レビューを自動更新
  let longitudinalReview = null;
  try {
    longitudinalReview = await updateLongitudinalReview(supabase, user.id);
  } catch (err) {
    console.error('Longitudinal review update failed:', err);
  }

  return NextResponse.json({
    checkup: {
      ...checkup,
      individual_review: individualReview,
    },
    longitudinalReview,
  });
}

// 画像からデータを抽出（GPT-5.2 Vision）
async function extractDataFromImage(imageUrl: string): Promise<Record<string, any>> {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5.2',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        {
          type: 'text',
          text: `この健康診断結果の画像から以下の検査値を読み取り、JSON形式で返してください。
読み取れない項目はnullとしてください。数値のみを抽出し、単位は含めないでください。

抽出する項目:
- height: 身長 (cm)
- weight: 体重 (kg)
- bmi: BMI
- waist_circumference: 腹囲 (cm)
- blood_pressure_systolic: 収縮期血圧 (mmHg)
- blood_pressure_diastolic: 拡張期血圧 (mmHg)
- hemoglobin: ヘモグロビン (g/dL)
- hba1c: HbA1c (%)
- fasting_glucose: 空腹時血糖 (mg/dL)
- total_cholesterol: 総コレステロール (mg/dL)
- ldl_cholesterol: LDLコレステロール (mg/dL)
- hdl_cholesterol: HDLコレステロール (mg/dL)
- triglycerides: 中性脂肪 (mg/dL)
- ast: AST/GOT (U/L)
- alt: ALT/GPT (U/L)
- gamma_gtp: γ-GTP (U/L)
- creatinine: クレアチニン (mg/dL)
- egfr: eGFR (mL/min/1.73m²)
- uric_acid: 尿酸 (mg/dL)

JSONのみを出力してください。`,
        },
      ],
    }],
    response_format: { type: 'json_object' },
    max_tokens: 1000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from GPT-5.2');
  }

  return JSON.parse(content);
}

// 個別レビューを生成（GPT-5.2）
async function generateIndividualReview(checkup: any): Promise<any> {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5.2',
    messages: [
      {
        role: 'system',
        content: `あなたは健康診断結果を分析する専門家です。
医学的に正確で、一般の方にもわかりやすい言葉で説明してください。
具体的な数値と基準値を比較しながら、改善点や良い点を指摘してください。`,
      },
      {
        role: 'user',
        content: `以下の健康診断結果を分析してください:

検査日: ${checkup.checkup_date}
血圧: ${checkup.blood_pressure_systolic ?? '-'}/${checkup.blood_pressure_diastolic ?? '-'} mmHg
HbA1c: ${checkup.hba1c ?? '-'}%
空腹時血糖: ${checkup.fasting_glucose ?? '-'} mg/dL
総コレステロール: ${checkup.total_cholesterol ?? '-'} mg/dL
LDL: ${checkup.ldl_cholesterol ?? '-'} mg/dL
HDL: ${checkup.hdl_cholesterol ?? '-'} mg/dL
中性脂肪: ${checkup.triglycerides ?? '-'} mg/dL
AST: ${checkup.ast ?? '-'} U/L
ALT: ${checkup.alt ?? '-'} U/L
γ-GTP: ${checkup.gamma_gtp ?? '-'} U/L
尿酸: ${checkup.uric_acid ?? '-'} mg/dL
eGFR: ${checkup.egfr ?? '-'} mL/min/1.73m²

以下の形式でJSONを返してください:
{
  "summary": "全体的な健康状態の要約（2-3文）",
  "concerns": ["気になる点1", "気になる点2"],
  "positives": ["良い点1", "良い点2"],
  "recommendations": ["改善アドバイス1", "改善アドバイス2"],
  "riskLevel": "low|medium|high"
}`,
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from GPT-5.2');
  }

  return JSON.parse(content);
}

// 経年レビューを更新
async function updateLongitudinalReview(supabase: any, userId: string): Promise<any> {
  // 全ての健康診断を取得（古い順）
  const { data: checkups, error } = await supabase
    .from('health_checkups')
    .select('*')
    .eq('user_id', userId)
    .order('checkup_date', { ascending: true });

  if (error || !checkups || checkups.length === 0) {
    return null;
  }

  // 2回以上の診断がない場合は経年レビューをスキップ
  if (checkups.length < 2) {
    return null;
  }

  // ユーザープロフィールを取得
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('age, gender, fitness_goals')
    .eq('id', userId)
    .single();

  // GPT-5.2で経年レビューを生成
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5.2',
    messages: [
      {
        role: 'system',
        content: `あなたは管理栄養士兼健康アドバイザーです。
複数回の健康診断結果から傾向を分析し、食事面での改善指針を提案してください。
具体的な食材名は避け、「〜を意識した食事」「〜を控える」といった方針レベルで記述してください。`,
      },
      {
        role: 'user',
        content: `【ユーザー情報】
年齢: ${profile?.age ?? '不明'}歳
性別: ${profile?.gender === 'male' ? '男性' : profile?.gender === 'female' ? '女性' : '不明'}
目標: ${profile?.fitness_goals?.join(', ') ?? '設定なし'}

【健康診断履歴（古→新）】
${checkups.map((c: any, i: number) => `
=== ${i + 1}回目 (${c.checkup_date}) ===
血圧: ${c.blood_pressure_systolic ?? '-'}/${c.blood_pressure_diastolic ?? '-'}
HbA1c: ${c.hba1c ?? '-'}%
LDL: ${c.ldl_cholesterol ?? '-'} mg/dL
中性脂肪: ${c.triglycerides ?? '-'} mg/dL
γ-GTP: ${c.gamma_gtp ?? '-'} U/L
尿酸: ${c.uric_acid ?? '-'} mg/dL
`).join('\n')}

以下の形式でJSONを返してください:
{
  "overallAssessment": "全体的な傾向の評価",
  "improvingMetrics": [{"metric": "項目名", "detail": "詳細"}],
  "worseningMetrics": [{"metric": "項目名", "detail": "詳細", "severity": "mild|moderate|serious"}],
  "stableMetrics": ["項目名"],
  "priorityActions": ["最優先で取り組むべきこと"],
  "nutritionGuidance": {
    "generalDirection": "全体的な食事方針",
    "avoidanceHints": ["控えるべき食事傾向"],
    "emphasisHints": ["意識すべき食事傾向"],
    "specialNotes": "特記事項"
  }
}`,
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 2000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from GPT-5.2');
  }

  const reviewData = JSON.parse(content);
  const checkupIds = checkups.map((c: any) => c.id);

  // 経年レビューをupsert
  const { data: review, error: upsertError } = await supabase
    .from('health_checkup_longitudinal_reviews')
    .upsert({
      user_id: userId,
      review_date: new Date().toISOString().split('T')[0],
      checkup_ids: checkupIds,
      trend_analysis: {
        overallAssessment: reviewData.overallAssessment,
        improvingMetrics: reviewData.improvingMetrics,
        worseningMetrics: reviewData.worseningMetrics,
        stableMetrics: reviewData.stableMetrics,
        priorityActions: reviewData.priorityActions,
      },
      nutrition_guidance: reviewData.nutritionGuidance,
    }, {
      onConflict: 'user_id',
    })
    .select()
    .single();

  if (upsertError) {
    console.error('Failed to upsert longitudinal review:', upsertError);
    return null;
  }

  // user_profilesにも栄養指針を保存
  await supabase
    .from('user_profiles')
    .update({ health_checkup_guidance: reviewData.nutritionGuidance })
    .eq('id', userId);

  return review;
}
