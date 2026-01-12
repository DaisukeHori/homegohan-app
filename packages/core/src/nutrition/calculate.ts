/**
 * 栄養目標計算モジュール - メイン計算ロジック
 * 
 * 日本人の食事摂取基準（2020年版）に準拠
 * Single Source of Truth: Web/Mobileで共通利用
 */

import {
  type NutritionCalculatorInput,
  type NutritionCalculationResult,
  type NutritionTargetData,
  type NutritionTargetSummary,
  type CalculationBasis,
  type EnergyCalculationBasis,
  type MacrosCalculationBasis,
  type NutrientReference,
  type Gender,
  type NutritionGoal,
  type WeightChangeRate,
  type PregnancyStatus,
  type PerformanceProfile,
  type GuardrailResult,
} from './types';

import {
  ageToAgeGroup,
  getDRIValue,
  DRI_TABLES,
  DRI2020_SOURCES,
  CHOLESTEROL_APP_DEFAULT,
  SUGAR_APP_DEFAULT,
} from './dri-tables';

// ================================================
// デフォルト値（欠損時のフォールバック）
// ================================================

const DEFAULTS = {
  age: 30,
  gender: 'unspecified' as Gender,
  height: 165,
  weight: 60,
  work_style: 'sedentary',
  exercise_intensity: 'moderate',
  exercise_frequency: 3,
  nutrition_goal: 'maintain' as NutritionGoal,
  weight_change_rate: 'moderate' as WeightChangeRate,
  pregnancy_status: 'none' as PregnancyStatus,
} as const;

// ================================================
// 活動係数テーブル
// ================================================

const WORK_STYLE_PAL: Record<string, number> = {
  sedentary: 1.2,
  light_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  student: 1.375,
  homemaker: 1.375,
};

const EXERCISE_BONUS: Record<string, number> = {
  light: 0.05,
  moderate: 0.1,
  intense: 0.15,
  athlete: 0.25,
};

// ================================================
// メイン計算関数
// ================================================

/**
 * プロフィールから栄養目標を計算する
 * 
 * @param profile - ユーザープロフィール（DBのスネークケース形式想定）
 * @returns 計算結果（targetData, summary, calculationBasis）
 */
export function calculateNutritionTargets(
  profile: NutritionCalculatorInput
): NutritionCalculationResult {
  const now = new Date().toISOString();
  
  // ================================================
  // 1. 入力の正規化（欠損値はデフォルト適用）
  // ================================================
  const missingFields: string[] = [];
  const defaultsApplied: Record<string, unknown> = {};
  
  const resolveField = <T>(
    fieldName: string,
    value: T | null | undefined,
    defaultValue: T
  ): T => {
    if (value === null || value === undefined) {
      missingFields.push(fieldName);
      defaultsApplied[fieldName] = defaultValue;
      return defaultValue;
    }
    return value;
  };
  
  const age = resolveField('age', profile.age, DEFAULTS.age);
  const gender = resolveField('gender', profile.gender, DEFAULTS.gender);
  const height = resolveField('height', profile.height, DEFAULTS.height);
  const weight = resolveField('weight', profile.weight, DEFAULTS.weight);
  const workStyle = resolveField('work_style', profile.work_style, DEFAULTS.work_style);
  const exerciseIntensity = resolveField('exercise_intensity', profile.exercise_intensity, DEFAULTS.exercise_intensity);
  const exerciseFrequency = resolveField('exercise_frequency', profile.exercise_frequency, DEFAULTS.exercise_frequency);
  const nutritionGoal = resolveField('nutrition_goal', profile.nutrition_goal, DEFAULTS.nutrition_goal);
  const weightChangeRate = resolveField('weight_change_rate', profile.weight_change_rate, DEFAULTS.weight_change_rate);
  const pregnancyStatus = resolveField('pregnancy_status', profile.pregnancy_status, DEFAULTS.pregnancy_status);
  const healthConditions: string[] = profile.health_conditions || [];
  const medications: string[] = profile.medications || [];
  
  // DRI年齢階級
  const ageGroup = ageToAgeGroup(age);
  
  // ================================================
  // 2. エネルギー計算（BMR → PAL → TDEE → 目標調整）
  // ================================================
  const energyCalc = calculateEnergy({
    age,
    gender,
    height,
    weight,
    workStyle,
    exerciseIntensity,
    exerciseFrequency,
    nutritionGoal,
    weightChangeRate,
    pregnancyStatus,
  });
  
  // ================================================
  // 3. PFC計算
  // ================================================
  const macrosCalc = calculateMacros({
    calories: energyCalc.final_kcal,
    weight,
    nutritionGoal,
    healthConditions,
  });
  
  // ================================================
  // 4. 微量栄養素（DRI2020参照）
  // ================================================
  const micronutrients = calculateMicronutrients({
    ageGroup,
    gender,
    pregnancyStatus,
    healthConditions,
    medications,
    calories: energyCalc.final_kcal,
  });

  // ================================================
  // 4.5. Performance OS v3 ガードレール適用
  // ================================================
  const performanceProfile = profile.performance_profile ?? null;
  const guardrailResult = applyPerformanceGuardrails({
    age,
    gender,
    weight,
    calories: energyCalc.final_kcal,
    protein: macrosCalc.values.protein,
    fat: macrosCalc.values.fat,
    carbs: macrosCalc.values.carbs,
    performanceProfile,
  });

  // ガードレールで調整された値を反映
  const finalCalories = guardrailResult.calories;
  const finalProtein = guardrailResult.protein;
  const finalFat = guardrailResult.fat;
  const finalCarbs = guardrailResult.carbs;

  // ================================================
  // 5. 計算根拠の構築
  // ================================================
  const calculationBasis: CalculationBasis = {
    version: 'dri2020_v1',
    calculated_at: now,
    inputs: {
      age,
      gender,
      height,
      weight,
      work_style: workStyle,
      exercise_intensity: exerciseIntensity,
      exercise_frequency: exerciseFrequency,
      nutrition_goal: nutritionGoal,
      weight_change_rate: weightChangeRate,
      health_conditions: healthConditions,
      medications,
      pregnancy_status: pregnancyStatus,
    },
    missing_fields: missingFields,
    defaults_applied: defaultsApplied,
    energy: energyCalc,
    macros: macrosCalc.basis,
    references: micronutrients.references,
    upper_limits: micronutrients.upperLimits,
    health_adjustments: micronutrients.healthAdjustments,
    guardrails: guardrailResult.guardrails.length > 0 ? guardrailResult.guardrails : undefined,
    performance_profile: performanceProfile ?? undefined,
  };
  
  // ================================================
  // 6. 出力データの構築（ガードレール適用後の値を使用）
  // ================================================
  const targetData: NutritionTargetData = {
    user_id: profile.id,
    daily_calories: finalCalories,
    protein_g: finalProtein,
    fat_g: finalFat,
    carbs_g: finalCarbs,
    fiber_g: micronutrients.values.fiber_g,
    fiber_soluble_g: Math.round(micronutrients.values.fiber_g / 3),
    fiber_insoluble_g: Math.round(micronutrients.values.fiber_g * 2 / 3),
    sodium_g: micronutrients.values.sodium_g,
    sugar_g: micronutrients.values.sugar_g,
    potassium_mg: micronutrients.values.potassium_mg,
    calcium_mg: micronutrients.values.calcium_mg,
    phosphorus_mg: micronutrients.values.phosphorus_mg,
    iron_mg: micronutrients.values.iron_mg,
    zinc_mg: micronutrients.values.zinc_mg,
    iodine_ug: micronutrients.values.iodine_ug,
    cholesterol_mg: micronutrients.values.cholesterol_mg,
    vitamin_b1_mg: round2(micronutrients.values.vitamin_b1_mg),
    vitamin_b2_mg: round2(micronutrients.values.vitamin_b2_mg),
    vitamin_c_mg: micronutrients.values.vitamin_c_mg,
    vitamin_b6_mg: micronutrients.values.vitamin_b6_mg,
    vitamin_b12_ug: micronutrients.values.vitamin_b12_ug,
    folic_acid_ug: micronutrients.values.folic_acid_ug,
    vitamin_a_ug: micronutrients.values.vitamin_a_ug,
    vitamin_d_ug: micronutrients.values.vitamin_d_ug,
    vitamin_k_ug: micronutrients.values.vitamin_k_ug,
    vitamin_e_mg: micronutrients.values.vitamin_e_mg,
    saturated_fat_g: macrosCalc.values.saturatedFat,
    monounsaturated_fat_g: macrosCalc.values.monounsaturatedFat,
    polyunsaturated_fat_g: macrosCalc.values.polyunsaturatedFat,
    calculation_basis: calculationBasis,
    last_calculated_at: now,
    updated_at: now,
  };
  
  const summary: NutritionTargetSummary = {
    calories: finalCalories,
    protein: finalProtein,
    fat: finalFat,
    carbs: finalCarbs,
    fiber: micronutrients.values.fiber_g,
    sodium: micronutrients.values.sodium_g,
    bmr: energyCalc.bmr.result_kcal,
    pal: energyCalc.pal.result,
    tdee: energyCalc.tdee_kcal,
    goal: nutritionGoal,
  };
  
  return {
    targetData,
    summary,
    calculationBasis,
  };
}

// ================================================
// エネルギー計算
// ================================================

interface EnergyInput {
  age: number;
  gender: Gender;
  height: number;
  weight: number;
  workStyle: string;
  exerciseIntensity: string;
  exerciseFrequency: number;
  nutritionGoal: NutritionGoal;
  weightChangeRate: WeightChangeRate;
  pregnancyStatus: PregnancyStatus;
}

function calculateEnergy(input: EnergyInput): EnergyCalculationBasis {
  const { age, gender, height, weight, workStyle, exerciseIntensity, exerciseFrequency, nutritionGoal, weightChangeRate, pregnancyStatus } = input;
  
  // BMR（Mifflin-St Jeor式）
  let bmrResult: number;
  let bmrFormula: string;
  let bmrSubstituted: string;
  
  if (gender === 'male') {
    bmrFormula = '10×体重 + 6.25×身長 - 5×年齢 + 5';
    bmrSubstituted = `10×${weight} + 6.25×${height} - 5×${age} + 5`;
    bmrResult = 10 * weight + 6.25 * height - 5 * age + 5;
  } else if (gender === 'female') {
    bmrFormula = '10×体重 + 6.25×身長 - 5×年齢 - 161';
    bmrSubstituted = `10×${weight} + 6.25×${height} - 5×${age} - 161`;
    bmrResult = 10 * weight + 6.25 * height - 5 * age - 161;
  } else {
    bmrFormula = '10×体重 + 6.25×身長 - 5×年齢 - 78（男女中間）';
    bmrSubstituted = `10×${weight} + 6.25×${height} - 5×${age} - 78`;
    bmrResult = 10 * weight + 6.25 * height - 5 * age - 78;
  }
  bmrResult = Math.round(bmrResult);
  
  // PAL
  const basePAL = WORK_STYLE_PAL[workStyle] || 1.375;
  const frequencyMultiplier = exerciseFrequency / 3;
  const exerciseAddition = (EXERCISE_BONUS[exerciseIntensity] || 0.1) * frequencyMultiplier;
  const rawPAL = basePAL + exerciseAddition;
  const capped = rawPAL > 2.5;
  const palResult = Math.min(rawPAL, 2.5);
  
  // TDEE
  let tdee = Math.round(bmrResult * palResult);
  
  // 目標による調整
  let goalDelta = 0;
  let goalReason = '';
  
  switch (nutritionGoal) {
    case 'lose_weight': {
      const deficitMap: Record<WeightChangeRate, number> = {
        slow: 300,
        moderate: 500,
        aggressive: 750,
      };
      goalDelta = -(deficitMap[weightChangeRate] || 500);
      goalReason = `減量目標（${weightChangeRate === 'slow' ? 'ゆっくり' : weightChangeRate === 'aggressive' ? '積極的' : '普通'}）`;
      break;
    }
    case 'gain_muscle': {
      const surplusMap: Record<WeightChangeRate, number> = {
        slow: 200,
        moderate: 350,
        aggressive: 500,
      };
      goalDelta = surplusMap[weightChangeRate] || 350;
      goalReason = `筋肥大目標（${weightChangeRate === 'slow' ? 'ゆっくり' : weightChangeRate === 'aggressive' ? '積極的' : '普通'}）`;
      break;
    }
    case 'athlete_performance': {
      goalDelta = 300;
      goalReason = '競技パフォーマンス目標';
      break;
    }
    default:
      goalReason = '現状維持';
  }
  
  let finalCalories = tdee + goalDelta;
  
  // 妊娠・授乳
  if (pregnancyStatus === 'pregnant') {
    finalCalories += 300;
    goalReason += '、妊娠中+300kcal';
  } else if (pregnancyStatus === 'nursing') {
    finalCalories += 500;
    goalReason += '、授乳中+500kcal';
  }
  
  // 最低カロリー
  const minCalories = gender === 'male' ? 1500 : 1200;
  const minimumApplied = finalCalories < minCalories;
  if (minimumApplied) {
    finalCalories = minCalories;
  }
  
  return {
    bmr: {
      model: 'mifflin-st-jeor',
      formula: bmrFormula,
      substituted: bmrSubstituted,
      result_kcal: bmrResult,
    },
    pal: {
      base_from_work_style: basePAL,
      work_style_used: workStyle,
      exercise_addition: round2(exerciseAddition),
      exercise_details: {
        intensity: exerciseIntensity,
        frequency: exerciseFrequency,
      },
      capped,
      result: round2(palResult),
    },
    tdee_kcal: tdee,
    goal_adjustment: {
      goal: nutritionGoal,
      delta_kcal: goalDelta,
      reason: goalReason,
    },
    minimum_applied: minimumApplied,
    minimum_value: minimumApplied ? minCalories : undefined,
    final_kcal: finalCalories,
  };
}

// ================================================
// PFC計算
// ================================================

interface MacrosInput {
  calories: number;
  weight: number;
  nutritionGoal: NutritionGoal;
  healthConditions: string[];
}

interface MacrosResult {
  values: {
    protein: number;
    fat: number;
    carbs: number;
    saturatedFat: number;
    monounsaturatedFat: number;
    polyunsaturatedFat: number;
  };
  basis: MacrosCalculationBasis;
}

function calculateMacros(input: MacrosInput): MacrosResult {
  const { calories, weight, nutritionGoal, healthConditions } = input;
  
  // 基本比率
  let proteinRatio = 0.20;
  let fatRatio = 0.25;
  let carbsRatio = 0.55;
  
  // 目標による調整
  switch (nutritionGoal) {
    case 'lose_weight':
      proteinRatio = 0.30;
      fatRatio = 0.25;
      carbsRatio = 0.45;
      break;
    case 'gain_muscle':
      proteinRatio = 0.30;
      fatRatio = 0.20;
      carbsRatio = 0.50;
      break;
    case 'athlete_performance':
      proteinRatio = 0.25;
      fatRatio = 0.25;
      carbsRatio = 0.50;
      break;
  }
  
  const overrides: MacrosCalculationBasis['overrides'] = [];
  
  // 持病による調整
  if (healthConditions.includes('糖尿病')) {
    carbsRatio = 0.40;
    fatRatio = 0.35;
    proteinRatio = 0.25;
    overrides.push({
      nutrient: 'carbs',
      original: 0.55,
      adjusted: carbsRatio,
      reason: '糖尿病: 炭水化物比率を制限',
    });
  }
  
  if (healthConditions.includes('脂質異常症')) {
    fatRatio = 0.20;
    overrides.push({
      nutrient: 'fat',
      original: 0.25,
      adjusted: fatRatio,
      reason: '脂質異常症: 脂質比率を制限',
    });
  }
  
  if (healthConditions.includes('腎臓病')) {
    proteinRatio = 0.15;
    overrides.push({
      nutrient: 'protein',
      original: 0.20,
      adjusted: proteinRatio,
      reason: '腎臓病: タンパク質比率を制限',
    });
  }
  
  // 比率からグラムへ
  let proteinG = Math.round((calories * proteinRatio) / 4);
  let fatG = Math.round((calories * fatRatio) / 9);
  let carbsG = Math.round((calories * carbsRatio) / 4);
  
  // タンパク質の体重ベース下限チェック
  const minProteinByWeight = Math.round(weight * 1.2);
  let method: 'ratio' | 'weight_based' | 'mixed' = 'ratio';
  
  if (proteinG < minProteinByWeight) {
    overrides.push({
      nutrient: 'protein',
      original: proteinG,
      adjusted: minProteinByWeight,
      reason: `体重ベース下限（${weight}kg × 1.2g）を適用`,
    });
    proteinG = minProteinByWeight;
    method = 'mixed';
  }
  
  // 脂肪酸の内訳
  const saturatedFatG = Math.round(calories * 0.07 / 9);
  const monounsaturatedFatG = Math.round(calories * 0.10 / 9);
  const polyunsaturatedFatG = Math.round(calories * 0.08 / 9);
  
  return {
    values: {
      protein: proteinG,
      fat: fatG,
      carbs: carbsG,
      saturatedFat: saturatedFatG,
      monounsaturatedFat: monounsaturatedFatG,
      polyunsaturatedFat: polyunsaturatedFatG,
    },
    basis: {
      method,
      ratios: {
        protein: proteinRatio,
        fat: fatRatio,
        carbs: carbsRatio,
      },
      grams: {
        protein: proteinG,
        fat: fatG,
        carbs: carbsG,
      },
      overrides: overrides.length > 0 ? overrides : undefined,
    },
  };
}

// ================================================
// 微量栄養素計算（DRI2020参照）
// ================================================

interface MicronutrientsInput {
  ageGroup: ReturnType<typeof ageToAgeGroup>;
  gender: Gender;
  pregnancyStatus: PregnancyStatus;
  healthConditions: string[];
  medications: string[];
  calories: number;
}

interface MicronutrientsResult {
  values: {
    fiber_g: number;
    sodium_g: number;
    sugar_g: number;
    potassium_mg: number;
    calcium_mg: number;
    phosphorus_mg: number;
    iron_mg: number;
    zinc_mg: number;
    iodine_ug: number;
    cholesterol_mg: number;
    vitamin_a_ug: number;
    vitamin_b1_mg: number;
    vitamin_b2_mg: number;
    vitamin_b6_mg: number;
    vitamin_b12_ug: number;
    vitamin_c_mg: number;
    vitamin_d_ug: number;
    vitamin_e_mg: number;
    vitamin_k_ug: number;
    folic_acid_ug: number;
  };
  references: Record<string, NutrientReference>;
  upperLimits?: Record<string, { value: number; unit: string; source: { url: string; title: string } }>;
  healthAdjustments?: CalculationBasis['health_adjustments'];
}

function calculateMicronutrients(input: MicronutrientsInput): MicronutrientsResult {
  const { ageGroup, gender, pregnancyStatus, healthConditions, medications, calories } = input;
  
  const values: MicronutrientsResult['values'] = {} as MicronutrientsResult['values'];
  const references: Record<string, NutrientReference> = {};
  const healthAdjustments: NonNullable<CalculationBasis['health_adjustments']> = [];
  
  // DRIテーブルから値を取得
  const driNutrients: Array<{
    key: keyof typeof DRI_TABLES;
    valueKey: keyof MicronutrientsResult['values'];
  }> = [
    { key: 'fiber_g', valueKey: 'fiber_g' },
    { key: 'sodium_g', valueKey: 'sodium_g' },
    { key: 'potassium_mg', valueKey: 'potassium_mg' },
    { key: 'calcium_mg', valueKey: 'calcium_mg' },
    { key: 'phosphorus_mg', valueKey: 'phosphorus_mg' },
    { key: 'iron_mg', valueKey: 'iron_mg' },
    { key: 'zinc_mg', valueKey: 'zinc_mg' },
    { key: 'iodine_ug', valueKey: 'iodine_ug' },
    { key: 'vitamin_a_ug', valueKey: 'vitamin_a_ug' },
    { key: 'vitamin_b1_mg', valueKey: 'vitamin_b1_mg' },
    { key: 'vitamin_b2_mg', valueKey: 'vitamin_b2_mg' },
    { key: 'vitamin_b6_mg', valueKey: 'vitamin_b6_mg' },
    { key: 'vitamin_b12_ug', valueKey: 'vitamin_b12_ug' },
    { key: 'vitamin_c_mg', valueKey: 'vitamin_c_mg' },
    { key: 'vitamin_d_ug', valueKey: 'vitamin_d_ug' },
    { key: 'vitamin_e_mg', valueKey: 'vitamin_e_mg' },
    { key: 'vitamin_k_ug', valueKey: 'vitamin_k_ug' },
    { key: 'folic_acid_ug', valueKey: 'folic_acid_ug' },
  ];
  
  for (const { key, valueKey } of driNutrients) {
    const dri = getDRIValue(key, ageGroup, gender, pregnancyStatus);
    if (dri) {
      (values as Record<string, number>)[valueKey] = dri.value;
      references[key] = {
        basis_type: dri.basisType,
        reference_value: dri.value,
        age_range: ageGroup,
        gender: gender,
        pregnancy_or_lactation: pregnancyStatus !== 'none' ? pregnancyStatus : undefined,
        source: {
          url: dri.source.url,
          title: dri.source.title,
          section: (dri.source as { section?: string }).section || '',
        },
        final_value: dri.value,
      };
    }
  }
  
  // コレステロール（DRIにないためアプリ独自）
  values.cholesterol_mg = CHOLESTEROL_APP_DEFAULT.default;
  references.cholesterol_mg = {
    basis_type: 'DG',
    reference_value: CHOLESTEROL_APP_DEFAULT.default,
    age_range: ageGroup,
    gender: gender,
    source: {
      url: DRI2020_SOURCES.energy_pfc.url,
      title: 'アプリ独自基準（DRI2020には基準値なし）',
      section: '',
    },
    final_value: CHOLESTEROL_APP_DEFAULT.default,
  };
  
  // 糖類（DRIにないためWHO推奨ベース）
  values.sugar_g = SUGAR_APP_DEFAULT.calculateFromCalories(calories);
  references.sugar_g = {
    basis_type: 'DG',
    reference_value: values.sugar_g,
    age_range: ageGroup,
    gender: gender,
    source: {
      url: 'https://www.who.int/nutrition/publications/guidelines/sugars_intake/en/',
      title: 'WHO推奨（エネルギーの5%目標、DRI2020には基準値なし）',
      section: '',
    },
    final_value: values.sugar_g,
  };
  
  // ================================================
  // 持病・薬による調整
  // ================================================
  
  // 高血圧
  if (healthConditions.includes('高血圧')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    // 塩分制限
    const originalSodium = values.sodium_g;
    values.sodium_g = 6.0;
    adjustments.push({
      nutrient: 'sodium_g',
      original: originalSodium,
      adjusted: 6.0,
      reason: '高血圧: 食塩相当量6g/日以下に制限',
      source_url: DRI2020_SOURCES.hypertension.url,
    });
    if (references.sodium_g) {
      references.sodium_g.adjustments = references.sodium_g.adjustments || [];
      references.sodium_g.adjustments.push({ delta: 6.0 - originalSodium, reason: '高血圧による制限' });
      references.sodium_g.final_value = 6.0;
    }
    
    // カリウム増加
    const originalPotassium = values.potassium_mg;
    values.potassium_mg = 3500;
    adjustments.push({
      nutrient: 'potassium_mg',
      original: originalPotassium,
      adjusted: 3500,
      reason: '高血圧: カリウム摂取量を増加（ナトリウム排出促進）',
      source_url: DRI2020_SOURCES.hypertension.url,
    });
    if (references.potassium_mg) {
      references.potassium_mg.adjustments = references.potassium_mg.adjustments || [];
      references.potassium_mg.adjustments.push({ delta: 3500 - originalPotassium, reason: '高血圧による増加' });
      references.potassium_mg.final_value = 3500;
    }
    
    healthAdjustments.push({
      condition: '高血圧',
      adjustments,
    });
  }
  
  // 脂質異常症
  if (healthConditions.includes('脂質異常症')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    const originalCholesterol = values.cholesterol_mg;
    values.cholesterol_mg = CHOLESTEROL_APP_DEFAULT.dyslipidemia;
    adjustments.push({
      nutrient: 'cholesterol_mg',
      original: originalCholesterol,
      adjusted: CHOLESTEROL_APP_DEFAULT.dyslipidemia,
      reason: '脂質異常症: コレステロール200mg/日以下に制限',
      source_url: DRI2020_SOURCES.dyslipidemia.url,
    });
    if (references.cholesterol_mg) {
      references.cholesterol_mg.adjustments = references.cholesterol_mg.adjustments || [];
      references.cholesterol_mg.adjustments.push({ delta: CHOLESTEROL_APP_DEFAULT.dyslipidemia - originalCholesterol, reason: '脂質異常症による制限' });
      references.cholesterol_mg.final_value = CHOLESTEROL_APP_DEFAULT.dyslipidemia;
    }
    
    healthAdjustments.push({
      condition: '脂質異常症',
      adjustments,
    });
  }
  
  // 糖尿病
  if (healthConditions.includes('糖尿病')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    // 糖類制限
    const originalSugar = values.sugar_g;
    values.sugar_g = 25;
    adjustments.push({
      nutrient: 'sugar_g',
      original: originalSugar,
      adjusted: 25,
      reason: '糖尿病: 糖類摂取を制限',
      source_url: DRI2020_SOURCES.diabetes.url,
    });
    if (references.sugar_g) {
      references.sugar_g.adjustments = references.sugar_g.adjustments || [];
      references.sugar_g.adjustments.push({ delta: 25 - originalSugar, reason: '糖尿病による制限' });
      references.sugar_g.final_value = 25;
    }
    
    // 食物繊維増加
    const originalFiber = values.fiber_g;
    values.fiber_g = Math.max(values.fiber_g, 25);
    if (values.fiber_g > originalFiber) {
      adjustments.push({
        nutrient: 'fiber_g',
        original: originalFiber,
        adjusted: values.fiber_g,
        reason: '糖尿病: 食物繊維摂取を増加',
        source_url: DRI2020_SOURCES.diabetes.url,
      });
      if (references.fiber_g) {
        references.fiber_g.adjustments = references.fiber_g.adjustments || [];
        references.fiber_g.adjustments.push({ delta: values.fiber_g - originalFiber, reason: '糖尿病による増加' });
        references.fiber_g.final_value = values.fiber_g;
      }
    }
    
    healthAdjustments.push({
      condition: '糖尿病',
      adjustments,
    });
  }
  
  // 腎臓病
  if (healthConditions.includes('腎臓病')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    // カリウム制限
    const originalPotassium = values.potassium_mg;
    values.potassium_mg = 2000;
    adjustments.push({
      nutrient: 'potassium_mg',
      original: originalPotassium,
      adjusted: 2000,
      reason: '腎臓病: カリウム摂取を制限',
      source_url: DRI2020_SOURCES.ckd.url,
    });
    if (references.potassium_mg) {
      references.potassium_mg.adjustments = references.potassium_mg.adjustments || [];
      references.potassium_mg.adjustments.push({ delta: 2000 - originalPotassium, reason: '腎臓病による制限' });
      references.potassium_mg.final_value = 2000;
    }
    
    // リン制限
    const originalPhosphorus = values.phosphorus_mg;
    values.phosphorus_mg = Math.min(values.phosphorus_mg, 700);
    if (values.phosphorus_mg < originalPhosphorus) {
      adjustments.push({
        nutrient: 'phosphorus_mg',
        original: originalPhosphorus,
        adjusted: values.phosphorus_mg,
        reason: '腎臓病: リン摂取を制限',
        source_url: DRI2020_SOURCES.ckd.url,
      });
      if (references.phosphorus_mg) {
        references.phosphorus_mg.adjustments = references.phosphorus_mg.adjustments || [];
        references.phosphorus_mg.adjustments.push({ delta: values.phosphorus_mg - originalPhosphorus, reason: '腎臓病による制限' });
        references.phosphorus_mg.final_value = values.phosphorus_mg;
      }
    }
    
    healthAdjustments.push({
      condition: '腎臓病',
      adjustments,
    });
  }
  
  // 心臓病
  if (healthConditions.includes('心臓病')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    // 塩分制限
    if (values.sodium_g > 6.0) {
      const originalSodium = values.sodium_g;
      values.sodium_g = 6.0;
      adjustments.push({
        nutrient: 'sodium_g',
        original: originalSodium,
        adjusted: 6.0,
        reason: '心臓病: 食塩相当量を制限',
      });
      if (references.sodium_g) {
        references.sodium_g.adjustments = references.sodium_g.adjustments || [];
        references.sodium_g.adjustments.push({ delta: 6.0 - originalSodium, reason: '心臓病による制限' });
        references.sodium_g.final_value = 6.0;
      }
    }
    
    // コレステロール制限
    if (values.cholesterol_mg > 200) {
      const originalCholesterol = values.cholesterol_mg;
      values.cholesterol_mg = 200;
      adjustments.push({
        nutrient: 'cholesterol_mg',
        original: originalCholesterol,
        adjusted: 200,
        reason: '心臓病: コレステロールを制限',
      });
      if (references.cholesterol_mg) {
        references.cholesterol_mg.adjustments = references.cholesterol_mg.adjustments || [];
        references.cholesterol_mg.adjustments.push({ delta: 200 - originalCholesterol, reason: '心臓病による制限' });
        references.cholesterol_mg.final_value = 200;
      }
    }
    
    if (adjustments.length > 0) {
      healthAdjustments.push({
        condition: '心臓病',
        adjustments,
      });
    }
  }
  
  // 骨粗しょう症
  if (healthConditions.includes('骨粗しょう症')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    // カルシウム増加
    const originalCalcium = values.calcium_mg;
    values.calcium_mg = Math.max(values.calcium_mg, 1000);
    if (values.calcium_mg > originalCalcium) {
      adjustments.push({
        nutrient: 'calcium_mg',
        original: originalCalcium,
        adjusted: values.calcium_mg,
        reason: '骨粗しょう症: カルシウム摂取を増加',
      });
      if (references.calcium_mg) {
        references.calcium_mg.adjustments = references.calcium_mg.adjustments || [];
        references.calcium_mg.adjustments.push({ delta: values.calcium_mg - originalCalcium, reason: '骨粗しょう症による増加' });
        references.calcium_mg.final_value = values.calcium_mg;
      }
    }
    
    if (adjustments.length > 0) {
      healthAdjustments.push({
        condition: '骨粗しょう症',
        adjustments,
      });
    }
  }
  
  // 貧血
  if (healthConditions.includes('貧血')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    // 鉄分増加
    const originalIron = values.iron_mg;
    values.iron_mg = 15;
    adjustments.push({
      nutrient: 'iron_mg',
      original: originalIron,
      adjusted: 15,
      reason: '貧血: 鉄分摂取を増加',
    });
    if (references.iron_mg) {
      references.iron_mg.adjustments = references.iron_mg.adjustments || [];
      references.iron_mg.adjustments.push({ delta: 15 - originalIron, reason: '貧血による増加' });
      references.iron_mg.final_value = 15;
    }
    
    healthAdjustments.push({
      condition: '貧血',
      adjustments,
    });
  }
  
  // ワーファリン服用
  if (medications.includes('warfarin')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    // ビタミンKを一定に維持
    const originalVitaminK = values.vitamin_k_ug;
    values.vitamin_k_ug = 80;
    adjustments.push({
      nutrient: 'vitamin_k_ug',
      original: originalVitaminK,
      adjusted: 80,
      reason: 'ワーファリン服用: ビタミンKを一定量に維持（変動を避ける）',
    });
    if (references.vitamin_k_ug) {
      references.vitamin_k_ug.adjustments = references.vitamin_k_ug.adjustments || [];
      references.vitamin_k_ug.adjustments.push({ delta: 80 - originalVitaminK, reason: 'ワーファリン服用による調整' });
      references.vitamin_k_ug.final_value = 80;
    }
    
    healthAdjustments.push({
      condition: 'ワーファリン服用',
      adjustments,
    });
  }
  
  // 降圧剤（ACE阻害薬）
  if (medications.includes('antihypertensive')) {
    const adjustments: NonNullable<CalculationBasis['health_adjustments']>[0]['adjustments'] = [];
    
    // カリウム過剰に注意
    if (values.potassium_mg > 2500) {
      const originalPotassium = values.potassium_mg;
      values.potassium_mg = 2500;
      adjustments.push({
        nutrient: 'potassium_mg',
        original: originalPotassium,
        adjusted: 2500,
        reason: '降圧剤（ACE阻害薬）服用: カリウム過剰を避ける',
      });
      if (references.potassium_mg) {
        references.potassium_mg.adjustments = references.potassium_mg.adjustments || [];
        references.potassium_mg.adjustments.push({ delta: 2500 - originalPotassium, reason: '降圧剤服用による制限' });
        references.potassium_mg.final_value = 2500;
      }
    }
    
    if (adjustments.length > 0) {
      healthAdjustments.push({
        condition: '降圧剤服用',
        adjustments,
      });
    }
  }
  
  return {
    values,
    references,
    healthAdjustments: healthAdjustments.length > 0 ? healthAdjustments : undefined,
  };
}

// ================================================
// Performance OS v3 ガードレール
// ================================================

interface GuardrailInput {
  age: number;
  gender: Gender;
  weight: number;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  performanceProfile?: PerformanceProfile | null;
}

interface GuardrailOutput {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  guardrails: GuardrailResult[];
}

/**
 * Performance OS v3 ガードレールを適用
 *
 * 安全性を担保するための制限:
 * 1. growth_protection: 18歳未満の成長期保護
 * 2. cut_safety: 減量時の安全制限
 * 3. fat_floor: 脂質下限（ホルモン・細胞膜維持）
 * 4. calorie_minimum: カロリー下限
 * 5. sport_specific: スポーツ特有調整
 */
function applyPerformanceGuardrails(input: GuardrailInput): GuardrailOutput {
  const { age, gender, weight, performanceProfile } = input;
  let { calories, protein, fat, carbs } = input;
  const guardrails: GuardrailResult[] = [];

  // ================================================
  // 1. 成長期保護（18歳未満）
  // ================================================
  if (performanceProfile?.growth?.isUnder18 || age < 18) {
    // 成長期は最低でもTDEE - 300kcalまで
    const minGrowthCalories = gender === 'male' ? 2000 : 1800;
    if (calories < minGrowthCalories) {
      guardrails.push({
        applied: true,
        type: 'growth_protection',
        original: calories,
        adjusted: minGrowthCalories,
        reason: `18歳未満の成長期保護: 最低${minGrowthCalories}kcalを確保`,
        severity: 'critical',
      });
      calories = minGrowthCalories;
    }

    // 成長期はカット（減量）禁止
    if (performanceProfile?.cut?.enabled) {
      guardrails.push({
        applied: true,
        type: 'growth_protection',
        original: 1, // cut enabled
        adjusted: 0, // cut disabled
        reason: '18歳未満の成長期は減量プログラムを推奨しません',
        severity: 'critical',
      });
    }
  }

  // ================================================
  // 2. 減量安全性（Cut Safety）
  // ================================================
  if (performanceProfile?.cut?.enabled && performanceProfile?.sport?.phase === 'cut') {
    // 急速減量の場合、体重の1%/週を超えない
    const strategy = performanceProfile.cut.strategy;

    if (strategy === 'rapid') {
      // 急速減量: 最大週1kg減（7700kcal/週 = 1100kcal/日の赤字）
      const maxDeficit = 1100;
      // BMR * 1.2 を基準として赤字を計算（仮定）
      const estimatedTDEE = calories + maxDeficit; // 逆算
      const minCutCalories = Math.max(gender === 'male' ? 1500 : 1200, estimatedTDEE - maxDeficit);

      if (calories < minCutCalories) {
        guardrails.push({
          applied: true,
          type: 'cut_safety',
          original: calories,
          adjusted: minCutCalories,
          reason: `急速減量でも最大1kg/週まで: 最低${minCutCalories}kcalを確保`,
          severity: 'warning',
        });
        calories = minCutCalories;
      }
    }

    // タンパク質を体重×2.0g以上に確保（筋量維持）
    const minProteinCut = Math.round(weight * 2.0);
    if (protein < minProteinCut) {
      guardrails.push({
        applied: true,
        type: 'cut_safety',
        original: protein,
        adjusted: minProteinCut,
        reason: `減量時の筋量維持: タンパク質${minProteinCut}g（体重×2.0g）を確保`,
        severity: 'warning',
      });
      protein = minProteinCut;
    }
  }

  // ================================================
  // 3. 脂質下限（Fat Floor）
  // ================================================
  // ホルモン・細胞膜維持のため最低15%は確保
  const fatCalories = fat * 9;
  const fatRatio = fatCalories / calories;
  const minFatRatio = 0.15;

  if (fatRatio < minFatRatio) {
    const minFatG = Math.round((calories * minFatRatio) / 9);
    guardrails.push({
      applied: true,
      type: 'fat_floor',
      original: fat,
      adjusted: minFatG,
      reason: `ホルモン・細胞膜維持のため脂質15%以上を確保: ${minFatG}g`,
      severity: 'warning',
    });
    fat = minFatG;

    // 脂質を増やした分、炭水化物を減らす
    const fatDelta = (minFatG - input.fat) * 9; // kcal差
    const carbsDelta = Math.round(fatDelta / 4);
    carbs = Math.max(50, carbs - carbsDelta); // 最低50gは確保
  }

  // ================================================
  // 4. スポーツ特有調整
  // ================================================
  if (performanceProfile?.sport) {
    const demandVector = performanceProfile.sport.demandVector;

    // 持久系スポーツ: 炭水化物を増加
    if (demandVector.endurance > 0.7) {
      const minCarbsRatio = 0.55;
      const carbsCalories = carbs * 4;
      const currentCarbsRatio = carbsCalories / calories;

      if (currentCarbsRatio < minCarbsRatio) {
        const minCarbsG = Math.round((calories * minCarbsRatio) / 4);
        guardrails.push({
          applied: true,
          type: 'sport_specific',
          original: carbs,
          adjusted: minCarbsG,
          reason: `持久系競技: 炭水化物55%以上を推奨（${minCarbsG}g）`,
          severity: 'info',
        });
        carbs = minCarbsG;
      }
    }

    // パワー系・筋力系スポーツ: タンパク質を増加
    if (demandVector.power > 0.7 || demandVector.strength > 0.7) {
      const minProteinByWeight = Math.round(weight * 1.8);
      if (protein < minProteinByWeight) {
        guardrails.push({
          applied: true,
          type: 'sport_specific',
          original: protein,
          adjusted: minProteinByWeight,
          reason: `パワー/筋力系競技: タンパク質${minProteinByWeight}g（体重×1.8g）を推奨`,
          severity: 'info',
        });
        protein = minProteinByWeight;
      }
    }

    // 体重階級スポーツ: 注意喚起のみ
    if (demandVector.weightClass > 0.8) {
      guardrails.push({
        applied: false,
        type: 'sport_specific',
        original: 0,
        adjusted: 0,
        reason: '体重階級競技: 急激な減量は避け、専門家と相談してください',
        severity: 'info',
      });
    }

    // 暑熱環境: 水分・電解質の注意喚起
    if (demandVector.heat > 0.7) {
      guardrails.push({
        applied: false,
        type: 'sport_specific',
        original: 0,
        adjusted: 0,
        reason: '暑熱環境競技: 水分・電解質補給を十分に行ってください',
        severity: 'info',
      });
    }
  }

  // ================================================
  // 5. 絶対最低カロリー
  // ================================================
  const absoluteMinCalories = gender === 'male' ? 1200 : 1000;
  if (calories < absoluteMinCalories) {
    guardrails.push({
      applied: true,
      type: 'calorie_minimum',
      original: calories,
      adjusted: absoluteMinCalories,
      reason: `健康維持のため絶対最低${absoluteMinCalories}kcalを確保`,
      severity: 'critical',
    });
    calories = absoluteMinCalories;
  }

  return {
    calories,
    protein,
    fat,
    carbs,
    guardrails,
  };
}

// ================================================
// ヘルパー
// ================================================

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
