# 環境変数設定ガイド

このプロジェクトで必要な環境変数の設定方法を説明します。

## 📋 必要な環境変数一覧

### 必須の環境変数

1. **Supabase関連**
   - `NEXT_PUBLIC_SUPABASE_URL` - SupabaseプロジェクトのURL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabaseの匿名キー
   - `SUPABASE_SERVICE_ROLE_KEY` - Supabaseのサービスロールキー（サーバーサイドのみ）

2. **Cron / スケジューラ関連**（3 か所に別々に保管する。役割と値を合わせる必要があるかは「Cron の共有シークレットの保管場所とローテーション」を参照）
   - `CRON_SECRET` - Vercel Cron からのリクエストを認証するシークレット（未設定の場合、cron エンドポイントは 503 を返す）
     - Vercel Dashboard → Settings → Environment Variables に設定
     - ランダムな英数字 32 文字以上を推奨
   - `CRON_SECRET` (Supabase Edge Function secrets) - pg_cron などから Edge Function を呼び出すときに受け取る側が確かめるシークレット。Vault の `app_cron_secret` と同じ値にする（別名 `SERVICE_ROLE_SECRET` は、`CRON_SECRET` が無いときだけ使われる）
   - `app_cron_secret` (Supabase Vault) - pg_cron から Edge Function を呼び出す際の Bearer トークン
   - `CRON_SECRET_PREVIOUS` - シークレットを入れ替える間だけ設定する旧い値。普段は設定しない（Vercel と Edge Function secrets のどちらにも置ける）

### Catalog cron secret (Supabase Vault)

Supabase Dashboard SQL Editor で以下を 1 度だけ実行:

```sql
SELECT vault.create_secret(
  '<Edge Function secrets の CRON_SECRET と同じ値>',
  'app_cron_secret',
  'CRON_SECRET for catalog import functions'
);
```

確認:
```sql
SELECT name FROM vault.secrets WHERE name = 'app_cron_secret';
```

値を入れ替えるとき（ローテーション）の手順は、次の「Cron の共有シークレットの保管場所とローテーション」を参照。

4. **Google AI (Gemini) 関連**
   - `GOOGLE_AI_STUDIO_API_KEY` または `GOOGLE_GEN_AI_API_KEY` - Google AI APIキー

5. **OpenAI関連**（既存機能用）
   - `OPENAI_API_KEY` - OpenAI APIキー

---

## Cron の共有シークレットの保管場所とローテーション

cron から呼ばれる API や Edge Function は、リクエストの `Authorization: Bearer <シークレット>` が正しいかを確かめて、呼び出し元を判断します。この「シークレット」は、次の 3 か所に **別々に** 置かれています。自動では同期されないので、各場所の役割と、値を合わせる必要があるかどうかを先に押さえてください。

### 3 つの保管場所

| 保管場所 | 名前 | 役割 | 他と値を合わせる必要 |
|---|---|---|---|
| Vercel の環境変数 | `CRON_SECRET` | 送る側も受ける側も Vercel の中で完結します。Vercel Cron が `/api/cron/process-menu-queue`（`vercel.json` の `crons`）を呼ぶとき、この値を自動で `Authorization: Bearer ...` に付けます。受ける側の Next.js（`src/lib/cron-auth.ts`）が、同じ環境変数と照らし合わせます | **不要**。他の 2 か所と別の値にしてかまいません（別の値にしておくと、片方が漏れてももう片方は守られます） |
| Supabase の Edge Function secrets | `CRON_SECRET`（別名 `SERVICE_ROLE_SECRET`。`CRON_SECRET` が無いときだけ代わりに使われます） | **受ける側**。`supabase/functions/_shared/auth.ts` の `requireServiceRole` が、次の Edge Function でこの値と照らし合わせます: コンビニカタログ取り込み 5 本（`import-seven-eleven-catalog` / `import-familymart-catalog` / `import-lawson-catalog` / `import-natural-lawson-catalog` / `import-ministop-catalog`）、`aggregate-org-stats`（停止中。認証だけ行い 410 を返します。#1325）、`calculate-segment-stats`、`regenerate-embeddings`、`stripe-price-sync`（最後の 2 本は service role key でも呼べます） | Vault の `app_cron_secret` と **同じ値にする** |
| Supabase Vault | `app_cron_secret` | **送る側**。pg_cron が定期実行する `public.invoke_catalog_import()` がこの値を読み、`Authorization: Bearer ...` に付けて、コンビニカタログ取り込みの Edge Function 5 本を呼びます（登録時のスケジュールは、毎日 UTC 3:00〜4:00 に 15 分おき） | Edge Function secrets の `CRON_SECRET` と **同じ値にする** |

つまり、**値を合わせないと動かないのは「Edge Function secrets の `CRON_SECRET`」と「Vault の `app_cron_secret`」の 2 つだけ**です。Vercel の `CRON_SECRET` は独立しています。

### 値が合っていないとどうなるか

- 値が違う → Edge Function は HTTP 401 を返します。
- Edge Function 側に `CRON_SECRET`（と `SERVICE_ROLE_SECRET`）が無い → HTTP 503 を返します。
- pg_cron は pg_net で **非同期に** 呼び出すため、cron ジョブ自体は成功扱いのままです。エラーの表示もなく、カタログ取り込みだけが止まります。

直近の呼び出し結果は、Supabase Dashboard の SQL Editor で次のように確かめられます。古い結果は自動で消える（既定では約 6 時間）ので、実行の直後に見てください。

```sql
SELECT id, status_code, timed_out, error_msg, created
FROM net._http_response
ORDER BY created DESC
LIMIT 20;
```

- `status_code` が **401 / 503** の行がある → 値が合っていません。
- `status_code` が 200 → 認証は通っています。
- `status_code` が空で `timed_out` が true → 認証は通っています。取り込みに 5 秒以上かかると、pg_net が先に待つのをやめるためです（正常）。

値のずれを自動で見つける仕組みは、まだありません（#1196 の残りの項目として別に対応します）。それまでは、ローテーションの後と、カタログ取り込みの結果がおかしいときに、上のクエリで確かめてください。

### Edge Function secrets の設定手順

Supabase Dashboard → Edge Functions → Secrets で、追加・更新・削除ができます。CLI でも同じことができます。

```bash
# 値を一時ファイル（名前=値 を 1 行ずつ。例: CRON_SECRET=...）に書いて読み込ませる。
# コマンドラインに値を直接書くと、シェルの履歴に残るため。
# 一時ファイルはリポジトリの外に置き、終わったらすぐ消す。
supabase secrets set --env-file ~/cron-secrets.env --project-ref <project-ref>
rm ~/cron-secrets.env

# 削除
supabase secrets unset CRON_SECRET_PREVIOUS --project-ref <project-ref>
```

### ローテーション手順（止めずに入れ替える）

Edge Function は、現行の `CRON_SECRET` に加えて `CRON_SECRET_PREVIOUS`（旧い値）も受け付けます。これを使って、送る側（Vault）を切り替えている間も、呼び出しが途切れないようにします。旧い値で認証された呼び出しは、Edge Function のログに `CRON_SECRET_PREVIOUS (旧いシークレット) で認証されました` という警告で残ります。

**前提**: `CRON_SECRET_PREVIOUS` に対応した Edge Function が本番にデプロイ済みであること。`supabase/functions/**` を変更した PR が main に入ると、GitHub Actions の「Deploy Supabase Functions」が自動でデプロイします。Actions で成功していることを確認してください。

1. **新しい値を作る。** `openssl rand -base64 32` などで、32 文字以上のランダムな文字列を作り、パスワードマネージャに保存します。旧い値も、手元の控え（パスワードマネージャなど）から取り出しておきます。
2. **Edge Function secrets に、新旧を同時に設定する。** `CRON_SECRET` に新しい値、`CRON_SECRET_PREVIOUS` に旧い値を入れます。これで、新旧どちらの Bearer も通ります。Vault はまだ旧い値のままなので、pg_cron の呼び出しは変わらず通り続けます。反映に少し時間がかかることがあるので、数分待ちます。
3. **Vault の `app_cron_secret` を新しい値に更新する。** SQL Editor で次を実行します。SQL Editor の履歴に値が残る点に注意してください（気になる場合は、Dashboard の Vault 画面から編集します）。

   ```sql
   SELECT vault.update_secret(
     (SELECT id FROM vault.secrets WHERE name = 'app_cron_secret'),
     '<新しい値>'
   );
   ```

4. **動作を確かめる。** 定期実行と同じ取り込みを 1 本だけ手動で走らせます（Firecrawl / LLM の利用料が、通常の 1 回分だけかかります）。

   ```sql
   SELECT public.invoke_catalog_import('import-ministop-catalog');
   ```

   1 分ほど待って、上の `net._http_response` のクエリで **401 / 503 が出ていない** ことを確かめます。
5. **旧い値を外す。** 翌日の定期実行（UTC 3:00〜4:00）が終わるまで待ち、Edge Function のログに `CRON_SECRET_PREVIOUS (旧いシークレット) で認証されました` が出ていない（= 旧い値を使っている送り手が残っていない）ことを確かめてから、`CRON_SECRET_PREVIOUS` を削除します。外すまでは旧い値でも通ってしまうので、入れ替えの目的が漏えい対策なら、できるだけ早く外してください。

途中で戻したくなったときは:

- 手順 3 の前なら、`CRON_SECRET` を旧い値に戻し、`CRON_SECRET_PREVIOUS` を削除します。
- 手順 3 の後なら、Vault の `app_cron_secret` を旧い値に戻します（`CRON_SECRET_PREVIOUS` が残っている間は、新旧どちらでも通ります）。

旧い値の控えが無いときは、`CRON_SECRET_PREVIOUS` を使えません。定期実行のない時間帯（UTC 4:30〜翌 2:30）に、手順 2 では `CRON_SECRET` だけを新しい値にして、すぐ手順 3 を行ってください。その数分の間だけ、手動で呼ぶ処理が 401 になります。

### Vercel の `CRON_SECRET` を入れ替えるとき

Vercel Dashboard → Settings → Environment Variables で `CRON_SECRET` の値を変更し、再デプロイします。Vercel Cron は再デプロイ後の値を付けて呼ぶので、Supabase 側とは無関係に入れ替えられます。`/api/cron/process-menu-queue` を curl などで手動で呼ぶ運用がある場合だけ、旧い値を一時的に Vercel の `CRON_SECRET_PREVIOUS` に入れて同時に再デプロイし、呼び出し側を直してから外してください。旧い値で呼ばれると、Vercel の関数ログに `CRON_SECRET_PREVIOUS (旧いシークレット) で認証されました` と警告が出ます。

### 守ること

- シークレットの値を、コード・Issue・PR・コミット・チャットに書かない。
- `CRON_SECRET_PREVIOUS` は、入れ替えの間だけ使う。普段は未設定（または空）にしておく。
- 新しい cron の受け口を作るときは、シークレットを自分で比べない。Next.js は `src/lib/cron-auth.ts` の `requireCronAuth`、Edge Function は `supabase/functions/_shared/auth.ts` の `requireServiceRole` を使う（定数時間の比較と、旧い値の受け付けが入っています）。

---

## ✉️ サイトの URL・メールの送信元・問い合わせ先（Web）

この 3 つは `src/lib/site-config.ts` の 1 か所で決まります（#1194）。どれも未設定なら、いま動いている既定値を使います。
`homegohan.com` へ切り替えるときは、この環境変数を設定するだけで、コードの変更は要りません。手順（DNS・Resend・Supabase・Google の設定）は [`docs/operations/email-domain.md`](docs/operations/email-domain.md) にあります。

| 環境変数 | 例 | 役割 | 未設定のときの既定値 |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://homegohan.com` | サイトの URL。メールの中のリンク・招待や譲渡の URL・ページの OGP / canonical・`robots.txt` の基点 | `https://homegohan-app.vercel.app`（いま動いているサイト） |
| `EMAIL_FROM` | `ほめゴハン <noreply@mail.homegohan.com>` | メールの送信元。Resend で検証済みのドメインにする | 従来の送信元（`noreply@homegohan.app`。このドメインは検証できないので、本番ではメールが届かない） |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | `support@homegohan.com` | 問い合わせ先。メールの文面・お問い合わせ画面・プライバシーポリシー・招待画面に出る | 従来のアドレス（`support@homegohan.app`） |

- `NEXT_PUBLIC_` で始まる値は**ビルド時に埋め込まれる**ので、Vercel で変えたら再デプロイしてください。
- 形が正しくない値（`https://` が無い URL、メールアドレスでない値）は無視して既定値に戻り、関数ログに警告が 1 回出ます。
- `NEXT_PUBLIC_INVITE_BASE_URL` は以前の招待リンク専用の設定です。設定してあると `NEXT_PUBLIC_APP_URL` より優先されるので、切り替えるときは**削除**してください。
- `SUPPORT_REPLY_TO`（任意）: サポートの返信メールの返信先。`support@` の受信箱ができたら設定します。
- サインアップの確認メール・パスワード再設定メールは Supabase が送ります。`EMAIL_FROM` は効かず、Supabase の Custom SMTP の設定が必要です（手順は上の文書）。
- メールが届かなくても、招待・お問い合わせ・サポート返信の処理は成功します（失敗は `app_logs` / 関数ログに残ります）。
- `https://homegohan-app.vercel.app` は、配布済みのアプリのビルドが WebView で開くため、古いビルドが使われなくなるまで止めない・リダイレクトしないでください。
- 送信用の DNS（Resend の DKIM・Return-Path・DMARC）が見えているかは、`node scripts/check-email-dns.mjs` で確かめられます（DNS を引くだけで、何も書き換えません）。

---

## 📱 モバイル（Expo）での環境変数

Expoでは `EXPO_PUBLIC_` で始まる変数がクライアントに埋め込まれます（=秘密情報は入れない）。

### 必須（モバイル）
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

### オプション（モバイル）
- `EXPO_PUBLIC_API_BASE_URL` - Next.js API（BFF）を叩く場合（例: `https://homegohan.com`）
- `EXPO_PUBLIC_APP_ENV` - `development | preview | production`
- `EXPO_PUBLIC_WEB_URL` - WebView が開く Web のオリジン（未設定なら `https://homegohan-app.vercel.app`）。設定画面の「利用規約」「プライバシーポリシー」も、このオリジンの `/terms` `/privacy` を開く
- `EXPO_PUBLIC_SUPPORT_EMAIL` - 設定画面・プロフィール画面の「お問い合わせ」の宛先（未設定なら従来のアドレス。`apps/mobile/src/lib/siteConfig.ts`）

サンプルは `apps/mobile/env.example` を参照してください。

### オプションの環境変数

- `GEMINI_IMAGE_MODEL` - 画像生成モデル（デフォルト: `gemini-3-pro-image-preview`）
  - 使用可能な値:
    - `gemini-2.5-flash-image-preview` (Nano Banana)
    - `gemini-3-pro-image-preview` (Nano Banana Pro - デフォルト)

### 本番では設定する環境変数: レート制限（Upstash Redis）

- `UPSTASH_REDIS_REST_URL` - Upstash Redis の REST URL
- `UPSTASH_REDIS_REST_TOKEN` - Upstash Redis の REST トークン（秘密情報。サーバーサイドのみ）

用途: AI 系 API の分あたりの上限、招待メール・子供メンバーの参加リクエストメール・オーナー／代表者の譲渡提案メールの送信回数の上限（#1163）、お問い合わせフォームの IP ごとの上限（1 分に 10 回。#1197）、ファイルのアップロード（`POST /api/upload`）のユーザーごとの上限（1 分に 10 回・24 時間で 100 回。#1164）。いずれも `src/lib/rate-limit.ts` の共通の仕組みで数えている。

- **ローカル開発**: 未設定でよい。サーバープロセス内のメモリで数える（再起動でリセットされる）。
- **本番（Vercel）**: Production に必ず設定する。未設定でも動くが、Vercel は同じユーザーのリクエストを別のサーバーインスタンスで処理することがあり、カウンタがインスタンスごとに分かれてしまう。特に **1 日あたりの上限（招待メール・アップロードなど）は、Upstash を設定したときだけサーバーインスタンスをまたいで共有される**。未設定のままだと、日次の上限はほとんど効かない。
- **Redis に接続できないとき**: 上限を判定できないので、安全側に倒して処理を断る（API は 500 を返し、メールは送らず、ファイルも保存しない）。

設定手順:

1. [Upstash Console](https://console.upstash.com/) で Redis データベースを作成する（リージョンは Vercel の関数リージョンに近いものにする）
2. データベースの「REST API」欄から `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` の値をコピーする
3. Vercel Dashboard → Settings → Environment Variables に、この 2 つの名前のまま追加する（Environment は Production）。Marketplace 連携で自動追加される変数名はこのアプリが読む名前と異なる場合があるので、上の 2 つの名前で入っているかを確認する
4. 再デプロイする（環境変数は再デプロイで反映される）
5. 反映の確認: Vercel の関数ログに `[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が未設定です` という警告が出ていなければ、Upstash が使われている

### 任意の環境変数: Edge Function の CORS（`ALLOWED_ORIGINS`）

これは Vercel の環境変数ではなく、**Supabase の Edge Function の Secret** です（Supabase Dashboard → Edge Functions → Secrets、または `supabase secrets set ALLOWED_ORIGINS=...`）。

- 用途: ブラウザから Edge Function を直接呼ぶときに、呼び出し元として認めるサイトのオリジン（カンマ区切り。`https://` から書き、末尾に `/` を付けない）。
- 未設定なら `https://homegohan.app` と `https://homegohan-app.vercel.app` だけを認めます。設定すると、この 2 つの代わりに、設定した値だけを認めます。`*` と `null` は書いても無視されます。
- 普段は設定不要です。このアプリのブラウザやモバイルアプリが Edge Function を直接呼ぶ処理は無く、Next.js の API ルートがサーバーから呼んでいます（サーバーからの呼び出しは CORS の対象外です）。自社の別ドメインのページから直接呼ぶ処理を足すときだけ設定してください。
- バッチ専用の関数（`aggregate-org-stats` など）には、この設定に関係なく CORS を付けません。

---

## 🖥️ ローカル開発環境での設定

### 1. `.env.local` ファイルを作成

プロジェクトのルートディレクトリ（`package.json` がある場所）に `.env.local` ファイルを作成します。

```bash
# プロジェクトルートで実行
touch .env.local
```

### 2. 環境変数を記述

`.env.local` ファイルに以下の内容を記述してください：

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Cron Secret (Vercel Cron 認証用)
CRON_SECRET=your_cron_secret_here

# Google AI (Gemini)
GOOGLE_AI_STUDIO_API_KEY=your_google_ai_api_key
# または
GOOGLE_GEN_AI_API_KEY=your_google_ai_api_key

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# オプション: 画像生成モデル（デフォルト: gemini-3-pro-image-preview）
GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview

# オプション: レート制限（Upstash Redis）。ローカルは未設定でよい。本番では必ず設定する
# UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url
# UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
```

### 3. 実際の値を取得

#### Supabaseの値の取得方法
1. [Supabase Dashboard](https://app.supabase.com/) にログイン
2. プロジェクトを選択
3. 左メニューの「Settings」→「API」を開く
4. 以下の値をコピー:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` キー → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` キー → `SUPABASE_SERVICE_ROLE_KEY`（⚠️ 秘密にしてください）

#### Google AI APIキーの取得方法
1. [Google AI Studio](https://aistudio.google.com/) にアクセス
2. 「Get API Key」をクリック
3. 新しいAPIキーを作成または既存のキーをコピー
4. コピーしたキーを `GOOGLE_AI_STUDIO_API_KEY` に設定

#### OpenAI APIキーの取得方法
1. [OpenAI Platform](https://platform.openai.com/) にログイン
2. 「API keys」セクションに移動
3. 新しいAPIキーを作成または既存のキーをコピー
4. コピーしたキーを `OPENAI_API_KEY` に設定

### 4. 開発サーバーを再起動

環境変数を変更した後は、開発サーバーを再起動してください：

```bash
# サーバーを停止（Ctrl+C）してから
npm run dev
```

---

## ☁️ Vercel（本番環境）での設定

### 方法1: Vercel Dashboardから設定（推奨）

1. **Vercel Dashboardにアクセス**
   - [https://vercel.com/dashboard](https://vercel.com/dashboard) にログイン

2. **プロジェクトを選択**
   - デプロイ済みのプロジェクト（例: `homegohan-app`）をクリック

3. **Settingsに移動**
   - プロジェクトページの上部タブから「Settings」をクリック

4. **Environment Variablesを開く**
   - 左メニューの「Environment Variables」をクリック

5. **環境変数を追加**
   - 「Add New」ボタンをクリック
   - 各環境変数を追加:
     - **Key**: 環境変数名（例: `GOOGLE_AI_STUDIO_API_KEY`）
     - **Value**: 実際の値
     - **Environment**: 適用する環境を選択
     - Production（本番）
     - Preview（プレビュー）
     - Development（開発）
   - 「Save」をクリック

6. **再デプロイ**
   - 環境変数を追加/変更した後は、再デプロイが必要です
   - 「Deployments」タブに移動
   - 最新のデプロイメントの「...」メニューから「Redeploy」を選択

### 方法2: Vercel CLIから設定

```bash
# Vercel CLIをインストール（未インストールの場合）
npm i -g vercel

# プロジェクトにログイン
vercel login

# 環境変数を設定
vercel env add GOOGLE_AI_STUDIO_API_KEY
# プロンプトに従って値を入力

# 他の環境変数も同様に設定
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
# ... など

# 再デプロイ
vercel --prod
```

---

## 🔍 環境変数の確認方法

### ローカル環境

```bash
# .env.local ファイルの内容を確認（機密情報が含まれるため注意）
cat .env.local
```

### Vercel環境

1. Vercel Dashboard → プロジェクト → Settings → Environment Variables
2. 設定済みの環境変数が一覧表示されます

---

## ⚠️ 注意事項

1. **`.env.local` はGitにコミットしない**
   - `.gitignore` に含まれているため、通常は自動的に除外されます
   - 誤ってコミットしないよう注意してください

2. **環境変数の命名規則**
   - `NEXT_PUBLIC_` で始まる変数は、クライアントサイド（ブラウザ）でも利用可能です
   - それ以外の変数はサーバーサイドのみで利用可能です

3. **APIキーの管理**
   - APIキーは機密情報です。他人と共有しないでください
   - 漏洩した場合は、すぐにキーを再生成してください

4. **Vercelでの環境変数設定後**
   - 環境変数を追加/変更した後は、必ず再デプロイしてください
   - 再デプロイしないと、新しい環境変数は反映されません

---

## 🆘 トラブルシューティング

### 環境変数が読み込まれない

1. **ファイル名を確認**
   - `.env.local` という名前で、プロジェクトルートに配置されているか確認

2. **開発サーバーを再起動**
   - 環境変数を変更した後は、必ず開発サーバーを再起動

3. **Vercelの場合**
   - 環境変数設定後、再デプロイを実行しているか確認
   - 正しい環境（Production/Preview/Development）に設定されているか確認

### APIキーエラーが発生する

1. **キーが正しく設定されているか確認**
   - コピー&ペースト時に余分なスペースが入っていないか確認

2. **キーが有効か確認**
   - 各サービスのダッシュボードでキーの状態を確認

3. **環境変数名が正しいか確認**
   - 大文字小文字、アンダースコアなど、正確に一致しているか確認

---

## GitHub Actions secrets

migration auto-deploy のため以下の Repository secrets が必要:

- `SUPABASE_ACCESS_TOKEN`: Personal Access Token
  https://supabase.com/dashboard/account/tokens で生成
- `SUPABASE_DB_PASSWORD`: 本番 DB password
  Project Settings → Database → Connection string で取得

設定場所: GitHub リポジトリ → Settings → Secrets and variables → Actions → New repository secret

---

## 📚 参考リンク

- [Next.js Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables)
- [Vercel Environment Variables](https://vercel.com/docs/projects/environment-variables)
- [Supabase API Keys](https://supabase.com/docs/guides/api/api-keys)
- [Google AI Studio](https://aistudio.google.com/)



