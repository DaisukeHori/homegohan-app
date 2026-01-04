import { describe, it, expect } from "vitest";

import {
  DEFAULT_STEP1_DAY_BATCH,
  DEFAULT_STEP2_FIXES_PER_RUN,
  DEFAULT_STEP2_FIXES_PER_WEEK,
  DEFAULT_STEP2_MAX_FIXES_CAP,
  DEFAULT_STEP3_SLOT_BATCH,
  countGeneratedTargetSlots,
  computeMaxFixesForRange,
  computeNextCursor,
  computeWeeksFromDays,
  getSlotKey,
  normalizeTargetSlots,
  sortTargetSlots,
  uniqDatesFromSlots,
  type TargetSlot,
} from "../supabase/functions/generate-menu-v4/step-utils";

describe("V4 Supabase Functions - step utils", () => {
  it("exports default constants", () => {
    expect(DEFAULT_STEP1_DAY_BATCH).toBeGreaterThan(0);
    expect(DEFAULT_STEP2_FIXES_PER_RUN).toBeGreaterThan(0);
    expect(DEFAULT_STEP2_FIXES_PER_WEEK).toBeGreaterThan(0);
    expect(DEFAULT_STEP2_MAX_FIXES_CAP).toBeGreaterThan(0);
    expect(DEFAULT_STEP3_SLOT_BATCH).toBeGreaterThan(0);
  });

  it("getSlotKey formats as YYYY-MM-DD:mealType", () => {
    expect(getSlotKey("2026-01-03", "dinner")).toBe("2026-01-03:dinner");
  });

  describe("normalizeTargetSlots", () => {
    it("normalizes snake_case records", () => {
      const out = normalizeTargetSlots([
        { date: "2026-01-03", meal_type: "breakfast", planned_meal_id: "pm1" },
      ]);
      expect(out).toEqual([{ date: "2026-01-03", mealType: "breakfast", plannedMealId: "pm1" }]);
    });

    it("normalizes camelCase records", () => {
      const out = normalizeTargetSlots([{ date: "2026-01-03", mealType: "lunch", plannedMealId: "pm2" }]);
      expect(out).toEqual([{ date: "2026-01-03", mealType: "lunch", plannedMealId: "pm2" }]);
    });

    it("filters invalid date", () => {
      const out = normalizeTargetSlots([{ date: "2026/01/03", meal_type: "dinner" }]);
      expect(out).toEqual([]);
    });

    it("filters missing mealType", () => {
      const out = normalizeTargetSlots([{ date: "2026-01-03" }]);
      expect(out).toEqual([]);
    });
  });

  it("uniqDatesFromSlots de-dupes and sorts", () => {
    const slots: TargetSlot[] = [
      { date: "2026-01-05", mealType: "dinner" },
      { date: "2026-01-03", mealType: "breakfast" },
      { date: "2026-01-05", mealType: "lunch" },
    ];
    expect(uniqDatesFromSlots(slots)).toEqual(["2026-01-03", "2026-01-05"]);
  });

  describe("sortTargetSlots", () => {
    it("sorts by date then mealType order", () => {
      const slots: TargetSlot[] = [
        { date: "2026-01-03", mealType: "dinner" },
        { date: "2026-01-03", mealType: "breakfast" },
        { date: "2026-01-02", mealType: "lunch" },
        { date: "2026-01-03", mealType: "snack" },
      ];
      expect(sortTargetSlots(slots)).toEqual([
        { date: "2026-01-02", mealType: "lunch" },
        { date: "2026-01-03", mealType: "breakfast" },
        { date: "2026-01-03", mealType: "dinner" },
        { date: "2026-01-03", mealType: "snack" },
      ]);
    });

    it("does not mutate input", () => {
      const slots: TargetSlot[] = [
        { date: "2026-01-03", mealType: "dinner" },
        { date: "2026-01-03", mealType: "breakfast" },
      ];
      const original = [...slots];
      sortTargetSlots(slots);
      expect(slots).toEqual(original);
    });
  });

  it("countGeneratedTargetSlots counts only generated keys for targetSlots", () => {
    const targets: TargetSlot[] = [
      { date: "2026-01-03", mealType: "breakfast" },
      { date: "2026-01-03", mealType: "lunch" },
      { date: "2026-01-03", mealType: "dinner" },
    ];
    const generated = {
      "2026-01-03:breakfast": { ok: true },
      "2026-01-03:dinner": { ok: true },
      // not in target:
      "2026-01-04:breakfast": { ok: true },
    };
    expect(countGeneratedTargetSlots(targets, generated)).toBe(2);
  });

  describe("computeWeeksFromDays", () => {
    it("returns 1 for non-positive days", () => {
      expect(computeWeeksFromDays(0)).toBe(1);
      expect(computeWeeksFromDays(-10)).toBe(1);
    });

    it("maps 1..7 days to 1 week", () => {
      expect(computeWeeksFromDays(1)).toBe(1);
      expect(computeWeeksFromDays(7)).toBe(1);
    });

    it("maps 8 days to 2 weeks", () => {
      expect(computeWeeksFromDays(8)).toBe(2);
    });

    it("maps 14 days to 2 weeks", () => {
      expect(computeWeeksFromDays(14)).toBe(2);
    });

    it("maps 15 days to 3 weeks", () => {
      expect(computeWeeksFromDays(15)).toBe(3);
    });

    it("maps 31 days to 5 weeks", () => {
      expect(computeWeeksFromDays(31)).toBe(5);
    });
  });

  describe("computeMaxFixesForRange", () => {
    it("returns 0 when issuesCount is 0", () => {
      expect(computeMaxFixesForRange({ days: 7, issuesCount: 0 })).toBe(0);
    });

    it("caps at 2 per 7 days (when issues are abundant)", () => {
      expect(computeMaxFixesForRange({ days: 7, issuesCount: 999 })).toBe(2);
    });

    it("scales to 4 fixes for 14 days", () => {
      expect(computeMaxFixesForRange({ days: 14, issuesCount: 999 })).toBe(4);
    });

    it("scales to 10 fixes for 31 days", () => {
      expect(computeMaxFixesForRange({ days: 31, issuesCount: 999 })).toBe(10);
    });

    it("does not exceed issuesCount", () => {
      expect(computeMaxFixesForRange({ days: 31, issuesCount: 3 })).toBe(3);
    });

    it("applies cap for long ranges", () => {
      expect(computeMaxFixesForRange({ days: 365, issuesCount: 999, cap: 12 })).toBe(12);
    });

    it("supports custom fixesPerWeek", () => {
      expect(computeMaxFixesForRange({ days: 7, issuesCount: 999, fixesPerWeek: 3 })).toBe(3);
    });
  });

  describe("computeNextCursor", () => {
    it("increments by batchSize", () => {
      expect(computeNextCursor({ cursor: 0, batchSize: 6, length: 31 })).toBe(6);
    });

    it("clamps to length", () => {
      expect(computeNextCursor({ cursor: 28, batchSize: 6, length: 31 })).toBe(31);
    });

    it("treats negative cursor as 0", () => {
      expect(computeNextCursor({ cursor: -5, batchSize: 3, length: 10 })).toBe(3);
    });

    it("treats batchSize <= 0 as 1", () => {
      expect(computeNextCursor({ cursor: 0, batchSize: 0, length: 10 })).toBe(1);
    });
  });
});

