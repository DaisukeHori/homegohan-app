/**
 * POST /api/account/data-requests/[id]/verify - 本人確認 (メールのリンクのトークンを突き合わせて受付にする) (#1178 / #1702)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §7.2。検査の順: NULL 文字 → authenticateDsrRequester → id → 本文の JSON → zod → service。
 * service.ts の verifyDsr が、本人の行を service_role で読み (無ければ 404) → 本人確認待ちでなければ 409 → 期限切れ 410 →
 * 不一致 400 → 状態と hash を条件にした UPDATE (0 行なら 409・メールなし) → メール 2 通 (best-effort) の順に判定する。
 * 応答期限 (日) は getDsrResponseDueDays() (環境変数 DSR_RESPONSE_DUE_DAYS)。
 */
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getDsrResponseDueDays } from '@/lib/data-subject-requests/config';
import { dsrVerifyBodySchema } from '@/lib/data-subject-requests/core';
import { verifyDsr } from '@/lib/data-subject-requests/service';
import {
  authenticateDsrRequester,
  createDsrRequesterContext,
  dsrInvalidJsonResponse,
  dsrRequesterInternalError,
  dsrRequesterResultResponse,
  dsrValidationErrorResponse,
  parseDsrId,
} from '@/lib/data-subject-requests/requester-http';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/account/data-requests/[id]/verify';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  // 本文に NULL 文字 (U+0000) があれば、認証・DB に触れる前に 400 INVALID_CHARACTER (#1657。§7.1 の形)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  const auth = await authenticateDsrRequester(ROUTE_NAME);
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const { id: rawId } = await context.params;
  const idResult = parseDsrId(rawId);
  if (!idResult.ok) return idResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return dsrInvalidJsonResponse();
  }
  const parsed = dsrVerifyBodySchema.safeParse(body);
  if (!parsed.success) return dsrValidationErrorResponse(parsed.error);

  const ctx = createDsrRequesterContext(ROUTE_NAME, userId);
  let admin: ReturnType<typeof getSupabaseAdmin>;
  try {
    // 本人をセッションで確かめたあとにだけ service_role の client を作る
    admin = getSupabaseAdmin();
  } catch (error) {
    return dsrRequesterInternalError(ROUTE_NAME, error, { userId, requestId: ctx.requestId });
  }
  const result = await verifyDsr(
    admin,
    { userId, id: idResult.id, token: parsed.data.token, dueDays: getDsrResponseDueDays() },
    ctx,
  );
  return dsrRequesterResultResponse(ROUTE_NAME, result, { ...ctx, userId }, { key: 'request', status: 200 });
}
