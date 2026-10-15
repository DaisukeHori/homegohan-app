// @vitest-environment node
/**
 * tests/e2e/helpers/jst-week.ts (jstThisMonday) の単体テスト (#1564)
 *
 * 献立の週のページは、ブラウザ (Asia/Tokyo) の JST の週で今週の月曜日を決める。
 * e2e の側で月曜日をプロセスのローカル時刻 (CI は UTC) で作っていたので、JST の月曜 0:00〜8:59 は 1 週間前の月曜日になり、
 * `getDate() - getDay() + 1` の形は日曜日に次の週の月曜日になっていた。
 * 時計を JST の 0:30 (UTC ではまだ前日) と 9:30 (UTC でも同じ日) に固定し、どのタイムゾーンで動いても JST の週の月曜日を返すことを確かめる。
 * あわせて、bug-20 の TODAY に使う todayLocal が JST の暦日になること、直した spec に古い形が戻っていないことを見張る。
 * 残りの候補 (Issue #1564 の最後のコメント) と、同じ型で見つけたもの (食品庫・冷蔵庫の期限の日付) も同じく見張る。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDaysToDate, todayLocal } from "../packages/shared/src/date-utils";
import { jstThisMonday } from "./e2e/helpers/jst-week";
import { inEachTimeZone, localOffsetMinutesOn20260101, withTimeZone } from "./helpers/time-zones";

/** 2026-10-12 (月) JST 0:30。UTC ではまだ 10/11 (日) 15:30 */
const JST_MONDAY_0030 = new Date("2026-10-11T15:30:00.000Z");
/** 2026-10-12 (月) JST 9:30。UTC でも 10/12 (月) 0:30 */
const JST_MONDAY_0930 = new Date("2026-10-12T00:30:00.000Z");
/** 2026-10-18 (日) JST 0:30。UTC では 10/17 (土) 15:30 */
const JST_SUNDAY_0030 = new Date("2026-10-17T15:30:00.000Z");
/** 2026-10-18 (日) JST 9:30。UTC でも 10/18 (日) 0:30 (`getDate() - getDay() + 1` だと次の週の 10/19 になる) */
const JST_SUNDAY_0930 = new Date("2026-10-18T00:30:00.000Z");
/** 上の時刻がすべて属する、JST の月曜日始まりの週の月曜日 */
const EXPECTED_MONDAY = "2026-10-12";
/** JST 0:30 / 9:30 の月曜日の、JST の暦日 */
const EXPECTED_MONDAY_TODAY = "2026-10-12";
/** 食品庫・冷蔵庫の spec が期限に使うずらしの日数 (r10-org-pantry-deep の B-18 / B-19 / B-24、modal-interaction-fridge-shopping の昨日・3 日後) */
const EXPIRY_OFFSETS_DAYS = [-1, 2, 3, 7] as const;
/** 上の日数を JST の月曜日 (EXPECTED_MONDAY_TODAY) からずらした JST の暦日 */
const EXPECTED_EXPIRY_DATES = ["2026-10-11", "2026-10-14", "2026-10-15", "2026-10-19"];

/** UTC のずれ (分)。UTC は 0、Asia/Tokyo は -540 (タイムゾーンの切り替えが効いていることの確認に使う) */
const UTC_OFFSET_MINUTES = 0;
const JST_OFFSET_MINUTES = -540;

afterEach(() => {
  vi.useRealTimers();
});

describe("jstThisMonday: JST の今週の月曜日 (#1564)", () => {
  it("タイムゾーンの切り替えが効いている (効いていなければ下のテストは何も確かめていない)", () => {
    expect(withTimeZone("UTC", localOffsetMinutesOn20260101)).toBe(UTC_OFFSET_MINUTES);
    expect(withTimeZone("Asia/Tokyo", localOffsetMinutesOn20260101)).toBe(JST_OFFSET_MINUTES);
  });

  it.each([
    ["月曜 JST 0:30 (UTC ではまだ日曜)", JST_MONDAY_0030],
    ["月曜 JST 9:30", JST_MONDAY_0930],
    ["日曜 JST 0:30 (UTC では土曜)", JST_SUNDAY_0030],
    ["日曜 JST 9:30", JST_SUNDAY_0930],
  ])("%s は、どのタイムゾーンで動いても JST の週の月曜日になる", (_label, now) => {
    for (const { tz, value } of inEachTimeZone(() => jstThisMonday(now))) {
      expect({ tz, value }).toEqual({ tz, value: EXPECTED_MONDAY });
    }
  });

  it.each([
    ["JST 0:30", JST_MONDAY_0030],
    ["JST 9:30", JST_MONDAY_0930],
  ])("引数を省くと今の時計で求める (時計を月曜 %s に固定・プロセスは UTC)", (_label, now) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(withTimeZone("UTC", () => jstThisMonday())).toBe(EXPECTED_MONDAY);
  });

  it.each([
    ["JST 0:30", JST_MONDAY_0030],
    ["JST 9:30", JST_MONDAY_0930],
  ])("bug-20 の TODAY (todayLocal) は JST の暦日 (時計を月曜 %s に固定・プロセスは UTC)", (_label, now) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(withTimeZone("UTC", () => todayLocal())).toBe(EXPECTED_MONDAY_TODAY);
  });

  it.each([
    ["JST 0:30", JST_MONDAY_0030],
    ["JST 9:30", JST_MONDAY_0930],
  ])("期限の日付 addDaysToDate(todayLocal(), n) は JST の今日からずらす (時計を月曜 %s に固定・プロセスは UTC)", (_label, now) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const dates = withTimeZone("UTC", () => EXPIRY_OFFSETS_DAYS.map((offset) => addDaysToDate(todayLocal(), offset)));
    expect(dates).toEqual(EXPECTED_EXPIRY_DATES);
  });
});

describe("#1564 で直した e2e の spec に、プロセスのローカル時刻で週・今日を作る形が戻っていない", () => {
  const e2eDir = path.join(__dirname, "e2e");
  /** JST の今週の月曜日を jstThisMonday で作る spec */
  const WEEK_SPECS = [
    "w5-3-menu-gen-adversarial.spec.ts",
    "wave2-f2-queue-reliability.spec.ts",
    "bug-04-cache-refetch-after-generation.spec.ts",
    "bug-01-15-19-queue-flow.spec.ts",
    "bug-03-progress-bar-server-sync.spec.ts",
    "adversarial-deep.spec.ts",
    "w5-11-catalog-adversarial.spec.ts",
    ".exploration/weekly-explore.spec.ts",
  ];
  /** JST の今日・前後の日を todayLocal / addDaysToDate で作る spec */
  const CALENDAR_DAY_SPECS = [
    ".exploration/weekly-explore.spec.ts",
    "r10-org-pantry-deep.spec.ts",
    "refactor-baseline/modal-interaction-fridge-shopping.spec.ts",
  ];
  /** 上の spec 全部 (UTC の toISOString から暦日を切り出す形が戻っていないことを見る) */
  const ALL_FIXED_SPECS = [...new Set([...WEEK_SPECS, ...CALENDAR_DAY_SPECS])];
  /** e2e の helpers/jst-week の import (spec の置き場所により ./ か ../) */
  const JST_WEEK_IMPORT = /from "(\.\.?\/)+helpers\/jst-week"/;
  /** packages/shared の date-utils の import */
  const DATE_UTILS_IMPORT = /from "(\.\.\/)+packages\/shared\/src\/date-utils"/;
  /** toISOString (UTC) から YYYY-MM-DD を切り出す形 (プロセスでもブラウザでも UTC の暦日になる) */
  const UTC_DATE_SLICE = /toISOString\(\)\.(split\(["']T["']\)|slice\(0, ?10\)|substring\(0, ?10\))/;
  /** JST の今日を todayLocal で作る spec */
  const TODAY_SPEC = "bug-20-checkin-mapping.spec.ts";
  /** プロセスのローカル時刻で曜日を読み日をずらす呼び出し (週の月曜日を自前で作っているしるし) */
  const LOCAL_WEEK_ARITHMETIC = /\.(getDay|getDate|setDate)\(/;
  /** プロセスのローカル時刻の年月日を読む呼び出し (今日を自前で作っているしるし) */
  const LOCAL_DATE_GETTER = /\.(getFullYear|getMonth|getDate)\(\)/;

  const read = (name: string) => fs.readFileSync(path.join(e2eDir, name), "utf8");

  it.each(WEEK_SPECS)("%s は jstThisMonday を使い、ローカル時刻の曜日から週を作らない", (name) => {
    const source = read(name);
    expect(source).toMatch(JST_WEEK_IMPORT);
    expect(source).toContain("jstThisMonday()");
    expect(source).not.toMatch(LOCAL_WEEK_ARITHMETIC);
    expect(source).not.toContain("getThisMonday");
  });

  it.each(CALENDAR_DAY_SPECS)("%s は todayLocal / addDaysToDate を使い、ローカル時刻の日付から暦日を作らない", (name) => {
    const source = read(name);
    expect(source).toMatch(DATE_UTILS_IMPORT);
    expect(source).toContain("todayLocal()");
    expect(source).toContain("addDaysToDate(");
    expect(source).not.toMatch(LOCAL_WEEK_ARITHMETIC);
    expect(source).not.toMatch(LOCAL_DATE_GETTER);
  });

  it.each(ALL_FIXED_SPECS)("%s は toISOString (UTC) から暦日を切り出さない", (name) => {
    expect(read(name)).not.toMatch(UTC_DATE_SLICE);
  });

  it(`${TODAY_SPEC} の TODAY は todayLocal (JST の暦日)`, () => {
    const source = read(TODAY_SPEC);
    expect(source).toContain("const TODAY = todayLocal();");
    expect(source).not.toMatch(LOCAL_DATE_GETTER);
  });
});
