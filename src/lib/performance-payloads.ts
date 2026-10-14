/**
 * #1048 F2-18: performance 系 POST の入力検証。
 *
 * user_performance_checkins テーブルは sleep_quality/fatigue/focus/hunger/mood/
 * soreness/training_load_rpe に DB CHECK 制約があるが、weight / body_fat_percentage /
 * resting_heart_rate / sleep_hours / training_minutes には制約が無く、
 * 異常値（例: weight=5000）がそのまま保存され user_profiles.weight にも
 * 汚染が伝播していた。ここでアプリ層のレンジ検証を一本化する。
 */

type ValidationResult<T extends object> = {
  data: Partial<T>;
  errors: string[];
};

type PlainObject = Record<string, unknown>;

// PerformanceCheckin (types/domain.ts) の各フィールドは null を許容しないため、
// このペイロードも同じ形（値 or 未設定＝undefined）に揃える。
// 空値/null が送られた場合は「未設定」（フィールドを省略しキーごと保存しない）として扱う。
export interface PerformanceCheckinInputPayload {
  sleepHours: number;
  sleepQuality: number;
  fatigue: number;
  focus: number;
  hunger: number;
  trainingLoadRpe: number;
  trainingMinutes: number;
  weight: number;
  bodyFatPercentage: number;
  restingHeartRate: number;
  mood: number;
  soreness: number;
  note: string;
}

function isPlainObject(value: unknown): value is PlainObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(input: PlainObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function parseNullableNumber(
  input: PlainObject,
  key: string,
  errors: string[],
  opts: { integer?: boolean; min?: number; max?: number; label?: string } = {},
): number | undefined {
  if (!hasOwn(input, key)) return undefined;

  const value = input[key];
  // PerformanceCheckin は null を許容しないため、null/空文字は「未設定」として扱う
  // （フィールド自体を省略し、既存値を変更しない）。
  if (value == null || value === '') return undefined;

  if (typeof value === 'string' && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    errors.push(`${key} must be a finite number or null`);
    return undefined;
  }

  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    errors.push(`${key} must be a finite number or null`);
    return undefined;
  }

  if (opts.integer && !Number.isInteger(numeric)) {
    errors.push(`${key} must be an integer or null`);
    return undefined;
  }

  const label = opts.label ?? key;
  if (opts.min !== undefined && numeric < opts.min) {
    errors.push(`${label} は ${opts.min} 以上の値を入力してください`);
    return undefined;
  }
  if (opts.max !== undefined && numeric > opts.max) {
    errors.push(`${label} は ${opts.max} 以下の値を入力してください`);
    return undefined;
  }

  return numeric;
}

function parseNullableString(input: PlainObject, key: string, errors: string[], maxLen = 2000): string | undefined {
  if (!hasOwn(input, key)) return undefined;

  const value = input[key];
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    errors.push(`${key} must be a string or null`);
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    errors.push(`${key} は ${maxLen} 文字以内で入力してください`);
    return undefined;
  }

  return trimmed || undefined;
}

// DB CHECK 済みの 1-5 尺度項目 (sleep_quality/fatigue/focus/hunger/mood/soreness)
const SCALE_1_5_FIELDS: Record<string, string> = {
  sleepQuality: '睡眠の質 (1-5)',
  fatigue: '疲労度 (1-5)',
  focus: '集中力 (1-5)',
  hunger: '空腹感 (1-5)',
  mood: '気分 (1-5)',
  soreness: '筋肉痛 (1-5)',
};

export function sanitizePerformanceCheckinPayload(input: unknown): ValidationResult<PerformanceCheckinInputPayload> {
  if (!isPlainObject(input)) {
    return { data: {}, errors: ['Body must be a JSON object'] };
  }

  const errors: string[] = [];
  const data: Record<string, unknown> = {};

  for (const [field, label] of Object.entries(SCALE_1_5_FIELDS)) {
    const value = parseNullableNumber(input, field, errors, { integer: true, min: 1, max: 5, label });
    if (value !== undefined) data[field] = value;
  }

  const trainingLoadRpe = parseNullableNumber(input, 'trainingLoadRpe', errors, {
    integer: true,
    min: 1,
    max: 10,
    label: 'トレーニング負荷RPE (1-10)',
  });
  if (trainingLoadRpe !== undefined) data.trainingLoadRpe = trainingLoadRpe;

  const trainingMinutes = parseNullableNumber(input, 'trainingMinutes', errors, {
    integer: true,
    min: 0,
    max: 1440,
    label: 'トレーニング時間 (分)',
  });
  if (trainingMinutes !== undefined) data.trainingMinutes = trainingMinutes;

  const sleepHours = parseNullableNumber(input, 'sleepHours', errors, {
    min: 0,
    max: 24,
    label: '睡眠時間 (h)',
  });
  if (sleepHours !== undefined) data.sleepHours = sleepHours;

  const weight = parseNullableNumber(input, 'weight', errors, {
    min: 20,
    max: 300,
    label: '体重 (kg)',
  });
  if (weight !== undefined) data.weight = weight;

  const bodyFatPercentage = parseNullableNumber(input, 'bodyFatPercentage', errors, {
    min: 1,
    max: 70,
    label: '体脂肪率 (%)',
  });
  if (bodyFatPercentage !== undefined) data.bodyFatPercentage = bodyFatPercentage;

  const restingHeartRate = parseNullableNumber(input, 'restingHeartRate', errors, {
    integer: true,
    min: 20,
    max: 300,
    label: '安静時心拍数 (bpm)',
  });
  if (restingHeartRate !== undefined) data.restingHeartRate = restingHeartRate;

  const note = parseNullableString(input, 'note', errors);
  if (note !== undefined) data.note = note;

  return { data, errors };
}
