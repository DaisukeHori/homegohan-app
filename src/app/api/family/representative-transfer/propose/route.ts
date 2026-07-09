// src/app/api/family/representative-transfer/propose/route.ts
// (設計書 02-flow-spec.md §10)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderFamilyTransferProposedEmail } from '@/lib/emails/membership/family-transfer-proposed';

export async function POST(request: Request) {
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

  const parsed = body as { family_id?: string; to_user_id?: string; reason?: string };

  if (!parsed.family_id || !parsed.to_user_id) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'family_id と to_user_id は必須です' } },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc('propose_family_representative_transfer', {
    p_family_id: parsed.family_id,
    p_to_user_id: parsed.to_user_id,
    // p_reason は DB 関数に存在しないため送らない
  });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: '代表者譲渡の提案に失敗しました' } },
      { status },
    );
  }

  // 対象者にメール送信
  try {
    const { data: toUserProfile } = await supabase
      .from('user_profiles')
      .select('email')
      .eq('id', parsed.to_user_id)
      .single();

    const { data: fromUserProfile } = await supabase
      .from('user_profiles')
      .select('nickname, email')
      .eq('id', user.id)
      .single();

    const { data: familyGroup } = await supabase
      .from('family_groups')
      .select('name')
      .eq('id', parsed.family_id)
      .single();

    if (toUserProfile?.email) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://homegohan.app';
      const proposalId = typeof data === 'string' ? data : (data as { proposal_id?: string })?.proposal_id ?? '';
      const acceptUrl = `${baseUrl}/family/transfer-accept/${proposalId}`;

      const envelope = renderFamilyTransferProposedEmail({
        to_email: toUserProfile.email,
        from_name: fromUserProfile?.nickname ?? fromUserProfile?.email ?? '代表者',
        family_name: familyGroup?.name ?? '家族グループ',
        accept_url: acceptUrl,
        reason: parsed.reason,
      });
      await sendEmail(envelope);
    }
  } catch (emailErr) {
    console.error('[api/family/representative-transfer/propose] email send failed:', emailErr);
  }

  return NextResponse.json({ data: { proposal: data } }, { status: 201 });
}
