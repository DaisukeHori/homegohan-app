// Phase B-2: weekView useReducer — 週カーソル + 日付ナビゲーション
import type { WeekStartDay, PlannedMeal } from '@/types/domain';

// -------------------------------------------------------
// State
// -------------------------------------------------------

/** 食事プランの1日分 */
interface MealPlanDay {
  id: string;
  dayDate: string;
  theme?: string | null;
  nutritionalFocus?: string | null;
  isCheatDay?: boolean;
  meals?: PlannedMeal[];
}

/** 週プラン */
interface WeekPlan {
  days: MealPlanDay[];
}

export interface WeekViewState {
  currentPlan: WeekPlan | null;
  weekStart: Date;
  selectedDayIndex: number;
  weekStartDay: WeekStartDay;
  weekStartDayLoaded: boolean;
  holidays: Record<string, string>;
  displayMonth: Date;
  isCalendarExpanded: boolean;
  calendarMealDates: Set<string>;
  expandedMealId: string | null;
  hasAutoExpanded: boolean;
  isDayNutritionExpanded: boolean;
  isTodayExpanded: boolean;
}

// -------------------------------------------------------
// Actions
// -------------------------------------------------------

export type WeekViewAction =
  | { type: 'WEEK_NAVIGATE_NEXT'; payload: Date }
  | { type: 'WEEK_NAVIGATE_PREV'; payload: Date }
  | { type: 'WEEK_SET_START'; payload: Date }
  | { type: 'DAY_SELECT'; payload: number }
  | { type: 'WEEK_START_DAY_LOADED'; payload: { weekStartDay: WeekStartDay; weekStart: Date } }
  | { type: 'HOLIDAYS_SET'; payload: Record<string, string> }
  | { type: 'DISPLAY_MONTH_SET'; payload: Date }
  | { type: 'CALENDAR_TOGGLE' }
  | { type: 'CALENDAR_MEAL_DATES_SET'; payload: Set<string> }
  | { type: 'CALENDAR_MEAL_DATES_MERGE'; payload: Set<string> }
  | { type: 'MEAL_EXPAND'; payload: string | null }
  | { type: 'MEAL_AUTO_EXPANDED'; payload: { mealId: string; dayIndex: number } }
  | { type: 'AUTO_EXPAND_SUPPRESS' }
  | { type: 'DAY_NUTRITION_TOGGLE' }
  | { type: 'DAY_NUTRITION_SET'; payload: boolean }
  | { type: 'TODAY_TOGGLE' }
  | { type: 'PLAN_SET'; payload: WeekPlan | null };

// -------------------------------------------------------
// Initial State
// -------------------------------------------------------

/** getWeekStart のデフォルト実装（月曜始まり） */
function getDefaultWeekStart(): Date {
  const d = new Date();
  const currentDay = d.getDay();
  const diff = currentDay === 0 ? -6 : 1 - currentDay; // monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

const _defaultWeekStart = getDefaultWeekStart();

export const initialWeekViewState: WeekViewState = {
  currentPlan: null,
  weekStart: _defaultWeekStart,
  selectedDayIndex: 0,
  weekStartDay: 'monday',
  weekStartDayLoaded: false,
  holidays: {},
  displayMonth: _defaultWeekStart,
  isCalendarExpanded: false,
  calendarMealDates: new Set(),
  expandedMealId: null,
  hasAutoExpanded: false,
  isDayNutritionExpanded: false,
  isTodayExpanded: false,
};

// -------------------------------------------------------
// Reducer
// -------------------------------------------------------

export function weekViewReducer(
  state: WeekViewState,
  action: WeekViewAction,
): WeekViewState {
  switch (action.type) {
    // UX2-24: 前週/次週ボタンでの週送りは、選択中の曜日位置（selectedDayIndex）を維持する
    // （従来はここも WEEK_SET_START と同じ扱いで常に週頭にリセットされていた）
    case 'WEEK_NAVIGATE_NEXT':
    case 'WEEK_NAVIGATE_PREV':
      return {
        ...state,
        weekStart: action.payload,
        hasAutoExpanded: false,
      };

    // カレンダーからの日付選択・生成中リクエスト復元時の週遷移は、従来どおり週頭（0日目）にリセットする
    case 'WEEK_SET_START':
      return {
        ...state,
        weekStart: action.payload,
        hasAutoExpanded: false,
        selectedDayIndex: 0,
      };

    case 'DAY_SELECT':
      return { ...state, selectedDayIndex: action.payload };

    case 'WEEK_START_DAY_LOADED':
      return {
        ...state,
        weekStartDay: action.payload.weekStartDay,
        weekStart: action.payload.weekStart,
        weekStartDayLoaded: true,
      };

    case 'HOLIDAYS_SET':
      return { ...state, holidays: { ...state.holidays, ...action.payload } };

    case 'DISPLAY_MONTH_SET':
      return { ...state, displayMonth: action.payload };

    case 'CALENDAR_TOGGLE':
      return { ...state, isCalendarExpanded: !state.isCalendarExpanded };

    case 'CALENDAR_MEAL_DATES_SET':
      return { ...state, calendarMealDates: action.payload };

    case 'CALENDAR_MEAL_DATES_MERGE': {
      const merged = new Set(state.calendarMealDates);
      action.payload.forEach((d) => merged.add(d));
      return { ...state, calendarMealDates: merged };
    }

    case 'MEAL_EXPAND':
      return { ...state, expandedMealId: action.payload };

    case 'MEAL_AUTO_EXPANDED':
      return {
        ...state,
        expandedMealId: action.payload.mealId,
        selectedDayIndex: action.payload.dayIndex,
        hasAutoExpanded: true,
      };

    // F1b-05: ユーザーがカレンダーから明示的に日付を選択した際に
    // 「次の食事への自動展開」エフェクトを抑止するためのフラグのみを立てる。
    // MEAL_AUTO_EXPANDED と違い selectedDayIndex/expandedMealId は上書きしない。
    case 'AUTO_EXPAND_SUPPRESS':
      return { ...state, hasAutoExpanded: true };

    case 'DAY_NUTRITION_TOGGLE':
      return { ...state, isDayNutritionExpanded: !state.isDayNutritionExpanded };

    // F1b-04: 呼び出し元が渡した真偽値をそのまま反映する（無条件トグルにしない）
    case 'DAY_NUTRITION_SET':
      return { ...state, isDayNutritionExpanded: action.payload };

    case 'TODAY_TOGGLE':
      return { ...state, isTodayExpanded: !state.isTodayExpanded };

    case 'PLAN_SET':
      return { ...state, currentPlan: action.payload };

    default:
      return state;
  }
}
