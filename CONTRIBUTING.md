# Contributing Guide

homegohan monorepo への貢献ガイドです。

---

## 目次

- [環境変数セットアップ](#環境変数セットアップ)
- [ローカルテスト実走手順](#ローカルテスト実走手順)
- [PR 開発ワークフロー](#pr-開発ワークフロー)
- [テストブロッカー方針](#テストブロッカー方針)

---

## 環境変数セットアップ

プロジェクトルートに `.env.local` を作成します (`git` にはコミットしないこと)。

詳細な取得手順は [ENV_SETUP.md](./ENV_SETUP.md) を参照してください。

### 必須キー一覧

```env
# Supabase (Web / API Routes)
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# E2E テストユーザー (Playwright / Maestro)
E2E_USER_EMAIL=<test-user@example.com>
E2E_USER_PASSWORD=<password>

# AI
XAI_API_KEY=<xai-key>
GOOGLE_AI_STUDIO_API_KEY=<google-ai-key>
OPENAI_API_KEY=<openai-key>

# Cron 認証
CRON_SECRET=<random-32-chars>
```

### インテグレーションテスト追加キー

インテグレーションテスト (`tests/integration/`) の接続先は **ローカルの Supabase スタック** です。本番や共有の Supabase には向けないでください。

必要な変数 (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_INTEGRATION_TEST=1` など) は、
`bash scripts/supabase-local.sh env .env.local` がローカルスタックの値で `.env.local` に書き出します。
手順は下の「Vitest — インテグレーションテスト」を参照してください。

### モバイル (Expo)

`apps/mobile/.env.local` または `apps/mobile/env.example` を参考に設定します。  
`EXPO_PUBLIC_` プレフィクスはクライアントバンドルに含まれるため、秘密情報を入れないでください。

```env
EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000
```

---

## ローカルテスト実走手順

### 型チェック / Lint

```bash
npm run typecheck
npm run lint
```

### Vitest — ユニットテスト

```bash
npm run test
```

`tests/` 配下の `.test.ts` / `.spec.ts` を実行します (`tests/e2e/` は除外)。

### Vitest — インテグレーションテスト

`tests/integration/` のテストは、**ローカルの Supabase スタック** と **ローカルの Next dev サーバ** に対して実行します。
テストはユーザーや業務データを作成・削除するため、**本番の Supabase には絶対に向けないでください**。

```bash
# 1. ローカル Supabase を起動し (初回はイメージ取得で数分)、接続情報を .env.local に書き出す
bash scripts/supabase-local.sh start
bash scripts/supabase-local.sh env .env.local

# 2. Next dev サーバを起動する (別ターミナル。既定は http://localhost:3000)
npm run dev

# 3. テストを実行する。対象のパスを渡して絞り込める (パスの部分一致)
npm run test:integration -- tests/integration/operator/admin-
npx vitest run --config vitest.integration.config.ts tests/integration/rls tests/integration/security
```

- `bash scripts/supabase-local.sh env .env.local` は `.env.local` を **上書き** します (既存のファイルは `.env.local.bak.<時刻>` に退避されます)。
  開発用に別の接続先を `.env.local` に入れている場合は、テストが終わったら退避したファイルを戻してください。
- 実行前に `.env.local` の `NEXT_PUBLIC_SUPABASE_URL` が `http://127.0.0.1:54321` であることを確認してください。
- dev サーバを別のポートで起動したときは `INTEGRATION_BASE_URL=http://localhost:3001` を付けて実行します。
- `supabase start` / `supabase db reset` をリポジトリの `supabase/` に対して直接実行しないでください。必ず `scripts/supabase-local.sh` を経由します (理由は [CLAUDE.md](./CLAUDE.md) の「ローカル / CI の Supabase」)。
  migration を追加・変更したら `bash scripts/supabase-local.sh reset` で作り直します。
- テストは自分で作ったデータを後片付けしますが、途中で中断するとローカル DB にデータが残ることがあります。そのときは `bash scripts/supabase-local.sh reset` で戻します。
- CI では `.github/workflows/security-regression.yml` が同じ手順で `tests/integration/rls`・`tests/integration/security`・`tests/integration/handson-tour`・`tests/integration/operator` (運営コンソール API。`admin-*` / `auth-boundary` / `super-admin-*`) を実行します。
  実行するファイルは vitest に渡すパスの文字列 (部分一致) で選んでいるため、新しい結合テストを足すときは、ファイル名を既存の指定に合わせてください。どの指定にも当たらないファイルは CI で動かないので、`tests/integration-ci-coverage.test.ts` が検出して落ちます。
- 失敗が既知の不具合によるテストは `it.fails` で書いてあります (`[既知の不具合]` と題名に付く)。不具合を直したら、そのテストの `.fails` を外してください。

### Playwright — E2E テスト (Web)

```bash
# 開発サーバーを自動起動してテスト
npm run test:e2e

# MVP spec のみ高速実行 (spec 01-05)
npm run test:e2e:mvp

# 既存サーバー / ステージング環境を対象にする場合
PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e

# インタラクティブ UI モード
npm run test:e2e:ui

# 特定の spec のみ実行
npx playwright test tests/e2e/01-login.spec.ts

# レポートを UI で確認
npm run test:e2e:report
```

初回のみ Playwright ブラウザのインストールが必要です。

```bash
npm run test:e2e:install
```

### フルスイートを CI で手動実行する場合

認証必須テストを含むフルスイートは GitHub Actions の `workflow_dispatch` で実行します。

1. GitHub リポジトリの Actions タブを開く
2. `e2e` ワークフローを選択
3. "Run workflow" から `full_suite=true` を指定して実行

### Mobile — Jest ユニットテスト

```bash
cd apps/mobile && npm test
```

### Mobile — Maestro E2E テスト (iOS / Android)

Maestro CLI のインストール:

```bash
curl -Ls https://get.maestro.mobile.dev | bash
```

シミュレーター (または実機) を起動した状態で実行:

```bash
cd apps/mobile

# 全フロー
maestro test maestro/

# 特定フロー
maestro test maestro/smoke.yaml
maestro test maestro/auth-flow.yaml
```

テストユーザーのデータリセット (テスト前に推奨):

```bash
npm run test:e2e:reset-data
```

---

## PR 開発ワークフロー

### ブランチ命名

```
<type>/<short-desc>
```

`type` は Conventional Commits に準拠します。

| type | 用途 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `test` | テスト追加・修正 |
| `docs` | ドキュメント |
| `refactor` | リファクタリング |
| `chore` | その他の保守作業 |

例:

```
feat/family-09-graduation-badge
test/coverage-recovery-T01-unit
fix/e2e-login-timeout
docs/contributing-readme-refresh
```

### PR タイトル

Conventional Commits prefix + 日本語サマリ の形式にします。

```
feat(family/09): Web Step 4 卒業バッジに disclaimer 追加
fix(e2e): Playwright login spec タイムアウト修正
test(operator): super-admin integration test 拡充
```

### コミットメッセージ

Conventional Commits 形式 + 日本語サマリを使用してください。

```
feat: 新機能の概要
fix: バグ修正の概要
test: テスト追加・修正
chore: 雑務・設定変更
```

### 並列開発時の隔離

複数の実装を並列で進める場合は `git worktree` で作業ツリーを分離してください。  
同一ブランチを共有すると未コミット変更が混入する原因になります。

```bash
# worktree を追加
git worktree add ../<dir-name> -b <branch-name>

# 作業後の削除
git worktree remove ../<dir-name>
```

---

## テストブロッカー方針

PR マージ前の必須・推奨チェックは以下の通りです。

### 必須 (PR マージブロッカー)

- `npm run typecheck` — 型エラーなし
- `npm run lint` — lint エラーなし
- `npm run test` — 変更に関連するユニットテストがすべてパス

### 推奨

- `npm run test:e2e:mvp` — MVP E2E spec (02-05) がパス

> **注意**: CI (GitHub Actions) でも PR トリガーで同じ MVP スイートが自動実行されます。  
> ただし CI コスト削減のため、将来的に PR トリガーの E2E を一時停止する場合は  
> ローカル実行結果を PR 本文に貼り付けて確認を取ってください。

### 任意 (GitHub Secrets 必要)

- E2E spec 01 (login spec) — `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` が必要なため、CI の GitHub Secrets が設定されている場合のみ実行

### CI

`.github/workflows/e2e.yml` が PR で Playwright E2E を自動実行します。  
対象パス: `src/**`, `tests/e2e/**`, `playwright.config.ts`, `package.json`, `package-lock.json`。  
レポートは `playwright-report` artifact として 14 日間保持されます。
