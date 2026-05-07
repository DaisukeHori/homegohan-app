# 22 — Analytics イベント完全仕様

> 関連: [20-observability](./20-observability.md) / operator/07-audit-monitoring (canonical)

---

## 1. イベント一覧

| event_name | 発火タイミング | カテゴリ |
|---|---|---|
| `handson_tour_eligible` | status API 結果 should_show=true | trigger |
| `handson_tour_started` | Step 0 で【はじめる】タップ | progression |
| `handson_tour_step_viewed` | 各ステップマウント | progression |
| `handson_tour_step_completed` | 各ステップ進む | progression |
| `handson_tour_skipped` | スキップ動作 (任意 step) | progression |
| `handson_tour_completed` | Step 4 卒業 API 成功 | completion |
| `handson_tour_step_error` | API エラー / mock 失敗 | error |
| `handson_tour_force_replayed` | force=1 で再表示 | re-engagement |
| `web_vitals_lcp` | Web Vitals (web のみ) | performance |
| `web_vitals_cls` | 同上 | performance |
| `web_vitals_fid` | 同上 | performance |

---

## 2. 完全 schema (Zod)

### 2.1 配置場所

```
packages/handson-tour-shared/src/analytics.ts
```

### 2.2 共通 properties

```ts
import { z } from 'zod';

// すべての event に含む共通フィールド
const CommonPropertiesSchema = z.object({
  user_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  platform: z.enum(['web', 'ios', 'android']),
  app_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  session_id: z.string().uuid().optional(),
  trace_id: z.string().optional(),
});
```

### 2.3 各 event schema

```ts
export const HandsonTourEventSchemas = {
  // ====== trigger ======
  handson_tour_eligible: CommonPropertiesSchema.extend({
    entry_source: z.enum(['auto', 'settings_force']),
  }),

  // ====== progression ======
  handson_tour_started: CommonPropertiesSchema.extend({
    entry_source: z.enum(['auto', 'settings_force']),
  }),

  handson_tour_step_viewed: CommonPropertiesSchema.extend({
    step: z.number().int().min(0).max(5),
    sub_step: z.string().optional(),  // 例 "1.5"
  }),

  handson_tour_step_completed: CommonPropertiesSchema.extend({
    step: z.number().int().min(0).max(5),
    dwell_ms: z.number().int().nonnegative(),
  }),

  handson_tour_skipped: CommonPropertiesSchema.extend({
    step: z.number().int().min(-1).max(4),  // -1 = admin_role / existing_user の auto-skip
    reason: z.enum([
      'user_action',        // 【あとで】タップ
      'hard_back',          // ハードバック
      'admin_role',         // ロール除外
      'existing_user',      // 既存ユーザー auto-skip
      'feature_disabled',   // feature flag OFF
      'not_in_rollout',     // rollout 対象外
    ]),
  }),

  // ====== completion ======
  handson_tour_completed: CommonPropertiesSchema.extend({
    total_duration_ms: z.number().int().nonnegative(),
    step_skipped_count: z.number().int().min(0).max(4),  // 中断なしなら 0
    badge_awarded: z.literal('tutorial_complete'),
    already_completed: z.boolean(),
  }),

  // ====== error ======
  handson_tour_step_error: CommonPropertiesSchema.extend({
    step: z.number().int().min(0).max(5),
    sub_step: z.string().optional(),
    error_code: z.string(),  // 'api_500', 'network_timeout', 'validation_fail', 'sandbox_not_eligible' 等
    error_message: z.string().max(500),  // PII 含まない
    http_status: z.number().int().optional(),
  }),

  // ====== re-engagement ======
  handson_tour_force_replayed: CommonPropertiesSchema.extend({
    /** 過去の completed_at */
    previous_completed_at: z.string().datetime().nullable(),
  }),

  // ====== performance ======
  web_vitals_lcp: CommonPropertiesSchema.extend({
    value_ms: z.number(),
    page: z.string(),  // '/handson-tour', '/handson-tour/photo' 等
  }),

  web_vitals_cls: CommonPropertiesSchema.extend({
    value: z.number(),
    page: z.string(),
  }),

  web_vitals_fid: CommonPropertiesSchema.extend({
    value_ms: z.number(),
    page: z.string(),
  }),
};

// 型エクスポート
export type HandsonTourEventName = keyof typeof HandsonTourEventSchemas;

export type HandsonTourEventPayload<T extends HandsonTourEventName> =
  z.infer<typeof HandsonTourEventSchemas[T]>;
```

---

## 3. 発火タイミング詳細

### 3.1 `handson_tour_eligible`

`/api/handson-tour/status` が `should_show: true` を返したとき。

```ts
// クライアント側
const status = await fetch('/api/handson-tour/status').then(r => r.json());
if (status.should_show) {
  fireAnalytics('handson_tour_eligible', {
    entry_source: 'auto' as const,
  });
}
```

### 3.2 `handson_tour_started`

Step 0 で【はじめる】タップ時。

```ts
const handleStart = () => {
  fireAnalytics('handson_tour_started', {
    entry_source: entrySource,  // 'auto' or 'settings_force'
  });
  // ...
};
```

### 3.3 `handson_tour_step_viewed`

各ステップ (0/1/2/3/4) のマウント時。複数 sub-step ある場合は親 step のみ発火 (sub_step は任意フィールド)。

```ts
useEffect(() => {
  fireAnalytics('handson_tour_step_viewed', {
    step: currentStep,
    sub_step: undefined,
  });
}, [currentStep]);
```

### 3.4 `handson_tour_step_completed`

各ステップ完了時 (= 次のステップへ進むとき)。

```ts
const handleAdvance = () => {
  const dwellMs = Date.now() - mountTime.current;
  fireAnalytics('handson_tour_step_completed', {
    step: currentStep,
    dwell_ms: dwellMs,
  });
  // 次のステップへ
};
```

### 3.5 `handson_tour_skipped`

スキップ時。step -1 = auto-skip (status API 内で発火、admin_role / existing_user / feature_disabled / not_in_rollout)。

```ts
// 明示スキップ
fireAnalytics('handson_tour_skipped', {
  step: currentStep,
  reason: 'user_action',
});

// auto-skip (サーバー側、status API)
fireAnalytics('handson_tour_skipped', {
  step: -1,
  reason: 'admin_role',
});
```

### 3.6 `handson_tour_completed`

Step 4 卒業 API 成功時。

```ts
const tourStartTimestamp = parseInt(sessionStorage.getItem('tourStartTimestamp') ?? '0', 10);
fireAnalytics('handson_tour_completed', {
  total_duration_ms: Date.now() - tourStartTimestamp,
  step_skipped_count: 0,  // 中断なしなら 0
  badge_awarded: 'tutorial_complete',
  already_completed: data.already_completed,
});
```

### 3.7 `handson_tour_step_error`

各 step のエラー (API failure / mock 失敗 / 想定外状態)。

```ts
try {
  await fetch('/api/handson-tour/complete', { ... });
} catch (err) {
  fireAnalytics('handson_tour_step_error', {
    step: 4,
    error_code: err.code ?? 'unknown',
    error_message: err.message?.slice(0, 500) ?? '',
    http_status: err.status,
  });
}
```

### 3.8 `handson_tour_force_replayed`

`/handson-tour?force=1` で表示されたとき。

```ts
useEffect(() => {
  if (entrySource === 'settings_force') {
    fireAnalytics('handson_tour_force_replayed', {
      previous_completed_at: status.completed_at,
    });
  }
}, []);
```

### 3.9 Web Vitals

cross/06-perf-cache 既存パターン。各 Vitals を取得して発火。

```ts
import { onLCP, onCLS, onFID } from 'web-vitals';

onLCP((metric) => fireAnalytics('web_vitals_lcp', {
  value_ms: metric.value,
  page: location.pathname,
}));
```

---

## 4. PostHog 配信実装

### 4.1 SDK 初期化

```ts
// src/lib/posthog.ts
import posthog from 'posthog-js';

if (typeof window !== 'undefined') {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    person_profiles: 'identified_only',
    autocapture: false,  // 手動 capture のみ
    capture_pageview: false,  // 手動制御
    persistence: 'localStorage',
    sanitize_properties: (props) => {
      // PII フィルタ
      delete props.nickname;
      delete props.email;
      delete props.weight_kg;
      return props;
    },
  });
}
export { posthog };
```

### 4.2 fireAnalytics ラッパー

```ts
// packages/handson-tour-shared/src/analytics.ts
import { posthog } from '@/lib/posthog';
import { HandsonTourEventSchemas } from './schemas';

export function fireAnalytics<T extends HandsonTourEventName>(
  eventName: T,
  payload: HandsonTourEventPayload<T>
) {
  // schema validation (dev only)
  if (process.env.NODE_ENV === 'development') {
    HandsonTourEventSchemas[eventName].parse(payload);
  }
  posthog.capture(eventName, payload);
}
```

### 4.3 user identify

```ts
// 認証後
posthog.identify(userId, {
  // 個人属性 (cohort 用、PII でない)
  signup_at: profile.created_at,
  platform: 'web',
});
// 注: nickname / email / weight 等の PII は **設定しない**
```

### 4.4 mobile 配信

PostHog React Native SDK:

```ts
// apps/mobile/src/lib/posthog.ts
import PostHog from 'posthog-react-native';

const posthog = await PostHog.initAsync(EXPO_PUBLIC_POSTHOG_KEY, {
  host: EXPO_PUBLIC_POSTHOG_HOST,
  captureNativeAppLifecycleEvents: true,
});
```

mobile/web 共通の `fireAnalytics` インターフェース。

---

## 5. KPI 集計クエリ

### 5.1 開始率

```sql
WITH cohort AS (
  SELECT user_id FROM users
  WHERE created_at >= now() - INTERVAL '30 days'
)
SELECT
  COUNT(DISTINCT c.user_id) AS signed_up,
  COUNT(DISTINCT e.user_id) FILTER (WHERE e.event_name = 'handson_tour_started') AS started,
  ROUND(100.0 * COUNT(DISTINCT e.user_id) FILTER (WHERE e.event_name = 'handson_tour_started')
        / NULLIF(COUNT(DISTINCT c.user_id), 0), 2) AS start_rate
FROM cohort c
LEFT JOIN events e ON e.user_id = c.user_id;
```

### 5.2 完了率

```sql
SELECT
  COUNT(*) FILTER (WHERE event_name = 'handson_tour_started') AS started,
  COUNT(*) FILTER (WHERE event_name = 'handson_tour_completed') AS completed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE event_name = 'handson_tour_completed')
        / NULLIF(COUNT(*) FILTER (WHERE event_name = 'handson_tour_started'), 0), 2) AS completion_rate
FROM events
WHERE event_name IN ('handson_tour_started','handson_tour_completed')
  AND timestamp >= now() - INTERVAL '7 days';
```

### 5.3 各ステップの離脱率 (漏斗)

```sql
WITH funnel AS (
  SELECT
    user_id,
    MAX(CASE WHEN event_name = 'handson_tour_step_viewed' AND (properties->>'step')::int = 0 THEN 1 ELSE 0 END) AS viewed_0,
    MAX(CASE WHEN event_name = 'handson_tour_step_viewed' AND (properties->>'step')::int = 1 THEN 1 ELSE 0 END) AS viewed_1,
    MAX(CASE WHEN event_name = 'handson_tour_step_viewed' AND (properties->>'step')::int = 2 THEN 1 ELSE 0 END) AS viewed_2,
    MAX(CASE WHEN event_name = 'handson_tour_step_viewed' AND (properties->>'step')::int = 3 THEN 1 ELSE 0 END) AS viewed_3,
    MAX(CASE WHEN event_name = 'handson_tour_step_viewed' AND (properties->>'step')::int = 4 THEN 1 ELSE 0 END) AS viewed_4,
    MAX(CASE WHEN event_name = 'handson_tour_completed' THEN 1 ELSE 0 END) AS completed
  FROM events
  WHERE event_name IN ('handson_tour_step_viewed', 'handson_tour_completed')
    AND timestamp >= now() - INTERVAL '7 days'
  GROUP BY user_id
)
SELECT
  SUM(viewed_0) AS step0,
  SUM(viewed_1) AS step1,
  SUM(viewed_2) AS step2,
  SUM(viewed_3) AS step3,
  SUM(viewed_4) AS step4,
  SUM(completed) AS completed
FROM funnel;
```

### 5.4 完了 vs スキップ群の継続率

```sql
WITH cohort AS (
  SELECT
    user_id,
    MIN(timestamp) FILTER (WHERE event_name = 'handson_tour_completed') AS completed_at,
    MIN(timestamp) FILTER (WHERE event_name = 'handson_tour_skipped') AS skipped_at
  FROM events
  WHERE event_name IN ('handson_tour_completed', 'handson_tour_skipped')
    AND timestamp >= now() - INTERVAL '30 days'
  GROUP BY user_id
), retention AS (
  SELECT c.user_id,
    CASE WHEN c.completed_at IS NOT NULL THEN 'completed' ELSE 'skipped' END AS group_,
    EXISTS (
      SELECT 1 FROM meal_logs ml
      WHERE ml.user_id = c.user_id
        AND ml.eaten_at BETWEEN COALESCE(c.completed_at, c.skipped_at) + INTERVAL '6 days'
                            AND COALESCE(c.completed_at, c.skipped_at) + INTERVAL '7 days'
        AND ml.is_sandbox = false
    ) AS active_7d
  FROM cohort c
)
SELECT
  group_,
  COUNT(*) AS users,
  COUNT(*) FILTER (WHERE active_7d) AS retained,
  ROUND(100.0 * COUNT(*) FILTER (WHERE active_7d) / COUNT(*), 2) AS rate
FROM retention
GROUP BY group_;
```

### 5.5 平均所要時間

```sql
SELECT
  AVG((properties->>'total_duration_ms')::int) AS avg_ms,
  PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY (properties->>'total_duration_ms')::int) AS median_ms,
  PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY (properties->>'total_duration_ms')::int) AS p95_ms
FROM events
WHERE event_name = 'handson_tour_completed'
  AND timestamp >= now() - INTERVAL '7 days';
```

### 5.6 エラー率

```sql
SELECT
  (properties->>'step')::int AS step,
  COUNT(*) AS errors,
  COUNT(DISTINCT user_id) AS affected_users
FROM events
WHERE event_name = 'handson_tour_step_error'
  AND timestamp >= now() - INTERVAL '24 hours'
GROUP BY step
ORDER BY step;
```

---

## 6. ダッシュボード仕様

### 6.1 メインダッシュボード (Looker Studio)

| ウィジェット | 内容 |
|---|---|
| KPI 数値: 開始率 | §5.1 SQL |
| KPI 数値: 完了率 | §5.2 SQL |
| KPI 数値: 平均所要時間 | §5.5 SQL |
| 漏斗グラフ: Step 0 → 4 | §5.3 SQL |
| 折れ線: 日次完了数 (過去 30 日) | 集計 SQL |
| 棒グラフ: スキップ理由分布 | reason ごとの count |
| 折れ線: エラー率 (時系列) | 1 時間粒度 |
| 比較棒: 完了 vs スキップ群の 7 日継続率 | §5.4 SQL |
| 折れ線: API レイテンシ p95 (時系列) | OpenTelemetry / APM |

### 6.2 公開タイミング
- Phase 4 (a11y / Analytics) 完了時にダッシュボード作成
- Phase 6 (canary) で本格モニタリング開始

---

## 7. プライバシー (PII フィルタ)

### 7.1 含めない項目

| カテゴリ | 例 |
|---|---|
| 個人識別 | nickname, email, phone, address |
| 身体情報 | weight_kg, height_cm, age, gender |
| 認証情報 | password, JWT, session_token |
| 位置情報 | GPS, IP の precise (粗い region は OK) |
| 健康 | allergies, dietary_preferences, nutrition_goal |

### 7.2 含めて良い項目

| カテゴリ | 例 |
|---|---|
| ID | user_id (UUID), session_id (UUID) |
| 行動 | step, dwell_ms, error_code |
| メタ | platform, app_version, timestamp |
| デバイス | OS バージョン (粗い)、画面解像度 (粗い) |

### 7.3 サニタイズ実装

```ts
// posthog 初期化時 sanitize_properties
sanitize_properties: (props) => {
  const FORBIDDEN_KEYS = [
    'nickname', 'email', 'phone', 'address',
    'weight_kg', 'height_cm', 'age', 'gender',
    'password', 'jwt', 'token',
  ];
  for (const key of FORBIDDEN_KEYS) {
    if (key in props) delete props[key];
  }
  return props;
};
```

---

## 8. テストケース

### 8.1 schema validation

```ts
import { HandsonTourEventSchemas } from '@homegohan/handson-tour-shared';

it('handson_tour_started schema validates', () => {
  const valid = {
    user_id: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
    timestamp: '2026-05-08T10:00:00.000Z',
    platform: 'web',
    app_version: '1.2.3',
    entry_source: 'auto',
  };
  expect(() => HandsonTourEventSchemas.handson_tour_started.parse(valid)).not.toThrow();
});

it('handson_tour_started rejects invalid platform', () => {
  expect(() => HandsonTourEventSchemas.handson_tour_started.parse({
    /* ... */ platform: 'desktop',
  })).toThrow();
});
```

### 8.2 PII フィルタ

```ts
it('PII keys are sanitized', () => {
  const event = sanitize({
    user_id: 'a1b2c3d4-...',
    nickname: '太郎',  // PII
    email: 'taro@example.com',  // PII
    step: 1,
  });
  expect(event).not.toHaveProperty('nickname');
  expect(event).not.toHaveProperty('email');
  expect(event.step).toBe(1);
});
```

### 8.3 配信確認 (mock)

```ts
it('handson_tour_started fires posthog.capture', () => {
  const spy = jest.spyOn(posthog, 'capture');
  fireAnalytics('handson_tour_started', { /* ... */ });
  expect(spy).toHaveBeenCalledWith('handson_tour_started', expect.objectContaining({ entry_source: 'auto' }));
});
```

---

## 9. 残不確実性 (§99 連携)

- [ ] PostHog vs Mixpanel の最終決定 (operator/07 で確定)
- [ ] sub_step の粒度 (1.5 / 1.6 を全部送るか、step のみで十分か)
- [ ] event sampling (低頻度 event は 100% 送信、高頻度 event は 10% 等)
- [ ] PII フィルタの ヌルチェック (nullable な PII フィールドの処理)
- [ ] Analytics 配信失敗時のリトライ (PostHog SDK 内蔵で十分か)
