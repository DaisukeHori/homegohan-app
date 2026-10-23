# ログイン履歴・不審なログインの通知・セッションの一覧と失効・パスワードの再利用の防止

> 版: v1.8 (2026-10-16 段 B の前の改定: メールの送信待ち #1760・#1785 の意味に合わせる。#1720。R1〜R3 の修正を含む) / Issue: #1190 (`[セキュリティ] ログイン履歴・不審ログイン通知が皆無`)・#1189 (`[セキュリティ] アクティブセッション/デバイス一覧・個別失効UIが存在しない`)・#1198 (`[運用] password_historyテーブルはあるがパスワード再利用防止ロジックが未実装のstub`)
> 位置づけ: `cross/01-auth-session.md` §3.2 (`INSERT user_sessions_metadata`)・§4.3〜4.4 (セッションの一覧・個別失効・ログアウト)・§7.1 (過去履歴禁止の世代数)・§9.1 (リセット時の `password_history` 照合) を、実装できる粒度に展開した正典。§4.3 の「同時 5 端末」と §4.4 の `supabaseAdmin.auth.admin.signOut(sessionId)` は本書が改める (§23)。DDL の正典 `operator/01-data-model.md` §3.23 / §3.25 は本書 §11 が改定する (§23)。
> オーナーの選択 (2026-10-15・選択式) で、ローンチに要るものとしてこの群を作ると決まっている。前提: ローンチ前で利用者ゼロ (正しい形で作る)。
> 改定履歴: v1.0 2026-10-15 初版。v1.1 2026-10-15 R1 の修正: ① パスワードの更新と「他の端末をログアウト」を、サーバーの client の `auth.updateUser` / `auth.signOut` から、本人の access token で GoTrue を呼ぶ形 (`updatePasswordWithAccessToken`・`signOutOtherSessions`) に改めた (Bearer だけのモバイルの要求ではサーバーの client にセッションが無い §3) ② 不審の判定の比べる相手 (prior) を「同じ利用者の前の行すべて」に改め、履歴が保持期間で消えた利用者を `history_expired` として知らせる (§10.1・§12.3) ③ 再設定の認可の `amr` に `otp` (token_hash / implicit の経路) を加えた (§12.4) ④ 番兵 (§22 N-24・N-33・N-34) と触るファイル (§21) を閉じた。 v1.2 2026-10-15 周 2 の網羅性の反映: 全パターン表に local のログアウトと凍結の行 (§8 の行 21・22)、Web の route の文脈の記録の例外の握り (§13.5)、テスト (§20) と触るファイル (§21.3・段 A の列挙 §0.2) の漏れ、番兵 N-19 の行数 (SECURITY INVOKER の 1 本を除く 8 本) と N-35〜N-38、§23 の期日の段の分け方。 v1.3 2026-10-15 R2 の修正: ① 通知の取り置きと戻しを DB の関数 `claim_login_alerts` (`FOR UPDATE SKIP LOCKED`)・`release_login_alert` (§11.4) にした (PostgREST では原子的に書けない) ② worker の行 `LoginAlertRow` に `ip_address` を足し、cron の route の `send` の組み立てを逐語にした (§13.3・§14.8) ③ モバイルの再設定の画面の、ログアウトに渡す利用者 ID とエラーの文言 (§16・§22 N-28) ④ 端末名の登録の重複よけを利用者 ID から access token に改めた (ログインし直しでも登録する §16) ⑤ 段 B と段 C を直列にした (同じファイルを触る §0.2) ⑥ 番兵 N-39 (`tests/jst-today-source-scan.test.ts` の規則 G) ⑦ プロフィールの行が最初のログインより後に作られる新規の利用者の `last_login_at` / `login_count` を、行を作るときのトリガー `user_profiles_fill_login_stats` で入れる (§11.3)。 v1.4 2026-10-16 R3 の修正: ① 利用者の API 7 本の認証を `requireUser` (プロフィールの行が無いと 401) から、行が無くても通る `requireSessionUser` (§12.4) に改めた (本番の 195 人のうち 130 人は行が無く、再設定と端末名の登録が後退していた §3) ② 再設定 (`p_current_password` が NULL) は、パスワードの無い利用者 (Google / Apple だけ) と比べられない形のハッシュの利用者を止めない (§11.5。いまの `updateUser` と同じ。S-28) ③ 状態遷移表に、終わった行 (ended) の通知の取り置き・完了・戻しを足し、終わったログインにも知らせると決めた (§10・S-29) ④ メールの「端末」は UA から決まる決まった言葉だけにし、利用者が書ける端末名 (`device_name`) はメールに載せず一覧に添えるだけ・使える文字を絞った (§7.1・§12.5・§13.4・§18・S-31) ⑤ 段 D の閲覧の監査は利用者の client で記録する (§14.9) ⑥ R-13 の結合テストを、トリガーの本体を必ず失敗させる形にした (§20.3)。 v1.5 2026-10-16 R4 の修正: ① 端末の種類が分からないログイン (`other/server`・`other/other`。一覧・メールでは「不明な端末」) を既知にせず、新しい端末として知らせる (Node の既定の UA `node` で GoTrue を直接呼ぶ攻撃者 S-4 に通知が届かなかった。§10.1・§12.3・S-32) ② 照合と再設定の認可が効くのはアプリの経路 (本書の API) だけと改め、盗んだセッションで GoTrue の `PUT /auth/v1/user` を直接呼ぶ経路 (S-33) を残る穴として書いた。GoTrue の設定 `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` を ON にできるよう、変更の API は `current_password` も GoTrue に渡す (§7.1・§13.2・§13.7・§24・Q-18) ③ `auth` の表のトリガーは表の所有者 (`supabase_auth_admin`) でないと DROP できないので、migration は同じ名前が無いときだけ作り、`.down.sql` は本体を「何もしない」に置き換えて残す (§3・§11.3・§11.7) ④ R-13 の結合テストの refresh・ログアウトの it を、行がある状態で制約を足す形に分けた (§20.3)。§10 にトリガーの失敗の行を足した。 v1.5 周 5 の網羅性の反映: `user_profiles.last_login_at` を読む既存の運営の一覧・候補・非活動の一覧 (§3・§9) と、変えない既存のファイルの判定 (§21.4: 運営の一覧と候補・非活動の一覧・`user-profiles-insert-guard`・退会・ログアウトのテスト) を足し、§21.1 の段 A の契約と結合のテストを名指しした。 v1.6 2026-10-16 R5 の修正: ① 通知の待ち (`pending`) の行が溜まって後から一斉に届く道を閉じた: `claim_login_alerts` に作成からの上限 (`LOGIN_ALERT_MAX_AGE_HOURS` = 24 時間) を足し、それより古い待ちの行は送らずに `done` にする (段 A のデプロイから段 B の worker まで・worker の停止の間に溜まった行。§10・§11.4・S-34)。`alert_status` の列の既定を `'done'` にし、トリガーだけが `'pending'` を明示して作る (ロールバックの後にもう一度 migration を流したとき、残った行が通知の対象に戻らない §11.1・S-35)。Web の login / callback の文脈の上書き (§13.5) を段 B から段 A へ移し、段 A の間の Web のログインが UA `node` (不明な端末) のまま溜まらないようにした (§0.2) ② Web の文脈の上書きを共通の関数 `recordWebLoginContextFromRequest` (§13.5) に寄せ、走査を「session を作る呼び出しの数 ≤ その関数の呼び出しの数」に、route のテストを callback の 3 つの分岐 (code・token_hash・`token` のフォールバック) ごとの it にした (§20.2・§20.3)。 v1.6 周 6 の網羅性の反映: 全パターン表に、盗んだ refresh token の使用 (行 35・S-36。知らせない限界 §25 Q-21) とメールアドレス変更の申し込み (行 34。変化なし) の行を足し、行 21 の指し先を origin/main の `signOut({ scope: "local" })` の行 (`AuthProvider.tsx:205`) に直した。Web の文脈の上書き `recordWebLoginContext` のガードに「判定の前 (`alert_status = 'pending'`) の行だけ」を足し、全状態での結果を状態遷移表に書いた (§10・§13.1・§13.5・§20.3)。§21.3 に §23 の文書 3 つ (`docs/requirements/03-operator-admin.md`・`docs/design/cross/02-rls-patterns.md`・`docs/design/cross/CLAUDE.md`) を足し、§23 に `docs/design/membership/05-operator-emergency-ui.md` を追随しない理由を書いた。 v1.7 2026-10-16 R6 の修正: 環境変数 `AUTH_LOGIN_ALERT` を `readOnlyBy` つきで足すと、`src/__tests__/lib/env.test.ts` の「値を読む場所が決まっている変数」の it (`readOnlyBy` を持つ変数の [名前, ファイル] の並びを直書きの配列と `toEqual` で比べる) が赤になるのに、追随表 (§22 N-2) と触るファイル (§21.3) に無かった。N-2 を番兵 3 本それぞれの反応と直し方に分け (env.test.ts は配列に 1 組・it の名前・`typeOnly` の `@ts-expect-error` を足す)、§21.3 の段 B・§20.1 (既存の it の書き換え)・§0.2 の段 B に足した。`src/lib/env.ts` の項目と `.env.example`・`ENV_SETUP.md` の文を逐語にし、rate-limit の 2 カテゴリの足し方 (型 `RateLimitCategory`・`CATEGORY_RULES` の配列の形) も逐語にした (§12.6・§23)。あわせて origin/main a6455673 と突き合わせ (§3)、§8 の行 21 の指し先を `AuthProvider.tsx:207` に直し、§8 の行 34 (メールアドレス変更の申し込みで `password_history` が増えない) と §10 の `recordWebLoginContext` の「行が無い」行を、§20.3 の結合テストの it に足した。 v1.7 続きの周 1 の網羅性の反映: §21.4 に、GoTrue を直接呼ぶ既存の結合テスト `tests/integration/security/password-update-revokes-sessions.test.ts` を「変えない」の行として足し、§22 N-32・§23 の 08 の行に origin/main 309dae0f でも数が同じ (pg_cron 9・Vercel 2) で、設計の枝の古い 08 (「6 つ」) を直すのではないことを書いた。 v1.7 続きの周 2 の修正: §4 の R-2・R-6・R-11 の根拠の列と §25 Q-6 から、リポジトリに無い文書への言及を除き、辿れる根拠 (Issue #1190・#1189 の本文、cross/01 §4.1、本書 §7.1・§12.1、`docs/design/CLAUDE.md`、ルートの `CLAUDE.md`、billing/01 の R18) に改めた。 v1.7 続きの周 2 の網羅性の反映: `user_profiles.last_login_at` / `login_count` の消費先のうち、admin の利用者詳細 (`src/app/api/admin/users/[id]/route.ts:162` → 画面 :183〜186) と support の利用者詳細 (`src/app/api/support/users/[id]/route.ts` :49〜50・:133〜134 → Web `page.tsx:264`・モバイル `[id].tsx` :131・:135) を §21.4 の「変えない」の行と §9 の行に足した。§3 の `src/app/(support)/support/users/page.tsx:188` は `/api/admin/users` の snake_case の応答を `lastLoginAt` で読むのでいつも `-` で、値が入っても変わらないことを §3・§21.4 に書き、直すかを §25 Q-22 にした。 v1.8 2026-10-16 段 B の前の改定 (#1720。段 A は PR #1757 で main と本番に入っている): #1760 (#1708 の段 B) で `sendEmail` が Resend を呼ばず送信待ち `email_outbox` に 1 行入れて返るようになり (`ok: true` = 登録できた。配信の失敗は送信待ちの worker の側で dead)、#1785 で秘密を含む文面の宣言 (`contains_secret`) と伏せ字 (`redact_after_send`) が入ったので、通知の送信を書いていた S-18・§6.1・§6.2・§9・§10・§13.3・§13.4・§13.6・§14.8・§17・§18・§20 をその意味に合わせた: ① `alert_sent_at` = 通知メールを送信待ちに登録した日時 (列の名前は段 A で本番に入っているので変えず、意味だけを定める。届いたかは `email_outbox` の行 (`idempotency_key` = `login-alert:<session_id>`・`user_id`) が持つ §10.2・Q-24) ② 届けられなかった通知 (dead) を通知の状態に書き戻さない (送信待ちの運用メール `ops_email_dead_letter` と `/super-admin/email-outbox` の再送で扱う。§7.1 の裁定の行・Q-23) ③ `sendEmail` の `ok: false` 4 種 (`invalid_envelope`・`not_configured` (`skipped: true`)・`suppressed`・`outbox_failed`) はどれも `alert_sent_at` NULL で `done` (再送しない §13.4) ④ worker は `userId: row.user_id` を渡す (退会時の伏せ字 `prepare_account_deletion` の 1b と画面の絞り込み) ⑤ 文面 `login_new_device` は秘密を含まない (`contains_secret` を書かない・`redactAfterSend` も渡さない。dead の行を再送できる §18) ⑥ worker の件数と cron の応答の `notified` を `queued` に改名 (§13.3・§14.8) ⑦ 番兵の追随: N-18 の除外の理由の文を送信待ちの意味で逐語に、N-40 (`secret-templates.test.ts` の `PUBLIC_TEMPLATES`)・N-41 (`email-resend-boundary-scan.test.ts`。反応しない)・N-42 (cross/12 の走査 ⑥。`assurance.ts` を import しない) を足した ⑧ 記録の現在形化: cross/12 は段 A〜C がマージ済み (§0.3・§2・Q-5 を「寄せない」で決めた)、cross/01 §3 のシーケンス図の participant「Next.js Edge」は §23 の行に (proxy は Node.js の runtime) ⑨ シナリオ S-37〜S-40 と §6.2 のトレース、§3 の前提の取り直し (origin/main 6da7b7ec・本番 DB 2026-10-16: 段 A の列・トリガー・RPC が入り、通知の待ちの行 103・`email_outbox` 0 行)。要件行列に R-16。 v1.8 周 1 の網羅性の反映: 送信待ちへの登録の後に通知の記録が残らない 2 つの経路 (`finish` が 3 回続けて失敗して `release` が done にする §10.2 #11・S-43、登録の後・`finish` の前に関数が止まり取り直しで重複の行ができる §10.2 #12・S-44) を §5・§6.2・§10・§10.2 に足し、`alert_sent_at` の NULL は「登録した記録が無い」ことまでを言うと §7.1 の (a)・§10.2・§12.5・§17 に書いた。`sendEmail` の `ok: false` の `outbox_failed` (S-41) と `invalid_envelope` (S-42) をシナリオとトレースに足した (§10.2 #5・#4 の行と対にした)。§20.1 の worker の it に「finish の例外の後に同じ回で send をもう一度呼ばない」を足した。シナリオは 44 本。 v1.8 R1 の修正 (origin/main 9f4f6da8 と突き合わせ): ① 送信待ちの画面と API (`/super-admin/email-outbox`・operator/10 §9.2) は operator/10 の段 C で、origin/main には無い (マージ済みは段 A #1737・段 B #1760・伏せ字 #1785)。「super_admin が画面で再送できる」を現在の事実として書いていた §0.2・§2・§3・R-16・S-37・§6.1・§6.2・§7.1・§9・§10.2・§13.4・§17・§18・§24・Q-23 を、段 C の前は dead の通知を再送できない (運用メールの件数だけ・RPC `requeue_email_outbox` は `service_role` だけ) と段 C の後の再送に分けて書き直した。段 B のマージの条件は変えず、段 C の着地を足すかを Q-25 にした ② 運営が送信待ちの行を `idempotency_key` か利用者で引けるという記述 (S-43・§6.1・§7.1・§7.2・§9・§10.2・§17) を、operator/10 §9.2 の一覧でできること (`template` = `login_new_device` の絞り込みと、時刻・`user_id` の列で見分ける。一覧は `idempotency_key` を返さず、利用者での絞り込みも無い) に直した。足りるかは Q-26 ③ 番兵 N-32 と §23 の 08 の行: 段 B で置き換える 08 の文を、origin/main の 4 本の文 (`email-outbox` #1760・`push-outbox` #1776 が入った後) に合わせ、4 → 5 本と `login-alerts` を足す位置を逐語にした。段 A の分 (pg_cron) は #1757 で済んだと書いた。 v1.8 R2 の修正 (origin/main 9f4f6da8 と突き合わせ): ① 番兵 N-43 (`tests/env-setup-cron-secret-crons.test.ts`。`ENV_SETUP.md` の `` `CRON_SECRET` `` の行が挙げる Vercel Cron の path と `vercel.json` の crons の一致を見る) が追随表に無く、段 B が `vercel.json` に `/api/cron/login-alerts` を足すと全件が赤になっていた。§22 に N-43 を足し、`ENV_SETUP.md` の行に path を足す逐語を §23 に、§0.2・§3・§14.8・§20.3・§21.3 に同じ PR で直すことを書いた ② 運営の画面の `alert_sent_at` の列見出しを「通知メールを送信待ちに登録した日時」と逐語で決め (「通知メール」だけでは配信済みに読める)、§17 に 7 つの列見出しを逐語で書き、§12.5・Q-23・§20.4・§23 (operator/03) をその見出しに合わせた。 v1.8 R3 の修正 (origin/main 9f4f6da8 と突き合わせ): ① worker の件数を数える時機を「`finish` が戻った後」に決めた。§13.4 の 4 で `sent.ok` のときに `queued` に数える書き方だと、登録の後に `finish` が例外になった回が `queued` と `failed` の両方に数えられ、§10.2 #10・#11 (その回は `failed` だけ) と食い違っていた。どの行も `queued`・`skipped`・`failed` のどれか 1 つだけに数え、`claimed` はその和 (§9・§10.2・§13.3 の `LoginAlertWorkerSummary`・§13.4・§14.8・S-39・S-41・S-43)。§20.1 の worker の it に、`finish` の例外の回の `queued`・`skipped` が 0 であることと、件数の和を足した ② §23 から operator/10 の行を外し、追随しない文書の ② に理由を書いた (10 の §6.6 は 10 自身が変える呼び出し元の差分の表で、§2 の「呼び出し元 15 か所」・§4.1 の図・R-19 は 10 の設計の時点の事実と 10 の変更の母集合。origin/main の #1709・#1758 の呼び出し元も載っていない)。§21.3 の段 B の cross/01 に §3 のシーケンス図を足し (§23 の期日が段 B)、§0.2 の段 B に段 B の文書の追随を名指しした。 v1.8 周 4 の網羅性の反映 (origin/main 9f4f6da8): ① `sendEmail` が停止リストを引けなかったとき (`lookup_failed`) は確かめずに登録して `ok: true` を返す枝を、§3・§10.2 #13・S-45 (シナリオとトレース) に足した (本書の行は 1 と同じく `alert_sent_at` = 登録した日時。送信待ちの worker が送る直前にもう一度引き、そこでも引けなければ停止リストに載った宛先にも届きうる) ② 本人による MFA の解除 (`DELETE /api/auth/mfa/factors/{id}`。cross/12 §14.4) を §8 の行 38 に足し (unenroll は `aal` / `factor_id` の UPDATE で `refreshed_at` を書かず、続く `refreshSession()` が行 7 と同じ更新)、行 7 の呼び出し元に `src/app/api/auth/mfa/factors/[id]/route.ts:98` を足した。§9 の cross/12 の行に行 38 を足した。

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

v1.8 (段 B の前の改定) は、この 1 冊の中の段 B の記述 (通知メールの送信の意味) を改めるだけで、分冊判定・段分け (A〜D) は変えない。段 B が触るファイルの母集合は §21 のとおりで、送信待ちの側 (`src/lib/emails/*`・`email_outbox` の migration・RPC) には触れない (§7.1)。

### 0.2 段分け (実装 WF の単位と順序)

| 段 | 中身 | 依存 | デプロイ後の状態 |
|---|---|---|---|
| **A DB と核** (PR #1757 で main にマージ済み・本番に適用済み。migration `20261016243000_auth_history_sessions.sql`) | migration (§11: 列・トリガー 5 本 (`auth.sessions` に 3・`auth.users` に 1・`user_profiles` に 1)・RPC 4 本・保守の関数 3 本・pg_cron のジョブ 1 本・既存行の写し) と対の `.down.sql`・型の再生成・`src/lib/auth/sessions/{constants,device-family,ip-network,login-alert-policy,request-context,session-claims,schemas,store,web-login-context}.ts`・`src/lib/auth/password/{policy,change,gotrue-user}.ts`・Web の login / callback route の文脈の上書き (§13.5)・単体テスト・route のテスト・走査・契約テスト・結合テスト (§20.1〜§20.3 の段 A の分)・`tests/integration/security/anon-definer-execute.test.ts` の決定表 (§22 N-19)・`tests/jst-today-source-scan.test.ts` の許可リスト (§22 N-39)・`docs/design/operator/08-cron-batches.md` の pg_cron の記述 (§22 N-32・§23)・段 A の文書の追随 (§21.3・§23) | なし | すべてのログインが `user_sessions_metadata` に記録され (Web の `/api/auth/login`・`/auth/callback` のログインは route が実際の IP / UA / 国で上書きする §13.5)、`user_profiles.last_login_at` / `login_count` が動き始め、パスワードの変更が `password_history` に残る。利用者に見える変化は無い (運営の「最終ログイン」が埋まる)。トリガーが作る行は通知の待ち (`pending`) のまま溜まる (worker は段 B。段 B の worker は作成から `LOGIN_ALERT_MAX_AGE_HOURS` (24 時間) を過ぎた待ちの行を送らずに `done` にする §10・§11.4) |
| **B セッションの一覧・失効・通知** | `GET /api/auth/sessions`・`DELETE /api/auth/sessions/{id}`・`PATCH /api/auth/sessions/current`・`POST /api/auth/sessions/revoke-others`・`GET /api/auth/login-history`・Web の `/settings/security/sessions`・設定の導線・モバイルの `settings/sessions` と端末名の登録・`GET /api/cron/login-alerts` + `vercel.json`・メール `login_new_device`・環境変数 `AUTH_LOGIN_ALERT` (`src/lib/env.ts`・`.env.example`・`ENV_SETUP.md` と、既存の `src/__tests__/lib/env.test.ts` の追随 §12.6・§22 N-2)・`docs/design/operator/08-cron-batches.md` の Vercel Cron の記述 (§22 N-32・§23)・`ENV_SETUP.md` の `` `CRON_SECRET` `` の行への `/api/cron/login-alerts` (§22 N-43・§23)・`src/__tests__/lib/emails/secret-templates.test.ts` の `PUBLIC_TEMPLATES` (§22 N-40)・`tests/email-send-throttle-contract.test.ts` の `EXEMPT_EMAIL_SENDERS` (§22 N-18)・ほかの既存の番兵の追随 (§21.3 の段 B の行・§22)・段 B の文書の追随 (`docs/design/cross/01-auth-session.md` の §3 のシーケンス図・§4.3・§4.4・§16・§17、`docs/design/cross/04-api-conventions.md` の段 B の 2 code、`docs/design/mobile/05-auth-session.md`、`src/lib/account-export-tables.ts` の理由の文。§21.3・§23) | A (段 A の migration が本番に入ってから `LOGIN_ALERT_MAX_AGE_HOURS` (24 時間) 以上たってからマージする = 2026-10-17 18:06 JST 以降。下の注) | 利用者が端末を一覧・失効でき、新しい端末・地域からのログインの通知メールが送信待ち (`email_outbox`) を通って届く (届けるのは `GET /api/cron/email-outbox` の worker。届けられなかった通知は送信待ちの dead になり、運用メールに件数が出る。再送の画面と API は operator/10 の段 C で、origin/main には無く、段 C の前は dead の通知を再送できない §10.2・Q-25)。worker の最初の回は、段 A の間に溜まった待ちの行のうち作成から 24 時間以内の行だけを判定して (Web の行は段 A から実際の UA なので、判定は段 B の後のログインと同じ) 送り、それより古い行は送らずに `done` にする (§10・S-34) |
| **C パスワードの変更・再設定の API 化と履歴の照合** | `POST /api/auth/password/change`・`POST /api/auth/password/reset`・rate-limit のカテゴリ 2 つ・Web の `/settings/account` と `/auth/reset-password` の呼び替え・モバイルの `account-credentials.ts`・`AccountCredentialsSection.tsx`・`reset-password.tsx` の呼び替え・`logout-guidance.ts` の使われなくなる関数の削除・既存テストの書き換え (§22 N-24〜N-28・N-31・N-33) | A・B (マージの順。下の注) | 変更・再設定のどちらも (Web・モバイルの画面 = 本書の API の経路で)、直近 N 世代と同じパスワードを 422 で断る (GoTrue を直接呼ぶ経路は照合を通らない §24・S-33)。変更は現在のパスワードを DB で確かめ、セッションの入れ替え (再認証のサインイン) をしなくなる |
| **D 運営の画面** | `GET /api/admin/users/{id}/login-history`・`/admin/users/{id}` のログイン履歴の節・監査 `admin.user.view_login_history` | A | admin / super_admin が利用者の直近 20 回のログインと印 (新しい端末 / IP / 地域) を見られる |

**B と C は直列** (B のマージの後に、C の実装 WF を origin/main から切る)。どちらも次の既存ファイルを触るので、並行にするとマージで衝突し、解消したコードと正典をもう一度審査することになる: `src/__tests__/api/null-character-routes.test.ts` (どちらも `ENTRIES` に足す §22 N-14)・`tests/helpers/ai-consent-enforced-paths.ts` (赤なら、どちらも `EXEMPT_ROUTES` に足す §22 N-11)・`docs/design/cross/04-api-conventions.md` (B は 2 code、C は 5 code §23)・`docs/design/cross/01-auth-session.md` (B は §4.3・§4.4・§16・§17、C は §9.1 §23)。**D は A の後に B・C と並行に作れる** (D が触るのは §21.1・§21.3 の D の行のファイルだけで、B・C の行と重ならない)。B・C・D は `src/lib/auth/sessions/` の段 A のファイルを読むだけで変えない。各段は単独で型検査とテストが通る。

**段 A の migration とコードの順・段 B をマージする時期**: 段 A をマージすると、migration は GitHub Actions (`.github/workflows/deploy-supabase-migrations.yml`。main への push で `supabase db push`) が、コードは Vercel が別々に本番へ入れるので、どちらが先かは決まらない。どちらが先でも壊れない: コードが先なら、migration の前の Web のログインには行が無く (トリガーがまだ無い)、`recordWebLoginContext` の UPDATE は列が無い error で `false` になり warn を残すだけ (ログインは成功する §13.6)。migration が先なら、コードが入るまでの間の Web のログインの行は `context_source='auth'`・UA `node` (不明な端末) の待ちの行で残る。この行を判定させないため、段 B は、段 A の migration が本番に入ってから `LOGIN_ALERT_MAX_AGE_HOURS` (24 時間) 以上たってからマージする (段 B の worker の最初の回で、その行は作成から 24 時間を過ぎていて、送らずに `done` になる §11.4・S-34)。段 C・D はこの制約を持たない (通知に触れない)。段 A の migration `20261016243000_auth_history_sessions.sql` は 2026-10-16 18:06 JST に本番へ適用した (本改定の時点の記録。本番 DB に入っていることは 2026-10-16 の読み取りで確かめた §3。通知の待ちの行は 103 行で、段 B の最初の回の時点で作成から 24 時間を過ぎた分は送らずに `done` になる) ので、段 B のマージは 2026-10-17 18:06 JST 以降 (§25 Q-20)。

### 0.3 本書が決めないもの (範囲外)

- cross/01 §4.3 の「同時ログイン上限 5 端末」(超過時の最古の強制失効)。本書は上限を設けず、一覧と個別失効・放置された端末の自動終了 (§11.6) で足りるとする。要るなら別 Issue。
- cross/01 §4.1 のロール別のアイドル / 絶対タイムアウト (個人 24h/30d・組織 8h/7d・運営 1h/12h)。本書は「更新の無いまま 30 日」の 1 値だけを DB で実装する (§7.1 の裁定・§25 Q-3)。
- 運営が利用者のセッションを失効させる操作。既存の凍結 (`/admin/users/{id}/freeze`) が middleware の判定で同じ効果を持つ。
- モバイルのログインの地域 (国) の記録。国は Vercel のヘッダ (`x-vercel-ip-country`) から取れる Web の経路だけで記録する (§7.1)。GeoIP の外部サービスは使わない。
- HIBP (cross/01 §7.2)・ログイン方法 (`amr`) の記録・サポートコンソール (`/support/users`) の変更・メールアドレス変更の経路。
- cross/12 (運営の MFA。段 A #1715・段 B #1754・段 C #1783 で main にマージ済み) の中身。本書は MFA と独立に動く (関係は §9 の最終行と §25 Q-5。`SessionClaimsSchema` の 2 重定義は寄せない。本書のファイルは `@/lib/auth/mfa/assurance` を import しない §22 N-42)。
- メールの送信待ち (`email_outbox`。operator/10・#1708) の表・RPC・worker・運用メール・再送の画面。本書の通知メールはこの仕組みを `sendEmail` で使うだけで、届けられなかった通知の扱いもそちらに任せる (§7.1)。再送の画面と API は operator/10 の段 C で、origin/main には無い (§3・Q-25)。

---

## 1. 目的・スコープ

1. **ログインの記録** (#1190): どの経路 (Web の `/api/auth/login`・Web の OAuth / メールのリンク・モバイルの直接の `signInWithPassword`・anon キーで GoTrue を直接呼ぶ攻撃者) でも漏れなく記録する。記録の入口は、呼ぶ側が選べない場所 = **`auth.sessions` への INSERT のトリガー** (§7.1)。1 行 = 1 ログイン (= 1 セッション)。終了 (ログアウト・失効・パスワード変更による失効・放置の終了) は DELETE のトリガーで同じ行に刻む。
2. **不審なログインの通知** (#1190): 新しい端末の種類 (OS × ブラウザ / アプリ) または新しい国からのログインを、本人のメールアドレスに知らせる。端末の種類が分からないログイン (Node などのサーバーの UA・空の UA。「不明な端末」) は、前にも同じことがあっても新しい端末として知らせる (§10.1)。判定は Vercel Cron (毎分) の worker が純関数 `decideLoginAlert` で行う (作成から 24 時間を過ぎてから判定に回る行は送らない。段の切り替え・worker の停止の間に溜まった行をまとめて送らない §11.4)。IP の範囲が新しいことは記録・表示するが、それだけでは知らせない (§7.1)。
3. **セッションの一覧と個別の失効** (#1189): Web とモバイルの設定から、ログイン中の端末を一覧し、1 つずつ失効させる。失効 = SECURITY DEFINER の RPC `auth_session_revoke` が `auth.sessions` の行を消す (GoTrue は、行の無い session_id の JWT を `session_not_found` で断り、refresh も失敗する §3)。
4. **パスワードの再利用の防止** (#1198): `password_history` への記録は **`auth.users.encrypted_password` の変更のトリガー** (どの経路でも漏れない)。照合は、変更・再設定を受ける **サーバーの API** が、DB の `auth_password_check` (pgcrypto の `crypt()` で bcrypt を比べる) で行う。世代数はロール別 (cross/01 §7.1: 個人 3 / 組織 5 / 運営 10)。照合と再設定の認可が効くのは本書の API を通る経路 (Web とモバイルの画面はすべてこれを通る) だけで、GoTrue の `PUT /auth/v1/user` を直接呼ぶ経路は照合を通らない (記録はトリガーで残る。§7.1・§24・S-33)。
5. **運営の画面** (#1190): `/admin/users/{id}` に直近のログイン履歴の節を足す。`user_profiles.last_login_at` / `login_count` (いま誰も書いていない) を 1 のトリガーが供給する (プロフィールの行が最初のログインより後に作られる新規の利用者は、行を作るときのトリガーがそれまでの記録から入れる §11.3)。

## 2. 関連要件・正典

| 文書 | 箇所 | 本書との関係 |
|---|---|---|
| Issue #1190 / #1189 / #1198 | 本文 | 要件の正本 (コメントは設計のマージ・本番の前提の読み取りの確認・閉じたときの記録で、要件を足していない) |
| `docs/design/cross/01-auth-session.md` | §3.2・§4.1・§4.3・§4.4・§7.1・§9.1・§13.1・§13.3・§16・§17 | 方針。食い違う箇所は本書が正 (§23 で §4.3・§4.4・§9.1 を改める) |
| `docs/design/operator/01-data-model.md` | §3.23 `password_history`・§3.25 `user_sessions_metadata` | DDL の正典。本書 §11.1 の列・ポリシーの変更を写す (§23) |
| `docs/design/cross/02-rls-patterns.md` | §4.1 (self_ownership の用途の例)・§9 (`rls_hardening.sql` テンプレートの 2. `user_sessions_metadata`・4. `password_history`) | RLS の正典の記述。本書 §11.1 で本人の UPDATE ポリシーを消し、本人は SELECT だけにする。§9 のポリシー名 (`sessions_self_select` / `sessions_self_update`) は実際の名前 (`sessions_self` / `sessions_revoke_self`。migration 20251126124224:10874・10870) とずれている (§23) |
| `docs/requirements/03-operator-admin.md` | §17.1 (`password_history` の DDL と世代数)・§17.4 (セッション管理と `user_sessions_metadata` の DDL) | 要件の源。世代数 (3 / 5 / 10) は本書と同じ。§17.4 の「同時 5 端末」・ロール別のタイムアウト・`/account/sessions` のパスは本書が採らない (§0.3・§15・§25 Q-3)。要件の文書は本書の PR では変えない (§23・§25 Q-17) |
| `docs/design/cross/04-api-conventions.md` | §4.2 (`VALID_PASSWORD_HISTORY` 422・`AUTH_SESSION_REVOKED` 401) | 既存の code を使い、新しい code を足す (§19・§23) |
| `docs/design/mobile/05-auth-session.md` | §2・§3・§6 | ネイティブと WebView のセッションは同じ `auth.sessions` の 1 行 (§8 の行 8) |
| `docs/design/operator/07-audit-monitoring.md` | §4.1.1 | 運営の閲覧の監査の形 (`admin.user.view` と同じ) |
| `docs/operations/auth-protection.md` | §2・§3 | Supabase Auth の設定値の置き場。本書の前提 (§24) を足す |
| `docs/design/cross/13a-legal-consent-api-server.md` (設計・実装とも main にある。実装は #1697) | §6.4 の許可リスト `LEGAL_CONSENT_EXEMPT_API_PATHS` | `/api/auth` (prefix・`auth_flow`) と `/api/cron` (prefix・`no_user_session`) が許可リストにあるので、本書の `/api/auth/sessions*`・`/api/auth/login-history`・`/api/auth/password/*`・`/api/cron/login-alerts` は同意のゲートで止まらない (未同意でも端末の失効・パスワードの変更ができる)。`/api/admin/users/{id}/login-history` は 13a の扱いのまま。本書から 13a は変えない |
| `docs/design/cross/12-operator-mfa.md` (段 A〜C マージ済み: #1715・#1754・#1783) | §3.1・§13.2 | `auth.getClaims` の使い方が同じ。識別子は共有しない: `src/lib/auth/mfa/assurance.ts` の `SessionClaimsSchema` (`aal` を読む) と本書の `src/lib/auth/sessions/session-claims.ts` の `SessionClaimsSchema` (`session_id`・`amr` を読む) は形が違い、寄せない (§25 Q-5)。本書の段 B 以降のファイルは `@/lib/auth/mfa/assurance` を import しない (cross/12 の走査 ⑥ §22 N-42) |
| `docs/design/operator/10-logs-and-mail-retry.md` (#1193 / #1708。送信待ちの表と RPC・`sendEmail` の載せ替えと worker (#1760)・秘密の伏せ字 (#1785) がマージ済み) | §5.2 (RPC `complete_email_outbox` / `fail_email_outbox`)・§6.3 (`sendEmail` は登録だけ)・§6.7 (`contains_secret`)・§7.1・§7.3・§8 (dead の運用メール)・§9.2 (再送の画面と API。段 C で、origin/main には無い §3) | 本書の通知メールはこの送信待ちを通る (§13.3)。`sendEmail` の `ok: true` は「送信待ちに登録した」で、配信の成否は含まない。届けられなかった通知の扱い (運用メール・再送) は 10 の持ち物で、本書は書き戻さない (§7.1・§10.2)。段 C の前は再送の経路がアプリに無い (§10.2 #8) |

## 3. 前提の事実 (origin/main 5a48abc9・本番 DB の読み取り 2026-10-15。R1 で origin/main 61c59321、R2・R3 で bffe1b6f、R4 で 36c926ad、R5 で 5ff68e67、R6 の修正で a6455673 と突き合わせ、本書が参照する識別子はすべて残っている (a6455673 で行がずれたのは §8 の行 21 の `AuthProvider.tsx` だけで、直した)。R3・R4 で本番 DB を 2026-10-16 に読み直した。v1.8 で origin/main 6da7b7ec と本番 DB (2026-10-16) に取り直した: 段 A の migration `20261016243000_auth_history_sessions.sql` が入り (`user_sessions_metadata` の列 `alert_status`・`alert_sent_at`・`ip_network`・`context_source` ほか・`auth.sessions` のトリガー 3 本・RPC `claim_login_alerts` / `release_login_alert`)、`user_sessions_metadata` 1,946 行・通知の待ち (`alert_status = 'pending'`) 103 行、`email_outbox` は表と RPC (`complete_email_outbox` / `fail_email_outbox`) があり 0 行)。v1.8 R1 の修正で origin/main 9f4f6da8 と突き合わせた: 送信待ちの画面と API (operator/10 §9.2) は無い (下の `src/lib/emails/send.ts` の項)・`vercel.json` の crons は `process-menu-queue`・`app-log-alerts`・`email-outbox`・`push-outbox` の 4 本で、`docs/design/operator/08-cron-batches.md` の Vercel Cron の文も 4 本 (§22 N-32)・`ENV_SETUP.md` の `` `CRON_SECRET` `` の行 (92 行) が挙げる Vercel Cron の path も同じ 4 本で、`tests/env-setup-cron-secret-crons.test.ts` がこの行と `vercel.json` の crons の一致を見ている (v1.8 R2 で足した。§22 N-43)・6da7b7ec からの差分 (#1789・#1791) が触った文書・コードのうち本書が名指すもの (`docs/design/cross/12-operator-mfa.md`・`tests/integration/rls/user-profiles-insert-guard.test.ts` ほか) は、本書の記述に関わる変更を含まない

- `auth.sessions` の列: `id uuid, user_id, created_at, updated_at, factor_id, aal, not_after, refreshed_at (timestamp without time zone), user_agent text, ip inet, tag, oauth_client_id, refresh_token_hmac_key, refresh_token_counter, scopes`。所有者 `supabase_auth_admin`。`postgres` は SELECT / INSERT / UPDATE / DELETE / TRIGGER を持つ。`auth` スキーマのトリガーは 0 本 (本書が最初)。**`auth.sessions` と `auth.users` の所有者は `supabase_auth_admin` で、`postgres` (migration を流す役割) はその役割の member ではない** (2026-10-16 の読み取り: `pg_has_role('postgres', 'supabase_auth_admin', 'MEMBER')` は false・`has_table_privilege('postgres', …, 'TRIGGER')` は true・PostgreSQL 17.6)。PostgreSQL では、CREATE TRIGGER は表の TRIGGER の権限で行えるが、DROP TRIGGER (`IF EXISTS` でも、トリガーがあるとき) と `ALTER TABLE … DISABLE TRIGGER` は表の所有者だけが行える。よって `postgres` は `auth` の表にトリガーを作れるが、消せない (§11.3・§11.7)。`user_profiles`・`user_sessions_metadata`・`password_history` の所有者は `postgres`。拡張: `pgcrypto 1.3` (スキーマ `extensions`)・`pg_cron 1.6.4`・`pg_net 0.19.5`・`supabase_vault`。
- 本番の行数: `auth.sessions` 1,331 (`auth.users` 195)。`user_sessions_metadata` 0・`password_history` 0 (どちらも stub。`src/` に読む・書くコードは無い)。
- **`ip` / `user_agent` は作成時に入る**: 一度も refresh していない 1,328 行の全部に `ip` と `user_agent` がある (GoTrue の `tokens/service.go` は `session.ApplyGrantParams(&grantParams)` の後に `tx.Create(session)`)。refresh のたびに refresh した側の `user_agent` / `ip` / `refreshed_at` で上書きされる (`UpdateOnlyRefreshInfo`)。
- **Web のログインは Next.js のサーバーが GoTrue を呼ぶ**ので、GoTrue が記録する UA は `node` (699 行)・IP は Vercel のもの。利用者の IP / UA は `POST /api/auth/login` (`src/app/api/auth/login/route.ts`) と `/auth/callback` (`src/app/(auth)/auth/callback/route.ts`) の request にしか無い。モバイルは `apps/mobile/app/(auth)/login.tsx:163` が GoTrue を直接呼ぶので、GoTrue の記録が端末の実値 (iOS のアプリは `CFNetwork/…`、Android は `okhttp/…`)。Web の refresh は主に Next.js の middleware (`lib/supabase/middleware.ts`) がサーバーで行う。ほかに browser の client (`@supabase/ssr` の `createBrowserClient` の自動更新と `src/hooks/useHomeData.ts:183` の `refreshSession()`) と、サーバーの `POST /api/auth/session-sync` (`src/app/api/auth/session-sync/route.ts:11` の `getSession()` が期限切れの access token を更新する。`:20` の `refreshSession()` は Cookie のセッションに token が無いときだけ呼ばれ、auth-js は refresh token が無いので GoTrue を呼ばずに `AuthSessionMissingError` を返す) も更新する。どの経路も同じ行の UPDATE で、新しい行は作らない (§8 の行 7)。
- GoTrue (supabase/auth master の実コード): `PUT /user` のパスワード更新は `user.UpdatePassword(tx, &session.ID)` → `LogoutAllExceptMe` (他のセッションを **DELETE**)。`secure_password_change` が ON のときだけ、セッションが無いか作成から 24 時間を過ぎていると nonce (再認証) を求める。`PUT /admin/users/{id}` は `UpdatePassword(tx, nil)` → `Logout` (本人の分も含めて **全部** DELETE)。`POST /logout?scope=others|global` も `auth.sessions` を DELETE。JWT の `session_id` の行が無いと `session_not_found` (403) を返す。期限や放置で行を消す仕組みは無い (timebox / inactivity は Pro の設定で、本番は未設定: 1,331 行が残っている)。この挙動のうち P-1 (他の端末の失効)・P-2 (本人は残る)・P-4 (`scope: 'others'`) は `tests/integration/security/password-update-revokes-sessions.test.ts` が GoTrue v2.183.0 で固定している。
- **GoTrue の `PUT /user` は、本人の access token と公開の anon キーがあれば、アプリを通らずに誰でも呼べる** (アプリの API・画面の検査は効かない)。GoTrue (supabase/auth master の `internal/api/user.go` の `UserUpdate`) には、現在のパスワードを求める設定 `UpdatePasswordRequireCurrentPassword` (環境変数 `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`・既定 OFF。`internal/conf/configuration.go`) があり、ON のとき、パスワードを持つ利用者の `PUT /user` に本文の `current_password` を求める (無ければ 400 `current_password_required`、違えば 400 `current_password_invalid`。`internal/api/apierrors/errorcode.go`)。ただし再設定のセッション (`session.IsRecovery()` = `amr` に `otp`・`magiclink`・`recovery` のどれか。`internal/models/factor.go`。期限は見ない) は求めない。supabase-js は v2.102.0 から `updateUser` に `current_password` を渡せる (Supabase の文書「Password-based Auth」)。ホスト版の設定画面・Management API でこの設定を変えられるかは確かめられていない (§24・Q-18)。`secure_password_change` (`UpdatePasswordRequireReauthentication`) が求める再認証は、セッションが無いか作成から 24 時間を過ぎたときだけ (作成から 24 時間以内の盗んだセッションは止めない)。
- GoTrue は、DB の暗号化の設定 (`GOTRUE_SECURITY_DB_ENCRYPTION_*`) が ON のとき、パスワードのログイン (`/token?grant_type=password`) の中で `encrypted_password` を書き直す (`internal/api/token.go` の `shouldReEncrypt` の枝の `db.UpdateOnly(user, "encrypted_password")`。「パスワードの変更ではなく暗号化の変更」とコメントがある)。本番の `encrypted_password` は全員 bcrypt (`$2…`。下の行) なので、いまは書き直していない。
- **サーバーの client は、Bearer だけの要求ではセッションを持たない**: `createClient()` (`lib/supabase/server.ts`) は `Authorization` を `global.headers` に入れるだけで、セッションの保管は Cookie。モバイル (`getApi()` は Bearer だけを送る) の要求では保管が空。auth-js の `_updateUser` は保管にセッションが無いと `AuthSessionMissingError` (code 無し) を投げ、`_signOut` は保管のセッションが無いと GoTrue を呼ばずに `{ error: null }` を返す (2.105.3 でも 2.117.3 でも同じ: `GoTrueClient.js:2868-2870`・`:3437-3456`)。よって本人のセッションで GoTrue を変える操作 (パスワードの更新・他の端末のログアウト) は、本人の access token を明示して GoTrue を呼ぶ (§13.7・§14.3)。`auth.admin.signOut(jwt, scope)` (`GoTrueAdminApi`) は `POST /logout?scope=<scope>` を渡した JWT で呼ぶ。
- **再設定のセッションの `amr`** (supabase/auth master の `internal/api/verify.go`): `POST /verify` (token_hash。Web の `/auth/callback` と モバイルの `authLink.ts:66` の `verifyOtp`) と、`GET /verify` の implicit の経路 (GoTrue の `GET /verify` がメールのリンクを開いたブラウザの要求でセッションを作り、token をフラグメントで返す → モバイルの再設定の画面 `apps/mobile/app/(auth)/auth/reset-password.tsx:48` の `setSession`。モバイルの client は `flowType` を指定しないので implicit) は、どちらも `models.OTP` (`otp`) で token を出す。アプリの `resetPasswordForEmail` の `redirectTo` は `/auth/reset-password` (`apps/mobile/app/(auth)/auth/forgot-password.tsx:36`) なので、再設定のリンクは `authLink.ts` (`verify.tsx`・`login.tsx` が使う) を通らず、再設定の画面が自分で `setSession` / `exchangeCodeForSession` を呼ぶ。`recovery` になるのは PKCE の code の経路 (Web の `resetPasswordForEmail` → `/auth/reset-password?code=…` を browser の client (`@supabase/ssr` の `detectSessionInUrl`) が交換) だけ。モバイルの再設定の画面にも code の枝 (`reset-password.tsx:45` の `exchangeCodeForSession`) があるが、モバイルの client は implicit で `code_verifier` を保管しないので、いまは GoTrue の `/token?grant_type=pkce` が交換を断り、セッションは作られない (client を PKCE にすれば `recovery`)。再設定の画面は token_hash の形を扱わない (いまの挙動。本書は変えない)。本番の `auth.mfa_amr_claims` は `password` 1,364・`otp` 2 で、`recovery` は 0 (2026-10-15)。アプリは `signInWithOtp` (メールのリンクでのログイン) を使っていない (origin/main の `src/`・`apps/mobile/` に 0 件)。
- 既存コード: `src/lib/auth/guarded-login.ts` (`performGuardedLogin`。副作用は deps)・`src/lib/auth/login-failures.ts` (環境変数の解釈 `resolveLoginFailureResetMinutes` の形)・`lib/supabase/server.ts` (`createClient()` は Cookie と `Authorization: Bearer` の両方を使う・`getSupabaseAdmin()`)・`src/lib/auth/helpers.ts` (`requireUser` / `requireRole`)・`src/lib/admin/audit.ts` (`recordAdminAudit` / `extractClientIp`)・`src/lib/rate-limit.ts` (`checkRateLimit(key, category)`・`auth-login` 10 回/分)・`src/lib/emails/send.ts` (`sendEmail`。v1.8: Resend を呼ばず、封筒の検証 → 宛先停止リスト → 送信待ち `email_outbox` に 1 行 (`status = 'queued'`) 入れて返る (#1760)。`ok: true` は登録できたこと (`id` = `email_outbox.id`) で、届いたことを含まない。`ok: false` は `skipped: true` の `not_configured` (`RESEND_API_KEY` 無し。登録しない) と、`skipped: false` の `invalid_envelope` / `suppressed` (停止リスト。`dead` / `suppressed` の行を best-effort で残す) / `outbox_failed` (登録の失敗)。停止リストを引けなかったとき (`lookupEmailSuppression` の `lookup_failed`。DB の失敗・時間切れ) は、確かめずに登録して `ok: true` を返す (`send.ts:170` の warn「宛先停止リストを引けなかったため、確かめずにメールを送信待ちに登録します」)。送信待ちの worker は送る直前にもう一度引き (`outbox.ts:256`)、載っていれば dead (`suppressed`)、そこでも引けなければ確かめずに送る (`outbox.ts:260` の warn。どちらも operator/10 の仕組みで、本書は変えない)。例外は投げない (R-01)。再試行 (1 分 → 5 分 → 15 分 → 1 時間 → 4 時間・既定 `EMAIL_OUTBOX_MAX_ATTEMPTS` 6 回) と Resend の Idempotency-Key は worker (`GET /api/cron/email-outbox`・毎分・`src/lib/emails/outbox.ts` の `processEmailOutbox`) が行い、使い切ると dead。400 / 401 / 403 / 422 は 1 回目で dead、作成から 7 日を過ぎた queued は `expired` で dead。dead は RPC `fail_email_outbox` が決め、`redact_after_send` の行はそのとき宛先・件名・本文を伏せる (`complete_email_outbox` は sent のとき)。dead の件数は `GET /api/cron/app-log-alerts` の `checkEmailDeadLetters` が 1 件から (`EMAIL_DEAD_LETTER_ALERT_THRESHOLD` = 0) `OPS_ALERT_EMAIL` へ知らせる (文面 `ops_email_dead_letter`。載せるのは件数・文面 (`template`) ごとの件数・送信待ちの画面へのリンク (`outbox_url`) だけ。`suppressed`・`recipient_deleted`・`ops_` で始まる文面は数えない)。再送の RPC `requeue_email_outbox` (dead → queued。伏せた行は 'redacted' で再送できない) はあるが、EXECUTE は `service_role` だけで、それを呼ぶ画面と API (`/super-admin/email-outbox`・`GET /api/super-admin/email-outbox`・`POST /api/super-admin/email-outbox/[id]/requeue`。operator/10 §9.2) は operator/10 の段 C で、origin/main 9f4f6da8 には無い (`git ls-tree -r origin/main` で `src/app` の下の email-outbox は `api/cron/email-outbox/route.ts` だけ・`src/lib/super-admin/email-outbox.ts` も無い。マージ済みは段 A #1737・段 B #1760・伏せ字 #1785)。段 C が入るまで、アプリから dead の行を再送する経路は無く、運用メールのリンクの先も無い。段 C の一覧の API (§9.2) は、絞り込みが `status`・`template`・`cursor`・`limit` だけで、`idempotency_key` を返さず (明記)、`user_id` は列として返す (利用者での絞り込みは無い)。退会の `prepare_account_deletion` (1b) は `user_id` か宛先が本人の行の宛先・件名・本文を伏せ、queued は dead `recipient_deleted` にする。`idempotency_key` に UNIQUE は無い (同じ鍵の行が 2 つできても Resend が 1 通にする)。`SendEmailOptions` は `idempotencyKey?` / `userId?` (`email_outbox.user_id`。JSDoc は「退会時の伏せ字と画面の絞り込みに使う」。分かる呼び出し元だけ渡す。§9.2 の一覧は `user_id` で絞り込まず、列として返す) / `redactAfterSend?`。封筒の `contains_secret: z.literal(true).optional()` (招待・本人確認・本人同意のトークン入りリンクの文面だけが書く。`false` は書かない) が true なら `redact_after_send` を立てる (#1785)。Resend を直接使えるのは `outbox.ts` だけ (`tests/email-resend-boundary-scan.test.ts`)。`src/lib/emails/send-result.ts` の `SendEmailResult` = `SendEmailSent` (`ok: true, id, attempts: 0, skipped: false, error: null`) | `SendEmailSkipped` (`ok: false, skipped: true`) | `SendEmailFailed` (`ok: false, skipped: false, error: EmailSendError`))・`src/lib/cron-auth.ts` (`requireCronAuth`)・`src/lib/env.ts` (`readOnlyBy`)・`apps/mobile/src/lib/api.ts` (`getApi()`: Bearer 付きで Next.js の API を呼ぶ)・`apps/mobile/src/lib/account-credentials.ts` (`changePassword`: 再認証 → `updateUser` → `signOut({scope:'others'})`)・`src/app/(main)/settings/account/page.tsx` (同じ 3 段を browser で)・`src/app/(auth)/auth/reset-password/page.tsx` (`updateUser` → `signOut({scope:'global'})`)・`packages/shared/src/password-policy.ts` (`validatePassword`・8 文字以上・英数)・`packages/shared/src/account-change-input.ts` (`validatePasswordChangeInput`)。
- `user_profiles.last_login_at` / `login_count` (migration 20251126124224:517・542) は、`src/`・`supabase/functions`・migration のどこにも書く処理が無い。運営の画面は読むだけ: admin の利用者詳細 (API `src/app/api/admin/users/[id]/route.ts:162` の `last_login_at: profile.last_login_at ?? null` → 画面 `src/app/admin/users/[id]/page.tsx:183〜186` の「最終ログイン」)・support の利用者詳細 (API `src/app/api/support/users/[id]/route.ts` の :49〜50 の select と :133〜134 の `lastLoginAt` / `loginCount` → Web `src/app/(support)/support/users/page.tsx:286` の「n回」と、モバイル `apps/mobile/app/(support)/support/users/[id].tsx` の :131 (回数)・:135 (最終ログイン)。2026-10-16 に削除した。#1598)。Web の support の一覧 `src/app/(support)/support/users/page.tsx:206` の「最終ログイン: …」は、`/api/admin/users` の行 (:189 で `last_login_at` を snake_case で返す) を同じ鍵 `last_login_at` で読み、値が NULL なら `-` を出す (#1717 で直った。前は camelCase の鍵 `lastLoginAt` で読み、いつも `-` だった §21.4・§25 Q-22)。モバイルの support の一覧 `apps/mobile/app/(support)/support/users.tsx:38` は camelCase の鍵で読むずれを持ったまま、2026-10-16 に削除した。#1598。`apps/mobile/app/(super-admin)/super-admin/admins.tsx:17` (2026-10-16 に削除した。#1598) の `lastLoginAt` は型だけで、API `src/app/api/super-admin/admins/route.ts` はこの列を select しない。ほかに読む所 (origin/main 6baa2f33 で `git grep last_login_at` の全数。続きの周 2 で origin/main cd4d4f17 でも同じ): 運営の利用者一覧の API `src/app/api/admin/users/route.ts` (:135 の絞り込み `last_login_before` = `.lt('last_login_at', …)`・:140〜141 の並べ替え `sort=last_login`・:188 の出力)・メンバー移譲の候補の API `src/app/api/operator/membership/org/[id]/candidates/route.ts:32` (`order('last_login_at', { ascending: false, nullsFirst: false })`)・`family/[id]/candidates/route.ts:49〜67` と、それを「最終ログイン: …」と出す `src/app/(operator)/operator/membership/{orgs,families}/[id]/transfer/page.tsx:140`。非活動の一覧 (`src/app/(operator)/operator/membership/families/inactive/page.tsx:28` は `last_login_at: null` の直書き、`orgs/inactive/page.tsx:30` は RPC `list_orgs_with_inactive_owner` の `owner_last_sign_in` = `auth.users.last_sign_in_at`、baseline 20251126124224:2182) と非活動の判定 `is_inactive_user` (`auth.users.last_sign_in_at`) は `user_profiles.last_login_at` を読まない。どれも本書では変えない (判定は §21.4)。`user_profiles` の行は新規登録の時点では無く、同意の `accept_legal_documents` (20261008200700:164 の `INSERT … ON CONFLICT (id) DO UPDATE`。SET に `last_login_at` / `login_count` は無い)・モバイルの初期設定の `upsert` (`apps/mobile/app/onboarding/questions.tsx:912`。どちらの列も送らない)・招待の承諾の RPC が作る。`user_profiles` の既存のトリガーは特権列ガード 2 本 (`trg_guard_user_profiles_privileged` / `_on_insert`) で、どちらも `last_login_at` / `login_count` を見ない。行の取り置きの既存の形は `claim_menu_request` (20261007160400) と `requeue_stale_meal_image_jobs` (20261015180000) の `FOR UPDATE SKIP LOCKED`。
- **`requireUser()` はプロフィールの行を要る**: `src/lib/auth/helpers.ts:83-88` の `requireUser` は `getUserProfile` (同 :38-61) を呼び、`user_profiles` を `.single()` で読んで、行が無いと `AuthError('AUTH_PROFILE_NOT_FOUND')` を投げる (route では 401)。本番 (2026-10-16 の読み取り): `auth.users` 195 人のうち `user_profiles` の行が無い利用者は 130 人。一方、いまの再設定の画面 (`src/app/(auth)/auth/reset-password/page.tsx:90`・モバイルの `apps/mobile/app/(auth)/auth/reset-password.tsx:90`) は browser / 端末の `updateUser({ password })` で、プロフィールの行に依らず動く。凍結の判定は、API については middleware (`lib/supabase/middleware.ts:183-240`) も行う (行を `maybeSingle` で読み、凍結なら 403 `AUTH_ACCOUNT_FROZEN`。読めないときは route に委ねる)。行の無い利用者は凍結されていない (凍結は行の `frozen_at`)。既存の「行を要さない」認証の helper は無い (`src/lib/auth/org-member.ts` の `requireOrgMember` のように、用途ごとの helper を `src/lib/auth/` に置く形はある)。
- **パスワードの無い利用者も再設定で最初のパスワードを作れる (いま)**: GoTrue の `/recover` はメールアドレスで利用者を引き、ログインの方法を問わず再設定のメールを送る。`PUT /user` は現在のパスワードを求めない。本番 (2026-10-16): `encrypted_password` が空の利用者 0 人・bcrypt (`$2…`) でない形の利用者 0 人 (Google / Apple のログインを足せば前者は増える)。
- **監査の client**: `src/lib/admin/audit.ts:51-53` の `RecordAdminAuditParams.supabase` は「user-scoped を推奨。RLS により `auth.uid()` と一致している必要がある」(`docs/design/CLAUDE.md` §6「`actor_id = auth.uid()` を WITH CHECK で強制」)。既存の `src/app/api/admin/users/[id]/route.ts:171-180` (`admin.user.view`) は、行を `getSupabaseAdmin()` で読み、監査には `await createClient()` の client を渡す。`src/app/api/admin` の `recordAdminAudit({` の 27 か所はすべて利用者の client。
- `src/modules/` はこのリポジトリに無い。既存の切り方は `src/lib/<領域>/` (`src/lib/auth/`・`src/lib/emails/`) で、本書もそれに合わせる (§25 Q-6)。
- ライブラリ: `@supabase/supabase-js` / `auth-js` 2.117.3 (`auth.getClaims(jwt?)`・`auth.admin.signOut(jwt, scope)`)・`@supabase/ssr` 0.12.7・`zod` 4・Next 15.5・モバイルは `expo-device ~7.1.4`。Vercel Cron は `*/1 * * * *` が既に使われている (`/api/cron/process-menu-queue`・`/api/cron/email-outbox`・`/api/cron/push-outbox`)。

## 4. 要件行列

| # | 要件 | 根拠 | 本書の節 |
|---|---|---|---|
| R-1 | どの経路のログインも漏れなく記録する (呼ぶ側が記録を避けられない) | #1190 本文 (乗っ取りの早期発見) | §7.1 / §11.3 |
| R-2 | 1 回のログインにつき: 日時・IP・IP の範囲・UA・端末の種類・端末名 (モバイル)・国 (Web)・終了の日時と理由を持つ。終わった行は 90 日で消す | #1190 本文 (ログイン履歴の表・新規デバイス / 新規 IP / 普段と異なる地域)。IP の範囲の扱いは §7.1 の比較、保持の日数は §12.1 の `LOGIN_HISTORY_RETENTION_DAYS` の根拠のコメントで決めた | §11.1 / §11.6 / §12.1 |
| R-3 | 新しい端末の種類・新しい国からのログインを本人にメールで知らせる (初めてのログインは知らせない。IP の範囲だけが新しいときは記録のみ)。端末の種類が分からないログイン (サーバーの UA・空の UA = 「不明な端末」) は、前にも不明な端末があっても新しい端末として知らせる (Node の既定の UA で GoTrue を直接呼ぶと何もせずに「不明な端末」になるため)。比べる相手は同じ利用者の前のログインすべて (長く続いているセッションを含む)。履歴が保持期間で消えた利用者のログインは「初めて」とみなさず知らせる。作成から判定までの間に終わったログインも知らせる (すぐにログアウトして通知を逃れさせない)。メールの「端末」は UA から決まる決まった言葉だけで、利用者が書ける値 (端末名) は載せない。作成から 24 時間を過ぎてから判定に回る行 (段の切り替え・worker の停止の間に溜まった行・ロールバックの後にもう一度 migration を流したときに残っていた行) は送らない (何日も前のログインのメールをまとめて届けない)。「知らせる」= 通知メールを送信待ち (`email_outbox`) に登録すること。配信・再試行・届けられなかったときの運用への通知は送信待ちの仕組み (operator/10) が受け持ち、本書の worker は配信の結果を待たず、書き戻さない (v1.8・R-16) | #1190 本文 (乗っ取りの早期発見) | §10 / §10.1 / §11.1 / §11.4 / §12.3 / §13.4 / §18 |
| R-4 | 利用者がログイン中の端末を一覧し、1 つずつ・または他の端末を全部失効できる (Web・モバイル) | #1189 本文 | §14.1〜14.4 / §15 / §16 |
| R-5 | 失効した端末は、次の API の要求・次の refresh で未ログインになる (PostgREST を JWT で直接呼ぶ要求は、JWT の期限まで通る §24) | #1189 本文 | §3 / §11.4 |
| R-6 | 更新 (refresh) の無いまま 30 日過ぎたセッションは自動で終える | #1189 本文 (ログイン中の端末の一覧と個別の失効)・cross/01 §4.1 (個人の絶対 30 日)。値は §12.1 の `SESSION_IDLE_EXPIRE_DAYS` | §11.6 |
| R-7 | パスワードの変更・再設定で、直近 N 世代 (個人 3 / 組織 5 / 運営 10) と同じパスワードを断る。断るのはアプリの経路 (本書の API。Web とモバイルの画面はすべてこれを通る)。GoTrue の `PUT /auth/v1/user` を直接呼ぶ経路は照合を通らない (§3・S-33)。記録はどの経路でも漏れない (トリガー) | #1198 本文・cross/01 §7.1・§9.1 | §11.3 (トリガー) / §11.5 / §12.2 / §14.6〜14.7 / §24 |
| R-8 | 変更は現在のパスワードを確かめる。再設定はメールのリンク / コードで作ったセッション (`amr` に 60 分以内の `recovery` または `otp`) だけが行える。この 2 つはアプリの経路の決まり。盗んだセッションで GoTrue の `PUT /auth/v1/user` を直接呼ぶ経路は、GoTrue の設定 `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` を ON にしたときだけ止まる (本書の変更の API は、その設定でも動くよう `current_password` を GoTrue に渡す §13.7。ON にするかは §24・Q-18)。再設定は、パスワードの無い利用者 (Google / Apple だけ) が最初のパスワードを作る経路としても今までどおり使える | #1198 本文・cross/01 §9.1・いまの再設定の画面の挙動 (§3) | §11.5 / §12.4 / §13.7 / §14.6 / §14.7 / §24 |
| R-9 | 運営 (admin / super_admin) が利用者の直近のログイン履歴を見られ、閲覧は監査ログに残る | #1190 本文・docs/design/CLAUDE.md 監査ログ必須 | §17 |
| R-10 | `user_profiles.last_login_at` / `login_count` が埋まる (プロフィールの行が最初のログインより後に作られる新規の利用者の、最初のログインも数える) | #1190 本文 (「最終ログイン」の単一列) | §11.3 |
| R-11 | migration の番号は決めない。対の `.down.sql` を作る。既存の関数・ポリシーは origin/main の定義を土台にする | `docs/design/CLAUDE.md`「同時編集が起きやすい箇所」の 3. (migration の番号の衝突)・ルートの `CLAUDE.md` (家族の関数・特権列ガードを `CREATE OR REPLACE` するときは、別の migration が書き換えた最新の定義の上に積む)・既存の設計書の先例 (billing/01 の R18: 番号はマージ時に確定・`.down.sql` を対で設計) | §11 |
| R-12 | `as any` を使わない。意味のある数値は名前付き定数 (根拠つき)。運用で変えうる値は環境変数で上書きできる | 共通規律 | §12 |
| R-13 | トリガーの失敗がログイン・サインアップ・パスワード更新・プロフィールの行の作成を止めない (記録は best-effort、認証は fail-open) | §7.1 | §11.3 |
| R-14 | 既存の番兵 (走査テスト・契約テスト) に反応するものを列挙し、直し方と段を決める | 設計ゲートの要件 | §22 |
| R-15 | `user_profiles` の行が無い利用者 (新規登録の直後・同意や初期設定の前) も、端末の一覧・失効・端末名の登録・パスワードの変更・再設定ができる (いまの再設定の画面はプロフィールの行に依らず動くので、後退させない) | §3 (行の無い利用者 130 人・いまの `updateUser` の画面) | §12.4 (`requireSessionUser`) / §14 |
| R-16 | 通知メールは `sendEmail` (送信待ち `email_outbox`) を通し、Resend を直接呼ばない。`alert_sent_at` は「送信待ちに登録した日時」で、登録できなかった (`sendEmail` の `ok: false`) ときは NULL のまま `done` (再送しない)。届けられなかった通知は送信待ちの dead になり、運用メール `ops_email_dead_letter` に件数が出る (通知の状態には書き戻さない)。再送は送信待ちの仕組みの側の操作で、画面と API (`/super-admin/email-outbox`。operator/10 §9.2) は operator/10 の段 C で入る。段 C の前は、アプリに再送の経路は無い (RPC `requeue_email_outbox` は `service_role` だけが呼べる §3)。文面は秘密を含まない (`contains_secret` を書かない・`redactAfterSend` を渡さない) ので、dead の行は伏せられず、段 C の後は再送できる。worker は `userId` を渡す (退会時の伏せ字。段 C の一覧では `user_id` の列に出る) | operator/10 §6.3・§6.7・R-23 (アプリのメールはすべて送信待ちを通る)・#1760・#1785 (v1.8) | §7.1 / §10.2 / §13.3 / §13.4 / §13.6 / §18 |

## 5. ユーザーシナリオ (45 本)

| # | 誰が | 何をする | 期待 |
|---|---|---|---|
| S-1 | 新規の利用者 (Web) | メールとパスワードで初めてログイン | `user_sessions_metadata` に 1 行 (Web の IP / UA / 国で上書き済み)。この時点ではプロフィールの行がまだ無い (同意・初期設定で作られる §7.1) ので `user_profiles` は変わらず、同意で行が作られるときに `last_login_at` (= このログインの日時) と `login_count = 1` が入る。初めてなので通知は無し。設定の一覧に「この端末」として出る |
| S-2 | S-1 の利用者 | 別の PC の Firefox からログイン | 新しい端末の種類 → 1〜2 分以内に「新しい端末からのログイン」のメール。一覧に 2 行 |
| S-3 | S-1 の利用者 | iPhone のアプリでログイン | GoTrue の記録 (`CFNetwork/…`) から「ほめゴハンのアプリ (iPhone・iPad)」。アプリが端末名 (`iPhone 15 Pro (iOS 18)`) を登録。新しい端末の種類 → メール |
| S-4 | 攻撃者 (パスワードを盗んだ) | anon キーで GoTrue の `/token?grant_type=password` を直接呼ぶ (Node の supabase-js・素の fetch なら、UA は何もしなくても既定の `node`) | 記録される (トリガー)。UA が `node` などのサーバーの既定・空なら端末の種類は「不明な端末」(`other/server`・`other/other`) で、本人の履歴に不明な端末があってもメール。ブラウザの UA なら、その種類が本人の履歴に無ければメール。UA を本人の端末の種類に偽ると鳴らない (端末の種類で比べる方式の限界 §25 Q-4)。本人は一覧で見つけて失効できる |
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
| S-15 | 攻撃者 (ログイン中のセッションを盗んだ) | `/auth/reset-password` を開いて (= 本書の `POST /api/auth/password/reset` で) 現在のパスワード無しで変えようとする | 403 `AUTH_RECOVERY_SESSION_REQUIRED` (`amr` に 60 分以内の `recovery` / `otp` が無い。盗んだセッションは `password` / `oauth`)。アプリの画面・API の経路では、今まで通っていたものが止まる。同じセッションで GoTrue を直接呼ぶ経路は S-33 |
| S-16 | admin | `/admin/users/{id}` を開く | 「ログイン履歴」の節に直近 20 回 (日時・端末・IP・国・印・終了)。`admin_audit_logs` に `admin.user.view_login_history` が 1 行。support には節が出ない (API も 403) |
| S-17 | モバイルの利用者 | 30 日アプリを開かない | 03:55 JST のジョブが `auth.sessions` を消す (`idle_expired`)。次に開くと refresh が失敗 → ログイン画面 (既存の #1599 の流れ) |
| S-18 | 利用者 (宛先停止リスト `email_blacklist` に載っている) | 新しい端末からログイン | worker は `sendEmail` を呼ぶが、登録の時点で停止リストに当たり `{ ok: false, skipped: false }` (`error.code` = `suppressed`。`email_outbox` には `dead` / `suppressed` の行が best-effort で残る) → `alert_sent_at` は NULL のまま `done`。印 (`is_new_device`) は残る。再送はしない。運用メールは `suppressed` を数えない |
| S-19 | Vercel Cron | 同じ回を 2 回呼ぶ | 行の取り置きは DB の関数 `claim_login_alerts` (`FOR UPDATE SKIP LOCKED`) で原子的 (同じ行を 2 つの worker が取らない)。Idempotency-Key `login-alert:<session_id>` で Resend も 1 通 |
| S-20 | DB | トリガー関数が失敗する (列が無い・権限) | EXCEPTION で握り、WARNING を残して RETURN NULL (`user_profiles_fill_login_stats` は RETURN NEW で行をそのまま作る)。ログイン・サインアップ・パスワード更新・同意 / 初期設定は成功する (R-13) |
| S-21 | Google だけでログインしている利用者 | パスワード変更の API を直接呼ぶ | 409 `AUTH_PASSWORD_NOT_SET` (画面はフォームを出さない。既存)。再設定のリンクからは最初のパスワードを作れる (S-28) |
| S-22 | super_admin | パスワード変更 | 直近 10 世代と比べる |
| S-23 | モバイルの利用者 | アプリの WebView で Web の画面を開く | WebView は native-bridge でネイティブと同じセッションを借りる (mobile/05 §6.1)。一覧には「ほめゴハンのアプリ」の 1 行だけ。失効させるとアプリも WebView も終わる |
| S-24 | 利用者 (退会) | アカウントを削除 | `auth.users` の削除で `user_sessions_metadata` と `password_history` は FK の CASCADE で消える (既存の DDL)。GoTrue の `Logout` で先に行が終わる |
| S-25 | 攻撃者 (利用者は 100 日前に iPhone のアプリでログインし、refresh で使い続けている) | Windows の Chrome からログイン | prior に 100 日前に作られた live の行 (`ios/app`) が入る (期間で絞らない) → `windows/chrome` は新しい → `new_device` でメール |
| S-26 | 攻撃者 (利用者は 120 日使っていない。最後のセッションは 30 日で終わり、その 90 日後に行は消えた) | ログイン | prior は空。アカウントは 90 日より前に作られている → `history_expired` (新しい端末として扱う) でメール |
| S-27 | モバイルの利用者 | アプリの「パスワードを忘れた？」→ メールのリンク (implicit: GoTrue の `GET /verify` がセッションを作り、フラグメントで返す → 再設定の画面 `reset-password.tsx:48` の `setSession`) → 再設定の画面で新しいパスワード | `POST /api/auth/password/reset` (Bearer だけ) → `amr` に 60 分以内の `otp` → 照合 → GoTrue の `PUT /user` を Bearer の JWT で → 200 → 既存の `signOutWithCleanup` |
| S-28 | Google / Apple だけでログインしている利用者 (パスワード無し) | 「パスワードを忘れた」→ 再設定メールのリンク → 新しいパスワード | 200 (最初のパスワードを作る。いまの `updateUser` と同じ)。`auth_password_check` は再設定 (`p_current_password` = NULL) ではパスワードが無くても `no_password` を返さず、履歴 (空) とだけ比べて `ok` (§11.5)。トリガーが `password_history` に 1 行を残す |
| S-29 | 攻撃者 (パスワードを盗んだ) | ログインして、作成から 15 秒以内にログアウトする | 行は `revoked_at` が入った ended / `pending` のまま。worker は終わった行も取り置いて判定し (`revoked_at` を見ない §10)、端末の種類が本人の履歴に無いか不明な端末ならメール (§10.1) |
| S-30 | 新規の利用者 (`user_profiles` の行がまだ無い) | 同意・初期設定の前に「パスワードを忘れた」から再設定する / アプリで初めてログインする | 再設定は 200 (`requireSessionUser` は行を要さない §12.4)。アプリの `PATCH /api/auth/sessions/current` も 200 で、最初のセッションの行に端末名が入る。どちらも `requireUser` の 401 にならない |
| S-31 | 攻撃者 (パスワードを盗んだ) | ログイン直後、判定の前に `PATCH /api/auth/sessions/current` で `device_name` に「あなたの iPhone 15 Pro」や URL を書く | 日本語・`:`・`/` などの使えない文字を含むので 400 `VALIDATION_ERROR` (使える文字は英数字・空白・`()._,+-` §12.5)。英数字だけの名前 (例 `iPhone 15 Pro`) は書けるが、メールの「端末」は UA から決まる言葉 (`deviceLabelOf`) だけで端末名は載らない (§13.4)。一覧では UA の言葉を見出しにし、端末名は「端末名: …」として添えるだけ (§15) |
| S-32 | 利用者 (Web・前にもログインしたことがある) | `/api/auth/login` でログインしたが、route の文脈の記録 (`recordWebLoginContextFromRequest` → `recordWebLoginContext`) が DB の一時的な失敗で書けなかった | ログインは成功する (§13.5)。行は `context_source='auth'`・UA `node` (端末の種類 `other/server` = 不明な端末) のまま。worker は不明な端末を新しい端末として判定し、本人に「端末: 不明な端末」のメールが 1 通 (送る側に倒す §10.1 の行 5) |
| S-33 | 攻撃者 (ログイン中のセッションを盗んだ) | anon キーと盗んだ access token で、GoTrue の `PUT /auth/v1/user { password }` を直接呼ぶ (本書の API を通らない) | GoTrue の設定 `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` が OFF (いまの既定) なら、パスワードは変わり、GoTrue が本人の他の端末を消す (P-1)。履歴の照合も再設定の認可も通らない (本書の範囲では防げない §24・Q-18)。記録は残る: トリガーが `password_history` に 1 行を足し、他の端末の行は `signed_out` になる。ON なら 400 `current_password_required` で変わらない (盗んだセッションの `amr` は `password` / `oauth` で、GoTrue の再設定の免除 (`otp`・`magiclink`・`recovery`) に当たらない §3) |
| S-34 | 利用者 (Web・段 A のデプロイの後にログインした) | 段 A のデプロイの 3 日後と、段 B のデプロイの 2 時間前に Web でログインした。段 B のデプロイの後の最初の worker の回 | 3 日前の行は作成から 24 時間 (`LOGIN_ALERT_MAX_AGE_HOURS`) を過ぎているので送らずに `done` (印 `is_new_*` は NULL のまま)。2 時間前の行は、route が段 A から実際の UA / IP / 国を書いている (§13.5) ので、段 B の後のログインと同じに判定する (端末の種類が履歴に無ければメール 1 通、あれば無し)。段 A の間の行が「不明な端末」としてまとめて届くことは無い (§0.2) |
| S-35 | 運営 (保守) | migration をロールバックし (§11.7)、後でもう一度流す | ロールバックで列は消え、行は残る。もう一度流すと `ADD COLUMN … alert_status … DEFAULT 'done'` (§11.1) が残った行をすべて `done` にし、通知の対象に戻さない。写し (§11.2) は残った行を `ON CONFLICT DO NOTHING` で飛ばす。本体が戻った後のログインだけがトリガーで `pending` に作られ、ふつうに判定される |
| S-36 | 攻撃者 (本人の端末から refresh token を盗んだ) | anon キーと盗んだ refresh token で GoTrue の `/token?grant_type=refresh_token` を直接呼ぶ (Node の道具。UA は既定の `node`) | 新しいセッションは作られない (同じ `auth.sessions` の行の UPDATE §3)。`user_sessions_metadata` は `last_active_at` だけが進み、`user_agent` / `ip_address` / 端末の種類は作成時 (または Web の文脈の上書き) の値のまま。通知の待ちの行は作られないのでメールは届かない (本書の通知はログイン = セッションの作成だけを見る。限界 §25 Q-21)。本人の一覧では、その行は元の端末の言葉の見出しのまま「最後の利用」が進んで見える (§15)。止めるのは、その行の失効 (他の端末の行なら §14.2) か、全端末のログアウト (この端末の行なら。同じセッションを攻撃者と共有しているので個別の失効の対象にならない S-8) |
| S-37 | 利用者 (送信ドメイン未検証・Resend の鍵が無効など、配信の側の障害) | 新しい端末からログイン | worker は `sendEmail` で送信待ちに登録でき (`ok: true`) → `alert_sent_at` = 登録した日時で `done`。配信は `GET /api/cron/email-outbox` の worker が行い、4xx (ドメイン未検証の 403・鍵の 401) は 1 回目で、429 / 5xx は再試行 (1 分 → 5 分 → 15 分 → 1 時間 → 4 時間) を使い切ると dead (`last_error_code` = Resend のコード)。本書の worker は再送せず、`alert_sent_at` もそのまま (書き戻さない §7.1)。dead は運用メール `ops_email_dead_letter` で `OPS_ALERT_EMAIL` に件数が届く (文面 `login_new_device` の件数。1 件から)。operator/10 の段 C (送信待ちの画面と API) が入るまでは、ここで止まる: アプリに再送の経路は無く、本人には届かない (原因を直しても、RPC `requeue_email_outbox` (`service_role` だけ) を呼ばない限り送られない §3)。段 C の後は、super_admin が原因を直して `/super-admin/email-outbox` から再送でき (伏せていないので再送できる)、本人には遅れて届く |
| S-38 | 運用 (本番で `RESEND_API_KEY` が未設定) | 利用者が新しい端末からログイン | `sendEmail` は登録せずに `{ ok: false, skipped: true }` (`not_configured`。app_logs に warn) → `alert_sent_at` NULL で `done`・`skipped` に数える。鍵を入れても、その間の通知は送らない (`AUTH_LOGIN_ALERT=off` と同じ結果。§24 の行) |
| S-39 | DB (送信待ちへの登録の直後に、`finishLoginAlert` の UPDATE が一時的に失敗) | 利用者が新しい端末からログイン | 登録 (`ok: true`・`email_outbox` に 1 行) の後の `finish` が例外 → `release` (`alert_attempts` + 1) → 次の回で取り直し → もう一度 `sendEmail` → `email_outbox` に同じ `idempotency_key` (`login-alert:<session_id>`) の 2 行目 (列に UNIQUE は無い §3) → `finish` で `alert_sent_at` = 2 回目の登録の日時。送信待ちの worker は 2 行とも Resend に送るが、同じ Idempotency-Key なので届くのは 1 通 (S-19 と同じ)。件数は 1 回目の回が `failed` だけ、取り直しの回が `queued` (§10.2 #10) |
| S-40 | 利用者 (通知メールが送信待ちにある間に退会) | `/api/account/delete` | `prepare_account_deletion` の 1b が、`user_id` が本人の行 (worker が `userId: row.user_id` を渡す §13.3。宛先の一致でも引ける) の宛先・件名・本文を伏せ、queued なら dead `recipient_deleted` にする → 通知は届かず、運用メールは `recipient_deleted` を数えない。`user_sessions_metadata` の行は FK の CASCADE で消える (S-24) |
| S-41 | DB (送信待ち `email_outbox` への INSERT が一時的に失敗) | 利用者が新しい端末からログイン | `sendEmail` は `{ ok: false, skipped: false }` (`error.code` = `outbox_failed`。app_logs に error) → `alert_sent_at` NULL で `done`・(`finish` が戻った後に) `skipped` に数える。再送しない (通知は届かない)。続く `finish` も失敗すれば例外 → `release` → その回は `failed` だけに数え (`skipped` に数えない)、次の回で取り直してもう一度 `sendEmail` (最大 `LOGIN_ALERT_MAX_ATTEMPTS` 回。§10.2 #5) |
| S-42 | 文面のバグ (`renderLoginNewDeviceEmail` の出力が `EmailEnvelopeSchema` を通らない) | 利用者が新しい端末からログイン | `sendEmail` は登録せずに `{ ok: false, skipped: false }` (`error.code` = `invalid_envelope`。app_logs に error) → `alert_sent_at` NULL で `done`・`skipped` に数える。再送しない (通知は届かない)。見張りは `login-new-device.test.ts` の「EmailEnvelopeSchema を通る」の it (§20.1。§10.2 #4) |
| S-43 | DB (送信待ちへの登録の後の `finishLoginAlert` の UPDATE が、取り直しのたびに失敗し続ける) | 利用者が新しい端末からログイン | 回ごとに登録 (`ok: true`) → `finish` が例外 → `release` (`alert_attempts` + 1) を 3 回 (`LOGIN_ALERT_MAX_ATTEMPTS`) 繰り返し、3 回目の `release` が `done` にする (§10 の例外の行)。`email_outbox` には同じ `idempotency_key` の queued の行が 3 つ入り、届くのは 1 通 (Resend が同じキーを 24 時間覚える operator/10 S-06。取り直しは毎分の回なので 3 行は数分の中)。本書の行は `alert_sent_at`・`device_family`・`is_new_*` が NULL のまま `done` (`release` は通知の列を書かない)。件数は回ごとに `failed` だけで、`queued` には 1 度も数えない (§10.2 #11)。`alert_sent_at` の NULL は「登録した記録が無い」で、登録しなかったことまでは言わない (§10.2 #11・§12.5)。登録と配信は送信待ちの行 (DB の上では `idempotency_key` `login-alert:<session_id>`) が持つ。運営の画面で見られるのは operator/10 の段 C の後で、`template` = `login_new_device` の一覧を時刻と `user_id` の列で見て分かる (一覧は `idempotency_key` を返さない §10.2)。段 C の前は画面で確かめる手段が無い (§17) |
| S-44 | Vercel の関数 (`GET /api/cron/login-alerts` の 1 回) が、送信待ちへの登録 (`ok: true`) の後・`finish` の前に止まる (関数の最長の時間を超える・プロセスが落ちる) | 利用者が新しい端末からログイン | 行は `processing` のまま残り (`release` も呼ばれないので `alert_attempts` は増えない)、`LOGIN_ALERT_RECLAIM_MINUTES` (10 分) の後の回で取り直し (§10 の取り直しの行) → もう一度 `sendEmail` → `email_outbox` に同じ `idempotency_key` の 2 行目 → `finish` で `alert_sent_at` = 2 回目の登録の日時。届くのは 1 通 (S-39 と同じ)。その回の件数 (応答) は残らない。止まり続けた行は 10 分ごとに登録を重ね、作成から 24 時間 (`LOGIN_ALERT_MAX_AGE_HOURS`) の期限切れで `alert_sent_at` NULL のまま `done` (§10.2 #12。最後の行の配信が 1 行目から 24 時間を過ぎると Resend がキーを忘れていて 2 通目になりうる) |
| S-45 | DB (`sendEmail` が宛先停止リスト `email_blacklist` を引く読み取りが一時的に失敗する・時間切れになる) | 利用者が新しい端末からログイン | `sendEmail` は停止リストを確かめずに送信待ちに登録し (`lookup_failed`。app_logs に warn)、`{ ok: true }` を返す → `alert_sent_at` = 登録した日時で `done`・`queued` に数える (S-2 と同じ)。送信待ちの worker は送る直前にもう一度停止リストを引く: 載っていなければ送り (S-2)、載っていれば dead (`suppressed`。運用メールは数えない) で届かない (S-18 と同じく届かないが、本書の行は `alert_sent_at` = 登録した日時のまま。書き戻さない §7.1)、そこでも引けなければ確かめずに送るので、停止リストに載った宛先にも届きうる (送信待ちの仕組みの既定 operator/10 で、本書は変えない)。§10.2 #13。見張りは送信待ちの既存のテスト (`src/__tests__/lib/emails/send.test.ts` の「停止リストを引けなかったとき (DB の失敗・時間切れ) は登録する…」・`src/__tests__/lib/emails/outbox.test.ts` の「停止リストを引けなければ warn して送る」。本書は変えない) と、§20.1 の worker の「send が ok: true (送信待ちに登録できた) なら sentAt = now() で done にし、finish が戻った後に queued に数える…」の it (本書の worker は `ok: true` の中身を見分けない) |

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
                         BEFORE INSERT ON user_profiles  trg_user_profiles_fill_login_stats ─▶ (行がまだ無かった最初のログインの) last_login_at/login_count
   Web の 2 route は session を作る呼び出し (login 1・callback 3) の直後に recordWebLoginContextFromRequest → recordWebLoginContext(session_id, ip, ua, country) で上書き (context_source = 'web')
   モバイルは PATCH /api/auth/sessions/current { device_name } (context_source = 'mobile')
                                                                                                        │
   GET /api/cron/login-alerts (毎分) ──RPC claim_login_alerts──▶ decideLoginAlert(current, prior = 同じ利用者の前の行すべて, horizon = アカウントの作成日時) ──▶ sendEmail(login_new_device) = email_outbox に 1 行 (queued) ──▶ done (alert_sent_at = 登録した日時)
                         (届けるのは GET /api/cron/email-outbox の worker (operator/10)。dead は email_outbox の運用メールで件数を知らせ、再送の画面は operator/10 の段 C (origin/main には無い)。本書は書き戻さない §10.2)
                         (claim_login_alerts は作成から 24 時間を過ぎた待ちの行を送らずに done にし、24 時間以内の行だけを返す)
   GET /api/auth/sessions / login-history ◀── RLS (本人の行)          DELETE /api/auth/sessions/{id} ──▶ RPC auth_session_revoke ──DELETE auth.sessions──▶ (DELETE トリガー)
   POST /api/auth/sessions/revoke-others ──▶ signOutOtherSessions (admin.auth.admin.signOut(本人の access token, 'others')) ──▶ GoTrue ─DELETE auth.sessions (他)─▶ (DELETE トリガー)
   GET /api/admin/users/{id}/login-history ◀── service_role + 監査
   POST /api/auth/password/change|reset ──▶ RPC auth_password_check (crypt) ──ok──▶ updatePasswordWithAccessToken (本人の access token で PUT /auth/v1/user。変更は current_password も渡す) ──▶ GoTrue ─UPDATE auth.users.encrypted_password─▶ AFTER UPDATE on_auth_user_password_changed ──▶ password_history (直近 10 件に切り詰め)
   (本人の access token = readSessionAuth が検証した token。Web は Cookie のセッションの token、モバイルは Bearer の JWT)
```

- **記録の真は `auth.sessions` / `auth.users` の変化だけ**。アプリは「ログインした」を自分で申告しない (申告は漏れる・偽れる)。アプリが足すのは、トリガーが知り得ない文脈 (Web の実 IP / UA / 国、モバイルの端末名) だけで、どれも後から同じ行に上書きする。
- **判定は純関数 2 つ**: `decideLoginAlert` (§12.3) と `deviceFamilyOf` (§12.1)。I/O (行の読み書き・メール) は worker が集めて渡す。
- **失効は DELETE 1 文**: `auth_session_revoke` が `auth.sessions` から消す。GoTrue 自身のログアウトと同じ結果になり、DELETE トリガーが終了を刻むので、「アプリの表だけ revoke 済み」という食い違いが生まれない。
- **パスワードの照合は DB の中で、更新は本人の access token で**: 平文を受けるのはサーバーの route だけ。ハッシュは DB から出さない (`crypt()` で比べる)。更新は `updatePasswordWithAccessToken` (本人の access token で GoTrue の `PUT /auth/v1/user`) → GoTrue が他のセッションを消す (P-1)。`createClient()` の `auth.updateUser` は使わない (Bearer だけの要求では保管にセッションが無く `AuthSessionMissingError` §3)。`admin.updateUserById` も使わない (本人のセッションまで消える §3)。
- **照合と再設定の認可はアプリの経路の決まり**: 効くのは本書の API を通る変更・再設定だけ。access token を持つ人 (盗んだ人を含む) は GoTrue の `PUT /auth/v1/user` を直接呼べるので、その経路は照合も再設定の認可も通らない (記録はトリガーで残る S-33)。直接の経路の「現在のパスワード無しの変更」を止めるのは GoTrue の設定 `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` で、本書の変更の API はその設定が ON でも動くよう `current_password` を GoTrue に渡す (§13.7)。DB のガードで止める案は §7.1 で退けた (§24・Q-18)。
- **他の端末のログアウトも本人の access token で**: `signOutOtherSessions` が `auth.admin.signOut(token, 'others')` を呼ぶ。`createClient()` の `auth.signOut({ scope: 'others' })` は、Bearer だけの要求では GoTrue を呼ばずに成功を返す (§3) ので使わない。
- **worker は取り置き → 判定 → 送信 → 完了の 4 手**で、行の状態 (`alert_status`) が進行を表す (§10)。取り置きは行が live か ended か (`revoked_at`) を見ない (終わったログインも知らせる S-29)。取り置くのは作成から `LOGIN_ALERT_MAX_AGE_HOURS` (24 時間) 以内の行だけで、それより古い待ちの行は同じ RPC が送らずに `done` にする (段 A の間・worker が止まっていた間に溜まった行を、後からまとめて送らない S-34)。通知の待ちの行を作るのはトリガーだけで、列の既定は `done` (トリガー以外の道・ロールバックの後の再適用で残った行は待ちにならない S-35)。
- **通知の「送る」= 送信待ちへの登録** (v1.8): worker の `send` は `sendEmail` で `email_outbox` に 1 行 (queued) 入れて返り、`ok: true` なら `alert_sent_at` に登録した日時を書く (`ok: false` = 登録できなかった (停止リスト・鍵無し・文面の不備・DB の失敗) は NULL で `done`。再送しない)。届けるのは送信待ちの worker (`GET /api/cron/email-outbox`) で、再試行・dead・運用メール・再送はそちらの仕組み (operator/10。再送の画面と API は operator/10 の段 C で、origin/main には無い §3)。本書の行と送信待ちの行は、DB の上で `idempotency_key = 'login-alert:<session_id>'` と `email_outbox.user_id` (worker が `userId` を渡す) でたどれる (段 C の画面の一覧は `idempotency_key` を返さず、`user_id` は列として出すだけで絞り込めない。画面では `template` = `login_new_device` と時刻・`user_id` の列で見分ける §10.2)。dead を通知の状態に書き戻す仕組みは作らない (§7.1)。文面は秘密を含まない (`contains_secret` を書かない) ので、dead の行は伏せられず、段 C の後は再送できる (§18)。
- **利用者の API 7 本の認証は `requireSessionUser`** (§12.4): `getUser` で本人を確かめ、`readSessionAuth` で JWT と access token を読み、`user_profiles` の行は `maybeSingle` で読む (行が無ければ roles = [] で通し、行があって凍結中なら 403)。`requireUser` は行が無いと 401 にするので使わない (§3。行の無い利用者の再設定と端末名の登録を止めない R-15)。運営の route (§14.9) は今までどおり `requireRole`。
- **利用者が書ける値はメールに載せない**: 端末名 (`device_name`) はセッションを持つ誰でも `PATCH sessions/current` で書ける (攻撃者も自分のセッションに書ける)。メールの「端末」は UA から決まる決まった言葉 (`deviceLabelOf`) だけ。一覧は UA の言葉を見出しにし、端末名は添えるだけ。端末名に使える文字は英数字・空白・`()._,+-` に絞る (§12.5)。

### 6.2 トレース (構造で手で走らせた結果)

| # | 経路 | 通る関数・判定 | 結果 |
|---|---|---|---|
| S-1 | `/api/auth/login` → `performGuardedLogin` → `signIn` (GoTrue INSERT → トリガー → 行 `pending`, `context_source='auth'`, UA `node`。`user_profiles` の UPDATE は 0 行) → route が `recordWebLoginContextFromRequest` (`getClaims(access_token)` で `session_id` → `recordWebLoginContext`。IP / UA / 国。`context_source='web'`) → 200 → 同意 (`accept_legal_documents` の `INSERT INTO user_profiles`) → BEFORE INSERT `trg_user_profiles_fill_login_stats` が `last_login_at` = この行の `created_at`・`login_count = 1` | worker: prior 0 件・アカウントは作ってから 90 日以内 → `first_login` → `done` | 通知無し。`GET /api/auth/sessions` が `is_current=true` の 1 行 |
| S-2 | 同上 (Firefox) | worker: prior 1 件 (`windows/chrome`) ≠ `windows/firefox` → `isNewDevice` → `renderLoginNewDeviceEmail` → `sendEmail` (`email_outbox` に queued の 1 行。`idempotency_key` `login-alert:<session_id>`・`user_id` = 本人・`redact_after_send` false) → `ok: true` → `alert_sent_at` = 登録した日時・`done` → 送信待ちの worker (`GET /api/cron/email-outbox`) が Resend へ → sent | メール 1 通 |
| S-3 | モバイル `signInWithPassword` (GoTrue INSERT → トリガー: `CFNetwork` → 後で `ios/app`) → `AuthProvider` の SIGNED_IN → `registerDeviceName(session.access_token)` (この access token ではまだ登録していない) → `PATCH /api/auth/sessions/current` (`DeviceNameBodySchema` の使える文字 → `requireSessionUser` → `device_name`, `context_source='mobile'`) | worker: `ios/app` は新 → メール (「端末」は `deviceLabelOf` の「ほめゴハンのアプリ (iPhone・iPad)」。端末名は載せない) | 一覧に UA の言葉の見出しと「端末名: iPhone 15 Pro (iOS 18)」の行 |
| S-4 | GoTrue 直接 → INSERT → トリガー (攻撃者の道具の UA。Node の supabase-js・fetch なら `node`) | worker: `deviceFamilyOf('node')` = `other/server` (不明な端末) → `decideLoginAlert` は prior に `other/server` の行があっても既知にしない → `new_device` → メール (端末: 不明な端末)。ブラウザの UA なら、その種類が prior に無ければ `new_device` | 本人が S-7 で失効 |
| S-5 | `signOut()` → GoTrue DELETE → `on_auth_session_deleted` (`signed_out`) → 再ログイン → INSERT | worker: 同じ `deviceFamilyKey`・同じ `ip_network` → `known` | 通知無し |
| S-6 | `/auth/callback` → `exchangeCodeForSession` (INSERT) → `recordWebLoginContextFromRequest` (→ `recordWebLoginContext`)。token_hash の `verifyOtp`・`token` のフォールバックの `verifyOtp` の分岐も、成功の直後に同じ関数を呼ぶ (§13.5) | S-1 と同じ | 国は `x-vercel-ip-country` |
| S-7 | `DELETE /api/auth/sessions/{id}` → `requireSessionUser` → `revokeSession` → RPC: `auth.uid()` 一致・`auth.jwt()->>'session_id'` ≠ id → `ended_reason='revoked_by_user'` → `DELETE auth.sessions` → トリガー (`revoked_at`) → `'revoked'` → 200 | 相手の端末: Web は middleware の `getUser()` が `session_not_found` → `/login`。モバイルは `getUser()` の失効 → SIGNED_OUT (AuthProvider の表) | 履歴に `revoked_by_user` |
| S-8 | 同上で id = 自分の `session_id` | RPC `'current'` → 409 | 何も消えない |
| S-9 | `POST /api/auth/sessions/revoke-others` → `requireSessionUser` (中の `readSessionAuth` が Web: Cookie のセッションの token / モバイル: Bearer の JWT を読む) → `signOutOtherSessions(getSupabaseAdmin(), ctx.session.accessToken)` → GoTrue `/logout?scope=others` (JWT の `session_id` 以外を DELETE) → DELETE × n → トリガー | 200 `{ ok: true, remaining }` (`listLiveSessions` で数え直す) | この端末は残る。Web とモバイルで同じ経路 |
| S-10 | 既存の画面 → `signOut()` (global) → DELETE × n | `signed_out` | 変更なし |
| S-11 | `POST /api/auth/password/change` → Zod → `validatePassword` → `requireSessionUser` (roles = 本人の行の roles。行が無ければ []) → `generations=3` → RPC `auth_password_check(uid, current, new, 3)` → `'current_mismatch'` | `performPasswordChange` → `{ kind: 'current_mismatch' }` → 400 | `updateUser` は呼ばれない |
| S-12 | 同上 → `crypt(new, history[1])` が一致 → `'reused'` | 422 `VALID_PASSWORD_HISTORY` | 同上 |
| S-13 | 同上 (route は `requireSessionUser` の `ctx.session` で本人の access token を持つ) → `'ok'` → `updatePasswordWithAccessToken(ctx.session.accessToken, new, current)` (`PUT /auth/v1/user`。本文に `current_password` も入る。Web は Cookie のセッションの token、モバイルは Bearer の JWT) → GoTrue: UPDATE `encrypted_password` → `on_auth_user_password_changed` (INSERT + 切り詰め) → `LogoutAllExceptMe` → DELETE トリガー | 200 `{ ok: true }` | 一覧は 1 行。モバイルも同じ |
| S-14 | `/auth/reset-password` → `POST /api/auth/password/reset` → `requireSessionUser` → `hasRecentRecoveryMethod` = true (`recovery` または `otp`) → RPC (`p_current_password` = NULL) → `'reused'` → 422 / `'ok'` → `updatePasswordWithAccessToken` → 200 → ページの `signOutEverywhere` (既存) | 既存の順 (clear → signOut global → broadcast) は変えない | テスト N-25 は API の呼び出しを足すだけ |
| S-15 | 同上。`amr` = `[{ method: 'password' }]` → `hasRecentRecoveryMethod` = false | 403 `AUTH_RECOVERY_SESSION_REQUIRED` | 変更されない |
| S-16 | page → `adminFetch('/api/admin/users/{id}/login-history')` → `requireRole(['admin','super_admin'])` → `isUuid` → `getSupabaseAdmin()` で 20 行 → 1 行以上なら `recordAdminAudit` (`supabase` は `await createClient()` の利用者の client。`actor_id = auth.uid()` の WITH CHECK を通す) で `admin.user.view_login_history` → `{ data: { entries } }` | support: 403 → page は節を描かない (`actor.roles` で呼び分け) | 監査 1 行 |
| S-17 | `expire_idle_auth_sessions()`: `refreshed_at` が 30 日より古い → `ended_reason='idle_expired'` → `DELETE auth.sessions` → トリガー | アプリ: refresh 400 → SIGNED_OUT | 行は 90 日後に消える |
| S-18 | worker → `sendEmail`: `lookupEmailSuppression` が `suppressed` → `email_outbox` に `dead` / `suppressed` の行 (best-effort) → `{ ok: false, skipped: false, error.code: 'suppressed' }` → `finishLoginAlert(status 'done', sentAt null)` | 再送しない (`alert_attempts` は例外のときだけ増える)。運用メールは `suppressed` を数えない | 印は残る |
| S-19 | 2 つの worker が同時に RPC `claim_login_alerts` → 候補の行を `FOR UPDATE SKIP LOCKED` で選ぶので、片方が取った (ロックした) 行をもう片方は飛ばす。取った側の commit 後は `processing` で条件に合わない | `email_outbox` の行も 1 つ。取り直し (S-39) で 2 行になっても、Resend は同じキーで 2 通目を送らない | 1 通 |
| S-20 | トリガー本体で例外 → `EXCEPTION WHEN OTHERS` → `RAISE WARNING` → `RETURN NULL` (本体の書き込みは巻き戻る) | GoTrue のトランザクションは続く | 記録だけ欠ける: INSERT なら行が作られず、refresh なら `last_active_at` が前のまま、DELETE なら行が live のまま (03:55 JST の照合 `reconcile_user_sessions_metadata` が `signed_out` に揃える §8 の行 20)。§10 のトリガーの失敗の行 |
| S-21 | RPC: `p_current_password` があり、`encrypted_password` が NULL / 空 → `'no_password'` | 409 | — |
| S-22 | `passwordHistoryGenerationsFor(['super_admin'])` = 10 | RPC の `LIMIT 10` | — |
| S-23 | native-bridge は `setSession` で Cookie を張るだけ (GoTrue に新しい行は無い) | 一覧は `ios/app` の 1 行 | — |
| S-24 | `auth.users` DELETE → FK CASCADE | 行が消える (トリガーは `auth.sessions` の DELETE で先に `signed_out` を書くが、その後 CASCADE で消える) | — |
| S-25 | GoTrue INSERT → トリガー → worker: `priorLogins` = `listPriorLogins` (`created_at < row.created_at`・期間で絞らない) に 100 日前の live の行 (`ios/app`) | `decideLoginAlert`: prior 1 件・`windows/chrome` は無い → `new_device` → `send` | メール 1 通 (§10.1 の行 5) |
| S-26 | 同上。`listPriorLogins` は 0 件 (終わった行は 90 日で消えた) → `accountOf` の `createdAt` は 90 日より前 | `decideLoginAlert`: prior 空・アカウントの年齢 > 90 日 → `history_expired` (`isNewDevice` = true。端末の種類が分からなくても同じ §10.1 の行 3) → `send` | メール 1 通 (§10.1 の行 2) |
| S-27 | メールのリンクを開いたブラウザ → GoTrue の `GET /verify` (implicit の枝) が `auth.sessions` に INSERT (トリガー: UA / IP はリンクを開いたブラウザのもの・`amr` `otp`。§8 の行 27) → `homegohan://auth/reset-password#access_token=…` → `reset-password.tsx` の `useEffect` が `setSession` (`:48`。GoTrue が作った行を端末に保管するだけで INSERT しない。SIGNED_IN → `registerDeviceName` が端末名を書く) → 再設定の画面の `onSubmit` → `getApi().post('/api/auth/password/reset')` (Bearer) → `requireSessionUser` (中の `readSessionAuth` が Bearer の JWT を読む。`amr` `otp`) → `hasRecentRecoveryMethod` = true → RPC → `'ok'` → `updatePasswordWithAccessToken(Bearer の JWT, new, null)` → 200 | 画面は既存の `signOutWithCleanup` | 変更される |
| S-28 | 再設定のリンク → `POST /api/auth/password/reset` → `requireSessionUser` → `hasRecentRecoveryMethod` = true → RPC `auth_password_check(uid, NULL, new, 3)`: `encrypted_password` が空だが `p_current_password` が NULL なので `no_password` を返さず、履歴 (0 行) と比べて `'ok'` → `updatePasswordWithAccessToken` → GoTrue が `encrypted_password` を書く → `on_auth_user_password_changed` が 1 行 | 200 → ページの全端末のログアウト (既存) | 最初のパスワードができる |
| S-29 | GoTrue INSERT (`pending`) → 15 秒以内に `signOut` → DELETE トリガー (`revoked_at`・`signed_out`。`alert_status` は `pending` のまま) → 次の回の `claim_login_alerts` (`revoked_at` を見ない) が取る → `decideLoginAlert` → 新しい端末の種類 (不明な端末を含む) なら `send` → `finishLoginAlert` | ended / `pending` → ended / `processing` → ended / `done` (§10 の ended の行) | メール 1 通 |
| S-30 | 再設定: `requireSessionUser` → `getUser` は本人・`user_profiles` は 0 行 (`maybeSingle` の `data` が null) → roles = [] で通す → 以下 S-14 と同じ (`generations` = 3)。アプリ: SIGNED_IN → `registerDeviceName` → `PATCH sessions/current` → `requireSessionUser` (同じく行無しで通す) → `setCurrentDeviceName` | `requireUser` を通らないので `AUTH_PROFILE_NOT_FOUND` (401) にならない | 200 |
| S-31 | `PATCH sessions/current` → `DeviceNameBodySchema` の `DEVICE_NAME_PATTERN` に合わない → 400。英数字だけなら 200 で書ける → worker の `send` には `deviceLabelOf(family)` だけを渡す (`LoginAlertRow` は `device_name` を持たない §13.3) | メールの「端末」は UA の言葉 | 一覧では見出し = UA の言葉、端末名は添え書き |
| S-32 | `/api/auth/login` → `signIn` (GoTrue INSERT → トリガー: UA `node`・`context_source='auth'`) → `recordWebLoginContextFromRequest` の中で `recordWebLoginContext` が `false` (または例外をその関数の try が握る §13.5) → `warn` → 200 (`signed-in`) | worker: `deviceFamilyOf('node')` = `other/server` → prior が 1 件以上 → 不明な端末は既知にしない → `new_device` → `send` (端末: 不明な端末・国の行は無し) | メール 1 通。ログインは成功のまま |
| S-33 | 攻撃者 → GoTrue `PUT /auth/v1/user` (anon キー + 盗んだ JWT。本書の route を通らない) → GoTrue の `UserUpdate`: (OFF) `UpdatePassword` → `on_auth_user_password_changed` (INSERT・切り詰め) → `LogoutAllExceptMe` → DELETE トリガー (`signed_out`) / (ON) `session.IsRecovery()` が偽 (`amr` `password`) なので `current_password` を求めて 400 | `auth_password_check` は呼ばれない (照合なし) | OFF: 変わる・記録は残る / ON: 変わらない |
| S-34 | 段 A: `/api/auth/login` → `signIn` → トリガー (`pending`) → `recordWebLoginContextFromRequest` (`web`・実際の UA) → worker が無いので待ちのまま。段 B のデプロイ → 次の分の `claim_login_alerts(…, p_max_age_hours = LOGIN_ALERT_MAX_AGE_HOURS)`: 1 つ目の文が `created_at < now − 24 時間` の待ちの行を `FOR UPDATE SKIP LOCKED` で選んで `done` (`alert_claimed_at` NULL・`is_new_*`・`device_family` は NULL のまま) → 2 つ目の文が 24 時間以内の待ちの行を古い順に取って返す | 3 日前の行: 返らない (送らない)。2 時間前の行: `decideLoginAlert` (UA は route が書いた実際の値) → `known` か `new_device` | 段 A の間の行が「不明な端末」としてまとめて届かない |
| S-35 | `.down.sql` (§11.7: 列を DROP・トリガーの本体を空に) → 行は残る → migration をもう一度: §11.1 の `ADD COLUMN IF NOT EXISTS alert_status text NOT NULL DEFAULT 'done'` (列が無いので足され、残った行はすべて `done`) → §11.2 の写しは `ON CONFLICT (session_id) DO NOTHING` で残った行を飛ばす → §11.3 が本体を戻す (トリガーは同じ名前があるので作らない) | worker: 残った行は `done` なので取り置かれない。本体を戻した後のログインだけが `pending` | 古い行の通知は出ない |
| S-36 | 攻撃者 → GoTrue `/token?grant_type=refresh_token` (anon キー + 盗んだ refresh token) → GoTrue が同じ行を UPDATE (`refreshed_at`・`user_agent`・`ip`。`UpdateOnlyRefreshInfo` §3) → `on_auth_session_refreshed` (`WHEN OLD.refreshed_at IS DISTINCT FROM NEW.refreshed_at`) → `auth_session_refreshed` が `last_active_at` だけを書く (`user_agent` は読まない。§20.3 の結合テストの「refresh で last_active_at が進み、user_agent は変わらない」の it) | worker: INSERT が無いので `pending` の行は無く、取り置くものが無い | メールは無い。一覧の行は `last_active_at` だけが進む (§8 の行 35) |
| S-37 | worker → `send` → `sendEmail` → `email_outbox` に queued → `ok: true` → `finishLoginAlert(sentAt = now())` → `done`。送信待ちの worker: `claim_email_outbox` → Resend 403 (`validation_error`。ドメイン未検証) → `fail_email_outbox(retryable = false)` → dead → `app-log-alerts` の `checkEmailDeadLetters` (閾値 0 = 1 件から) → `claim_ops_alert` → `mark_email_outbox_dead_alerted` → `ops_email_dead_letter` (段 B の整合で再走行するのはここまで) → (operator/10 の段 C の後だけ) super_admin が `/super-admin/email-outbox` で再送 → `requeue_email_outbox` → queued → sent (operator/10 S-11 の範囲) | `user_sessions_metadata` は `done`・`alert_sent_at` = 登録の日時のまま (書き戻しは無い) | 段 C の前: 届かない (運用メールの件数まで)。段 C の後: 本人には再送の後に届く |
| S-38 | worker → `send` → `sendEmail` が `RESEND_API_KEY` 無しで登録せず `{ ok: false, skipped: true }` → `finishLoginAlert(sentAt null)` → `done`・`skipped` | `email_outbox` に行は無い | メールは無い |
| S-39 | worker → `send` (`email_outbox` に 1 行) → `finish` が例外 → `release` (`alert_attempts` 1・`pending`) → 次の回 `claim` → `send` (2 行目・同じ `idempotency_key`) → `finish` → `done` (`alert_sent_at` = 2 回目) | 送信待ちの worker が 2 行を順に送る: 1 行目 sent、2 行目は Resend が同じキーで同じ応答を返す (処理中なら `concurrent_idempotent_requests` → 再試行) → sent | 1 通 |
| S-40 | worker が登録した行 (`user_id` = 本人) が queued のまま → `/api/account/delete` → `prepare_account_deletion` の 1b (`o.user_id = p_user_id OR lower(o.to_email) = ANY (v_emails)`) → `to_email` 伏せ字・dead `recipient_deleted` → `auth.admin.deleteUser` → `user_sessions_metadata` は CASCADE で消える | 送信待ちの worker はこの行を取らない (dead)。運用メールは `recipient_deleted` を数えない | メールは無い |
| S-41 | worker → `send` → `sendEmail` → 停止リストを引く → `email_outbox` の INSERT が失敗 → `outbox_failed` (`ok: false`) → `finishLoginAlert(sentAt = null)` → `done` (`skipped`) | 送信待ちに行は無い | 届かない |
| S-42 | worker → `send` → `sendEmail` → `EmailEnvelopeSchema.safeParse` が失敗 → `invalid_envelope` (`ok: false`) → `finishLoginAlert(sentAt = null)` → `done` (`skipped`) | 送信待ちに行は無い | 届かない |
| S-43 | worker → `send` (1 行目) → `finish` が例外 → `release` (`alert_attempts` 1・`pending`) → 次の回 `send` (2 行目) → `finish` が例外 → `release` (2・`pending`) → 次の回 `send` (3 行目) → `finish` が例外 → `release` (3 ≥ `LOGIN_ALERT_MAX_ATTEMPTS` → `done`)。`alert_sent_at`・`device_family`・`is_new_*` は NULL | 送信待ちの worker が 3 行を順に送る: 1 行目 sent、2・3 行目は Resend が同じキーで同じ応答を返す → sent | 1 通 |
| S-44 | worker → `send` (1 行目) → 関数が止まる (`processing`・`alert_claimed_at` は止まる前の時刻) → 10 分後の回の `claim_login_alerts` が取り直す (`alert_claimed_at < now - LOGIN_ALERT_RECLAIM_MINUTES`) → `send` (2 行目) → `finishLoginAlert(sentAt = now())` → `done` | S-39 と同じ (2 行とも sent・届くのは 1 通) | 1 通 |
| S-45 | worker → `send` → `sendEmail` → `lookupEmailSuppression` が `lookup_failed` → warn → `email_outbox` に queued → `ok: true` → `finishLoginAlert(sentAt = now())` → `done` (`queued`)。送信待ちの worker: `claim_email_outbox` → `lookupEmailSuppression` (もう一度) → `clear` なら Resend → sent / `suppressed` なら `fail_email_outbox` → dead `suppressed` / `lookup_failed` なら warn → Resend → sent | `user_sessions_metadata` は `done`・`alert_sent_at` = 登録の日時のまま (どの枝でも書き戻しは無い) | `clear`: 1 通。`suppressed`: 届かない。2 回とも引けない: 停止リストに載った宛先にも 1 通届きうる |

## 7. 構造裁定 (相 3・1 回だけ)

### 7.1 代替案の比較

| 論点 | 案 | 採否 | 理由 |
|---|---|---|---|
| **ログインの記録の入口** | (a) `auth.sessions` の INSERT / UPDATE / DELETE トリガー | **採用** | 呼ぶ側 (Web・モバイル・攻撃者の直接呼び出し) が選べない場所。1 行 = 1 セッションなので一覧と履歴が同じ表で済む。`ip` / `user_agent` は作成時に入る (§3) |
| | (b) アプリの各ログイン経路で INSERT (Web の 2 route + モバイルの申告 API) | 不採用 | anon キーで GoTrue を直接呼ぶ攻撃者 (S-4) と、申告を呼ばない旧アプリ・OAuth の新経路が漏れる。#1190 の目的 (乗っ取りの早期発見) に対して構造的な穴 |
| | (c) pg_cron で `auth.sessions` を毎分写す | 不採用 | 1 分の遅れで「ログイン直後に一覧に自分が居ない」。同じ分の中で作られて消えたセッションを取りこぼす。終了の時刻が近似になる |
| | (d) Supabase Auth Hook (Custom Access Token) | 不採用 | 入力に IP / UA が無い。発行のたび (refresh) に呼ばれ、ログインと区別できない |
| **Web の実 IP / UA** | (a) Web の 2 route がログインの直後に同じ行を上書き (`recordWebLoginContextFromRequest` → `recordWebLoginContext` §13.5。段 A で入れる §0.2) | **採用** | GoTrue が記録する Web の UA は `node`・IP は Vercel (§3)。上書きはトリガーの INSERT より後 (同じ要求の中) で、worker は作成から 15 秒は判定しない。上書きは判定の前 (`alert_status = 'pending'`) の行だけで、判定に回った後に届いた上書きは捨てる (§10・§13.5) |
| | (b) middleware で毎要求に上書き | 不採用 | 全要求に DB の書き込みが増える |
| **端末の判定の単位** | (a) OS × クライアント (ブラウザ / アプリ) の種類 (`deviceFamilyOf`) | **採用** | UA の生の文字列はブラウザの更新で毎回変わり、更新のたびに「新しい端末」になる。種類で比べれば更新では鳴らない |
| | (b) UA の生の文字列 | 不採用 | 上 |
| **IP の扱い** | (a) /24 (v6 は /48) の範囲を記録・表示し、通知の条件には使わない | **採用** | 携帯回線 (CGNAT) と家庭の回線は接続ごとに範囲が変わり、本人のログインのたびに鳴る。鳴りすぎる通知は無視される。端末の種類と国で鳴らす (Google / GitHub と同じ方針)。変えるなら `decideLoginAlert` 1 か所 (§25 Q-4) |
| | (b) 新しい IP の範囲でも通知 | 不採用 | 上 |
| **地域** | (a) Web の経路だけ Vercel の `x-vercel-ip-country` を記録し、国が分かっている行どうしで比べる | **採用** | 外部の GeoIP に利用者の IP を送らない。モバイルは NULL (比べない) |
| | (b) GeoIP の外部 API | 不採用 | 依存・費用・IP の第三者提供 |
| **通知の実行** | (a) Vercel Cron (毎分) の worker が `pending` の行を取り置いて処理 | **採用** | 経路を問わず 1 本。既存の `*/1 * * * *` と `requireCronAuth` (app-log-alerts) に揃う。取り置きと戻しは DB の関数 (`claim_login_alerts`・`release_login_alert` §11.4)。PostgREST の UPDATE では「件数を限って取る」と `alert_attempts + 1` を原子的に書けないので、既存の `claim_menu_request` (20261007160400) と `requeue_stale_meal_image_jobs` (20261015180000) と同じ `FOR UPDATE SKIP LOCKED` の形にする |
| | (b) トリガーから pg_net で API を叩く | 不採用 | 秘密を DB に置く経路が増える (Vault はあるが、ログインのたびに HTTP が出る)。失敗の再試行が無い |
| | (c) Web の login route の中で送る | 不採用 | モバイル・直接の経路を取りこぼす (= (b) の記録の案と同じ穴) |
| **溜まった通知の待ちの行** (段 A のデプロイから段 B の worker まで・worker が止まっていた間・ロールバックの後にもう一度 migration を流したときに残っていた行) | (a) 取り置きに作成からの上限 (`LOGIN_ALERT_MAX_AGE_HOURS` = 24 時間) を置き、超えた待ちの行は送らずに `done` にする (§11.4)。列 `alert_status` の既定は `'done'` で、待ちの行はトリガーだけが `'pending'` を明示して作る (§11.1)。Web の文脈の上書き (§13.5) は段 A で入れる (§0.2) | **採用** (R5) | 経路・時期を問わず「何日も前のログインのメールをまとめて送る」道が無くなる (S-34・S-35)。上限は SQL の 1 か所 (§11.4) で、段の手順やスイッチの操作に頼らない。Web の文脈を段 A で入れるので、段 A の間の Web の行は実際の UA で記録され、上限の内側の行の判定は段 B の後のログインと同じ (「不明な端末」としてまとめて届かない)。上限の外に落ちるのは worker が 24 時間以上止まったときのその間のログインで、記録 (履歴) は残る (§25 Q-20) |
| | (b) 段 A のトリガーは `'done'` で作り、段 B の migration で `'pending'` に切り替える | 不採用 (R5) | 段 B に migration (と `.down.sql`) が増える。migration とコードの本番への入り方の順が決まらない (§0.2 の注) ので、切り替えから worker と Web の文脈の上書きが入るまでの間の行が残る。ロールバックの後の再適用 (S-35) は閉じない |
| | (c) 段 B は `AUTH_LOGIN_ALERT=off` で出し、溜まった行が掃けてから on にする | 不採用 (R5) | 人の操作の時機に頼る (戻し忘れ・早すぎで一斉に届く)。ロールバックの後の再適用 (S-35) と、worker が長く止まった後の再開は閉じない |
| | (d) 上限を置かない (R4 まで) | 不採用 (R5) | 段 B の最初の回に段 A の間のすべての行が判定され、Web の行は UA `node` の「不明な端末」としてメールになる。worker が止まっていた後も、その間のすべてのログインが遅れてまとめて届く |
| **通知メールの「送った」の意味と、届けられなかったときの扱い** (v1.8。#1760 で `sendEmail` が送信待ちへの登録になった) | (a) `alert_sent_at` = 送信待ち (`email_outbox`) に登録した日時。`sendEmail` の `ok: false` (登録できなかった) は NULL で `done`。登録の後の記録が残らなかった行 (`finish` の 3 回続けての失敗・関数が止まり続けての期限切れ §10.2 #11・#12) も NULL で、NULL は「登録した記録が無い」の意味 (登録の正本は `email_outbox` の行)。配信の失敗 (dead) は送信待ちの側 (運用メール `ops_email_dead_letter`。再送の画面と API は operator/10 の段 C で入る) で扱い、通知の状態 (`alert_sent_at`・`alert_status`) には書き戻さない。行どうしは DB の上で `idempotency_key` (`login-alert:<session_id>`) と `user_id` でたどれる (段 C の画面の一覧は `template` で絞り、`user_id` は列として出すだけ §10.2) | **採用** (v1.8) | 列の名前 `alert_sent_at` は段 A で本番に入っていて変えない (意味だけ定める Q-24)。送信待ちは「アプリのメールはすべてここを通り、配信の責任はここが持つ」(operator/10 R-23) ための仕組みで、再試行 (約 5.4 時間)・dead の運用メール (1 件から) は main にあり、再送の画面と API は同じ設計 (operator/10 §9.2) の段 C で入る (origin/main 9f4f6da8 には無い §3。段 C の前は dead の通知を再送できず、運用メールの件数だけになる)。本書が配信の結果を見ると、同じ責任を 2 か所で持つ。(b) で書き戻しても本書の worker は再送しないので、段 C の前の「再送できない」は (a)・(b) で変わらない。届かない原因 (ドメイン未検証・鍵・停止リスト) は利用者の行ごとでなく運用で直すもので、直せば段 C の後は画面から再送できる (S-37)。段 B のマージの条件に段 C を足すかは Q-25 |
| | (b) 送信待ちの worker が dead にしたとき、`user_sessions_metadata.alert_sent_at` を NULL に戻す (`fail_email_outbox` から `idempotency_key` の接頭辞で本書の行を引く、または通知の列に `email_outbox.id` を持つ) | 不採用 (v1.8) | 送信待ちの RPC・表 (operator/10 の持ち物) に本書の都合の分岐を足し、2 つの設計が互いに依存する。戻しても本書の worker は再送しない (24 時間の期限 §11.4) ので、NULL に戻す意味は「届かなかった」の記録だけになり、それは `email_outbox` の行が既に持つ (dead は 30 日残る)。段 A の列・RPC を変えず、段 B に migration を足さないためにも採らない |
| | (c) 本書の worker が `email_outbox` の行の状態 (sent / dead) を待って `alert_sent_at` を書く | 不採用 (v1.8) | 取り置きが配信の時間 (最大約 5.4 時間) にまたがり、`LOGIN_ALERT_RECLAIM_MINUTES` (10 分) の取り直しと衝突する。worker を 2 段 (登録 → 配信の確認) にする分の状態 (列) が増える |
| **文面 `login_new_device` の秘密の宣言** (#1785) | (a) 宣言しない (`contains_secret` を書かず、`redactAfterSend` も渡さない) | **採用** (v1.8) | 文面にあるのは日時・端末の種類の言葉・IP・国と、固定のパス (`/settings/account`・`/settings/security/sessions`) へのリンクだけで、受け取った人だけが使えるトークンは無い (#1708 の秘密の定義 = 招待・本人確認・本人同意のトークンを含むリンク)。伏せないので、dead の行を再送できる形で残す (伏せた行は 'redacted' で再送できない。再送の画面と API は operator/10 の段 C で入る §3)。IP はログイン履歴 (`user_sessions_metadata`。本人は一覧で見る) が持つ値で、`email_outbox` の行は sent 7 日 / dead 30 日で消える |
| | (b) `contains_secret: true` にする (IP を伏せる) | 不採用 (v1.8) | 秘密の定義に当たらず、`secret-templates.test.ts` の秘密ありの見本 (`SECRET_EMAIL_SAMPLES`。本物の組み立てでトークンが本文に入ること) を満たせない。伏せると dead の再送ができず、届かなかった通知を運用で届け直せない |
| **`email_outbox.user_id`** | (a) worker が `userId: row.user_id` を渡す | **採用** (v1.8) | 退会の伏せ字 (`prepare_account_deletion` の 1b。宛先の一致でも引けるが、`user_id` があれば確実) に使う。送信待ちの画面 (operator/10 の段 C) の一覧は `user_id` を列として返す (絞り込みの条件には無い §9.2) ので、`template` で絞った一覧から本人の行を見分ける手がかりにもなる。worker は `user_id` を持っている (operator/10 §6.3「分かる呼び出し元だけ渡す」) |
| | (b) 渡さない | 不採用 (v1.8) | 画面で利用者の通知を引けない。退会の伏せ字は宛先の一致に頼ることになる |
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
| **再設定の認可** | (a) `amr` に 60 分以内の `recovery` または `otp` (`RECOVERY_AMR_METHODS`) | **採用** (R1 で `otp` を加えた) | 盗んだ普通のセッション (`password` / `oauth`) で現在のパスワード無しに変える穴 (S-15) を、アプリの経路 (本書の API・画面) で閉じる (GoTrue を直接呼ぶ経路は下の「GoTrue の `PUT /user` の直接の呼び出し」の行・S-33)。再設定のリンクの形で `amr` が変わる (PKCE の code → `recovery`、token_hash / implicit → `otp` §3) ので両方を受ける。`otp` はメールのリンク / コードでメールボックスを持つことを示したセッションで、`recovery` と同じ強さ。`getClaims` は署名を確かめる |
| | (b) `recovery` だけ | 不採用 (R1) | token_hash (Web の `/auth/callback`)・implicit (モバイル) の正当な再設定が全部 403 になる |
| **GoTrue の `PUT /user` の直接の呼び出し** (access token + 公開の anon キーで、本書の API を通らずにパスワードを変える S-33) | (a) 本書はアプリの経路だけを守る。直接の経路の「現在のパスワード無しの変更」は GoTrue の設定 `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` (§3) に任せ、本書の変更の API はその設定が ON でも動くよう `current_password` を GoTrue に渡す (§13.7)。ON にするかはオーナーの判断 (§24・Q-18)。直接の経路の履歴の照合は行わない (記録はトリガーで残る) | **採用** (R4) | GoTrue 自身が、再設定のセッション (`otp`・`magiclink`・`recovery`) を除いて現在のパスワードを求める仕組みを持つ。設定 1 つで、アプリの外の経路にも「現在のパスワードか、再設定のセッション」の決まりが掛かる (GoTrue は再設定のセッションの期限を見ない §3)。照合 (再利用の禁止) は平文が要るので、GoTrue を直接呼ぶ経路では行えない (下の (b) の ④) |
| | (b) `auth.users` の `BEFORE UPDATE OF encrypted_password` のガードが、`auth_password_check` が `ok` のときに出す短命の許可を消費し、許可が無ければ例外で更新を止める | 不採用 (R4) | ① ガードの失敗・許可の欠落がパスワードの更新を止める (R-13 の逆)。管理 API (`PUT /admin/users/{id}`)・Supabase の画面からの変更・既存の結合テスト (`tests/integration/security/password-update-revokes-sessions.test.ts`・`account-credentials-change.test.ts` の `updateUser({ password })`) は許可を持たないので、全部止まる ② GoTrue は DB の暗号化の設定が ON のとき、パスワードのログインの中で `encrypted_password` を書き直す (§3) ので、その設定に変わるとガードがログインそのものを止める ③ 許可は RPC と GoTrue への別の HTTP の要求をまたぎ、トリガーには新しいハッシュ (塩つき) しか見えないので、許可を「照合したパスワード」に結び付けられない ④ 再利用の照合はトリガーではできない (平文が無い) ので、ガードが止めるのは「本書の API を通らない変更」で、直接の経路の再利用の照合にはならない |
| **端末の種類が分からないログイン** (UA が `node`・`undici` などのサーバーの既定 = `other/server`、空・読めない UA = `other/other`。一覧・メールの言葉はどちらも「不明な端末」) | (a) 既知にしない: prior に同じ不明な種類の行があっても新しい端末として知らせる。prior が空で履歴が消えた (`history_expired`) ときも知らせる | **採用** (R4) | Node の supabase-js・素の fetch で GoTrue を直接呼ぶと、UA は何もしなくても `node` になる (S-4)。既知にすると、この経路の攻撃者には通知が 1 通も届かない (国も入らない §7.1 の「地域」の行)。Web の正規のログインは作成から 15 秒のうちに route が実際の UA に書き換える (§13.5) ので、判定の時点で `node` のまま残るのは、文脈の記録に失敗したログイン (S-32) か、スクリプトからのログインだけ。前者で本人に 1 通届くのは、送る側に倒す方針 (`LOGIN_ALERT_PRIOR_MAX_ROWS` の注記と同じ) で受け入れる |
| | (b) 既知とみなす (送らない) | 不採用 (R4) | 上の穴 (R-3) |
| **不審の判定の比べる相手** | (a) 同じ利用者の前の行すべて (`created_at < row.created_at`。期間では絞らない) + アカウントの作成日時で「履歴が消えた」を見分ける | **採用** (R1) | 長く続く live の行は消えないので必ず入る (S-25)。終わった行は 90 日で消えるので、作成から 90 日を過ぎたアカウントで prior が空なら、初めてと断定できない → 知らせる (S-26)。作成から 90 日以内なら消えた行は無い (消すのは `revoked_at` が 90 日より前の行だけ) ので、prior が空なら本当に初めて |
| | (b) 直近 90 日に作られた行だけ | 不採用 (R1) | 90 日より前に作られて今も続く端末を取りこぼし、乗っ取りを `first_login` と誤る |
| | (c) `user_profiles.login_count` で初めてかを見る | 不採用 (R1) | 新規登録の直後の最初のログインでは `user_profiles` の行がまだ無い (行は同意・初期設定で作られる。migration 20261008200700 の `INSERT INTO public.user_profiles` の注記) ので、数が当てにならない |
| **放置されたセッション** | (a) 30 日の 1 値を DB のジョブで | **採用** | GoTrue は消さない (§3)。1 値なら SQL の定数 1 つ。ロール別 (cross/01 §4.1) は §25 Q-3 |
| **既存の表** | (a) `user_sessions_metadata` に列を足し、`password_history` はそのまま | **採用** | 正典 (operator/01 §3.23 / §3.25) の stub をそのまま埋める。`sessions_revoke_self` (本人の UPDATE) は消す (本人が印や終了を書き換えられる) |
| **利用者の API の認証** | (a) 行の無い利用者も通す `requireSessionUser` (`getUser` + `readSessionAuth` + `user_profiles` を `maybeSingle`。行があって凍結中なら 403) | **採用** (R3) | `user_profiles` の行は同意・初期設定・招待の承諾で作られ、本番の 130 人には無い (§3)。いまの再設定はこの人たちにも動く。凍結は行の `frozen_at` なので、行が無ければ凍結は無い。middleware も API の凍結を止める (§3) |
| | (b) 既存の `requireUser` | 不採用 (R3) | 行が無いと `AUTH_PROFILE_NOT_FOUND` (401)。同意の前に再設定する人と、アプリで初めてログインした人の端末名の登録が止まる (後退) |
| | (c) `requireUser` に「行を要さない」引数を足す | 不採用 (R3) | `src/lib/auth/helpers.ts` を使う全 route の契約に触れる。本書の 7 本だけが要るので、本書のモジュールに置く |
| **終わったログインの通知** | (a) 取り置きは `revoked_at` を見ない (ended の行も判定して知らせる) | **採用** (R3) | 攻撃者がログインして 15 秒以内にログアウトすれば通知を逃れる穴を作らない (S-29)。パスワードの変更・MFA で GoTrue が消した他の端末の `pending` の行も同じく判定される (§8 の行 12・16) |
| | (b) live の行だけ (`revoked_at IS NULL`) | 不採用 (R3) | 上の穴 (R-3) |
| **端末名 (`device_name`) の扱い** | (a) メールに載せない。一覧は UA の言葉を見出しにし、端末名は添えるだけ。使える文字は英数字・空白・`()._,+-` | **採用** (R3) | 端末名はセッションを持つ誰でも書ける (攻撃者も、判定の前に自分のセッションに)。自由な文が正規のドメインから届くメールに載ると、「あなたの iPhone」の偽装や URL のフィッシングの文を運ぶ。機種名と OS の版はこの文字で書ける。アプリは利用者が付けた端末の名前 (`expo-device` の `deviceName`。人の名前を含みうる) を送らず、機種名 (`modelName`) を送る (§16) |
| | (b) `context_source = 'auth'` の行だけ書ける (1 度だけ) | 不採用 (R3) | 攻撃者が GoTrue を直接呼んで作る行は `auth` なので、1 度は書ける (防げない) |

### 7.2 F の問い — 縁の発生源を消すより単純な構造は無いか

- 記録の入口は `auth.sessions` のトリガー 1 つに畳んだ。アプリ側の「文脈の上書き」は Web の 2 route (login の 1 か所・callback の 3 か所。どれも共通の `recordWebLoginContextFromRequest` §13.5) とモバイルの 1 call で、どれも無くても記録は残る (Web の文脈が無いと端末の種類が `other/server` (不明な端末) のままで、判定は新しい端末として知らせる側に倒れる S-32。端末名が無いと一覧は UA の言葉だけになる)。
- 残る縁は 7 つで、いずれもテスト (§20) が見張る: ① Web で GoTrue に新しいセッションを作る route・分岐が増えたのに、その直後に文脈を書かない (走査 `tests/auth/web-login-context-source-scan.test.ts`: `src/app/**/route.ts` の、コメントを除いた本文の `.signInWithPassword(`・`.exchangeCodeForSession(`・`.verifyOtp(` の呼び出しの数より、`recordWebLoginContextFromRequest(` の呼び出しの数が少ないと赤。分岐ごとに呼んでいるかは route のテスト §20.2 の分岐ごとの it が見る) ② `password_history` の切り詰め数と TS の世代数の最大が食い違う (契約テスト) ③ SQL の 30 日 / 90 日 / `/24` / `/48` と TS の定数が食い違う (契約テスト) ④ パスワードを更新する画面が API を通らず `updateUser({ password })` を直接呼ぶ (走査 `tests/auth/password-update-source-scan.test.ts`: `src/`・`apps/mobile/` の本番コードで `updateUser({ password` は 0 件)。 ⑤ 本人として GoTrue を変える route が、サーバーの client の `auth.updateUser` / `auth.signOut` に戻り、Bearer だけのモバイルの要求で黙って失敗する (同じ走査: `revoke-others` と `password/**` の route は `auth.signOut(` / `auth.updateUser(` を呼ばない。結合テスト §20.3 が Bearer だけの更新・失効を実 GoTrue で確かめる)。 ⑥ 利用者の route が `requireUser` に戻り、`user_profiles` の行が無い利用者を 401 にする (route のテスト §20.2 の「行の無い利用者でも 200」の it と、`requireSessionUser` の単体テスト §20.1)。 ⑦ 通知の待ちの行が溜まって、後から何日も前のログインのメールがまとめて届く (段の切り替え・worker の停止・ロールバックの後の再適用。取り置きの作成からの上限 §11.4 と列の既定 `'done'` §11.1。結合テストの期限切れの it と契約テスト §20.3)。
- 「申告しない (トリガー) + 文脈だけ上書き」より単純な構造 (申告だけ) は、S-4 を取りこぼす。「上書きもしない」は Web の記録が全部 `node` / Vercel の IP になる。

- v1.8 (段 B の前の改定) は構造を変えない: 配信の責任を送信待ち (operator/10) に置いたまま、worker の `send` の戻りの意味と `alert_sent_at` の意味を合わせただけ。縁は増えない (通知の行と送信待ちの行をつなぐ新しい列・RPC を作らず、DB の上で `idempotency_key` と `user_id` でたどる)。見張りは既存の番兵 (§22 N-18・N-40・N-41) と worker の単体テスト (§20.1) が受け持つ。

**構造を確定する。以後の蒸し返しは裁定への差し戻し事由として別に扱う。**

## 8. ① 全パターン表 (出来事 × 経路 → 記録)

| # | 出来事 | 経路 | `auth.sessions` | トリガー | アプリ | 行の結果 |
|---|---|---|---|---|---|---|
| 1 | パスワードでログイン | Web `/api/auth/login` | INSERT (UA `node`) | created | `recordWebLoginContextFromRequest` (§13.5) | `web`・実 IP / UA / 国・`pending` (記録に失敗すると `auth`・UA `node` = 不明な端末のまま S-32) |
| 2 | パスワードでログイン | モバイル (直接) | INSERT (端末の UA) | created | `PATCH sessions/current` | `mobile`・端末名・`pending` |
| 3 | Google / Apple でログイン | Web `/auth/callback` (code の `exchangeCodeForSession`) | INSERT | created | `recordWebLoginContextFromRequest` | 1 と同じ |
| 4 | Google でログイン | モバイル (`authLink.ts` の exchange) | INSERT | created | `PATCH sessions/current` | 2 と同じ |
| 5 | メールのリンク (確認・招待・メールアドレス変更。token_hash の形の再設定) | Web `/auth/callback` (token_hash の `verifyOtp`・`token` のフォールバックの `verifyOtp` の 2 つの分岐。どちらも成功の直後に `recordWebLoginContextFromRequest`) / モバイル `authLink.ts` (`verify.tsx` に届くリンク。`:66` の `verifyOtp`・`:72` の `setSession`) | INSERT (`setSession` の形は、GoTrue の `GET /verify` がリンクを開いたブラウザの要求で作った行。アプリの `setSession` は保管するだけ) | created | 1 / 2 と同じ | 再設定の行も 1 ログイン。アプリの再設定のリンクは `authLink.ts` を通らない (行 26〜28) |
| 6 | anon キーで GoTrue を直接 | 攻撃者 | INSERT | created | 無し | `auth`・GoTrue の実 IP / UA・`pending` (Node の道具なら UA は `node` = 不明な端末で、判定は新しい端末 §10.1・S-4) |
| 7 | トークンの更新 | Web middleware (サーバー) / Web の browser の client (`@supabase/ssr` の自動更新・`src/hooks/useHomeData.ts:183` の `refreshSession()`) / サーバーの `POST /api/auth/session-sync` (`src/app/api/auth/session-sync/route.ts:11` の `getSession()` が期限切れの access token を更新。`:20` の `refreshSession()` は Cookie のセッションに token が無いときだけ呼ばれ、auth-js が GoTrue を呼ばずに `AuthSessionMissingError` を返すので更新は起きない) / サーバーの `DELETE /api/auth/mfa/factors/{id}` (MFA の解除の後の `src/app/api/auth/mfa/factors/[id]/route.ts:98` の `refreshSession()`。解除そのものは行 38) / モバイル auth-js (自動更新・`apps/mobile/src/lib/webViewBridge.ts:535` の `refreshSession()`) | UPDATE `refreshed_at` (UA / IP も上書きされるが読まない。INSERT はしない) | refreshed | 無し | `last_active_at` |
| 8 | WebView の bridge | `/auth/native-bridge` (`setSession`) | 変化なし | — | 無し | ネイティブの行のまま (S-23。§20.3 の結合テストの setSession の it) |
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
| 21 | ログアウト (local) | モバイル `AuthProvider` の起動時の確認 (`getUser()` が失効と答えた後の `signOut({ scope: 'local' })`。origin/main a6455673 `apps/mobile/src/providers/AuthProvider.tsx:207`) | GoTrue の `/logout?scope=local` が呼んだセッションの行を DELETE × 1 (サーバーが失効と答えた後なので、多くは行がもう無く 0 件) | deleted (行があったときだけ) | 無し | `signed_out` (行が既に無ければ、先に消した側の理由のまま) |
| 22 | 運営による凍結 | `/admin/users/{id}/freeze` | 変化なし (凍結は middleware の判定で止める §0.3) | — | 無し | 行は変わらない (記録しない。一覧には live のまま出る) |
| 23 | プロフィールの行ができる (新規の利用者の同意・モバイルの初期設定の upsert・招待の承諾) | `accept_legal_documents` などの `INSERT INTO user_profiles` | 変化なし | `user_profiles` の BEFORE INSERT `trg_user_profiles_fill_login_stats` | 無し | `user_sessions_metadata` は変わらない。`user_profiles.last_login_at` / `login_count` を、それまでの記録 (同じ利用者の行の最新の `created_at` と行数) から入れる (行 1〜6 のログインの時点で行が無く、`auth_session_created` の UPDATE が 0 行だった分) |
| 24 | ログインが判定の前 (作成から 15 秒以内) に終わる (乗っ取りの直後のログアウトを含む) | 行 1〜6 のどれか → 行 9〜13・16 のどれか | INSERT → DELETE | created → deleted | 行 1〜6 と同じ | ended (`signed_out` など)・`pending` のまま。worker が取り置いて判定し、送るべきならメール (§10 の ended の行・S-29) |
| 25 | パスワードの無い利用者 (Google / Apple だけ) の再設定 | `POST /api/auth/password/reset` (Web / モバイル) → 画面の全端末のログアウト | 行 13 と同じ | `auth.users` の password_changed (`encrypted_password` が空 → bcrypt) + deleted | route + 画面 | `password_history` +1 (最初の 1 行。S-28)。`auth_password_check` は `no_password` を返さない (§11.5) |
| 26 | 再設定のリンク (Web・PKCE。いまの既定) | `resetPasswordForEmail` → GoTrue の `GET /verify` (PKCE の枝。セッションは作らず code を返す) → `/auth/reset-password?code=…` を browser の client (`@supabase/ssr` の `detectSessionInUrl`) が交換 (`/token?grant_type=pkce`) | INSERT (ブラウザが GoTrue を直接呼ぶ: UA / IP は利用者の実値) | created | 無し (route を通らないので `recordWebLoginContext` は呼ばれない。§7.2 ① の走査の対象外) | `auth`・実 IP / UA・国は無し・`pending`。`amr` `recovery` (S-14) |
| 27 | 再設定のリンク (モバイル・implicit。いまの既定) | アプリの `resetPasswordForEmail` (`redirectTo` = `/auth/reset-password`。`forgot-password.tsx:36`) → メールのリンクを開いたブラウザ → GoTrue の `GET /verify` (implicit の枝) → `homegohan://auth/reset-password#access_token=…` → `apps/mobile/app/(auth)/auth/reset-password.tsx:48` の `setSession` | INSERT (GoTrue の `GET /verify` の時点。UA / IP はリンクを開いたブラウザのもの。アプリの `setSession` は保管するだけで変化なし) | created | `PATCH sessions/current` (`setSession` の SIGNED_IN → `registerDeviceName`) | `mobile`・端末名・端末の種類はリンクを開いたブラウザのもの (例: iPhone の Safari)・`pending`。`amr` `otp` (S-27)。その種類が履歴に無ければ、本人の再設定でも通知が 1 通 (§10.1) |
| 28 | 再設定のリンク (モバイル・code) | `apps/mobile/app/(auth)/auth/reset-password.tsx:45` の `exchangeCodeForSession` | いまは変化なし (モバイルの client は implicit で `code_verifier` を保管しないので、GoTrue の `/token?grant_type=pkce` が交換を断る §3)。client を PKCE にしたときは INSERT (端末の UA) | 交換できたときだけ created | 交換できたときだけ `PATCH sessions/current` | 交換できたときは 2 と同じ・`amr` `recovery` |
| 29 | browser の client の `setSession` (Web) | `src/hooks/useHomeData.ts:160` (`/api/auth/session-sync` の応答の `accessToken` / `refreshToken` を渡す) | 変化なし (応答に token は無い (`session-sync/route.ts:47`) ので `undefined` が渡り、auth-js は GoTrue を呼ばずに `AuthSessionMissingError` を返す) | — | 無し | 行は変わらない (INSERT しない) |
| 30 | パスワード変更の前の再認証 (段 C のマージまでの間だけ) | `src/app/(main)/settings/account/page.tsx:125` (browser) / `apps/mobile/src/lib/account-credentials.ts:59` (端末) の `signInWithPassword` | INSERT (browser / 端末が GoTrue を直接呼ぶ: UA / IP は実値) | created | 無し (Web は route を通らない。モバイルは SIGNED_IN で `PATCH sessions/current`) | 行 1・2 と同じく 1 ログイン (同じ端末なので多くは `known`)。続く `PUT /user` が前のセッションを消す (行 12)。段 C (§0.2) で画面が API に替わり、この経路は無くなる |
| 31 | パスワード変更 (アプリを通らない) | GoTrue の `PUT /auth/v1/user` を直接 (access token + 公開の anon キー。盗んだセッションを含む S-33) | DELETE × 他 (GoTrue) | deleted + `auth.users` の password_changed | 無し (本書の API を通らないので照合も再設定の認可も無い §7.1) | 他は `signed_out`。`password_history` +1 (記録は漏れない)。GoTrue の `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` が ON なら、再設定のセッションでないときは `current_password` が要る (§3・§24) |
| 32 | 通知の判定の前に、作成から 24 時間 (`LOGIN_ALERT_MAX_AGE_HOURS`) を過ぎる (段 A のデプロイから段 B の worker まで §0.2・Vercel Cron の停止) | worker の取り置き (`claim_login_alerts` の 1 つ目の文 §11.4) | 変化なし | — | 無し | `done`・`alert_claimed_at` NULL・印 (`device_family`・`is_new_*`) と `alert_sent_at` は NULL (送らない。§10 の期限切れの行・S-34) |
| 33 | ロールバック (§11.7) の後に、もう一度 migration を流す | 運営 (保守) | 変化なし | (本体が戻る) | 無し | 残っていた行は列の既定で `done` (通知の対象に戻らない)。戻った後のログインは行 1〜6 と同じ `pending` (S-35) |
| 34 | メールアドレス変更の申し込み | Web `src/app/(main)/settings/account/page.tsx:299` / モバイル `apps/mobile/src/lib/account-credentials.ts:98` の `updateUser({ email }, { emailRedirectTo })` (GoTrue の `PUT /auth/v1/user`。origin/main 5ff68e67。本書は変えない §0.3) | 変化なし (確認のメールを送るだけで、セッションの行は作らない・消さない) | — (`auth.users` の UPDATE で `on_auth_user_password_changed` が動いても、`encrypted_password` が前と同じなので `password_history_record` は行を足さない §11.3) | 無し | 行は変わらない。確認のリンクを開いたときのセッションは行 5 (§20.3 の結合テストの updateUser({ email }) の it) |
| 35 | 盗んだ refresh token で GoTrue の `/token?grant_type=refresh_token` を直接 | 攻撃者 (anon キー + 本人の端末から盗んだ refresh token。S-36) | UPDATE `refreshed_at` (UA / IP は攻撃者の値で上書きされる。INSERT はしない §3) | refreshed | 無し | `last_active_at` だけ (行 7 と同じ)。`user_agent` / `ip_address` / 端末の種類・通知の状態は変わらず、通知は無い (待ちの行を作るのは INSERT のトリガーだけ §10。限界 §25 Q-21) |
| 36 | MFA の回復 (cross/12 §14.5) | `POST /api/auth/mfa/recover` (本人の access token で `admin.signOut(token, 'global')`) | DELETE × 全部 (GoTrue) | deleted | — | `signed_out` |
| 37 | 運営による MFA の解除 (cross/12 §14.7・§11.5) | `POST /api/super-admin/admins/{id}/mfa/reset` (service_role の RPC `operator_mfa_end_sessions`) | DELETE × 全部 (SQL) | deleted | — | `signed_out` (トリガー `on_auth_session_deleted` が書く。`ended_reason` の値は増やさない cross/12 Q-18) |
| 38 | 本人による MFA の解除 (cross/12 §14.4・S-9) | `DELETE /api/auth/mfa/factors/{id}` (本人の Cookie のセッション。`mfa.unenroll` → `deleteBackupCodes` → `refreshSession()` `route.ts:98`) | GoTrue の unenroll は factor を消し、その factor で aal2 に上がったセッションを UPDATE (`aal` = `aal1`・`factor_id` = NULL。`refreshed_at` は書かない。supabase/auth の `UnenrollFactor` → `DowngradeSessionsToAAL1` → `updateFactorAssociatedSessions`)。DELETE はしない。続く `refreshSession()` が行 7 と同じ UPDATE `refreshed_at` (コードの削除に失敗した回は呼ばない) | unenroll の UPDATE では動かない (`on_auth_session_refreshed` は `AFTER UPDATE OF refreshed_at` §11.3)。refresh で refreshed | 無し | セッションは終わらない (`revoked_at` は付かない)。refresh の分だけ `last_active_at` (行 7 と同じ)。通知の状態は変わらない |

## 9. ② 状態比較表 (現行 vs 設計後)

| 面 | 現行 (origin/main) | 設計後 |
|---|---|---|
| ログインの記録 | 無し (`user_sessions_metadata` 0 行。cross/01 §3.2 の INSERT は未実装) | `auth.sessions` のトリガーが全経路を記録 (§11.3) |
| `user_profiles.last_login_at` / `login_count` | 誰も書かない (運営の画面は `-`) | `auth.sessions` の INSERT トリガーが書く。プロフィールの行がまだ無い (新規登録の直後の) ログインは、行を作るときの BEFORE INSERT トリガーが記録から入れる |
| 不審なログインの通知 | 無し | 新しい端末の種類 / 国でメール (§12.3・§18)。端末の種類が分からないログイン (不明な端末) は、前にもあっても新しい端末として知らせる (§10.1・S-4・S-32)。判定の前に終わったログインも判定して知らせる (§10・S-29)。メールの「端末」は UA から決まる言葉だけ (利用者が書ける端末名は載せない §7.1)。作成から 24 時間を過ぎた待ちの行は送らない (段の切り替え・worker の停止の間に溜まった行 §11.4・S-34)。待ちの行を作るのはトリガーだけ (列の既定は `done` §11.1・S-35)。盗んだ refresh token の使用 (同じ行の更新。新しいセッションを作らない) は知らせない (§8 の行 35・S-36・§25 Q-21) |
| セッションの一覧 | 無し | `/settings/security/sessions` (Web)・`settings/sessions` (モバイル)・`GET /api/auth/sessions`。見出しは UA から決まる言葉 (`device_label`)、アプリが登録した端末名 (`device_name`。英数字・空白・`()._,+-` だけ) は「端末名: …」として添える |
| 個別の失効 | 無し (`signOut()` の global だけ) | `DELETE /api/auth/sessions/{id}` → RPC |
| 他の端末のログアウト | パスワード変更の副作用だけ | `POST /api/auth/sessions/revoke-others` (Web / モバイル。本人の access token で GoTrue の `/logout?scope=others`) |
| 不審の判定の比べる相手 | — | 同じ利用者の前の行すべて (期間で絞らない) + アカウントの作成日時 (§10.1) |
| 放置されたセッション | 永久に残る (1,331 行) | 30 日で終える (pg_cron) |
| パスワード変更 (Web / モバイル) | browser / 端末が `signInWithPassword` → `updateUser` → `signOut({scope:'others'})` (Web は Turnstile つき) | `POST /api/auth/password/change` (現在のパスワードは DB で確認・履歴の照合・更新は本人の access token で `PUT /auth/v1/user` (`current_password` も渡す §13.7)。他の端末の失効は GoTrue が同じ更新の中で行う。Turnstile は要らない)。成功の表示は常に「この端末以外のログインはすべて解除しました」(「他の端末のログアウトを確認できませんでした」の注意書きは無くなる)。照合が効くのはこの API の経路だけで、access token で GoTrue の `PUT /auth/v1/user` を直接呼ぶ経路 (いまも同じ) は照合を通らず、現在のパスワードも GoTrue の設定 `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` が ON のときだけ求められる (§24・S-33。変わらない点) |
| パスワード再設定 | 画面が `updateUser` → 全端末のログアウト。プロフィールの行の有無・パスワードの有無に依らず動く (パスワードの無い利用者は最初のパスワードを作れる) | 画面が `POST /api/auth/password/reset` (`amr` の `recovery` / `otp` の確認・履歴の照合) → 今までどおり全端末のログアウト。プロフィールの行が無い利用者 (`requireSessionUser` §12.4・S-30) と、パスワードの無い利用者 (Google / Apple だけ。`auth_password_check` は再設定では `no_password` を返さない §11.5・S-28) も今までどおり通る。bcrypt でない形のハッシュの利用者も再設定は通る (変更は 409)。`amr` の確認と照合はこの API の経路だけで、GoTrue の `PUT /auth/v1/user` を直接呼ぶ経路は通らない (§24・S-33。変わらない点) |
| `password_history` | 0 行 (stub) | トリガーで全経路を記録。既存 195 人分は migration で写す |
| 運営の利用者詳細 | 最終ログインの 1 列 | 1 列 + ログイン履歴の節 (admin / super_admin。監査つき) |
| `user_profiles.last_login_at` / `login_count` を読む既存の運営の画面・一覧・候補 (§3・§21.4) | 全員 NULL (`login_count` は列の既定の 0): 利用者一覧の「最終ログインがこの日より前」の絞り込みは 0 件 (NULL は `.lt` に入らない)、`sort=last_login` は順が付かない、メンバー移譲の候補は最終ログインの順にならず「最終ログイン: -」、admin の利用者詳細の「最終ログイン」は `-`、support の利用者詳細は Web が「0回」・モバイルが回数 0 と最終ログイン `-` (モバイルのネイティブの support の画面は 2026-10-16 に削除した。#1598)。Web の support の一覧の「最終ログイン」は `-` (値が NULL。一覧が読む鍵は #1717 で直った §3) | コードは変えない。移行の後にログインした利用者から値が入り、絞り込み・並べ替え・候補の順が効き始め、admin / support の利用者詳細に最終ログインの日時と回数 (移行の後のログインの数。移行の前のログインは数えない) が出る。Web の support の一覧の「最終ログイン」にも日時が出る (§21.4・§25 Q-22)。移行の後にまだログインしていない利用者は NULL のまま (§11.2 は `user_profiles` の 2 列を写さない): 絞り込みに入らず、`sort=last_login` の降順では先頭 (PostgreSQL の既定で DESC は NULL が先)、候補では末尾 (`nullsFirst: false`)。非活動の一覧と判定は `auth.users.last_sign_in_at` を見るので変わらない |
| 利用者の API の認証 | — (新しい API) | `requireSessionUser` (§12.4)。`user_profiles` の行が無くても通る (行があれば凍結を見る)。`requireUser` は使わない (行が無いと 401 §3) |
| `sessions_revoke_self` (本人の UPDATE ポリシー) | ある (本人が印・終了を直接書ける) | 消す。本人は SELECT だけ。書くのは service_role・RPC・トリガー |
| `secure_password_change` 前提 | 直前の `signInWithPassword` で回避 | OFF を前提 (§24)。ON なら 403 `AUTH_REAUTHENTICATION_REQUIRED` (ログインし直し) |
| GoTrue の `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` | OFF (既定)。ON にすると、いまの画面 (`current_password` を渡さない `updateUser`) の変更が 400 になる | OFF のまま。ON にしても本書の API は動く (変更は `current_password` を渡し、再設定のセッションは GoTrue が免除する §13.7)。ON にするかは §24・Q-18 |
| cross/12 (MFA) との関係 | — | 独立。verify の他セッション失効・回復・運営による解除の全セッションの終了は `signed_out` として記録される (§8 の行 16・36・37)。本人による解除はセッションを終えず、続く refresh が `last_active_at` を進めるだけ (§8 の行 38)。cross/12 は段 A〜C がマージ済みで、`SessionClaimsSchema` の 2 重定義は寄せない (§25 Q-5) |
| 不審なログインの通知メールの送信 (v1.8) | v1.7 まで: `sendEmail` が Resend を呼んで届け、`ok: false` なら `alert_sent_at` NULL (届かなかった)。origin/main には段 B の worker はまだ無い | `sendEmail` は送信待ち `email_outbox` に登録するだけ。`alert_sent_at` = 登録した日時 (`ok: true`)。登録できなかった (`ok: false`: `suppressed`・`not_configured`・`invalid_envelope`・`outbox_failed`) は NULL で `done`・再送しない。配信・再試行・dead・運用メールは送信待ちの仕組み (operator/10 §7.3・§8)。再送の画面と API (§9.2) は operator/10 の段 C で、origin/main には無い (段 C の前は dead の通知を再送できない)。dead は通知の状態に書き戻さない (§7.1・§10.2) |
| 通知メールの行の退会時の伏せ字・`user_id` (v1.8) | — | worker が `userId: row.user_id` を渡す (`email_outbox.user_id`)。退会で queued は dead `recipient_deleted`・伏せ字 (S-40)。送信待ちの画面 (operator/10 の段 C) の一覧では `user_id` の列に出る (利用者での絞り込みは無い) |
| 通知メールの秘密の宣言 `contains_secret` (v1.8) | — | 書かない (秘密なし。`redactAfterSend` も渡さない)。dead の行は伏せられず、operator/10 の段 C の後は再送できる (S-37)。`secret-templates.test.ts` の `PUBLIC_TEMPLATES` に載せる (§22 N-40) |
| worker の件数・cron の応答 (v1.8) | — | `{ claimed, queued, skipped, failed }` (`queued` = 送信待ちに登録し、`finish` で記録まで済んだ行の数。登録の後に `finish` が例外になった行は `failed` だけ §13.4 の 5。v1.7 の `notified` を改名) |

## 10. ③ 状態遷移表

`user_sessions_metadata` の 1 行。状態は 2 つの軸の組: 終わったか (`live` = `revoked_at IS NULL` / `ended` = `revoked_at IS NOT NULL`) と、通知の進み (`alert_status`)。`alert_status` は `pending → processing → done` と進み、戻るのは例外の戻し (`processing → pending`) だけ。`pending` と取り直しの `processing` は、作成から `LOGIN_ALERT_MAX_AGE_HOURS` (24 時間) を過ぎると、判定をせずに `done` に進む (期限切れ。送らない §11.4)。`pending` で行を作るのはトリガー `auth_session_created` だけで、列の既定は `done` (§11.1)。2 つの軸は独立に進む: 通知の取り置き・完了・戻しは `revoked_at` を見ず (ended の行も同じ遷移)、終了 (DELETE・失効・照合) は `alert_status` を変えない。通知メールの行 (`email_outbox`。queued → sent / dead) は、この表の行と独立に進み、この表の列を変えない (§10.2)。

| 状態 (live / alert) | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| (無し) | `auth.sessions` INSERT | live / pending (トリガーが `'pending'` を明示する) | `ON CONFLICT (session_id) DO NOTHING` | `user_profiles.last_login_at` / `login_count` (プロフィールの行があるときだけ。無ければ 0 行の更新で、行を作るときに入る。下の注) |
| (無し) | `auth.sessions` INSERT で、トリガーの本体が失敗 (S-20) | (無し) (行は作られない) | — | WARNING だけ。ログインは成功 (R-13)。行は後からも作られない (照合 `reconcile` は live の行を終えるだけ) ので、このログインは記録・通知されない (記録は best-effort) |
| (無し) | migration の写し (既存の 1,331 行) | live / done | 既存の行だけ | 通知はしない (`is_new_*` NULL) |
| 列の無い行 (ロールバック §11.7 の後に残った行) | migration をもう一度流す (§11.1 の `ADD COLUMN IF NOT EXISTS alert_status … DEFAULT 'done'`) | live / done または ended / done (`revoked_at` はそのまま) | 列がまだ無いときだけ (列があれば何も変えない) | 通知はしない (`is_new_*` NULL)。S-35 |
| live / pending | Web route の `recordWebLoginContextFromRequest` → `recordWebLoginContext` (§13.5) | live / pending | `context_source='auth'` かつ `alert_status='pending'` の行だけ上書き (mobile の端末名は消さない。判定の後の行は変えない) | `ip_address` / `ip_network` / `user_agent` / `country_code` / `context_source='web'`。戻り値 `true` |
| ended / pending | 同上 (route の書き込みが、セッションの終了の後に届く: 同じ瞬間に他の端末のパスワード変更・`revoke-others`・全端末のログアウト・失効で行が消えた。S-29 と同じく `revoked_at` を見ない) | ended / pending | live / pending の行と同じ (`revoked_at` は見ない) | live / pending の行と同じ。worker は上書きの後の UA で判定する |
| live / processing・live / done・ended / processing・ended / done | 同上 (route の書き込みが、worker の取り置き (作成から `LOGIN_ALERT_MIN_AGE_SECONDS` = 15 秒の後) か、判定の完了より後に届く) | 同じ (変えない) | `alert_status='pending'` に合わないので UPDATE は 0 行 | 戻り値 `false` → `recordWebLoginContextFromRequest` が warn (`stage: 'record'`) を 1 回。行は `context_source='auth'`・UA `node` のままで、worker はその値 (不明な端末) で判定する / した (S-32 と同じ結果。取り置いた値で判定した行の `user_agent` と、`finishLoginAlert` が書く `device_family` が食い違わない) |
| (無し) | 同上 (トリガーの本体が失敗して行が無い S-20) | (無し) | 行が無いので UPDATE は 0 行 | 戻り値 `false` → warn (`stage: 'record'`) を 1 回。ログインは成功のまま |
| live / * | `PATCH sessions/current` | 同じ | 本人の `session_id` の行 (終わったセッションの JWT は `requireSessionUser` の `getUser` が 401 にする)・`device_name` は `DEVICE_NAME_PATTERN` の文字だけ (§12.5。合わなければ 400 で何も変えない) | `device_name` / `context_source='mobile'` |
| live / pending | worker の取り置き (RPC `claim_login_alerts` §11.4) | live / processing | `created_at <= now - 15 s`・`created_at >= now - 24 時間` (`LOGIN_ALERT_MAX_AGE_HOURS`)・`alert_status='pending'`。`revoked_at` は見ない。古い順に 100 行まで (下の取り直しの行と合わせて)。`FOR UPDATE SKIP LOCKED` (ほかの worker がロック中の行は取らない) | `alert_claimed_at = now` |
| live / processing | worker の取り置き (取り直し。関数が途中で死んだ行) | live / processing | `alert_claimed_at < now - 10 分` (ほかは上の行と同じ) | `alert_claimed_at = now`。送信待ちへの登録の後・`finish` の前に死んだ行は、この取り直しでもう一度登録する (`email_outbox` に同じ `idempotency_key` の行が増える。`alert_attempts` は増えない §10.2 #12・S-44) |
| live / processing | 判定 → 送信 (必要なら。= `sendEmail` で送信待ちに登録) → `finishLoginAlert` | live / done | — | `device_family` / `is_new_*` / `alert_sent_at` (送信待ちに登録できたとき = `sendEmail` の `ok: true`。届いたかは見ない v1.8 §10.2) |
| live / processing | 例外 → RPC `release_login_alert` (§11.4) | live / pending (`alert_attempts + 1`) または done (`alert_attempts + 1 >= 3`) | `alert_status = 'processing'` の行だけ (ほかは変えない) | `alert_claimed_at = NULL`・ログ。`device_family`・`is_new_*`・`alert_sent_at` は書かない: 送信待ちへの登録 (`ok: true`) の後に `finish` が 3 回続けて例外になった行は、登録したまま `alert_sent_at` NULL で done (§10.2 #11・S-43) |
| ended / pending | worker の取り置き (同じ RPC) | ended / processing | live / pending の行と同じ (`revoked_at` を見ない)。この状態に来るのは、作成から 15 秒以内に終わったログイン (S-29・§8 の行 24)、パスワードの変更・再設定・MFA で GoTrue が消した他の端末の `pending` の行 (§8 の行 12・13・16)、取り置きの前に失効・放置の終了・照合で終わった行 | `alert_claimed_at = now` |
| ended / processing | worker の取り置き (取り直し) | ended / processing | live / processing の取り直しの行と同じ | `alert_claimed_at = now` |
| ended / processing | 判定 → 送信 (必要なら) → `finishLoginAlert` | ended / done | — (判定・メールの文は live の行と同じ。終わったログインにも知らせる §7.1) | live / processing の完了の行と同じ |
| ended / processing | 例外 → RPC `release_login_alert` | ended / pending (`alert_attempts + 1`) または ended / done (`alert_attempts + 1 >= 3`) | live / processing の戻しの行と同じ | 同じ |
| live / pending | worker の取り置きの期限切れ (同じ RPC の 1 つ目の文 §11.4) | live / done | `created_at < now - 24 時間`・`alert_status='pending'`。`revoked_at` は見ない。件数の上限は無い。`FOR UPDATE SKIP LOCKED` | 送らない。`alert_claimed_at = NULL`。`device_family`・`is_new_*`・`alert_sent_at` は NULL のまま (判定していない)。段 A のデプロイから段 B の worker までの行 (§0.2・S-34) と、worker が止まっていた間の行がここに来る |
| live / processing | 期限切れ (取り直しの行。同じ文) | live / done | `created_at < now - 24 時間`・`alert_claimed_at < now - 10 分` | 上の行と同じ (途中で死に続ける行の取り直しも 24 時間で終わる) |
| ended / pending・ended / processing (取り直し) | 期限切れ (同じ文) | ended / done | live の 2 行と同じ | 上の行と同じ |
| live / * | `auth.sessions` UPDATE `refreshed_at` | 同じ | — | `last_active_at` |
| live / * | `auth.sessions` DELETE (ログアウト・GoTrue の失効・MFA) | ended (`signed_out`) / 同じ | `ended_reason` が未設定のときだけ `signed_out` | `revoked_at = now` |
| live / * | `auth.sessions` UPDATE `refreshed_at` / DELETE で、トリガーの本体が失敗 (S-20) | 同じ (本体の UPDATE は巻き戻る) | — | WARNING だけ。refresh・ログアウトは成功 (R-13)。DELETE の取り残し (live のまま・`auth.sessions` に行が無い) は、下の `reconcile_user_sessions_metadata` の行が ended (`signed_out`) に揃える |
| live / * | RPC `auth_session_revoke` | ended (`revoked_by_user`) / 同じ | `user_id = auth.uid()`・`session_id ≠ auth.jwt()->>'session_id'` | DELETE → 上の行 |
| live / * | `expire_idle_auth_sessions` | ended (`idle_expired`) / 同じ | `COALESCE(refreshed_at, created_at) < now - 30 日` | DELETE → 上の行 |
| live / * | `reconcile_user_sessions_metadata` | ended (`signed_out`) / 同じ | `auth.sessions` に行が無い | `revoked_at = now` |
| ended / * | `cleanup_ended_user_sessions_metadata` | (消える) | `revoked_at < now - 90 日` | — |
| * | `auth.users` DELETE | (消える) | FK CASCADE | — |

`password_history`: (無し) → `auth.users` INSERT / UPDATE OF `encrypted_password` (NULL・空でない・前と違う。空 → bcrypt の最初のパスワード (S-28) も含む) → 行 +1 → 同じ利用者の行が 10 を超えたら古い順に消える → `auth.users` DELETE で CASCADE。

`user_profiles.last_login_at` / `login_count`: (プロフィールの行が無い) → 行の INSERT (同意・初期設定・招待の承諾。§8 の行 23) → BEFORE INSERT `trg_user_profiles_fill_login_stats` が、`last_login_at` が NULL の行にだけ、同じ利用者の `user_sessions_metadata` の行数と最新の `created_at` を入れる (記録が 0 行なら変えない) → 以後は `auth.sessions` の INSERT ごとに `last_login_at` = その `created_at`・`login_count + 1`。

### 10.1 worker の判定の入力 × 結果 (`decideLoginAlert` の全パターン)

prior = `listPriorLogins` が返す、同じ利用者の `created_at < row.created_at` の行 (live・終わった行の両方。期間では絞らない。自分の行は含めない)。アカウントの年齢 = worker の `now()` − `auth.users.created_at`。保持 = `LOGIN_HISTORY_RETENTION_DAYS` (90 日)。不明な端末 = `deviceFamilyOf` が `other/server` (`node`・`undici` などのサーバーの UA。§12.1 の `SERVER_DEVICE_FAMILY_KEY`) か `other/other` (空・読めない UA。`UNKNOWN_DEVICE_FAMILY_KEY`) を返す種類で、一覧・メールの言葉はどちらも「不明な端末」。不明な端末は端末を表さないので、prior に同じ値があっても既知にしない (§7.1)。

| # | prior | アカウントの年齢 | current の端末の種類 | 国・IP の範囲 | reason | `isNewDevice` / `isNewIp` / `isNewCountry` | 送る |
|---|---|---|---|---|---|---|---|
| 1 | 空 | ≤ 保持 | 何でも | 何でも | `first_login` | false / false / false | 送らない (S-1) |
| 2 | 空 | > 保持 | 不明な端末でない | 何でも | `history_expired` | true / (`ip_network` があれば true) / false | 送る (S-26) |
| 3 | 空 | > 保持 | 不明な端末 | 何でも | `history_expired` | true / (同上) / false | 送る (端末: 不明な端末。比べる相手が無く、端末も分からない) |
| 4 | 1 件以上 (90 日より前に作られた live の行を含む) | 問わない | 不明な端末でなく、prior に同じ種類がある | 国が同じか、国の分かる prior が無い、または current の国が不明。IP の範囲は既知 | `known` | false / false / false | 送らない (S-5) |
| 5 | 1 件以上 (同上) | 問わない | prior に無い種類、または不明な端末 (prior に同じ不明な種類があっても) | 行 4 と同じ | `new_device` | true / * / false | 送る (S-2・S-3・S-4・S-25・S-32) |
| 6 | 1 件以上 | 問わない | 既知 (行 4 と同じ) | 国の分かる prior があり、current の国がそのどれとも違う | `new_country` | false / * / true | 送る |
| 7 | 1 件以上 | 問わない | 行 5 と同じ (prior に無い種類、または不明な端末) | 行 6 と同じ | `new_device_and_country` | true / * / true | 送る |
| 8 | 1 件以上 | 問わない | 既知 | 国は行 4 と同じ。IP の範囲だけが prior に無い | `known` | false / true / false | 送らない (記録のみ §7.1) |

`*` = IP の範囲の新旧で変わる (送るかどうかには効かない)。行 1 が「初めて」と断定できる理由: 終わった行が消えるのは `revoked_at < now − 90 日` のときだけ (§11.6) で、`revoked_at ≥ created_at ≥ auth.users.created_at` なので、アカウントの年齢が 90 日以下なら消えた行は 1 つも無い。live の行は保持で消えない (利用者の削除の CASCADE だけ)。行 2・3 は「作成から 90 日を過ぎてから初めてログインした」利用者にも当たり、その人には本人のログインでメールが 1 通届く (§25 Q-13)。行 5 の不明な端末は、Web の文脈の記録に失敗した本人のログイン (S-32) にも当たり、本人に「不明な端末」のメールが 1 通届く (送る側に倒す §7.1)。

### 10.2 通知メールの行 (`email_outbox`) × 通知の状態 (v1.8)

`finishLoginAlert` の後、通知メールの行は送信待ちの仕組み (operator/10 §7.3) の中で進む。どの出来事でも本書の行 (`user_sessions_metadata`) の `alert_sent_at`・`alert_status` は変わらない (書き戻さない §7.1)。`alert_sent_at` が NULL なのは「送信待ちに登録した記録が無い」ことで、登録しなかったことまでは言わない: 登録の後の記録 (`finish`) が 3 回続けて失敗した行 (#11) と、登録の後に関数が止まり続けて期限切れになった行 (#12) は、送信待ちに行があり本人に届いても NULL のまま。登録と配信の正本は `email_outbox` の行 (`idempotency_key` = `login-alert:<session_id>`) で、#10〜#12 の重複の行も DB の上では同じキーで引ける。運営の画面で引けるとは言わない: 送信待ちの画面と API (`/super-admin/email-outbox`・operator/10 §9.2) は operator/10 の段 C で origin/main には無く (§3)、入った後も一覧の絞り込みは `status`・`template`・`cursor`・`limit` だけで、`idempotency_key` は返さず、`user_id` は列として出すだけ。通知の行は `template` = `login_new_device` で絞り、`created_at` と `user_id` の列で見分ける (足りるかは Q-26)。段 C の前は、dead の通知は運用メールの件数 (#8) が出るだけで、アプリから再送できない。「worker の件数」の列は `finish` が戻った後に数える値で (§13.4 の 5)、`finish` が例外になった回は、どの行でも `failed` だけに数える (`queued`・`skipped` には数えない。#5・#10・#11)。

| # | `sendEmail` の戻り / 送信待ちの行の出来事 | `email_outbox` の行 | `alert_sent_at` | `alert_status` | worker の件数 | 運用への知らせ | 本人に届くか |
|---|---|---|---|---|---|---|---|
| 1 | `ok: true` (登録できた) | queued (`idempotency_key` = `login-alert:<session_id>`・`user_id` = 本人・`redact_after_send` false) | 登録した日時 | done | `queued` | — | 送信待ちの worker が送る (S-2) |
| 2 | `ok: false` / `suppressed` (登録時の停止リスト。引けなかったときは #13) | dead `suppressed` (best-effort。無いこともある) | NULL | done | `skipped` | 数えない | 届かない (S-18) |
| 3 | `ok: false` / `not_configured` (`skipped: true`) | 無し | NULL | done | `skipped` | app_logs の warn だけ | 届かない (S-38) |
| 4 | `ok: false` / `invalid_envelope` | 無し | NULL | done | `skipped` | app_logs の error | 届かない (文面のバグ。`login-new-device.test.ts` の「EmailEnvelopeSchema を通る」の it が見張る。S-42) |
| 5 | `ok: false` / `outbox_failed` (登録の失敗) | 無し | NULL | done | `skipped` (続く `finish` が例外なら、その回は `failed` だけ) | app_logs の error | 届かない (S-41)。続く `finish` も失敗すれば例外 → `release` → 取り直し (最大 `LOGIN_ALERT_MAX_ATTEMPTS` 回) |
| 6 | 1 の後、送信待ちの worker が送れた | sent (`sent_at`。7 日で消える) | 変わらない | 変わらない | — | — | 届く |
| 7 | 1 の後、一時的な失敗 (429 / 5xx / 通信) | queued (`attempts` + 1・`next_attempt_at`) | 変わらない | 変わらない | — | — | 待てば届く (最大 6 回・約 5.4 時間) |
| 8 | 1 の後、dead (4xx・回数切れ・作成から 7 日の `expired`・送る直前の停止リスト) | dead (`last_error_code`。30 日で消える) | 変わらない (書き戻さない) | 変わらない | — | `ops_email_dead_letter` に件数 (1 件から。`expired`・Resend のコードは数える。`suppressed` は数えない) | 届かない。段 C の前: アプリに再送の経路が無く、届かないまま (運用メールの件数だけ。RPC `requeue_email_outbox` は `service_role` だけ §3)。段 C の後: super_admin が画面から再送すれば (`requeue_email_outbox`。伏せていないので 'redacted' にならない) 届く (S-37) |
| 9 | 1 の後、本人が退会 | dead `recipient_deleted`・宛先・件名・本文は伏せ字 (`prepare_account_deletion` の 1b) | (行ごと CASCADE で消える) | (同左) | — | 数えない | 届かない (S-40) |
| 10 | 1 の後に `finish` が例外 → 取り直し → もう一度 1 (S-39) | 2 行 (同じ `idempotency_key`) | 2 回目の登録の日時 | done | 1 回目の回は `failed` だけ (`queued` に数えない) + 取り直しの回の `queued` | — | 1 通 |
| 11 | 1 の後に `finish` が例外、を `LOGIN_ALERT_MAX_ATTEMPTS` (3) 回続ける (S-43) | 3 行 (同じ `idempotency_key`。どれも queued から 6〜9 の行と同じに進む) | NULL (登録したが記録できなかった) | done (3 回目の `release`) | 回ごとに `failed` だけ × 3 (`queued` には 1 度も数えない) | — | 1 通 (Resend が同じキーを 24 時間覚える operator/10 S-06) |
| 12 | 1 の後・`finish` の前に関数が止まる → 10 分後に取り直し → もう一度 1 (S-44) | 2 行 (同じ `idempotency_key`)。止まり続ければ 10 分ごとに 1 行ずつ増える | 2 回目の登録の日時。止まり続けて作成から 24 時間の期限切れになれば NULL | done (`finish`、または期限切れ) | 止まった回は応答が無い (件数は残らない) + 取り直しの回の `queued` | — | 1 通 (最後の行の配信が 1 行目から 24 時間を過ぎたときだけ 2 通目になりうる) |
| 13 | `ok: true` (登録時に停止リストを引けなかった: `lookup_failed`。確かめずに登録) (S-45) | queued (1 と同じ) | 登録した日時 | done | `queued` | app_logs の warn (登録時。送る直前にも引けなければもう 1 回) | 送信待ちの worker が送る直前にもう一度引く: 載っていなければ 6 (届く)・載っていれば 8 の dead `suppressed` (届かない。運用メールは数えない。`alert_sent_at` は登録した日時のまま)・そこでも引けなければ確かめずに送る (停止リストに載った宛先にも届きうる。operator/10 の既定で本書は変えない) |

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
  ADD COLUMN IF NOT EXISTS alert_status   text NOT NULL DEFAULT 'done',
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
COMMENT ON COLUMN public.user_sessions_metadata.alert_status IS '不審なログインの通知の進み (pending → processing → done)。pending で作るのはトリガー auth_session_created だけ。既定の done は、列を足した時点の行 (ロールバックの後にもう一度流したときに残っていた行) とトリガー以外が作る行を、通知の対象にしないため。cross/16 §10・§11.4';

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

2 行の目印 (`-- [cross16-backfill:begin]` / `-- [cross16-backfill:end]`) はそのまま migration に書く。結合テスト (§20.3) が、この 2 行の間を切り出して 2 回流し、冪等を確かめる。

```sql
-- [cross16-backfill:begin]
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
-- [cross16-backfill:end]
```

### 11.3 トリガー関数 5 本 (`auth` の表の 4 本は SECURITY DEFINER・所有者 postgres。`user_profiles` の 1 本は SECURITY INVOKER。どれも `search_path = ''`・失敗は握る) とトリガー 5 本 (`auth` の表の 4 本は、同じ名前が無いときだけ作る)

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

-- トリガー (auth の表に足すのはトリガーだけ。表・列は変えない)。auth.sessions / auth.users の所有者は supabase_auth_admin で、
-- postgres は TRIGGER の権限で CREATE TRIGGER はできるが、DROP TRIGGER はできない (表の所有者だけ。IF EXISTS でも、トリガーが
-- あると所有者の確認で失敗する §3)。よって DROP TRIGGER を書かず、同じ名前のトリガーが無いときだけ作る (2 回目の適用・ロールバック
-- の後の適用では作らない。本体は上の CREATE OR REPLACE FUNCTION が入れ替える。トリガーの定義 (時機・列・WHEN) を変えたくなったら、
-- 同じ名前は使えないので新しい名前で作る)。2 行の目印の間は結合テスト (§20.3) が切り出してもう一度流す
-- [cross16-auth-triggers:begin]
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.sessions'::regclass AND t.tgname = 'on_auth_session_created') THEN
    CREATE TRIGGER on_auth_session_created AFTER INSERT ON auth.sessions
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_created();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.sessions'::regclass AND t.tgname = 'on_auth_session_refreshed') THEN
    CREATE TRIGGER on_auth_session_refreshed AFTER UPDATE OF refreshed_at ON auth.sessions
      FOR EACH ROW WHEN (OLD.refreshed_at IS DISTINCT FROM NEW.refreshed_at) EXECUTE FUNCTION public.auth_session_refreshed();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.sessions'::regclass AND t.tgname = 'on_auth_session_deleted') THEN
    CREATE TRIGGER on_auth_session_deleted AFTER DELETE ON auth.sessions
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_deleted();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'on_auth_user_password_changed') THEN
    CREATE TRIGGER on_auth_user_password_changed AFTER INSERT OR UPDATE OF encrypted_password ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.password_history_record();
  END IF;
END $$;
-- [cross16-auth-triggers:end]

-- 権限: 誰にも直接は実行させない (anon の番兵 §22 N-19)。トリガーとして動くときは EXECUTE を確かめられない (確かめるのは CREATE TRIGGER の時だけ。
-- migration 20261010000100 の注記と同じ)。auth の表の 4 本は、GoTrue の役割 (supabase_auth_admin) にだけ GRANT を明示しておく
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['auth_session_created', 'auth_session_refreshed', 'auth_session_deleted', 'password_history_record'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO supabase_auth_admin', fn);
  END LOOP;
END $$;

-- プロフィールの行を作るときに、それまでのログインを入れる (R-10・§8 の行 23)。新規登録の直後の最初のログインでは
-- user_profiles の行がまだ無く (行は同意 accept_legal_documents・モバイルの初期設定・招待の承諾が作る)、auth_session_created の
-- UPDATE が 0 行になるため。SECURITY INVOKER: 行を作るのは authenticated (本人の upsert。user_sessions_metadata の本人の行は
-- sessions_self で読める)・service_role・postgres (SECURITY DEFINER の RPC) で、どれも同じ利用者の行を読める。
-- 特権列ガード (trg_guard_user_profiles_privileged_on_insert) は last_login_at / login_count を見ないので、発火の順 (名前の順) に依らない
CREATE OR REPLACE FUNCTION public.user_profiles_fill_login_stats()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_last_login  timestamptz;
  v_login_count integer;
BEGIN
  -- 値を明示して作る行 (移行・テスト) は変えない
  IF NEW.last_login_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT max(m.created_at), count(*)::integer INTO v_last_login, v_login_count
    FROM public.user_sessions_metadata m
   WHERE m.user_id = NEW.id;
  IF v_login_count > 0 THEN
    NEW.last_login_at := v_last_login;
    NEW.login_count := GREATEST(COALESCE(NEW.login_count, 0), v_login_count);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 記録の失敗で同意・初期設定を止めない (R-13)
  RAISE WARNING 'user_profiles_fill_login_stats failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.user_profiles_fill_login_stats() FROM PUBLIC, anon, authenticated, service_role;
-- user_profiles の所有者は postgres (§3) なので、こちらは DROP TRIGGER IF EXISTS → CREATE で作り直せる
DROP TRIGGER IF EXISTS trg_user_profiles_fill_login_stats ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_fill_login_stats BEFORE INSERT ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.user_profiles_fill_login_stats();
COMMENT ON COLUMN public.user_profiles.last_login_at IS '最終ログイン日時。auth.sessions の INSERT のトリガー auth_session_created が書き、行がまだ無かった最初のログインは行を作るときのトリガー user_profiles_fill_login_stats が入れる (cross/16 §11.3)';
```

### 11.4 RPC `auth_session_revoke` (本人の 1 端末の失効) と、通知の取り置き・戻し (`claim_login_alerts`・`release_login_alert`)

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

worker (§13.3) の取り置きと戻し。呼ぶのは cron の route の service_role だけなので SECURITY INVOKER (service_role は表の権限を持ち RLS を通らない。`cleanup_ended_user_sessions_metadata` と同じ扱いで、§22 N-19 の決定表には足さない)。数 (100 行・15 秒・10 分・24 時間・3 回) は引数で受け、値は `constants.ts` (§12.1) が持つ。`claim_login_alerts` は 2 つの文で、1 つ目が作成から `p_max_age_hours` を過ぎた待ち・取り直しの行を送らずに `done` にし (期限切れ §10)、2 つ目がそれより新しい行を取り置いて返す (同じ関数の中なので `now()` は 2 つの文で同じ値 = 2 つの集合は重ならず、漏れも無い)。

```sql
CREATE OR REPLACE FUNCTION public.claim_login_alerts(
  p_batch_size integer, p_min_age_seconds integer, p_reclaim_minutes integer, p_max_age_hours integer)
RETURNS SETOF public.user_sessions_metadata
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_min_age_seconds IS NULL OR p_min_age_seconds < 0
     OR p_reclaim_minutes IS NULL OR p_reclaim_minutes < 1 OR p_max_age_hours IS NULL OR p_max_age_hours < 1 THEN
    RAISE EXCEPTION 'claim_login_alerts: argument out of range' USING ERRCODE = '22023';
  END IF;
  -- 1. 期限切れ: 作成から p_max_age_hours を過ぎた待ちの行 (と、取り直しの時機を過ぎた processing の行) は、送らずに done にする。
  --    段 A のデプロイから段 B の worker まで・worker が止まっていた間に溜まった行を、後からまとめて送らない (§10 の期限切れの行・S-34)。
  --    印 (device_family・is_new_*) と alert_sent_at は NULL のまま (判定していない)。ほかの worker がロック中の行は飛ばす
  WITH stale AS (
    SELECT m.session_id
      FROM public.user_sessions_metadata m
     WHERE m.created_at < pg_catalog.now() - pg_catalog.make_interval(hours => p_max_age_hours)
       AND (m.alert_status = 'pending'
            OR (m.alert_status = 'processing'
                AND m.alert_claimed_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_reclaim_minutes)))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.user_sessions_metadata m
     SET alert_status = 'done', alert_claimed_at = NULL
    FROM stale
   WHERE m.session_id = stale.session_id;

  -- 2. 取り置き: 候補を古い順に p_batch_size 行まで選んでロックする。ほかの worker がロック中の行は飛ばす (同じ行を 2 つの worker が取らない S-19)
  -- revoked_at は見ない: 判定の前に終わったログイン (すぐのログアウト・GoTrue が消した他の端末) も判定して知らせる (§10 の ended の行・S-29)
  -- now() はトランザクションの開始の時刻で 1 の文と同じ値なので、1 で done にしなかった行 (作成から p_max_age_hours 以内) だけが候補になる
  RETURN QUERY
  WITH picked AS (
    SELECT m.session_id
      FROM public.user_sessions_metadata m
     WHERE m.created_at <= pg_catalog.now() - pg_catalog.make_interval(secs => p_min_age_seconds)
       AND m.created_at >= pg_catalog.now() - pg_catalog.make_interval(hours => p_max_age_hours)
       AND (m.alert_status = 'pending'
            OR (m.alert_status = 'processing'
                AND m.alert_claimed_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_reclaim_minutes)))
     ORDER BY m.created_at
     LIMIT p_batch_size
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.user_sessions_metadata m
     SET alert_status = 'processing', alert_claimed_at = pg_catalog.now()
    FROM picked
   WHERE m.session_id = picked.session_id
  RETURNING m.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_login_alert(p_session_id text, p_max_attempts integer)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_session_id IS NULL OR p_max_attempts IS NULL OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'release_login_alert: argument out of range' USING ERRCODE = '22023';
  END IF;
  -- processing の行だけを戻す。数えた回数が p_max_attempts に届いたら諦めて done (§10 の例外の行)
  UPDATE public.user_sessions_metadata m
     SET alert_attempts = m.alert_attempts + 1,
         alert_status = CASE WHEN m.alert_attempts + 1 >= p_max_attempts THEN 'done' ELSE 'pending' END,
         alert_claimed_at = NULL
   WHERE m.session_id = p_session_id
     AND m.alert_status = 'processing';
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['claim_login_alerts(integer, integer, integer, integer)', 'release_login_alert(text, integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;
```

### 11.5 RPC `auth_password_check` (現在のパスワードの確認と履歴の照合)

```sql
CREATE OR REPLACE FUNCTION public.auth_password_check(
  p_user_id uuid, p_current_password text, p_new_password text, p_generations integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c_max_generations CONSTANT integer := 10;   -- password_history_record と同じ
  c_bcrypt_prefix   CONSTANT text := '$2%';   -- pgcrypto の crypt() が比べられる bcrypt。ほかの形式は比べない (crypt に渡さない)
  v_hash       text;
  v_has_hash   boolean;
  v_comparable boolean;
  v_reused     boolean;
BEGIN
  IF p_generations IS NULL OR p_generations < 1 OR p_generations > c_max_generations THEN
    RAISE EXCEPTION 'p_generations out of range' USING ERRCODE = '22023';
  END IF;
  SELECT u.encrypted_password INTO v_hash FROM auth.users u WHERE u.id = p_user_id;
  v_has_hash   := v_hash IS NOT NULL AND v_hash <> '';
  v_comparable := v_has_hash AND v_hash LIKE c_bcrypt_prefix;

  -- 変更 (p_current_password がある): 現在のパスワードを確かめる。パスワードが無い・比べられない形なら確かめられないので断る
  IF p_current_password IS NOT NULL THEN
    IF NOT v_has_hash THEN RETURN 'no_password'; END IF;
    IF NOT v_comparable THEN RETURN 'unsupported_hash'; END IF;
    IF v_hash <> extensions.crypt(p_current_password, v_hash) THEN RETURN 'current_mismatch'; END IF;
  END IF;
  -- 再設定 (p_current_password が NULL。メールのリンク / コードで本人を確かめた §14.7) は、パスワードが無い (Google / Apple だけ)・
  -- 比べられない形でも止めない。いまの再設定の画面 (updateUser) と同じく、最初のパスワードを作れる (S-28)

  -- 直近 p_generations 世代 (履歴に写した現在のパスワードを含む) と比べる。bcrypt でない行は CASE で crypt に渡さない
  SELECT EXISTS (
    SELECT 1 FROM (SELECT h.password_hash FROM public.password_history h
                    WHERE h.user_id = p_user_id ORDER BY h.changed_at DESC LIMIT p_generations) AS recent
     WHERE CASE WHEN recent.password_hash LIKE c_bcrypt_prefix
                THEN recent.password_hash = extensions.crypt(p_new_password, recent.password_hash)
                ELSE false END
  ) INTO v_reused;
  IF v_reused THEN RETURN 'reused'; END IF;
  -- 現在のパスワードと同じ (履歴に無い場合の念のため)。比べられるときだけ
  IF v_comparable THEN
    IF v_hash = extensions.crypt(p_new_password, v_hash) THEN RETURN 'reused'; END IF;
  END IF;
  RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION public.auth_password_check(uuid, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_password_check(uuid, text, text, integer) TO service_role;
```

平文は保存しない・ログに出さない (PostgREST は引数をバインドパラメータで渡し、Postgres は既定でパラメータの値をログに書かない)。1 回の呼び出しの bcrypt は最大 12 回 (現在 1 + 世代 10 + 現在との比較 1)。

戻り値の決定表 (`p_current_password` が NULL = 再設定 §14.7、NULL でない = 変更 §14.6):

| # | 呼び方 | `auth.users.encrypted_password` | 新しいパスワード | 戻り |
|---|---|---|---|---|
| 1 | 変更 | NULL / 空 (Google / Apple だけ) | — | `no_password` (409 S-21) |
| 2 | 変更 | bcrypt でない形 | — | `unsupported_hash` (409) |
| 3 | 変更 | bcrypt・現在のパスワードが違う | — | `current_mismatch` (400 S-11) |
| 4 | 変更 | bcrypt・現在のパスワードが合う | 直近 N 世代の bcrypt の行、または現在のハッシュと同じ | `reused` (422 S-12) |
| 5 | 変更 | 同上 | どれとも違う | `ok` |
| 6 | 再設定 | 何でも (NULL / 空・bcrypt でない形も止めない) | 直近 N 世代の bcrypt の行と同じ、または現在のハッシュ (bcrypt のときだけ比べる) と同じ | `reused` (422 S-14) |
| 7 | 再設定 | 何でも | どれとも違う (パスワードが無く履歴も空なら必ずここ S-28) | `ok` |

再設定は `no_password`・`unsupported_hash`・`current_mismatch` を返さない (§14.7 の 5 は、起きたら `internalError`)。

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

-- 毎日 03:55 JST (18:55 UTC)。ほかの毎日のジョブ (03:10 / 03:15 / 03:25 / 03:45 JST。docs/design/operator/08-cron-batches.md §3.0) と重ねない。同じ名前・同じ処理のジョブは先に外す (20261011070000 と同じ形)
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

`supabase/rollbacks/<番号はマージ時に確定>_auth_history_sessions.down.sql` の全文 (この順)。`auth.sessions` / `auth.users` のトリガー 4 本は消さない: 表の所有者は `supabase_auth_admin` で、ロールバックを流す `postgres` は DROP TRIGGER も `ALTER TABLE … DISABLE TRIGGER` もできない (§3)。代わりに、`postgres` が持つトリガー関数 4 本の本体を「何もしない」(`RETURN NULL` だけ) に置き換え、トリガーと関数は残す (トリガーが関数に依るので、関数も消せない)。残った 4 本は記録をしないので、消した列・表を読まない。もう一度 migration を流すと、`CREATE OR REPLACE FUNCTION` が本体を戻し、トリガーは同じ名前があるので作らない (§11.3)。トリガーそのものを消すには表の所有者の権限が要る (Supabase のサポートに頼む §24・§25 Q-11)。

```sql
-- 1. pg_cron のジョブ (無ければ何もしない。cron.unschedule(name) は無い名前で例外になるので jobid で外す)
DO $$
DECLARE v_job record;
BEGIN
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname = 'cleanup-auth-sessions-and-login-history' ORDER BY jobid LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END $$;

-- 2. 保守の関数 3 本と RPC 4 本
DROP FUNCTION IF EXISTS public.expire_idle_auth_sessions();
DROP FUNCTION IF EXISTS public.reconcile_user_sessions_metadata();
DROP FUNCTION IF EXISTS public.cleanup_ended_user_sessions_metadata();
DROP FUNCTION IF EXISTS public.auth_session_revoke(uuid);
DROP FUNCTION IF EXISTS public.auth_password_check(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.claim_login_alerts(integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.release_login_alert(text, integer);

-- 3. user_profiles のトリガーと関数 (表の所有者は postgres なので消せる)
DROP TRIGGER IF EXISTS trg_user_profiles_fill_login_stats ON public.user_profiles;
DROP FUNCTION IF EXISTS public.user_profiles_fill_login_stats();

-- 4. auth の表のトリガー 4 本は消せない (所有者 supabase_auth_admin §3)。関数の本体を「何もしない」に置き換えて残す
--    (SECURITY DEFINER・search_path・権限 (supabase_auth_admin だけ EXECUTE) は CREATE OR REPLACE で変わらない)
CREATE OR REPLACE FUNCTION public.auth_session_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.auth_session_refreshed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.auth_session_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.password_history_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END;
$$;
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['auth_session_created', 'auth_session_refreshed', 'auth_session_deleted', 'password_history_record'] LOOP
    EXECUTE format(
      'COMMENT ON FUNCTION public.%I() IS %L', fn,
      'cross/16 のロールバックで本体を空にした (何も記録しない)。auth の表のトリガーは表の所有者 (supabase_auth_admin) でないと消せないので残る。migration をもう一度流すと本体が戻る');
  END LOOP;
END $$;

-- 5. user_profiles.last_login_at の COMMENT を baseline (20251126124224) の文に戻す
COMMENT ON COLUMN public.user_profiles.last_login_at IS '最終ログイン日時 (auth.users.last_sign_in_at を Edge Function が同期)';

-- 6. 索引・制約・列 (§11.1 で足したもの)
DROP INDEX IF EXISTS public.idx_sessions_alert_queue;
DROP INDEX IF EXISTS public.idx_sessions_ended;
ALTER TABLE public.user_sessions_metadata
  DROP CONSTRAINT IF EXISTS user_sessions_metadata_context_source_check,
  DROP CONSTRAINT IF EXISTS user_sessions_metadata_alert_status_check,
  DROP CONSTRAINT IF EXISTS user_sessions_metadata_ended_reason_check;
ALTER TABLE public.user_sessions_metadata
  DROP COLUMN IF EXISTS ip_network,
  DROP COLUMN IF EXISTS country_code,
  DROP COLUMN IF EXISTS context_source,
  DROP COLUMN IF EXISTS device_family,
  DROP COLUMN IF EXISTS is_new_device,
  DROP COLUMN IF EXISTS is_new_ip,
  DROP COLUMN IF EXISTS is_new_country,
  DROP COLUMN IF EXISTS alert_status,
  DROP COLUMN IF EXISTS alert_claimed_at,
  DROP COLUMN IF EXISTS alert_attempts,
  DROP COLUMN IF EXISTS alert_sent_at,
  DROP COLUMN IF EXISTS ended_reason;

-- 7. ポリシーと表の権限を baseline (20251126124224:10870・13031〜13032・12815〜12816) の状態に戻す
DROP POLICY IF EXISTS sessions_revoke_self ON public.user_sessions_metadata;
CREATE POLICY sessions_revoke_self ON public.user_sessions_metadata FOR UPDATE USING (user_id = auth.uid());
GRANT ALL ON TABLE public.user_sessions_metadata, public.password_history TO anon, authenticated;
```

写した行 (§11.2) と、トリガーが書いた `user_sessions_metadata` / `password_history` の行は消さない (残る列は既存のものだけで、害が無い)。ロールバックの後に残るのは、`auth` の表のトリガー 4 本と、本体が空の関数 4 本だけ (`SELECT tgname FROM pg_trigger WHERE tgrelid IN ('auth.sessions'::regclass, 'auth.users'::regclass) AND NOT tgisinternal` で 4 行)。もう一度 migration を流すと、残った行は §11.1 の `alert_status` の既定 `'done'` で埋まり、通知の対象に戻らない (`DEFAULT 'pending'` だと、残った行が終わった行も含めてすべて待ちになり、段 B の worker が一斉に送る。§11.2 の写しは `ON CONFLICT DO NOTHING` なので直さない。S-35)。

### 11.8 型の生成物

`src/types/database.types.ts` と `packages/shared/src/database.types.ts` を作り直す (`tests/database-types-migrations-contract.test.ts` の冒頭の手順)。`Functions` に `auth_session_revoke`・`auth_password_check`・`claim_login_alerts`・`release_login_alert`・`expire_idle_auth_sessions`・`reconcile_user_sessions_metadata`・`cleanup_ended_user_sessions_metadata` の 7 本が入る (トリガー関数 5 本は出ない)。`Tables.user_sessions_metadata.Row` に 12 列が増える。

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
/**
 * 作成からこの時間を過ぎた通知の待ちの行は、判定も送信もせずに done にする (claim_login_alerts の p_max_age_hours §11.4)。
 * 段 A のデプロイから段 B の worker まで・worker が止まっていた間に溜まった行を、後からまとめて送らない (何日も前のログインのメールは、
 * 本人が自分のログインかを確かめにくく、まとめて届くと読まれない)。1 日以内の遅れは、乗っ取りに気づいて失効させるのに間に合う範囲として送る。
 * 取り直し (LOGIN_ALERT_RECLAIM_MINUTES) × 試行 (LOGIN_ALERT_MAX_ATTEMPTS) より十分長い (ふつうの再試行は期限の前に終わる)
 */
export const LOGIN_ALERT_MAX_AGE_HOURS = 24;
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
/**
 * サーバーの UA (node / undici / Next.js / Vercel) の種類。Web のログインの直後 (route が実際の UA に上書きする前 §13.5) と、
 * Node の道具 (supabase-js・素の fetch。既定の UA が node) で GoTrue を直接呼んだログイン (S-4)。端末を表さないので、
 * 判定では prior に同じ値があっても既知にしない (login-alert-policy.ts・§10.1)。一覧・メールの言葉は「不明な端末」
 */
export const SERVER_DEVICE_FAMILY_KEY = 'other/server';
/** 空・読めない UA (OS もクライアントも分からない) の種類。SERVER_DEVICE_FAMILY_KEY と同じく、判定では既知にしない。言葉は「不明な端末」 */
export const UNKNOWN_DEVICE_FAMILY_KEY = 'other/other';
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
/**
 * 端末を表さない種類 (「不明な端末」)。device-family.ts の SERVER_DEVICE_FAMILY_KEY ('other/server') と UNKNOWN_DEVICE_FAMILY_KEY
 * ('other/other') と同じ値 (実装では 2 つを import して集合を作る)。prior に同じ値があっても既知にしない (§10.1・§7.1)
 */
const UNIDENTIFIED_DEVICE_FAMILY_KEYS: ReadonlySet<string> = new Set(['other/server', 'other/other']);
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
/**
 * prior = 同じ利用者の、この行より前に作られた行すべて (live・終わった行の両方。期間では絞らない §13.3)。
 * prior が空で、アカウントの年齢が保持の日数以下なら初めてのログイン (消えた行はあり得ない §10.1)。
 * 保持の日数を超えていれば、履歴が消えた (比べる相手が無い) とみなし、新しい端末として知らせる (不明な端末でも同じ)。
 * current が不明な端末 (UNIDENTIFIED_DEVICE_FAMILY_KEYS) なら、prior に同じ値があっても新しい端末とする
 * (Node の既定の UA で GoTrue を直接呼ぶ攻撃者 S-4 を、何もしないで既知にさせない)。
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
    return {
      isNewDevice: true,
      isNewIp: current.ipNetwork !== null,
      isNewCountry: false,
      shouldNotify: true,
      reason: 'history_expired',
    };
  }
  const deviceKnown =
    !UNIDENTIFIED_DEVICE_FAMILY_KEYS.has(current.deviceFamilyKey) &&
    prior.some((p) => p.deviceFamilyKey === current.deviceFamilyKey);
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
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { isAccountFrozen } from '@/lib/auth/frozen';
export const SessionClaimsSchema = z.object({
  sub: z.uuid(),
  session_id: z.uuid(),
  amr: z.array(z.object({ method: z.string(), timestamp: z.number() })).optional(),
});
export type SessionClaims = z.infer<typeof SessionClaimsSchema>;
/**
 * 再設定 (現在のパスワード無しの変更) を受け付ける amr の method。どちらも「メールのリンク / コードで、メールボックスを持つことを示して作ったセッション」(§3):
 * - 'recovery': PKCE の code の経路 (Web の resetPasswordForEmail → /auth/reset-password?code=… を browser の client が交換)。GoTrue は flow state の方法を amr に書く
 * - 'otp': token_hash の経路 (POST /verify。Web の /auth/callback・モバイルの authLink.ts の verifyOtp) と implicit の経路 (GET /verify → フラグメント → モバイルの再設定の画面 reset-password.tsx の setSession)。GoTrue は models.OTP を amr に書く
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
/** requireSessionUser の戻り。route はこれで本人・本人の access token・世代数の入力 (roles) を受ける */
export interface SessionUserContext {
  readonly user: User;
  readonly session: SessionAuth;
  /** user_profiles.roles。プロフィールの行が無ければ [] (passwordHistoryGenerationsFor の入力。認可には使わない) */
  readonly roles: ReadonlyArray<string>;
}
/** 凍結の判定と世代数に要る列だけ (行は無くてもよい) */
const SessionUserProfileSchema = z.object({
  roles: z.array(z.string()).nullable(),
  frozen_at: z.string().nullable(),
  unban_at: z.string().nullable(),
});
/** user_profiles を読めなかった (DB の失敗)。route は internalError (500) にする。値・DB の英文は持たない */
export class SessionUserProfileReadError extends Error {
  constructor() {
    super('user_profiles を読めませんでした');
    this.name = 'SessionUserProfileReadError';
  }
}
/**
 * 本書の利用者の API 7 本 (§14.1〜14.7) の認証。requireUser (src/lib/auth/helpers.ts) と違い、user_profiles の行を要さない
 * (行は同意・初期設定・招待の承諾で作られ、新規登録の直後と同意の前の利用者には無い §3・R-15)。
 * 1. supabase.auth.getUser() (Cookie / Bearer) で本人を確かめる。error・user 無しは AuthError('AUTH_UNAUTHENTICATED')
 * 2. readSessionAuth で claims と access token を読む。読めない・sub が 1 の本人と違うなら AuthError('AUTH_UNAUTHENTICATED')
 * 3. user_profiles の roles / frozen_at / unban_at を maybeSingle で読む。error は SessionUserProfileReadError。
 *    行が無ければ roles = [] で通す (凍結は行の frozen_at なので、行が無ければ凍結は無い)。行があって凍結中なら ForbiddenError('AUTH_ACCOUNT_FROZEN')
 */
export async function requireSessionUser(
  supabase: SupabaseClient,
  authorization: string | null | undefined,
): Promise<SessionUserContext> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData.user;
  if (userError || !user) throw new AuthError('AUTH_UNAUTHENTICATED');
  const session = await readSessionAuth(supabase.auth, authorization);
  if (!session || session.claims.sub !== user.id) throw new AuthError('AUTH_UNAUTHENTICATED');
  const { data, error } = await supabase
    .from('user_profiles')
    .select('roles, frozen_at, unban_at')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new SessionUserProfileReadError();
  if (data === null) return { user, session, roles: [] };
  const profile = SessionUserProfileSchema.parse(data);
  if (isAccountFrozen({ frozenAt: profile.frozen_at, unbanAt: profile.unban_at })) {
    throw new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています');
  }
  return { user, session, roles: profile.roles ?? [] };
}
```

`requireSessionUser` の呼び方 (route): `const supabase = await createClient(); const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));`。`ctx.user.id` が本人の ID、`ctx.session.claims.session_id` がこの端末のセッション、`ctx.session.accessToken` が GoTrue を本人として呼ぶ token、`ctx.roles` が世代数の入力。`AuthError` → 401 `AUTH_UNAUTHENTICATED`、`ForbiddenError` → 403 (`code` のまま)、それ以外 (`SessionUserProfileReadError`・通信の失敗) → `internalError` (§14 の共通)。単体テストは偽の client (`as unknown as SupabaseClient`。既存のテストと同じ書き方) で `auth.getUser`・`auth.getSession`・`auth.getClaims`・`from('user_profiles').select().eq().maybeSingle()` を与える (§20.1)。

再設定の経路と `amr` (§3 の実コード。結合テスト §20.3 が token_hash の経路と password の経路を実 GoTrue で固定する):

| 経路 | 入口 | GoTrue | `amr` の method | 再設定の API |
|---|---|---|---|---|
| Web・PKCE (いまの `resetPasswordForEmail` の既定) | `/auth/reset-password?code=…` を browser の client が交換 | `/verify` の PKCE の枝 → code → `/token?grant_type=pkce` | `recovery` | 通す |
| Web・token_hash (メールの雛形が `{{ .TokenHash }}` の形のとき) | `/auth/callback` の `verifyOtp({ token_hash, type: 'recovery' })` | `POST /verify` | `otp` | 通す |
| モバイル・implicit (いまの既定。`flowType` 未指定) | 再設定の画面 `apps/mobile/app/(auth)/auth/reset-password.tsx:48` の `setSession` (フラグメント。§8 の行 27) | `GET /verify` の implicit の枝 | `otp` | 通す |
| モバイル・code (client を PKCE にしたとき) | 再設定の画面 `reset-password.tsx:45` の `exchangeCodeForSession` (§8 の行 28。いまは `code_verifier` が無く交換できない) | `/verify` の PKCE の枝 → code → `/token?grant_type=pkce` | `recovery` | 通す |
| モバイル・token_hash | `authLink.ts:66` の `verifyOtp` (`verify.tsx` に届くリンク。再設定の画面は token_hash を扱わない §3) | `POST /verify` | `otp` | 通す |
| パスワードのログイン | `/api/auth/login`・モバイルの `signInWithPassword` | `/token?grant_type=password` | `password` | 403 (S-15) |
| Google / Apple | `/auth/callback` の code・`authLink.ts` の code | `/token?grant_type=pkce` (OAuth) | `oauth` | 403 |

### 12.5 `src/lib/auth/sessions/schemas.ts` (API の Zod)

```ts
// src/lib/auth/sessions/schemas.ts
import { z } from 'zod';
/**
 * POST /api/auth/login の PASSWORD_MAX_LENGTH と同じ値・同じ理由 (bcrypt は 72 バイト超を比べない。巨大な本文を送らない)。
 * 本文の大きさの上限で、パスワードの規則ではない。新しいパスワードの 72 バイトの上限 (packages/shared の PASSWORD_MAX_BYTES) は、
 * Zod の後の validatePassword が見て 422 VALID_PASSWORD_WEAK (理由の文言つき) にする (ここで 72 にすると、規則の文言の無い 400 になる)。
 * 現在のパスワード (current_password) には 72 バイトの上限を付けない (上限より長い既存のパスワードの利用者を締め出さない。#1864)
 */
export const PASSWORD_INPUT_MAX_LENGTH = 1024;
/** user_sessions_metadata.device_name varchar(200) */
export const DEVICE_NAME_MAX_LENGTH = 200;
export const PasswordChangeBodySchema = z.object({
  current_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH),
  new_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH),
});
export const PasswordResetBodySchema = z.object({ new_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH) });
/**
 * 端末名に使える文字 (英数字・空白・括弧・ピリオド・カンマ・プラス・ハイフン・下線)。機種名と OS の版 (例 "iPhone 15 Pro (iOS 18.0)") は書け、
 * URL (`:` `/`)・メールアドレス (`@`)・改行・日本語の文は書けない。端末名はセッションを持つ誰でも書ける (攻撃者も自分のセッションに) ので、
 * 一覧で人を欺く文を運ばせない (§7.1)。メールには端末名を載せない (§13.4)。apps/mobile/src/lib/device-name.ts の DEVICE_NAME_DISALLOWED_CHARS はこの補集合
 */
export const DEVICE_NAME_PATTERN = /^[A-Za-z0-9 ()._,+-]+$/;
export const DeviceNameBodySchema = z.object({
  device_name: z.string().trim().min(1).max(DEVICE_NAME_MAX_LENGTH).regex(DEVICE_NAME_PATTERN),
});
export const EndedReasonSchema = z.enum(['signed_out', 'revoked_by_user', 'idle_expired']);
export const SessionSummarySchema = z.object({
  session_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  last_active_at: z.iso.datetime({ offset: true }),
  /** deviceLabelOf(deviceFamilyOf(user_agent)) */
  device_label: z.string(),
  /** アプリが登録した端末名 (DEVICE_NAME_PATTERN の文字だけ)。画面は device_label を見出しにし、これは「端末名: …」として添える (§15) */
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

`LoginHistoryEntrySchema.alert_sent_at` の意味 (v1.8): 通知メールを送信待ち (`email_outbox`) に登録した日時。届いたかは含まない (届けられなかった通知は `email_outbox` の dead の行が持つ §10.2)。送らなかった行 (初めて・既知・`AUTH_LOGIN_ALERT=off`・宛先無し・期限切れ) と、登録できなかった行 (`sendEmail` の `ok: false`) は null。登録の後の記録が残らなかった行 (`finish` が 3 回続けて失敗した S-43・登録の後に関数が止まり続けて期限切れになった S-44 の行。§10.2 #11・#12) も null で、null は「登録した記録が無い」ことまでを言う。段 A のファイル (`schemas.ts`・`store.ts`) はこの改定で変えない (§21.4)。本人の画面 (§15) はこの値を出さず、運営の画面 (§17) は列見出し「通知メールを送信待ちに登録した日時」の列に日本時間で出す (null は「なし」)。

### 12.6 環境変数・rate-limit のカテゴリ

| 名前 | 置き場 | 既定 | 意味 |
|---|---|---|---|
| `AUTH_LOGIN_ALERT` | `src/lib/env.ts` の `SERVER_ENV_VARS` の最後 (`AUTH_LOGIN_FAILURE_RESET_MINUTES` の項目の次) に `required: false`・`readOnlyBy: 'src/app/api/cron/login-alerts/route.ts'` で追加。`.env.example`・`ENV_SETUP.md` に説明 (3 か所の文は下の逐語)。`readOnlyBy` を持つ変数を直書きで並べる既存のテスト `src/__tests__/lib/env.test.ts` にも足す (§22 N-2) | `on` | `off` で worker はメールを送らず印だけ付ける (障害・移行の間に止める用)。不正な値は on に戻して warn (変数名だけ) |
| rate-limit `'auth-password-change'` | `src/lib/rate-limit.ts` の型 `RateLimitCategory` の並びの最後に `\| 'auth-password-change'`、`CATEGORY_RULES` の最後に `'auth-password-change': [{ name: 'auth-password-change', max: 5, windowSec: 10 * MINUTE_SEC }],` (既存の `export` と同じ形)。`CATEGORY_RULES` の前のコメントの【その他】に 1 項目 (#1198。POST /api/auth/password/change、key = 認証で確定した user.id。理由は右の列) | `max: 5, windowSec: 10 * MINUTE_SEC` (キー = user.id) | 現在のパスワードの総当たりを本人のセッションで試させない (GoTrue のログインの制限は通らない経路なので) |
| rate-limit `'auth-password-reset'` | 同上 (`'auth-password-reset'` を `'auth-password-change'` の次に。`[{ name: 'auth-password-reset', max: 5, windowSec: 10 * MINUTE_SEC }]`・POST /api/auth/password/reset) | `max: 5, windowSec: 10 * MINUTE_SEC` (キー = user.id) | 同上 |

`AUTH_LOGIN_ALERT` を足す 3 か所の逐語 (段 B)。`src/lib/env.ts` は、`readOnlyBy` を持つ任意の変数に `whenMissing` が要る (`src/__tests__/lib/env.test.ts` の同じ it が確かめる) ので、次の項目をそのまま足す:

```ts
// tsc:skip — src/lib/env.ts の SERVER_ENV_VARS の、AUTH_LOGIN_FAILURE_RESET_MINUTES の項目の次 (オブジェクトの最後) に足す項目
  AUTH_LOGIN_ALERT: {
    required: false,
    description:
      '新しい端末・地域からのログインを本人にメールで知らせるか (#1190)。on / off (大文字・小文字は問わない)。' +
      'off にすると、毎分の cron (GET /api/cron/login-alerts) は判定して印を付けるが、メールを送らない (障害・移行の間に止める用)',
    whenMissing: 'on と同じ (知らせる)。on / off 以外の値も on に戻し、warn ログに変数名だけを残す',
    // 解釈 (未設定・不正な値の扱い) は src/lib/auth/sessions/constants.ts の resolveLoginAlertMode。値を読むのは cron の route だけ
    readOnlyBy: 'src/app/api/cron/login-alerts/route.ts',
  },
```

`.env.example` は、`AUTH_LOGIN_FAILURE_RESET_MINUTES=` の行の次 (同じ塊の最後) に足す:

```dotenv
# 新しい端末・地域からのログインを本人にメールで知らせるか (任意。サーバー専用。#1190)。on / off。
# off にすると、毎分の cron (GET /api/cron/login-alerts) は判定して印を付けるが、メールを送らない (障害・移行の間に止める用)。
# 未設定なら on。on / off 以外の値も on に戻す (warn ログに変数名だけを残す)。メールが届くには送信元ドメインの検証が要る (docs/operations/email-domain.md)。
AUTH_LOGIN_ALERT=
```

`ENV_SETUP.md` は、節「任意の環境変数: ログイン・登録・パスワード再設定の bot 対策（Cloudflare Turnstile、#1165）」の次 (節「任意の環境変数: Edge Function の CORS（`ALLOWED_ORIGINS`）」の前) に節を 1 つ足す:

```markdown
### 任意の環境変数: 新しい端末からのログインの通知（`AUTH_LOGIN_ALERT`、#1190）

- `AUTH_LOGIN_ALERT`（任意・サーバー専用。Vercel の環境変数）- 新しい端末・地域からのログインを、本人の登録メールアドレスに知らせるか。`on` / `off`。未設定なら `on`。`on` / `off` 以外の値も `on` に戻し、warn ログに変数名だけを残します。
- `off` にすると、毎分の cron（`GET /api/cron/login-alerts`）は判定して印（新しい端末・地域）を付けますが、メールを送りません。障害や移行の間に止める用です。止めていた間に判定したログインのメールは、`on` に戻しても送りません。
- メールが実際に届くには、送信元ドメインの検証が要ります（`RESEND_API_KEY` / `EMAIL_FROM`。[docs/operations/email-domain.md](docs/operations/email-domain.md)）。
```

## 13. facade 契約 (公開関数のシグネチャとエラー表)

### 13.1 `src/lib/auth/sessions/store.ts` (I/O。client は引数で受ける)

```ts
// src/lib/auth/sessions/store.ts — シグネチャ (本体は実装で書く。I/O は supabase-js の client を引数で受け、テストでは偽物を渡す)
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
export type ContextSource = 'auth' | 'web' | 'mobile';
export type EndedReason = 'signed_out' | 'revoked_by_user' | 'idle_expired';
export type AlertStatus = 'pending' | 'processing' | 'done';
/**
 * user_sessions_metadata の 1 行 (database.types.ts の Row と同じ列)。PostgREST の data (enum の列も string) を、
 * 各関数は SessionRowSchema.array().parse (PriorLoginRow は .pick(...)) で絞って返す。合わなければ例外 (型の断定はしない)
 */
export const SessionRowSchema = z.object({
  session_id: z.string(), user_id: z.string(), ip_address: z.string().nullable(), ip_network: z.string().nullable(),
  user_agent: z.string().nullable(), device_name: z.string().nullable(), device_family: z.string().nullable(),
  country_code: z.string().nullable(), context_source: z.enum(['auth', 'web', 'mobile']),
  created_at: z.string(), last_active_at: z.string(), revoked_at: z.string().nullable(),
  ended_reason: z.enum(['signed_out', 'revoked_by_user', 'idle_expired']).nullable(),
  is_new_device: z.boolean().nullable(), is_new_ip: z.boolean().nullable(), is_new_country: z.boolean().nullable(),
  alert_status: z.enum(['pending', 'processing', 'done']), alert_claimed_at: z.string().nullable(),
  alert_attempts: z.number().int(), alert_sent_at: z.string().nullable(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;
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
/**
 * service_role。Web の route がログイン直後に呼ぶ。context_source = 'auth' かつ alert_status = 'pending' (判定の前) の行だけ上書きし、'web' にする
 * (revoked_at は見ない §10)。行が無い・既に web/mobile・判定に回った (processing / done) なら false。例外は投げず false (ログインを止めない)
 */
export declare function recordWebLoginContext(admin: SupabaseClient, input: { userId: string; sessionId: string; ipAddress: string | null; userAgent: string | null; countryCode: string | null }): Promise<boolean>;
/**
 * service_role。取り置き (§10 の行) = admin.rpc('claim_login_alerts', { p_batch_size: batchSize, p_min_age_seconds: minAgeSeconds,
 * p_reclaim_minutes: reclaimMinutes, p_max_age_hours: maxAgeHours }) (§11.4)。時刻の条件は DB の now() で SQL の中にある。
 * 作成から maxAgeHours を過ぎた待ち・取り直しの行は、RPC が送らずに done にし (期限切れ)、戻りに入れない。
 * 戻りは取れた行だけ (processing にした行)。error は例外
 */
export declare function claimLoginAlerts(
  admin: SupabaseClient,
  input: { batchSize: number; minAgeSeconds: number; reclaimMinutes: number; maxAgeHours: number },
): Promise<SessionRow[]>;
/**
 * service_role。判定の結果と送信の結果を書く = admin.from('user_sessions_metadata').update({ alert_status: 'done', device_family: deviceFamily,
 * is_new_device: isNewDevice, is_new_ip: isNewIp, is_new_country: isNewCountry, alert_sent_at: sentAt?.toISOString() ?? null }).eq('session_id', sessionId)。
 * error は例外
 */
export declare function finishLoginAlert(admin: SupabaseClient, input: { sessionId: string; deviceFamily: string; isNewDevice: boolean; isNewIp: boolean; isNewCountry: boolean; sentAt: Date | null }): Promise<void>;
/**
 * service_role。失敗した行を戻す = admin.rpc('release_login_alert', { p_session_id: sessionId, p_max_attempts: maxAttempts }) (§11.4)。
 * processing の行の alert_attempts を 1 増やし、maxAttempts に届けば done、届かなければ pending (processing でない行は変えない)。error は例外
 */
export declare function releaseLoginAlert(admin: SupabaseClient, input: { sessionId: string; maxAttempts: number }): Promise<void>;
```

`store.ts` が timestamptz の列 (名前が `_at` で終わる列) を `.gte` / `.gt` / `.lte` / `.lt` で絞るのは、`listPriorLogins` の `.lt('created_at', input.createdAt)` の **1 か所だけ** にする (取り置きの時刻の条件は SQL の中 §11.4。`listLiveSessions` は `.is('revoked_at', null)`、`listLoginHistory` は `.order('created_at', …)` だけ)。この 1 か所は `tests/jst-today-source-scan.test.ts` の規則 G に当たるので、許可リストに件数 1 で載せる (§22 N-39)。

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
   * updatePasswordWithAccessToken(session.accessToken, input.newPassword, input.currentPassword) (§13.7。session = readSessionAuth の結果)。
   * currentPassword は変更なら現在のパスワード (GoTrue の UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD が ON でも通るよう GoTrue にも渡す)、再設定なら null。
   * createClient() の auth.updateUser は使わない (Bearer だけの要求ではセッションが無く AuthSessionMissingError §3)
   */
  updatePassword(input: { newPassword: string; currentPassword: string | null }): Promise<UpdatePasswordOutcome>;
}
export type PasswordChangeResult =
  | { kind: 'changed' } | { kind: 'current_mismatch' } | { kind: 'reused' } | { kind: 'no_password' } | { kind: 'unsupported_hash' }
  | { kind: 'weak' } | { kind: 'reauthentication_required' }
  | { kind: 'upstream-error'; code: string | null; status: number | null };
/** GoTrue のエラーの code (auth-js の AuthApiError.code) */
const GOTRUE_WEAK_PASSWORD = 'weak_password';
const GOTRUE_SAME_PASSWORD = 'same_password';
const GOTRUE_REAUTHENTICATION_NEEDED = 'reauthentication_needed';
/** GoTrue の UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD が ON で、渡した current_password が違う (DB の照合の後に別の要求でパスワードが変わった) */
const GOTRUE_CURRENT_PASSWORD_INVALID = 'current_password_invalid';
export async function performPasswordChange(input: PasswordChangeInput, deps: PasswordChangeDeps): Promise<PasswordChangeResult> {
  const check = await deps.checkPassword(input);
  if (check !== 'ok') return { kind: check };
  const { error } = await deps.updatePassword({ newPassword: input.newPassword, currentPassword: input.currentPassword });
  if (!error) return { kind: 'changed' };
  if (error.code === GOTRUE_WEAK_PASSWORD) return { kind: 'weak' };
  if (error.code === GOTRUE_SAME_PASSWORD) return { kind: 'reused' };
  if (error.code === GOTRUE_REAUTHENTICATION_NEEDED) return { kind: 'reauthentication_required' };
  if (error.code === GOTRUE_CURRENT_PASSWORD_INVALID) return { kind: 'current_mismatch' };
  return { kind: 'upstream-error', code: error.code, status: error.status };
}
```

### 13.3 `src/lib/auth/sessions/login-alert-worker.ts`

```ts
// src/lib/auth/sessions/login-alert-worker.ts — シグネチャ。1 行の処理の順は §13.4
import type { SupabaseClient } from '@supabase/supabase-js';
/**
 * 取り置いた行のうち worker が使う列 (store.ts の SessionRow はこの形に代入できる)。ip_address は完全な IP (メールの「IP アドレス」の行・一覧と同じ値)、ip_network は判定に使う範囲。
 * device_name は持たない (利用者が書ける値をメールに載せない §7.1。メールの端末は deviceLabelOf(deviceFamilyOf(user_agent)) だけ)
 */
export interface LoginAlertRow {
  session_id: string; user_id: string; user_agent: string | null; ip_address: string | null; ip_network: string | null;
  country_code: string | null; created_at: string;
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
  /**
   * createLoginAlertWorkerDeps の send (下の表)。deviceLabel = deviceLabelOf(deviceFamilyOf(row.user_agent)) (決まった言葉だけ §13.4)。
   * ok = sendEmail が送信待ち (email_outbox) に登録できた (SendEmailResult.ok。届いたかは含まない。配信は GET /api/cron/email-outbox の worker §10.2)。
   * 登録できなかった (ok: false = suppressed・not_configured (skipped: true)・invalid_envelope・outbox_failed) は { ok: false } で返り、例外にしない
   */
  send(row: LoginAlertRow, deviceLabel: string, to: string): Promise<{ ok: boolean }>;
  /** sentAt = 送信待ちに登録できた (send の ok が真) ときの now() (alert_sent_at)。それ以外 (送らない判定・宛先無し・ok: false) は null (§13.4 の 5) */
  finish(sessionId: string, result: { deviceFamily: string; isNewDevice: boolean; isNewIp: boolean; isNewCountry: boolean; sentAt: Date | null }): Promise<void>;
  release(sessionId: string): Promise<void>;
  now(): Date;
}
/**
 * 件数だけ。claimed = claim() が返した行の数。どの行も queued・skipped・failed のどれか 1 つだけに数える (claimed = queued + skipped + failed)。
 * queued と skipped は finish が戻った後に数える (§13.4 の 5)。queued = 通知メールを送信待ちに登録し、finish でその日時を記録できた行 (届いたかは含まない)。
 * skipped = 送らない判定・宛先無し・登録できなかった行で、finish が戻った行。
 * failed = §13.4 の 1〜5 で例外になった行 (release を呼ぶ。release も例外でも failed。send が ok: true の後に finish が例外になった行も failed だけで、queued に数えない §10.2 #10・#11)
 */
export interface LoginAlertWorkerSummary { claimed: number; queued: number; skipped: number; failed: number }
export declare function processLoginAlerts(deps: LoginAlertWorkerDeps, options: { alertMode: 'on' | 'off' }): Promise<LoginAlertWorkerSummary>;
/** 本物の deps (下の表)。cron の route が getSupabaseAdmin() を渡して呼ぶ */
export declare function createLoginAlertWorkerDeps(admin: SupabaseClient): LoginAlertWorkerDeps;
```

`createLoginAlertWorkerDeps(admin)` の中身 (`admin` は cron の route が渡す `getSupabaseAdmin()`。数は §12.1 の定数。`sendEmail` を import する (`import { sendEmail } from '@/lib/emails/send'`) のは、このファイルだけ §22 N-18。`resend`・`@/lib/emails/outbox`・`@/lib/auth/mfa/assurance` は import しない §22 N-41・N-42):

| deps | 中身 |
|---|---|
| `claim()` | `claimLoginAlerts(admin, { batchSize: LOGIN_ALERT_BATCH_SIZE, minAgeSeconds: LOGIN_ALERT_MIN_AGE_SECONDS, reclaimMinutes: LOGIN_ALERT_RECLAIM_MINUTES, maxAgeHours: LOGIN_ALERT_MAX_AGE_HOURS })` |
| `priorLogins(row)` | `listPriorLogins(admin, { userId: row.user_id, sessionId: row.session_id, createdAt: row.created_at, limit: LOGIN_ALERT_PRIOR_MAX_ROWS })` を `{ deviceFamilyKey: p.device_family ?? deviceFamilyOf(p.user_agent).key, ipNetwork: p.ip_network, countryCode: p.country_code }` に |
| `accountOf(userId)` | `admin.auth.admin.getUserById(userId)`。`data.user` が無ければ null、あれば `{ email: data.user.email ?? null, createdAt: new Date(data.user.created_at) }`。`error` が「見つからない」(status 404) なら null、それ以外の error は例外 |
| `send(row, deviceLabel, to)` | `` const result = await sendEmail(renderLoginNewDeviceEmail({ to_email: to, logged_in_at: new Date(row.created_at), device_label: deviceLabel, ip_address: row.ip_address, country_code: row.country_code }), { idempotencyKey: `login-alert:${row.session_id}`, userId: row.user_id }); return { ok: result.ok }; `` (`result` は `SendEmailResult`)。`ok: true` = 送信待ち (`email_outbox`) に登録できた (`result.id` = `email_outbox.id`。届いたかは含まない §10.2)。`userId` は `email_outbox.user_id` (退会時の伏せ字 `prepare_account_deletion` の 1b。送信待ちの画面 (operator/10 の段 C) の一覧では `user_id` の列に出る §7.1)。`redactAfterSend` は渡さない (文面は秘密を含まず、dead の行を再送できるようにする §18)。`sendEmail` は例外を投げない (R-01) ので `send` も投げない。`ok: false` の種類 (`result.error.code`) は見ない (ログは `sendEmail` が残す) |
| `finish(sessionId, result)` | `finishLoginAlert(admin, { sessionId, ...result })` |
| `release(sessionId)` | `releaseLoginAlert(admin, { sessionId, maxAttempts: LOGIN_ALERT_MAX_ATTEMPTS })` |
| `now()` | `new Date()` |

### 13.4 worker の 1 行の順 (逐語)

1. `family = deviceFamilyOf(row.user_agent)`、`prior = await priorLogins(row)`、`account = await accountOf(row.user_id)`。
2. `account` が null (利用者が消えた) → `finish(session_id, { deviceFamily: family.key, isNewDevice: false, isNewIp: false, isNewCountry: false, sentAt: null })` → `finish` が戻ったら `skipped` に数え、次の行へ (`finish` が例外なら 6)。
3. `decision = decideLoginAlert({ deviceFamilyKey: family.key, ipNetwork: row.ip_network, countryCode: row.country_code }, prior, { accountCreatedAt: account.createdAt, now: now(), retentionDays: LOGIN_HISTORY_RETENTION_DAYS })`。
4. `decision.shouldNotify && alertMode === 'on'` のときだけ送る: `account.email` が null なら送らない (5 で `skipped` に数える)。あれば `sent = await send(row, deviceLabelOf(family), account.email)`。端末の文言は UA から決まる決まった言葉だけで、行の `device_name` (利用者が `PATCH sessions/current` で書ける §7.1) は使わない (`LoginAlertRow` に `device_name` は無い)。ここではまだ数えない (`sent.ok` が真でも、件数は 5 の `finish` が戻った後に決まる)。
5. `finish(session_id, { deviceFamily: family.key, isNewDevice, isNewIp, isNewCountry, sentAt: sent?.ok ? now() : null })`。`sentAt` = 送信待ちに登録した日時 (`alert_sent_at`。届いたかは含まない。配信は送信待ちの worker が行い、届けられなければ dead として運用メールで知らせる。再送は送信待ちの側の操作で、画面と API は operator/10 の段 C §10.2・S-37)。登録できなかった (`ok: false`: `suppressed` S-18・`not_configured` (`skipped: true`) S-38・`invalid_envelope`・`outbox_failed`) ときも `done` (`sentAt` null。再送しない。`sendEmail` が app_logs に残す。`ok: false` の種類で分岐しない)。送らない判定 (`shouldNotify` が偽・`alertMode` が off) の行も `finish` する (`sentAt` は null)。件数は `finish` が戻った後に数える: `sent.ok` (= 送信待ちに登録できた) が真の行は `queued`、それ以外 (送らない判定・宛先無し・`ok: false`) は `skipped`。`finish` が例外なら 6 の `failed` だけで、`queued`・`skipped` には数えない (登録 (`ok: true`) の後でも同じ。§10.2 #10・#11)。どの行も `queued`・`skipped`・`failed` のどれか 1 つだけに数え、`claimed` (`claim()` が返した行の数) = `queued` + `skipped` + `failed`。
6. 1〜5 で例外 → `release(session_id)` (RPC `release_login_alert`。attempts + 1、3 回目で done) → `failed` に数え (`queued`・`skipped` には数えない)、次の行へ。`release` も例外なら握って (`failed` のまま) 次の行へ (行は `processing` のまま残り、10 分後の取り置きで取り直される §10)。登録 (`ok: true`) の後に `finish` が例外になった行は、次の回で `send` からやり直すので `email_outbox` に同じ `idempotency_key` の行が 2 つできるが、届くのは 1 通 (S-39)。
7. 戻り値は件数だけ。応答にも、ログにも、メールアドレス・IP・UA は入れない (件数と session_id の数だけ)。

### 13.5 Web の route がログイン直後に呼ぶ (`recordWebLoginContextFromRequest` → `recordWebLoginContext`。段 A)

Web の 2 route は、GoTrue にセッションを作らせる呼び出し (`signInWithPassword`・`exchangeCodeForSession`・`verifyOtp`) の成功の直後に、共通の `recordWebLoginContextFromRequest` を 1 回ずつ呼ぶ。呼ぶ所は 4 か所 (login の 1 か所・callback の 3 か所)。呼ぶ所ごとに try を書かない (握りはこの関数の中に 1 つ)。

```ts
// src/lib/auth/sessions/web-login-context.ts — シグネチャ (本体は下の手順の逐語)
/**
 * session-claims.ts の SessionClaimsReader (§12.4) と同じ形。実装ではここに書かず session-claims.ts から import する
 * (この block は単独で型検査するので同じ形を書く)
 */
interface SessionClaimsReader {
  getSession(): Promise<{ data: { session: { access_token: string } | null } }>;
  getClaims(jwt?: string): Promise<{ data: { claims: unknown } | null; error: { message: string } | null }>;
}
/**
 * Web の route が、GoTrue にセッションを作らせる呼び出しの成功の直後に呼ぶ。auth = route の createClient() の supabase.auth、
 * headers = request.headers、session = その呼び出しの戻りの data.session。トリガーが作った user_sessions_metadata の行
 * (context_source = 'auth') に request の IP・UA・国を書く。例外を投げない (失敗は warn を 1 回だけ残し、ログインの応答を変えない)
 */
export declare function recordWebLoginContextFromRequest(
  auth: SessionClaimsReader,
  headers: Pick<Headers, 'get'>,
  session: { access_token: string } | null | undefined,
): Promise<void>;
```

本体の手順 (import は `createLogger` (`@/lib/db-logger`)・`getSupabaseAdmin` (`@/lib/supabase/server`)・`extractClientIp` (`@/lib/admin/client-ip`)・`readSessionAuth` (`./session-claims`)・`recordWebLoginContext` (`./store`)・`countryCodeOf` (`./request-context`)):

1. `session` が `null` / `undefined` なら何もしないで返す (`auth.getClaims` も `getSupabaseAdmin()` も呼ばない。§22 N-36 の既存テストの mock はセッションを返さないので、ここで終わる)。
2. 以下の全体を 1 つの `try { … } catch (error) { … }` で包む:
   1. `` const sessionAuth = await readSessionAuth(auth, `Bearer ${session.access_token}`) `` (§12.4)。`null` なら `createLogger('auth/login-context').warn('ログインの文脈を記録できませんでした', { stage: 'claims' })` を出して返す。
   2. `const recorded = await recordWebLoginContext(getSupabaseAdmin(), { userId: sessionAuth.claims.sub, sessionId: sessionAuth.claims.session_id, ipAddress: extractClientIp(headers), userAgent: headers.get('user-agent'), countryCode: countryCodeOf(headers) })`。`extractClientIp` は login の route の `clientIp` と同じ関数 (`src/lib/admin/audit.ts` が再 export している元)。`recorded` が `false` なら同じ warn を `{ stage: 'record' }` で出す。
   3. `catch (error)` は同じ warn を `{ stage: 'exception', error_name: error instanceof Error ? error.name : typeof error }` で出す (`error.message` は出さない: PostgREST・GoTrue の英文に値が入りうる)。
3. warn の metadata は `stage` (と `error_name`) だけ。token・IP・UA・利用者 ID・`session_id` を出さない。warn は 1 回の呼び出しで多くても 1 回。

route の書き方:

- `src/app/api/auth/login/route.ts`: `signIn` の中を `const { data, error } = await supabase.auth.signInWithPassword(...)` にし、続けて `if (!error) await recordWebLoginContextFromRequest(supabase.auth, request.headers, data.session);` → 今までどおり `return { error: … }`。`guarded-login.ts` は変えない (`deps.signIn` の中で済む)。
- `src/app/(auth)/auth/callback/route.ts`: 3 つの分岐 (origin/main の `:62` code の `exchangeCodeForSession`・`:77` token_hash の `verifyOtp`・`:97` `token` のフォールバックの `verifyOtp`) のそれぞれで、今の `try` の中の `authSuccess = !error` の次の行に `if (!error) await recordWebLoginContextFromRequest(supabase.auth, request.headers, data.session);` を書く (分岐を足したら、その分岐にも書く。走査 §20.3 が数を見る)。callback は `getSupabaseAdmin` を import しない (使うのは `recordWebLoginContextFromRequest` の中だけ)。今の分岐ごとの `try` / `catch` とログ・リダイレクト先は変えない。
- `countryCodeOf(headers)`: `x-vercel-ip-country` を読み、`/^[A-Z]{2}$/` に合えばその値、無ければ null (`src/lib/auth/sessions/request-context.ts`)。
- `recordWebLoginContext` は `context_source = 'auth'` かつ判定の前 (`alert_status = 'pending'`) の行だけ上書き (`.eq('user_id', userId).eq('session_id', sessionId).eq('context_source', 'auth').eq('alert_status', 'pending')`。`revoked_at` は見ない)。UPDATE が 0 行なら `false` (`.select('session_id')` の戻りの件数で見る)。worker が取り置いた後の行を変えないのは、取り置いた値で判定した行の `user_agent` と、`finishLoginAlert` が書く `device_family` を食い違わせないため (§10。食い違うと、後のログインの prior でその行が不明な端末のまま比べられる)。`ip_network` は TS の `ipNetworkOf(ip)` で計算して同じ UPDATE に入れる (`src/lib/auth/sessions/ip-network.ts`: IPv4 は `a.b.c.0/24`、IPv6 は先頭 48 ビットを `xxxx:xxxx:xxxx::/48` の形。`node:net` の `isIP` で種類を見る。不正なら null)。幅は SQL のトリガーと同じ値 (契約テスト §20.3)。migration の前にコードが本番に入ったとき (§0.2 の注) は、列が無い UPDATE の error で `false` を返す (例外にしない §13.6)。

### 13.6 facade のエラー表 (lib)

| 関数 | 失敗 | 扱い |
|---|---|---|
| `readSessionAuth` | token 無し・検証失敗・形が違う | `null` (`requireSessionUser` が `AuthError` にする → 401 `AUTH_UNAUTHENTICATED`) |
| `requireSessionUser` | `getUser` の error・user 無し / `readSessionAuth` が null / claims の `sub` が本人と違う | `AuthError('AUTH_UNAUTHENTICATED')` → route は 401 `AUTH_UNAUTHENTICATED` |
| `requireSessionUser` | `user_profiles` の行があり凍結中 (`isAccountFrozen`) | `ForbiddenError('AUTH_ACCOUNT_FROZEN')` → 403 `AUTH_ACCOUNT_FROZEN` |
| `requireSessionUser` | `user_profiles` の読み取りの error | `SessionUserProfileReadError` → route は `internalError` (500) |
| `requireSessionUser` | `user_profiles` の行が無い | 失敗にしない (`roles: []` で通す R-15) |
| `revokeSession` | RPC の error (28000 = 未認証 / その他) | 例外 → route は `internalError` (500) |
| `signOutOtherSessions` | GoTrue の error (`auth.admin.signOut` の戻り) | 例外 → route は `internalError` (500)。`remaining` は返さない |
| `updatePasswordWithAccessToken` | GoTrue の 4xx / 5xx | `{ error: { code, status } }` (例外にしない) → `performPasswordChange` が kind に変える。通信の失敗 (`fetch` の例外) は例外のまま → route は `internalError` (`stage: 'password-update'`) |
| `recordWebLoginContext` | DB の失敗 (列が無い・PostgREST の error・通信)・UPDATE が 0 行 (行が無い・既に `web` / `mobile`・判定に回った `processing` / `done` の行 §10) | `false` (例外にしない。ログは出さず、呼ぶ側の `recordWebLoginContextFromRequest` が warn を 1 回出す) |
| `recordWebLoginContextFromRequest` | `readSessionAuth` が null / `recordWebLoginContext` が `false` / どこかで例外 (`getClaims`・`getSupabaseAdmin` の環境変数の欠け・通信) | 例外を投げず、warn を 1 回 (`stage` = `claims` / `record` / `exception` §13.5)。route はログインの応答を変えない (ログインは成功のまま) |
| `setCurrentDeviceName` | 行が無い | `false` → route は 404 `AUTH_SESSION_NOT_FOUND` |
| `performPasswordChange` | RPC の例外 | 例外 → route は `internalError` (`stage: 'password-check'`) |
| `claimLoginAlerts` / `releaseLoginAlert` / `finishLoginAlert` | RPC・UPDATE の error | 例外 (worker が受ける。下の行) |
| `processLoginAlerts` | 1 行の例外 | `release` して続行 (`release` の例外も握る §13.4 の 6)。`claim` 自体の失敗は例外 → route は 500 |
| `send` (`createLoginAlertWorkerDeps`) → `sendEmail` | `ok: false` (`suppressed` / `not_configured` (`skipped: true`) / `invalid_envelope` / `outbox_failed`) | 例外にしない。worker は `sentAt: null` で `done` (再送しない §13.4 の 5)。ログは `sendEmail` が残す。登録の後に届けられなかった (dead) は `sendEmail` の戻りには出ず、送信待ちの側で扱う (§10.2) |

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
 * currentPassword = 変更なら現在のパスワード (本文の current_password に入れる)、再設定なら null (本文に入れない)。
 * GoTrue は UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD が OFF (既定) なら current_password を読まない。ON なら、再設定のセッション
 * (amr が otp・magiclink・recovery) を除いてこれを照合する (§3)。本書は変更でいつも渡すので、どちらの設定でも同じに動く (§24・Q-18)。
 * 成功なら { error: null }。GoTrue が 4xx / 5xx なら { error: { code, status } } (例外にしない)。通信の失敗は fetch の例外のまま投げる。
 * パスワード・token・GoTrue の英文はログにも戻り値にも入れない
 */
export async function updatePasswordWithAccessToken(
  accessToken: string,
  newPassword: string,
  currentPassword: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<UpdatePasswordOutcome> {
  const requestBody = currentPassword === null ? { password: newPassword } : { password: newPassword, current_password: currentPassword };
  const response = await fetchImpl(`${getSupabaseUrl()}${GOTRUE_USER_PATH}`, {
    method: 'PUT',
    headers: {
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      [GOTRUE_API_VERSION_HEADER]: GOTRUE_API_VERSION,
    },
    body: JSON.stringify(requestBody),
    cache: 'no-store',
  });
  if (response.ok) return { error: null };
  const body: unknown = await response.json().catch(() => null);
  return { error: { code: gotrueErrorCodeOf(body), status: response.status } };
}
```

GoTrue の `PUT /user` は、パスワードを変えた同じトランザクションで本人 (JWT の `session_id`) 以外のセッションを消す (P-1 / P-2 §3)。`secure_password_change` が ON で nonce が要るときは `code: 'reauthentication_needed'` が返る (§24)。`UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` が ON で `current_password` が違うときは `code: 'current_password_invalid'` (`performPasswordChange` が `current_mismatch` にする §13.2)、無いときは `current_password_required` (変更ではいつも渡し、再設定のセッションは GoTrue が免除するので起きない。起きたら `upstream-error`)。

### 13.8 利用者の API の認証 `requireSessionUser` (`src/lib/auth/sessions/session-claims.ts`。本体は §12.4)

```ts
// tsc:skip — シグネチャの再掲 (正典の本体は §12.4 のブロック)
export interface SessionUserContext { readonly user: User; readonly session: SessionAuth; readonly roles: ReadonlyArray<string> }
export class SessionUserProfileReadError extends Error {}
export declare function requireSessionUser(supabase: SupabaseClient, authorization: string | null | undefined): Promise<SessionUserContext>;
```

- 使う route: §14.1〜14.7 の 7 本 (`GET /api/auth/sessions`・`DELETE /api/auth/sessions/{id}`・`PATCH /api/auth/sessions/current`・`POST /api/auth/sessions/revoke-others`・`GET /api/auth/login-history`・`POST /api/auth/password/change`・`POST /api/auth/password/reset`)。この 7 本は `requireUser` を呼ばない (`user_profiles` の行の無い利用者を 401 にする §3)。§14.9 の運営の route は `requireRole`。
- エラーは §13.6 の `requireSessionUser` の 4 行。

## 14. API 仕様

共通: `runtime = 'nodejs'`・`dynamic = 'force-dynamic'`・`Cache-Control: private, no-store`・本文の形は `{ error: 利用者向けの文言, code, ... }` (login route と同じ flat)。認証は §14.1〜14.7 の 7 本とも `const supabase = await createClient(); const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));` (§12.4・§13.8。Cookie / Bearer。`user_profiles` の行が無くても通る R-15。行があって凍結中は 403 `AUTH_ACCOUNT_FROZEN`)。`requireUser()` は呼ばない (行が無いと 401 §3)。`AuthError` → 401 `AUTH_UNAUTHENTICATED`、`ForbiddenError` → 403 (code はそのまま)、それ以外の例外 (`SessionUserProfileReadError` を含む) → 5xx。本文を読む handler は最初に `rejectNullCharacterBody(request)`。5xx は `internalError(ROUTE_NAME, error, { userId })`。以下の `user.id` は `ctx.user.id`、`session` は `ctx.session`。

### 14.1 `GET /api/auth/sessions`

`requireSessionUser` → `listLiveSessions(supabase, ctx.user.id)` → 各行を `{ session_id, created_at, last_active_at, device_label: deviceLabelOf(deviceFamilyOf(user_agent)), device_name, ip_address, country_code, is_current: session_id === ctx.session.claims.session_id }` に → 200 `SessionsResponseSchema`。

### 14.2 `DELETE /api/auth/sessions/{id}`

`params: Promise<{ id: string }>`・`isUuid(id)` でなければ 404 `AUTH_SESSION_NOT_FOUND` → `requireSessionUser` → `revokeSession(supabase, id)` → `'revoked'` 200 `{ ok: true }` / `'current'` 409 `AUTH_SESSION_IS_CURRENT` / `'not_found'` 404 `AUTH_SESSION_NOT_FOUND`。

### 14.3 `POST /api/auth/sessions/revoke-others`

`requireSessionUser` → `await signOutOtherSessions(getSupabaseAdmin(), ctx.session.accessToken)` (GoTrue の `/logout?scope=others` を本人の access token で。Web は Cookie のセッションの token、モバイルは Bearer の JWT。Cookie は触らない) → 例外なら `internalError` → `listLiveSessions(supabase, ctx.user.id)` で残りを数え 200 `{ ok: true, remaining: n }`。`createClient()` の `auth.signOut` は呼ばない (§3: Bearer だけの要求では何も消さずに成功を返す)。

### 14.4 `PATCH /api/auth/sessions/current`

`rejectNullCharacterBody` → 本文 `DeviceNameBodySchema` (違えば 400 `VALIDATION_ERROR`。`DEVICE_NAME_PATTERN` に無い文字 (日本語・`:` `/` `@`・改行など) を含むときも §12.5) → `requireSessionUser` (プロフィールの行が無い新規の利用者の最初のセッションも通る S-30) → `setCurrentDeviceName(getSupabaseAdmin(), { userId: ctx.user.id, sessionId: ctx.session.claims.session_id, deviceName })` → true 200 `{ ok: true }` / false 404 `AUTH_SESSION_NOT_FOUND`。

### 14.5 `GET /api/auth/login-history`

`requireSessionUser` → `listLoginHistory(supabase, ctx.user.id, LOGIN_HISTORY_PAGE_SIZE)` → `LoginHistoryResponseSchema` (`ended_at = revoked_at`)。

### 14.6 `POST /api/auth/password/change`

1. `rejectNullCharacterBody` → `readJsonBody` + `PasswordChangeBodySchema` (違えば 400 `VALIDATION_ERROR`) → `validatePassword(new_password)` (packages/shared。違えば 422 `VALID_PASSWORD_WEAK` に理由の文言) → `new_password === current_password` なら 422 `VALID_PASSWORD_HISTORY` (「現在のパスワードと違うものに」)。
2. `requireSessionUser` (§12.4) → `checkRateLimit(ctx.user.id, 'auth-password-change')` (超過 429 `RATE_LIMITED` + `Retry-After`)。
3. `generations = passwordHistoryGenerationsFor(ctx.roles)` (`ctx.roles` は `requireSessionUser` が読んだ本人の行の roles。行が無ければ `[]` で 3 世代。route は `user_profiles` を自分で読まない)。
4. `performPasswordChange({ userId: ctx.user.id, currentPassword, newPassword, generations }, { checkPassword: (input) => <getSupabaseAdmin().rpc('auth_password_check', { p_user_id: input.userId, p_current_password: input.currentPassword, p_new_password: input.newPassword, p_generations: input.generations }) の data を PasswordCheckOutcome に絞る。error・知らない値は例外>, updatePassword: ({ newPassword, currentPassword }) => updatePasswordWithAccessToken(ctx.session.accessToken, newPassword, currentPassword) })` (変更では `currentPassword` = 本文の `current_password` が GoTrue にも渡る §13.7)。`createClient()` の `auth.updateUser` は呼ばない (§3: Bearer だけのモバイルの要求ではセッションが無く必ず失敗する)。
5. 結果 → `changed` 200 `{ ok: true }` / `current_mismatch` 400 `AUTH_CURRENT_PASSWORD_MISMATCH` / `reused` 422 `VALID_PASSWORD_HISTORY` / `no_password` 409 `AUTH_PASSWORD_NOT_SET` / `unsupported_hash` 409 `AUTH_PASSWORD_NOT_SET` (文言は「この方法では変更できません。お問い合わせください」) / `weak` 422 `VALID_PASSWORD_WEAK` / `reauthentication_required` 403 `AUTH_REAUTHENTICATION_REQUIRED` / `upstream-error` → `internalError`。
6. 他の端末の失効は GoTrue が行う (P-1)。route は `signOut` を呼ばない。

### 14.7 `POST /api/auth/password/reset`

1 は `PasswordResetBodySchema`。2 は `requireSessionUser` (プロフィールの行が無い利用者も通る S-30) → `!hasRecentRecoveryMethod(ctx.session.claims, new Date(), PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES)` なら 403 `AUTH_RECOVERY_SESSION_REQUIRED` (「再設定メールのリンクから開き直してください」。`amr` の `recovery` / `otp` §12.4) → rate-limit は `'auth-password-reset'`。3 は 14.6 と同じ (`ctx.roles`)。4 は `currentPassword: null`・`updatePassword` は 14.6 と同じ (`updatePasswordWithAccessToken(ctx.session.accessToken, newPassword, null)`。本文は `password` だけ。再設定のセッションは GoTrue の `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` の免除に当たる §3)。5 は `changed` 200・`reused` 422 `VALID_PASSWORD_HISTORY`・`weak` 422・`reauthentication_required` 403・`upstream-error` → `internalError`。`current_mismatch`・`no_password`・`unsupported_hash` は再設定では起き得ない (§11.5 の決定表の行 6・7。パスワードの無い利用者は最初のパスワードを作れる S-28)。起きたら `internalError`。全端末のログアウトはページが行う (既存)。

### 14.8 `GET /api/cron/login-alerts` (Vercel Cron 毎分)

`const authError = await requireCronAuth(req); if (authError) return authError;` (CC-6 の形) → `resolveLoginAlertMode(process.env.AUTH_LOGIN_ALERT)` (ignored なら変数名だけ warn を 1 回) → `processLoginAlerts(createLoginAlertWorkerDeps(getSupabaseAdmin()), { alertMode })` (§13.3) → 200 `{ claimed, queued, skipped, failed }` (`queued` = 通知メールを送信待ちに登録し、`finish` で記録まで済んだ行の数。登録の後に `finish` が例外になった行は `failed` だけ §13.4 の 5。届いたかは送信待ちの `email_outbox` の行が持つ。`GET /api/cron/email-outbox` の応答は回ごとの件数で、行を画面で見られるのは operator/10 の段 C の後の `/super-admin/email-outbox` §10.2)。route は `sendEmail` も store も直接は呼ばない。`claim` の失敗は `internalError`。`vercel.json` に `{ "path": "/api/cron/login-alerts", "schedule": "*/1 * * * *" }`。同じ PR で、`vercel.json` の crons の path を挙げる 2 つの文書を直す: `docs/design/operator/08-cron-batches.md` (§22 N-32) と `ENV_SETUP.md` の `` `CRON_SECRET` `` の行 (§22 N-43。逐語は §23)。

### 14.9 `GET /api/admin/users/{id}/login-history` (段 D)

`const actor = await requireRole(['admin', 'super_admin'])` (support は 403) → `isUuid(id)` でなければ 404 → 行は service_role で読む: `listLoginHistory(getSupabaseAdmin(), id, LOGIN_HISTORY_PAGE_SIZE)` → 1 件以上なら監査を **利用者の client** で記録する: `recordAdminAudit({ supabase: await createClient(), actorId: actor.id, actionType: 'admin.user.view_login_history', targetId: id, targetType: 'user', details: { returned_count }, request, routeName: 'api/admin/users/[id]/login-history GET' })` (service_role の client は渡さない。`admin_audit_logs` は `actor_id = auth.uid()` を WITH CHECK で強制する (`docs/design/CLAUDE.md` §6・`src/lib/admin/audit.ts:51-53`)。既存の `GET /api/admin/users/{id}` (`src/app/api/admin/users/[id]/route.ts:171-180`) と同じ: 読むのは `getSupabaseAdmin()`、監査は `createClient()`。記録の失敗 `{ ok: false }` では閲覧を止めない (既存と同じ)) → 200 `{ data: { entries } }` (運営 API は nested。401/403 は `{ error: { code, message } }`。既存の `GET /api/admin/users/{id}` と同じ形)。

## 15. 画面 (Web)

| 画面 | 中身 |
|---|---|
| `/settings/security/sessions` (`src/app/(main)/settings/security/sessions/page.tsx`・client) | 見出し「ログイン中の端末」。`GET /api/auth/sessions` の各行をカードで: 見出しは `device_label` (UA から決まる言葉)、`device_name` があれば見出しの下に「端末名: <device_name>」(アプリが登録した名前。見出しの代わりにはしない §7.1)・IP・国・「最後の利用: n 分前 / 日時」・「ログインした日時」。`is_current` に「この端末」のバッジ (ボタン無し)。他の行に「この端末をログアウトさせる」(確認ダイアログ → `DELETE`)。下に「他の端末をすべてログアウト」(確認 → `POST revoke-others`)。次の見出し「最近のログイン」(`GET /api/auth/login-history`): 日時・端末 (`device_label`。`device_name` があれば「(端末名: …)」を添える)・IP・国・印 (`is_new_device` → 「新しい端末」、`is_new_country` → 「新しい地域」、`is_new_ip` → 「新しい接続元」の薄い印)・終了 (`signed_out` 「ログアウト」/ `revoked_by_user` 「この一覧から解除」/ `idle_expired` 「使われずに期限切れ」)。読み込み失敗・未ログインは `/settings/account` と同じ型 (`account-load-error` / `account-signed-out` の testid の流儀) |
| `/settings` (`src/app/(main)/settings/page.tsx`) | 「アカウント」のカードに行を足す: 「ログイン中の端末・ログイン履歴」(`data-testid="settings-sessions-link"` → `/settings/security/sessions`) |
| `/settings/account` | `PasswordChangeSection` を API 呼び出しに置き換える: `validatePasswordChangeInput` → `POST /api/auth/password/change` → 200 で成功の表示 (「この端末以外のログインはすべて解除しました」はそのまま。`result` の state を `{ othersSignedOut: boolean } \| null` から `boolean` (成功を出すか。送信の始めに `false`、200 で `true`) に改め、`othersSignedOut` の分岐と `data-testid="password-change-others-not-signed-out-note"` の段落、`describeOthersNotSignedOutNote` の import と呼び出しは消す。GoTrue が更新と同じトランザクションで他の端末を消すので、200 なら他の端末は必ず消えている §13.7。`describeForgotCurrentPasswordNote` はそのまま)。`src/lib/auth/logout-guidance.ts` の `describeOthersNotSignedOutNote` は呼ぶ所が無くなるので関数ごと消す (§22 N-33) / 失敗の文言: 401 はログイン画面への案内、それ以外 (400・403・409・422・429・500・通信の失敗) は `describePasswordChangeApiError(code, message)` (`src/lib/auth/password/client.ts` が返す `{ code, message }`。§16 の規則: 本文の `error` = §19 の文があればそれ。例: 400 `AUTH_CURRENT_PASSWORD_MISMATCH` → 「現在のパスワードが正しくありません。」、403 `AUTH_REAUTHENTICATION_REQUIRED` → 「安全のため、もう一度ログインしてから変更してください。」)。`TurnstileWidget` と `useTurnstile` はこのセクションから外す (再認証のサインインが無くなるため。#1474 の対象は `/auth/verify` だけになる) |
| `/auth/reset-password` | `supabase.auth.updateUser` を `POST /api/auth/password/reset` に置き換える。成功後の `signOutEverywhere` (clear → `signOut global` → broadcast) と 3 秒後の `/login` はそのまま。422 → 本文の `error`。403 `AUTH_RECOVERY_SESSION_REQUIRED` → 「リンクが無効です」の画面と同じ案内 |
| Web の通信 (`src/lib/auth/sessions/client.ts`・`src/lib/auth/password/client.ts`) | `fetch` の薄い包み: `listSessions()` / `revokeSession(id)` / `revokeOtherSessions()` / `listLoginHistory()` / `changePassword(body)` / `resetPassword(body)`。応答は Zod で検証。エラーは `{ code, message }` に正規化 |

## 16. モバイル

| ファイル | 中身 |
|---|---|
| `apps/mobile/src/lib/sessions-api.ts` (新規) | `getApi()` で `GET /api/auth/sessions`・`DELETE /api/auth/sessions/{id}`・`POST /api/auth/sessions/revoke-others`・`GET /api/auth/login-history`・`PATCH /api/auth/sessions/current` を呼ぶ関数 5 つ。応答は `packages/shared` に写した Zod (§25 Q-7) か、同じ形の型で受ける |
| `apps/mobile/src/lib/device-name.ts` (新規) | `deviceNameOf()`: `expo-device` の `modelName ?? Platform.OS` + ` (osName osVersion)` から、`DEVICE_NAME_DISALLOWED_CHARS = /[^A-Za-z0-9 ()._,+-]/g` (サーバーの `DEVICE_NAME_PATTERN` §12.5 の補集合) に当たる文字を除き、続く空白を 1 つに畳み、前後を削り、200 文字に切る。空になれば `Platform.OS`。利用者が付けた端末の名前 (`Device.deviceName`。人の名前を含みうる・日本語や `’` はサーバーで 400 になる) は使わない (§7.1)。2 つの文字の決まりがずれても、サーバーが 400 を返して端末名が入らないだけ (登録は warn で終わり、一覧は `device_label` で出る)。`registerDeviceName(accessToken: string): Promise<void>`: モジュールの変数 `lastRegisteredAccessToken` (プロセスの中だけ。保存しない) と同じ token なら何もしない。違えば先にその token を覚えてから `getApi().patch('/api/auth/sessions/current', { device_name: deviceNameOf() })` を送る (同時に来た同じ token の 2 回目は送らない)。失敗したら、覚えた値がまだその token なら `null` に戻し (次の SIGNED_IN / INITIAL_SESSION で送り直す)、例外は投げず `console.warn('[device-name] 端末名を登録できませんでした')` だけ (token・端末名・応答は出さない)。重ねよけを利用者 ID でなく access token にするのは、同じ利用者のログアウト → ログイン (S-27 の再設定の後のログインを含む) が新しいセッション = 新しい token で、その行に端末名を書くため (§8 の行 2)。auth-js の `Session` は `session_id` を持たないので、セッションごとに変わる access token で見分ける。同じセッションでも refresh で token が変わった後の SIGNED_IN では送り直すが、書く値は同じ (冪等) |
| `apps/mobile/src/providers/AuthProvider.tsx` (変更) | `onAuthStateChange` の `INITIAL_SESSION` の枝の `if (nextSession) { … }` の中 (`return` の前) と、`SIGNED_IN` のとき (末尾の `applySession(nextSession)` の前。`event === 'SIGNED_IN' && nextSession` で絞る) で `registerDeviceName(nextSession.access_token).catch(() => undefined)` を fire-and-forget (待たない) (既存の掃除の表・`restoreSession` には触らない) |
| `apps/mobile/app/settings/sessions.tsx` (新規) | §15 の `/settings/security/sessions` と同じ構成 (一覧・この端末・解除・他の端末をすべて・最近のログイン)。`testID="sessions-screen"` |
| `apps/mobile/app/(tabs)/settings.tsx` (変更) | 「アカウント」に `SettingRow` を足す: 「ログイン中の端末」(`testID="settings-sessions-row"` → `/settings/sessions`) |
| `apps/mobile/src/lib/account-credentials.ts` (変更) | `changePassword(email, input)` の中身を `getApi().post('/api/auth/password/change', { current_password, new_password })` に (送るのは Bearer だけ。サーバーは Bearer の JWT で GoTrue を呼ぶ §13.7)。戻りの型 `{ ok: true; othersSignedOut: boolean }` は `{ ok: true }` に改め、`othersSignedOut` は消す。失敗したときの文言は `getApiErrorMessage(error, describePasswordChangeApiError(null, null))` (`apps/mobile/src/lib/api-error.ts` の既存の関数。`getApi()` が投げる `HTTP <status> …: <本文>` の本文の `error` を取り出し、圏外・待ち時間切れは通信の文言。取り出せなければ第 2 引数の共通の失敗の文言)。`console.error` には `error.name` だけを出す (パスワード・本文は出さない)。`describePasswordChangeApiError(code: string \| null, serverMessage: string \| null): string` は `packages/shared/src/account-change-errors.ts` に足す (Web の `/settings/account` §15 が `{ code, message }` で呼び、モバイルは上の第 2 引数で使う。`index.ts` から export)。規則: `serverMessage` (応答の本文の `error`。route が §19 の固定の文か `internalError` の共通の文で作り、生の英文は入らない §22 N-5) が空でなければそれを返す。空なら code が `AUTH_CURRENT_PASSWORD_MISMATCH`・`VALID_PASSWORD_HISTORY`・`AUTH_REAUTHENTICATION_REQUIRED`・`AUTH_RECOVERY_SESSION_REQUIRED`・`AUTH_PASSWORD_NOT_SET` のとき §19 の文、それ以外 (通信の失敗の null を含む) は共通の失敗の文言 |
| `apps/mobile/src/components/settings/AccountCredentialsSection.tsx` (変更) | `result` の state を `{ othersSignedOut: boolean } \| null` から `boolean` (変更できたか。`useState(false)`・送信の始めに `setResult(false)`・成功で `setResult(true)`) に改める。成功の帯の文は常に「セキュリティのため、この端末以外のログインはすべて解除しました。他の端末では、新しいパスワードでログインし直してください。」(「ただし、他の端末のログアウトを確認できませんでした…」の枝は消す)。ほかの表示・testID は変えない |
| `apps/mobile/app/(auth)/auth/reset-password.tsx` (変更) | `onSubmit` の `try` の中を次の順に: ① `const { data: current } = await supabase.auth.getSession(); const userId = current.session?.user?.id ?? null;` (ログアウトの掃除に渡す利用者 ID。API の応答 `{ ok: true }` は ID を返さないので、呼ぶ前のセッションから取る) ② `await getApi().post('/api/auth/password/reset', { new_password: password })` (`supabase.auth.updateUser` は呼ばない) ③ 今までどおり `Alert.alert("完了", …)` → `await signOutWithCleanup(userId)` → `router.replace("/login")`。`catch (e)` は `Alert.alert("更新失敗", getApiErrorMessage(e, "更新に失敗しました。"))` (`../../../src/lib/api-error`。本文の `error` = §19 の文: 422 `VALID_PASSWORD_HISTORY` / `VALID_PASSWORD_WEAK`、403 `AUTH_RECOVERY_SESSION_REQUIRED` / `AUTH_REAUTHENTICATION_REQUIRED`、429 など。圏外は通信の文言。再設定は `AUTH_PASSWORD_NOT_SET` を返さない §14.7)。失敗のときはログアウトも画面の移動もしない (今までどおり) |

## 17. 運営の画面 (段 D)

`src/app/admin/users/[id]/page.tsx`: `actor.roles` に admin / super_admin があるときだけ `adminFetch('/api/admin/users/{id}/login-history')` を呼び、「ログイン履歴 (直近 20 回)」の表を描く: 日時 (`toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })`。サーバーのコンポーネントで描くので、`timeZone` を書かないと UTC になる)・端末 (`device_label`。`device_name` があれば「(端末名: …)」を添える §7.1)・IP・国・印 (新しい端末 / 接続元 / 地域)・通知メールを送信待ちに登録した日時 (`alert_sent_at` を日時の列と同じ `toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })` で出し、null は「なし」。届いたかはこの画面では分からない (§10.2)。null には登録の後の記録が残らなかった行 (§10.2 #11・#12) も入る。そのときも送信待ちの行はある (DB の上では `idempotency_key` `login-alert:<session_id>`)。運営が送信待ちの行を画面で見るのは operator/10 の段 C の後で、`/super-admin/email-outbox` (super_admin) の一覧を `template` = `login_new_device` で絞り、時刻と `user_id` の列で見分ける (一覧は `idempotency_key` を返さず、利用者での絞り込みも無い §10.2)。この括弧の中の説明は画面に出さない)・終了 (理由)。列見出しは左から次の 7 つを逐語で出す: 「日時」「端末」「IP」「国」「印」「通知メールを送信待ちに登録した日時」「終了」(v1.8 R2。`alert_sent_at` の列を「通知メール」とだけ書くと、日時が出ている行が配信済みに読めるため、見出しに「送信待ちに登録した」を入れる。§12.5・Q-23・§20.4 はこの見出しを指す)。0 件は「記録なし」。応答が ok でない (403 / 500 / 通信の失敗) ときは節の中に「ログイン履歴を読み込めませんでした」だけを出し、ページの他の節は今までどおり描く (`notFound()` / `redirect` にしない)。support には節を出さない (API も 403)。

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
  /** deviceLabelOf(deviceFamilyOf(user_agent)) (決まった言葉だけ)。利用者が書ける device_name は入れない (§7.1・§13.4) */
  device_label: string;
  /** user_sessions_metadata.ip_address (完全な IP。一覧 §14.1 と同じ値。範囲 ip_network ではない) */
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

送信は worker の `createLoginAlertWorkerDeps` の `send` だけ (`` sendEmail(envelope, { idempotencyKey: `login-alert:${session_id}`, userId: row.user_id }) `` §13.3。`sendEmail` は送信待ち `email_outbox` に登録して返り、届けるのは `GET /api/cron/email-outbox` の worker §10.2)。宛先は本人の登録メールアドレス (利用者が指定したアドレスではない) なので、招待の回数制限 (`invite-throttle`) は通さない (§22 N-18 の除外)。文面は秘密 (受け取った人だけが使えるトークンを含むリンク #1708) を含まないので、`contains_secret` を書かない (`false` も書かない §7.1)。`redactAfterSend` も渡さない: dead になった行の宛先・本文を残し、再送できる形にしておく (伏せた行は `requeue_email_outbox` が 'redacted' を返して再送できない)。再送の画面 `/super-admin/email-outbox` は operator/10 の段 C で入り、段 C の前はアプリから再送できない (§10.2 #8)。`src/__tests__/lib/emails/secret-templates.test.ts` の走査は、この文面を秘密なしの表 `PUBLIC_TEMPLATES` に `login_new_device: ['country_code']` で載せないと赤 (項目の名前が `_code` で終わるので「リンク・トークンらしい項目」として拾う。国コードは ISO 3166-1 の 2 文字で、リンクでもトークンでもない §22 N-40)。本文に入る利用者の値は端末の言葉・IP・国だけ (生の UA・`session_id`・端末名・メールアドレスは入れない)。

## 19. エラー表 (全 code)

| code | HTTP | どこで | 文言 (利用者向け) |
|---|---|---|---|
| `VALIDATION_ERROR` (既存) | 400 | 本文の形 (端末名の使えない文字 §12.5 を含む) | 「入力の内容を確認してください。」 |
| `INVALID_CHARACTER` (既存) | 400 | NULL 文字 | 既存 |
| `AUTH_CURRENT_PASSWORD_MISMATCH` (新) | 400 | change | 「現在のパスワードが正しくありません。」 |
| `AUTH_UNAUTHENTICATED` (既存) | 401 | 全部 | 既存 |
| `AUTH_ACCOUNT_FROZEN` (既存) | 403 | 全部 | 既存 |
| `AUTH_RECOVERY_SESSION_REQUIRED` (新) | 403 | reset | 「パスワードの再設定は、再設定メールのリンクから開き直してください。」 |
| `AUTH_REAUTHENTICATION_REQUIRED` (新) | 403 | change | 「安全のため、もう一度ログインしてから変更してください。」 |
| `OP_PERMISSION_DENIED` (既存) | 403 | admin API (support) | 既存 (`GET /api/admin/users/{id}` と同じ nested の本文 §14.9) |
| `AUTH_SESSION_NOT_FOUND` (新) | 404 | sessions/{id}・current | 「その端末のログインは、すでに終了しています。」 |
| `AUTH_SESSION_IS_CURRENT` (新) | 409 | sessions/{id} | 「いま使っている端末は、ここでは解除できません。ログアウトを使ってください。」 |
| `AUTH_PASSWORD_NOT_SET` (新) | 409 | change だけ (`no_password`・`unsupported_hash`。再設定は返さない §11.5) | 「このアカウントはパスワードでログインしていないため、変更できません。」(`unsupported_hash` は §14.6 の 5 の文) |
| `VALID_PASSWORD_WEAK` (新) | 422 | change / reset | `validatePassword` の理由 (8 文字以上・英字と数字・UTF-8 で 72 バイトまで。72 バイト超は `PASSWORD_TOO_LONG_MESSAGE`。#1864) |
| `VALID_PASSWORD_HISTORY` (既存 cross/04) | 422 | change / reset | 「最近使ったパスワードは使えません。別のパスワードにしてください。」 |
| `RATE_LIMITED` (既存) | 429 | change / reset | 既存 |
| `INTERNAL_ERROR` (既存) | 500 | 全部 | 既存 |
| `cron_disabled` / `unauthorized` (既存 cron-auth) | 503 / 401 | cron | 既存 |

## 20. テスト一覧 (it 名)

### 20.1 単体 (段の印が無い行は段 A。置き場は `src/lib/auth/__tests__/`。別の置き場の行はパスを書く)

- `sessions-device-family.test.ts`: 「iPhone の Safari を ios/safari にする」「Android の Chrome を android/chrome にする」「Windows の Edge を edge にする (Chrome より先に見る)」「Mac の Firefox を macos/firefox にする」「CFNetwork を含む UA を ios/app にする」「okhttp を android/app にする」「node・undici・Vercel Edge Functions を other/server にする」「空・null を other/other にする」「deviceFamilyOf('node') の key は SERVER_DEVICE_FAMILY_KEY、deviceFamilyOf('') の key は UNKNOWN_DEVICE_FAMILY_KEY」「512 文字より後ろは見ない」「deviceLabelOf が app・server・不明・ブラウザの 4 つの形の文言を返す」
- `sessions-login-alert-policy.test.ts`: 「履歴が無く、アカウントが保持の日数以内に作られたなら first_login で送らない (保持の日数ちょうども first_login)」「履歴が無く、アカウントが保持の日数より前に作られたなら history_expired で送る」「history_expired は current が不明な端末 (other/server・other/other) でも送る (isNewDevice は true)」「同じ端末の種類と同じ IP の範囲は known」「端末の種類が新しければ new_device で送る」「IP の範囲だけが新しいときは isNewIp だけで送らない」「国が分かる履歴があり国が違えば new_country で送る」「国が分からない履歴しか無ければ国では送らない」「current が other/server (Node の既定の UA node) なら、prior に other/server の行があっても new_device で送る (S-4・S-32)」「current が other/other (空の UA) なら、prior に other/other の行があっても new_device で送る」「端末と国が両方新しければ new_device_and_country」
- `sessions-session-claims.test.ts`: 「Bearer があれば getSession を呼ばずその JWT を getClaims に渡し、accessToken にその JWT を返す」「Bearer が無ければ Cookie のセッションの access_token を渡し、accessToken にその token を返す」「token が無い・getClaims が error・claims の形が違うときは null」「hasRecentRecoveryMethod は 60 分以内の recovery を真にする」「hasRecentRecoveryMethod は 60 分以内の otp を真にする」「password・oauth だけなら偽」「60 分より古い recovery / otp は偽」「requireSessionUser は getUser が error か user 無しなら AuthError (AUTH_UNAUTHENTICATED)」「requireSessionUser は claims が読めない・sub が getUser の id と違うなら AuthError (AUTH_UNAUTHENTICATED)」「requireSessionUser は user_profiles の行が無ければ (maybeSingle の data が null) roles [] で通し、凍結の判定で止めない (S-30)」「requireSessionUser は行があって凍結中なら ForbiddenError AUTH_ACCOUNT_FROZEN、unban_at が過ぎていれば通す」「requireSessionUser は行の roles を返し、null は []」「requireSessionUser は user_profiles の読み取りが error なら SessionUserProfileReadError (値・英文を持たない)」
- `password-gotrue-user.test.ts`: 「PUT <SUPABASE_URL>/auth/v1/user に Bearer の access token・apikey・X-Supabase-Api-Version: 2024-01-01 を付ける」「currentPassword が null なら本文は { password } だけ、文字列なら { password, current_password }」「2xx なら error は null」「4xx の本文の code (文字列) と status を返す」「code が数値で error_code が文字列の古い形は error_code を返す」「本文が JSON でなければ code は null で status を返す」「fetch の例外はそのまま投げる」
- `sessions-constants.test.ts`: 「AUTH_LOGIN_ALERT は未設定で on、off で off、ほかの値は on に戻して ignored」「LOGIN_ALERT_MAX_AGE_HOURS の時間は LOGIN_ALERT_MIN_AGE_SECONDS より長く、LOGIN_ALERT_RECLAIM_MINUTES × LOGIN_ALERT_MAX_ATTEMPTS の分より長い (ふつうの再試行は期限切れの前に終わる §12.1)」
- `sessions-web-login-context.test.ts` (`recordWebLoginContextFromRequest` §13.5。`@/lib/supabase/server`・`@/lib/db-logger`・`@/lib/auth/sessions/store` の `recordWebLoginContext` を vi.mock): 「session が null・undefined なら getClaims も getSupabaseAdmin も recordWebLoginContext も呼ばず、warn も出さない」「getClaims の sub / session_id と extractClientIp(headers)・user-agent・countryCodeOf(headers) で、getSupabaseAdmin() の client を渡して recordWebLoginContext を 1 回呼ぶ」「readSessionAuth が null (getClaims が error) なら recordWebLoginContext を呼ばず、warn を stage claims で 1 回出す」「recordWebLoginContext が false なら warn を stage record で 1 回出す」「getClaims・getSupabaseAdmin・recordWebLoginContext が投げても reject せず、warn を stage exception で 1 回出す」「warn の metadata は stage (と error_name) だけで、token・IP・UA・利用者 ID・session_id・error の message を含まない」
- `sessions-ip-network.test.ts`: 「IPv4 を /24 の範囲にする」「IPv6 を /48 の範囲にする」「不正な文字列は null」
- `sessions-request-context.test.ts`: 「countryCodeOf は x-vercel-ip-country が大文字 2 文字 (例 JP) ならその値を返す」「ヘッダが無ければ null」「小文字・3 文字・数字・空・前後の空白つきなど /^[A-Z]{2}$/ に合わなければ null」
- `password-policy.test.ts`: 「運営のロールを 1 つでも持てば 10」「org_ のロールは 5」「それ以外は 3」「空の配列は 3」
- `password-change.test.ts`: 「checkPassword が ok 以外なら updatePassword を呼ばず同じ kind を返す」「updatePassword に newPassword と currentPassword を渡す (再設定は currentPassword が null)」「current_password_invalid → current_mismatch」「updatePassword の weak_password → weak」「same_password → reused」「reauthentication_needed → reauthentication_required」「その他のエラー → upstream-error に code と status」「成功 → changed」
- `sessions-login-alert-worker.test.ts` (段 B): 「取り置いた行ごとに判定し、送るべき行だけ send を呼ぶ」「decideLoginAlert に accountOf の createdAt・now()・LOGIN_HISTORY_RETENTION_DAYS を渡す (prior が空で古いアカウントなら送る)」「accountOf が null の行は送らずに印を false で finish し、skipped に数える」「alertMode が off なら送らず印だけ finish する」「email が無い行は skipped」「send が ok: false (sendEmail が登録できなかった: suppressed・not_configured (skipped: true)・invalid_envelope・outbox_failed) でも done (sentAt null) にして再送せず、skipped に数える」「send が ok: true (送信待ちに登録できた) なら sentAt = now() で done にし、finish が戻った後に queued に数える (配信の成否は待たず、email_outbox を読まない)」「send に渡す端末の文言は deviceLabelOf(deviceFamilyOf(user_agent)) で、取り置いた行に device_name があっても使わない (S-31)」「1 行の例外は release して次へ進み、failed に数える」「send が ok: true の後に finish が例外を投げた行は、release を 1 回呼んで failed に数え (queued は 0・skipped は 0)、同じ回の中で send をもう一度呼ばない (重複の登録は次の回の取り直しの 1 回だけ S-39・S-43)」「send が ok: false の後に finish が例外を投げた行は、failed だけに数える (skipped は 0)」「どの行も queued・skipped・failed のどれか 1 つだけに数え、claimed (claim が返した行の数) はその和になる」「release も例外を投げても次の行へ進み、failed に数える」「戻り値に件数 ({ claimed, queued, skipped, failed }) だけを返す」「createLoginAlertWorkerDeps の send は、行の created_at・ip_address (ip_network ではない)・country_code と端末の文言で renderLoginNewDeviceEmail を作り、sendEmail に idempotencyKey login-alert:<session_id> と userId = row.user_id を付けて渡し、redactAfterSend は渡さない」「createLoginAlertWorkerDeps の send は sendEmail の戻りの ok をそのまま { ok } で返す (ok: true = 登録できた。{ ok: false, skipped: true } も ok: false。例外にしない)」「createLoginAlertWorkerDeps の claim / release は LOGIN_ALERT_BATCH_SIZE・LOGIN_ALERT_MIN_AGE_SECONDS・LOGIN_ALERT_RECLAIM_MINUTES・LOGIN_ALERT_MAX_AGE_HOURS (p_max_age_hours)・LOGIN_ALERT_MAX_ATTEMPTS を RPC の引数にする」「createLoginAlertWorkerDeps の accountOf は getUserById が 404 なら null、ほかの error は例外」
- `sessions-client.test.ts` (B。Web の `src/lib/auth/sessions/client.ts`): 「listSessions は GET /api/auth/sessions を呼び、応答を SessionsResponseSchema で検証して返す」「revokeSession(id) は DELETE /api/auth/sessions/{id}、revokeOtherSessions は POST /api/auth/sessions/revoke-others、listLoginHistory は GET /api/auth/login-history を呼ぶ」「4xx / 5xx の本文の code と error を { code, message } にして返す」「応答が Zod に合わなければ、生の本文を出さずに失敗として返す」「fetch の reject は通信エラーの { code, message } にする」
- `password-client.test.ts` (C。Web の `src/lib/auth/password/client.ts`): 「changePassword は POST /api/auth/password/change に { current_password, new_password } を JSON で送る」「resetPassword は POST /api/auth/password/reset に { new_password } を送る」「200 は成功、400 / 403 / 409 / 422 / 429 / 500 は本文の code と error を { code, message } にする」「fetch の reject は通信エラーにする」「戻り値・例外にパスワードを含めない」
- `password-change-api-errors.test.ts` (C。`packages/shared` の `describePasswordChangeApiError` を `@homegohan/shared` から読む): 「serverMessage (本文の error) が空でなければそれをそのまま返す」「serverMessage が null・空なら、AUTH_CURRENT_PASSWORD_MISMATCH・VALID_PASSWORD_HISTORY・AUTH_REAUTHENTICATION_REQUIRED・AUTH_RECOVERY_SESSION_REQUIRED・AUTH_PASSWORD_NOT_SET は §19 の文言の列と同じ文を返す」「serverMessage が null・空で、それ以外の code (VALID_PASSWORD_WEAK・RATE_LIMITED・AUTH_UNAUTHENTICATED・INTERNAL_ERROR・知らない code・null) は共通の失敗の文言」
- `src/__tests__/lib/emails/account/login-new-device.test.ts` (B): 「template は login_new_device、宛先は to_email、件名は §18 の文」「ログインの日時を日本時間で出す」「IP と国があれば 2 行を出し、null の方の行は出さない (両方 null なら端末の行の後に場所の行が無い)」「パスワードの変更のリンクは getSiteUrl() + /settings/account、端末の一覧のリンクは getSiteUrl() + /settings/security/sessions」「本文に入る利用者の値は vars の端末の文言・IP・国だけ (生の user_agent・session_id・メールアドレスを本文に書かない)」「EmailEnvelopeSchema を通る」「contains_secret を持たない (封筒に無く、EmailEnvelopeSchema.parse の後も undefined。秘密なし §18)」「本文のリンクは getSiteUrl() + 固定のパス 2 つだけで、トークン・一時的な値を含まない」
- `src/__tests__/lib/env.test.ts` (B。既存の it の書き換え。直し方の逐語は §22 N-2): it「値を読む場所が決まっている変数 (AI_ULTIMATE_MODE_DAILY_LIMIT・AUTH_LOGIN_ALERT・AUTH_LOGIN_FAILURE_RESET_MINUTES・CRON_SECRET・…) は、check:env のために一覧にあるが、getOptionalEnv では読めない」(名前の並びに `AUTH_LOGIN_ALERT` を足す)。期待の配列に `['AUTH_LOGIN_ALERT', 'src/app/api/cron/login-alerts/route.ts']`、`typeOnly` に `getOptionalEnv('AUTH_LOGIN_ALERT')` の `@ts-expect-error` を足す。ほかの it は変えない

- `packages/shared/src/password-policy-max-bytes.test.ts` (#1864): 「GoTrue の MaxPasswordLength と同じ 72」「utf8ByteLength は Buffer.byteLength (UTF-8) と同じ数」「半角 72 バイトは通り 73 バイトは止める」「日本語 26 文字 (74 バイト) で止める」「絵文字は length ではなくバイト数で数える」「長すぎるときは英字・数字より先に長さの文言」

### 20.2 route (`tests/api/`)

- `auth-sessions-routes.test.ts` (B): 「GET は本人の live の行を device_label と is_current つきで返す」「GET は claims が読めなければ 401」「DELETE は revoked で 200、current で 409、not_found で 404、UUID でなければ 404」「DELETE は RPC を本人の client で呼ぶ (service_role を使わない)」「revoke-others は Cookie のセッションの access token で auth.admin.signOut(token, 'others') を呼び、残りの件数を返す」「revoke-others は Bearer だけの要求 (Cookie 無し) でも Bearer の JWT を auth.admin.signOut に渡す」「revoke-others は createClient() の auth.signOut を呼ばない」「revoke-others は auth.admin.signOut が error なら 500 で remaining を返さない」「revoke-others は claims が読めなければ 401」「PATCH current は device_name を検証し、行が無ければ 404」「PATCH current は日本語・`:`・`/`・`@`・改行を含む device_name を 400 VALIDATION_ERROR にし、setCurrentDeviceName を呼ばない (S-31)。`iPhone 15 Pro (iOS 18.0)` は通す」「GET と PATCH current は user_profiles の行が無い利用者 (maybeSingle が null) でも 200 (requireUser の 401 にならない S-30)」「login-history は 20 件まで」「凍結中は 403」「どの応答にも Cache-Control: private, no-store」
- `auth-password-routes.test.ts` (C): 「change: 入力の検証で弾くときは RPC も updateUser も呼ばない」「change: current_mismatch → 400」「change: reused → 422 VALID_PASSWORD_HISTORY」「change: no_password → 409」「change: 成功 → 200 で signOut を呼ばない」「change: rate-limit 超過 → 429」「change: roles から世代数を決めて RPC に渡す (super_admin は 10)」「change: Bearer だけの要求 (Cookie 無し) でも createClient() の auth.updateUser を呼ばず、updatePasswordWithAccessToken に Bearer の JWT と、第 3 引数に本文の current_password を渡す」「change: Cookie の要求では Cookie のセッションの access token を渡す」「change: updatePasswordWithAccessToken の weak_password → 422 VALID_PASSWORD_WEAK」「reset: amr に recovery も otp も無い (password) → 403」「reset: 60 分より古い recovery → 403」「reset: amr の recovery (PKCE) → 200」「reset: amr の otp (token_hash / implicit) → 200」「reset: 直近の世代と同じパスワード (RPC が reused) → 422 VALID_PASSWORD_HISTORY で、updatePasswordWithAccessToken を呼ばない (S-14)」「reset: RPC に p_current_password = null を渡す」「reset: Bearer だけの要求でも Bearer の JWT で更新し、updatePasswordWithAccessToken の第 3 引数は null」「change: updatePasswordWithAccessToken が current_password_invalid を返したら 400 AUTH_CURRENT_PASSWORD_MISMATCH」「reset: user_profiles の行が無い利用者でも 200 で、RPC の p_generations は 3 (S-30)」「change: 世代数は requireSessionUser の roles から決め、route は user_profiles を読まない」「reset: RPC が current_mismatch・no_password・unsupported_hash を返したら 500 (再設定では起き得ない §14.7)」「本文にパスワードも生のエラー文も出ない」
- `auth-login-context.test.ts` (A。login と callback が文脈の記録を呼ぶ所 §13.5。`@/lib/auth/sessions/web-login-context` を vi.mock し、中身は `sessions-web-login-context.test.ts` §20.1 が見る): 「login: signInWithPassword が error 無しで返ると、recordWebLoginContextFromRequest を supabase.auth・request.headers・その data.session で 1 回呼び、応答は 200 (signed-in)」「login: signInWithPassword が error を返すと呼ばない」「callback: code の exchangeCodeForSession が error 無しで返ると、その data.session で 1 回呼ぶ」「callback: token_hash と type の verifyOtp ({ token_hash, type }) が error 無しで返ると、その data.session で 1 回呼ぶ」「callback: token と type だけ (token_hash 無し) のフォールバックの verifyOtp ({ token_hash: token, type }) が error 無しで返ると、その data.session で 1 回呼ぶ」「callback: 3 つの分岐のどれも、error を返したときは呼ばない」「callback: 3 つの分岐のどれも、呼んだときのリダイレクト先は呼ばないときと同じ (記録が応答を変えない)」。route のどの 1 か所の呼び出しを消しても、その分岐の it が赤になる (走査 §20.3 と合わせて、呼び忘れを 2 つの面で見る)
- `cron-login-alerts-route.test.ts` (B): 「processLoginAlerts に createLoginAlertWorkerDeps(getSupabaseAdmin()) の deps を渡し、route は sendEmail を呼ばない」「CRON_SECRET が合わなければ 401」「AUTH_LOGIN_ALERT=off を worker に渡す」「不正な値は変数名だけを warn に出す」「応答は件数だけ ({ claimed, queued, skipped, failed })」
- `admin-user-login-history-route.test.ts` (D): 「support は 403」「admin は 20 件を返し admin.user.view_login_history を 1 行記録する」「行は getSupabaseAdmin() の client で読み、recordAdminAudit には createClient() の client を渡す (service_role の client を渡さない §14.9)」「0 件のときは記録しない」「UUID でなければ 404」

### 20.3 走査・契約 (`tests/`)

- `auth-history-sessions-migration-contract.test.ts` (A): 「トリガー関数 5 本のうち auth の表の 4 本は SECURITY DEFINER、user_profiles_fill_login_stats は SECURITY INVOKER で、5 本とも search_path = ''・EXCEPTION WHEN OTHERS を持つ」「SQL の /24・/48・30 days・90 days・c_max_generations 10 が constants.ts / policy.ts の値と一致する」「auth.sessions に 3 本・auth.users に 1 本・user_profiles に 1 本 (BEFORE INSERT) のトリガーを CREATE する」「RPC 4 本と保守 3 本の REVOKE / GRANT が決めたとおり (claim_login_alerts・release_login_alert は SECURITY INVOKER で service_role だけ)」「claim_login_alerts は 4 つの引数 (p_max_age_hours を含む) を持ち、作成から p_max_age_hours を過ぎた行を FOR UPDATE SKIP LOCKED で選んで done にする文と、作成から p_max_age_hours 以内の候補を FOR UPDATE SKIP LOCKED で選んで processing にする文を持つ」「user_sessions_metadata.alert_status の列の既定は 'done' で (ADD COLUMN … DEFAULT 'done' §11.1)、auth_session_created の INSERT は alert_status に 'pending' を明示する」「migration は auth.sessions / auth.users に DROP TRIGGER を書かず、その 4 本の CREATE TRIGGER は、[cross16-auth-triggers:begin] / [cross16-auth-triggers:end] の目印の間で、それぞれ pg_trigger に同じ名前が無いときだけ (IF NOT EXISTS の中で) 行う (表の所有者でない postgres の 2 回目の適用が所有者の確認に当たらない §11.3)」「.down.sql は DROP TRIGGER を user_profiles の trg_user_profiles_fill_login_stats にだけ書き、auth の表には DROP TRIGGER も DISABLE TRIGGER も書かない。トリガー関数 4 本 (auth_session_created・auth_session_refreshed・auth_session_deleted・password_history_record) は DROP せず、本体が RETURN NULL だけの CREATE OR REPLACE FUNCTION にする (§11.7)」「.down.sql は、そのほかの migration の作るもの (RPC 4 本・保守 3 本・user_profiles_fill_login_stats・索引・制約・列・ジョブ) を消し、ポリシーと GRANT と user_profiles.last_login_at の COMMENT を戻す」「既存の行の写し (§11.2) は [cross16-backfill:begin] / [cross16-backfill:end] の目印の間にあり、user_sessions_metadata の写しは ON CONFLICT (session_id) DO NOTHING、password_history の写しは NOT EXISTS と ON CONFLICT (user_id, changed_at) DO NOTHING を持つ」「pg_cron のジョブの名前と時刻」
- `auth/web-login-context-source-scan.test.ts` (A): 「src/app の route.ts ごとに、コメント (`//`・`/* */`) を除いた本文の `.signInWithPassword(`・`.exchangeCodeForSession(`・`.verifyOtp(` の呼び出しの数より、`recordWebLoginContextFromRequest(` の呼び出しの数が少ないファイルは無い (分岐を足して呼び忘れると赤。callback の 3 か所のどれか 1 つの呼び出しを消しても赤。分岐ごとの対応は route のテスト §20.2 が見る)」「数えたファイルに src/app/api/auth/login/route.ts と src/app/(auth)/auth/callback/route.ts が入っていて、どちらも session を作る呼び出しが 1 つ以上ある (走査が空振りしない)」
- `auth/password-update-source-scan.test.ts` (C): 「src と apps/mobile の本番コードに updateUser({ password の呼び出しが無い (API を通す)」「signInWithPassword を本人確認に使う画面 (settings/account・account-credentials) が無い」「src/app/api/auth/sessions/revoke-others/route.ts と src/app/api/auth/password/**/route.ts は auth.signOut( と auth.updateUser( を呼ばない (本人の access token で GoTrue を呼ぶ §13.7・§14.3。Bearer だけの要求で黙って失敗する形に戻さない)」
- `src/__tests__/lib/emails/secret-templates.test.ts` (B。既存。表 `PUBLIC_TEMPLATES` に `login_new_device: ['country_code']` の 1 行を足す §22 N-40。it は変えない): 「すべての文面が表のどちらかに載っていて、表に余分な行が無い」「%s が使うリンク・トークンの項目は、表のその文面の行と同じ」「%s は、秘密ありの文面のときだけ contains_secret: true を書いている」が `login_new_device` (`account/login-new-device.ts`) でも通る
- `tests/email-send-throttle-contract.test.ts` (B。既存。`EXEMPT_EMAIL_SENDERS` に 1 項目 §22 N-18。it は変えない): 「除外リストの項目は実在し、今もメールを送り、判定を通していない」が `src/lib/auth/sessions/login-alert-worker.ts` で通る
- `tests/email-resend-boundary-scan.test.ts` (B。既存。変えない §22 N-41): 段 B のファイルが Resend を直接使わないので緑のまま (走らせて確認)
- `tests/env-setup-cron-secret-crons.test.ts` (B。既存。変えない §22 N-43): 「行が挙げる /api/cron/* の path の集合が、vercel.json の crons の path の集合と同じ」が、`vercel.json` の `/api/cron/login-alerts` と `ENV_SETUP.md` の `` `CRON_SECRET` `` の行の追記 (§23) で緑のまま (走らせて確認)
- `tests/integration/security/auth-history-sessions.test.ts` (A。ローカル Supabase): 「プロフィールの行がある利用者がパスワードでサインインすると、user_sessions_metadata に 1 行 (ip / user_agent / ip_network) が入り、user_profiles.last_login_at がその行の created_at に、login_count が 1 増える」「プロフィールの行が無い利用者 (admin.createUser の直後) のサインインも成功し、user_sessions_metadata に 1 行が入る (user_profiles は 0 行の更新)。そのあと accept_legal_documents と同じ列で user_profiles の行を作ると、last_login_at = そのセッションの created_at・login_count = 1 が入る (S-1)」「last_login_at を明示して作る user_profiles の行は、トリガーが変えない」「refresh で last_active_at が進み、user_agent は変わらない (盗んだ refresh token の使用 S-36 の経路も同じ。行は増えず、alert_status も変わらない)」「recordWebLoginContext は context_source が auth で alert_status が pending の行を web にして true を返す。終わった (revoked_at の入った) pending の行も上書きする。alert_status を processing・done にした行と、context_source が mobile の行は変えずに false を返す。行の無い session_id (新しい UUID) でも false を返す (§10)」「signOut (global) で revoked_at と signed_out」「auth_session_revoke は他人の行を消せず not_found、本人の他の行を消すと revoked、自分の行は current」「消した後の JWT で getUser すると session_not_found」「updateUser (GoTrue の PUT /user を本書の API を通さずに呼ぶ = S-33 の経路) で password_history が 1 行増え、11 回変えると 10 行に切り詰まる (照合は通らないが記録は漏れない)」「updateUser({ email }) (メールアドレス変更の申し込み。確認のメールを送るだけ) は error 無しで返り、その前後で password_history の行数も、その利用者の user_sessions_metadata の行数も変わらない (サインインはその前に済ませる。§8 の行 34。password_history_record は encrypted_password が前と同じ UPDATE では行を足さない §11.3)」「auth_password_check が §11.5 の決定表の 7 行を返す: bcrypt の利用者は変更で current_mismatch / reused / ok、再設定 (p_current_password = NULL) で reused / ok。パスワード無しで作った利用者 (admin.createUser に password を渡さない。GoTrue v2.183.0 はそれでも乱数のパスワードの bcrypt を encrypted_password に入れ、トリガーが password_history に 1 行を書くので、作った直後に pgQuery で encrypted_password を '' にし、その 1 行を消して Google / Apple だけの利用者の形にする) は変更で no_password、再設定で ok。encrypted_password を pgQuery で `$argon2id$` で始まる値にした利用者は変更で unsupported_hash、再設定で ok (bcrypt の履歴と同じなら reused)」「パスワード無しで作った利用者が generate_link (recovery) → POST /verify (token_hash) の JWT で updatePasswordWithAccessToken (第 3 引数 null) を呼ぶと、encrypted_password が bcrypt になり password_history が 1 行になる (S-28)」「expire_idle_auth_sessions が refreshed_at の古い行だけを消して idle_expired にする」「reconcile が auth.sessions に無い live の行を signed_out にする」「cleanup が 90 日より古い終了行だけを消す」「anon / authenticated は 7 本の関数 (RPC 4 本と保守 3 本) のうち auth_session_revoke だけを (authenticated が) 実行できる」「記録の失敗でログインを止めない (R-13・S-20): pgQuery で `ALTER TABLE public.user_sessions_metadata ADD CONSTRAINT cross16_test_force_fail CHECK (false) NOT VALID` を足した間、プロフィールの行がある利用者のパスワードのサインインは成功し (session が返り、その access token で getUser が通る)、auth.sessions にその session_id の行があり、user_sessions_metadata にはその session_id の行が無く、user_profiles.login_count は増えない (auth_session_created の本体の INSERT が失敗して UPDATE ごと巻き戻る)。finally で `ALTER TABLE public.user_sessions_metadata DROP CONSTRAINT IF EXISTS cross16_test_force_fail`」「記録の失敗で更新 (refresh)・ログアウトを止めない (R-13・S-20。auth_session_refreshed・auth_session_deleted): 先に制約を足さずにサインインし、user_sessions_metadata にその session_id の行があること (revoked_at が NULL) を確かめ、その行の last_active_at を控える。そのあと pgQuery で `ALTER TABLE public.user_sessions_metadata ADD CONSTRAINT cross16_test_force_fail CHECK (false) NOT VALID` を足した間に、refreshSession は error 無しで新しい session を返し、pgQuery で読む auth.sessions のその行の refreshed_at は前と変わる (サインインの直後は NULL。トリガーの WHEN が真 = 本体が動いた) が、user_sessions_metadata の行の last_active_at は控えた値のまま (本体の UPDATE が CHECK で失敗し、握られて巻き戻る)。続けて refresh の後の session で signOut (global) も error 無しで成功し、auth.sessions のその行は消え、user_sessions_metadata の行は revoked_at も ended_reason も NULL のまま (同じく巻き戻る)。finally で DROP CONSTRAINT IF EXISTS (live のまま残った行は、別の it の reconcile の対象になる §10 のトリガーの失敗の行)。制約を足す前に行を作るのが要: 行が無いと 2 つの UPDATE は 0 行の更新で CHECK に当たらず、EXCEPTION の枝を通らない」「履歴の記録の失敗でパスワードの更新を止めない (R-13): pgQuery で `ALTER TABLE public.password_history ADD CONSTRAINT cross16_test_force_fail CHECK (false) NOT VALID` を足した間、updatePasswordWithAccessToken は error が null で、auth.users.encrypted_password は変わり、password_history の行数は変わらない。finally で DROP CONSTRAINT IF EXISTS」「ログインの数の補完の失敗でプロフィールの行の作成を止めない (R-13): pgQuery で `REVOKE SELECT ON public.user_sessions_metadata FROM service_role` をした間、service_role の client で user_profiles に `{ id, nickname: 'Guest', age_group: 'unspecified', gender: 'unspecified' }` (accept_legal_documents と同じ既定値) を INSERT すると、error 無しで行ができ、last_login_at は NULL のまま (user_profiles_fill_login_stats は SECURITY INVOKER なので service_role として SELECT し、権限の不足を握る)。finally で `GRANT SELECT ON public.user_sessions_metadata TO service_role`。R-13 の 4 つの it は、どれも失敗させる書き込み・読み取りが必ず起きる形 (INSERT は必ず 1 行・UPDATE は行がある状態・SELECT は権限の確認) で、対応するトリガー関数 (auth_session_created / auth_session_refreshed と auth_session_deleted / password_history_record / user_profiles_fill_login_stats) の EXCEPTION WHEN OTHERS を消すと、サインイン・refresh とログアウト・パスワードの更新・INSERT が失敗して赤になる (WARNING は GoTrue・PostgREST の接続に返るのでテストからは読まない)」「Cookie を持たず Bearer の JWT だけで updatePasswordWithAccessToken を (第 3 引数に現在のパスワードを入れて) 呼ぶと、encrypted_password が変わり、呼んだセッションは残り、同じ利用者の他のセッションは消える (本文の current_password は、GoTrue の UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD が OFF のローカルでも更新を妨げない)」「signOutOtherSessions(admin, Bearer の JWT) は同じ利用者の他のセッションを消し、呼んだセッションは残す」「generate_link (recovery) → POST /verify (token_hash) で作ったセッションの JWT は amr に otp を持ち、hasRecentRecoveryMethod が真」「パスワードでサインインしたセッションの JWT は amr が password で、hasRecentRecoveryMethod が偽」「listPriorLogins は created_at が 90 日より前の live の行も返し、自分の行と、後に作られた行は返さない」「claimLoginAlerts を 2 つ同時に (Promise.all で) 呼ぶと、同じ pending の行はどちらか一方だけが返し、両方の戻りの session_id に重なりが無い (S-19)」「claimLoginAlerts は created_at が minAgeSeconds より新しい行と done の行を取らず、取った行を processing・alert_claimed_at = now にする」「claimLoginAlerts は processing のまま alert_claimed_at が reclaimMinutes より前の行を取り直し、reclaimMinutes 以内の processing の行は取らない (§10 の取り置きの行)」「claimLoginAlerts は 1 回に batchSize 行までしか取らない」「claimLoginAlerts は、created_at が maxAgeHours より前の pending の行と、created_at が maxAgeHours より前で alert_claimed_at が reclaimMinutes より前の processing の行を返さず、done にする (alert_claimed_at は NULL、device_family・is_new_*・alert_sent_at は NULL のまま)。同じ呼び出しで、created_at が maxAgeHours 以内の pending の行は返す (サインインで作った 3 行の created_at を pgQuery で 25 時間前・25 時間前 (processing・alert_claimed_at は 11 分前)・23 時間前にする。§10 の期限切れの行・S-34)」「claimLoginAlerts は、created_at が maxAgeHours より前でも、done の行と、alert_claimed_at が reclaimMinutes 以内の processing の行 (ほかの worker が処理中) は変えない」「alert_status を指定せずに user_sessions_metadata に INSERT した行 (pgQuery。user_id はテストの利用者・session_id は新しい UUID・created_at は 1 分前) は done で、claimLoginAlerts が取らない (列の既定 §11.1・S-35)」「claimLoginAlerts は revoked_at のある (終わった) pending の行も取り (サインインして minAgeSeconds より前に signOut した行)、finishLoginAlert で done にする。revoked_at と ended_reason は変わらない (§10 の ended の行・S-29)」「releaseLoginAlert は processing の行の alert_attempts を 1 増やして pending に戻し (alert_claimed_at は NULL)、maxAttempts 回目 (attempts が 3 になる回) で done にする。processing でない行は変えない (§10 の例外の行)」「finishLoginAlert は done にして device_family・is_new_*・alert_sent_at を書く」「recordWebLoginContext は context_source = auth の行を web にして IP・ip_network・UA・国を書き true、context_source = mobile の行 (端末名あり) と web の行は変えずに false (§10 の recordWebLoginContext の行のガード)」「setCurrentDeviceName は本人の行に device_name と context_source = mobile を書き、他人の session_id では false」「migration の [cross16-backfill:begin] と [cross16-backfill:end] の間 (§11.2) を切り出し、ローカルの postgres-meta (`/pg/query`。anon-definer-execute.test.ts の pgQuery と同じ口) でもう一度流しても、user_sessions_metadata と password_history の行数は変わらない (冪等)」「migration の [cross16-auth-triggers:begin] と [cross16-auth-triggers:end] の間 (§11.3 の auth の表のトリガーを作る DO ブロック) を切り出し、pgQuery でもう一度流しても失敗せず、pg_trigger の on_auth_session_created・on_auth_session_refreshed・on_auth_session_deleted (auth.sessions)・on_auth_user_password_changed (auth.users) は 1 本ずつのまま (同じ名前があれば作らない)」「auth.admin.deleteUser で、その利用者の user_sessions_metadata と password_history の行が消える (FK の CASCADE。S-24)」「サインインしたセッションの access_token と refresh_token を、別の client (persistSession: false) の auth.setSession に渡しても (`/auth/native-bridge` の establishSession と同じ呼び方)、その利用者の user_sessions_metadata の行数は変わらず、行の session_id は setSession の後の getClaims の session_id と同じ (WebView はネイティブの行を借り、行を増やさない。S-23)」

- `tests/integration/security/password-max-bytes.test.ts` (#1864。ローカル Supabase): 「M-1 signUp: 72 バイト以下は登録でき、72 バイトを超えると 400 validation_failed」「M-2 PUT /auth/v1/user (updatePasswordWithAccessToken) も同じ境目」「M-3 validatePassword の判定は GoTrue の判定とすべての試料で一致する」「M-4 pgcrypto (auth_password_check) は 72 バイトより後ろだけが違うパスワードを区別しない」「M-5 72 バイトを超える既存のパスワードの利用者はログインでき、現在のパスワードとして渡して変えられる」

### 20.4 画面 (Web `src/__tests__/app/`・モバイル `apps/mobile/__tests__/`)

- `settings/sessions-page.test.tsx` (B): 「ログイン中の端末を一覧し、この端末にはバッジを出して解除のボタンを出さない」「解除は確認のあと DELETE を呼び、成功したら一覧から消す」「他の端末をすべてログアウトは確認のあと POST を呼ぶ」「最近のログインの印 (新しい端末・地域) を出す」「端末の見出しは device_label で、device_name は『端末名: …』として添え、見出しにしない (S-31)」「読み込み失敗ともう一度読み込む」「未ログインの案内」
- `settings/account-page.test.ts` (C。既存の書き換え。describe ごとの扱いは §22 N-24): 成功の it を「POST /api/auth/password/change を 1 回呼び、signInWithPassword / updateUser / signOut を呼ばない」に。再認証の失敗の it を「400 AUTH_CURRENT_PASSWORD_MISMATCH で『現在のパスワードが正しくありません』」に。「422 VALID_PASSWORD_HISTORY の文言」「403 AUTH_REAUTHENTICATION_REQUIRED の文言」を足す。「他の端末のログアウトを確認できなかった」の it は削除。Turnstile の it は削除
- `src/__tests__/lib/auth/logout-guidance.test.ts` (C。既存の書き換え §22 N-33): 「アカウント画面は、案内の文を直書きせず、この出し分けを使う」の it から `describeOthersNotSignedOutNote` の期待を外し、`not.toContain('describeOthersNotSignedOutNote')` を足す。describe「#1552 他の端末のログアウトを確認できなかったときの注意書き」は削除
- `apps/mobile/__tests__/settings/sessions.test.tsx` (B): 「一覧・この端末・解除・他の端末をすべて・最近のログイン」の 5 本
- `src/__tests__/app/settings/account-link.test.ts` (B。既存に it を足す): 「設定の『アカウント』に data-testid="settings-sessions-link" があり /settings/security/sessions を指す」
- `apps/mobile/__tests__/settings/sessions-entry.test.tsx` (B。新規。`ai-consent-entry.test.tsx` と同じ mock の形で `app/(tabs)/settings.tsx` を描く): 「アカウントに testID="settings-sessions-row" の行があり、押すと /settings/sessions へ router.push する」
- `apps/mobile/__tests__/providers/auth-provider.test.tsx` (B。既存に it を足す。`../../src/lib/device-name` を jest.mock する): 「SIGNED_IN でセッションの access token を registerDeviceName に渡す」「INITIAL_SESSION でセッションがあれば、その access token で registerDeviceName を呼ぶ」「SIGNED_OUT のあとに別のセッションで SIGNED_IN すると、新しい access token でもう一度呼ぶ」「セッションが無い (未ログインで起動・SIGNED_OUT) ときは呼ばない」「registerDeviceName が reject しても、セッションの状態と掃除の表 (既存の it) は変わらない」
- `tests/admin-user-login-history-page.test.tsx` (D。新規。`tests/admin-preparing-pages.test.tsx` と同じ形: `requireRole` と `adminFetch` を mock し、`renderToStaticMarkup(await Page({ params }))` で描く): 「admin は /api/admin/users/{id}/login-history を呼び、『ログイン履歴 (直近 20 回)』の節に日時 (日本時間。2026-10-15T01:00:00Z は 10:00 と出る)・端末 (device_label。device_name があれば『(端末名: …)』を添える)・IP・国・印・alert_sent_at (日本時間。null は『なし』)・終了の理由を出し、列見出しは左から『日時』『端末』『IP』『国』『印』『通知メールを送信待ちに登録した日時』『終了』の 7 つ (§17 の逐語。見出しが『通知メール』だけの形を通さない)」「support は login-history を呼ばず (adminFetch の呼び出しに login-history が無い)、節を出さない」「0 件は『記録なし』」「login-history の応答が 403 / 500 なら節に『ログイン履歴を読み込めませんでした』を出し、利用者詳細の他の節は出る」
- `apps/mobile/__tests__/lib/device-name.test.ts` (B。`jest.resetModules()` で it ごとに読み直す): 「expo-device の modelName と OS の名前・版から 200 文字以内の端末名を作る (例 iPhone 15 Pro (iOS 18.0))」「使えない文字 (日本語・’・: / @・改行) を除き、続く空白を 1 つに畳む。Device.deviceName (利用者が付けた名前) は使わない」「modelName が null なら Platform.OS を使う」「同じ access token では 1 回だけ PATCH する (同時に 2 回呼んでも 1 回)」「別の access token (ログアウトしてログインし直した) ではもう一度 PATCH する」「PATCH が失敗したら例外を投げず、同じ access token の次の呼び出しで送り直す」「warn に access token と端末名を出さない」
- `apps/mobile/__tests__/lib/account-credentials.test.ts` (C。書き換え): 「API を 1 回呼び、Supabase の signInWithPassword / updateUser / signOut を呼ばない」「成功は { ok: true } (othersSignedOut を持たない)」「400 / 422 / 403 / 通信エラーの文言」
- `apps/mobile/__tests__/settings/account-credentials.test.tsx` (C。書き換え §22 N-27): 「3. パスワードの変更の API を 1 回呼び、成功を表示して入力を消す」「成功の帯は常に『この端末以外のログインはすべて解除しました』」(「他の端末のログアウトを確認できなかったときは、成功に注意書きを添える」の it は削除)「4. 現在のパスワードが違えば (400)、理由を表示し、入力は残す」「連打しても、API は 1 回しか呼ばない」
- `apps/mobile/__tests__/auth/reset-password.test.tsx` (C。書き換えの中身は §22 N-28): 「1. パスワードが一致しないとき API を呼ばない」「2. 8 文字未満のとき長さエラーを出し、API を呼ばない」「3. 正常な入力で POST /api/auth/password/reset に { new_password } を送り、updateUser を呼ばない」「4. 更新後のサインアウトは、呼ぶ前のセッションの利用者 ID を共通のログアウト処理に渡し、ログイン画面へ移る」「5. 422 のときは本文の error (最近使ったパスワード…) を『更新失敗』で出し、サインアウトしない」「6. 403 AUTH_RECOVERY_SESSION_REQUIRED のときは本文の error (再設定メールのリンクから…) を出し、サインアウトしない」

## 21. 触るファイルの母集合・新設一覧・段

### 21.1 新設 (ファイル)

| 段 | ファイル | 中身 |
|---|---|---|
| A | `supabase/migrations/<番号はマージ時に確定>_auth_history_sessions.sql` / `supabase/rollbacks/<番号はマージ時に確定>_auth_history_sessions.down.sql` | §11 |
| A | `src/lib/auth/sessions/constants.ts`・`device-family.ts`・`ip-network.ts`・`login-alert-policy.ts`・`session-claims.ts`・`schemas.ts`・`store.ts`・`request-context.ts`・`web-login-context.ts` | §12.1〜12.5・§13.1・§13.5 |
| A | `src/lib/auth/password/policy.ts`・`change.ts`・`gotrue-user.ts` | §12.2・§13.2・§13.7 |
| A | テスト: §20.1 の段 A の 10 本 (`sessions-device-family`・`sessions-login-alert-policy`・`sessions-session-claims`・`password-gotrue-user`・`sessions-constants`・`sessions-web-login-context`・`sessions-ip-network`・`sessions-request-context`・`password-policy`・`password-change`)・§20.2 の `tests/api/auth-login-context.test.ts`・§20.3 の走査 `tests/auth/web-login-context-source-scan.test.ts`・契約 `tests/auth-history-sessions-migration-contract.test.ts`・結合 `tests/integration/security/auth-history-sessions.test.ts` | §20 |
| B | `src/lib/auth/sessions/login-alert-worker.ts`・`client.ts`・`src/lib/emails/account/login-new-device.ts` | §13.3・§15・§18 |
| B | `src/app/api/auth/sessions/route.ts`・`sessions/[id]/route.ts`・`sessions/current/route.ts`・`sessions/revoke-others/route.ts`・`login-history/route.ts`・`src/app/api/cron/login-alerts/route.ts` | §14.1〜14.5・§14.8 |
| B | `src/app/(main)/settings/security/sessions/page.tsx`・`apps/mobile/app/settings/sessions.tsx`・`apps/mobile/src/lib/sessions-api.ts`・`apps/mobile/src/lib/device-name.ts` | §15・§16 |
| B | テスト: `sessions-login-alert-worker.test.ts`・`sessions-client.test.ts`・`src/__tests__/lib/emails/account/login-new-device.test.ts`・`tests/api/auth-sessions-routes.test.ts`・`tests/api/cron-login-alerts-route.test.ts`・画面と端末名 4 本 (`src/__tests__/app/settings/sessions-page.test.tsx`・`apps/mobile/__tests__/settings/sessions.test.tsx`・`apps/mobile/__tests__/settings/sessions-entry.test.tsx`・`apps/mobile/__tests__/lib/device-name.test.ts`) | §20 |
| C | `src/app/api/auth/password/change/route.ts`・`reset/route.ts`・`src/lib/auth/password/client.ts` | §14.6・14.7 |
| C | テスト: `tests/api/auth-password-routes.test.ts`・`tests/auth/password-update-source-scan.test.ts`・`password-client.test.ts`・`password-change-api-errors.test.ts` (どちらも `src/lib/auth/__tests__/`) | §20 |
| D | `src/app/api/admin/users/[id]/login-history/route.ts`・`tests/api/admin-user-login-history-route.test.ts`・`tests/admin-user-login-history-page.test.tsx` | §14.9・§17・§20.4 |

### 21.2 新設 (識別子)

| 種類 | 名前 |
|---|---|
| 定数 | `IP_NETWORK_PREFIX_V4`・`IP_NETWORK_PREFIX_V6`・`LOGIN_HISTORY_RETENTION_DAYS`・`SESSION_IDLE_EXPIRE_DAYS`・`LOGIN_ALERT_BATCH_SIZE`・`LOGIN_ALERT_MIN_AGE_SECONDS`・`LOGIN_ALERT_RECLAIM_MINUTES`・`LOGIN_ALERT_MAX_ATTEMPTS`・`LOGIN_ALERT_MAX_AGE_HOURS`・`LOGIN_HISTORY_PAGE_SIZE`・`AUTH_LOGIN_ALERT_ENV_NAME`・`SERVER_DEVICE_FAMILY_KEY`・`UNKNOWN_DEVICE_FAMILY_KEY`・`PASSWORD_HISTORY_GENERATIONS`・`PASSWORD_HISTORY_MAX_GENERATIONS`・`PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES`・`RECOVERY_AMR_METHODS`・`LOGIN_ALERT_PRIOR_MAX_ROWS`・`GOTRUE_API_VERSION`・`GOTRUE_API_VERSION_HEADER`・`GOTRUE_USER_PATH`・`PASSWORD_INPUT_MAX_LENGTH`・`DEVICE_NAME_MAX_LENGTH`・`DEVICE_NAME_PATTERN`・`SESSIONS_SETTINGS_PATH`・`ACCOUNT_SETTINGS_PATH`・モバイルの `DEVICE_NAME_DISALLOWED_CHARS` (`apps/mobile/src/lib/device-name.ts`) |
| Zod | `SessionRowSchema`・`SessionClaimsSchema`・`PasswordChangeBodySchema`・`PasswordResetBodySchema`・`DeviceNameBodySchema`・`EndedReasonSchema`・`SessionSummarySchema`・`SessionsResponseSchema`・`LoginHistoryEntrySchema`・`LoginHistoryResponseSchema` |
| 型・クラス | `SessionUserContext`・`SessionUserProfileReadError` (例外のクラス)・`LoginAlertMode`・`LoginAlertSetting`・`DeviceOs`・`DeviceClient`・`DeviceFamily`・`LoginContext`・`LoginAlertReason`・`LoginAlertDecision`・`LoginHistoryHorizon`・`SessionClaims`・`SessionClaimsReader`・`SessionAuth`・`PriorLoginRow`・`LoginAlertAccount`・`FetchLike`・`ContextSource`・`EndedReason`・`AlertStatus`・`SessionRow`・`RevokeOutcome`・`PasswordCheckOutcome`・`PasswordChangeInput`・`UpdatePasswordOutcome`・`PasswordChangeDeps`・`PasswordChangeResult`・`LoginAlertRow`・`PriorLogin`・`LoginAlertWorkerDeps`・`LoginAlertWorkerSummary`・`SessionSummary`・`LoginHistoryEntry`・`LoginNewDeviceEmailVars` |
| 関数 | `resolveLoginAlertMode`・`deviceFamilyOf`・`deviceLabelOf`・`ipNetworkOf`・`decideLoginAlert`・`bearerTokenOf`・`readSessionAuth`・`hasRecentRecoveryMethod`・`requireSessionUser`・`passwordHistoryGenerationsFor`・`performPasswordChange`・`updatePasswordWithAccessToken`・`listLiveSessions`・`listLoginHistory`・`listPriorLogins`・`revokeSession`・`signOutOtherSessions`・`setCurrentDeviceName`・`recordWebLoginContext`・`recordWebLoginContextFromRequest`・`claimLoginAlerts`・`finishLoginAlert`・`releaseLoginAlert`・`processLoginAlerts`・`createLoginAlertWorkerDeps`・`countryCodeOf`・`renderLoginNewDeviceEmail`・Web の `listSessions` / `revokeSession` / `revokeOtherSessions` / `listLoginHistory` / `changePassword` / `resetPassword`・共通の `describePasswordChangeApiError`・モバイルの `deviceNameOf` / `registerDeviceName` |
| route | `GET /api/auth/sessions`・`DELETE /api/auth/sessions/{id}`・`PATCH /api/auth/sessions/current`・`POST /api/auth/sessions/revoke-others`・`GET /api/auth/login-history`・`POST /api/auth/password/change`・`POST /api/auth/password/reset`・`GET /api/cron/login-alerts`・`GET /api/admin/users/{id}/login-history` |
| 画面 | `/settings/security/sessions` (Web)・`/settings/sessions` (モバイル) |
| 列 (`user_sessions_metadata`) | `ip_network`・`country_code`・`context_source`・`device_family`・`is_new_device`・`is_new_ip`・`is_new_country`・`alert_status`・`alert_claimed_at`・`alert_attempts`・`alert_sent_at`・`ended_reason` |
| 索引・制約 | `idx_sessions_alert_queue`・`idx_sessions_ended`・`user_sessions_metadata_context_source_check`・`_alert_status_check`・`_ended_reason_check` |
| DB の関数 | トリガー関数 `auth_session_created`・`auth_session_refreshed`・`auth_session_deleted`・`password_history_record`・`user_profiles_fill_login_stats` / RPC `auth_session_revoke(uuid)`・`auth_password_check(uuid, text, text, integer)`・`claim_login_alerts(integer, integer, integer, integer)`・`release_login_alert(text, integer)` / 保守 `expire_idle_auth_sessions()`・`reconcile_user_sessions_metadata()`・`cleanup_ended_user_sessions_metadata()` |
| トリガー | `on_auth_session_created`・`on_auth_session_refreshed`・`on_auth_session_deleted` (`auth.sessions`)・`on_auth_user_password_changed` (`auth.users`)・`trg_user_profiles_fill_login_stats` (`user_profiles`・BEFORE INSERT) |
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
| A | `tests/integration/security/anon-definer-execute.test.ts` | 決定表 `EXPECTED_ACL` に SECURITY DEFINER の 8 本の行を足す (§22 N-19) |
| A | `src/app/api/auth/login/route.ts`・`src/app/(auth)/auth/callback/route.ts` | session を作る呼び出し (login の 1 か所・callback の 3 か所) の成功の直後に `recordWebLoginContextFromRequest` (§13.5) |
| A | `tests/jst-today-source-scan.test.ts` | 許可リスト `ALLOWLIST` に `src/lib/auth/sessions/store.ts` の規則 G を 1 件足す (§22 N-39) |
| A | `docs/design/operator/01-data-model.md`・`docs/design/cross/01-auth-session.md` (§3.2・§13.1・§13.3)・`docs/design/cross/02-rls-patterns.md` (§4.1・§9)・`docs/operations/auth-protection.md` | §23 の各行 (段 A の分) |
| — | `docs/design/cross/CLAUDE.md` | ファイル一覧に本書の行 (§23。段ではなく、オーケストレーターが設計のマージと同じ PR で) |
| — | `docs/requirements/03-operator-admin.md` (§17.1・§17.4) | 注記を 1 行ずつ (§23。段ではなく、足すか・要件の文を改めるか・いつかはオーケストレーターが決める §25 Q-17) |
| B | `src/app/(main)/settings/page.tsx`・`apps/mobile/app/(tabs)/settings.tsx`・`apps/mobile/src/providers/AuthProvider.tsx` | 導線・端末名の登録 (§15・§16) |
| B | `src/__tests__/app/settings/account-link.test.ts`・`apps/mobile/__tests__/providers/auth-provider.test.tsx`・`apps/mobile/__tests__/providers/auth-provider-sign-out-cleanup.test.tsx`・`apps/mobile/__tests__/lib/web-view-auth-messages.real-auth.test.ts`・`src/__tests__/lib/emails/templates-site-config.test.ts` | 導線の it・`device-name` の mock と it・メールの一覧 (§20.4・§22 N-35・N-37) |
| B | `docs/design/cross/01-auth-session.md` (§3 のシーケンス図の `participant Next`・§4.3・§4.4・§16・§17)・`docs/design/cross/04-api-conventions.md` (段 B の 2 code)・`docs/design/mobile/05-auth-session.md`・`ENV_SETUP.md`・`src/lib/account-export-tables.ts` (`user_sessions_metadata` の理由の文) | §23 の各行 (段 B の分) |
| A | `docs/design/operator/08-cron-batches.md` | pg_cron の記述 (§3.0・§3.1 の注記) にジョブ `cleanup-auth-sessions-and-login-history` を足し本数を +1 (§22 N-32・§23) |
| B | `vercel.json`・`src/lib/env.ts`・`.env.example` | cron・`AUTH_LOGIN_ALERT` (§12.6 の逐語。`ENV_SETUP.md` は上の文書の行。`vercel.json` に cron を足すので、同じ PR で `ENV_SETUP.md` の `` `CRON_SECRET` `` の行にも `/api/cron/login-alerts` を足す。§22 N-43・§23 の `ENV_SETUP.md` の行の ②) |
| B | `docs/design/operator/08-cron-batches.md` | Vercel Cron の記述 (§3.0・§3.2 の表と注記・§5 の注記) に `login-alerts` を足し本数を +1 (origin/main 9f4f6da8 では 4 → 5 本。§22 N-32・§23 の逐語) |
| B | `src/__tests__/lib/env.test.ts`・`tests/ai-usage-contract.test.ts`・`tests/email-send-throttle-contract.test.ts`・`src/__tests__/api/null-character-routes.test.ts`・`src/__tests__/lib/emails/secret-templates.test.ts`・(赤なら) `tests/helpers/ai-consent-enforced-paths.ts` | 前の 5 本は必ず書き換える (走らせて赤かを見る条件つきではない。どれも直書きの一覧に足す: §22 N-2 (env.test.ts の `readOnlyBy` の配列・it の名前・`typeOnly`)・N-12・N-18 (`EXEMPT_EMAIL_SENDERS` の項目は逐語)・N-14 (B の `PATCH sessions/current` を `ENTRIES` に)・N-40 (`PUBLIC_TEMPLATES` に `login_new_device: ['country_code']`))。(赤なら) の `tests/helpers/ai-consent-enforced-paths.ts` だけは、走らせて赤のときに §22 N-11 のとおり足す |
| C | `src/lib/rate-limit.ts` | カテゴリ 2 つ |
| C | `src/app/(main)/settings/account/page.tsx`・`src/app/(auth)/auth/reset-password/page.tsx`・`apps/mobile/src/lib/account-credentials.ts`・`apps/mobile/src/components/settings/AccountCredentialsSection.tsx`・`apps/mobile/app/(auth)/auth/reset-password.tsx`・`packages/shared/src/account-change-errors.ts` | API 経由 (§15・§16) |
| C | `tests/integration/security/account-credentials-change.test.ts` | 冒頭のコメントだけ (§22 N-38。assert は変えない) |
| C | `docs/design/cross/01-auth-session.md` (§9.1)・`docs/design/cross/04-api-conventions.md` (段 C の 5 code) | §23 の各行 (段 C の分) |
| C | `src/lib/auth/logout-guidance.ts` | `describeOthersNotSignedOutNote` を消す (呼ぶ所が無くなる §15・§22 N-33)。`describeForgotCurrentPasswordNote` と定数 3 つはそのまま |
| C | `src/__tests__/app/settings/account-page.test.ts`・`tests/auth/reset-password-session-revoke.test.ts`・`tests/auth-turnstile-resend-password-change.test.tsx`・`apps/mobile/__tests__/lib/account-credentials.test.ts`・`apps/mobile/__tests__/settings/account-credentials.test.tsx`・`apps/mobile/__tests__/auth/reset-password.test.tsx`・`src/__tests__/api/null-character-routes.test.ts`・`src/__tests__/app/faq/account-answers.test.ts`・`src/__tests__/lib/auth/logout-guidance.test.ts` | 必ず書き換える (走らせて赤かを見る条件つきではない。直し方は §22 N-14 (C の `POST password/change`・`POST password/reset` を `ENTRIES` に)・N-24〜N-28・N-31・N-33 のとおり) |
| C | (赤なら) `tests/helpers/ai-consent-enforced-paths.ts` | §22 N-11 (走らせて赤のときだけ `EXEMPT_ROUTES` に足す) |
| D | `src/app/admin/users/[id]/page.tsx` | ログイン履歴の節 (§17) |
| D | `docs/design/operator/02-api-spec.md`・`docs/design/operator/03-ui-spec.md`・`docs/design/operator/07-audit-monitoring.md` | §23 の各行 |

### 21.4 変えない既存のファイル (本設計で前提・挙動が変わるもの。変えないと決めた理由と確かめ方)

「走らせて確認」は、その段の PR の全件 (offload) で緑であることを見る。赤なら blocking (本書の設計の誤り) で、テストの期待を緩めて通さない。

| 段 | ファイル | 本設計で変わること | 判定 |
|---|---|---|---|
| A | `src/app/api/admin/users/route.ts` (:135 `last_login_before`・:140〜141 `sort=last_login`・:188)・`src/lib/admin/users-schemas.ts` (:24〜25・:64)・`src/app/admin/users/page.tsx` (:31 の型だけ)・テスト `tests/admin-users-date-filters.test.ts` | `user_profiles.last_login_at` が全員 NULL から、移行の後にログインした利用者だけ値を持つ形になる (§9) | 変えない。NULL の扱い (絞り込みに入らない・降順で先頭) は今までの式のまま。テストは偽の DB で式を見る (:267 は NULL を除く期待) ので変わらない (走らせて確認) |
| A | `src/app/api/operator/membership/org/[id]/candidates/route.ts` (:29・:32・:48)・`family/[id]/candidates/route.ts` (:49〜67)・`src/app/(operator)/operator/membership/orgs/[id]/transfer/page.tsx:140`・`families/[id]/transfer/page.tsx:140`・テスト `src/__tests__/api/operator/membership/org-candidates.test.ts`・`family-candidates.test.ts` | 候補が最終ログインの新しい順に並び、「最終ログイン」に日時が出始める (まだログインしていない人は末尾・`-`) | 変えない。テストは DB を mock した値で見るので変わらない (走らせて確認) |
| A | `src/app/api/admin/users/[id]/route.ts:162` (`last_login_at: profile.last_login_at ?? null`)・それを描く `src/app/admin/users/[id]/page.tsx:183〜186` (「最終ログイン」。この画面は段 D でログイン履歴の節を足す §21.3 が、この行は変えない)・テスト `tests/admin-pii-view-audit.test.ts` (:193・:341)・`tests/admin-users-email.test.ts:102`・`tests/admin-view-audit-1326.test.ts:189`・`tests/integration/security/admin-pii-view-audit.test.ts` | admin の利用者詳細の応答の `last_login_at` が全員 NULL (画面は `-`) から、移行の後にログインした利用者だけ日時を持つ形になる (§9) | 変えない。式は `?? null` のままで、まだログインしていない利用者は今までどおり NULL (`-`)。単体のテスト 3 本は DB を mock した値で見る。結合テストは監査の `viewed_fields` (返した項目名 `Object.keys(body.data)`。値が null の項目も含む) を見るので、値が入っても項目の集合は変わらない (走らせて確認) |
| A | `src/app/api/support/users/[id]/route.ts` (:49〜50 の select・:133〜134 の `lastLoginAt` / `loginCount`)・それを描く `src/app/(support)/support/users/page.tsx:286` (詳細の「n回」)・`apps/mobile/app/(support)/support/users/[id].tsx` (:131 回数・:135 最終ログイン。2026-10-16 に削除した。#1598)・テスト `tests/support-routes.test.ts` (:92〜93・:280)・`tests/integration/security/support-routes.test.ts`・`apps/mobile/__tests__/app/profile-name-placeholder-lists.test.tsx` (:55〜56・:80〜81。2026-10-16 に削除した。#1598) | support の利用者詳細の最終ログインが `-` から日時に、回数が 0 (列の既定) から移行の後のログインの数になる (§9)。この 2 列は本書の前から support に返している (ログイン履歴 (IP) は support に見せない §25 Q-10 のとは別) | 変えない。route は列をそのまま写すだけで、まだログインしていない利用者は今までどおり NULL (`-`)・0。単体のテストは DB を mock した値 (`login_count: 12` → `loginCount: 12`) で見る。結合テストはこの 2 項目を assert しない。モバイルのテストは mock の値で描く (走らせて確認) |
| A | `src/app/(support)/support/users/page.tsx:206` (一覧の「最終ログイン: …」)・テスト `tests/support-users-list-1717.test.tsx`・`apps/mobile/app/(support)/support/users.tsx:38` (2026-10-16 に削除した。#1598) | Web の一覧は `/api/admin/users` の行を API と同じ鍵 `last_login_at` (snake_case。`src/app/api/admin/users/route.ts:189`) で読む (#1717 で直った) ので、移行の後にログインした利用者から「最終ログイン」に日時が出始める (まだの人は `-`)。モバイルの一覧は camelCase の鍵 `lastLoginAt` で読むずれを持ったまま削除した | 変えない。テストは route の応答を偽の DB から作って画面に渡す (値のある行と NULL の行の両方) ので変わらない (走らせて確認) |
| — | `src/app/(operator)/operator/membership/families/inactive/page.tsx:28`・`orgs/inactive/page.tsx:30`・`src/components/operator/membership/InactiveOwnerTable.tsx:60` | 変わらない。非活動の判定と表示の値は `auth.users.last_sign_in_at` (GoTrue が書く) から来て、`user_profiles.last_login_at` を読まない。家族の一覧の「最終ログイン」は今までどおり `-` (直書きの null) | 変えない (本書の範囲の外)。`docs/design/membership/05-operator-emergency-ui.md` (:50・:60・:75) は非活動を `user_profiles.last_login_at` で判定・表示する形を書くが、実装は `auth.users.last_sign_in_at` を使う (本書の前からのずれ。本書では直さない §25 Q-19) |
| A | `tests/integration/rls/user-profiles-insert-guard.test.ts` | 本人 (authenticated) と service_role の `user_profiles` の INSERT / upsert のたびに BEFORE INSERT `trg_user_profiles_fill_login_stats` が動く。テストの利用者はサインイン済みなので、作られた行に `last_login_at` / `login_count` が入る。特権列の拒否 (42501) の it は、ガード `trg_guard_user_profiles_privileged_on_insert` の例外で文ごと巻き戻る (本書のトリガーは自分の失敗だけを握り、ガードの例外は握らない) | 変えない (走らせて確認)。`getProfile` は 2 列を select しないので期待は変わらない。ガードは 2 列を見ない (§11.3) ので、拒否・許可も変わらない。authenticated の INSERT で SECURITY INVOKER の読み取り (`sessions_self` の本人の行) が通る経路の回帰を、このテストが受け持つ (本書の結合テスト §20.3 は service_role の INSERT を見る) |
| A | `src/lib/account-self-service.ts` (`signOutAfterAccountDeletion`)・`src/app/api/account/delete/route.ts`・`src/lib/account-deletion.ts` (:330 `auth.admin.deleteUser`) | 退会で `auth.users` の行が消えると、`auth.sessions` の行の削除で `on_auth_session_deleted` が動き、`user_sessions_metadata` と `password_history` の行は FK の CASCADE で消える (§8 の行 18・S-24)。退会の後の `signOut()` は利用者が無いので GoTrue が断る (今までどおり catch で握る) | 変えない。テスト `tests/integration/security/account-delete-route.test.ts` (C: Bearer でサインインした利用者の退会が 200 = トリガーが CASCADE の中で動く経路) と `tests/integration/security/account-deletion.test.ts` (利用者はサインインしないが、`admin.createUser` の password で `on_auth_user_password_changed` が `password_history` に 1 行を書き、退会で CASCADE で消える) は走らせて確認 |
| C | `apps/mobile/__tests__/settings/account-delete.test.tsx` | 描く `app/settings/account` の部品 `AccountCredentialsSection` が段 C で変わる (§16) | 変えない。部品を mock している (`jest.mock('../../src/components/settings/AccountCredentialsSection', …)`) ので変わらない (走らせて確認) |
| B | `apps/mobile/__tests__/settings/logout.test.tsx` | 描く `app/(tabs)/settings.tsx` に「ログイン中の端末」の行 (`settings-sessions-row` §16) が足される | 変えない (走らせて確認)。行は押すまで何も呼ばない (描くときに API を呼ばない) ので、`getApi` の mock・ログアウトの順の期待は変わらない。testid の期待 (`settings-notifications-toggle`・`settings-logout-button`・`settings-account-row`) はそのまま残る |
| B | `src/__tests__/app/main-layout-signed-out.test.tsx` | 描く `src/app/(main)/settings/page.tsx` の「アカウント」に `settings-sessions-link` が足される (§15) | 変えない (走らせて確認)。期待 (ログアウトと退会が出ない・ネイティブの注記がある・ネイティブへ送る種類) は足す link に触れない |
| A | `tests/integration/security/password-update-revokes-sessions.test.ts` (P-1〜P-4。ローカル Supabase) | GoTrue の `updateUser({ password })`・`signOut({ scope: 'global' })`・`signOut({ scope: 'others' })`・`signInWithPassword`・`admin.createUser` / `deleteUser` を直接呼ぶ。段 A から、そのたびに `auth.sessions` の 3 本と `auth.users` の `on_auth_user_password_changed` が動き、`user_sessions_metadata` の行が作られて `signed_out` になり、`password_history` に 1 行が足される (§8 の行 31・S-33 と同じ経路。afterAll の `deleteUser` で CASCADE で消える) | 変えない (走らせて確認)。assert は GoTrue が返すセッションの生死とサインインの成否だけを見て、本書の表を読まない。トリガーは自分の失敗を握り、GoTrue の要求を止めない (R-13 §11.3) ので、P-1〜P-4 の結果は変わらない。P-3 のコメント「Web の /auth/reset-password と同じ呼び出し」は、段 C の後も GoTrue への要求として同じ (再設定の API がページの access token で `PUT /auth/v1/user` を呼び §13.7、ページがそのあと `signOut({ scope: 'global' })` を呼ぶ §22 N-25) なので直さない。GoTrue の `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` (§24・Q-18) を本番で ON にしても、ローカルのスタックの設定 (`supabase/config.toml`・`scripts/supabase-local.sh`) は本書では変えないので、このテストは変わらない |
| — | `src/__tests__/app/frozen-page-logout.test.tsx` | 変わらない。本書は `/frozen` の画面を変えず、ログアウトの記録は DB のトリガー (§8) で、テストは client を mock する | 変えない (各段の全件で緑のまま) |
| B | `src/lib/auth/sessions/store.ts` (`finishLoginAlert` の JSDoc「判定の結果と送信の結果を書く」・`sentAt`)・`src/lib/auth/sessions/schemas.ts` (`LoginHistoryEntrySchema.alert_sent_at`) (段 A。main にある) | v1.8 で `alert_sent_at` の意味を「通知メールを送信待ちに登録した日時」と定めた (§12.5・§13.4)。段 A のコードは値の経路 (`sentAt` → `alert_sent_at`) を持つだけで、意味は呼ぶ側 (段 B の worker) が決める | 変えない (段 A のファイルは段 B で変えない §0.2)。「送信の結果」= `send` の戻り (`sendEmail` の `ok`) で v1.8 でも正しい。意味の説明は本書 §12.5・§13.3・§13.4 と、段 B の `login-alert-worker.ts` の `send` / `finish` のコメントに書く (`COMMENT ON COLUMN` も足さない §25 Q-24) |
| B | `src/lib/emails/send.ts`・`send-result.ts`・`envelope.ts`・`outbox.ts`・`outbox-store.ts`・`src/app/api/cron/email-outbox/route.ts`・`src/app/api/cron/app-log-alerts/route.ts` (`checkEmailDeadLetters`)・`supabase/migrations/20261016234000_email_outbox.sql` (送信待ち。#1760・#1785) | 本書の通知メールがこの経路を通る (登録 → worker → sent / dead → 運用メール。再送の画面と API は operator/10 の段 C) | 変えない。本書は `sendEmail(envelope, { idempotencyKey, userId })` を呼ぶだけで、送信待ちの表・RPC・worker・運用メール・画面に本書の分岐を足さない (§7.1 の (b) を退けた理由)。`src/__tests__/lib/emails/send.test.ts`・`outbox.test.ts`・`outbox-store.test.ts`・`src/__tests__/api/cron/email-outbox.test.ts`・`app-log-alerts.test.ts`・`tests/email-outbox-migration-contract.test.ts`・`tests/integration/rls/email-outbox.test.ts`・`email-outbox-secret-templates.test.ts` は走らせて確認 |

## 22. 既存の番兵 (契約テスト・走査テスト) の追随表

grep の語 = 本設計が足す・変える名前。反応するテストと直し方。

| # | 番兵 | grep の語 | 反応する理由 | 直し方 | 段 |
|---|---|---|---|---|---|
| N-1 | `tests/database-types-migrations-contract.test.ts` | `auth_session_revoke`・`auth_password_check`・`claim_login_alerts`・`release_login_alert`・`expire_idle_auth_sessions`・`reconcile_user_sessions_metadata`・`cleanup_ended_user_sessions_metadata` | migration の CREATE FUNCTION が型ファイルに無い (トリガー関数は規則で除外) | 型を作り直して 2 ファイルに写す (§11.8) | A |
| N-2 | `tests/env-source-scan.test.ts`・`src/__tests__/lib/env.test.ts`・`tests/check-env-script.test.ts` | `AUTH_LOGIN_ALERT`・`process.env.AUTH_LOGIN_ALERT`・`readOnlyBy` | ① `tests/env-source-scan.test.ts`: 本番コードが名前を書いて読む変数が一覧に無い・一覧の変数が `.env.example` に無い・`readOnlyBy` の変数を別のファイルが読む・一覧の変数名を例外や応答の文字列に書く (ログはよい)、のどれかで赤 (どれも `ENV_VARS` から作って比べるので、テストの書き換えは要らない) ② `src/__tests__/lib/env.test.ts` (origin/main a6455673 の 419〜485 行の it「値を読む場所が決まっている変数 (…) は、check:env のために一覧にあるが、getOptionalEnv では読めない」): `readOnlyBy` を持つ変数の `[名前, readOnlyBy]` の並びを sort して、直書きの配列と `toEqual` で比べる (422 行) ので、`AUTH_LOGIN_ALERT` を `readOnlyBy` つきで足すと赤 ③ `tests/check-env-script.test.ts`: 要約の件数は `\d+` で見て (310 行)、変数の一覧を直書きしないので反応しない | ① `SERVER_ENV_VARS` に §12.6 の項目 (`readOnlyBy: 'src/app/api/cron/login-alerts/route.ts'`・`whenMissing` つき)、`.env.example` に §12.6 の行。値を読む (`process.env.AUTH_LOGIN_ALERT`) のは cron の route だけ (`constants.ts` は名前の定数 `AUTH_LOGIN_ALERT_ENV_NAME` と解釈の関数 `resolveLoginAlertMode` だけで、`process.env` を読まない)。変数名は warn のログにだけ書き、例外・応答の本文に書かない (§14.8 の応答は件数だけ) ② 同じ段 B の PR で env.test.ts の 3 か所を直す: (a) 期待の配列の `['AI_ULTIMATE_MODE_DAILY_LIMIT', 'src/lib/plan/entitlements.ts'],` の行と、`['AUTH_LOGIN_FAILURE_RESET_MINUTES', …]` の上の注記の行 (`// #1165 ログインの連続失敗の回数を 0 に戻すまでの時間。…`) の間 (sort の順。`'AUTH_LOGIN_A…'` は `'AUTH_LOGIN_F…'` より前) に、注記 `// #1190 不審なログインの通知のスイッチ。解釈 (未設定・不正な値は on) は src/lib/auth/sessions/constants.ts の resolveLoginAlertMode、値を読むのは cron の route 1 か所` と `['AUTH_LOGIN_ALERT', 'src/app/api/cron/login-alerts/route.ts'],` の 2 行を足す (b) it の名前の括弧の中の並びの `AI_ULTIMATE_MODE_DAILY_LIMIT・` の次に `AUTH_LOGIN_ALERT・` を足す (c) `typeOnly` の中の `getOptionalEnv('AUTH_LOGIN_FAILURE_RESET_MINUTES');` の行の次に、`// @ts-expect-error AUTH_LOGIN_ALERT の値を読むのは cron の route (src/app/api/cron/login-alerts/route.ts) だけ (#1190)` と `getOptionalEnv('AUTH_LOGIN_ALERT');` の 2 行を足す (`readOnlyBy` を持つ変数は型 `OptionalEnvName` に入らないので、この `@ts-expect-error` は型検査を通り、型で渡せないことを見張る)。同じ it のループ (`required` が false・`whenMissing` がある・`readOnlyBy` のファイルが実在する) は、§12.6 の項目と、同じ段 B で作る cron の route のファイルで通る。ほかの it は変えない (§20.1) ③ 変更なし (走らせて確認) | B |
| N-3 | `tests/rate-limit-single-implementation.test.ts` | `@upstash/ratelimit` | route が自前の制限を持つと赤 | `checkRateLimit(user.id, 'auth-password-change' \| 'auth-password-reset')` だけ | C |
| N-4 | `tests/supabase-service-role-client-scan.test.ts` | `createClient` (`@supabase/supabase-js`)・`SUPABASE_SERVICE_ROLE_KEY` | 自前で service_role の client を作ると赤 | `getSupabaseAdmin()` だけ (store.ts は client を引数で受ける) | A〜D |
| N-5 | `tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts` | `error.message`・`internalError` | 本文に Supabase の生の文を入れると赤 | 4xx は §19 の固定の文、5xx は `internalError`。`validatePassword` の文言 (こちらが書いた文) は出してよい | B〜D |
| N-6 | `tests/next15-async-request-api-scan.test.ts` | `createClient()`・`headers()`・`params` | await 無し / `params` が Promise でないと赤 | `await createClient()`・`(await headers())`・`sessions/[id]` と `admin/users/[id]/login-history` は `params: Promise<{ id: string }>` | B・D |
| N-7 | `tests/role-check-source-scan.test.ts` | `requireRole(`・`roles?.` | `src/app/api` の route で roles を手書き判定すると赤 (走査の範囲は `SCAN_ROOT = 'src/app/api'`) | admin の route は `requireRole(['admin', 'super_admin'])`。password/change・reset の世代数の入力の roles は `requireSessionUser` (`src/lib/auth/sessions/session-claims.ts`。走査の範囲の外) が読み、route は `user_profiles` を読まず `passwordHistoryGenerationsFor(ctx.roles)` を呼ぶだけ (route に `.roles` の `some` / `includes` も `roles?.` も書かない) | C・D |
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
| N-18 | `tests/email-send-throttle-contract.test.ts` (#1163。`src/` の `.ts` / `.tsx` を構文木で走査。`src/lib/emails` と `__tests__` は除く) | `@/lib/emails/send`・`sendEmail(` | `@/lib/emails/send` を import して `sendEmail(` を呼ぶファイルは、`invite-throttle` の判定 (`checkInviteEmailLimits` / `checkTransferProposeLimit`) を通すか、`EXEMPT_EMAIL_SENDERS` に理由を書く (it 1)。除外の項目は実在し・今も送り・判定を通していないことも見る (it 4)。段 B の `login-alert-worker.ts` が当たる (`sendEmail` は送信待ちへの登録になったが、走査の母集合は変わらない。cron の route は worker を呼ぶだけで当たらない) | `EXEMPT_EMAIL_SENDERS` に 1 項目 (既存の `app-log-alerts/route.ts` の項目と同じ書き方): `` 'src/lib/auth/sessions/login-alert-worker.ts': '宛先は本人の auth.users 上の登録メールアドレス (auth.admin.getUserById で引く) に固定で、利用者は宛先を指定できない。CRON_SECRET の Bearer 認証 (requireCronAuth) を通った Vercel Cron (GET /api/cron/login-alerts) からしか動かず、DB の claim_login_alerts で取り置いた 1 セッション (1 ログイン) につき 1 通だけを送信待ち (email_outbox) に登録する (Idempotency-Key login-alert:<session_id>。再試行・再送は送信待ちの worker が同じ鍵で行う)。本文は UA から決めた端末の言葉・IP・国と固定のリンクだけで、利用者が書ける値は含めない (cross/16 §13.3・§18)' `` | B |
| N-19 | `tests/integration/security/anon-definer-execute.test.ts` A1 / A2 / B | `prosecdef`・`has_function_privilege('anon'` | SECURITY DEFINER の関数に anon の EXECUTE が残ると赤 | §11.3〜11.6 の REVOKE (PUBLIC / anon / authenticated / service_role) → 必要な役割だけ GRANT。決定表 `EXPECTED_ACL` (B) に SECURITY DEFINER の 8 本の行を足す: `auth_session_revoke(uuid)` (anon false・authenticated true・serviceRole false) / `auth_password_check(uuid,text,text,integer)` (anon false・authenticated false・serviceRole true) / `expire_idle_auth_sessions()`・`reconcile_user_sessions_metadata()` (anon false・authenticated false・serviceRole true) / トリガー関数 `auth_session_created()`・`auth_session_refreshed()`・`auth_session_deleted()`・`password_history_record()` (anon false・authenticated false・serviceRole false。実行は supabase_auth_admin だけ)。`cleanup_ended_user_sessions_metadata()` (§11.6)・`claim_login_alerts(integer,integer,integer)`・`release_login_alert(text,integer)` (§11.4)・トリガー関数 `user_profiles_fill_login_stats()` (§11.3) は SECURITY INVOKER なので足さない (B の it は `secdef` が true であることを確かめるため、足すと赤。A1 / A2 も SECURITY DEFINER だけを見る)。`sig` は `oid::regprocedure` の形 (引数の型を空白なしのカンマ区切り。既存の `organizations_owner_id_unchanged(uuid,uuid)` と同じ)。`why` は各関数の §11 の役割を 1 文で | A |
| N-20 | `tests/integration/security/auth-users-fk-on-delete.test.ts` | `auth.users`・`ON DELETE` | 新しい FK は無い (既存の 2 本は CASCADE)。H (メールらしい列) も無し | 変更なし (走らせて確認) | A |
| N-21 | `tests/helpers/schema-snapshot.ts` (account-export の模型) | `ALTER TABLE … ADD COLUMN` | ベストエフォートの構文解析 | §11.1 の形 (`ALTER TABLE public.x ADD COLUMN IF NOT EXISTS …` をカンマ区切り) は解析できる | A |
| N-22 | `tests/native-sign-out-order-source-scan.test.ts` | `broadcastSignOut(`・`auth.signOut(` | `broadcastSignOut` を呼ぶ箇所の並び | `revoke-others` の route は `broadcastSignOut` を呼ばない (サーバー)。`reset-password` ページの並びは変えない | B・C |
| N-23 | `tests/edge-function-verify-jwt.test.ts`・`src/__tests__/config/turnstile-config.test.ts` | `supabase/config.toml` | config.toml の行の形 | 触らない | — |
| N-24 | `src/__tests__/app/settings/account-page.test.ts` (origin/main 61c59321 の行で: 297 #1187 入力の検証・357 #1187 現在のパスワードが違う・416 #1187 成功・503 #1187 更新やログアウトの失敗・584 #1552 案内の指し先・648 #1187 コンソールに出さない) | `signInWithPassword`・`updateUser`・`signOut`・`password-change-others-not-signed-out-note` | 画面が API 経由になり、他の端末のログアウトの失敗の枝が無くなる | describe ごとに: **297** は it をそのまま残し、共通の確かめ `expectNoAuthMutation` に「`fetch` で `/api/auth/password/change` を呼んでいない」を足す。337 の it 名の「再認証の前に」を「API を呼ぶ前に」に。**357** の 3 it は API に置き換え (400 `AUTH_CURRENT_PASSWORD_MISMATCH` → 「現在のパスワードが正しくありません」と `updateUser`・`signOut` を呼ばない / `fetch` の reject → 通信エラーの文言でパスワードの間違いとは言わない / `fetch` の例外でも画面が壊れない)。**416** の 417 を「POST /api/auth/password/change を 1 回呼び、signInWithPassword / updateUser / signOut を呼ばない」に、469 を「二重に送信しても API は 1 回」に。431・440・458 は期待をそのまま (呼び出しの mock だけ `fetch` に)。**503** の weak_password の it を「422 `VALID_PASSWORD_WEAK` の本文の文言を出す」に、same_password の it を「422 `VALID_PASSWORD_HISTORY` の文言」に。`signOutFailures` の `it.each` (2 本) は削除 (他の端末の失効は GoTrue が更新と同じトランザクションで行い、画面に失敗の枝が無い)。403 `AUTH_REAUTHENTICATION_REQUIRED` の it を 1 本足す。**584** の 595 と 611 (他の端末を確認できなかったときの注意書き) は削除、`failOthersSignOut` も削除。631 は `renderPage()` だけにして `password-change-forgot-current-note` の期待だけを残す。603・621 はそのまま。**648** の `failures` の 6 件を API の 4 件 (400・422・500・`fetch` の reject) に置き換え、パスワードをログに出さない期待はそのまま。700 (メールアドレス変更)・807 (読み込み) は変えない | C |
| N-25 | `tests/auth/reset-password-session-revoke.test.ts` | `updateUser`・`signOut({ scope: "global" })` | ページが API 経由になる | `updateUser` の期待を `fetch('/api/auth/password/reset')` に。clear → signOut global → broadcast の順の it はそのまま | C |
| N-26 | `tests/auth-turnstile-resend-password-change.test.tsx` (310 行目からの describe) | `password-change`・`signInWithPassword` | パスワード変更の本人確認が無くなる | その describe (6 it) を削除。`/auth/verify` の describe は残す | C |
| N-27 | `apps/mobile/__tests__/lib/account-credentials.test.ts`・`apps/mobile/__tests__/settings/account-credentials.test.tsx` | `signInWithPassword`・`updateUser`・`scope: 'others'` | `changePassword` が API 経由になる | §20.4 のとおり書き換え (it 3・4・「他の端末…」・「連打…」)。`apps/mobile/__tests__/settings/account-credentials.test.tsx` は `../../src/lib/api` (`getApi`) の mock を足し、「3. 再認証 → 更新 → この端末以外のログアウト を呼び…」を「3. パスワードの変更の API を 1 回呼び…」に、「他の端末のログアウトを確認できなかったときは、成功に注意書きを添える」(origin/main 149 行) を削除、「4. 現在のパスワードが違えば…」を 400 の応答に、「連打しても、再認証は 1 回しか呼ばない」を「API は 1 回」に (§20.4)。部品 `AccountCredentialsSection.tsx` の `othersSignedOut` の削除 (§16) と同じ PR | C |
| N-28 | `apps/mobile/__tests__/auth/reset-password.test.tsx` (冒頭のコメントと it 1〜5。origin/main の it 4 は `mockUpdateUser` の戻りの `data.user.id` を `signOutWithCleanup` に渡すことを、it 5 は `updateUser` の error で失敗することを見る) | `mockUpdateUser`・`signOutWithCleanup('user-reset-1')`・`'weak password'` | 画面が `updateUser` を呼ばなくなり、利用者 ID は呼ぶ前の `getSession()` から取る (§16) | `jest.mock('../../src/lib/api', () => ({ getApi: () => ({ post: (...args) => mockApiPost(...args) }) }))` を足す (`../../src/lib/api-error` は mock しない。本物で本文の `error` を取り出す)。`beforeEach` の `mockGetSession` の戻りを `{ data: { session: { access_token: 'tok', user: { id: 'user-reset-1' } } } }` に、`mockApiPost.mockResolvedValue({ ok: true })` を既定に。it 1・2 は `expect(mockApiPost).not.toHaveBeenCalled()` (名前の「updateUser を呼ばない」を「API を呼ばない」に)。it 3 は `expect(mockApiPost).toHaveBeenCalledWith('/api/auth/password/reset', { new_password: 'NewPassword1' })` と `expect(mockUpdateUser).not.toHaveBeenCalled()`。it 4 は `mockUpdateUser` の設定を消し、期待 (`signOutWithCleanup('user-reset-1')`・`/login`・`signOut` を呼ばない) はそのまま (ID は `getSession` の `user.id` から来る)。it 5 は `mockApiPost.mockRejectedValue(new Error('HTTP 422 Unprocessable Entity: {"error":"最近使ったパスワードは使えません。別のパスワードにしてください。","code":"VALID_PASSWORD_HISTORY"}'))` で、`Alert.alert('更新失敗', '最近使ったパスワードは使えません。別のパスワードにしてください。')` と、`signOutWithCleanup`・`replace` を呼ばない。it 6 を足す: 403 `AUTH_RECOVERY_SESSION_REQUIRED` (§19 の文) を同じ形で。冒頭のコメントの 1〜4 を API の流れに | C |
| N-29 | `tests/login-failure-grant-claim-cleanup-contract.test.ts`・`tests/integration/security/log-cleanup-and-dau-snapshot.test.ts` | `cron.job` | 自分のジョブだけを見る | 変更なし。新しいジョブは §20.3 の契約テストが見る (migration の全ジョブの名前と数を 08 の記述と突き合わせる番兵は別にある → N-32) | A |
| N-30 | `tests/mobile-super-admin-api-contract.test.ts` (ネイティブの (super-admin) の画面と一緒に 2026-10-16 に削除した。#1598)・`apps/mobile/__tests__/app/error-boundaries.test.tsx` | `(super-admin)`・`_layout.tsx` | 対象外 (新しい画面は `settings/sessions.tsx` で layout ではない) | 変更なし (走らせて確認) | B |
| N-31 | `src/__tests__/app/faq/account-answers.test.ts` (#1187 の「モバイルのアカウント管理: … 実際に Supabase で変更する」の it。origin/main 243〜255 行) | `updateUser({ password: input.newPassword })`・`signOut({ scope: "others" })`・`{ email: input.email }` | `apps/mobile/src/lib/account-credentials.ts` の本文に 3 つの文字列があることを読む走査。§16 で `changePassword` が `getApi().post('/api/auth/password/change', …)` になり、前の 2 つの文字列が消えて赤 | その it の `credentials` への期待 3 つのうち、`updateUser({ password: input.newPassword })` と `signOut({ scope: "others" })` の 2 つを `expect(credentials).toContain('/api/auth/password/change')` の 1 つに置き換える (引用符の種類に依らないよう、path だけを見る)。`{ email: input.email }` の期待 (メールアドレスの変更は今までどおり Supabase の `updateUser`) と、画面・部品の見出しの期待はそのまま。it の名前の「実際に Supabase で変更する」を「パスワードは API (`/api/auth/password/change`) で、メールアドレスは Supabase で変更する」に。同じ describe の Web のアカウント画面の it (見出しと入力欄の文言) は、§15 で文言を変えないので変更なし (走らせて確認) | C |
| N-32 | `tests/log-cleanup-dau-snapshot-contract.test.ts` (「#1125 設計書の『いま』の記述が、木の実物と合っている」の Vercel Cron の it 2 つと pg_cron の it 1 つ。origin/main 9f4f6da8 の 313〜358 行) | `vercel.json` の `crons`・migration の `cron.schedule(` (名前は `tests/helpers/migration-cron-jobs.ts` が数える) | vercel.json の cron の名前 (path の最後の部分) と、migration が pg_cron に登録するジョブの名前を、`docs/design/operator/08-cron-batches.md` の §3.0・§3.1 の注記・§3.2 の注記・§5 の注記がすべて挙げ、§3.0・§3.1 の注記・§3.2 の注記の本数の宣言が実数と同じであることを見る。本設計で pg_cron の `cleanup-auth-sessions-and-login-history` (段 A) と Vercel Cron の `login-alerts` (段 B) が 1 本ずつ増えるので、08 を直さないとその段の全件が赤。§11.6 は名前を文字列で直書きしているので、見張りは名前を解ける (未解決 0 件) | 08 をその段の PR で直す (逐語は §23 の 08 の行)。段 A: PR #1757 で済んだ (origin/main 9f4f6da8 の 08 §3.0 は「いま、このリポジトリの migration が pg_cron に登録しているジョブは 11 つある」で、`cleanup-auth-sessions-and-login-history` を「そのほか」の箇条書きと §3.1 の注記に挙げている)。段 B: §3.0 と §3.2 の注記の「`vercel.json` に登録されている Vercel Cron は … の N 本」を +1 し、§3.0・§3.2 の注記・§5 の注記に `` `login-alerts` `` を書く (名前は path の最後の部分。`` `/api/cron/login-alerts` `` の書き方だけでは数えられない)。N は PR の時点の origin/main の実数から数える。origin/main 9f4f6da8 (と 6da7b7ec) の `vercel.json` の crons は `process-menu-queue`・`app-log-alerts`・`email-outbox` (#1760)・`push-outbox` (#1776) の 4 本で、08 の文も 4 本で書かれている (§3.0 の 17 行「… の 4 本である。」・§3.2 の注記の 176 行「… の 4 本。この表のほかの 11 本は …」・§5 の注記の 479 行「`vercel.json` にあるのは … `push-outbox` (…) だけで」) ので、段 B では 4 → 5 本。置き換える元の文と後の文・`login-alerts` を足す位置 (どの文も列挙の最後 = `push-outbox` の後ろ) は §23 の 08 の行の逐語に従う。PR の時点で origin/main の本数がさらに変わっていれば、その実数 + 1 にし、元の文はその時点の 08 から写す。名前を解く見張り `tests/helpers/migration-cron-jobs.ts` と `tests/migration-cron-job-names.test.ts` は、§11.6 の直書きの名前を解ける (段 A で確かめ済み) | A・B |
| N-33 | `src/__tests__/lib/auth/logout-guidance.test.ts` (origin/main 61c59321 の 67〜92 行の describe「#1552 他の端末のログアウトを確認できなかったときの注意書き」と、148〜154 行の it「アカウント画面は、案内の文を直書きせず、この出し分けを使う」) | `describeOthersNotSignedOutNote`・`src/app/(main)/settings/account/page.tsx` | it が画面のソースに `describeOthersNotSignedOutNote(accountActionsPlacement)` があることを読む。§15 でその呼び出しが消えて赤。関数も §21.3 で消す | describe「#1552 他の端末のログアウトを確認できなかったときの注意書き」(4 it。`it.each` を含む) を削除し、import から `describeOthersNotSignedOutNote` を外す。it「アカウント画面は…」の `expect(account).toContain('describeOthersNotSignedOutNote(accountActionsPlacement)')` を `expect(account).not.toContain('describeOthersNotSignedOutNote')` に置き換える (ほかの 4 つの期待 = `describeForgotCurrentPasswordNote(accountActionsPlacement)`・`useAccountActionsPlacement(isNativeApp)`・2 つの `not.toContain` はそのまま)。describe「#1552 現在のパスワードを思い出せない人への案内」と構文の it は変えない | C |
| N-34 | `tests/mobile-sign-out-doc-callers.test.ts` (origin/main 61c59321 で増えた見張り) | `signOutOnDevice`・`apps/mobile/app/**` | `apps/mobile/app` の中で `signOutOnDevice` を呼ぶ画面は設定画面 (`(tabs)/settings.tsx`) だけでないと赤 | 新しい画面 `apps/mobile/app/settings/sessions.tsx` は `signOutOnDevice` を呼ばない (この端末には解除のボタンを出さない §15。他の端末は API で消す)。`docs/design/mobile/05-auth-session.md` への追記 (§23) にも「端末からのログアウト」の行を足さない | B |
| N-35 | `src/__tests__/lib/emails/templates-site-config.test.ts` (「テンプレート一覧が、実際にあるテンプレートのファイルと一致している」の it と、`TEMPLATES` を回す 3 つの describe) | `src/lib/emails/account/*.ts`・`getEmailFrom()`・`emailSignature()` | `account/` のファイルを `readdirSync` で数え、`TEMPLATES` と同じでないと赤。§18 の `account/login-new-device.ts` が増える | `TEMPLATES` に 1 件足す: `{ file: 'account/login-new-device', name: 'login-new-device', render: () => renderLoginNewDeviceEmail({ to_email: 'taro@example.com', logged_in_at: new Date('2026-10-15T01:00:00.000Z'), device_label: 'Windows の Chrome', ip_address: '203.0.113.10', country_code: 'JP' }), mentionsSupport: true }` (本文が `getSupportEmail()` を書くので true)。§18 の本文は `getEmailFrom()`・`emailSignature()` を使い、URL は `${getSiteUrl()}` で始めるので、ドメインの直書きの it も通る | B |
| N-36 | `tests/api/auth-login-route.test.ts`・`tests/auth-callback-legal-consent.test.ts` | `createClient` の mock (`auth.signInWithPassword` だけ / `exchangeCodeForSession`・`verifyOtp`・`getUser` だけ。`getSupabaseAdmin` は login の mock にだけあり `rpc` だけ) | §13.5 で 2 つの route が、session を作る呼び出しの成功の直後に `recordWebLoginContextFromRequest` を呼び、その中で `auth.getClaims`・`getSupabaseAdmin()`・`admin.from(...)` を使う。mock に無い (callback の mock には `getSupabaseAdmin` が無い) | 変更なし (走らせて確認)。どちらの mock も成功時に `data.session` を返さない (`{ data: {} }` / `{ data: { user } }`) ので、`recordWebLoginContextFromRequest` は手順 1 で返り、`getClaims` も `getSupabaseAdmin` も触らない (§13.5)。この関数は例外を投げない (§13.5・§13.6) ので、仮に先へ進んでも応答は変わらない。呼ぶ所の確かめは新しい `tests/api/auth-login-context.test.ts` (§20.2)、中身は `sessions-web-login-context.test.ts` (§20.1) が持つ | A |
| N-37 | `apps/mobile/__tests__/providers/auth-provider.test.tsx`・`apps/mobile/__tests__/providers/auth-provider-sign-out-cleanup.test.tsx`・`apps/mobile/__tests__/lib/web-view-auth-messages.real-auth.test.ts` (本物の `AuthProvider` を描く 3 本。ほかの画面のテストは `AuthProvider` を mock している) | `onAuthStateChange`・`SIGNED_IN`・`INITIAL_SESSION`・`fetch` | §16 で `AuthProvider` が `registerDeviceName` (→ `getApi()` の `PATCH /api/auth/sessions/current`) を呼ぶ。mock していないと、fetch の偽物の呼び出しの数・順の期待や、`expo-device` の mock の形に触れる | 3 本とも `jest.mock('../../src/lib/device-name', () => ({ registerDeviceName: jest.fn(() => Promise.resolve()) }))` を足す (既存の期待は変えない)。`auth-provider.test.tsx` には §20.4 の it を足す | B |
| N-38 | `tests/integration/security/account-credentials-change.test.ts` (冒頭のコメント 1〜30 行と A-1・A-2 の it) | `signInWithPassword`・`updateUser`・`signOut({ scope: 'others' })` | 冒頭のコメントが「画面と同じ流れ (再認証 → updateUser → signOut others)」「画面はこのエラーコードで…」と書く。§15・§16 で画面がその流れを使わなくなり、記述が事実と違う。assert は GoTrue の実物の挙動を見るだけなので、テストは赤にならない | assert・it は変えない (A-1〜A-5 は GoTrue の挙動の固定として残す。A-3 の `same_password` は `performPasswordChange` の対応 §13.2 が使う)。冒頭のコメントの「画面は Supabase Auth (GoTrue) の次の挙動に頼っている」「画面と同じ流れ」「画面はこのエラーコードで…」を、「パスワードの変更は `POST /api/auth/password/change` (cross/16 §14.6) が受け、GoTrue の `PUT /user` を本人の access token で呼ぶ。ここでは GoTrue の挙動 (A-1〜A-3) と、メールアドレスの変更の画面が頼る挙動 (A-4・A-5) を固定する。API の結合テストは tests/integration/security/auth-history-sessions.test.ts」の趣旨に改める | C |
| N-39 | `tests/jst-today-source-scan.test.ts` (規則 G。`SCAN_ROOTS` に `src` を含む・許可リスト `ALLOWLIST` は件数ちょうど) | `.lt('created_at'`・`.gte(` / `.gt(` / `.lte(` / `.lt(` と `_at` で終わる列 | `src/lib/auth/sessions/store.ts` の `listPriorLogins` が `.lt('created_at', input.createdAt)` で絞る (§13.1)。値は判定する行の `created_at` で、JST の暦日から作った時刻ではないので規則 G の finding が 1 件出て、許可リストに無いと全件が赤 | `ALLOWLIST` の規則 G の並びに 1 件足す: `{ file: 'src/lib/auth/sessions/store.ts', rule: 'G', count: 1, reason: '不審なログインの判定で、同じ利用者の「判定する行より前に作られた行」を読む (listPriorLogins の created_at < 判定する行の created_at)。DB の行の時刻どうしの比較で、暦日ではない (cross/16 §13.1)' }`。件数は store.ts の `_at` の列への `.gte` / `.gt` / `.lte` / `.lt` の数ちょうど (§13.1 で 1 か所と決めた。取り置きの時刻の条件は SQL の中 §11.4 で、走査の対象外)。新しい timestamptz の列はどれも `_at` で終わる (`alert_claimed_at`・`alert_sent_at`) ので、`TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX` と migration の突き合わせの it は変わらない (§11 の SQL の timestamptz の変数は `v_` で始まる `v_last_login` だけで、走査が除く) | A |
| N-40 | `src/__tests__/lib/emails/secret-templates.test.ts` (#1785。`src/lib/emails` 配下の `render\w+Email(` を走査し、`SECRET_TEMPLATES` / `PUBLIC_TEMPLATES` の表と突き合わせる) | `template: 'login_new_device',`・`contains_secret: true,`・名前が `_url` / `_link` / `_token` / `_code` で終わる識別子 | ① 文面の数 = 2 つの表の行数の和 (走査の番兵) ② すべての文面がどちらかの表に載る ③ 文面のコード (コメントを除く) に現れる、名前が `_url` / `_link` / `_token` / `_code` で終わる識別子の集合 = 表のその行の配列 ④ `contains_secret: true` を書くのは `SECRET_TEMPLATES` の文面だけ ⑤ 秘密ありの見本 (`tests/helpers/secret-email-samples.ts`) は `SECRET_TEMPLATES` と過不足なし。§18 の `account/login-new-device.ts` を足すと ①②③ が赤 (`country_code` が `_code` で終わるので ③ は `['country_code']` を求める。`to_email`・`ip_address`・`device_label`・`logged_in_at`・`SESSIONS_SETTINGS_PATH` (大文字) は拾わない) | `PUBLIC_TEMPLATES` に 1 行 (`account_deleted: [],` の行の次): `` login_new_device: ['country_code'], // 新しい端末からのログインの通知 (cross/16 §18)。country_code は ISO 3166-1 の 2 文字の国コードで、リンクでもトークンでもない (名前が _code で終わるので走査が拾う)。リンクは getSiteUrl() + 固定のパス 2 つだけ ``。`SECRET_TEMPLATES`・`tests/helpers/secret-email-samples.ts` は触らない (秘密なし §18)。文面に `contains_secret` を書かない (書くと ④ が赤) | B |
| N-41 | `tests/email-resend-boundary-scan.test.ts` (#1193。`src/` の `.ts` / `.tsx` を構文木で走査し、Resend を直接使うファイルが `ALLOWED` (`src/lib/emails/outbox.ts`) だけであることを見る) | `from 'resend'`・`import('resend')`・`new Resend(`・`api.resend.com` | 段 B の新しいファイル (`login-alert-worker.ts`・`login-new-device.ts`・cron の route) がこの 4 つの書き方を 1 つでも持つと赤 | 反応しない (段 B は `sendEmail` (`@/lib/emails/send`) だけを import し、`resend`・`@/lib/emails/outbox` を import しない §13.3)。走らせて確認 (`ALLOWED` は変えない) | B |
| N-42 | `tests/operator-mfa-entry-points-scan.test.ts` ⑥ (cross/12 §20。`@/lib/auth/mfa/assurance` を import してよいのは `src/lib/auth/helpers.ts`・自己サービスの MFA の route・テストだけ) | `@/lib/auth/mfa/assurance`・`SessionClaimsSchema` | cross/12 (段 A〜C マージ済み) の `src/lib/auth/mfa/assurance.ts` と本書の `src/lib/auth/sessions/session-claims.ts` が同じ名前の `SessionClaimsSchema` を export する (形は違う §25 Q-5)。段 B 以降の route・lib が間違って `assurance` の方を import すると赤 | 反応しない: 本書のファイルは `@/lib/auth/sessions/session-claims` だけを import する (`requireSessionUser`・`readSessionAuth`)。寄せない (Q-5)。走らせて確認 | B〜D |
| N-43 | `tests/env-setup-cron-secret-crons.test.ts` (#1776 (#1722 の段 B) で足された見張り。`ENV_SETUP.md` の Vercel の環境変数の表の `` `CRON_SECRET` `` の行 (1 列目が「Vercel の環境変数」・2 列目が `` `CRON_SECRET` `` で、「Vercel Cron が」を含む行。ちょうど 1 行であることも見る。origin/main 9f4f6da8 の `ENV_SETUP.md` の 92 行) が挙げる `/api/cron/*` の path の集合と、`vercel.json` の `crons` の path の集合が同じことを見る) | `vercel.json` の `crons`・`/api/cron/login-alerts`・`` `CRON_SECRET` `` | 段 B が `vercel.json` に `/api/cron/login-alerts` を足す (§14.8) と、行が挙げる path (origin/main 9f4f6da8 では `process-menu-queue`・`app-log-alerts`・`email-outbox`・`push-outbox` の 4 本) に `login-alerts` が無いので、段 B の全件が赤 | 同じ段 B の PR で `ENV_SETUP.md` の `` `CRON_SECRET` `` の行を直す (逐語は §23 の `ENV_SETUP.md` の行の ②): 行の中の「`` `/api/cron/push-outbox` ``（どれも `` `vercel.json` `` の `` `crons` ``）」を「`` `/api/cron/push-outbox` ``・`` `/api/cron/login-alerts` ``（どれも `` `vercel.json` `` の `` `crons` ``）」にする (`login-alerts` は列挙の最後 = `push-outbox` の後ろ)。行のほかの文と、ほかの行は変えない。PR の時点で origin/main の行がさらに変わっていれば (並行の案件が cron を足した)、その時点の行の列挙の最後に `` `/api/cron/login-alerts` `` を足す。テストは変えない。直したら offload で流して緑を確かめる | B |

## 23. 他の文書への追随表 (本書の PR では変えない。実装の段で同じ PR か後続 PR で直す)

| 文書 | 箇所 | 直し方 | 期日 |
|---|---|---|---|
| `docs/design/cross/01-auth-session.md` | §3 のシーケンス図 (`participant Next as Next.js Edge`)・§3.2 (`INSERT user_sessions_metadata`)・§4.3 (5 端末)・§4.4 (`admin.signOut(sessionId)`)・§9.1 (step 4)・§13.1 / §13.3・§16・§17 | §3 のシーケンス図の `participant Next as Next.js Edge` を `participant Next as Next.js (proxy・Node.js runtime)` に (Next 16 の `src/proxy.ts` は Node.js の runtime だけで動き Edge ではない。2026-10-16 の整合ゲートの candidate の現在形化。v1.8)。§3.2 の INSERT を「DB のトリガー (cross/16 §11.3)」に。§4.3 を「上限は設けない。一覧・個別失効・30 日の自動終了 (cross/16)」に。§4.4 の擬似コードを「個別の失効は RPC `auth_session_revoke` (cross/16 §11.4)。ログアウトは今までどおり `signOut()`」に。§9.1 の step 4 を「`POST /api/auth/password/reset` (cross/16 §14.7)。照合と再設定の認可はこの API の経路だけで、GoTrue の `PUT /auth/v1/user` を直接呼ぶ経路は通らない (cross/16 §24・S-33)」に。§13.1 / §13.3 に「→ cross/16 §11 が正典」。§16 の Integration 行 (5 端末上限) を本書のテストに。§17 の middleware 行を消す | 段ごとに分ける: §3.2・§13.1・§13.3 は段 A、§3 のシーケンス図・§4.3・§4.4・§16・§17 は段 B、§9.1 は段 C の PR (§21.3) |
| `docs/design/operator/01-data-model.md` | §3.23・§3.25・§3.9.1・§3.1 の順序 | §3.25 に 12 列・索引 2 本・CHECK 3 本・`sessions_revoke_self` の削除・GRANT の変更・RPC `claim_login_alerts` / `release_login_alert` を写し「→ cross/16 §11.1・§11.4 が正典」。§3.23 に「書くのはトリガー `password_history_record` (cross/16 §11.3)」。§3.9.1 の `last_login_at` の注記「auth.users.last_sign_in_at を Edge Function が同期」を「`auth.sessions` の INSERT のトリガー `auth_session_created` が書き、行がまだ無かった最初のログインは行を作るときのトリガー `user_profiles_fill_login_stats` が入れる (cross/16 §11.3)」に。§3.1 の一覧の末尾に本 migration (番号はマージ時の値) | 段 A |
| `docs/design/cross/02-rls-patterns.md` | §4.1 の self_ownership の「用途」の行・§9 の `rls_hardening.sql` テンプレートの「2. user_sessions_metadata」(`sessions_self_select`・`sessions_self_update`・「INSERT は Edge Function (service_role) のみ」) と「4. password_history」(「service_role のみアクセス可 (パスワード変更 Edge Function 経由)」) | §4.1 の用途の例から `user_sessions_metadata`・`password_history` を外す (前者は本人の SELECT だけ、後者は本人に何も見せない)。§9 の 2. を、本書 §11.1 の後の実際の形に: SELECT のポリシーは実名 `sessions_self` (`USING (user_id = auth.uid())`)・UPDATE のポリシーは無し (`sessions_revoke_self` は本書の migration が消す。02 の `sessions_self_update` はもともと実名とずれていた)・注記を「書くのは `auth.sessions` のトリガー・RPC `auth_session_revoke` / `claim_login_alerts` / `release_login_alert`・service_role だけ (cross/16 §11.1・§11.3・§11.4)」に。4. の注記を「書くのはトリガー `password_history_record`、読むのは RPC `auth_password_check` (どちらも SECURITY DEFINER。cross/16 §11.3・§11.5)。PUBLIC・anon・authenticated の表の権限は無い」に | 段 A |
| `docs/requirements/03-operator-admin.md` | §17.1 の `password_history` の DDL の下・§17.4 の `user_sessions_metadata` の DDL の下 | 要件の文は変えず、2 か所に注記を 1 行ずつ: §17.1「記録はトリガー・照合はサーバーの API と RPC `auth_password_check` (cross/16 §11.3・§11.5)」、§17.4「列の追加・ポリシー・一覧と失効・30 日の自動終了は cross/16 が正典。同時 5 端末の上限・ロール別のタイムアウト・`/account/sessions` のパスは採らない (cross/16 §0.3)」。注記を足すか、要件の文そのものを改めるかはオーケストレーターが決める (§25 Q-17) | オーケストレーターの判断 (Q-17) |
| `docs/design/cross/04-api-conventions.md` | §4.2 AUTH 系・VALID 系 | §19 の新 7 code を足す。`AUTH_SESSION_REVOKED` (401) は GoTrue の `session_not_found` に対応する既存の意味のまま | 段 B (`AUTH_SESSION_NOT_FOUND`・`AUTH_SESSION_IS_CURRENT`)・段 C (`AUTH_CURRENT_PASSWORD_MISMATCH`・`AUTH_RECOVERY_SESSION_REQUIRED`・`AUTH_REAUTHENTICATION_REQUIRED`・`AUTH_PASSWORD_NOT_SET`・`VALID_PASSWORD_WEAK`) |
| `docs/design/cross/CLAUDE.md` | ファイル一覧 | `16-auth-history-sessions.md` の行 (担当範囲: ログイン履歴 / 不審ログインの通知 / セッションの一覧と失効 / パスワード履歴。要件 03 §17) を足す | 設計のマージと同じ PR (オーケストレーター) |
| `docs/design/operator/07-audit-monitoring.md` | §4.1.1 | `admin.user.view_login_history` (details: `returned_count`・severity info・0 件は記録しない) | 段 D |
| `docs/design/operator/02-api-spec.md` | §4 ユーザー管理 API | `GET /api/admin/users/{id}/login-history` の節 | 段 D |
| `docs/design/operator/03-ui-spec.md` | §6 ユーザー詳細 | 「ログイン履歴 (直近 20 回)」の節 (列見出しは §17 の逐語の 7 つ) | 段 D |
| `docs/design/operator/08-cron-batches.md` | §3.0 実装状況 (見出しの日付・Vercel Cron の本数と名前の文)・§3.2 の表と注記・§5 の注記 (段 A の分 = pg_cron の §3.0・§3.1 の注記は PR #1757 で済み) | 段 A (pg_cron): PR #1757 で済んだ (origin/main 9f4f6da8 の §3.0 は「いま、このリポジトリの migration が pg_cron に登録しているジョブは 11 つある」で、`` `cleanup-auth-sessions-and-login-history` `` を「そのほか」の箇条書きと §3.1 の注記に挙げている。段 B では pg_cron の文に触れない)。段 B (Vercel): origin/main 9f4f6da8 の 08 の Vercel Cron の文は 4 本 (`email-outbox` #1760・`push-outbox` #1776 が入った後) で、次の 3 か所を直す。① §3.0 (17 行) の「… `push-outbox` (毎分。Push 通知の送信待ちを送る worker。#1136・`mobile/06-push-send.md` §6.6) の 4 本である。」を「… `push-outbox` (毎分。Push 通知の送信待ちを送る worker。#1136・`mobile/06-push-send.md` §6.6)・`login-alerts` (毎分。新しい端末・地域からのログインを本人にメールで知らせる worker。#1190・`cross/16-auth-history-sessions.md` §14.8) の 5 本である。」に (`login-alerts` は列挙の最後 = `push-outbox` の後ろ)。見出し「### 3.0 実装状況 (2026-10-16 更新)」の日付はその PR の日付に。② §3.2 の表の最後の行 (`` `app_log_alerts` (実装済み: #1157) `` の行) の下に 1 行を足す: ジョブ名の列 = `` `login_alerts` (実装済み: #1190) ``・スケジュール (JST) の列 = 毎分・概要の列 = 新しい端末・地域からのログインを本人にメールで知らせる (`/api/cron/login-alerts`。設計は cross/16-auth-history-sessions.md §13.3・§14.8)。行に「実装済み」を書くので、注記の「この表のほかの 11 本」は 11 のまま (表は 12 → 13 行・実装済みは 1 → 2 行)。§3.2 の注記 (176 行) の「… `push-outbox` (この表に無い。毎分。Push 通知の送信待ちを送る worker。#1136・`mobile/06-push-send.md` §6.6) の 4 本。」を「… `push-outbox` (この表に無い。毎分。Push 通知の送信待ちを送る worker。#1136・`mobile/06-push-send.md` §6.6)・`login-alerts` (この表の `login_alerts`。#1190) の 5 本。」に。注記の頭の「2026-10-16 時点の状態」の日付はその PR の日付に。③ §5 の注記 (479 行) の「`vercel.json` にあるのは `process-menu-queue`・`app-log-alerts`・`email-outbox` (#1193)・`push-outbox` (#1136・`mobile/06-push-send.md` §6.6) だけで」を「`vercel.json` にあるのは `process-menu-queue`・`app-log-alerts`・`email-outbox` (#1193)・`push-outbox` (#1136・`mobile/06-push-send.md` §6.6)・`login-alerts` (#1190・cross/16 §14.8) だけで」に (§5 の注記には本数の宣言が無い)。注記の頭の「2026-10-16 時点」の日付はその PR の日付に。PR の時点で origin/main の 08 がさらに変わっていれば (並行の案件が cron を足した・文を変えた)、①〜③ の元の文はその時点の 08 から写し、本数はその実数 + 1、`login-alerts` は同じく列挙の最後に足す。本数の宣言の文の、宣言より前の括弧の中に「の <数> 本」「の <数> つ」を書かない (番兵の正規表現 `` /`vercel\.json` に登録されている Vercel Cron は[^\n]*?の (\d+) 本/ `` は最初の「の <数> 本」に当たる。上の ①・② の括弧は当たらない)。直したら `tests/log-cleanup-dau-snapshot-contract.test.ts` を offload で流して緑を確かめる (§22 N-32) | 段 B の PR と同じ PR (後続の PR にすると、段 B の全件が赤)。段 A の分は PR #1757 で済み |
| `docs/design/mobile/05-auth-session.md` | §2・§3 の末尾 | 「ログイン直後と起動時に `PATCH /api/auth/sessions/current` で端末名を登録 (cross/16 §16)」の 1 節 | 段 B |
| `docs/operations/auth-protection.md` | §3.2 (攻撃対策) | 次の 7 項目を足す (§24 の前提のうち Auth の設定と `auth` の表のトリガーに関わるもの。送信ドメインは `docs/operations/email-domain.md` の持ち物なので足さない): Secure password change は OFF のまま・GoTrue の DB の暗号化は OFF のまま (ON にすると照合が暗号文と比べられない)・`UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` の値と、OFF の間は盗んだセッションで GoTrue を直接呼ぶ変更 (cross/16 S-33) を防げないこと (ON にするかは cross/16 Q-18 の結論を写す)・JWT の有効期間・Session timebox / inactivity は使わない (本書の 30 日のジョブが代わり)・`auth.sessions` / `auth.users` のトリガー 4 本が残っているかの年 1 回の点検 (確かめ方は `SELECT tgname FROM pg_trigger WHERE tgrelid IN ('auth.sessions'::regclass, 'auth.users'::regclass) AND NOT tgisinternal`)・その 4 本は表の所有者 (`supabase_auth_admin`) でないと消せず、migration のロールバックは本体を空にして残すこと (cross/16 §11.7。消すときは Supabase のサポートに頼む) | 段 A |
| `ENV_SETUP.md`・`.env.example` | ① `ENV_SETUP.md` の節「任意の環境変数: ログイン・登録・パスワード再設定の bot 対策（Cloudflare Turnstile、#1165）」の次・`.env.example` の `AUTH_LOGIN_FAILURE_RESET_MINUTES=` の行の次 ② `ENV_SETUP.md` の Vercel の環境変数の表の `` `CRON_SECRET` `` の行 (origin/main 9f4f6da8 の 92 行。「Vercel Cron が … を呼ぶとき」の列挙) | ① `AUTH_LOGIN_ALERT` の説明 (文は §12.6 の逐語。§22 N-2) ② 列挙の「`` `/api/cron/push-outbox` ``（どれも `` `vercel.json` `` の `` `crons` ``）」を「`` `/api/cron/push-outbox` ``・`` `/api/cron/login-alerts` ``（どれも `` `vercel.json` `` の `` `crons` ``）」に (§22 N-43。行のほかの文は変えない。PR の時点で行が変わっていれば、その時点の列挙の最後に足す) | 段 B。② は `vercel.json` に cron を足す段 B の PR と同じ PR (後続の PR にすると、段 B の全件が `tests/env-setup-cron-secret-crons.test.ts` で赤) |
| `src/lib/account-export-tables.ts` | `ACCOUNT_EXPORT_EXCLUDED` の `user_sessions_metadata` の理由 | 「ログインの記録 (IP・端末・不審の印)。本人には設定の『ログイン中の端末』と『最近のログイン』で見せる」に改める (分類は変えない) | 段 B |

追随しない文書は 2 つ。

① `docs/design/membership/05-operator-emergency-ui.md` (:50・:60・:75。非活動を `user_profiles.last_login_at` で判定・表示する形を書く) は、この表に載せない。本書は非活動の判定・一覧 (`is_inactive_user`・`list_orgs_with_inactive_owner`・`list_families_with_inactive_representative`。どれも `auth.users.last_sign_in_at`) を変えず、実装と文書のずれは本書の前からあるもので、本書の変更が新しく作るずれではない (§21.4・§25 Q-19)。揃えるなら membership の設計の別 Issue。

② `docs/design/operator/10-logs-and-mail-retry.md` も、この表に載せない。本書の worker は 10 の公開の契約 `sendEmail(envelope, { idempotencyKey, userId })` (10 §6.3) を呼ぶだけで、10 の表・RPC・worker・運用メール・画面 (§9.2 の一覧の絞り込みを含む。Q-26) を変えない (§7.1・§21.4)。10 の中で呼び出し元を挙げる箇所はどれも、10 の設計の時点の事実か 10 自身の変更の母集合で、後から足された呼び出し元を書き足す一覧ではない: §2 の「呼び出し元 15 か所」(origin/main 9f4f6da8 の 53 行。`git grep 'sendEmail(' origin/main -- src` で数えた当時の数と列挙)・§4.1 の図の「呼び出し元 16 か所」(その 15 か所とお問い合わせの route)・R-19 (「既存の `sendEmail` の呼び出し元 15 か所のうち、§6.6 の 3 か所を除く 12 か所のコードは変えない」)・§6.6 (「呼び出し元で変えるもの」。10 自身が変えた 3 か所とお問い合わせの route の差分の表)。origin/main 9f4f6da8 にある呼び出し元 `src/lib/data-subject-requests/notifications.ts` (#1709) と `src/app/api/family/members/child/route.ts` (#1758) も、10 のこれらの箇所に載っていない。worker の呼び方 (`userId: row.user_id` を渡す・`redactAfterSend` を渡さない・Idempotency-Key `login-alert:<session_id>`・文面 `login_new_device` は秘密を含まない) の正典は本書 §13.3・§18 で、本書の段 B の it (§20.1 の `createLoginAlertWorkerDeps` の send の it) が見張る。文面が秘密を含まない分類は `secret-templates.test.ts` の `PUBLIC_TEMPLATES` (§22 N-40) に、送る側のファイルは `email-send-throttle-contract.test.ts` の `EXEMPT_EMAIL_SENDERS` (§22 N-18) に載る。10 の呼び出し元の数と列挙を今の実数に揃えるなら、operator/10 の別 Issue。

## 24. 運用の前提 (マージ前にオーナーが確かめる)

| 前提 | 確かめ方 | 外れたとき |
|---|---|---|
| Supabase の「Secure password change」(`secure_password_change`) が OFF | ダッシュボード → Authentication → Providers → Email | ON だと、作成から 24 時間を過ぎたセッションの変更が 403 `AUTH_REAUTHENTICATION_REQUIRED` (ログインし直せば通る)。本書は nonce (メールの OTP) を扱わない。ON でも、作成から 24 時間以内の盗んだセッションで GoTrue を直接呼ぶ変更 (S-33) は止まらない (§3) |
| GoTrue の `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` (既定 OFF §3) の値と、ON にするか (Q-18) | ホスト版の設定画面・Management API で見られるか・変えられるかは確かめられていない (Q-18) | OFF (いまの前提) の間は、access token を盗んだ人が GoTrue の `PUT /auth/v1/user` を直接呼ぶと、現在のパスワード無しにパスワードを変えられ、本書の照合・再設定の認可も通らない (S-33。記録はトリガーで残る)。これは本書の前からある穴で、本書は防がない (アプリの経路だけを守る §7.1)。ON にすると止まる (再設定のセッションは GoTrue が免除する)。本書の API は ON でも動く (変更は `current_password` を渡す §13.7)。ON にするのは段 C のマージの後 (それまでの画面は `current_password` を渡さない `updateUser({ password })` で変更し、ON だと 400 になる) |
| JWT (access token) の有効期間は既定の 1 時間以下 | Authentication → Sessions | 失効した端末が PostgREST を直接呼ぶ要求は、JWT の期限まで通る (GoTrue のログアウトと同じ性質。本書の API と refresh は即時に止まる) |
| Session timebox / inactivity timeout は未設定のまま | 同上 | 設定すると GoTrue が `auth.sessions` を消す側になる。本書のトリガーは DELETE を記録するだけなので壊れないが、30 日のジョブと二重になる |
| 送信ドメインの検証 (`docs/operations/email-domain.md`)・`RESEND_API_KEY` | Resend・Vercel の環境変数 | 鍵が無い間は `sendEmail` が登録せず `skipped` (通知は印だけ・`AUTH_LOGIN_ALERT=off` と同じ結果。S-38)。鍵はあるがドメインが未検証の間は、通知は送信待ちに登録され (`alert_sent_at` が入る)、配信で dead になって運用メールに件数が出る (S-37)。検証を済ませた後の再送は、operator/10 の段 C (送信待ちの画面と API) が入っていれば super_admin が `/super-admin/email-outbox` から行える (dead は 30 日で消える)。段 C の前に段 B が入ると、その間の dead の通知は再送できず本人に届かない (アプリに再送の経路が無い §3・Q-23・Q-25)。届く前提の文言をアプリには書かない (v1.8) |
| `auth` スキーマのトリガーは Supabase の管理対象の表に足すもの。表の所有者は `supabase_auth_admin` で、migration を流す `postgres` は作れるが消せない (§3) | 年に 1 度 `pg_trigger` で 4 本を数える (§23 の `auth-protection.md` の行) | Supabase 側の移行で `auth.sessions` / `auth.users` が作り直されるとトリガーが消える (記録が止まるだけでログインは止まらない)。`reconcile` と結合テスト (§20.3) が異常を見つける。migration のロールバック (§11.7) は 4 本を消せないので、関数の本体を空にして残す (記録はしない)。トリガーそのものを消すには表の所有者の権限が要る (Supabase のサポート Q-11) |
| GoTrue の DB の暗号化の設定 (`GOTRUE_SECURITY_DB_ENCRYPTION_*`) は OFF | 本番の `encrypted_password` が全員 bcrypt (`$2…`) (§3) | ON にすると `encrypted_password` が暗号文になり、`auth_password_check` は比べられない (変更は 409 `AUTH_PASSWORD_NOT_SET`・再設定は暗号文の行と比べずに通る)。GoTrue は切り替わった後のログインで `encrypted_password` を書き直す (§3) ので、`password_history` に暗号文の行が足される |

## 25. 未解決事項 (オーケストレーターへの問い)

| # | 問い | 本書の仮置き |
|---|---|---|
| Q-1 | `secure_password_change` の本番の値 (§24) | OFF を前提。ON なら §14.6 の 403 で案内 |
| Q-2 | 失効が PostgREST の直接の要求に効くのは JWT の期限 (≤ 1 時間) 後でよいか | よい (GoTrue のログアウトと同じ)。短くするなら JWT の期限の設定で |
| Q-3 | 放置の終了を 30 日の 1 値にしてよいか (cross/01 §4.1 はロール別) | 1 値。ロール別は `user_profiles.roles` を JOIN する別の migration で足せる |
| Q-4 | 「新しい IP の範囲」だけで通知しないでよいか (§7.1)。端末の種類で比べる方式の限界: 攻撃者が UA を本人の端末の種類 (例 Windows の Chrome) に偽ると、端末の種類では鳴らず、GoTrue を直接呼ぶ経路には国も入らないので通知は届かない (S-4。偽らない Node の既定の UA は「不明な端末」として鳴る §10.1) | しない。変えるなら `decideLoginAlert` の `shouldNotify` 1 行 (IP の範囲で鳴らせば UA を偽る攻撃者も拾えるが、携帯回線・家庭の回線の本人のログインのたびにも鳴る) |
| Q-5 | cross/12 (MFA) の `src/lib/auth/mfa/assurance.ts` (`SessionClaimsSchema`: `sub` は `string().min(1)`・`aal` は `catch('aal1')`・`session_id` は任意。`bearerJwtOf` は 3 セグメントの JWT だけ) と本書の `src/lib/auth/sessions/session-claims.ts` (`SessionClaimsSchema`: `sub`・`session_id` は `uuid()` 必須・`amr` 任意。`bearerTokenOf`) は、どちらも main にある (cross/12 は #1715・#1754・#1783、本書の段 A は #1757)。寄せるか | v1.8 で決めた: **寄せない**。読む claim (`aal` と `session_id` / `amr`) と厳しさ (`sub` の形・`session_id` の要否) が違い、1 つにすると片方の検査が緩むか、両方の用途の和集合の形になる。名前が同じでもモジュールが違い、`assurance.ts` は cross/12 の走査 ⑥ で import 元が限られる (§22 N-42)。本書の段 B〜D は `@/lib/auth/sessions/session-claims` だけを使う。別名にする改名は、段 A のファイルを変えないためしない。統合するなら両設計の改定を伴う別 Issue |
| Q-6 | `src/modules/<name>/` + facade の形はこのリポジトリに無い | 既存の `src/lib/auth/<領域>/` に合わせた |
| Q-7 | モバイルが API の応答を検証する Zod を `packages/shared` に写すか、型だけにするか | 型だけ (`sessions-api.ts` の中に同じ形の type)。写すなら `packages/shared/src/auth-sessions.ts` |
| Q-8 | 既存の 1,331 セッション・195 人のパスワードの写し (§11.2) を migration でやってよいか | やる (ローンチ前・テストの利用者。写さないと一覧に「この端末」が出ない) |
| Q-9 | Web のパスワード変更から Turnstile を外す (§15) | 外す (再認証のサインインが無くなり、API は本人のセッション + rate-limit で守る) |
| Q-10 | support にログイン履歴を見せるか | 見せない (IP は PII。admin / super_admin だけ) |
| Q-11 | `auth` スキーマにトリガーを置くことへの合意 (§24)。置いたトリガーは表の所有者 (`supabase_auth_admin`) でないと消せない (§3) | 置く (Supabase の文書どおりの作法。失敗は握る)。migration のロールバックは関数の本体を空にして 4 本を残す (§11.7)。トリガーそのものを消す必要が出たら Supabase のサポートに頼む |
| Q-12 | 再設定の認可で `amr` の `otp` も受けてよいか (§7.1・§12.4) | 受ける。token_hash (Web の `/auth/callback`) と implicit (モバイルの既定) の再設定は `otp` になる (§3)。`otp` はメールのリンク / コードでメールボックスを持つことを示したセッションで、`recovery` と同じ強さ。`recovery` だけにするなら、Web とモバイルの再設定を PKCE に揃える (モバイルの `flowType: 'pkce'`・メールの雛形) 別の案件が先に要る |
| Q-13 | 作成から 90 日を過ぎて初めてログインした利用者 (と、移行の時点でセッションが 1 つも無かった既存の利用者が、移行の後に初めてログインし、それを worker が判定したとき) に `history_expired` のメールが 1 通届いてよいか (§10.1 の行 2・3)。あわせて、移行で写した行 (§11.2) のうち UA が `node` の行 (Next.js のサーバー経由の Web のログイン = 不明な端末) は比べる相手の端末の種類にならない (不明な端末は一致させない) ので、写した行がその形だけの既存の利用者には、worker が判定する最初の Web のログインで `new_device` のメールが 1 通届く (§10.1 の行 5。2026-10-16 の本番の `auth.sessions` は UA `node` 803 行・ブラウザ 631 行)。段 A の間のログインの行は、段 B の worker が動き始める時点で作成から 24 時間を過ぎていれば判定されず送られない (§11.4) が、比べる相手 (prior) には入る (Web の行は段 A から実際の UA §13.5) ので、段 A の間に同じ端末の種類でログインしていた利用者には、段 B の後のログインで届かない | よい (本人のログインでの 1 通。履歴が消えた乗っ取り (S-26) を取りこぼさない側に倒す)。なくすには、消えない「ログインしたことがある」の印 (新しい表) が要る |
| Q-14 | `user_profiles.last_login_at` / `login_count` は特権列ガード (`guard_user_profiles_privileged` / `_on_insert`、20261008200700) の対象外で、本人が自分の行を PostgREST で書き換えられる (本書の前から同じ)。本書がこの 2 列を「最終ログイン」として意味のある値にするので、ガードに足すか | 本書では足さない (ガードの関数は同意の設計 20261008200700 の持ち物で、`CREATE OR REPLACE` は本書の範囲の外)。運営の画面の値は参考で、ログインの事実はログイン履歴 (`user_sessions_metadata`。本人は SELECT だけ §11.1) が持つ。足すなら別 Issue |
| Q-15 | 再設定で、パスワードの無い利用者 (Google / Apple だけ) が最初のパスワードを作れることを残してよいか (§11.5・S-28) | 残す (いまの `updateUser` の画面と同じ挙動。メールのリンクで本人を確かめたセッションだけが通る R-8)。断るなら §11.5 の決定表の行 6・7 を「パスワードが無ければ `no_password`」に改め、§9 の再設定の行に後退として書く |
| Q-16 | 端末名に使える文字を英数字・空白・`()._,+-` に絞ってよいか (§12.5)。アプリは機種名 (`modelName`) を送り、利用者が付けた端末の名前 (`deviceName`) は送らない | 絞る (攻撃者も自分のセッションに書けるので、URL・日本語の文で人を欺かせない §7.1)。機種名と OS の版は英数字で書ける。合わない名前は登録されず、一覧は UA の言葉 (`device_label`) で出る |
| Q-17 | 要件 `docs/requirements/03-operator-admin.md` §17.4 の「同時ログイン: 最大 5 端末」・ロール別のタイムアウト・`/account/sessions`・`/account/sessions/revoke-all` を本書は採らない (§0.3・§15・§14.3)。要件の文書に注記を足すか、要件の文を改めるか | 注記だけ (§23 の行)。要件の文の改定は設計の PR では行わない (要件の変更は発注の側の判断のため) |
| Q-18 | 盗んだセッション (access token) で GoTrue の `PUT /auth/v1/user` を直接呼ぶ変更 (S-33) を、本書は防がない (照合と再設定の認可はアプリの経路だけ §7.1)。GoTrue の `UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` を ON にするか。ホスト版で変えられるか (§3 では確かめられていない) | 本書の API は ON に備える (変更は `current_password` を GoTrue に渡す §13.7)。ON にするか・変えられるかの確認はオーナーの判断 (§24)。変えられない・ON にしないなら、本書の前からある穴として受け入れる (`secure_password_change` を ON にすると、作成から 24 時間を過ぎた盗んだセッションに限って止まる)。DB のガードで止める案は §7.1 で退けた (止められるのは「API を通らない変更」だけで、ログイン・管理 API まで止めうる)。ON にしても、直接の経路の再利用 (履歴の照合) は止まらない (現在のパスワードか再設定のセッションを持つ本人が直接呼ぶ場合。本人が自分で決まりを外すだけで、乗っ取りにはならない) |
| Q-19 | `user_profiles.last_login_at` が本書で埋まるようになった後も、非活動の一覧・判定 (`is_inactive_user`・`list_orgs_with_inactive_owner`・`list_families_with_inactive_representative`) は `auth.users.last_sign_in_at` を使い、家族の非活動の一覧の「最終ログイン」は `-` の直書きのまま (§21.4)。`docs/design/membership/05-operator-emergency-ui.md` は `user_profiles.last_login_at` を使う形を書いている (本書の前からのずれ) | 本書では変えない (非活動の判定は membership の設計の持ち物で、`auth.users.last_sign_in_at` は GoTrue が全経路で書くので判定は今のままで正しい)。揃えるなら別 Issue |
| Q-20 | 作成から 24 時間 (`LOGIN_ALERT_MAX_AGE_HOURS`) を過ぎた通知の待ちの行は送らずに `done` にする (§11.4)。このため worker (Vercel Cron) が 24 時間以上止まると、その間のログイン (乗っ取りを含む) のメールは届かない (記録・履歴は残る。印 `is_new_*` は NULL)。あわせて、段 B は段 A の migration が本番に入ってから 24 時間以上たってからマージする (§0.2 の注) | 送らない (段の切り替え・worker の停止の後に、何日も前のログインのメールをまとめて届けない R-3)。24 時間は定数 1 つ (§12.1) で、変えるなら値だけ。止まっていた間の期限切れの件数を運営に知らせる仕組みは本書では作らない (要るなら別 Issue) |
| Q-21 | 盗んだ refresh token の使用 (GoTrue の `/token?grant_type=refresh_token` を直接。S-36・§8 の行 35) は、新しいセッションを作らず同じ `auth.sessions` の行を更新するだけなので、本書の通知 (待ちの行を作るのは INSERT のトリガーだけ §10) では知らせない。GoTrue は refresh のたびに行の `user_agent` / `ip` を上書きする (§3) が、本書の refresh のトリガーは `last_active_at` だけを書き、UA / IP の変化を見ない | 知らせない (本書の範囲は「ログイン」= セッションの作成の記録と通知。refresh は Web の middleware・browser の client・モバイルの自動更新で access token の期限 (既定 1 時間 §24) ごとに起き、Web の UA は Next.js のサーバーの `node` なので、refresh の UA / IP の変化で鳴らすと本人の利用のたびに鳴る)。盗まれた端末の行は、本人が一覧で失効 (他の端末の行) か全端末のログアウト (この端末の行) で止める。refresh の UA / IP の変化を記録・判定するなら、refresh のトリガーと判定の入力を足す別 Issue |
| Q-22 | Web の support の一覧 (`src/app/(support)/support/users/page.tsx:206`) は、#1717 で `/api/admin/users` の snake_case の応答 (`last_login_at`・`is_banned` など) を同じ鍵で読むように直ったので、本書で `last_login_at` が埋まると一覧の「最終ログイン」に日時が出る。同じずれ (camelCase の鍵 `lastLoginAt`・`isBanned` などで読む) を持っていたモバイルの support の一覧 (`apps/mobile/app/(support)/support/users.tsx:38`) は、2026-10-16 に削除した。#1598 (§3・§21.4) | 解消した (Web は #1717 で直り、モバイルは #1598 で削除した)。本書では何もしない |
| Q-23 | 届けられなかった通知 (`email_outbox` の dead) を通知の状態 (`alert_sent_at`) に書き戻さない (§7.1 の (a)・v1.8)。運用は dead の運用メール (`ops_email_dead_letter`。1 件から。抑止は app-log-alerts の設定) と、送信待ちの再送 (画面と API は operator/10 の段 C。origin/main には無い §3) で足りるか | 書き戻さないことは変えない (送信待ちの仕組みが全文面に対して持つ経路で、本書だけの経路を作らない)。ただし段 B が operator/10 の段 C より先に本番に入れば、その間の dead の通知は運用メールに件数が出るだけで再送できない (本人に届かない。RPC `requeue_email_outbox` は `service_role` だけ)。段 C の後は画面から再送でき、通知の行は `template` = `login_new_device` と時刻・`user_id` の列で見分ける (§10.2・Q-26)。段 B のマージの条件に段 C の着地を足すかは Q-25。本人の画面 (§15) は `alert_sent_at` を出さず、運営の画面 (§17) は列見出し「通知メールを送信待ちに登録した日時」の列に出す (null は「なし」)。届いたかを画面に出すなら、`email_outbox` を `idempotency_key` で引く読み取りを足す別 Issue |
| Q-24 | 列の名前 `alert_sent_at` を「送信待ちに登録した日時」の意味のまま使う (段 A で本番に入っているので改名しない。v1.8) | そのまま。`COMMENT ON COLUMN` も足さない (段 B に migration を増やさない)。意味は本書 §12.5・§13.4 と段 B の worker のコメントが持つ |
| Q-25 | 段 B のマージの条件に、operator/10 の段 C (送信待ちの画面と API) の着地を足すか。段 C の前に段 B が入ると、その間に dead になった通知は運用メールに件数が出るだけで、アプリから再送できない (§10.2 #8・S-37) | 足さない (条件は §0.2 のまま: 段 A の migration の本番適用 2026-10-16 18:06 JST から 24 時間以上)。段 C の前の dead は、届けられなかった通知として運用メールに件数が残る。足すかはオーケストレーターの判断 |
| Q-26 | 運営が特定の利用者・セッションの通知メールの行を画面で見分けるのに、operator/10 §9.2 の一覧 (絞り込みは `status`・`template`・`cursor`・`limit`。`idempotency_key` を返さず、`user_id` は列として返すだけ) で足りるか | 本書は §9.2 にあるもの (`template` = `login_new_device` の絞り込みと、時刻・`user_id` の列) だけで書く (§10.2・§17)。operator/10 に絞り込みを足す要求は本書では作らない。足りなければ operator/10 の改定 (別 Issue) |
