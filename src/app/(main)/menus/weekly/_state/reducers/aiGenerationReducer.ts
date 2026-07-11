// Phase B-2: aiGeneration useReducer — AI 生成進行状況
import type { MealType } from '@/types/domain';

// -------------------------------------------------------
// State
// -------------------------------------------------------

export interface GenerationProgress {
  phase: string;
  message: string;
  percentage: number;
  totalSlots?: number;
  completedSlots?: number;
  isUltimateMode?: boolean;
}

export interface AiGenerationState {
  isGenerating: boolean;
  generatingMeal: { dayIndex: number; mealType: MealType } | null;
  generationProgress: GenerationProgress | null;
  generationFailedError: string | null;
  generationFailedRequestId: string | null;
  isRegenerating: boolean;
  isImprovingMeal: boolean;
  improveNextDay: boolean;
  isAnalyzingPhoto: boolean;
  isGeneratingMealImage: boolean;
}

// -------------------------------------------------------
// Actions
// -------------------------------------------------------

export type AiGenerationAction =
  | { type: 'GEN_START'; payload?: { meal?: { dayIndex: number; mealType: MealType } } }
  | { type: 'GEN_PROGRESS'; payload: GenerationProgress }
  | { type: 'GEN_PROGRESS_CLEAR' }
  | { type: 'GEN_SUCCESS' }
  | { type: 'GEN_FAIL'; payload: { error: string | null; requestId: string | null } }
  | { type: 'GEN_FAILED_CLEAR' }
  | { type: 'GENERATING_MEAL_SET'; payload: { dayIndex: number; mealType: MealType } | null }
  | { type: 'REGEN_START'; payload?: { meal?: unknown } }
  | { type: 'REGEN_END' }
  | { type: 'IMPROVE_MEAL_START'; payload?: { nextDay?: boolean } }
  | { type: 'IMPROVE_MEAL_END' }
  | { type: 'IMPROVE_NEXT_DAY_SET'; payload: boolean }
  | { type: 'PHOTO_ANALYZE_START' }
  | { type: 'PHOTO_ANALYZE_END' }
  | { type: 'IMAGE_GEN_START' }
  | { type: 'IMAGE_GEN_END' };

// -------------------------------------------------------
// Initial State
// -------------------------------------------------------

export const initialAiGenerationState: AiGenerationState = {
  isGenerating: false,
  generatingMeal: null,
  generationProgress: null,
  generationFailedError: null,
  generationFailedRequestId: null,
  isRegenerating: false,
  isImprovingMeal: false,
  improveNextDay: false,
  isAnalyzingPhoto: false,
  isGeneratingMealImage: false,
};

// -------------------------------------------------------
// Reducer
// -------------------------------------------------------

export function aiGenerationReducer(
  state: AiGenerationState,
  action: AiGenerationAction,
): AiGenerationState {
  switch (action.type) {
    case 'GEN_START':
      return {
        ...state,
        isGenerating: true,
        generatingMeal: action.payload?.meal ?? state.generatingMeal,
      };

    case 'GEN_PROGRESS':
      return { ...state, generationProgress: action.payload };

    // F1b-03: 進捗クリア専用。GEN_SUCCESS と違い isGenerating/generatingMeal には触れない
    // (呼び出し元は生成中の進捗更新の一環として progress のみ null にしたい場合がある)
    case 'GEN_PROGRESS_CLEAR':
      return { ...state, generationProgress: null };

    case 'GEN_SUCCESS':
      return {
        ...state,
        isGenerating: false,
        generationProgress: null,
        generatingMeal: null,
      };

    case 'GEN_FAIL':
      return {
        ...state,
        isGenerating: false,
        generationProgress: null,
        generationFailedError: action.payload.error,
        generationFailedRequestId: action.payload.requestId,
      };

    case 'GEN_FAILED_CLEAR':
      return {
        ...state,
        generationFailedError: null,
        generationFailedRequestId: null,
      };

    case 'GENERATING_MEAL_SET':
      return { ...state, generatingMeal: action.payload };

    case 'REGEN_START':
      return { ...state, isRegenerating: true };

    case 'REGEN_END':
      return { ...state, isRegenerating: false };

    case 'IMPROVE_MEAL_START':
      return {
        ...state,
        isImprovingMeal: true,
        improveNextDay: action.payload?.nextDay ?? state.improveNextDay,
      };

    case 'IMPROVE_MEAL_END':
      return { ...state, isImprovingMeal: false };

    case 'IMPROVE_NEXT_DAY_SET':
      return { ...state, improveNextDay: action.payload };

    case 'PHOTO_ANALYZE_START':
      return { ...state, isAnalyzingPhoto: true };

    case 'PHOTO_ANALYZE_END':
      return { ...state, isAnalyzingPhoto: false };

    case 'IMAGE_GEN_START':
      return { ...state, isGeneratingMealImage: true };

    case 'IMAGE_GEN_END':
      return { ...state, isGeneratingMealImage: false };

    default:
      return state;
  }
}
