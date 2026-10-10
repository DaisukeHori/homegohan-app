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
| **必須** | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | アプリが動きません。コードは、使う場面でエラー（`MissingEnvError`）を出し、500 になります。URL か anon キーが無いと、middleware がページと API（`/api/health` を除く）を汎用の 500 で止めます。`SUPABASE_SERVICE_ROLE_KEY` だけが無いと、それを使う API が 500 になります。応答（本文・ヘッダ・エラーページ）には変数名も値も出しません。本文は API によって、汎用の文（「処理中にエラーが発生しました」）・`MissingEnvError` の固定の文（変数名は入りません）・Next.js の既定のエラーのどれかです。どの変数が足りないかは、サーバーのログの `[env] missing required env: <変数名>` の行（どの経路でも出ます）と、`npm run check:env` で分かります。500 を `internalError()` で返す API と middleware では、構造化ログの `missing_env_name` にも残ります（console に出る構造化ログには必ず入ります。`app_logs` に書けるのは URL と `SUPABASE_SERVICE_ROLE_KEY` がそろっているとき、つまり anon キーだけが無いときです）。コマンドは終了コード 1 |
| **任意** | メール（`RESEND_API_KEY`）・レート制限（`UPSTASH_REDIS_REST_*`）・課金（`STRIPE_SECRET_KEY`）・AI（`GOOGLE_AI_STUDIO_API_KEY`・`XAI_API_KEY`・`OPENAI_API_KEY`）・`CRON_SECRET`・モバイル認証ブリッジのスイッチ（`NATIVE_BRIDGE_*`）・規約の再同意のスイッチ（`LEGAL_CONSENT_*`）など | アプリは動きますが、その機能が使えなくなったり弱くなったりします。コマンドは「未設定です。…が起きます」と表示するだけです |

- 任意の変数が足りないことで、本番を止めてはいけません。任意の変数を読む共通の関数（`getOptionalEnv()`。`src/lib/env.ts`）は、変数が無いときに例外を投げず、`undefined` を返して、プロセスごとに 1 回だけ警告をログに残します。メール送信・レート制限・Stripe・AI など、いまは各機能が `process.env` を直接読んでいる箇所が残っていて、ほかの作業と重ならないところから順にこの関数へ置き換えていきます。
- 下の「必須の環境変数」に載っている `CRON_SECRET` は、「cron（定期処理）を動かすには必要」という意味です。`check:env` では任意に分類しています（無くてもアプリ本体は動き、cron の API が 503 を返すだけのため）。
- `check:env` は **CI には組み込んでいません**（CI にはシークレットが無く、必須の変数がそろわないため）。デプロイ前や環境を作り直したときに、手元で実行してください。
- 新しい環境変数を足すときは、`src/lib/env.ts` の一覧に足し（必須にするのは、無いとアプリが動かないものだけ）、`.env.example` にも書いてください（`tests/env-source-scan.test.ts` が、Web のコードが読む変数が一覧に無いとき・一覧の変数が `.env.example` に無いときに失敗します）。コードで `process.env.X!` と書くのは禁止です。
- モバイルアプリ（`apps/mobile`）の変数は別です。下の「モバイル（Expo）での環境変数」を見てください。`EXPO_PUBLIC_SUPABASE_URL` と `EXPO_PUBLIC_SUPABASE_ANON_KEY` が無いビルドは、開発中は起動時にエラーを出し、リリースビルドでは「アプリの設定が不足しています」という画面を出します（接続先の無いままログイン画面を出し続けません）。

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
| Vercel の環境変数 | `CRON_SECRET` | 送る側も受ける側も Vercel の中で完結します。Vercel Cron が `/api/cron/process-menu-queue` と `/api/cron/app-log-alerts`（どちらも `vercel.json` の `crons`）を呼ぶとき、この値を自動で `Authorization: Bearer ...` に付けます。受ける側の Next.js（`src/lib/cron-auth.ts`）が、同じ環境変数と照らし合わせます | **不要**。他の 2 か所と別の値にしてかまいません（別の値にしておくと、片方が漏れてももう片方は守られます） |
| Supabase の Edge Function secrets | `CRON_SECRET`（別名 `SERVICE_ROLE_SECRET`。`CRON_SECRET` が無いときだけ代わりに使われます） | **受ける側**。`supabase/functions/_shared/auth.ts` の `requireServiceRole` が、次の Edge Function でこの値と照らし合わせます: コンビニカタログ取り込み 5 本（`import-seven-eleven-catalog` / `import-familymart-catalog` / `import-lawson-catalog` / `import-natural-lawson-catalog` / `import-ministop-catalog`）、`aggregate-org-stats`（停止中。認証だけ行い 410 を返します。#1325）、`calculate-segment-stats`、`regenerate-embeddings`、`stripe-price-sync`（最後の 2 本は service role key でも呼べます） | Vault の `app_cron_secret` と **同じ値にする** |
| Supabase Vault | `app_cron_secret` | **送る側**。pg_cron が定期実行する次の関数がこの値を読み、`Authorization: Bearer ...` に付けて Edge Function を呼びます: `public.invoke_catalog_import()`（コンビニカタログ取り込みの Edge Function 5 本。登録時のスケジュールは、毎日 UTC 3:00〜4:00 に 15 分おき）、`public.invoke_calculate_segment_stats()`（比較ランキングの集計 `calculate-segment-stats` を daily / weekly / monthly の 3 回。期間が切り替わった直後の回は直前の期間の分も。ジョブ `calculate-segment-stats`、1 時間ごと（毎時 5 分）。#1406） | Edge Function secrets の `CRON_SECRET` と **同じ値にする** |

つまり、**値を合わせないと動かないのは「Edge Function secrets の `CRON_SECRET`」と「Vault の `app_cron_secret`」の 2 つだけ**です。Vercel の `CRON_SECRET` は独立しています。

### 値が合っていないとどうなるか

- 値が違う → Edge Function は HTTP 401（本文 `{"error":"Unauthorized"}`）を返します。
- Edge Function 側に `CRON_SECRET`（と `SERVICE_ROLE_SECRET`）が無い → HTTP 503 を返します。
- pg_cron は pg_net で **非同期に** 呼び出すため、cron ジョブ自体は成功扱いのままです（`cron.job_run_details` は HTTP の結果にかかわらず `succeeded` になります）。エラーの表示もなく、カタログ取り込みだけが止まります。

値とは別に、**関数のゲートウェイの JWT 検証（`verify_jwt`）が有効なまま** だと、値が合っていても関数に届く前に止まります。`app_cron_secret`（`CRON_SECRET`）はランダムな文字列で JWT ではないため、Supabase のゲートウェイが HTTP 401（本文 `{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT", ...}`）を返します。pg_cron から呼ぶ関数は `supabase/config.toml` で `verify_jwt = false` にしてあり（認証は関数の中の `requireServiceRole` が行います。#1406）、GitHub Actions の「Deploy Supabase Functions」がこの設定ごとデプロイします。この 401 が出たら、設定がまだデプロイされていません。Actions の「Deploy Supabase Functions」が成功しているかを確かめ、必要なら手動で実行（Run workflow）し直してください。

直近の呼び出し結果は、Supabase Dashboard の SQL Editor で次のように確かめられます。古い結果は自動で消える（既定では約 6 時間）ので、実行の直後に見てください。

```sql
SELECT id, status_code, timed_out, error_msg, created
FROM net._http_response
ORDER BY created DESC
LIMIT 20;
```

- `status_code` が **401 / 503** の行がある → 値が合っていません。ただし 401 の本文が `UNAUTHORIZED_INVALID_JWT_FORMAT` なら、値ではなくゲートウェイの JWT 検証で止まっています（上を参照）。本文は `content::text` で見られます（下の「比較ランキングの集計が動いているかの確かめ方」のクエリ）。
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

旧い値の控えが無いときは、`CRON_SECRET_PREVIOUS` を使えません。コンビニカタログの取り込みが動かない時間帯（UTC 4:30〜翌 2:30）の、比較ランキングの集計の回（毎時 5 分）を避けた時刻（例: 毎時 10 分〜55 分）に、手順 2 では `CRON_SECRET` だけを新しい値にして、すぐ手順 3 を行ってください。その数分の間だけ、手動で呼ぶ処理が 401 になります。比較ランキングの集計の回と重なって 401 になっても、次の回（1 時間後）で取り戻せます（JST 0 時台の回だけは、直前の期間の集計し直しが行われないので、避けてください）。

### 比較ランキングの集計の間隔

比較ランキング（Web の `/comparison`・モバイルの比較画面）の集計 `calculate-segment-stats` は、pg_cron のジョブ `calculate-segment-stats` が **1 時間ごと（毎時 5 分）** に呼びます（migration `20261009100000_schedule_calculate_segment_stats.sql`。#1406）。

- 毎回、daily / weekly / monthly の 3 つの要求が pg_net から並行して出ます。どれも、自分の期間の食事の記録（monthly は 1 か月分）を全件読みます。
- 日・週・月が切り替わった直後の回（JST 0:05）は、切り替わった種類について直前の期間も 1 回だけ集計し直します（最大 3 つ増えます）。期間の最後の 1 時間（例: 23:05〜23:59）の記録を、その期間の最終の値に入れるためです。
- 応答を待つ上限は 400 秒です。間隔（1 時間）より十分短いので、前の回と重なりません。直近の結果は `net._http_response` で確かめられます（下の「比較ランキングの集計が動いているかの確かめ方」）。

利用者が増えて毎時の集計が重くなったら、Supabase Dashboard の SQL Editor で間隔を広げられます（migration は要りません）。例: 3 時間ごと

```sql
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'calculate-segment-stats'),
  schedule := '5 */3 * * *'
);
```

- **UTC 15 時台（= JST 0 時台）の回を必ず含めてください。** 直前の期間の集計し直しは、期間が切り替わってから 1 時間以内（`calculate_segment_stats_request_bodies` の `c_finalize_window`）の回だけが行います。`'5 */3 * * *'` は UTC 0, 3, …, 15, 18, 21 時なので含みます。`'5 */2 * * *'` は含まないので使えません。
- 間隔を変えたら、モバイルの比較画面の案内（`apps/mobile/app/comparison/index.tsx` の `RANKING_UPDATE_INTERVAL_HOURS`）も同じ時間に直し、次の migration でジョブのスケジュールも揃えてください（`tests/segment-stats-schedule-sync.test.ts` が migration と画面を突き合わせます）。
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

   - `status_code` が 200 で、本文が `{"success":true, ...}` → 集計できています。
   - 401 で、本文が `UNAUTHORIZED_INVALID_JWT_FORMAT` → ゲートウェイの JWT 検証で止まっています。`verify_jwt = false` がまだデプロイされていません（上の「値が合っていないとどうなるか」）。
   - 401 で、本文が `{"error":"Unauthorized"}` → Vault の `app_cron_secret` と Edge Function secrets の `CRON_SECRET` の値が合っていません。
   - 503 → Edge Function secrets に `CRON_SECRET` がありません。
   - 500 → 認証は通り、集計の途中で失敗しています。Supabase Dashboard の Edge Functions → `calculate-segment-stats` → Logs を見てください。
   - 行がまだ無い → 応答を待っています（上限 400 秒）。少し待ってから見直してください。古い結果は自動で消える（既定では約 6 時間）ので、実行の直後に見てください。
   - ほかの pg_net の呼び出し（カタログ取り込み）の結果も同じ表に入ります。UTC 3:00〜4:00 の回と重なったら、件数を増やして見分けてください。

5. 集計の結果が入っている。

   ```sql
   SELECT period_type, max(period_start) AS latest_period, count(*) AS rows
   FROM public.segment_stats
   GROUP BY period_type;
   ```

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

## 🚨 エラー急増の運用メール（`OPS_ALERT_EMAIL`）

アプリのエラーログ（`app_logs` の `level = 'error'`）が急に増えたときに、運用の担当者へ 1 通だけメールで知らせます（#1157）。Vercel Cron が 15 分おきに `GET /api/cron/app-log-alerts` を呼び、直近 15 分の件数を数えます。

| 環境変数 | 例 | 役割 | 未設定のときの動き |
|---|---|---|---|
| `OPS_ALERT_EMAIL` | `ops@example.com` | 通知メールの宛先。**メールアドレスを 1 つだけ**書く（`名前 <アドレス>` の形や、カンマ区切りの複数は不可）。共有の受信箱ができるまでは、個人のアドレスでよい | 通知しない。cron は動くが、`app_logs` に info ログを 1 行残すだけで、DB にもメールにも触れない |
| `OPS_ALERT_ERROR_THRESHOLD`（任意） | `50` | しきい値。直近 15 分の `error` が**この件数を超えたら**通知する。1〜100000 の整数 | 既定の 20 件。整数でない・範囲外の値も既定値に戻し、`cron/app-log-alerts` の warn ログに変数名だけを残す |
| `OPS_ALERT_COOLDOWN_MINUTES`（任意） | `120` | 同じ通知を送り直さない時間（分）。1〜10080 の整数 | 既定の 60 分。不正な値は既定値に戻す（しきい値と同じ） |

- 通知する条件: 直近 15 分の `error` が **20 件を超えた**とき（21 件から）。既定値は `src/lib/ops-alerts/app-log-error-spike.ts` の定数で、`OPS_ALERT_ERROR_THRESHOLD` で上書きできる。窓（15 分）は `vercel.json` の cron の間隔と同じにしてあるので、環境変数では変えない。
- 同じ通知は **60 分は送り直さない**（`OPS_ALERT_COOLDOWN_MINUTES` で上書きできる）（DB の `ops_alert_state` で覚える。メールを送れなかったときは「送った」と記録せず、15 分後の次の回でもう一度試す）。
- メールに載るのは、件数・関数名・運用ログ画面（`/super-admin/logs`）へのリンクだけです。ユーザー ID・メールアドレス・ログの本文は載せません（送信先の Resend は米国の事業者のため）。
- **メールが実際に届くには、メールの送信元ドメインを Resend で検証し、`RESEND_API_KEY` と `EMAIL_FROM` を設定する必要があります**（手順は [`docs/operations/email-domain.md`](docs/operations/email-domain.md)）。それまでは、送れなかったことが `app_logs`（`function_name = 'email'` の error と、`cron/app-log-alerts` の warn）に残るだけで、アプリの動きには影響しません。
- 応答（JSON）の `status` は、`disabled`（宛先が未設定）・`invalid_config`（宛先の形が不正）・`below_threshold`（しきい値以下）・`deduped`（60 分以内に送信済み）・`sent`（送信した）・`send_skipped` / `send_failed`（送れなかった）のどれかです。cron が動いているかは、Vercel の Cron Jobs の画面（HTTP ステータス）で確かめられます。`app_logs`（`/super-admin/logs` で `function_name` に `cron/app-log-alerts` を指定）に残るのは、宛先が未設定・形が不正・通知した・通知できなかった回と、しきい値・クールダウンの環境変数の値が不正だった回 (warn。変数名だけ) です（しきい値以下の回と、60 分以内の回は何も残しません）。
- 認証は他の cron と同じ `CRON_SECRET`（上の「Cron の共有シークレットの保管場所とローテーション」）。手で呼ぶ場合は `Authorization: Bearer <CRON_SECRET>` を付けます（値はコマンドの履歴やチャットに残さないこと）。しきい値を超えているときに手で呼ぶと、本物の通知メールが 1 通出て、60 分の抑止が始まります。

---

## 📱 モバイル（Expo）での環境変数

Expoでは `EXPO_PUBLIC_` で始まる変数がクライアントに埋め込まれます（=秘密情報は入れない）。

### 必須（モバイル）
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

この 2 つはビルドのときに埋め込まれます（EAS Build なら、EAS の環境変数に登録しておく）。入っていないビルドは、次のように動きます（#1182。以前は `https://placeholder.supabase.co` という存在しない接続先でクライアントを作り、ログインなどが原因の分かりにくいエラーで失敗し続けていました）。

- 開発中（`npx expo start`・development ビルド）: アプリの起動時に、足りない変数名を書いたエラー（`[mobile] Missing env: EXPO_PUBLIC_SUPABASE_URL, …`）で止まります。
- リリースビルド（preview・production）: クラッシュはさせず、「アプリの設定が不足しています」の画面を出し、足りない変数名を端末のログ（`console.error`）に残します。画面には変数名を出しません（開発ビルドでは画面にも出します）。このビルドは配布せず、環境変数を直して作り直してください。

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

### 任意の環境変数: Edge Function の CORS（`ALLOWED_ORIGINS`）

これは Vercel の環境変数ではなく、**Supabase の Edge Function の Secret** です（Supabase Dashboard → Edge Functions → Secrets、または `supabase secrets set ALLOWED_ORIGINS=...`）。

- 用途: ブラウザから Edge Function を直接呼ぶときに、呼び出し元として認めるサイトのオリジン（カンマ区切り。`https://` から書き、末尾に `/` を付けない）。
- 未設定なら `https://homegohan.app` と `https://homegohan-app.vercel.app` だけを認めます。設定すると、この 2 つの代わりに、設定した値だけを認めます。`*` と `null` は書いても無視されます。
- 普段は設定不要です。このアプリのブラウザやモバイルアプリが Edge Function を直接呼ぶ処理は無く、Next.js の API ルートがサーバーから呼んでいます（サーバーからの呼び出しは CORS の対象外です）。自社の別ドメインのページから直接呼ぶ処理を足すときだけ設定してください。
- バッチ専用の関数（`aggregate-org-stats` など）には、この設定に関係なく CORS を付けません。

### 任意の環境変数: 規約への再同意の強制（`LEGAL_CONSENT_ENFORCE`）

利用規約・プライバシーポリシーへの同意を、画面を開くたびに確かめる仕組み（#1174）のスイッチです。Vercel の環境変数に設定します。

- 確かめるもの: 利用者ごとに記録された「同意済みの版」（`user_profiles.terms_version_accepted` / `privacy_version_accepted`）が、`packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS`（いま有効な版）と同じか。同意の証跡（いつ・どの版に・どの IP と端末から）は `terms_acceptances` に残ります。
- 未設定、または `on` 以外（既定）: 誰も止めません。同意が済んでいない人の画面の上にお知らせを出すかどうかは、次の `LEGAL_CONSENT_NOTICE` で決まります（既定は出しません）。
- `on`: 同意が済むまで、画面を開くと同意画面（`/legal-consent`）へ回します。同意すると元の画面に戻ります。次は回しません: API、利用規約（`/terms`）、プライバシーポリシー（`/privacy`）、特定商取引法の表記（`/legal`）、問い合わせ（`/contact`）、凍結の案内（`/frozen`）、認証の途中の画面（`/auth/*`。アプリの認証ブリッジを含む）、ハンズオンツアー（`/handson-tour`）。
- 同意しない人は、同意画面の「同意しない」でログアウトでき、データの削除は問い合わせフォームから依頼する案内が出ます。
- 強制を始める前に決めること（オーナー）: ①版番号と施行日と同意文言（弁護士の確認。いまの値は仮置き）②強制を始める日。③始める前に、お知らせだけの期間（`LEGAL_CONSENT_NOTICE=on`）を置くかどうか。
- 本番は 2026-10-10 に `on` にしました（オーナー判断。版と施行日は仮置きのまま、お知らせだけの期間は置いていません）。ゲートが掛かるのは Web の画面だけで、モバイルのネイティブの画面と `/api/*` は通りません（#1442）。
- 改定のたびにやること: `LEGAL_DOCUMENTS` の `version` と `effectiveDate` を書き換えて出す。版が変わると、同意済みの人も含めて、全員に再同意を求めます（版を変えずに文面だけ直すと、再同意は求めません）。
- 戻し方: 環境変数を消す（または `off` にする）と、再デプロイ後に同意画面へ回さなくなります。記録済みの同意は残ります。

### 任意の環境変数: 規約への同意のお知らせ（`LEGAL_CONSENT_NOTICE`）

同意が済んでいない人に、画面の上で「同意のお願い」を出すかどうかのスイッチです（#1174）。Vercel の環境変数に設定します。値の読み方は `LEGAL_CONSENT_ENFORCE` と同じです（`on` のときだけ有効。大文字小文字と前後の空白は区別しません）。

- 未設定、または `on` 以外（既定）: 出しません。未同意の人にも何も表示せず、誰も止めません。この間、同意の記録が残るのは、同意画面（`/legal-consent`）を開いて同意した人だけです。
- `on`: 強制（`LEGAL_CONSENT_ENFORCE=on`）していない間、同意が済んでいない人の `(main)` の画面の上に、同意画面へのリンクつきのお知らせを出します。使うのは止めません。お知らせは規約・プライバシーポリシー・同意画面・ログインや新規登録の画面などには出ません。
- `LEGAL_CONSENT_ENFORCE=on` のときは、この設定によらず同意画面へ回します（お知らせは出しません）。
- サーバー側（middleware）だけで読みます。`NEXT_PUBLIC_` は付けません。
- 戻し方: 環境変数を消す（または `off` にする）と、再デプロイ後にお知らせを出さなくなります。

### 任意の環境変数: 機能フラグの対象ユーザー数の上限（`FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT`）

運営の機能フラグ画面（`/super-admin/flags`）の「対象ユーザー数」は、段階公開や条件つきのフラグについて、ユーザーを 1 人ずつ判定して数えます（#1148）。ユーザーがこの数を超えると数えず、画面では「—」になります。全員が対象で条件の無いフラグは件数だけを数えるので、この上限によらず出ます。

- 未設定、または正の整数でない（既定）: 20000。
- 正の整数: その人数まで数えます。大きくすると、運営画面の一覧を開くたびに読むユーザーの行が増え、表示が遅くなります。
- サーバー側（`src/lib/super-admin/flag-active-users.ts`）だけで読みます。`NEXT_PUBLIC_` は付けません。

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



