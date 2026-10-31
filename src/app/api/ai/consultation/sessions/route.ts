import { createClient } from '@/lib/supabase/server';
import { jstDayOffset } from '@/lib/jst-day-ranges';
import { NextResponse } from 'next/server';
import { aiChatDisabledResponse } from '@/lib/ai/ai-chat-gate';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

/** 新しいセッションの文脈に入れる、最近の食事の日数 (JST の今日から何日前までか) */
const RECENT_MEAL_DAYS = 7;
/**
 * 新しいセッションの文脈に入れる、最近の食事の件数の上限 (いままでの値。7 日 × 1 日 3 食 = 21 件より多い)。
 * 7 日前からの日の古い側からこの件数を読む (先の日の献立もあるので、新しい側から読むと過去の食事が落ちる。#2150)
 */
const RECENT_MEAL_LIMIT = 30;

// セッション一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'active';

  // 更新した日時の新しい順。同じ日時は id の順で、上限の境目でどれが入るかも決まる (#2139 T1)
  let query = orderListBy(
    supabase
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
      .eq('user_id', user.id),
    LIST_ORDERS.aiConsultationSessions,
  );

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error } = await query.limit(50);

  if (error) return internalError('GET /api/ai/consultation/sessions', error, { userId: user.id });

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
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // #1148: AI 相談の緊急停止スイッチ (feature_flags の ai_chat_enabled。通常は ON)
  const unavailable = await aiChatDisabledResponse(user.id);
  if (unavailable) return unavailable;

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    
    // ユーザーの現在の状態をスナップショット
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // 最近の食事データ（日付ベースモデル）
    // 7 日前は JST の暦日で求める (#1433。day_date は JST の暦日)
    // 日の古い順。同じ日の食事は id の順で、件数の上限の境目でどれが入るかも決まる (#2150)
    const sevenDaysAgo = jstDayOffset(-RECENT_MEAL_DAYS);
    const { data: recentMeals } = await orderListBy(
      supabase
        .from('planned_meals')
        .select(`
        meal_type,
        dish_name,
        calories_kcal,
        protein_g,
        is_completed,
        user_daily_meals!inner(day_date, user_id)
      `)
        .eq('user_daily_meals.user_id', user.id)
        .gte('user_daily_meals.day_date', sevenDaysAgo),
      LIST_ORDERS.aiConsultationContextMealsByDay,
    )
      .limit(RECENT_MEAL_LIMIT);

    // 健康記録
    const { data: healthRecords } = await supabase
      .from('health_records')
      .select('*')
      .eq('user_id', user.id)
      .order('record_date', { ascending: false })
      .limit(7);

    // 過去のセッション要約を取得（最新10件）
    // 同じ日時は id の順 (#2139 T1)。並びは not の前に重ねる (not のあとの問い合わせの型を orderListBy に渡すと、
    // 型の深さの上限 TS2589 に当たる)
    const { data: pastSessions } = await orderListBy(
      supabase
        .from('ai_consultation_sessions')
        .select('id, title, summary, key_topics, context_snapshot, summary_generated_at')
        .eq('user_id', user.id)
        .eq('status', 'closed'),
      LIST_ORDERS.aiConsultationPastSummaries,
    )
      .not('summary', 'is', null)
      .limit(10);

    // 重要メッセージを取得（最新20件）
    // 同じ日時は id の順 (#2139 T1)
    const { data: importantMessages } = await orderListBy(
      supabase
        .from('ai_consultation_messages')
        .select(`
        content,
        importance_reason,
        created_at,
        ai_consultation_sessions!inner(user_id, title)
      `)
        .eq('is_important', true)
        .eq('ai_consultation_sessions.user_id', user.id),
      LIST_ORDERS.aiConsultationImportantMessages,
    )
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
    return internalError('POST /api/ai/consultation/sessions', error, { userId: user.id });
  }
}

