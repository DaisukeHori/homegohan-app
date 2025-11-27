import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

// 招待一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'org_admin' || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { data: invites, error } = await supabase
      .from('organization_invites')
      .select(`
        id,
        email,
        role,
        department_id,
        token,
        expires_at,
        accepted_at,
        created_at,
        departments(name)
      `)
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({
      invites: (invites || []).map((i: any) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        departmentId: i.department_id,
        departmentName: i.departments?.name || null,
        token: i.token,
        expiresAt: i.expires_at,
        acceptedAt: i.accepted_at,
        createdAt: i.created_at,
        isExpired: new Date(i.expires_at) < new Date(),
        isAccepted: !!i.accepted_at,
      })),
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 招待作成
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'org_admin' || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { email, role = 'member', departmentId } = body;

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    // 既存の招待確認
    const { data: existing } = await supabase
      .from('organization_invites')
      .select('id')
      .eq('organization_id', profile.organization_id)
      .eq('email', email)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Active invite already exists for this email' }, { status: 400 });
    }

    // 既存ユーザー確認（auth.usersはRLSで取れないので、emailでの既存チェックは省略）

    // 招待トークン生成
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7日間有効

    const { data, error } = await supabase
      .from('organization_invites')
      .insert({
        organization_id: profile.organization_id,
        email,
        role,
        department_id: departmentId || null,
        token,
        expires_at: expiresAt.toISOString(),
        created_by: user.id,
      })
      .select()
      .single();

    if (error) throw error;

    // 招待リンク生成
    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/invite/${token}`;

    return NextResponse.json({
      success: true,
      invite: {
        id: data.id,
        email: data.email,
        inviteUrl,
        expiresAt: data.expires_at,
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 招待削除
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'org_admin' || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const inviteId = searchParams.get('id');

    if (!inviteId) {
      return NextResponse.json({ error: 'Invite ID is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('organization_invites')
      .delete()
      .eq('id', inviteId)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

