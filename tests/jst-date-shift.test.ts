// @vitest-environment node
//
// #1433: 「今日」・期間・月を JST の暦日で決めるための共通の関数の単体テスト。
//
// - Web / Mobile 用 (packages/shared → src/lib/date-utils.ts): addDaysToDate / isCalendarDate / monthLocal / jstDayStartTimestamp
// - Edge Functions 用 (supabase/functions/_shared/jst-date.ts): addDaysToDate / monthJst / jstDayRangeToTimestamps
//
// 境界 (JST 0:00 ちょうど・8:59:59・月初・月末・年末) と、実行環境のタイムゾーン (process.env.TZ) を変えても
// 結果が同じことを確かめる。2 つの実装が同じ結果を返すこと (パリティ) も確かめる。
// 期待値は実装とは別に、手で JST の暦を引いた固定値。

import { describe, expect, it } from 'vitest';

import {
  addDaysToDate,
  formatLocalDate,
  isCalendarDate,
  jstDayStartTimestamp,
  monthLocal,
} from '../src/lib/date-utils';
import {
  addDaysToDate as addDaysToDateEdge,
  formatJstDate,
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

describe('isCalendarDate: YYYY-MM-DD の実在する日付か', () => {
  it('実在する日付だけ true', () => {
    expect(isCalendarDate('2026-10-10')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-10-10T00:00:00Z')).toBe(false);
    expect(isCalendarDate('')).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(20261010)).toBe(false);
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
