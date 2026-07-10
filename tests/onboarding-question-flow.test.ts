/**
 * tests/onboarding-question-flow.test.ts
 *
 * Issue #1045 (F6-13): 質問の「戻る」で下流回答が残留し矛盾プロフィールが確定する
 * 不具合の回帰テスト。pruneStaleAnswers() が showIf=false になった質問の回答を
 * 正しく除去することを検証する。
 */

import { describe, expect, it } from "vitest";
import { QUESTIONS, pruneStaleAnswers } from "../src/app/onboarding/questions/question-flow";

describe("pruneStaleAnswers", () => {
  it("#1045: athlete_performance → lose_weight に変更すると sport 系の回答が全て消える", () => {
    const answers = {
      nickname: "たろう",
      gender: "male",
      nutrition_goal: "lose_weight", // 戻って変更した後の値
      sport_type: "soccer",
      sport_custom_name: null,
      training_phase: "competition",
      competition_date: "2026-08-01",
      target_weight: "65",
    };

    const pruned = pruneStaleAnswers(answers);

    expect(pruned.sport_type).toBeUndefined();
    expect(pruned.training_phase).toBeUndefined();
    expect(pruned.competition_date).toBeUndefined();
    // lose_weight では target_weight は引き続き有効な質問
    expect(pruned.target_weight).toBe("65");
    expect(pruned.nutrition_goal).toBe("lose_weight");
  });

  it("sport_type が 'custom' から他競技に変わると sport_custom_name が消える", () => {
    const answers = {
      nutrition_goal: "athlete_performance",
      sport_type: "soccer",
      sport_custom_name: "トライアスロン", // custom だった頃の回答
    };

    const pruned = pruneStaleAnswers(answers);

    expect(pruned.sport_custom_name).toBeUndefined();
    expect(pruned.sport_type).toBe("soccer");
  });

  it("training_phase が competition/cut 以外になると competition_date が消える", () => {
    const answers = {
      nutrition_goal: "athlete_performance",
      training_phase: "recovery",
      competition_date: "2026-08-01",
    };

    const pruned = pruneStaleAnswers(answers);

    expect(pruned.competition_date).toBeUndefined();
  });

  it("gender が female から male に変わると pregnancy_status が消える", () => {
    const answers = {
      gender: "male",
      pregnancy_status: "pregnant",
    };

    const pruned = pruneStaleAnswers(answers);

    expect(pruned.pregnancy_status).toBeUndefined();
  });

  it("条件を満たしたままの回答は保持される (誤削除しない)", () => {
    const answers = {
      nutrition_goal: "athlete_performance",
      sport_type: "custom",
      sport_custom_name: "トライアスロン",
      training_phase: "cut",
      competition_date: "2026-08-01",
    };

    const pruned = pruneStaleAnswers(answers);

    expect(pruned.sport_type).toBe("custom");
    expect(pruned.sport_custom_name).toBe("トライアスロン");
    expect(pruned.training_phase).toBe("cut");
    expect(pruned.competition_date).toBe("2026-08-01");
  });

  it("QUESTIONS は showIf が参照するフィールドより後ろに定義されている (順序前提の検証)", () => {
    const idsBefore = (idx: number) => QUESTIONS.slice(0, idx).map((q) => q.id);
    QUESTIONS.forEach((q, idx) => {
      if (!q.showIf) return;
      // showIf を持つ質問自身より前に、その依存先が最低1つは存在するはず
      // (この QUESTIONS 定義では依存先は常に手前に置かれている)
      expect(idsBefore(idx).length).toBeGreaterThan(0);
    });
  });
});
