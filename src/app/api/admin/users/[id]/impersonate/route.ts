/**
 * POST /api/admin/users/{id}/impersonate — impersonate
 * operator/02-api-spec.md §4 準拠
 * 権限: super_admin のみ
 */

import { NextResponse } from 'next/server';
import { requireRole, impersonate } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError, ImpersonationError } from '@/lib/auth/errors';
import { ImpersonateBodySchema } from '@/lib/admin/users-schemas';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

export async function POST(request: Request, { params }: Params) {
  // impersonate は super_admin のみ可能
  try {
    await requireRole(['super_admin']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: 'impersonate は super_admin のみ実行可能です' } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { id } = params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = ImpersonateBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'reason は必須です', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { reason } = parseResult.data;

  try {
    const result = await impersonate(id, reason);
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof ImpersonationError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 403 },
      );
    }
    throw err;
  }
}
