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

    // 最近の食事データ
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
        meal_plan_days!inner(day_date)
      `)
      .gte('meal_plan_days.day_date', sevenDaysAgo.toISOString().split('T')[0])
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

    // 過去のセッション要約を整形
    const pastSessionsInfo = pastSessions && pastSessions.length > 0
      ? `【過去の相談履歴（最新10件）】
${pastSessions.map((s: any) => {
  const keyFacts = s.context_snapshot?.key_facts || [];
  const userInsights = s.context_snapshot?.user_insights || [];
  return `
■ ${s.title}（${s.summary_generated_at ? new Date(s.summary_generated_at).toLocaleDateString('ja-JP') : '日付不明'}）
  概要: ${s.summary || '要約なし'}
  トピック: ${(s.key_topics || []).join(', ') || 'なし'}
  ${keyFacts.length > 0 ? `重要な事実:
${keyFacts.map((f: any) => `    - [${f.category}] ${f.date ? f.date + ': ' : ''}${f.content}`).join('\n')}` : ''}
  ${userInsights.length > 0 ? `判明したこと: ${userInsights.join(', ')}` : ''}`;
}).join('\n')}`
      : '';

    // 重要メッセージを整形
    const importantMessagesInfo = importantMessages && importantMessages.length > 0
      ? `【ユーザーが重要とマークした過去の会話（最新20件）】
${importantMessages.map((m: any) => `- ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''} ${m.importance_reason ? `(理由: ${m.importance_reason})` : ''}`).join('\n')}`
      : '';

    // システムメッセージを追加
    await supabase
      .from('ai_consultation_messages')
      .insert({
        session_id: data.id,
        role: 'system',
        content: `あなたは「ほめゴハン」のAI栄養アドバイザーです。
ユーザーの食事や健康について相談に乗り、具体的なアドバイスを提供します。

【重要な行動指針】
1. まず褒める：ユーザーの努力や良い点を見つけて褒める
2. 共感する：ユーザーの悩みや状況に寄り添う
3. 具体的に提案：実行可能な具体的なアドバイスを提供
4. アクション提案：必要に応じて献立の作成や変更を提案
5. 過去の相談内容を踏まえて、一貫性のあるアドバイスを提供

【ユーザー情報】
${JSON.stringify(contextSnapshot.profile, null, 2)}

【最近の食事傾向】
${recentMeals?.length || 0}件の食事記録があります。

${pastSessionsInfo}

${importantMessagesInfo}

あなたはユーザーの代わりに以下のアクションを実行できます：
- generate_day_menu: 特定の日の献立を作成
- generate_week_menu: 1週間の献立を作成
- update_meal: 既存の献立を変更
- add_to_shopping_list: 買い物リストに追加
- suggest_recipe: レシピを提案

アクションを提案する場合は、以下の形式でJSONを含めてください：
\`\`\`action
{
  "type": "アクション種類",
  "params": { ... }
}
\`\`\`

【重要】過去の相談で判明したユーザーの好みや傾向、設定した目標を覚えておき、一貫性のあるアドバイスを心がけてください。`,
        metadata: { isSystemPrompt: true },
      });

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

