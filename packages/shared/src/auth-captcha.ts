/**
 * Supabase Auth の CAPTCHA (Cloudflare Turnstile) に断られたときの判定と文言 (#1165 / #1474)
 *
 * Web (src/lib/auth/turnstile.ts) とモバイル (apps/mobile/src/lib/turnstile.ts) で同じ値を使うため、置き場をここにまとめた (#1187)。
 * 両方のファイルは、ここを読み直して公開している。
 */

/** Supabase Auth が CAPTCHA の確認を断ったときの、利用者向けの文言 */
export const CAPTCHA_FAILED_MESSAGE = 'ボットではないことの確認に失敗しました。もう一度お試しください。';

/**
 * Supabase Auth のエラーが「CAPTCHA の確認に失敗した」ものか。
 * Supabase 側で CAPTCHA を有効にしたあとで、トークンが無い・期限切れ・使用済みのときに返る
 * (error.code が captcha_failed、message が "captcha verification process failed" など)。
 */
export function isCaptchaFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === 'captcha_failed') return true;
  return typeof message === 'string' && /captcha/i.test(message);
}
