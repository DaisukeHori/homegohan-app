/**
 * ログイン中のパスワード変更・メールアドレス変更 (#1187) で、Supabase Auth が返したエラーを利用者向けの日本語に直す。
 *
 * モバイルの設定画面でも同じ文言を使うため、本体を packages/shared (account-change-errors.ts) へ移した。
 * このファイルは、Web の既存の import 先を変えずに済むよう、そこを読み直すだけの入口。
 */

export {
  describeEmailChangeError,
  describePasswordChangeError,
  isNetworkAuthError,
  isRateLimitAuthError,
  isSessionExpiredAuthError,
  type AuthErrorLike,
} from '@homegohan/shared';
