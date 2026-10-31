/**
 * 403 の本文の文のうち、ロールが足りないのとは別の理由 (二段階認証の未完了・凍結) を伝える日本語の固定の文 (#1917)
 *
 * サーバー (src/lib/api/error-responses.ts の 403 の既定の表・operatorForbiddenMessageOf) と、
 * 運営の画面 (src/lib/admin/api-error-message.ts の forbiddenMessageForScreen) の両方が読む。
 * 画面の bundle に next/server を入れないよう、ほかを import しないこのファイルに置く。
 */

/** 403: アカウントが凍結されている (AUTH_ACCOUNT_FROZEN。src/lib/auth/helpers.ts の assertNotFrozen と同じ文) */
export const API_ACCOUNT_FROZEN_MESSAGE = 'アカウントが凍結されています';
/** 403: 二段階認証の確認が要る (AUTH_2FA_REQUIRED。src/lib/auth/mfa/assurance.ts と同じ文) */
export const API_MFA_REQUIRED_MESSAGE = '二段階認証の確認が必要です';
/** 403: 二段階認証の登録が要る (AUTH_2FA_ENROLLMENT_REQUIRED。src/lib/auth/mfa/assurance.ts と同じ文) */
export const API_MFA_ENROLLMENT_REQUIRED_MESSAGE = '二段階認証の登録が必要です';

/**
 * 403 の理由の文の集合。画面は 403 の本文の文がこのどれかなら、画面の固定の文 (「権限がありません」など) の代わりにその文を出す
 * (ゲートの後でセッションの状態が変わったとき、二段階認証が要るのに権限が無いように見せないため)
 */
export const FORBIDDEN_REASON_MESSAGES: ReadonlySet<string> = new Set([
  API_ACCOUNT_FROZEN_MESSAGE,
  API_MFA_REQUIRED_MESSAGE,
  API_MFA_ENROLLMENT_REQUIRED_MESSAGE,
]);

/**
 * 403 の理由の文 → その理由の code (サーバーの 403 の既定の表 (src/lib/api/error-responses.ts の DEFAULT_FORBIDDEN_MESSAGES) と同じ組)。
 * 本文の code だけを読む画面 (手動のプラン付与。src/lib/billing/manual-grant-client.ts) が、運営の route の 403
 * (code は OP_PERMISSION_DENIED のまま、文だけが理由の文) の理由を code に直して固定の文を引くために使う (#2086 V4)。
 * 表に無い文 (ロールが足りない・英字の内部の文など) は理由として扱わない
 */
export const FORBIDDEN_REASON_CODE_BY_MESSAGE: ReadonlyMap<string, string> = new Map([
  [API_ACCOUNT_FROZEN_MESSAGE, 'AUTH_ACCOUNT_FROZEN'],
  [API_MFA_REQUIRED_MESSAGE, 'AUTH_2FA_REQUIRED'],
  [API_MFA_ENROLLMENT_REQUIRED_MESSAGE, 'AUTH_2FA_ENROLLMENT_REQUIRED'],
]);
