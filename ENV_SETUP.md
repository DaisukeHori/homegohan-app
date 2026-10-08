# 環境変数設定ガイド

このプロジェクトで必要な環境変数の設定方法を説明します。

## 📋 必要な環境変数一覧

### 必須の環境変数

1. **Supabase関連**
   - `NEXT_PUBLIC_SUPABASE_URL` - SupabaseプロジェクトのURL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabaseの匿名キー
   - `SUPABASE_SERVICE_ROLE_KEY` - Supabaseのサービスロールキー（サーバーサイドのみ）

2. **Cron / スケジューラ関連**
   - `CRON_SECRET` - Vercel Cron からのリクエストを認証するシークレット（未設定の場合、cron エンドポイントは 503 を返す）
     - Vercel Dashboard → Settings → Environment Variables に設定
     - ランダムな英数字 32 文字以上を推奨
   - `app_cron_secret` (Supabase Vault) - pg_cron から Edge Function を呼び出す際の Bearer トークン

### Catalog cron secret (Supabase Vault)

Supabase Dashboard SQL Editor で以下を 1 度だけ実行:

```sql
SELECT vault.create_secret(
  '<Vercel の CRON_SECRET と同値>',
  'app_cron_secret',
  'CRON_SECRET for catalog import functions'
);
```

確認:
```sql
SELECT name FROM vault.secrets WHERE name = 'app_cron_secret';
```

4. **Google AI (Gemini) 関連**
   - `GOOGLE_AI_STUDIO_API_KEY` または `GOOGLE_GEN_AI_API_KEY` - Google AI APIキー

5. **OpenAI関連**（既存機能用）
   - `OPENAI_API_KEY` - OpenAI APIキー

---

## 📱 モバイル（Expo）での環境変数

Expoでは `EXPO_PUBLIC_` で始まる変数がクライアントに埋め込まれます（=秘密情報は入れない）。

### 必須（モバイル）
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

### オプション（モバイル）
- `EXPO_PUBLIC_API_BASE_URL` - Next.js API（BFF）を叩く場合（例: `https://homegohan.com`）
- `EXPO_PUBLIC_APP_ENV` - `development | preview | production`

サンプルは `apps/mobile/env.example` を参照してください。

### オプションの環境変数

- `GEMINI_IMAGE_MODEL` - 画像生成モデル（デフォルト: `gemini-3-pro-image-preview`）
  - 使用可能な値:
    - `gemini-2.5-flash-image-preview` (Nano Banana)
    - `gemini-3-pro-image-preview` (Nano Banana Pro - デフォルト)

### 本番では設定する環境変数: レート制限（Upstash Redis）

- `UPSTASH_REDIS_REST_URL` - Upstash Redis の REST URL
- `UPSTASH_REDIS_REST_TOKEN` - Upstash Redis の REST トークン（秘密情報。サーバーサイドのみ）

用途: AI 系 API の分あたりの上限と、招待メール・子供メンバーの参加リクエストメール・オーナー／代表者の譲渡提案メールの送信回数の上限（#1163）。

- **ローカル開発**: 未設定でよい。サーバープロセス内のメモリで数える（再起動でリセットされる）。
- **本番（Vercel）**: Production に必ず設定する。未設定でも動くが、Vercel は同じユーザーのリクエストを別のサーバーインスタンスで処理することがあり、カウンタがインスタンスごとに分かれてしまう。特に **1 日あたりの上限（招待メールなど）は、Upstash を設定したときだけサーバーインスタンスをまたいで共有される**。未設定のままだと、日次の上限はほとんど効かない。
- **Redis に接続できないとき**: 上限を判定できないので、安全側に倒して処理を断る（API は 500 を返し、メールは送らない）。

設定手順:

1. [Upstash Console](https://console.upstash.com/) で Redis データベースを作成する（リージョンは Vercel の関数リージョンに近いものにする）
2. データベースの「REST API」欄から `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` の値をコピーする
3. Vercel Dashboard → Settings → Environment Variables に、この 2 つの名前のまま追加する（Environment は Production）。Marketplace 連携で自動追加される変数名はこのアプリが読む名前と異なる場合があるので、上の 2 つの名前で入っているかを確認する
4. 再デプロイする（環境変数は再デプロイで反映される）
5. 反映の確認: Vercel の関数ログに `[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が未設定です` という警告が出ていなければ、Upstash が使われている

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



