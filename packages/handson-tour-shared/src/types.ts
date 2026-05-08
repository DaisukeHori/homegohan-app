// TourOverlay / TourBubble / TourProgress / TourSandboxWrapper の型定義
// Canonical: docs/design/family/09-onboarding-handson-tour/07-components.md §2.1 §3.1 §4.1 §5.2
// docs/design/family/09-onboarding-handson-tour/08-state-db.md §6.1 §2.2

// ============================================================
// 補助型
// ============================================================

export type TargetRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// ============================================================
// TourState (§08 §6.1)
// ============================================================

export type TourState = {
  /** 現在の Step (0-5) */
  currentStep: 0 | 1 | 2 | 3 | 4 | 5;
  /** Step 0 開始時刻 (total_duration_ms 計算用) */
  tourStartTimestamp: number;
  /** entry source (analytics) */
  entrySource: 'auto' | 'settings_force';
  /** 各ステップの dwell time */
  stepDwellMs: Record<number, number>;
  /** force=1 で再表示中か */
  forceMode: boolean;
};

// ============================================================
// Step1State (§03 §10.1)
// ============================================================

export type Step1State = {
  subStep: '1.1' | '1.2' | '1.3' | '1.4' | '1.5' | '1.6' | '1.7' | '1.8' | 'error';
  isAutoAdvancing: boolean;
  errorCount: number;
  errorPayload: ErrorPayload | null;
  mountTime: number;
};

export type ErrorPayload = {
  code: string;
  message: string;
  httpStatus?: number;
};

// ============================================================
// TourOverlayState (§07 §2.2)
// ============================================================

export type TourOverlayState = {
  /** 現在の target 矩形 (web: DOMRect、mobile: LayoutRectangle) */
  targetRect: TargetRect | null;
  /** entrance/exit アニメーション制御 */
  isVisible: boolean;
  /** auto-advance タイマー ID */
  autoAdvanceTimerId: number | null;
  /** scroll 監視 タイマー ID */
  scrollRecalcTimerId: number | null;
};

// ============================================================
// TourOverlayProps (§07 §2.1)
// ============================================================

export interface TourOverlayProps {
  /** Spotlight ターゲットの testID。null ならフルスクリーン (target なし) */
  targetTestId: string | null;

  /** 複数要素をまとめて Spotlight する場合 (例: 結果カード + カロリー両方) */
  targetTestIds?: string[];

  /** 吹き出しの内容 */
  bubble: {
    /** 任意のタイトル */
    title?: string;
    /** 本文 (個人情報展開済の確定文字列を渡す、HTML タグ含めない) */
    body: string;
    /** 吹き出し位置 */
    position: 'top' | 'bottom' | 'left' | 'right' | 'auto';
    /** 吹き出し最大幅 (default 280px) */
    maxWidth?: number;
  };

  /** 進行ボタン (null なら非表示 = 自動進行 mode) */
  primaryAction?: {
    label: string;
    onPress: () => void;
    /** 押下中の disabled 状態 */
    disabled?: boolean;
    /** disabled 中の spinner 表示 */
    showSpinner?: boolean;
  };

  /** 自動進行のタイムアウト ms (primaryAction なしのとき必須) */
  autoAdvanceMs?: number;

  /** 自動進行コールバック (autoAdvanceMs 経過時に発火) */
  onAutoAdvance?: () => void;

  /** 自動進行に対するキャンセル可否 (タップで進められるか) */
  autoAdvanceTappable?: boolean;

  /** スキップボタンを表示するか (Step 0/4 のみ true) */
  showSkip?: boolean;
  onSkip?: () => void;

  /** 進捗 (Step 0/1/2/3/4 = 0-4) */
  progress?: { current: number; total: number };

  /** dimmed 背景の opacity (default 0.6) */
  dimOpacity?: number;

  /** spotlight padding (px) (default 8) */
  spotlightPadding?: number;

  /** 吹き出しまでの距離 (px) (default 12) */
  bubbleOffset?: number;

  /** a11y 用ラベル (default "使い方ガイド") */
  accessibilityLabel?: string;

  /** 動きの低減を強制 (テスト用) */
  forceReducedMotion?: boolean;

  /** スクロール時に target 位置を再計算する間隔 (ms) (default 100) */
  scrollRecalcIntervalMs?: number;

  /** Spotlight クリック時の動作 (default 'block' = タップを無効化) */
  spotlightClickBehavior?: 'block' | 'forward';
}

// ============================================================
// TourBubbleProps (§07 §3.1)
// ============================================================

export interface TourBubbleProps {
  /** Spotlight ターゲットの矩形 (吹き出し配置の基準) */
  target: TargetRect | null;
  /** 吹き出し内容 */
  bubble: {
    title?: string;
    body: string;
    maxWidth?: number;
  };
  /** 配置位置 */
  position: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  /** primary action (任意) */
  primaryAction?: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    showSpinner?: boolean;
  };
  /** 進捗ドット */
  progress?: { current: number; total: number };
  /** target との距離 */
  offset: number;
}

// ============================================================
// TourProgressProps (§07 §4.1)
// ============================================================

export interface TourProgressProps {
  /** 現在のステップ (1-based、1..total) */
  current: number;
  /** 全ステップ数 (= 5、Step 0-4) */
  total: number;
  /** ドットサイズ (default 8px) */
  size?: number;
  /** ドット間隔 (default 8px) */
  spacing?: number;
  /** active カラー (default primary-600) */
  activeColor?: string;
  /** inactive カラー (default gray-300) */
  inactiveColor?: string;
}

// ============================================================
// TourSandboxWrapperProps<T> (§07 §5.2)
// ============================================================

export interface TourSandboxWrapperProps<T> {
  /** 既存コンポーネントに渡す props */
  childProps: T;
  /** 現在のサブステップ (Spotlight 連動用) */
  subStep: string;
  /** Overlay 設定 */
  overlay: Omit<TourOverlayProps, 'targetTestId' | 'targetTestIds'>;
  /** subStep ごとの target testID マッピング */
  subStepToTarget: Record<string, string | string[] | null>;
  /** sandbox 完了コールバック */
  onSandboxComplete: (result: unknown) => void;
}
