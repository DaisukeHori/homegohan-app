# モバイル 認証・セッション・push token の扱い

> 版: v1.2。改定履歴: v1.0 Issue #1038 (F7-04〜F7-10) の整理。v1.1 2026-10-17 Issue #1768: `@supabase/supabase-js` 2.117.3 と `@supabase/ssr` 0.12.7 への更新に合わせ、借り物のセッションを捨てる合図 (§6.1・§6.3) を auth-js 2.117 の挙動 (access token が有効なうちの先回りの更新の失敗ではセッションを捨てず `SIGNED_OUT` も出さない) で決め直し、§3・§5・§7 の auth-js の版に依る記述を現在形にし、§0 (範囲と分冊判定) と §9 (更新の設計: 要件・シナリオとトレース・構造裁定・表 3 点・Cookie の読み書きの移行・テストの直し方・apps/mobile の版・段分け・番兵と他の文書の追随表) を足した。 v1.1 の後の追記: #1720 段 B (2026-10-17。§3.1 端末名の登録)・#1812 (2026-10-17。§6.2 の開き直す画面に `/settings/data-requests` を足し、§9 の表の `app/settings/account.tsx` の行番号を追随)。v1.2 2026-10-18 実装の追随の記録: #1720 段 C (パスワードの変更・再設定が API 経由になった) に合わせて §3 の掃除の表の「パスワード再設定のあと」の利用者・§9.1 の auth の呼び出しの閉包 (W-1・W-6・W-9・M-1・M-3・M-4・M-8 と合計)・§9.6 ① の scope `others` の行を直し、§9.15 の Dependabot #1590 の行を事実に直した。設計の判断は変えない。

## 0. 改定 #1768 の範囲と分冊判定 (v1.1)

範囲の正本は Issue #1768 の本文 (関連: #1621・Dependabot #1590)。`@supabase/supabase-js` を 2.105.3 から 2.117.3 へ、`@supabase/ssr` を 0.1.0 から 0.12.7 へ上げるために、本書の §6.1・§6.3 の前提 (借り物のセッションを捨てる合図) を 2.117 の挙動に合わせて改め、Cookie の読み書き (ssr 0.12 の `getAll` / `setAll`) への移行・赤になる既存テストの直し方・apps/mobile の版・段分けを §9 に書く。§6.1・§6.3 は改定後の本文で、§9 は実装者が手を止めずに実装できる粒度の設計。

分冊判定: **1 冊** (核と配線に分けない)。本書は改定後に約 1,200 行で 800 行を超え、消費先 (Web の Supabase の呼び出し口 3 ファイルと proxy・テスト・apps/mobile の `package.json`) も 3 を超える (判定のトリガーに当たる) が、変更は「依存の版を上げる」1 つの操作に閉じていて分けられない。ssr 0.12.7 は peer に `@supabase/supabase-js` `^2.114.0` を要る (npm の 0.12.7 の `peerDependencies`) ので 2 つは同時に上げる。`getAll` / `setAll` は ssr 0.1.0 に無く (0.1.0 の `dist/index.js:253-339` は `get` / `set` / `remove` だけを見る)、赤になるテストは 2.117 の挙動で初めて意味を持つので、版を上げる PR と同じ PR で直す。共有面 (`package-lock.json`・`lib/supabase/*`) に触るのはこの 1 本の PR だけ (§9.13)。

## 1. 目的・スコープ

モバイルアプリの認証まわり (セッションの保管、起動時の復元、Google ログイン、WebView との状態の食い違い、push token) の設計。Apple のログイン (iOS のネイティブのシート・Web の OAuth) は `08-sign-in-with-apple.md`。
Issue #1038 (F7-04〜F7-10) の修正に合わせて整理した。

`01-architecture.md` の「3.3 セッション同期」は、この文書の内容で置き換わる部分がある (特に、セッションの保管先と、`session-expired` の向き)。
WebView の認証ブリッジそのもの (ワンタイムコード方式、オリジンの固定) は #1036 / #1158 (`webViewBridge.ts`) の担当で、ここでは扱わない。

| 項目 | 内容 | 実装 |
|------|------|------|
| F7-06 | セッションを平文の AsyncStorage ではなく、端末の安全な保管庫に置く | `src/lib/secureSessionStorage.ts` / `src/lib/supabase.ts` |
| F7-07 | オフライン起動でログイン済みのユーザーをウェルカム画面に落とさない | `src/providers/AuthProvider.tsx` / `src/lib/authErrors.ts` |
| F7-08 | Google ログインのコールバック URL を捨てない。成功と誤表示しない | `app/(auth)/login.tsx` / `app/(auth)/auth/verify.tsx` / `src/lib/authLink.ts` |
| F7-09 | push token の登録が、展開されなかった `$VAR` で静かに失敗しない | `eas.json` / `src/lib/pushNotifications.ts` |
| F7-10 | ログアウトで、この端末の push token を `user_push_tokens` から消す | `src/lib/signOut.ts` / `src/lib/pushNotifications.ts` |
| F7-04 | Web (WebView) でログアウトしたら、ネイティブもログアウトする | `src/lib/webViewAuthMessages.ts` / Web: `src/lib/native-auth-bridge.ts` |
| F7-05 | Web とネイティブが同じ refresh_token を別々に更新して、セッションごと失効するのを防ぐ | 同上 / Web: `native-bridge/route.ts`, `NativeSessionWatcher.tsx` |

## 2. セッションの保管 (F7-06)

Supabase のセッション (access_token と refresh_token) は、iOS Keychain / Android Keystore に置く (`expo-secure-store`)。
以前は AsyncStorage (平文) に置いていた。refresh_token は長期間有効なログイン権限なので、バックアップやファイルの読み取りで見えてはいけない。

- expo-secure-store は 1 つの値を 2048 バイトまでに制限する (超えると警告。将来の SDK ではエラーになり得る)。セッションは 3〜5KB なので、値を小さく分けて保存する
  - `<key>` に目次 `v1.<世代>.<断片数>`、`<key>.<世代>.<番号>` に断片
  - 書き込みは「新しい世代の断片 → 目次 → 古い世代の削除」の順。途中で失敗しても、読み手は古い世代をそのまま読める
- Supabase 公式ドキュメントの「乱数鍵を SecureStore、暗号化したセッションを AsyncStorage」方式は採らなかった。暗号ライブラリ (aes-js) と乱数のネイティブモジュールが増え、認証タグの無い AES-CTR を自前で持つことになる。OS の保管庫に直接置くほうが部品が少ない
- 読み取りのたびに保管庫へ問い合わせず、メモリにも持つ (`getSession()` は API 呼び出しごとに走る)
- 移行: 旧バージョンが AsyncStorage に保存した平文のセッションは、最初に読んだときに保管庫へ移して AsyncStorage から消す。ログアウトされない
- 保管庫に書けない端末 (Keystore の破損など) では、ログインできなくならないよう AsyncStorage に退避する (次に読んだときに移行を再試行する)
- 保管庫に書けたのに平文の削除だけが失敗すると、平文には使用済み (ローテーション済み) の古いセッションが残る。AsyncStorage に値があるときは、
  セッションの有効期限 (`expires_at`) を保管庫の値と比べ、**保管庫のほうが新しければ保管庫を採って平文を消す**。古い平文で新しい値を上書きすると、
  使用済みの refresh_token をサーバーが再利用とみなして、セッションごと失効し得るため。比べられない値 (PKCE の code-verifier など) は、これまでどおり平文を採る
- **iOS の Keychain はアプリを削除しても残る**。AsyncStorage に「入っている」印を置き、印が無いのに保管庫に値があれば再インストールの残りとみなして消す。前のユーザーのセッションが復活しない
- 保存キーは supabase-js の既定 (`sb-<ref>-auth-token`) のまま

## 3. 起動時のセッション復元 (F7-07)

`AuthProvider` は起動時に保存済みのセッションをサーバーで検証する。**サーバーが失効と明言したときだけ**捨てる。

| `getUser()` のエラー | 扱い |
|---|---|
| 401 / 403、`session_not_found`、`user_not_found`、`refresh_token_not_found` など | 通常のログアウトと同じ掃除 (`clearUserScopedLocalData`。失効したセッションの利用者の ID で) を先に通してから、セッションを捨てる (`signOut({ scope: 'local' })`) |
| `AuthRetryableFetchError`、status 0 / 408 / 429 / 5xx、fetch の例外 | 保存済みのセッションを信頼して起動する |
| 上記以外 | 失効を確認できていないので、捨てない |

未ログインになるどの経路でも、通常のログアウトと同じ掃除 (`apps/mobile/src/lib/userScopedLocalData.ts` の `clearUserScopedLocalData`。AsyncStorage の利用者別のキーと、次に開く WebView の利用者別の localStorage と、端末の Cookie の置き場 (§6.4)) を通す (#1599 / #1615)。
経路ごとの掃除の順と、掃除する利用者の表は `apps/mobile/src/providers/AuthProvider.tsx` の先頭が正。

| 経路 | 掃除する利用者 | 順 |
|---|---|---|
| 起動時、サーバーが失効と明言した (上の表の 1 行目) | 失効したセッションの利用者 | push token の行の release の宛先を控える (#1636。通信はしない) → 掃除 → `signOut({ scope: 'local' })`。そのあとの `SIGNED_OUT` で release |
| 起動時、`getSession()` が `session: null` (refresh_token の失効・保管庫を読めない・一度もログインしていない)、通信の失敗で保存済みのセッションも無い、`getSession()` の例外 | 直前に分かっていたセッションの利用者。ふつうは分からず、ID なし (利用者別のキーを接頭辞で全員分消す) | 掃除の前に、端末に残っている push token の値 (`push_token_value_v1:<利用者>`) を全部 release の宛先として控える (#1636。利用者が分からないので全部。通信はしない。値を読むところまで待つ。下の注) → 掃除 → 控えた宛先 (と前に消せなかった宛先) の release を始める (待たない)。掃除が済んでから未ログインの画面を出す。ただし端末の Cookie の置き場の掃除 (`Networking.clearCookies`) は始めるだけで完了を待たない (`{ webViewNativeCookies: "background" }`。下の注。#1647) |
| `onAuthStateChange` の `SIGNED_OUT` (自動更新で refresh_token が失効と答えた (access token の失効の後。§9.1)・`getUser()` が失効を見つけて端末のセッションを消した・ログアウトの `signOut()` (access token が有効なうちに呼んだときは、サーバーへのログアウトが失敗したときも。失効していて更新もできないときは届かない。下の表の `{ error }` の行)) | 直前に分かっていたセッションの利用者 (無ければ ID なし) | supabase-js がセッションを消したあと。画面はすぐ未ログインにし、掃除はそのあと。この掃除 (`clearUserScopedLocalDataAfterSignedOut`) だけは、この端末の push token の値 (`push_token_value_v1:<利用者>`) を残す。端末の Cookie の置き場の掃除は完了を待たない (#1647)。掃除のあと、残した値と端末の秘密の値で `user_push_tokens` の行をセッション無しで消す (release。利用者が分からない (ID なし) ときは残っている値を全部。#1636。下の注) |
| Web からの `session-expired` で、`getUser()` が失効を見つけた (`webViewAuthMessages.ts`) | `SIGNED_OUT` の行は直前に分かっていたセッションの利用者、`signOut.ts` は `getUser()` の前に控えた利用者 (同じ利用者) | `getUser()` が端末のセッションを消して `SIGNED_OUT` が届く → `SIGNED_OUT` の行の掃除 (push token の値は残す) → `signOut.ts` の push token の行の削除 (残した値を読む。`SIGNED_OUT` の release が先に消していて 0 件なら、release の宛先を控える。#1706。release は合う行が無ければ 0 件で控えから外れるだけ) → 掃除 (値もここで消える) → `signOut()` |
| ログアウト (設定画面の `signOutOnDevice`、アカウントの画面 (`app/settings/account.tsx`) で退会の API が 401 を返したときの `signOutOnDevice`、退会のあとの `signOutAfterAccountDeletion`)、パスワード再設定のあと (`auth/reset-password.tsx` の `signOutWithCleanup`)、Web からの `sign-out` (`webViewAuthMessages.ts` の `signOutWithCleanup`) | 画面が持つ利用者 (パスワード再設定のあとは `POST /api/auth/password/reset` を呼ぶ前のセッションの利用者 (#1720 段 C)、Web からのときは処理の最初に控えた利用者) | push token の行の削除 (退会のあとは無し。削除が失敗・0 件なら、掃除が値を消す前に release の宛先を控える (`recordPushTokenRelease`。#1706。通信はしない)) → 掃除 → `signOut()`。そのあと届く `SIGNED_OUT` で、`SIGNED_OUT` の行の掃除がもう一度走り、控えた宛先があれば release が消す |
| 上の行の `signOut()` が、通信の失敗 (オフラインなど)・5xx で `{ error }` を返した | 上の行と同じ | `signOut()` の前の掃除のあとは、保管庫の access token の状態で 2 つの枝に分かれる (§9.1 の `_signOut` の失敗の行の ①・②)。**(a) access token が有効** (残り 90 秒未満で更新に失敗していても、失効の前なら有効): サーバーへのログアウトまで届いて失敗する。supabase-js (auth-js 2.117) は保管庫のセッションを消して `SIGNED_OUT` を出す (scope `others` を除く) ので、成功のときと同じく `SIGNED_OUT` の行の掃除と release が走る (S-20)。**(b) access token が失効していて、更新もできない** (更新が接続の失敗・5xx で終わった、または失敗の控えの 60 秒の間): `signOut()` はサーバーへのログアウトを呼ばずに `{ error }` を返し、保管庫のセッションは残り、`SIGNED_OUT` も届かない (2.105 と同じ。S-22)。`SIGNED_OUT` の行の掃除と release は走らない。設定画面のログアウト・アカウントの画面の 401 のときのログアウトと退会のあと (`signOutOnDevice`・`signOutAfterAccountDeletion`) は、どちらの枝でも (と `signOut()` が例外を投げたときも)、保管庫のセッションを端末だけで消し (`clearStoredSessionLocally`)、`clearSession()` で画面の状態を消す。(b) と例外では、これが後始末の本体 (`SIGNED_OUT` が来ない) で、(a) では supabase-js の消去と重なる (二重でも害は無い)。パスワード再設定のあとと Web からの `sign-out` (`signOutWithCleanup`) は端末だけで消す処理を持たないので、(a) では `SIGNED_OUT` で未ログインになるが、(b) では保管庫のセッションと画面の状態が残る (ログイン中のまま。パスワード再設定のあとは、ログイン画面へ移っても `(auth)/_layout.tsx` がセッションを見てホームへ戻す。規約の同意画面からの `sign-out` では、同意画面の `afterSignOut` の `getSession()` も `null` を返すので入口へ移らず、同意を待つ扱いのまま残る (Web の `signOut()` も失敗して form に戻る。§9.3 の S-29))。サーバーのセッションは、設定画面のログアウト・パスワード再設定のあと・Web からの `sign-out` では失効しないまま残り (端末から消えても、GoTrue の上のセッションと refresh_token は有効なまま)、アカウントの画面の 401 のときは、サーバーがいまのセッションを既に認めていない (退会の API の `getUser()` が失敗した)。退会のあとは `auth.users` の削除と一緒に既に消えている。push token の行の削除が通信の失敗で済まなければ、掃除が値を消す前に release の宛先を控えてある (#1706)。(a) では `SIGNED_OUT` の release が控えを消しに行き、(b) では起動時に未ログインと決まったとき (`flushPendingPushTokenReleases`) か次の `SIGNED_OUT` で消す。release が通信の失敗で済まなければ控えに残り、同じ契機でやり直す。(b) でログイン中のまま残る `signOutWithCleanup` の経路の控えは、その利用者の次の登録 (claim の成功) で外れるか、次のサインアウトで消す |

- ログアウト (`signOut.ts`) と失効の明言は、サインアウトの前に掃除し、そのあとに届く `SIGNED_OUT` でもう一度掃除する。二重の掃除に害は無い (同じキーを消し直し、WebView の掃除の ID を作り直すだけ。次に開く WebView が一度だけ消す)
- `SIGNED_OUT` の掃除が push token の値を残すのは、`SIGNED_OUT` が `signOut.ts` の push token の行の削除 (値を読む) より前に届くことがあるため (上の表の `session-expired` の行。ほかに、ログアウトの途中で自動更新が失効を答えたとき)。先に消すと、削除が値を読めず、端末から取り直せなければ `user_push_tokens` の行が残り、共有端末で前の利用者宛ての通知が届く (#1038 F7-10)。値はこの端末のトークンでどの利用者でも同じ値になり、利用者の ID 付きのキーなので次の利用者は読まない。`signOut.ts` を通らない `SIGNED_OUT` (自動更新の失効) では値が残るが、その利用者が次にログインしたときの登録で書き直され、起動時に未ログインと決まったときの掃除 (ID なし) で消える
- `SIGNED_OUT` の掃除は画面を未ログインにしたあとに走るが、次の利用者のログイン (人の操作) より先に終わる。万一ログインが先でも、消えるのは次の利用者の値で、前の利用者の値は残らない
- 端末の Cookie の置き場の掃除 (`Networking.clearCookies`。§6.4 の①) の完了を待つのは、このあとにサインアウトする経路 (ログアウト・退会の `signOut.ts` と、起動時の失効の明言) だけ。サインアウトの前に消す順を保つため (上限 `WEB_VIEW_NATIVE_COOKIE_CLEAR_TIMEOUT_MS` = 3 秒)。起動時に未ログインと決まったときと `SIGNED_OUT` は、サインアウトが済んでいて待っても順は変わらないので、始めるだけで待たず、失敗はログに残すだけ (#1647)。待つと、ネイティブから知らせが来ない端末では、未ログインで起動するたびに (一度もログインしていない端末も) 読み込み中の表示が上限まで延びる。AsyncStorage の掃除と WebView の localStorage の掃除の依頼は、どの経路でも待つ
- `signOut.ts` を通らない `SIGNED_OUT` (自動更新の失効) と起動時の失効の明言では、セッションが無いので RLS では `user_push_tokens` の行を消せない (#1636)。
  `SIGNED_OUT` の掃除のあとに、残した値と端末の秘密の値 (`03-push-notification.md` §3.2) で release の API を呼ぶ
  (`apps/mobile/src/lib/pushTokenRelease.ts` の `releasePushTokenAfterSignedOut`)。起動時の失効の明言では、掃除が値を消す前に宛先を控え
  (`recordPushTokenRelease`)、そのあとの `SIGNED_OUT` の release が消す。消せなかったら宛先を控え、起動時に未ログインと決まったとき
  (`flushPendingPushTokenReleases`) と次の `SIGNED_OUT` でやり直す。どれも画面は待たない。
  サインアウトした利用者が分からないとき (アプリが閉じている間に refresh_token が失効し、次の起動で supabase-js の初期化がセッションを消したときなど。
  起動時に未ログインと決まったとき・利用者の分からない `SIGNED_OUT`) は、端末に残っている値 (`push_token_value_v1:<利用者>`) を全部宛先にする
  (端末は未ログインなので、残っている値はどれもサインアウトした利用者のもの)。起動時は ID なしの掃除が値を消すので、掃除の前に控える
  (`recordPushTokenReleasesForStoredValues`。値を読むところまで待ち、控えへの書き込みは release の順番の列に積む)。`SIGNED_OUT` の掃除は値を残すので、
  掃除のあとの release (`releasePushTokenAfterSignedOut(null)`) が読む。保管庫を読めない起動 (実はログイン中) ではログイン中の利用者の値も宛先になるが、
  端末の秘密の値も同じ保管庫で読めないので、やり直しは通信せずに控えを残し、次にセッションが戻った起動の登録 (claim の成功) が同じトークンの控えを外す。
  `signOut.ts` を通った `SIGNED_OUT` では、`signOut.ts` が値を先に消しているので、release は控えのやり直しだけをする。
  行は、`signOut.ts` の削除で消えているか、削除が失敗・0 件だったとき (アカウントの画面で退会の API が 401 を返したときのログアウトのように、
  セッションが既に失効しているなど) は、`signOut.ts` が掃除で値を消す前に控えた宛先 (`recordPushTokenRelease`) として、このやり直しが消す (#1706)。
  `session-expired` では、`signOut.ts` の削除と release が同じ行を消しに行くことがある (どちらかが 0 件になるだけで害は無い。
  `signOut.ts` の側が 0 件だと `push_token_unregister_no_rows` が端末のコンソールに出る)
- 保管庫を読めない起動 (iOS で端末のロックを一度も解除していない間のバックグラウンドの起動など) でも、未ログインと決まるので掃除する。ログイン中の利用者の設定 (`v4_range_days` など) と、この端末の push token の控えが消える。控えは次の起動・ログインの登録で書き直される

`apps/mobile/__tests__/providers/auth-provider.test.tsx` (呼ばれる経路と順) と `apps/mobile/__tests__/providers/auth-provider-sign-out-cleanup.test.tsx` (本物の掃除で、利用者別のキーが消えること。`Networking.clearCookies` が未ログインの起動と `SIGNED_OUT` で呼ばれ、その完了を待たずに未ログインの画面が出ること・失効の明言では待ってからサインアウトすること) が確かめる。`session-expired` の行は `apps/mobile/__tests__/lib/web-view-auth-messages.real-auth.test.ts` (本物の AuthProvider・掃除・supabase-js で、`SIGNED_OUT` の掃除が先に走っても、保存済みの値で行を消すこと) が確かめる。

access_token が期限切れで、更新に通信が必要な機内モード起動では、`getSession()` が `session: null` を返す (保存済みのセッションは消えていない)。
通信エラーのときは `getStoredSession()` で保存済みのセッションを読み、それで起動する。通信が戻ると supabase-js が更新し (`TOKEN_REFRESHED`)、差し替わる。
auth-js 2.117 は、やり直せる失敗 (`AuthRetryableFetchError`。5xx・接続の失敗) でも、同じ refresh_token の更新を 60 秒控える (`REFRESH_FAILURE_COOLDOWN_MS`。セッションは捨てない。§9.1)。
そのため更新は、最後の失敗から 60 秒が過ぎた最初の契機 (30 秒ごとの tick か `getSession()`) まで待つ。通信が戻ってから差し替わるまで最大で 60 秒 + tick の 30 秒かかる (2.105 は次の契機で更新した)。
その間、`getSession()` は控えた失敗 (`session: null`) を返し、supabase-js の要求は anon キーで出る。WebView のまだ開いていないタブは bridge が通らず Web のログイン画面になり、WebView からの `session-expired` にもネイティブは何もしない (控えが取れない。§6.2 の 1)。この遅れは受け入れる (§9.5 の裁定 G。§9.4 の T-19・T-23)。
サーバーが `refresh_token` を失効と答えれば `SIGNED_OUT` になるので、検証を省いても失効の取りこぼしにはならない。
auth-js 2.117 (#1768。§9.1) では、access token がまだ有効なうちの先回りの更新 (残り 120 秒未満の tick・残り 90 秒未満の `getSession()`) が失効と答えられても、セッションを捨てず `SIGNED_OUT` も出さない (失敗を 60 秒控え、その間は同じ refresh_token で `/token` を呼ばない)。
捨てて `SIGNED_OUT` を出すのは、access token が失効したあとの更新の失敗 (失効から最大 90 秒 = 控えの 60 秒 + tick の 30 秒の遅れ)。上の表の `SIGNED_OUT` の行 (ネイティブの経路と掃除) の中身は変わらず、届く時刻が access token の失効の後になるだけ (§9.6 の表②)。`getUser()` の `403 session_not_found` で端末のセッションを消す経路 (起動時の失効の明言・`session-expired`) は 2.117 でも同じ (§5)。

- **この場合は `getUser()` による検証を省く**。`getUser()` も同じ更新を試みて、同じ理由で失敗するだけだから (2.117 では、控えた失敗をすぐ受け取る)。
  supabase-js は、やり直せる失敗の更新を約 25 秒かけてやり直す (`_refreshAccessToken` の指数バックオフ。次の待ちが tick の 30 秒を越えるまで。§9.1)。
  2.105 は `_initialize` と `getSession()` のそれぞれでやり直した。実測で、期限切れ + オフラインの起動は `getSession()` が約 51 秒かかり、そのあと `getUser()` がさらに約 51 秒かかっていた (合わせて約 100 秒)。検証を省いて約 51 秒にした。
  2.117 は `_initialize` の失敗を控え、`getSession()` は控えた失敗をすぐ返す。そのため約 25 秒になる (コードから導いた値。§9.4 の T-19)
- それでも、読み込み中の表示が約 25 秒 (2.105 のビルドでは約 50 秒) 続く。短くするには、保存済みのセッションで先に画面を出し、更新と検証を裏で行う設計が要る (未対応。§8)

### 3.1 端末名の登録 (#1189。cross/16 §16)

ログイン直後と起動時に `PATCH /api/auth/sessions/current` で端末名を登録する (cross/16 §16)。

- `AuthProvider` の `onAuthStateChange` が、`INITIAL_SESSION` (セッションがあるとき) と `SIGNED_IN` で `registerDeviceName(session.access_token)` (`apps/mobile/src/lib/device-name.ts`) を呼ぶ。待たない (失敗しても画面・掃除の表は変わらない)
- 端末名は機種名と OS の版 (`expo-device` の `modelName` と `osName`・`osVersion`。例 `iPhone 15 Pro (iOS 18.0)`)。利用者が付けた端末の名前 (`Device.deviceName`) は送らない。サーバーの `DEVICE_NAME_PATTERN` (英数字・空白・`()._,+-`) に無い文字は除く
- 同じ access token では 1 回だけ送る (プロセスの中だけ覚える)。ログアウト → ログインは新しいセッション = 新しい token なので、その行に送り直す。失敗したら次の `SIGNED_IN` / `INITIAL_SESSION` で送り直す
- 一覧の画面 (`apps/mobile/app/settings/sessions.tsx`。設定タブの「ログイン中の端末」から開く) は、端末名を UA から決まる見出し (`device_label`) の下に「端末名: …」として添える

`apps/mobile/__tests__/providers/auth-provider.test.tsx` (渡す access token) と `apps/mobile/__tests__/lib/device-name.test.ts` (作る名前・重ねよけ・失敗のやり直し) が確かめる。

## 4. Google ログインのコールバック (F7-08)

iOS の `ASWebAuthenticationSession` は、コールバック URL を `openAuthSessionAsync` の `result.url` にだけ返し、`Linking` のイベントには流さない。
以前は `result.url` を捨てて `/auth/verify` へ遷移していたため、verify 画面が URL を取れず、セッションが無いまま「確認が完了しました」と表示した。

- `login.tsx` が `result.url` から `code` / `access_token`+`refresh_token` を取り出し、その場でセッションにする (`completeAuthLink`)
- `verify.tsx` は、リンクの情報が無い・`error` がある・交換に失敗したときはエラー表示にする (見出しのアイコンと色もエラーのもの。成功の緑のチェックにするのは、エラーなく終わったときだけ)。
  起動リンクの取得が済むまでは、エラーを出さず確認中のままにする
- Android では同じコールバックが `result.url` とディープリンクの両方で届き得る。`code` は 1 回しか交換できないので、同じリンクの処理は 1 回にして結果を共有する
- 既知の見え方 (実機で確認する): Android の Google ログインでは、リダイレクトのディープリンクで expo-router も `/auth/verify` を開く。
  verify の `Linking.useURL()` は購読前に流れたイベントを受け取れないので、`login.tsx` の `routeAfterSignIn` が画面を移すまでの 1〜2 秒、
  「確認できませんでした」が見える可能性がある。ログイン自体は `login.tsx` 側で完了し、画面が移れば消える

## 5. push token (F7-09 / F7-10)

登録 (`registerAndSaveExpoPushToken`)
- EAS の project ID は UUID 形式を確認し、不正な値 (展開されなかった `"$EXPO_PUBLIC_EAS_PROJECT_ID"` など) は読み飛ばして次の候補へ進む
  (環境変数 → `easConfig` → `app.json` の `extra.eas.projectId` → `extra.projectId`)
- `eas.json` の `EXPO_PUBLIC_EAS_PROJECT_ID` の行は削除した。`app.json` の `extra.eas.projectId` を使う。
  eas.json の `"$VAR"` は展開されずに文字列のまま入っていた (Issue #1038 の報告)。形式の検査があるので、どちらでも壊れない。
  `01-architecture.md` §7.2 の表にある同名の行 (preview / production) は、この変更で eas.json に設定しなくなった (環境変数や EAS Secret として注入することは今でもできる)
- 失敗は端末のコンソールとサーバーログ (`POST /api/log` → `app_logs`。エラー境界の記録と同じ経路) に出す (`push_token_registration_failed`。トークンやユーザー ID は載せない)。PostHog には送らない (#1166)。
  サーバーログに送るのは決まった値だけ (イベント名・OS・段 (`stage`)・エラーの名前とコード (英数字と `._:-` の 64 文字以内。外れたら `unknown`)・HTTP の状態・project ID の出どころ) で、エラーの本文は送らない (#1413)。
  送る本文と送ってよいキーの一覧は `apps/mobile/src/lib/push-issue-log.ts` (`PUSH_ISSUE_SERVER_METADATA_KEYS`)。キー名に `password` / `token` / `secret` / `authorization` / `api_key` を含めない
  (`/api/log` の `sanitizeLogEntry` がキー名だけで値を `***` にするため。`tests/push-issue-log-sanitizer.test.ts` が本物の `sanitizeLogEntry` で確かめる)。
  登録の失敗では送信を待たない
- 起動時の自動登録 (`ensurePushTokenRegistered`) は、起動・ログインした利用者が変わるたびに、登録 (upsert) と claim
  (`POST /api/push-tokens/claim`。同じトークンのほかの利用者の行を外す) を通す。どちらも何度呼んでも同じ結果になる (#1599)。
  claim には端末の秘密の値を付け、外すのは同じ端末の前の利用者の行 (とハッシュの無い古い行) だけ (#1636。`03-push-notification.md` §3.2)。
  登録は、動いている release (セッションの無いときの後片付け) が終わってから行う。
  「登録済み」の印で省くことはしない。claim はほかの利用者の行を消すので、印があっても行があるとは限らない
  (共有の端末で、利用者 A のセッションが掃除を通らずに終わる → B がログインして claim で A の行を消す → A が再びログインする、のとき、
  印で省くと A の行が無いまま再登録されず、A 宛ての通知がこの端末に届かなくなる)。
  旧ビルドが付けた印 (`push_token_registered_v2:<uid>`、#1038 より前の `push_token_registered_v1:<uid>`。v1 は権限を拒否されても付いていた) は
  読まず書かず、ログアウトで消す
- 権限のダイアログ: 起動時の自動登録では、まだ一度も尋ねていない (`undetermined`) ときだけ出す。拒否された後も毎回出すと、
  Android 13 以降は、一度拒否した利用者に次の起動でもう一度ダイアログが出る。拒否した利用者は OS の設定で許可すれば、次の起動で登録される。
  設定画面の登録ボタン (`userInitiated: true`) は利用者の操作なので、OS がまだ尋ねられる (`canAskAgain` が `false` でない) なら出す

削除 (`apps/mobile/src/lib/signOut.ts` の `signOutOnDevice` / `signOutWithCleanup`)
- ログアウトは「push token の削除 → 端末データの削除 → サインアウト」の順。削除は RLS (本人の行のみ) のため、サインアウトの前に行う
- 通る場所と、削除を認可するもの

  | 通る場所 | 削除を認可するもの |
  |---|---|
  | 設定画面のログアウト (`signOutOnDevice(user?.id ?? null, { clearSession })`)、パスワード再設定後の全端末サインアウト (`auth/reset-password.tsx` の `signOutWithCleanup`) | いまのセッション。セッションが生きているうちに呼ぶので、supabase-js が付ける |
  | アカウントの画面で、退会の API (`/api/account/delete`) が 401 を返したときのログアウト (`app/settings/account.tsx` の `signOutOnDevice(user?.id ?? null, { clearSession })`。#1562) | いまのセッション (supabase-js が付ける)。サーバーはこのセッションを既に認めていないので、削除が 0 件・失敗になり得る。そのときも下のとおりログアウトは止めず、行は release で消す (下の「削除が失敗・0 件のとき」。#1706) |
  | Web (WebView) からの `sign-out` / `session-expired` の反映 (`webViewAuthMessages.ts`) | **処理の最初に控えた本人のアクセストークン**。`Authorization` ヘッダーで明示する (下) |

- Web (WebView) からのログアウトでは、**キャッシュ済みのセッションに頼らず、控えた値を使う**。Web の `signOut()` は全端末のセッションをサーバーで失効させ、
  失効したあとにネイティブが `getUser()` を呼ぶと、サーバーは `403 session_not_found` を返す。auth-js はそれを `AuthSessionMissingError` にして、
  端末のセッションを消す (`_removeSession`。2.105.3 の `dist/main/GoTrueClient.js:2506-2511` と 2.117.3 の同 `:2724-2729` で同じ)。
  2.105 では auth-js の処理がロック (`_acquireLock` の待ち行列) で直列だったので、そのあとに動く `getSession()` は `null` を返した。2.117 はロック無しが既定 (`lock = null`。同 `:157`・`:2494-2507` の `_useSession` は直列化しない) で、
  `getUser()` の途中に動く `getSession()` がまだ消えていないセッションを返すこともあるが、どちらの版でも「処理の最初に控える」(§6.2) は成り立つ。
  控えが無いと、ユーザー ID が分からず削除を諦める (skipped)、または削除の通信が anon キーで送られて RLS で 0 行になる (エラーにならない)。
  詳しい順番と対策は §6.2
- `Authorization` ヘッダーを明示すると、supabase-js は上書きしない (`fetchWithAuth` は、既にあれば付けない)。
  PostgREST は JWT の署名と期限だけを見て、セッションが失効済みかどうかは見ないので、アクセストークンの期限内なら、失効後でも RLS で本人の行を消せる
- 消えた行の件数を数える (`delete({ count: 'exact' })`)。0 件 (RLS に弾かれた、または行が既に無い。どちらもエラーにならない) のときは `push_token_unregister_no_rows` を端末のコンソールとサーバーログ (`app_logs`。#1413) に出す (PostHog には送らない: #1166)。
  以前は 0 件でも「削除できた」扱いで、RLS を素通りしても気づけなかった。Web からアカウントを削除したときも `sign-out` が届くが、そのときは `auth.users` の削除で行が CASCADE で先に消えているので、この通知が出る (正常)
- 消すのは「この端末のトークンの、このユーザーの行」だけ。同じユーザーの他の端末の行を消すと、その端末では次にアプリを起動するまで再登録されず、その間は通知が届かなくなる
- 削除が失敗・0 件のとき (`unregisterExpoPushToken` が `failed` / `no_rows` を返した、または万一例外を投げた) は、端末データの削除が
  値 (`push_token_value_v1:<利用者>`) を消す前に、その行を release の宛先として控える (`apps/mobile/src/lib/pushTokenRelease.ts` の
  `recordPushTokenRelease`。通信はしない。#1706)。控えないと、あとに届く `SIGNED_OUT` の release (`releasePushTokenAfterSignedOut`) は値を読めず、
  行が残る (§3 の注)。控えた宛先は、その `SIGNED_OUT` の release か、起動時に未ログインと決まったときのやり直し (`flushPendingPushTokenReleases`) が
  端末の秘密の値で消す。消せたとき (`deleted`)・何もしなかったとき (`skipped`。利用者や値が分からず、控える値も無い) は控えない。
  行が既に無かった (`SIGNED_OUT` の release や `auth.users` の削除の CASCADE が先に消した) ときも控えるが、release は合う行が無ければ 0 件で `200` を返し、
  控えから外れるだけ。`apps/mobile/__tests__/lib/sign-out-push-token-release.test.ts` (本物の `signOut.ts`・`pushTokenRelease.ts`・掃除) と
  `apps/mobile/__tests__/settings/account-delete.test.tsx` (退会の API の 401) が確かめる
- 失敗・タイムアウト (3 秒) でもログアウトは止めない。失敗 (エラー・タイムアウト・途中の例外) は `push_token_unregister_failed` (`reason`: `error` / `timeout` / `exception`) として端末のコンソールとサーバーログに出す (#1413)
- 0 件・失敗のサーバーログには、原因を切り分ける値として、削除に使った push の値の出どころ (`push_value_source`: `stored` = 端末に控えた値 / `refetched` = 取り直した値。`timeout` と `exception` では送らない) と、
  控えたアクセストークンで `Authorization` を明示したか (`explicit_auth_header`) を送る。0 件では件数 (`deleted_count`: 0)、`error` ではエラーのコードと HTTP の状態、`exception` ではエラーの名前も送る。
  端末のコンソールでは同じ値を `token_source` / `explicit_access_token` の名前で出す (サーバーには送らないのでマスクされない)。
  `explicit_auth_header` が `true` になるのは Web から始まったサインアウト・`session-expired` だけで、その記録は下のとおり `app_logs` にはほぼ載らない
  (`app_logs` で見えるのは、ほぼ端末からのサインアウトの `false` の行)
- サーバーログへの送信 (0 件・失敗) は、`unregisterExpoPushToken` が返る前に待つ (上限 2 秒 = `PUSH_ISSUE_LOG_TIMEOUT_MS`)。サインアウトでセッションが消えたあとでは `/api/log` の認証を通らないため。
  控えたアクセストークンがあれば `Authorization` で明示して送る。送れなかった記録は諦める (ログアウトは止めない)
- この順番で記録が `app_logs` に残るのは、端末からのサインアウト (設定画面・パスワード再設定のあと。セッションが生きているうちに呼ぶ) だけ。アカウントの画面で退会の API が 401 を返したときのログアウトは、端末から始まるが、サーバーがセッションを既に認めていないので、ふつうは残らない (`/api/log` の `getUser()` も 401 になる)。
  Web から始まったサインアウト・`session-expired` では、端末が送るより前に、ふつうは Web の `signOut()` がサーバー側のセッションを失効させている
  (`session-expired` は `getUser()` で失効を確かめてからログアウトするので必ず。Web からアカウントを削除したあとの `sign-out` も、ユーザーが消えているので同じ)。`/api/log` (`src/app/api/log/route.ts`) はサーバーで `getUser()`
  (GoTrue の `GET /user`。JWT の `session_id` のセッションが残っているかまで確かめる) を呼ぶので、控えたアクセストークンを明示しても `401` になり、記録は残らない
  (端末のコンソールには出る)。削除の `DELETE` が同じトークンで通るのは、PostgREST が JWT の署名と期限しか見ないからで、`/api/log` はそうではない。
  送る順番では防げない (端末が送る前にサーバー側のセッションが消えている)。`sign-out` は Web の `signOut()` の前に届くので、Web の失効より先に送れたときだけは残りうる。
  この経路の記録も残すには `/api/log` の認証 (サーバー側) を変える必要がある (この変更では変えていない)。
  この食い違いは `tests/integration/security/push-issue-log-after-session-revoked.test.ts` が本物のサーバーで固定する
- アカウント削除 (アプリの `app/settings/account.tsx`) では不要。`auth.users` の削除で `user_push_tokens` が `ON DELETE CASCADE` で消える

## 6. Web (WebView) とネイティブの状態を揃える (F7-04 / F7-05)

ログイン状態の持ち主は**ネイティブ**。WebView の Web 側は、ネイティブが張った借り物の Cookie セッションで動く。

> 3 つ目のメッセージ `{ type: 'mfa-verify-required' }` (Web → ネイティブ。運営ロールの二段階認証の 6 桁の確認をネイティブの確認画面に頼む。
> `docs/design/cross/12-operator-mfa.md` §16.4) は、Web の送る側 (`src/lib/native-auth-bridge.ts` の `requestNativeMfaVerify`) が段 A で、
> ネイティブの受け取り・確認画面・読み込み直しが段 D で入った (段 D より前のアプリは知らない type として捨てる)。受け取りの規則は §6.2 の末尾。

### 6.1 refresh_token の持ち主はネイティブだけ (F7-05)

ネイティブの refresh_token をそのまま Web の Cookie にも入れると、Web (middleware / ブラウザの supabase-js) とネイティブが同じ refresh_token を別々にローテーションする。
片方が使った古い refresh_token をもう片方が使うと、Supabase は再利用とみなしてセッションごと失効させ、突然のログアウトになる。

- `/auth/native-bridge?code=...` (`handleCode`) は、Web の Cookie セッションに access_token だけを実際の値で入れ、refresh_token には使えない値
  (`NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER`) を入れる。Web は自分で更新できない
- 期限が近づいたら Web が `{ type: 'session-expired' }` を送り (§6.2)、ネイティブが新しいコードで WebView を読み込み直す
- 旧方式 (トークンを URL で渡す GET) は変えない。旧アプリは再ブリッジの仕組みを持たないため。なお旧方式は、期限 `LEGACY_SUNSET_AT` (`src/lib/auth/native-bridge-code.ts`。2026-10-18 00:00 JST) を過ぎたので、いまは受け付けずに 426 (アプリの更新を促すページ) を返す (#1036)
- 従来の動作 (実際の refresh_token を入れる) へ戻すスイッチ: 環境変数 `NATIVE_BRIDGE_SHARE_REFRESH_TOKEN=on` (Vercel は再デプロイ後に効く)
- この作りの帰結として、WebView の借り物のセッションでは、Supabase のセッションの token を発行し直す操作 (二段階認証の 6 桁の verify・解除の後の refresh) を Web の側でしない。持ち主のネイティブが行い、WebView を読み込み直す (`docs/design/cross/12-operator-mfa.md` §16.4)

**「切れる前に頼むので、Web は更新しない」は、前面で使っているときしか成り立たない。** ブラウザの supabase-js (auth-js 2.117.3。#1768 で 2.105.3 から上げた。§9.1 に file:line) は、次の時点で必ず更新を試みる。
借り物の refresh_token では更新が 400 (`refresh_token_not_found`) になる。auth-js 2.117 はその失敗を次のとおり扱う (2.105 は、どちらの契機でも失敗した時点でセッションを捨てて `SIGNED_OUT` を出していた)。

| auth-js が更新を試みる契機 | 更新を試みる残り時間 | 失敗したとき (2.117.3) |
|---|---|---|
| 自動更新の tick (30 秒ごと。前面のときだけ) | 120 秒未満 (`floor(残り / 30 秒) <= AUTO_REFRESH_TICK_THRESHOLD (3)`) | access token が**まだ有効**なら、セッションを残し `SIGNED_OUT` を出さない。失敗を 60 秒 (`REFRESH_FAILURE_COOLDOWN_MS`) 控え、その間は同じ refresh_token で `/token` を呼ばない。access token が**失効した後**なら、セッションを捨てて `SIGNED_OUT` を出す |
| `getSession()` (Supabase への API 呼び出しのたびに走る)・バックグラウンドからの復帰 (`visibilitychange`) | 90 秒未満 (`EXPIRY_MARGIN_MS`)。復帰時は tick も直ちに走る | 同上。残したセッションがあれば `getSession()` はそれを返す (失効前は access token がそのまま使える)。失効後で控えが効いている間は `{ session: null, error }` を返し、保管はまだ消えていない (次の実際の更新で捨てる。その前にサーバーの応答が Cookie を消すこともある §6.3 の 5) |

`SIGNED_OUT` が出るのは、**access token が失効したあとの更新の失敗** (やり直せない失敗。5xx・接続の失敗では、失効後でも捨てず、60 秒控えるだけ) か、利用者のログアウト (`signOut()`) だけになった。失効から `SIGNED_OUT` までは最大 90 秒 (控えの 60 秒 + 次の tick までの 30 秒。§9.4 の T-4)。ただしこの上限は、ブラウザの auth-js が自分で捨てる場合のもの。その前に Next のサーバー (`/api/*` の要求の middleware など。要求ごとに作るクライアントで、失敗の控えを持たない) が同じ Cookie で失効後の更新を試みて 400 になると、応答で Cookie を消す。ブラウザの auth-js はその削除を事象として受け取らないので、`SIGNED_OUT` は出ない (§6.3 の 5。§9.3 の S-27)。実際の refresh_token を持つふつうのブラウザでも、サーバーで refresh_token が失効したとき (別の端末からの全端末ログアウトなど) は同じ順が起き、`SIGNED_OUT` は出ず、`MainLayout` は何もしない (§6.3 の「ふつうのブラウザ」の段落。§9.3 の S-28・§9.5 の裁定 H2)。

そのため 2 段構えにしている (構えは #1038 と同じ。2.117 で変わるのは、1 と 2 の間の「捨てられるが使える」期間が無くなったこと)。

1. **前面で使っているとき**: `NativeSessionWatcher` が、auth-js より先に再ブリッジを頼む (`REFRESH_AHEAD_SECONDS` = 180 秒)。
   20 秒ごとの確認の遅れと、ネイティブの再ブリッジにかかる時間を見込んでも、auth-js の tick (120 秒) より前に済む。
   (以前の 120 秒は tick と同じ閾値で、tick が先に走ると (およそ 3 回に 1 回) 借り物の refresh_token で更新して失敗していた。90 秒という説明も誤りで、90 秒は `getSession()` の閾値)。
   2.117 では、万一 tick が先に走っても access token が有効な間はセッションが残り、画面は動き続ける (借り物の値での `/token` の 400 が 1 回出るだけ)。180 秒は、その無駄な `/token` を避け、失効の前に読み込み直しを済ませるための値として据え置く
2. **先回りできないとき**: 1 時間以上バックグラウンドに置いて戻ると、その間タイマーが止まっているので、復帰した瞬間に auth-js が更新を試みる (access token は失効しているので、捨てて `SIGNED_OUT`)。
   どんな閾値でも先回りできない。WebView の中の `SIGNED_OUT` は「利用者のログアウト」とは限らないので、`MainLayout` は §6.3 のとおり扱う。
   復帰時は `NativeSessionWatcher` の `visibilitychange` も走り、`getSession()` が `null` なら `session-expired` を送る。`MainLayout` の送信と重なっても、Web 側の最小の間隔 (`SESSION_EXPIRED_MIN_INTERVAL_MS` = 15 秒) で 1 回になる

閾値の関係は `src/__tests__/lib/native-session-authjs-thresholds.test.ts` が、本物の auth-js (GoTrueClient) の動きで確かめる (auth-js を上げて閾値が変わると落ちる)。
#1768 で、同じファイルに「失敗の控えは 60 秒」「先回りの失敗ではセッションを残す」「失効後の失敗で捨てて `SIGNED_OUT`」も足す (§9.9)。

### 6.2 Web → ネイティブ のメッセージ

`window.ReactNativeWebView.postMessage(JSON.stringify(message))`。ネイティブは、自分の Web オリジンのページから届いたものだけを処理する。

```typescript
type WebToNativeAuthMessage =
  | { type: 'sign-out' }             // 利用者が Web でログアウトした
  | { type: 'session-expired' }      // Web のセッションが切れた・切れそう
  | { type: 'mfa-verify-required' }  // 運営の二段階認証の 6 桁の確認をネイティブに頼む (cross/12 §16.4)
  | { type: 'legal-consent-accepted' }; // 規約の同意を記録できた (cross/13b)。ログアウトの合図ではない
```

| 送る場所 (Web) | メッセージ |
|---|---|
| 各画面のログアウト処理が `supabase.auth.signOut()` の**前**に呼ぶ `notifyNativeSignOut()` (`src/lib/native-auth-bridge.ts`)。設定・マイページ (ログアウトと退会)・組織レイアウト・`family/promotions/[token]`・パスワード再設定後の全端末ログアウト・凍結ページ。`signOut()` の後の `broadcastSignOut()` (`src/lib/user-storage.ts`) も、まだ送っていなければ送る | `sign-out` |
| `NativeSessionWatcher` (認証が必要なページの共通レイアウトに常駐)。20 秒ごと・前面復帰時に確認し、セッションが無い、または (ネイティブから借りたセッションで) 有効期限までの残りが 180 秒を切った | `session-expired` |
| `MainLayout` の `onAuthStateChange`。WebView の中で `SIGNED_OUT` になった (§6.3) | `session-expired` |
| ログイン画面が表示されたとき (WebView でログイン画面 = セッションが無い) | `session-expired` |
| 運営の MFA の確認画面 (`/settings/security/mfa/verify`) を WebView の中で開いたとき (`NativeAppMfaNotice` の kind=verify。描画の後に 1 回と、[確認画面を開く] を押したとき。cross/12 §16.4.3) | `mfa-verify-required` |
| Web の同意画面 (`LegalConsentForm`) が同意を記録できた直後 (`POST /api/legal/accept` が 200。`window.location.assign(next)` の前)。ネイティブの受け手は `WebViewScreen` の `onMessage` で、`useWebAuthMessages` を通らない。ネイティブはゲートが同意画面から入口へ移す (cross/13b) | `legal-consent-accepted` |

`session-expired` は Web 側で 15 秒以内に続けて送らず、ログアウトを知らせた後は送らない。`sign-out` は 1 つのページで 1 回だけ送る。普通のブラウザでは何も送らない。

**ログアウトの `sign-out` は、`signOut()` の前に送る。** 利用者のログアウトでも、`signOut()` の途中で auth-js が `SIGNED_OUT` を出す。
`MainLayout` がそれを `session-expired` として先に送ると、ネイティブは自分のセッションをサーバーで確かめ、(Web の `signOut()` が全端末を失効させるので) 失効と返り、
auth-js が端末のセッションを消す。そのあとに届く `sign-out` では、ユーザー ID も本人の JWT も取れず、push token を消せない (§5)。そこで二重に備える。

1. **Web**: 各画面が `signOut()` の前に `notifyNativeSignOut()` を呼ぶ。このページはログアウト通知済みになり、`session-expired` を送らなくなる。ネイティブには `sign-out` だけが先に届く。
   `broadcastSignOut()` 自体は `signOut()` の**あと**に呼ぶ (先に呼ぶと、同じタブの `BroadcastChannel` で `MainLayout` が `/login` へ移り、`signOut()` が途中で止まる)。
   並び (`notifyNativeSignOut` → `signOut` → `broadcastSignOut`) は `tests/native-sign-out-order-source-scan.test.ts` が検査する
2. **ネイティブ**: 順番が違っても消せるように、処理の最初にセッションを控える (下)。呼び忘れた画面、別のタブのログイン画面が送る `session-expired`、
   ログアウトの途中で届く `session-expired` でも、取りこぼさない

ネイティブの処理 (`src/lib/webViewAuthMessages.ts`)
- **セッションの控え**: 処理の最初に `getSession()` で `userId` と `accessToken` を控える。同時に動く他のメッセージとは、同じ控えを使い回す
  (メッセージごとに `getSession()` を呼ぶと、先に動いている `session-expired` の `getUser()` が端末のセッションを消したあとで、`null` を受け取る)。
  控えは、処理中のメッセージが無くなったとき、またはログアウトが済んだときに捨てる (次のログインの別ユーザーに使わない)。
  ログアウトでは、この控えを `signOutWithCleanup(userId, { accessToken })` に渡し、push token の削除を本人の JWT で認可する (§5)
- `sign-out`: 共通のログアウト (§5) を行い、ウェルカム画面へ戻る。5 つのタブが同時に送ってきても 1 回だけ行う。規約の同意画面 (`app/legal-consent.tsx`) だけは `WebViewScreen` の `afterSignOut` でウェルカムへ移らず、Web の「同意しない」「登録をやめる」の後の案内を残して「閉じる」を出す (13b。ネイティブのサインアウトが通信の失敗で終わったときの分かれ方は §9.3 の S-29)
- `session-expired`:
  1. ネイティブも未ログインなら何もしない (上の控えが無い)。この控えは、次の `getUser()` より**前**に取る
  2. ネイティブのセッションをサーバーで確かめる。失効していれば (Web のログアウトで全端末のセッションが失効した後など)、読み込み直さず、控えた値でログアウトを揃える (ログアウトの後の移り先は `sign-out` と同じ。規約の同意画面では `afterSignOut` を呼び、ウェルカムへ移らない)
  3. 生きている (または確かめられない) なら、その画面 (タブ、タブ以外の `/settings/ai-consent`・`/settings/data-requests`) を、いま開いているパス (`WebViewScreen` が `initialPath` を検証したあとの `effectivePath`) に使い捨ての `_rb` を付けた `initialPath` で開き直させる (= bridge をやり直す)
  4. 回数制限: タブごとに、10 秒以上の間隔、5 分で 3 回まで。ブリッジが失敗し続けても延々と繰り返さない
  5. 確かめている間に `sign-out` が始まった・済んだら、読み込み直しも二重のログアウトもしない
- `mfa-verify-required` (cross/12 §16.4.4・§16.4.5): セッションの控え・`getSession()` / `getUser()`・回数制限のどれにも触れず、`WebViewScreen` にネイティブの確認画面 (`NativeMfaVerifyModal`) を出させる。
  確認画面はネイティブのセッションで 6 桁を verify し (既に aal2 なら 6 桁を求めない)、済んだら閉じて、いま開いているパス (`effectivePath`) に `_rb` を付けて開き直させる
  (`session-expired` の 3 と同じ組み立て。回数制限は通さない: 6 桁を入れた後に 1 回だけ呼ぶもので、制限に当たると aal2 になったのに WebView が古いままになるため)。
  [閉じる] では開き直さない。登録・回復・設定はブラウザだけ (確認画面は案内を出す)

```mermaid
sequenceDiagram
  participant W as Web (WebView)
  participant N as ネイティブ
  participant S as Supabase Auth

  Note over W,N: F7-04 / F7-10 Web でログアウト (各画面は signOut の前に sign-out を送る)
  W->>N: { type: 'sign-out' }
  N->>N: セッション (userId・access_token) を控える
  W->>S: signOut() (全端末のセッションを失効)
  N->>S: DELETE user_push_tokens (控えた access_token を Authorization に明示)
  N->>N: 端末データを削除 → signOut → ウェルカム画面へ

  Note over W,N: 順番が逆でも消せる (signOut の途中の SIGNED_OUT が session-expired として先に届いた場合など)
  W->>N: { type: 'session-expired' }
  N->>N: セッションを控える (getUser の前)
  N->>S: getUser() → 403 session_not_found (auth-js が端末のセッションを消す)
  W->>N: { type: 'sign-out' } (控えを使い回す。getSession() はもう null)
  N->>S: DELETE user_push_tokens (控えた access_token)
  N->>N: 端末データを削除 → signOut → ウェルカム画面へ

  Note over W,N: F7-05 Web のセッションが切れそう (前面) / 切れた (バックグラウンドから復帰して SIGNED_OUT)
  W->>N: { type: 'session-expired' }
  N->>N: セッションを控える
  N->>S: getUser() で自分のセッションを確認 (必要なら更新)
  alt 失効している
    N->>S: DELETE user_push_tokens (控えた access_token)
    N->>N: ログアウトを揃える
  else 生きている
    N->>S: POST /api/auth/native-bridge/code
    N->>W: 新しいコードで読み込み直す (/auth/native-bridge?code=...)
  end
```

### 6.3 WebView の中の SIGNED_OUT (`MainLayout`)

`MainLayout` は `onAuthStateChange` の `SIGNED_OUT` で、これまで `clearUserScopedLocalStorage()` と `/login` への移動を行っていた (ほかのタブでのログアウトを伝えるため。#145)。
WebView の中では、`SIGNED_OUT` は利用者のログアウトとは限らない (§6.1。auth-js 2.117 では、借り物の access token が失効したあとの更新の失敗で出る。失効の前は出ない)。ログアウト扱いにすると、ログアウトしていないのに、次のことが起きる。

- user-scoped の localStorage のキーが消える。Cookie と localStorage は全タブの WebView で共有なので、開いているすべてのタブが失う。
  `v4MenuGenerating` など (献立タブがページリロード時に進行中の生成を復元する値)、`v4_range_days` / `v4_include_existing` (AI 生成の設定)、`profile_reminder_dismissed` (閉じたバナーが再び出る)
- `/login` が一瞬出てから、ネイティブの再ブリッジで読み込み直される

そこで、WebView の中 (`isInNativeWebView()`) の `SIGNED_OUT` は次のとおり扱う。**`MainLayout` が受ける合図は、2.117 でも `SIGNED_OUT` のまま** (§9.5 の裁定 A)。
失効の前に auth-js がセッションを捨てなくなったぶん、`SIGNED_OUT` は「失効してから最大 90 秒」に遅れて届き、ブラウザより先にサーバーの応答が Cookie を消したときは届かない (下の 5.)。どちらの間も `NativeSessionWatcher` が `getSession()` の `null` で `session-expired` を送る (§6.1 の 2.)。`MainLayout` のコードは変えない。

1. `session-expired` を送って、再ブリッジを頼む。localStorage は消さず、`/login` へも移さない
2. ネイティブが読み込み直すと、ページごと入れ替わるので、待ちは自然に終わる
3. `NATIVE_REBRIDGE_WAIT_MS` (15 秒) 待っても読み込み直されなければ、従来どおりログアウトとして扱う (localStorage を消して `/login` へ移る)。
   `session-expired` を知らない旧アプリ、ネイティブ側の回数制限、ネイティブも未ログイン (auth-js 2.117 では、access token が失効していて更新の失敗を控えている間のネイティブも、`getSession()` が `null` なのでここに入る。§9.6 ① の bridge の行・S-23)、通信が極端に遅い場合のため。旧アプリでは、実際の refresh_token を持つセッションの失効が従来より最大 15 秒遅れて `/login` に移るだけ。この待ちは `SIGNED_OUT` が届いたときだけ張られ、5. の経路では張られない
4. 待っている間に、セッションが戻った (`SIGNED_IN` など。別のタブが先に再ブリッジされ、共有の Cookie が新しくなった場合) とき、またはこのレイアウトを離れたときは、待ちをやめる
5. **サーバーの応答が先に Cookie を消したとき (2.117 で起きるようになった順)**: 再ブリッジが通らないまま (ネイティブ側の回数制限・S-23 の `no-session`) 借り物の access token が失効し、ブラウザの auth-js が自分で更新を試みる前 (失敗の控えの間。失効から最大 90 秒) に画面の `/api/*` などの要求が届くと、Next のサーバー (middleware の `getSession()` `lib/supabase/middleware.ts:191`・画面の `getUser()` `:291`) が借り物の値で更新して 400 になり、失効後なので Cookie を消す応答を返す (§9.6 ① の middleware の失効後の行)。ブラウザの auth-js は Cookie の削除を事象として受け取らない (次の契機で保管が空なのを見て `{ session: null, error: null }` を返すだけ) ので、`SIGNED_OUT` は出ず、`MainLayout` は `session-expired` を送らず、3. の待ちも張らない。localStorage は残り、`/login` へも移らない。
   このときの合図は見張りの `getSession()` の `null` だけで、見張りは Cookie が無い間、20 秒ごと (`SESSION_CHECK_INTERVAL_MS`) と前面への復帰のたびに `session-expired` を送り続ける (`NativeSessionWatcher.tsx:65-67`・`:82-87`。Web 側の最小の間隔 15 秒で畳む)。ネイティブの回数制限が解けるか、ネイティブの更新が済んで控えが取れた (S-23) あとの最初の送信で、ネイティブが読み込み直す。ネイティブのセッションも失効していれば、ネイティブは `session-expired` の受け取りで失効を確かめてログアウトを揃える (§6.2)。読み込み直しまでの間、Cookie の要る要求は未ログインとして扱われる (401 で自分から `/login` へ移る画面は移る §8。画面を移ると middleware が `/login` へ回し、ログイン画面が `session-expired` を送る §6.2)。
   2.105 では、前面ではブラウザの tick が失効の 120 秒前に先に捨てて `SIGNED_OUT` を出していたので、この順は起きなかった。この経路でも 3. の待ちを張る案は採らない (§9.5 の裁定 H。§9.3 の S-27)

**ふつうのブラウザ** (`isInNativeWebView()` でない) の `SIGNED_OUT` は、従来どおりすぐログアウトとして扱う (localStorage を消して `/login`。#145)。2.117 では、サーバーで refresh_token が失効したとき (別の端末からの全端末ログアウトなど) の `SIGNED_OUT` は、ブラウザ自身の `getUser()` が 403 を受けたとき (両版で同じ。§9.6 ① の 403 の行) か、access token の失効の後 (最大 90 秒) の更新の失敗で出る (2.105 は失効の 120 秒前からの先回りの更新の失敗でも出た。§9.3 の S-9)。それより先に画面の `/api/*` か画面の移動がサーバーに届くと、middleware (失効の前なら、サーバーのセッションの消失を見つけた `getUser()` の 403 `session_not_found` `lib/supabase/middleware.ts:220`・`:291`。失効の後なら `getSession()` の更新の 400 `:191`。画面の移動は `getUser()` `:291` の中の更新の 400) が Cookie を消す応答を返し、5. と同じくブラウザの auth-js には事象が届かず `SIGNED_OUT` は出ない。`MainLayout` は何もせず (localStorage は残り、`/login` へも移らない)、見張りも居ない (`NativeSessionWatcher` は WebView の中だけ)。次に画面を移ると middleware が `/login?next=…` へ回し、認証の要る `/api/*` は未ログインとして答える (401 で自分から `/login` へ移る画面は移る §8)。localStorage は、次のログアウト (`clearUserScopedLocalStorage` を呼ぶ画面) か、次に `MainLayout` が受ける `SIGNED_OUT` まで残る。
サーバーのセッションが消えたときの 403 の経路では、この順は両版で既に起きている (2.105 でも、前面のブラウザの tick が失効の 120 秒前に捨てるまでの間)。2.117 で増えるのは、ブラウザが失効の前に捨てなくなったぶん、同じ順が失効の後 (ブラウザが自分で捨てるまでの最大 90 秒) にも起き得ることだけ。本改定はこの帰結を受け入れ、コードを変えない (§9.5 の裁定 H2。§9.3 の S-28。仕組みの案は §9.17 の Q-9)

利用者が意図したログアウト (設定・マイページ・組織レイアウトなど) は、この扱いに頼らない。各画面が `signOut()` の前に自分で `clearUserScopedLocalStorage()` を呼び、
続けて `notifyNativeSignOut()` で `sign-out` を送る。このページはログアウト通知済みになるので、`signOut()` が出す `SIGNED_OUT` では `session-expired` を送らず、
ネイティブには `sign-out` だけが届く (§6.2)。再ブリッジの待ち (上の 3.) のタイマーは動くが、`signOut()` のあとの `broadcastSignOut()` が同じタブの `BroadcastChannel` で
すぐ `/login` へ移し、ページごと入れ替わるので、15 秒を待たずに終わる。
ほかのタブからの `BroadcastChannel('auth')` の `SIGNED_OUT` (意図したログアウト) は、従来どおりすぐログアウト扱いにする。

`src/__tests__/app/main-layout-signed-out.test.tsx` が、本物の auth-js (GoTrueClient) で、失効した借り物のセッションの更新を失敗させて `SIGNED_OUT` を出し、この扱いを確かめる。
あわせて、失効の前 (残り 100 秒・60 秒) の更新の失敗では、セッションが残り、`MainLayout` が何も送らず localStorage も消さないことを確かめる (2.117 で変わった前提の固定。it の一覧は §9.9)。失効の後、ブラウザが捨てる前に Cookie が消えたとき (上の 5.) に、`MainLayout` が何も送らず、待ち時間を過ぎても localStorage を消さず `/login` へも移らないことも、WebView とふつうのブラウザ (上の段落) の 2 行で確かめる (§9.9 の A-9)。見張りが Cookie の無いときに送ることは `src/__tests__/components/native-session-watcher.test.tsx:140` (「Web 側のセッションが既に無ければ (Cookie が消えた)、送る」) が確かめる。
同じファイルで、実際の設定画面を `MainLayout` の中に置いてログアウトし、ネイティブに届くのが `sign-out` だけであること (`session-expired` が先に届かないこと) も確かめる。

### 6.4 WebView の Cookie の掃除 (#1612 F7-16 / #1647)

ネイティブのログアウトは Web の `signOut()` (Cookie を消す) を通らないので、同じ掃除の経路 (`clearUserScopedLocalData`) の上で 2 段で消す。正は `apps/mobile/src/lib/webViewUserStorageCleanup.ts` の「Cookie」。

1. ①ログアウトの時点で `clearWebViewNativeCookies()` が React Native の `Networking.clearCookies` で端末の Cookie の置き場を空にする (Android は WebView の `CookieManager` そのもの、iOS は `sharedCookiesEnabled` が WebView を作るたびに書き戻す `NSHTTPCookieStorage`)。未ログインになるどの経路でも走る (§3)。完了を待つかは経路で分ける (§3 の注)
2. ②iOS の `WKWebView` が自分で持つ置き場は①で空にできないので、次に bridge 無しで WebView を開くとき、localStorage の掃除と同じ注入の JS が `USER_SCOPED_COOKIE_NAME_PREFIXES` (`sb-`) の Cookie を `Path=/` で期限切れにする。bridge で開くときは消さない (bridge が同じ名前の Cookie を上書きする)

- ①は `sb-` に限らず端末の Cookie をすべて消すが、未ログインの間に作られて消えると困る Cookie は無い (#1647 で洗った。Web が張るのは `sb-`・`is_native_app`・ログイン中の画面だけの `aiChatBubblePosition` / `handson_tour_force`。未ログインで使う WebView は Turnstile のウィジェットだけ。ネイティブのログインは supabase-js で Cookie を使わない)
- `is_native_app` は利用者のものではない端末の印で、WebViewScreen が毎回 `?mode=app` で開き直す (middleware が張り直す) ので②では消さない。①で消えるのは Android だけ (iOS は WKWebView の置き場に残る。①が空にするのは `NSHTTPCookieStorage` だけ)
- 限界: iOS で①のあと最初に bridge 無しで開いた WebView の最初の要求は、WKWebView に残った前の利用者の Cookie を送る (注入の JS は応答のあとに動く)。サーバーのセッションがログアウトで失効していれば Web の middleware が Cookie を消すので、前の利用者として表示され得るのは、オフラインでログアウトしたときだけ
- bridge で開いたのに code の引き換えに失敗した (期限切れ・使用済み・DB 障害) ときは、`/auth/native-bridge` は WebView に残った Cookie セッションでは進まず、`sb-` の Cookie を消して `/login` へ戻す (#1647)。以前は残った Cookie で `getUser()` が通れば next へ進んでいたので、iOS で前の利用者がオフラインでログアウトしたあと、次の利用者のブリッジの引き換えが失敗すると、前の利用者のまま進み得た。WebView の中のログイン画面は `session-expired` を送り、ネイティブがいまの利用者の新しい code で開き直す (§6.2)。`tests/auth/native-bridge.test.ts` のケース 8 と `tests/integration/security/native-bridge-flow.test.ts` の S-7 が確かめる

## 7. 互換性とリリースの順序

| 変更 | 新しい Web + 旧アプリ | 旧 Web + 新アプリ |
|---|---|---|
| `sign-out` / `session-expired` の送信 | 旧アプリは未知の `type` を無視する。変化なし | メッセージが来ないだけ。ネイティブの処理は何も起きない |
| ログアウトの `sign-out` を `signOut()` の前に送る (§6.2) | 旧アプリは未知の `type` を無視する。変化なし | この変更より前の Web (`session-expired` が先、`sign-out` が `signOut()` のあとに届く) でも、新アプリは処理の最初に控えたセッションで push token を消せる |
| WebView の中の `SIGNED_OUT` (§6.3) | 旧アプリは `session-expired` を無視するので、`NATIVE_REBRIDGE_WAIT_MS` (15 秒) 後に従来どおり localStorage を消して `/login` へ移る。従来より最大 15 秒遅れるだけ | — |
| `native-bridge` の Cookie の refresh_token | コード方式を使うのは新ビルドだけ (旧アプリは旧方式。旧方式は 2026-10-18 00:00 JST の期限を過ぎて 426 を返すので、旧アプリの WebView はブリッジできず、アプリの更新を促すページになる。#1036)。変化なし | — |
| auth-js 2.117 への更新 (#1768。§9) | Web の借り物のセッションが失効の前に捨てられなくなるだけ。旧アプリが受けるメッセージ (`session-expired` / `sign-out`) と意味は同じ。ネイティブの auth-js は 2.105 のまま | ネイティブの自動更新で refresh_token が失効と答えたときの `SIGNED_OUT` が、access token の失効の後 (最大 90 秒後) に届く。経路と掃除は同じ (§3)。access token が期限切れの間に通信が失敗すると、通信が戻ってから更新まで最大約 90 秒かかる (控えの 60 秒 + tick。§3)。その間 (最大約 90 秒) は、まだ開いていないタブの bridge が通らず WebView が Web のログイン画面になり、WebView からの `session-expired` もネイティブが何もしない (S-23・S-24。裁定 G)。期限切れ + オフラインの起動の読み込み中は約 25 秒に縮む。access token が有効なうちのログアウトは、`/logout` が失敗しても `SIGNED_OUT` で未ログインになる (失効していて更新もできないときは従来どおり端末での消去。§3 の `{ error }` の行)。規約の同意画面からの Web の `sign-out` も同じで、成功のときと同じく「閉じる」を出す (S-29)。Web の借り物の扱いは旧 Web のまま |
| Web の Cookie の書式 (ssr 0.12 に `cookieEncoding: 'raw'` を明示。§9.7) | 書く値は 0.1.0 と同じ JSON。旧アプリの WebView は Cookie の名前しか見ない (`sb-` の接頭辞で期限切れにする注入の JS・`Networking.clearCookies` は全部を消す §6.4)。変化なし | — (Cookie は Web が書き、ネイティブは読まない) |
| 旧バンドル (デプロイの前に開いたブラウザのタブ・WebView のページ。ssr 0.1.0 + auth-js 2.105.3) と、Vercel を旧版に戻したとき (#1768) | 新しいサーバー・新しいバンドルが書く Cookie は JSON なので、旧バンドルも旧サーバーも読める。ログアウトされない (S-25・S-26)。ssr の既定の `base64url` で書くと、旧バンドルが Cookie を消して `SIGNED_OUT` を出すので、本改定では書かない (§9.5 の裁定 D) | — |

- Web の変更は、先に本番へ出して問題ない。旧アプリは何も変わらない
- ただし、**コード方式のブリッジ (#1036 / #1289) を載せたビルドと、この変更のネイティブ側は、同じビルドで出す**こと。
  Web 側の refresh_token が使えない値になるため、`session-expired` を処理するネイティブが無いと、WebView は最長 1 時間で未ログインの表示になる
- OTA が無効 (`updates.enabled=false`) で、`expo-secure-store` はネイティブモジュールなので、反映には EAS Build とストアリリースが必要

## 8. 未解決事項

- ログアウトがオフラインで失敗したとき (`signOut()` が `{ error }` を返す、または例外を投げてセッションが残る) の扱いは、#1037 で対応済み。auth-js 2.117 で `{ error }` のあとにセッションが残るのは、access token が失効していて更新もできないとき (§3 の表の `{ error }` の行の (b)。S-22) で、access token が有効なうちの失敗では supabase-js が保管を消して `SIGNED_OUT` を出す (同じ行の (a)。S-20)。`apps/mobile/src/lib/signOut.ts` の `signOutOnDevice` (設定画面の通常のログアウトと、アカウントの画面で退会の API が 401 を返したときのログアウト) と `signOutAfterAccountDeletion` (退会のあと) が、失敗したら `clearStoredSessionLocally()` で保管庫のセッション (と PKCE の code-verifier) を端末だけで消し、呼び出し側から渡された AuthProvider の `clearSession()` で画面の状態も消す (`SIGNED_OUT` が届かないため)。`apps/mobile/__tests__/settings/logout.test.tsx` と `apps/mobile/__tests__/lib/sign-out.test.ts` が確かめる
- ネイティブのログアウト・退会は、Web の画面の `clearUserScopedLocalStorage()` を通らない。代わりに `signOut.ts` がサインアウトの前に `requestWebViewUserScopedStorageClear()` (`apps/mobile/src/lib/webViewUserStorageCleanup.ts`) で掃除の ID を残し、次に開く WebView が `injectedJavaScriptBeforeContentLoaded` の先頭で `USER_SCOPED_LOCAL_STORAGE_KEYS` (`packages/shared/src/user-scoped-storage.ts`。Web と共有の一覧) を消す (#1037)
- Web の設定・マイページのログアウト / 退会ボタンは、WebView 内では出さない (#1037。PR #1079 で main に入った。判定は `src/hooks/useAccountActionsPlacement.ts`)。この変更の `sign-out` 通知は、隠れなかった経路 (凍結ページなど) の二重の備え
- `invite/[token]` の「ログアウトしてやり直す」は `notifyNativeSignOut()` / `broadcastSignOut()` を通らないのでネイティブへ直接は通知しない (WebView の主要な導線ではない)。
  Web のログアウトのあとに移るログイン画面が `session-expired` を送り、ネイティブがサーバーで失効を確かめて、控えたセッションでログアウトを揃える (§6.2)
- 再ブリッジは、開いていたパスではなく画面の既定のパス (または検証を通った直前の `initialPath`) を開き直す。入力中のフォームの内容は失われる
- `MainLayout` 以外にも、API が 401 を返したときに自分で `/login` へ移る画面がある (献立ページの生成ポーリング `weeklyMenuGenerating` / `singleMealGenerating` を消して移る処理、設定の書き出しなど)。
  WebView の借り物のセッションが失われた直後の 1〜3 秒 (ネイティブの再ブリッジが終わる前) にそのリクエストが重なると、その画面は従来どおり `/login` へ移る。
  `MainLayout` の扱い (§6.3) は、ほぼすべての画面に共通する localStorage の削除と `/login` への移動を避けるもので、個々の画面の 401 の扱いは変えていない
- 起動時の読み込み中の表示 (§3): access_token が期限切れのままオフラインで起動すると、約 25 秒続く (supabase-js の更新のやり直し。auth-js 2.105 のビルドでは約 50 秒)。保存済みのセッションで先に画面を出し、更新と検証を裏で行う設計にすれば無くせるが、
  検証前のセッションで画面を出すことになる (失効済みでも一瞬ホームが見える)。未対応
- Android の `react-native-webview` は `window.ReactNativeWebView` を `addJavascriptInterface` で全フレームに出す。自分のオリジンのページに埋め込まれた他オリジンの iframe からも
  `sign-out` / `session-expired` を送れ、`nativeEvent.url` (メインフレームの URL) の検査を通り得る。影響は強制ログアウトと再ブリッジの要求まで。`download` の送信元の検査と同じ信頼モデルで、
  自分の Web が他オリジンの iframe を埋め込まない限り起きないため、いまは対処しない
- `NATIVE_REBRIDGE_WAIT_MS` (15 秒): 回線が遅いと、ネイティブの再ブリッジ (`getUser()` + コードの発行 + ページの読み込み) が間に合わず、避けたかった localStorage の削除と `/login` への移動が起きる。
  ネイティブが受け付けたことを Web に返す仕組み (`injectJavaScript`) を入れるか、待ち時間を延ばす余地がある。旧アプリで行き止まりになるのを避ける 15 秒を優先して、いまは変えない
- ログアウトのあと、同じタブの `MainLayout` が `BroadcastChannel` で `window.location.href = '/login'` と全体を読み込み直す。ページごと入れ替わるので `notifyNativeSignOut()` の記録が初期化され、
  ログイン画面が `session-expired` をもう一度送る。ネイティブ側で `ignored` (ログアウト処理中) か `no-session` (ログアウト済み) になるだけで害は無いので、そのままにしている。
  `sessionStorage` に印を残して抑える案は、印が残る期間の管理が要り、本当に再ブリッジが要るときに止めてしまう危険のほうが大きい
- push token を DB 側で端末ごとに 1 ユーザーへ紐づけ直す (別ユーザーのログインで古い行を消す) には、サービスロールの処理が要る。サーバー側の送信は `06-push-send.md` (送信待ち `push_outbox` と worker `GET /api/cron/push-outbox`。#1136)
- auth-js 2.117 への更新 (#1768) で残る未解決は §9.17

## 9. `@supabase/supabase-js` 2.117.3 と `@supabase/ssr` 0.12.7 への更新 (#1768)

Issue #1768 の本文が範囲の正本 (Dependabot #1590・仕分け #1621 の見送り分)。本章は、2.117 で変わる auth-js の挙動のもとで借り物のセッションを捨てる合図を決め直し (§9.2〜§9.6)、ssr 0.12 の Cookie の読み書きへ移行し (§9.7・§9.8)、赤になる既存のテストを新しい挙動の意味のある assert に書き直し (§9.9)、apps/mobile の版 (§9.10) と段分け (§9.13) を決める。
行番号は、npm の tgz を展開した `package/dist/main/` (auth-js 2.117.3・2.105.3、ssr 0.12.7) と `package/dist/index.js` (ssr 0.1.0)、リポジトリは origin/main `7d05ff10` (2026-10-17) のもの。設計の枝が取り込んだ `81c1e838` (#1833。13b 段 B2) との違いは、本章が数える母集合の 2 か所だけ: §9.1 の製品の import の閉包は `81c1e838` では 77 ファイル (`scripts/` 17。#1836 が scripts の test-full-pipeline.mjs を消す前)、§9.9 G の母集合は 273 ファイル (#1837 が `tests/integration/rls/billing-manual-grant-rpc.test.ts` を足す前)。本章が行を引くほかのファイルは両方で同じ。更新後の木では `node_modules/@supabase/auth-js/dist/main/` と `node_modules/@supabase/ssr/dist/main/` に同じファイルがある。

### 9.1 前提の実測 (file:line)

**auth-js 2.117.3 (`dist/main/`)**

| 事実 | 場所 |
|---|---|
| 定数: `AUTO_REFRESH_TICK_DURATION_MS` = 30 秒・`AUTO_REFRESH_TICK_THRESHOLD` = 3・`EXPIRY_MARGIN_MS` = 90 秒 (2.105.3 と同じ値)。**新設** `REFRESH_FAILURE_COOLDOWN_MS` = 2 tick = 60 秒 | `lib/constants.js:6`・`:9`・`:13`・`:14-21` |
| 更新の失敗の控え `lastRefreshFailure` (refresh_token ごと。成功・他タブの `TOKEN_REFRESHED` / `SIGNED_IN`・`_removeSession` で消える) | `GoTrueClient.js:105-119`・`:282-284`・`:4430` |
| `_callRefreshToken`: 同じ refresh_token で控えが有効 (`Date.now() < expiresAt`) なら `/token` を呼ばず控えた結果を返す | `GoTrueClient.js:4211-4216` |
| `_callRefreshToken` の失敗 (やり直せないエラー = `AuthRetryableFetchError` でない `AuthError`): 保管の `expires_at * 1000 > Date.now()` なら**セッションを残す** (`_removeSession` を呼ばない)。失効後なら `_removeSession` → `SIGNED_OUT` | `GoTrueClient.js:4295-4334` (分岐 `:4299`・残す `:4310-4314`・捨てる `:4316`) |
| `_callRefreshToken` の失敗の控え: やり直せるエラー (`AuthRetryableFetchError`。5xx・接続の失敗) を**含む**どの `AuthError` でも、上の分岐の**外**で失敗を `REFRESH_FAILURE_COOLDOWN_MS` 控える。やり直せるエラーではセッションを捨てない (失効後でも) | `GoTrueClient.js:4297`・`:4324-4328` (控え)。成功で控えを消す `:4291` |
| `_refreshAccessToken`: やり直せるエラーは指数バックオフ (200 ms から倍々) でやり直し、次の待ちが tick (30 秒) を越えるところでやめる (待ちの合計は約 25 秒) | `GoTrueClient.js:4021-4058` (待ち `:4031-4033`・やめる条件 `:4042-4047`) |
| `refreshSession()` (引数なし): 保管の refresh_token で `_callRefreshToken` を呼ぶので、控えに当たる。控えの間は、access token が有効で `__loadSession` が保管を返しても、そのあとの `_callRefreshToken` が控えた失敗を返し、結果は `{ data: { session: null }, error }` | `GoTrueClient.js:3220-3240` (`:3234`・`:3235-3236`) |
| `__loadSession` (= `getSession()`): 残り 90 秒未満で更新 → 失敗しても保管が有効なら**その保管を返す**。保管が無い・失効済みなら `{ session: null, error }` | `GoTrueClient.js:2540-2547`・`:2563-2573` |
| `_recoverAndRefresh` (初期化・復帰): 残り 90 秒未満で更新。失敗は `_debug` だけ (`console.error` も `_removeSession` もしない) | `GoTrueClient.js:4126-4145` |
| tick: `floor(残り / 30 秒) <= 3` (= 残り 120 秒未満) で更新。ロック無しの既定では更新中の tick を飛ばす | `GoTrueClient.js:4688-4691`・`:4702-4706` |
| `_startAutoRefresh`: 30 秒の `setInterval` と、直後の 1 回 (`setTimeout` 0) | `GoTrueClient.js:4466`・`:4487-4490` |
| 復帰 (`visibilitychange` → visible): `_recoverAndRefresh` | `GoTrueClient.js:4752-4791` (`:4782`) |
| `_removeSession`: 控えを消し、保管・PKCE の verifier・`-user` を消して `SIGNED_OUT` | `GoTrueClient.js:4421-4439` |
| ロック: 既定は無し (`lock = null`。`settings.lock` を渡したときだけ)。`_useSession` は直列化しない | `GoTrueClient.js:157`・`:202-206`・`:2494-2507` |
| `getUser()`: `403 session_not_found` (`AuthSessionMissingError`) で `_removeSession` (2.105.3 と同じ) | `GoTrueClient.js:2724-2731` (2.105.3: `:2506-2511`) |
| `mfa.enroll`: TOTP の `qr_code` に `data:image/svg+xml;utf-8,` を前置 (2.105.3 と同じ文) | `GoTrueClient.js:4893-4895` (2.105.3: `:4368-4370`) |
| `_updateUser`: 保管にセッションが無いと `AuthSessionMissingError` (2.105.3 と同じ) | `GoTrueClient.js:2868-2870` (2.105.3: `:2646-2648`) |
| `_signOut`: 保管にセッション (access token) が無ければ GoTrue を呼ばず `_removeSession` だけして `{ error: null }` (2.105.3 と同じ) | `GoTrueClient.js:3427-3458` (`:3437-3456`。2.105.3: `:3182-3208`) |
| `admin.signOut(jwt, scope)`: `POST /logout?scope=` を渡された JWT で呼ぶ (2.105.3 と同じ) | `GoTrueAdminApi.js:67-78` (両版で同じ行) |
| `/token` の URL は `token?grant_type=refresh_token` のまま (テストの `refreshRequests` が引く語) | `GoTrueClient.js:4035` |
| `handleError`: 本文が JSON でなく status が 500/501/502/503/504/520〜530 なら `AuthRetryableFetchError(message, status)` (message は `statusText`、空なら `'HTTP <status>'`)。JSON なら本文の `msg` / `message` | `lib/fetch.js:29-54` (`:44-48`)・`lib/errors.js:238-243` |
| サブパスの import `@supabase/auth-js/dist/main/lib/constants` は引き続き解決する (`package.json` に `exports` が無い。`main` = `dist/main/index.js`) | `package.json:22-24` |
| 実行環境の API: `navigator.locks` / `BroadcastChannel` / `crypto.subtle` / `structuredClone` / `TextEncoder` の参照はいずれも 2.105.3 にもあり、新しく要る API は無い (dist の grep) | — |
| `_useSession` を通る呼び出しは `__loadSession` の結果を受け取る: 引数なしの `getUser()` (`_getUser` `:2707-2722`)・`updateUser` (`:2863-2870`)・`signOut` (`:3428`)・`mfa.challenge` / `mfa.verify` (`:4948-4955`・`:4906-4913`。`mfa.challengeAndVerify` は 2 つを順に呼ぶ `:4999-5011`)・`mfa.unenroll` (`:4851-4858`)・引数なしの `refreshSession()` (`:3220-3235`)。`mfa.listFactors` は `getUser()` を (`:5015-5020`)、引数なしの `mfa.getAuthenticatorAssuranceLevel()` は `getSession()` を通る (`:5075-5084`)。残り 90 秒未満で更新が失敗しても access token が有効なら保管を受け取り、その token で GoTrue を呼ぶ。2.105.3 は `{ session: null, error }` を受け取り、呼び出しはそのエラー (または `AuthSessionMissingError`) で終わった | `GoTrueClient.js:2494-2507`・`:2563-2573` (2.105.3: `:2381-2384`) |
| `_signOut` の失敗は 2 つの枝に分かれる。**①セッションの読み込みの失敗** (`_useSession` が受け取る `__loadSession` の結果が `{ session: null, error }` = 保管の access token が失効していて、更新がやり直せる失敗 (5xx・接続の失敗) で終わったか、失敗の控えの間): `AuthSessionMissingError` でなければ、`/logout` を呼ばず、保管も消さず、`SIGNED_OUT` も出さずに `{ error }` を返す (両版で同じ。`_removeSession` を通らない)。失効後の更新がやり直せない失敗 (400 など) なら、`_callRefreshToken` が先に `_removeSession` → `SIGNED_OUT` してから、同じくここで `{ error }` を返す (両版で同じ)。2.105.3 は残り 90 秒未満の失効前でも、更新が失敗すればここで返った (`__loadSession` が `{ session: null, error }` を返した) が、2.117.3 は失効前なら保管を受け取って ② へ進む。**②`/logout` の失敗** (読み込みが通った = access token が有効): `admin.signOut` が 401 / 403 / 404 と `AuthSessionMissingError` 以外のエラー (5xx・接続の失敗の `AuthRetryableFetchError` を含む) を返すと、scope が `others` でなければ `_removeSession` (→ `SIGNED_OUT`) してから `{ error }` を返す。2.105.3 は保管を残したまま `{ error }` を返した (`SIGNED_OUT` も無い)。scope `others` はどちらの版も保管を消さない | ① `GoTrueClient.js:3433-3435` (2.105.3: `:3185-3187`)・読み込みの失敗 `:2563-2573` (2.105.3: `:2381-2384`)。② `:3439-3449` (`:3446-3448`。2.105.3: `:3191-3198`) |
| `getClaims(jwt)`: 期限切れの JWT は `AuthInvalidJwtError` にして `{ data: null, error }` で返す。2.105.3 は `validateExp` の `Error` (`AuthError` でない) をそのまま投げた | `GoTrueClient.js:5529-5534` (2.105.3: `:4834`) |
| `_setSession`: 渡された access token が失効していなければ `_getUser(access_token)` で確かめて保存し `SIGNED_IN` (`/token` を呼ばない。2.105.3 と同じ)。失効していれば渡された refresh_token で `_callRefreshToken` (保管と別の token なので控えに当たらない `:4211-4213`) | `GoTrueClient.js:3036-3075` (`:3050-3058`・`:3059-3075`) |
| PKCE の verifier: 始めるたびに 3 つ書く (flow ごとの `<storageKey>-flow-<flow id>-code-verifier`・一覧 `<storageKey>-flows-code-verifier`・従来の `<storageKey>-code-verifier`)。同時に置く flow は `PKCE_MAX_CONCURRENT_FLOWS` = 5 本まで。flow id を渡さない `exchangeCodeForSession(code)` は、ブラウザでなければ従来のキーを読み、成功・失敗のどちらでも従来のキーだけを消す。redirect の URL への `sb_flow_id` の付加は `experimental.appendPkceFlowIdToRedirects` のときだけ (`experimental` の既定は `{}` で、付かない)。`_removeSession` は一覧にある flow と従来のキーを全部消す。verifier を書くのは `flowType: 'pkce'` のときだけで、`createClient` の既定は `'implicit'` (verifier を書かず、`exchangeCodeForSession` も verifier を求めない)。2.105.3 は従来のキー 1 つだけ | `lib/helpers.js:303`・`:305`・`:327-341`・`:349-356`・`:362-366`・`:394-401`・`:424-435`・`lib/constants.js:45`・`:50`・`GoTrueClient.js:24`・`:182`・`:1609-1625`・`:1627-1629`・`:4433`・`:4838-4843` (2.105.3: `lib/helpers.js:264-274`)。supabase-js 2.117.3 の既定 `flowType: "implicit"` は `dist/index.cjs:36` |
| 型の名前: `Session`・`Factor`・`User` は auth-js の `lib/types.d.ts:283`・`:371`・`:402`。supabase-js 2.117.3 は realtime-js と auth-js を再 export し (`RealtimeChannel` はここから)、`SupabaseClient`・`PostgrestError`・`createClient` を export する | `dist/index.d.mts:6-7`・`:829` (supabase-js 2.117.3) |

**auth-js 2.105.3 (比較。`dist/main/`)**: `_callRefreshToken` の失敗はやり直せないエラーなら**必ず** `_removeSession`、やり直せるエラーなら捨てず、どちらも控えは無い (次の契機でまた `/token` を呼ぶ。`GoTrueClient.js:3928-3936`)、`__loadSession` は失敗を `{ session: null, error }` にする (`:2381-2384`)、`_recoverAndRefresh` は失敗を `console.error` に出して `_removeSession` (`:3859-3866`)、ロックは `navigator.locks` があればそれ・無ければ `lockNoOp` で、`_acquireLock` の待ち行列 (`pendingInLock`) が同じクライアントの処理を直列にしていた (`:140-154`・`_acquireLock` は `:2252` から)。`handleError` は 5xx を本文を読む前に `AuthRetryableFetchError(_getErrorMessage(Response), status)` にし、`Response` を `JSON.stringify` した `'{}'` が message だった (`lib/fetch.js:32-41`)。

**ssr 0.12.7 (`dist/main/`)**

| 事実 | 場所 |
|---|---|
| `createServerClient`: `cookieEncoding` の既定は `base64url`。auth の設定は `flowType: 'pkce'`・`autoRefreshToken: false`・`persistSession: true`・`skipAutoInitialize: true` (最初の `getSession()` / `getUser()` / `getClaims()` まで読まない) | `createServerClient.js:18-21`・`:32-42` |
| `createServerClient`: `SIGNED_IN` / `TOKEN_REFRESHED` / `USER_UPDATED` / `PASSWORD_RECOVERY` / `SIGNED_OUT` / `MFA_CHALLENGE_VERIFIED` で、溜めた書き込みを `applyServerStorage` でまとめて `setAll` に渡す | `createServerClient.js:52-70` |
| `createBrowserClient`: `cookies` を省くと (`get` も `getAll` も無い object も同じ) `document.cookie` を読み書きする。`isSingleton` の既定はブラウザなら true | `cookies.js:77-79`・`:165-169`・`createBrowserClient.js:14-18`・`:25-28` |
| `get` / `set` / `remove` は動くが非推奨 (型は `@deprecated`)。`set` / `remove` の無い server client は書くときに `console.warn` | `cookies.js:98-145` (`:139`)・`createServerClient.d.ts:3-12` |
| `getAll` / `setAll` の経路。`setAll` の第 2 引数は応答に付けるべきヘッダー (`Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0`・`Expires: 0`・`Pragma: no-cache`。同じ server client では最初の書き込みのときだけ中身がある) | `cookies.js:146-159`・`:323-331`・`:505-509`・`types.d.ts:23-58` |
| 読み: `base64-` で始まる値は base64url を戻して JSON として検証し、壊れていれば `console.warn` して「無い」扱い。**始まらない値 (0.1.0 が書いた JSON) はそのまま返す** | `cookies.js:45-65` |
| 書き (server): 変わった Cookie だけを書き、古いチャンク (分割の数が減ったとき) を `maxAge: 0` で消す。書き (browser) も同じ | `cookies.js:435-509` (`:444-461`)・`:210-267` |
| 値の書式: `cookieEncoding` が `base64url` (既定) なら `base64-` + base64url(JSON)、`raw` なら auth-js が渡す JSON のまま (0.1.0 と同じ値)。分割 (`createChunks`。URL エンコードした長さでチャンクの上限 3,180 バイト) は 0.1.0 と同じ処理。読み (`decodeChunkedCookieValue`) は `cookieEncoding` に依らず両方の書式を読む | `cookies.js:9`・`:214-217`・`:449-452`・`createServerClient.js:20`・`:67`・`createBrowserClient.js:27`・`utils/chunker.js:8`・`:23-64` (0.1.0: `dist/index.js:54-85`) |
| Cookie の既定: `path: '/'`・`sameSite: 'lax'`・`httpOnly: false`・`maxAge` 400 日 (0.1.0 は 1,000 年。ブラウザは 400 日で切る) | `utils/constants.js:4-11` (0.1.0: `dist/index.js:46-51`) |
| 型: `CookieMethodsServer = { encode?; getAll; setAll? }`・`CookieMethodsBrowser = { encode?; getAll?; setAll? }`・`CookieOptions = Partial<SerializeOptions>` (`cookie` 1.x) | `types.d.ts:3`・`:66-89`・`:97-128` |
| peer: `@supabase/supabase-js ^2.114.0`。依存: `cookie ^1.0.2` だけ | npm の `package.json` |

**ssr 0.1.0 (比較。`dist/index.js`)**: `createBrowserClient` に options を渡すと `cookies` が `undefined` で上書きされ `typeof cookies.get` で落ちるので `cookies: {}` が要った (`:133-138`)。型でも `cookies: CookieMethods` が必須 (`index.d.ts:17-21`)。Cookie の値は JSON そのまま (`combineChunks` `:86-103`)。読みは `combineChunks` がつないだ値をそのまま auth-js に渡し、`base64-` の接頭辞を知らない。auth-js 2.105.3 の `getItemAsync` は `JSON.parse` に失敗すると文字列のまま返し (`lib/helpers.js:129-139`)、`__loadSession` (`GoTrueClient.js:2336-2343`) と `_recoverAndRefresh` (`:3848-3853`) は `_isValidSession` が偽 (文字列) なら `_removeSession` (保管 = Cookie を消して `SIGNED_OUT`) を呼ぶ。つまり **ssr 0.1.0 + auth-js 2.105.3 のクライアント (デプロイの前に開いたタブの JS・ロールバックした旧サーバー) は、`base64-` の Cookie を読むとセッションを消す** (§9.5 の裁定 D)。

**リポジトリ (origin/main `7d05ff10`)**

| 事実 | 場所 |
|---|---|
| 版: ルートの `package.json` は `@supabase/ssr ^0.1.0`・`@supabase/supabase-js ^2.78.0`、`apps/mobile/package.json` は `@supabase/supabase-js ^2.78.0`。`package-lock.json` の実体は auth-js / supabase-js / postgrest-js / realtime-js / storage-js / functions-js が 2.105.3、ssr が 0.1.0 で、`apps/mobile/node_modules/@supabase/*` は無い (ワークスペースの 1 コピーに巻き上げ) | `package.json:37-38`・`apps/mobile/package.json:24`・`package-lock.json:5523-5607` |
| Node: `engines.node` = `22.x`・`.nvmrc` = 22 (supabase-js 2.117.3 の `engines.node >= 22`) | `package.json:32-34` |
| Web の Supabase の呼び出し口 (ssr): ① `lib/supabase/middleware.ts:147-184` (`get` / `set` / `remove`。`request.cookies` と `supabaseResponse.cookies` の両方に書く)・`:67` と `lib/legal-consent-minor.ts:13` の `ReturnType<typeof createServerClient>` (型だけ) ② `lib/supabase/server.ts:36-65` (`get` / `set` / `remove`。`set` / `remove` は `try` で包む) ③ `lib/supabase/client.ts:8` (`createBrowserClient(url, key)`。options 無し) ④ `src/proxy.ts:9`・`:54` (`updateSession` を呼ぶだけ) ⑤ `src/__tests__/helpers/real-auth-js.ts:65-72` (`createBrowserClient` に `cookies: {}`)。ssr の値の import (`createServerClient` / `createBrowserClient`) は製品コードでは `lib/supabase/` の 3 ファイルだけ (`git grep "@supabase/ssr" origin/main`。ほかは `vi.mock('@supabase/ssr')` のテストと型だけの import)。**`src/lib/supabase/` は origin/main に無い** (`git ls-tree origin/main src/lib/supabase` が空。Supabase のクライアントを作る口は `lib/supabase/` だけで、`src/lib/` には無い)。`src/app/api/org/members/route.ts:1` の `createServerClient` は `@/lib/supabase/server` の `createClient` の別名 (`import { createClient as createServerClient }`。この別名はこの 1 ファイルだけ) で、ssr の `createServerClient` ではない (tsconfig の `@/*` は `./src/*` → `./*` の順に解決し、`@/lib/supabase/server` は `lib/supabase/server.ts` に当たる。`:20`・`:93` の呼び出しは ② を通る) | 左のとおり |
| Supabase の呼び出し口 (supabase-js の `createClient` を値で import。ssr を通らない) ⑥: `lib/supabase/server.ts:2`・`:20-21` (`getSupabaseAdmin`。service_role)・`src/lib/db-logger.ts:9`・`:80-81` (service_role)・`src/app/api/health/route.ts:22`・`:101-102` (anon)・`apps/mobile/src/lib/supabase.ts:3`・`:54-63`。前 3 つは `autoRefreshToken: false`・`persistSession: false` で、更新の失敗の扱い (2.117 の変化) も Cookie (ssr 0.12 の変化) も通らない。`supabase/functions/` (Deno) は `supabase/functions/deno.json:10` の `jsr:@supabase/supabase-js@2.99.1` で、npm の版とは別 (本改定で変えない)。`scripts/` の `.mjs` は手で流す運用の道具で、npm の版に従う (呼び方は変わらない) | `tests/supabase-service-role-client-scan.test.ts:71-90` の `SUPABASE_JS_CLIENT_ALLOWLIST`と同じ 3 ファイル + モバイル |
| middleware の更新の契機: `/api` は `getSession()` (`:191`) と `getUser()` (`:220`)、画面は `getUser()` (`:291`)。更新した Cookie は `supabaseResponse` に溜め、置き換える応答へは `withSessionCookies` (`:39-44`) で引き継ぐ | `lib/supabase/middleware.ts` |
| native-bridge: Cookie の**名前**だけを見る (`SUPABASE_AUTH_COOKIE_PATTERN` `:50`・`clearSupabaseAuthCookies` `:127-134`)。`setSession` で書く (`:141-156`) | `src/app/(auth)/auth/native-bridge/route.ts` |
| `MainLayout` の `SIGNED_OUT` の扱い (§6.3) と、2.105 の挙動を前提にしたコメント | `src/app/(main)/MainLayout.tsx:146-173` (`:157-167`) |
| `NativeSessionWatcher`: `SESSION_CHECK_INTERVAL_MS` = 20 秒・`REFRESH_AHEAD_SECONDS` = 180・`getSession()` が `null` なら送る・借り物でなければ何もしない | `src/components/native-app/NativeSessionWatcher.tsx:12`・`:34`・`:58-79` |
| `native-auth-bridge.ts`: 2.105 の閾値のコメント `:54-66`・`SESSION_EXPIRED_MIN_INTERVAL_MS` = 15 秒 `:79`・`NATIVE_REBRIDGE_WAIT_MS` = 15 秒 `:90` | `src/lib/native-auth-bridge.ts` |
| 赤になるテスト ①: `main-layout-signed-out.test.tsx` の `it.each([100, 60])` (`:200-218`)・待ち時間 (`:220-236`)・離脱 (`:238-255`)・セッションが戻る (`:257-276`)・ふつうのブラウザ (`:361-372`) の計 6 件。どれも「残り 60〜100 秒の借り物の更新の失敗 → `SIGNED_OUT`」を前提 (`getSession()` が `null`) | `src/__tests__/app/main-layout-signed-out.test.tsx` |
| 赤になるテスト ②: `integration-auth-transient-retry.test.ts:100-107` (`error?.message` が `'{}'`)。やり直しの判定は status だけを見る (`tests/integration/helpers/auth-transient-retry.ts:200`) ので、仕組みは変わらない | `tests/integration-auth-transient-retry.test.ts` |
| 緑のまま (本物の auth-js): `native-session-authjs-thresholds.test.ts` (更新を**試みる**ことだけを見る)、`main-layout-signed-out` の残り 3 件 (`:278`・`:291`・`:337`。どれも残り 3,000 秒で更新が走らない)、apps/mobile の本物の supabase-js を使う 3 本 =  `supabase-client.test.ts` (`setSession → getSession → signOut`)・`webViewBridge.supabase.test.ts` (更新が成功する経路)・`web-view-auth-messages.real-auth.test.ts` (`getUser()` の 403 → `_removeSession`。`:173` の `/token` の 400 は呼ばれない経路の備え) | 左のとおり |
| Cookie の値を JSON として読むテスト: `tests/integration/security/native-bridge-flow.test.ts:173-188` (`readSession`)・`tests/integration/security/operator-mfa.test.ts:163-180` (`sessionFromSetCookie`。`:139` に「0.1.0」の注記)・`tests/e2e/fixtures/auth.ts:140-146`。JSON の Cookie を**書く**側 (`operator-mfa.test.ts:155`・`e2e/fixtures/auth.ts:232-239`・`fresh-user.ts:261-273`・`global-setup.ts:188-193`) は 0.12 でもそのまま読める。本改定は `cookieEncoding: 'raw'` (§9.7) なので、サーバーが書く Cookie も JSON のままで、読む側も変わらない | 左のとおり |
| デプロイの skew の対策 (`deploymentId`・Vercel の skew protection) の設定は無い (`git grep -n -i -E "deploymentId\|skew" origin/main -- 'next.config.*' vercel.json` が 0 件)。デプロイの前に開いたブラウザのタブ・WebView のページは、読み込み直すまで旧バンドル (ssr 0.1.0 + auth-js 2.105.3) のまま動き、新しいサーバーと新しいバンドルのタブが書いた Cookie を読む | `next.config.mjs`・`vercel.json` |
| ネイティブの WebView の bridge: `WebViewScreen.tsx:217` が `getSessionForBridge(supabase.auth)` を呼ぶ。`getSessionForBridge` (`webViewBridge.ts:560-583`) は `auth.getSession()` (`:565`) の結果が無ければ null、残りが `BRIDGE_MIN_TOKEN_TTL_SEC` (= 150 + 60 = 210 秒。`:54`・`:60`・`:69`) 未満なら `refreshSessionOnce` (`:529-545`。中で `auth.refreshSession()` `:535`) を呼び、更新に失敗したら残りが `BRIDGE_SERVER_MIN_TOKEN_TTL_SEC` (150 秒) 以上ならいまの token、未満なら null (`:579`)。null なら `WebViewScreen` は code を取らずに直接の URL を開く (`:216-218`)。bridge は `effectivePath` が変わったときだけ走る (`:206-262` の `useEffect` の依存は `[effectivePath]`) | `apps/mobile/src/lib/webViewBridge.ts`・`apps/mobile/src/components/web/WebViewScreen.tsx` |
| ネイティブの `session-expired` の受け取り: `handleSessionExpired` は最初に `getSession()` で控えを取り (`webViewAuthMessages.ts:203-217`・`:249`)、控えが無ければ `no-session` で何もしない (`:250`)。ログイン画面は描画のときに 1 回 `session-expired` を送る (`src/app/(auth)/login/page.tsx:55`) | 左のとおり |
| `src/lib/auth/sessions/session-claims.ts`: `readSessionAuth(auth, authorization)` (`:40-47`) は Bearer か `auth.getSession()` (`:41`) の access token を `auth.getClaims(token)` (`:43`) に渡し、`error` か `data` 無しなら null (`:44`)。呼ぶのは `requireSessionUser` (`:89`。origin/main の製品コードには呼び出し元が無く、単体テスト `src/lib/auth/__tests__/sessions-session-claims.test.ts` だけ) と `recordWebLoginContextFromRequest` (`src/lib/auth/sessions/web-login-context.ts:32`。ログインの直後の session の access token を Bearer で渡す。例外は `:45-50` で warn の stage `exception`、null は `:33-35` で stage `claims`) | 左のとおり |
| middleware のテストのモックが `options.cookies.set(...)` を呼ぶ: `middleware-maintenance.test.ts:225`・`:436`、`middleware-legal-consent.test.ts:113-119`、`middleware-legal-consent-api.test.ts:128-134` | `lib/supabase/__tests__/` |
| apps/mobile: `createClient(url, anonKey, { auth: { storage: secureSessionStorage, storageKey, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } })`。OTA は無効 (`updates.enabled: false`) | `apps/mobile/src/lib/supabase.ts:54-63`・`apps/mobile/app.json:66-70` |
| 2.105 の挙動を書いたコメント (apps/mobile): `webViewAuthMessages.ts:34-36`・`__tests__/lib/web-view-auth-messages.real-auth.test.ts:12-13`・`__tests__/lib/web-view-auth-messages.test.ts:472-473`・`:492`・`:540` | 左のとおり |
| 他の設計書の版の記述: `cross/12-operator-mfa.md:97`・`:100`・`:1059`・`:1484`、`cross/16-auth-history-sessions.md:84`・`:92`。`cross/14-parental-consent.md:1325-1329` は `createServerClient` の型だけ (変わらない)。`mobile/01-architecture.md` の 90 秒 (`EXPIRY_MARGIN_MS`) の行は値が変わらない | 左のとおり |

**auth の呼び出しの閉包 (製品のコードと apps/mobile。origin/main `7d05ff10` で数え、#1720 段 B・段 C (`307ae1cf`・`9dd73f23`) で増えた・無くなった呼び出しを反映した数。file:line は `7d05ff10` の行番号で、反映で足した呼び出しだけ `9dd73f23` の行番号)**

母集合は `git grep -n -E '(^|[^A-Za-z0-9_$])auth\.[A-Za-z.]+\(' origin/main -- src lib apps/mobile packages ':!**/__tests__/**' ':!*.test.*'` の 364 行 (origin/main `9dd73f23`) から、コメントの行 (`*`・`//`・`/*` で始まる) を除いた 315 行に、改行で続ける 2 行を足した **317 呼び出し** (Web 273・apps/mobile 44 = `apps/mobile/src` 22 と画面 `apps/mobile/app` 22)。`7d05ff10` では 368 行・321 行・323 呼び出し (Web 276・apps/mobile 47 = 25 と 22) で、差は #1720 段 B が足した 1 つ (W-1) と、段 C が無くした 8 つ (W-6 の 1・W-9 の 3・M-3 の 2・M-4 の 1・M-8 の 1) と足した 1 つ (M-1)。正規表現は `supabase.auth.getUser(` のような `.auth.` の形と、`auth` を引数で受けて呼ぶ形 (`auth.getSession(`。`auth` の前が識別子の文字でも点でもない) の両方を拾う。後者は 4 行 (W-10・M-9)。改行で続ける形 (`supabase.auth` の次の行が `.getUser()`) は 1 行の正規表現に掛からないので、`git grep -n -E '^[[:space:]]*\.(auth|getSession|getUser|refreshSession|getClaims|setSession|signOut|exchangeCodeForSession|onAuthStateChange|updateUser|signInWith[A-Za-z]+|signUp|verifyOtp|resend|resetPasswordForEmail|getAuthenticatorAssuranceLevel|listFactors|challengeAndVerify|mfa)[^A-Za-z0-9_]'` (同じ範囲) で拾う: `src/app/handson-tour/menu/page.tsx:92-93`・`src/app/handson-tour/photo/page.tsx:112-113` の引数なしの `getUser()` 2 つ (W-2)。ほかの名前で auth を受けて呼ぶ形は無い (`git grep -n -E '[]A-Za-z0-9_$)]\.(getSession|getUser|refreshSession|getClaims|setSession|signOut|exchangeCodeForSession|onAuthStateChange|updateUser|signInWith[A-Za-z]+|signUp|verifyOtp|resend|resetPasswordForEmail|getAuthenticatorAssuranceLevel|listFactors|challengeAndVerify|challenge|verify|enroll|unenroll)\('` の同じ範囲の 330 行 (`9dd73f23`。`7d05ff10` では 337 行) から、`.auth.` と `auth.` を含む行とコメントの行を除くと 0 行)。`supabase.auth` を引数で渡す行は `WebViewScreen.tsx:217` (M-9)・`session-claims.ts:89` (W-10)・`recordWebLoginContextFromRequest(supabase.auth, …)` の 4 行 (`src/app/(auth)/auth/callback/route.ts:65`・`:84`・`:105`・`src/app/api/auth/login/route.ts:204`。中で `readSessionAuth` を呼ぶ W-10) で、渡した先の呼び出しは W-10・M-9 で数える。呼び出しの種類はこの表の行で尽きる (表に無い種類の呼び出しは無い)。「規則 U」= §9.1 の `_useSession` の行 (残り 90 秒未満で更新が失敗しても、access token が有効なら保管の token で GoTrue を呼ぶ。2.105.3 はそのエラーで終わった。サーバーが失効と答えれば 401 / 403 で、`getUser()` の 403 は `_removeSession`。どちらの版も同じ)。Web のサーバーのクライアント (`lib/supabase/server.ts`・`middleware.ts`) は要求ごとに作るので、失敗の控え (60 秒) はその要求の中でしか効かない。

| 群 | 呼び出し (origin/main の file:line) | 行数 | 2.117.3 での扱い |
|---|---|---|---|
| W-1 Web・service_role (セッションを持たない) | `auth.admin.*` 13 行 (`getUserById`: `src/app/api/org/owner-transfer/propose/route.ts:149`・`src/lib/account-deletion-notification.ts:83`・`src/lib/admin/send-ticket-reply-email.ts:67`・`src/lib/data-subject-requests/notifications.ts:72`・`src/lib/membership/resolve-auth-emails.ts:117`・`src/lib/auth/sessions/login-alert-worker.ts:168` (`9dd73f23`。#1720 段 B)、`mfa.listFactors` / `mfa.deleteFactor`: `src/app/api/auth/mfa/recover/route.ts:114`・`:137`・`src/app/api/super-admin/admins/[id]/mfa/reset/route.ts:120`・`:153`、`signOut`: `src/app/api/auth/mfa/recover/route.ts:130`・`src/lib/auth/sessions/store.ts:90`、`deleteUser`: `src/lib/account-deletion.ts:445`) と `admin.auth.getUser(jwt)` (`src/app/api/auth/native-bridge/code/route.ts:83`) | 14 | 変わらない。保管も更新も通らない。`admin.signOut` は §9.1 の行 (両版で同じ)。`getUser(jwt)` は `/user` を直接呼ぶ (`GoTrueClient.js:2679-2681`・`:2700-2705`) |
| W-2 Web・引数なしの `getUser()` | 217 呼び出し。入口の多くは `src/lib/auth/helpers.ts:29` (`getAuthUser`。route の認証)・`lib/supabase/middleware.ts:220`・`:291`。ほかは母集合の grep の `getUser()` の行 (この 3 行のほか、`src/app/api/**` 171 行・画面と hooks と `src/lib/**`・`src/components/**` 41 行) と、改行で続ける 2 つ (`src/app/handson-tour/menu/page.tsx:92-93`・`src/app/handson-tour/photo/page.tsx:112-113`) | 217 | **変わる** (規則 U)。残り 90 秒未満で更新が失敗しても access token が有効なら `/user` が通り、route は 401 にならず、画面は `/login` に移らない (§9.6 ① の middleware の行と同じ)。失効後は 2.105.3 と同じく失敗 |
| W-3 Web・`getSession()` | `lib/supabase/middleware.ts:191`・`src/app/(auth)/auth/reset-password/page.tsx:62`・`src/app/api/auth/mfa/factors/[id]/route.ts:68`・`src/app/api/auth/mfa/verify/route.ts:89`・`src/app/api/auth/session-sync/route.ts:11`・`src/components/native-app/NativeSessionWatcher.tsx:60`・`src/hooks/useHomeData.ts:169`・`src/lib/auth/mfa/assurance.ts:53` | 8 | **変わる** (§9.1 の `__loadSession` の行。失効前の失敗は保管を返す)。見張りは §6.1・S-2〜S-4、`assurance.ts:53` は Cookie の access token (失効前なら有効) を返す。`middleware.ts:191` は要求ごとのクライアントで控えを持たず、失効後は両版とも捨てて Cookie を消す応答を返す。2.117 では前面のブラウザより先に消し得る (WebView の S-27・ふつうのブラウザの S-28) |
| W-4 Web・引数なしの `refreshSession()` | `src/app/api/auth/mfa/factors/[id]/route.ts:101`・`src/app/api/auth/session-sync/route.ts:20`・`src/hooks/useHomeData.ts:183` | 3 | **変わる** (控え)。同じクライアントで同じ refresh_token の更新が 60 秒以内に失敗していれば `/token` を呼ばず控えた失敗を返す。route の 2 つは要求ごとのクライアントの最初の更新なので控えに当たらない。`useHomeData.ts:183` は `getSession()` が `null` のときだけ呼ぶ (結果は `null` のまま同じ)。成功の経路は同じ |
| W-5 Web・`setSession` | `src/app/(auth)/auth/native-bridge/route.ts:147`・`src/hooks/useHomeData.ts:160` | 2 | 変わらない。渡す token は直前に発行されたもの (失効していない) で、`_setSession` は `_getUser(access_token)` で確かめて保存する (§9.1) |
| W-6 Web・`signOut` | 既定 (global) 9 行: `src/app/(main)/profile/page.tsx:375`・`:623`・`src/app/(main)/settings/page.tsx:221`・`src/app/(org)/layout.tsx:81`・`src/app/family/promotions/[token]/page.tsx:210`・`src/app/frozen/page.tsx:37`・`src/app/invite/[token]/page.tsx:218`・`src/app/legal-consent/LegalConsentForm.tsx:188`・`src/lib/account-self-service.ts:185`、明示の global 1 行: `src/app/(auth)/auth/reset-password/page.tsx:33` | 10 | global の 10 行は**変わる**: access token が有効なうちなら、`/logout` が失敗 (5xx・接続の失敗) しても Cookie のセッションを消して `SIGNED_OUT` を出す (成功のときと同じ後続。`MainLayout` §6.3)。2.105.3 は失敗なら Cookie が残った。access token が失効していて更新もできない (5xx・接続の失敗・控えの間) ときは、両版とも `/logout` を呼ばずに `{ error }` を返し、Cookie は残り `SIGNED_OUT` も出ない (§9.1 の `_signOut` の失敗の ①。呼び出し側のコードは変えない)。`LegalConsentForm.tsx:188` (同意画面の「同意しない」) は `{ error }` を失敗として扱うので、有効なうちの失敗で Cookie のセッションが消えても「ログアウトに失敗しました」を出して form に戻る (サーバーのセッションは残るので、文は今も正しい。S-29)。scope `others` の 1 行 (`src/app/(main)/settings/account/page.tsx:151`。パスワードの変更のあとの他の端末のログアウト) は #1720 段 C で無くなった (他の端末の失効は GoTrue がパスワードの更新と同じトランザクションで行う) |
| W-7 Web・PKCE を始める (ブラウザの `lib/supabase/client.ts`。ssr は `flowType: 'pkce'`) | `signInWithOAuth`: `src/app/(auth)/login/page.tsx:78`・`src/app/(auth)/signup/page.tsx:55`、`signUp`: `src/app/(auth)/signup/page.tsx:104`、`resetPasswordForEmail`: `src/app/(auth)/auth/forgot-password/page.tsx:41`、メールの `updateUser`: `src/app/(main)/settings/account/page.tsx:299` | 5 | **変わる**: verifier の Cookie が 1 つから 3 つ (flow ごと・一覧・従来のキー。§9.1 の PKCE の行) になる。redirect の URL は変わらない (`sb_flow_id` を付けない)。メールの `updateUser` は規則 U も |
| W-8 Web・PKCE を終える (サーバー) | `exchangeCodeForSession(code)`: `src/app/(auth)/auth/callback/route.ts:63` | 1 | **変わる**: flow id を渡さないので従来のキーを読む。更新の前に始めた flow (従来のキーだけ) も、後に始めた flow (3 つ書き、従来のキーも同じ値) も通る (S-21)。終えたあと消すのは従来のキーだけで、flow ごとのキーと一覧の Cookie は次の `_removeSession` (ログアウト・失効) か、新しい flow が 5 本を越えたときに消える |
| W-9 Web・そのほか | `verifyOtp` (token_hash。verifier を使わない): `src/app/(auth)/auth/callback/route.ts:79`・`:100`、`signInWithPassword`: `src/app/api/auth/login/route.ts:198`、`resend`: `src/app/(auth)/auth/verify/page.tsx:46`、`mfa.enroll`: `src/app/api/auth/mfa/enroll/route.ts:69`、`mfa.unenroll`: `src/app/api/auth/mfa/enroll/route.ts:65`・`src/app/api/auth/mfa/factors/[id]/route.ts:86`、`mfa.challengeAndVerify`: `src/app/api/auth/mfa/verify/route.ts:112`、`getClaims(token)`: `src/lib/auth/mfa/assurance.ts:68`、`onAuthStateChange`: `src/app/(main)/MainLayout.tsx:146`・`src/hooks/useHomeData.ts:979` | 11 | `verifyOtp`・`signInWithPassword`・`resend`・`mfa.enroll` (§9.1 の data URL) は変わらない。`mfa.unenroll`・`mfa.challengeAndVerify` は規則 U。パスワードの変更の再認証の `signInWithPassword` (`settings/account/page.tsx:125`) とパスワードの `updateUser` (`settings/account/page.tsx:138`・`reset-password/page.tsx:90`) は、#1720 段 C で API (`POST /api/auth/password/change`・`/reset`。GoTrue を本人の access token で呼ぶ) に移り、無くなった。`getClaims(token)` は**変わる**: 期限切れの token は `{ error }` で返り、`readSessionAssurance` は `AUTH_UNAUTHENTICATED` (401) にする (2.105.3 は例外が route まで上がった)。token は直前の `getSession()` か Bearer なので、期限切れが届くのはその間に失効したときだけ。`onAuthStateChange` は事象の種類が同じで、`MainLayout` は §6.3、`useHomeData.ts:979` はどの事象でも読み直す (失効前の `SIGNED_OUT` が来なくなるだけ) |
| W-10 Web・`auth` を引数で受ける (`SessionClaimsReader`) | `src/lib/auth/sessions/session-claims.ts:41` (`auth.getSession()`。Bearer が無いときだけ)・`:43` (`auth.getClaims(token)`) | 2 | `:41` は W-3 と同じ (失効前の失敗は保管を返す)。`:43` は**変わる** (W-9 の `getClaims(token)` と同じ型の変化): 期限切れの token は `{ data: null, error }` で返り、`readSessionAuth` は null を返す (`:44`)。2.105.3 は `Error` を投げ、`readSessionAuth` から呼び出し元へ抜けた。呼び出し元は 2 つ: `recordWebLoginContextFromRequest` (`web-login-context.ts:32`) はログインの直後の token (失効していない) を渡すので、ふつうは届かない。届いたときの warn の stage が `exception` (2.105.3) から `claims` (2.117.3) に変わるだけで、ログインの応答は変わらない。`requireSessionUser` (`:89`) は origin/main の製品コードに呼び出し元が無い (単体テストだけ)。呼ぶ route ができたら、期限切れの Bearer で `AuthError('AUTH_UNAUTHENTICATED')` (401) になる (2.105.3 なら `Error` が route まで上がった) |
| M-1 apps/mobile・`getSession()` | `apps/mobile/src/providers/AuthProvider.tsx:142`・`apps/mobile/src/lib/api.ts:89`・`apps/mobile/src/components/ai/AIAdvisorSheet.tsx:328`・`:445`・`apps/mobile/src/lib/webViewAuthMessages.ts:205`、画面: `apps/mobile/app/(auth)/auth/reset-password.tsx:30`・`:56`・`:97` (`9dd73f23`。#1720 段 C の、再設定の API を呼ぶ前に掃除に渡す利用者を読む)・`apps/mobile/app/(auth)/auth/verify.tsx:81`・`apps/mobile/app/(tabs)/settings.tsx:152`・`apps/mobile/app/legal-consent.tsx:82` | 11 | **変わる** (W-3 と同じ)。`AuthProvider.tsx:142` は §3・S-19。`api.ts:89` と `AIAdvisorSheet.tsx` の 2 行は API に付ける access token で、失効前の失敗では保管の token が返り要求は通る。失効後の控えの間は `null` で token 無しの要求になる (既存の 401 の扱いのまま)。`webViewAuthMessages.ts:205` は §6.2 の控え。画面の `reset-password.tsx`・`verify.tsx`・`settings.tsx` の 5 行はセッションの有無と access token を読むだけで、失効前の失敗でも「セッションあり」のまま進む。`legal-consent.tsx:82` は規約の同意画面の `afterSignOut` (Web からの `sign-out`・失効の `session-expired` でネイティブがサインアウトした後に呼ばれる。`webViewAuthMessages.ts:359-363`) で、端末にセッションが残ったか (`data.session`) だけを見て、残っていれば入口へ移す。2.117 では、access token が有効なうちのサインアウトの通信の失敗でも supabase-js が保管を消すので `null` (移らず、成功のときと同じく「閉じる」を出す)。失効していて更新もできないときは保管が残るが、`getSession()` は控えた失敗で `null` (移らない。両版で同じ)。2.105.3 は有効なうちの失敗で保管が残り、残りが 90 秒以上なら保管を返して入口へ移った (S-29・T-29・§9.6 ① の同意画面の行・③ (d)) |
| M-2 apps/mobile・引数なしの `getUser()` | `apps/mobile/src/providers/AuthProvider.tsx:175`・`apps/mobile/src/lib/webViewAuthMessages.ts:256`・`apps/mobile/src/lib/pushNotifications.ts:258`・`apps/mobile/src/components/settings/AccountCredentialsSection.tsx:269`、画面: `apps/mobile/app/(auth)/login.tsx:77`・`apps/mobile/app/onboarding/complete/index.tsx:82`・`:157`・`apps/mobile/app/onboarding/questions.tsx:767`・`:937`・`apps/mobile/app/onboarding/resume.tsx:37`・`apps/mobile/app/profile/nutrition-targets.tsx:82`・`:112`・`apps/mobile/app/settings/account.tsx:63` | 13 | **変わる** (規則 U)。`AuthProvider.tsx:175` は §3、`webViewAuthMessages.ts:256` は §6.2・S-17 (403 → `_removeSession` は同じ)、`pushNotifications.ts:258` は push の登録の前の利用者の確認 (失効前の失敗でも通る)。画面の 9 行は利用者の ID を読むだけで、失効前の失敗でも利用者が返る |
| M-3 apps/mobile・`updateUser` | `apps/mobile/src/lib/account-credentials.ts:98` (メール) | 1 | 規則 U。apps/mobile は `flowType` を渡さず既定の `'implicit'` なので、メールの変更でも verifier を書かない (§9.1)。パスワードの `updateUser` の 2 つ (`account-credentials.ts:67`・`apps/mobile/app/(auth)/auth/reset-password.tsx:91`) は、#1720 段 C で API (`POST /api/auth/password/change`・`/reset`) に移り、無くなった |
| M-4 apps/mobile・`signOut` | `apps/mobile/src/lib/signOut.ts:101` (`signOutOrForgetLocally`)・`:127` (`signOutWithCleanup`)・`apps/mobile/src/providers/AuthProvider.tsx:207` (scope `local`) | 3 | 3 行とも**変わる**: access token が有効なうちなら、サーバーへのログアウトが失敗しても保管を消して `SIGNED_OUT` を出し、AuthProvider の `SIGNED_OUT` の行 (`AuthProvider.tsx:240-259`。成功のときと同じ掃除と release) が走る (S-20)。access token が失効していて更新もできないときは、両版とも `/logout` を呼ばずに `{ error }` を返し、保管は残り `SIGNED_OUT` も出ない (§9.1 の `_signOut` の失敗の ①。S-22)。`signOutOrForgetLocally` の端末での消去 (`signOut.ts:107-110`) はコードを変えずに残す: 失効後で更新もできないときと例外のときは、これが後始末の本体 (`SIGNED_OUT` が来ない)。有効なうちの失敗では supabase-js の消去と重なるが、二重でも害は無い (無いキーの `removeItem` と `null` への `setSession`)。AuthProvider の scope `local` (`AuthProvider.tsx:207`。起動時の失効の明言) は、`getSession()` が有効なセッションを返した直後 (`getUser()` の検証のあと) に呼ぶので、ふつうは ① の枝に当たらない (この経路はコードも挙動も変えない)。scope `others` の 1 行 (`apps/mobile/src/lib/account-credentials.ts:80`) は #1720 段 C で無くなった |
| M-5 apps/mobile・リンク | `setSession`: `apps/mobile/src/lib/authLink.ts:72`・`apps/mobile/app/(auth)/auth/reset-password.tsx:49`、`exchangeCodeForSession`: `apps/mobile/src/lib/authLink.ts:63`・`apps/mobile/app/(auth)/auth/reset-password.tsx:46`、`verifyOtp`: `apps/mobile/src/lib/authLink.ts:66` | 5 | 変わらない。リンクの token は発行直後で `_setSession` は `_getUser(access_token)` を通る。`'implicit'` なので `exchangeCodeForSession` は verifier を求めない (`GoTrueClient.js:1627-1629`。`code_verifier` が無く交換できないのは 2.105.3 と同じで、cross/16 §8 の行 28 の記述のまま) |
| M-6 apps/mobile・MFA | `mfa.listFactors`: `apps/mobile/src/components/MfaVerifyGate.tsx:75`、`mfa.challengeAndVerify`: `:101`、`mfa.getAuthenticatorAssuranceLevel`: `apps/mobile/src/lib/operator-mfa.ts:26` | 3 | 規則 U (`listFactors` は `getUser()`、AAL は `getSession()` を通る) |
| M-7 apps/mobile・`onAuthStateChange` | `apps/mobile/src/providers/AuthProvider.tsx:229` | 1 | 事象の種類は同じ。`SIGNED_OUT` が失効前の更新の失敗では来なくなり (S-16)、access token が有効なうちのログアウトの失敗でも来る (S-20。失効していて更新もできないときのログアウトの失敗では、両版とも来ない S-22) |
| M-8 apps/mobile・ログインを始める | `signInWithOAuth`: `apps/mobile/app/(auth)/login.tsx:107`・`apps/mobile/app/(auth)/signup.tsx:40`、`signUp`: `apps/mobile/app/(auth)/signup.tsx:101`、`resetPasswordForEmail`: `apps/mobile/app/(auth)/auth/forgot-password.tsx:41`、`signInWithPassword`: `apps/mobile/app/(auth)/login.tsx:164` (パスワードの変更の再認証の `apps/mobile/src/lib/account-credentials.ts:59` は #1720 段 C で無くなった) | 5 | 変わらない。`'implicit'` なので verifier を書かず (§9.1 の PKCE の行は `flowType: 'pkce'` のときだけ)、redirect の URL も変わらない |
| M-9 apps/mobile・`auth` を引数で受ける (`BridgeAuthClient`。WebView の bridge) | `apps/mobile/src/lib/webViewBridge.ts:565` (`auth.getSession()`。`getSessionForBridge`)・`:535` (`auth.refreshSession()`。`refreshSessionOnce`)。`auth` は `WebViewScreen.tsx:217` が渡す `supabase.auth` | 2 | **変わる** (失敗の控え)。(1) access token が失効していて、更新がやり直せる失敗で終わったあとの 60 秒 (控えの間) は、通信が戻っていても `getSession()` が控えた失敗 (`session: null`) を返し、`getSessionForBridge` は null → 直接の URL (S-23)。2.105.3 は `getSession()` が `/token` を呼び直し、通信が戻っていれば bridge が通った。(2) 残りが `BRIDGE_SERVER_MIN_TOKEN_TTL_SEC` (150 秒) 未満で、同じ refresh_token の更新が 60 秒以内に失敗していると、`refreshSession()` が控えた失敗をすぐ受け取り (§9.1 の `refreshSession()` の行)、`webViewBridge.ts:579` で null → 直接の URL (S-24)。2.105.3 は `/token` を呼び直した。どちらも裁定 G で受け入れる。成功の経路 (控えの無いとき) は変わらない (G-4) |

**製品の Supabase のパッケージの import の閉包**

母集合は `git grep -l -E "@supabase/(supabase-js|ssr|auth-js)" origin/main -- ':!docs' ':!package-lock.json' ':!package.json' ':!apps/mobile/package.json' ':!supabase/functions'` からテスト (`__tests__/`・`*.test.*`・`*.spec.*`・`tests/`) を除いた 76 ファイル。

| 群 | ファイル | 数 | 判定 |
|---|---|---|---|
| 値の import (クライアントを作る) | `lib/supabase/client.ts:1`・`lib/supabase/middleware.ts:1`・`lib/supabase/server.ts:1-2`・`src/app/api/health/route.ts:22`・`src/lib/db-logger.ts:9`・`apps/mobile/src/lib/supabase.ts:3` | 6 | 上の表の ①〜④・⑥。変えるのは §9.7 の ①・②・③ だけ (③ は `cookieEncoding` を渡すだけ) |
| 型だけの import | `apps/mobile/src/providers/AuthProvider.tsx:1`・`lib/catalog-products.ts:1`・`lib/legal-consent-minor.ts:9`・`lib/meal-image-jobs.ts:1`・`src/app/(main)/menus/weekly/page.tsx:26`・`src/lib/account-deletion-storage.ts:24`・`src/lib/account-deletion.ts:54`・`src/lib/account-export.ts:17`・`src/lib/admin/audit.ts:42`・`src/lib/admin/moderation-backend.ts:31`・`src/lib/admin/user-ban.ts:26`・`src/lib/admin/user-emails.ts:20`・`src/lib/ai/ai-queue-writer.ts:1`・`src/lib/ai/consent-guard.ts:17`・`src/lib/ai/consent.ts:31`・`src/lib/auth/helpers.ts:9`・`src/lib/auth/mfa/assurance.ts:9`・`src/lib/auth/mfa/backup-codes.ts:11`・`src/lib/auth/mfa/factors.ts:6`・`src/lib/auth/org-member.ts:15`・`src/lib/auth/sessions/session-claims.ts:6`・`src/lib/auth/sessions/store.ts:9`・`src/lib/badges/awardBadge.ts:1`・`src/lib/data-subject-requests/requester-http.ts:12`・`src/lib/data-subject-requests/service.ts:14`・`src/lib/experiments/assignment.ts:20`・`src/lib/handson-tour/sandbox-eligibility.ts:1`・`src/lib/handson-tour/sandbox-photo-meal.ts:1`・`src/lib/handson-tour/tour-profile.ts:19`・`src/lib/health-insight-meals.ts:13`・`src/lib/membership/exit-notification.ts:24`・`src/lib/membership/org-invite.ts:12`・`src/lib/nutrition-feedback-watch.ts:12`・`src/lib/org-challenge-api.ts:10`・`src/lib/org-challenge-privacy.ts:5`・`src/lib/photo-storage-signing.ts:23`・`src/lib/plan/coupon.ts:29`・`src/lib/planned-meals-snapshot.ts:1`・`src/lib/shopping-list/active-list.ts:17`・`src/lib/super-admin/flag-active-users.ts:18`・`src/lib/super-admin/plan-subscribers.ts:23`・`src/lib/v4-target-slots.ts:1`・`src/lib/weekly-menu-request-stale.ts:45` | 43 | 変わらない。名前は `SupabaseClient`・`User`・`Session`・`Factor`・`RealtimeChannel`・`PostgrestError` と ssr の `createServerClient` (`typeof` だけ) で、2.117.3 / 0.12.7 にもある (§9.1 の型の名前の行)。auth の呼び出しは上の表 (W-* / M-*) で扱う。型の変化は `npx tsc --noEmit` で確かめる (赤なら型の変化として扱い、`any` で逃げない) |
| コメントだけ (import は無い) | `apps/mobile/src/lib/signOut.ts:91`・`packages/shared/src/user-scoped-storage.ts:58`・`src/app/(auth)/auth/native-bridge/route.ts:49`・`src/app/api/cron/process-menu-queue/route.ts:12`・`src/components/native-app/NativeSessionWatcher.tsx:18`・`src/lib/auth/native-bridge-code.ts:31`・`src/lib/native-auth-bridge.ts:55` | 7 | `signOut.ts`・`NativeSessionWatcher.tsx`・`native-bridge-code.ts`・`native-auth-bridge.ts` は段 4 で現在形に (§9.13)。`user-scoped-storage.ts:58-61` は接頭辞 `sb-` だけを使い、2.117 の verifier の新しい名前 (`sb-<ref>-auth-token-flow-…`) も同じ接頭辞で消える。`native-bridge/route.ts:49` の名前の型と `process-menu-queue/route.ts:12` の説明は変わらない |
| 手で流す道具 (`scripts/`) | `scripts/` の 16 ファイル (うち `scripts/lib/e2e-ai-consent.ts:12`・`scripts/lib/meal-image-backfill.ts:27` は型だけ) | 16 | 変えない (§9.1 ⑥)。service_role / anon で PostgREST を呼ぶ道具で、更新の失敗も Cookie も通らない |
| コードでない文書 | `.github/workflows/deploy-supabase-functions.yml`・`DESIGN.md`・`README.md`・`SPECIFICATION.md` | 4 | 変えない (Edge Function の配備と説明。npm の版を書かない) |

### 9.2 要件行列

| # | 要件 | 根拠 | 本章の節 |
|---|---|---|---|
| R-1 | `@supabase/supabase-js` 2.117.3 と `@supabase/ssr` 0.12.7 を同時に上げる (ssr 0.12.7 の peer は supabase-js `^2.114.0`) | Issue #1768 本文 | §9.13 |
| R-2 | 借り物のセッションを捨てる合図を、2.117 の挙動 (有効な access token のうちの先回りの更新の失敗ではセッションを捨てず `SIGNED_OUT` も出さない) のもとで決める | Issue #1768 本文「やること」1 | §9.4〜§9.6 |
| R-3 | `MainLayout` の扱い (localStorage を消さない・`/login` へ移さない・`NATIVE_REBRIDGE_WAIT_MS` 待つ) と、`NativeSessionWatcher` の閾値 (180 秒) を変えない。変えるのはコメント | #1038 F7-05 (§6.1・§6.3) | §9.5 |
| R-4 | ssr 0.12 の `getAll` / `setAll` へ移行する (middleware・server)。Cookie の書式は 3 つの呼び出し口 (middleware・server・client) で `cookieEncoding: 'raw'` (0.1.0 と同じ JSON) を明示する。`base64url` への切り替えは本改定に入れない (裁定 D) | Issue #1768 本文「やること」2 | §9.7 |
| R-5 | すでにログインしている利用者のセッション (0.1.0 が書いた JSON の Cookie・分割あり) が、更新のあとも切れない。デプロイの前に開いたタブ (旧バンドル: ssr 0.1.0 + auth-js 2.105.3) と、Vercel を旧版に戻したときの旧サーバーも、更新のあとに書かれた Cookie を読めて切れない。機械検査と本番の確認の手順を持つ | Issue #1768 本文「やること」2 | §9.8 |
| R-6 | 赤になる既存のテスト (`main-layout-signed-out` 6 件・`integration-auth-transient-retry:105`) は、期待値を緩めず、新しい挙動の意味のある assert に書き直す | Issue #1768 本文 | §9.9 |
| R-7 | 2.117 の新しい前提 (`REFRESH_FAILURE_COOLDOWN_MS`・失効前は残す・失効後は捨てる・やり直せる失敗も捨てずに控える・ログアウトの失敗の 2 つの枝・失効後の更新の 400 と保管なしと scope `others` のログアウト・期限切れの token の `getClaims` が投げずに `{ error }` を返す・従来の PKCE の verifier の Cookie を読む・期限切れ + オフラインの起動の控え) を本物の auth-js で固定するテストを持つ (次に auth-js を上げたとき気づく) | §6.1 の閾値テストと同じ考え | §9.9 |
| R-8 | apps/mobile も同じ版にし、ワークスペースの 1 コピーを保つ。ネイティブモジュールは増えない。端末側の挙動の変化を auth の呼び出しの閉包 (M-1〜M-9) から漏れなく挙げ、判断の材料にする | Issue #1768 本文「やること」(apps/mobile) | §9.10 |
| R-9 | cross/12・cross/16 が依る auth-js の挙動 (`mfa.enroll` の data URL・セッションが無いときの `_updateUser` / `_signOut`・`admin.signOut`・`getUser()` の 403) が 2.117.3 でも同じことを file:line で裏づける | Issue #1768 本文・仕様の指示 | §9.1 |
| R-10 | `any` への cast を使わない。意味のある数値は名前付き定数 (テストの期待値も auth-js の定数から導く) | 設計の絶対条件 | §9.9・§9.11 |
| R-11 | 1 PR で上げ、lock の整合 (`npm ci` が通る) と CI の依存の検査 (Dependency review / `npm audit`) の緑をマージの門にする | `tests/local-ci-workflow-sync.test.ts:84-86` の決まり | §9.13 |

### 9.3 ユーザーシナリオ (29 本)

| # | 誰が | 何をする | 期待 (設計後) |
|---|---|---|---|
| S-1 | WebView の利用者 (前面) | 献立を見続け、借り物の access token の残りが 180 秒を切る | `NativeSessionWatcher` が `session-expired` → ネイティブが読み込み直す。auth-js は `/token` を呼ばない (従来どおり) |
| S-2 | WebView の利用者 (前面) | 見張りの確認が遅れ、残り 119 秒で tick が先に走る | 借り物の値で `/token` → 400。**セッションは残り、画面は動き続ける** (`SIGNED_OUT` 無し・localStorage そのまま)。20 秒以内の次の確認で `session-expired` → 読み込み直し。2.105 ではここで捨てられ `/login` が一瞬出ていた |
| S-3 | WebView の利用者 (前面) | 残り 89 秒で API を呼ぶ (`getSession()` が走る) | 更新に失敗しても `getSession()` は残したセッション (同じ access token) を返し、API は通る。控えの 60 秒は `/token` を呼ばない |
| S-4 | WebView の利用者 | 1 時間以上バックグラウンドに置いて戻る (access token は失効) | 復帰の `_recoverAndRefresh` が `/token` → 400 → 失効後なので捨てて `SIGNED_OUT` → `MainLayout` が `session-expired` を送り、localStorage を消さずに待つ → ネイティブが読み込み直す。`NativeSessionWatcher` の復帰の確認も `null` を見て送るが、15 秒の間隔で 1 回 |
| S-5 | S-4 の利用者 (旧アプリ) | ネイティブが `session-expired` を知らない | `NATIVE_REBRIDGE_WAIT_MS` (15 秒) 後に従来どおり localStorage を消して `/login` へ (変わらない) |
| S-6 | S-4 の利用者 | 待っている間に別のタブが先に読み込み直され、共有の Cookie が新しくなる | `SIGNED_IN` で待ちをやめる (変わらない) |
| S-7 | WebView の利用者 | WebView の中の画面 (凍結の画面など) でログアウトする | `notifyNativeSignOut` → `signOut()` → `broadcastSignOut`。ネイティブに届くのは `sign-out` だけ (変わらない) |
| S-8 | WebView の利用者 | `notifyNativeSignOut` を呼ばない画面でログアウトする | `session-expired` → `sign-out` の順でも、ネイティブは控えで push token を消す (変わらない) |
| S-9 | ふつうのブラウザの利用者 (前面) | 別の端末からの全端末ログアウトで、サーバーのセッションと refresh_token が失効する。この画面は、そのあと自動更新の tick の先回りの更新 (残り 120 秒未満) まで、ブラウザの `getUser()` も `/api/*` も画面の移動もしない | 先回りの更新が 400 でもセッションは残り、画面はそのまま (2.105 はここで `SIGNED_OUT` → `/login`)。access token の失効の後の最初の実際の更新の失敗で `SIGNED_OUT` → `MainLayout` が user-scoped の localStorage を消して `/login` (失効から最大 90 秒。2.105 より最大約 210 秒遅い)。その間に画面の要求がサーバーに届くと、サーバーの応答が先に Cookie を消し、`SIGNED_OUT` は出ない (S-28)。ブラウザの `getUser()` が先に 403 を受ければ、両版ともすぐ `SIGNED_OUT` → `/login` (§9.6 ① の 403 の行) |
| S-10 | 更新の前にログインしていた利用者 (ふつうのブラウザ) | 更新 (本番デプロイ) のあとにページを開く | middleware の `getAll` が 0.1.0 の JSON の Cookie を読み、`getUser()` が通る。次の token の更新でも JSON (`raw`) のまま書き直される。ログアウトされない |
| S-11 | S-10 の利用者 | Cookie が 2 つに分割されている (`.0` / `.1`) | 同じ。分割も JSON のまま読める |
| S-12 | S-10 の利用者 | 更新後の最初の書き直しで、セッションの JSON の長さが変わって分割の数が変わる (2 分割 → 1 つ、または逆) | `applyServerStorage` が古いチャンクを `maxAge: 0` で消し、新しいチャンクを同じ応答で書く。読み手は新しい値を読む |
| S-13 | WebView の利用者 (新 Web + 旧アプリ) | ブリッジで `/auth/native-bridge?code=` を開く | `setSession` が JSON (`raw`) の Cookie を書く。アプリは名前しか見ないので変わらない。`clearSupabaseAuthCookies` も名前で消す |
| S-14 | ローカル Supabase の結合テスト | `Set-Cookie` からセッションを取り出す | サーバーは JSON (`raw`) で書くので、既存の読み取り (`readSession`・`sessionFromSetCookie` の `JSON.parse`) がそのまま通る (変えない) |
| S-15 | 結合テストのプロセス | ゲートウェイが 504 を返す | やり直しは status だけを見るので変わらない。やり直しが無いときのエラーは `AuthRetryableFetchError` で message は `'HTTP 504'` (2.105 は `'{}'`) |
| S-16 | ネイティブの利用者 (新アプリ) | Web の `signOut()` (全端末の失効) のあと、アプリの tick が先回りの更新をする | 400 → access token が有効なら残す → 失効後の更新で `SIGNED_OUT` (最大 90 秒遅れ) → AuthProvider の `SIGNED_OUT` の行の掃除と release (§3。内容は同じ) |
| S-17 | ネイティブの利用者 (新アプリ) | Web からの `session-expired` → `getUser()` が `403 session_not_found` | `_removeSession` → `SIGNED_OUT` (2.117 でも同じ経路)。控えで push token を消す (変わらない) |
| S-18 | 旧アプリの利用者 | 新しい Web を開く | ネイティブの auth-js は 2.105 のまま。Web の変化 (借り物を失効前に捨てない・Cookie の書式) はアプリから見えない |
| S-19 | ネイティブの利用者 (新アプリ) | access token が期限切れのまま機内モードで起動し、しばらくして通信が戻る | 読み込み中は約 25 秒 (初期化のやり直し) で、保存済みのセッションで起動する (§3。経路は変わらない)。通信が戻ってから、最後の失敗から 60 秒の控えが切れた最初の契機 (tick ≤ 30 秒・`getSession()`) で更新し、`TOKEN_REFRESHED` で差し替わる (最大約 90 秒。2.105 は次の契機)。その間の supabase-js の要求は anon キーで出る (裁定 G で受け入れる) |
| S-20 | ネイティブの利用者 (新アプリ。保管の access token は有効) | 通信が切れた状態で、設定画面のログアウトを押す | サーバーへのログアウトは接続の失敗で `{ error }` になるが、access token が有効なので 2.117 は保管を消して `SIGNED_OUT` を出す → AuthProvider の `SIGNED_OUT` の行 (成功のときと同じ掃除と release) → `signOutOrForgetLocally` の端末での消去が重なる (害は無い) → ログインの画面へ。2.105 は `SIGNED_OUT` が無く、端末での消去と `clearSession` だけだった (§9.1 の `_signOut` の失敗の行・閉包 M-4) |
| S-21 | ふつうのブラウザの利用者 | 更新 (本番デプロイ) の前に Google ログイン (またはパスワードの再設定のメール) を始め、更新の後にコールバックへ戻る | 2.105 が書いた従来の verifier の Cookie (`sb-<ref>-auth-token-code-verifier`) を、コールバックの route の `exchangeCodeForSession(code)` が flow id 無しで従来のキーから読み、ログインが通る。更新の後に始めた flow も同じ (従来のキーにも同じ値を書く)。flow ごとと一覧の Cookie は次のログアウト・失効で消える (閉包 W-7・W-8) |
| S-22 | S-19 の利用者 (新アプリ。access token が失効し、通信はまだ戻っていない) | 保存済みのセッションで起動した画面から、設定画面のログアウトを押す | push token の行の削除は通信の失敗で済まず、release の宛先を控える (#1706)。`signOut()` は `/logout` を呼ばずに `{ error }` (`AuthRetryableFetchError`) を返し、保管は残り `SIGNED_OUT` も出ない (2.105 と同じ。§9.1 の `_signOut` の失敗の ①) → `signOutOrForgetLocally` が保管を端末だけで消し (`clearStoredSessionLocally`)、`clearSession` で画面を未ログインにする → ログインの画面へ。`SIGNED_OUT` の行の掃除と release は走らず、控えた宛先は起動時に未ログインと決まったとき (`flushPendingPushTokenReleases`) か次の `SIGNED_OUT` で消す。サーバーのセッションは残る。失敗の控えが切れていれば、`signOut()` は更新のやり直し (約 25 秒) のあとで返る (§3 の表の `{ error }` の行の (b)) |
| S-23 | S-19 の利用者 (新アプリ。access token が失効し、最後の更新はやり直せる失敗で終わった) | 通信が戻ってから、ネイティブの更新 (控えが切れた後の最初の tick) より前に、まだ開いていないタブ (WebView) を開く | `getSessionForBridge` の `getSession()` が控えた失敗 (`session: null`) を受け取り null → `WebViewScreen` は code を取らずに直接の URL を開く → 借り物の Cookie が無い (または失効している) ので Web はログイン画面 → ログイン画面の `session-expired` は、ネイティブの控え (`getSession()`) も null なので何もしない (`no-session`)。WebView はログイン画面のまま残る。ネイティブが更新を終えた (`TOKEN_REFRESHED`) あとに、利用者が同じタブを押し直すと (`tabPress` で初期の URL を読み込み直す `WebViewScreen.tsx:186-204`)、middleware がログイン画面へ回し、その描画の `session-expired` でネイティブが読み込み直す (bridge が通る)。`WebViewScreen` は `TOKEN_REFRESHED` では自分から読み込み直さない (bridge は `effectivePath` の変化でだけ走る)。既に開いている WebView から届く `session-expired` (見張り・`MainLayout`) も同じく何もせず、`MainLayout` が待っていれば 15 秒後に従来どおりログアウトとして扱う (§6.3 の 3。localStorage を消して `/login`)。ただし、ブラウザより先にサーバーの応答が Cookie を消していれば `MainLayout` は待っておらず、見張りが 20 秒ごとに送り続け、ネイティブの更新のあとの送信で読み込み直される (S-27)。2.105 は `getSession()` が `/token` を呼び直したので、通信が戻っていればどちらも bridge が通った。裁定 G で受け入れる |
| S-24 | ネイティブの利用者 (新アプリ。access token の残りは 120 秒未満で有効) | tick の更新が接続の失敗 (約 25 秒やり直した後) で終わり、その 60 秒の間に通信が戻り、残りが 150 秒未満のときにまだ開いていないタブを開く | `getSessionForBridge` は残りが 210 秒未満なので `refreshSessionOnce` → `refreshSession()` が控えた失敗をすぐ受け取り null → 残りが 150 秒未満なので null (`webViewBridge.ts:579`) → 直接の URL。ほかのタブが張った借り物の Cookie がまだ有効ならその Cookie で開き (失効が近いので見張りがすぐ `session-expired` を送る)、無ければ S-23 と同じくログイン画面。2.105 は `/token` を呼び直した。裁定 G で受け入れる |
| S-25 | デプロイの前からブラウザのタブを開いたままの利用者 (そのタブは旧バンドル: ssr 0.1.0 + auth-js 2.105.3) | デプロイのあと、同じブラウザの別のタブ (新バンドル) で操作する・`/api/*` を呼ぶ・1 時間ごとの更新が走る (新しいサーバー・新しいバンドルが Cookie を書き直す) | 書き直された Cookie は JSON (`raw`) なので、旧バンドルのタブの auth-js 2.105.3 も tick・`getSession()`・復帰で読める。ログアウトされない。`base64url` で書くと、旧バンドルが `_removeSession` で Cookie を消して `SIGNED_OUT` → `MainLayout` がログアウトとして扱う (localStorage を消して `/login`。Cookie はブラウザで共有なので新しいタブも切れる)。これを避けるのが裁定 D |
| S-26 | 運用者 | デプロイのあとに不具合が見つかり、Vercel を旧版 (ssr 0.1.0 + auth-js 2.105.3) に戻す | 更新のあとに書かれた Cookie は JSON (`raw`) なので、旧版の middleware・server・ブラウザが読める。ログアウトされない (`base64url` なら S-25 と同じ経路で Cookie が消える) |
| S-27 | WebView の利用者 (前面。新アプリ) | 再ブリッジが通らないまま (ネイティブの回数制限・S-23 の `no-session`) 借り物の access token が失効し、ブラウザの auth-js が自分で更新を試みる前 (失敗の控えの間) に、画面が `/api/*` を呼ぶ (または画面を移る) | middleware が借り物の値で更新して 400 → 失効後なので Cookie を消す応答。ブラウザの auth-js には事象が届かず `SIGNED_OUT` は出ない → `MainLayout` は送らず、15 秒の待ちも張らない (localStorage は残り、`/login` へも移らない)。見張りが 20 秒ごとに `null` を見て `session-expired` を送り続け、ネイティブの制限が解けるか更新が済んだあとの送信で読み込み直される (§6.3 の 5。裁定 H)。2.105 では前面ではこの順は起きなかった (ブラウザの tick が失効の 120 秒前に先に捨てていた) |
| S-28 | ふつうのブラウザの利用者 (前面) | 別の端末からの全端末ログアウト (S-9 と同じ) のあと、ブラウザの auth-js が自分で捨てる前に、画面が `/api/*` を呼ぶ (または画面を移る) | middleware が、失効の前ならサーバーのセッションの消失 (`getUser()` の 403 `session_not_found`。両版で同じ)、失効の後なら更新の 400 (2.117 で前面でも起きるようになった) で Cookie を消す応答を返す。ブラウザの auth-js には事象が届かず `SIGNED_OUT` は出ない → `MainLayout` は何もしない (user-scoped の localStorage は残り、`/login` へも移らない)。`/api/*` の画面はそのまま残り、認証の要る `/api/*` は未ログインとして答え (401 など。401 で自分から `/login` へ移る画面は移る §8)、supabase-js の直接の要求は anon キーで出る。画面を移ると (この要求でも、次の要求でも) middleware が `/login?next=…` へ回す。localStorage は次のログアウトか次に `MainLayout` が受ける `SIGNED_OUT` まで残る (§6.3 の「ふつうのブラウザ」の段落)。裁定 H2 で受け入れる |
| S-29 | 規約の同意画面 (`apps/mobile/app/legal-consent.tsx`) の利用者 (新アプリ。同意を待つ間) | 通信が切れた状態で、Web の「同意しない」を押す (Web はネイティブへ `sign-out` を送ってから、自分の `signOut()` を呼ぶ) | ネイティブの `signOutWithCleanup` の `signOut()` は通信の失敗で `{ error }` を返し、そのあと `afterSignOut` が `getSession()` で端末のセッションが残ったかを見る (残っていれば入口へ移す)。**(a) access token が有効**: 2.117 は保管を消して `SIGNED_OUT` を出す (S-20 と同じ) → AuthProvider の掃除と release → `getSession()` は `null` → 入口へ移らず、扱いが `signed-out-notice` になって「閉じる」を出す (成功のときと同じ)。2.105.3 は保管が残り、残りが 90 秒以上なら `getSession()` が保管を返して入口へ移り (ゲートが同意画面 1 つに畳み直す。ログイン中のまま)、90 秒未満なら更新の失敗で `null` を返して (b) と同じになった。**(b) access token が失効していて更新もできない (通信の失敗・失敗の控えの間)**: 両版とも保管が残り `SIGNED_OUT` も出ない (S-22 と同じ)。`getSession()` は更新の失敗 (2.117 は控えた失敗をすぐ) で `null` → 入口へ移らない。AuthProvider のセッションが残るので扱いは `awaiting-consent` のままで、「閉じる」は出ない。どちらの枝でも、Web の `signOut()` も通信の失敗で `{ error }` を返すので、Web は「ログアウトに失敗しました」を出して form に戻る (Web の借り物の access token は、ネイティブの token を bridge の時点で写したもの (`src/app/(auth)/auth/native-bridge/route.ts:141-156` の `setSession`) なので、ネイティブより後には失効しない。(b) では Web も同じく更新できない)。(b) で入口へ移らないことに害は無い: 同意画面は同意を待つ扱いのまま Web の form を出し、通信が戻ってからもう一度押せばログアウトできる (入口へ移しても、ゲートが同意画面に畳み直して同じ form を出す)。サーバーのセッションは、どちらの枝でも失効しないまま残る (S-20・S-22 と同じ) |

### 9.4 構想とトレース

構想: **捨てる合図は `SIGNED_OUT` のまま、失効の前は見張り (`NativeSessionWatcher`) が受け持つ**。2.117 は「捨てたが access token はまだ使えた」区間 (失効前 120 秒) を無くし、代わりに「失効したがまだ `SIGNED_OUT` が出ていない」区間 (失効後最大 90 秒) を作る。前者は 2 段構えの 1 (見張り) が、後者は見張りの `getSession()` が `null` を返すこと (`NativeSessionWatcher.tsx:65-67`) と `MainLayout` の `SIGNED_OUT` で受ける (その区間にサーバーの応答が先に Cookie を消すと `SIGNED_OUT` は出ず、見張りだけで受ける。S-27・裁定 H)。実際の refresh_token のふつうのブラウザで同じ順が起きたとき (S-28) は、サーバーのセッションが消えたときの 403 の経路で両版に既にある帰結 (`MainLayout` は何もせず、次の画面の移動で `/login`) として受け入れる (裁定 H2)。コードは変えず、テストと説明を 2.117 に合わせる。Cookie は `getAll` / `setAll` へ移し、書式は `raw` (0.1.0 と同じ JSON) を 3 つの呼び出し口で明示する (旧バンドル・ロールバックが読めるように。裁定 D)。ネイティブの bridge の失敗の控えによる遅れ (S-23・S-24) は、裁定 G で受け入れる。

トレース (時刻は借り物の access token の失効を E とし、auth-js の内部は §9.1 の行):

- **T-1 (S-1)**: 前面。E-180 秒で見張りの `check` → `session.expires_at - now < 180` → `notifyNativeSessionExpired()` → ネイティブが `getUser()` で自分のセッションを確かめ、code を発行し WebView を開き直す (§6.2)。auth-js の tick は残り ≥ 120 秒で動かない (`:4702-4706`)。
- **T-2 (S-2)**: 前面。見張りの最後の確認が E-181 秒 (閾値の直前) で、次の確認 (20 秒後 = E-161) より先に tick が走ることは無い (E-120 まで tick は更新しない)。見張りが止まっていた (例: タブが非活性) とき、E-119 の tick → `_callRefreshToken` → `/token` 400 → `isAuthRetryableFetchError` でない → 保管の `expires_at*1000 > now` → 残す (`:4312-4314`) → 控え (E-119 から 60 秒。`:4324-4328`)。`MainLayout` には何も届かない。E-90 の tick → `__loadSession` が `hasExpired` → `_callRefreshToken` → 控えを返す (`:4211-4216`) → `__loadSession` は保管が有効なので保管を返す (`:2563-2572`) → tick は残り 3 tick 以下なので `_callRefreshToken` → 控え。見張りの次の確認 → 残り < 180 → `session-expired` → 読み込み直し。
- **T-3 (S-3)**: E-89 で API 呼び出し → `getSession()` → `hasExpired` (`:2540-2542`) → `/token` 400 → 残す → `__loadSession` は保管を返す → 呼び出し側は access token を付けて API を呼べる。E-60 までの `getSession()` は `/token` を呼ばない (控え)。E-59 の `getSession()` → 控えが切れている → `/token` 400 → まだ有効 → 残す → 控え (E-59 から 60 秒)。
- **T-4 (S-4)**: バックグラウンドで E を過ぎる (タイマー停止)。復帰 → `_onVisibilityChanged` → `_recoverAndRefresh` (`:4782`) → `expiresWithMargin` → `_callRefreshToken` (控えは無いか切れている) → 400 → 保管の `expires_at*1000 > now` が偽 → `_removeSession` (`:4316`) → `SIGNED_OUT` (`:4438`) → `MainLayout` (`isInNativeWebView`) → `notifyNativeSessionExpired()` → 15 秒のタイマー → ネイティブが読み込み直し、ページが入れ替わる。同時に `_startAutoRefresh` の即時の tick と見張りの `visibilitychange` の `check` が走るが、保管は消えているので tick は何もせず、見張りは `null` を見て送ろうとして 15 秒の間隔で止まる。
  失効から `SIGNED_OUT` までの上限: 前面に居続けた場合、E の前の最後の実際の `/token` が E-x (0 < x ≤ 60) なら控えは E-x+60 まで効き、その後の最初の tick (30 秒以内) で `/token` → 失効後 → 捨てる。よって ≤ (60 - x) + 30 < 90 秒。`SIGNED_OUT_AFTER_EXPIRY_MAX_MS` = `REFRESH_FAILURE_COOLDOWN_MS + AUTO_REFRESH_TICK_DURATION_MS` (§9.9 の A-1 が失効の後を 1 秒ずつ進める上限と、B-4 が待つ時間)。
  この上限は、ブラウザの auth-js が自分で捨てる場合のもの。その前に Next のサーバーの応答が Cookie を消すと `SIGNED_OUT` は出ない (WebView は T-27、実際の refresh_token のふつうのブラウザは T-28)。ブラウザが自分の更新を始めた後 (保管を読んだ後) に Cookie が消えたときは、その失敗で読み直す保管 (`storedNow`) が空なので失効扱いになり、`_removeSession` → `SIGNED_OUT` が出る (`:4310-4316`)。この T-4 の復帰では、`_recoverAndRefresh` が保管を読むのは復帰の直後なので、このあとの要求の応答が Cookie を消しても `SIGNED_OUT` は出る。読む前に応答が届いたときは T-27 と同じ。
- **T-5 (S-5)**: T-4 のあと 15 秒で `treatAsSignedOut` → `clearUserScopedLocalStorage()` → `/login`。変わらない。
- **T-6 (S-6)**: T-4 のあと別タブの読み込み直しで Cookie が新しくなる → このタブの auth-js は `BroadcastChannel` (`:270-290`) か次の `getSession()` で新しいセッションを見る → `SIGNED_IN` / `INITIAL_SESSION` → `if (session) stopWaitingForRebridge()`。変わらない。
- **T-7 (S-7)・T-8 (S-8)**: 借り物の access token が失効の前なら (控えの有無に依らず `_useSession` が保管を受け取る `:2563-2572`)、`signOut()` → `_signOut` → `admin.signOut` → `_removeSession` → `SIGNED_OUT` (`:3427-3458`。`/logout` が失敗しても `_removeSession` を通る `:3446-3448`)。読み込み直しが済まないまま失効した後 (`SIGNED_OUT` の前の最大 90 秒) にログアウトすると、控えの間は `/logout` を呼ばずに `{ error }` を返し、Cookie は残り `SIGNED_OUT` も出ない (`:3433-3435`)。控えが切れていれば更新が 400 → `_removeSession` → `SIGNED_OUT` → `{ error }`。残った Cookie は、次に auth-js (ブラウザか middleware) が失効後の更新を試みたとき、借り物の値なので 400 → 捨てる (§9.6 ① の WebView の失効後・控え切れの行)。S-7 では `notifyNativeSignOut()` が `signOut()` の前に済んでいるので、ネイティブには `sign-out` が届き、`session-expired` は送られない。S-8 (呼ばない画面) は、`SIGNED_OUT` が出たときだけ `session-expired` が先に届き、ネイティブは §6.2 の控えで受ける (変わらない。呼び出し側のコードも変えない)。2.105 は失効の前に借り物のセッションを捨てていたので、失効後のログアウトは保管が無く `_removeSession` だけして `{ error: null }` だった。
- **T-9 (S-9)**: 全端末ログアウトでサーバーのセッションと refresh_token が失効 → 残り 120 秒未満の最初の tick (`:4702-4706`) → `/token` 400 (`refresh_token_not_found`) → `storedNow` の `expires_at*1000 > now` → 残す (`:4310-4314`) → 控え 60 秒 (控えの間の tick は控えた失敗を受け取る `:4211-4216`) → E の後、控えが切れた最初の tick → `/token` 400 → 失効後なので `_removeSession` (`:4316`) → `SIGNED_OUT` → `MainLayout` (`isInNativeWebView()` でない `MainLayout.tsx:152-155`) → `treatAsSignedOut` (localStorage を消して `/login`)。失効から `SIGNED_OUT` まで ≤ 90 秒 (T-4 の上限)。2.105.3 は最初の tick の 400 で `_removeSession` していた (`GoTrueClient.js:3928-3936`)。この間 (失効の前も後も) に画面の要求が middleware に届くと T-28 になる。ブラウザの `getUser()` (閉包 W-2 の画面の呼び出し) が先に呼ばれれば、`/user` の 403 → `_removeSession` (`:2724-2731`) → `SIGNED_OUT` → 同じく `/login` (両版で同じ)。
- **T-10 (S-10)**: 要求の Cookie `sb-<ref>-auth-token=<JSON>` → middleware の `getAll` → `combineChunks` → `decodeChunkedCookieValue` が接頭辞無しの値をそのまま返す (`cookies.js:46-48`) → `getUser()` 通る。残り 90 秒未満なら更新 → `TOKEN_REFRESHED` → `applyServerStorage` → `cookieEncoding` が `raw` なので接頭辞を付けず JSON のまま分割して `setAll` へ (`:447-459`・`:449-452`・`:487-509`) → 応答の `Set-Cookie`。
- **T-11 (S-11)**: `.0` / `.1` を `combineChunks` がつなぐ (0.12 も `.N` の順につなぐ) → JSON → 同上。
- **T-12 (S-12)**: `applyServerStorage` の `removeExistingCookiesForItem` が、新しいチャンクの名前に無い古い名前 (`.1` や `.2`) を `maxAge: 0` で `setAll` に渡す (`:448-457`・`:495-499`)。`middleware.ts` の `setAll` はそれを `supabaseResponse.cookies.set({ name, value: '', ...options })` で書く。
- **T-13 (S-13)**: `handleCode` → `createClient(cookieStore)` → `setSession` → `_saveSession` → `setItem` → `applyServerStorage` は `SIGNED_IN` で走る (`createServerClient.js:52-70`) → JSON のまま `server.ts` の `setAll` → `store.set(...)`。アプリの注入 JS と `Networking.clearCookies` は名前 (`sb-`) か全部 (§6.4)。
- **T-14 (S-14)**: `Set-Cookie` の `sb-*-auth-token(.N)` は JSON (T-10) → 既存の `readSession`・`sessionFromSetCookie` が番号順につなぎ `decodeURIComponent` → `JSON.parse` (変えない)。
- **T-15 (S-15)**: `gateway(504)` = 本文 `upstream error`・`statusText` 空 → `handleError` の `error.json()` が失敗 → 504 は `NETWORK_ERROR_CODES` → `AuthRetryableFetchError('HTTP 504', 504)`。`withAuthTransientRetry` は `response.status` で判定 (`auth-transient-retry.ts:200`) → やり直しは今までどおり。
- **T-16 (S-16)**: ネイティブ (2.117)。Web の `signOut()` が全端末を失効 → アプリの tick (残り < 120 秒) → `/token` → 400 → 残す → E 以降の更新で捨てて `SIGNED_OUT` → AuthProvider の `SIGNED_OUT` の行 (§3) → 掃除と release。E までは access token で API が通る (サーバーのセッションの失効を見るのは GoTrue の `/user` と Next の `/api/*` の `getUser()` で、それらは 401 / 403 を返す。既存の 401 の扱いのまま)。
- **T-17 (S-17)**: `takeSessionSnapshot` (控え) → `getUser()` → 403 → `AuthSessionMissingError` → `_removeSession` (`:2726-2729`) → `SIGNED_OUT` → 控えた JWT で DELETE。2.117 の lock 無しで `sign-out` 側の `getSession()` が先に走っても、控えは共有 (§6.2 の「同じ控えを使い回す」)。
- **T-18 (S-18)**: 旧アプリの auth-js は端末に入ったまま。Web の `session-expired` / `sign-out` の意味・順番は変わらない (§6.2)。
- **T-19 (S-19)**: ネイティブ (2.117)。起動 → `_initialize` → `_recoverAndRefresh` (`:4126-4145`) → 失効済み (残り < 90 秒) → `_callRefreshToken` → `_refreshAccessToken` が接続の失敗をやり直す (約 25 秒。`:4042-4047`) → `AuthRetryableFetchError` → `:4299` の分岐に入らず捨てない → 控え (失敗の時刻 F から 60 秒。`:4324-4328`) → AuthProvider の `getSession()` (初期化を待つ) → `__loadSession` → `hasExpired` → `_callRefreshToken` → 控えを返す (`:4211-4216`) → 保管は失効済みなので `{ session: null, error: AuthRetryableFetchError }` (`:2563-2573`) → `classifyAuthError` が `transient` → `getStoredSession()` で起動 (§3。ここまで約 25 秒)。tick (30 秒ごと。RN では `_handleVisibilityChange` が常に動かす `:4724-4729`) は、控えの間 `__loadSession` が控えを受け取り `/token` を呼ばない。F + 60 秒より後の最初の tick か `getSession()` で `/token` を呼ぶ: 通信が戻っていれば成功 → `TOKEN_REFRESHED` (控えは消える `:4291`) → AuthProvider の `onAuthStateChange` で差し替わる。まだ戻っていなければ約 25 秒やり直して失敗し、控えを張り直す。通信が時刻 R に戻ったとき、更新までは (控えの残り ≤ 60 秒) + (次の tick ≤ 30 秒) で、最大約 90 秒。その間、supabase-js の要求は `getSession()` の `null` により anon キーで出る (2.105 は R の後の最初の契機で更新した)。
- **T-20 (S-20)**: ネイティブ (2.117)。`signOutOrForgetLocally` → `signOut()` → `_signOut` (`:3427`) → `_useSession` (保管の access token は有効) → `admin.signOut(jwt, 'global')` → 接続の失敗 (`AuthRetryableFetchError`) → 無視する 401 / 403 / 404 / `AuthSessionMissingError` でない (`:3443-3445`) → scope が `others` でないので `_removeSession` (`:3446-3448`) → 保管・verifier・`-user` を消して `SIGNED_OUT` (`:4432-4438`) → AuthProvider (`AuthProvider.tsx:240-259`) が画面を未ログインにし、掃除と release を流す → `signOut()` が `{ error }` を返す (`:3449`) → `signOutOrForgetLocally` (`signOut.ts:107-110`) が `clearStoredSessionLocally` (もう無いキーの `removeItem`) と `clearSession` (`setSession(null)`) → 呼び出し側がログインの画面へ。サーバーのセッションは失効していない (2.105 と同じ)。`signOutWithCleanup` (`signOut.ts:127`) と AuthProvider の scope `local` (`AuthProvider.tsx:207`) も、access token が有効なら同じ経路で保管を消す。access token が失効していて更新もできないときは `_useSession` の読み込みが失敗し、`/logout` まで届かない (T-22)。
- **T-21 (S-21)**: 更新の前、ブラウザの `signInWithOAuth` (ssr 0.1.0・auth-js 2.105.3) が `getCodeChallengeAndMethod` (2.105.3 `lib/helpers.js:264-274`) で従来のキーに verifier を書く (Cookie) → Google → 更新 → `/auth/callback?code=` → route の `createClient()` (ssr 0.12.7 の `getAll`) → `exchangeCodeForSession(code)` → ブラウザでなく flow id も渡さないので `requestedFlowId` は null (`GoTrueClient.js:1610-1615`) → `retrievePKCEVerifier` が従来のキーを読む (`lib/helpers.js:354-355`。値に `base64-` が無いのでそのまま `cookies.js:46-48`) → `/token?grant_type=pkce` → `_saveSession` → `SIGNED_IN` → `setAll` に `base64-` のセッションの Cookie と、従来のキーを消す書き込み (`removePKCEVerifier` `lib/helpers.js:362-366`)。更新の後に始めた flow は 3 つのキーを書き (`:327-341`)、コールバックは同じく従来のキーを読む。flow ごとのキーと一覧の Cookie は残り、次の `_removeSession` が一覧から消す (`:394-401`)。
- **T-22 (S-22)**: ネイティブ (2.117)。T-19 のあと (保管の access token は失効済み、通信は無い)。`signOutOnDevice` → `unregisterPushTokenOrRecordRelease` (削除は通信の失敗 → `recordPushTokenRelease`) → `clearUserScopedLocalData` → `signOutOrForgetLocally` → `signOut()` → `_signOut` (`:3427`) → `_useSession` → `__loadSession` → `hasExpired` → `_callRefreshToken`: 控えが有効なら控えた失敗を返す (`:4211-4216`)、切れていれば約 25 秒やり直して `AuthRetryableFetchError` → `:4299` の分岐に入らず捨てない → 控え (`:4324-4328`) → 保管は失効済みなので `{ session: null, error }` (`:2563-2573`) → `_signOut` は `AuthSessionMissingError` でないので `{ error }` を返す (`:3433-3435`。`admin.signOut` も `_removeSession` も通らない) → `signOutOrForgetLocally` (`signOut.ts:107-110`) が `clearStoredSessionLocally` (保管のキーと従来の verifier のキーを消す) と `clearSession` (`setSession(null)`) → 呼び出し側がログインの画面へ。`SIGNED_OUT` は出ないので、AuthProvider の `SIGNED_OUT` の行は走らない。そのあとの tick は保管が無いので何もしない。2.105.3 も同じ (`:3185-3187`。控えが無いぶん、毎回約 25 秒やり直す)。
- **T-23 (S-23)**: ネイティブ (2.117)。T-19 のあと、最後の失敗の時刻 F の控えが F + 60 秒まで効く。通信が R (F ≤ R < F + 60 秒) に戻る。R の後、まだ開いていないタブを開く → `WebViewScreen` の `useEffect` (`:206-262`) → `resolveBridgeCode` → `getSessionForBridge(supabase.auth)` (`:217`) → `auth.getSession()` (`webViewBridge.ts:565`) → `__loadSession` → `hasExpired` → `_callRefreshToken` → 控えを返す (`GoTrueClient.js:4211-4216`) → 保管は失効済みなので `{ session: null, error }` (`:2563-2573`) → `current` が null → `getSessionForBridge` は null (`webViewBridge.ts:568`) → `resolveBridgeCode` は null → 直接の URL (`withAppMode(effectivePath)`) → Web の middleware は Cookie のセッションが無い (タブ間で共有の借り物は access token と同じく失効していて、更新は借り物の値で 400 → 捨てる §9.6 ① の middleware の失効後の行) ので `/login` へ → ログイン画面の描画で `session-expired` (`login/page.tsx:55`) → ネイティブの `handleSessionExpired` → `takeSessionSnapshot` → `getSession()` は同じく控えた失敗で `session: null` → 控えは null → `no-session` (`webViewAuthMessages.ts:250`)。F + 60 秒より後の最初の tick (≤ 30 秒) が `/token` を呼んで成功 → `TOKEN_REFRESHED`。`WebViewScreen` はこれでは読み込み直さない。利用者が同じタブを押し直すと (`:186-204`) ログイン画面がもう一度描画され、`session-expired` → 控えあり → `getUser()` 通る → 回数制限 (10 秒の間隔・5 分で 3 回) を通れば `rebridge` → `effectivePath` が変わり bridge が通る。2.105.3 は R の後の `getSession()` が `/token` を呼び直して成功し、bridge が通った。
- **T-24 (S-24)**: ネイティブ (2.117)。残り 120 秒未満の tick → `_callRefreshToken` → 接続の失敗を約 25 秒やり直して `AuthRetryableFetchError` (時刻 F) → 保管は有効なので残る → 控え (F から 60 秒)。通信が戻る。まだ開いていないタブを開く → `getSessionForBridge` → `getSession()` は残りが 90 秒以上なら保管をそのまま返し、90 秒未満なら更新が控えに当たっても保管が有効なので保管を返す (`:2563-2572`) → 残りが 210 秒未満 → `refreshSessionOnce` → `refreshSession()` → `_refreshSession` → `_callRefreshToken` が控えた失敗を返す (`:3234-3236`) → `data.session` は null → `refreshedTokens` は null → 残りが 150 秒未満なので null (`webViewBridge.ts:579`) → 直接の URL。WebView に有効な借り物の Cookie (ほかのタブが張ったもの) があればそれで開き、見張りがすぐ `session-expired` を送る (`REFRESH_AHEAD_SECONDS` = 180 秒を切っている) → ネイティブは控えあり (保管は有効) → `getUser()` 通る → `rebridge` → bridge は同じく控えの間は null。控えが切れた後の契機で更新が通ってから、次の `session-expired` か利用者の操作で bridge が通る。2.105.3 は `refreshSession()` が `/token` を呼び直した。
- **T-25 (S-25)**: 新しいタブの auth-js 2.117 (または middleware) が更新 → `applyServerStorage` / ブラウザの `setItem` が `cookieEncoding: 'raw'` で JSON のまま `document.cookie` (`Set-Cookie`) に書く (`cookies.js:214-217`・`:449-452`。接頭辞を付けない) → 旧バンドルのタブの auth-js 2.105.3 の tick・`getSession()`・復帰 → ssr 0.1.0 の `combineChunks` (`dist/index.js:86-103`) → `getItemAsync` の `JSON.parse` が通る (`lib/helpers.js:129-136`) → `_isValidSession` が真 → 使い続ける。`base64url` なら `JSON.parse` が失敗して文字列が返り (`:137-139`)、`__loadSession` (`GoTrueClient.js:2336-2343`) / `_recoverAndRefresh` (`:3848-3853`) が `_removeSession` → Cookie を消して `SIGNED_OUT` → 旧バンドルの `MainLayout` (`isInNativeWebView()` でない) がログアウトとして扱う。
- **T-26 (S-26)**: Vercel を旧版に戻す → 旧版の middleware (ssr 0.1.0 の `get` → `combineChunks` → auth-js 2.105.3 の `getItemAsync`) が、更新のあとに書かれた JSON の Cookie を T-25 と同じく読む → `getUser()` 通る。
- **T-27 (S-27)**: 前面。見張りが E-180 から `session-expired` を送るが、ネイティブが読み込み直さない (回数制限の中、または S-23 の `no-session`)。ブラウザの auth-js は、E の前の最後の実際の `/token` (E-x、0 < x ≤ 60) の失敗の控えが E-x+60 まで効く (T-4 の上限の説明)。その間に E を過ぎ、画面が `/api/*` を呼ぶ → middleware の要求ごとのクライアント (控えを持たない) の `getSession()` (`lib/supabase/middleware.ts:191`) → `__loadSession` → `hasExpired` → `_callRefreshToken` → 借り物の値で `/token` 400 → `storedNow` の `expires_at*1000 > now` が偽 → `_removeSession` (`GoTrueClient.js:4316`) → サーバーのクライアントの `SIGNED_OUT` → ssr が Cookie を消す書き込み (`maxAge: 0`) を `setAll` に渡す (`createServerClient.js:52-70`) → 応答 (`supabaseResponse`) の `Set-Cookie` でブラウザの Cookie が消える (§9.6 ① の middleware の失効後の行)。ブラウザの auth-js の次の tick → `_useSession` → `__loadSession` は保管が空で `{ session: null, error: null }` (`:2532-2534`) → tick は `no session` で戻る (`:4697-4699`)。`getSession()` も同じ。復帰の `_recoverAndRefresh` も保管が空なら何もしない (`:4118-4124`)。どこも `_removeSession` を呼ばないので `SIGNED_OUT` は出ず、`MainLayout` の `onAuthStateChange` (`MainLayout.tsx:146-173`) は走らない (送らず、15 秒の待ちも張らず、localStorage も消さない)。見張りの次の `check` (≤ 20 秒) → `getSession()` が `null` → `notifyNativeSessionExpired()` (15 秒の間隔で畳む) → 以後 20 秒ごとに同じ。ネイティブの `handleSessionExpired` は、回数制限の中なら何もせず、制限が解けた後の送信で `rebridge`。S-23 の `no-session` なら、ネイティブの更新 (`TOKEN_REFRESHED`) の後の送信で控えが取れ、`getUser()` → `rebridge`。読み込み直しでページが入れ替わる。画面を移ると middleware の `getUser()` (`:291`) が Cookie 無しで `/login` へ回し、ログイン画面が `session-expired` を送る (§6.2)。2.105.3 では、前面のブラウザの tick が E-120 で借り物の値で更新して捨て、`SIGNED_OUT` が先に出ていた (middleware が更新を試みるのは残り 90 秒未満からなので、その後)。
- **T-28 (S-28)**: ふつうのブラウザ (前面)。全端末ログアウトのあと、ブラウザの auth-js が自分で捨てる前に、画面が `/api/*` を呼ぶ → middleware の要求ごとのクライアント (控えを持たない) → (1) 失効の前: `getSession()` (`lib/supabase/middleware.ts:191`。残り 90 秒未満なら更新が 400 でも、失効の前なので保管を残す) → `getUser()` (`:220`) → `/user` 403 `session_not_found` (サーバーのセッションが消えている) → `AuthSessionMissingError` → `_removeSession` (`GoTrueClient.js:2724-2731`。2.105.3 も同じ `:2506-2511`)。(2) 失効の後: `getSession()` (`:191`) → `__loadSession` → `hasExpired` → `_callRefreshToken` → `/token` 400 → `storedNow` が失効 → `_removeSession` (`:4316`) (続く `getUser()` (`:220`) は保管が空で `/user` を呼ばない)。どちらもサーバーのクライアントの `SIGNED_OUT` → ssr が Cookie を消す書き込み (`maxAge: 0`) を `setAll` に渡す (`createServerClient.js:52-70`) → 応答 (`supabaseResponse`) の `Set-Cookie` でブラウザの Cookie が消える。ブラウザの auth-js: 次の tick → `_useSession` → `__loadSession` は保管が空で `{ session: null, error: null }` (`:2532-2534`) → `no session` で戻る (`:4697-4699`)。`getSession()` も同じ。`getUser()` は保管が空なら `_removeSession` を通らずに `{ data: { user: null }, error: AuthSessionMissingError }` を返す (`:2714-2716`)。復帰の `_recoverAndRefresh` も何もしない (`:4118-4124`)。どこも `_removeSession` を呼ばないので `SIGNED_OUT` は出ず、`MainLayout` の `onAuthStateChange` (`MainLayout.tsx:146-173`) は走らない (localStorage を消さず `/login` へも移さない)。`NativeSessionWatcher` は WebView の外では何もしない (`NativeSessionWatcher.tsx:53`)。以後: 画面の `/api/*` は Cookie 無しで route の認証 (`src/lib/auth/helpers.ts:29` の `getAuthUser` など) が通らず、未ログインとして答える。supabase-js の直接の要求は anon キーで出る。画面を移る (全体の読み込み・RSC の要求) と、middleware の `getUser()` (`:291`) が user なしで `/login?next=…` へ回す (`:342-347`)。最初の要求が画面の移動なら、`getUser()` (`:291`) が失効の前は 403、失効の後は中の更新の 400 で user なしになり、同じく `/login?next=…` へ回る (Cookie はこの redirect では消えず、`/login` の要求の応答で消える §9.6 ① の middleware の 403 の行)。localStorage は次のログアウト (`clearUserScopedLocalStorage`) か次に `MainLayout` が受ける `SIGNED_OUT` まで残る。2.105.3: (1) は同じ (残り 90 秒未満では middleware の `getSession()` の更新の 400 が先に `_removeSession` する `GoTrueClient.js:3928-3936` が、Cookie を消す応答になるのは同じ。ブラウザの側も、保管が空なら `__loadSession` は `{ session: null, error: null }` `:2346-2348`・tick は `no session` `:4199`・`getUser()` も `_removeSession` を通らない `:2496-2498`)。ただし前面では、残り 120 秒未満の最初の tick の 400 でブラウザが先に捨てる (T-9) ので、(1) はそれまでの間だけで、(2) は起きなかった。2.117 では、ブラウザが失効の後に自分で捨てるまで (最大 90 秒) の間、(1) と (2) のどちらも起き得る。
- **T-29 (S-29)**: ネイティブ (2.117)。Web の同意画面の `handleDecline` (`src/app/legal-consent/LegalConsentForm.tsx:175-196`) が `notifyNativeSignOut()` (`:185`) で `sign-out` を送る → `useWebAuthMessages` → `performNativeSignOut` (`apps/mobile/src/lib/webViewAuthMessages.ts:219-239`) → `signOutWithCleanup` (`apps/mobile/src/lib/signOut.ts:120-129`。push token の削除は通信の失敗で控える → 掃除 → `supabase.auth.signOut()`) → `_signOut` (`GoTrueClient.js:3427`)。(a) 保管の access token が有効: T-20 と同じく `admin.signOut` が接続の失敗 → `_removeSession` (`:3446-3448`) → `SIGNED_OUT` → AuthProvider (`AuthProvider.tsx:240-259`) が `setSession(null)` と掃除・release → `signOutWithCleanup` は `{ error }` を返す (投げない) → `performNativeSignOut` が `deps.goToWelcome()` (`webViewAuthMessages.ts:231`) → `useWebAuthMessages` の `goToWelcome` (`:359-363`) が `options.afterSignOut` を呼ぶ → `afterSignOut` (`apps/mobile/app/legal-consent.tsx:81-88`) → `supabase.auth.getSession()` (`:82`) → `__loadSession` は保管が空で `{ session: null, error: null }` (`GoTrueClient.js:2532-2534`) → `close()` を呼ばない。扱いは `legalConsentScreenModeOf` (`apps/mobile/src/lib/legal-consent.ts:216-223`) が、サインイン中でなく required を見た後なので `signed-out-notice` → 「閉じる」を出す (`apps/mobile/app/legal-consent.tsx:95-113`)。(b) 保管の access token が失効していて、更新が接続の失敗で終わる (または控えの間): T-22 と同じく `_useSession` の読み込みが `{ session: null, error }` → `_signOut` は `{ error }` (`:3433-3435`。保管は残り `SIGNED_OUT` は出ない) → `goToWelcome` → `afterSignOut` → `getSession()` → `__loadSession` → `hasExpired` → `_callRefreshToken` は `signOut()` の中の更新が張った控えを返す (`:4211-4216`) → `{ session: null, error }` (`:2563-2573`) → `close()` を呼ばない。AuthProvider のセッションは残る (`SIGNED_OUT` が無い) ので、扱いは `awaiting-consent` (required のまま) で「閉じる」は出ず、同意画面の `usePreventRemove` (`apps/mobile/app/legal-consent.tsx:60-63`) が取り除く操作を全部止める (`legalConsentScreenPreventsRemoval`。`apps/mobile/src/lib/legal-consent.ts:248-255`。ゲートの畳み直し (RESET) は同意画面の route を key ごと再利用するので、同意画面は取り除かれない。cross/13b §6.6.8)。どちらの枝でも、Web の `signOut()` (`LegalConsentForm.tsx:188`) は通信の失敗で `{ error }` を返し (Web の借り物の access token が有効なら `/logout` の失敗、失効していれば更新の失敗。(b) では必ず後者)、`handleDecline` は「ログアウトに失敗しました」(`:192-194`) を出して form に戻る (`setPhase('idle')`)。2.105.3: (a) は `/logout` の失敗で保管を残して `{ error }` (`:3191-3198`)。`getSession()` は、残りが 90 秒以上なら保管を返して `close()` → 入口 (`ENTRY_SCREEN_PATH` = `/`) → ゲートが同意画面 1 つに畳み直す。90 秒未満なら `_signOut` の読み込みの更新が失敗して ① の枝で返り (`:3185-3187`)、`getSession()` も更新の失敗で `null` → (b) と同じ。(b) は同じ (控えが無いので、`getSession()` がもう 1 回ぶん約 25 秒やり直してから `null`)。

### 9.5 構造裁定 (1 回だけ)

| 案 | 中身 | 判定 |
|---|---|---|
| A: 合図は `SIGNED_OUT` のまま。見張りの 180 秒も `MainLayout` も変えない | 2.117 の「失効前は残す」は、見張りが受け持つ区間に重なる。失効後の `SIGNED_OUT` の遅れ (≤ 90 秒) は見張りの `null` の送信で埋まる | **採用**。コードを変えず、テストと説明を直す。縁 (新しい状態・新しい定数) を増やさない |
| B: `MainLayout` が自分で `expires_at` を見張り、失効の時点で `session-expired` を送る | 失効後の遅れ (≤ 90 秒) を無くせる | 不採用。見張り (`NativeSessionWatcher`) が同じことを既に 180 秒前からしている。`MainLayout` に 2 つ目の時計を置くと、送信の重なり (15 秒の間隔で畳むが) と 2 か所の閾値の保守が増える |
| C: 見張りの閾値を 120 秒より下げる (2.117 なら失敗しても害が無い) | 読み込み直しの回数を減らせる | 不採用。借り物の値での `/token` の 400 が毎回 1 回出て GoTrue のログと端末のコンソールを汚す。180 秒の根拠 (読み込み直しが失効の前に終わる) は 2.117 でも同じ。閾値テストの関係 (180 > 120 > 90) も据え置く |
| D: `cookieEncoding: 'raw'` で書式を 0.1.0 のまま保つ (middleware・server・client の 3 か所で、1 つの定数 `SUPABASE_COOKIE_ENCODING` を渡す) | デプロイの前に開いたタブの旧バンドル (ssr 0.1.0 + auth-js 2.105.3) と、Vercel を旧版に戻したときの旧サーバーが、更新のあとに書かれた Cookie を読める (S-25・S-26)。結合テストと e2e の JSON の読み取りも変えずに済む | **採用** (この改定)。旧バンドルは `base64-` の値を読むと `_removeSession` で Cookie を消して `SIGNED_OUT` を出す (§9.1 の ssr 0.1.0 の段落)。skew の対策 (`deploymentId`) が無いので旧バンドルのタブは読み込み直すまで残り、Cookie はブラウザで共有なので、1 つの旧タブがそのブラウザの全タブのセッションを消す。`raw` は 0.12.7 の型にある値 (`createServerClient.d.ts:11`・`:77`・`createBrowserClient.d.ts:33`) で、読みは書式に依らず両方を読むので、あとで `base64url` に切り替えるときも `raw` の版から読める (§9.17 Q-7) |
| D2: 既定の `base64url` をこの改定で入れる | ssr の既定に合う | 不採用 (この改定では)。S-25・S-26 で利用者が切れる (発注の「上げたあとも切れない」を満たさない)。切り替えは、0.1.0 の旧バンドルが残らないと見なせてから別の Issue で行う (§9.17 Q-7) |
| E: middleware の `setAll` で `NextResponse.next({ request })` を作り直す (Supabase の Next.js の例の形) | 同じ要求の Server Component が更新後の Cookie を読める | 不採用 (この改定では)。いまの 2 か所に書く形 (`request.cookies` と同じ `supabaseResponse`) を保つのが最小の差分で、`withLegalConsentPendingHeader` (`:89-98`) との順番も変わらない。作り直す案は §9.17 Q-2 に残す |
| F: 2 PR (Web と apps/mobile を分ける) | — | 不採用。lock は 1 つで、apps/mobile は巻き上げで同じ実体を使う (§9.10)。`package.json` の宣言だけ別 PR にする意味が無い |
| G: やり直せる失敗の控え (60 秒) による更新の遅れを避ける (通信の回復で `refreshSession()` を呼ぶ・控えを消す) | 通信が戻ってすぐ更新でき、その間の bridge も通る (S-19・S-23・S-24) | 不採用 (遅れを受け入れる)。**避ける手段が無い**: `refreshSession()` は引数なしでも `refresh_token` を渡しても同じ refresh_token なので控えに当たる (§9.1 `:3234`・`:4211-4216`。控えは refresh_token ごと)。`setSession` も失効した access token なら同じ refresh_token で `_callRefreshToken` を呼ぶ (`:3059-3075`)。控えを消す公開の API は無く、`lastRefreshFailure` (private) を書き換えるには型を外す cast が要る (禁止)。**起きる条件**: (1) access token が失効していて、最後の更新がやり直せる失敗 (5xx・接続の失敗を約 25 秒やり直した後) で終わり、その失敗から 60 秒の間に通信が戻ったとき (S-19・S-23)。(2) 残りが 150 秒未満の有効な access token で、60 秒以内に同じ refresh_token の更新がやり直せる失敗で終わり、その間に通信が戻ったとき (S-24)。どちらも約 25 秒以上の通信の失敗のあとの、回復から最大約 90 秒 (控えの残り ≤ 60 秒 + 次の tick ≤ 30 秒) に限られる。**その間に起きること**: ① supabase-js の要求が anon キーで出る (`getSession()` が `null`。失効後のとき) ② ネイティブでまだ開いていないタブを開くと、bridge が null で直接の URL になり、WebView は Web のログイン画面になる。ログイン画面の `session-expired` は、ネイティブの控えも null なので何もしない (S-23・S-24) ③ (1) のとき、既に開いている WebView から届く `session-expired` も同じく何もしない ((2) では控えが取れるので読み込み直すが、bridge は同じく null で直接の URL になる。T-24)。`MainLayout` が待っていれば 15 秒後に従来どおりログアウトとして扱う (§6.3 の 3。localStorage を消して `/login`。§6.3 の 3 が挙げる「ネイティブも未ログイン」「通信が極端に遅い」と同じ扱い)。**受け入れる理由**: どれも 2.105 でも通信が戻る前には同じ結果で (更新が失敗し `getSession()` は `null`)、2.117 で延びるのは回復から最大約 90 秒だけ。ネイティブのセッションは保管に残り (§3 の保存済みのセッションで画面は出たまま)、控えが切れた後の最初の契機で `TOKEN_REFRESHED` になって戻る。失効の取りこぼしも無い (サーバーが失効と答えれば `SIGNED_OUT`)。ログイン画面に残った WebView は、利用者が同じタブを押し直せば戻る (S-23)。`TOKEN_REFRESHED` で bridge の無い WebView を読み込み直す仕組みは apps/mobile の製品コードの新しい挙動で、本改定の範囲 (版の更新) に入れない (§9.17 Q-8) |
| H: サーバーの応答が先に Cookie を消して `SIGNED_OUT` が出ないとき (S-27) にも、`MainLayout` の 15 秒の待ち (§6.3 の 3。過ぎたら localStorage を消して `/login`) を張る (例: 見張りが `null` を見たら `MainLayout` に知らせる・`MainLayout` が自分で `getSession()` を見張る) | §6.3 の 3 の退避が、Cookie を消したのがブラウザかサーバーかに依らず効く | 不採用 (受け入れる)。**退避が要る理由がこの経路に無い**: §6.3 の 3 が挙げる理由のうち「`session-expired` を知らない旧アプリ」は、借り物のセッションを持たない (コード方式のブリッジを使うのは `session-expired` を処理する新しいビルドだけ §7) ので起きない。残りの理由 (ネイティブ側の回数制限・ネイティブも未ログイン (S-23)・通信が極端に遅い) では、退避しないほうが早く戻る: 見張りは Cookie が無い間、20 秒ごとと前面への復帰のたびに `session-expired` を送り続け (`NativeSessionWatcher.tsx:65-67`・`:82-87`)、制限が解けるか、ネイティブの更新が済んだ (S-23 の最大約 90 秒) あとの最初の送信で読み込み直される。退避した先の `/login` は `MainLayout` の外で見張りが居らず、描画の 1 回しか送らない (`src/app/(auth)/login/page.tsx:55`) ので、そこで制限や `no-session` に当たると、利用者がタブを押し直すまでログイン画面に残る (S-23)。加えて、退避しなければ user-scoped の localStorage が消えない (§6.3 がもともと避けたかったもの)。**受け入れる帰結**: 読み込み直しまでの間 (ネイティブが生きていれば、回数制限の窓 (5 分で 3 回) か S-23 の窓 (通信の回復から最大約 90 秒) に、見張りの間隔 (20 秒) を足した時間まで)、画面は Cookie の無いまま残り、認証の要る `/api/*` は未ログインとして答え (401 など)、supabase-js の直接の要求は anon キーで出る。401 で自分から `/login` へ移る画面 (§8) はそう動き、画面を移ると middleware が `/login` へ回す。ネイティブのセッションも失効していれば、`session-expired` の受け取りでネイティブがログアウトを揃える (§6.2)。コードは変えない (裁定 A の範囲に閉じる)。§9.9 の A-9 の 1 行目が `MainLayout` の側を固定する |
| H2: 実際の refresh_token のふつうのブラウザで、サーバーの応答が先に Cookie を消して `SIGNED_OUT` が出ないとき (S-28) にも、`MainLayout` がログアウトとして扱う (localStorage を消して `/login`。例: `MainLayout` が `getSession()` を見張り、保管が空になったら `treatAsSignedOut`) | Cookie を消したのがブラウザかサーバーかに依らず、`/login` への移動と user-scoped の localStorage の削除が揃う | 不採用 (受け入れる)。**帰結は両版に既にある**: サーバーのセッションが消えたあと (全端末ログアウト・退会など)、ブラウザの `getUser()` より先に画面の `/api/*` か画面の移動が middleware に届くと、middleware の `getUser()` (`lib/supabase/middleware.ts:220`・`:291`) が 403 `session_not_found` で `_removeSession` を呼んで Cookie を消し、ブラウザには事象が届かない (§9.6 ① の middleware の 403 の行・③ (a) の「有効 / 失効前・控え中 → 保管なし」の行。2.105.3 も `_getUser` の `GoTrueClient.js:2506-2511` と、保管が空なら `__loadSession` が `{ session: null, error: null }` を返すだけ `:2346-2348`・tick は `no session` `:4199`)。`/api/*` の通信のある画面では、全端末ログアウトのあとの最初の要求でこの経路になる。2.117 で増えるのは、前面のブラウザが失効の 120 秒前に先に捨てなくなったぶん、同じ順が起き得る間が、失効の後にブラウザが自分で捨てるまで (最大 90 秒。T-4) 延び、失効の後の更新の 400 の経路が加わること (T-28) だけ。**対処には新しい判定が要る**: 2.117 では `getSession()` の `null` は「失効後・控え中」(やり直せる失敗の後で、保管は残る。③ (a)) にも返るので、`null` だけでログアウトとして扱うと、一時的な通信の失敗で利用者をログアウトさせる。保管が空かどうか (`error` が `null` か) で分けて見張るのは `MainLayout` の 2 つ目の時計 (裁定 B と同じ形) で、版の更新の範囲 (R-3。`MainLayout` のコードを変えない) を越える。直すなら既存の 403 の経路も同じ対処で直るので、別の Issue で設計する (§9.17 の Q-9)。**受け入れる帰結**: Cookie が無いので、次に画面を移ると middleware が `/login?next=…` へ回し (`lib/supabase/middleware.ts:342-347`)、認証の要る `/api/*` は未ログインとして答え (401 など。401 で自分から `/login` へ移る画面は移る §8)、supabase-js の直接の要求は anon キーで出る。user-scoped の localStorage は、次のログアウト (`clearUserScopedLocalStorage` を呼ぶ画面) か次に `MainLayout` が受ける `SIGNED_OUT` まで残り、その前に同じブラウザで別の利用者がログインすると、前の利用者の値 (§6.3 の冒頭の一覧と、家族の表示の切り替え `familyViewState_`) がその利用者の画面に残る (403 の経路と同じ)。コードは変えない。§9.9 の A-9 の 2 行目が `MainLayout` の側を固定する |

縁の発生源を消すより単純な構造は無いか: 合図を 1 つ (`SIGNED_OUT`) に保ち、失効前の区間を見張り 1 つに任せる A が最も単純。2.117 が消した「捨てたが使える」区間は、本書の 2 段構えがもともと避けたかった区間そのもの (S-2 の `/login` の一瞬) で、構造は簡単になる方向。Cookie の書式は、書き手 (新しいサーバー・新しいバンドル) と読み手 (旧バンドル・ロールバックした旧サーバーを含む) の組を 1 つの書式 (JSON) に閉じる D が、読み手の版の数を数えずに済むので最も単純。H は合図を増やさない (見張りの `null` は、もともと 2 段構えの 1 の合図) うえ、退避の待ちを張らないほうが早く戻るので、構造を足さない。 H2 も合図を増やさず、既存の 403 の経路と同じ帰結に揃えるだけで、構造を足さない (足すなら 403 の経路と合わせて 1 つの仕組みにする。Q-9)。

### 9.6 表 3 点

**① 全パターン表** (借り物 = `refresh_token` が `NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER`。E = access token の失効)

| 実行環境 | 契機 | 残り | 2.105.3 | 2.117.3 | 受ける側 (設計後) |
|---|---|---|---|---|---|
| WebView (借り物) | tick | ≥ 120 秒 | 何もしない | 何もしない | 見張りが E-180 で `session-expired` (S-1) |
| WebView (借り物) | tick | 120〜90 秒 | 捨てて `SIGNED_OUT` | 残す + 控え 60 秒 | 見張り (S-2)。`MainLayout` には届かない |
| WebView (借り物) | `getSession()` (API)・復帰 | 90〜0 秒 | 捨てて `SIGNED_OUT`。`getSession()` は `null` | 残す + 控え。`getSession()` は保管を返す | 見張り (S-3)。API は通る |
| WebView (借り物) | tick・`getSession()`・復帰 | 失効後 (控え有効) | (保管は既に無い) | `/token` を呼ばず `{ session: null, error }`。保管はまだある | 見張りが `null` で `session-expired` (S-4 の復帰の確認) |
| WebView (借り物) | tick・`getSession()`・復帰 | 失効後 (控え切れ) | — | 捨てて `SIGNED_OUT` | `MainLayout` → `session-expired`・15 秒の待ち (S-4〜S-6) |
| WebView (借り物) | サーバーの応答 (middleware・Cookie を書ける route の server client) が先に Cookie を消した後の tick・`getSession()`・復帰 | 失効後 (ブラウザの auth-js が捨てる前に、画面の要求がサーバーに届いた) | 前面では起きない (ブラウザの tick が失効の 120 秒前に先に捨てる) | 保管が空なので `{ session: null, error: null }` を返すだけ。事象は無く `SIGNED_OUT` は出ない (`GoTrueClient.js:2532-2534`・tick `:4697-4699`・`_recoverAndRefresh` `:4118-4124`)。ブラウザが自分の更新を始めた後に消えたときは、その失敗で読み直す保管 (`storedNow`) が空 (失効扱い) で `_removeSession` → `SIGNED_OUT` (`:4310-4316`。上の行と同じ) | 見張りが `null` で `session-expired` を送り続ける (20 秒ごと)。`MainLayout` は送らず、15 秒の待ちも張らない (localStorage は残り `/login` へも移らない。§6.3 の 5・S-27・裁定 H) |
| WebView (借り物) | `signOut()` | 失効前 (控えの有無に依らない) | `SIGNED_OUT` (サーバーへのログアウトが失敗したら保管が残り `SIGNED_OUT` も無い) | `SIGNED_OUT` (`/logout` が失敗しても保管を消す) | `notifyNativeSignOut` 済みなら送らない (S-7・S-8) |
| WebView (借り物) | `signOut()` | 失効後 (控え有効) | (保管は既に無い。`_removeSession` だけして `{ error: null }`・`SIGNED_OUT`) | `/logout` を呼ばずに `{ error }`。Cookie は残り `SIGNED_OUT` 無し (`:3433-3435`) | ネイティブには `sign-out` が先に届いている (S-7)。残った Cookie は次の失効後の更新 (控えの無いクライアント・middleware) の 400 で捨てる (T-7) |
| WebView (借り物) | `signOut()` | 失効後 (控え切れ) | (同上) | 更新が 400 → 捨てて `SIGNED_OUT` → `{ error }` | 成功のときと同じ (S-7・S-8) |
| ふつうのブラウザ (実 token) | tick・`getSession()` | 120〜0 秒 (失効と答えられた) | 捨てて `/login` | 残す → 失効後の最初の実際の更新で `SIGNED_OUT` → `/login` (失効から最大 90 秒)。その前にサーバーの応答が Cookie を消すと `SIGNED_OUT` は出ない (下の「先に Cookie を消した後」の行) | `MainLayout` (S-9)。サーバーが先に消したときは何もしない (S-28) |
| ふつうのブラウザ (実 token) | 更新が成功 | 120〜0 秒 | `TOKEN_REFRESHED` | 同じ (控えは消える) | — |
| ふつうのブラウザ (実 token) | 画面の `getUser()` (引数なし。閉包 W-2) が `403 session_not_found` (サーバーのセッションが消えた: 全端末ログアウト・退会など) | 任意 (access token の署名と期限は有効) | `AuthSessionMissingError` → `_removeSession` → `SIGNED_OUT`。呼び出しは `user: null` とそのエラーを受け取る | 同じ (§9.1 の `getUser()` の行 `GoTrueClient.js:2724-2731`) | `MainLayout` §6.3 (localStorage を消し `/login`。③ (b) の `isInNativeWebView()` でない行。S-9 の後続と同じ)。呼び出し側は変えない。両版で同じ (§9.12 の `GET /user` の行) |
| ふつうのブラウザ (実 token) | サーバーの応答 (middleware の `getUser()` の 403 `session_not_found`・失効後の `getSession()` の更新の 400。T-28) が先に Cookie を消した後の tick・`getSession()`・`getUser()`・復帰 | 403 は失効の前 (サーバーのセッションが消えた後)・400 は失効の後 (ブラウザの auth-js が捨てる前) | 403 では同じ (保管が空なので事象なし。2.105.3 `GoTrueClient.js:2346-2348`・tick `:4199`)。400 の経路は前面では起きない (ブラウザの tick が失効の 120 秒前に先に捨てる) | 保管が空なので `{ session: null, error: null }` を返すだけ (`GoTrueClient.js:2532-2534`・tick `:4697-4699`・`_recoverAndRefresh` `:4118-4124`)。`getUser()` は `_removeSession` を通らずに `{ data: { user: null }, error: AuthSessionMissingError }` (`:2714-2716`)。事象は無く `SIGNED_OUT` は出ない | `MainLayout` は何もしない (user-scoped の localStorage は残り、`/login` へも移らない。見張りは居ない)。次に画面を移ると middleware が `/login?next=…` へ回し、認証の要る `/api/*` は未ログインとして答える (§6.3 の「ふつうのブラウザ」の段落・S-28・裁定 H2) |
| ふつうのブラウザ・ネイティブ (実 token) | `signOut()` (scope global / local) で `/logout` が成功 (401 / 403 / 404 = サーバーにセッションがもう無い、も同じ扱い。§9.1 の `_signOut` の失敗の行の ②) | 失効前 (access token が有効)、または失効後で更新が成功 | `_removeSession` → `SIGNED_OUT` → `{ error: null }` | 同じ | ふつうのブラウザは `MainLayout` §6.3 (localStorage を消し `/login`。③ (b) の `isInNativeWebView()` でない行)。ネイティブは §3 のログアウトの行 → AuthProvider の `SIGNED_OUT` の行 (`AuthProvider.tsx:240-259`。掃除と release)。`signOutOrForgetLocally` の端末での消去は重なる (害は無い。閉包 W-6・M-4) |
| Next の middleware (借り物の Cookie) | `/api` の `getSession()`・画面の `getUser()` | 90〜0 秒 | 捨てて `SIGNED_OUT` → `applyServerStorage` が Cookie を消す応答 | 残す。Cookie は変わらない | 要求は access token で通る。見張りが先に読み込み直すのが常 |
| Next の middleware (借り物の Cookie) | 同上 | 失効後 | Cookie を消す | 同じ (捨てて `SIGNED_OUT` → Cookie を消す応答) | 画面は `/login` へ → ログイン画面が `session-expired` (§6.2)。`/api/*` の要求では応答で Cookie を消すだけで、ブラウザの auth-js に事象は届かない (上の「先に Cookie を消した後」の行。S-27) |
| Next の middleware (実 token の Cookie) | 同上 | 90〜0 秒 (失効と答えられた) | Cookie を消す → `/login` | 残す → 失効後に Cookie を消す | サーバーのセッションが残っていれば、利用者は失効まで使える (消えていれば下の 403 の行で、両版とも先に Cookie を消す)。失効後に Cookie を消したのが `/api/*` の応答なら、ブラウザの auth-js に事象は届かず `SIGNED_OUT` は出ない (ふつうのブラウザの「先に Cookie を消した後」の行・S-28) |
| Next の middleware (実 token・借り物の Cookie) | 画面の `getUser()` が `403 session_not_found` (サーバーのセッションが消えた: 全端末ログアウト・退会など) | 任意 (access token の署名と期限は有効) | `AuthSessionMissingError` → `_removeSession` → `SIGNED_OUT`。Cookie を消す書き込みは `supabaseResponse` に積まれる | 同じ (§9.1 の `getUser()` の行 `GoTrueClient.js:2724-2731`) | `user` が `null` → 公開でない画面は `/login?next=…` へ (`lib/supabase/middleware.ts:342-347`)。この redirect は Cookie を引き継がないので、Cookie が消えるのは `/login` の要求で同じ 403 を受けた応答 (`:459` の `supabaseResponse`)。`/api/*` の要求 (`:220`) では、その応答で Cookie が消え、ブラウザの auth-js に事象は届かない (ふつうのブラウザは S-28、WebView は見張りが受ける §6.3 の 5)。両版で同じ (§9.12 の `GET /user` の行) |
| ネイティブ (実 token) | tick・`getSession()` | 120〜0 秒 (失効と答えられた) | 捨てて `SIGNED_OUT` | 残す → 失効後に `SIGNED_OUT` | AuthProvider の `SIGNED_OUT` の行 (S-16) |
| ネイティブ (実 token) | `getUser()` の 403 | 任意 | `_removeSession` → `SIGNED_OUT` | 同じ | §3・§6.2 (S-17) |
| ネイティブ (実 token) | 起動時 `getSession()` (期限切れ + オフライン) | 失効後 | `AuthRetryableFetchError` → 保管は残り `null`。初期化と `getSession()` のそれぞれで約 25 秒やり直す | 捨てない (保管は残り `null`)。初期化の失敗を 60 秒控え、`getSession()` は控えた失敗をすぐ返す (合わせて約 25 秒) | §3 の `getStoredSession()` (経路は変わらない)。更新は控えが切れてから (S-19) |
| ネイティブ (実 token) | WebView のまだ開いていないタブを開く (`getSessionForBridge`。`WebViewScreen.tsx:217`) | 失効後・控え中 (通信は戻っている) | `getSession()` が `/token` を呼び直して更新し、bridge が通る | `getSession()` が控えた失敗 (`session: null`) → `getSessionForBridge` が null (`webViewBridge.ts:568`) → 直接の URL → Web のログイン画面 | 裁定 G で受け入れる。ログイン画面の `session-expired` は下の行。利用者が同じタブを押し直すと、ネイティブの更新の後なら bridge が通る (S-23・T-23) |
| ネイティブ (実 token) | 同上 | 失効前で残り 150 秒未満・控え中 (60 秒以内にやり直せる失敗。通信は戻っている) | `refreshSession()` が `/token` を呼び直して更新し、bridge が通る | `refreshSessionOnce` が控えた失敗をすぐ受け取り null → `webViewBridge.ts:579` で null → 直接の URL (共有の借り物の Cookie が有効ならそれで開き、無ければログイン画面) | 裁定 G で受け入れる (S-24・T-24) |
| ネイティブ (実 token) | WebView の `session-expired` (ログイン画面・`MainLayout`・見張り) の受け取り (`handleSessionExpired`) | 失効後・控え中 (通信は戻っている) | `getSession()` が更新して控えを取り、`getUser()` → 読み込み直し | 控え (`getSession()`) が null → `no-session` で何もしない (`webViewAuthMessages.ts:250`) | 裁定 G で受け入れる。`MainLayout` が待っていれば 15 秒後にログアウトとして扱う (§6.3 の 3。S-23) |
| ネイティブ (実 token) | 規約の同意画面 (`apps/mobile/app/legal-consent.tsx`) で、Web からの `sign-out` の `signOutWithCleanup` の `signOut()` が通信の失敗で終わったあとの `afterSignOut` の `getSession()` (`:82`) | 失効前 (access token が有効) / 失効後 (更新もできない) | 失効前: 保管が残り、残りが 90 秒以上なら `getSession()` が保管を返して入口へ移る (ゲートが同意画面 1 つに畳み直す。ログイン中のまま)。90 秒未満なら更新の失敗で `null` → 移らない。失効後: 保管が残り、更新の失敗で `null` → 移らない | 失効前: 保管を消して `SIGNED_OUT` → `getSession()` は保管が空で `{ session: null, error: null }` → 移らない。失効後: 保管が残り、控えた失敗で `null` → 移らない (両版で同じ) | 失効前: 成功のときと同じく、扱いが `signed-out-notice` になり「閉じる」を出す (AuthProvider の `SIGNED_OUT` の行の掃除と release も走る)。失効後: `SIGNED_OUT` が無く AuthProvider のセッションが残るので、扱いは `awaiting-consent` のまま「閉じる」は出ない。Web の `signOut()` も失敗して form に戻るので害は無い (両版で同じ)。S-29・T-29・③ (d) |
| どれでも (実 token・借り物、Web・ネイティブ) | tick・`getSession()`・復帰で `/token` が 5xx・接続の失敗 (`AuthRetryableFetchError`) | 任意 | 捨てない。次の契機でまた `/token` | 捨てない (失効後でも)。失敗を 60 秒控え、その間は `/token` を呼ばない。失効前の `getSession()` は保管を返し、失効後は控えた失敗 (`{ session: null, error }`) を返す | 見張りは `AuthRetryableFetchError` なら送らない (`NativeSessionWatcher.tsx:62`)。ネイティブは S-19。遅れは裁定 G で受け入れる |
| どれでも (Web・ネイティブ) | `signOut()` (scope global / local) の `/logout` が 5xx・接続の失敗 | 失効前 (access token が有効。残り 90 秒未満で更新に失敗していても) | 保管を残して `{ error }`。`SIGNED_OUT` 無し (残り 90 秒未満で更新が失敗したときは `/logout` まで届かず、`{ error }` で返った。やり直せない失敗なら、その更新が捨てて `SIGNED_OUT`) | 保管を消して `SIGNED_OUT` を出し `{ error }` (§9.1 の `_signOut` の失敗の ②) | Web は `MainLayout` §6.3 (成功のときと同じ)。ネイティブは AuthProvider の `SIGNED_OUT` の行と `signOutOrForgetLocally` の端末での消去 (S-20・閉包 W-6・M-4)。scope `others` は両版とも保管を残す |
| どれでも (Web・ネイティブ) | `signOut()` (scope global / local) で、更新が 5xx・接続の失敗で終わる (控えの間も) | 失効後 | `/logout` を呼ばずに `{ error }`。保管は残り `SIGNED_OUT` 無し (`:3185-3187`) | 同じ (`:3433-3435`。§9.1 の `_signOut` の失敗の ①) | ネイティブは `signOutOrForgetLocally` の端末での消去 (`clearStoredSessionLocally`・`clearSession`) が後始末の本体 (S-22。§3 の `{ error }` の行の (b))。`signOutWithCleanup` の経路はログイン中のまま残る。Web は Cookie が残る (呼び出し側は変えない) |
| どれでも (Web・ネイティブ) | `signOut()` (scope global / local) で、更新がやり直せない失敗 (400 など) | 失効後 | 更新が捨てて `SIGNED_OUT`、`signOut()` は `{ error }` | 同じ | 成功のときと同じ後続 (`SIGNED_OUT` の行)。ネイティブの `signOutOrForgetLocally` の端末での消去は重なる (害は無い) |
| どれでも (Web・ネイティブ) | `signOut()` (scope global / local) で保管が空 (サーバーの応答が先に Cookie を消した後・`getUser()` の 403 の後など) | — | GoTrue を呼ばず `_removeSession` → `SIGNED_OUT` → `{ error: null }` (`:3202-3206`) | 同じ (`:3437-3438`・`:3453-3456`) | 成功のときと同じ後続 (`SIGNED_OUT` の行。③ (a) の「保管なし」× `signOut()` の行) |
| どれでも (Web・ネイティブ) | `signOut({ scope: 'others' })` | 失効前 (access token が有効)、または保管が空 | 他の端末のセッションだけを取り消し、保管は残り `SIGNED_OUT` 無し。`/logout` が失敗なら `{ error }`。保管が空なら何もせず `{ error: null }` | 同じ (`:3446`・`:3453` の `scope !== 'others'` の分岐を通らない) | 製品のコードに呼び出しは無い (閉包 W-6 の `src/app/(main)/settings/account/page.tsx:151`・M-4 の `apps/mobile/src/lib/account-credentials.ts:80` の 2 行は #1720 段 C で無くなった)。失効後は上の scope global / local の 2 行と同じ (セッションの読み込みで決まる) |
| どれでも (Web・ネイティブ) | `_useSession` を通る呼び出し (規則 U: 引数なしの `getUser()`・`updateUser`・`mfa.*`・引数なしの `refreshSession()`) | 90〜0 秒 (更新が失敗) | `{ session: null, error }` を受け取り、呼び出しはそのエラーで終わる | 保管の access token で GoTrue を呼ぶ (`refreshSession()` は控えの間は控えた失敗) | 閉包 W-2・W-4・W-9・M-2・M-3・M-6。サーバーが失効と答えれば 401 / 403 (両版で同じ) |
| ふつうのブラウザ (PKCE) | `signInWithOAuth` / `signUp` / `resetPasswordForEmail` / メールの `updateUser` → コールバックの route の `exchangeCodeForSession(code)` | — | verifier の Cookie は従来のキー 1 つ | 3 つ (flow ごと・一覧・従来)。コールバックは flow id 無しで従来のキーを読む | 更新をまたぐ flow も通る (S-21・閉包 W-7・W-8)。flow ごとと一覧の Cookie は `_removeSession` か 5 本の輪で消える |
| Next の route (Cookie / Bearer の token) | `getClaims(token)` で token が期限切れ | 失効後 | `Error` を投げ、route まで上がる (`recordWebLoginContextFromRequest` は catch して warn の stage `exception`) | `{ data: null, error }` → `readSessionAssurance` が `AUTH_UNAUTHENTICATED` (401)。`readSessionAuth` は null → `requireSessionUser` が `AUTH_UNAUTHENTICATED`・`recordWebLoginContextFromRequest` は warn の stage `claims` | `src/lib/auth/mfa/assurance.ts:68-69` (閉包 W-9)・`src/lib/auth/sessions/session-claims.ts:43-44` (閉包 W-10) |

**①-2 Cookie の書式 × 読み手** (書き手 = 更新のあとの middleware・server・ブラウザ。読み手の「旧」= ssr 0.1.0 + auth-js 2.105.3)

| 書き手の書式 | 読み手 | 読んだ結果 | 帰結 |
|---|---|---|---|
| JSON (0.1.0 が書いたもの。更新の前からの Cookie) | 新 (middleware・server・ブラウザ) | `decodeChunkedCookieValue` がそのまま返す → 使う | ログインが続く (S-10・S-11) |
| JSON (`raw`。設計後に書く) | 新 | 同上 | 同上 |
| JSON (`raw`) | 旧バンドルのタブ・WebView のページ (デプロイの前に開いた) | `combineChunks` → `getItemAsync` の `JSON.parse` が通る → 使う | ログインが続く (S-25・T-25) |
| JSON (`raw`) | 旧サーバー (Vercel を旧版に戻した) | 同上 | ログインが続く (S-26・T-26) |
| `base64-` (不採用の `base64url`。裁定 D2) | 新 | `decodeChunkedCookieValue` が戻す → 使う | ログインが続く |
| `base64-` (不採用の `base64url`) | 旧バンドル・旧サーバー | `getItemAsync` の `JSON.parse` が失敗し文字列 → `_isValidSession` が偽 → `_removeSession` (Cookie を消す) → `SIGNED_OUT` | 切れる (ブラウザで共有の Cookie なので全タブ)。これを避けるため設計は書かない |

**② 状態比較表** (現行 = 2.105.3 + ssr 0.1.0 / 設計後 = 2.117.3 + ssr 0.12.7)

| 項目 | 現行 | 設計後 |
|---|---|---|
| 借り物の先回りの更新 (失効前) の失敗 | セッションを捨てて `SIGNED_OUT`。`getSession()` は `null` | セッションを残す。`SIGNED_OUT` 無し。`getSession()` は保管を返す。失敗を 60 秒控える |
| 借り物の失効後の更新の失敗 | (失効前に捨てている) | 捨てて `SIGNED_OUT` (失効から ≤ 90 秒)。その前にサーバーの応答が Cookie を消すと出ない (下の行) |
| 借り物の失効後、ブラウザの auth-js より先にサーバー (middleware など) が Cookie を消す | 前面では起きない (ブラウザが失効の 120 秒前に捨てる) | 起きる (ブラウザは失効後も控えの間は更新を試みない)。`SIGNED_OUT` は出ず、`MainLayout` は送らず待ちも張らない。合図は見張りの `null` だけ (S-27・裁定 H) |
| ふつうのブラウザ (実 token) で、サーバーで refresh_token が失効したあと (全端末ログアウトなど)、ブラウザの auth-js より先にサーバー (middleware など) が Cookie を消す | サーバーのセッションが消えたときの `getUser()` の 403 で起きる (前面では、ブラウザの tick が失効の 120 秒前に捨てるまでの間)。`SIGNED_OUT` は出ず、`MainLayout` は何もしない | 同じことが、失効の後にブラウザが自分で捨てるまで (最大 90 秒) も起き得る (失効後の更新の 400 の経路が加わる)。`SIGNED_OUT` は出ず、`MainLayout` は何もしない (user-scoped の localStorage は残り、`/login` へは次の画面の移動で移る。S-28・裁定 H2) |
| 同じ refresh_token での `/token` の回数 | 契機のたび (tick 30 秒ごと + `getSession()` のたび) | 失敗のあとは 60 秒に 1 回まで (やり直せる失敗も同じ) |
| やり直せる失敗 (5xx・接続の失敗) のあとの回復 | 次の契機 (tick ≤ 30 秒・`getSession()`) で実際に更新する | 失敗から 60 秒は `/token` を呼ばない。失効後は `getSession()` が控えた失敗 (`session: null`) を返し、要求は anon キーで出る。通信の回復から更新まで最大約 90 秒 (60 秒 + tick。S-19・裁定 G) |
| 期限切れ + オフラインの起動 (ネイティブ) の読み込み中 | 約 51 秒 (初期化と `getSession()` のそれぞれで約 25 秒のやり直し) | 約 25 秒 (`getSession()` は初期化の失敗の控えをすぐ受け取る) |
| `MainLayout` の `SIGNED_OUT` の扱い | §6.3 | 同じ (コードは変えない)。コメントを 2.117 に。`SIGNED_OUT` が来ない経路 (WebView の S-27・ふつうのブラウザの S-28) では何もしない |
| `NativeSessionWatcher` の閾値 | 180 秒 | 同じ。コメントを 2.117 に |
| 見張りが `null` を見る場面 | Cookie が消えた | Cookie が消えた (サーバーの応答が先に消したとき S-27 を含む)・失効後で控えが効いている間 |
| auth-js の lock | `navigator.locks` / `lockNoOp` + 待ち行列で直列 | 無し (`lock = null`)。更新だけ単一化 (`refreshingDeferred`) |
| middleware / server の Cookie の API | `get` / `set` / `remove` | `getAll` / `setAll` (`setAll` の `headers` は middleware だけ応答に付ける) |
| 書かれる Cookie の値 | JSON (チャンク 3,180 バイト) | 同じ (`cookieEncoding: 'raw'` を 3 つの呼び出し口で明示。既定の `base64url` は使わない) |
| 読める Cookie の値 | JSON | JSON と `base64-` の両方 |
| 旧バンドル (デプロイの前に開いたタブ)・旧版に戻したサーバーが、更新のあとに書かれた Cookie を読めるか | — | 読める (JSON。①-2) |
| ネイティブの bridge (`getSessionForBridge`) が、通信の回復の直後 (失敗の控えの間) に開くタブ | 更新して bridge が通る | null → 直接の URL (Web のログイン画面、または共有の借り物の Cookie)。回復から最大約 90 秒 (S-23・S-24。裁定 G) |
| ネイティブの `session-expired` の受け取り (失効後・控えの間) | 更新して読み込み直す | `no-session` で何もしない (S-23) |
| Cookie の `maxAge` | 1,000 年 (ブラウザは 400 日で切る) | 400 日 |
| `createBrowserClient` のテスト用の options | `cookies: {}` が要る | 不要 (省く) |
| 504 (本文が JSON でない) の message | `'{}'` | `statusText` か `'HTTP 504'` |
| `_recoverAndRefresh` の失敗のログ | `console.error` | 出ない (`_debug` だけ) |
| `mfa.enroll` の data URL・`_updateUser` / `_signOut` のセッション無し・`admin.signOut`・`getUser()` の 403 | — | 同じ (§9.1) |
| `signOut()` (scope global / local) の `/logout` の失敗 (access token が有効) | 保管を残して `{ error }`。`SIGNED_OUT` 無し | 保管を消して `SIGNED_OUT` を出し `{ error }` (scope `others` は両版とも残す) |
| `signOut()` (scope global / local) で、access token が失効していて更新もできない (5xx・接続の失敗・控えの間) | `/logout` を呼ばずに `{ error }`。保管は残り `SIGNED_OUT` 無し | 同じ (端末での消去 `clearStoredSessionLocally`・`clearSession` が後始末の本体。S-22) |
| 規約の同意画面で、Web からの `sign-out` のネイティブのサインアウトが通信の失敗で終わる (access token が有効) | 保管が残り、`afterSignOut` は残りが 90 秒以上なら入口へ移す (ゲートが同意画面に畳み直す。ログイン中のまま)。90 秒未満なら移らず、同意を待つ扱いのまま | 保管を消して `SIGNED_OUT`。`afterSignOut` は移らず、成功のときと同じく「閉じる」を出す (S-29) |
| 同 (access token が失効していて更新もできない) | 保管が残り、`afterSignOut` は `getSession()` の `null` で移らず、同意を待つ扱いのまま (「閉じる」は出ない。Web も失敗して form に戻る) | 同じ (S-29) |
| `_useSession` を通る呼び出し (規則 U) の、残り 90 秒未満の更新の失敗 | 呼び出しがそのエラーで終わる | access token が有効なら保管の token で呼び通る |
| PKCE の verifier の Cookie (Web) | `sb-<ref>-auth-token-code-verifier` の 1 つ | 従来の名前と `…-flow-<flow id>-code-verifier`・`…-flows-code-verifier` (同時に 5 flow まで)。コールバックは従来の名前を読む |
| 期限切れの token の `getClaims(token)` | `Error` を投げる | `{ data: null, error: AuthInvalidJwtError }` |
| 版の宣言 | ルート `ssr ^0.1.0`・`supabase-js ^2.78.0`、apps/mobile `^2.78.0` | ルート `ssr ^0.12.7`・`supabase-js ^2.117.3`、apps/mobile `^2.117.3` |

**③ 状態遷移表**

(a) auth-js 2.117 の借り物のセッション (1 つのクライアント。実際の refresh_token のふつうのブラウザで、サーバーが refresh_token を失効と答える (更新が 400 になる) ときも同じ遷移。S-9・S-28)

| 状態 | 事象 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| 有効 (残り ≥ 90 秒。tick は ≥ 120 秒で動かない) | tick (残り < 120 秒) / `getSession()` (残り < 90 秒) / 復帰 (残り < 90 秒) | 失効前・控え中 | `/token` が 400・保管の `expires_at*1000 > now` | 控え (60 秒)。`SIGNED_OUT` 無し |
| 失効前・控え中 | tick / `getSession()` / 復帰 | 失効前・控え中 | 控えが有効 | `/token` を呼ばない。`getSession()` は保管を返す |
| 失効前・控え中 | 控えが切れた後の契機 (まだ失効前) | 失効前・控え中 | `/token` が 400・まだ有効 | 控えを張り直す |
| 失効前・控え中 / 有効 | 時刻が E を過ぎる | 失効後・控え中 (控えが残っていれば) / 失効後・控え無し | — | 無し (保管はそのまま) |
| 失効後・控え中 | tick / `getSession()` / 復帰 | 失効後・控え中 | 控えが有効 | `getSession()` は `{ session: null, error }` (保管は残る)。見張りは `null` で送る |
| 失効後・控え無し | tick / `getSession()` / 復帰 | 捨てた | `/token` が 400・保管の `expires_at*1000 > now` が偽 (更新の途中でサーバーの応答が Cookie を消し、読み直した保管が空でも偽 `:4310-4316`) | `_removeSession` → `SIGNED_OUT` |
| 有効 / 失効前・控え中 | サーバーの応答が Cookie を消す | 保管なし | Next の `getUser()` が `403 session_not_found` (サーバーのセッションが消えた。両版で同じ。① の 403 の行) | 事象なし (`SIGNED_OUT` は出ない。ふつうのブラウザでは S-28 の失効の前) |
| 失効後・控え中 / 失効後・控え無し | サーバーの応答が Cookie を消す | 保管なし | middleware・Cookie を書ける route の server client が失効後の更新で 400 → `_removeSession` → `setAll` に `maxAge: 0`。ブラウザの auth-js はまだ自分の更新を始めていない | 事象なし (`SIGNED_OUT` は出ない。2.105 の前面では起きなかった順。S-27・S-28) |
| 保管なし | tick / `getSession()` / 復帰 | 保管なし | — | `{ session: null, error: null }`・事象なし (`:2532-2534`・`:4697-4699`・`:4118-4124`)。見張りは `null` で送る |
| 有効 / 失効前・控え中 (控えが切れた後) / 失効後・控え無し | tick / `getSession()` / 復帰 | その時間帯の控え中 (失効前・控え中 / 失効後・控え中) | `/token` が 5xx・接続の失敗 (`AuthRetryableFetchError`。約 25 秒やり直した後) | 捨てない (失効後でも)。控え (60 秒)。`SIGNED_OUT` 無し |
| 有効 (更新の閾値の内: tick は残り < 120 秒・`getSession()` と復帰は < 90 秒) / 失効前・控え中 (控えが切れた後) / 失効後・控え中 (控えが切れた後) / 失効後・控え無し | 控えが無いか切れた後の契機 (tick / `getSession()` / 復帰) | 有効 | `/token` が成功 (実際の refresh_token のときだけ。通信が戻った後など。借り物の値では起きない) | `_saveSession` → `TOKEN_REFRESHED` (`GoTrueClient.js:4273`・`:4287`)。控えを消す (`:4291`)。ふつうのブラウザの ① の「更新が成功」の行、ネイティブの S-19・T-19 の通信の回復の後の更新、T-23 の `TOKEN_REFRESHED`、(c) の最後の行がこの遷移 |
| 任意 | `setSession` (読み込み直し後の新しい Cookie) / 他タブの `SIGNED_IN` | 有効 | — | 控えを消す |
| 有効 / 失効前・控え中 | `signOut()` (scope `others` 以外) | 捨てた | — (`/logout` が失敗しても。2.105.3 は失敗なら元の状態のまま) | `SIGNED_OUT` |
| 有効 / 失効前・控え中 | `signOut({ scope: 'others' })` | 元の状態のまま | — (`/logout` (scope `others`) の成否に依らない) | 他の端末のセッションだけを取り消す。保管は残り `SIGNED_OUT` 無し (`scope !== 'others'` の分岐 `:3446`・`:3453` を通らない)。`/logout` が失敗なら `{ error }`、成功なら `{ error: null }` (両版で同じ。① の scope `others` の行) |
| 失効後・控え中 | `signOut()` (どの scope でも。セッションの読み込みで決まる) | 失効後・控え中 | 控えが有効 | `/logout` を呼ばずに `{ error }` (`:3433-3435`)。保管は残り `SIGNED_OUT` 無し |
| 失効後・控え無し | `signOut()` (どの scope でも。セッションの読み込みで決まる) | 捨てた | `/token` が 400 | 更新が `_removeSession` → `SIGNED_OUT`。`signOut()` は `{ error }` |
| 失効後・控え無し | `signOut()` (どの scope でも。セッションの読み込みで決まる) | 失効後・控え中 | `/token` が 5xx・接続の失敗 (約 25 秒やり直した後) | `{ error }`。保管は残り `SIGNED_OUT` 無し。控え (60 秒) |
| 保管なし | `signOut()` (scope `others` 以外) | 保管なし | 保管が空 (`__loadSession` が `{ session: null, error: null }`。`:2532-2534`) | GoTrue を呼ばず `_removeSession` (消すものは無い) → `SIGNED_OUT` → `{ error: null }` (`:3437-3438`・`:3453-3456`・`_removeSession` の通知 `:4438`。両版で同じ。§9.12 の「`_signOut` で保管にセッションが無い」の行) |
| 保管なし | `signOut({ scope: 'others' })` | 保管なし | 保管が空 | 何もせず `{ error: null }`。`SIGNED_OUT` 無し (両版で同じ) |

(b) `MainLayout` (コードは変えない。ガードに `isInNativeWebView()` とある行は WebView の中、`isInNativeWebView()` でないとある行はふつうのブラウザ。ガードが — の行は両方)

| 状態 | 事象 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| 監視中 | `SIGNED_OUT` (auth-js) | 再ブリッジ待ち | `isInNativeWebView()`・ログアウト通知済みでない | `notifyNativeSessionExpired()` を呼ぶ (`MainLayout.tsx:167`)。`MainLayout` 自身はログアウト通知済みかを見ず、送るかどうかは `native-auth-bridge` の中で決まる: ログアウト通知済み (`signOutNotified`) でなく、前の送信 (見張りの送信を含む) から `SESSION_EXPIRED_MIN_INTERVAL_MS` (15 秒) 以上たっていれば `session-expired` を送り、15 秒未満なら畳む (`src/lib/native-auth-bridge.ts:147-148`)。どちらでもタイマー 15 秒を張る (`MainLayout.tsx:170-172`) |
| 監視中 | `SIGNED_OUT` (auth-js) | 再ブリッジ待ち | `isInNativeWebView()`・ログアウト通知済み (`notifyNativeSignOut()` の後。S-7) | `session-expired` は送られない (`native-auth-bridge.ts:147`)。タイマー 15 秒は張られる (`MainLayout.tsx:170-172`)。`signOut()` のあとの `broadcastSignOut()` が下の `BroadcastChannel` の行で先に `/login` へ移し、ページごと入れ替わる (§6.3 の「利用者が意図したログアウト」の段落) |
| 再ブリッジ待ち | `SIGNED_OUT` (auth-js。2 回目) | 再ブリッジ待ち | `isInNativeWebView()`・タイマーが動いている (`rebridgeWaitTimer !== null`) | `notifyNativeSessionExpired()` は呼ぶ (送るかどうかは上の行と同じく `native-auth-bridge` の中。1 回目から 15 秒未満なら畳まれる)。タイマーは張り直さず、1 回目のタイマーのまま満了する (`MainLayout.tsx:170`) |
| 監視中 | `SIGNED_OUT` (auth-js) | ログアウト済み | `isInNativeWebView()` でない | localStorage を消し `/login` |
| 監視中 / 再ブリッジ待ち | `BroadcastChannel('auth')` の `SIGNED_OUT` | ログアウト済み | — | 同上 |
| 再ブリッジ待ち | `SIGNED_IN` / `INITIAL_SESSION` / `TOKEN_REFRESHED` (session あり) | 監視中 | — | タイマーを止める |
| 再ブリッジ待ち | タイマー満了 | ログアウト済み | — | localStorage を消し `/login` |
| 再ブリッジ待ち / 監視中 | unmount | 離脱 | — | 購読とタイマーを止める |
| 監視中 | (事象なし) サーバーの応答が Cookie を消した ((a) の「保管なし」) | 監視中 | `isInNativeWebView()` | 何もしない (`onAuthStateChange` は呼ばれない)。送るのは見張り (20 秒ごと)。待ちのタイマーも張らない (§6.3 の 5・S-27) |
| 監視中 | (事象なし) サーバーの応答が Cookie を消した ((a) の「保管なし」) | 監視中 | `isInNativeWebView()` でない | 何もしない (`onAuthStateChange` は呼ばれない。user-scoped の localStorage は残り、`/login` へも移らない。見張りは居ない)。次に画面を移ると middleware が `/login?next=…` へ回す (§6.3 の「ふつうのブラウザ」の段落・S-28・裁定 H2) |

(c) ネイティブの bridge (`getSessionForBridge`。WebView のタブを開くとき・`rebridge` のとき。ネイティブのセッションの状態ごと。残りの閾値は `BRIDGE_MIN_TOKEN_TTL_SEC` = 210 秒・`BRIDGE_SERVER_MIN_TOKEN_TTL_SEC` = 150 秒)

| ネイティブのセッションの状態 | 事象 | 遷移先 (WebView) | ガード | 副作用 |
|---|---|---|---|---|
| 有効 (残り ≥ 210 秒) | タブを開く | bridge で開く | — | `/token` を呼ばない (変わらない) |
| 有効 (残り < 210 秒)・控え無し | タブを開く | bridge で開く | 更新が成功 | `/token` 1 回 (`refreshSessionOnce`。変わらない) |
| 有効 (残り 150〜210 秒)・控え無し / 控え中 | タブを開く | bridge で開く (いまの token) | 更新が失敗 / 控えた失敗 | 2.117 は控えの間 `/token` を呼ばない |
| 有効 (残り < 150 秒)・控え無し | タブを開く | bridge で開く / 直接の URL | 更新が成功 / 失敗 | 変わらない (失敗なら 2.117 は控えを張る) |
| 有効 (残り < 150 秒)・控え中 | タブを開く | 直接の URL | 控えた失敗 (`webViewBridge.ts:579`) | 2.105 は `/token` を呼び直した (S-24) |
| 失効後・控え中 | タブを開く | 直接の URL | `getSession()` が控えた失敗で `null` (`:568`) | 2.105 は `/token` を呼び直した (S-23) |
| 失効後・控え無し | タブを開く | bridge で開く / 直接の URL | 更新が成功 / 失敗 (やり直せる失敗なら控えを張る。400 なら `_removeSession` → ネイティブの `SIGNED_OUT`) | 変わらない |
| 失効後・控え中 | WebView の `session-expired` | 変わらない (何もしない) | 控え (`getSession()`) が null | `no-session` (S-23) |
| 失効後・控え中 → 控えが切れた後の契機で更新が成功 | `TOKEN_REFRESHED` | 変わらない (WebView は自分では読み込み直さない) | — | 次のタブを開く・同じタブを押し直す・次の `session-expired` で bridge が通る |

(d) 規約の同意画面 (`apps/mobile/app/legal-consent.tsx`。コードは変えない。扱いは 13b の `legalConsentScreenModeOf`。Web からの `sign-out` でネイティブのサインアウトが終わったあとの `afterSignOut` の分かれ方)

| 状態 | 事象 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| 同意を待つ (`awaiting-consent`。サインイン中・required) | `signOutWithCleanup` の後の `afterSignOut` | ログアウトの後の案内 (`signed-out-notice`) | `SIGNED_OUT` で AuthProvider のセッションが `null`・`getSession()` が `null` (サインアウトの成功。2.117 では access token が有効なうちの通信の失敗も) | 入口へ移らず「閉じる」を出す。案内の間は取り除く操作を全部止める |
| 同意を待つ | 同上 | 同意を待つ (変わらない) | `SIGNED_OUT` が無く AuthProvider のセッションが残る・`getSession()` が `null` (access token が失効していて更新もできないときの失敗。両版で同じ。2.105.3 では有効なうちの失敗で残りが 90 秒未満のときも) | 何もしない (「閉じる」は出ない。Web も失敗して form に戻るので、通信が戻ってからもう一度押せる) |
| 同意を待つ | 同上 | 入口 → ゲートが同意画面 1 つに畳み直す | `getSession()` がセッションを返す (サインアウトの途中の例外など。2.105.3 では有効なうちの通信の失敗で残りが 90 秒以上のときも) | `close()` (ゲートが畳んだ同意画面では下に画面が無いので `router.replace('/')`)。ログイン中のまま |
| 同意を待つ | 同上 | 入口 | `getSession()` が投げる | `close()` |

2.117 で変わるのは (a) と (c) の控え中の行と、(a) の「失効後 → 保管なし」の行 (2.105 の前面では、ブラウザが先に捨てるので起きなかった)。(b) の「監視中 → 再ブリッジ待ち」の事象は、失効前に来なくなり、失効後 (≤ 90 秒) か `signOut()` (失効後・控え中の `signOut()` と scope `others` を除く。保管なしの `signOut()` でも来る) でだけ来る。失効後でも、ブラウザより先にサーバーの応答が Cookie を消すと来ず、(b) は監視中のまま (S-27)。ふつうのブラウザの「監視中 → ログアウト済み」(`SIGNED_OUT`) も同じで、サーバーの応答が先に Cookie を消すと来ず、監視中のまま (S-28。サーバーのセッションが消えたときの 403 の経路では両版で同じ)。(b) の「再ブリッジ待ち → タイマー満了」は、(c) の「失効後・控え中」の `session-expired` (何もしない) のあとでも起きる (S-23。待ちは `SIGNED_OUT` が届いたときだけ)。(d) は、access token が有効なうちのサインアウトの通信の失敗が 1 行目 (案内) に入るようになった (2.105.3 は残りが 90 秒以上なら 3 行目、未満なら 2 行目)。2 行目の失効していて更新もできない枝は両版で同じ (S-29)。

### 9.7 Cookie の読み書き (ssr 0.12) への移行

呼び出し口の母集合 (§9.1 の表の ①〜⑤) のうち変えるのは ①・②・③・⑤。④ `proxy.ts` (`updateSession` を呼ぶだけ) は変えない。`lib/legal-consent-minor.ts:13` の型 (`ReturnType<typeof createServerClient>`) は 0.12.7 でも同じ名前の関数の戻り値 (`SupabaseClient`) なので変えない。

`cookieEncoding` は 3 つの呼び出し口 (①・②・③) とテストの ⑤ で、新設の定数 `SUPABASE_COOKIE_ENCODING` (= `'raw'`) を渡す (裁定 D)。書く値は 0.1.0 と同じ JSON で、読みは 0.12.7 が JSON と `base64-` の両方を読む。`cookieOptions` は指定しない (既定 `path: '/'`・`sameSite: 'lax'`・`httpOnly: false`・400 日。native-bridge の `clearSupabaseAuthCookies` が `path: '/'` で消すのと一致)。

**新設 `lib/supabase/cookie-encoding.ts`** (import を持たない。ブラウザのバンドルに入る `client.ts` からも読むので、env や zod を引き込まない)

```ts
/**
 * @supabase/ssr が認証の Cookie に書く値の書式 (#1768。docs/design/mobile/05-auth-session.md §9.5 の裁定 D)。
 *
 * 'raw' = auth-js が渡す JSON をそのまま書く (@supabase/ssr 0.1.0 と同じ値)。0.12 の既定の 'base64url' (値に base64- を付ける) にしない。
 * デプロイの前に開いたタブの JS (ssr 0.1.0 + auth-js 2.105.3) と、Vercel を旧版に戻したときの旧サーバーは base64- の値を読めず、
 * セッションを消して SIGNED_OUT を出す (Cookie はブラウザで共有なので、そのブラウザの全タブが切れる)。
 * 0.12 は書式の設定に依らず JSON と base64- の両方を読むので、'base64url' への切り替えは別の Issue で、0.1.0 の JS が残らないと見なせてから行う。
 * createServerClient / createBrowserClient を呼ぶ 3 ファイル (lib/supabase/client.ts・server.ts・middleware.ts) は必ずこの定数を渡す
 * (tests/supabase-cookie-encoding-callers.test.ts が見張る)。
 */
export const SUPABASE_COOKIE_ENCODING = 'raw' as const
```

**① `lib/supabase/middleware.ts:147-184` を次に置き換え、`:1` の import の次の行に `import { SUPABASE_COOKIE_ENCODING } from '@/lib/supabase/cookie-encoding'` を足す** (ほかの行は変えない。`request.cookies` と `supabaseResponse.cookies` の両方に書く 2 か所の形を保つ。裁定 E)。

```ts
// tsc:skip  (@supabase/ssr 0.12.7 の型 CookieMethodsServer (getAll / setAll) を使う。依存を上げる前の木では型検査を通らないので、実装者は同じ PR で `npx tsc --noEmit` を通す)
  const supabase = createServerClient(
    supabaseConfig.url,
    supabaseConfig.anonKey,
    {
      global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
      cookieEncoding: SUPABASE_COOKIE_ENCODING,
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          // リクエストとレスポンスの両方に書く (#1768 より前の set / remove と同じ 2 か所。同じレスポンスのインスタンスに蓄積する)。
          // 消すときは value が '' で options.maxAge が 0 (ssr が作る)。request 側は name と value だけ
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
          for (const { name, value, options } of cookiesToSet) supabaseResponse.cookies.set({ name, value, ...options })
          // Cookie を書いた応答を共有キャッシュに置かせないヘッダー (ssr が渡す。同じクライアントでは最初の書き込みのときだけ中身がある)。
          // 画面の応答は下で Cache-Control を上書きする (private, no-store のまま)
          for (const [headerName, headerValue] of Object.entries(headers)) supabaseResponse.headers.set(headerName, headerValue)
        },
      },
    }
  )
```

- `request.cookies.getAll()` は `{ name, value }[]` (Next の `RequestCookies`) で `GetAllCookies` に合う。`request.cookies.set(name, value)` は既存の `set` の形と同じ。
- `supabaseResponse.cookies.set({ name, value, ...options })` は現行の `set` / `remove` (`:158-168`・`:171-181`) と同じ書き方 (`CookieOptions` = `Partial<SerializeOptions>` の展開は 0.1.0 でも同じ型で通っていた)。現行の `options: any` (`:156`・`:170`) は無くなる (`setAll` の引数は ssr の型で決まる)。
- 置き換える応答 (`maintenanceApiResponse` / 同意の 403 / リダイレクト) は `withSessionCookies` (`:39-44`) と同意のリダイレクトの `for` (`:430`) で Cookie だけを引き継ぐ。`headers` は引き継がない (それらは `Cache-Control: private, no-store` を自分で付けるか、リダイレクトで本文が無い)。
- `fetchMiddlewareProfile` の引数の型 (`:67`) は変えない。

**② `lib/supabase/server.ts:1`・`:32-66` を次に置き換える** (`getSupabaseAdmin` は変えない)。

```ts
// tsc:skip  (同上。@supabase/ssr 0.12.7 の型が要る)
import { createServerClient } from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'
import { getSupabaseAnonKey, getSupabaseServiceRoleKey, getSupabaseUrl } from '@/lib/env-required'
import { SUPABASE_COOKIE_ENCODING } from '@/lib/supabase/cookie-encoding'

export async function createClient(cookieStore?: Awaited<ReturnType<typeof cookies>>) {
  const store = cookieStore ?? (await cookies())
  const authHeader = (await headers()).get('authorization')

  return createServerClient(
    getSupabaseUrl(),
    getSupabaseAnonKey(),
    {
      global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
      cookieEncoding: SUPABASE_COOKIE_ENCODING,
      cookies: {
        getAll() {
          return store.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) store.set({ name, value, ...options })
          } catch {
            // Server Component から呼ばれたとき (応答の Cookie に書けない)。
            // middleware (lib/supabase/middleware.ts) が同じ更新を応答に書くので無視してよい (#1768 より前の set / remove と同じ扱い)
          }
        },
      },
    }
  )
}
```

- `type CookieOptions` の import は使わなくなるので外す (`tests/supabase-service-role-client-scan.test.ts` は `createServerClient` の import を見るだけで、`CookieOptions` には反応しない)。
- `setAll` の第 2 引数 (`headers`) は受け取らない。`cookies()` の API からは応答のヘッダーに触れない。route handler の応答は各 route が作る (native-bridge は `Cache-Control: no-store` を自分で付ける `route.ts:76-80`)。

**③ `lib/supabase/client.ts` を次に置き換える** (書式を明示するだけで、書く値は今と同じ JSON。options に `cookies` を渡さないので、0.12.7 は `document.cookie` を読み書きする `cookies.js:165-169`。`isSingleton` は既定のまま)。

```ts
// tsc:skip  (@supabase/ssr 0.12.7 の型 (cookieEncoding) が要る)
import { createBrowserClient } from '@supabase/ssr'
// ブラウザのバンドルに入るので、zod を持つ @/lib/env ではなく何も import しない env-required を使う (#1182)
import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env-required'
import { SUPABASE_COOKIE_ENCODING } from '@/lib/supabase/cookie-encoding'

export function createClient() {
  // 未設定なら MissingEnvError になる (`process.env.X!` では undefined のまま渡って分かりにくいエラーになっていた)。
  // 欠けている変数名は envName にあり、message には入らない (どれが欠けているかは `npm run check:env` で分かる)
  return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey(), { cookieEncoding: SUPABASE_COOKIE_ENCODING })
}
```

**⑤ `src/__tests__/helpers/real-auth-js.ts:65-72`** は `cookies: {}` と 0.1.0 の注記を外し、`isSingleton: false`・`cookieEncoding: SUPABASE_COOKIE_ENCODING` (製品の `client.ts` と同じ) と `global.fetch` にする (0.12.7 は `cookies` を省くと `document.cookie` を使う `cookies.js:165-169`。型も `cookies?`)。`seedBorrowedSession` (`:75-93`) は**変えない**: JSON のまま書く Cookie は「0.1.0 が書いた形」そのもので、0.12.7 がそれを読むことの検査になる (§9.8)。`'borrowed-access-token'` (`:77`) は `export const BORROWED_ACCESS_TOKEN` に出し、§9.9 のテストが「同じ access token が残る」を見る。同じファイルに、§9.9 の A と B が共に使う `ALREADY_EXPIRED_REMAINING_SECONDS` と `SIGNED_OUT_AFTER_EXPIRY_MAX_MS` も export する (§9.11。auth-js の定数は `@supabase/auth-js/dist/main/lib/constants` から import する)。

**結合テスト・e2e の Cookie の読み書きは変えない**: サーバーが書く Cookie は JSON (`raw`) のままなので、`tests/integration/security/native-bridge-flow.test.ts:173-188` の `readSession`・`tests/integration/security/operator-mfa.test.ts:163-180` の `sessionFromSetCookie`・`tests/e2e/fixtures/auth.ts:140-166` の Cookie の確認 (`decodeURIComponent` → `JSON.parse`) はそのまま通る。JSON の Cookie を**書く**側 (`operator-mfa.test.ts:155`・`tests/e2e/fixtures/auth.ts:232-239`・`tests/e2e/fixtures/fresh-user.ts:261-273`・`tests/e2e/global-setup.ts:188-193`・`tests/e2e/membership/02-org-invite-new-user.spec.ts:112-125`・`:219`。`tests/e2e/helpers/test-session.mjs:104` はその形の型の説明) も変えない (0.12 は JSON をそのまま読む。§9.8 の「0.1.0 の Cookie を 0.12 のサーバーが読む」の検査を兼ねる)。`operator-mfa.test.ts:139` のコメント「@supabase/ssr (0.1.0) の Cookie の名前」だけは、版を書かない文 (「@supabase/ssr の Cookie の名前」) にする (段 4)。`base64-` の値を読むテストの道具は、`base64url` へ切り替える Issue (§9.17 Q-7) で作る。

### 9.8 すでにログインしている利用者のセッションが切れないことの確かめ方

書く書式は 1 つ (JSON。`raw` で 0.1.0 と同じ値)、読める書式は 2 つ (JSON と、`base64url` で書かれた `base64-`) で、0.12 の読み手は `decodeChunkedCookieValue` (`cookies.js:45-65`) の 1 か所。読み手には 0.1.0 + auth-js 2.105.3 (デプロイの前に開いたタブ・旧版に戻したサーバー) も居て、こちらは JSON しか読めない (§9.6 ①-2)。確かめ方は 3 段。

1. **単体 (新設 `src/__tests__/lib/supabase-ssr-cookie-compat.test.ts`。本物の `@supabase/ssr` 0.12.7 と本物の auth-js。製品と同じ `cookieEncoding: SUPABASE_COOKIE_ENCODING`)**: `createServerClient` に `getAll` / `setAll` の小さな保管 (Map) を渡し、(a) JSON の Cookie 1 つ (b) JSON を 2 つに分割 (`.0` / `.1`) (c) `base64-` の値、のそれぞれで `getSession()` が同じ `access_token` を返すこと、`getUser()` が偽の fetch (`createFakeSupabaseFetch`) で `user-1` を返すこと。(d) (b) の保管で `setSession` を呼ぶと、`setAll` が受け取るセッションの Cookie の値が `base64-` で始まらず、番号順につないで `decodeURIComponent` → `JSON.parse` できる (= ssr 0.1.0 の `combineChunks` と auth-js 2.105.3 の `getItemAsync` が読む形。旧バンドル・旧サーバーが読める)、かつ新しいセッションが 1 つの Cookie に収まるときは (b) の古い `.0` / `.1` が `maxAge: 0` で同じ呼び出しに入ること。(e) `createBrowserClient` (`cookieEncoding` だけを渡す・jsdom) が `document.cookie` の JSON を読み、更新のあと `document.cookie` に JSON のまま書くこと (= `seedBorrowedSession` の形。`main-layout-signed-out` の全 it がこの経路を通る)。it の名前は §9.9 E。3 つの呼び出し口が同じ定数を渡すことは §9.9 F (走査) が見る。
2. **結合 (ローカル Supabase。既存・変えない)**: `tests/integration/security/native-bridge-flow.test.ts` (ブリッジの `setSession` → `Set-Cookie` → 同じ Cookie で middleware を通す) と `operator-mfa.test.ts` (JSON の Cookie で route を呼び、`Set-Cookie` の新しい値を読む) が、既存の `JSON.parse` の読み取りのまま緑であること (サーバーが JSON で書いていることの結合の検査を兼ねる)。`operator-mfa.test.ts:155` は JSON の Cookie を**送る**ので、「0.1.0 の Cookie を 0.12 のサーバーが読む」の結合の検査そのもの。
3. **本番 (整合ゲート)**: デプロイの前からログインしているブラウザ (オーケストレーターの自分の利用者) で、(a) デプロイの前にタブ A を開いておき、デプロイ後に別のタブ B で `/home` を開いて、ログイン画面に落ちない (b) 1 時間以内 (access token の更新の後) に DevTools の Application → Cookies で `sb-<ref>-auth-token` の値が `base64-` で始まらず、URL エンコードした JSON (`%7B` で始まる) のままである (c) タブ B で更新が走った後に、タブ A (旧バンドル) を前面に戻して操作しても、ログイン画面に落ちず Cookie も消えない (S-25) (d) Vercel のランタイムログに `@supabase/ssr: could not base64url-decode` / `chunked cookie decoded to invalid JSON` の warn が出ていない、を確かめる。アプリは、更新前のビルド (2.105) の WebView でブリッジ → ホームが開くこと (S-13・S-18)。

### 9.9 テストの直し方 (it の一覧)

期待値は緩めず、2.117 の挙動を名指しする assert に書き直す。数値は auth-js の定数から導く (`import { AUTO_REFRESH_TICK_DURATION_MS, REFRESH_FAILURE_COOLDOWN_MS } from '@supabase/auth-js/dist/main/lib/constants'`。2.105.3 には `REFRESH_FAILURE_COOLDOWN_MS` が無いので、この import は依存を上げた後でだけ通る)。

**A. `src/__tests__/app/main-layout-signed-out.test.tsx`** (ヘッダーのコメント `:2-13` も 2.117 の文に直す)

このファイルの it は 9 件 (`it.each` の 2 行を 2 件と数える)。直した後は同じ数え方で 12 件 = A-1 (2) + A-2〜A-4 (3) + A-5〜A-7 (3) + A-8 (2。いまの 1 件を `it.each` の 2 行にする) + A-9 (2。新設の `it.each` の 2 行)。2.117.3 で赤になるのは次の 6 件で、残る 3 件 (`:278`・`:291`・`:337`) は残り 3,000 秒の種で更新が走らないので緑のまま (A-5〜A-7)。

| 現行の it (origin/main の行) | 種 | 2.117.3 で赤になる assert | 赤になる理由 | 直した後 |
|---|---|---|---|---|
| `it.each([100, 60])` の 100 (`:200-218`) | `seedBorrowedSession(100)` | `:212` `expect(data.session).toBeNull()`・`:214` `expect(sentTypes()).toEqual(['session-expired'])` | tick の先回りの更新が 400 でも、access token が有効なのでセッションが残り (`GoTrueClient.js:4310-4314`)、`SIGNED_OUT` が出ない → `getSession()` は保管を返し、`MainLayout` は何も送らない | A-1 (100) |
| `it.each([100, 60])` の 60 (`:200-218`) | `seedBorrowedSession(60)` | 同上 (`:212`・`:214`) | 同上 (`getSession()` の更新の失敗も、`__loadSession` が保管を返す `:2563-2572`) | A-1 (60) |
| 待ち時間を過ぎたら /login (`:220-236`) | `seedBorrowedSession(60)` | `:226` `expect(sentTypes()).toEqual(['session-expired'])` (以降の `/login` への遷移も起きない) | 同上。`SIGNED_OUT` が来ないので待ちも始まらない | A-2 (種を失効済みに) |
| 待ちの途中で離脱 (`:238-255`) | `seedBorrowedSession(60)` | `:244` `expect(sentTypes()).toEqual(['session-expired'])` | 同上 | A-3 (種を失効済みに) |
| 待っている間にセッションが戻る (`:257-276`) | `seedBorrowedSession(60)` | `:263` `expect(sentTypes()).toEqual(['session-expired'])` | 同上 | A-4 (種を失効済みに) |
| ふつうのブラウザ (`:361-372`) | `seedBorrowedSession(60)` | `:369` `expect(hrefSetter).toHaveBeenCalledWith('/login')`・`:370` `expect(remainingKeys()).toEqual([])` | 同上。`SIGNED_OUT` が来ないので `treatAsSignedOut` が走らない | A-8 (2 行: 残り 60 秒 = 残る / 失効済み = 現行の assert) |

| # | it (新しい名前) | 中身 |
|---|---|---|
| A-1 | `it.each([100, 60])` 「借り物のセッション (残り %i 秒) の先回りの更新に auth-js が失敗しても、access token が有効な間はセッションを捨てず、何も送らず、user-scoped のキーも残る。失効して SIGNED_OUT が出たら、ログアウト扱いにせず session-expired を送る」 | (1) `seedBorrowedSession(remaining)` → mount → `advance(1_000)`: `refreshRequests(fakeFetch).length >= 1`・`getSession().data.session?.access_token === BORROWED_ACCESS_TOKEN`・`sentTypes()` が `[]`・`remainingKeys()` が全部・`hrefSetter` 未呼び出し。(2) `advance(remaining * 1000 - 1_000 - 1)` (= 失効 E の 1 ms 前): `sentTypes()` が `[]`・`remainingKeys()` が全部・`hrefSetter` 未呼び出し。(3) 失効の後は `SIGNED_OUT_POLL_STEP_MS` ずつ進め、`sentTypes()` が空でなくなった時点で止める: `for (let waited = 0; sentTypes().length === 0 && waited <= SIGNED_OUT_AFTER_EXPIRY_MAX_MS; waited += SIGNED_OUT_POLL_STEP_MS) await advance(SIGNED_OUT_POLL_STEP_MS)`。(4) 止めた時点で: `sentTypes()` が `['session-expired']`・`getSession().data.session` が `null`・`remainingKeys()` が全部・`hrefSetter` 未呼び出し。(3) の前に `expect(SIGNED_OUT_POLL_STEP_MS).toBeLessThan(NATIVE_REBRIDGE_WAIT_MS)` (前提) |
| A-2 | 「ネイティブが読み込み直してくれないまま待ち時間を過ぎたら (古いアプリ・再ブリッジが止められたとき)、従来どおりログアウトとして /login へ移し、user-scoped のキーを消す」 | `seedBorrowedSession(ALREADY_EXPIRED_REMAINING_SECONDS)` (= -1。1 時間以上バックグラウンドに置いて戻った状態) → mount → `advance(1_000)`: `sentTypes()` が `['session-expired']`。以降は現行と同じ (`NATIVE_REBRIDGE_WAIT_MS - 1_000 - 1` で未遷移・`+1` で `/login` とキー削除) |
| A-3 | 「待ち時間の途中でこのレイアウトから離れた…」 | 種を失効済みにするだけ。中身は現行 |
| A-4 | 「待っている間にセッションが戻ったとき…」 | 同上 |
| A-5〜A-7 | 設定画面にログアウトが出ない / WebView の中のログアウト / 安全網 | 変えない (残り 3,000 秒。更新は走らない) |
| A-8 | ふつうのブラウザ: `it.each` で 2 行 — 「[残り 60 秒] 先回りの更新に失敗してもセッションは残り、/login へ移らず、キーも消えない」/「[失効済み] すぐに user-scoped のキーを消して /login へ移る。ネイティブへは何も送らない」 | 前者: `advance(1_000)` 後に `refreshRequests ≥ 1`・`getSession()` が同じ access token・`hrefSetter` 未呼び出し・キー全部。後者: 現行の assert |
| A-9 | `it.each` で 2 行 (`[{ environment: 'WebView', inNativeWebView: true }, { environment: 'ふつうのブラウザ', inNativeWebView: false }]`。名前の `$environment` に入れる) — 「[$environment] access token が失効した後、auth-js が自分で捨てる前にサーバーの応答が Cookie を消すと (middleware の失効後の更新の失敗)、SIGNED_OUT は出ず、MainLayout は session-expired を送らず、待ち時間を過ぎても /login へ移らず、user-scoped のキーも残る」 (新設。WebView = S-27・裁定 H、ふつうのブラウザ = S-28・裁定 H2) | 置き場所はファイルの末尾に足す新しい `describe('MainLayout — auth-js が捨てる前にサーバーの応答が Cookie を消したとき (#1768)')` (WebView とふつうのブラウザの 2 行を 1 か所に持つ。`beforeEach` が `ReactNativeWebView` を消すので、既定はふつうのブラウザ)。`inNativeWebView` なら `enterNativeWebView()` → `seedBorrowedSession(SERVER_CLEARS_FIRST_REMAINING_SECONDS)` → `let signedOutCount = 0` と `supabaseClient.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') signedOutCount += 1 })` (auth-js の事象を直に数える) → `mountLayout()` → `advance(1_000)` → `advance(SERVER_CLEARS_FIRST_REMAINING_SECONDS * 1000 - 1_000 + 1)` (= 失効 E の 1 ms 後)。前提: `signedOutCount` が 0・`sentTypes()` が `[]`・`hrefSetter` 未呼び出し・`remainingKeys()` が全部 (ブラウザはまだ捨てていない。WebView なら `SIGNED_OUT` で `session-expired` が送られ、ふつうのブラウザなら `SIGNED_OUT` ですぐ `/login` へ移ってキーが消えるので、どちらの行でも崩れたら、種の残りと控えの関係 (下の説明) が変わったので種を選び直す)。続けて `` document.cookie = `${STORAGE_KEY}=; Max-Age=0; path=/` `` (サーバーの応答の `Set-Cookie` の `maxAge: 0` と同じ削除。`STORAGE_KEY` は `real-auth-js.ts` から import) → `const before = refreshRequests(fakeFetch).length` → `advance(SIGNED_OUT_AFTER_EXPIRY_MAX_MS + NATIVE_REBRIDGE_WAIT_MS)`: `signedOutCount` が 0・`sentTypes()` が `[]`・`hrefSetter` 未呼び出し・`remainingKeys()` が全部・`refreshRequests(fakeFetch).length` が `before` のまま (保管が空なので `/token` を呼ばない)・`supabaseClient.auth.getSession()` が `data.session === null` かつ `error === null`。ふつうのブラウザの行は、ブラウザが自分で捨てたなら `SIGNED_OUT` ですぐ `/login` へ移る (A-8 の失効済みの行) ので、`hrefSetter` 未呼び出しとキーが全部残ることが、裁定 H2 で受け入れた帰結の固定になる |

A-1 の (3) を 1 歩ずつ進める理由: `MainLayout` は `SIGNED_OUT` を受けると `NATIVE_REBRIDGE_WAIT_MS` (15 秒) の待ちを張り (`MainLayout.tsx:167-172`)、待ちを止めるのはセッションありの事象だけ (`:148`) なので、失効の後を一度に `SIGNED_OUT_AFTER_EXPIRY_MAX_MS` (90 秒) 進めると、待ちが満了して `/login` へ移りキーも消える (A-2 の挙動。§9.6 ③ (b) の「タイマー満了」)。§9.4 のトレースでは、`SIGNED_OUT` は残り 60 秒の種で E ちょうどの tick (表示直後 (E - 60) の失敗の控えが E で切れる)、残り 100 秒の種で E + 20 秒の tick (E - 100 の失敗 → 控え E - 40 → E - 40 で実際に 1 回 → 控え E + 20 → E + 20 で失効後なので `_removeSession`) に出る。どちらも `SIGNED_OUT_AFTER_EXPIRY_MAX_MS` 以内で、1 歩 (1 秒) で止めれば `SIGNED_OUT` からの経過は 1 秒以内、15 秒の待ちはまだ満了しない。到達の時刻はトレースの説明で、it は時刻を直書きせず「上限以内に届く・届いた時点では待ち中」を見る。

A-9 の種を残り 100 秒 (`SERVER_CLEARS_FIRST_REMAINING_SECONDS`。2 行とも同じ。auth-js の動きは WebView かどうかに依らない) にする理由: 上のトレースのとおり、残り 100 秒の種は E - 40 の失敗の控えが E + 20 まで効き、ブラウザが捨てるのは E + 20 の tick。E の 1 ms 後はブラウザがまだ捨てておらず、サーバーが先に Cookie を消す順 (WebView は S-27・T-27、ふつうのブラウザは S-28・T-28) を作れる。残り 60 秒の種は E ちょうどの tick で捨てるので使えない。この順を作れていることは、it の中の前提の assert (`signedOutCount` が 0。WebView の行は `sentTypes()` が `[]`、ふつうのブラウザの行は `hrefSetter` 未呼び出しとキーが全部残ること、も同じ意味) が確かめる。削除のあとに進める時間 (`SIGNED_OUT_AFTER_EXPIRY_MAX_MS + NATIVE_REBRIDGE_WAIT_MS`) は、ブラウザが自分で捨てたなら `SIGNED_OUT` が出て、WebView では待ちが満了し、ふつうのブラウザではすぐ `/login` へ移る時間で、この it はその間に何も起きないことを見る。

`console.error` の 'Invalid Refresh Token' の黙らせ (`:159-161`) は 2.117 では出なくなるが、残してよい。

**B. `src/__tests__/lib/native-session-authjs-thresholds.test.ts`** (既存の it は変えない。新しい `describe('auth-js 2.117 の更新の失敗の扱い (借り物のセッション)')` を足す)

| # | it | 中身 |
|---|---|---|
| B-1 | 「失敗の控えは 60 秒 (REFRESH_FAILURE_COOLDOWN_MS = 2 tick)」 | `REFRESH_FAILURE_COOLDOWN_MS === 2 * AUTO_REFRESH_TICK_DURATION_MS` かつ `=== 60_000` |
| B-2 | 「先回りの更新 (残り 100 秒の tick) が失敗しても、セッションは残り (getSession が同じ access_token を返す)、SIGNED_OUT は出ない」 | `onAuthStateChange` で `SIGNED_OUT` を数える → `startClientWithSession(100)` → `refreshRequests` が 1・`getSession()` の `access_token` が `BORROWED_ACCESS_TOKEN`・`SIGNED_OUT` 0 回 |
| B-3 | 「同じ refresh_token での更新の失敗は 60 秒控える: 控えの間の getSession() は /token を呼ばず、控えが切れた最初の契機で 1 回だけ呼び、また控える」 | タイマーを進めずに残り 89 秒で作る (既存の `getSession()` の it と同じ形。初期化の復帰処理が 1 回更新を試みる) → `getSession()` → `/token` の回数を n とする (n ≥ 1) → 続けて `getSession()` を 3 回 → n のまま (控え) → `vi.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS)` (この間の tick は残り 59 秒 → 控え、60 秒の境で控えが切れて実際に 1 回) → n + 1 → `getSession()` → n + 1 のまま (控えを張り直した)。`getSession()` はどの時点でも同じ access token を返す (残り 29 秒でも失効前) |
| B-4 | 「access token が失効したあとの更新の失敗で、セッションを捨てて SIGNED_OUT を出す (失効から最大 90 秒)」 | `it.each([100, 60])` (A-1 と同じ 2 行: tick だけが更新を試みる残りと、`getSession()` も試みる残り) → `startClientWithSession(remaining)` → `vi.advanceTimersByTimeAsync(remaining * 1000 + SIGNED_OUT_AFTER_EXPIRY_MAX_MS)` → `SIGNED_OUT` 1 回・`getSession()` が `null`・`/token` の回数 ≥ 2 (失効前の 1 回以上と失効後の 1 回) |
| B-5 | 「/token がやり直せる失敗 (503) のときは、access token が失効していてもセッションを捨てず (Cookie は残る)、失敗を 60 秒控える: 控えの間の getSession() は /token を呼ばずに AuthRetryableFetchError を返し、控えが切れたあとの契機で 1 回呼ぶ」 | このファイルに `createTransientRefreshFailureFetch()` を置く: `createFakeSupabaseFetch()` と同じ型の `vi.fn`。`/auth/v1/token?grant_type=refresh_token` には本文 `upstream error` (JSON でない)・status `TRANSIENT_GATEWAY_STATUS` (= 503。auth-js が `AuthRetryableFetchError` にする 5xx) を返し、ほかは `createFakeSupabaseFetch()` に任せる。手順: `seedBorrowedSession(ALREADY_EXPIRED_REMAINING_SECONDS)` → `client = createRealBrowserClient(transientFetch)` → `const pending = client.auth.getSession()` → `vi.advanceTimersByTimeAsync(AUTO_REFRESH_TICK_DURATION_MS)` (初期化のやり直しを流しきる) → `await pending` が `data.session === null`・`error?.name === 'AuthRetryableFetchError'` → `/token` の回数を n とする (n ≥ 1) → `document.cookie` に `STORAGE_KEY` が残る (捨てていない) → `getSession()` を 3 回 → どれも同じ `error.name`・`/token` は n のまま → `vi.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS + AUTO_REFRESH_TICK_DURATION_MS)` (控えが切れた後の tick で実際に呼び、そのやり直しも流しきる) → `/token` が n より多い → `document.cookie` に `STORAGE_KEY` が残る・`SIGNED_OUT` 0 回 (`onAuthStateChange` で数える) |
| B-6 | `it.each` で 2 行 — 「[access token が有効] signOut() の /logout が 503 でも、保管を消して SIGNED_OUT を出し { error } を返す」/「[失効済みで /token も 503] signOut() は /logout を呼ばずに { error } を返し、保管は残り SIGNED_OUT も出ない」 | このファイルに `createTransientSignOutFailureFetch()` を置く: `createFakeSupabaseFetch()` と同じ型の `vi.fn`。`/auth/v1/logout` と `/auth/v1/token?grant_type=refresh_token` には本文 `upstream error` (JSON でない)・status `TRANSIENT_GATEWAY_STATUS` を返し、ほかは `createFakeSupabaseFetch()` に任せる。表の入力は `{ remaining, logoutCalls, cookieKept, signedOutCount }` = `{ LONG_REMAINING_SECONDS, 1, false, 1 }` と `{ ALREADY_EXPIRED_REMAINING_SECONDS, 0, true, 0 }`。手順: `seedBorrowedSession(remaining)` → `client = createRealBrowserClient(fetch)` → `onAuthStateChange` で `SIGNED_OUT` を数える → `const pending = client.auth.signOut()` → `vi.advanceTimersByTimeAsync(AUTO_REFRESH_TICK_DURATION_MS)` (失効済みの行で、初期化の更新のやり直しを流しきる) → `const { error } = await pending` が `error?.name === 'AuthRetryableFetchError'`・`error?.status === TRANSIENT_GATEWAY_STATUS` → `/auth/v1/logout` を呼んだ回数が `logoutCalls`・`document.cookie` に `STORAGE_KEY` があるかが `cookieKept`・`SIGNED_OUT` の回数が `signedOutCount`。有効の行は `refreshRequests` が 0 (更新は走らない。前提として `expect(LONG_REMAINING_SECONDS).toBeGreaterThan(TICK_REFRESHES_BELOW_SECONDS)`。`TICK_REFRESHES_BELOW_SECONDS` はこのファイルの既存の定数 `:29`)。続く `getSession()` が、有効の行は `data.session === null`・`error === null` (保管が空) を、失効済みの行は `data.session === null`・`error?.name === 'AuthRetryableFetchError'` (控えた失敗) を返すことも見る (どちらも、規約の同意画面の `afterSignOut` が入口へ移らない入力。S-29)。前の行は 2.117 の変化 (§9.1 の `_signOut` の失敗の ②。2.105.3 では保管が残り赤)、後の行は両版で同じ挙動 (同 ①) で、`signOutOrForgetLocally` の端末での消去が要る理由 (S-22) を本物の auth-js で固定する |
| B-7 | `it.each` で 4 行 — 「[失効済みで /token が 400] signOut() は更新が捨てて SIGNED_OUT を出し、/logout を呼ばずに { error } を返す」/「[保管なし] signOut() は GoTrue を呼ばずに SIGNED_OUT を出し { error: null } を返す」/「[access token が有効・scope others] signOut({ scope: 'others' }) は /logout (scope=others) を呼び、保管を残し SIGNED_OUT を出さず { error: null } を返す」/「[保管なし・scope others] 何もせず { error: null }・SIGNED_OUT 無し」 (表①の `signOut()` の 400 の行・保管が空の行・scope `others` の行、③ (a) の「失効後・控え無し × `signOut()` × 400」「保管なし × `signOut()`」「有効 × scope `others`」「保管なし × scope `others`」の 4 行。§9.12 の「`_signOut` で保管にセッションが無い」の行) | このファイルに `createSignOutSuccessFetch()` を置く: `createFakeSupabaseFetch()` と同じ型の `vi.fn`。`/auth/v1/logout` には本文の無い 204 を返し、ほかは `createFakeSupabaseFetch()` に任せる (`/token` は 400 `refresh_token_not_found`)。表の入力は `{ seed, expireBeforeSignOut, scope, logoutCalls, refreshCalls, cookieKept, signedOutCount, errorName }` = `{ LONG_REMAINING_SECONDS, true, 'local', 0, 1, false, 1, 'AuthApiError' }`・`{ null, false, 'local', 0, 0, false, 1, null }`・`{ LONG_REMAINING_SECONDS, false, 'others', 1, 0, true, 0, null }`・`{ null, false, 'others', 0, 0, false, 0, null }` (`seed` が `null` の行は `seedBorrowedSession` を呼ばない)。手順: `seed` があれば `seedBorrowedSession(seed)` → `const fakeFetch = createSignOutSuccessFetch()` → `client = createRealBrowserClient(fakeFetch)` → `onAuthStateChange` で `SIGNED_OUT` を数える → `vi.advanceTimersByTimeAsync(1_000)` (初期化を済ませる。既存の it の `advance(1_000)` と同じ) → `expireBeforeSignOut` の行だけ、`await client.auth.stopAutoRefresh()` (tick を止め、`signOut()` 自身の更新だけが `/token` を呼ぶようにする) のあと `vi.setSystemTime(Date.now() + LONG_REMAINING_SECONDS * 1000)` (タイマーは進めず、時計だけを失効の後へ動かす。失効済みの種で作ると初期化の更新 (`_recoverAndRefresh`) が先に 400 で捨ててしまい、`signOut()` が保管なしの行になるため) → `const before = refreshRequests(fakeFetch).length` → `const { error } = await client.auth.signOut({ scope })`。見るもの: `error?.name ?? null` が `errorName`・`/auth/v1/logout` の回数が `logoutCalls` (scope `others` の行は URL に `scope=others`)・`refreshRequests(fakeFetch).length - before` が `refreshCalls`・`document.cookie` に `STORAGE_KEY` があるかが `cookieKept`・`signOut()` の前後で増えた `SIGNED_OUT` の回数が `signedOutCount`。1 行目は 2.105.3 では保管が無い (失効の前に捨てている) ので `{ error: null }` だった行で、2.117 で起きるようになった枝 (T-7)。ほかの 3 行は両版で同じ |
| B-8 | 「期限切れの token を getClaims(token) に渡すと、投げずに { data: null, error: AuthInvalidJwtError } を返し、/user を呼ばない」 (表①の `getClaims` の行・§9.12・閉包 W-9・W-10。2.105.3 は `Error` を投げた) | `createRealBrowserClient(fakeFetch)` の `auth.getClaims(fakeJwt(Math.floor(Date.now() / 1000) + ALREADY_EXPIRED_REMAINING_SECONDS))` (`fakeJwt` は `real-auth-js.ts` の既存の関数。秒への換算は既存の `:29`・`:31` と同じ。`alg` が `HS256` なので、署名の鍵を引く前に期限で止まる `GoTrueClient.js:5526-5534`) → `data` が `null`・`error?.name` が `'AuthInvalidJwtError'`・`fakeFetch` に `/auth/v1/user` の呼び出しが無い (`expect(...).resolves` で投げないことも見る)。この戻り値 (`{ error }`) を `readSessionAssurance` が `AUTH_UNAUTHENTICATED` にすることは `src/lib/auth/__tests__/mfa-assurance.test.ts:101` の it (`getClaims` をモックして `{ error }` を返す) が既に見ている。B-8 は本物の auth-js が期限切れでその形を返す (投げない) ことを固定し、2 つで route までの鎖を閉じる |

**C. `tests/integration-auth-transient-retry.test.ts:100-107`**

```ts
// tsc:skip  (vitest の it。相対 import は既存のファイルのもの)
it("やり直しが無いと、504 で signInWithPassword はゲートウェイの失敗のエラーになる (AuthRetryableFetchError。本文が JSON でなく statusText も無いので message は 'HTTP 504'。落ち方の再現)", async () => {
  const fake = scriptedFetch([gateway(504)]);
  vi.stubGlobal("fetch", fake.fn);
  const { data, error } = await adminClient().auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
  expect(data.session).toBeNull();
  expect(error?.name).toBe("AuthRetryableFetchError");
  expect(error?.message).toBe("HTTP 504");
  expect(error?.status).toBe(504);
});
```

ヘッダーのコメント `:8-9` の「`{}` というメッセージのエラー」は「ゲートウェイの失敗 (502 / 503 / 504) のエラー (auth-js 2.105 では message が `{}`、2.117 からは `HTTP 504`)」に直す。`describe` の名前 (`:99`) の「beforeAll の `{}`」も同じく。やり直しのヘルパ `tests/integration/helpers/auth-transient-retry.ts:6-9` の説明 (「`{}` というメッセージのエラー」「そのメッセージに Response を JSON にしたもの (`{}`) を入れる」) も同じ文に直す (ヘルパのコードは変えない。判定は status だけ `:200`)。

**D. middleware のテストのモック (4 か所)** — `options.cookies.set('sb-…', 'value', { path: '/' })` を `options.cookies.setAll([{ name: 'sb-…', value: 'value', options: { path: '/' } }], {})` に置き換える (`middleware-maintenance.test.ts:225`・`:436`、`middleware-legal-consent.test.ts:116`、`middleware-legal-consent-api.test.ts:131`)。assert (`set-cookie` に `sb-…=value` が入る) は変えない。コメント「`cookies.set` が呼ばれる」は「`cookies.setAll` が呼ばれる」に。

**E. 新設 `src/__tests__/lib/supabase-ssr-cookie-compat.test.ts`** (jsdom。本物の ssr と auth-js。fetch は `createFakeSupabaseFetch`。`createServerClient` / `createBrowserClient` には製品と同じ `cookieEncoding: SUPABASE_COOKIE_ENCODING` を渡す。分割の境界は ssr の `MAX_CHUNK_SIZE` (`@supabase/ssr/dist/main/utils/chunker` から import) より長い JSON で作り、長さを直書きしない)

| # | it |
|---|---|
| E-1 | 「ssr 0.1 が書いた JSON の Cookie (1 つ) を、getAll / setAll の createServerClient が読み、getSession が同じ access_token を返し、getUser が通る」 |
| E-2 | 「2 つに分割された JSON の Cookie (.0 / .1) も読む」 |
| E-3 | 「base64url で書かれた base64- の Cookie も読む (あとで base64url へ切り替えたときの読み)」 |
| E-4 | 「SUPABASE_COOKIE_ENCODING (raw) でセッションを書くと、値は base64- で始まらず、番号順につないで JSON.parse できる (ssr 0.1.0 + auth-js 2.105.3 が読む形)。1 つに収まるときは古い分割 (.0 / .1) を同じ setAll で maxAge 0 にする」 |
| E-5 | 「createBrowserClient (cookieEncoding だけを渡す) は document.cookie の JSON の Cookie を読み、更新のあとも JSON のまま書く (seedBorrowedSession の形)」 |
| E-6 | `it.each` で 2 行 (`[{ flow: 'Google ログイン', stored: LEGACY_CODE_VERIFIER, event: 'SIGNED_IN' }, { flow: 'パスワードの再設定', stored: LEGACY_CODE_VERIFIER + '/recovery', event: 'PASSWORD_RECOVERY' }]`。名前の `$flow` に入れる) 「[$flow] 更新の前 (ssr 0.1 + auth-js 2.105) に書かれた従来の verifier の Cookie (`<STORAGE_KEY>-code-verifier`) を、更新の後のコールバックの route と同じ createServerClient (getAll / setAll・raw) の exchangeCodeForSession(code) (flow id 無し) が読み、その verifier で交換し、セッションを JSON の Cookie に書き、従来の verifier の Cookie を maxAge 0 で消す」 (S-21・T-21・閉包 W-7・W-8)。中身: 保管 (Map) に `${STORAGE_KEY}-code-verifier` を E-1 と同じ形 (2.105.3 の `setItemAsync` が `JSON.stringify` した値。`stored`) で置き、fetch は `createPkceExchangeFetch()` (このファイルに置く: `/auth/v1/token?grant_type=pkce` の本文の `code_verifier` を記録してセッションの JSON を返し、ほかは `createFakeSupabaseFetch()` に任せる)。`exchangeCodeForSession(AUTH_CODE)` のあと、記録した `code_verifier` が `LEGACY_CODE_VERIFIER` (`/recovery` は付かない `GoTrueClient.js:1626`)・`onAuthStateChange` の事象が `event` (`:1652`)・`data.session` が null でない・`setAll` に渡ったセッションの Cookie の値が `base64-` で始まらず JSON として読める・同じく `${STORAGE_KEY}-code-verifier` が `maxAge: 0` で渡る (`removePKCEVerifier` の flow id 無しの枝 `lib/helpers.js:362-366`) |
| E-7 | 「更新の後に始めた flow (createBrowserClient の signInWithOAuth) は、flow ごとの Cookie と一覧の Cookie に加えて従来のキーにも同じ verifier を書き、flow id を渡さないコールバック (createServerClient の exchangeCodeForSession(code)) が従来のキーからその verifier を読んで交換する」 (S-21 の後半・T-21)。中身: `createBrowserClient` (jsdom・`cookieEncoding` だけ・fetch は `createPkceExchangeFetch()`) で `signInWithOAuth({ provider: 'google', options: { redirectTo: OAUTH_CALLBACK_URL, skipBrowserRedirect: true } })` → `document.cookie` に `${STORAGE_KEY}-code-verifier`・`${STORAGE_KEY}-flows-code-verifier`・`${STORAGE_KEY}-flow-<flow id>-code-verifier` (`<flow id>` は一覧の Cookie の配列の 1 つ目) があり、flow ごとの値と従来のキーの値が同じ (`lib/helpers.js:327-341`)。その `document.cookie` の名前と値を保管 (Map) に移して `createServerClient` を作り、`exchangeCodeForSession(AUTH_CODE)` → 記録した `code_verifier` が従来のキーの値 (JSON から戻した文字列) と同じ・`data.session` が null でない |

**F. 新設 `tests/supabase-cookie-encoding-callers.test.ts`** (走査。`tests/helpers/ai-reach.ts` の `stripComments` でコメントを外した本文を見る)

| # | it | 中身 |
|---|---|---|
| F-1 | 「SUPABASE_COOKIE_ENCODING は raw (ssr 0.1.0 と同じ JSON の書式。旧バンドルとロールバックが読める)」 | `expect(SUPABASE_COOKIE_ENCODING).toBe('raw')` |
| F-2 | `it.each(['lib/supabase/client.ts', 'lib/supabase/server.ts', 'lib/supabase/middleware.ts'])` 「%s の createServerClient / createBrowserClient の呼び出しは、どれも cookieEncoding: SUPABASE_COOKIE_ENCODING を渡す」 | 本文の `/\bcreate(?:Server\|Browser)Client\(/g` の数が 1 以上で、`/\bcookieEncoding:\s*SUPABASE_COOKIE_ENCODING\b/g` の数と等しい (`ReturnType<typeof createServerClient>` は `(` が続かないので数えない)。3 ファイルとも `@/lib/supabase/cookie-encoding` を import する |
| F-3 | 「ssr のクライアントを値で作るのは lib/supabase の 3 ファイルだけ (ほかの製品コードが書式を指定せずに作らない)」 | `src`・`lib`・`packages` の製品コード (`__tests__`・`*.test.*` を除く) で、`@supabase/ssr` から `createServerClient` / `createBrowserClient` を値で import するファイルの集合が F-2 の 3 ファイルと一致する (`import type` は数えない。`lib/legal-consent-minor.ts:9` は型だけ) |

**G. 変えないテスト (実測で緑を確かめる)**

母集合は「`@supabase/supabase-js`・`@supabase/auth-js`・`@supabase/ssr` を import するテストと、それらを import するヘルパを使うテスト」(`git grep -l "@supabase/supabase-js\|@supabase/auth-js\|@supabase/ssr" origin/main -- tests src lib apps/mobile/__tests__` の 274 ファイルから製品のコードを除いた 222 ファイル。閉包は表の下)。どれも実装の枠の全件 (`npx vitest run`・`npm run test:integration` 相当・apps/mobile の `npx jest`) に入るので、ここでは**本物のライブラリの挙動を通るか**で分け、通るものを名指しする。赤になったら、2.117 の lock 無し (§9.6 ②) による順番の違いか、`refresh_token_not_found` の扱いの違いか、本文が JSON でない 5xx の message の違い (§9.12) かを切り分け、assert の意味を保って直す。期待値は緩めない。

| 群 | テスト (origin/main) | 本物のライブラリを通る経路 | 2.117.3 / 0.12.7 で変わるか |
|---|---|---|---|
| G-1 Web・本物の auth-js | `src/__tests__/lib/native-session-authjs-thresholds.test.ts` の既存の it | 定数 (`dist/main/lib/constants`) と、更新を**試みる**こと | 変わらない (定数は同じ値 §9.1) |
| G-2 Web・本物の auth-js | `main-layout-signed-out.test.tsx` の `:278`・`:291`・`:337` (A-5〜A-7) | `createBrowserClient` (`real-auth-js.ts`) と `signOut()` | 変わらない (更新が走らない。`signOut` は §9.1 の `_signOut`) |
| G-3 apps/mobile・本物の supabase-js | `apps/mobile/__tests__/lib/supabase-client.test.ts` (`jest.dontMock('@supabase/supabase-js')` `:50`) | `setSession → getSession → signOut` を `secureSessionStorage` に通す | 変わらない見込み (lock 無しでも 1 呼び出しずつ `await` する) |
| G-4 apps/mobile・本物の supabase-js | `apps/mobile/__tests__/lib/webViewBridge.supabase.test.ts` (`:19` で `createClient` を直接 import) | `getSession()` の自動更新の条件 (残り 90 秒) と更新の成功 | 既存の it は変わらない (`EXPIRY_MARGIN_MS` は同じ。成功の経路は控えに触れない)。控えの経路は H で足す (段 3) |
| G-5 apps/mobile・本物の supabase-js | `apps/mobile/__tests__/lib/web-view-auth-messages.real-auth.test.ts` (`:234` で本物の `supabase.ts`) | `getUser()` の 403 → `_removeSession` | 変わらない (§9.1 `:2724-2731`)。コメント `:12-13` だけ段 4 |
| G-6 結合・本物の supabase-js (ローカル Supabase) | 道具の `tests/integration/helpers/supabase.ts:17`・`:33-34`・`:61-62`・`:80-81`、`tests/integration/helpers/mfa.ts:9`・`:105-108` と、`tests/integration/rls/*`・`tests/integration/security/*` (#1831 の `security/anon-invoker-execute.test.ts` (`:49-50`)・#1828 の `security/cron-failure-monitoring.test.ts` (`:90-91`)・#1837 の `rls/billing-manual-grant-rpc.test.ts` (`:60-61`) を含む)・`tests/integration/operator/*`・`tests/integration/handson-tour/*`・`tests/integration/edge-functions/smoke.test.ts`。この 130 ファイルは、`handson-tour/rpc-cleanup-sandbox.test.ts` が道具を使うほかは、ファイルの中で `createClient` を道具と同じ `auth` の指定で作る | クライアントは全部 `autoRefreshToken: false`・`persistSession: false`。`signInWithPassword` と PostgREST の呼び出し | 更新の失敗の扱いは通らない。Cookie を読む 2 本 (`native-bridge-flow`・`operator-mfa`) も、サーバーが JSON (`raw`) で書くので変わらない (§9.7。`operator-mfa.test.ts:139` のコメントだけ段 4) |
| G-7 結合・本物の supabase-js (偽の fetch) | `tests/integration-setup-transient-retry.test.ts:14`・`:108-109` | PostgREST の 5xx (本文は JSON `:81`) の `error.message` | 変わらない見込み (本文が JSON なら message は本文から)。`integration-auth-transient-retry` は C で直す |
| G-8 型だけの import | `src/__tests__/lib/badges/award-badge.test.ts:3`・`src/__tests__/lib/data-subject-requests/fake-dsr-db.ts:15`・`notifications.test.ts:5`・`src/__tests__/lib/membership/exit-notification.test.ts:2`・`src/lib/auth/__tests__/mfa-assurance.test.ts:5`・`mfa-factors.test.ts:4`・`sessions-session-claims.test.ts:4`・`tests/api/account-data-requests-missing-profile.test.ts:19`・`account-data-requests-route.test.ts:14`・`tests/award-badge.test.ts:13`・`tests/meal-image-backfill-trigger.test.ts:21`・`tests/meal-image-skip.test.ts:30`・`tests/integration/helpers/org-owner.ts:12`・`setup-transient-retry.ts:26` | `import type` (`SupabaseClient`・`User`・`Factor`) だけ | 型の名前は 2.117.3 にもある。`tsc` で確かめる (赤なら型の変化として扱い、`any` で逃げない) |
| G-9 ssr をモック | `lib/supabase/__tests__/` の `vi.mock('@supabase/ssr')` のうち D で直さない 5 本 (`middleware.test.ts`・`middleware-family-menu.test.ts`・`middleware-frozen-allowed-api.test.ts`・`middleware-legal-consent-matrix.test.ts`・`middleware-push-token-claim-exemption.test.ts`)・`tests/health-middleware-exemption.test.ts`・`tests/next16-proxy-convention.test.ts`・`src/__tests__/lib/maintenance-mode.test.ts` | 本物の ssr は通らない。モックが `options.cookies.set` を呼ばないこと | 変わらない (D の 4 か所以外に `cookies.set(` を呼ぶモックは無い §9.14) |
| G-10 supabase-js をモック・走査 | `native-session-watcher.test.tsx` (`getSession` をモック)・`tests/auth/native-bridge.test.ts` (server の `createClient` をモック)・`apps/mobile/__tests__/lib/supabase-config.test.ts` (`jest.mock('@supabase/supabase-js')` `:26`)・`tests/supabase-service-role-client-scan.test.ts`・`tests/edge-function-dep-pinning.test.ts` (文字列の走査) | 本物は通らない | 変わらない (§9.14) |
| G-11 supabase-js を `vi.mock` で丸ごと差し替え (27 本) | `src/__tests__/api/account/delete-missing-env.test.ts`・`src/__tests__/api/cron/process-menu-queue.test.ts`・`src/__tests__/api/log.test.ts`・`src/__tests__/api/operator/membership/family-candidates.test.ts`・`family-dissolve.test.ts`・`family-transfer.test.ts`・`org-candidates.test.ts`・`org-dissolve.test.ts`・`org-transfer.test.ts`・`src/__tests__/api/org/owner-transfer/propose.test.ts`・`src/__tests__/lib/db-logger-env.test.ts`・`src/__tests__/lib/db-logger-missing-env.test.ts`・`tests/aggregate-org-stats-disabled.test.ts`・`tests/ai-usage-edge.test.ts`・`tests/api-security-cluster.test.ts`・`tests/api/health-route.test.ts`・`tests/calculate-segment-stats-planned-meals.test.ts`・`tests/catalog-import-run-finalize.test.ts`・`tests/cron-process-menu-queue-ai-consent.test.ts`・`tests/cron-secret.test.ts`・`tests/e2e-membership-cleanup.test.ts`・`tests/edge-db-logger-supabase-js.test.ts`・`tests/edge-function-cors.test.ts`・`tests/edge-missing-env-response.test.ts`・`tests/logger.test.ts`・`tests/process-meal-image-jobs-worker-edges.test.ts`・`tests/purge-hidden-content-edge.test.ts` | 本物は通らない (`createClient` は偽物。`auth.admin.*` も偽物の関数) | 変わらない |
| G-12 supabase-js を `importOriginal` で残し `createClient` だけ差し替え (7 本) | `tests/ai-chat-flag-edge.test.ts`・`tests/ai-consent-enforcement-edge.test.ts`・`tests/ai-consent-enforcement-routes.test.ts`・`tests/ai-consent-stored-failure.test.ts`・`tests/ai-usage-direct-jwt-edge.test.ts`・`tests/edge-public-error-1444.test.ts`・`tests/edge-stored-failure-raw-error.test.ts` | Edge Function のコードを Vitest で読む。`@supabase/supabase-js` は Vitest では npm の版 (更新後は 2.117.3) に解決し (Deno の `jsr:` 2.99.1 ではない)、クライアント以外の export (エラーのクラスなど) は本物 | 変わらない見込み (クライアントは偽物で、更新も Cookie も通らない)。赤なら export の名前・エラーのクラスの変化として切り分ける |
| G-13 e2e (Playwright。実装の枠の全件 = Vitest / Jest の外) (16 本) | `tests/e2e/fixtures/fresh-family.ts`・`fresh-org.ts`・`fresh-user.ts`・`tests/e2e/global-setup.ts`・`tests/e2e/helpers/membership-paste.ts`・`membership.ts`・`test-session.mjs`・`tests/e2e/legal-consent-gate.spec.ts`・`tests/e2e/membership/01-org-invite-existing-user.spec.ts`・`02-org-invite-new-user.spec.ts`・`03-org-invite-edge-cases.spec.ts`・`04-org-member-management.spec.ts`・`05-family-create-and-invite.spec.ts`・`06-family-edge-cases.spec.ts`・`07-family-child-management.spec.ts` (membership の 7 本。`08`〜`14` は supabase-js を import しないので母集合の外)・`tests/e2e/signup-email-callback-full.spec.ts` | service_role のクライアント (`autoRefreshToken: false`・`persistSession: false`) と `auth.admin.*`、JSON の Cookie を書く (§9.7) | 変わらない (Cookie を読む側の `tests/e2e/fixtures/auth.ts` も、JSON (`raw`) のままなので変えない)。e2e は実装の枠では流さず、本番の Cookie の経路は §9.8 の 3 で見る |
| G-14 Cookie の名前だけ (1 本) | `apps/mobile/__tests__/lib/web-view-cookie-cleanup.test.ts` (`sb-…-auth-token`・`.0`・`.1`・`-code-verifier` を接頭辞 `sb-` で消す) | 本物は通らない | 変わらない (0.12.7 / 2.117.3 でも名前の形は同じで、2.117 の verifier の新しい名前も `sb-` で始まる §9.1) |
| G-15 文字列・コメントだけ (3 本) | `lib/supabase/__tests__/supabase-public-env.ts` (コメント)・`tests/log-sanitizer.test.ts:157` (スタックの文字列)・`tests/integration/helpers/auth-transient-retry.ts:6-9` (2.105 の `{}` の説明) | 本物は通らない | テストは変わらない。`auth-transient-retry.ts:6-9` のコメントだけ段 3 で 2.117 の message (`statusText` か `'HTTP <status>'`) の文に直す (§9.9 C と同じ) |

閉包: 上の grep の 274 ファイル (origin/main `7d05ff10`) から製品のコード (§9.1 の import の閉包) 52 ファイルを除いた **222 ファイル**が、A〜F・H で直す・新設するもの (H の `webViewBridge.supabase.test.ts` は G-4 にも数える) と G-1〜G-15 で尽きる。G-6 の `*` は、ファイルごとの判定を書かずクライアントの作り方で一括に判定する (2026-10-17 の数: `rls` 56・`security` 69・`operator` 1・`handson-tour` 3・`edge-functions/smoke.test.ts` 1 の 130 ファイル)。作り方の確かめ方: 130 ファイルそれぞれで、コメントの行 (`//`・`*`・`/**` で始まる) を除いた `createClient(` の数が、`autoRefreshToken: false` の数と `persistSession: false` の数のどちらより多くもない (2026-10-17 は全部そう。`createClient(` の無い 1 本は `handson-tour/rpc-cleanup-sandbox.test.ts` で、道具を使う)。origin/main が進んでこの表に無いファイルが母集合に出たら、全件 (`npx vitest run`・`cd apps/mobile && npx jest`) の緑で判定し、赤ならこの節の規則 (切り分け → assert の意味を保って直す。期待値は緩めない) で直す。

**H. `apps/mobile/__tests__/lib/webViewBridge.supabase.test.ts` に describe を足す** (「auth-js 2.117 の失敗の控えのもとでの getSessionForBridge (本物の supabase-js)」。既存の it は変えない)

`makeDeviceAuth(remainingSec, clockBehindSec = 0, isGatewayDown: () => boolean = () => false, autoRefreshToken = false)` と第 3・第 4 引数を足す。`isGatewayDown()` が真の間は `fetchMock` が `new Response(GATEWAY_FAILURE_BODY, { status: TRANSIENT_GATEWAY_STATUS })` (本文が JSON でない 503。auth-js が `AuthRetryableFetchError` にする) を返す。`autoRefreshToken` は `createClient` の `auth.autoRefreshToken` に渡す (既定の `false` はいまの値。`true` は端末の `apps/mobile/src/lib/supabase.ts:59` と同じで、初期化の `_recoverAndRefresh` が失効済みのセッションの更新を試みる `GoTrueClient.js:4128-4129`)。既存の呼び出しは第 3・第 4 引数を渡さない (挙動は変わらない)。この describe は `beforeEach(() => jest.useFakeTimers())`・`afterEach(() => jest.useRealTimers())` (auth-js のやり直しの `sleep` は `setTimeout`、控えの期限は `Date.now()`。どちらも偽の時計で進める)。auth-js の定数は `@supabase/auth-js/dist/main/lib/constants` から import する (`AUTO_REFRESH_TICK_DURATION_MS`・`REFRESH_FAILURE_COOLDOWN_MS`。jest は `jest.config.js` の `modulePaths` でルートの `node_modules` から解決する)。

| # | it | 中身 |
|---|---|---|
| H-1 | 「access token が失効し、更新がやり直せる失敗 (503) で終わったあとは、失敗の控え (REFRESH_FAILURE_COOLDOWN_MS) の間に通信が戻っても /token を呼ばずに null を返し (直接の URL へ倒れる)、控えが切れたあとは更新して bridge のセッションを返す」 | `let gatewayDown = true` → `makeDeviceAuth(ALREADY_EXPIRED_REMAINING_SEC, 0, () => gatewayDown)` → `const first = getSessionForBridge(auth)` → `await jest.advanceTimersByTimeAsync(RETRY_WINDOW_MS)` (やり直しを流しきる) → `await first` が `null` → `/token` の回数を n とする (n ≥ 1) → `gatewayDown = false` → `getSessionForBridge(auth)` が `null`・`/token` は n のまま (控え) → `auth.getSession()` が `data.session === null`・`error?.name === 'AuthRetryableFetchError'`・`/token` は n のまま (ネイティブの `session-expired` の受け取りの控え `readSessionSnapshot` (`webViewAuthMessages.ts:203-212`) が読むのと同じ値。null の控えが `no-session` になることは `apps/mobile/__tests__/lib/web-view-auth-messages.real-auth.test.ts:425` の it が見ている。2 つで表①の `session-expired` の受け取りの行・S-23 を閉じる) → `await jest.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS)` → `getSessionForBridge(auth)` の `refresh_token` が `'RT-new'`・`/token` は n + 1 |
| H-2 | 「残りが 150 秒 (Web 側の下限) 未満のとき、60 秒以内に同じ refresh_token の更新がやり直せる失敗で終わっていると、通信が戻っていても refreshSession は /token を呼ばず、getSessionForBridge は null を返す」 | `const remainingAtStart = BRIDGE_SERVER_MIN_TOKEN_TTL_SEC + RETRY_WINDOW_MS / MS_PER_SECOND + REMAINING_HEADROOM_SEC` → 前提: `expect(remainingAtStart).toBeLessThan(BRIDGE_MIN_TOKEN_TTL_SEC)` と `expect(RETRY_WINDOW_MS + (REMAINING_HEADROOM_SEC + 1) * MS_PER_SECOND).toBeLessThan(REFRESH_FAILURE_COOLDOWN_MS)` (2 回目の呼び出しが控えの中) → `let gatewayDown = true` → `makeDeviceAuth(remainingAtStart, 0, () => gatewayDown)` → `const first = getSessionForBridge(auth)` → `advanceTimersByTimeAsync(RETRY_WINDOW_MS)` → `await first` の `access_token` が `originalAccessToken` (更新は失敗したが残りが下限以上) → `/token` の回数を n とする (n ≥ 1) → `gatewayDown = false` → `advanceTimersByTimeAsync((REMAINING_HEADROOM_SEC + 1) * MS_PER_SECOND)` (残りが下限を 1 秒割る) → `getSessionForBridge(auth)` が `null`・`/token` は n のまま |
| H-3 | 「access token が失効したまま通信の無い状態で起動すると、初期化の更新のやり直し (1 回ぶん) のあとの getSession() は /token を呼び直さず、控えた失敗 (session null・AuthRetryableFetchError) をすぐ返す」 (表①の「起動時 `getSession()` (期限切れ + オフライン)」の行・S-19・T-19。2.105.3 は初期化と `getSession()` のそれぞれでやり直した) | `const { auth, fetchMock } = makeDeviceAuth(ALREADY_EXPIRED_REMAINING_SEC, 0, () => true, true)` (作った時点で初期化が更新を始める) → `let settled = false` → `const first = auth.getSession().then((r) => { settled = true; return r })` → `await jest.advanceTimersByTimeAsync(RETRY_WINDOW_MS)` (初期化のやり直しを 1 回ぶん流しきる) → `settled` が真 (やり直しが 1 回ぶんで返る。2.105.3 では `getSession()` がもう 1 回ぶんやり直すので偽) → `await first` が `data.session === null`・`error?.name === 'AuthRetryableFetchError'` → `/token` の回数を n とする (n ≥ 1) → タイマーを進めずに `await auth.getSession()` → 同じ `error.name`・`/token` は n のまま → 最後に `await auth.stopAutoRefresh()` (`autoRefreshToken: true` が張った tick を止める) |

H-1〜H-3 は 2.105.3 では赤になる (控えが無く、H-1・H-2 は通信が戻った後の `/token` が成功して bridge のセッションが返り、H-3 は `getSession()` がもう 1 回ぶんやり直して `RETRY_WINDOW_MS` の後も返らない)。2.117 の控えが bridge と起動に効くことを本物の supabase-js で固定し、次に auth-js を上げたとき気づくためのもの (裁定 G で受け入れた挙動の番兵)。

**I. 表 3 点の行と it の対応 (閉包)**

§9.6 の ① と ③ のうち 2.117 で変わる行と、本改定で足した行を、それを固定する it に対応させる。it の無い行は、理由を書く。

| 表の行 | it |
|---|---|
| ① WebView の tick / `getSession()` (120〜0 秒・失効後の控え有効・控え切れ)、③ (a) の「有効 → 失効前・控え中」〜「失効後・控え無し → 捨てた」 | A-1・B-2〜B-4 |
| ① WebView の「サーバーの応答が先に Cookie を消した後」、ふつうのブラウザの同じ行、③ (a) の「→ 保管なし」「保管なし × tick」、③ (b) の「(事象なし)」2 行 | A-9 (2 行) |
| ① ふつうのブラウザの tick (120〜0 秒) | A-8 (2 行) |
| ① 「どれでも」の 5xx・接続の失敗、③ (a) の「→ その時間帯の控え中」 | B-5 |
| ① 「どれでも」の `signOut()` の `/logout` の失敗・失効後の更新の 5xx、③ (a) の「有効 × `signOut()`」「失効後・控え中 × `signOut()`」「失効後・控え無し × `signOut()` × 5xx」 | B-6 (2 行) |
| ① ネイティブの規約の同意画面の `afterSignOut` の行、③ (d) の 4 行 | B-6 (2 行。`signOut()` の後の `getSession()` が、有効の行は保管が空で `null`、失効済みの行は控えた失敗で `null`) + `apps/mobile/__tests__/app/legal-consent-screen.test.tsx` の既存の it (`:148` session が無くなると「閉じる」を出す・`:119` 同意を待つ間は「閉じる」を出さない・`:219` `getSession()` が `null` なら移らない・`:231` セッションが残っていれば入口へ・`:243` `getSession()` が投げたら入口へ) |
| ① 「どれでも」の `signOut()` の更新の 400・保管が空・scope `others`、③ (a) の「失効後・控え無し × `signOut()` × 400」「保管なし × `signOut()`」「有効 × scope `others`」「保管なし × scope `others`」 | B-7 (4 行) |
| ③ (a) の「→ 有効 (`/token` が成功)」 | H-1 の最後 (控えが切れた後の更新が成功し、bridge が `RT-new` を返す。本物の supabase-js)。借り物の値では成功しないので、Web の借り物の it は無い |
| ① ふつうのブラウザ (PKCE) | E-6 (2 行)・E-7 |
| ① Next の route の `getClaims(token)` の期限切れ | B-8 + `mfa-assurance.test.ts:101` (既存) |
| ① ネイティブの起動時 `getSession()` (期限切れ + オフライン) | H-3 |
| ① ネイティブの WebView のタブを開く 2 行、③ (c) の控え中の行 | H-1・H-2 |
| ① ネイティブの `session-expired` の受け取り (控え中)、③ (c) の「失効後・控え中 × `session-expired`」 | H-1 の `auth.getSession()` の assert + `web-view-auth-messages.real-auth.test.ts:425` (既存。null の控えで `no-session`) |
| ③ (b) の `SIGNED_OUT` の行 (送る・ログアウト通知済み・タイマー満了・セッションが戻る・離脱) | A-1〜A-4・A-6 (ログアウト通知済みで `session-expired` が届かない `:291`) |
| ③ (b) の「再ブリッジ待ち × 2 回目の `SIGNED_OUT`」 | 無い。`MainLayout` のコードを変えない行で、2.117 の変化 (失効前に捨てない) はこの行の挙動 (`notifyNativeSessionExpired()` を呼び、タイマーは張り直さない `MainLayout.tsx:167`・`:170`) を変えない。2 回目の `SIGNED_OUT` は、他のタブの auth-js の `SIGNED_OUT` (`GoTrueClient.js:270-290` の BroadcastChannel) や保管なしの `signOut()` で来る |
| ① middleware の行 (借り物・実 token)・`getUser()` の 403 の行・ネイティブの 403 の行 | 両版で同じ (§9.1)。既存の G-5・G-6 と結合テスト |

### 9.10 apps/mobile

- `apps/mobile/package.json:24` を `"@supabase/supabase-js": "^2.117.3"` にする。ルートの lock はワークスペースの 1 コピー (`apps/mobile/node_modules/@supabase/*` は無い) なので、ルートを上げた時点で apps/mobile も 2.117.3 を使う。宣言を同じ範囲にして、巻き上げが 1 つであることを宣言でも保つ (`tests/zod-single-copy-1444.test.ts` と同じ考え。supabase-js 用の番兵は作らない: 範囲が違っても npm は 1 コピーに巻き上げ、違いが出るのは apps/mobile だけが古い範囲を要求したとき)。
- **ネイティブのビルドは要らない**: supabase-js も auth-js も JS だけで、ネイティブモジュールの追加・変更は無い (依存は `tslib` だけ)。実行環境の API も 2.105.3 と同じ (§9.1)。ただし OTA は無効 (`app.json:66-70`) なので、端末に届くのは次の EAS Build からで、この更新のためだけにビルドは出さない。
- 端末側の挙動の変化は §9.6 ① の 9 行 (発注の決めること 4 の判断の材料。呼び出しごとの扱いは §9.1 の auth の呼び出しの閉包 M-1〜M-9): 「ネイティブ (実 token)」の tick・`getSession()` の行 (失効と答えられたときの `SIGNED_OUT` が失効の後になる)、起動時の `getSession()` の行 (期限切れ + オフラインの起動の読み込み中が約 25 秒に縮む)、「どれでも」の 5xx・接続の失敗の行 (通信の回復から更新まで最大約 90 秒。S-19・裁定 G)、「ネイティブ (実 token)」の WebView のタブを開く 2 行と `session-expired` の受け取りの行 (同じ最大約 90 秒の間、まだ開いていないタブは bridge が通らず Web のログイン画面になり、WebView からの `session-expired` も何もしない。既に開いている WebView は `MainLayout` の 15 秒の待ちのあと localStorage を消して `/login` になりうる。S-23・S-24・裁定 G。閉包 M-9)、「どれでも」の `signOut()` の `/logout` の失敗の行 (access token が有効なうちなら、失敗でも保管を消して `SIGNED_OUT`。S-20)、「ネイティブ (実 token)」の規約の同意画面の `afterSignOut` の行 (access token が有効なうちの Web からの `sign-out` の失敗でも、成功のときと同じく「閉じる」を出す。S-29)、「どれでも」の規則 U の行 (残り 90 秒未満の更新の失敗でも `getUser()`・`updateUser`・MFA が保管の token で通る)。access token が失効していて更新もできないときの `signOut()` (両版とも `{ error }` で保管が残る。S-22) は変わらない。§3 の経路と掃除のコードは変わらない (`signOut()` の失敗は、access token が有効なうちなら成功のときと同じ `SIGNED_OUT` の行を通り、失効していて更新もできないときは `signOutOrForgetLocally` の端末での消去が受ける。§3 の表の `{ error }` の行)。どの行も、ネイティブのセッションを新しく失う変化ではない (`SIGNED_OUT` が遅れて届くか、ログアウトの失敗でも届くようになるか、通信の回復の直後の最大約 90 秒に bridge が通らないか)。apps/mobile を 2.105.3 に留める (宣言を `2.105.3` に固定して `apps/mobile/node_modules/@supabase/*` に 2 つ目のコピーを置く) と、これらの変化は起きないが、ワークスペースの 1 コピー (R-8) が崩れ、apps/mobile の auth-js だけが古いまま Dependabot の対象に残る。本設計は上げる (裁定 F)。S-23 の窓を縮める apps/mobile の対処 (`TOKEN_REFRESHED` で bridge の無い WebView を読み込み直す) は §9.17 Q-8。
- `secureSessionStorage` (`getItem` / `setItem` / `removeItem` の非同期の保管) は 2.117 の `SupportedStorage` のまま。`lock` は渡さない (既定の無し。2.105 でも RN には `navigator.locks` が無く `lockNoOp` だった)。

### 9.11 新設一覧と定数

| 種類 | 名前 | 場所 | 中身 |
|---|---|---|---|
| ファイル | `lib/supabase/cookie-encoding.ts` | 新設 (製品コード。import を持たない) | §9.7。`SUPABASE_COOKIE_ENCODING` だけを export する |
| 定数 | `SUPABASE_COOKIE_ENCODING` = `'raw' as const` | `lib/supabase/cookie-encoding.ts` (export) | ssr の `cookieEncoding` に渡す書式 (裁定 D)。`lib/supabase/client.ts`・`server.ts`・`middleware.ts` と `src/__tests__/helpers/real-auth-js.ts`・§9.9 E が import する。F が見張る |
| ファイル | `tests/supabase-cookie-encoding-callers.test.ts` | 新設 | §9.9 F |
| ファイル | `src/__tests__/lib/supabase-ssr-cookie-compat.test.ts` | 新設 | §9.9 E |
| 定数 | `BORROWED_ACCESS_TOKEN` = `'borrowed-access-token'` | `src/__tests__/helpers/real-auth-js.ts` (export) | `seedBorrowedSession` が書く access token。A-1・A-8・B-2・E が「同じ token が残る」を見る |
| 定数 | `ALREADY_EXPIRED_REMAINING_SECONDS` = -1 | `src/__tests__/helpers/real-auth-js.ts` (export) | 失効済みの借り物のセッションの残り (バックグラウンドから戻った状態)。A-2〜A-4・A-8・B-5・B-6 が使う。B-8 は期限切れの JWT の `exp` に使う |
| 定数 | `SIGNED_OUT_AFTER_EXPIRY_MAX_MS` = `REFRESH_FAILURE_COOLDOWN_MS + AUTO_REFRESH_TICK_DURATION_MS` | `src/__tests__/helpers/real-auth-js.ts` (export。1 か所で定義) | 失効から `SIGNED_OUT` までの上限 (§9.4 T-4)。auth-js の定数から導く (数字を直書きしない)。A-1・B-4 が使う |
| 定数 | `SIGNED_OUT_POLL_STEP_MS` = 1_000 | `main-layout-signed-out.test.tsx` | A-1 の (3) で失効の後を進める 1 歩。`NATIVE_REBRIDGE_WAIT_MS` (15 秒) より短くして、`SIGNED_OUT` を見つけた時点で待ちが満了していないようにする (it の中で前提として assert)。既存の it の `advance(1_000)` と同じ 1 秒 |
| 定数 | `SERVER_CLEARS_FIRST_REMAINING_SECONDS` = 100 | `main-layout-signed-out.test.tsx` | A-9 (2 行とも) の種の残り。失効の直後にブラウザの auth-js がまだ捨てていない (E - 40 の失敗の控えが E + 20 まで効く) 残りで、サーバーが先に Cookie を消す順 (S-27・S-28) を作る。A-1 の `it.each` の 100 と同じ値 (§9.9 A の説明) |
| 定数 | `TRANSIENT_GATEWAY_STATUS` = 503 | `native-session-authjs-thresholds.test.ts` | B-5 の `/token` と B-6 の `/logout`・`/token` が返す状態。auth-js の `handleError` が本文が JSON でない 5xx を `AuthRetryableFetchError` にする (`lib/fetch.js:44-48`) |
| 関数 | `createTransientRefreshFailureFetch(): FakeSupabaseFetch` | `native-session-authjs-thresholds.test.ts` (ファイル内) | B-5。`/token` だけ `TRANSIENT_GATEWAY_STATUS` を返し、ほかは `createFakeSupabaseFetch()` |
| 関数 | `createTransientSignOutFailureFetch(): FakeSupabaseFetch` | `native-session-authjs-thresholds.test.ts` (ファイル内) | B-6。`/logout` と `/token` が `TRANSIENT_GATEWAY_STATUS` を返し、ほかは `createFakeSupabaseFetch()` |
| 定数 | `LONG_REMAINING_SECONDS` = 3_000 | `native-session-authjs-thresholds.test.ts` | B-6 の有効の行の残り。tick (残り 120 秒未満) も `getSession()` (残り 90 秒未満) も更新を試みない長さ (`main-layout-signed-out` の A-5〜A-7 の種と同じ値) |
| 関数 | `createSignOutSuccessFetch(): FakeSupabaseFetch` | `native-session-authjs-thresholds.test.ts` (ファイル内) | B-7。`/logout` に本文の無い 204 を返し、ほかは `createFakeSupabaseFetch()` (`/token` は 400) |
| 関数 | `createPkceExchangeFetch()` (`createFakeSupabaseFetch()` と同じ型の `vi.fn` と、記録した `code_verifier` の一覧を返す) | `src/__tests__/lib/supabase-ssr-cookie-compat.test.ts` (ファイル内) | E-6・E-7。`/auth/v1/token?grant_type=pkce` の本文の `code_verifier` を記録してセッションの JSON を返し、ほかは `createFakeSupabaseFetch()` |
| 定数 | `LEGACY_CODE_VERIFIER`・`AUTH_CODE`・`OAUTH_CALLBACK_URL` (文字列) | 同上 | E-6・E-7。2.105 が書いた形の verifier の値・コールバックに届く code・`redirectTo` |
| 関数の引数 | `makeDeviceAuth(remainingSec, clockBehindSec = 0, isGatewayDown: () => boolean = () => false, autoRefreshToken = false)` の第 3・第 4 引数 | `apps/mobile/__tests__/lib/webViewBridge.supabase.test.ts` (ファイル内の既存の関数) | §9.9 H。第 3 引数が真の間は `/token` に `TRANSIENT_GATEWAY_STATUS` を返す。第 4 引数は `createClient` の `auth.autoRefreshToken` (H-3 だけ `true`) |
| 定数 | `TRANSIENT_GATEWAY_STATUS` = 503・`GATEWAY_FAILURE_BODY` = `'upstream error'` | `apps/mobile/__tests__/lib/webViewBridge.supabase.test.ts` | §9.9 H。本文が JSON でない 503 (auth-js が `AuthRetryableFetchError` にする。B の同名の定数と同じ値だが、jest と vitest で別のファイル) |
| 定数 | `ALREADY_EXPIRED_REMAINING_SEC` = -1 | 同上 | H-1・H-3。失効済みの access token の残り (`real-auth-js.ts` の `ALREADY_EXPIRED_REMAINING_SECONDS` と同じ意味。jest から vitest のヘルパを読まないので別に持つ) |
| 定数 | `RETRY_WINDOW_MS` = `AUTO_REFRESH_TICK_DURATION_MS` | 同上 | H-1〜H-3。auth-js がやり直せる失敗をやり直す時間の上限 (`_refreshAccessToken` は次の待ちが tick を越えるところでやめる §9.1)。偽の時計をこれだけ進めて、やり直しを流しきる |
| 定数 | `MS_PER_SECOND` = 1_000・`REMAINING_HEADROOM_SEC` = 10 | 同上 | H-2。1 回目の呼び出しの残りを、やり直しを流しきった後でも下限 (150 秒) より 10 秒多くし、そこから 11 秒進めて下限を 1 秒割る。11 秒 + `RETRY_WINDOW_MS` が控えの 60 秒より短いことを it の前提で assert する |

製品コード (`src/`・`lib/`・`apps/mobile/src/`) の新しい識別子は `lib/supabase/cookie-encoding.ts` の `SUPABASE_COOKIE_ENCODING` だけ。環境変数・migration・テーブル・route・エラーコードの新設は無い。

### 9.12 エラー表

| 事象 | 2.105.3 | 2.117.3 | 扱う場所 |
|---|---|---|---|
| 借り物の refresh_token で `/token` → 400 `refresh_token_not_found` (`AuthApiError`。やり直さない) | セッションを捨て `SIGNED_OUT` | access token が有効なら残す (控え 60 秒)。失効後なら捨て `SIGNED_OUT` | `MainLayout` §6.3・見張り §6.1。Next のサーバー (middleware など) が失効後に捨てたときは、応答で Cookie を消すだけで、ブラウザに `SIGNED_OUT` は出ない (見張りが受ける。§6.3 の 5・S-27・裁定 H) |
| `/token` が 5xx・接続の失敗 (`AuthRetryableFetchError`) | 捨てない (保管は残る)。約 25 秒のやり直し。控えは無く、次の契機でまた `/token` | 捨てない (失効後でも。保管は残る)。約 25 秒のやり直しのあと、失敗を 60 秒控える (`:4324-4328`)。控えの間は `/token` を呼ばず、失効後の `getSession()` は控えた失敗 (`session: null`) を返す | 見張りは `AuthRetryableFetchError` なら何もしない (`NativeSessionWatcher.tsx:62`)。ネイティブは §3 の `getStoredSession()` で起動し、更新の遅れ (最大約 90 秒) は裁定 G で受け入れる (S-19) |
| `/token` などが 504 で本文が JSON でない | `AuthRetryableFetchError('{}')` | `AuthRetryableFetchError` で message は `statusText` (空なら `'HTTP 504'`) | `tests/integration-auth-transient-retry.test.ts` (§9.9 C) |
| `GET /user` → 403 `session_not_found` | `AuthSessionMissingError` → `_removeSession` | 同じ | §3・§6.2 (ネイティブ)・middleware の画面の分岐 (`/login`) |
| ふつうのブラウザの実 token で、サーバーの応答 (middleware の `getUser()` の 403 `session_not_found`・失効後の `getSession()` の更新の 400) が先に Cookie を消す | 403 では同じ (ブラウザに事象なし)。400 は前面では起きない (ブラウザが失効の 120 秒前に捨てる) | ブラウザに事象なし (`SIGNED_OUT` は出ない)。失効の後 (ブラウザが自分で捨てるまでの最大 90 秒) にも起き得る | `MainLayout` は何もしない (user-scoped の localStorage は残る)。画面の移動で middleware が `/login?next=…` へ回し、認証の要る `/api/*` は未ログインとして答える。裁定 H2 で受け入れる (S-28) |
| `_updateUser` で保管にセッションが無い | `AuthSessionMissingError` | 同じ | cross/16 §3 (本人の access token を明示して GoTrue を呼ぶ) |
| `_signOut` で保管にセッションが無い | GoTrue を呼ばず `_removeSession` → `SIGNED_OUT` → `{ error: null }` (scope `others` なら何もせず `{ error: null }`。`SIGNED_OUT` 無し) | 同じ (§9.6 ③ (a) の「保管なし」の行) | cross/16 §3 |
| `signOut()` (scope global / local) の `/logout` が 5xx・接続の失敗 (access token が有効) | 保管を残して `{ error }`。`SIGNED_OUT` 無し | 保管を消して `SIGNED_OUT` を出し `{ error }` (`GoTrueClient.js:3446-3449`) | Web は `MainLayout` §6.3。ネイティブは AuthProvider の `SIGNED_OUT` の行と `signOutOrForgetLocally` (S-20)。規約の同意画面の Web からの `sign-out` では、`afterSignOut` が入口へ移らず「閉じる」を出す (S-29) |
| `signOut()` (scope global / local) で、access token が失効していて更新が 5xx・接続の失敗で終わる (控えの間も) | `/logout` を呼ばずに `{ error }`。保管は残り `SIGNED_OUT` 無し (`:3185-3187`) | 同じ (`GoTrueClient.js:3433-3435`) | ネイティブは `signOutOrForgetLocally` の端末での消去が後始末の本体 (S-22)。`signOutWithCleanup` の経路と Web は保管が残る (§3 の `{ error }` の行の (b))。規約の同意画面は同意を待つ扱いのまま残る (Web も失敗して form に戻る。S-29) |
| `getClaims(token)` で token が期限切れ | `Error` を投げる (route まで上がる) | `{ data: null, error: AuthInvalidJwtError }` | `src/lib/auth/mfa/assurance.ts:68-69` が `AUTH_UNAUTHENTICATED` (401) にする。`src/lib/auth/sessions/session-claims.ts:43-44` の `readSessionAuth` が null を返し、`requireSessionUser` は `AuthError('AUTH_UNAUTHENTICATED')`・`recordWebLoginContextFromRequest` は warn の stage `claims` (2.105.3 は `exception`)。閉包 W-9・W-10 |
| ネイティブの bridge で、`getSession()` / `refreshSession()` が失敗の控えを返す (失効後、または残り 150 秒未満) | — (控えが無く `/token` を呼び直す) | `getSessionForBridge` が null → `WebViewScreen` は直接の URL (`webViewBridge.ts:568`・`:579`)。`session-expired` の控えも null なら `no-session` | 裁定 G で受け入れる (S-23・S-24)。§9.9 H が固定する |
| PKCE のコールバックで verifier が無い (`flowType: 'pkce'`) | `AuthPKCECodeVerifierMissingError` | 同じ (flow id 無しは従来のキーを読む。`GoTrueClient.js:1627-1629`) | コールバックの route の既存の失敗の扱いのまま |
| ssr: `createServerClient` に `set` / `remove` の無い `get` だけ | 動く | 書くときに `console.warn` (非推奨) | 本改定で `getAll` / `setAll` へ (§9.7)。残っていたら実装の誤り |
| ssr: `base64-` の値が base64url / JSON として壊れている | — | `console.warn` して「無い」扱い → 未ログインとして進む | 本改定は `base64-` を書かない (`raw`) ので、届くのは外から作られた Cookie だけ。本番の確認 §9.8 の 3 (d) で warn が無いことを見る |
| 旧バンドル・旧サーバー (ssr 0.1.0 + auth-js 2.105.3) が `base64-` の Cookie を読む | `getItemAsync` が文字列を返し `_removeSession` → Cookie を消して `SIGNED_OUT` | (書き手の 0.12.7 は `raw` なので起きない) | 裁定 D。§9.6 ①-2・S-25・S-26。§9.9 E-4・F が `raw` で書くことを見張る |
| ssr: `createBrowserClient` に `cookies` を渡さずブラウザ以外で `setItem` | — | 例外 (`cookies.js:179-181`) | テストは jsdom (isBrowser 真) で動かす。SSR の描画では `createClient()` (`client.ts`) を呼ばない (現行どおり) |

### 9.13 段分けと触るファイル

**1 PR・コミットは 4 段**。段ごとのレビューは要らない (変更は 40 ファイル = 段 1 が 3・段 2 が 10 (うち新設 3)・段 3 が 5・段 4 が 22。挙動を変える製品コードは `lib/supabase/middleware.ts` と `lib/supabase/server.ts` の 2 ファイル (Cookie の API) で、`lib/supabase/client.ts` は書式の指定を足すだけ (書く値は今と同じ JSON)・`lib/supabase/cookie-encoding.ts` は新設の定数 1 つ、ほかの製品コードはコメントだけ。15 ファイルを超えるので、実装ゲートのレビューは段 2・段 3・段 1 + 4 を担当に分けた分割パネル + 横断の 1 枚で組む)。`package-lock.json` の差分は生成物で、レビューは `package.json` の宣言と lock の実体 (`node_modules/@supabase/*` の版・`apps/mobile/node_modules/@supabase` が無いこと) を数えるだけにする。

| 段 | 中身 | 触るファイル | 段の完了条件 (数えて確かめる) |
|---|---|---|---|
| 1 依存 | `package.json` (`ssr ^0.12.7`・`supabase-js ^2.117.3`)・`apps/mobile/package.json` (`^2.117.3`)・`package-lock.json` の再生成。**版を名指しして**入れる (宣言の範囲だけで作ると、`^2.117.3` の中の最新 (2026-10-17 の時点で 2.118.0) が入り、本章の file:line (2.117.3) と食い違う)。M2 では流さず、テスト用の機械 (offload の行き先) で流して 3 ファイルを持ち帰る: `offload --no-install --fetch package.json --fetch apps/mobile/package.json --fetch package-lock.json -- bash -c 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund @supabase/supabase-js@2.117.3 @supabase/ssr@0.12.7 && npm install --package-lock-only --ignore-scripts --no-audit --no-fund -w apps/mobile @supabase/supabase-js@2.117.3'` (2 つの `package.json` の宣言は npm が `^2.117.3`・`^0.12.7` に書く) | `package.json`・`apps/mobile/package.json`・`package-lock.json` | (1) `git diff origin/main -- package-lock.json` で変わる `packages` の項目が次の集合と一致し、ほかに 1 つも無い: `""` と `apps/mobile` の宣言・`node_modules/@supabase/{supabase-js,auth-js,postgrest-js,realtime-js,storage-js,functions-js}` (2.105.3 → 2.117.3)・`node_modules/@supabase/ssr` (0.1.0 → 0.12.7)・`node_modules/@supabase/phoenix` (0.4.1 → 0.4.5。realtime-js 2.117.3 の固定)・`node_modules/cookie` (0.5.0 → ssr 0.12.7 の `^1.0.2` の範囲の最新。2026-10-17 は 1.1.1。使うのは ssr だけ)・`node_modules/@types/ws` は**残り**、`"dev": true` が付くだけ (ルートの `devDependencies` の `"@types/ws": "^8.18.2"` が要る。本番の依存から要っていた realtime-js 2.105.3 は `ws` と `@types/ws` に依っていたが、2.117.3 は依らない)・`node_modules/ramda` の削除 (使っていたのは ssr 0.1.0 だけ)。`node_modules/ws` は変わらない。計 13 項目。この集合は 2026-10-17 にテスト用の機械で上のコマンドを流し、origin/main の lock と `packages` の項目ごとに比べた実測 (npm の `dependencies` (`npm view <名前>@<版> dependencies`) と lock の逆引きとも合う) (2) zod・react・react-dom・@types/react の実体の版が origin/main と同じ (`tests/zod-single-copy-1444.test.ts`・`tests/react-types-version-contract.test.ts` が緑) (3) `npm ci` が lock のまま通る (4) `npm ls @supabase/supabase-js @supabase/ssr @supabase/auth-js` が 2.117.3 / 0.12.7 / 2.117.3 を 1 つずつ・`apps/mobile/node_modules/@supabase` が無い。(1) に無い項目が出たら、lock の再生成がほかの依存を動かしたので、その項目を origin/main の版に戻して作り直す (戻せないなら理由を deviations に書く) |
| 2 Cookie | §9.7 の ①・②・③・⑤ と新設の `lib/supabase/cookie-encoding.ts`、D のモック 4 か所、E・F のテスト | `lib/supabase/middleware.ts`・`lib/supabase/server.ts`・`lib/supabase/client.ts`・`lib/supabase/cookie-encoding.ts` (新)・`src/__tests__/helpers/real-auth-js.ts`・`lib/supabase/__tests__/middleware-maintenance.test.ts`・`middleware-legal-consent.test.ts`・`middleware-legal-consent-api.test.ts`・`src/__tests__/lib/supabase-ssr-cookie-compat.test.ts` (新)・`tests/supabase-cookie-encoding-callers.test.ts` (新) | `lib/supabase/middleware.ts`・`server.ts` の `cookies:` に `get` / `set` / `remove` が残らない (`getAll` / `setAll` だけ)・3 つの呼び出し口の `create*Client(` の数と `cookieEncoding: SUPABASE_COOKIE_ENCODING` の数が等しい (F-2 が緑)・`lib/supabase/__tests__` のモックに `cookies.set(` が残らない (`git grep -n "cookies.set(" -- lib/supabase/__tests__` の 4 か所が `cookies.setAll(` に)・結合テスト 2 本 (`native-bridge-flow`・`operator-mfa`) と `tests/e2e/fixtures/auth.ts` に差分が無い (段 4 の `operator-mfa.test.ts:139` のコメントを除く)・E-1〜E-7 と F-1〜F-3 が緑・`server.ts` から `type CookieOptions` の import が消えている |
| 3 auth の挙動 | §9.9 の A・B・C・H | `src/__tests__/app/main-layout-signed-out.test.tsx`・`src/__tests__/lib/native-session-authjs-thresholds.test.ts`・`tests/integration-auth-transient-retry.test.ts`・`tests/integration/helpers/auth-transient-retry.ts` (`:6-9` のコメントだけ)・`apps/mobile/__tests__/lib/webViewBridge.supabase.test.ts` | §9.9 A の赤の 6 件が A-1〜A-4・A-8 に置き換わって緑・新設の A-9 (2 行) が緑・A-5〜A-7 は差分無し・B-1〜B-8・C・H-1〜H-3 が緑 (H は `cd apps/mobile && npx jest`)・`webViewBridge.supabase.test.ts` の既存の it に差分が無い (`makeDeviceAuth` の第 3 引数の追加を除く)・`auth-transient-retry.ts` の差分がコメントの行だけ (`git grep -n "{}" -- tests/integration/helpers/auth-transient-retry.ts tests/integration-auth-transient-retry.test.ts` に 2.105 の message をいまの挙動として書く行が残らない)・テストに秒数の直書きが無い (auth-js の `lib/constants` と `NATIVE_REBRIDGE_WAIT_MS` から導く。そうでない値は §9.11 の名前付きの定数: `ALREADY_EXPIRED_REMAINING_SECONDS`・`SIGNED_OUT_POLL_STEP_MS`・`SERVER_CLEARS_FIRST_REMAINING_SECONDS`・`TRANSIENT_GATEWAY_STATUS`・`LONG_REMAINING_SECONDS`、H の `ALREADY_EXPIRED_REMAINING_SEC`・`RETRY_WINDOW_MS`・`MS_PER_SECOND`・`REMAINING_HEADROOM_SEC`・`GATEWAY_FAILURE_BODY`。`it.each` の残り秒 (100・60) は既存の it と同じく表の入力) |
| 4 説明 | 2.105 の挙動を書いたコメントを 2.117 に (製品の挙動は変えない) | `src/lib/native-auth-bridge.ts:54-66`・`src/components/native-app/NativeSessionWatcher.tsx:17-27`・`src/app/(main)/MainLayout.tsx:157-167`・`src/app/(auth)/auth/native-bridge/route.ts:29-31`・`apps/mobile/src/lib/webViewAuthMessages.ts:34-36`・`apps/mobile/__tests__/lib/web-view-auth-messages.real-auth.test.ts:12-13`・`apps/mobile/__tests__/lib/web-view-auth-messages.test.ts:472-473`・`:492`・`:540`・`tests/api/auth-mfa-routes.test.ts:215`・`apps/mobile/src/lib/pushNotifications.ts:396`・`src/lib/auth/native-bridge-code.ts:31` (`EXPIRY_MARGIN_MS` の版の記述。値 90 は変えない)・`src/lib/auth/mfa/factors.ts:21`・`src/lib/auth/__tests__/mfa-factors.test.ts:75`・`apps/mobile/src/providers/AuthProvider.tsx:147-154` (「通信が戻れば supabase-js が自動で更新」「約 25 秒かけてやり直す」「約 50 秒」「約 100 秒」を §3 の文に合わせる: やり直せる失敗も 60 秒控えるので更新は控えが切れてから・2.117 の起動は約 25 秒・`getUser()` を省く判断は版に依らず保つ)・`apps/mobile/__tests__/providers/auth-provider.test.tsx:317`・`:321` (it の名前とコメントの「約 50 秒」を同じく。assert は変えない)・`apps/mobile/src/providers/AuthProvider.tsx:18-26` (`clearSession` の説明「`signOut()` はネットワークエラー等で失敗すると `SIGNED_OUT` を発火せず」を、2 つの枝に書き分ける: access token が失効していて更新もできない (オフライン・5xx・失敗の控えの間) ときは `{ error }` を返すだけで保管も残り `SIGNED_OUT` も発火しない (このとき `clearSession` が画面の状態を消す本体)、access token が有効なうちなら、サーバーへのログアウトが失敗しても保管を消して `SIGNED_OUT` を出す。`clearSession` を呼ぶ理由 (自動クリアが効かないことがある) は残す)・`:39` (先頭の表の「上の行の signOut が、通信の失敗 (オフラインなど) で { error } を返した」の行を、§3 の表の同じ行 (改定後。(a) と (b) の 2 つの枝) に合わせる。いまの文は (b) の枝として残し、(a) の枝を足す。この表は §3 が「掃除の順の正」と呼ぶもの)・`tests/integration/security/operator-mfa.test.ts:139` (「@supabase/ssr (0.1.0) の Cookie の名前」を「@supabase/ssr の Cookie の名前」に。版を書かない)・`apps/mobile/src/lib/signOut.ts:88-96` (「サーバーへのログアウトの呼び出しが…失敗すると、例外を投げずに { error } を返し、保管庫のセッションを消さないまま終わる」を 2 つの枝に: access token が失効していて更新もできないときは、サーバーへのログアウトを呼ばずに `{ error }` を返し、保管庫のセッションを消さず `SIGNED_OUT` も届かない (この関数の端末での消去が後始末の本体)。access token が有効なうちなら、サーバーへのログアウトが失敗しても supabase-js が保管を消して `SIGNED_OUT` を出す (端末での消去は重なるが害は無い))・`:172-174` (「scope: "local" でも…それが失敗すると消さない」を「scope: "local" でも、access token が失効していて更新もできないと、サーバーへのログアウトに届かずに `{ error }` を返して消さない」に)・`apps/mobile/app/settings/account.tsx:93-95` (「サインアウトが失敗すると SIGNED_OUT が届かず、AuthProvider がセッションを持ったままになる」を、access token が失効していて更新もできないとき (とサインアウトが例外を投げたとき) は `SIGNED_OUT` が届かず AuthProvider がセッションを持ったままになる、と書き分ける。有効なうちの失敗では supabase-js が保管庫を消して `SIGNED_OUT` を出す。`signOutAfterAccountDeletion` を通す理由は残す)・`apps/mobile/__tests__/settings/logout.test.tsx:173-174` (「supabase.auth.signOut() は通信に失敗すると、保管庫のセッションを消さずに { error } を返し、SIGNED_OUT も出さない」を同じく 2 つの枝に。このテストの偽物の `signOut` が保管を消さずに `{ error }` を返す形は、失効していて更新もできない枝のもの。assert は変えない)・`apps/mobile/app/legal-consent.tsx:77-80` (`afterSignOut` の上のコメントの「ネイティブのログアウトが通信の失敗で済まず、端末にセッションが残ったとき (signOutWithCleanup は失敗のときに端末のセッションを消さない。§6.8) は、今までどおり入口へ移す」を、端末にセッションが残り `getSession()` がそれを返したとき (サインアウトの途中の例外など) は今までどおり入口へ移す、にし、サインアウトが通信の失敗で終わったときの 2 つの枝を足す: access token が有効なうちなら supabase-js が端末のセッションを消して `SIGNED_OUT` を出すので、成功のときと同じく移らない。失効していて更新もできないときは端末のセッションが残るが、`getSession()` も `null` を返すので移らない (同意を待つ扱いのまま。Web の `signOut()` も失敗して form に戻る。`docs/design/mobile/05-auth-session.md` §9.3 の S-29)。`afterSignOut` のコードは変えない)・`apps/mobile/__tests__/app/legal-consent-screen.test.tsx:231` (it の名前の「(ネイティブのログアウトが通信の失敗で済まなかったとき)」を「(サインアウトの途中の例外などで、端末にセッションが残ったとき)」に。assert は変えない)・`src/app/legal-consent/LegalConsentForm.tsx:186-187` (「supabase-js の signOut は、通信に失敗しても例外を投げず { error } を返し、その間はセッションが残る」の「その間はセッションが残る」を、サーバーのセッションは失効しないまま残る (access token が有効なうちなら、この端末の Cookie のセッションは supabase-js が消して `SIGNED_OUT` を出す。失効していて更新もできないときは Cookie のセッションも残る)、に。`{ error }` を失敗として扱うコードは変えない)・`tests/legal-consent-page.test.tsx:571` (it の名前の「(通信失敗。セッションは残る)」を「(通信失敗。サーバーのセッションは残る)」に。assert は変えない)。`signOutOrForgetLocally` と `clearStoredSessionLocally` のコードは変えない。§9.1 の `_signOut` の失敗の行の ①・②・閉包 W-6・M-1・M-4・S-20・S-22・S-29。サインアウトの失敗の記述の母集合は §9.14 の表の下 | 左の各行が、いまの版 (2.117.3) の挙動を現在形で書く (2.105 を「いまの版」として名指しする行が無い。`git grep -n "2\.105" -- src lib apps/mobile tests` の残りは、2.105 との違いを過去の版として書いた行だけ)・製品コードの差分がコメントの行だけ・テストの差分がコメントと it の名前の行だけ (assert は変えない) |

変えないもの (母集合の閉包): §9.1 の import の閉包の「型だけの import」43 ファイルと「コメントだけ」のうち段 4 に挙げないもの (`packages/shared/src/user-scoped-storage.ts`・`src/app/(auth)/auth/native-bridge/route.ts:49`・`src/app/api/cron/process-menu-queue/route.ts`)・§9.1 の auth の呼び出しの閉包の全 317 呼び出し (origin/main `9dd73f23`。#1720 段 C の後の数) のコード (W-* / M-* の「変わる」は auth-js の中の変化で、呼び出し側のコードは変えない)・`src/proxy.ts`・`lib/legal-consent-minor.ts`・`src/app/(main)/MainLayout.tsx` のコード・`NativeSessionWatcher.tsx` のコードと定数・`native-auth-bridge.ts` の定数・`apps/mobile/src/lib/supabase.ts`・`secureSessionStorage.ts`・`apps/mobile/src/lib/webViewBridge.ts`・`apps/mobile/src/components/web/WebViewScreen.tsx`・`apps/mobile/src/lib/webViewAuthMessages.ts` のコード (S-23・S-24 は裁定 G で受け入れる。`webViewAuthMessages.ts` は段 4 のコメントだけ)・`apps/mobile/app/legal-consent.tsx`・`apps/mobile/app/settings/account.tsx`・`src/app/legal-consent/LegalConsentForm.tsx` のコード (段 4 のコメントだけ。S-29 の (b) で入口へ移らないことは害が無いので受け入れる)・`src/lib/auth/sessions/session-claims.ts`・`web-login-context.ts` (W-10)・結合テスト・e2e の Cookie の読み書き (§9.7)・supabase-js の `createClient` のほかの呼び出し口 (`src/lib/db-logger.ts`・`src/app/api/health/route.ts`。§9.1 ⑥)・`supabase/functions/deno.json` (Edge Function の `jsr:@supabase/supabase-js@2.99.1`)・`scripts/`・migration・環境変数・`vercel.json`・`.github/workflows/*`。

検証 (実装・修正の枠。M2 では打たず offload で): `npx tsc --noEmit`・`npm run lint`・`npx vitest run` 全件 (JSON の実数)・`cd apps/mobile && npx jest` 全件・`git diff origin/main...HEAD | grep -n 'as any'` が 0・`npm ci` が lock のまま通る・`npm ls @supabase/supabase-js @supabase/ssr @supabase/auth-js` が 2.117.3 / 0.12.7 / 2.117.3 を 1 つずつ (dedupe されていること)。マージの門: 上の緑 + CI の依存の検査 (Dependency review・`npm audit`) の緑 (`tests/local-ci-workflow-sync.test.ts:84-86`)。本番の確認は §9.8 の 3。

### 9.14 既存の番兵 (契約テスト・走査テスト) の追随表

本設計が足す・変える名前を grep の語にして `tests/`・`scripts/`・`lib/**/__tests__`・`src/__tests__`・`apps/mobile/__tests__` を引いた結果。

| grep の語 | 反応する番兵 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `cookies.set(` / `cookies.remove(` (middleware のモック) | `lib/supabase/__tests__/middleware-maintenance.test.ts:225`・`:436`、`middleware-legal-consent.test.ts:116`、`middleware-legal-consent-api.test.ts:131` | `options.cookies.set` が無くなり TypeError → `set-cookie` の assert が赤 | §9.9 D | 2 |
| `auth-token` + `JSON.parse` | `tests/integration/security/native-bridge-flow.test.ts:173-188`・`operator-mfa.test.ts:163-180`・`tests/e2e/fixtures/auth.ts:140-146` | サーバーは JSON (`raw`) で書くので `JSON.parse` が通る。反応しない (`base64url` なら null → 赤だった。裁定 D) | — | — |
| `cookies: {}` | `src/__tests__/helpers/real-auth-js.ts:67-68` | 0.12.7 では不要 (動くが注記が古い) | 外す | 2 |
| `dist/main/lib/constants` | `src/__tests__/lib/native-session-authjs-thresholds.test.ts:12-16` | 2.117.3 でも解決する (exports 無し)。既存の it は緑 | B を足す | 3 |
| `refresh_token_not_found` / `grant_type=refresh_token` | `src/__tests__/helpers/real-auth-js.ts:33-37`・`:58-62`、`apps/mobile/__tests__/lib/web-view-auth-messages.real-auth.test.ts:173` | URL も応答の形も変わらない。反応しない | — | — |
| `NATIVE_REBRIDGE_WAIT_MS` / `REFRESH_AHEAD_SECONDS` / `SESSION_CHECK_INTERVAL_MS` | `main-layout-signed-out.test.tsx`・`native-session-watcher.test.tsx`・`native-session-authjs-thresholds.test.ts` | 値を変えないので反応しない | — | — |
| `createServerClient` / `createBrowserClient` (import の走査) | `tests/supabase-service-role-client-scan.test.ts:47-49`・`:241-244`・`tests/native-app-tabs-contract.test.ts:93` | import の名前は変わらない。反応しない | — | — |
| `@supabase/ssr` (型だけの import) | `lib/legal-consent-minor.ts:9`・`tests/supabase-service-role-client-scan.test.ts:244` | `import type` のまま。反応しない | — | — |
| `package-lock.json` | `tests/react-types-version-contract.test.ts`・`tests/zod-single-copy-1444.test.ts` | React・zod だけを見る。反応しない (lock の再生成で zod の実体が動いたら `zod-single-copy` が赤 → `--package-lock-only` で zod を動かさないこと) | 赤なら lock を作り直す | 1 |
| `2.105` / `auth-js (2.105)` (コメント) | `tests/api/auth-mfa-routes.test.ts:215`・`apps/mobile/__tests__/lib/web-view-auth-messages.real-auth.test.ts:12`・`apps/mobile/src/lib/webViewAuthMessages.ts:34`・`apps/mobile/src/lib/pushNotifications.ts:396`・`src/components/native-app/NativeSessionWatcher.tsx:18`・`src/lib/native-auth-bridge.ts:55`・`src/lib/auth/native-bridge-code.ts:31`・`src/lib/auth/mfa/factors.ts:21`・`src/lib/auth/__tests__/mfa-factors.test.ts:75` (`git grep -n "2\.105" origin/main -- ':!docs' ':!package-lock.json'` の全件) | 記述だけ。テストは反応しない | 段 4 で現在形に | 4 |
| `ssr 0.1.0` / `(0.1.0)` (コメント) | `src/__tests__/helpers/real-auth-js.ts:67`・`tests/integration/security/operator-mfa.test.ts:139` | 記述だけ | `real-auth-js.ts` は段 2 で外す (§9.7 ⑤)。`operator-mfa.test.ts:139` は段 4 で版を書かない文に | 2・4 |
| `createClient` を `@supabase/supabase-js` から値で import (構文木の走査) | `tests/supabase-service-role-client-scan.test.ts:46`・`:71-90` (`SUPABASE_JS_CLIENT_ALLOWLIST` = `lib/supabase/server.ts`・`src/lib/db-logger.ts`・`src/app/api/health/route.ts`)・`:339` (ssr のクライアントを作るファイルは service_role の取り出し口に触れない。canonical を除く) | `server.ts` は §9.7 ② のあとも `createClient as createAdminClient` を import し、`createServerClient` も import する (canonical なので `:253` の対象外。いまと同じ)。ほかの 2 本は変えない。新設のヘルパ・テストは `tests/` と `src/__tests__/` で走査の外。反応しない | — | — |
| `type CookieOptions` (型だけの import) | `tests/supabase-service-role-client-scan.test.ts:242`・`:244` (走査関数そのものの単体。文字列の入力) | 入力は文字列の定数で、`server.ts` の import の形に依らない。反応しない | — | — |
| `jsr:@supabase/supabase-js` / `esm.sh/@supabase/supabase-js` (Edge Function の版の固定) | `tests/edge-function-dep-pinning.test.ts` (`supabase/functions/deno.json:10` = 2.99.1) | npm の版と別。本改定は `supabase/functions/` を変えない。反応しない | — | — |
| `signOutOnDevice` / `端末からのサインアウト` (本書を走査) | `tests/mobile-sign-out-doc-callers.test.ts:46` | 本改定で `signOutOnDevice` を書く行 (§3 の表の `{ error }` の行・T-22 など) は、呼ばない画面 (`NON_CALLER_SCREEN_NAMES` の名前) を書かず、§3 の行は呼ぶ画面 (設定画面・アカウントの画面) を書く。§5 の該当行はそのまま。反応しない (本書の改定の PR で全件の緑を見る) | — | — |
| 消したモバイルの画面のパスの名指し (本書を走査) | `tests/design-doc-removed-mobile-screens.test.ts` | 本改定は消した画面を名指ししない (本章が挙げるモバイルのファイルは `apps/mobile/src/`・`apps/mobile/__tests__/`・`apps/mobile/package.json`・`app.json` と、§9.1 の auth の呼び出しの閉包が挙げる画面 (`apps/mobile/app/(auth)/`・`onboarding/`・`profile/nutrition-targets.tsx`・`settings/account.tsx`・`(tabs)/settings.tsx`。どれも `tests/helpers/mobile-removed-1598.ts` の一覧に無く、origin/main にある))。反応しない | — | — |
| `docs/design/mobile/*push*.md` の `path:` (本書は対象外) | `tests/design-doc-push-paths-resolve.test.ts` | 対象は `*push*.md` だけ。反応しない | — | — |
| 追随表の逐語の書き換え (「A」を「B」に) の行 (他の設計書を走査) | `tests/design-doc-followup-owned-edits.test.ts` (`OWNED_EDITS` に載せた正典の追随表の行だけを見る) | 本書は `OWNED_EDITS` に無い。§9.15 に足した cross/13b の行は、書き換えの後の文を逐語で決めず (「段 4 の文に揃える」「2 つの枝に書き分ける」)、逐語の突き合わせの形でもない。反応しない | — | — |
| `updateSession` / `@/lib/supabase/middleware` | `tests/next16-proxy-convention.test.ts`・`tests/health-middleware-exemption.test.ts` | 名前も呼び方も変わらない。反応しない | — | — |
| `NEXT_PUBLIC_SUPABASE_URL` (env の走査) | `tests/env-source-scan.test.ts` | proxy の import は変わらない (ssr 0.12.7 の依存は `cookie` だけ)。反応しない | — | — |
| `{}` というメッセージ (コメント。`2.105` の語を含まない) | `tests/integration-auth-transient-retry.test.ts:8-9`・`:99`・`tests/integration/helpers/auth-transient-retry.ts:6-9` | 記述だけ (2.117 の message は `statusText` か `'HTTP <status>'`) | §9.9 C の文に | 3 |
| サインアウトの失敗で保管が残る・`SIGNED_OUT` を発火しない (コメント・it の名前。`2.105` の語を含まない) | `apps/mobile/src/lib/signOut.ts:88-96`・`:172-174`・`apps/mobile/src/providers/AuthProvider.tsx:18-26`・`:39`・`apps/mobile/app/settings/account.tsx:93-95`・`apps/mobile/app/legal-consent.tsx:79-80`・`src/app/legal-consent/LegalConsentForm.tsx:186-187`・`apps/mobile/__tests__/settings/logout.test.tsx:173-174` (コメント)・`apps/mobile/__tests__/app/legal-consent-screen.test.tsx:231`・`tests/legal-consent-page.test.tsx:571` (it の名前)。母集合は表の下 | 記述だけ。いまの記述は、access token が失効していて更新もできない枝 (両版で同じ。S-22) では正しく、access token が有効なうちの `/logout` の失敗 (2.117 は保管を消して `SIGNED_OUT`。S-20・S-29) では古い。`signOut` / `getSession` を偽物にするテストは反応しない (it の名前を変えても assert は同じ) | 段 4 で 2 つの枝を書き分ける (コードは変えない。§9.13 の段 4 の行) | 4 |
| `-code-verifier` (Cookie の名前) | `apps/mobile/__tests__/lib/web-view-cookie-cleanup.test.ts:108-113`・`:131`・`packages/shared/src/user-scoped-storage.ts:58-61` (接頭辞 `sb-`)・`src/app/(auth)/auth/native-bridge/route.ts:50` (`SUPABASE_AUTH_COOKIE_PATTERN` は verifier の名前に合わない) | 2.117 の verifier の新しい名前 (`…-flow-<flow id>-code-verifier`・`…-flows-code-verifier`) も接頭辞 `sb-` で消える。native-bridge が verifier の Cookie を消さないのは従来どおり (セッションの Cookie ではない)。反応しない | — | — |
| `-auth-token` で終わる名前の判定 (`endsWith`) | `tests/e2e/fixtures/auth.ts:143` | 書式が JSON (`raw`) のままで長さも変わらないので、分割の起き方は今と同じ。反応しない | — | — |
| `cookieEncoding` / `cookieOptions` / `storageKey` (Web の Supabase のクライアントの走査) | `tests/native-app-tabs-contract.test.ts:86-97` (`WEB_SUPABASE_CLIENTS` の 3 ファイルに `cookieOptions`・`storageKey` が無いこと) | `cookieEncoding` は `\bcookieOptions\b` にも `\bstorageKey\b` にも合わない。Cookie の名前は変わらない。反応しない | — | — |
| `lib/supabase/client.ts` の import をたどる走査 (env.ts に着かない・env-required に着く) | `tests/env-source-scan.test.ts:614-645` | 新設の `lib/supabase/cookie-encoding.ts` は import を持たないので env.ts に着かない。`client.ts`・`middleware.ts` は今どおり env-required を import する。反応しない | — | — |
| `getSessionForBridge` / `BRIDGE_MIN_TOKEN_TTL_SEC` (本物の supabase-js) | `apps/mobile/__tests__/lib/webViewBridge.supabase.test.ts` | 既存の it は控えに触れない (成功の経路・更新しない経路)。反応しない | H の describe を足す | 3 |
| `createServerClient` / `createBrowserClient` の options を読むモック | `lib/supabase/__tests__/middleware.test.ts:172`・`:190`・`:213`・`:223` (`mock.calls[0][2].global` だけを見る) | `cookieEncoding` を足しても `global` は変わらない。反応しない | — | — |

**サインアウトの失敗の記述の母集合** (上の「サインアウトの失敗で保管が残る」の行): `git grep -n -E '(サインアウト|ログアウト|signOut(\(\))?)(の呼び出し)?(が|は)[^。]{0,20}失敗|SIGNED_OUT (が|も)届か|SIGNED_OUT を発火せず|消さないまま|セッションを消さない|\{ ?error ?\} を返' origin/main -- src lib apps/mobile packages tests` の行と、1 行の正規表現に掛からない書き方の 2 か所 (`AuthProvider.tsx:21-22` は改行で文が切れる・`signOut.ts:174` は「それが失敗すると消さない」)。上の行に挙げたもののほかは、版に依らない記述なので変えない: 端末の処理がサインアウトの失敗のときに何をするかを書く行 (`apps/mobile/src/lib/signOut.ts:47`・`:139`・`:159`・`apps/mobile/app/(tabs)/settings.tsx:248`・`src/lib/account-self-service.ts:187`・`apps/mobile/__tests__/lib/sign-out.test.ts:12`・`:22`・`:358`・`apps/mobile/__tests__/lib/web-view-user-storage-cleanup.test.ts:167`・`apps/mobile/__tests__/settings/logout.test.tsx:8`)、「サインアウトも失敗して `SIGNED_OUT` が届かないとき」を条件として書く行 (`apps/mobile/__tests__/lib/sign-out-push-token-release.test.ts:125`・`apps/mobile/src/lib/pushTokenRelease.ts:217`。失効していて更新もできない枝のまま正しい)、サインアウトと関係の無い行 (`apps/mobile/src/lib/secureSessionStorage.ts`・`src/__tests__/api/cron/app-log-alerts.test.ts`・`tests/admin-finance-refunds-route.test.ts`・`tests/edge-db-logger-supabase-js.test.ts` の、保管庫の読み取りや DB の `insert` / RPC の `{ error }` を書く行)。

### 9.15 他の文書への追随表

本書の PR (設計) は他の設計書を変えない。実装 PR も設計書を変えない (記述のみの不一致は整合ゲートで blocking にせず、オーケストレーターの docs PR で現在形化する決まり)。

| 文書 | 行 | いまの記述 | 直し方 | 誰が・いつ |
|---|---|---|---|---|
| `docs/design/cross/12-operator-mfa.md` | `:97` | 「`@supabase/supabase-js` 2.105.3 (`@supabase/auth-js` 2.105.3)・`@supabase/ssr` 0.1.0・…・Next 15.5」 | 版を 2.117.3 / 0.12.7 に (Next は #1744 の追随と同じ扱い)。auth-js の API の列挙は同じ | オーケストレーターの docs PR (実装のマージ後) |
| 同上 | `:100` | 「auth-js 2.105.3 の `admin.signOut(jwt, scope)`」 | 「auth-js の `admin.signOut(jwt, scope)` (2.117.3 でも同じ: `GoTrueAdminApi.js:67-78`)」 | 同上 |
| 同上 | `:1059`・`:1484` | 「auth-js (@supabase/auth-js 2.105.3 の GoTrueClient._enroll) は … 前置」 | 「2.117.3 でも同じ (`dist/main/GoTrueClient.js:4893-4895`)」を添える。route の `toBareQrCodeSvg` は変えない | 同上 |
| `docs/design/cross/16-auth-history-sessions.md` | `:84` | 「auth-js 2.105.3 の `_updateUser` は … `AuthSessionMissingError` … `_signOut` は … `{ error: null }`」 | 「2.117.3 でも同じ (`:2868-2870`・`:3437-3456`)」を添える | 同上 |
| 同上 | `:92` | 「`@supabase/supabase-js` / `auth-js` 2.105.3 … `@supabase/ssr` 0.1.0 … Next 15.5」 | 版を現在形に | 同上 |
| `docs/design/cross/01-auth-session.md` | — (`:119` の `supabaseAdmin.auth.admin.signOut(sessionId)` は §4.4 のログアウトの route の例) | auth-js・supabase-js・ssr の版の記述は無い (`git grep -n "2\.105\|0\.1\.0\|auth-js\|@supabase/ssr" origin/main -- docs/design/cross/01-auth-session.md` が 0 件)。`:119` は版と関係しない例 (`admin.signOut(jwt, scope)` の形は両版で同じ。§9.1) | 直さない | — |
| `docs/design/cross/14-parental-consent.md` | `:1325-1329` | `import type { createServerClient } from '@supabase/ssr'` の型 | 変わらない (0.12.7 も同じ名前・同じ戻り値)。直さない | — |
| `docs/design/mobile/01-architecture.md` | 「90 秒 … `EXPIRY_MARGIN_MS`」の行 | 値は 2.117.3 でも 90 秒 | 直さない | — |
| `docs/design/mobile/CLAUDE.md` | — | 版の記述は無い | 直さない | — |
| `docs/design/mobile/01-architecture.md` | `:188` | 「supabase.auth.signOut() → ネイティブ SecureStore のトークン削除 (失敗したら端末だけで消し、画面の状態も消す)」 | 直さない (`signOutOrForgetLocally` のコードは変えず、失敗のときの端末での消去は残る。2.117 では、access token が有効なうちの失敗なら supabase-js も保管を消し、失効していて更新もできないときは両版とも消さないので、端末での消去が後始末の本体。§9.1 の `_signOut` の失敗の行の ①・②) | — |
| `docs/design/cross/16-auth-history-sessions.md` | `:358`・`:1365` | モバイルの再設定の画面の `exchangeCodeForSession` は client が implicit で `code_verifier` が無く交換できない | 直さない (2.117 も `flowType: 'pkce'` のときだけ verifier を書き・求める。§9.1 の PKCE の行・閉包 M-5) | — |
| `docs/design/mobile/01-architecture.md` | `:173` | 「更新に失敗したときは、残りが 150 秒以上なら現在のトークンで code を発行してもらい、足りなければ…直接 URL を表示する」 | 文は 2.117 でも正しいので残し、「auth-js 2.117 では、60 秒以内に同じ refresh_token の更新が失敗していると、`refreshSession` は `/token` を呼ばずに控えた失敗を返すので、これも『更新に失敗した』に入る (`docs/design/mobile/05-auth-session.md` §9.6 ① の bridge の行・S-24)」を添える | オーケストレーターの docs PR (実装のマージ後) |
| `docs/design/cross/13b-legal-consent-mobile.md` | `:991-992` (§6.6.11 の正典コードの、`afterSignOut` の上のコメント) | 「ネイティブのログアウトが通信の失敗で済まず、端末にセッションが残ったとき (signOutWithCleanup は失敗のときに端末のセッションを消さない。§6.8) は、今までどおり入口へ移す」 | 実装の段 4 が `apps/mobile/app/legal-consent.tsx:77-80` に書いた文に揃える (§9.13 の段 4 の行) | オーケストレーターの docs PR (実装のマージ後) |
| 同上 | `:1307` (§6.8 のエラー表の「「同意しない」の後のネイティブの `signOut` が通信の失敗で `{ error }` を返す」の行)・`:256` (S4 の末尾の「ネイティブのログアウトが通信の失敗で済まなかったとき (端末にセッションが残る) は §6.8 の行」)・`:1595` (§8 の Q-8) | 通信の失敗のサインアウトでは端末のセッションが残り、同意画面の `afterSignOut` が入口へ移して、ゲートが同意画面 1 つに畳み直す (Q-8 は「通信が戻ってから「同意しない」をもう一度押せばログアウトできる」) | 2 つの枝に書き分ける: access token が有効なうちの失敗では、supabase-js (auth-js 2.117) が端末のセッションを消して `SIGNED_OUT` を出すので、成功のときと同じく `signed-out-notice` で「閉じる」を出す (Web は §6.8 の最後の行「Web の `signOut` だけが通信の失敗で終わる」と同じく form に戻る)。失効していて更新もできないときは端末のセッションが残るが、`afterSignOut` の `getSession()` も `null` を返すので入口へ移らず、同意を待つ扱いのまま (Web の `signOut()` も失敗して form に戻るので、通信が戻ってからもう一度押せる)。入口へ移るのは、端末にセッションが残り `getSession()` がそれを返したとき (サインアウトの途中の例外など)。本書の §9.3 の S-29 | 同上 |
| `docs/design/cross/16-auth-history-sessions.md` | `:1289-1295`・`:1356` | `readSessionAuth` は「読めなければ null」、`requireSessionUser` の `AuthError` → 401・それ以外 → `internalError` | 直さない (2.117 で期限切れの token の `getClaims` が `{ error }` になり、`readSessionAuth` の「読めなければ null」→ 401 の契約どおりになる。2.105 で `Error` が `internalError` に落ちていたのは契約の外の挙動。閉包 W-10) | — |
| `.github/dependabot.yml` / Dependabot #1590 | — | #1590 (2026-10-14 作成) は 2026-10-16T05:07Z (UTC) にマージされずに閉じている。本書の実装の PR #1841 (2026-10-17 マージ) より前 | 直すものは無い (閉じる操作も要らない) | 済み |

### 9.16 受入 (デプロイ後整合ゲート) の項目

1. 本番の `/home` を、デプロイ前からログインしているブラウザで再読み込みしてログインが続く (§9.8 の 3 (a)〜(d))。
2. 更新前のビルド (2.105) のアプリの WebView でブリッジ → ホームが開き、1 時間以上バックグラウンドに置いて戻ると読み込み直される (S-4。`SIGNED_OUT` の遅れが見えないこと)。
3. Vercel のランタイムログに `@supabase/ssr` の warn (非推奨の `get` / `set` / `remove`・`setAll` 無し・base64 の復号の失敗) が 0 件。
4. `npm ls` で `@supabase/*` が 1 コピーずつ (apps/mobile に入れ子が無い)。
5. Dependabot #1590 が閉じている。
6. デプロイ後に、ふつうのブラウザで Google ログインとパスワードの再設定のメールのリンクが通る (PKCE の verifier の Cookie。S-21。実装の枠の機械検査は §9.9 E-6・E-7)。
7. デプロイの前に開いたタブ (旧バンドル) を残したまま、別のタブで更新が走ったあとに旧タブを前面に戻しても、ログインが続き Cookie が消えない。本番の `sb-<ref>-auth-token` の値は `base64-` で始まらない (§9.8 の 3 (b)・(c)。S-25)。

### 9.17 未解決

- Q-1 (決着): `package-lock.json` の再生成は、テスト用の機械 (offload の行き先) で版を名指しして流し、3 ファイルを持ち帰る (§9.13 の段 1 のコマンド)。2026-10-17 に流した実測で、差分は段 1 の完了条件 (1) の 13 項目と一致した (`@supabase/*` 8 項目・`cookie`・`@types/ws` の `dev` の印・`ramda` の削除と、2 つの宣言)。版を名指ししない再生成は `^2.117.3` の中の最新 (同日 2.118.0) を選ぶので使わない。
- Q-2: middleware の `setAll` で `NextResponse.next({ request })` を作り直す形 (Supabase の Next.js の例。同じ要求の Server Component が更新後の Cookie を読める) は、本改定では採らない (裁定 E)。要るなら別の Issue で、`withLegalConsentPendingHeader` (`:89-98`) との順番と `tests/middleware-csp.test.ts` の作り直しの前提を含めて設計する。
- Q-3: 失効から `SIGNED_OUT` までの最大 90 秒の間 (と、サーバーの応答が先に Cookie を消して `SIGNED_OUT` が出ないとき (WebView の S-27・裁定 H の読み込み直しまでの間と、ふつうのブラウザの S-28・裁定 H2 の次の画面の移動までの間))、個々の画面の 401 の扱い (§8 の 5 つ目) は従来どおり。短くするなら `MainLayout` が `expires_at` を見張る案 (裁定 B) だが、見張りの `null` の送信で足りるかを本番の観察 (S-4 の読み込み直しの遅れ) で確かめてから決める。
- Q-4: apps/mobile の本物の supabase-js を使うテスト 3 本 (§9.9 G) が 2.117 の lock 無しで順番の違いを出すか。実装の全件 (`npx jest`) で確かめ、赤ならその it の意味を保って直す。
- Q-5: ssr 0.12 の `maxAge` 400 日 (0.1.0 は 1,000 年) で、400 日以上開かなかった利用者の Cookie がブラウザから消える時期が変わるか。ブラウザは 0.1.0 の値も 400 日で切っていた (Chrome の上限) ので、実質は変わらないと見る。
- Q-6: 本番の access token の寿命 (GoTrue の JWT の expiry) は、本章では失効の時刻 E として扱い、値に依らない (§6.1・§7 の「1 時間」は GoTrue の既定 3,600 秒を前提にした #1038 からの記述)。本番の値は §9.8 の 3 (b) の確認 (更新が走るまでの時間) で併せて見る。
- Q-7: Cookie の書式を ssr の既定の `base64url` へ切り替えるのは別の Issue。前提は、本改定 (`raw`) の版が本番に出て、0.1.0 + auth-js 2.105.3 の旧バンドルを持つタブが残らないと見なせること (skew の対策 `deploymentId` を入れるかも含めて、その Issue で決める)。切り替えの PR は `SUPABASE_COOKIE_ENCODING` を 1 か所変え、§9.9 E-4・F-1 の期待を改め、結合テスト・e2e の `JSON.parse` の読み取りを `base64-` も読む形にする (`base64-` を読む道具はその Issue で作る)。切り替えた後に本改定の版へ戻しても、0.12.7 は `base64-` を読める。
- Q-8: S-23・S-24 の窓 (通信の回復から最大約 90 秒、bridge が通らず WebView が Web のログイン画面になる) を縮める apps/mobile の対処は、本改定に入れない (裁定 G)。案: AuthProvider の `TOKEN_REFRESHED` を受けて、bridge 無しで開いた (`resolveBridgeCode` が null だった) WebView と、`session-expired` に `no-session` で答えた WebView を 1 回だけ読み込み直す。apps/mobile の製品コードの新しい挙動で、届くのは次の EAS Build からなので、要るなら別の Issue で設計する。
- Q-9: ふつうのブラウザで、サーバーの応答が先に Cookie を消して `SIGNED_OUT` が出ないとき (S-28) に、user-scoped の localStorage を消して `/login` へ移す仕組みは、本改定に入れない (裁定 H2)。サーバーのセッションが消えたときの 403 の経路で両版に既にある帰結で、2.117 はその起き得る間を失効の後 (最大 90 秒) まで延ばすだけ。案は 2 つ: (1) `MainLayout` (ふつうのブラウザ) が `getSession()` を見張り、`{ session: null, error: null }` (保管が空) を見たら `treatAsSignedOut` する (2.117 の「失効後・控え中」の `{ session: null, error }` (保管は残る) とは `error` で分ける) (2) ふつうのブラウザのログイン画面 (`/login`) の描画で user-scoped の localStorage を消す (前の利用者の値が次の利用者に残るのを、どの経路でも止める。WebView のログイン画面は再ブリッジの途中でも出る (S-23) ので消さない §6.3)。(1) は `MainLayout` の 2 つ目の時計 (裁定 B と同じ形)、(2) はログイン画面の新しい挙動で、どちらも 403 の経路も直す。要るなら別の Issue で設計する。
