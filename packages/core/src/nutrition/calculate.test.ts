/**
 * 栄養目標計算モジュール テスト
 * 
 * 日本人の食事摂取基準（2020年版）に準拠した計算結果の検証
 */

import { describe, it, expect } from 'vitest';
import { calculateNutritionTargets, applyPerformanceGuardrails } from './calculate';
import { ageToAgeGroup, getDRIValue } from './dri-tables';
import type {
  CutStrategy,
  NutritionCalculatorInput,
  PerformanceProfile,
  TrainingPhase,
} from './types';

describe('ageToAgeGroup', () => {
  it('should map ages to correct DRI age groups', () => {
    expect(ageToAgeGroup(0)).toBe('6-11m');
    expect(ageToAgeGroup(1)).toBe('1-2');
    expect(ageToAgeGroup(2)).toBe('1-2');
    expect(ageToAgeGroup(3)).toBe('3-5');
    expect(ageToAgeGroup(18)).toBe('18-29');
    expect(ageToAgeGroup(29)).toBe('18-29');
    expect(ageToAgeGroup(30)).toBe('30-49');
    expect(ageToAgeGroup(49)).toBe('30-49');
    expect(ageToAgeGroup(50)).toBe('50-64');
    expect(ageToAgeGroup(64)).toBe('50-64');
    expect(ageToAgeGroup(65)).toBe('65-74');
    expect(ageToAgeGroup(75)).toBe('75+');
    expect(ageToAgeGroup(100)).toBe('75+');
  });
});

describe('getDRIValue', () => {
  it('should return correct vitamin C RDA for 30yo male', () => {
    const result = getDRIValue('vitamin_c_mg', '30-49', 'male', 'none');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(100);
    expect(result!.basisType).toBe('RDA');
  });

  it('should add pregnancy addition for vitamin C', () => {
    const result = getDRIValue('vitamin_c_mg', '30-49', 'female', 'pregnant');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(110); // 100 + 10
  });

  it('should add nursing addition for vitamin C', () => {
    const result = getDRIValue('vitamin_c_mg', '30-49', 'female', 'nursing');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(145); // 100 + 45
  });

  it('should return correct iron values by gender', () => {
    const male = getDRIValue('iron_mg', '30-49', 'male', 'none');
    const female = getDRIValue('iron_mg', '30-49', 'female', 'none');
    expect(male!.value).toBe(7.5);
    expect(female!.value).toBe(6.5); // 月経なしの場合
  });

  it('should treat unspecified gender as male', () => {
    const unspecified = getDRIValue('vitamin_a_ug', '30-49', 'unspecified', 'none');
    const male = getDRIValue('vitamin_a_ug', '30-49', 'male', 'none');
    expect(unspecified!.value).toBe(male!.value);
  });
});

describe('calculateNutritionTargets', () => {
  describe('BMR calculation (Mifflin-St Jeor)', () => {
    it('should calculate correct BMR for 30yo male, 70kg, 175cm', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
        height: 175,
        weight: 70,
      };
      const result = calculateNutritionTargets(input);
      
      // BMR = 10×70 + 6.25×175 - 5×30 + 5 = 700 + 1093.75 - 150 + 5 = 1648.75 ≈ 1649
      expect(result.calculationBasis.energy.bmr.result_kcal).toBe(1649);
    });

    it('should calculate correct BMR for 30yo female, 55kg, 160cm', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'female',
        height: 160,
        weight: 55,
      };
      const result = calculateNutritionTargets(input);
      
      // BMR = 10×55 + 6.25×160 - 5×30 - 161 = 550 + 1000 - 150 - 161 = 1239
      expect(result.calculationBasis.energy.bmr.result_kcal).toBe(1239);
    });
  });

  describe('PAL calculation', () => {
    it('should use sedentary PAL for sedentary work style', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
        height: 175,
        weight: 70,
        work_style: 'sedentary',
        exercise_frequency: 0,
        exercise_intensity: 'light',
      };
      const result = calculateNutritionTargets(input);
      
      // sedentary base = 1.2, exercise addition = 0.05 * (0/3) = 0
      expect(result.calculationBasis.energy.pal.base_from_work_style).toBe(1.2);
      expect(result.calculationBasis.energy.pal.result).toBe(1.2);
    });

    it('should add exercise bonus based on frequency and intensity', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
        height: 175,
        weight: 70,
        work_style: 'sedentary',
        exercise_frequency: 3,
        exercise_intensity: 'moderate',
      };
      const result = calculateNutritionTargets(input);
      
      // sedentary base = 1.2, exercise addition = 0.1 * (3/3) = 0.1
      expect(result.calculationBasis.energy.pal.exercise_addition).toBe(0.1);
      expect(result.calculationBasis.energy.pal.result).toBe(1.3);
    });

    it('should cap PAL at 2.5', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
        height: 175,
        weight: 70,
        work_style: 'very_active', // base 1.725
        exercise_frequency: 14, // 14/3 = 4.67 multiplier
        exercise_intensity: 'athlete', // 0.25 bonus
      };
      const result = calculateNutritionTargets(input);
      
      // 1.725 + (0.25 * 14/3) = 1.725 + 1.167 = 2.892 -> capped at 2.5
      expect(result.calculationBasis.energy.pal.capped).toBe(true);
      expect(result.calculationBasis.energy.pal.result).toBe(2.5);
    });
  });

  describe('Goal adjustment', () => {
    it('should subtract calories for weight loss goal', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
        height: 175,
        weight: 70,
        nutrition_goal: 'lose_weight',
        weight_change_rate: 'moderate',
      };
      const result = calculateNutritionTargets(input);
      
      expect(result.calculationBasis.energy.goal_adjustment.delta_kcal).toBe(-500);
    });

    it('should add calories for muscle gain goal', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
        height: 175,
        weight: 70,
        nutrition_goal: 'gain_muscle',
        weight_change_rate: 'moderate',
      };
      const result = calculateNutritionTargets(input);
      
      expect(result.calculationBasis.energy.goal_adjustment.delta_kcal).toBe(350);
    });

    it('should enforce minimum calories for males', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
        height: 160,
        weight: 50,
        nutrition_goal: 'lose_weight',
        weight_change_rate: 'aggressive',
      };
      const result = calculateNutritionTargets(input);
      
      expect(result.calculationBasis.energy.minimum_applied).toBe(true);
      expect(result.targetData.daily_calories).toBeGreaterThanOrEqual(1500);
    });

    it('should enforce minimum calories for females', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'female',
        height: 155,
        weight: 45,
        nutrition_goal: 'lose_weight',
        weight_change_rate: 'aggressive',
      };
      const result = calculateNutritionTargets(input);
      
      expect(result.calculationBasis.energy.minimum_applied).toBe(true);
      expect(result.targetData.daily_calories).toBeGreaterThanOrEqual(1200);
    });
  });

  describe('Pregnancy/Nursing adjustment', () => {
    it('should add 300 kcal for pregnant women', () => {
      const baseInput: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'female',
        height: 160,
        weight: 55,
        pregnancy_status: 'none',
      };
      const pregnantInput: NutritionCalculatorInput = {
        ...baseInput,
        pregnancy_status: 'pregnant',
      };
      
      const baseResult = calculateNutritionTargets(baseInput);
      const pregnantResult = calculateNutritionTargets(pregnantInput);
      
      expect(pregnantResult.targetData.daily_calories - baseResult.targetData.daily_calories).toBe(300);
    });

    it('should add 500 kcal for nursing women', () => {
      const baseInput: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'female',
        height: 160,
        weight: 55,
        pregnancy_status: 'none',
      };
      const nursingInput: NutritionCalculatorInput = {
        ...baseInput,
        pregnancy_status: 'nursing',
      };
      
      const baseResult = calculateNutritionTargets(baseInput);
      const nursingResult = calculateNutritionTargets(nursingInput);
      
      expect(nursingResult.targetData.daily_calories - baseResult.targetData.daily_calories).toBe(500);
    });

    it('should increase folic acid for pregnant women', () => {
      const normalInput: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'female',
        height: 160,
        weight: 55,
        pregnancy_status: 'none',
      };
      const pregnantInput: NutritionCalculatorInput = {
        ...normalInput,
        pregnancy_status: 'pregnant',
      };
      
      const normalResult = calculateNutritionTargets(normalInput);
      const pregnantResult = calculateNutritionTargets(pregnantInput);
      
      // 妊娠中は葉酸+240µg
      expect(pregnantResult.targetData.folic_acid_ug).toBe(normalResult.targetData.folic_acid_ug + 240);
    });
  });

  describe('Health condition adjustments', () => {
    it('should reduce sodium for hypertension', () => {
      const normalInput: NutritionCalculatorInput = {
        id: 'test-user',
        age: 50,
        gender: 'male',
        health_conditions: [],
      };
      const hypertensionInput: NutritionCalculatorInput = {
        ...normalInput,
        health_conditions: ['高血圧'],
      };
      
      const normalResult = calculateNutritionTargets(normalInput);
      const hypertensionResult = calculateNutritionTargets(hypertensionInput);
      
      expect(hypertensionResult.targetData.sodium_g).toBe(6.0);
      expect(hypertensionResult.targetData.potassium_mg).toBe(3500);
      expect(hypertensionResult.calculationBasis.health_adjustments).toBeDefined();
    });

    it('should reduce cholesterol for dyslipidemia', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 50,
        gender: 'male',
        health_conditions: ['脂質異常症'],
      };
      
      const result = calculateNutritionTargets(input);
      
      expect(result.targetData.cholesterol_mg).toBe(200);
    });

    it('should restrict potassium for kidney disease', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 50,
        gender: 'male',
        health_conditions: ['腎臓病'],
      };
      
      const result = calculateNutritionTargets(input);
      
      expect(result.targetData.potassium_mg).toBe(2000);
    });

    it('should increase iron for anemia', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'female',
        health_conditions: ['貧血'],
      };
      
      const result = calculateNutritionTargets(input);
      
      expect(result.targetData.iron_mg).toBe(15);
    });

    it('should adjust vitamin K for warfarin users', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 60,
        gender: 'male',
        medications: ['warfarin'],
      };
      
      const result = calculateNutritionTargets(input);
      
      expect(result.targetData.vitamin_k_ug).toBe(80);
    });
  });

  describe('Default values for missing fields', () => {
    it('should apply defaults and record missing fields', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        // All other fields undefined
      };
      
      const result = calculateNutritionTargets(input);
      
      expect(result.calculationBasis.missing_fields).toContain('age');
      expect(result.calculationBasis.missing_fields).toContain('gender');
      expect(result.calculationBasis.missing_fields).toContain('height');
      expect(result.calculationBasis.missing_fields).toContain('weight');
      expect(result.calculationBasis.defaults_applied).toHaveProperty('age');
      expect(result.calculationBasis.defaults_applied).toHaveProperty('gender');
    });
  });

  describe('Output structure', () => {
    it('should return all required fields in targetData', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
        height: 175,
        weight: 70,
      };
      
      const result = calculateNutritionTargets(input);
      
      // Check all 23 required nutrients
      expect(result.targetData.daily_calories).toBeGreaterThan(0);
      expect(result.targetData.protein_g).toBeGreaterThan(0);
      expect(result.targetData.fat_g).toBeGreaterThan(0);
      expect(result.targetData.carbs_g).toBeGreaterThan(0);
      expect(result.targetData.fiber_g).toBeGreaterThan(0);
      expect(result.targetData.sodium_g).toBeGreaterThan(0);
      expect(result.targetData.potassium_mg).toBeGreaterThan(0);
      expect(result.targetData.calcium_mg).toBeGreaterThan(0);
      expect(result.targetData.phosphorus_mg).toBeGreaterThan(0);
      expect(result.targetData.iron_mg).toBeGreaterThan(0);
      expect(result.targetData.zinc_mg).toBeGreaterThan(0);
      expect(result.targetData.iodine_ug).toBeGreaterThan(0);
      expect(result.targetData.cholesterol_mg).toBeGreaterThan(0);
      expect(result.targetData.vitamin_a_ug).toBeGreaterThan(0);
      expect(result.targetData.vitamin_b1_mg).toBeGreaterThan(0);
      expect(result.targetData.vitamin_b2_mg).toBeGreaterThan(0);
      expect(result.targetData.vitamin_b6_mg).toBeGreaterThan(0);
      expect(result.targetData.vitamin_b12_ug).toBeGreaterThan(0);
      expect(result.targetData.vitamin_c_mg).toBeGreaterThan(0);
      expect(result.targetData.vitamin_d_ug).toBeGreaterThan(0);
      expect(result.targetData.vitamin_e_mg).toBeGreaterThan(0);
      expect(result.targetData.vitamin_k_ug).toBeGreaterThan(0);
      expect(result.targetData.folic_acid_ug).toBeGreaterThan(0);
    });

    it('should include calculation_basis with DRI references', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user',
        age: 30,
        gender: 'male',
      };
      
      const result = calculateNutritionTargets(input);
      
      expect(result.calculationBasis.version).toBe('dri2020_v1');
      expect(result.calculationBasis.references).toBeDefined();
      expect(result.calculationBasis.references.vitamin_c_mg).toBeDefined();
      expect(result.calculationBasis.references.vitamin_c_mg.source.url).toContain('mhlw.go.jp');
    });

    it('should include user_id in targetData', () => {
      const input: NutritionCalculatorInput = {
        id: 'test-user-123',
      };
      
      const result = calculateNutritionTargets(input);
      
      expect(result.targetData.user_id).toBe('test-user-123');
    });
  });
});

// ================================================
// 急速減量ガードレール (#1208)
// ================================================

/**
 * 減量期 (phase=cut) の performance_profile を作る。
 * demandVector はすべて 0 にして、スポーツ特有調整が結果に混ざらないようにする。
 */
function makeCutProfile(
  overrides: { strategy?: CutStrategy; enabled?: boolean; phase?: TrainingPhase } = {}
): PerformanceProfile {
  return {
    sport: {
      id: 'boxing',
      experience: 'intermediate',
      phase: overrides.phase ?? 'cut',
      demandVector: {
        endurance: 0,
        power: 0,
        strength: 0,
        technique: 0,
        weightClass: 0,
        heat: 0,
        altitude: 0,
      },
    },
    cut: {
      enabled: overrides.enabled ?? true,
      strategy: overrides.strategy ?? 'rapid',
    },
  };
}

describe('applyPerformanceGuardrails: rapid cut safety (#1208)', () => {
  type GuardrailInput = Parameters<typeof applyPerformanceGuardrails>[0];

  // 他のガードレール (タンパク質下限・脂質下限・絶対最低カロリー) が発火しない値にしておく。
  // 70kg の減量期タンパク質下限は 70 × 2.0 = 140g。
  const makeInput = (overrides: Partial<GuardrailInput> = {}): GuardrailInput => ({
    age: 30,
    gender: 'male',
    weight: 70,
    tdee: 3000,
    calories: 2500,
    protein: 150,
    fat: 70,
    carbs: 300,
    performanceProfile: makeCutProfile(),
    ...overrides,
  });

  const cutSafetyOf = (result: ReturnType<typeof applyPerformanceGuardrails>) =>
    result.guardrails.filter((g) => g.type === 'cut_safety');

  describe('赤字が 1100kcal/日 (週 1kg 相当) を超える計画', () => {
    it('should raise calories to TDEE - 1100 and report cut_safety', () => {
      // TDEE 3000 に対して 1600kcal = 赤字 1400kcal/日 (週 1kg 超)
      const result = applyPerformanceGuardrails(makeInput({ tdee: 3000, calories: 1600 }));

      expect(result.calories).toBe(1900); // 3000 - 1100
      expect(result.guardrails).toEqual([
        expect.objectContaining({
          applied: true,
          type: 'cut_safety',
          original: 1600,
          adjusted: 1900,
          severity: 'warning',
        }),
      ]);
      expect(result.guardrails[0].reason).toContain('1900kcal');
    });

    it('should fire when the deficit exceeds 1100 kcal by just 1 kcal', () => {
      const result = applyPerformanceGuardrails(makeInput({ tdee: 3000, calories: 1899 }));

      expect(result.calories).toBe(1900);
      expect(cutSafetyOf(result)).toHaveLength(1);
    });

    it.each([1000, 1300, 1600, 1899])(
      'should converge to the same minimum regardless of how low the calories are (calories=%i)',
      (calories) => {
        const result = applyPerformanceGuardrails(makeInput({ tdee: 3000, calories }));

        expect(result.calories).toBe(1900);
        expect(cutSafetyOf(result)).toHaveLength(1);
        expect(cutSafetyOf(result)[0].original).toBe(calories);
      }
    );

    it.each([
      // [tdee, 期待される最低カロリー]
      [2400, 1500], // 2400 - 1100 = 1300 は男性の下限 1500 を下回るので 1500
      [3000, 1900],
      [3500, 2400],
    ])('should derive the minimum from the real TDEE (tdee=%i → %i kcal)', (tdee, expectedMin) => {
      // 同じ 1400kcal でも、TDEE が高いほど赤字が大きくなり、引き上げ先も高くなる。
      // (旧実装は calories から TDEE を逆算していたため、TDEE に関係なく常に素通りしていた)
      const result = applyPerformanceGuardrails(makeInput({ tdee, calories: 1400 }));

      expect(result.calories).toBe(expectedMin);
      expect(cutSafetyOf(result)).toHaveLength(1);
    });

    it('should not go below the male floor (1500 kcal) when TDEE - 1100 is lower', () => {
      const tooLow = applyPerformanceGuardrails(makeInput({ tdee: 2400, calories: 1400 }));
      expect(tooLow.calories).toBe(1500);

      // 下限ちょうどなら発火しない
      const atFloor = applyPerformanceGuardrails(makeInput({ tdee: 2400, calories: 1500 }));
      expect(atFloor.calories).toBe(1500);
      expect(atFloor.guardrails).toEqual([]);
    });

    it('should not go below the female floor (1200 kcal) when TDEE - 1100 is lower', () => {
      const female = { gender: 'female', weight: 55, protein: 120, fat: 50, carbs: 150 } as const;

      const tooLow = applyPerformanceGuardrails(makeInput({ ...female, tdee: 2000, calories: 1100 }));
      expect(tooLow.calories).toBe(1200); // 2000 - 1100 = 900 は女性の下限 1200 を下回る
      expect(cutSafetyOf(tooLow)).toHaveLength(1);

      const atFloor = applyPerformanceGuardrails(makeInput({ ...female, tdee: 2000, calories: 1200 }));
      expect(atFloor.calories).toBe(1200);
      expect(atFloor.guardrails).toEqual([]);
    });
  });

  describe('赤字が 1100kcal/日 以内の計画 (安全な計画)', () => {
    it.each([
      [3000, 1900], // 赤字ちょうど 1100 (境界値)
      [3000, 2250], // 赤字 750 (現行の「積極的」減量の最大)
      [3000, 2500], // 赤字 500 (通常の減量)
      [3000, 3000], // 赤字なし
    ])('should not fire (tdee=%i, calories=%i)', (tdee, calories) => {
      const result = applyPerformanceGuardrails(makeInput({ tdee, calories }));

      expect(result.calories).toBe(calories);
      expect(result.guardrails).toEqual([]);
    });
  });

  describe('急速減量のガードレールが対象外になる条件', () => {
    // どの条件でも「TDEE 3000 に対して 1600kcal (赤字 1400)」のまま素通りする
    const tooFast = { tdee: 3000, calories: 1600 } as const;

    it('should not fire when the strategy is gradual', () => {
      const result = applyPerformanceGuardrails(
        makeInput({ ...tooFast, performanceProfile: makeCutProfile({ strategy: 'gradual' }) })
      );

      expect(result.calories).toBe(1600);
      expect(result.guardrails).toEqual([]);
    });

    it('should not fire when the cut is disabled', () => {
      const result = applyPerformanceGuardrails(
        makeInput({ ...tooFast, performanceProfile: makeCutProfile({ enabled: false }) })
      );

      expect(result.calories).toBe(1600);
      expect(result.guardrails).toEqual([]);
    });

    it.each<TrainingPhase>(['training', 'competition', 'recovery'])(
      'should not fire when the training phase is %s (not cut)',
      (phase) => {
        const result = applyPerformanceGuardrails(
          makeInput({ ...tooFast, performanceProfile: makeCutProfile({ phase }) })
        );

        expect(result.calories).toBe(1600);
        expect(result.guardrails).toEqual([]);
      }
    );

    it.each([null, undefined])('should not fire without a performance profile (%s)', (performanceProfile) => {
      const result = applyPerformanceGuardrails(makeInput({ ...tooFast, performanceProfile }));

      expect(result.calories).toBe(1600);
      expect(result.guardrails).toEqual([]);
    });
  });
});

describe('calculateNutritionTargets: rapid cut strategy (#1208)', () => {
  // TDEE が大きいユーザー。BMR 1911 × PAL 1.75 = TDEE 3344kcal
  const baseInput: NutritionCalculatorInput = {
    id: 'rapid-cut-user',
    age: 30,
    gender: 'male',
    height: 185,
    weight: 90,
    work_style: 'moderately_active',
    exercise_intensity: 'intense',
    exercise_frequency: 4,
    nutrition_goal: 'lose_weight',
    weight_change_rate: 'aggressive',
  };

  it('should leave a safe plan untouched even when the strategy is rapid', () => {
    // 現行の減量設定の赤字は最大 750kcal/日 で、急速減量の上限 1100kcal/日 に届かない。
    // 実際の TDEE を渡しても、通常の計算結果が変わらない (ガードレールが誤発火しない) ことを確認する。
    const withProfile = calculateNutritionTargets({
      ...baseInput,
      performance_profile: makeCutProfile({ strategy: 'rapid' }),
    });
    const withoutProfile = calculateNutritionTargets(baseInput);

    const { tdee_kcal, final_kcal } = withProfile.calculationBasis.energy;
    // 前提: 減量計画であり、赤字は週 1kg 相当 (1100kcal/日) 以内
    const deficit = tdee_kcal - final_kcal;
    expect(deficit).toBeGreaterThan(0);
    expect(deficit).toBeLessThanOrEqual(1100);

    expect(withProfile.targetData.daily_calories).toBe(final_kcal);
    expect(withProfile.targetData.daily_calories).toBe(withoutProfile.targetData.daily_calories);
    expect(withProfile.calculationBasis.guardrails).toBeUndefined();
  });
});
