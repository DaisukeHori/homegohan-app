import { describe, expect, it } from 'vitest';
import { clampIntParam } from '../src/lib/http-params';

/**
 * #1048 F2-16: クエリの NaN・不正日付で未処理例外500 / limit 未クランプ の回帰テスト。
 */
describe('clampIntParam', () => {
  it('returns the default when the param is missing', () => {
    expect(clampIntParam(null, { min: 1, max: 90, default: 7 })).toBe(7);
    expect(clampIntParam(undefined, { min: 1, max: 90, default: 7 })).toBe(7);
    expect(clampIntParam('', { min: 1, max: 90, default: 7 })).toBe(7);
  });

  it('falls back to the default instead of throwing on non-numeric input (e.g. days=abc)', () => {
    expect(clampIntParam('abc', { min: 1, max: 90, default: 7 })).toBe(7);
    expect(() => clampIntParam('abc', { min: 1, max: 90, default: 7 })).not.toThrow();
  });

  it('rejects loosely-numeric strings that parseInt would have accepted (e.g. "20abc")', () => {
    // parseInt("20abc") === 20 (permissive); Number("20abc") === NaN (strict).
    // ここでは NaN 扱い→デフォルトへのフォールバックになることを確認する。
    expect(clampIntParam('20abc', { min: 1, max: 90, default: 7 })).toBe(7);
  });

  it('clamps values below the minimum', () => {
    expect(clampIntParam('0', { min: 1, max: 90, default: 7 })).toBe(1);
    expect(clampIntParam('-5', { min: 1, max: 90, default: 7 })).toBe(1);
  });

  it('clamps values above the maximum (DoS 防止)', () => {
    expect(clampIntParam('99999', { min: 1, max: 400, default: 30 })).toBe(400);
  });

  it('accepts valid in-range values', () => {
    expect(clampIntParam('365', { min: 1, max: 400, default: 30 })).toBe(365);
    expect(clampIntParam('30', { min: 1, max: 90, default: 7 })).toBe(30);
  });

  it('truncates non-integer numeric input', () => {
    expect(clampIntParam('7.9', { min: 1, max: 90, default: 7 })).toBe(7);
  });

  it('rejects Infinity / -Infinity safely', () => {
    expect(clampIntParam('Infinity', { min: 1, max: 90, default: 7 })).toBe(7);
    expect(clampIntParam('-Infinity', { min: 1, max: 90, default: 7 })).toBe(7);
  });
});
