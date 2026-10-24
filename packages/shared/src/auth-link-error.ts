/**
 * 認証の戻り (OAuth の戻り・メールの確認や再設定のリンク) が、エラーを運んで戻ったときに利用者へ出す文 (Web とモバイルで同じもの。#1917 の続き)
 *
 * Supabase Auth (GoTrue) や provider (Google など) は、戻り先の URL に ?error= / #error= と英語の説明 (error_description) を付ける
 * ('Email link is invalid or has expired'・'User denied access' など)。以前は Apple 以外ではこの英文をそのまま画面に出していた。
 * 画面には provider に関わらずこの固定の文を出し、英文はログ (console) にだけ残す。
 *   - Web: /auth/callback (src/app/(auth)/auth/callback/route.ts) と /auth/link-notice (src/lib/auth/link-notice.ts) が
 *     /login?error= に渡す。Apple だけはより詳しい固定の文 (src/lib/auth/apple/web-callback.ts の APPLE_WEB_CALLBACK_ERROR_MESSAGE)
 *   - モバイル: apps/mobile/src/lib/authLink.ts (link_error) と apps/mobile/app/(auth)/auth/reset-password.tsx
 * ログイン画面 (src/app/(auth)/login/page.tsx) は ?error= の値をもう 1 回 decodeURIComponent してから出すので、% を含めない
 */
export const AUTH_LINK_ERROR_MESSAGE =
  'ログインの手続きを完了できませんでした。メールのリンクから開いた場合は、リンクの期限が切れている可能性があります。もう一度お試しください。';

/** モバイルで、リンクの code の交換・OTP の確認・setSession が失敗したときに出す文 (例外の文が日本語でないとき。apps/mobile/src/lib/authLink.ts) */
export const AUTH_LINK_FAILED_MESSAGE = '確認に失敗しました。';
