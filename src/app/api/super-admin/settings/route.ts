import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// システム設定一覧取得
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
    const { data: settings, error } = await supabase
      .from('system_settings')
      .select('*')
      .order('key', { ascending: true });

    if (error) throw error;

    return NextResponse.json({
      settings: (settings || []).map((s: any) => ({
        key: s.key,
        value: s.value,
        description: s.description,
        updatedAt: s.updated_at,
      })),
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// システム設定更新
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
    const { key, value, description } = body;

    if (!key) {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('system_settings')
      .upsert({
        key,
        value,
        description,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      });

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: 'update_system_setting',
        details: { key, value },
        severity: 'high',
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

