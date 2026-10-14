// ハンズオンツアー Step 1 (写真から食事を記録) の保存で送る本文と、応答の読み方 (#1604)。
//
// 設計書 docs/design/family/09-onboarding-handson-tour/03-step1-photo.md §3.7 の保存の決め:
//   - いつの食事か: 保存した「今」(eaten_at)。route がサーバーの今で入れる (src/lib/handson-tour/sandbox-photo-meal.ts)
//   - 食事の種類: 夕食 (meal_type: 'dinner')
//   - 料理: サンプルの固定値 (MOCK_PHOTO_RESPONSE の料理名・カロリー)。写真はサンプルなので保存しない (photo_url: null)
//   - お試しの記録として送る (sandbox: true。URL の ?source=handson_tour と組)
// 以前は MOCK_PHOTO_RESPONSE をそのまま送っていて mealType が無く、POST /api/meal-plans/add-from-photo の
// mealType の検証で 400 になっていた (#846 の E2E で発見)。
// お試しの記録は meals (is_sandbox = true) の 1 行に入り、日付 (dayDate) は使わないので送らない
// (今日の user_daily_meals を作ると、同じ日の本物の記録と一意キー UNIQUE(user_id, day_date) を取り合うため)。

import { MOCK_PHOTO_RESPONSE } from '@homegohan/handson-tour-shared';
import type { SandboxEligibilityError } from '@/lib/handson-tour/sandbox-eligibility';
import type { PlannedMealType } from '@/lib/planned-meal-validation';

/** ツアーの保存先。?source=handson_tour はツアーからの保存の目印 */
export const TOUR_PHOTO_SAVE_URL = '/api/meal-plans/add-from-photo?source=handson_tour';

/** お試しの記録の食事の種類 (設計書 03-step1 §3.7 の meal_type: 'dinner') */
export const TOUR_PHOTO_MEAL_TYPE = 'dinner' as const satisfies PlannedMealType;

/** サンプルの料理の役割 (定食 1 品を主菜として記録する。route の既定は 'side') */
const TOUR_PHOTO_DISH_ROLE = 'main';

/**
 * お試しの保存を受け付けない利用者への応答の code (src/lib/handson-tour/sandbox-eligibility.ts)。
 * ツアーを完了・スキップ済みで設定からやり直している利用者 (設計書 17-security §2.1 で 409 already_finished) など。
 */
const SANDBOX_NOT_ELIGIBLE_CODE = 'sandbox_not_eligible' as const satisfies SandboxEligibilityError['code'];

export type TourPhotoSaveBody = {
  sandbox: true;
  mealType: typeof TOUR_PHOTO_MEAL_TYPE;
  dishes: Array<{ name: string; cal: number; role: string }>;
  totalCalories: number;
  imageUrl: null;
};

/** Step 1 の保存で送る本文 */
export function buildTourPhotoSaveBody(): TourPhotoSaveBody {
  return {
    sandbox: true,
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

/**
 * 失敗の応答の本文が「この利用者はお試しの保存の対象ではない」(sandbox_not_eligible) かどうか。
 * そうなら何度送っても同じ答えになるので、画面はエラーにせず Step 2 へ進める
 * (設定からのやり直し = 設計書 01-trigger-flow §1.2 / §4.2 は、完了済みでも Step 4 まで通して見せる)。
 * @param body 応答の本文 (JSON として読めなかったときは null)
 */
export function isSandboxNotEligibleBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === SANDBOX_NOT_ELIGIBLE_CODE;
}
