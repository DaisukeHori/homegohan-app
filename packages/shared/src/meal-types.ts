/**
 * 食事タイプ定数
 */

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '朝食',
  lunch: '昼食',
  dinner: '夕食',
  snack: 'おやつ',
  midnight_snack: '夜食',
};

export const MEAL_ORDER: MealType[] = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'midnight_snack',
];

/**
 * 文字列が食事の区分 (MealType の 5 値) のどれかかを確かめる型ガード (#1446)。
 * DB の行の meal_type は string で来るので、MEAL_ORDER.indexOf などに渡す前に
 * `as any` / `as MealType` で型を外さず、これで絞る。値の正本は MEAL_ORDER。
 */
export function isMealType(value: string): value is MealType {
  return MEAL_ORDER.some((mealType) => mealType === value);
}
