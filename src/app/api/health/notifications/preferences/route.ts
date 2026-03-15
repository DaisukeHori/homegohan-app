import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  mergeNotificationPreferences,
  sanitizeNotificationPreferences,
} from '@/lib/health-payloads';

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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('notification_preferences')
    .select(PREFERENCE_COLUMNS)
    .eq('user_id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ 
    preferences: mergeNotificationPreferences(data),
    isDefault: !data,
  });
}

// 通知設定の更新
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { data: preferences, errors } = sanitizeNotificationPreferences(body);

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(preferences).length === 0) {
    return NextResponse.json({ error: 'No valid preference fields were provided' }, { status: 400 });
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
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  return NextResponse.json({ preferences: mergeNotificationPreferences(result.data) });
}
