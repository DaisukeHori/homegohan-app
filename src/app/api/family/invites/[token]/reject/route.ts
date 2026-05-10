// src/app/api/family/invites/[token]/reject/route.ts
// (設計書 02-flow-spec.md §3 相当, family 版)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const supabase = await createClient();

  // 認証は任意 (未ログインでも拒否できる)
  const { token } = await params;

  if (!token) {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'トークンが必要です' } },
      { status: 400 },
    );
  }

  // RPC: reject_family_invite
  const { data, error } = await supabase.rpc('reject_family_invite', {
    p_token: token,
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

    console.error('[api/family/invites/reject] RPC error:', error);
    return NextResponse.json(
      { error: { code: MembershipErrorCode.RPC_FAILED, message: '招待の拒否に失敗しました' } },
      { status: 500 },
    );
  }

  return NextResponse.json({ data });
}
