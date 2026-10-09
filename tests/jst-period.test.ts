// @vitest-environment node
//
// #1211: 集計期間 (daily / weekly / monthly / all_time) の境界が、実行環境のタイムゾーンではなく
// JST (Asia/Tokyo, UTC+9) の暦で決まることの単体テスト。
//
// - Edge Functions 用: supabase/functions/_shared/jst-date.ts の calculateJstPeriod / jstDayRangeToTimestamps
// - Web 用            : src/lib/date-utils.ts → packages/shared の calculatePeriodLocal
//
// 以前は calculate-segment-stats (Edge Function) と /api/comparison/rankings (Next.js) が、それぞれ
// new Date().getDay() / getDate() / getMonth() (実行環境のローカル時刻。どちらも UTC) で期間を求めていた。
// UTC の暦だと、JST の 00:00〜08:59 の 9 時間はまだ「前日」なので、月曜の早朝は日曜日扱いで週の開始日が
// 1 週間前の月曜になり、月初の早朝は前月、毎日の早朝は前日の期間になっていた。
// 2 つの実装が同じ期間を返すこと (パリティ) は、保存側 (Edge) と読み出し側 (Web) の period_start が
// 食い違わないための条件なので、あわせて確かめる。tests/jst-date.test.ts と同じ並びで書いている。
//
// 期待値は、実装とは別の計算 (Python の datetime で JST の暦を引いたもの) で求めた固定値。

import { afterEach, describe, expect, it, vi } from "vitest";

import { calculatePeriodLocal } from "../src/lib/date-utils";
import {
  addDaysToDate,
  calculateJstLookbackPeriod,
  calculateJstPeriod,
  calculateJstPreviousPeriod,
  isJstCalendarPeriodType,
  JST_OFFSET_MS,
  jstDayRangeToTimestamps,
} from "../supabase/functions/_shared/jst-date.ts";

type Period = { periodStart: string; periodEnd: string };
type Calculator = (periodType: string, now?: Date) => Period;

const implementations: Array<[string, Calculator]> = [
  ["Edge 用 calculateJstPeriod", calculateJstPeriod],
  ["Web 用 calculatePeriodLocal", (periodType, now) => calculatePeriodLocal(periodType, now)],
];

const period = (periodStart: string, periodEnd: string): Period => ({ periodStart, periodEnd });

const originalTz = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/**
 * 日付の変わり目・月またぎ・年またぎ・うるう日を中心にした固定の時刻と、その時刻が属する JST の期間。
 * [UTC の時刻, JST での時刻, daily, weekly, monthly]
 */
const CASES: Array<[string, string, Period, Period, Period]> = [
  // 週の境界 (2026-07-13 は月曜日)
  ["2026-07-12T14:59:59.999Z", "日 7/12 23:59:59.999", period("2026-07-12", "2026-07-12"), period("2026-07-06", "2026-07-12"), period("2026-07-01", "2026-07-31")],
  ["2026-07-12T15:00:00.000Z", "月 7/13 00:00:00.000", period("2026-07-13", "2026-07-13"), period("2026-07-13", "2026-07-19"), period("2026-07-01", "2026-07-31")],
  ["2026-07-12T23:59:59.999Z", "月 7/13 08:59:59.999", period("2026-07-13", "2026-07-13"), period("2026-07-13", "2026-07-19"), period("2026-07-01", "2026-07-31")],
  ["2026-07-13T00:00:00.000Z", "月 7/13 09:00:00.000", period("2026-07-13", "2026-07-13"), period("2026-07-13", "2026-07-19"), period("2026-07-01", "2026-07-31")],
  ["2026-07-19T14:59:59.999Z", "日 7/19 23:59:59.999", period("2026-07-19", "2026-07-19"), period("2026-07-13", "2026-07-19"), period("2026-07-01", "2026-07-31")],
  ["2026-07-19T15:00:00.000Z", "月 7/20 00:00:00.000", period("2026-07-20", "2026-07-20"), period("2026-07-20", "2026-07-26"), period("2026-07-01", "2026-07-31")],
  // 月の境界
  ["2026-07-31T14:59:59.999Z", "金 7/31 23:59:59.999", period("2026-07-31", "2026-07-31"), period("2026-07-27", "2026-08-02"), period("2026-07-01", "2026-07-31")],
  ["2026-07-31T15:00:00.000Z", "土 8/1 00:00:00.000", period("2026-08-01", "2026-08-01"), period("2026-07-27", "2026-08-02"), period("2026-08-01", "2026-08-31")],
  ["2026-06-30T15:00:00.000Z", "水 7/1 00:00:00.000", period("2026-07-01", "2026-07-01"), period("2026-06-29", "2026-07-05"), period("2026-07-01", "2026-07-31")],
  ["2026-08-31T15:00:00.000Z", "火 9/1 00:00:00.000", period("2026-09-01", "2026-09-01"), period("2026-08-31", "2026-09-06"), period("2026-09-01", "2026-09-30")],
  // 年またぎ
  ["2026-12-31T15:00:00.000Z", "金 2027/1/1 00:00:00.000", period("2027-01-01", "2027-01-01"), period("2026-12-28", "2027-01-03"), period("2027-01-01", "2027-01-31")],
  ["2027-01-03T15:00:00.000Z", "月 2027/1/4 00:00:00.000", period("2027-01-04", "2027-01-04"), period("2027-01-04", "2027-01-10"), period("2027-01-01", "2027-01-31")],
  // うるう年・うるう日
  ["2028-01-31T15:00:00.000Z", "火 2028/2/1 00:00:00.000", period("2028-02-01", "2028-02-01"), period("2028-01-31", "2028-02-06"), period("2028-02-01", "2028-02-29")],
  ["2028-02-28T15:00:00.000Z", "火 2028/2/29 00:00:00.000", period("2028-02-29", "2028-02-29"), period("2028-02-28", "2028-03-05"), period("2028-02-01", "2028-02-29")],
  ["2028-02-29T15:00:00.000Z", "水 2028/3/1 00:00:00.000", period("2028-03-01", "2028-03-01"), period("2028-02-28", "2028-03-05"), period("2028-03-01", "2028-03-31")],
  // うるう年でない年の 2 月
  ["2027-01-31T15:00:00.000Z", "月 2027/2/1 00:00:00.000", period("2027-02-01", "2027-02-01"), period("2027-02-01", "2027-02-07"), period("2027-02-01", "2027-02-28")],
];

/** all_time は開始日が固定 (2024-01-01) で、終了日は JST の今日 */
const ALL_TIME_CASES: Array<[string, Period]> = [
  ["2026-07-12T14:59:59.999Z", period("2024-01-01", "2026-07-12")],
  ["2026-07-12T15:00:00.000Z", period("2024-01-01", "2026-07-13")],
  ["2026-12-31T15:00:00.000Z", period("2024-01-01", "2027-01-01")],
];

/** 知らない periodType は「JST の今日の 7 日前 〜 今日」 */
const UNKNOWN_CASES: Array<[string, Period]> = [
  ["2026-07-12T14:59:59.999Z", period("2026-07-05", "2026-07-12")],
  ["2026-07-12T15:00:00.000Z", period("2026-07-06", "2026-07-13")],
  ["2026-03-03T15:00:00.000Z", period("2026-02-25", "2026-03-04")], // うるう年でない年の 2 月をまたぐ
  ["2028-03-03T15:00:00.000Z", period("2028-02-26", "2028-03-04")], // うるう日をまたぐ
];

describe.each(implementations)("%s: 期間の境界は JST の暦で決まる (#1211)", (_name, calc) => {
  it.each(CASES)("%s (JST %s): daily / weekly / monthly", (utc, _jst, daily, weekly, monthly) => {
    const now = new Date(utc);
    expect(calc("daily", now)).toEqual(daily);
    expect(calc("weekly", now)).toEqual(weekly);
    expect(calc("monthly", now)).toEqual(monthly);
  });

  it("Issue の再現例: JST 月曜 0:00〜8:59 (UTC はまだ日曜) の週は、前の週ではなく、その月曜から始まる週", () => {
    // 修正前は getDay() が UTC の日曜日になり、週の開始日が 1 週間前の月曜 (2026-07-06) になっていた
    for (const utc of ["2026-07-12T15:00:00.000Z", "2026-07-12T20:00:00.000Z", "2026-07-12T23:59:59.999Z"]) {
      expect(calc("weekly", new Date(utc)), utc).toEqual(period("2026-07-13", "2026-07-19"));
    }
  });

  it("週は月曜日始まりの 7 日間。JST の月曜 0:00 から日曜 23:59 までの 168 時間は、1 時間刻みで同じ週", () => {
    const mondayStart = Date.parse("2026-07-12T15:00:00.000Z"); // JST 月曜 7/13 0:00
    for (let h = 0; h < 7 * 24; h++) {
      const now = new Date(mondayStart + h * 3_600_000);
      expect(calc("weekly", now), now.toISOString()).toEqual(period("2026-07-13", "2026-07-19"));
    }
    // 168 時間目 (次の月曜 0:00) で次の週になる
    expect(calc("weekly", new Date(mondayStart + 7 * 24 * 3_600_000))).toEqual(period("2026-07-20", "2026-07-26"));
    // その 1 ミリ秒前はまだ同じ週
    expect(calc("weekly", new Date(mondayStart + 7 * 24 * 3_600_000 - 1))).toEqual(period("2026-07-13", "2026-07-19"));
  });

  it("月は 1 日から末日まで。JST の 1 日 0:00 ちょうどで翌月になる", () => {
    expect(calc("monthly", new Date("2026-07-31T14:59:59.999Z"))).toEqual(period("2026-07-01", "2026-07-31"));
    expect(calc("monthly", new Date("2026-07-31T15:00:00.000Z"))).toEqual(period("2026-08-01", "2026-08-31"));
  });

  it("毎日 (daily) は開始日と終了日が同じ日で、JST の 0 時ちょうどで日が変わる", () => {
    expect(calc("daily", new Date("2026-07-12T14:59:59.999Z"))).toEqual(period("2026-07-12", "2026-07-12"));
    expect(calc("daily", new Date("2026-07-12T15:00:00.000Z"))).toEqual(period("2026-07-13", "2026-07-13"));
  });

  it.each(ALL_TIME_CASES)("all_time: %s → 2024-01-01 から JST の今日まで", (utc, expected) => {
    expect(calc("all_time", new Date(utc))).toEqual(expected);
  });

  it.each(UNKNOWN_CASES)("知らない periodType: %s → 7 日前から JST の今日まで (従来どおりの形)", (utc, expected) => {
    expect(calc("yearly", new Date(utc))).toEqual(expected);
    expect(calc("", new Date(utc))).toEqual(expected);
  });

  it("YYYY-MM-DD (ゼロ埋め) で返す", () => {
    for (const type of ["daily", "weekly", "monthly", "all_time", "other"]) {
      const result = calc(type, new Date("2026-01-05T00:00:00Z"));
      expect(result.periodStart, type).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.periodEnd, type).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(calc("weekly", new Date("2026-01-05T00:00:00Z"))).toEqual(period("2026-01-05", "2026-01-11"));
  });

  it("期間は JST の今日を含み、daily は 1 日・weekly は月曜始まりの 7 日・monthly は 1 日から末日までの 28〜31 日", () => {
    const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
    const days = (p: Period) => (day(p.periodEnd) - day(p.periodStart)) / 86_400_000 + 1;
    // 3 日 7 時間 13 分刻みで走査する (時刻と曜日が少しずつずれるので、1 日のどの時間帯・どの曜日も通る)
    for (let t = day("2026-01-01"); t < day("2028-03-10"); t += (3 * 24 + 7) * 3_600_000 + 13 * 60_000) {
      const now = new Date(t);
      const jstToday = new Date(t + 9 * 3_600_000).toISOString().slice(0, 10); // この関数とは別に求めた JST の今日
      const label = `${now.toISOString()} (JST ${jstToday})`;

      const daily = calc("daily", now);
      expect(days(daily), label).toBe(1);
      expect(daily.periodStart, label).toBe(jstToday);

      const weekly = calc("weekly", now);
      expect(days(weekly), label).toBe(7);
      expect(new Date(day(weekly.periodStart)).getUTCDay(), `${label} weekly は月曜始まり`).toBe(1);
      expect(day(weekly.periodStart) <= day(jstToday) && day(jstToday) <= day(weekly.periodEnd), `${label} weekly は今日を含む`).toBe(true);

      const monthly = calc("monthly", now);
      expect(monthly.periodStart, label).toBe(`${jstToday.slice(0, 8)}01`);
      expect([28, 29, 30, 31], label).toContain(days(monthly));
      expect(new Date(day(monthly.periodEnd) + 86_400_000).getUTCDate(), `${label} monthly は末日で終わる`).toBe(1);
      expect(monthly.periodEnd >= jstToday, `${label} monthly は今日を含む`).toBe(true);
    }
  }, 30_000);

  it("now を省略したときは、現在時刻を基準にする (JST 0 時で日が変わる)", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-07-12T14:59:59.999Z")); // JST 日曜 7/12 23:59:59.999
    expect(calc("weekly")).toEqual(period("2026-07-06", "2026-07-12"));

    vi.setSystemTime(new Date("2026-07-12T15:00:00.000Z")); // JST 月曜 7/13 0:00
    expect(calc("weekly")).toEqual(period("2026-07-13", "2026-07-19"));
  });

  it("now を渡したときは、システム時計ではなく now を基準にする", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(calc("weekly", new Date("2026-07-12T16:00:00Z"))).toEqual(period("2026-07-13", "2026-07-19"));
  });

  it("不正な Date は黙って変な日付を返さず、例外にする", () => {
    for (const type of ["daily", "weekly", "monthly", "all_time", "other"]) {
      expect(() => calc(type, new Date(Number.NaN)), type).toThrow(RangeError);
    }
  });
});

describe("実行環境のタイムゾーンに依存しない (#1211)", () => {
  // UTC からの偏移が 0・正・負・サマータイムありの実行環境。Deno (Supabase) と Vercel は UTC だが、
  // 手元の開発機やテスト環境の TZ が何であっても、同じ期間になること
  const timeZones = ["UTC", "Asia/Tokyo", "Pacific/Kiritimati", "Pacific/Midway", "America/Los_Angeles", "Europe/London"];

  it.each(implementations)("%s: どのタイムゾーンの実行環境でも、固定の期待値と同じ", (_name, calc) => {
    for (const tz of timeZones) {
      process.env.TZ = tz;
      for (const [utc, jst, daily, weekly, monthly] of CASES) {
        const now = new Date(utc);
        expect(calc("daily", now), `${tz} ${utc} (JST ${jst}) daily`).toEqual(daily);
        expect(calc("weekly", now), `${tz} ${utc} (JST ${jst}) weekly`).toEqual(weekly);
        expect(calc("monthly", now), `${tz} ${utc} (JST ${jst}) monthly`).toEqual(monthly);
      }
      for (const [utc, expected] of ALL_TIME_CASES) {
        expect(calc("all_time", new Date(utc)), `${tz} ${utc} all_time`).toEqual(expected);
      }
      for (const [utc, expected] of UNKNOWN_CASES) {
        expect(calc("other", new Date(utc)), `${tz} ${utc} other`).toEqual(expected);
      }
    }
  });

  // 修正前の求め方 (実行環境のローカル時刻の getDay() / getDate() / getMonth() で求めて、toISOString() で UTC の暦日にする)。
  // 実行環境のタイムゾーンしだいで答えが変わることと、JST 月曜の早朝に前の週になることを示す対照実験
  function legacyWeekly(now: Date): Period {
    const dayOfWeek = now.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { periodStart: start.toISOString().split("T")[0], periodEnd: end.toISOString().split("T")[0] };
  }

  it("（対照実験）修正前の求め方は、UTC の実行環境では JST 月曜の早朝に前の週を返し、JST の実行環境でも日付がずれる", () => {
    const jstMondayMidnight = new Date("2026-07-12T15:00:00.000Z"); // JST 月曜 7/13 0:00

    process.env.TZ = "UTC"; // Supabase の Edge Runtime (Deno) と Vercel の実行環境
    expect(legacyWeekly(jstMondayMidnight)).toEqual(period("2026-07-06", "2026-07-12")); // 前の週 (Issue の不具合)

    process.env.TZ = "Asia/Tokyo"; // 日本の開発機: 週は合うが、ローカルの 0 時を UTC の暦日にするので 1 日前になる
    expect(legacyWeekly(jstMondayMidnight)).toEqual(period("2026-07-12", "2026-07-18"));

    // 修正後は、どちらの環境でも同じ (正しい) 週
    for (const tz of ["UTC", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      expect(calculateJstPeriod("weekly", jstMondayMidnight), tz).toEqual(period("2026-07-13", "2026-07-19"));
      expect(calculatePeriodLocal("weekly", jstMondayMidnight), tz).toEqual(period("2026-07-13", "2026-07-19"));
    }
  });
});

describe("Edge 用 (calculateJstPeriod) と Web 用 (calculatePeriodLocal) の一致 (#1211)", () => {
  /** start から end まで stepMinutes 刻みの時刻 */
  function* sweep(startIso: string, endIso: string, stepMinutes: number) {
    const end = new Date(endIso).getTime();
    for (let t = new Date(startIso).getTime(); t <= end; t += stepMinutes * 60_000) {
      yield new Date(t);
    }
  }

  it("年末年始・うるう日・月またぎ・週またぎを 97 分刻みで走査しても、すべての periodType で同じ期間", () => {
    const ranges: Array<[string, string]> = [
      ["2026-12-27T00:00:00Z", "2027-01-04T00:00:00Z"], // 年またぎ (週またぎも含む)
      ["2028-02-27T00:00:00Z", "2028-03-02T00:00:00Z"], // うるう日
      ["2026-07-11T00:00:00Z", "2026-07-14T12:00:00Z"], // 週またぎ (7/13 月曜)
      ["2026-07-30T00:00:00Z", "2026-08-02T12:00:00Z"], // 月またぎ (8/1)
      ["2027-02-27T00:00:00Z", "2027-03-02T00:00:00Z"], // うるう年でない年の 2 月末
    ];
    let checked = 0;
    for (const [start, end] of ranges) {
      for (const d of sweep(start, end, 97)) {
        for (const type of ["daily", "weekly", "monthly", "all_time", "other"]) {
          expect(calculateJstPeriod(type, d), `${type} ${d.toISOString()}`).toEqual(calculatePeriodLocal(type, d));
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(250);
  }, 30_000);

  it("JST 0 時ちょうどの前後 1 ミリ秒でも、すべての periodType で同じ期間", () => {
    for (const midnightUtc of [
      "2026-07-12T15:00:00.000Z", // 月曜 0 時
      "2026-07-31T15:00:00.000Z", // 月初 0 時
      "2026-12-31T15:00:00.000Z", // 元日 0 時
      "2028-02-28T15:00:00.000Z", // うるう日 0 時
    ]) {
      const t = new Date(midnightUtc).getTime();
      for (const d of [new Date(t - 1), new Date(t), new Date(t + 1)]) {
        for (const type of ["daily", "weekly", "monthly", "all_time", "other"]) {
          expect(calculateJstPeriod(type, d), `${type} ${d.toISOString()}`).toEqual(calculatePeriodLocal(type, d));
        }
      }
    }
  });

  it("now を省略した場合も、同じ現在時刻なら同じ期間", () => {
    vi.useFakeTimers();
    for (const nowUtc of ["2026-07-12T15:00:00.000Z", "2026-07-12T23:59:59.999Z", "2026-07-13T14:59:59.999Z", "2026-07-31T15:00:00.000Z"]) {
      vi.setSystemTime(new Date(nowUtc));
      for (const type of ["daily", "weekly", "monthly", "all_time", "other"]) {
        expect(calculateJstPeriod(type), `${type} ${nowUtc}`).toEqual(calculatePeriodLocal(type));
      }
    }
  });
});

describe("jstDayRangeToTimestamps: JST の暦日の範囲を、timestamptz 列を絞る時刻の範囲にする (#1211)", () => {
  it("開始日の JST 0 時 (含む) から、終了日の翌日の JST 0 時 (含まない) まで", () => {
    // 2026-07-13 (月) の週: JST 7/13 0:00 = UTC 7/12 15:00。終了日 7/19 の翌日 JST 7/20 0:00 = UTC 7/19 15:00
    expect(jstDayRangeToTimestamps("2026-07-13", "2026-07-19")).toEqual({
      from: "2026-07-12T15:00:00.000Z",
      before: "2026-07-19T15:00:00.000Z",
    });
  });

  it("1 日だけの範囲は、ちょうど 24 時間", () => {
    expect(jstDayRangeToTimestamps("2026-07-13", "2026-07-13")).toEqual({
      from: "2026-07-12T15:00:00.000Z",
      before: "2026-07-13T15:00:00.000Z",
    });
  });

  it("月末・年末・うるう日をまたいでも、終了日の翌日の 0 時になる", () => {
    expect(jstDayRangeToTimestamps("2026-07-01", "2026-07-31")).toEqual({
      from: "2026-06-30T15:00:00.000Z",
      before: "2026-07-31T15:00:00.000Z",
    });
    expect(jstDayRangeToTimestamps("2026-12-31", "2026-12-31").before).toBe("2026-12-31T15:00:00.000Z");
    expect(jstDayRangeToTimestamps("2028-02-29", "2028-02-29")).toEqual({
      from: "2028-02-28T15:00:00.000Z",
      before: "2028-02-29T15:00:00.000Z",
    });
  });

  it("calculateJstPeriod の週と組み合わせると、JST の月曜 0:00〜日曜 23:59:59.999 の食事だけが範囲に入る", () => {
    const { periodStart, periodEnd } = calculateJstPeriod("weekly", new Date("2026-07-12T15:00:00.000Z"));
    const { from, before } = jstDayRangeToTimestamps(periodStart, periodEnd);
    const inRange = (iso: string) => Date.parse(iso) >= Date.parse(from) && Date.parse(iso) < Date.parse(before);

    expect(inRange("2026-07-12T14:59:59.999Z")).toBe(false); // JST 日曜 7/12 23:59:59.999 (前の週)
    expect(inRange("2026-07-12T15:00:00.000Z")).toBe(true); // JST 月曜 7/13 0:00:00
    expect(inRange("2026-07-19T14:59:59.999Z")).toBe(true); // JST 日曜 7/19 23:59:59.999
    expect(inRange("2026-07-19T15:00:00.000Z")).toBe(false); // JST 月曜 7/20 0:00:00 (次の週)
  });

  it("不正な日付は黙って変な範囲を返さず、例外にする", () => {
    expect(() => jstDayRangeToTimestamps("not-a-date", "2026-07-19")).toThrow(RangeError);
    expect(() => jstDayRangeToTimestamps("2026-07-13", "")).toThrow(RangeError);
  });
});

// ── 今日から N 日さかのぼる期間 (#1407) ───────────────────────────────────────
//
// generate-health-insights は、期間 (前日〜今日・7 日前〜今日・30 日前〜今日) を
// new Date() の setDate(getDate() - N) と toISOString() の日付 (どちらも UTC の暦) で求めていたので、
// JST の 00:00〜08:59 は終了日が JST の昨日になり、今日の記録が分析に入らなかった。
// 期待値は、上と同じく実装とは別の計算 (Python の datetime で JST の暦を引いたもの) で求めた固定値。

describe("addDaysToDate(day, offsetDays): 暦日を N 日ずらす (#1407)", () => {
  it.each([
    // [暦日, ずらす日数, 期待する暦日, 説明]
    ["2026-07-13", -7, "2026-07-06", "同じ月の中"],
    ["2027-01-01", -30, "2026-12-02", "年をまたいで過去へ"],
    ["2026-12-31", 1, "2027-01-01", "年をまたいで未来へ"],
    ["2028-03-01", -1, "2028-02-29", "うるう年の 3/1 の前日 = 2/29"],
    ["2027-03-01", -1, "2027-02-28", "うるう年でない年の 3/1 の前日 = 2/28"],
    ["2026-01-31", 30, "2026-03-02", "月の日数の違いをまたぐ"],
    ["2024-02-29", 365, "2025-02-28", "うるう日から 365 日後"],
    ["2026-07-13", 0, "2026-07-13", "0 日はそのまま"],
  ])("%s を %i 日ずらす → %s (%s)", (day, offset, expected) => {
    expect(addDaysToDate(day, offset)).toBe(expected);
  });

  it("実行環境のタイムゾーンに左右されない", () => {
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      expect(addDaysToDate("2027-01-01", -30), tz).toBe("2026-12-02");
      expect(addDaysToDate("2028-03-01", -1), tz).toBe("2028-02-29");
    }
  });

  it("形の違う日付・存在しない日付・整数でない日数は、黙って変な日付を返さず例外にする", () => {
    expect(() => addDaysToDate("not-a-date", 1)).toThrow(RangeError);
    expect(() => addDaysToDate("2026-7-13", 1)).toThrow(RangeError);
    expect(() => addDaysToDate("2026-07-13T00:00:00Z", 1)).toThrow(RangeError);
    expect(() => addDaysToDate("2026-02-30", 0)).toThrow(RangeError);
    expect(() => addDaysToDate("2027-02-29", 0)).toThrow(RangeError);
    expect(() => addDaysToDate("2026-13-01", 0)).toThrow(RangeError);
    expect(() => addDaysToDate("2026-07-13", 1.5)).toThrow(RangeError);
    expect(() => addDaysToDate("2026-07-13", Number.NaN)).toThrow(RangeError);
  });
});

describe("calculateJstLookbackPeriod(lookbackDays, now): JST の今日から N 日さかのぼる期間 (#1407)", () => {
  /** 以前の書き方 (UTC の暦)。JST 00:00〜08:59 に 1 日前へずれることを示すために使う */
  const utcLookback = (lookbackDays: number, now: Date) => {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - lookbackDays);
    return period(start.toISOString().split("T")[0], now.toISOString().split("T")[0]);
  };

  it.each([
    // [さかのぼる日数, 現在時刻 (UTC), 期待する開始日, 期待する終了日, 説明]
    [7, "2026-07-12T14:59:59.999Z", "2026-07-05", "2026-07-12", "JST 7/12 23:59:59.999 は、まだ 7/12 が今日"],
    [7, "2026-07-12T15:00:00.000Z", "2026-07-06", "2026-07-13", "JST 7/13 0:00 ちょうどから 7/13 が今日 (UTC はまだ 7/12)"],
    [7, "2026-07-12T23:59:59.999Z", "2026-07-06", "2026-07-13", "JST 7/13 8:59:59.999 も 7/13 が今日 (UTC はまだ 7/12)"],
    [7, "2026-07-13T00:00:00.000Z", "2026-07-06", "2026-07-13", "JST 7/13 9:00 (UTC も 7/13)"],
    [1, "2026-07-31T14:59:59.999Z", "2026-07-30", "2026-07-31", "月末 JST 7/31 23:59:59.999"],
    [1, "2026-07-31T15:00:00.000Z", "2026-07-31", "2026-08-01", "月をまたぐ: JST 8/1 0:00 (UTC はまだ 7/31)"],
    [30, "2026-12-31T14:59:59.999Z", "2026-12-01", "2026-12-31", "大晦日 JST 23:59:59.999"],
    [30, "2026-12-31T15:00:00.000Z", "2026-12-02", "2027-01-01", "年をまたぐ: JST 元日 0:00 (UTC はまだ 12/31)"],
    [30, "2026-12-31T23:59:59.999Z", "2026-12-02", "2027-01-01", "年をまたぐ: JST 元日 8:59:59.999 (UTC はまだ 12/31)"],
    [7, "2027-01-06T15:00:00.000Z", "2026-12-31", "2027-01-07", "開始日だけが前の年"],
    [30, "2028-02-29T15:00:00.000Z", "2028-01-31", "2028-03-01", "うるう日の翌日 JST 3/1 0:00 (UTC はまだ 2/29)"],
    [1, "2028-02-29T15:00:00.000Z", "2028-02-29", "2028-03-01", "うるう日と、その翌日"],
    [30, "2026-03-31T20:00:00.000Z", "2026-03-02", "2026-04-01", "JST 4/1 5:00 (UTC はまだ 3/31)"],
    [0, "2026-07-12T15:00:00.000Z", "2026-07-13", "2026-07-13", "0 日なら JST の今日だけ"],
  ])("%i 日 @ %s → %s 〜 %s (%s)", (lookbackDays, nowUtc, start, end) => {
    expect(calculateJstLookbackPeriod(lookbackDays, new Date(nowUtc))).toEqual(period(start, end));
  });

  it("JST 00:00〜08:59 の 9 時間は、以前の書き方 (UTC の暦) より 1 日先の期間になる。09:00 以降は一致する", () => {
    for (let h = 0; h < 24; h++) {
      // JST 2027-01-01 の h 時 (UTC では h-9 時。h < 9 のときは UTC の 2026-12-31)
      const now = new Date(Date.UTC(2027, 0, 1, h - 9, 30, 0, 0));
      expect(calculateJstLookbackPeriod(30, now), `JST ${h}:30`).toEqual(period("2026-12-02", "2027-01-01"));
      const before = utcLookback(30, now);
      if (h < 9) expect(before, `以前の書き方 JST ${h}:30`).toEqual(period("2026-12-01", "2026-12-31"));
      else expect(before, `以前の書き方 JST ${h}:30`).toEqual(period("2026-12-02", "2027-01-01"));
    }
  });

  it("実行環境のタイムゾーンに左右されない", () => {
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      expect(calculateJstLookbackPeriod(30, new Date("2026-12-31T15:00:00.000Z")), tz).toEqual(
        period("2026-12-02", "2027-01-01"),
      );
    }
  });

  it("now を省略すると現在時刻の JST の今日を終了日にする", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-31T15:00:00.000Z"));
    expect(calculateJstLookbackPeriod(7)).toEqual(period("2026-12-25", "2027-01-01"));
  });

  it("負の数・整数でない日数・不正な Date は例外にする", () => {
    const now = new Date("2026-07-12T15:00:00.000Z");
    expect(() => calculateJstLookbackPeriod(-1, now)).toThrow(RangeError);
    expect(() => calculateJstLookbackPeriod(1.5, now)).toThrow(RangeError);
    expect(() => calculateJstLookbackPeriod(7, new Date("invalid"))).toThrow(RangeError);
  });
});

describe("calculateJstPreviousPeriod(periodType, now): now が属する期間の 1 つ前の期間 (#1406)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  /** 暦日 (YYYY-MM-DD) の JST 0 時 (UTC の時刻) */
  const jstMidnightMs = (day: string) => Date.parse(`${day}T00:00:00Z`) - JST_OFFSET_MS;
  it.each([
    // [種類, 現在時刻 (UTC), 期待する開始日, 期待する終了日, 説明]
    ["daily", "2026-10-12T15:05:00.000Z", "2026-10-12", "2026-10-12", "JST 火曜 10/13 0:05 の回 → 前日 10/12 (UTC の暦ではまだ 10/12)"],
    ["daily", "2026-10-12T14:59:59.999Z", "2026-10-11", "2026-10-11", "JST 10/12 23:59:59.999 → 前日 10/11"],
    ["weekly", "2026-10-11T15:05:00.000Z", "2026-10-05", "2026-10-11", "JST 月曜 10/12 0:05 の回 → 先週 (UTC の暦ではまだ日曜)"],
    ["weekly", "2026-10-11T14:59:59.999Z", "2026-09-28", "2026-10-04", "JST 日曜 10/11 23:59:59.999 → その前の週"],
    ["monthly", "2026-10-31T15:05:00.000Z", "2026-10-01", "2026-10-31", "JST 11/1 0:05 の回 → 10 月 (UTC の暦ではまだ 10/31)"],
    ["monthly", "2026-12-31T15:05:00.000Z", "2026-12-01", "2026-12-31", "年をまたぐ: JST 元日 0:05 → 前年 12 月"],
    ["monthly", "2028-02-29T15:05:00.000Z", "2028-02-01", "2028-02-29", "うるう年: JST 3/1 0:05 → 2 月 (29 日まで)"],
    ["daily", "2027-01-31T15:05:00.000Z", "2027-01-31", "2027-01-31", "JST 月曜 2027-02-01 0:05 (日・週・月が同時に切り替わる)"],
    ["weekly", "2027-01-31T15:05:00.000Z", "2027-01-25", "2027-01-31", "JST 月曜 2027-02-01 0:05 (日・週・月が同時に切り替わる)"],
    ["monthly", "2027-01-31T15:05:00.000Z", "2027-01-01", "2027-01-31", "JST 月曜 2027-02-01 0:05 (日・週・月が同時に切り替わる)"],
  ])("%s @ %s → %s 〜 %s (%s)", (periodType, nowUtc, start, end) => {
    expect(calculateJstPreviousPeriod(periodType, new Date(nowUtc))).toEqual(period(start, end));
  });

  it("直前の期間の終了日の翌日が、今の期間の開始日 (隙間も重なりも無い)。期間の途中のどの時刻でも同じ直前の期間になる", () => {
    for (const periodType of ["daily", "weekly", "monthly"]) {
      // JST 2026-10-01 0:30 から 1 時間おきに 40 日分
      for (let h = 0; h < 40 * 24; h++) {
        const now = new Date(Date.UTC(2026, 8, 30, 15 + h, 30, 0, 0));
        const current = calculateJstPeriod(periodType, now);
        const previous = calculateJstPreviousPeriod(periodType, now);
        const dayAfter = new Date(Date.parse(`${previous.periodEnd}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
        expect(dayAfter, `${periodType} ${now.toISOString()}`).toBe(current.periodStart);
        // 直前の期間は、その期間の最後の瞬間で求めた期間と同じ
        expect(calculateJstPeriod(periodType, new Date(jstMidnightMs(current.periodStart) - 1))).toEqual(previous);
      }
    }
  });

  it("実行環境のタイムゾーンに左右されない", () => {
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      expect(calculateJstPreviousPeriod("weekly", new Date("2026-10-11T15:05:00.000Z")), tz).toEqual(
        period("2026-10-05", "2026-10-11"),
      );
    }
  });

  it("now を省略すると現在時刻で求める", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T15:05:00.000Z"));
    expect(calculateJstPreviousPeriod("daily")).toEqual(period("2026-10-11", "2026-10-11"));
  });

  it("暦で区切らない種類 (all_time・不明な種類) と不正な Date は例外にする", () => {
    const now = new Date("2026-10-11T15:05:00.000Z");
    expect(() => calculateJstPreviousPeriod("all_time", now)).toThrow(RangeError);
    expect(() => calculateJstPreviousPeriod("yearly", now)).toThrow(RangeError);
    expect(() => calculateJstPreviousPeriod("daily", new Date("invalid"))).toThrow(RangeError);
  });

  it("isJstCalendarPeriodType は daily / weekly / monthly だけを真にする", () => {
    expect(["daily", "weekly", "monthly"].every(isJstCalendarPeriodType)).toBe(true);
    for (const value of ["all_time", "", "Daily", null, undefined, 1, true]) {
      expect(isJstCalendarPeriodType(value), String(value)).toBe(false);
    }
  });
});
