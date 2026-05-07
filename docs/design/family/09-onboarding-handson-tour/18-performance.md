# 18 — パフォーマンス

> 関連: [07-components](./07-components.md) / [11-testing](./11-testing.md) / [20-observability](./20-observability.md)

---

## 1. パフォーマンス目標値

### 1.1 Web (Lighthouse + Web Vitals)

| 指標 | 目標 | 測定方法 |
|---|---|---|
| Performance Score | > 90 | Lighthouse CI |
| First Contentful Paint (FCP) | < 1.5 s | Web Vitals |
| Largest Contentful Paint (LCP) | < 2.5 s | Web Vitals |
| Cumulative Layout Shift (CLS) | < 0.1 | Web Vitals |
| Total Blocking Time (TBT) | < 200 ms | Lighthouse |
| Time to Interactive (TTI) | < 3.5 s | Lighthouse |
| First Input Delay (FID) | < 100 ms | Web Vitals |
| Interaction to Next Paint (INP) | < 200 ms | Web Vitals (新指標) |

### 1.2 Mobile (Reanimated)

| 指標 | 目標 |
|---|---|
| FPS (アニメーション中) | 60 fps 維持 |
| Spotlight 移動時の jank | 0 dropped frames |
| Step 4 紙吹雪 (300 paritcle) | 60 fps 維持 |
| 起動時から /handson-tour 表示まで | < 1.5 s |

### 1.3 API レイテンシ

| Endpoint | p50 目標 | p95 目標 |
|---|---|---|
| `/api/handson-tour/status` | < 100 ms | < 300 ms |
| `/api/handson-tour/complete` | < 200 ms | < 500 ms |
| `/api/handson-tour/skip` | < 100 ms | < 300 ms |
| `/api/meal-plans/add-from-photo?source=handson_tour` | < 300 ms | < 800 ms |
| `/api/menu-plans/add?source=handson_tour` | < 300 ms | < 800 ms |

---

## 2. ボトルネック分析

### 2.1 想定ボトルネック

| 箇所 | 影響 | 対策 |
|---|---|---|
| Spotlight 用の要素位置計算 (`measureInWindow` / `getBoundingClientRect`) | 100ms 間隔で実行、CPU 負荷 | RAF (requestAnimationFrame) 利用 + ResizeObserver |
| 紙吹雪パーティクル 300 個 | Mobile で fps 低下 | パーティクル数調整 (低スペック端末で 150 個に減) |
| サンプル画像 (1MB+) | 初期 load 遅延 | webp 変換 + 200KB 以下に圧縮 |
| 共通 package のインポート | bundle size 膨張 | tree shaking 確実化 (`sideEffects: false`) |
| Animation Reanimated 多重起動 | mobile fps 低下 | アニメ同時実行 3 つまでに制限 |

### 2.2 計測ポイント

| ポイント | 計測方法 |
|---|---|
| `/handson-tour` ページ load 時間 | Web Vitals (LCP) |
| Spotlight 表示までの時間 | カスタム performance.mark / measure |
| API 応答時間 | OpenTelemetry trace |
| Reanimated FPS | `useFrameCallback` (mobile dev only) |
| Memory 使用量 | Sentry / Bugsnag |

---

## 3. 画像最適化

### 3.1 sample-meal.jpg

#### 3.1.1 元ファイル
- パス: `tests/e2e/fixtures/karaage.jpg`
- 推定サイズ: ~500 KB-1 MB (元写真依存)

#### 3.1.2 配置先 (圧縮後)

| パス | フォーマット | 目標サイズ |
|---|---|---|
| `apps/mobile/assets/handson-tour/sample-meal.jpg` | JPEG | < 200 KB |
| `apps/mobile/assets/handson-tour/sample-meal.webp` | WebP (option) | < 80 KB |
| `public/handson-tour/sample-meal.jpg` | JPEG | < 200 KB |
| `public/handson-tour/sample-meal.webp` | WebP | < 80 KB |

#### 3.1.3 圧縮コマンド (Phase 2)

```bash
# JPEG quality 85
cjpeg -quality 85 -outfile public/handson-tour/sample-meal.jpg tests/e2e/fixtures/karaage.jpg

# WebP quality 85
cwebp -q 85 tests/e2e/fixtures/karaage.jpg -o public/handson-tour/sample-meal.webp

# Mobile assets も同様に
```

または `sharp` package を使ってビルド時に動的圧縮 (Next.js Image component)。

#### 3.1.4 Web での画像配信

```tsx
import Image from 'next/image';

<Image
  src="/handson-tour/sample-meal.jpg"
  alt="唐揚げ定食 (ご飯・味噌汁・キャベツ千切り付き)"
  width={1024}
  height={768}
  priority  // Step 1 で重要、preload
  placeholder="blur"  // base64 placeholder
  blurDataURL="..."
/>
```

`priority` で preload、`placeholder="blur"` で UX 改善。

#### 3.1.5 Mobile での配信

```tsx
import { Image } from 'react-native';

<Image
  source={require('../../../apps/mobile/assets/handson-tour/sample-meal.jpg')}
  style={{ width: 300, height: 225 }}
  accessibilityLabel="唐揚げ定食"
/>
```

Expo の `expo-image` を使う場合:

```tsx
import { Image } from 'expo-image';

<Image
  source={require('...sample-meal.jpg')}
  contentFit="cover"
  cachePolicy="memory-disk"  // キャッシュ
/>
```

### 3.2 Step 1 表示前の preload

Step 0 マウント時に Step 1 で使う画像を preload:

```ts
// Step 0 useEffect
useEffect(() => {
  if (typeof window !== 'undefined') {
    const img = new window.Image();
    img.src = '/handson-tour/sample-meal.jpg';
  }
  // mobile
  Image.prefetch(require('../assets/handson-tour/sample-meal.jpg'));
}, []);
```

これで Step 1 到達時には既にキャッシュされており、即時表示。

---

## 4. Bundle サイズ管理

### 4.1 共通 package のサイズ

`packages/handson-tour-shared/` の bundle 影響:

| 項目 | 想定サイズ (gzipped) |
|---|---|
| types.ts (typescript only、bundle に出ない) | 0 KB |
| mocks.ts | ~2 KB |
| analytics.ts (Zod schema) | ~3 KB |
| i18n.ts (81 keys) | ~5 KB |
| personalize.ts | ~1 KB |
| その他 | ~2 KB |

合計: ~13 KB gzipped (許容範囲)

### 4.2 tree shaking

```json
// packages/handson-tour-shared/package.json
{
  "sideEffects": false,
  "main": "./dist/index.js",
  "module": "./dist/index.esm.js",
  "types": "./dist/index.d.ts"
}
```

未使用の export は webpack / rollup で削除される。

### 4.3 動的 import (web)

`/handson-tour/*` ページは別 bundle に分離 (Next.js App Router で自動 code splitting)。
通常 home / settings 利用時にハンズオン関連コードを load しない。

```tsx
// Next.js App Router で自動 split されるが、念のため
const HandsonTourLayout = dynamic(() => import('./layout'), { ssr: false });
```

### 4.4 react-confetti の bundle 影響

| package | gzipped size |
|---|---|
| react-confetti | ~10 KB |

許容範囲。

mobile は自前実装で react-confetti を使わない (= 共通 package に依存させない)。

---

## 5. クライアント側パフォーマンス最適化

### 5.1 Spotlight 計算の頻度

#### 100ms 間隔の妥当性
- 60 fps = 16.6 ms/frame
- 100ms 間隔 = 6 frames に 1 回計算
- ResizeObserver / MutationObserver で trigger された場合は即時計算
- → 実用上は 100ms で十分

```ts
const measureInterval = useMemo(() => {
  return prefersReducedMotion ? 500 : 100;  // reduce-motion なら頻度落とす
}, [prefersReducedMotion]);
```

### 5.2 React 再 render 抑制

```tsx
// useMemo / useCallback で props の変化を最小化
const overlayProps = useMemo(() => ({
  targetTestId,
  bubble: { body: bubbleBody, position: 'auto' },
  primaryAction: { label: '次へ', onPress: handleNext },
}), [targetTestId, bubbleBody, handleNext]);

<HandsonTourOverlay {...overlayProps} />
```

### 5.3 Reanimated worklet

mobile では shared value + worklet で UI thread でアニメーション実行 (JS thread bypass):

```ts
const opacity = useSharedValue(0);
const animatedStyle = useAnimatedStyle(() => ({
  opacity: opacity.value,
}));
```

これで JS thread blocking でもアニメは継続。

### 5.4 紙吹雪のパフォーマンス調整

mobile (低スペック端末対応):

```ts
const particleCount = useMemo(() => {
  // 端末性能を判定 (簡易: bundle 内の deviceMemory 等)
  if (DeviceInfo.getDeviceType() === 'Tablet' || DeviceInfo.getTotalMemory() > 4_000_000_000) {
    return 300;
  }
  return 150;  // 低スペック
}, []);
```

または、Reanimated v3 の `runOnUI` でメインスレッド負荷を最小化。

---

## 6. サーバーサイドパフォーマンス

### 6.1 SQL クエリ最適化

§08-state-db.md の partial index で:

```sql
-- 部分インデックス (pending な user のみ)
CREATE INDEX idx_user_profiles_handson_tour_pending
  ON user_profiles (user_id)
  WHERE handson_tour_completed_at IS NULL AND handson_tour_skipped_at IS NULL;
```

`should_show` 判定の SELECT が高速化 (= pending user のみ index に乗る、typically <1% of total)。

### 6.2 RPC 関数のパフォーマンス

`complete_handson_tour` RPC は:
- UPDATE 1 回 + INSERT 1 回 + SELECT 1 回 = 3 SQL
- TX 内で完結
- p95 < 500 ms (目標)

EXPLAIN ANALYZE で:

```sql
EXPLAIN ANALYZE
WITH updated AS (
  UPDATE user_profiles
  SET handson_tour_completed_at = COALESCE(handson_tour_completed_at, now())
  WHERE user_id = '...'
  RETURNING handson_tour_completed_at
), inserted AS (
  INSERT INTO user_badges ... ON CONFLICT DO NOTHING RETURNING ...
)
SELECT * FROM updated, inserted;
```

PRIMARY KEY index 利用で sub-millisecond で完了するはず。

### 6.3 Connection pooling

Supabase の connection pool (PgBouncer) を使う (既存設定)。

API route は serverless (Vercel Edge or Node Lambda) で多重接続が分散される。

### 6.4 キャッシュ

`/api/handson-tour/status` は user 単位で頻繁に呼ばれる可能性 (= /home マウントごと)。

#### 6.4.1 キャッシュ戦略

| 戦略 | TTL | 適用 |
|---|---|---|
| memo (ブラウザ tab 単位) | 60 s | クライアント側 fetch cache |
| Redis user cache | 300 s | サーバー側 (Upstash) |
| CDN edge cache | なし | user-specific のため適用不可 |

#### 6.4.2 実装

```ts
// クライアント側 SWR / React Query で 60s stale time
const { data: status } = useSWR('/api/handson-tour/status', fetcher, {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
});
```

```ts
// サーバー側 Redis cache
const cached = await redis.get(`handson-tour-status:${userId}`);
if (cached) return cached;
const result = await computeStatus(userId);
await redis.set(`handson-tour-status:${userId}`, result, { ex: 300 });
return result;
```

### 6.5 cache invalidation

ユーザーが `complete` / `skip` API を呼んだ時、Redis cache を invalidate:

```ts
await redis.del(`handson-tour-status:${userId}`);
```

---

## 7. ネットワーク最適化

### 7.1 HTTP/2 / HTTP/3
- Vercel + Cloudflare で HTTP/2 / HTTP/3 自動有効
- Mobile は OS 任せ

### 7.2 圧縮
- gzip / br 自動 (Vercel default)
- API レスポンス JSON サイズ < 1 KB (typical)

### 7.3 CDN
- 静的 asset (sample-meal.jpg) は Vercel CDN edge cache
- max-age=31536000 (1 年、長期キャッシュ)

```http
Cache-Control: public, max-age=31536000, immutable
```

---

## 8. パフォーマンステスト

### 8.1 Lighthouse CI

```yaml
# .github/workflows/lighthouse.yml
name: Lighthouse
on:
  pull_request:
    paths: ['src/app/handson-tour/**']
jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: treosh/lighthouse-ci-action@v10
        with:
          urls: |
            https://${VERCEL_PREVIEW_URL}/handson-tour
          uploadArtifacts: true
          temporaryPublicStorage: true
          configPath: ./lighthouserc.json
```

```json
// lighthouserc.json
{
  "ci": {
    "assert": {
      "preset": "lighthouse:recommended",
      "assertions": {
        "categories:performance": ["error", { "minScore": 0.9 }],
        "first-contentful-paint": ["error", { "maxNumericValue": 1500 }],
        "largest-contentful-paint": ["error", { "maxNumericValue": 2500 }]
      }
    }
  }
}
```

### 8.2 Reanimated FPS テスト (mobile)

実機 + Maestro で 60fps 維持を計測:

```yaml
# 13-step4-fps.yaml (Maestro)
appId: com.homegohan.app
---
- runFlow: 08-step4-graduation.yaml  # Step 4 まで
- # 紙吹雪表示中の fps を計測
- assertVisible:
    id: tour-step-4-graduate
- # Maestro fps assertion (要 plugin)
```

または、開発中に React Native Performance Monitor で目視確認。

### 8.3 API レイテンシテスト

```ts
// integration test
it('complete API responds within 500ms p95', async () => {
  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = Date.now();
    await fetch('/api/handson-tour/complete', { method: 'POST', ... });
    times.push(Date.now() - start);
  }
  const p95 = times.sort()[94];
  expect(p95).toBeLessThan(500);
});
```

---

## 9. メモリ使用量

### 9.1 Web (Chrome DevTools Performance Memory)

- 通常状態: ~50 MB
- ハンズオン中: +10 MB (overlay + 紙吹雪)
- Step 4 終了後: 元に戻る (-10 MB)

メモリリーク監視:
- TourProvider unmount で context 破棄
- setTimeout / setInterval cleanup
- Reanimated / Framer Motion アニメーションの完了確認

### 9.2 Mobile (Hermes JS engine)

- Hermes の小さいフットプリント (= ハンズオン追加で +5-10 MB 程度)
- Reanimated worklets は別スレッド、JS heap への影響少

---

## 10. パフォーマンスバジェット

| バジェット | 値 |
|---|---|
| `/handson-tour` ページの JS bundle (gzipped) | < 200 KB |
| ハンズオン関連 image asset 合計 | < 500 KB |
| API レスポンス (各 endpoint) | < 5 KB JSON |
| `/handson-tour` の HTML | < 50 KB |

これを超えたらビルドで warn / fail (webpack-bundle-analyzer 等で検出)。

---

## 11. パフォーマンス監視 (本番)

### 11.1 Real User Monitoring (RUM)

- Web Vitals を Vercel Analytics or Google Analytics に送信
- Mobile は Sentry / Bugsnag の performance tab

### 11.2 alerting

| 条件 | 通知 |
|---|---|
| LCP p75 > 3.0 s | Slack #app-alerts |
| API p95 > 1.0 s | 同上 |
| FPS < 50 (mobile) | 同上 |
| Memory leak 検出 (heap > 100 MB on mobile) | PagerDuty |

---

## 12. 残不確実性 (§99 連携)

- [ ] sample-meal.jpg を Phase 2 で webp 変換するか、JPEG のみでスタートするか
- [ ] react-confetti の bundle 影響が許容範囲か (gzipped < 10 KB と推定)
- [ ] Mobile 低スペック端末で 60fps 維持できるかの実機検証
- [ ] Redis cache の TTL 300s が UX 上問題ないか (status 変更 = signup 完了で max 5 分の遅延)
- [ ] パフォーマンスバジェット 200 KB が現実的か (bundle 計測で確認)
- [ ] Step 0 マウント時の image preload が効いているか (Lighthouse で確認)
