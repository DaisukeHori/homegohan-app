import { describe, expect, it } from 'vitest';
import {
  MAX_MANUAL_CALORIES,
  MIN_MANUAL_CALORIES,
  getBmrWarning,
  getManualCalorieError,
} from '../src/lib/nutrition-target-validation';

// #1055 UX3-19: nutrition-target-planner.tsx の手動カロリー調整が範囲検証なしで
// 保存できてしまっていた (500kcal 等) バグの契約テスト。
describe('nutrition-target-validation', () => {
  it('rejects empty input', () => {
    expect(getManualCalorieError('', 0)).toBeTruthy();
  });

  it('rejects values below the minimum (e.g. 500kcal from the bug report)', () => {
    expect(getManualCalorieError('500', 500)).toBeTruthy();
  });

  it('rejects values above the maximum', () => {
    expect(getManualCalorieError('6000', 6000)).toBeTruthy();
  });

  it('accepts values within the allowed range', () => {
    expect(getManualCalorieError('1800', 1800)).toBeNull();
    expect(getManualCalorieError(String(MIN_MANUAL_CALORIES), MIN_MANUAL_CALORIES)).toBeNull();
    expect(getManualCalorieError(String(MAX_MANUAL_CALORIES), MAX_MANUAL_CALORIES)).toBeNull();
  });

  it('warns (non-blocking) when the value is below BMR', () => {
    expect(getBmrWarning(1200, 1500)).toBeTruthy();
  });

  it('does not warn when the value is at or above BMR', () => {
    expect(getBmrWarning(1500, 1500)).toBeNull();
    expect(getBmrWarning(1800, 1500)).toBeNull();
  });

  it('does not warn when BMR is unknown', () => {
    expect(getBmrWarning(1200, null)).toBeNull();
    expect(getBmrWarning(1200, undefined)).toBeNull();
  });
});
