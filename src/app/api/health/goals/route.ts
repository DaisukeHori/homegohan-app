import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

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

  const body = await request.json();
  const { goal_type, target_value, target_unit, target_date, note } = body;

  if (!goal_type || target_value === undefined || !target_unit) {
    return NextResponse.json({ 
      error: 'goal_type, target_value, and target_unit are required' 
    }, { status: 400 });
  }

  // 現在値を取得（体重の場合）
  let startValue = null;
  if (goal_type === 'weight') {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('weight')
      .eq('id', user.id)
      .single();
    startValue = profile?.weight;
  } else if (goal_type === 'body_fat') {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('body_fat_percentage')
      .eq('id', user.id)
      .single();
    startValue = profile?.body_fat_percentage;
  }

  // 進捗率を計算
  let progressPercentage = 0;
  if (startValue !== null && target_value !== null) {
    const totalChange = Math.abs(target_value - startValue);
    if (totalChange > 0) {
      progressPercentage = 0;
    }
  }

  const { data, error } = await supabase
    .from('health_goals')
    .insert({
      user_id: user.id,
      goal_type,
      target_value,
      target_unit,
      target_date,
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
  if (goal_type === 'weight') {
    await supabase
      .from('user_profiles')
      .update({ target_weight: target_value, target_date })
      .eq('id', user.id);
  } else if (goal_type === 'body_fat') {
    await supabase
      .from('user_profiles')
      .update({ target_body_fat: target_value, target_date })
      .eq('id', user.id);
  }

  return NextResponse.json({ goal: data });
}

