/**
 * 血液検査・健診値の基準値 (性別依存) の単一ソース。
 *
 * 従来は checkups/[id] (CheckupDetailClient) と blood-tests/page.tsx で
 * それぞれ別の基準値表・別の見せ方 (前者はハイライトのみ・後者は範囲テキストのみで
 * 判定なし) を持っており、かつ性別非依存 (実質女性寄り) の固定値だった。
 * (#1055 UX3-24)
 *
 * NOTE: ここでの数値は一般的な人間ドック学会の基準範囲を参考にした目安であり、
 * 医学的診断を目的としたものではない。個人差・持病により正常範囲は異なる。
 */

export type BiologicalSex = 'male' | 'female' | string | null | undefined;

interface SexRange {
  low?: number;
  high?: number;
}

interface MetricDef {
  label: string;
  unit: string;
  male: SexRange;
  female: SexRange;
}

export const BLOOD_METRIC_DEFS: Record<string, MetricDef> = {
  blood_pressure_systolic: { label: '収縮期血圧', unit: 'mmHg', male: { high: 130 }, female: { high: 130 } },
  blood_pressure_diastolic: { label: '拡張期血圧', unit: 'mmHg', male: { high: 85 }, female: { high: 85 } },
  hemoglobin: { label: 'ヘモグロビン', unit: 'g/dL', male: { low: 13.5, high: 17.6 }, female: { low: 11.3, high: 15.2 } },
  hba1c: { label: 'HbA1c', unit: '%', male: { high: 5.6 }, female: { high: 5.6 } },
  fasting_glucose: { label: '空腹時血糖', unit: 'mg/dL', male: { high: 100 }, female: { high: 100 } },
  total_cholesterol: { label: '総コレステロール', unit: 'mg/dL', male: { high: 220 }, female: { high: 220 } },
  ldl_cholesterol: { label: 'LDLコレステロール', unit: 'mg/dL', male: { high: 140 }, female: { high: 140 } },
  hdl_cholesterol: { label: 'HDLコレステロール', unit: 'mg/dL', male: { low: 40 }, female: { low: 40 } },
  triglycerides: { label: '中性脂肪', unit: 'mg/dL', male: { high: 150 }, female: { high: 150 } },
  ast: { label: 'AST(GOT)', unit: 'U/L', male: { low: 13, high: 30 }, female: { low: 9, high: 25 } },
  alt: { label: 'ALT(GPT)', unit: 'U/L', male: { low: 10, high: 42 }, female: { low: 7, high: 23 } },
  gamma_gtp: { label: 'γ-GTP', unit: 'U/L', male: { low: 13, high: 64 }, female: { low: 9, high: 32 } },
  creatinine: { label: 'クレアチニン', unit: 'mg/dL', male: { low: 0.65, high: 1.07 }, female: { low: 0.46, high: 0.79 } },
  egfr: { label: 'eGFR', unit: 'mL/min/1.73m²', male: { low: 60 }, female: { low: 60 } },
  uric_acid: { label: '尿酸', unit: 'mg/dL', male: { low: 3.7, high: 7.8 }, female: { low: 2.6, high: 5.5 } },
};

export type MetricKey = keyof typeof BLOOD_METRIC_DEFS;

function normalizeSex(sex: BiologicalSex): 'male' | 'female' | null {
  if (sex === 'male' || sex === 'female') return sex;
  return null;
}

/** 性別が未設定の場合は男女どちらでも異常を見逃さないよう、範囲を合成 (低いlow, 高いhigh) して返す。 */
function combinedRange(def: MetricDef): SexRange {
  const low =
    def.male.low != null && def.female.low != null
      ? Math.min(def.male.low, def.female.low)
      : def.male.low ?? def.female.low;
  const high =
    def.male.high != null && def.female.high != null
      ? Math.max(def.male.high, def.female.high)
      : def.male.high ?? def.female.high;
  return { low, high };
}

export function getRangeForSex(key: string, sex?: BiologicalSex): SexRange | null {
  const def = BLOOD_METRIC_DEFS[key];
  if (!def) return null;
  const normalized = normalizeSex(sex);
  if (normalized === 'male') return def.male;
  if (normalized === 'female') return def.female;
  return combinedRange(def);
}

export function formatRangeText(range: SexRange | null): string {
  if (!range) return '-';
  if (range.low != null && range.high != null) return `${range.low}〜${range.high}`;
  if (range.high != null) return `${range.high}以下`;
  if (range.low != null) return `${range.low}以上`;
  return '-';
}

export type MetricStatus = 'normal' | 'low' | 'high' | 'unknown';

export function evaluateStatus(key: string, value: number | null | undefined, sex?: BiologicalSex): MetricStatus {
  if (value == null) return 'unknown';
  const range = getRangeForSex(key, sex);
  if (!range) return 'unknown';
  if (range.high != null && value > range.high) return 'high';
  if (range.low != null && value < range.low) return 'low';
  return 'normal';
}

export function getMetricLabel(key: string): string | null {
  return BLOOD_METRIC_DEFS[key]?.label ?? null;
}

export function getMetricUnit(key: string): string | null {
  return BLOOD_METRIC_DEFS[key]?.unit ?? null;
}
