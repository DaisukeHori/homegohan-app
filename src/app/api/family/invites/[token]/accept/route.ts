// src/app/api/family/invites/[token]/accept/route.ts
// (設計書 02-flow-spec.md §7)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AcceptFamilyInviteBodySchema } from '@/schemas/membership/family-invite-action';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const supabase = await createClient();

  // 認証必須
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { token } = await params;

  // リクエスト検証
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = AcceptFamilyInviteBodySchema.safeParse({
    token,
    ...(typeof body === 'object' && body !== null ? body : {}),
  });

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

  const { share_meals, share_health, share_menu } = parsed.data;

  // RPC: accept_family_invite
  const { data, error } = await supabase.rpc('accept_family_invite', {
    p_token: token,
    p_share_meals: share_meals,
    p_share_health: share_health,
    p_share_menu: share_menu,
  });

  if (error) {
    const msg = error.message ?? '';

    if (msg.includes('INVITE_NOT_FOUND')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.INVITE_NOT_FOUND, message: '招待が見つかりません' } },
        { status: 404 },
      );
    }
    if (msg.includes('INVITE_EXPIRED')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.INVITE_EXPIRED, message: '招待の期限が切れています' } },
        { status: 410 },
      );
    }
    if (msg.includes('INVITE_ALREADY_USED')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.INVITE_ALREADY_USED, message: '招待は既に使用済みです' } },
        { status: 409 },
      );
    }
    if (msg.includes('INVITE_REVOKED')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.INVITE_REVOKED, message: '招待は取り消されました' } },
        { status: 410 },
      );
    }
    if (msg.includes('ALREADY_IN_FAMILY')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.ALREADY_IN_FAMILY, message: '既に家族グループに所属しています' } },
        { status: 409 },
      );
    }
    if (msg.includes('INVITE_EMAIL_MISMATCH')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.INVITE_EMAIL_MISMATCH, message: '招待のメールアドレスと一致しません' } },
        { status: 403 },
      );
    }

    console.error('[api/family/invites/accept] RPC error:', error);
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: '招待の承諾に失敗しました' } },
      { status: 500 },
    );
  }

  const result = data as { id: string; family_id: string; role: string };
  return NextResponse.json({
    data: {
      family_id: result.family_id,
      member_id: result.id,  // RPC は family_members の id を返す (主キー名は id)
      role: result.role,
    },
  });
}
