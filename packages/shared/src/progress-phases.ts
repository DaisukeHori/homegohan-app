/**
 * 献立生成進捗フェーズ定数
 *
 * PROGRESS_PHASES: 通常モード 12 フェーズ
 * ULTIMATE_PROGRESS_PHASES: 究極モード 15 フェーズ
 * SHOPPING_LIST_PHASES: 買い物リスト再生成 8 フェーズ
 */

export interface PhaseDefinition {
  phase: string;
  label: string;
  threshold: number;
}

export const PROGRESS_PHASES: PhaseDefinition[] = [
  { phase: 'user_context', label: 'ユーザー情報を取得', threshold: 5 },
  { phase: 'search_references', label: '参考レシピを検索', threshold: 10 },
  { phase: 'generating', label: '献立をAIが作成', threshold: 15 },
  { phase: 'step1_complete', label: '献立生成完了', threshold: 40 },
  { phase: 'reviewing', label: '献立のバランスをチェック', threshold: 45 },
  { phase: 'review_done', label: '改善点を発見', threshold: 55 },
  { phase: 'fixing', label: '改善点を修正', threshold: 60 },
  { phase: 'no_issues', label: '問題なし', threshold: 70 },
  { phase: 'step2_complete', label: 'レビュー完了', threshold: 75 },
  { phase: 'calculating', label: '栄養価を計算', threshold: 80 },
  { phase: 'saving', label: '献立を保存', threshold: 88 },
  { phase: 'completed', label: '完了！', threshold: 100 },
];

export const ULTIMATE_PROGRESS_PHASES: PhaseDefinition[] = [
  { phase: 'user_context', label: 'ユーザー情報を取得', threshold: 3 },
  { phase: 'search_references', label: '参考レシピを検索', threshold: 6 },
  { phase: 'generating', label: '献立をAIが作成', threshold: 10 },
  { phase: 'step1_complete', label: '献立生成完了', threshold: 25 },
  { phase: 'reviewing', label: '献立のバランスをチェック', threshold: 28 },
  { phase: 'fixing', label: '改善点を修正', threshold: 32 },
  { phase: 'step2_complete', label: 'レビュー完了', threshold: 38 },
  { phase: 'calculating', label: '栄養価を計算', threshold: 42 },
  { phase: 'step3_complete', label: '栄養計算完了', threshold: 48 },
  { phase: 'nutrition_analyzing', label: '栄養バランスを詳細分析', threshold: 55 },
  { phase: 'nutrition_feedback', label: '改善アドバイスを生成', threshold: 62 },
  { phase: 'improving', label: '献立を改善中', threshold: 70 },
  { phase: 'step5_complete', label: '改善完了', threshold: 82 },
  { phase: 'final_saving', label: '最終保存中', threshold: 90 },
  { phase: 'completed', label: '究極の献立が完成！', threshold: 100 },
];

export const SHOPPING_LIST_PHASES: PhaseDefinition[] = [
  { phase: 'starting', label: '開始中...', threshold: 0 },
  { phase: 'extracting', label: '献立から材料を抽出', threshold: 10 },
  { phase: 'normalizing', label: 'AIが材料を整理中', threshold: 30 },
  { phase: 'validating', label: '整合性チェック', threshold: 60 },
  { phase: 'categorizing', label: 'カテゴリ分類', threshold: 70 },
  { phase: 'saving', label: '保存中', threshold: 85 },
  { phase: 'completed', label: '完了！', threshold: 100 },
  { phase: 'failed', label: 'エラーが発生しました', threshold: 0 },
];
