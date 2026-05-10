// src/app/api/org/invites/[token]/reject/route.ts
// (設計書 02-flow-spec.md §3 reject フロー)
// 認証任意 (anon でも reject 可)
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

function mapRpcError(message: string): { code: string; status: number } {
  if (message.includes('INVITE_NOT_FOUND'))    return { code: MembershipErrorCode.INVITE_NOT_FOUND,       status: 404 };
  if (message.includes('INVITE_ALREADY_USED')) return { code: MembershipErrorCode.INVITE_ALREADY_USED,    status: 409 };
  if (message.includes('INVITE_EMAIL_MISMATCH')) return { code: MembershipErrorCode.INVITE_EMAIL_MISMATCH, status: 409 };
  return { code: MembershipErrorCode.RPC_FAILED, status: 500 };
}

export async function POST(
  _request: Request,
  { params }: { params: { token: string } },
) {
  const supabase = await createClient();
  const token = params.token;

  // NOTE: DB 型生成が未完のため unknown キャストを使用 (migration 後に型再生成が必要)
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>)(
    'reject_org_invite',
    { p_token: token },
  );

  if (error) {
    const { code, status } = mapRpcError(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: error.message } },
      { status },
    );
  }

  return NextResponse.json({ data });
}
