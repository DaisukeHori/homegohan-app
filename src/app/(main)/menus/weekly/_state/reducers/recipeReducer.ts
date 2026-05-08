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
    case 'RECIPE_SELECT':
      return {
        ...state,
        selectedRecipe: action.payload,
        // レシピが変わったらお気に入り状態をリセット
        isFavorite: action.payload === null ? false : state.isFavorite,
      };

    case 'RECIPE_DATA_SET':
      return { ...state, selectedRecipeData: action.payload };

    case 'FAVORITE_SET':
      return { ...state, isFavorite: action.payload };

    case 'FAVORITE_LOADING_SET':
      return { ...state, isFavoriteLoading: action.payload };

    case 'FAVORITE_TOGGLE':
      return { ...state, isFavorite: !state.isFavorite };

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
