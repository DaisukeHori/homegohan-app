import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// ユーザーBAN
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();

    // 自分自身はBANできない
    if (params.id === user.id) {
      return NextResponse.json({ error: '自分自身をBANすることはできません' }, { status: 400 });
    }

    // 対象ユーザーの権限確認
    const { data: targetProfile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', params.id)
      .single();

    if (!targetProfile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // super_adminはBANできない
    if (targetProfile.role === 'super_admin') {
      return NextResponse.json({ error: 'スーパー管理者はBANできません' }, { status: 403 });
    }

    // adminはadminをBANできない
    if (profile.role === 'admin' && targetProfile.role === 'admin') {
      return NextResponse.json({ error: '管理者は他の管理者をBANできません' }, { status: 403 });
    }

    const { error } = await supabase
      .from('user_profiles')
      .update({
        is_banned: true,
        banned_at: new Date().toISOString(),
        banned_reason: body.reason || null,
      })
      .eq('id', params.id);

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action: 'ban_user',
        target_type: 'user',
        target_id: params.id,
        details: { reason: body.reason },
        severity: 'warning',
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Ban user error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// BAN解除
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { error } = await supabase
      .from('user_profiles')
      .update({
        is_banned: false,
        banned_at: null,
        banned_reason: null,
      })
      .eq('id', params.id);

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action: 'unban_user',
        target_type: 'user',
        target_id: params.id,
        details: {},
        severity: 'info',
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Unban user error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

