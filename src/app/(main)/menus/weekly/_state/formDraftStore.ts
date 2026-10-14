// Refactor B Phase B-1: モーダル内編集 state 集約 store
import { create } from 'zustand';
import type { MealMode, MealType } from '@/types/domain';
import type { CatalogProductSummary } from '@/types/catalog';
import type { LegacyDishDetail } from './types';

interface FormDraftState {
  // 食事名・モード
  editMealName: string;
  editMealMode: MealMode;

  // 手動入力
  // #1031: page.tsx の manualDishes は旧形式(cal/protein等の短縮キー)との
  // 後方互換のため LegacyDishDetail[] を使う。DishDetail[] に狭めると
  // saveManualEdit 等の d.cal 参照が型エラーになる。
  manualDishes: LegacyDishDetail[];
  manualMode: MealMode;

  // カタログ検索
  catalogQuery: string;
  catalogResults: CatalogProductSummary[];
  selectedCatalogProduct: CatalogProductSummary | null;
  isCatalogSearching: boolean;
  catalogSearchError: string;

  // 冷蔵庫追加フォーム
  newFridgeName: string;
  newFridgeAmount: string;
  newFridgeExpiry: string;
  // UX2-18: 編集対象アイテムID（null なら新規追加、非 null なら編集モード）
  editingFridgeItemId: string | null;

  // 買い物リスト追加フォーム
  newShoppingName: string;
  newShoppingAmount: string;
  newShoppingCategory: string;

  // AI チャット
  aiChatInput: string;

  // 条件選択
  selectedConditions: string[];

  // 食事追加
  addMealKey: MealType | null;
  addMealDayIndex: number;

  // 画像生成
  imageGenerationPrompt: string;
  imageReferenceFiles: File[];
  imageReferencePreviews: string[];

  // 写真編集
  photoFiles: File[];
  photoPreviews: string[];
}

interface FormDraftActions {
  setEditMealName: (name: string) => void;
  setEditMealMode: (mode: MealMode) => void;
  setManualDishes: (dishes: LegacyDishDetail[]) => void;
  setManualMode: (mode: MealMode) => void;
  setCatalogQuery: (query: string) => void;
  setCatalogResults: (results: CatalogProductSummary[]) => void;
  setSelectedCatalogProduct: (product: CatalogProductSummary | null) => void;
  setIsCatalogSearching: (isSearching: boolean) => void;
  setCatalogSearchError: (error: string) => void;
  setNewFridgeName: (name: string) => void;
  setNewFridgeAmount: (amount: string) => void;
  setNewFridgeExpiry: (expiry: string) => void;
  setEditingFridgeItemId: (id: string | null) => void;
  setNewShoppingName: (name: string) => void;
  setNewShoppingAmount: (amount: string) => void;
  setNewShoppingCategory: (category: string) => void;
  setAiChatInput: (input: string) => void;
  setSelectedConditions: (conditions: string[]) => void;
  setAddMealKey: (key: MealType | null) => void;
  setAddMealDayIndex: (index: number) => void;
  setImageGenerationPrompt: (prompt: string) => void;
  setImageReferenceFiles: (files: File[]) => void;
  setImageReferencePreviews: (previews: string[]) => void;
  setPhotoFiles: (files: File[]) => void;
  setPhotoPreviews: (previews: string[]) => void;

  resetEditMeal: () => void;
  resetManual: () => void;
  resetFridgeForm: () => void;
  resetShoppingForm: () => void;
  resetPhotoEdit: () => void;
  resetImageGenerate: () => void;
  resetAddMeal: () => void;
}

const initialState: FormDraftState = {
  editMealName: '',
  editMealMode: 'cook',
  manualDishes: [],
  manualMode: 'cook',
  catalogQuery: '',
  catalogResults: [],
  selectedCatalogProduct: null,
  isCatalogSearching: false,
  catalogSearchError: '',
  newFridgeName: '',
  newFridgeAmount: '',
  newFridgeExpiry: '',
  editingFridgeItemId: null,
  newShoppingName: '',
  newShoppingAmount: '',
  // #1031 round-2: 旧 page.tsx local useState の既定値 "食材" と一致させる。
  // AddShoppingModal の <select> に空文字値の <option> は無く (catch-all は
  // value="食材" のため)、'' のままだとフルリロード直後にカテゴリ未選択で
  // 追加した場合に API へ category: "" が送られる退行が発生する。
  newShoppingCategory: '食材',
  aiChatInput: '',
  selectedConditions: [],
  addMealKey: null,
  addMealDayIndex: 0,
  imageGenerationPrompt: '',
  imageReferenceFiles: [],
  imageReferencePreviews: [],
  photoFiles: [],
  photoPreviews: [],
};

export const useFormDraftStore = create<FormDraftState & FormDraftActions>()((set) => ({
  ...initialState,

  setEditMealName: (name) => set({ editMealName: name }),
  setEditMealMode: (mode) => set({ editMealMode: mode }),
  setManualDishes: (dishes) => set({ manualDishes: dishes }),
  setManualMode: (mode) => set({ manualMode: mode }),
  setCatalogQuery: (query) => set({ catalogQuery: query }),
  setCatalogResults: (results) => set({ catalogResults: results }),
  setSelectedCatalogProduct: (product) => set({ selectedCatalogProduct: product }),
  setIsCatalogSearching: (isSearching) => set({ isCatalogSearching: isSearching }),
  setCatalogSearchError: (error) => set({ catalogSearchError: error }),
  setNewFridgeName: (name) => set({ newFridgeName: name }),
  setNewFridgeAmount: (amount) => set({ newFridgeAmount: amount }),
  setNewFridgeExpiry: (expiry) => set({ newFridgeExpiry: expiry }),
  setEditingFridgeItemId: (id) => set({ editingFridgeItemId: id }),
  setNewShoppingName: (name) => set({ newShoppingName: name }),
  setNewShoppingAmount: (amount) => set({ newShoppingAmount: amount }),
  setNewShoppingCategory: (category) => set({ newShoppingCategory: category }),
  setAiChatInput: (input) => set({ aiChatInput: input }),
  setSelectedConditions: (conditions) => set({ selectedConditions: conditions }),
  setAddMealKey: (key) => set({ addMealKey: key }),
  setAddMealDayIndex: (index) => set({ addMealDayIndex: index }),
  setImageGenerationPrompt: (prompt) => set({ imageGenerationPrompt: prompt }),
  setImageReferenceFiles: (files) => set({ imageReferenceFiles: files }),
  setImageReferencePreviews: (previews) => set({ imageReferencePreviews: previews }),
  setPhotoFiles: (files) => set({ photoFiles: files }),
  setPhotoPreviews: (previews) => set({ photoPreviews: previews }),

  resetEditMeal: () =>
    set({
      editMealName: initialState.editMealName,
      editMealMode: initialState.editMealMode,
    }),

  resetManual: () =>
    set({
      manualDishes: initialState.manualDishes,
      manualMode: initialState.manualMode,
      catalogQuery: initialState.catalogQuery,
      catalogResults: initialState.catalogResults,
      selectedCatalogProduct: initialState.selectedCatalogProduct,
      isCatalogSearching: initialState.isCatalogSearching,
      catalogSearchError: initialState.catalogSearchError,
    }),

  resetFridgeForm: () =>
    set({
      newFridgeName: initialState.newFridgeName,
      newFridgeAmount: initialState.newFridgeAmount,
      newFridgeExpiry: initialState.newFridgeExpiry,
      editingFridgeItemId: initialState.editingFridgeItemId,
    }),

  resetShoppingForm: () =>
    set({
      newShoppingName: initialState.newShoppingName,
      newShoppingAmount: initialState.newShoppingAmount,
      newShoppingCategory: initialState.newShoppingCategory,
    }),

  resetPhotoEdit: () =>
    set({
      photoFiles: initialState.photoFiles,
      photoPreviews: initialState.photoPreviews,
    }),

  resetImageGenerate: () =>
    set({
      imageGenerationPrompt: initialState.imageGenerationPrompt,
      imageReferenceFiles: initialState.imageReferenceFiles,
      imageReferencePreviews: initialState.imageReferencePreviews,
    }),

  resetAddMeal: () =>
    set({
      addMealKey: initialState.addMealKey,
      addMealDayIndex: initialState.addMealDayIndex,
    }),
}));
