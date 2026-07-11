// Phase B-2: uiFlag useReducer — 独立した UI フラグ

// -------------------------------------------------------
// State
// -------------------------------------------------------

// UX2-01: successMessage は元々「成功」専用の名前だったが、エラー通知にも
// 流用されており（title: 'エラー' でも緑チェックの成功見た目のまま表示されていた）、
// 呼び出し元の意図と見た目が矛盾していた。type を追加して見た目を意図と一致させる。
// type 省略時は 'success'（既存呼び出し元との後方互換）。
export type UiFlagMessageType = 'success' | 'error' | 'info';

export interface UiFlagMessage {
  title: string;
  message: string;
  refreshOnDismiss?: boolean;
  type?: UiFlagMessageType;
}

export interface UiFlagState {
  loading: boolean;
  successMessage: UiFlagMessage | null;
  shouldRestoreSubscription: boolean;
}

// -------------------------------------------------------
// Actions
// -------------------------------------------------------

export type UiFlagAction =
  | { type: 'LOADING_SET'; payload: boolean }
  | { type: 'SUCCESS_SHOW'; payload: UiFlagMessage }
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
