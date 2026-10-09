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

### メール送信の結果と失敗の記録

メールは `src/lib/emails/send.ts` の `sendEmail(envelope)` で送る。戻り値は `{ ok, id, attempts, error }` で、配信の失敗では例外を投げない (#1193)。

- 失敗 (再試行を使い切った・400/403 など) と `RESEND_API_KEY` 未設定は、`sendEmail` が `createLogger('email')` で app_logs に残す。残すのは文面の名前 (`template`)・マスクした宛先・Resend のエラーコード・送った回数だけ。呼び出し側が戻り値を見なくても、失敗は記録される。
- 429 / 5xx / 通信エラーだけ、500ms・1s・2s の指数バックオフで最大 3 回再試行する (合計で最大 4 回)。同じ Idempotency-Key を付けるので二重送信にならない。再試行は呼び出し側の「試行回数」には数えない。
- 失敗したときに追加の処理 (送信記録の保存・画面への表示・文脈つきのログ) をする呼び出し側だけが、結果を見る。判定は `src/lib/emails/send-result.ts` の `isEmailFailure` / `emailFailureReasons` を使う。`RESEND_API_KEY` が無くて送らなかった結果は `ok: false` かつ `skipped: true` で、失敗には数えない。
- 新しい文面 (`render*Email`) は、返す封筒に `template` (snake_case の名前) を必ず入れる (`src/__tests__/lib/emails/template-names.test.ts` が検査する)。
- 呼び出し側のテストで `@/lib/emails/send` をモックしても、`send-result.ts` は別ファイルなので実物のまま使える。

### ロール認可

API Route (`src/app/api/**`) のロール認可は、共通ヘルパーを入口で呼ぶ。`getUser()` → `user_profiles` の取得 → ロール判定を route に手書きしない (#1161。`tests/role-check-source-scan.test.ts` が検査する)。

- 運営ロール (support / admin / super_admin など): `requireRole([...])` (`src/lib/auth/helpers.ts`)
- 組織の管理者 (所属組織の `org_role` が owner / admin): `requireOrgAdmin()` (同上。判定の実体は `src/lib/auth/org-admin.ts` の `isOrgAdmin`。roles 配列の `org_admin` は見ない)
- 他ユーザーの行を読む必要があるとき (`user_profiles` などは RLS で本人の行しか見えない) だけ、認可を通した**あとに** `getSupabaseAdmin()` (service_role) を使う。認可の前には使わない。使うときは、対象を絞る条件 (対象ユーザーの id など) を必ず付ける
- 500 の本文は汎用メッセージだけにし、DB の生のエラー文は返さない。詳細は上記の構造化ログに残す (#1172)。route では共通ヘルパー `internalError(routeName, error, ctx?)` (`src/lib/api/errors.ts`) を `return` する。構造化ログへの記録と、汎用の本文 `{ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }` の返却を一度に行う。`error` は文字列のままにする (画面が `data.error` をそのまま表示するため。オブジェクトにすると描画で落ちる)。運営 API のように `error.message` を読むクライアントには `{ shape: 'nested' }` を渡す
- JSON 本文に `error.message` を入れている既存の route は `tests/api-raw-error-message-scan.test.ts` の許可リストに載っている。新しく足すとテストが落ちる。直したら許可リストの件数を減らす (0 件になったら行を消す)

### レート制限

`src/lib/rate-limit.ts` に集約する (#1197)。新しい制限は `RateLimitCategory` にカテゴリを足し、`checkRateLimit(key, category)` で判定する。route ごとに Upstash / in-memory の制限を自前で作らない (`tests/rate-limit-single-implementation.test.ts` が `@upstash/ratelimit` を使うファイルを検査する)。key は認証で確定した ID を使い、ログイン前の公開 API (お問い合わせ) だけクライアント IP を使う。

### PostHog の既定ホスト

`packages/shared` の `POSTHOG_DEFAULT_HOST` に集約する (#1197)。Web・モバイルのコードはこれを import し、ホストの文字列を直接書かない。素の Node ESM の `next.config.mjs` と `.env.example` だけは同じ値のリテラルが残るので、ホストを変えるときは 3 か所を合わせる (`src/__tests__/config/posthog-default-host.test.ts` が検査する)。

### 状態色 (success / warning / error / danger)

`packages/shared/src/design-tokens.ts` の `STATUS_COLOR_TOKENS` に集約する (#590)。Web の home・pantry・health 配下の画面とモバイルの `colors.ts` は、これを import して使い、状態色の hex を直書きしない (`src/__tests__/config/status-color-tokens.test.ts` がこの範囲の画面を検査する)。週間献立など、ほかの画面には A 系の値の直書きがまだ残っている。その画面を触るときにトークンへ寄せる。

- 塗り (背景・枠線・アイコン・グラフの線や棒): `success` / `warning` / `error` / `danger` と、淡い下地の `*Light`
- 文字: `successText` / `warningText` / `dangerText`。WCAG の AA (4.5:1) を、白地・各 Light の下地・ページの背景・塗りの薄い透過の下地の上で満たす (`packages/shared/src/design-tokens.test.ts` が数値で確かめる)。塗りの色は白地で 4.5:1 に届かないので、文字には使わない。`error` の赤い文字にも `dangerText` を使う
- 値を変えるときは `design-tokens.ts` だけを直す。画面ごと・モバイルの `colors.ts` に同じ値を書き足さない
- 中立色 (bg / text / border など) と accent / purple / blue はまだ対象外 (画面ごとに値が違う。別の変更で揃える)

### 栄養計算入力

`src/lib/build-nutrition-input.ts` に集約。栄養計算に必要な入力オブジェクトを組み立てる際は、このモジュールを経由する。直接構築しない。

### 環境変数

読む環境変数の一覧は `src/lib/env.ts` (zod のスキーマ。公開用 `NEXT_PUBLIC_*` とサーバー用に分け、必須/任意を区別する) に集約する (#1182)。

- **必須** (Supabase の接続情報 3 つ: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`) は、`src/lib/env-required.ts` の `getSupabaseUrl()` などで取り出す。欠けていれば変数名つきの `MissingEnvError`。**`process.env.X!` と書かない** (`tests/env-source-scan.test.ts` が検査する)。DB に書き込む処理の前に取り出す (書き込んだあとで投げると、リクエストの行が processing のまま残る)。
- **任意** (メール・レート制限・AI・課金など) は `src/lib/env.ts` の `getOptionalEnv(name)` で取り出す。無ければ `undefined` を返し、プロセスごとに 1 回だけ警告を出す。**任意の変数が無いことで本番を止めない**。
- `env-required.ts` は何も import しない。ブラウザ向け (`lib/supabase/client.ts`) と Edge Runtime (middleware・`runtime = 'edge'` の route) のコードは `env.ts` を import しない (zod は最小のスキーマでも minify 後に約 59 KB、gzip 約 16 KB 加わるため。`tests/env-source-scan.test.ts` が到達性を検査する)。`env.ts` は `scripts/check-env.mjs` が Node.js から直接読むため、静的に import してよいのは zod だけ。
- 新しい環境変数は、`env.ts` の一覧 (必須にするのは、無いとアプリが動かないものだけ。無いと何が起きるかも書く) と `.env.example` の両方に足す。`npm run check:env` が `.env.local` などを一覧に照らして検査する (CI には組み込まない。CI にシークレットが無いため)。
- **モバイル** (`apps/mobile`) は `src/lib/env.ts`。`EXPO_PUBLIC_*` は `process.env.EXPO_PUBLIC_X` と名前を直接書く (`process.env[name]` はビルド時に置き換わらず、リリースビルドで常に undefined になる)。必須の `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` が無いと、`lib/supabase.ts` は存在しない接続先のクライアントを作らず、開発中は読み込み時に例外、リリースビルドは `app/_layout.tsx` が設定エラーの画面を出す。モバイルの jest では `process.env` を差し替えず、同じオブジェクトを書き換える (`expo/virtual/env` が読み込み時の `process.env` を握るため)。

### localStorage クリーンアップ

`src/lib/user-storage.ts` の `clearUserScopedLocalStorage()` を使う。  
サインアウト処理では **Supabase signOut を呼ぶ前に** このヘルパーを実行する。

### Web のログアウト画面と、モバイルアプリの WebView への通知

Web の画面で利用者がログアウトするときは、`clearUserScopedLocalStorage()` → `notifyNativeSignOut()` (`src/lib/native-auth-bridge.ts`) → `supabase.auth.signOut()` → `broadcastSignOut()` (`src/lib/user-storage.ts`) の順に呼ぶ (#1038)。
`signOut()` の前に `notifyNativeSignOut()` を呼ばないと、`signOut()` の途中の `SIGNED_OUT` が `session-expired` としてネイティブへ先に届き、ネイティブが `user_push_tokens` のこの端末の行を消せなくなる。
`broadcastSignOut()` は `signOut()` のあとに呼ぶ (先に呼ぶと同じタブが `/login` へ移り、`signOut()` が途中で止まる)。`tests/native-sign-out-order-source-scan.test.ts` が検査する。

### エラー境界 (画面の描画中の例外を受ける)

画面の描画中に起きた例外を受ける境界が無いと、Web ではルート全体を置き換える `global-error.tsx` まで、モバイルではアプリ全体のクラッシュまで届く (#1207)。新しい route group / layout を足すときは、境界も足す。

- **Web**: layout (`layout.tsx`) を持つ区画には、同じ階層に `error.tsx` を置く。中身は共通部品 `src/components/error/RouteError.tsx` を返すだけにする (手書きしない)。`RouteError` は「再試行」(`router.refresh()` + `reset()`)・戻るリンク・記録 (`src/lib/report-boundary-error.ts`) をそろえる。`reset()` だけではサーバーコンポーネントの例外から復帰できないため、`router.refresh()` を一緒に呼ぶ。例外の文面・スタックは画面に出さず、出すのは `digest` だけ。記録に URL / パスを入れない (`/invite/{token}` など URL に秘密が入るページがあるため)。`tests/route-error-boundaries.test.tsx` が配置と表示を検査する。
- **モバイル**: `apps/mobile/app` の `_layout.tsx` は、すべて `export function ErrorBoundary` を持ち、`src/components/ErrorFallback.tsx` を返す。expo-router は、この export がある layout の中の例外だけを受ける (無いと誰にも受けられない)。Provider の外 (ルートの境界) でも描画されるので、`ErrorFallback` は hooks や Provider に頼らない。`apps/mobile/__tests__/app/error-boundaries.test.tsx` が全 layout を検査する。記録は `apps/mobile/src/lib/error-report.ts`。PostHog (外部の計測サービス。イベントがユーザー ID に紐づく) には、例外の文面・スタックを送らない。`captureEvent` の PII フィルタはキー名しか見ず、値の中身は除かないため。送るのは境界・OS・例外の種類 (識別子の形のときだけ)・指紋 (元に戻せないハッシュ) だけにする (`docs/design/operator/07-audit-monitoring.md` §15.7)。生の文面は、サーバー側でマスクされる `POST /api/log` の metadata にだけ残す。`apps/mobile/__tests__/lib/error-report.test.ts` が、PostHog に送る内容を固定している。

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

## 家族 (family_*) を変える関数のロック順 (DB)

家族のメンバー・所属・代表者を変える関数 (`accept_family_invite` / `add_family_child` / `leave_family` / `remove_family_member` / `operator_force_dissolve_family` / `operator_force_representative_transfer` / `accept_family_representative_transfer` / `accept_child_promotion`) は、**最初に `family_groups` の行をロックし**、そのあとで子の行 (`family_invites` / `ownership_transfer_proposals` / `family_members` / `family_promotion_requests` / `user_profiles`) を触る (#1310)。代表者による家族の削除 (`DELETE FROM family_groups` + CASCADE) は、DELETE 文が最初に家族の行を取るので、もともとこの順になっている。

順番がそろっていないと、運営の強制解散・家族の削除と同時に走ったときに、解散済みの家族に active のメンバーが残る / デッドロック (40P01) する。

- 家族に関わる関数を `CREATE OR REPLACE` するときは、既存のロックを外さない。別の migration が同じ関数を書き換えているときは、最新の定義の上に積む (古い本文で上書きするとロックが消える)。
- 新しく足す家族の行のロックは `FOR NO KEY UPDATE` にする (`add_family_child` だけは #1213 のまま `FOR UPDATE`)。`FOR UPDATE` だと、子の行を先に持つ関数が最後に取る外部キーの確認 (`FOR KEY SHARE`) が待たされ、逆向きに待ち合ってデッドロックする。
- 子の行を先に取って、あとで家族の行を外部キーの確認で取る関数 (`create_family_invite` の再招待 / `request_child_promotion`) は、まだ家族の行を先に取らない。代表者の DELETE と同時に走ると、まれにどちらかがデッドロックで失敗する (既知。やり直せば通る)。
- 回帰テスト: `tests/integration/security/family-lock-order-race.test.ts`

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
