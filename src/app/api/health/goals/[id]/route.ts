import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// 目標の取得
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const { data, error } = await supabase
    .from('health_goals')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ goal: data });
}

// 目標の更新
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();

  // 目標の所有者確認
  const { data: existing } = await supabase
    .from('health_goals')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 });
  }

  // current_valueが更新された場合、進捗率を再計算
  let progressPercentage = existing.progress_percentage;
  if (body.current_value !== undefined && existing.start_value !== null) {
    const totalChange = Math.abs(existing.target_value - existing.start_value);
    const currentChange = Math.abs(body.current_value - existing.start_value);
    if (totalChange > 0) {
      progressPercentage = Math.min(100, (currentChange / totalChange) * 100);
    }
  }

  // マイルストーン達成チェック
  let milestones = existing.milestones || [];
  if (body.current_value !== undefined) {
    const milestoneValues = calculateMilestones(existing.start_value, existing.target_value);
    for (const milestone of milestoneValues) {
      const achieved = milestones.find((m: any) => m.value === milestone);
      if (!achieved) {
        // 減量目標の場合
        if (existing.target_value < existing.start_value && body.current_value <= milestone) {
          milestones.push({ value: milestone, achieved_at: new Date().toISOString() });
        }
        // 増量目標の場合
        else if (existing.target_value > existing.start_value && body.current_value >= milestone) {
          milestones.push({ value: milestone, achieved_at: new Date().toISOString() });
        }
      }
    }
  }

  // 目標達成チェック
  let status = body.status || existing.status;
  let achievedAt = existing.achieved_at;
  if (body.current_value !== undefined) {
    const isAchieved = existing.target_value < existing.start_value
      ? body.current_value <= existing.target_value
      : body.current_value >= existing.target_value;
    
    if (isAchieved && status === 'active') {
      status = 'achieved';
      achievedAt = new Date().toISOString();
    }
  }

  const { data, error } = await supabase
    .from('health_goals')
    .update({
      ...body,
      progress_percentage: progressPercentage,
      milestones,
      status,
      achieved_at: achievedAt,
      last_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ goal: data });
}

// 目標の削除
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const { error } = await supabase
    .from('health_goals')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

// マイルストーン値を計算
function calculateMilestones(start: number, target: number): number[] {
  const diff = target - start;
  const milestones: number[] = [];
  
  // 25%, 50%, 75%のマイルストーン
  [0.25, 0.5, 0.75].forEach(ratio => {
    milestones.push(parseFloat((start + diff * ratio).toFixed(1)));
  });
  
  return milestones;
}

