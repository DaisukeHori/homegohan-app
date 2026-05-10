// src/app/api/family/invites/[id]/revoke/route.ts
// (設計書 02-flow-spec.md §3 相当, family 版 revoke)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();

  // 認証必須 (owner/sub_owner のみが revoke 可能)
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { id } = await params;

  if (!id) {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: '招待 ID が必要です' } },
      { status: 400 },
    );
  }

  // RPC: revoke_family_invite
  const { data, error } = await supabase.rpc('revoke_family_invite', {
    p_invite_id: id,
  });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message ?? '');

    if (code === MembershipErrorCode.INVITE_NOT_FOUND) {
      return NextResponse.json(
        { error: { code, message: '招待が見つかりません' } },
        { status },
      );
    }
    if (code === MembershipErrorCode.INSUFFICIENT_PERMISSION) {
      return NextResponse.json(
        { error: { code, message: 'この操作を行う権限がありません' } },
        { status },
      );
    }

    console.error('[api/family/invites/revoke] RPC error:', error);
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: '招待の取り消しに失敗しました' } },
      { status: 500 },
    );
  }

  return NextResponse.json({ data });
}
