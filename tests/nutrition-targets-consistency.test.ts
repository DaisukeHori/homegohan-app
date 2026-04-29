/**
 * nutrition-targets-consistency.test.ts
 *
 * Bug-fix: #17, #42
 *
 * 同一プロフィールを buildNutritionCalculatorInput() に渡したとき、
 * 4 ルート相当の呼び出しが bit-exact に同じ NutritionCalculatorInput を生成することを保証する。
 *
 * さらに calculateNutritionTargets() が決定論的であること（同じ入力 → 同じ BMR/TDEE/calories）も確認。
 */

import { describe, expect, it } from "vitest";
import { buildNutritionCalculatorInput } from "../src/lib/build-nutrition-input";
import { calculateNutritionTargets } from "@homegohan/core";

// テスト用プロフィール（DB スネークケース形式）
const BASE_PROFILE: Record<string, unknown> = {
  age: 32,
  gender: "male",
  height: 175,
  weight: 70,
  work_style: "sedentary",
  exercise_intensity: "moderate",
  exercise_frequency: 3,
  exercise_duration_per_session: 60,
  nutrition_goal: "maintain",
  weight_change_rate: "moderate",
  health_conditions: [],
  medications: [],
  pregnancy_status: "none",
};

const USER_ID = "test-user-000";

describe("buildNutritionCalculatorInput", () => {
  it("4ルート相当の呼び出しが bit-exact に同じ入力を生成する", () => {
    // profile/route.ts パターン
    const fromProfileRoute = buildNutritionCalculatorInput(BASE_PROFILE, USER_ID);

    // nutrition-targets/calculate/route.ts パターン（同じ shape）
    const fromCalculateRoute = buildNutritionCalculatorInput(BASE_PROFILE, USER_ID);

    // nutrition/targets/route.ts パターン（profile が optional なので ?? {} を使う）
    const profileOrEmpty = BASE_PROFILE ?? {};
    const fromTargetsRoute = buildNutritionCalculatorInput(profileOrEmpty, USER_ID);

    // onboarding/complete/route.ts パターン（performance_profile なし）
    const fromOnboardingRoute = buildNutritionCalculatorInput(BASE_PROFILE, USER_ID, {});

    expect(fromProfileRoute).toEqual(fromCalculateRoute);
    expect(fromCalculateRoute).toEqual(fromTargetsRoute);
    expect(fromTargetsRoute).toEqual(fromOnboardingRoute);
  });

  it("NULL フィールドがあっても同じ shape を返す（defaults は calculateNutritionTargets が補完）", () => {
    const profileWithNulls: Record<string, unknown> = {
      age: null,
      gender: null,
      height: null,
      weight: null,
      work_style: null,
      exercise_intensity: null,
      exercise_frequency: null,
      exercise_duration_per_session: null,
      nutrition_goal: null,
      weight_change_rate: null,
      health_conditions: null,
      medications: null,
      pregnancy_status: null,
    };

    const input = buildNutritionCalculatorInput(profileWithNulls, USER_ID);

    // 全フィールドが存在すること（undefined ではなく null または undefined が来てもキーは存在）
    expect(Object.keys(input)).toContain("age");
    expect(Object.keys(input)).toContain("gender");
    expect(Object.keys(input)).toContain("height");
    expect(Object.keys(input)).toContain("weight");
    // health_conditions / medications は [] にフォールバック
    expect(input.health_conditions).toEqual([]);
    expect(input.medications).toEqual([]);
  });

  it("performance_profile が extra に渡されたとき入力に含まれる", () => {
    const fakePerformanceProfile = { sport: { id: "soccer" } };
    const input = buildNutritionCalculatorInput(BASE_PROFILE, USER_ID, {
      performance_profile: fakePerformanceProfile,
    });
    expect(input.performance_profile).toEqual(fakePerformanceProfile);
  });

  it("extra なしのとき performance_profile キー自体が存在しない（onboarding 以外のルートに対応）", () => {
    const input = buildNutritionCalculatorInput(BASE_PROFILE, USER_ID);
    expect("performance_profile" in input).toBe(false);
  });
});

describe("calculateNutritionTargets — 決定論的な出力", () => {
  it("同じ入力を 2 回渡すと bit-exact に同じ calories/BMR/TDEE を返す", () => {
    const input = buildNutritionCalculatorInput(BASE_PROFILE, USER_ID);

    const result1 = calculateNutritionTargets(input);
    const result2 = calculateNutritionTargets(input);

    expect(result1.summary.calories).toBe(result2.summary.calories);
    expect(result1.summary.bmr).toBe(result2.summary.bmr);
    expect(result1.summary.tdee).toBe(result2.summary.tdee);
    expect(result1.targetData.daily_calories).toBe(result2.targetData.daily_calories);
    expect(result1.targetData.protein_g).toBe(result2.targetData.protein_g);
    expect(result1.targetData.fat_g).toBe(result2.targetData.fat_g);
    expect(result1.targetData.carbs_g).toBe(result2.targetData.carbs_g);
  });

  it("NULL 入力のとき missing_fields と defaults_applied が返される（#42: 概算ラベル根拠）", () => {
    const nullInput = buildNutritionCalculatorInput({}, USER_ID);
    const result = calculateNutritionTargets(nullInput);

    expect(result.calculationBasis.missing_fields.length).toBeGreaterThan(0);
    expect(Object.keys(result.calculationBasis.defaults_applied).length).toBeGreaterThan(0);
  });

  it("exercise_frequency=0 と null では計算結果が異なることを確認（BMR 変動の再現テスト）", () => {
    // exercise_frequency=null → defaults で 3 回として計算
    const inputDefault = buildNutritionCalculatorInput(
      { ...BASE_PROFILE, exercise_frequency: null },
      USER_ID
    );
    // exercise_frequency=0 → 明示的に 0 として計算
    const inputZero = buildNutritionCalculatorInput(
      { ...BASE_PROFILE, exercise_frequency: 0 },
      USER_ID
    );

    const resultDefault = calculateNutritionTargets(inputDefault);
    const resultZero = calculateNutritionTargets(inputZero);

    // PAL が異なるので calories が異なるはず
    expect(resultDefault.summary.calories).not.toBe(resultZero.summary.calories);
  });
});
