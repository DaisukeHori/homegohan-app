import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 管理者ロール変更（昇格/降格）
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
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

  // 自分自身は変更不可
  if (params.id === user.id) {
    return NextResponse.json({ error: 'Cannot modify own role' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { role } = body;

    if (!['user', 'support', 'admin', 'org_admin'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    // ターゲットユーザーの現在のロール取得
    const { data: targetUser } = await supabase
      .from('user_profiles')
      .select('role, nickname')
      .eq('id', params.id)
      .single();

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // super_adminは他のsuper_adminを変更できない
    if (targetUser.role === 'super_admin') {
      return NextResponse.json({ error: 'Cannot modify another super_admin' }, { status: 400 });
    }

    // ロール更新
    const { error } = await supabase
      .from('user_profiles')
      .update({ role })
      .eq('id', params.id);

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: 'change_admin_role',
        target_id: params.id,
        details: { 
          previousRole: targetUser.role, 
          newRole: role,
          targetNickname: targetUser.nickname,
        },
        severity: 'high',
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

