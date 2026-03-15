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

## Notes

- 認証・DB・Storage は Supabase を利用しています。
- AI 関連処理は Next.js API Routes と Supabase Edge Functions に分散しています。
- 公開文面や DB の前提を変更した場合は、コードだけでなく `SPECIFICATION.md` と `docs/` も更新してください。
