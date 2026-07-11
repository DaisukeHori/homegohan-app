// src/__tests__/app/menus/weekly/state/weekViewReducer.test.ts
// Issue #1032 (F1b-04 / F1b-05): 互換 setter 層の二重 dispatch バグの回帰防止。
//
// F1b-04: DAY_NUTRITION_SET は渡された真偽値をそのまま反映する（無条件 TOGGLE にしない）。
//         (旧: setIsDayNutritionExpanded(false) が DAY_NUTRITION_TOGGLE を dispatch していたため、
//          日タブ切替のたびに栄養パネルが勝手に開閉していた)
// F1b-05: AUTO_EXPAND_SUPPRESS は hasAutoExpanded だけを立て、selectedDayIndex/expandedMealId は上書きしない。
//         (旧: setHasAutoExpanded(true) が no-op で、カレンダー選択日が自動展開ロジックに上書きされていた)

import { describe, it, expect } from 'vitest';
import {
  weekViewReducer,
  initialWeekViewState,
  type WeekViewState,
} from '@/app/(main)/menus/weekly/_state/reducers/weekViewReducer';

describe('weekViewReducer', () => {
  it('DAY_NUTRITION_SET(false) は開いている状態を閉じる（#1032 F1b-04）', () => {
    const expanded: WeekViewState = { ...initialWeekViewState, isDayNutritionExpanded: true };
    const next = weekViewReducer(expanded, { type: 'DAY_NUTRITION_SET', payload: false });
    expect(next.isDayNutritionExpanded).toBe(false);
  });

  it('DAY_NUTRITION_SET(false) は閉じている状態のまま維持する（旧 TOGGLE 実装だと誤って開いてしまうケース）', () => {
    const collapsed: WeekViewState = { ...initialWeekViewState, isDayNutritionExpanded: false };
    const next = weekViewReducer(collapsed, { type: 'DAY_NUTRITION_SET', payload: false });
    expect(next.isDayNutritionExpanded).toBe(false);
  });

  it('DAY_NUTRITION_TOGGLE は依然として反転動作する（明示クリックでのトグルは維持）', () => {
    const collapsed: WeekViewState = { ...initialWeekViewState, isDayNutritionExpanded: false };
    const next = weekViewReducer(collapsed, { type: 'DAY_NUTRITION_TOGGLE' });
    expect(next.isDayNutritionExpanded).toBe(true);
  });

  it('AUTO_EXPAND_SUPPRESS は hasAutoExpanded のみ立て、selectedDayIndex/expandedMealId は変更しない（#1032 F1b-05）', () => {
    const state: WeekViewState = {
      ...initialWeekViewState,
      hasAutoExpanded: false,
      selectedDayIndex: 3,
      expandedMealId: 'meal-abc',
    };
    const next = weekViewReducer(state, { type: 'AUTO_EXPAND_SUPPRESS' });
    expect(next.hasAutoExpanded).toBe(true);
    expect(next.selectedDayIndex).toBe(3);
    expect(next.expandedMealId).toBe('meal-abc');
  });

  it('MEAL_AUTO_EXPANDED は hasAutoExpanded に加え selectedDayIndex/expandedMealId も更新する（AUTO_EXPAND_SUPPRESS とは別物）', () => {
    const next = weekViewReducer(initialWeekViewState, {
      type: 'MEAL_AUTO_EXPANDED',
      payload: { mealId: 'meal-xyz', dayIndex: 5 },
    });
    expect(next.hasAutoExpanded).toBe(true);
    expect(next.selectedDayIndex).toBe(5);
    expect(next.expandedMealId).toBe('meal-xyz');
  });
});
