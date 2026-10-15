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

/**
 * 食事の区分ごとの絵文字 (#1665)。Web とモバイルで同じ値を使う見た目はここに置く (表示名は MEAL_LABELS)。
 * 色・アイコンの部品のようにプラットフォームで持ち方が違う見た目は、Web は src/lib/meal-type-visuals.ts、
 * モバイルは apps/mobile/src/lib/meal-type-visuals.ts に 1 か所ずつ置く。
 * Record<MealType, …> なので、MealType に値が増えると tsc が漏れを止める。
 */
export const MEAL_EMOJIS: Record<MealType, string> = {
  breakfast: '🌅',
  lunch: '☀️',
  dinner: '🌙',
  snack: '🍪',
  midnight_snack: '🌃',
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
 * キャストで型を外さず、これで絞る。値の正本は MEAL_ORDER。
 */
export function isMealType(value: string): value is MealType {
  return MEAL_ORDER.some((mealType) => mealType === value);
}
