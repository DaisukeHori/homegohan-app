// @vitest-environment node
//
// #1433: 「今日」・期間・月を UTC の暦日やローカル時刻で決めていた箇所を、JST の暦日に直した関数の回帰テスト。
//
// 直した箇所と、ここで確かめる関数の対応 (呼び出し側がこの関数を使っていることは tests/jst-today-source-scan.test.ts で確かめる):
//   - POST /api/ai/nutrition-analysis (今日・7 日・30 日)          → nutritionAnalysisRange
//   - GET  /api/badges (連続日数)                                 → consecutiveDayStreak
//   - POST /api/health/challenges (開始日・終了日)                → challengePeriod
//   - GET  /api/super-admin/llm/usage (期間)                      → llmUsageRange
//   - GET  /api/ai/menu/meal/pending (日曜始まりの週)              → sundayWeekRange
//   - GET  /api/ai/consultation/sessions (7 日前) / GET /api/performance/checkins (30 日前)
//     / GET /api/admin/finance/revenue (30 日前)                    → jstDayOffset
//   - GET  /api/meals・/api/performance/*・health/checkups・health/blood-tests の「今日」 → jstToday
//   - モバイルの健康グラフ (app/health/graphs.tsx)                   → healthGraphFetchStartDate / healthGraphDateSlots
//   - 献立生成の旬の食材・行事 (lib/seasonal-ingredients.ts / lib/seasonal-events.ts)
//   - 献立生成モーダルのスロット (lib/slot-builder.ts の日付の範囲)
//
// 境界 (JST 0:00 ちょうど・8:59:59・月初・月末・年末) と、実行環境のタイムゾーン (process.env.TZ) を変えても結果が同じことを確かめる。
// 期待値は実装とは別に、Python の datetime で JST の暦を引いて求めた固定値。

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  challengePeriod,
  consecutiveDayStreak,
  jstDayOffset,
  jstToday,
  llmUsageRange,
  NUTRITION_ANALYSIS_MONTH_DAYS,
  NUTRITION_ANALYSIS_WEEK_DAYS,
  nutritionAnalysisRange,
  sundayWeekRange,
} from '../src/lib/jst-day-ranges';
import { healthGraphDateSlots, healthGraphFetchStartDate } from '../apps/mobile/src/lib/health-graph-dates';
import {
  getSeasonalIngredients,
  getSeasonalIngredientsForDate,
  getSeasonalIngredientsForRange,
} from '../lib/seasonal-ingredients';
import { getEventsForDate, getEventsForRange } from '../lib/seasonal-events';
import { buildEmptySlots } from '../lib/slot-builder';
import { TEST_TIME_ZONES, inEachTimeZone, localOffsetMinutesOn20260101, withTimeZone } from './helpers/time-zones';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 境界の時刻 (UTC の ISO 表記) と、その時刻の JST の暦日から数えた日付。
 *   today: JST の今日 / d1: 1 日前 / d2: 2 日前 / d6: 6 日前 / d7: 7 日前 / d29: 29 日前 / d30: 30 日前 / p7: 7 日後
 */
const BOUNDARIES = [
  { label: 'JST 0:00 ちょうど', at: '2026-10-09T15:00:00.000Z', today: '2026-10-10', d1: '2026-10-09', d2: '2026-10-08', d6: '2026-10-04', d7: '2026-10-03', d29: '2026-09-11', d30: '2026-09-10', p7: '2026-10-17' },
  { label: 'JST 8:59:59', at: '2026-10-09T23:59:59.000Z', today: '2026-10-10', d1: '2026-10-09', d2: '2026-10-08', d6: '2026-10-04', d7: '2026-10-03', d29: '2026-09-11', d30: '2026-09-10', p7: '2026-10-17' },
  { label: 'JST 0:00 の 1 ミリ秒前', at: '2026-10-09T14:59:59.999Z', today: '2026-10-09', d1: '2026-10-08', d2: '2026-10-07', d6: '2026-10-03', d7: '2026-10-02', d29: '2026-09-10', d30: '2026-09-09', p7: '2026-10-16' },
  { label: '月初 (JST 11/1 0:00)', at: '2026-10-31T15:00:00.000Z', today: '2026-11-01', d1: '2026-10-31', d2: '2026-10-30', d6: '2026-10-26', d7: '2026-10-25', d29: '2026-10-03', d30: '2026-10-02', p7: '2026-11-08' },
  { label: '月初 (JST 11/1 8:59:59)', at: '2026-10-31T23:59:59.000Z', today: '2026-11-01', d1: '2026-10-31', d2: '2026-10-30', d6: '2026-10-26', d7: '2026-10-25', d29: '2026-10-03', d30: '2026-10-02', p7: '2026-11-08' },
  { label: '月末 (JST 10/31 23:59:59)', at: '2026-10-31T14:59:59.000Z', today: '2026-10-31', d1: '2026-10-30', d2: '2026-10-29', d6: '2026-10-25', d7: '2026-10-24', d29: '2026-10-02', d30: '2026-10-01', p7: '2026-11-07' },
  { label: '年末 (JST 12/31 23:59:59)', at: '2026-12-31T14:59:59.000Z', today: '2026-12-31', d1: '2026-12-30', d2: '2026-12-29', d6: '2026-12-25', d7: '2026-12-24', d29: '2026-12-02', d30: '2026-12-01', p7: '2027-01-07' },
  { label: '年始 (JST 1/1 0:00)', at: '2026-12-31T15:00:00.000Z', today: '2027-01-01', d1: '2026-12-31', d2: '2026-12-30', d6: '2026-12-26', d7: '2026-12-25', d29: '2026-12-03', d30: '2026-12-02', p7: '2027-01-08' },
  { label: '年始 (JST 1/1 8:59:59)', at: '2026-12-31T23:59:59.000Z', today: '2027-01-01', d1: '2026-12-31', d2: '2026-12-30', d6: '2026-12-26', d7: '2026-12-25', d29: '2026-12-03', d30: '2026-12-02', p7: '2027-01-08' },
] as const;

type Boundary = (typeof BOUNDARIES)[number];

/** fn(now) をすべてのタイムゾーンで呼び、すべて expected と等しいことを確かめる */
function expectSameInEveryTimeZone<T>(b: Boundary, fn: (now: Date) => T, expected: T) {
  for (const { tz, value } of inEachTimeZone(() => fn(new Date(b.at)))) {
    expect(value, `${b.label} / TZ=${tz}`).toEqual(expected);
  }
}

describe('テストの前提', () => {
  it('タイムゾーンの切り替えが効いている', () => {
    const offsets = new Set(TEST_TIME_ZONES.map((tz) => withTimeZone(tz, localOffsetMinutesOn20260101)));
    expect(offsets.size).toBe(TEST_TIME_ZONES.length);
  });

  it('以前の書き方 (toISOString の先頭 10 文字) は、JST 0:00〜8:59:59 に前日になる (直した不具合)', () => {
    expect(new Date('2026-10-09T15:00:00.000Z').toISOString().slice(0, 10)).toBe('2026-10-09');
    expect(new Date('2026-10-09T23:59:59.000Z').toISOString().split('T')[0]).toBe('2026-10-09');
  });
});

describe.each(BOUNDARIES)('$label', (b) => {
  it(`jstToday / jstDayOffset (今日・1 日前・7 日前・30 日前・7 日後)`, () => {
    expectSameInEveryTimeZone(b, (now) => jstToday(now), b.today);
    expectSameInEveryTimeZone(b, (now) => jstDayOffset(-1, now), b.d1);
    expectSameInEveryTimeZone(b, (now) => jstDayOffset(-7, now), b.d7);
    expectSameInEveryTimeZone(b, (now) => jstDayOffset(-30, now), b.d30);
    expectSameInEveryTimeZone(b, (now) => jstDayOffset(7, now), b.p7);
  });

  it('jstToday は、引数を省略すると現在時刻 (fake timers の時刻) の JST の暦日', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(b.at));
    for (const { tz, value } of inEachTimeZone(() => [jstToday(), jstDayOffset(-7)])) {
      expect(value, tz).toEqual([b.today, b.d7]);
    }
  });

  it('nutritionAnalysisRange: 今日 = 今日だけ / 週 = 今日を含む 7 日 / 月 = 今日を含む 30 日', () => {
    expectSameInEveryTimeZone(b, (now) => nutritionAnalysisRange('today', now), { startDate: b.today, endDate: b.today });
    expectSameInEveryTimeZone(b, (now) => nutritionAnalysisRange('week', now), { startDate: b.d6, endDate: b.today });
    expectSameInEveryTimeZone(b, (now) => nutritionAnalysisRange('month', now), { startDate: b.d29, endDate: b.today });
    // 想定外の period は「今日」と同じ (以前のルートの default)
    expectSameInEveryTimeZone(b, (now) => nutritionAnalysisRange('year', now), { startDate: b.today, endDate: b.today });
  });

  it('consecutiveDayStreak: JST の今日から途切れずに続く日数 (今日が無ければ昨日から)', () => {
    expectSameInEveryTimeZone(b, (now) => consecutiveDayStreak([b.today, b.d1, b.d2, b.d6], now), 3);
    expectSameInEveryTimeZone(b, (now) => consecutiveDayStreak([b.d1, b.d2], now), 2);
    expectSameInEveryTimeZone(b, (now) => consecutiveDayStreak([b.today, b.d2], now), 1);
    expectSameInEveryTimeZone(b, (now) => consecutiveDayStreak([b.d2], now), 0);
    expectSameInEveryTimeZone(b, (now) => consecutiveDayStreak([], now), 0);
    // 「明日」(UTC の暦日だと JST の今日が明日に見える時間帯がある) は数えない
    expectSameInEveryTimeZone(b, (now) => consecutiveDayStreak([jstDayOffset(1, now)], now), 0);
  });

  it('challengePeriod: 開始日 = JST の今日、終了日 = 7 日後', () => {
    expectSameInEveryTimeZone(b, (now) => challengePeriod(7, now), { startDate: b.today, endDate: b.p7 });
  });

  it('llmUsageRange: 終了日の既定は JST の今日、開始日は 1 / 7 / 30 日前', () => {
    expectSameInEveryTimeZone(b, (now) => llmUsageRange({ period: '1d' }, now), { fromDate: b.d1, toDate: b.today });
    expectSameInEveryTimeZone(b, (now) => llmUsageRange({ period: '7d' }, now), { fromDate: b.d7, toDate: b.today });
    expectSameInEveryTimeZone(b, (now) => llmUsageRange({ period: '30d' }, now), { fromDate: b.d30, toDate: b.today });
    // custom で from が無いときは、以前のルートと同じく 30 日前
    expectSameInEveryTimeZone(b, (now) => llmUsageRange({ period: 'custom' }, now), { fromDate: b.d30, toDate: b.today });
    // 指定された from / to はそのまま
    expectSameInEveryTimeZone(
      b,
      (now) => llmUsageRange({ period: 'custom', from: '2026-01-01', to: '2026-01-31' }, now),
      { fromDate: '2026-01-01', toDate: '2026-01-31' },
    );
  });

  it('健康グラフ (モバイル): 取得の開始日 = 30 日前、横軸 = JST の今日を最後の日とする 7 日', () => {
    expectSameInEveryTimeZone(b, (now) => healthGraphFetchStartDate(30, now), b.d30);
    expectSameInEveryTimeZone(b, (now) => {
      const slots = healthGraphDateSlots(7, now);
      return { length: slots.length, first: slots[0], last: slots[slots.length - 1] };
    }, { length: 7, first: b.d6, last: b.today });
  });

  it('旬の食材 (Date を渡したとき): その時刻の JST の月', () => {
    const jstMonth = Number(b.today.slice(5, 7));
    expectSameInEveryTimeZone(b, (now) => getSeasonalIngredientsForDate(now), getSeasonalIngredients(jstMonth));
  });
});

describe('nutritionAnalysisRange の日数 (以前のルートと同じ)', () => {
  it('週 = 7 日、月 = 30 日 (開始日と終了日の両方を含む)', () => {
    expect(NUTRITION_ANALYSIS_WEEK_DAYS).toBe(7);
    expect(NUTRITION_ANALYSIS_MONTH_DAYS).toBe(30);
  });
});

describe('sundayWeekRange: 日曜から土曜までの週 (暦の計算だけ・どのタイムゾーンでも同じ)', () => {
  const CASES: Array<[string, string, string]> = [
    ['2026-10-14', '2026-10-11', '2026-10-17'], // 水
    ['2026-10-11', '2026-10-11', '2026-10-17'], // 日 (週の最初の日)
    ['2026-10-17', '2026-10-11', '2026-10-17'], // 土 (週の最後の日)
    ['2026-12-31', '2026-12-27', '2027-01-02'], // 年をまたぐ週
    ['2027-01-01', '2026-12-27', '2027-01-02'],
    ['2026-03-08', '2026-03-08', '2026-03-14'], // 米国の夏時間の開始日
    ['2026-03-07', '2026-03-01', '2026-03-07'],
  ];

  it.each(CASES)('%s → %s 〜 %s', (day, startDate, endDate) => {
    for (const { tz, value } of inEachTimeZone(() => sundayWeekRange(day))) {
      expect(value, tz).toEqual({ startDate, endDate });
    }
  });

  it('以前の書き方 (new Date(day).getDay()) は、UTC より西のタイムゾーンで前日の曜日を読み、週がずれていた', () => {
    // new Date('2026-10-11') は UTC の 0 時。Los Angeles のローカル時刻では 10/10 (土)
    expect(withTimeZone('America/Los_Angeles', () => new Date('2026-10-11').getDay())).toBe(6);
    expect(withTimeZone('America/Los_Angeles', () => sundayWeekRange('2026-10-11'))).toEqual({
      startDate: '2026-10-11',
      endDate: '2026-10-17',
    });
  });

  it('形の違う日付・存在しない日付は RangeError', () => {
    expect(() => sundayWeekRange('2026-02-30')).toThrow(RangeError);
    expect(() => sundayWeekRange('2026/10/11')).toThrow(RangeError);
  });
});

describe('旬の食材・行事 (lib/seasonal-*): 暦日の文字列は、どのタイムゾーンでもその日のまま', () => {
  it('getSeasonalIngredientsForDate("2026-11-01") は 11 月 (UTC より西でも 10 月にならない)', () => {
    for (const { tz, value } of inEachTimeZone(() => getSeasonalIngredientsForDate('2026-11-01'))) {
      expect(value, tz).toEqual(getSeasonalIngredients(11));
    }
  });

  it('getSeasonalIngredientsForRange("2026-01-31", "2026-03-01") は 1〜3 月 (以前は 1/31 から setMonth で 3/3 に飛び、2 月を落とすことがあった)', () => {
    const union = (months: number[]) => {
      const all = months.map(getSeasonalIngredients);
      return {
        vegetables: [...new Set(all.flatMap((m) => m.vegetables))],
        fish: [...new Set(all.flatMap((m) => m.fish))],
        fruits: [...new Set(all.flatMap((m) => m.fruits))],
      };
    };
    for (const { tz, value } of inEachTimeZone(() => getSeasonalIngredientsForRange('2026-01-31', '2026-03-01'))) {
      expect(value, tz).toEqual(union([1, 2, 3]));
    }
    // 年をまたぐ範囲 (12 月〜1 月)
    for (const { tz, value } of inEachTimeZone(() => getSeasonalIngredientsForRange('2026-12-28', '2027-01-03'))) {
      expect(value, tz).toEqual(union([12, 1]));
    }
    // 開始日が終了日より後のときは、終了日の月だけ (以前と同じ)
    expect(getSeasonalIngredientsForRange('2026-05-10', '2026-04-01')).toEqual(union([4]));
  });

  it('getEventsForDate("2026-01-01") はお正月 (UTC より西でも 12/31 にならない)', () => {
    for (const { tz, value } of inEachTimeZone(() => getEventsForDate('2026-01-01').map((e) => e.name))) {
      expect(value, tz).toContain('お正月');
    }
  });

  it('getEventsForRange は、範囲の日を暦の計算で 1 日ずつ進める (年をまたいでも・どのタイムゾーンでも同じ)', () => {
    const results = inEachTimeZone(() => getEventsForRange('2026-12-31', '2027-01-07').map((e) => e.name).sort());
    for (const { tz, value } of results) {
      expect(value, tz).toEqual(results[0].value);
      expect(value, tz).toContain('お正月');
      expect(value, tz).toContain('七草がゆ');
    }
  });
});

describe('献立生成のスロット (lib/slot-builder.ts): 日付の範囲は暦の計算で作る', () => {
  it('月末をまたぐ範囲・米国の夏時間をまたぐ範囲でも、どのタイムゾーンでも同じ日付が並ぶ', () => {
    const dates = (startDate: string, endDate: string) =>
      buildEmptySlots({ mealPlanDays: [], mealTypes: ['dinner'], startDate, endDate }).map((s) => s.date);
    for (const { tz, value } of inEachTimeZone(() => dates('2026-10-30', '2026-11-02'))) {
      expect(value, tz).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    }
    for (const { tz, value } of inEachTimeZone(() => dates('2026-03-07', '2026-03-09'))) {
      expect(value, tz).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    }
    for (const { tz, value } of inEachTimeZone(() => dates('2026-12-31', '2027-01-01'))) {
      expect(value, tz).toEqual(['2026-12-31', '2027-01-01']);
    }
  });

  it('終了日を省略すると、開始日から 6 日後まで (1 週間)', () => {
    for (const { tz, value } of inEachTimeZone(() =>
      buildEmptySlots({ mealPlanDays: [], mealTypes: ['dinner'], startDate: '2026-12-28' }).map((s) => s.date),
    )) {
      expect(value, tz).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    }
  });

  it('日付の入力が空のときは 0 件 (以前と同じく例外にしない)', () => {
    expect(buildEmptySlots({ mealPlanDays: [], startDate: '2026-10-10', endDate: '' })).toEqual([]);
  });
});
