type ValidationResult<T extends object> = {
  data: Partial<T>;
  errors: string[];
};

type PlainObject = Record<string, unknown>;

export interface NotificationPreferencesPayload {
  enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  record_mode: string;
  personality_type: string;
  morning_reminder_enabled: boolean;
  morning_reminder_time: string;
  evening_reminder_enabled: boolean;
  evening_reminder_time: string;
  vacation_mode: boolean;
  vacation_until: string | null;
}

export interface HealthRecordPayload {
  weight: number | null;
  body_fat_percentage: number | null;
  muscle_mass: number | null;
  systolic_bp: number | null;
  diastolic_bp: number | null;
  heart_rate: number | null;
  sleep_hours: number | null;
  sleep_quality: number | null;
  mood_score: number | null;
  stress_level: number | null;
  overall_condition: number | null;
  water_intake: number | null;
  step_count: number | null;
  body_temp: number | null;
  bowel_movement: number | null;
  energy_level: number | null;
  daily_note: string | null;
  data_source: string | null;
}

export interface HealthGoalUpdatePayload {
  target_value: number | null;
  current_value: number | null;
  target_unit: string | null;
  target_date: string | null;
  note: string | null;
}

export interface HealthCheckupPayload {
  checkup_date: string | null;
  facility_name: string | null;
  checkup_type: string | null;
  image_url: string | null;
  height: number | null;
  weight: number | null;
  bmi: number | null;
  waist_circumference: number | null;
  blood_pressure_systolic: number | null;
  blood_pressure_diastolic: number | null;
  hemoglobin: number | null;
  hba1c: number | null;
  fasting_glucose: number | null;
  total_cholesterol: number | null;
  ldl_cholesterol: number | null;
  hdl_cholesterol: number | null;
  triglycerides: number | null;
  ast: number | null;
  alt: number | null;
  gamma_gtp: number | null;
  creatinine: number | null;
  egfr: number | null;
  uric_acid: number | null;
}

export interface BloodTestPayload {
  test_date: string | null;
  test_facility: string | null;
  total_cholesterol: number | null;
  ldl_cholesterol: number | null;
  hdl_cholesterol: number | null;
  triglycerides: number | null;
  fasting_glucose: number | null;
  hba1c: number | null;
  ast: number | null;
  alt: number | null;
  gamma_gtp: number | null;
  creatinine: number | null;
  egfr: number | null;
  uric_acid: number | null;
  bun: number | null;
  hemoglobin: number | null;
  note: string | null;
}

export const DEFAULT_NOTIFICATION_PREFERENCES = {
  enabled: true,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  record_mode: 'standard',
  personality_type: 'positive',
  morning_reminder_enabled: true,
  morning_reminder_time: '07:30',
  evening_reminder_enabled: false,
  evening_reminder_time: '21:00',
  vacation_mode: false,
  vacation_until: null,
} as const;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NOTIFICATION_RECORD_MODES = new Set(['standard', 'minimal', 'weekly', 'off']);
const NOTIFICATION_PERSONALITY_TYPES = new Set(['positive', 'logical', 'gentle', 'competitive']);

function isPlainObject(value: unknown): value is PlainObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(input: PlainObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function parseNullableString(
  input: PlainObject,
  key: string,
  errors: string[],
  opts: { date?: boolean } = {},
): string | null | undefined {
  if (!hasOwn(input, key)) return undefined;

  const value = input[key];
  if (value == null) return null;
  if (typeof value !== 'string') {
    errors.push(`${key} must be a string or null`);
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (opts.date && !DATE_PATTERN.test(trimmed)) {
    errors.push(`${key} must be a date in YYYY-MM-DD format`);
    return undefined;
  }

  return trimmed;
}

function parseNullableTime(input: PlainObject, key: string, errors: string[]): string | undefined {
  if (!hasOwn(input, key)) return undefined;

  const value = input[key];
  if (typeof value !== 'string') {
    errors.push(`${key} must be a string`);
    return undefined;
  }

  const trimmed = value.trim();
  if (!TIME_PATTERN.test(trimmed)) {
    errors.push(`${key} must be a time in HH:MM format`);
    return undefined;
  }

  return trimmed;
}

function parseBoolean(input: PlainObject, key: string, errors: string[]): boolean | undefined {
  if (!hasOwn(input, key)) return undefined;

  const value = input[key];
  if (typeof value !== 'boolean') {
    errors.push(`${key} must be a boolean`);
    return undefined;
  }

  return value;
}

function parseNullableNumber(
  input: PlainObject,
  key: string,
  errors: string[],
  opts: { integer?: boolean; min?: number; max?: number; label?: string } = {},
): number | null | undefined {
  if (!hasOwn(input, key)) return undefined;

  const value = input[key];
  if (value == null || value === '') return null;

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

function parseEnum(
  input: PlainObject,
  key: string,
  allowed: Set<string>,
  errors: string[],
): string | undefined {
  if (!hasOwn(input, key)) return undefined;

  const value = input[key];
  if (typeof value !== 'string') {
    errors.push(`${key} must be a string`);
    return undefined;
  }

  const trimmed = value.trim();
  if (!allowed.has(trimmed)) {
    errors.push(`${key} must be one of: ${Array.from(allowed).join(', ')}`);
    return undefined;
  }

  return trimmed;
}

function parseKnownFields<T extends object>(
  input: unknown,
  parser: (body: PlainObject, errors: string[]) => Partial<T>,
): ValidationResult<T> {
  if (!isPlainObject(input)) {
    return {
      data: {},
      errors: ['Body must be a JSON object'],
    };
  }

  const errors: string[] = [];
  const data = parser(input, errors);
  return { data, errors };
}

export function sanitizeNotificationPreferences(input: unknown): ValidationResult<NotificationPreferencesPayload> {
  return parseKnownFields(input, (body, errors) => {
    const data: Record<string, unknown> = {};

    const enabled = parseBoolean(body, 'enabled', errors);
    if (enabled !== undefined) data.enabled = enabled;

    const quietHoursStart = parseNullableTime(body, 'quiet_hours_start', errors);
    if (quietHoursStart !== undefined) data.quiet_hours_start = quietHoursStart;

    const quietHoursEnd = parseNullableTime(body, 'quiet_hours_end', errors);
    if (quietHoursEnd !== undefined) data.quiet_hours_end = quietHoursEnd;

    const recordMode = parseEnum(body, 'record_mode', NOTIFICATION_RECORD_MODES, errors);
    if (recordMode !== undefined) data.record_mode = recordMode;

    const personalityType = parseEnum(body, 'personality_type', NOTIFICATION_PERSONALITY_TYPES, errors);
    if (personalityType !== undefined) data.personality_type = personalityType;

    const morningEnabled = parseBoolean(body, 'morning_reminder_enabled', errors);
    if (morningEnabled !== undefined) data.morning_reminder_enabled = morningEnabled;

    const morningTime = parseNullableTime(body, 'morning_reminder_time', errors);
    if (morningTime !== undefined) data.morning_reminder_time = morningTime;

    const eveningEnabled = parseBoolean(body, 'evening_reminder_enabled', errors);
    if (eveningEnabled !== undefined) data.evening_reminder_enabled = eveningEnabled;

    const eveningTime = parseNullableTime(body, 'evening_reminder_time', errors);
    if (eveningTime !== undefined) data.evening_reminder_time = eveningTime;

    const vacationMode = parseBoolean(body, 'vacation_mode', errors);
    if (vacationMode !== undefined) data.vacation_mode = vacationMode;

    const vacationUntil = parseNullableString(body, 'vacation_until', errors, { date: true });
    if (vacationUntil !== undefined) data.vacation_until = vacationUntil;

    return data;
  });
}

export function mergeNotificationPreferences(input: unknown) {
  const merged = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  if (!isPlainObject(input)) return merged;

  const { data } = sanitizeNotificationPreferences(input);
  return { ...merged, ...data };
}

export function sanitizeHealthRecordPayload(
  input: unknown,
  opts: { acceptLegacyNotes?: boolean } = {},
): ValidationResult<HealthRecordPayload> {
  return parseKnownFields(input, (body, errors) => {
    const data: Record<string, unknown> = {};

    const numericFieldOpts: Record<string, { min?: number; max?: number; label?: string }> = {
      weight: { min: 20, max: 300, label: '体重 (kg)' },
      body_fat_percentage: { min: 1, max: 70, label: '体脂肪率 (%)' },
      muscle_mass: { min: 5, max: 150, label: '筋肉量 (kg)' },
      sleep_hours: { min: 0, max: 24, label: '睡眠時間 (h)' },
      body_temp: { min: 30, max: 45, label: '体温 (°C)' },
    };
    const numericFields = [
      'weight',
      'body_fat_percentage',
      'muscle_mass',
      'sleep_hours',
      'body_temp',
    ] as const;
    for (const field of numericFields) {
      const value = parseNullableNumber(body, field, errors, numericFieldOpts[field] ?? {});
      if (value !== undefined) data[field] = value;
    }

    const integerFieldOpts: Record<string, { min?: number; max?: number; label?: string }> = {
      systolic_bp: { min: 30, max: 300, label: '収縮期血圧 (mmHg)' },
      diastolic_bp: { min: 20, max: 200, label: '拡張期血圧 (mmHg)' },
      heart_rate: { min: 20, max: 300, label: '心拍数 (bpm)' },
      sleep_quality: { min: 1, max: 10, label: '睡眠の質 (1-10)' },
      water_intake: { min: 0, max: 10000, label: '水分摂取量 (mL)' },
      step_count: { min: 0, max: 100000, label: '歩数' },
      bowel_movement: { min: 0, max: 20, label: '排便回数' },
      overall_condition: { min: 1, max: 10, label: '全体的な体調 (1-10)' },
      mood_score: { min: 1, max: 10, label: '気分スコア (1-10)' },
      energy_level: { min: 1, max: 10, label: 'エネルギーレベル (1-10)' },
      stress_level: { min: 1, max: 10, label: 'ストレスレベル (1-10)' },
    };
    const integerFields = [
      'systolic_bp',
      'diastolic_bp',
      'heart_rate',
      'sleep_quality',
      'water_intake',
      'step_count',
      'bowel_movement',
      'overall_condition',
      'mood_score',
      'energy_level',
      'stress_level',
    ] as const;
    for (const field of integerFields) {
      const value = parseNullableNumber(body, field, errors, { integer: true, ...(integerFieldOpts[field] ?? {}) });
      if (value !== undefined) data[field] = value;
    }

    const dailyNote = parseNullableString(body, 'daily_note', errors);
    if (dailyNote !== undefined) {
      data.daily_note = dailyNote;
    } else if (opts.acceptLegacyNotes) {
      const legacyNotes = parseNullableString(body, 'notes', errors);
      if (legacyNotes !== undefined) data.daily_note = legacyNotes;
    }

    const dataSource = parseNullableString(body, 'data_source', errors);
    if (dataSource !== undefined) data.data_source = dataSource;

    return data;
  });
}

export function sanitizeHealthGoalUpdate(input: unknown): ValidationResult<HealthGoalUpdatePayload> {
  return parseKnownFields(input, (body, errors) => {
    const data: Record<string, unknown> = {};

    const targetValue = parseNullableNumber(body, 'target_value', errors);
    if (targetValue !== undefined) data.target_value = targetValue;

    const currentValue = parseNullableNumber(body, 'current_value', errors);
    if (currentValue !== undefined) data.current_value = currentValue;

    const targetUnit = parseNullableString(body, 'target_unit', errors);
    if (targetUnit !== undefined) data.target_unit = targetUnit;

    const targetDate = parseNullableString(body, 'target_date', errors, { date: true });
    if (targetDate !== undefined) data.target_date = targetDate;

    const note = parseNullableString(body, 'note', errors);
    if (note !== undefined) data.note = note;

    return data;
  });
}

export function sanitizeHealthCheckupPayload(input: unknown): ValidationResult<HealthCheckupPayload> {
  return parseKnownFields(input, (body, errors) => {
    const data: Record<string, unknown> = {};

    const dateFields = ['checkup_date'] as const;
    for (const field of dateFields) {
      const value = parseNullableString(body, field, errors, { date: true });
      if (value !== undefined) data[field] = value;
    }

    const stringFields = ['facility_name', 'checkup_type', 'image_url'] as const;
    for (const field of stringFields) {
      const value = parseNullableString(body, field, errors);
      if (value !== undefined) data[field] = value;
    }

    const numericFieldOpts: Record<string, { min?: number; max?: number; label?: string }> = {
      height: { min: 50, max: 250, label: '身長 (cm)' },
      weight: { min: 20, max: 300, label: '体重 (kg)' },
      bmi: { min: 10, max: 70, label: 'BMI' },
      waist_circumference: { min: 30, max: 300, label: '腹囲 (cm)' },
      hemoglobin: { min: 1, max: 25, label: 'ヘモグロビン (g/dL)' },
      hba1c: { min: 3, max: 15, label: 'HbA1c (%)' },
      creatinine: { min: 0.1, max: 30, label: 'クレアチニン (mg/dL)' },
      egfr: { min: 0, max: 150, label: 'eGFR (mL/min/1.73m²)' },
      uric_acid: { min: 0.5, max: 20, label: '尿酸 (mg/dL)' },
    };
    const numericFields = [
      'height',
      'weight',
      'bmi',
      'waist_circumference',
      'hemoglobin',
      'hba1c',
      'creatinine',
      'egfr',
      'uric_acid',
    ] as const;
    for (const field of numericFields) {
      const value = parseNullableNumber(body, field, errors, numericFieldOpts[field] ?? {});
      if (value !== undefined) data[field] = value;
    }

    const integerFieldOpts: Record<string, { min?: number; max?: number; label?: string }> = {
      blood_pressure_systolic: { min: 30, max: 300, label: '収縮期血圧 (mmHg)' },
      blood_pressure_diastolic: { min: 20, max: 200, label: '拡張期血圧 (mmHg)' },
      fasting_glucose: { min: 20, max: 700, label: '空腹時血糖 (mg/dL)' },
      total_cholesterol: { min: 50, max: 1000, label: '総コレステロール (mg/dL)' },
      ldl_cholesterol: { min: 10, max: 700, label: 'LDLコレステロール (mg/dL)' },
      hdl_cholesterol: { min: 5, max: 200, label: 'HDLコレステロール (mg/dL)' },
      triglycerides: { min: 10, max: 5000, label: '中性脂肪 (mg/dL)' },
      ast: { min: 1, max: 5000, label: 'AST (U/L)' },
      alt: { min: 1, max: 5000, label: 'ALT (U/L)' },
      gamma_gtp: { min: 1, max: 5000, label: 'γ-GTP (U/L)' },
    };
    const integerFields = [
      'blood_pressure_systolic',
      'blood_pressure_diastolic',
      'fasting_glucose',
      'total_cholesterol',
      'ldl_cholesterol',
      'hdl_cholesterol',
      'triglycerides',
      'ast',
      'alt',
      'gamma_gtp',
    ] as const;
    for (const field of integerFields) {
      const value = parseNullableNumber(body, field, errors, { integer: true, ...(integerFieldOpts[field] ?? {}) });
      if (value !== undefined) data[field] = value;
    }

    return data;
  });
}

export function sanitizeBloodTestPayload(input: unknown): ValidationResult<BloodTestPayload> {
  return parseKnownFields(input, (body, errors) => {
    const data: Record<string, unknown> = {};

    const testDate = parseNullableString(body, 'test_date', errors, { date: true });
    if (testDate !== undefined) data.test_date = testDate;

    const stringFields = ['test_facility', 'note'] as const;
    for (const field of stringFields) {
      const value = parseNullableString(body, field, errors);
      if (value !== undefined) data[field] = value;
    }

    const numericFieldOpts: Record<string, { min?: number; max?: number; label?: string }> = {
      hba1c: { min: 3, max: 15, label: 'HbA1c (%)' },
      creatinine: { min: 0.1, max: 30, label: 'クレアチニン (mg/dL)' },
      egfr: { min: 0, max: 150, label: 'eGFR (mL/min/1.73m²)' },
      uric_acid: { min: 0.5, max: 20, label: '尿酸 (mg/dL)' },
      bun: { min: 1, max: 200, label: 'BUN (mg/dL)' },
      hemoglobin: { min: 1, max: 25, label: 'ヘモグロビン (g/dL)' },
    };
    const numericFields = ['hba1c', 'creatinine', 'egfr', 'uric_acid', 'bun', 'hemoglobin'] as const;
    for (const field of numericFields) {
      const value = parseNullableNumber(body, field, errors, numericFieldOpts[field] ?? {});
      if (value !== undefined) data[field] = value;
    }

    const integerFieldOpts: Record<string, { min?: number; max?: number; label?: string }> = {
      total_cholesterol: { min: 50, max: 1000, label: '総コレステロール (mg/dL)' },
      ldl_cholesterol: { min: 10, max: 700, label: 'LDLコレステロール (mg/dL)' },
      hdl_cholesterol: { min: 5, max: 200, label: 'HDLコレステロール (mg/dL)' },
      triglycerides: { min: 10, max: 5000, label: '中性脂肪 (mg/dL)' },
      fasting_glucose: { min: 20, max: 700, label: '空腹時血糖 (mg/dL)' },
      ast: { min: 1, max: 5000, label: 'AST (U/L)' },
      alt: { min: 1, max: 5000, label: 'ALT (U/L)' },
      gamma_gtp: { min: 1, max: 5000, label: 'γ-GTP (U/L)' },
    };
    const integerFields = [
      'total_cholesterol',
      'ldl_cholesterol',
      'hdl_cholesterol',
      'triglycerides',
      'fasting_glucose',
      'ast',
      'alt',
      'gamma_gtp',
    ] as const;
    for (const field of integerFields) {
      const value = parseNullableNumber(body, field, errors, { integer: true, ...(integerFieldOpts[field] ?? {}) });
      if (value !== undefined) data[field] = value;
    }

    return data;
  });
}
