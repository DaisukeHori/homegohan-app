# PostHog Dashboard セットアップ手順 — family/09 ハンズオンチュートリアル

> 作成: 2026-05-08 (family/09 Phase 4 PostHog dashboard 公開)
> 関連: `docs/design/operator/07-audit-monitoring.md` §15 (analytics events canonical)
> 関連: `docs/design/family/09-onboarding-handson-tour/22-analytics.md` (KPI 集計クエリ例)

---

## 1. 概要

family/09 ハンズオンチュートリアルは PostHog で 11 イベントを計測する。本ドキュメントは PostHog UI 上で以下を構築する手順:

1. **Insight (グラフ) 8 種** — KPI ツリーに対応
2. **Dashboard 1 枚** — 上記 Insight をまとめた共有ボード
3. **Alert** — 完走率低下時の Slack 通知

PostHog プロジェクトは堀さん (admin) が事前作成済の前提。プロジェクト URL は `https://us.posthog.com/project/<PROJECT_ID>` (環境変数 `NEXT_PUBLIC_POSTHOG_KEY` と紐付く)。

---

## 2. 前提: 計測中のイベント (canonical 11 イベント)

operator/07 §15 で定義された 11 イベント。コードからの送信は `posthog-js` (Web) / `posthog-react-native` (Mobile) 経由。

| event 名 | プロパティ | 送信元 |
|---|---|---|
| `handson_tour_shown` | `entry_source` (`auto`/`force`/`settings`) | TourOverlay マウント時 |
| `handson_tour_started` | `entry_source` | Step 0 「はじめる」タップ |
| `handson_tour_step_completed` | `step` (0-4), `dwell_ms` | 各 Step の前進タップ |
| `handson_tour_step_skipped` | `step`, `reason` (`hard_back`/`later_button`/`auto_skip`) | スキップ系操作 |
| `handson_tour_completed` | `total_dwell_ms` | Step 4 卒業画面表示 |
| `handson_tour_skipped` | `step`, `reason` | スキップ完了 |
| `handson_tour_error` | `step`, `error_code`, `error_message` | API/UI エラー時 |
| `handson_tour_replayed` | `replay_count` | force=1 で再表示時 |
| `handson_tour_eligible` | `condition` (A/B/C/D) | should_show 判定時 |
| `handson_tour_ineligible` | `reason` | should_show=false 時 |
| `handson_tour_badge_awarded` | `badge_code`, `is_first_award` | バッジ付与成功時 |

イベント送信が動作確認済か:
1. PostHog UI → Activity → Events → 直近 24h で上記イベントが流れているか確認
2. 流れていない場合は `NEXT_PUBLIC_POSTHOG_KEY` 設定 + `apps/mobile/.env` の同 key を確認

---

## 3. Insight 作成手順 (PostHog UI)

PostHog UI 左サイドバー → Insights → "+ New Insight" から以下を順番に作成。

### 3.1 ハンズオン到達率 (= shown / signup_completed)
- Type: **Trends**
- Series A: Event = `handson_tour_shown`、math = `Total count`
- Series B: Event = `$identify` フィルター `properties.signup_completed_at exists`、math = `Total count`
- Formula: `A / B * 100`
- Time range: Last 30 days
- Display: **Number** (大文字)
- 目標値: ≥ 95%
- Insight name: `Tour Reach Rate`

### 3.2 ハンズオン開始率 (= started / shown)
- Type: Trends + Formula
- A = `handson_tour_started`, B = `handson_tour_shown`
- Formula: `A / B * 100`
- 目標値: ≥ 95% (= スキップ率 5% 以下)
- Insight name: `Tour Start Rate`

### 3.3 ハンズオン完走率 (= completed / started)
- Type: Trends + Formula
- A = `handson_tour_completed`, B = `handson_tour_started`
- Formula: `A / B * 100`
- 目標値: ≥ 80%
- Insight name: `Tour Completion Rate`
- ⚠️ **本指標の Alert を §6 で設定**

### 3.4 各 Step の離脱率 (= step_skipped / step_started)
- Type: **Funnel**
- Steps:
  1. `handson_tour_step_completed` filter `properties.step = 0`
  2. `handson_tour_step_completed` filter `properties.step = 1`
  3. `handson_tour_step_completed` filter `properties.step = 2`
  4. `handson_tour_step_completed` filter `properties.step = 3`
  5. `handson_tour_step_completed` filter `properties.step = 4`
- Display: **Funnel chart**
- 目標: 各ステップ離脱率 ≤ 5%
- Insight name: `Tour Step Funnel`

### 3.5 平均完走時間
- Type: Trends
- Event = `handson_tour_completed`
- Property aggregation: `properties.total_dwell_ms` の **median** と **95th percentile**
- 目標: median < 90,000 (90s)、p95 < 150,000 (150s)
- Insight name: `Tour Completion Time`

### 3.6 完走 vs スキップ群の継続率差 (Cohort)
- Type: **Retention** Insight
- Cohort A: `handson_tour_completed` 発火ユーザー (Last 30 days)
- Cohort B: `handson_tour_skipped` 発火ユーザー (Last 30 days)
- Returning event: 任意の `$pageview` or `meal_logged` 等のアクティビティ
- Period: 1d, 3d, 7d, 14d
- 目標: 7 日 +15pp、14 日 +10pp (完走群 - スキップ群)
- Insight name: `Tour Retention Lift`

### 3.7 エラー率
- Type: Trends + Formula
- A = `handson_tour_error`, B = `handson_tour_shown`
- Formula: `A / B * 100`
- 目標: < 1%
- Insight name: `Tour Error Rate`

### 3.8 バッジ獲得率 (14 日以内)
- Type: Trends + Formula
- A = `handson_tour_badge_awarded` (14 日以内に発火したユニークユーザー)
- B = `handson_tour_started` (14 日前以降に発火したユニークユーザー)
- Formula: `A / B * 100`
- 目標: > 90% (現状 35% から劇的改善期待)
- Insight name: `Badge Award Rate (14d)`

---

## 4. Dashboard 作成手順

PostHog UI → Dashboards → "+ New Dashboard"

### 4.1 設定
- Name: **homegohan / family-09 ハンズオンチュートリアル KPI**
- Description: `family/09 90 秒ハンズオンチュートリアルの主要 KPI 8 指標。詳細は docs/design/family/09-onboarding-handson-tour/00-overview.md §3.1 参照。`
- Tags: `family-09`, `onboarding`, `kpi`

### 4.2 Insight 配置
左から右、上から下の順で 8 Insight を配置。推奨レイアウト (12-col grid):

```
┌──────────────┬──────────────┬──────────────┐
│ 3.1 Reach    │ 3.2 Start    │ 3.3 Compl    │  ← 大文字 (Number)
├──────────────┴──────────────┴──────────────┤
│ 3.4 Step Funnel (full width)                │  ← Funnel
├──────────────────────┬──────────────────────┤
│ 3.5 Completion Time  │ 3.7 Error Rate       │  ← Trends
├──────────────────────┴──────────────────────┤
│ 3.6 Retention Lift (full width)              │  ← Retention
├─────────────────────────────────────────────┤
│ 3.8 Badge Award Rate (full width)            │  ← Trends
└─────────────────────────────────────────────┘
```

### 4.3 共有設定
- 右上 "Share" → "Share dashboard"
- "Anyone with the link can view" を ON
- 生成された URL を `docs/operations/posthog-dashboard.md` 末尾の §8 に貼り付け
- Slack #app-metrics 等にも投下

---

## 5. KPI 通知 / Alert 設定

### 5.1 完走率低下アラート (最重要)
PostHog UI → Insight `3.3 Tour Completion Rate` を開く → 右上 "Alerts" → "+ Add alert"

- Condition: `value < 60`
- Time window: `1 day`
- Notification: Slack channel `#app-alerts` (要 Slack integration、なければ `<TEAM_LEAD_EMAIL>`)
- Frequency: 1 回 / 日まで
- Message: `homegohan ハンズオン完走率が 60% を下回りました。直近の Step Funnel を確認してください。`

### 5.2 エラー率上昇アラート
PostHog UI → Insight `3.7 Tour Error Rate` を開く → "Alerts"

- Condition: `value > 5`
- Time window: `1 hour`
- Notification: 同上 Slack
- Message: `homegohan ハンズオンチュートリアルのエラー率が 5% を超えました。Sentry / app_logs で詳細確認。`

---

## 6. 動作確認チェックリスト

Dashboard を共有する前に:

- [ ] PostHog Activity → Events で 11 イベント全て直近 24h 以内に少なくとも 1 件流れている
- [ ] Insight 3.1〜3.8 が全て描画され、N/A や 0/0 のエラーになっていない
- [ ] Dashboard 上で各 Insight が正しい順序で並んでいる
- [ ] Share URL を別ブラウザ (匿名タブ) で開けて閲覧できる
- [ ] Alert §5.1, §5.2 の Slack 通知テストが届く (PostHog UI で "Send test notification")

---

## 7. トラブルシューティング

### Q. イベントが流れない
1. ブラウザの Network タブで `https://us.i.posthog.com/i/v0/e/?` への POST リクエスト確認
2. Cookie 同意で reject していないか (PostHog SDK は同意取得後に有効化される実装、cross/03-design-system §22 参照)
3. SDK の `posthog.debug(true)` で console ログ確認

### Q. Funnel の数字がおかしい (Step 完了数 > Step 開始数 等)
- イベント送信が画面遷移より早く発火していないか (`handson_tour_step_completed` を Step 完了前に呼んでないか)
- 二重送信していないか (same step を 2 回送信)
- ブラウザ拡張機能 (uBlock 等) が一部イベントだけブロックしていないか

### Q. Retention Lift の数字が出ない
- Cohort A/B の最小ユーザー数が PostHog 仕様で 10 以上必要なケースあり、ロールアウト初期は data 不足で表示されないことがある (1-2 週間後に再確認)

---

## 8. Dashboard 共有 URL

公開後の共有 URL を以下に記載:

```
https://us.posthog.com/shared_dashboard/<TOKEN>
```

(初回作成時に堀さん側で URL を埋めてください。シークレット token を含むので公開リポにそのまま貼って良いか確認してから commit。)

---

## 9. 更新履歴

| 日付 | 担当 | 内容 |
|---|---|---|
| 2026-05-08 | Opus | 初版作成 (family/09 Phase 4 PostHog dashboard セットアップ手順) |
