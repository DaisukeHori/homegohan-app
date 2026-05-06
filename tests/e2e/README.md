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

`.github/workflows/e2e.yml` が `pull_request` と `workflow_dispatch` で動く。
本番 URL に対して走るため、ローカル dev server は起動しない。

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
