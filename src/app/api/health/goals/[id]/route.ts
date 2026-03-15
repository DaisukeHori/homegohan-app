import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sanitizeHealthGoalUpdate } from '@/lib/health-payloads';

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
  const body = await request.json().catch(() => null);
  const { data: updates, errors } = sanitizeHealthGoalUpdate(body);

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid goal fields were provided' }, { status: 400 });
  }

  if (updates.target_value === null) {
    return NextResponse.json({ error: 'target_value cannot be null' }, { status: 400 });
  }

  if (updates.target_unit === null) {
    return NextResponse.json({ error: 'target_unit cannot be null' }, { status: 400 });
  }

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
  const targetValue =
    updates.target_value !== undefined ? updates.target_value : existing.target_value;
  const currentValue =
    updates.current_value !== undefined ? updates.current_value : existing.current_value;

  let progressPercentage = existing.progress_percentage;
  if (currentValue !== null && existing.start_value !== null && targetValue !== null) {
    const totalChange = Math.abs(targetValue - existing.start_value);
    const currentChange = Math.abs(currentValue - existing.start_value);
    if (totalChange > 0) {
      progressPercentage = Math.min(100, (currentChange / totalChange) * 100);
    }
  }

  // マイルストーン達成チェック
  let milestones = Array.isArray(existing.milestones) ? existing.milestones : [];
  if (
    existing.start_value !== null &&
    targetValue !== null &&
    currentValue !== null &&
    (updates.current_value !== undefined || updates.target_value !== undefined)
  ) {
    const previousMilestones = new Map(
      milestones
        .filter((milestone: any) => milestone?.value != null && milestone?.achieved_at)
        .map((milestone: any) => [milestone.value, milestone.achieved_at])
    );

    milestones = calculateMilestones(existing.start_value, targetValue)
      .filter((milestone) => isGoalAchieved(existing.start_value, targetValue, currentValue, milestone))
      .map((value) => ({
        value,
        achieved_at: previousMilestones.get(value) || new Date().toISOString(),
      }));
  }

  // 目標達成チェック
  let status = existing.status;
  let achievedAt = existing.achieved_at;

  if (
    existing.status !== 'cancelled' &&
    existing.start_value !== null &&
    targetValue !== null &&
    currentValue !== null
  ) {
    const achieved = isGoalAchieved(existing.start_value, targetValue, currentValue, targetValue);

    if (achieved) {
      status = 'achieved';
      achievedAt = achievedAt || new Date().toISOString();
    } else if (updates.current_value !== undefined || updates.target_value !== undefined) {
      status = 'active';
      achievedAt = null;
    }
  }

  const { data, error } = await supabase
    .from('health_goals')
    .update({
      ...updates,
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

function isGoalAchieved(start: number, target: number, current: number, threshold: number): boolean {
  return target < start ? current <= threshold : current >= threshold;
}
