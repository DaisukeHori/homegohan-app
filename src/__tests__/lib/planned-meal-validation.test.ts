/**
 * src/__tests__/lib/planned-meal-validation.test.ts
 *
 * #1205: 食事 (planned_meals) の登録・更新 API が受け取る meal_type と栄養素 4 列の共通バリデータ。
 * 以前は 4 つのルートが calories_kcal / protein_g / fat_g / carbs_g / meal_type を型・範囲の確認なしに
 * DB へ渡していたため、負の値・NaN・桁外れの値・想定外の meal_type がそのまま保存された。
 *
 * - 範囲外・NaN・Infinity・数値でない値は不正として、項目ごとのメッセージ付きで拒否される
 * - undefined (キー無し) は書かない、null は「値なし」、数字だけの文字列は数値として読む
 * - calories_kcal は整数列のため、範囲を確認した後に四捨五入する
 * - meal_type は packages/shared の MealType (夜食 midnight_snack を含む 5 値)
 * - AI の推定値は保存を止めず、範囲内に整える
 */

import { describe, it, expect } from 'vitest';
import { MEAL_ORDER } from '@homegohan/shared';
import {
  PLANNED_MEAL_NUTRIENT_FIELDS,
  PLANNED_MEAL_NUTRIENT_LIMITS,
  PLANNED_MEAL_TYPES,
  isPlannedMealType,
  plannedMealValidationErrorBody,
  sanitizeAiNutrient,
  validatePlannedMealInput,
  type PlannedMealNutrientField,
} from '@/lib/planned-meal-validation';

function nutrients(input: Partial<Record<PlannedMealNutrientField, unknown>>) {
  return validatePlannedMealInput({ nutrients: input });
}

describe('PLANNED_MEAL_TYPES / isPlannedMealType', () => {
  it('packages/shared の MealType (5 値。夜食を含む) と同じ集合', () => {
    expect([...PLANNED_MEAL_TYPES].sort()).toEqual([...MEAL_ORDER].sort());
    expect(PLANNED_MEAL_TYPES).toContain('midnight_snack');
  });

  it.each(['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'])('%s は許可される', (value) => {
    expect(isPlannedMealType(value)).toBe(true);
  });

  it.each([
    ['存在しない値', 'brunch'],
    ['空文字', ''],
    ['大文字', 'Breakfast'],
    ['前後に空白', 'lunch '],
    ['日本語', '朝食'],
    ['null', null],
    ['undefined', undefined],
    ['数値', 1],
    ['配列', ['lunch']],
    ['オブジェクト', { mealType: 'lunch' }],
  ])('%s は許可されない', (_label, value) => {
    expect(isPlannedMealType(value)).toBe(false);
  });
});

describe('栄養素の範囲 (AI 相談経由の更新と同じ値)', () => {
  it('calories 0〜5000 / protein 0〜500 / fat 0〜300 / carbs 0〜800', () => {
    expect(PLANNED_MEAL_NUTRIENT_FIELDS).toEqual(['calories_kcal', 'protein_g', 'fat_g', 'carbs_g']);
    expect(PLANNED_MEAL_NUTRIENT_LIMITS.calories_kcal).toMatchObject({ min: 0, max: 5000, integer: true });
    expect(PLANNED_MEAL_NUTRIENT_LIMITS.protein_g).toMatchObject({ min: 0, max: 500, integer: false });
    expect(PLANNED_MEAL_NUTRIENT_LIMITS.fat_g).toMatchObject({ min: 0, max: 300, integer: false });
    expect(PLANNED_MEAL_NUTRIENT_LIMITS.carbs_g).toMatchObject({ min: 0, max: 800, integer: false });
  });
});

describe('validatePlannedMealInput: 栄養素', () => {
  it('範囲内の値はそのまま通る (境界を含む)', () => {
    const result = nutrients({ calories_kcal: 5000, protein_g: 0, fat_g: 300, carbs_g: 0.5 });
    expect(result).toEqual({
      ok: true,
      mealType: undefined,
      nutrients: { calories_kcal: 5000, protein_g: 0, fat_g: 300, carbs_g: 0.5 },
    });
  });

  it('undefined (キー無し) の項目は結果に含まれない。何も渡さなくても通る', () => {
    const partial = nutrients({ calories_kcal: 600, protein_g: undefined });
    expect(partial).toMatchObject({ ok: true, nutrients: { calories_kcal: 600 } });
    expect(Object.keys((partial as { nutrients: object }).nutrients)).toEqual(['calories_kcal']);

    expect(validatePlannedMealInput({})).toEqual({ ok: true, mealType: undefined, nutrients: {} });
    expect(nutrients({})).toEqual({ ok: true, mealType: undefined, nutrients: {} });
  });

  it('null は「値なし」として通り、結果にも null で入る (入力欄を空にして消す操作)', () => {
    const result = nutrients({ calories_kcal: null, protein_g: null, fat_g: null, carbs_g: null });
    expect(result).toMatchObject({
      ok: true,
      nutrients: { calories_kcal: null, protein_g: null, fat_g: null, carbs_g: null },
    });
  });

  describe('範囲外は項目ごとのメッセージ付きで拒否される', () => {
    it.each([
      ['calories_kcal', -1],
      ['calories_kcal', 5001],
      ['calories_kcal', 1e9],
      ['protein_g', -0.1],
      ['protein_g', 500.01],
      ['fat_g', -5],
      ['fat_g', 300.5],
      ['carbs_g', -1],
      ['carbs_g', 801],
    ] as const)('%s = %s', (field, value) => {
      const result = nutrients({ [field]: value });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(Object.keys(result.fieldErrors)).toEqual([field]);
      const limit = PLANNED_MEAL_NUTRIENT_LIMITS[field];
      expect(result.fieldErrors[field]).toBe(
        `${limit.label} は ${limit.min} 〜 ${limit.max} の範囲の数値で指定してください`,
      );
      expect(result.error).toBe(result.fieldErrors[field]);
    });
  });

  describe('数値でない値・NaN・Infinity は拒否される', () => {
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['JSON の 1e999 (パース結果は Infinity)', JSON.parse('1e999')],
      ['文字列 "NaN"', 'NaN'],
      ['文字列 "Infinity"', 'Infinity'],
      ['文字列 "-Infinity"', '-Infinity'],
      ['文字列 "abc"', 'abc'],
      ['空文字', ''],
      ['空白だけ', '   '],
      ['指数表記の文字列', '1e3'],
      ['16 進の文字列', '0x10'],
      ['桁区切りの文字列', '1,000'],
      ['数値と単位の文字列', '500kcal'],
      ['全角数字', '５００'],
      ['true', true],
      ['false', false],
      ['配列', [500]],
      ['空の配列', []],
      ['オブジェクト', { value: 500 }],
    ])('%s', (_label, value) => {
      for (const field of PLANNED_MEAL_NUTRIENT_FIELDS) {
        const result = nutrients({ [field]: value });
        expect(result.ok, `${field} に ${String(_label)} を入れたら拒否されるはず`).toBe(false);
      }
    });
  });

  describe('数字だけの文字列は数値として読む', () => {
    it.each([
      ['420', 420],
      [' 420 ', 420],
      ['20.5', 20.5],
      ['0', 0],
      ['-0', 0],
      ['0.0', 0],
    ])('"%s" → %s', (text, expected) => {
      expect(nutrients({ protein_g: text })).toMatchObject({ ok: true, nutrients: { protein_g: expected } });
    });

    it('範囲外の数字文字列は拒否される', () => {
      expect(nutrients({ calories_kcal: '-5' }).ok).toBe(false);
      expect(nutrients({ calories_kcal: '99999' }).ok).toBe(false);
    });
  });

  describe('calories_kcal は整数列のため、範囲を確認した後に四捨五入する', () => {
    it.each([
      [523.4, 523],
      [523.5, 524],
      [523.6, 524],
      ['523.5', 524],
      [0.4, 0],
      [4999.5, 5000],
      [5000, 5000],
      [-0, 0],
    ])('%s → %s', (input, expected) => {
      const result = nutrients({ calories_kcal: input });
      expect(result).toMatchObject({ ok: true, nutrients: { calories_kcal: expected } });
      // -0 は 0 にそろえる (JSON では同じだが、比較や表示で紛れないように)
      expect(Object.is((result as { nutrients: { calories_kcal: number } }).nutrients.calories_kcal, -0)).toBe(false);
    });

    it.each([5000.4, 5000.5, 5001, -0.4, -0.5, -1])('%s は送られた値のまま範囲外', (input) => {
      expect(nutrients({ calories_kcal: input }).ok).toBe(false);
    });

    it('protein_g / fat_g / carbs_g は丸めない', () => {
      expect(nutrients({ protein_g: 20.55, fat_g: 0.25, carbs_g: 99.99 })).toMatchObject({
        ok: true,
        nutrients: { protein_g: 20.55, fat_g: 0.25, carbs_g: 99.99 },
      });
    });
  });

  it('複数の項目が不正なときは、すべてを fieldErrors に入れ、error は " / " でつなぐ', () => {
    const result = nutrients({ calories_kcal: -1, protein_g: 'abc', fat_g: 100, carbs_g: 9999 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(['calories_kcal', 'carbs_g', 'protein_g']);
    expect(result.error.split(' / ')).toHaveLength(3);
  });

  it('不正な項目が 1 つでもあれば、正しい項目も含めて ok: false', () => {
    const result = nutrients({ calories_kcal: 500, protein_g: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors)).toEqual(['protein_g']);
  });
});

describe('validatePlannedMealInput: meal_type', () => {
  it.each(PLANNED_MEAL_TYPES)('%s は通り、検証済みの値が返る', (mealType) => {
    expect(validatePlannedMealInput({ mealType })).toEqual({ ok: true, mealType, nutrients: {} });
  });

  it.each(['brunch', '', 'Breakfast', 'lunch ', '朝食', null, undefined, 5, ['lunch']])(
    'mealType = %j は拒否される (キーを渡した場合は値が undefined でも必須として扱う)',
    (mealType) => {
      const result = validatePlannedMealInput({ mealType });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(Object.keys(result.fieldErrors)).toEqual(['meal_type']);
      expect(result.fieldErrors.meal_type).toContain('midnight_snack');
    },
  );

  it('mealType のキーを渡さなければ検証しない (PATCH のように meal_type を受け取らないルート)', () => {
    const result = validatePlannedMealInput({ nutrients: { calories_kcal: 500 } });
    expect(result).toEqual({ ok: true, mealType: undefined, nutrients: { calories_kcal: 500 } });
  });

  it('meal_type と栄養素の両方が不正なときは両方のメッセージを返す', () => {
    const result = validatePlannedMealInput({ mealType: 'brunch', nutrients: { calories_kcal: -1 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(['calories_kcal', 'meal_type']);
  });
});

describe('plannedMealValidationErrorBody', () => {
  it('error (画面にそのまま出せる 1 行) / code / fieldErrors を返す', () => {
    const result = validatePlannedMealInput({ mealType: 'brunch', nutrients: { calories_kcal: 99999 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = plannedMealValidationErrorBody(result);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('エネルギー(kcal)');
    expect(body.error).toContain('mealType');
    expect(body.fieldErrors).toEqual(result.fieldErrors);
  });
});

describe('sanitizeAiNutrient (AI の推定値は保存を止めず、範囲内に整える)', () => {
  it('範囲内の値はそのまま', () => {
    expect(sanitizeAiNutrient('calories_kcal', 640)).toBe(640);
    expect(sanitizeAiNutrient('protein_g', 28.4)).toBe(28.4);
    expect(sanitizeAiNutrient('calories_kcal', 0)).toBe(0);
  });

  it('上限を超える値は上限にする', () => {
    expect(sanitizeAiNutrient('calories_kcal', 99999)).toBe(5000);
    expect(sanitizeAiNutrient('protein_g', 1e6)).toBe(500);
    expect(sanitizeAiNutrient('fat_g', 301)).toBe(300);
    expect(sanitizeAiNutrient('carbs_g', 801)).toBe(800);
  });

  it('負の値・数値として読めない値・NaN・Infinity は null (値なし)', () => {
    for (const bad of [-1, -0.6, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '', 'NaN', {}, [], true]) {
      expect(sanitizeAiNutrient('calories_kcal', bad), String(bad)).toBeNull();
      expect(sanitizeAiNutrient('protein_g', bad), String(bad)).toBeNull();
    }
  });

  it('null は null、undefined は undefined (呼び出し側は、キーを書かないことで既存値を残せる)', () => {
    expect(sanitizeAiNutrient('calories_kcal', null)).toBeNull();
    expect(sanitizeAiNutrient('calories_kcal', undefined)).toBeUndefined();
  });

  it('calories_kcal の小数は四捨五入、数字の文字列は数値として読む', () => {
    expect(sanitizeAiNutrient('calories_kcal', 620.4)).toBe(620);
    expect(sanitizeAiNutrient('calories_kcal', 620.5)).toBe(621);
    expect(sanitizeAiNutrient('calories_kcal', '620')).toBe(620);
    expect(sanitizeAiNutrient('protein_g', '28.4')).toBe(28.4);
  });

  it('小さな負の値 (-0.4) も負の値として null。-0 は 0 にそろえる', () => {
    expect(sanitizeAiNutrient('calories_kcal', -0.4)).toBeNull();
    expect(sanitizeAiNutrient('calories_kcal', -0)).toBe(0);
    expect(Object.is(sanitizeAiNutrient('calories_kcal', -0), -0)).toBe(false);
  });

  it('上限の手前の小数は四捨五入して上限まで (4999.5 → 5000)、上限を超える小数は上限', () => {
    expect(sanitizeAiNutrient('calories_kcal', 4999.5)).toBe(5000);
    expect(sanitizeAiNutrient('calories_kcal', 5000.4)).toBe(5000);
  });
});
