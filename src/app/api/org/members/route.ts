import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// admin 機能用には supabase-js のクライアントを直接使う（service_role キーが必要）
function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// メンバー一覧取得
export async function GET(_request: Request) {
  const supabase = await createServerClient();

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: adminProfile } = await supabase
      .from('user_profiles')
      .select('organization_id, roles')
      .eq('id', user.id)
      .single();

    if (!adminProfile?.roles?.includes('org_admin') || !adminProfile?.organization_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: members, error } = await supabase
      .from('user_profiles')
      .select('id, nickname, roles, created_at, updated_at, organization_id')
      .eq('organization_id', adminProfile.organization_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ members });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// メンバー作成 (org_admin のみ)
export async function POST(request: Request) {
  const supabase = await createServerClient();

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // 1. リクエスト実行者の権限チェック
    const { data: { user: actor } } = await supabase.auth.getUser();
    if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: adminProfile } = await supabase
      .from('user_profiles')
      .select('organization_id, roles')
      .eq('id', actor.id)
      .single();

    if (!adminProfile?.roles?.includes('org_admin') || !adminProfile?.organization_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 2. 作成パラメータ取得
    const body = await request.json();
    const { email, password, nickname } = body;

    if (!email || !password || !nickname) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 3. ユーザー作成 (Admin API)
    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nickname },
    });

    if (createError) throw createError;
    if (!newUser.user) throw new Error('Failed to create user');

    // 4. プロフィール作成 & 組織紐付け
    const { error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .upsert({
        id: newUser.user.id,
        nickname,
        organization_id: adminProfile.organization_id,
        roles: ['user'],
        updated_at: new Date().toISOString(),
      });

    if (profileError) {
      console.error('Profile update error', profileError);
      return NextResponse.json({ error: 'User created but profile update failed' }, { status: 500 });
    }

    return NextResponse.json({ success: true, user: newUser.user });

  } catch (error: any) {
    console.error('Create member error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
