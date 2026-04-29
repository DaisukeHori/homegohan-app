# homegohan-app

ほめゴハンの monorepo です。Web アプリ、Expo mobile アプリ、Supabase Edge Functions、共有パッケージを同じリポジトリで管理しています。

## Requirements

- Node.js 20.x
- npm 10 以上
- Supabase プロジェクト

Node 18 では `@supabase/supabase-js` の警告が出るため、ローカル開発・CI・Vercel ともに Node 20.x を前提にしてください。

## Workspace Layout

- `src/`: Next.js Web アプリ
- `apps/mobile/`: Expo / React Native アプリ
- `supabase/functions/`: Supabase Edge Functions
- `packages/core/`: 共有ロジック
- `tests/`: Vitest テスト
- `docs/`, `SPECIFICATION.md`: 補足ドキュメント

## Setup

1. 依存関係をインストールします。

```bash
npm install
```

2. 環境変数を設定します。

- セットアップ手順: [ENV_SETUP.md](./ENV_SETUP.md)
- 参考: [SETUP_ENV.sh](./SETUP_ENV.sh)

3. 開発サーバーを起動します。

```bash
npm run dev
```

Web アプリは `http://localhost:3000` で確認できます。

## Useful Commands

```bash
npm run dev
npm run build
npm test
npm run lint
npm run mobile:start
```

## テスト

### ユニット / インテグレーション (Vitest)

```bash
npm run test
```

`tests/e2e/` は vitest の除外対象です (`vitest.config.ts` の `exclude` を参照)。

### E2E (Playwright)

ローカル (開発サーバー自動起動):

```bash
npm run test:e2e
```

既存サーバー・本番環境に対して実行する場合は `PLAYWRIGHT_BASE_URL` を指定します:

```bash
PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e
```

E2E テスト用ユーザーの認証情報は環境変数 `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` で渡します。  
CI では GitHub Secrets に同名で登録してください。

## CI

`.github/workflows/e2e.yml` が PR (および手動トリガー) で Playwright E2E を実行します。  
対象パス: `src/**`, `tests/e2e/**`, `playwright.config.ts`, `package.json`, `package-lock.json`。  
レポートは `playwright-report` artifact として 14 日間保持されます。

## Notes

- 認証・DB・Storage は Supabase を利用しています。
- AI 関連処理は Next.js API Routes と Supabase Edge Functions に分散しています。
- 公開文面や DB の前提を変更した場合は、コードだけでなく `SPECIFICATION.md` と `docs/` も更新してください。
