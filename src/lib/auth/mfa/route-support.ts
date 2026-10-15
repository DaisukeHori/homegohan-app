/**
 * 運営ロールの MFA の自己サービス API (/api/auth/mfa/*) の応答の共通部品 (#1176。docs/design/cross/12-operator-mfa.md §14 冒頭)
 *
 * 共通の約束: 応答に Cache-Control: private, no-store・本文は /api/auth/login と同じ flat の形 { error, code, ... } (成功は { ok: true, ... })。
 * POST / DELETE は /api/auth/login と同じ判定で別オリジンを 403 FORBIDDEN_ORIGIN にする (Cookie を持つ要求のため)。
 * 500 は internalError (固定の文。元のエラーは app_logs) に no-store を付けたもの。
 * 段 A の 4 route (status / enroll / verify / recover) と、段 B で足す 2 route (factors/{id}・backup-codes) が使う。
 * サーバー専用 (next/server)。画面 (client component) からは import しない。
 */
import { NextResponse, type NextRequest } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

/** 自己サービス API の応答に付けるヘッダ (本人だけの応答なので、共有のキャッシュにもブラウザのキャッシュにも残さない) */
export const MFA_NO_STORE_HEADERS: Readonly<Record<string, string>> = { 'Cache-Control': 'private, no-store' };

/** 別オリジンの要求を断るときの文 (/api/auth/login と同じ) */
const FORBIDDEN_ORIGIN_MESSAGE = '許可されていないリクエストです。';
/** 回数制限の文 (/api/auth/login と同じ) */
const RATE_LIMITED_MESSAGE = 'しばらくしてから再度お試しください。';
/** 未認証・セッションを読めない (AuthError) ときの文。code は例外の code をそのまま出す (§14.8.1) */
const UNAUTHENTICATED_MESSAGE = 'ログインが切れました。もう一度ログインしてください。';
/** 対象ロールでない・凍結中 (ForbiddenError) ときの文。code は例外の code をそのまま出す (§14.8.1) */
const FORBIDDEN_MESSAGE = 'この操作を行う権限がありません。';
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;

/** flat の本文の応答 (no-store 付き) */
export function mfaJson(
  body: Record<string, unknown>,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): NextResponse {
  return NextResponse.json(body, { status, headers: { ...MFA_NO_STORE_HEADERS, ...headers } });
}

/**
 * 別のサイトのページから送られた要求か (/api/auth/login の isCrossOrigin と同じ規則)。ブラウザは POST / DELETE の fetch に Origin を付ける。
 * Origin が無い要求 (ブラウザ以外・モバイルの Bearer) はここでは断らない
 */
export function isCrossOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.nextUrl.host;
  } catch {
    return true;
  }
}

/** 403 FORBIDDEN_ORIGIN */
export function mfaForbiddenOrigin(): NextResponse {
  return mfaJson({ error: FORBIDDEN_ORIGIN_MESSAGE, code: 'FORBIDDEN_ORIGIN' }, HTTP_FORBIDDEN);
}

/** 429 RATE_LIMITED。秒が分かれば Retry-After と retryAfter を付ける (アプリ側の回数制限) */
export function mfaRateLimited(retryAfterSec: number | null): NextResponse {
  return mfaJson(
    { error: RATE_LIMITED_MESSAGE, code: 'RATE_LIMITED', ...(retryAfterSec ? { retryAfter: retryAfterSec } : {}) },
    HTTP_TOO_MANY_REQUESTS,
    retryAfterSec ? { 'Retry-After': String(retryAfterSec) } : {},
  );
}

/** 500 INTERNAL_ERROR (internalError に no-store を付ける。元のエラーは app_logs にだけ残り、本文は固定の文) */
export function mfaInternalError(routeName: string, error: unknown, userId?: string): NextResponse {
  const response = internalError(routeName, error, userId ? { userId } : {});
  for (const [name, value] of Object.entries(MFA_NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

/**
 * requireRole などの認可の例外を応答にする (§14.8.1): AuthError → 401・ForbiddenError → 403。どちらも本文の code は例外の code をそのまま出し、
 * 文はこちらで決めた固定の文 (例外の文面は本文に入れない)。認可の例外でなければ null (呼び出し側が 500 にする)
 */
export function mfaAuthFailure(err: unknown): NextResponse | null {
  if (err instanceof AuthError) return mfaJson({ error: UNAUTHENTICATED_MESSAGE, code: err.code }, HTTP_UNAUTHORIZED);
  if (err instanceof ForbiddenError) return mfaJson({ error: FORBIDDEN_MESSAGE, code: err.code }, HTTP_FORBIDDEN);
  return null;
}
