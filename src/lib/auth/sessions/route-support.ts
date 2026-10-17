/**
 * ログイン中の端末・ログイン履歴の利用者の API (/api/auth/sessions*・/api/auth/login-history) の応答の共通部品 (#1189・#1190)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §14 冒頭・§19。
 *
 * 共通の約束: 応答に Cache-Control: private, no-store・本文は /api/auth/login と同じ flat の形 { error: 利用者向けの文言, code, ... }。
 * 認証は requireSessionUser (§12.4): AuthError → 401 (code はそのまま)・ForbiddenError → 403 (code はそのまま)・それ以外 → 500 (internalError)。
 * 本文に例外の文面・DB の生の文を入れない (4xx はこちらで決めた固定の文 §19)。
 * サーバー専用 (next/server)。画面 (client component) からは import しない。
 */
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { deviceFamilyOf, deviceLabelOf } from './device-family';
import type { LoginHistoryEntry, SessionSummary } from './schemas';
import type { SessionRow } from './store';

/** 本人だけの応答なので、共有のキャッシュにもブラウザのキャッシュにも残さない */
export const SESSIONS_NO_STORE_HEADERS: Readonly<Record<string, string>> = { 'Cache-Control': 'private, no-store' };

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** 未認証・セッションを読めない (AuthError) ときの文 */
const UNAUTHENTICATED_MESSAGE = 'ログインが切れました。もう一度ログインしてください。';
/** 凍結中 (ForbiddenError の AUTH_ACCOUNT_FROZEN) の文 (middleware・requireUser と同じ文) */
const FROZEN_MESSAGE = 'アカウントが凍結されています';
/** そのほかの ForbiddenError の文 */
const FORBIDDEN_MESSAGE = 'この操作を行う権限がありません。';

/** §19 の固定の文 (本書の段 B の code) */
export const SESSION_ERROR_MESSAGES = {
  VALIDATION_ERROR: '入力の内容を確認してください。',
  AUTH_SESSION_NOT_FOUND: 'その端末のログインは、すでに終了しています。',
  AUTH_SESSION_IS_CURRENT: 'いま使っている端末は、ここでは解除できません。ログアウトを使ってください。',
} as const;

/** flat の本文の応答 (no-store 付き) */
export function sessionsJson(body: Record<string, unknown>, status?: number): NextResponse {
  return NextResponse.json(body, { status, headers: SESSIONS_NO_STORE_HEADERS });
}

/** 400 VALIDATION_ERROR (本文の形・端末名の使えない文字 §12.5) */
export function sessionsValidationError(): NextResponse {
  return sessionsJson({ error: SESSION_ERROR_MESSAGES.VALIDATION_ERROR, code: 'VALIDATION_ERROR' }, HTTP_BAD_REQUEST);
}

/** 404 AUTH_SESSION_NOT_FOUND */
export function sessionNotFound(): NextResponse {
  return sessionsJson({ error: SESSION_ERROR_MESSAGES.AUTH_SESSION_NOT_FOUND, code: 'AUTH_SESSION_NOT_FOUND' }, HTTP_NOT_FOUND);
}

/** 409 AUTH_SESSION_IS_CURRENT */
export function sessionIsCurrent(): NextResponse {
  return sessionsJson({ error: SESSION_ERROR_MESSAGES.AUTH_SESSION_IS_CURRENT, code: 'AUTH_SESSION_IS_CURRENT' }, HTTP_CONFLICT);
}

/** 500 INTERNAL_ERROR (internalError に no-store を付ける。元のエラーは app_logs にだけ残り、本文は固定の文) */
export function sessionsInternalError(routeName: string, error: unknown, userId?: string): NextResponse {
  const response = internalError(routeName, error, userId ? { userId } : {});
  for (const [name, value] of Object.entries(SESSIONS_NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

/**
 * 例外を応答にする: AuthError → 401・ForbiddenError → 403 (どちらも本文の code は例外の code をそのまま出し、文は固定)。
 * それ以外 (SessionUserProfileReadError・DB・GoTrue の失敗) → 500
 */
export function sessionsFailure(routeName: string, err: unknown, userId?: string): NextResponse {
  if (err instanceof AuthError) return sessionsJson({ error: UNAUTHENTICATED_MESSAGE, code: err.code }, HTTP_UNAUTHORIZED);
  if (err instanceof ForbiddenError) {
    const message = err.code === 'AUTH_ACCOUNT_FROZEN' ? FROZEN_MESSAGE : FORBIDDEN_MESSAGE;
    return sessionsJson({ error: message, code: err.code }, HTTP_FORBIDDEN);
  }
  return sessionsInternalError(routeName, err, userId);
}

/**
 * user_sessions_metadata の行を一覧の 1 行 (§14.1) にする。device_label は UA から決まる言葉 (見出し)、device_name はアプリが登録した名前 (添え書き §15)。
 * is_current = 要求の JWT の session_id の行か
 */
export function toSessionSummary(row: SessionRow, currentSessionId: string): SessionSummary {
  return {
    session_id: row.session_id,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    device_label: deviceLabelOf(deviceFamilyOf(row.user_agent)),
    device_name: row.device_name,
    ip_address: row.ip_address,
    country_code: row.country_code,
    is_current: row.session_id === currentSessionId,
  };
}

/** user_sessions_metadata の行を「最近のログイン」の 1 行 (§14.5) にする。ended_at = revoked_at */
export function toLoginHistoryEntry(row: SessionRow): LoginHistoryEntry {
  return {
    session_id: row.session_id,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    device_label: deviceLabelOf(deviceFamilyOf(row.user_agent)),
    device_name: row.device_name,
    ip_address: row.ip_address,
    country_code: row.country_code,
    ended_at: row.revoked_at,
    ended_reason: row.ended_reason,
    is_new_device: row.is_new_device,
    is_new_ip: row.is_new_ip,
    is_new_country: row.is_new_country,
    alert_sent_at: row.alert_sent_at,
  };
}
