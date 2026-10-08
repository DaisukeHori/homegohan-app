// src/app/api/org/invites/[id]/revoke/route.ts
// (設計書 02-flow-spec.md §3 — POST /api/org/invites/{id}/revoke)
// owner/admin のみ実行可 (RLS + 共通の requireOrgAdmin()、#1161)

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // 呼び出し者が所属組織の owner/admin かを確認する
  try {
    await requireOrgAdmin();
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner/admin のみ取消可能です' } },
        { status: 403 },
      );
    }
    createLogger('POST /api/org/invites/[id]/revoke', generateRequestId()).error('組織管理者の確認に失敗しました', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }

  const supabase = createClient();
  const { error } = await supabase.rpc('revoke_org_invite', { p_invite_id: id });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message);
    return NextResponse.json(
      { error: { code, message: error.message } },
      { status },
    );
  }

  return NextResponse.json({ ok: true });
}
