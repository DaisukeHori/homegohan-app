/**
 * TOTP (Supabase の factor) の扱い (#1176。docs/design/cross/12-operator-mfa.md §12.4)
 *
 * 登録状態は Supabase の user.factors を見る (getUser() の戻りに入っていて、追加の I/O が無い。自前の表で二重に持たない §7.1)。
 */
import type { Factor, User } from '@supabase/supabase-js';

/** QR の発行者名 (認証アプリに出る)。文字列は固定 (環境で変えない) */
export const MFA_TOTP_ISSUER = 'ほめゴハン 運営';
/** factor の表示名 (1 人 1 factor なので固定) */
export const MFA_TOTP_FRIENDLY_NAME = 'authenticator';

/**
 * 画面が素の SVG (enroll の応答の qr_code_svg) に 1 回だけ前置して <img src> にする data URL の前置き (§15.2)。
 * auth-js の mfa.enroll も data.totp.qr_code にこの前置きを付けて返すので、route は toBareQrCodeSvg で外してから返す。
 */
export const MFA_QR_SVG_DATA_URL_PREFIX = 'data:image/svg+xml;utf-8,';

/**
 * auth-js の data.totp.qr_code を素の SVG にする (enroll の route の qr_code_svg §14.2)。
 * auth-js (@supabase/auth-js 2.105.3 の GoTrueClient._enroll) は Supabase の応答の SVG に MFA_QR_SVG_DATA_URL_PREFIX を
 * 前置して返す。そのまま返すと画面の前置きと 2 重になり、QR の画像が壊れる (#1707)。
 * 前置きが無い値 (auth-js が前置きをやめたとき) はそのまま返す。外すのは先頭の 1 回だけ。
 */
export function toBareQrCodeSvg(qrCode: string): string {
  return qrCode.startsWith(MFA_QR_SVG_DATA_URL_PREFIX) ? qrCode.slice(MFA_QR_SVG_DATA_URL_PREFIX.length) : qrCode;
}

export type VerifiedTotpFactor = Factor<'totp', 'verified'>;

function isTotp(factor: Factor): boolean {
  return factor.factor_type === 'totp';
}

/** verified な TOTP factor (Phase 1 は 1 人 1 個。複数あれば created_at が最も古いもの) */
export function findVerifiedTotpFactor(user: Pick<User, 'factors'>): VerifiedTotpFactor | null {
  const verified = (user.factors ?? []).filter(
    (f): f is VerifiedTotpFactor => isTotp(f) && f.status === 'verified',
  );
  return [...verified].sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
}

/** unverified な TOTP factor の id (enroll の前に消す対象) */
export function listUnverifiedTotpFactorIds(user: Pick<User, 'factors'>): string[] {
  return (user.factors ?? []).filter((f) => isTotp(f) && f.status === 'unverified').map((f) => f.id);
}

/** factor id が本人のものか (verified / unverified を問わない。verify の route が使う: 他人の factor id を送られても verify しない) */
export function ownsFactor(user: Pick<User, 'factors'>, factorId: string): boolean {
  return (user.factors ?? []).some((f) => f.id === factorId);
}

/**
 * factor id が本人の verified な TOTP factor か (解除 DELETE /factors/{id} の対象。§14.4)。
 * 本人の unverified な factor・TOTP でない factor・他人の factor は false (unverified な factor の掃除は enroll が受け持つ)
 */
export function isVerifiedTotpFactorId(user: Pick<User, 'factors'>, factorId: string): boolean {
  return (user.factors ?? []).some((f) => f.id === factorId && isTotp(f) && f.status === 'verified');
}
