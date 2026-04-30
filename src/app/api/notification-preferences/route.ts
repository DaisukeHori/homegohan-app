import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const DEFAULT_SETTINGS = {
  notifications_enabled: true,
  auto_analyze_enabled: true,
  data_share_enabled: false,
};

// 設定 toggle の取得
export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('notification_preferences')
    .select('notifications_enabled, auto_analyze_enabled, data_share_enabled')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const settings = data
    ? {
        notifications_enabled: data.notifications_enabled ?? DEFAULT_SETTINGS.notifications_enabled,
        auto_analyze_enabled: data.auto_analyze_enabled ?? DEFAULT_SETTINGS.auto_analyze_enabled,
        data_share_enabled: data.data_share_enabled ?? DEFAULT_SETTINGS.data_share_enabled,
      }
    : DEFAULT_SETTINGS;

  return NextResponse.json({ settings });
}

// 設定 toggle の部分更新
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const allowed = ['notifications_enabled', 'auto_analyze_enabled', 'data_share_enabled'] as const;
  const patch: Partial<Record<(typeof allowed)[number], boolean>> = {};

  for (const key of allowed) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') {
        return NextResponse.json({ error: `${key} must be boolean` }, { status: 400 });
      }
      patch[key] = body[key] as boolean;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from('notification_preferences')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();

  let result;
  if (existing) {
    result = await supabase
      .from('notification_preferences')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('notifications_enabled, auto_analyze_enabled, data_share_enabled')
      .single();
  } else {
    result = await supabase
      .from('notification_preferences')
      .insert({ user_id: user.id, ...patch })
      .select('notifications_enabled, auto_analyze_enabled, data_share_enabled')
      .single();
  }

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  const settings = {
    notifications_enabled: result.data.notifications_enabled ?? DEFAULT_SETTINGS.notifications_enabled,
    auto_analyze_enabled: result.data.auto_analyze_enabled ?? DEFAULT_SETTINGS.auto_analyze_enabled,
    data_share_enabled: result.data.data_share_enabled ?? DEFAULT_SETTINGS.data_share_enabled,
  };

  return NextResponse.json({ settings });
}
