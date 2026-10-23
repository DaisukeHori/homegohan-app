import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { HEALTH_GOAL_NOT_FOUND_MESSAGE, HEALTH_GOAL_NO_FIELDS_MESSAGE, HEALTH_GOAL_TARGET_UNIT_NULL_MESSAGE, HEALTH_GOAL_TARGET_VALUE_NULL_MESSAGE } from '@/lib/health-api-messages';
import { INVALID_ID_PARAM_CODE, INVALID_ID_PARAM_MESSAGE, isUuid } from '@/lib/http-params';
import { sanitizeHealthGoalUpdate } from '@/lib/health-payloads';
import { calculateGoalProgressPercentage } from '@/lib/health-goal-progress';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

// 目標の取得
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { id } = await params;
  // uuid 型の列に UUID でない文字列を渡すと 22P02 で 500 になるので、DB に投げる前に 400 にする (#1478)
  if (!isUuid(id)) {
    return NextResponse.json({ error: INVALID_ID_PARAM_MESSAGE, code: INVALID_ID_PARAM_CODE }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('health_goals')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error) {
    return internalError('GET /api/health/goals/[id]', error, { userId: user.id, table: 'health_goals' });
  }

  return NextResponse.json({ goal: data });
}

// 目標の更新
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { id } = await params;
  // uuid 型の列に UUID でない文字列を渡すと 22P02 で 500 になるので、DB に投げる前に 400 にする (#1478)
  if (!isUuid(id)) {
    return NextResponse.json({ error: INVALID_ID_PARAM_MESSAGE, code: INVALID_ID_PARAM_CODE }, { status: 400 });
  }
  const body = await request.json().catch(() => null);

  // 目標の所有者確認
  // #1229: 目標値の範囲は goal_type ごとに違うため、入力の検証より先に対象の行を取得する
  const { data: existing } = await supabase
    .from('health_goals')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: HEALTH_GOAL_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  const { data: updates, errors } = sanitizeHealthGoalUpdate(body, { goalType: existing.goal_type });

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: HEALTH_GOAL_NO_FIELDS_MESSAGE }, { status: 400 });
  }

  if (updates.target_value === null) {
    return NextResponse.json({ error: HEALTH_GOAL_TARGET_VALUE_NULL_MESSAGE }, { status: 400 });
  }

  if (updates.target_unit === null) {
    return NextResponse.json({ error: HEALTH_GOAL_TARGET_UNIT_NULL_MESSAGE }, { status: 400 });
  }

  // current_valueが更新された場合、進捗率を再計算
  const targetValue =
    updates.target_value !== undefined ? updates.target_value : existing.target_value;
  const currentValue =
    updates.current_value !== undefined ? updates.current_value : existing.current_value;

  let progressPercentage = existing.progress_percentage;
  if (currentValue !== null && existing.start_value !== null && targetValue !== null) {
    progressPercentage = calculateGoalProgressPercentage(
      existing.start_value,
      targetValue,
      currentValue,
      progressPercentage,
    );
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
    return internalError('PUT /api/health/goals/[id]', error, { userId: user.id, table: 'health_goals' });
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
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { id } = await params;
  // uuid 型の列に UUID でない文字列を渡すと 22P02 で 500 になるので、DB に投げる前に 400 にする (#1478)
  if (!isUuid(id)) {
    return NextResponse.json({ error: INVALID_ID_PARAM_MESSAGE, code: INVALID_ID_PARAM_CODE }, { status: 400 });
  }

  const { error } = await supabase
    .from('health_goals')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    return internalError('DELETE /api/health/goals/[id]', error, { userId: user.id, table: 'health_goals' });
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
