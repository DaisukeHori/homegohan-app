> ⚠️ **重要**: 本ディレクトリは部分的に [`docs/design/membership/`](../membership/) によって supersede されました (2026-05-10)。
>
> ### membership/ で canonical となった範囲 (本ドキュメントの記述は参考用)
> - 招待発行・受諾・拒否フロー
> - メンバ管理 (追加・除名・脱退)
> - 役割定義 (family: representative/adult/child)
> - 代表譲渡フロー
> - ペースト機能 (家族間レコード共有)
> - 閲覧権限 (share_meals/share_health/share_menu)
> - 運営強制操作
>
> ### 本ドキュメントが引き続き有効な範囲
> - データモデルの core 構造 (テーブル基本定義、関連カラム)
> - plan_key / member_limit / 課金関連 (operator/ 設計と整合)
> - その他の運用・UI ガイドライン (招待関連以外: 献立リクエスト、買い物リスト、子供メンバー管理、18 歳移行、グループ分割等)

# family/ 家族管理ドメイン 開発指針

要件定義 `docs/requirements/01-family-management.md` の詳細設計。

## ファイル一覧

| ファイル | 担当範囲 | 要件参照 |
|---------|--------|---------|
| `01-data-model.md` | DDL (family_groups / members / invites / shared_menus / shopping_lists / meal_requests / activity_log) + ER 図 | 01 §7 |
| `02-api-spec.md` | 全 API の I/O (REST + Server Actions) | 01 §8 |
| `03-ui-spec.md` | 画面仕様 + コンポーネント階層 | 01 §9 |
| `04-meal-request-flow.md` | 個別献立リクエスト 4 パターン状態機械詳細 | 01 §5.5.5 |
| `05-shared-menu-engine.md` | 共有献立 AI 生成ロジック (constraints 和集合) | 01 §5.5 |
| `06-shopping-list.md` | 共有買い物リスト (active partial unique) | 01 §5.6 §7.1.7 |
| `07-lifecycle.md` | 凍結 / 子供成長 / グループ分割 / 大人代理 | 01 §5.5.5 §7.6-7.8 |
| `08-rls-policies.md` | RLS ポリシー一覧 (具体的 SQL) | 01 §7.1.3 §7.4 §7.7 |

## ドメインの役割

家族グループ単位での食事管理:
- 1 ユーザーが 1 owner グループ + 複数 member グループ
- 共有献立 / 個別献立リクエスト / 買い物リスト
- 子供メンバー (user_id NULL) の代理操作
- 18 歳到達時の独立アカウント移行
- 離婚等でのグループ分割

## 主要シーケンス

### 個別献立リクエスト (4 パターン)
- パターン①: 妻が自分で別メニューを決める (UC-FAM-11)
- パターン②: 妻が AI に代替案を依頼 (UC-FAM-12)
- パターン③: 妻が夫にリクエスト「これ作って」 (UC-FAM-13)
- パターン④: 親が子供の代理で決定 (UC-FAM-14)

詳細は `04-meal-request-flow.md`。

### 退職時の家族グループ凍結
組織同梱ライセンス (`source_org_assignment_id` 経由) のグループは、退職者の `org_license_assignments.revoked_at` セット時に:
- `family_groups.status = 'frozen'`
- 30 日 grace period
- 個人プラン移行 / 譲渡 / 解散から選択

詳細は `07-lifecycle.md` + `org/05-offboarding-flow.md`。

## ドメイン設計原則

### 1. RLS 厳格
全テーブルで RLS 必須。子供メンバー (`user_id IS NULL`) も含めて漏れない設計。
- INSERT は `family_meal_requests_insert` ポリシーで target_member の同グループ確認
- SELECT は同グループメンバーのみ (家族プライバシー)

### 2. プラン依存
- `family_groups.plan_key` は `subscription_plans` への FK
- `family_basic` (4 名) / `family_pro` (8 名) / `family_addon` (組織同梱)
- メンバー追加時は `member_limit` チェック

### 3. 子供メンバーの特殊性
- `family_members.user_id IS NULL` で子供を表現
- `parental_consents` テーブルで親同意記録 (13 歳未満は COPPA、18 歳未満は日本)
- 18 歳到達バッチで親に移行通知

### 4. 楽観的ロック
状態遷移を伴う API (migrate-to-personal / transfer-ownership / dissolve / split) は:
- `If-Unmodified-Since` ヘッダ必須
- `pg_advisory_xact_lock` で直列化
詳細は `cross/02-rls-patterns.md`。

## 他ドメインとの依存

| 依存先 | 用途 |
|-------|------|
| `cross/01-auth-session.md` | 認証 / 子供同意 (parental_consents) |
| `cross/02-rls-patterns.md` | RLS テンプレート / advisory lock |
| `cross/04-api-conventions.md` | API 規約 / エラーコード |
| `operator/01-data-model.md` | `subscription_plans.plan_key` への FK |
| `org/05-offboarding-flow.md` | UC-ORG-17 退職時の家族凍結トリガー元 |

## このドメインから他ドメインへの提供

| 提供先 | 内容 |
|-------|------|
| `org/06-industrial-doctor.md` | 産業医は **家族領域のデータを閲覧不可** という境界 |
| `mobile/02-deep-link.md` | `homegohan://invite/family/{token}` の受諾画面要件 |

## テスト戦略

- **Unit**: state machine (meal_request) ロジック / アレルゲン突合 / 18 歳到達検知
- **Integration**: Supabase Local で family RLS 全パターン
- **E2E**: 主要シナリオ (招待 → 献立リクエスト → 承認 → 買い物リスト同期) を Playwright

詳細は各設計書の §7 テスト方針セクション。

## 既存実装との関連

### 削除済み (clean-build)
- `src/app/api/family/groups/`, `src/app/api/family/members/` (commit `32d13e1`)

### 保持
- `src/app/api/meals/`, `meal-plans/`, `food-recognition/` 等 (要件 01 §15.3)
- `apps/mobile/` (要件 01 §15)
- 既存 `family_groups` / `family_members` テーブル (Supabase ダッシュボード DROP 後、新 DDL で再構築)

### 新規作成
- `src/app/(family)/` 配下 UI
- `src/app/api/family/*` (groups / members / invites / meal-requests / shared-menus / shopping-list)
- 関連 Edge Functions (`family-meal-ai-propose`, `family-shared-menu-generate`)
