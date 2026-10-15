# ログイン履歴・不審なログインの通知・セッションの一覧と失効・パスワードの再利用の防止

> 版: v1.1 (2026-10-15 設計ゲート R1 の修正) / Issue: #1190 (`[セキュリティ] ログイン履歴・不審ログイン通知が皆無`)・#1189 (`[セキュリティ] アクティブセッション/デバイス一覧・個別失効UIが存在しない`)・#1198 (`[運用] password_historyテーブルはあるがパスワード再利用防止ロジックが未実装のstub`)
> 位置づけ: `cross/01-auth-session.md` §3.2 (`INSERT user_sessions_metadata`)・§4.3〜4.4 (セッションの一覧・個別失効・ログアウト)・§7.1 (過去履歴禁止の世代数)・§9.1 (リセット時の `password_history` 照合) を、実装できる粒度に展開した正典。§4.3 の「同時 5 端末」と §4.4 の `supabaseAdmin.auth.admin.signOut(sessionId)` は本書が改める (§23)。DDL の正典 `operator/01-data-model.md` §3.23 / §3.25 は本書 §11 が改定する (§23)。
> ローンチに要るものとしてこの群を作る (オーナーの選択 2026-10-15・選択式)。前提: ローンチ前で利用者ゼロ (正しい形で作る)。
> 改定履歴: v1.0 2026-10-15 初版。v1.1 2026-10-15 R1 の修正: ① パスワードの更新と「他の端末をログアウト」を、サーバーの client の `auth.updateUser` / `auth.signOut` から、本人の access token で GoTrue を呼ぶ形 (`updatePasswordWithAccessToken`・`signOutOtherSessions`) に改めた (Bearer だけのモバイルの要求ではサーバーの client にセッションが無い §3) ② 不審の判定の比べる相手 (prior) を「同じ利用者の前の行すべて」に改め、履歴が保持期間で消えた利用者を `history_expired` として知らせる (§10.1・§12.3) ③ 再設定の認可の `amr` に `otp` (token_hash / implicit の経路) を加えた (§12.4) ④ 番兵 (§22 N-24・N-33・N-34) と触るファイル (§21) を閉じた。

---

## 0. 分冊判定・段分け・範囲 (相 1 の結果)

### 0.1 分冊判定

| 目安 | 本件 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (migration の正典・表 3 点・追随表を 1 冊に持つため) | 当たる |
| 消費先レーン 3 以上 | Web の設定画面・モバイルの設定画面・Web の認証 route (login / callback)・運営の利用者詳細・Vercel Cron・DB (トリガー / RPC / pg_cron) = 6 | 当たる |
| 共有面に 2 つ以上触る | `auth.sessions` / `auth.users` へのトリガー (Supabase Auth の表)・`user_sessions_metadata` / `password_history` の DDL・`user_profiles.last_login_at` / `login_count` の供給・`src/lib/rate-limit.ts`・`src/lib/env.ts` / `.env.example`・`vercel.json` | 当たる |

**判定: 設計書は 1 冊、実装は 4 段 (A〜D) に分け、段ごとに別の実装 WF (別ブランチ・別ゲート・別 PR) で積む。**
分冊しない理由: 核は「記録の入口を DB (auth.sessions / auth.users のトリガー) に 1 つ置く」ことで、配線 (一覧・失効・通知・パスワード API・運営画面) はすべてその記録を読む・その記録に印を足すだけ。契約 (§11〜§14) を本書に逐語で置けば、各段の実装者は本書だけで手が止まらない。核を別冊にすると「段 A のマージ待ちで配線の設計が止まる」が、段 A は本書の §11 だけで実装できる。

### 0.2 段分け (実装 WF の単位と順序)

| 段 | 中身 | 依存 | デプロイ後の状態 |
|---|---|---|---|
| **A DB と核** | migration (§11: 列・トリガー 4 本・RPC 2 本・保守の関数 3 本・pg_cron のジョブ 1 本・既存行の写し) と対の `.down.sql`・型の再生成・`src/lib/auth/sessions/{constants,device-family,login-alert-policy,session-claims,schemas,store}.ts`・`src/lib/auth/password/{policy,change,gotrue-user}.ts`・単体テスト・契約テスト (§20.1・§20.3)・`docs/design/operator/08-cron-batches.md` の pg_cron の記述 (§22 N-32・§23) | なし | すべてのログインが `user_sessions_metadata` に記録され、`user_profiles.last_login_at` / `login_count` が動き始め、パスワードの変更が `password_history` に残る。利用者に見える変化は無い (運営の「最終ログイン」が埋まる) |
| **B セッションの一覧・失効・通知** | `GET /api/auth/sessions`・`DELETE /api/auth/sessions/{id}`・`PATCH /api/auth/sessions/current`・`POST /api/auth/sessions/revoke-others`・`GET /api/auth/login-history`・Web の `/settings/security/sessions`・設定の導線・モバイルの `settings/sessions` と端末名の登録・`GET /api/cron/login-alerts` + `vercel.json`・メール `login_new_device`・環境変数 `AUTH_LOGIN_ALERT`・Web の login / callback route の文脈の上書き (§13.5)・`docs/design/operator/08-cron-batches.md` の Vercel Cron の記述 (§22 N-32・§23) | A | 利用者が端末を一覧・失効でき、新しい端末・地域からのログインがメールで届く |
| **C パスワードの変更・再設定の API 化と履歴の照合** | `POST /api/auth/password/change`・`POST /api/auth/password/reset`・rate-limit のカテゴリ 2 つ・Web の `/settings/account` と `/auth/reset-password` の呼び替え・モバイルの `account-credentials.ts`・`AccountCredentialsSection.tsx`・`reset-password.tsx` の呼び替え・`logout-guidance.ts` の使われなくなる関数の削除・既存テストの書き換え (§22 N-24〜N-28・N-31・N-33) | A | 変更・再設定のどちらも、直近 N 世代と同じパスワードを 422 で断る。変更は現在のパスワードを DB で確かめ、セッションの入れ替え (再認証のサインイン) をしなくなる |
| **D 運営の画面** | `GET /api/admin/users/{id}/login-history`・`/admin/users/{id}` のログイン履歴の節・監査 `admin.user.view_login_history` | A | admin / super_admin が利用者の直近 20 回のログインと印 (新しい端末 / IP / 地域) を見られる |

B・C・D は A の後に並行に作れる (互いに触るファイルが重ならない。B と C はどちらも `src/lib/auth/sessions/session-claims.ts` を読むだけ)。各段は単独で型検査とテストが通る。

### 0.3 本書が決めないもの (範囲外)

- cross/01 §4.3 の「同時ログイン上限 5 端末」(超過時の最古の強制失効)。本書は上限を設けず、一覧と個別失効・放置された端末の自動終了 (§11.6) で足りるとする。要るなら別 Issue。
- cross/01 §4.1 のロール別のアイドル / 絶対タイムアウト (個人 24h/30d・組織 8h/7d・運営 1h/12h)。本書は「更新の無いまま 30 日」の 1 値だけを DB で実装する (§7.1 の裁定・§25 Q-3)。
- 運営が利用者のセッションを失効させる操作。既存の凍結 (`/admin/users/{id}/freeze`) が middleware の判定で同じ効果を持つ。
- モバイルのログインの地域 (国) の記録。国は Vercel のヘッダ (`x-vercel-ip-country`) から取れる Web の経路だけで記録する (§7.1)。GeoIP の外部サービスは使わない。
- HIBP (cross/01 §7.2)・ログイン方法 (`amr`) の記録・サポートコンソール (`/support/users`) の変更・メールアドレス変更の経路。
- cross/12 (運営の MFA。別ブランチ `design/operator-mfa`・未マージ) の中身。本書は MFA と独立に動く (関係は §9 の最終行と §25 Q-5)。

---

## 1. 目的・スコープ

1. **ログインの記録** (#1190): どの経路 (Web の `/api/auth/login`・Web の OAuth / メールのリンク・モバイルの直接の `signInWithPassword`・anon キーで GoTrue を直接呼ぶ攻撃者) でも漏れなく記録する。記録の入口は、呼ぶ側が選べない場所 = **`auth.sessions` への INSERT のトリガー** (§7.1)。1 行 = 1 ログイン (= 1 セッション)。終了 (ログアウト・失効・パスワード変更による失効・放置の終了) は DELETE のトリガーで同じ行に刻む。
2. **不審なログインの通知** (#1190): 新しい端末の種類 (OS × ブラウザ / アプリ) または新しい国からのログインを、本人のメールアドレスに知らせる。判定は Vercel Cron (毎分) の worker が純関数 `decideLoginAlert` で行う。IP の範囲が新しいことは記録・表示するが、それだけでは知らせない (§7.1)。
3. **セッションの一覧と個別の失効** (#1189): Web とモバイルの設定から、ログイン中の端末を一覧し、1 つずつ失効させる。失効 = SECURITY DEFINER の RPC `auth_session_revoke` が `auth.sessions` の行を消す (GoTrue は、行の無い session_id の JWT を `session_not_found` で断り、refresh も失敗する §3)。
4. **パスワードの再利用の防止** (#1198): `password_history` への記録は **`auth.users.encrypted_password` の変更のトリガー** (どの経路でも漏れない)。照合は、変更・再設定を受ける **サーバーの API** が、DB の `auth_password_check` (pgcrypto の `crypt()` で bcrypt を比べる) で行う。世代数はロール別 (cross/01 §7.1: 個人 3 / 組織 5 / 運営 10)。
5. **運営の画面** (#1190): `/admin/users/{id}` に直近のログイン履歴の節を足す。`user_profiles.last_login_at` / `login_count` (いま誰も書いていない) を 1 のトリガーが供給する。

## 2. 関連要件・正典

| 文書 | 箇所 | 本書との関係 |
|---|---|---|
| Issue #1190 / #1189 / #1198 | 本文 | 要件の正本 (コメントは 0 件) |
| `docs/design/cross/01-auth-session.md` | §3.2・§4.1・§4.3・§4.4・§7.1・§9.1・§13.1・§13.3・§16・§17 | 方針。食い違う箇所は本書が正 (§23 で §4.3・§4.4・§9.1 を改める) |
| `docs/design/operator/01-data-model.md` | §3.23 `password_history`・§3.25 `user_sessions_metadata` | DDL の正典。本書 §11.1 の列・ポリシーの変更を写す (§23) |
| `docs/design/cross/04-api-conventions.md` | §4.2 (`VALID_PASSWORD_HISTORY` 422・`AUTH_SESSION_REVOKED` 401) | 既存の code を使い、新しい code を足す (§19・§23) |
| `docs/design/mobile/05-auth-session.md` | §2・§3・§6 | ネイティブと WebView のセッションは同じ `auth.sessions` の 1 行 (§8 の行 8) |
| `docs/design/operator/07-audit-monitoring.md` | §4.1.1 | 運営の閲覧の監査の形 (`admin.user.view` と同じ) |
| `docs/operations/auth-protection.md` | §2・§3 | Supabase Auth の設定値の置き場。本書の前提 (§24) を足す |
| `docs/design/cross/13a-legal-consent-api-server.md` (マージ済みの設計・未実装) | §6.4 の許可リスト `LEGAL_CONSENT_EXEMPT_API_PATHS` | `/api/auth` (prefix・`auth_flow`) と `/api/cron` (prefix・`no_user_session`) が許可リストにあるので、本書の `/api/auth/sessions*`・`/api/auth/login-history`・`/api/auth/password/*`・`/api/cron/login-alerts` は同意のゲートで止まらない (未同意でも端末の失効・パスワードの変更ができる)。`/api/admin/users/{id}/login-history` は 13a の扱いのまま。本書から 13a は変えない |
| `docs/design/cross/12-operator-mfa.md` (未マージ) | §3.1・§13.2 | `auth.getClaims` の使い方が同じ。識別子は共有しない (§25 Q-5) |

## 3. 前提の事実 (origin/main 5a48abc9・本番 DB の読み取り 2026-10-15。R1 で origin/main 61c59321 と突き合わせ、本書が参照する識別子はすべて残っている)

- `auth.sessions` の列: `id uuid, user_id, created_at, updated_at, factor_id, aal, not_after, refreshed_at (timestamp without time zone), user_agent text, ip inet, tag, oauth_client_id, refresh_token_hmac_key, refresh_token_counter, scopes`。所有者 `supabase_auth_admin`。`postgres` は SELECT / INSERT / UPDATE / DELETE / TRIGGER を持つ。`auth` スキーマのトリガーは 0 本 (本書が最初)。拡張: `pgcrypto 1.3` (スキーマ `extensions`)・`pg_cron 1.6.4`・`pg_net 0.19.5`・`supabase_vault`。
- 本番の行数: `auth.sessions` 1,331 (`auth.users` 195)。`user_sessions_metadata` 0・`password_history` 0 (どちらも stub。`src/` に読む・書くコードは無い)。
- **`ip` / `user_agent` は作成時に入る**: 一度も refresh していない 1,328 行の全部に `ip` と `user_agent` がある (GoTrue の `tokens/service.go` は `session.ApplyGrantParams(&grantParams)` の後に `tx.Create(session)`)。refresh のたびに refresh した側の `user_agent` / `ip` / `refreshed_at` で上書きされる (`UpdateOnlyRefreshInfo`)。
- **Web のログインは Next.js のサーバーが GoTrue を呼ぶ**ので、GoTrue が記録する UA は `node` (699 行)・IP は Vercel のもの。利用者の IP / UA は `POST /api/auth/login` (`src/app/api/auth/login/route.ts`) と `/auth/callback` (`src/app/(auth)/auth/callback/route.ts`) の request にしか無い。モバイルは `apps/mobile/app/(auth)/login.tsx:163` が GoTrue を直接呼ぶので、GoTrue の記録が端末の実値 (iOS のアプリは `CFNetwork/…`、Android は `okhttp/…`)。Web の refresh も Next.js の middleware (`lib/supabase/middleware.ts`) がサーバーで行う。
- GoTrue (supabase/auth master の実コード): `PUT /user` のパスワード更新は `user.UpdatePassword(tx, &session.ID)` → `LogoutAllExceptMe` (他のセッションを **DELETE**)。`secure_password_change` が ON のときだけ、セッションが無いか作成から 24 時間を過ぎていると nonce (再認証) を求める。`PUT /admin/users/{id}` は `UpdatePassword(tx, nil)` → `Logout` (本人の分も含めて **全部** DELETE)。`POST /logout?scope=others|global` も `auth.sessions` を DELETE。JWT の `session_id` の行が無いと `session_not_found` (403) を返す。期限や放置で行を消す仕組みは無い (timebox / inactivity は Pro の設定で、本番は未設定: 1,331 行が残っている)。この挙動のうち P-1 (他の端末の失効)・P-2 (本人は残る)・P-4 (`scope: 'others'`) は `tests/integration/security/password-update-revokes-sessions.test.ts` が GoTrue v2.183.0 で固定している。
- **サーバーの client は、Bearer だけの要求ではセッションを持たない**: `createClient()` (`lib/supabase/server.ts`) は `Authorization` を `global.headers` に入れるだけで、セッションの保管は Cookie。モバイル (`getApi()` は Bearer だけを送る) の要求では保管が空。auth-js 2.105.3 の `_updateUser` は保管にセッションが無いと `AuthSessionMissingError` (code 無し) を投げ、`_signOut` は保管のセッションが無いと GoTrue を呼ばずに `{ error: null }` を返す。よって本人のセッションで GoTrue を変える操作 (パスワードの更新・他の端末のログアウト) は、本人の access token を明示して GoTrue を呼ぶ (§13.7・§14.3)。`auth.admin.signOut(jwt, scope)` (`GoTrueAdminApi`) は `POST /logout?scope=<scope>` を渡した JWT で呼ぶ。
- **再設定のセッションの `amr`** (supabase/auth master の `internal/api/verify.go`): `POST /verify` (token_hash。Web の `/auth/callback` と モバイルの `authLink.ts` の `verifyOtp`) と、`GET /verify` の implicit の経路 (フラグメントの token → モバイルの `authLink.ts` の `setSession`。モバイルの client は `flowType` を指定しないので implicit) は、どちらも `models.OTP` (`otp`) で token を出す。`recovery` になるのは PKCE の code の経路 (Web の `resetPasswordForEmail` → `/auth/reset-password?code=…` を browser の client が交換) だけ。本番の `auth.mfa_amr_claims` は `password` 1,364・`otp` 2 で、`recovery` は 0 (2026-10-15)。アプリは `signInWithOtp` (メールのリンクでのログイン) を使っていない (origin/main の `src/`・`apps/mobile/` に 0 件)。
- 既存コード: `src/lib/auth/guarded-login.ts` (`performGuardedLogin`。副作用は deps)・`src/lib/auth/login-failures.ts` (環境変数の解釈 `resolveLoginFailureResetMinutes` の形)・`lib/supabase/server.ts` (`createClient()` は Cookie と `Authorization: Bearer` の両方を使う・`getSupabaseAdmin()`)・`src/lib/auth/helpers.ts` (`requireUser` / `requireRole`)・`src/lib/admin/audit.ts` (`recordAdminAudit` / `extractClientIp`)・`src/lib/rate-limit.ts` (`checkRateLimit(key, category)`・`auth-login` 10 回/分)・`src/lib/emails/send.ts` (`sendEmail`。停止リスト・再試行・Idempotency-Key)・`src/lib/cron-auth.ts` (`requireCronAuth`)・`src/lib/env.ts` (`readOnlyBy`)・`apps/mobile/src/lib/api.ts` (`getApi()`: Bearer 付きで Next.js の API を呼ぶ)・`apps/mobile/src/lib/account-credentials.ts` (`changePassword`: 再認証 → `updateUser` → `signOut({scope:'others'})`)・`src/app/(main)/settings/account/page.tsx` (同じ 3 段を browser で)・`src/app/(auth)/auth/reset-password/page.tsx` (`updateUser` → `signOut({scope:'global'})`)・`packages/shared/src/password-policy.ts` (`validatePassword`・8 文字以上・英数)・`packages/shared/src/account-change-input.ts` (`validatePasswordChangeInput`)。
- `user_profiles.last_login_at` / `login_count` (migration 20251126124224:517・542) は、`src/`・`supabase/functions`・migration のどこにも書く処理が無い。運営の画面 (`src/app/admin/users/[id]/page.tsx:183`・`src/app/(support)/support/users/page.tsx:188`・`src/app/api/support/users/[id]/route.ts:49`) は読むだけ。
- `src/modules/` はこのリポジトリに無い。既存の切り方は `src/lib/<領域>/` (`src/lib/auth/`・`src/lib/emails/`) で、本書もそれに合わせる (§25 Q-6)。
- ライブラリ: `@supabase/supabase-js` / `auth-js` 2.105.3 (`auth.getClaims(jwt?)`・`auth.admin.signOut(jwt, scope)`)・`@supabase/ssr` 0.1.0・`zod` 4・Next 15.5・モバイルは `expo-device ~7.1.4`。Vercel Cron は `*/1 * * * *` が既に使われている (`/api/cron/process-menu-queue`)。

## 4. 要件行列

| # | 要件 | 根拠 | 本書の節 |
|---|---|---|---|
| R-1 | どの経路のログインも漏れなく記録する (呼ぶ側が記録を避けられない) | #1190 本文 (乗っ取りの早期発見) | §7.1 / §11.3 |
| R-2 | 1 回のログインにつき: 日時・IP・IP の範囲・UA・端末の種類・端末名 (モバイル)・国 (Web)・終了の日時と理由を持つ。終わった行は 90 日で消す | #1190 本文・仕様ファイル「IP と端末の扱い・保持期間」 | §11.1 / §11.6 / §12.1 |
| R-3 | 新しい端末の種類・新しい国からのログインを本人にメールで知らせる (初めてのログインは知らせない。IP の範囲だけが新しいときは記録のみ)。比べる相手は同じ利用者の前のログインすべて (長く続いているセッションを含む)。履歴が保持期間で消えた利用者のログインは「初めて」とみなさず知らせる | #1190 本文 | §10.1 / §12.3 / §13.4 / §18 |
| R-4 | 利用者がログイン中の端末を一覧し、1 つずつ・または他の端末を全部失効できる (Web・モバイル) | #1189 本文 | §14.1〜14.4 / §15 / §16 |
| R-5 | 失効した端末は、次の API の要求・次の refresh で未ログインになる (PostgREST を JWT で直接呼ぶ要求は、JWT の期限まで通る §24) | #1189 本文 | §3 / §11.4 |
| R-6 | 更新 (refresh) の無いまま 30 日過ぎたセッションは自動で終える | 仕様ファイル「sessions の扱い」・cross/01 §4.1 (個人の絶対 30 日) | §11.6 |
| R-7 | パスワードの変更・再設定で、直近 N 世代 (個人 3 / 組織 5 / 運営 10) と同じパスワードを断る。記録はどの経路でも漏れない | #1198 本文・cross/01 §7.1・§9.1 | §11.3 (トリガー) / §11.5 / §12.2 / §14.6〜14.7 |
| R-8 | 変更は現在のパスワードを確かめる。再設定はメールのリンク / コードで作ったセッション (`amr` に 60 分以内の `recovery` または `otp`) だけが行える | #1198 本文・cross/01 §9.1 | §12.4 / §14.6 / §14.7 |
| R-9 | 運営 (admin / super_admin) が利用者の直近のログイン履歴を見られ、閲覧は監査ログに残る | #1190 本文・docs/design/CLAUDE.md 監査ログ必須 | §17 |
| R-10 | `user_profiles.last_login_at` / `login_count` が埋まる | #1190 本文 (「最終ログイン」の単一列) | §11.3 |
| R-11 | migration の番号は決めない。対の `.down.sql` を作る。既存の関数・ポリシーは origin/main の定義を土台にする | 仕様ファイル | §11 |
| R-12 | `as any` を使わない。意味のある数値は名前付き定数 (根拠つき)。運用で変えうる値は環境変数で上書きできる | 共通規律 | §12 |
| R-13 | トリガーの失敗がログイン・サインアップ・パスワード更新を止めない (記録は best-effort、認証は fail-open) | §7.1 | §11.3 |
| R-14 | 既存の番兵 (走査テスト・契約テスト) に反応するものを列挙し、直し方と段を決める | 設計ゲートの要件 | §22 |

## 5. ユーザーシナリオ (27 本)

| # | 誰が | 何をする | 期待 |
|---|---|---|---|
| S-1 | 新規の利用者 (Web) | メールとパスワードで初めてログイン | `user_sessions_metadata` に 1 行 (Web の IP / UA / 国で上書き済み)。`last_login_at` が入る。初めてなので通知は無し。設定の一覧に「この端末」として出る |
| S-2 | S-1 の利用者 | 別の PC の Firefox からログイン | 新しい端末の種類 → 1〜2 分以内に「新しい端末からのログイン」のメール。一覧に 2 行 |
| S-3 | S-1 の利用者 | iPhone のアプリでログイン | GoTrue の記録 (`CFNetwork/…`) から「ほめゴハンのアプリ (iPhone・iPad)」。アプリが端末名 (`iPhone 15 Pro (iOS 18)`) を登録。新しい端末の種類 → メール |
| S-4 | 攻撃者 (パスワードを盗んだ) | anon キーで GoTrue の `/token?grant_type=password` を直接呼ぶ | 記録される (トリガー)。端末の種類が本人の履歴に無ければメール。本人は一覧で見つけて失効できる |
| S-5 | S-1 の利用者 | 同じ PC の同じブラウザでログアウト → ログイン | 前の行は `revoked_at` + `signed_out`。新しい行は既知の端末・IP の範囲 → 通知無し |
| S-6 | 利用者 (Web) | Google でログイン (`signInWithOAuth` → `/auth/callback`) | callback が code を交換した直後に、request の IP / UA / 国で上書き。以降は S-1 と同じ |
| S-7 | 利用者 (Web) | 一覧で「見覚えの無い端末」の「ログアウトさせる」を押す | `DELETE /api/auth/sessions/{id}` → RPC が `auth.sessions` を消す → 行は `revoked_by_user`。その端末の次の要求は `session_not_found` → middleware が `/login` へ (Web) / `getUser()` の失効で SIGNED_OUT (モバイル) |
| S-8 | 利用者 | 一覧で「この端末」を失効させようとする | ボタンは出ない。API を直接呼んでも 409 `AUTH_SESSION_IS_CURRENT` (ログアウトを使う) |
| S-9 | 利用者 (Web / モバイル) | 「他の端末をすべてログアウト」を押す | `POST /api/auth/sessions/revoke-others` → `signOutOtherSessions` (本人の access token で GoTrue の `/logout?scope=others`。モバイルの Bearer だけの要求でも同じ) → GoTrue が他の行を DELETE → 全部 `signed_out`。この端末は残る |
| S-10 | 利用者 (Web) | 設定のログアウト | 今までどおり `signOut()` (global)。全行が `signed_out` になる (既存の挙動を変えない) |
| S-11 | 利用者 (Web) | パスワード変更で現在のパスワードを間違える | 400 `AUTH_CURRENT_PASSWORD_MISMATCH`。何も変わらない。セッションも入れ替わらない |
| S-12 | 個人の利用者 | 2 回前に使ったパスワードに変える | 422 `VALID_PASSWORD_HISTORY` (直近 3 世代)。4 回前なら通る |
| S-13 | 利用者 (Web / モバイル) | 正しい現在のパスワードで変更 | 200。GoTrue の `PUT /user` は本人の access token で呼ぶ (Web は Cookie のセッションの token、モバイルは Bearer の JWT)。トリガーが `password_history` に新しいハッシュを残す。GoTrue が他のセッションを消す (P-1) → 一覧はこの端末だけ。履歴に `signed_out` が並ぶ |
| S-14 | 利用者 (Web) | 再設定メールのリンクで `/auth/reset-password` を開き、直近に使ったパスワードを入れる | 422 `VALID_PASSWORD_HISTORY`。別のパスワードなら 200 → ページは今までどおり全端末をログアウト (`signOut global`)。リンクの形 (PKCE の code → `amr` `recovery` / token_hash → `amr` `otp`) のどちらでも通る |
| S-15 | 攻撃者 (ログイン中のセッションを盗んだ) | `/auth/reset-password` を開いて現在のパスワード無しで変えようとする | 403 `AUTH_RECOVERY_SESSION_REQUIRED` (`amr` に 60 分以内の `recovery` / `otp` が無い。盗んだセッションは `password` / `oauth`)。今までは通っていた (改善) |
| S-16 | admin | `/admin/users/{id}` を開く | 「ログイン履歴」の節に直近 20 回 (日時・端末・IP・国・印・終了)。`admin_audit_logs` に `admin.user.view_login_history` が 1 行。support には節が出ない (API も 403) |
| S-17 | モバイルの利用者 | 30 日アプリを開かない | 03:55 JST のジョブが `auth.sessions` を消す (`idle_expired`)。次に開くと refresh が失敗 → ログイン画面 (既存の #1599 の流れ) |
| S-18 | 利用者 (停止リストに載っている・送信ドメイン未検証) | 新しい端末からログイン | worker は送信を試み、`sendEmail` が失敗 → `alert_sent_at` は NULL のまま `done`。印 (`is_new_device`) は残る。再送はしない |
| S-19 | Vercel Cron | 同じ回を 2 回呼ぶ | 行の取り置きは `alert_status = 'pending'` の条件つき UPDATE で原子的。Idempotency-Key `login-alert:<session_id>` で Resend も 1 通 |
| S-20 | DB | トリガー関数が失敗する (列が無い・権限) | EXCEPTION で握り、WARNING を残して RETURN NULL。ログイン・サインアップ・パスワード更新は成功する (R-13) |
| S-21 | Google だけでログインしている利用者 | パスワード変更の API を直接呼ぶ | 409 `AUTH_PASSWORD_NOT_SET` (画面はフォームを出さない。既存) |
| S-22 | super_admin | パスワード変更 | 直近 10 世代と比べる |
| S-23 | モバイルの利用者 | アプリの WebView で Web の画面を開く | WebView は native-bridge でネイティブと同じセッションを借りる (mobile/05 §6.1)。一覧には「ほめゴハンのアプリ」の 1 行だけ。失効させるとアプリも WebView も終わる |
| S-24 | 利用者 (退会) | アカウントを削除 | `auth.users` の削除で `user_sessions_metadata` と `password_history` は FK の CASCADE で消える (既存の DDL)。GoTrue の `Logout` で先に行が終わる |
| S-25 | 攻撃者 (利用者は 100 日前に iPhone のアプリでログインし、refresh で使い続けている) | Windows の Chrome からログイン | prior に 100 日前に作られた live の行 (`ios/app`) が入る (期間で絞らない) → `windows/chrome` は新しい → `new_device` でメール |
| S-26 | 攻撃者 (利用者は 120 日使っていない。最後のセッションは 30 日で終わり、その 90 日後に行は消えた) | ログイン | prior は空。アカウントは 90 日より前に作られている → `history_expired` (新しい端末として扱う) でメール |
| S-27 | モバイルの利用者 | アプリの「パスワードを忘れた？」→ メールのリンク (implicit: フラグメント → `setSession`) → 再設定の画面で新しいパスワード | `POST /api/auth/password/reset` (Bearer だけ) → `amr` に 60 分以内の `otp` → 照合 → GoTrue の `PUT /user` を Bearer の JWT で → 200 → 既存の `signOutWithCleanup` |

## 6. 構想 (相 2) — 構造と、全シナリオのトレース

### 6.1 構造

```
   Web browser ─(Cookie)─▶ POST /api/auth/login ─▶ signInWithPassword ─▶ GoTrue ─INSERT auth.sessions─┐
   Web browser ─(OAuth)──▶ /auth/callback ───────▶ exchangeCodeForSession ─▶ GoTrue ─INSERT auth.sessions─┤
   mobile app ──(直接)───▶ GoTrue ─INSERT auth.sessions ───────────────────────────────────────────────┤
   攻撃者 (anon key) ────▶ GoTrue ─INSERT auth.sessions ───────────────────────────────────────────────┤
                                                                                                        ▼
                         AFTER INSERT  on_auth_session_created ──▶ user_sessions_metadata (pending) + user_profiles.last_login_at/login_count
                         AFTER UPDATE  on_auth_session_refreshed ─▶ last_active_at
                         AFTER DELETE  on_auth_session_deleted ───▶ revoked_at / ended_reason
   Web の 2 route は直後に recordWebLoginContext(session_id, ip, ua, country) で上書き (context_source = 'web')
   モバイルは PATCH /api/auth/sessions/current { device_name } (context_source = 'mobile')
                                                                                                        │
   GET /api/cron/login-alerts (毎分) ──claim──▶ decideLoginAlert(current, prior = 同じ利用者の前の行すべて, horizon = アカウントの作成日時) ──▶ sendEmail(login_new_device) ──▶ done
   GET /api/auth/sessions / login-history ◀── RLS (本人の行)          DELETE /api/auth/sessions/{id} ──▶ RPC auth_session_revoke ──DELETE auth.sessions──▶ (DELETE トリガー)
   POST /api/auth/sessions/revoke-others ──▶ signOutOtherSessions (admin.auth.admin.signOut(本人の access token, 'others')) ──▶ GoTrue ─DELETE auth.sessions (他)─▶ (DELETE トリガー)
   GET /api/admin/users/{id}/login-history ◀── service_role + 監査
   POST /api/auth/password/change|reset ──▶ RPC auth_password_check (crypt) ──ok──▶ updatePasswordWithAccessToken (本人の access token で PUT /auth/v1/user) ──▶ GoTrue ─UPDATE auth.users.encrypted_password─▶ AFTER UPDATE on_auth_user_password_changed ──▶ password_history (直近 10 件に切り詰め)
   (本人の access token = readSessionAuth が検証した token。Web は Cookie のセッションの token、モバイルは Bearer の JWT)
```

- **記録の真は `auth.sessions` / `auth.users` の変化だけ**。アプリは「ログインした」を自分で申告しない (申告は漏れる・偽れる)。アプリが足すのは、トリガーが知り得ない文脈 (Web の実 IP / UA / 国、モバイルの端末名) だけで、どれも後から同じ行に上書きする。
- **判定は純関数 2 つ**: `decideLoginAlert` (§12.3) と `deviceFamilyOf` (§12.1)。I/O (行の読み書き・メール) は worker が集めて渡す。
- **失効は DELETE 1 文**: `auth_session_revoke` が `auth.sessions` から消す。GoTrue 自身のログアウトと同じ結果になり、DELETE トリガーが終了を刻むので、「アプリの表だけ revoke 済み」という食い違いが生まれない。
- **パスワードの照合は DB の中で、更新は本人の access token で**: 平文を受けるのはサーバーの route だけ。ハッシュは DB から出さない (`crypt()` で比べる)。更新は `updatePasswordWithAccessToken` (本人の access token で GoTrue の `PUT /auth/v1/user`) → GoTrue が他のセッションを消す (P-1)。`createClient()` の `auth.updateUser` は使わない (Bearer だけの要求では保管にセッションが無く `AuthSessionMissingError` §3)。`admin.updateUserById` も使わない (本人のセッションまで消える §3)。
- **他の端末のログアウトも本人の access token で**: `signOutOtherSessions` が `auth.admin.signOut(token, 'others')` を呼ぶ。`createClient()` の `auth.signOut({ scope: 'others' })` は、Bearer だけの要求では GoTrue を呼ばずに成功を返す (§3) ので使わない。
- **worker は取り置き → 判定 → 送信 → 完了の 4 手**で、行の状態 (`alert_status`) が進行を表す (§10)。

### 6.2 トレース (構造で手で走らせた結果)

| # | 経路 | 通る関数・判定 | 結果 |
|---|---|---|---|
| S-1 | `/api/auth/login` → `performGuardedLogin` → `signIn` (GoTrue INSERT → トリガー → 行 `pending`, `context_source='auth'`, UA `node`) → route が `getClaims(access_token)` で `session_id` → `recordWebLoginContext` (IP / UA / 国。`context_source='web'`) → 200 | worker: prior 0 件・アカウントは作ってから 90 日以内 → `first_login` → `done` | 通知無し。`GET /api/auth/sessions` が `is_current=true` の 1 行 |
| S-2 | 同上 (Firefox) | worker: prior 1 件 (`windows/chrome`) ≠ `windows/firefox` → `isNewDevice` → `renderLoginNewDeviceEmail` → `sendEmail` → `alert_sent_at` | メール 1 通 |
| S-3 | モバイル `signInWithPassword` (GoTrue INSERT → トリガー: `CFNetwork` → 後で `ios/app`) → `AuthProvider` の SIGNED_IN → `registerDeviceName` → `PATCH /api/auth/sessions/current` (`device_name`, `context_source='mobile'`) | worker: `ios/app` は新 → メール | 一覧に端末名つきの行 |
| S-4 | GoTrue 直接 → INSERT → トリガー (端末の実 UA) | worker: 新しい端末の種類ならメール | 本人が S-7 で失効 |
| S-5 | `signOut()` → GoTrue DELETE → `on_auth_session_deleted` (`signed_out`) → 再ログイン → INSERT | worker: 同じ `deviceFamilyKey`・同じ `ip_network` → `known` | 通知無し |
| S-6 | `/auth/callback` → `exchangeCodeForSession` (INSERT) → `recordWebLoginContext` | S-1 と同じ | 国は `x-vercel-ip-country` |
| S-7 | `DELETE /api/auth/sessions/{id}` → `requireUser` → `revokeSession` → RPC: `auth.uid()` 一致・`auth.jwt()->>'session_id'` ≠ id → `ended_reason='revoked_by_user'` → `DELETE auth.sessions` → トリガー (`revoked_at`) → `'revoked'` → 200 | 相手の端末: Web は middleware の `getUser()` が `session_not_found` → `/login`。モバイルは `getUser()` の失効 → SIGNED_OUT (AuthProvider の表) | 履歴に `revoked_by_user` |
| S-8 | 同上で id = 自分の `session_id` | RPC `'current'` → 409 | 何も消えない |
| S-9 | `POST /api/auth/sessions/revoke-others` → `requireUser` → `readSessionAuth` (Web: Cookie のセッションの token / モバイル: Bearer の JWT) → `signOutOtherSessions(getSupabaseAdmin(), session.accessToken)` → GoTrue `/logout?scope=others` (JWT の `session_id` 以外を DELETE) → DELETE × n → トリガー | 200 `{ ok: true, remaining }` (`listLiveSessions` で数え直す) | この端末は残る。Web とモバイルで同じ経路 |
| S-10 | 既存の画面 → `signOut()` (global) → DELETE × n | `signed_out` | 変更なし |
| S-11 | `POST /api/auth/password/change` → `requireUser` → Zod → `validatePassword` → roles → `generations=3` → RPC `auth_password_check(uid, current, new, 3)` → `'current_mismatch'` | `performPasswordChange` → `{ kind: 'current_mismatch' }` → 400 | `updateUser` は呼ばれない |
| S-12 | 同上 → `crypt(new, history[1])` が一致 → `'reused'` | 422 `VALID_PASSWORD_HISTORY` | 同上 |
| S-13 | 同上 (route は `readSessionAuth` で本人の access token を持つ) → `'ok'` → `updatePasswordWithAccessToken(session.accessToken, new)` (`PUT /auth/v1/user`。Web は Cookie のセッションの token、モバイルは Bearer の JWT) → GoTrue: UPDATE `encrypted_password` → `on_auth_user_password_changed` (INSERT + 切り詰め) → `LogoutAllExceptMe` → DELETE トリガー | 200 `{ ok: true }` | 一覧は 1 行。モバイルも同じ |
| S-14 | `/auth/reset-password` → `POST /api/auth/password/reset` → `readSessionAuth` → `hasRecentRecoveryMethod` = true (`recovery` または `otp`) → RPC (`p_current_password` = NULL) → `'reused'` → 422 / `'ok'` → `updatePasswordWithAccessToken` → 200 → ページの `signOutEverywhere` (既存) | 既存の順 (clear → signOut global → broadcast) は変えない | テスト N-25 は API の呼び出しを足すだけ |
| S-15 | 同上。`amr` = `[{ method: 'password' }]` → `hasRecentRecoveryMethod` = false | 403 `AUTH_RECOVERY_SESSION_REQUIRED` | 変更されない |
| S-16 | page → `adminFetch('/api/admin/users/{id}/login-history')` → `requireRole(['admin','super_admin'])` → `isUuid` → `getSupabaseAdmin()` で 20 行 → 1 行以上なら `recordAdminAudit('admin.user.view_login_history')` → `{ data: { entries } }` | support: 403 → page は節を描かない (`actor.roles` で呼び分け) | 監査 1 行 |
| S-17 | `expire_idle_auth_sessions()`: `refreshed_at` が 30 日より古い → `ended_reason='idle_expired'` → `DELETE auth.sessions` → トリガー | アプリ: refresh 400 → SIGNED_OUT | 行は 90 日後に消える |
| S-18 | worker → `sendEmail` が `{ ok: false }` → `finishLoginAlert(status 'done', sentAt null)` | 再送しない (`alert_attempts` は例外のときだけ増える) | 印は残る |
| S-19 | 2 つの worker が同じ `pending` 行を `UPDATE … WHERE alert_status='pending'` → 片方だけ RETURNING | Resend は同じキーで 2 通目を送らない | 1 通 |
| S-20 | トリガー本体で例外 → `EXCEPTION WHEN OTHERS` → `RAISE WARNING` → `RETURN NULL` | GoTrue のトランザクションは続く | 記録だけ欠ける |
| S-21 | RPC: `encrypted_password` が NULL → `'no_password'` | 409 | — |
| S-22 | `passwordHistoryGenerationsFor(['super_admin'])` = 10 | RPC の `LIMIT 10` | — |
| S-23 | native-bridge は `setSession` で Cookie を張るだけ (GoTrue に新しい行は無い) | 一覧は `ios/app` の 1 行 | — |
| S-24 | `auth.users` DELETE → FK CASCADE | 行が消える (トリガーは `auth.sessions` の DELETE で先に `signed_out` を書くが、その後 CASCADE で消える) | — |
| S-25 | GoTrue INSERT → トリガー → worker: `priorLogins` = `listPriorLogins` (`created_at < row.created_at`・期間で絞らない) に 100 日前の live の行 (`ios/app`) | `decideLoginAlert`: prior 1 件・`windows/chrome` は無い → `new_device` → `send` | メール 1 通 (§10.1 の行 5) |
| S-26 | 同上。`listPriorLogins` は 0 件 (終わった行は 90 日で消えた) → `accountOf` の `createdAt` は 90 日より前 | `decideLoginAlert`: prior 空・アカウントの年齢 > 90 日 → `history_expired` (`isNewDevice` = 端末の種類が分かる) → `send` | メール 1 通 (§10.1 の行 2) |
| S-27 | `authLink.ts` の `setSession` (implicit) → 再設定の画面 → `getApi().post('/api/auth/password/reset')` (Bearer) → `readSessionAuth` (Bearer の JWT。`amr` `otp`) → `hasRecentRecoveryMethod` = true → RPC → `'ok'` → `updatePasswordWithAccessToken(Bearer の JWT, new)` → 200 | 画面は既存の `signOutWithCleanup` | 変更される |

## 7. 構造裁定 (相 3・1 回だけ)

### 7.1 代替案の比較

| 論点 | 案 | 採否 | 理由 |
|---|---|---|---|
| **ログインの記録の入口** | (a) `auth.sessions` の INSERT / UPDATE / DELETE トリガー | **採用** | 呼ぶ側 (Web・モバイル・攻撃者の直接呼び出し) が選べない場所。1 行 = 1 セッションなので一覧と履歴が同じ表で済む。`ip` / `user_agent` は作成時に入る (§3) |
| | (b) アプリの各ログイン経路で INSERT (Web の 2 route + モバイルの申告 API) | 不採用 | anon キーで GoTrue を直接呼ぶ攻撃者 (S-4) と、申告を呼ばない旧アプリ・OAuth の新経路が漏れる。#1190 の目的 (乗っ取りの早期発見) に対して構造的な穴 |
| | (c) pg_cron で `auth.sessions` を毎分写す | 不採用 | 1 分の遅れで「ログイン直後に一覧に自分が居ない」。同じ分の中で作られて消えたセッションを取りこぼす。終了の時刻が近似になる |
| | (d) Supabase Auth Hook (Custom Access Token) | 不採用 | 入力に IP / UA が無い。発行のたび (refresh) に呼ばれ、ログインと区別できない |
| **Web の実 IP / UA** | (a) Web の 2 route がログインの直後に同じ行を上書き (`recordWebLoginContext`) | **採用** | GoTrue が記録する Web の UA は `node`・IP は Vercel (§3)。上書きはトリガーの INSERT より後 (同じ要求の中) で、worker は作成から 15 秒は判定しない |
| | (b) middleware で毎要求に上書き | 不採用 | 全要求に DB の書き込みが増える |
| **端末の判定の単位** | (a) OS × クライアント (ブラウザ / アプリ) の種類 (`deviceFamilyOf`) | **採用** | UA の生の文字列はブラウザの更新で毎回変わり、更新のたびに「新しい端末」になる。種類で比べれば更新では鳴らない |
| | (b) UA の生の文字列 | 不採用 | 上 |
| **IP の扱い** | (a) /24 (v6 は /48) の範囲を記録・表示し、通知の条件には使わない | **採用** | 携帯回線 (CGNAT) と家庭の回線は接続ごとに範囲が変わり、本人のログインのたびに鳴る。鳴りすぎる通知は無視される。端末の種類と国で鳴らす (Google / GitHub と同じ方針)。変えるなら `decideLoginAlert` 1 か所 (§25 Q-4) |
| | (b) 新しい IP の範囲でも通知 | 不採用 | 上 |
| **地域** | (a) Web の経路だけ Vercel の `x-vercel-ip-country` を記録し、国が分かっている行どうしで比べる | **採用** | 外部の GeoIP に利用者の IP を送らない。モバイルは NULL (比べない) |
| | (b) GeoIP の外部 API | 不採用 | 依存・費用・IP の第三者提供 |
| **通知の実行** | (a) Vercel Cron (毎分) の worker が `pending` の行を取り置いて処理 | **採用** | 経路を問わず 1 本。既存の `*/1 * * * *` と `requireCronAuth`・`claim` の形 (app-log-alerts) に揃う |
| | (b) トリガーから pg_net で API を叩く | 不採用 | 秘密を DB に置く経路が増える (Vault はあるが、ログインのたびに HTTP が出る)。失敗の再試行が無い |
| | (c) Web の login route の中で送る | 不採用 | モバイル・直接の経路を取りこぼす (= (b) の記録の案と同じ穴) |
| **失効の手段** | (a) SECURITY DEFINER の RPC で `auth.sessions` を DELETE | **採用** | GoTrue のログアウトと同じ結果 (refresh 失敗・`session_not_found`)。cross/01 §4.4 の `admin.signOut(sessionId)` は存在しない (`admin.signOut(jwt, scope)` は JWT を要る) |
| | (b) アプリの表に `revoked_at` を書き、middleware で照合 | 不採用 | GoTrue のセッションは生きたまま。PostgREST を直接呼ぶモバイル・攻撃者には効かない。2 つの真ができる |
| **パスワード履歴の記録** | (a) `auth.users.encrypted_password` の UPDATE トリガーで GoTrue のハッシュをそのまま写す | **採用** | どの経路 (管理 API・リセット・変更) でも漏れない。ハッシュを作り直さない (GoTrue の bcrypt cost 10 のまま) |
| | (b) API が自分でハッシュして INSERT | 不採用 | API を通らない更新 (GoTrue の `/user` を直接) が漏れる。ハッシュの二重管理 |
| **照合の場所** | (a) DB の `auth_password_check` (pgcrypto `crypt()`) | **採用** | ハッシュが DB の外に出ない。平文はサーバーの route から PostgREST の本文 (TLS) で 1 回だけ渡る。bcrypt の比較は C で 1 回 50〜100 ms |
| | (b) Node の bcryptjs | 不採用 | 依存が増え、ハッシュを service_role で読み出す。JS の bcrypt は 2〜3 倍遅い |
| **現在のパスワードの確認** | (a) 同じ RPC で `auth.users.encrypted_password` と比べる | **採用** | セッションを作らない (いまの browser の `signInWithPassword` は新しい `auth.sessions` の行 = 偽のログイン記録 + Turnstile が要る) |
| | (b) 今までどおり browser が `signInWithPassword` | 不採用 | 上。記録に「変更のたびのログイン」が混ざる |
| **更新の呼び方** | (a) 本人の access token (`readSessionAuth` が検証した token) で GoTrue の `PUT /auth/v1/user` を直接呼ぶ (`updatePasswordWithAccessToken` §13.7) | **採用** (R1 で改めた) | GoTrue が他のセッションを消し、本人のは残す (P-1 / P-2)。Cookie の Web と Bearer だけのモバイルが同じ経路になる |
| | (b) 本人のセッション (`createClient()`) の `auth.updateUser` | 不採用 (R1) | Bearer だけの要求ではサーバーの client の保管にセッションが無く、auth-js が `AuthSessionMissingError` を投げる (§3)。モバイルの変更・再設定が毎回 500 になる |
| | (c) `admin.updateUserById` | 不採用 | 本人のセッションも消える (§3) |
| **他の端末のログアウトの呼び方** | (a) `auth.admin.signOut(本人の access token, 'others')` (`signOutOtherSessions`) | **採用** (R1) | JWT を明示して GoTrue の `/logout?scope=others` を呼ぶ。Web とモバイルが同じ経路 |
| | (b) `createClient()` の `auth.signOut({ scope: 'others' })` | 不採用 (R1) | Bearer だけの要求では GoTrue を呼ばずに `{ error: null }` を返す (§3)。モバイルで何も消さずに 200 になる |
| **再設定の認可** | (a) `amr` に 60 分以内の `recovery` または `otp` (`RECOVERY_AMR_METHODS`) | **採用** (R1 で `otp` を加えた) | 盗んだ普通のセッション (`password` / `oauth`) で現在のパスワード無しに変える穴 (S-15) を閉じる。再設定のリンクの形で `amr` が変わる (PKCE の code → `recovery`、token_hash / implicit → `otp` §3) ので両方を受ける。`otp` はメールのリンク / コードでメールボックスを持つことを示したセッションで、`recovery` と同じ強さ。`getClaims` は署名を確かめる |
| | (b) `recovery` だけ | 不採用 (R1) | token_hash (Web の `/auth/callback`)・implicit (モバイル) の正当な再設定が全部 403 になる |
| **不審の判定の比べる相手** | (a) 同じ利用者の前の行すべて (`created_at < row.created_at`。期間では絞らない) + アカウントの作成日時で「履歴が消えた」を見分ける | **採用** (R1) | 長く続く live の行は消えないので必ず入る (S-25)。終わった行は 90 日で消えるので、作成から 90 日を過ぎたアカウントで prior が空なら、初めてと断定できない → 知らせる (S-26)。作成から 90 日以内なら消えた行は無い (消すのは `revoked_at` が 90 日より前の行だけ) ので、prior が空なら本当に初めて |
| | (b) 直近 90 日に作られた行だけ | 不採用 (R1) | 90 日より前に作られて今も続く端末を取りこぼし、乗っ取りを `first_login` と誤る |
| | (c) `user_profiles.login_count` で初めてかを見る | 不採用 (R1) | 新規登録の直後の最初のログインでは `user_profiles` の行がまだ無い (行は同意・初期設定で作られる。migration 20261008200700 の `INSERT INTO public.user_profiles` の注記) ので、数が当てにならない |
| **放置されたセッション** | (a) 30 日の 1 値を DB のジョブで | **採用** | GoTrue は消さない (§3)。1 値なら SQL の定数 1 つ。ロール別 (cross/01 §4.1) は §25 Q-3 |
| **既存の表** | (a) `user_sessions_metadata` に列を足し、`password_history` はそのまま | **採用** | 正典 (operator/01 §3.23 / §3.25) の stub をそのまま埋める。`sessions_revoke_self` (本人の UPDATE) は消す (本人が印や終了を書き換えられる) |

### 7.2 F の問い — 縁の発生源を消すより単純な構造は無いか

- 記録の入口は `auth.sessions` のトリガー 1 つに畳んだ。アプリ側の「文脈の上書き」は Web の 2 route とモバイルの 1 call の 3 か所で、どれも無くても記録は残る (端末の種類が `other/server` / 端末名無しになるだけ)。
- 残る縁は 5 つで、いずれもテスト (§20) が見張る: ① Web で GoTrue に新しいセッションを作る route が増えたのに `recordWebLoginContext` を呼ばない (走査 `tests/auth/web-login-context-source-scan.test.ts`: `exchangeCodeForSession` / `verifyOtp` / `signInWithPassword` を呼ぶ `src/app/**/route.ts` は同じ handler で `recordWebLoginContext` を呼ぶ) ② `password_history` の切り詰め数と TS の世代数の最大が食い違う (契約テスト) ③ SQL の 30 日 / 90 日 / `/24` / `/48` と TS の定数が食い違う (契約テスト) ④ パスワードを更新する画面が API を通らず `updateUser({ password })` を直接呼ぶ (走査 `tests/auth/password-update-source-scan.test.ts`: `src/`・`apps/mobile/` の本番コードで `updateUser({ password` は 0 件)。 ⑤ 本人として GoTrue を変える route が、サーバーの client の `auth.updateUser` / `auth.signOut` に戻り、Bearer だけのモバイルの要求で黙って失敗する (同じ走査: `revoke-others` と `password/**` の route は `auth.signOut(` / `auth.updateUser(` を呼ばない。結合テスト §20.3 が Bearer だけの更新・失効を実 GoTrue で確かめる)。
- 「申告しない (トリガー) + 文脈だけ上書き」より単純な構造 (申告だけ) は、S-4 を取りこぼす。「上書きもしない」は Web の記録が全部 `node` / Vercel の IP になる。

**構造を確定する。以後の蒸し返しは裁定への差し戻し事由として別に扱う。**

## 8. ① 全パターン表 (出来事 × 経路 → 記録)

| # | 出来事 | 経路 | `auth.sessions` | トリガー | アプリ | 行の結果 |
|---|---|---|---|---|---|---|
| 1 | パスワードでログイン | Web `/api/auth/login` | INSERT (UA `node`) | created | `recordWebLoginContext` | `web`・実 IP / UA / 国・`pending` |
| 2 | パスワードでログイン | モバイル (直接) | INSERT (端末の UA) | created | `PATCH sessions/current` | `mobile`・端末名・`pending` |
| 3 | Google / Apple でログイン | Web `/auth/callback` (code) | INSERT | created | `recordWebLoginContext` | 1 と同じ |
| 4 | Google でログイン | モバイル (`authLink.ts` の exchange) | INSERT | created | `PATCH sessions/current` | 2 と同じ |
| 5 | メールのリンク (確認・招待・再設定) | Web `/auth/callback` (token_hash) / モバイル `authLink.ts` | INSERT | created | 1 / 2 と同じ | `recovery` の行も 1 ログイン |
| 6 | anon キーで GoTrue を直接 | 攻撃者 | INSERT | created | 無し | `auth`・GoTrue の実 IP / UA・`pending` |
| 7 | トークンの更新 | Web middleware (サーバー) / モバイル auth-js | UPDATE `refreshed_at` (UA / IP も上書きされるが読まない) | refreshed | 無し | `last_active_at` |
| 8 | WebView の bridge | `/auth/native-bridge` (`setSession`) | 変化なし | — | 無し | ネイティブの行のまま (S-23) |
| 9 | ログアウト (global) | Web の各画面・モバイル `signOut.ts` | DELETE × 全部 | deleted | 無し | `signed_out` |
| 10 | 他の端末をログアウト | `POST /api/auth/sessions/revoke-others` (Web の Cookie / モバイルの Bearer。どちらも本人の access token で `admin.signOut(token, 'others')`) | DELETE × 他 (GoTrue) | deleted | route | `signed_out` |
| 11 | 1 端末を失効 | `DELETE /api/auth/sessions/{id}` | DELETE × 1 (RPC) | deleted | route | `revoked_by_user` |
| 12 | パスワード変更 | `POST /api/auth/password/change` (Web / モバイル。本人の access token で `PUT /auth/v1/user`) | DELETE × 他 (GoTrue) | deleted + `auth.users` の password_changed | route | 他は `signed_out`。`password_history` +1 |
| 13 | パスワード再設定 | `POST /api/auth/password/reset` (Web / モバイル。同上) → 画面の全端末のログアウト (Web `signOut global` / モバイル `signOutWithCleanup`) | DELETE × 他 → DELETE × 自分 | 同上 | route + 画面 | 同上 |
| 14 | サインアップ (パスワード) | Web / モバイル | INSERT (確認後のログイン時) + `auth.users` INSERT | password_changed (INSERT) | — | `password_history` +1 |
| 15 | 管理 API でパスワードを変える | 運営 (本書は使わない) | DELETE × 全部 | deleted + password_changed | — | 漏れない |
| 16 | MFA の verify (cross/12) | — | DELETE × 他 (GoTrue) | deleted | — | `signed_out` |
| 17 | 放置 30 日 | pg_cron 03:55 JST | DELETE (関数) | deleted | — | `idle_expired` |
| 18 | 退会 | `/api/account/delete` | DELETE (GoTrue `Logout`) → `auth.users` DELETE | deleted | — | 行は CASCADE で消える |
| 19 | 終了から 90 日 | pg_cron 03:55 JST | — | — | — | 行を消す |
| 20 | `auth.sessions` の行がトリガーを通らず消えた | 保守 | — | — | — | 03:55 JST の照合で `signed_out` に揃える |

## 9. ② 状態比較表 (現行 vs 設計後)

| 面 | 現行 (origin/main) | 設計後 |
|---|---|---|
| ログインの記録 | 無し (`user_sessions_metadata` 0 行。cross/01 §3.2 の INSERT は未実装) | `auth.sessions` のトリガーが全経路を記録 (§11.3) |
| `user_profiles.last_login_at` / `login_count` | 誰も書かない (運営の画面は `-`) | INSERT トリガーが書く |
| 不審なログインの通知 | 無し | 新しい端末の種類 / 国でメール (§12.3・§18) |
| セッションの一覧 | 無し | `/settings/security/sessions` (Web)・`settings/sessions` (モバイル)・`GET /api/auth/sessions` |
| 個別の失効 | 無し (`signOut()` の global だけ) | `DELETE /api/auth/sessions/{id}` → RPC |
| 他の端末のログアウト | パスワード変更の副作用だけ | `POST /api/auth/sessions/revoke-others` (Web / モバイル。本人の access token で GoTrue の `/logout?scope=others`) |
| 不審の判定の比べる相手 | — | 同じ利用者の前の行すべて (期間で絞らない) + アカウントの作成日時 (§10.1) |
| 放置されたセッション | 永久に残る (1,331 行) | 30 日で終える (pg_cron) |
| パスワード変更 (Web / モバイル) | browser / 端末が `signInWithPassword` → `updateUser` → `signOut({scope:'others'})` (Web は Turnstile つき) | `POST /api/auth/password/change` (現在のパスワードは DB で確認・履歴の照合・更新は本人の access token で `PUT /auth/v1/user`。他の端末の失効は GoTrue が同じ更新の中で行う。Turnstile は要らない)。成功の表示は常に「この端末以外のログインはすべて解除しました」(「他の端末のログアウトを確認できませんでした」の注意書きは無くなる) |
| パスワード再設定 | 画面が `updateUser` → 全端末のログアウト | 画面が `POST /api/auth/password/reset` (`amr` の `recovery` / `otp` の確認・履歴の照合) → 今までどおり全端末のログアウト |
| `password_history` | 0 行 (stub) | トリガーで全経路を記録。既存 195 人分は migration で写す |
| 運営の利用者詳細 | 最終ログインの 1 列 | 1 列 + ログイン履歴の節 (admin / super_admin。監査つき) |
| `sessions_revoke_self` (本人の UPDATE ポリシー) | ある (本人が印・終了を直接書ける) | 消す。本人は SELECT だけ。書くのは service_role・RPC・トリガー |
| `secure_password_change` 前提 | 直前の `signInWithPassword` で回避 | OFF を前提 (§24)。ON なら 403 `AUTH_REAUTHENTICATION_REQUIRED` (ログインし直し) |
| cross/12 (MFA) との関係 | — | 独立。verify の他セッション失効は `signed_out` として記録される |

## 10. ③ 状態遷移表

`user_sessions_metadata` の 1 行 (`live` = `revoked_at IS NULL`)。`alert_status` は `pending → processing → done` の一方向。

| 状態 (live / alert) | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| (無し) | `auth.sessions` INSERT | live / pending | `ON CONFLICT (session_id) DO NOTHING` | `user_profiles.last_login_at` / `login_count` |
| (無し) | migration の写し (既存の 1,331 行) | live / done | 既存の行だけ | 通知はしない (`is_new_*` NULL) |
| live / pending | Web route の `recordWebLoginContext` | live / pending | `context_source='auth'` の行だけ上書き (mobile の端末名は消さない) | `ip_address` / `ip_network` / `user_agent` / `country_code` / `context_source='web'` |
| live / * | `PATCH sessions/current` | 同じ | 本人の `session_id` の行 | `device_name` / `context_source='mobile'` |
| live / pending | worker の取り置き | live / processing | `created_at <= now - 15 s`、`alert_status='pending'` または (`processing` かつ `alert_claimed_at < now - 10 分`) | `alert_claimed_at = now` |
| live / processing | 判定 → 送信 (必要なら) | live / done | — | `device_family` / `is_new_*` / `alert_sent_at` (送れたとき) |
| live / processing | 例外 | live / pending (`alert_attempts + 1`) または done (`attempts >= 3`) | — | ログ |
| live / * | `auth.sessions` UPDATE `refreshed_at` | 同じ | — | `last_active_at` |
| live / * | `auth.sessions` DELETE (ログアウト・GoTrue の失効・MFA) | ended (`signed_out`) / 同じ | `ended_reason` が未設定のときだけ `signed_out` | `revoked_at = now` |
| live / * | RPC `auth_session_revoke` | ended (`revoked_by_user`) | `user_id = auth.uid()`・`session_id ≠ auth.jwt()->>'session_id'` | DELETE → 上の行 |
| live / * | `expire_idle_auth_sessions` | ended (`idle_expired`) | `COALESCE(refreshed_at, created_at) < now - 30 日` | DELETE → 上の行 |
| live / * | `reconcile_user_sessions_metadata` | ended (`signed_out`) | `auth.sessions` に行が無い | `revoked_at = now` |
| ended / * | `cleanup_ended_user_sessions_metadata` | (消える) | `revoked_at < now - 90 日` | — |
| * | `auth.users` DELETE | (消える) | FK CASCADE | — |

`password_history`: (無し) → `auth.users` INSERT / UPDATE OF `encrypted_password` (NULL でない・前と違う) → 行 +1 → 同じ利用者の行が 10 を超えたら古い順に消える → `auth.users` DELETE で CASCADE。

### 10.1 worker の判定の入力 × 結果 (`decideLoginAlert` の全パターン)

prior = `listPriorLogins` が返す、同じ利用者の `created_at < row.created_at` の行 (live・終わった行の両方。期間では絞らない。自分の行は含めない)。アカウントの年齢 = worker の `now()` − `auth.users.created_at`。保持 = `LOGIN_HISTORY_RETENTION_DAYS` (90 日)。

| # | prior | アカウントの年齢 | current の端末の種類 | 国・IP の範囲 | reason | `isNewDevice` / `isNewIp` / `isNewCountry` | 送る |
|---|---|---|---|---|---|---|---|
| 1 | 空 | ≤ 保持 | 何でも | 何でも | `first_login` | false / false / false | 送らない (S-1) |
| 2 | 空 | > 保持 | `other/server` 以外 | 何でも | `history_expired` | true / (`ip_network` があれば true) / false | 送る (S-26) |
| 3 | 空 | > 保持 | `other/server` | 何でも | `history_expired` | false / (同上) / false | 送らない (端末が分からない) |
| 4 | 1 件以上 (90 日より前に作られた live の行を含む) | 問わない | prior に同じ種類がある、または `other/server` | 国が同じか、国の分かる prior が無い、または current の国が不明。IP の範囲は既知 | `known` | false / false / false | 送らない (S-5) |
| 5 | 1 件以上 (同上) | 問わない | prior に無い種類 | 行 4 と同じ | `new_device` | true / * / false | 送る (S-2・S-3・S-25) |
| 6 | 1 件以上 | 問わない | 既知 (行 4 と同じ) | 国の分かる prior があり、current の国がそのどれとも違う | `new_country` | false / * / true | 送る |
| 7 | 1 件以上 | 問わない | prior に無い種類 | 行 6 と同じ | `new_device_and_country` | true / * / true | 送る |
| 8 | 1 件以上 | 問わない | 既知 | 国は行 4 と同じ。IP の範囲だけが prior に無い | `known` | false / true / false | 送らない (記録のみ §7.1) |

`*` = IP の範囲の新旧で変わる (送るかどうかには効かない)。行 1 が「初めて」と断定できる理由: 終わった行が消えるのは `revoked_at < now − 90 日` のときだけ (§11.6) で、`revoked_at ≥ created_at ≥ auth.users.created_at` なので、アカウントの年齢が 90 日以下なら消えた行は 1 つも無い。live の行は保持で消えない (利用者の削除の CASCADE だけ)。行 2 は「作成から 90 日を過ぎてから初めてログインした」利用者にも当たり、その人には本人のログインでメールが 1 通届く (§25 Q-13)。

## 11. データモデル (migration の正典)

ファイル: `supabase/migrations/<番号はマージ時に確定>_auth_history_sessions.sql`・対の `supabase/rollbacks/<番号はマージ時に確定>_auth_history_sessions.down.sql`。番号はマージ直前に `origin/main` の `supabase/migrations` の最大より大きい値で確定する。土台は origin/main 5a48abc9 の DDL (migration 20251126124224:5750・6731・10727・10870・10874)。

### 11.1 `user_sessions_metadata` の列・索引・権限

```sql
-- 1. 列 (既存: session_id, user_id, device_name, ip_address, user_agent, created_at, last_active_at, revoked_at)
ALTER TABLE public.user_sessions_metadata
  ADD COLUMN IF NOT EXISTS ip_network     inet,
  ADD COLUMN IF NOT EXISTS country_code   character(2),
  ADD COLUMN IF NOT EXISTS context_source text NOT NULL DEFAULT 'auth',
  ADD COLUMN IF NOT EXISTS device_family  text,
  ADD COLUMN IF NOT EXISTS is_new_device  boolean,
  ADD COLUMN IF NOT EXISTS is_new_ip      boolean,
  ADD COLUMN IF NOT EXISTS is_new_country boolean,
  ADD COLUMN IF NOT EXISTS alert_status   text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS alert_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS alert_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alert_sent_at  timestamptz,
  ADD COLUMN IF NOT EXISTS ended_reason   text;

ALTER TABLE public.user_sessions_metadata
  ADD CONSTRAINT user_sessions_metadata_context_source_check CHECK (context_source IN ('auth', 'web', 'mobile')),
  ADD CONSTRAINT user_sessions_metadata_alert_status_check   CHECK (alert_status IN ('pending', 'processing', 'done')),
  ADD CONSTRAINT user_sessions_metadata_ended_reason_check   CHECK (ended_reason IS NULL OR ended_reason IN ('signed_out', 'revoked_by_user', 'idle_expired'));

COMMENT ON COLUMN public.user_sessions_metadata.context_source IS 'ip_address / user_agent の出どころ。auth = GoTrue の記録 (Web は Next.js のサーバーの値)、web = Web の route が request の値で上書き、mobile = アプリが端末名を登録';
COMMENT ON COLUMN public.user_sessions_metadata.ip_network IS 'IPv4 は /24、IPv6 は /48 (ホスト単位では比べない)';

-- 2. 索引 (既存: idx_sessions_user (user_id, last_active_at DESC))
CREATE INDEX IF NOT EXISTS idx_sessions_alert_queue ON public.user_sessions_metadata (created_at) WHERE alert_status <> 'done';
CREATE INDEX IF NOT EXISTS idx_sessions_ended       ON public.user_sessions_metadata (revoked_at) WHERE revoked_at IS NOT NULL;

-- 3. 権限とポリシー。本人は SELECT だけ (sessions_self は残す)。書くのは service_role・SECURITY DEFINER の関数・トリガーだけ
DROP POLICY IF EXISTS sessions_revoke_self ON public.user_sessions_metadata;
REVOKE ALL ON TABLE public.user_sessions_metadata FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_sessions_metadata TO authenticated;
REVOKE ALL ON TABLE public.password_history FROM PUBLIC, anon, authenticated;
```

`password_history` の列は変えない (`user_id, password_hash varchar(255), changed_at`・PK `(user_id, changed_at)`・`idx_password_history_user`・RLS `password_history_no_direct_access USING (false)`)。

### 11.2 既存の行の写し (1 回だけ。冪等)

```sql
-- 既存のセッション (1,331 行) を live として写す。通知はしない (alert_status = 'done')
INSERT INTO public.user_sessions_metadata
  (session_id, user_id, ip_address, ip_network, user_agent, created_at, last_active_at, context_source, alert_status)
SELECT s.id::text, s.user_id, s.ip,
       CASE WHEN s.ip IS NULL THEN NULL WHEN family(s.ip) = 4 THEN network(set_masklen(s.ip, 24)) ELSE network(set_masklen(s.ip, 48)) END,
       s.user_agent, s.created_at, COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.created_at), 'auth', 'done'
FROM auth.sessions s
ON CONFLICT (session_id) DO NOTHING;

-- 既存の利用者 (195 人) の現在のパスワードのハッシュを履歴の 1 件目にする (移行前の現在のパスワードも世代に数える)
INSERT INTO public.password_history (user_id, password_hash, changed_at)
SELECT u.id, u.encrypted_password, COALESCE(u.updated_at, u.created_at, pg_catalog.now())
FROM auth.users u
WHERE u.encrypted_password IS NOT NULL AND u.encrypted_password <> ''
  AND NOT EXISTS (SELECT 1 FROM public.password_history h WHERE h.user_id = u.id)
ON CONFLICT (user_id, changed_at) DO NOTHING;
```

### 11.3 トリガー関数 4 本 (SECURITY DEFINER・所有者 postgres・`search_path = ''`・失敗は握る)

```sql
CREATE OR REPLACE FUNCTION public.auth_session_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  -- 「同じ場所」とみなす範囲。src/lib/auth/sessions/constants.ts の IP_NETWORK_PREFIX_V4 / V6 と同じ値 (契約テスト §20.3)
  c_prefix_v4 CONSTANT integer := 24;
  c_prefix_v6 CONSTANT integer := 48;
BEGIN
  INSERT INTO public.user_sessions_metadata
    (session_id, user_id, ip_address, ip_network, user_agent, created_at, last_active_at, context_source, alert_status)
  VALUES
    (NEW.id::text, NEW.user_id, NEW.ip,
     CASE WHEN NEW.ip IS NULL THEN NULL
          WHEN family(NEW.ip) = 4 THEN network(set_masklen(NEW.ip, c_prefix_v4))
          ELSE network(set_masklen(NEW.ip, c_prefix_v6)) END,
     NEW.user_agent, NEW.created_at, COALESCE(NEW.refreshed_at AT TIME ZONE 'UTC', NEW.created_at), 'auth', 'pending')
  ON CONFLICT (session_id) DO NOTHING;

  UPDATE public.user_profiles
     SET last_login_at = NEW.created_at, login_count = COALESCE(login_count, 0) + 1
   WHERE id = NEW.user_id;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- 記録の失敗でログインを止めない (R-13)。値 (IP / UA) はログに出さない
  RAISE WARNING 'auth_session_created failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_session_refreshed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- refresh した側の user_agent / ip は写さない (Web の refresh は Next.js のサーバーが行う §3)
  UPDATE public.user_sessions_metadata
     SET last_active_at = COALESCE(NEW.refreshed_at AT TIME ZONE 'UTC', pg_catalog.now())
   WHERE session_id = NEW.id::text;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auth_session_refreshed failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_session_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.user_sessions_metadata
     SET revoked_at = COALESCE(revoked_at, pg_catalog.now()),
         ended_reason = COALESCE(ended_reason, 'signed_out')
   WHERE session_id = OLD.id::text;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auth_session_deleted failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.password_history_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  -- 残す世代の最大 = 運営の世代数 (cross/01 §7.1)。src/lib/auth/password/policy.ts の PASSWORD_HISTORY_MAX_GENERATIONS と同じ値 (契約テスト)
  c_max_generations CONSTANT integer := 10;
BEGIN
  IF NEW.encrypted_password IS NULL OR NEW.encrypted_password = '' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.encrypted_password IS NOT DISTINCT FROM NEW.encrypted_password THEN RETURN NULL; END IF;

  INSERT INTO public.password_history (user_id, password_hash, changed_at)
  VALUES (NEW.id, NEW.encrypted_password, pg_catalog.clock_timestamp())
  ON CONFLICT (user_id, changed_at) DO NOTHING;

  DELETE FROM public.password_history h
   WHERE h.user_id = NEW.id
     AND h.changed_at < (SELECT min(newest.changed_at)
                           FROM (SELECT changed_at FROM public.password_history
                                  WHERE user_id = NEW.id ORDER BY changed_at DESC LIMIT c_max_generations) AS newest);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'password_history_record failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

-- トリガー (auth の表に足すのはトリガーだけ。表・列は変えない)
DROP TRIGGER IF EXISTS on_auth_session_created ON auth.sessions;
CREATE TRIGGER on_auth_session_created AFTER INSERT ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION public.auth_session_created();
DROP TRIGGER IF EXISTS on_auth_session_refreshed ON auth.sessions;
CREATE TRIGGER on_auth_session_refreshed AFTER UPDATE OF refreshed_at ON auth.sessions
  FOR EACH ROW WHEN (OLD.refreshed_at IS DISTINCT FROM NEW.refreshed_at) EXECUTE FUNCTION public.auth_session_refreshed();
DROP TRIGGER IF EXISTS on_auth_session_deleted ON auth.sessions;
CREATE TRIGGER on_auth_session_deleted AFTER DELETE ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION public.auth_session_deleted();
DROP TRIGGER IF EXISTS on_auth_user_password_changed ON auth.users;
CREATE TRIGGER on_auth_user_password_changed AFTER INSERT OR UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.password_history_record();

-- 権限: 誰にも直接は実行させない (anon の番兵 §22 N-19)。トリガーは GoTrue (supabase_auth_admin) の文で動く
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['auth_session_created', 'auth_session_refreshed', 'auth_session_deleted', 'password_history_record'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO supabase_auth_admin', fn);
  END LOOP;
END $$;
```

### 11.4 RPC `auth_session_revoke` (本人の 1 端末の失効)

```sql
CREATE OR REPLACE FUNCTION public.auth_session_revoke(p_session_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_current text := auth.jwt() ->> 'session_id';
  v_deleted integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF v_current IS NOT NULL AND v_current = p_session_id::text THEN RETURN 'current'; END IF;

  UPDATE public.user_sessions_metadata SET ended_reason = 'revoked_by_user'
   WHERE session_id = p_session_id::text AND user_id = v_uid AND revoked_at IS NULL;
  DELETE FROM auth.sessions s WHERE s.id = p_session_id AND s.user_id = v_uid;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN
    UPDATE public.user_sessions_metadata SET ended_reason = NULL
     WHERE session_id = p_session_id::text AND user_id = v_uid AND revoked_at IS NULL;
    RETURN 'not_found';
  END IF;
  RETURN 'revoked';
END;
$$;
REVOKE ALL ON FUNCTION public.auth_session_revoke(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_session_revoke(uuid) TO authenticated;
COMMENT ON FUNCTION public.auth_session_revoke(uuid) IS '本人 (auth.uid()) のセッション 1 つを auth.sessions から消す。自分のセッション (auth.jwt() の session_id) は ''current''、無ければ ''not_found''、消せたら ''revoked''。終了は on_auth_session_deleted が刻む (ended_reason は先に revoked_by_user にしておく)。cross/16 §11.4';
```

### 11.5 RPC `auth_password_check` (現在のパスワードの確認と履歴の照合)

```sql
CREATE OR REPLACE FUNCTION public.auth_password_check(
  p_user_id uuid, p_current_password text, p_new_password text, p_generations integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c_max_generations CONSTANT integer := 10;   -- password_history_record と同じ
  c_bcrypt_prefix   CONSTANT text := '$2%';   -- pgcrypto の crypt() が比べられる bcrypt。ほかの形式は比べない
  v_hash   text;
  v_reused boolean;
BEGIN
  IF p_generations IS NULL OR p_generations < 1 OR p_generations > c_max_generations THEN
    RAISE EXCEPTION 'p_generations out of range' USING ERRCODE = '22023';
  END IF;
  SELECT u.encrypted_password INTO v_hash FROM auth.users u WHERE u.id = p_user_id;
  IF v_hash IS NULL OR v_hash = '' THEN RETURN 'no_password'; END IF;
  IF v_hash NOT LIKE c_bcrypt_prefix THEN RETURN 'unsupported_hash'; END IF;
  IF p_current_password IS NOT NULL AND v_hash <> extensions.crypt(p_current_password, v_hash) THEN
    RETURN 'current_mismatch';
  END IF;
  -- 直近 p_generations 世代 (履歴に写した現在のパスワードを含む) と比べる
  SELECT EXISTS (
    SELECT 1 FROM (SELECT h.password_hash FROM public.password_history h
                    WHERE h.user_id = p_user_id ORDER BY h.changed_at DESC LIMIT p_generations) AS recent
     WHERE recent.password_hash LIKE c_bcrypt_prefix
       AND recent.password_hash = extensions.crypt(p_new_password, recent.password_hash)
  ) INTO v_reused;
  IF v_reused OR v_hash = extensions.crypt(p_new_password, v_hash) THEN RETURN 'reused'; END IF;
  RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION public.auth_password_check(uuid, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_password_check(uuid, text, text, integer) TO service_role;
```

平文は保存しない・ログに出さない (PostgREST は引数をバインドパラメータで渡し、Postgres は既定でパラメータの値をログに書かない)。1 回の呼び出しの bcrypt は最大 12 回 (現在 1 + 世代 10 + 現在との比較 1)。

### 11.6 保守の関数 3 本と pg_cron のジョブ

```sql
CREATE OR REPLACE FUNCTION public.expire_idle_auth_sessions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  -- 更新 (refresh) の無いまま終える日数。cross/01 §4.1 の個人の絶対タイムアウト。constants.ts の SESSION_IDLE_EXPIRE_DAYS と同じ値
  c_idle   CONSTANT interval := INTERVAL '30 days';
  v_ids    uuid[];
  v_count  integer;
BEGIN
  SELECT array_agg(s.id) INTO v_ids FROM auth.sessions s
   WHERE COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.created_at) < pg_catalog.now() - c_idle;
  IF v_ids IS NULL THEN RETURN 0; END IF;
  UPDATE public.user_sessions_metadata SET ended_reason = 'idle_expired'
   WHERE revoked_at IS NULL AND session_id = ANY (v_ids::text[]);
  DELETE FROM auth.sessions s WHERE s.id = ANY (v_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_user_sessions_metadata()
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  WITH fixed AS (
    UPDATE public.user_sessions_metadata m
       SET revoked_at = pg_catalog.now(), ended_reason = COALESCE(m.ended_reason, 'signed_out')
     WHERE m.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id::text = m.session_id)
    RETURNING 1)
  SELECT count(*)::integer FROM fixed
$$;

CREATE OR REPLACE FUNCTION public.cleanup_ended_user_sessions_metadata()
RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
  WITH params AS (SELECT INTERVAL '90 days' AS retention),  -- constants.ts の LOGIN_HISTORY_RETENTION_DAYS と同じ値
  deleted AS (
    DELETE FROM public.user_sessions_metadata m USING params p
     WHERE m.revoked_at IS NOT NULL AND m.revoked_at < pg_catalog.now() - p.retention
    RETURNING 1)
  SELECT count(*)::integer FROM deleted
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['expire_idle_auth_sessions', 'reconcile_user_sessions_metadata', 'cleanup_ended_user_sessions_metadata'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO service_role', fn);
  END LOOP;
END $$;

-- 毎日 03:55 JST (18:55 UTC)。ほかのジョブ (03:15 / 03:45 JST) と重ねない。同じ名前・同じ処理のジョブは先に外す (20261011070000 と同じ形)
DO $$
DECLARE v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid, jobname, schedule FROM cron.job
     WHERE jobname = 'cleanup-auth-sessions-and-login-history'
        OR command ~* '[[:<:]]expire_idle_auth_sessions[[:>:]]'
     ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
    RAISE NOTICE '登録済みの pg_cron のジョブを登録解除しました: jobid=%, jobname=%, schedule=%', v_job.jobid, v_job.jobname, v_job.schedule;
  END LOOP;
  PERFORM cron.schedule(
    'cleanup-auth-sessions-and-login-history',
    '55 18 * * *',
    'SELECT public.expire_idle_auth_sessions(), public.reconcile_user_sessions_metadata(), public.cleanup_ended_user_sessions_metadata();'
  );
END $$;
```

### 11.7 `.down.sql`

順に: `cron.unschedule('cleanup-auth-sessions-and-login-history')` → 保守の関数 3 本を DROP → RPC 2 本を DROP → トリガー 4 本を DROP → トリガー関数 4 本を DROP → 索引 2 本を DROP → CHECK 3 本を DROP → 足した列 12 本を DROP → `CREATE POLICY sessions_revoke_self ON public.user_sessions_metadata FOR UPDATE USING (user_id = auth.uid())` を戻す → `GRANT ALL ON TABLE public.user_sessions_metadata, public.password_history TO anon, authenticated` を戻す (baseline の状態)。写した行 (11.2) は消さない (列は既存のものだけで、害が無い)。

### 11.8 型の生成物

`src/types/database.types.ts` と `packages/shared/src/database.types.ts` を作り直す (`tests/database-types-migrations-contract.test.ts` の冒頭の手順)。`Functions` に `auth_session_revoke`・`auth_password_check`・`expire_idle_auth_sessions`・`reconcile_user_sessions_metadata`・`cleanup_ended_user_sessions_metadata` が入る (トリガー関数は出ない)。`Tables.user_sessions_metadata.Row` に 12 列が増える。

## 12. 定数・環境変数・純関数 (canonical)

### 12.1 `src/lib/auth/sessions/constants.ts`・`device-family.ts`

```ts
// src/lib/auth/sessions/constants.ts
/** IPv4 で「同じ場所」とみなす範囲の長さ (/24)。携帯回線・家庭の回線は接続のたびに末尾が変わるので、ホスト単位では比べない。SQL の auth_session_created と同じ値 */
export const IP_NETWORK_PREFIX_V4 = 24;
/** IPv6 の同じ範囲 (/48 = 1 契約に割り当てられる典型の幅)。SQL と同じ値 */
export const IP_NETWORK_PREFIX_V6 = 48;
/** 終わったセッションの行 (= ログイン履歴) を残す日数。SQL の cleanup_ended_user_sessions_metadata と同じ値。不審の判定は期間で絞らず残っている行をすべて見て、アカウントの年齢がこれを超えて履歴が空なら「履歴が消えた」とみなす (§10.1) */
export const LOGIN_HISTORY_RETENTION_DAYS = 90;
/** 不審の判定で読む前の行の上限 (新しい順)。1 人が保持の 90 日の間にこれを超えてログインすることは想定しない。超えた分 (古い側) を見落としても、判定は「新しい端末」= 送る側に倒れる */
export const LOGIN_ALERT_PRIOR_MAX_ROWS = 1000;
/** 更新 (refresh) の無いまま終える日数 (cross/01 §4.1 の個人の絶対タイムアウト)。SQL の expire_idle_auth_sessions と同じ値 */
export const SESSION_IDLE_EXPIRE_DAYS = 30;
/** worker が 1 回 (1 分) で処理する行数の上限。1 行 = DB 2〜3 回 + メール 1 通で、1 分の中に収まる量 */
export const LOGIN_ALERT_BATCH_SIZE = 100;
/** 作成からこの秒数は判定しない。Web の route が同じ要求の中で IP / UA / 国を上書きするのを待つ (§13.5) */
export const LOGIN_ALERT_MIN_AGE_SECONDS = 15;
/** processing のまま止まった行 (関数が途中で死んだ) を取り直すまでの分数。Vercel の関数の最長 (60 秒) より十分長い */
export const LOGIN_ALERT_RECLAIM_MINUTES = 10;
/** 例外で失敗した行を諦めるまでの回数 */
export const LOGIN_ALERT_MAX_ATTEMPTS = 3;
/** 一覧 (利用者・運営) に出す履歴の件数 */
export const LOGIN_HISTORY_PAGE_SIZE = 20;
/** 通知を止めるスイッチ。値を読むのは src/app/api/cron/login-alerts/route.ts だけ (env.ts の readOnlyBy) */
export const AUTH_LOGIN_ALERT_ENV_NAME = 'AUTH_LOGIN_ALERT';

export type LoginAlertMode = 'on' | 'off';
export interface LoginAlertSetting { readonly mode: LoginAlertMode; readonly ignored: boolean }
/** 未設定・空白は on。on / off 以外は on に戻して ignored = true (resolveLoginFailureResetMinutes と同じ扱い) */
export function resolveLoginAlertMode(raw: string | undefined): LoginAlertSetting {
  const text = raw?.trim().toLowerCase();
  if (!text) return { mode: 'on', ignored: false };
  if (text === 'on' || text === 'off') return { mode: text, ignored: false };
  return { mode: 'on', ignored: true };
}
```

```ts
// src/lib/auth/sessions/device-family.ts — UA から端末の種類 (OS × クライアント) を決める純関数。外部ライブラリは使わない
export type DeviceOs = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'other';
export type DeviceClient = 'app' | 'safari' | 'chrome' | 'firefox' | 'edge' | 'server' | 'other';
export interface DeviceFamily { readonly os: DeviceOs; readonly client: DeviceClient; readonly key: string }
/** Next.js のサーバー経由で GoTrue に届いた UA (node / undici / Vercel)。端末の情報を持たないので、判定では「端末の種類が分からない」として扱う */
export const SERVER_DEVICE_FAMILY_KEY = 'other/server';
/** UA の読む長さの上限 (細工された長い UA で正規表現に時間を使わせない) */
const UA_MAX_LENGTH = 512;
const SERVER_UA = /^(node|undici|next\.js|vercel edge functions)/i;
const IOS_APP_UA = /CFNetwork\//;    // React Native (iOS) の fetch
const ANDROID_APP_UA = /^okhttp\//i; // React Native (Android) の fetch

function osOf(ua: string): DeviceOs {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  if (/Windows NT/.test(ua)) return 'windows';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'other';
}
function clientOf(ua: string): DeviceClient {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}
export function deviceFamilyOf(userAgent: string | null | undefined): DeviceFamily {
  const ua = (userAgent ?? '').slice(0, UA_MAX_LENGTH);
  let os: DeviceOs = 'other';
  let client: DeviceClient = 'other';
  if (!ua) { /* 不明 */ }
  else if (SERVER_UA.test(ua)) client = 'server';
  else if (IOS_APP_UA.test(ua)) { os = 'ios'; client = 'app'; }
  else if (ANDROID_APP_UA.test(ua)) { os = 'android'; client = 'app'; }
  else { os = osOf(ua); client = clientOf(ua); }
  return { os, client, key: `${os}/${client}` };
}
const OS_LABEL: Record<DeviceOs, string> = { ios: 'iPhone・iPad', android: 'Android', macos: 'Mac', windows: 'Windows', linux: 'Linux', other: '不明な端末' };
const CLIENT_LABEL: Record<DeviceClient, string> = { app: 'ほめゴハンのアプリ', safari: 'Safari', chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge', server: '不明', other: 'ブラウザ' };
/** 一覧・メールに出す文言。例: 「iPhone・iPad の Safari」「ほめゴハンのアプリ (Android)」「不明な端末」 */
export function deviceLabelOf(family: DeviceFamily): string {
  if (family.client === 'app') return `${CLIENT_LABEL.app} (${OS_LABEL[family.os]})`;
  if (family.client === 'server' || (family.os === 'other' && family.client === 'other')) return OS_LABEL.other;
  return `${OS_LABEL[family.os]} の ${CLIENT_LABEL[family.client]}`;
}
```

### 12.2 `src/lib/auth/password/policy.ts`

```ts
// src/lib/auth/password/policy.ts
/** 過去履歴の禁止の世代数 (cross/01 §7.1)。履歴には現在のパスワードも入るので「現在 + 直前 N-1 個」と同じ */
export const PASSWORD_HISTORY_GENERATIONS = { user: 3, org_member: 5, operator: 10 } as const;
/** DB が残す世代の最大 = 運営の世代数。SQL の password_history_record / auth_password_check の c_max_generations と同じ値 (契約テスト) */
export const PASSWORD_HISTORY_MAX_GENERATIONS = 10;
/** メールのリンク / コードで作ったセッション (amr に recovery または otp。session-claims.ts の RECOVERY_AMR_METHODS) を、再設定の API が受け付ける分数。Supabase の再設定リンクの有効期間 (既定 1 時間) に合わせる */
export const PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES = 60;
/** 運営の世代数を適用するロール (cross/01 §7.1 の「運営 (admin+)」。support / sales / finance / content_moderator も運営の画面を持つので含める) */
const OPERATOR_ROLES: ReadonlySet<string> = new Set(['support', 'sales', 'finance', 'content_moderator', 'admin', 'super_admin']);
const ORG_ROLE_PREFIX = 'org_';
export function passwordHistoryGenerationsFor(roles: ReadonlyArray<string>): number {
  if (roles.some((r) => OPERATOR_ROLES.has(r))) return PASSWORD_HISTORY_GENERATIONS.operator;
  if (roles.some((r) => r.startsWith(ORG_ROLE_PREFIX))) return PASSWORD_HISTORY_GENERATIONS.org_member;
  return PASSWORD_HISTORY_GENERATIONS.user;
}
```

### 12.3 `src/lib/auth/sessions/login-alert-policy.ts` (不審の判定)

```ts
// src/lib/auth/sessions/login-alert-policy.ts
export interface LoginContext {
  /** deviceFamilyOf(user_agent).key */
  readonly deviceFamilyKey: string;
  /** user_sessions_metadata.ip_network の文字列 (例 "203.0.113.0/24")。無ければ null */
  readonly ipNetwork: string | null;
  readonly countryCode: string | null;
}
export type LoginAlertReason = 'first_login' | 'history_expired' | 'known' | 'new_device' | 'new_country' | 'new_device_and_country';
export interface LoginAlertDecision {
  readonly isNewDevice: boolean;
  readonly isNewIp: boolean;
  readonly isNewCountry: boolean;
  /** メールを送るか = 新しい端末の種類 または 新しい国。IP の範囲だけでは送らない (§7.1) */
  readonly shouldNotify: boolean;
  readonly reason: LoginAlertReason;
}
/** prior が空のとき、初めてのログインか、履歴が保持期間で消えたのかを見分ける材料 (§10.1) */
export interface LoginHistoryHorizon {
  /** auth.users.created_at (auth.admin.getUserById の user.created_at) */
  readonly accountCreatedAt: Date;
  /** worker の now() */
  readonly now: Date;
  /** LOGIN_HISTORY_RETENTION_DAYS (constants.ts。実装では import して渡す) */
  readonly retentionDays: number;
}
/** device-family.ts の SERVER_DEVICE_FAMILY_KEY と同じ値 (実装では import する) */
const SERVER_DEVICE_FAMILY_KEY = 'other/server';
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
/**
 * prior = 同じ利用者の、この行より前に作られた行すべて (live・終わった行の両方。期間では絞らない §13.3)。
 * prior が空で、アカウントの年齢が保持の日数以下なら初めてのログイン (消えた行はあり得ない §10.1)。
 * 保持の日数を超えていれば、履歴が消えた (比べる相手が無い) とみなし、端末の種類が分かれば新しい端末として知らせる。
 */
export function decideLoginAlert(
  current: LoginContext,
  prior: ReadonlyArray<LoginContext>,
  horizon: LoginHistoryHorizon,
): LoginAlertDecision {
  if (prior.length === 0) {
    const accountAgeMs = horizon.now.getTime() - horizon.accountCreatedAt.getTime();
    if (accountAgeMs <= horizon.retentionDays * MS_PER_DAY) {
      return { isNewDevice: false, isNewIp: false, isNewCountry: false, shouldNotify: false, reason: 'first_login' };
    }
    const deviceKnowable = current.deviceFamilyKey !== SERVER_DEVICE_FAMILY_KEY;
    return {
      isNewDevice: deviceKnowable,
      isNewIp: current.ipNetwork !== null,
      isNewCountry: false,
      shouldNotify: deviceKnowable,
      reason: 'history_expired',
    };
  }
  const deviceKnown =
    current.deviceFamilyKey === SERVER_DEVICE_FAMILY_KEY || prior.some((p) => p.deviceFamilyKey === current.deviceFamilyKey);
  const isNewDevice = !deviceKnown;
  const isNewIp = current.ipNetwork !== null && !prior.some((p) => p.ipNetwork === current.ipNetwork);
  const priorWithCountry = prior.filter((p) => p.countryCode !== null);
  const isNewCountry =
    current.countryCode !== null && priorWithCountry.length > 0 && !priorWithCountry.some((p) => p.countryCode === current.countryCode);
  const reason: LoginAlertReason =
    isNewDevice && isNewCountry ? 'new_device_and_country' : isNewDevice ? 'new_device' : isNewCountry ? 'new_country' : 'known';
  return { isNewDevice, isNewIp, isNewCountry, shouldNotify: isNewDevice || isNewCountry, reason };
}
```

### 12.4 `src/lib/auth/sessions/session-claims.ts` (JWT の claims の読み取り)

```ts
// src/lib/auth/sessions/session-claims.ts
import { z } from 'zod';
export const SessionClaimsSchema = z.object({
  sub: z.uuid(),
  session_id: z.uuid(),
  amr: z.array(z.object({ method: z.string(), timestamp: z.number() })).optional(),
});
export type SessionClaims = z.infer<typeof SessionClaimsSchema>;
/**
 * 再設定 (現在のパスワード無しの変更) を受け付ける amr の method。どちらも「メールのリンク / コードで、メールボックスを持つことを示して作ったセッション」(§3):
 * - 'recovery': PKCE の code の経路 (Web の resetPasswordForEmail → /auth/reset-password?code=… を browser の client が交換)。GoTrue は flow state の方法を amr に書く
 * - 'otp': token_hash の経路 (POST /verify。Web の /auth/callback・モバイルの authLink.ts の verifyOtp) と implicit の経路 (GET /verify → フラグメント → モバイルの setSession)。GoTrue は models.OTP を amr に書く
 * 'password' / 'oauth' (盗んだ普通のセッション) は含めない (S-15)
 */
export const RECOVERY_AMR_METHODS: ReadonlySet<string> = new Set(['recovery', 'otp']);
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
export function bearerTokenOf(authorization: string | null | undefined): string | null {
  const m = authorization?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}
/** auth-js の GoTrueClient['auth'] のうち使うもの (テストでは偽物を渡す) */
export interface SessionClaimsReader {
  getSession(): Promise<{ data: { session: { access_token: string } | null } }>;
  getClaims(jwt?: string): Promise<{ data: { claims: unknown } | null; error: { message: string } | null }>;
}
/** 検証済みの claims と、その元の access token。token は GoTrue を本人として呼ぶ (updatePasswordWithAccessToken §13.7・signOutOtherSessions §13.1) のに使う。ログ・応答に出さない */
export interface SessionAuth {
  readonly claims: SessionClaims;
  readonly accessToken: string;
}
/** Bearer (モバイル) があればその JWT、無ければ Cookie のセッションの access_token を getClaims で検証して読む。読めなければ null */
export async function readSessionAuth(auth: SessionClaimsReader, authorization: string | null | undefined): Promise<SessionAuth | null> {
  const token = bearerTokenOf(authorization) ?? (await auth.getSession()).data.session?.access_token ?? null;
  if (!token) return null;
  const { data, error } = await auth.getClaims(token);
  if (error || !data) return null;
  const parsed = SessionClaimsSchema.safeParse(data.claims);
  return parsed.success ? { claims: parsed.data, accessToken: token } : null;
}
/** amr に、now から maxAgeMinutes 以内の recovery / otp (RECOVERY_AMR_METHODS) があるか (再設定の API の認可) */
export function hasRecentRecoveryMethod(claims: SessionClaims, now: Date, maxAgeMinutes: number): boolean {
  return (claims.amr ?? []).some(
    (entry) => RECOVERY_AMR_METHODS.has(entry.method) && now.getTime() - entry.timestamp * MS_PER_SECOND <= maxAgeMinutes * MS_PER_MINUTE,
  );
}
```

再設定の経路と `amr` (§3 の実コード。結合テスト §20.3 が token_hash の経路と password の経路を実 GoTrue で固定する):

| 経路 | 入口 | GoTrue | `amr` の method | 再設定の API |
|---|---|---|---|---|
| Web・PKCE (いまの `resetPasswordForEmail` の既定) | `/auth/reset-password?code=…` を browser の client が交換 | `/verify` の PKCE の枝 → code → `/token?grant_type=pkce` | `recovery` | 通す |
| Web・token_hash (メールの雛形が `{{ .TokenHash }}` の形のとき) | `/auth/callback` の `verifyOtp({ token_hash, type: 'recovery' })` | `POST /verify` | `otp` | 通す |
| モバイル・implicit (いまの既定。`flowType` 未指定) | `authLink.ts` の `setSession` (フラグメント) | `GET /verify` の implicit の枝 | `otp` | 通す |
| モバイル・token_hash | `authLink.ts` の `verifyOtp` | `POST /verify` | `otp` | 通す |
| パスワードのログイン | `/api/auth/login`・モバイルの `signInWithPassword` | `/token?grant_type=password` | `password` | 403 (S-15) |
| Google / Apple | `/auth/callback` の code・`authLink.ts` の code | `/token?grant_type=pkce` (OAuth) | `oauth` | 403 |

### 12.5 `src/lib/auth/sessions/schemas.ts` (API の Zod)

```ts
// src/lib/auth/sessions/schemas.ts
import { z } from 'zod';
/** POST /api/auth/login の PASSWORD_MAX_LENGTH と同じ値・同じ理由 (bcrypt は 72 バイト超を比べない。巨大な本文を送らない) */
export const PASSWORD_INPUT_MAX_LENGTH = 1024;
/** user_sessions_metadata.device_name varchar(200) */
export const DEVICE_NAME_MAX_LENGTH = 200;
export const PasswordChangeBodySchema = z.object({
  current_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH),
  new_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH),
});
export const PasswordResetBodySchema = z.object({ new_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH) });
export const DeviceNameBodySchema = z.object({ device_name: z.string().trim().min(1).max(DEVICE_NAME_MAX_LENGTH) });
export const EndedReasonSchema = z.enum(['signed_out', 'revoked_by_user', 'idle_expired']);
export const SessionSummarySchema = z.object({
  session_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  last_active_at: z.iso.datetime({ offset: true }),
  /** deviceLabelOf(deviceFamilyOf(user_agent)) */
  device_label: z.string(),
  device_name: z.string().nullable(),
  ip_address: z.string().nullable(),
  country_code: z.string().length(2).nullable(),
  is_current: z.boolean(),
});
export const SessionsResponseSchema = z.object({ sessions: z.array(SessionSummarySchema) });
export const LoginHistoryEntrySchema = SessionSummarySchema.omit({ is_current: true }).extend({
  ended_at: z.iso.datetime({ offset: true }).nullable(),
  ended_reason: EndedReasonSchema.nullable(),
  is_new_device: z.boolean().nullable(),
  is_new_ip: z.boolean().nullable(),
  is_new_country: z.boolean().nullable(),
  alert_sent_at: z.iso.datetime({ offset: true }).nullable(),
});
export const LoginHistoryResponseSchema = z.object({ entries: z.array(LoginHistoryEntrySchema) });
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type LoginHistoryEntry = z.infer<typeof LoginHistoryEntrySchema>;
```

### 12.6 環境変数・rate-limit のカテゴリ

| 名前 | 置き場 | 既定 | 意味 |
|---|---|---|---|
| `AUTH_LOGIN_ALERT` | `src/lib/env.ts` の `SERVER_ENV_VARS` に `required: false`・`readOnlyBy: 'src/app/api/cron/login-alerts/route.ts'`・`.env.example` に説明つきで追加 | `on` | `off` で worker はメールを送らず印だけ付ける (障害・移行の間に止める用)。不正な値は on に戻して warn (変数名だけ) |
| rate-limit `'auth-password-change'` | `src/lib/rate-limit.ts` の `CATEGORY_RULES` | `max: 5, windowSec: 10 * MINUTE_SEC` (キー = user.id) | 現在のパスワードの総当たりを本人のセッションで試させない (GoTrue のログインの制限は通らない経路なので) |
| rate-limit `'auth-password-reset'` | 同上 | `max: 5, windowSec: 10 * MINUTE_SEC` (キー = user.id) | 同上 |

## 13. facade 契約 (公開関数のシグネチャとエラー表)

### 13.1 `src/lib/auth/sessions/store.ts` (I/O。client は引数で受ける)

```ts
// src/lib/auth/sessions/store.ts — シグネチャ (本体は実装で書く。I/O は supabase-js の client を引数で受け、テストでは偽物を渡す)
import type { SupabaseClient } from '@supabase/supabase-js';
export type ContextSource = 'auth' | 'web' | 'mobile';
export type EndedReason = 'signed_out' | 'revoked_by_user' | 'idle_expired';
export type AlertStatus = 'pending' | 'processing' | 'done';
/** user_sessions_metadata の 1 行 (database.types.ts の Row と同じ列) */
export interface SessionRow {
  session_id: string; user_id: string; ip_address: string | null; ip_network: string | null; user_agent: string | null;
  device_name: string | null; device_family: string | null; country_code: string | null; context_source: ContextSource;
  created_at: string; last_active_at: string; revoked_at: string | null; ended_reason: EndedReason | null;
  is_new_device: boolean | null; is_new_ip: boolean | null; is_new_country: boolean | null;
  alert_status: AlertStatus; alert_claimed_at: string | null; alert_attempts: number; alert_sent_at: string | null;
}
export type RevokeOutcome = 'revoked' | 'not_found' | 'current';
/** 本人の client (RLS)。live の行を last_active_at の降順で */
export declare function listLiveSessions(client: SupabaseClient, userId: string): Promise<SessionRow[]>;
/** 本人の client (RLS) または service_role。終わった行を含め created_at の降順で limit 件 */
export declare function listLoginHistory(client: SupabaseClient, userId: string, limit: number): Promise<SessionRow[]>;
/** 本人の client で rpc('auth_session_revoke'). 戻りの文字列を RevokeOutcome に絞る (それ以外は例外) */
export declare function revokeSession(client: SupabaseClient, sessionId: string): Promise<RevokeOutcome>;
/**
 * service_role の client (getSupabaseAdmin())。admin.auth.admin.signOut(accessToken, 'others') で、GoTrue の POST /logout?scope=others を
 * 本人の access token で呼ぶ (JWT の session_id 以外の本人のセッションを DELETE。呼んだセッションは残る)。error が返れば例外を投げる。
 * createClient() の auth.signOut({ scope: 'others' }) は使わない (Bearer だけの要求では GoTrue を呼ばずに成功を返す §3)
 */
export declare function signOutOtherSessions(admin: SupabaseClient, accessToken: string): Promise<void>;
/** worker の判定が読む前の行の列 */
export type PriorLoginRow = Pick<SessionRow, 'user_agent' | 'device_family' | 'ip_network' | 'country_code'>;
/**
 * service_role。同じ user_id で session_id ≠ input.sessionId かつ created_at < input.createdAt の行 (live・終わった行の両方。期間では絞らない
 * — 保持は cleanup_ended_user_sessions_metadata が決め、live の行は消えない)。created_at の降順で input.limit 件 (LOGIN_ALERT_PRIOR_MAX_ROWS)
 */
export declare function listPriorLogins(admin: SupabaseClient, input: { userId: string; sessionId: string; createdAt: string; limit: number }): Promise<PriorLoginRow[]>;
/** service_role。本人の session_id の行に device_name と context_source = 'mobile' を書く。行が無ければ false */
export declare function setCurrentDeviceName(admin: SupabaseClient, input: { userId: string; sessionId: string; deviceName: string }): Promise<boolean>;
/** service_role。Web の route がログイン直後に呼ぶ。context_source = 'auth' の行だけ上書きし、'web' にする。行が無い・既に web/mobile なら false。例外は投げず false (ログインを止めない) */
export declare function recordWebLoginContext(admin: SupabaseClient, input: { userId: string; sessionId: string; ipAddress: string | null; userAgent: string | null; countryCode: string | null }): Promise<boolean>;
/** service_role。取り置き (§10 の行)。戻りは取れた行だけ */
export declare function claimLoginAlerts(admin: SupabaseClient, input: { now: Date; batchSize: number; minAgeSeconds: number; reclaimMinutes: number }): Promise<SessionRow[]>;
/** service_role。判定の結果と送信の結果を書く */
export declare function finishLoginAlert(admin: SupabaseClient, input: { sessionId: string; deviceFamily: string; isNewDevice: boolean; isNewIp: boolean; isNewCountry: boolean; sentAt: Date | null }): Promise<void>;
/** service_role。失敗した行を pending に戻す (attempts を 1 増やす)。attempts が maxAttempts 以上なら done にする */
export declare function releaseLoginAlert(admin: SupabaseClient, input: { sessionId: string; maxAttempts: number }): Promise<void>;
```

### 13.2 `src/lib/auth/password/change.ts` (変更・再設定の筋。副作用は deps)

```ts
// src/lib/auth/password/change.ts
export type PasswordCheckOutcome = 'ok' | 'current_mismatch' | 'reused' | 'no_password' | 'unsupported_hash';
export interface PasswordChangeInput {
  userId: string;
  /** 再設定 (recovery) のときは null (現在のパスワードを確かめない) */
  currentPassword: string | null;
  newPassword: string;
  /** passwordHistoryGenerationsFor(roles) */
  generations: number;
}
/** GoTrue の PUT /auth/v1/user の結果。code = GoTrue のエラーの code (例 weak_password)、読めなければ null。status = HTTP の status。GoTrue の英文はここに入れない */
export interface UpdatePasswordOutcome { error: { code: string | null; status: number } | null }
export interface PasswordChangeDeps {
  /** admin.rpc('auth_password_check', { p_user_id, p_current_password, p_new_password, p_generations }) の戻りを絞って返す */
  checkPassword(input: PasswordChangeInput): Promise<PasswordCheckOutcome>;
  /**
   * updatePasswordWithAccessToken(session.accessToken, newPassword) (§13.7。session = readSessionAuth の結果)。
   * createClient() の auth.updateUser は使わない (Bearer だけの要求ではセッションが無く AuthSessionMissingError §3)
   */
  updatePassword(newPassword: string): Promise<UpdatePasswordOutcome>;
}
export type PasswordChangeResult =
  | { kind: 'changed' } | { kind: 'current_mismatch' } | { kind: 'reused' } | { kind: 'no_password' } | { kind: 'unsupported_hash' }
  | { kind: 'weak' } | { kind: 'reauthentication_required' }
  | { kind: 'upstream-error'; code: string | null; status: number | null };
/** GoTrue のエラーの code (auth-js の AuthApiError.code) */
const GOTRUE_WEAK_PASSWORD = 'weak_password';
const GOTRUE_SAME_PASSWORD = 'same_password';
const GOTRUE_REAUTHENTICATION_NEEDED = 'reauthentication_needed';
export async function performPasswordChange(input: PasswordChangeInput, deps: PasswordChangeDeps): Promise<PasswordChangeResult> {
  const check = await deps.checkPassword(input);
  if (check !== 'ok') return { kind: check };
  const { error } = await deps.updatePassword(input.newPassword);
  if (!error) return { kind: 'changed' };
  if (error.code === GOTRUE_WEAK_PASSWORD) return { kind: 'weak' };
  if (error.code === GOTRUE_SAME_PASSWORD) return { kind: 'reused' };
  if (error.code === GOTRUE_REAUTHENTICATION_NEEDED) return { kind: 'reauthentication_required' };
  return { kind: 'upstream-error', code: error.code, status: error.status };
}
```

### 13.3 `src/lib/auth/sessions/login-alert-worker.ts`

```ts
// src/lib/auth/sessions/login-alert-worker.ts — シグネチャ。1 行の処理の順は §13.4
export interface LoginAlertRow {
  session_id: string; user_id: string; user_agent: string | null; ip_network: string | null; country_code: string | null;
  created_at: string; device_name: string | null;
}
export interface PriorLogin { deviceFamilyKey: string; ipNetwork: string | null; countryCode: string | null }
/** 判定と宛先に使う利用者の情報 */
export interface LoginAlertAccount {
  /** 登録メールアドレス。無ければ null (送らない) */
  email: string | null;
  /** auth.users.created_at (§10.1 の「アカウントの年齢」) */
  createdAt: Date;
}
export interface LoginAlertWorkerDeps {
  claim(): Promise<LoginAlertRow[]>;
  /**
   * listPriorLogins(admin, { userId: row.user_id, sessionId: row.session_id, createdAt: row.created_at, limit: LOGIN_ALERT_PRIOR_MAX_ROWS }) を
   * PriorLogin にしたもの (device_family が NULL の行は deviceFamilyOf(user_agent).key)。期間では絞らない (§10.1)
   */
  priorLogins(row: LoginAlertRow): Promise<PriorLogin[]>;
  /** auth.admin.getUserById(user_id) の user.email と user.created_at。利用者が居なければ null */
  accountOf(userId: string): Promise<LoginAlertAccount | null>;
  /** sendEmail(renderLoginNewDeviceEmail(...), { idempotencyKey: `login-alert:${session_id}` })。届かなくても例外にしない */
  send(row: LoginAlertRow, deviceLabel: string, to: string): Promise<{ ok: boolean }>;
  finish(sessionId: string, result: { deviceFamily: string; isNewDevice: boolean; isNewIp: boolean; isNewCountry: boolean; sentAt: Date | null }): Promise<void>;
  release(sessionId: string): Promise<void>;
  now(): Date;
}
export interface LoginAlertWorkerSummary { claimed: number; notified: number; skipped: number; failed: number }
export declare function processLoginAlerts(deps: LoginAlertWorkerDeps, options: { alertMode: 'on' | 'off' }): Promise<LoginAlertWorkerSummary>;
```

### 13.4 worker の 1 行の順 (逐語)

1. `family = deviceFamilyOf(row.user_agent)`、`prior = await priorLogins(row)`、`account = await accountOf(row.user_id)`。
2. `account` が null (利用者が消えた) → `finish(session_id, { deviceFamily: family.key, isNewDevice: false, isNewIp: false, isNewCountry: false, sentAt: null })` → `skipped` に数え、次の行へ。
3. `decision = decideLoginAlert({ deviceFamilyKey: family.key, ipNetwork: row.ip_network, countryCode: row.country_code }, prior, { accountCreatedAt: account.createdAt, now: now(), retentionDays: LOGIN_HISTORY_RETENTION_DAYS })`。
4. `decision.shouldNotify && alertMode === 'on'` のときだけ送る: `account.email` が null なら送らない (`skipped`)。あれば `sent = await send(row, row.device_name ?? deviceLabelOf(family), account.email)`。`sent.ok` なら `notified`。
5. `finish(session_id, { deviceFamily: family.key, isNewDevice, isNewIp, isNewCountry, sentAt: sent?.ok ? now() : null })`。送れなかった (`ok: false`) ときも `done` (再送しない。`sendEmail` が app_logs に残す)。送らない判定 (`shouldNotify` が偽・`alertMode` が off) の行も `finish` する (`sentAt` は null)。件数: `sent.ok` が真の行は `notified`、それ以外で `finish` した行 (送らない判定・宛先無し・`ok: false`) は `skipped`。
6. 1〜5 で例外 → `release(session_id)` (attempts + 1、3 回目で done) → `failed` に数え、次の行へ。
7. 戻り値は件数だけ。応答にも、ログにも、メールアドレス・IP・UA は入れない (件数と session_id の数だけ)。

### 13.5 Web の route がログイン直後に呼ぶ (`recordWebLoginContext`)

- `src/app/api/auth/login/route.ts`: `signIn` の中で `const { data, error } = await supabase.auth.signInWithPassword(...)`。`!error && data.session` なら `const session = await readSessionAuth(supabase.auth, 'Bearer ' + data.session.access_token)` → `session` が取れたら `await recordWebLoginContext(admin, { userId: session.claims.sub, sessionId: session.claims.session_id, ipAddress: clientIp, userAgent: request.headers.get('user-agent'), countryCode: countryCodeOf(request.headers) })`。失敗しても `signed-in` を返す (ログインを止めない。`createLogger('auth/login-context').warn`)。`guarded-login.ts` は変えない (`deps.signIn` の中で済む)。
- `src/app/(auth)/auth/callback/route.ts`: `exchangeCodeForSession` / `verifyOtp` (3 か所) の成功 (`data.session`) の直後に同じ呼び出し。
- `countryCodeOf(headers)`: `x-vercel-ip-country` を読み、`/^[A-Z]{2}$/` に合えばその値、無ければ null (`src/lib/auth/sessions/request-context.ts`)。
- `recordWebLoginContext` は `context_source = 'auth'` の行だけ上書き (`.eq('context_source', 'auth')`)。`ip_network` は TS の `ipNetworkOf(ip)` で計算して同じ UPDATE に入れる (`src/lib/auth/sessions/ip-network.ts`: IPv4 は `a.b.c.0/24`、IPv6 は先頭 48 ビットを `xxxx:xxxx:xxxx::/48` の形。`node:net` の `isIP` で種類を見る。不正なら null)。幅は SQL のトリガーと同じ値 (契約テスト §20.3)。

### 13.6 facade のエラー表 (lib)

| 関数 | 失敗 | 扱い |
|---|---|---|
| `readSessionAuth` | token 無し・検証失敗・形が違う | `null` (route は 401 `AUTH_UNAUTHENTICATED`) |
| `revokeSession` | RPC の error (28000 = 未認証 / その他) | 例外 → route は `internalError` (500) |
| `signOutOtherSessions` | GoTrue の error (`auth.admin.signOut` の戻り) | 例外 → route は `internalError` (500)。`remaining` は返さない |
| `updatePasswordWithAccessToken` | GoTrue の 4xx / 5xx | `{ error: { code, status } }` (例外にしない) → `performPasswordChange` が kind に変える。通信の失敗 (`fetch` の例外) は例外のまま → route は `internalError` (`stage: 'password-update'`) |
| `recordWebLoginContext` | DB の失敗 | `false` + warn ログ (ログインは成功のまま) |
| `setCurrentDeviceName` | 行が無い | `false` → route は 404 `AUTH_SESSION_NOT_FOUND` |
| `performPasswordChange` | RPC の例外 | 例外 → route は `internalError` (`stage: 'password-check'`) |
| `processLoginAlerts` | 1 行の例外 | `release` して続行。`claim` 自体の失敗は例外 → route は 500 |

### 13.7 `src/lib/auth/password/gotrue-user.ts` (本人の access token で GoTrue の `PUT /auth/v1/user`)

Web (Cookie) とモバイル (Bearer だけ) を同じ経路にするため、auth-js の保管のセッションに頼らず、`readSessionAuth` が検証した access token を明示して GoTrue を呼ぶ (§3・§7.1)。

```ts
// src/lib/auth/password/gotrue-user.ts
import { z } from 'zod';
import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env-required';
/** GoTrue のエラー本文を { code: 文字列, message } の形で返させる版。auth-js の API_VERSIONS['2024-01-01'] と同じ値 */
export const GOTRUE_API_VERSION = '2024-01-01';
/** auth-js の API_VERSION_HEADER_NAME と同じ名前 */
export const GOTRUE_API_VERSION_HEADER = 'X-Supabase-Api-Version';
/** GoTrue の本人の情報の更新 (auth-js の updateUser と同じ口) */
export const GOTRUE_USER_PATH = '/auth/v1/user';
/** change.ts の UpdatePasswordOutcome と同じ形 (実装では change.ts から import する) */
export interface UpdatePasswordOutcome { error: { code: string | null; status: number } | null }
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const GoTrueErrorBodySchema = z.object({ code: z.unknown(), error_code: z.unknown() }).partial();
/** 版のヘッダを付けると code が文字列で返る。付かない古い形 (code が数値・error_code が文字列) も読む。どちらも無ければ null */
function gotrueErrorCodeOf(body: unknown): string | null {
  const parsed = GoTrueErrorBodySchema.safeParse(body);
  if (!parsed.success) return null;
  if (typeof parsed.data.code === 'string') return parsed.data.code;
  if (typeof parsed.data.error_code === 'string') return parsed.data.error_code;
  return null;
}
/**
 * accessToken = readSessionAuth(...).accessToken (Web は Cookie のセッションの token、モバイルは Bearer の JWT)。
 * 成功なら { error: null }。GoTrue が 4xx / 5xx なら { error: { code, status } } (例外にしない)。通信の失敗は fetch の例外のまま投げる。
 * パスワード・token・GoTrue の英文はログにも戻り値にも入れない
 */
export async function updatePasswordWithAccessToken(
  accessToken: string,
  newPassword: string,
  fetchImpl: FetchLike = fetch,
): Promise<UpdatePasswordOutcome> {
  const response = await fetchImpl(`${getSupabaseUrl()}${GOTRUE_USER_PATH}`, {
    method: 'PUT',
    headers: {
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      [GOTRUE_API_VERSION_HEADER]: GOTRUE_API_VERSION,
    },
    body: JSON.stringify({ password: newPassword }),
    cache: 'no-store',
  });
  if (response.ok) return { error: null };
  const body: unknown = await response.json().catch(() => null);
  return { error: { code: gotrueErrorCodeOf(body), status: response.status } };
}
```

GoTrue の `PUT /user` は、パスワードを変えた同じトランザクションで本人 (JWT の `session_id`) 以外のセッションを消す (P-1 / P-2 §3)。`secure_password_change` が ON で nonce が要るときは `code: 'reauthentication_needed'` が返る (§24)。

## 14. API 仕様

共通: `runtime = 'nodejs'`・`dynamic = 'force-dynamic'`・`Cache-Control: private, no-store`・本文の形は `{ error: 利用者向けの文言, code, ... }` (login route と同じ flat)。認証は `requireUser()` (Cookie / Bearer。凍結は 403 `AUTH_ACCOUNT_FROZEN`)。`AuthError` → 401 `AUTH_UNAUTHENTICATED`、`ForbiddenError` → 403 (code はそのまま)。本文を読む handler は最初に `rejectNullCharacterBody(request)`。5xx は `internalError(ROUTE_NAME, error, { userId })`。

### 14.1 `GET /api/auth/sessions`

`requireUser` → `const session = await readSessionAuth(supabase.auth, request.headers.get('authorization'))` (null なら 401) → `listLiveSessions(supabase, user.id)` → 各行を `{ session_id, created_at, last_active_at, device_label: deviceLabelOf(deviceFamilyOf(user_agent)), device_name, ip_address, country_code, is_current: session_id === session.claims.session_id }` に → 200 `SessionsResponseSchema`。

### 14.2 `DELETE /api/auth/sessions/{id}`

`params: Promise<{ id: string }>`・`isUuid(id)` でなければ 404 `AUTH_SESSION_NOT_FOUND` → `requireUser` → `revokeSession(supabase, id)` → `'revoked'` 200 `{ ok: true }` / `'current'` 409 `AUTH_SESSION_IS_CURRENT` / `'not_found'` 404 `AUTH_SESSION_NOT_FOUND`。

### 14.3 `POST /api/auth/sessions/revoke-others`

`requireUser` → `const session = await readSessionAuth(supabase.auth, request.headers.get('authorization'))` (null なら 401 `AUTH_UNAUTHENTICATED`) → `await signOutOtherSessions(getSupabaseAdmin(), session.accessToken)` (GoTrue の `/logout?scope=others` を本人の access token で。Web は Cookie のセッションの token、モバイルは Bearer の JWT。Cookie は触らない) → 例外なら `internalError` → `listLiveSessions(supabase, user.id)` で残りを数え 200 `{ ok: true, remaining: n }`。`createClient()` の `auth.signOut` は呼ばない (§3: Bearer だけの要求では何も消さずに成功を返す)。

### 14.4 `PATCH /api/auth/sessions/current`

本文 `DeviceNameBodySchema` (違えば 400 `VALIDATION_ERROR`) → `requireUser` → `readSessionAuth` (null なら 401) → `setCurrentDeviceName(admin, { userId: user.id, sessionId: session.claims.session_id, deviceName })` → true 200 `{ ok: true }` / false 404 `AUTH_SESSION_NOT_FOUND`。

### 14.5 `GET /api/auth/login-history`

`requireUser` → `listLoginHistory(supabase, user.id, LOGIN_HISTORY_PAGE_SIZE)` → `LoginHistoryResponseSchema` (`ended_at = revoked_at`)。

### 14.6 `POST /api/auth/password/change`

1. `rejectNullCharacterBody` → `readJsonBody` + `PasswordChangeBodySchema` (違えば 400 `VALIDATION_ERROR`) → `validatePassword(new_password)` (packages/shared。違えば 422 `VALID_PASSWORD_WEAK` に理由の文言) → `new_password === current_password` なら 422 `VALID_PASSWORD_HISTORY` (「現在のパスワードと違うものに」)。
2. `requireUser` → `const session = await readSessionAuth(supabase.auth, request.headers.get('authorization'))` (null なら 401 `AUTH_UNAUTHENTICATED`) → `checkRateLimit(user.id, 'auth-password-change')` (超過 429 `RATE_LIMITED` + `Retry-After`)。
3. roles: `supabase.from('user_profiles').select('roles').eq('id', user.id).maybeSingle()` (本人の行。無ければ `[]`) → `generations = passwordHistoryGenerationsFor(roles)`。
4. `performPasswordChange({ userId: user.id, currentPassword, newPassword, generations }, { checkPassword: admin.rpc('auth_password_check', …), updatePassword: (password) => updatePasswordWithAccessToken(session.accessToken, password) })`。`createClient()` の `auth.updateUser` は呼ばない (§3: Bearer だけのモバイルの要求ではセッションが無く必ず失敗する)。
5. 結果 → `changed` 200 `{ ok: true }` / `current_mismatch` 400 `AUTH_CURRENT_PASSWORD_MISMATCH` / `reused` 422 `VALID_PASSWORD_HISTORY` / `no_password` 409 `AUTH_PASSWORD_NOT_SET` / `unsupported_hash` 409 `AUTH_PASSWORD_NOT_SET` (文言は「この方法では変更できません。お問い合わせください」) / `weak` 422 `VALID_PASSWORD_WEAK` / `reauthentication_required` 403 `AUTH_REAUTHENTICATION_REQUIRED` / `upstream-error` → `internalError`。
6. 他の端末の失効は GoTrue が行う (P-1)。route は `signOut` を呼ばない。

### 14.7 `POST /api/auth/password/reset`

1 は `PasswordResetBodySchema`。2 は `requireUser` → `readSessionAuth` (null なら 401) → `!hasRecentRecoveryMethod(session.claims, new Date(), PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES)` なら 403 `AUTH_RECOVERY_SESSION_REQUIRED` (「再設定メールのリンクから開き直してください」。`amr` の `recovery` / `otp` §12.4) → rate-limit は `'auth-password-reset'`。4 は `currentPassword: null`・`updatePassword` は 14.6 と同じ (`updatePasswordWithAccessToken(session.accessToken, …)`)。5 の `current_mismatch` は起き得ない (起きたら `internalError`)。全端末のログアウトはページが行う (既存)。

### 14.8 `GET /api/cron/login-alerts` (Vercel Cron 毎分)

`const authError = await requireCronAuth(req); if (authError) return authError;` (CC-6 の形) → `resolveLoginAlertMode(process.env.AUTH_LOGIN_ALERT)` (ignored なら変数名だけ warn を 1 回) → `processLoginAlerts(deps, { alertMode })` → 200 `{ claimed, notified, skipped, failed }`。`claim` の失敗は `internalError`。`vercel.json` に `{ "path": "/api/cron/login-alerts", "schedule": "*/1 * * * *" }`。

### 14.9 `GET /api/admin/users/{id}/login-history` (段 D)

`requireRole(['admin', 'super_admin'])` (support は 403) → `isUuid` → `listLoginHistory(getSupabaseAdmin(), id, LOGIN_HISTORY_PAGE_SIZE)` → 1 件以上なら `recordAdminAudit({ supabase: admin, actorId: actor.id, actionType: 'admin.user.view_login_history', targetId: id, targetType: 'user', details: { returned_count }, request })` → 200 `{ data: { entries } }` (運営 API は nested。401/403 は `{ error: { code, message } }`。既存の `GET /api/admin/users/{id}` と同じ形)。

## 15. 画面 (Web)

| 画面 | 中身 |
|---|---|
| `/settings/security/sessions` (`src/app/(main)/settings/security/sessions/page.tsx`・client) | 見出し「ログイン中の端末」。`GET /api/auth/sessions` の各行をカードで: `device_name ?? device_label`・IP・国・「最後の利用: n 分前 / 日時」・「ログインした日時」。`is_current` に「この端末」のバッジ (ボタン無し)。他の行に「この端末をログアウトさせる」(確認ダイアログ → `DELETE`)。下に「他の端末をすべてログアウト」(確認 → `POST revoke-others`)。次の見出し「最近のログイン」(`GET /api/auth/login-history`): 日時・端末・IP・国・印 (`is_new_device` → 「新しい端末」、`is_new_country` → 「新しい地域」、`is_new_ip` → 「新しい接続元」の薄い印)・終了 (`signed_out` 「ログアウト」/ `revoked_by_user` 「この一覧から解除」/ `idle_expired` 「使われずに期限切れ」)。読み込み失敗・未ログインは `/settings/account` と同じ型 (`account-load-error` / `account-signed-out` の testid の流儀) |
| `/settings` (`src/app/(main)/settings/page.tsx`) | 「アカウント」のカードに行を足す: 「ログイン中の端末・ログイン履歴」(`data-testid="settings-sessions-link"` → `/settings/security/sessions`) |
| `/settings/account` | `PasswordChangeSection` を API 呼び出しに置き換える: `validatePasswordChangeInput` → `POST /api/auth/password/change` → 200 で成功の表示 (「この端末以外のログインはすべて解除しました」はそのまま。`result` の state を `{ othersSignedOut: boolean } \| null` から `boolean` (成功を出すか。送信の始めに `false`、200 で `true`) に改め、`othersSignedOut` の分岐と `data-testid="password-change-others-not-signed-out-note"` の段落、`describeOthersNotSignedOutNote` の import と呼び出しは消す。GoTrue が更新と同じトランザクションで他の端末を消すので、200 なら他の端末は必ず消えている §13.7。`describeForgotCurrentPasswordNote` はそのまま)。`src/lib/auth/logout-guidance.ts` の `describeOthersNotSignedOutNote` は呼ぶ所が無くなるので関数ごと消す (§22 N-33) / 400 `AUTH_CURRENT_PASSWORD_MISMATCH` → 「現在のパスワードが正しくありません。」/ 422 → 本文の `error` / 403 `AUTH_REAUTHENTICATION_REQUIRED` → 「もう一度ログインしてから変更してください。」/ 401 → ログイン画面への案内 / 429・500 → 共通の文言。`TurnstileWidget` と `useTurnstile` はこのセクションから外す (再認証のサインインが無くなるため。#1474 の対象は `/auth/verify` だけになる) |
| `/auth/reset-password` | `supabase.auth.updateUser` を `POST /api/auth/password/reset` に置き換える。成功後の `signOutEverywhere` (clear → `signOut global` → broadcast) と 3 秒後の `/login` はそのまま。422 → 本文の `error`。403 `AUTH_RECOVERY_SESSION_REQUIRED` → 「リンクが無効です」の画面と同じ案内 |
| Web の通信 (`src/lib/auth/sessions/client.ts`・`src/lib/auth/password/client.ts`) | `fetch` の薄い包み: `listSessions()` / `revokeSession(id)` / `revokeOtherSessions()` / `listLoginHistory()` / `changePassword(body)` / `resetPassword(body)`。応答は Zod で検証。エラーは `{ code, message }` に正規化 |

## 16. モバイル

| ファイル | 中身 |
|---|---|
| `apps/mobile/src/lib/sessions-api.ts` (新規) | `getApi()` で `GET /api/auth/sessions`・`DELETE /api/auth/sessions/{id}`・`POST /api/auth/sessions/revoke-others`・`GET /api/auth/login-history`・`PATCH /api/auth/sessions/current` を呼ぶ関数 5 つ。応答は `packages/shared` に写した Zod (§25 Q-7) か、同じ形の型で受ける |
| `apps/mobile/src/lib/device-name.ts` (新規) | `deviceNameOf()`: `expo-device` の `modelName ?? deviceName ?? Platform.OS` + `(osName osVersion)` を 200 文字に切る。`registerDeviceName(userId)`: プロセスの中で同じ `userId` には 1 回だけ `PATCH sessions/current` (失敗は無視・ログだけ) |
| `apps/mobile/src/providers/AuthProvider.tsx` (変更) | `onAuthStateChange` の `SIGNED_IN` と `INITIAL_SESSION` で `session?.user.id` があれば `registerDeviceName(session.user.id)` を fire-and-forget (既存の掃除の表には触らない) |
| `apps/mobile/app/settings/sessions.tsx` (新規) | §15 の `/settings/security/sessions` と同じ構成 (一覧・この端末・解除・他の端末をすべて・最近のログイン)。`testID="sessions-screen"` |
| `apps/mobile/app/(tabs)/settings.tsx` (変更) | 「アカウント」に `SettingRow` を足す: 「ログイン中の端末」(`testID="settings-sessions-row"` → `/settings/sessions`) |
| `apps/mobile/src/lib/account-credentials.ts` (変更) | `changePassword(email, input)` の中身を `getApi().post('/api/auth/password/change', { current_password, new_password })` に (送るのは Bearer だけ。サーバーは Bearer の JWT で GoTrue を呼ぶ §13.7)。戻りの型 `{ ok: true; othersSignedOut: boolean }` は `{ ok: true }` に改め、`othersSignedOut` は消す。エラーの code → 文言は `packages/shared/src/account-change-errors.ts` に `describePasswordChangeApiError(code)` を足す (Web と共通) |
| `apps/mobile/src/components/settings/AccountCredentialsSection.tsx` (変更) | `result` の state を `{ othersSignedOut: boolean } \| null` から `boolean` (変更できたか。`useState(false)`・送信の始めに `setResult(false)`・成功で `setResult(true)`) に改める。成功の帯の文は常に「セキュリティのため、この端末以外のログインはすべて解除しました。他の端末では、新しいパスワードでログインし直してください。」(「ただし、他の端末のログアウトを確認できませんでした…」の枝は消す)。ほかの表示・testID は変えない |
| `apps/mobile/app/(auth)/auth/reset-password.tsx` (変更) | `supabase.auth.updateUser({ password })` を `getApi().post('/api/auth/password/reset', { new_password })` に。成功後の `signOutWithCleanup` はそのまま |

## 17. 運営の画面 (段 D)

`src/app/admin/users/[id]/page.tsx`: `actor.roles` に admin / super_admin があるときだけ `adminFetch('/api/admin/users/{id}/login-history')` を呼び、「ログイン履歴 (直近 20 回)」の表を描く: 日時 (`toLocaleString('ja-JP')`)・端末 (`device_name ?? device_label`)・IP・国・印 (新しい端末 / 接続元 / 地域)・通知 (`alert_sent_at` の有無)・終了 (理由)。0 件は「記録なし」。support には節を出さない (API も 403)。

## 18. メール `login_new_device` (`src/lib/emails/account/login-new-device.ts`)

```ts
// src/lib/emails/account/login-new-device.ts
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { emailSignature } from '@/lib/emails/common';
import { getEmailFrom, getSiteUrl, getSupportEmail } from '@/lib/site-config';
const DISPLAY_TIME_ZONE = 'Asia/Tokyo';
const LOGGED_IN_AT_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export const SESSIONS_SETTINGS_PATH = '/settings/security/sessions';
export const ACCOUNT_SETTINGS_PATH = '/settings/account';
export interface LoginNewDeviceEmailVars {
  to_email: string;
  logged_in_at: Date;
  /** device_name ?? deviceLabelOf(deviceFamilyOf(user_agent)) */
  device_label: string;
  ip_address: string | null;
  country_code: string | null;
}
export function renderLoginNewDeviceEmail(vars: LoginNewDeviceEmailVars): EmailEnvelope {
  const where = [vars.ip_address ? `IP アドレス: ${vars.ip_address}` : null, vars.country_code ? `国: ${vars.country_code}` : null]
    .filter((line): line is string => line !== null)
    .join('\n');
  return {
    template: 'login_new_device',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: '【ほめゴハン】新しい端末からのログインがありました',
    text: `${LOGGED_IN_AT_FORMAT.format(vars.logged_in_at)} (日本時間) に、これまでと違う端末または地域から、このメールアドレスのアカウントへのログインがありました。

端末: ${vars.device_label}
${where}

ご自身の操作であれば、このメールは無視してください。

心当たりが無い場合は、すぐに次の対応をお願いします。
1. パスワードを変更する: ${getSiteUrl()}${ACCOUNT_SETTINGS_PATH}
2. 見覚えの無い端末をログアウトさせる: ${getSiteUrl()}${SESSIONS_SETTINGS_PATH}
3. 解決しないときは ${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`,
  };
}
```

送信は worker だけ (`sendEmail(envelope, { idempotencyKey: \`login-alert:${session_id}\` })`)。宛先は本人の登録メールアドレス (利用者が指定したアドレスではない) なので、招待の回数制限 (`invite-throttle`) は通さない (§22 N-18 の除外)。

## 19. エラー表 (全 code)

| code | HTTP | どこで | 文言 (利用者向け) |
|---|---|---|---|
| `VALIDATION_ERROR` (既存) | 400 | 本文の形 | 「入力の内容を確認してください。」 |
| `INVALID_CHARACTER` (既存) | 400 | NULL 文字 | 既存 |
| `AUTH_CURRENT_PASSWORD_MISMATCH` (新) | 400 | change | 「現在のパスワードが正しくありません。」 |
| `AUTH_UNAUTHENTICATED` (既存) | 401 | 全部 | 既存 |
| `AUTH_ACCOUNT_FROZEN` (既存) | 403 | 全部 | 既存 |
| `AUTH_RECOVERY_SESSION_REQUIRED` (新) | 403 | reset | 「パスワードの再設定は、再設定メールのリンクから開き直してください。」 |
| `AUTH_REAUTHENTICATION_REQUIRED` (新) | 403 | change | 「安全のため、もう一度ログインしてから変更してください。」 |
| `PERM_DENIED` (既存) | 403 | admin API (support) | 既存 |
| `AUTH_SESSION_NOT_FOUND` (新) | 404 | sessions/{id}・current | 「その端末のログインは、すでに終了しています。」 |
| `AUTH_SESSION_IS_CURRENT` (新) | 409 | sessions/{id} | 「いま使っている端末は、ここでは解除できません。ログアウトを使ってください。」 |
| `AUTH_PASSWORD_NOT_SET` (新) | 409 | change / reset | 「このアカウントはパスワードでログインしていないため、変更できません。」 |
| `VALID_PASSWORD_WEAK` (新) | 422 | change / reset | `validatePassword` の理由 |
| `VALID_PASSWORD_HISTORY` (既存 cross/04) | 422 | change / reset | 「最近使ったパスワードは使えません。別のパスワードにしてください。」 |
| `RATE_LIMITED` (既存) | 429 | change / reset | 既存 |
| `INTERNAL_ERROR` (既存) | 500 | 全部 | 既存 |
| `cron_disabled` / `unauthorized` (既存 cron-auth) | 503 / 401 | cron | 既存 |

## 20. テスト一覧 (it 名)

### 20.1 単体 (段 A。`src/lib/auth/__tests__/`)

- `sessions-device-family.test.ts`: 「iPhone の Safari を ios/safari にする」「Android の Chrome を android/chrome にする」「Windows の Edge を edge にする (Chrome より先に見る)」「Mac の Firefox を macos/firefox にする」「CFNetwork を含む UA を ios/app にする」「okhttp を android/app にする」「node・undici・Vercel Edge Functions を other/server にする」「空・null を other/other にする」「512 文字より後ろは見ない」「deviceLabelOf が app・server・不明・ブラウザの 4 つの形の文言を返す」
- `sessions-login-alert-policy.test.ts`: 「履歴が無く、アカウントが保持の日数以内に作られたなら first_login で送らない (保持の日数ちょうども first_login)」「履歴が無く、アカウントが保持の日数より前に作られたなら history_expired で、端末の種類が分かれば送る」「history_expired でも server の UA なら送らない」「同じ端末の種類と同じ IP の範囲は known」「端末の種類が新しければ new_device で送る」「IP の範囲だけが新しいときは isNewIp だけで送らない」「国が分かる履歴があり国が違えば new_country で送る」「国が分からない履歴しか無ければ国では送らない」「server の UA の行は端末の種類が不明として扱い、new_device にしない」「端末と国が両方新しければ new_device_and_country」
- `sessions-session-claims.test.ts`: 「Bearer があれば getSession を呼ばずその JWT を getClaims に渡し、accessToken にその JWT を返す」「Bearer が無ければ Cookie のセッションの access_token を渡し、accessToken にその token を返す」「token が無い・getClaims が error・claims の形が違うときは null」「hasRecentRecoveryMethod は 60 分以内の recovery を真にする」「hasRecentRecoveryMethod は 60 分以内の otp を真にする」「password・oauth だけなら偽」「60 分より古い recovery / otp は偽」
- `password-gotrue-user.test.ts`: 「PUT <SUPABASE_URL>/auth/v1/user に Bearer の access token・apikey・X-Supabase-Api-Version: 2024-01-01 を付け、本文は password だけ」「2xx なら error は null」「4xx の本文の code (文字列) と status を返す」「code が数値で error_code が文字列の古い形は error_code を返す」「本文が JSON でなければ code は null で status を返す」「fetch の例外はそのまま投げる」
- `sessions-constants.test.ts`: 「AUTH_LOGIN_ALERT は未設定で on、off で off、ほかの値は on に戻して ignored」
- `sessions-ip-network.test.ts`: 「IPv4 を /24 の範囲にする」「IPv6 を /48 の範囲にする」「不正な文字列は null」
- `password-policy.test.ts`: 「運営のロールを 1 つでも持てば 10」「org_ のロールは 5」「それ以外は 3」「空の配列は 3」
- `password-change.test.ts`: 「checkPassword が ok 以外なら updatePassword を呼ばず同じ kind を返す」「updatePassword の weak_password → weak」「same_password → reused」「reauthentication_needed → reauthentication_required」「その他のエラー → upstream-error に code と status」「成功 → changed」
- `sessions-login-alert-worker.test.ts` (段 B): 「取り置いた行ごとに判定し、送るべき行だけ send を呼ぶ」「decideLoginAlert に accountOf の createdAt・now()・LOGIN_HISTORY_RETENTION_DAYS を渡す (prior が空で古いアカウントなら送る)」「accountOf が null の行は送らずに印を false で finish し、skipped に数える」「alertMode が off なら送らず印だけ finish する」「email が無い行は skipped」「send が ok: false でも done (sentAt null) にして再送しない」「1 行の例外は release して次へ進み、failed に数える」「戻り値に件数だけを返す」

### 20.2 route (`tests/api/`)

- `auth-sessions-routes.test.ts` (B): 「GET は本人の live の行を device_label と is_current つきで返す」「GET は claims が読めなければ 401」「DELETE は revoked で 200、current で 409、not_found で 404、UUID でなければ 404」「DELETE は RPC を本人の client で呼ぶ (service_role を使わない)」「revoke-others は Cookie のセッションの access token で auth.admin.signOut(token, 'others') を呼び、残りの件数を返す」「revoke-others は Bearer だけの要求 (Cookie 無し) でも Bearer の JWT を auth.admin.signOut に渡す」「revoke-others は createClient() の auth.signOut を呼ばない」「revoke-others は auth.admin.signOut が error なら 500 で remaining を返さない」「revoke-others は claims が読めなければ 401」「PATCH current は device_name を検証し、行が無ければ 404」「login-history は 20 件まで」「凍結中は 403」「どの応答にも Cache-Control: private, no-store」
- `auth-password-routes.test.ts` (C): 「change: 入力の検証で弾くときは RPC も updateUser も呼ばない」「change: current_mismatch → 400」「change: reused → 422 VALID_PASSWORD_HISTORY」「change: no_password → 409」「change: 成功 → 200 で signOut を呼ばない」「change: rate-limit 超過 → 429」「change: roles から世代数を決めて RPC に渡す (super_admin は 10)」「change: Bearer だけの要求 (Cookie 無し) でも createClient() の auth.updateUser を呼ばず、updatePasswordWithAccessToken に Bearer の JWT を渡す」「change: Cookie の要求では Cookie のセッションの access token を渡す」「change: updatePasswordWithAccessToken の weak_password → 422 VALID_PASSWORD_WEAK」「reset: amr に recovery も otp も無い (password) → 403」「reset: 60 分より古い recovery → 403」「reset: amr の recovery (PKCE) → 200」「reset: amr の otp (token_hash / implicit) → 200」「reset: Bearer だけの要求でも Bearer の JWT で更新する」「本文にパスワードも生のエラー文も出ない」
- `cron-login-alerts-route.test.ts` (B): 「CRON_SECRET が合わなければ 401」「AUTH_LOGIN_ALERT=off を worker に渡す」「不正な値は変数名だけを warn に出す」「応答は件数だけ」
- `admin-user-login-history-route.test.ts` (D): 「support は 403」「admin は 20 件を返し admin.user.view_login_history を 1 行記録する」「0 件のときは記録しない」「UUID でなければ 404」

### 20.3 走査・契約 (`tests/`)

- `auth-history-sessions-migration-contract.test.ts` (A): 「トリガー関数 4 本は SECURITY DEFINER・search_path = ''・EXCEPTION WHEN OTHERS を持つ」「SQL の /24・/48・30 days・90 days・c_max_generations 10 が constants.ts / policy.ts の値と一致する」「auth.sessions に 3 本・auth.users に 1 本のトリガーを CREATE する」「RPC 2 本と保守 3 本の REVOKE / GRANT が決めたとおり」「.down.sql が migration の作るもの (トリガー・関数・索引・制約・列・ジョブ) を全部消し、ポリシーと GRANT を戻す」「pg_cron のジョブの名前と時刻」
- `auth/web-login-context-source-scan.test.ts` (B): 「src/app の route.ts で signInWithPassword / exchangeCodeForSession / verifyOtp を呼ぶ handler は、同じ handler で recordWebLoginContext を呼ぶ (login と callback の 2 ファイル)」
- `auth/password-update-source-scan.test.ts` (C): 「src と apps/mobile の本番コードに updateUser({ password の呼び出しが無い (API を通す)」「signInWithPassword を本人確認に使う画面 (settings/account・account-credentials) が無い」「src/app/api/auth/sessions/revoke-others/route.ts と src/app/api/auth/password/**/route.ts は auth.signOut( と auth.updateUser( を呼ばない (本人の access token で GoTrue を呼ぶ §13.7・§14.3。Bearer だけの要求で黙って失敗する形に戻さない)」
- `tests/integration/security/auth-history-sessions.test.ts` (A。ローカル Supabase): 「パスワードでサインインすると user_sessions_metadata に 1 行 (ip / user_agent / ip_network) と last_login_at / login_count が入る」「refresh で last_active_at が進み、user_agent は変わらない」「signOut (global) で revoked_at と signed_out」「auth_session_revoke は他人の行を消せず not_found、本人の他の行を消すと revoked、自分の行は current」「消した後の JWT で getUser すると session_not_found」「updateUser で password_history が 1 行増え、11 回変えると 10 行に切り詰まる」「auth_password_check が current_mismatch / reused / ok / no_password を返す」「expire_idle_auth_sessions が refreshed_at の古い行だけを消して idle_expired にする」「reconcile が auth.sessions に無い live の行を signed_out にする」「cleanup が 90 日より古い終了行だけを消す」「anon / authenticated は 5 本の関数のうち auth_session_revoke だけを (authenticated が) 実行できる」「トリガー関数の本体を壊しても (search_path を変えて失敗させても) サインインは成功する」「Cookie を持たず Bearer の JWT だけで updatePasswordWithAccessToken を呼ぶと、encrypted_password が変わり、呼んだセッションは残り、同じ利用者の他のセッションは消える」「signOutOtherSessions(admin, Bearer の JWT) は同じ利用者の他のセッションを消し、呼んだセッションは残す」「generate_link (recovery) → POST /verify (token_hash) で作ったセッションの JWT は amr に otp を持ち、hasRecentRecoveryMethod が真」「パスワードでサインインしたセッションの JWT は amr が password で、hasRecentRecoveryMethod が偽」「listPriorLogins は created_at が 90 日より前の live の行も返し、自分の行と、後に作られた行は返さない」

### 20.4 画面 (Web `src/__tests__/app/`・モバイル `apps/mobile/__tests__/`)

- `settings/sessions-page.test.tsx` (B): 「ログイン中の端末を一覧し、この端末にはバッジを出して解除のボタンを出さない」「解除は確認のあと DELETE を呼び、成功したら一覧から消す」「他の端末をすべてログアウトは確認のあと POST を呼ぶ」「最近のログインの印 (新しい端末・地域) を出す」「読み込み失敗ともう一度読み込む」「未ログインの案内」
- `settings/account-page.test.ts` (C。既存の書き換え。describe ごとの扱いは §22 N-24): 成功の it を「POST /api/auth/password/change を 1 回呼び、signInWithPassword / updateUser / signOut を呼ばない」に。再認証の失敗の it を「400 AUTH_CURRENT_PASSWORD_MISMATCH で『現在のパスワードが正しくありません』」に。「422 VALID_PASSWORD_HISTORY の文言」「403 AUTH_REAUTHENTICATION_REQUIRED の文言」を足す。「他の端末のログアウトを確認できなかった」の it は削除。Turnstile の it は削除
- `src/__tests__/lib/auth/logout-guidance.test.ts` (C。既存の書き換え §22 N-33): 「アカウント画面は、案内の文を直書きせず、この出し分けを使う」の it から `describeOthersNotSignedOutNote` の期待を外し、`not.toContain('describeOthersNotSignedOutNote')` を足す。describe「#1552 他の端末のログアウトを確認できなかったときの注意書き」は削除
- `apps/mobile/__tests__/settings/sessions.test.tsx` (B): 「一覧・この端末・解除・他の端末をすべて・最近のログイン」の 5 本
- `apps/mobile/__tests__/lib/device-name.test.ts` (B): 「expo-device の値から 200 文字以内の端末名を作る」「同じ利用者には 1 回だけ PATCH する」「失敗しても例外を投げない」
- `apps/mobile/__tests__/lib/account-credentials.test.ts` (C。書き換え): 「API を 1 回呼び、Supabase の signInWithPassword / updateUser / signOut を呼ばない」「成功は { ok: true } (othersSignedOut を持たない)」「400 / 422 / 403 / 通信エラーの文言」
- `apps/mobile/__tests__/settings/account-credentials.test.tsx` (C。書き換え §22 N-27): 「3. パスワードの変更の API を 1 回呼び、成功を表示して入力を消す」「成功の帯は常に『この端末以外のログインはすべて解除しました』」(「他の端末のログアウトを確認できなかったときは、成功に注意書きを添える」の it は削除)「4. 現在のパスワードが違えば (400)、理由を表示し、入力は残す」「連打しても、API は 1 回しか呼ばない」
- `apps/mobile/__tests__/auth/reset-password.test.tsx` (C。it 3 の書き換え): 「POST /api/auth/password/reset を呼び、成功後は共通のログアウトでログイン画面へ」

## 21. 触るファイルの母集合・新設一覧・段

### 21.1 新設 (ファイル)

| 段 | ファイル | 中身 |
|---|---|---|
| A | `supabase/migrations/<番号はマージ時に確定>_auth_history_sessions.sql` / `supabase/rollbacks/<番号はマージ時に確定>_auth_history_sessions.down.sql` | §11 |
| A | `src/lib/auth/sessions/constants.ts`・`device-family.ts`・`ip-network.ts`・`login-alert-policy.ts`・`session-claims.ts`・`schemas.ts`・`store.ts`・`request-context.ts` | §12.1〜12.5・§13.1・§13.5 |
| A | `src/lib/auth/password/policy.ts`・`change.ts`・`gotrue-user.ts` | §12.2・§13.2・§13.7 |
| A | テスト: §20.1 の 8 本 (worker を除く)・§20.3 の契約 1 本と結合 1 本 |
| B | `src/lib/auth/sessions/login-alert-worker.ts`・`client.ts`・`src/lib/emails/account/login-new-device.ts` | §13.3・§15・§18 |
| B | `src/app/api/auth/sessions/route.ts`・`sessions/[id]/route.ts`・`sessions/current/route.ts`・`sessions/revoke-others/route.ts`・`login-history/route.ts`・`src/app/api/cron/login-alerts/route.ts` | §14.1〜14.5・§14.8 |
| B | `src/app/(main)/settings/security/sessions/page.tsx`・`apps/mobile/app/settings/sessions.tsx`・`apps/mobile/src/lib/sessions-api.ts`・`apps/mobile/src/lib/device-name.ts` | §15・§16 |
| B | テスト: `sessions-login-alert-worker.test.ts`・`tests/api/auth-sessions-routes.test.ts`・`tests/api/cron-login-alerts-route.test.ts`・`tests/auth/web-login-context-source-scan.test.ts`・画面 3 本 |
| C | `src/app/api/auth/password/change/route.ts`・`reset/route.ts`・`src/lib/auth/password/client.ts` | §14.6・14.7 |
| C | テスト: `tests/api/auth-password-routes.test.ts`・`tests/auth/password-update-source-scan.test.ts` |
| D | `src/app/api/admin/users/[id]/login-history/route.ts`・`tests/api/admin-user-login-history-route.test.ts` | §14.9・§17 |

### 21.2 新設 (識別子)

| 種類 | 名前 |
|---|---|
| 定数 | `IP_NETWORK_PREFIX_V4`・`IP_NETWORK_PREFIX_V6`・`LOGIN_HISTORY_RETENTION_DAYS`・`SESSION_IDLE_EXPIRE_DAYS`・`LOGIN_ALERT_BATCH_SIZE`・`LOGIN_ALERT_MIN_AGE_SECONDS`・`LOGIN_ALERT_RECLAIM_MINUTES`・`LOGIN_ALERT_MAX_ATTEMPTS`・`LOGIN_HISTORY_PAGE_SIZE`・`AUTH_LOGIN_ALERT_ENV_NAME`・`SERVER_DEVICE_FAMILY_KEY`・`PASSWORD_HISTORY_GENERATIONS`・`PASSWORD_HISTORY_MAX_GENERATIONS`・`PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES`・`RECOVERY_AMR_METHODS`・`LOGIN_ALERT_PRIOR_MAX_ROWS`・`GOTRUE_API_VERSION`・`GOTRUE_API_VERSION_HEADER`・`GOTRUE_USER_PATH`・`PASSWORD_INPUT_MAX_LENGTH`・`DEVICE_NAME_MAX_LENGTH`・`SESSIONS_SETTINGS_PATH`・`ACCOUNT_SETTINGS_PATH` |
| Zod | `SessionClaimsSchema`・`PasswordChangeBodySchema`・`PasswordResetBodySchema`・`DeviceNameBodySchema`・`EndedReasonSchema`・`SessionSummarySchema`・`SessionsResponseSchema`・`LoginHistoryEntrySchema`・`LoginHistoryResponseSchema` |
| 型 | `LoginAlertMode`・`LoginAlertSetting`・`DeviceOs`・`DeviceClient`・`DeviceFamily`・`LoginContext`・`LoginAlertReason`・`LoginAlertDecision`・`LoginHistoryHorizon`・`SessionClaims`・`SessionClaimsReader`・`SessionAuth`・`PriorLoginRow`・`LoginAlertAccount`・`FetchLike`・`ContextSource`・`EndedReason`・`AlertStatus`・`SessionRow`・`RevokeOutcome`・`PasswordCheckOutcome`・`PasswordChangeInput`・`UpdatePasswordOutcome`・`PasswordChangeDeps`・`PasswordChangeResult`・`LoginAlertRow`・`PriorLogin`・`LoginAlertWorkerDeps`・`LoginAlertWorkerSummary`・`SessionSummary`・`LoginHistoryEntry`・`LoginNewDeviceEmailVars` |
| 関数 | `resolveLoginAlertMode`・`deviceFamilyOf`・`deviceLabelOf`・`ipNetworkOf`・`decideLoginAlert`・`bearerTokenOf`・`readSessionAuth`・`hasRecentRecoveryMethod`・`passwordHistoryGenerationsFor`・`performPasswordChange`・`updatePasswordWithAccessToken`・`listLiveSessions`・`listLoginHistory`・`listPriorLogins`・`revokeSession`・`signOutOtherSessions`・`setCurrentDeviceName`・`recordWebLoginContext`・`claimLoginAlerts`・`finishLoginAlert`・`releaseLoginAlert`・`processLoginAlerts`・`countryCodeOf`・`renderLoginNewDeviceEmail`・Web の `listSessions` / `revokeSession` / `revokeOtherSessions` / `listLoginHistory` / `changePassword` / `resetPassword`・共通の `describePasswordChangeApiError`・モバイルの `deviceNameOf` / `registerDeviceName` |
| route | `GET /api/auth/sessions`・`DELETE /api/auth/sessions/{id}`・`PATCH /api/auth/sessions/current`・`POST /api/auth/sessions/revoke-others`・`GET /api/auth/login-history`・`POST /api/auth/password/change`・`POST /api/auth/password/reset`・`GET /api/cron/login-alerts`・`GET /api/admin/users/{id}/login-history` |
| 画面 | `/settings/security/sessions` (Web)・`/settings/sessions` (モバイル) |
| 列 (`user_sessions_metadata`) | `ip_network`・`country_code`・`context_source`・`device_family`・`is_new_device`・`is_new_ip`・`is_new_country`・`alert_status`・`alert_claimed_at`・`alert_attempts`・`alert_sent_at`・`ended_reason` |
| 索引・制約 | `idx_sessions_alert_queue`・`idx_sessions_ended`・`user_sessions_metadata_context_source_check`・`_alert_status_check`・`_ended_reason_check` |
| DB の関数 | トリガー関数 `auth_session_created`・`auth_session_refreshed`・`auth_session_deleted`・`password_history_record` / RPC `auth_session_revoke(uuid)`・`auth_password_check(uuid, text, text, integer)` / 保守 `expire_idle_auth_sessions()`・`reconcile_user_sessions_metadata()`・`cleanup_ended_user_sessions_metadata()` |
| トリガー | `on_auth_session_created`・`on_auth_session_refreshed`・`on_auth_session_deleted` (`auth.sessions`)・`on_auth_user_password_changed` (`auth.users`) |
| pg_cron | `cleanup-auth-sessions-and-login-history` (`55 18 * * *`) |
| Vercel Cron | `/api/cron/login-alerts` (`*/1 * * * *`) |
| 消すもの | ポリシー `sessions_revoke_self` |
| rate-limit | `'auth-password-change'`・`'auth-password-reset'` |
| 環境変数 | `AUTH_LOGIN_ALERT` |
| エラーコード (新) | `AUTH_CURRENT_PASSWORD_MISMATCH`・`AUTH_RECOVERY_SESSION_REQUIRED`・`AUTH_REAUTHENTICATION_REQUIRED`・`AUTH_SESSION_NOT_FOUND`・`AUTH_SESSION_IS_CURRENT`・`AUTH_PASSWORD_NOT_SET`・`VALID_PASSWORD_WEAK` |
| メールの template | `login_new_device` |
| 監査 action_type | `admin.user.view_login_history` |

### 21.3 変更 (既存ファイル)

| 段 | ファイル | 変更 |
|---|---|---|
| A | `src/types/database.types.ts`・`packages/shared/src/database.types.ts` | 作り直し (§11.8) |
| B | `src/app/api/auth/login/route.ts`・`src/app/(auth)/auth/callback/route.ts` | ログイン成功の直後に `recordWebLoginContext` (§13.5) |
| B | `src/app/(main)/settings/page.tsx`・`apps/mobile/app/(tabs)/settings.tsx`・`apps/mobile/src/providers/AuthProvider.tsx` | 導線・端末名の登録 (§15・§16) |
| A | `docs/design/operator/08-cron-batches.md` | pg_cron の記述 (§3.0・§3.1 の注記) にジョブ `cleanup-auth-sessions-and-login-history` を足し本数を +1 (§22 N-32・§23) |
| B | `vercel.json`・`src/lib/env.ts`・`.env.example` | cron・`AUTH_LOGIN_ALERT` (§12.6) |
| B | `docs/design/operator/08-cron-batches.md` | Vercel Cron の記述 (§3.0・§3.2 の表と注記・§5 の注記) に `login-alerts` を足し本数を +1 (§22 N-32・§23) |
| B | `tests/ai-usage-contract.test.ts`・`tests/email-send-throttle-contract.test.ts`・`src/__tests__/api/null-character-routes.test.ts`・(赤なら) `tests/helpers/ai-consent-enforced-paths.ts` | §22 |
| C | `src/lib/rate-limit.ts` | カテゴリ 2 つ |
| C | `src/app/(main)/settings/account/page.tsx`・`src/app/(auth)/auth/reset-password/page.tsx`・`apps/mobile/src/lib/account-credentials.ts`・`apps/mobile/src/components/settings/AccountCredentialsSection.tsx`・`apps/mobile/app/(auth)/auth/reset-password.tsx`・`packages/shared/src/account-change-errors.ts` | API 経由 (§15・§16) |
| C | `src/lib/auth/logout-guidance.ts` | `describeOthersNotSignedOutNote` を消す (呼ぶ所が無くなる §15・§22 N-33)。`describeForgotCurrentPasswordNote` と定数 3 つはそのまま |
| C | `src/__tests__/app/settings/account-page.test.ts`・`tests/auth/reset-password-session-revoke.test.ts`・`tests/auth-turnstile-resend-password-change.test.tsx`・`apps/mobile/__tests__/lib/account-credentials.test.ts`・`apps/mobile/__tests__/settings/account-credentials.test.tsx`・`apps/mobile/__tests__/auth/reset-password.test.tsx`・`src/__tests__/api/null-character-routes.test.ts`・`src/__tests__/app/faq/account-answers.test.ts`・`src/__tests__/lib/auth/logout-guidance.test.ts` | §22 N-24〜N-28・N-31・N-33 |
| D | `src/app/admin/users/[id]/page.tsx` | ログイン履歴の節 (§17) |

## 22. 既存の番兵 (契約テスト・走査テスト) の追随表

grep の語 = 本設計が足す・変える名前。反応するテストと直し方。

| # | 番兵 | grep の語 | 反応する理由 | 直し方 | 段 |
|---|---|---|---|---|---|
| N-1 | `tests/database-types-migrations-contract.test.ts` | `auth_session_revoke`・`auth_password_check`・`expire_idle_auth_sessions`・`reconcile_user_sessions_metadata`・`cleanup_ended_user_sessions_metadata` | migration の CREATE FUNCTION が型ファイルに無い (トリガー関数は規則で除外) | 型を作り直して 2 ファイルに写す (§11.8) | A |
| N-2 | `tests/env-source-scan.test.ts`・`src/__tests__/lib/env.test.ts`・`tests/check-env-script.test.ts` | `AUTH_LOGIN_ALERT`・`process.env.AUTH_LOGIN_ALERT` | 一覧に無い変数を読む / `.env.example` に無い / readOnlyBy 以外が読む | `SERVER_ENV_VARS` に `readOnlyBy: 'src/app/api/cron/login-alerts/route.ts'`・`.env.example` に説明。値を読むのは cron route だけ | B |
| N-3 | `tests/rate-limit-single-implementation.test.ts` | `@upstash/ratelimit` | route が自前の制限を持つと赤 | `checkRateLimit(user.id, 'auth-password-change' \| 'auth-password-reset')` だけ | C |
| N-4 | `tests/supabase-service-role-client-scan.test.ts` | `createClient` (`@supabase/supabase-js`)・`SUPABASE_SERVICE_ROLE_KEY` | 自前で service_role の client を作ると赤 | `getSupabaseAdmin()` だけ (store.ts は client を引数で受ける) | A〜D |
| N-5 | `tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts` | `error.message`・`internalError` | 本文に Supabase の生の文を入れると赤 | 4xx は §19 の固定の文、5xx は `internalError`。`validatePassword` の文言 (こちらが書いた文) は出してよい | B〜D |
| N-6 | `tests/next15-async-request-api-scan.test.ts` | `createClient()`・`headers()`・`params` | await 無し / `params` が Promise でないと赤 | `await createClient()`・`(await headers())`・`sessions/[id]` と `admin/users/[id]/login-history` は `params: Promise<{ id: string }>` | B・D |
| N-7 | `tests/role-check-source-scan.test.ts` | `requireRole(`・`roles?.` | route で roles を手書き判定すると赤 | admin の route は `requireRole(['admin', 'super_admin'])`。password/change が読む `user_profiles.roles` は認可ではなく世代数の入力 (配列の `some` を使わず `passwordHistoryGenerationsFor` に渡す。走査は `.roles` に続く `some` / `includes` 等を見るので、route では `profile?.roles ?? []` を渡すだけにする) | C・D |
| N-8 | `tests/admin-view-audit-1326.test.ts` (b) | `admin_audit_logs`・`x-forwarded-for` | `src/app/api/admin/**` で直接 INSERT / 直読みすると赤 | `recordAdminAudit` 経由 | D |
| N-9 | `tests/account-export-tables.test.ts` (`設計上の不変条件`) | `user_sessions_metadata`・`password_history` | 既に `ACCOUNT_EXPORT_EXCLUDED`。列を足しても分類は変わらない | 変更なし (走らせて確認) | A |
| N-10 | `tests/auth/no-login-lockout.test.ts` | `AUTH_ACCOUNT_LOCKED`・`locked_until`・`423` 等 | `/api/auth/*` で 423 を返す・禁止の語を書くと赤。文書の走査もある | 本書と実装は「失効」「終了」「ログアウト」で書く。新 route は 423 を返さない | 全部 |
| N-11 | `tests/helpers/ai-consent-enforced-paths.ts`・`tests/ai-consent-enforcement*.test.ts` | `src/app/api/auth/sessions/`・`password/`・`cron/login-alerts` | import を辿って `src/lib/env.ts` (AI の名前を含む) に届く route は分類が要ることがある | 走らせて赤なら `EXEMPT_ROUTES` に `noAi` で足す (`src/app/api/auth/login/route.ts` の行と同じ形)。cron は「判定を呼ぶか AI へ送らない route」の it にも当たる | B・C |
| N-12 | `tests/ai-usage-contract.test.ts` の `CRON_ENTRYPOINTS` | `vercel:/api/cron/login-alerts` | vercel.json の cron の全数と突き合わせる | `'vercel:/api/cron/login-alerts': '新しい端末からのログインを本人にメールで知らせる (AI を使わない)'` を足す | B |
| N-13 | `tests/cron-secret-contract.test.ts` CC-6 | `requireCronAuth` | cron の route は決まった形で await していないと赤 | `const authError = await requireCronAuth(req); if (authError) return authError;` をそのまま書く | B |
| N-14 | `src/__tests__/api/null-character-routes.test.ts` | `request.json()`・`readJsonBody(`・`rejectNullCharacterBody` | 本文を読む handler は `ENTRIES` か `EXCLUDED` にちょうど 1 回 | `PATCH sessions/current`・`POST password/change`・`POST password/reset` を `ENTRIES` に (3 つとも `rejectNullCharacterBody` を最初に呼ぶ) | B・C |
| N-15 | `src/__tests__/app/route-uniqueness.test.ts` | `page.tsx`・`route.ts` の URL | ルートグループを外した URL の重複 | `/settings/security/sessions`・`/api/auth/sessions/*`・`/api/auth/password/*`・`/api/auth/login-history`・`/api/cron/login-alerts`・`/api/admin/users/[id]/login-history` は origin/main のどれとも重ならない (cross/12 の `/settings/security/mfa*` とも別) | B〜D |
| N-16 | `tests/route-error-boundaries.test.tsx` | `layout.tsx`・`error.tsx` | 新しい page の上の階層の error.tsx | `(main)/settings/security/sessions/page.tsx` は既存の `(main)/error.tsx` が受ける。走らせて確認 | B |
| N-17 | `src/__tests__/lib/emails/template-names.test.ts` | `render\w+Email(`・`template: '…',` | 封筒の template の名前を 1 行 (`    template: 'login_new_device',` の形) で持つ | §18 のとおりに書く | B |
| N-18 | `tests/email-send-throttle-contract.test.ts` | `@/lib/emails/send`・`sendEmail(` | `src/` でメールを送るファイルは throttle を通すか除外リストに理由 | `src/lib/auth/sessions/login-alert-worker.ts` (sendEmail を呼ぶのは worker。cron route は worker を呼ぶだけ) を除外リストに: 「宛先は本人の登録メールアドレス (利用者が指定したアドレスではない)。1 セッション 1 通 (Idempotency-Key)」 | B |
| N-19 | `tests/integration/security/anon-definer-execute.test.ts` A1 / A2 / B | `prosecdef`・`has_function_privilege('anon'` | SECURITY DEFINER の関数に anon の EXECUTE が残ると赤 | §11.3〜11.6 の REVOKE (PUBLIC / anon / authenticated / service_role) → 必要な役割だけ GRANT。決定表 B に 9 本の行を足す (`auth_session_revoke`: authenticated のみ / `auth_password_check`: service_role のみ / 保守 3 本: service_role のみ / トリガー関数 4 本: supabase_auth_admin のみ) | A |
| N-20 | `tests/integration/security/auth-users-fk-on-delete.test.ts` | `auth.users`・`ON DELETE` | 新しい FK は無い (既存の 2 本は CASCADE)。H (メールらしい列) も無し | 変更なし (走らせて確認) | A |
| N-21 | `tests/helpers/schema-snapshot.ts` (account-export の模型) | `ALTER TABLE … ADD COLUMN` | ベストエフォートの構文解析 | §11.1 の形 (`ALTER TABLE public.x ADD COLUMN IF NOT EXISTS …` をカンマ区切り) は解析できる | A |
| N-22 | `tests/native-sign-out-order-source-scan.test.ts` | `broadcastSignOut(`・`auth.signOut(` | `broadcastSignOut` を呼ぶ箇所の並び | `revoke-others` の route は `broadcastSignOut` を呼ばない (サーバー)。`reset-password` ページの並びは変えない | B・C |
| N-23 | `tests/edge-function-verify-jwt.test.ts`・`src/__tests__/config/turnstile-config.test.ts` | `supabase/config.toml` | config.toml の行の形 | 触らない | — |
| N-24 | `src/__tests__/app/settings/account-page.test.ts` (origin/main 61c59321 の行で: 297 #1187 入力の検証・357 #1187 現在のパスワードが違う・416 #1187 成功・503 #1187 更新やログアウトの失敗・584 #1552 案内の指し先・648 #1187 コンソールに出さない) | `signInWithPassword`・`updateUser`・`signOut`・`password-change-others-not-signed-out-note` | 画面が API 経由になり、他の端末のログアウトの失敗の枝が無くなる | describe ごとに: **297** は it をそのまま残し、共通の確かめ `expectNoAuthMutation` に「`fetch` で `/api/auth/password/change` を呼んでいない」を足す。337 の it 名の「再認証の前に」を「API を呼ぶ前に」に。**357** の 3 it は API に置き換え (400 `AUTH_CURRENT_PASSWORD_MISMATCH` → 「現在のパスワードが正しくありません」と `updateUser`・`signOut` を呼ばない / `fetch` の reject → 通信エラーの文言でパスワードの間違いとは言わない / `fetch` の例外でも画面が壊れない)。**416** の 417 を「POST /api/auth/password/change を 1 回呼び、signInWithPassword / updateUser / signOut を呼ばない」に、469 を「二重に送信しても API は 1 回」に。431・440・458 は期待をそのまま (呼び出しの mock だけ `fetch` に)。**503** の weak_password の it を「422 `VALID_PASSWORD_WEAK` の本文の文言を出す」に、same_password の it を「422 `VALID_PASSWORD_HISTORY` の文言」に。`signOutFailures` の `it.each` (2 本) は削除 (他の端末の失効は GoTrue が更新と同じトランザクションで行い、画面に失敗の枝が無い)。403 `AUTH_REAUTHENTICATION_REQUIRED` の it を 1 本足す。**584** の 595 と 611 (他の端末を確認できなかったときの注意書き) は削除、`failOthersSignOut` も削除。631 は `renderPage()` だけにして `password-change-forgot-current-note` の期待だけを残す。603・621 はそのまま。**648** の `failures` の 6 件を API の 4 件 (400・422・500・`fetch` の reject) に置き換え、パスワードをログに出さない期待はそのまま。700 (メールアドレス変更)・807 (読み込み) は変えない | C |
| N-25 | `tests/auth/reset-password-session-revoke.test.ts` | `updateUser`・`signOut({ scope: "global" })` | ページが API 経由になる | `updateUser` の期待を `fetch('/api/auth/password/reset')` に。clear → signOut global → broadcast の順の it はそのまま | C |
| N-26 | `tests/auth-turnstile-resend-password-change.test.tsx` (310 行目からの describe) | `password-change`・`signInWithPassword` | パスワード変更の本人確認が無くなる | その describe (6 it) を削除。`/auth/verify` の describe は残す | C |
| N-27 | `apps/mobile/__tests__/lib/account-credentials.test.ts`・`apps/mobile/__tests__/settings/account-credentials.test.tsx` | `signInWithPassword`・`updateUser`・`scope: 'others'` | `changePassword` が API 経由になる | §20.4 のとおり書き換え (it 3・4・「他の端末…」・「連打…」)。`apps/mobile/__tests__/settings/account-credentials.test.tsx` は `../../src/lib/api` (`getApi`) の mock を足し、「3. 再認証 → 更新 → この端末以外のログアウト を呼び…」を「3. パスワードの変更の API を 1 回呼び…」に、「他の端末のログアウトを確認できなかったときは、成功に注意書きを添える」(origin/main 149 行) を削除、「4. 現在のパスワードが違えば…」を 400 の応答に、「連打しても、再認証は 1 回しか呼ばない」を「API は 1 回」に (§20.4)。部品 `AccountCredentialsSection.tsx` の `othersSignedOut` の削除 (§16) と同じ PR | C |
| N-28 | `apps/mobile/__tests__/auth/reset-password.test.tsx` (it 3・4) | `mockUpdateUser` | `updateUser` を呼ばなくなる | it 3 を API の呼び出しに。it 4 (共通のログアウト) はそのまま | C |
| N-29 | `tests/login-failure-grant-claim-cleanup-contract.test.ts`・`tests/integration/security/log-cleanup-and-dau-snapshot.test.ts` | `cron.job` | 自分のジョブだけを見る | 変更なし。新しいジョブは §20.3 の契約テストが見る (migration の全ジョブの名前と数を 08 の記述と突き合わせる番兵は別にある → N-32) | A |
| N-30 | `tests/mobile-super-admin-api-contract.test.ts`・`apps/mobile/__tests__/app/error-boundaries.test.tsx` | `(super-admin)`・`_layout.tsx` | 対象外 (新しい画面は `settings/sessions.tsx` で layout ではない) | 変更なし (走らせて確認) | B |
| N-31 | `src/__tests__/app/faq/account-answers.test.ts` (#1187 の「モバイルのアカウント管理: … 実際に Supabase で変更する」の it。origin/main 243〜255 行) | `updateUser({ password: input.newPassword })`・`signOut({ scope: "others" })`・`{ email: input.email }` | `apps/mobile/src/lib/account-credentials.ts` の本文に 3 つの文字列があることを読む走査。§16 で `changePassword` が `getApi().post('/api/auth/password/change', …)` になり、前の 2 つの文字列が消えて赤 | その it の `credentials` への期待 3 つのうち、`updateUser({ password: input.newPassword })` と `signOut({ scope: "others" })` の 2 つを `expect(credentials).toContain('/api/auth/password/change')` の 1 つに置き換える (引用符の種類に依らないよう、path だけを見る)。`{ email: input.email }` の期待 (メールアドレスの変更は今までどおり Supabase の `updateUser`) と、画面・部品の見出しの期待はそのまま。it の名前の「実際に Supabase で変更する」を「パスワードは API (`/api/auth/password/change`) で、メールアドレスは Supabase で変更する」に。同じ describe の Web のアカウント画面の it (見出しと入力欄の文言) は、§15 で文言を変えないので変更なし (走らせて確認) | C |
| N-32 | `tests/log-cleanup-dau-snapshot-contract.test.ts` (「#1125 設計書の『いま』の記述が、木の実物と合っている」の Vercel Cron の 2 本と pg_cron の 1 本の it。origin/main 313〜358 行) | `vercel.json` の `crons`・migration の `cron.schedule(` (名前は `tests/helpers/migration-cron-jobs.ts` が数える) | vercel.json の cron の名前 (path の最後の部分) と、migration が pg_cron に登録するジョブの名前を、`docs/design/operator/08-cron-batches.md` の §3.0・§3.1 の注記・§3.2 の注記・§5 の注記がすべて挙げ、§3.0・§3.1 の注記・§3.2 の注記の本数の宣言が実数と同じであることを見る。本設計で pg_cron の `cleanup-auth-sessions-and-login-history` (段 A) と Vercel Cron の `login-alerts` (段 B) が 1 本ずつ増えるので、08 を直さないとその段の全件が赤。§11.6 は名前を文字列で直書きしているので、見張りは名前を解ける (未解決 0 件) | 08 をその段の PR で直す (手順は §23 の 08 の行)。段 A: §3.0 の「migration が pg_cron に登録しているジョブは N つ」と §3.1 の注記の「… の N つ」を +1 し、両方に `` `cleanup-auth-sessions-and-login-history` `` を書く。段 B: §3.0 と §3.2 の注記の「`vercel.json` に登録されている Vercel Cron は … の N 本」を +1 し、§3.0・§3.2 の注記・§5 の注記に `` `login-alerts` `` を書く (名前は path の最後の部分。`` `/api/cron/login-alerts` `` の書き方だけでは数えられない)。N は PR の時点の origin/main の実数から数える (origin/main 5a48abc9・61c59321 のどちらでも pg_cron 8 → 9・Vercel 2 → 3。名前を解く見張り `tests/helpers/migration-cron-jobs.ts` と `tests/migration-cron-job-names.test.ts` は、§11.6 の直書きの名前を解ける) | A・B |
| N-33 | `src/__tests__/lib/auth/logout-guidance.test.ts` (origin/main 61c59321 の 67〜92 行の describe「#1552 他の端末のログアウトを確認できなかったときの注意書き」と、148〜154 行の it「アカウント画面は、案内の文を直書きせず、この出し分けを使う」) | `describeOthersNotSignedOutNote`・`src/app/(main)/settings/account/page.tsx` | it が画面のソースに `describeOthersNotSignedOutNote(accountActionsPlacement)` があることを読む。§15 でその呼び出しが消えて赤。関数も §21.3 で消す | describe「#1552 他の端末のログアウトを確認できなかったときの注意書き」(4 it。`it.each` を含む) を削除し、import から `describeOthersNotSignedOutNote` を外す。it「アカウント画面は…」の `expect(account).toContain('describeOthersNotSignedOutNote(accountActionsPlacement)')` を `expect(account).not.toContain('describeOthersNotSignedOutNote')` に置き換える (ほかの 4 つの期待 = `describeForgotCurrentPasswordNote(accountActionsPlacement)`・`useAccountActionsPlacement(isNativeApp)`・2 つの `not.toContain` はそのまま)。describe「#1552 現在のパスワードを思い出せない人への案内」と構文の it は変えない | C |
| N-34 | `tests/mobile-sign-out-doc-callers.test.ts` (origin/main 61c59321 で増えた見張り) | `signOutOnDevice`・`apps/mobile/app/**` | `apps/mobile/app` の中で `signOutOnDevice` を呼ぶ画面は設定画面 (`(tabs)/settings.tsx`) だけでないと赤 | 新しい画面 `apps/mobile/app/settings/sessions.tsx` は `signOutOnDevice` を呼ばない (この端末には解除のボタンを出さない §15。他の端末は API で消す)。`docs/design/mobile/05-auth-session.md` への追記 (§23) にも「端末からのログアウト」の行を足さない | B |

## 23. 他の文書への追随表 (本書の PR では変えない。実装の段で同じ PR か後続 PR で直す)

| 文書 | 箇所 | 直し方 | 期日 |
|---|---|---|---|
| `docs/design/cross/01-auth-session.md` | §3.2 (`INSERT user_sessions_metadata`)・§4.3 (5 端末)・§4.4 (`admin.signOut(sessionId)`)・§9.1 (step 4)・§13.1 / §13.3・§16・§17 | §3.2 の INSERT を「DB のトリガー (cross/16 §11.3)」に。§4.3 を「上限は設けない。一覧・個別失効・30 日の自動終了 (cross/16)」に。§4.4 の擬似コードを「個別の失効は RPC `auth_session_revoke` (cross/16 §11.4)。ログアウトは今までどおり `signOut()`」に。§9.1 の step 4 を「`POST /api/auth/password/reset` (cross/16 §14.7)」に。§13.1 / §13.3 に「→ cross/16 §11 が正典」。§16 の Integration 行 (5 端末上限) を本書のテストに。§17 の middleware 行を消す | 段 B・C と同じ PR |
| `docs/design/operator/01-data-model.md` | §3.23・§3.25・§3.1 の順序 | §3.25 に 12 列・索引 2 本・CHECK 3 本・`sessions_revoke_self` の削除・GRANT の変更を写し「→ cross/16 §11.1 が正典」。§3.23 に「書くのはトリガー `password_history_record` (cross/16 §11.3)」。§3.1 の一覧の末尾に本 migration (番号はマージ時の値) | 段 A |
| `docs/design/cross/04-api-conventions.md` | §4.2 AUTH 系・VALID 系 | §19 の新 7 code を足す。`AUTH_SESSION_REVOKED` (401) は GoTrue の `session_not_found` に対応する既存の意味のまま | 段 B・C |
| `docs/design/cross/CLAUDE.md` | ファイル一覧 | `16-auth-history-sessions.md` の行 (担当範囲: ログイン履歴 / 不審ログインの通知 / セッションの一覧と失効 / パスワード履歴。要件 03 §17) を足す | 設計のマージと同じ PR (オーケストレーター) |
| `docs/design/operator/07-audit-monitoring.md` | §4.1.1 | `admin.user.view_login_history` (details: `returned_count`・severity info・0 件は記録しない) | 段 D |
| `docs/design/operator/02-api-spec.md` | §4 ユーザー管理 API | `GET /api/admin/users/{id}/login-history` の節 | 段 D |
| `docs/design/operator/03-ui-spec.md` | §6 ユーザー詳細 | 「ログイン履歴 (直近 20 回)」の節 | 段 D |
| `docs/design/operator/08-cron-batches.md` | §3.0 実装状況 (見出しの日付・本数と名前の文・「そのほか」の箇条書き)・§3.1 の注記・§3.2 の表と注記・§5 の注記 | 段 A (pg_cron): §3.0 の「いま、このリポジトリの migration が pg_cron に登録しているジョブは 8 つある」を 9 つに、「残りの 6 つ `…`」を 7 つにして `` `cleanup-auth-sessions-and-login-history` `` を足す。「そのほか」の箇条書きに 1 項目: migration `<番号はマージ時に確定>_auth_history_sessions.sql` (#1190) がジョブ `` `cleanup-auth-sessions-and-login-history` `` を毎日 03:55 JST (`55 18 * * *` UTC) に登録し、`expire_idle_auth_sessions()` (30 日更新の無いセッションを終える)・`reconcile_user_sessions_metadata()` (GoTrue 側に無いのに終わっていない行を終える)・`cleanup_ended_user_sessions_metadata()` (終わってから 90 日を過ぎた行を消す) を呼ぶ。3 つの関数の `EXECUTE` は `service_role` だけ。ロールバックは `supabase/rollbacks/<番号はマージ時に確定>_auth_history_sessions.down.sql`。詳しくは cross/16 §11.6。§3.1 の注記の「migration が pg_cron に登録しているのは、… この表に無い `…` の 8 つ (§3.0)」の列挙に `` `cleanup-auth-sessions-and-login-history` `` を足して 9 つに。段 B (Vercel): §3.0 の「`vercel.json` に登録されている Vercel Cron は `process-menu-queue` と `app-log-alerts` (…) の 2 本である」に `` `login-alerts` `` (#1190。新しい端末・地域からのログインを本人にメールで知らせる。毎分) を足して 3 本に。§3.2 の表に 1 行を足す (ジョブ名の列 = `` `login_alerts` (実装済み: #1190) ``・スケジュール (JST) の列 = 毎分・概要の列 = 新しい端末・地域からのログインを本人にメールで知らせる (`/api/cron/login-alerts`。設計は cross/16 §13.3・§14.8)) (行に「実装済み」を書くので、注記の「この表のほかの 11 本」は 11 のまま)。§3.2 の注記の「… の 2 本」に `` `login-alerts` `` (この表の `login_alerts`) を足して 3 本に。§5 の注記の「`vercel.json` にあるのは `process-menu-queue` と `app-log-alerts` だけ」に `` `login-alerts` `` を足す。どちらの段も、本数は PR の時点の origin/main の実数 + 1 (並行の案件が先に cron を足していれば、その数から数える)。本数の宣言の文の、宣言より前の括弧の中に「の <数> 本」「の <数> つ」を書かない (番兵の正規表現が先に当たる)。見出し・注記の日付はその PR の日付に。直したら `tests/log-cleanup-dau-snapshot-contract.test.ts` を offload で流して緑を確かめる (§22 N-32) | 段 A・段 B のそれぞれの PR と同じ PR (後続の PR にすると、その段の全件が赤) |
| `docs/design/mobile/05-auth-session.md` | §2・§3 の末尾 | 「ログイン直後と起動時に `PATCH /api/auth/sessions/current` で端末名を登録 (cross/16 §16)」の 1 節 | 段 B |
| `docs/operations/auth-protection.md` | §3.2 (攻撃対策) | 本書の前提 (§24) の 3 行: Secure password change は OFF のまま・JWT の有効期間・Session timebox / inactivity は使わない (本書の 30 日のジョブが代わり) | 段 A |
| `ENV_SETUP.md`・`.env.example` | 環境変数 | `AUTH_LOGIN_ALERT` の説明 (N-2) | 段 B |
| `src/lib/account-export-tables.ts` | `ACCOUNT_EXPORT_EXCLUDED` の `user_sessions_metadata` の理由 | 「ログインの記録 (IP・端末・不審の印)。本人には設定の『ログイン中の端末』と『最近のログイン』で見せる」に改める (分類は変えない) | 段 B |

## 24. 運用の前提 (マージ前にオーナーが確かめる)

| 前提 | 確かめ方 | 外れたとき |
|---|---|---|
| Supabase の「Secure password change」(`secure_password_change`) が OFF | ダッシュボード → Authentication → Providers → Email | ON だと、作成から 24 時間を過ぎたセッションの変更が 403 `AUTH_REAUTHENTICATION_REQUIRED` (ログインし直せば通る)。本書は nonce (メールの OTP) を扱わない |
| JWT (access token) の有効期間は既定の 1 時間以下 | Authentication → Sessions | 失効した端末が PostgREST を直接呼ぶ要求は、JWT の期限まで通る (GoTrue のログアウトと同じ性質。本書の API と refresh は即時に止まる) |
| Session timebox / inactivity timeout は未設定のまま | 同上 | 設定すると GoTrue が `auth.sessions` を消す側になる。本書のトリガーは DELETE を記録するだけなので壊れないが、30 日のジョブと二重になる |
| 送信ドメインの検証 (`docs/operations/email-domain.md`) | Resend | 未検証の間は通知が届かない (worker は印だけ付ける。`AUTH_LOGIN_ALERT=off` と同じ結果。届く前提の文言をアプリには書かない) |
| `auth` スキーマのトリガーは Supabase の管理対象の表に足すもの | — | Supabase 側の移行で `auth.sessions` / `auth.users` が作り直されるとトリガーが消える (記録が止まるだけでログインは止まらない)。`reconcile` と結合テスト (§20.3) が異常を見つける。年に 1 度の点検を `docs/operations/auth-protection.md` に書く (§23) |

## 25. 未解決事項 (オーケストレーターへの問い)

| # | 問い | 本書の仮置き |
|---|---|---|
| Q-1 | `secure_password_change` の本番の値 (§24) | OFF を前提。ON なら §14.6 の 403 で案内 |
| Q-2 | 失効が PostgREST の直接の要求に効くのは JWT の期限 (≤ 1 時間) 後でよいか | よい (GoTrue のログアウトと同じ)。短くするなら JWT の期限の設定で |
| Q-3 | 放置の終了を 30 日の 1 値にしてよいか (cross/01 §4.1 はロール別) | 1 値。ロール別は `user_profiles.roles` を JOIN する別の migration で足せる |
| Q-4 | 「新しい IP の範囲」だけで通知しないでよいか (§7.1) | しない。変えるなら `decideLoginAlert` の `shouldNotify` 1 行 |
| Q-5 | cross/12 (MFA) の `SessionClaimsSchema` / `bearerJwtOf` と本書の `session-claims.ts` は同じ役割。先にマージした方を正にして、後の方が import に寄せる | 本書は独立に書く (未マージの枝に依存しない)。統合は後の実装 WF の 1 コミット |
| Q-6 | 仕様ファイルの「`src/modules/<name>/` + facade」はこのリポジトリに無い | 既存の `src/lib/auth/<領域>/` に合わせた |
| Q-7 | モバイルが API の応答を検証する Zod を `packages/shared` に写すか、型だけにするか | 型だけ (`sessions-api.ts` の中に同じ形の type)。写すなら `packages/shared/src/auth-sessions.ts` |
| Q-8 | 既存の 1,331 セッション・195 人のパスワードの写し (§11.2) を migration でやってよいか | やる (ローンチ前・テストの利用者。写さないと一覧に「この端末」が出ない) |
| Q-9 | Web のパスワード変更から Turnstile を外す (§15) | 外す (再認証のサインインが無くなり、API は本人のセッション + rate-limit で守る) |
| Q-10 | support にログイン履歴を見せるか | 見せない (IP は PII。admin / super_admin だけ) |
| Q-11 | `auth` スキーマにトリガーを置くことへの合意 (§24 の最終行) | 置く (Supabase の文書どおりの作法。失敗は握る) |
| Q-12 | 再設定の認可で `amr` の `otp` も受けてよいか (§7.1・§12.4) | 受ける。token_hash (Web の `/auth/callback`) と implicit (モバイルの既定) の再設定は `otp` になる (§3)。`otp` はメールのリンク / コードでメールボックスを持つことを示したセッションで、`recovery` と同じ強さ。`recovery` だけにするなら、Web とモバイルの再設定を PKCE に揃える (モバイルの `flowType: 'pkce'`・メールの雛形) 別の案件が先に要る |
| Q-13 | 作成から 90 日を過ぎて初めてログインした利用者 (と、移行の時点でセッションが 1 つも無かった既存の利用者の、移行後の最初のログイン) に `history_expired` のメールが 1 通届いてよいか (§10.1 の行 2) | よい (本人のログインでの 1 通。履歴が消えた乗っ取り (S-26) を取りこぼさない側に倒す)。なくすには、消えない「ログインしたことがある」の印 (新しい表) が要る |
