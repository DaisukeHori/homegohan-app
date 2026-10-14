/**
 * 食事の区分 (meal-types) の正本のテスト (#1446)
 *
 * Web の献立画面・食事を追加するモーダルとモバイルの献立画面は、5 値の手書きをやめて
 * ここの MealType / MEAL_ORDER / isMealType から導く。値と並びが変わると
 * 画面の選択肢の順と献立の並び順が変わるので、ここで固定する。
 */
import { describe, expect, it } from 'vitest';
import { MEAL_LABELS, MEAL_ORDER, isMealType } from './meal-types';

describe('MEAL_ORDER (食事の区分の正本)', () => {
  it('5 値が朝食 → 昼食 → 夕食 → おやつ → 夜食の順に並ぶ', () => {
    expect(MEAL_ORDER).toEqual(['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack']);
  });

  it('MEAL_LABELS のキーと同じ集合 (重複なし)', () => {
    expect(new Set(MEAL_ORDER).size).toBe(MEAL_ORDER.length);
    expect([...MEAL_ORDER].sort()).toEqual(Object.keys(MEAL_LABELS).sort());
  });
});

describe('isMealType', () => {
  it('MEAL_ORDER の 5 値はすべて true', () => {
    for (const mealType of MEAL_ORDER) {
      expect(isMealType(mealType)).toBe(true);
    }
  });

  it.each(['', 'Breakfast', 'brunch', 'midnight-snack', 'toString', '__proto__', ' breakfast'])(
    '5 値以外の %j は false',
    (value) => {
      expect(isMealType(value)).toBe(false);
    },
  );
});
