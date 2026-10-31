# Sign in with Apple (iOS のネイティブのログイン・Web のログイン・退会のときの失効)

| 項目 | 内容 |
|---|---|
| 版 | v1.14 (2026-11-01) |
| 状態 | 設計ゲート通過 (2026-10-23)。段 A1 (#1989)・A2 (#1995)・B (#1994) は main に入った (スイッチは off)。段 D (法務) は PR #1997 (`3193a2fa`) で施行日 2026-11-01 に main に入り公開した (版 `v2026.4`。同じ版に cross/21 の公開レシピの作者名の表示の文も入った) |
| 範囲の正本 | Issue #1139 と、その本文が該当箇所に挙げる `MOBILE_TODO.md`。Issue の本文は「EAS Build / Submit・本番審査の提出・Pass1〜10 の品質検証が未完了」を述べ、該当箇所に `MOBILE_TODO.md:159-217` を挙げる (本文に Sign in with Apple の語は無く、コメントは無い)。Sign in with Apple を求めているのは `MOBILE_TODO.md` の Pass 3「認証/セッション」(`:186`)・Pass 10「ストア要件 (iOS)」(`:193`) と「提出前に片付けるブロッカー」の 5 (`:41`。作業計画 T43)。本書はこの 3 か所の Sign in with Apple の部分を扱う |
| 土台 | origin/main `9575aa99` (2026-10-23)。本文の file:line はこの版の事実 (v1.2 の時点の origin/main `b6fa5d65` までの差分は、本書が名指すコードとテストに触れていない。v1.4 の時点の origin/main `0c86c3dd` までの差分も同じで、設計書の差分 (cross/20 の F-19・F-51、billing/01 の追随表の行番号、billing/03) は本書が指す行ではない。v1.6 の時点の origin/main `62425ec8` までの差分 (組織の一覧の API と画面・Edge Function 1 本・設計書の行の置き換え) も、本書が名指すコード・テスト・設計書の行に触れておらず、行の数も変えていない。v1.8 の時点の origin/main `86427394` までの差分 (通知の行き先の関数 `apps/mobile/src/lib/notificationRoute.ts` とそのテスト・`docs/design/mobile/03-push-notification.md` の 1 行) も同じで、`apps/mobile/app/(auth)/`・`apps/mobile/src/components/`・`apps/mobile/src/theme/`・`apps/mobile/__tests__/auth/` には差分が無い。v1.10 の時点の origin/main `c5e57b0d` までの差分 (#1979: API の失敗の本文を日本語の固定の文にする共通の関数 `src/lib/api/error-responses.ts` と走査の見張り `tests/api-error-japanese-scan.test.ts`・`tests/helpers/api-error-japanese-scope.ts`・`tests/helpers/api-error-text-scan.ts`、`/api/admin/organizations`、設計書の行の中身の置き換え (行の数は変えない)) も、本書が名指すコード・テスト・設計書の行に触れていない。新しい見張りは本書の新設の route を走査するので §17 に行を足した。v1.11 の時点の origin/main `40105bee` までの差分 (#1980: お知らせの作成と比較の集計の手動実行を運営の監査ログに記録し、`tests/admin-mutation-audit-coverage-1571.test.ts` の走査を `src/app/api` の 4 つのディレクトリの外へ広げた。`src/app/api/announcements/route.ts`・`src/app/api/comparison/trigger/route.ts`・そのテスト・設計書と要件の文書の行) は、`src/app/api/announcements/route.ts` の行を 6 行ずらした。本書でその行を指すのは §5.2 の S-25 だけで、そこは origin/main `40105bee` の行 (`:95-97`) に直した。広げた走査は本書の新設の route も読むので §17 に行を足した) |
| 関連の正典 | `docs/design/cross/01-auth-session.md` §3.1 (Apple Sign In = Phase 1・iOS App Store 必須)・§3.3 (退会のときの IdP 側の revoke)・`docs/design/mobile/05-auth-session.md` (Google ログイン・セッションの保管)・`docs/design/cross/16-auth-history-sessions.md` §11.5 (パスワードの無い利用者 = Google / Apple だけ)・`docs/design/cross/13b-legal-consent-mobile.md` (ログインの後の同意のゲート)・`docs/design/cross/20-terms-privacy-text.md` (委託先の表・主張の表・版) |
| 実装の範囲 | 段 A1 サーバ (表・交換と失効の lib・API・退会の段階)・段 A2 モバイル (iOS のネイティブのシート)・段 B Web (OAuth)・段 D 法務 (プライバシーポリシーの委託先と版)。§15 |

改定履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-23 | 初版 (A 型・4 相。要件行列・シナリオ 24 本・構造裁定・表 3 点・正典コード・テスト・段分け・番兵と他の文書の追随表) |
| v1.1 | 2026-10-23 | 周 1 の網羅性の反映: §17 に退会の番兵 (`tests/account-deletion-email.test.ts`・`src/__tests__/api/account/delete-missing-env.test.ts`・`tests/billing-account-deletion.test.ts`・結合テスト 3 本)・`signInWithOAuth` をモックする画面のテスト 2 本 (`apps/mobile/__tests__/auth/turnstile-screens.test.tsx`・`tests/signup-minor-notice.test.tsx`)・`tests/auth/web-login-context-source-scan.test.ts` の行を足し、§14.1 に `expo-apple-authentication`・`expo-crypto` の正典のモックを書いた。§18 に `cross/16`・`mobile/07`・`billing/01`・`docs/operations/auth-protection.md` の行を足し、`mobile/05`・`cross/13b` の行に `routeAfterSignIn` の場所を名指す行を足した。§18.1 (コードの注の追随) を新設し、§15 の段 A2・B の触るファイルに足した。§21 Q-9 の文を直した |
| v1.2 | 2026-10-23 | 周 1 の審査の反映: (1) 退会の段階 `apple_revoke` の正典コードで `createAppleClientSecret` を行ごとの `try` に入れ、秘密鍵が壊れていても投げずに `failed` に数えて `warn` にした。route の本体は `secret_failed` (500・`step: 'client_secret'`) を返す。§7.1・§7.3 (b)・§9.2・§9.3・§12.2・§12.4・§14.2 に追随 (2) 段 D の依存を「A2 のマージ後」に直した (委託先と主張の表の evidence が A2 の新設ファイルを指すため) (3) Web の環境変数 5 つの登録 (`src/lib/env.ts`・`.env.example`・`env.test.ts`) を段 A1 に寄せ、`env.test.ts` の `publicNames` は導出で足す一覧が無いことを §11.7・§17 に書いた (4) Web のボタンのロゴを、Apple の文書にある logo の画像の URL から取る PNG (`public/auth/apple-logo-on-black.png`) にし、取り方 (コマンド)・確かめ方 (テスト) を §10.2・§11.6・§14.2 に書いた (F-14 に一次情報) |
| v1.3 | 2026-10-23 | 周 2 の網羅性の反映: (1) §17・§8.1・§14.2・§15 の段 A1 に `tests/integration/security/auth-users-fk-on-delete.test.ts` (D0。auth.users を指す外部キーの「表.列」と `EXPECTED_ACTIONS` の一致) を足し、`EXPECTED_ACTIONS` に `apple_sign_in_tokens.user_id` → `CASCADE` を足す直し方を書いた。同じ型の結合テスト (`db-privilege-hardening` の T-1・`select-columns-exist`) を「確認だけ」の行で足した。(2) §7.1 全パターン表に S-12 (サーバの秘密なし)・S-13 (交換の失敗)・S-24 (nonce の不一致)・S-23 (iPhone の設定で停止したあとの再ログイン)・S-20 (Web の 2 回目) の行を足し、Web の「同じメール」の行を `email` / `google` と名指した (S-4・S-5 の Web 版)。(3) 表紙の「範囲の正本」・§2・§3 の R-11 / R-12 の根拠・§18 の `mobile/CLAUDE.md` の行・§21 Q-12 を、Issue #1139 の本文が Sign in with Apple を名指しておらず、名指しているのは本文が該当箇所に挙げる `MOBILE_TODO.md` の Pass 3・Pass 10・ブロッカー 5 である事実に合わせた |
| v1.4 | 2026-10-23 | 周 2 の審査の反映: 段 D (版 `v2026.4`) は版を上げる改定なので、cross/20 §9.3 の「版を上げる改定すべて」の行が求める §9.4 の 2 (施行日の前に運営のお知らせに改定の予告を載せる) の工程を入れた (公開中のプライバシーポリシー第18条 1 項・利用規約第24条 1 項が施行日の前の掲載を約束している)。§21 に Q-13 (選択式。予告して施行日を待つ / 予告なしで公開し cross/20 §9.3 の除外に `v2026.4` を書き足す) を足し、§11.8 に (i) 改定の予告を新設し、§0.4・§0.5・§3 R-16・§4 S-25 (シナリオ 25 本)・§5.2・§7.1・§7.2・§7.3 (d) (段 D の公開の工程)・§9.6・§11.8 (f)・§15 の公開の順と段 D の行・§18 の cross/20 の行・§19.3・§19.4・§20 の 6 を追随させた |
| v1.5 | 2026-10-23 | 周 3 の網羅性の反映: (1) §4 にシナリオ S-26〜S-31 (退会・行あり・秘密なし / 秘密鍵が壊れている、Web・provider 無効、Web・refresh token を保管できない (Services ID 無し・`provider_refresh_token` 無し)、`identityToken` が無い、名前の保存の失敗) を足し 31 本にし、§5.2 のトレースに足した。§4 S-12 の参照を S-16 (行なしの退会) に直し、§5.2 S-13 の順の記述 (名前 → 登録 → 振り分け) を直した (2) §7.1 に シートの取り消し (S-7)・`identityToken` 無し・名前の保存の失敗・Web の provider 無効・Web の Services ID 無し / `provider_refresh_token` 無し・WebView のタブ (S-21)・中継のアドレスへのメール (S-22) の行を足した (3) §7.3 (a) に名前の保存の成否の行、§7.3 (b) の `none` に Web の保管しない条件の行を足した (4) §14.2 に `packages/shared/src/apple-sign-in.test.ts`・`src/__tests__/lib/auth/apple/schemas.test.ts` (段 A1)・`src/__tests__/lib/auth/apple-sign-in-flag.test.ts` (段 B) を足し、§15・§16 の本数を直した (5) §17 に設定画面のテスト 2 本 (確認だけ) を足した (6) §18 に `marketing/01`・`cross/08`・`mobile/02`・`cross/12` の行を足し、`ENV_SETUP.md` をリポジトリ直下のものと明記した。§21 に Q-14 を足した |
| v1.6 | 2026-10-23 | 周 3 の審査の反映: 退会の段階 `apple_revoke` に段階全体の時間の上限 `APPLE_REVOKE_TOTAL_BUDGET_MS` (3 秒) を置いた。退会の route の `maxDuration` 60 秒から Storage の掃除の上限 45 秒と完了メールの待ちの上限 5 秒を引いた 10 秒のうち 3 秒を Apple に充てる (§13.1 の計算。`config.test.ts` が和を確かめる)。締め切りは段階の入口で決め、試行ごとの待ちは `APPLE_API_TIMEOUT_MS` と残りの短いほう (`revokeAppleRefreshToken` に `timeoutMs` を足した)。締め切りを過ぎた行は Apple を呼ばずに `failed` に数えて `warn` を 1 回出す。§0.5・§3 R-8・§4 S-15 とシナリオ S-32 (2 行・Apple が応答しない。32 本)・§5.1・§5.2・§6 裁定 2 と帰結・§7.1・§7.3 (b)・§9.3・§11.2・§11.3・§11.4・§12.4・§13.1・§14.2・§16・§21 Q-2 を追随させた。`APPLE_REVOKE_ATTEMPTS` の注と §13.1 の根拠 (「5xx ならもう 1 回」「応答を待たせない」) を、コードの事実 (失敗の種類を区別せずやり直す・やり直しも上限の中だけ) に合わせた。波及の掃除: §7.3 (b) に既存の挙動の行 (秘密なし S-26・表を読めない) とガード (締め切りの前) を足し、§7.1 に表を読めないの行を足した。§9.3 の既定の名前 `defaultAccountDeletionAppleRevocation` (正典コードに無い) を `createAccountDeletionAppleRevocation({ admin: () => admin })` に直した |
| v1.7 | 2026-10-23 | 周 4 の網羅性の反映: (1) §7.1 に Web 新規登録の行 (スイッチ無し・provider 無効・同じメールの `email` / `google`・同じ `sub` の `apple`) を足した (2) §13.1 に `APPLE_LOGO_SRC`・`APPLE_SIGN_IN_TITLES`・`APPLE_CALLBACK_PROVIDER` (§16 の新設と一致させた) と、`MS_PER_SECOND`・テストの中の `PNG_SIGNATURE`・`IHDR_WIDTH_OFFSET` / `IHDR_HEIGHT_OFFSET` を足した (3) §14.1 に S-31 (名前の保存の失敗でも `signed_in`) の it、§14.2 の route のテストに `store_failed` (500・`step: 'store'`) の it、`tests/signup-legal-consent.test.tsx` にスイッチ無しの it を足した (4) §14.4 (新しい it を置かないシナリオと確かめ方: S-2・S-4〜S-6・S-21・S-22・S-25・S-28) を新設し、§20 に 9 (Web のスイッチの後に Apple の画面へ行く。S-28) を足した (5) §16 に migration と対の戻し口の行を足した (6) §5.2 S-25 の出典を `src/app/api/announcements/route.ts:89-91` (`is_public`・`published_at`) と行の中身まで書いた。波及の掃除: §10.2 の部品の節の参照を §11.6 に、§11.2 の注の `tests/apple-sign-in-config.test.ts` (§14 に無い名前) を `src/__tests__/lib/auth/apple/config.test.ts` に直した |
| v1.8 | 2026-10-23 | 周 4 の審査の反映: iOS の Apple のボタンの高さ 48pt は、Google のボタンの高さの見積もり (`paddingVertical` 14 × 2 + 文字 20) が枠 (`borderWidth` 1 × 2) を数え落としたもので、実際の Google のボタン (中身なりで約 50〜52pt) より低く、R-1 (Google と同じ大きさ以上) を満たしていなかった。見積もりに頼らない形に改めた: (1) 定数を `AUTH_PROVIDER_BUTTON_MIN_HEIGHT` = 56 (Apple と Google のボタンの下限の高さ) に改め、Google のボタン 2 つ (`login.tsx`・`signup.tsx`) に `minHeight` として足す (2) Apple のボタンの高さは、同じ画面の Google のボタンの `onLayout` で測った高さ (下限 56) にする (`useAuthProviderButtonHeight`。端末の文字の大きさの設定で Google のボタンが伸びたときも同じ高さ)。§0.2 に F-17 (Google のボタンの組み立てと文字の大きさの設定) を足し、§1・§3 R-1・§4 S-33 (33 本)・§5.2・§7.1・§7.2・§7.3 (e) (新設)・§10.1・§11.5 (部品・`login.tsx` と `signup.tsx` の差分)・§13.1・§14.1 (it の追加・改名と「props を写す偽物」のモック)・§14.4・§16・§20 の 1 を追随させた。同じ型 (利用者の文字の大きさの設定で Apple のボタンが Google より低くなる) を Web にも見つけて直した: Google のボタンを `h-14` (rem。ブラウザの文字の大きさの設定で変わる) にする案をやめ、Apple と同じ px の定数 `APPLE_SIGN_IN_BUTTON_HEIGHT_PX` を `style.height` に渡し、`py-6` を `py-0` にする (§7.1・§7.2・§10.2・§11.6・§13.1・§14.2・§20 の 5)。波及の掃除: §10.2 の Apple のボタンの高さの記述 (`h-14` ではなく `style` の px)・F-6 の `signup/page.tsx` の行 (367-390・545-556 はファイルの外。正しくは 47-69・223-236) と `login/page.tsx` の行を直した |
| v1.9 | 2026-10-23 | 周 5 の網羅性の反映: (1) Web で Apple の画面で取り消したときを §4 (S-34。34 本)・§5.2・§7.1・§7.3 (b)・§12.3・§14.4 に足した (既存のコールバックの分岐 `src/app/(auth)/auth/callback/route.ts:37-46` が `/login?error=` へ送る。本書のコードは通らない) (2) §17 に、本書が触る画面・コールバックを描く・読む既存のテスト (`apps/mobile/__tests__/auth/login.test.tsx`・`signup.test.tsx`・`tests/auth-link-notice.test.tsx`・`tests/api/auth-login-context.test.ts`・ソースを読む走査 5 本) の行を足した (3) §17 の「版の直書き」の行の例 (`src/__tests__/api/cron/push-outbox.test.ts`) は `v2026.3` を含まない。origin/main の `src/`・`tests/`・`apps/`・`packages/`・`scripts/` で `v2026.3` を含むのは `packages/shared/src/legal-versions.ts` だけなので、行を「直書きは無い (確認だけ)」に改め、§11.8 (h)・§15 の段 D の行を追随させた (4) §16 の載せ方 (export するものと、§5.2 のトレースが名指すモジュールの中の関数) を書き、モバイルの `saveAppleFullName` ほかトレースが名指す関数・`APPLE_AUTHORIZATION_API_PATH`・export する型・route の export (`runtime`・`dynamic`) の行を足した |
| v1.10 | 2026-10-23 | 周 5 の審査の反映: Web で Apple の画面を取り消したとき (S-34) に、既存のコールバックの分岐が Apple・GoTrue の英文 (`error_description`。無ければ `user_cancelled_authorize` などの `error`) をログイン画面の赤いバナーにそのまま出していた。段 B で `/auth/callback` の `?error=` の分岐を、`?provider=apple` のときだけ日本語の固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE` に替える (`appleCallbackErrorMessage`。`src/lib/auth/apple/web-callback.ts`。ほかの provider は今までどおり)。`?provider=apple` が `error` と一緒に届くことは GoTrue のソースで確かめ、§0.2 に F-18 として足した。§21 Q-7 を選択式 (既定 (a) 固定の文 / (b) 取り消しは何も出さない) にし、§0.5・§3 (R-19 を新設)・§4 S-34・§5.1・§5.2・§7.1・§7.2・§7.3 (b) と (f) (新設)・§9.5・§10.2・§11.6 (正典コードと route の差分)・§12.3・§13.1・§14.2 (it の追加)・§14.4 (S-34 を it の受け持ちへ)・§16・§17・§20 の 10 を追随させた。origin/main の突合: `c5e57b0d` (#1979) が足した走査の見張り `tests/api-error-japanese-scan.test.ts` は `src/app/api` の route の `NextResponse.json` の本文の文を読むので、新設の route (§11.4) の応答を、本文を引数で受ける小さな関数 `json()` から `NextResponse.json` を直接呼ぶ形に改め、見張りが文を読めるようにした (R-18。文と status は同じ)。§17 に行を足した |
| v1.11 | 2026-10-23 | 周 6 の審査の反映: (1) 公開の工程 (§7.3 (d)) で、スイッチを on にする前に、サーバの秘密 (iOS は `APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY`、Web はそれと `APPLE_SIGN_IN_SERVICES_ID`) が本番のデプロイに効いていることを確かめる工程 (§19.3 の「スイッチの前の確認」) を入れた。秘密が無い・効いていない・壊れている間に Apple で入った人は refresh token の行が残らず、退会のときに失効されないため (R-8)。確認は Vercel の名前の一覧とデプロイの時刻、EAS の preview にだけスイッチを入れた内部配布のビルドでオーナーが 1 回入って本番に行ができること・ログに `not_configured` と 500 が無いことで行う。§7.3 (d) に状態 `secrets_verified` と行を足し、§0.4・§0.5・§3 R-8・§4 S-12 / S-29・§5.1・§7.1・§9.6・§11.5 (`env.example` の注)・§11.7 (`NEXT_PUBLIC_APPLE_SIGN_IN` の説明)・§13.2・§14.3・§15 の公開の順・§18 (`docs/operations/` の行)・§19.3・§19.4・§20 の 4 と 7・§20 の 11 (新設) を追随させた (2) §17 に `tests/ai-consent-provider-inventory.test.ts` の行を足した (§11.2 の `https://appleid.apple.com` の文字列が送信先の走査に入り、`NON_AI_HOSTS` に無いと段 A1 で赤)。§11.2 に注を、§15 の段 A1 の触るファイルと完了条件に足した。同じ型 (本書が足すファイル・route・テスト・migration を走査の対象に入れる番兵) を洗い直し、`tests/heavy-unit-test-timeout.test.ts` (route のテストの読み込みの置き場)・`tests/migration-file-version-integrity.test.ts` (番号を確定したときの 5 か所)・`tests/admin-mutation-audit-coverage-1571.test.ts`・`tests/next15-async-request-api-scan.test.ts`・`tests/business-info-legal-pages.test.ts` (確認だけ) の行を足した (3) origin/main `40105bee` に追随した (表紙の土台・§5.2 の S-25 の行番号) |
| v1.12 | 2026-10-23 | 網羅性の反映: (1) §0.2 F-12 の `packages/shared/src/legal-versions.ts` の行番号を origin/main の `LEGAL_DOCUMENTS` の 2 行 (`:59-60`) に直した (§17 の「版の直書き」の行と同じ) (2) §7.3 (b) の「秘密鍵が壊れている」行のガードを、正典コード (§11 の `revokeRow` は config ありのときだけ呼ばれ、入口で `remainingMs() <= 0` なら `not_attempted` を返してから `createAppleClientSecret` を作る) に合わせて「秘密あり・締め切りの前」にし、§5.2 の S-27 のトレースに行の入口の残りの確認を足した |
| v1.13 | 2026-10-24 | 設計ゲート通過の後のオーケストレーターの直し: ファイル名を `08-sign-in-with-apple.md` に改め (`06-push-send.md` と番号が重なるため。Q-9)、自己参照 (`mobile/06` の 6 か所を含む) を置換し、`mobile/CLAUDE.md` の表に行を足した。§15 と §0.4 の migration の当て方を、段 A1 のマージで CI が当てる形に直し、段 A1 の完了条件に、表がまだ無いときも退会が止まらないことを足した。§21 の Q-1・Q-7・Q-13・Q-14 にオーナーの選択 (2026-10-23) を書いた |
| v1.14 | 2026-11-01 | 段 D の公開の後の現在形化 (製品の挙動は変えない): 状態の行 (段 D は PR #1997 で 2026-11-01 に公開)・F-12・§0 の Q-13 の行・§7.2・§9.6・§11.8 (d)・§14.2 の T-35 に、同じ版 `v2026.4` に cross/21 §7.12 の公開レシピの作者名の表示の文 (第8条 3 項・第9条とその見出し。主張の表 +7) も入り、`LEGAL_CLAIM_COUNT` が 433 になったことを書いた |

## 0. 範囲・前提・分冊判定

### 0.1 範囲

- App Store Review Guideline 4.8 (Login Services): 第三者のログイン (Google など) で主たるアカウントを作る・認証するアプリは、同等の選択肢として「名前とメールアドレスに限った取得・メールアドレスを隠せる・広告目的の追跡をしない」ログインを置く。本アプリは Web とモバイルに Google ログインがあり (`src/app/(auth)/login/page.tsx:79`・`signup/page.tsx:56`・`apps/mobile/app/(auth)/login.tsx:108`・`signup.tsx:41`)、Apple の実装は 0 件 (`expo-apple-authentication`・`signInWithIdToken`・`provider: 'apple'` の呼び出しは無い。あるのは設定画面の表示名 `providerLabel` の `apple` の分岐だけ: `src/app/(main)/settings/account/page.tsx:59`・`apps/mobile/src/components/settings/AccountCredentialsSection.tsx:30`)。
- 本書が決めるもの: (1) iOS のネイティブの入口 (ログイン・新規登録) とボタン (2) Web の入口とボタン (3) 認証の流れ (Supabase の呼び方・nonce・コールバック)・日本語の固定の文 (4) 既存のアカウントとの関係・初回だけ来る名前・メールの中継 (5) 退会と Apple のトークンの失効 (要る。手順を §9.3) (6) 設定が無いとき (オーナー作業の前) の画面 (ボタンを出さない) (7) 本物の Apple に繋がないテスト (8) オーナーの作業 (Apple Developer・Supabase・Vercel・EAS) とエージェントの作業の分け。
- 本書が決めないもの (範囲外): Android の Apple ログイン (§21 Q-3)、Apple のアカウントの連携を設定画面から外す操作 (退会でだけ失効させる。§21 Q-4)、WebView の中の Web のログイン画面 (モバイルのログインはネイティブの画面。§0.2)、LINE などほかの IdP。

### 0.2 前提の事実 (origin/main `9575aa99`。F-8 には段 A1 の後の origin/main `33eaa0eb` の行を添えた)

| # | 事実 | 根拠 |
|---|---|---|
| F-1 | モバイルのログイン・新規登録はネイティブの画面 (WebView ではない)。Google は `signInWithOAuth({ provider: "google", options: { redirectTo: Linking.createURL("/auth/verify"), skipBrowserRedirect: true } })` → `WebBrowser.openAuthSessionAsync` → `completeAuthLink(extractSupabaseLinkParams(result.url))` → `routeAfterSignIn()` | `apps/mobile/app/(auth)/login.tsx:103-134`・`signup.tsx:36-56`・`apps/mobile/src/lib/authLink.ts` |
| F-2 | ログインの後の振り分け `routeAfterSignIn` (`user_profiles` の `onboarding_*` と `?next=`) は `login.tsx` の中の関数で、`signup.tsx` には無い (Google 登録は `router.replace("/auth/verify")` へ) | `apps/mobile/app/(auth)/login.tsx:76-100`・`signup.tsx:53` |
| F-3 | モバイルの Supabase client は `storage: secureSessionStorage`・`detectSessionInUrl: false`。セッションを作れば `AuthProvider` が `onAuthStateChange` で受け取り、`identifyPurchases`・端末名の登録が動く | `apps/mobile/src/lib/supabase.ts`・`apps/mobile/src/providers/AuthProvider.tsx` |
| F-4 | モバイルの依存は Expo SDK 58 (`expo ~58.0.14`・`expo-web-browser ~58.0.6`・`expo-secure-store ~58.0.2`・`expo-linking ~58.0.13`)。`expo-apple-authentication`・`expo-crypto` は無い。Expo の SDK 58 の版の表 (`expo@58.0.14` の `bundledNativeModules.json`) は `expo-apple-authentication` = `~58.0.2`・`expo-crypto` = `~58.0.7` | `apps/mobile/package.json:24-50`・`tests/mobile-toolchain-contract.test.ts` |
| F-5 | `app.json` は `ios.bundleIdentifier` = `com.homegohan.app`・`infoPlist.CFBundleLocalizations` = `["ja", "en"]`・`plugins` に `expo-apple-authentication` は無く `ios.usesAppleSignIn` も無い。`runtimeVersion.policy` = `fingerprint` (ネイティブのモジュールを足すと指紋が変わる = 新しいビルドが要る) | `apps/mobile/app.json` |
| F-6 | Web のログインは `signInWithOAuth({ provider: 'google', options: { redirectTo: `${origin}/auth/callback?next=…` } })`。コールバック `/auth/callback` は `code` を `exchangeCodeForSession` で交換し、初めての人は同意画面へ回す (#1435)。新規登録は同意のチェック (`agreedToLegal`) を入れるまで Google のボタンを押せない (#1174) | `src/app/(auth)/login/page.tsx:70-91, 207-231`・`signup/page.tsx:47-69, 223-236`・`src/app/(auth)/auth/callback/route.ts:72-83, 194-203` |
| F-7 | 設定画面のアカウントは `user.app_metadata.provider` (最初に登録した provider) が `email` のときだけパスワード・メールの変更のフォームを出し、`google` / `apple` は案内 (`ExternalProviderGuidance`) だけ。`apple` の表示名「Apple」は既にある | `src/app/(main)/settings/account/page.tsx:57-60, 408-429`・`apps/mobile/src/components/settings/AccountCredentialsSection.tsx:28-31, 228-250, 281-282`・`src/__tests__/app/settings/account-page.test.ts:298` |
| F-8 | (段 A1 の前、土台 `9575aa99` の状態) 退会 `deleteAccount` の段階は `check_blockers` → `billing` → `prepare` → `release_membership` → `storage` → `record` → `billing_recheck` → `delete_user` (→ 完了メール)。Stripe の処理は差し替え口 `params.billing` (`AccountDeletionBilling`) で入れ、テストは偽物を渡す。Apple・`identities`・revoke の語は 0 件。いまは段 A1 (PR #1989) の後で、`billing_recheck` と `delete_user` の間に段階 `apple_revoke` がある | origin/main `33eaa0eb` (2026-10-25) の `src/lib/account-deletion.ts:9-40` (流れの見出し。段階 4''' `apple_revoke` は `:31-32`)・`:68-78` (`AccountDeletionStep`)・`:355-475` (`deleteAccount`)。`9575aa99` の同じファイルでは `deleteAccount` が `:310` から・`apple` の語は 0 件・`tests/account-deletion.test.ts` |
| F-9 | 利用者の API の認証は `requireSessionUser(supabase, authorization)` (Cookie / Bearer。`user_profiles` の行が無くても通る)。失敗の応答は `sessionsFailure` (AuthError → 401・ForbiddenError → 403・ほか 500)。本文を読む route は最初に `rejectNullCharacterBody` を呼び、`src/__tests__/api/null-character-routes.test.ts` の表に載る。500 は `internalError` だけ | `src/lib/auth/sessions/session-claims.ts:82-103`・`src/lib/auth/sessions/route-support.ts:71-78`・`src/app/api/auth/password/change/route.ts` |
| F-10 | 環境変数は `src/lib/env.ts` の一覧 (`PUBLIC_ENV_VARS` / `SERVER_ENV_VARS`。任意の変数は `whenMissing` を書く) と `.env.example` の両方に書く (`tests/env-source-scan.test.ts`)。公開の変数は `process.env.NEXT_PUBLIC_X` と名前を直接書いて読む。モバイルは `process.env.EXPO_PUBLIC_X` と直接書き、`apps/mobile/env.example` に書く (`apps/mobile/__tests__/lib/env-example.test.ts`)。設定の無いビルドで機能を出さない流儀は RevenueCat (`apps/mobile/src/lib/purchases.ts:22-28`) と Turnstile (`src/lib/auth/turnstile.ts`) にある。on / off のスイッチは `'on'` だけを有効とみなす (`lib/legal-consent.ts:66-68` の `isLegalConsentFlagOn`) | 各ファイル |
| F-11 | service_role の client は `getSupabaseAdmin()` (`lib/supabase/server.ts:20-24`) だけで作る (`tests/supabase-service-role-client-scan.test.ts`)。新しい表は RLS を有効にし、既定の権限を `REVOKE ALL` で外す (`supabase/migrations/20261023130000_account_deletion_owner_guard.sql:58-67`)。migration を足したら `database.types.ts` 2 本を作り直す (`tests/database-types-migrations-contract.test.ts`) | 各ファイル |
| F-12 | プライバシーポリシーの委託先の表 `PRIVACY_PROCESSORS` に Google (OAuth) の行があり、`tests/legal-text-1901.test.ts` の T-33 は `PRIVACY_PROCESSORS` に `Apple` が無いことを確かめている (ストアの決済の事業者としての Apple を載せない趣旨。billing/03 Q-17)。第3条の「アカウント」の行と第10条の外部送信の表に Google の行がある。主張の表は `LEGAL_CLAIM_COUNT = 424`。版は両文書とも `v2026.3` (段 D の後の main: `PRIVACY_PROCESSORS` に Apple の行・T-33 は Apple をログインの事業者として確かめる・`LEGAL_CLAIM_COUNT = 433` (Apple の 2 行と cross/21 §7.12 の作者名の表示の 7 行)・版は両文書とも `v2026.4`) | `src/lib/legal/privacy-text.ts:64-91, 209, 382`・`tests/legal-text-1901.test.ts:857-870`・`tests/legal-claims-1901.ts:25, 243, 330, 373`・`packages/shared/src/legal-versions.ts:59-60` |
| F-13 | 本番の `auth.identities` の provider は `email` だけ (194 件。2026-10-23 の SELECT)。`google`・`apple` は 0 件。Supabase の Apple provider の有効化・Apple Developer の設定は SELECT では分からない (オーナーの作業。§19) | 本番の読み取り (MCP の SELECT) |
| F-14 | Apple (一次情報): 4.8 の本文 (§0.1)。5.1.1(v) は退会をアプリの中で提供すること。Apple Developer News (2022-05-24)「If your app offers Sign in with Apple, you'll need to use the Sign in with Apple REST API to revoke user tokens when deleting an account」。失効の API は `POST https://appleid.apple.com/auth/revoke` (`client_id`・`client_secret`・`token`・`token_type_hint`。200 で本文なし。既に無効な token でも 200)。交換の API は `POST https://appleid.apple.com/auth/token` (`client_id`・`client_secret`・`code`・`grant_type=authorization_code`。`redirect_uri` は最初の認可で渡したときだけ。応答に `refresh_token`)。`client_secret` は ES256 の JWT (`kid` = Key ID・`iss` = Team ID・`aud` = `https://appleid.apple.com`・`sub` = `client_id`・`exp` は 6 か月 = 15,777,000 秒以内)。HIG: ボタンはほかのログインのボタンより小さくしない・スクロールしないと見えない位置に置かない・最小 140×30pt・題名は Sign in / Sign up / Continue with Apple だけ・自作のボタンは Apple Design Resources のロゴだけを使い題名の文字の大きさはボタンの高さの 43%。メールの中継 (`@privaterelay.appleid.com`) へ送るには送信ドメインを「Sign in with Apple for Email Communication」に登録し SPF (と DKIM) を通す。中継のアドレスは 1 日 100 通まで。自作のボタンに使う画像は Apple が URL で配る: ロゴだけのボタンは `https://appleid.cdn-apple.com/appleid/button/logo` (`size` (pt)・`color` = `white` / `black`・`border`・`border_radius` (0〜50)・`scale` (1〜6))。応答は PNG で、URL を開くと画像が落ちてくる (「Incorporating Sign in with Apple into other platforms」の「Add a custom Sign in with Apple button」)。2026-10-23 に `size=56&color=black&border=false&border_radius=0&scale=3` を 2 回取得して、どちらも 200・`image/png`・168×168 の RGBA・1,748 バイト・同じ内容 (黒の正方形の中央に白い Apple のロゴ) | developer.apple.com (guidelines・news・HIG・REST API・private email relay・Sign in with Apple JS / other platforms の各ページ) |
| F-15 | Supabase (一次情報): ネイティブは `expo-apple-authentication` の `signInAsync` → `identityToken` を `signInWithIdToken({ provider: 'apple', token })`。Dashboard の Client IDs は「Services ID を先頭、続けて bundle ID」(Web の OAuth は先頭の ID を使う。ネイティブはどれでもよい)。Secret Key (Web の OAuth 用) は 6 か月で切れるので入れ替える。名前は identity token に無く Apple が初回だけ返す (OAuth の経路は GoTrue が `user` パラメータから `full_name` に入れる。ネイティブは `updateUser` で保存する)。メールの中継は「Sign in with Apple for Email Communication」に送信元を登録。GoTrue: `id_token` の `aud` は Client IDs のどれか・nonce は「両方あるか両方無いか」で、あるときは raw の SHA-256 (小文字の hex) と `id_token` の `nonce` を比べる・provider が無効なら 400 `provider_disabled`。Apple の `id_token` の `email` は常に `Verified: true` として扱い、同じメールの既存の利用者に自動で結び付く (`DetermineAccountLinking`。既存の `email` / `google` の identity と同じ linking domain)。PKCE の交換 (`exchangeCodeForSession`) は flow state の `provider_refresh_token` を返す (provider が返したときだけ) | supabase.com/docs (auth-apple・auth-identity-linking)・github.com/supabase/auth (`token_oidc.go`・`provider/oidc.go`・`provider/apple.go`・`external.go`・`token.go`・`models/linking.go`) |
| F-16 | `expo-apple-authentication` (SDK 58): iOS だけ (Android・web は未対応)。`app.json` の `ios.usesAppleSignIn: true` で EAS Build が capability を入れる。`signInAsync({ requestedScopes, nonce, state })`・`isAvailableAsync()`・`AppleAuthenticationButton` (`buttonType` SIGN_IN / CONTINUE / SIGN_UP・`buttonStyle` WHITE / WHITE_OUTLINE / BLACK・`cornerRadius`・`style` に width と height が要る)。取り消しは `ERR_REQUEST_CANCELED`。`expo-crypto`: `randomUUID()`・`digestStringAsync(CryptoDigestAlgorithm.SHA256, data)` (既定は hex) | docs.expo.dev (apple-authentication・crypto) |
| F-17 | モバイルの Google のボタンは高さを指定していない `Pressable` で、高さは中身なり: `paddingVertical: 14` (上下で 28)・`borderWidth: 1` (上下で 2。Yoga は枠を高さに足す)・中身は `GoogleIcon` (20 × 20) と題名 (`Text`・`fontSize: 15`・太字) の横並び (`flexDirection: "row"`・`alignItems: "center"`) で、中身の高さはアイコンの 20 と題名の行の高さの大きいほう。題名の書体は Noto Sans JP (`Text` が字形を置き換える。字形を読み込む前はシステムの字形) で、行の高さは書体の値で決まり、15pt で約 22 (システムの字形で約 18) の見積もり。よって標準の文字の大きさで約 50〜52pt (少なくとも 28 + 2 + 20 = 50)。`apps/mobile` に `allowFontScaling`・`maxFontSizeMultiplier` の指定は 0 件で、RN の `Text` は既定で端末の文字の大きさの設定に従うので、設定を大きくすると題名とボタンが伸びる。ボタンは縦の並び (`login.tsx:296`・`signup.tsx:166` の `gap: spacing.md` の `View`) の中で幅いっぱい | `apps/mobile/app/(auth)/login.tsx:22-31` (`GoogleIcon`)・`:394-412` (Google のボタン)・`signup.tsx:16-25`・`:253-271`・`apps/mobile/src/components/ui/Text.tsx`・`apps/mobile/src/theme/fonts.ts` |
| F-18 | Web の OAuth が失敗で戻るときの形 (GoTrue のソース): `/auth/v1/callback` は middleware の `loadFlowState` が先に flow state を読み、`signInWithOAuth` の `redirectTo` (flow state の `Referrer`) を文脈に入れる。provider (Apple) が `error` を付けて戻す (form_post は本文、ほかはクエリ) と、`oAuthCallback` は `code` を見る前に `OAuthError(error, error_description)` を返し、`redirectErrors` が `Referrer` の URL の既存のクエリに `error`・`error_description` を足して (`getErrorQueryString` は渡されたクエリに `Set` する)、ハッシュにも同じ値を付けて 302 で送る。よって本書の Web のボタン (`redirectTo` = `/auth/callback?provider=apple&next=…`) では、`?provider=apple` が `error` と一緒に `/auth/callback` に届く。GoTrue 自身の失敗 (新規登録の停止・メールの未確認など) も `access_denied` / `server_error` などと英文の `error_description` で同じ経路を通る。flow state を読めない (期限切れ・使用済み・`state` が無い) ときは `loadFlowState` が Site URL へ送り、`/auth/callback` を通らない。`/auth/callback` は `?error=` があれば交換の前に `/login?error=<error_description (無ければ error)>` へ送り、ログイン画面はその値を `decodeURIComponent` して赤いバナーに出す (ハッシュは読まない) | github.com/supabase/auth の `internal/api/api.go` (`/callback` の middleware)・`internal/api/external_oauth.go` (`loadFlowState`・`oAuthCallback`)・`internal/api/external.go` (`redirectErrors`・`getErrorQueryString`・`getExternalRedirectURL`・`loadExternalStateFromUUID`) (2026-10-23 の master)・`src/app/(auth)/auth/callback/route.ts:33-47`・`src/app/(auth)/login/page.tsx:58-68` |

### 0.3 分冊判定

**1 冊 (本書)。実装は 4 段 (§15)。** 本書は 800 行を超え、消費先は 3 を超え (モバイルの画面 2・Web の画面 2・コールバック・退会)、共有面 (`src/lib/account-deletion.ts`・`src/lib/env.ts`・`packages/shared`・法務の文面と版) に 2 つ以上触るので、判定のトリガーには当たる。それでも分冊しないのは、核になるもの (Supabase の `apple` の identity とサーバに保管する refresh token・それを失効させる退会の段階) が 1 つで、iOS・Web の入口はその核に認可コード (またはコールバックの refresh token) を 1 本渡す配線に過ぎず、核だけを先にマージしても検証できるもの (ログインの入口) が無いためである。代わりに段を 4 つに分け、段ごとに 2 枚のレビューを挟む (§15)。

### 0.4 エージェントの作業とオーナーの作業

| 作業 | 誰が | 本書の節 |
|---|---|---|
| コード (サーバ・モバイル・Web・法務の文面)・テスト・migration・設計書 | エージェント (実装 WF) | §8〜§18 |
| Apple Developer: App ID の capability・Services ID・Key (.p8)・メールの中継の送信元の登録 | オーナー | §19.1 |
| Supabase Dashboard: Apple provider の有効化・Client IDs・Secret Key (6 か月ごとの入れ替え) | オーナー | §19.2 |
| Vercel / EAS の環境変数 (スイッチと秘密)・新しいビルド・実機の確認・ストアの提出 | オーナー (実機の確認はオーケストレーターと分担) | §19.3〜§19.5 |
| スイッチの前の確認 (サーバの秘密が本番のデプロイに効いていること。iOS・Web のスイッチを on にする前) | オーケストレーター (Vercel の名前の一覧・デプロイの時刻・本番の行の数・ログを読む。値は読まない) とオーナー (確認のビルドで 1 回入る) | §19.3・§7.3 (d) |
| 本番の migration の適用 | CI (Deploy Supabase Migrations。オーケストレーターが段 A1 をマージしたとき。適用はオーケストレーターが読み取りで確かめる) (追加だけ) | §15 |
| 段 D (版 `v2026.4`) の改定の予告を載せるか・施行日 (Q-13) | 予告は載せる (Q-13 は (a)。§21)。施行日は 2026-11-01 (日) (オーナーの選択 2026-10-24)。予告のお知らせはオーナーが運営画面 (`/admin/announcements`) から投稿し、段 D (PR #1997) は施行日にオーケストレーターがマージする (2026-11-01 にマージした) | §11.8 (i)・§7.3 (d) |

### 0.5 本書の既定と、選択肢として残す点

本書は実装者が手を止めないよう、次を既定として決めて書く。別の案に変えるときの差分は §21 に書いてある。

| 論点 | 既定 (本書) | 別の案 (§21) |
|---|---|---|
| iOS の入口 | ネイティブのシート (`expo-apple-authentication`) + `signInWithIdToken` (§6 裁定 1) | ブラウザの OAuth (Google と同じ経路) |
| Android | 出さない (§6 裁定 1) | Web と同じ OAuth をブラウザで (Q-3) |
| Web | 出す (段 B。`signInWithOAuth({ provider: 'apple' })`) | アプリだけ (Q-1) |
| 退会のときの Apple のトークンの失効 | 行う。失敗しても退会は止めない。段階の時間は `APPLE_REVOKE_TOTAL_BUDGET_MS` (3 秒) まで (§6 裁定 2・§13.1) | 失敗したら退会を止める・やり直しの列を持つ (Q-2) |
| 設定が無いとき | スイッチ (`EXPO_PUBLIC_APPLE_SIGN_IN` / `NEXT_PUBLIC_APPLE_SIGN_IN` = `on`) が無ければボタンを出さない (§6 裁定 3)。スイッチは、サーバの秘密が本番のデプロイに効いていることを確かめてから入れる (§19.3 の「スイッチの前の確認」・§7.3 (d)) | — |
| Web で Apple の画面を取り消した・Apple / GoTrue が失敗した (`/auth/callback?provider=apple&…&error=…` で戻る) | ログイン画面の赤いバナーに日本語の固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE` (`error` の値で分けない。§12.3・S-34) | (選ばれなかった案: 取り消しのときは何も出さない (Q-7 (b))。Q-7 は (a)。§21) |
| プライバシーポリシー | Apple を委託先の表に足し版を上げる (段 D)。施行日の前に運営のお知らせに改定の予告を載せ (cross/20 §9.4 の 2)、施行日に段 D をデプロイする。アプリと Web で Apple のログインを出すのは施行日の後 | (選ばれなかった案: 予告なしで公開し、cross/20 §9.3 の除外の行に `v2026.4` を書き足す (Q-13 (b))。Q-13 は (a)。§21) |

## 1. 目的・スコープ

iOS のアプリに Sign in with Apple を足し、App Store の審査 (4.8) を通す。同じ利用者が Web でも Apple で入れるようにし (段 B)、退会のときに Apple 側の認可を失効させる (5.1.1(v) と Apple の要求)。既存の Google ログインの流れ・メールとパスワードのログイン・セッションの保管・WebView のブリッジ・同意のゲートは変えない (Google のボタンは、Apple のボタンと高さをそろえるための見た目の変更だけをする。§10.1・§10.2)。

## 2. 関連要件

- App Store Review Guideline 4.8・5.1.1(v)・Apple Developer News 2022-05-24 (F-14)。
- `docs/design/cross/01-auth-session.md` §3.1「Apple Sign In: Phase 1 (iOS App Store 必須)」・§3.3「退会時: ソーシャル連携トークン全削除 + Google/Apple ドキュメント準拠で IdP 側 revoke」。
- `MOBILE_TODO.md:41` (ブロッカー 5)・`:186` (Pass 3)・`:193` (Pass 10)。Issue #1139 の本文は、これらの Pass を含む「Pass1〜10 の品質検証」が未完了であることを述べ、該当箇所に `MOBILE_TODO.md:159-217` を挙げる (本文に Sign in with Apple の語は無い)。
- `docs/design/cross/20-terms-privacy-text.md` §7 (委託先の表)・§9.3 (内容が変わる改定は版を上げる)・§10 (主張の表)。

## 3. 要件行列 (相 1)

| # | 要件 | 根拠 | 本書の答え |
|---|---|---|---|
| R-1 | iOS のログイン画面と新規登録画面に、Google と同等 (同じ大きさ以上・スクロール無しで見える) の Apple のボタンを置く | 4.8・HIG | §10.1: Google の上に、Google のボタンと同じ高さの `AppleAuthenticationButton`。2 つとも下限 `AUTH_PROVIDER_BUTTON_MIN_HEIGHT` = 56pt (Google には `minHeight`)、Apple の高さは Google のボタンの測った高さに合わせる (`useAuthProviderButtonHeight`。文字の大きさの設定で Google が伸びても同じ。S-33) |
| R-2 | 取得するのは名前とメールだけ (`requestedScopes` = FULL_NAME・EMAIL) | 4.8 | §11.4 `signInWithApple` |
| R-3 | メールを隠す選択 (中継のアドレス) を受け入れ、別のメールを求めない | 4.8・HIG | §9.4: 中継のアドレスをそのまま登録のメールにする。設定画面はそのアドレスを表示 (F-7) |
| R-4 | ネイティブでは nonce で identity token の使い回しを防ぐ | GoTrue の nonce の規則 (F-15) | §11.4: raw = `randomUUID()`、Apple へ SHA-256 hex、Supabase へ raw |
| R-5 | Supabase のセッションにしたあとは、既存のログインと同じ振り分け・同意のゲート・購入の結び付け・端末名の登録が動く | F-2・F-3・cross/13b | §9.1: `routeAfterSignIn` を共有の関数に移して両画面から呼ぶ。`AuthProvider` は変えない |
| R-6 | 初回だけ来る名前を失わない | F-15 | §9.4: ネイティブは `updateUser({ data: { full_name, given_name, family_name } })` (既に `full_name` があれば上書きしない)。Web は GoTrue が `user` から入れる |
| R-7 | 同じメールの既存のアカウント (メール / Google) と自動で結び付く挙動を前提にし、壊さない | F-15 | §9.4・§7.1: 結び付いた利用者の `app_metadata.provider` は最初の provider のまま (設定画面の分岐は変えない) |
| R-8 | 退会のとき Apple のトークンを失効させる | 5.1.1(v)・Apple News・cross/01 §3.3 | §9.3: サーバが保管した refresh token を `/auth/revoke` へ。段階 `apple_revoke` を `delete_user` の直前に置く。段階の時間は `APPLE_REVOKE_TOTAL_BUDGET_MS` まで (退会の route の 60 秒に収める。§13.1)。失効できるのはログインのときに保管した行だけなので、スイッチはサーバの秘密が本番で効いていることを確かめてから on にする (§7.3 (d)・§19.3 の「スイッチの前の確認」) |
| R-9 | 失効に使う refresh token を得る: ネイティブは認可コードをサーバで交換、Web はコールバックの `provider_refresh_token` | F-14・F-15 | §9.2 `POST /api/auth/apple/authorization`・§9.5 コールバック |
| R-10 | 秘密 (.p8・Team ID・Key ID) はサーバだけが持ち、ログ・応答に出さない。refresh token は service_role だけが読める表に置く | 既存の規律 (#1172・#1182) | §8・§11.1〜11.3・§12 |
| R-11 | 設定が無いとき (Apple Developer・Supabase の作業の前) はボタンを出さない。案内もしない | 本書の範囲 (§0.1 の (6)) | §6 裁定 3・§10 |
| R-12 | 本物の Apple・Supabase に繋がないで確かめる | 本書の範囲 (§0.1 の (7)) | §14: `expo-apple-authentication`・`supabase.auth`・`fetch` を偽物にする |
| R-13 | Web のボタンは Apple のロゴと題名の規則に従う (題名は「Appleで続ける」「Appleで登録」。ロゴは Apple が配る画像 (F-14 のロゴだけのボタンの URL)。文字の大きさは高さの 43%) | HIG・F-14 | §10.2・§11.6 |
| R-14 | Web の新規登録は同意のチェックを入れるまで Apple のボタンも押せない。ログイン画面の「はじめての方は…同意の画面が出ます」の案内は Apple にも掛かる | #1174・#1435 | §10.2 |
| R-15 | 環境変数は一覧と `.env.example` / `env.example` に書き、無いときの挙動を書く | F-10 | §13.2 |
| R-16 | プライバシーポリシーに Apple (ログイン) を委託先として載せ、版を上げる。アプリで Apple のログインが使えるようになる前に公開する。版を上げる改定なので、改定の概要と施行日を施行日の前に本サービスのお知らせに載せる (公開中のプライバシーポリシー第18条 1 項・利用規約第24条 1 項の約束) | cross/20 §7・§9.3・§9.4 の 2 | §15 段 D と公開の順・§7.3 (d)・§9.6・§11.8 (f)・(i)・§21 Q-13 |
| R-17 | メールの中継のアドレスへ届くメール (確認・退会の完了・通知) のために送信ドメインを Apple に登録する | F-14 | §19.1 (オーナー) |
| R-18 | 新しい表・route・環境変数・依存は、既存の番兵 (契約テスト・走査テスト) が反応する形で足す | 既存の規律 | §17 |
| R-19 | Apple のログイン・登録の失敗と取り消しで利用者に見せる文は、日本語の固定の文にする (Apple・GoTrue の英文を出さない) | 本書の範囲 (§0.1 の (3))・#1172 の規律 | §12: iOS は `APPLE_SIGN_IN_MESSAGES` (取り消しは何も出さない。S-7)。Web のボタンの失敗は §11.6 の固定の文。Web の `/auth/callback` に `?error=` で戻ったときは `APPLE_WEB_CALLBACK_ERROR_MESSAGE` (S-34・§21 Q-7) |

## 4. ユーザーシナリオ (34 本)

| # | シナリオ | 期待する結果 |
|---|---|---|
| S-1 | iPhone・初めての人・ログイン画面で「Apple でサインイン」を押し、Face ID で認可し、メールを共有する | Supabase に新しい利用者 (identity `apple`)。名前を `user_metadata.full_name` に保存。認可コードをサーバが交換して refresh token を保管。初期設定の入口 `/onboarding/welcome` へ。同意のゲート (`LegalConsentProvider`) が `required` なら同意画面 |
| S-2 | S-1 で「メールを非公開」を選ぶ | `auth.users.email` は `xxx@privaterelay.appleid.com`。ほかは S-1 と同じ。設定画面はそのアドレスを表示 |
| S-3 | S-1 の人が 2 回目にログインする (Apple は名前・メールを返さない) | `signInWithIdToken` が既存の利用者を返す。`full_name` は上書きしない。refresh token は新しい値で上書き (upsert)。ホームへ |
| S-4 | メールとパスワードで登録済みの人が、同じメールを共有して Apple で入る | GoTrue が既存の利用者に `apple` の identity を結び付ける (新しい利用者は作らない)。`app_metadata.provider` は `email` のまま → 設定画面にパスワードのフォームが出続ける。refresh token は保管 |
| S-5 | Google で登録済みの人が同じ Gmail を共有して Apple で入る | S-4 と同じ (provider は `google` のまま) |
| S-6 | S-4 の人が「メールを非公開」を選ぶ | メールが違うので新しい利用者ができる (結び付かない)。2 つのアカウントを持つ (Google と同じ既存の帰結。案内は §21 Q-5) |
| S-7 | シートで「キャンセル」を押す | 何も起きない (アラートも出さない)。ボタンは押せる状態に戻る |
| S-8 | スイッチは on だが Supabase の Apple provider が無効 | `signInWithIdToken` が 400 `provider_disabled` → 固定の文「Apple でのログインに失敗しました。…」。ログイン画面のまま |
| S-9 | スイッチが無いビルド (オーナーの作業の前) | Apple のボタンは出ない。ほかは今までどおり |
| S-10 | Android の端末 | Apple のボタンは出ない |
| S-11 | 新規登録画面の「Apple で登録」 | S-1 と同じ流れ。既存の利用者なら S-3 と同じ振り分け (ホームへ) |
| S-12 | ログインは成功したが、サーバの秘密 (Team ID など) が未設定 | ログインは成功。`POST /api/auth/apple/authorization` は 200 `{ stored: false, reason: 'not_configured' }`。refresh token は保管されない (退会のときは行が無いので Apple を呼ばない。S-16)。公開の工程はスイッチの前に秘密が効いていることを確かめるので (§7.3 (d)・§19.3)、利用者がこの状態に当たるのは公開の後に秘密を外したときだけ |
| S-13 | ログインは成功したが、交換の API が 5 分を過ぎた・通信できない | ログインは成功。route は 400 `APPLE_AUTHORIZATION_CODE_INVALID` または 500。アプリは `console.warn` だけで画面は進む |
| S-14 | Apple でログインした人が退会する (refresh token の行がある) | `apple_revoke`: 行ごとに `client_secret` を作り `/auth/revoke` を呼ぶ (200)。行は `deleteUser` の CASCADE で消える。退会は完了 (完了メール) |
| S-15 | 退会・Apple の API が落ちている (すぐ失敗が返る: 通信の失敗・5xx) | 段階の時間の上限 (`APPLE_REVOKE_TOTAL_BUDGET_MS` = 3 秒) の中で 2 回試して失敗 → `warn` のログ (request_id・段階)。退会は続けて完了する |
| S-16 | 退会・行が無い (S-12 の人・Google だけの人) | Apple を呼ばずに `delete_user` へ |
| S-17 | Web のログイン画面で「Appleで続ける」(初めての人) | `/auth/v1/authorize?provider=apple` → Apple → Supabase → `/auth/callback?provider=apple&code=…` → `exchangeCodeForSession` → 初めてなので同意画面 (#1435)。`provider_refresh_token` があり identity に `apple` があれば Services ID の行として保管 |
| S-18 | Web の新規登録画面・同意のチェック無しで Apple のボタン | 押せない (`disabled`)。`signInWithOAuth` は呼ばれない |
| S-19 | Web・スイッチ無し | Apple のボタンは出ない。Google のボタンと案内は今までどおり |
| S-20 | Web・2 回目 | ホーム (`/home`) へ。保管の行を上書き |
| S-21 | iPhone でログインしたあと WebView のタブを開く | 既存のブリッジ (`/auth/native-bridge`) でそのまま入れる (変えない) |
| S-22 | 中継のアドレスの人に退会の完了メール・プッシュの代わりのメールを送る | 送信ドメインを Apple に登録していれば届く。未登録なら Apple が拒む (オーナーの作業 §19.1 の 4) |
| S-23 | 利用者が iPhone の設定で「Apple でサインインの使用を停止」したあと、もう一度 Apple で入る | Apple は初回として名前・メールを返し、新しい認可コードを発行。`sub` は同じなので Supabase は既存の利用者。古い refresh token は Apple 側で無効 (失効しても 200)。新しいコードを交換して行を上書き |
| S-24 | identity token の nonce が合わない (改ざん・別のリクエストの token) | `signInWithIdToken` が失敗 → 固定の文。セッションは作られない |
| S-25 | 既存の利用者 (どの provider でも) が、段 D の施行日の前と後にアプリ / Web を開く | 施行日の前: ホームのお知らせに改定の予告 (概要・施行日) が出る。同意の画面は出ない。施行日 (段 D のデプロイ) の後: 同意の画面が出て、2 文書とも「改定あり」。同意すると元の画面へ戻る (Q-13 は (a) で、予告を出す。§21) |
| S-26 | Apple でログインした人 (refresh token の行がある) が、サーバの秘密 (`APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY` のどれか) が外れている間に退会する | `apple_revoke` は Apple を呼ばず `skipped: 'not_configured'` (行数つきの `warn`)。行は `deleteUser` の CASCADE で消える。退会は完了 |
| S-27 | S-26 と同じ人が、秘密鍵の値が壊れている (`\n` の書き誤り・ヘッダの欠け・別の鍵) 間に退会する | 行ごとに `client_secret` を作れず、Apple を呼ばずに `failed` に数えて `warn` (`client_id`・`error_name`。PEM は出さない)。退会は完了 |
| S-28 | Web・スイッチは on だが Supabase の Apple provider が無効 | 「Appleで続ける」を押すと、Apple の画面へ行かず Supabase の `/auth/v1/authorize` が 400 の JSON を出す (スイッチは provider を有効にしてから入れる運用で防ぐ。§19.3) |
| S-29 | Web・Apple で入ったが、サーバに Services ID (`APPLE_SIGN_IN_SERVICES_ID`) が無い、または Supabase が `provider_refresh_token` を返さない | ログインと振り分けは S-17・S-20 と同じ。refresh token は保管しない (`info`)。退会のときは Web の行が無いので、その入口の失効はスキップになる (iOS で入ったことがあれば iOS の行で失効する。§21 Q-6)。Services ID が無い場合は、公開の工程がスイッチの前に確かめて防ぐ (§19.3 の「スイッチの前の確認」の 1・2) |
| S-30 | iPhone・シートは通ったが Apple が `identityToken` を返さない | Supabase を呼ばない。固定の文 `APPLE_SIGN_IN_MESSAGES.noIdentityToken` のアラート。ログイン画面のまま |
| S-31 | iPhone・初めての人のログインで、名前の保存 (`updateUser`) が失敗する | ログインは成功し、振り分けへ進む (`console.warn` だけ)。名前は保存されない (次に Apple が名前を返すのは S-23 の停止の後だけ。ニックネームは初期設定で入れる) |
| S-32 | iPhone と Web の両方で Apple で入った人 (refresh token の行が 2 つ) が、Apple の API が応答しない (時間切れになる) 間に退会する | 1 行目の 1 回目を段階の時間の上限 (3 秒) の残りで打ち切り、やり直さずに `failed` (`warn`)。2 行目は Apple を呼ばずに `failed` (上限を過ぎた行の `warn` 1 回)。`apple_revoke` は約 3 秒で終わり、退会は完了する (退会の route の 60 秒を Apple の障害で超えない) |
| S-33 | iPhone・Apple のボタンが出る状態 (スイッチ on・対応端末) で、端末の文字の大きさの設定を標準より大きくしてから、ログイン画面 (または新規登録画面) を開く。そのあと標準に戻す | Google のボタンの題名が大きくなる。中身が 56pt に収まるうちは 2 つとも 56pt (Google の `minHeight`)。収まらなくなると Google のボタンは 56pt を超えて伸び、Apple のボタンも同じ高さになる (Google より低くならない)。標準に戻すと 2 つとも 56pt |
| S-34 | Web のログイン画面 (または新規登録画面) で「Appleで続ける」(「Appleで登録」) を押し、Apple の画面で取り消す (サインインをやめる・拒否する) | Apple が取り消し・拒否の `error` (`user_cancelled_authorize`・`access_denied` など。値は Apple と GoTrue が決める) を付けて Supabase へ戻し、Supabase が `/auth/callback?provider=apple&next=…&error=…&error_description=…` へ送る (F-18) → コールバックは交換の前に `/login?error=` へ送る (新規登録画面から始めてもログイン画面)。`?provider=apple` なので、`?error=` の値は Apple・GoTrue の英文ではなく日本語の固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE`「Apple でのログインを完了できませんでした。もう一度お試しください。」(`error` の値で分けない) → ログイン画面 (`src/app/(auth)/login/page.tsx:59-68`) が赤いバナーにその文を出す (§12.3・§21 Q-7 の既定 (a))。セッションは作られず、refresh token は保管しない (コールバックは交換の前に戻る)。Apple や GoTrue の失敗で `?error=` が付いて戻ったときも同じ |

## 5. 構想とトレース (相 2)

### 5.1 構造

```
iOS (ネイティブの画面)                              Web (Next.js)
  AppleSignInButton (expo-apple-authentication)        AppleSignInButton (自作。Apple のロゴ)
    │ signInAsync({ FULL_NAME, EMAIL, nonce: sha256 })    │ signInWithOAuth({ provider: 'apple',
    ▼                                                      │   redirectTo: /auth/callback?provider=apple&next=… })
  signInWithApple() (apps/mobile/src/lib/appleSignIn.ts)   ▼
    1. supabase.auth.signInWithIdToken({ provider: 'apple', token, nonce: raw })
    2. 名前の保存 (updateUser。初回だけ)              Apple → Supabase /auth/v1/callback → /auth/callback (code)
    3. POST /api/auth/apple/authorization { authorization_code }   exchangeCodeForSession → session.provider_refresh_token
    4. routeAfterSignIn()                                  storeAppleRefreshToken(Services ID) ──┐
                                                                                                 │
  サーバ (src/lib/auth/apple/)                                                                   │
    config.ts      … 環境変数 (Team ID・Key ID・.p8・Services ID)・bundle ID の定数                │
    client-secret.ts … ES256 の JWT (node:crypto)                                                │
    rest.ts        … /auth/token (交換)・/auth/revoke (失効)                                      │
    tokens.ts      … 表 apple_sign_in_tokens の upsert / 一覧 / 削除 (service_role)  ◄────────────┘
    authorization.ts … route の本体 (交換 → 保管)
    revocation.ts  … 退会の段階 apple_revoke (差し替え口 AccountDeletionAppleRevocation。段階の時間の上限 3 秒)
  退会 deleteAccount: … billing_recheck → apple_revoke → delete_user (CASCADE で行も消える)
```

- 核は「Supabase の `apple` の identity」と「サーバに保管した refresh token を退会で失効させる段階」。iOS と Web はその核へ refresh token の元 (認可コード / `provider_refresh_token`) を渡す配線。
- スイッチは 2 つ (`EXPO_PUBLIC_APPLE_SIGN_IN`・`NEXT_PUBLIC_APPLE_SIGN_IN`。値 `on` だけ有効。読み方は `packages/shared` の `isAppleSignInFlagOn` 1 つ)。サーバの秘密が無いときは交換・失効をしないだけで、ログインは止めない (S-12)。その間に入った人の行は残らず退会のときに失効できないので、スイッチは秘密が本番で効いていることを確かめてから入れる (§7.3 (d)・§19.3)。
- Web の `/auth/callback` に `?error=` で戻ったとき (Apple の画面で取り消した・Apple / GoTrue の失敗) は、`?provider=apple` なら Apple・GoTrue の英文ではなく日本語の固定の文 (`APPLE_WEB_CALLBACK_ERROR_MESSAGE`) でログイン画面へ送る (`appleCallbackErrorMessage`。S-34・§9.5)。

### 5.2 トレース (全シナリオを §5.1 で手で走らせた記録)

| # | 走らせた経路 (→ は順) | 結果 (§4 と一致) |
|---|---|---|
| S-1 | `AppleSignInButton` (available) → `signInWithApple`: nonce 生成 → `signInAsync` が credential (identityToken・authorizationCode・fullName・email) → `signInWithIdToken` 200 (新規。`DetermineAccountLinking` = CreateAccount) → `data.user.user_metadata.full_name` 無し かつ fullName あり → `updateUser` → `registerAppleAuthorization` → route: `requireSessionUser` → identities に `apple` → config あり → `/auth/token` 200 (refresh_token) → upsert (user_id, `com.homegohan.app`) → 200 → `routeAfterSignIn`: profile 無し → `/onboarding/welcome` | 一致 |
| S-2 | S-1 と同じ。`credential.email` が中継のアドレス。`auth.users.email` も中継 (GoTrue は `id_token.email` を使う) | 一致 |
| S-3 | `signInAsync` が fullName = null・email = null → `signInWithIdToken` (AccountExists) → fullName 無しなので `updateUser` を呼ばない → route の upsert (同じ PK) で上書き → `routeAfterSignIn`: completed → `/(tabs)/home` | 一致 |
| S-4 | `signInWithIdToken`: `id_token.email` = 既存の email の identity と同じ・Verified → LinkAccount → 既存の user に `apple` の identity → `app_metadata.provider` は `email`・`providers` に `apple` が増える → 設定画面 `canEditCredentials` = `provider === "email"` のまま true | 一致 |
| S-5 | S-4 の provider が `google` | 一致 |
| S-6 | `id_token.email` が中継 → 一致する identity 無し → CreateAccount | 一致 |
| S-7 | `signInAsync` が `ERR_REQUEST_CANCELED` を投げる → `{ status: 'cancelled' }` → 画面は何もしない (`setIsSubmitting(false)`) | 一致 |
| S-8 | `signInWithIdToken` が `{ error: AuthApiError(400, provider_disabled) }` → `{ status: 'failed', message: APPLE_SIGN_IN_MESSAGES.failed }` → `Alert.alert("Appleログイン失敗", message)` | 一致 |
| S-9 | `isAppleSignInEnabled()` = false (値が `on` でない) → `AppleSignInButton` は null | 一致 |
| S-10 | `Platform.OS !== 'ios'` → false → null | 一致 |
| S-11 | `signup.tsx` の `onAppleSignup` は `login.tsx` の `onAppleLogin` と同じ関数の組 (`signInWithApple` → `routeAfterSignIn`) | 一致 |
| S-12 | route: `readAppleSignInServerConfig()` = null → 200 `{ stored: false, reason: 'not_configured' }` (ログは `warn` 1 回。`getOptionalEnv` の 1 回だけの警告と重ならないよう route は `info`) → アプリは結果を読まない | 一致 |
| S-13 | `/auth/token` が 400 `invalid_grant` → `{ ok: false, reason: 'invalid_code' }` → route 400 `APPLE_AUTHORIZATION_CODE_INVALID`。通信の失敗 (timeout) → `{ ok: false, reason: 'unavailable' }` → `internalError` 500。アプリ: `registerAppleAuthorization` の `catch` → `console.warn` → `signed_in` を返す → 画面が `routeAfterSignIn` (順は 名前 → 登録 → 振り分け。登録の失敗で振り分けを止めない) | 一致 |
| S-14 | `deleteAccount`: … `billing_recheck` → `step = 'apple_revoke'` → `appleRevocation.revokeForAccountDeletion(userId, userLog, requestId)`: `listAppleRefreshTokens` 1 行 → config → `client_secret` (sub = 行の client_id) → `/auth/revoke` 200 → `{ tokens: 1, revoked: 1, failed: 0 }` → `delete_user` → CASCADE で行が消える → 完了メール | 一致 |
| S-15 | `apple_revoke` の入口で締め切り = 今 + `APPLE_REVOKE_TOTAL_BUDGET_MS` → `listAppleRefreshTokens` 1 行 → config → `client_secret` → `/auth/revoke` が 503 (または通信の失敗) をすぐ返す (`timeoutMs` = min(`APPLE_API_TIMEOUT_MS`, 残り)) → 残りがあるので 2 回目 → また失敗 → `warn` (`attempts: 2`) → `{ tokens: 1, revoked: 0, failed: 1, skipped: null }` → `delete_user` へ (投げない) | 一致 |
| S-16 | `listAppleRefreshTokens` 0 行 → `{ tokens: 0, … }` → Apple を呼ばない | 一致 |
| S-17 | `handleAppleLogin` → `signInWithOAuth({ provider: 'apple', redirectTo })` → ブラウザが Supabase → Apple → Supabase → `/auth/callback?provider=apple&code=` → `exchangeCodeForSession` 200 → `storeAppleRefreshTokenFromWebCallback`: `provider === 'apple'` かつ `session.provider_refresh_token` かつ identities に `apple` かつ Services ID あり → upsert (user_id, Services ID) → 既存の分岐 (profile 無し → `resolveFirstSignInDestination` → `/legal-consent`) | 一致 |
| S-18 | `disabled={isLoading \|\| !agreedToLegal}` と `handleAppleSignup` の先頭の `if (!agreedToLegal)` の 2 重 | 一致 |
| S-19 | `isAppleSignInEnabled()` = false → ボタンを描かない | 一致 |
| S-20 | S-17 の `next = '/home'` | 一致 |
| S-21 | 既存の経路 (`05-auth-session.md` §6)。本書は触らない | 一致 |
| S-22 | 送信は既存の `email_outbox` (Resend)。Apple の中継が受け取るかは送信ドメインの登録次第 (§19.1) | 一致 |
| S-23 | Apple が `fullName` を返す → `user_metadata.full_name` は既にある → 上書きしない。認可コードは新しい → upsert で上書き | 一致 |
| S-24 | GoTrue が `invalid nonce` (Nonces mismatch) → `signInWithIdToken` の `error` → `failed` | 一致 |
| S-25 | 予告: オーケストレーターが `/admin/announcements` でお知らせを公開 (`is_public` = true。`published_at` が入る: `src/app/api/announcements/route.ts:95-97` の `is_public: isPublic`・`published_at: isPublic ? new Date().toISOString() : null`) → `GET /api/announcements?mode=public` → Web とアプリのホームに出る (cross/20 F-31)。この間 `LEGAL_DOCUMENTS` は `v2026.3` のままなので同意のゲートは動かない。施行日: 段 D のデプロイで 2 文書が `v2026.4` → `user_profiles.terms_version_accepted` / `privacy_version_accepted` (`v2026.3`) と違う (`packages/shared/src/legal-versions.ts:106-109`) → 既存の同意のゲートが同意の画面へ (cross/20 §9.2。本書は変えない) | 一致 |
| S-26 | `deleteAccount`: … `billing_recheck` → `step = 'apple_revoke'` → `revokeForAccountDeletion`: `listAppleRefreshTokens` 1 行 → `readAppleSignInServerConfig()` = null → `{ tokens: 1, revoked: 0, failed: 0, skipped: 'not_configured' }` と `warn` → `delete_user` → CASCADE | 一致 |
| S-27 | S-26 と同じ入口 → config あり → 行の入口で残りあり (締め切りの前。`remainingMs() > 0`) → 行ごとの `try` の中で `createAppleClientSecret` が投げる (`createPrivateKey` が PEM を読めない) → `catch` で `failed` に数えて `warn` (`client_id`・`error_name`)・`revokeAppleRefreshToken` を呼ばない → `{ tokens: 1, revoked: 0, failed: 1, skipped: null }` → `delete_user` | 一致 |
| S-28 | `handleAppleLogin` → `signInWithOAuth({ provider: 'apple' })` は URL を作ってブラウザを `/auth/v1/authorize?provider=apple` へ送る (`error` は返らない) → GoTrue が provider 無効の 400 を返す。アプリのコードは通らない (§7.1・§19.3 の運用) | 一致 |
| S-29 | S-17 の `exchangeCodeForSession` 200 の後 → `storeAppleRefreshTokenFromWebCallback`: `session.provider_refresh_token` 無し → `info` で `skipped` / または `readAppleSignInServerConfig()?.servicesId` が null → `info` で `skipped` → 既存の分岐 (振り分けは同じ) | 一致 |
| S-30 | `signInAsync` が credential を返す → `credential.identityToken` が null → `{ status: 'failed', message: APPLE_SIGN_IN_MESSAGES.noIdentityToken }` (`signInWithIdToken` を呼ばない) → `Alert.alert("Appleログイン失敗", message)` | 一致 |
| S-31 | S-1 の `signInWithIdToken` 200 の後 → `saveAppleFullName`: `fullName` あり・`full_name` 無し → `updateUser` が `{ error }` → `console.warn` (投げない) → `registerAppleAuthorization` → `signed_in` → `routeAfterSignIn` | 一致 |
| S-32 | `deleteAccount`: … `billing_recheck` → `step = 'apple_revoke'` → 締め切り = 入口 + 3,000 ms → `listAppleRefreshTokens` 2 行 (bundle ID・Services ID) → config → 1 行目: 残りあり → `client_secret` → `revokeAppleRefreshToken` (`timeoutMs` = min(5,000, 残り) = 残り) が時間切れ (`{ ok: false, status: null, error: null }`) → 残り ≤ 0 なのでやり直さない → `warn` (`attempts: 1`・`budget_exhausted: true`) → 2 行目: 残り ≤ 0 → `not_attempted` (`client_secret` も作らず Apple を呼ばない) → `warn` 1 回 (`not_attempted: 1`・`budget_ms: 3000`) → `{ tokens: 2, revoked: 0, failed: 2, skipped: null }` → `delete_user` → CASCADE で 2 行とも消える | 一致 |
| S-33 | `LoginScreen` (`SignupScreen` も同じ) の `useAuthProviderButtonHeight()` → 初めの `height` = `AUTH_PROVIDER_BUTTON_MIN_HEIGHT` (56) → `AppleSignInButton` (available) の `style.height` = 56 → Google の `Pressable` (`minHeight` 56) が題名の大きさなりに 56 を超えて並ぶ → `onLayout` が測った高さ (例 64) → `onGoogleButtonLayout` → `setHeight(Math.max(56, 64))` = 64 → 描き直しで Apple の `style.height` = 64。標準に戻す → Google の `minHeight` で 56 → `onLayout` 56 → `Math.max(56, 56)` = 56 → Apple も 56 | 一致 |
| S-34 | `handleAppleLogin` (新規登録は `handleAppleSignup`) → `signInWithOAuth({ provider: 'apple', redirectTo: /auth/callback?provider=apple&next=… })` → ブラウザが Supabase → Apple (取り消す) → Supabase の `oAuthCallback` が `OAuthError` → `redirectErrors` が `Referrer` のクエリに `error`・`error_description` を足す (F-18) → `/auth/callback?provider=apple&next=…&error=…` → `error_param` がある (`:37`) → `appleCallbackErrorMessage('apple')` = `APPLE_WEB_CALLBACK_ERROR_MESSAGE` → `/login?error=<固定の文>` へ redirect (段 B の差分。§11.6。`code` の交換の分岐 (`:72-83`) に入らないので `storeAppleRefreshTokenFromWebCallback` は呼ばれない) → `LoginPage` の `useEffect` が `searchParams.get('error')` を `decodeURIComponent` して `setError` に入れ、URL から消す (`login/page.tsx:59-68`。固定の文は `%` を含まないのでもう 1 回の decode で変わらない)。ブラウザは元の URL のハッシュ (GoTrue が付けた `#error=…`) を `/login` に引き継ぐが、ログイン画面はハッシュを読まない (Google の取り消しも同じ。既存) | 一致 |

## 6. 構造裁定 (相 3。1 回だけ)

### 裁定 1: iOS の入口 = ネイティブのシート + `signInWithIdToken`

| 案 | 中身 | 利点 | 欠点 |
|---|---|---|---|
| A (採用) | `expo-apple-authentication` のシート → `identityToken` を `signInWithIdToken` | Apple の既定の見え方 (Face ID・メールを隠す・名前)。Services ID と 6 か月の secret が無くても動く (Client IDs に bundle ID を入れるだけ)。`authorizationCode` が取れるので失効に使う refresh token を自前で得られる | ネイティブのモジュールが 2 つ増える (`expo-apple-authentication`・`expo-crypto`)。Android は使えない |
| B | Google と同じ `signInWithOAuth` + `openAuthSessionAsync` | 追加のモジュール無し。Android も同じコード | Services ID と 6 か月ごとの secret の入れ替えが iOS でも必須になる。名前は OAuth の `user` パラメータ (GoTrue が読む) に頼る。失効のための refresh token は `provider_refresh_token` に頼る (Web と同じ不確かさ。§21 Q-6)。審査で「ブラウザで Apple のログイン」は通るが、HIG の見え方 (ネイティブのシート) から外れる |
| C | WebView の中の Web のログイン画面 | 実装は Web だけ | モバイルのログインはネイティブの画面 (F-1) で、WebView はログインの後にしか開かない。構造を変える案で、範囲外 |

「縁の発生源を消すより単純な構造は無いか」: B は iOS の縁 (モジュール・nonce・authorizationCode) を消す代わりに、Services ID・secret の入れ替え・`provider_refresh_token` の不確かさを iOS にも持ち込む。縁の発生源 (Apple の設定の多さ) は消えず、場所が移るだけ。A を採る。Android は B の一部 (ブラウザの OAuth) で足せるが、Android の提出は iOS の後 (`MOBILE_TODO.md`) なので本書では出さない (Q-3)。

### 裁定 2: 退会のときの失効 = サーバに保管した refresh token を失効させる。失敗しても退会は止めない

| 案 | 中身 | 利点 | 欠点 |
|---|---|---|---|
| R1 (採用) | ログインのとき (iOS: 認可コードの交換 / Web: `provider_refresh_token`) にサーバが refresh token を `apple_sign_in_tokens` に保管し、退会の `delete_user` の直前に `/auth/revoke` を呼ぶ。失敗は `warn` で続ける。段階の時間に上限 (`APPLE_REVOKE_TOTAL_BUDGET_MS`。§13.1) を置き、上限を過ぎた行は呼ばずに失敗に数える (Apple が応答しなくても退会の route の 60 秒を超えない) | Apple の要求 (F-14) を満たす。退会 (5.1.1(v)) を Apple の障害で止めない。表は CASCADE で消える | 失敗したトークンはそのまま消える (利用者は iPhone の設定から自分で停止できる。Apple の中継の停止も同じ場所) |
| R2 | 失効しない | 実装が無い | Apple の要求に反する (審査の指摘の元) |
| R3 | R1 + 失敗した失効を列 (表 + cron) に残してやり直す | 取りこぼしが無い | cron の route・`CRON_SECRET` の契約・列の表と番兵が増える。退会は利用者がゼロの今、量が無い |

R1 を採り、R3 は Q-2 に残す (退会の量が増えたら足す)。

### 裁定 3: 設定が無いとき = ビルド時のスイッチでボタンを出さない

| 案 | 中身 | 利点 | 欠点 |
|---|---|---|---|
| F1 (採用) | `EXPO_PUBLIC_APPLE_SIGN_IN` / `NEXT_PUBLIC_APPLE_SIGN_IN` = `on` のときだけボタンを出す (値の読み方は `isAppleSignInFlagOn`) | Turnstile・RevenueCat と同じ流儀 (F-10)。Supabase の設定が済むまで利用者に見せない。Web で provider が無効のまま押すと GoTrue の 400 の JSON がそのまま表示される事故を防ぐ | 有効にするには新しいビルド (iOS) / 再デプロイ (Web) が要る |
| F2 | Supabase の provider の有効・無効を実行時に問い合わせる | ビルドし直しが要らない | GoTrue に provider の有効・無効を返す公開の API は無い。試しに `authorize` を叩く形は副作用がある |

F1 を採る。

### 裁定の帰結 (以後の相で蒸し返さない)

- iOS はネイティブ (A)・Android は出さない・Web は OAuth (段 B)。
- refresh token の保管は 1 表 (`apple_sign_in_tokens`。PK = `(user_id, client_id)`)・失効は退会の段階 1 つ・失敗は止めない・段階の時間に上限を置く (§13.1)。
- スイッチは 2 つ・読み方は 1 つ。

## 7. 表 3 点

### 7.1 全パターン表 (入口 × 条件 → 結果)

| 入口 | スイッチ | 端末 / 設定 | Supabase の Apple provider | 既存のアカウント | 結果 |
|---|---|---|---|---|---|
| iOS ログイン | 無し | — | — | — | ボタン無し (S-9) |
| iOS ログイン | on | iOS・`isAvailableAsync` = false | — | — | ボタン無し |
| iOS ログイン | on | iOS | 無効 | — | 固定の文 (S-8) |
| iOS ログイン | on | iOS | 有効 | 無し | 新規。名前の保存。refresh token の保管 (秘密があれば)。`/onboarding/welcome` (S-1・S-2) |
| iOS ログイン | on | iOS | 有効 | 同じメールの `email` / `google` | 結び付け。provider はそのまま (S-4・S-5) |
| iOS ログイン | on | iOS | 有効 | 同じ `sub` の `apple` | 既存。振り分けは profile 次第 (S-3) |
| iOS ログイン | on | iOS (iPhone の設定で「Apple でサインインの使用を停止」したあと) | 有効 | 同じ `sub` の `apple` | 既存の利用者。Apple は名前・メールを初回として返すが、`user_metadata.full_name` があれば上書きしない。新しい認可コードを交換して行を上書き (upsert) (S-23) |
| iOS ログイン | on | iOS | 有効 | 中継のメール | 新規 (S-6) |
| iOS ログイン | on | iOS・サーバの秘密なし (`APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY` のどれかが無い) | 有効 | どれでも | ログインは成功。`POST /api/auth/apple/authorization` は 200 `{ stored: false, reason: 'not_configured' }`。行は保管しない (退会では失効をスキップ。S-16) (S-12)。公開の工程はスイッチの前に秘密を確かめて防ぐ (§7.3 (d)・§19.3) |
| iOS ログイン | on | iOS・認可コードの交換の失敗 (Apple が `invalid_grant` = 5 分超・使用済み・別の client / Apple に届かない・時間切れ) | 有効 | どれでも | ログインは成功。route は 400 `APPLE_AUTHORIZATION_CODE_INVALID` / 500 `INTERNAL_ERROR` (ログに `step: 'exchange'`)。アプリは `console.warn` だけで、振り分け (`routeAfterSignIn`) は止めない。行は保管しない (S-13) |
| iOS ログイン | on | iOS・identity token の nonce が合わない (改ざん・別のリクエストの token) | 有効 | — | `signInWithIdToken` の error → 固定の文 `APPLE_SIGN_IN_MESSAGES.failed`。セッションは作られない。ログイン画面のまま (S-24) |
| iOS ログイン | on | iOS・シートで「キャンセル」(`ERR_REQUEST_CANCELED`) | — | — | 何も出さない (アラート無し)。Supabase を呼ばない。ボタンは押せる状態に戻る (S-7) |
| iOS ログイン | on | iOS・Apple が `identityToken` を返さない | — | — | Supabase を呼ばない。固定の文 `APPLE_SIGN_IN_MESSAGES.noIdentityToken`。ログイン画面のまま (S-30) |
| iOS ログイン | on | iOS・名前の保存 (`updateUser`) の失敗 | 有効 | 無し (初回) | ログインは成功。名前は保存されない (`console.warn`)。認可コードの登録と振り分けは続ける (S-31) |
| iOS 新規登録 | (上の iOS ログインと同じ行) | | | | 同じ (S-11) |
| iOS ログイン・新規登録 (ボタンの高さ) | on | iOS・文字の大きさの設定が標準 (Apple のボタンが出る状態) | — | — | Apple と Google のボタンはどちらも `AUTH_PROVIDER_BUTTON_MIN_HEIGHT` (56pt)。Google は `minHeight`、Apple は `useAuthProviderButtonHeight` の初めの値と Google の `onLayout` の測った高さ (56) |
| iOS ログイン・新規登録 (ボタンの高さ) | on | iOS・文字の大きさの設定を大きくした (Google のボタンが 56pt を超えて伸びる) | — | — | Apple のボタンは Google のボタンの `onLayout` の測った高さと同じ (S-33) |
| iOS / Android ログイン・新規登録 (ボタンの高さ) | 無し (または Android・非対応端末) | — | — | — | Apple のボタンは無い。Google のボタンは `minHeight` 56pt (標準の文字の大きさで現行の約 50〜52pt から 56pt になる。F-17) |
| Android | どれでも | Android | — | — | ボタン無し (S-10) |
| Web ログイン | 無し | — | — | — | ボタン無し (S-19) |
| Web ログイン | on | — | 無効 | — | Apple の画面へ行かず Supabase が 400 の JSON を出す (スイッチは provider を有効にしてから入れる。§19.3) (S-28) |
| Web ログイン | on | — | 有効 | 無し | 同意画面 (#1435)。`provider_refresh_token` があれば保管 (S-17) |
| Web ログイン | on | — | 有効 | 同じメールの `email` / `google` | 結び付け (GoTrue。iOS と同じ。`app_metadata.provider` はそのまま。S-4・S-5 の Web 版) |
| Web ログイン | on | — | 有効 | 同じ `sub` の `apple` (2 回目) | `next` (既定 `/home`) へ。`provider_refresh_token` があれば Services ID の行を上書き (S-20) |
| Web ログイン | on | サーバに Services ID (`APPLE_SIGN_IN_SERVICES_ID`) が無い | 有効 | どれでも | ログインと振り分けは上の行と同じ。refresh token は保管しない (`info`)。退会では Web の行の失効をスキップ (S-29)。公開の工程はスイッチの前に Services ID を確かめて防ぐ (§19.3) |
| Web ログイン | on | Supabase が `provider_refresh_token` を返さない (§21 Q-6) | 有効 | どれでも | 同上 (S-29) |
| Web ログイン・新規登録 | on (新規登録は同意のチェックあり) | Apple の画面で取り消した・拒否した・Apple / GoTrue の失敗 (`user_cancelled_authorize`・`access_denied`・`server_error` など) | 有効 | どれでも | Supabase が `/auth/callback?provider=apple&…&error=…` へ戻し (F-18)、コールバックが交換の前に `/login?error=` へ送る (新規登録から始めてもログイン画面)。`?error=` の値は日本語の固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE` で、ログイン画面の赤いバナーにその文が出る (Apple・GoTrue の英文を出さない。`error` の値で分けない。§12.3・§21 Q-7 (a))。セッション無し・保管無し (S-34) |
| Web ログイン (Google。本書の範囲外の参考) | — | Google の画面で取り消した (`?provider=` が付かない) | — | どれでも | `/login?error=<AUTH_LINK_ERROR_MESSAGE>` (#1917 の続きで error_description から改めた。§21 Q-7) |
| Web 新規登録 | 無し | — | — | — | ボタン無し。同意のチェックと「Googleで登録」は今までどおり (S-19) |
| Web 新規登録 | on | 同意のチェック無し | — | — | 押せない (S-18) |
| Web 新規登録 | on | 同意のチェックあり | 無効 | — | Web ログインの無効の行と同じ (Supabase が 400 の JSON。S-28) |
| Web 新規登録 | on | 同意のチェックあり | 有効 | 無し | S-17 と同じ |
| Web 新規登録 | on | 同意のチェックあり | 有効 | 同じメールの `email` / `google` | Web ログインの同じ行と同じ: 結び付け (GoTrue。新しい利用者は作らない。`app_metadata.provider` はそのまま)。振り分けは既存の `/auth/callback` の分岐 (`redirectTo` は `buildCallbackUrl()` に `provider=apple` を足した URL。§11.6)。`provider_refresh_token` があれば Services ID の行を保管 (S-4・S-5 の Web 版) |
| Web 新規登録 | on | 同意のチェックあり | 有効 | 同じ `sub` の `apple` | Web ログインの 2 回目の行と同じ (既存の利用者・Services ID の行を上書き。S-20) |
| Web ログイン・新規登録 (ボタンの高さ) | on | ブラウザの文字の大きさの設定を変えた・拡大した | — | — | Apple と Google のボタンはどちらも `style.height` = `APPLE_SIGN_IN_BUTTON_HEIGHT_PX` (56px) で同じ高さ (拡大では 2 つとも同じ比で大きくなる。§10.2) |
| 退会 | — | 行あり・秘密あり | — | — | 失効 → 削除 (S-14) |
| 退会 | — | 行あり・Apple が落ちている (すぐ失敗が返る) | — | — | 段階の時間の上限 (3 秒) の中で 2 回失敗 → warn → 削除 (S-15) |
| 退会 | — | 行あり (2 つ)・Apple が応答しない (時間切れ) | — | — | 1 行目は上限の残りで打ち切って warn (やり直さない)・2 行目は Apple を呼ばずに `failed` (warn 1 回) → 削除。段階は約 3 秒 (S-32) |
| 退会 | — | 行あり・秘密なし | — | — | 失効をスキップ (warn) → 削除 (S-26) |
| 退会 | — | 行あり・秘密鍵が壊れている (`client_secret` を作れない) | — | — | 行ごとに warn・`failed` に数える (Apple を呼ばない) → 削除 (S-27) |
| 退会 | — | 行なし | — | — | Apple を呼ばずに削除 (S-16) |
| 退会 | — | 表を読めない (`listAppleRefreshTokens` が投げた) | — | — | warn (`error_name`) → Apple を呼ばずに削除 (§12.4) |
| iOS で Apple のログインの後に WebView のタブを開く | — | iOS | — | どれでも | 既存のブリッジ (`/auth/native-bridge`) でそのまま入れる。本書は変えない (S-21) |
| メールの送信 (確認・退会の完了・通知の控え) | — | 宛先が中継のアドレス (`@privaterelay.appleid.com`) | — | — | 既存の送信 (`email_outbox` → Resend) のまま。送信ドメインを Apple に登録していれば届き、未登録なら Apple が拒む (§19.1 の 4。オーナーの作業) (S-22) |
| 既存の利用者が開く (Web / アプリ) | — | 段 D の施行日の前・予告の公開の後 (Q-13 (a)) | — | どれでも | ホームにお知らせ (改定の予告)。同意の画面は出ない (S-25) |
| 既存の利用者が開く (Web / アプリ) | — | 段 D のデプロイ (施行日) の後 | — | どれでも | 同意の画面 (2 文書とも改定あり) → 同意すると戻る (S-25) |

### 7.2 状態比較表 (現行 vs 設計後)

| 面 | 現行 | 設計後 |
|---|---|---|
| iOS ログイン画面のボタン | メールとパスワード・Google | メールとパスワード・**Apple (Google の上)**・Google。スイッチ無し / Android / 非対応端末では現行と同じ |
| iOS 新規登録画面のボタン | アカウント作成・Google で登録 | アカウント作成・**Apple で登録**・Google で登録 |
| モバイルの Google のボタンの高さ (`login.tsx`・`signup.tsx`。iOS・Android) | 中身なり: `paddingVertical` 14 × 2 + `borderWidth` 1 × 2 + 中身 (アイコン 20 と 15pt の題名の行の高さの大きいほう) = 標準の文字の大きさで約 50〜52pt。文字の大きさの設定で伸びる (F-17) | `minHeight: AUTH_PROVIDER_BUTTON_MIN_HEIGHT` (56pt) を足す: 標準の文字の大きさでは 56pt。文字の大きさの設定で伸びるのは今までどおり。`onLayout` に `onGoogleButtonLayout` を渡す (スイッチの有無・端末によらない) |
| iOS の Apple のボタンの高さ | — | Google のボタンの `onLayout` で測った高さと同じ。下限と初めの値は 56pt (`useAuthProviderButtonHeight`)。Google より低くならない (R-1) |
| ログインの後の振り分け | `login.tsx` の中の `routeAfterSignIn` | `apps/mobile/src/lib/routeAfterSignIn.ts` に移し `login.tsx`・`signup.tsx` (Apple) から呼ぶ。中身は同じ |
| モバイルの依存 | SDK 58 の 15 モジュール | + `expo-apple-authentication ~58.0.2`・`expo-crypto ~58.0.7` |
| `app.json` | `usesAppleSignIn` 無し | `ios.usesAppleSignIn: true`・`infoPlist.CFBundleAllowMixedLocalizations: true` |
| Web ログイン画面 | 「Googleで続ける」+ 案内 + メール | 「**Appleで続ける**」(スイッチ on) + 「Googleで続ける」+ 案内 (文は同じ) + メール |
| Web 新規登録画面 | 同意のチェック → 「Googleで登録」 | 同意のチェック → 「**Appleで登録**」(スイッチ on) + 「Googleで登録」 |
| Web の Google のボタンの高さ (`login/page.tsx`・`signup/page.tsx`) | `Button` の既定の `h-10` と className の `py-6` (どちらも rem。ブラウザの文字の大きさの設定で変わる) | `style.height` = `APPLE_SIGN_IN_BUTTON_HEIGHT_PX` (56px)・className は `py-0`。Apple のボタンと同じ px の高さ (スイッチの有無によらない) |
| `/auth/callback` | `code` の交換 → 振り分け。`?error=` があれば交換の前に `/login?error=<error_description (無ければ error)>` (#1917 の続きの前の形。いまは `/login?error=<AUTH_LINK_ERROR_MESSAGE>`) | 同じ。`?provider=apple` のときだけ `provider_refresh_token` を保管 (失敗しても振り分けを変えない)。`?error=` の分岐は、`?provider=apple` のときだけ `/login?error=` の値を日本語の固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE` にする (ほかの provider は `/login?error=<AUTH_LINK_ERROR_MESSAGE>`。#1917 の続きで error_description から改めた。§21 Q-7) |
| Web ログイン画面の赤いバナー (Apple の画面で取り消した後) | — (Apple のボタンが無い) | 「Apple でのログインを完了できませんでした。もう一度お試しください。」(S-34。Apple・GoTrue の英文を出さない) |
| DB | — | 表 `apple_sign_in_tokens` (RLS 有効・利用者の権限なし) |
| API | — | `POST /api/auth/apple/authorization` |
| 退会の段階 | … `billing_recheck` → `delete_user` | … `billing_recheck` → **`apple_revoke`** → `delete_user` |
| 環境変数 | — | Web: `NEXT_PUBLIC_APPLE_SIGN_IN`・`APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY`・`APPLE_SIGN_IN_SERVICES_ID`。モバイル: `EXPO_PUBLIC_APPLE_SIGN_IN` |
| レート制限の種類 | 22 種 | + `auth-apple-authorization` (利用者ごと 5 回 / 10 分) |
| プライバシーポリシー | 委託先に Google (OAuth)。版 `v2026.3` | 委託先に **Apple (ログイン)**。第3条・第10条に Apple。版 `v2026.4`。施行日 = 段 D のデプロイ日 (2026-11-01)。同じ版に cross/21 §7.12 の公開レシピの作者名の表示の文 (第8条 3 項・第9条とその見出し) も入った |
| 改定の予告 (運営のお知らせ) | `v2026.2`・`v2026.3` は予告なしで公開した (cross/20 §9.3 の除外の行) | `v2026.4` は施行日の前に `/admin/announcements` で予告を公開し、施行日に段 D をデプロイする (Q-13 は (a)。§21) |
| 設定画面のアカウント | `apple` の表示名あり (使われていない) | 同じコードが Apple の利用者に使われる (変更なし) |

### 7.3 状態遷移表

(a) iOS の Apple のログイン (画面の状態 × 操作)

| 状態 | 操作 / 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `idle` (ボタンが押せる) | ボタンを押す | `sheet` | `isSubmitting` = false | `setIsSubmitting(true)`。nonce を作る。`signInAsync` を呼ぶ |
| `sheet` | 利用者が認可 | `exchanging` | `identityToken` がある | `signInWithIdToken` |
| `sheet` | 利用者が取り消し (`ERR_REQUEST_CANCELED`) | `idle` | — | 無し (アラートを出さない。S-7) |
| `sheet` | Apple の失敗 (ほかの `ERR_*`) | `idle` | — | `Alert("Appleログイン失敗", failed)` |
| `sheet` | `identityToken` が無い | `idle` | — | `Alert("Appleログイン失敗", noIdentityToken)` (Supabase を呼ばない。S-30) |
| `exchanging` | `signInWithIdToken` が error | `idle` | — | `Alert("Appleログイン失敗", failed)` |
| `exchanging` | 成功 (名前を保存しない: `fullName` が無い、または `user_metadata.full_name` が既にある) | `after_sign_in` | — | `AuthProvider` が `SIGNED_IN` を受ける (購入の結び付け・端末名)。`updateUser` を呼ばない (S-3・S-23) |
| `exchanging` | 成功・名前の保存 (`updateUser`) が成功 | `after_sign_in` | `fullName` あり・`user_metadata.full_name` 無し | `AuthProvider` が `SIGNED_IN` を受ける。`user_metadata` に `full_name`・`given_name`・`family_name` (S-1) |
| `exchanging` | 成功・名前の保存 (`updateUser`) が error | `after_sign_in` | 同上 | `AuthProvider` が `SIGNED_IN` を受ける。`console.warn` (名前は保存されない。投げない。S-31) |
| `after_sign_in` | `registerAppleAuthorization` (成功・失敗どちらでも) | `routed` | — | 失敗は `console.warn`。`routeAfterSignIn(next)` |
| `routed` | — | (画面を離れる) | — | `setIsSubmitting(false)` (finally) |

(b) refresh token の行 (`apple_sign_in_tokens` の (user_id, client_id))

| 状態 | 操作 / 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `none` | iOS のログイン → route の交換が成功 | `stored` | 秘密あり・identity に `apple` | upsert (`client_id` = bundle ID) |
| `none` | Web のコールバック (`provider=apple`) | `stored` | `provider_refresh_token` あり・identity に `apple`・Services ID あり | upsert (`client_id` = Services ID) |
| `none` | iOS のログイン → route: 秘密なし / 秘密鍵が壊れている (`client_secret` を作れない。route は 500 `step: 'client_secret'`) / 交換の失敗 / 表に書けない | `none` | — | ログ (秘密なしは `info`・`invalid_grant` は `warn`・ほかは `internalError`。S-12・S-13) |
| `none` | Web のコールバック: `?provider=` が `apple` でない (Google のコールバック) / `user` が無い / identities に `apple` が無い / `provider_refresh_token` なし / Services ID なし / 表に書けない | `none` | — | 前の 3 つはログ無しで `skipped`。`provider_refresh_token` なし・Services ID なしは `info`、書けないは `warn` (振り分けは変えない。S-29) |
| `none` | Web: Apple の画面で取り消した・拒否した・Apple / GoTrue の失敗 (`/auth/callback?provider=apple&…&error=…`) | `none` | — | コールバックは交換の前に `/login?error=<APPLE_WEB_CALLBACK_ERROR_MESSAGE>` へ送る (`src/app/(auth)/auth/callback/route.ts:37-47` の分岐。段 B が Apple のときの文だけを替える。§7.3 (f)) ので、保管 (`storeAppleRefreshTokenFromWebCallback`) を呼ばない (S-34) |
| `stored` | 同じ入口でもう一度ログイン | `stored` | — | `refresh_token`・`updated_at` を上書き |
| `stored` | 退会 `apple_revoke` の成功 | `revoked` | 秘密あり・締め切りの前 | `/auth/revoke` 200 |
| `stored` | 退会 `apple_revoke` の失敗 (段階の時間の上限の中で最大 2 回。1 回目の時間切れで上限を使い切ったら 1 回) | `stored` (直後に消える) | 秘密あり・締め切りの前 (1 回目) | `warn` (`client_id`・`attempts`・`apple_status`・`apple_error`・`budget_exhausted`) |
| `stored` | 退会 `apple_revoke` で締め切りを過ぎた (前の行が上限を使い切った) | `stored` (直後に消える) | 締め切り ≤ 今 | Apple を呼ばない (`client_secret` も作らない)。`failed` に数える。`warn` 1 回 (`not_attempted`・`budget_ms`)。退会は続く (S-32) |
| `stored` | 退会 `apple_revoke` で秘密鍵が壊れている (`client_secret` を作れない) | `stored` (直後に消える) | 秘密あり・締め切りの前 | `warn` (`client_id`・`error_name`)。Apple を呼ばない。退会は続く (S-27) |
| `stored` | 退会 `apple_revoke` で秘密なし (`readAppleSignInServerConfig()` = null) | `stored` (直後に消える) | — | Apple を呼ばない。`warn` 1 回 (行数)。報告は `skipped: 'not_configured'`。退会は続く (S-26) |
| `stored` | 退会 `apple_revoke` で表を読めない (`listAppleRefreshTokens` が投げた) | `stored` (直後に消える) | — | Apple を呼ばない。`warn` (`error_name`)。報告は `tokens: 0`。退会は続く (§12.4) |
| `stored` / `revoked` | `delete_user` | (行なし) | — | `auth.users` の CASCADE |

(c) 利用者のアカウント (Supabase の identity)

| 状態 | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| 無し | Apple で入る (メール共有・一致する identity なし) | `apple` だけの利用者 (`provider` = `apple`) | — | `user_profiles` は同意・初期設定で作られる (既存) |
| 無し | Apple で入る (メールを隠す) | `apple` だけの利用者 (メールは中継) | — | 同上 |
| `email` の利用者 | Apple で入る (同じメールを共有) | `email` + `apple` (`provider` = `email`) | `id_token.email` が一致 | 設定画面のフォームは出続ける |
| `google` の利用者 | Apple で入る (同じメール) | `google` + `apple` (`provider` = `google`) | 同上 | — |
| `apple` を持つ利用者 | Apple で入る | 同じ利用者 | `sub` が一致 | `last_sign_in_at` の更新 |
| `apple` を持つ利用者 | 退会 | 削除 | — | 失効 → CASCADE |

(d) 段 D の公開とスイッチの工程 (オーケストレーター。cross/20 §9.4。§11.8 (i)・§15・§19.3)

| 状態 | 操作 / 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `d_passed` (段 D が 2 枚 PASS・未マージ。版 `v2026.4`・`effectiveDate` は仮置き) | 予告する (Q-13 は (a)。§21) | `notice_planned` | — | 施行日 (JST の YYYY-MM-DD) をオーナーに伺って決める |
| `d_passed` | (使わない: Q-13 (b) 予告なし。Q-13 は (a)。§21) | `ready_to_publish` | — | (使わない) |
| `notice_planned` | `/admin/announcements` でお知らせを作り公開 (`is_public` = true) | `notice_public` | 掲載の日 < 施行日 | Web とアプリのホームに出る (S-25) |
| `notice_public` | 施行日になる | `ready_to_publish` | 予告が公開のまま | — |
| `notice_planned` / `notice_public` | 別の改定が `v2026.4` を先に使う (main にマージ) | `notice_planned` | — | 段 D の版と §11.8 (g) の控えの道をその次の版に改め、お知らせの版と施行日を直す (§11.8 (i)) |
| `ready_to_publish` | `effectiveDate` を施行日に置き換え、目印を消す → 全件 → マージ・デプロイ | `published` | 目印の `git grep` が 0 行 (§11.8 (f)) | 版 `v2026.4` が出る → 既存の利用者に再同意 (S-25) |
| `published` | オーナーが §19.3 のサーバの秘密 (iOS と Web の `APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY`。Web を出すならそれと `APPLE_SIGN_IN_SERVICES_ID`) を Vercel の本番に入れて再デプロイ (段 A1・段 B のデプロイの後に入れてあればそのまま) → オーケストレーターとオーナーがスイッチの前の確認 (§19.3) の 1〜3 を流す (3 は EAS の preview にだけ `EXPO_PUBLIC_APPLE_SIGN_IN=on` を入れた内部配布のビルドで、オーナーが 1 回入る) | `secrets_verified` | 1〜3 がすべて通る: 名前が Vercel の Production にある・今の本番のデプロイがその後に作られた・確認のログインの後に本番の `apple_sign_in_tokens` に `client_id = 'com.homegohan.app'` の行ができ、その時刻のログに `not_configured` の `info` と route の 500 (`step` = `client_secret` / `exchange` / `store`) が無い (= 本番で `readAppleSignInServerConfig()` が null でなく、秘密鍵で `client_secret` を作れ、Apple の交換が通る) | 本番にオーナーの行が 1 つできる (オーナーが退会すれば §9.3 で失効して消える) |
| `published` | 確認の 1〜3 のどれかが通らない | `published` | — | §19.3 の確認の表の「通らないとき」の列で直す値を見分け、入れ直して再デプロイ → もう一度 1 から |
| `secrets_verified` | §19.3 の秘密 (Team ID・Key ID・秘密鍵) を入れ替える・消す | `published` | — | もう一度 1 から |
| `secrets_verified` | Vercel に `NEXT_PUBLIC_APPLE_SIGN_IN=on` (段 B の後) を入れて再デプロイ / EAS の production に `EXPO_PUBLIC_APPLE_SIGN_IN=on` を入れたビルド | `apple_public` | §19.2 の 1〜3 (Web)・1〜2 (iOS) が済んでいる。Web のスイッチは、確認の 1・2 に `APPLE_SIGN_IN_SERVICES_ID` が入っていたときだけ (iOS だけを先に出し、後から Web を出すときは、Services ID を入れて再デプロイし、1・2 をもう一度流してから) | Apple のボタンが出る |
| `published` | スイッチ (Vercel の `NEXT_PUBLIC_APPLE_SIGN_IN`・EAS の production の `EXPO_PUBLIC_APPLE_SIGN_IN`) を on にする | (遷移しない。行わない) | スイッチの前の確認 (§19.3) が通るまでは on にしない (R-8): 秘密が無い・効いていない・壊れている間に Apple で入った人は、route が 200 `not_configured` か 500 を返し (Web は Services ID が無いと保管しない)、refresh token の行が残らない (S-12・S-29)。行を作り直す道はその人がまた Apple で入ること (S-3) だけで、その人の退会では Apple を呼ばずに消える (S-16) | — |
| `apple_public` | ストアへ提出 | (審査) | — | §19.5 |
| `d_passed` / `notice_planned` / `notice_public` / `ready_to_publish` | スイッチを on にする (スイッチの前の確認の preview のビルドを含む) | (遷移しない。行わない) | 段 D のデプロイ (施行日) の前は on にしない (R-16)。確認のビルドも `published` になってから作る | — |

(e) iOS の Apple のボタンの高さ (`useAuthProviderButtonHeight` の `height`。ログイン画面と新規登録画面でそれぞれ 1 つ)

| 状態 | 操作 / 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| (画面を開く前) | 画面を描く | `min` (`height` = 56) | — | Google のボタンは `minHeight` 56。Apple のボタンは出す条件を満たせば `style.height` = 56 で描く |
| `min` | Google のボタンの `onLayout` (測った高さ h ≤ 56。標準の文字の大きさ) | `min` | — | `setHeight(56)` (同じ値なので描き直さない) |
| `min` | Google のボタンの `onLayout` (h > 56。文字の大きさの設定を大きくした) | `grown(h)` | — | Apple のボタンの `style.height` = h (S-33) |
| `grown(h)` | Google のボタンの `onLayout` (h' > 56) | `grown(h')` | — | Apple のボタンの `style.height` = h' |
| `grown(h)` | Google のボタンの `onLayout` (h' ≤ 56。標準に戻した) | `min` | — | Apple のボタンの `style.height` = 56 (S-33) |
| `min` / `grown(h)` | Apple のボタンを出さない (スイッチ無し・Android・非対応端末) | (同じ) | — | `height` は使われない。Google のボタンは `minHeight` 56 のまま |

(f) Web の Apple のログイン・登録のコールバック (段 B。`/auth/callback` とログイン画面。F-18)

| 状態 | 操作 / 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `apple_page` (Apple の画面。`redirectTo` = `/auth/callback?provider=apple&next=…`) | 利用者が認可 → Supabase が `?provider=apple&next=…&code=…` で戻す | `exchanging` | — | — |
| `apple_page` | 利用者が取り消す・拒否する、または Apple / GoTrue が失敗する → Supabase が `?provider=apple&next=…&error=…&error_description=…` で戻す | `login_with_banner` | `?error=` がある・`?provider=` が `apple` | `/login?error=<APPLE_WEB_CALLBACK_ERROR_MESSAGE>` へ redirect。交換と保管をしない (S-34) |
| `apple_page` | Supabase が flow state を読めない (期限切れ・使用済み・`state` が無い) | (Site URL。`/auth/callback` を通らない) | — | 既存 (GoTrue の `loadFlowState`。本書は変えない。F-18) |
| `exchanging` | `exchangeCodeForSession` が成功 | (振り分け: 同意画面・`next`・`/home` など。既存) | — | `storeAppleRefreshTokenFromWebCallback` ((b) の表) |
| `exchanging` | `exchangeCodeForSession` が失敗 | (`/login`。既存。バナーの文なし) | 既存のセッションが無い | 保管しない (§12.3) |
| `login_with_banner` | ログイン画面の `useEffect` | `login_idle` (バナーあり) | `?error=` がある | `setError(decodeURIComponent(…))` (固定の文はそのまま)・URL から `error` を消す (既存。`login/page.tsx:59-68`) |
| (Google のコールバック。`?provider=` が無い) | `?error=` で戻る | (`/login`。既存) | `?provider=` が `apple` でない | `/login?error=<AUTH_LINK_ERROR_MESSAGE>` (#1917 の続きで error_description から改めた。§21 Q-7) |

## 8. データモデル

### 8.1 表 `apple_sign_in_tokens` (新設)

Apple が発行した refresh token を、退会のときに失効させるためだけに保管する。利用者は読めず、書けない (RLS 有効・ポリシー無し・`anon` / `authenticated` / `PUBLIC` の権限を外す)。読み書きは service_role の client (`getSupabaseAdmin()`) だけ。退会で `auth.users` の行が消えると CASCADE で消える。利用者へのデータの書き出し (`src/lib/account-export-tables.ts`) には含めない (本人に返す意味が無く、返すと失効に使える値が外へ出る)。

ファイル名は `supabase/migrations/20261024100000_apple_sign_in_tokens.sql` (番号はマージの直前に origin/main の `supabase/migrations` の最大より大きい値で確定した)。対の戻し口は `supabase/rollbacks/20261024100000_apple_sign_in_tokens.down.sql`。

```sql
-- migration: 20261024100000_apple_sign_in_tokens.sql
-- 戻し方: supabase/rollbacks/20261024100000_apple_sign_in_tokens.down.sql
-- Sign in with Apple (docs/design/mobile/08-sign-in-with-apple.md §8): Apple が発行した refresh token を、退会のときに
-- Apple の失効の API (/auth/revoke) へ渡すためだけに保管する表。client_id は token を得た client (iOS の bundle ID か Web の Services ID)
-- で、失効のときの client_secret の sub に使う。
-- 読み書きは service_role の client だけ (src/lib/auth/apple/tokens.ts)。利用者 (anon / authenticated) は読めず書けない。
-- 退会で auth.users の行が消えると CASCADE で消える (失効は src/lib/account-deletion.ts の段階 apple_revoke が delete_user の前に行う)。
-- 権限の定型 (#1039/#1020): 新しい表には既定の権限で anon / authenticated に権限が付くので REVOKE ALL で外す。service_role は既定のまま。
-- 既存データへの影響: なし (表を作るだけ)。冪等: CREATE TABLE IF NOT EXISTS。
-- 確認: tests/apple-sign-in-tokens-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.apple_sign_in_tokens (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  refresh_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, client_id)
);

ALTER TABLE public.apple_sign_in_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.apple_sign_in_tokens FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.apple_sign_in_tokens IS
  'Sign in with Apple の refresh token (退会のときの失効に使う。docs/design/mobile/08-sign-in-with-apple.md §8)。client_id は token を得た client (bundle ID / Services ID)。service_role だけが読み書きする。auth.users の削除で消える';
```

```sql
-- rollback: 20261024100000_apple_sign_in_tokens.sql
-- Sign in with Apple の refresh token の表を外す。本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。
-- ⚠️ 先にアプリを戻すこと: src/lib/auth/apple/tokens.ts が表を読み書きする (無ければ保管と失効が失敗のログになるだけで、ログインと退会は止まらない)。
-- 影響: 保管していた refresh token は消え、その利用者の退会では Apple 側の失効を行えなくなる。
-- 何度流しても同じ結果になる (DROP ... IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS public.apple_sign_in_tokens;
```

`user_id` は `auth.users` を指す外部キー (`ON DELETE CASCADE`) なので、段 A1 で `tests/integration/security/auth-users-fk-on-delete.test.ts` の `EXPECTED_ACTIONS` に `'apple_sign_in_tokens.user_id': 'CASCADE'` を注つきで足す (注: 「mobile/08-sign-in-with-apple §8.1: 退会のときの失効にだけ使う値なので、本人と一緒に消す」。足さないと D0 が `notListed` で赤になる。§17)。

migration を足したら `src/types/database.types.ts` と `packages/shared/src/database.types.ts` を作り直す (手順は `tests/database-types-migrations-contract.test.ts` の冒頭。テスト用の機械 (offload の行き先) で流す)。

### 8.2 ほかの表・列は変えない

`auth.identities` (GoTrue が書く)・`user_profiles`・`user_sessions_metadata` は変えない。名前は `auth.users.raw_user_meta_data` の `full_name` (GoTrue の既存の置き場。`src/lib/user-display.ts:25` が表示の予備として読む)。

## 9. 流れと API

### 9.1 iOS のネイティブのログイン (シーケンス)

```mermaid
sequenceDiagram
    actor U as 利用者
    participant S as login.tsx / signup.tsx
    participant L as appleSignIn.ts
    participant A as Apple (ASAuthorization)
    participant G as Supabase Auth (GoTrue)
    participant W as Web API (Next.js)
    participant DB as apple_sign_in_tokens

    U->>S: Apple のボタンを押す
    S->>L: signInWithApple()
    L->>L: raw = randomUUID(), hashed = sha256(raw)
    L->>A: signInAsync({ FULL_NAME, EMAIL, nonce: hashed })
    A-->>L: credential (identityToken, authorizationCode, fullName?, email?)
    L->>G: signInWithIdToken({ provider: 'apple', token: identityToken, nonce: raw })
    G-->>L: session (新規 / 既存 / 結び付け)
    Note over L: fullName があり user_metadata.full_name が無ければ updateUser
    L->>W: POST /api/auth/apple/authorization { authorization_code } (Bearer)
    W->>A: POST /auth/token (client_id = bundle ID, client_secret, code)
    A-->>W: refresh_token
    W->>DB: upsert (user_id, bundle ID, refresh_token)
    W-->>L: 200 { stored: true } (失敗は warn だけ)
    L-->>S: { status: 'signed_in' }
    S->>S: routeAfterSignIn(next)
```

- `routeAfterSignIn` は `login.tsx:76-100` の関数を `apps/mobile/src/lib/routeAfterSignIn.ts` に移す (中身は変えない。`login.tsx` のメールとパスワードのログイン・Google ログインも移した関数を呼ぶ)。
- `AuthProvider` は `SIGNED_IN` を既存どおり受ける (購入の結び付け・端末名の登録・同意のゲート)。本書は変えない。

### 9.2 `POST /api/auth/apple/authorization` (新設)

iOS が `signInWithIdToken` のあとに呼ぶ。認可コードを Apple の交換の API に渡し、refresh token を保管する。

| 項目 | 内容 |
|---|---|
| 認証 | `requireSessionUser(supabase, request.headers.get('authorization'))` (Bearer。`user_profiles` の行が無い新規の利用者も通る) |
| 本文 | `{ "authorization_code": string }` (`AppleAuthorizationBodySchema`。1〜1024 文字) |
| 順 | `rejectNullCharacterBody` → `readJsonBody` + schema (違えば 400 `VALIDATION_ERROR`) → `requireSessionUser` (401 / 403) → `checkRateLimit(user.id, 'auth-apple-authorization')` (429) → identity に `apple` が無ければ 409 `APPLE_IDENTITY_NOT_LINKED` → `registerAppleAuthorization` |
| 200 | `{ "stored": true }` / `{ "stored": false, "reason": "not_configured" }` (サーバの秘密が無い。info のログ) |
| 400 | `VALIDATION_ERROR` (本文の形)・`INVALID_CHARACTER` (NULL 文字)・`APPLE_AUTHORIZATION_CODE_INVALID` (Apple が `invalid_grant` = 期限切れ・使用済み・別の client のコード) |
| 401 / 403 | `sessionsFailure` と同じ (`AUTH_UNAUTHENTICATED` / `AUTH_ACCOUNT_FROZEN`) |
| 409 | `APPLE_IDENTITY_NOT_LINKED` (この利用者は Apple で入っていない) |
| 429 | `RATE_LIMITED` (`rateLimitExceededResponse`) |
| 500 | `internalError` (秘密鍵が壊れていて `client_secret` を作れない・Apple に届かない・応答が壊れている・DB の失敗。本文は固定の文。ログに段階 `client_secret` / `exchange` / `store`) |
| ヘッダ | `Cache-Control: private, no-store` |
| ログ | 認可コード・refresh token・secret は出さない。残すのは `request_id`・`client_id`・段階・Apple の HTTP status・`error` の値 (`invalid_grant` など。`error_description` は出さない) |

`runtime = 'nodejs'`・`dynamic = 'force-dynamic'`。`src/__tests__/api/null-character-routes.test.ts` の表に `auth/apple/authorization/route.ts` (POST) を足す。

### 9.3 退会の段階 `apple_revoke`

`deleteAccount` (`src/lib/account-deletion.ts`) の `billing_recheck` の後・`delete_user` の前に置く。差し替え口は Stripe (`params.billing`) と同じ形で `params.appleRevocation` (`AccountDeletionAppleRevocation`。省略時の既定は `createAccountDeletionAppleRevocation({ admin: () => admin })` で、`deleteAccount` に渡された `admin` で表を読む。§11.4)。

```mermaid
sequenceDiagram
    participant D as deleteAccount
    participant R as revocation.ts
    participant DB as apple_sign_in_tokens
    participant A as Apple /auth/revoke

    D->>R: revokeForAccountDeletion(userId, log, requestId)
    Note over R: 締め切り = 今 + APPLE_REVOKE_TOTAL_BUDGET_MS (3 秒。§13.1)
    R->>DB: 行を全部読む (user_id)
    alt 行が無い
        R-->>D: { tokens: 0, revoked: 0, failed: 0, skipped: null }
    else 秘密が無い
        R-->>D: { tokens: n, revoked: 0, failed: 0, skipped: 'not_configured' } (warn)
    else
        loop 行ごと (行ごとの処理は try の中。client_secret を作れなければ Apple を呼ばず failed に数えて warn)
            alt 締め切りを過ぎた
                R->>R: Apple を呼ばず failed に数える (not_attempted)
            else
                R->>A: POST (client_id = 行の client_id, client_secret(sub = client_id), token, token_type_hint = refresh_token。待ちは min(APPLE_API_TIMEOUT_MS, 残り))
                A-->>R: 200 (既に無効でも 200) / 失敗 → 締め切りの前なら 1 回だけやり直し
            end
        end
        R-->>D: { tokens: n, revoked: k, failed: n - k, skipped: null } (失敗した行ごとに warn。呼ばなかった行があれば warn 1 回)
    end
    D->>D: step = 'delete_user' → auth.admin.deleteUser (CASCADE で行も消える)
```

- `revokeForAccountDeletion` は例外を投げない (中で全部受け止める)。退会の結果は変えない。表の読み取り (`listAppleRefreshTokens`) と、行ごとの処理 (`client_secret` の作成 (`createPrivateKey`・`sign` は PEM が壊れていると投げる) と失効) をそれぞれ `try` で囲む。秘密鍵の書き間違い (`\n` の誤り・ヘッダの欠け・別の鍵) でも、その行を `failed` に数えて `warn` にし、次の行・`delete_user` へ進む。
- 段階全体 (表の読み取りから最後の行まで) の時間は `APPLE_REVOKE_TOTAL_BUDGET_MS` (3 秒) まで (計算は §13.1: 退会の route の `maxDuration` 60 秒に収める)。締め切りは段階の入口で 1 回決める。試行ごとの待ち (`AbortSignal.timeout`) は `APPLE_API_TIMEOUT_MS` と締め切りまでの残りの短いほう。締め切りを過ぎたら、やり直しも次の行の失効もしない。残りの行は `client_secret` も作らず `failed` に数え、`warn` を 1 回 (`not_attempted`・`budget_ms`) 出す。Apple が応答しなくても段階は約 3 秒で終わり、`delete_user` へ進む (裁定 2・S-15・S-32)。
- 行の削除はしない (CASCADE に任せる。失効に失敗した行も `deleteUser` で消える)。
- `AccountDeletionStep` に `'apple_revoke'` を足す (ログの `step` に使う。失敗で返す段階にはならない)。成功のログ `account deleted` の metadata に `apple: report` を足す。

### 9.4 既存のアカウントとの関係・名前・メールの中継

| 事項 | 挙動 (本書は GoTrue の挙動を前提にし、コードで上書きしない) |
|---|---|
| 同じメールの既存の利用者 | GoTrue が `id_token.email` を Verified として扱い、同じ linking domain (`email` / `google` / `apple` は全部 `default`) の identity・利用者に結び付ける (F-15)。新しい利用者は作らない。`app_metadata.provider` は最初の provider のまま、`providers` に `apple` が増える。設定画面の分岐 (`provider === "email"`) は変えない |
| メールを隠した (中継) | `auth.users.email` が中継のアドレスになる。一致する利用者が無いので新規。アプリは別のメールを求めない (HIG)。設定画面は中継のアドレスをそのまま表示 (F-7 の `email`) |
| 名前 (iOS) | `credential.fullName` の `givenName`・`familyName` を `"<family> <given>"` の順ではなく、Supabase の例と同じ `"<given> <family>"` で `full_name` にし、`given_name`・`family_name` も `user_metadata` に入れる。`signInWithIdToken` の `data.user.user_metadata.full_name` が空のときだけ `updateUser` (既にある名前を Apple の値で上書きしない)。失敗は `console.warn` (ログインは止めない) |
| 名前 (Web) | Apple の `user` パラメータ (初回だけ) を GoTrue が `full_name`・`name` に入れる (`provider/apple.go` の `ParseUser`)。コードは書かない |
| 名前の使い道 | `src/lib/user-display.ts:25` (`resolveDisplayName` の予備)。ニックネームは初期設定で入れる (既存) |
| 2 回目の確認 (開発) | Apple が名前・メールをもう一度返すのは、iPhone の設定 → Apple アカウント → サインインとセキュリティ → Apple でサインイン → このアプリ → 「Apple でサインインの使用を停止」のあとだけ (S-23) |
| 中継のアドレスへのメール | 既存の送信 (`email_outbox` → Resend) のまま。Apple の中継は、登録した送信ドメインからのメールだけを通す (§19.1 の 4)。1 アドレス 1 日 100 通の上限 (F-14) は、本アプリの送信量 (確認・退会の完了・通知の控え) では届かない |

### 9.5 Web のログイン (段 B) とコールバック

```mermaid
sequenceDiagram
    actor U as 利用者
    participant P as login/page.tsx
    participant G as Supabase Auth
    participant A as Apple
    participant C as /auth/callback
    participant DB as apple_sign_in_tokens

    U->>P: 「Appleで続ける」
    P->>G: signInWithOAuth({ provider: 'apple', options: { redirectTo: origin + '/auth/callback?provider=apple&next=…' } })
    G->>A: appleid.apple.com/auth/authorize
    alt 利用者が認可
        A-->>G: /auth/v1/callback (form_post。初回だけ user = 名前)
        G-->>C: /auth/callback?provider=apple&code=…
        C->>G: exchangeCodeForSession(code)
        G-->>C: session (provider_refresh_token があれば) + user (identities)
        C->>DB: provider=apple かつ provider_refresh_token かつ identities に apple かつ Services ID あり → upsert (user_id, Services ID)
        C-->>U: 既存の振り分け (初めてなら同意画面 #1435)
    else 取り消し・拒否・Apple / GoTrue の失敗 (S-34)
        A-->>G: /auth/v1/callback (error=…)
        G-->>C: /auth/callback?provider=apple&next=…&error=…&error_description=… (F-18)
        C-->>U: /login?error=APPLE_WEB_CALLBACK_ERROR_MESSAGE (交換・保管なし。ログイン画面の赤いバナーに固定の文)
    end
```

- `redirectTo` に `provider=apple` を足すのは Web の Apple のボタンだけ (Google は変えない)。`/auth/callback` の既存の分岐 (`code` / `token_hash` / `token`・同意画面・`next`) は変えず、`code` の交換が成功したあとに `storeAppleRefreshTokenFromWebCallback` (§11.3) を 1 回呼ぶ。失敗は `warn` で振り分けを変えない。
- `provider_refresh_token` が無いとき (GoTrue が返さなかった。§21 Q-6) は保管しない (`info` のログ)。退会のときはその入口の失効をスキップする (iOS で入ったことのある人は iOS の行で失効する)。
- `?error=` で戻ったとき (Apple の画面で取り消した・拒否した・Apple / GoTrue の失敗。S-34): 既存の分岐 (`src/app/(auth)/auth/callback/route.ts:37-47`) は交換の前に `/login?error=` へ送る。段 B はこの分岐の `?error=` の値だけを、`?provider=apple` のときに日本語の固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE` に替える (`appleCallbackErrorMessage`。§11.6)。`error` の値 (Apple と GoTrue が決める) では分けない。`?provider=` が `apple` でない (Google など) ときとメールのリンクの `?error=` は、`error_description` ではなく固定の文 `AUTH_LINK_ERROR_MESSAGE` (`packages/shared/src/auth-link-error.ts`) を入れる (§21 Q-7。#1917 の続きで今までの `error_description` を改めた)。ログ (`console.error` の `error`・`description`・`code`) は今までどおり。

### 9.6 プライバシーポリシー (段 D)

委託先の表に Apple (ログイン) を足し、第3条のアカウントの行と第10条の外部送信の表に Apple を足し、両文書の版を `v2026.4` に上げる (内容が変わる改定。cross/20 §9.3)。差分は §11.8。版を上げる改定なので、施行日の前に運営のお知らせに改定の予告を載せる (cross/20 §9.4 の 2。§11.8 (i)。Q-13 は (a)。§21)。公開の順は §15 と §7.3 (d) (施行日の前に予告 → 施行日に段 D をデプロイ → サーバの秘密を入れてスイッチの前の確認 (§19.3) → スイッチを on にしたビルド / デプロイ)。2 文書の版は同じ値で動く (`tests/legal-text-1901.test.ts` の T-17) ので、施行日の後に開いた既存の利用者には 2 文書とも再同意が出る (本番の `auth.identities` は 194 件。F-13)。

同じ版 `v2026.4` には、cross/21 §7.12 の公開レシピの作者名の表示の文 (第8条 3 項に 1 文・第9条に 3 項と見出し「第9条（家族グループ、組織、公開したレシピでの見え方）」。主張の表 +7) も入った (cross/21 §21 Q-1 は (a))。段 D は PR #1997 (`3193a2fa`) で施行日 2026-11-01 に公開した。

## 10. 画面

### 10.1 iOS (`apps/mobile/app/(auth)/login.tsx`・`signup.tsx`)

| 項目 | 内容 |
|---|---|
| 置き場所 | 「または」の区切りの下、Google のボタンの上 (HIG: 積むときは Apple を上に。R-1) |
| 部品 | `apps/mobile/src/components/auth/AppleSignInButton.tsx` (§11.5)。`AppleAuthentication.AppleAuthenticationButton` を使う (Apple の見た目・OS の言語の題名・VoiceOver の読み上げが付く) |
| 種類 | ログイン画面 `SIGN_IN` (題名は OS が「Apple でサインイン」)・新規登録画面 `SIGN_UP` (「Apple で登録」) |
| 見た目 | `buttonStyle` = `WHITE_OUTLINE` (白い背景 `colors.bg` の上。Google のボタンと同じ白の枠)・`cornerRadius` = `radius.lg`・幅 100% (Google のボタンと同じ幅。最小 140pt を満たす) |
| 高さ (Apple と Google をそろえる) | Apple のボタンの高さ = 同じ画面の Google のボタンの実際の高さ (`useAuthProviderButtonHeight`。Google の `Pressable` の `onLayout` で測り、下限と初めの値は `AUTH_PROVIDER_BUTTON_MIN_HEIGHT` = 56)。Google のボタンには `minHeight: AUTH_PROVIDER_BUTTON_MIN_HEIGHT` を足す (`paddingVertical: 14`・`borderWidth: 1` は残す)。Google のボタンの中身なりの高さは標準の文字の大きさで約 50〜52pt (F-17) なので、標準では 2 つともちょうど 56pt で並ぶ (Apple のボタンが測った高さを待たずに同じ高さで出る)。文字の大きさの設定で Google が伸びたら Apple も同じ高さになる (S-33・§7.3 (e))。OS が描く Apple のボタンの高さは `style` でしか決まらない (F-16) ので、測った高さを渡す。56 は Web のボタンの高さ (§10.2) と HIG の例と同じで、最小 30pt を満たす |
| 出す条件 | `isAppleSignInEnabled()` (iOS かつスイッチ `on`) かつ `isAvailableAsync()` = true。満たさないときは何も描かない (余白も出さない) |
| 押せない条件 | `isSubmitting` (Google・メールと同じ。`pointerEvents="none"` + `opacity 0.7`) |
| 失敗の表示 | `Alert.alert("Appleログイン失敗", message)` / `Alert.alert("Apple登録失敗", message)` (Google の `"Googleログイン失敗"` と同じ形)。取り消しは何も出さない |
| testID | `login-apple-button`・`signup-apple-button` |

### 10.2 Web (`src/app/(auth)/login/page.tsx`・`signup/page.tsx`)

| 項目 | 内容 |
|---|---|
| 置き場所 | Google のボタンの上 (同じ `space-y-4` の中) |
| 部品 | `src/components/auth/AppleSignInButton.tsx` (§11.6)。自作のボタン (Apple の JS のボタンは Apple 自身の認可の流れに結び付くので使わない) |
| 題名 | ログイン画面「Appleで続ける」・新規登録画面「Appleで登録」(HIG の Continue / Sign up に当たる日本語。Google の「Googleで続ける」「Googleで登録」と対) |
| 見た目 | 黒い背景・白いロゴと文字 (HIG の Black。白い背景の上)。高さ 56px (`APPLE_SIGN_IN_BUTTON_HEIGHT_PX`。`style` の px)・文字 24px (高さの 43%。HIG の例 56pt / 24pt)・太字・角丸 `rounded-xl` (Google と同じ)。ロゴは Apple が URL で配る「ロゴだけのボタン」の画像 (F-14。黒の正方形の中央に白いロゴ・余白つきの PNG) を `public/auth/apple-logo-on-black.png` に置き、ボタンの高さと同じ 56px の正方形で描く (切らない・上下の余白を足さない。画像の黒はボタンの黒と同じなので境目は見えない)。取り方は §11.6 (実装者がコマンド 1 つで取る。オーナーの作業は要らない)。Google のボタンは className の `py-6` を `py-0` に替え、`style={{ height: APPLE_SIGN_IN_BUTTON_HEIGHT_PX }}` を足して高さをそろえる (Apple のボタンをほかより小さくしない)。2 つとも同じ px の定数にするのは、Tailwind の高さ・余白のクラス (`h-14`・`py-6` など) が rem で、ブラウザの文字の大きさの設定 (ルートの文字の大きさ。本アプリの CSS は決めていない: `src/app/globals.css`) で変わり、px の Apple のボタンと高さがずれるため (拡大は 2 つとも同じ比で大きくなる)。`py-0` は、文字の大きさの設定を大きくしても Google の中身 (アイコン `w-5 h-5` と `text-sm` の題名。どちらも rem) が 56px に収まるようにするため |

| 出す条件 | `isAppleSignInEnabled()` (スイッチ `on`)。無ければ描かない |
| 押せない条件 | ログイン画面: `isLoading`。新規登録画面: `isLoading` または `!agreedToLegal` (Google と同じ。R-14) |
| 失敗の表示 | 既存の赤いバナー (`setError` / `setFormError`)。文は「Apple でのログインに失敗しました。しばらくしてからお試しください。」「Apple での登録に失敗しました。しばらくしてからお試しください。」(`signInWithOAuth` が error を返したとき)。Apple の画面で取り消した・Apple / GoTrue の失敗で戻ったときはログイン画面のバナーに「Apple でのログインを完了できませんでした。もう一度お試しください。」(`APPLE_WEB_CALLBACK_ERROR_MESSAGE`。下の `?error=` の行) |
| 案内 | ログイン画面の `login-google-legal-note` (「はじめての方は、続けたあとに…同意の画面が出ます。」) は Apple と Google の両方の下に 1 つ (文は変えない。`data-testid` も変えない) |
| testID | `login-apple-button`・`signup-apple-button` |
| `?error=` | コールバックが `/login?error=` に戻す既存の経路を使う。`?provider=apple` のコールバックでは `?error=` の値を日本語の固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE` にする (Apple・GoTrue の英文 (`error_description` の文や、`user_cancelled_authorize` などの `error` の値) を出さない。新規登録画面から始めてもログイン画面に出る。S-34・§21 Q-7)。ログイン画面のコード (`login/page.tsx:59-68` の表示) は変えない |

### 10.3 設定画面のアカウント (変えない)

`providerLabel("apple")` = 「Apple」(F-7)。Apple だけの利用者には `ExternalProviderGuidance` が「Apple アカウントでログインしています」とメール (中継のアドレスを含む) を出す。結び付いた利用者 (`provider` = `email`) にはパスワードのフォームが出る。本書はコードを変えない。

## 11. 正典コード (Zod・型・定数・facade 契約)

書き方: `// tsc:skip` の無いブロックは単独で型検査を通る。新設モジュール同士の import や、まだ無い依存 (`expo-apple-authentication`・作り直す前の `database.types.ts`・一覧に足す前の `getOptionalEnv` の名前) を持つブロックは 1 行目を `// tsc:skip`、2 行目を `// place=<置き場所>` にする。実装者はその置き場所に置き、リポジトリ全体で `tsc` に掛ける。

### 11.1 共有の定数と文 (`packages/shared/src/apple-sign-in.ts`。新設)

Web とモバイルの両方が読む (`@homegohan/shared`)。`packages/shared/src/index.ts` に `export * from './apple-sign-in';` を足す。

```ts
/**
 * Sign in with Apple の共有の定数と固定の文 (docs/design/mobile/08-sign-in-with-apple.md §11.1)。
 * Web (NEXT_PUBLIC_APPLE_SIGN_IN) とモバイル (EXPO_PUBLIC_APPLE_SIGN_IN) のスイッチの読み方を 1 つにする
 * (lib/legal-consent.ts の isLegalConsentFlagOn と同じ: 明示的に on と書いたときだけ有効。大文字小文字と前後の空白は区別しない)。
 */

/** スイッチを有効とみなす値 */
export const APPLE_SIGN_IN_FLAG_ON = 'on';

/** スイッチの値が on か (未設定・空・それ以外の語は off) */
export function isAppleSignInFlagOn(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === APPLE_SIGN_IN_FLAG_ON;
}

/**
 * Apple の認可コード (authorizationCode) の長さの上限。Apple のコードは数百文字で、1,024 を超えることは無い
 * (超える値は本文の形の誤りとして 400 にする。POST /api/auth/apple/authorization の AppleAuthorizationBodySchema)
 */
export const APPLE_AUTHORIZATION_CODE_MAX_LENGTH = 1024;

/** 利用者に見せる固定の文 (Apple・GoTrue の英文は出さない) */
export const APPLE_SIGN_IN_MESSAGES = {
  /** Apple のシートは通ったが Supabase のセッションにできなかった (provider が無効・nonce の不一致・通信の失敗) */
  failed: 'Apple でのログインに失敗しました。しばらくしてからお試しください。',
  /** 新規登録画面の同じ失敗 */
  signupFailed: 'Apple での登録に失敗しました。しばらくしてからお試しください。',
  /** Apple が identityToken を返さなかった */
  noIdentityToken: 'Apple からログインの情報を受け取れませんでした。もう一度お試しください。',
} as const;
```

### 11.2 サーバの設定と client secret (`src/lib/auth/apple/config.ts`・`client-secret.ts`。新設)

```ts
// tsc:skip
// place=src/lib/auth/apple/config.ts
/**
 * Sign in with Apple のサーバ側の設定 (docs/design/mobile/08-sign-in-with-apple.md §11.2)。サーバ専用 (秘密を持つ)。
 * 4 つの環境変数は任意 (src/lib/env.ts の一覧)。Team ID・Key ID・秘密鍵のどれかが無ければ「未設定」で、交換と失効を行わない
 * (ログインは止めない)。Services ID は Web の OAuth の行にだけ要る。
 */
import { getOptionalEnv } from '@/lib/env';

/** iOS のアプリの client_id (= apps/mobile/app.json の ios.bundleIdentifier。src/__tests__/lib/auth/apple/config.test.ts が突き合わせる) */
export const APPLE_SIGN_IN_NATIVE_CLIENT_ID = 'com.homegohan.app';
/** 交換の API (F-14) */
export const APPLE_TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
/** 失効の API (F-14) */
export const APPLE_REVOKE_ENDPOINT = 'https://appleid.apple.com/auth/revoke';
/** client_secret の aud (F-14) */
export const APPLE_CLIENT_SECRET_AUDIENCE = 'https://appleid.apple.com';
/**
 * client_secret の有効期間 (秒)。要求のたびに作り直すので短くてよい。Apple の上限は 6 か月 (15,777,000 秒)。
 * 5 分 = サーバとの時計のずれ (数十秒) に耐え、漏れたときの使える時間を短くする
 */
export const APPLE_CLIENT_SECRET_TTL_SECONDS = 300;
/**
 * Apple の API の 1 回の応答を待つ最長 (ミリ秒)。ふだんは 1 秒以内。Turnstile の確認 (TURNSTILE_VERIFY_TIMEOUT_MS) と同じ 5 秒。
 * 交換 (/auth/token) はこの値。失効 (/auth/revoke) はこの値と、退会の段階の締め切りまでの残りの短いほう (APPLE_REVOKE_TOTAL_BUDGET_MS)
 */
export const APPLE_API_TIMEOUT_MS = 5000;
/**
 * 失効の試行の回数 (1 回目が失敗ならもう 1 回。失敗の種類 (通信の失敗・時間切れ・4xx・5xx) は区別しない)。
 * 2 回目も APPLE_REVOKE_TOTAL_BUDGET_MS の締め切りの前だけ試す (締め切りを過ぎたらやり直さない)
 */
export const APPLE_REVOKE_ATTEMPTS = 2;
/**
 * 退会の段階 apple_revoke 全体 (表の読み取りから最後の行の失効まで) に使ってよい時間 (ミリ秒)。設計書 §13.1 の計算:
 * 退会の route (src/app/api/account/delete/route.ts) の maxDuration 60 秒 − Storage の掃除の上限 45 秒
 * (src/lib/account-deletion-storage.ts の DEFAULT_MAX_DURATION_MS) − 完了メールの待ちの上限 5 秒
 * (src/lib/account-deletion-notification.ts の ACCOUNT_DELETED_EMAIL_TIMEOUT_MS) = 10 秒を、段階全体の上限を持たない段階
 * (DB の関数・Stripe・deleteUser。Stripe は 1 回の呼び出しに上限があるが段階全体の上限は無い) と分け合う。Apple に 3 秒、ほかの段階に 7 秒を残す。
 * 締め切りを過ぎた行は Apple を呼ばずに failed に数える (Apple の障害で退会の route の時間を超えない。裁定 2)。
 * 環境変数にしない: 3 つの上限と組で決まる値で、これだけを上げるとほかの段階の分 (7 秒) が減り、60 秒を超えうる (src/__tests__/lib/auth/apple/config.test.ts が 3 つの和 < 60 秒を確かめる)
 */
export const APPLE_REVOKE_TOTAL_BUDGET_MS = 3000;

export interface AppleSignInServerConfig {
  readonly teamId: string;
  readonly keyId: string;
  /** PEM (-----BEGIN PRIVATE KEY----- …)。環境変数には改行を \n と書いて入れる (ここで戻す) */
  readonly privateKeyPem: string;
  /** Web の OAuth の client_id (Services ID)。無ければ null (Web の行は保管・失効しない) */
  readonly servicesId: string | null;
}

/** 環境変数の値の改行の書き方 (\n) を実際の改行に戻す */
function pemOf(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

/** 秘密がそろっていれば設定、そろっていなければ null (呼ぶたびに読む。値はログに出さない) */
export function readAppleSignInServerConfig(): AppleSignInServerConfig | null {
  const teamId = getOptionalEnv('APPLE_SIGN_IN_TEAM_ID')?.trim();
  const keyId = getOptionalEnv('APPLE_SIGN_IN_KEY_ID')?.trim();
  const privateKey = getOptionalEnv('APPLE_SIGN_IN_PRIVATE_KEY');
  const servicesId = getOptionalEnv('APPLE_SIGN_IN_SERVICES_ID')?.trim();
  if (!teamId || !keyId || !privateKey || privateKey.trim() === '') return null;
  return { teamId, keyId, privateKeyPem: pemOf(privateKey), servicesId: servicesId ? servicesId : null };
}
```

```ts
/**
 * Apple の client_secret (ES256 の JWT) を作る (docs/design/mobile/08-sign-in-with-apple.md §11.2。F-14 の形)。
 * ライブラリを足さず node:crypto で署名する (ECDSA P-256 + SHA-256。JOSE の署名は r||s の生の 64 バイトなので dsaEncoding: 'ieee-p1363')。
 * 置き場所: src/lib/auth/apple/client-secret.ts
 */
import { createPrivateKey, sign } from 'node:crypto';

/** client_secret の aud (config.ts の APPLE_CLIENT_SECRET_AUDIENCE と同じ値。このファイルは config.ts を import しない) */
const CLIENT_SECRET_AUDIENCE = 'https://appleid.apple.com';

export interface AppleClientSecretInput {
  /** Apple Developer の Team ID (10 文字) */
  readonly teamId: string;
  /** Sign in with Apple の Key の Key ID (10 文字) */
  readonly keyId: string;
  /** .p8 の中身 (PEM) */
  readonly privateKeyPem: string;
  /** client_id (bundle ID か Services ID)。sub に入れる */
  readonly clientId: string;
  /** 発行の時刻 (UNIX 秒) */
  readonly issuedAtSeconds: number;
  /** 有効期間 (秒)。6 か月 (15,777,000) を超えない */
  readonly ttlSeconds: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createAppleClientSecret(input: AppleClientSecretInput): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: input.keyId }));
  const payload = base64url(
    JSON.stringify({
      iss: input.teamId,
      iat: input.issuedAtSeconds,
      exp: input.issuedAtSeconds + input.ttlSeconds,
      aud: CLIENT_SECRET_AUDIENCE,
      sub: input.clientId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(input.privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}
```

`https://appleid.apple.com` を書く 4 つの文字列 (`config.ts` の `APPLE_TOKEN_ENDPOINT`・`APPLE_REVOKE_ENDPOINT`・`APPLE_CLIENT_SECRET_AUDIENCE` と `client-secret.ts` の `CLIENT_SECRET_AUDIENCE`) は、コードの `https://<ホスト>` を集める送信先の棚卸し (`tests/ai-consent-provider-inventory.test.ts`) に入る。段 A1 で同じテストの `NON_AI_HOSTS` に `appleid.apple.com` を理由つきで足す (§17)。

### 11.3 Apple の REST と表の読み書き (`src/lib/auth/apple/rest.ts`・`tokens.ts`。新設)

```ts
// tsc:skip
// place=src/lib/auth/apple/schemas.ts
/**
 * Apple の交換・失効の API の応答の形 (docs/design/mobile/08-sign-in-with-apple.md §11.3)。
 */
import { z } from 'zod';
import { APPLE_AUTHORIZATION_CODE_MAX_LENGTH } from '@homegohan/shared';

/** POST /api/auth/apple/authorization の本文 (長さの上限は packages/shared の定数と同じ値) */
export const AppleAuthorizationBodySchema = z.object({
  authorization_code: z.string().min(1).max(APPLE_AUTHORIZATION_CODE_MAX_LENGTH),
});
export type AppleAuthorizationBody = z.infer<typeof AppleAuthorizationBodySchema>;

/** /auth/token の 200 (F-14)。使うのは refresh_token だけ */
export const AppleTokenResponseSchema = z.object({
  refresh_token: z.string().min(1),
  access_token: z.string().optional(),
  id_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});

/** /auth/token・/auth/revoke の 4xx の本文 (F-14 の ErrorResponse) */
export const AppleErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/** route の 200 の本文 */
export const AppleAuthorizationResponseSchema = z.discriminatedUnion('stored', [
  z.object({ stored: z.literal(true) }),
  z.object({ stored: z.literal(false), reason: z.literal('not_configured') }),
]);
export type AppleAuthorizationResponse = z.infer<typeof AppleAuthorizationResponseSchema>;
```

```ts
// tsc:skip
// place=src/lib/auth/apple/rest.ts
/**
 * Apple の交換 (/auth/token) と失効 (/auth/revoke) の呼び出し (docs/design/mobile/08-sign-in-with-apple.md §11.3)。
 * fetch は引数で差し替えられる (テストは本物の Apple に繋がない)。応答の本文・secret・token はログに出さない。
 */
import { APPLE_API_TIMEOUT_MS, APPLE_REVOKE_ENDPOINT, APPLE_TOKEN_ENDPOINT } from './config';
import { AppleErrorResponseSchema, AppleTokenResponseSchema } from './schemas';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type AppleTokenExchangeResult =
  | { ok: true; refreshToken: string }
  /** Apple が invalid_grant (期限切れ・使用済み・別の client のコード)。利用者側の 400 */
  | { ok: false; reason: 'invalid_code'; status: number; error: string }
  /** 届かない・時間切れ・5xx・本文が壊れている */
  | { ok: false; reason: 'unavailable'; status: number | null; error: string | null };

export type AppleRevokeResult = { ok: true } | { ok: false; status: number | null; error: string | null };

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const INVALID_GRANT = 'invalid_grant';

/** timeoutMs を過ぎたら fetch (と本文の読み取り) を打ち切る */
async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>, timeoutMs: number): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 4xx の本文の error (無ければ null)。error_description は読まない (ログにも出さない) */
async function appleErrorOf(response: Response): Promise<string | null> {
  const parsed = AppleErrorResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : null;
}

/** 認可コードを refresh token に替える (grant_type=authorization_code。ネイティブは redirect_uri を渡さない) */
export async function exchangeAppleAuthorizationCode(
  input: { clientId: string; clientSecret: string; code: string },
  fetchImpl: FetchLike = fetch,
): Promise<AppleTokenExchangeResult> {
  let response: Response;
  try {
    response = await postForm(
      fetchImpl,
      APPLE_TOKEN_ENDPOINT,
      {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
      },
      APPLE_API_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: 'unavailable', status: null, error: null };
  }
  if (response.status === HTTP_OK) {
    const parsed = AppleTokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { ok: false, reason: 'unavailable', status: response.status, error: null };
    return { ok: true, refreshToken: parsed.data.refresh_token };
  }
  const error = await appleErrorOf(response);
  if (response.status === HTTP_BAD_REQUEST && error === INVALID_GRANT) {
    return { ok: false, reason: 'invalid_code', status: response.status, error };
  }
  return { ok: false, reason: 'unavailable', status: response.status, error };
}

/**
 * refresh token を失効させる (token_type_hint=refresh_token)。200 は既に無効な token でも返る (F-14)。
 * timeoutMs: 待つ最長 (ミリ秒)。省略すると APPLE_API_TIMEOUT_MS。退会の段階 (revocation.ts) は締め切りまでの残りとの短いほうを渡す
 */
export async function revokeAppleRefreshToken(
  input: { clientId: string; clientSecret: string; refreshToken: string; timeoutMs?: number },
  fetchImpl: FetchLike = fetch,
): Promise<AppleRevokeResult> {
  let response: Response;
  try {
    response = await postForm(
      fetchImpl,
      APPLE_REVOKE_ENDPOINT,
      {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        token: input.refreshToken,
        token_type_hint: 'refresh_token',
      },
      input.timeoutMs ?? APPLE_API_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, status: null, error: null };
  }
  if (response.status === HTTP_OK) return { ok: true };
  return { ok: false, status: response.status, error: await appleErrorOf(response) };
}
```

```ts
// tsc:skip
// place=src/lib/auth/apple/tokens.ts
/**
 * 表 apple_sign_in_tokens の読み書き (docs/design/mobile/08-sign-in-with-apple.md §8・§11.3)。service_role の client だけが呼ぶ。
 * 失敗は例外のまま投げる (呼ぶ側が段階に応じて受け止める)。refresh_token は戻り値の中だけで扱い、ログに渡さない。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** 表の読み書きに使う client の形 (テストは偽物を渡す) */
export type AppleTokenStore = Pick<SupabaseClient, 'from'>;

export interface AppleRefreshTokenRow {
  readonly client_id: string;
  readonly refresh_token: string;
}

export async function storeAppleRefreshToken(
  admin: AppleTokenStore,
  input: { userId: string; clientId: string; refreshToken: string; now?: () => Date },
): Promise<void> {
  const { error } = await admin.from('apple_sign_in_tokens').upsert(
    {
      user_id: input.userId,
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      updated_at: (input.now?.() ?? new Date()).toISOString(),
    },
    { onConflict: 'user_id,client_id' },
  );
  if (error) throw error;
}

export async function listAppleRefreshTokens(admin: AppleTokenStore, userId: string): Promise<AppleRefreshTokenRow[]> {
  const { data, error } = await admin
    .from('apple_sign_in_tokens')
    .select('client_id, refresh_token')
    .eq('user_id', userId);
  if (error) throw error;
  return data ?? [];
}
```

### 11.4 route の本体と退会の段階 (`authorization.ts`・`revocation.ts`・route。新設)

```ts
// tsc:skip
// place=src/lib/auth/apple/authorization.ts
/**
 * POST /api/auth/apple/authorization の本体 (docs/design/mobile/08-sign-in-with-apple.md §9.2)。
 * 認可コード → (client_secret) → /auth/token → refresh_token を保管。route は入口の確認と応答への変換だけ。
 */
import type { User } from '@supabase/supabase-js';
import { createAppleClientSecret } from './client-secret';
import {
  APPLE_CLIENT_SECRET_TTL_SECONDS,
  APPLE_SIGN_IN_NATIVE_CLIENT_ID,
  readAppleSignInServerConfig,
} from './config';
import { exchangeAppleAuthorizationCode, type FetchLike } from './rest';
import { storeAppleRefreshToken, type AppleTokenStore } from './tokens';

export type RegisterAppleAuthorizationResult =
  | { status: 'stored' }
  | { status: 'not_configured' }
  /** 秘密鍵が壊れていて client_secret を作れない (createPrivateKey・sign が投げた。error は呼ぶ側が internalError に渡す) */
  | { status: 'secret_failed'; error: unknown }
  | { status: 'invalid_code'; appleStatus: number; appleError: string }
  | { status: 'unavailable'; appleStatus: number | null; appleError: string | null }
  /** DB の失敗 (error は呼ぶ側が internalError に渡す) */
  | { status: 'store_failed'; error: unknown };

/** この利用者が Apple で入っているか (identities に provider 'apple' がある) */
export function hasAppleIdentity(user: Pick<User, 'identities'>): boolean {
  return (user.identities ?? []).some((identity) => identity.provider === 'apple');
}

const MS_PER_SECOND = 1000;

export async function registerAppleAuthorization(
  input: { admin: AppleTokenStore; userId: string; authorizationCode: string; now?: () => Date; fetchImpl?: FetchLike },
): Promise<RegisterAppleAuthorizationResult> {
  const config = readAppleSignInServerConfig();
  if (!config) return { status: 'not_configured' };
  const issuedAt = Math.floor((input.now?.() ?? new Date()).getTime() / MS_PER_SECOND);
  let clientSecret: string;
  try {
    clientSecret = createAppleClientSecret({
      teamId: config.teamId,
      keyId: config.keyId,
      privateKeyPem: config.privateKeyPem,
      clientId: APPLE_SIGN_IN_NATIVE_CLIENT_ID,
      issuedAtSeconds: issuedAt,
      ttlSeconds: APPLE_CLIENT_SECRET_TTL_SECONDS,
    });
  } catch (error) {
    return { status: 'secret_failed', error };
  }
  const exchanged = await exchangeAppleAuthorizationCode(
    { clientId: APPLE_SIGN_IN_NATIVE_CLIENT_ID, clientSecret, code: input.authorizationCode },
    input.fetchImpl,
  );
  if (!exchanged.ok) {
    return exchanged.reason === 'invalid_code'
      ? { status: 'invalid_code', appleStatus: exchanged.status, appleError: exchanged.error }
      : { status: 'unavailable', appleStatus: exchanged.status, appleError: exchanged.error };
  }
  try {
    await storeAppleRefreshToken(input.admin, {
      userId: input.userId,
      clientId: APPLE_SIGN_IN_NATIVE_CLIENT_ID,
      refreshToken: exchanged.refreshToken,
      now: input.now,
    });
  } catch (error) {
    return { status: 'store_failed', error };
  }
  return { status: 'stored' };
}
```

```ts
// tsc:skip
// place=src/app/api/auth/apple/authorization/route.ts
/**
 * POST /api/auth/apple/authorization — iOS の Sign in with Apple の認可コードを refresh token に替えて保管する
 * (docs/design/mobile/08-sign-in-with-apple.md §9.2)。
 * 1. rejectNullCharacterBody → readJsonBody + AppleAuthorizationBodySchema (違えば 400 VALIDATION_ERROR)
 * 2. requireSessionUser (Bearer。user_profiles の行が無い新規の利用者も通る) → checkRateLimit(user.id, 'auth-apple-authorization') (429)
 * 3. identities に apple が無ければ 409 APPLE_IDENTITY_NOT_LINKED
 * 4. registerAppleAuthorization → 200 { stored } / 400 APPLE_AUTHORIZATION_CODE_INVALID / 500 (internalError。step は client_secret / exchange / store)
 * 本文・ログに認可コード・refresh token・secret を出さない。
 */
import { NextResponse, type NextRequest } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { hasAppleIdentity, registerAppleAuthorization } from '@/lib/auth/apple/authorization';
import { AppleAuthorizationBodySchema } from '@/lib/auth/apple/schemas';
import { sessionsFailure } from '@/lib/auth/sessions/route-support';
import { requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { readJsonBody } from '@/lib/http-params';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/apple/authorization';
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
/**
 * 利用者に見せる固定の文 (英文の生のエラーは出さない)。本文は NextResponse.json に直接書く
 * (tests/api-error-japanese-scan.test.ts の走査は NextResponse.json の本文の error / message と同じファイルの定数を読む。
 *  本文を引数で受ける関数を挟むと文を読めない)
 */
const VALIDATION_MESSAGE = '入力の形が正しくありません。';
const CODE_INVALID_MESSAGE = 'Apple の認可の情報が有効ではありません。もう一度ログインしてください。';
const NOT_LINKED_MESSAGE = 'このアカウントは Apple でログインしていません。';

/**
 * 既存の関数 (internalError・rateLimitExceededResponse) が返す応答にも Cache-Control: private, no-store を付ける
 * (§9.2 のヘッダの行は、この route のすべての応答に掛かる)。本文・status は変えない
 */
function withNoStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE)) response.headers.set(name, value);
  return response;
}

export async function POST(request: NextRequest) {
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  const read = await readJsonBody(request);
  if (!read.ok) {
    return NextResponse.json({ error: VALIDATION_MESSAGE, code: 'VALIDATION_ERROR' }, { status: HTTP_BAD_REQUEST, headers: NO_STORE });
  }
  const parsed = AppleAuthorizationBodySchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json({ error: VALIDATION_MESSAGE, code: 'VALIDATION_ERROR' }, { status: HTTP_BAD_REQUEST, headers: NO_STORE });
  }

  const requestId = generateRequestId();
  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    const limit = await checkRateLimit(ctx.user.id, 'auth-apple-authorization');
    if (!limit.success) return withNoStore(rateLimitExceededResponse(limit));
    if (!hasAppleIdentity(ctx.user)) {
      return NextResponse.json({ error: NOT_LINKED_MESSAGE, code: 'APPLE_IDENTITY_NOT_LINKED' }, { status: HTTP_CONFLICT, headers: NO_STORE });
    }

    const log = createLogger(ROUTE_NAME, requestId).withUser(ctx.user.id);
    const result = await registerAppleAuthorization({
      admin: getSupabaseAdmin(),
      userId: ctx.user.id,
      authorizationCode: parsed.data.authorization_code,
    });
    switch (result.status) {
      case 'stored':
        return NextResponse.json({ stored: true }, { status: HTTP_OK, headers: NO_STORE });
      case 'not_configured':
        log.info('apple authorization: server config is missing; refresh token not stored', { request_id: requestId });
        return NextResponse.json({ stored: false, reason: 'not_configured' }, { status: HTTP_OK, headers: NO_STORE });
      case 'invalid_code':
        log.warn('apple authorization: apple rejected the authorization code', {
          request_id: requestId,
          apple_status: result.appleStatus,
          apple_error: result.appleError,
        });
        return NextResponse.json(
          { error: CODE_INVALID_MESSAGE, code: 'APPLE_AUTHORIZATION_CODE_INVALID' },
          { status: HTTP_BAD_REQUEST, headers: NO_STORE },
        );
      case 'unavailable':
        return withNoStore(
          internalError(ROUTE_NAME, new Error('apple token endpoint unavailable'), {
            userId: ctx.user.id,
            requestId,
            step: 'exchange',
            apple_status: result.appleStatus,
            apple_error: result.appleError,
          }),
        );
      case 'secret_failed':
        return withNoStore(internalError(ROUTE_NAME, result.error, { userId: ctx.user.id, requestId, step: 'client_secret' }));
      case 'store_failed':
        return withNoStore(internalError(ROUTE_NAME, result.error, { userId: ctx.user.id, requestId, step: 'store' }));
    }
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
```

`src/lib/rate-limit.ts`: `RateLimitCategory` に `'auth-apple-authorization'` を足し、`CATEGORY_RULES` に `'auth-apple-authorization': [{ name: 'auth-apple-authorization', max: 5, windowSec: 10 * MINUTE_SEC }]` を足す (ログインのたびに 1 回。`auth-password-change` と同じ 5 回 / 10 分。キーは利用者 ID)。

```ts
// tsc:skip
// place=src/lib/auth/apple/revocation.ts
/**
 * 退会の段階 apple_revoke (docs/design/mobile/08-sign-in-with-apple.md §9.3)。
 * 保管している refresh token を行ごとに失効させる。例外を投げない (退会の結果を変えない)。失敗は warn のログ。
 * 表の読み取りと、行ごとの処理 (client_secret の作成と失効) をそれぞれ try で囲む (秘密鍵が壊れていると createAppleClientSecret が投げる)。
 * 段階全体 (表の読み取りから最後の行まで) の時間は APPLE_REVOKE_TOTAL_BUDGET_MS まで (§13.1。退会の route の maxDuration に収める)。
 * 締め切りは入口で 1 回決める。試行ごとの待ちは APPLE_API_TIMEOUT_MS と締め切りまでの残りの短いほう。
 * 締め切りを過ぎたら、やり直しも次の行の失効もしない。残りの行は Apple を呼ばずに failed に数え、warn を 1 回出す。
 */
import { createAppleClientSecret } from './client-secret';
import {
  APPLE_API_TIMEOUT_MS,
  APPLE_CLIENT_SECRET_TTL_SECONDS,
  APPLE_REVOKE_ATTEMPTS,
  APPLE_REVOKE_TOTAL_BUDGET_MS,
  readAppleSignInServerConfig,
} from './config';
import { revokeAppleRefreshToken, type AppleRevokeResult, type FetchLike } from './rest';
import { listAppleRefreshTokens, type AppleRefreshTokenRow, type AppleTokenStore } from './tokens';

/** 退会の本体 (deleteAccount) が受け取る報告 (成功のログの metadata に載る) */
export interface AppleRevocationReport {
  readonly tokens: number;
  readonly revoked: number;
  /** 失効できなかった行 (Apple の失敗・client_secret を作れない・締め切りを過ぎて呼ばなかった) */
  readonly failed: number;
  /** 秘密が無く Apple を呼ばなかった */
  readonly skipped: 'not_configured' | null;
}

/** ログの口 (createLogger(...).withUser(...) の一部。AccountDeletionBillingLogger と同じ形) */
export interface AppleRevocationLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
}

/** 退会の差し替え口 (Stripe の AccountDeletionBilling と同じ位置づけ。テストは偽物を渡す) */
export interface AccountDeletionAppleRevocation {
  revokeForAccountDeletion(userId: string, log: AppleRevocationLogger, requestId: string): Promise<AppleRevocationReport>;
}

/** 1 行の結果。not_attempted = 締め切りを過ぎていて Apple を呼ばなかった (failed に数える) */
type RevokeRowOutcome = 'revoked' | 'failed' | 'not_attempted';
type AppleRevokeFailure = Extract<AppleRevokeResult, { ok: false }>;

const MS_PER_SECOND = 1000;

export function createAccountDeletionAppleRevocation(deps: {
  admin: () => AppleTokenStore;
  fetchImpl?: FetchLike;
  /** 時計 (client_secret の iat と締め切り)。テストは進む偽物を渡す。省略すると new Date() */
  now?: () => Date;
  /** 段階全体の時間の上限 (ミリ秒)。テスト用。省略すると APPLE_REVOKE_TOTAL_BUDGET_MS */
  budgetMs?: number;
}): AccountDeletionAppleRevocation {
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime();
  return {
    async revokeForAccountDeletion(userId, log, requestId) {
      const budgetMs = deps.budgetMs ?? APPLE_REVOKE_TOTAL_BUDGET_MS;
      const deadlineMs = nowMs() + budgetMs;
      const remainingMs = (): number => deadlineMs - nowMs();
      let rows: AppleRefreshTokenRow[];
      try {
        rows = await listAppleRefreshTokens(deps.admin(), userId);
      } catch (error) {
        log.warn('account deletion: could not read apple refresh tokens (deletion continues; nothing revoked)', {
          request_id: requestId,
          step: 'apple_revoke',
          error_name: error instanceof Error ? error.name : 'unknown',
        });
        return { tokens: 0, revoked: 0, failed: 0, skipped: null };
      }
      if (rows.length === 0) return { tokens: 0, revoked: 0, failed: 0, skipped: null };
      const config = readAppleSignInServerConfig();
      if (!config) {
        log.warn('account deletion: apple server config is missing; refresh tokens not revoked', {
          request_id: requestId,
          step: 'apple_revoke',
          tokens: rows.length,
        });
        return { tokens: rows.length, revoked: 0, failed: 0, skipped: 'not_configured' };
      }
      /** 1 行を失効させる。投げない (client_secret を作れないときも failed を返して warn) */
      const revokeRow = async (row: AppleRefreshTokenRow): Promise<RevokeRowOutcome> => {
        if (remainingMs() <= 0) return 'not_attempted';
        try {
          const clientSecret = createAppleClientSecret({
            teamId: config.teamId,
            keyId: config.keyId,
            privateKeyPem: config.privateKeyPem,
            clientId: row.client_id,
            issuedAtSeconds: Math.floor(nowMs() / MS_PER_SECOND),
            ttlSeconds: APPLE_CLIENT_SECRET_TTL_SECONDS,
          });
          let attempts = 0;
          let lastFailure: AppleRevokeFailure | null = null;
          while (attempts < APPLE_REVOKE_ATTEMPTS) {
            const remaining = remainingMs();
            if (remaining <= 0) break;
            attempts += 1;
            const result = await revokeAppleRefreshToken(
              {
                clientId: row.client_id,
                clientSecret,
                refreshToken: row.refresh_token,
                timeoutMs: Math.min(APPLE_API_TIMEOUT_MS, remaining),
              },
              deps.fetchImpl,
            );
            if (result.ok) return 'revoked';
            lastFailure = result;
          }
          // client_secret を作る間に締め切りを過ぎた (1 回も呼んでいない)
          if (attempts === 0) return 'not_attempted';
          log.warn('account deletion: apple token revocation failed (deletion continues)', {
            request_id: requestId,
            step: 'apple_revoke',
            client_id: row.client_id,
            attempts,
            apple_status: lastFailure?.status ?? null,
            apple_error: lastFailure?.error ?? null,
            budget_exhausted: remainingMs() <= 0,
          });
          return 'failed';
        } catch (error) {
          // 秘密鍵が壊れている (createPrivateKey・sign が投げた) など。値・PEM はログに出さない
          log.warn('account deletion: could not revoke the apple token (deletion continues)', {
            request_id: requestId,
            step: 'apple_revoke',
            client_id: row.client_id,
            error_name: error instanceof Error ? error.name : 'unknown',
          });
          return 'failed';
        }
      };
      let revoked = 0;
      let notAttempted = 0;
      for (const row of rows) {
        const outcome = await revokeRow(row);
        if (outcome === 'revoked') revoked += 1;
        if (outcome === 'not_attempted') notAttempted += 1;
      }
      if (notAttempted > 0) {
        log.warn('account deletion: apple revocation ran out of its time budget; the remaining tokens were not sent to apple (deletion continues)', {
          request_id: requestId,
          step: 'apple_revoke',
          not_attempted: notAttempted,
          budget_ms: budgetMs,
        });
      }
      return { tokens: rows.length, revoked, failed: rows.length - revoked, skipped: null };
    },
  };
}
```

`src/lib/account-deletion.ts` の差分:

```ts
// tsc:skip
// place=src/lib/account-deletion.ts (差分。既存の行はそのまま)
import { createAccountDeletionAppleRevocation, type AccountDeletionAppleRevocation, type AppleRevocationReport } from '@/lib/auth/apple/revocation';

// AccountDeletionStep に 'apple_revoke' を足す ('billing_recheck' と 'delete_user' の間)
export type AccountDeletionStep =
  | 'init'
  | 'check_blockers'
  | 'billing'
  | 'prepare'
  | 'release_membership'
  | 'storage'
  | 'record'
  | 'billing_recheck'
  | 'apple_revoke'
  | 'delete_user';

// DeleteAccountParams に差し替え口を足す (billing と同じ)
//   /** Sign in with Apple の refresh token の失効 (§9.3)。省略時は params.admin で表を読む既定の実装 */
//   appleRevocation?: AccountDeletionAppleRevocation;

// deleteAccount の中 (billing_recheck の直後・delete_user の直前):
//   (段階の時間は revocation.ts の中で APPLE_REVOKE_TOTAL_BUDGET_MS まで。deleteAccount は時間を渡さない)
//   step = 'apple_revoke';
//   const appleRevocation = params.appleRevocation ?? createAccountDeletionAppleRevocation({ admin: () => admin });
//   const appleReport: AppleRevocationReport = await appleRevocation.revokeForAccountDeletion(userId, userLog, requestId);
//
//   step = 'delete_user';
//   … (既存)
//
// 成功のログ:
//   log.info('account deleted', { …既存…, billing_recheck: billingRecheckReport, apple: appleReport });
```

ファイル冒頭の流れの注に「4'''. 段階 apple_revoke: Sign in with Apple の refresh token を失効させる (docs/design/mobile/08-sign-in-with-apple.md §9.3)。失敗しても退会は続ける (warn)。時間は APPLE_REVOKE_TOTAL_BUDGET_MS (3 秒) まで (退会の route の maxDuration に収める。過ぎた行は Apple を呼ばない)」の行を足す。

### 11.5 モバイル (`apps/mobile`)

```ts
// tsc:skip
// place=apps/mobile/src/lib/routeAfterSignIn.ts
/**
 * ログインの後の振り分け (docs/design/mobile/08-sign-in-with-apple.md §9.1)。
 * apps/mobile/app/(auth)/login.tsx の中にあった routeAfterSignIn をそのまま移した (メール・パスワード / Google / Apple の 3 つの入口で共通)。
 * user_profiles から初期設定の状態を読み、?next= (/ 始まりだけ) があればそこへ、無ければ 完了 → ホーム / 開始済み → 再開 / 未開始 → ウェルカム。
 * (#1122: admin / super_admin も同じ振り分け)
 */
import { router } from "expo-router";

import { supabase } from "./supabase";

export async function routeAfterSignIn(next: string | string[] | undefined): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("onboarding_started_at, onboarding_completed_at")
    .eq("id", user.id)
    .single();

  const safeNext = typeof next === "string" && next.startsWith("/") ? next : null;

  if (safeNext) {
    router.replace(safeNext as never);
  } else if (profile?.onboarding_completed_at) {
    router.replace("/(tabs)/home");
  } else if (profile?.onboarding_started_at) {
    router.replace("/onboarding/resume");
  } else {
    router.replace("/onboarding/welcome");
  }
}
```

`router.replace(safeNext as never)` は、いまの `login.tsx:88` の `any` へのキャスト (`as` で `any` にする書き方) を `never` へのキャストに替えたもの (expo-router の `Href` の型に動的な文字列を渡す既存の書き方。挙動は同じ。`any` へのキャストは本書の正典コードでは使わない)。

```ts
// tsc:skip
// place=apps/mobile/src/lib/appleSignIn.ts
/**
 * Sign in with Apple (iOS のネイティブのシート) → Supabase のセッション (docs/design/mobile/08-sign-in-with-apple.md §9.1・§11.5)。
 *  - スイッチ EXPO_PUBLIC_APPLE_SIGN_IN が on で iOS のときだけ有効 (Android・スイッチ無しのビルドではボタンを出さない)
 *  - nonce: raw を作り、Apple へは SHA-256 (hex)、Supabase へは raw を渡す (GoTrue が raw を hash して id_token の nonce と比べる)
 *  - 名前は初回だけ届く。user_metadata.full_name が空のときだけ updateUser で保存する
 *  - 認可コードはサーバ (POST /api/auth/apple/authorization) が refresh token に替えて保管する (退会のときの失効に使う)。失敗してもログインは止めない
 *  - 本物の Apple・Supabase には繋がない (テストは expo-apple-authentication・supabase.auth・getApi を差し替える)
 */
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { APPLE_SIGN_IN_MESSAGES, isAppleSignInFlagOn } from "@homegohan/shared";

import { getApi } from "./api";
import { supabase } from "./supabase";

export type AppleSignInOutcome =
  /** Supabase のセッションを作れた (名前の保存・認可コードの登録も試した) */
  | { status: "signed_in" }
  /** 利用者がシートを閉じた。画面は何も出さない */
  | { status: "cancelled" }
  /** 失敗。message は利用者に見せてよい固定の文 */
  | { status: "failed"; message: string };

/** expo-apple-authentication が投げるエラーの形 (code を持つ) */
type CodedError = { code?: unknown };

/** 利用者がシートを閉じたときの code (expo-apple-authentication) */
const ERR_REQUEST_CANCELED = "ERR_REQUEST_CANCELED";
/** 認可コードの登録の API */
export const APPLE_AUTHORIZATION_API_PATH = "/api/auth/apple/authorization";

/** このビルド・この端末で Apple のボタンを出すか (iOS かつスイッチが on)。isAvailableAsync はこの後に別で見る */
export function isAppleSignInEnabled(): boolean {
  // 名前を直接書く (Metro の置き換えは process.env.EXPO_PUBLIC_X の形だけ。src/lib/env.ts の規則)
  return Platform.OS === "ios" && isAppleSignInFlagOn(process.env.EXPO_PUBLIC_APPLE_SIGN_IN);
}

/** 有効で、かつ端末が対応している (iOS 13 以降。シミュレータは対応と答えるが実機でしか動かない) */
export async function isAppleSignInAvailable(): Promise<boolean> {
  if (!isAppleSignInEnabled()) return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

function fullNameOf(name: AppleAuthentication.AppleAuthenticationFullName | null): { full_name: string; given_name: string | null; family_name: string | null } | null {
  const given = name?.givenName?.trim() || null;
  const family = name?.familyName?.trim() || null;
  if (!given && !family) return null;
  return { full_name: [given, family].filter(Boolean).join(" "), given_name: given, family_name: family };
}

/** 初回だけ届く名前を保存する (既に full_name があれば上書きしない)。失敗はログだけ */
async function saveAppleFullName(name: AppleAuthentication.AppleAuthenticationFullName | null, currentFullName: unknown): Promise<void> {
  const parts = fullNameOf(name);
  if (!parts) return;
  if (typeof currentFullName === "string" && currentFullName.trim() !== "") return;
  const { error } = await supabase.auth.updateUser({ data: parts });
  if (error) console.warn("[appleSignIn] could not save the name from Apple", error.name);
}

/** 認可コードをサーバへ渡す (refresh token の保管)。失敗はログだけ (ログインの結果を変えない) */
async function registerAppleAuthorization(authorizationCode: string | null): Promise<void> {
  if (!authorizationCode) return;
  try {
    await getApi().post(APPLE_AUTHORIZATION_API_PATH, { authorization_code: authorizationCode });
  } catch (error) {
    console.warn("[appleSignIn] could not register the authorization code", error instanceof Error ? error.name : "unknown");
  }
}

export async function signInWithApple(): Promise<AppleSignInOutcome> {
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (error) {
    if ((error as CodedError | null)?.code === ERR_REQUEST_CANCELED) return { status: "cancelled" };
    return { status: "failed", message: APPLE_SIGN_IN_MESSAGES.failed };
  }
  if (!credential.identityToken) return { status: "failed", message: APPLE_SIGN_IN_MESSAGES.noIdentityToken };

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token: credential.identityToken,
    nonce: rawNonce,
  });
  if (error) return { status: "failed", message: APPLE_SIGN_IN_MESSAGES.failed };

  await saveAppleFullName(credential.fullName, data.user?.user_metadata?.full_name);
  await registerAppleAuthorization(credential.authorizationCode);
  return { status: "signed_in" };
}
```

```tsx
// tsc:skip
// place=apps/mobile/src/components/auth/AppleSignInButton.tsx
/**
 * Apple のログインのボタン (docs/design/mobile/08-sign-in-with-apple.md §10.1)。
 * OS が描く AppleAuthenticationButton (Apple の見た目・言語・VoiceOver) を使う。出す条件 (iOS・スイッチ・端末の対応) を満たさないときは何も描かない。
 * 高さは同じ画面の Google のボタンと同じにする (HIG: ほかのログインのボタンより小さくしない。R-1)。画面は useAuthProviderButtonHeight の
 * height をこの部品の height に、onGoogleButtonLayout を Google のボタンの onLayout に渡し、Google のボタンの style に
 * minHeight: AUTH_PROVIDER_BUTTON_MIN_HEIGHT を足す。
 */
import * as AppleAuthentication from "expo-apple-authentication";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import type { LayoutChangeEvent } from "react-native";

import { isAppleSignInAvailable } from "../../lib/appleSignIn";
import { radius } from "../../theme";

/**
 * ログイン・新規登録の画面の Apple と Google のボタンの下限の高さ (pt)。Google のボタンには minHeight として、Apple のボタンには
 * useAuthProviderButtonHeight の初めの値と下限として使う。
 * 根拠: Google のボタンの中身なりの高さ (paddingVertical 14 × 2 + 枠 1 × 2 + アイコン 20 と 15pt の題名の行の高さの大きいほう) は
 * 標準の文字の大きさで約 50〜52 (行の高さは書体の値で決まる見積もり。設計書 §0.2 F-17) なので、それより大きい 56 にして、標準では
 * 2 つのボタンがちょうどこの高さで並ぶようにする (Apple のボタンが測った高さを待たずに同じ高さで出る)。56 は Web のボタンの高さと
 * HIG の例 (56pt) と同じ。HIG の最小 30pt を満たす。見た目の値で、運用で変える値ではないので環境変数にしない。
 */
export const AUTH_PROVIDER_BUTTON_MIN_HEIGHT = 56;
/** 押せないときの薄さ (Google のボタンの pressed / isSubmitting と同じ 0.7) */
const DISABLED_OPACITY = 0.7;

export type AppleSignInButtonKind = "sign_in" | "sign_up";

const BUTTON_TYPE: Record<AppleSignInButtonKind, AppleAuthentication.AppleAuthenticationButtonType> = {
  sign_in: AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN,
  sign_up: AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP,
};

/**
 * Apple のボタンの高さを、同じ画面の Google のボタンの実際の高さに合わせる (R-1)。
 * 端末の文字の大きさの設定で Google の題名が大きくなりボタンが伸びたときも (RN の Text は既定で設定に従う。設計書 §0.2 F-17)、
 * Apple のボタンを同じ高さにする (OS が描く Apple のボタンの高さは style でしか決まらない。F-16)。
 * height の初めの値と下限は AUTH_PROVIDER_BUTTON_MIN_HEIGHT (Google のボタンの minHeight と同じ)。
 */
export function useAuthProviderButtonHeight(): { height: number; onGoogleButtonLayout: (event: LayoutChangeEvent) => void } {
  const [height, setHeight] = useState<number>(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);
  const onGoogleButtonLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(Math.max(AUTH_PROVIDER_BUTTON_MIN_HEIGHT, event.nativeEvent.layout.height));
  }, []);
  return { height, onGoogleButtonLayout };
}

export function AppleSignInButton(props: { kind: AppleSignInButtonKind; onPress: () => void; disabled: boolean; testID: string; height: number }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    isAppleSignInAvailable().then((value) => alive && setAvailable(value));
    return () => {
      alive = false;
    };
  }, []);
  if (!available) return null;
  return (
    <View testID={props.testID} pointerEvents={props.disabled ? "none" : "auto"} style={{ opacity: props.disabled ? DISABLED_OPACITY : 1 }}>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={BUTTON_TYPE[props.kind]}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE_OUTLINE}
        cornerRadius={radius.lg}
        style={{ width: "100%", height: props.height }}
        onPress={props.onPress}
      />
    </View>
  );
}
```

`apps/mobile/app/(auth)/login.tsx` の差分:

```tsx
// tsc:skip
// place=apps/mobile/app/(auth)/login.tsx (差分)
import { AppleSignInButton, AUTH_PROVIDER_BUTTON_MIN_HEIGHT, useAuthProviderButtonHeight } from "../../src/components/auth/AppleSignInButton";
import { signInWithApple } from "../../src/lib/appleSignIn";
import { routeAfterSignIn } from "../../src/lib/routeAfterSignIn";
// 画面の中の routeAfterSignIn (76-100 行) は消し、呼ぶ所 (Google の 118 行・メールの 221 行) を routeAfterSignIn(next) に替える

// LoginScreen の中・const captcha = useTurnstile(); (43 行) の次に置く (フックなので条件の中に入れない)
const { height: providerButtonHeight, onGoogleButtonLayout } = useAuthProviderButtonHeight();

async function onAppleLogin() {
  setIsSubmitting(true);
  try {
    const outcome = await signInWithApple();
    if (outcome.status === "signed_in") {
      await routeAfterSignIn(next);
    } else if (outcome.status === "failed") {
      Alert.alert("Appleログイン失敗", outcome.message);
    }
    // cancelled: 何も出さない
  } finally {
    setIsSubmitting(false);
  }
}

// JSX: 「または」の区切りの直後・Google のボタンの前
<AppleSignInButton kind="sign_in" onPress={onAppleLogin} disabled={isSubmitting} testID="login-apple-button" height={providerButtonHeight} />

// Google のボタン (394-412 行) の Pressable に onLayout を足し、style の paddingVertical: 14 の次に minHeight を足す。ほかは変えない
<Pressable
  testID="login-google-button"
  onPress={onGoogleLogin}
  onLayout={onGoogleButtonLayout}
  disabled={isSubmitting}
  style={({ pressed }) => ({
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.lg, paddingVertical: 14, minHeight: AUTH_PROVIDER_BUTTON_MIN_HEIGHT,
    borderWidth: 1, borderColor: colors.border,
    ...shadows.sm,
    opacity: pressed || isSubmitting ? 0.7 : 1,
  })}
>
```

`apps/mobile/app/(auth)/signup.tsx` の差分: 同じ import と `onAppleSignup` (Alert の題は `"Apple登録失敗"`、失敗の文は `outcome.message` のまま)。`signInWithApple` の失敗の文はログイン・登録で共通 (`APPLE_SIGN_IN_MESSAGES.failed`)。`routeAfterSignIn(undefined)` を呼ぶ (新規登録画面には `?next=` が無い)。`SignupScreen` の中・`const captcha = useTurnstile();` (34 行) の次に `const { height: providerButtonHeight, onGoogleButtonLayout } = useAuthProviderButtonHeight();` を置く。JSX は `<AppleSignInButton kind="sign_up" onPress={onAppleSignup} disabled={isSubmitting} testID="signup-apple-button" height={providerButtonHeight} />` を Google の前に置く。Google 登録のボタン (253-271 行の `Pressable`) は `login.tsx` と同じく `onLayout={onGoogleButtonLayout}` を足し、style の `paddingVertical: 14` の次に `minHeight: AUTH_PROVIDER_BUTTON_MIN_HEIGHT` を足す (ほかは変えない)。Google 登録の既存の処理 (`router.replace("/auth/verify")`) は変えない。

`apps/mobile/package.json`: `"expo-apple-authentication": "~58.0.2"`・`"expo-crypto": "~58.0.7"` を `dependencies` に足す (アルファベット順。版は SDK 58 の表のとおり。`tests/mobile-toolchain-contract.test.ts`)。`package-lock.json` はテスト用の機械で作り直して持ち帰る (05 §9.13 の段 1 と同じ形: `offload --no-install --fetch apps/mobile/package.json --fetch package-lock.json -- bash -c 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund -w apps/mobile expo-apple-authentication@58.0.2 expo-crypto@58.0.7'`。2 つはルートに巻き上がる (入れ子は react と @types/react だけ、の契約のまま))。

`apps/mobile/app.json`: `ios.usesAppleSignIn: true` (EAS Build が Sign In with Apple の capability と entitlement `com.apple.developer.applesignin` を入れる) と `ios.infoPlist.CFBundleAllowMixedLocalizations: true` (OS のボタンの題名を端末の言語にする。Expo の注) を足す。`plugins` には足さない (どちらか 1 つで足りる。Expo の注)。`runtimeVersion` は `fingerprint` のまま (指紋が変わるので新しいビルドが要る)。

`apps/mobile/env.example` に足す:

```
# Sign in with Apple (docs/design/mobile/08-sign-in-with-apple.md)。iOS のログイン・新規登録の画面に Apple のボタンを出すスイッチ。
# on のときだけ出す (大文字小文字と前後の空白は区別しない)。未設定・ほかの値なら出さない (Supabase の Apple provider と Apple Developer の設定が済み、
# Web のサーバの秘密 APPLE_SIGN_IN_TEAM_ID・APPLE_SIGN_IN_KEY_ID・APPLE_SIGN_IN_PRIVATE_KEY が本番で効いていることを確かめるまでは入れない。設計書 §19.3)。
# Android には効かない (出さない)。ビルド時に埋め込まれるので、変えたら新しいビルドが要る。本番・preview ビルドでは EAS の環境変数に登録する。
EXPO_PUBLIC_APPLE_SIGN_IN=
```

### 11.6 Web (`src/`。段 B)

```ts
// tsc:skip
// place=src/lib/auth/apple-sign-in-flag.ts
/**
 * Web で Apple のボタンを出すか (docs/design/mobile/08-sign-in-with-apple.md §10.2)。NEXT_PUBLIC_APPLE_SIGN_IN が on のときだけ。
 * 名前を直接書いて読む (Next.js はこの形だけをブラウザのバンドルで値に置き換える。src/lib/env-required.ts の注)。React に依存しない。
 */
import { isAppleSignInFlagOn } from '@homegohan/shared';

export function isAppleSignInEnabled(): boolean {
  return isAppleSignInFlagOn(process.env.NEXT_PUBLIC_APPLE_SIGN_IN);
}
```

```tsx
// tsc:skip
// place=src/components/auth/AppleSignInButton.tsx
/**
 * Web の Apple のボタン (自作。docs/design/mobile/08-sign-in-with-apple.md §10.2。HIG の「Creating a custom Sign in with Apple button」)。
 *  - 黒い背景に白いロゴと題名。題名は「Appleで続ける」「Appleで登録」だけ (HIG の Continue / Sign up に当たる日本語)
 *  - 高さ 56px・文字 24px (高さの 43%)・ロゴの高さ = ボタンの高さ (ロゴの画像は余白込み。切らない)
 *  - ロゴは Apple が配るロゴだけのボタンの画像 (黒地に白いロゴ・PNG) を public/auth/apple-logo-on-black.png に置く
 *    (取得: https://appleid.cdn-apple.com/appleid/button/logo?size=56&color=black&border=false&border_radius=0&scale=3。設計書 §11.6)
 */
import Image from 'next/image';

/**
 * ボタンの高さ (px)。Google のボタンの style の height にも同じ値を渡してそろえる (Apple のボタンをほかより小さくしない)。
 * 2 つとも px にする (Tailwind の h-14 などは rem で、ブラウザの文字の大きさの設定で変わり、px の高さとずれる。設計書 §10.2)
 */
export const APPLE_SIGN_IN_BUTTON_HEIGHT_PX = 56;
/** 題名の文字の大きさ (px) = 高さの 43% (HIG の例: 56pt / 24pt) */
export const APPLE_SIGN_IN_BUTTON_FONT_PX = 24;
/** ロゴの画像の置き場 (public/ からの道)。画像は Apple の URL から取った PNG (設計書 §11.6) */
export const APPLE_LOGO_SRC = '/auth/apple-logo-on-black.png';
/**
 * ロゴの画像を取るときの scale (Apple の URL の scale。1〜6)。3 倍 = 高解像度の画面 (devicePixelRatio 3 まで) で滲まない。
 * 画像の一辺の画素数 = APPLE_SIGN_IN_BUTTON_HEIGHT_PX × APPLE_LOGO_IMAGE_SCALE (= 168。tests/apple-sign-in-logo-asset.test.ts が確かめる)
 */
export const APPLE_LOGO_IMAGE_SCALE = 3;

export const APPLE_SIGN_IN_TITLES = {
  continue: 'Appleで続ける',
  sign_up: 'Appleで登録',
} as const;

export function AppleSignInButton(props: {
  kind: keyof typeof APPLE_SIGN_IN_TITLES;
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={props.onClick}
      disabled={props.disabled}
      className="w-full rounded-xl bg-black text-white font-bold flex items-center justify-center gap-2 hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      style={{ height: APPLE_SIGN_IN_BUTTON_HEIGHT_PX, fontSize: APPLE_SIGN_IN_BUTTON_FONT_PX }}
    >
      <Image src={APPLE_LOGO_SRC} alt="" aria-hidden width={APPLE_SIGN_IN_BUTTON_HEIGHT_PX} height={APPLE_SIGN_IN_BUTTON_HEIGHT_PX} unoptimized />
      {props.loading ? '処理中...' : APPLE_SIGN_IN_TITLES[props.kind]}
    </button>
  );
}
```

ロゴの画像の取り方 (段 B の実装者。worktree の根で 1 回。テスト用の機械ではなくネットに出られる手元で流してよい。取ったファイルはコミットする):

```
mkdir -p public/auth
curl -fsS -o public/auth/apple-logo-on-black.png "https://appleid.cdn-apple.com/appleid/button/logo?size=56&color=black&border=false&border_radius=0&scale=3"
file public/auth/apple-logo-on-black.png   # PNG image data, 168 x 168
```

- 引数の意味: `size=56` = ボタンの高さ (`APPLE_SIGN_IN_BUTTON_HEIGHT_PX`)・`color=black` = ボタンの背景と同じ黒・`border=false`・`border_radius=0` (角はボタンの `rounded-xl` で丸める。画像の角は黒の上の黒で見えない)・`scale=3` (`APPLE_LOGO_IMAGE_SCALE`)。
- 2026-10-23 の取得の実測 (F-14): 200・`image/png`・168×168・1,748 バイト・SHA-256 `25268728e298470d7d119ac26db41be83d20d0cceba704df4c5dc6eef9f8f3e6`。Apple が画像を作り直すとバイトは変わりうるので、テストはハッシュではなく PNG の形と大きさを確かめる (§14.2 `tests/apple-sign-in-logo-asset.test.ts`)。
- 404 は引数の誤り (Apple の文書: 不正な引数は 404) なので、上の URL を引数ごと写し直して流す。ほかの経路で作ったロゴ (自分で描いた形・記憶から起こした SVG) は置かない (HIG: 自作のボタンには Apple が配るロゴだけを使う)。取れなければ `deviations` に書いて止める。

`src/app/(auth)/login/page.tsx` の差分:

```tsx
// tsc:skip
// place=src/app/(auth)/login/page.tsx (差分)
import { AppleSignInButton, APPLE_SIGN_IN_BUTTON_HEIGHT_PX } from '@/components/auth/AppleSignInButton';
import { isAppleSignInEnabled } from '@/lib/auth/apple-sign-in-flag';

import { APPLE_SIGN_IN_MESSAGES } from '@homegohan/shared';
// Apple のログインの失敗の文は packages/shared の固定の文 (APPLE_SIGN_IN_MESSAGES.failed。新規登録の画面は .signupFailed)

const handleAppleLogin = async () => {
  try {
    setIsLoading(true);
    setError(null);
    const safeNext = getSafeRedirectPath(rawRedirectParam);
    // provider=apple は /auth/callback が provider_refresh_token を保管する目印 (Google には付けない)
    const callback = new URL('/auth/callback', window.location.origin);
    callback.searchParams.set('provider', 'apple');
    if (safeNext) callback.searchParams.set('next', safeNext);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: callback.toString() },
    });
    if (error) throw error;
  } catch (error) {
    console.error('Error logging in with Apple:', error);
    setError(APPLE_SIGN_IN_MESSAGES.failed);
  } finally {
    setIsLoading(false);
  }
};

// JSX: Google のボタンの前
{isAppleSignInEnabled() && (
  <AppleSignInButton kind="continue" onClick={handleAppleLogin} disabled={isLoading} loading={isLoading} testId="login-apple-button" />
)}
// Google のボタン (207-221 行の Button): className の py-6 を py-0 に替え、style={{ height: APPLE_SIGN_IN_BUTTON_HEIGHT_PX }} を足す (Apple と同じ 56px の px。ほかは変えない)
```

`src/app/(auth)/signup/page.tsx` の差分: `handleAppleSignup` (先頭に `if (!agreedToLegal) { setFormError(LEGAL_AGREEMENT_REQUIRED_MESSAGE); return; }`。`redirectTo` は `buildCallbackUrl()` に `provider=apple` を足した URL。失敗の文は `APPLE_SIGN_IN_MESSAGES.signupFailed` (`packages/shared/src/apple-sign-in.ts`。文は「Apple での登録に失敗しました。しばらくしてからお試しください。」))。JSX は Google のボタンの前に `<AppleSignInButton kind="sign_up" onClick={handleAppleSignup} disabled={isLoading || !agreedToLegal} loading={isLoading} testId="signup-apple-button" />` (スイッチが on のときだけ)。import は `login/page.tsx` と同じ (`AppleSignInButton`・`APPLE_SIGN_IN_BUTTON_HEIGHT_PX`・`isAppleSignInEnabled`)。Google のボタン (223-236 行の `Button`) は className の `py-6` を `py-0` に替え、`style={{ height: APPLE_SIGN_IN_BUTTON_HEIGHT_PX }}` を足す (`login/page.tsx` と同じ。ほかは変えない)。

```ts
// tsc:skip
// place=src/lib/auth/apple/web-callback.ts
/**
 * Web の OAuth (段 B) のコールバックで、Apple の refresh token を保管する (docs/design/mobile/08-sign-in-with-apple.md §9.5)。
 * /auth/callback が code の交換に成功したあとに 1 回呼ぶ。例外を投げない (振り分けを変えない)。token はログに出さない。
 */
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { hasAppleIdentity } from './authorization';
import { readAppleSignInServerConfig } from './config';
import { storeAppleRefreshToken } from './tokens';

export interface WebCallbackLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

/** /auth/callback の ?provider= の値のうち、保管の対象 (?error= のときに固定の文にする対象も同じ) */
export const APPLE_CALLBACK_PROVIDER = 'apple';

/**
 * ?provider=apple の /auth/callback に ?error= が付いて戻ったとき (Apple の画面で取り消した・拒否した、Apple / GoTrue の失敗。S-34) に、
 * ログイン画面 (/login?error=) の赤いバナーに出す固定の文。Apple・GoTrue の英文 (error_description・error の値) を出さない。
 * error の値 (user_cancelled_authorize・access_denied・server_error など。Apple と GoTrue が決める) では分けない (§21 Q-7 の (a))。
 * ログイン画面は ?error= の値をもう 1 回 decodeURIComponent してから出す (src/app/(auth)/login/page.tsx:65) ので、% を含めない
 */
export const APPLE_WEB_CALLBACK_ERROR_MESSAGE = 'Apple でのログインを完了できませんでした。もう一度お試しください。';

/** ?provider= が apple なら APPLE_WEB_CALLBACK_ERROR_MESSAGE、ほかは null (呼ぶ側は provider に関わらない固定の文 AUTH_LINK_ERROR_MESSAGE を使う。#1917 の続き) */
export function appleCallbackErrorMessage(provider: string | null): string | null {
  return provider === APPLE_CALLBACK_PROVIDER ? APPLE_WEB_CALLBACK_ERROR_MESSAGE : null;
}

export async function storeAppleRefreshTokenFromWebCallback(input: {
  provider: string | null;
  user: User | null;
  session: Session | null;
  log: WebCallbackLogger;
  requestId: string;
}): Promise<'stored' | 'skipped'> {
  if (input.provider !== APPLE_CALLBACK_PROVIDER || !input.user || !hasAppleIdentity(input.user)) return 'skipped';
  const refreshToken = input.session?.provider_refresh_token;
  if (!refreshToken) {
    input.log.info('auth/callback: apple sign-in without provider_refresh_token; nothing stored', { request_id: input.requestId });
    return 'skipped';
  }
  const servicesId = readAppleSignInServerConfig()?.servicesId ?? null;
  if (!servicesId) {
    input.log.info('auth/callback: apple services id is not configured; refresh token not stored', { request_id: input.requestId });
    return 'skipped';
  }
  try {
    await storeAppleRefreshToken(getSupabaseAdmin(), { userId: input.user.id, clientId: servicesId, refreshToken });
    return 'stored';
  } catch (error) {
    input.log.warn('auth/callback: could not store the apple refresh token (sign-in continues)', {
      request_id: input.requestId,
      error_name: error instanceof Error ? error.name : 'unknown',
    });
    return 'skipped';
  }
}
```

`src/app/(auth)/auth/callback/route.ts` の差分は 2 か所。(1) `code` の交換 (`:72-83`) の `if (!error)` の中、`recordWebLoginContextFromRequest` の後に `await storeAppleRefreshTokenFromWebCallback({ provider: requestUrl.searchParams.get('provider'), user: data.user, session: data.session, log: createLogger('GET /auth/callback', requestId), requestId })` を足す (`requestId` は `generateRequestId()` で route の先頭で 1 つ作る)。`provider` の値はログに出してよい (秘密ではない)。(2) `?error=` の分岐 (`:37-47`) の `loginUrl.searchParams.set` (`:45`) の値を、下のブロックのとおり `appleCallbackErrorMessage(…) ?? (今までの式)` にする (S-34。#1917 の続きで、今までの式 (`error_description` か `error`) は `AUTH_LINK_ERROR_MESSAGE` に改めた)。分岐の入り方・`console.error` のログ・redirect 先 (`/login`) は変えない。ほかの分岐 (`token_hash`・`token`・同意画面・`next`) は変えない。

```ts
// tsc:skip
// place=src/app/(auth)/auth/callback/route.ts (差分。import と :43-46 の置き換え)
import { createLogger, generateRequestId } from '@/lib/db-logger'
import { appleCallbackErrorMessage, storeAppleRefreshTokenFromWebCallback } from '@/lib/auth/apple/web-callback'

    // エラーページにリダイレクト（エラー情報付き）
    // Apple (?provider=apple) は Apple・GoTrue の英文を出さず、日本語の固定の文にする (docs/design/mobile/08-sign-in-with-apple.md §12.3・S-34)。
    // ほかの provider (Google など) とメールのリンクも英文を出さず、固定の文 AUTH_LINK_ERROR_MESSAGE (#1917 の続き)
    const loginUrl = new URL('/login', requestUrl.origin)
    loginUrl.searchParams.set(
      'error',
      appleCallbackErrorMessage(requestUrl.searchParams.get('provider')) ?? AUTH_LINK_ERROR_MESSAGE,
    )
    return NextResponse.redirect(loginUrl)
```

### 11.7 環境変数 (`src/lib/env.ts`・`.env.example`)

```ts
// tsc:skip
// place=src/lib/env.ts (差分。PUBLIC_ENV_VARS と SERVER_ENV_VARS に足す行)
// PUBLIC_ENV_VARS (NEXT_PUBLIC_TURNSTILE_SITE_KEY の後):
  NEXT_PUBLIC_APPLE_SIGN_IN: {
    required: false,
    description:
      "Web のログイン・新規登録の画面に Apple のボタンを出すスイッチ (docs/design/mobile/08-sign-in-with-apple.md)。'on' のときだけ出す。" +
      'Supabase の Apple provider と Apple Developer の Services ID の設定が済み、サーバの 4 つ (APPLE_SIGN_IN_*) が本番で効いていることを確かめてから入れる (設計書 §19.3)。' +
      'ビルド時に埋め込まれるので、変えたら再デプロイする',
    whenMissing: 'Apple のボタンを出さない (今までどおり)',
  },
// SERVER_ENV_VARS (末尾):
  APPLE_SIGN_IN_TEAM_ID: {
    required: false,
    description: 'Apple Developer の Team ID (10 文字)。Sign in with Apple の client_secret の iss (docs/design/mobile/08-sign-in-with-apple.md §11.2)',
    whenMissing: 'Apple の refresh token の交換と失効を行わない (ログインはできる。退会のときに Apple 側の失効をスキップする)',
  },
  APPLE_SIGN_IN_KEY_ID: {
    required: false,
    description: 'Sign in with Apple の Key の Key ID (10 文字)。client_secret の kid',
    whenMissing: 'APPLE_SIGN_IN_TEAM_ID と同じ',
  },
  APPLE_SIGN_IN_PRIVATE_KEY: {
    required: false,
    description: 'Sign in with Apple の Key の秘密鍵 (.p8 の中身の PEM。改行は \\n と書く)。client_secret の署名に使う秘密の値',
    whenMissing: 'APPLE_SIGN_IN_TEAM_ID と同じ',
  },
  APPLE_SIGN_IN_SERVICES_ID: {
    required: false,
    description: 'Web の Sign in with Apple の Services ID (Supabase の Apple provider の Client IDs の先頭と同じ値)。Web で入った人の refresh token の client_id',
    whenMissing: 'Web で入った人の refresh token を保管しない (iOS で入った人の分は bundle ID の定数で扱うので影響しない)',
  },
```

`.env.example` には 5 つを値を空にして書く (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` の後に `NEXT_PUBLIC_APPLE_SIGN_IN=`、サーバの節に 4 つ。秘密鍵の書き方 (1 行・改行は `\n`) をコメントに書く)。

- 5 つとも段 A1 で `src/lib/env.ts`・`.env.example` に足す (公開の `NEXT_PUBLIC_APPLE_SIGN_IN` を読むのは段 B の `src/lib/auth/apple-sign-in-flag.ts` だけだが、一覧に載っていて読まれない変数を咎める番兵は無い (`tests/env-source-scan.test.ts` の規則は「読む変数が一覧にある」「一覧の変数が `.env.example` にある」の向き)。段 B は env の 3 ファイルに触らない)。
- `src/__tests__/lib/env.test.ts`: 足すのは §14.2 の新しい it 1 つだけ (段 A1)。`:361-373` の it の `publicNames` は `Object.keys(publicEnvSchema.shape)` からの導出で、名前を足す固定の一覧は無い (`PUBLIC_ENV_VARS` に足せば自動で入る)。

### 11.8 法務 (段 D。`src/lib/legal/privacy-text.ts`・`tests/legal-claims-1901.ts`・`tests/legal-text-1901.test.ts`・版)

cross/20 §9.3 (内容が変わる改定は版を上げる)・§10 (主張の表) の規則のまま。billing/03 §11 が足した形と同じ手順。

(a) 第7条 `PRIVACY_PROCESSORS`: `Google` の行の直後に足す。

```ts
// tsc:skip
// place=src/lib/legal/privacy-text.ts (PRIVACY_PROCESSORS の Google の行の後)
  {
    name: 'Apple',
    country: 'アメリカ合衆国',
    purpose: 'Apple アカウントでのログイン',
    data: 'ログインのときに Apple と当社の間でやりとりする、Apple アカウントの識別子、メールアドレス（メールアドレスを隠す選択をした場合は Apple が発行する転送用のアドレス）、名前（初回のログインのときだけ）、退会のときに Apple でのログインを解除するためのトークン',
    evidence: { file: 'apps/mobile/src/lib/appleSignIn.ts', needle: 'provider: "apple"' },
  },
```

`evidence` のファイルは段 A2 が新設する (§11.5 の `signInWithIdToken({ provider: "apple", … })` の行が needle に当たる)。T-7 がファイルの実在と needle を求めるので、段 D は A2 のマージ後に作る (§15)。

`PRIVACY_PROCESSORS` の注の「ストアの事業者 (Apple・Google) は委託先ではないので載せない (第3条に書く。billing/03 Q-17)」を「ストアの決済の事業者としての Apple・Google は委託先ではないので載せない (第3条に書く。billing/03 Q-17)。ログインの事業者としての Google・Apple は載せる (mobile/08 §11.8)」に書き換える。

(b) 第3条の「アカウント」の行: `'メールアドレス、パスワード（ハッシュ化して保存します）、Google アカウントで登録した場合に Google から受け取る情報、生年月日、ニックネーム、ご利用のプラン'` → `'メールアドレス、パスワード（ハッシュ化して保存します）、Google アカウントまたは Apple アカウントで登録した場合に Google または Apple から受け取る情報（Apple でメールアドレスを隠す選択をした場合は転送用のアドレス、Apple でのログインを退会のときに解除するためのトークンを含みます）、生年月日、ニックネーム、ご利用のプラン'`。

(c) 第10条の外部送信の表: `Google（ログインの画面）` の行の直後に `['Apple（ログインの画面）', 'Apple のログイン画面で Apple が取得する情報', 'Apple アカウントでのログイン']` を足す。

(d) 主張の表 `tests/legal-claims-1901.ts`: `privacy-3#3` の `chars` を (b) の文字数に直し、`evidence` に `apps/mobile/src/lib/appleSignIn.ts` を足す。`privacy-7` と `privacy-10` に 1 行ずつ足す (`id` はその節の既存の最大の番号の次。`fragment` は `'Apple | アメリカ合'`・`'Apple（ログインの画面'`。`chars` は T-35 の文脈で数えた文字数。`basis: 'product'`。`evidence: 'F-16・apps/mobile/src/lib/appleSignIn.ts・src/app/(auth)/login/page.tsx'`)。`LEGAL_CLAIM_COUNT` を 424 → **426** (段 D の 2 行)。同じ PR #1997 に cross/21 §7.12 の作者名の表示の 7 行も入り、main の値は **433**。

(e) `tests/legal-text-1901.test.ts` T-33: `expect(names).not.toContain('Apple');` を、ログインの事業者としての Apple は載り、決済の事業者としては載らないことの確認に替える:

```ts
// tsc:skip
// place=tests/legal-text-1901.test.ts (T-33 の中。expect(names).not.toContain('Apple') を置き換える)
    const apple = PRIVACY_PROCESSORS.find((p) => p.name === 'Apple');
    expect(apple?.purpose, 'Apple はログインの事業者として載る (mobile/08 §11.8)').toBe('Apple アカウントでのログイン');
    for (const word of LEGAL_TEXT_PAID_TERMS) expect(`${apple?.purpose} ${apple?.data}`).not.toContain(word);
```

T-34 の `PRIVACY_DATA_TABLES` に `apple_sign_in_tokens` → `'アカウント'` を足す (段 A1 で表が増えた時点で足す。T-34 は migration の表を数えるので、段 A1 のテストが赤にならないように段 A1 に含める)。

(f) 版: `packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS` の 2 文書を `v2026.3` → **`v2026.4`** (`effectiveDate` は仮の実在する日付を置き、行末に `// 仮置き: マージ直前に公開日へ置き換える` を付ける。オーケストレーターがマージの直前に施行日 (予告に書いた施行日で、その日にマージ・デプロイする。Q-13 は (a)) へ置き換えて目印を消す (cross/20 §9.4 の 3・4。施行日 = デプロイ日)。billing/03 §11.6 と同じ)。ファイル先頭の注と `LEGAL_DOCUMENTS` の JSDoc に「v2026.4 は mobile/08 (Sign in with Apple) で委託先に Apple (ログイン) を足した版。改定前の版 (v2026.3) の文面は docs/legal/archive/v2026.3/ に控えてある」の段落を足す。利用規約の本文は変えないが、両文書の版は同じ値で動かす (既存の 3 回の改定と同じ)。

(g) 旧版の控え: `docs/legal/archive/v2026.3/terms.md`・`privacy.md` を新設 (形は `docs/legal/archive/v2026.2/` と同じ。見出し・版 `v2026.3`・施行日 `2026-10-22`・控えの元・「この版は mobile/08 の版 v2026.4 に置き換わった…」の文・`---`・本文)。

(h) テストの版の直書き: origin/main ではテストに `v2026.3` の直書きは無い (`git grep -F v2026.3` の当たりは `packages/shared/src/legal-versions.ts` だけ。§17)。段 D の実装で同じ `git grep` を流し直し、当たるテストが増えていれば `v2026.4` に直す。

(i) 改定の予告 (cross/20 §9.4 の 2。コードは変えない。オーケストレーターの工程。予告のお知らせの投稿はオーナー (§0.4)。§7.3 (d)): 段 D が 2 枚 PASS したら、マージの前に施行日をオーナーに伺う (Q-13 は (a) 予告する。§21)。予告するのは、cross/20 §9.3 の原則 (版を上げる改定すべてで §9.4 の 2 を必ず行う。除外は `v2026.1`・`v2026.2`・`v2026.3` の公開だけ) と、公開中のプライバシーポリシー第18条 1 項 (`src/lib/legal/privacy-text.ts` の `privacy-18`)・利用規約第24条 1 項 (`src/lib/legal/terms-text.ts` の `terms-24`) の「施行日の前にお知らせに掲載」の約束による。

- (a) 予告する: 施行日を決め、施行日より前に `/admin/announcements` でお知らせを作って公開 (`is_public`) にする。中身は cross/20 §9.4 の 2 の項目のとおり (題「利用規約・プライバシーポリシーの改定のお知らせ」・改定の概要・施行日・施行日以後に同意をお願いすること・同意するまでの間の扱い (利用規約第24条 2 項)・同意の前でもできること)。改定の概要は「プライバシーポリシー: Apple アカウントでのログインを始めるにあたり、委託先 (第7条)・アカウントの情報 (第3条)・外部送信 (第10条) に Apple を足します。利用規約: 文面は変わりませんが、版をプライバシーポリシーと同じ値に更新します」。施行日に (f) の `effectiveDate` を施行日に置き換えて段 D をマージ・デプロイする。
- (b) 予告しない: 使わない (Q-13 は (a)。§21)。
- 施行日を待つ間に別の改定が `v2026.4` を先に使ったら (main にマージ)、段 D の版と (g) の控えの道をその次の版に改め (billing/03 v1.11 と同じ)、お知らせの版と施行日も直す。

## 12. エラー表

### 12.1 iOS (`signInWithApple` の結果 → 画面)

| 出来事 | 結果 | 画面 | 文 (固定) |
|---|---|---|---|
| 利用者がシートを閉じた (`ERR_REQUEST_CANCELED`) | `cancelled` | 何もしない | — |
| Apple のほかの失敗 (`ERR_REQUEST_FAILED`・`ERR_REQUEST_NOT_HANDLED`・`ERR_INVALID_RESPONSE` など) | `failed` | `Alert("Appleログイン失敗", …)` | `APPLE_SIGN_IN_MESSAGES.failed` |
| `identityToken` が無い | `failed` | 同上 | `APPLE_SIGN_IN_MESSAGES.noIdentityToken` |
| `signInWithIdToken` の error (`provider_disabled`・nonce の不一致・`bad_jwt`・通信の失敗・`signup_disabled`) | `failed` | 同上 | `APPLE_SIGN_IN_MESSAGES.failed` |
| `updateUser` (名前) の失敗 | `signed_in` | 進む | — (`console.warn`) |
| `POST /api/auth/apple/authorization` の失敗 (どの status でも) | `signed_in` | 進む | — (`console.warn`) |
| 新規登録画面の同じ失敗 | `failed` | `Alert("Apple登録失敗", …)` | 同じ文 |

### 12.2 `POST /api/auth/apple/authorization`

| status | code | 文 (本文の `error`) | 原因 |
|---|---|---|---|
| 400 | `INVALID_CHARACTER` | (既存の `NULL_CHARACTER_ERROR_MESSAGE`) | 本文に U+0000 |
| 400 | `VALIDATION_ERROR` | 入力の形が正しくありません。 | JSON でない・`authorization_code` が無い・空・1,024 文字超 |
| 400 | `APPLE_AUTHORIZATION_CODE_INVALID` | Apple の認可の情報が有効ではありません。もう一度ログインしてください。 | Apple が `invalid_grant` (5 分超・使用済み・別の client) |
| 401 | `AUTH_UNAUTHENTICATED` | (`sessionsFailure` の固定の文) | Bearer が無い・失効 |
| 403 | `AUTH_ACCOUNT_FROZEN` | (同上) | 凍結中 |
| 409 | `APPLE_IDENTITY_NOT_LINKED` | このアカウントは Apple でログインしていません。 | `identities` に `apple` が無い |
| 429 | `RATE_LIMITED` | (`rateLimitExceededResponse` の固定の文) | 5 回 / 10 分 (利用者ごと) |
| 500 | `INTERNAL_ERROR` | (`internalError` の固定の文) | 秘密鍵が壊れていて `client_secret` を作れない (`step: 'client_secret'`。`APPLE_SIGN_IN_PRIVATE_KEY` の `\n` の書き誤り・ヘッダの欠け・別の鍵)、Apple に届かない・時間切れ・5xx・本文が壊れている (`step: 'exchange'`)、表に書けない (`step: 'store'`)、`user_profiles` を読めない (`sessionsFailure`) |

### 12.3 Web (段 B)

| 出来事 | 画面 | 文 (固定) |
|---|---|---|
| `signInWithOAuth` が error を返した (まれ。URL を作れない) | 赤いバナー | Apple でのログインに失敗しました。しばらくしてからお試しください。 / Apple での登録に失敗しました。しばらくしてからお試しください。 |
| Apple の画面で取り消した・拒否した、Apple / GoTrue の失敗 (`user_cancelled_authorize`・`access_denied`・`server_error` など。値で分けない) | Supabase → `/auth/callback?provider=apple&…&error=…` (F-18) → `/login?error=<固定の文>` → ログイン画面の赤いバナー (新規登録画面から始めてもログイン画面。S-34) | `APPLE_WEB_CALLBACK_ERROR_MESSAGE`: Apple でのログインを完了できませんでした。もう一度お試しください。(§21 Q-7 の既定 (a)) |
| Supabase が flow state を読めない (期限切れ・使用済み) | Supabase が Site URL へ送る (`/auth/callback` を通らない。既存。F-18) | — (本書は変えない。トップの画面 `src/app/page.tsx` は `?error=` を読まないので、英文は画面に出ない) |
| `code` の交換の失敗 | 既存 (`/login`) | — |
| refresh token の保管の失敗 | 影響なし (振り分けは既存のまま) | — (`warn`) |

### 12.4 退会 (`apple_revoke`)

| 出来事 | 退会 | ログ |
|---|---|---|
| 行が無い | 続く | なし |
| 秘密が無い | 続く | `warn` (`skipped: 'not_configured'`・行数) |
| 表を読めない | 続く | `warn` (`error_name`) |
| Apple が 200 | 続く | なし (成功のログの `apple.revoked`) |
| Apple が 4xx / 5xx / 時間切れ (段階の時間の上限の中で最大 2 回。1 回目で上限を使い切ったら 1 回) | 続く | `warn` (`client_id`・`attempts`・`apple_status`・`apple_error`・`budget_exhausted`) |
| 締め切り (`APPLE_REVOKE_TOTAL_BUDGET_MS`) を過ぎた後の行 | 続く (Apple を呼ばない。`failed` に数える) | `warn` 1 回 (`not_attempted`・`budget_ms`) |
| 秘密鍵が壊れていて `client_secret` を作れない (行ごと) | 続く (Apple を呼ばない。`failed` に数える) | `warn` (`client_id`・`error_name`) |

## 13. 定数と環境変数

### 13.1 名前付き定数 (根拠つき。マジックナンバーを式に埋めない)

| 名前 | 値 | 場所 | 根拠 |
|---|---|---|---|
| `APPLE_SIGN_IN_FLAG_ON` | `'on'` | `packages/shared/src/apple-sign-in.ts` | `LEGAL_CONSENT_FLAG_ON` と同じ流儀 (明示的に on のときだけ) |
| `APPLE_AUTHORIZATION_CODE_MAX_LENGTH` | 1024 | 同上 (`schemas.ts` が import する) | Apple の認可コードは数百文字。超える本文は形の誤り |
| `APPLE_SIGN_IN_MESSAGES` | 3 つの固定の文 | 同上 | Apple・GoTrue の英文を出さない (#1172 の規律) |
| `APPLE_SIGN_IN_NATIVE_CLIENT_ID` | `'com.homegohan.app'` | `src/lib/auth/apple/config.ts` | `apps/mobile/app.json` の `ios.bundleIdentifier` (テストが突き合わせる) |
| `APPLE_TOKEN_ENDPOINT` / `APPLE_REVOKE_ENDPOINT` / `APPLE_CLIENT_SECRET_AUDIENCE` | Apple の URL | 同上 | F-14 |
| `APPLE_CLIENT_SECRET_TTL_SECONDS` | 300 | 同上 | 要求ごとに作る。時計のずれに耐え、漏れたときの時間を短く。上限 6 か月 |
| `APPLE_API_TIMEOUT_MS` | 5000 | 同上 | Turnstile の確認と同じ。運用で変える想定が無いので環境変数にしない。交換はこの値、失効はこの値と締め切りまでの残りの短いほう |
| `APPLE_REVOKE_ATTEMPTS` | 2 | 同上 | 一時の失敗を 1 回だけ吸収する (失敗の種類は区別しない)。2 回目も `APPLE_REVOKE_TOTAL_BUDGET_MS` の締め切りの前だけ |
| `APPLE_REVOKE_TOTAL_BUDGET_MS` | 3000 | 同上 | 退会の route の `maxDuration` 60 秒 (`src/app/api/account/delete/route.ts:9`) − Storage の掃除の上限 45 秒 (`DEFAULT_MAX_DURATION_MS`。`src/lib/account-deletion-storage.ts:55`) − 完了メールの待ちの上限 5 秒 (`ACCOUNT_DELETED_EMAIL_TIMEOUT_MS`。`src/lib/account-deletion-notification.ts:34`) = 10 秒が、段階全体の上限をコードに持たない段階 (`check_blockers`・`billing`・`prepare`・`release_membership`・`record`・`billing_recheck`・`delete_user`・完了の記録。Stripe の段階は 1 回の呼び出しに 10 秒の上限 (`src/lib/billing/stripe-gateway.ts:33`) があるが、段階全体の上限は無い) と `apple_revoke` の分。そのうち 3 秒を Apple に充て、ほかの段階に 7 秒を残す (45 + 5 + 3 = 53 < 60。`src/__tests__/lib/auth/apple/config.test.ts` が和を確かめる)。Apple のふだんの応答 (1 秒以内) なら 2 行でも収まる。Apple が応答しないときは 1 行目の 1 回目で使い切り、段階は約 3 秒で終わる (S-32)。環境変数にしない (3 つの上限と組で決まる値で、これだけを上げるとほかの段階の分 (7 秒) が減り、60 秒を超えうる) |
| `AUTH_PROVIDER_BUTTON_MIN_HEIGHT` | 56 (pt) | `apps/mobile/src/components/auth/AppleSignInButton.tsx` (`login.tsx`・`signup.tsx` が Google のボタンの `minHeight` に import する) | ログイン・新規登録の画面の Apple と Google のボタンの下限の高さ。Google のボタンの中身なりの高さ (`paddingVertical` 14 × 2 + `borderWidth` 1 × 2 + アイコン 20 と 15pt の題名の行の高さの大きいほう = 標準の文字の大きさで約 50〜52pt。F-17) より大きくして、標準では 2 つともちょうどこの高さで並ぶ。それより高くなる (文字の大きさの設定) ときは Apple が Google の測った高さに合わせる (`useAuthProviderButtonHeight`)。Web のボタン (`APPLE_SIGN_IN_BUTTON_HEIGHT_PX` = 56) と HIG の例 (56pt) と同じ。HIG の最小 30pt を満たす。見た目の値で、運用で変える値ではないので環境変数にしない |
| `APPLE_SIGN_IN_BUTTON_HEIGHT_PX` / `APPLE_SIGN_IN_BUTTON_FONT_PX` | 56 / 24 | `src/components/auth/AppleSignInButton.tsx` (高さは `login/page.tsx`・`signup/page.tsx` が Google のボタンの `style.height` に import する) | HIG の 43% (56pt / 24pt の例)。高さは Apple と Google のボタンで同じ px にする (rem のクラスはブラウザの文字の大きさの設定でずれる。§10.2) |
| `APPLE_LOGO_IMAGE_SCALE` | 3 | 同上 | ロゴの画像を Apple の URL から取るときの `scale` (1〜6)。高解像度の画面 (devicePixelRatio 3 まで) で滲まない。画像の一辺 = 56 × 3 = 168 画素 (§11.6) |
| `APPLE_LOGO_SRC` | `'/auth/apple-logo-on-black.png'` | 同上 | ロゴの画像の置き場 (`public/` からの道)。画像は Apple の URL から取った PNG (F-14・§11.6)。`tests/apple-sign-in-logo-asset.test.ts` がファイルの実在を確かめる |
| `APPLE_SIGN_IN_TITLES` | `{ continue: 'Appleで続ける', sign_up: 'Appleで登録' }` | 同上 | HIG の題名 (Continue / Sign up with Apple) に当たる日本語。Google の「Googleで続ける」「Googleで登録」と対 (§10.2・R-13) |
| `APPLE_CALLBACK_PROVIDER` | `'apple'` | `src/lib/auth/apple/web-callback.ts` | `/auth/callback` の `?provider=` のうち refresh token の保管の対象 (`?error=` のときに固定の文にする対象も同じ)。Web の Apple のボタンだけが `redirectTo` に足す値 (§9.5)。Supabase の provider の名前と同じ |
| `APPLE_WEB_CALLBACK_ERROR_MESSAGE` | `'Apple でのログインを完了できませんでした。もう一度お試しください。'` | 同上 | `?provider=apple` の `/auth/callback` に `?error=` が付いて戻ったときに、ログイン画面のバナーに出す固定の文 (S-34・R-19)。取り消しにも失敗にも合う文にする (`error` の値で分けない。§21 Q-7)。ログイン画面がもう 1 回 `decodeURIComponent` するので `%` を含めない |
| `MS_PER_SECOND` | 1000 | `src/lib/auth/apple/authorization.ts`・`revocation.ts` (どちらもモジュールの中だけ。export しない)・`src/__tests__/lib/auth/apple/config.test.ts` | 秒とミリ秒の換算 (JWT の `iat` は秒・`Date` はミリ秒・退会の route の `maxDuration` は秒)。単位の換算で、運用で変える値ではない |
| `PNG_SIGNATURE` | `[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]` | `tests/apple-sign-in-logo-asset.test.ts` (テストの中だけ) | PNG の仕様の先頭 8 バイトの署名 |
| `IHDR_WIDTH_OFFSET` / `IHDR_HEIGHT_OFFSET` | 16 / 20 | 同上 | PNG の仕様の固定の位置: 署名 8 バイト + IHDR の長さ 4 バイト + 種類 `IHDR` 4 バイト = 16 から幅 (4 バイトのビッグエンディアン)、その次の 20 から高さ |
| レート制限 `auth-apple-authorization` | 5 回 / 10 分 (利用者ごと) | `src/lib/rate-limit.ts` | `auth-password-change` と同じ。ログイン 1 回につき 1 回 |

### 13.2 環境変数

| 名前 | 場所 | 必須 | 無いとき |
|---|---|---|---|
| `EXPO_PUBLIC_APPLE_SIGN_IN` | EAS (ビルド時)。`apps/mobile/env.example` | 任意 | iOS に Apple のボタンを出さない |
| `NEXT_PUBLIC_APPLE_SIGN_IN` | Vercel (ビルド時)。`src/lib/env.ts`・`.env.example` | 任意 | Web に Apple のボタンを出さない |
| `APPLE_SIGN_IN_TEAM_ID` / `APPLE_SIGN_IN_KEY_ID` / `APPLE_SIGN_IN_PRIVATE_KEY` | Vercel (サーバ)。`src/lib/env.ts`・`.env.example` | 任意 | 交換・失効をしない (ログイン・退会は止めない) |
| `APPLE_SIGN_IN_SERVICES_ID` | Vercel (サーバ) | 任意 | Web で入った人の refresh token を保管しない |

秘密の値 (`APPLE_SIGN_IN_PRIVATE_KEY`) は `.env.example` に値を書かない (`tests/no-committed-credentials.test.ts`)。

スイッチ 2 つ (`EXPO_PUBLIC_APPLE_SIGN_IN`・`NEXT_PUBLIC_APPLE_SIGN_IN`) は、サーバの秘密 (iOS は Team ID・Key ID・秘密鍵の 3 つ、Web はそれと Services ID) が本番のデプロイに効いていることを §19.3 の「スイッチの前の確認」で確かめてから入れる (無い間に入った人は refresh token が保管されず、退会のときに失効されない。§7.3 (d))。

## 14. テスト (it の一覧)

本物の Apple・Supabase に繋がない。iOS は `expo-apple-authentication`・`expo-crypto`・`../../src/lib/supabase`・`../../src/lib/api` を `jest.mock`、サーバは `fetch` を引数で差し替え、表は `from` の偽物。

### 14.1 モバイル (jest。`apps/mobile/__tests__/`)

| ファイル | it |
|---|---|
| `lib/appleSignIn.test.ts` (新設) | `isAppleSignInEnabled: iOS かつ EXPO_PUBLIC_APPLE_SIGN_IN=on のときだけ true (ON・空白つきも true。空・off・Android は false)` / `isAppleSignInAvailable: 有効でも isAvailableAsync が false・投げたら false` / `signInWithApple: nonce は randomUUID を SHA-256 (hex) にして Apple へ、raw を Supabase へ渡す` / `requestedScopes は FULL_NAME と EMAIL` / `ERR_REQUEST_CANCELED は cancelled (Supabase を呼ばない・アラートの文を持たない)` / `ほかの Apple の失敗は failed (APPLE_SIGN_IN_MESSAGES.failed)` / `identityToken が無ければ failed (noIdentityToken)` / `signInWithIdToken の error は failed` / `初回 (fullName あり・user_metadata.full_name 無し) は updateUser({ data: { full_name, given_name, family_name } })` / `full_name が既にあれば updateUser を呼ばない` / `fullName が null なら updateUser を呼ばない` / `updateUser が error を返しても signed_in (console.warn だけ・投げない・認可コードの登録は続けて呼ぶ。S-31)` / `認可コードを POST /api/auth/apple/authorization に送る (Bearer は getApi が付ける)` / `登録の API が失敗しても signed_in (console.warn だけ)` / `authorizationCode が null なら API を呼ばない` |
| `lib/routeAfterSignIn.test.ts` (新設。login.test.tsx の 4-3 の振り分けの検査をこの関数に対して) | `?next= が / 始まりならそこへ` / `完了 → /(tabs)/home・開始済み → /onboarding/resume・未開始 → /onboarding/welcome` / `admin も同じ振り分け (#1122)` / `user が無ければ何もしない` |
| `components/AppleSignInButton.test.tsx` (新設) | `isAppleSignInAvailable が true なら AppleAuthenticationButton を描く (SIGN_IN / SIGN_UP・WHITE_OUTLINE・cornerRadius は radius.lg・幅 100%・高さは props の height)` / `false なら何も描かない` / `disabled のとき押せない (pointerEvents none)` / `useAuthProviderButtonHeight: 初めの height は AUTH_PROVIDER_BUTTON_MIN_HEIGHT (56)` / `useAuthProviderButtonHeight: Google の onLayout の高さが AUTH_PROVIDER_BUTTON_MIN_HEIGHT より大きければその高さ、以下なら AUTH_PROVIDER_BUTTON_MIN_HEIGHT (大きくしたあと標準に戻しても下限に戻る。S-33)` |
| `auth/login.test.tsx` (追記) | `5-1. スイッチ on・iOS: Apple のボタン (login-apple-button) が Google の前にある` / `5-2. 押すと signInWithApple → signed_in → routeAfterSignIn (ホームへ)` / `5-3. cancelled はアラートを出さず画面に留まる` / `5-4. failed は Alert("Appleログイン失敗", 文)` / `5-5. スイッチ無し: ボタンが無い` / `5-6. ?next= は Apple でも効く` / `5-7. Apple のボタンの高さは Google のボタンと同じ: Google のボタンの style の minHeight は AUTH_PROVIDER_BUTTON_MIN_HEIGHT、Apple の高さは初め AUTH_PROVIDER_BUTTON_MIN_HEIGHT、Google の onLayout (高さ 70) のあとは 70 (S-33)`。既存の 4-1〜4-3 は `routeAfterSignIn` の移動後も緑のまま (`mockFrom` の形は同じ) |
| `auth/signup.test.tsx` (追記) | `4. スイッチ on: Apple で登録 (signup-apple-button) がある。押すと signInWithApple → routeAfterSignIn` / `5. failed は Alert("Apple登録失敗", 文)` / `6. スイッチ無し: 無い` / `7. Apple で登録のボタンの高さは Google で登録のボタンと同じ (login の 5-7 と同じ検査。S-33)` |
| `lib/env-example.test.ts` (既存。自動) | `EXPO_PUBLIC_APPLE_SIGN_IN` が `env.example` にあること |

`expo-apple-authentication`・`expo-crypto` の正典のモック。`login.tsx`・`signup.tsx` を描くテストは、`AppleSignInButton.tsx` が読み込みのときに `AppleAuthenticationButtonType` を読む (`BUTTON_TYPE`) ので、スイッチ無しの画面のテストでもこの 2 つを `jest.mock` する (jest の native module の扱いに結果を依存させない)。`auth/turnstile-screens.test.tsx` はこの形のまま足す (期待値は変えない)。`auth/login.test.tsx`・`auth/signup.test.tsx`・`lib/appleSignIn.test.ts`・`components/AppleSignInButton.test.tsx` はこの形を土台に、it ごとに `mockResolvedValue` などで上書きする。Apple のボタンを描く冊 (`components/AppleSignInButton.test.tsx`・`auth/login.test.tsx`・`auth/signup.test.tsx`) は `AppleAuthenticationButton` だけを下の 2 つ目のブロックの「props を写す偽物」に替える (押す・高さを読むため。既存の `apps/mobile/__tests__/app/frozen-screen.test.tsx:11-21` と同じ、`mock` で始まる配列に props を残して host の要素を返す形)。列挙の値は文字列にする (本物の数値に意味は無く、テストは名前で比べる)。

```ts
// tsc:skip
// place=apps/mobile/__tests__/auth/turnstile-screens.test.tsx (ほかの jest.mock の並びに足す。login.test.tsx・signup.test.tsx・appleSignIn.test.ts・AppleSignInButton.test.tsx も同じ形を土台にする)
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  signInAsync: jest.fn(),
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', CONTINUE: 'CONTINUE', SIGN_UP: 'SIGN_UP' },
  AppleAuthenticationButtonStyle: { WHITE: 'WHITE', WHITE_OUTLINE: 'WHITE_OUTLINE', BLACK: 'BLACK' },
  AppleAuthenticationScope: { FULL_NAME: 'FULL_NAME', EMAIL: 'EMAIL' },
}));
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'raw-nonce'),
  digestStringAsync: jest.fn(async () => 'hashed-nonce'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));
```

```ts
// tsc:skip
// place=apps/mobile/__tests__/components/AppleSignInButton.test.tsx (auth/login.test.tsx・auth/signup.test.tsx も同じ形。上の正典のモックの AppleAuthenticationButton だけを替える)
const mockAppleButtonProps: Array<{ buttonType: string; buttonStyle: string; cornerRadius: number; style: { width: string; height: number }; onPress: () => void }> = [];
jest.mock('expo-apple-authentication', () => {
  const ReactActual = require('react');
  const { Pressable } = require('react-native');
  return {
    isAvailableAsync: jest.fn().mockResolvedValue(false),
    signInAsync: jest.fn(),
    // 受けた props を残し、押せる host の要素を返す (testID で押す。高さは mockAppleButtonProps.at(-1).style.height で読む)
    AppleAuthenticationButton: (props: (typeof mockAppleButtonProps)[number]) => {
      mockAppleButtonProps.push(props);
      return ReactActual.createElement(Pressable, { testID: 'apple-authentication-button', style: props.style, onPress: props.onPress });
    },
    AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', CONTINUE: 'CONTINUE', SIGN_UP: 'SIGN_UP' },
    AppleAuthenticationButtonStyle: { WHITE: 'WHITE', WHITE_OUTLINE: 'WHITE_OUTLINE', BLACK: 'BLACK' },
    AppleAuthenticationScope: { FULL_NAME: 'FULL_NAME', EMAIL: 'EMAIL' },
  };
});
// beforeEach で mockAppleButtonProps.length = 0 に戻す。
// Google のボタンの onLayout は RNTL の fireEvent で起こす (RNTL は 'layout' を onLayout に当てる):
//   fireEvent(getByTestId('login-google-button'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 70 } } });
// Google のボタンの minHeight は StyleSheet.flatten(getByTestId('login-google-button').props.style).minHeight で読む。
// useAuthProviderButtonHeight の it は renderHook (@testing-library/react-native) と act で onGoogleButtonLayout を呼ぶ。
```

### 14.2 サーバ (vitest)

| ファイル | it |
|---|---|
| `src/__tests__/lib/auth/apple/client-secret.test.ts` (新設) | `ES256 の JWT: header は { alg: 'ES256', kid }、payload は iss / iat / exp = iat + ttl / aud / sub` / `署名は node:crypto の verify (ieee-p1363) で検証できる (テスト用に生成した P-256 の鍵)` / `exp - iat が 6 か月 (15,777,000 秒) を超えない (APPLE_CLIENT_SECRET_TTL_SECONDS)` |
| `src/__tests__/lib/auth/apple/config.test.ts` (新設) | `APPLE_SIGN_IN_NATIVE_CLIENT_ID は apps/mobile/app.json の ios.bundleIdentifier と同じ` / `4 つのうち Team ID・Key ID・秘密鍵のどれかが無ければ null` / `秘密鍵の \n を改行に戻す` / `Services ID が無ければ servicesId は null (ほかはそろう)` / `退会の時間の予算: APPLE_REVOKE_TOTAL_BUDGET_MS + DEFAULT_MAX_DURATION_MS (src/lib/account-deletion-storage.ts) + ACCOUNT_DELETED_EMAIL_TIMEOUT_MS (src/lib/account-deletion-notification.ts) が、退会の route の maxDuration (秒) をミリ秒にした値より小さい` (秒 → ミリ秒は名前付きの定数 `MS_PER_SECOND`。maxDuration は `src/app/api/account/delete/route.ts` の本文を `/export const maxDuration = (\d+);/` で読む。`tests/account-deletion-owner-guard-migration-contract.test.ts:188` と同じ読み方。2 つの定数は import する。`account-deletion-notification.ts` の import 先 `@/lib/emails/send` は `tests/account-deletion-email.test.ts` が `importOriginal` で実物を読んでいる) |
| `packages/shared/src/apple-sign-in.test.ts` (新設。段 A1。`packages/shared/src/*.test.ts` の既存の置き方) | `isAppleSignInFlagOn: 'on'・'ON'・' on ' は true` / `undefined・''・'off'・'true'・'1' は false` / `APPLE_SIGN_IN_MESSAGES は failed・signupFailed・noIdentityToken の 3 つで、どれも空でない日本語の文 (Apple・GoTrue の英文の語 (provider・nonce・token など) を含まない)` |
| `src/__tests__/lib/auth/apple/schemas.test.ts` (新設。段 A1) | `AppleAuthorizationBodySchema: 1 文字と APPLE_AUTHORIZATION_CODE_MAX_LENGTH 文字は通り、空・APPLE_AUTHORIZATION_CODE_MAX_LENGTH + 1 文字・authorization_code が無い・文字列でない は通らない` / `AppleTokenResponseSchema: refresh_token が無い・空は通らない。access_token・id_token・token_type・expires_in は無くても通る` / `AppleErrorResponseSchema: error が無ければ通らない。error_description は無くても通る` / `AppleAuthorizationResponseSchema: { stored: true } と { stored: false, reason: 'not_configured' } は通り、{ stored: false } (reason 無し)・ほかの reason は通らない` |
| `src/__tests__/lib/auth/apple/rest.test.ts` (新設) | `exchange: form (client_id・client_secret・code・grant_type=authorization_code) を /auth/token へ POST し、200 の refresh_token を返す` / `redirect_uri を送らない` / `400 invalid_grant は invalid_code` / `ほかの 4xx・5xx・壊れた本文・例外 (時間切れ) は unavailable (error_description は結果に入れない)` / `revoke: token_type_hint=refresh_token で POST。200 は ok` / `失敗は status と error` / `exchange と、timeoutMs を渡さない revoke は AbortSignal.timeout(APPLE_API_TIMEOUT_MS) を付ける` / `revoke に timeoutMs を渡すと AbortSignal.timeout(timeoutMs) を付ける` (どちらも `vi.spyOn(AbortSignal, 'timeout')` の引数で見る) |
| `src/__tests__/lib/auth/apple/tokens.test.ts` (新設) | `store: upsert の onConflict は user_id,client_id` / `list: user_id で絞って client_id と refresh_token を返す` / `error は投げる` |
| `src/__tests__/lib/auth/apple/authorization.test.ts` (新設) | `not_configured なら Apple を呼ばない` / `secret の sub と client_id は bundle ID` / `invalid_code → status invalid_code` / `unavailable → unavailable` / `store の失敗 → store_failed (error を持つ)` / `秘密鍵が壊れていれば secret_failed (投げない・Apple を呼ばない)` / `成功 → stored (upsert の行)` / `hasAppleIdentity: provider apple があれば true` |
| `src/__tests__/lib/auth/apple/revocation.test.ts` (新設) | `行が無ければ Apple を呼ばず tokens 0` / `秘密が無ければ skipped not_configured と warn` / `行ごとに client_id を sub にした secret で revoke` / `締め切りの前なら失敗は 2 回まで試し、2 回目も失敗なら failed に数えて warn (attempts 2。投げない)` / `秘密鍵が壊れていても投げず、行ごとに failed に数えて warn (Apple を呼ばない。PEM を warn に出さない)` / `表の読み取りの失敗は warn して tokens 0` / `予算を超えたら残りの行を呼ばずに failed にして投げない: 2 行・偽の fetch が偽の時計を budgetMs 進めて時間切れ (例外) を返す → fetch は 1 回だけ (1 行目の 1 回目)・2 行目は呼ばない・{ tokens: 2, revoked: 0, failed: 2 }・warn は 1 行目 (attempts 1・budget_exhausted true) と締め切り (not_attempted 1・budget_ms) の 2 つ` / `1 回目の失敗で締め切りを過ぎたらやり直さない (1 行・fetch 1 回・attempts 1)` / `試行の待ちは APPLE_API_TIMEOUT_MS と締め切りまでの残りの短いほう (budgetMs 3000 で 1 回目は 3000、budgetMs 10000 で 1 回目は 5000。vi.spyOn(AbortSignal, 'timeout') の引数で見る)` / `budgetMs を省略すると APPLE_REVOKE_TOTAL_BUDGET_MS (偽の時計を APPLE_REVOKE_TOTAL_BUDGET_MS 進める fetch で、2 行目を呼ばない)`。偽の時計は fetch の中でだけ進める (`now` は呼ぶたびに同じ値を返す) |
| `src/__tests__/lib/auth/apple/web-callback.test.ts` (新設) | `provider が apple でなければ skipped (何も読まない)` / `identities に apple が無ければ skipped` / `provider_refresh_token が無ければ info で skipped` / `Services ID が無ければ skipped` / `そろえば Services ID の行として store` / `store の失敗は warn で skipped (投げない)` / `appleCallbackErrorMessage: 'apple' なら APPLE_WEB_CALLBACK_ERROR_MESSAGE、null・'google'・'' なら null` / `APPLE_WEB_CALLBACK_ERROR_MESSAGE は空でなく日本語を含み、英文だけの文ではなく、% を含まない (decodeURIComponent しても同じ文)` |
| `src/__tests__/api/auth/apple-authorization.test.ts` (新設) | `本文の形が違えば 400 VALIDATION_ERROR (Supabase を作らない)` / `1,025 文字は 400` / `未認証は 401` / `凍結は 403` / `レート制限は 429` / `apple の identity が無ければ 409 APPLE_IDENTITY_NOT_LINKED (Apple を呼ばない)` / `not_configured は 200 { stored: false, reason }` / `invalid_code は 400 APPLE_AUTHORIZATION_CODE_INVALID` / `unavailable は 500 (本文は固定の文。ログに step exchange)` / `secret_failed は 500 (本文は固定の文。ログに step client_secret)` / `store_failed は 500 (本文は固定の文。ログに step store)` / `stored は 200 { stored: true }` / `Cache-Control: private, no-store` / `認可コードが応答・ログに出ない` |
| `tests/account-deletion.test.ts` (追記) | `apple_revoke は billing_recheck のあと deleteUser の前に 1 回呼ぶ (呼ぶ順の検査に足す)` / `失効の報告は成功のログの apple に載る` / `既定の実装で秘密鍵が壊れていても退会は ok (段階 apple_revoke で失敗にならず deleteUser まで進む)` / `appleRevocation が無いときの既定の実装は params.admin で表を読む (偽の admin の from が返す行)`。既存の it は `appleRevocation` に偽物 (`{ revokeForAccountDeletion: async () => ({ tokens: 0, revoked: 0, failed: 0, skipped: null }) }`) を渡す共通の引数に足して緑のまま |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` (追記。段 A1。結合テストの枠 `vitest.integration.config.ts`) | `EXPECTED_ACTIONS` に `'apple_sign_in_tokens.user_id': 'CASCADE'` の 1 行 (§8.1 の注つき) を足すだけ。新しい it は足さない: 既存の `D0` (カタログと一覧の両方向の一致) と、一覧から作る `${key} は ON DELETE ${expected}` が新しい行を検査する |
| `tests/apple-sign-in-tokens-migration-contract.test.ts` (新設) | `CREATE TABLE IF NOT EXISTS public.apple_sign_in_tokens (PK (user_id, client_id)・user_id は auth.users ON DELETE CASCADE)` / `ENABLE ROW LEVEL SECURITY と REVOKE ALL FROM PUBLIC, anon, authenticated がある` / `ポリシー・GRANT・UPDATE/INSERT が無い` / `SET LOCAL lock_timeout がある` / `戻し口は DROP TABLE IF EXISTS だけ` / `コメントに記録の無い決定の帰属の語が無い (tests/account-deletion-migration-contract.test.ts の規則 7 と同じ)` |
| `tests/auth-callback-apple-token.test.ts` (新設) | `?provider=apple で code の交換が成功すると storeAppleRefreshTokenFromWebCallback を session と user で呼ぶ` / `provider 無し (Google) では呼んでも skipped で、振り分けは変わらない` / `保管の失敗でも同意画面 / next への redirect は同じ` / `?provider=apple&next=%2Fhome&error=user_cancelled_authorize (error_description 無し) は /login へ redirect し、Location の error は APPLE_WEB_CALLBACK_ERROR_MESSAGE。exchangeCodeForSession と storeAppleRefreshTokenFromWebCallback を呼ばない (S-34)` / `?provider=apple&error=access_denied&error_description=<英文> も同じ固定の文で、Location に英文 (error_description・error の値) を含まない` / `?provider= 無し (Google・メールのリンク) の ?error=access_denied&error_description=<英文> は /login?error=<AUTH_LINK_ERROR_MESSAGE>。英文を Location に含まない (#1917 の続きで改めた)` |
| `tests/apple-sign-in-logo-asset.test.ts` (新設。段 B) | `public/auth/apple-logo-on-black.png が APPLE_LOGO_SRC の置き場にある` / `先頭 8 バイトが PNG の署名 (89 50 4E 47 0D 0A 1A 0A)` / `IHDR の幅と高さが APPLE_SIGN_IN_BUTTON_HEIGHT_PX × APPLE_LOGO_IMAGE_SCALE (168)`。読む位置は名前付きの定数にする (`PNG_SIGNATURE`・`IHDR_WIDTH_OFFSET` = 16・`IHDR_HEIGHT_OFFSET` = 20。PNG の仕様の固定の位置) |
| `src/__tests__/lib/auth/apple-sign-in-flag.test.ts` (新設。段 B) | `isAppleSignInEnabled: NEXT_PUBLIC_APPLE_SIGN_IN が 'on'・'ON'・' on ' なら true、未設定・空・'off' なら false (vi.stubEnv)` / `スイッチの読み方は 1 つ: src/ と apps/mobile/src/ (どちらも __tests__ を除く) で process.env.NEXT_PUBLIC_APPLE_SIGN_IN・process.env.EXPO_PUBLIC_APPLE_SIGN_IN を書いているファイルは src/lib/auth/apple-sign-in-flag.ts と apps/mobile/src/lib/appleSignIn.ts の 2 つだけで、その行はどちらも isAppleSignInFlagOn( の引数になっている (ファイルの文字列を読む走査。コメントを除いた行で数える。src/lib/env.ts の一覧のキー `NEXT_PUBLIC_APPLE_SIGN_IN:` は process.env を伴わないので数えない)` |
| `tests/login-apple-button.test.tsx` (新設) | `NEXT_PUBLIC_APPLE_SIGN_IN=on: 「Appleで続ける」が Google の前にある (login-apple-button)` / `押すと signInWithOAuth({ provider: 'apple', redirectTo: …/auth/callback?provider=apple })` / `?next= は redirectTo の next に入る` / `スイッチ無し: 無い` / `error のとき固定の文のバナー` / `?error= が APPLE_WEB_CALLBACK_ERROR_MESSAGE のとき、バナーの文が APPLE_WEB_CALLBACK_ERROR_MESSAGE と同じ (S-34)` (`next/navigation` の `useSearchParams` のモックは `new URLSearchParams({ error: APPLE_WEB_CALLBACK_ERROR_MESSAGE })` を返す。`useEffect` を動かすため `react-dom/client` の `createRoot` と `act` で描き (このリポジトリには `@testing-library/react` が無い)、描いた DOM の `[role="alert"]` を読む。`renderToStaticMarkup` では `useEffect` が動かない) / `login-google-legal-note は 1 つで文は変わらない (tests/login-google-legal-note.test.tsx も緑)` / `Google のボタンの style の height は APPLE_SIGN_IN_BUTTON_HEIGHT_PX で、Apple のボタンの style の height と同じ (className に py-6・h-14 が無い)` |
| `tests/signup-legal-consent.test.tsx` (追記) | `同意のチェック無し: Apple のボタンも disabled で、押しても signInWithOAuth を呼ばない` / `チェックあり: provider apple で呼ぶ` / `スイッチ無し: Apple のボタン (signup-apple-button) が無く、「Googleで登録」と同意のチェックは今までどおり (S-19)` / `「Googleで登録」のボタンの style の height は APPLE_SIGN_IN_BUTTON_HEIGHT_PX (スイッチ on の Apple のボタンと同じ)` |
| `src/__tests__/lib/env.test.ts` (追記。段 A1) | `Sign in with Apple の 5 つ (公開の NEXT_PUBLIC_APPLE_SIGN_IN・サーバの APPLE_SIGN_IN_TEAM_ID / KEY_ID / PRIVATE_KEY / SERVICES_ID) はどれも任意として一覧にあり、公開の 1 つは PUBLIC_ENV_VARS・サーバの 4 つは SERVER_ENV_VARS にある` (新しい it を 1 つ足すだけ。既存の `publicNames` の it は `Object.keys(publicEnvSchema.shape)` からの導出で、足す一覧は無い) |
| `tests/legal-text-1901.test.ts` (段 D で改める) | T-33 の置き換え (§11.8 (e))・T-7 (evidence の実在)・T-24 (行数)・T-34 (`apple_sign_in_tokens` → アカウント)・T-35 (`LEGAL_CLAIM_COUNT` = 433。段 D の Apple の 2 行と、同じ版に入った cross/21 §7.12 の作者名の表示の 7 行) |

### 14.3 実機 (オーナー・オーケストレーター。§20)

シミュレータは `getCredentialStateAsync` で投げ、名前・メールの初回の挙動も実機と違う。Apple のシートは実機 (TestFlight か内部配布) で確かめる。公開の前の秘密の確認 (§19.3 の「スイッチの前の確認」の 3) も実機で行う (EAS の preview にだけスイッチを入れた内部配布のビルド)。

### 14.4 新しい it を置かないシナリオと、その確かめ方

本書のコードを通らない (既存の経路のまま・Supabase や Apple の側の挙動・運用の工程) ので単体の it を足さないシナリオ。ほかのシナリオ (S-1・S-3・S-7〜S-20・S-23・S-24・S-26・S-27・S-29〜S-34) は §14.1・§14.2 の it が受け持つ (S-34 は `tests/auth-callback-apple-token.test.ts`・`src/__tests__/lib/auth/apple/web-callback.test.ts`・`tests/login-apple-button.test.tsx` の it)。

| # | 新しい it を置かない理由 | 確かめ方 |
|---|---|---|
| S-2・S-4・S-5・S-6 (中継のメール・既存のアカウントとの結び付け) | 新しい利用者にするか既存の利用者に結び付けるか、`auth.users.email` に何を入れるかは GoTrue が決める (F-15)。本書のコードはメールも identity の結び付けも扱わず、設定画面の分岐 (`app_metadata.provider`) も変えない | 設定画面の既存のテストが緑のまま (§17 の `apps/mobile/__tests__/settings/account-credentials.test.tsx`・`src/__tests__/app/settings/account-page.test.ts`。確認だけ)。§20 の 1 (中継のアドレスが設定画面に出る) |
| S-21 (WebView のタブ) | 既存のブリッジ (`/auth/native-bridge`) を変えない (§7.1)。Apple の利用者でもセッションの形は同じ | 既存のテストが緑のまま: `apps/mobile/__tests__/components/WebViewScreen.bridge.test.tsx`・`apps/mobile/__tests__/lib/webViewBridge.test.ts`・`src/__tests__/api/auth/native-bridge-code.test.ts`・`src/__tests__/lib/auth/native-bridge-code.test.ts` (段 A2 の全件) |
| S-22 (中継のアドレスへのメール) | 送信 (`email_outbox` → Resend) を変えない。届くかは送信ドメインの Apple への登録 (§19.1 の 4。オーナーの作業) で決まり、コードで確かめられない | §20 の 8 (中継のアドレスの利用者に退会の完了メールが届く) |
| S-25 (予告と再同意) | 予告は `/admin/announcements` の運用の工程 (§7.3 (d))。施行日の後の再同意は既存の同意のゲートが版の不一致で動く (本書は変えない) | 予告: §20 の 6 (`announcements` の `is_public`・`published_at` を SELECT)。再同意: 既存の `packages/shared/src/legal-versions.test.ts` (古い版なら再同意の対象)・`tests/legal-consent-gate.test.ts` (`resolveLegalConsent`) が緑のまま、段 D の `tests/legal-text-1901.test.ts` の T-17 (2 文書の版がそろう) が緑 |
| S-28 (Web・provider 無効) | `signInWithOAuth` はブラウザを `/auth/v1/authorize` へ送るだけで、400 は Supabase が返す (アプリのコードを通らない。§5.2 S-28) | §19.3 の順 (provider を有効にしてからスイッチを入れる) と §20 の 9 (スイッチを on にした後、「Appleで続ける」が Apple の画面へ行く) |

## 15. 段分けと触るファイル

4 段・4 PR。段ごとに敵対レビュー 2 枚 PASS → マージ。段 A1 → A2 → B は直列 (A2 は A1 の route を、B は A1 の lib を呼ぶ)。段 D は A2 のマージ後 (D が足す委託先の行と主張の表の `evidence` は A2 が新設する `apps/mobile/src/lib/appleSignIn.ts` を指し、`tests/legal-text-1901.test.ts` の T-7 (`existsRepo(evidence.file)` と needle) と T-35 (evidence の道の実在) がそのファイルを求める。A2 の前に D を作ると T-7・T-35 が赤)。B と D は触るファイルが重ならないので、A2 のマージ後はどちらを先にしてもよい。**公開の順** (§7.3 (d)。Q-13 は (a)。§21): 段 D の 2 枚 PASS → 施行日をオーナーに伺って決める (§11.8 (i)) → 施行日より前に運営のお知らせに改定の予告を公開 → 施行日に `effectiveDate` を施行日へ置き換えて段 D をマージ・デプロイ (プライバシーポリシーに Apple が載る。再同意が始まる) → オーナーが §19.3 のサーバの秘密 (iOS と Web の `APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY`。Web を出すならそれと `APPLE_SIGN_IN_SERVICES_ID`) を Vercel の本番に入れて再デプロイ (段 A1・段 B のデプロイの後に入れてあればそのまま) → スイッチの前の確認 (§19.3 の 1〜3。3 は EAS の preview にだけ `EXPO_PUBLIC_APPLE_SIGN_IN=on` を入れた内部配布のビルドで、オーナーが 1 回入る) → Vercel に `NEXT_PUBLIC_APPLE_SIGN_IN=on` (段 B のあと) / EAS の production に `EXPO_PUBLIC_APPLE_SIGN_IN=on` を入れたビルド → 提出。スイッチは、段 D のデプロイ (施行日) より前 (R-16) と、スイッチの前の確認が通る前 (R-8) には on にしない。段 A1・A2・B はスイッチが無ければボタンを出さないので、施行日を待たずにマージしてよい。migration (追加だけ) は、段 A1 のマージで CI (Deploy Supabase Migrations) が本番へ当てる (このリポジトリは本番の DB への直接の DDL をしない)。マージの直後は、Vercel の新しいコードが先に出て表がまだ無い数分の窓がありうるので、段 A1 の実装は、表が無くても (`42P01`・PostgREST の `PGRST205` などの読み取りの失敗) 退会が止まらないことを確かめる (§15 段 A1 の完了条件)。

| 段 | 中身 | 触るファイル (新設は ★) | 完了条件 |
|---|---|---|---|
| A1 サーバ | 表・lib・route・退会の段階・環境変数・レート制限・共有の定数 | ★`supabase/migrations/20261024100000_apple_sign_in_tokens.sql`・★`supabase/rollbacks/20261024100000_apple_sign_in_tokens.down.sql`・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・★`packages/shared/src/apple-sign-in.ts`・`packages/shared/src/index.ts`・★`src/lib/auth/apple/config.ts`・★`client-secret.ts`・★`schemas.ts`・★`rest.ts`・★`tokens.ts`・★`authorization.ts`・★`revocation.ts`・★`src/app/api/auth/apple/authorization/route.ts`・`src/lib/account-deletion.ts`・`src/lib/rate-limit.ts`・`src/lib/env.ts` (Web の 5 つ全部)・`.env.example` (同)・`src/lib/account-export-tables.ts` (除外に `apple_sign_in_tokens`)・テスト (§14.2 の新設 10 本 = `client-secret`・`config`・`schemas`・`rest`・`tokens`・`authorization`・`revocation`・`api/auth/apple-authorization`・`apple-sign-in-tokens-migration-contract`・`packages/shared/src/apple-sign-in.test.ts` + `tests/account-deletion.test.ts`・`src/__tests__/api/null-character-routes.test.ts`・`src/__tests__/lib/env.test.ts` (it 1 つ)・`tests/legal-text-1901.test.ts` の T-34 の表・`tests/account-export-tables.test.ts`・`tests/ai-consent-provider-inventory.test.ts` (`NON_AI_HOSTS` に 1 行)・`tests/integration/security/auth-users-fk-on-delete.test.ts` (`EXPECTED_ACTIONS` に 1 行)・`tests/helpers/ai-consent-enforced-paths.ts` (`EXEMPT_ROUTES` に authorization の route の行)・★`tests/no-literal-private-key.test.ts`)・`.gitleaks.toml` (注に `.gitleaksignore` の道)・★`.gitleaksignore`・`ENV_SETUP.md` (段 A1 #1989 が触った) | 全件緑。結合テストの枠で `auth-users-fk-on-delete` が緑 (D0)。`tests/database-types-migrations-contract` が表を見つける。route が null-character の表にある。`tests/api-error-japanese-scan` が緑 (`src/app/api/auth` は直し終えた配下で違反 0 件)。`tests/ai-consent-provider-inventory` が緑 (`appleid.apple.com` が `NON_AI_HOSTS` にある)。`apple_sign_in_tokens` がまだ無い (`42P01`・`PGRST205` などの読み取りの失敗) ときも、退会の段階 `apple_revoke` が退会を止めないこと (単体テストで確かめる。§15 の冒頭のマージ直後の窓)。変更が 15 ファイルを超えるので、レビューは「lib + route」「退会 + migration」「環境変数 + 共有 + テスト」の分割パネル + 横断 1 枚 |
| A2 モバイル | iOS のボタンと流れ・振り分けの共有化・依存・`app.json` | `apps/mobile/package.json`・`package-lock.json`・`apps/mobile/app.json`・`apps/mobile/env.example`・★`apps/mobile/src/lib/appleSignIn.ts`・★`apps/mobile/src/lib/routeAfterSignIn.ts`・★`apps/mobile/src/components/auth/AppleSignInButton.tsx`・`apps/mobile/app/(auth)/login.tsx`・`apps/mobile/app/(auth)/signup.tsx`・`apps/mobile/app/onboarding/_layout.tsx` (注だけ。§18.1)・テスト (§14.1。既存の `apps/mobile/__tests__/auth/turnstile-screens.test.tsx` に §14.1 のモック) | `npx jest` 全件緑 (テスト用の機械)。`tests/mobile-toolchain-contract` が lock の巻き上げを認める。`expo install --check` が typescript 以外のずれを出さない |
| B Web | Web のボタンとコールバック (環境変数の一覧には触らない。A1 で足してある) | ★`src/lib/auth/apple-sign-in-flag.ts`・★`src/components/auth/AppleSignInButton.tsx`・★`public/auth/apple-logo-on-black.png` (§11.6 のコマンドで取る)・★`src/lib/auth/apple/web-callback.ts`・`src/app/(auth)/login/page.tsx`・`src/app/(auth)/signup/page.tsx`・`src/app/(auth)/auth/callback/route.ts`・`lib/legal-consent.ts` (注だけ。§18.1)・テスト (§14.2 の新設 5 本 = `web-callback`・`apple-sign-in-flag`・`auth-callback-apple-token`・`login-apple-button`・`apple-sign-in-logo-asset` + 追記 `signup-legal-consent`) | 全件緑。`tests/login-google-legal-note`・`tests/auth-callback-legal-consent`・`tests/auth-turnstile-pages`・`tests/auth-link-notice` (Google の `?error=` は今までどおり) が緑のまま |
| D 法務 (A2 のマージ後。マージ・デプロイは施行日 = §11.8 (i) で決めた日) | 委託先・第3条・第10条・主張の表・版・控え | `src/lib/legal/privacy-text.ts`・`tests/legal-claims-1901.ts`・`tests/legal-text-1901.test.ts`・`packages/shared/src/legal-versions.ts`・★`docs/legal/archive/v2026.3/terms.md`・★`privacy.md`・(版の直書きのあるテストは origin/main に無い。段 D で `git grep -F v2026.3` を流し直し、増えていれば直す。§17) | `tests/legal-text-1901` 全件緑 (T-35 の 1 対 1・字数)。`docs/legal/archive/v2026.3/` がある |

## 16. 新設一覧

載せ方: 名前の行は export するもの (関数・定数・型・route の export) を載せる。モジュールの中だけのもの (export しない関数・定数) は §11 の正典コードが正で、ここには §5.2 のトレースが名指す関数だけを「(内部)」として載せる (ほかの内部の定数・関数 (`pemOf`・`base64url`・`postForm`・`appleErrorOf`・`fullNameOf`・`HTTP_*`・`MS_PER_SECOND` など) は §11・§13.1 を見る)。

| 種類 | 名前 | 場所 | 段 |
|---|---|---|---|
| 表 | `public.apple_sign_in_tokens` (列 `user_id`・`client_id`・`refresh_token`・`created_at`・`updated_at`。PK `(user_id, client_id)`) | migration (§8.1) | A1 |
| migration と戻し口 | `20261024100000_apple_sign_in_tokens.sql` と対の `20261024100000_apple_sign_in_tokens.down.sql` (`DROP TABLE IF EXISTS` だけ) | `supabase/migrations/`・`supabase/rollbacks/` (§8.1・§15) | A1 |
| route | `POST /api/auth/apple/authorization` | `src/app/api/auth/apple/authorization/route.ts` | A1 |
| エラーコード | `APPLE_AUTHORIZATION_CODE_INVALID` (400)・`APPLE_IDENTITY_NOT_LINKED` (409) | route | A1 |
| 退会の段階 | `apple_revoke` (`AccountDeletionStep`) | `src/lib/account-deletion.ts` | A1 |
| 差し替え口 | `DeleteAccountParams.appleRevocation` (`AccountDeletionAppleRevocation`) | 同上・`src/lib/auth/apple/revocation.ts` | A1 |
| レート制限の種類 | `'auth-apple-authorization'` | `src/lib/rate-limit.ts` | A1 |
| 関数 (サーバ) | `createAppleClientSecret`・`exchangeAppleAuthorizationCode`・`revokeAppleRefreshToken`・`storeAppleRefreshToken`・`listAppleRefreshTokens`・`registerAppleAuthorization`・`hasAppleIdentity`・`createAccountDeletionAppleRevocation`・`readAppleSignInServerConfig`・`storeAppleRefreshTokenFromWebCallback`・`appleCallbackErrorMessage` (この 2 つは段 B) | `src/lib/auth/apple/*.ts` | A1 / B |
| 定数 (サーバ) | `APPLE_SIGN_IN_NATIVE_CLIENT_ID`・`APPLE_TOKEN_ENDPOINT`・`APPLE_REVOKE_ENDPOINT`・`APPLE_CLIENT_SECRET_AUDIENCE`・`APPLE_CLIENT_SECRET_TTL_SECONDS`・`APPLE_API_TIMEOUT_MS`・`APPLE_REVOKE_ATTEMPTS`・`APPLE_REVOKE_TOTAL_BUDGET_MS`・`APPLE_CALLBACK_PROVIDER`・`APPLE_WEB_CALLBACK_ERROR_MESSAGE` (この 2 つは段 B) | `config.ts`・`web-callback.ts` | A1 / B |
| Zod | `AppleAuthorizationBodySchema`・`AppleTokenResponseSchema`・`AppleErrorResponseSchema`・`AppleAuthorizationResponseSchema` | `src/lib/auth/apple/schemas.ts` | A1 |
| 共有 | `APPLE_SIGN_IN_FLAG_ON`・`isAppleSignInFlagOn`・`APPLE_AUTHORIZATION_CODE_MAX_LENGTH`・`APPLE_SIGN_IN_MESSAGES` | `packages/shared/src/apple-sign-in.ts` | A1 |
| 環境変数 | `NEXT_PUBLIC_APPLE_SIGN_IN`・`APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY`・`APPLE_SIGN_IN_SERVICES_ID` (5 つとも A1) / `EXPO_PUBLIC_APPLE_SIGN_IN` (A2) | `src/lib/env.ts`・`.env.example` / `apps/mobile/env.example` | A1 / A2 |
| 関数 (モバイル) | `isAppleSignInEnabled`・`isAppleSignInAvailable`・`signInWithApple`・`routeAfterSignIn` (移動)・(内部) `saveAppleFullName`・`registerAppleAuthorization` (`appleSignIn.ts` の中だけ。サーバの同名の関数とは別)・(内部) `onAppleLogin` (`login.tsx`)・`onAppleSignup` (`signup.tsx`) | `apps/mobile/src/lib/appleSignIn.ts`・`routeAfterSignIn.ts`・`apps/mobile/app/(auth)/login.tsx`・`signup.tsx` | A2 |
| 定数 (モバイル) | `APPLE_AUTHORIZATION_API_PATH` (`/api/auth/apple/authorization`) | `apps/mobile/src/lib/appleSignIn.ts` | A2 |
| 部品 (モバイル) | `AppleSignInButton`・`AUTH_PROVIDER_BUTTON_MIN_HEIGHT`・`useAuthProviderButtonHeight`・testID `login-apple-button`・`signup-apple-button` | `apps/mobile/src/components/auth/AppleSignInButton.tsx` | A2 |
| 依存 (モバイル) | `expo-apple-authentication ~58.0.2`・`expo-crypto ~58.0.7` | `apps/mobile/package.json` | A2 |
| 設定 (モバイル) | `ios.usesAppleSignIn`・`ios.infoPlist.CFBundleAllowMixedLocalizations` | `apps/mobile/app.json` | A2 |
| 関数・部品 (Web) | `isAppleSignInEnabled`・`AppleSignInButton`・`APPLE_SIGN_IN_TITLES`・`APPLE_SIGN_IN_BUTTON_HEIGHT_PX`・`APPLE_SIGN_IN_BUTTON_FONT_PX`・`APPLE_LOGO_SRC`・`APPLE_LOGO_IMAGE_SCALE`・testID `login-apple-button`・`signup-apple-button` | `src/lib/auth/apple-sign-in-flag.ts`・`src/components/auth/AppleSignInButton.tsx` | B |
| 関数 (Web。内部) | `handleAppleLogin` (`login/page.tsx`)・`handleAppleSignup` (`signup/page.tsx`) | `src/app/(auth)/login/page.tsx`・`signup/page.tsx` | B |
| 型 (export) | `AppleSignInServerConfig` (`config.ts`)・`AppleClientSecretInput` (`client-secret.ts`)・`AppleAuthorizationBody`・`AppleAuthorizationResponse` (`schemas.ts`)・`FetchLike`・`AppleTokenExchangeResult`・`AppleRevokeResult` (`rest.ts`)・`AppleTokenStore`・`AppleRefreshTokenRow` (`tokens.ts`)・`RegisterAppleAuthorizationResult` (`authorization.ts`)・`AppleRevocationReport`・`AppleRevocationLogger`・`AccountDeletionAppleRevocation` (`revocation.ts`) / `WebCallbackLogger` (`web-callback.ts`) / `AppleSignInOutcome` (`apps/mobile/src/lib/appleSignIn.ts`)・`AppleSignInButtonKind` (`apps/mobile/src/components/auth/AppleSignInButton.tsx`)。既存の型 `AccountDeletionStep` (`src/lib/account-deletion.ts`) には値 `apple_revoke` を足す (上の「退会の段階」の行) | `src/lib/auth/apple/*.ts` / `apps/mobile/src/` | A1 / B / A2 |
| route の export | `runtime = 'nodejs'`・`dynamic = 'force-dynamic'`・`POST` (`maxDuration` は置かない) | `src/app/api/auth/apple/authorization/route.ts` | A1 |
| 静的ファイル | `public/auth/apple-logo-on-black.png` (Apple が配るロゴだけのボタンの画像。168×168。§11.6) | `public/auth/` | B |
| 法務 | `PRIVACY_PROCESSORS` の Apple の行・第3条と第10条の文・主張の表 2 行・版 `v2026.4`・`docs/legal/archive/v2026.3/` | §11.8 | D |
| テスト | §14 の新設 (モバイル 3 本 (A2)・サーバ 15 本 (A1 が 10 本・B が 5 本)) | — | A1 / A2 / B |

## 17. 既存の番兵 (契約テスト・走査テスト) の追随表

本設計が足す・変えるものの名前を grep の語にして、反応する既存の番兵を列挙した (origin/main `9575aa99` の `tests/`・`src/__tests__/`・`apps/mobile/__tests__/`)。v1.11 で、ディレクトリを歩いてソース・テスト・migration の文字列や書き方を数える番兵 (`readdirSync` などで走査するテスト) を origin/main `40105bee` で洗い直し、本書が足すもの (コードの `https://` の文字列・route・route のテスト・migration) を走査の対象に入れる番兵の行を足した (`ai-consent-provider-inventory`・`heavy-unit-test-timeout`・`migration-file-version-integrity`・`admin-mutation-audit-coverage-1571`・`next15-async-request-api-scan`・`business-info-legal-pages`)。

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/env-source-scan.test.ts` (規則 4・6) | `NEXT_PUBLIC_APPLE_SIGN_IN`・`APPLE_SIGN_IN_` | 一覧に無い変数を読む・`.env.example` に無い | `src/lib/env.ts` の一覧と `.env.example` に 5 つを足す (§11.7)。段 B が公開の 1 つを読むときには一覧に載っている | A1 (5 つ全部) |
| `src/__tests__/lib/env.test.ts:361-373` (`publicNames` / `serverNames`) | `publicEnvSchema.shape` | 名前はスキーマからの導出 (`Object.keys(publicEnvSchema.shape)`) で、足す一覧は無い。5 つの名前の形 (公開は `NEXT_PUBLIC_*`・サーバは含まない・重複なし) を満たすので反応しない | 足すのは §14.2 の新しい it 1 つだけ (§11.7) | A1 |
| `tests/check-env-script.test.ts` | `check-env` | 一覧の増減で出力が変わる可能性 | 赤になったら期待値を実数に合わせる (緩めない) | A1 |
| `apps/mobile/__tests__/lib/env-example.test.ts` | `process.env.EXPO_PUBLIC_` | ソースが読む `EXPO_PUBLIC_APPLE_SIGN_IN` が `env.example` に無い | `apps/mobile/env.example` に足す (§11.5) | A2 |
| `apps/mobile/__tests__/lib/env.test.ts` | `process.env[` | 名前を変数にした読み取り | `process.env.EXPO_PUBLIC_APPLE_SIGN_IN` と直接書く (§11.5) | A2 |
| `tests/mobile-toolchain-contract.test.ts` (1・3b・6・7) | `expo-apple-authentication`・`expo-crypto`・`MOBILE_NESTED_ALLOWED` | 新しい依存の版と lock の置き場 | 版は `~58.0.2`・`~58.0.7` (SDK 58 の表)。lock はテスト用の機械で作り直し、2 つがルートに巻き上がることを `git diff -- package-lock.json` の `packages` のキーで数える | A2 |
| `tests/mobile-easignore-bundle-inputs.test.ts` | `.easignore` | 新しい import が `.easignore` で落ちないか | 足す import は node_modules と `apps/mobile/src` の中だけなので反応しない (確認だけ) | A2 |
| `tests/maestro-flow-testids.test.ts` | `login-google-button` | flow が使う testID の実在 | 既存の flow は Apple の testID を使わないので反応しない (確認だけ) | A2 |
| `src/__tests__/api/null-character-routes.test.ts` (`ENTRIES`) | `rejectNullCharacterBody` | 本文を読む route が表に無い | `{ file: 'auth/apple/authorization/route.ts', method: 'POST', load: … }` を足す | A1 |
| `tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts` | `.message` | 応答・結果に生のエラー文 | route・lib は固定の文だけを本文・結果に入れる (§11.3・§11.4 の形のまま)。`error_description` を結果に入れない | A1 |
| `tests/api-error-japanese-scan.test.ts` (origin/main `c5e57b0d` の #1979。範囲は `tests/helpers/api-error-japanese-scope.ts`・走査は `tests/helpers/api-error-text-scan.ts`) の「番兵: 一覧の外の配下の違反の件数は基線と同じ」 | `NextResponse.json`・`UNFIXED_VIOLATION_BASELINE`・`src/app/api/auth` | `src/app/api` の全部の `route.ts` の `NextResponse.json` の本文の `error` / `message` の文 (同じファイルの定数と import 元の定数をたどる) を読み、英語だけの文と `X.message` を、`src/app/api/<最初の区切り>` ごとに数えて基線と比べる。新設の `src/app/api/auth/apple/authorization/route.ts` は直し終えた配下 `src/app/api/auth` (`tests/helpers/api-error-japanese-scope.ts` の `JAPANESE_ERROR_API_DIRS`) に入っており、違反 0 件を見張られる (基線 `UNFIXED_VIOLATION_BASELINE` は空) | 新設の route は本文を `NextResponse.json` に直接書き、`error` の文はどれも日本語の定数 (`VALIDATION_MESSAGE`・`NOT_LINKED_MESSAGE`・`CODE_INVALID_MESSAGE`。§11.4) なので違反は 0 件。反応しない (確認だけ)。英語の文を足すと赤になる (見張りが新設の route にも効く形。R-18)。401 / 403 / 429 / 500 は既存の関数 (`sessionsFailure`・`rateLimitExceededResponse`・`internalError`) の本文で、この route では数えない。`/auth/callback` (`src/app/(auth)/`) は `src/app/api` の外なので走査されない | A1 |
| `tests/ai-consent-provider-inventory.test.ts` の「すべての送信先は、同意を取る AI 事業者か、AI 事業者ではない理由つきの送信先のどれか」 | `https://`・`appleid.apple.com`・`NON_AI_HOSTS` | `src`・`supabase/functions`・`shared`・`lib`・`packages`・`apps/mobile/app`・`apps/mobile/src` のコード (テストとコメントを除く) の `https://<ホスト>` の文字列を全部集め、`AI_HOSTS`・`NON_AI_HOSTS`・コンビニの公開サイト・テスト用のホストのどれにも無いホストがあると赤 (失敗の文は「AI 事業者なら AI_HOSTS と AI_CONSENT_PROVIDERS に、そうでなければ理由つきで NON_AI_HOSTS に載せること」)。段 A1 の `src/lib/auth/apple/config.ts` (`APPLE_TOKEN_ENDPOINT`・`APPLE_REVOKE_ENDPOINT`・`APPLE_CLIENT_SECRET_AUDIENCE`) と `client-secret.ts` (`CLIENT_SECRET_AUDIENCE`) の `https://appleid.apple.com` が新しいホストになる (`NON_AI_HOSTS` にある Apple のホストは `apps.apple.com` だけ)。段 B の Web のボタンのロゴの URL (`https://appleid.cdn-apple.com/…`) は `AppleSignInButton.tsx` の JSDoc の中 (§11.6) で、走査はコメントを消してから読むので数えない。モバイルは `getApi()` で自社の Web を呼ぶだけで、新しいホストを書かない | `NON_AI_HOSTS` に 1 行足す: `'appleid.apple.com': 'Sign in with Apple の認可コードの交換 (/auth/token) と、退会のときの refresh token の失効 (/auth/revoke)。client_secret の aud にも同じホストを書く (docs/design/mobile/08-sign-in-with-apple.md §11.2)。送るのは認可コード・refresh token・client_id・client_secret だけで、AI の送信先ではない'`。AI の送信先ではないので `AI_HOSTS`・`AI_CONSENT_PROVIDERS`・`AI_CONSENT_VERSION` は変えない (既存の `exp.host`・`api.revenuecat.com`・`schema.org` を足したときと同じ形)。Apple の委託先としての開示は段 D のプライバシーポリシー (§11.8) が受け持つ。ロゴの URL をコメントの外 (文字列) に書くなら `appleid.cdn-apple.com` の行も要る (本書の正典コードは書かない) | A1 |
| `tests/heavy-unit-test-timeout.test.ts` の「同じ型のファイル」の検査 (`SAME_TYPE_SCAN_ROOTS` = `tests`・`src`・`lib`・`packages`。`tests/e2e/`・`tests/integration/` を除く) | `import(`・`/route` | it・フックの中 (字下げした行) で route の本体を `import('…/route')` で読み込むテストのファイルは「同じ型」で、ファイルの時間切れを延ばす (`applyHeavyUnitTestTimeout()`・`vi.setConfig`) か、読み込むフック・テストに個別の時間切れを渡すか、理由つきの例外の一覧に載せないと赤。ファイルの一番外側の読み込み (静的な `import` か、字下げの無い `await import`) は収集のときに読むので対象外 | 新設の route のテスト 2 本 (`src/__tests__/api/auth/apple-authorization.test.ts`・`tests/auth-callback-apple-token.test.ts`) は route をファイルの一番外側で読み込む: 静的な `import { POST } from '@/app/api/auth/apple/authorization/route'` (`vi.mock` は巻き上げられて先に効く。既存の `src/__tests__/api/account/delete-missing-env.test.ts:93`・`tests/api/auth-login-context.test.ts:64-65` と同じ形) か、字下げの無い `const { GET } = await import('@/app/(auth)/auth/callback/route')` (既存の `tests/auth-callback-legal-consent.test.ts:66`・`tests/auth-link-notice.test.tsx:69` と同じ形)。サーバの設定は呼ぶたびに読む (`readAppleSignInServerConfig`。§11.2) ので、環境変数を変える it (`vi.stubEnv`) も route を読み込み直さなくてよい | A1 / B |
| `tests/migration-file-version-integrity.test.ts` (#1636) | `-- migration:`・`-- rollback:`・`supabase/rollbacks/` | 全部の migration で、ファイル名 (14 桁の版)・1 行目の `-- migration: <名前>` (自分のファイル名と一致)・本文が案内する `supabase/rollbacks/<名前>` の実在・戻し口の 1 行目の `-- rollback: <名前>` (対の migration と一致) を突き合わせる | 番号は `20261024100000` に確定した (§8.1)。5 か所が同じ番号: migration のファイル名・その 1 行目 (`-- migration: 20261024100000_apple_sign_in_tokens.sql`)・2 行目の戻し方の案内 (`supabase/rollbacks/20261024100000_apple_sign_in_tokens.down.sql`)・戻し口のファイル名・その 1 行目 (`-- rollback: 20261024100000_apple_sign_in_tokens.sql`)。§8.1 の SQL の見出しもこの番号で書いてある | A1 |
| `tests/admin-mutation-audit-coverage-1571.test.ts` (origin/main `40105bee` の #1980 で、`src/app/api` の 4 つのディレクトリ (`admin`・`super-admin`・`support`・`operator`) の外の route も走査に入った) | `requireRole`・`requireSuperAdmin`・`recordAdminAudit` | 4 つのディレクトリの外の route は、変更系の handler (POST など) が運営ロールの確認 (`requireRole` / `requireSuperAdmin`。同じファイルの関数の中も) に届くものだけを表 `EXPECTED` と突き合わせる | 新設の `POST /api/auth/apple/authorization` は `requireSessionUser` だけを呼び、運営ロールの確認に届かないので表に入らない。運営の操作ではないので `recordAdminAudit` も呼ばない。反応しない (確認だけ) | A1 |
| `tests/next15-async-request-api-scan.test.ts` (#1444・#1621) | `createClient`・`params` | 本番コード (`src`・`lib`・`components`・`shared`) の `'@/lib/supabase/server'` の `createClient()` は `await` の直下・route の handler の第 2 引数の `params` は `Promise<…>` の型 | 新設の route は `const supabase = await createClient();` (§11.4) で、handler は `POST(request)` (第 2 引数なし)。段 B の `/auth/callback` の差分は `createClient` の呼び方を変えない。`src/lib/auth/apple/*.ts` は `getSupabaseAdmin()` だけを使う。反応しない (確認だけ) | A1 / B |
| `tests/business-info-legal-pages.test.ts` (#1366 の「プライバシーポリシーの AI の送信先の一覧」) | `privacy-ai-providers`・`AI_CONSENT_PROVIDERS` | プライバシーポリシーの画面を描き、AI の送信先の一覧 (`data-testid="privacy-ai-providers"`。`src/components/legal/LegalDocumentBody.tsx`) が同意を取る事業者と同じ数・同じ順 | 段 D が足す Apple は委託先 (`PRIVACY_PROCESSORS`)・第3条・第10条で、AI の送信先の一覧には足さない (Apple は AI の事業者ではない。上の `ai-consent-provider-inventory` の行と同じ扱い)。反応しない (確認だけ) | D |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient` | service_role の client を自前で作る | `getSupabaseAdmin()` だけを使う (§11.4・§11.6) | A1 / B |
| `tests/role-check-source-scan.test.ts` | `roles` | 手書きのロール判定 | 無い (認証は `requireSessionUser`) | A1 |
| `tests/database-types-migrations-contract.test.ts` | `CREATE TABLE` | 表が型ファイル 2 本に無い | `database.types.ts` を作り直す (§8.1) | A1 |
| `tests/db-privilege-hardening-migration-contract.test.ts` (3・5) | `TRUNCATE`・`GRANT` | 後の migration が利用者へ TRUNCATE / GRANT を付ける | migration は `REVOKE ALL` だけ・戻し口は `DROP TABLE` だけ (§8.1) | A1 |
| `tests/account-export-tables.test.ts` | `ACCOUNT_EXPORT_EXCLUDED`・`auth.users` | 利用者に紐づく表が書き出しの一覧にも除外にも無い | `src/lib/account-export-tables.ts` の除外に `apple_sign_in_tokens` を理由つきで足す (本人に返す意味が無く、失効に使える値を外へ出さない) | A1 |
| `tests/legal-text-1901.test.ts` T-34 (`PRIVACY_DATA_TABLES`) | `PRIVACY_DATA_TABLES` | 利用者に紐づく表が第3条の行にも除外にも無い | `apple_sign_in_tokens` → `'アカウント'` を足す | A1 |
| `tests/legal-text-1901.test.ts` T-33 | `not.toContain('Apple')` | `PRIVACY_PROCESSORS` に Apple が載る | §11.8 (e) の置き換え | D |
| `tests/legal-text-1901.test.ts` T-7・T-24・T-35 | `PRIVACY_PROCESSORS`・`LEGAL_CLAIM_COUNT` | evidence の実在・行数・主張の表の 1 対 1 と字数 | §11.8 (a)〜(d) | D |
| `tests/legal-claims-1901.ts` | `privacy-7#`・`privacy-10#`・`privacy-3#3` | 主張の表 | §11.8 (d) | D |
| 版の直書き (テストが `v2026.3` を書いていないか) | `v2026.3` | origin/main の `src/`・`tests/`・`apps/`・`packages/`・`scripts/` を `git grep -F v2026.3` すると、当たるのは `packages/shared/src/legal-versions.ts` (`LEGAL_DOCUMENTS` の 2 行 `:59-60` と注) だけで、テストに版の直書きは無い。テストは `LEGAL_DOCUMENTS` から版を読むので、段 D で版を上げても反応しない | 確認だけ。段 D の実装で同じ `git grep` を流し直し、当たるテストが増えていれば `v2026.4` に直す (緩めない) | D |
| `tests/account-deletion.test.ts` | `billing_recheck`・`deleteUser` | 呼ぶ順の検査に段階が増える。既定の実装が偽の `admin.from` を呼ぶ | §14.2 の追記。既存の it は `appleRevocation` の偽物を共通の引数に足す | A1 |
| `tests/account-delete-route.test.ts` | `deleteAccount` | route は変えないので反応しない (確認だけ) | — | A1 |
| `tests/account-deletion-email.test.ts` (`:38` の billing のモジュールの差し替え・`:202-212` の `run()`・`:242` の呼ぶ順) | `billing_recheck`・`deleteAccount(` | `run()` と route 経由の it は `appleRevocation` を渡さないので、既定の実装が偽の `makeAdmin` の `from('apple_sign_in_tokens')` を読む。偽物の `builder` は `select`・`eq` を自分に返し、`then` で `{ data: [], error: null }` を返す (`:114-123`) → 0 行で失効を呼ばず warn も出さない。`world.calls` に `from:apple_sign_in_tokens` が 1 つ増えるが、この冊の検査は位置の比較 (`at(…)`) だけで、並び全体の `toEqual` は無い | 反応しない (確認だけ) | A1 |
| `src/__tests__/api/account/delete-missing-env.test.ts` (`:80` の billing の差し替え・`:234-239` の `mockCreateAdminClient` 1 回と billing → billing_recheck の順・`:259` の warn 無し) | `billing_recheck`・`mockLoggerWarn` | route 経由で既定の実装が動く。既定の実装は `deleteAccount` に渡された同じ `admin` を使う (`createAccountDeletionAppleRevocation({ admin: () => admin })` §11.4) ので `mockCreateAdminClient` は 1 回のまま。`mockAdminFrom` の `emptyQuery()` (`:114-121`) は `select`・`eq` を自分に返し `then` で `{ data: [], error: null }` → 0 行で warn を出さない。`mockCancelForAccountDeletion` は `apple_revoke` から呼ばれないので順も 2 回のまま | 反応しない (確認だけ) | A1 |
| `tests/billing-account-deletion.test.ts` | `billing_recheck` | billing のモジュール (`src/lib/billing/account-deletion.ts`) の単体で、`deleteAccount` を呼ばない | 反応しない (確認だけ) | A1 |
| `tests/integration/security/account-deletion.test.ts`・`account-deletion-owner-guard.test.ts`・`self-dissolve.test.ts` | `deleteAccount(` | 本物の service_role の client で `deleteAccount` を `appleRevocation` 無しで呼ぶ。既定の実装がローカルの DB の `apple_sign_in_tokens` (段 A1 の migration で作られる・0 行) を読み、失効を呼ばない。表を読めなくても警告だけで続ける (§11.4)。結果 (`ok`・段階・CASCADE) は変わらない | 反応しない (確認だけ。結合テストの枠で緑を確かめる) | A1 |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` D0 (`:318-333`)・`${key} は ON DELETE ${expected}` (`:344-352`) | `EXPECTED_ACTIONS`・`REFERENCES auth.users` | DB のカタログの auth.users を指す外部キーの「表.列」の集合と `EXPECTED_ACTIONS` のキーの集合を両方向で突き合わせる。新しい `apple_sign_in_tokens.user_id` が一覧に無いと `notListed` で赤 | `EXPECTED_ACTIONS` に `'apple_sign_in_tokens.user_id': 'CASCADE'` を注つきで足す (§8.1・§14.2)。同じ冊の E (退会で消える表を指す NO ACTION / RESTRICT) は、新しい表を指す外部キーが無いので反応しない。H (列名に `mail` を含む列) は新しい表の列に無いので反応しない (確認だけ) | A1 |
| `tests/integration/security/db-privilege-hardening.test.ts` T-1 (`:315-327`) | `TRUNCATE` | public の全部の表で anon / authenticated に TRUNCATE が無いこと | migration が `REVOKE ALL ... FROM PUBLIC, anon, authenticated` を流すので反応しない (確認だけ。結合テストの枠) | A1 |
| `tests/integration/security/select-columns-exist.test.ts` | `.from('apple_sign_in_tokens')`・`.select('client_id, refresh_token')` | `src/` の select の列がローカルの DB のカタログにあること | 段 A1 の migration が列 `client_id`・`refresh_token` を作るので反応しない (確認だけ。結合テストの枠) | A1 |
| `tests/auth-callback-legal-consent.test.ts` | `exchangeCodeForSession` | コールバックの既存の分岐 | `provider` 無しでは保管を呼んでも `skipped` で、redirect は同じ (§11.6)。モックの `data` に `session` が無くても `?.` で通る | B |
| `tests/login-google-legal-note.test.tsx` | `login-google-legal-note`・`Googleで続ける` | 案内の testID と文・Google のボタンの存在 | どちらも変えない (§10.2) | B |
| `tests/signup-legal-consent.test.tsx` | `signInWithOAuth` | 同意前にボタンを押せない | Apple のボタンも同じ条件 (§14.2 の追記) | B |
| `tests/auth-turnstile-pages.test.tsx`・`src/__tests__/app/login-native-notify.test.tsx` | `createClient` のモック | 画面の描画 | モックの `auth` に `signInWithOAuth` があるので反応しない (確認だけ) | B |
| `tests/signup-minor-notice.test.tsx` (`:29` の `createClient` のモック) | `signInWithOAuth` | 新規登録の画面の描画 | モックの `auth` に `signInWithOAuth` があり、スイッチ (`NEXT_PUBLIC_APPLE_SIGN_IN`) 無しで Apple のボタンは出ないので反応しない (確認だけ) | B |
| `tests/auth/web-login-context-source-scan.test.ts` | `exchangeCodeForSession`・`recordWebLoginContextFromRequest` | `src/app` の route.ts ごとに、セッションを作る呼び出しの数 ≤ 文脈の記録の呼び出しの数 | 段 B は `/auth/callback` にセッションを作る呼び出しを足さない (保管は既存の交換の後 §11.6)。新設の route `POST /api/auth/apple/authorization` もセッションを作らない。反応しない (確認だけ) | A1 / B |
| `apps/mobile/__tests__/auth/turnstile-screens.test.tsx` (`:38` の `signInWithOAuth` のモック・`:101-102` で `login.tsx`・`signup.tsx` を読む) | `signInWithOAuth`・`app/(auth)/login` | 画面が `appleSignIn.ts`・`AppleSignInButton.tsx` を読み、`expo-apple-authentication`・`expo-crypto` を読み込む (`BUTTON_TYPE` は読み込みのときに列挙を読む) | §14.1 の正典のモックを足す (期待値は変えない)。スイッチ (`EXPO_PUBLIC_APPLE_SIGN_IN`) 無しなので Apple のボタンは描かれず、Turnstile の検査は同じ | A2 |
| `apps/mobile/__tests__/settings/account-credentials.test.tsx` (`:67` の `provider: 'email'`・`:105` の `provider: 'google'`) | `app_metadata`・`provider` | 設定画面のアカウント (モバイル) が `app_metadata.provider` で分ける | 本書は設定画面を変えない (§7.2・§10.3)。Apple で結び付いた利用者の `provider` は最初の provider のまま (F-15)、Apple だけの利用者は `apple` で既存の `providerLabel` の分岐に入るので反応しない (確認だけ) | A2 |
| `src/__tests__/app/settings/account-page.test.ts` (`:80`・`:83` の `provider`・`:298-307` の `apple` の案内) | `app_metadata`・`provider` | 設定画面のアカウント (Web) が `app_metadata.provider` で分ける。`apple` の利用者に「Appleアカウントでログインしています」を出す it が既にある | 同上 (確認だけ) | B |
| `tests/e2e/legal-consent-gate.spec.ts:256-263` | `Googleで登録` | 同意前の Google のボタン | e2e の環境はスイッチ無しなので Apple のボタンは出ない (確認だけ。Q-8) | B |
| `tests/design-doc-version-header-matches-history.test.ts`・`tests/docs-table-column-count.test.ts` | `\| 版 \|`・表の `\|` | 本書の表紙と表 | 本書が満たす (表紙の版と改定履歴の最後の版が同じ・列の数) | 設計 |
| `tests/design-doc-auth-call-closure-count.test.ts` | `全 317 呼び出し` | 05 §9.1 の閉包の数 (記録) の内部の整合だけ | 本書は 05 を変えない。auth の呼び出しが増える事実は §18 の 05 の行で扱う | — |
| `tests/design-doc-removed-mobile-screens.test.ts`・`tests/mobile-removed-files-references.test.ts` | `apps/mobile/app/` | 消した画面の名指し | 本書が名指しする画面 (`(auth)/login.tsx`・`signup.tsx`・`settings/account.tsx`) は現存 | 設計 |
| `tests/no-committed-credentials.test.ts` | `PRIVATE_KEY` | `.env.example` に値 | 値を空にする | A1 |
| gitleaks (`.github/workflows/security.yml` の gitleaks ジョブ・`scripts/local-ci.sh` の secrets 段) と ★`tests/no-literal-private-key.test.ts` | `PRIVATE KEY` | PR で増えたコミットと、`src`・`tests`・`packages`・`apps`・`scripts`・`supabase`・`docs` の文字のファイルと `.env.example` の秘密鍵の形 (BEGIN … PRIVATE KEY のヘッダの行から 64 文字以上あとの、最初の `KEY` にダッシュ 5 つが続く所までを 1 つの鍵として拾う。テストのダミーの PEM も拾う) | テストのダミーの PEM はヘッダの文字列を分けて組み立てる。本書は §11.2 の注 (`AppleSignInServerConfig.privateKeyPem`) に PEM のヘッダを書いているので、それより後ろで `KEY` にダッシュ 5 つを続けて書かない (そこまでが 1 つの鍵として拾われて赤になる)。push 済みのコミットの差分にだけ残った誤検知の 1 件は ★`.gitleaksignore` にコミットの完全な SHA 付きの指紋で足す (`.gitleaks.toml` の注にその道を書く。段 A1 #1989) | A1 |
| `tests/no-pending-wording-1911.test.ts` | `準備中` | 画面の文 | 新しい文に未完成・予定の語を使わない (§11.1・§12) | A1 / A2 / B |
| `apps/mobile/__tests__/auth/login.test.tsx` (`:30-42` の `../../src/lib/supabase` のモック・`:81-89` の `../../src/theme` のモック) | `app/(auth)/login`・`signInWithOAuth` | 画面を描く。段 A2 の後の `login.tsx` は `AppleSignInButton.tsx` (`radius` を読む)・`appleSignIn.ts` (`expo-apple-authentication`・`expo-crypto`・`./api` を読む)・`routeAfterSignIn.ts` を読み込む。`AppleSignInButton.tsx` は読み込みのときに `AppleAuthenticationButtonType` を読む。`supabase` のモックに `signInWithIdToken`・`updateUser` は無いが、スイッチ (`EXPO_PUBLIC_APPLE_SIGN_IN`) 無しの既存の it は Apple の関数を呼ばない。`theme` のモックに `radius.lg` はある。`./api` (`apps/mobile/src/lib/api.ts`) は `getApi()` を呼ぶまで client を作らない (`let _api = null`) ので、読み込みでは何も起きない | §14.1 の正典のモック (`expo-apple-authentication`・`expo-crypto`) を足す。既存の it (1〜3・4-1〜4-8・振り分け) の期待値は変えない。追記の it は §14.1 (5-1〜5-7) | A2 |
| `apps/mobile/__tests__/auth/signup.test.tsx` (`:23-30` の `../../src/lib/supabase` のモック・`:59-67` の `../../src/theme` のモック) | `app/(auth)/signup`・`signInWithOAuth` | login.test.tsx と同じ (新規登録画面も同じ 3 つを読み込む。`supabase` のモックは `signUp`・`signInWithOAuth` だけで、スイッチ無しの既存の it は Apple の関数を呼ばない) | 同上 (正典のモックを足す。既存の it 1〜3・`SIGNUP_MINOR_NOTICE` の it の期待値は変えない。追記の it は §14.1 (4〜7)) | A2 |
| `tests/auth-link-notice.test.tsx` (`:42-53` の `@/lib/supabase/server` のモックは `createClient` だけ・`:175-178` の `?code=abc`・`:180-182` の `?error=`。#1917 の続きで行の位置が変わった) | `auth/callback/route`・`exchangeCodeForSession` | 段 B の後の `/auth/callback` を描かずに `GET` で呼ぶ。`?code=abc` の it は交換の成功の後に `storeAppleRefreshTokenFromWebCallback` を通るが、`?provider=` が無いので最初の判定で `skipped` を返し、`getSupabaseAdmin` (モックに無い) に触れない。段 B が新たに読む `@/lib/db-logger` はこの冊ではモックされず本物を読むが、`createLogger` は作るだけでは書かず (`src/lib/db-logger.ts:139` 以降。ログは呼んだときだけ)、`skipped` の道はログを呼ばない。redirect 先は同じ。`?error=` の it (`:180-182`) は `?provider=` が無いので、段 B の `appleCallbackErrorMessage(null)` が `null` を返し、`/login?error=<AUTH_LINK_ERROR_MESSAGE>` (#1917 の続きで `error_description` の英文から固定の文に改めた。英文は console にだけ残す)。交換の前に戻る | 反応しない (確認だけ。Apple のときの固定の文は §14.2 の `tests/auth-callback-apple-token.test.ts` が受け持つ。S-34) | B |
| `tests/api/auth-login-context.test.ts` (`:59-62` の `@/lib/db-logger` のモック・`:104` の交換の結果 `{ user: USER, session: SESSION }`・`:165-175` の「記録が応答を変えない」) | `auth/callback/route`・`exchangeCodeForSession`・`createLogger` | 段 B の差分は `generateRequestId()`・`createLogger(…)` を呼ぶ (モックが返す)。`?provider=` が無いので保管は `skipped`。`recordWebLoginContextFromRequest` の呼ぶ回数と redirect 先は変わらない | 反応しない (確認だけ) | B |
| `tests/ai-consent-enforcement.test.ts` の「AI へ送るコードに届く route ハンドラ (src/app 全体。api の外も含む) は、すべて判定を呼ぶか、理由つきで除外されている」(`tests/helpers/ai-reach.ts` の `reachesAi`・`tests/helpers/ai-consent-enforced-paths.ts` の `EXEMPT_ROUTES`) | `src/app/(auth)/auth/callback/route.ts`・`@/lib/env` | `src/app` の route.ts を import でたどり、AI の印 (`src/lib/env.ts` の一覧の説明にある提供元の名前など) に届く route が `ENFORCED_ROUTES` か `EXEMPT_ROUTES` に無いと赤。段 B の `/auth/callback` は `web-callback.ts` → `config.ts` → `@/lib/env` で `src/lib/env.ts` に届くようになる (`src/app/api/auth/apple/authorization/route.ts` が A1 で同じ理由で除外されている) | `tests/helpers/ai-consent-enforced-paths.ts` の `EXEMPT_ROUTES` に `src/app/(auth)/auth/callback/route.ts` (`handlers: { GET: { noAi: … } }`。送る先は Supabase Auth と DB だけ) を足す | B |
| ソースを読む走査: `tests/public-claims-guard.test.ts` (`:127-141` の `PUBLIC_SOURCE_FILES` に `src/app/(auth)/login/page.tsx`・`signup/page.tsx`・`src/lib/legal/privacy-text.ts`。`FORBIDDEN` の文字列)・`src/__tests__/app/faq/account-answers.test.ts:233-234`・`src/__tests__/lib/auth/logout-guidance.test.ts:90-91` (パスワードを忘れたときの文の実在)・`apps/mobile/__tests__/app/route-targets-exist.test.ts:214` (`/(auth)/login` の実在)・`tests/operator-mfa-entry-points-scan.test.ts:41-42` (`AUTO_INCLUDE_EXCLUSIONS` のコールバック) | `app/(auth)/login`・`app/(auth)/signup`・`auth/callback/route` | 本書は画面とコールバックに足すだけで、既存の文・ファイル・`roles` の振り分けを消さない。足す文 (§11.6 の固定の文・§11.8 の委託先の行) に `FORBIDDEN` の文字列は無い。新設の route `POST /api/auth/apple/authorization` は運営のロールの文字列も入口の関数も持たない | 反応しない (確認だけ) | A2 / B / D |

## 18. 他の文書への追随表

| 文書 | 箇所 | 直すこと | 誰が・いつ |
|---|---|---|---|
| `docs/design/mobile/CLAUDE.md` | ファイル一覧の表 | 本書の行を足す: `08-sign-in-with-apple.md` / Sign in with Apple (iOS のネイティブ・Web の OAuth・退会のときの失効) / #1139 (`MOBILE_TODO.md` の Pass 3・Pass 10・ブロッカー 5) (番号は 08。Q-9)。「他ドメインとの依存」に `cross/01 §3.1・§3.3` の行 | オーケストレーターの docs PR (本書のマージと同時) |
| `docs/design/mobile/05-auth-session.md` | §1 (Google ログイン)・§9.1 の閉包 (`全 317 呼び出し`。数えた sha の記録)・`:129` (「`login.tsx` の `routeAfterSignIn` が画面を移すまで」) | §1 に「Apple のログインは `08-sign-in-with-apple.md`」の 1 行。`:129` は Google のログインの見え方の記録で、移した後も `login.tsx` が `routeAfterSignIn` を呼んで画面を移す事実は同じなので変えない。§9.1 は記録なので変えない (次に閉包を数え直す改定で `signInWithIdToken`・`updateUser` (apps/mobile)・`signInWithOAuth({ provider: 'apple' })` (Web) を M-*・W-* の行に足す) | オーケストレーターの docs PR (段 A2 のマージ後) |
| `docs/design/cross/01-auth-session.md` | §3.1 の表 (Apple Sign In Phase 1)・§3.3 | §3.3 の「退会時: ソーシャル連携トークン全削除 + Google/Apple ドキュメント準拠で IdP 側 revoke」に「Apple は mobile/08 §9.3 (`apple_revoke`)。Google の revoke は未実装 (Q-10)」を添える | オーケストレーターの docs PR (段 A1 のマージ後) |
| `docs/design/cross/13b-legal-consent-mobile.md` | `:50`・`:200` (`login.tsx:89-100`)・`:255` (S1 の (B)。`login.tsx:76-100`)・`:331` (`login.tsx:76-100`)・`:1728` (Q-4 の `?next=`。`login.tsx:86-90`) の `routeAfterSignIn` の場所・`:315`・`:360` (ログインの入口「メールとパスワード・Google」) | 場所を `apps/mobile/src/lib/routeAfterSignIn.ts` に、入口に「Apple」を足す (行番号の記録)。`:315` の「`login.tsx` の `routeAfterSignIn`」は、新規登録の画面 (Apple) からも呼ぶ事実を添える (`:368` は場所を名指していないので変えない)。`:689`・`:1070`・`:1234` はコードの注の写し (記録) なので変えない (コードの注は §18.1) | オーケストレーターの docs PR (段 A2 のマージ後) |
| `docs/design/cross/16-auth-history-sessions.md` | `:124` (S-6「Google でログイン (`signInWithOAuth` → `/auth/callback`)」)・`:212` (S-6 のトレース)・§8 の行 3 (`:333`「Google / Apple でログイン」)・§11.5 (パスワードの無い利用者 = Google / Apple だけ) | S-6 の文に「Apple (段 B) も同じ経路」を添える (記録)。§8 の行 3 と §11.5 は Apple を既に含むので変えない。Web の Apple のログインは同じ `/auth/callback` の `exchangeCodeForSession` → `recordWebLoginContextFromRequest` を通り (§17 の `web-login-context-source-scan` の行)、iOS の `signInWithIdToken` はモバイルの既存の文脈の記録 (`AuthProvider` の SIGNED_IN → `registerDeviceName`。cross/16 の S-3) を通るので、cross/16 の設計は変わらない | オーケストレーターの docs PR (段 B のマージ後) |
| `docs/design/mobile/07-toolchain-upgrade.md` | `:216`・`:260` (S9 の「ログイン直後の `routeAfterSignIn` の `replace`」)・`:855` (`apps/mobile/src/lib/legal-consent.ts:239` の注の写し) | 変えない。場所 (`login.tsx`) を名指しておらず、移した後も `routeAfterSignIn` が `replace` する事実は同じ | — |
| `docs/design/billing/01-billing-core.md` | `:3287` (`AccountDeletionStep` の和の抜粋。`billing`・`billing_recheck` を足した差分の説明) | 抜粋の `'billing_recheck'` の行の後に「`'apple_revoke'` は mobile/08 §9.3 が `billing_recheck` と `delete_user` の間に足す」の注を 1 行添える (抜粋は billing の差分の記録なので、和の中身は書き換えない) | オーケストレーターの docs PR (段 A1 のマージ後) |
| `docs/operations/auth-protection.md` | §4 の表の `:137` (「Google ログイン・登録」の行。呼び出しは `signInWithOAuth`・Web とモバイルとも CAPTCHA の対象外) | その次に Apple の行を足す (画面「Apple ログイン・登録」・呼び出しは Web が `signInWithOAuth` (段 B)・iOS が `signInWithIdToken` (段 A2)・Web とモバイルとも CAPTCHA の対象外) (GoTrue は `/token` の `grant_type` が `id_token`・`pkce`・`refresh_token` のとき CAPTCHA を確かめない。`internal/api/middleware.go` の `isIgnoreCaptchaRoute`) | オーケストレーターの docs PR (段 A2 のマージ後) |
| `docs/design/cross/20-terms-privacy-text.md` | §2.2 F-15 (外部送信に `Google OAuth`)・F-16 (委託先に `Google (OAuth)`)・§10 の主張の表 (`privacy-3#3`・`privacy-7`・`privacy-10` の行と区分の数)・§9 の版の履歴・§17・§9.3 の「版を上げる改定すべて」の行・§9.4 の 2 の括弧書き (予告を行ったかの記録) | 段 D の差分 (§11.8) を正典にも写す (Apple (OAuth) を F-15・F-16 に、主張の表に 2 行、版 `v2026.4` の行)。§9.4 の 2 の括弧書きに、`v2026.4` の公開で予告を行ったこと (Q-13 は (a)) と施行日を記録として足す | オーケストレーターの docs PR (段 D のマージと同時) |
| `docs/design/billing/03-paid-plans-and-iap.md` | F24 (「`PRIVACY_PROCESSORS` に `Stripe`・`RevenueCat`・`Apple` が無いこと」の記述)・§11.2 (c) の注の文 | T-33 の Apple の条件が「決済の事業者として載せない」に変わった事実を添える (記録) | オーケストレーターの docs PR (段 D のマージ後) |
| `MOBILE_TODO.md` | `:41` (ブロッカー 5)・`:186`・`:193` | 追跡を本書 (`docs/design/mobile/08-sign-in-with-apple.md`) にし、済んだ段を記す | オーケストレーター (各段のマージ後) |
| `apps/mobile/README.md`・`ENV_SETUP.md` (リポジトリ直下。`apps/mobile/ENV_SETUP.md` は無い) | `apps/mobile/README.md` の環境変数の節 (`:17-26`)・`ENV_SETUP.md` の任意の変数の表 (`:22`) と「モバイル（Expo）での環境変数」の節 (`:447`) | `EXPO_PUBLIC_APPLE_SIGN_IN` (`apps/mobile/README.md` と `ENV_SETUP.md` のモバイルの節)・Web の 5 つ (`ENV_SETUP.md` の任意の変数) の説明 (設定の順 §19) | 実装 PR (Web の 5 つは段 A1・モバイルの 1 つは段 A2) で足してよい (設計正典ではない) |
| `docs/design/cross/08-legal-compliance.md` | `:397` (「初回の作成」の行: 「サインアップ画面の Google 登録・メール確認と、ログイン画面の「Googleで続ける」で初めて入った人 (サインアップ画面のチェックを通らない) が、どれもここを通る」) | 「Apple 登録」と「Appleで続ける」(段 B) を足す。iOS の Apple のログインは `/auth/callback` を通らず、モバイルの同意のゲート (cross/13b) で同意の画面へ回る事実を添える。判定 (`resolveFirstSignInDestination`) は provider を見ないので行の決まりは変わらない (§18.1 の `lib/legal-consent.ts` の注と同じ) | オーケストレーターの docs PR (段 B のマージ後) |
| `docs/design/marketing/01-landing-site.md` | `:516` (主張 `signup-methods`「メールアドレスか Google アカウントで登録できる」。根拠 `src/app/(auth)/signup/page.tsx:47`・`:235`)・`:823` (要点 1「登録はメールか Google で」)・`:846` (FAQ 10)・`:2175`・`:2266` (正典コードの写し)。コードは `src/components/marketing/landing-copy.ts:810`・`:901`、公開の FAQ は `src/app/faq/page.tsx:48` | 段 B と段 D のマージ後も、Web のスイッチ (`NEXT_PUBLIC_APPLE_SIGN_IN`) が off の間は Web に Apple のボタンが出ないので、文は事実のまま (変えない)。スイッチを on にした後は Apple でも登録できるのに文が挙げないので、Apple を足す (Q-14 は (a)。§21)。主張の表・要点・FAQ の文と `landing-copy.ts`・`faq/page.tsx` を同じ PR で直す (marketing/01 の手順) | オーケストレーター (Web のスイッチを on にするのと同じ時期の別の PR) |
| `docs/design/mobile/02-deep-link.md` | `:27` (`homegohan://auth/verify` = 新規登録の確認・Google ログインの戻り・メールアドレス変更の確認) | 変えない。iOS の Apple のログインはネイティブのシートと `signInWithIdToken` でアプリの中で完結し、ディープリンクの戻りを使わない (§9.1) | — |
| `docs/design/cross/12-operator-mfa.md` | `:56` (「パスワード (または Google ログイン) に加えて」)・`:185` (S-18 Google ログインの admin)・`:2722`・`:2857` (判定はログインの方式を入力に持たない) | 変えない。運営の入口の判定はセッションの AAL だけを見てログインの方式を入力に持たない (`:2722`) ので、Apple で入った運営の権限の持ち主も S-18 と同じく `aal2` を求められる。Web の Apple のログインも同じ `/auth/callback` を通る (§9.5) | — |
| `docs/operations/` | (新設の候補) `sign-in-with-apple.md` | §19 のオーナーの手順 (§19.3 のスイッチの前の確認を含む) と 6 か月ごとの Secret Key の入れ替えの記録 | オーケストレーター (段 A1 のマージ後。任意) |
| `CLAUDE.md` (ルート) | モバイルの認証の節があれば | Apple のログインの入口と、スイッチの名前 | オーケストレーターの docs PR (任意) |

### 18.1 コードの注の追随 (実装の段で同じ PR)

設計正典ではないコードの注のうち、Google だけを名指す文と `routeAfterSignIn` の場所を名指す文。振る舞いは変えない (同意の画面へ回す判定 `resolveFirstSignInDestination` は provider を見ないので、Apple で初めて入った人も同じく同意の画面へ回る R-14)。

| ファイル | 箇所 | 直すこと | 段 |
|---|---|---|---|
| `lib/legal-consent.ts` | `:189`・`:192` (`resolveFirstSignInDestination` の注「ログイン画面の「Googleで続ける」は、初めての人には新しいアカウントを作るが、そのチェックを通らない」) | 「Googleで続ける」「Appleで続ける」の両方を名指す | B |
| `src/app/(auth)/auth/callback/route.ts` | `:194` (#1435 の注の「ログイン画面の「Googleで続ける」で初めて入った人」) | 同上 (段 B が同じファイルを触る) | B |
| `src/app/(auth)/login/page.tsx` | `:222` (#1435 の注「「Googleで続ける」は、初めての人には新しいアカウントを作る」) | 同上。案内 `login-google-legal-note` の文と testID は変えない (§10.2) | B |
| `src/app/(auth)/signup/page.tsx` | `:26`・`:28` (「登録 (Google 登録・メール確認) のあと」「ログイン画面の「Googleで続ける」で初めて入った人も」) | Apple の登録と「Appleで続ける」を足す | B |
| `apps/mobile/app/onboarding/_layout.tsx` | `:22` (#1442 の注「`login.tsx` の `routeAfterSignIn` が…」) | 「ログイン・新規登録の画面から呼ぶ `routeAfterSignIn` (`src/lib/routeAfterSignIn.ts`) が…」にする | A2 |
| `apps/mobile/app/legal-consent.tsx` | `:31` (「ログインの直後の `routeAfterSignIn` の replace など」) | 変えない (場所を名指していない) | — |
| `apps/mobile/src/lib/legal-consent.ts` | `:239` (同上の REPLACE) | 変えない (同上) | — |

## 19. オーナーの作業 (手順)

### 19.1 Apple Developer (developer.apple.com → Certificates, Identifiers & Profiles)

1. **App ID** `com.homegohan.app` の Capabilities で **Sign In with Apple** を有効にする (EAS Build が managed credentials で同期するが、先に有効にしておくと確実)。
2. **Key**: Keys → + → 名前 (例: Homegohan Sign in with Apple) → Sign In with Apple にチェック → Configure で Primary App ID = `com.homegohan.app` → 登録 → **.p8 をダウンロード (1 回しかできない) し、Key ID (10 文字) と Team ID (10 文字) を控える**。
3. **Services ID** (Web の OAuth = 段 B に要る): Identifiers → + → Services IDs → Identifier (例: `com.homegohan.app.web`) → Sign In with Apple を有効にして Configure → Primary App ID = `com.homegohan.app`、Domains and Subdomains = Supabase のプロジェクトのホスト (`<project-ref>.supabase.co`)、Return URLs = `https://<project-ref>.supabase.co/auth/v1/callback`。
4. **メールの中継**: Identifiers → Services → **Sign in with Apple for Email Communication** → Configure → Email Sources に、メールの送信ドメイン (`EMAIL_FROM` のドメイン。Resend で検証済みのもの) を登録する。登録したドメインの SPF が通っていること (Resend の SPF・DKIM の DNS がそのまま使える。表の SPF の列が通ったことを確かめる)。未登録だと中継のアドレス (`@privaterelay.appleid.com`) の利用者にメール (確認・退会の完了) が届かない。

### 19.2 Supabase Dashboard (Authentication → Providers → Apple)

1. Enabled を on。
2. **Client IDs**: 段 B まで出すなら `<Services ID>,com.homegohan.app` (Services ID を先頭に。Web の OAuth は先頭の ID を使う)。iOS だけなら `com.homegohan.app`。
3. **Secret Key** (Web の OAuth にだけ要る): Supabase の案内のとおり、Team ID・Key ID・.p8・Services ID から 6 か月有効の JWT を作って入れる。**6 か月ごとに作り直す** (切れると Web の Apple ログインだけが失敗する。iOS のネイティブは影響しない)。入れ替えの日をカレンダーに入れる。
4. Redirect URLs の許可リストに Web の `https://<Web のオリジン>/auth/callback` があること (Google と同じ。既にあるはず)。

### 19.3 Vercel の環境変数 (Production)

| 名前 | 値 | 入れる時期 |
|---|---|---|
| `APPLE_SIGN_IN_TEAM_ID` | Team ID | 段 A1 のデプロイの後。遅くとも iOS・Web のどちらかのスイッチを入れる前 (下の「スイッチの前の確認」の前) に入れて再デプロイする (無くてもログインは動くが、無い間に Apple で入った人は refresh token が保管されず、退会のときに失効されない。S-12・S-16) |
| `APPLE_SIGN_IN_KEY_ID` | Key ID | 同上 |
| `APPLE_SIGN_IN_PRIVATE_KEY` | .p8 の中身を 1 行にし改行を `\n` と書いたもの | 同上 (書き方を誤ると route が 500 (`step: 'client_secret'`) を返し、同じく保管されない) |
| `APPLE_SIGN_IN_SERVICES_ID` | Services ID (19.2 の 2 の Client IDs の先頭と同じ文字列) | 段 B のデプロイの後。Web のスイッチを入れる前 (下の「スイッチの前の確認」の前) に入れて再デプロイする (無い間に Web で入った人は保管されない。S-29) |
| `NEXT_PUBLIC_APPLE_SIGN_IN` | `on` | 段 B と段 D のデプロイ (施行日) の後、19.2 の 1〜3 と下の「スイッチの前の確認」(Web の分を含む) が済んでから (再デプロイが要る) |

**スイッチの前の確認** (§7.3 (d) の `published` → `secrets_verified`。iOS・Web のどちらのスイッチより前にも行う。オーケストレーターが名前の一覧・デプロイの時刻・本番の行の数・ログを読み、オーナーは 3 の確認のビルドで 1 回入る。秘密の値は読まない・出さない・ログに残さない)

秘密が無い・本番のデプロイに効いていない・壊れている間に Apple で入った人は、refresh token の行が残らない (iOS は route が 200 `not_configured` か 500 を返す。Web は Services ID が無いと保管しない)。行を作り直す道はその人がまた Apple で入ること (S-3) だけで、その人の退会では Apple を呼ばずに消える (S-16)。§20 の受入は公開の後に流すので、この空白は公開の前のここで閉じる。

| # | 確かめること | 方法 | 通らないとき |
|---|---|---|---|
| 1 | 名前が Vercel の Production にある: `APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY` (iOS と Web)。Web を出すなら `APPLE_SIGN_IN_SERVICES_ID` も | `vercel env ls production` (名前・環境・時刻の一覧。値は出ない) の名前の列を見る。値を出す操作 (`vercel env pull`・ダッシュボードの値の表示) はしない | オーナーが入れる |
| 2 | 効いている: 今の本番のデプロイが、1 の変数を最後に入れた (変えた) 時刻より後に作られている | 本番のデプロイの作成時刻と 1 の一覧の時刻を比べる (Vercel の環境変数は、保存した後に作るデプロイから効く。それより前のデプロイには入らない) | 本番を再デプロイする |
| 3 | 本番で `readAppleSignInServerConfig()` が null でなく、秘密鍵で `client_secret` を作れ、Apple の交換 (`/auth/token`) が通る | EAS の preview の環境変数にだけ `EXPO_PUBLIC_APPLE_SIGN_IN=on` を入れた内部配布のビルド (利用者には配らない。preview の `EXPO_PUBLIC_API_BASE_URL` が本番の Web を、`EXPO_PUBLIC_SUPABASE_URL` が本番の Supabase を指すもの) で、オーナーが自分の Apple ID で 1 回入る。オーケストレーターは、本番の `apple_sign_in_tokens` に `client_id = 'com.homegohan.app'` で `updated_at` がそのログインの直前の時刻より後の行が 1 つあること (`SELECT count(*)`。`refresh_token` は読まない) と、その時刻の Vercel のランタイムログに `apple authorization: server config is missing; refresh token not stored` (`info`) と route の 500 が無いことを見る | 行が無ければ、その時刻のログで見分ける: `info` (`not_configured`) → 1・2 の漏れ (名前・再デプロイ)。`warn` の `apple rejected the authorization code` (`apple_error` = `invalid_grant`) → 認可コードの期限切れ・使用済み (S-13) なので、もう一度入る。500 の `step: 'client_secret'` → 秘密鍵の書き方 (1 行・改行は `\n`・ヘッダとフッタ) を直して 2 から。`step: 'exchange'` → Team ID・Key ID・Key の Primary App ID (19.1 の 2) を直して 2 から。`step: 'store'` → 段 A1 の migration (表) が本番にあるかを確かめる。直したら 3 をもう一度 |

- Web の保管は秘密鍵を使わない (GoTrue が返す `provider_refresh_token` を保管するだけ。§9.5) ので、Web の分は 1・2 で確かめる。Web の行の失効に使う秘密鍵・Team ID・Key ID は 3 が確かめる (iOS と同じ値)。
- 確認の後に秘密を入れ替えた・消したときは、§7.3 (d) の `published` に戻ってもう一度 1 から。スイッチを入れた後に入れ替えたときも、入れ替えの後のデプロイで 1〜3 と同じ確かめ方を流す (確認のビルドの代わりに、公開中のビルドでオーナーが 1 回入ってよい)。

### 19.4 EAS の環境変数とビルド

- `EXPO_PUBLIC_APPLE_SIGN_IN` = `on` は 2 回に分けて入れる。(1) preview の環境変数に入れて内部配布のビルドを作り、§19.3 の「スイッチの前の確認」の 3 に使う (段 D の公開 (施行日)・19.2 の 1〜2・§19.3 の 3 つの秘密の登録と再デプロイの後。利用者には配らない)。(2) production の環境変数に入れて production のビルドを作り、提出する (§19.3 の「スイッチの前の確認」の 1〜3 が通った後)。
- 段 A2 のマージ後に新しいビルド (指紋が変わる)。内部配布か TestFlight で実機の確認 (§20)。

### 19.5 App Store Connect

- App Privacy の申告は既存の「名前・メールアドレス (アカウント)」の範囲で、新しい項目は無い。Notes for Review に「Sign in with Apple を提供」と、審査用のアカウント (既存の案内 `docs/operations/app-store-metadata.md`) を書く。

## 20. 受入 (デプロイ後整合ゲート) の項目

1. 本番の実機 (iOS) のログイン画面に Apple のボタンが Google の上に同じ高さで出て (iPhone の設定 → 画面表示と明るさ → テキストサイズを変更 で文字を最大にしても、Apple のボタンが Google のボタンより低くならない。S-33)、Face ID の認可のあとホーム (または初期設定・同意画面) に入る。設定 → アカウントに「Apple アカウントでログインしています」とメール (中継を選んだときは `@privaterelay.appleid.com`) が出る。
2. 本番の `auth.identities` に `provider = 'apple'` の行と、`apple_sign_in_tokens` に `client_id = 'com.homegohan.app'` の行が 1 つできている (SELECT。値は読まない・載せない)。
3. 同じ利用者で退会 → `app_logs` の `account deleted` の metadata に `apple.revoked = 1`、Apple の `/auth/revoke` が 200 (warn が無い)。iPhone の設定 → Apple アカウント → Apple でサインイン の一覧からこのアプリが消えている。
4. シートで取り消し → 何も出ない。スイッチ無しのビルド (段 A2 のマージの後・スイッチを入れる前に作ったビルド) ではボタンが無い。
5. Web (段 B のあと): 「Appleで続ける」と「Googleで続ける」が同じ高さで並ぶ (ブラウザの文字の大きさの設定を大きくしても同じ。§10.2)。「Appleで続ける」で同意画面 → ホーム。`apple_sign_in_tokens` に Services ID の行ができる (`provider_refresh_token` が返っていれば。返らなければ Q-6 を記録)。
6. プライバシーポリシー `/privacy` の第7条に Apple の行、版 `v2026.4`、施行日 = 段 D のデプロイ日。既存の利用者に再同意が出る。施行日より前に予告のお知らせが公開されていた (`announcements` の `is_public` = true・`published_at` が施行日 (JST) より前。SELECT で題と日時だけを見る。Q-13 は (a))。
7. スイッチを on にした後の Vercel のランタイムログに、`apple authorization` の `warn` / 500 と `not_configured` の `info` が無い (秘密はスイッチの前に入れて確かめてある。§19.3)。
8. 中継のアドレスの利用者に退会の完了メールが届く (19.1 の 4 が済んでいること)。
9. Web のスイッチ (`NEXT_PUBLIC_APPLE_SIGN_IN=on`) を入れた後、ログイン画面と新規登録画面の Apple のボタンが Apple の画面へ行く (Supabase の `/auth/v1/authorize` の 400 の JSON にならない。S-28)。
10. Web (段 B のあと・スイッチ on): ログイン画面と新規登録画面のそれぞれで「Appleで続ける」「Appleで登録」→ Apple の画面で取り消す → ログイン画面の赤いバナーに「Apple でのログインを完了できませんでした。もう一度お試しください。」が出る (英文 (`user_cancelled_authorize` など) が出ない。S-34)。そのときの `/auth/callback` の要求に `provider` が付いていた (Vercel のランタイムログの `[auth/callback] Param presence (no values)` に `provider` と `error` の名前がある。F-18)。Apple が返した `error` の値は同じ要求の `[auth/callback] Supabase returned error:` のログ (`route.ts:38-42`。既存) で読める (Q-7 は (a) で値では分けないので、記録として読むだけ)。
11. スイッチの前の確認 (§19.3) が、iOS・Web のスイッチより前に通っていた: Vercel の Production の名前の一覧 (iOS は 3 つ、Web はそれと `APPLE_SIGN_IN_SERVICES_ID`)・本番のデプロイの作成時刻がそれより後・確認のビルドでオーナーが入った後に `apple_sign_in_tokens` の `client_id = 'com.homegohan.app'` の行ができ、その時刻のログに `not_configured` の `info` と route の 500 が無い (記録を整合ゲートに添える。値は載せない)。

## 21. 未解決事項・選択肢

- **Q-1 (選択式) Web にも Apple のログインを出すか**: 既定 = 出す (段 B)。理由: アプリで Apple だけで作った人が Web に入る手段が、Apple か「パスワードを忘れた」の再設定 (cross/16 §11.5) しか無い。アプリだけにするなら段 B と `APPLE_SIGN_IN_SERVICES_ID`・19.1 の 3・19.2 の 3 を落とす (iOS のネイティブは Services ID も Secret Key も要らない)。
  - **オーナーの選択 (2026-10-23)**: 出す (既定のとおり。段 B を作る)。
- **Q-2 (選択式) 失効に失敗したときに退会を止めるか**: 既定 = 止めない (裁定 2)。止める案は Apple の障害で退会 (5.1.1(v)) ができなくなる。やり直しの列 (R3) は退会の量が増えたら別の Issue で (段階の時間の上限 (§13.1) を過ぎて呼ばなかった行も、その列があれば拾える)。
- **Q-3 Android の Apple ログイン**: 範囲外。出すときは Google と同じ `signInWithOAuth({ provider: 'apple' })` + `openAuthSessionAsync` (Services ID と Secret Key が要る) を `Platform.OS === 'android'` のときだけ使う。Android の提出 (iOS の後) の案件で決める。
- **Q-4 設定画面から Apple の連携だけを外す操作**: 範囲外 (Supabase の `unlinkIdentity` は identity が 2 つ以上のときだけ使える)。要るなら別の Issue。
- **Q-5 メールを隠した人が既存のアカウントと別になったときの案内**: 本書は Google と同じく案内しない (S-6)。HIG は「同じメールなら結び付けを提案」と言うが、中継のメールでは判定できない。要るなら設定画面に `linkIdentity` の案内を足す別の Issue。
- **Q-6 Web の `provider_refresh_token` の有無**: GoTrue は PKCE の交換で flow state の `provider_refresh_token` を返す (`token.go`)。Apple の交換の応答に `refresh_token` があるので返る見込みだが、本番で 1 回確かめる (§20 の 5)。返らないときは Web の行は保管されず、その入口の失効はスキップになる (iOS の行で失効する)。返らないことが分かったら、Web の Apple のログインも iOS と同じ「認可コードをこちらで交換する」形 (Supabase の `signInWithOAuth` を使わず Apple の JS でコードを受け、サーバで交換して `signInWithIdToken`) に変える別の設計が要る。
- **Q-7 (選択式) Web で Apple の画面を取り消したとき (と Apple / GoTrue の失敗で `/auth/callback?provider=apple&…&error=…` に戻ったとき) のログイン画面の表示**: 既存のコールバックは、Apple 以外の provider とメールのリンクの失敗も固定の文 `AUTH_LINK_ERROR_MESSAGE` を出す (`src/app/(auth)/auth/callback/route.ts:46-53`。PR #2007 より前は `error_description` (英文。無ければ `user_cancelled_authorize` などの `error` の値) をそのままバナーに出していた)。本書は Apple のときに `APPLE_WEB_CALLBACK_ERROR_MESSAGE` を出す (S-34・R-19)。段 B は (a) で実装した (下の選択)。
  - (a) 既定: `error` の値で分けず、どれもログイン画面のバナーに固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE`「Apple でのログインを完了できませんでした。もう一度お試しください。」を出す。取り消しにも失敗にも合う文。Apple と GoTrue が返す値の一覧に頼らないので、本物の Apple に繋がずに確かめられる (§14.2)。iOS の取り消し (何も出さない。S-7) とは見え方が違う。
  - (b) 取り消しは何も出さない (iOS の S-7 と同じ): `appleCallbackErrorMessage` が `error` の値も受け取り、取り消しの値 (`user_cancelled_authorize` など。Apple の値の一覧を定数にする) のときは `/login` へ `?error=` を付けずに送り、ほかの値は (a) の固定の文にする。取り消しの値は Apple が決めるので、§20 の 10 のログ (`[auth/callback] Supabase returned error:`) で実際の値を確かめてから一覧を固める。
  - Google の取り消し・失敗 (`?provider=` が無い) の英文は本書の範囲外で、今までどおり。日本語にするなら別の Issue。(→ #1917 の続きで、provider に関わらない固定の文 `AUTH_LINK_ERROR_MESSAGE` にした)
  - **オーナーの選択 (2026-10-23)**: (a) 固定の文 `APPLE_WEB_CALLBACK_ERROR_MESSAGE` を出す。
- **Q-8 e2e**: Playwright の e2e は本物の Apple を通せない。スイッチ無しで Apple のボタンが出ないこと (段 B の `tests/login-apple-button.test.tsx` の単体) で足りるとする。スイッチ on の e2e は「ボタンが disabled である」までを足してよい (Q-8 は実装者の判断に委ねない: 足さない)。
- **Q-9 (オーケストレーターの裁定・済み) 本書のファイル名の番号**: `docs/design/mobile/` には `06-push-send.md` が既にあるので、本書は設計ゲートの通過の後に `08-sign-in-with-apple.md` に置いた (`mobile/CLAUDE.md` の表に行を足した)。
- **Q-10 Google の revoke**: cross/01 §3.3 は Google も IdP 側で revoke すると書くが、未実装 (本書の範囲外)。Apple と同じ表 (`client_id` を Google の client ID にする) で扱える形にしてあるので、要るなら別の Issue。
- **Q-11 Secret Key の自動化**: Supabase の Apple の Secret Key (6 か月) を、サーバの `createAppleClientSecret` と同じ鍵で作る `scripts/` の道具は本書に入れない (オーナーが Supabase の案内で作る)。入れ替えを忘れると Web の Apple ログインが止まるので、`docs/operations/` の記録 (§18) に日付を残す。
- **Q-12 Issue の番号**: #1139 の本文はストアの提出と Pass 1〜10 の全体で、Sign in with Apple の語は本文に無い。Sign in with Apple は、本文が該当箇所に挙げる `MOBILE_TODO.md` の Pass 3 (`:186`)・Pass 10 (`:193`) と、同じファイルのブロッカー 5 (`:41`) の一部。実装の Issue は #1139 の子として 4 段 (A1・A2・B・D) で起こすのがよい (オーケストレーター)。
- **Q-13 (選択式) 段 D (版 `v2026.4`) の改定の予告**: cross/20 §9.3 の「版を上げる改定すべて」の行は §9.4 の 2 (施行日の前に運営のお知らせに改定の予告を載せる) を必ず行うと定め、除外は `v2026.1`・`v2026.2`・`v2026.3` の公開だけ。公開中のプライバシーポリシー第18条 1 項 (`privacy-18`) と利用規約第24条 1 項 (`terms-24`) は、内容が変わる改定の概要と施行日を施行日の前にお知らせに掲載すると約束している (省くと公開した約束を破る。cross/20 §9.4 の 2)。版を上げると 2 文書とも再同意が全員に出る (T-17。本番の `auth.identities` は 194 件。F-13)。(a) を選んだ (下の選択)。施行日を伺うのは段 D の 2 枚 PASS の後・マージの前 (§11.8 (i))。
  - (a) 既定: 予告して施行日を待つ。施行日はオーナーが決める (cross/20 は予告から施行日までの日数を決めていない)。お知らせを施行日より前に公開し、施行日に段 D をマージ・デプロイする。Apple のログインを出す (スイッチ on・ストアへの提出) のは施行日の後になる。段 A1・A2・B のマージは待たない。
  - (b) 予告なしで公開する: 段 D の 2 枚 PASS の後すぐにマージ・デプロイできる。公開中の約束 (施行日の前の掲載) を守らない公開になるので、cross/20 §9.3 の除外の行に `v2026.4` を書き足す (§18)。
  - **オーナーの選択 (2026-10-23)**: (a) 予告して施行日を待つ。施行日は段 D の 2 枚 PASS の後にオーナーに伺う。**オーナーの選択 (2026-10-24)**: 施行日は 2026-11-01 (日)。予告のお知らせはオーナーが運営画面から投稿する (文はエージェントが PR #1997 の差分から下書きした)。
- **Q-14 (選択式) 紹介ページと FAQ の「登録はメールか Google で」**: 紹介ページの主張 `signup-methods` (`docs/design/marketing/01-landing-site.md:516`。文は `src/components/marketing/landing-copy.ts:810`・`:901`) と公開の FAQ (`src/app/faq/page.tsx:48`) は、登録の方法をメールと Google だけ挙げる。Web のスイッチが off の間は事実のまま。on にした後は Apple でも登録できるのに挙げない文になる (誤りではないが、方法の列挙として欠ける)。(a) を選んだ (下の選択)。直すのは Web のスイッチを on にするのと同じ時期 (§18)。
  - (a) 既定: Apple を足す。スイッチを on にするのと同じ時期に、主張の表・要点・FAQ と 2 つのコードの文を同じ PR で直す (marketing/01 の手順。本書の段 A1・A2・B・D には含めない)。
  - (b) 足さない: 文は今のまま (メールか Google で登録できる、は事実のまま)。
  - **オーナーの選択 (2026-10-23)**: (a) Apple を足す (Web のスイッチを on にするのと同じ時期の別の PR)。
