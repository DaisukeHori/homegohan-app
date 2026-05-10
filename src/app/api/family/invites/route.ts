// src/app/api/family/invites/route.ts
// (設計書 02-flow-spec.md §7, 06-implementation-phases.md P3)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { CreateFamilyInviteBodySchema } from '@/schemas/membership/family-invite';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderFamilyInviteExistingEmail } from '@/lib/emails/membership/family-invite-existing';
import { renderFamilyInviteNewEmail } from '@/lib/emails/membership/family-invite-new';
import { buildFamilyInviteUrl } from '@/lib/membership/urls';

// 招待一覧取得
export async function GET(_request: Request) {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // 自身の family_id を取得
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('family_id')
    .eq('id', user.id)
    .single();

  if (!profile?.family_id) {
    return NextResponse.json({ data: { invites: [] } });
  }

  const { data: invites, error } = await supabase
    .from('family_invites')
    .select('*')
    .eq('family_id', profile.family_id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[api/family/invites] GET error:', error);
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: '招待一覧の取得に失敗しました' } },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: { invites: invites ?? [] } });
}

// 招待発行
export async function POST(request: Request) {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // リクエスト検証
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = CreateFamilyInviteBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力値が不正です',
          details: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }

  const { family_id, email, custom_message } = parsed.data;

  // 招待者のプロフィール取得 (名前, family_id 確認)
  const { data: inviterProfile } = await supabase
    .from('user_profiles')
    .select('family_id, nickname, display_name')
    .eq('id', user.id)
    .single();

  if (!inviterProfile?.family_id || inviterProfile.family_id !== family_id) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_FAMILY_ADULT, message: 'この家族グループのメンバーではありません' } },
      { status: 403 },
    );
  }

  // 家族グループ情報取得 (グループ名)
  const { data: familyGroup } = await supabase
    .from('family_groups')
    .select('name')
    .eq('id', family_id)
    .single();

  // RPC: create_family_invite
  const { data: inviteData, error: rpcError } = await supabase.rpc('create_family_invite', {
    p_family_id: family_id,
    p_email: email,
    p_custom_message: custom_message ?? null,
  });

  if (rpcError) {
    if (rpcError.message?.includes('ALREADY_IN_FAMILY')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.ALREADY_IN_FAMILY, message: 'このメールアドレスは既に家族グループのメンバーです' } },
        { status: 409 },
      );
    }
    if (rpcError.message?.includes('MEMBER_LIMIT_EXCEEDED')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.MEMBER_LIMIT_EXCEEDED, message: 'メンバー数の上限に達しています' } },
        { status: 409 },
      );
    }
    console.error('[api/family/invites] RPC error:', rpcError);
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: '招待の作成に失敗しました' } },
      { status: 500 },
    );
  }

  const invite = inviteData as { token: string; expires_at: string; id: string };
  const invite_url = buildFamilyInviteUrl(invite.token);
  const inviterName = inviterProfile.nickname ?? inviterProfile.display_name ?? user.email ?? '招待者';
  const scopeName = familyGroup?.name ?? '家族グループ';
  const expiresDate = invite.expires_at.slice(0, 10); // YYYY-MM-DD

  // 既存ユーザー判定: get_invite_details で is_existing_user を確認
  let isExistingUser = false;
  let inviteeDisplayName: string | null = null;
  try {
    const { data: inviteDetails } = await supabase.rpc('get_invite_details', {
      p_token: invite.token,
    });
    if (inviteDetails) {
      const details = inviteDetails as { is_existing_user?: boolean; invitee_display_name?: string | null };
      isExistingUser = details.is_existing_user ?? false;
      inviteeDisplayName = details.invitee_display_name ?? null;
    }
  } catch (detailsError) {
    // 詳細取得失敗は警告のみ。既存ユーザー判定できない場合は新規向けテンプレートにフォールバック
    console.warn('[api/family/invites] get_invite_details failed:', detailsError);
  }

  // Resend でメール送信 (失敗は warn のみ)
  try {
    const emailVars = {
      display_name: isExistingUser ? inviteeDisplayName : null,
      email_address: email,
      inviter_name: inviterName,
      scope_name: scopeName,
      invite_url,
      expires_at: expiresDate,
      custom_message: custom_message ?? null,
    };
    const envelope = isExistingUser
      ? renderFamilyInviteExistingEmail(emailVars)
      : renderFamilyInviteNewEmail(emailVars);
    await sendEmail(envelope);
  } catch (emailError) {
    // メール送信失敗は警告のみ (invite row は残す)
    console.warn('[api/family/invites] email send failed (invite row kept):', emailError);
  }

  return NextResponse.json(
    { data: { invite: inviteData, invite_url } },
    { status: 201 },
  );
}
