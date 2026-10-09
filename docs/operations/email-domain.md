# メールの送信元・問い合わせ先・サイトの URL を homegohan.com にそろえる手順 (#1194)

「ほめゴハンが出すメール」「問い合わせ先のアドレス」「サイトの URL」を、`homegohan.com` にそろえるための手順です。
**コードの変更は要りません。** 値は `src/lib/site-config.ts` (モバイルは `apps/mobile/src/lib/siteConfig.ts`) の 1 か所にまとめてあり、環境変数を設定するだけで切り替わります。
この文書の「オーナーの作業」は、ドメインの契約者であるオーナーにしかできない作業 (DNS・各サービスの管理画面) です。

---

## 1. いまの状態 (2026-10-08 に確認)

### コードの既定値 (環境変数を設定していないとき)

| もの | 既定値 | 実態 |
|---|---|---|
| サイトの URL | `https://homegohan-app.vercel.app` | アプリが実際に動いている URL |
| メールの送信元 | `ほめゴハン <noreply@homegohan.app>` | `homegohan.app` は DNS に存在しない。Resend で検証できないので、**本番ではメールが 1 通も届かない** |
| 問い合わせ先 | `support@homegohan.app` | 同上。このアドレスには届かない |

以前は、メールの文面 14 本・お問い合わせ API・招待画面・ページのメタ情報・`robots.txt`・モバイルの設定画面に、
`.app` / `.jp` / `.com` のドメインが別々に直接書かれていました。いまは上の 3 つに集約し、環境変数で上書きします。

### 各ドメインの DNS (公開情報を `dig` 相当で確認した結果)

| ドメイン | 状態 |
|---|---|
| `homegohan.app` / `homegohan.jp` | **DNS に存在しない** (NXDOMAIN)。メールもサイトも成り立たない |
| `homegohan.com` のメール (MX) | Microsoft 365 (`homegohan-com.mail.protection.outlook.com`) |
| `homegohan.com` の SPF | `v=spf1 include:spf.protection.outlook.com -all` (Microsoft 365 だけを許可) |
| `homegohan.com` の DMARC (`_dmarc`) | **なし** |
| `homegohan.com` の Microsoft 365 の DKIM (`selector1/2._domainkey`) | **なし** (未設定) |
| `homegohan.com` の Resend 用レコード | **なし** |
| `homegohan.com` のネームサーバー | `01〜04.dnsv.jp` (DNS の変更はこの管理画面で行う) |
| `homegohan.com` の Web (A レコード) | 別のサービスを指している (Replit の確認用 TXT あり)。**ほめゴハンのサイトではない** |

### メールが届かなくても壊れないこと

メールは「届けば便利」な通知で、届くことに依存する処理はありません。送信に失敗しても処理は止まらず、失敗は記録されます。

- 招待 (家族・組織): 招待そのものは作られ、招待リンク (`invite_url`) は API の応答にも含まれます (メールが届かなくても、招待した人がリンクを直接渡せます)。
- お問い合わせ: 内容は DB に保存されます。管理者への通知メールだけが届きません。
- サポートの返信: 返信メッセージは保存され、メールの結果 (`skipped` / `failed`) が管理画面に出ます。
- 失敗の記録: Resend の断り (例: `The … domain is not verified`) は `EMAIL_SEND_FAILED: …` として呼び出し側のログ (`app_logs` または Vercel のログ) に残ります。

---

## 2. 設定する環境変数

### Web (Vercel の Production)

| 環境変数 | 例 | 役割 | 反映 |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://homegohan.com` | サイトの URL。メールの中のリンク、招待・譲渡のリンク、ページの OGP / canonical、`robots.txt` の Sitemap の基点 | **再デプロイが必要** (ビルド時に埋め込まれる) |
| `EMAIL_FROM` | `ほめゴハン <noreply@mail.homegohan.com>` | メールの送信元 (From)。**Resend で検証済みのドメイン**にする | 再デプロイ |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | `support@homegohan.com` | 問い合わせ先。メールの文面、お問い合わせ画面、プライバシーポリシー、招待画面に出る | **再デプロイが必要** (ビルド時に埋め込まれる) |
| `SUPPORT_REPLY_TO` (任意) | `support@homegohan.com` | サポートの返信メールの「返信先」。受信箱ができたら設定する。未設定ならメールは送信専用のままで、本文でお問い合わせフォームへ案内する | 再デプロイ |
| `ADMIN_NOTIFICATION_EMAIL` (既存) | `support@homegohan.com` など | お問い合わせが届いたときの、管理者への通知の宛先 | 再デプロイ |
| `OPS_ALERT_EMAIL` | `ops@homegohan.com` など (個人のアドレスでもよい) | アプリのエラーが急増したときの運用メールの宛先 (メールアドレス 1 つ。#1157)。**未設定なら通知しない**。送信ドメインの検証 (手順 1) が済むまでは、設定しても届かない | 再デプロイ |
| `NEXT_PUBLIC_INVITE_BASE_URL` | (**削除する**) | 以前の招待リンク専用の設定。**設定が残っていると、`NEXT_PUBLIC_APP_URL` より優先される**ので、サイトの URL を変えても招待リンクだけ古いままになる | 再デプロイ |

- 値が不正 (URL やメールアドレスの形になっていない) なときは、無視して既定値に戻り、Vercel の関数ログに `[site-config] … の形が正しくないため無視して既定値を使います` と 1 回だけ警告が出ます。
- 空にしても (値を消さずに空欄で保存しても) 未設定と同じ扱いです。
- Preview 環境には設定しない (設定しない場合は既定値が使われ、本番の URL を指します)。

### モバイル (EAS のビルド環境。ビルド時に埋め込まれる)

| 環境変数 | 例 | 役割 |
|---|---|---|
| `EXPO_PUBLIC_SUPPORT_EMAIL` | `support@homegohan.com` | 設定画面・プロフィール画面の「お問い合わせ」の宛先 |
| `EXPO_PUBLIC_WEB_URL` | `https://homegohan.com` | WebView が開くサイトの URL。設定画面の「利用規約」「プライバシーポリシー」も同じ URL の `/terms` `/privacy` を開く。**サイトを homegohan.com に移した後にだけ設定する** (§4 の手順 6) |

どちらも、設定したあと**アプリをビルドし直して**配布するまで反映されません。

### Supabase の Edge Function (任意)

`ALLOWED_ORIGINS` (Edge Function の Secret): ブラウザから Edge Function を直接呼ぶ処理は今はありません。呼ぶ処理を足すときだけ、
`https://homegohan.com,https://homegohan-app.vercel.app` のようにサイトの URL を足します (詳細は `ENV_SETUP.md`)。

---

## 3. 「メール」と「サイト」は別々に切り替えられる

| 切り替え | 設定するもの | 前提 |
|---|---|---|
| **A. メールだけ homegohan.com にする** | `EMAIL_FROM` `NEXT_PUBLIC_SUPPORT_EMAIL` (`SUPPORT_REPLY_TO`) | Resend の送信ドメインの検証 + `support@` の受信箱 |
| **B. サイトも homegohan.com に移す** | `NEXT_PUBLIC_APP_URL` (`NEXT_PUBLIC_INVITE_BASE_URL` を削除) + Vercel / Supabase / Google の URL 設定 | `homegohan.com` の A レコードを Vercel に向けられる |

- **A だけを先に行ってかまいません。** そのとき `NEXT_PUBLIC_APP_URL` は変えません (サイトの URL は `homegohan-app.vercel.app` のまま)。
  今は `homegohan.com` の A レコードが別のサービスを指しているので、`NEXT_PUBLIC_APP_URL=https://homegohan.com` にすると、メールのリンクが全部別のサービスへ飛んでしまいます。
- **B は、`https://homegohan.com/login` がほめゴハンのログイン画面として開くことを確かめてから**行います。

---

## 4. 手順 (オーナーの作業)

画面の表記や項目名は、各サービスが変えることがあります。違っていたら各サービスの最新のドキュメントを正としてください。

### 手順 0: 先に決める・確かめる

1. `homegohan.com` の登録者 (レジストラの契約者) が、オーナー本人であることを確かめる。
2. サイトも `homegohan.com` に移すか (B をやるか) を決める。移さないなら、手順 5・6 は不要。
3. `support@homegohan.com` の受信箱 (Microsoft 365 の共有メールボックスかエイリアス) を作り、実際にメールが届くことを確かめる。
4. DMARC のレポートを受け取るアドレスを決める (例: `dmarc@homegohan.com`。`support@` とは別にすると読みやすい)。

### 手順 1: Resend で送信ドメインを検証する (A)

1. Resend の管理画面 → Domains → Add Domain で、**送信専用のサブドメイン `mail.homegohan.com`** を追加する。
   - `homegohan.com` 本体ではなくサブドメインにする理由: 本体にはすでに Microsoft 365 の受信 (MX) と SPF があり、Resend のレコードと混ざるとどちらかが壊れやすいため。サブドメインなら、受信側に一切触れずに済みます。
2. Resend が表示する DNS レコードを、**表示されたとおりに** DNS (ネームサーバー側の管理画面) へ登録する。形の目安は次のとおり (ホスト名・値は Resend の画面が正。推測や別のドメインの値は使わない):

   | 種類 | ホスト名 (`mail.homegohan.com` を登録した場合) | 役割 |
   |---|---|---|
   | TXT | `resend._domainkey.mail` | **DKIM**: メールが改ざんされていないことを証明する署名の公開鍵 (`p=…`) |
   | MX | `send.mail` (優先度 10。向き先は `feedback-smtp.….amazonses.com`) | **Return-Path**: 届かなかったメールの通知 (バウンス) の受け取り先 |
   | TXT | `send.mail` (`v=spf1 include:amazonses.com ~all`) | **SPF**: このドメインからメールを送ってよいサーバーの宣言 |

   - DNS の管理画面によっては、ホスト名にドメイン名を自動でつなげます (その場合は `resend._domainkey.mail` と入れる)。つなげない場合は `resend._domainkey.mail.homegohan.com` と全部入れます。
   - `homegohan.com` 本体の MX・SPF (Microsoft 365) は**変更しない**。
3. Resend の画面で Verify を押し、`Verified` になるまで待つ (数分〜数時間。長いと 72 時間)。
4. 登録できたか、次のコマンドで確かめる (DNS を引くだけで、何も書き換えない):

   ```bash
   node scripts/check-email-dns.mjs --from "ほめゴハン <noreply@mail.homegohan.com>"
   ```

   `[FAIL]` が無くなるまで直す。`[WARN] DMARC がありません` は次の手順で直す。設定直後で古い答えが返るときは `--server 1.1.1.1` を付けて別の DNS サーバーに聞く。

### 手順 2: DMARC を登録する (A)

DMARC は「SPF・DKIM を通らないメールをどう扱うか」を受信側に伝える仕組みです。なりすまし対策と、迷惑メール扱いされにくくするために入れます。
**最初は監視だけ (`p=none`) で入れ、2〜4 週間レポートを見て、段階的に強めます。** いきなり強くすると、正当なメールまで捨てられるおそれがあります。

1. `_dmarc.homegohan.com` に TXT を登録する:

   ```
   v=DMARC1; p=none; rua=mailto:dmarc@homegohan.com
   ```

   `homegohan.com` には今、DMARC がありません。すでに誰かが登録していたら、新しく作らずその内容を直します (TXT の `v=DMARC1` は 1 つだけ)。
2. 2〜4 週間、届くレポート (XML。読みにくいので、無料の DMARC レポート解析サービスを使ってもよい) で、**Resend (`mail.homegohan.com`) と Microsoft 365 の両方**が SPF か DKIM を通っていることを確かめる。
3. 通っていれば `p=quarantine; pct=25` → `pct=100` → `p=reject` の順に、数週間ずつ空けて強める。
4. 余裕があれば、Microsoft 365 の DKIM (`selector1/2._domainkey` の CNAME。Microsoft 365 の管理センターで有効化) も入れる。今は SPF だけで通っているので必須ではありませんが、DKIM があると転送されたメールも通りやすくなります。

### 手順 3: Vercel の環境変数を設定して再デプロイする (A)

Vercel → Project → Settings → Environment Variables (Environment は **Production**) に設定する:

- `EMAIL_FROM` = `ほめゴハン <noreply@mail.homegohan.com>`
- `NEXT_PUBLIC_SUPPORT_EMAIL` = `support@homegohan.com`
- (任意) `SUPPORT_REPLY_TO` = `support@homegohan.com`
- (必要なら) `ADMIN_NOTIFICATION_EMAIL`

そのあと **Redeploy** する (Deployments → 最新のデプロイ → Redeploy。不安なら "Use existing Build Cache" のチェックを外す)。
`NEXT_PUBLIC_` で始まる値はビルド時に埋め込まれるので、再デプロイしないと画面に出ません。

### 手順 4: Supabase の認証メールを Resend 経由にする (A)

サインアップの確認メール・パスワード再設定メールは、アプリのコードではなく **Supabase が送ります**。上の `EMAIL_FROM` は効きません。

Supabase → Authentication → (Emails の) SMTP Settings で Custom SMTP を有効にして設定する:

| 項目 | 値 |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Resend の API キー (**Supabase の画面にだけ入力する。Issue・PR・チャット・リポジトリに書かない**) |
| Sender email | `noreply@mail.homegohan.com` |
| Sender name | `ほめゴハン` |

Supabase が最初から持っている送信は、本番で使うには送信数の上限が厳しく、送信元も Supabase のものです。

### 手順 5: サイトを homegohan.com に移す (B。移すときだけ)

1. Vercel → Project → Settings → Domains で `homegohan.com` を追加し、Vercel が表示する A / CNAME レコードを DNS に登録する。**MX・TXT など、メールのレコードには触らない。** `homegohan-app.vercel.app` は**外さない** (§5)。
2. `https://homegohan.com/login` がほめゴハンのログイン画面として開くことを確かめる。
3. Vercel の環境変数 (Production): `NEXT_PUBLIC_APP_URL` = `https://homegohan.com` を設定し、**`NEXT_PUBLIC_INVITE_BASE_URL` を削除**して、再デプロイする。
4. Supabase → Authentication → URL Configuration:
   - Site URL = `https://homegohan.com`
   - Redirect URLs に `https://homegohan.com/**` を**追加**する。`https://homegohan-app.vercel.app/**` と `homegohan://**` (モバイルアプリ) は**残す**。アプリのログイン・パスワード再設定は、そのとき開いているサイト (`window.location.origin`) へ戻る作りで、古いアドレスから来る人もいるため。
5. Google Cloud Console → OAuth クライアントの「承認済みの JavaScript 生成元」に `https://homegohan.com` を追加する。「承認済みのリダイレクト URI」は Supabase のコールバック (`https://<プロジェクト>.supabase.co/auth/v1/callback`) のままで変更しない。

### 手順 6: モバイルアプリ (B。サイトを移した後)

EAS のビルド環境に `EXPO_PUBLIC_WEB_URL=https://homegohan.com` と `EXPO_PUBLIC_SUPPORT_EMAIL=support@homegohan.com` を設定して、新しいビルドを出す。
サイトを移さない (A だけの) 場合は `EXPO_PUBLIC_SUPPORT_EMAIL` だけを設定します。

---

## 5. 古いアプリのビルドを壊さない (重要)

すでに配布されているアプリのビルドは、**`https://homegohan-app.vercel.app` を WebView で開くよう固定**されています (`apps/mobile/src/lib/webBaseUrl.ts` の既定値)。
さらに、WebView を自分のサイトのオリジンに固定する変更 (PR #1289) が入る予定です。

- `homegohan-app.vercel.app` を**止めない・Vercel から外さない・`homegohan.com` へリダイレクトしない**。古いビルドを使う人がいなくなったと確認できるまで、両方のアドレスで同じサイトを返し続ける。
- 確認できる前にリダイレクトすると、古いビルドが「別のサイトへ飛ばされた」と判断して表示できなくなるおそれがあります。
- Supabase の Redirect URLs・`ALLOWED_ORIGINS` から `homegohan-app.vercel.app` を消すのも、同じ条件が整うまで待つ。

---

## 6. 切り替えた後の確認

- `node scripts/check-email-dns.mjs --from "<EMAIL_FROM の値>"` で `[FAIL]` が無い。
- 本番のお問い合わせフォームから送ると、`ADMIN_NOTIFICATION_EMAIL` に通知が届く (送信元が `noreply@mail.homegohan.com`)。
- 家族の招待を自分のアドレス宛に送ると届き、本文の問い合わせ先・署名の URL が新しい値になっている。
- (`OPS_ALERT_EMAIL` を設定した場合) エラー急増の運用メール (件名「【ほめゴハン運用】エラーが急増しています」) が届く。しきい値 (15 分で 20 件) を超えないと送られないので、確認だけのために手で cron を叩くときは `ENV_SETUP.md` の「エラー急増の運用メール」の注意を読む。
- 届いたメールの「メッセージのソース」(Gmail なら「メッセージのソースを表示」) で、`SPF: PASS` `DKIM: PASS` `DMARC: PASS` になっている。
- 迷惑メールフォルダに入っていない。
- プライバシーポリシー (`/privacy`)・お問い合わせ (`/contact`)・招待画面の問い合わせ先が `support@homegohan.com` になっている。
- Vercel の関数ログ / `app_logs` に `EMAIL_SEND_FAILED` や `[site-config]` の警告が出ていない。

## 7. 元に戻すには

Vercel の環境変数 (`EMAIL_FROM` `NEXT_PUBLIC_SUPPORT_EMAIL` `NEXT_PUBLIC_APP_URL` `SUPPORT_REPLY_TO`) を**削除**して再デプロイすると、既定値 (今の値) に戻ります。コードの変更は要りません。
DNS のレコード (Resend・DMARC) は残しておいてかまいません。

## 8. つまずきやすいところ

| 症状 | 原因と対処 |
|---|---|
| メールが送れず `The … domain is not verified` が記録される | `EMAIL_FROM` のドメインが Resend で未検証。手順 1 を完了するか、`EMAIL_FROM` を検証済みのドメインにする |
| 環境変数を変えたのに画面が変わらない | `NEXT_PUBLIC_` の値はビルド時に埋め込まれる。再デプロイする |
| 招待のリンクだけ古いホストのまま | `NEXT_PUBLIC_INVITE_BASE_URL` が残っている。削除して再デプロイする |
| メールのリンクが別のサービスに飛ぶ | `NEXT_PUBLIC_APP_URL` を `homegohan.com` にしたが、A レコードがまだほめゴハンを指していない。手順 5 の 1〜2 を先に |
| SPF のエラー (permerror) | 1 つのホスト名に `v=spf1` の TXT が 2 つ以上ある。1 つにまとめる (`check-email-dns.mjs` が検出する) |
| 認証メール (サインアップ確認) の送信元が Resend のものにならない | 手順 4 の Supabase の Custom SMTP が未設定。`EMAIL_FROM` は認証メールには効かない |
| `[site-config] … の形が正しくないため無視して既定値を使います` | 環境変数の書き方の誤り。`NEXT_PUBLIC_APP_URL` は `https://` から、`EMAIL_FROM` は `ほめゴハン <noreply@mail.homegohan.com>` の形で書く |
| 本番で `NEXT_PUBLIC_APP_URL` に `http://localhost:3000` を入れているのに、メールのリンクが `homegohan-app.vercel.app` になる | Vercel の本番では localhost の URL は使わない仕組みになっている (開発用の値を本番に登録してしまっても、リンクが壊れないようにするため)。本番の環境変数は、公開されているサイトの URL にする |

## 9. この手順の範囲外 (別の Issue)

- 送信失敗のリトライ・失敗の保存 (#1193)
- Resend のバウンス・苦情の受信と、送信の抑制 (#1184)
- 運営会社・特定商取引法の事業者情報 (#1155)

---

## コード側の仕組み (開発者向け)

- Web: `src/lib/site-config.ts` の `getSiteUrl()` / `getEmailFrom()` / `getSupportEmail()` だけがドメインを決める。メールの共通部品は `src/lib/emails/common.ts` (署名) と `src/lib/emails/envelope.ts` (メールの形。送信元の既定値を含む)。招待・譲渡のリンクは `src/lib/membership/urls.ts`。
- モバイル: `apps/mobile/src/lib/siteConfig.ts` (問い合わせ先・利用規約・プライバシーポリシー)。WebView のオリジンは従来どおり `apps/mobile/src/lib/webBaseUrl.ts`。
- `tests/site-config-guard.test.ts` が、`src/` と `apps/mobile/` に `@homegohan.app` `@homegohan.jp` `https://homegohan.app` が直接書かれていないことを検査する。許すのは既定値の定数と、それを固定するテストだけ。
  - 例外が 1 つ残っている: `src/app/(main)/settings/page.tsx` (PR #1079 が設定画面を別ファイルに移す。移した先で `getSupportEmail()` にして、テストの `PENDING_FILES` から外す)。
- 設計書 (`docs/design/membership/04-email-templates.md` など) の `homegohan.app` は設計時の値で、実装の正は上記のコードと環境変数です。
