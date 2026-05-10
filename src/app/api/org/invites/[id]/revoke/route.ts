// src/app/api/org/invites/[id]/revoke/route.ts
// (設計書 02-flow-spec.md §3 revoke フロー)
// 認証必須 + admin/owner 権限
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const inviteId = params.id;

  // 招待 fetch (organization_id 取得)
  const { data: invite, error: fetchError } = await supabase
    .from('organization_invites')
    .select('id, organization_id, status')
    .eq('id', inviteId)
    .single();

  if (fetchError || !invite) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.INVITE_NOT_FOUND, message: '招待が見つかりません' } },
      { status: 404 },
    );
  }

  if (invite.status !== 'pending') {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.INVITE_ALREADY_USED, message: '招待はすでに処理済みです' } },
      { status: 409 },
    );
  }

  // 権限確認: caller が org の admin/owner か
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  const isOrgAdmin = profile?.roles?.some((r: string) =>
    ['org_admin', 'org_manager'].includes(r),
  );

  if (!isOrgAdmin || profile?.organization_id !== invite.organization_id) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_ORG_ADMIN, message: '権限がありません' } },
      { status: 403 },
    );
  }

  // revoke: status を 'revoked' に更新
  const { data: updated, error: updateError } = await supabase
    .from('organization_invites')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
    } as Record<string, unknown>)
    .eq('id', inviteId)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: updateError.message } },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: updated });
}
