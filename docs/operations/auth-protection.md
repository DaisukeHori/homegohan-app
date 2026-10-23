# ログイン・登録の守り — Supabase Auth の設定値と Cloudflare Turnstile (bot 対策)

> 作成: 2026-10-08 / 関連: Issue #1165 / オーナー判断: 2026-10-08 (決定キー 1165)
> 更新: 2026-10-10 — Web のログインのサーバー経由化 (`POST /api/auth/login`) と、ログイン失敗の回数によるボットの確認を追加 (§1・§2.1・§4〜§8)
> 更新: 2026-10-10 — ログイン失敗のロック (5 回で 15 分など) をやめた。失敗が続いたらボットの確認を求めるだけにした (§1・§2・§2.1・§5・§7・§8)
> 更新: 2026-10-14 — メール確認の再送 (`/auth/verify`) と、設定のパスワード変更の本人確認にも Turnstile のトークンを付けた (#1474。§1・§4〜§6・§8〜§10)
> 更新: 2026-10-14 — e2e・デプロイ後の動作確認スクリプト (`--with-auth`)・Maestro の補助スクリプトが、パスワードのログインを使わず、管理用の鍵でセッションを作るようにした (#1547。§1・§4・§6・§8・§10)
>
> この文書は 2 つのことを 1 か所にまとめる。
> 1. **いまの Supabase Auth の設定値の記録** (レート制限・攻撃対策)。「**オーナー記入**」と書いた欄は、Supabase のダッシュボードで見える現在の値を、オーナーが書き込む。
> 2. **Cloudflare Turnstile (bot 対策) を入れて、Supabase で有効にするまでの手順**。順番を間違えると、アプリのログインが止まる。

---

## 1. 決まっていること (要約)

| 項目 | 決定 |
|---|---|
| bot 対策の方式 | Cloudflare Turnstile (**Managed** モード)。ログイン・新規登録・パスワード再設定の 3 画面と、メール確認の再送 (`/auth/verify`) (#1474)。設定のパスワード変更は、#1720 段 C (PR #1860) から再認証のサインインをしない (`POST /api/auth/password/change`) ので対象外 |
| アカウントのロックアウト | しない (オーナーの選択 2026-10-10。他人のメールアドレスで失敗を繰り返すだけで本人を締め出せるため。失敗が続いたらボットの確認を求める) |
| ログインに続けて失敗したとき | 同じメールアドレスで **続けて 3 回以上** 失敗したら、次のログインからボットの確認 (Turnstile) を求める (§2.1)。Web のログイン (`POST /api/auth/login`) で働く。何回失敗しても、正しいパスワードならログインできる |
| いまのクールダウン | **残す**。ログインに失敗すると、同じメールアドレスでは 30 秒待つ (画面側の仕組み。Web は localStorage、アプリは AsyncStorage) |
| 入れる順番 | **Web が先、モバイルは次のビルド** |
| Supabase で CAPTCHA を有効にする時期 | **モバイルの新しいビルドを配って、古いビルドが使われなくなってから** (§6)。オーナーが決める |

### なぜ、すぐには Supabase で有効にしないのか

Supabase の CAPTCHA を有効にすると、ログイン・登録・パスワード再設定の API は、Turnstile のトークンが付いていないリクエストを**断る**ようになる。

- 今配られているモバイルのビルドは、トークンを付けられない。有効にした瞬間に、ログインも新規登録もできなくなる。
- 本番を対象にした e2e (`tests/e2e/global-setup.ts` など)・デプロイ後の動作確認スクリプト (`--with-auth`)・Maestro の補助スクリプトは、Supabase の `/auth/v1/token?grant_type=password` を直接呼んでいた。トークンが無いので失敗する。#1547 で、パスワードのログインを使わない方法に変えた (§4)。

一方で、**Web の画面に Turnstile を出しただけでは、本当の防御にはならない**。Supabase の URL と anon key は公開されているので、攻撃者は画面を通さずに Supabase の Auth API を直接呼べる。トークンを必須にする (= Supabase で CAPTCHA を有効にする) まで、直接呼ぶ攻撃は止まらない。だから、順番は「Web とモバイルの両方がトークンを付けるようになる → 古いビルドが消える → Supabase で有効にする」になる。

---

## 2. 守りの全体像 (何が何を止めるか)

| 守り | どこで動く | 止めるもの | 止められないもの |
|---|---|---|---|
| ログイン失敗後の 30 秒クールダウン | 画面 (ブラウザ・アプリ) | 同じ端末での連打 | 画面を通さない攻撃、別の端末、保存データを消した端末 |
| Turnstile のウィジェット | 画面 | bot が画面を操作すること | Supabase の API を直接呼ぶ攻撃 |
| **Supabase の CAPTCHA (有効化後)** | **Supabase (サーバー)** | **トークンの無い・使用済み・偽物のリクエスト (画面を通すかどうかに関係なく)** | — |
| Supabase のレート制限 (§3.1) | Supabase (サーバー) | IP アドレスごと・ユーザーごとの回数超過 | 多数の IP を使う攻撃 |
| Supabase の攻撃対策 (§3.2) | Supabase (サーバー) | 漏れたことのあるパスワードの利用、弱いパスワード | — |
| IP アドレスごとの回数制限 (10 回/分) | このアプリのサーバー (`POST /api/auth/login`) | 1 つの IP から多くのメールアドレス・パスワードを試すこと | 多数の IP を使う攻撃、Supabase の API を直接呼ぶ攻撃、モバイルのアプリ (§2.1) |
| 続けて失敗したメールアドレスでのボットの確認 (§2.1) | このアプリのサーバー (`POST /api/auth/login`) + DB | 同じメールアドレスへのパスワードの総当たりを、bot で続けること (端末・IP をまたいでも数える。`TURNSTILE_SECRET_KEY` があるとき) | 人の手による試行、Supabase の API を直接呼ぶ攻撃、モバイルのアプリ (§2.1) |

### 2.1 ログインに続けて失敗したとき (Web)

**アカウントはロックしない**。他人のメールアドレスで失敗を繰り返すだけで、本人を締め出せてしまうため (§1)。失敗が続いたら、ボットの確認を求めるだけにする。

Web のログイン画面は、ブラウザから Supabase を直接呼ばず、このアプリのサーバーの `POST /api/auth/login` を通す。サーバーは次の順で処理する (`src/lib/auth/guarded-login.ts`)。

1. IP アドレスごとの回数制限 (10 回/分。`src/lib/rate-limit.ts` の `auth-login`)。超えたら 429。
2. 続けて 3 回以上失敗しているメールアドレスなら、ボットの確認のトークンを Cloudflare に問い合わせて確かめる (`TURNSTILE_SECRET_KEY` があるとき。§5)。トークンが無い・偽物なら 400 で断る (パスワードは確かめない・回数は増やさない)。
3. Supabase でパスワードを確かめる。違えば回数を 1 増やして 401。合っていればログインでき、回数を 0 に戻す。

| 続けて失敗した回数 | すること |
|---|---|
| 0〜2 回 | なし |
| 3 回以上 | 次のログインから、ボットの確認を求める (キーがあるとき)。何回失敗しても、ロックはしない |

- 回数は**メールアドレスごと** (小文字・前後の空白なし)。端末・ブラウザ・IP をまたいで数える。記録は DB の `auth_login_failures` (メールアドレスは SHA-256 のハッシュだけ。`supabase/migrations/20261010130000_auth_login_failures.sql`)。数え方の関数は `supabase/migrations/20261010160000_auth_login_failure_window.sql`。
- 登録されていないメールアドレスも同じように数える (応答からアカウントの有無が分からないように)。
- 回数が 0 に戻るのは、**ログインに成功したとき**と、**最後の失敗から 24 時間** (環境変数 `AUTH_LOGIN_FAILURE_RESET_MINUTES` で分単位に変えられる。1〜10080) が経ったとき。パスワードの再設定では戻さない (戻す必要が無い。再設定のあとのログインに成功すれば戻る)。
- 記録の保持期間: 記録の行は、最後の失敗 (`last_failed_at`。無ければ `updated_at`) から **8 日** が経つと、毎日 03:45 JST の pg_cron のジョブ `cleanup-stale-login-failures-and-grant-claims` が消す (`supabase/migrations/20261011070000_schedule_login_failure_and_grant_claim_cleanup.sql`、#1492)。8 日は、回数を 0 に戻すまでの時間の上限 (10080 分 = 7 日) より 1 日長いので、数えている途中の行は消さない (上限より古い行は、どの設定でも回数の判定に使われない)。
- ロックをしないので、ロック中の応答 (423)・ロックの残り時間の案内・ロックの通知のメール (本人・運営)・ロックを外す API は無い。
- **ボットの確認が働かないもの**: モバイルのアプリのログイン (アプリはまだ Supabase を直接呼ぶ)、Supabase の Auth API を直接呼ぶ攻撃 (URL と anon key は公開されている)、Google ログイン。直接呼ぶ攻撃は、Supabase の CAPTCHA (§6 手順 5) とレート制限 (§3.1) で止める。
- ロックがあったころの列 (`auth_login_failures.locked_until`) と関数 (`auth_login_lock_status`・`auth_login_record_failure`・`auth_login_apply_lock`・`auth_login_account_user_id`) は、DB から消してある (`supabase/migrations/20261017010000_drop_auth_login_lock_objects.sql`、#1542)。

---

## 3. いまの Supabase Auth の設定値 (オーナー記入)

オーナーが Supabase のダッシュボードで現在値を確認し、右の列に書き込む。記入したら「確認日」も書く。値を変えたときは、この表も更新する。

- 確認した人: **(オーナー記入)**
- 確認日: **(オーナー記入)**
- Supabase のプラン (Free / Pro など): **(オーナー記入)**

### 3.1 レート制限 (ダッシュボード → Authentication → Rate Limits)

「Supabase の既定値」は、公式ドキュメント ([Rate limits](https://supabase.com/docs/guides/auth/rate-limits)) に書かれている初期値 (2026-10-08 に確認)。**参考であって、このプロジェクトの現在値ではない**。現在値の列を埋める。

| 項目 | 対象の API | 数え方 | Supabase の既定値 (参考) | 現在値 (オーナー記入) |
|---|---|---|---|---|
| メールの送信 | Auth が送るメール全部 (確認・再設定・招待など) | プロジェクト全体・1 時間あたり | 2 通 (組み込みの送信機能のとき。独自の SMTP を設定すると変えられる) | |
| SMS の送信 | SMS を送る Auth の API 全部 | プロジェクト全体・1 時間あたり | 30 通 | |
| サインアップ・サインイン | `/signup` `/recover` `/resend` `/magiclink` `/otp` `/user` | IP アドレスごと・5 分あたり | 30 回 | |
| トークン (パスワードログインを含む) | `/token` (パスワード・リフレッシュ・ID トークン・PKCE) | IP アドレスごと・5 分あたり | 150 回 | |
| 確認 | `/verify` (メールのリンク・OTP の確認) | IP アドレスごと・5 分あたり | 30 回 | |
| 匿名サインイン | `/signup` (メールも電話も無いもの) | IP アドレスごと・1 時間あたり | 30 回 | |
| Web3 サインイン | `/token` | IP アドレスごと・5 分あたり | 30 回 | |
| 多要素認証 (MFA) の challenge / verify | `/factors/:id/challenge` `/factors/:id/verify` | IP アドレスごと・1 分あたり | 15 回 (変更不可) | 変更できないので記入は不要 (運営ロールは TOTP を使う。docs/design/cross/12-operator-mfa.md・下の §11) |
| 同じユーザーへの再送 | `/signup` の確認メール、`/recover`、`/otp` | ユーザーごと | 60 秒に 1 回 | |

超えると 429 (Too Many Requests) が返る。画面は「しばらくしてから再度お試しください」と表示し、ログインではクールダウンも付ける (`src/app/(auth)/login/page.tsx`)。

### 3.2 攻撃対策 (ダッシュボード → Authentication → Attack Protection など)

画面の名前や場所は Supabase 側の更新で変わることがある。見つからなければ、公式ドキュメントの検索で「CAPTCHA protection」「leaked password protection」を探す。

| 項目 | 現在値 (オーナー記入) | メモ |
|---|---|---|
| CAPTCHA protection (有効 / 無効) | | **いまは無効のはず**。有効にする時期は §6 |
| CAPTCHA のプロバイダー | | 有効にするときは **Cloudflare Turnstile** |
| CAPTCHA の秘密キーを登録済みか | | 値はここに書かない。登録したかどうかだけ書く |
| Leaked password protection (漏洩パスワードの拒否) | | Pro プラン以上で使える。プランは上の欄 |
| パスワードの最小文字数 | | アプリ側の確認は 8 文字以上・英字と数字を含む (`src/lib/auth/validate-password.ts`) |
| パスワードに必須の文字の種類 | | |
| メールアドレスの確認 (Confirm email) | | 有効だと、登録後にメールのリンクを押すまでログインできない |
| Secure password change (`secure_password_change`。Authentication → Providers → Email) | | **OFF のまま**にする。ON だと、作成から 24 時間を過ぎたセッションのパスワードの変更に再認証 (メールのコード) が要り、アプリの画面はそれを扱わない (`docs/design/cross/16-auth-history-sessions.md` §24) |
| GoTrue の DB の暗号化 (`GOTRUE_SECURITY_DB_ENCRYPTION_*`) | | **OFF のまま**にする。ON にすると `auth.users.encrypted_password` が暗号文になり、過去のパスワードとの照合 (RPC `auth_password_check`。bcrypt を比べる) ができない (cross/16 §3) |
| `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` (パスワードの変更に現在のパスワードを求める) | | 既定は OFF。OFF の間は、access token を盗んだ人が GoTrue の `PUT /auth/v1/user` を直接呼ぶと、現在のパスワード無しで変えられる (アプリの照合も通らない。cross/16 S-33)。ON にするかは cross/16 §25 Q-18 の結論に従う (ON にできるのは、パスワードの変更の API (cross/16 段 C) が入った後) |
| JWT (access token) の有効期間 (Authentication → Sessions) | | 既定の 1 時間以下にする。失効させた端末が PostgREST を直接呼ぶ要求は、JWT の期限まで通る (cross/16 §24) |
| Session timebox / inactivity timeout (Authentication → Sessions) | | **使わない** (未設定のまま)。代わりに pg_cron のジョブ `cleanup-auth-sessions-and-login-history` が、30 日更新の無いセッションを終える (cross/16 §11.6) |
| `auth.sessions` / `auth.users` のトリガー 4 本が残っているか | | 年に 1 回、SQL エディタで `SELECT tgname FROM pg_trigger WHERE tgrelid IN ('auth.sessions'::regclass, 'auth.users'::regclass) AND NOT tgisinternal` を流し、`on_auth_session_created`・`on_auth_session_refreshed`・`on_auth_session_deleted`・`on_auth_user_password_changed` の 4 行があることを確かめる。Supabase 側の移行で表が作り直されると消え、ログインの記録とパスワードの履歴が止まる (ログインは止まらない) |
| その 4 本のトリガーの消し方 | | 表の所有者 (`supabase_auth_admin`) でないと消せない。migration のロールバック (`supabase/rollbacks/20261016243000_auth_history_sessions.down.sql`) は関数の本体を空にして残す (cross/16 §11.7)。トリガーそのものを消すときは Supabase のサポートに頼む |

### 3.3 メール送信についての注意

本番のメールは、送信元ドメインがまだ認証できていないため、**届かない**ことがある。確認メールやパスワード再設定メールに頼る動作確認は、いまは成立しない。

- 登録・パスワード再設定の画面は、メールの到着を待たない作りにしてある。メールの送信に失敗しても、画面が壊れることはない。
- CAPTCHA を有効にしたあとの動作確認では、「メールが届くこと」ではなく「Supabase が 200 を返すこと」(画面が完了表示になること) を見る。

---

## 4. このリポジトリの対応状況

| 画面 | Supabase の呼び出し | Web (Turnstile) | モバイル (Turnstile) |
|---|---|---|---|
| ログイン | Web: `POST /api/auth/login` (サーバーが `signInWithPassword`)。モバイル: `signInWithPassword` | 対応済み (トークンは本文の `captchaToken`) | 対応済み (**次のビルドから**) |
| 新規登録 | `signUp` | 対応済み | 対応済み (次のビルドから) |
| パスワード再設定の依頼 | `resetPasswordForEmail` | 対応済み | 対応済み (次のビルドから) |
| Google ログイン・登録 | `signInWithOAuth` | CAPTCHA の対象外 | CAPTCHA の対象外 |
| メール確認の再送 (`/auth/verify`) | `resend` | 対応済み (トークンは `options.captchaToken`。#1474) | (モバイルに再送の画面は無い) |
| 設定 → アカウント → パスワード変更 | Web・モバイルとも `POST /api/auth/password/change` (サーバーが RPC `auth_password_check` で今のパスワードを確かめ、GoTrue の `PUT /auth/v1/user` で更新する。#1720 段 C・PR #1860) | CAPTCHA の対象外 (再認証の `signInWithPassword` をしない。`src/app/(main)/settings/account/page.tsx`。#1474 で付けたトークンは #1860 で要らなくなった) | CAPTCHA の対象外 (同じ API。`apps/mobile/src/lib/account-credentials.ts`) |
| 新しいパスワードの保存 (`/auth/reset-password`) | `updateUser` | CAPTCHA の対象外 | CAPTCHA の対象外 |

メール確認の再送と、設定のパスワード変更の本人確認は、#1474 でトークンを付けた (それまでは、Supabase で CAPTCHA を有効にすると動かなくなる「未対応」だった)。ほかの画面と同じく、サイトキーが未設定ならウィジェットを出さず、トークンも付けない。サイトキーがあれば、トークンが取れるまで再送・変更のボタンは押せない。パスワード変更では、新しいパスワードの保存 (`updateUser`) と他の端末のログアウト (`signOut`) は CAPTCHA の対象外なので、トークンは本人確認の `signInWithPassword` にだけ付けていた。その後、#1720 段 C (PR #1860) でパスワードの変更は `POST /api/auth/password/change` に替わり、本人確認の `signInWithPassword` が無くなったので、いまの設定のパスワード変更はウィジェットを出さず、トークンも付けない (上の表)。

テストの道具のログイン (#1547 で対応済み):

以前は、次の 3 つが Supabase のパスワードのログイン (`/auth/v1/token?grant_type=password`) を直接呼んでいて、CAPTCHA を有効にすると断られた。いまは、パスワードのログインを使わず、**管理用の鍵 (service_role) でテスト用のセッションを作る**。手順は 3 つとも同じで、e2e と `--with-auth` は共通の補助関数 `tests/e2e/helpers/test-session.mjs` (依存の無い素の JavaScript) を import して使う (手順を写さない)。Maestro の補助スクリプトだけは import できないので同じ手順を写し、補助関数と食い違わないことを単体テストで突き合わせる:

1. service_role で `POST /auth/v1/admin/generate_link` (`type: "recovery"`) → ワンタイムのトークン (`hashed_token`) を受け取る。メールは送られない
2. anon key で `POST /auth/v1/verify` (`type: "recovery"`, `token_hash`) → セッションを受け取る

`/admin/generate_link` (管理用の鍵の検査だけ) と `/verify` には、Supabase の CAPTCHA の検査が掛からない (Supabase Auth のソースで確かめた。根拠の場所は `tests/e2e/helpers/test-session.mjs` の先頭のコメント)。`type` は `recovery` にする (`magiclink` は、そのメールアドレスのユーザーがいないと新しく作ってしまう。`recovery` はいなければ 404 で止まる)。

- **e2e** (`tests/e2e/global-setup.ts`、`tests/e2e/fixtures/auth.ts`・`fresh-user.ts`、`tests/e2e/helpers/seed-roles.ts`、`tests/e2e/tour/`、`tests/e2e/membership/02-org-invite-new-user.spec.ts`): 共通の補助関数 `tests/e2e/helpers/test-session.mjs` の `createTestSession` を呼ぶ。鍵は今までのテストと同じ環境変数 (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`) から読む。`SUPABASE_SERVICE_ROLE_KEY` が無いと、`global-setup.ts` と `fixtures/auth.ts` は画面からのログインに回る。
  - 同じテストユーザーのセッションを複数の worker が同時に作ると、後の `generate_link` が先のトークンを消す (Supabase Auth は発行のたびに同じ種類の既存のトークンを消す)。先の `/verify` は 403 (`otp_expired`) になるので、`createTestSession` はこの 403 のときだけ、乱数で待ってから `generate_link` からやり直す (既定 6 回まで。環境変数 `E2E_TEST_SESSION_MAX_ATTEMPTS` で変えられる)。`--with-auth` (同じ補助関数を使うので、回数・待ち方・環境変数も同じ) と Maestro の補助スクリプト (既定 6 回まで。シェルの環境変数 `MAESTRO_E2E_TEST_SESSION_MAX_ATTEMPTS` で変えられる。`scripts/maestro-parallel-runner.sh` は並列のシミュレーターすべてに同じテストユーザーを渡す) も、同じ 403 (`otp_expired`) のときだけ発行からやり直す。やり直しの分だけ `/verify` を余分に呼ぶ。
  - `/verify` の回数制限 (§3.1 の「確認」。既定は IP ごとに 5 分 30 回) は、パスワードのログインの `/token` (既定 150 回) より低い。`authedPage` はテストごとにセッションを作るので、手元から本番に向けて全件を流すと 429 になりやすい。429 のときは間を空けてやり直し、それでも作れなければ、保存済みのセッション (storageState・refresh_token) の経路に回る。
  - CI の本番向け e2e (`.github/workflows/e2e.yml`) は、Supabase の値を渡していないので、もとから画面からログインしている (この変更の影響は無い)。画面のログインは Turnstile のウィジェットのトークンを付けるので CAPTCHA を有効にしても通るが、本番のサイトキーでは自動化ブラウザに操作を求めることがある (§6 手順 2 の注意)。
- **デプロイ後の動作確認スクリプトの `--with-auth`** (`npm run test:smoke -- --with-auth`、本体は `scripts/lib/smoke.mjs`): 共通の補助関数 `tests/e2e/helpers/test-session.mjs` を import して使う (手順を写さない)。確認したい環境の `SUPABASE_SERVICE_ROLE_KEY` が要る (`E2E_USER_PASSWORD` は使わなくなった)。**本番では `--with-auth` を使わない** (本番の管理用の鍵を、確認用の端末やシェルに出さないため)。本番は `--with-auth` なしの 4 項目で確認する (`--with-auth` を付けない通常の確認は、CAPTCHA の影響を受けない)。
- **Maestro (モバイルの e2e) の補助スクリプト** `apps/mobile/maestro/flows/scripts/reset-onboarding.js`: 同じ手順 (Maestro の JavaScript は import できないので、ここだけ写している)。Supabase の URL・anon key・service_role は、シェルの環境変数 `MAESTRO_SUPABASE_URL` / `MAESTRO_SUPABASE_ANON_KEY` / `MAESTRO_SUPABASE_SERVICE_ROLE_KEY` で渡す (`apps/mobile/maestro/README.md`)。**本番の Supabase には使わない** (本番の URL や鍵を既定値として持たない)。
- 結合テスト (`tests/integration/`) は、ローカルの Supabase (CAPTCHA は常に無効) に向けて動くので影響しない (今までどおりパスワードでログインする)。

そのほか、CAPTCHA を有効にすると動かなくなるもの (いまは無い):

- (解消済み) **モバイルの設定 → アカウント管理 → パスワード変更** (#1187)。以前は本人確認の `signInWithPassword` にトークンを付けておらず、有効にすると「ボットではないことの確認に失敗しました」と断られるはずだった。#1720 段 C (PR #1860) でパスワードの変更が `POST /api/auth/password/change` に替わり、再認証のサインインが無くなったので、有効にしても影響しない (メールアドレス変更の `updateUser` も CAPTCHA の対象外)。

---

## 5. キーと環境変数

Cloudflare Turnstile のキーは 2 つある。

| キー | 置き場所 | 公開してよいか |
|---|---|---|
| **サイトキー** (sitekey) | Web: Vercel の `NEXT_PUBLIC_TURNSTILE_SITE_KEY`。モバイル: EAS の環境変数 `EXPO_PUBLIC_TURNSTILE_SITE_KEY` | 公開してよい (画面のコードに埋め込まれる) |
| **秘密キー** (secret key) | 次の 2 か所の**どちらか一方だけ**に入れる。(1) Vercel のサーバー用の環境変数 `TURNSTILE_SECRET_KEY` (§6 手順 2 の 5。Web のログインで、続けて 3 回以上失敗したメールアドレスのトークンをこのアプリのサーバーが確かめる)。(2) Supabase のダッシュボード (§6 手順 5。すべてのリクエストのトークンを Supabase が確かめる) | **公開しない**。コード・Issue・PR・チャットに書かない。`NEXT_PUBLIC_` を付けた変数には入れない |

- **どちらのサイトキーも未設定なら、Turnstile は出ない**。画面は今までどおりに動き、トークンも送らない。ローカル開発・テストは未設定のままでよい。
- **`TURNSTILE_SECRET_KEY` (またはサイトキー) が未設定なら、このアプリのサーバーはトークンを確かめずに通す**。サーバーの起動後、最初にログインを処理したときに、その旨のログ (`app_logs` の warn) が 1 回だけ出る。ログインに続けて失敗しても、キーの有無に関係なく、アカウントはロックしない (§2.1)。
- **秘密キーを (1) と (2) の両方に入れない**。トークンは 1 回しか使えないので、このアプリのサーバーが確かめたトークンは Supabase へ渡さない。Supabase の CAPTCHA が有効だと、そのログインは「トークンが無い」として断られる。Supabase で有効にするときは、先に `TURNSTILE_SECRET_KEY` を消す (§6 手順 5)。
- 設定すると、ログイン・新規登録・パスワード再設定の 3 画面と、メール確認の再送にウィジェットが出て、**確認が終わるまで送信ボタン (再送のボタン) が押せなくなる** (設定のパスワード変更は #1860 から対象外)。
- どちらもビルド時に埋め込まれる。変えたら、Web は再デプロイ、モバイルは新しいビルドが要る。

### Cloudflare 側の設定

Cloudflare ダッシュボード → Turnstile → Add widget で作る。

- **Widget mode は Managed** (リスクの高い訪問者にだけチェックボックスを出す)。
- **Hostname management (許可するホスト名)** に、次をすべて入れる。入っていないホストでは、ウィジェットが `110200` のエラーで動かない。
  - Web の本番ドメイン (本番で使うもの全部)
  - `homegohan-app.vercel.app` (いまの本番の URL。プレビューも使うなら、そのホストも)
  - **モバイルの WebView が使うホスト名**。アプリは WebView に `EXPO_PUBLIC_WEB_URL` (未設定なら `https://homegohan-app.vercel.app`) の origin を与えて Turnstile を動かすので、そのホスト名が許可されている必要がある
  - 手元で動かすなら `localhost`
- 作ると、サイトキーと秘密キーが表示される。秘密キーは再表示できないことがあるので、安全な場所に控える。

### 動作確認用のテストキー (Cloudflare 公式)

[Test your Turnstile implementation](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) に載っている、公開されたダミーのキー。任意のドメインで動き、実際の確認は行わない。**本番には使わない**。

| 種類 | 値 | 動き |
|---|---|---|
| サイトキー | `1x00000000000000000000AA` | 常に成功 (表示あり)。**CI の e2e が使っている** |
| サイトキー | `2x00000000000000000000AB` | 常に失敗 (表示あり) |
| サイトキー | `3x00000000000000000000FF` | 必ず操作を求める (表示あり) |
| 秘密キー | `1x0000000000000000000000000000000AA` | 常に成功 |
| 秘密キー | `2x0000000000000000000000000000000AA` | 常に失敗 |

テスト用のサイトキーが返すダミーのトークンは `XXXX.DUMMY.TOKEN.XXXX`。本番の秘密キーはこのダミーを断る。

---

## 6. 有効にするまでの手順 (この順番で)

### 手順 1. Cloudflare でウィジェットを作る

§5 のとおり、Managed で作り、サイトキーと秘密キーを控える。

### 手順 2. Web に入れる (Supabase はまだ CAPTCHA 無効のまま)

1. Vercel → Settings → Environment Variables に `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (サイトキー) を、Production (と、使うなら Preview) に追加する。
2. 再デプロイする。
3. `/login` `/signup` `/auth/forgot-password` を開いて確認する。
   - ウィジェットが出る。出ない (エラーが表示される) 場合は、ホスト名の許可 (§5) と CSP を疑う。
   - トークンが取れるまで、送信ボタンが押せない。取れたら押せる。
   - ログインできる。
   - あわせて、メール確認の再送 (`/auth/verify?email=…` の「再送信」) でも、ウィジェットが出て、トークンが取れるまでボタンが押せないことを確かめる (#1474。設定のパスワード変更は #1860 からウィジェットを出さない)。
4. この時点では、Supabase はトークンを検証しない (付いて届くだけ)。**誰もログインできなくなることはない**。
5. (任意) Vercel のサーバー用の環境変数 `TURNSTILE_SECRET_KEY` に秘密キーを入れて再デプロイすると、Web のログインで続けて 3 回以上失敗したメールアドレスの次のログインから、このアプリのサーバーがトークンを確かめる (§2.1)。`NEXT_PUBLIC_` を付けない。手順 5 で Supabase の CAPTCHA を有効にするときは、先にこれを消す (§5)。

> 本番を対象にした e2e は、ログイン画面のウィジェットを待つようになる。本番のサイトキーは、CI の自動化ブラウザには操作を求めることがある。サイトキーを本番に入れる前に、本番向け e2e の扱い (§4 の最後) を決めておく。

### 手順 3. モバイルに入れる (次のビルド)

1. EAS の環境変数に `EXPO_PUBLIC_TURNSTILE_SITE_KEY` (同じサイトキー) を登録する。最初は **preview ビルドだけ**に入れ、実機で確認してから本番ビルドに入れる。
2. 実機 (iOS・Android) で、ログイン・新規登録・パスワード再設定の画面を確認する。
   - ウィジェットが出て、トークンが取れる (取れるまで送信ボタンは押せない)。
   - チェックボックスが出る場合に、押せる。
   - ウィジェットの中の Cloudflare の「プライバシー」「利用規約」のリンクを押すと、外のブラウザで開く。アプリの中のウィジェットは別のページに置き換わらず、そのまま残る (WebView の `onOpenWindow` で受けている。実機でしか確かめられない)。
   - ログインできる。
   - 機内モードなど、通信できないときに、エラーと「もう一度確認する」が出る。
3. 本番ビルドを作り、TestFlight / ストアで配布する。

### 手順 4. 有効にする前の最終確認

- [ ] モバイルの新しいビルドが配られ、**古いビルドが使われなくなった** (使われているビルドの内訳は、App Store Connect / Google Play Console で見る)
- [x] メール確認の再送と、設定画面のパスワード変更の本人確認に、トークンを付ける対応が入った (#1474。§4。その後 PR #1860 でパスワード変更は再認証のサインインをしなくなり、トークンも要らなくなった)
- [x] 本番向け e2e のログインを、トークンが要らない方法へ変えた (§4。#1547 の PR #1581 (e6879e8f): `global-setup.ts`・`fixtures/auth.ts` ほかが管理用の鍵でテスト用のセッションを作る。CI の本番向け e2e (`e2e.yml`) は Supabase の値を渡さず、画面からウィジェットのトークンを付けてログインする)
- [x] デプロイ後の動作確認スクリプトの `--with-auth` (`scripts/lib/smoke.mjs`) と、Maestro の補助スクリプト (`apps/mobile/maestro/flows/scripts/reset-onboarding.js`) を、トークンが要らない方法へ変えた、または使わない運用にした (§4。#1547: 管理用の鍵でセッションを作る方法に変えた。どちらも本番では使わない)
- [ ] Web の本番に `NEXT_PUBLIC_TURNSTILE_SITE_KEY` が入っていて、3 画面と、メール確認の再送で動いている (設定のパスワード変更は #1860 から対象外)
- [ ] ロールバック手順 (§7) を読んだ

### 手順 5. Supabase で CAPTCHA を有効にする

0. Vercel に `TURNSTILE_SECRET_KEY` を入れている (手順 2 の 5) なら、先に**削除して再デプロイ**する (このアプリのサーバーと Supabase が同じトークンを 2 回確かめると、2 回目が「使用済み」で断られる)。
1. Supabase ダッシュボード → Authentication → Attack Protection (Bot and Abuse Protection) → **Enable CAPTCHA protection**。
2. プロバイダーに **Cloudflare Turnstile** を選び、**秘密キー**を入れて保存する。
3. 保存した直後から、トークンの無いリクエストは断られる。

### 手順 6. 有効にした直後の確認

- Web の 3 画面で、ログイン・登録・パスワード再設定が通る。
- Web で、メール確認の再送が通る (#1474)。設定のパスワード変更も通る (#1860 から CAPTCHA の対象外)。
- モバイルの新しいビルドで、同じ 3 つが通る。
- 古いビルドは通らない (想定内。使えなくなったことを確認するだけ)。
- 失敗するときは、画面に「ボットではないことの確認に失敗しました。もう一度お試しください。」と出る (英語の生のエラー文は出さない)。
- メールの到着は確認項目に入れない (§3.3)。

---

## 7. 元に戻す (ロールバック)

| 状況 | やること | 反映 |
|---|---|---|
| Supabase の CAPTCHA を有効にしたら、ログインできなくなった | Supabase ダッシュボードで **CAPTCHA protection を無効**にして保存する | すぐ |
| Web のウィジェットが動かず、ログインできない | Vercel の `NEXT_PUBLIC_TURNSTILE_SITE_KEY` を**削除**して再デプロイする。画面から Turnstile が消え、トークンも送らなくなる (今までどおり)。Supabase の CAPTCHA が有効なら、先にそちらを無効にする | 再デプロイ後 |
| モバイルのウィジェットが動かず、ログインできない | Supabase の CAPTCHA を無効にする (サーバー側で止める)。アプリのキーを外すには、キー無しの新しいビルドが要る | Supabase は即時。アプリは次のビルド |
| ボットの確認 (このアプリのサーバー側) が誤って断る | Vercel の `TURNSTILE_SECRET_KEY` を削除して再デプロイする (確かめずに通すようになる) | 再デプロイ後 |

この変更 (コード) 自体を戻す必要がある場合は、PR を revert する。ログイン失敗の回数の DB (`auth_login_failures` と関数) は、**Web のデプロイを戻したあとで** `supabase/rollbacks/20261010160000_auth_login_failure_window.down.sql`・`supabase/rollbacks/20261010130000_auth_login_failures.down.sql` の順に、その内容を新しい migration として入れて消す (先に消すと、`POST /api/auth/login` が回数を読めず 500 になり、ログインできなくなる)。

---

## 8. ローカル・CI・テスト

- **ローカルの Supabase は CAPTCHA を有効にしない** (`supabase/config.toml` に `[auth.captcha]` を書かない)。結合テスト・e2e・開発は、トークン無しで `signInWithPassword` / `signUp` を呼ぶため。`src/__tests__/config/turnstile-config.test.ts` が、有効にされていないことを検査する。
- **単体テスト** (`tests/auth-turnstile-widget.test.tsx`、`tests/auth-turnstile-pages.test.tsx`、`tests/auth-turnstile-resend-password-change.test.tsx`): ウィジェットの動き、3 画面とメール確認の再送 (#1474) が Supabase の**正しい場所**にトークンを付けること (設定のパスワード変更は #1860 から対象外で、`tests/auth-turnstile-resend-password-change.test.tsx` は再送だけを見る)、「トークンが無い間は送信ボタンが押せない」こと。モバイルは `apps/mobile/__tests__/`。
  - 注意: `resetPasswordForEmail` だけは、`captchaToken` を `options` の中ではなく**第 2 引数の直下** (`redirectTo` と同じ階層) に渡す。`options` の中に入れても、Supabase には届かず、黙って無視される。
- **テストの道具のログイン (#1547)**: 単体テスト `tests/e2e-test-session.test.ts` が、共通の補助関数 (`tests/e2e/helpers/test-session.mjs`) と Maestro の補助スクリプトが CAPTCHA の対象外の経路 (`/admin/generate_link` と `/verify`) だけを呼び、パスワードのログインを呼ばないこと (呼び出しの検査)、同じユーザーで並行に作って `/verify` が 403 になったときに発行からやり直すこと、e2e の各所と `--with-auth` がこの補助関数を import して使うこと、`tests/e2e`・`scripts`・`apps/mobile/maestro` で発行・確認の経路を直接呼ぶのが補助関数と Maestro のスクリプト (import できないただ 1 つの写し。やり直す回数の解釈を補助関数と同じ入力で突き合わせる) だけであること、これらのコード (コメントを除く) にパスワードのログインが戻ってきていないことを確かめる。`--with-auth` は `tests/smoke-script.test.ts` (node で CLI を動かして、補助関数を読み込めることも確かめる)。ローカルの Supabase は CAPTCHA が無効なので、e2e が緑でも「CAPTCHA が有効でも通る」ことは示せない。そのため呼び出しの形で固定している。
- **ログインに続けて失敗したとき (ロックしない)**: 単体テスト `tests/auth/login-failures.test.ts` (回数 → ボットの確認の決定表・時間で戻る・環境変数)・`tests/auth/guarded-login.test.ts` (状態 × 操作の表。何回失敗しても正しいパスワードならログインできる)・`tests/api/auth-login-route.test.ts` (応答の表。何回失敗しても 423 にならない)・`tests/auth/turnstile-verify.test.ts`。回帰テスト `tests/auth/no-login-lockout.test.ts` (ロックの応答・ロックの DB の関数・ロックを外す API がコードに戻ってきたら失敗する。AI の送る先の一覧のログインの項に外したメール (Resend) が書かれていたり、文書にロックを前提にした文が書かれていたりしても失敗する)。結合テスト `tests/integration/security/auth-login-lock.test.ts` (ローカルの Supabase で、DB の関数の権限・同時の加算・時間で戻る・本物の Auth と組み合わせて 25 回失敗してもロックしないこと)。
- **e2e** (`tests/e2e/auth-turnstile.spec.ts`): 本物のブラウザ・本物の CSP・本物の Cloudflare の `api.js` と、**Cloudflare のテスト用サイトキー** (`1x00000000000000000000AA`) で、ウィジェットがトークンを出し、新規登録・パスワード再設定・メール確認の再送 (#1474) では Supabase へのリクエストに `captcha_token` が、ログインでは `POST /api/auth/login` の本文に `captchaToken` が入ることを確かめる。通信はブラウザで差し替えるので、Supabase には繋がない。
  - 新規登録・メール確認の再送 (#1474)・`api.js` を読み込めないときのテストは、外のネットワークに繋がない (#1672)。テスト用サイトキーでも `api.js` と iframe は `challenges.cloudflare.com` から読むので、外の通信の遅れ・失敗で常設の e2e が落ちることがあった。この 3 つは `tests/e2e/helpers/turnstile-offline.ts` が `challenges.cloudflare.com` への通信をブラウザで手元の応答に差し替え、テスト用サイトキーが出すのと同じダミーのトークン (`XXXX.DUMMY.TOKEN.XXXX`) を出す (新規登録・再送では、それが Supabase へのリクエストに入ることを確かめる)。URL は本物と同じなので、CSP の判定はそのまま受ける。本物の `api.js` が CSP の下でトークンを出すことは、ログイン・パスワード再設定のテストが確かめる。
  - CI: `.github/workflows/e2e-local.yml` が、このテスト用サイトキーを付けてアプリをビルドし、この spec と `01-login.spec.ts` を回す。`01-login.spec.ts` は通信を差し替えず、ウィジェットがトークンを出すのを待ってから本物のサーバーでログインし、`POST /api/auth/login` の本文に `captchaToken` が付くことを確かめる。
  - これらの画面では、e2e は `networkidle` を待たない (ウィジェットが通信し続けるため成り立たない)。`tests/e2e/helpers/login-form.ts` の `waitForLoginFormReady` を使う (`src/__tests__/config/e2e-auth-page-wait.test.ts` が検査する)。
  - ローカル: `NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npx playwright test tests/e2e/auth-turnstile.spec.ts` (起動済みの dev サーバーは再利用されるので、キー無しで起動していたら止めてから)。
  - 実行するコマンドに、このテスト用サイトキー (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`) が付いていないとき (CI の `E2E_REQUIRE_TURNSTILE=1` を除く) は、この spec は全部スキップされる。本番のサイトキーを入れたあとの本番向け e2e (手動で回すフルスイート) で、本物のサイトキーに向けて走ってしまわないため。
  - サイトキー無しでビルドされたアプリ (Turnstile は無効) に向けても、全部スキップされる (CI だけは、スキップせずに失敗にする)。
- 本番を対象にした `e2e.yml` には、サイトキーを渡せない (起動済みのアプリには効かない)。

---

## 9. 知っておくこと

- **Cloudflare への通信が遮断される環境** (広告ブロッカー、企業のプロキシなど) では、ウィジェットが出せず、送信ボタンが押せないままになる。画面には、原因の見当と「もう一度確認する」ボタンが出る。Supabase の CAPTCHA が有効になっても、この環境ではどのみちログインできない。
- トークンの有効期限は 5 分で、1 回しか使えない。画面は、送信のたびに取り直し、期限が切れたら自動で取り直す。
- Google でのログイン・登録は CAPTCHA の対象外。
- Turnstile を有効にすると、ウィジェットを出す画面 (§1。3 画面と、メール確認の再送) で閲覧者の端末の情報が Cloudflare に送られる。プライバシーポリシー (`/privacy`) は v2026.1 (cross/20・#1901 の PR #1918) から、第7条の委託先と第10条の外部送信に Cloudflare (ボットの判定) を載せている (`src/lib/legal/privacy-text.ts`)。

---

## 10. オーナーにお願いしたいこと

- [ ] Cloudflare で Turnstile のウィジェット (Managed) を作り、**サイトキーと秘密キー**を発行する。ホスト名の許可は §5 のとおり
- [ ] Supabase ダッシュボードの**現在の設定値** (§3.1・§3.2) を、この文書の表に記入する
- [ ] Web の本番に入れる時期を決める (§6 手順 2)
- [ ] モバイルの新しいビルドを配り、**古いビルドが使われなくなる**のを待つ。実機での確認は §6 手順 3
- [x] 本番向け e2e・動作確認スクリプト (`--with-auth`)・Maestro 補助スクリプトのログインの対応を依頼する (§4 の「未対応」だった 2 つは #1474 で対応済み。e2e・`--with-auth`・Maestro 補助スクリプトの Supabase の直接の呼び出しは #1547 で対応済み)
- [ ] **Supabase で CAPTCHA を有効にする時期**を決める (§6 手順 5)
- [ ] プライバシーポリシーへの追記が要るか判断する (§9。いまのポリシーは v2026.1 から Cloudflare を載せている)

---

## 11. 運営の MFA (二段階認証) の運用

正典は `docs/design/cross/12-operator-mfa.md`。必須ロール (super_admin / admin / finance / org_industrial_doctor) は、認証アプリ (TOTP) の 6 桁を入れたセッション (aal2) でなければ運営の画面・API を使えない (#1176 / #1707)。

- **ダッシュボードの前提**: Supabase の Authentication → Multi-Factor で、TOTP の Enroll / Verify が有効であること (Supabase の既定は有効)。ローカルの Supabase は `scripts/supabase-local.sh` が組み立てる config.toml の `[auth.mfa.totp]` で有効にしている。
- **`OPERATOR_MFA_ENFORCE_FROM` の決め方**: 未設定なら、未登録の必須ロールは次のアクセスから登録を求められる (猶予なし)。運営に登録の期間を渡したいときは、ISO 8601 + タイムゾーンの日時 (例: `2026-11-01T00:00:00+09:00`) を入れる。その日時までは未登録でも運営の画面を使え、画面の上に期日のバナーが出る。登録済みの運営には効かない (常に 6 桁を求める)。形が違う値・存在しない日時は無視して猶予なしになる (警告のログを 1 回出す)。全員が登録したら消す。
- 別の super_admin の解除 (`/admin/users/{id}` の「二段階認証を解除」) は、対象の認証アプリとバックアップコードを消す前に、対象のすべての端末のログインを終える (SQL の関数 `operator_mfa_end_sessions`。cross/12 §11.5・§14.7)。対象はすべての端末で再ログインになる。DB (PostgREST) を直接呼ぶ経路だけは access token の期限 (Supabase の JWT の寿命の設定。既定 1 時間) まで残る (設計書 §0.3)
- **super_admin が 2 人とも認証アプリを使えなくなったとき (最後の手段)**: バックアップコードも無いときは、Supabase のダッシュボードの Authentication → Users → 対象の利用者 → MFA factors で factor を削除する。次のログインで登録を求められるので、登録し直す。⚠️ factor の削除だけでは、その利用者の既存のセッションは終わらない (2026-10-16 のローカルの GoTrue v2.183.0 の実測で、削除の前の aal1 のセッションが残った)。アプリの回復 (`/settings/security/mfa/recover`) は route が全セッションを終えるが、ダッシュボードの削除はそれをしない。6 桁を入れたセッション (aal2) が他の端末に残っていると、factor が消えてもそのセッションは運営の入口を通る (設計書 P-3) ので、端末の紛失・盗難が疑われるときは、登録し直した後にパスワードの再設定 (`/auth/reset-password`。すべての端末からログアウトする) を行う。
- **JWT の署名鍵が対称 (HS256) のプロジェクト**では、運営の要求ごとに `getClaims` が Auth へ 1 回問い合わせる (getUser と同程度)。非対称の鍵に移すとサーバーの中で確かめられる。
- **アプリ (ホームのタブの WebView で開く運営画面)** の猶予の扱いは Web と同じ。猶予中は未登録の必須ロールも通り (画面の上に期日のバナー)、猶予を過ぎると WebView の中の「ブラウザで登録」の案内で止まる (設計書 §16。アプリのネイティブの運営の区画は 2026-10-16 に削除したので、区画のゲートは無い)。
- **6 桁を入れるたびに (登録のときだけでなく毎回)、同じ人の他の端末・ブラウザの aal1 のセッションがログアウトされる**。例: Web で 6 桁を入れるとスマホのアプリが再ログインになる。アプリから防ぐ手段は無い (Supabase の verify の挙動。設計書 §26.3・S-25・Q-11)。
- **DB (PostgREST / RPC) を本人の JWT で直接呼ぶ経路**も、TOTP を登録済みの運営に aal2 を求める (段 E。migration `20261017130000_operator_mfa_db_gate.sql`・設計書 §11.4)。未登録の運営は DB では止めない (猶予を過ぎても登録しない運営は、Web の運営の画面が登録へ回す。設計書 §0.3)。
- **アプリのホームのタブ (WebView の `/admin`)** では 6 桁をアプリの確認画面で入れ、登録・回復・設定 (バックアップコードの再発行・認証アプリの解除) はブラウザで行う (設計書 §16.4)。アプリの確認画面は段 D の版から開くので、それより前のアプリでは、アプリの更新かブラウザを使う。
- バックアップコード (10 個・1 回だけ使える) は `/settings/security/mfa` で発行し直せる (6 桁を入れたセッションだけ)。発行し直すと古いコードはすべて使えなくなる。
