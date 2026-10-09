import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { sanitizeHealthGoalCreate } from '@/lib/health-payloads';
import { calculateGoalProgressPercentage } from '@/lib/health-goal-progress';
import { findGoalTypeDef, isWithinGoalRange } from '@/lib/health-goal-types';

// 目標一覧の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'active';

  let query = supabase
    .from('health_goals')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    return internalError('GET /api/health/goals', error, { userId: user.id, table: 'health_goals' });
  }

  return NextResponse.json({ goals: data });
}

// 目標の作成
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  // #1229: goal_type は受け付ける種類 (weight / body_fat / steps / step_count / sleep_hours) だけ、
  // target_value はその種類の範囲だけを通す。DB の検査トリガー (target_value > 0 など) に当たる前に 400 で返す。
  const { data: goalData, errors } = sanitizeHealthGoalCreate({
    goal_type: body.goal_type,
    target_value: body.target_value,
    target_unit: body.target_unit,
    target_date: body.target_date,
    note: body.note,
  });

  if (!goalData) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  const {
    goal_type: goalType,
    target_value: targetValue,
    target_unit: targetUnit,
    target_date: targetDate,
    note,
  } = goalData;

  // 現在値を取得（体重の場合）
  let profileValue: unknown = null;
  if (goalType === 'weight') {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('weight')
      .eq('id', user.id)
      .single();
    profileValue = profile?.weight;
  } else if (goalType === 'body_fat') {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('body_fat_percentage')
      .eq('id', user.id)
      .single();
    profileValue = profile?.body_fat_percentage;
  }

  // #1229: プロフィールの値が未入力・範囲外 (異常値) のときは開始値にしない。
  // そのまま start_value / current_value に入れると、DB の検査トリガー (current_value >= 0) や
  // 桁あふれ (numeric(10,2)) に当たって目標を作れなくなるため。
  const startRange = findGoalTypeDef(goalType)?.current;
  const startValue: number | null =
    startRange && isWithinGoalRange(profileValue, startRange) ? profileValue : null;

  // 進捗率を計算（新規作成時は current_value = start_value のため常に0%になるが、
  // #1046 round-2 Suggestion: PUT側と同じ calculateGoalProgressPercentage を使い
  // 重複ロジック・死んだ分岐を解消する）
  let progressPercentage = 0;
  if (startValue !== null) {
    progressPercentage = calculateGoalProgressPercentage(startValue, targetValue, startValue, 0);
  }

  const { data, error } = await supabase
    .from('health_goals')
    .insert({
      user_id: user.id,
      goal_type: goalType,
      target_value: targetValue,
      target_unit: targetUnit,
      target_date: targetDate,
      start_value: startValue,
      current_value: startValue,
      progress_percentage: progressPercentage,
      note,
      status: 'active',
    })
    .select()
    .single();

  if (error) {
    return internalError('POST /api/health/goals', error, { userId: user.id, table: 'health_goals' });
  }

  // user_profilesの目標も更新
  if (goalType === 'weight') {
    await supabase
      .from('user_profiles')
      .update({ target_weight: targetValue, target_date: targetDate })
      .eq('id', user.id);
  } else if (goalType === 'body_fat') {
    await supabase
      .from('user_profiles')
      .update({ target_body_fat: targetValue, target_date: targetDate })
      .eq('id', user.id);
  }

  return NextResponse.json({ goal: data });
}
