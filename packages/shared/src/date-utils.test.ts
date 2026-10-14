/**
 * date-utils ユニットテスト
 *
 * Refactor E (PR #908) で packages/shared に集約された純粋日付関数の初の unit test。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatLocalDate, todayLocal, parseLocalDate, addDays, daysUntilLocal, formatExpiry, formatDateJa } from './date-utils';

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

describe('daysUntilLocal (#1053)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('JST 今日と同じ日付なら 0 を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T01:00:00Z')); // JST 2026-07-08 10:00
    expect(daysUntilLocal('2026-07-08')).toBe(0);
  });

  it('未来日は正の残日数を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T01:00:00Z'));
    expect(daysUntilLocal('2026-07-11')).toBe(3);
  });

  it('過去日は負の残日数を返す（期限切れ）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T01:00:00Z'));
    expect(daysUntilLocal('2026-07-05')).toBe(-3);
  });

  it('null/undefined は null を返す', () => {
    expect(daysUntilLocal(null)).toBeNull();
    expect(daysUntilLocal(undefined)).toBeNull();
  });

  it('UTC 環境で TZ=UTC ランタイムでも JST 早朝の「今日」を正しく 0 と判定する（#1035 と同種のズレ回帰防止）', () => {
    vi.useFakeTimers();
    // JST 2026-07-08 06:00 = UTC 2026-07-07 21:00。UTC 基準の new Date() 比較だと前日扱いになりうる境界。
    vi.setSystemTime(new Date('2026-07-07T21:00:00Z'));
    expect(daysUntilLocal('2026-07-08', 'Asia/Tokyo')).toBe(0);
  });
});

describe('formatExpiry (#1053)', () => {
  it('null は空文字を返す', () => {
    expect(formatExpiry(null)).toBe('');
  });

  it('負の日数は「期限切れ」を返す', () => {
    expect(formatExpiry(-1)).toBe('期限切れ');
  });

  it('0 は「今日まで」を返す', () => {
    expect(formatExpiry(0)).toBe('今日まで');
  });

  it('1 は「明日まで」を返す', () => {
    expect(formatExpiry(1)).toBe('明日まで');
  });

  it('2以上は「あとN日」を返す', () => {
    expect(formatExpiry(5)).toBe('あと5日');
  });
});

describe('formatDateJa (#1053)', () => {
  it('デフォルト（年なし）で「M月D日」を返す', () => {
    expect(formatDateJa('2026-07-08')).toBe('7月8日');
  });

  it('includeYear: true で「YYYY年M月D日」を返す', () => {
    expect(formatDateJa('2026-07-08', { includeYear: true })).toBe('2026年7月8日');
  });
});
