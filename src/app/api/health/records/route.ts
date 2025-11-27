import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// 健康記録の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');
  const limit = parseInt(searchParams.get('limit') || '30');

  let query = supabase
    .from('health_records')
    .select('*')
    .eq('user_id', user.id)
    .order('record_date', { ascending: false })
    .limit(limit);

  if (startDate) {
    query = query.gte('record_date', startDate);
  }
  if (endDate) {
    query = query.lte('record_date', endDate);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ records: data });
}

// 健康記録の作成・更新（UPSERT）
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { record_date, ...recordData } = body;

  if (!record_date) {
    return NextResponse.json({ error: 'record_date is required' }, { status: 400 });
  }

  // 既存レコードを確認
  const { data: existing } = await supabase
    .from('health_records')
    .select('id')
    .eq('user_id', user.id)
    .eq('record_date', record_date)
    .single();

  let result;
  
  if (existing) {
    // 更新
    result = await supabase
      .from('health_records')
      .update({
        ...recordData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();
  } else {
    // 新規作成
    result = await supabase
      .from('health_records')
      .insert({
        user_id: user.id,
        record_date,
        ...recordData,
      })
      .select()
      .single();
  }

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  // 連続記録を更新
  await updateStreak(supabase, user.id, record_date);

  // user_profilesの体重も更新（最新の記録の場合）
  if (recordData.weight) {
    const today = new Date().toISOString().split('T')[0];
    if (record_date === today) {
      await supabase
        .from('user_profiles')
        .update({ weight: recordData.weight })
        .eq('id', user.id);
    }
  }

  return NextResponse.json({ record: result.data });
}

// 連続記録の更新
async function updateStreak(supabase: any, userId: string, recordDate: string) {
  const streakType = 'daily_record';
  
  // 現在の連続記録を取得
  const { data: streak } = await supabase
    .from('health_streaks')
    .select('*')
    .eq('user_id', userId)
    .eq('streak_type', streakType)
    .single();

  const today = new Date(recordDate);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  if (streak) {
    // 既存の連続記録がある場合
    const lastDate = streak.last_activity_date;
    
    if (lastDate === recordDate) {
      // 同じ日の記録は無視
      return;
    }
    
    let newStreak = streak.current_streak;
    let newStreakStart = streak.streak_start_date;
    
    if (lastDate === yesterdayStr) {
      // 連続している
      newStreak += 1;
    } else {
      // 連続が途切れた
      newStreak = 1;
      newStreakStart = recordDate;
    }
    
    const longestStreak = Math.max(streak.longest_streak, newStreak);
    
    // バッジ判定
    const achievedBadges = streak.achieved_badges || [];
    const badgeMilestones = [7, 14, 30, 60, 100];
    for (const milestone of badgeMilestones) {
      const badgeCode = `${milestone}_days`;
      if (newStreak >= milestone && !achievedBadges.includes(badgeCode)) {
        achievedBadges.push(badgeCode);
      }
    }
    
    await supabase
      .from('health_streaks')
      .update({
        current_streak: newStreak,
        longest_streak: longestStreak,
        last_activity_date: recordDate,
        streak_start_date: newStreakStart,
        achieved_badges: achievedBadges,
        total_records: streak.total_records + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', streak.id);
  } else {
    // 新規作成
    await supabase
      .from('health_streaks')
      .insert({
        user_id: userId,
        streak_type: streakType,
        current_streak: 1,
        longest_streak: 1,
        last_activity_date: recordDate,
        streak_start_date: recordDate,
        achieved_badges: [],
        total_records: 1,
      });
  }
}

