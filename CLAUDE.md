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

## Supabase 本番スキーマ変更ポリシー

本番 Supabase (project `flmeolcfutuwwbjmzyoz`) へのスキーマ変更は、必ず `supabase/migrations/*.sql` をファイル化して PR 経由でコミットすること。

**禁止**: Supabase MCP の `apply_migration` やダッシュボードの SQL Editor で本番に直接 DDL を当てること。

理由: #1064 で、秒精度のタイムスタンプ版 migration (MCP `apply_migration` 由来) とリポジトリの丸め連番版 migration がズレて `supabase db push` が全ブロックし、2 ヶ月間デプロイできない状態になった実例がある。スキーマ変更は必ずファイル化 → PR → CI の migration drift 検知を通すこと。

---

## Claude Code Cloud (claude.ai/code) 動作要件

### 基本方針
- クラウド環境は **本番 Supabase に接続しない**。開発・テストは Docker 上のローカル Supabase で行う。
- 本番へのスキーマ反映は PR → main マージ → `deploy-supabase-migrations.yml` (CI) のみ。Edge Functions も `deploy-supabase-functions.yml` が main push で反映する。
- 本番の状態調査は **読み取り専用 Supabase コネクタ** (`https://mcp.supabase.com/mcp?project_ref=flmeolcfutuwwbjmzyoz&read_only=true`) のみ使う。書き込み可能な Supabase コネクタはこのリポジトリのセッションでは使わない。
- 本番 / ステージングへの E2E は CI (`e2e.yml`) を起動し、結果を `gh run view` で読む。
- 本番データの修正 (stuck ジョブ掃除・embedding 再生成等) はクラウドで行わず、堀さんのローカル Mac で実施する。

### 起動時 setup
- 環境の「セットアップスクリプト」: Node 20 / gh / Supabase CLI 2.62.10 / Deno をインストール (環境キャッシュされる)
- `.claude/settings.json` の SessionStart hook: `scripts/setup-cccloud.sh` (npm ci 等)。ローカルでは no-op
- integration test / dev server を使う前に `bash scripts/cccloud-supabase-local.sh` を実行するとローカル Supabase が起動し `.env.local` が生成される

### 環境変数・シークレット
- 環境変数欄にはシークレットを入れない (環境を使う全員に見える)。
- AI キー (Gemini / xAI / OpenAI) は環境設定の **「API認証情報」** に登録し、プロキシがヘッダを付与する。コードの未設定チェックを通すため環境変数側にはダミー値 `injected-by-proxy` を入れる。Edge Functions 用には `cccloud-supabase-local.sh` が `supabase/functions/.env` に同じ値を書き出す。
- **Stripe キーは入れない**。本番 (Vercel / Supabase secrets) にも未設定で、未設定時の mock モードが正。ダミーを入れると price-change が「Stripe 同期必須」扱いになり 502 になる。
- 本番の `GEMINI_IMAGE_MODEL` は `gemini-2.5-flash-image` (2026-10 時点、Vercel production)。
- 環境変数に `NEXT_PUBLIC_SUPABASE_URL` 等の Supabase 系・`PLAYWRIGHT_BASE_URL`・`TZ`・`GH_TOKEN` は **入れない** (前 2 つは .env.local より優先されローカル Supabase / ローカル dev に向かなくなる。TZ は CI が UTC 前提、GH_TOKEN は GitHub プロキシが認証する)。

### 利用可能なコマンド (Cloud 動作可)
| 用途 | コマンド |
|---|---|
| ローカル Supabase 起動 | `bash scripts/cccloud-supabase-local.sh` |
| 開発サーバー | `npm run dev` |
| Lint | `npm run lint` |
| 型チェック | `npm run typecheck` |
| Vitest unit | `npm test` (シークレット不要) |
| Vitest integration | `npx vitest run --config vitest.integration.config.ts` (要ローカル Supabase) |
| Playwright E2E (ローカル) | `npm run test:e2e` (要 `npx playwright install chromium`) |
| migration 新規作成 | `supabase migration new <name>` → `supabase db reset` で全適用確認 |
| CI 結果確認 | `gh run list` / `gh run view <id> --log-failed` |

### Cloud で **実行不可** なコマンド
- `npm run mobile:ios` / `mobile:android` (Xcode / Android SDK / シミュレータ依存)
- `eas build --local` (CocoaPods / Xcode 依存、TestFlight 提出は堀さんローカル)
- ローカル MCP (ProxmoxMCP / SSH-MCP / Cloudflare 等)
- 本番 Supabase への `supabase link` / `db push` (鍵を置かない方針)

### Network
環境のネットワークアクセスは `Custom` (デフォルトリスト込み) + `deno.land` / `dl.deno.land` / `jsr.io` / `esm.sh` / `homegohan-app.vercel.app`。
Supabase のローカルイメージ (public.ecr.aws) と Gemini (`*.googleapis.com`) はデフォルトリストに含まれる。API認証情報に登録したホストはネットワーク設定と無関係に到達可能。

### 引き継ぎ
新セッション開始時は `docs/handover/2026-05-08.md` を Read してから着手 (リポジトリ内に複製済み、CCCloud / ローカル両方から読める)。
