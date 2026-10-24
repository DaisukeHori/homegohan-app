// Phase B-2: recipe useReducer — レシピモーダル内コンテンツ

// -------------------------------------------------------
// State
// -------------------------------------------------------

type AnyRecord = unknown;

export interface RecipeState {
  selectedRecipe: string | null;
  selectedRecipeData: AnyRecord;
  isFavorite: boolean;
  isFavoriteLoading: boolean;
  /** 保存済みのお気に入りの id (DELETE /api/favorites/[id] に使う)。未保存・未取得は null (#2011) */
  favoriteId: string | null;
  aiSuggestions: AnyRecord[];
  aiHint: string;
  isLoadingHint: boolean;
}

// -------------------------------------------------------
// Actions
// -------------------------------------------------------

export type RecipeAction =
  | { type: 'RECIPE_SELECT'; payload: string | null }
  | { type: 'RECIPE_DATA_SET'; payload: AnyRecord }
  | { type: 'FAVORITE_SET'; payload: boolean }
  | { type: 'FAVORITE_LOADING_SET'; payload: boolean }
  | { type: 'FAVORITE_TOGGLE' }
  | { type: 'FAVORITE_ID_SET'; payload: string | null }
  | { type: 'AI_SUGGESTIONS_SET'; payload: AnyRecord[] }
  | { type: 'AI_HINT_SET'; payload: string }
  | { type: 'HINT_LOADING_START' }
  | { type: 'HINT_LOADING_END' }
  | { type: 'RECIPE_RESET' };

// -------------------------------------------------------
// Initial State
// -------------------------------------------------------

export const initialRecipeState: RecipeState = {
  selectedRecipe: null,
  selectedRecipeData: null,
  isFavorite: false,
  isFavoriteLoading: false,
  favoriteId: null,
  aiSuggestions: [],
  aiHint: '',
  isLoadingHint: false,
};

// -------------------------------------------------------
// Reducer
// -------------------------------------------------------

export function recipeReducer(
  state: RecipeState,
  action: RecipeAction,
): RecipeState {
  switch (action.type) {
    // 料理が変わったとき (別の名前・閉じる (null)) だけ ♥ の状態と id を両方とも未取得に戻す。
    // 同じ名前を選び直したとき (買い物リストに足してモーダルが閉じ、selectedRecipe が残ったまま同じ料理を開く) は両方を保つ
    // (どちらの場合も、モーダルが開くたびに page.tsx の status の取得が引き直して入れ直す。取得中は ♥ が disabled。#2011)
    case 'RECIPE_SELECT': {
      const sameRecipe = action.payload !== null && action.payload === state.selectedRecipe;
      return {
        ...state,
        selectedRecipe: action.payload,
        isFavorite: sameRecipe ? state.isFavorite : false,
        favoriteId: sameRecipe ? state.favoriteId : null,
      };
    }

    case 'RECIPE_DATA_SET':
      return { ...state, selectedRecipeData: action.payload };

    case 'FAVORITE_SET':
      return { ...state, isFavorite: action.payload };

    case 'FAVORITE_LOADING_SET':
      return { ...state, isFavoriteLoading: action.payload };

    case 'FAVORITE_TOGGLE':
      return { ...state, isFavorite: !state.isFavorite };

    case 'FAVORITE_ID_SET':
      return { ...state, favoriteId: action.payload };

    case 'AI_SUGGESTIONS_SET':
      return { ...state, aiSuggestions: action.payload };

    case 'AI_HINT_SET':
      return { ...state, aiHint: action.payload };

    case 'HINT_LOADING_START':
      return { ...state, isLoadingHint: true };

    case 'HINT_LOADING_END':
      return { ...state, isLoadingHint: false };

    case 'RECIPE_RESET':
      return { ...initialRecipeState };

    default:
      return state;
  }
}
