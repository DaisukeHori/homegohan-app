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

## バグ回帰スペック

`tests/e2e/bug-XX-*.spec.ts` の命名で 1 Issue = 1 ファイル。
各ファイル先頭に対応 Issue 番号と再現手順を JSDoc で記載する。
