// src/app/api/family/members/[member_id]/promote/route.ts
// #1232: 旧・即時 promote (promote_child_to_user) を本人同意フローへ置換。
// POST = 昇格リクエスト作成 (request_child_promotion) + 同意依頼メール送信
// DELETE = pending リクエスト取消 (revoke_child_promotion)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderFamilyPromoteEmail } from '@/lib/emails/membership/family-promote';
import { checkInviteEmailLimits, inviteThrottleResponse } from '@/lib/membership/invite-throttle';
import {
  FamilyMemberIdParamsSchema,
  RequestChildPromotionBodySchema,
} from '@/schemas/membership/family-promote-action';

function invalidMemberIdResponse() {
  return NextResponse.json(
    { error: { code: 'VALIDATION_ERROR', message: 'メンバー ID が不正です' } },
    { status: 400 },
  );
}

interface PromotionRequestResult {
  id: string;
  family_id: string;
  member_id: string;
  member_display_name: string | null;
  family_name: string | null;
  email: string;
  token: string;
  status: string;
  expires_at: string;
  requester_name: string | null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ member_id: string }> },
) {
  const { member_id } = await params;
  const supabase = await createClient();
  const logger = createLogger('POST /api/family/members/[member_id]/promote', generateRequestId());

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }
  if (!FamilyMemberIdParamsSchema.safeParse({ member_id }).success) {
    return invalidMemberIdResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const parsed = RequestChildPromotionBodySchema.safeParse(body);
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

  // #1163 同意依頼メールの送信回数を制限する。最初の副作用 (RPC) の前に判定する。
  // この時点では URL の member_id が自分の家族の枠かどうかを確認できていない (RPC が確かめる) ので、
  // member_id も、そこから引く family_id も鍵にしない。鍵は認証で確定した user.id だけ
  // (宛先の上限も user.id の範囲で数える)。
  // 判定できない (Redis 障害など) ときは例外がそのまま伝播し、RPC もメールも実行されない (fail-closed)。
  const throttle = await checkInviteEmailLimits({
    flow: 'child-promotion',
    userId: user.id,
    scopeId: user.id,
    recipientEmail: parsed.data.email,
  });
  if (throttle) {
    return inviteThrottleResponse(throttle);
  }

  const { data, error } = await supabase.rpc('request_child_promotion', {
    p_member_id: member_id,
    p_email: parsed.data.email,
  });
  if (error) {
    // #1232 v3 (G10): SQLSTATE (PostgrestError.code) を渡し 40P01 → CONFLICT_RETRY(409) を有効化
    const { code, status } = mapPgErrorToHttp(error.message ?? '', error.code);
    if (status >= 500) {
      logger.withUser(user.id).error('request_child_promotion failed', error, { member_id, pg_code: error.code });
    }
    return NextResponse.json(
      { error: { code, message: '参加リクエストの作成に失敗しました' } },
      { status },
    );
  }
  const req = data as unknown as PromotionRequestResult;

  // 同意リクエストメール送信。
  // ★token は HTTP レスポンスに絶対含めない (メールで対象者本人にのみ届く同意証跡)。
  // ミューテーション感度テスト対象 (設計 §8-A)。
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://homegohan.app';
    const envelope = renderFamilyPromoteEmail({
      email_address: req.email,
      family_name: req.family_name ?? '家族グループ',
      member_display_name: req.member_display_name ?? '子供メンバー',
      requester_name: req.requester_name ?? user.email ?? '家族の代表者',
      accept_url: `${baseUrl}/family/promotions/${req.token}`,
      expires_at: req.expires_at,
    });
    await sendEmail(envelope);
  } catch (emailErr) {
    // メール失敗はリクエスト作成自体を失敗にしない (再送 = 再リクエストで可能)
    logger.withUser(user.id).error('promotion request email send failed', emailErr, {
      member_id,
      request_id: req.id,
    });
  }

  return NextResponse.json(
    {
      data: {
        request: {
          id: req.id,
          member_id: req.member_id,
          email: req.email,
          status: 'pending',
          expires_at: req.expires_at,
        },
      },
    },
    { status: 200 },
  );
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ member_id: string }> },
) {
  const { member_id } = await params;
  const supabase = await createClient();
  const logger = createLogger('DELETE /api/family/members/[member_id]/promote', generateRequestId());

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }
  if (!FamilyMemberIdParamsSchema.safeParse({ member_id }).success) {
    return invalidMemberIdResponse();
  }

  const { data, error } = await supabase.rpc('revoke_child_promotion', { p_member_id: member_id });
  if (error) {
    // #1232 v3 (G10): SQLSTATE (PostgrestError.code) を渡し 40P01 → CONFLICT_RETRY(409) を有効化
    const { code, status } = mapPgErrorToHttp(error.message ?? '', error.code);
    if (status >= 500) {
      logger.withUser(user.id).error('revoke_child_promotion failed', error, { member_id, pg_code: error.code });
    }
    return NextResponse.json(
      { error: { code, message: '参加リクエストの取消に失敗しました' } },
      { status },
    );
  }

  // ★#1232 v3 (G12): revoke_child_promotion は token 列を含む family_promotion_requests
  // 全行を返す (RPC 戻り値は列単位 GRANT (G8) をバイパスする)。RPC 戻り値を絶対に
  // そのまま返さず、最小 JSON に再構成する。ミューテーション感度テスト対象 (設計 §8-A)。
  const r = data as { id: string };
  return NextResponse.json({ data: { request_id: r.id, status: 'revoked' } }, { status: 200 });
}
