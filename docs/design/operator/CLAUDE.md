# operator/ 運営管理ドメイン 開発指針

要件定義 `docs/requirements/03-operator-admin.md` の詳細設計。

## ファイル一覧

| ファイル | 担当範囲 | 要件参照 |
|---------|--------|---------|
| `01-data-model.md` | DDL (subscription_plans / personal_subscriptions / coupons / admin_audit_logs / support_tickets / etc.) + ER 図 | 03 §7 |
| `02-api-spec.md` | 全 API の I/O (admin / super-admin) | 03 §8 |
| `03-ui-spec.md` | 画面仕様 (admin / super-admin / support / sales / finance) | 03 §9 |
| `04-plan-management.md` | F-OP-015 プラン定義・販売管理ツール (subscription_plans / feature_packages / coupons) | 03 §5.15-5.17 |
| `05-stripe-integration.md` | Stripe webhook (idempotency) / Price 同期 / reconciliation | 03 §15.12 §22.10 |
| `06-ai-llm.md` | モデル選定 / quota / プロンプト / アレルゲン突合 | 03 §5.5 |
| `07-audit-monitoring.md` | admin_audit_logs / 監査ログ操作網羅リスト / Sentry / Better Stack | 03 §5.3 §22.9 |
| `08-cron-batches.md` | pg_cron + Vercel Cron 全 job (license_expire / freeze_grace / archive_purge / trial_reminder) | 03 §15.17 |
| `09-runbook.md` | 運用手順書 (Stripe reconcile / HR retry / deprecated rollback / incident response / DR) | 03 §15 §16.5 |

## ドメインの役割

運営側のすべての管理機能:
- **super_admin**: プラン定義 / 機能パッケージ / 価格変更 / DB 管理 / impersonate
- **admin**: ユーザー / 組織 / 課金 / モデレーション
- **support**: サポートチケット対応
- **sales**: 法人見込み客 / クーポン管理
- **finance**: 請求書 / 売上ダッシュボード / Stripe 連携
- **content_moderator**: コンテンツ審査

## 主要シーケンス

### プラン価格変更 (Stripe Price 連携)
```
super_admin
  → POST /api/super-admin/plans/{id}/price-change
    → 影響シミュレーション (impact API)
    → 確認モーダル → 確定
  → Edge Function stripe-price-sync
    → stripe.prices.create (新 Price object)
    → 適用範囲別: 新規のみ / 更新時 / 即時 (proration_behavior)
    → INSERT plan_price_history
  → 該当ユーザーへ段階通知 (90/30/7 日前)
```

詳細は `04-plan-management.md` + `05-stripe-integration.md`。

### Stripe Webhook idempotency
```
Stripe → POST /api/webhooks/stripe
  → Stripe-Signature 検証
  → INSERT stripe_webhook_events (PRIMARY KEY = event.id)
    → 既存 → 200 早期 return (replayed)
    → 新規 → イベント type に応じて DB 更新
  → SET processing_status = 'completed'
```

詳細は `05-stripe-integration.md`。

### 監査ログ閲覧 (super_admin のみ)
- INSERT は admin / super_admin / support / sales / finance / content_moderator から可
- SELECT は **super_admin のみ** (admin が自分の操作を消せない設計)
- UPDATE / DELETE は不可
- 7 年保管

詳細は `07-audit-monitoring.md`。

## ドメイン設計原則

### 1. plan_key マスター責務
- `subscription_plans` の唯一の管理者
- 9 種公式 plan_key (`free`, `pro`, `family_basic`, `family_pro`, `family_addon`, `org_starter`, `org_standard`, `org_pro`, `org_enterprise`) を seed
- ON UPDATE CASCADE / ON DELETE RESTRICT で他ドメインとの整合性保証

### 2. Stripe との同期
- DB が source of truth、Stripe が課金実行
- 整合性は日次 reconciliation cron (`/api/cron/stripe-reconcile`) で担保
- webhook の idempotency は `stripe_webhook_events` テーブルで保証

### 3. 監査ログの不可逆性
- `admin_audit_logs` は 7 年保管、`UPDATE / DELETE 不可` (RLS + WITH CHECK)
- 全 admin 系操作 (要件 03 §15.8 の網羅リスト) を必ず記録
- impersonate は `impersonated_by` 列で識別

### 4. 監査ログ閲覧権限の最小化
- SELECT は super_admin のみ (admin が自分の操作を消せない設計)
- 個別 admin が自分のログを見たい場合は super_admin に依頼

### 5. AI モデル選定の透明性
| 機能 | モデル |
|------|------|
| 画像認識 | Gemini Flash (コスト最安) |
| チャット・献立 | xAI Grok (latency 最速) |
| 産業医アドバイス | Claude Sonnet (専門性・安全性) |

選定根拠を `06-ai-llm.md` に明記。コスト見積りも含める。

## 他ドメインとの依存

| 依存先 | 用途 |
|-------|------|
| `cross/01-auth-session.md` | super_admin / admin 認可 / impersonate |
| `cross/02-rls-patterns.md` | admin_audit_logs の immutable RLS |
| `cross/06-perf-cache.md` | キャッシュ戦略 (subscription_plans を 5 分キャッシュ) |
| `family/01-data-model.md` | `family_groups.plan_key` の参照元 |
| `org/01-data-model.md` | `org_license_pools.plan_key` の参照元 |

## このドメインから他ドメインへの提供

operator は **全ドメインの基盤**:

| 提供内容 | 利用先 |
|---------|------|
| `subscription_plans` | 全ドメインの plan_key FK 参照 |
| `personal_subscriptions` | family / org の getUserActivePlan() 計算 |
| `admin_audit_logs` | 全ドメインの監査ログ INSERT 先 |
| `coupons` / `coupon_redemptions` | family / org の課金フローで適用 |
| `feature_packages` | プラン × 機能の照合 |
| AI モデル選定・quota | family / org の Edge Function 呼び出し |

## テスト戦略

- **Unit**: `getUserActivePlan()` / Stripe 価格計算 / クーポン適用ロジック
- **Integration**: Supabase Local で
  - admin_audit_logs の immutable 制約
  - stripe_webhook_events の idempotency
  - subscription_plans deprecated 時の関連テーブル動作
- **E2E**: super_admin プラン作成 → 公開 → 組織が購入 → 退職フロー全体

## 既存実装との関連

### 削除済み (clean-build)
- `src/app/api/admin/`, `src/app/api/super-admin/` 全部
- `src/app/(admin)/`, `src/app/(super-admin)/` 全部 (commit `32d13e1`)

### 保持
- `supabase/functions/_shared/llm-usage.ts` (organization_id 列追加で拡張)
- 既存 LLM Edge Functions

### 新規作成
- `src/app/admin/`, `src/app/super-admin/` 配下全 UI (要件 03 §9) ※ PR #821 で route group から実 segment にリネーム済み
- `src/app/api/admin/*`, `super-admin/*` 全 API (要件 03 §8)
- 全 cron job (`src/app/api/cron/*` + pg_cron)
- 全運用手順書 (`docs/operations/*.md`)

## 運用手順書 (`09-runbook.md`)

設計フェーズで作成:
- Stripe ↔ DB reconciliation 手順
- pg_cron 失敗時の手動実行手順
- deprecated プラン rollback 手順
- 誤大量 CSV 割当の bulk-revoke 手順
- org_admin ゼロ状態の緊急復旧手順
- GDPR 削除要求対応フロー
- 漏洩 72 時間報告フロー
- DR (PITR / フェイルオーバー) 手順
