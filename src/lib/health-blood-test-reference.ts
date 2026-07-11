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

/**
 * 身体測定値の基準値 (#1051 UX3-07)。
 * 健診詳細画面で身長/体重/BMI/腹囲が一切表示されておらず、異常判定の基準も無かった。
 * BMI・腹囲は特定健診(メタボ)基準を目安に採用。身長・体重は個人差が大きく単一の
 * 異常基準を持たないため、範囲を持たせず参考値なしの表示専用項目として扱う
 * (evaluateStatus は low/high 未設定のため常に 'normal' を返し、色による誤誘導をしない)。
 */
export const BODY_METRIC_DEFS: Record<string, MetricDef> = {
  height: { label: '身長', unit: 'cm', male: {}, female: {} },
  weight: { label: '体重', unit: 'kg', male: {}, female: {} },
  bmi: { label: 'BMI', unit: '', male: { low: 18.5, high: 25 }, female: { low: 18.5, high: 25 } },
  waist_circumference: { label: '腹囲', unit: 'cm', male: { high: 85 }, female: { high: 90 } },
};

// evaluateStatus/getRangeForSex/getMetricLabel/getMetricUnit は血液検査値・身体測定値の
// 両方を単一ソースから引けるようにこちらを参照する。checkups詳細画面では身体測定の
// ラベル・単位取得にも使うためエクスポートする。
export const ALL_METRIC_DEFS: Record<string, MetricDef> = { ...BLOOD_METRIC_DEFS, ...BODY_METRIC_DEFS };

export type MetricKey = keyof typeof BLOOD_METRIC_DEFS;

function normalizeSex(sex: BiologicalSex): 'male' | 'female' | null {
  if (sex === 'male' || sex === 'female') return sex;
  return null;
}

/**
 * 性別が未設定の場合は、男女どちらの基準で見ても正常範囲内という値まで
 * 誤って異常扱い(誤警報)しないよう、範囲を合成 (低い方のlow, 高い方のhigh) して返す。
 * ＝ 性別不明時は「どちらの性別であっても確定的に異常と言える場合」のみ high/low とフラグする設計。
 * (代わりに、実際の性別なら異常と判定されたはずの値を見逃す可能性はある)
 */
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
  const def = ALL_METRIC_DEFS[key];
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

// #1051 UX3-07: 基準値ちょうどの線で急に「異常」と赤表示するのではなく、
// 境界に近い(±10%)場合は「注意(やや高め/やや低め)」として区別する。
const WARNING_BAND_RATIO = 0.1;

export type MetricStatus = 'normal' | 'low' | 'high' | 'warning_low' | 'warning_high' | 'unknown';

export function evaluateStatus(key: string, value: number | null | undefined, sex?: BiologicalSex): MetricStatus {
  if (value == null) return 'unknown';
  const range = getRangeForSex(key, sex);
  if (!range) return 'unknown';
  if (range.high != null) {
    if (value > range.high) return 'high';
    if (value >= range.high * (1 - WARNING_BAND_RATIO)) return 'warning_high';
  }
  if (range.low != null) {
    if (value < range.low) return 'low';
    if (value <= range.low * (1 + WARNING_BAND_RATIO)) return 'warning_low';
  }
  return 'normal';
}

export function getMetricLabel(key: string): string | null {
  return ALL_METRIC_DEFS[key]?.label ?? null;
}

export function getMetricUnit(key: string): string | null {
  return ALL_METRIC_DEFS[key]?.unit ?? null;
}

// #1051 UX3-07: 色(赤/オレンジのドット)だけに頼らず、状態をテキストでも示す。
export function getStatusLabel(status: MetricStatus): string | null {
  switch (status) {
    case 'high':
      return '基準超';
    case 'low':
      return '基準未満';
    case 'warning_high':
      return 'やや高め';
    case 'warning_low':
      return 'やや低め';
    default:
      return null;
  }
}
