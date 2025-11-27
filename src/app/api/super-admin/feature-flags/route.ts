import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// デフォルトの機能フラグ
const DEFAULT_FLAGS = {
  ai_chat_enabled: true,
  meal_photo_analysis: true,
  recipe_generation: true,
  weekly_menu_generation: true,
  health_insights: true,
  comparison_feature: true,
  organization_features: true,
  maintenance_mode: false,
};

// 機能フラグ取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // system_settingsから機能フラグを取得
    const { data: setting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'feature_flags')
      .single();

    const flags = setting?.value || DEFAULT_FLAGS;

    return NextResponse.json({ flags });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 機能フラグ更新
export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { flags } = body;

    if (!flags || typeof flags !== 'object') {
      return NextResponse.json({ error: 'Invalid flags' }, { status: 400 });
    }

    const { error } = await supabase
      .from('system_settings')
      .upsert({
        key: 'feature_flags',
        value: flags,
        description: 'Feature flags for enabling/disabling features',
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      });

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: 'update_feature_flags',
        details: { flags },
        severity: 'high',
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

