# ログイン・登録の守り — Supabase Auth の設定値と Cloudflare Turnstile (bot 対策)

> 作成: 2026-10-08 / 関連: Issue #1165 / オーナー判断: 2026-10-08 (決定キー 1165)
> 更新: 2026-10-10 — Web のログインのサーバー経由化 (`POST /api/auth/login`) と、ログイン失敗の回数によるボットの確認を追加 (§1・§2.1・§4〜§8)
> 更新: 2026-10-10 — ログイン失敗のロック (5 回で 15 分など) をやめた。失敗が続いたらボットの確認を求めるだけにした (§1・§2・§2.1・§5・§7・§8)
>
> この文書は 2 つのことを 1 か所にまとめる。
> 1. **いまの Supabase Auth の設定値の記録** (レート制限・攻撃対策)。「**オーナー記入**」と書いた欄は、Supabase のダッシュボードで見える現在の値を、オーナーが書き込む。
> 2. **Cloudflare Turnstile (bot 対策) を入れて、Supabase で有効にするまでの手順**。順番を間違えると、アプリのログインが止まる。

---

## 1. 決まっていること (要約)

| 項目 | 決定 |
|---|---|
| bot 対策の方式 | Cloudflare Turnstile (**Managed** モード)。ログイン・新規登録・パスワード再設定の 3 画面 |
| アカウントのロックアウト | しない (オーナーの選択 2026-10-10。他人のメールアドレスで失敗を繰り返すだけで本人を締め出せるため。失敗が続いたらボットの確認を求める) |
| ログインに続けて失敗したとき | 同じメールアドレスで **続けて 3 回以上** 失敗したら、次のログインからボットの確認 (Turnstile) を求める (§2.1)。Web のログイン (`POST /api/auth/login`) で働く。何回失敗しても、正しいパスワードならログインできる |
| いまのクールダウン | **残す**。ログインに失敗すると、同じメールアドレスでは 30 秒待つ (画面側の仕組み。Web は localStorage、アプリは AsyncStorage) |
| 入れる順番 | **Web が先、モバイルは次のビルド** |
| Supabase で CAPTCHA を有効にする時期 | **モバイルの新しいビルドを配って、古いビルドが使われなくなってから** (§6)。オーナーが決める |

### なぜ、すぐには Supabase で有効にしないのか

Supabase の CAPTCHA を有効にすると、ログイン・登録・パスワード再設定の API は、Turnstile のトークンが付いていないリクエストを**断る**ようになる。

- 今配られているモバイルのビルドは、トークンを付けられない。有効にした瞬間に、ログインも新規登録もできなくなる。
- 本番を対象にした e2e (`tests/e2e/global-setup.ts` など) は、Supabase の `/auth/v1/token?grant_type=password` を直接呼んでいる。トークンが無いので失敗する。デプロイ後の動作確認スクリプト (`--with-auth`) と Maestro の補助スクリプトも同じ (§4)。

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
- ロックをしないので、ロック中の応答 (423)・ロックの残り時間の案内・ロックの通知のメール (本人・運営)・ロックを外す API は無い。
- **ボットの確認が働かないもの**: モバイルのアプリのログイン (アプリはまだ Supabase を直接呼ぶ)、Supabase の Auth API を直接呼ぶ攻撃 (URL と anon key は公開されている)、Google ログイン。直接呼ぶ攻撃は、Supabase の CAPTCHA (§6 手順 5) とレート制限 (§3.1) で止める。
- DB には、ロックがあったころの列 (`auth_login_failures.locked_until`) と関数 (`auth_login_lock_status`・`auth_login_record_failure`・`auth_login_apply_lock`・`auth_login_account_user_id`) が残っている。アプリからは呼ばない。消すかどうかは別に決める (関数・列の削除になるため)。

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
| 多要素認証 (MFA) の challenge / verify | `/factors/:id/challenge` `/factors/:id/verify` | IP アドレスごと・1 分あたり | 15 回 (変更不可) | 変更できないので記入は不要 (このアプリは MFA を使っていない) |
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
| **メール確認の再送** (`/auth/verify`) | `resend` | **未対応** | (モバイルに再送の画面は無い) |
| **設定 → アカウント → パスワード変更の本人確認** | `signInWithPassword` | **未対応** (`src/app/(main)/settings/account/page.tsx`) | (モバイルに同等の処理は無い) |
| 新しいパスワードの保存 (`/auth/reset-password`) | `updateUser` | CAPTCHA の対象外 | CAPTCHA の対象外 |

**「未対応」の 2 つは、Supabase で CAPTCHA を有効にすると動かなくなる** (トークンを付けていないため)。有効にする前に、トークンを付ける対応が要る (§6 の手順 4)。今回の PR の範囲外。

そのほか、CAPTCHA を有効にすると動かなくなるもの:

- 本番 (Supabase の本番プロジェクト) を対象にした e2e のログイン (`tests/e2e/global-setup.ts`、`tests/e2e/fixtures/auth.ts` など。Supabase の REST を直接呼ぶ)。有効にするのと同時に、トークンが要らない方法 (管理 API でセッションを作るなど) へ変える。
- **デプロイ後の動作確認スクリプトの `--with-auth`** (`npm run test:smoke -- --with-auth`、本体は `scripts/lib/smoke.mjs`)。テストユーザーで Supabase の `/auth/v1/token?grant_type=password` を直接呼ぶので、トークンが無く断られ、「ログインに失敗しました」と報告されて確認全体が失敗 (終了コード 1) になる。有効にするのと同時に、`--with-auth` を使わない運用 (未ログインで叩ける範囲だけの確認) にするか、トークンが要らない方法へ変える。`--with-auth` を付けない通常の確認は影響しない。
- **Maestro (モバイルの e2e) の補助スクリプト** `apps/mobile/maestro/flows/scripts/reset-onboarding.js`。同じく Supabase のパスワードログインを直接呼ぶので、有効にすると失敗する。e2e と同じ扱いで直す。
- 結合テスト (`tests/integration/`) は、ローカルの Supabase (CAPTCHA は常に無効) に向けて動くので影響しない。

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
- 設定すると、3 画面にウィジェットが出て、**確認が終わるまで送信ボタンが押せなくなる**。
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
- [ ] §4 の「未対応」の 2 つ (メール確認の再送、設定画面のパスワード変更の本人確認) に、トークンを付ける対応が入った
- [ ] 本番向け e2e のログインを、トークンが要らない方法へ変えた (§4)
- [ ] デプロイ後の動作確認スクリプトの `--with-auth` (`scripts/lib/smoke.mjs`) と、Maestro の補助スクリプト (`apps/mobile/maestro/flows/scripts/reset-onboarding.js`) を、トークンが要らない方法へ変えた、または使わない運用にした (§4)
- [ ] Web の本番に `NEXT_PUBLIC_TURNSTILE_SITE_KEY` が入っていて、3 画面で動いている
- [ ] ロールバック手順 (§7) を読んだ

### 手順 5. Supabase で CAPTCHA を有効にする

0. Vercel に `TURNSTILE_SECRET_KEY` を入れている (手順 2 の 5) なら、先に**削除して再デプロイ**する (このアプリのサーバーと Supabase が同じトークンを 2 回確かめると、2 回目が「使用済み」で断られる)。
1. Supabase ダッシュボード → Authentication → Attack Protection (Bot and Abuse Protection) → **Enable CAPTCHA protection**。
2. プロバイダーに **Cloudflare Turnstile** を選び、**秘密キー**を入れて保存する。
3. 保存した直後から、トークンの無いリクエストは断られる。

### 手順 6. 有効にした直後の確認

- Web の 3 画面で、ログイン・登録・パスワード再設定が通る。
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
- **単体テスト** (`tests/auth-turnstile-widget.test.tsx`、`tests/auth-turnstile-pages.test.tsx`): ウィジェットの動き、3 画面が Supabase の**正しい場所**にトークンを付けること、「トークンが無い間は送信ボタンが押せない」こと。モバイルは `apps/mobile/__tests__/`。
  - 注意: `resetPasswordForEmail` だけは、`captchaToken` を `options` の中ではなく**第 2 引数の直下** (`redirectTo` と同じ階層) に渡す。`options` の中に入れても、Supabase には届かず、黙って無視される。
- **ログインに続けて失敗したとき (ロックしない)**: 単体テスト `tests/auth/login-failures.test.ts` (回数 → ボットの確認の決定表・時間で戻る・環境変数)・`tests/auth/guarded-login.test.ts` (状態 × 操作の表。何回失敗しても正しいパスワードならログインできる)・`tests/api/auth-login-route.test.ts` (応答の表。何回失敗しても 423 にならない)・`tests/auth/turnstile-verify.test.ts`。回帰テスト `tests/auth/no-login-lockout.test.ts` (ロックの応答・ロックの DB の関数・ロックを外す API がコードに戻ってきたら失敗する)。結合テスト `tests/integration/security/auth-login-lock.test.ts` (ローカルの Supabase で、DB の関数の権限・同時の加算・時間で戻る・本物の Auth と組み合わせて 25 回失敗してもロックしないこと)。
- **e2e** (`tests/e2e/auth-turnstile.spec.ts`): 本物のブラウザ・本物の CSP・本物の Cloudflare の `api.js` と、**Cloudflare のテスト用サイトキー** (`1x00000000000000000000AA`) で、ウィジェットがトークンを出し、新規登録・パスワード再設定では Supabase へのリクエストに `captcha_token` が、ログインでは `POST /api/auth/login` の本文に `captchaToken` が入ることを確かめる。通信はブラウザで差し替えるので、Supabase には繋がない。
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
- Turnstile を有効にすると、3 画面で閲覧者の端末の情報が Cloudflare に送られる。**プライバシーポリシー (`/privacy`) への追記が要るか**は、オーナー (法務) の判断。このリポジトリのコードでは変えていない。

---

## 10. オーナーにお願いしたいこと

- [ ] Cloudflare で Turnstile のウィジェット (Managed) を作り、**サイトキーと秘密キー**を発行する。ホスト名の許可は §5 のとおり
- [ ] Supabase ダッシュボードの**現在の設定値** (§3.1・§3.2) を、この文書の表に記入する
- [ ] Web の本番に入れる時期を決める (§6 手順 2)
- [ ] モバイルの新しいビルドを配り、**古いビルドが使われなくなる**のを待つ。実機での確認は §6 手順 3
- [ ] §4 の「未対応」の 2 つと、本番向け e2e・動作確認スクリプト (`--with-auth`)・Maestro 補助スクリプトのログインの対応を依頼する
- [ ] **Supabase で CAPTCHA を有効にする時期**を決める (§6 手順 5)
- [ ] プライバシーポリシーへの追記が要るか判断する (§9)
