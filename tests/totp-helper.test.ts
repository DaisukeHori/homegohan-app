// @vitest-environment node
/**
 * #1176 テストの道具の TOTP (tests/helpers/totp.ts と tests/e2e/helpers/totp.mjs) が、RFC 6238 Appendix B の値を出し、
 * 2 つが同じ値を出すことを確かめる。docs/design/cross/12-operator-mfa.md §21.3 (totp-helper.test.ts)
 *
 * RFC 6238 Appendix B (SHA-1・秘密 "12345678901234567890"・30 秒): T=59 → 8 桁 94287082・T=1111111109 → 07081804。
 * Supabase の TOTP は 6 桁なので下 6 桁 (287082・081804)。
 */
import { describe, expect, it } from 'vitest';
import * as tsTotp from './helpers/totp';
import * as mjsTotp from './e2e/helpers/totp.mjs';

/** "12345678901234567890" (ASCII) の base32 */
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS: ReadonlyArray<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

const implementations = [
  ['tests/helpers/totp.ts', tsTotp],
  ['tests/e2e/helpers/totp.mjs', mjsTotp],
] as const;

describe('テストの道具の TOTP', () => {
  for (const [name, impl] of implementations) {
    it(`${name}: RFC 6238 Appendix B (SHA-1) の 6 桁を出す`, () => {
      for (const [at, expected] of RFC_VECTORS) {
        expect(impl.generateTotp(RFC_SECRET_BASE32, at), `T=${at}`).toBe(expected);
      }
    });

    it(`${name}: base32 の復号 (小文字・空白・= を許し、字母の外は例外)`, () => {
      expect(impl.decodeBase32(RFC_SECRET_BASE32).toString('ascii')).toBe('12345678901234567890');
      expect(impl.decodeBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq====').toString('ascii')).toBe('12345678901234567890');
      expect(impl.decodeBase32('MZXW6YTBOI').toString('ascii')).toBe('foobar');
      expect(() => impl.decodeBase32('ABC1')).toThrow();
    });

    it(`${name}: 定数は 30 秒・6 桁で、同じ 30 秒の窓の中は同じコード・次の窓で変わる`, () => {
      expect(impl.TOTP_STEP_SECONDS).toBe(30);
      expect(impl.TOTP_DIGITS).toBe(6);
      expect(impl.generateTotp(RFC_SECRET_BASE32, 60)).toBe(impl.generateTotp(RFC_SECRET_BASE32, 89));
      expect(impl.generateTotp(RFC_SECRET_BASE32, 59)).not.toBe(impl.generateTotp(RFC_SECRET_BASE32, 60));
    });
  }

  it('2 つの実装は同じ secret・時刻で同じ 6 桁を出す', () => {
    const secrets = [RFC_SECRET_BASE32, 'JBSWY3DPEHPK3PXP', 'MZXW6YTBOI'];
    for (const secret of secrets) {
      for (let at = 0; at < 3000; at += 97) {
        expect(mjsTotp.generateTotp(secret, at), `${secret} T=${at}`).toBe(tsTotp.generateTotp(secret, at));
      }
    }
    const now = Date.now() / 1000;
    expect(mjsTotp.generateTotp(RFC_SECRET_BASE32, now)).toBe(tsTotp.generateTotp(RFC_SECRET_BASE32, now));
  });
});
