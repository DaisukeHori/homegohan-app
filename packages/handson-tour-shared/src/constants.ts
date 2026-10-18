// ハンズオン中で使う固定値
// Canonical: docs/design/family/09-onboarding-handson-tour/14-mocks-i18n.md §5.1

export const HANDSON_TOUR_CONSTANTS = {
  // 各ステップの自動進行タイマー (ms)
  STEP1_INTRO_AUTO_MS: 2500,
  STEP1_CAMERA_AUTO_MS: 2000,
  STEP1_ANALYZING_DURATION_MS: 1500,
  STEP1_RESULT_TO_SPOTLIGHT_MS: 500,

  STEP2_INTRO_AUTO_MS: 2500,
  STEP2_LOADING_DURATION_MS: 2000,

  STEP3_INTRO_AUTO_MS: 2000,

  STEP4_SAVING_DELAY_MS: 100,
  STEP4_BUTTON_ACTIVATION_MS: 5000,

  STEP5_TOAST_DURATION_MS: 4000,

  // エラー連続失敗閾値
  ERROR_CONSECUTIVE_THRESHOLD: 3,

  // タイムアウト
  STATUS_API_TIMEOUT_MS: 5000,
  COMPLETE_API_TIMEOUT_MS: 10000,

  // アニメーション
  OVERLAY_FADE_IN_MS: 200,
  OVERLAY_FADE_OUT_MS: 200,
  SPOTLIGHT_MOVE_MS: 250,
  BUBBLE_FADE_IN_MS: 150,
  BUBBLE_FADE_DELAY_MS: 100,

  // 紙吹雪
  CONFETTI_PARTICLE_COUNT: 300,
  CONFETTI_DURATION_MS: 3000,

  // バッジ
  BADGE_GLOW_DURATION_MS: 1000,
} as const;

export type HandsonTourConstantsKey = keyof typeof HANDSON_TOUR_CONSTANTS;

/**
 * Step 3 (バッジ確認) に来た時点で、ツアーが前の Step で実際に付けているバッジのコード (#1626)。
 * - planner: Step 2 の [献立に追加] (POST /api/menu-plans/add) が awardBadge で付ける
 *   (AI で複数の日の献立をまとめて作った生成の完了でも付くが (#1867)、ツアーの中では AI の献立の生成をしないので、Step 3 の時点の数には関わらない)
 * - first_bite は入れない: Step 1 のお試しの記録はバッジの判定に数えない (#1314。GET /api/badges は is_sandbox の記録を数えない)
 * Step 3 の intro_title / a11y_title の「n つ」(日本語・英語) はこの数と合わせる。
 * packages/handson-tour-shared/__tests__/i18n.test.ts が文言の数と、tests/handson-tour-step3-earned-count.test.ts が実際の付与の経路と突き合わせる
 */
export const STEP3_BADGES_EARNED_IN_TOUR = ['planner'] as const;
