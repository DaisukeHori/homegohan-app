import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateGeminiJson } from '@/lib/ai/gemini-json';

// AI分析結果の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '20');
  const unreadOnly = searchParams.get('unread') === 'true';
  const alertsOnly = searchParams.get('alerts') === 'true';

  let query = supabase
    .from('health_insights')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_dismissed', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (unreadOnly) {
    query = query.eq('is_read', false);
  }
  if (alertsOnly) {
    query = query.eq('is_alert', true);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 未読数もカウント
  const { count: unreadCount } = await supabase
    .from('health_insights')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_read', false)
    .eq('is_dismissed', false);

  // アラート数もカウント
  const { count: alertCount } = await supabase
    .from('health_insights')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_alert', true)
    .eq('is_dismissed', false);

  return NextResponse.json({
    insights: data,
    unreadCount: unreadCount || 0,
    alertCount: alertCount || 0,
  });
}

// health_insights を LLM で生成・挿入する
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ユーザーの最近の health_records, health_checkups, planned_meals を集約
  const [recordsResult, checkupsResult, mealsResult] = await Promise.all([
    supabase
      .from('health_records')
      .select('record_date,weight,body_fat_percentage,systolic_bp,diastolic_bp,sleep_hours,step_count')
      .eq('user_id', user.id)
      .order('record_date', { ascending: false })
      .limit(30),
    supabase
      .from('health_checkups')
      .select('checkup_date,weight,blood_pressure_systolic,blood_pressure_diastolic,hba1c,total_cholesterol,ldl_cholesterol,hdl_cholesterol,triglycerides,gamma_gtp,uric_acid,egfr')
      .eq('user_id', user.id)
      .order('checkup_date', { ascending: false })
      .limit(5),
    supabase
      .from('planned_meals')
      .select('planned_date,calories_kcal,protein_g,fat_g,carbs_g')
      .eq('user_id', user.id)
      .order('planned_date', { ascending: false })
      .limit(30),
  ]);

  const records = recordsResult.data ?? [];
  const checkups = checkupsResult.data ?? [];
  const meals = mealsResult.data ?? [];

  if (records.length === 0 && checkups.length === 0) {
    return NextResponse.json({ error: 'データが不足しています。健康記録を追加してから再試行してください。' }, { status: 400 });
  }

  const insightSchema = {
    type: 'object',
    required: ['insights'],
    properties: {
      insights: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'content', 'insight_type', 'is_alert'],
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            insight_type: { type: 'string', enum: ['nutrition', 'activity', 'sleep', 'checkup', 'trend', 'goal'] },
            is_alert: { type: 'boolean' },
            priority: { type: ['number', 'null'] },
          },
        },
      },
    },
  };

  const prompt = `あなたは栄養士・健康アドバイザーです。以下のデータを分析し、ユーザーへの健康インサイトを3〜5件生成してください。

## 最近の健康記録（新→旧）
${records.slice(0, 10).map((r: any) => `- ${r.record_date}: 体重${r.weight ?? '-'}kg, 血圧${r.systolic_bp ?? '-'}/${r.diastolic_bp ?? '-'}, 睡眠${r.sleep_hours ?? '-'}h, 歩数${r.step_count ?? '-'}`).join('\n') || 'データなし'}

## 健康診断（最新）
${checkups.slice(0, 2).map((c: any) => `- ${c.checkup_date}: HbA1c${c.hba1c ?? '-'}%, LDL${c.ldl_cholesterol ?? '-'}, HDL${c.hdl_cholesterol ?? '-'}, 中性脂肪${c.triglycerides ?? '-'}, γ-GTP${c.gamma_gtp ?? '-'}, 尿酸${c.uric_acid ?? '-'}`).join('\n') || 'データなし'}

## 食事記録（直近）
${meals.slice(0, 7).map((m: any) => `- ${m.planned_date}: ${m.calories_kcal ?? '-'}kcal, タンパク${m.protein_g ?? '-'}g, 脂質${m.fat_g ?? '-'}g, 炭水化物${m.carbs_g ?? '-'}g`).join('\n') || 'データなし'}

インサイトは日本語で、具体的かつ行動に繋がるものにしてください。
is_alert は基準値逸脱や急激な変化がある場合のみ true にしてください。`;

  let generatedInsights: any[] = [];
  try {
    const { data } = await generateGeminiJson<{ insights: any[] }>({
      prompt,
      schema: insightSchema,
      temperature: 0.3,
      maxOutputTokens: 2048,
      signal: AbortSignal.timeout(30_000),
    });
    generatedInsights = data.insights ?? [];
  } catch (err) {
    console.error('Health insight generation failed:', err);
    return NextResponse.json({ error: 'AIによるインサイト生成に失敗しました' }, { status: 500 });
  }

  if (generatedInsights.length === 0) {
    return NextResponse.json({ error: 'インサイトを生成できませんでした' }, { status: 500 });
  }

  // DB に挿入
  const rows = generatedInsights.map((ins: any) => ({
    user_id: user.id,
    title: String(ins.title ?? '').slice(0, 200),
    content: String(ins.content ?? ''),
    insight_type: ['nutrition', 'activity', 'sleep', 'checkup', 'trend', 'goal'].includes(ins.insight_type)
      ? ins.insight_type
      : 'trend',
    is_alert: Boolean(ins.is_alert),
    priority: typeof ins.priority === 'number' ? ins.priority : null,
    is_read: false,
    is_dismissed: false,
  }));

  const { data: inserted, error: insertError } = await supabase
    .from('health_insights')
    .insert(rows)
    .select();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ insights: inserted, count: inserted?.length ?? 0 });
}
