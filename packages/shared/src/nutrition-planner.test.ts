/**
 * nutrition-planner ユニットテスト
 *
 * Refactor E (PR #908) で packages/shared に集約された純粋 PFC 計算関数の初の unit test。
 */

import { describe, it, expect } from 'vitest';
import { deriveMacroTargets, estimateGoalProjection } from './nutrition-planner';

describe('deriveMacroTargets', () => {
  describe('基本的な PFC 計算', () => {
    it('代表的な入力値で PFC グラムを正しく計算する', () => {
      // 2000 kcal, P:30% F:25% C:45%
      const result = deriveMacroTargets({
        dailyCalories: 2000,
        ratios: { protein: 0.3, fat: 0.25, carbs: 0.45 },
      });

      // protein: 2000 * 0.3 / 4 = 150g
      expect(result.proteinG).toBe(150);
      // fat: 2000 * 0.25 / 9 ≈ 55.6g
      expect(result.fatG).toBe(55.6);
      // carbs: 残カロリー / 4
      // remaining after protein: 2000 - 150*4 = 1400
      // remaining after fat: 1400 - 55.6*9 ≈ 1400 - 500.4 = 899.6 → 899.6/4 ≈ 224.9g
      expect(result.carbsG).toBeCloseTo(224.9, 0);
    });

    it('lose_weight ゴールの場合はタンパク質フロア (体重×1.2g) が適用される', () => {
      // 1800 kcal, P:20%, 70kgユーザー → フロア = 70 * 1.2 = 84g
      // ratio だと: 1800 * 0.20 / 4 = 90g > 84g → フロア不発動
      const resultNoFloor = deriveMacroTargets({
        dailyCalories: 1800,
        ratios: { protein: 0.2, fat: 0.3, carbs: 0.5 },
        currentWeightKg: 70,
        nutritionGoal: 'lose_weight',
      });
      expect(resultNoFloor.proteinG).toBe(90);

      // ratio が低い場合にフロアが発動する: P:10% → 1800*0.1/4=45g < 84g → 84g に引き上げ
      const resultWithFloor = deriveMacroTargets({
        dailyCalories: 1800,
        ratios: { protein: 0.1, fat: 0.3, carbs: 0.6 },
        currentWeightKg: 70,
        nutritionGoal: 'lose_weight',
      });
      expect(resultWithFloor.proteinG).toBe(84);
    });

    it('maintain_weight ゴールではタンパク質フロアが適用されない', () => {
      // maintain ゴールはフロア対象外
      const result = deriveMacroTargets({
        dailyCalories: 1800,
        ratios: { protein: 0.1, fat: 0.3, carbs: 0.6 },
        currentWeightKg: 70,
        nutritionGoal: 'maintain_weight',
      });
      // フロア未適用: 1800 * 0.1 / 4 = 45g
      expect(result.proteinG).toBe(45);
    });

    it('gain_muscle ゴールはタンパク質フロア適用対象', () => {
      const result = deriveMacroTargets({
        dailyCalories: 2500,
        ratios: { protein: 0.05, fat: 0.3, carbs: 0.65 },
        currentWeightKg: 80,
        nutritionGoal: 'gain_muscle',
      });
      // フロア = 80 * 1.2 = 96g
      // ratio = 2500 * 0.05 / 4 = 31.25g < 96g → 96g
      expect(result.proteinG).toBe(96);
    });
  });

  describe('エッジケース', () => {
    it('dailyCalories = 0 の場合すべて 0 を返す', () => {
      const result = deriveMacroTargets({
        dailyCalories: 0,
        ratios: { protein: 0.3, fat: 0.25, carbs: 0.45 },
      });
      expect(result.proteinG).toBe(0);
      expect(result.fatG).toBe(0);
      expect(result.carbsG).toBe(0);
    });

    it('dailyCalories が負の場合は 0 として扱う', () => {
      const result = deriveMacroTargets({
        dailyCalories: -500,
        ratios: { protein: 0.3, fat: 0.25, carbs: 0.45 },
      });
      expect(result.proteinG).toBe(0);
      expect(result.fatG).toBe(0);
      expect(result.carbsG).toBe(0);
    });

    it('currentWeightKg が null の場合はフロアなしで計算される', () => {
      const result = deriveMacroTargets({
        dailyCalories: 1800,
        ratios: { protein: 0.1, fat: 0.3, carbs: 0.6 },
        currentWeightKg: null,
        nutritionGoal: 'lose_weight',
      });
      // フロア適用なし: 1800 * 0.1 / 4 = 45g
      expect(result.proteinG).toBe(45);
    });

    it('タンパク質が最大値 (dailyCalories/4) を超えないようキャップされる', () => {
      // フロアが高すぎる場合のガード
      // 500 kcal, 体重500kg (フロア=600g, 最大=125g)
      const result = deriveMacroTargets({
        dailyCalories: 500,
        ratios: { protein: 0.1, fat: 0.3, carbs: 0.6 },
        currentWeightKg: 500,
        nutritionGoal: 'lose_weight',
      });
      // proteinG は max 500/4 = 125g にキャップ
      expect(result.proteinG).toBe(125);
      // 残カロリー = 500 - 125*4 = 0 → fat/carbs は 0
      expect(result.fatG).toBe(0);
      expect(result.carbsG).toBe(0);
    });
  });
});

describe('estimateGoalProjection', () => {
  describe('到達可能ケース', () => {
    it('減量方向の正常ケースで estimatedDays と direction を正しく計算する', () => {
      // 70kg → 65kg (diff = -5kg), TDEE=2200, 摂取=1700 (gap=-500)
      // days = ceil(5 * 7700 / 500) = ceil(77) = 77
      const result = estimateGoalProjection({
        currentWeightKg: 70,
        targetWeightKg: 65,
        dailyCalories: 1700,
        tdeeKcal: 2200,
        startDate: new Date('2024-01-01T00:00:00'),
      });

      expect(result.reachable).toBe(true);
      if (result.reachable) {
        expect(result.direction).toBe('lose');
        expect(result.estimatedDays).toBe(77);
        expect(result.dailyEnergyGapKcal).toBe(-500);
      }
    });

    it('増量方向の正常ケースで direction = gain を返す', () => {
      // 60kg → 65kg (diff = +5kg), TDEE=2000, 摂取=2500 (gap=+500)
      const result = estimateGoalProjection({
        currentWeightKg: 60,
        targetWeightKg: 65,
        dailyCalories: 2500,
        tdeeKcal: 2000,
        startDate: new Date('2024-01-01T00:00:00'),
      });

      expect(result.reachable).toBe(true);
      if (result.reachable) {
        expect(result.direction).toBe('gain');
        expect(result.estimatedDays).toBe(77);
      }
    });

    it('estimatedDate は startDate + estimatedDays であること', () => {
      const startDate = new Date('2024-01-01T00:00:00');
      const result = estimateGoalProjection({
        currentWeightKg: 70,
        targetWeightKg: 65,
        dailyCalories: 1700,
        tdeeKcal: 2200,
        startDate,
      });

      expect(result.reachable).toBe(true);
      if (result.reachable) {
        const expected = new Date('2024-01-01T00:00:00');
        expected.setDate(expected.getDate() + result.estimatedDays);
        expect(result.estimatedDate).toBe(expected.toISOString());
      }
    });
  });

  describe('到達不能ケース', () => {
    it('減量したいのに摂取カロリーが TDEE 以上の場合 reachable = false', () => {
      const result = estimateGoalProjection({
        currentWeightKg: 70,
        targetWeightKg: 65,
        dailyCalories: 2500,
        tdeeKcal: 2000,
      });

      expect(result.reachable).toBe(false);
      if (!result.reachable) {
        expect(result.reason).toContain('減量');
      }
    });

    it('増量したいのに摂取カロリーが TDEE 以下の場合 reachable = false', () => {
      const result = estimateGoalProjection({
        currentWeightKg: 60,
        targetWeightKg: 65,
        dailyCalories: 1800,
        tdeeKcal: 2000,
      });

      expect(result.reachable).toBe(false);
      if (!result.reachable) {
        expect(result.reason).toContain('増量');
      }
    });

    it('現在体重と目標体重が同じ場合 reachable = false', () => {
      const result = estimateGoalProjection({
        currentWeightKg: 70,
        targetWeightKg: 70,
        dailyCalories: 2000,
        tdeeKcal: 2000,
      });

      expect(result.reachable).toBe(false);
      if (!result.reachable) {
        expect(result.reason).toContain('同じ');
      }
    });

    it('必須入力が null の場合 reachable = false', () => {
      const result = estimateGoalProjection({
        currentWeightKg: null,
        targetWeightKg: 65,
        dailyCalories: 1700,
        tdeeKcal: 2200,
      });

      expect(result.reachable).toBe(false);
    });

    it('必須入力が undefined の場合 reachable = false', () => {
      const result = estimateGoalProjection({});

      expect(result.reachable).toBe(false);
    });

    it('エネルギー差が 0 に丸められる極小差の場合 reachable = false', () => {
      // dailyCalories = 2000.1, TDEE = 2000.0 → gap = 0.1 → round1 → 0.1 → effectiveGap < 1 ではない
      // effectiveGap < 1 になるケース: 差が 0.4 未満
      const result = estimateGoalProjection({
        currentWeightKg: 70,
        targetWeightKg: 65,
        dailyCalories: 1999.7,
        tdeeKcal: 2000.0, // gap = -0.3 → round1 → 0.0 → effectiveGap = 0.0 < 1
      });

      // gap は -0.3 → round1 → 0.0 → wantsToLose=true かつ gap=0 → reachable=false 条件 (>=0) に入る
      expect(result.reachable).toBe(false);
    });
  });
});
