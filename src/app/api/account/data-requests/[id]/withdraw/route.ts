/**
 * POST /api/account/data-requests/[id]/withdraw - 開いている請求を本人が取り下げる (#1178 / #1702)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §7.2。本文は読まない (rejectNullCharacterBody も呼ばない)。
 * 検査の順: authenticateDsrRequester → id → service。メールは送らない。
 * service.ts の withdrawDsr が、終わった請求なら 409 DSR_INVALID_STATE、開いている状態を条件にした UPDATE が 0 行なら
 * 409 DSR_INVALID_STATE (判定の後に運営が対応済み・却下にした記録を上書きしない) を返す。
 */
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { withdrawDsr } from '@/lib/data-subject-requests/service';
import {
  authenticateDsrRequester,
  createDsrRequesterContext,
  dsrRequesterInternalError,
  dsrRequesterResultResponse,
  parseDsrId,
} from '@/lib/data-subject-requests/requester-http';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/account/data-requests/[id]/withdraw';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  const auth = await authenticateDsrRequester(ROUTE_NAME);
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const { id: rawId } = await context.params;
  const idResult = parseDsrId(rawId);
  if (!idResult.ok) return idResult.response;

  const ctx = createDsrRequesterContext(ROUTE_NAME, userId);
  let admin: ReturnType<typeof getSupabaseAdmin>;
  try {
    // 本人をセッションで確かめたあとにだけ service_role の client を作る
    admin = getSupabaseAdmin();
  } catch (error) {
    return dsrRequesterInternalError(ROUTE_NAME, error, { userId, requestId: ctx.requestId });
  }
  const result = await withdrawDsr(admin, { userId, id: idResult.id }, ctx);
  return dsrRequesterResultResponse(ROUTE_NAME, result, { ...ctx, userId }, { key: 'request', status: 200 });
}
