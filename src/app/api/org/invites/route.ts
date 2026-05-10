import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderOrgInviteExistingEmail } from '@/lib/emails/membership/org-invite-existing';
import { renderOrgInviteNewEmail } from '@/lib/emails/membership/org-invite-new';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';

// 招待一覧取得
export async function GET(request: Request) {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, org_role')
    .eq('id', user.id)
    .single();

  const allowedGetRoles = ['owner', 'admin'];
  if (!profile?.org_role || !allowedGetRoles.includes(profile.org_role as string) || !profile?.organization_id) {
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

// 招待作成 (RPC create_org_invite + Resend 送信)
export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, org_role, nickname')
    .eq('id', user.id)
    .single();

  const allowedOrgRoles = ['owner', 'admin'];
  if (!profile?.org_role || !allowedOrgRoles.includes(profile.org_role as string) || !profile?.organization_id) {
    return NextResponse.json(
      { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner/admin のみ招待可能です' } },
      { status: 403 },
    );
  }

  let body: { email?: string; role?: string; custom_message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'INVALID_BODY', message: 'リクエストボディが不正です' } }, { status: 400 });
  }

  const { email, role = 'member', custom_message } = body;

  if (!email) {
    return NextResponse.json({ error: { code: 'INVALID_BODY', message: 'email は必須です' } }, { status: 400 });
  }
  if (!['admin', 'member'].includes(role)) {
    return NextResponse.json({ error: { code: 'INVALID_BODY', message: 'role は admin または member のみ' } }, { status: 400 });
  }

  // create_org_invite RPC 呼び出し (既存 pending は RPC 内で revoke)
  const { data: invite, error: rpcError } = await supabase.rpc('create_org_invite', {
    p_organization_id: profile.organization_id,
    p_email: email.toLowerCase(),
    p_role: role as 'admin' | 'member',
    p_custom_message: custom_message,
  });

  if (rpcError) {
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    return NextResponse.json({ error: { code, message: rpcError.message } }, { status });
  }

  if (!invite) {
    return NextResponse.json({ error: { code: 'RPC_FAILED', message: '招待の作成に失敗しました' } }, { status: 500 });
  }

  const inviteRow = invite as {
    id: string;
    token: string;
    email: string;
    invited_role: string;
    status: string;
    expires_at: string;
    custom_message: string | null;
    organization_id: string | null;
  };

  const baseUrl = process.env.NEXT_PUBLIC_INVITE_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const inviteUrl = `${baseUrl}/invite/${inviteRow.token}`;

  // 組織名を取得
  const { data: orgData } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', profile.organization_id)
    .single();

  // 既存ユーザー判定: auth.admin.listUsers は service_role 専用のため
  // get_invite_details の is_existing_user フィールドを使用
  const { data: inviteDetails } = await supabase.rpc('get_invite_details', {
    p_token: inviteRow.token,
  });

  const isExistingUser = (inviteDetails as Record<string, unknown> | null)?.is_existing_user === true;

  const expiresDate = inviteRow.expires_at.substring(0, 10); // 'YYYY-MM-DD'
  const inviterName = profile.nickname ?? user.email?.split('@')[0] ?? '招待者';
  const scopeName = orgData?.name ?? '組織';

  const emailVars: InviteEmailVars = {
    display_name: null,
    email_address: email.toLowerCase(),
    inviter_name: inviterName,
    scope_name: scopeName,
    invite_url: inviteUrl,
    expires_at: expiresDate,
    custom_message: custom_message ?? null,
  };

  // Resend 送信 (失敗時は warn のみ — 招待 row は残す)
  try {
    const envelope = isExistingUser
      ? renderOrgInviteExistingEmail(emailVars)
      : renderOrgInviteNewEmail(emailVars);
    await sendEmail(envelope);
  } catch (emailErr) {
    console.warn('[api/org/invites] メール送信失敗 (招待は有効):', emailErr);
  }

  return NextResponse.json({
    ok: true,
    invite: {
      id: inviteRow.id,
      email: inviteRow.email,
      role: inviteRow.invited_role,
      status: inviteRow.status,
      expires_at: inviteRow.expires_at,
      invite_url: inviteUrl,
    },
  });
}

// 招待削除
export async function DELETE(request: Request) {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, org_role')
    .eq('id', user.id)
    .single();

  const allowedDeleteRoles = ['owner', 'admin'];
  if (!profile?.org_role || !allowedDeleteRoles.includes(profile.org_role as string) || !profile?.organization_id) {
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

