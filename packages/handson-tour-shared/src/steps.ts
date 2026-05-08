// Step / sub-step 定義
// Canonical:
//   docs/design/family/09-onboarding-handson-tour/03-step1-photo.md §3.1 (Step 1 サブステップ)
//   docs/design/family/09-onboarding-handson-tour/04-step2-menu.md §3.1 (Step 2 サブステップ)
//   docs/design/family/09-onboarding-handson-tour/05-step3-badges.md §3.1 (Step 3 サブステップ)
//   docs/design/family/09-onboarding-handson-tour/06-step4-graduation.md §3.1 (Step 4 サブステップ)

// ============================================================
// Step 番号
// ============================================================

export const STEP_NUMBERS = [0, 1, 2, 3, 4] as const;

export type StepNumber = (typeof STEP_NUMBERS)[number];

// ============================================================
// Step 0 サブステップ
// (Step 0 ウェルカム: 単一画面のため sub-step なし)
// ============================================================

export const SUB_STEPS_OF_STEP_0 = ['0.1'] as const;

export type SubStepOfStep0 = (typeof SUB_STEPS_OF_STEP_0)[number];

// ============================================================
// Step 1 サブステップ (§03 §3.1)
// ============================================================

export const SUB_STEPS_OF_STEP_1 = [
  '1.1', // intro 吹き出し (自動 2.5s)
  '1.2', // カメラボタン Spotlight (自動 2.0s)
  '1.3', // analyzing スピナー (自動 1.5s)
  '1.4', // result 画面表示 (自動 0.5s)
  '1.5', // 結果カード Spotlight (手動: 【次へ】)
  '1.6', // 保存ボタン Spotlight (手動: 【保存】)
  '1.7', // 保存中 spinner (API 完了まで)
] as const;

export type SubStepOfStep1 = (typeof SUB_STEPS_OF_STEP_1)[number];

// ============================================================
// Step 2 サブステップ (§04 §3.1)
// ============================================================

export const SUB_STEPS_OF_STEP_2 = [
  '2.1', // intro 吹き出し (自動 2.5s)
  '2.2', // 条件フラグ Spotlight (手動: 【次へ】)
  '2.3', // 自由メモ Spotlight (手動: 【次へ】)
  '2.4', // 生成ボタン Spotlight (手動: 【生成する】)
  '2.5', // ローディング (自動 2.0s)
  '2.6', // 結果カード Spotlight (手動: 【次へ】)
  '2.7', // 追加ボタン Spotlight (手動: 【追加】)
  '2.8', // 追加中 spinner (API 完了まで)
  '2.9', // 成功 → Step 3 へ (即時)
] as const;

export type SubStepOfStep2 = (typeof SUB_STEPS_OF_STEP_2)[number];

// ============================================================
// Step 3 サブステップ (§05 §3.1)
// ============================================================

export const SUB_STEPS_OF_STEP_3 = [
  '3.0', // バッジ取得中 spinner (API 完了まで)
  '3.1', // intro 吹き出し (自動 2.0s)
  '3.2', // first_bite カード Spotlight (手動: 【次へ】)
  '3.3', // planner カード Spotlight (手動: 【次へ】)
  '3.4', // tutorial_complete カード (半透明) Spotlight (手動: 【次へ】)
] as const;

export type SubStepOfStep3 = (typeof SUB_STEPS_OF_STEP_3)[number];

// ============================================================
// Step 4 サブステップ (§06 §3.1)
// ============================================================

export const SUB_STEPS_OF_STEP_4 = [
  '4.0', // バッジ付与中 spinner (API 完了 ~500ms)
  '4.1', // 卒業画面表示 + 🎓 アニメ + 紙吹雪 (自動 5s 後 4.2)
  '4.2', // 【ホームへ】活性化 (手動: タップ)
  '4.3', // /home へ遷移 + welcome toast (toast 4s)
] as const;

export type SubStepOfStep4 = (typeof SUB_STEPS_OF_STEP_4)[number];

// ============================================================
// Union 型
// ============================================================

export type SubStep =
  | SubStepOfStep0
  | SubStepOfStep1
  | SubStepOfStep2
  | SubStepOfStep3
  | SubStepOfStep4;

// ============================================================
// testID マッピング (各ステップの sub-step → spotlight target)
// Canonical: §16 §5.3
// ============================================================

export const STEP1_SUB_STEP_TO_TARGET: Record<
  SubStepOfStep1,
  string | string[] | null
> = {
  '1.1': null,
  '1.2': 'meal-camera-button',
  '1.3': null,
  '1.4': null,
  '1.5': ['meal-result-dish-name', 'meal-result-calories'],
  '1.6': 'meal-save-button',
  '1.7': null,
};

export const STEP2_SUB_STEP_TO_TARGET: Record<
  SubStepOfStep2,
  string | string[] | null
> = {
  '2.1': null,
  '2.2': 'v4-no-cook-toggle',
  '2.3': 'v4-note-textarea',
  '2.4': 'v4-generate-button',
  '2.5': null,
  '2.6': 'v4-result-card',
  '2.7': 'v4-add-to-menu-button',
  '2.8': null,
  '2.9': null,
};

export const STEP3_SUB_STEP_TO_TARGET: Record<
  SubStepOfStep3,
  string | string[] | null
> = {
  '3.0': null,
  '3.1': null,
  '3.2': 'badge-card-first_bite',
  '3.3': 'badge-card-planner',
  '3.4': 'badge-card-tutorial_complete',
};

export const STEP4_SUB_STEP_TO_TARGET: Record<
  SubStepOfStep4,
  string | string[] | null
> = {
  '4.0': 'tour-step-4-saving',
  '4.1': 'tour-step-4-graduate',
  '4.2': 'tour-step-4-go-home',
  '4.3': 'tour-step-5-toast',
};
