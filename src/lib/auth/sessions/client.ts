/**
 * ログイン中の端末・最近のログインの画面 (Web の /settings/security/sessions) の通信の薄い包み (#1189・#1190)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §15 (Web の通信)・§14.1〜14.3・§14.5。
 *
 * React に依存しない。fetch を 1 回呼び、結果を判別共用体 SessionsClientResult<T> で返す (例外を投げない)。
 * 2xx の本文は §12.5 の Zod で読み、形が違えば失敗 (生の本文は出さない)。失敗は { code, message } に正規化する:
 * 4xx / 5xx は本文の code と error (route が §19 の固定の文か internalError の共通の文で作る)、読めなければ既定の code と文。
 *
 * ⚠️ client component ("use client") が import するので、サーバー専用のもの (next/headers・@/lib/supabase/server・store.ts) を import しない。
 */
import { z } from 'zod';
import {
  LoginHistoryResponseSchema,
  SessionsResponseSchema,
  type LoginHistoryEntry,
  type SessionSummary,
} from './schemas';

/** §14 の API のパス。画面はこれ以外の URL を組み立てない */
export const SESSIONS_API_PATHS = {
  sessions: '/api/auth/sessions',
  revokeOthers: '/api/auth/sessions/revoke-others',
  loginHistory: '/api/auth/login-history',
} as const;

/** DELETE /api/auth/sessions/{id} の URL */
export function sessionPath(sessionId: string): string {
  return `${SESSIONS_API_PATHS.sessions}/${encodeURIComponent(sessionId)}`;
}

/** HTTP の応答として扱えなかった (fetch が例外を投げた) ときの status。HTTP のステータスに 0 は無い */
export const SESSIONS_CLIENT_NO_STATUS = 0;
/** 通信の失敗 (fetch の reject) の code */
export const SESSIONS_CLIENT_NETWORK_ERROR = 'NETWORK_ERROR';
/** 2xx なのに本文が §12.5 の形でない・失敗の本文から code を読めないときの code */
export const SESSIONS_CLIENT_UNKNOWN_CODE = 'UNKNOWN';
/** 通信の失敗の文 */
export const SESSIONS_NETWORK_ERROR_MESSAGE = '通信に失敗しました。電波の良い所でもう一度お試しください。';
/** 本文から文を読めないときの文 */
export const SESSIONS_UNKNOWN_ERROR_MESSAGE = '読み込みに失敗しました。時間をおいてもう一度お試しください。';

export interface SessionsClientError {
  readonly code: string;
  readonly message: string;
}
export type SessionsClientResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: SessionsClientError };

/** 失敗の本文 (§14 冒頭の flat の形 { error, code }) */
const FlatErrorBodySchema = z.object({ error: z.string().min(1).optional(), code: z.string().min(1).optional() });
const OkBodySchema = z.object({ ok: z.literal(true) });
const RevokeOthersBodySchema = z.object({ ok: z.literal(true), remaining: z.number().int().nonnegative() });

function errorOf(body: unknown): SessionsClientError {
  const parsed = FlatErrorBodySchema.safeParse(body);
  return {
    code: (parsed.success ? parsed.data.code : undefined) ?? SESSIONS_CLIENT_UNKNOWN_CODE,
    message: (parsed.success ? parsed.data.error : undefined) ?? SESSIONS_UNKNOWN_ERROR_MESSAGE,
  };
}

/**
 * API を 1 回呼び、2xx の本文を schema で読む。例外は投げない。
 * Cookie のセッションで呼ぶので credentials は same-origin、応答は本人だけのものなので cache は no-store
 */
async function requestSessionsApi<T>(path: string, method: 'GET' | 'POST' | 'DELETE', schema: z.ZodType<T>): Promise<SessionsClientResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return {
      ok: false,
      status: SESSIONS_CLIENT_NO_STATUS,
      error: { code: SESSIONS_CLIENT_NETWORK_ERROR, message: SESSIONS_NETWORK_ERROR_MESSAGE },
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, status: response.status, error: errorOf(body) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: response.status,
      error: { code: SESSIONS_CLIENT_UNKNOWN_CODE, message: SESSIONS_UNKNOWN_ERROR_MESSAGE },
    };
  }
  return { ok: true, data: parsed.data };
}

/** GET /api/auth/sessions (ログイン中の端末) */
export async function listSessions(): Promise<SessionsClientResult<SessionSummary[]>> {
  const result = await requestSessionsApi(SESSIONS_API_PATHS.sessions, 'GET', SessionsResponseSchema);
  return result.ok ? { ok: true, data: result.data.sessions } : result;
}

/** DELETE /api/auth/sessions/{id} (1 つの端末を失効させる) */
export async function revokeSession(sessionId: string): Promise<SessionsClientResult<{ ok: true }>> {
  return requestSessionsApi(sessionPath(sessionId), 'DELETE', OkBodySchema);
}

/** POST /api/auth/sessions/revoke-others (この端末以外をすべて) */
export async function revokeOtherSessions(): Promise<SessionsClientResult<{ ok: true; remaining: number }>> {
  return requestSessionsApi(SESSIONS_API_PATHS.revokeOthers, 'POST', RevokeOthersBodySchema);
}

/** GET /api/auth/login-history (最近のログイン) */
export async function listLoginHistory(): Promise<SessionsClientResult<LoginHistoryEntry[]>> {
  const result = await requestSessionsApi(SESSIONS_API_PATHS.loginHistory, 'GET', LoginHistoryResponseSchema);
  return result.ok ? { ok: true, data: result.data.entries } : result;
}
