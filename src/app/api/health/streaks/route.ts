import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// 連続記録の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const streakType = searchParams.get('type') || 'daily_record';

  // 連続記録を取得
  const { data: streak, error } = await supabase
    .from('health_streaks')
    .select('*')
    .eq('user_id', user.id)
    .eq('streak_type', streakType)
    .single();

  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 連続記録がない場合のデフォルト値
  const defaultStreak = {
    streak_type: streakType,
    current_streak: 0,
    longest_streak: 0,
    last_activity_date: null,
    streak_start_date: null,
    achieved_badges: [],
    total_records: 0,
  };

  // 連続が途切れているかチェック
  let currentStreak = streak || defaultStreak;
  if (streak?.last_activity_date) {
    const lastDate = new Date(streak.last_activity_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    lastDate.setHours(0, 0, 0, 0);
    
    const diffDays = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // 2日以上経過していたら連続が途切れている
    if (diffDays > 1) {
      currentStreak = {
        ...streak,
        current_streak: 0,
        streak_start_date: null,
      };
    }
  }

  // 次のバッジまでの日数を計算
  const badgeMilestones = [7, 14, 30, 60, 100];
  const achievedBadges = currentStreak.achieved_badges || [];
  let nextBadge = null;
  let daysToNextBadge = null;
  
  for (const milestone of badgeMilestones) {
    if (!achievedBadges.includes(`${milestone}_days`)) {
      nextBadge = milestone;
      daysToNextBadge = milestone - currentStreak.current_streak;
      break;
    }
  }

  // 週間の記録状況を取得
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  const weekStartStr = weekStart.toISOString().split('T')[0];

  const { data: weeklyRecords } = await supabase
    .from('health_records')
    .select('record_date')
    .eq('user_id', user.id)
    .gte('record_date', weekStartStr)
    .order('record_date', { ascending: true });

  const recordedDates = (weeklyRecords || []).map(r => r.record_date);

  return NextResponse.json({ 
    streak: currentStreak,
    nextBadge,
    daysToNextBadge,
    weeklyRecords: recordedDates,
    weeklyRecordCount: recordedDates.length,
  });
}

// 連続記録の手動リセット（テスト用）
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const streakType = searchParams.get('type') || 'daily_record';

  const { error } = await supabase
    .from('health_streaks')
    .delete()
    .eq('user_id', user.id)
    .eq('streak_type', streakType);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

