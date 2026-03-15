import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sanitizeHealthGoalUpdate } from '@/lib/health-payloads';

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
    return NextResponse.json({ error: error.message }, { status: 500 });
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

  const goalType = typeof body.goal_type === 'string' ? body.goal_type.trim() : '';
  const { data: goalData, errors } = sanitizeHealthGoalUpdate({
    target_value: body.target_value,
    target_unit: body.target_unit,
    target_date: body.target_date,
    note: body.note,
  });

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (!goalType || goalData.target_value === undefined || goalData.target_value === null || !goalData.target_unit) {
    return NextResponse.json({ 
      error: 'goal_type, target_value, and target_unit are required' 
    }, { status: 400 });
  }

  const targetValue = goalData.target_value;
  const targetUnit = goalData.target_unit;
  const targetDate = goalData.target_date === undefined ? null : goalData.target_date;
  const note = goalData.note === undefined ? null : goalData.note;

  // 現在値を取得（体重の場合）
  let startValue = null;
  if (goalType === 'weight') {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('weight')
      .eq('id', user.id)
      .single();
    startValue = profile?.weight;
  } else if (goalType === 'body_fat') {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('body_fat_percentage')
      .eq('id', user.id)
      .single();
    startValue = profile?.body_fat_percentage;
  }

  // 進捗率を計算
  let progressPercentage = 0;
  if (startValue !== null) {
    const totalChange = Math.abs(targetValue - startValue);
    if (totalChange > 0) {
      progressPercentage = 0;
    }
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
    return NextResponse.json({ error: error.message }, { status: 500 });
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
