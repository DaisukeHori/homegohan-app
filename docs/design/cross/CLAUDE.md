# cross/ 横断設計 開発指針

全ドメイン共通の設計ドキュメント群。**他ドメインの設計書はここを参照する**。

## ファイル一覧

| ファイル | 担当範囲 | 要件参照 |
|---------|--------|---------|
| `01-auth-session.md` | 認証 / セッション / 2FA / SSO / 子供同意 | 03 §17 |
| `02-rls-patterns.md` | RLS 共通パターン / 楽観的ロック / advisory lock | 全要件 |
| `03-design-system.md` | デザイントークン / コンポーネント基底 / ダークモード | 03 §21 |
| `04-api-conventions.md` | API パス規約 / エラーコード / pagination / バージョニング | 03 §19 |
| `05-i18n-a11y.md` | next-intl / WCAG 2.1 AA / アクセシビリティ細部 | 03 §16.1-2 |
| `06-perf-cache.md` | パフォーマンス目標 / Upstash Redis / レート制限 | 03 §16.4 §22.1-2 |
| `07-dr-backup.md` | 災害復旧 / バックアップ / リージョン | 03 §16.5 §22.8 |
| `08-legal-compliance.md` | 特商法 / インボイス / GDPR / 利用規約 / 医療免責 | 03 §18 |

## このドメインの役割

横断設計は **他ドメインに先行して確定** すべき。理由:
- ドメイン設計が cross/* に依存する (例: family が `requireOrgRole` を呼ぶ)
- API 規約・エラーコード・RLS パターンが揃っていないと並行開発が衝突する

## 設計原則

### 1. 仕様の集約
複数ドメインで共通する設計は **必ず cross/** に書く。各ドメインは参照のみ。
- ✅: `requireOrgRole()` の仕様 → `01-auth-session.md`
- ❌: 各ドメイン設計書で個別に再定義

### 2. 後方互換性
cross/* の変更は全ドメインに波及する。**仕様変更は最終手段**:
- 追加 (新ロール / 新エラーコード) は OK、既存変更は NG (代わりに deprecate ラベル付き廃止予告)

### 3. 可読性優先
- 各ファイル 500 行以下を目安
- 表・図を多用
- 各セクションは独立して読めるように

## 他ドメインからの参照

family / org / operator / mobile は cross/* を以下のように参照:

```markdown
## 認証
全 API で `cross/01-auth-session.md` の §3 認可パターンに従う。
```

逆に cross/* は **特定ドメインに依存しない** こと。例外:
- `subscription_plans` は operator ドメインの主管だが、cross/02-rls-patterns.md で RLS パターンの例として参照する

## テスト

cross/* の仕様は **共通ライブラリ** (`src/lib/auth`, `src/lib/plan`, `src/lib/cache`) として実装される。

テスト戦略:
- 各 lib に対して unit test 必須
- 共通 RLS パターンは Supabase Local で integration test
- a11y テストは @axe-core/playwright

## 完了基準

cross/* の設計書 8 ファイルすべてが以下を満たすこと:
- 関連要件 (要件 §XX) を明示
- 実装に必要な情報が揃っている (DDL / API / lib インターフェース)
- ドメイン設計者が読んで参照できる
