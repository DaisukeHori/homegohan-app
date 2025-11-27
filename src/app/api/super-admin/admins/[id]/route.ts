import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 管理者ロール変更（追加/削除）
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || !profile?.roles?.includes('super_admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 自分自身は変更不可
  if (params.id === user.id) {
    return NextResponse.json({ error: 'Cannot modify own roles' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { roles } = body; // 新しいロール配列

    // rolesが配列でない場合はエラー
    if (!Array.isArray(roles)) {
      return NextResponse.json({ error: 'Roles must be an array' }, { status: 400 });
    }

    // 許可されたロールのみ
    const allowedRoles = ['user', 'support', 'admin', 'org_admin', 'super_admin'];
    const invalidRoles = roles.filter((r: string) => !allowedRoles.includes(r));
    if (invalidRoles.length > 0) {
      return NextResponse.json({ error: `Invalid roles: ${invalidRoles.join(', ')}` }, { status: 400 });
    }

    // 最低でもuserロールは必要
    if (!roles.includes('user')) {
      roles.push('user');
    }

    // ターゲットユーザーの現在のロール取得
    const { data: targetUser } = await supabase
      .from('user_profiles')
      .select('roles, nickname')
      .eq('id', params.id)
      .single();

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // super_adminは他のsuper_adminからsuper_adminを剥奪できない
    if (targetUser.roles?.includes('super_admin') && !roles.includes('super_admin')) {
      return NextResponse.json({ error: 'Cannot remove super_admin role from another super_admin' }, { status: 400 });
    }

    // ロール更新
    const { error } = await supabase
      .from('user_profiles')
      .update({ roles })
      .eq('id', params.id);

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: 'change_admin_roles',
        target_id: params.id,
        details: { 
          previousRoles: targetUser.roles, 
          newRoles: roles,
          targetNickname: targetUser.nickname,
        },
        severity: 'high',
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
