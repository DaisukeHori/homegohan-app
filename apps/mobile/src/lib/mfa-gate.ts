/**
 * 運営ロールの MFA (二段階認証) — アプリの確認画面の判定 (純関数。#1176 / #1707 段 D)
 *
 * 正典: docs/design/cross/12-operator-mfa.md §16.1。
 * アプリで運営が通る経路は、WebView で開く Web の運営画面だけ (ネイティブの運営の区画は #1598 で削除した)。
 * ネイティブの確認画面 (NativeMfaVerifyModal) を開くのは、WebView の中の Web のゲートが challenge_required と判定して
 * verify の画面へ回し、その画面が mfa-verify-required を送ったときだけ。ロールと猶予の判定は Web のゲートで済んでいるので、
 * ここでは読まない (Web の MFA_REQUIRED_ROLES の写しも持たない)。
 */

export type MobileAal = 'aal1' | 'aal2';

export type MobileOperatorGate = 'allow' | 'verify' | 'enroll_on_web';

/** ネイティブのセッションの AAL (auth.mfa.getAuthenticatorAssuranceLevel の値を toMobileAal で直したもの)。ロールは持たない (§16) */
export interface MobileOperatorGateInput {
  readonly currentLevel: MobileAal | null;
  readonly nextLevel: MobileAal | null;
}

/**
 * 未登録のときの案内 (MfaVerifyGate・NativeMfaVerifyModal が出す文)。
 * 登録はアプリの中 (WebView を含む) ではできない (§16.4) ので、アプリの外のブラウザへ案内する
 */
export const MOBILE_MFA_ENROLL_ON_WEB_MESSAGE =
  '二段階認証の登録は、ブラウザ (Safari・Chrome・パソコンなど。アプリの中では登録できません) で、ほめゴハンの「設定 → セキュリティ (二段階認証)」から行ってください。登録すると、この画面も使えるようになります。';

/** 認証アプリの 6 桁 (Web の TOTP_CODE_PATTERN と同じ) */
export const MOBILE_TOTP_CODE_PATTERN = /^\d{6}$/;

/** auth-js の AAL の値を、このファイルの型にする (aal1 / aal2 以外と null は null) */
export function toMobileAal(level: string | null | undefined): MobileAal | null {
  if (level === 'aal1' || level === 'aal2') return level;
  return null;
}

/**
 * WebView から頼まれた確認 (§16.4) をどう扱うか。ロールと猶予は読まない (頼んだ Web のゲートが判定済み §16)。
 *   currentLevel が aal2    → allow (ネイティブのセッションは既に aal2。WebView の Cookie だけが古い)
 *   nextLevel が aal2       → verify (verified な factor がある)
 *   それ以外                → enroll_on_web (verified な factor が無い)
 */
export function decideMobileOperatorGate(input: MobileOperatorGateInput): MobileOperatorGate {
  if (input.currentLevel === 'aal2') return 'allow';
  if (input.nextLevel === 'aal2') return 'verify';
  return 'enroll_on_web';
}
