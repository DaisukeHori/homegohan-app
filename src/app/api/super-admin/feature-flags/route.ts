import { createClient } from '@/lib/supabase/server';
import { DEFAULT_FEATURE_FLAGS } from '@/lib/menu-generation-feature-flags';
import { NextResponse } from 'next/server';

// 機能フラグ取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || profile?.roles?.includes('super_admin') !== true) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // system_settingsから機能フラグを取得
    const { data: setting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'feature_flags')
      .single();

    const flags = { ...DEFAULT_FEATURE_FLAGS, ...(setting?.value ?? {}) };

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
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || profile?.roles?.includes('super_admin') !== true) {
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
