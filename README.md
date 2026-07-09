<!-- ===================== 引き継ぎ (HANDOFF) ここから ===================== -->
> [!IMPORTANT]
> **🔍 コードレビュー引き継ぎ (2026-07-09) — 全面監査で 47 Issue 起票済み・修正フェーズ**
>
> homegohan を **Claude Sonnet 5 × Fable 5 の二重監査＋独立検証**で全面レビューし、GitHub Issue 47件を起票しました。
> 次の作業者は **まず統合トラッカー [#1012](https://github.com/DaisukeHori/homegohan-app/issues/1012) を読む**こと（修正順・依存関係・検証SQL・目次が全部そこにあります）。
> コードを触る前に必ず **前提作業 [#1056](https://github.com/DaisukeHori/homegohan-app/issues/1056)（未コミット4ファイルの破棄）** を消化してください。

<details>
<summary>📋 引き継ぎ全文（クリックで展開）</summary>

### 現状サマリ
- リポジトリ: `~/homegohan`（リモート `DaisukeHori/homegohan-app`）
- 監査基準: コミット済み HEAD。**作業ツリー版は使わない**
- 起票: 親トラッカー #1012 / 前提作業 #1056 / 指摘 #1013-#1055 / UX追加 #1057-#1058
- 内訳: critical 20 / high 18 / medium 7

### 着手順（#1012 のプレイブック要約）
1. **【前提】#1056** = 未コミット4ファイルを破棄（コミット済み監査修正の巻き戻しなので必ず最初に）
   ```bash
   git checkout -- \
     src/app/api/account/delete/route.ts \
     src/app/api/admin/organizations/route.ts \
     src/schemas/membership/family-invite.ts \
     src/schemas/membership/organization-invite.ts
   ```
2. **#1034 CI 整備**（型/lint/test を PR 必須 + auto-merge 制限）— 無いと以降が無検証で main 入り
3. **セキュリティ最優先**: #1013→#1014→#1015 は同根（UPDATE ポリシーの `WITH CHECK` 欠如）で1 migration にまとめる。続けて #1016-#1020（認証バイパス/IDOR/REVOKE漏れ）、#1022（レート制限）、#1036（モバイル）
4. **ハンズオンツアー連鎖**: #1027→#1026→#1025（DB→route→契約の順）
5. **機能不全**: #1023 #1024 #1028-#1030 と BH群（#1039-#1042）
6. **状態管理**: #1031（親／page と store を同時修正しないと再発）→ #1032 #1033
7. **横断/UX**: #1035（UTC日付）、D群・F群

### Issue の扱い方
- ラベル `verified` = コード上裏取り済 / `needs-verification` = 実DB状態次第
- `needs-verification`（#1020 #1025 #1026 #1027 #1028 #1040）は着手前に各Issueのコメント欄の**読み取り専用SELECT**を Supabase で1回流して確定してから直す
- 同根 finding はテーマ別に束ねてある。本文のチェックリストと相互参照（#XXXX）を辿ること

### 遵守すべきリポジトリ規約（CLAUDE.md / 設計canonical）
- `homegohan-app/` ・`.worktrees/` ・`.claude/` は無視（旧ツリー残骸。編集・参照しない）
- 構造化ログ: Next.js は `src/lib/db-logger.ts`、Edge Functions は `_shared/db-logger.ts` を必ず使う
- 栄養計算入力は `src/lib/build-nutrition-input.ts` 経由
- `signOut` の前に `src/lib/user-storage.ts` の `clearUserScopedLocalStorage()` を呼ぶ
- DDL canonical は operator/01 系 migration に単一化。`roles` は公式12種（`'banned'` 禁止）、`plan_keys` 9種、`SubscriptionStatus` 7値
- RPC は `createServerClient<Database>` で型付け（#1023 の引数不一致の再発防止）

### 環境・運用メモ
- ローカル検証: `npm run typecheck` / `npm run lint` / `npm test` / `npm run test:e2e`
- migration差分: `npx supabase@2.62.10 db diff`
- **main push で Vercel 自動デプロイ、migration/Edge Function も `deploy-supabase-*.yml` が main push で無条件適用（テストゲート無し＝#1034 で是正対象）**

### 未検証で残した前提（本番DBで最終確認推奨）
- RLS の PUBLIC 実行権限・列権限は「migration に REVOKE/GRANT が無い」ことからの推定
- `GET /api/org/invites` が参照する `organizations`/`departments`/`role`/`department_id` は migration 管理外のレガシースキーマの可能性（誤検知寄りに格下げ済み）
- `ai_consultation_*` / `ai_action_logs` / `nutrition_targets` / `health_insights` / `health_challenges` / `user_badges` の DDL・RLS がリポジトリに無い → 本番で RLS 確認し migration として取り込むこと

### 保留中の唯一のタスク
- **#1058（横断デザインシステムの完全監査）** は Claude の週次利用上限で未完。2026-07-12 18:00(JST) のリセット後に完全監査を実施し #1058 に追記する。既知分（重複コンポーネント/デッドコード/グローバルa11y基盤チェックリスト）は起票済み。

</details>
<!-- ===================== 引き継ぎ (HANDOFF) ここまで ===================== -->

# ほめゴハン (homegohan-app)

ほめゴハンの monorepo です。Web アプリ、Expo mobile アプリ、Supabase Edge Functions、共有パッケージを同じリポジトリで管理しています。

## アーキテクチャ概要

```
homegohan/
├── src/               # Next.js 14 Web アプリ (App Router)
├── apps/mobile/       # Expo / React Native モバイルアプリ (iOS / Android)
├── supabase/
│   ├── functions/     # Supabase Edge Functions (Deno)
│   └── migrations/    # DB マイグレーション
├── packages/core/     # Web / Mobile 共有ロジック
└── tests/             # Vitest テスト (e2e 以外)
    └── e2e/           # Playwright E2E テスト
```

- **Web**: Next.js + Tailwind CSS、Vercel にデプロイ
- **Mobile**: Expo (React Native)、EAS Build で iOS / Android ビルド
- **バックエンド**: Supabase (Auth / Database / Storage / Edge Functions)
- **AI**: xAI / Google Gemini / OpenAI を Next.js API Routes と Edge Functions から利用

## Requirements

- Node.js 20.x
- npm 10 以上
- Supabase プロジェクト

Node 18 では `@supabase/supabase-js` の警告が出るため、ローカル開発・CI・Vercel ともに Node 20.x を前提にしてください。

## Quick Start

```bash
# 1. 依存関係インストール
npm install

# 2. 環境変数を設定 (.env.local を作成)
#    → ENV_SETUP.md を参照

# 3. 開発サーバー起動
npm run dev
# http://localhost:3000 で確認
```

環境変数の詳細セットアップは [ENV_SETUP.md](./ENV_SETUP.md) を参照してください。

## Workspace Layout

- `src/`: Next.js Web アプリ
- `apps/mobile/`: Expo / React Native アプリ
- `supabase/functions/`: Supabase Edge Functions
- `packages/core/`: 共有ロジック
- `tests/`: Vitest テスト
- `docs/`, `SPECIFICATION.md`: 補足ドキュメント

## Useful Commands

```bash
npm run dev           # Web 開発サーバー起動
npm run build         # プロダクションビルド
npm run typecheck     # 型チェック
npm run lint          # ESLint
npm test              # Vitest ユニットテスト
npm run test:e2e      # Playwright E2E (開発サーバー自動起動)
npm run mobile:start  # モバイル Metro bundler 起動
```

## テスト

詳細な手順・環境変数設定は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

### ユニット / インテグレーション (Vitest)

```bash
# ユニットテスト
npm run test

# インテグレーションテスト (Supabase 接続が必要)
SUPABASE_INTEGRATION_TEST=1 npm run test:integration
```

`tests/e2e/` は vitest の除外対象です (`vitest.config.ts` の `exclude` を参照)。

### E2E — Web (Playwright)

```bash
# ローカル (開発サーバー自動起動)
npm run test:e2e

# MVP spec のみ高速実行
npm run test:e2e:mvp

# 本番 / ステージング環境を対象にする場合
PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e
```

E2E テスト用ユーザーの認証情報は環境変数 `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` で渡します。  
CI では GitHub Secrets に同名で登録してください。

### E2E — Mobile (Maestro)

```bash
# Maestro CLI インストール (初回のみ)
curl -Ls https://get.maestro.mobile.dev | bash

# シミュレーター起動後に実行
cd apps/mobile && maestro test maestro/
```

### モバイル Jest

```bash
cd apps/mobile && npm test
```

## CI

`.github/workflows/e2e.yml` が PR (および手動トリガー) で Playwright E2E を実行します。  
対象パス: `src/**`, `tests/e2e/**`, `playwright.config.ts`, `package.json`, `package-lock.json`。  
レポートは `playwright-report` artifact として 14 日間保持されます。

PR マージ前のチェック方針は [CONTRIBUTING.md](./CONTRIBUTING.md#テストブロッカー方針) を参照してください。

## Notes

- 認証・DB・Storage は Supabase を利用しています。
- AI 関連処理は Next.js API Routes と Supabase Edge Functions に分散しています。
- 公開文面や DB の前提を変更した場合は、コードだけでなく `SPECIFICATION.md` と `docs/` も更新してください。
- コントリビューション方法・開発フローの詳細は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。
