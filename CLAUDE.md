# CLAUDE.md — homegohan 開発メモ

このファイルはリポジトリ固有の規約・構造メモです。

---

## テスト基盤

### ディレクトリ構成

| パス | フレームワーク | 備考 |
|------|------------|------|
| `tests/` (e2e 以外) | Vitest | `npm run test` で実行 |
| `tests/e2e/` | Playwright | `npm run test:e2e` で実行。Vitest の `exclude` 対象 |

### E2E テストの実行

```bash
# ローカル (開発サーバー自動起動)
npm run test:e2e

# 本番 / ステージング環境を対象にする場合
PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e
```

E2E 用ユーザーの認証情報: 環境変数 `E2E_USER_EMAIL` / `E2E_USER_PASSWORD`。  
CI では GitHub Secrets に登録する。

### CI

`.github/workflows/e2e.yml` が PR で自動実行。Playwright レポートは artifact として 14 日間保持。

---

## 共通ヘルパー規約

### 構造化ログ

- **Next.js (API Routes / Server Components)**: `src/lib/db-logger.ts`
- **Supabase Edge Functions**: `supabase/functions/_shared/db-logger.ts`

いずれも `app_logs` テーブルへ構造化エラーを記録するユーティリティ。新規エンドポイント・Edge Function では必ずこれを利用する。

### 栄養計算入力

`src/lib/build-nutrition-input.ts` に集約。栄養計算に必要な入力オブジェクトを組み立てる際は、このモジュールを経由する。直接構築しない。

### localStorage クリーンアップ

`src/lib/user-storage.ts` の `clearUserScopedLocalStorage()` を使う。  
サインアウト処理では **Supabase signOut を呼ぶ前に** このヘルパーを実行する。

---

## 無視対象

`homegohan-app/` ディレクトリ (旧ツリーの残骸) は無視する。編集・参照しない。
