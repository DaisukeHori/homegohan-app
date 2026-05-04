import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sanitizeBloodTestPayload } from '@/lib/health-payloads';
import { getFastLLMClient, getFastLLMModel } from '@/lib/ai/fast-llm';

// 血液検査結果一覧の取得（+ 経年レビュー）
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // #265: limit に上限を設けて DoS を防ぐ
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '10'), 1), 200);

  const { data, error } = await supabase
    .from('blood_test_results')
    .select('*')
    .eq('user_id', user.id)
    .order('test_date', { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 経年レビューも取得
  const { data: longitudinalReview } = await supabase
    .from('blood_test_longitudinal_reviews')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  return NextResponse.json({ results: data, longitudinalReview });
}

// 血液検査結果の作成（→ 個別 AI レビュー → 経年レビュー自動更新）
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { data: resultData, errors } = sanitizeBloodTestPayload(body);

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (!resultData.test_date) {
    return NextResponse.json({ error: 'test_date is required' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('blood_test_results')
    .insert({
      user_id: user.id,
      ...resultData,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 個別 AI レビューを生成
  let aiReview = null;
  try {
    aiReview = await generateBloodTestReview(data);

    await supabase
      .from('blood_test_results')
      .update({ ai_review: aiReview })
      .eq('id', data.id);
  } catch (err) {
    console.error('Blood test AI review generation failed:', err);
  }

  // 経年レビューを自動更新
  let longitudinalReview = null;
  try {
    longitudinalReview = await updateBloodTestLongitudinalReview(supabase, user.id);
  } catch (err) {
    console.error('Blood test longitudinal review update failed:', err);
  }

  return NextResponse.json({
    result: {
      ...data,
      ai_review: aiReview,
    },
    longitudinalReview,
  });
}

// 個別 AI レビューを生成
async function generateBloodTestReview(result: any): Promise<any> {
  const client = getFastLLMClient();
  const model = getFastLLMModel();

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `あなたは血液検査結果を分析する専門家です。
医学的に正確で、一般の方にもわかりやすい言葉で説明してください。
具体的な数値と基準値を比較しながら、改善点や良い点を指摘してください。`,
      },
      {
        role: 'user',
        content: `以下の血液検査結果を分析してください:

検査日: ${result.test_date}
HbA1c: ${result.hba1c ?? '-'}%
空腹時血糖: ${result.fasting_glucose ?? '-'} mg/dL
総コレステロール: ${result.total_cholesterol ?? '-'} mg/dL
LDL: ${result.ldl_cholesterol ?? '-'} mg/dL
HDL: ${result.hdl_cholesterol ?? '-'} mg/dL
中性脂肪: ${result.triglycerides ?? '-'} mg/dL
AST: ${result.ast ?? '-'} U/L
ALT: ${result.alt ?? '-'} U/L
γ-GTP: ${result.gamma_gtp ?? '-'} U/L
クレアチニン: ${result.creatinine ?? '-'} mg/dL
eGFR: ${result.egfr ?? '-'} mL/min/1.73m²
尿酸: ${result.uric_acid ?? '-'} mg/dL
BUN: ${result.bun ?? '-'} mg/dL
ヘモグロビン: ${result.hemoglobin ?? '-'} g/dL

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
    throw new Error('Empty response from LLM');
  }

  return JSON.parse(content);
}

// 経年レビューを更新
async function updateBloodTestLongitudinalReview(supabase: any, userId: string): Promise<any> {
  const { data: results, error } = await supabase
    .from('blood_test_results')
    .select('*')
    .eq('user_id', userId)
    .order('test_date', { ascending: true });

  if (error || !results || results.length === 0) {
    return null;
  }

  // 2回以上の検査がない場合はスキップ
  if (results.length < 2) {
    return null;
  }

  const client = getFastLLMClient();
  const model = getFastLLMModel();

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `あなたは管理栄養士兼健康アドバイザーです。
複数回の血液検査結果から傾向を分析し、食事面での改善指針を提案してください。
具体的な食材名は避け、「〜を意識した食事」「〜を控える」といった方針レベルで記述してください。`,
      },
      {
        role: 'user',
        content: `【血液検査履歴（古→新）】
${results.map((r: any, i: number) => `
=== ${i + 1}回目 (${r.test_date}) ===
HbA1c: ${r.hba1c ?? '-'}%
LDL: ${r.ldl_cholesterol ?? '-'} mg/dL
HDL: ${r.hdl_cholesterol ?? '-'} mg/dL
中性脂肪: ${r.triglycerides ?? '-'} mg/dL
空腹時血糖: ${r.fasting_glucose ?? '-'} mg/dL
γ-GTP: ${r.gamma_gtp ?? '-'} U/L
尿酸: ${r.uric_acid ?? '-'} mg/dL
eGFR: ${r.egfr ?? '-'} mL/min/1.73m²
ヘモグロビン: ${r.hemoglobin ?? '-'} g/dL
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
    throw new Error('Empty response from LLM');
  }

  const reviewData = JSON.parse(content);
  const bloodTestIds = results.map((r: any) => r.id);

  const { data: review, error: upsertError } = await supabase
    .from('blood_test_longitudinal_reviews')
    .upsert({
      user_id: userId,
      review_date: new Date().toISOString().split('T')[0],
      blood_test_ids: bloodTestIds,
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
    console.error('Failed to upsert blood test longitudinal review:', upsertError);
    return null;
  }

  return review;
}
