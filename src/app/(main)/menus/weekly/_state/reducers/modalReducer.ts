// Phase B-2: modal useReducer — 全モーダルの開閉 + 編集対象 meal
import type { PlannedMeal, MealType } from '@/types/domain';

// -------------------------------------------------------
// Types re-exported for consumers
// -------------------------------------------------------

export type ModalType =
  | 'ai'
  | 'aiPreview'
  | 'aiMeal'
  | 'fridge'
  | 'shopping'
  | 'stats'
  | 'recipe'
  | 'add'
  | 'addFridge'
  | 'addShopping'
  | 'editMeal'
  | 'regenerateMeal'
  | 'manualEdit'
  | 'photoEdit'
  | 'imageGenerate'
  | 'addMealSlot'
  | 'confirmDelete'
  | 'shoppingRange'
  | null;

// -------------------------------------------------------
// State
// -------------------------------------------------------

export interface ModalState {
  activeModal: ModalType;

  // V4 modal
  showV4Modal: boolean;

  // モーダル内の編集対象
  editingMeal: PlannedMeal | null;
  regeneratingMeal: PlannedMeal | null;
  regeneratingMealId: string | null;
  manualEditMeal: PlannedMeal | null;
  deletingMeal: PlannedMeal | null;
  photoEditMeal: PlannedMeal | null;
  // 写真から入力のモーダルを開いた回の番号 (開くたびに 1 増える。#2047)。解析の結果を待つあいだ (最大 2 分) に
  // 利用者が閉じて開き直したモーダルを、待ち始めたときのモーダルと見分ける (同じ献立を開き直しても別の回になる)
  photoEditSession: number;
  imageGenerateMeal: PlannedMeal | null;

  // 改善対象
  improveMealTargets: MealType[];

  // boolean open/close flags (独立モーダル)
  showWeeklySummaryModal: boolean;
  showServingsModal: boolean;
  showImproveMealModal: boolean;
  showNutritionDetailModal: boolean;
  // #1053: 買い物リスト全削除の確認（window.confirm 廃止、styled モーダルに統一）
  showConfirmDeleteAllShopping: boolean;
  // UX2-11: AI生成の中止確認（window.confirm 未使用のまま統一）
  showConfirmCancelGeneration: boolean;

  // 削除中フラグ
  isDeleting: boolean;
}

// -------------------------------------------------------
// Actions
// -------------------------------------------------------

export type ModalAction =
  | { type: 'MODAL_OPEN'; payload: ModalType }
  | { type: 'MODAL_CLOSE' }
  | { type: 'V4_MODAL_OPEN' }
  | { type: 'V4_MODAL_CLOSE' }
  | { type: 'MODAL_SET_EDITING_MEAL'; payload: PlannedMeal | null }
  | { type: 'MODAL_SET_REGENERATING_MEAL'; payload: PlannedMeal | null }
  | { type: 'MODAL_SET_REGENERATING_MEAL_ID'; payload: string | null }
  | { type: 'MODAL_SET_MANUAL_EDIT_MEAL'; payload: PlannedMeal | null }
  | { type: 'MODAL_SET_DELETING_MEAL'; payload: PlannedMeal | null }
  | { type: 'MODAL_SET_PHOTO_EDIT_MEAL'; payload: PlannedMeal | null }
  // 写真から入力のモーダルを、その献立で新しい回として開く (photoEditSession を 1 増やす。#2047)
  | { type: 'MODAL_OPEN_PHOTO_EDIT'; payload: PlannedMeal }
  // 写真の解析の結果を待ち終えたとき (#2047): 写真から入力のモーダルが、まだ解析を頼んだ回 (payload = photoEditSession) のものなら閉じる。
  // 待っているあいだに利用者が閉じた・別の献立や同じ献立のモーダルを開き直した・ほかのモーダルを開いたなら、それは閉じない
  // (その時点の状態で判定する)
  | { type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION'; payload: number }
  | { type: 'MODAL_SET_IMAGE_GENERATE_MEAL'; payload: PlannedMeal | null }
  | { type: 'IMPROVE_TARGETS_SET'; payload: MealType[] }
  | { type: 'WEEKLY_SUMMARY_MODAL_OPEN' }
  | { type: 'WEEKLY_SUMMARY_MODAL_CLOSE' }
  | { type: 'SERVINGS_MODAL_OPEN' }
  | { type: 'SERVINGS_MODAL_CLOSE' }
  | { type: 'IMPROVE_MEAL_MODAL_OPEN' }
  | { type: 'IMPROVE_MEAL_MODAL_CLOSE' }
  | { type: 'NUTRITION_DETAIL_MODAL_OPEN' }
  | { type: 'NUTRITION_DETAIL_MODAL_CLOSE' }
  | { type: 'CONFIRM_DELETE_ALL_SHOPPING_OPEN' }
  | { type: 'CONFIRM_DELETE_ALL_SHOPPING_CLOSE' }
  | { type: 'CONFIRM_CANCEL_GENERATION_OPEN' }
  | { type: 'CONFIRM_CANCEL_GENERATION_CLOSE' }
  | { type: 'IS_DELETING_SET'; payload: boolean };

// -------------------------------------------------------
// Initial State
// -------------------------------------------------------

export const initialModalState: ModalState = {
  activeModal: null,
  showV4Modal: false,
  editingMeal: null,
  regeneratingMeal: null,
  regeneratingMealId: null,
  manualEditMeal: null,
  deletingMeal: null,
  photoEditMeal: null,
  photoEditSession: 0,
  imageGenerateMeal: null,
  improveMealTargets: [],
  showWeeklySummaryModal: false,
  showServingsModal: false,
  showImproveMealModal: false,
  showNutritionDetailModal: false,
  showConfirmDeleteAllShopping: false,
  showConfirmCancelGeneration: false,
  isDeleting: false,
};

// -------------------------------------------------------
// Reducer
// -------------------------------------------------------

export function modalReducer(
  state: ModalState,
  action: ModalAction,
): ModalState {
  switch (action.type) {
    case 'MODAL_OPEN':
      return { ...state, activeModal: action.payload };

    case 'MODAL_CLOSE':
      return { ...state, activeModal: null };

    case 'V4_MODAL_OPEN':
      return { ...state, showV4Modal: true };

    case 'V4_MODAL_CLOSE':
      return { ...state, showV4Modal: false };

    case 'MODAL_SET_EDITING_MEAL':
      return { ...state, editingMeal: action.payload };

    case 'MODAL_SET_REGENERATING_MEAL':
      return { ...state, regeneratingMeal: action.payload };

    case 'MODAL_SET_REGENERATING_MEAL_ID':
      return { ...state, regeneratingMealId: action.payload };

    case 'MODAL_SET_MANUAL_EDIT_MEAL':
      return { ...state, manualEditMeal: action.payload };

    case 'MODAL_SET_DELETING_MEAL':
      return { ...state, deletingMeal: action.payload };

    case 'MODAL_SET_PHOTO_EDIT_MEAL':
      return { ...state, photoEditMeal: action.payload };

    case 'MODAL_OPEN_PHOTO_EDIT':
      return {
        ...state,
        activeModal: 'photoEdit',
        photoEditMeal: action.payload,
        photoEditSession: state.photoEditSession + 1,
      };

    case 'MODAL_CLOSE_PHOTO_EDIT_SESSION':
      if (state.activeModal !== 'photoEdit' || state.photoEditSession !== action.payload) return state;
      return { ...state, activeModal: null, photoEditMeal: null };

    case 'MODAL_SET_IMAGE_GENERATE_MEAL':
      return { ...state, imageGenerateMeal: action.payload };

    case 'IMPROVE_TARGETS_SET':
      return { ...state, improveMealTargets: action.payload };

    case 'WEEKLY_SUMMARY_MODAL_OPEN':
      return { ...state, showWeeklySummaryModal: true };

    case 'WEEKLY_SUMMARY_MODAL_CLOSE':
      return { ...state, showWeeklySummaryModal: false };

    case 'SERVINGS_MODAL_OPEN':
      return { ...state, showServingsModal: true };

    case 'SERVINGS_MODAL_CLOSE':
      return { ...state, showServingsModal: false };

    case 'IMPROVE_MEAL_MODAL_OPEN':
      return { ...state, showImproveMealModal: true };

    case 'IMPROVE_MEAL_MODAL_CLOSE':
      return { ...state, showImproveMealModal: false };

    case 'NUTRITION_DETAIL_MODAL_OPEN':
      return { ...state, showNutritionDetailModal: true };

    case 'NUTRITION_DETAIL_MODAL_CLOSE':
      return { ...state, showNutritionDetailModal: false };

    case 'CONFIRM_DELETE_ALL_SHOPPING_OPEN':
      return { ...state, showConfirmDeleteAllShopping: true };

    case 'CONFIRM_DELETE_ALL_SHOPPING_CLOSE':
      return { ...state, showConfirmDeleteAllShopping: false };

    case 'CONFIRM_CANCEL_GENERATION_OPEN':
      return { ...state, showConfirmCancelGeneration: true };

    case 'CONFIRM_CANCEL_GENERATION_CLOSE':
      return { ...state, showConfirmCancelGeneration: false };

    case 'IS_DELETING_SET':
      return { ...state, isDeleting: action.payload };

    default:
      return state;
  }
}
