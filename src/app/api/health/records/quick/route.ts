import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// クイック記録（体重・気分・睡眠のみ）
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const {
    weight,
    bodyFat,       // 体脂肪率（写真からの記録用）
    muscleMass,    // 筋肉量（写真からの記録用）
    mood_score,
    sleep_quality,
    source,        // 'manual' | 'photo' - データソース
    record_date = new Date().toISOString().split('T')[0]
  } = body;

  // 少なくとも1つのデータが必要
  if (!weight && !mood_score && !sleep_quality) {
    return NextResponse.json({
      error: 'At least one field (weight, mood_score, or sleep_quality) is required'
    }, { status: 400 });
  }

  // 既存レコードを確認
  const { data: existing } = await supabase
    .from('health_records')
    .select('*')
    .eq('user_id', user.id)
    .eq('record_date', record_date)
    .single();

  const updateData: Record<string, any> = {
    data_source: source === 'photo' ? 'photo' : 'quick',
    updated_at: new Date().toISOString(),
  };

  if (weight !== undefined) updateData.weight = weight;
  if (bodyFat !== undefined) updateData.body_fat_percentage = bodyFat;
  if (muscleMass !== undefined) updateData.muscle_mass = muscleMass;
  if (mood_score !== undefined) updateData.mood_score = mood_score;
  if (sleep_quality !== undefined) updateData.sleep_quality = sleep_quality;

  let result;
  
  if (existing) {
    // 更新（既存データを保持しつつ新しいデータをマージ）
    result = await supabase
      .from('health_records')
      .update(updateData)
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
        ...updateData,
      })
      .select()
      .single();
  }

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  // 連続記録を更新
  await updateStreak(supabase, user.id, record_date);

  // 前日との比較データを取得
  const yesterday = new Date(record_date);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const { data: previousRecord } = await supabase
    .from('health_records')
    .select('weight, mood_score, sleep_quality')
    .eq('user_id', user.id)
    .eq('record_date', yesterdayStr)
    .single();

  // 変化を計算
  const changes: Record<string, number | null> = {};
  if (weight && previousRecord?.weight) {
    changes.weight = parseFloat((weight - previousRecord.weight).toFixed(2));
  }

  // 連続記録情報を取得
  const { data: streak } = await supabase
    .from('health_streaks')
    .select('current_streak, longest_streak')
    .eq('user_id', user.id)
    .eq('streak_type', 'daily_record')
    .single();

  // user_profilesの体重・体組成も更新（今日の記録の場合）
  const today = new Date().toISOString().split('T')[0];
  if (record_date === today) {
    const profileUpdate: Record<string, any> = {};
    if (weight) profileUpdate.weight = weight;
    if (bodyFat) profileUpdate.body_fat_percentage = bodyFat;
    if (muscleMass) profileUpdate.muscle_mass = muscleMass;

    if (Object.keys(profileUpdate).length > 0) {
      await supabase
        .from('user_profiles')
        .update(profileUpdate)
        .eq('id', user.id);
    }
  }

  return NextResponse.json({ 
    record: result.data,
    changes,
    streak: streak || { current_streak: 1, longest_streak: 1 },
    message: getEncouragementMessage(changes, streak?.current_streak || 1),
  });
}

// 連続記録の更新
async function updateStreak(supabase: any, userId: string, recordDate: string) {
  const streakType = 'daily_record';
  
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
    const lastDate = streak.last_activity_date;
    
    if (lastDate === recordDate) return;
    
    let newStreak = streak.current_streak;
    let newStreakStart = streak.streak_start_date;
    
    if (lastDate === yesterdayStr) {
      newStreak += 1;
    } else {
      newStreak = 1;
      newStreakStart = recordDate;
    }
    
    const longestStreak = Math.max(streak.longest_streak, newStreak);
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

// 励ましメッセージを生成
function getEncouragementMessage(changes: Record<string, number | null>, streak: number): string {
  const messages: string[] = [];

  // 体重変化に基づくメッセージ
  if (changes.weight !== null && changes.weight !== undefined) {
    if (changes.weight < -0.3) {
      messages.push(`🎉 昨日より${Math.abs(changes.weight).toFixed(1)}kg減りました！素晴らしい！`);
    } else if (changes.weight < 0) {
      messages.push(`✨ 少しずつ減っています！この調子！`);
    } else if (changes.weight === 0) {
      messages.push(`📊 昨日と同じ体重です。安定していますね。`);
    } else if (changes.weight > 0.5) {
      messages.push(`💪 少し増えましたが、水分量の変動かもしれません。焦らず続けましょう！`);
    }
  }

  // 連続記録に基づくメッセージ
  if (streak === 7) {
    messages.push(`🌱 1週間連続達成！素晴らしいスタートです！`);
  } else if (streak === 14) {
    messages.push(`🌿 2週間連続達成！習慣化が進んでいます！`);
  } else if (streak === 30) {
    messages.push(`🌳 1ヶ月連続達成！もう立派な習慣です！`);
  } else if (streak > 30) {
    messages.push(`🔥 ${streak}日連続！あなたは健康マスターです！`);
  } else if (streak > 1) {
    messages.push(`📝 ${streak}日連続記録中！`);
  }

  return messages.join(' ') || '今日も記録ありがとうございます！';
}

