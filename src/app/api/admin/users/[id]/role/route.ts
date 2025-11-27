import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createClient();

  try {
    // 1. 実行者の権限チェック
    const { data: { user: actor }, error: authError } = await supabase.auth.getUser();
    if (authError || !actor) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: actorProfile } = await supabase
      .from('user_profiles')
      .select('roles')
      .eq('id', actor.id)
      .single();

    if (!actorProfile?.roles?.some((r: string) => ['admin', 'super_admin'].includes(r))) {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // 2. リクエストボディ取得
    const body = await request.json();
    const { roles } = body; // 新しいロール配列

    // rolesが配列でない場合、単一ロールを配列に変換（後方互換性）
    let newRoles: string[];
    if (Array.isArray(roles)) {
      newRoles = roles;
    } else if (body.role) {
      // 旧形式（単一role）にも対応
      newRoles = body.role === 'admin' ? ['user', 'admin'] : ['user'];
    } else {
      return NextResponse.json({ error: 'Roles must be provided' }, { status: 400 });
    }

    // 許可されたロールのみ（super_adminはこのAPIでは付与不可）
    const allowedRoles = ['user', 'support', 'admin', 'org_admin'];
    const invalidRoles = newRoles.filter((r: string) => !allowedRoles.includes(r));
    if (invalidRoles.length > 0) {
      return NextResponse.json({ error: `Invalid roles: ${invalidRoles.join(', ')}` }, { status: 400 });
    }

    // 最低でもuserロールは必要
    if (!newRoles.includes('user')) {
      newRoles.push('user');
    }

    // 3. ロール更新
    // 自分のadmin権限を剥奪することはできない
    if (params.id === actor.id && !newRoles.includes('admin')) {
      return NextResponse.json({ error: 'Cannot remove own admin privileges' }, { status: 400 });
    }

    // ターゲットの現在のロールを取得
    const { data: targetProfile } = await supabase
      .from('user_profiles')
      .select('roles')
      .eq('id', params.id)
      .single();

    // super_adminのロールは変更不可
    if (targetProfile?.roles?.includes('super_admin')) {
      return NextResponse.json({ error: 'Cannot modify super_admin roles' }, { status: 403 });
    }

    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ roles: newRoles })
      .eq('id', params.id);

    if (updateError) throw updateError;

    // 4. 監査ログ記録
    await supabase.from('admin_audit_logs').insert({
      admin_id: actor.id,
      action_type: 'update_roles',
      target_id: params.id,
      details: { 
        previous_roles: targetProfile?.roles,
        new_roles: newRoles 
      }
    });

    return NextResponse.json({ success: true, roles: newRoles });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
