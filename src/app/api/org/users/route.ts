import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Note: admin機能用には supabase-js のクライアントを直接使う（service_roleキーが必要）
// 環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されている前提
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

export async function POST(request: Request) {
  const supabase = createServerClient(cookies());

  try {
    // 1. リクエスト実行者の権限チェック
    const { data: { user: actor } } = await supabase.auth.getUser();
    if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: adminProfile } = await supabase
      .from('user_profiles')
      .select('organization_id, role')
      .eq('id', actor.id)
      .single();

    if (adminProfile?.role !== 'org_admin' || !adminProfile?.organization_id) {
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
      email_confirm: true, // 確認済みとして作成
      user_metadata: {
        nickname: nickname // メタデータに入れておく
      }
    });

    if (createError) throw createError;
    if (!newUser.user) throw new Error('Failed to create user');

    // 4. プロフィール作成 & 組織紐付け
    // トリガーで作成されるuser_profilesを更新するか、直接insertするか。
    // 通常はトリガーが走るが、organization_idを入れる必要がある。
    // トリガーが走った直後を狙うのは競合するので、Admin権限でupdateをかけるのが確実。
    
    // 少し待機（トリガー完了待ち）するか、upsertを使う
    // ここでは単純に user_profiles に update をかける
    
    const { error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .upsert({
        id: newUser.user.id,
        nickname: nickname,
        organization_id: adminProfile.organization_id,
        role: 'user', // 一般ユーザー
        updated_at: new Date().toISOString()
      });

    if (profileError) {
      // 失敗したらAuthユーザーも消すべきだが、今回はエラーを返すのみ
      console.error("Profile update error", profileError);
      return NextResponse.json({ error: 'User created but profile update failed' }, { status: 500 });
    }

    return NextResponse.json({ success: true, user: newUser.user });

  } catch (error: any) {
    console.error("Create user error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const supabase = createServerClient(cookies());

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: adminProfile } = await supabase
      .from('user_profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    if (adminProfile?.role !== 'org_admin' || !adminProfile?.organization_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: members, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('organization_id', adminProfile.organization_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ members });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

