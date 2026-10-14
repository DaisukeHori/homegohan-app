// ハンズオンツアー Step 1 (写真から食事を記録) の保存で送る本文 (#1604)。
//
// 設計書 docs/design/family/09-onboarding-handson-tour/03-step1-photo.md §3.7 の保存の決め:
//   - いつの食事か: 保存した「今」(eaten_at: new Date())
//   - 食事の種類: 夕食 (meal_type: 'dinner')
//   - 料理: サンプルの固定値 (MOCK_PHOTO_RESPONSE の料理名・カロリー)。写真はサンプルなので保存しない (photo_url: null)
//   - お試しの記録として送る (sandbox: true。URL の ?source=handson_tour と組)
// POST /api/meal-plans/add-from-photo は本文の dayDate (YYYY-MM-DD) と mealType を読む。以前は MOCK_PHOTO_RESPONSE を
// そのまま送っていて dayDate / mealType が無く、mealType の検証で 400 になっていた (#846 の E2E で発見)。
// 「今」は DB の日付列と同じ JST の暦日にする (user_daily_meals.day_date は JST の暦日。src/lib/jst-day-ranges.ts)。

import { MOCK_PHOTO_RESPONSE } from '@homegohan/handson-tour-shared';
import { jstToday } from '@/lib/jst-day-ranges';
import type { PlannedMealType } from '@/lib/planned-meal-validation';

/** ツアーの保存先。?source=handson_tour で、記録の出どころ (planned_meals.source_type) が handson_tour になる */
export const TOUR_PHOTO_SAVE_URL = '/api/meal-plans/add-from-photo?source=handson_tour';

/** お試しの記録の食事の種類 (設計書 03-step1 §3.7 の meal_type: 'dinner') */
export const TOUR_PHOTO_MEAL_TYPE = 'dinner' as const satisfies PlannedMealType;

/** サンプルの料理の役割 (定食 1 品を主菜として記録する。route の既定は 'side') */
const TOUR_PHOTO_DISH_ROLE = 'main';

export type TourPhotoSaveBody = {
  sandbox: true;
  dayDate: string;
  mealType: typeof TOUR_PHOTO_MEAL_TYPE;
  dishes: Array<{ name: string; cal: number; role: string }>;
  totalCalories: number;
  imageUrl: null;
};

/**
 * Step 1 の保存で送る本文。dayDate は now の JST の暦日。
 * @param now 保存した時刻 (テストで固定するための引数。既定は今)
 */
export function buildTourPhotoSaveBody(now: Date = new Date()): TourPhotoSaveBody {
  return {
    sandbox: true,
    dayDate: jstToday(now),
    mealType: TOUR_PHOTO_MEAL_TYPE,
    dishes: [
      {
        name: MOCK_PHOTO_RESPONSE.dishName,
        cal: MOCK_PHOTO_RESPONSE.calories,
        role: TOUR_PHOTO_DISH_ROLE,
      },
    ],
    totalCalories: MOCK_PHOTO_RESPONSE.calories,
    imageUrl: null,
  };
}
