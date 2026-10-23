import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { HEALTH_PREFERENCES_NO_FIELDS_MESSAGE } from '@/lib/health-api-messages';
import {
  mergeNotificationPreferences,
  sanitizeNotificationPreferences,
} from '@/lib/health-payloads';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

const PREFERENCE_COLUMNS = [
  'enabled',
  'quiet_hours_start',
  'quiet_hours_end',
  'record_mode',
  'personality_type',
  'morning_reminder_enabled',
  'morning_reminder_time',
  'evening_reminder_enabled',
  'evening_reminder_time',
  'vacation_mode',
  'vacation_until',
].join(', ');

// 通知設定の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('notification_preferences')
    .select(PREFERENCE_COLUMNS)
    .eq('user_id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    return internalError('GET /api/health/notifications/preferences', error, {
      userId: user.id,
      table: 'notification_preferences',
    });
  }

  return NextResponse.json({ 
    preferences: mergeNotificationPreferences(data),
    isDefault: !data,
  });
}

// 通知設定の更新
export async function PUT(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { data: preferences, errors } = sanitizeNotificationPreferences(body);

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(preferences).length === 0) {
    return NextResponse.json({ error: HEALTH_PREFERENCES_NO_FIELDS_MESSAGE }, { status: 400 });
  }

  // 既存設定を確認
  const { data: existing } = await supabase
    .from('notification_preferences')
    .select('id')
    .eq('user_id', user.id)
    .single();

  let result;
  
  if (existing) {
    result = await supabase
      .from('notification_preferences')
      .update({
        ...preferences,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select(PREFERENCE_COLUMNS)
      .single();
  } else {
    result = await supabase
      .from('notification_preferences')
      .insert({
        user_id: user.id,
        ...preferences,
      })
      .select(PREFERENCE_COLUMNS)
      .single();
  }

  if (result.error) {
    return internalError('PUT /api/health/notifications/preferences', result.error, {
      userId: user.id,
      table: 'notification_preferences',
    });
  }

  return NextResponse.json({ preferences: mergeNotificationPreferences(result.data) });
}
