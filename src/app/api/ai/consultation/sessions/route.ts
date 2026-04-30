import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// セッション一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'active';

  let query = supabase
    .from('ai_consultation_sessions')
    .select(`
      id,
      title,
      status,
      summary,
      key_topics,
      created_at,
      updated_at,
      ai_consultation_messages(id)
    `)
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error } = await query.limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sessions = (data || []).map((s: any) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    summary: s.summary,
    keyTopics: s.key_topics,
    messageCount: s.ai_consultation_messages?.length || 0,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));

  return NextResponse.json({ sessions });
}

// 新規セッション作成
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    
    // ユーザーの現在の状態をスナップショット
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // 最近の食事データ（日付ベースモデル）
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const { data: recentMeals } = await supabase
      .from('planned_meals')
      .select(`
        meal_type,
        dish_name,
        calories_kcal,
        protein_g,
        is_completed,
        user_daily_meals!inner(day_date)
      `)
      .eq('user_id', user.id)
      .gte('user_daily_meals.day_date', sevenDaysAgo.toISOString().split('T')[0])
      .limit(30);

    // 健康記録
    const { data: healthRecords } = await supabase
      .from('health_records')
      .select('*')
      .eq('user_id', user.id)
      .order('record_date', { ascending: false })
      .limit(7);

    // 過去のセッション要約を取得（最新10件）
    const { data: pastSessions } = await supabase
      .from('ai_consultation_sessions')
      .select('id, title, summary, key_topics, context_snapshot, summary_generated_at')
      .eq('user_id', user.id)
      .eq('status', 'closed')
      .not('summary', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(10);

    // 重要メッセージを取得（最新20件）
    const { data: importantMessages } = await supabase
      .from('ai_consultation_messages')
      .select(`
        content,
        importance_reason,
        created_at,
        ai_consultation_sessions!inner(user_id, title)
      `)
      .eq('is_important', true)
      .eq('ai_consultation_sessions.user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    const contextSnapshot = {
      profile: profile ? {
        age: profile.age,
        gender: profile.gender,
        height: profile.height,
        weight: profile.weight,
        targetWeight: profile.target_weight,
        healthConditions: profile.health_conditions,
        dietFlags: profile.diet_flags,
        fitnessGoals: profile.fitness_goals,
        cookingExperience: profile.cooking_experience,
      } : null,
      recentMeals: recentMeals || [],
      healthRecords: healthRecords || [],
      pastSessionSummaries: pastSessions || [],
      importantMessages: importantMessages || [],
      capturedAt: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('ai_consultation_sessions')
      .insert({
        user_id: user.id,
        title: body.title || 'AI相談',
        context_snapshot: contextSnapshot,
      })
      .select()
      .single();

    if (error) throw error;

    // #138: セッション作成時のシステムメッセージDB書き込みを削除。
    // システムプロンプトは messages/route.ts の buildSystemPrompt() で動的に構築され、
    // DB には保存しない（二重管理の解消）。

    return NextResponse.json({
      success: true, 
      session: {
        id: data.id,
        title: data.title,
        status: data.status,
        createdAt: data.created_at,
      }
    });

  } catch (error: any) {
    console.error('Session creation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

