/**
 * ログイン画面から POST /api/auth/login を呼ぶ部品 (#1165)。ブラウザで使う (React には依存しない)。
 *
 * 応答の code ごとの意味は src/app/api/auth/login/route.ts の先頭のコメント。
 * 画面に出す文言は loginErrorMessage が決める (サーバーの文言を基本にし、無ければ code ごとの既定の文言)。
 * ログインに続けて失敗しても、アカウントはロックしない (docs/operations/auth-protection.md §1)。ロックの応答 (423) は無い。
 */

export const LOGIN_API_PATH = '/api/auth/login';

export type LoginErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_CAPTCHA_FAILED'
  | 'AUTH_CAPTCHA_UNAVAILABLE'
  | 'AUTH_EMAIL_NOT_CONFIRMED'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN';

const KNOWN_CODES: ReadonlySet<string> = new Set<LoginErrorCode>([
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_CAPTCHA_FAILED',
  'AUTH_CAPTCHA_UNAVAILABLE',
  'AUTH_EMAIL_NOT_CONFIRMED',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
]);

export type LoginOutcome =
  | { ok: true }
  | {
      ok: false;
      code: LoginErrorCode;
      /** サーバーが返した利用者向けの文言 (無ければ null) */
      message: string | null;
      /** 回数制限が外れるまでの秒数 (無ければ null) */
      retryAfterSec: number | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** POST /api/auth/login を呼ぶ。通信の失敗は例外のまま投げる (画面が「予期せぬエラー」を出す) */
export async function requestLogin(input: {
  email: string;
  password: string;
  captchaToken: string | null;
}): Promise<LoginOutcome> {
  const response = await fetch(LOGIN_API_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      // Turnstile が無効のときはトークンを付けない
      ...(input.captchaToken ? { captchaToken: input.captchaToken } : {}),
    }),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok && isRecord(body) && body.ok === true) return { ok: true };

  const rawCode = isRecord(body) && typeof body.code === 'string' ? body.code : '';
  const code: LoginErrorCode = KNOWN_CODES.has(rawCode) ? (rawCode as LoginErrorCode) : 'UNKNOWN';
  const message = isRecord(body) && typeof body.error === 'string' && body.error.trim() ? body.error : null;
  const retryAfter = isRecord(body) ? body.retryAfter : undefined;
  const retryAfterSec = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  return { ok: false, code, message, retryAfterSec };
}

const FALLBACK_MESSAGES: Record<LoginErrorCode, string> = {
  AUTH_INVALID_CREDENTIALS: 'メールアドレスまたはパスワードが正しくありません。',
  AUTH_CAPTCHA_FAILED: 'ボットではないことの確認に失敗しました。もう一度お試しください。',
  AUTH_CAPTCHA_UNAVAILABLE: 'ボットではないことの確認を、いま行えません。しばらくしてから再度お試しください。',
  AUTH_EMAIL_NOT_CONFIRMED: 'メールアドレスが確認されていません。確認メールをご確認ください。',
  RATE_LIMITED: 'しばらくしてから再度お試しください。',
  VALIDATION_ERROR: 'メールアドレスとパスワードを入力してください。',
  UNKNOWN: 'ログインに失敗しました。しばらくしてからお試しください。',
};

/** 画面に出すエラーの文言 */
export function loginErrorMessage(outcome: Extract<LoginOutcome, { ok: false }>): string {
  return outcome.message ?? FALLBACK_MESSAGES[outcome.code];
}
