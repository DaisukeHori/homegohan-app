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
