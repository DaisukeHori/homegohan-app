/**
 * tests/onboarding-answers-schema.test.ts
 *
 * Issue #1045 (F6-12): /api/onboarding/progress の answers 無バリデーション対策として
 * 追加した src/schemas/onboarding.ts の contract テスト。
 */

import { describe, expect, it } from "vitest";
import {
  OnboardingAnswersSchema,
  NICKNAME_MAX_LENGTH,
  OCCUPATION_MAX_LENGTH,
  TAG_MAX_LENGTH,
  TAG_MAX_COUNT,
} from "../src/schemas/onboarding";

describe("#1045 round-2: クライアント側 UI (questions/page.tsx) と共有する上限定数", () => {
  // src/app/onboarding/questions/page.tsx の maxLength と
  // src/app/onboarding/questions/tag-input.ts の addTagsFromInput が
  // これらの定数を import しており、値が変わればクライアント側の入力上限も追従する。
  it("nickname/occupation の上限は 100 文字である", () => {
    expect(NICKNAME_MAX_LENGTH).toBe(100);
    expect(OCCUPATION_MAX_LENGTH).toBe(100);
  });

  it("タグの上限は 1件30文字・最大30件である", () => {
    expect(TAG_MAX_LENGTH).toBe(30);
    expect(TAG_MAX_COUNT).toBe(30);
  });
});

describe("OnboardingAnswersSchema", () => {
  it("age が数値文字列でない場合 (#1045: age='abc') は無効", () => {
    const result = OnboardingAnswersSchema.safeParse({ age: "abc" });
    expect(result.success).toBe(false);
  });

  it("age が範囲外 (0 や 200) の場合は無効", () => {
    expect(OnboardingAnswersSchema.safeParse({ age: "0" }).success).toBe(false);
    expect(OnboardingAnswersSchema.safeParse({ age: "200" }).success).toBe(false);
  });

  it("age が妥当な数値文字列の場合は有効", () => {
    expect(OnboardingAnswersSchema.safeParse({ age: "25" }).success).toBe(true);
    expect(OnboardingAnswersSchema.safeParse({ age: 25 }).success).toBe(true);
  });

  it("gender が enum 外の場合は無効", () => {
    const result = OnboardingAnswersSchema.safeParse({ gender: "abc" });
    expect(result.success).toBe(false);
  });

  it("gender が enum 内の場合は有効", () => {
    expect(OnboardingAnswersSchema.safeParse({ gender: "male" }).success).toBe(true);
    expect(OnboardingAnswersSchema.safeParse({ gender: "unspecified" }).success).toBe(true);
  });

  it("nickname が 100 文字を超える場合は無効 (最大長)", () => {
    const result = OnboardingAnswersSchema.safeParse({ nickname: "a".repeat(101) });
    expect(result.success).toBe(false);
  });

  it("<script> を含む nickname はそれ自体では拒否されない (raw 保存前提)", () => {
    const result = OnboardingAnswersSchema.safeParse({ nickname: "<script>alert(1)</script>" });
    expect(result.success).toBe(true);
  });

  it("nutrition_goal が enum 外の場合は無効", () => {
    expect(OnboardingAnswersSchema.safeParse({ nutrition_goal: "get_rich" }).success).toBe(false);
  });

  it("nutrition_goal が enum 内の場合は有効", () => {
    expect(OnboardingAnswersSchema.safeParse({ nutrition_goal: "athlete_performance" }).success).toBe(true);
  });

  it("exercise_types に未知の値が含まれる場合は無効", () => {
    const result = OnboardingAnswersSchema.safeParse({ exercise_types: ["running", "unknown_sport"] });
    expect(result.success).toBe(false);
  });

  it("既知フィールドが全て未指定 (空オブジェクト) でも有効 (途中経過保存)", () => {
    expect(OnboardingAnswersSchema.safeParse({}).success).toBe(true);
  });

  it("未知のフィールドが含まれていてもエラーにしない (前方互換)", () => {
    const result = OnboardingAnswersSchema.safeParse({ some_future_field: "x", nickname: "たろう" });
    expect(result.success).toBe(true);
  });

  it("servings_config は default とレンジ内の byDayMeal のみ許可する", () => {
    const valid = OnboardingAnswersSchema.safeParse({
      servings_config: {
        default: 3,
        byDayMeal: { monday: { breakfast: 3, lunch: 0, dinner: 3 } },
      },
    });
    expect(valid.success).toBe(true);

    const invalid = OnboardingAnswersSchema.safeParse({
      servings_config: { default: 999 },
    });
    expect(invalid.success).toBe(false);
  });
});
