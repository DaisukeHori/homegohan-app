import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { HEALTH_STREAK_TYPE_INVALID_MESSAGE } from '@/lib/health-api-messages';
import { addDaysToDate, todayLocal } from '@/lib/date-utils';

/** 「週間の記録状況」の日数 (JST の今日を含む) */
const WEEKLY_RECORD_DAYS = 7;

// 連続記録の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rawType = searchParams.get('type') || 'daily_record';

  const ALLOWED_STREAK_TYPES = ['daily_record', 'meal_record', 'health_record', 'exercise_record'] as const;
  type StreakType = (typeof ALLOWED_STREAK_TYPES)[number];
  if (!ALLOWED_STREAK_TYPES.includes(rawType as StreakType)) {
    return NextResponse.json({ error: HEALTH_STREAK_TYPE_INVALID_MESSAGE }, { status: 400 });
  }
  const streakType = rawType;

  // 連続記録を取得
  const { data: streak, error } = await supabase
    .from('health_streaks')
    .select('*')
    .eq('user_id', user.id)
    .eq('streak_type', streakType)
    .single();

  if (error && error.code !== 'PGRST116') {
    return internalError('GET /api/health/streaks', error, { userId: user.id, table: 'health_streaks' });
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
    // #266: JST の今日を使用して UTC ズレを防ぐ
    // 最後に記録した日が昨日より前 (2 日以上経過) なら、連続が途切れている。日付 (YYYY-MM-DD) どうしを比べるので、
    // 実行環境のタイムゾーン・夏時間に左右されない (#1463。以前は new Date + setHours (ローカル時刻) の差をミリ秒で割って日数にしていたので、
    // 夏時間の切り替えをまたぐと 1 時間足りず、UTC より西の実行環境では 2 日空いても「1 日」と数えて連続が続いていた)
    const yesterdayStr = addDaysToDate(todayLocal(), -1);
    if (streak.last_activity_date < yesterdayStr) {
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
  // #266: JST の今日を基準に週間開始日 (今日を含む 7 日間の最初の日) を計算する。
  // 暦の計算だけで求める (#1463。以前の new Date(今日) (UTC の 0 時) + setDate (ローカル時刻) + toLocaleDateString (JST) は、
  // 結果こそ合っていたが、ローカル時刻の setDate と、UTC の 0 時 = JST の 9 時という余裕に頼る書き方だった)
  const weekStartStr = addDaysToDate(todayLocal(), -(WEEKLY_RECORD_DAYS - 1));

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
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rawTypeDelete = searchParams.get('type') || 'daily_record';

  const ALLOWED_STREAK_TYPES_DELETE = ['daily_record', 'meal_record', 'health_record', 'exercise_record'] as const;
  type StreakTypeDelete = (typeof ALLOWED_STREAK_TYPES_DELETE)[number];
  if (!ALLOWED_STREAK_TYPES_DELETE.includes(rawTypeDelete as StreakTypeDelete)) {
    return NextResponse.json({ error: HEALTH_STREAK_TYPE_INVALID_MESSAGE }, { status: 400 });
  }
  const streakType = rawTypeDelete;

  const { error } = await supabase
    .from('health_streaks')
    .delete()
    .eq('user_id', user.id)
    .eq('streak_type', streakType);

  if (error) {
    return internalError('DELETE /api/health/streaks', error, { userId: user.id, table: 'health_streaks' });
  }

  return NextResponse.json({ success: true });
}

