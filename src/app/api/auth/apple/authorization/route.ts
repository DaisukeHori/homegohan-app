/**
 * POST /api/auth/apple/authorization — iOS の Sign in with Apple の認可コードを refresh token に替えて保管する
 * (docs/design/mobile/08-sign-in-with-apple.md §9.2)。
 * 1. rejectNullCharacterBody → readJsonBody + AppleAuthorizationBodySchema (違えば 400 VALIDATION_ERROR)
 * 2. requireSessionUser (Bearer。user_profiles の行が無い新規の利用者も通る) → checkRateLimit(user.id, 'auth-apple-authorization') (429)
 * 3. identities に apple が無ければ 409 APPLE_IDENTITY_NOT_LINKED
 * 4. registerAppleAuthorization → 200 { stored } / 400 APPLE_AUTHORIZATION_CODE_INVALID / 500 (internalError。step は client_secret / exchange / store)
 * 本文・ログに認可コード・refresh token・secret を出さない。
 */
import { NextResponse, type NextRequest } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { hasAppleIdentity, registerAppleAuthorization } from '@/lib/auth/apple/authorization';
import { AppleAuthorizationBodySchema } from '@/lib/auth/apple/schemas';
import { sessionsFailure } from '@/lib/auth/sessions/route-support';
import { requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { readJsonBody } from '@/lib/http-params';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/apple/authorization';
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
/**
 * 利用者に見せる固定の文 (英文の生のエラーは出さない)。本文は NextResponse.json に直接書く
 * (tests/api-error-japanese-scan.test.ts の走査は NextResponse.json の本文の error / message と同じファイルの定数を読む。
 *  本文を引数で受ける関数を挟むと文を読めない)
 */
const VALIDATION_MESSAGE = '入力の形が正しくありません。';
const CODE_INVALID_MESSAGE = 'Apple の認可の情報が有効ではありません。もう一度ログインしてください。';
const NOT_LINKED_MESSAGE = 'このアカウントは Apple でログインしていません。';

/**
 * 既存の関数 (internalError・rateLimitExceededResponse) が返す応答にも Cache-Control: private, no-store を付ける
 * (§9.2 のヘッダの行は、この route のすべての応答に掛かる)。本文・status は変えない
 */
function withNoStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE)) response.headers.set(name, value);
  return response;
}

export async function POST(request: NextRequest) {
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  const read = await readJsonBody(request);
  if (!read.ok) {
    return NextResponse.json({ error: VALIDATION_MESSAGE, code: 'VALIDATION_ERROR' }, { status: HTTP_BAD_REQUEST, headers: NO_STORE });
  }
  const parsed = AppleAuthorizationBodySchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json({ error: VALIDATION_MESSAGE, code: 'VALIDATION_ERROR' }, { status: HTTP_BAD_REQUEST, headers: NO_STORE });
  }

  const requestId = generateRequestId();
  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    const limit = await checkRateLimit(ctx.user.id, 'auth-apple-authorization');
    if (!limit.success) return withNoStore(rateLimitExceededResponse(limit));
    if (!hasAppleIdentity(ctx.user)) {
      return NextResponse.json({ error: NOT_LINKED_MESSAGE, code: 'APPLE_IDENTITY_NOT_LINKED' }, { status: HTTP_CONFLICT, headers: NO_STORE });
    }

    const log = createLogger(ROUTE_NAME, requestId).withUser(ctx.user.id);
    const result = await registerAppleAuthorization({
      admin: getSupabaseAdmin(),
      userId: ctx.user.id,
      authorizationCode: parsed.data.authorization_code,
    });
    switch (result.status) {
      case 'stored':
        return NextResponse.json({ stored: true }, { status: HTTP_OK, headers: NO_STORE });
      case 'not_configured':
        log.info('apple authorization: server config is missing; refresh token not stored', { request_id: requestId });
        return NextResponse.json({ stored: false, reason: 'not_configured' }, { status: HTTP_OK, headers: NO_STORE });
      case 'invalid_code':
        log.warn('apple authorization: apple rejected the authorization code', {
          request_id: requestId,
          apple_status: result.appleStatus,
          apple_error: result.appleError,
        });
        return NextResponse.json(
          { error: CODE_INVALID_MESSAGE, code: 'APPLE_AUTHORIZATION_CODE_INVALID' },
          { status: HTTP_BAD_REQUEST, headers: NO_STORE },
        );
      case 'unavailable':
        return withNoStore(
          internalError(ROUTE_NAME, new Error('apple token endpoint unavailable'), {
            userId: ctx.user.id,
            requestId,
            step: 'exchange',
            apple_status: result.appleStatus,
            apple_error: result.appleError,
          }),
        );
      case 'secret_failed':
        return withNoStore(internalError(ROUTE_NAME, result.error, { userId: ctx.user.id, requestId, step: 'client_secret' }));
      case 'store_failed':
        return withNoStore(internalError(ROUTE_NAME, result.error, { userId: ctx.user.id, requestId, step: 'store' }));
    }
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
