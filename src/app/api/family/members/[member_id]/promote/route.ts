// src/app/api/family/members/[member_id]/promote/route.ts
// (設計書 02-flow-spec.md §9)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderFamilyPromoteEmail } from '@/lib/emails/membership/family-promote';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ member_id: string }> },
) {
  const { member_id } = await params;
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = body as { email?: string };

  if (!parsed.email) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'email は必須です' } },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc('promote_child_to_user', {
    p_member_id: member_id,
    p_email: parsed.email,
  });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: '子供メンバーのプロモートに失敗しました' } },
      { status },
    );
  }

  // 成功時: 招待メール送信
  try {
    const envelope = renderFamilyPromoteEmail({
      email_address: parsed.email,
      child_name: (data as { display_name?: string })?.display_name ?? '子供メンバー',
    });
    await sendEmail(envelope);
  } catch (emailErr) {
    console.error('[api/family/members/promote] email send failed:', emailErr);
    // メール失敗はログのみ、処理は続行
  }

  return NextResponse.json({ data: { member: data } }, { status: 200 });
}
