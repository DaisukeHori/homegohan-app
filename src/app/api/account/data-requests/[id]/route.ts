/**
 * GET /api/account/data-requests/[id] - 本人の個人情報の請求の詳細 (応答 response_note を読む) (#1178 / #1702)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §7.2。本人のセッションの client で、id と本人の user_id の両方で絞って読む
 * (service.ts の getOwnDsr)。無い行・他人の行・退会済みの行は 404 (admin / super_admin の本人でも他人の id は 404)。
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOwnDsr } from '@/lib/data-subject-requests/service';
import {
  authenticateDsrRequester,
  createDsrRequesterContext,
  dsrRequesterInternalError,
  dsrRequesterResultResponse,
  parseDsrId,
} from '@/lib/data-subject-requests/requester-http';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'GET /api/account/data-requests/[id]';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const auth = await authenticateDsrRequester(ROUTE_NAME);
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const { id: rawId } = await context.params;
  const idResult = parseDsrId(rawId);
  if (!idResult.ok) return idResult.response;

  const ctx = createDsrRequesterContext(ROUTE_NAME, userId);
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (error) {
    return dsrRequesterInternalError(ROUTE_NAME, error, { userId, requestId: ctx.requestId });
  }
  const result = await getOwnDsr(supabase, userId, idResult.id, ctx);
  return dsrRequesterResultResponse(ROUTE_NAME, result, { ...ctx, userId }, { key: 'request', status: 200 });
}
