# operator/ API 仕様

## 1. 目的・スコープ

運営管理ドメインの全 API エンドポイントの I/O 仕様を定義する。対象は `/api/admin/*`, `/api/super-admin/*`, `/api/support/*`, `/api/webhooks/stripe`, `/api/webhooks/resend`, `/api/cron/*`。

## 2. 関連要件

- 要件 03 §8 API 仕様
- cross/04-api-conventions.md (エラーコード体系・認証ヘルパー)

## 3. 共通仕様

### 3.1 認証

```typescript
import { requireRole } from '@/lib/auth/helpers';

// admin 画面
const user = await requireRole(['admin', 'super_admin']);

// super_admin 画面
const user = await requireRole(['super_admin']);

// support 画面
const user = await requireRole(['admin', 'super_admin', 'support']);

// finance 画面
const user = await requireRole(['admin', 'super_admin', 'finance']);

// sales 画面
const user = await requireRole(['admin', 'super_admin', 'sales']);
```

### 3.2 レスポンス形式

成功:
```json
{ "data": { ... }, "meta": { "total": 100, "page": 1, "per_page": 50 } }
```

エラー:
```json
{ "error": { "code": "OP_PERMISSION_DENIED", "message": "...", "details": {} } }
```

### 3.3 監査ログ記録

**全破壊的操作に必須**:

```typescript
await supabase.from('admin_audit_logs').insert({
  actor_id: user.id,  // WITH CHECK で強制
  action_type: 'admin.user.ban',
  target_id: userId,
  target_type: 'user',
  details: { reason, ban_type, duration_days },
  severity: 'warn',
  ip_address: request.headers.get('x-forwarded-for'),
});
```

---

## 4. ユーザー管理 API

### GET /api/admin/users
ユーザー一覧・検索

**クエリパラメータ**:

| パラメータ | 型 | 説明 |
|----------|---|------|
| `q` | string | 全文検索 (email/name/user_id) |
| `plan` | string | plan_key でフィルタ |
| `role` | string | ロールでフィルタ |
| `status` | `active\|banned\|deleted` | ステータス |
| `registered_from` | date | 登録日 FROM |
| `registered_to` | date | 登録日 TO |
| `last_login_before` | date | 最終ログイン日 |
| `sort` | string | `registered_at\|last_login\|meal_count` |
| `order` | `asc\|desc` | ソート方向 |
| `page` | int | ページ番号 (default: 1) |
| `per_page` | int | 件数 (default: 50, max: 200) |

**レスポンス**:
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "display_name": "山田太郎",
      "plan_key": "pro",
      "roles": ["user"],
      "is_banned": false,
      "last_login_at": "2026-05-06T09:00:00Z",
      "registered_at": "2026-01-15T00:00:00Z",
      "meal_count": 342,
      "organization_id": null
    }
  ],
  "meta": { "total": 12450, "page": 1, "per_page": 50 }
}
```

**権限**: `admin`, `super_admin`, `support`

---

### GET /api/admin/users/{id}
ユーザー詳細

**レスポンス**:
```json
{
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "display_name": "山田太郎",
    "roles": ["user"],
    "plan_key": "pro",
    "organization_id": null,
    "family_group_ids": ["uuid"],
    "stats": {
      "meal_count": 342,
      "ai_session_count": 87,
      "health_checkup_count": 2,
      "last_meal_at": "2026-05-05T18:30:00Z"
    },
    "ban_history": [],
    "support_ticket_count": 3,
    "active_subscription": { "plan_key": "pro", "status": "active", "next_billing_at": "2026-06-01" }
  }
}
```

---

### PATCH /api/admin/users/{id}
ユーザー基本情報更新 (admin note のみ更新可)

**リクエスト**:
```json
{ "admin_note": "要注意ユーザー、規約違反1回目" }
```

**権限**: `admin`, `super_admin`

---

### POST /api/admin/users/{id}/ban
ユーザー BAN

**リクエスト**:
```json
{
  "ban_type": "temporary",
  "reason_category": "spam",
  "reason_detail": "大量スパム投稿を確認",
  "duration_days": 7,
  "notify_user": true,
  "notification_message": "規約違反により7日間の利用停止となりました。"
}
```

**バリデーション**:
- `ban_type`: `temporary` | `permanent`
- `reason_category`: `spam` | `abuse` | `policy_violation` | `other`
- `duration_days`: `temporary` の場合必須、1〜365
- super_admin のみ `permanent` BAN 可能

**レスポンス**: `200 { "data": { "ban_id": "uuid", "unban_at": "2026-05-13T00:00:00Z" } }`

**副作用**: `admin_audit_logs` INSERT (severity='warn')

---

### POST /api/admin/users/{id}/unban
BAN 解除

**リクエスト**: `{ "reason": "誤検知と判断" }`

**権限**: `admin`, `super_admin`

---

### PUT /api/admin/users/{id}/roles
ロール付与・剥奪

**リクエスト**:
```json
{
  "roles": ["admin", "support"],
  "reauth_token": "one_time_token_from_reauth"
}
```

**バリデーション**:
- `super_admin` ロールは `super_admin` のみ付与可能
- 付与可能ロール: 公式 12 種のみ
- パスワード再認証必須 (`reauth_token`)

**権限**: `admin` (super_admin 以外), `super_admin` (全ロール)

---

### GET /api/admin/users/{id}/audit-logs
ユーザーへの操作履歴

**クエリ**: `?page=1&per_page=50&from=2026-01-01`

**権限**: `super_admin`

---

### POST /api/admin/users/{id}/notes
管理ノート追加

**リクエスト**: `{ "body": "サポート対応履歴..." }`

---

## 5. モデレーション API

### GET /api/admin/moderation/{type}
モデレーション対象一覧

`type`: `food` | `recipe` | `ai_content`

**クエリ**: `?status=pending&page=1&per_page=30`

**レスポンス**:
```json
{
  "data": [
    {
      "id": "uuid",
      "type": "food",
      "content_url": "https://storage.../meal-photos/xxx.jpg",
      "reporter_count": 3,
      "user_id": "uuid",
      "created_at": "2026-05-06T10:00:00Z"
    }
  ]
}
```

---

### PUT /api/admin/moderation/{type}/{id}
モデレーション解決

**リクエスト**:
```json
{
  "action": "delete_and_temp_ban",
  "ban_duration_days": 7,
  "resolution_note": "明らかな規約違反画像"
}
```

`action`: `approve` | `delete_only` | `delete_and_warn` | `delete_and_temp_ban` | `delete_and_perm_ban` | `escalate`

---

### POST /api/admin/moderation/auto-rules
自動モデレーションルール作成

**権限**: `super_admin`

---

## 6. 監査ログ API

### GET /api/admin/audit-logs
監査ログ一覧

**クエリ**:

| パラメータ | 説明 |
|----------|------|
| `actor_id` | 操作者 ID |
| `target_id` | 対象 ID |
| `action_type` | アクション種別 |
| `severity` | `info\|warn\|critical` |
| `from` | 期間 FROM |
| `to` | 期間 TO |
| `page`, `per_page` | ページネーション |

**権限**: `super_admin` のみ

---

### POST /api/admin/audit-logs/export
監査ログ CSV エクスポート

**リクエスト**: `{ "from": "2026-01-01", "to": "2026-05-06", "format": "csv" }`

**レスポンス**: `{ "data": { "export_id": "uuid", "status": "processing" } }`

**副作用**: `admin_audit_logs` に `admin.export.request` を記録

---

## 7. 機能フラグ API

### GET /api/super-admin/feature-flags
フラグ一覧

**レスポンス**:
```json
{
  "data": [
    {
      "key": "new_meal_ai_v2",
      "description": "新しい食事 AI V2",
      "enabled": true,
      "rollout_strategy": { "type": "percentage", "value": 25 },
      "constraints": { "min_user_age_days": 7, "exclude_plans": ["free"] },
      "active_user_count": 3200,
      "updated_at": "2026-05-06T00:00:00Z"
    }
  ]
}
```

---

### PUT /api/super-admin/feature-flags/{key}
フラグ更新

**リクエスト**:
```json
{
  "enabled": true,
  "rollout_strategy": { "type": "percentage", "value": 50 },
  "constraints": {}
}
```

**副作用**: 即座に全ユーザーへ反映、監査ログ記録

---

### POST /api/super-admin/feature-flags
フラグ新規作成

### DELETE /api/super-admin/feature-flags/{key}
フラグ削除 (利用中の場合は `OP_FEATURE_FLAG_IN_USE` で 409)

---

## 8. LLM 使用量 API

### GET /api/super-admin/llm-usage
LLM 使用量ダッシュボード

**クエリ**: `?period=7d&model=xai_grok&function=knowledge-gpt`

**レスポンス**:
```json
{
  "data": {
    "total_cost_usd": 1234.56,
    "total_cost_jpy": 187000,
    "by_model": [
      { "model": "xai_grok", "requests": 45000, "tokens": 12000000, "cost_usd": 800 }
    ],
    "by_function": [
      { "function": "knowledge-gpt", "requests": 30000, "cost_usd": 600 }
    ],
    "top_users": [
      { "user_id": "uuid", "email": "user@example.com", "requests": 1200, "cost_usd": 50 }
    ],
    "timeseries": [
      { "date": "2026-05-06", "cost_usd": 180 }
    ],
    "anomalies": []
  }
}
```

---

### GET /api/super-admin/llm-usage/users/{id}
ユーザー別 LLM 使用量詳細

---

### POST /api/super-admin/llm-usage/quota-update
クォータ更新

**リクエスト**:
```json
{
  "target_type": "user",
  "target_id": "uuid",
  "daily_limit": 100,
  "monthly_limit": 2000,
  "reason": "異常使用検知のため制限"
}
```

---

## 9. 売上・経理 API

### GET /api/admin/finance/dashboard
売上ダッシュボード

**レスポンス**:
```json
{
  "data": {
    "current_mrr_jpy": 4580000,
    "current_arr_jpy": 54960000,
    "churn_rate": 2.3,
    "ltv_jpy": 18500,
    "new_mrr_jpy": 280000,
    "expansion_mrr_jpy": 45000,
    "contraction_mrr_jpy": 12000,
    "churned_mrr_jpy": 35000
  }
}
```

**権限**: `admin`, `super_admin`, `finance`

---

### GET /api/admin/finance/mrr
MRR 時系列

**クエリ**: `?from=2025-01-01&to=2026-05-01&granularity=month`

---

### GET /api/admin/finance/cohorts
コホート分析

**クエリ**: `?cohort_by=registered_month&retention_months=12`

---

### POST /api/admin/finance/invoices/generate
請求書一括生成

**リクエスト**: `{ "billing_period": "2026-04", "org_ids": ["uuid1", "uuid2"] }`

**レスポンス**: `{ "data": { "job_id": "uuid", "invoice_count": 45, "status": "processing" } }`

**権限**: `finance`, `admin`, `super_admin`

---

### GET /api/admin/finance/invoices
請求書一覧

### POST /api/admin/finance/invoices/{id}/resend
請求書再送

---

## 10. サポート API

### GET /api/support/tickets
チケット一覧

**クエリ**: `?status=open&priority=high&assignee_id=uuid&page=1`

**権限**: `support`, `admin`, `super_admin`

---

### POST /api/support/tickets
チケット作成 (ユーザー側から)

**リクエスト**:
```json
{
  "subject": "ログインできません",
  "category": "account",
  "body": "昨日からログインできなくなりました。",
  "priority": "high"
}
```

---

### GET /api/support/tickets/{id}
チケット詳細 (メッセージ一覧含む)

---

### POST /api/support/tickets/{id}/messages
メッセージ追加

**リクエスト**:
```json
{
  "body": "ご不便をおかけしております。パスワードリセットをお試しください。",
  "is_internal": false,
  "attachments": []
}
```

---

### PATCH /api/support/tickets/{id}
ステータス・担当者変更

**リクエスト**: `{ "status": "resolved", "assignee_id": "uuid" }`

---

## 11. 通知配信 API

### GET /api/admin/notifications/campaigns
キャンペーン一覧

**権限**: `admin`, `super_admin`

---

### POST /api/admin/notifications/campaigns
キャンペーン作成

**リクエスト**:
```json
{
  "name": "5月キャンペーン",
  "channel": "push",
  "target_filter": {
    "plan_keys": ["free"],
    "last_login_before_days": 14
  },
  "variants": [
    {
      "key": "A",
      "title": "久しぶりですね！",
      "body": "今日の食事を記録してみましょう",
      "deep_link": "homegohan://meals/new"
    }
  ],
  "scheduled_at": "2026-05-10T09:00:00+09:00"
}
```

---

### POST /api/admin/notifications/campaigns/{id}/send
キャンペーン配信実行

**権限**: `admin`, `super_admin`

---

### GET /api/admin/notifications/campaigns/{id}/stats
配信統計

**レスポンス**:
```json
{
  "data": {
    "total_recipients": 15000,
    "sent_count": 14987,
    "open_count": 4500,
    "click_count": 890,
    "open_rate": 30.0,
    "click_rate": 5.9
  }
}
```

---

## 12. 不正検知 API

### GET /api/super-admin/abuse/rules
ルール一覧

### POST /api/super-admin/abuse/rules
ルール作成

**リクエスト**:
```json
{
  "name": "BOT 大量登録",
  "rule_type": "multi_account",
  "threshold": { "ip_accounts_per_10min": 10 },
  "action_type": "perm_ban",
  "action_config": { "auto_execute": true }
}
```

**権限**: `super_admin`

---

### PATCH /api/super-admin/abuse/rules/{id}
ルール更新 (有効化/無効化含む)

### GET /api/super-admin/abuse/detections
検知一覧

**クエリ**: `?review_status=auto&page=1`

---

### POST /api/super-admin/abuse/detections/{id}/review
手動レビュー

**リクエスト**: `{ "review_status": "false_positive", "note": "テストユーザーの誤検知" }`

---

## 13. インフラ監視 API

### GET /api/super-admin/infra/dashboard
統合監視ダッシュボード

**レスポンス**:
```json
{
  "data": {
    "vercel": { "error_rate": 0.01, "p95_ms": 320, "deploy_status": "healthy" },
    "supabase": { "db_connections": 45, "p95_query_ms": 28, "edge_fn_status": "healthy" },
    "llm_apis": {
      "xai": { "p95_ms": 450, "error_rate": 0.002 },
      "gemini": { "p95_ms": 380, "error_rate": 0.001 }
    },
    "cache_hit_rate": 0.82,
    "active_incidents": 0
  }
}
```

**権限**: `super_admin`

---

### GET /api/super-admin/infra/metrics
メトリクス時系列

**クエリ**: `?metric=vercel_error_rate&from=2026-05-01&to=2026-05-06`

---

### GET /api/super-admin/infra/alerts
アラート一覧

### POST /api/super-admin/infra/alerts/{id}/acknowledge
アラート確認

---

## 14. 営業 CRM API

### GET /api/admin/sales/leads
見込み客一覧

**クエリ**: `?stage=meeting&assigned_to=uuid&page=1`

**権限**: `sales`, `admin`, `super_admin`

---

### POST /api/admin/sales/leads
見込み客作成

**リクエスト**:
```json
{
  "company_name": "株式会社テスト",
  "industry": "manufacturing",
  "employee_count": 500,
  "contact_name": "佐藤部長",
  "contact_email": "sato@test.co.jp",
  "source": "referral",
  "estimated_acv": 1200000
}
```

---

### PATCH /api/admin/sales/leads/{id}
リード更新 (ステージ変更含む)

---

### POST /api/admin/sales/leads/{id}/activities
活動記録追加

**リクエスト**:
```json
{
  "activity_type": "meeting",
  "details": {
    "date": "2026-05-08",
    "participants": ["田中部長", "鈴木GM"],
    "summary": "デモ実施、次回提案書提出予定",
    "next_action": "提案書を5/15までに送付"
  }
}
```

---

### POST /api/admin/sales/leads/{id}/proposal-pdf
提案書 PDF 生成

**レスポンス**: `{ "data": { "pdf_url": "https://storage.../proposals/xxx.pdf" } }`

---

## 15. A/B テスト API

### GET /api/super-admin/experiments
実験一覧

**権限**: `super_admin`

---

### POST /api/super-admin/experiments
実験作成

**リクエスト**:
```json
{
  "key": "new_chat_ui_2026_05",
  "name": "新チャット UI テスト",
  "hypothesis": "新 UI でメッセージ送信率 +20%",
  "variants": [
    { "key": "control", "weight": 50 },
    { "key": "new_ui", "weight": 50 }
  ],
  "primary_metric": "message_send_rate",
  "start_date": "2026-05-10",
  "end_date": "2026-05-24"
}
```

---

### PATCH /api/super-admin/experiments/{id}
実験更新 (start/stop/cancel)

### GET /api/super-admin/experiments/{id}/results
実験結果 (p値、信頼区間、サブグループ分析)

---

## 16. データエクスポート API

### POST /api/super-admin/exports
エクスポートリクエスト

**リクエスト**:
```json
{
  "export_type": "user_data",
  "format": "csv",
  "filters": { "registered_from": "2026-01-01", "plan_key": "pro" },
  "mask_pii": true
}
```

**権限**: `super_admin`

---

### GET /api/super-admin/exports/{id}
エクスポートステータス確認

### GET /api/super-admin/exports/{id}/download
エクスポートファイルダウンロード (署名付き URL を返す)

---

## 17. プラン定義 API

### GET /api/super-admin/plans
プラン一覧

**クエリ**: `?type=org&status=public`

**権限**: `super_admin`

---

### POST /api/super-admin/plans
プラン新規作成 (draft で作成)

**リクエスト**:
```json
{
  "plan_key": "org_pro_2027",
  "display_name": "Org Pro 2027",
  "plan_type": "org",
  "monthly_price_jpy": 2200,
  "yearly_price_jpy": 22000,
  "max_members": 500,
  "trial_days": 0,
  "feature_package_ids": ["uuid1", "uuid2"]
}
```

---

### GET /api/super-admin/plans/{id}
プラン詳細

### PATCH /api/super-admin/plans/{id}
プラン編集 (draft のみ自由編集、public 以降は価格変更 API 経由)

---

### POST /api/super-admin/plans/{id}/publish
`draft` → `public` 公開

**バリデーション**: `plan_key` が 9 種公式リストに含まれるか、または super_admin が意図的に追加したものか確認

---

### POST /api/super-admin/plans/{id}/unpublish
`public` → `private`

---

### POST /api/super-admin/plans/{id}/deprecate
廃止

**リクエスト**:
```json
{
  "superseded_by_plan_id": "uuid",
  "ends_at": "2026-08-31T23:59:59Z",
  "migration_message": "このプランは2026年9月1日に終了します。新プランへの移行をお願いします。"
}
```

**副作用**:
- 関連 `org_license_pools.auto_renew = FALSE` に強制更新
- `admin_audit_logs` に severity='critical' で記録
- 90/30/7 日前通知ジョブをキュー投入

---

### POST /api/super-admin/plans/{id}/un-deprecate
deprecated → private にロールバック (緊急用)

**権限**: `super_admin` のみ

**副作用**:
- `org_license_pools.auto_renew_was_force_disabled_at IS NOT NULL` のレコードを `auto_renew = TRUE` に復元
- 影響組織管理者へ通知
- 監査ログに severity='critical'

---

### POST /api/super-admin/plans/{id}/price-change
価格変更

**リクエスト**:
```json
{
  "new_monthly_price_jpy": 1180,
  "new_yearly_price_jpy": 11800,
  "applies_to": "on_renewal",
  "reason": "物価上昇に伴うインフレ調整",
  "effective_at": "2026-06-01T00:00:00Z"
}
```

**処理フロー**:
1. 影響シミュレーション (GET impact を内部呼び出し)
2. Stripe: `prices.create` で新 Price object 生成
3. DB: `subscription_plans` 更新 + `plan_price_history` INSERT
4. 適用範囲: `on_renewal` → 既存サブスクリプションの次回更新時に切替

**エラー**: Stripe 側失敗時は新 Price を deactivate + DB rollback

---

### GET /api/super-admin/plans/{id}/impact
価格変更影響シミュレーション

**クエリ**: `?new_monthly_price_jpy=1180&applies_to=on_renewal`

**レスポンス**:
```json
{
  "data": {
    "affected_subscription_count": 3420,
    "affected_mrr_change_jpy": 680000,
    "affected_user_sample": [ { "user_id": "uuid", "email": "..." } ]
  }
}
```

---

### GET /api/super-admin/plans/{id}/price-history
価格変更履歴

### GET /api/super-admin/plans/{id}/downgrade-impact
ダウングレード機能消失シミュレーション

**クエリ**: `?to_plan_id=uuid`

**レスポンス**:
```json
{
  "data": {
    "lost_features": ["industrial_doctor_access", "ai_doctor_advice"],
    "affected_member_count": 87,
    "affected_members_sample": [ { "user_id": "uuid", "email": "..." } ]
  }
}
```

---

## 18. 機能パッケージ API

### GET /api/super-admin/feature-packages
パッケージ一覧

### POST /api/super-admin/feature-packages
パッケージ作成

**リクエスト**:
```json
{
  "package_key": "advanced_analytics",
  "display_name": "高度分析",
  "feature_flags": ["cohort_analysis_v2", "ab_test_dashboard"],
  "display_order": 80
}
```

**権限**: `super_admin`

---

### PATCH /api/super-admin/feature-packages/{id}
パッケージ更新

### DELETE /api/super-admin/feature-packages/{id}
パッケージ削除

**バリデーション**: 利用中プランがある場合は `OP_PACKAGE_IN_USE` で 409

---

## 19. クーポン管理 API

### GET /api/admin/coupons
クーポン一覧

**クエリ**: `?status=active&page=1`

**権限**: `sales`, `admin`, `super_admin`

---

### POST /api/admin/coupons
クーポン作成

**リクエスト**:
```json
{
  "code": "ENTERPRISE2026",
  "display_name": "法人営業キャンペーン2026",
  "discount_type": "percentage",
  "discount_value": 20,
  "applicable_to": "org",
  "valid_from": "2026-05-01T00:00:00Z",
  "valid_until": "2026-12-31T23:59:59Z",
  "max_uses": 100,
  "per_user_limit": 1,
  "duration_months": 3
}
```

**バリデーション**:
- 0 円や 1 円となるクーポン (100% OFF + monthly_price <= 1 円) は警告表示
- `gross_margin_preview_jpy` を計算して返す

---

### PATCH /api/admin/coupons/{id}
クーポン編集

### POST /api/admin/coupons/{id}/pause
一時停止

### GET /api/admin/coupons/{id}/redemptions
利用統計

**レスポンス**:
```json
{
  "data": {
    "total_redemptions": 45,
    "active_redemptions": 42,
    "total_discount_jpy": 894000,
    "redemptions": [ { "user_id": "uuid", "redeemed_at": "2026-05-01T00:00:00Z" } ]
  }
}
```

---

## 20. 収益管理 API

### GET /api/admin/finance/revenue/snapshot
最新収益スナップショット

### GET /api/admin/finance/revenue/timeseries
MRR / ARR 時系列

**クエリ**: `?from=2025-01-01&to=2026-05-01&segment=personal`

---

### GET /api/admin/finance/revenue/forecast
収益予測

**クエリ**: `?horizon=6` (6ヶ月予測)

**レスポンス**:
```json
{
  "data": {
    "forecast": [
      { "month": "2026-06", "mrr_jpy": 5100000, "confidence_low": 4800000, "confidence_high": 5400000 }
    ],
    "assumptions": { "churn_rate": 2.3, "growth_rate": 5.1 }
  }
}
```

---

### GET /api/admin/finance/licenses
組織ライセンス販売一覧

**クエリ**: `?status=active&expiring_within_days=30`

### GET /api/admin/finance/personal
個人課金者リスト

**クエリ**: `?plan_key=pro&status=active&page=1`

---

## 21. Webhook API

### POST /api/webhooks/stripe
Stripe Webhook 受信 (idempotent)

**ヘッダー**: `Stripe-Signature: t=xxxx,v1=xxxx`

**処理フロー**:
```
1. Stripe-Signature 検証 (stripe.webhooks.constructEvent)
2. INSERT stripe_webhook_events (id = event.id)
   → CONFLICT (id 重複) → 200 early return (replayed event)
   → 成功 → processing_status = 'processing'
3. event.type に応じた DB 更新:
   subscription.created/updated → personal_subscriptions UPSERT
   invoice.paid → personal_subscriptions.status = 'active'
   invoice.payment_failed → personal_subscriptions.status = 'past_due'
   customer.subscription.deleted → status = 'cancelled'
   trial_will_end → trial 終了リマインダー送信
   charge.dispute.created → ユーザー soft-suspend + 監査ログ
4. UPDATE stripe_webhook_events SET processing_status = 'completed'
5. エラー時: processing_status = 'failed', error_message をセット
```

**冪等性保証**: `stripe_webhook_events.id` (Stripe event.id) が PRIMARY KEY のため、同一イベントの重複処理は CONFLICT で早期 return

---

### POST /api/webhooks/resend
Resend Webhook 受信 (メール配信ステータス更新)

**処理フロー**:
```
1. Resend-Signature 検証
2. event.type に応じて:
   email.bounced → email_blacklist に追加 + email_delivery_logs 更新
   email.complained → email_blacklist に追加
   email.delivered / opened / clicked → email_delivery_logs 更新
```

---

## 22. Cron API

### POST /api/cron/stripe-reconcile
Stripe 整合性チェック (日次 12:00 JST)

**処理**:
1. Stripe API: subscriptions 全件 paginate
2. personal_subscriptions と status を比較
3. 不一致 → `admin_audit_logs` に記録 + Slack アラート
4. 自動修復禁止 (人間確認後 super_admin が手動修正)

**認証**: `CRON_SECRET` ヘッダー

---

### POST /api/cron/trial-reminder
試用終了リマインダー (日次 09:00 JST)

**処理**:
1. `personal_subscriptions WHERE status='trialing' AND trial_ends_at BETWEEN NOW() AND NOW()+3d`
2. Push + Email 送信
3. メール件名: 「【ほめゴハン】無料トライアルが X 日後に終了します」

---

### POST /api/cron/deprecate-plan-notice
deprecated プラン通知 (日次 11:00 JST)

**処理**:
1. `subscription_plans WHERE status='deprecated' AND ends_at IS NOT NULL`
2. 90/30/7 日前に該当する全ユーザー・組織へ通知

---

### POST /api/cron/re-engagement-email
再エンゲージメントメール (日次 13:00 JST)

**処理**:
1. 7/14/30 日間ログインなし かつ `plan_key != 'free'` のユーザー
2. 段階的メール送信 (7日目: 軽いリマインダー / 30日目: 解約防止オファー)

---

### POST /api/cron/nps-survey-sender
NPS サーベイ送信 (日次 14:00 JST)

**処理**: 登録 30 日経過 + 前回 NPS から 90 日経過のユーザーに送信

---

### POST /api/cron/license-renewal-reminder
ライセンス更新リマインダー (日次 10:00 JST)

**処理**: 30/14/7 日前の `org_license_pools` に対し、`org_admin` へ更新通知

---

## 23. エラーコード一覧

| コード | HTTP | 意味 |
|--------|------|------|
| `OP_PERMISSION_DENIED` | 403 | ロール不足 |
| `OP_TARGET_PROTECTED` | 403 | 保護ユーザーへの操作不可 (super_admin BAN 等) |
| `OP_AUDIT_LOG_IMMUTABLE` | 403 | 監査ログ書き換え不可 |
| `OP_FEATURE_FLAG_IN_USE` | 409 | 削除しようとしたフラグが利用中 |
| `OP_PACKAGE_IN_USE` | 409 | 削除しようとしたパッケージが利用中 |
| `OP_QUOTA_EXCEEDED` | 429 | LLM クォータ超過 |
| `OP_RE_AUTH_REQUIRED` | 401 | 再認証必須 |
| `OP_PLAN_KEY_CONFLICT` | 409 | plan_key 重複 |
| `OP_PLAN_DEPRECATED` | 422 | deprecated プランへの新規加入不可 |
| `OP_COUPON_ALREADY_ACTIVE` | 409 | 1 契約に対し有効クーポンが既に存在 |
| `OP_SUBSCRIPTION_ALREADY_ACTIVE` | 409 | active/trialing が既に存在 |
| `OP_STRIPE_SYNC_FAILED` | 502 | Stripe API 呼び出し失敗 |
| `OP_COUPON_EXPIRED` | 422 | クーポン期限切れ |
| `OP_TRIAL_ALREADY_USED` | 422 | 同一プランの試用は 1 回のみ |

## 24. テスト方針

主要テストケース:

1. `it('rejects webhook with invalid Stripe signature')`
2. `it('returns already_processed on second webhook with same event_id')`
3. `it('applies coupon discount correctly to subscription price')`
4. `it('returns 403 when non-super_admin calls POST /api/super-admin/plans')`
5. `it('returns 403 when admin role calls impersonate endpoint')`
6. `it('creates admin_audit_log entry on impersonation')`
7. `it('updates plan status to deprecated and triggers migration job')`
8. `it('E2E: super_admin creates plan, publishes, user purchases, webhook updates DB')`

```typescript
// tests/unit/operator/stripe-webhook-signature.test.ts
import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { validateStripeSignature } from '@/lib/operator/stripe-webhook';

describe('Stripe Webhook 署名検証', () => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST!, {
    apiVersion: '2024-11-20.acacia',
  });

  it('accepts webhook with valid signature', () => {
    const payload = JSON.stringify({ type: 'customer.subscription.created' });
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    expect(() => validateStripeSignature(payload, signature, secret)).not.toThrow();
  });

  it('rejects webhook with invalid signature', () => {
    const payload = JSON.stringify({ type: 'customer.subscription.created' });
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;
    expect(() =>
      validateStripeSignature(payload, 'invalid-sig', secret),
    ).toThrow();
  });
});

// tests/unit/operator/coupon-calculation.test.ts
import { applyCoupon } from '@/lib/operator/coupon';

describe('クーポン適用計算', () => {
  it('applies percentage discount correctly', () => {
    const result = applyCoupon({
      original_price_jpy: 980,
      coupon: { discount_type: 'percent', discount_value: 20 },
    });
    expect(result.discounted_price_jpy).toBe(784); // 980 * 0.8
    expect(result.discount_amount_jpy).toBe(196);
  });

  it('applies fixed amount discount correctly', () => {
    const result = applyCoupon({
      original_price_jpy: 980,
      coupon: { discount_type: 'fixed', discount_value: 300 },
    });
    expect(result.discounted_price_jpy).toBe(680); // 980 - 300
  });

  it('clamps discounted price to 0 when fixed discount exceeds original price', () => {
    const result = applyCoupon({
      original_price_jpy: 300,
      coupon: { discount_type: 'fixed', discount_value: 500 },
    });
    expect(result.discounted_price_jpy).toBe(0); // 0 以下にならない
  });
});

// tests/integration/operator/api-permissions.integration.test.ts
describe('operator API 権限テスト', () => {
  it('returns 403 when non-super_admin calls POST /api/super-admin/plans', async () => {
    const adminToken = await signInAsUser('admin@test.local'); // finance ロール
    const res = await fetch(`${BASE_URL}/api/super-admin/plans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_key: 'test_plan', display_name: 'テスト' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when admin role calls impersonate endpoint', async () => {
    const adminToken = await signInAsUser('admin@test.local');
    const res = await fetch(
      `${BASE_URL}/api/super-admin/users/${faker.string.uuid()}/impersonate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    expect(res.status).toBe(403);
  });

  it('creates admin_audit_log entry on successful impersonation', async () => {
    const superToken = await signInAsUser('super@test.local');
    const targetUserId = faker.string.uuid();

    await fetch(`${BASE_URL}/api/super-admin/users/${targetUserId}/impersonate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superToken}` },
    });

    const { data: logs } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('*')
      .eq('action_type', 'impersonate')
      .eq('target_id', targetUserId)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(logs).toHaveLength(1);
    expect(logs![0].actor_id).toBeTruthy();
    expect(logs![0].impersonated_by).toBeTruthy();
  });
});
```

## 25. 既存実装との関連

- `/api/admin/*`, `/api/super-admin/*` は commit `32d13e1` で全削除済み → 完全新規実装
- Stripe webhook ハンドラも新規 (`/api/webhooks/stripe`)

## 26. 未解決事項

- `POST /api/super-admin/plans/{id}/deprecate` の通知ジョブは Vercel Queue (Phase 2) か Supabase Edge Function か → 08-cron-batches.md で決定
- `GET /api/admin/finance/revenue/forecast` の ML モデルは Phase 4 実装、現在は線形外挿のみ
- Resend Webhook の署名検証方式 (HMAC-SHA256) は Resend ドキュメント準拠で実装
