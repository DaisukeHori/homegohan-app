// src/app/api/org/invites/[id]/revoke/route.ts
// (設計書 02-flow-spec.md §3 — POST /api/org/invites/{id}/revoke)
// owner/admin のみ実行可 (RLS + 共通の requireOrgAdmin()、#1161)

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { INTERNAL_ERROR_MESSAGE, internalError } from '@/lib/api/errors';
import { ORG_API_REVOKE_ADMIN_ONLY_MESSAGE } from '@/lib/org-api-errors';

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
        { error: { code: 'INSUFFICIENT_PERMISSION', message: ORG_API_REVOKE_ADMIN_ONLY_MESSAGE } },
        { status: 403 },
      );
    }
    createLogger('POST /api/org/invites/[id]/revoke', generateRequestId()).error('組織管理者の確認に失敗しました', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE } },
      { status: 500 },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc('revoke_org_invite', { p_invite_id: id });

  if (error) {
    // RPC の生のエラー文は本文に出さない (#1172)。分かるコードは固定の文で返し、分からないものは汎用の 500 にして構造化ログに残す
    const { code, status } = mapPgErrorToHttp(error.message);
    if (status >= 500) {
      return internalError('POST /api/org/invites/[id]/revoke', error, {}, { shape: 'nested' });
    }
    return NextResponse.json({ error: { code, message: '招待の取り消しに失敗しました' } }, { status });
  }

  return NextResponse.json({ ok: true });
}
