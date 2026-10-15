/**
 * #1176 TOTP (Supabase の factor) の扱いのテスト。docs/design/cross/12-operator-mfa.md §12.4・§21.1 (mfa-factors.test.ts)
 */
import type { Factor } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  MFA_QR_SVG_DATA_URL_PREFIX,
  MFA_TOTP_FRIENDLY_NAME,
  MFA_TOTP_ISSUER,
  findVerifiedTotpFactor,
  isVerifiedTotpFactorId,
  listUnverifiedTotpFactorIds,
  ownsFactor,
  toBareQrCodeSvg,
} from '@/lib/auth/mfa/factors';

function factor(id: string, factorType: 'totp' | 'phone', status: 'verified' | 'unverified', createdAt: string): Factor {
  return {
    id,
    friendly_name: MFA_TOTP_FRIENDLY_NAME,
    factor_type: factorType,
    status,
    created_at: createdAt,
    updated_at: createdAt,
  } as Factor;
}

const OLD_TOTP = factor('totp-old', 'totp', 'verified', '2026-01-01T00:00:00Z');
const NEW_TOTP = factor('totp-new', 'totp', 'verified', '2026-06-01T00:00:00Z');
const UNVERIFIED_TOTP = factor('totp-unverified', 'totp', 'unverified', '2026-07-01T00:00:00Z');
const UNVERIFIED_TOTP_2 = factor('totp-unverified-2', 'totp', 'unverified', '2026-07-02T00:00:00Z');
const PHONE = factor('phone-1', 'phone', 'verified', '2025-01-01T00:00:00Z');
const UNVERIFIED_PHONE = factor('phone-2', 'phone', 'unverified', '2025-02-01T00:00:00Z');

describe('factors', () => {
  it('定数: 発行者名と表示名は固定', () => {
    expect(MFA_TOTP_ISSUER).toBe('ほめゴハン 運営');
    expect(MFA_TOTP_FRIENDLY_NAME).toBe('authenticator');
  });

  it('findVerifiedTotpFactor は verified な totp だけを返す (unverified / phone は無視。複数なら最古)', () => {
    expect(findVerifiedTotpFactor({ factors: [NEW_TOTP, PHONE, OLD_TOTP, UNVERIFIED_TOTP] })?.id).toBe('totp-old');
    expect(findVerifiedTotpFactor({ factors: [UNVERIFIED_TOTP, PHONE] })).toBeNull();
    expect(findVerifiedTotpFactor({ factors: [] })).toBeNull();
    expect(findVerifiedTotpFactor({ factors: undefined })).toBeNull();
  });

  it('listUnverifiedTotpFactorIds / ownsFactor', () => {
    expect(listUnverifiedTotpFactorIds({ factors: [OLD_TOTP, UNVERIFIED_TOTP, UNVERIFIED_PHONE, UNVERIFIED_TOTP_2] })).toEqual([
      'totp-unverified',
      'totp-unverified-2',
    ]);
    expect(listUnverifiedTotpFactorIds({ factors: undefined })).toEqual([]);
    const user = { factors: [OLD_TOTP, UNVERIFIED_TOTP, PHONE] };
    expect(ownsFactor(user, 'totp-old')).toBe(true);
    expect(ownsFactor(user, 'totp-unverified')).toBe(true);
    expect(ownsFactor(user, 'phone-1')).toBe(true);
    expect(ownsFactor(user, 'someone-else')).toBe(false);
    expect(ownsFactor({ factors: undefined }, 'totp-old')).toBe(false);
  });

  it('isVerifiedTotpFactorId は本人の verified な totp の id だけ true (本人の unverified な totp・phone・他人の id・存在しない id は false)', () => {
    const user = { factors: [OLD_TOTP, UNVERIFIED_TOTP, PHONE] };
    expect(isVerifiedTotpFactorId(user, 'totp-old')).toBe(true);
    expect(isVerifiedTotpFactorId(user, 'totp-unverified')).toBe(false);
    expect(isVerifiedTotpFactorId(user, 'phone-1')).toBe(false);
    expect(isVerifiedTotpFactorId(user, 'totp-new')).toBe(false);
    expect(isVerifiedTotpFactorId(user, 'missing')).toBe(false);
    expect(isVerifiedTotpFactorId({ factors: undefined }, 'totp-old')).toBe(false);
  });

  it('toBareQrCodeSvg は auth-js が付けた data URL の前置きを先頭から 1 回だけ外す (前置きの無い値はそのまま #1707)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    expect(MFA_QR_SVG_DATA_URL_PREFIX).toBe('data:image/svg+xml;utf-8,');
    // auth-js 2.105.3 の mfa.enroll が返す形
    expect(toBareQrCodeSvg(`data:image/svg+xml;utf-8,${svg}`)).toBe(svg);
    expect(toBareQrCodeSvg(svg)).toBe(svg);
    // 先頭でない位置の同じ文字列は外さない
    expect(toBareQrCodeSvg(`${svg}data:image/svg+xml;utf-8,`)).toBe(`${svg}data:image/svg+xml;utf-8,`);
    // 画面が前置きを 1 回足すと、前置きはちょうど 1 回になる
    const src = `${MFA_QR_SVG_DATA_URL_PREFIX}${toBareQrCodeSvg(`data:image/svg+xml;utf-8,${svg}`)}`;
    expect(src.split('data:image/svg+xml;utf-8,').length - 1).toBe(1);
  });
});
