import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFastLLMApiKey, getFastLLMChatCompletionsUrl, getFastLLMModel } from "../_shared/fast-llm.ts";
import { withOpenAIUsageContext, generateExecutionId } from "../_shared/llm-usage.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface HealthRecord {
  record_date: string;
  weight?: number;
  body_fat_percentage?: number;
  systolic_bp?: number;
  diastolic_bp?: number;
  sleep_hours?: number;
  sleep_quality?: number;
  mood_score?: number;
  overall_condition?: number;
  step_count?: number;
  water_intake?: number;
}

interface Insight {
  insight_type: string;
  title: string;
  summary: string;
  details: Record<string, any>;
  recommendations: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  is_alert: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authorization header required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const periodType = body.period_type || 'weekly'; // 'daily', 'weekly', 'monthly'

    // 期間を計算
    const endDate = new Date();
    const startDate = new Date();
    if (periodType === 'daily') {
      startDate.setDate(startDate.getDate() - 1);
    } else if (periodType === 'weekly') {
      startDate.setDate(startDate.getDate() - 7);
    } else {
      startDate.setDate(startDate.getDate() - 30);
    }

    // 健康記録を取得
    const { data: records, error: recordsError } = await supabase
      .from('health_records')
      .select('*')
      .eq('user_id', user.id)
      .gte('record_date', startDate.toISOString().split('T')[0])
      .lte('record_date', endDate.toISOString().split('T')[0])
      .order('record_date', { ascending: true });

    if (recordsError) {
      throw new Error(`Failed to fetch records: ${recordsError.message}`);
    }

    if (!records || records.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          insights: [],
          message: "分析に必要なデータがありません" 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ユーザープロフィールを取得
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // 目標を取得
    const { data: goals } = await supabase
      .from('health_goals')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'active');

    // 分析を実行（LLMトークン使用量計測付き）
    const executionId = generateExecutionId();
    const supabaseService = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const insights = await withOpenAIUsageContext({
      functionName: "generate-health-insights",
      executionId,
      userId: user.id,
      supabaseClient: supabaseService,
    }, async () => {
      return await generateInsights(
        records as HealthRecord[],
        profile,
        goals || [],
        periodType,
        startDate,
        endDate
      );
    });

    // インサイトをDBに保存
    for (const insight of insights) {
      await supabase.from('health_insights').insert({
        user_id: user.id,
        analysis_date: new Date().toISOString().split('T')[0],
        period_start: startDate.toISOString().split('T')[0],
        period_end: endDate.toISOString().split('T')[0],
        period_type: periodType,
        ...insight,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        insights,
        period: {
          start: startDate.toISOString().split('T')[0],
          end: endDate.toISOString().split('T')[0],
          type: periodType,
        },
        records_analyzed: records.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function generateInsights(
  records: HealthRecord[],
  profile: any,
  goals: any[],
  periodType: string,
  startDate: Date,
  endDate: Date
): Promise<Insight[]> {
  const insights: Insight[] = [];

  // 1. 体重トレンド分析
  const weightInsight = analyzeWeightTrend(records, goals);
  if (weightInsight) insights.push(weightInsight);

  // 2. 血圧分析
  const bpInsight = analyzeBloodPressure(records);
  if (bpInsight) insights.push(bpInsight);

  // 3. 睡眠分析
  const sleepInsight = analyzeSleep(records);
  if (sleepInsight) insights.push(sleepInsight);

  // 4. 体調・気分の相関分析
  const correlationInsight = analyzeCorrelations(records);
  if (correlationInsight) insights.push(correlationInsight);

  // 5. 活動量分析
  const activityInsight = analyzeActivity(records);
  if (activityInsight) insights.push(activityInsight);

  // 6. AIによる総合分析（OpenAI）
  const aiInsight = await generateAIInsight(records, profile, goals, periodType);
  if (aiInsight) insights.push(aiInsight);

  return insights;
}

function analyzeWeightTrend(records: HealthRecord[], goals: any[]): Insight | null {
  const weightRecords = records.filter(r => r.weight != null);
  if (weightRecords.length < 2) return null;

  const firstWeight = weightRecords[0].weight!;
  const lastWeight = weightRecords[weightRecords.length - 1].weight!;
  const change = lastWeight - firstWeight;
  const avgWeight = weightRecords.reduce((sum, r) => sum + r.weight!, 0) / weightRecords.length;

  const weightGoal = goals.find(g => g.goal_type === 'weight');
  let goalProgress = null;
  if (weightGoal) {
    const remaining = lastWeight - weightGoal.target_value;
    goalProgress = {
      target: weightGoal.target_value,
      remaining,
      onTrack: (weightGoal.target_value < firstWeight && change < 0) ||
               (weightGoal.target_value > firstWeight && change > 0),
    };
  }

  const recommendations: string[] = [];
  let priority: 'low' | 'medium' | 'high' | 'critical' = 'low';
  let isAlert = false;

  if (Math.abs(change) > 2) {
    priority = 'high';
    isAlert = true;
    if (change > 0) {
      recommendations.push('急激な体重増加が見られます。食事内容を見直しましょう');
      recommendations.push('水分摂取量を確認してください');
    } else {
      recommendations.push('急激な体重減少が見られます。栄養バランスを確認しましょう');
    }
  } else if (goalProgress?.onTrack) {
    recommendations.push('目標に向かって順調です！このペースを維持しましょう');
  }

  return {
    insight_type: 'weight_trend',
    title: change < 0 ? '📉 体重が減少傾向' : change > 0 ? '📈 体重が増加傾向' : '➡️ 体重は安定',
    summary: `この期間で${Math.abs(change).toFixed(1)}kg${change < 0 ? '減少' : change > 0 ? '増加' : '変化なし'}しました（平均${avgWeight.toFixed(1)}kg）`,
    details: {
      start_weight: firstWeight,
      end_weight: lastWeight,
      change,
      average: avgWeight,
      goal_progress: goalProgress,
      data_points: weightRecords.length,
    },
    recommendations,
    priority,
    is_alert: isAlert,
  };
}

function analyzeBloodPressure(records: HealthRecord[]): Insight | null {
  const bpRecords = records.filter(r => r.systolic_bp != null && r.diastolic_bp != null);
  if (bpRecords.length < 2) return null;

  const avgSystolic = bpRecords.reduce((sum, r) => sum + r.systolic_bp!, 0) / bpRecords.length;
  const avgDiastolic = bpRecords.reduce((sum, r) => sum + r.diastolic_bp!, 0) / bpRecords.length;

  const recommendations: string[] = [];
  let priority: 'low' | 'medium' | 'high' | 'critical' = 'low';
  let isAlert = false;
  let status = '正常';

  if (avgSystolic >= 140 || avgDiastolic >= 90) {
    status = '高血圧';
    priority = 'critical';
    isAlert = true;
    recommendations.push('血圧が高めです。医師への相談をお勧めします');
    recommendations.push('塩分摂取を控えめにしましょう');
    recommendations.push('適度な運動を心がけましょう');
  } else if (avgSystolic >= 130 || avgDiastolic >= 85) {
    status = '高め';
    priority = 'high';
    recommendations.push('血圧がやや高めです。生活習慣を見直しましょう');
    recommendations.push('減塩を意識した食事を心がけましょう');
  } else if (avgSystolic < 90 || avgDiastolic < 60) {
    status = '低め';
    priority = 'medium';
    recommendations.push('血圧が低めです。水分をしっかり摂りましょう');
  }

  return {
    insight_type: 'blood_pressure',
    title: `🩺 血圧は${status}`,
    summary: `平均血圧: ${avgSystolic.toFixed(0)}/${avgDiastolic.toFixed(0)} mmHg`,
    details: {
      average_systolic: avgSystolic,
      average_diastolic: avgDiastolic,
      status,
      data_points: bpRecords.length,
    },
    recommendations,
    priority,
    is_alert: isAlert,
  };
}

function analyzeSleep(records: HealthRecord[]): Insight | null {
  const sleepRecords = records.filter(r => r.sleep_hours != null || r.sleep_quality != null);
  if (sleepRecords.length < 2) return null;

  const avgHours = sleepRecords.filter(r => r.sleep_hours).length > 0
    ? sleepRecords.filter(r => r.sleep_hours).reduce((sum, r) => sum + r.sleep_hours!, 0) / 
      sleepRecords.filter(r => r.sleep_hours).length
    : null;
  
  const avgQuality = sleepRecords.filter(r => r.sleep_quality).length > 0
    ? sleepRecords.filter(r => r.sleep_quality).reduce((sum, r) => sum + r.sleep_quality!, 0) / 
      sleepRecords.filter(r => r.sleep_quality).length
    : null;

  const recommendations: string[] = [];
  let priority: 'low' | 'medium' | 'high' | 'critical' = 'low';

  if (avgHours && avgHours < 6) {
    priority = 'high';
    recommendations.push('睡眠時間が不足しています。7-8時間を目標にしましょう');
    recommendations.push('就寝前のスマホ使用を控えましょう');
  } else if (avgHours && avgHours > 9) {
    priority = 'medium';
    recommendations.push('睡眠時間が長めです。睡眠の質を確認しましょう');
  }

  if (avgQuality && avgQuality < 3) {
    priority = 'high';
    recommendations.push('睡眠の質が低めです。睡眠環境を見直しましょう');
    recommendations.push('カフェインの摂取時間を確認しましょう');
  }

  return {
    insight_type: 'sleep_analysis',
    title: avgQuality && avgQuality >= 4 ? '😴 良質な睡眠' : avgQuality && avgQuality < 3 ? '😪 睡眠の質に注意' : '💤 睡眠分析',
    summary: `平均睡眠時間: ${avgHours?.toFixed(1) || '-'}時間、睡眠の質: ${avgQuality?.toFixed(1) || '-'}/5`,
    details: {
      average_hours: avgHours,
      average_quality: avgQuality,
      data_points: sleepRecords.length,
    },
    recommendations,
    priority,
    is_alert: false,
  };
}

function analyzeCorrelations(records: HealthRecord[]): Insight | null {
  // 睡眠と体調の相関を分析
  const validRecords = records.filter(r => 
    (r.sleep_hours != null || r.sleep_quality != null) && 
    (r.mood_score != null || r.overall_condition != null)
  );
  
  if (validRecords.length < 5) return null;

  // 簡易的な相関分析
  const sleepGoodDays = validRecords.filter(r => 
    (r.sleep_quality && r.sleep_quality >= 4) || (r.sleep_hours && r.sleep_hours >= 7)
  );
  const sleepGoodMoodAvg = sleepGoodDays.length > 0
    ? sleepGoodDays.reduce((sum, r) => sum + (r.mood_score || r.overall_condition || 3), 0) / sleepGoodDays.length
    : 0;

  const sleepBadDays = validRecords.filter(r => 
    (r.sleep_quality && r.sleep_quality <= 2) || (r.sleep_hours && r.sleep_hours < 6)
  );
  const sleepBadMoodAvg = sleepBadDays.length > 0
    ? sleepBadDays.reduce((sum, r) => sum + (r.mood_score || r.overall_condition || 3), 0) / sleepBadDays.length
    : 0;

  const correlation = sleepGoodMoodAvg - sleepBadMoodAvg;

  if (Math.abs(correlation) < 0.5) return null;

  return {
    insight_type: 'correlation_analysis',
    title: '🔗 睡眠と体調の関連性を発見',
    summary: correlation > 0 
      ? 'よく眠れた日は体調が良い傾向があります'
      : '睡眠と体調に負の相関が見られます',
    details: {
      sleep_good_mood_avg: sleepGoodMoodAvg,
      sleep_bad_mood_avg: sleepBadMoodAvg,
      correlation_strength: Math.abs(correlation),
    },
    recommendations: correlation > 0 
      ? ['睡眠の質を上げることで、日中のパフォーマンスも向上しそうです']
      : ['睡眠以外の要因が体調に影響している可能性があります'],
    priority: 'low',
    is_alert: false,
  };
}

function analyzeActivity(records: HealthRecord[]): Insight | null {
  const activityRecords = records.filter(r => r.step_count != null);
  if (activityRecords.length < 3) return null;

  const avgSteps = activityRecords.reduce((sum, r) => sum + r.step_count!, 0) / activityRecords.length;
  const maxSteps = Math.max(...activityRecords.map(r => r.step_count!));
  const minSteps = Math.min(...activityRecords.map(r => r.step_count!));

  const recommendations: string[] = [];
  let priority: 'low' | 'medium' | 'high' | 'critical' = 'low';

  if (avgSteps < 5000) {
    priority = 'high';
    recommendations.push('活動量が少なめです。1日8000歩を目標にしましょう');
    recommendations.push('階段を使う、一駅歩くなど小さな工夫から始めましょう');
  } else if (avgSteps >= 10000) {
    recommendations.push('素晴らしい活動量です！この調子を維持しましょう');
  }

  return {
    insight_type: 'activity_analysis',
    title: avgSteps >= 8000 ? '🚶 活動量は良好' : avgSteps < 5000 ? '⚠️ 活動量が不足' : '👣 活動量分析',
    summary: `平均歩数: ${avgSteps.toFixed(0)}歩/日`,
    details: {
      average_steps: avgSteps,
      max_steps: maxSteps,
      min_steps: minSteps,
      data_points: activityRecords.length,
    },
    recommendations,
    priority,
    is_alert: avgSteps < 3000,
  };
}

async function generateAIInsight(
  records: HealthRecord[],
  profile: any,
  goals: any[],
  periodType: string
): Promise<Insight | null> {
  try {
    const prompt = `以下の健康記録データを分析し、ユーザーへの個別アドバイスを生成してください。

期間: ${periodType === 'weekly' ? '1週間' : periodType === 'monthly' ? '1ヶ月' : '1日'}
記録数: ${records.length}件

データサマリー:
${JSON.stringify(summarizeRecords(records), null, 2)}

ユーザー情報:
- 年齢: ${profile?.age || '不明'}
- 性別: ${profile?.gender || '不明'}
- 目標: ${goals.map(g => `${g.goal_type}: ${g.target_value}${g.target_unit}`).join(', ') || 'なし'}

以下のJSON形式で回答してください:
{
  "title": "絵文字付きの短いタイトル",
  "summary": "2-3文の要約",
  "recommendations": ["具体的なアドバイス1", "具体的なアドバイス2", "具体的なアドバイス3"],
  "priority": "low" | "medium" | "high"
}`;

    const response = await fetch(getFastLLMChatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getFastLLMApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getFastLLMModel(),
        messages: [
          { role: "system", content: "あなたは優しく励ましながらも的確なアドバイスをする健康コーチです。" },
          { role: "user", content: prompt },
        ],
        max_tokens: 500,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      insight_type: 'ai_comprehensive',
      title: parsed.title || '🤖 AI分析',
      summary: parsed.summary || '',
      details: { source: 'xai' },
      recommendations: parsed.recommendations || [],
      priority: parsed.priority || 'low',
      is_alert: false,
    };
  } catch (error) {
    console.error("AI insight generation failed:", error);
    return null;
  }
}

function summarizeRecords(records: HealthRecord[]): Record<string, any> {
  const summary: Record<string, any> = {};

  const weightRecords = records.filter(r => r.weight);
  if (weightRecords.length > 0) {
    summary.weight = {
      count: weightRecords.length,
      min: Math.min(...weightRecords.map(r => r.weight!)),
      max: Math.max(...weightRecords.map(r => r.weight!)),
      avg: weightRecords.reduce((sum, r) => sum + r.weight!, 0) / weightRecords.length,
    };
  }

  const sleepRecords = records.filter(r => r.sleep_hours);
  if (sleepRecords.length > 0) {
    summary.sleep = {
      count: sleepRecords.length,
      avg_hours: sleepRecords.reduce((sum, r) => sum + r.sleep_hours!, 0) / sleepRecords.length,
    };
  }

  const moodRecords = records.filter(r => r.mood_score);
  if (moodRecords.length > 0) {
    summary.mood = {
      count: moodRecords.length,
      avg: moodRecords.reduce((sum, r) => sum + r.mood_score!, 0) / moodRecords.length,
    };
  }

  return summary;
}
