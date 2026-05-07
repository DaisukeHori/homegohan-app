# 19 — ロールアウト計画

> 関連: [12-phases](./12-phases.md) / [20-observability](./20-observability.md)

---

## 1. ロールアウト戦略

段階的公開 (canary → percentage rollout) で、不具合検出時の影響を最小化する。

### 1.1 段階一覧

| Day | 公開対象 | 判断基準 |
|---|---|---|
| Day 1-7 | 社内のみ (`@homegohan.test` ドメイン) | 主要バグ検出 |
| Day 8-13 | 新規 signup の 10% | KPI 目標達成 |
| Day 14-20 | 同 50% | 同上 + パフォーマンス安定 |
| Day 21+ | 100% | 全 KPI 目標達成 |

---

## 2. Feature Flag

### 2.1 フラグ名

| 変数 | 値 | 適用先 |
|---|---|---|
| `NEXT_PUBLIC_HANDSON_TOUR_ENABLED` | "true" / "false" | Web (Vercel env) |
| `EXPO_PUBLIC_HANDSON_TOUR_ENABLED` | "true" / "false" | Mobile (expo build env) |
| `HANDSON_TOUR_ROLLOUT_PERCENTAGE` | 0-100 | サーバー側 (10% / 50% 段階公開) |

### 2.2 OFF 時の挙動

```ts
// src/app/handson-tour/layout.tsx
if (!process.env.NEXT_PUBLIC_HANDSON_TOUR_ENABLED || process.env.NEXT_PUBLIC_HANDSON_TOUR_ENABLED === 'false') {
  return <Redirect to="/home" />;
}
```

サーバー側 (status API):
```ts
if (process.env.HANDSON_TOUR_ENABLED !== 'true') {
  return Response.json({ should_show: false, reason: 'feature_disabled' });
}
```

→ flag OFF で全機能 disabled、/handson-tour 直リンクは /home へ即リダイレクト。

### 2.3 段階公開 (10% / 50%)

```ts
// サーバー側 status API
function isUserInRollout(userId: string, percentage: number): boolean {
  // user_id をハッシュ化して 0-99 の範囲にマッピング
  const hash = simpleHash(userId);
  return hash % 100 < percentage;
}

// 使用
const percentage = parseInt(process.env.HANDSON_TOUR_ROLLOUT_PERCENTAGE ?? '0', 10);
if (!isUserInRollout(user.id, percentage)) {
  return Response.json({ should_show: false, reason: 'not_in_rollout' });
}
```

`simpleHash`:
```ts
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
```

UUID は均等分散なので、% 100 で 10/100 ユーザー = 10% 公開。

---

## 3. Canary (社内テスト、Day 1-7)

### 3.1 対象
- `@homegohan.test` メールドメインのアカウント (堀さん含む)
- 開発者用テストアカウント

### 3.2 確認事項
- [ ] Step 0-4 が通しで動く
- [ ] 写真認識 mock + バッジ実獲得が連動する
- [ ] AI 献立 mock + バッジ実獲得が連動する
- [ ] 卒業 API が成功する
- [ ] welcome toast が表示される
- [ ] /settings から再開できる
- [ ] hard back / アプリ再起動で再表示されない (skip マーク)
- [ ] admin role で表示されない
- [ ] iOS / Android / Safari / Chrome で動作

### 3.3 完了基準
- 上記 9 項目が全部 OK
- KPI 計測パイプラインが動作 (PostHog 等にイベント到達)
- パフォーマンス目標達成 (Lighthouse > 90)

### 3.4 不具合検出時の対応
- 緊急: feature flag OFF で即無効化
- 中程度: hotfix PR で修正、再デプロイ
- 低: 次回 v1.1 で対応

---

## 4. 段階的公開 (Day 8-21)

### 4.1 Day 8: 10% 公開

```bash
# Vercel env 更新
HANDSON_TOUR_ENABLED=true
HANDSON_TOUR_ROLLOUT_PERCENTAGE=10
```

#### モニタリング
- Slack #app-alerts でアラート受信
- Sentry / PostHog ダッシュボードを毎日確認
- 完了率 / エラー率 / 平均所要時間

#### 続行条件
- エラー率 < 5%
- 完了率 > 60%
- p95 レイテンシ < 1s
- Sentry エラー > 5/h なら停止

### 4.2 Day 14: 50% 公開

```bash
HANDSON_TOUR_ROLLOUT_PERCENTAGE=50
```

10% で問題なければ 50% へ。

### 4.3 Day 21: 100% 公開

```bash
HANDSON_TOUR_ROLLOUT_PERCENTAGE=100
```

または、code 内のフラグ削除 + cleanup PR (= feature flag が不要になる)。

---

## 5. ロールバック手順

### 5.1 軽度 (UI バグ等)
- feature flag OFF で即時無効化 (env 変更のみ、再デプロイなし)
- ホットフィックス PR を準備、修正後 flag ON

### 5.2 中度 (DB 整合性問題)
- feature flag OFF
- DB 行の修正 (operator/09-runbook 経由)
- 修正後 flag ON

### 5.3 重度 (DB スキーマ不整合)
- feature flag OFF
- ロールバック SQL 実行 (§21 §18.2)
- 該当 user_badges 行削除
- 修正版 migration 作成、再デプロイ

### 5.4 ロールバック SQL (再掲)

```sql
BEGIN;
DROP INDEX IF EXISTS idx_user_profiles_handson_tour_pending;
DROP INDEX IF EXISTS idx_meal_logs_user_non_sandbox;
DROP INDEX IF EXISTS uniq_user_sandbox_meal;
ALTER TABLE user_profiles
  DROP COLUMN IF EXISTS handson_tour_completed_at,
  DROP COLUMN IF EXISTS handson_tour_skipped_at;
ALTER TABLE meal_logs DROP COLUMN IF EXISTS is_sandbox;
ALTER TABLE weekly_menus DROP COLUMN IF EXISTS is_sandbox;
DELETE FROM badges WHERE code = 'tutorial_complete';
COMMIT;
```

---

## 6. KPI モニタリング

### 6.1 ダッシュボード

Looker Studio / Metabase / Datadog でハンズオン専用ダッシュボード:

#### 主要メトリクス
- 開始率 (`handson_tour_started` count / signup completed count)
- 完了率 (`handson_tour_completed` count / `handson_tour_started` count)
- スキップ率 (`handson_tour_skipped` count / 表示 count)
- 平均所要時間 (`handson_tour_completed.total_duration_ms` 平均)
- 各 step の通過率 (漏斗 funnel)

#### サブメトリクス
- 完了 vs スキップ群の 7 日継続率
- 完了 vs スキップ群の 14 日 first_bite 獲得率
- エラー発生率 (step ごと)

### 6.2 アラート閾値

| メトリクス | 閾値 | アクション |
|---|---|---|
| 完了率 | < 60% (1 日) | 設計レビュー |
| エラー率 | > 5% (10 分) | hotfix or rollback |
| 平均所要時間 | > 180s (1 日) | UX レビュー |
| complete API p95 | > 1s (5 分) | DB 調査 |

### 6.3 通知先

- Slack #app-alerts (即時)
- 週次レポート: Slack #product-weekly

---

## 7. デプロイ手順

### 7.1 Phase 1 (DB) のデプロイ

1. PR P1-A マージ → main
2. Supabase migration 適用 (CLI):
   ```bash
   supabase db push
   ```
3. 確認:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name='user_profiles' AND column_name LIKE 'handson_tour%';
   ```
4. tutorial_complete バッジ存在確認
5. PR P1-B (API + 共通) マージ → 自動デプロイ

### 7.2 Phase 2 (UI) のデプロイ

1. PR P2-A (Web) マージ → Vercel 自動デプロイ
2. PR P2-B (Mobile) マージ → EAS build → TestFlight (アプリストア審査)
3. iOS / Android 両方のリリースを 揃える

### 7.3 Phase 3 (sandbox) のデプロイ
同様。

### 7.4 Phase 4 (a11y / Analytics)
- PostHog / Mixpanel SDK 連携設定
- Vercel env 更新 (`POSTHOG_API_KEY` 等)

### 7.5 Phase 5 (E2E)
- CI ワークフロー追加 (PR で自動実行)

### 7.6 Phase 6 (canary 開始)
- env: `HANDSON_TOUR_ENABLED=true` (社内のみ)
- 1 週間運用
- 続行判定 → Day 8 へ

---

## 8. アプリストア審査

### 8.1 iOS App Store

新機能追加でストア再審査が必要:
- 申請 → Apple 審査 (1-3 日)
- 承認後リリース
- 段階的公開 (Phased Release)

### 8.2 Android Google Play

- Internal testing → Closed testing → Production
- 各段階で 100% 公開

### 8.3 Web (Vercel)

- 即時デプロイ
- 段階公開は環境変数で制御

---

## 9. 既存機能への影響

### 9.1 影響を受ける既存機能

| 機能 | 影響 |
|---|---|
| `/onboarding/complete` | レスポンスに `next_route` 追加、既存クライアント無視で動作継続 |
| `/badges` | tutorial_complete バッジが 1 件追加 (14 種に) |
| `/api/meal-plans/add-from-photo` | sandbox prop 追加、既存利用は影響なし |
| `/api/menu-plans/add` | 同上 |

### 9.2 後方互換性

- API レスポンスの `next_route` は新規追加 (既存クライアントは無視)
- DB スキーマ追加列は NOT NULL DEFAULT (互換性あり)
- バッジ追加は既存の badges 一覧に 1 件増えるだけ (UI 自動表示)

→ 後方互換性維持、breaking change なし。

---

## 10. ステークホルダー連絡

### 10.1 通知対象

| 対象 | タイミング | チャネル |
|---|---|---|
| 開発チーム | PR マージごと | GitHub PR notification |
| デザイナー | Phase 2 / 3 完了時 | Slack |
| プロダクト | Phase 5 完了時 + Day 1 / 8 / 14 / 21 | Slack + 週次定例 |
| マーケティング | Day 1 / 21 | Slack |
| サポート | Day 1 (canary) | Slack + Notion ドキュメント |

### 10.2 公開前準備

- [ ] サポートチーム向け Q&A ドキュメント作成
- [ ] FAQ ページ更新 (もし必要なら)
- [ ] ブログ記事 (新機能紹介、Day 21 公開時)
- [ ] Twitter / Instagram 告知 (Day 21)

---

## 11. テストケース (rollout)

### 11.1 Feature flag
- `HANDSON_TOUR_ENABLED=false` → /handson-tour 直リンク即 /home へ
- `HANDSON_TOUR_ENABLED=true, ROLLOUT_PERCENTAGE=0` → 全ユーザー対象外
- `ROLLOUT_PERCENTAGE=10` → 10% のユーザーが eligible

### 11.2 段階的公開シミュレーション
- 1000 ユーザーで `isUserInRollout` を実行 → 10% (±2%) が true
- 同じ user_id は同じ判定 (deterministic)

### 11.3 ロールバック SQL
- ロールバック実行 → ALTER 列が消える
- 再 migration → 列が戻る

---

## 12. 残不確実性 (§99 連携)

- [ ] iOS App Store の Phased Release を使うか (web / mobile で公開時期の同期)
- [ ] 段階的公開のパーセンテージ (10/50/100) が適切か (Day 8 / 14 / 21)
- [ ] 100% 公開後に feature flag を完全削除する PR を出すか (= 永続化)
- [ ] サポートチームへの Q&A ドキュメントの責任者
- [ ] アプリストア審査で「sandbox 行で実バッジ付与」が rejection 対象にならないか (= ガイドライン違反の懸念)
