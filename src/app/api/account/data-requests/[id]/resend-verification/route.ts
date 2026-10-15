/**
 * POST /api/account/data-requests/[id]/resend-verification - 本人確認のメールを新しいリンクで送り直す (#1178 / #1702)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §7.2。本文は読まない (rejectNullCharacterBody も呼ばない)。
 * 検査の順: requireUser → id → 連打の上限 (カテゴリ dsr) → service。
 * service.ts の resendDsrVerification が、本人確認待ちでなければ 409 DSR_INVALID_STATE、送信回数が上限なら 409 DSR_VERIFICATION_LIMIT、
 * 状態と送信回数を条件にした UPDATE が 0 行なら 409 DSR_INVALID_STATE (メールなし) を返す。期限切れかどうかは問わない。
 */
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getSiteUrl } from '@/lib/site-config';
import { DSR_RATE_LIMIT_CATEGORY } from '@/lib/data-subject-requests/core';
import { resendDsrVerification } from '@/lib/data-subject-requests/service';
import {
  authenticateDsrRequester,
  createDsrRequesterContext,
  dsrRequesterInternalError,
  dsrRequesterResultResponse,
  parseDsrId,
  withDsrNoStore,
} from '@/lib/data-subject-requests/requester-http';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/account/data-requests/[id]/resend-verification';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  const auth = await authenticateDsrRequester(ROUTE_NAME);
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const { id: rawId } = await context.params;
  const idResult = parseDsrId(rawId);
  if (!idResult.ok) return idResult.response;

  const ctx = createDsrRequesterContext(ROUTE_NAME, userId);
  // 連打の上限 (カテゴリ dsr。key は本人の id。作成と同じ枠)。判定できないとき (Redis の障害) は通さない (fail-close → 500)
  try {
    const rateLimit = await checkRateLimit(userId, DSR_RATE_LIMIT_CATEGORY);
    if (!rateLimit.success) {
      ctx.log.warn('個人情報の請求の確認メールの再送が連打の上限に掛かりました', { reset: rateLimit.reset });
      return withDsrNoStore(rateLimitExceededResponse(rateLimit));
    }
  } catch (error) {
    return dsrRequesterInternalError(ROUTE_NAME, error, { userId, requestId: ctx.requestId });
  }

  let admin: ReturnType<typeof getSupabaseAdmin>;
  try {
    // 本人をセッションで確かめたあとにだけ service_role の client を作る
    admin = getSupabaseAdmin();
  } catch (error) {
    return dsrRequesterInternalError(ROUTE_NAME, error, { userId, requestId: ctx.requestId });
  }
  const result = await resendDsrVerification(admin, { userId, id: idResult.id, siteUrl: getSiteUrl() }, ctx);
  return dsrRequesterResultResponse(ROUTE_NAME, result, { ...ctx, userId }, { key: 'request', status: 200 });
}
