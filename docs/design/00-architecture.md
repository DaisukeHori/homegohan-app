# homegohan-app 全体アーキテクチャ (基本設計)

PR #797 要件定義 (01/02/03 + 100-scenarios.md) に基づく実装基本設計。clean-build 方針 (`docs/design/00-existing-cleanup.md` 参照)。

## 1. 技術スタック

### Frontend (Web)
- **Framework**: Next.js 15 (App Router)
- **Runtime**: Node.js 22.x / Edge Runtime (一部 Edge Function)
- **UI**: React 19 + Tailwind CSS v4 + Lucide Icons
- **State**: Server Components + Server Actions、クライアント state は最小限
- **Forms**: React Hook Form + Zod
- **Toast**: sonner
- **Build**: Vercel (hnd1 / Tokyo)

### Frontend (Mobile)
- **Framework**: React Native (Expo SDK 53)
- **Architecture**: WebView Hybrid (主要画面は Web 側を WebView 内で表示、ネイティブ機能は薄いブリッジ)
- **Distribution**: Apple Configurator 2 (開発)、TestFlight (β) → App Store (本番)
- **Push**: Expo Push Notifications

### Backend
- **DB**: Supabase (PostgreSQL 15+)
- **Auth**: Supabase Auth (Email + Password、SSO は Phase 2)
- **Storage**: Supabase Storage (バケット分離: `meal-photos` / `fridge-images` / `health-checkups` / `org-logos` / `user-avatars`)
- **Realtime**: Supabase Realtime (Phase 2 でリッチに)
- **Edge Functions**: Deno runtime (LLM プロキシ、写真解析、献立生成)
- **Cache**: Upstash Redis (KV、Vercel から低遅延)
- **Cron**: pg_cron (DB 集約バッチ) + Vercel Cron (HTTP トリガー)

### 外部サービス
- **決済**: Stripe (Stripe Japan)
- **メール**: Resend (本番)、Mailtrap (開発)
- **LLM**:
  - xAI Grok (チャット・献立提案)
  - Google Gemini (画像認識・OCR)
  - Anthropic Claude (産業医アドバイス)
- **エラー監視**: Sentry
- **APM**: Vercel Speed Insights + Sentry Performance
- **ログ集約**: Better Stack (旧 Logtail)
- **Status Page**: status.homegohan.app (Better Stack)
- **CAPTCHA**: Cloudflare Turnstile

## 2. アーキテクチャ全体図

```
┌───────────────────────────────────────────────────────────┐
│                     ユーザー (Web / Mobile)                │
└─────────────────────────┬─────────────────────────────────┘
                          │
            ┌─────────────┴──────────────┐
            │                            │
┌───────────▼──────────┐    ┌───────────▼──────────┐
│  Next.js (Vercel)    │    │  Mobile (Expo)        │
│  - App Router        │    │  - WebView Hybrid     │
│  - Server Actions    │    │  - Expo Push          │
│  - Edge Middleware   │    │  - Image Picker       │
└───────────┬──────────┘    └───────────┬──────────┘
            │                            │
            │  REST + Server Actions     │
            └─────────────┬──────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
┌───────▼────────┐                  ┌──────▼─────────────┐
│ Upstash Redis  │                  │  Supabase          │
│ - Session      │                  │  - PostgreSQL      │
│ - Rate Limit   │                  │  - Auth            │
│ - Cache        │                  │  - Storage         │
└────────────────┘                  │  - Edge Functions  │
                                    │  - Realtime        │
                                    │  - pg_cron         │
                                    └────────┬───────────┘
                                             │
                          ┌──────────────────┼──────────────────┐
                          │                  │                  │
                  ┌───────▼──────┐  ┌────────▼───────┐  ┌──────▼──────┐
                  │ xAI Grok API │  │ Google Gemini  │  │ Anthropic   │
                  │ (chat/menu)  │  │ (image/OCR)    │  │ Claude      │
                  └──────────────┘  └────────────────┘  └─────────────┘

  ┌─────────────────────────────────────────────────────────┐
  │ Stripe (決済) ←─ Webhook ─→ Next.js /api/webhooks/stripe │
  │ Resend (メール) ←─ Webhook ─→ /api/webhooks/resend      │
  └─────────────────────────────────────────────────────────┘
```

## 3. ドメイン分割

```
┌─────────────────────────────────────────────────┐
│              横断 (Cross-cutting)                │
│  認証 / RLS / デザイン / API 規約 / i18n / a11y │
│  パフォ / DR / 法務 (要件 03 §16-19)            │
└─────────────────────────────────────────────────┘
        │              │              │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │ Family  │   │  Org    │   │Operator │
   │ Domain  │   │ Domain  │   │ Domain  │
   │ (01)    │   │ (02)    │   │ (03)    │
   └─────────┘   └─────────┘   └─────────┘
        │              │              │
        └──────────────┼──────────────┘
                       │
                ┌──────▼──────┐
                │   Mobile    │
                │   App       │
                └─────────────┘
```

各ドメインの責務:

- **Family**: 家族グループ・メンバー・共有献立・買い物リスト・個別献立リクエスト (1〜N 家族)
- **Org**: 組織・部署・ライセンス管理・産業医・チャレンジ (BtoB)
- **Operator**: プラン定義・課金・LLM quota・監査・運用 (運営側)
- **Cross**: 全ドメインで共通の設計 (RLS パターン / API 規約 / 認証 / デザインシステム)
- **Mobile**: ネイティブ機能のブリッジ (deep link / push / camera)

## 4. データフロー (主要シナリオ)

### 4.1 個別献立リクエスト (UC-FAM-13 妻が夫にリクエスト)
```
妻 (Web)
  → POST /api/family/meal-requests
    → INSERT family_meal_requests (status=pending, assignee_id=夫)
    → Realtime broadcast (subject: family_group_id)
  → 夫 (Mobile) Push 通知 + アプリ内バッジ +1
夫 (Mobile)
  → 提案画面で「AI に任せる」or「自分で考える」
  → POST /api/family/meal-requests/{id}/ai-propose (AI 利用時)
    → Edge Function family-meal-ai-propose
      → xAI Grok 呼び出し (constraints + アレルギー)
      → ProposedRecipeSchema validate
      → アレルゲン突合 (3 回まで再生成)
    → UPDATE family_meal_requests (status=proposed)
妻
  → 確認 → POST /api/family/meal-requests/{id}/accept
    → INSERT planned_meals (source_request_id=リクエスト ID)
    → 共有買い物リストに材料追加 (family_shopping_items)
```

### 4.2 ライセンス購入・配布 (UC-ORG-11)
```
org_admin (Web)
  → POST /api/org/licenses (プラン選択 + seat 数)
    → Stripe Checkout 起動
  → Stripe webhook 受信 (/api/webhooks/stripe)
    → INSERT org_license_pools
    → ストライプ event_id を idempotency key として記録
org_admin
  → CSV 一括割当
  → POST /api/org/licenses/{poolId}/assignments/bulk
    → トリガー sync_org_license_pool_usage で行ロック取得
    → INSERT org_license_assignments × N
    → Realtime broadcast (subject: organization_id)
社員
  → ライセンス受領通知 → 機能解放
```

### 4.3 退職時 family owner 凍結 (UC-ORG-17)
```
HR システム
  → POST /api/webhooks/hr (退職者リスト)
    → INSERT hr_webhook_events (raw 保存)
    → INSERT hr_revoke_jobs × N (個別ジョブ)
pg_cron worker
  → process_hr_revoke_jobs (5 分ごと)
    → 各 job: org_license_assignments.revoked_at セット
    → 該当 family_groups.status = 'frozen'、freeze_grace_until = NOW() + 30d
    → 退職者本人 + 家族メンバーへ通知
退職者
  → 30 日以内に migrate-to-personal / transfer-ownership / dissolve から選択
  → 楽観的ロック (If-Unmodified-Since) + advisory lock で同時実行を防ぐ
```

## 5. 共通パッケージ構成

```
src/
├── app/
│   ├── (auth)/                    # 認証画面 (login, signup, etc.)
│   ├── (main)/                    # 個人ユーザー画面
│   │   ├── menu/                  # 献立 (既存維持)
│   │   ├── meals/                 # 食事記録 (既存維持)
│   │   ├── health/                # 健診 (既存維持)
│   │   └── settings/              # 設定
│   ├── (family)/                  # 家族管理 (新規、要件 01)
│   ├── (org)/                     # 組織管理 (新規、要件 02)
│   ├── (admin)/                   # 運営管理 (新規、要件 03)
│   ├── (super-admin)/             # super_admin 管理 (新規、要件 03 §9.4)
│   ├── api/
│   │   ├── auth/                  # 認証 API
│   │   ├── family/                # 家族 API (新規)
│   │   ├── org/                   # 組織 API (新規 + 既存維持の me / dashboard)
│   │   ├── admin/                 # 運営 API (新規)
│   │   ├── super-admin/           # super_admin API (新規)
│   │   ├── webhooks/
│   │   │   ├── stripe/            # Stripe webhook (新規)
│   │   │   ├── resend/            # Resend webhook (新規)
│   │   │   └── hr/                # HR Webhook 受信 (新規)
│   │   ├── cron/                  # Vercel Cron (既存 + 新規)
│   │   ├── meals/                 # 既存維持
│   │   ├── meal-plans/            # 既存維持
│   │   ├── food-recognition/      # 既存維持
│   │   ├── health/                # 既存維持
│   │   ├── nutrition/             # 既存維持
│   │   └── recipes/               # 既存維持
│   └── webhooks/                  # 同上
├── components/                    # 既存 UI 部品 + 新規ドメイン部品
├── lib/
│   ├── supabase/                  # Supabase クライアント (既存)
│   ├── auth/                      # 認証ヘルパー (新規 requireOrgRole)
│   ├── plan/                      # getUserActivePlan() (新規)
│   ├── stripe/                    # Stripe SDK ラッパー (新規)
│   ├── llm/                       # LLM 呼び出しヘルパー (Edge Function 経由)
│   ├── notifications/             # Push / Email 統合 (新規)
│   ├── i18n/                      # next-intl (新規)
│   ├── a11y/                      # アクセシビリティ helpers
│   ├── ratelimit/                 # Upstash Ratelimit ラッパー (新規)
│   └── cache/                     # Upstash Redis キャッシュラッパー (新規)
├── middleware.ts                  # セッション同期 (既存)
└── types/
    ├── supabase.ts                # 自動生成 (新規、既存 database.ts は migrate)
    └── domain/                    # ドメイン型定義
        ├── family.ts
        ├── org.ts
        └── operator.ts
```

```
supabase/
├── migrations/                    # 既存維持 + 新規追加 (要件 03 §11.0 の順序)
│   ├── 2026MMDD000_create_subscription_plans.sql      ← 1 番目
│   ├── 2026MMDD001_create_personal_subscriptions.sql
│   ├── 2026MMDD002_alter_user_profiles_org.sql
│   ├── 2026MMDD003_create_organizations.sql
│   ├── 2026MMDD004_create_org_licenses.sql
│   ├── 2026MMDD005_create_family_management.sql
│   ├── 2026MMDD006_create_admin_audit_logs.sql
│   ├── 2026MMDD007_rls_hardening.sql
│   ├── 2026MMDD008_cron_setup.sql
│   └── ...
└── functions/                     # 既存維持 + 新規
    ├── knowledge-gpt/             # 既存
    ├── generate-menu-v5/          # 既存
    ├── food-recognition/          # 既存
    ├── ...
    ├── family-meal-ai-propose/    # 新規 (個別献立 AI 提案)
    ├── family-shared-menu-generate/  # 新規 (家族全員制約和集合献立)
    ├── industrial-doctor-advice/  # 新規 (Claude Sonnet)
    ├── stripe-price-sync/         # 新規 (価格変更時の Stripe 連携)
    ├── notify-push/               # 新規 (Expo Push 一斉送信)
    ├── notify-email/              # 新規 (Resend 一斉送信)
    └── scan-file/                 # 新規 (ClamAV ウイルススキャン)
```

```
apps/mobile/                       # 既存維持 + 新規追加
├── app/
│   ├── _layout.tsx                # 既存 + Linking handler 追加
│   ├── family/
│   │   └── invite-accept.tsx      # 新規 (homegohan://invite/family/{token})
│   └── org/
│       └── invite-accept.tsx      # 新規 (homegohan://invite/org/{token})
└── src/
    ├── lib/
    │   ├── pushNotifications.ts   # 既存 + setBadgeCountAsync 追加
    │   ├── deeplink.ts            # 新規 (URL parser)
    │   └── storage.ts             # 既存 + uploadMealPhoto 追加
    └── components/web/
        └── WebViewScreen.tsx      # 既存維持
```

## 6. 主要マイグレーション順序 (要件 03 §11.0 確定)

```
[Phase 4.5 開始]
1. align_existing_tables.sql            # auth.users / user_profiles の roles 列確認 (既存)
2. create_subscription_plans.sql        # 9 種 plan_key seed
3. create_personal_subscriptions.sql
4. alter_existing_for_plans.sql         # user_profiles.organization_id, family_groups.plan_key 等
5. create_organizations.sql             # organizations / departments / department_history
6. create_org_licenses.sql              # org_license_pools / assignments / audit_log
7. create_family_management.sql         # family_groups / members / invites / shared_menus / shopping / meal_requests / activity_log
8. alter_planned_meals.sql              # family_shared_menu_id, source_request_id
9. alter_user_daily_meals.sql           # proxy_family_member_id (child 代理対応)
10. create_admin_audit_logs.sql
11. create_supporting_tables.sql        # support_tickets / coupons / notifications / etc.
12. rls_hardening.sql                   # iroca_* 制限、meals 家族閲覧、産業医ポリシー
13. cron_setup.sql                      # pg_cron で license_expire / family_freeze_grace 等
```

## 7. 技術選定の根拠

| 選定 | 理由 |
|------|------|
| Supabase | Auth + DB + Storage + Realtime + Edge Functions のオールインワン、コスト最適 |
| Vercel | Next.js との親和性、Edge Functions、ISR、Preview Deployment |
| Upstash Redis | サーバーレス互換、Vercel から低遅延、無料枠 10000 req/day |
| Stripe | 国内サブスク標準、インボイス対応、webhook 充実 |
| Resend | 開発者体験良好、bounces webhook 充実、SPF/DKIM 自動設定 |
| xAI Grok | latency 最速、コスト競争力 |
| Gemini Flash | 画像認識最安、OCR 品質高 |
| Claude Sonnet | 健康指導の専門性・安全性 |

## 8. 環境構成

| 環境 | 用途 | ホスト | DB | 環境変数 |
|------|------|------|-----|----------|
| 開発 | ローカル | localhost | Supabase Local | `.env.local` (Doppler 同期) |
| Preview | PR ごと | Vercel Preview | Supabase Branch | Vercel Environment Variables (Preview) |
| Staging | リリース前検証 | staging.homegohan.app | Supabase Staging Project | 同上 |
| 本番 | エンドユーザー | homegohan.app | Supabase Production | Vercel Environment Variables (Production) |

## 9. 並行開発計画

設計書 (詳細設計) は以下で並行開発:

```
docs/design/
├── 00-architecture.md              ← Opus 直接 (本ファイル)
├── 00-existing-cleanup.md          ← Opus 直接
├── CLAUDE.md                        ← Opus 直接 (全体)
│
├── cross/                           ← 並列 implementer A (横断)
│   ├── CLAUDE.md
│   ├── 01-auth-session.md
│   ├── 02-rls-patterns.md
│   ├── 03-design-system.md
│   ├── 04-api-conventions.md
│   ├── 05-i18n-a11y.md
│   ├── 06-perf-cache.md
│   ├── 07-dr-backup.md
│   └── 08-legal-compliance.md
│
├── family/                          ← 並列 implementer B (家族)
│   ├── CLAUDE.md
│   ├── 01-data-model.md
│   ├── 02-api-spec.md
│   ├── 03-ui-spec.md
│   ├── 04-meal-request-flow.md
│   ├── 05-shared-menu-engine.md
│   ├── 06-shopping-list.md
│   ├── 07-lifecycle.md
│   └── 08-rls-policies.md
│
├── org/                             ← 並列 implementer C (組織)
│   ├── CLAUDE.md
│   ├── 01-data-model.md
│   ├── 02-api-spec.md
│   ├── 03-ui-spec.md
│   ├── 04-license-management.md
│   ├── 05-offboarding-flow.md
│   ├── 06-industrial-doctor.md
│   ├── 07-challenge.md
│   ├── 08-sso-saml.md
│   └── 09-rls-policies.md
│
├── operator/                        ← 並列 implementer D (運営)
│   ├── CLAUDE.md
│   ├── 01-data-model.md
│   ├── 02-api-spec.md
│   ├── 03-ui-spec.md
│   ├── 04-plan-management.md
│   ├── 05-stripe-integration.md
│   ├── 06-ai-llm.md
│   ├── 07-audit-monitoring.md
│   ├── 08-cron-batches.md
│   └── 09-runbook.md
│
└── mobile/                          ← 並列 implementer E (モバイル)
    ├── CLAUDE.md
    ├── 01-architecture.md
    ├── 02-deep-link.md
    ├── 03-push-notification.md
    └── 04-storage-camera.md
```

各 implementer は他ドメインに **直接依存しない**:
- 共通の plan_key / API 規約 / RLS パターンは cross/* で確定
- 各ドメインは cross/* を参照して設計

## 10. 設計書の品質基準

各設計書は以下を含むこと:

1. **目的・対象範囲**: そのドキュメントが解決する問題
2. **要件定義の参照**: どの要件 (FAM-XX / ORG-XX / OP-XX) を実装するか
3. **データモデル**: 関連テーブルの DDL (既存 / 新規 / ALTER)
4. **API 仕様**: パス・メソッド・リクエスト・レスポンス・エラー
5. **UI 仕様**: 画面構成・コンポーネント・状態遷移
6. **シーケンス図**: 主要フローを Mermaid で
7. **エラーハンドリング**: 失敗時の挙動
8. **テスト方針**: unit / integration / E2E のカバー範囲
9. **既存実装との関連**: 保持・削除・新規追加の明示
10. **未解決事項**: TODO / Phase 2 以降への先送り
