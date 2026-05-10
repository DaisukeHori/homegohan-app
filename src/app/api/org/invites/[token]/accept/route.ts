// src/app/api/org/invites/[token]/accept/route.ts
// (設計書 02-flow-spec.md §1.2 accept フロー)
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

// P0001 エラーメッセージ → MembershipErrorCode マッピング
function mapRpcError(message: string): { code: string; status: number } {
  if (message.includes('INVITE_NOT_FOUND'))    return { code: MembershipErrorCode.INVITE_NOT_FOUND,       status: 404 };
  if (message.includes('INVITE_EXPIRED'))      return { code: MembershipErrorCode.INVITE_EXPIRED,         status: 410 };
  if (message.includes('INVITE_EMAIL_MISMATCH')) return { code: MembershipErrorCode.INVITE_EMAIL_MISMATCH, status: 409 };
  if (message.includes('INVITE_ALREADY_USED')) return { code: MembershipErrorCode.INVITE_ALREADY_USED,    status: 409 };
  if (message.includes('ALREADY_IN_ORG'))      return { code: MembershipErrorCode.ALREADY_IN_ORG,         status: 409 };
  if (message.includes('IS_ORG_OWNER'))        return { code: MembershipErrorCode.IS_ORG_OWNER,           status: 409 };
  if (message.includes('NOT_AUTHENTICATED'))   return { code: MembershipErrorCode.NOT_AUTHENTICATED,      status: 401 };
  return { code: MembershipErrorCode.RPC_FAILED, status: 500 };
}

export async function POST(
  _request: Request,
  { params }: { params: { token: string } },
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const token = params.token;

  // NOTE: DB 型生成が未完のため unknown キャストを使用 (migration 後に型再生成が必要)
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>)(
    'accept_org_invite',
    { p_token: token },
  );

  if (error) {
    const { code, status } = mapRpcError(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: error.message } },
      { status },
    );
  }

  const profile = data as {
    organization_id: string;
    org_role: string;
  };

  return NextResponse.json({
    data: {
      organization_id: profile.organization_id,
      org_role: profile.org_role,
    },
  });
}
