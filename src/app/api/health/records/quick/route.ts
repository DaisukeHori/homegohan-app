import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { RECORD_DATE_PATTERN, sanitizeHealthRecordPayload, stripUndefined } from '@/lib/health-payloads';
import { todayLocal, formatLocalDate } from '@/lib/date-utils';
import { updateHealthStreak } from '@/lib/health-streaks';

const DATE_PATTERN = RECORD_DATE_PATTERN;

// クイック記録（体重・気分・睡眠のみ）
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

  const recordDate =
    typeof body.record_date === 'string' && body.record_date.trim()
      ? body.record_date.trim()
      : todayLocal();

  if (!DATE_PATTERN.test(recordDate)) {
    return NextResponse.json({ error: 'record_date must be in YYYY-MM-DD format' }, { status: 400 });
  }

  if (body.source !== undefined && typeof body.source !== 'string') {
    return NextResponse.json({ error: 'source must be a string' }, { status: 400 });
  }

  const dataSource = body.source === 'photo' ? 'photo' : 'quick';
  // #1048 F2-19: `{ weight: body.weight }` のように未送信フィールドを undefined のまま
  // 詰め替えると、オブジェクトにキー自体は残ってしまい sanitizeHealthRecordPayload の
  // hasOwn 判定で「null が送られた」と誤認され、未送信の項目まで null 上書きされる
  // （例: mood_score のみのクイック記録で weight が null に巻き戻る）。
  // stripUndefined で未送信キーを事前に除去してから渡す。
  const { data: sanitizedRecord, errors } = sanitizeHealthRecordPayload(stripUndefined({
    weight: body.weight,
    body_fat_percentage: body.bodyFat ?? body.body_fat_percentage,
    muscle_mass: body.muscleMass ?? body.muscle_mass,
    mood_score: body.mood_score,
    sleep_quality: body.sleep_quality,
  }));

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  // #1048 F2-19: キー存在(`in`)だけで判定すると、値が null の項目しか
  // 送られなかった場合でも「記録あり」扱いになり、streak が誤加算される。
  // 実際に値が入っている（null でない）項目があるかどうかで判定する。
  const hasMetric = ['weight', 'body_fat_percentage', 'muscle_mass', 'mood_score', 'sleep_quality'].some(
    (field) => sanitizedRecord[field as keyof typeof sanitizedRecord] != null,
  );

  if (!hasMetric) {
    return NextResponse.json({
      error: 'At least one quick health metric is required'
    }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {
    ...sanitizedRecord,
    data_source: dataSource,
    updated_at: new Date().toISOString(),
  };

  // #1048 F2-19: 確認してから insert/update する check-then-act は同時リクエストで
  // UNIQUE(user_id, record_date) 違反 500 を起こし得るため upsert に統一する。
  const result = await supabase
    .from('health_records')
    .upsert(
      {
        user_id: user.id,
        record_date: recordDate,
        ...updateData,
      },
      { onConflict: 'user_id,record_date' },
    )
    .select()
    .single();

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  // 連続記録を更新
  await updateHealthStreak(supabase, user.id, recordDate);

  // 前日との比較データを取得
  const yesterday = new Date(recordDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatLocalDate(yesterday);

  const { data: previousRecord } = await supabase
    .from('health_records')
    .select('weight, mood_score, sleep_quality')
    .eq('user_id', user.id)
    .eq('record_date', yesterdayStr)
    .single();

  // 変化を計算
  const changes: Record<string, number | null> = {};
  if (typeof sanitizedRecord.weight === 'number' && typeof previousRecord?.weight === 'number') {
    changes.weight = parseFloat((sanitizedRecord.weight - previousRecord.weight).toFixed(2));
  }

  // 連続記録情報を取得
  const { data: streak } = await supabase
    .from('health_streaks')
    .select('current_streak, longest_streak')
    .eq('user_id', user.id)
    .eq('streak_type', 'daily_record')
    .single();

  // user_profilesの体重・体組成も更新（今日の記録の場合）
  const today = todayLocal();
  if (recordDate === today) {
    const profileUpdate: Record<string, number> = {};
    if (typeof sanitizedRecord.weight === 'number') profileUpdate.weight = sanitizedRecord.weight;
    if (typeof sanitizedRecord.body_fat_percentage === 'number') {
      profileUpdate.body_fat_percentage = sanitizedRecord.body_fat_percentage;
    }
    if (typeof sanitizedRecord.muscle_mass === 'number') {
      profileUpdate.muscle_mass = sanitizedRecord.muscle_mass;
    }

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
