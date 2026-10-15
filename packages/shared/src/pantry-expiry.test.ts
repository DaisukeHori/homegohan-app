/**
 * #1602: 食品の期限の判定 (classifyPantryExpiry) の境界。
 * 期限の日付は、今日 (2026-10-14) から手で数えた固定値 (実装の関数で求めない)。
 */
import { describe, expect, it } from 'vitest';
import { classifyPantryExpiry, PANTRY_EXPIRING_SOON_DAYS, pantryExpiringSoonUntil } from './pantry-expiry';

const TODAY = '2026-10-14';

describe('PANTRY_EXPIRING_SOON_DAYS', () => {
  it('「期限間近」は全画面で 3 日 (#1602)', () => {
    expect(PANTRY_EXPIRING_SOON_DAYS).toBe(3);
  });
});

describe('pantryExpiringSoonUntil', () => {
  it('今日から 3 日後の日付', () => {
    expect(pantryExpiringSoonUntil(TODAY)).toBe('2026-10-17');
  });

  it('月末・年末をまたぐ', () => {
    expect(pantryExpiringSoonUntil('2026-10-30')).toBe('2026-11-02');
    expect(pantryExpiringSoonUntil('2026-12-30')).toBe('2027-01-02');
  });
});

describe('classifyPantryExpiry', () => {
  it.each([
    ['昨日', '2026-10-13', 'expired'],
    ['1 年前', '2025-10-14', 'expired'],
    ['今日', '2026-10-14', 'expiringSoon'],
    ['明日', '2026-10-15', 'expiringSoon'],
    ['2 日後', '2026-10-16', 'expiringSoon'],
    ['3 日後', '2026-10-17', 'expiringSoon'],
    ['4 日後', '2026-10-18', 'normal'],
    ['30 日後', '2026-11-13', 'normal'],
  ] as const)('期限が%s (%s) → %s', (_label, date, expected) => {
    expect(classifyPantryExpiry(date, TODAY)).toBe(expected);
  });

  it('月をまたぐ境界 (今日 10-30: 11-02 = 期限間近 / 11-03 = それ以外 / 10-29 = 期限切れ)', () => {
    expect(classifyPantryExpiry('2026-11-02', '2026-10-30')).toBe('expiringSoon');
    expect(classifyPantryExpiry('2026-11-03', '2026-10-30')).toBe('normal');
    expect(classifyPantryExpiry('2026-10-29', '2026-10-30')).toBe('expired');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空文字', ''],
    ['日付でない文字列', 'あした'],
    ['存在しない日付', '2026-02-30'],
    ['時刻つき', '2026-10-14T00:00:00Z'],
    ['数値', 20261014],
  ])('期限が%sなら判定しない (normal)', (_label, value) => {
    expect(classifyPantryExpiry(value, TODAY)).toBe('normal');
  });
});
