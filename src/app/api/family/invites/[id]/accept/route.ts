// src/app/api/family/invites/[id]/accept/route.ts
// (設計書 02-flow-spec.md §7)
// Note: [id] slug is used for route deduplication; the value is the invite token.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AcceptFamilyInviteBodySchema } from '@/schemas/membership/family-invite-action';
import { ErrorStatusMap, MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();

  // 認証必須
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { id: token } = await params;

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

    if (msg.includes(MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED)) {
      // #1173: 18 歳未満の本人は家族を作れない・招待から入れない (DB の関数が先頭で断る)。DB の生の文は出さない
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED,
            message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED],
          },
        },
        { status: 403 },
      );
    }
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
    // billing/03 §9.5: 家族プランの契約が無い代表者のグループにはメンバーを足せない (DB の門が FAMILY_PLAN_REQUIRED を RAISE する)。DB の生の文は出さない
    if (msg.includes(MembershipErrorCode.FAMILY_PLAN_REQUIRED)) {
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.FAMILY_PLAN_REQUIRED,
            message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.FAMILY_PLAN_REQUIRED],
          },
        },
        { status: ErrorStatusMap[MembershipErrorCode.FAMILY_PLAN_REQUIRED] },
      );
    }
    // #1213: 家族の人数が上限に達している。RPC は上限の確認を家族の行のロック下で行うため、
    // 別の人の承諾と同時になった場合も、後から処理された側にここで返る (以前は対応が無く 500 RPC_FAILED になっていた)
    if (msg.includes('MEMBER_LIMIT_EXCEEDED')) {
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.MEMBER_LIMIT_EXCEEDED,
            message: 'この家族グループは人数の上限に達しているため、参加できません。招待した方にご確認ください',
          },
        },
        { status: 409 },
      );
    }
    // #1213: 招待先の家族が解散済み (または削除済み)
    if (msg.includes('FAMILY_NOT_FOUND')) {
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.FAMILY_NOT_FOUND,
            message: '招待先の家族グループが見つからないか、解散されています',
          },
        },
        { status: 404 },
      );
    }

    console.error('[api/family/invites/accept] RPC error:', error);
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: '招待の承諾に失敗しました' } },
      { status: 500 },
    );
  }

  // accept_family_invite RPC は family_members 行を返す (主キーは member_id ではなく id)
  const result = data as { id: string; family_id: string; role: string };
  return NextResponse.json({
    data: {
      family_id: result.family_id,
      member_id: result.id,
      role: result.role,
    },
  });
}
