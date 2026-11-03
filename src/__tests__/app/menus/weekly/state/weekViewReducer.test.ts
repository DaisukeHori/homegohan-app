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

  // #2195 V1: 月のカレンダーの献立のある日は、読み直した範囲の答えをその範囲の正にする。
  // 足すだけ (MERGE) だと、範囲の中で献立が無くなった日 (AI 相談で消した食事の日など) の印が残った
  it('CALENDAR_MEAL_DATES_REPLACE_RANGE は範囲の中 (両端を含む) だけを答えに置き換え、範囲の外の日は残す（#2195 V1）', () => {
    const state: WeekViewState = {
      ...initialWeekViewState,
      calendarMealDates: new Set(['2026-10-31', '2026-11-01', '2026-11-03', '2026-11-09', '2026-11-10']),
    };
    const next = weekViewReducer(state, {
      type: 'CALENDAR_MEAL_DATES_REPLACE_RANGE',
      payload: { startDate: '2026-11-01', endDate: '2026-11-09', dates: new Set(['2026-11-05']) },
    });
    expect([...next.calendarMealDates].sort()).toEqual(['2026-10-31', '2026-11-05', '2026-11-10']);
    // 元の集合は変えない (新しい Set を返す)
    expect(state.calendarMealDates.has('2026-11-03')).toBe(true);
  });

  it('CALENDAR_MEAL_DATES_MERGE は足すだけ (範囲の中の古い日も残す。読み直しには REPLACE_RANGE を使う)', () => {
    const state: WeekViewState = { ...initialWeekViewState, calendarMealDates: new Set(['2026-11-03']) };
    const next = weekViewReducer(state, { type: 'CALENDAR_MEAL_DATES_MERGE', payload: new Set(['2026-11-05']) });
    expect([...next.calendarMealDates].sort()).toEqual(['2026-11-03', '2026-11-05']);
  });
});
