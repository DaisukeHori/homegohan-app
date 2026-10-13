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
//   - GET  /api/meal-plans (既定の今週)・AI 相談の「来週」(月曜始まりの週。#1463) → mondayWeekRange / calendarDayOfWeek
//   - GET  /api/ai/consultation/sessions (7 日前) / GET /api/performance/checkins (30 日前)
//     / GET /api/admin/finance/revenue (30 日前)                    → jstDayOffset
//   - GET  /api/meals・/api/performance/*・health/checkups・health/blood-tests の「今日」 → jstToday
//   - GET  /api/super-admin/llm/usage (created_at の範囲)            → jstDayRangeTimestamps (日次の系列は DB の関数 llm_usage_summary が JST の暦日でまとめる。#1498)
//   - GET  /api/super-admin/audit-logs・/api/operator/membership/audit (created_at の範囲。開始日・終了日は空欄もある)
//     / GET /api/admin/finance/nps の一覧・POST /api/admin/finance/exports (invoices / subscriptions / nps)
//                                                                  → jstOptionalDayRangeTimestamps
//   - GET  /api/admin/finance/nps の集計 (両端を含む DB の関数に渡す終了日)  → jstDayEndInclusiveTimestamp
//   - 家族・組織の招待メールの期限の日付 (expires_at)                → jstDayOfTimestamp
//   - GET  /api/admin/finance/dashboard (今月・先月)              → jstMonthBoundaries
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
  isCalendarDate,
  jstDayOffset,
  jstDayEndInclusiveTimestamp,
  jstDayOfTimestamp,
  jstDayRangeTimestamps,
  jstMonthBoundaries,
  jstOptionalDayRangeTimestamps,
  jstToday,
  llmUsageRange,
  LLM_USAGE_PERIOD_DAYS,
  NUTRITION_ANALYSIS_MONTH_DAYS,
  NUTRITION_ANALYSIS_WEEK_DAYS,
  calendarDayOfWeek,
  mondayWeekRange,
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
import { microsOf } from './helpers/timestamptz';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 境界の時刻 (UTC の ISO 表記) と、その時刻の JST の暦日から数えた日付。
 *   today: JST の今日 / d1: 1 日前 / d2: 2 日前 / d6: 6 日前 / d7: 7 日前 / d29: 29 日前 / d30: 30 日前 / p7: 7 日後
 *   mStart: JST の今月の月初 / pmStart: 先月の月初 / pmEnd: 先月の末日
 */
const BOUNDARIES = [
  { label: 'JST 0:00 ちょうど', at: '2026-10-09T15:00:00.000Z', today: '2026-10-10', d1: '2026-10-09', d2: '2026-10-08', d6: '2026-10-04', d7: '2026-10-03', d29: '2026-09-11', d30: '2026-09-10', p7: '2026-10-17', mStart: '2026-10-01', pmStart: '2026-09-01', pmEnd: '2026-09-30' },
  { label: 'JST 8:59:59', at: '2026-10-09T23:59:59.000Z', today: '2026-10-10', d1: '2026-10-09', d2: '2026-10-08', d6: '2026-10-04', d7: '2026-10-03', d29: '2026-09-11', d30: '2026-09-10', p7: '2026-10-17', mStart: '2026-10-01', pmStart: '2026-09-01', pmEnd: '2026-09-30' },
  { label: 'JST 0:00 の 1 ミリ秒前', at: '2026-10-09T14:59:59.999Z', today: '2026-10-09', d1: '2026-10-08', d2: '2026-10-07', d6: '2026-10-03', d7: '2026-10-02', d29: '2026-09-10', d30: '2026-09-09', p7: '2026-10-16', mStart: '2026-10-01', pmStart: '2026-09-01', pmEnd: '2026-09-30' },
  { label: '月初 (JST 11/1 0:00)', at: '2026-10-31T15:00:00.000Z', today: '2026-11-01', d1: '2026-10-31', d2: '2026-10-30', d6: '2026-10-26', d7: '2026-10-25', d29: '2026-10-03', d30: '2026-10-02', p7: '2026-11-08', mStart: '2026-11-01', pmStart: '2026-10-01', pmEnd: '2026-10-31' },
  { label: '月初 (JST 11/1 8:59:59)', at: '2026-10-31T23:59:59.000Z', today: '2026-11-01', d1: '2026-10-31', d2: '2026-10-30', d6: '2026-10-26', d7: '2026-10-25', d29: '2026-10-03', d30: '2026-10-02', p7: '2026-11-08', mStart: '2026-11-01', pmStart: '2026-10-01', pmEnd: '2026-10-31' },
  { label: '月末 (JST 10/31 23:59:59)', at: '2026-10-31T14:59:59.000Z', today: '2026-10-31', d1: '2026-10-30', d2: '2026-10-29', d6: '2026-10-25', d7: '2026-10-24', d29: '2026-10-02', d30: '2026-10-01', p7: '2026-11-07', mStart: '2026-10-01', pmStart: '2026-09-01', pmEnd: '2026-09-30' },
  { label: '年末 (JST 12/31 23:59:59)', at: '2026-12-31T14:59:59.000Z', today: '2026-12-31', d1: '2026-12-30', d2: '2026-12-29', d6: '2026-12-25', d7: '2026-12-24', d29: '2026-12-02', d30: '2026-12-01', p7: '2027-01-07', mStart: '2026-12-01', pmStart: '2026-11-01', pmEnd: '2026-11-30' },
  { label: '年始 (JST 1/1 0:00)', at: '2026-12-31T15:00:00.000Z', today: '2027-01-01', d1: '2026-12-31', d2: '2026-12-30', d6: '2026-12-26', d7: '2026-12-25', d29: '2026-12-03', d30: '2026-12-02', p7: '2027-01-08', mStart: '2027-01-01', pmStart: '2026-12-01', pmEnd: '2026-12-31' },
  { label: '年始 (JST 1/1 8:59:59)', at: '2026-12-31T23:59:59.000Z', today: '2027-01-01', d1: '2026-12-31', d2: '2026-12-30', d6: '2026-12-26', d7: '2026-12-25', d29: '2026-12-03', d30: '2026-12-02', p7: '2027-01-08', mStart: '2027-01-01', pmStart: '2026-12-01', pmEnd: '2026-12-31' },
] as const;

type Boundary = (typeof BOUNDARIES)[number];

/**
 * 1 つの境界で、どのタイムゾーンでも同じになるべき値 (1 件の it の中の 1 つの確かめ)。
 *   run: その境界の時刻 (now) を渡して値を求める。clock: 'system' のものは、now を渡さずに現在時刻 (fake timers を
 *        その境界の時刻にしたもの) を読む
 */
interface BoundaryCheck {
  label: string;
  run: (now: Date) => unknown;
  expected: unknown;
  clock?: 'system';
}

/** 境界ごとの it の名前と、その中の確かめ (it の名前は以前と同じ) */
const BOUNDARY_TESTS: ReadonlyArray<{ name: string; checks: (b: Boundary) => BoundaryCheck[] }> = [
  {
    name: 'jstToday / jstDayOffset (今日・1 日前・7 日前・30 日前・7 日後)',
    checks: (b) => [
      { label: 'jstToday', run: (now) => jstToday(now), expected: b.today },
      { label: 'jstDayOffset(-1)', run: (now) => jstDayOffset(-1, now), expected: b.d1 },
      { label: 'jstDayOffset(-7)', run: (now) => jstDayOffset(-7, now), expected: b.d7 },
      { label: 'jstDayOffset(-30)', run: (now) => jstDayOffset(-30, now), expected: b.d30 },
      { label: 'jstDayOffset(7)', run: (now) => jstDayOffset(7, now), expected: b.p7 },
    ],
  },
  {
    name: 'jstToday は、引数を省略すると現在時刻 (fake timers の時刻) の JST の暦日',
    checks: (b) => [{ label: 'jstToday() / jstDayOffset(-7)', run: () => [jstToday(), jstDayOffset(-7)], expected: [b.today, b.d7], clock: 'system' }],
  },
  {
    name: 'nutritionAnalysisRange: 今日 = 今日だけ / 週 = 今日を含む 7 日 / 月 = 今日を含む 30 日',
    checks: (b) => [
      { label: 'today', run: (now) => nutritionAnalysisRange('today', now), expected: { startDate: b.today, endDate: b.today } },
      { label: 'week', run: (now) => nutritionAnalysisRange('week', now), expected: { startDate: b.d6, endDate: b.today } },
      { label: 'month', run: (now) => nutritionAnalysisRange('month', now), expected: { startDate: b.d29, endDate: b.today } },
      // 想定外の period は「今日」と同じ (以前のルートの default)
      { label: 'year (想定外)', run: (now) => nutritionAnalysisRange('year', now), expected: { startDate: b.today, endDate: b.today } },
    ],
  },
  {
    name: 'consecutiveDayStreak: JST の今日から途切れずに続く日数 (今日が無ければ昨日から)',
    checks: (b) => [
      { label: '今日・1・2・6 日前', run: (now) => consecutiveDayStreak([b.today, b.d1, b.d2, b.d6], now), expected: 3 },
      { label: '1・2 日前', run: (now) => consecutiveDayStreak([b.d1, b.d2], now), expected: 2 },
      { label: '今日・2 日前', run: (now) => consecutiveDayStreak([b.today, b.d2], now), expected: 1 },
      { label: '2 日前', run: (now) => consecutiveDayStreak([b.d2], now), expected: 0 },
      { label: '空', run: (now) => consecutiveDayStreak([], now), expected: 0 },
      // 「明日」(UTC の暦日だと JST の今日が明日に見える時間帯がある) は数えない
      { label: '明日', run: (now) => consecutiveDayStreak([jstDayOffset(1, now)], now), expected: 0 },
    ],
  },
  {
    name: 'challengePeriod: 開始日 = JST の今日、終了日 = 7 日後',
    checks: (b) => [{ label: 'challengePeriod(7)', run: (now) => challengePeriod(7, now), expected: { startDate: b.today, endDate: b.p7 } }],
  },
  {
    name: 'llmUsageRange: 終了日の既定は JST の今日、開始日は今日を含む 1 / 7 / 30 日間の最初の日 (#1463。画面のラベル「今日」「7日」「30日」)',
    checks: (b) => [
      // 1d は今日だけ (以前は昨日と今日の 2 暦日で、画面のラベル「今日」と合わなかった)
      { label: '1d', run: (now) => llmUsageRange({ period: '1d' }, now), expected: { fromDate: b.today, toDate: b.today } },
      { label: '7d', run: (now) => llmUsageRange({ period: '7d' }, now), expected: { fromDate: b.d6, toDate: b.today } },
      { label: '30d', run: (now) => llmUsageRange({ period: '30d' }, now), expected: { fromDate: b.d29, toDate: b.today } },
      // custom で from が無いときは 30d と同じ
      { label: 'custom (from なし)', run: (now) => llmUsageRange({ period: 'custom' }, now), expected: { fromDate: b.d29, toDate: b.today } },
      // 指定された from / to はそのまま
      {
        label: 'custom (from / to あり)',
        run: (now) => llmUsageRange({ period: 'custom', from: '2026-01-01', to: '2026-01-31' }, now),
        expected: { fromDate: '2026-01-01', toDate: '2026-01-31' },
      },
    ],
  },
  {
    name: 'jstMonthBoundaries: 今月の月初・先月の月初・先月の末日 (JST の暦)',
    checks: (b) => [
      {
        label: 'jstMonthBoundaries',
        run: (now) => jstMonthBoundaries(now),
        expected: { thisMonthStart: b.mStart, lastMonthStart: b.pmStart, lastMonthEnd: b.pmEnd },
      },
    ],
  },
  {
    name: 'jstDayOfTimestamp: 時刻 (timestamptz の値) が属する JST の暦日',
    checks: (b) => [
      { label: 'Z の表記', run: () => jstDayOfTimestamp(b.at), expected: b.today },
      // DB (PostgREST) が返す +00:00 の表記でも同じ
      { label: '+00:00 の表記', run: () => jstDayOfTimestamp(b.at.replace('.000Z', '+00:00')), expected: b.today },
    ],
  },
  {
    name: '健康グラフ (モバイル): 取得の開始日 = 30 日前、横軸 = JST の今日を最後の日とする 7 日',
    checks: (b) => [
      { label: 'healthGraphFetchStartDate(30)', run: (now) => healthGraphFetchStartDate(30, now), expected: b.d30 },
      {
        label: 'healthGraphDateSlots(7)',
        run: (now) => {
          const slots = healthGraphDateSlots(7, now);
          return { length: slots.length, first: slots[0], last: slots[slots.length - 1] };
        },
        expected: { length: 7, first: b.d6, last: b.today },
      },
    ],
  },
  {
    name: '旬の食材 (Date を渡したとき): その時刻の JST の月',
    checks: (b) => [
      {
        label: 'getSeasonalIngredientsForDate',
        run: (now) => getSeasonalIngredientsForDate(now),
        expected: getSeasonalIngredients(Number(b.today.slice(5, 7))),
      },
    ],
  },
];

/** 確かめの値 (例外を投げたときは、その文面。どのタイムゾーン・どの確かめで投げたかを、期待値との差で見せる) */
type Outcome = { value: unknown } | { thrown: string };

function outcomeOf(fn: () => unknown): Outcome {
  try {
    return { value: fn() };
  } catch (error) {
    return { thrown: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/**
 * 全境界 × 全確かめを、タイムゾーンを 1 つずつ切り替えて 1 回の走査で求める (#1496)。
 * 以前は確かめ 1 つごとに 5 つのタイムゾーンを切り替えていた (process.env.TZ の書き換えは 1 回数 ms かかり、
 * 9 境界 × 28 か所 × 5 つ × 2 回 = 約 2,500 回でこのファイルの所要の大半を占めていた)。
 * 求める組み合わせ (境界 × 確かめ × タイムゾーン) と期待値は以前と同じで、減らしていない。
 * 走査の中で、各タイムゾーンのローカル時刻のずれも記録し、切り替えが効いていたことを確かめる。
 */
function sweepBoundaries() {
  return inEachTimeZone(() => ({
    offsetMinutes: localOffsetMinutesOn20260101(),
    boundaries: BOUNDARIES.map((b) =>
      BOUNDARY_TESTS.map((t) =>
        t.checks(b).map((c) => {
          if (c.clock !== 'system') return outcomeOf(() => c.run(new Date(b.at)));
          vi.useFakeTimers({ toFake: ['Date'] });
          try {
            vi.setSystemTime(new Date(b.at));
            return outcomeOf(() => c.run(new Date(b.at)));
          } finally {
            vi.useRealTimers();
          }
        }),
      ),
    ),
  }));
}

let sweep: ReturnType<typeof sweepBoundaries> | undefined;
/** 走査の結果 (最初に使うときに 1 回だけ求める) */
function sweptOutcomes(): NonNullable<typeof sweep> {
  sweep ??= sweepBoundaries();
  return sweep;
}

describe('テストの前提', () => {
  it('タイムゾーンの切り替えが効いている', () => {
    const offsets = new Set(TEST_TIME_ZONES.map((tz) => withTimeZone(tz, localOffsetMinutesOn20260101)));
    expect(offsets.size).toBe(TEST_TIME_ZONES.length);
  });

  it('境界の確かめの走査 (sweepBoundaries) でも、タイムゾーンごとに切り替えが効いていて、全部のタイムゾーン・境界・確かめを求めている', () => {
    const swept = sweptOutcomes();
    expect(swept.map((s) => s.tz)).toEqual([...TEST_TIME_ZONES]);
    expect(new Set(swept.map((s) => s.value.offsetMinutes)).size).toBe(TEST_TIME_ZONES.length);
    const expectedCounts = BOUNDARIES.map((b) => BOUNDARY_TESTS.map((t) => t.checks(b).length));
    for (const { tz, value } of swept) {
      expect(value.boundaries.map((tests) => tests.map((checks) => checks.length)), tz).toEqual(expectedCounts);
    }
  });

  it('以前の書き方 (toISOString の先頭 10 文字) は、JST 0:00〜8:59:59 に前日になる (直した不具合)', () => {
    expect(new Date('2026-10-09T15:00:00.000Z').toISOString().slice(0, 10)).toBe('2026-10-09');
    expect(new Date('2026-10-09T23:59:59.000Z').toISOString().split('T')[0]).toBe('2026-10-09');
  });
});

describe.each(BOUNDARIES.map((b, bi) => ({ ...b, bi })))('$label', (b) => {
  it.each(BOUNDARY_TESTS.map((t, ti) => ({ name: t.name, ti })))('$name', ({ ti }) => {
    const checks = BOUNDARY_TESTS[ti].checks(b);
    for (const { tz, value } of sweptOutcomes()) {
      checks.forEach((c, ci) => {
        expect(value.boundaries[b.bi][ti][ci], `${b.label} / TZ=${tz} / ${c.label}`).toEqual({ value: c.expected });
      });
    }
  });
});

describe('jstMonthBoundaries: 以前の書き方との違い', () => {
  it('以前の書き方 (ローカル時刻の年・月の 0 時を toISOString) は、実行環境のタイムゾーンで結果が変わっていた (直した不具合)', () => {
    const at = new Date('2026-10-31T18:00:00.000Z'); // JST 11/1 3:00
    const legacy = () => new Date(at.getFullYear(), at.getMonth(), 1).toISOString().slice(0, 10);
    expect(withTimeZone('UTC', legacy)).toBe('2026-10-01');
    expect(withTimeZone('Asia/Tokyo', legacy)).toBe('2026-10-31');
    expect(withTimeZone('UTC', () => jstMonthBoundaries(at).thisMonthStart)).toBe('2026-11-01');
    expect(withTimeZone('Asia/Tokyo', () => jstMonthBoundaries(at).thisMonthStart)).toBe('2026-11-01');
  });

  it('前月がうるう年の 2 月・31 日の月・30 日の月の末日', () => {
    for (const { tz, value } of inEachTimeZone(() => [
      jstMonthBoundaries(new Date('2028-02-29T15:00:00.000Z')), // JST 2028/3/1 0:00
      jstMonthBoundaries(new Date('2027-02-28T15:00:00.000Z')), // JST 2027/3/1 0:00
      jstMonthBoundaries(new Date('2026-07-31T15:00:00.000Z')), // JST 2026/8/1 0:00
    ])) {
      expect(value, tz).toEqual([
        { thisMonthStart: '2028-03-01', lastMonthStart: '2028-02-01', lastMonthEnd: '2028-02-29' },
        { thisMonthStart: '2027-03-01', lastMonthStart: '2027-02-01', lastMonthEnd: '2027-02-28' },
        { thisMonthStart: '2026-08-01', lastMonthStart: '2026-07-01', lastMonthEnd: '2026-07-31' },
      ]);
    }
  });

  it('引数を省略すると現在時刻 (fake timers の時刻) の JST の暦', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-31T15:00:00.000Z')); // JST 2027/1/1 0:00
    for (const { tz, value } of inEachTimeZone(() => jstMonthBoundaries())) {
      expect(value, tz).toEqual({ thisMonthStart: '2027-01-01', lastMonthStart: '2026-12-01', lastMonthEnd: '2026-12-31' });
    }
  });
});

describe('jstDayRangeTimestamps: JST の暦日の範囲 → timestamptz と比べる時刻の範囲', () => {
  it.each([
    // [開始日, 終了日, 開始日の JST 0 時, 終了日の翌日の JST 0 時]
    ['2026-10-09', '2026-10-10', '2026-10-08T15:00:00.000Z', '2026-10-10T15:00:00.000Z'],
    ['2026-10-31', '2026-10-31', '2026-10-30T15:00:00.000Z', '2026-10-31T15:00:00.000Z'], // 月末 (翌日は月初)
    ['2026-11-01', '2026-11-01', '2026-10-31T15:00:00.000Z', '2026-11-01T15:00:00.000Z'], // 月初 (開始は前月の UTC)
    ['2026-12-31', '2026-12-31', '2026-12-30T15:00:00.000Z', '2026-12-31T15:00:00.000Z'], // 年末 (翌日は年始)
    ['2027-01-01', '2027-01-01', '2026-12-31T15:00:00.000Z', '2027-01-01T15:00:00.000Z'], // 年始 (開始は前年の UTC)
    ['2028-02-28', '2028-02-29', '2028-02-27T15:00:00.000Z', '2028-02-29T15:00:00.000Z'], // うるう日
  ])('%s 〜 %s → [%s, %s)', (fromDate, toDate, fromTimestamp, toTimestampExclusive) => {
    for (const { tz, value } of inEachTimeZone(() => jstDayRangeTimestamps(fromDate, toDate))) {
      expect(value, tz).toEqual({ fromTimestamp, toTimestampExclusive });
    }
  });

  it('範囲の端: 開始日の JST 0:00 ちょうど・8:59:59 は入り、終了日の翌日の JST 0:00 は入らない', () => {
    const { fromTimestamp, toTimestampExclusive } = jstDayRangeTimestamps('2026-10-09', '2026-10-10');
    const inRange = (at: string) => Date.parse(at) >= Date.parse(fromTimestamp) && Date.parse(at) < Date.parse(toTimestampExclusive);
    expect(inRange('2026-10-08T14:59:59.999Z')).toBe(false); // JST 10/8 23:59:59.999
    expect(inRange('2026-10-08T15:00:00.000Z')).toBe(true); // JST 10/9 0:00
    expect(inRange('2026-10-08T23:59:59.000Z')).toBe(true); // JST 10/9 8:59:59 (日付の文字列のまま絞ると落ちていた)
    expect(inRange('2026-10-10T14:59:59.999Z')).toBe(true); // JST 10/10 23:59:59.999
    expect(inRange('2026-10-10T15:00:00.000Z')).toBe(false); // JST 10/11 0:00
  });

  it('形の違う日付・存在しない日付は RangeError', () => {
    expect(() => jstDayRangeTimestamps('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => jstDayRangeTimestamps('2026-03-01', '2026/03/02')).toThrow(RangeError);
  });
});

describe('jstOptionalDayRangeTimestamps: 開始日・終了日のどちらかが空欄でもよい版 (監査ログの期間)', () => {
  it.each([
    // [開始日, 終了日, 開始日の JST 0 時, 終了日の翌日の JST 0 時]
    ['2026-10-10', '2026-10-10', '2026-10-09T15:00:00.000Z', '2026-10-10T15:00:00.000Z'],
    ['2026-10-10', undefined, '2026-10-09T15:00:00.000Z', undefined], // 開始日だけ (上限なし)
    [undefined, '2026-10-10', undefined, '2026-10-10T15:00:00.000Z'], // 終了日だけ (下限なし)
    [undefined, undefined, undefined, undefined], // どちらも空欄 (絞らない)
    [undefined, '2026-10-31', undefined, '2026-10-31T15:00:00.000Z'], // 月末だけ (翌日は月初)
    ['2026-11-01', undefined, '2026-10-31T15:00:00.000Z', undefined], // 月初だけ (開始は前月の UTC)
    [undefined, '2026-12-31', undefined, '2026-12-31T15:00:00.000Z'], // 年末だけ (翌日は年始)
    ['2027-01-01', undefined, '2026-12-31T15:00:00.000Z', undefined], // 年始だけ (開始は前年の UTC)
  ])('%s 〜 %s → [%s, %s)', (fromDate, toDate, fromTimestamp, toTimestampExclusive) => {
    for (const { tz, value } of inEachTimeZone(() => jstOptionalDayRangeTimestamps(fromDate, toDate))) {
      expect(value, tz).toEqual({ fromTimestamp, toTimestampExclusive });
    }
  });

  it('両方あるときは jstDayRangeTimestamps と同じ時刻', () => {
    for (const [fromDate, toDate] of [
      ['2026-10-09', '2026-10-10'],
      ['2026-12-31', '2027-01-01'],
      ['2028-02-28', '2028-02-29'],
    ] as const) {
      expect(jstOptionalDayRangeTimestamps(fromDate, toDate)).toEqual(jstDayRangeTimestamps(fromDate, toDate));
    }
  });

  it('終了日だけのとき、終了日の JST 23:59:59.999 は入り、翌日の JST 0:00・8:59:59 は入らない (UTC の 23:59:59 で閉じると入っていた)', () => {
    const { toTimestampExclusive } = jstOptionalDayRangeTimestamps(undefined, '2026-10-10');
    const before = (at: string) => Date.parse(at) < Date.parse(toTimestampExclusive!);
    expect(before('2026-10-10T14:59:59.999Z')).toBe(true); // JST 10/10 23:59:59.999
    expect(before('2026-10-10T15:00:00.000Z')).toBe(false); // JST 10/11 0:00
    expect(before('2026-10-10T23:59:59.000Z')).toBe(false); // JST 10/11 8:59:59 (以前の 'T23:59:59Z' では入っていた)
  });

  it('開始日だけのとき、開始日の JST 0:00 ちょうど・8:59:59 は入り、前日の JST 23:59:59.999 は入らない', () => {
    const { fromTimestamp } = jstOptionalDayRangeTimestamps('2026-10-10', undefined);
    const after = (at: string) => Date.parse(at) >= Date.parse(fromTimestamp!);
    expect(after('2026-10-09T14:59:59.999Z')).toBe(false); // JST 10/9 23:59:59.999
    expect(after('2026-10-09T15:00:00.000Z')).toBe(true); // JST 10/10 0:00 (日付の文字列のまま絞ると落ちていた)
    expect(after('2026-10-09T23:59:59.000Z')).toBe(true); // JST 10/10 8:59:59 (同上)
  });

  it('形の違う日付・存在しない日付は RangeError (片方だけ渡したときも)', () => {
    expect(() => jstOptionalDayRangeTimestamps('2026-02-30', undefined)).toThrow(RangeError);
    expect(() => jstOptionalDayRangeTimestamps(undefined, '2026/03/02')).toThrow(RangeError);
  });
});

describe('jstDayEndInclusiveTimestamp: 終了日の最後の瞬間 (両端を含む DB の関数に渡す p_to)', () => {
  it.each([
    // [終了日, 翌日の JST 0 時の 1 マイクロ秒前]
    ['2026-10-10', '2026-10-10T14:59:59.999999Z'],
    ['2026-10-31', '2026-10-31T14:59:59.999999Z'], // 月末 (翌日は月初)
    ['2026-11-01', '2026-11-01T14:59:59.999999Z'], // 月初
    ['2026-12-31', '2026-12-31T14:59:59.999999Z'], // 年末 (翌日は年始)
    ['2027-01-01', '2027-01-01T14:59:59.999999Z'], // 年始
    ['2028-02-29', '2028-02-29T14:59:59.999999Z'], // うるう日
  ])('%s → %s (どのタイムゾーンでも同じ)', (toDate, expected) => {
    for (const { tz, value } of inEachTimeZone(() => jstDayEndInclusiveTimestamp(toDate))) {
      expect(value, tz).toBe(expected);
    }
  });

  it('翌日の JST 0 時 (jstDayRangeTimestamps の toTimestampExclusive) のちょうど 1 マイクロ秒前', () => {
    for (const toDate of ['2026-10-10', '2026-12-31', '2028-02-29']) {
      const { toTimestampExclusive } = jstDayRangeTimestamps(toDate, toDate);
      expect(microsOf(toTimestampExclusive) - microsOf(jstDayEndInclusiveTimestamp(toDate)), toDate).toBe(1n);
    }
  });

  it('`<= この時刻` は `< 翌日の JST 0 時` と同じ行を選ぶ (timestamptz の精度 = 1 マイクロ秒で比べる)', () => {
    const end = microsOf(jstDayEndInclusiveTimestamp('2026-10-10'));
    const { toTimestampExclusive } = jstDayRangeTimestamps('2026-10-10', '2026-10-10');
    const exclusive = microsOf(toTimestampExclusive);
    const rows = [
      '2026-10-09T15:00:00Z', // JST 10/10 0:00
      '2026-10-09T23:59:59Z', // JST 10/10 8:59:59
      '2026-10-10T00:00:00Z', // JST 10/10 9:00 (以前の、日付の文字列のまま `<= '2026-10-10'` の上端)
      '2026-10-10T14:59:59.999Z', // JST 10/10 23:59:59.999
      '2026-10-10T14:59:59.999999Z', // JST 10/10 23:59:59.999999 (その日の最後の値)
      '2026-10-10T15:00:00Z', // JST 10/11 0:00
      '2026-10-10T15:00:00.000001Z', // JST 10/11 0:00 の 1 マイクロ秒後
      '2026-10-10T23:59:59Z', // JST 10/11 8:59:59
    ];
    const inclusive = rows.filter((at) => microsOf(at) <= end);
    expect(inclusive).toEqual(rows.filter((at) => microsOf(at) < exclusive));
    expect(inclusive).toEqual(rows.slice(0, 5));
  });

  it('形の違う日付・存在しない日付は RangeError', () => {
    expect(() => jstDayEndInclusiveTimestamp('2026-02-30')).toThrow(RangeError);
    expect(() => jstDayEndInclusiveTimestamp('2026/10/10')).toThrow(RangeError);
    expect(() => jstDayEndInclusiveTimestamp('2026-10-10T00:00:00Z')).toThrow(RangeError);
  });
});

describe('jstDayOfTimestamp: 招待メールの期限 (expires_at) の境界', () => {
  it.each([
    // [期限の時刻 (DB から読んだ timestamptz の値), メールに書く JST の暦日]
    ['2026-10-16T15:00:00+00:00', '2026-10-17'], // JST 10/17 0:00 ちょうど (slice(0, 10) では 10/16)
    ['2026-10-16T23:59:59+00:00', '2026-10-17'], // JST 10/17 8:59:59 (slice(0, 10) では 10/16)
    ['2026-10-17T14:59:59.999999+00:00', '2026-10-17'], // JST 10/17 23:59:59.999999
    ['2026-10-17T15:00:00+00:00', '2026-10-18'], // JST 10/18 0:00
    ['2026-10-31T15:00:00+00:00', '2026-11-01'], // 月初 (JST 11/1 0:00。slice(0, 10) では 10/31)
    ['2026-12-31T15:00:00+00:00', '2027-01-01'], // 年始 (JST 1/1 0:00。slice(0, 10) では前年の 12/31)
  ])('%s → %s (どのタイムゾーンでも同じ)', (expiresAt, expected) => {
    for (const { tz, value } of inEachTimeZone(() => jstDayOfTimestamp(expiresAt))) {
      expect(value, tz).toBe(expected);
    }
  });
});

describe('jstDayOfTimestamp: 読めない時刻', () => {
  it('時刻として読めない文字列は RangeError (黙って変な日付を返さない)', () => {
    expect(() => jstDayOfTimestamp('not-a-time')).toThrow(RangeError);
    expect(() => jstDayOfTimestamp('')).toThrow(RangeError);
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

describe('mondayWeekRange / calendarDayOfWeek: 月曜から日曜までの週・暦日の曜日 (#1463。暦の計算だけ・どのタイムゾーンでも同じ)', () => {
  const CASES: Array<[string, number, string, string]> = [
    ['2026-10-14', 3, '2026-10-12', '2026-10-18'], // 水
    ['2026-10-12', 1, '2026-10-12', '2026-10-18'], // 月 (週の最初の日)
    ['2026-10-18', 0, '2026-10-12', '2026-10-18'], // 日 (前の月曜から始まる週の最後の日)
    ['2026-12-31', 4, '2026-12-28', '2027-01-03'], // 年をまたぐ週
    ['2027-01-03', 0, '2026-12-28', '2027-01-03'],
    ['2028-02-29', 2, '2028-02-28', '2028-03-05'], // うるう日
    ['2026-03-08', 0, '2026-03-02', '2026-03-08'], // 米国の夏時間の開始日
    ['2026-11-01', 0, '2026-10-26', '2026-11-01'], // 米国の夏時間の終了日
  ];

  it.each(CASES)('%s は曜日 %i、週は %s 〜 %s', (day, dayOfWeek, startDate, endDate) => {
    for (const { tz, value } of inEachTimeZone(() => [calendarDayOfWeek(day), mondayWeekRange(day)])) {
      expect(value, tz).toEqual([dayOfWeek, { startDate, endDate }]);
    }
  });

  it('以前の書き方 (parseLocalDate + setDate + formatLocalDate) は、JST より東のタイムゾーンで 1 日前の日付になっていた (直した不具合)', () => {
    // GET /api/meal-plans の既定の今週の月曜日の、以前の求め方 (2026-10-14 (水) → 本来は 10/12)
    const previousWay = (today: string): string => {
      const [y, m, d] = today.split('-').map(Number);
      const local = new Date(y, m - 1, d); // parseLocalDate
      local.setDate(local.getDate() - local.getDay() + (local.getDay() === 0 ? -6 : 1));
      return local.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // formatLocalDate
    };
    expect(withTimeZone('Asia/Tokyo', () => previousWay('2026-10-14'))).toBe('2026-10-12');
    // UTC+14 のローカル時刻の 0 時は、JST では前日の 19 時
    expect(withTimeZone('Pacific/Kiritimati', () => previousWay('2026-10-14'))).toBe('2026-10-11');
    expect(withTimeZone('Pacific/Kiritimati', () => mondayWeekRange('2026-10-14').startDate)).toBe('2026-10-12');
  });

  it('形の違う日付・存在しない日付は RangeError', () => {
    expect(() => calendarDayOfWeek('2026-02-30')).toThrow(RangeError);
    expect(() => mondayWeekRange('2026-02-30')).toThrow(RangeError);
    expect(() => mondayWeekRange('2026/10/12')).toThrow(RangeError);
  });
});

describe('LLM の使用量の期間の日数 (#1463)', () => {
  it('画面のボタンのラベル (今日 / 7日 / 30日) と同じ日数', () => {
    expect(LLM_USAGE_PERIOD_DAYS).toEqual({ '1d': 1, '7d': 7, '30d': 30 });
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

  it('getEventsForRange に不正な日付を渡すと 0 件 (以前と同じく例外にしない)', () => {
    expect(getEventsForRange('', '2026-01-07')).toEqual([]);
    expect(getEventsForRange('2026-01-01', 'not-a-date')).toEqual([]);
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

describe('isCalendarDate を通った日付は、期間の関数で RangeError にならない (受け付ける範囲の端。#1433)', () => {
  // 受け付ける範囲は 0101-01-02〜9998-12-30 (暦の計算で扱える 0100-01-01〜9999-12-31 から、前後 366 日の余白を取った範囲)。
  // 期待値は Python の datetime (先発グレゴリオ暦) で引いた固定値
  it('受け付ける最初の日・最後の日は isCalendarDate を通り、その外側の隣の日は通らない', () => {
    expect(isCalendarDate('0101-01-02')).toBe(true);
    expect(isCalendarDate('9998-12-30')).toBe(true);
    expect(isCalendarDate('0101-01-01')).toBe(false);
    expect(isCalendarDate('9998-12-31')).toBe(false);
    expect(isCalendarDate('9999-12-31')).toBe(false);
    expect(isCalendarDate('0100-01-01')).toBe(false);
  });

  it('jstDayRangeTimestamps / jstOptionalDayRangeTimestamps / jstDayEndInclusiveTimestamp は、端の日付でも時刻にできる', () => {
    expect(jstDayRangeTimestamps('0101-01-02', '9998-12-30')).toEqual({
      fromTimestamp: '0101-01-01T15:00:00.000Z',
      toTimestampExclusive: '9998-12-30T15:00:00.000Z',
    });
    expect(jstOptionalDayRangeTimestamps('0101-01-02', '9998-12-30')).toEqual({
      fromTimestamp: '0101-01-01T15:00:00.000Z',
      toTimestampExclusive: '9998-12-30T15:00:00.000Z',
    });
    expect(jstDayEndInclusiveTimestamp('9998-12-30')).toBe('9998-12-30T14:59:59.999999Z');
  });

  it('sundayWeekRange は、端の日付を含む週を返す (9998-12-30 は水曜・0101-01-02 は日曜)', () => {
    expect(sundayWeekRange('9998-12-30')).toEqual({ startDate: '9998-12-27', endDate: '9999-01-02' });
    expect(sundayWeekRange('0101-01-02')).toEqual({ startDate: '0101-01-02', endDate: '0101-01-08' });
  });

  it('範囲の外の 9999-12-31 は、翌日が暦の計算で扱える範囲の外なので RangeError (入口の isCalendarDate で 400 にする理由)', () => {
    expect(() => jstOptionalDayRangeTimestamps(undefined, '9999-12-31')).toThrow(RangeError);
    expect(() => jstDayRangeTimestamps('2026-10-10', '9999-12-31')).toThrow(RangeError);
    expect(() => jstDayEndInclusiveTimestamp('9999-12-31')).toThrow(RangeError);
  });
});
