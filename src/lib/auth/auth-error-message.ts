/**
 * Supabase Auth (GoTrue) の失敗を Web の認証の画面 (新規登録・メール確認の再送・パスワードの再設定) に出す文 (#1917 の続き)
 *
 * 問題:
 *   画面が GoTrue の `error.message` ('Email rate limit exceeded'・'For security purposes, you can only request this after 60 seconds.'
 *   など) をそのまま、または「登録に失敗しました: <英文>」のように付け足して赤い帯に出していた。GoTrue の文は英語なので、
 *   失敗したときだけ英語が画面に出る (モバイルは apps/mobile/src/lib/api-error.ts の getJapaneseApiErrorMessage で固定の文にしている)。
 *
 * 決まり:
 *   - 回数の制限 (429・code が over_*_rate_limit・文が rate limit / For security purposes) は、ログインの画面と同じ
 *     「しばらくしてから再度お試しください」の案内にする
 *   - 文が日本語なら、そのまま出す (画面が自分で投げた日本語の文)
 *   - それ以外 (GoTrue・通信の英語の文) は、画面ごとの固定の文 (fallback) にする。元の文は呼び出し側が console に残す
 *   - CAPTCHA の確認で断られたとき (isCaptchaFailure) の文は、呼び出し側が先に CAPTCHA_FAILED_MESSAGE にする (今までどおり)
 */

/** 回数の制限で断られたときの文 (ログインの画面の「しばらくしてから再度お試しください」と同じ案内) */
export const AUTH_RATE_LIMITED_MESSAGE = '短い時間に続けて送られたため、受け付けられませんでした。しばらくしてから再度お試しください。';

/** HTTP 429 Too Many Requests (GoTrue が回数の制限で断ったときの状態) */
const HTTP_TOO_MANY_REQUESTS = 429;
/** GoTrue の回数の制限の code (over_email_send_rate_limit・over_request_rate_limit・over_sms_send_rate_limit) */
const RATE_LIMIT_CODE_PATTERN = /^over_[a-z_]*rate_limit$/;
/** GoTrue の回数の制限の英語の文 ('Email rate limit exceeded'・'For security purposes, you can only request this after 60 seconds.') */
const RATE_LIMIT_MESSAGE_PATTERN = /rate limit|for security purposes|too many requests/i;
/** 日本語の文字 (ひらがな・カタカナ・漢字・全角の記号) */
const JAPANESE_TEXT_PATTERN = /[぀-ヿ㐀-鿿＀-￯]/;

interface AuthErrorLike {
  message?: unknown;
  status?: unknown;
  code?: unknown;
}

/** GoTrue が回数の制限で断ったか */
export function isAuthRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { message, status, code } = error as AuthErrorLike;
  return (
    status === HTTP_TOO_MANY_REQUESTS ||
    (typeof code === 'string' && RATE_LIMIT_CODE_PATTERN.test(code)) ||
    (typeof message === 'string' && RATE_LIMIT_MESSAGE_PATTERN.test(message))
  );
}

/**
 * Supabase Auth の失敗 (返り値の error・投げられた例外) を、画面に出す日本語の文にする。
 * 回数の制限は AUTH_RATE_LIMITED_MESSAGE、日本語の文はそのまま、それ以外は fallback
 */
export function authErrorMessageForDisplay(error: unknown, fallback: string): string {
  if (isAuthRateLimited(error)) return AUTH_RATE_LIMITED_MESSAGE;
  const message = typeof error === 'object' && error !== null ? (error as AuthErrorLike).message : undefined;
  return typeof message === 'string' && JAPANESE_TEXT_PATTERN.test(message) ? message : fallback;
}
