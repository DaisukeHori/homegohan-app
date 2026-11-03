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
  plannedMealFieldsOf,
  type WeekViewState,
} from '@/app/(main)/menus/weekly/_state/reducers/weekViewReducer';
import { toPlannedMeal } from '@/lib/converter';

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

  // #2201 U2: 楽観的な更新とその巻き戻しは、今の献立の 1 つの食事にだけ当てる。描画の時点の献立の写しから週全体を作り直して
  // PLAN_SET で置くと、その描画のあとに置いた献立 (AI 相談の成功の取り直しの応答) を写しの古い献立で戻した
  describe('PLAN_MEAL_UPDATE (#2201 U2)', () => {
    const meal = (id: string, dishName: string, isCompleted = false) =>
      toPlannedMeal({ id, daily_meal_id: 'day-1', meal_type: 'dinner', dish_name: dishName, is_completed: isCompleted });
    /** 取り直しが置いた今の献立 (AI 相談で 2 つ目の食事を変えた) */
    const latest: WeekViewState = {
      ...initialWeekViewState,
      currentPlan: {
        days: [
          { id: 'day-1', dayDate: '2026-11-02', meals: [meal('meal-1', '鮭の塩焼き'), meal('meal-2', 'AI が変えた肉じゃが')] },
          { id: 'day-2', dayDate: '2026-11-03', meals: [meal('meal-3', '親子丼')] },
        ],
      },
    };

    it('今の献立のその食事にだけ当て、ほかの食事・ほかの日 (取り直しが置いた値) はそのまま', () => {
      const next = weekViewReducer(latest, { type: 'PLAN_MEAL_UPDATE', payload: { dayId: 'day-1', mealId: 'meal-1', updates: { isCompleted: true } } });
      const [day1, day2] = next.currentPlan?.days ?? [];
      expect(day1.meals?.map((m) => [m.id, m.dishName, m.isCompleted])).toEqual([
        ['meal-1', '鮭の塩焼き', true],
        ['meal-2', 'AI が変えた肉じゃが', false],
      ]);
      expect(day2).toBe(latest.currentPlan?.days[1]);
      // 元の献立は変えない
      expect(latest.currentPlan?.days[0].meals?.[0].isCompleted).toBe(false);
    });

    it('献立が無い・その日にその食事が無いときは何もしない', () => {
      expect(weekViewReducer(initialWeekViewState, { type: 'PLAN_MEAL_UPDATE', payload: { dayId: 'day-1', mealId: 'meal-1', updates: { isCompleted: true } } })).toBe(
        initialWeekViewState,
      );
      expect(weekViewReducer(latest, { type: 'PLAN_MEAL_UPDATE', payload: { dayId: 'day-2', mealId: 'meal-1', updates: { isCompleted: true } } })).toBe(latest);
    });

    it('plannedMealFieldsOf は updates が変える項目の今の値だけを返す (巻き戻しで、ほかの項目を戻さない)', () => {
      const before = meal('meal-1', '鮭の塩焼き', false);
      expect(plannedMealFieldsOf(before, { isCompleted: true })).toEqual({ isCompleted: false });
      expect(plannedMealFieldsOf(before, { dishName: '焼き鮭', mode: 'buy' })).toEqual({ dishName: '鮭の塩焼き', mode: before.mode });
    });
  });
});
