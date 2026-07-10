/**
 * 手動カロリー調整の範囲検証 (#1055 UX3-19)
 *
 * nutrition-target-planner.tsx:383 付近で、HTML の min/max 属性だけでは
 * 500kcal のような極端な値の保存を防げていなかったための対応。
 * ロジックをコンポーネントから切り出し、単体テスト可能にする。
 */

export const MIN_MANUAL_CALORIES = 1000;
export const MAX_MANUAL_CALORIES = 5000;

export function getManualCalorieError(
  rawValue: string,
  numericValue: number,
): string | null {
  if (!rawValue) return '目標カロリーを入力してください。';
  if (numericValue < MIN_MANUAL_CALORIES || numericValue > MAX_MANUAL_CALORIES) {
    return `目標カロリーは ${MIN_MANUAL_CALORIES}〜${MAX_MANUAL_CALORIES}kcal の範囲で入力してください。`;
  }
  return null;
}

export function getBmrWarning(numericValue: number, bmrKcal: number | null | undefined): string | null {
  if (bmrKcal == null) return null;
  if (numericValue < bmrKcal) {
    return `基礎代謝 (BMR: ${bmrKcal}kcal) を下回っています。長期間続けると体調を崩す可能性があります。`;
  }
  return null;
}
