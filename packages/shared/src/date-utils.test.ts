/**
 * date-utils ユニットテスト
 *
 * Refactor E (PR #908) で packages/shared に集約された純粋日付関数の初の unit test。
 */

import { describe, it, expect } from 'vitest';
import { formatLocalDate, todayLocal, parseLocalDate, addDays } from './date-utils';

describe('formatLocalDate', () => {
  it('UTC の真夜中直前 (23:59 JST = 14:59 UTC) を JST 当日として返す', () => {
    // 2024-03-15 14:59:59 UTC = 2024-03-15 23:59:59 JST → まだ 3/15
    const date = new Date('2024-03-15T14:59:59Z');
    expect(formatLocalDate(date, 'Asia/Tokyo')).toBe('2024-03-15');
  });

  it('UTC の日付変わり目直前 (23:59 UTC ≠ JST 翌日) を UTC ローカルとして正しく返す', () => {
    // 2024-03-15 00:00:00 UTC = 2024-03-15 09:00:00 JST
    const date = new Date('2024-03-15T00:00:00Z');
    expect(formatLocalDate(date, 'UTC')).toBe('2024-03-15');
  });

  it('JST と UTC でタイムゾーン跨ぎが発生する時刻を正しく区別する', () => {
    // 2024-03-15 15:30:00 UTC = 2024-03-16 00:30:00 JST → JST では翌日
    const date = new Date('2024-03-15T15:30:00Z');
    expect(formatLocalDate(date, 'Asia/Tokyo')).toBe('2024-03-16');
    expect(formatLocalDate(date, 'UTC')).toBe('2024-03-15');
  });

  it('デフォルトタイムゾーンが Asia/Tokyo であること', () => {
    // 明示的に Asia/Tokyo を指定した場合と同じ結果になる
    const date = new Date('2024-06-01T10:00:00Z');
    expect(formatLocalDate(date)).toBe(formatLocalDate(date, 'Asia/Tokyo'));
  });
});

describe('todayLocal', () => {
  it('YYYY-MM-DD 形式の文字列を返す', () => {
    const result = todayLocal();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('UTC タイムゾーンを指定すると UTC 日付を返す', () => {
    const utcResult = todayLocal('UTC');
    // UTC の今日を確認
    const expected = new Date().toLocaleDateString('sv-SE', { timeZone: 'UTC' });
    expect(utcResult).toBe(expected);
  });
});

describe('parseLocalDate', () => {
  it('YYYY-MM-DD 文字列を正しい Date オブジェクトに変換する', () => {
    const result = parseLocalDate('2024-03-15');
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(2); // 0-indexed: March = 2
    expect(result.getDate()).toBe(15);
  });

  it('月末日を正しくパースする', () => {
    const result = parseLocalDate('2024-02-29'); // 2024年はうるう年
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(1); // February = 1
    expect(result.getDate()).toBe(29);
  });

  it('1月1日をパースする', () => {
    const result = parseLocalDate('2024-01-01');
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(1);
  });

  it('年末日 12-31 をパースする', () => {
    const result = parseLocalDate('2023-12-31');
    expect(result.getFullYear()).toBe(2023);
    expect(result.getMonth()).toBe(11); // December = 11
    expect(result.getDate()).toBe(31);
  });
});

describe('addDays', () => {
  it('正の日数を加算する', () => {
    const base = new Date('2024-03-15T00:00:00');
    const result = addDays(base, 5);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(2);
    expect(result.getDate()).toBe(20);
  });

  it('月末を跨ぐ加算が正しく処理される', () => {
    const base = new Date('2024-01-29T00:00:00');
    const result = addDays(base, 3);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(1);
  });

  it('年末を跨ぐ加算が正しく処理される', () => {
    const base = new Date('2023-12-30T00:00:00');
    const result = addDays(base, 5);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(4);
  });

  it('負の日数（過去方向）の加算が正しく処理される', () => {
    const base = new Date('2024-03-01T00:00:00');
    const result = addDays(base, -1);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(29); // 2024はうるう年
  });

  it('0 日加算は元の Date と同じ日付を返す', () => {
    const base = new Date('2024-06-15T00:00:00');
    const result = addDays(base, 0);
    expect(result.getDate()).toBe(base.getDate());
    expect(result.getMonth()).toBe(base.getMonth());
    expect(result.getFullYear()).toBe(base.getFullYear());
  });

  it('元の Date オブジェクトを変更しない（immutable）', () => {
    const base = new Date('2024-03-15T00:00:00');
    const originalTime = base.getTime();
    addDays(base, 10);
    expect(base.getTime()).toBe(originalTime);
  });
});
