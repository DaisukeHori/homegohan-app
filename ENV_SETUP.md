# 環境変数設定ガイド

このプロジェクトで必要な環境変数の設定方法を説明します。

## 環境変数の検査（`npm run check:env`）

このアプリが読む環境変数が、手元の `.env.local`（と実行中の環境変数）にそろっているかを確かめるコマンドです（#1182）。値は表示せず、変数の名前と、設定されているかどうかだけを出します。

```bash
npm run check:env                                  # .env.local → .env の順に読む
npm run check:env -- --file=.env.production.local  # 別の環境の値を書いたファイルを確かめる
npm run check:env -- --strict                      # 任意の変数の「値の形式の誤り」「組の片方だけの設定」も失敗にする
```

コマンドは `src/lib/env.ts`（TypeScript）を Node.js の型の除去で直接読み込むため、Node.js 22.18 以上が要ります（このリポジトリの `engines` は `22.x`）。古い Node.js では、その旨を案内して終了コード 2 で止まります。

変数は 2 種類に分かれています。一覧とその説明は `src/lib/env.ts` にあります（コマンドもコードも、同じ一覧を使います）。

| 種類 | 変数 | 足りないとき |
|---|---|---|
| **必須** | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | アプリが動きません。コードは、使う場面でエラー（`MissingEnvError`）を出します。状態コードは場面ごとに次のとおりです。URL か anon キーが無いと、middleware がページと API（`/api/health` を除く）を汎用の 500 で止めます。`/api/health` は middleware を通らず、`?deep=1` のときだけ 503（`status: "degraded"`）を返します（`?deep=1` が無ければ DB を見ないので 200 のままです）。`SUPABASE_SERVICE_ROLE_KEY` だけが無いと、それを使う API はほとんどが 500 になります。ただし `POST /api/super-admin/embeddings/regenerate` は 503（`OP_EMBEDDING_JOB_UNAVAILABLE`）を返します。`POST /api/org/owner-transfer/propose` は提案の作成は成功のまま、通知メールだけを送りません。献立の画像生成ワーカーの起動（`lib/meal-image-jobs.ts`）と、AI の利用記録の署名ヘッダー（`src/lib/plan/entitlements.ts`）は、エラーにせずに飛ばします。応答（本文・ヘッダ・エラーページ）には変数名も値も出しません。本文は API によって、汎用の文（「処理中にエラーが発生しました」）・`MissingEnvError` の固定の文（変数名は入りません）・Next.js の既定のエラーのどれかです。どの変数が足りないかは、サーバーのログの `[env] missing required env: <変数名>` の行（どの経路でも出ます）と、`npm run check:env` で分かります。500 を `internalError()` で返す API と middleware では、構造化ログの `missing_env_name` にも残ります（console に出る構造化ログには必ず入ります。`app_logs` に書けるのは URL と `SUPABASE_SERVICE_ROLE_KEY` がそろっているとき、つまり anon キーだけが無いときです）。コマンドは終了コード 1 |
| **任意** | メール（`RESEND_API_KEY`）・レート制限（`UPSTASH_REDIS_REST_*`）・課金（`STRIPE_SECRET_KEY`・`STRIPE_WEBHOOK_SECRET`）・AI（`GOOGLE_AI_STUDIO_API_KEY`・`XAI_API_KEY`・`OPENAI_API_KEY`）・`CRON_SECRET`・モバイル認証ブリッジのスイッチ（`NATIVE_BRIDGE_*`）・規約の再同意のスイッチ（`LEGAL_CONSENT_*`）など | アプリは動きますが、その機能が使えなくなったり弱くなったりします。コマンドは「未設定です。…が起きます」と表示するだけです |

- 任意の変数が足りないことで、本番を止めてはいけません。任意の変数を読む共通の関数（`getOptionalEnv()`。`src/lib/env.ts`）は、変数が無いときに例外を投げず、`undefined` を返して、プロセスごとに 1 回だけ警告をログに残します。メール送信・レート制限・Stripe・AI など、いまは各機能が `process.env` を直接読んでいる箇所が残っていて、ほかの作業と重ならないところから順にこの関数へ置き換えていきます。
- 下の「必須の環境変数」は `src/lib/env.ts` の必須（`required: true`）と同じ 3 つだけです。`CRON_SECRET`・Google AI（Gemini）・OpenAI は、その下の「機能ごとに要る環境変数」に分けてあります。`check:env` ではどれも任意です（無くてもアプリ本体は動き、cron の API が 503 を返す・その AI の機能が使えない、になるだけのため）。本番では、使う機能の分を設定してください。
- `check:env` は **CI には組み込んでいません**（CI にはシークレットが無く、必須の変数がそろわないため）。デプロイ前や環境を作り直したときに、手元で実行してください。
- 新しい環境変数を足すときは、`src/lib/env.ts` の一覧に足し（必須にするのは、無いとアプリが動かないものだけ）、`.env.example` にも書いてください（`tests/env-source-scan.test.ts` が、Web のコードが読む変数が一覧に無いとき・一覧の変数が `.env.example` に無いときに失敗します）。コードで `process.env.X!` と書くのは禁止です。
- モバイルアプリ（`apps/mobile`）の変数は別です。下の「モバイル（Expo）での環境変数」を見てください。`EXPO_PUBLIC_SUPABASE_URL`・`EXPO_PUBLIC_SUPABASE_ANON_KEY`・`EXPO_PUBLIC_API_BASE_URL` のどれかが無いビルドは、開発中は起動時のエラーか設定エラーの画面になり、リリースビルドでは「アプリの設定が不足しています」という画面を出します（接続先の無いままログイン画面を出し続けません）。

## 📋 必要な環境変数一覧

### 必須の環境変数

`src/lib/env.ts` で必須にしている変数です（`npm run check:env` は、1 つでも無いと終了コード 1）。無いとアプリが動きません（上の表）。

1. **Supabase関連**
   - `NEXT_PUBLIC_SUPABASE_URL` - SupabaseプロジェクトのURL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabaseの匿名キー
   - `SUPABASE_SERVICE_ROLE_KEY` - Supabaseのサービスロールキー（サーバーサイドのみ）

### 機能ごとに要る環境変数（`check:env` では任意）

無くてもアプリは動きますが、その機能が動きません（`src/lib/env.ts` では任意。`npm run check:env` は「未設定です。…」と表示するだけです）。本番では設定してください。

1. **Cron / スケジューラ関連**（3 か所に別々に保管する。役割と値を合わせる必要があるかは「Cron の共有シークレットの保管場所とローテーション」を参照）
   - `CRON_SECRET` - Vercel Cron からのリクエストを認証するシークレット（未設定の場合、cron エンドポイントは 503 を返す）
     - Vercel Dashboard → Settings → Environment Variables に設定
     - ランダムな英数字 32 文字以上を推奨
   - `CRON_SECRET` (Supabase Edge Function secrets) - pg_cron などから Edge Function を呼び出すときに受け取る側が確かめるシークレット。Vault の `app_cron_secret` と同じ値にする（別名 `SERVICE_ROLE_SECRET` は、`CRON_SECRET` が無いときだけ使われる）
   - `app_cron_secret` (Supabase Vault) - pg_cron から Edge Function を呼び出す際の Bearer トークン
   - `CRON_SECRET_PREVIOUS` - シークレットを入れ替える間だけ設定する旧い値。普段は設定しない（Vercel と Edge Function secrets のどちらにも置ける）

2. **Google AI (Gemini) 関連**（無いと、Gemini を使う機能 (写真の解析・画像生成など) が使えない）
   - `GOOGLE_AI_STUDIO_API_KEY` または `GOOGLE_GEN_AI_API_KEY` - Google AI APIキー

3. **OpenAI関連**（既存機能用。無いと、栄養フィードバック (`/api/ai/nutrition/feedback`) が使えない）
   - `OPENAI_API_KEY` - OpenAI APIキー

4. **Stripe (課金) 関連**（無いと、有料プランの購入・管理が動かない。手順は `docs/design/billing/01-billing-core.md` §17）
   - `STRIPE_SECRET_KEY` - Stripe の秘密鍵（`sk_live_…` / `sk_test_…`）。Checkout・Billing Portal・解約の予約と取り消し・退会での解約に使う。無いと、これらの API は 503（契約の要約と確認画面の内容は 200 のまま）
   - `STRIPE_WEBHOOK_SECRET` - Stripe の Webhook の署名の秘密（`whsec_…`。Stripe の Dashboard で Webhook のエンドポイントを登録すると出る）。`POST /api/webhooks/stripe` が署名を確かめるのに使う。無いと Webhook は 503

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

---

## Cron の共有シークレットの保管場所とローテーション

cron から呼ばれる API や Edge Function は、リクエストの `Authorization: Bearer <シークレット>` が正しいかを確かめて、呼び出し元を判断します。この「シークレット」は、次の 3 か所に **別々に** 置かれています。自動では同期されないので、各場所の役割と、値を合わせる必要があるかどうかを先に押さえてください。

### 3 つの保管場所

| 保管場所 | 名前 | 役割 | 他と値を合わせる必要 |
|---|---|---|---|
| Vercel の環境変数 | `CRON_SECRET` | 送る側も受ける側も Vercel の中で完結します。Vercel Cron が `/api/cron/process-menu-queue`・`/api/cron/app-log-alerts`・`/api/cron/email-outbox`・`/api/cron/push-outbox`・`/api/cron/backup-freshness`・`/api/cron/login-alerts`（どれも `vercel.json` の `crons`）を呼ぶとき、この値を自動で `Authorization: Bearer ...` に付けます。受ける側の Next.js（`src/lib/cron-auth.ts`）が、同じ環境変数と照らし合わせます | **不要**。他の 2 か所と別の値にしてかまいません（別の値にしておくと、片方が漏れてももう片方は守られます） |
| Supabase の Edge Function secrets | `CRON_SECRET`（別名 `SERVICE_ROLE_SECRET`。`CRON_SECRET` が無いときだけ代わりに使われます） | **受ける側**。`supabase/functions/_shared/auth.ts` の `requireServiceRole` が、次の Edge Function でこの値と照らし合わせます: コンビニカタログ取り込み 5 本（`import-seven-eleven-catalog` / `import-familymart-catalog` / `import-lawson-catalog` / `import-natural-lawson-catalog` / `import-ministop-catalog`）、`aggregate-org-stats`（停止中。認証だけ行い 410 を返します。#1325）、`calculate-segment-stats`、`purge-hidden-content`（運営が隠したコンテンツの完全削除。#1538）、`process-meal-image-jobs`（料理画像のジョブの処理。#1561）、`cron-secret-probe`（cron の共有シークレットの確認。#1560）、`regenerate-embeddings`、`stripe-price-sync`（最後の 3 本は service role key でも呼べます） | Vault の `app_cron_secret` と **同じ値にする** |
| Supabase Vault | `app_cron_secret` | **送る側**。pg_cron が定期実行する次の関数がこの値を読み、`Authorization: Bearer ...` に付けて Edge Function を呼びます: `public.invoke_catalog_import()`（コンビニカタログ取り込みの Edge Function 5 本。登録時のスケジュールは、毎日 UTC 3:00〜4:00 に 15 分おき）、`public.invoke_calculate_segment_stats()`（比較ランキングの集計 `calculate-segment-stats` を daily / weekly / monthly の 3 回。期間が切り替わった直後の回は直前の期間の分も。ジョブ `calculate-segment-stats`、1 時間ごと（毎時 5 分）。#1406）、`public.invoke_calculate_segment_stats_finalize_retry()`（その直前の期間の分の再試行。ジョブ `calculate-segment-stats-finalize-retry`、毎日 JST 0:20 と 0:35。#1500）、`public.invoke_process_meal_image_jobs()`（料理画像の待ちのジョブがあれば `process-meal-image-jobs` を 1 回。ジョブ `process-pending-meal-image-jobs`、5 分ごと。#1561）、`public.invoke_purge_hidden_content()`（運営が隠してから 90 日を過ぎた食事・レシピと画像を消す `purge-hidden-content`。ジョブ `purge-hidden-content`、毎日 JST 3:25。#1538）、`public.send_cron_secret_probe()`（`GET /api/cron/app-log-alerts` が 15 分おきに呼ぶ確認。Edge Function `cron-secret-probe` を 1 回。#1560） | Edge Function secrets の `CRON_SECRET` と **同じ値にする** |

つまり、**値を合わせないと動かないのは「Edge Function secrets の `CRON_SECRET`」と「Vault の `app_cron_secret`」の 2 つだけ**です。Vercel の `CRON_SECRET` は独立しています。

### 値が合っていないとどうなるか

- 値が違う → Edge Function は HTTP 401（本文 `{"error":"Unauthorized"}`）を返します。
- Edge Function 側に `CRON_SECRET`（と `SERVICE_ROLE_SECRET`）が無い → HTTP 503（本文 `{"error":"Service not configured"}`）を返します。
- Edge Function 側に、関数が動くのに要る secrets が無い → HTTP 503（本文 `{"error":"サーバーの設定が不足しています","code":"SERVER_CONFIG_MISSING"}`。カタログ取り込みは `"success":false` も付きます）を返します。503 になる secrets は関数ごとに違います: コンビニカタログ取り込み（`_shared/catalog/import-runner.ts` を使う関数）は `SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`（`SERVICE_ROLE_JWT` でも可）・`FIRECRAWL_API_KEY`（`FIRECRAWL_AUTH_TOKEN` でも可。`FIRECRAWL_BASE_URL` で自前の Firecrawl を指すときは不要）、`process-meal-image-jobs` は `SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`（`SERVICE_ROLE_JWT` でも可）・Google AI のキー（`GOOGLE_AI_STUDIO_API_KEY` か `GOOGLE_GEN_AI_API_KEY`）、`stripe-price-sync` は `STRIPE_SECRET_KEY` だけです。`stripe-price-sync` は、`SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`（`SERVICE_ROLE_JWT` でも可）だけが無いときは 503 にせず、新しい Price を作ったうえで旧 Price の無効化を飛ばして HTTP 200 を返します（本文の `month` / `year` のうち、新しい Price を作った方が `"deactivated":false,"deactivation_skipped_reason":"old_price_fetch_failed"` になります）。どの関数も、応答の本文や例外の文には変数名を出さず、足りない変数名は関数のログ（Supabase Dashboard → Edge Functions → Logs）の `[env] missing required env: <変数名>` の行にだけ残します（#1467）。
- pg_cron は pg_net で **非同期に** 呼び出すため、cron ジョブ自体は成功扱いのままです（`cron.job_run_details` は HTTP の結果にかかわらず `succeeded` になります）。エラーの表示もなく、カタログ取り込みだけが止まります。

値とは別に、**関数のゲートウェイの JWT 検証（`verify_jwt`）が有効なまま** だと、値が合っていても関数に届く前に止まります。`app_cron_secret`（`CRON_SECRET`）はランダムな文字列で JWT ではないため、Supabase のゲートウェイが HTTP 401（本文 `{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT", ...}`）を返します。pg_cron から呼ぶ関数は `supabase/config.toml` で `verify_jwt = false` にしてあり（認証は関数の中の `requireServiceRole` が行います。#1406）、GitHub Actions の「Deploy Supabase Functions」がこの設定ごとデプロイします。この 401 が出たら、設定がまだデプロイされていません。Actions の「Deploy Supabase Functions」が成功しているかを確かめ、必要なら手動で実行（Run workflow）し直してください。

直近の呼び出し結果は、Supabase Dashboard の SQL Editor で次のように確かめられます。古い結果は自動で消える（既定では約 6 時間）ので、実行の直後に見てください。

```sql
SELECT id, status_code, timed_out, error_msg, created
FROM net._http_response
ORDER BY created DESC
LIMIT 20;
```

- `status_code` が **401** の行がある → 値が合っていません。ただし 401 の本文が `UNAUTHORIZED_INVALID_JWT_FORMAT` なら、値ではなくゲートウェイの JWT 検証で止まっています（上を参照）。
- `status_code` が **503** の行がある → 値のずれではなく、Edge Function secrets に足りないものがあります。本文で見分けます。
  - 本文が `{"error":"Service not configured"}` → Edge Function secrets に `CRON_SECRET`（と `SERVICE_ROLE_SECRET`）がありません。
  - 本文に `"code":"SERVER_CONFIG_MISSING"` がある → 認証は通っています。関数が動くのに要る secrets（`SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`・`FIRECRAWL_API_KEY` など）が足りません。足りない変数名は、関数のログの `[env] missing required env: <変数名>` の行で確かめてください（上を参照）。
- 本文は `content::text` で見られます（下の「比較ランキングの集計が動いているかの確かめ方」のクエリ）。
- `status_code` が 200 → 認証は通っています。
- `status_code` が空で `timed_out` が true → 認証は通っています。取り込みに 5 秒以上かかると、pg_net が先に待つのをやめるためです（正常）。

上のクエリは「ずれた結果」を見るものです。値そのもののずれは、次の「値のずれの確かめ方」のスクリプトで、呼び出しを待たずに確かめられます。

### 値のずれの確かめ方（`check-cron-secret-drift`）

`node scripts/check-cron-secret-drift.mjs` は、3 か所の保管場所から **値ではなく SHA-256 のダイジェストだけ** を集めて比べます（#1196）。表示するのは、一致・不一致と、ダイジェストの先頭 8 文字だけです。どの保管場所も読むだけで、書き換えません。本番の資格情報が要るので、オーナーが手元で実行します（CI には組み込んでいません）。

```bash
# Edge Function secrets・Vault・Vercel の 3 か所を確かめる
# (Vault の接続先は、値をコマンドラインに書かずに環境変数 SUPABASE_DB_URL で渡す。psql で接続する)
node scripts/check-cron-secret-drift.mjs --project-ref <project-ref>

# psql を使わないとき: SQL Editor で下の SQL を実行し、出たダイジェスト (16 進 64 文字) を渡す
node scripts/check-cron-secret-drift.mjs --project-ref <project-ref> --vault-digest <ダイジェスト>
```

```sql
-- Vault のダイジェストだけを返す (値は返さない)。行が出なければ --vault-missing を付けて実行する
SELECT coalesce(encode(extensions.digest(convert_to(decrypted_secret, 'UTF8'), 'sha256'), 'hex'), '') AS digest
FROM vault.decrypted_secrets WHERE name = 'app_cron_secret';
```

| 保管場所 | ダイジェストの取り方 | 要るもの |
|---|---|---|
| Edge Function secrets（`CRON_SECRET`・`SERVICE_ROLE_SECRET`・`CRON_SECRET_PREVIOUS`） | `supabase secrets list -o json`。Supabase は値を返さず、SHA-256 のダイジェストだけを返します | supabase CLI（ログイン済み、または `SUPABASE_ACCESS_TOKEN`） |
| Vault（`app_cron_secret`） | 上の SQL を psql で実行（接続先は環境変数 `SUPABASE_DB_URL`。`--db-url-env` で別の名前にできます）、または SQL Editor で実行して `--vault-digest` で渡す | psql、または SQL Editor |
| Vercel（`CRON_SECRET`・`CRON_SECRET_PREVIOUS`） | `vercel env pull` を、権限 700 の一時ディレクトリに umask 077 で書かせ、ダイジェストを計算したらすぐ消します（既定は `--vercel-environment production`）。Sensitive の変数は値の代わりに `[SENSITIVE]`（古い vercel CLI では空）で書かれるので、ある・無いだけを確かめます | vercel CLI（ログイン済み。このディレクトリにリンクしていないときは `--vercel-project` / `--vercel-scope`） |

判定（`--help` に全部のオプションがあります）:

- **FAIL**（終了コード 1）: Edge Function secrets の `CRON_SECRET`（無いときだけ `SERVICE_ROLE_SECRET`）と Vault の `app_cron_secret` が食い違う（pg_cron の呼び出しが 401）／どちらかが無い・空（503・例外）／Vercel の `CRON_SECRET` が無い（cron の API が 503）。
  - Edge Function secrets と Vault が食い違ったら、**Vault の `app_cron_secret` を正として、Edge Function secrets の `CRON_SECRET` をそれに合わせます**（下の「Edge Function secrets の設定手順」。Vault の値は控え（パスワードマネージャ）から取り出します。控えが無いときは、SQL Editor で `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_cron_secret';` を実行して読めます。画面に値が出るので、周りに人がいないところで行ってください）。`CRON_SECRET` が無く `SERVICE_ROLE_SECRET` が使われているときも、`CRON_SECRET` に Vault の値を入れます（`CRON_SECRET` があれば `SERVICE_ROLE_SECRET` は見られません）。Vault を変えるのは、Vault の値が漏えいした・失われたなど、入れ替えそのものが目的のときだけです。そのときは下の「ローテーション手順」に従います。合わせた後に、もう一度実行して Edge ⇔ Vault が PASS になることを確かめます。
- **WARN**: Vault がまだ Edge Function secrets の `CRON_SECRET_PREVIOUS`（旧い値）と同じ（入れ替えの途中。下の手順の 2 と 3 の間）／Vault が新しい値なのに `CRON_SECRET_PREVIOUS` が残っている（手順 5 の外し忘れ）／`CRON_SECRET_PREVIOUS` が現行と同じ／Vercel の `CRON_SECRET` が Sensitive の変数で値を取り出せない（`vercel env pull` では値の代わりに `[SENSITIVE]`、古い vercel CLI では空で書かれるため、ある・無いしか分かりません。`--vercel-must-match` を付けていても FAIL にはせず WARN にします）。
- **INFO**: Vercel の `CRON_SECRET` が Supabase 側と同じか違うか。上の表のとおり Vercel は独立しているので、違っていても失敗にしません（同じ値で運用すると決めたときは `--vercel-must-match` で FAIL にできます）。
- 読めなかった保管場所がある（CLI が無い・ログインしていない・接続できない）と、終了コード 2 です。ただし、FAIL と「読めなかった」が同時のときは、終了コード 1 を優先します（読めた保管場所だけで、すでにずれが分かっているため）。`--skip-edge` / `--skip-vault` / `--skip-vercel` で、その保管場所を外して実行できます。
- 読めなかったときは、コマンド（`supabase secrets list`・`vercel env pull`・`psql`）の標準エラー出力の末尾 5 行を理由として出します。その中の値・URL・パスワードやトークンらしきものは `***` に伏せます。
- 実行中に Ctrl-C などで止めても、`vercel env pull` に書かせた一時ファイル（本番の全部の環境変数が入ります）は消してから終わります（終了コードは 128 + シグナル番号。Ctrl-C なら 130）。消せなかったときは、その場所を表示するので、手で消してください。

ローテーションの後（下の手順の 4 と 5）と、カタログ取り込みや比較ランキングの集計の結果がおかしいときに実行してください。

#### 自動の確認（`GET /api/cron/app-log-alerts`。#1560）

手で流す検査とは別に、運用アラートの cron（15 分おき）が自動で確かめます。DB の `send_cron_secret_probe()` が Vault の `app_cron_secret` を Bearer に付けて Edge Function `cron-secret-probe` を 1 回呼び（pg_cron の実際の呼び出しと同じ道）、次の回がその結果を判定します。検知の遅れは最大 30 分です。`OPS_ALERT_EMAIL` が未設定のときは何もしません。

- **FAIL**（食い違い・Edge に値が無い・Vault が無い／空／復号できない・ゲートウェイの JWT 検証・未デプロイ・時間切れ・pg_net の不達）は、キー `cron_secret_drift` の運用メールで知らせます。抑止は `OPS_ALERT_COOLDOWN_MINUTES`（既定 60 分）で、直るまでその間隔で届きます。
- **WARN**（入れ替えの途中・Edge Function secrets や Vercel の `CRON_SECRET_PREVIOUS` の残り・Vault が service role key）は、キー `cron_secret_rotation` の運用メールで知らせます。抑止は `OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES`（既定 1440 分 = 24 時間。1 日 1 通まで）で、ずれの通知には載りません。
- Vercel の `CRON_SECRET` と Supabase 側（Edge Function secrets・Vault）の一致は比べません（Vercel は独立した値です）。Vercel の `CRON_SECRET` 自体が無いときは、この cron 自身が動かないので検知できません（Vercel の Cron Jobs の画面の HTTP ステータスで分かります）。
- 値もダイジェストも計算しません（手で流す検査との違い）。メールに載るのは所見の題と対処だけです。所見の一覧と読み方は [`docs/design/operator/12-cron-secret-drift-monitor.md`](docs/design/operator/12-cron-secret-drift-monitor.md) の §8.1.1。

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
2. **Edge Function secrets に、新旧を同時に設定する。** `CRON_SECRET` に新しい値、`CRON_SECRET_PREVIOUS` に旧い値を入れます。これで、新旧どちらの Bearer も通ります。Vault はまだ旧い値のままなので、pg_cron の呼び出しは変わらず通り続けます。反映に少し時間がかかることがあるので、数分待ちます。この間、自動の確認が Vault を更新するまで 24 時間に 1 通「入れ替えが途中です」を送ります（下の「自動の確認」）。
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
   あわせて `node scripts/check-cron-secret-drift.mjs` で、Edge Function secrets と Vault が一致していること（Edge ⇔ Vault が PASS）を確かめます（上の「値のずれの確かめ方」）。
5. **旧い値を外す。** 翌日の定期実行（UTC 3:00〜4:00）が終わるまで待ち、Edge Function のログに `CRON_SECRET_PREVIOUS (旧いシークレット) で認証されました` が出ていない（= 旧い値を使っている送り手が残っていない。`/cron-secret-probe` の記録は、自動の確認が Vault の値で呼んだものなので除く。Vault を更新したあとは、この記録も出なくなる）ことを確かめてから、`CRON_SECRET_PREVIOUS` を削除します。削除した後に `node scripts/check-cron-secret-drift.mjs` を実行し、`CRON_SECRET_PREVIOUS` の WARN が消えていることを確かめます。外すまでは旧い値でも通ってしまうので、入れ替えの目的が漏えい対策なら、できるだけ早く外してください。

途中で戻したくなったときは:

- 手順 3 の前なら、`CRON_SECRET` を旧い値に戻し、`CRON_SECRET_PREVIOUS` を削除します。
- 手順 3 の後なら、Vault の `app_cron_secret` を旧い値に戻します（`CRON_SECRET_PREVIOUS` が残っている間は、新旧どちらでも通ります）。

旧い値の控えが無いときは、`CRON_SECRET_PREVIOUS` を使えません。コンビニカタログの取り込みが動かない時間帯（UTC 4:30〜翌 2:30）の、比較ランキングの集計の回（毎時 5 分）を避けた時刻（例: 毎時 10 分〜55 分）に、手順 2 では `CRON_SECRET` だけを新しい値にして、すぐ手順 3 を行ってください。その数分の間だけ、手動で呼ぶ処理が 401 になります。比較ランキングの集計の回と重なって 401 になっても、次の回（1 時間後）で取り戻せます（JST 0 時台は、直前の期間の集計し直しとバッジの判定を 0:05 に行い、失敗したときの再試行が 0:20 と 0:35 にしかないので、避けてください）。

### 比較ランキングの集計の間隔

比較ランキング（Web の `/comparison`・モバイルの比較画面）の集計 `calculate-segment-stats` は、pg_cron のジョブ `calculate-segment-stats` が **1 時間ごと（毎時 5 分）** に呼びます（migration `20261009100000_schedule_calculate_segment_stats.sql`。#1406）。

- 毎回、daily / weekly / monthly の 3 つの要求が pg_net から並行して出ます。1 つの要求が読むものは次のとおりです（#1491）。
  - 指標とセグメントの定義（`metric_definitions`・`segment_definitions`）。有効なものだけ。
  - 自分の期間の食事の記録（`meals`。monthly は 1 か月分）と献立（`planned_meals`）を全件。どちらもハンズオンのお試しの記録（`meals.is_sandbox`・`user_daily_meals.is_sandbox` が true）は除きます（#1500）。運営が隠した食事（`meals.hidden_at` が入った行。#1101）も読みません（#1445）。
  - 指標 `total_meals`（全期間の食事の記録の件数）が有効なら、DB の関数 `count_meals_per_user`（migration `20261011060000_count_meals_per_user.sql`。お試しの記録を数えないのは `20261011120000_segment_stats_finalize_retry.sql` から、運営が隠した食事も数えないのは `20261011130000_count_meals_per_user_exclude_hidden.sql` から）が数えた、記録のある利用者 1 人につき 1 行の件数。`meals` の全期間の行は読みません。`total_meals` が有効でなければ呼びません。
  - そのほか、全利用者のプロフィール（`user_profiles`）と継続日数（`health_streaks`）。
  - 変化率の計算元として、1 つ前の期間の指標（`user_metrics`。同じ種類の 1 つ前の期間の分）。
  - ランキングを作るときに、書いたばかりのセグメントの統計（`segment_stats`）の平均を、セグメントと指標の組ごとに 1 行ずつ。
  - 確定の回（下の、直前の期間を集計し直す回）だけ: バッジの定義（`badges`）、その期間のランキング（`user_segment_rankings`。バッジの判定に使う）、確定の回をやり終えた期間の記録（`segment_stats_finalized_periods`）。
  - どれも 1 回の応答が 1000 行を超えると、1000 行ずつ取り直します。
- 日・週・月が切り替わった直後の回（JST 0:05）は、切り替わった種類について直前の期間も 1 回だけ集計し直します（最大 3 つ増えます）。期間の最後の 1 時間（例: 23:05〜23:59）の記録を、その期間の最終の値に入れるためです。
- 比較のバッジ（順位・上位 X%・平均超え・改善）は、この直前の期間を集計し直す回（確定の回）だけが判定します（#1491）。毎時の今の期間の回は、指標・統計・ランキングを更新するだけです（期間の途中の暫定の値で、取り消されないバッジを付けないため）。手動の集計（`POST /api/comparison/trigger`）も今の期間を集計するので、バッジは付きません。
  - 確定の回は、付けたバッジを `user_badges`（1 バッジ 1 行。最初に取ったときの行だけが残る）に書き、取った期間を表 `user_badge_period_awards`（1 期間 1 行。2 回目以降の期間も残る。migration `20261015130000_user_badge_period_awards.sql`。#1528）にも書きます。獲得済みのバッジの一覧（Web・アプリのバッジの画面）は、この表から「どの期間に取ったか（最新の期間）」と「何回取ったか」を出します（同じ migration の関数 `get_my_badge_period_award_summaries` が DB の中でバッジごとにまとめます。表の行のまま読むと 1 回の応答の 1000 行で打ち切られるためです）。この migration を流す前に新しい Edge Function をデプロイすると、確定の回が「表が無い」で 500 になります（migration が先）。
- 確定の回は、失敗したとき（pg_net の待ち時間切れ・Edge Function の 500 など）のために、ジョブ `calculate-segment-stats-finalize-retry` が **JST 0:20 と 0:35**（UTC 15:20 と 15:35）に同じ本文で 2 回まで呼び直します（migration `20261011120000_segment_stats_finalize_retry.sql`。#1500）。間隔の 15 分は、応答を待つ上限（400 秒）より長くしてあり、前の試みと重なりません。再試行が送るのは確定の回の本文だけです（今の期間の本文は送りません）。
  - Edge Function は、確定の回をバッジの判定まで終えたら、その期間（種類と開始日）を表 `segment_stats_finalized_periods` に記録します。記録がある期間への確定の回は、何も読まず何も書かずに `{"success":true,"alreadyFinalized":true, ...}` を返します。0:05 の回が成功していれば、0:20 と 0:35 の回は何もしません（期間が終わったあとに足された記録で、確定した値やバッジを変えません。同じバッジが 2 つ付くこともありません）。
  - 3 回とも失敗しても、知らせる仕組みはありません（運用メールのエラー急増の通知は、15 分で error が 20 件を超えたときだけ送るので、この 3 件だけでは届きません）。JST 0:40 以降に、下の「比較ランキングの集計が動いているかの確かめ方」の 4 と 6 で確かめてください。
  - 確定の回をやり直したいとき（失敗したまま窓を過ぎた、など）は、SQL Editor で、その期間の記録を消してから（`DELETE FROM public.segment_stats_finalized_periods WHERE period_type = 'weekly' AND period_start = '2026-10-05';` のように）、確定の回を呼び直してください。再試行の関数は、期間が切り替わってから 1 時間を過ぎると何も送らないので、窓の外では、本文 `{"periodType":"weekly","previousPeriod":true}` で Edge Function を直接呼びます（Bearer は Edge Function secrets の `CRON_SECRET`）。直接呼んだときに集計し直すのは「今の 1 つ前の期間」です。
- 応答を待つ上限は 400 秒です。間隔（1 時間）より十分短いので、前の回と重なりません。直近の結果は `net._http_response` で確かめられます（下の「比較ランキングの集計が動いているかの確かめ方」）。

利用者が増えて毎時の集計が重くなったら、Supabase Dashboard の SQL Editor で間隔を広げられます（migration は要りません）。例: 3 時間ごと

```sql
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'calculate-segment-stats'),
  schedule := '5 */3 * * *'
);
```

- **UTC 15 時台（= JST 0 時台）の回を必ず含めてください。** 直前の期間の集計し直しは、期間が切り替わってから 1 時間以内（`calculate_segment_stats_request_bodies` の `c_finalize_window`）の回だけが行います。含めないと、期間の最終の値が入らないうえ、比較のバッジが一度も判定されません。`'5 */3 * * *'` は UTC 0, 3, …, 15, 18, 21 時なので含みます。`'5 */2 * * *'` は含まないので使えません。
- 間隔を変えるときは、次の migration でジョブのスケジュールを揃えてください（`tests/segment-stats-schedule-sync.test.ts` が migration の間隔・期間の種類と、Web の比較画面の選択肢・手動の API を突き合わせます）。アプリの比較のタブは WebView で Web の比較画面を出します（以前あったネイティブの比較画面 `apps/mobile/app/comparison/index.tsx` の更新の間隔の案内は、タブと同じパスの届かない画面として消しました。#1598）。
- 今の設定は `SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'calculate-segment-stats';` で確かめられます。

### 比較ランキングの集計が動いているかの確かめ方

migration の適用後や、`supabase/config.toml` の `verify_jwt` を変えたデプロイの後に、Supabase Dashboard の SQL Editor で順に確かめます（どれも読み取りだけです）。

1. Vault に `app_cron_secret` がある（値は Edge Function secrets の `CRON_SECRET` と同じにしておく）。

   ```sql
   SELECT name, updated_at FROM vault.secrets WHERE name = 'app_cron_secret';
   ```

2. ジョブが登録されている。

   ```sql
   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'calculate-segment-stats%';
   ```

3. 毎時 5 分の回のあと、ジョブが動いた。

   ```sql
   SELECT status, return_message, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
   ```

   `succeeded` は「pg_net に要求を積めた」という意味でしかありません。Edge Function が 401 を返していても `succeeded` になります。HTTP の結果は次の 4 で見ます。

4. **HTTP の結果を見る。** 1 回の実行で要求は 3 つ（daily / weekly / monthly）、JST 0:05 の回は最大 6 つ出ます。

   ```sql
   SELECT status_code, content::text FROM net._http_response ORDER BY created DESC LIMIT 6;
   ```

   - `status_code` が 200 で、本文が `{"success":true, ...}` → 集計できています。JST 0:20 と 0:35 の再試行の回（ジョブ `calculate-segment-stats-finalize-retry`。要求は切り替わった種類の数だけ、最大 3 つ）は、0:05 の確定の回が成功していれば `"alreadyFinalized":true` を返します（何もしていない。正常）。
   - 401 で、本文が `UNAUTHORIZED_INVALID_JWT_FORMAT` → ゲートウェイの JWT 検証で止まっています。`verify_jwt = false` がまだデプロイされていません（上の「値が合っていないとどうなるか」）。
   - 401 で、本文が `{"error":"Unauthorized"}` → Vault の `app_cron_secret` と Edge Function secrets の `CRON_SECRET` の値が合っていません。
   - 503 で、本文が `{"error":"Service not configured"}` → Edge Function secrets に `CRON_SECRET` がありません（本文に `"code":"SERVER_CONFIG_MISSING"` がある 503 は、同じ表に入るカタログ取り込みの結果です。上の「値が合っていないとどうなるか」）。
   - 500 → 認証は通り、集計の途中で失敗しています。Supabase Dashboard の Edge Functions → `calculate-segment-stats` → Logs を見てください。
   - 行がまだ無い → 応答を待っています（上限 400 秒）。少し待ってから見直してください。古い結果は自動で消える（既定では約 6 時間）ので、実行の直後に見てください。
   - ほかの pg_net の呼び出し（カタログ取り込み）の結果も同じ表に入ります。UTC 3:00〜4:00 の回と重なったら、件数を増やして見分けてください。

5. 集計の結果が入っている。

   ```sql
   SELECT period_type, max(period_start) AS latest_period, count(*) AS rows
   FROM public.segment_stats
   GROUP BY period_type;
   ```

6. 確定の回（直前の期間の集計し直しとバッジの判定）をやり終えた期間が記録されている（#1500）。JST 0:40 を過ぎても、切り替わった種類の直前の期間の行が無ければ、0:05・0:20・0:35 の 3 回とも失敗しています。4 の結果と Edge Function のログで原因を確かめ、上の「比較ランキングの集計の間隔」の手順でやり直してください。

   ```sql
   SELECT period_type, period_start, period_end, finalized_at
   FROM public.segment_stats_finalized_periods
   ORDER BY finalized_at DESC
   LIMIT 6;
   ```

   確定の回で付いたバッジの期間（#1528）は、次で数えられます（条件を満たした人がいなければ 0 行です）。

   ```sql
   SELECT period_type, period_start, count(*) AS awards
   FROM public.user_badge_period_awards
   GROUP BY period_type, period_start
   ORDER BY period_start DESC
   LIMIT 6;
   ```

### Vercel の `CRON_SECRET` を入れ替えるとき

Vercel Dashboard → Settings → Environment Variables で `CRON_SECRET` の値を変更し、再デプロイします。Vercel Cron は再デプロイ後の値を付けて呼ぶので、Supabase 側とは無関係に入れ替えられます。`/api/cron/process-menu-queue` を curl などで手動で呼ぶ運用がある場合だけ、旧い値を一時的に Vercel の `CRON_SECRET_PREVIOUS` に入れて同時に再デプロイし、呼び出し側を直してから外してください。旧い値で呼ばれると、Vercel の関数ログに `CRON_SECRET_PREVIOUS (旧いシークレット) で認証されました` と警告が出ます。Vercel に `CRON_SECRET_PREVIOUS` がある間は、自動の確認が 1 日 1 通「入れ替えが途中です」を送ります（現行と同じ値なら、その旨の題で）。外して再デプロイすると止まります。

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
| `EMAIL_FROM` | `ほめゴハン <noreply@mail.homegohan.com>` | メールの送信元。Resend で検証済みのドメインにする | `src/lib/site-config.ts` の `DEFAULT_EMAIL_FROM`（従来の送信元。そのドメインは DNS に無く検証できないので、本番ではメールが届かない） |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | `support@homegohan.com` | 問い合わせ先。メールの文面・お問い合わせ画面・プライバシーポリシー・招待画面に出る | `src/lib/site-config.ts` の `DEFAULT_SUPPORT_EMAIL`（従来のアドレス。同じドメインなので届かない） |

- `NEXT_PUBLIC_` で始まる値は**ビルド時に埋め込まれる**ので、Vercel で変えたら再デプロイしてください。
- 形が正しくない値（`https://` が無い URL、メールアドレスでない値）は無視して既定値に戻り、関数ログに警告が 1 回出ます。
- `NEXT_PUBLIC_INVITE_BASE_URL` は以前の招待リンク専用の設定です。設定してあると `NEXT_PUBLIC_APP_URL` より優先されるので、切り替えるときは**削除**してください。
- `SUPPORT_REPLY_TO`（任意）: サポートの返信メールの返信先。`support@` の受信箱ができたら設定します。
- メールは送信待ち（DB の `email_outbox`。#1193）を通ります。アプリの処理は送信待ちに登録するだけで、Vercel Cron が毎分 `GET /api/cron/email-outbox` を呼んで送ります（1 分ほどで届きます）。一時的な失敗は時間をおいて再試行し（1 分 → 5 分 → 15 分 → 1 時間 → 4 時間）、使い切ったものや直らない失敗（ドメイン未検証の 403 など）は「届けられなかった」として残ります。super_admin が `/super-admin/email-outbox` で見て、原因を直してから再送できます。
- `EMAIL_OUTBOX_MAX_ATTEMPTS`（任意）: 送信待ちの試行の上限（最初の 1 回を含む回数）。1〜20 の整数。未設定・不正な値なら既定の 6 回（不正な値は `cron/email-outbox` の warn ログに変数名だけを残す）。
- `EMAIL_OUTBOX_BATCH_SIZE`（任意）: 1 回の cron（毎分）で送る件数の上限。1〜100 の整数。未設定・不正な値なら既定の 20 件。
- サインアップの確認メール・パスワード再設定メールは Supabase が送ります。`EMAIL_FROM` は効かず、Supabase の Custom SMTP の設定が必要です（手順は上の文書）。
- メールが届かなくても、招待・お問い合わせ・サポート返信の処理は成功します（失敗は `app_logs` / 関数ログに残ります）。
- `https://homegohan-app.vercel.app` は、配布済みのアプリのビルドが WebView で開くため、古いビルドが使われなくなるまで止めない・リダイレクトしないでください。
- 送信用の DNS（Resend の DKIM・Return-Path・DMARC）が見えているかは、`node scripts/check-email-dns.mjs` で確かめられます（DNS を引くだけで、何も書き換えません）。

### 届かない宛先・苦情の宛先へ送らない（`RESEND_WEBHOOK_SECRET`。#1184）

Resend から「届かなかった（ハードバウンス）」「迷惑メールと報告された（苦情）」の知らせを Webhook で受け、その宛先を宛先停止リスト（DB の `email_blacklist`）に入れます。アプリのメール（招待・譲渡・退会の知らせ・サポート返信・運用メールなど。`src/lib/emails/send.ts` の `sendEmail` を通るもの）は、送る前にこのリストを引き、載っている宛先へは送りません（`app_logs` の `function_name = 'email'` に「宛先停止リストに載っている宛先のため、メールを送信しませんでした」の warn が残ります。宛先はマスクされます）。送信待ちに登録したあとで停止リストに載った宛先（登録時にリストを引けずに、確かめないまま登録した行も）は、worker（`GET /api/cron/email-outbox`）が送る直前に引いて止め、その行を届けられなかった（dead）にします。このときは warn ではなく、`function_name = 'cron/email-outbox'` に「メールを届けられませんでした (dead)」の error が残ります（エラー急増の通知の数に入ります。届けられなかったメールの通知の数には入りません）。

| 環境変数 | 値の例 | 用途 | 未設定のとき |
|---|---|---|---|
| `RESEND_WEBHOOK_SECRET` | `whsec_...`（Resend の管理画面に出る値） | `POST /api/webhooks/resend` が、届いたイベントの署名（`svix-id` / `svix-timestamp` / `svix-signature`）をこの値で確かめる | Webhook を 503 で断る（受け付けない）。宛先停止リストに入らず、届かない宛先へも送り続ける |

設定の手順（Resend の管理画面と Vercel。コードの変更は要りません）:

1. Resend の管理画面 → Webhooks → Add Webhook。宛先の URL は `https://<サイトのドメイン>/api/webhooks/resend`、イベントは `email.bounced` と `email.complained` を選ぶ（ほかのイベントを選んでも、何もせずに 200 を返すだけです）。
2. 登録した Webhook の署名の秘密（`whsec_` で始まる値）を、Vercel の環境変数 `RESEND_WEBHOOK_SECRET`（Production）に入れて再デプロイする。値はコマンドの履歴やチャットに残さないこと。
3. Resend の管理画面のその Webhook の配信の記録で、送られたイベントが 200 になっていることを確かめる。401 なら値が違う、503 なら環境変数が入っていない（または再デプロイ前）です。

振り分け:

- `email.bounced` のうち、`bounce.type` が `Permanent`（宛先が存在しない・受け取りを拒否された）だけを入れます（理由 `bounce`）。`Temporary` などの一時的な不達（受信箱がいっぱいなど）は入れません。
- `email.complained` は入れます（理由 `complaint`）。
- 同じ知らせが何度届いても、行は 1 つのままです（最初に入った理由と時刻が残ります）。運営が手で入れた行（理由 `manual`）も上書きしません。
- リストから外すときは、SQL Editor で `DELETE FROM public.email_blacklist WHERE email = '<小文字のアドレス>';` を実行します（宛先は小文字で入っています）。
- 宛先停止リストを引けなかったとき（DB の不調・3 秒を超えたとき）は、確かめずに送ります（warn ログが残ります）。メールを全部止めてしまわないためです。
- サインアップの確認メール・パスワード再設定メールは Supabase が送るので、このリストでは止まりません（Supabase の Custom SMTP に Resend を使っていれば、Resend 自身の停止リストが効きます）。
- 退会・除名・譲渡の通知などを送った側が「送れなかった」と残すログも、理由が停止リストだけなら warn です（止めた宛先へ送らないのは意図した動きなので、エラー急増の通知の数には入りません。ほかの理由の失敗は error のまま。#1577）。
- メンテナンス中（`maintenance_mode` が ON）も、この Webhook は止めません（#1577）。cron と同じ機械からの呼び出しで、止めると長いメンテナンスのあいだに知らせを失うか、Resend が宛先を無効にする恐れがあるためです。ほかの Webhook（Stripe）はメンテナンス中は 503 を返し、Stripe が送り直します。

---

## 🚨 エラー急増の運用メール（`OPS_ALERT_EMAIL`）

アプリのエラーログ（`app_logs` の `level = 'error'`）が急に増えたときに、運用の担当者へ 1 通だけメールで知らせます（#1157）。Vercel Cron が 15 分おきに `GET /api/cron/app-log-alerts` を呼び、直近 15 分の件数を数えます。同じ宛先に、DB バックアップが 30 時間より新しく取れていないことの通知も届きます (`GET /api/cron/backup-freshness`。日 1 回、14:37 JST。#1129)

数えるものは 2 種類あり、別々に知らせます（#1493）。サーバーが書いた `error`（`source` が `client` 以外）と、ブラウザ・端末から `POST /api/log` で届いた `error`（`source = 'client'`）です。`/api/log` はログインしていれば誰でも書けるので、まとめて数えると、利用者が `error` を書くだけでサーバーの障害の通知を鳴らしたり、その 60 分の抑止で本物の障害の通知を止めたりできてしまうためです。2 種類の通知は抑止も別々です。

| 環境変数 | 例 | 役割 | 未設定のときの動き |
|---|---|---|---|
| `OPS_ALERT_EMAIL` | `ops@example.com` | 通知メールの宛先。**メールアドレスを 1 つだけ**書く（`名前 <アドレス>` の形や、カンマ区切りの複数は不可）。共有の受信箱ができるまでは、個人のアドレスでよい | 通知しない。cron は動くが、`app_logs` に info ログを 1 行残すだけで、DB にもメールにも触れない |
| `OPS_ALERT_ERROR_THRESHOLD`（任意） | `50` | サーバーの `error` のしきい値。直近 15 分のサーバーの `error` が**この件数を超えたら**通知する。1〜100000 の整数 | 既定の 20 件。整数でない・範囲外の値も既定値に戻し、`cron/app-log-alerts` の warn ログに変数名だけを残す |
| `OPS_ALERT_CLIENT_ERROR_THRESHOLD`（任意） | `300` | ブラウザ・端末から届いた `error` のしきい値（#1493）。直近 15 分のその `error` が**この件数を超えたら**、サーバーとは別の通知を送る。1〜100000 の整数 | 既定の 100 件。不正な値は既定値に戻す（サーバーのしきい値と同じ） |
| `OPS_ALERT_COOLDOWN_MINUTES`（任意） | `120` | 同じ通知を送り直さない時間（分）。1〜10080 の整数 | 既定の 60 分。不正な値は既定値に戻す（しきい値と同じ） |
| `OPS_ALERT_PG_CRON_STALL_MINUTES`（任意） | `120` | pg_cron の停止のしきい値（#1125 の B）。有効なジョブがあるのに、最新の実行から**この分数を超えて**1 つも動いていなければ通知する。10〜1440 の整数 | 既定の 60 分。不正な値は既定値に戻す（しきい値と同じ） |
| `OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES`（任意） | `2880` | cron の共有シークレットの入れ替えの途中・旧い値の残り（WARN。#1560）の通知を、送ったあと送り直さない時間（分）。1440〜10080 の整数で、1 日 1 通までより短くはできない。ずれ（FAIL）の通知は `OPS_ALERT_COOLDOWN_MINUTES` | 既定の 1440 分（24 時間）。不正な値は既定値に戻す（しきい値と同じ） |

- 通知する条件: 直近 15 分のサーバーの `error` が **20 件を超えた**とき（21 件から）。ブラウザ・端末から届いた `error` は **100 件を超えた**とき（101 件から）に別の通知を送る。既定値は `src/lib/ops-alerts/app-log-error-spike.ts` の定数で、`OPS_ALERT_ERROR_THRESHOLD` / `OPS_ALERT_CLIENT_ERROR_THRESHOLD` で上書きできる。窓（15 分）は `vercel.json` の cron の間隔と同じにしてあるので、環境変数では変えない。
- 同じ通知は **60 分は送り直さない**（`OPS_ALERT_COOLDOWN_MINUTES` で上書きできる。分数は 2 種類で同じだが、抑止は種類ごとに別々）（DB の `ops_alert_state` で覚える。キーはサーバーが `app_logs_error_spike`、ブラウザ・端末が `app_logs_client_error_spike`。メールを送れなかったときは「送った」と記録せず、15 分後の次の回でもう一度試す）。
- **届けられなかったメール**（送信待ち `email_outbox` の dead。#1193）も、同じ cron・同じ宛先・同じ抑止の分数で知らせます（3 つ目の通知。キーは `email_dead_letter`）。1 件からで、まだ知らせていない dead を数え、知らせた行には印を付けます（同じメールを 2 回は数えません。抑止の間に届けられなかったものは、抑止が明けた最初の回で知らせます）。宛先停止リスト・退会で送らなかったものと、運用メール自身は数えません。メールに載るのは、文面の名前（template）ごとの件数と、送信待ちの画面（`/super-admin/email-outbox`）へのリンクだけです。
- **定期処理の失敗**（4 つ目の通知。キーは `cron_failure`。#1125 の B）も、同じ cron・同じ宛先・同じ抑止の分数で知らせます。対象は、pg_cron のジョブの失敗した実行（`cron.job_run_details` の `status = 'failed'`）と、Vercel Cron の route が 500 を返した回（`app_logs` の固定文の error）です。1 件から、直近 7 日のうちまだ知らせていないものを数え、知らせた失敗は台帳 `cron_failure_alerts` に記録します（同じ失敗を 2 回は数えません。抑止の間に起きたものは、抑止が明けた最初の回で知らせます）。ブラウザ・端末が書いた行（`source = 'client'`）は数えません。メールに載るのは、`pg_cron/<ジョブ名>`・`vercel_cron/<route 名>` ごとの件数と運用ログ画面へのリンクだけです。
- **pg_cron の停止**（5 つ目の通知。キーは `pg_cron_stalled`。#1125 の B）も同じ宛先に知らせます。有効なジョブがあるのに、最新の実行から `OPS_ALERT_PG_CRON_STALL_MINUTES`（既定 60 分）を超えて 1 つも動いていないときです。止まったままなら、抑止（既定 60 分）ごとに 1 通届きます。
- **cron の共有シークレットのずれ**（6 つ目の通知。キーは `cron_secret_drift`。#1560）も同じ宛先に知らせます。Edge Function secrets の `CRON_SECRET` と Vault の `app_cron_secret` の食い違いなど、pg_cron からの Edge Function の呼び出しが止まる状態です（pg_net は非同期なので `cron.job_run_details` には出ません）。続く間は、抑止（既定 60 分）ごとに 1 通届きます。
- **入れ替えの途中・旧い値の残り**（7 つ目の通知。キーは `cron_secret_rotation`。#1560）は、いまは通るが片づけるべき状態（`CRON_SECRET_PREVIOUS` の残りなど）を知らせます。抑止は `OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES`（既定 24 時間）で、1 日 1 通までです。読み方は上の「自動の確認」。
- メールに載るのは、件数・関数名・運用ログ画面（`/super-admin/logs`）へのリンクだけです。ユーザー ID・メールアドレス・ログの本文は載せません（送信先の Resend は米国の事業者のため）。
- **メールが実際に届くには、メールの送信元ドメインを Resend で検証し、`RESEND_API_KEY` と `EMAIL_FROM` を設定する必要があります**（手順は [`docs/operations/email-domain.md`](docs/operations/email-domain.md)）。それまでは、送れなかったことが `app_logs`（`function_name = 'cron/email-outbox'` の error（届けられなかった行は `/super-admin/email-outbox` にも残る）と、`cron/app-log-alerts` の warn）に残るだけで、アプリの動きには影響しません。
- ブラウザ・端末から届いたログ（`POST /api/log`）は、利用者ごとに 1 分 30 回・直近 24 時間で 1000 回までしか受け付けません（超えると 429。#1493）。
- 応答（JSON）の `status`（サーバーの判定。ブラウザ・端末の判定は `client.status`、共有シークレットのずれは `cron_secret_drift.status`、入れ替えの途中は `cron_secret_rotation.status`）は、`disabled`（宛先が未設定）・`invalid_config`（宛先の形が不正）・`below_threshold`（しきい値以下）・`deduped`（60 分以内に送信済み）・`sent`（送信した）・`send_skipped` / `send_failed`（送れなかった）のどれかです。cron が動いているかは、Vercel の Cron Jobs の画面（HTTP ステータス）で確かめられます。`app_logs`（`/super-admin/logs` で `function_name` に `cron/app-log-alerts` を指定）に残るのは、宛先が未設定・形が不正・通知した・通知できなかった回と、しきい値・クールダウンの環境変数の値が不正だった回 (warn。変数名だけ) です（しきい値以下の回と、60 分以内の回は何も残しません）。
- 認証は他の cron と同じ `CRON_SECRET`（上の「Cron の共有シークレットの保管場所とローテーション」）。手で呼ぶ場合は `Authorization: Bearer <CRON_SECRET>` を付けます（値はコマンドの履歴やチャットに残さないこと）。しきい値を超えているときに手で呼ぶと、本物の通知メールが 1 通出て、60 分の抑止が始まります。

---

## 🔔 Push 通知の送信（`EXPO_ACCESS_TOKEN`）

アプリの端末に、サーバーから Push 通知を送ります（#1136。設計は [`docs/design/mobile/06-push-send.md`](docs/design/mobile/06-push-send.md)）。いま送るのは、2 日以上の範囲の献立の生成が終わったとき（できた / 作れなかった）の 2 種類です。生成の結果を DB のトリガーが送信待ちの表 `push_outbox` に積み、Vercel Cron が毎分 `GET /api/cron/push-outbox` を呼んで Expo Push Service に送ります。

| 環境変数 | 例 | 役割 | 未設定のときの動き |
|---|---|---|---|
| `EXPO_ACCESS_TOKEN` | （Expo の画面で作った値） | Expo Push Service のアクセストークン（サーバー専用・秘密）。Expo に送る要求に `Authorization: Bearer` で付ける | Push 通知を送らない。cron は warn ログを 1 行残し、掃除だけをする（24 時間を超えた送信待ちの行を `expired` にし、送信済みは 7 日・届けられなかった行は 30 日で消す） |
| `PUSH_OUTBOX_MAX_ATTEMPTS`（任意） | `5` | 試行の上限。これだけ失敗したら届けられなかった（`dead`）にする。1〜10 の整数 | 既定の 3 回（1 分・5 分・15 分の間隔で再試行）。整数でない・範囲外の値も既定値に戻し、`cron/push-outbox` の warn ログに変数名だけを残す |
| `PUSH_OUTBOX_BATCH_SIZE`（任意） | `200` | 1 回の cron（毎分）で取り出して送る件数の上限。1〜500 の整数 | 既定の 100 件。不正な値は既定値に戻す（試行の上限と同じ） |

**アクセストークンの作り方と、Enhanced push security を ON にする手順（オーナー作業）**

1. [expo.dev](https://expo.dev) にログインし、アプリの Expo プロジェクトの設定で **Enhanced push security** を ON にする。ON にすると、アクセストークンを付けない送信の要求を Expo が `UNAUTHORIZED` で断る（push token を知っている第三者が通知を送れなくなる）。
2. `expo.dev/settings/access-tokens` でアクセストークンを作る。
3. Vercel の Project Settings > Environment Variables に `EXPO_ACCESS_TOKEN` として入れる（production / preview）。値はチャットやコマンドの履歴に残さない。ローカルで試すときは `.env.local` に入れる。

- 送る直前に、凍結中・現行の規約に未同意（`LEGAL_CONSENT_ENFORCE` が on のとき）・通知を切った（`notification_preferences.notifications_enabled = false`）利用者には送らない（その行は `dead`）。メンテナンス中は何もしない。
- `app_logs`（`/super-admin/logs` で `function_name` に `cron/push-outbox` を指定）に、処理した回の件数と、届けられなかった行の理由（種類・利用者 ID・token の末尾 4 文字）が残る。通知の文面と token の全体は残さない。
- Android の端末へ届くには、EAS に FCM V1 の資格情報を登録する必要がある（未登録の間は Android だけ `InvalidCredentials` で届かず、iOS には届く）。
- 認証は他の cron と同じ `CRON_SECRET`。

---

## 📱 モバイル（Expo）での環境変数

Expoでは `EXPO_PUBLIC_` で始まる変数がクライアントに埋め込まれます（=秘密情報は入れない）。

### 必須（モバイル）
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_API_BASE_URL` - Next.js API（BFF）の基点（例: いまアプリが動いている `https://homegohan-app.vercel.app`。`homegohan.com` は、サイトを移すまで別のサービスを指しているので使わない）。献立・買い物リスト・AI などの画面が呼ぶ（#1434 で必須に分類した。無いと、その画面が `[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL` の例外で落ちていた）

この 3 つはビルドのときに埋め込まれます（EAS Build なら、EAS の環境変数に登録しておく）。一覧は `apps/mobile/src/lib/env.ts` の `REQUIRED_MOBILE_ENV_NAMES` です。入っていないビルドは、次のように動きます（#1182。以前は `https://placeholder.supabase.co` という存在しない接続先でクライアントを作り、ログインなどが原因の分かりにくいエラーで失敗し続けていました）。空・空白だけの値も、未設定として扱います。

- 開発中（`npx expo start`・development ビルド）: Supabase の 2 つが無ければ、アプリの起動時に、足りない変数名を書いたエラー（`[mobile] Missing env: EXPO_PUBLIC_SUPABASE_URL, …`）で止まります。`EXPO_PUBLIC_API_BASE_URL` だけが無ければ、「アプリの設定が不足しています」の画面に足りない変数名を出します。
- リリースビルド（preview・production）: クラッシュはさせず、「アプリの設定が不足しています」の画面を出し、足りない変数名を端末のログ（`console.error`）に残します。画面には変数名を出しません（開発ビルドでは画面にも出します）。このビルドは配布せず、環境変数を直して作り直してください。

### オプション（モバイル）
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

### 任意の環境変数: ログイン・登録・パスワード再設定の bot 対策（Cloudflare Turnstile、#1165）

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` - Cloudflare Turnstile のサイトキー（Web。Vercel の環境変数）
- `EXPO_PUBLIC_TURNSTILE_SITE_KEY` - 同じサイトキー（モバイル。EAS の環境変数）
- `TURNSTILE_SECRET_KEY` - Turnstile の秘密キー（Web のサーバー専用。Vercel の環境変数。`NEXT_PUBLIC_` を付けない）。任意

どちらもサイトキーは公開してよい値です。秘密キーは公開しません。秘密キーは、**Vercel の `TURNSTILE_SECRET_KEY` か Supabase のダッシュボードの、どちらか一方だけ**に入れます（トークンは 1 回しか使えないため、両方で確かめると 2 回目が断られます）。

- `TURNSTILE_SECRET_KEY` を入れると、Web のログインで続けて 3 回以上失敗したメールアドレスの次のログインから、このアプリのサーバー（`POST /api/auth/login`）がトークンを確かめます。**未設定（またはサイトキーが未設定）なら確かめずに通し**、サーバーの起動後に最初にログインを処理したとき、その旨のログが 1 回だけ出ます。
- ログインに続けて失敗しても、アカウントはロックしません（キーの有無に関係なく）。続けて 3 回以上失敗したメールアドレスで、ボットの確認を求めるだけです（[docs/operations/auth-protection.md](docs/operations/auth-protection.md) §1・§2.1）。
- `AUTH_LOGIN_FAILURE_RESET_MINUTES`（任意・サーバー専用）- 連続失敗の回数を 0 に戻すまでの、最後の失敗からの時間（分）。1〜10080 の整数。未設定なら 1440 分（24 時間）。不正な値は既定値に戻し、`auth/login-failures` の warn ログに変数名だけを残します。ログインに成功しても 0 に戻ります。

- **未設定なら Turnstile は出ず、今までどおりに動きます**（ローカル開発・テストは未設定でよい）。
- 設定すると、ログイン・新規登録・パスワード再設定の画面にウィジェットが出て、確認が終わるまで送信ボタンが押せなくなります。
- ビルド時に埋め込まれるので、変えたら再デプロイ（モバイルは新しいビルド）が要ります。
- Web に入れただけでは、Supabase の Auth API を直接呼ぶ攻撃は止まりません。Supabase 側で CAPTCHA を有効にする時期と手順、現在の設定値の記録は [docs/operations/auth-protection.md](docs/operations/auth-protection.md) を参照してください（有効にするのは、モバイルの新しいビルドを配って古いビルドが使われなくなってから）。

### 任意の環境変数: 新しい端末からのログインの通知（`AUTH_LOGIN_ALERT`、#1190）

- `AUTH_LOGIN_ALERT`（任意・サーバー専用。Vercel の環境変数）- 新しい端末・地域からのログインを、本人の登録メールアドレスに知らせるか。`on` / `off`。未設定なら `on`。`on` / `off` 以外の値も `on` に戻し、warn ログに変数名だけを残します。
- `off` にすると、毎分の cron（`GET /api/cron/login-alerts`）は判定して印（新しい端末・地域）を付けますが、メールを送りません。障害や移行の間に止める用です。止めていた間に判定したログインのメールは、`on` に戻しても送りません。
- メールが実際に届くには、送信元ドメインの検証が要ります（`RESEND_API_KEY` / `EMAIL_FROM`。[docs/operations/email-domain.md](docs/operations/email-domain.md)）。

### 任意の環境変数: Edge Function の CORS（`ALLOWED_ORIGINS`）

これは Vercel の環境変数ではなく、**Supabase の Edge Function の Secret** です（Supabase Dashboard → Edge Functions → Secrets、または `supabase secrets set ALLOWED_ORIGINS=...`）。

- 用途: ブラウザから Edge Function を直接呼ぶときに、呼び出し元として認めるサイトのオリジン（カンマ区切り。`https://` から書き、末尾に `/` を付けない）。
- 未設定なら、いまアプリが動いている `https://homegohan-app.vercel.app` だけを認めます。設定すると、これの代わりに、設定した値だけを認めます（サイトを `homegohan.com` に移したら、そのオリジンを足してください。手順は [`docs/operations/email-domain.md`](docs/operations/email-domain.md)）。`*` と `null` は書いても無視されます。
- 普段は設定不要です。このアプリのブラウザやモバイルアプリが Edge Function を直接呼ぶ処理は無く、Next.js の API ルートがサーバーから呼んでいます（サーバーからの呼び出しは CORS の対象外です）。自社の別ドメインのページから直接呼ぶ処理を足すときだけ設定してください。
- バッチ専用の関数（`aggregate-org-stats` など）には、この設定に関係なく CORS を付けません。

### 任意の環境変数: 規約への再同意の強制（`LEGAL_CONSENT_ENFORCE`）

利用規約・プライバシーポリシーへの同意を、画面を開くたびに確かめる仕組み（#1174）のスイッチです。Vercel の環境変数に設定します。

- 確かめるもの: 利用者ごとに記録された「同意済みの版」（`user_profiles.terms_version_accepted` / `privacy_version_accepted`）が、`packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS`（いま有効な版）と同じか。同意の証跡（いつ・どの版に・どの IP と端末から）は `terms_acceptances` に残ります。
- 未設定、または `on` 以外（既定）: 既存の利用者は止めません（ただし、初めてサインインした新規の人（初期設定を始めておらず、いまの版に未同意）は、このフラグに関わらず `/auth/callback` が同意画面へ回します。#1435）。同意が済んでいない人の画面の上にお知らせを出すかどうかは、次の `LEGAL_CONSENT_NOTICE` で決まります（既定は出しません）。
- `on`: 同意が済むまで、画面を開くと同意画面（`/legal-consent`）へ回します。同意すると元の画面に戻ります。`/api/*` は 403（`{ error, code: 'LEGAL_CONSENT_REQUIRED' }`）で止めます（同意そのもの・認証・退会と書き出し・問い合わせ・ログなどの許可リストを除く。一覧は `packages/shared/src/legal-consent-api.ts` の `LEGAL_CONSENT_EXEMPT_API_PATHS`。#1442）。画面で次は回しません: 利用規約（`/terms`）、プライバシーポリシー（`/privacy`）、特定商取引法の表記（`/legal`）、問い合わせ（`/contact`）、凍結の案内（`/frozen`）、認証の途中の画面（`/auth/*`。アプリの認証ブリッジを含む）、ハンズオンツアー（`/handson-tour`）。
- 同意しない人は、同意画面の「同意しない」でログアウトでき、データの削除は問い合わせフォームから依頼する案内が出ます。
- 強制を始める前に決めること（オーナー）: ①版番号と施行日と同意文言（弁護士の確認。いまの値は仮置き）②強制を始める日。③始める前に、お知らせだけの期間（`LEGAL_CONSENT_NOTICE=on`）を置くかどうか。
- 本番は 2026-10-10 に `on` にしました（オーナー判断。版と施行日は仮置きのまま、お知らせだけの期間は置いていません）。`/api/*` は middleware の `/api` の分岐で止めます（403 `LEGAL_CONSENT_REQUIRED`。許可リストは `packages/shared/src/legal-consent-api.ts`。#1442・設計書 `docs/design/cross/13a-legal-consent-api-server.md`）。アプリも起動時と `/api` の 403 で同意画面（Web と同じ画面）を出します（#1442・設計書 13b）。
- 改定のたびにやること: `LEGAL_DOCUMENTS` の `version` と `effectiveDate` を書き換えて出す。版が変わると、同意済みの人も含めて、全員に再同意を求めます（版を変えずに文面だけ直すと、再同意は求めません）。
- 戻し方: 環境変数を消す（または `off` にする）と、再デプロイ後に既存の利用者を同意画面へ回さなくなります。初めてサインインした新規の人は、`/auth/callback` が引き続き同意画面へ回します（#1435）。記録済みの同意は残ります。

### 任意の環境変数: 規約への同意のお知らせ（`LEGAL_CONSENT_NOTICE`）

同意が済んでいない人に、画面の上で「同意のお願い」を出すかどうかのスイッチです（#1174）。Vercel の環境変数に設定します。値の読み方は `LEGAL_CONSENT_ENFORCE` と同じです（`on` のときだけ有効。大文字小文字と前後の空白は区別しません）。

- 未設定、または `on` 以外（既定）: 出しません。未同意の人にも何も表示せず、誰も止めません。この間、同意の記録が残るのは、同意画面（`/legal-consent`）を開いて同意した人と、初めてサインインしたときに `/auth/callback` から同意画面へ回された新規の人です（#1435）。
- `on`: 強制（`LEGAL_CONSENT_ENFORCE=on`）していない間、同意が済んでいない人の `(main)` の画面の上に、同意画面へのリンクつきのお知らせを出します。使うのは止めません。お知らせは規約・プライバシーポリシー・同意画面・ログインや新規登録の画面などには出ません。
- `LEGAL_CONSENT_ENFORCE=on` のときは、この設定によらず同意画面へ回します（お知らせは出しません）。
- サーバー側（middleware）だけで読みます。`NEXT_PUBLIC_` は付けません。
- 戻し方: 環境変数を消す（または `off` にする）と、再デプロイ後にお知らせを出さなくなります。

### 任意の環境変数: CSP を「報告だけ」にする（`CSP_REPORT_ONLY`）

本番の Content-Security-Policy（CSP）は、`src/proxy.ts` が毎リクエスト作る nonce で Next のスクリプトだけを許し、`script-src` に `'unsafe-inline'` を持ちません（#1169。方針の正本は `src/lib/security/csp.ts`）。このスイッチは、ローンチ後に、ある画面でスクリプトが止まる報告（`app_logs` の `function_name = csp-report`。運営は `/super-admin/logs` で絞る）が集まったときの戻し方です。Vercel の環境変数に設定します。値の読み方は `LEGAL_CONSENT_ENFORCE` と同じです（`on` のときだけ有効。大文字小文字と前後の空白は区別しません）。

- 未設定、または `on` 以外（既定）: 強制します（`Content-Security-Policy`）。nonce の無いインラインスクリプトは止まり、違反の報告も `/api/csp-report` に届きます。
- `on`: `Content-Security-Policy-Report-Only` で返し、違反を止めず報告だけ届かせます。
- 強制へ戻す条件: 直近 7 日の `csp-report` の行のうち、`blocked_uri` が `inline` / `eval` / 自オリジンのものが 0 件になったら外します（他オリジンの報告は利用者のブラウザ拡張などなので数えません）。
- サーバー側（middleware）だけで読みます。`NEXT_PUBLIC_` は付けません。Vercel で変えた場合は、再デプロイ後に効きます。
- CI の e2e（`.github/workflows/e2e-local.yml`・`scripts/local-ci.sh`）では設定しません（`tests/e2e/csp-nonce.spec.ts` は強制を期待します）。

### 任意の環境変数: 機能フラグの対象ユーザー数の上限（`FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT`）

運営の機能フラグ画面（`/super-admin/flags`）の「対象ユーザー数」は、段階公開や条件つきのフラグについて、ユーザーを 1 人ずつ判定して数えます（#1148）。ユーザーがこの数を超えると数えず、画面では「—」になります。全員が対象で条件の無いフラグは件数だけを数えるので、この上限によらず出ます。

- 未設定、または正の整数でない（既定）: 20000。
- 正の整数: その人数まで数えます。大きくすると、運営画面の一覧を開くたびに読むユーザーの行が増え、表示が遅くなります。
- サーバー側（`src/lib/super-admin/flag-active-users.ts`）だけで読みます。`NEXT_PUBLIC_` は付けません。

### 任意の環境変数: 機能フラグの行をメモリに覚える時間（`FEATURE_FLAG_CACHE_TTL_MS`）

機能フラグ（`feature_flags`）の行を、サーバー（API route とミドルウェア）がメモリに覚える時間（ミリ秒）です。運営画面（`/super-admin/flags`）で切り替えてから全員に反映されるまでの、最大の遅れになります（#1148・#1496）。

- 未設定、または 10 進の数字だけで書いた正の整数でない（既定）: 30000（30 秒）。空・`0`・負の数・小数（`2000.0`）・指数（`1e3`）・16 進（`0x7D0`）・符号つき（`+2000`）も既定になります（#1535）。
- 10 進の数字だけで書いた正の整数（前後の空白を除いて、先頭が 1〜9 の数字だけ）: その時間だけ覚えます。短くすると、DB を読む回数が増えます。
- **本番（Vercel）では設定しません**（既定のまま）。設定するのは、結合テストの段（`.github/workflows/security-regression.yml` と `scripts/local-ci.sh` の integration）が起動する next dev と、そのサーバーに対して反映を待つ `tests/integration/security/feature-flags-runtime.test.ts` だけです（両方に同じ値を渡します。テストは反映を待つ上限をこの値から決めます）。
- サーバー側（`src/lib/feature-flag-cache-ttl.ts`）だけで読みます。`NEXT_PUBLIC_` は付けません。

### 任意の環境変数: 献立の単発追加の開始日のずらしの上限（`MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS`）

献立の単発追加（`POST /api/menu-plans/add`）は、本文の `date_offset_days` の日数だけ JST の今日からずらした日を開始日にします。この値の絶対値の上限です（#1463）。上限を超える値（と、開始日が暦の計算で扱える範囲の外に出る値）は 400 になります。利用者が値を選ぶ画面は無く、ハンズオンツアーの見本の献立が 1（明日）を送るだけです。

- 未設定、または正の整数でない（既定）: 366（前後 1 年）。
- 正の整数: その日数まで受け付けます。
- サーバー側（`src/lib/menu-plan-date-offset.ts`）だけで読みます。`NEXT_PUBLIC_` は付けません。

### 任意の環境変数: 献立生成の究極モードの 1 日の上限（`AI_ULTIMATE_MODE_DAILY_LIMIT`）

献立生成の究極モードは、1 日の AI の上限（DB の `ai_daily_limits`）とは別に、利用者ごと・1 日（JST の暦日）にこの回数まで使えます（#1142）。1 回の究極モードは、1 日の AI の上限の合計にも 1 回入ります。

- 未設定、または 0 以上の整数でない（既定）: 1（`AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT`）。
- 0 以上の整数: その回数まで使えます（0 はその日は 1 回も使えません）。超えると 429 `AI_DAILY_LIMIT` になります。
- Vercel と Edge Functions（Supabase の secrets）の**両方に同じ値**を入れます。片方だけだと、入口によって上限が変わります。
- Web ではサーバー側（`src/lib/plan/entitlements.ts`）だけで読みます。`NEXT_PUBLIC_` は付けません。

### 任意の環境変数: 組織チャレンジの順位表に参加者の表示名を出すか（`ORG_CHALLENGE_SHOW_NAMES`）

組織チャレンジの順位表（`GET /api/org/challenges/[id]`。参加者本人にだけ返す）に、ほかの参加者の表示名（ニックネーム）を出すかどうかです（#1132）。参加者どうしに表示名を見せてよいかは社内の方針の確認待ちなので、決まるまでは未設定のままにします。

- 未設定、または下の値以外（既定）: 出しません。本人の行は「あなた」、ほかの人は「参加者」と表示し、DB からも表示名を取りません。
- `1` / `true` / `on` / `yes`（大文字小文字・前後の空白は無視）: 出します。
- サーバー側（`src/lib/org-challenges.ts` の `showParticipantNames`）だけで読みます。`NEXT_PUBLIC_` は付けません。Vercel で変えた場合は、再デプロイ後に効きます。

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
# 必須: Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# 任意 (cron を動かすとき): Cron Secret (Vercel Cron 認証用)
CRON_SECRET=your_cron_secret_here

# 任意 (Gemini を使う機能): Google AI (Gemini)
GOOGLE_AI_STUDIO_API_KEY=your_google_ai_api_key
# または
GOOGLE_GEN_AI_API_KEY=your_google_ai_api_key

# 任意 (栄養フィードバック): OpenAI
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

### DB バックアップ（`.github/workflows/db-backup.yml`。#1129 / #1191）

毎日の DB の論理バックアップ（本番を暗号化して Cloudflare R2 に置く）には、次の secrets と variables が要ります。**どれも無いうちは、取得は `not_configured` で止まり（DB の中身を取り出す前に止まります）、Issue「【自動】DB バックアップの失敗」が立ちます。** 登録の順番（R2 のバケット・API トークン・age の鍵対 → 登録 → 最初の実行）と値の作り方は `docs/operations/backup-restore.md` の 2 章です。値はここにも Issue にも書きません。

| 種類 | 名前 | 中身 |
|---|---|---|
| secret | `BACKUP_R2_ACCESS_KEY_ID` | R2 の API トークン「Object Read & Write」（このバケットだけに絞る）の Access Key ID |
| secret | `BACKUP_R2_SECRET_ACCESS_KEY` | 同じトークンの Secret Access Key |
| variable | `BACKUP_R2_ACCOUNT_ID` | Cloudflare のアカウント ID（公開してよい） |
| variable | `BACKUP_R2_BUCKET` | R2 のバケット名（既定の名前は `homegohan-db-backups`） |
| variable | `BACKUP_AGE_RECIPIENT` | age の公開鍵（`age1…`）。秘密鍵は GitHub・Vercel・Supabase・リポジトリに置かない |

- 任意の調整用の variable が 4 つあります。DB が育って時間切れになったときだけ入れます（無ければ既定）。形が違う値は黙って既定に戻さず `not_configured` で止まります: `BACKUP_DUMP_TIMEOUT_MINUTES`・`BACKUP_UPLOAD_TIMEOUT_MINUTES`・`BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES`・`BACKUP_ZSTD_LEVEL`。
- 本番に繋ぐ `SUPABASE_ACCESS_TOKEN`・`SUPABASE_DB_PASSWORD`（上の migration auto-deploy と同じ secrets）はそのまま使います。
- GitHub が自動で入れるもの（`GITHUB_TOKEN`・`GITHUB_REPOSITORY`・`GITHUB_RUN_ID`・`GITHUB_RUN_ATTEMPT`・`GITHUB_SHA`・`RUNNER_TEMP`）は設定しません。
- **復元**（`node scripts/backup-db.mjs restore`）は、オーナーの手元のシェルに R2 の 4 つ（`BACKUP_R2_ACCOUNT_ID`・`BACKUP_R2_BUCKET`・`BACKUP_R2_ACCESS_KEY_ID`・`BACKUP_R2_SECRET_ACCESS_KEY`）を置いて流します。前の 2 つは上の variable と同じ値で、後ろの 2 つのキーは**復元用の読み取り専用（Object Read only）のトークン**のものです（取得用の Read & Write のキーは手元に写さない）。値は書かず、パスワードマネージャーから取ります（`docs/operations/backup-restore.md` の 5 章）。
- 新しい Supabase プロジェクトへ復元するときの接続先 `NEW_DB_URL` は、`docs/operations/backup-restore.md` の 6 章でオーナーの手元のシェルにだけ置く変数です。パスワードを含む秘密なので、GitHub・Vercel には置きません。

---

## 📚 参考リンク

- [Next.js Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables)
- [Vercel Environment Variables](https://vercel.com/docs/projects/environment-variables)
- [Supabase API Keys](https://supabase.com/docs/guides/api/api-keys)
- [Google AI Studio](https://aistudio.google.com/)



