// #1210: JST (Asia/Tokyo, UTC+9) の日付ヘルパーの単体テスト。
//
// - Edge Functions 用: supabase/functions/_shared/jst-date.ts (formatJstDate / todayJst)
// - Web / Mobile 用   : src/lib/date-utils.ts → packages/shared (formatLocalDate / todayLocal)
//
// 日付の変わり目 (JST 0 時 = UTC 15 時) と、JST 00:00〜08:59 の 9 時間
// (UTC の暦日だと「前日」になる時間帯) を中心に確かめる。
// 2 つの実装が同じ日付を返すこと (パリティ) も確かめる。

import { afterEach, describe, expect, it, vi } from "vitest";

import { formatLocalDate, todayLocal } from "../src/lib/date-utils";
import { JST_OFFSET_MS, formatJstDate, todayJst } from "../supabase/functions/_shared/jst-date.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** 以前の書き方 (UTC の暦日)。JST 00:00〜08:59 に前日になることを示すために使う。 */
const utcDate = (d: Date) => d.toISOString().split("T")[0];

/** JST で 2026-07-13 の h 時 0 分 (UTC では h-9 時。h < 9 のときは UTC の前日になる) */
const jstHourOn0713 = (h: number) => new Date(Date.UTC(2026, 6, 13, h - 9, 0, 0, 0));

describe("JST_OFFSET_MS", () => {
  it("UTC+9 時間 (ミリ秒)", () => {
    expect(JST_OFFSET_MS).toBe(32_400_000);
  });
});

describe("formatJstDate(date): その時刻が属する JST の暦日 (Edge 用)", () => {
  it("JST の 0 時〜23 時のどの時刻でも、同じ JST の日付 (2026-07-13) を返す", () => {
    for (let h = 0; h < 24; h++) {
      expect(formatJstDate(jstHourOn0713(h)), `JST ${h}:00`).toBe("2026-07-13");
    }
  });

  it("UTC の暦日が前日になる JST 00:00〜08:59 の 9 時間でも、JST の日付を返す", () => {
    for (let h = 0; h < 9; h++) {
      const d = jstHourOn0713(h);
      expect(utcDate(d), `UTC の暦日 (JST ${h}:00)`).toBe("2026-07-12"); // 以前の書き方はここがズレていた
      expect(formatJstDate(d), `JST ${h}:00`).toBe("2026-07-13");
    }
    // JST 09:00 以降は UTC の暦日と一致する
    for (let h = 9; h < 24; h++) {
      const d = jstHourOn0713(h);
      expect(utcDate(d), `UTC の暦日 (JST ${h}:00)`).toBe("2026-07-13");
      expect(formatJstDate(d), `JST ${h}:00`).toBe("2026-07-13");
    }
  });

  it("日付の変わり目: JST 0 時ちょうど (UTC 15:00:00.000) で翌日になる", () => {
    expect(formatJstDate(new Date("2026-07-12T14:59:59.999Z"))).toBe("2026-07-12"); // JST 7/12 23:59:59.999
    expect(formatJstDate(new Date("2026-07-12T15:00:00.000Z"))).toBe("2026-07-13"); // JST 7/13 00:00:00.000
  });

  it("JST 08:59:59.999 と 09:00:00.000 はどちらも同じ日付", () => {
    expect(formatJstDate(new Date("2026-07-12T23:59:59.999Z"))).toBe("2026-07-13"); // JST 7/13 08:59:59.999
    expect(formatJstDate(new Date("2026-07-13T00:00:00.000Z"))).toBe("2026-07-13"); // JST 7/13 09:00:00.000
  });

  it.each([
    // [UTC の時刻, 期待する JST の日付, 説明]
    ["2026-07-31T14:59:59.999Z", "2026-07-31", "月末 JST 23:59:59.999"],
    ["2026-07-31T15:00:00.000Z", "2026-08-01", "月初 JST 00:00:00 (UTC はまだ 7/31)"],
    ["2026-12-31T14:59:59.999Z", "2026-12-31", "大晦日 JST 23:59:59.999"],
    ["2026-12-31T15:00:00.000Z", "2027-01-01", "元日 JST 00:00:00 (UTC はまだ 12/31)"],
    ["2028-02-28T15:00:00.000Z", "2028-02-29", "うるう日 JST 00:00:00"],
    ["2028-02-29T15:00:00.000Z", "2028-03-01", "うるう日の翌日 JST 00:00:00"],
    ["2027-02-28T15:00:00.000Z", "2027-03-01", "うるう年でない年の 2/28 の翌日 = 3/1"],
    ["2026-01-01T00:00:00.000Z", "2026-01-01", "UTC 元日 0 時 = JST 元日 9 時"],
  ])("%s → %s (%s)", (utcIso, expected) => {
    expect(formatJstDate(new Date(utcIso))).toBe(expected);
  });

  it("YYYY-MM-DD 形式 (ゼロ埋め) で返す", () => {
    expect(formatJstDate(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
    expect(formatJstDate(new Date("2026-07-12T16:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("不正な Date は黙って変な日付を返さず、例外にする", () => {
    expect(() => formatJstDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("todayJst(now?): JST の今日 (Edge 用)", () => {
  it("Issue の再現例: UTC 2026-07-12 16:00 (JST 7/13 01:00) の「今日」は 2026-07-13", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T16:00:00Z"));
    expect(utcDate(new Date())).toBe("2026-07-12"); // 以前の書き方だと前日になっていた
    expect(todayJst()).toBe("2026-07-13");
  });

  it("引数なしは現在時刻を使い、JST 0 時で日付が変わる", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-07-12T14:59:59.999Z")); // JST 7/12 23:59:59.999
    expect(todayJst()).toBe("2026-07-12");

    vi.setSystemTime(new Date("2026-07-12T15:00:00.000Z")); // JST 7/13 00:00:00.000
    expect(todayJst()).toBe("2026-07-13");

    vi.setSystemTime(new Date("2026-07-12T23:59:59.999Z")); // JST 7/13 08:59:59.999
    expect(todayJst()).toBe("2026-07-13");

    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z")); // JST 7/13 09:00:00.000
    expect(todayJst()).toBe("2026-07-13");

    vi.setSystemTime(new Date("2026-07-13T14:59:59.999Z")); // JST 7/13 23:59:59.999
    expect(todayJst()).toBe("2026-07-13");

    vi.setSystemTime(new Date("2026-07-13T15:00:00.000Z")); // JST 7/14 00:00:00.000
    expect(todayJst()).toBe("2026-07-14");
  });

  it("now を渡したときは、システム時計ではなく now を基準にする", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(todayJst(new Date("2026-07-12T16:00:00Z"))).toBe("2026-07-13");
  });
});

describe("Web 側ヘルパー (todayLocal / formatLocalDate) も JST 00:00〜08:59 で前日にならない", () => {
  it("formatLocalDate: JST の 0 時〜23 時のどの時刻でも、同じ JST の日付 (2026-07-13) を返す", () => {
    for (let h = 0; h < 24; h++) {
      expect(formatLocalDate(jstHourOn0713(h)), `JST ${h}:00`).toBe("2026-07-13");
    }
  });

  it("formatLocalDate: JST 0 時ちょうどで日付が変わる", () => {
    expect(formatLocalDate(new Date("2026-07-12T14:59:59.999Z"))).toBe("2026-07-12");
    expect(formatLocalDate(new Date("2026-07-12T15:00:00.000Z"))).toBe("2026-07-13");
  });

  it("todayLocal: Issue の再現例 (UTC 2026-07-12 16:00 = JST 7/13 01:00) は 2026-07-13", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T16:00:00Z"));
    expect(todayLocal()).toBe("2026-07-13");
  });
});

describe("Edge 用 (formatJstDate / todayJst) と Web 用 (formatLocalDate / todayLocal) の一致", () => {
  /** start から end まで stepMinutes 刻みの時刻 */
  function* sweep(startIso: string, endIso: string, stepMinutes: number) {
    const end = new Date(endIso).getTime();
    for (let t = new Date(startIso).getTime(); t <= end; t += stepMinutes * 60_000) {
      yield new Date(t);
    }
  }

  it("年末年始・うるう日・月またぎ・夏の期間を 37 分刻みで走査しても、すべて同じ日付", () => {
    const ranges: Array<[string, string]> = [
      ["2026-12-30T00:00:00Z", "2027-01-03T00:00:00Z"], // 年またぎ
      ["2028-02-27T00:00:00Z", "2028-03-02T00:00:00Z"], // うるう日
      ["2026-07-30T00:00:00Z", "2026-08-02T00:00:00Z"], // 月またぎ
      ["2026-04-28T00:00:00Z", "2026-05-02T00:00:00Z"], // 連休の月またぎ
    ];
    let checked = 0;
    for (const [start, end] of ranges) {
      for (const d of sweep(start, end, 37)) {
        expect(formatJstDate(d), d.toISOString()).toBe(formatLocalDate(d, "Asia/Tokyo"));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("JST 0 時ちょうどの前後 1 ミリ秒でも同じ日付", () => {
    for (const midnightUtc of [
      "2026-07-12T15:00:00.000Z",
      "2026-12-31T15:00:00.000Z",
      "2028-02-28T15:00:00.000Z",
      "2028-02-29T15:00:00.000Z",
    ]) {
      const t = new Date(midnightUtc).getTime();
      for (const d of [new Date(t - 1), new Date(t), new Date(t + 1)]) {
        expect(formatJstDate(d), d.toISOString()).toBe(formatLocalDate(d, "Asia/Tokyo"));
      }
    }
  });

  it("todayJst() と todayLocal() は同じ「今日」を返す", () => {
    vi.useFakeTimers();
    for (const nowUtc of [
      "2026-07-12T15:00:00.000Z",
      "2026-07-12T16:00:00.000Z",
      "2026-07-12T23:59:59.999Z",
      "2026-07-13T00:00:00.000Z",
      "2026-07-13T14:59:59.999Z",
    ]) {
      vi.setSystemTime(new Date(nowUtc));
      expect(todayJst(), nowUtc).toBe(todayLocal());
    }
  });
});
