/**
 * 栄養目標計算モジュール - 型定義
 * 
 * 日本人の食事摂取基準（2020年版）に準拠した栄養目標の計算に使用する型
 */

// ================================================
// 基本的な入力型（プロフィールからの抽出）
// ================================================

export type Gender = 'male' | 'female' | 'unspecified';

export type NutritionGoal = 'maintain' | 'lose_weight' | 'gain_muscle' | 'athlete_performance';

export type WeightChangeRate = 'slow' | 'moderate' | 'aggressive';

export type WorkStyle = 
  | 'sedentary' 
  | 'light_active' 
  | 'moderately_active' 
  | 'very_active'
  | 'student'
  | 'homemaker';

export type ExerciseIntensity = 'light' | 'moderate' | 'intense' | 'athlete';

export type PregnancyStatus = 'none' | 'pregnant' | 'nursing';

// ================================================
// Performance OS v3 Types
// ================================================

export type TrainingPhase = 'training' | 'competition' | 'cut' | 'recovery';
export type CutStrategy = 'gradual' | 'rapid';

/**
 * スポーツ要求特性ベクトル（0-1）
 */
export interface DemandVector {
  endurance: number;    // 持久力
  power: number;        // 瞬発力
  strength: number;     // 筋力
  technique: number;    // 技術
  weightClass: number;  // 体重階級の重要度
  heat: number;         // 暑熱環境
  altitude: number;     // 高地適応
}

/**
 * パフォーマンスプロファイル（静的設定）
 */
export interface PerformanceProfile {
  sport?: {
    id: string;
    name?: string;
    role?: string;
    experience: 'beginner' | 'intermediate' | 'advanced';
    phase: TrainingPhase;
    demandVector: DemandVector;
  };
  growth?: {
    isUnder18: boolean;
    heightChangeRecent?: number;
    growthProtectionEnabled: boolean;
  };
  cut?: {
    enabled: boolean;
    targetWeight?: number;
    targetDate?: string;
    strategy: CutStrategy;
  };
  priorities?: {
    protein: 'high' | 'moderate' | 'low';
    carbs: 'high' | 'moderate' | 'low';
    fat: 'high' | 'moderate' | 'low';
    hydration: 'high' | 'moderate' | 'low';
  };
}

/**
 * ガードレール適用結果
 */
export interface GuardrailResult {
  applied: boolean;
  type: 'growth_protection' | 'cut_safety' | 'fat_floor' | 'calorie_minimum' | 'sport_specific';
  original: number;
  adjusted: number;
  reason: string;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * 計算に必要な入力プロフィール
 */
export interface NutritionCalculatorInput {
  // 必須
  id: string;

  // 基本情報（欠損可能）
  age?: number | null;
  gender?: Gender | null;
  height?: number | null;
  weight?: number | null;

  // 活動情報
  work_style?: WorkStyle | null;
  exercise_intensity?: ExerciseIntensity | null;
  exercise_frequency?: number | null;
  exercise_duration_per_session?: number | null;

  // 目標
  nutrition_goal?: NutritionGoal | null;
  weight_change_rate?: WeightChangeRate | null;

  // 健康状態
  health_conditions?: string[] | null;
  medications?: string[] | null;
  pregnancy_status?: PregnancyStatus | null;

  // Performance OS v3
  performance_profile?: PerformanceProfile | null;
}

// ================================================
// DRI（Dietary Reference Intakes）関連
// ================================================

/**
 * DRIの参照値の種別
 * - RDA: 推奨量（Recommended Dietary Allowance）
 * - AI: 目安量（Adequate Intake）
 * - DG: 目標量（Tentative Dietary Goal）- 日本独自
 * - UL: 耐容上限量（Tolerable Upper Intake Level）
 */
export type DRIBasisType = 'RDA' | 'AI' | 'DG' | 'UL';

/**
 * DRI年齢階級
 */
export type DRIAgeGroup = 
  | '0-5m' | '6-11m'
  | '1-2' | '3-5' | '6-7' | '8-9' | '10-11' | '12-14' | '15-17'
  | '18-29' | '30-49' | '50-64' | '65-74' | '75+';

/**
 * 単一栄養素のDRI参照値
 */
export interface DRIReference {
  value: number;
  basisType: DRIBasisType;
  ageGroup: DRIAgeGroup;
  gender: Gender;
  source: {
    url: string;
    title: string;
    section: string;
    page?: string;
  };
  // 妊娠/授乳中の追加量
  pregnancyAddition?: number;
  nursingAddition?: number;
}

// ================================================
// 計算結果・計算根拠
// ================================================

/**
 * 計算根拠のうちエネルギー計算部分
 */
export interface EnergyCalculationBasis {
  bmr: {
    model: 'mifflin-st-jeor';
    formula: string;
    substituted: string;
    result_kcal: number;
  };
  pal: {
    base_from_work_style: number;
    work_style_used: string;
    exercise_addition: number;
    exercise_details?: {
      intensity: string;
      frequency: number;
      duration?: number;
    };
    capped: boolean;
    result: number;
  };
  tdee_kcal: number;
  goal_adjustment: {
    goal: NutritionGoal;
    delta_kcal: number;
    reason: string;
  };
  minimum_applied: boolean;
  minimum_value?: number;
  final_kcal: number;
}

/**
 * マクロ栄養素の計算根拠
 */
export interface MacrosCalculationBasis {
  method: 'ratio' | 'weight_based' | 'mixed';
  ratios: {
    protein: number;
    fat: number;
    carbs: number;
  };
  grams: {
    protein: number;
    fat: number;
    carbs: number;
  };
  overrides?: {
    nutrient: string;
    original: number;
    adjusted: number;
    reason: string;
  }[];
}

/**
 * 単一栄養素の参照情報
 */
export interface NutrientReference {
  basis_type: DRIBasisType;
  reference_value: number;
  age_range: string;
  gender: string;
  pregnancy_or_lactation?: string;
  source: {
    url: string;
    title: string;
    section: string;
    page?: string;
  };
  adjustments?: {
    delta: number;
    reason: string;
    source_url?: string;
  }[];
  final_value: number;
}

/**
 * 上限量情報
 */
export interface UpperLimitInfo {
  value: number;
  unit: string;
  source: {
    url: string;
    title: string;
  };
}

/**
 * 計算根拠（calculation_basis）の完全な構造
 */
export interface CalculationBasis {
  version: 'dri2020_v1';
  calculated_at: string;
  
  inputs: {
    age: number;
    gender: Gender;
    height: number;
    weight: number;
    work_style: string;
    exercise_intensity: string;
    exercise_frequency: number;
    nutrition_goal: NutritionGoal;
    weight_change_rate: WeightChangeRate;
    health_conditions: string[];
    medications: string[];
    pregnancy_status: PregnancyStatus;
  };
  
  missing_fields: string[];
  defaults_applied: Record<string, unknown>;
  
  energy: EnergyCalculationBasis;
  macros: MacrosCalculationBasis;
  
  references: Record<string, NutrientReference>;
  upper_limits?: Record<string, UpperLimitInfo>;
  
  health_adjustments?: {
    condition: string;
    adjustments: {
      nutrient: string;
      original: number;
      adjusted: number;
      reason: string;
      source_url?: string;
    }[];
  }[];

  // Performance OS v3 guardrails
  guardrails?: GuardrailResult[];
  performance_profile?: PerformanceProfile;
}

// ================================================
// DB保存用出力（スネークケース）
// ================================================

/**
 * nutrition_targets テーブルへ直接upsertできる形式
 */
export interface NutritionTargetData {
  user_id: string;
  daily_calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  fiber_soluble_g: number;
  fiber_insoluble_g: number;
  sodium_g: number;
  sugar_g: number;
  potassium_mg: number;
  calcium_mg: number;
  phosphorus_mg: number;
  iron_mg: number;
  zinc_mg: number;
  iodine_ug: number;
  cholesterol_mg: number;
  vitamin_b1_mg: number;
  vitamin_b2_mg: number;
  vitamin_c_mg: number;
  vitamin_b6_mg: number;
  vitamin_b12_ug: number;
  folic_acid_ug: number;
  vitamin_a_ug: number;
  vitamin_d_ug: number;
  vitamin_k_ug: number;
  vitamin_e_mg: number;
  saturated_fat_g: number;
  monounsaturated_fat_g: number;
  polyunsaturated_fat_g: number;
  calculation_basis: CalculationBasis;
  last_calculated_at: string;
  updated_at: string;
}

/**
 * UI表示用のサマリー
 */
export interface NutritionTargetSummary {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  fiber: number;
  sodium: number;
  bmr: number;
  pal: number;
  tdee: number;
  goal: NutritionGoal;
}

/**
 * 計算結果の完全な出力
 */
export interface NutritionCalculationResult {
  targetData: NutritionTargetData;
  summary: NutritionTargetSummary;
  calculationBasis: CalculationBasis;
}
