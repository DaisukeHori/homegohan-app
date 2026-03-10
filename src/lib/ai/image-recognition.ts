export const DEFAULT_GEMINI_FLASH_LITE_MODEL = 'gemini-3.1-flash-lite-preview';
export const DEFAULT_GEMINI_VISION_MODEL = DEFAULT_GEMINI_FLASH_LITE_MODEL;
export const DEFAULT_GEMINI_FLASH_MODEL = DEFAULT_GEMINI_FLASH_LITE_MODEL;
export const DEFAULT_GEMINI_CLASSIFY_MODEL = DEFAULT_GEMINI_FLASH_MODEL;
export const AUTO_CLASSIFY_CONFIDENCE_THRESHOLD = 0.6;
export const AUTO_CLASSIFY_CANDIDATE_FALLBACK_THRESHOLD = 0.45;

export type PhotoType = 'meal' | 'fridge' | 'health_checkup' | 'weight_scale' | 'unknown';
export type HealthPhotoType = 'weight_scale' | 'blood_pressure' | 'thermometer' | 'unknown';

export interface ClassificationCandidate {
  type: PhotoType;
  confidence: number;
}

export interface ClassifyPhotoResult {
  type: PhotoType;
  confidence: number;
  description: string;
  candidates: ClassificationCandidate[];
}

export interface MealRecognitionIngredient {
  name: string;
  amount_g: number;
}

export type MealCookingMethod =
  | 'fried'
  | 'grilled'
  | 'stir_fried'
  | 'simmered'
  | 'steamed'
  | 'boiled'
  | 'raw'
  | 'rice'
  | 'soup'
  | 'baked'
  | 'other';

export interface MealRecognitionDish {
  name: string;
  role: 'main' | 'side' | 'soup' | 'rice' | 'salad' | 'dessert';
  cookingMethod: MealCookingMethod;
  visiblePortionWeightG: number;
  visibleIngredients: MealRecognitionIngredient[];
  estimatedIngredients: MealRecognitionIngredient[];
}

export interface MealRecognitionResult {
  dishes: MealRecognitionDish[];
}

export interface ClassifyPhotoWithMealAnalysisResult extends ClassifyPhotoResult {
  mealAnalysis?: MealRecognitionResult;
}

export interface ResolvedClassifyPhotoType {
  type: Exclude<PhotoType, 'unknown'> | null;
  confidence: number;
  source: 'primary' | 'candidate' | 'none';
}

export interface FridgeIngredientRecognition {
  name: string;
  category: '野菜' | '肉類' | '魚介類' | '乳製品' | '卵' | '調味料' | '飲料' | 'その他';
  quantity: string;
  freshness: 'fresh' | 'good' | 'expiring_soon' | 'expired';
  daysRemaining: number;
}

export interface FridgeAnalysisResult {
  ingredients: FridgeIngredientRecognition[];
  summary: string;
  suggestions: string[];
}

export interface HealthPhotoAnalysisResult {
  type: HealthPhotoType;
  values: {
    weight?: number;
    body_fat_percentage?: number;
    muscle_mass?: number;
    systolic_bp?: number;
    diastolic_bp?: number;
    heart_rate?: number;
    body_temp?: number;
  };
  confidence: number;
  raw_text?: string;
}

export interface WeightScaleResult {
  weight: number;
  bodyFat?: number;
  muscleMass?: number;
  confidence: number;
  rawText?: string;
}

export interface HealthCheckupExtractedData {
  checkupDate?: string;
  facilityName?: string;
  checkupType?: string;
  height?: number;
  weight?: number;
  bmi?: number;
  waistCircumference?: number;
  bloodPressureSystolic?: number;
  bloodPressureDiastolic?: number;
  hemoglobin?: number;
  hba1c?: number;
  fastingGlucose?: number;
  totalCholesterol?: number;
  ldlCholesterol?: number;
  hdlCholesterol?: number;
  triglycerides?: number;
  ast?: number;
  alt?: number;
  gammaGtp?: number;
  creatinine?: number;
  egfr?: number;
  uricAcid?: number;
  confidence?: number;
  notes?: string;
}

const PHOTO_TYPES: PhotoType[] = ['meal', 'fridge', 'health_checkup', 'weight_scale', 'unknown'];
const HEALTH_PHOTO_TYPES: HealthPhotoType[] = ['weight_scale', 'blood_pressure', 'thermometer', 'unknown'];
const FRIDGE_CATEGORIES = ['野菜', '肉類', '魚介類', '乳製品', '卵', '調味料', '飲料', 'その他'] as const;
const FRESHNESS_VALUES = ['fresh', 'good', 'expiring_soon', 'expired'] as const;

const numericField = { type: ['number', 'null'] };
const stringField = { type: ['string', 'null'] };

export const classifyPhotoSchema = {
  type: 'object',
  required: ['type', 'confidence'],
  properties: {
    type: { type: 'string', enum: PHOTO_TYPES },
    confidence: { type: 'number' },
  },
} as const;

export const mealRecognitionSchema = {
  type: 'object',
  required: ['dishes'],
  properties: {
    dishes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'role', 'cookingMethod', 'visiblePortionWeightG', 'visibleIngredients'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['main', 'side', 'soup', 'rice', 'salad', 'dessert'] },
          cookingMethod: {
            type: 'string',
            enum: ['fried', 'grilled', 'stir_fried', 'simmered', 'steamed', 'boiled', 'raw', 'rice', 'soup', 'baked', 'other'],
          },
          visiblePortionWeightG: { type: 'number' },
          visibleIngredients: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'amount_g'],
              properties: {
                name: { type: 'string' },
                amount_g: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function getClassifyPhotoDescription(type: PhotoType): string {
  switch (type) {
    case 'meal':
      return '食事の写真と判定しました';
    case 'fridge':
      return '冷蔵庫の写真と判定しました';
    case 'health_checkup':
      return '健康診断結果の写真と判定しました';
    case 'weight_scale':
      return '体重計や健康機器の写真と判定しました';
    default:
      return 'AIが画像を判定しました';
  }
}

export const fridgeAnalysisSchema = {
  type: 'object',
  required: ['ingredients', 'summary', 'suggestions'],
  properties: {
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'category', 'quantity', 'freshness', 'daysRemaining'],
        properties: {
          name: { type: 'string' },
          category: { type: 'string', enum: [...FRIDGE_CATEGORIES] },
          quantity: { type: 'string' },
          freshness: { type: 'string', enum: [...FRESHNESS_VALUES] },
          daysRemaining: { type: 'number' },
        },
      },
    },
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

export const healthPhotoAnalysisSchema = {
  type: 'object',
  required: ['type', 'values', 'confidence', 'raw_text'],
  properties: {
    type: { type: 'string', enum: HEALTH_PHOTO_TYPES },
    values: {
      type: 'object',
      properties: {
        weight: numericField,
        body_fat_percentage: numericField,
        muscle_mass: numericField,
        systolic_bp: numericField,
        diastolic_bp: numericField,
        heart_rate: numericField,
        body_temp: numericField,
      },
    },
    confidence: { type: 'number' },
    raw_text: { type: 'string' },
  },
} as const;

export const healthCheckupSchema = {
  type: 'object',
  properties: {
    checkupDate: stringField,
    facilityName: stringField,
    checkupType: stringField,
    height: numericField,
    weight: numericField,
    bmi: numericField,
    waistCircumference: numericField,
    bloodPressureSystolic: numericField,
    bloodPressureDiastolic: numericField,
    hemoglobin: numericField,
    hba1c: numericField,
    fastingGlucose: numericField,
    totalCholesterol: numericField,
    ldlCholesterol: numericField,
    hdlCholesterol: numericField,
    triglycerides: numericField,
    ast: numericField,
    alt: numericField,
    gammaGtp: numericField,
    creatinine: numericField,
    egfr: numericField,
    uricAcid: numericField,
    confidence: numericField,
    notes: stringField,
  },
} as const;

function clampConfidence(value: unknown): number {
  const numeric = toOptionalNumber(value);
  if (numeric === undefined) return 0;
  return Math.max(0, Math.min(1, Math.round(numeric * 100) / 100));
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeMealRecognitionResult(raw: unknown): MealRecognitionResult {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const dishesInput = Array.isArray(input.dishes) ? input.dishes : [];

  return {
    dishes: dishesInput
      .map((dish) => {
        const item = typeof dish === 'object' && dish !== null ? dish as Record<string, unknown> : {};
        const visibleIngredientsInput = Array.isArray(item.visibleIngredients)
          ? item.visibleIngredients
          : Array.isArray(item.estimatedIngredients)
            ? item.estimatedIngredients
            : [];

        const visibleIngredients = visibleIngredientsInput
          .map((ingredient) => {
            const candidate = typeof ingredient === 'object' && ingredient !== null ? ingredient as Record<string, unknown> : {};
            const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : null;
            const amount = toOptionalNumber(candidate.amount_g);
            if (!name || amount === undefined) return null;
            return { name, amount_g: Math.max(0, amount) };
          })
          .filter((ingredient): ingredient is MealRecognitionIngredient => ingredient !== null);

        const role = typeof item.role === 'string' && ['main', 'side', 'soup', 'rice', 'salad', 'dessert'].includes(item.role)
          ? item.role as MealRecognitionDish['role']
          : 'main';
        const cookingMethod = typeof item.cookingMethod === 'string' && [
          'fried',
          'grilled',
          'stir_fried',
          'simmered',
          'steamed',
          'boiled',
          'raw',
          'rice',
          'soup',
          'baked',
          'other',
        ].includes(item.cookingMethod)
          ? item.cookingMethod as MealRecognitionDish['cookingMethod']
          : role === 'rice'
            ? 'rice'
            : role === 'soup'
              ? 'soup'
              : role === 'salad'
                ? 'raw'
                : 'other';
        const visiblePortionWeightG = Math.max(
          0,
          toOptionalNumber(item.visiblePortionWeightG)
            ?? visibleIngredients.reduce((sum, ingredient) => sum + ingredient.amount_g, 0),
        );

        return {
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '不明な料理',
          role,
          cookingMethod,
          visiblePortionWeightG,
          visibleIngredients,
          estimatedIngredients: visibleIngredients,
        };
      })
      .filter((dish) => dish.visibleIngredients.length > 0),
  };
}

function uniqueCandidates(candidates: ClassificationCandidate[]): ClassificationCandidate[] {
  const seen = new Set<PhotoType>();
  const result: ClassificationCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.type)) continue;
    seen.add(candidate.type);
    result.push(candidate);
  }

  return result;
}

export function normalizeClassifyPhotoResult(raw: unknown): ClassifyPhotoResult {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const primaryType = PHOTO_TYPES.includes(input.type as PhotoType) ? input.type as PhotoType : 'unknown';
  const confidence = clampConfidence(input.confidence);
  const description = toOptionalString(input.description) ?? getClassifyPhotoDescription(primaryType);
  const candidatesInput = Array.isArray(input.candidates) ? input.candidates : [];

  const candidates = uniqueCandidates(
    candidatesInput
      .map((item) => {
        const candidate = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
        const type = PHOTO_TYPES.includes(candidate.type as PhotoType) ? candidate.type as PhotoType : 'unknown';
        return {
          type,
          confidence: clampConfidence(candidate.confidence),
        };
      })
      .filter((candidate) => candidate.type !== 'unknown' || candidate.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence),
  );

  if (!candidates.some((candidate) => candidate.type === primaryType) && (primaryType !== 'unknown' || confidence > 0)) {
    candidates.unshift({ type: primaryType, confidence });
  }

  return {
    type: primaryType,
    confidence,
    description,
    candidates: uniqueCandidates(candidates).slice(0, 3),
  };
}

export function resolveClassifyPhotoType(
  result: Pick<ClassifyPhotoResult, 'type' | 'confidence' | 'candidates'>,
): ResolvedClassifyPhotoType {
  if (result.type !== 'unknown' && result.confidence >= AUTO_CLASSIFY_CONFIDENCE_THRESHOLD) {
    return {
      type: result.type,
      confidence: result.confidence,
      source: 'primary',
    };
  }

  const bestCandidate = [...result.candidates]
    .filter((candidate): candidate is ClassificationCandidate & { type: Exclude<PhotoType, 'unknown'> } => (
      candidate.type !== 'unknown'
    ))
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (bestCandidate && bestCandidate.confidence >= AUTO_CLASSIFY_CANDIDATE_FALLBACK_THRESHOLD) {
    return {
      type: bestCandidate.type,
      confidence: bestCandidate.confidence,
      source: 'candidate',
    };
  }

  return {
    type: null,
    confidence: 0,
    source: 'none',
  };
}

export function aggregateClassifyPhotoResults(
  results: Array<Pick<ClassifyPhotoResult, 'type' | 'confidence' | 'candidates'>>,
): ClassifyPhotoResult {
  const scoreByType = new Map<Exclude<PhotoType, 'unknown'>, number>();
  const voteByType = new Map<Exclude<PhotoType, 'unknown'>, number>();

  for (const type of PHOTO_TYPES) {
    if (type === 'unknown') continue;
    scoreByType.set(type, 0);
    voteByType.set(type, 0);
  }

  for (const result of results) {
    const resolved = resolveClassifyPhotoType(result);
    if (resolved.type) {
      scoreByType.set(resolved.type, (scoreByType.get(resolved.type) ?? 0) + resolved.confidence);
      voteByType.set(resolved.type, (voteByType.get(resolved.type) ?? 0) + 1);
      continue;
    }

    const seenFallbackTypes = new Set<Exclude<PhotoType, 'unknown'>>();
    for (const candidate of result.candidates) {
      if (candidate.type === 'unknown' || seenFallbackTypes.has(candidate.type)) continue;
      seenFallbackTypes.add(candidate.type);
      scoreByType.set(candidate.type, (scoreByType.get(candidate.type) ?? 0) + candidate.confidence * 0.5);
    }
  }

  const ranked = [...scoreByType.entries()]
    .map(([type, score]) => ({
      type,
      score,
      votes: voteByType.get(type) ?? 0,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      return b.score - a.score;
    });

  if (ranked.length === 0) {
    return {
      type: 'unknown',
      confidence: 0,
      description: '複数画像を確認しましたが判別できませんでした',
      candidates: [],
    };
  }

  const top = ranked[0];
  const normalizedCandidates = ranked.slice(0, 3).map((entry) => ({
    type: entry.type,
    confidence: clampConfidence(entry.score / Math.max(results.length, 1)),
  }));

  const topConfidence = normalizedCandidates[0]?.confidence ?? 0;
  const nextConfidence = normalizedCandidates[1]?.confidence ?? 0;
  const isConsensus =
    top.votes >= Math.ceil(results.length / 2) ||
    topConfidence >= AUTO_CLASSIFY_CONFIDENCE_THRESHOLD ||
    (topConfidence >= AUTO_CLASSIFY_CANDIDATE_FALLBACK_THRESHOLD && topConfidence - nextConfidence >= 0.15);

  return {
    type: isConsensus ? top.type : 'unknown',
    confidence: topConfidence,
    description: `${results.length}枚を個別確認した結果`,
    candidates: normalizedCandidates,
  };
}

export function normalizeFridgeAnalysisResult(raw: unknown): FridgeAnalysisResult {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const ingredientsInput = Array.isArray(input.ingredients) ? input.ingredients : [];

  const ingredients = ingredientsInput
    .map((item) => {
      const ingredient = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
      const name = toOptionalString(ingredient.name);
      if (!name) return null;

      const category = FRIDGE_CATEGORIES.includes(ingredient.category as typeof FRIDGE_CATEGORIES[number])
        ? ingredient.category as typeof FRIDGE_CATEGORIES[number]
        : 'その他';
      const quantity = toOptionalString(ingredient.quantity) ?? '不明';
      const freshness = FRESHNESS_VALUES.includes(ingredient.freshness as typeof FRESHNESS_VALUES[number])
        ? ingredient.freshness as typeof FRESHNESS_VALUES[number]
        : 'good';
      const daysRemaining = toOptionalNumber(ingredient.daysRemaining);

      return {
        name,
        category,
        quantity,
        freshness,
        daysRemaining: daysRemaining === undefined ? -1 : Math.round(daysRemaining),
      };
    })
    .filter((ingredient): ingredient is FridgeIngredientRecognition => ingredient !== null);

  return {
    ingredients,
    summary: toOptionalString(input.summary) ?? '',
    suggestions: Array.isArray(input.suggestions)
      ? input.suggestions.map((item) => toOptionalString(item)).filter((item): item is string => Boolean(item)).slice(0, 3)
      : [],
  };
}

function normalizeOptionalNumericObject(raw: unknown, keys: string[]): Record<string, number | undefined> {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  return keys.reduce<Record<string, number | undefined>>((result, key) => {
    result[key] = toOptionalNumber(input[key]);
    return result;
  }, {});
}

export function normalizeHealthPhotoAnalysisResult(raw: unknown): HealthPhotoAnalysisResult {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const values = normalizeOptionalNumericObject(input.values, [
    'weight',
    'body_fat_percentage',
    'muscle_mass',
    'systolic_bp',
    'diastolic_bp',
    'heart_rate',
    'body_temp',
  ]);

  return {
    type: HEALTH_PHOTO_TYPES.includes(input.type as HealthPhotoType) ? input.type as HealthPhotoType : 'unknown',
    values,
    confidence: clampConfidence(input.confidence),
    raw_text: toOptionalString(input.raw_text),
  };
}

export function extractWeightScaleResult(raw: unknown): WeightScaleResult {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const source = typeof input.result === 'object' && input.result !== null
    ? input.result as Record<string, unknown>
    : input;
  const normalized = normalizeHealthPhotoAnalysisResult(source);

  return {
    weight: normalized.values.weight ?? 0,
    bodyFat: normalized.values.body_fat_percentage,
    muscleMass: normalized.values.muscle_mass,
    confidence: normalized.confidence,
    rawText: normalized.raw_text,
  };
}

export function normalizeHealthCheckupExtractedData(raw: unknown): Required<Pick<HealthCheckupExtractedData, 'confidence' | 'notes'>> & Omit<HealthCheckupExtractedData, 'confidence' | 'notes'> {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};

  return {
    checkupDate: toOptionalString(input.checkupDate),
    facilityName: toOptionalString(input.facilityName),
    checkupType: toOptionalString(input.checkupType),
    height: toOptionalNumber(input.height),
    weight: toOptionalNumber(input.weight),
    bmi: toOptionalNumber(input.bmi),
    waistCircumference: toOptionalNumber(input.waistCircumference),
    bloodPressureSystolic: toOptionalNumber(input.bloodPressureSystolic),
    bloodPressureDiastolic: toOptionalNumber(input.bloodPressureDiastolic),
    hemoglobin: toOptionalNumber(input.hemoglobin),
    hba1c: toOptionalNumber(input.hba1c),
    fastingGlucose: toOptionalNumber(input.fastingGlucose),
    totalCholesterol: toOptionalNumber(input.totalCholesterol),
    ldlCholesterol: toOptionalNumber(input.ldlCholesterol),
    hdlCholesterol: toOptionalNumber(input.hdlCholesterol),
    triglycerides: toOptionalNumber(input.triglycerides),
    ast: toOptionalNumber(input.ast),
    alt: toOptionalNumber(input.alt),
    gammaGtp: toOptionalNumber(input.gammaGtp),
    creatinine: toOptionalNumber(input.creatinine),
    egfr: toOptionalNumber(input.egfr),
    uricAcid: toOptionalNumber(input.uricAcid),
    confidence: clampConfidence(input.confidence),
    notes: toOptionalString(input.notes) ?? '',
  };
}

export function countExtractedHealthFields(data: HealthCheckupExtractedData): number {
  return Object.entries(data).filter(([key, value]) => {
    if (key === 'confidence' || key === 'notes') return false;
    return value !== null && value !== undefined && value !== '';
  }).length;
}
