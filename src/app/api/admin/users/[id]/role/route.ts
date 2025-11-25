import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient(cookies());

  try {
    // 1. 実行者の権限チェック
    const { data: { user: actor }, error: authError } = await supabase.auth.getUser();
    if (authError || !actor) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: actorProfile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', actor.id)
      .single();

    if (actorProfile?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // 2. リクエストボディ取得
    const body = await request.json();
    const newRole = body.role; // 'admin' or 'user'

    if (!['admin', 'user'].includes(newRole)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    // 3. ロール更新
    // 自分の権限を剥奪することはできないようにする（安全策）
    if (params.id === actor.id && newRole !== 'admin') {
      return NextResponse.json({ error: 'Cannot remove own admin privileges' }, { status: 400 });
    }

    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ role: newRole })
      .eq('id', params.id);

    if (updateError) throw updateError;

    // 4. 監査ログ記録
    await supabase.from('admin_audit_logs').insert({
      admin_id: actor.id,
      action_type: 'update_role',
      target_id: params.id,
      details: { new_role: newRole }
    });

    return NextResponse.json({ success: true, role: newRole });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

