import { describe, expect, it } from 'vitest';
import { clampIntParam, isUuid, readJsonBody } from '../src/lib/http-params';

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

/**
 * #1161: uuid 型の列に UUID でない文字列を渡すと PostgREST が 22P02 で失敗し、「存在しない id」(404) のはずが
 * 500 になる。DB に渡す前に弾くための形式チェック。
 */
describe('isUuid', () => {
  it('accepts UUID-shaped strings (case-insensitive, version/variant bits are not checked)', () => {
    expect(isUuid('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBe(true);
    expect(isUuid('0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['not a uuid', 'not-a-uuid'],
    ['too short', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc'],
    ['too long', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc0'],
    ['missing hyphens', 'cccccccccccc4ccc8cccCCCCCCCCCCCC'],
    ['non-hex characters', 'gggggggg-gggg-4ggg-8ggg-gggggggggggg'],
    ['surrounding whitespace', ' cccccccc-cccc-4ccc-8ccc-cccccccccccc '],
    ['trailing newline', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc\n'],
    ['SQL-ish payload', "x' or '1'='1"],
  ])('rejects %s', (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])).toBe(false);
  });
});

describe('readJsonBody', () => {
  const post = (body: string) => new Request('http://localhost/x', { method: 'POST', body });

  it('returns the parsed body', async () => {
    expect(await readJsonBody(post('{"a":1}'))).toEqual({ ok: true, body: { a: 1 } });
    expect(await readJsonBody(post('null'))).toEqual({ ok: true, body: null });
  });

  it('does not throw on a broken body: returns { ok: false } so the caller can answer 400 instead of 500', async () => {
    expect(await readJsonBody(post('{ not json'))).toEqual({ ok: false });
    expect(await readJsonBody(post(''))).toEqual({ ok: false });
  });

  it('does not throw when json() itself rejects', async () => {
    expect(await readJsonBody({ json: () => Promise.reject(new Error('stream already read')) })).toEqual({ ok: false });
  });
});
