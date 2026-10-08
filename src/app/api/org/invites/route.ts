import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import {
  createOrgInviteWithEmail,
  invalidOrgInviteBodyResponse,
  orgInviteFailureResponse,
} from '@/lib/membership/org-invite';
import { CreateOrgInviteRequestBodySchema } from '@/schemas/membership/organization-invite';

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'INVALID_BODY', message: 'リクエストボディが不正です' } }, { status: 400 });
  }

  // #1163 メールアドレスは前後の空白を除いて小文字にし、形式と長さを確かめる (不正なアドレスでは招待を作らない)。
  // role に owner は指定できない。未知のキーは取り除く。
  const parsed = CreateOrgInviteRequestBodySchema.safeParse(body);
  if (!parsed.success) {
    return invalidOrgInviteBodyResponse(parsed.error);
  }
  const { email, role, custom_message } = parsed.data;

  // 招待を作り、招待メールを送る (POST /api/org/members と共通。送信回数の制限もこの中で判定する)
  const result = await createOrgInviteWithEmail({
    supabase,
    inviter: { id: user.id, email: user.email, nickname: profile.nickname },
    organizationId: profile.organization_id,
    email,
    role,
    customMessage: custom_message,
  });
  if (!result.ok) {
    return orgInviteFailureResponse(result);
  }

  return NextResponse.json({ ok: true, invite: result.invite });
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

