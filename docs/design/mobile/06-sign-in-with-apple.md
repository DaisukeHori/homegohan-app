# Sign in with Apple (iOS のネイティブのログイン・Web のログイン・退会のときの失効)

| 項目 | 内容 |
|---|---|
| 版 | v1.1 (2026-10-23) |
| 状態 | 設計ゲート審査中 (実装着手は通過後) |
| 範囲の正本 | Issue #1139 (本文の Pass 3「認証/セッション」と Pass 10「ストア要件 (iOS)」の Sign in with Apple。`MOBILE_TODO.md` の「提出前に片付けるブロッカー」の 5 = Sign in with Apple・作業計画 T43) |
| 土台 | origin/main `9575aa99` (2026-10-23)。本文の file:line はこの版の事実 |
| 関連の正典 | `docs/design/cross/01-auth-session.md` §3.1 (Apple Sign In = Phase 1・iOS App Store 必須)・§3.3 (退会のときの IdP 側の revoke)・`docs/design/mobile/05-auth-session.md` (Google ログイン・セッションの保管)・`docs/design/cross/16-auth-history-sessions.md` §11.5 (パスワードの無い利用者 = Google / Apple だけ)・`docs/design/cross/13b-legal-consent-mobile.md` (ログインの後の同意のゲート)・`docs/design/cross/20-terms-privacy-text.md` (委託先の表・主張の表・版) |
| 実装の範囲 | 段 A1 サーバ (表・交換と失効の lib・API・退会の段階)・段 A2 モバイル (iOS のネイティブのシート)・段 B Web (OAuth)・段 D 法務 (プライバシーポリシーの委託先と版)。§15 |

改定履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-23 | 初版 (A 型・4 相。要件行列・シナリオ 24 本・構造裁定・表 3 点・正典コード・テスト・段分け・番兵と他の文書の追随表) |
| v1.1 | 2026-10-23 | 周 1 の網羅性の反映: §17 に退会の番兵 (`tests/account-deletion-email.test.ts`・`src/__tests__/api/account/delete-missing-env.test.ts`・`tests/billing-account-deletion.test.ts`・結合テスト 3 本)・`signInWithOAuth` をモックする画面のテスト 2 本 (`apps/mobile/__tests__/auth/turnstile-screens.test.tsx`・`tests/signup-minor-notice.test.tsx`)・`tests/auth/web-login-context-source-scan.test.ts` の行を足し、§14.1 に `expo-apple-authentication`・`expo-crypto` の正典のモックを書いた。§18 に `cross/16`・`mobile/07`・`billing/01`・`docs/operations/auth-protection.md` の行を足し、`mobile/05`・`cross/13b` の行に `routeAfterSignIn` の場所を名指す行を足した。§18.1 (コードの注の追随) を新設し、§15 の段 A2・B の触るファイルに足した。§21 Q-9 の文を直した |

## 0. 範囲・前提・分冊判定

### 0.1 範囲

- App Store Review Guideline 4.8 (Login Services): 第三者のログイン (Google など) で主たるアカウントを作る・認証するアプリは、同等の選択肢として「名前とメールアドレスに限った取得・メールアドレスを隠せる・広告目的の追跡をしない」ログインを置く。本アプリは Web とモバイルに Google ログインがあり (`src/app/(auth)/login/page.tsx:79`・`signup/page.tsx:56`・`apps/mobile/app/(auth)/login.tsx:108`・`signup.tsx:41`)、Apple の実装は 0 件 (`expo-apple-authentication`・`signInWithIdToken`・`provider: 'apple'` の呼び出しは無い。あるのは設定画面の表示名 `providerLabel` の `apple` の分岐だけ: `src/app/(main)/settings/account/page.tsx:59`・`apps/mobile/src/components/settings/AccountCredentialsSection.tsx:30`)。
- 本書が決めるもの: (1) iOS のネイティブの入口 (ログイン・新規登録) とボタン (2) Web の入口とボタン (3) 認証の流れ (Supabase の呼び方・nonce・コールバック)・日本語の固定の文 (4) 既存のアカウントとの関係・初回だけ来る名前・メールの中継 (5) 退会と Apple のトークンの失効 (要る。手順を §9.3) (6) 設定が無いとき (オーナー作業の前) の画面 (ボタンを出さない) (7) 本物の Apple に繋がないテスト (8) オーナーの作業 (Apple Developer・Supabase・Vercel・EAS) とエージェントの作業の分け。
- 本書が決めないもの (範囲外): Android の Apple ログイン (§21 Q-3)、Apple のアカウントの連携を設定画面から外す操作 (退会でだけ失効させる。§21 Q-4)、WebView の中の Web のログイン画面 (モバイルのログインはネイティブの画面。§0.2)、LINE などほかの IdP。

### 0.2 前提の事実 (origin/main `9575aa99`)

| # | 事実 | 根拠 |
|---|---|---|
| F-1 | モバイルのログイン・新規登録はネイティブの画面 (WebView ではない)。Google は `signInWithOAuth({ provider: "google", options: { redirectTo: Linking.createURL("/auth/verify"), skipBrowserRedirect: true } })` → `WebBrowser.openAuthSessionAsync` → `completeAuthLink(extractSupabaseLinkParams(result.url))` → `routeAfterSignIn()` | `apps/mobile/app/(auth)/login.tsx:103-134`・`signup.tsx:36-56`・`apps/mobile/src/lib/authLink.ts` |
| F-2 | ログインの後の振り分け `routeAfterSignIn` (`user_profiles` の `onboarding_*` と `?next=`) は `login.tsx` の中の関数で、`signup.tsx` には無い (Google 登録は `router.replace("/auth/verify")` へ) | `apps/mobile/app/(auth)/login.tsx:76-100`・`signup.tsx:53` |
| F-3 | モバイルの Supabase client は `storage: secureSessionStorage`・`detectSessionInUrl: false`。セッションを作れば `AuthProvider` が `onAuthStateChange` で受け取り、`identifyPurchases`・端末名の登録が動く | `apps/mobile/src/lib/supabase.ts`・`apps/mobile/src/providers/AuthProvider.tsx` |
| F-4 | モバイルの依存は Expo SDK 58 (`expo ~58.0.14`・`expo-web-browser ~58.0.6`・`expo-secure-store ~58.0.2`・`expo-linking ~58.0.13`)。`expo-apple-authentication`・`expo-crypto` は無い。Expo の SDK 58 の版の表 (`expo@58.0.14` の `bundledNativeModules.json`) は `expo-apple-authentication` = `~58.0.2`・`expo-crypto` = `~58.0.7` | `apps/mobile/package.json:24-50`・`tests/mobile-toolchain-contract.test.ts` |
| F-5 | `app.json` は `ios.bundleIdentifier` = `com.homegohan.app`・`infoPlist.CFBundleLocalizations` = `["ja", "en"]`・`plugins` に `expo-apple-authentication` は無く `ios.usesAppleSignIn` も無い。`runtimeVersion.policy` = `fingerprint` (ネイティブのモジュールを足すと指紋が変わる = 新しいビルドが要る) | `apps/mobile/app.json` |
| F-6 | Web のログインは `signInWithOAuth({ provider: 'google', options: { redirectTo: `${origin}/auth/callback?next=…` } })`。コールバック `/auth/callback` は `code` を `exchangeCodeForSession` で交換し、初めての人は同意画面へ回す (#1435)。新規登録は同意のチェック (`agreedToLegal`) を入れるまで Google のボタンを押せない (#1174) | `src/app/(auth)/login/page.tsx:71-91, 209-231`・`signup/page.tsx:367-390, 545-556`・`src/app/(auth)/auth/callback/route.ts:72-83, 194-203` |
| F-7 | 設定画面のアカウントは `user.app_metadata.provider` (最初に登録した provider) が `email` のときだけパスワード・メールの変更のフォームを出し、`google` / `apple` は案内 (`ExternalProviderGuidance`) だけ。`apple` の表示名「Apple」は既にある | `src/app/(main)/settings/account/page.tsx:57-60, 408-429`・`apps/mobile/src/components/settings/AccountCredentialsSection.tsx:28-31, 228-250, 281-282`・`src/__tests__/app/settings/account-page.test.ts:298` |
| F-8 | 退会 `deleteAccount` の段階は `check_blockers` → `billing` → `prepare` → `release_membership` → `storage` → `record` → `billing_recheck` → `delete_user` (→ 完了メール)。Stripe の処理は差し替え口 `params.billing` (`AccountDeletionBilling`) で入れ、テストは偽物を渡す。Apple・`identities`・revoke の語は 0 件 | `src/lib/account-deletion.ts:9-35, 50-60, 122-135, 310-415`・`tests/account-deletion.test.ts` |
| F-9 | 利用者の API の認証は `requireSessionUser(supabase, authorization)` (Cookie / Bearer。`user_profiles` の行が無くても通る)。失敗の応答は `sessionsFailure` (AuthError → 401・ForbiddenError → 403・ほか 500)。本文を読む route は最初に `rejectNullCharacterBody` を呼び、`src/__tests__/api/null-character-routes.test.ts` の表に載る。500 は `internalError` だけ | `src/lib/auth/sessions/session-claims.ts:82-103`・`src/lib/auth/sessions/route-support.ts:71-78`・`src/app/api/auth/password/change/route.ts` |
| F-10 | 環境変数は `src/lib/env.ts` の一覧 (`PUBLIC_ENV_VARS` / `SERVER_ENV_VARS`。任意の変数は `whenMissing` を書く) と `.env.example` の両方に書く (`tests/env-source-scan.test.ts`)。公開の変数は `process.env.NEXT_PUBLIC_X` と名前を直接書いて読む。モバイルは `process.env.EXPO_PUBLIC_X` と直接書き、`apps/mobile/env.example` に書く (`apps/mobile/__tests__/lib/env-example.test.ts`)。設定の無いビルドで機能を出さない流儀は RevenueCat (`apps/mobile/src/lib/purchases.ts:22-28`) と Turnstile (`src/lib/auth/turnstile.ts`) にある。on / off のスイッチは `'on'` だけを有効とみなす (`lib/legal-consent.ts:66-68` の `isLegalConsentFlagOn`) | 各ファイル |
| F-11 | service_role の client は `getSupabaseAdmin()` (`lib/supabase/server.ts:20-24`) だけで作る (`tests/supabase-service-role-client-scan.test.ts`)。新しい表は RLS を有効にし、既定の権限を `REVOKE ALL` で外す (`supabase/migrations/20261023130000_account_deletion_owner_guard.sql:58-67`)。migration を足したら `database.types.ts` 2 本を作り直す (`tests/database-types-migrations-contract.test.ts`) | 各ファイル |
| F-12 | プライバシーポリシーの委託先の表 `PRIVACY_PROCESSORS` に Google (OAuth) の行があり、`tests/legal-text-1901.test.ts` の T-33 は `PRIVACY_PROCESSORS` に `Apple` が無いことを確かめている (ストアの決済の事業者としての Apple を載せない趣旨。billing/03 Q-17)。第3条の「アカウント」の行と第10条の外部送信の表に Google の行がある。主張の表は `LEGAL_CLAIM_COUNT = 424`。版は両文書とも `v2026.3` | `src/lib/legal/privacy-text.ts:64-91, 209, 382`・`tests/legal-text-1901.test.ts:857-870`・`tests/legal-claims-1901.ts:25, 243, 330, 373`・`packages/shared/src/legal-versions.ts:53-54` |
| F-13 | 本番の `auth.identities` の provider は `email` だけ (194 件。2026-10-23 の SELECT)。`google`・`apple` は 0 件。Supabase の Apple provider の有効化・Apple Developer の設定は SELECT では分からない (オーナーの作業。§19) | 本番の読み取り (MCP の SELECT) |
| F-14 | Apple (一次情報): 4.8 の本文 (§0.1)。5.1.1(v) は退会をアプリの中で提供すること。Apple Developer News (2022-05-24)「If your app offers Sign in with Apple, you'll need to use the Sign in with Apple REST API to revoke user tokens when deleting an account」。失効の API は `POST https://appleid.apple.com/auth/revoke` (`client_id`・`client_secret`・`token`・`token_type_hint`。200 で本文なし。既に無効な token でも 200)。交換の API は `POST https://appleid.apple.com/auth/token` (`client_id`・`client_secret`・`code`・`grant_type=authorization_code`。`redirect_uri` は最初の認可で渡したときだけ。応答に `refresh_token`)。`client_secret` は ES256 の JWT (`kid` = Key ID・`iss` = Team ID・`aud` = `https://appleid.apple.com`・`sub` = `client_id`・`exp` は 6 か月 = 15,777,000 秒以内)。HIG: ボタンはほかのログインのボタンより小さくしない・スクロールしないと見えない位置に置かない・最小 140×30pt・題名は Sign in / Sign up / Continue with Apple だけ・自作のボタンは Apple Design Resources のロゴだけを使い題名の文字の大きさはボタンの高さの 43%。メールの中継 (`@privaterelay.appleid.com`) へ送るには送信ドメインを「Sign in with Apple for Email Communication」に登録し SPF (と DKIM) を通す。中継のアドレスは 1 日 100 通まで | developer.apple.com (guidelines・news・HIG・REST API・private email relay の各ページ) |
| F-15 | Supabase (一次情報): ネイティブは `expo-apple-authentication` の `signInAsync` → `identityToken` を `signInWithIdToken({ provider: 'apple', token })`。Dashboard の Client IDs は「Services ID を先頭、続けて bundle ID」(Web の OAuth は先頭の ID を使う。ネイティブはどれでもよい)。Secret Key (Web の OAuth 用) は 6 か月で切れるので入れ替える。名前は identity token に無く Apple が初回だけ返す (OAuth の経路は GoTrue が `user` パラメータから `full_name` に入れる。ネイティブは `updateUser` で保存する)。メールの中継は「Sign in with Apple for Email Communication」に送信元を登録。GoTrue: `id_token` の `aud` は Client IDs のどれか・nonce は「両方あるか両方無いか」で、あるときは raw の SHA-256 (小文字の hex) と `id_token` の `nonce` を比べる・provider が無効なら 400 `provider_disabled`。Apple の `id_token` の `email` は常に `Verified: true` として扱い、同じメールの既存の利用者に自動で結び付く (`DetermineAccountLinking`。既存の `email` / `google` の identity と同じ linking domain)。PKCE の交換 (`exchangeCodeForSession`) は flow state の `provider_refresh_token` を返す (provider が返したときだけ) | supabase.com/docs (auth-apple・auth-identity-linking)・github.com/supabase/auth (`token_oidc.go`・`provider/oidc.go`・`provider/apple.go`・`external.go`・`token.go`・`models/linking.go`) |
| F-16 | `expo-apple-authentication` (SDK 58): iOS だけ (Android・web は未対応)。`app.json` の `ios.usesAppleSignIn: true` で EAS Build が capability を入れる。`signInAsync({ requestedScopes, nonce, state })`・`isAvailableAsync()`・`AppleAuthenticationButton` (`buttonType` SIGN_IN / CONTINUE / SIGN_UP・`buttonStyle` WHITE / WHITE_OUTLINE / BLACK・`cornerRadius`・`style` に width と height が要る)。取り消しは `ERR_REQUEST_CANCELED`。`expo-crypto`: `randomUUID()`・`digestStringAsync(CryptoDigestAlgorithm.SHA256, data)` (既定は hex) | docs.expo.dev (apple-authentication・crypto) |

### 0.3 分冊判定

**1 冊 (本書)。実装は 4 段 (§15)。** 本書は 800 行を超え、消費先は 3 を超え (モバイルの画面 2・Web の画面 2・コールバック・退会)、共有面 (`src/lib/account-deletion.ts`・`src/lib/env.ts`・`packages/shared`・法務の文面と版) に 2 つ以上触るので、判定のトリガーには当たる。それでも分冊しないのは、核になるもの (Supabase の `apple` の identity とサーバに保管する refresh token・それを失効させる退会の段階) が 1 つで、iOS・Web の入口はその核に認可コード (またはコールバックの refresh token) を 1 本渡す配線に過ぎず、核だけを先にマージしても検証できるもの (ログインの入口) が無いためである。代わりに段を 4 つに分け、段ごとに 2 枚のレビューを挟む (§15)。

### 0.4 エージェントの作業とオーナーの作業

| 作業 | 誰が | 本書の節 |
|---|---|---|
| コード (サーバ・モバイル・Web・法務の文面)・テスト・migration・設計書 | エージェント (実装 WF) | §8〜§18 |
| Apple Developer: App ID の capability・Services ID・Key (.p8)・メールの中継の送信元の登録 | オーナー | §19.1 |
| Supabase Dashboard: Apple provider の有効化・Client IDs・Secret Key (6 か月ごとの入れ替え) | オーナー | §19.2 |
| Vercel / EAS の環境変数 (スイッチと秘密)・新しいビルド・実機の確認・ストアの提出 | オーナー (実機の確認はオーケストレーターと分担) | §19.3〜§19.5 |
| 本番の migration の適用 | オーケストレーター (追加だけ) | §15 |

### 0.5 本書の既定と、選択肢として残す点

本書は実装者が手を止めないよう、次を既定として決めて書く。別の案に変えるときの差分は §21 に書いてある。

| 論点 | 既定 (本書) | 別の案 (§21) |
|---|---|---|
| iOS の入口 | ネイティブのシート (`expo-apple-authentication`) + `signInWithIdToken` (§6 裁定 1) | ブラウザの OAuth (Google と同じ経路) |
| Android | 出さない (§6 裁定 1) | Web と同じ OAuth をブラウザで (Q-3) |
| Web | 出す (段 B。`signInWithOAuth({ provider: 'apple' })`) | アプリだけ (Q-1) |
| 退会のときの Apple のトークンの失効 | 行う。失敗しても退会は止めない (§6 裁定 2) | 失敗したら退会を止める・やり直しの列を持つ (Q-2) |
| 設定が無いとき | スイッチ (`EXPO_PUBLIC_APPLE_SIGN_IN` / `NEXT_PUBLIC_APPLE_SIGN_IN` = `on`) が無ければボタンを出さない (§6 裁定 3) | — |
| プライバシーポリシー | Apple を委託先の表に足し版を上げる (段 D)。アプリで Apple のログインを出す前に公開する | — |

## 1. 目的・スコープ

iOS のアプリに Sign in with Apple を足し、App Store の審査 (4.8) を通す。同じ利用者が Web でも Apple で入れるようにし (段 B)、退会のときに Apple 側の認可を失効させる (5.1.1(v) と Apple の要求)。既存の Google ログイン・メールとパスワードのログイン・セッションの保管・WebView のブリッジ・同意のゲートは変えない。

## 2. 関連要件

- App Store Review Guideline 4.8・5.1.1(v)・Apple Developer News 2022-05-24 (F-14)。
- `docs/design/cross/01-auth-session.md` §3.1「Apple Sign In: Phase 1 (iOS App Store 必須)」・§3.3「退会時: ソーシャル連携トークン全削除 + Google/Apple ドキュメント準拠で IdP 側 revoke」。
- `MOBILE_TODO.md:41` (ブロッカー 5)・`:186` (Pass 3)・`:193` (Pass 10)。
- `docs/design/cross/20-terms-privacy-text.md` §7 (委託先の表)・§9.3 (内容が変わる改定は版を上げる)・§10 (主張の表)。

## 3. 要件行列 (相 1)

| # | 要件 | 根拠 | 本書の答え |
|---|---|---|---|
| R-1 | iOS のログイン画面と新規登録画面に、Google と同等 (同じ大きさ以上・スクロール無しで見える) の Apple のボタンを置く | 4.8・HIG | §10.1: Google の上に同じ高さ (48pt) の `AppleAuthenticationButton` |
| R-2 | 取得するのは名前とメールだけ (`requestedScopes` = FULL_NAME・EMAIL) | 4.8 | §11.4 `signInWithApple` |
| R-3 | メールを隠す選択 (中継のアドレス) を受け入れ、別のメールを求めない | 4.8・HIG | §9.4: 中継のアドレスをそのまま登録のメールにする。設定画面はそのアドレスを表示 (F-7) |
| R-4 | ネイティブでは nonce で identity token の使い回しを防ぐ | GoTrue の nonce の規則 (F-15) | §11.4: raw = `randomUUID()`、Apple へ SHA-256 hex、Supabase へ raw |
| R-5 | Supabase のセッションにしたあとは、既存のログインと同じ振り分け・同意のゲート・購入の結び付け・端末名の登録が動く | F-2・F-3・cross/13b | §9.1: `routeAfterSignIn` を共有の関数に移して両画面から呼ぶ。`AuthProvider` は変えない |
| R-6 | 初回だけ来る名前を失わない | F-15 | §9.4: ネイティブは `updateUser({ data: { full_name, given_name, family_name } })` (既に `full_name` があれば上書きしない)。Web は GoTrue が `user` から入れる |
| R-7 | 同じメールの既存のアカウント (メール / Google) と自動で結び付く挙動を前提にし、壊さない | F-15 | §9.4・§7.1: 結び付いた利用者の `app_metadata.provider` は最初の provider のまま (設定画面の分岐は変えない) |
| R-8 | 退会のとき Apple のトークンを失効させる | 5.1.1(v)・Apple News・cross/01 §3.3 | §9.3: サーバが保管した refresh token を `/auth/revoke` へ。段階 `apple_revoke` を `delete_user` の直前に置く |
| R-9 | 失効に使う refresh token を得る: ネイティブは認可コードをサーバで交換、Web はコールバックの `provider_refresh_token` | F-14・F-15 | §9.2 `POST /api/auth/apple/authorization`・§9.5 コールバック |
| R-10 | 秘密 (.p8・Team ID・Key ID) はサーバだけが持ち、ログ・応答に出さない。refresh token は service_role だけが読める表に置く | 既存の規律 (#1172・#1182) | §8・§11.1〜11.3・§12 |
| R-11 | 設定が無いとき (Apple Developer・Supabase の作業の前) はボタンを出さない。案内もしない | 範囲の正本 | §6 裁定 3・§10 |
| R-12 | 本物の Apple・Supabase に繋がないで確かめる | 範囲の正本 | §14: `expo-apple-authentication`・`supabase.auth`・`fetch` を偽物にする |
| R-13 | Web のボタンは Apple のロゴと題名の規則に従う (題名は「Appleで続ける」「Appleで登録」。ロゴは Apple Design Resources のもの。文字の大きさは高さの 43%) | HIG | §10.2 |
| R-14 | Web の新規登録は同意のチェックを入れるまで Apple のボタンも押せない。ログイン画面の「はじめての方は…同意の画面が出ます」の案内は Apple にも掛かる | #1174・#1435 | §10.2 |
| R-15 | 環境変数は一覧と `.env.example` / `env.example` に書き、無いときの挙動を書く | F-10 | §13.2 |
| R-16 | プライバシーポリシーに Apple (ログイン) を委託先として載せ、版を上げる。アプリで Apple のログインが使えるようになる前に公開する | cross/20 §7・§9.3 | §15 段 D・§9.6 |
| R-17 | メールの中継のアドレスへ届くメール (確認・退会の完了・通知) のために送信ドメインを Apple に登録する | F-14 | §19.1 (オーナー) |
| R-18 | 新しい表・route・環境変数・依存は、既存の番兵 (契約テスト・走査テスト) が反応する形で足す | 既存の規律 | §17 |

## 4. ユーザーシナリオ (24 本)

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
| S-12 | ログインは成功したが、サーバの秘密 (Team ID など) が未設定 | ログインは成功。`POST /api/auth/apple/authorization` は 200 `{ stored: false, reason: 'not_configured' }`。refresh token は保管されない (退会のときは失効をスキップ。S-14) |
| S-13 | ログインは成功したが、交換の API が 5 分を過ぎた・通信できない | ログインは成功。route は 400 `APPLE_AUTHORIZATION_CODE_INVALID` または 500。アプリは `console.warn` だけで画面は進む |
| S-14 | Apple でログインした人が退会する (refresh token の行がある) | `apple_revoke`: 行ごとに `client_secret` を作り `/auth/revoke` を呼ぶ (200)。行は `deleteUser` の CASCADE で消える。退会は完了 (完了メール) |
| S-15 | 退会・Apple の API が落ちている | 2 回試して失敗 → `warn` のログ (request_id・段階)。退会は続けて完了する |
| S-16 | 退会・行が無い (S-12 の人・Google だけの人) | Apple を呼ばずに `delete_user` へ |
| S-17 | Web のログイン画面で「Appleで続ける」(初めての人) | `/auth/v1/authorize?provider=apple` → Apple → Supabase → `/auth/callback?provider=apple&code=…` → `exchangeCodeForSession` → 初めてなので同意画面 (#1435)。`provider_refresh_token` があり identity に `apple` があれば Services ID の行として保管 |
| S-18 | Web の新規登録画面・同意のチェック無しで Apple のボタン | 押せない (`disabled`)。`signInWithOAuth` は呼ばれない |
| S-19 | Web・スイッチ無し | Apple のボタンは出ない。Google のボタンと案内は今までどおり |
| S-20 | Web・2 回目 | ホーム (`/home`) へ。保管の行を上書き |
| S-21 | iPhone でログインしたあと WebView のタブを開く | 既存のブリッジ (`/auth/native-bridge`) でそのまま入れる (変えない) |
| S-22 | 中継のアドレスの人に退会の完了メール・プッシュの代わりのメールを送る | 送信ドメインを Apple に登録していれば届く。未登録なら Apple が拒む (オーナーの作業 §19.1 の 4) |
| S-23 | 利用者が iPhone の設定で「Apple でサインインの使用を停止」したあと、もう一度 Apple で入る | Apple は初回として名前・メールを返し、新しい認可コードを発行。`sub` は同じなので Supabase は既存の利用者。古い refresh token は Apple 側で無効 (失効しても 200)。新しいコードを交換して行を上書き |
| S-24 | identity token の nonce が合わない (改ざん・別のリクエストの token) | `signInWithIdToken` が失敗 → 固定の文。セッションは作られない |

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
    revocation.ts  … 退会の段階 apple_revoke (差し替え口 AccountDeletionAppleRevocation)
  退会 deleteAccount: … billing_recheck → apple_revoke → delete_user (CASCADE で行も消える)
```

- 核は「Supabase の `apple` の identity」と「サーバに保管した refresh token を退会で失効させる段階」。iOS と Web はその核へ refresh token の元 (認可コード / `provider_refresh_token`) を渡す配線。
- スイッチは 2 つ (`EXPO_PUBLIC_APPLE_SIGN_IN`・`NEXT_PUBLIC_APPLE_SIGN_IN`。値 `on` だけ有効。読み方は `packages/shared` の `isAppleSignInFlagOn` 1 つ)。サーバの秘密が無いときは交換・失効をしないだけで、ログインは止めない (S-12)。

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
| S-13 | `/auth/token` が 400 `invalid_grant` → `{ ok: false, reason: 'invalid_code' }` → route 400 `APPLE_AUTHORIZATION_CODE_INVALID`。通信の失敗 (timeout) → `{ ok: false, reason: 'unavailable' }` → `internalError` 500。アプリ: `catch` → `console.warn` → `routeAfterSignIn` は先に済んでいる (順は 名前 → 登録 → 振り分け。登録の失敗で振り分けを止めない) | 一致 |
| S-14 | `deleteAccount`: … `billing_recheck` → `step = 'apple_revoke'` → `appleRevocation.revokeForAccountDeletion(userId, userLog, requestId)`: `listAppleRefreshTokens` 1 行 → config → `client_secret` (sub = 行の client_id) → `/auth/revoke` 200 → `{ tokens: 1, revoked: 1, failed: 0 }` → `delete_user` → CASCADE で行が消える → 完了メール | 一致 |
| S-15 | `/auth/revoke` が timeout ×2 → `failed: 1` → `warn` → `delete_user` へ (投げない) | 一致 |
| S-16 | `listAppleRefreshTokens` 0 行 → `{ tokens: 0, … }` → Apple を呼ばない | 一致 |
| S-17 | `handleAppleLogin` → `signInWithOAuth({ provider: 'apple', redirectTo })` → ブラウザが Supabase → Apple → Supabase → `/auth/callback?provider=apple&code=` → `exchangeCodeForSession` 200 → `storeAppleRefreshTokenFromWebCallback`: `provider === 'apple'` かつ `session.provider_refresh_token` かつ identities に `apple` かつ Services ID あり → upsert (user_id, Services ID) → 既存の分岐 (profile 無し → `resolveFirstSignInDestination` → `/legal-consent`) | 一致 |
| S-18 | `disabled={isLoading \|\| !agreedToLegal}` と `handleAppleSignup` の先頭の `if (!agreedToLegal)` の 2 重 | 一致 |
| S-19 | `isAppleSignInEnabled()` = false → ボタンを描かない | 一致 |
| S-20 | S-17 の `next = '/home'` | 一致 |
| S-21 | 既存の経路 (`05-auth-session.md` §6)。本書は触らない | 一致 |
| S-22 | 送信は既存の `email_outbox` (Resend)。Apple の中継が受け取るかは送信ドメインの登録次第 (§19.1) | 一致 |
| S-23 | Apple が `fullName` を返す → `user_metadata.full_name` は既にある → 上書きしない。認可コードは新しい → upsert で上書き | 一致 |
| S-24 | GoTrue が `invalid nonce` (Nonces mismatch) → `signInWithIdToken` の `error` → `failed` | 一致 |

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
| R1 (採用) | ログインのとき (iOS: 認可コードの交換 / Web: `provider_refresh_token`) にサーバが refresh token を `apple_sign_in_tokens` に保管し、退会の `delete_user` の直前に `/auth/revoke` を呼ぶ。失敗は `warn` で続ける | Apple の要求 (F-14) を満たす。退会 (5.1.1(v)) を Apple の障害で止めない。表は CASCADE で消える | 失敗したトークンはそのまま消える (利用者は iPhone の設定から自分で停止できる。Apple の中継の停止も同じ場所) |
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
- refresh token の保管は 1 表 (`apple_sign_in_tokens`。PK = `(user_id, client_id)`)・失効は退会の段階 1 つ・失敗は止めない。
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
| iOS ログイン | on | iOS | 有効 | 中継のメール | 新規 (S-6) |
| iOS 新規登録 | (上の iOS ログインと同じ行) | | | | 同じ (S-11) |
| Android | どれでも | Android | — | — | ボタン無し (S-10) |
| Web ログイン | 無し | — | — | — | ボタン無し (S-19) |
| Web ログイン | on | — | 無効 | — | Apple の画面へ行かず Supabase が 400 の JSON を出す (スイッチは provider を有効にしてから入れる。§19.3) |
| Web ログイン | on | — | 有効 | 無し | 同意画面 (#1435)。`provider_refresh_token` があれば保管 (S-17) |
| Web ログイン | on | — | 有効 | 同じメール | 結び付け (GoTrue。iOS と同じ) |
| Web 新規登録 | on | 同意のチェック無し | — | — | 押せない (S-18) |
| Web 新規登録 | on | 同意のチェックあり | 有効 | 無し | S-17 と同じ |
| 退会 | — | 行あり・秘密あり | — | — | 失効 → 削除 (S-14) |
| 退会 | — | 行あり・Apple が落ちている | — | — | 2 回失敗 → warn → 削除 (S-15) |
| 退会 | — | 行あり・秘密なし | — | — | 失効をスキップ (warn) → 削除 |
| 退会 | — | 行なし | — | — | Apple を呼ばずに削除 (S-16) |

### 7.2 状態比較表 (現行 vs 設計後)

| 面 | 現行 | 設計後 |
|---|---|---|
| iOS ログイン画面のボタン | メールとパスワード・Google | メールとパスワード・**Apple (Google の上)**・Google。スイッチ無し / Android / 非対応端末では現行と同じ |
| iOS 新規登録画面のボタン | アカウント作成・Google で登録 | アカウント作成・**Apple で登録**・Google で登録 |
| ログインの後の振り分け | `login.tsx` の中の `routeAfterSignIn` | `apps/mobile/src/lib/routeAfterSignIn.ts` に移し `login.tsx`・`signup.tsx` (Apple) から呼ぶ。中身は同じ |
| モバイルの依存 | SDK 58 の 15 モジュール | + `expo-apple-authentication ~58.0.2`・`expo-crypto ~58.0.7` |
| `app.json` | `usesAppleSignIn` 無し | `ios.usesAppleSignIn: true`・`infoPlist.CFBundleAllowMixedLocalizations: true` |
| Web ログイン画面 | 「Googleで続ける」+ 案内 + メール | 「**Appleで続ける**」(スイッチ on) + 「Googleで続ける」+ 案内 (文は同じ) + メール |
| Web 新規登録画面 | 同意のチェック → 「Googleで登録」 | 同意のチェック → 「**Appleで登録**」(スイッチ on) + 「Googleで登録」 |
| `/auth/callback` | `code` の交換 → 振り分け | 同じ。`?provider=apple` のときだけ `provider_refresh_token` を保管 (失敗しても振り分けを変えない) |
| DB | — | 表 `apple_sign_in_tokens` (RLS 有効・利用者の権限なし) |
| API | — | `POST /api/auth/apple/authorization` |
| 退会の段階 | … `billing_recheck` → `delete_user` | … `billing_recheck` → **`apple_revoke`** → `delete_user` |
| 環境変数 | — | Web: `NEXT_PUBLIC_APPLE_SIGN_IN`・`APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY`・`APPLE_SIGN_IN_SERVICES_ID`。モバイル: `EXPO_PUBLIC_APPLE_SIGN_IN` |
| レート制限の種類 | 22 種 | + `auth-apple-authorization` (利用者ごと 5 回 / 10 分) |
| プライバシーポリシー | 委託先に Google (OAuth)。版 `v2026.3` | 委託先に **Apple (ログイン)**。第3条・第10条に Apple。版 `v2026.4` |
| 設定画面のアカウント | `apple` の表示名あり (使われていない) | 同じコードが Apple の利用者に使われる (変更なし) |

### 7.3 状態遷移表

(a) iOS の Apple のログイン (画面の状態 × 操作)

| 状態 | 操作 / 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `idle` (ボタンが押せる) | ボタンを押す | `sheet` | `isSubmitting` = false | `setIsSubmitting(true)`。nonce を作る。`signInAsync` を呼ぶ |
| `sheet` | 利用者が認可 | `exchanging` | `identityToken` がある | `signInWithIdToken` |
| `sheet` | 利用者が取り消し (`ERR_REQUEST_CANCELED`) | `idle` | — | 無し (アラートを出さない) |
| `sheet` | Apple の失敗 (ほかの `ERR_*`) | `idle` | — | `Alert("Appleログイン失敗", failed)` |
| `sheet` | `identityToken` が無い | `idle` | — | `Alert("Appleログイン失敗", noIdentityToken)` |
| `exchanging` | `signInWithIdToken` が error | `idle` | — | `Alert("Appleログイン失敗", failed)` |
| `exchanging` | 成功 | `after_sign_in` | — | `AuthProvider` が `SIGNED_IN` を受ける (購入の結び付け・端末名)。`fullName` があり `user_metadata.full_name` が無ければ `updateUser` |
| `after_sign_in` | `registerAppleAuthorization` (成功・失敗どちらでも) | `routed` | — | 失敗は `console.warn`。`routeAfterSignIn(next)` |
| `routed` | — | (画面を離れる) | — | `setIsSubmitting(false)` (finally) |

(b) refresh token の行 (`apple_sign_in_tokens` の (user_id, client_id))

| 状態 | 操作 / 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `none` | iOS のログイン → route の交換が成功 | `stored` | 秘密あり・identity に `apple` | upsert (`client_id` = bundle ID) |
| `none` | Web のコールバック (`provider=apple`) | `stored` | `provider_refresh_token` あり・identity に `apple`・Services ID あり | upsert (`client_id` = Services ID) |
| `none` | 秘密なし / 交換の失敗 / `provider_refresh_token` なし | `none` | — | ログ (`info` / `warn`) |
| `stored` | 同じ入口でもう一度ログイン | `stored` | — | `refresh_token`・`updated_at` を上書き |
| `stored` | 退会 `apple_revoke` の成功 | `revoked` | 秘密あり | `/auth/revoke` 200 |
| `stored` | 退会 `apple_revoke` の失敗 (2 回) | `stored` (直後に消える) | — | `warn` |
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

## 8. データモデル

### 8.1 表 `apple_sign_in_tokens` (新設)

Apple が発行した refresh token を、退会のときに失効させるためだけに保管する。利用者は読めず、書けない (RLS 有効・ポリシー無し・`anon` / `authenticated` / `PUBLIC` の権限を外す)。読み書きは service_role の client (`getSupabaseAdmin()`) だけ。退会で `auth.users` の行が消えると CASCADE で消える。利用者へのデータの書き出し (`src/lib/account-export-tables.ts`) には含めない (本人に返す意味が無く、返すと失効に使える値が外へ出る)。

ファイル名は `supabase/migrations/<番号はマージ時に確定>_apple_sign_in_tokens.sql` (番号はマージの直前に origin/main の `supabase/migrations` の最大より大きい値で確定する)。対の戻し口は `supabase/rollbacks/<同じ番号>_apple_sign_in_tokens.down.sql`。

```sql
-- migration: <番号はマージ時に確定>_apple_sign_in_tokens.sql
-- 戻し方: supabase/rollbacks/<同じ番号>_apple_sign_in_tokens.down.sql
-- Sign in with Apple (docs/design/mobile/06-sign-in-with-apple.md §8): Apple が発行した refresh token を、退会のときに
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
  'Sign in with Apple の refresh token (退会のときの失効に使う。docs/design/mobile/06-sign-in-with-apple.md §8)。client_id は token を得た client (bundle ID / Services ID)。service_role だけが読み書きする。auth.users の削除で消える';
```

```sql
-- rollback: <同じ番号>_apple_sign_in_tokens.sql
-- Sign in with Apple の refresh token の表を外す。本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。
-- ⚠️ 先にアプリを戻すこと: src/lib/auth/apple/tokens.ts が表を読み書きする (無ければ保管と失効が失敗のログになるだけで、ログインと退会は止まらない)。
-- 影響: 保管していた refresh token は消え、その利用者の退会では Apple 側の失効を行えなくなる。
-- 何度流しても同じ結果になる (DROP ... IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS public.apple_sign_in_tokens;
```

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
| 500 | `internalError` (Apple に届かない・応答が壊れている・DB の失敗。本文は固定の文。ログに段階 `exchange` / `store`) |
| ヘッダ | `Cache-Control: private, no-store` |
| ログ | 認可コード・refresh token・secret は出さない。残すのは `request_id`・`client_id`・段階・Apple の HTTP status・`error` の値 (`invalid_grant` など。`error_description` は出さない) |

`runtime = 'nodejs'`・`dynamic = 'force-dynamic'`。`src/__tests__/api/null-character-routes.test.ts` の表に `auth/apple/authorization/route.ts` (POST) を足す。

### 9.3 退会の段階 `apple_revoke`

`deleteAccount` (`src/lib/account-deletion.ts`) の `billing_recheck` の後・`delete_user` の前に置く。差し替え口は Stripe (`params.billing`) と同じ形で `params.appleRevocation` (`AccountDeletionAppleRevocation`。既定は `defaultAccountDeletionAppleRevocation`)。

```mermaid
sequenceDiagram
    participant D as deleteAccount
    participant R as revocation.ts
    participant DB as apple_sign_in_tokens
    participant A as Apple /auth/revoke

    D->>R: revokeForAccountDeletion(userId, log, requestId)
    R->>DB: 行を全部読む (user_id)
    alt 行が無い
        R-->>D: { tokens: 0, revoked: 0, failed: 0, skipped: null }
    else 秘密が無い
        R-->>D: { tokens: n, revoked: 0, failed: 0, skipped: 'not_configured' } (warn)
    else
        loop 行ごと
            R->>A: POST (client_id = 行の client_id, client_secret(sub = client_id), token, token_type_hint = refresh_token)
            A-->>R: 200 (既に無効でも 200) / 失敗 → 1 回だけやり直し
        end
        R-->>D: { tokens: n, revoked: k, failed: n - k, skipped: null } (failed > 0 なら warn)
    end
    D->>D: step = 'delete_user' → auth.admin.deleteUser (CASCADE で行も消える)
```

- `revokeForAccountDeletion` は例外を投げない (中で全部受け止める)。退会の結果は変えない。
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
    A-->>G: /auth/v1/callback (form_post。初回だけ user = 名前)
    G-->>C: /auth/callback?provider=apple&code=…
    C->>G: exchangeCodeForSession(code)
    G-->>C: session (provider_refresh_token があれば) + user (identities)
    C->>DB: provider=apple かつ provider_refresh_token かつ identities に apple かつ Services ID あり → upsert (user_id, Services ID)
    C-->>U: 既存の振り分け (初めてなら同意画面 #1435)
```

- `redirectTo` に `provider=apple` を足すのは Web の Apple のボタンだけ (Google は変えない)。`/auth/callback` の既存の分岐 (`code` / `token_hash` / `token`・同意画面・`next`) は変えず、`code` の交換が成功したあとに `storeAppleRefreshTokenFromWebCallback` (§11.3) を 1 回呼ぶ。失敗は `warn` で振り分けを変えない。
- `provider_refresh_token` が無いとき (GoTrue が返さなかった。§21 Q-6) は保管しない (`info` のログ)。退会のときはその入口の失効をスキップする (iOS で入ったことのある人は iOS の行で失効する)。

### 9.6 プライバシーポリシー (段 D)

委託先の表に Apple (ログイン) を足し、第3条のアカウントの行と第10条の外部送信の表に Apple を足し、両文書の版を `v2026.4` に上げる (内容が変わる改定。cross/20 §9.3)。差分は §11.8。公開の順は §15 (段 D の公開 → スイッチを on にしたビルド / デプロイ)。

## 10. 画面

### 10.1 iOS (`apps/mobile/app/(auth)/login.tsx`・`signup.tsx`)

| 項目 | 内容 |
|---|---|
| 置き場所 | 「または」の区切りの下、Google のボタンの上 (HIG: 積むときは Apple を上に。R-1) |
| 部品 | `apps/mobile/src/components/auth/AppleSignInButton.tsx` (§11.5)。`AppleAuthentication.AppleAuthenticationButton` を使う (Apple の見た目・OS の言語の題名・VoiceOver の読み上げが付く) |
| 種類 | ログイン画面 `SIGN_IN` (題名は OS が「Apple でサインイン」)・新規登録画面 `SIGN_UP` (「Apple で登録」) |
| 見た目 | `buttonStyle` = `WHITE_OUTLINE` (白い背景 `colors.bg` の上。Google のボタンと同じ白の枠)・`cornerRadius` = `radius.lg`・高さ `APPLE_SIGN_IN_BUTTON_HEIGHT` = 48 (Google のボタンの実測の高さ 48 = `paddingVertical` 14 × 2 + 文字 20 と同じ。最小 30pt を満たす)・幅 100% (最小 140pt を満たす) |
| 出す条件 | `isAppleSignInEnabled()` (iOS かつスイッチ `on`) かつ `isAvailableAsync()` = true。満たさないときは何も描かない (余白も出さない) |
| 押せない条件 | `isSubmitting` (Google・メールと同じ。`pointerEvents="none"` + `opacity 0.7`) |
| 失敗の表示 | `Alert.alert("Appleログイン失敗", message)` / `Alert.alert("Apple登録失敗", message)` (Google の `"Googleログイン失敗"` と同じ形)。取り消しは何も出さない |
| testID | `login-apple-button`・`signup-apple-button` |

### 10.2 Web (`src/app/(auth)/login/page.tsx`・`signup/page.tsx`)

| 項目 | 内容 |
|---|---|
| 置き場所 | Google のボタンの上 (同じ `space-y-4` の中) |
| 部品 | `src/components/auth/AppleSignInButton.tsx` (§11.7)。自作のボタン (Apple の JS のボタンは Apple 自身の認可の流れに結び付くので使わない) |
| 題名 | ログイン画面「Appleで続ける」・新規登録画面「Appleで登録」(HIG の Continue / Sign up に当たる日本語。Google の「Googleで続ける」「Googleで登録」と対) |
| 見た目 | 黒い背景・白いロゴと文字 (HIG の Black。白い背景の上)。高さ 56px (`h-14`)・文字 24px (高さの 43%。HIG の例 56pt / 24pt)・太字・角丸 `rounded-xl` (Google と同じ)。ロゴは Apple Design Resources の「Sign in with Apple」のロゴ (白・SVG・ロゴと文字のボタン用の余白つき) を `public/auth/apple-logo-white.svg` に置き、高さをボタンと同じにする (切らない・上下の余白を足さない)。Google のボタンは `py-6` を `h-14` に変えて高さをそろえる (Apple のボタンをほかより小さくしない) |
| 出す条件 | `isAppleSignInEnabled()` (スイッチ `on`)。無ければ描かない |
| 押せない条件 | ログイン画面: `isLoading`。新規登録画面: `isLoading` または `!agreedToLegal` (Google と同じ。R-14) |
| 失敗の表示 | 既存の赤いバナー (`setError` / `setFormError`)。文は「Apple でのログインに失敗しました。しばらくしてからお試しください。」「Apple での登録に失敗しました。しばらくしてからお試しください。」 |
| 案内 | ログイン画面の `login-google-legal-note` (「はじめての方は、続けたあとに…同意の画面が出ます。」) は Apple と Google の両方の下に 1 つ (文は変えない。`data-testid` も変えない) |
| testID | `login-apple-button`・`signup-apple-button` |
| `?error=` | コールバックが `/login?error=` に戻す既存の経路はそのまま (Apple で `access_denied` などが来たときも同じ表示) |

### 10.3 設定画面のアカウント (変えない)

`providerLabel("apple")` = 「Apple」(F-7)。Apple だけの利用者には `ExternalProviderGuidance` が「Apple アカウントでログインしています」とメール (中継のアドレスを含む) を出す。結び付いた利用者 (`provider` = `email`) にはパスワードのフォームが出る。本書はコードを変えない。

## 11. 正典コード (Zod・型・定数・facade 契約)

書き方: `// tsc:skip` の無いブロックは単独で型検査を通る。新設モジュール同士の import や、まだ無い依存 (`expo-apple-authentication`・作り直す前の `database.types.ts`・一覧に足す前の `getOptionalEnv` の名前) を持つブロックは 1 行目を `// tsc:skip`、2 行目を `// place=<置き場所>` にする。実装者はその置き場所に置き、リポジトリ全体で `tsc` に掛ける。

### 11.1 共有の定数と文 (`packages/shared/src/apple-sign-in.ts`。新設)

Web とモバイルの両方が読む (`@homegohan/shared`)。`packages/shared/src/index.ts` に `export * from './apple-sign-in';` を足す。

```ts
/**
 * Sign in with Apple の共有の定数と固定の文 (docs/design/mobile/06-sign-in-with-apple.md §11.1)。
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
 * Sign in with Apple のサーバ側の設定 (docs/design/mobile/06-sign-in-with-apple.md §11.2)。サーバ専用 (秘密を持つ)。
 * 4 つの環境変数は任意 (src/lib/env.ts の一覧)。Team ID・Key ID・秘密鍵のどれかが無ければ「未設定」で、交換と失効を行わない
 * (ログインは止めない)。Services ID は Web の OAuth の行にだけ要る。
 */
import { getOptionalEnv } from '@/lib/env';

/** iOS のアプリの client_id (= apps/mobile/app.json の ios.bundleIdentifier。tests/apple-sign-in-config.test.ts が突き合わせる) */
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
/** Apple の API の応答を待つ最長 (ミリ秒)。ふだんは 1 秒以内。Turnstile の確認 (TURNSTILE_VERIFY_TIMEOUT_MS) と同じ 5 秒 */
export const APPLE_API_TIMEOUT_MS = 5000;
/** 失効の試行の回数 (1 回目が通信の失敗・5xx ならもう 1 回)。退会の応答を待たせ過ぎないよう 2 回まで */
export const APPLE_REVOKE_ATTEMPTS = 2;

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
 * Apple の client_secret (ES256 の JWT) を作る (docs/design/mobile/06-sign-in-with-apple.md §11.2。F-14 の形)。
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

### 11.3 Apple の REST と表の読み書き (`src/lib/auth/apple/rest.ts`・`tokens.ts`。新設)

```ts
// tsc:skip
// place=src/lib/auth/apple/schemas.ts
/**
 * Apple の交換・失効の API の応答の形 (docs/design/mobile/06-sign-in-with-apple.md §11.3)。
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
 * Apple の交換 (/auth/token) と失効 (/auth/revoke) の呼び出し (docs/design/mobile/06-sign-in-with-apple.md §11.3)。
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

async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(APPLE_API_TIMEOUT_MS),
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
    response = await postForm(fetchImpl, APPLE_TOKEN_ENDPOINT, {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      grant_type: 'authorization_code',
    });
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

/** refresh token を失効させる (token_type_hint=refresh_token)。200 は既に無効な token でも返る (F-14) */
export async function revokeAppleRefreshToken(
  input: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: FetchLike = fetch,
): Promise<AppleRevokeResult> {
  let response: Response;
  try {
    response = await postForm(fetchImpl, APPLE_REVOKE_ENDPOINT, {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      token: input.refreshToken,
      token_type_hint: 'refresh_token',
    });
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
 * 表 apple_sign_in_tokens の読み書き (docs/design/mobile/06-sign-in-with-apple.md §8・§11.3)。service_role の client だけが呼ぶ。
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
 * POST /api/auth/apple/authorization の本体 (docs/design/mobile/06-sign-in-with-apple.md §9.2)。
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
  const clientSecret = createAppleClientSecret({
    teamId: config.teamId,
    keyId: config.keyId,
    privateKeyPem: config.privateKeyPem,
    clientId: APPLE_SIGN_IN_NATIVE_CLIENT_ID,
    issuedAtSeconds: issuedAt,
    ttlSeconds: APPLE_CLIENT_SECRET_TTL_SECONDS,
  });
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
 * (docs/design/mobile/06-sign-in-with-apple.md §9.2)。
 * 1. rejectNullCharacterBody → readJsonBody + AppleAuthorizationBodySchema (違えば 400 VALIDATION_ERROR)
 * 2. requireSessionUser (Bearer。user_profiles の行が無い新規の利用者も通る) → checkRateLimit(user.id, 'auth-apple-authorization') (429)
 * 3. identities に apple が無ければ 409 APPLE_IDENTITY_NOT_LINKED
 * 4. registerAppleAuthorization → 200 { stored } / 400 APPLE_AUTHORIZATION_CODE_INVALID / 500 (internalError)
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
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
/** 利用者に見せる固定の文 (英文の生のエラーは出さない) */
const VALIDATION_MESSAGE = '入力の形が正しくありません。';
const CODE_INVALID_MESSAGE = 'Apple の認可の情報が有効ではありません。もう一度ログインしてください。';
const NOT_LINKED_MESSAGE = 'このアカウントは Apple でログインしていません。';

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  const read = await readJsonBody(request);
  if (!read.ok) return json({ error: VALIDATION_MESSAGE, code: 'VALIDATION_ERROR' }, HTTP_BAD_REQUEST);
  const parsed = AppleAuthorizationBodySchema.safeParse(read.body);
  if (!parsed.success) return json({ error: VALIDATION_MESSAGE, code: 'VALIDATION_ERROR' }, HTTP_BAD_REQUEST);

  const requestId = generateRequestId();
  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    const limit = await checkRateLimit(ctx.user.id, 'auth-apple-authorization');
    if (!limit.success) return rateLimitExceededResponse(limit);
    if (!hasAppleIdentity(ctx.user)) return json({ error: NOT_LINKED_MESSAGE, code: 'APPLE_IDENTITY_NOT_LINKED' }, HTTP_CONFLICT);

    const log = createLogger(ROUTE_NAME, requestId).withUser(ctx.user.id);
    const result = await registerAppleAuthorization({
      admin: getSupabaseAdmin(),
      userId: ctx.user.id,
      authorizationCode: parsed.data.authorization_code,
    });
    switch (result.status) {
      case 'stored':
        return json({ stored: true }, 200);
      case 'not_configured':
        log.info('apple authorization: server config is missing; refresh token not stored', { request_id: requestId });
        return json({ stored: false, reason: 'not_configured' }, 200);
      case 'invalid_code':
        log.warn('apple authorization: apple rejected the authorization code', {
          request_id: requestId,
          apple_status: result.appleStatus,
          apple_error: result.appleError,
        });
        return json({ error: CODE_INVALID_MESSAGE, code: 'APPLE_AUTHORIZATION_CODE_INVALID' }, HTTP_BAD_REQUEST);
      case 'unavailable':
        return internalError(ROUTE_NAME, new Error('apple token endpoint unavailable'), {
          userId: ctx.user.id,
          requestId,
          step: 'exchange',
          apple_status: result.appleStatus,
          apple_error: result.appleError,
        });
      case 'store_failed':
        return internalError(ROUTE_NAME, result.error, { userId: ctx.user.id, requestId, step: 'store' });
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
 * 退会の段階 apple_revoke (docs/design/mobile/06-sign-in-with-apple.md §9.3)。
 * 保管している refresh token を行ごとに失効させる。例外を投げない (退会の結果を変えない)。失敗は warn のログ。
 */
import { createAppleClientSecret } from './client-secret';
import { APPLE_CLIENT_SECRET_TTL_SECONDS, APPLE_REVOKE_ATTEMPTS, readAppleSignInServerConfig } from './config';
import { revokeAppleRefreshToken, type FetchLike } from './rest';
import { listAppleRefreshTokens, type AppleTokenStore } from './tokens';

/** 退会の本体 (deleteAccount) が受け取る報告 (成功のログの metadata に載る) */
export interface AppleRevocationReport {
  readonly tokens: number;
  readonly revoked: number;
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

const MS_PER_SECOND = 1000;

export function createAccountDeletionAppleRevocation(
  deps: { admin: () => AppleTokenStore; fetchImpl?: FetchLike; now?: () => Date },
): AccountDeletionAppleRevocation {
  return {
    async revokeForAccountDeletion(userId, log, requestId) {
      let rows: Awaited<ReturnType<typeof listAppleRefreshTokens>>;
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
      let revoked = 0;
      for (const row of rows) {
        const clientSecret = createAppleClientSecret({
          teamId: config.teamId,
          keyId: config.keyId,
          privateKeyPem: config.privateKeyPem,
          clientId: row.client_id,
          issuedAtSeconds: Math.floor((deps.now?.() ?? new Date()).getTime() / MS_PER_SECOND),
          ttlSeconds: APPLE_CLIENT_SECRET_TTL_SECONDS,
        });
        let ok = false;
        for (let attempt = 1; attempt <= APPLE_REVOKE_ATTEMPTS && !ok; attempt += 1) {
          const result = await revokeAppleRefreshToken(
            { clientId: row.client_id, clientSecret, refreshToken: row.refresh_token },
            deps.fetchImpl,
          );
          ok = result.ok;
          if (!result.ok && attempt === APPLE_REVOKE_ATTEMPTS) {
            log.warn('account deletion: apple token revocation failed (deletion continues)', {
              request_id: requestId,
              step: 'apple_revoke',
              client_id: row.client_id,
              apple_status: result.status,
              apple_error: result.error,
            });
          }
        }
        if (ok) revoked += 1;
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

ファイル冒頭の流れの注に「4'''. 段階 apple_revoke: Sign in with Apple の refresh token を失効させる (docs/design/mobile/06-sign-in-with-apple.md §9.3)。失敗しても退会は続ける (warn)」の行を足す。

### 11.5 モバイル (`apps/mobile`)

```ts
// tsc:skip
// place=apps/mobile/src/lib/routeAfterSignIn.ts
/**
 * ログインの後の振り分け (docs/design/mobile/06-sign-in-with-apple.md §9.1)。
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
 * Sign in with Apple (iOS のネイティブのシート) → Supabase のセッション (docs/design/mobile/06-sign-in-with-apple.md §9.1・§11.5)。
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
 * Apple のログインのボタン (docs/design/mobile/06-sign-in-with-apple.md §10.1)。
 * OS が描く AppleAuthenticationButton (Apple の見た目・言語・VoiceOver) を使う。出す条件 (iOS・スイッチ・端末の対応) を満たさないときは何も描かない。
 */
import * as AppleAuthentication from "expo-apple-authentication";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { isAppleSignInAvailable } from "../../lib/appleSignIn";
import { radius } from "../../theme";

/** ボタンの高さ (pt)。Google のボタン (paddingVertical 14 × 2 + 文字 20) と同じ。HIG の最小 30pt を満たす */
export const APPLE_SIGN_IN_BUTTON_HEIGHT = 48;
/** 押せないときの薄さ (Google のボタンの pressed / isSubmitting と同じ 0.7) */
const DISABLED_OPACITY = 0.7;

export type AppleSignInButtonKind = "sign_in" | "sign_up";

const BUTTON_TYPE: Record<AppleSignInButtonKind, AppleAuthentication.AppleAuthenticationButtonType> = {
  sign_in: AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN,
  sign_up: AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP,
};

export function AppleSignInButton(props: { kind: AppleSignInButtonKind; onPress: () => void; disabled: boolean; testID: string }) {
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
        style={{ width: "100%", height: APPLE_SIGN_IN_BUTTON_HEIGHT }}
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
import { AppleSignInButton } from "../../src/components/auth/AppleSignInButton";
import { signInWithApple } from "../../src/lib/appleSignIn";
import { routeAfterSignIn } from "../../src/lib/routeAfterSignIn";
// 画面の中の routeAfterSignIn (76-100 行) は消し、呼ぶ所 (Google の 118 行・メールの 221 行) を routeAfterSignIn(next) に替える

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
<AppleSignInButton kind="sign_in" onPress={onAppleLogin} disabled={isSubmitting} testID="login-apple-button" />
```

`apps/mobile/app/(auth)/signup.tsx` の差分: 同じ import と `onAppleSignup` (Alert の題は `"Apple登録失敗"`、失敗の文は `outcome.message` のまま)。`signInWithApple` の失敗の文はログイン・登録で共通 (`APPLE_SIGN_IN_MESSAGES.failed`)。`routeAfterSignIn(undefined)` を呼ぶ (新規登録画面には `?next=` が無い)。JSX は `<AppleSignInButton kind="sign_up" onPress={onAppleSignup} disabled={isSubmitting} testID="signup-apple-button" />` を Google の前に置く。Google 登録の既存の処理 (`router.replace("/auth/verify")`) は変えない。

`apps/mobile/package.json`: `"expo-apple-authentication": "~58.0.2"`・`"expo-crypto": "~58.0.7"` を `dependencies` に足す (アルファベット順。版は SDK 58 の表のとおり。`tests/mobile-toolchain-contract.test.ts`)。`package-lock.json` はテスト用の機械で作り直して持ち帰る (05 §9.13 の段 1 と同じ形: `offload --no-install --fetch apps/mobile/package.json --fetch package-lock.json -- bash -c 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund -w apps/mobile expo-apple-authentication@58.0.2 expo-crypto@58.0.7'`。2 つはルートに巻き上がる (入れ子は react と @types/react だけ、の契約のまま))。

`apps/mobile/app.json`: `ios.usesAppleSignIn: true` (EAS Build が Sign In with Apple の capability と entitlement `com.apple.developer.applesignin` を入れる) と `ios.infoPlist.CFBundleAllowMixedLocalizations: true` (OS のボタンの題名を端末の言語にする。Expo の注) を足す。`plugins` には足さない (どちらか 1 つで足りる。Expo の注)。`runtimeVersion` は `fingerprint` のまま (指紋が変わるので新しいビルドが要る)。

`apps/mobile/env.example` に足す:

```
# Sign in with Apple (docs/design/mobile/06-sign-in-with-apple.md)。iOS のログイン・新規登録の画面に Apple のボタンを出すスイッチ。
# on のときだけ出す (大文字小文字と前後の空白は区別しない)。未設定・ほかの値なら出さない (Supabase の Apple provider と Apple Developer の設定が済むまでは入れない)。
# Android には効かない (出さない)。ビルド時に埋め込まれるので、変えたら新しいビルドが要る。本番・preview ビルドでは EAS の環境変数に登録する。
EXPO_PUBLIC_APPLE_SIGN_IN=
```

### 11.6 Web (`src/`。段 B)

```ts
// tsc:skip
// place=src/lib/auth/apple-sign-in-flag.ts
/**
 * Web で Apple のボタンを出すか (docs/design/mobile/06-sign-in-with-apple.md §10.2)。NEXT_PUBLIC_APPLE_SIGN_IN が on のときだけ。
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
 * Web の Apple のボタン (自作。docs/design/mobile/06-sign-in-with-apple.md §10.2。HIG の「Creating a custom Sign in with Apple button」)。
 *  - 黒い背景に白いロゴと題名。題名は「Appleで続ける」「Appleで登録」だけ (HIG の Continue / Sign up に当たる日本語)
 *  - 高さ 56px・文字 24px (高さの 43%)・ロゴの高さ = ボタンの高さ (ロゴの画像は余白込み。切らない)
 *  - ロゴは Apple Design Resources の「Sign in with Apple」の白いロゴ (SVG) を public/auth/apple-logo-white.svg に置く
 */
import Image from 'next/image';

/** ボタンの高さ (px)。Google のボタンも同じ高さにそろえる (Apple のボタンをほかより小さくしない) */
export const APPLE_SIGN_IN_BUTTON_HEIGHT_PX = 56;
/** 題名の文字の大きさ (px) = 高さの 43% (HIG の例: 56pt / 24pt) */
export const APPLE_SIGN_IN_BUTTON_FONT_PX = 24;
export const APPLE_LOGO_SRC = '/auth/apple-logo-white.svg';

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

`src/app/(auth)/login/page.tsx` の差分:

```tsx
// tsc:skip
// place=src/app/(auth)/login/page.tsx (差分)
import { AppleSignInButton } from '@/components/auth/AppleSignInButton';
import { isAppleSignInEnabled } from '@/lib/auth/apple-sign-in-flag';

/** Apple のログインの失敗の文 (固定) */
const APPLE_LOGIN_FAILED_MESSAGE = 'Apple でのログインに失敗しました。しばらくしてからお試しください。';

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
    setError(APPLE_LOGIN_FAILED_MESSAGE);
  } finally {
    setIsLoading(false);
  }
};

// JSX: Google のボタンの前
{isAppleSignInEnabled() && (
  <AppleSignInButton kind="continue" onClick={handleAppleLogin} disabled={isLoading} loading={isLoading} testId="login-apple-button" />
)}
// Google のボタンの className の py-6 を h-14 に替える (高さ 56px)
```

`src/app/(auth)/signup/page.tsx` の差分: `handleAppleSignup` (先頭に `if (!agreedToLegal) { setFormError(LEGAL_AGREEMENT_REQUIRED_MESSAGE); return; }`。`redirectTo` は `buildCallbackUrl()` に `provider=apple` を足した URL。失敗の文は `'Apple での登録に失敗しました。しばらくしてからお試しください。'`)。JSX は Google のボタンの前に `<AppleSignInButton kind="sign_up" onClick={handleAppleSignup} disabled={isLoading || !agreedToLegal} loading={isLoading} testId="signup-apple-button" />` (スイッチが on のときだけ)。Google のボタンの `py-6` を `h-14` に替える。

```ts
// tsc:skip
// place=src/lib/auth/apple/web-callback.ts
/**
 * Web の OAuth (段 B) のコールバックで、Apple の refresh token を保管する (docs/design/mobile/06-sign-in-with-apple.md §9.5)。
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

/** /auth/callback の ?provider= の値のうち、保管の対象 */
export const APPLE_CALLBACK_PROVIDER = 'apple';

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

`src/app/(auth)/auth/callback/route.ts` の差分: `code` の交換 (`:72-83`) の `if (!error)` の中、`recordWebLoginContextFromRequest` の後に `await storeAppleRefreshTokenFromWebCallback({ provider: requestUrl.searchParams.get('provider'), user: data.user, session: data.session, log: createLogger('GET /auth/callback', requestId), requestId })` を足す (`requestId` は `generateRequestId()` で route の先頭で 1 つ作る)。`provider` の値はログに出してよい (秘密ではない)。ほかの分岐 (`token_hash`・`token`・同意画面・`next`) は変えない。

### 11.7 環境変数 (`src/lib/env.ts`・`.env.example`)

```ts
// tsc:skip
// place=src/lib/env.ts (差分。PUBLIC_ENV_VARS と SERVER_ENV_VARS に足す行)
// PUBLIC_ENV_VARS (NEXT_PUBLIC_TURNSTILE_SITE_KEY の後):
  NEXT_PUBLIC_APPLE_SIGN_IN: {
    required: false,
    description:
      "Web のログイン・新規登録の画面に Apple のボタンを出すスイッチ (docs/design/mobile/06-sign-in-with-apple.md)。'on' のときだけ出す。" +
      'Supabase の Apple provider と Apple Developer の Services ID の設定が済んでから入れる。ビルド時に埋め込まれるので、変えたら再デプロイする',
    whenMissing: 'Apple のボタンを出さない (今までどおり)',
  },
// SERVER_ENV_VARS (末尾):
  APPLE_SIGN_IN_TEAM_ID: {
    required: false,
    description: 'Apple Developer の Team ID (10 文字)。Sign in with Apple の client_secret の iss (docs/design/mobile/06-sign-in-with-apple.md §11.2)',
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

`.env.example` には 5 つを値を空にして書く (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` の後に `NEXT_PUBLIC_APPLE_SIGN_IN=`、サーバの節に 4 つ。秘密鍵の書き方 (1 行・改行は `\n`) をコメントに書く)。`src/__tests__/lib/env.test.ts:371` の `publicNames` の一覧に `NEXT_PUBLIC_APPLE_SIGN_IN` を足す。

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

`PRIVACY_PROCESSORS` の注の「ストアの事業者 (Apple・Google) は委託先ではないので載せない (第3条に書く。billing/03 Q-17)」を「ストアの決済の事業者としての Apple・Google は委託先ではないので載せない (第3条に書く。billing/03 Q-17)。ログインの事業者としての Google・Apple は載せる (mobile/06 §11.8)」に書き換える。

(b) 第3条の「アカウント」の行: `'メールアドレス、パスワード（ハッシュ化して保存します）、Google アカウントで登録した場合に Google から受け取る情報、生年月日、ニックネーム、ご利用のプラン'` → `'メールアドレス、パスワード（ハッシュ化して保存します）、Google アカウントまたは Apple アカウントで登録した場合に Google または Apple から受け取る情報（Apple でメールアドレスを隠す選択をした場合は転送用のアドレス、Apple でのログインを退会のときに解除するためのトークンを含みます）、生年月日、ニックネーム、ご利用のプラン'`。

(c) 第10条の外部送信の表: `Google（ログインの画面）` の行の直後に `['Apple（ログインの画面）', 'Apple のログイン画面で Apple が取得する情報', 'Apple アカウントでのログイン']` を足す。

(d) 主張の表 `tests/legal-claims-1901.ts`: `privacy-3#3` の `chars` を (b) の文字数に直し、`evidence` に `apps/mobile/src/lib/appleSignIn.ts` を足す。`privacy-7` と `privacy-10` に 1 行ずつ足す (`id` はその節の既存の最大の番号の次。`fragment` は `'Apple | アメリカ合'`・`'Apple（ログインの画面'`。`chars` は T-35 の文脈で数えた文字数。`basis: 'product'`。`evidence: 'F-16・apps/mobile/src/lib/appleSignIn.ts・src/app/(auth)/login/page.tsx'`)。`LEGAL_CLAIM_COUNT` を 424 → **426**。

(e) `tests/legal-text-1901.test.ts` T-33: `expect(names).not.toContain('Apple');` を、ログインの事業者としての Apple は載り、決済の事業者としては載らないことの確認に替える:

```ts
// tsc:skip
// place=tests/legal-text-1901.test.ts (T-33 の中。expect(names).not.toContain('Apple') を置き換える)
    const apple = PRIVACY_PROCESSORS.find((p) => p.name === 'Apple');
    expect(apple?.purpose, 'Apple はログインの事業者として載る (mobile/06 §11.8)').toBe('Apple アカウントでのログイン');
    for (const word of LEGAL_TEXT_PAID_TERMS) expect(`${apple?.purpose} ${apple?.data}`).not.toContain(word);
```

T-34 の `PRIVACY_DATA_TABLES` に `apple_sign_in_tokens` → `'アカウント'` を足す (段 A1 で表が増えた時点で足す。T-34 は migration の表を数えるので、段 A1 のテストが赤にならないように段 A1 に含める)。

(f) 版: `packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS` の 2 文書を `v2026.3` → **`v2026.4`** (`effectiveDate` は仮の実在する日付を置き、行末に `// 仮置き: マージ直前に公開日へ置き換える` を付ける。オーケストレーターがマージの直前に公開日へ置き換えて目印を消す。billing/03 §11.6 と同じ)。ファイル先頭の注と `LEGAL_DOCUMENTS` の JSDoc に「v2026.4 は mobile/06 (Sign in with Apple) で委託先に Apple (ログイン) を足した版。改定前の版 (v2026.3) の文面は docs/legal/archive/v2026.3/ に控えてある」の段落を足す。利用規約の本文は変えないが、両文書の版は同じ値で動かす (既存の 3 回の改定と同じ)。

(g) 旧版の控え: `docs/legal/archive/v2026.3/terms.md`・`privacy.md` を新設 (形は `docs/legal/archive/v2026.2/` と同じ。見出し・版 `v2026.3`・施行日 `2026-10-22`・控えの元・「この版は mobile/06 の版 v2026.4 に置き換わった…」の文・`---`・本文)。

(h) `src/__tests__/api/cron/push-outbox.test.ts` などに版 `v2026.3` の直書きがあれば `v2026.4` に直す (grep の語 `v2026.3`。§17)。

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
| 500 | `INTERNAL_ERROR` | (`internalError` の固定の文) | Apple に届かない・時間切れ・5xx・本文が壊れている (`step: 'exchange'`)、表に書けない (`step: 'store'`)、`user_profiles` を読めない |

### 12.3 Web (段 B)

| 出来事 | 画面 | 文 (固定) |
|---|---|---|
| `signInWithOAuth` が error を返した (まれ。URL を作れない) | 赤いバナー | Apple でのログインに失敗しました。しばらくしてからお試しください。 / Apple での登録に失敗しました。しばらくしてからお試しください。 |
| Apple で取り消した・拒否した (`access_denied` など) | Supabase → `/auth/callback?error=…` → `/login?error=…` (既存) | 既存のとおり `error_description` をそのまま (本書は変えない。§21 Q-7) |
| `code` の交換の失敗 | 既存 (`/login`) | — |
| refresh token の保管の失敗 | 影響なし (振り分けは既存のまま) | — (`warn`) |

### 12.4 退会 (`apple_revoke`)

| 出来事 | 退会 | ログ |
|---|---|---|
| 行が無い | 続く | なし |
| 秘密が無い | 続く | `warn` (`skipped: 'not_configured'`・行数) |
| 表を読めない | 続く | `warn` (`error_name`) |
| Apple が 200 | 続く | なし (成功のログの `apple.revoked`) |
| Apple が 4xx / 5xx / 時間切れ (2 回) | 続く | `warn` (`client_id`・`apple_status`・`apple_error`) |

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
| `APPLE_API_TIMEOUT_MS` | 5000 | 同上 | Turnstile の確認と同じ。運用で変える想定が無いので環境変数にしない |
| `APPLE_REVOKE_ATTEMPTS` | 2 | 同上 | 退会の応答 (route の `maxDuration` 60 秒) を待たせない |
| `APPLE_SIGN_IN_BUTTON_HEIGHT` | 48 (pt) | `apps/mobile/src/components/auth/AppleSignInButton.tsx` | Google のボタンの高さと同じ。HIG の最小 30pt |
| `APPLE_SIGN_IN_BUTTON_HEIGHT_PX` / `APPLE_SIGN_IN_BUTTON_FONT_PX` | 56 / 24 | `src/components/auth/AppleSignInButton.tsx` | HIG の 43% (56pt / 24pt の例) |
| レート制限 `auth-apple-authorization` | 5 回 / 10 分 (利用者ごと) | `src/lib/rate-limit.ts` | `auth-password-change` と同じ。ログイン 1 回につき 1 回 |

### 13.2 環境変数

| 名前 | 場所 | 必須 | 無いとき |
|---|---|---|---|
| `EXPO_PUBLIC_APPLE_SIGN_IN` | EAS (ビルド時)。`apps/mobile/env.example` | 任意 | iOS に Apple のボタンを出さない |
| `NEXT_PUBLIC_APPLE_SIGN_IN` | Vercel (ビルド時)。`src/lib/env.ts`・`.env.example` | 任意 | Web に Apple のボタンを出さない |
| `APPLE_SIGN_IN_TEAM_ID` / `APPLE_SIGN_IN_KEY_ID` / `APPLE_SIGN_IN_PRIVATE_KEY` | Vercel (サーバ)。`src/lib/env.ts`・`.env.example` | 任意 | 交換・失効をしない (ログイン・退会は止めない) |
| `APPLE_SIGN_IN_SERVICES_ID` | Vercel (サーバ) | 任意 | Web で入った人の refresh token を保管しない |

秘密の値 (`APPLE_SIGN_IN_PRIVATE_KEY`) は `.env.example` に値を書かない (`tests/no-committed-credentials.test.ts`)。

## 14. テスト (it の一覧)

本物の Apple・Supabase に繋がない。iOS は `expo-apple-authentication`・`expo-crypto`・`../../src/lib/supabase`・`../../src/lib/api` を `jest.mock`、サーバは `fetch` を引数で差し替え、表は `from` の偽物。

### 14.1 モバイル (jest。`apps/mobile/__tests__/`)

| ファイル | it |
|---|---|
| `lib/appleSignIn.test.ts` (新設) | `isAppleSignInEnabled: iOS かつ EXPO_PUBLIC_APPLE_SIGN_IN=on のときだけ true (ON・空白つきも true。空・off・Android は false)` / `isAppleSignInAvailable: 有効でも isAvailableAsync が false・投げたら false` / `signInWithApple: nonce は randomUUID を SHA-256 (hex) にして Apple へ、raw を Supabase へ渡す` / `requestedScopes は FULL_NAME と EMAIL` / `ERR_REQUEST_CANCELED は cancelled (Supabase を呼ばない・アラートの文を持たない)` / `ほかの Apple の失敗は failed (APPLE_SIGN_IN_MESSAGES.failed)` / `identityToken が無ければ failed (noIdentityToken)` / `signInWithIdToken の error は failed` / `初回 (fullName あり・user_metadata.full_name 無し) は updateUser({ data: { full_name, given_name, family_name } })` / `full_name が既にあれば updateUser を呼ばない` / `fullName が null なら updateUser を呼ばない` / `認可コードを POST /api/auth/apple/authorization に送る (Bearer は getApi が付ける)` / `登録の API が失敗しても signed_in (console.warn だけ)` / `authorizationCode が null なら API を呼ばない` |
| `lib/routeAfterSignIn.test.ts` (新設。login.test.tsx の 4-3 の振り分けの検査をこの関数に対して) | `?next= が / 始まりならそこへ` / `完了 → /(tabs)/home・開始済み → /onboarding/resume・未開始 → /onboarding/welcome` / `admin も同じ振り分け (#1122)` / `user が無ければ何もしない` |
| `components/AppleSignInButton.test.tsx` (新設) | `isAppleSignInAvailable が true なら AppleAuthenticationButton を描く (SIGN_IN / SIGN_UP・WHITE_OUTLINE・高さ 48)` / `false なら何も描かない` / `disabled のとき押せない (pointerEvents none)` |
| `auth/login.test.tsx` (追記) | `5-1. スイッチ on・iOS: Apple のボタン (login-apple-button) が Google の前にある` / `5-2. 押すと signInWithApple → signed_in → routeAfterSignIn (ホームへ)` / `5-3. cancelled はアラートを出さず画面に留まる` / `5-4. failed は Alert("Appleログイン失敗", 文)` / `5-5. スイッチ無し: ボタンが無い` / `5-6. ?next= は Apple でも効く`。既存の 4-1〜4-3 は `routeAfterSignIn` の移動後も緑のまま (`mockFrom` の形は同じ) |
| `auth/signup.test.tsx` (追記) | `4. スイッチ on: Apple で登録 (signup-apple-button) がある。押すと signInWithApple → routeAfterSignIn` / `5. failed は Alert("Apple登録失敗", 文)` / `6. スイッチ無し: 無い` |
| `lib/env-example.test.ts` (既存。自動) | `EXPO_PUBLIC_APPLE_SIGN_IN` が `env.example` にあること |

`expo-apple-authentication`・`expo-crypto` の正典のモック。`login.tsx`・`signup.tsx` を描くテストは、`AppleSignInButton.tsx` が読み込みのときに `AppleAuthenticationButtonType` を読む (`BUTTON_TYPE`) ので、スイッチ無しの画面のテストでもこの 2 つを `jest.mock` する (jest の native module の扱いに結果を依存させない)。`auth/turnstile-screens.test.tsx` はこの形のまま足す (期待値は変えない)。`auth/login.test.tsx`・`auth/signup.test.tsx`・`lib/appleSignIn.test.ts`・`components/AppleSignInButton.test.tsx` はこの形を土台に、it ごとに `mockResolvedValue` などで上書きする (部品のテストは `AppleAuthenticationButton` を props を描く偽物に替える)。列挙の値は文字列にする (本物の数値に意味は無く、テストは名前で比べる)。

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

### 14.2 サーバ (vitest)

| ファイル | it |
|---|---|
| `src/__tests__/lib/auth/apple/client-secret.test.ts` (新設) | `ES256 の JWT: header は { alg: 'ES256', kid }、payload は iss / iat / exp = iat + ttl / aud / sub` / `署名は node:crypto の verify (ieee-p1363) で検証できる (テスト用に生成した P-256 の鍵)` / `exp - iat が 6 か月 (15,777,000 秒) を超えない (APPLE_CLIENT_SECRET_TTL_SECONDS)` |
| `src/__tests__/lib/auth/apple/config.test.ts` (新設) | `APPLE_SIGN_IN_NATIVE_CLIENT_ID は apps/mobile/app.json の ios.bundleIdentifier と同じ` / `4 つのうち Team ID・Key ID・秘密鍵のどれかが無ければ null` / `秘密鍵の \n を改行に戻す` / `Services ID が無ければ servicesId は null (ほかはそろう)` |
| `src/__tests__/lib/auth/apple/rest.test.ts` (新設) | `exchange: form (client_id・client_secret・code・grant_type=authorization_code) を /auth/token へ POST し、200 の refresh_token を返す` / `redirect_uri を送らない` / `400 invalid_grant は invalid_code` / `ほかの 4xx・5xx・壊れた本文・例外 (時間切れ) は unavailable (error_description は結果に入れない)` / `revoke: token_type_hint=refresh_token で POST。200 は ok` / `失敗は status と error` / `AbortSignal.timeout(5000) を付ける` |
| `src/__tests__/lib/auth/apple/tokens.test.ts` (新設) | `store: upsert の onConflict は user_id,client_id` / `list: user_id で絞って client_id と refresh_token を返す` / `error は投げる` |
| `src/__tests__/lib/auth/apple/authorization.test.ts` (新設) | `not_configured なら Apple を呼ばない` / `secret の sub と client_id は bundle ID` / `invalid_code → status invalid_code` / `unavailable → unavailable` / `store の失敗 → store_failed (error を持つ)` / `成功 → stored (upsert の行)` / `hasAppleIdentity: provider apple があれば true` |
| `src/__tests__/lib/auth/apple/revocation.test.ts` (新設) | `行が無ければ Apple を呼ばず tokens 0` / `秘密が無ければ skipped not_configured と warn` / `行ごとに client_id を sub にした secret で revoke` / `失敗は 2 回まで試し、2 回目も失敗なら failed に数えて warn (投げない)` / `表の読み取りの失敗は warn して tokens 0` |
| `src/__tests__/lib/auth/apple/web-callback.test.ts` (新設) | `provider が apple でなければ skipped (何も読まない)` / `identities に apple が無ければ skipped` / `provider_refresh_token が無ければ info で skipped` / `Services ID が無ければ skipped` / `そろえば Services ID の行として store` / `store の失敗は warn で skipped (投げない)` |
| `src/__tests__/api/auth/apple-authorization.test.ts` (新設) | `本文の形が違えば 400 VALIDATION_ERROR (Supabase を作らない)` / `1,025 文字は 400` / `未認証は 401` / `凍結は 403` / `レート制限は 429` / `apple の identity が無ければ 409 APPLE_IDENTITY_NOT_LINKED (Apple を呼ばない)` / `not_configured は 200 { stored: false, reason }` / `invalid_code は 400 APPLE_AUTHORIZATION_CODE_INVALID` / `unavailable は 500 (本文は固定の文。ログに step exchange)` / `stored は 200 { stored: true }` / `Cache-Control: private, no-store` / `認可コードが応答・ログに出ない` |
| `tests/account-deletion.test.ts` (追記) | `apple_revoke は billing_recheck のあと deleteUser の前に 1 回呼ぶ (呼ぶ順の検査に足す)` / `失効の報告は成功のログの apple に載る` / `appleRevocation が無いときの既定の実装は params.admin で表を読む (偽の admin の from が返す行)`。既存の it は `appleRevocation` に偽物 (`{ revokeForAccountDeletion: async () => ({ tokens: 0, revoked: 0, failed: 0, skipped: null }) }`) を渡す共通の引数に足して緑のまま |
| `tests/apple-sign-in-tokens-migration-contract.test.ts` (新設) | `CREATE TABLE IF NOT EXISTS public.apple_sign_in_tokens (PK (user_id, client_id)・user_id は auth.users ON DELETE CASCADE)` / `ENABLE ROW LEVEL SECURITY と REVOKE ALL FROM PUBLIC, anon, authenticated がある` / `ポリシー・GRANT・UPDATE/INSERT が無い` / `SET LOCAL lock_timeout がある` / `戻し口は DROP TABLE IF EXISTS だけ` / `コメントに記録の無い決定の帰属の語が無い (tests/account-deletion-migration-contract.test.ts の規則 7 と同じ)` |
| `tests/auth-callback-apple-token.test.ts` (新設) | `?provider=apple で code の交換が成功すると storeAppleRefreshTokenFromWebCallback を session と user で呼ぶ` / `provider 無し (Google) では呼んでも skipped で、振り分けは変わらない` / `保管の失敗でも同意画面 / next への redirect は同じ` |
| `tests/login-apple-button.test.tsx` (新設) | `NEXT_PUBLIC_APPLE_SIGN_IN=on: 「Appleで続ける」が Google の前にある (login-apple-button)` / `押すと signInWithOAuth({ provider: 'apple', redirectTo: …/auth/callback?provider=apple })` / `?next= は redirectTo の next に入る` / `スイッチ無し: 無い` / `error のとき固定の文のバナー` / `login-google-legal-note は 1 つで文は変わらない (tests/login-google-legal-note.test.tsx も緑)` |
| `tests/signup-legal-consent.test.tsx` (追記) | `同意のチェック無し: Apple のボタンも disabled で、押しても signInWithOAuth を呼ばない` / `チェックあり: provider apple で呼ぶ` |
| `src/__tests__/lib/env.test.ts` (追記) | `NEXT_PUBLIC_APPLE_SIGN_IN が公開の一覧にある`・サーバの 4 つが任意 |
| `tests/legal-text-1901.test.ts` (段 D で改める) | T-33 の置き換え (§11.8 (e))・T-7 (evidence の実在)・T-24 (行数)・T-34 (`apple_sign_in_tokens` → アカウント)・T-35 (`LEGAL_CLAIM_COUNT` = 426) |

### 14.3 実機 (オーナー・オーケストレーター。§20)

シミュレータは `getCredentialStateAsync` で投げ、名前・メールの初回の挙動も実機と違う。Apple のシートは実機 (TestFlight か内部配布) で確かめる。

## 15. 段分けと触るファイル

4 段・4 PR。段ごとに敵対レビュー 2 枚 PASS → マージ。段 A1 → A2 → B は直列 (A2 は A1 の route を、B は A1 の lib を呼ぶ)。段 D は A1 のマージ後ならいつでも (B とは触るファイルが重ならない)。**公開の順**: 段 D のデプロイ (プライバシーポリシーに Apple が載る) → Vercel に `NEXT_PUBLIC_APPLE_SIGN_IN=on` (段 B のあと) / EAS に `EXPO_PUBLIC_APPLE_SIGN_IN=on` を入れたビルド → 提出。migration (追加だけ) は段 A1 のマージの前にオーケストレーターが本番へ当てる。

| 段 | 中身 | 触るファイル (新設は ★) | 完了条件 |
|---|---|---|---|
| A1 サーバ | 表・lib・route・退会の段階・環境変数・レート制限・共有の定数 | ★`supabase/migrations/<番号>_apple_sign_in_tokens.sql`・★`supabase/rollbacks/<番号>_apple_sign_in_tokens.down.sql`・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・★`packages/shared/src/apple-sign-in.ts`・`packages/shared/src/index.ts`・★`src/lib/auth/apple/config.ts`・★`client-secret.ts`・★`schemas.ts`・★`rest.ts`・★`tokens.ts`・★`authorization.ts`・★`revocation.ts`・★`src/app/api/auth/apple/authorization/route.ts`・`src/lib/account-deletion.ts`・`src/lib/rate-limit.ts`・`src/lib/env.ts`・`.env.example`・`src/lib/account-export-tables.ts` (除外に `apple_sign_in_tokens`)・テスト (§14.2 の新設 7 本 + `tests/account-deletion.test.ts`・`src/__tests__/api/null-character-routes.test.ts`・`src/__tests__/lib/env.test.ts`・`tests/legal-text-1901.test.ts` の T-34 の表・`tests/account-export-tables.test.ts`) | 全件緑。`tests/database-types-migrations-contract` が表を見つける。route が null-character の表にある。変更が 15 ファイルを超えるので、レビューは「lib + route」「退会 + migration」「環境変数 + 共有 + テスト」の分割パネル + 横断 1 枚 |
| A2 モバイル | iOS のボタンと流れ・振り分けの共有化・依存・`app.json` | `apps/mobile/package.json`・`package-lock.json`・`apps/mobile/app.json`・`apps/mobile/env.example`・★`apps/mobile/src/lib/appleSignIn.ts`・★`apps/mobile/src/lib/routeAfterSignIn.ts`・★`apps/mobile/src/components/auth/AppleSignInButton.tsx`・`apps/mobile/app/(auth)/login.tsx`・`apps/mobile/app/(auth)/signup.tsx`・`apps/mobile/app/onboarding/_layout.tsx` (注だけ。§18.1)・テスト (§14.1。既存の `apps/mobile/__tests__/auth/turnstile-screens.test.tsx` に §14.1 のモック) | `npx jest` 全件緑 (テスト用の機械)。`tests/mobile-toolchain-contract` が lock の巻き上げを認める。`expo install --check` が typescript 以外のずれを出さない |
| B Web | Web のボタンとコールバック | ★`src/lib/auth/apple-sign-in-flag.ts`・★`src/components/auth/AppleSignInButton.tsx`・★`public/auth/apple-logo-white.svg`・★`src/lib/auth/apple/web-callback.ts`・`src/app/(auth)/login/page.tsx`・`src/app/(auth)/signup/page.tsx`・`src/app/(auth)/auth/callback/route.ts`・`lib/legal-consent.ts` (注だけ。§18.1)・テスト (§14.2 の `web-callback`・`auth-callback-apple-token`・`login-apple-button`・`signup-legal-consent`) | 全件緑。`tests/login-google-legal-note`・`tests/auth-callback-legal-consent`・`tests/auth-turnstile-pages` が緑のまま |
| D 法務 | 委託先・第3条・第10条・主張の表・版・控え | `src/lib/legal/privacy-text.ts`・`tests/legal-claims-1901.ts`・`tests/legal-text-1901.test.ts`・`packages/shared/src/legal-versions.ts`・★`docs/legal/archive/v2026.3/terms.md`・★`privacy.md`・版の直書きのあるテスト (§17) | `tests/legal-text-1901` 全件緑 (T-35 の 1 対 1・字数)。`docs/legal/archive/v2026.3/` がある |

## 16. 新設一覧

| 種類 | 名前 | 場所 | 段 |
|---|---|---|---|
| 表 | `public.apple_sign_in_tokens` (列 `user_id`・`client_id`・`refresh_token`・`created_at`・`updated_at`。PK `(user_id, client_id)`) | migration (§8.1) | A1 |
| route | `POST /api/auth/apple/authorization` | `src/app/api/auth/apple/authorization/route.ts` | A1 |
| エラーコード | `APPLE_AUTHORIZATION_CODE_INVALID` (400)・`APPLE_IDENTITY_NOT_LINKED` (409) | route | A1 |
| 退会の段階 | `apple_revoke` (`AccountDeletionStep`) | `src/lib/account-deletion.ts` | A1 |
| 差し替え口 | `DeleteAccountParams.appleRevocation` (`AccountDeletionAppleRevocation`) | 同上・`src/lib/auth/apple/revocation.ts` | A1 |
| レート制限の種類 | `'auth-apple-authorization'` | `src/lib/rate-limit.ts` | A1 |
| 関数 (サーバ) | `createAppleClientSecret`・`exchangeAppleAuthorizationCode`・`revokeAppleRefreshToken`・`storeAppleRefreshToken`・`listAppleRefreshTokens`・`registerAppleAuthorization`・`hasAppleIdentity`・`createAccountDeletionAppleRevocation`・`readAppleSignInServerConfig`・`storeAppleRefreshTokenFromWebCallback` (段 B) | `src/lib/auth/apple/*.ts` | A1 / B |
| 定数 (サーバ) | `APPLE_SIGN_IN_NATIVE_CLIENT_ID`・`APPLE_TOKEN_ENDPOINT`・`APPLE_REVOKE_ENDPOINT`・`APPLE_CLIENT_SECRET_AUDIENCE`・`APPLE_CLIENT_SECRET_TTL_SECONDS`・`APPLE_API_TIMEOUT_MS`・`APPLE_REVOKE_ATTEMPTS`・`APPLE_CALLBACK_PROVIDER` (段 B) | `config.ts`・`web-callback.ts` | A1 / B |
| Zod | `AppleAuthorizationBodySchema`・`AppleTokenResponseSchema`・`AppleErrorResponseSchema`・`AppleAuthorizationResponseSchema` | `src/lib/auth/apple/schemas.ts` | A1 |
| 共有 | `APPLE_SIGN_IN_FLAG_ON`・`isAppleSignInFlagOn`・`APPLE_AUTHORIZATION_CODE_MAX_LENGTH`・`APPLE_SIGN_IN_MESSAGES` | `packages/shared/src/apple-sign-in.ts` | A1 |
| 環境変数 | `NEXT_PUBLIC_APPLE_SIGN_IN`・`APPLE_SIGN_IN_TEAM_ID`・`APPLE_SIGN_IN_KEY_ID`・`APPLE_SIGN_IN_PRIVATE_KEY`・`APPLE_SIGN_IN_SERVICES_ID` / `EXPO_PUBLIC_APPLE_SIGN_IN` | `src/lib/env.ts`・`.env.example` / `apps/mobile/env.example` | A1 / A2 |
| 関数 (モバイル) | `isAppleSignInEnabled`・`isAppleSignInAvailable`・`signInWithApple`・`routeAfterSignIn` (移動) | `apps/mobile/src/lib/appleSignIn.ts`・`routeAfterSignIn.ts` | A2 |
| 部品 (モバイル) | `AppleSignInButton`・`APPLE_SIGN_IN_BUTTON_HEIGHT`・testID `login-apple-button`・`signup-apple-button` | `apps/mobile/src/components/auth/AppleSignInButton.tsx` | A2 |
| 依存 (モバイル) | `expo-apple-authentication ~58.0.2`・`expo-crypto ~58.0.7` | `apps/mobile/package.json` | A2 |
| 設定 (モバイル) | `ios.usesAppleSignIn`・`ios.infoPlist.CFBundleAllowMixedLocalizations` | `apps/mobile/app.json` | A2 |
| 関数・部品 (Web) | `isAppleSignInEnabled`・`AppleSignInButton`・`APPLE_SIGN_IN_TITLES`・`APPLE_SIGN_IN_BUTTON_HEIGHT_PX`・`APPLE_SIGN_IN_BUTTON_FONT_PX`・`APPLE_LOGO_SRC`・testID `login-apple-button`・`signup-apple-button` | `src/lib/auth/apple-sign-in-flag.ts`・`src/components/auth/AppleSignInButton.tsx` | B |
| 静的ファイル | `public/auth/apple-logo-white.svg` (Apple Design Resources) | `public/auth/` | B |
| 法務 | `PRIVACY_PROCESSORS` の Apple の行・第3条と第10条の文・主張の表 2 行・版 `v2026.4`・`docs/legal/archive/v2026.3/` | §11.8 | D |
| テスト | §14 の新設 (モバイル 3 本・サーバ 10 本) | — | A1 / A2 / B |

## 17. 既存の番兵 (契約テスト・走査テスト) の追随表

本設計が足す・変えるものの名前を grep の語にして、反応する既存の番兵を列挙した (origin/main `9575aa99` の `tests/`・`src/__tests__/`・`apps/mobile/__tests__/`)。

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/env-source-scan.test.ts` (規則 4・6) | `NEXT_PUBLIC_APPLE_SIGN_IN`・`APPLE_SIGN_IN_` | 一覧に無い変数を読む・`.env.example` に無い | `src/lib/env.ts` の一覧と `.env.example` に 5 つを足す (§11.7) | A1 (サーバの 4 つ)・B (公開の 1 つ) |
| `src/__tests__/lib/env.test.ts:371` (`publicNames`) | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | 公開の変数の名前の一覧が増える | 一覧に `NEXT_PUBLIC_APPLE_SIGN_IN` を足す | B |
| `tests/check-env-script.test.ts` | `check-env` | 一覧の増減で出力が変わる可能性 | 赤になったら期待値を実数に合わせる (緩めない) | A1 |
| `apps/mobile/__tests__/lib/env-example.test.ts` | `process.env.EXPO_PUBLIC_` | ソースが読む `EXPO_PUBLIC_APPLE_SIGN_IN` が `env.example` に無い | `apps/mobile/env.example` に足す (§11.5) | A2 |
| `apps/mobile/__tests__/lib/env.test.ts` | `process.env[` | 名前を変数にした読み取り | `process.env.EXPO_PUBLIC_APPLE_SIGN_IN` と直接書く (§11.5) | A2 |
| `tests/mobile-toolchain-contract.test.ts` (1・3b・6・7) | `expo-apple-authentication`・`expo-crypto`・`MOBILE_NESTED_ALLOWED` | 新しい依存の版と lock の置き場 | 版は `~58.0.2`・`~58.0.7` (SDK 58 の表)。lock はテスト用の機械で作り直し、2 つがルートに巻き上がることを `git diff -- package-lock.json` の `packages` のキーで数える | A2 |
| `tests/mobile-easignore-bundle-inputs.test.ts` | `.easignore` | 新しい import が `.easignore` で落ちないか | 足す import は node_modules と `apps/mobile/src` の中だけなので反応しない (確認だけ) | A2 |
| `tests/maestro-flow-testids.test.ts` | `login-google-button` | flow が使う testID の実在 | 既存の flow は Apple の testID を使わないので反応しない (確認だけ) | A2 |
| `src/__tests__/api/null-character-routes.test.ts` (`ENTRIES`) | `rejectNullCharacterBody` | 本文を読む route が表に無い | `{ file: 'auth/apple/authorization/route.ts', method: 'POST', load: … }` を足す | A1 |
| `tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts` | `.message` | 応答・結果に生のエラー文 | route・lib は固定の文だけを本文・結果に入れる (§11.3・§11.4 の形のまま)。`error_description` を結果に入れない | A1 |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient` | service_role の client を自前で作る | `getSupabaseAdmin()` だけを使う (§11.4・§11.6) | A1 / B |
| `tests/role-check-source-scan.test.ts` | `roles` | 手書きのロール判定 | 無い (認証は `requireSessionUser`) | A1 |
| `tests/database-types-migrations-contract.test.ts` | `CREATE TABLE` | 表が型ファイル 2 本に無い | `database.types.ts` を作り直す (§8.1) | A1 |
| `tests/db-privilege-hardening-migration-contract.test.ts` (3・5) | `TRUNCATE`・`GRANT` | 後の migration が利用者へ TRUNCATE / GRANT を付ける | migration は `REVOKE ALL` だけ・戻し口は `DROP TABLE` だけ (§8.1) | A1 |
| `tests/account-export-tables.test.ts` | `ACCOUNT_EXPORT_EXCLUDED`・`auth.users` | 利用者に紐づく表が書き出しの一覧にも除外にも無い | `src/lib/account-export-tables.ts` の除外に `apple_sign_in_tokens` を理由つきで足す (本人に返す意味が無く、失効に使える値を外へ出さない) | A1 |
| `tests/legal-text-1901.test.ts` T-34 (`PRIVACY_DATA_TABLES`) | `PRIVACY_DATA_TABLES` | 利用者に紐づく表が第3条の行にも除外にも無い | `apple_sign_in_tokens` → `'アカウント'` を足す | A1 |
| `tests/legal-text-1901.test.ts` T-33 | `not.toContain('Apple')` | `PRIVACY_PROCESSORS` に Apple が載る | §11.8 (e) の置き換え | D |
| `tests/legal-text-1901.test.ts` T-7・T-24・T-35 | `PRIVACY_PROCESSORS`・`LEGAL_CLAIM_COUNT` | evidence の実在・行数・主張の表の 1 対 1 と字数 | §11.8 (a)〜(d) | D |
| `tests/legal-claims-1901.ts` | `privacy-7#`・`privacy-10#`・`privacy-3#3` | 主張の表 | §11.8 (d) | D |
| 版の直書き (`src/__tests__/api/cron/push-outbox.test.ts` ほか) | `v2026.3` | 版を上げると赤 | `v2026.4` に直す (grep して全部) | D |
| `tests/account-deletion.test.ts` | `billing_recheck`・`deleteUser` | 呼ぶ順の検査に段階が増える。既定の実装が偽の `admin.from` を呼ぶ | §14.2 の追記。既存の it は `appleRevocation` の偽物を共通の引数に足す | A1 |
| `tests/account-delete-route.test.ts` | `deleteAccount` | route は変えないので反応しない (確認だけ) | — | A1 |
| `tests/account-deletion-email.test.ts` (`:38` の billing のモジュールの差し替え・`:202-212` の `run()`・`:242` の呼ぶ順) | `billing_recheck`・`deleteAccount(` | `run()` と route 経由の it は `appleRevocation` を渡さないので、既定の実装が偽の `makeAdmin` の `from('apple_sign_in_tokens')` を読む。偽物の `builder` は `select`・`eq` を自分に返し、`then` で `{ data: [], error: null }` を返す (`:114-123`) → 0 行で失効を呼ばず warn も出さない。`world.calls` に `from:apple_sign_in_tokens` が 1 つ増えるが、この冊の検査は位置の比較 (`at(…)`) だけで、並び全体の `toEqual` は無い | 反応しない (確認だけ) | A1 |
| `src/__tests__/api/account/delete-missing-env.test.ts` (`:80` の billing の差し替え・`:234-239` の `mockCreateAdminClient` 1 回と billing → billing_recheck の順・`:259` の warn 無し) | `billing_recheck`・`mockLoggerWarn` | route 経由で既定の実装が動く。既定の実装は `deleteAccount` に渡された同じ `admin` を使う (`createAccountDeletionAppleRevocation({ admin: () => admin })` §11.4) ので `mockCreateAdminClient` は 1 回のまま。`mockAdminFrom` の `emptyQuery()` (`:114-121`) は `select`・`eq` を自分に返し `then` で `{ data: [], error: null }` → 0 行で warn を出さない。`mockCancelForAccountDeletion` は `apple_revoke` から呼ばれないので順も 2 回のまま | 反応しない (確認だけ) | A1 |
| `tests/billing-account-deletion.test.ts` | `billing_recheck` | billing のモジュール (`src/lib/billing/account-deletion.ts`) の単体で、`deleteAccount` を呼ばない | 反応しない (確認だけ) | A1 |
| `tests/integration/security/account-deletion.test.ts`・`account-deletion-owner-guard.test.ts`・`self-dissolve.test.ts` | `deleteAccount(` | 本物の service_role の client で `deleteAccount` を `appleRevocation` 無しで呼ぶ。既定の実装がローカルの DB の `apple_sign_in_tokens` (段 A1 の migration で作られる・0 行) を読み、失効を呼ばない。表を読めなくても警告だけで続ける (§11.4)。結果 (`ok`・段階・CASCADE) は変わらない | 反応しない (確認だけ。結合テストの枠で緑を確かめる) | A1 |
| `tests/auth-callback-legal-consent.test.ts` | `exchangeCodeForSession` | コールバックの既存の分岐 | `provider` 無しでは保管を呼んでも `skipped` で、redirect は同じ (§11.6)。モックの `data` に `session` が無くても `?.` で通る | B |
| `tests/login-google-legal-note.test.tsx` | `login-google-legal-note`・`Googleで続ける` | 案内の testID と文・Google のボタンの存在 | どちらも変えない (§10.2) | B |
| `tests/signup-legal-consent.test.tsx` | `signInWithOAuth` | 同意前にボタンを押せない | Apple のボタンも同じ条件 (§14.2 の追記) | B |
| `tests/auth-turnstile-pages.test.tsx`・`src/__tests__/app/login-native-notify.test.tsx` | `createClient` のモック | 画面の描画 | モックの `auth` に `signInWithOAuth` があるので反応しない (確認だけ) | B |
| `tests/signup-minor-notice.test.tsx` (`:29` の `createClient` のモック) | `signInWithOAuth` | 新規登録の画面の描画 | モックの `auth` に `signInWithOAuth` があり、スイッチ (`NEXT_PUBLIC_APPLE_SIGN_IN`) 無しで Apple のボタンは出ないので反応しない (確認だけ) | B |
| `tests/auth/web-login-context-source-scan.test.ts` | `exchangeCodeForSession`・`recordWebLoginContextFromRequest` | `src/app` の route.ts ごとに、セッションを作る呼び出しの数 ≤ 文脈の記録の呼び出しの数 | 段 B は `/auth/callback` にセッションを作る呼び出しを足さない (保管は既存の交換の後 §11.6)。新設の route `POST /api/auth/apple/authorization` もセッションを作らない。反応しない (確認だけ) | A1 / B |
| `apps/mobile/__tests__/auth/turnstile-screens.test.tsx` (`:38` の `signInWithOAuth` のモック・`:101-102` で `login.tsx`・`signup.tsx` を読む) | `signInWithOAuth`・`app/(auth)/login` | 画面が `appleSignIn.ts`・`AppleSignInButton.tsx` を読み、`expo-apple-authentication`・`expo-crypto` を読み込む (`BUTTON_TYPE` は読み込みのときに列挙を読む) | §14.1 の正典のモックを足す (期待値は変えない)。スイッチ (`EXPO_PUBLIC_APPLE_SIGN_IN`) 無しなので Apple のボタンは描かれず、Turnstile の検査は同じ | A2 |
| `tests/e2e/legal-consent-gate.spec.ts:256-263` | `Googleで登録` | 同意前の Google のボタン | e2e の環境はスイッチ無しなので Apple のボタンは出ない (確認だけ。Q-8) | B |
| `tests/design-doc-version-header-matches-history.test.ts`・`tests/docs-table-column-count.test.ts` | `\| 版 \|`・表の `\|` | 本書の表紙と表 | 本書が満たす (版 v1.0・列の数) | 設計 |
| `tests/design-doc-auth-call-closure-count.test.ts` | `全 317 呼び出し` | 05 §9.1 の閉包の数 (記録) の内部の整合だけ | 本書は 05 を変えない。auth の呼び出しが増える事実は §18 の 05 の行で扱う | — |
| `tests/design-doc-removed-mobile-screens.test.ts`・`tests/mobile-removed-files-references.test.ts` | `apps/mobile/app/` | 消した画面の名指し | 本書が名指しする画面 (`(auth)/login.tsx`・`signup.tsx`・`settings/account.tsx`) は現存 | 設計 |
| `tests/no-committed-credentials.test.ts` | `PRIVATE_KEY` | `.env.example` に値 | 値を空にする | A1 |
| `tests/no-pending-wording-1911.test.ts` | `準備中` | 画面の文 | 新しい文に未完成・予定の語を使わない (§11.1・§12) | A1 / A2 / B |

## 18. 他の文書への追随表

| 文書 | 箇所 | 直すこと | 誰が・いつ |
|---|---|---|---|
| `docs/design/mobile/CLAUDE.md` | ファイル一覧の表 | 本書の行を足す: `06-sign-in-with-apple.md` / Sign in with Apple (iOS のネイティブ・Web の OAuth・退会のときの失効) / #1139 Pass 3・Pass 10 (番号は Q-9 の裁定に従う)。「他ドメインとの依存」に `cross/01 §3.1・§3.3` の行 | オーケストレーターの docs PR (本書のマージと同時) |
| `docs/design/mobile/05-auth-session.md` | §1 (Google ログイン)・§9.1 の閉包 (`全 317 呼び出し`。数えた sha の記録)・`:129` (「`login.tsx` の `routeAfterSignIn` が画面を移すまで」) | §1 に「Apple のログインは `06-sign-in-with-apple.md`」の 1 行。`:129` は Google のログインの見え方の記録で、移した後も `login.tsx` が `routeAfterSignIn` を呼んで画面を移す事実は同じなので変えない。§9.1 は記録なので変えない (次に閉包を数え直す改定で `signInWithIdToken`・`updateUser` (apps/mobile)・`signInWithOAuth({ provider: 'apple' })` (Web) を M-*・W-* の行に足す) | オーケストレーターの docs PR (段 A2 のマージ後) |
| `docs/design/cross/01-auth-session.md` | §3.1 の表 (Apple Sign In Phase 1)・§3.3 | §3.3 の「退会時: ソーシャル連携トークン全削除 + Google/Apple ドキュメント準拠で IdP 側 revoke」に「Apple は mobile/06 §9.3 (`apple_revoke`)。Google の revoke は未実装 (Q-10)」を添える | オーケストレーターの docs PR (段 A1 のマージ後) |
| `docs/design/cross/13b-legal-consent-mobile.md` | `:50`・`:200` (`login.tsx:89-100`)・`:331` (`login.tsx:76-100`) の `routeAfterSignIn` の場所・`:315`・`:360` (ログインの入口「メールとパスワード・Google」) | 場所を `apps/mobile/src/lib/routeAfterSignIn.ts` に、入口に「Apple」を足す (行番号の記録)。`:315` の「`login.tsx` の `routeAfterSignIn`」は、新規登録の画面 (Apple) からも呼ぶ事実を添える (`:368` は場所を名指していないので変えない)。`:689`・`:1070`・`:1234` はコードの注の写し (記録) なので変えない (コードの注は §18.1) | オーケストレーターの docs PR (段 A2 のマージ後) |
| `docs/design/cross/16-auth-history-sessions.md` | `:124` (S-6「Google でログイン (`signInWithOAuth` → `/auth/callback`)」)・`:212` (S-6 のトレース)・§8 の行 3 (`:333`「Google / Apple でログイン」)・§11.5 (パスワードの無い利用者 = Google / Apple だけ) | S-6 の文に「Apple (段 B) も同じ経路」を添える (記録)。§8 の行 3 と §11.5 は Apple を既に含むので変えない。Web の Apple のログインは同じ `/auth/callback` の `exchangeCodeForSession` → `recordWebLoginContextFromRequest` を通り (§17 の `web-login-context-source-scan` の行)、iOS の `signInWithIdToken` はモバイルの既存の文脈の記録 (`AuthProvider` の SIGNED_IN → `registerDeviceName`。cross/16 の S-3) を通るので、cross/16 の設計は変わらない | オーケストレーターの docs PR (段 B のマージ後) |
| `docs/design/mobile/07-toolchain-upgrade.md` | `:216`・`:260` (S9 の「ログイン直後の `routeAfterSignIn` の `replace`」)・`:855` (`apps/mobile/src/lib/legal-consent.ts:239` の注の写し) | 変えない。場所 (`login.tsx`) を名指しておらず、移した後も `routeAfterSignIn` が `replace` する事実は同じ | — |
| `docs/design/billing/01-billing-core.md` | `:3287` (`AccountDeletionStep` の和の抜粋。`billing`・`billing_recheck` を足した差分の説明) | 抜粋の `'billing_recheck'` の行の後に「`'apple_revoke'` は mobile/06 §9.3 が `billing_recheck` と `delete_user` の間に足す」の注を 1 行添える (抜粋は billing の差分の記録なので、和の中身は書き換えない) | オーケストレーターの docs PR (段 A1 のマージ後) |
| `docs/operations/auth-protection.md` | §4 の表の `:137` (「Google ログイン・登録」の行。呼び出しは `signInWithOAuth`・Web とモバイルとも CAPTCHA の対象外) | その次に Apple の行を足す (画面「Apple ログイン・登録」・呼び出しは Web が `signInWithOAuth` (段 B)・iOS が `signInWithIdToken` (段 A2)・Web とモバイルとも CAPTCHA の対象外) (GoTrue は `/token` の `grant_type` が `id_token`・`pkce`・`refresh_token` のとき CAPTCHA を確かめない。`internal/api/middleware.go` の `isIgnoreCaptchaRoute`) | オーケストレーターの docs PR (段 A2 のマージ後) |
| `docs/design/cross/20-terms-privacy-text.md` | §2.2 F-15 (外部送信に `Google OAuth`)・F-16 (委託先に `Google (OAuth)`)・§10 の主張の表 (`privacy-3#3`・`privacy-7`・`privacy-10` の行と区分の数)・§9 の版の履歴・§17 | 段 D の差分 (§11.8) を正典にも写す (Apple (OAuth) を F-15・F-16 に、主張の表に 2 行、版 `v2026.4` の行) | オーケストレーターの docs PR (段 D のマージと同時) |
| `docs/design/billing/03-paid-plans-and-iap.md` | F24 (「`PRIVACY_PROCESSORS` に `Stripe`・`RevenueCat`・`Apple` が無いこと」の記述)・§11.2 (c) の注の文 | T-33 の Apple の条件が「決済の事業者として載せない」に変わった事実を添える (記録) | オーケストレーターの docs PR (段 D のマージ後) |
| `MOBILE_TODO.md` | `:41` (ブロッカー 5)・`:186`・`:193` | 追跡を本書 (`docs/design/mobile/06-sign-in-with-apple.md`) にし、済んだ段を記す | オーケストレーター (各段のマージ後) |
| `apps/mobile/README.md`・`ENV_SETUP.md` | 環境変数の案内 | `EXPO_PUBLIC_APPLE_SIGN_IN`・Web の 5 つの説明 (設定の順 §19) | 実装 PR (段 A1 / A2) で足してよい (設計正典ではない) |
| `docs/operations/` | (新設の候補) `sign-in-with-apple.md` | §19 のオーナーの手順と 6 か月ごとの Secret Key の入れ替えの記録 | オーケストレーター (段 A1 のマージ後。任意) |
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
| `APPLE_SIGN_IN_TEAM_ID` | Team ID | 段 A1 のデプロイの後 (無くてもログインは動く。退会の失効のため早めに) |
| `APPLE_SIGN_IN_KEY_ID` | Key ID | 同上 |
| `APPLE_SIGN_IN_PRIVATE_KEY` | .p8 の中身を 1 行にし改行を `\n` と書いたもの | 同上 |
| `APPLE_SIGN_IN_SERVICES_ID` | Services ID | 段 B のデプロイの後 |
| `NEXT_PUBLIC_APPLE_SIGN_IN` | `on` | 段 B と段 D のデプロイの後、19.2 の 1〜3 が済んでから (再デプロイが要る) |

### 19.4 EAS の環境変数とビルド

- `EXPO_PUBLIC_APPLE_SIGN_IN` = `on` を preview / production の環境変数に入れる (段 D の公開と 19.2 の 1〜2 の後)。
- 段 A2 のマージ後に新しいビルド (指紋が変わる)。内部配布か TestFlight で実機の確認 (§20)。

### 19.5 App Store Connect

- App Privacy の申告は既存の「名前・メールアドレス (アカウント)」の範囲で、新しい項目は無い。Notes for Review に「Sign in with Apple を提供」と、審査用のアカウント (既存の案内 `docs/operations/app-store-metadata.md`) を書く。

## 20. 受入 (デプロイ後整合ゲート) の項目

1. 本番の実機 (iOS) のログイン画面に Apple のボタンが Google の上に同じ高さで出て、Face ID の認可のあとホーム (または初期設定・同意画面) に入る。設定 → アカウントに「Apple アカウントでログインしています」とメール (中継を選んだときは `@privaterelay.appleid.com`) が出る。
2. 本番の `auth.identities` に `provider = 'apple'` の行と、`apple_sign_in_tokens` に `client_id = 'com.homegohan.app'` の行が 1 つできている (SELECT。値は読まない・載せない)。
3. 同じ利用者で退会 → `app_logs` の `account deleted` の metadata に `apple.revoked = 1`、Apple の `/auth/revoke` が 200 (warn が無い)。iPhone の設定 → Apple アカウント → Apple でサインイン の一覧からこのアプリが消えている。
4. シートで取り消し → 何も出ない。スイッチ無しの preview ビルドではボタンが無い。
5. Web (段 B のあと): 「Appleで続ける」で同意画面 → ホーム。`apple_sign_in_tokens` に Services ID の行ができる (`provider_refresh_token` が返っていれば。返らなければ Q-6 を記録)。
6. プライバシーポリシー `/privacy` の第7条に Apple の行、版 `v2026.4`。既存の利用者に再同意が出る。
7. Vercel のランタイムログに `apple authorization` の `warn` / 500 が無い (`not_configured` の `info` は秘密を入れる前だけ)。
8. 中継のアドレスの利用者に退会の完了メールが届く (19.1 の 4 が済んでいること)。

## 21. 未解決事項・選択肢

- **Q-1 (選択式) Web にも Apple のログインを出すか**: 既定 = 出す (段 B)。理由: アプリで Apple だけで作った人が Web に入る手段が、Apple か「パスワードを忘れた」の再設定 (cross/16 §11.5) しか無い。アプリだけにするなら段 B と `APPLE_SIGN_IN_SERVICES_ID`・19.1 の 3・19.2 の 3 を落とす (iOS のネイティブは Services ID も Secret Key も要らない)。
- **Q-2 (選択式) 失効に失敗したときに退会を止めるか**: 既定 = 止めない (裁定 2)。止める案は Apple の障害で退会 (5.1.1(v)) ができなくなる。やり直しの列 (R3) は退会の量が増えたら別の Issue で。
- **Q-3 Android の Apple ログイン**: 範囲外。出すときは Google と同じ `signInWithOAuth({ provider: 'apple' })` + `openAuthSessionAsync` (Services ID と Secret Key が要る) を `Platform.OS === 'android'` のときだけ使う。Android の提出 (iOS の後) の案件で決める。
- **Q-4 設定画面から Apple の連携だけを外す操作**: 範囲外 (Supabase の `unlinkIdentity` は identity が 2 つ以上のときだけ使える)。要るなら別の Issue。
- **Q-5 メールを隠した人が既存のアカウントと別になったときの案内**: 本書は Google と同じく案内しない (S-6)。HIG は「同じメールなら結び付けを提案」と言うが、中継のメールでは判定できない。要るなら設定画面に `linkIdentity` の案内を足す別の Issue。
- **Q-6 Web の `provider_refresh_token` の有無**: GoTrue は PKCE の交換で flow state の `provider_refresh_token` を返す (`token.go`)。Apple の交換の応答に `refresh_token` があるので返る見込みだが、本番で 1 回確かめる (§20 の 5)。返らないときは Web の行は保管されず、その入口の失効はスキップになる (iOS の行で失効する)。返らないことが分かったら、Web の Apple のログインも iOS と同じ「認可コードをこちらで交換する」形 (Supabase の `signInWithOAuth` を使わず Apple の JS でコードを受け、サーバで交換して `signInWithIdToken`) に変える別の設計が要る。
- **Q-7 `/login?error=` の文**: コールバックは Apple の `error_description` (英文) をそのまま出す既存の経路。本書は変えない (Google と同じ)。日本語にするなら別の Issue。
- **Q-8 e2e**: Playwright の e2e は本物の Apple を通せない。スイッチ無しで Apple のボタンが出ないこと (段 B の `tests/login-apple-button.test.tsx` の単体) で足りるとする。スイッチ on の e2e は「ボタンが disabled である」までを足してよい (Q-8 は実装者の判断に委ねない: 足さない)。
- **Q-9 (オーケストレーターの裁定) 本書のファイル名の番号**: `docs/design/mobile/` には `06-push-send.md` が既にある。本書は `06-sign-in-with-apple.md` に置いてあり、`mobile/CLAUDE.md` の表の番号と衝突する。マージのときに `08-sign-in-with-apple.md` に改める (本書の中の自己参照 (`mobile/06`・`docs/design/mobile/06-sign-in-with-apple.md`) も一緒に置換する) か、06 のまま並べるかを決める。
- **Q-10 Google の revoke**: cross/01 §3.3 は Google も IdP 側で revoke すると書くが、未実装 (本書の範囲外)。Apple と同じ表 (`client_id` を Google の client ID にする) で扱える形にしてあるので、要るなら別の Issue。
- **Q-11 Secret Key の自動化**: Supabase の Apple の Secret Key (6 か月) を、サーバの `createAppleClientSecret` と同じ鍵で作る `scripts/` の道具は本書に入れない (オーナーが Supabase の案内で作る)。入れ替えを忘れると Web の Apple ログインが止まるので、`docs/operations/` の記録 (§18) に日付を残す。
- **Q-12 Issue の番号**: #1139 の本文はストアの提出と Pass 1〜10 の全体で、Sign in with Apple はその一部 (Pass 3・Pass 10・`MOBILE_TODO.md` のブロッカー 5)。実装の Issue は #1139 の子として 4 段 (A1・A2・B・D) で起こすのがよい (オーケストレーター)。
