# E2E tests (Playwright)

## Local

```bash
# 一度だけ: ブラウザインストール
npx playwright install --with-deps chromium

# 開発サーバ自動起動 + テスト実行 (デフォルト http://localhost:3000)
npx playwright test

# UI モード
npx playwright test --ui

# 既存の Vercel preview / 本番に対して回したい場合
PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npx playwright test
```

## 認証

ログインを伴うテストは `tests/e2e/fixtures/auth.ts` の `authedPage` フィクスチャを使う:

```ts
import { test, expect } from "./fixtures/auth";

test("...", async ({ authedPage }) => {
  await authedPage.goto("/home");
  // ...
});
```

テストアカウントは環境変数で上書き可:

- `E2E_USER_EMAIL` (default: `claude-debug-1777477826@homegohan.local`)
- `E2E_USER_PASSWORD` (default: `ClaudeDebug2026!`)

## CI

| ワークフロー | 対象 | テストユーザー |
|---|---|---|
| `.github/workflows/e2e-local.yml` | PR のコード。ローカルの Supabase (`scripts/supabase-local.sh`) と本番ビルド (`next build && next start`) で、MVP のうち AI を使わない 01 / 04 / 05 を実行 | 実行ごとにローカルの DB に作る (`scripts/create-e2e-accounts.ts`、パスワードは実行ごとにランダム) |
| `.github/workflows/e2e.yml` | 本番 URL。ローカル dev server は起動しない | 本番の `e2e-user-01〜04@homegohan.test`。Secrets `E2E_USER_EMAIL` (= `e2e-user-01@homegohan.test`) / `E2E_USER_PASSWORD` が必要 (未設定ならジョブを最初に止める) |

本番のテストユーザーは、本番の service role を `.env.local` に置いて次のように作れる (パスワードは Secrets と同じ値):

```bash
E2E_USER_PASSWORD='<Secrets と同じパスワード>' npx --yes tsx@4 scripts/create-e2e-accounts.ts
```

CI では `E2E_REQUIRE_LOGIN=1` で、global-setup がログインできなければ全テストを走らせずに止める。
また、Playwright のトレースと失敗時のページスナップショット (`error-context`) は入力したパスワードを平文で含むため、
CI では取らない (`--trace off` / `PLAYWRIGHT_NO_COPY_PROMPT=1`)。HTML レポートも手順名に入力値を含むため、
artifact には上げず、`tests/e2e/.output/` (失敗時のスクリーンショット・動画・エラー内容) だけを上げる。

## NPM スクリプト

| コマンド | 内容 |
|---------|------|
| `npm run test:e2e:mvp` | **MVP 5 spec のみ** (推奨、30秒以内) |
| `npm run test:e2e` | 全 spec (探索系含む) |
| `npm run test:e2e:ui` | UI モード (デバッグ用) |
| `npm run test:e2e:report` | 前回レポート表示 |

```bash
npm run test:e2e:mvp        # MVP 5 spec のみ実行 (PR 前チェックに最適)
npm run test:e2e            # CLI 実行 (デフォルト: 本番 URL、全 spec)
npm run test:e2e:ui         # UI モード (推奨・デバッグ向け)
npm run test:e2e:headed     # ブラウザ表示
npm run test:e2e:report     # 前回レポート表示
npm run test:e2e:install    # Chromium インストール (初回のみ)
```

## MVP フロー (01-05)

| ファイル | カバーするフロー |
|---|---|
| `01-login.spec.ts` | ログイン基本動作 |
| `02-meal-photo.spec.ts` | 食事画像認識 (fixture 画像が必要: `fixtures/karaage.jpg`) |
| `03-ai-advisor.spec.ts` | AI Advisor チャット送受信 |
| `04-menu-page.spec.ts` | 献立週間表示 |
| `05-shopping-list.spec.ts` | 買い物リストモーダル URL |

### fixture 画像の準備 (02 のみ必要)

```bash
# 唐揚げ等の食事画像を配置
cp ~/Downloads/karaage.jpg tests/e2e/fixtures/karaage.jpg
```

画像が存在しない場合、`02-meal-photo.spec.ts` は自動的にスキップされます。

## バグ回帰スペック

`tests/e2e/bug-XX-*.spec.ts` の命名で 1 Issue = 1 ファイル。
各ファイル先頭に対応 Issue 番号と再現手順を JSDoc で記載する。
