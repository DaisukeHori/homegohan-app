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
| `09-testing.md` | テスト戦略統合 (Unit/Integration/E2E、CI/CD、モック、E2E シナリオ網羅) | 03 §16.4 §22.3 + 100-scenarios.md |
| `12-operator-mfa.md` | 運営ロールの MFA (TOTP・AAL2 の入口・バックアップコード・解除) | 01 §3.1・#1176 |
| `13a-legal-consent-api-server.md` | 規約の同意ゲートを `/api` に掛ける (middleware の `/api` の分岐・許可リスト・`GET /api/legal/status`・`packages/shared` の判定と文面) | 08 §7.2 |
| `14-parental-consent.md` | 未成年の年齢確認と保護者の同意 (生年月日・`parental_consents`・同意ゲートの判定) | 03 §17.10・#1173 |
| `15-data-subject-requests.md` | 開示・訂正・利用停止の請求の受付 (表・本人と運営の経路・応答期限) | 08・#1178 |
| `18-csp-nonce.md` | 本番の CSP の nonce 方式・違反の報告の受け口 | #1169 |

10・11 は欠番 (13a は分冊前の 13 の番号を引き継いでいる)。16・17 は並行して設計中の冊が使う。

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
