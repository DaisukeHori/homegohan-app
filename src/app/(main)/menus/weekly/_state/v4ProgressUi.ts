// UX2-10: V4進捗をUI形式に変換するヘルパー関数。
// モジュールスコープの純関数として定義し、生成進捗の変換ロジックをこの1箇所に統一する
// （以前は復元/handleV4Generate/ポーリング等4箇所に類似ロジックが重複し、計算式が不一致だった）。
// 単調増加ガードは呼び出し側の aiGenerationReducer(GEN_PROGRESS) で行う。
//
// #1597: 究極モード (#1142) の段 (6 工程・ULTIMATE_PROGRESS_PHASES) か通常の段 (3 工程・PROGRESS_PHASES) かは、
// 生成の印 (ultimateMode) を引数で受け取って決める。以前は progress.totalSteps === 6 で見分けていたが、
// 行を作ったときの totalSteps は枠の数 (v4 / v5 の route の targetSlots.length) や AI 相談の固定値 (1 / 3 / 21) で、
// Edge Function が最初の進捗で 3 / 6 に書き直すまでの間、枠が 6 の通常の生成を究極モードの段に、
// 枠が 6 でない究極モードの生成を通常の段に取り違えていた。
// 呼び出し側が渡す印は次のどれか (モバイルの #1582 と同じ考え方):
//   - 生成を始めた直後: 生成を始めたときの要求 (V4GenerateModal の究極モードの選択)
//   - 画面に入り直したとき: 生成中の行の確認 (GET /api/ai/menu/weekly/pending) の ultimateMode
//     (サーバーが行の generated_data.ultimateMode を isUltimateModeWeeklyMenuRequest で判定した結果)
//   - 究極モードの無い生成 (1 食の生成・再生成・献立の改善・旧来の週の生成): false
import type { AiGenerationAction, GenerationProgress } from './reducers/aiGenerationReducer';
import { requestProgressForDisplay } from '@/lib/request-progress-display';

/** 生成のリクエストの行 (weekly_menu_requests) の progress。V4 形式 (currentStep / totalSteps) か、UI 形式 (phase / percentage) */
export interface V4GenerationProgress {
  phase?: string;
  message?: string;
  percentage?: number;
  currentStep?: number;
  totalSteps?: number;
  completedSlots?: number;
  totalSlots?: number;
}

export const convertV4ProgressToUIFormat = (
  rawProgress: V4GenerationProgress,
  ultimateMode: boolean,
): GenerationProgress => {
  // DB の既定値の progress (ワーカーがまだ進捗を書いていない行。phase 'pending' で割合が無い) の文は出さず、
  // 置き換えてから変換する (#1911。割合が無いので下のフォールバックに入る)
  const progress = requestProgressForDisplay(rawProgress);
  const completedSlots = progress.completedSlots || 0;
  const totalSlots = progress.totalSlots || 0;

  // 既にUI形式の場合はそのまま返す（totalSlotsを追加）
  if (progress.phase && progress.percentage !== undefined) {
    return {
      phase: progress.phase,
      message: progress.message || '',
      percentage: progress.percentage,
      totalSlots,
      completedSlots,
      isUltimateMode: ultimateMode,
    };
  }

  // V4形式の場合はUI形式に変換
  if (progress.currentStep !== undefined && progress.totalSteps !== undefined) {
    const message = progress.message || 'AIが献立を生成中...';
    const currentStep = progress.currentStep;
    // 究極モードかは、呼び出し側が渡す生成の印 (ultimateMode) で決める (#1597)。totalSteps では見分けない
    const isUltimateMode = ultimateMode;

    let phase = 'generating';
    let percentage = 0;

    if (isUltimateMode) {
      // 究極モード（6ステップ）
      // Step 1 (0-25%): 生成フェーズ
      if (currentStep === 1 || currentStep === 0) {
        if (message.includes('ユーザー情報') || message.includes('取得中')) {
          phase = 'user_context';
          percentage = 3;
        } else if (message.includes('参考') || message.includes('検索中')) {
          phase = 'search_references';
          percentage = 6;
        } else if (message.includes('生成完了')) {
          phase = 'step1_complete';
          percentage = 25;
        } else {
          phase = 'generating';
          percentage = 8 + Math.round((completedSlots / Math.max(totalSlots, 1)) * 15);
        }
      }
      // Step 2 (25-38%): レビューフェーズ
      else if (currentStep === 2) {
        if (message.includes('バランス') || message.includes('チェック中') || message.includes('重複')) {
          phase = 'reviewing';
          percentage = 28;
        } else if (message.includes('改善中')) {
          phase = 'fixing';
          percentage = 32;
        } else if (message.includes('レビュー完了')) {
          phase = 'step2_complete';
          percentage = 38;
        } else {
          phase = 'reviewing';
          percentage = 30;
        }
      }
      // Step 3 (38-48%): 栄養計算フェーズ（究極モードでは保存しない）
      else if (currentStep === 3) {
        if (message.includes('栄養計算') || message.includes('栄養')) {
          phase = 'calculating';
          percentage = 42;
        } else if (message.includes('完了')) {
          phase = 'step3_complete';
          percentage = 48;
        } else {
          phase = 'calculating';
          percentage = 45;
        }
      }
      // Step 4 (48-62%): 栄養バランス詳細分析
      else if (currentStep === 4) {
        phase = 'nutrition_analyzing';
        const match = message.match(/(\d+)\/(\d+)/);
        if (match) {
          const current = parseInt(match[1]);
          const total = parseInt(match[2]);
          percentage = 50 + Math.round((current / Math.max(total, 1)) * 12);
        } else {
          percentage = 55;
        }
      }
      // Step 5 (62-82%): 献立改善
      else if (currentStep === 5) {
        phase = 'improving';
        const match = message.match(/(\d+)\/(\d+)/);
        if (match) {
          const current = parseInt(match[1]);
          const total = parseInt(match[2]);
          percentage = 65 + Math.round((current / Math.max(total, 1)) * 17);
        } else {
          percentage = 70;
        }
      }
      // Step 6 (82-100%): 最終保存
      else if (currentStep === 6) {
        if (message.includes('完了') || message.includes('完成')) {
          phase = 'completed';
          percentage = 100;
        } else {
          phase = 'final_saving';
          const match = message.match(/(\d+)\/(\d+)/);
          if (match) {
            const current = parseInt(match[1]);
            const total = parseInt(match[2]);
            percentage = 85 + Math.round((current / Math.max(total, 1)) * 13);
          } else {
            percentage = 90;
          }
        }
      }
    } else {
      // 通常モード（3ステップ）
      // Step 1 (0-40%): 生成フェーズ
      if (currentStep === 1 || currentStep === 0) {
        if (message.includes('ユーザー情報') || message.includes('取得中')) {
          phase = 'user_context';
          percentage = 5;
        } else if (message.includes('参考') || message.includes('検索中')) {
          phase = 'search_references';
          percentage = 10;
        } else {
          phase = 'generating';
          percentage = 12 + Math.round((completedSlots / Math.max(totalSlots, 1)) * 28);
        }
      }
      // Step 2 (40-75%): レビューフェーズ
      else if (currentStep === 2) {
        if (message.includes('バランス') || message.includes('チェック中') || message.includes('重複')) {
          phase = 'reviewing';
          percentage = 47;
        } else if (message.includes('改善中')) {
          phase = 'fixing';
          const match = message.match(/(\d+)\/(\d+)/);
          if (match) {
            const current = parseInt(match[1]);
            const total = parseInt(match[2]);
            percentage = 58 + Math.round((current / Math.max(total, 1)) * 12);
          } else {
            percentage = 60;
          }
        } else if (message.includes('問題なし')) {
          phase = 'no_issues';
          percentage = 72;
        } else if (message.includes('レビュー完了')) {
          phase = 'step2_complete';
          percentage = 75;
        } else {
          phase = 'reviewing';
          percentage = 50;
        }
      }
      // Step 3 (75-100%): 保存フェーズ
      else if (currentStep === 3) {
        if (message.includes('栄養計算') || message.includes('栄養')) {
          phase = 'calculating';
          percentage = 80;
        } else if (message.includes('保存中')) {
          phase = 'saving';
          const match = message.match(/(\d+)\/(\d+)/);
          if (match) {
            const current = parseInt(match[1]);
            const total = parseInt(match[2]);
            percentage = 88 + Math.round((current / Math.max(total, 1)) * 10);
          } else {
            percentage = 90;
          }
        } else if (message.includes('完了') || message.includes('保存しました')) {
          phase = 'completed';
          percentage = 100;
        } else {
          phase = 'saving';
          percentage = 88;
        }
      }
    }

    return {
      phase,
      message,
      percentage: Math.round(percentage),
      totalSlots,
      completedSlots,
      isUltimateMode,
    };
  }

  // フォールバック
  return {
    phase: 'generating',
    message: progress.message || 'AIが献立を生成中...',
    percentage: 0,
    totalSlots,
    completedSlots,
    isUltimateMode: ultimateMode,
  };
};

/**
 * 画面に入り直して生成中の行を見つけたとき (生成中の行の確認 GET /api/ai/menu/weekly/pending の応答)、
 * 最初の進捗 (ポーリング・Realtime の応答) が届くまでの間に置く空の進捗 (#1609)。
 * 段 (究極 / 通常) を決める印 (ultimateMode) だけを持ち、どの工程もまだ始まっていない (phase は空・message は空・割合は 0)。
 * message が空なので、カード (ProgressTodoCard) は既定の文 (AIが献立を生成中...) を出す。
 * これを置かないと、進捗が null の間 (最初の応答までの数百 ms) は isUltimateMode が読めず、
 * 究極モードの生成でもカードが一瞬だけ通常の段 (PROGRESS_PHASES) で描かれていた。
 */
export const pendingRestoreProgress = (ultimateMode: boolean): GenerationProgress => ({
  phase: '',
  message: '',
  percentage: 0,
  isUltimateMode: ultimateMode,
});

/**
 * 画面に入り直して生成中の行を見つけたときに aiGenerationReducer へ送る action (#1629)。
 * 生成中にし、進捗がまだ無いときだけ空の進捗 (pendingRestoreProgress) を置く。
 * すでに生成中で進捗があるときは上書きしない (reducer の GEN_RESUME_PENDING が今の状態で見分ける)。
 * 週間献立の画面の入り直しの 2 か所 (fetchPlan・checkPendingRequests) はどちらもこれを送る。
 */
export const resumePendingGenerationAction = (ultimateMode: boolean): AiGenerationAction => ({
  type: 'GEN_RESUME_PENDING',
  payload: pendingRestoreProgress(ultimateMode),
});
