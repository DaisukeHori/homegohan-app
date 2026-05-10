// src/app/api/family/representative-transfer/[id]/accept/route.ts
// (設計書 02-flow-spec.md §10)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderFamilyTransferCompletedEmail } from '@/lib/emails/membership/family-transfer-completed';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: proposal_id } = await params;
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { data, error } = await supabase.rpc('accept_family_representative_transfer', {
    p_proposal_id: proposal_id,
  });

  if (error) {
    if (error.message?.includes('TRANSFER_NOT_FOUND')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.TRANSFER_NOT_FOUND, message: '譲渡提案が見つかりません' } },
        { status: 404 },
      );
    }
    if (error.message?.includes('TRANSFER_NOT_PENDING')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.TRANSFER_NOT_PENDING, message: '譲渡提案は既に処理済みです' } },
        { status: 409 },
      );
    }
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: '代表者譲渡の承諾に失敗しました' } },
      { status },
    );
  }

  // 完了メール送信
  try {
    const result = data as { family_id?: string; new_representative_id?: string; old_representative_id?: string };
    if (result?.family_id) {
      const { data: familyGroup } = await supabase
        .from('family_groups')
        .select('name')
        .eq('id', result.family_id)
        .single();

      const { data: newRepProfile } = await supabase
        .from('user_profiles')
        .select('nickname, email')
        .eq('id', result.new_representative_id ?? user.id)
        .single();

      const { data: oldRepProfile } = await supabase
        .from('user_profiles')
        .select('email')
        .eq('id', result.old_representative_id ?? '')
        .single();

      const familyName = familyGroup?.name ?? '家族グループ';
      const newRepName = newRepProfile?.nickname ?? newRepProfile?.email ?? '新代表者';

      if (oldRepProfile?.email) {
        const envelope = renderFamilyTransferCompletedEmail({
          to_email: oldRepProfile.email,
          new_representative_name: newRepName,
          family_name: familyName,
          is_old_representative: true,
        });
        await sendEmail(envelope);
      }

      if (newRepProfile?.email) {
        const envelope = renderFamilyTransferCompletedEmail({
          to_email: newRepProfile.email,
          new_representative_name: newRepName,
          family_name: familyName,
          is_old_representative: false,
        });
        await sendEmail(envelope);
      }
    }
  } catch (emailErr) {
    console.error('[api/family/representative-transfer/accept] email send failed:', emailErr);
  }

  return NextResponse.json({ data }, { status: 200 });
}
