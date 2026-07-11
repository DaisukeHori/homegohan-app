// Refactor B Phase B-1: 買い物リスト state 集約 store
import { create } from 'zustand';
import type { ShoppingListItem, ShoppingList } from '@/types/domain';

export type ShoppingRangeType = 'today' | 'tomorrow' | 'dayAfterTomorrow' | 'week' | 'days' | 'currentWeek' | 'custom';

export interface ShoppingRangeSelection {
  type: ShoppingRangeType;
  /** today 選択時の食事タイプ */
  todayMeals: ('breakfast' | 'lunch' | 'dinner')[];
  /** days 選択時の日数 */
  daysCount: number;
  /** custom 選択時の開始日 */
  customStartDate?: string;
  /** custom 選択時の終了日 */
  customEndDate?: string;
}

interface ShoppingListProgress {
  phase: string;
  message: string;
  percentage: number;
}

const defaultShoppingRange: ShoppingRangeSelection = {
  type: 'week',
  todayMeals: ['breakfast', 'lunch', 'dinner'],
  daysCount: 3,
};

interface ShoppingState {
  shoppingList: ShoppingListItem[];
  activeShoppingList: ShoppingList | null;
  isRegeneratingShoppingList: boolean;
  shoppingListProgress: ShoppingListProgress | null;
  shoppingListRequestId: string | null;
  shoppingListTotalServings: number | null;
  shoppingRange: ShoppingRangeSelection;
  shoppingRangeStep: 'range' | 'servings';
}

interface ShoppingActions {
  setShoppingList: (list: ShoppingListItem[]) => void;
  setActiveShoppingList: (list: ShoppingList | null) => void;
  setIsRegeneratingShoppingList: (isRegenerating: boolean) => void;
  setShoppingListProgress: (progress: ShoppingListProgress | null) => void;
  setShoppingListRequestId: (id: string | null) => void;
  setShoppingListTotalServings: (servings: number | null) => void;
  setShoppingRange: (range: ShoppingRangeSelection) => void;
  setShoppingRangeStep: (step: 'range' | 'servings') => void;
  resetShoppingState: () => void;
}

const initialState: ShoppingState = {
  shoppingList: [],
  activeShoppingList: null,
  isRegeneratingShoppingList: false,
  shoppingListProgress: null,
  shoppingListRequestId: null,
  shoppingListTotalServings: null,
  shoppingRange: defaultShoppingRange,
  shoppingRangeStep: 'range',
};

export const useShoppingStore = create<ShoppingState & ShoppingActions>()((set) => ({
  ...initialState,

  setShoppingList: (list) => set({ shoppingList: list }),
  setActiveShoppingList: (list) => set({ activeShoppingList: list }),
  setIsRegeneratingShoppingList: (isRegenerating) =>
    set({ isRegeneratingShoppingList: isRegenerating }),
  setShoppingListProgress: (progress) => set({ shoppingListProgress: progress }),
  setShoppingListRequestId: (id) => set({ shoppingListRequestId: id }),
  setShoppingListTotalServings: (servings) => set({ shoppingListTotalServings: servings }),
  setShoppingRange: (range) => set({ shoppingRange: range }),
  setShoppingRangeStep: (step) => set({ shoppingRangeStep: step }),

  resetShoppingState: () => set(initialState),
}));
