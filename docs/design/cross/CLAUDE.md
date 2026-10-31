# cross/ 横断設計 開発指針

全ドメイン共通の設計ドキュメント群。**他ドメインの設計書はここを参照する**。

## ファイル一覧

| ファイル | 担当範囲 | 要件参照 |
|---------|--------|---------|
| `01-auth-session.md` | 認証 / セッション / 2FA / SSO (§12 の子供同意は `14-parental-consent.md` へ移した) | 03 §17 |
| `02-rls-patterns.md` | RLS 共通パターン / 楽観的ロック / advisory lock | 全要件 |
| `03-design-system.md` | デザイントークン / コンポーネント基底 / ダークモード | 03 §21 |
| `04-api-conventions.md` | API パス規約 / エラーコード / pagination / バージョニング | 03 §19 |
| `05-i18n-a11y.md` | next-intl / WCAG 2.1 AA / アクセシビリティ細部 | 03 §16.1-2 |
| `06-perf-cache.md` | パフォーマンス目標 / Upstash Redis / レート制限 | 03 §16.4 §22.1-2 |
| `07-dr-backup.md` | 災害復旧 / バックアップ / リージョン | 03 §16.5 §22.8 |
| `08-legal-compliance.md` | 特商法 / インボイス / GDPR / 利用規約 / 医療免責 | 03 §18 |
| `09-testing.md` | テスト戦略統合 (Unit/Integration/E2E、CI/CD、モック、E2E シナリオ網羅) | 03 §16.4 §22.3 + 100-scenarios.md |
| `12-operator-mfa.md` | 運営ロールの MFA (TOTP・AAL2 の入口・バックアップコード・解除) | #1176 |
| `13a-legal-consent-api-server.md` | 規約の同意ゲートを `/api` に掛ける (middleware の `/api` の分岐・許可リスト・`GET /api/legal/status`・`packages/shared` の判定と文面) | 08 §7.2 |
| `13b-legal-consent-mobile.md` | 規約の同意ゲートをモバイルのネイティブの画面にも掛ける (ルートのゲートが、同意が要る間はアプリの画面を Web の `/legal-consent` の WebView の route 1 つに畳む・`legal-consent-accepted` の合図) | 13a |
| `14-parental-consent.md` | 未成年の年齢確認と保護者の同意 (生年月日・`parental_consents`・同意ゲートの判定) | #1173 |
| `15-data-subject-requests.md` | 開示・訂正・利用停止の請求の受付 (表・本人と運営の経路・応答期限) | #1178 |
| `16-auth-history-sessions.md` | ログイン履歴・不審ログインの通知・セッションの一覧と失効・パスワードの再利用の防止 | #1190 #1189 #1198 |
| `17-backup-automation.md` | 長期バックアップの自動化と DR 訓練の記録 | #1129 #1191 |
| `18-csp-nonce.md` | 本番の CSP の nonce 方式・違反の報告の受け口 | #1169 |
| `19-private-photo-buckets.md` | 食事写真と冷蔵庫写真のバケットを非公開にする (公開 URL を使う経路の全列挙・保存済みの URL の扱い) | #1365 |
| `20-terms-privacy-text.md` | 利用規約・プライバシーポリシーの全文 (逐語の正典)・各条項 ⇄ 製品の根拠・版の上げ方 | #1901 |
| `21-recipe-author-display-name.md` | 公開レシピの作者の表示名 (SECURITY DEFINER の関数 `recipe_author_display_names` で公開の作者だけ・本人の選択・凍結と年齢・同意した版の扱い) | #1917 の続き (実装済み: 段 A #2158・段 B #2159・文面は #1997) |
| `22-dish-favorites.md` | 献立の料理のお気に入り (料理の写しを本人だけの表 `dish_favorites` に・名前の鍵で 1 件・お気に入りの画面の詳細) | #2011 |
| `23-planned-meals-score-integrity.md` | `planned_meals` の `veg_score` / `is_completed` / `completed_at` をサーバの計算値だけにする (列の権限・完了の RPC・写真の解析の service_role) | #2025 |
| `24-freeze-notify-mail.md` | 運営の凍結の通知メール (凍結した本人へ `account_frozen` を送信待ちに積む・画面のチェックと任意のメッセージ・監査と応答に結果) | #2026 |

10・11 は欠番 (13a は分冊前の 13 の番号を引き継いでいる)。

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
