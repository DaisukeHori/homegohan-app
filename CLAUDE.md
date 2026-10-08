# CLAUDE.md — homegohan 開発メモ

このファイルはリポジトリ固有の規約・構造メモです。

---

## 会話の言語 (必須)

ユーザーとのやり取りは **必ず日本語** で行う。返答・進捗報告・質問 (選択肢を含む)・最終報告のすべてが対象。
GitHub に書く PR の説明・Issue / PR のコメント・コミットメッセージの本文も日本語で書く。
コード・SQL・コマンド・識別子・エラーメッセージなど、原文のまま示すべきものは英語のままでよい。

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

### 利用者が指定した宛先へのメール送信

利用者が指定したアドレスへメールを送る処理 (招待・参加リクエスト・譲渡提案など) は、必ず `src/lib/membership/invite-throttle.ts` の送信回数制限を通す (#1163。`tests/email-send-throttle-contract.test.ts` が検査する)。

### レート制限

`src/lib/rate-limit.ts` に集約する (#1197)。新しい制限は `RateLimitCategory` にカテゴリを足し、`checkRateLimit(key, category)` で判定する。route ごとに Upstash / in-memory の制限を自前で作らない (`tests/rate-limit-single-implementation.test.ts` が `@upstash/ratelimit` を使うファイルを検査する)。key は認証で確定した ID を使い、ログイン前の公開 API (お問い合わせ) だけクライアント IP を使う。

### PostHog の既定ホスト

`packages/shared` の `POSTHOG_DEFAULT_HOST` に集約する (#1197)。Web・モバイルのコードはこれを import し、ホストの文字列を直接書かない。素の Node ESM の `next.config.mjs` と `.env.example` だけは同じ値のリテラルが残るので、ホストを変えるときは 3 か所を合わせる (`src/__tests__/config/posthog-default-host.test.ts` が検査する)。

### 栄養計算入力

`src/lib/build-nutrition-input.ts` に集約。栄養計算に必要な入力オブジェクトを組み立てる際は、このモジュールを経由する。直接構築しない。

### localStorage クリーンアップ

`src/lib/user-storage.ts` の `clearUserScopedLocalStorage()` を使う。  
サインアウト処理では **Supabase signOut を呼ぶ前に** このヘルパーを実行する。

---

## Web アプリは Next 14 + React 18 (React 19 / Next 15 前提の API は使わない)

- Web アプリ (`src/`) は **Next.js 14 + React 18** で動く。React 19 / Next 15 ではない (モバイルの `apps/mobile` だけが Expo 53 + React 19)。`docs/design/` には Next 15 / React 19 前提の記述が残っているが、実装の現状はこの節が正。
- **React 19 / Next 15 前提の API は `src/` で使わない**: `use` / `useActionState` / `useOptimistic` (`react`)、`useFormStatus` (`react-dom`)。ESLint の `no-restricted-imports` と `no-restricted-properties` が `src/**` で止める (#1199)。`import * as React from 'react'` も同じルールに掛かるので、名前付き import (`import { useState } from 'react'`) を使う。`import React from 'react'` のあとの `React.use(...)` なども止まる。
  - 禁止する理由は、Next 15 / React 19 前提の書き方を持ち込まないため。Next 14 の App Router が同梱する React (canary) には `use` / `useOptimistic` / `useFormStatus` が実在するが、`useActionState` は無く、Next 14 の `params` は Promise ではない。
  - ルールの対象は `src/**` だけ。モバイルと、ルート直下の `components/` ・ `lib/` (`@/` の別名の逃げ先 `./*` 経由で Web からも使われる) は対象外。そこにも React 19 / Next 15 前提の API を書かない。
- **型検査ではこれらを止められない。止めているのは上の ESLint ルールだけなので、外さないこと。** Next 14 の型 (`next/types/index.d.ts`) が `react/experimental` と `react-dom/experimental` (canary の型) を読み込むため、`@types/react` が 18 系でも `use` / `useOptimistic` / `useActionState` / `useFormStatus` は `npm run typecheck` を通る。この前提は `tests/eslint-react19-guard.test.ts` が確かめる。
- Next 14 のページでは `params` は Promise ではなく普通のオブジェクト。`use(params)` は実行時に例外になる (#1275)。クライアントページでは `useParams()` を使う。
- 型の版は実行時の React にそろえてある。ルート `package.json` の `@types/react` / `@types/react-dom` は **18 系**。これで React 19 の型にしかない書き方 (例: `<Context value={...}>`) は型検査で落ちる (上の API は止まらない)。モバイルは自前の `@types/react ~19.0.10` を `apps/mobile/node_modules` に入れ子で持ち、`apps/mobile/tsconfig.json` の `paths` で `react` の型をそれに固定している (外すとモバイルの型エラーが増える)。ルートの型だけを 19 系に上げない。`tests/react-types-version-contract.test.ts` が検査する。
- React 19 / Next 15 への移行は別タスク。やるときは `react` と `@types/react` を一緒に上げ、`eslint.config.mjs` のルールとそのテスト (`tests/eslint-react19-guard.test.ts`)、`apps/mobile/tsconfig.json` の固定、この節も更新する。
- ルートで依存を更新する `npm install` は、`react-native` の peer (`react@^19`) とルートの `react@18` が衝突して ERESOLVE になることがある (モバイルが React 19 を入れ子で持つ構成のため)。その場合は `npm install --package-lock-only --legacy-peer-deps` で `package-lock.json` だけ更新し、続けて `npm install --package-lock-only` を 1 回実行して形をそろえる。差分が意図した変更だけであることと `npm ci --dry-run` が通ることを確認する。

---

## 無視対象

`homegohan-app/` ディレクトリ (旧ツリーの残骸) は無視する。編集・参照しない。

---

## Supabase 本番スキーマ変更ポリシー

本番 Supabase (project `flmeolcfutuwwbjmzyoz`) へのスキーマ変更は、必ず `supabase/migrations/*.sql` をファイル化して PR 経由でコミットすること。

**禁止**: Supabase MCP の `apply_migration` やダッシュボードの SQL Editor で本番に直接 DDL を当てること。

理由: #1064 で、秒精度のタイムスタンプ版 migration (MCP `apply_migration` 由来) とリポジトリの丸め連番版 migration がズレて `supabase db push` が全ブロックし、2 ヶ月間デプロイできない状態になった実例がある。スキーマ変更は必ずファイル化 → PR → CI の migration drift 検知を通すこと。

---

## ローカル / CI の Supabase (ベースライン方式)

ローカルと CI では本番スキーマの読み取り専用スナップショット (`supabase/baseline/`) を出発点にし、本番台帳より新しい migration だけを上に積む。詳細は `supabase/baseline/README.md`。

`supabase/migrations/` は #1116 で空 DB から流し直せるようにした。本番台帳の最大 version (`20261007112200`) 以下の migration は、最も古いファイル `20251126124224_create_meal_planner_tables.sql` に本番スキーマのベースラインとして統合し、ほかはプレースホルダにしてある (統合前の中身は git 履歴)。これらは本番では適用済みのため実行されない。**既存の migration ファイルは編集せず、変更は必ず新しい migration として追加する。**

```bash
bash scripts/supabase-local.sh start            # 起動
bash scripts/supabase-local.sh env .env.local   # 接続情報を .env.local へ
bash scripts/supabase-local.sh reset            # migration を追加・変更したら (= db reset)
npx vitest run --config vitest.integration.config.ts tests/integration/rls   # RLS / 権限の回帰テスト
```

- リポジトリの `supabase/` に対して `supabase start` / `supabase db reset` を直接実行しない (ローカル専用の設定 (project_id・認証のレート制限の緩和) と Kong の再起動対策は `scripts/supabase-local.sh` が入れる)。
- CI の `deploy-supabase-migrations.yml` は `supabase db diff --linked` で、空のシャドウ DB に全 migration を流してから本番と比べる。流せなければジョブが失敗する。
- PR では `.github/workflows/security-regression.yml` が同じ方法でローカルスタックを立て、`tests/integration/rls/` と `tests/integration/security/` と `tests/integration/handson-tour/` を実行する。
- 結合テストで行を INSERT するときは、返ってくる `error` を必ず確認する。握りつぶすと、列名の誤り (例: `meals` に `dish_name` 列は無く、`user_daily_meals` の日付列は `day_date`) で行が入らないまま、テストが空振りで通る / 原因の分かりにくい失敗になる。

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
