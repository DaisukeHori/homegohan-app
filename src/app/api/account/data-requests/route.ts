/**
 * GET  /api/account/data-requests - 本人の個人情報の請求 (開示・訂正・利用停止・消去) の一覧 (#1178 / #1702)
 * POST /api/account/data-requests - 請求を出す (本人確認のメールを登録アドレスへ送る)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §7.1・§7.2。本文の形は flat。
 * 一覧は本人のセッションの client (RLS・列の GRANT) で、必ず本人の user_id で絞って読む (service.ts の listOwnDsr)。
 * 作成は認証のあとに作る service_role の client で行う (書き込みの口はサーバーだけ。§3.1)。
 * 凍結中の呼び出しは middleware が先に 403 にする (route の requireUser の 403 は二重の守り)。
 */
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { getSiteUrl } from '@/lib/site-config';
import { DSR_RATE_LIMIT_CATEGORY, dsrCreateBodySchema } from '@/lib/data-subject-requests/core';
import { createDsr, listOwnDsr } from '@/lib/data-subject-requests/service';
import {
  authenticateDsrRequester,
  createDsrRequesterContext,
  dsrInvalidJsonResponse,
  dsrRequesterInternalError,
  dsrRequesterResultResponse,
  dsrValidationErrorResponse,
  withDsrNoStore,
} from '@/lib/data-subject-requests/requester-http';

export const dynamic = 'force-dynamic';

const GET_ROUTE_NAME = 'GET /api/account/data-requests';
const POST_ROUTE_NAME = 'POST /api/account/data-requests';

export async function GET(): Promise<NextResponse> {
  const auth = await authenticateDsrRequester(GET_ROUTE_NAME);
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;
  const ctx = createDsrRequesterContext(GET_ROUTE_NAME, userId);

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (error) {
    return dsrRequesterInternalError(GET_ROUTE_NAME, error, { userId, requestId: ctx.requestId });
  }
  const result = await listOwnDsr(supabase, userId, ctx);
  return dsrRequesterResultResponse(GET_ROUTE_NAME, result, { ...ctx, userId }, { key: 'requests', status: 200 });
}

export async function POST(request: Request): Promise<NextResponse> {
  // 本文に NULL 文字 (U+0000) があれば、認証・DB に触れる前に 400 INVALID_CHARACTER (#1657。§7.1 の形)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  const auth = await authenticateDsrRequester(POST_ROUTE_NAME);
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;
  const ctx = createDsrRequesterContext(POST_ROUTE_NAME, userId);

  // 連打の上限 (カテゴリ dsr。key は本人の id)。判定できないとき (Redis の障害) は通さない (fail-close → 500)
  try {
    const rateLimit = await checkRateLimit(userId, DSR_RATE_LIMIT_CATEGORY);
    if (!rateLimit.success) {
      ctx.log.warn('個人情報の請求の作成が連打の上限に掛かりました', { reset: rateLimit.reset });
      return withDsrNoStore(rateLimitExceededResponse(rateLimit));
    }
  } catch (error) {
    return dsrRequesterInternalError(POST_ROUTE_NAME, error, { userId, requestId: ctx.requestId });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return dsrInvalidJsonResponse();
  }
  const parsed = dsrCreateBodySchema.safeParse(body);
  if (!parsed.success) return dsrValidationErrorResponse(parsed.error);

  let admin: ReturnType<typeof getSupabaseAdmin>;
  try {
    // 本人をセッションで確かめたあとにだけ service_role の client を作る
    admin = getSupabaseAdmin();
  } catch (error) {
    return dsrRequesterInternalError(POST_ROUTE_NAME, error, { userId, requestId: ctx.requestId });
  }
  const result = await createDsr(admin, { userId, input: parsed.data, siteUrl: getSiteUrl() }, ctx);
  return dsrRequesterResultResponse(POST_ROUTE_NAME, result, { ...ctx, userId }, { key: 'request', status: 201 });
}
