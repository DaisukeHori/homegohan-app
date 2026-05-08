// Phase B-2: nutrition useReducer — 栄養グラフ + フィードバック
import { DEFAULT_RADAR_NUTRIENTS } from '@homegohan/shared';

// -------------------------------------------------------
// State
// -------------------------------------------------------

export interface NutritionState {
  radarChartNutrients: string[];
  nutritionFeedback: string | null;
  praiseComment: string | null;
  nutritionTip: string | null;
  isLoadingFeedback: boolean;
  isEditingRadarNutrients: boolean;
  tempRadarNutrients: string[];
  isSavingRadarNutrients: boolean;
  lastFeedbackDate: string | null;
  feedbackCacheId: string | null;
  weeklySummaryTab: 'today' | 'week';
  weeklyNutritionFeedback: string | null;
  isLoadingWeeklyFeedback: boolean;
}

// -------------------------------------------------------
// Actions
// -------------------------------------------------------

export type NutritionAction =
  | { type: 'RADAR_NUTRIENTS_SET'; payload: string[] }
  | { type: 'NUTRITION_FEEDBACK_SET'; payload: string | null }
  | { type: 'PRAISE_COMMENT_SET'; payload: string | null }
  | { type: 'NUTRITION_TIP_SET'; payload: string | null }
  | { type: 'FEEDBACK_LOADING_START' }
  | { type: 'FEEDBACK_LOADING_END' }
  | { type: 'RADAR_EDIT_START' }
  | { type: 'RADAR_EDIT_CANCEL' }
  | { type: 'TEMP_RADAR_NUTRIENTS_SET'; payload: string[] }
  | { type: 'RADAR_SAVING_START' }
  | { type: 'RADAR_SAVING_END'; payload: string[] }
  | { type: 'RADAR_SAVING_CANCEL' }
  | { type: 'LAST_FEEDBACK_DATE_SET'; payload: string | null }
  | { type: 'FEEDBACK_CACHE_ID_SET'; payload: string | null }
  | { type: 'WEEKLY_SUMMARY_TAB_SET'; payload: 'today' | 'week' }
  | { type: 'WEEKLY_NUTRITION_FEEDBACK_SET'; payload: string | null }
  | { type: 'WEEKLY_FEEDBACK_LOADING_START' }
  | { type: 'WEEKLY_FEEDBACK_LOADING_END' };

// -------------------------------------------------------
// Initial State
// -------------------------------------------------------

export const initialNutritionState: NutritionState = {
  radarChartNutrients: DEFAULT_RADAR_NUTRIENTS,
  nutritionFeedback: null,
  praiseComment: null,
  nutritionTip: null,
  isLoadingFeedback: false,
  isEditingRadarNutrients: false,
  tempRadarNutrients: [],
  isSavingRadarNutrients: false,
  lastFeedbackDate: null,
  feedbackCacheId: null,
  weeklySummaryTab: 'today',
  weeklyNutritionFeedback: null,
  isLoadingWeeklyFeedback: false,
};

// -------------------------------------------------------
// Reducer
// -------------------------------------------------------

export function nutritionReducer(
  state: NutritionState,
  action: NutritionAction,
): NutritionState {
  switch (action.type) {
    case 'RADAR_NUTRIENTS_SET':
      return { ...state, radarChartNutrients: action.payload };

    case 'NUTRITION_FEEDBACK_SET':
      return { ...state, nutritionFeedback: action.payload };

    case 'PRAISE_COMMENT_SET':
      return { ...state, praiseComment: action.payload };

    case 'NUTRITION_TIP_SET':
      return { ...state, nutritionTip: action.payload };

    case 'FEEDBACK_LOADING_START':
      return { ...state, isLoadingFeedback: true };

    case 'FEEDBACK_LOADING_END':
      return { ...state, isLoadingFeedback: false };

    case 'RADAR_EDIT_START':
      return {
        ...state,
        isEditingRadarNutrients: true,
        tempRadarNutrients: [...state.radarChartNutrients],
      };

    case 'RADAR_EDIT_CANCEL':
      return { ...state, isEditingRadarNutrients: false, tempRadarNutrients: [] };

    case 'TEMP_RADAR_NUTRIENTS_SET':
      return { ...state, tempRadarNutrients: action.payload };

    case 'RADAR_SAVING_START':
      return { ...state, isSavingRadarNutrients: true };

    case 'RADAR_SAVING_CANCEL':
      return { ...state, isSavingRadarNutrients: false };

    case 'RADAR_SAVING_END':
      return {
        ...state,
        isSavingRadarNutrients: false,
        isEditingRadarNutrients: false,
        radarChartNutrients: action.payload,
        tempRadarNutrients: [],
      };

    case 'LAST_FEEDBACK_DATE_SET':
      return { ...state, lastFeedbackDate: action.payload };

    case 'FEEDBACK_CACHE_ID_SET':
      return { ...state, feedbackCacheId: action.payload };

    case 'WEEKLY_SUMMARY_TAB_SET':
      return { ...state, weeklySummaryTab: action.payload };

    case 'WEEKLY_NUTRITION_FEEDBACK_SET':
      return { ...state, weeklyNutritionFeedback: action.payload };

    case 'WEEKLY_FEEDBACK_LOADING_START':
      return { ...state, isLoadingWeeklyFeedback: true };

    case 'WEEKLY_FEEDBACK_LOADING_END':
      return { ...state, isLoadingWeeklyFeedback: false };

    default:
      return state;
  }
}
