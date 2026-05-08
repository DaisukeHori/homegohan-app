# 20 — ロギング・観測

> 関連: [22-analytics](./22-analytics.md) / [18-performance](./18-performance.md) / [19-rollout](./19-rollout.md) / operator/07-audit-monitoring (canonical)

---

## 1. 観測対象

| カテゴリ | 内容 | ツール |
|---|---|---|
| アプリログ (server) | API ハンドラの info / warn / error | Datadog or LogTail |
| クラッシュレポート (mobile) | RN クラッシュ + breadcrumb | Sentry / Bugsnag |
| エラー監視 (web) | JS エラー | Sentry |
| Analytics | ユーザー行動イベント | PostHog or Mixpanel |
| パフォーマンス | API レイテンシ + Web Vitals | Datadog APM / Sentry Performance |
| 監査ログ (audit_logs) | 重要操作の追跡 | Supabase / 内部 audit_logs テーブル |
| アラート | Slack 通知 | Slack #app-alerts |

---

## 2. Server logs

### 2.1 ログレベル

| level | 用途 |
|---|---|
| info | 正常な API 呼び出し (PII なし) |
| warn | 不正検出 (sandbox=true 偽装試行など) |
| error | 5xx エラー、DB エラー、unexpected 例外 |

### 2.2 ログ項目 (構造化)

```ts
logger.info({
  event: 'handson_tour.complete.success',
  user_id: userId,        // UUID のみ
  duration_ms: 350,
  already_completed: false,
  trace_id: traceId,
});
```

PII (nickname, weight, etc) は含めない。user_id は UUID なので OK。

### 2.3 ログ event 名

| event | level | 出すタイミング |
|---|---|---|
| `handson_tour.status.success` | info | status API 成功 |
| `handson_tour.complete.success` | info | complete API 成功 |
| `handson_tour.complete.already_completed` | info | force=1 で再実行 |
| `handson_tour.skip.success` | info | skip API 成功 |
| `handson_tour.sandbox_meal.success` | info | sandbox=true で meal_log INSERT |
| `handson_tour.sandbox_menu.success` | info | sandbox=true で weekly_menu INSERT |
| `handson_tour.sandbox.eligibility_violation` | warn | sandbox=true 偽装試行 (admin role 等) |
| `handson_tour.complete.failure` | error | complete API 失敗 (DB 等) |
| `handson_tour.badge_award.failure` | error | バッジ INSERT 失敗 |
| `handson_tour.unique_constraint_skip` | info | 中断後の二重 INSERT 防止 (unique violation) |

### 2.4 サンプル log

```json
{
  "timestamp": "2026-05-08T10:31:30.123Z",
  "level": "info",
  "service": "homegohan-web-api",
  "event": "handson_tour.complete.success",
  "user_id": "a1b2c3d4-...",
  "trace_id": "abc123",
  "duration_ms": 350,
  "badge_awarded": "tutorial_complete",
  "already_completed": false,
  "platform": "web"
}
```

```json
{
  "timestamp": "2026-05-08T10:35:00.000Z",
  "level": "warn",
  "service": "homegohan-web-api",
  "event": "handson_tour.sandbox.eligibility_violation",
  "user_id": "x9y8z7w6-...",
  "reason": "admin_role",
  "endpoint": "/api/meal-plans/add-from-photo",
  "trace_id": "def456"
}
```

---

## 3. クラッシュレポート (mobile)

### 3.1 Sentry breadcrumb

```ts
import * as Sentry from '@sentry/react-native';

// Step 進入時
Sentry.addBreadcrumb({
  category: 'handson_tour',
  message: `Entered step ${step}`,
  data: { step, sub_step: subStep },
  level: 'info',
});

// エラー発生時
Sentry.captureException(error, {
  tags: {
    feature: 'handson_tour',
    step: String(step),
  },
  extra: { sub_step: subStep, error_code: error.code },
});
```

### 3.2 PII 取り扱い
- user.id は UUID のみ
- nickname / email は **設定しない**
- session token / JWT は **絶対に送らない**

```ts
Sentry.setUser({
  id: userId,  // UUID
  // username は設定しない
  // email は設定しない
});
```

### 3.3 リプレイ機能 (将来)
- Sentry Session Replay でユーザーセッションを再現
- ハンズオン中の挙動を分析
- v2 で導入検討 (PII redaction 必須)

---

## 4. エラー監視 (web)

### 4.1 Sentry 統合

```ts
// src/lib/sentry.ts
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend(event) {
    // PII redaction
    if (event.user) delete event.user.email;
    return event;
  },
});
```

### 4.2 ハンズオン特有のエラー

```ts
import * as Sentry from '@sentry/react';

try {
  await fetch('/api/handson-tour/complete', { ... });
} catch (err) {
  Sentry.captureException(err, {
    tags: { feature: 'handson_tour', step: '4' },
    extra: { sub_step: '4.0' },
  });
  setError(err);
}
```

---

## 5. Analytics events (PostHog / Mixpanel)

### 5.1 イベント発火 (§22-analytics.md で完全仕様)

```ts
import { posthog } from '@/lib/posthog';

posthog.capture('handson_tour_started', {
  entry_source: 'auto',
  platform: 'web',
  app_version: '1.2.3',
});

posthog.capture('handson_tour_step_completed', {
  step: 1,
  dwell_ms: 12500,
});

posthog.capture('handson_tour_completed', {
  total_duration_ms: 87500,
  step_skipped_count: 0,
});
```

### 5.2 PII 取り扱い
- user_id (UUID) のみ identify
- 個別属性 (nickname, weight, age) は送らない

```ts
posthog.identify(userId, {
  // distinct user attributes (cohort 用、PII でない)
  signup_at: '2026-05-01',
  platform: 'web',
});
// 注: PII (email, nickname, weight) は送らない
```

### 5.3 cohort 分析

完了 vs スキップ群の継続率比較 (§17 §4 の SQL):

```sql
WITH cohort AS (
  SELECT user_id,
    COALESCE(MIN(timestamp) FILTER (WHERE event_name='handson_tour_completed'), 'epoch'::timestamp) AS completed_at,
    COALESCE(MIN(timestamp) FILTER (WHERE event_name='handson_tour_skipped'), 'epoch'::timestamp) AS skipped_at
  FROM events
  GROUP BY user_id
)
SELECT
  CASE WHEN c.completed_at > 'epoch' THEN 'completed' ELSE 'skipped' END AS group_,
  COUNT(*) AS users,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM meals ml
    WHERE ml.user_id = c.user_id
    AND ml.eaten_at BETWEEN c.completed_at + INTERVAL '6 days' AND c.completed_at + INTERVAL '7 days'
    AND ml.is_sandbox = false
  )) AS retained_7d,
  ROUND(100.0 * COUNT(*) FILTER (WHERE /* same */) / COUNT(*), 2) AS retention_rate
FROM cohort c GROUP BY group_;
```

---

## 6. パフォーマンス監視

### 6.1 Datadog APM

```ts
// API ハンドラに trace 追加
import { tracer } from 'dd-trace';

export async function POST(req: Request) {
  const span = tracer.scope().active();
  span?.setTag('handson_tour.endpoint', 'complete');
  span?.setTag('handson_tour.user_id', userId);
  // ...
}
```

### 6.2 Web Vitals

```ts
// src/lib/webVitals.ts
import { getCLS, getFID, getLCP } from 'web-vitals';

getCLS((metric) => posthog.capture('web_vitals_cls', { value: metric.value, page: '/handson-tour' }));
getLCP((metric) => posthog.capture('web_vitals_lcp', { value: metric.value, page: '/handson-tour' }));
getFID((metric) => posthog.capture('web_vitals_fid', { value: metric.value, page: '/handson-tour' }));
```

---

## 7. 監査ログ (audit_logs)

### 7.1 audit_logs テーブル

cross/01 既存スキーマ:

```sql
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  event_name text NOT NULL,
  properties jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz DEFAULT now()
);
```

### 7.2 ハンズオン関連の記録イベント

| event_name | 記録対象 |
|---|---|
| `handson_tour.completed_server` | complete API 成功 |
| `handson_tour.skipped_server` | skip API 成功 |
| `handson_tour.eligibility_check` | status API レスポンス |
| `handson_tour.sandbox_meal_inserted` | sandbox=true で meal_log 挿入 |
| `handson_tour.sandbox_menu_inserted` | sandbox=true で weekly_menu 挿入 |
| `handson_tour.sandbox_violation_attempt` | 偽装試行 |
| `handson_tour.force_replay_attempt` | force=1 で再実行 |

### 7.3 audit_log 出力 (擬似)

```ts
// src/lib/audit.ts
async function audit(userId: string, event: string, properties: object) {
  await supabase.from('audit_logs').insert({
    user_id: userId,
    event_name: event,
    properties,
    ip_address: getClientIp(req),
    user_agent: req.headers.get('user-agent'),
  });
}

// 使用例
await audit(userId, 'handson_tour.completed_server', {
  duration_ms: 350,
  badge_awarded: 'tutorial_complete',
});
```

### 7.4 audit_logs の保持期間

- 90 日 (cross/07-dr-backup 既定)
- 90 日経過 → 自動 archive (S3)
- 永続: バッジ獲得時刻だけは user_badges に確定保存 (audit と二重保存)

---

## 8. アラート設計

### 8.1 アラート閾値

| メトリクス | 閾値 | 重大度 | チャネル |
|---|---|---|---|
| 完了率 | < 60% (1 日) | warn | Slack #app-alerts |
| 完了率 | < 40% (1 日) | critical | Slack + on-call |
| エラー率 | > 5% (10 分) | warn | Slack |
| エラー率 | > 10% (10 分) | critical | Slack + on-call |
| complete API p95 | > 1s (5 分) | warn | Slack |
| complete API p95 | > 3s (5 分) | critical | Slack + on-call |
| sandbox_violation_attempt | > 5 件/h (= 偽装攻撃疑い) | warn | Slack #security-alerts |
| force_replay 異常 | > 50 件/day | info | Slack |

### 8.2 アラート例 (Slack message)

```
:warning: [Handson Tour] 完了率が低下
- 過去 1 時間の完了率: 55%
- 通常 80% に対して -25pp
- 期間: 2026-05-08 14:00-15:00
- ダッシュボード: https://datadog.com/dashboards/handson-tour
- 対応: @oncall
```

### 8.3 alerting tool

- Datadog Monitors
- PagerDuty / on-call スケジュール
- Slack incomming webhook

---

## 9. Dashboards

### 9.1 主要ダッシュボード

#### Looker Studio / Metabase
- **Tour Funnel**: Step 0 → 4 の通過率
- **Daily Completion**: 日次完了数 + 開始数 + 完了率
- **Latency**: API p50/p95/p99 (時系列)
- **Error Rate**: エラー率 (時系列)
- **Cohort Analysis**: 完了 vs スキップ群の 7/14 日継続率

#### Sentry
- Issues: 直近 24h のエラー一覧
- Performance: 各 API のレイテンシ trends

#### PostHog
- Insights: ハンズオン関連の event funnel + cohort analysis

---

## 10. ログ保持・コンプライアンス

### 10.1 保持期間

| データ | 保持期間 | 理由 |
|---|---|---|
| Server logs | 30 日 | デバッグ |
| Sentry | 90 日 | エラー追跡 |
| Analytics events (PostHog) | 1 年 | KPI トレンド |
| audit_logs | 90 日 → archive | 監査 |

### 10.2 GDPR 対応

- ユーザー削除リクエスト → audit_logs / events から user_id を匿名化 (UUID → null)
- export リクエスト → 該当 user_id の events を JSON で出力

cross/08-legal-compliance §gdpr で定義された手順に従う。

---

## 11. テストケース (observability)

### 11.1 ログ出力確認
- complete API 成功 → `handson_tour.complete.success` ログ出力
- sandbox 偽装 → `handson_tour.sandbox.eligibility_violation` ログ出力 (warn level)

### 11.2 Sentry breadcrumb
- ハンズオン進行中の breadcrumb が Sentry に記録される

### 11.3 PII フィルタ
- ログ output で nickname / email / phone / weight が含まれていないこと

```ts
it('Logs do not contain PII', async () => {
  const logs = await captureLogsForOperation(() => completeHandsonTour(userId));
  for (const log of logs) {
    expect(log).not.toContain(profile.nickname);
    expect(log).not.toContain(profile.email);
  }
});
```

### 11.4 アラート発火
- 完了率を < 60% にして 1 日経過 → Slack 通知 (テストモード)

---

## 12. on-call 対応

### 12.1 オンコール責任者
- 各週ローテーション (Slack /oncall)

### 12.2 ハンズオン関連の対応 runbook

operator/09-runbook.md に追記:

#### 完了率低下時
1. Sentry / PostHog でエラー確認
2. Step ごとの離脱率を funnel で見る
3. 低い step をユーザーが詰まっている → UI バグの可能性
4. hotfix or rollback

#### sandbox 偽装攻撃検出時
1. `audit_logs` で攻撃元 user_id を特定
2. 該当 user の rate limit 強化
3. 攻撃 IP を block (Cloudflare WAF)
4. インシデント記録

---

## 13. 残不確実性 (§99 連携)

- [ ] PostHog vs Mixpanel どちらを採用 (operator/07 で確定が必要)
- [ ] Datadog APM のサンプリングレート (10% で十分か)
- [ ] Sentry の Session Replay を v1 で導入するか (PII redaction の手間)
- [ ] audit_logs に書く頻度 (毎リクエスト → DB 負荷増、必要最小限に絞る)
- [ ] alerting tool (PagerDuty を使うか、Slack のみで足りるか)
- [ ] GDPR 対応の人手対応 vs 自動化 (現状は手動)
