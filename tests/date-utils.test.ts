/**
 * tests/date-utils.test.ts
 *
 * src/lib/date-utils.ts の todayLocal / formatLocalDate が
 * JST (Asia/Tokyo, UTC+9) の「今日」を正しく返すことを確認する。
 *
 * UTC 0:00〜8:59 は「前日」になるバグの回帰防止テスト。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { todayLocal, formatLocalDate } from "../src/lib/date-utils";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * UTC 時刻文字列から Date を生成して Date.now() をモックする。
 * toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) が JST 日付を返すことを検証。
 */
function mockDateNow(utcIso: string) {
  const ms = new Date(utcIso).getTime();
  vi.useFakeTimers();
  vi.setSystemTime(ms);
}

describe("todayLocal()", () => {
  it("JST 0:30 (UTC 前日 15:30) → JST の今日を返す", () => {
    // 例: JST 2026-04-30 00:30 = UTC 2026-04-29 15:30
    mockDateNow("2026-04-29T15:30:00Z");
    expect(todayLocal()).toBe("2026-04-30");
  });

  it("JST 8:59 (UTC 前日 23:59) → JST の今日を返す", () => {
    // JST 2026-04-30 08:59 = UTC 2026-04-29 23:59
    mockDateNow("2026-04-29T23:59:00Z");
    expect(todayLocal()).toBe("2026-04-30");
  });

  it("JST 9:00 (UTC 当日 00:00) → JST の今日を返す", () => {
    // JST 2026-04-30 09:00 = UTC 2026-04-30 00:00
    mockDateNow("2026-04-30T00:00:00Z");
    expect(todayLocal()).toBe("2026-04-30");
  });

  it("JST 18:00 (UTC 当日 09:00) → JST の今日を返す", () => {
    // JST 2026-04-30 18:00 = UTC 2026-04-30 09:00
    mockDateNow("2026-04-30T09:00:00Z");
    expect(todayLocal()).toBe("2026-04-30");
  });
});

describe("formatLocalDate(date)", () => {
  it("UTC 2026-04-29T15:30Z の Date を渡すと JST 2026-04-30 を返す", () => {
    const d = new Date("2026-04-29T15:30:00Z");
    expect(formatLocalDate(d)).toBe("2026-04-30");
  });

  it("UTC 2026-04-29T23:59Z の Date を渡すと JST 2026-04-30 を返す", () => {
    const d = new Date("2026-04-29T23:59:00Z");
    expect(formatLocalDate(d)).toBe("2026-04-30");
  });

  it("UTC 2026-04-30T00:00Z の Date を渡すと JST 2026-04-30 を返す", () => {
    const d = new Date("2026-04-30T00:00:00Z");
    expect(formatLocalDate(d)).toBe("2026-04-30");
  });
});
