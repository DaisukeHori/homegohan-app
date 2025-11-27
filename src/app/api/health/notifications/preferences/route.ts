import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// 通知設定の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // デフォルト設定
  const defaultPreferences = {
    enabled: true,
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    record_mode: 'standard',
    personality_type: 'positive',
    morning_reminder_enabled: true,
    morning_reminder_time: '07:30',
    evening_reminder_enabled: false,
    evening_reminder_time: '21:00',
    vacation_mode: false,
    vacation_until: null,
  };

  return NextResponse.json({ 
    preferences: data || defaultPreferences,
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

  const body = await request.json();

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
        ...body,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();
  } else {
    result = await supabase
      .from('notification_preferences')
      .insert({
        user_id: user.id,
        ...body,
      })
      .select()
      .single();
  }

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  return NextResponse.json({ preferences: result.data });
}

