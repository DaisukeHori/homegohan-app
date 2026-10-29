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
  // 解析している写真を送った「写真から入力」のモーダルの回 (modalReducer の photoEditSession)。解析していなければ null (#2047)。
  // 解析の結果を待つあいだ (最大 2 分) に利用者が閉じて別の献立や同じ献立のモーダルを開き直したとき、
  // その新しいモーダルに「AIが解析中...」を出さず、待ち終えたときにそのモーダルを閉じないために、回で見分ける
  analyzingPhotoSession: number | null;
  isGeneratingMealImage: boolean;
}

// -------------------------------------------------------
// Actions
// -------------------------------------------------------

export type AiGenerationAction =
  | { type: 'GEN_START'; payload?: { meal?: { dayIndex: number; mealType: MealType } } }
  | { type: 'GEN_PROGRESS'; payload: GenerationProgress }
  | { type: 'GEN_PROGRESS_CLEAR' }
  | { type: 'GEN_PROGRESS_WHILE_GENERATING'; payload: GenerationProgress }
  | { type: 'GEN_RESUME_PENDING'; payload: GenerationProgress }
  | { type: 'GEN_SUCCESS' }
  | { type: 'GEN_FAIL'; payload: { error: string | null; requestId: string | null } }
  | { type: 'GEN_FAILED_CLEAR' }
  | { type: 'GENERATING_MEAL_SET'; payload: { dayIndex: number; mealType: MealType } | null }
  | { type: 'REGEN_START'; payload?: { meal?: unknown } }
  | { type: 'REGEN_END' }
  | { type: 'IMPROVE_MEAL_START'; payload?: { nextDay?: boolean } }
  | { type: 'IMPROVE_MEAL_END' }
  | { type: 'IMPROVE_NEXT_DAY_SET'; payload: boolean }
  | { type: 'PHOTO_ANALYZE_START'; payload: { session: number } }
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
  analyzingPhotoSession: null,
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
        // UX2-10 の単調増加ガード（GEN_PROGRESS の Math.max クランプ）が新しい世代の生成にまで
        // 汚染して波及しないよう、生成開始時に必ず前回の進捗をリセットする（防御的 hardening）。
        generationProgress: null,
      };

    // UX2-10: percentage の単調増加ガード。Realtime/ポーリング/復元経路が非同期に競合すると
    // 古いイベントが後着して進捗が逆行し得るため、同一生成中は前回値を下回らないようにクランプする。
    case 'GEN_PROGRESS': {
      const prevPercentage = state.generationProgress?.percentage ?? 0;
      return {
        ...state,
        generationProgress: {
          ...action.payload,
          percentage: Math.max(action.payload.percentage, prevPercentage),
        },
      };
    }

    // F1b-03: 進捗クリア専用。GEN_SUCCESS と違い isGenerating/generatingMeal には触れない
    // (呼び出し元は生成中の進捗更新の一環として progress のみ null にしたい場合がある)
    case 'GEN_PROGRESS_CLEAR':
      return { ...state, generationProgress: null };

    // #1663: ポーリング (V4 の生成・献立の改善) が DB から読んだ進捗を置く action。
    // 生成中 (isGenerating) のときだけ GEN_PROGRESS と同じに置く (割合は Math.max で戻らない。Realtime も GEN_PROGRESS なので、
    // Realtime が届くときはそちらが先に進み、遅れて着いたポーリングの応答で割合が戻らない)。
    // 生成中でないとき (完了・失敗・中止で GEN_SUCCESS / GEN_FAIL / setIsGenerating(false) が先に着いた) は何も変えない
    // (同じ state をそのまま返す)。判定は reducer の中で今の状態に対して行う (ポーリングの closure は前の描画の isGenerating を握っているため)。
    // 別の生成が始まったあと (isGenerating はまた true) に着いた前の生成の応答は、呼び出し側の監視の印 (#1657) で止める。
    // 以前 (#1644) はポーリングが「今の進捗が null のときだけ置く」action (GEN_PROGRESS_IF_EMPTY) を使い、生成の開始で
    // 初期の進捗 (3% / 5%) を置いたあとは一度も DB の進捗を置かず、Realtime がつながらない間は完了まで初期の進捗のまま止まって見えた
    // (その action は、要る経路が無くなったので外した)。
    case 'GEN_PROGRESS_WHILE_GENERATING':
      if (!state.isGenerating) return state;
      return aiGenerationReducer(state, { type: 'GEN_PROGRESS', payload: action.payload });

    // #1629: 画面に入り直して生成中の行 (GET /api/ai/menu/weekly/pending) を見つけたときの復元。
    // 生成中にし、進捗はまだ無い (null) ときだけ payload (pendingRestoreProgress の空の進捗) を置く。
    // すでに生成中で進捗があるとき (生成中のリロードで restoreGeneration が DB の進捗を先に置いた・
    // キャッシュが切れたあとに同じ週へ戻った) は、その進捗 (phase・message・totalSlots) を残す。
    // GEN_START と違って進捗を null に戻さない。判定は reducer の中で今の状態に対して行う
    // (呼び出し側の非同期の処理 (fetchPlan など) は前の描画の値を握っているので、そちらで見分けると古い値で上書きする)。
    // 生成中でないときは GEN_START と同じく前回の進捗を残さない (別の生成の進捗を引き継がない)。
    case 'GEN_RESUME_PENDING':
      return {
        ...state,
        isGenerating: true,
        generationProgress:
          state.isGenerating && state.generationProgress !== null ? state.generationProgress : action.payload,
      };

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
      return { ...state, isAnalyzingPhoto: true, analyzingPhotoSession: action.payload.session };

    case 'PHOTO_ANALYZE_END':
      return { ...state, isAnalyzingPhoto: false, analyzingPhotoSession: null };

    case 'IMAGE_GEN_START':
      return { ...state, isGeneratingMealImage: true };

    case 'IMAGE_GEN_END':
      return { ...state, isGeneratingMealImage: false };

    default:
      return state;
  }
}

// -------------------------------------------------------
// Selectors
// -------------------------------------------------------

/**
 * 写真から入力のモーダル (回 = session) から見た、写真の解析の状態 (#2047)。
 * - 'idle': 解析していない
 * - 'own': このモーダルで送った写真を解析している (結果を待っているあいだも含む)。「AIが解析中...」を出し、送った写真を変えられない
 * - 'other': 前のモーダル (閉じた別の献立のもの・同じ献立で開き直す前のもの) で送った写真を解析している。
 *   写真は選べるが、解析は一度に 1 つなので、解析のボタンは待ち終えるまで押せない
 */
export type PhotoAnalyzeStateForSession = 'idle' | 'own' | 'other';

export function photoAnalyzeStateForSession(
  state: Pick<AiGenerationState, 'isAnalyzingPhoto' | 'analyzingPhotoSession'>,
  session: number,
): PhotoAnalyzeStateForSession {
  if (!state.isAnalyzingPhoto) return 'idle';
  return state.analyzingPhotoSession === session ? 'own' : 'other';
}
