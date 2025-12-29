import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (!body?.confirm) {
    return NextResponse.json({ error: 'confirm is required' }, { status: 400 });
  }

  const userId = user.id;

  try {
    const supabaseAdmin = getSupabaseAdmin();
    // CASCADEされない/NO ACTION な参照を先に解消
    await supabaseAdmin.from('ai_content_logs').delete().eq('user_id', userId);

    // 管理系の参照（通常ユーザーは対象外だが、消せない状態を防ぐためnull化）
    await supabaseAdmin.from('admin_audit_logs').update({ admin_id: null }).eq('admin_id', userId);
    await supabaseAdmin.from('admin_user_notes').update({ admin_id: null }).eq('admin_id', userId);
    await supabaseAdmin.from('announcements').update({ created_by: null }).eq('created_by', userId);
    await supabaseAdmin.from('moderation_flags').update({ resolved_by: null }).eq('resolved_by', userId);
    await supabaseAdmin.from('recipe_flags').update({ reporter_id: null }).eq('reporter_id', userId);
    await supabaseAdmin.from('recipe_flags').update({ reviewed_by: null }).eq('reviewed_by', userId);
    await supabaseAdmin.from('organization_challenges').update({ created_by: null }).eq('created_by', userId);
    await supabaseAdmin.from('organization_invites').update({ created_by: null }).eq('created_by', userId);
    await supabaseAdmin.from('system_settings').update({ updated_by: null }).eq('updated_by', userId);
    await supabaseAdmin.from('departments').update({ manager_id: null }).eq('manager_id', userId);

    // Authユーザー削除（public側はFKでCASCADE/SET NULLされる）
    const { error: delError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (delError) throw delError;

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[account/delete] error', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}



