// src/app/api/org/invites/route.ts
// (設計書 02-flow-spec.md §1.2 / 06-implementation-phases.md P1)
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CreateOrgInviteBodySchema } from '@/schemas/membership/organization-invite';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';
import { buildOrgInviteUrl } from '@/lib/membership/urls';
import { sendEmail } from '@/lib/emails/send';
import { renderOrgInviteExistingEmail } from '@/lib/emails/membership/org-invite-existing';
import { renderOrgInviteNewEmail } from '@/lib/emails/membership/org-invite-new';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Supabase admin env is missing');
  }
  return createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// 招待一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
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
      invites: (invites || []).map((i: Record<string, unknown>) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        departmentId: i.department_id,
        departmentName: (i.departments as Record<string, unknown> | null)?.name ?? null,
        token: i.token,
        expiresAt: i.expires_at,
        acceptedAt: i.accepted_at,
        createdAt: i.created_at,
        isExpired: new Date(i.expires_at as string) < new Date(),
        isAccepted: !!(i.accepted_at),
      })),
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// 招待作成 (設計書 02-flow-spec.md §1.2)
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // Zod バリデーション
  let body: ReturnType<typeof CreateOrgInviteBodySchema.parse>;
  try {
    const raw = await request.json();
    body = CreateOrgInviteBodySchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: err.issues[0]?.message ?? 'Invalid request' } },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid JSON' } }, { status: 400 });
  }

  // 招待者情報を取得
  const { data: inviterProfile } = await supabase
    .from('user_profiles')
    .select('nickname, organization_id')
    .eq('id', user.id)
    .single();

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', body.organization_id)
    .single();

  if (!org) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '組織が見つかりません' } },
      { status: 404 },
    );
  }

  // RPC: create_org_invite
  // NOTE: DB 型生成が未完のため unknown キャストを使用 (migration 後に型再生成が必要)
  const { data: invite, error: rpcError } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>)(
    'create_org_invite',
    {
      p_organization_id: body.organization_id,
      p_email: body.email,
      p_role: body.role,
      p_custom_message: body.custom_message ?? null,
    },
  );

  if (rpcError) {
    const msg = rpcError.message ?? '';
    let code: string = MembershipErrorCode.RPC_FAILED;
    let status = 500;
    if (msg.includes('NOT_ORG_ADMIN')) {
      code = MembershipErrorCode.NOT_ORG_ADMIN; status = 403;
    } else if (msg.includes('SEAT_LIMIT_EXCEEDED')) {
      code = MembershipErrorCode.SEAT_LIMIT_EXCEEDED; status = 400;
    }
    return NextResponse.json({ error: { code, message: msg } }, { status });
  }

  const inviteRecord = invite as {
    id: string;
    token: string;
    email: string;
    invited_role: string;
    custom_message: string | null;
    status: string;
    expires_at: string;
    created_at: string;
    invited_by: string;
  };

  const inviteUrl = buildOrgInviteUrl(inviteRecord.token);

  // 既存ユーザー判定 (auth.admin.listUsers)
  let isExistingUser = false;
  try {
    const adminClient = getSupabaseAdmin();
    const { data: userList } = await adminClient.auth.admin.listUsers();
    isExistingUser = (userList?.users ?? []).some(
      (u) => u.email?.toLowerCase() === body.email.toLowerCase(),
    );
  } catch (adminErr) {
    console.error('[org/invites] admin.listUsers failed (graceful)', adminErr);
    // admin クライアント失敗時は新規ユーザ向けテンプレートにフォールバック
  }

  // メール送信
  const expiresAtDate = new Date(inviteRecord.expires_at);
  const expiresAtStr = expiresAtDate.toISOString().slice(0, 10); // YYYY-MM-DD

  const { data: inviteeProfile } = await supabase
    .from('user_profiles')
    .select('nickname')
    .eq('id', user.id) // 招待者プロファイル (invitee は未登録の可能性あり)
    .single();
  void inviteeProfile; // 受領者プロファイルは取れないため未使用

  const emailVars: InviteEmailVars = {
    display_name: null, // 既存ユーザでも display_name は admin クライアントなしでは取得不可
    email_address: body.email,
    inviter_name: inviterProfile?.nickname ?? user.email ?? '管理者',
    scope_name: org.name,
    invite_url: inviteUrl,
    expires_at: expiresAtStr,
    custom_message: body.custom_message ?? null,
  };

  const envelope = isExistingUser
    ? renderOrgInviteExistingEmail(emailVars)
    : renderOrgInviteNewEmail(emailVars);

  try {
    await sendEmail(envelope);
  } catch (emailErr) {
    // EMAIL_SEND_FAILED: 招待 row は残す (再送可能)
    console.error('[org/invites] sendEmail failed', emailErr);
    return NextResponse.json(
      {
        error: {
          code: MembershipErrorCode.EMAIL_SEND_FAILED,
          message: 'メール送信に失敗しました。招待リンクはコピーして手動で共有できます。',
        },
        data: {
          invite: inviteRecord,
          invite_url: inviteUrl,
        },
      },
      { status: 207 }, // Multi-Status: 招待は成功、メール送信のみ失敗
    );
  }

  return NextResponse.json({
    data: {
      invite: inviteRecord,
      invite_url: inviteUrl,
    },
  });
}

// 招待削除 (既存互換のため維持)
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
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

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
