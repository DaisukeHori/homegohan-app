/**
 * buildNutritionCalculatorInput のテスト
 * packages/core 共有の栄養計算入力を正しく組み立てるかを検証する
 */
import { buildNutritionCalculatorInput } from '../../../../src/lib/build-nutrition-input';

describe('buildNutritionCalculatorInput', () => {
  const BASE_PROFILE: Record<string, unknown> = {
    age: 30,
    gender: 'male',
    height: 175,
    weight: 70,
    work_style: 'sedentary',
    exercise_intensity: 'moderate',
    exercise_frequency: 3,
    exercise_duration_per_session: 60,
    nutrition_goal: 'maintain',
    weight_change_rate: null,
    health_conditions: ['diabetes'],
    medications: ['metformin'],
    pregnancy_status: null,
  };

  describe('基本的な入力組み立て', () => {
    it('userId が id フィールドにセットされる', () => {
      const result = buildNutritionCalculatorInput(BASE_PROFILE, 'user-123');
      expect(result.id).toBe('user-123');
    });

    it('プロフィールの各フィールドが正しくマッピングされる', () => {
      const result = buildNutritionCalculatorInput(BASE_PROFILE, 'user-123');
      expect(result.age).toBe(30);
      expect(result.gender).toBe('male');
      expect(result.height).toBe(175);
      expect(result.weight).toBe(70);
      expect(result.work_style).toBe('sedentary');
      expect(result.exercise_intensity).toBe('moderate');
      expect(result.exercise_frequency).toBe(3);
      expect(result.exercise_duration_per_session).toBe(60);
      expect(result.nutrition_goal).toBe('maintain');
    });

    it('health_conditions が配列でマッピングされる', () => {
      const result = buildNutritionCalculatorInput(BASE_PROFILE, 'user-123');
      expect(result.health_conditions).toEqual(['diabetes']);
    });

    it('medications が配列でマッピングされる', () => {
      const result = buildNutritionCalculatorInput(BASE_PROFILE, 'user-123');
      expect(result.medications).toEqual(['metformin']);
    });
  });

  describe('null/undefined の処理', () => {
    it('health_conditions が null の場合は空配列になる', () => {
      const profile = { ...BASE_PROFILE, health_conditions: null };
      const result = buildNutritionCalculatorInput(profile, 'user-123');
      expect(result.health_conditions).toEqual([]);
    });

    it('medications が null の場合は空配列になる', () => {
      const profile = { ...BASE_PROFILE, medications: null };
      const result = buildNutritionCalculatorInput(profile, 'user-123');
      expect(result.medications).toEqual([]);
    });

    it('health_conditions が undefined の場合は空配列になる', () => {
      const profile = { ...BASE_PROFILE, health_conditions: undefined };
      const result = buildNutritionCalculatorInput(profile, 'user-123');
      expect(result.health_conditions).toEqual([]);
    });

    it('age が null の場合は null がそのまま渡る', () => {
      const profile = { ...BASE_PROFILE, age: null };
      const result = buildNutritionCalculatorInput(profile, 'user-123');
      expect(result.age).toBeNull();
    });

    it('gender が null の場合は null がそのまま渡る', () => {
      const profile = { ...BASE_PROFILE, gender: null };
      const result = buildNutritionCalculatorInput(profile, 'user-123');
      expect(result.gender).toBeNull();
    });
  });

  describe('extra フィールド', () => {
    it('performance_profile なしで呼んだ場合はフィールドが含まれない', () => {
      const result = buildNutritionCalculatorInput(BASE_PROFILE, 'user-123');
      expect('performance_profile' in result).toBe(false);
    });

    it('performance_profile を渡した場合はフィールドが含まれる', () => {
      const perfProfile = { sport: 'running', level: 'intermediate' };
      const result = buildNutritionCalculatorInput(BASE_PROFILE, 'user-123', {
        performance_profile: perfProfile,
      });
      expect(result.performance_profile).toEqual(perfProfile);
    });

    it('extra が空オブジェクトの場合はperformance_profileが含まれない', () => {
      const result = buildNutritionCalculatorInput(BASE_PROFILE, 'user-123', {});
      expect('performance_profile' in result).toBe(false);
    });
  });

  describe('pregnancy_status', () => {
    it('pregnancy_status が設定されている場合にマッピングされる', () => {
      const profile = { ...BASE_PROFILE, gender: 'female', pregnancy_status: 'pregnant' };
      const result = buildNutritionCalculatorInput(profile, 'user-456');
      expect(result.pregnancy_status).toBe('pregnant');
    });

    it('pregnancy_status が null の場合は null がそのまま渡る', () => {
      const result = buildNutritionCalculatorInput(BASE_PROFILE, 'user-456');
      expect(result.pregnancy_status).toBeNull();
    });
  });

  describe('異なる userId での生成', () => {
    it('複数の userId で呼んだ場合、それぞれ正しい id が返る', () => {
      const r1 = buildNutritionCalculatorInput(BASE_PROFILE, 'user-aaa');
      const r2 = buildNutritionCalculatorInput(BASE_PROFILE, 'user-bbb');
      expect(r1.id).toBe('user-aaa');
      expect(r2.id).toBe('user-bbb');
    });
  });
});
