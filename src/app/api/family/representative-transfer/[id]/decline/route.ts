// src/app/api/family/representative-transfer/[id]/decline/route.ts
// (設計書 02-flow-spec.md §10)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

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

  // #1039 F3-06/F3-07: 直接 UPDATE は RLS で0行に潰れる (責任は RPC に移す)
  const { error: rpcError } = await supabase.rpc('decline_family_representative_transfer', {
    p_proposal_id: proposal_id,
  });

  if (rpcError) {
    if (rpcError.message?.includes('TRANSFER_NOT_FOUND')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.TRANSFER_NOT_FOUND, message: '譲渡提案が見つかりません' } },
        { status: 404 },
      );
    }
    if (rpcError.message?.includes('INSUFFICIENT_PERMISSION')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.INSUFFICIENT_PERMISSION, message: 'この操作を行う権限がありません' } },
        { status: 403 },
      );
    }
    if (rpcError.message?.includes('TRANSFER_NOT_PENDING')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.TRANSFER_NOT_PENDING, message: '譲渡提案は既に処理済みです' } },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: '譲渡提案の拒否に失敗しました' } },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: { proposal_id, status: 'rejected' } }, { status: 200 });
}
