// POST /api/org/members/[user_id]/remove
// 所属組織の owner/admin のみ実行可 (共通の requireOrgAdmin()、#1161)
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin, type OrgAdminContext } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  request: Request,
  { params }: { params: { user_id: string } },
) {
  let admin: OrgAdminContext;
  try {
    admin = await requireOrgAdmin();
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner/admin のみ除名可能です' } },
        { status: 403 },
      );
    }
    createLogger('POST /api/org/members/[user_id]/remove', generateRequestId()).error(
      '組織管理者の確認に失敗しました',
      error,
    );
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
  const { profile } = admin;

  const targetUserId = params.user_id;
  if (!targetUserId) {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'user_id が必要です' } },
      { status: 400 },
    );
  }

  const supabase = createClient();
  const { error: rpcError } = await supabase.rpc('remove_org_member', {
    p_organization_id: profile.organization_id,
    p_user_id: targetUserId,
  });

  if (rpcError) {
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    return NextResponse.json({ error: { code, message: rpcError.message } }, { status });
  }

  return NextResponse.json({ ok: true });
}
