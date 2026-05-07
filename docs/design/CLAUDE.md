# 設計書 開発指針 (全体)

このディレクトリ (`docs/design/`) は要件定義 (`docs/requirements/`) を実装可能な詳細設計に落とした成果物。並行開発のためにドメイン別に分割している。

## ドメイン構成

| ディレクトリ | 担当範囲 | 要件参照 |
|------------|--------|---------|
| `cross/` | 全ドメイン横断 (認証 / RLS / API 規約 / a11y / DR / 法務) | 03 §16-19 |
| `family/` | 家族管理 | 01 全体 |
| `org/` | 組織管理 | 02 全体 |
| `operator/` | 運営管理 | 03 §1-15 |
| `mobile/` | モバイル App | 01 §15 |

各ドメインに `CLAUDE.md` がある。**そのドメインで作業する Claude セッションは、まずそのドメインの CLAUDE.md を読むこと**。

## 全体の設計原則

### 1. clean-build 方針
既存の中途半端な管理 UI / API は削除済み (commit `32d13e1`)。要件通りに新規構築する。`docs/design/00-existing-cleanup.md` の保持リスト (Edge Functions, dataset_recipes, 既存 meal/health API 等) は触らない。

### 2. 並行開発のための独立性
- 各ドメイン設計書は **他ドメインに直接依存しない**
- 共通要素 (plan_key / API 規約 / RLS パターン) は **cross/** に集約
- ドメイン間の結合点 (例: family が `subscription_plans.plan_key` を FK 参照) は **両方の設計書で明記**

### 3. RLS 厳格化
- 全テーブルで RLS 有効化必須
- 例外: `dataset_*` 等の公開マスター
- service_role 経由でのバイパスは Edge Function に限定し、コードレビューで監視

### 4. snake_case 統一
- DB: snake_case
- API レスポンス: snake_case (camelCase 変換層は廃止)
- TypeScript 型: Supabase 自動生成型を直接使用

### 5. 楽観的ロック + advisory lock
状態遷移を伴う API は:
- `If-Unmodified-Since` ヘッダで楽観的ロック
- 必要に応じて `pg_advisory_xact_lock` で直列化
詳細は `cross/02-rls-patterns.md`。

### 6. 監査ログ必須
全ての破壊的・課金的・セキュリティ系操作は:
- `admin_audit_logs` (運営) または `org_license_audit_log` (組織) または `family_activity_log` (家族) に記録
- `actor_id = auth.uid()` を WITH CHECK で強制
- UPDATE / DELETE は不可

## 設計書の構造規約

### ファイル命名
- 数字 prefix で順序を明示: `01-data-model.md`, `02-api-spec.md`, ...
- ハイフン区切りで小文字
- Markdown 形式

### 章構成テンプレート
```markdown
# [タイトル]

## 1. 目的・スコープ
何を解決するか、対象外は何か

## 2. 関連要件
要件定義 §XX を参照

## 3. データモデル (該当する場合)
DDL (新規 / ALTER)

## 4. API 仕様 (該当する場合)
パス・メソッド・I/O

## 5. シーケンス
Mermaid 図

## 6. エラーハンドリング

## 7. テスト方針

## 8. 既存実装との関連
保持・削除・新規

## 9. 未解決事項
```

### 図表
- シーケンス図・ER 図は Mermaid 推奨 (GitHub レンダリング対応)
- 複雑な図は `docs/design/diagrams/` に PNG/SVG 配置可

### 言語
- 日本語ベース
- DDL / TypeScript / API パスは英語
- 専門用語 (RLS / FK / Migrations 等) は英語のまま

## 横断ルール (全ドメイン共通遵守)

### A. プラン (plan_key) の参照
- 真は `subscription_plans.plan_key` (operator ドメイン定義)
- 全ての関連テーブル (`family_groups.plan_key`, `org_license_pools.plan_key`, `personal_subscriptions.plan_key`) は FK 参照、`ON UPDATE CASCADE ON DELETE RESTRICT`
- ハードコード禁止 (例外: 一部の `'free'` チェックのみ)

### B. ロール (user_profiles.roles)
公式ロール 12 種 (operator §7.1.1):
`user / support / sales / finance / content_moderator / org_member / org_viewer / org_manager / org_admin / org_industrial_doctor / admin / super_admin`

新規追加は禁止 (要件で確定済み)。

### C. 認証ヘルパー
全ての route で:
```typescript
import { requireRole, requireOrgRole } from '@/lib/auth/helpers';

const user = await requireRole(['admin', 'super_admin']);
// または
await requireOrgRole(user.id, orgId, ['org_admin', 'org_manager']);
```

詳細は `cross/01-auth-session.md`。

### D. エラーコード体系
`cross/04-api-conventions.md` のエラーコード命名規則に従う。

### E. パフォーマンス目標 (要件 §16.4)
| 指標 | 目標 |
|------|------|
| API p95 | < 500ms |
| `getUserActivePlan()` p95 | < 100ms |
| DB クエリ p95 | < 50ms |
| Lighthouse Performance | ≥ 90 |

### F. テスト戦略
- Unit: Vitest
- Integration: Vitest + Supabase Local
- E2E: Playwright (5 spec MVP → 拡充)
- a11y: @axe-core/playwright (CI 必須)

## 並行開発時の conflict 注意

### 同時編集が起きやすい箇所
1. `cross/04-api-conventions.md` の **エラーコード一覧表** — 各ドメインの新規エラーを追加する際に conflict
2. `00-architecture.md` の **ドメイン分割** — 滅多に変えない、変える場合は全 implementer に通知
3. **マイグレーション順序** (`operator/01-data-model.md` の §11.0 部分) — 番号採番で衝突注意

### 解決方法
- **エラーコード追加**: 各ドメインの設計書内で `[NEW] AUTH_FOO` と明示し、cross/* には PR レビュー時に集約
- **マイグレーション**: 新規追加は最大番号 + 1 を採番、conflict 時は人手で resequence
- **共通 lib (`@/lib/auth`, `@/lib/plan`)**: 仕様変更は cross/* PR で先行、各ドメインは追従

## 実装着手前のチェックリスト

各ドメインの実装に取り掛かる前:
- [ ] そのドメインの CLAUDE.md を読んだ
- [ ] そのドメインの設計書 8-9 ファイルを通読
- [ ] cross/* の関連設計を確認
- [ ] 要件定義の該当章を再確認
- [ ] 既存実装で残っている部分 (`docs/design/00-existing-cleanup.md` 保持リスト) を確認
- [ ] テスト戦略 (unit/integration/E2E) を計画

## 設計書の更新

設計書は **生きたドキュメント**。実装中に判明した事実があれば:
- 対象ドキュメントを更新
- PR description で何が変わったか明示
- 関連ドメインに通知 (CLAUDE.md の前提が変わった場合は重要)

設計書直接編集は **Opus / メインセッション** が原則。implementer は実装上必要な小修正のみ可、大きな仕様変更はメインに戻す。
