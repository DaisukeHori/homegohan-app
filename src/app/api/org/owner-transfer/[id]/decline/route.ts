// POST /api/org/owner-transfer/[id]/decline
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const proposalId = params.id;

  // #1039 F3-06/F3-07: 直接 UPDATE は RLS で0行に潰れる (責任は RPC に移す)
  const { data, error } = await supabase.rpc('decline_org_owner_transfer', {
    p_proposal_id: proposalId,
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
        { error: { code: MembershipErrorCode.TRANSFER_NOT_PENDING, message: '対象の提案が見つからないか、すでに処理済みです' } },
        { status: 409 },
      );
    }
    if (error.message?.includes('INSUFFICIENT_PERMISSION')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.INSUFFICIENT_PERMISSION, message: 'この操作を行う権限がありません' } },
        { status: 403 },
      );
    }
    const { code, status } = mapPgErrorToHttp(error.message);
    return NextResponse.json({ error: { code, message: error.message } }, { status });
  }

  return NextResponse.json({ ok: true, result: data });
}
