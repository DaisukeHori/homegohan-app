// @vitest-environment node
/**
 * #2259 P2 献立表 (/menus/weekly) の月のカレンダーの印を読む月の鍵 (monthKeysBetween) の回帰テスト。
 *
 * 問題 (直す前): 月の鍵 (monthKeyOf) は年を getFullYear() のまま書き、1000 年より前の月を '101-01' と書いた
 *   (#2254 M2 で献立表の addDaysStr を直したのと同じ形の取り残し)。?date=0101-01-10 の週を開くと、読んだ月の覚え
 *   (page.tsx の fetchedMonthsRef) と取り直しの置き場所の鍵 (mealDatesKey) が 'YYYY-MM' の形にならなかった。
 * 直したあと: 年は formatCalendarDate と同じく 0 埋めの 4 桁 ('0101-01')。
 *
 * 範囲の計算は page.tsx の weekWindowOf / monthWindowOf と同じ日数 (週の始まりの 14 日前〜28 日後・月の初日の 7 日前〜末日の 7 日後)。
 * 直す前の形で赤になる。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { monthKeysBetween } from '@/app/(main)/menus/weekly/_state/calendarMonthKeys';
import { parseLocalDate } from '@homegohan/shared';

/** 'YYYY-MM' (4 桁の年・2 桁の月) */
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

/** 実行環境のタイムゾーン (端末の 0 時の Date を端末の暦で読むので、どの地域でも同じ鍵になる) */
const RUNTIME_TIME_ZONES = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'] as const;

describe('月の鍵は年を 0 埋めの 4 桁で書く (#2259 P2)', () => {
  const originalTimeZone = process.env.TZ;
  afterEach(() => {
    // 元が未設定なら消す (undefined を入れると文字列 "undefined" になる)
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  for (const timeZone of RUNTIME_TIME_ZONES) {
    it(`${timeZone}: ?date=0101-01-10 の週の窓 (0100-12-27〜0101-02-07) の月の鍵は '0100-12'・'0101-01'・'0101-02' (直す前は '100-12'・'101-01'・'101-02')`, () => {
      process.env.TZ = timeZone;
      const keys = monthKeysBetween(parseLocalDate('0100-12-27'), parseLocalDate('0101-02-07'));
      expect(keys).toEqual(['0100-12', '0101-01', '0101-02']);
      for (const key of keys) expect(key).toMatch(MONTH_KEY_PATTERN);
    });
  }

  it('月の窓 (0100-12-25〜0101-02-07) も同じ鍵', () => {
    expect(monthKeysBetween(parseLocalDate('0100-12-25'), parseLocalDate('0101-02-07'))).toEqual(['0100-12', '0101-01', '0101-02']);
  });

  it('999 年と 1000 年の境目 (直す前は "999-12")', () => {
    expect(monthKeysBetween(parseLocalDate('0999-12-20'), parseLocalDate('1000-01-10'))).toEqual(['0999-12', '1000-01']);
  });

  it('今の年 (4 桁) は今までどおり (対照)', () => {
    expect(monthKeysBetween(parseLocalDate('2026-10-19'), parseLocalDate('2026-12-06'))).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(monthKeysBetween(parseLocalDate('2026-12-20'), parseLocalDate('2027-01-10'))).toEqual(['2026-12', '2027-01']);
  });

  it('1 か月の中の範囲は 1 つの鍵 (対照)', () => {
    expect(monthKeysBetween(parseLocalDate('2026-11-02'), parseLocalDate('2026-11-08'))).toEqual(['2026-11']);
  });
});
