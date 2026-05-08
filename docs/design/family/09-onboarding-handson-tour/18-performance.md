# 18 — パフォーマンス

> 関連: [07-components](./07-components.md) / [15-design-tokens](./15-design-tokens.md) / [20-observability](./20-observability.md)

---

## 1. パフォーマンス目標値

### 1.1 Web

| 指標 | 目標 | 計測 |
|---|---|---|
| First Contentful Paint (FCP) | < 1.5s | Lighthouse |
| Largest Contentful Paint (LCP) | < 2.5s | Lighthouse |
| Time to Interactive (TTI) | < 3.0s | Lighthouse |
| Total Blocking Time (TBT) | < 200ms | Lighthouse |
| Cumulative Layout Shift (CLS) | < 0.1 | Lighthouse |
| Performance Score | > 90 | Lighthouse |

### 1.2 Mobile

| 指標 | 目標 | 計測 |
|---|---|---|
| アプリ起動 → /handson-tour 表示 | < 1.5s (新規 signup 直後) | 実機計測 (Reanimated frame callback) |
| Step 0 → Step 1 遷移 | < 500ms | 同上 |
| Step 1 結果画面表示まで | mock 1.5s + UI ~200ms = < 2.0s | 同上 |
| Step 4 紙吹雪アニメーション中 | 60fps 維持 | useFrameCallback |
| Spotlight 移動 | < 250ms (アニメ duration) | 同上 |
| Tour 完了後 /home 遷移 | < 1.0s | 同上 |

### 1.3 API

| エンドポイント | p95 目標 | 計測 |
|---|---|---|
| GET /api/handson-tour/status | < 100ms | OpenTelemetry |
| POST /api/handson-tour/complete | < 500ms | 同上 |
| POST /api/handson-tour/skip | < 200ms | 同上 |
| POST /api/meal-plans/add-from-photo (sandbox) | < 500ms | 同上 |
| POST /api/menu-plans/add (sandbox) | < 500ms | 同上 |

---

## 2. ボトルネック分析

### 2.1 想定されるボトルネック

| 箇所 | 原因 | 対策 |
|---|---|---|
| 起動時の status API call | ネットワーク | プリフェッチ (onboarding/complete のレスポンスに含める) |
| サンプル画像読込 | 画像サイズ | webp 化 + preload |
| Spotlight 計測 (measureTarget) | 100ms 間隔の polling | Polling は Tour 表示中のみ、不要時は止める |
| 紙吹雪 | 300 paritcle 描画 | Reanimated worklet で UI thread 外で実行 |
| 卒業 API | DB トランザクション | RPC 関数化、index 最適化 |

### 2.2 ボトルネック解消の優先度

1. (高) サンプル画像 preload + webp 化
2. (高) status API のキャッシュ (短期 5 分)
3. (中) measureTarget polling 最適化
4. (低) 紙吹雪 fps 監視 → 必要なら particle 数削減

---

## 3. 画像最適化

### 3.1 sample-meal.jpg → sample-meal.webp

```bash
cwebp -q 85 sample-meal.jpg -o sample-meal.webp
# 元 jpg 200KB → webp ~80KB (60% 削減)
```

### 3.2 picture タグで配信 (web)

```tsx
<picture>
  <source srcSet="/handson-tour/sample-meal.webp" type="image/webp" />
  <img src="/handson-tour/sample-meal.jpg" alt="..." width={1024} height={768} />
</picture>
```

### 3.3 preload (web)

Step 0 マウント時に Step 1 で使う画像を preload:

```tsx
useEffect(() => {
  // Step 0 マウント時、Step 1 画像を pre-fetch
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'image';
  link.href = '/handson-tour/sample-meal.webp';
  document.head.appendChild(link);
  return () => document.head.removeChild(link);
}, []);
```

### 3.4 mobile (Expo)

```tsx
import { Image } from 'expo-image';
import { Asset } from 'expo-asset';

// プリロード
useEffect(() => {
  Asset.fromModule(require('../../../apps/mobile/assets/handson-tour/sample-meal.jpg')).downloadAsync();
}, []);
```

---

## 4. status API キャッシュ

### 4.1 キャッシュ戦略

ハンズオン状態は 1 度確定したら変わりにくい (= completed_at セット後、同じ user で skip にならない)。短期キャッシュで API 負荷削減:

#### サーバー側 (HTTP Cache-Control)

```
Cache-Control: private, max-age=300  // 5 分
```

ただし `should_show: true` の場合のみキャッシュ (= 完了したら即時無効化したい)。

#### クライアント側 (in-memory)

```ts
const statusCache = new Map<string, { value: HandsonTourStatusResponse; expiresAt: number }>();

async function getStatus() {
  const userId = getUserId();
  const cached = statusCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await fetch('/api/handson-tour/status').then(r => r.json());
  statusCache.set(userId, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
  return value;
}

// 完了/スキップ後にキャッシュ無効化
function invalidateCache() {
  statusCache.clear();
}
```

### 4.2 onboarding/complete レスポンスから直接取得

ベストパフォーマンス: status API を呼ばずに、onboarding/complete のレスポンスから `next_route` を直接取得。

```ts
const onboardingResult = await fetch('/api/onboarding/complete', { method: 'POST' }).then(r => r.json());
router.replace(onboardingResult.next_route);  // status API 呼ばない
```

これで status API 呼び出しを省略 (Step 0 への遷移時)。/home 直接アクセス時のみ status を呼ぶ。

---

## 5. measureTarget の最適化

### 5.1 現状 (§07 §7.1)

100ms 間隔で `getBoundingClientRect` (web) / `measureInWindow` (mobile)。10Hz polling。

### 5.2 改善案

#### 案 A: 必要時のみ計測

```ts
useEffect(() => {
  if (!isVisible || !targetTestId) return;

  measureTarget();

  // ResizeObserver (web) や Layout 変化検出 (mobile) で代替
  const observer = new ResizeObserver(measureTarget);
  observer.observe(document.querySelector(`[data-testid="${targetTestId}"]`));

  // scroll 監視
  const onScroll = () => measureTarget();
  window.addEventListener('scroll', onScroll);

  return () => {
    observer.disconnect();
    window.removeEventListener('scroll', onScroll);
  };
}, [isVisible, targetTestId]);
```

→ polling やめて event-driven。CPU 負荷削減。

#### 案 B: requestAnimationFrame

```ts
let rafId: number | null = null;
function tick() {
  measureTarget();
  rafId = requestAnimationFrame(tick);
}

useEffect(() => {
  if (!isVisible) return;
  tick();
  return () => rafId && cancelAnimationFrame(rafId);
}, [isVisible]);
```

→ ブラウザ標準で最適化、scroll/resize に追従。

→ **推奨は案 A** (必要時のみ + ResizeObserver)。

---

## 6. Reanimated worklet (mobile)

### 6.1 spring アニメーション

```ts
const scale = useSharedValue(0.5);
useEffect(() => {
  scale.value = withSpring(1, { damping: 10, stiffness: 100 });
}, []);
```

UI thread 外で実行、JS thread に影響しない (60fps 維持)。

### 6.2 紙吹雪 worklet

```ts
import { useFrameCallback } from 'react-native-reanimated';

const particles = useSharedValue<Particle[]>([]);

const frameCallback = useFrameCallback((info) => {
  'worklet';
  const dt = info.timeSincePreviousFrame ?? 16;
  particles.value = particles.value.map(p => ({
    ...p,
    y: p.y + p.vy * dt / 1000,
    rotation: p.rotation + p.vr * dt / 1000,
    opacity: Math.max(0, p.opacity - dt / 3000),
  }));
}, true);
```

worklet は UI thread で実行。JS スレッドのブロッキングなし。

---

## 7. Bundle サイズ削減

### 7.1 共通 package のツリーシェイキング

```ts
// 個別 import (推奨)
import { MOCK_PHOTO_RESPONSE } from '@homegohan/handson-tour-shared/mocks';

// vs 一括 import (未使用も含む)
import * as Tour from '@homegohan/handson-tour-shared';
```

`package.json` で `"sideEffects": false` を指定:

```json
{
  "name": "@homegohan/handson-tour-shared",
  "sideEffects": false,
  ...
}
```

### 7.2 dynamic import

ハンズオンルートは初回 visit 時のみ load:

```tsx
// src/app/handson-tour/layout.tsx
import dynamic from 'next/dynamic';

const TourOverlay = dynamic(() => import('@/components/handson-tour/TourOverlay'), {
  ssr: false,  // overlay は client only
  loading: () => <Spinner />,
});
```

→ 通常ユーザーの bundle に Tour コードが含まれない。

### 7.3 react-confetti の dynamic import

```tsx
const Confetti = dynamic(() => import('react-confetti'), { ssr: false });

// Step 4 でのみ render
{showConfetti && <Confetti ... />}
```

---

## 8. レンダリング最適化

### 8.1 React.memo

```tsx
export const TourBubble = React.memo(function TourBubble(props: TourBubbleProps) {
  // ...
}, (prev, next) => {
  return prev.targetTestId === next.targetTestId
    && prev.bubble.body === next.bubble.body
    && prev.bubble.title === next.bubble.title;
});
```

target が変わらない限り re-render しない。

### 8.2 useMemo for personalize

```tsx
const personalizedBody = useMemo(
  () => personalize(bodyTemplate, { nickname, target_kcal, percent }),
  [bodyTemplate, nickname, target_kcal, percent]
);
```

### 8.3 useCallback for handlers

```tsx
const handleNext = useCallback(() => {
  setSubStep(getNextSubStep(subStep));
}, [subStep]);
```

---

## 9. データフェッチ最適化

### 9.1 GET /api/badges 並列化

Step 3 で /api/badges を呼ぶ際、Tour Layout で **prefetch** しておく:

```tsx
// src/app/handson-tour/layout.tsx
useEffect(() => {
  // Step 3 で使う badges を prefetch
  fetch('/api/badges').then(/* キャッシュに保存 */);
}, []);
```

→ Step 3 マウント時には既にキャッシュ済 → 即表示。

### 9.2 並列 API call

Step 4 卒業 API + Analytics event は並列:

```ts
const [completeResult, _] = await Promise.all([
  fetch('/api/handson-tour/complete', { method: 'POST', ... }),
  fireAnalytics('handson_tour_completed', { ... }),
]);
```

---

## 10. CI でのパフォーマンス監視

### 10.1 Lighthouse CI

```yaml
# .github/workflows/lighthouse.yml
name: Lighthouse Performance
on: pull_request
jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: |
          npx lighthouse https://preview.homegohan.app/handson-tour \
            --output html --output-path ./lighthouse-tour.html \
            --chrome-flags="--headless"
      - uses: actions/upload-artifact@v4
        with:
          name: lighthouse-tour
          path: lighthouse-tour.html
      - run: |
          # Performance Score < 90 で fail
          score=$(jq -r '.categories.performance.score' lighthouse-tour.json)
          [ $(echo "$score < 0.9" | bc -l) -eq 1 ] && exit 1 || exit 0
```

### 10.2 mobile FPS 監視

`tests/perf/handson-tour-fps.test.ts`:

```ts
import { useFrameCallback } from 'react-native-reanimated';

test('Step 4 紙吹雪 60fps 維持', async () => {
  const frames: number[] = [];
  // Step 4 を render
  // useFrameCallback で 各 frame の経過時間を記録
  // 平均 16.67ms (= 60fps) を維持
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  expect(avg).toBeLessThan(17);  // < 17ms = 約 60fps
});
```

実機計測は難しいため、シミュレーターで近似値。低スペック端末は手動 QA。

---

## 11. 監視 (operator/07 連携)

### 11.1 Datadog / Sentry ダッシュボード

| メトリクス | 計測値 | 表示 |
|---|---|---|
| status API レイテンシ p95 | (毎リクエスト記録) | グラフ |
| complete API レイテンシ p95 | 同上 | グラフ |
| Tour 完了率 | 完了 / 開始 | 数値 + トレンド |
| Tour 平均所要時間 | total_duration_ms 平均 | 数値 + トレンド |
| エラー率 | step_error / step_viewed | 数値 + アラート閾値 |

### 11.2 アラート

- complete API p95 > 1s で 5 分継続 → Slack #app-alerts
- エラー率 > 5% で 10 分継続 → 同上
- Tour 完了率 < 60% で 1 日継続 → 同上

---

## 12. 容量・データベース

### 12.1 sandbox 行の容量見積もり

- 1 行 ~500 bytes (meals)
- 新規ユーザー 1 人につき Step 1+Step 2 で 2 行 (total 1KB)
- 月 1000 新規ユーザー → 1MB / 月

→ DB 容量影響は軽微。

### 12.2 sandbox 行の長期保存

- v1 では削除しない (データ整合性、バッジ判定のため)
- v2 で sandbox 行のクリーンアップ (90 日経過後削除等) を検討

---

## 13. テストケース (パフォーマンス)

### 13.1 Lighthouse CI
- `/handson-tour` で Performance Score > 90
- LCP < 2.5s

### 13.2 API レイテンシ
- 各 API の p95 を計測 (load test or 本番 metrics)

### 13.3 mobile FPS
- Step 4 紙吹雪 60fps (シミュレーター)
- 実機 (iPhone 14, Pixel 7) で手動 QA

---

## 14. 残不確実性 (§99 連携)

- [ ] webp 採用範囲 (古いブラウザ Safari 13 以下は jpg fallback)
- [ ] mobile sample-meal.jpg を Asset.fromModule 経由でロードする方法
- [ ] Step 4 紙吹雪 300 paritcle で低スペック Android (Pixel 4a 等) で 60fps 維持できるか
- [ ] Lighthouse CI を PR 必須にするか (= performance regression を blocking にするか)
- [ ] 状態 API キャッシュ 5 分が適切か (= 完了直後に他端末で再ログインしても 5 分間古い状態が出る)
