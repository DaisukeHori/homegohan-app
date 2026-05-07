# 02 — Step 0: ウェルカム画面 詳細

> 関連: [01-trigger-flow](./01-trigger-flow.md) / [03-step1-photo](./03-step1-photo.md) / [07-components](./07-components.md) / [10-a11y](./10-a11y.md) / [15-design-tokens](./15-design-tokens.md)

---

## 1. 画面役割

ハンズオンの最初の画面。ユーザーに **これから何が起こるか** を予告し、開始 / スキップの選択を促す。Spotlight / コーチマークは使わず、フルスクリーンモーダル単独。

---

## 2. レイアウト

### 2.1 ASCII ワイヤーフレーム

```
┌──────────────────────────────────────┐ ← 端末画面 (ステータスバー含む)
│ [status bar 透明 / dim 背景]            │
├──────────────────────────────────────┤
│                                      │
│                                      │
│                                      │
│             ┌──────────┐              │ ← アプリアイコン 96×96
│             │   icon   │              │   位置: 上から 25%
│             └──────────┘              │
│                                      │
│       {nickname} さん、ようこそ! 👋     │ ← title 24sp/1.5rem bold
│                                      │
│       3 つの便利機能を                  │ ← subtitle 16sp/1rem regular
│       一緒に試してみましょう              │   line-height 1.5
│       (約 90 秒)                       │
│                                      │
│         ● ○ ○ ○ ○                   │ ← 進捗ドット 5 個 (Step 0-4、active=primary, inactive=gray)
│                                      │
│        ┌────────────────┐              │
│        │   はじめる      │              │ ← primary button
│        └────────────────┘              │   高さ 56px、横幅 80%
│                                      │
│           [ あとで ]                   │ ← text button、高さ 44px (a11y 最小)
│                                      │
│                                      │
└──────────────────────────────────────┘
   背景全体: rgba(0,0,0,0.6) (バックドロップ)
   モーダル本体: 白 (light) / gray-900 (dark)
```

### 2.2 寸法表 (詳細)

| 要素 | width | height | offset |
|---|---|---|---|
| ステータスバー | 100% | OS 依存 (~44pt iOS) | top: 0 |
| モーダル本体 (visible area) | 100% (mobile) / max 480px (web) | 100% | center |
| アプリアイコン | 96px | 96px | top: 25% (≒ 200pt on iPhone 14) |
| title | max 320px | auto | margin-top: 32px from icon |
| subtitle | max 280px | auto | margin-top: 16px from title |
| 進捗ドット | 8px × 5 + 8px × 4 spacing = 72px | 8px | margin-top: 40px from subtitle (Step 0-4 の 5 個) |
| 【はじめる】ボタン | 80% (max 320px) | 56px | margin-top: 40px from dots |
| 【あとで】ボタン | auto (テキスト幅) | 44px | margin-top: 16px from primary |

### 2.3 レスポンシブ
| 画面サイズ | レイアウト |
|---|---|
| < 360px (極小スマホ) | アイコン 80×80、title 22sp、subtitle 14sp |
| 360-768px (通常スマホ) | 上記基準 |
| > 768px (タブレット / Web デスクトップ) | モーダル幅 max 480px、画面中央寄せ、背景 dim はそのまま画面全体 |
| ランドスケープ | 縦スクロール許容 (mobile)、Web は中央寄せ維持 |

### 2.4 セーフエリア対応
- iOS: `useSafeAreaInsets()` で top/bottom 余白を確保
- Android: `StatusBar.translucent={false}` で被らない
- web: `100vh` だが iOS Safari の bottom URL バー考慮で `100dvh` (dynamic viewport)

---

## 3. UI 文言 (i18n key 確定)

### 3.1 表示文言

| key | 文言 | 個人情報展開 |
|---|---|---|
| `tour.step0.title` | "{nickname} さん、ようこそ!" | nickname (`user_profiles.nickname`) を埋込 |
| `tour.step0.subtitle` | "3 つの便利機能を一緒に試してみましょう (約 90 秒)" | なし |
| `tour.step0.start_button` | "はじめる" | なし |
| `tour.step0.later_button` | "あとで" | なし |

### 3.2 nickname フォールバック
| nickname の値 | 表示 |
|---|---|
| 通常文字列 | "{nickname} さん、ようこそ!" |
| `''` (空文字) or 空白のみ | "あなた、ようこそ!" |
| NULL (理論上ないが防御) | "あなた、ようこそ!" |
| 50 文字超 | 先頭 30 文字 + "…" |
| 絵文字含む | そのまま表示 (将来 emoji parse) |

### 3.3 アクセシビリティ用文言

| key | 文言 |
|---|---|
| `tour.step0.a11y_title` | "ステップ 1 / 5、{nickname} さんへのウェルカム画面" |
| `tour.step0.a11y_start_hint` | "タップするとハンズオンが始まります" |
| `tour.step0.a11y_later_hint` | "タップするとチュートリアルを終了します" |

VoiceOver / TalkBack 読み上げ順:
1. `a11y_title` (1 度のみ、画面表示時)
2. subtitle 本文
3. 進捗ドット (`role="progressbar" aria-valuetext="ステップ 1 / 5"`)
4. 【はじめる】 + a11y_start_hint
5. 【あとで】 + a11y_later_hint

---

## 4. インタラクション

### 4.1 タップ・ボタン挙動

| 要素 | タップ動作 | サーバー副作用 |
|---|---|---|
| 【はじめる】 | Step 1 へ遷移 (`/handson-tour/photo`) | `handson_tour_started` event 発火 |
| 【あとで】 | /home へ遷移 + `POST /api/handson-tour/skip { step: 0, reason: 'user_action' }` | `handson_tour_skipped_at` セット |
| ハードバック | 【あとで】と同じ動作 (reason: 'hard_back') | 同上 |
| アプリアイコン | タップ無効 (装飾のみ) | なし |
| Tap outside (web) | タップ無効 (誤クリック防止) | なし |
| Esc キー (web のみ) | 【あとで】と同じ | 同上 |

### 4.2 タップ領域

すべてのインタラクティブ要素は最小 44×44pt (Apple HIG / WCAG 2.5.5 AA)。

【あとで】テキストボタンは見た目より広いタップ領域 (44px height、padding で確保):

```css
.later-button {
  padding: 12px 24px;
  min-height: 44px;
  min-width: 88px;
}
```

### 4.3 二重タップ防止

【はじめる】タップ後 1 秒間 disabled (連打で複数 event 発火を防止)。

```ts
const [isTransitioning, setIsTransitioning] = useState(false);
const handleStart = () => {
  if (isTransitioning) return;
  setIsTransitioning(true);
  fireAnalytics('handson_tour_started', { entry_source: entrySource });
  router.push('/handson-tour/photo');
};
```

---

## 5. アニメーション

### 5.1 entrance (画面表示時)

```
0ms      : opacity 0 + scale 0.95 (モーダル)、背景 dim opacity 0
0-200ms  : 背景 dim opacity 0 → 0.6 (linear)
0-300ms  : モーダル opacity 0 → 1 (ease-out) + scale 0.95 → 1.0
300ms-   : 進捗ドット fade in
400ms-   : ボタン fade in (順次)
```

### 5.2 exit (Step 1 へ遷移時)

```
0-200ms  : モーダル opacity 1 → 0 (ease-in) + scale 1.0 → 0.98
0-200ms  : 背景 dim opacity 0.6 → 0 (linear)
```

### 5.3 動きの低減 (`prefers-reduced-motion: reduce`)

| 要素 | 通常 | reduced-motion |
|---|---|---|
| 背景 dim | linear 200ms | 即時 (0ms) |
| モーダル fade-in | ease-out 300ms | linear 100ms |
| モーダル scale | 0.95→1.0 | 1.0 固定 (無し) |
| 進捗ドット fade | sequenced | 即時表示 |

### 5.4 web 実装 (Framer Motion)

```tsx
import { motion } from 'framer-motion';

<motion.div
  initial={{ opacity: 0, scale: 0.95 }}
  animate={{ opacity: 1, scale: 1 }}
  exit={{ opacity: 0, scale: 0.98 }}
  transition={prefersReducedMotion ? { duration: 0.1 } : { duration: 0.3, ease: 'easeOut' }}
>
  {/* モーダル content */}
</motion.div>
```

### 5.5 mobile 実装 (Reanimated v3)

```tsx
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';

const opacity = useSharedValue(0);
const scale = useSharedValue(0.95);

useEffect(() => {
  opacity.value = withTiming(1, { duration: 300, easing: Easing.out(Easing.ease) });
  scale.value = withTiming(1, { duration: 300, easing: Easing.out(Easing.ease) });
}, []);

const animatedStyle = useAnimatedStyle(() => ({
  opacity: opacity.value,
  transform: [{ scale: scale.value }],
}));

<Animated.View style={animatedStyle}>{/* content */}</Animated.View>
```

### 5.6 動きの低減実装

```ts
// web
const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

// mobile
import { AccessibilityInfo } from 'react-native';
const [reduceMotion, setReduceMotion] = useState(false);
useEffect(() => {
  AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
}, []);
```

---

## 6. 状態管理

### 6.1 ローカル state

```ts
type Step0State = {
  entrySource: 'auto' | 'settings_force';   // route から決定
  isTransitioning: boolean;                 // 二重タップ防止
  isVisible: boolean;                       // entrance/exit アニメーション制御
};
```

### 6.2 entrySource 判定

```ts
// web: useSearchParams or pathname
const params = useSearchParams();
const entrySource = params.get('force') === '1' ? 'settings_force' : 'auto';

// mobile: useLocalSearchParams (expo-router)
const params = useLocalSearchParams();
const entrySource = params.force === '1' ? 'settings_force' : 'auto';
```

### 6.3 進捗ドット計算

```ts
const steps = ['welcome', 'photo', 'menu', 'badges', 'graduate'];  // length 5
const currentStepIndex = 0;  // Step 0 = welcome
const progressDotsTotal = 5;
const progressDotsActive = currentStepIndex + 1;  // 1 / 5
```

ASCII では 3 個のドットを示しているが、実装上は **5 個** が正しい (= Step 0 から 4 まで)。Step 5 (本番ホーム) はカウントしない。

### 6.4 nickname 取得

```ts
// web
import { useUser } from '@/hooks/useUser';
const { profile } = useUser();
const nickname = profile?.nickname?.trim() || 'あなた';

// mobile
import { useProfile } from '@/hooks/useProfile';
const profile = useProfile();
const nickname = profile?.nickname?.trim() || 'あなた';
```

---

## 7. エラーケース

### 7.1 想定エラー

| エラー | 発生条件 | UX |
|---|---|---|
| nickname 取得失敗 | profile API 失敗 | "あなた" にフォールバック表示、event `handson_tour_step_error { step: 0, error_code: 'profile_fetch_fail' }` |
| skip API 失敗 | ネットワーク断 | ローカルの skipped state は維持、サーバー側スキップは次回 status 確認時にも繰り返し試行 (idempotent) |
| Analytics 失敗 | PostHog/Mixpanel ネットワーク失敗 | UX には影響しない、analytics SDK 内蔵リトライに任せる |

### 7.2 nickname 表示時の防御

```ts
function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}
```

---

## 8. アクセシビリティ詳細

### 8.1 セマンティクス (web)

```tsx
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="tour-step0-title"
  aria-describedby="tour-step0-subtitle"
  data-testid="tour-step-0"
>
  <img src="/icon.png" alt="" aria-hidden="true" /> {/* 装飾 */}
  <h1 id="tour-step0-title" data-testid="tour-step-0-title">
    {nickname} さん、ようこそ!
  </h1>
  <p id="tour-step0-subtitle" data-testid="tour-step-0-subtitle">
    3 つの便利機能を一緒に試してみましょう (約 90 秒)
  </p>
  <div role="progressbar" aria-valuenow={1} aria-valuemin={1} aria-valuemax={5} aria-valuetext="ステップ 1 / 5">
    {/* dots 装飾的、aria-hidden */}
    <span aria-hidden="true">●</span>
    <span aria-hidden="true">○</span>
    {/* ... */}
  </div>
  <button data-testid="tour-step-0-start" onClick={handleStart} aria-label="ハンズオンを はじめる">
    はじめる
  </button>
  <button data-testid="tour-step-0-skip" onClick={handleSkip} aria-label="チュートリアルを終了する">
    あとで
  </button>
</div>
```

### 8.2 セマンティクス (mobile)

```tsx
import { View, Text, Pressable, Image } from 'react-native';

<View
  accessibilityRole="alert"
  accessibilityLiveRegion="polite"
  accessibilityLabel="ハンズオンチュートリアル ウェルカム画面"
  testID="tour-step-0"
>
  <Image source={require('./icon.png')} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
  <Text accessibilityRole="header" testID="tour-step-0-title">
    {nickname} さん、ようこそ!
  </Text>
  <Text testID="tour-step-0-subtitle">
    3 つの便利機能を一緒に試してみましょう (約 90 秒)
  </Text>
  <View accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: 5, now: 1, text: 'ステップ 1 / 5' }}>
    {/* dots */}
  </View>
  <Pressable
    testID="tour-step-0-start"
    onPress={handleStart}
    accessibilityRole="button"
    accessibilityLabel="ハンズオンを はじめる"
    accessibilityHint="タップするとチュートリアルが始まります"
  >
    <Text>はじめる</Text>
  </Pressable>
  <Pressable
    testID="tour-step-0-skip"
    onPress={handleSkip}
    accessibilityRole="button"
    accessibilityLabel="チュートリアルを終了する"
  >
    <Text>あとで</Text>
  </Pressable>
</View>
```

### 8.3 VoiceOver アナウンス (画面表示時)

mobile では `AccessibilityInfo.announceForAccessibility()` で追加アナウンス:

```ts
useEffect(() => {
  AccessibilityInfo.announceForAccessibility(
    `ステップ 1 / 5、${nickname} さんへのウェルカム画面。3 つの便利機能を一緒に試してみましょう。約 90 秒です。`
  );
}, [nickname]);
```

web は `aria-live="polite"` の自動読み上げに任せる。

### 8.4 キーボード (web)

| キー | 動作 |
|---|---|
| Tab | フォーカス循環: 【はじめる】→ 【あとで】→ 【はじめる】(無限ループ、モーダル trap) |
| Enter / Space | 現在フォーカスのボタン押下 |
| Esc | 【あとで】と同等 |

実装: `react-focus-lock` を使ってモーダル内に focus を閉じ込める。

---

## 9. データ依存関係

### 9.1 必要な data

| 項目 | 取得元 | 失敗時 |
|---|---|---|
| `nickname` | profile API or context | "あなた" フォールバック |
| `entrySource` | URL query (`force=1`) | 'auto' default |

### 9.2 不要な data

- meal_logs / weekly_menus (Step 0 では不要、Step 1 で初めて発火)
- badges (Step 3 で初めて取得)
- target_kcal_per_day (Step 1 から使用)

→ Step 0 は最も軽量、レンダリング 50ms 以内に完了 (§18-performance.md)。

---

## 10. testID 一覧

| testID | 要素 | 用途 |
|---|---|---|
| `tour-step-0` | モーダル全体 | E2E 表示確認 |
| `tour-step-0-title` | title text | 文言確認 |
| `tour-step-0-subtitle` | subtitle text | 文言確認 |
| `tour-step-0-start` | 【はじめる】 | E2E タップ |
| `tour-step-0-skip` | 【あとで】 | E2E タップ |
| `tour-progress-dots` | 進捗ドット container | E2E 進捗確認 (共通) |

---

## 11. Analytics events

### 11.1 発火するイベント

| event | timing | properties |
|---|---|---|
| `handson_tour_step_viewed` | Step 0 マウント時 | `{ step: 0, platform, app_version }` |
| `handson_tour_started` | 【はじめる】タップ | `{ entry_source: 'auto'|'settings_force', platform }` |
| `handson_tour_step_completed` | 【はじめる】タップ後 | `{ step: 0, dwell_ms }` |
| `handson_tour_skipped` | 【あとで】タップ or hard_back | `{ step: 0, reason: 'user_action'|'hard_back' }` |

### 11.2 dwell_ms の計測

```ts
const mountTime = useRef(Date.now());
const handleStart = () => {
  const dwellMs = Date.now() - mountTime.current;
  fireAnalytics('handson_tour_step_completed', { step: 0, dwell_ms: dwellMs });
  // ...
};
```

---

## 12. 既存実装との統合

### 12.1 onboarding/complete からの遷移

`src/app/api/onboarding/complete/route.ts` のレスポンスに `next_route` 追加:

```ts
const tourStatus = await getHandsonTourStatus(userId);
return NextResponse.json({
  ok: true,
  next_route: tourStatus.should_show ? '/handson-tour' : '/home',
  ...existingFields,
});
```

クライアント側 (`src/app/onboarding/complete/page.tsx`) は `next_route` を使って遷移:

```ts
const result = await fetch('/api/onboarding/complete', { method: 'POST' }).then(r => r.json());
router.replace(result.next_route);
```

### 12.2 /handson-tour ルート追加

新規ファイル:
- `src/app/handson-tour/layout.tsx` (共通 layout、§1.3.3 マウント検証)
- `src/app/handson-tour/page.tsx` (= Step 0)

mobile 同様:
- `apps/mobile/app/handson-tour/_layout.tsx`
- `apps/mobile/app/handson-tour/index.tsx` (= Step 0)

---

## 13. テストケース

### 13.1 Unit (`<TourStep0Welcome>`)
- nickname null / empty / normal / 50 字超
- entrySource auto / settings_force
- click /タップ で正しい route へ遷移する
- click 中の二重タップ防止 (1 秒間 disabled)
- prefers-reduced-motion で動きが減る

### 13.2 E2E (Maestro)
```yaml
# 02-skip-at-welcome.yaml
appId: com.homegohan.app
---
- runFlow: ../_shared/login-as-new-user.yaml
- assertVisible:
    id: tour-step-0
- assertVisible:
    id: tour-step-0-title
    text: ".+さん、ようこそ!"
- tapOn:
    id: tour-step-0-skip
- assertVisible:
    id: home-condition-section
- assertNotVisible:
    id: tour-step-0
- # 再起動後にも表示されない
- killApp
- launchApp
- assertVisible:
    id: home-condition-section
- assertNotVisible:
    id: tour-step-0
```

### 13.3 視覚回帰
- Storybook (web) で 4 variant スナップショット:
  - nickname normal / 30 字超 / 空
  - reduce-motion off / on

---

## 14. 残不確実性

[`99-open-questions.md`](./99-open-questions.md) §step0 セクションに集約:

- [ ] キャッチコピー文言確定 (案: "3 つの便利機能を一緒に試してみましょう")
- [ ] 進捗ドット 5 個で表示するか 3 個で表示するか (実体は 5 ステップ、UX として 3 にまとめる案も)
- [ ] アプリアイコンの位置 (top: 25% で OK か、もう少し上か)
- [ ] entrance アニメーションの persistence (reduce-motion off の人にだけ scale 演出するか、全員にするか)
