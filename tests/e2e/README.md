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

### dev サーバー (next dev) に対して動かすときの注意

dev サーバーは、プロジェクトの中のファイルが変わると再コンパイルし、その間はページの読み込みが止まる
(プロジェクトの外にファイルを書いても起きない。#854 で確認)。
Playwright は、成果物 (動画・スクリーンショットなど) を `tests/e2e/.output/` に、
ログイン情報の更新を `tests/e2e/.auth/` に書く。どちらもプロジェクトの中なので、書き込みが続くと再コンパイルが重なり、
テストが「要素が見えない」と待ち切れずに失敗することがある。
次のどちらかで動かすと安定する。

```bash
# 成果物の出力先をプロジェクトの外にする (.auth への書き込みによる再コンパイルは残る)
npx playwright test --output=/tmp/playwright-output tests/e2e/w5-1-onboarding-adversarial.spec.ts

# 本番ビルドに対して動かす (CI の e2e-local.yml と同じ。再コンパイル自体が起きない)
npm run build && npm run start   # 別ターミナル
PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test
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

共通のテストユーザーは環境変数で渡す。どちらも既定値は無く、未設定だと、ログインに使うところで分かりやすいエラーで止まる:

- `E2E_USER_EMAIL` (例: `e2e-user-01@homegohan.test`)
- `E2E_USER_PASSWORD`

### パスワードの扱い

リポジトリには、`e2e-user-XX@homegohan.test` のパスワードの既定値を置かない。
既存アカウント (`e2e-user-01〜10`) のパスワードは、環境変数からだけ取る。

- `E2E_USER_XX_PASSWORD` (個別。`XX` は `01`〜`10`)。あれば共通より優先
- `E2E_USER_PASSWORD` (共通)

どちらも無いと、`global-setup` と `getUserCredentials()` / `login()` は、分かりやすいエラーで止まる
(`E2E_REQUIRE_LOGIN=1` の `global-setup` は、全テストを走らせずに止める)。

ローカルでは `scripts/create-e2e-accounts.ts` が、`E2E_USER_PASSWORD` が無ければランダムなパスワードを作り、
ローカル DB のユーザーを作成・更新したうえで `.env.local` の `E2E_USER_XX_PASSWORD` に書く
(行が既にあれば値を書き換える。パスワードは標準出力に出さない)。

```bash
# ローカル (ランダムなパスワードを .env.local に書く)
npx --yes tsx@4 scripts/create-e2e-accounts.ts
```

テストの中で新しく作るユーザー (`fresh-user`、招待で作るユーザー、signup のテスト) は、
`tests/e2e/helpers/credentials.ts` の `generateTestPassword()` で、実行ごとにランダムなパスワードを作る。

### コミットしてはいけないもの (#1114)

以前は、本番のデバッグ用アカウントのメールアドレスとパスワードを、環境変数が無いときの既定値として spec に書いていた。
`tests/e2e/.exploration/` には、そのアカウントでログインしたときのブラウザの通信記録 (HAR) も置いていた。
HAR にはログイン要求のパスワードやアクセストークンが平文で入る。どちらもリポジトリから消した。

- 特定のアカウントのメールアドレスやパスワードを、環境変数の既定値として spec に書かない。
  共通のテストユーザーは `tests/e2e/helpers/credentials.ts` の `requireE2eUserCredentials()` で読む (未設定ならエラーで止まる)
- 通信記録 (`*.har`)、`secrets/` の中身、サービスアカウント鍵 (`*service-account*.json`) はコミットしない。`.gitignore` で除外している
- 探索 spec で通信記録やトレースを残すときは、gitignore 済みの `tests/e2e/.output/` に出す (`.exploration/` の下には置かない)

`tests/no-committed-credentials.test.ts` (`npm test`) が、リポジトリで管理しているファイルにこれらが残っていないかを調べる。
一度でも公開した値は、消しても履歴に残る。パスワードの変更やアカウントの削除は別に必要。

## CI

| ワークフロー | 対象 | テストユーザー |
|---|---|---|
| `.github/workflows/e2e-local.yml` | PR のコード。ローカルの Supabase (`scripts/supabase-local.sh`) と本番ビルド (`next build && next start`) で、MVP のうち AI を使わない 01 / 04 / 05 と、未ログインで読める公開ページの `public-policy-pages.spec.ts` (利用規約・プライバシーポリシー #1174)、ハンズオンツアーの `tour/` (#846) を実行 | 実行ごとにローカルの DB に作る (`scripts/create-e2e-accounts.ts`、パスワードは実行ごとにランダム)。`tour/` はテストごとに新規ユーザーを service_role で作って消す |
| `.github/workflows/e2e.yml` | 本番 URL。ローカル dev server は起動しない | 本番の `e2e-user-01〜04@homegohan.test`。Secrets `E2E_USER_EMAIL` (= `e2e-user-01@homegohan.test`) / `E2E_USER_PASSWORD` が必要 (未設定ならジョブを最初に止める) |

本番のテストユーザーのパスワードはランダムな値で、Secrets `E2E_USER_PASSWORD` にだけ置く (リポジトリにも `.env.local` の共有にも書かない)。
本番のテストユーザーを作り直すときは、本番の service role を `.env.local` に置いて次のように作れる (パスワードは Secrets と同じ値):

```bash
E2E_USER_PASSWORD='<Secrets と同じパスワード>' npx --yes tsx@4 scripts/create-e2e-accounts.ts
```

CI では `E2E_REQUIRE_LOGIN=1` で、global-setup がログインできなければ全テストを走らせずに止める。
また、Playwright のトレースと失敗時のページスナップショット (`error-context`) は入力したパスワードを平文で含むため、
CI では取らない (`--trace off` / `PLAYWRIGHT_NO_COPY_PROMPT=1`)。HTML レポートも手順名に入力値を含むため、
artifact には上げず、`tests/e2e/.output/` (失敗時のスクリーンショット・動画・エラー内容) だけを上げる。

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

## ハンズオンツアー (`tour/`, #846)

初回の使い方ガイド (`/handson-tour`) の Step 0〜4・スキップ・やり直し・対象判定 API (`/api/handson-tour/status`) を確かめる。
`e2e-local.yml` で PR ごとに動く。

| ファイル | カバーするフロー |
|---|---|
| `tour/01-eligibility.spec.ts` | 対象判定 API の reason (未ログイン / onboarding 未完 / 通常 / 完了済 / スキップ済 / admin / 既存活動) |
| `tour/02-step0-welcome.spec.ts` | Step 0 の表示・「はじめる」・「あとで」 |
| `tour/03-step1-photo.spec.ts` ・ `04-step2-menu.spec.ts` ・ `05-step3-badges.spec.ts` | Step 1 (写真) ・ 2 (献立) ・ 3 (バッジ)。それぞれのページを直接開いて確かめる |
| `tour/06-step4-graduate.spec.ts` | 卒業画面・完了の記録・エラーからのやり直し・Step 0 から /home までの通し |
| `tour/07-skip-and-replay.spec.ts` | スキップ・設定からのやり直し |
| `tour/08-small-screen.spec.ts` | 小さい画面 (360x640) で Step 0 から卒業画面まで通しで進める |

- テストごとに新規ユーザーを service_role で作り (`tour/helpers.ts` の `tourUser` / `createUser`)、終わったら消す。
  `.env.local` に `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` が要る
  (ローカルは `bash scripts/supabase-local.sh env .env.local`)。足りないとき、本番 URL に向けた実行などでは理由付きの
  `test.fixme` になる。CI (`E2E_REQUIRE_LOGIN=1`) では `fixme` にせず失敗にする (判断は `tour/provisioning.ts`)。
- ツアーの「生成」「写真の解析」はサンドボックスの固定値で、AI は使わない。
- Spotlight の対象 (`meal-save-button` など) の上にはオーバーレイがかぶさっていて直接は押せない。進めるときは吹き出しの
  `tour-next-button` を押す (`completeStep1〜3`)。
- **`test.skip` は使わない**。以前は「未実装かも」「UI が見つからない」で skip にしていたため、動いていなくても緑のままだった。
  Playwright の `isVisible({ timeout })` は timeout を無視する (今の状態を返すだけ) ので、待つときは `expect(...).toBeVisible({ timeout })`。
  動かせない理由があるときは `test.fixme` に理由を書く。`tests/e2e-tour-contract.test.ts` が `npm test` で検査する。
- 既知の不具合で `test.fixme` にしているもの (直したら外す。`grep -rn "test.fixme" tests/e2e/tour` で探せる):
  - Step 1 の保存 API (`POST /api/meal-plans/add-from-photo`) が、ツアーが送る本文に `dayDate` / `mealType` が無く 400 になる。
    お試しの記録 (`is_sandbox = true`) を何として残すか (日付・食事の区分・カレンダーに出すか) は製品判断が要る。
  - Step 3 のバッジ一覧が、`/api/badges` の `earned` / `obtainedAt` ではなく存在しない `obtained_at` を見ていて、
    獲得済みでも「獲得済」が付かない。直すと、お試しの記録を数えない (#1314) ため `first_bite` が付かないのに
    「もう 2 つ獲得しています」と出る食い違いが見えるため、見せ方は製品判断が要る。

## バグ回帰スペック

`tests/e2e/bug-XX-*.spec.ts` の命名で 1 Issue = 1 ファイル。
各ファイル先頭に対応 Issue 番号と再現手順を JSDoc で記載する。
