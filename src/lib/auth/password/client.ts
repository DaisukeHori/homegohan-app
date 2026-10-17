/**
 * パスワードの変更・再設定の画面 (Web の /settings/account・/auth/reset-password) の通信の薄い包み (#1198)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §15 (Web の通信)・§14.6・§14.7。
 *
 * React に依存しない。fetch を 1 回呼び、結果を判別共用体 PasswordClientResult で返す (例外を投げない)。
 * 失敗は { code, message } に正規化する: 4xx / 5xx は本文の code と error (route が §19 の固定の文か internalError の共通の文で作る。
 * GoTrue・DB の生の英文は入らない)。本文を読めなければ code = UNKNOWN・message = null。通信の失敗 (fetch の reject) は
 * code = NETWORK_ERROR と通信の文。画面は describePasswordChangeApiError(code, message) で文言を決める。
 * 戻り値・例外にパスワードを含めない (要求の本文は呼び出しの中だけ)。
 *
 * ⚠️ client component ("use client") が import するので、サーバー専用のもの (next/headers・@/lib/supabase/server) を import しない。
 */
import { z } from 'zod';

/** §14 の API のパス。画面はこれ以外の URL を組み立てない */
export const PASSWORD_API_PATHS = {
  change: '/api/auth/password/change',
  reset: '/api/auth/password/reset',
} as const;

/** HTTP の応答として扱えなかった (fetch が例外を投げた) ときの status。HTTP のステータスに 0 は無い */
export const PASSWORD_CLIENT_NO_STATUS = 0;
/** 通信の失敗 (fetch の reject) の code */
export const PASSWORD_CLIENT_NETWORK_ERROR = 'NETWORK_ERROR';
/** 失敗の本文から code を読めないときの code */
export const PASSWORD_CLIENT_UNKNOWN_CODE = 'UNKNOWN';
/** 通信の失敗の文 (account-errors の通信の文と同じ趣旨) */
export const PASSWORD_NETWORK_ERROR_MESSAGE = '通信に失敗しました。ネットワークの状態を確認して、もう一度お試しください。';

export interface PasswordClientError {
  readonly code: string;
  /** 本文の error (route の固定の文)。読めなければ null (画面は code から文言を決める) */
  readonly message: string | null;
}
export type PasswordClientResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly error: PasswordClientError };

/** 失敗の本文 (§14 冒頭の flat の形 { error, code }) */
const FlatErrorBodySchema = z.object({ error: z.string().min(1).optional(), code: z.string().min(1).optional() });
const OkBodySchema = z.object({ ok: z.literal(true) });

function errorOf(body: unknown): PasswordClientError {
  const parsed = FlatErrorBodySchema.safeParse(body);
  return {
    code: (parsed.success ? parsed.data.code : undefined) ?? PASSWORD_CLIENT_UNKNOWN_CODE,
    message: (parsed.success ? parsed.data.error : undefined) ?? null,
  };
}

/** POST を 1 回呼ぶ。Cookie のセッションで呼ぶので credentials は same-origin、応答は本人だけのものなので cache は no-store */
async function postPasswordApi(path: string, requestBody: Record<string, string>): Promise<PasswordClientResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch {
    return {
      ok: false,
      status: PASSWORD_CLIENT_NO_STATUS,
      error: { code: PASSWORD_CLIENT_NETWORK_ERROR, message: PASSWORD_NETWORK_ERROR_MESSAGE },
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, status: response.status, error: errorOf(body) };
  // 2xx なのに { ok: true } でない本文は成功と見なさない (生の本文は出さない)
  if (!OkBodySchema.safeParse(body).success) {
    return { ok: false, status: response.status, error: { code: PASSWORD_CLIENT_UNKNOWN_CODE, message: null } };
  }
  return { ok: true };
}

/** POST /api/auth/password/change (ログイン中のパスワードの変更) */
export async function changePassword(body: { current_password: string; new_password: string }): Promise<PasswordClientResult> {
  return postPasswordApi(PASSWORD_API_PATHS.change, { current_password: body.current_password, new_password: body.new_password });
}

/** POST /api/auth/password/reset (再設定メールのリンクで作ったセッションでの再設定) */
export async function resetPassword(body: { new_password: string }): Promise<PasswordClientResult> {
  return postPasswordApi(PASSWORD_API_PATHS.reset, { new_password: body.new_password });
}
