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
