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

---

## Claude Code Cloud (claude.ai/code) 動作要件

### 起動時 setup
- `.claude/settings.json` の SessionStart hook、または環境設定 UI の "Setup Script" に
  `bash scripts/setup-cccloud.sh` を登録すると依存解決される
- スクリプトは Cloud 環境のみで動作 (`CLAUDE_CODE_REMOTE` 等を検知)、ローカルでは no-op

### 環境変数
必須・任意の全変数は `.env.example` 参照。CCCloud では環境設定 UI の Environment Variables に同形式で貼り付け。
**注: 現状 CCCloud に専用シークレットストアは無し**。シークレット値は環境を編集できる人全員から見える前提で扱うこと (Stripe live key 等は CCCloud に置かない方針推奨)。

### 利用可能なコマンド (Cloud 動作可)
| 用途 | コマンド |
|---|---|
| 開発サーバー | `npm run dev` |
| Lint | `npm run lint` |
| 型チェック | `npm run typecheck` |
| Vitest unit | `npm test` |
| Playwright E2E | `npm run test:e2e` (要 PLAYWRIGHT_BASE_URL or 起動済 dev) |
| Supabase migration 確認 | `npx supabase@2.62.10 db diff` 等 |

### Cloud で **実行不可** なコマンド
- `npm run mobile:ios` / `mobile:android` (Xcode / Android SDK / シミュレータ依存)
- `eas build --local` (CocoaPods / Xcode 依存、TestFlight 提出は堀さんローカル)
- 任意の MCP ツール (ProxmoxMCP / SSH-MCP / Cloudflare 等のローカル MCP は CCCloud では未登録)

### Network 制約
CCCloud のデフォルト `Trusted` レベルでは Stripe / Supabase / Vercel API はホワイトリスト外。アクセス必要なら環境設定 > Network access で `Custom` を選び以下を追加:
```
*.supabase.co
api.stripe.com
api.vercel.com
api.x.ai
generativelanguage.googleapis.com
api.openai.com
api.resend.com
us.i.posthog.com
*.upstash.io
```
または `Full` (全許可)。

### 引き継ぎ
新セッション開始時は `docs/handover/2026-05-08.md` を Read してから着手 (リポジトリ内に複製済み、CCCloud / ローカル両方から読める)。
