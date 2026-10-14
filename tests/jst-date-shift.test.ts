// @vitest-environment node
//
// #1433: 「今日」・期間・月を JST の暦日で決めるための共通の関数の単体テスト。
//
// - Web / Mobile 用 (packages/shared → src/lib/date-utils.ts): addDaysToDate / isCalendarDate / monthLocal / jstDayStartTimestamp
// - Edge Functions 用 (supabase/functions/_shared/jst-date.ts): addDaysToDate / isCalendarDate / monthJst / jstDayRangeToTimestamps
//
// 境界 (JST 0:00 ちょうど・8:59:59・月初・月末・年末) と、実行環境のタイムゾーン (process.env.TZ) を変えても
// 結果が同じことを確かめる。2 つの実装が同じ結果を返すこと (パリティ) も確かめる。
// 期待値は実装とは別に、手で JST の暦を引いた固定値。

import { describe, expect, it } from 'vitest';

import {
  addDaysToDate,
  CALENDAR_DATE_MAX,
  CALENDAR_DATE_MIN,
  CALENDAR_DATE_REQUIREMENT,
  CALENDAR_DATE_SHIFT_MARGIN_DAYS,
  formatLocalDate,
  isCalendarDate,
  jstDayStartTimestamp,
  monthLocal,
} from '../src/lib/date-utils';
import {
  addDaysToDate as addDaysToDateEdge,
  CALENDAR_DATE_MAX as CALENDAR_DATE_MAX_EDGE,
  CALENDAR_DATE_MIN as CALENDAR_DATE_MIN_EDGE,
  CALENDAR_DATE_REQUIREMENT as CALENDAR_DATE_REQUIREMENT_EDGE,
  CALENDAR_DATE_SHIFT_MARGIN_DAYS as CALENDAR_DATE_SHIFT_MARGIN_DAYS_EDGE,
  formatJstDate,
  isCalendarDate as isCalendarDateEdge,
  jstDayRangeToTimestamps,
  monthJst,
} from '../supabase/functions/_shared/jst-date.ts';
import { inEachTimeZone, localOffsetMinutesOn20260101, withTimeZone } from './helpers/time-zones';

/** 境界の時刻 (UTC の ISO 表記) と、その時刻の JST の暦日・月 */
const BOUNDARIES = [
  { label: 'JST 0:00 ちょうど', at: '2026-10-09T15:00:00.000Z', jstDay: '2026-10-10', jstMonth: 10 },
  { label: 'JST 8:59:59', at: '2026-10-09T23:59:59.000Z', jstDay: '2026-10-10', jstMonth: 10 },
  { label: 'JST 0:00 の 1 ミリ秒前', at: '2026-10-09T14:59:59.999Z', jstDay: '2026-10-09', jstMonth: 10 },
  { label: '月初 (JST 11/1 0:00)', at: '2026-10-31T15:00:00.000Z', jstDay: '2026-11-01', jstMonth: 11 },
  { label: '月初 (JST 11/1 8:59:59)', at: '2026-10-31T23:59:59.000Z', jstDay: '2026-11-01', jstMonth: 11 },
  { label: '月末 (JST 10/31 23:59:59)', at: '2026-10-31T14:59:59.000Z', jstDay: '2026-10-31', jstMonth: 10 },
  { label: '年末 (JST 12/31 23:59:59)', at: '2026-12-31T14:59:59.000Z', jstDay: '2026-12-31', jstMonth: 12 },
  { label: '年始 (JST 1/1 0:00)', at: '2026-12-31T15:00:00.000Z', jstDay: '2027-01-01', jstMonth: 1 },
  { label: '年始 (JST 1/1 8:59:59)', at: '2026-12-31T23:59:59.000Z', jstDay: '2027-01-01', jstMonth: 1 },
] as const;

describe('タイムゾーンの切り替え (テストの前提)', () => {
  it('process.env.TZ を変えると、ローカル時刻のずれが変わる (変わらなければ以下のテストは何も確かめていない)', () => {
    expect(withTimeZone('UTC', localOffsetMinutesOn20260101)).toBe(0);
    expect(withTimeZone('Asia/Tokyo', localOffsetMinutesOn20260101)).toBe(-540);
    expect(withTimeZone('Pacific/Pago_Pago', localOffsetMinutesOn20260101)).toBe(660);
  });

  it('以前の書き方 (setDate + toISOString) は、タイムゾーンで結果が変わる (このテストで直した型)', () => {
    const legacyAddDays = (day: string, n: number) => {
      const d = new Date(day);
      d.setDate(d.getDate() + n);
      return d.toISOString().split('T')[0];
    };
    const results = inEachTimeZone(() => legacyAddDays('2026-03-08', 1));
    // UTC では正しいが、米国の夏時間の開始日 (3/8) をまたぐと、ローカル時刻の setDate では 23 時間しか進まず、
    // toISOString (UTC) で戻すと 3/8 のままになる
    expect(results.find((r) => r.tz === 'UTC')?.value).toBe('2026-03-09');
    expect(results.find((r) => r.tz === 'America/Los_Angeles')?.value).toBe('2026-03-08');
  });
});

describe('addDaysToDate: 暦日を N 日ずらす (Web / Mobile と Edge で同じ結果)', () => {
  const CASES: Array<[string, number, string]> = [
    ['2026-10-10', 0, '2026-10-10'],
    ['2026-10-10', -6, '2026-10-04'],
    ['2026-10-10', -29, '2026-09-11'],
    ['2026-11-01', -1, '2026-10-31'], // 月初 → 前月末
    ['2026-10-31', 1, '2026-11-01'], // 月末 → 翌月初
    ['2026-12-31', 1, '2027-01-01'], // 年末 → 年始
    ['2027-01-01', -30, '2026-12-02'],
    ['2028-03-01', -1, '2028-02-29'], // うるう年
    ['2027-03-01', -1, '2027-02-28'],
    ['2026-03-08', 1, '2026-03-09'], // 米国の夏時間の開始日 (ローカル時刻の setDate だとずれうる)
    ['2026-11-01', 7, '2026-11-08'], // 米国の夏時間の終了日をまたぐ
  ];

  it.each(CASES)('(%s, %i) → %s。どのタイムゾーンでも同じ', (day, n, expected) => {
    for (const { tz, value } of inEachTimeZone(() => [addDaysToDate(day, n), addDaysToDateEdge(day, n)])) {
      expect(value, tz).toEqual([expected, expected]);
    }
  });

  it('形の違う日付・存在しない日付・整数でない日数は RangeError (Edge と同じ)', () => {
    for (const fn of [addDaysToDate, addDaysToDateEdge]) {
      expect(() => fn('2026-2-3', 1)).toThrow(RangeError);
      expect(() => fn('2026-02-30', 0)).toThrow(RangeError);
      expect(() => fn('', 0)).toThrow(RangeError);
      expect(() => fn('2026-10-10', 1.5)).toThrow(RangeError);
    }
  });
});

describe('isCalendarDate: YYYY-MM-DD の実在する日付で、受け付ける範囲の中か (Web / Mobile と Edge で同じ答え)', () => {
  it('実在する日付だけ true', () => {
    for (const fn of [isCalendarDate, isCalendarDateEdge]) {
      expect(fn('2026-10-10')).toBe(true);
      expect(fn('2028-02-29')).toBe(true);
      expect(fn('2027-02-29')).toBe(false);
      expect(fn('2026-02-30')).toBe(false);
      expect(fn('2026-13-01')).toBe(false);
      expect(fn('2026-10-10T00:00:00Z')).toBe(false);
      expect(fn('')).toBe(false);
      expect(fn(undefined)).toBe(false);
      expect(fn(20261010)).toBe(false);
    }
  });

  it('受け付ける範囲は 0101-01-02〜9998-12-30 (暦の計算で扱える 0100-01-01〜9999-12-31 から、前後 366 日の余白を取った範囲)', () => {
    // 期待値は Python の datetime (先発グレゴリオ暦) で引いた固定値: date(100,1,1) + 366 日 / date(9999,12,31) - 366 日
    expect([CALENDAR_DATE_MIN, CALENDAR_DATE_MAX, CALENDAR_DATE_SHIFT_MARGIN_DAYS]).toEqual(['0101-01-02', '9998-12-30', 366]);
    expect([CALENDAR_DATE_MIN_EDGE, CALENDAR_DATE_MAX_EDGE, CALENDAR_DATE_SHIFT_MARGIN_DAYS_EDGE]).toEqual([
      '0101-01-02',
      '9998-12-30',
      366,
    ]);
    for (const fn of [isCalendarDate, isCalendarDateEdge]) {
      expect(fn('0101-01-02')).toBe(true);
      expect(fn('9998-12-30')).toBe(true);
      expect(fn('0101-01-01')).toBe(false); // 最初の日の前日
      expect(fn('9998-12-31')).toBe(false); // 最後の日の翌日
      expect(fn('9999-12-31')).toBe(false); // 実在するが、翌日を YYYY-MM-DD で表せない (以前は通って、翌日を求めるところで 500)
      expect(fn('0100-01-01')).toBe(false);
      expect(fn('0099-12-31')).toBe(false); // Date.UTC が 1999 年と読む
      expect(fn('0000-01-01')).toBe(false);
    }
  });

  it('400 の文の説明も Web / Mobile と Edge で同じ', () => {
    expect(CALENDAR_DATE_REQUIREMENT).toBe('YYYY-MM-DD format (an existing calendar date from 0101-01-02 to 9998-12-30)');
    expect(CALENDAR_DATE_REQUIREMENT_EDGE).toBe(CALENDAR_DATE_REQUIREMENT);
  });

  it('受け付けた日付は、前後に余白の日数 (366 日) ずらしても、暦の計算で扱える範囲に収まる (それを超えると RangeError)', () => {
    for (const fn of [addDaysToDate, addDaysToDateEdge]) {
      expect(fn(CALENDAR_DATE_MAX, CALENDAR_DATE_SHIFT_MARGIN_DAYS)).toBe('9999-12-31');
      expect(fn(CALENDAR_DATE_MIN, -CALENDAR_DATE_SHIFT_MARGIN_DAYS)).toBe('0100-01-01');
      expect(() => fn(CALENDAR_DATE_MAX, CALENDAR_DATE_SHIFT_MARGIN_DAYS + 1)).toThrow(RangeError);
      expect(() => fn(CALENDAR_DATE_MIN, -(CALENDAR_DATE_SHIFT_MARGIN_DAYS + 1))).toThrow(RangeError);
    }
  });
});

describe('addDaysToDate: 結果が暦の計算で扱える範囲 (0100-01-01〜9999-12-31) の外に出るときは RangeError (#1433)', () => {
  it.each([
    ['9999-12-31', 1], // 以前は "+010000-01" (YYYY-MM-DD でない文字列) を返し、jstDayStartTimestamp などが後で落ちていた
    ['9999-12-25', 7],
    ['0100-01-01', -1], // 以前は "0099-12-31" を返し、それを受けた addDaysToDate が「存在しない日」で落ちていた
    ['2026-10-10', 3_000_000], // 10000 年を超える
    ['2026-10-10', 1e12], // Date で表せない (toISOString の Invalid time value)
  ])('(%s, %d) は RangeError (Web / Mobile と Edge で同じ)', (day, n) => {
    expect(() => addDaysToDate(day, n)).toThrow(RangeError);
    expect(() => addDaysToDateEdge(day, n)).toThrow(RangeError);
  });

  it('範囲の端の日そのものには届く (9999-12-30 + 1・0100-01-02 - 1)', () => {
    for (const fn of [addDaysToDate, addDaysToDateEdge]) {
      expect(fn('9999-12-30', 1)).toBe('9999-12-31');
      expect(fn('0100-01-02', -1)).toBe('0100-01-01');
    }
  });
});

describe('monthLocal / monthJst: その時刻が属する JST の月', () => {
  it.each(BOUNDARIES)('$label → $jstMonth 月 (Web / Mobile と Edge で同じ・どのタイムゾーンでも同じ)', ({ at, jstMonth }) => {
    for (const { tz, value } of inEachTimeZone(() => [monthLocal(new Date(at)), monthJst(new Date(at))])) {
      expect(value, tz).toEqual([jstMonth, jstMonth]);
    }
  });

  it('以前の書き方 (new Date().getMonth() + 1) は、UTC の実行環境で月初の JST 0:00〜8:59 に前月になる', () => {
    const monthStart = new Date('2026-10-31T23:59:59.000Z'); // JST 11/1 8:59:59
    expect(withTimeZone('UTC', () => monthStart.getMonth() + 1)).toBe(10);
    expect(withTimeZone('UTC', () => monthJst(monthStart))).toBe(11);
  });

  it('不正な Date は RangeError (黙って NaN を返さない)', () => {
    expect(() => monthJst(new Date('x'))).toThrow(RangeError);
    expect(() => monthLocal(new Date('x'))).toThrow(RangeError);
  });
});

describe('formatLocalDate と formatJstDate: 境界でも JST の暦日 (どのタイムゾーンでも同じ)', () => {
  it.each(BOUNDARIES)('$label → $jstDay', ({ at, jstDay }) => {
    for (const { tz, value } of inEachTimeZone(() => [formatLocalDate(new Date(at)), formatJstDate(new Date(at))])) {
      expect(value, tz).toEqual([jstDay, jstDay]);
    }
  });
});

describe('jstDayStartTimestamp: JST の暦日の 0 時 (timestamptz 列と比べる時刻)', () => {
  const CASES: Array<[string, string]> = [
    ['2026-10-10', '2026-10-09T15:00:00.000Z'],
    ['2026-11-01', '2026-10-31T15:00:00.000Z'],
    ['2027-01-01', '2026-12-31T15:00:00.000Z'],
    ['2028-02-29', '2028-02-28T15:00:00.000Z'],
  ];

  it.each(CASES)('%s → %s。Edge の jstDayRangeToTimestamps の from と同じ・どのタイムゾーンでも同じ', (day, expected) => {
    for (const { tz, value } of inEachTimeZone(() => jstDayStartTimestamp(day))) {
      expect(value, tz).toBe(expected);
    }
    expect(jstDayRangeToTimestamps(day, day).from).toBe(expected);
  });

  it('JST の今日の 0 時は、今の時刻以前 (JST 0:00 ちょうど・8:59:59 でも)', () => {
    for (const at of ['2026-10-09T15:00:00.000Z', '2026-10-09T23:59:59.000Z']) {
      const start = jstDayStartTimestamp(formatLocalDate(new Date(at)));
      expect(start).toBe('2026-10-09T15:00:00.000Z');
      expect(Date.parse(start)).toBeLessThanOrEqual(Date.parse(at));
    }
  });

  it('形の違う日付・存在しない日付は RangeError', () => {
    expect(() => jstDayStartTimestamp('2026-02-30')).toThrow(RangeError);
    expect(() => jstDayStartTimestamp('2026/10/10')).toThrow(RangeError);
  });
});
