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
| `.github/workflows/e2e-local.yml` | PR のコード。ローカルの Supabase (`scripts/supabase-local.sh`) と本番ビルド (`next build && next start`) で、MVP のうち AI を使わない 01 / 04 / 05 と、未ログインで読める公開ページの `public-policy-pages.spec.ts` (利用規約・プライバシーポリシー #1174)、規約の再同意ゲートの `legal-consent-gate.spec.ts` (#1174。既定 (強制なし・お知らせなし) のサーバーと、`LEGAL_CONSENT_ENFORCE=on`・`LEGAL_CONSENT_NOTICE=on` でそれぞれ別ポートに起動したサーバーの 3 回)、未同意なら AI へ送らないことと同意画面を確かめる `ai-consent-first-use.spec.ts` (#1154) を実行 | 実行ごとにローカルの DB に作る (`scripts/create-e2e-accounts.ts`、パスワードは実行ごとにランダム) |
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

## AI の同意 (外国の AI 事業者への提供の同意、#1154)

同意していない利用者のデータは、サーバーが AI へ送る手前で止める (403 `AI_CONSENT_REQUIRED`)。画面は、AI の操作の前に
同意画面 (`data-testid="ai-consent-modal"`) を出し、「同意しない」(`data-testid="ai-consent-decline"`) なら操作をやめる。
AI を使う spec が止められないよう、テスト用のアカウントは同意済みにしてある。

- ローカルの `e2e-user-01〜10`: `scripts/create-e2e-accounts.ts` が作るときに記録する (`scripts/lib/e2e-ai-consent.ts`。service role)。
- `fixtures/fresh-user.ts` のユーザー (`regularUser` / `adminUser` / `tourPendingUser` など): 作るときに記録する
  (`aiConsentGranted` が既定 true。サインアップの流れの `freshUserPage` は記録しない)。
- `fixtures/auth.ts` の `authedPage`、`helpers/auth.ts` の `login()`、`global-setup.ts`: ログインのあとに
  `helpers/ai-consent.ts` の `ensureAiConsentGranted` がアプリの API (`GET` / `POST /api/ai/consent`) で記録する
  (同意済みなら何もしない)。本番の e2e-user (`e2e.yml`) もこれで同意済みになる。
- 同意画面そのものを試す spec (`ai-consent-first-use.spec.ts`) は、`test.use({ aiConsentGranted: false })` で同意の行が空の状態から始める。
- `@playwright/test` の `page` を自分でログインさせる spec で AI を使うなら、ログインのあとに `ensureAiConsentGranted(page, origin)` を呼ぶ。
- ローカルで `next dev` に向けて実行するときは、`--output=/tmp/pw-out` のように Playwright の出力先 (動画・スクリーンショット) を
  リポジトリの外にする。出力先がリポジトリの中 (既定の `tests/e2e/.output`) だと、dev server が再コンパイルを繰り返してページの読み込みが
  止まり、`waitForResponse` などがタイムアウトすることがあった。本番ビルド (`npm run build && npm run start`) では起きない。

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

## バグ回帰スペック

`tests/e2e/bug-XX-*.spec.ts` の命名で 1 Issue = 1 ファイル。
各ファイル先頭に対応 Issue 番号と再現手順を JSDoc で記載する。
