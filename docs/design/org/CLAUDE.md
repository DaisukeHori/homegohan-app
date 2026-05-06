# org/ 組織管理ドメイン 開発指針

要件定義 `docs/requirements/02-organization-management.md` の詳細設計。

## ファイル一覧

| ファイル | 担当範囲 | 要件参照 |
|---------|--------|---------|
| `01-data-model.md` | DDL (organizations / departments / org_members / org_subscriptions / org_license_pools / assignments / audit_log) + ER 図 | 02 §7 |
| `02-api-spec.md` | 全 API の I/O | 02 §8 |
| `03-ui-spec.md` | 画面仕様 (admin / member / industrial_doctor) | 02 §9 |
| `04-license-management.md` | F-ORG-011/012/013 ライセンスプール / 配布 / 同梱 / 分析 | 02 §5.11-5.13 |
| `05-offboarding-flow.md` | UC-ORG-17 退職時の家族凍結 / HR Webhook 冪等化 | 02 §4.17 §15.2 |
| `06-industrial-doctor.md` | F-ORG-010 産業医 + AI advice (Claude Sonnet) | 02 §5.10 §8.8 |
| `07-challenge.md` | F-ORG-006 チャレンジ機能 | 02 §5.6 |
| `08-sso-saml.md` | SSO Phase 2 (SAML / OIDC / SCIM / JIT) | 02 §6.4 + 03 §17.3 |
| `09-rls-policies.md` | RLS ポリシー一覧 (organization_id 境界 / 産業医境界) | 02 §7 |

## ドメインの役割

法人 (組織) 向けの管理機能:
- 組織契約 (Stripe 経由)、プラン購入 → ライセンスプール → 社員配布
- 部署管理 / メンバー招待 / チャレンジ
- 産業医による個別健康指導 (Org Pro 以上)
- 退職フロー (HR Webhook 連携 + 家族グループ凍結)
- 複数組織所属対応 (副業・出向)

## 主要シーケンス

### ライセンス購入 → 配布
```
org_admin
  → /api/org/licenses (Stripe Checkout)
  → Stripe webhook → INSERT org_license_pools (idempotent via stripe_webhook_events)
  → CSV 一括割当
  → POST /api/org/licenses/{poolId}/assignments/bulk
  → trigger sync_org_license_pool_usage (FOR UPDATE 行ロック、容量チェック)
```

詳細は `04-license-management.md`。

### 退職時の家族凍結
```
HR system
  → POST /api/webhooks/hr (退職者リスト)
  → INSERT hr_webhook_events + hr_revoke_jobs
  → pg_cron で個別ジョブ処理 (冪等、5 回リトライ + dead letter)
  → org_license_assignments.revoked_at セット
  → トリガーで family_groups.status = 'frozen' (source_org_assignment_id 経由)
退職者
  → 30 日以内に migrate-to-personal / transfer-ownership / dissolve から選択
  → If-Unmodified-Since + advisory lock で同時実行防止
```

詳細は `05-offboarding-flow.md`。

## ドメイン設計原則

### 1. organization_id 境界を厳守
- 全 RLS で `organization_id` 一致チェック
- 複数組織所属ユーザーは `org_license_assignments` の active 行で表現
- API 認可は `requireOrgRole(uid, orgId, [...])` でガード (`cross/01-auth-session.md`)
- リクエスト body の `organization_id` は信頼せず、server-side で `resolveOrganizationId` 経由 (`cross/04-api-conventions.md`)

### 2. ライセンスプールの整合性
- `used_licenses` はトリガー `sync_org_license_pool_usage` で同期
- `available_licenses` は GENERATED ALWAYS 列、直接 UPDATE 禁止
- 同時 INSERT 競合は `SELECT ... FOR UPDATE` で防御
- CHECK 制約 `total_licenses >= used_licenses`

### 3. 産業医の閲覧範囲
- 同組織の同意済メンバー (`consent_org_health_data = TRUE`) のみ
- 家族領域 (`family_groups` 配下) は **閲覧不可**
- 退職者 (`is_active_in_org = FALSE`) は閲覧不可
- 別組織のメンバーは閲覧不可
- 全アクセスを `org_health_access_logs` に記録 (10 年保管)

### 4. 監査ログ必須
ライセンス操作・部署変更・メンバー除名・産業医アクセスは:
- `org_license_audit_log` または `org_health_access_logs` に記録
- `actor_id = auth.uid()` を WITH CHECK で強制
- UPDATE / DELETE 不可

## 他ドメインとの依存

| 依存先 | 用途 |
|-------|------|
| `cross/01-auth-session.md` | `requireOrgRole` / SSO / 2FA |
| `cross/02-rls-patterns.md` | RLS テンプレート / advisory lock |
| `cross/04-api-conventions.md` | エラーコード `ORG_*` / `CONFLICT_LICENSE_POOL_EXHAUSTED` |
| `operator/01-data-model.md` | `subscription_plans.plan_key` (org_starter 〜 org_enterprise / family_addon) |
| `operator/05-stripe-integration.md` | Stripe Subscription / webhook / Price ID 連携 |
| `family/07-lifecycle.md` | UC-ORG-17 退職時に family_groups を凍結する境界 |

## このドメインから他ドメインへの提供

| 提供先 | 内容 |
|-------|------|
| `family/07-lifecycle.md` | `org_license_assignments.revoked_at` トリガーから family 凍結 |
| `operator/02-api-spec.md` | `/admin/organizations/{orgId}/billing` で参照する組織情報 |
| `mobile/02-deep-link.md` | `homegohan://invite/org/{token}` の受諾画面 |

## テスト戦略

- **Unit**: ライセンス容量計算 / `getUserActivePlan()` / 産業医境界判定
- **Integration**: Supabase Local で
  - org_license_assignments の同時 INSERT 競合
  - 産業医が他組織データに RLS で弾かれる
  - 退職時の自動 family 凍結
- **E2E**: 法人契約 → CSV 一括割当 → 産業医アクセス を Playwright

## 既存実装との関連

### 削除済み (clean-build)
- `src/app/api/org/users/`, `org/settings/`, `org/stats/`, `org/departments/` (commit `32d13e1`)

### 保持
- `src/app/api/org/me/`, `org/dashboard/` (要件で再構築だが既存ロジックは流用候補)
- `src/components/` の組織関連 UI 部品

### 新規作成
- `src/app/(org)/` 配下 UI
- `src/app/api/org/*` (members / invites / departments / licenses / family-addon / dashboard)
- HR Webhook 受信 (`/api/webhooks/hr`)
- 関連 Edge Function (`industrial-doctor-advice`)
