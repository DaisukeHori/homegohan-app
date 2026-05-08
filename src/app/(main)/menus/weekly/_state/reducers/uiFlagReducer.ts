// Phase B-2: uiFlag useReducer — 独立した UI フラグ

// -------------------------------------------------------
// State
// -------------------------------------------------------

export interface UiFlagState {
  loading: boolean;
  successMessage: { title: string; message: string; refreshOnDismiss?: boolean } | null;
  shouldRestoreSubscription: boolean;
}

// -------------------------------------------------------
// Actions
// -------------------------------------------------------

export type UiFlagAction =
  | { type: 'LOADING_SET'; payload: boolean }
  | { type: 'SUCCESS_SHOW'; payload: { title: string; message: string; refreshOnDismiss?: boolean } }
  | { type: 'SUCCESS_DISMISS' }
  | { type: 'SUBSCRIPTION_RESTORE_SET'; payload: boolean };

// -------------------------------------------------------
// Initial State
// -------------------------------------------------------

export const initialUiFlagState: UiFlagState = {
  loading: true,
  successMessage: null,
  shouldRestoreSubscription: false,
};

// -------------------------------------------------------
// Reducer
// -------------------------------------------------------

export function uiFlagReducer(
  state: UiFlagState,
  action: UiFlagAction,
): UiFlagState {
  switch (action.type) {
    case 'LOADING_SET':
      return { ...state, loading: action.payload };

    case 'SUCCESS_SHOW':
      return { ...state, successMessage: action.payload };

    case 'SUCCESS_DISMISS':
      return { ...state, successMessage: null };

    case 'SUBSCRIPTION_RESTORE_SET':
      return { ...state, shouldRestoreSubscription: action.payload };

    default:
      return state;
  }
}
