# 07 — UI コンポーネント詳細仕様

> 関連: [02-step0-welcome](./02-step0-welcome.md) / [15-design-tokens](./15-design-tokens.md) / [10-a11y](./10-a11y.md)

---

## 1. コンポーネント一覧 (新規 4 種、Web/Mobile 各 1 セット)

| コンポーネント | 用途 | Web | Mobile |
|---|---|---|---|
| `<TourOverlay>` | 全体 overlay + Spotlight 描画 + 吹き出し配置 | `src/components/handson-tour/TourOverlay.tsx` | `apps/mobile/src/handson-tour/TourOverlay.tsx` |
| `<TourBubble>` | 吹き出し (title / body / 進捗 / ボタン) | 同 dir / `TourBubble.tsx` | 同 dir / `TourBubble.tsx` |
| `<TourProgress>` | 進捗ドット (◯ ● ◯ ...) | 同 dir / `TourProgress.tsx` | 同 dir / `TourProgress.tsx` |
| `<TourSandboxWrapper>` | 既存画面を sandbox モードでマウントする HOC | 同 dir / `TourSandboxWrapper.tsx` | 同 dir / `TourSandboxWrapper.tsx` |

**コンポーネント名の確定** (§16 §5.2 と一致): v1 では短縮形 `<Tour*>` を採用。ファイル名と一致させる (`TourOverlay.tsx` → `<TourOverlay>`)。HandsonTour プレフィックスは長すぎるため不採用。

加えて、既存画面 (`<MealNewScreen>`, `<V4GenerateModal>`, `<BadgesPage>`) に `mode='sandbox'` プロップを追加する変更がある (§13-integration.md)。

---

## 2. `<TourOverlay>` 詳細

### 2.1 Props 完全 schema

```ts
interface TourOverlayProps {
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
    label: string;       // 例 "次へ" / "保存" / "ホームへ"
    onPress: () => void;
    /** 押下中の disabled 状態 */
    disabled?: boolean;
    /** disabled 中の spinner 表示 */
    showSpinner?: boolean;
  };

  /** 自動進行のタイムアウト ms (primaryAction なしのとき必須) */
  autoAdvanceMs?: number;

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
```

### 2.2 内部 state

```ts
type TourOverlayState = {
  /** 現在の target 矩形 (web: DOMRect、mobile: LayoutRectangle) */
  targetRect: TargetRect | null;
  /** entrance/exit アニメーション制御 */
  isVisible: boolean;
  /** auto-advance タイマー ID */
  autoAdvanceTimerId: number | null;
  /** scroll 監視 タイマー ID */
  scrollRecalcTimerId: number | null;
};

type TargetRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
```

### 2.3 ライフサイクル

```ts
useEffect(() => {
  // Mount: target 取得 + entrance アニメ
  measureTarget();
  setIsVisible(true);

  // Auto-advance タイマー
  if (autoAdvanceMs && primaryAction === undefined) {
    const id = setTimeout(() => onAutoAdvance(), autoAdvanceMs);
    setAutoAdvanceTimerId(id);
  }

  // Scroll 監視 (target が画面外に出たら追従、自動スクロール検討)
  const scrollId = setInterval(measureTarget, scrollRecalcIntervalMs ?? 100);
  setScrollRecalcTimerId(scrollId);

  return () => {
    if (autoAdvanceTimerId) clearTimeout(autoAdvanceTimerId);
    if (scrollRecalcTimerId) clearInterval(scrollRecalcTimerId);
  };
}, [targetTestId, targetTestIds]);

useEffect(() => {
  // targetTestId が変わったら crossfade
  if (isVisible) {
    measureTarget();
  }
}, [targetTestId, targetTestIds]);

const measureTarget = useCallback(() => {
  if (!targetTestId && !targetTestIds) {
    setTargetRect(null);
    return;
  }
  const ids = targetTestIds ?? [targetTestId!];
  const rects = ids.map(id => measureSingleElement(id)).filter(Boolean);
  if (rects.length === 0) {
    setTargetRect(null);
    return;
  }
  // 複数要素を包含する bounding rect を計算
  const merged = mergeRects(rects);
  setTargetRect(merged);
}, [targetTestId, targetTestIds]);
```

### 2.4 Web 実装 (CSS mask + Portal)

```tsx
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

export function TourOverlay(props: TourOverlayProps) {
  const { targetRect, isVisible, ... } = useTourOverlayLogic(props);

  if (!isVisible) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-live="polite"
        aria-label={props.accessibilityLabel ?? '使い方ガイド'}
        data-testid="tour-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-50"
        style={{
          // CSS mask で穴を開ける
          maskImage: targetRect ? buildSpotlightMask(targetRect, props.spotlightPadding ?? 8) : 'none',
        }}
      >
        {/* dim 背景 */}
        <div className="absolute inset-0 bg-black/60" />

        {/* 吹き出し */}
        {targetRect && (
          <TourBubble
            target={targetRect}
            bubble={props.bubble}
            position={props.bubble.position}
            primaryAction={props.primaryAction}
            progress={props.progress}
            offset={props.bubbleOffset ?? 12}
          />
        )}

        {/* スキップボタン */}
        {props.showSkip && (
          <button
            data-testid="tour-skip-button"
            onClick={props.onSkip}
            className="absolute top-4 right-4 text-white/80 hover:text-white"
            aria-label="チュートリアルを終了する"
          >
            あとで
          </button>
        )}
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
```

#### CSS mask の実装

```ts
function buildSpotlightMask(rect: TargetRect, padding: number): string {
  const x = rect.x - padding;
  const y = rect.y - padding;
  const w = rect.width + padding * 2;
  const h = rect.height + padding * 2;
  return `
    radial-gradient(
      circle at ${x + w/2}px ${y + h/2}px,
      transparent ${Math.max(w, h) / 2}px,
      black ${Math.max(w, h) / 2 + 4}px
    )
  `;
  // または rect 形状なら CSS conic / polygon mask
}
```

矩形 spotlight のため、より正確には:

```css
.overlay {
  -webkit-mask-image:
    linear-gradient(black, black),
    linear-gradient(black, black);
  -webkit-mask-position: 0 0, var(--spotlight-x) var(--spotlight-y);
  -webkit-mask-size: 100% 100%, var(--spotlight-w) var(--spotlight-h);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}
```

### 2.5 Mobile 実装 (MaskedView + Reanimated)

```tsx
import MaskedView from '@react-native-masked-view/masked-view';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { View, Pressable } from 'react-native';

export function TourOverlay(props: TourOverlayProps) {
  const opacity = useSharedValue(0);
  const { targetRect } = useTourOverlayLogic(props);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 200 });
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, animatedStyle]}
      pointerEvents="auto"
      accessibilityLabel={props.accessibilityLabel ?? '使い方ガイド'}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="tour-overlay"
    >
      <MaskedView
        style={StyleSheet.absoluteFill}
        maskElement={
          <View style={StyleSheet.absoluteFill}>
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'black' }]} />
            {targetRect && (
              <View
                style={{
                  position: 'absolute',
                  left: targetRect.x - (props.spotlightPadding ?? 8),
                  top: targetRect.y - (props.spotlightPadding ?? 8),
                  width: targetRect.width + (props.spotlightPadding ?? 8) * 2,
                  height: targetRect.height + (props.spotlightPadding ?? 8) * 2,
                  backgroundColor: 'transparent',
                  borderRadius: 12,
                }}
              />
            )}
          </View>
        }
      >
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)' }]} />
      </MaskedView>

      {targetRect && (
        <TourBubble
          target={targetRect}
          bubble={props.bubble}
          position={props.bubble.position}
          primaryAction={props.primaryAction}
          progress={props.progress}
          offset={props.bubbleOffset ?? 12}
        />
      )}

      {props.showSkip && (
        <Pressable
          testID="tour-skip-button"
          onPress={props.onSkip}
          style={{ position: 'absolute', top: 50, right: 16 }}
          accessibilityLabel="チュートリアルを終了する"
        >
          <Text style={{ color: 'rgba(255,255,255,0.8)' }}>あとで</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}
```

### 2.6 アクセシビリティ詳細

§10-a11y.md と重複しないよう、本ファイルでは props 仕様のみ。

---

## 3. `<TourBubble>` 詳細

### 3.1 Props

```ts
interface TourBubbleProps {
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
```

### 3.2 配置ロジック

```ts
function calculateBubblePosition(
  target: TargetRect | null,
  preferredPosition: 'top' | 'bottom' | 'left' | 'right' | 'auto',
  bubbleSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
  offset: number
): { x: number; y: number; actualPosition: 'top' | 'bottom' | 'left' | 'right' | 'center' } {
  if (!target) {
    // フルスクリーンモード: 画面中央
    return {
      x: (viewportSize.width - bubbleSize.width) / 2,
      y: (viewportSize.height - bubbleSize.height) / 2,
      actualPosition: 'center',
    };
  }

  if (preferredPosition === 'auto') {
    // target の位置に応じて自動判定
    const spaceBelow = viewportSize.height - (target.y + target.height);
    const spaceAbove = target.y;
    if (spaceBelow >= bubbleSize.height + offset + 16) {
      preferredPosition = 'bottom';
    } else if (spaceAbove >= bubbleSize.height + offset + 16) {
      preferredPosition = 'top';
    } else {
      preferredPosition = 'bottom';  // 諦めて bottom (overlap する)
    }
  }

  switch (preferredPosition) {
    case 'top':
      return {
        x: clamp(target.x + target.width / 2 - bubbleSize.width / 2, 16, viewportSize.width - bubbleSize.width - 16),
        y: target.y - bubbleSize.height - offset,
        actualPosition: 'top',
      };
    case 'bottom':
      return {
        x: clamp(target.x + target.width / 2 - bubbleSize.width / 2, 16, viewportSize.width - bubbleSize.width - 16),
        y: target.y + target.height + offset,
        actualPosition: 'bottom',
      };
    // left / right も同様
  }
}
```

### 3.3 矢印 (arrow / pointer)

吹き出しから target を指す三角矢印 (CSS `border` で実装):

```css
.bubble-arrow {
  position: absolute;
  width: 0;
  height: 0;
  border-left: 8px solid transparent;
  border-right: 8px solid transparent;
  border-bottom: 8px solid white;  /* light モード */
}

.bubble-arrow-top {
  top: -8px;
  left: 50%;
  transform: translateX(-50%);
}

.bubble-arrow-bottom {
  bottom: -8px;
  border-bottom: none;
  border-top: 8px solid white;
}
```

### 3.4 内部レンダリング

```tsx
function TourBubble(props: TourBubbleProps) {
  const position = calculateBubblePosition(...);

  return (
    <div
      data-testid="tour-bubble"
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        maxWidth: props.bubble.maxWidth ?? 280,
        background: 'white',
        borderRadius: 12,
        padding: 16,
        boxShadow: '0 8px 16px rgba(0,0,0,0.12)',
      }}
    >
      {/* 矢印 */}
      <div className={`bubble-arrow bubble-arrow-${position.actualPosition}`} />

      {/* 進捗 */}
      {props.progress && (
        <TourProgress current={props.progress.current} total={props.progress.total} />
      )}

      {/* タイトル */}
      {props.bubble.title && (
        <h3 data-testid="tour-bubble-title" className="text-base font-semibold mb-2">
          {props.bubble.title}
        </h3>
      )}

      {/* 本文 */}
      <p data-testid="tour-bubble-body" className="text-sm text-gray-700 mb-3">
        {props.bubble.body}
      </p>

      {/* primary action */}
      {props.primaryAction && (
        <button
          data-testid="tour-next-button"
          onClick={props.primaryAction.onPress}
          disabled={props.primaryAction.disabled}
          aria-label={props.primaryAction.label}
          className="bg-primary-600 text-white px-6 py-3 rounded-lg w-full font-semibold disabled:opacity-50"
        >
          {props.primaryAction.showSpinner ? <Spinner /> : props.primaryAction.label}
        </button>
      )}
    </div>
  );
}
```

mobile 版は `<View>` / `<Text>` / `<Pressable>` で同等構造。

### 3.5 折り返し / 長文対応

- 本文は word-wrap で自動改行
- max-width 280px、line-height 1.4
- 200 文字超える場合はスクロール許容 (max-height: 180px)
- 個人情報埋め込みで文字数が増減する可能性 → 試験で複数 nickname / cooking_experience でレイアウト確認

---

## 4. `<TourProgress>` 詳細

### 4.1 Props

```ts
interface TourProgressProps {
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
```

### 4.2 実装

```tsx
function TourProgress(props: TourProgressProps) {
  const { current, total, size = 8, spacing = 8, activeColor, inactiveColor } = props;

  return (
    <div
      data-testid="tour-progress-dots"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuetext={`ステップ ${current} / ${total}`}
      className="flex justify-center mb-2"
      style={{ gap: spacing }}
    >
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="rounded-full transition-colors duration-200"
          style={{
            width: size,
            height: size,
            backgroundColor: i + 1 <= current ? (activeColor ?? '#2563EB') : (inactiveColor ?? '#D1D5DB'),
          }}
        />
      ))}
    </div>
  );
}
```

mobile 版も同様 (`<View>` で代替)。

---

## 5. `<TourSandboxWrapper>` 詳細 (HOC)

### 5.1 役割
既存画面 (`<MealNewScreen>`, `<V4GenerateModal>`, `<BadgesPage>`) を sandbox モードでマウントし、ハンズオン用の overlay と連動させる薄い HOC。

### 5.2 Props

```ts
interface TourSandboxWrapperProps<T> {
  /** 既存コンポーネント (sandbox モード対応済み) */
  children: React.ReactElement;
  /** 既存コンポーネントに渡す props */
  childProps: T;
  /** 現在のサブステップ (Spotlight 連動用) */
  subStep: string;
  /** Overlay 設定 */
  overlay: Omit<TourOverlayProps, 'targetTestId' | 'targetTestIds'>;
  /** subStep ごとの target testID マッピング */
  subStepToTarget: Record<string, string | string[] | null>;
  /** sandbox 完了コールバック */
  onSandboxComplete: (result: any) => void;
}
```

### 5.3 実装

```tsx
function TourSandboxWrapper<T>(props: TourSandboxWrapperProps<T>) {
  const target = props.subStepToTarget[props.subStep];

  return (
    <>
      {React.cloneElement(props.children, {
        ...props.childProps,
        mode: 'sandbox',
        onSandboxComplete: props.onSandboxComplete,
      })}
      <TourOverlay
        {...props.overlay}
        targetTestId={typeof target === 'string' ? target : null}
        targetTestIds={Array.isArray(target) ? target : undefined}
      />
    </>
  );
}
```

### 5.4 使用例 (Step 1)

```tsx
function HandsonTourPhotoPage() {
  const [subStep, setSubStep] = useState<Step1State['subStep']>('1.1');
  const router = useRouter();

  const subStepToTarget = {
    '1.1': null,
    '1.2': 'meal-camera-button',
    '1.3': null,
    '1.4': null,
    '1.5': ['meal-result-dish-name', 'meal-result-calories'],
    '1.6': 'meal-save-button',
    '1.7': null,
  };

  const bubbles = {
    '1.1': { body: '写真 1 枚で食事が記録できます', position: 'auto' },
    '1.2': { body: '写真を撮るかギャラリーから選びます', position: 'top' },
    '1.5': { title: 'AI が自動判定', body: personalize('...', profile), position: 'bottom' },
    '1.6': { body: '保存するだけで毎日の記録が完成', position: 'top' },
    // ...
  };

  return (
    <TourSandboxWrapper
      subStep={subStep}
      subStepToTarget={subStepToTarget}
      overlay={{
        bubble: bubbles[subStep],
        progress: { current: 2, total: 5 },
        autoAdvanceMs: ['1.1', '1.2', '1.3', '1.4'].includes(subStep) ? 2500 : undefined,
        primaryAction: ['1.5', '1.6'].includes(subStep) ? {
          label: subStep === '1.6' ? '保存' : '次へ',
          onPress: () => advanceSubStep(),
        } : undefined,
        showSkip: false,
      }}
      childProps={{
        initialStep: 'result',
        prefilled: MOCK_PHOTO_RESPONSE,
        apiOptions: { source: 'handson_tour', sandbox: true },
      }}
      onSandboxComplete={() => router.push('/handson-tour/menu')}
    >
      <MealNewScreen />
    </TourSandboxWrapper>
  );
}
```

---

## 6. 既存画面への `mode='sandbox'` 追加

### 6.1 `<MealNewScreen>` 拡張

```ts
// apps/mobile/app/meals/new.tsx + src/app/(main)/meals/new/page.tsx

interface MealNewScreenSandboxProps {
  mode: 'sandbox';
  initialStep?: 'mode-select' | 'capture' | 'analyzing' | 'result' | 'select-date';
  prefilled: typeof MOCK_PHOTO_RESPONSE;
  apiOptions: { source: 'handson_tour'; sandbox: true };
  onSandboxComplete: (result: { meal_log_id: string; badge_awarded?: any }) => void;
  onSandboxError?: (error: any) => void;
}

interface MealNewScreenNormalProps {
  mode?: 'normal';
  // 既存 props (camera_request_id, modal_visible 等)
}

type MealNewScreenProps = MealNewScreenSandboxProps | MealNewScreenNormalProps;

function MealNewScreen(props: MealNewScreenProps) {
  if (props.mode === 'sandbox') {
    return <MealNewScreenSandbox {...props} />;
  }
  return <MealNewScreenNormal {...props} />;
}
```

### 6.2 `<V4GenerateModal>` 拡張

```ts
interface V4GenerateModalSandboxProps {
  mode: 'sandbox';
  initialFlags: { no_cook?: boolean; simple_only?: boolean; variety_emphasis?: boolean };
  prefilled: typeof MOCK_MENU_RESPONSE;
  loadingDurationMs: number;  // 2000
  apiOptions: { source: 'handson_tour'; sandbox: true };
  onSandboxComplete: (result: { menu_id: string; badge_awarded?: any }) => void;
  onSandboxError?: (error: any) => void;
}
```

### 6.3 `<BadgesPage>` 拡張

URL クエリで:
- `?tutorial-mode=1`: チュートリアルモード ON、ヘッダー / サイドバー (web) を非表示、Spotlight overlay 連動
- `?highlight=first_bite,planner,tutorial_complete`: 強調するバッジ codes

実装:

```tsx
function BadgesPage() {
  const params = useSearchParams();
  const tutorialMode = params.get('tutorial-mode') === '1';
  const highlight = params.get('highlight')?.split(',') ?? [];

  // 通常 UI を表示しつつ、tutorialMode が true なら overlay を上に重ねる
  return (
    <div>
      {!tutorialMode && <Header />}
      <div className="badges-grid">
        {badges.map(b => (
          <BadgeCard
            key={b.code}
            badge={b}
            data-testid={`badge-card-${b.code}`}
            tutorialMode={tutorialMode && highlight.includes(b.code)}
          />
        ))}
      </div>
      {tutorialMode && <HandsonTourBadgesOverlay highlight={highlight} />}
    </div>
  );
}
```

---

## 7. パフォーマンス考慮

### 7.1 `measureTarget` の頻度

- 100ms 間隔で要素位置を再計算 (scroll 追従)
- ResizeObserver / MutationObserver で要素サイズ変更も検知
- 過剰計算で iOS で fps 低下する可能性 → 100ms は妥当 (10Hz)

### 7.2 ResizeObserver (web)

```ts
useEffect(() => {
  if (!targetTestId) return;
  const el = document.querySelector(`[data-testid="${targetTestId}"]`);
  if (!el) return;
  const observer = new ResizeObserver(() => measureTarget());
  observer.observe(el);
  return () => observer.disconnect();
}, [targetTestId]);
```

### 7.3 Mobile の onLayout

```tsx
<View
  testID="meal-camera-button"
  onLayout={(e) => {
    if (currentTarget === 'meal-camera-button') {
      setTargetRect(e.nativeEvent.layout);
    }
  }}
>
```

または `measureInWindow()` / `measureLayout()` を `useEffect` 内で 100ms 間隔で呼ぶ。

---

## 8. テストケース (コンポーネント)

### 8.1 Unit
- `<TourOverlay>`:
  - target 取得成功 → spotlight 表示
  - target NULL → フルスクリーン dim
  - autoAdvanceMs → タイマー発火 → onAutoAdvance 呼出
  - primaryAction.onPress → コールバック呼出
  - reduce-motion → アニメ短縮
- `<TourBubble>`:
  - position='auto' で target 上下空間に応じて切替
  - 矢印が正しい方向 (top/bottom/left/right)
  - title なしレイアウト
- `<TourProgress>`:
  - 5 ドット中 3 つ active で正しい色
- `<TourSandboxWrapper>`:
  - children に mode='sandbox' プロップが渡る
  - subStep 切り替えで overlay の target が変わる

### 8.2 視覚回帰 (Storybook + Chromatic)
- 各コンポーネントの主要 variant スナップショット
- light / dark モード
- nickname 短/長

---

## 9. Web/Mobile 実装の差分 サマリ

| 機能 | Web | Mobile |
|---|---|---|
| Portal | `createPortal(document.body)` | 不要 (View で重ね) |
| Spotlight 穴 | CSS `mask-image` | `MaskedView` + 透明 View |
| アニメーション | Framer Motion | Reanimated |
| 要素位置取得 | `getBoundingClientRect` + ResizeObserver | `measureInWindow` + `onLayout` |
| 紙吹雪 (Step 4) | `react-confetti` | Reanimated 自前実装 |
| キーボード | Tab / Esc 対応 | (キーボード非対応、a11y のみ) |

---

## 10. ファイル配置

```
src/components/handson-tour/
├── TourOverlay.tsx
├── TourBubble.tsx
├── TourProgress.tsx
├── TourSandboxWrapper.tsx
├── useTourOverlayLogic.ts  (内部 hook、target 計測)
├── useReducedMotion.ts     (web)
└── index.ts

apps/mobile/src/handson-tour/
├── TourOverlay.tsx
├── TourBubble.tsx
├── TourProgress.tsx
├── TourSandboxWrapper.tsx
├── useTourOverlayLogic.ts  (内部 hook)
├── useReducedMotion.ts     (mobile版、AccessibilityInfo)
└── index.ts
```

---

## 11. 残不確実性 (§99 連携)

- [ ] CSS mask 対応ブラウザ範囲 (Safari 12+ / Chrome / Firefox / Edge OK、IE は対象外)
- [ ] mobile 版 `<MaskedView>` の Android 大画面 (Foldable) での表示崩れ確認
- [ ] Reanimated v3 で 60fps 維持できるか (LayoutAnimation との併用 NG)
- [ ] `<TourSandboxWrapper>` で children を cloneElement する際の TypeScript 型推論の煩雑さ (HOC 型ヘルパーが必要かも)
- [ ] ResizeObserver fallback (古いブラウザ): Polyfill 必要か / 諦めるか
- [ ] target が Modal 内にある場合 (例: V4GenerateModal の中の generate-button) の measureInWindow の挙動
