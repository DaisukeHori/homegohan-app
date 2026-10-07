/**
 * #1205: 食事 (planned_meals) の登録・更新で受け取る meal_type と栄養素 4 列の共通バリデータ。
 *
 * 以前は POST /api/meals・PATCH /api/meals/[id]・POST /api/meal-plans/meals・PATCH /api/meal-plans/meals/[id] が
 * calories_kcal / protein_g / fat_g / carbs_g / meal_type を型・範囲の確認なしにそのまま INSERT / UPDATE へ渡していた。
 * 負の値・NaN・桁外れの値が保存され、摂取カロリーの合計やエクスポートが静かに狂った。
 *
 * 範囲は AI 相談経由の更新 (src/lib/ai/consultation-action-executor.ts の sanitizeMealUpdate) と同じ値を共有する。
 * DB 側の CHECK 制約 (supabase/migrations/20261007160500_planned_meals_value_checks.sql) は、
 * ここより緩い範囲 (calories 20000 / protein・fat・carbs 2000) で、アプリ層を通らない書き込み
 * (モバイルの直接 INSERT・Edge Function) の最後の砦として働く。ここの範囲を広げるときは DB 側も合わせて確認する。
 *
 * 入力の扱い (栄養素):
 *   - undefined      キーが無いのと同じ。何も書かない (PATCH で既存値を残す)。
 *   - null           値なし。DB には NULL を書く (入力欄を空にして消す操作)。
 *   - number         有限の数だけ。NaN / Infinity (JSON の 1e999 も) は不正。
 *   - 数字だけの文字列  数値として読む ("520"・"20.5")。指数表記・16 進・"NaN"・"Infinity"・空文字は不正。
 *   - それ以外 (真偽値・配列・オブジェクト)  不正。
 *   - 範囲は送られた値のまま確認する (0 以上・上限以下)。範囲内なら、calories_kcal は DB が integer のため
 *     小数を四捨五入する (モバイルの編集画面は合計 kcal を小数で送り得る)。範囲内の値は丸めても範囲内のまま。
 */

import type { MealType } from '@homegohan/shared';

// ==================== meal_type ====================

/**
 * planned_meals.meal_type に入れてよい値。packages/shared の MealType (5 値) と、DB の
 * planned_meals_meal_type_check と同じ。夜食 (midnight_snack) を含む (UI・献立生成が使う)。
 * MealType と食い違わないことは src/__tests__/lib/planned-meal-validation.test.ts で確認する。
 */
export const PLANNED_MEAL_TYPES = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'midnight_snack',
] as const satisfies readonly MealType[];

export type PlannedMealType = (typeof PLANNED_MEAL_TYPES)[number];

export function isPlannedMealType(value: unknown): value is PlannedMealType {
  return typeof value === 'string' && (PLANNED_MEAL_TYPES as readonly string[]).includes(value);
}

// ==================== 栄養素 4 列 ====================

export const PLANNED_MEAL_NUTRIENT_FIELDS = ['calories_kcal', 'protein_g', 'fat_g', 'carbs_g'] as const;

export type PlannedMealNutrientField = (typeof PLANNED_MEAL_NUTRIENT_FIELDS)[number];

export interface PlannedMealNutrientLimit {
  min: number;
  max: number;
  /** DB の列が integer か (true なら小数を四捨五入する) */
  integer: boolean;
  /** エラーメッセージに使う表示名 */
  label: string;
}

/** 1 食あたりの上限。AI 相談経由の更新 (consultation-action-executor.ts) と共有する。 */
export const PLANNED_MEAL_NUTRIENT_LIMITS: Record<PlannedMealNutrientField, PlannedMealNutrientLimit> = {
  calories_kcal: { min: 0, max: 5000, integer: true, label: 'エネルギー(kcal)' },
  protein_g: { min: 0, max: 500, integer: false, label: 'たんぱく質(g)' },
  fat_g: { min: 0, max: 300, integer: false, label: '脂質(g)' },
  carbs_g: { min: 0, max: 800, integer: false, label: '炭水化物(g)' },
};

/** 数字だけの文字列 (符号は - のみ。前後の空白は呼び出し側で trim する)。指数表記・16 進・Infinity・NaN・空文字は含めない。 */
const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;

/** number か数字だけの文字列を有限の数にする。読めなければ null。 */
function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!NUMERIC_STRING.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** integer 列は四捨五入し、-0 は 0 にそろえる (範囲内の値に使う)。 */
function normalize(limit: PlannedMealNutrientLimit, value: number): number {
  const rounded = limit.integer ? Math.round(value) : value;
  return rounded === 0 ? 0 : rounded;
}

function rangeMessage(limit: PlannedMealNutrientLimit): string {
  return `${limit.label} は ${limit.min} 〜 ${limit.max} の範囲の数値で指定してください`;
}

type NutrientParse = { ok: true; value: number | null } | { ok: false; message: string };

function parseNutrient(field: PlannedMealNutrientField, raw: unknown): NutrientParse {
  const limit = PLANNED_MEAL_NUTRIENT_LIMITS[field];
  if (raw === null) return { ok: true, value: null };
  const numeric = toFiniteNumber(raw);
  if (numeric === null || numeric < limit.min || numeric > limit.max) {
    return { ok: false, message: rangeMessage(limit) };
  }
  return { ok: true, value: normalize(limit, numeric) };
}

// ==================== ルートから使う入口 ====================

export type PlannedMealNutrientValues = Partial<Record<PlannedMealNutrientField, number | null>>;

export type PlannedMealValidationField = 'meal_type' | PlannedMealNutrientField;

export type PlannedMealValidationFailure = {
  ok: false;
  /** そのまま画面に出せる 1 行のメッセージ (複数あるときは ' / ' でつなぐ) */
  error: string;
  /** 不正だった項目ごとのメッセージ (キーは DB の列名) */
  fieldErrors: Partial<Record<PlannedMealValidationField, string>>;
};

export type PlannedMealValidationResult =
  | {
      ok: true;
      /** 入力に mealType を渡したときだけ入る (検証済み) */
      mealType?: PlannedMealType;
      /**
       * 検証・正規化済みの値。入力で undefined (キー無し) だった項目は含まれない。
       * null は「値なし」、calories_kcal は整数に丸め済み。
       */
      nutrients: PlannedMealNutrientValues;
    }
  | PlannedMealValidationFailure;

const MEAL_TYPE_MESSAGE = `mealType は ${PLANNED_MEAL_TYPES.join(' / ')} のいずれかを指定してください`;

/**
 * リクエストから取り出した meal_type と栄養素を検証する。DB に触れる前に呼ぶ。
 *
 * - `mealType` のキーを渡したとき (値が undefined でも) 必須として検証する。PATCH のように
 *   meal_type を受け取らないルートは、キーごと渡さない。
 * - `nutrients` は DB の列名をキーにする。値が undefined の項目は「送られていない」として飛ばす。
 */
export function validatePlannedMealInput(input: {
  mealType?: unknown;
  nutrients?: Partial<Record<PlannedMealNutrientField, unknown>>;
}): PlannedMealValidationResult {
  const fieldErrors: PlannedMealValidationFailure['fieldErrors'] = {};

  let mealType: PlannedMealType | undefined;
  if ('mealType' in input) {
    if (isPlannedMealType(input.mealType)) {
      mealType = input.mealType;
    } else {
      fieldErrors.meal_type = MEAL_TYPE_MESSAGE;
    }
  }

  const nutrients: PlannedMealNutrientValues = {};
  for (const field of PLANNED_MEAL_NUTRIENT_FIELDS) {
    const raw = input.nutrients?.[field];
    if (raw === undefined) continue;
    const parsed = parseNutrient(field, raw);
    if (parsed.ok) {
      nutrients[field] = parsed.value;
    } else {
      fieldErrors[field] = parsed.message;
    }
  }

  const messages = Object.values(fieldErrors);
  if (messages.length > 0) {
    return { ok: false, error: messages.join(' / '), fieldErrors };
  }
  return { ok: true, mealType, nutrients };
}

/**
 * 400 レスポンスの本文。`error` は既存のクライアント (web の alert・モバイルの Alert) が
 * そのまま表示する文字列で、`fieldErrors` で項目ごとに引ける。
 */
export function plannedMealValidationErrorBody(failure: PlannedMealValidationFailure) {
  return {
    error: failure.error,
    code: 'VALIDATION_ERROR' as const,
    fieldErrors: failure.fieldErrors,
  };
}

// ==================== AI の推定値 ====================

/**
 * AI の推定値 (写真解析の合計など) を保存用に整える。人が入力した値と違い、AI は桁を間違えることがあり、
 * そのせいで写真から登録する操作ごと失敗させない。
 *   - 数値として読めない・負の値 → null (値なし)
 *   - 上限を超える値 → 上限
 *   - calories_kcal の小数 → 四捨五入
 * 入力が undefined のときは undefined を返す (呼び出し側は、キーを書かないことで既存値を残せる)。
 */
export function sanitizeAiNutrient(field: PlannedMealNutrientField, raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  const limit = PLANNED_MEAL_NUTRIENT_LIMITS[field];
  const numeric = toFiniteNumber(raw);
  if (numeric === null || numeric < limit.min) return null;
  return normalize(limit, Math.min(numeric, limit.max));
}
