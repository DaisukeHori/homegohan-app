# operator/ 運用ログの閲覧・アラートとメール送信の送信待ち (outbox)・再試行・デッドレター (#1157 / #1193)

版: v1.6 (2026-10-17 #1708 の整合の追随。段 A (#1737)・段 B (#1760)・段 C (#1806) と秘密を含む文面の伏せ字 (#1785) は main にマージ済み)
改定履歴: v1.0 2026-10-15 新設 (A 型設計ゲート・叩き台) / v1.1 2026-10-15 R1 の指摘の修正 (409 の再試行・dead になった退会の完了メールの伏せ字・アラートの種類の型・cron の数・既存テストの追随) / v1.2 2026-10-15 R2 の指摘の修正 (既存の番兵 3 本の追随・env.ts の 2 項目・requeue の handler の形) / v1.3 2026-10-15 R3 の指摘の修正 (サポートの返信の「メール未送信」の案内の範囲・お問い合わせの管理者通知を送信待ちへ載せ替え・番兵 2 本の追随) / v1.4 2026-10-16 R4 の指摘の修正 (退会の伏せ字に 1c を足す: 他人宛の行の件名・本文・返信先に入った退会者のアドレスを、その部分だけ伏せる。シナリオ S-17) / v1.5 2026-10-16 R5 の指摘の修正 (届けられなかったメールの通知を、15 分の窓で数える形から「まだ知らせていない dead を数え、知らせた行に印 `dead_alerted_at` を付ける」形に替える: 抑止 (60 分) の間・cron の遅れの間に dead になった行も、次に権利を取れた回で 1 回だけ知らせる (持ち越さない例外は §8.3)。RPC 2 本 (`mark_email_outbox_dead_alerted` / `unmark_email_outbox_dead_alerted`)・列 1 つ・シナリオ S-18) / v1.6 2026-10-17 #1708 の整合の指摘の追随 (件名・本文に秘密 (招待・本人確認・本人同意のトークンを含むリンク) を含む文面は、封筒の `contains_secret` で宣言し、`sendEmail` が `redact_after_send` を立てる。送れた・dead のときに退会の完了メールと同じく伏せる: R-10・§6.3・§6.7)

## 0. 位置づけと分冊判定

要件の正本は Issue #1157・#1193 の本文とコメント。前提は、ローンチ前で利用者ゼロ (正しい形で作る) であることと、オーナーの選択 (2026-10-15・選択式) で、ローンチに要るものとしてこの群を作ると決まっていること。本書は、その範囲の中で次の 4 点を決め、Sonnet 5.5 の実装者が手を止めずに実装できる粒度まで展開する。

| 決めること | 本書の決定 (要約) | 詳細 |
|---|---|---|
| app_logs を運営の画面で見る (検索・絞り込み・権限・監査) | 既存の `/super-admin/logs` (#1157 PR #1386) を保ち、**本文の部分一致検索 `q`** と **閲覧の監査ログ (`super_admin.app_logs.list`。1 回の GET = 1 行)** を足す。権限は super_admin のみのまま | §9 |
| アラート (しきい値・通知先・既存の急増通知との関係) | 既存のエラー急増の通知 (`GET /api/cron/app-log-alerts`。#1157 PR #1460) をそのまま使い、**3 つ目の種類 `email_dead_letter` (届けられなかったメール) を同じ cron・同じ `ops_alert_state`・同じ宛先 `OPS_ALERT_EMAIL` で知らせる**。しきい値は「1 件でも」(運用メール自身の失敗は数えない)。窓は持たず、**まだ知らせていない dead を数え、知らせた行に印 (`dead_alerted_at`) を付ける** (抑止 60 分の間・cron の遅れの間に dead になった行も、次に送れる回で 1 回だけ知らせる) | §8 |
| メール送信の失敗の扱い (再試行の回数と間隔・デッドレターの表・運営が見て再送する画面・Resend の Webhook との関係) | 新しい表 **`email_outbox`** (送信待ち / 送信済み / 届けられなかった) を 1 通 = 1 行の記録にする。再試行は **最大 6 回** (間隔 1 分 → 5 分 → 15 分 → 1 時間 → 4 時間)、使い切ったら **dead**。画面 `/super-admin/email-outbox` で見て **再送 (requeue)** できる (監査ログに残す)。Webhook (#1184) が入れる停止リスト (`email_blacklist`) は、登録時と送信時の両方で引く。Webhook 自体は変えない | §5 §7 §9 |
| 送信を fire-and-forget から確実な形にする経路 | **transactional outbox**: `sendEmail` は Resend を呼ばず、`email_outbox` に 1 行入れて返る。送るのは **Vercel Cron が 1 分おきに呼ぶ `GET /api/cron/email-outbox`** だけ (Node ランタイム。pg_cron → net は使わない)。既存の呼び出し元 15 か所のコードは、§6.6 の 3 か所を除いて変えない。`sendEmail` を通らず Resend を直接呼んでいたお問い合わせの管理者通知 (`src/app/api/contact/route.ts`) も `sendEmail` に載せ替え (§6.6)、Resend を呼ぶのは worker だけにする (新しい見張り `tests/email-resend-boundary-scan.test.ts`) | §6 |

**分冊判定 (相 1 で実施)**: 目安 3 つ (800 行超・消費先 3 以上・共有面 2 つ以上) にすべて当たる (本書 ≈ 2,020 行、消費先 = sendEmail の呼び出し元 (お問い合わせの route を含む) / cron / super-admin 画面 / migration、共有面 = `ops_alert_state` と cron `app-log-alerts` / メール送信の基盤 `src/lib/emails`)。それでも **1 冊にする**。理由: (a) 核 (`email_outbox` と RPC・`sendEmail` の enqueue・worker) と配線 (画面・API・アラートの 3 つ目の種類) は 1 つの表と RPC の契約で結ばれ、契約は本書で逐語に確定するので、配線を別冊にしても参照する実コードは本書の DDL と同じになる。(b) 画面と API は「繋ぐだけ」(表を読む・RPC を 1 本呼ぶ) で、画面ごとの設計ゲートを積まない。(c) 実装は §13 の 3 段 (A: DB / B: 送信経路と worker とアラート / C: 画面・API・ログ閲覧の検索と監査) に分け、段ごとに 2 枚のレビューを通す (同じ WF・同じ worktree)。収束しなければ段 C を別冊に切り出す (核は段 A + B)。

規約: `docs/design/CLAUDE.md` (章構成・snake_case・RLS 厳格化・監査ログ必須) と `operator/CLAUDE.md` に従う。監査ログの正本は `07-audit-monitoring.md`、cron の正本は `08-cron-batches.md`、表の一覧は `01-data-model.md` (追随表 §15)。

## 1. 目的・スコープ

### 1.1 解決すること

- メールの失敗が握りつぶされる (#1193): いまの `sendEmail` (`src/lib/emails/send.ts`) は同期で Resend を呼び、一時的な失敗だけを 500ms → 1s → 2s で最大 3 回再試行する (合計 4 回・約 3.5 秒)。それでも失敗すると `app_logs` に error を 1 行残すだけで、**記録の表も、あとからの再試行も、運営が見て再送する手段も無い**。送信元ドメインが未検証の本番 (`docs/operations/email-domain.md`) では、招待・譲渡・退会の完了メールがすべてこの経路で消えている。お問い合わせの管理者への通知 (`src/app/api/contact/route.ts` の `sendAdminNotification`) は `sendEmail` すら通らず、Resend の API を直接 `fetch` し、失敗は `console.error` だけ (`app_logs` にも残らない) で、再試行も無い。
- 運用の見え方 (#1157): ログの閲覧と急増の通知は入った。残っているのは、本文での検索と、誰がログを見たかの監査、そして「メールが届いていない」ことに気づく仕組み。

### 1.2 対象外 (本書では決めない・変えない)

- Resend の Webhook (`POST /api/webhooks/resend`。#1184) の受け口と振り分け (`src/lib/emails/resend-webhook-event.ts`) は変えない。配信済み / 開封の記録 (`email_delivery_logs` の更新) も作らない (#1577 の 5 で記述の差を解消する側)。
- `email_delivery_logs` 表は消さない・変えない。新しく書くのは `email_outbox` だけにし、唯一の書き手だった `src/lib/admin/send-ticket-reply-email.ts` は `email_delivery_logs` への INSERT をやめる (§6.6)。
- Supabase Auth が送るメール (サインアップの確認・パスワード再設定) は `sendEmail` を通らないので対象外。
- 急増通知のしきい値 (20 件 / 100 件)・窓 (15 分)・クールダウン (60 分) は変えない。
- マーケティングメール・配信停止リンク (`membership/04-email-templates.md` §末尾の将来案) は対象外。
- メンテナンス中の Webhook の扱い (#1577 の 4) は対象外 (worker は `/api/cron` 配下なので、`isMaintenanceExemptPath` で止まらない: `src/lib/maintenance-mode.ts`)。Resend の Webhook (`POST /api/webhooks/resend`) は、#1577 の 4 でメンテナンス中も止めない対象に足した (`operator/02-api-spec.md` §7・§21)。

### 1.3 用語

| 語 | 意味 |
|---|---|
| 送信待ち (queued) | `email_outbox.status = 'queued'`。worker がまだ送っていない、または再試行を待っている |
| 送信済み (sent) | Resend が受け付けた (`resend_message_id` あり)。届いたかどうかは別 (Webhook の範囲) |
| デッドレター (dead) | 再試行を使い切った、または直らない種類の失敗で、worker が送るのをやめた行。運営が画面で見て再送できる |
| 試行 (attempt) | worker が Resend を 1 回呼ぶこと。`attempts` 列に数える。登録時は 0 |
| 再送 (requeue) | super_admin が dead の行を queued に戻す操作 (`requeue_email_outbox`) |
| worker | `GET /api/cron/email-outbox` (Vercel Cron が 1 分おきに呼ぶ) |

## 2. 関連要件と現行の事実

- 要件: `docs/requirements/03-operator-admin.md` §5.3 (監査)・§22.9 (エラー監視)・§15 (運用)。Issue #1157 (ログの閲覧とアラート)・#1193 (メールの再試行とデッドレター)・#1184 / #1577 (Webhook と停止リスト)。
- 現行 (origin/main 2026-10-15。file:line はリサーチの事実):
  - `sendEmail`: `src/lib/emails/send.ts:187`。結果の型は `src/lib/emails/send-result.ts` (`SendEmailSent` / `SendEmailSkipped` / `SendEmailFailed`、`isEmailFailure`、`emailFailureReasons`)。再試行の定数 `MAX_RETRIES = 3`・`RETRY_BASE_DELAY_MS = 500` (send.ts:53-55)。停止リストの引き当て `lookupEmailSuppression` (`src/lib/emails/suppression.ts`)。
  - 呼び出し元 15 か所 (`git grep 'sendEmail(' origin/main -- src` から、定義 `src/lib/emails/send.ts` とコメント `src/lib/emails/send-result.ts`・テストを除いた数): family/invites・family/members/[member_id]/promote・family/representative-transfer (propose・accept)・org/owner-transfer (propose・accept)・operator/membership の dissolve / transfer (family・org)・`src/lib/membership/exit-notification.ts`・`src/lib/membership/org-invite.ts`・`src/lib/account-deletion-notification.ts`・`src/lib/admin/send-ticket-reply-email.ts`・`src/app/api/cron/app-log-alerts/route.ts`。どれも `await` し、`isEmailFailure` か `emailFailureReasons` で失敗だけを記録する (本体の操作は成功のまま)。`void sendEmail` / `waitUntil(sendEmail…)` は 0 件。
  - 急増通知: `src/app/api/cron/app-log-alerts/route.ts` (`checkScope('server' | 'client', …)`)・`src/lib/ops-alerts/app-log-error-spike.ts` (定数・判定。`AppLogAlertScope = 'server' | 'client'`、`APP_LOG_ALERT_COUNT_RPC` / `APP_LOG_ALERT_KEYS` は 2 キーの `Record<AppLogAlertScope, …>` で、`tests/app-log-error-counts-split-contract.test.ts` A-1 / A-2 が `toEqual` で 2 キーを確かめる)・`src/lib/emails/ops/app-log-error-spike.ts` (文面。`SCOPE_WORDING: Record<AppLogAlertScope, …>` が 2 キー)・migration `20261010123500_ops_alert_state.sql` (`ops_alert_state`・`claim_ops_alert`・`release_ops_alert`・`app_log_error_counts`) と `20261011080000_app_log_error_counts_split_client.sql`。
  - ログ閲覧: `src/app/api/super-admin/logs/route.ts`・`src/lib/super-admin/app-logs.ts` (カーソル `encodeAppLogCursor` / `decodeAppLogCursor` / `olderThanCursorFilter`、`parseAppLogsQuery`)・`src/app/super-admin/logs/page.tsx`。監査ログの記録は無い (`recordAdminAudit` の呼び出し 0 件)。
  - 監査ログのヘルパー: `src/lib/admin/audit.ts` (`recordAdminAudit`・`buildListViewDetails`)。一覧の記録の規則は `07-audit-monitoring.md` §4.1.1。
  - 退会時の伏せ字: `prepare_account_deletion` (`supabase/migrations/20261010000100_auth_users_fk_on_delete.sql:363-477`) が `email_delivery_logs.email` などを `redacted@redacted.invalid` にする。
  - pg_cron の登録の書き方: `20261010150000_schedule_log_cleanup_and_dau_snapshot.sql` (`cron.job` の存在を確かめ、同名を unschedule してから `cron.schedule`)。
  - Vercel Cron: `vercel.json` に `process-menu-queue` (毎分)・`app-log-alerts` (15 分おき)・`email-outbox` (毎分。§6.5)・`push-outbox` (毎分。#1136・`mobile/06-push-send.md` §6.6)・`backup-freshness` (日 1 回。#1129・cross/17 §7.3)・`login-alerts` (毎分。#1190・#1720 段 B・cross/16 §14.8) の 6 本。
  - Resend を直接使うのは `src/lib/emails/send.ts` (SDK の `new Resend`) と `src/app/api/contact/route.ts` (`fetch('https://api.resend.com/emails')`。宛先は `ADMIN_NOTIFICATION_EMAIL`、本文に問い合わせた人の生のメールアドレス) の 2 か所 (`git grep -n "from 'resend'\|api.resend.com\|new Resend(" origin/main -- src`)。`tests/email-send-throttle-contract.test.ts` は送信の回数制限の見張りで、Resend の直接利用そのものは禁じていない (contact の route も理由つきで `EXEMPT_EMAIL_SENDERS` に載っている)。
  - サポートの返信メール (#1183): `src/lib/admin/send-ticket-reply-email.ts` が `sendEmail` の結果を `ReplyEmailOutcome` (`src/lib/admin/support-reply-email-status.ts`) にし、`isEmailFailure` なら `{ status: 'failed', reason: 'send_failed' }`。管理画面 `src/app/admin/support/[id]/page.tsx` が `describeReplyEmailOutcome` で「メール未送信: メールの送信に失敗しました…」を出す。
  - `src/modules/` は無い。この repo のモジュール境界は `src/lib/<領域>/` (facade = そのディレクトリの export)。本書もそれに合わせ、`src/lib/emails/` を「メール送信モジュール」の境界とし、**本書の実装後は Resend を直接使うのを `src/lib/emails/outbox.ts` (worker の送信) だけにする** (お問い合わせの通知を `sendEmail` へ載せ替え: §6.6。見張りは新設の `tests/email-resend-boundary-scan.test.ts`: §12)。

## 3. 相 1: 外形固定 — 要件行列とユーザーシナリオ

### 3.1 要件行列 (全 24 行)

| # | 要件 | 根拠 | 本書の節 |
|---|---|---|---|
| R-01 | `sendEmail` の呼び出し元は、メールの失敗で本体の操作を巻き込まない (現行どおり) | send.ts 冒頭の方針・#1193 | §6.3 |
| R-02 | 送るメールは 1 通 = 1 行で DB に記録され、送信前に失われない (fire-and-forget をやめる) | #1193「キュー・リトライ・デッドレター皆無」 | §5 §6 |
| R-03 | 一時的な失敗は時間をおいて再試行する。回数と間隔は定数で、回数は環境変数で変えられる | #1193・CLAUDE.md マジックナンバー禁止 | §6.1 |
| R-04 | 直らない失敗・使い切った失敗は dead として残り、運営の画面で見える | #1193「デッドレター」 | §5 §9.2 |
| R-05 | super_admin は dead の行を再送できる。再送は監査ログに残る | 仕様「運営が見て再送する画面」・CLAUDE.md 監査ログ必須 | §9.2 §10 |
| R-06 | 同じメールが 2 通届かない (worker の二重起動・途中停止・再送でも) | #1193・Vercel Cron の二重起動 (ops_alert_state の背景) | §5.2 §6.2 §6.5 |
| R-07 | 停止リスト (`email_blacklist`) に載った宛先へは送らない (登録時・送信時の両方) | #1184 | §6.2 §6.3 |
| R-08 | `RESEND_API_KEY` が無い環境 (開発・CI・未設定の本番) では行を作らず、現行どおり skipped を返す | send.ts の現行・テスト多数 | §6.3 |
| R-09 | 宛先のメールアドレス・件名・本文は `app_logs`・監査ログ・運用メール・API の応答に出さない (表の中だけ) | send.ts の方針・cross/08 §16.2 | §6.2 §6.3 §9.2 |
| R-10 | 退会した本人の生のアドレスを `email_outbox` に残さない (`prepare_account_deletion` が、本人の行 (user_id・宛先が一致) の宛先・件名・本文を伏せ、他人宛の行の件名・本文・返信先に入った本人のアドレスも、その部分だけを伏せる (状態は変えない)。退会の完了メール (`redact_after_send`) は sent になったときも dead になったときも宛先・件名・本文を伏せ、登録時に停止リストに当たったら行を作らない)。件名・本文に秘密 (招待・本人確認・本人同意のトークンを含むリンク) を含む文面 (封筒の `contains_secret`。§6.7) も同じく `redact_after_send` で登録し、生のトークンを sent の 7 日・dead の 30 日のあいだ残さない (cross/15 §3.1 の「生のトークンは保存しない」) | cross/08-legal-compliance.md §16.2 手順 4・6・cross/15 §3.1 | §5.2 (2)(3) §5.3 §6.3 §7.3 |
| R-11 | 表は service_role だけが読み書きできる (RLS + GRANT の完全形) | ops_alert_state の権限の考え方 | §5.1 §5.2 |
| R-12 | 送信済み・dead の行は期限で消える (sent 7 日・dead 30 日)。queued が古くなりすぎたら dead にする (7 日) | app_logs の 30 日と同じ考え方・招待の期限 7 日 | §5.2 (6) §6.2 |
| R-13 | 届けられなかったメールがあれば、運用メールに知らせる (既存の急増通知と同じ宛先・同じ抑止)。数える対象の dead の行は、どれも 1 回だけ通知の件数に入る (抑止の間・cron の発火の遅れの間に dead になった行も、抑止が明けた最初の回で知らせる。通知を送れずに権利を返した回の分は次の回に持ち越す。持ち越さない例外は §8.3) | 仕様「アラート…既存の急増通知との関係」 | §5.2 (5)(7)(8) §8 |
| R-14 | 運用メール自身が届かなくても通知が無限に繰り返されない (#1577 の 8) | #1577 | §8.3 |
| R-15 | worker は Vercel Cron の認証 (`requireCronAuth`) を通し、`/api/cron` の既存の書き方 (Node・`fetchCache = 'force-no-store'`) に合わせる | tests/cron-secret-contract.test.ts | §6.5 |
| R-16 | worker は 1 回の実行を 60 秒に収める (maxDuration)。残りは次の回に回す | Vercel Pro の上限・process-menu-queue と同じ | §6.1 §6.5 §12 |
| R-17 | ログ閲覧 (`/super-admin/logs`) の権限は super_admin のみのまま。本文の部分一致で検索できる | 仕様「検索・絞り込み・権限」 | §9.1 |
| R-18 | ログ閲覧は「1 回の検索 = 1 行」で監査ログに残る (0 件は残さない。値ではなく条件と件数) | 仕様「監査」・07 §4.1.1 | §10 |
| R-19 | 既存の `sendEmail` の呼び出し元 15 か所のうち、§6.6 の 3 か所を除く 12 か所のコードは変えない (結果の型の形を保つ) | 変更の母集合を閉じる | §6.3 §6.6 |
| R-20 | 新しい表・RPC は `database.types.ts` (2 か所) に反映し、migration と対の down.sql を書く | tests/database-types-migrations-contract.test.ts | §5 §13 |
| R-21 | 新しい環境変数は `src/lib/env.ts` の一覧・`.env.example`・`ENV_SETUP.md` にそろえ、値を読むのは 1 ファイル | tests/env-source-scan.test.ts | §6.1 §15 |
| R-22 | 新しい cron (Vercel・pg_cron) は `08-cron-batches.md` §3.0 と数・名前が一致する | tests/log-cleanup-dau-snapshot-contract.test.ts 規則 9 | §15 |
| R-23 | アプリが送るメールはすべて `sendEmail` (送信待ち) を通り、Resend を直接使うのは worker の送信 (`src/lib/emails/outbox.ts`) だけ。お問い合わせの管理者通知も載せ替え、送信待ちの行には問い合わせた人の生のメールアドレスを入れない (全体は `inquiries` にあり、サポートの画面で見る。退会の伏せ字の本文の照合 (§5.3 の 1c) はアカウントのアドレスでしか引けず、ログインした人が別の連絡先アドレスで問い合わせた分は、`inquiries` は user_id で伏せられても、user_id の無い送信待ちの行の本文では引けない) | 仕様「送信を fire-and-forget から確実な形にする経路」・R-10 | §6.6 §12 |
| R-24 | サポートの返信メールの「メール未送信」の案内 (#1183) は、返信を保存した時点で分かる失敗 (宛先なし・設定なし・送信待ちへの登録の失敗・宛先停止リスト・文面の不備) に出す。登録したあとの送信の失敗は worker が再試行し、届けられなければ dead の通知 (§8) と送信待ちの画面 (§9.2) で運営が扱う | #1183・本書の送信経路 (登録と送信が別の時点になる) | §6.6 §7.1 §7.2 |

### 3.2 ユーザーシナリオ (18 本)

| # | シナリオ | 期待する結果 |
|---|---|---|
| S-01 | 家族の代表者が招待を送る。Resend は正常 | 招待は 201。メールは `email_outbox` に queued で入り、次の worker (1 分以内) が送って sent になる |
| S-02 | 招待を送ったとき Resend が 503 を返す (一時障害)。5 分後に復旧 | 1 回目は失敗 → queued のまま 1 分後に 2 回目 → 失敗 → 5 分後の 3 回目で sent。利用者は何もしなくてよい |
| S-03 | 本番で送信元ドメインが未検証 (Resend が 403 `validation_error` を返す) | 1 回目で dead (再試行しない)。15 分以内に運用メール「届けられなかったメールがあります」(届けられなかったメールの通知の抑止 (60 分) の間なら、抑止が明けた最初の回: S-18)。super_admin が画面で見て、ドメインを検証したあとに「再送」→ sent。招待・本人確認・本人同意の文面 (秘密を含む: §6.7) の行は dead の時点で宛先・件名・本文が伏せられるので再送できず、招待した人の再招待・本人の「確認メールを再送」で出し直す (画面は「宛先を伏せた行は再送できません」) |
| S-04 | 停止リストに載っている宛先 (ハードバウンス済み) へ招待を送る | `sendEmail` は送らずに dead (`suppressed`) の行を残し、現行どおり `error.code = 'suppressed'` を返す。運用メールの対象にはしない (画面には出る) |
| S-05 | ローカル開発・CI (`RESEND_API_KEY` 無し) で招待を送る | 行を作らず skipped (`not_configured`) を返す。現行のテストの挙動は変わらない |
| S-06 | worker が 20 通のうち 5 通目の送信中に止められた (デプロイの切り替え) | 5 通目はリース (120 秒) が切れたあとの回で取り直される。同じ Idempotency-Key で送るので、1 回目が実は届いていても 2 通にならない |
| S-07 | Vercel Cron が同じ分の worker を 2 回呼んだ | `FOR UPDATE SKIP LOCKED` で同じ行を 2 本が取らない。各行は 1 本だけが送る |
| S-08 | 利用者が退会する | 完了メールは queued → sent のあと、宛先・件名・本文が伏せられる (`redact_after_send`)。退会の直前に、その人宛の queued の行 (古い招待など) は dead (`recipient_deleted`) になり、宛先は伏せられる。worker がその行を送っている途中 (リース中) に退会した場合は、送信が済んでも行は dead (`recipient_deleted`)・伏せ字のまま残る (記録を伏せることを優先する。通知の対象にしない)。完了メールが届けられずに dead になった場合も、その時点で宛先・件名・本文が伏せられ、再送はできない (画面は「宛先を伏せた行は再送できません」) |
| S-09 | Resend の鍵が無効になり、10 日間そのままだった (送るたびに 401 `invalid_api_key`) | 401 は再試行しない (§7.1 の 4xx の行) ので、各行は 1 回目で dead (`invalid_api_key`)。`RESEND_API_KEY` を直して再送できる。再送しても作成から 7 日を超えた行は `expired` で dead。招待・本人確認・本人同意の文面 (秘密を含む: §6.7) の行は dead の時点で伏せられるので再送できず、招待などを出し直す |
| S-10 | 運用メールの宛先 `OPS_ALERT_EMAIL` が停止リストに載った状態で、エラーが急増する | `sendEmail` は suppressed を返すが、cron は権利を返さない (60 分の抑止が効く)。15 分ごとの繰り返しにならない。画面に dead (`suppressed`・template `ops_app_log_error_spike`) が残る |
| S-11 | super_admin が画面で dead の 1 行を「再送」する | 行は queued (attempts 0・requeue_count +1) になり、次の worker が送る。`admin_audit_logs` に `super_admin.email_outbox.requeue` が 1 行 |
| S-12 | super_admin がアプリログを「timeout」で本文検索する。admin が同じ API を呼ぶ | super_admin: message / error_message に timeout を含む行が新しい順に出て、`admin_audit_logs` に `super_admin.app_logs.list` が 1 行 (条件と件数だけ)。admin: 403 で記録なし |
| S-13 | Resend の鍵が 1 時間無効になり (401 `invalid_api_key`。非 retryable)、その間に送ろうとした 40 通が、送るたびに dead になった (dead になる時刻は 1 時間に散らばる) | 運用メールは 2 通。1 通目は最初の dead のあとの回 (15 分以内) で、その時点のまだ知らせていない件数。抑止 (60 分) の間の回は送らず、行に印も付けない。抑止が明けた最初の回で、その間に dead になった残りの行の件数で 2 通目。40 行はどれも、どちらか一方の通知の件数に 1 回だけ入る。文面は template ごとの件数と画面へのリンク。復旧後、super_admin が 40 行を 1 行ずつ再送する (一括は作らない) |
| S-14 | 時間がたつ | sent は 7 日、dead は 30 日で pg_cron (`cleanup-email-outbox`・毎日 03:20 JST) が消す。queued は消さない (worker が 7 日で dead にする) |
| S-15 | サポート担当がチケットに顧客向けの返信をする。本番で送信元ドメインが未検証 (Resend が 403) | 返信は 201・`email.status = 'sent'` (送信待ちに受け付けた) で、チケットの画面に「メール未送信」は出ない。worker の 1 回目で dead → 15 分以内 (抑止の間なら、抑止が明けた最初の回) に運用メール (template `support_ticket_reply` 1 件)。super_admin がドメインを検証してから画面で再送 → 顧客に届く。送信待ちへの登録そのものが失敗したときだけ、現行どおり `failed / send_failed` で「メール未送信」が出る |
| S-16 | ログインしていない人がお問い合わせを送る (`ADMIN_NOTIFICATION_EMAIL` 設定済み) | 問い合わせは `inquiries` に保存され 200。管理者への通知は送信待ち (template `contact_admin_notification`) に入り、worker が送る。本文の送信者は `u***@example.com` のようにマスクし、全体はサポートの画面 (`/support/inquiries`) で見る。Resend が落ちていれば再試行し、届けられなければ dead の通知の対象になる。`ADMIN_NOTIFICATION_EMAIL` 未設定なら送信待ちに入れず warn だけ |
| S-17 | 運営が組織のオーナーを強制譲渡する (通知 3 種。新オーナー宛の本文に旧オーナーのアドレス)。新オーナー宛は Resend の一時障害で再試行待ち (queued)、旧オーナー宛と一般メンバー宛は送信済み (sent)。5 分後に旧オーナーが退会する | 旧オーナー宛の行は宛先・件名・本文が伏せられる (sent のまま)。新オーナー宛の行は状態・試行回数・Idempotency-Key がそのままで、本文の旧オーナーのアドレスの部分だけが `redacted@redacted.invalid` になり、次の試行で伏せた本文が送られる。一般メンバー宛 (本文は新オーナーのアドレスだけ) は変わらない。家族の招待 (招待者)・昇格の依頼 (代表者) の本文に、表示名の代わりに入ったアドレスも同じ |
| S-18 | 招待 (`family_invite`) が 1 通 dead になり、運用メールが 1 通届いた。その 25 分後、抑止 (60 分) の間に、別の原因でサポートの返信 (`support_ticket_reply`) が 1 通 dead になる。その後は dead は出ない。Vercel Cron の発火が遅れ、回の間が 15 分より空くことがある | 抑止が明けた最初の回で、`support_ticket_reply` 1 件の運用メールが届く (2 通目)。1 通目に数えた `family_invite` の行は 2 通目に数えない。cron の発火が遅れて回の間が空いても、その間に dead になった行は数え漏れない (窓で区切らない) |

## 4. 相 2・相 3: 構造とその裁定

### 4.1 構造 (確定)

```mermaid
flowchart LR
  C[呼び出し元 16 か所<br/>既存の 15 か所 §2 + お問い合わせの route §6.6<br/>招待・譲渡・退会・チケット・お問い合わせ・運用メール] -->|sendEmail(envelope)| S[src/lib/emails/send.ts<br/>検証 → 停止リスト → INSERT email_outbox]
  S -->|ok:true id=outbox id| C
  S --> T[(email_outbox)]
  W[GET /api/cron/email-outbox<br/>Vercel Cron 毎分] -->|claim_email_outbox| T
  W -->|停止リスト → Resend (Idempotency-Key)| R[Resend]
  W -->|complete / fail| T
  A[GET /api/cron/app-log-alerts<br/>15 分おき] -->|email_outbox_dead_counts → claim_ops_alert → mark_email_outbox_dead_alerted<br/>送れなければ unmark_email_outbox_dead_alerted| T
  A -->|claim_ops_alert → sendEmail| S
  U[/super-admin/email-outbox] -->|GET list / POST requeue| API[/api/super-admin/email-outbox]
  API -->|select masked / requeue_email_outbox| T
  API -->|recordAdminAudit| AU[(admin_audit_logs)]
  K[pg_cron cleanup-email-outbox 03:20 JST] -->|cleanup_email_outbox| T
  D[prepare_account_deletion] -->|本人の行を伏せる・queued→dead / 他人宛の行の本人のアドレスを伏せる| T
```

部品と責務:

| 部品 | 場所 | 責務 |
|---|---|---|
| 送信待ちの表 | `email_outbox` (migration §5) | 1 通 = 1 行。状態 queued / sent / dead。宛先・件名・本文・Idempotency-Key・試行回数・次の試行時刻・リース・最後の失敗 |
| 登録 (enqueue) | `sendEmail` (`src/lib/emails/send.ts`。§6.3) | 封筒の検証 → 鍵の有無 → 停止リスト → INSERT。Resend は呼ばない。結果の型は現行の形のまま |
| 送信 (worker) | `src/lib/emails/outbox.ts` (純粋な処理。§6.2) + `src/lib/emails/outbox-store.ts` (DB。§6.4) + `src/app/api/cron/email-outbox/route.ts` (glue。§6.5) | 取る (claim) → 期限 → 停止リスト → Resend 1 回 → complete / fail。1 回の実行は 60 秒に収める |
| DB の判断 | RPC 8 本 (§5.2。判断の 5 本 `claim_email_outbox` / `complete_email_outbox` / `fail_email_outbox` / `requeue_email_outbox` / `email_outbox_dead_counts` と、掃除の 1 本 `cleanup_email_outbox` と、通知の印の 2 本 `mark_email_outbox_dead_alerted` / `unmark_email_outbox_dead_alerted`) | 取り合い (SKIP LOCKED)・リース・回数と次の時刻・dead の判定・通知の印 (どの dead を知らせたか) を DB で原子的に |
| 通知 | 既存の `app-log-alerts` に 3 つ目の種類 `email_dead_letter` (§8) | まだ知らせていない dead の件数 (運用メール自身・宛先停止・退会は除く。窓は無い) ≥ 1 なら、既存の権利 (`claim_ops_alert`) を取り、その行に印 (`dead_alerted_at`) を付けて 1 通。送れなければ印と権利を返す |
| 画面と API | `/super-admin/email-outbox`・`GET /api/super-admin/email-outbox`・`POST /api/super-admin/email-outbox/[id]/requeue` (§9.2) | 宛先はマスクして一覧。dead を再送。再送は監査ログ |
| ログ閲覧の追加 | `GET /api/super-admin/logs` に `q`、閲覧の監査 (§9.1 §10) | 既存の仕組みに足すだけ |

### 4.2 トレース (18 本を上の構造で手で走らせる)

| # | 走らせた経路 | 結果 (期待と一致) |
|---|---|---|
| S-01 | POST family/invites → RPC で招待作成 → `sendEmail` → 検証 OK → 鍵あり → `lookupEmailSuppression` clear → INSERT (queued, next_attempt_at = now, attempts 0) → `{ ok: true, id }` → 201。worker (≤ 60 秒後): claim → 期限内 → 停止リスト clear → Resend 200 → `complete_email_outbox` → sent | 一致 |
| S-02 | worker 1 回目: Resend 503 (retryable) → `fail_email_outbox(retryable=true, max=6, retry_after=60)` → attempts 1・queued・next = +60 秒。2 回目 (1 分後): 503 → attempts 2・next = +300 秒。3 回目 (5 分後): 200 → sent | 一致 (間隔の表 §6.1) |
| S-03 | worker: Resend 403 `validation_error` (statusCode 403 → retryable false) → `fail_email_outbox(retryable=false)` → dead (attempts 1・dead_at)。app-log-alerts (≤ 15 分後): `email_outbox_dead_counts(p_limit 10)` (まだ知らせていない dead。窓なし) → 1 件 > しきい値 0 → `claim_ops_alert('email_dead_letter', 60)` → 取った時刻 T → `mark_email_outbox_dead_alerted(T, 10)` が行に `dead_alerted_at = T` を付けて 1 件を返す → その件数で `sendEmail(運用メール)` → queued → worker が送る (ドメイン未検証なら、この運用メールも dead になるが、template が `ops_` で始まるので数えない)。super_admin: ドメイン検証後に画面で再送 → `requeue_email_outbox` → queued (attempts 0) → sent。秘密を含む文面の行 (`redact_after_send`: §6.7) は dead にするとき `fail_email_outbox` が伏せる → `requeue_email_outbox` は 'redacted' (再送できない) | 一致 |
| S-04 | `sendEmail`: 停止リスト suppressed → INSERT (status dead, last_error_code 'suppressed', attempts 0, dead_at now。`redact_after_send` の登録 (退会の完了メール・秘密を含む文面) だけは INSERT しない: S-08・§6.7) → 現行と同じ `suppressed` の失敗を返す。`email_outbox_dead_counts` は `last_error_code = 'suppressed'` を除くので通知しない | 一致 |
| S-05 | `sendEmail`: 鍵なし → INSERT せず skipped (`not_configured`) | 一致 (現行の挙動) |
| S-06 | claim で `lease_expires_at = now + 120 秒`・`worker_id`。5 通目の途中で停止 → 行は queued のまま lease 内。次の分の worker は lease が切れるまで取らない → 2 分後の回で取り直し → 同じ `idempotency_key` で Resend へ → Resend は 24 時間同じキーを覚え、1 回目が届いていれば同じ結果を返す。1 回目の要求がまだ Resend の中で処理中なら 409 `concurrent_idempotent_requests` が返る → `isRetryableResendError` が true (現行の send.ts と同じ) → `fail_email_outbox(retryable=true)` → queued・次の回で同じキーを送り直し、1 回目の結果を受け取って sent (dead にしない) | 一致 |
| S-07 | 2 本の claim が同時: `FOR UPDATE SKIP LOCKED` で行の集合が重ならない。complete / fail は `worker_id` の一致を条件にするので、もう片方の更新は 0 行 | 一致 |
| S-08 | 退会: `prepare_account_deletion` が `email_outbox` の本人の行 (user_id または宛先一致) を伏せ、queued は dead (`recipient_deleted`) にする → deleteUser → `notifyAccountDeleted` → `sendEmail(…, { redactAfterSend: true })` → queued (redact_after_send true) → worker が sent にするとき `complete_email_outbox` が宛先・件名・本文を伏せる。届けられずに dead になるとき (非 retryable・回数切れ・expired・worker 側の suppressed) は `fail_email_outbox` が同じく伏せる → `requeue_email_outbox` は 'redacted' (再送できない)。登録時に停止リストに当たったときは `sendEmail` が行を作らない (suppressed を返すだけ)。競合: worker が本人宛の行を claim して Resend を呼んでいる間に `prepare_account_deletion` が走ると、行は dead (`recipient_deleted`)・`worker_id NULL`・伏せ字になる → Resend が受け付けても `complete_email_outbox` は `worker_id` と `status = 'queued'` のガードで 0 行 (false) → worker は sent に数えず warn (失敗なら `fail_email_outbox` が 'ignored') → 行は dead (`recipient_deleted`) のまま。`email_outbox_dead_counts` は `recipient_deleted` を数えないので通知しない | 一致 |
| S-09 | 401 (`invalid_api_key`) は statusCode 401 → retryable false → 1 回で dead。鍵を直して再送 → queued → worker: `created_at` が 7 日より前なら `fail(expired, retryable=false)` → dead (`expired`)。秘密を含む文面の行 (`redact_after_send`: §6.7) は 1 回目の dead で伏せられ、`requeue_email_outbox` は 'redacted' | 一致 (1 回目で dead・伏せていない行は再送できる・7 日を超えた行は expired。招待などは出し直す。画面にその旨を出す §9.2) |
| S-10 | app-log-alerts: 権利を取る → `sendEmail` → suppressed の失敗 → `releaseClaim` を**呼ばない** (§8.3 の規則: 返さないのは suppressed と invalid_envelope のときだけ。それ以外の ok:false は現行どおり返す) → `send_failed` を返し warn。次の回は deduped | 一致 |
| S-11 | POST requeue: `requireRole(['super_admin'])` → `isUuid` → service role で行を 1 件読む (template・status・user_id) → 無ければ 404 → `requeue_email_outbox(id)` → 'requeued' → `recordAdminAudit({ actionType: 'super_admin.email_outbox.requeue', … })` (user-scoped client) → 200 | 一致 |
| S-12 | GET logs?q=timeout: `parseAppLogsQuery` が q を検証 → `.or(buildMessageSearchFilter(q))` → 行あり → `recordAdminAudit({ actionType: 'super_admin.app_logs.list', details: buildListViewDetails({ q, level, … }, page.length, null) })` → 200。admin: `requireRole` が 403 → 記録なし | 一致 |
| S-13 | 00:00〜01:00 に 40 行が散らばって dead (どれも 401 → retryable false → 1 回目で dead)。app-log-alerts: 00:15 の回は `email_outbox_dead_counts` = 00:15 までの k 件 > 0 → claim OK (T1 = 00:15) → `mark_email_outbox_dead_alerted(T1)` が印の無い dead m 件 (k 件と、数えてから印を付けるまでに dead になった行) に印 → m 件で 1 通目。00:30・00:45・01:00 の回は数えると印の無い行があるが、claim NULL (T1 から 60 分たっていない) → deduped (mark を呼ばない。印は付かない)。01:15 の回 (秒のずれで権利が取れなければ 01:30 の回) は印の無い dead = 40 − m 件 → claim OK (T2) → mark(T2) → 40 − m 件で 2 通目。以後は印の無い行が 0 件 → below_threshold。各行の印は T1 か T2 のどちらか 1 つ。文面は template ごとの件数 (上位 10) + 合計 + リンク | 一致 (2 通・取りこぼし無し) |
| S-14 | pg_cron `cleanup-email-outbox` が `cleanup_email_outbox()` を呼び、`sent_at < now - 7 日` の sent と `dead_at < now - 30 日` の dead を消す。queued は触らない | 一致 |
| S-15 | POST `/api/admin/support/tickets/[id]/messages` (顧客向け) → `sendTicketReplyEmail` → 宛先を `getUserById` で取得 → `sendEmail(renderTicketReplyEmail(…), { userId: ticket.user_id })` → 停止リスト clear → INSERT (queued) → `{ ok: true }` → `{ status: 'sent' }` (§7.1 の対応表) → 201・`describeReplyEmailOutcome` は null (案内なし)。worker: Resend 403 → retryable false → dead (`validation_error`)。app-log-alerts: `email_outbox_dead_counts` → まだ知らせていない `support_ticket_reply` 1 件 → claim → `mark_email_outbox_dead_alerted` で印 → 運用メール。super_admin: 再送 (`requeue_email_outbox` が `dead_alerted_at` を NULL に戻す) → queued → sent。INSERT が失敗した場合: `outbox_failed` → `isEmailFailure` true → `{ status: 'failed', reason: 'send_failed' }` → 「メール未送信: メールの送信に失敗しました…」 | 一致 (R-24) |
| S-16 | POST `/api/contact` (未ログイン) → レート制限 → 検証 → `inquiries` に INSERT → `sendAdminNotification(data)`: `ADMIN_NOTIFICATION_EMAIL` あり → `sendEmail(renderContactAdminNotificationEmail({ …, sender_masked: maskEmailAddress(data.email), inquiries_url }))` (`userId` は渡さない) → INSERT (queued・`to_email` は運営のアドレス・本文の送信者はマスク) → 200。worker が送る。問い合わせた人が退会しても、`prepare_account_deletion` の 1b (user_id・宛先) には当たらず、1c (件名・本文・返信先の照合) にも当たらない (本文はマスクした形だけで、生のアドレスが行に無い。R-23)。`ADMIN_NOTIFICATION_EMAIL` 無し → `sendEmail` を呼ばず warn → 200 | 一致 (R-23) |
| S-17 | POST `/api/operator/membership/org/[id]/transfer` → `renderForceTransferEmail` ×3 → `sendEmail` ×3 (`userId` なし。R-19 で変えない) → 3 行 queued (新オーナー宛の `text_body` に旧オーナーのアドレス)。worker: 旧オーナー宛・一般メンバー宛は 200 → sent。新オーナー宛は 503 → `fail_email_outbox(retryable)` → queued (attempts 1・+60 秒)。旧オーナーの退会: `prepare_account_deletion` → 1b: 旧オーナー宛の sent の行 (宛先が `v_emails` に一致) の宛先・件名・本文を伏せる (sent のまま) → 1c: `v_email_pattern` = 旧オーナーのアドレス (英数字以外をエスケープ) → 新オーナー宛の行 (`to_email` は伏せ字でない) の `text_body` が `~*` に当たる → `regexp_replace(…, 'gi')` で該当部分だけ `redacted@redacted.invalid` に (status queued・attempts 1・`next_attempt_at`・`idempotency_key`・リースは変えない)。一般メンバー宛は新オーナーのアドレスだけなので当たらない → 戻り値 `email_outbox` = 1 + 1 = 2。次の worker: 新オーナー宛を伏せた本文で Resend へ → 200 → `complete_email_outbox` → sent (本文は伏せたまま: `redact_after_send` でない行の本文を complete は上書きしない)。1 回目の要求を Resend がその鍵で受け付けていた (応答を失った) 場合は、本文が変わったので 409 `invalid_idempotent_request` → 非 retryable → dead (§7.1。通知の対象) | 一致 (R-10) |
| S-18 | 00:05 `family_invite` の行が dead (403)。00:15 の回: `email_outbox_dead_counts` → 印の無い 1 件 → claim OK (T1 = 00:15) → `mark_email_outbox_dead_alerted(T1)` → 1 件に印 → 1 通目 (`family_invite` 1 件)。00:40 `support_ticket_reply` の行が dead (印 NULL)。00:45 の回: 数える → 印の無い 1 件 → claim NULL (T1 から 30 分) → deduped (mark を呼ばない)。01:00 の回: 同じく deduped。Vercel Cron の 01:15 の発火が 01:22 に遅れる: 数える → 印の無い 1 件 (窓で区切らないので 00:40 の行も入る) → claim OK (T1 から 67 分。T2 = 01:22) → mark(T2) → `support_ticket_reply` 1 件に印 (`family_invite` の行は印 T1 があるので WHERE に当たらない) → 2 通目 (`support_ticket_reply` 1 件)。01:30 の回: 印の無い行 0 件 → below_threshold (権利を取らない) | 一致 (R-13) |

### 4.3 構造裁定 (1 回だけ)

| 案 | 内容 | 退けた理由 / 採った理由 |
|---|---|---|
| A. 現行 + 失敗時だけ記録 | `sendEmail` は今までどおり同期で送り、最終的に失敗したものだけをデッドレター表に入れて cron が再試行する | 送る前に落ちた (関数の停止・応答の喪失) 分は記録されない (fire-and-forget のまま)。送る側が 2 つ (同期 + cron) になり、二重送信を防ぐリースと結果の型の 3 つ目の状態 (deferred) が要る |
| B. 同期の 1 回目 + outbox | 行を入れてから同期で 1 回送り、失敗なら worker に任せる | A と同じく送る側が 2 つ。呼び出し元が見る結果が sent / deferred / failed の 3 種になり、15 か所の分岐とテストが変わる。得られるのは「1 分の遅れ」が無いことだけで、このアプリのメール (招待・通知・運用) に 1 分を争うものは無い |
| **C. 純粋な outbox (採用)** | `sendEmail` は DB に入れるだけ。送るのは worker だけ | 送る側が 1 つで、二重送信の防止 (Idempotency-Key + リース + SKIP LOCKED) が 1 か所に閉じる。呼び出し元の結果の型の形を保てる (`ok: true` = 受け付けた)。失敗の記録・再試行・再送が同じ表で完結する |

「縁の発生源を消すより単純な構造は無いか」: 送信の同期経路そのものを消したのが C。残る縁は (1) 鍵が無い環境 (行を作らず skipped: R-08)、(2) 停止リストの登録時の判定 (行を dead で残すだけで、送る側の判定は worker 1 か所)、(3) 運用メールが outbox を通ることで生まれる自己参照 (数えない規則 §8.3 で切る)。以後、構造の疑義は裁定への差し戻し事由として扱い、仕上げ相では蒸し返さない。

Vercel Cron を選び pg_cron → `net.http_post` を選ばない理由: Resend の SDK は Node で動き、既存の精算 (`process-menu-queue`) と同じ形で済む。pg_cron 経由は Vault の秘密と HTTP の往復が増える (`20261011120000_segment_stats_finalize_retry.sql` の形) ので、必要になるまで足さない。

## 5. データモデル (migration。正典)

ファイル: `supabase/migrations/<番号はマージ時に確定>_email_outbox.sql` と対の `supabase/rollbacks/<同じ番号>_email_outbox.down.sql`。番号はマージ直前に origin/main の `supabase/migrations` の最大 (2026-10-15 時点 `20261015180000_meal_image_jobs_pickup_cron.sql`) より大きい値にする。適用後に `database.types.ts` を 2 か所 (`src/types/` と `packages/shared/src/`) で作り直す (`tests/database-types-migrations-contract.test.ts` の手順)。

### 5.1 表 `email_outbox`

```sql
-- migration: <番号>_email_outbox.sql
-- #1193 / #1157: メールの送信待ち (outbox)。sendEmail は Resend を呼ばず、この表に 1 行入れる。
-- 送るのは GET /api/cron/email-outbox (Vercel Cron・毎分) だけ。再試行は最大 EMAIL_OUTBOX_MAX_ATTEMPTS 回 (既定 6)、
-- 使い切ったら dead。super_admin は /super-admin/email-outbox で dead を再送 (requeue) できる。
-- 権限の考え方は 20261010123500_ops_alert_state.sql と同じ (service_role だけ。関数は SECURITY INVOKER・search_path '')。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS / CREATE INDEX IF NOT EXISTS。
-- 既存の行・表には触れない。prepare_account_deletion は 20261010000100 の定義を土台に、email_outbox の段 (1b・1c) を足す (§5.3)。
-- 確認: tests/integration/rls/email-outbox.test.ts / ロールバック: supabase/rollbacks/<番号>_email_outbox.down.sql

CREATE TABLE IF NOT EXISTS public.email_outbox (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'dead')),
  -- 文面の名前 (EmailEnvelope.template。無ければ 'unknown')。運用メールは 'ops_' で始まる (§8.3 で数えない)
  template           TEXT        NOT NULL CHECK (char_length(template) BETWEEN 1 AND 100),
  to_email           TEXT        NOT NULL CHECK (char_length(to_email) BETWEEN 3 AND 320),
  from_email         TEXT        NOT NULL CHECK (char_length(from_email) BETWEEN 3 AND 320),
  reply_to           TEXT        CHECK (reply_to IS NULL OR char_length(reply_to) BETWEEN 3 AND 320),
  subject            TEXT        NOT NULL,
  text_body          TEXT        NOT NULL,
  html_body          TEXT,
  -- 誰についてのメールか (任意。退会時の伏せ字と画面の絞り込みに使う)。退会で NULL になる
  user_id            UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
  -- Resend の Idempotency-Key。再試行・再送でも同じ値 (1 回目が届いていても 2 通にならない)
  idempotency_key    TEXT        NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  -- true なら、送れたとき (sent) と届けられなかったとき (dead) に宛先・件名・本文を伏せる (退会の完了メール。cross/08 §16.2 手順 6)
  redact_after_send  BOOLEAN     NOT NULL DEFAULT false,
  attempts           INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requeue_count      INTEGER     NOT NULL DEFAULT 0 CHECK (requeue_count >= 0),
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at   TIMESTAMPTZ,
  worker_id          TEXT,
  last_error_code    TEXT,
  last_error_message TEXT,
  last_status_code   INTEGER,
  sent_at            TIMESTAMPTZ,
  resend_message_id  TEXT,
  dead_at            TIMESTAMPTZ,
  requeued_at        TIMESTAMPTZ,
  -- 届けられなかったメールの運用メール (§8) でこの行を知らせた印。値は app-log-alerts が取った権利の時刻 (claim_ops_alert の戻り値)。
  -- NULL = まだ知らせていない。mark_email_outbox_dead_alerted が付け、送れなかったときは unmark_email_outbox_dead_alerted が外す。
  -- 再送 (requeue_email_outbox) で NULL に戻す (もう一度 dead になれば、また知らせる)
  dead_alerted_at    TIMESTAMPTZ,
  CONSTRAINT email_outbox_status_times CHECK (
       (status = 'queued' AND sent_at IS NULL AND dead_at IS NULL)
    OR (status = 'sent'   AND sent_at IS NOT NULL AND dead_at IS NULL)
    OR (status = 'dead'   AND dead_at IS NOT NULL AND sent_at IS NULL)
  ),
  -- 知らせた印は dead の行にだけ付く (queued / sent に印が残ると、再び dead になったときに知らせなくなる)
  CONSTRAINT email_outbox_dead_alerted_only_dead CHECK (dead_alerted_at IS NULL OR status = 'dead')
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_claim
  ON public.email_outbox (next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_email_outbox_status_created
  ON public.email_outbox (status, created_at DESC, id DESC);
-- dead の行だけの部分索引。掃除 (cleanup_email_outbox の dead_at < now − 30 日) と、通知の数える・印を付ける (§5.2 (5)(7)。dead の行だけを見る) に使う。
-- dead の行は 30 日で消えるので、印の無い行を探すための索引は別に作らない
CREATE INDEX IF NOT EXISTS idx_email_outbox_dead_at
  ON public.email_outbox (dead_at) WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS idx_email_outbox_sent_at
  ON public.email_outbox (sent_at) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_email_outbox_user_id
  ON public.email_outbox (user_id);

ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_outbox FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_outbox TO service_role;
DROP POLICY IF EXISTS email_outbox_deny_client_access ON public.email_outbox;
CREATE POLICY email_outbox_deny_client_access ON public.email_outbox
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.email_outbox IS
  '#1193: メールの送信待ち (outbox)。1 通 = 1 行。queued → sent / dead。service_role のみ。本文を含むので画面には宛先をマスクして件名・本文を出さない。';
```

### 5.2 RPC 8 本 (すべて SECURITY INVOKER・`SET search_path = ''`・EXECUTE は service_role だけ)

```sql
-- (1) 送る行を取る (リース付き・取り合いは SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_email_outbox(
  p_worker_id     TEXT,
  p_limit         INTEGER DEFAULT 20,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF public.email_outbox
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_worker_id IS NULL OR pg_catalog.btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'claim_email_outbox: invalid worker_id' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'claim_email_outbox: invalid limit' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 10 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'claim_email_outbox: invalid lease' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
      FROM public.email_outbox AS o
     WHERE o.status = 'queued'
       AND o.next_attempt_at <= pg_catalog.now()
       AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= pg_catalog.now())
     ORDER BY o.next_attempt_at ASC, o.created_at ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.email_outbox AS o
     SET lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
         worker_id        = p_worker_id,
         updated_at       = pg_catalog.now()
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*;
END $$;

-- (2) 送れた。redact_after_send の行は宛先・件名・本文を伏せる
CREATE OR REPLACE FUNCTION public.complete_email_outbox(
  p_id                UUID,
  p_worker_id         TEXT,
  p_resend_message_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  c_masked_email CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  c_masked_text  CONSTANT pg_catalog.text := '[redacted]';
  v_updated INTEGER;
BEGIN
  UPDATE public.email_outbox AS o
     SET status            = 'sent',
         sent_at           = pg_catalog.now(),
         attempts          = o.attempts + 1,
         resend_message_id = pg_catalog.left(p_resend_message_id, 256),
         lease_expires_at  = NULL,
         worker_id         = NULL,
         updated_at        = pg_catalog.now(),
         to_email  = CASE WHEN o.redact_after_send THEN c_masked_email ELSE o.to_email END,
         subject   = CASE WHEN o.redact_after_send THEN c_masked_text  ELSE o.subject  END,
         text_body = CASE WHEN o.redact_after_send THEN c_masked_text  ELSE o.text_body END,
         html_body = CASE WHEN o.redact_after_send THEN NULL           ELSE o.html_body END
   WHERE o.id = p_id AND o.worker_id = p_worker_id AND o.status = 'queued';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END $$;

-- (3) 送れなかった。再試行するか dead にするかを DB で決める。戻り値は新しい status ('queued' / 'dead')、
--     行が無い・worker が違う・queued でないときは 'ignored'。
--     dead にする行が redact_after_send (退会の完了メール) なら、宛先・件名・本文を伏せる (R-10。再送は 'redacted' で断られる)
CREATE OR REPLACE FUNCTION public.fail_email_outbox(
  p_id                  UUID,
  p_worker_id           TEXT,
  p_error_code          TEXT,
  p_error_message       TEXT,
  p_status_code         INTEGER,
  p_retryable           BOOLEAN,
  p_max_attempts        INTEGER,
  p_retry_after_seconds INTEGER
) RETURNS TEXT
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  c_masked_email CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  c_masked_text  CONSTANT pg_catalog.text := '[redacted]';
  v_status TEXT;
BEGIN
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'fail_email_outbox: invalid max_attempts' USING ERRCODE = '22023';
  END IF;
  IF p_retry_after_seconds IS NULL OR p_retry_after_seconds < 1 OR p_retry_after_seconds > 604800 THEN
    RAISE EXCEPTION 'fail_email_outbox: invalid retry_after' USING ERRCODE = '22023';
  END IF;
  -- NULL だと status (dead) と伏せ字の判定 (伏せない) が食い違うので受け付けない
  IF p_retryable IS NULL THEN
    RAISE EXCEPTION 'fail_email_outbox: invalid retryable' USING ERRCODE = '22023';
  END IF;
  UPDATE public.email_outbox AS o
     SET attempts = o.attempts + 1,
         status   = CASE WHEN p_retryable AND o.attempts + 1 < p_max_attempts THEN 'queued' ELSE 'dead' END,
         dead_at  = CASE WHEN p_retryable AND o.attempts + 1 < p_max_attempts THEN NULL ELSE pg_catalog.now() END,
         next_attempt_at = CASE WHEN p_retryable AND o.attempts + 1 < p_max_attempts
                                THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_after_seconds)
                                ELSE o.next_attempt_at END,
         -- 下の 4 列: dead にする (再試行しない) ときだけ、redact_after_send の行を伏せる。SET の右辺の o.* は更新前の値
         to_email  = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts)
                          THEN c_masked_email ELSE o.to_email END,
         subject   = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts)
                          THEN c_masked_text ELSE o.subject END,
         text_body = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts)
                          THEN c_masked_text ELSE o.text_body END,
         html_body = CASE WHEN o.redact_after_send AND NOT (p_retryable AND o.attempts + 1 < p_max_attempts)
                          THEN NULL ELSE o.html_body END,
         last_error_code    = pg_catalog.left(p_error_code, 100),
         last_error_message = pg_catalog.left(p_error_message, 500),
         last_status_code   = p_status_code,
         lease_expires_at   = NULL,
         worker_id          = NULL,
         updated_at         = pg_catalog.now()
   WHERE o.id = p_id AND o.worker_id = p_worker_id AND o.status = 'queued'
  RETURNING o.status INTO v_status;
  RETURN COALESCE(v_status, 'ignored');
END $$;

-- (4) 再送 (dead → queued)。戻り値: 'requeued' / 'not_found' / 'not_dead' / 'redacted' (宛先を伏せた行は送り先が無い)。
--     知らせた印 (dead_alerted_at) は NULL に戻す (もう一度 dead になれば、また知らせる。CHECK email_outbox_dead_alerted_only_dead)
CREATE OR REPLACE FUNCTION public.requeue_email_outbox(p_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  c_masked_email CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  v_status TEXT;
  v_to     TEXT;
BEGIN
  SELECT o.status, o.to_email INTO v_status, v_to FROM public.email_outbox AS o WHERE o.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_status <> 'dead' THEN RETURN 'not_dead'; END IF;
  IF v_to = c_masked_email THEN RETURN 'redacted'; END IF;
  UPDATE public.email_outbox AS o
     SET status = 'queued', attempts = 0, dead_at = NULL, dead_alerted_at = NULL, next_attempt_at = pg_catalog.now(),
         lease_expires_at = NULL, worker_id = NULL,
         requeue_count = o.requeue_count + 1, requeued_at = pg_catalog.now(), updated_at = pg_catalog.now()
   WHERE o.id = p_id;
  RETURN 'requeued';
END $$;

-- (5) まだ知らせていない (dead_alerted_at が NULL の) dead を template ごとに数える (運用メールの通知用。§8)。
--     窓は持たない: 抑止 (claim_ops_alert のクールダウン) の間や cron の発火の遅れの間に dead になった行も、次の回で数える。
--     宛先停止 (suppressed)・退会 (recipient_deleted)・運用メール自身 (template が ops_ で始まる) は数えない。
--     下の WHERE の 5 行 (status から template まで) は (7) mark_email_outbox_dead_alerted の WHERE と同じ条件にする (数えた行 = 印を付けられる行)
CREATE OR REPLACE FUNCTION public.email_outbox_dead_counts(
  p_limit INTEGER DEFAULT 10
) RETURNS TABLE (template TEXT, dead_count BIGINT, total_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'email_outbox_dead_counts: invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT g.template, g.dead_count, (pg_catalog.sum(g.dead_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT o.template, pg_catalog.count(*)::BIGINT AS dead_count
        FROM public.email_outbox AS o
       WHERE o.status = 'dead'
         AND o.dead_alerted_at IS NULL
         AND o.last_error_code IS DISTINCT FROM 'suppressed'
         AND o.last_error_code IS DISTINCT FROM 'recipient_deleted'
         AND o.template NOT LIKE 'ops\_%'
       GROUP BY o.template
    ) AS g
   ORDER BY g.dead_count DESC, g.template ASC
   LIMIT p_limit;
END $$;

-- (6) 掃除 (pg_cron が毎日呼ぶ)。sent は 7 日、dead は 30 日で消す。queued は消さない (worker が 7 日で dead にする)
CREATE OR REPLACE FUNCTION public.cleanup_email_outbox() RETURNS INTEGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  c_sent_retention CONSTANT pg_catalog.interval := interval '7 days';   -- 送れた記録は Resend 側にもある。宛先を長く残さない
  c_dead_retention CONSTANT pg_catalog.interval := interval '30 days';  -- app_logs の保持 (30 日) と同じ
  v_sent INTEGER; v_dead INTEGER;
BEGIN
  DELETE FROM public.email_outbox AS o WHERE o.status = 'sent' AND o.sent_at < pg_catalog.now() - c_sent_retention;
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  DELETE FROM public.email_outbox AS o WHERE o.status = 'dead' AND o.dead_at < pg_catalog.now() - c_dead_retention;
  GET DIAGNOSTICS v_dead = ROW_COUNT;
  RETURN v_sent + v_dead;
END $$;

-- (7) 知らせる行に印を付ける (app-log-alerts が claim_ops_alert で権利を取ったあとに 1 回だけ呼ぶ。§8.2)。
--     まだ印の無い dead (数える条件は (5) と同じ) のすべてに dead_alerted_at = p_alerted_at を付け、
--     印を付けた行だけを template ごとに数えて返す (形は (5) と同じ)。運用メールの件数はこの戻り値で作る
--     (数えたあと印を付けるまでに dead になった行も、印が付けばこの通知に入る。印の付いた行は次の回の (5) に入らない)。
--     p_alerted_at は claim_ops_alert が返した時刻 (権利ごとに違う値)。送れなかったときは (8) がこの値で印を外す
CREATE OR REPLACE FUNCTION public.mark_email_outbox_dead_alerted(
  p_alerted_at TIMESTAMPTZ,
  p_limit      INTEGER DEFAULT 10
) RETURNS TABLE (template TEXT, dead_count BIGINT, total_count BIGINT)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_alerted_at IS NULL THEN
    RAISE EXCEPTION 'mark_email_outbox_dead_alerted: invalid alerted_at' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'mark_email_outbox_dead_alerted: invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH marked AS (
    UPDATE public.email_outbox AS o
       SET dead_alerted_at = p_alerted_at,
           updated_at      = pg_catalog.now()
     WHERE o.status = 'dead'
       AND o.dead_alerted_at IS NULL
       AND o.last_error_code IS DISTINCT FROM 'suppressed'
       AND o.last_error_code IS DISTINCT FROM 'recipient_deleted'
       AND o.template NOT LIKE 'ops\_%'
    RETURNING o.template AS marked_template
  )
  SELECT g.marked_template, g.dead_count, (pg_catalog.sum(g.dead_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT m.marked_template, pg_catalog.count(*)::BIGINT AS dead_count
        FROM marked AS m
       GROUP BY m.marked_template
    ) AS g
   ORDER BY g.dead_count DESC, g.marked_template ASC
   LIMIT p_limit;
END $$;

-- (8) 印を外す (運用メールを送れずに権利を返すとき。§8.3)。p_alerted_at と同じ印の行だけを「まだ知らせていない」に戻し、戻した行数を返す。
--     別の回の印 (時刻が違う) は外さない (release_ops_alert と同じ考え方)
CREATE OR REPLACE FUNCTION public.unmark_email_outbox_dead_alerted(
  p_alerted_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF p_alerted_at IS NULL THEN
    RAISE EXCEPTION 'unmark_email_outbox_dead_alerted: invalid alerted_at' USING ERRCODE = '22023';
  END IF;
  UPDATE public.email_outbox AS o
     SET dead_alerted_at = NULL,
         updated_at      = pg_catalog.now()
   WHERE o.dead_alerted_at = p_alerted_at;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END $$;

REVOKE ALL ON FUNCTION public.claim_email_outbox(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_email_outbox(TEXT, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.complete_email_outbox(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_email_outbox(UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.fail_email_outbox(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_email_outbox(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.requeue_email_outbox(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.requeue_email_outbox(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.email_outbox_dead_counts(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.email_outbox_dead_counts(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_email_outbox() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_email_outbox() TO service_role;
REVOKE ALL ON FUNCTION public.mark_email_outbox_dead_alerted(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_email_outbox_dead_alerted(TIMESTAMPTZ, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.unmark_email_outbox_dead_alerted(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unmark_email_outbox_dead_alerted(TIMESTAMPTZ) TO service_role;
```

(関数ごとに `COMMENT ON FUNCTION` を 1 行ずつ付ける。文面は上の見出しの説明をそのまま使う。)

### 5.3 `prepare_account_deletion` への段 1b・1c (退会時の伏せ字)

`20261010000100_auth_users_fk_on_delete.sql` の `CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)` (363〜477 行) を**逐語で写し**、次の 3 点だけを足す (REVOKE / GRANT / COMMENT も同じ形で写す)。

1. `DECLARE` に次の 3 行を足す (`v_delivery_logs` の行の直後)。

```sql
  v_outbox          pg_catalog.int4 := 0;   -- 1b で伏せた行 (本人の行) と 1c で伏せた行 (他人宛の行) の数の和
  v_outbox_mentions pg_catalog.int4 := 0;   -- 1c で伏せた行の数 (v_outbox に足す)
  v_email_pattern   pg_catalog.text;        -- 1c の照合に使う正規表現 (本人のアドレスを | でつないだもの。アドレスが無ければ NULL)
```

2. `-- 1) メール配信ログ` の UPDATE と `GET DIAGNOSTICS v_delivery_logs` の直後に、次の 1b と 1c を挿入する。

```sql
  -- 1b) 送信待ち (email_outbox): 本人の行 (user_id が本人、または宛先が本人のアドレス) の宛先・件名・本文を伏せる。
  --     まだ送っていない行 (queued) は送り先が無くなるので dead (recipient_deleted) にする。sent / dead は状態のまま伏せるだけ
  UPDATE public.email_outbox AS o
     SET to_email  = c_masked_email,
         subject   = '[redacted]',
         text_body = '[redacted]',
         html_body = NULL,
         status    = CASE WHEN o.status = 'queued' THEN 'dead' ELSE o.status END,
         dead_at   = CASE WHEN o.status = 'queued' THEN pg_catalog.now() ELSE o.dead_at END,
         last_error_code = CASE WHEN o.status = 'queued' THEN 'recipient_deleted' ELSE o.last_error_code END,
         lease_expires_at = NULL,
         worker_id = NULL,
         updated_at = pg_catalog.now()
   WHERE (o.user_id = p_user_id OR pg_catalog.lower(o.to_email) = ANY (v_emails))
     AND o.to_email <> c_masked_email;
  GET DIAGNOSTICS v_outbox = ROW_COUNT;

  -- 1c) 送信待ち (email_outbox): 他人宛の行 (1b で伏せなかった行) の件名・本文・返信先に入った本人のアドレスを、
  --     その部分だけ伏せ字にする (大文字小文字を区別しない)。他人へのメールなので送るのはやめない:
  --     status・attempts・next_attempt_at・リース (worker_id / lease_expires_at)・idempotency_key・to_email は変えない。
  --     例: 運営の強制譲渡の通知 (新オーナー宛の本文の旧オーナーのアドレス)・家族の昇格の依頼と招待 (表示名が無い代表者・招待者のアドレス)
  --     照合の正規表現: 本人のアドレスの英数字以外の文字を \ で文字どおりにし (. や + を任意の文字・繰り返しにしない)、| でつなぐ
  SELECT pg_catalog.string_agg(pg_catalog.regexp_replace(e.addr, '([^[:alnum:]])', '\\\1', 'g'), '|')
    INTO v_email_pattern
    FROM pg_catalog.unnest(v_emails) AS e(addr);
  IF v_email_pattern IS NOT NULL THEN
    UPDATE public.email_outbox AS o
       SET subject    = pg_catalog.regexp_replace(o.subject, v_email_pattern, c_masked_email, 'gi'),
           text_body  = pg_catalog.regexp_replace(o.text_body, v_email_pattern, c_masked_email, 'gi'),
           html_body  = pg_catalog.regexp_replace(o.html_body, v_email_pattern, c_masked_email, 'gi'),
           reply_to   = pg_catalog.regexp_replace(o.reply_to, v_email_pattern, c_masked_email, 'gi'),
           updated_at = pg_catalog.now()
     WHERE o.to_email <> c_masked_email
       AND (o.subject ~* v_email_pattern
            OR o.text_body ~* v_email_pattern
            OR o.html_body ~* v_email_pattern
            OR o.reply_to ~* v_email_pattern);
    GET DIAGNOSTICS v_outbox_mentions = ROW_COUNT;
    v_outbox := v_outbox + v_outbox_mentions;
  END IF;
```

3. 戻り値の `jsonb_build_object` に `'email_outbox', v_outbox` を足す (1b と 1c の行数の和。キーは 1 つ)。

1b: リース中 (worker が送っている途中) の queued も同じく dead にし、`worker_id` / `lease_expires_at` を消す。その worker のあとの `complete_email_outbox` / `fail_email_outbox` は `worker_id` と `status = 'queued'` のガードで 0 行になり、送信が実際に済んでいても行は dead (`recipient_deleted`)・伏せ字のまま残る (§7.3。退会した人の記録を伏せることを、送信済みの記録より優先する)。

1c の決めごと (§7.1 の退会の表・§7.3):

- **対象**: 1b のあとで `to_email` が伏せ字でない行 (= 宛先が本人でない行) のうち、`subject` / `text_body` / `html_body` / `reply_to` のどれかに本人のアドレス (`v_emails` = ログイン用のアドレスと外部ログインの identity のアドレス。小文字) が大文字小文字を問わず含まれる行。状態 (queued・sent・dead) とリースの有無を問わない。`v_emails` は空文字を含まない (20261010000100 の SELECT が `s.email <> ''` で除く。空の選択肢を持つ正規表現はどこにでも当たるので、この除外を写し間違えない)。伏せた行は `to_email` が伏せ字でないので、`requeue_email_outbox` で再送できる (伏せた本文で送る)。
- **状態を変えない理由**: 宛先は他人で、その人へのお知らせ (譲渡・招待など) は送る意味がある。伏せるのは退会した人のアドレスの部分だけ。
- **リース中の行**: worker が送っている途中の要求は、伏せる前の本文 (退会の前に組み立てたもの) で Resend に届く。行の記録は伏せたまま残る (`complete_email_outbox` は `redact_after_send` でない行の件名・本文を `o.*` のまま書くので、1c のあとの値になる。`fail_email_outbox` も同じ)。1c は `worker_id` / `lease_expires_at` を変えないので、その worker の complete / fail はそのまま効く。
- **Idempotency-Key を変えない理由**: 変えると、以前の試行が実は Resend に受け付けられていた (応答を失った) 場合に 2 通目が届く。変えないと、その場合だけ次の試行が 409 `invalid_idempotent_request` (同じ鍵で別の内容。Resend は鍵を 24 時間覚える) になり、§7.1 の非 retryable の行のとおり dead (通知の対象) になる。2 通届くより dead で運営の目に入るほうを採る。
- **照合の幅**: アドレスを文字列として探す (前後の文字の境目は見ない)。本人のアドレスを一部に含む別のアドレス (本人 `a@example.com` に対して `ba@example.com` や `a@example.com.jp`) も、その部分が伏せ字になる (伏せすぎ)。伏せすぎは安全の側で、境目を見る照合は、日本語の文に続けて書かれたアドレスを取りこぼす向きの誤りを作りうるので採らない。
- **呼び出し元を変えない理由 (R-19)**: 本文に他人のアドレスを入れる呼び出し元は、運営の強制譲渡 (`operator-force-transfer.ts` の `old_owner_email` / `new_owner_email`)・家族の昇格の依頼 (`src/app/api/family/members/[member_id]/promote/route.ts` の `requester_name` の既定値 `user.email`)・家族の招待 (`src/app/api/family/invites/route.ts` の `inviterName` の既定値 `user.email`) と、利用者が書く自由な文 (招待の `custom_message`) で、文面の側で全部を閉じることはできない (将来の文面も同じ)。照合を退会の 1 か所に置けば、文面が増えても閉じる。
- **重さ**: `email_outbox` は sent 7 日・dead 30 日で消える表で、退会は 1 人ずつなので、索引の無い正規表現の照合で足りる。

退会の完了メール (`src/lib/account-deletion-notification.ts`) はこの関数の**あと**に `sendEmail(…, { redactAfterSend: true })` で登録するので、ここでは触れない。送れたときは `complete_email_outbox` が (§5.2 (2))、届けられずに dead になるときは `fail_email_outbox` が (§5.2 (3)) 伏せる。登録の時点で宛先が停止リストに載っていたら、`sendEmail` は行を作らない (§6.3)。

### 5.4 pg_cron の登録 (同じ migration の末尾)

`20261010150000_schedule_log_cleanup_and_dau_snapshot.sql` の `DO $$ … $$` と同じ形で: `cron.job` が無ければ飛ばす → `jobname = 'cleanup-email-outbox'` または `command ~* '[[:<:]]cleanup_email_outbox[[:>:]]'` のジョブを unschedule (NOTICE に command は載せない) → `PERFORM cron.schedule('cleanup-email-outbox', '20 18 * * *', 'SELECT public.cleanup_email_outbox();');` (毎日 03:20 JST。`cleanup-old-app-logs` の 03:15 の直後)。

### 5.5 ロールバック `<番号>_email_outbox.down.sql`

順に: (1) `cron.job` があれば `cleanup-email-outbox` を unschedule、(2) `prepare_account_deletion` を `20261010000100` の定義 (逐語) で `CREATE OR REPLACE` し直す (REVOKE / GRANT / COMMENT も)、(3) `DROP FUNCTION IF EXISTS` を 8 本 (引数の型まで完全形。§5.2 の REVOKE / GRANT の行と同じ引数の型: `email_outbox_dead_counts(INTEGER)`・`mark_email_outbox_dead_alerted(TIMESTAMPTZ, INTEGER)`・`unmark_email_outbox_dead_alerted(TIMESTAMPTZ)` など)、(4) `DROP TABLE IF EXISTS public.email_outbox` (ポリシー・索引・権限は表と一緒に消える)。先に Web のデプロイ (`sendEmail` の enqueue・worker・vercel.json) を戻すこと。戻すとメールは同期送信の現行に戻り、queued の行は失われる (送られない)。

## 6. 送信経路 (正典コード)

### 6.1 定数と環境変数

| 名前 | 値 | 根拠 | 変え方 |
|---|---|---|---|
| `EMAIL_OUTBOX_MAX_ATTEMPTS` (定数 6) | 最初の 1 回を含む試行の上限。6 回目の失敗で dead | 間隔の表と合わせて約 5.4 時間。Resend の障害・DNS の反映 (数時間) を越える。それ以上は宛先か設定の問題 | 環境変数 `EMAIL_OUTBOX_MAX_ATTEMPTS` (1〜20。`fail_email_outbox` の上限) |
| `EMAIL_OUTBOX_RETRY_DELAYS_SECONDS` | `[60, 300, 900, 3600, 14400]` (n 回目の失敗のあとの待ち。表より多い回は最後の値) | 1 分・5 分・15 分・1 時間・4 時間。短い障害は数分で、長い障害は数時間で追いつく | 定数 (変えるときは本書) |
| `EMAIL_OUTBOX_BATCH_SIZE` (定数 20) | 1 回の worker が取る行数 | 20 × (送信 ≈ 0.5 秒 + 間隔 0.6 秒) ≈ 22 秒 < maxDuration 60 秒 | 環境変数 `EMAIL_OUTBOX_BATCH_SIZE` (1〜100。`claim_email_outbox` の上限) |
| `EMAIL_OUTBOX_LEASE_SECONDS` | 120 | 1 回の実行 (最長 60 秒) の 2 倍。切れた行は次の回が取り直す | 定数 |
| `EMAIL_OUTBOX_SEND_INTERVAL_MS` | 600 | Resend の既定の上限 2 req/s を下回る間隔 | 定数 |
| `EMAIL_OUTBOX_RUN_BUDGET_MS` | 40,000 | 応答を返す余裕を残して打ち切る (残りはリース切れ後に次の回へ) | 定数 |
| `EMAIL_OUTBOX_QUEUED_MAX_AGE_MS` | 7 日 | 招待の期限 (7 日) を過ぎたメールは送っても無意味。超えた queued は `expired` で dead | 定数 |
| `email_outbox_dead_counts` の数え方 | 窓なし。まだ知らせていない (`dead_alerted_at` が NULL の) dead をすべて数える | 窓で区切ると、抑止 (60 分) の間と cron の発火の遅れの間に dead になった行が、どの通知にも入らない (§8.1)。急増通知の窓 (`APP_LOG_ALERT_WINDOW_MINUTES` 15 分) は使わない | 変えない |
| sent / dead の保持 | 7 日 / 30 日 (`cleanup_email_outbox` の定数) | §5.2 (6) | 定数 (SQL) |

環境変数 2 つは `src/lib/env.ts` の `SERVER_ENV_VARS` に `required: false`・`readOnlyBy: 'src/app/api/cron/email-outbox/route.ts'` で足し、`.env.example` と `ENV_SETUP.md` に書く (§15)。値を読むのは route だけで、解釈 (`resolveEmailOutboxSettings`) は純粋な関数。不正な値は既定に戻し、変数名だけを warn に残す (`resolveAppLogAlertSettings` と同じ)。

`SERVER_ENV_VARS` に足す 2 項目 (逐語。置き場所は `OPS_ALERT_COOLDOWN_MINUTES` の項目の直後・`SUPPORT_REPLY_TO` の前)。`readOnlyBy` を持つ任意の変数には `whenMissing` が必須 (`src/__tests__/lib/env.test.ts` の「値を読む場所が決まっている変数…」の it が `entry.whenMissing?.trim()` を確かめる):

```ts
// tsc:skip — src/lib/env.ts の SERVER_ENV_VARS のオブジェクトリテラルに挿す 2 項目 (断片)
  EMAIL_OUTBOX_MAX_ATTEMPTS: {
    required: false,
    description:
      'メールの送信待ち (email_outbox) の試行の上限 (#1193)。最初の 1 回を含む回数で、これだけ失敗したら届けられなかった (dead) にする。1〜20 の整数',
    whenMissing: '既定の 6 回を使う (不正な値のときも既定値に戻し、warn ログを残す)',
    // 未設定・不正な値の扱い (warn のログ) を、送信待ちの cron の route 1 か所に置いている
    readOnlyBy: 'src/app/api/cron/email-outbox/route.ts',
  },
  EMAIL_OUTBOX_BATCH_SIZE: {
    required: false,
    description: 'メールの送信待ち (email_outbox) を 1 回の cron (毎分) で取り出して送る件数の上限 (#1193)。1〜100 の整数',
    whenMissing: '既定の 20 件を使う (不正な値のときも既定値に戻し、warn ログを残す)',
    readOnlyBy: 'src/app/api/cron/email-outbox/route.ts',
  },
```

`readOnlyBy` を持つので `getOptionalEnv` の引数の型 (`OptionalEnvName`) から外れる (`src/lib/env.ts` の `OptionalNames`)。`src/__tests__/lib/env.test.ts` の追随は §12・§15.1。

### 6.2 `src/lib/emails/outbox.ts` (新設・純粋な処理。型検査の対象)

`maskEmailAddress` / `redactEmailAddresses` と、再試行の対象の判定 (`QUOTA_ERROR_CODES` / `RETRYABLE_ERROR_CODES` / `isRetryableResendError`) は `send.ts` からここへ**判定の中身を変えずに移す** (下の正典のコードが移したあとの形。数値の 429 / 500 は名前付きの定数にし、409 `concurrent_idempotent_requests` の分岐も残す。現行の `src/__tests__/lib/emails/send.test.ts` の再試行の判定の it はそのまま outbox.test.ts へ移って緑のまま) (send.ts は `maskEmailAddress` を `./outbox` から再エクスポートし、既存の import 先 `@/lib/emails/send` を保つ。循環 import を作らないため、このファイルは `send.ts` を import しない)。

```ts
/**
 * メールの送信待ち (email_outbox) — 定数・型・Zod・worker の本体 (#1193)。DB と Resend は引数で受け取る (純粋)。
 * 登録は send.ts (sendEmail)、worker の起動は src/app/api/cron/email-outbox/route.ts、DB の読み書きは src/lib/emails/outbox-store.ts。
 */
import { z } from 'zod';
import { Resend } from 'resend';
import type { EmailSuppressionLookup } from '@/lib/emails/suppression';

// ── 定数 (§6.1) ────────────────────────────────────────────────────────────
export const EMAIL_OUTBOX_TABLE = 'email_outbox';
export const EMAIL_OUTBOX_STATUSES = ['queued', 'sent', 'dead'] as const;
export type EmailOutboxStatus = (typeof EMAIL_OUTBOX_STATUSES)[number];
/** 最初の 1 回を含む試行の上限 (既定)。EMAIL_OUTBOX_MAX_ATTEMPTS で上書き。DB の fail_email_outbox が決める */
export const EMAIL_OUTBOX_MAX_ATTEMPTS = 6;
export const EMAIL_OUTBOX_MAX_ATTEMPTS_MIN = 1;
export const EMAIL_OUTBOX_MAX_ATTEMPTS_MAX = 20;
/** n 回目の失敗のあと、次の試行まで待つ秒数 (1 分・5 分・15 分・1 時間・4 時間)。表より多い回は最後の値 */
export const EMAIL_OUTBOX_RETRY_DELAYS_SECONDS: readonly number[] = [60, 300, 900, 3600, 14400];
/** 1 回の worker が取る行数 (既定)。EMAIL_OUTBOX_BATCH_SIZE で上書き。claim_email_outbox の上限は 100 */
export const EMAIL_OUTBOX_BATCH_SIZE = 20;
export const EMAIL_OUTBOX_BATCH_SIZE_MIN = 1;
export const EMAIL_OUTBOX_BATCH_SIZE_MAX = 100;
/** 取った行のリース (秒)。1 回の実行 (最長 60 秒) の 2 倍。切れた行は次の回が取り直す */
export const EMAIL_OUTBOX_LEASE_SECONDS = 120;
/** 送信の間隔 (ミリ秒)。Resend の上限 2 req/s を下回る */
export const EMAIL_OUTBOX_SEND_INTERVAL_MS = 600;
/** 1 回の実行で送るのに使う時間の上限 (ミリ秒)。超えたら残りを次の回に回す (maxDuration 60 秒に収める) */
export const EMAIL_OUTBOX_RUN_BUDGET_MS = 40_000;
/** これより古い queued は送らず expired で dead にする (招待の期限 7 日と同じ) */
export const EMAIL_OUTBOX_QUEUED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 運用ログ画面と同じく super_admin 専用の、送信待ちの画面のパス */
export const SUPER_ADMIN_EMAIL_OUTBOX_PATH = '/super-admin/email-outbox';
/** 運用メールの template の接頭辞。dead の通知で数えない (自分の失敗で自分を鳴らさない) */
export const OPS_EMAIL_TEMPLATE_PREFIX = 'ops_';
export const UNKNOWN_EMAIL_TEMPLATE = 'unknown';
/** Resend 由来ではない失敗のコード (email_outbox.last_error_code / SendEmailResult.error.code) */
export const EMAIL_OUTBOX_ERROR_CODES = {
  suppressed: 'suppressed',
  expired: 'expired',
  recipientDeleted: 'recipient_deleted',
  networkError: 'network_error',
  invalidResponse: 'invalid_response',
  outboxFailed: 'outbox_failed',
} as const;

// ── 環境変数 (route が読み、ここは文字列を解釈するだけ) ───────────────────
export type EmailOutboxSettingEnvName = 'EMAIL_OUTBOX_MAX_ATTEMPTS' | 'EMAIL_OUTBOX_BATCH_SIZE';
export interface EmailOutboxSettingSources {
  readonly maxAttempts: string | undefined;
  readonly batchSize: string | undefined;
}
export interface EmailOutboxSettings {
  readonly maxAttempts: number;
  readonly batchSize: number;
  /** 不正で既定に戻した変数の名前 (値は返さない) */
  readonly ignored: readonly EmailOutboxSettingEnvName[];
}
const DECIMAL_INTEGER_PATTERN = /^\d{1,15}$/;
function resolveIntegerSetting(raw: string | undefined, fallback: number, min: number, max: number) {
  const text = raw?.trim();
  if (!text) return { value: fallback, ignored: false };
  if (!DECIMAL_INTEGER_PATTERN.test(text)) return { value: fallback, ignored: true };
  const n = Number(text);
  return n < min || n > max ? { value: fallback, ignored: true } : { value: n, ignored: false };
}
export function resolveEmailOutboxSettings(sources: EmailOutboxSettingSources): EmailOutboxSettings {
  const max = resolveIntegerSetting(sources.maxAttempts, EMAIL_OUTBOX_MAX_ATTEMPTS, EMAIL_OUTBOX_MAX_ATTEMPTS_MIN, EMAIL_OUTBOX_MAX_ATTEMPTS_MAX);
  const batch = resolveIntegerSetting(sources.batchSize, EMAIL_OUTBOX_BATCH_SIZE, EMAIL_OUTBOX_BATCH_SIZE_MIN, EMAIL_OUTBOX_BATCH_SIZE_MAX);
  const ignored: EmailOutboxSettingEnvName[] = [];
  if (max.ignored) ignored.push('EMAIL_OUTBOX_MAX_ATTEMPTS');
  if (batch.ignored) ignored.push('EMAIL_OUTBOX_BATCH_SIZE');
  return { maxAttempts: max.value, batchSize: batch.value, ignored };
}
/** n 回目の失敗 (1 始まり) のあとに待つ秒数 */
export function retryDelaySeconds(failedAttempt: number): number {
  const index = Math.min(Math.max(failedAttempt, 1), EMAIL_OUTBOX_RETRY_DELAYS_SECONDS.length) - 1;
  return EMAIL_OUTBOX_RETRY_DELAYS_SECONDS[index] ?? EMAIL_OUTBOX_RETRY_DELAYS_SECONDS[0];
}

// ── マスク (send.ts から移す。中身は変えない) ───────────────────────────────
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return '***';
  const local = [...address.slice(0, at)];
  const domain = address.slice(at + 1);
  return `${local.length >= 3 ? local[0] : ''}***@${domain}`;
}
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}/g;
export function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (address) => maskEmailAddress(address));
}

// ── claim_email_outbox が返す行 (Zod が正本) ────────────────────────────────
export const EmailOutboxClaimedRowSchema = z.object({
  id: z.string().uuid(),
  template: z.string().min(1).max(100),
  to_email: z.string().min(3).max(320),
  from_email: z.string().min(3).max(320),
  reply_to: z.string().min(3).max(320).nullable(),
  subject: z.string(),
  text_body: z.string(),
  html_body: z.string().nullable(),
  idempotency_key: z.string().min(1).max(256),
  attempts: z.number().int().min(0),
  created_at: z.string(),
  redact_after_send: z.boolean(),
});
export type EmailOutboxClaimedRow = z.infer<typeof EmailOutboxClaimedRowSchema>;
/** RPC の応答を検証する。形が違えば例外 (黙って 0 件にしない: app-log-alerts と同じ考え方) */
export function parseClaimedRows(data: unknown): EmailOutboxClaimedRow[] {
  return z.array(EmailOutboxClaimedRowSchema).parse(data ?? []);
}

// ── 送る側 (Resend) ────────────────────────────────────────────────────────
export interface EmailTransportFailure {
  code: string;
  /** 宛先のアドレスはマスク済み */
  message: string;
  statusCode: number | null;
  retryable: boolean;
}
export type EmailTransportOutcome = { ok: true; id: string } | { ok: false; failure: EmailTransportFailure };
export interface EmailTransport {
  send(row: EmailOutboxClaimedRow): Promise<EmailTransportOutcome>;
}
/** 429 でも待てば直る種類ではないもの (送信数の上限) */
const QUOTA_ERROR_CODES: ReadonlySet<string> = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);
/** statusCode が数値でないとき、名前で再試行の対象と見なすエラー */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limit_exceeded', 'internal_server_error', 'application_error', 'concurrent_idempotent_requests',
]);
interface ResendErrorLike { name?: string; message?: string; statusCode?: number | null }
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
/** 409 のうち、同じ Idempotency-Key の要求が Resend の中でまだ処理中のもの。待てば直る (リース切れの取り直しで起きうる) */
const CONCURRENT_IDEMPOTENT_REQUESTS = 'concurrent_idempotent_requests';
/** 再試行すれば直る見込みのある失敗か (429 / 5xx / 409 の処理中 / 通信エラー)。400 / 401 / 403 / 422 などは false */
export function isRetryableResendError(error: ResendErrorLike): boolean {
  const code = error.name ?? '';
  if (QUOTA_ERROR_CODES.has(code)) return false;
  const status = error.statusCode;
  // 数値が返っているときはステータスで判断する。409 のうち、同じキーの要求が処理中のものだけは待てば直る (send.ts の現行と同じ)
  if (typeof status === 'number') {
    return status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN || code === CONCURRENT_IDEMPOTENT_REQUESTS;
  }
  // statusCode が null (または無い) のときは名前で判断する
  return RETRYABLE_ERROR_CODES.has(code);
}
export function createResendTransport(apiKey: string): EmailTransport {
  const resend = new Resend(apiKey);
  return {
    async send(row) {
      try {
        const response = await resend.emails.send(
          { from: row.from_email, to: row.to_email, subject: row.subject, text: row.text_body, html: row.html_body ?? undefined, replyTo: row.reply_to ?? undefined },
          { idempotencyKey: row.idempotency_key },
        );
        if (response.error) {
          const code = response.error.name || 'unknown_error';
          return { ok: false, failure: { code, message: redactEmailAddresses(response.error.message || code), statusCode: response.error.statusCode ?? null, retryable: isRetryableResendError(response.error) } };
        }
        const id = response.data?.id;
        if (!id) return { ok: false, failure: { code: EMAIL_OUTBOX_ERROR_CODES.invalidResponse, message: 'Resend の応答にメール ID がありません', statusCode: null, retryable: false } };
        return { ok: true, id };
      } catch (err) {
        return { ok: false, failure: { code: EMAIL_OUTBOX_ERROR_CODES.networkError, message: redactEmailAddresses(err instanceof Error ? err.message : String(err)), statusCode: null, retryable: true } };
      }
    },
  };
}

// ── DB (実装は outbox-store.ts。ここは契約だけ) ─────────────────────────────
export type OutboxFailOutcome = 'queued' | 'dead' | 'ignored';
export interface OutboxStore {
  claim(workerId: string, limit: number, leaseSeconds: number): Promise<EmailOutboxClaimedRow[]>;
  complete(id: string, workerId: string, resendMessageId: string): Promise<boolean>;
  fail(id: string, workerId: string, failure: EmailTransportFailure, policy: { maxAttempts: number; retryAfterSeconds: number }): Promise<OutboxFailOutcome>;
}

// ── worker の本体 ──────────────────────────────────────────────────────────
export interface OutboxLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void;
}
export interface EmailOutboxWorkerDeps {
  store: OutboxStore;
  transport: EmailTransport;
  /** 送る直前の停止リストの引き当て (lookupEmailSuppression)。引けなければ送る */
  suppression: (address: string) => Promise<EmailSuppressionLookup>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: OutboxLogger;
}
export interface EmailOutboxRunOptions {
  workerId: string;
  maxAttempts: number;
  batchSize: number;
  leaseSeconds?: number;
  sendIntervalMs?: number;
  runBudgetMs?: number;
  queuedMaxAgeMs?: number;
}
export interface EmailOutboxRunSummary {
  claimed: number;
  sent: number;
  /** 失敗して再試行を待つ行 */
  requeued: number;
  dead: number;
  /** dead になった行のコード別の数 (通知の判断は DB の email_outbox_dead_counts が行う。ここは応答とログ用) */
  dead_codes: Record<string, number>;
  /** 時間の予算で打ち切った (残りはリース切れ後に次の回が取る) */
  stopped_early: boolean;
}
const EXPIRED_FAILURE: EmailTransportFailure = { code: EMAIL_OUTBOX_ERROR_CODES.expired, message: '作成から 7 日を超えたため送りませんでした', statusCode: null, retryable: false };
const SUPPRESSED_FAILURE: EmailTransportFailure = { code: EMAIL_OUTBOX_ERROR_CODES.suppressed, message: '宛先停止リストに載っている宛先のため送りませんでした', statusCode: null, retryable: false };

export async function processEmailOutbox(deps: EmailOutboxWorkerDeps, options: EmailOutboxRunOptions): Promise<EmailOutboxRunSummary> {
  const leaseSeconds = options.leaseSeconds ?? EMAIL_OUTBOX_LEASE_SECONDS;
  const sendIntervalMs = options.sendIntervalMs ?? EMAIL_OUTBOX_SEND_INTERVAL_MS;
  const runBudgetMs = options.runBudgetMs ?? EMAIL_OUTBOX_RUN_BUDGET_MS;
  const queuedMaxAgeMs = options.queuedMaxAgeMs ?? EMAIL_OUTBOX_QUEUED_MAX_AGE_MS;
  const summary: EmailOutboxRunSummary = { claimed: 0, sent: 0, requeued: 0, dead: 0, dead_codes: {}, stopped_early: false };

  const rows = await deps.store.claim(options.workerId, options.batchSize, leaseSeconds);
  summary.claimed = rows.length;
  const startedAt = deps.now();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) {
      if (deps.now() - startedAt > runBudgetMs) { summary.stopped_early = true; break; }
      await deps.sleep(sendIntervalMs);
    }
    const meta = { outbox_id: row.id, template: row.template, recipient: maskEmailAddress(row.to_email), attempt: row.attempts + 1 };

    let outcome: EmailTransportOutcome;
    const ageMs = deps.now() - Date.parse(row.created_at);
    if (Number.isFinite(ageMs) && ageMs > queuedMaxAgeMs) {
      outcome = { ok: false, failure: EXPIRED_FAILURE };
    } else {
      const suppression = await deps.suppression(row.to_email);
      if (suppression.status === 'suppressed') {
        outcome = { ok: false, failure: SUPPRESSED_FAILURE };
      } else {
        if (suppression.status === 'lookup_failed') deps.log.warn('宛先停止リストを引けなかったため、確かめずに送ります', meta);
        try {
          outcome = await deps.transport.send(row);
        } catch (err) {
          outcome = { ok: false, failure: { code: EMAIL_OUTBOX_ERROR_CODES.networkError, message: redactEmailAddresses(err instanceof Error ? err.message : String(err)), statusCode: null, retryable: true } };
        }
      }
    }

    if (outcome.ok) {
      const done = await deps.store.complete(row.id, options.workerId, outcome.id);
      if (done) summary.sent += 1;
      else deps.log.warn('送れたが、行は別の worker に取り直されたか、退会で伏せられていました (記録は更新していません)', meta);
      continue;
    }
    const next = await deps.store.fail(row.id, options.workerId, outcome.failure, { maxAttempts: options.maxAttempts, retryAfterSeconds: retryDelaySeconds(row.attempts + 1) });
    const failMeta = { ...meta, error_code: outcome.failure.code, status_code: outcome.failure.statusCode, retryable: outcome.failure.retryable };
    if (next === 'dead') {
      summary.dead += 1;
      summary.dead_codes[outcome.failure.code] = (summary.dead_codes[outcome.failure.code] ?? 0) + 1;
      deps.log.error('メールを届けられませんでした (dead)', new Error(outcome.failure.message), failMeta);
    } else if (next === 'queued') {
      summary.requeued += 1;
      deps.log.warn('メールの送信に失敗しました。時間をおいて再試行します', failMeta);
    } else {
      deps.log.warn('失敗の記録先の行が無い、別の worker に取り直された、または退会で伏せられていました', failMeta);
    }
  }
  return summary;
}
```

### 6.3 `src/lib/emails/send.ts` — `sendEmail` は登録だけ (差分の正典)

残すもの: ファイル冒頭の方針コメント (再試行・Idempotency-Key・停止リストの段落を「worker が行う」に書き換える)、`SendEmailOptions`、`describeEnvelope`、`EmailEnvelopeSchema` の再エクスポート、`createLogger('email')` への記録。消すもの: `MAX_RETRIES` / `RETRY_BASE_DELAY_MS` / `getResend` / `attemptSend` / `sleep` / 再試行のループ / `isRetryableResendError` と 2 つの Set (outbox.ts へ移す) / `maskEmailAddress` と `redactEmailAddresses` の本体 (outbox.ts へ移し、`export { maskEmailAddress } from './outbox'` で再エクスポート)。結果の型 (`send-result.ts`) の**形は変えない** (型・関数・クラスのシグネチャはそのまま)。ただし意味が変わる箇所の JSDoc を段 B で直す (§13 の触るファイルに含める): `EmailSendError.code` の列挙に `outbox_failed` (送信待ちへの登録の失敗) を足す / `EmailSendError.attempts` と `SendEmailSent.attempts` は「Resend へ送った回数」から「`sendEmail` の中で Resend へ送った回数 (常に 0。送るのは worker)」へ / `SendEmailSent` の説明と `id` は「Resend が受け付けた・Resend のメール ID」から「送信待ちに登録した・`email_outbox.id` (受け付けの ID)」へ / `SendEmailFailed` の説明の「再試行を使い切った」を「登録に失敗した (`outbox_failed`)」へ。

```ts
// tsc:skip — 新設モジュール (./outbox) を import するため。形は逐語で実装する
import { randomUUID } from 'crypto';
import { createLogger } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { EmailSendError, type SendEmailResult } from '@/lib/emails/send-result';
import { lookupEmailSuppression } from '@/lib/emails/suppression';
import { EMAIL_OUTBOX_ERROR_CODES, EMAIL_OUTBOX_TABLE, UNKNOWN_EMAIL_TEMPLATE, maskEmailAddress, redactEmailAddresses } from './outbox';
import { EmailEnvelopeSchema, type EmailEnvelope } from './envelope';

export interface SendEmailOptions {
  /** Resend の Idempotency-Key。省略すると登録ごとに randomUUID()。再試行・再送でも同じ値を使う (email_outbox.idempotency_key) */
  idempotencyKey?: string;
  /** 誰についてのメールか (email_outbox.user_id)。退会時の伏せ字と画面の絞り込みに使う。分かる呼び出し元だけ渡す */
  userId?: string;
  /**
   * 送れたとき・届けられずに dead になったときに宛先・件名・本文を伏せ、登録時に停止リストに当たったら行を作らない (退会の完了メール)。既定 false。
   * 封筒の contains_secret が true (件名・本文に秘密を含む文面。#1708) なら、ここを渡さなくても同じく伏せる (false を渡しても伏せる)
   */
  redactAfterSend?: boolean;
}

/** 失敗の結果を作る (attempts は常に 0: Resend にはまだ送っていない) */
function failure(code: string, message: string, skipped: boolean): SendEmailResult {
  const error = new EmailSendError(code, message, null, 0, code === EMAIL_OUTBOX_ERROR_CODES.outboxFailed);
  return skipped ? { ok: false, id: null, attempts: 0, skipped: true, error } : { ok: false, id: null, attempts: 0, skipped: false, error };
}

export async function sendEmail(envelope: EmailEnvelope, options: SendEmailOptions = {}): Promise<SendEmailResult> {
  const logger = createLogger('email');
  const { template, recipient } = describeEnvelope(envelope);

  // 1. 封筒の検証 (現行のまま: ログの文面・error の形も変えない)
  const parsed = EmailEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) { /* 現行の invalid_envelope の分岐をそのまま (logger.error → failure('invalid_envelope', …, false)) */ }
  const v = parsed.data;

  // 2. 鍵が無ければ登録しない (現行のまま skipped / not_configured。開発・CI・未設定の本番で行を作らない)
  if (!process.env.RESEND_API_KEY) { /* 現行の not_configured の分岐をそのまま */ }

  // 3. 停止リスト。載っていれば dead の行を残し (best-effort)、現行と同じ suppressed の失敗を返す。引けなければ登録して worker に任せる。
  //    redact_after_send の行 (退会の完了メール・秘密を含む文面) は残さない: 宛先・件名・本文を伏せる経路 (complete / fail) を通らず、
  //    退会した本人の生のアドレス (R-10) や本文の生のトークン (#1708) が残るため
  const suppression = await lookupEmailSuppression(v.to);
  const row = {
    template: v.template?.slice(0, 100) || UNKNOWN_EMAIL_TEMPLATE,
    to_email: v.to, from_email: v.from, reply_to: v.reply_to ?? null,
    subject: v.subject, text_body: v.text, html_body: v.html ?? null,
    user_id: options.userId ?? null,
    idempotency_key: options.idempotencyKey ?? randomUUID(),
    // 秘密を含む文面 (contains_secret) は、呼び出し元が redactAfterSend を渡し忘れても伏せる (#1708)
    redact_after_send: options.redactAfterSend === true || v.contains_secret === true,
  };
  if (suppression.status === 'suppressed') {
    logger.warn('宛先停止リストに載っている宛先のため、メールを送信しませんでした', { template, recipient, suppression_reason: suppression.reason });
    if (!row.redact_after_send) {
      // 記録は best-effort。例外 (service role の設定が無いなど) も受けて、結果は suppressed のまま返す (sendEmail は例外を投げない: R-01)
      try {
        const { error } = await getSupabaseAdmin().from(EMAIL_OUTBOX_TABLE).insert({ ...row, status: 'dead', dead_at: new Date().toISOString(), last_error_code: EMAIL_OUTBOX_ERROR_CODES.suppressed });
        if (error) logger.warn('送らなかった記録 (dead) を残せませんでした', { template, recipient, pg_code: error.code });
      } catch (err) {
        logger.warn('送らなかった記録 (dead) を残せませんでした', { template, recipient, error_message: redactEmailAddresses(err instanceof Error ? err.message : String(err)) });
      }
    }
    return failure(EMAIL_OUTBOX_ERROR_CODES.suppressed, 'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした', false);
  }
  if (suppression.status === 'lookup_failed') { /* 現行の warn をそのまま (文面は「送信待ちに登録します」に変える) */ }

  // 4. 登録。失敗 ({ error }・行が返らない・例外) は outbox_failed (ok: false / retryable: true)。Resend へは送らない (同期の送信経路は無い)
  //    例外も受けるのは、sendEmail が例外を投げない約束 (R-01) を保つため (getSupabaseAdmin は service role の設定が無いと例外を投げる)
  try {
    const { data, error } = await getSupabaseAdmin().from(EMAIL_OUTBOX_TABLE).insert({ ...row, status: 'queued' }).select('id').single();
    if (error || !data) {
      // error.message だけを使う (error.details には行の値 = 宛先が入りうるので載せない: R-09)
      logger.error('メールを送信待ちに登録できませんでした', new Error(error?.message ?? 'no row'), { template, recipient, error_code: EMAIL_OUTBOX_ERROR_CODES.outboxFailed, pg_code: error?.code ?? null });
      return failure(EMAIL_OUTBOX_ERROR_CODES.outboxFailed, 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', false);
    }
    logger.info('メールを送信待ちに登録しました', { template, recipient, outbox_id: data.id });
    return { ok: true, id: data.id, attempts: 0, skipped: false, error: null };
  } catch (err) {
    logger.error('メールを送信待ちに登録できませんでした', new Error(redactEmailAddresses(err instanceof Error ? err.message : String(err))), { template, recipient, error_code: EMAIL_OUTBOX_ERROR_CODES.outboxFailed, pg_code: null });
    return failure(EMAIL_OUTBOX_ERROR_CODES.outboxFailed, 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', false);
  }
}
```

守ること: `sendEmail` は例外を投げない (DB の失敗も例外も `outbox_failed` の結果にする。R-01)。`isEmailFailure` は `ok: false && !skipped` のまま (outbox_failed・suppressed・invalid_envelope は失敗、受け付けは成功)。`redactEmailAddresses` は `lookup_failed` の warn の `error_message` に現行どおり使う。`app_logs` に宛先・件名・本文を出さない (R-09)。

### 6.4 `src/lib/emails/outbox-store.ts` (新設・DB の読み書き。`database.types.ts` の作り直し後に型が付く)

```ts
// tsc:skip — 段 A で作り直した database.types.ts の RPC の型に依存する
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { parseClaimedRows, type EmailTransportFailure, type OutboxFailOutcome, type OutboxStore } from '@/lib/emails/outbox';

/** RPC の失敗は例外にする (worker の route が 500 にして app_logs に残す。黙って 0 件にしない) */
function rpcError(name: string, error: { message: string; code?: string }): Error {
  return new Error(`${name} failed: ${error.code ?? 'unknown'}`); // message に DB の生の文を入れない (ログは cause で持つ)
}
export function createOutboxStore(admin = getSupabaseAdmin()): OutboxStore {
  return {
    async claim(workerId, limit, leaseSeconds) {
      const { data, error } = await admin.rpc('claim_email_outbox', { p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw rpcError('claim_email_outbox', error);
      return parseClaimedRows(data);
    },
    async complete(id, workerId, resendMessageId) {
      const { data, error } = await admin.rpc('complete_email_outbox', { p_id: id, p_worker_id: workerId, p_resend_message_id: resendMessageId });
      if (error) throw rpcError('complete_email_outbox', error);
      return data === true;
    },
    async fail(id, workerId, failure: EmailTransportFailure, policy): Promise<OutboxFailOutcome> {
      const { data, error } = await admin.rpc('fail_email_outbox', {
        p_id: id, p_worker_id: workerId, p_error_code: failure.code, p_error_message: failure.message,
        p_status_code: failure.statusCode, p_retryable: failure.retryable,
        p_max_attempts: policy.maxAttempts, p_retry_after_seconds: policy.retryAfterSeconds,
      });
      if (error) throw rpcError('fail_email_outbox', error);
      return data === 'queued' || data === 'dead' ? data : 'ignored';
    },
  };
}
```

### 6.5 `src/app/api/cron/email-outbox/route.ts` (新設・glue)

`app-log-alerts/route.ts` と同じ骨格: `export const runtime = 'nodejs'; dynamic = 'force-dynamic'; fetchCache = 'force-no-store'; maxDuration = 60;` `ROUTE_NAME = 'cron/email-outbox'`。`GET` だけを公開する。

import と route 内の定数 (正典。下の glue が使う名前はすべてここから来る。`@/lib/emails/send` は import しない: `tests/email-send-throttle-contract.test.ts`):

```ts
// tsc:skip — 新設モジュール (outbox.ts・outbox-store.ts) が木に入ってから型が付く
import { randomUUID } from 'crypto';                         // send.ts (§6.3) と同じ書き方
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';               // app-log-alerts/route.ts と同じ
import { requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { lookupEmailSuppression } from '@/lib/emails/suppression';
import { createResendTransport, processEmailOutbox, resolveEmailOutboxSettings } from '@/lib/emails/outbox';   // §6.2
import { createOutboxStore } from '@/lib/emails/outbox-store';                                                // §6.4

const ROUTE_NAME = 'cron/email-outbox';

/**
 * 応答を返したあとも関数を延命する時間 (ミリ秒)。app-log-alerts/route.ts の同名の定数と同じ値・同じ理由
 * (createLogger の書き込みは非同期なので、応答の直後に止められると最後のログが失われうる)。
 * app-log-alerts 側は export していないので、この route にも同じ定義を置く (共有化はしない)。
 */
const LOG_FLUSH_GRACE_MS = 1000;
```

```ts
// tsc:skip — 新設モジュールを import する glue。順序と応答の形が正典
export async function GET(req: Request) {
  const authError = await requireCronAuth(req);            // 1. 認証 (401 / 503)。tests/cron-secret-contract.test.ts の規則 4
  if (authError) return authError;
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);
  const apiKey = process.env.RESEND_API_KEY;                 // 2. 鍵が無ければ取らない (queued は残り、鍵が入った回で送る)
  if (!apiKey) { logger.warn('RESEND_API_KEY が未設定のため、送信待ちのメールを送りません'); return NextResponse.json({ status: 'not_configured' }); }
  const settings = resolveEmailOutboxSettings({ maxAttempts: process.env.EMAIL_OUTBOX_MAX_ATTEMPTS, batchSize: process.env.EMAIL_OUTBOX_BATCH_SIZE });
  if (settings.ignored.length > 0) logger.warn('送信待ちの環境変数の値が正しくないため、既定値を使います', { ignored_env: settings.ignored });
  try {
    const summary = await processEmailOutbox(
      { store: createOutboxStore(), transport: createResendTransport(apiKey), suppression: lookupEmailSuppression, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: logger },
      { workerId: randomUUID(), maxAttempts: settings.maxAttempts, batchSize: settings.batchSize },
    );
    if (summary.claimed > 0) logger.info('送信待ちのメールを処理しました', { ...summary });
    const response = NextResponse.json({ status: summary.claimed === 0 ? 'idle' : 'processed', ...summary });
    waitUntil(new Promise<void>((resolve) => setTimeout(resolve, LOG_FLUSH_GRACE_MS)));   // app-log-alerts と同じ延命 (1000ms)
    return response;
  } catch (err) {
    return internalError(ROUTE_NAME, err, { requestId });   // 3. claim / complete / fail の RPC の失敗・応答の形の誤りは 500 (本文は汎用)
  }
}
```

応答 (JSON): `{ status: 'not_configured' | 'idle' | 'processed', claimed, sent, requeued, dead, dead_codes, stopped_early }` (`not_configured` のときは `status` だけ)。`vercel.json` の `crons` に `{ "path": "/api/cron/email-outbox", "schedule": "*/1 * * * *" }` を足す (3 本目)。

### 6.6 呼び出し元で変えるもの (既存の呼び出し元 15 か所のうち 3 か所と、Resend を直接呼んでいたお問い合わせの route の 1 か所。既存の呼び出し元の他の 12 か所は変えない)

| ファイル | 変更 |
|---|---|
| `src/lib/admin/send-ticket-reply-email.ts` | `email_delivery_logs` への INSERT (114 行付近の 3) の段) を**消す** (送信の記録は `email_outbox`)。`sendEmail(envelope, { userId: ticket.user_id })` と `userId` を渡す。`TICKET_REPLY_EMAIL_TEMPLATE` は文面の `template` の名前として残す (JSDoc の「email_delivery_logs.template に入れる値」を「文面の template の名前 (email_outbox.template)」に)。結果の対応 (§7.1 の対応表) は現行のまま: `skipped` → `skipped / not_configured`、`isEmailFailure` → `failed / send_failed`、それ以外 (`ok: true` = 送信待ちに受け付けた) → `sent`。ファイル冒頭のコメントの「送信できたら email_delivery_logs に 1 行残す…」の 2 段落を「送信待ち (email_outbox) に登録できたら sent を返す。登録したあとの送信の失敗はここでは分からない (worker が再試行し、届けられなければ dead の通知と /super-admin/email-outbox で運営が扱う: docs/design/operator/10-logs-and-mail-retry.md §7.2)」に直す。`const resendMessageId = result.id;` も消す |
| `src/lib/admin/support-reply-email-status.ts` | JSDoc だけ (型・`NOT_SENT_MESSAGES` の文面・`describeReplyEmailOutcome` は変えない)。`ReplyEmailStatus` に「`sent` は送信待ちに受け付けた (届いたかどうかは含まない)」、`ReplyEmailReason` の `send_failed` の説明を「メールの送信 (Resend) がエラーになった」から「送信待ちに登録できなかった、または宛先停止リスト・文面の不備で送らなかった (登録したあとの送信の失敗はここには出ない)」に (R-24) |
| `src/app/api/contact/route.ts` | `sendAdminNotification` の中身を下の正典に置き換える (Resend の直接の `fetch` をやめ、`sendEmail` で送信待ちへ。R-23)。`RESEND_API_KEY` は読まなくなる (鍵の有無は `sendEmail` が見る)。`POST` / `GET` の本体・レート制限・`await sendAdminNotification(data)` の位置は変えない |
| `src/lib/account-deletion-notification.ts` | `sendEmail(renderAccountDeletedEmail(…), { redactAfterSend: true })`。`userId` は渡さない (削除後。現行の理由のまま)。冒頭コメントの「email_delivery_logs には書かない」を「email_outbox には、送れたあと・届けられなかったあとは伏せた形でだけ残る (宛先が停止リストに載っていれば行を作らない)」に直す |
| `src/app/api/cron/app-log-alerts/route.ts` | §8 (3 つ目の種類の追加と、権利を返す条件の変更)。`email_id: result.id` のログのキーは `outbox_id` に |

`src/lib/membership/exit-notification.ts` は**変えない** (`userId` を渡さない。本書の「変えない」12 か所に数える)。退会時の伏せ字は宛先の一致でも引く (§5.3 の 1b) ので、`user_id` が無い行も伏せられる。`src/__tests__/lib/membership/exit-notification.test.ts` も変えない。「変えない」12 か所のうち、本文に宛先以外の人のアドレスを入れるもの (運営の強制譲渡の新旧オーナーのアドレス・家族の昇格の依頼と招待の、表示名が無い代表者・招待者のアドレス) も変えない。その人が退会したときは、§5.3 の 1c が本文の該当部分だけを伏せる (R-10)。

サポートの返信の案内 (R-24) の決定: 「メール未送信」の案内は、返信を保存した時点で分かる失敗だけに出す。登録したあとの送信の失敗 (S-15 の 403 など) は、チケットの画面には出さない。代わりに worker が再試行し、届けられなければ dead の通知 (§8。運用メール) と送信待ちの画面 (§9.2。再送できる) で運営が扱う。現行は Resend の失敗で即座に案内を出すが、そのメールは二度と送られない。設計後は案内が出ない代わりに、ドメインの検証などを直したあと再送すれば顧客に届く。チケットの画面に送信待ちの状態 (dead) を出すことは本書ではしない (§16)。

#### お問い合わせの管理者通知 (`src/app/api/contact/route.ts` の `sendAdminNotification`。差分の正典)

問い合わせた人のメールアドレスは本文に生で入れない (マスクした形だけ)。送信待ちの行は 7 日 (sent) / 30 日 (dead) 残る。この行の宛先は運営のアドレスで `userId` も渡さないので、退会の `prepare_account_deletion` の 1b (user_id・宛先) には当たらない。1c (§5.3。件名・本文・返信先にあるアカウントのアドレスを伏せる) は本文の中のアドレスも伏せるが、照合に使えるのはアカウントのアドレス (ログイン用と外部ログインの identity) だけで、ログインした人が別の連絡先アドレスで問い合わせた分は、`inquiries.email` は同じ関数が user_id で伏せても、送信待ちの行の本文では引けない。そのため、送信待ちの行と運営の受信箱に写しを作らない。アドレスの全体と本文は、サポートの画面 (`/support/inquiries`。`inquiries` を読む) で見る。

```ts
// tsc:skip — 既存の route の関数の置き換え (新設モジュールを import する)。import は下の 4 行を足し、
// 既存の `import { getEmailFrom } from '@/lib/site-config';` は `import { getSiteUrl } from '@/lib/site-config';` に替える
// (送信元は文面の側が getEmailFrom で決めるので、route では使わなくなる)。ほかの既存の import は変えない
import { sendEmail } from '@/lib/emails/send';
import { isEmailFailure } from '@/lib/emails/send-result';
import { maskEmailAddress } from '@/lib/emails/outbox';
import { renderContactAdminNotificationEmail } from '@/lib/emails/support/contact-admin-notification';

/** サポートの画面のお問い合わせの一覧 (src/app/(support)/support/inquiries/page.tsx) のパス */
const SUPPORT_INQUIRIES_PATH = '/support/inquiries';

async function sendAdminNotification(inquiry: {
  id: string;
  inquiry_type: string;
  email: string;
  subject: string;
  message: string;
}): Promise<void> {
  const logger = createLogger('contact');
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    // 問い合わせは保存済み。通知の宛先が無いことだけを残す (変数名はログにだけ書く)
    logger.warn('ADMIN_NOTIFICATION_EMAIL が未設定のため、お問い合わせの通知メールを送りません', { inquiry_id: inquiry.id });
    return;
  }
  // sendEmail は例外を投げない (R-01)。鍵が無いとき (skipped) は sendEmail が warn を残す
  const result = await sendEmail(
    renderContactAdminNotificationEmail({
      to_email: adminEmail,
      inquiry_id: inquiry.id,
      inquiry_type: inquiry.inquiry_type,
      sender_masked: maskEmailAddress(inquiry.email),
      subject: inquiry.subject,
      message: inquiry.message,
      inquiries_url: `${getSiteUrl()}${SUPPORT_INQUIRIES_PATH}`,
    }),
  );
  if (isEmailFailure(result)) {
    logger.warn('お問い合わせの通知メールを送信待ちに登録できませんでした', { inquiry_id: inquiry.id, error_code: result.error.code });
  }
}
```

`userId` は渡さない (行に本人のアドレスが無いので伏せる対象が無く、ログインしていない問い合わせとの扱いを分けない)。`getSiteUrl` は `src/lib/site-config.ts` に既にある (§8 の dead の通知と同じ)。

#### `src/lib/emails/support/contact-admin-notification.ts` (新設・型検査の対象)

```ts
/**
 * お問い合わせが届いたことを運営 (ADMIN_NOTIFICATION_EMAIL) へ知らせるメール (#1193 で src/app/api/contact/route.ts から移した)。
 * 問い合わせた人のメールアドレスは、呼び出し側がマスクした形 (sender_masked) だけを載せる。
 * 退会の伏せ字 (prepare_account_deletion) はアカウントのアドレスでしか送信待ち (email_outbox) の行を引けず、
 * 別の連絡先アドレスで問い合わせた分を伏せられないため (docs/design/operator/10-logs-and-mail-retry.md §6.6)。
 */
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { getEmailFrom } from '@/lib/site-config';

export interface ContactAdminNotificationVars {
  /** 運営の宛先 (ADMIN_NOTIFICATION_EMAIL) */
  to_email: string;
  inquiry_id: string;
  inquiry_type: string;
  /** 問い合わせた人のメールアドレスをマスクしたもの (maskEmailAddress の結果) */
  sender_masked: string;
  subject: string;
  message: string;
  /** サポートの画面のお問い合わせの一覧の絶対 URL */
  inquiries_url: string;
}

/** EmailEnvelopeSchema の subject の上限 (src/lib/emails/envelope.ts) */
const SUBJECT_MAX_LENGTH = 100;
const SUBJECT_PREFIX = '[お問い合わせ] ';
const ELLIPSIS = '…';
const EMPTY_SUBJECT = '(件名なし)';

/** 改行・連続する空白を 1 つの空白にして、1 行にそろえる */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** UTF-16 の長さで max 以内に収める。サロゲートペアは途中で切らない */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - ELLIPSIS.length) break;
    out += ch;
  }
  return `${out}${ELLIPSIS}`;
}

export function renderContactAdminNotificationEmail(vars: ContactAdminNotificationVars): EmailEnvelope {
  const title = toSingleLine(vars.subject) || EMPTY_SUBJECT;
  return {
    template: 'contact_admin_notification',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `${SUBJECT_PREFIX}${truncate(title, SUBJECT_MAX_LENGTH - SUBJECT_PREFIX.length)}`,
    text: [
      '新しいお問い合わせが届きました。',
      '',
      `ID: ${vars.inquiry_id}`,
      `種別: ${vars.inquiry_type}`,
      `送信者: ${vars.sender_masked} (アドレスの全体はサポートの画面で確認してください)`,
      `件名: ${title}`,
      '',
      '--- 内容 ---',
      vars.message,
      '',
      'サポートの画面 (お問い合わせの一覧):',
      vars.inquiries_url,
    ].join('\n'),
  };
}
```

件名は現行の `[お問い合わせ] ${subject}` と同じ形で、100 文字を超える分だけ切る (問い合わせの件名は 100 文字まで入るので、接頭辞を足すと `EmailEnvelopeSchema` の上限を超え、`invalid_envelope` で送られなくなるため)。`template` の行は `src/__tests__/lib/emails/template-names.test.ts` の正規表現 (`^\s+template: '…',$`) に当たる形で 1 行に書く。


### 6.7 秘密を含む文面の伏せ字 (#1708)

件名・本文に秘密 (受け取った人だけが使えるもの = 招待・本人確認・本人同意のトークンを含むリンク) を入れる文面は、封筒 (`src/lib/emails/envelope.ts` の `EmailEnvelopeSchema`) の `contains_secret: z.literal(true).optional()` を `true` にして返す。`sendEmail` は `redact_after_send = options.redactAfterSend === true || v.contains_secret === true` で登録する (§6.3)。伏せる処理は退会の完了メールと同じ RPC (§5.2 (2)(3)) で、migration は足さない。

| template | 文面のファイル | 秘密 (項目) |
|---|---|---|
| `dsr_verification` | `src/lib/emails/dsr/verification.ts` | `verify_url` (`?id=&token=<生のトークン>`。DB には sha256 だけを置く: cross/15 §3.1) |
| `family_invite` / `family_invite_new` / `family_invite_existing` | `src/lib/emails/membership/family-invite*.ts` | `invite_url` (`/invite/<招待のトークン>`) |
| `org_invite_new` / `org_invite_existing` | `src/lib/emails/membership/org-invite-*.ts` | `invite_url` (`/invite/<招待のトークン>`) |
| `family_promote` | `src/lib/emails/membership/family-promote.ts` | `accept_url` (`/family/promotions/<本人同意のトークン>`) |

- 秘密に数えないもの: 譲渡の提案 (`org_transfer_proposed` / `family_transfer_proposed`) の `accept_url` は提案の id で、承諾できるのはログインした譲渡先の本人だけ。保護者の同意の控え (`family_parental_consent_recorded`。#1713) の `document_url` は同意書の全文の公開の頁 (`/legal/parental-consent`)、`members_url` はメンバー管理画面で、どちらも固定のリンク。ほかの文面のリンクは、ログインした本人・運営だけが開ける画面への固定のリンク。サインアップの確認・パスワードの再設定のメールは Supabase Auth が送り、`sendEmail` を通らない。
- 宣言は文面の側に置く (呼び出し元が `redactAfterSend` を渡す形は、呼び出し元ごとの付け忘れを防げないため)。宣言の漏れは `src/__tests__/lib/emails/secret-templates.test.ts` が見張る (文面ごとの秘密あり / 秘密なしの分類表と、文面のコードが使う `_url` / `_link` / `_token` / `_code` の項目の突き合わせ。新しい文面・新しいリンクの項目は分類しないと赤)。
- 送るまで (queued の間) は本文にトークンが残る (worker が送るのに要る)。最長は再試行を使い切るまで (§6.1 の待ちの合計で約 5 時間 21 分) か、worker が止まっていれば 7 日 (`expired` で dead)。
- 伏せたあとは、運営の画面 (§9.2) では `redacted: true` の行として出て、再送はできない (`requeue_email_outbox` が 'redacted'。画面は「宛先を伏せた行は再送できません」)。招待・本人確認を送り直すのは、招待した人の再招待・本人の「確認メールを再送」(新しいトークン) で行う。`template` は伏せないので、どの文面の行かは画面で分かる。
- 登録の時点で宛先が停止リストに載っていれば、行を作らない (§6.3。dead の行にトークン入りの本文を残さないため)。送らなかったことは `app_logs` の warn (文面の名前・マスクした宛先) に残る。
- この変更より前に送られた行 (sent・dead) は、さかのぼって伏せない (データの書き換えになるため)。sent は 7 日、dead は 30 日で `cleanup_email_outbox` が消す。
- テスト: `src/__tests__/lib/emails/secret-templates.test.ts` (宣言の走査)・`src/__tests__/lib/emails/send.test.ts` (秘密を含む文面のすべてで `redact_after_send` が立つ・停止リストでは行を作らない)・`tests/integration/rls/email-outbox-secret-templates.test.ts` (実 DB: 秘密を含む文面のすべてで、sent と dead のあとに宛先・件名・本文が伏せられ、どの列にもトークンが残らない・再送は 'redacted')。文面の見本は `tests/helpers/secret-email-samples.ts`。

## 7. 表 3 点

### 7.1 全パターン表 (入力の組み合わせ → 結果)

登録 (`sendEmail`):

| 封筒 | 鍵 | 停止リスト | INSERT | 行 | 戻り値 |
|---|---|---|---|---|---|
| 不正 | – | 引かない | しない | 無し | `ok:false / skipped:false / invalid_envelope / attempts 0` (現行) |
| 正 | 無し | 引かない | しない | 無し | `ok:false / skipped:true / not_configured` (現行) |
| 正 (`redactAfterSend` 無し) | あり | suppressed | dead | `dead / suppressed / attempts 0` | `ok:false / skipped:false / suppressed` (現行) |
| 正 (`redactAfterSend: true`) | あり | suppressed | しない | 無し (退会した本人の生のアドレスを残さない。R-10) | `ok:false / skipped:false / suppressed` (現行) |
| 正 (`redactAfterSend` 無し) | あり | clear または lookup_failed | 成功 | `queued / attempts 0 / next_attempt_at now / redact_after_send false` | `ok:true / id = 行の id / attempts 0` |
| 正 (`redactAfterSend: true`。退会の完了メール) | あり | clear または lookup_failed | 成功 | `queued / attempts 0 / next_attempt_at now / redact_after_send true` (worker の表で sent / dead になるときに伏せる。R-10) | `ok:true / id = 行の id / attempts 0` |
| 正 (`redactAfterSend` は問わない) | あり | clear または lookup_failed | 失敗 (`{ error }`・行が返らない・例外) | 無し | `ok:false / skipped:false / outbox_failed / retryable true` (新) |

worker (1 行ごと。`attempts` は失敗前の値、`max` = maxAttempts。「dead」の行はどれも、`redact_after_send = true` なら `fail_email_outbox` が同じ更新で宛先・件名・本文を伏せる (R-10)。伏せた行の再送は 'redacted'。「数える (通知)」の「する」は、印 `dead_alerted_at` の無い dead として、次に権利を取れた回の運用メールの件数に 1 回入ること (§8)。template が `ops_` で始まる行 (運用メール自身) は、どの理由で dead になっても数えない (7 行目)):

| template | created_at | 停止リスト | Resend | retryable | attempts+1 < max | 行の次の状態 | 数える (通知) |
|---|---|---|---|---|---|---|---|
| `ops_` で始まらない | 7 日超 | 引かない | 呼ばない | false | – | dead `expired` (`redact_after_send` なら伏せる) | する |
| 問わない | 7 日以内 | suppressed | 呼ばない | false | – | dead `suppressed` (`redact_after_send` なら伏せる) | しない |
| 問わない | 7 日以内 | clear / lookup_failed | 200 | – | – | sent (`redact_after_send` なら伏せる) | – |
| 問わない | 7 日以内 | clear / lookup_failed | 429 (quota 以外) / 5xx / 409 `concurrent_idempotent_requests` (同じキーの要求が処理中) / 通信エラー (`statusCode` 無しの `rate_limit_exceeded` `internal_server_error` `application_error` `concurrent_idempotent_requests`) / 例外 | true | はい | queued・`next_attempt_at = now + delays[attempts]` (伏せない) | – |
| `ops_` で始まらない | 7 日以内 | clear / lookup_failed | 同上 | true | いいえ | dead (Resend のコード。`redact_after_send` なら伏せる) | する |
| `ops_` で始まらない | 7 日以内 | clear / lookup_failed | 4xx (400 / 401 / 403 / 404 / 422・409 `invalid_idempotent_request` など)・quota の 429・`statusCode` 無しのそれ以外の名前・応答に ID 無し | false | – | dead (Resend のコード / `invalid_response`。`redact_after_send` なら伏せる) | する |
| `ops_` で始まる (運用メール自身。`ops_email_dead_letter` など。`OPS_EMAIL_TEMPLATE_PREFIX`) | 7 日超 / 7 日以内 | 上の 1・5・6 行目と同じ | 同じ | 同じ | 同じ | 上の 1・5・6 行目と同じ dead (`expired` / Resend のコード / `invalid_response`) | しない (運用メール自身の dead は理由を問わず数えず、印も付けない。§5.2 (5)(7)・§8.3 の自己参照の切り方。画面には出る) |
| 問わない | – | – | – | – | – | 退会 (`prepare_account_deletion`) の queued → dead `recipient_deleted` | しない |
| 問わない | 7 日以内 (リース中に退会) | clear / lookup_failed | 200 | – | – | dead `recipient_deleted`・伏せ字のまま (`complete_email_outbox` は false。sent に数えず warn) | しない |
| 問わない | 7 日以内 (リース中に退会) | clear / lookup_failed | 失敗 (種類を問わない) | – | – | dead `recipient_deleted`・伏せ字のまま (`fail_email_outbox` は 'ignored'。warn) | しない |
| 問わない | 7 日以内 (他人宛。退会の 1c で本文などの退会者のアドレスを伏せた行。リース中に伏せた行を含む) | clear / lookup_failed | 200 / 失敗 | 7 日以内の 200・失敗の行 (この表の 3〜6 行目) と同じ | 同じ | 同じ (伏せたあとの試行は伏せた本文で送る。伏せたときに送っている途中だった要求は伏せる前の本文のまま届く。どちらも sent になった行の本文は伏せたまま)。以前の試行を Resend がその鍵で受け付けていたときだけ、409 `invalid_idempotent_request` (非 retryable) で dead | 同じ (dead なら、上の行と同じく template が `ops_` で始まらない行だけ数える) |

退会 (`prepare_account_deletion` の `email_outbox` の段。§5.3。`v_emails` = 退会する人のアドレス):

| 行 | 状態 | 段 | 行の次の状態 | 変える列 | 変えない列 | 戻り値の `email_outbox` |
|---|---|---|---|---|---|---|
| 本人の行 (`user_id` が本人、または `lower(to_email)` が `v_emails` のどれか) | queued (リース無し・リース中とも) | 1b | dead `recipient_deleted` | `to_email` を伏せ字・`subject` と `text_body` を `[redacted]`・`html_body` NULL・`dead_at`・`last_error_code`・リース解除・`updated_at` | 左に無い列すべて (`attempts`・`idempotency_key`・`reply_to` など) | 1 行に 1 |
| 本人の行 | sent / dead | 1b | 同じ状態 | 宛先・件名・本文 (上と同じ)・リース解除・`updated_at` | 左に無い列すべて (状態・`dead_at`・`last_error_code` など) | 1 行に 1 |
| 他人宛 (`to_email` が伏せ字でない) で、`subject` / `text_body` / `html_body` / `reply_to` のどれかに `v_emails` のアドレス (大文字小文字を問わない) | queued (リース無し・リース中とも) | 1c | queued (リースはそのまま) | 4 列の中の該当部分だけを `redacted@redacted.invalid` に・`updated_at` | 左に無い列すべて (`status`・`attempts`・`next_attempt_at`・`worker_id`・`lease_expires_at`・`idempotency_key`・`to_email` を含む) | 1 行に 1 |
| 同上 | sent / dead | 1c | 同じ状態 | 同上 | 同上 (dead の行は再送できる) | 1 行に 1 |
| 他人宛で、どの列にも `v_emails` のアドレスが無い (マスクした形 `u***@…` だけを含む行を含む) | 問わない | – | 変えない | – | すべて (`updated_at` も) | 0 |
| 伏せ字の行 (`to_email` が伏せ字。前の退会・`redact_after_send` で伏せた行) | 問わない | – | 変えない | – | すべて | 0 |
| (`v_emails` が空: アドレスの無いアカウント) | 問わない | 1b は `user_id` の一致だけ・1c は飛ばす | 1b のとおり | 1b のとおり | – | 1b の行数 |

サポートの返信 (`sendTicketReplyEmail`。§6.6・R-24) の結果の対応:

| 状況 | `sendEmail` の結果 | `ReplyEmailOutcome` | チケットの画面の案内 (`describeReplyEmailOutcome`) |
|---|---|---|---|
| `ticket.user_id` が無い / 宛先の取得の失敗 / アドレスが無い | 呼ばない | `failed / no_recipient` | 「メール未送信: お客様のメールアドレスを取得できなかった…」(現行) |
| 鍵が無い | `skipped / not_configured` | `skipped / not_configured` | 「メール未送信: メール送信の設定が未完了…」(現行) |
| 封筒が不正 / 宛先停止リスト / 送信待ちへの登録の失敗 | `ok:false` (`invalid_envelope` / `suppressed` / `outbox_failed`) | `failed / send_failed` | 「メール未送信: メールの送信に失敗しました…」(文面は現行のまま) |
| 送信待ちに登録できた | `ok:true` | `sent` | 出さない。そのあとの送信の失敗は worker の再試行・dead の通知 (§8)・送信待ちの画面の再送 (§9.2) |
| 文面の組み立てなどの例外 | – | `failed / send_failed` | 現行 |

お問い合わせの管理者通知 (`sendAdminNotification`。§6.6・R-23):

| `ADMIN_NOTIFICATION_EMAIL` | `sendEmail` の結果 | route のログ | 応答 |
|---|---|---|---|
| 未設定 | 呼ばない | warn (`inquiry_id`) | 200 (問い合わせは保存済み) |
| あり | `ok:true` (送信待ち) | なし | 200 |
| あり | `skipped` (鍵が無い) | なし (`sendEmail` が warn) | 200 |
| あり | `ok:false` (`suppressed` / `invalid_envelope` / `outbox_failed`) | warn (`inquiry_id`・`error_code`) | 200 |

### 7.2 状態比較表 (現行 vs 設計後)

| 面 | 現行 | 設計後 |
|---|---|---|
| 送信の経路 | 呼び出し元の要求の中で同期に Resend (最大 4 回・約 3.5 秒) | 要求の中は DB に 1 行。送るのは worker (≤ 1 分後) |
| 一時的な失敗 | 3.5 秒で諦めて app_logs に error | 最大 6 回・約 5.4 時間。失敗の記録は行に残る |
| 直らない失敗 | app_logs に error。再送の手段なし | dead として画面に出る。super_admin が再送 (監査ログ) |
| 再送 (requeue) | 無し (送る行の記録も、再送の API・画面も無い) | super_admin が `/super-admin/email-outbox` で dead (宛先が伏せ字でない) の行を `requeue_email_outbox` で queued に戻す (`attempts 0`・`requeue_count + 1`・`requeued_at`・`dead_at NULL`)。成功のたびに `admin_audit_logs` に `super_admin.email_outbox.requeue` を 1 行。dead 以外は `not_dead`・伏せ字の行は `redacted` で 409 (記録しない)。送るのは次の worker (R-05・§7.3・§9.2・§10) |
| 送信前の停止 (停止リスト) | 送らず suppressed | 同じ + dead の行が画面に残る (通知はしない) |
| 鍵が無い環境 | skipped (行なし) | 同じ |
| 送信の記録 | `email_delivery_logs` にチケットの返信だけ (成功時のみ) | `email_outbox` に全部 (queued / sent / dead)。`email_delivery_logs` は書かない |
| サポートの返信メールの「メール未送信」の案内 (#1183) | Resend の失敗 (再試行を含め最大 4 回) で即座に `failed / send_failed` → 案内が出る。そのメールはそれきり送られない | 案内は返信を保存した時点で分かる失敗 (宛先なし・設定なし・登録の失敗・停止リスト・文面の不備) だけ。Resend の失敗は案内に出ず、worker の再試行 → dead → 運用メール (template `support_ticket_reply` の件数) → super_admin が原因を直して再送すれば顧客に届く (R-24・§7.1 の対応表) |
| お問い合わせの管理者通知 | Resend の API を直接 `fetch`。失敗は `console.error` だけ (`app_logs` に残らない)・再試行なし。本文に問い合わせた人の生のアドレス | `sendEmail` で送信待ちへ (記録・再試行・dead の通知・再送)。本文の送信者はマスクし、全体はサポートの画面 (`/support/inquiries`) で見る。未設定・登録の失敗は `app_logs` に warn (R-23) |
| Resend を直接使う場所 | `src/lib/emails/send.ts`・`src/app/api/contact/route.ts` | `src/lib/emails/outbox.ts` だけ (`tests/email-resend-boundary-scan.test.ts` が見張る) |
| 二重送信 | 同じ呼び出しの再試行だけ同じ Idempotency-Key | 行に保存した Idempotency-Key を再試行・再送でも使う + リース + SKIP LOCKED |
| 退会時の宛先 | `email_delivery_logs` を伏せる | `email_outbox` も伏せる: 本人の行は宛先・件名・本文 (queued は dead)、他人宛の行は件名・本文・返信先の中の本人のアドレスの部分だけ (状態は変えない。§5.3 の 1b・1c)。完了メールは送れたとき・届けられずに dead になったときに伏せ、登録時に停止リストに当たれば行を作らない (生のアドレスが残る状態を作らない) |
| 届かないことへの気づき | 急増通知 (20 件 / 15 分) に紛れる | dead 1 件から運用メール (15 分以内・60 分の抑止)。抑止の間と cron の発火の遅れの間に dead になった行も、抑止が明けた最初の回で知らせる (まだ知らせていない dead を数え、知らせた行に印 `dead_alerted_at`。どの行も 1 回だけ件数に入る)。運用メール自身の失敗は数えない |
| 運用メールの宛先が停止リスト (#1577-8) | 15 分ごとに送り直し続ける | 権利を返さない (60 分の抑止)。dead が画面に残る |
| ログ閲覧 | 完全一致の絞り込みだけ。監査なし | 本文の部分一致 `q`。1 回の検索 = 監査 1 行 |
| Vercel Cron / pg_cron | 2 本 / 9 つ (origin/main `36c926ad` (2026-10-16 01:02 JST) で数えた実数。§15.2 の `08-cron-batches.md` の行) | 3 本 / 10 つ (マージ時に origin/main の数が変わっていれば、その数 + 1) |

### 7.3 状態遷移表 (`email_outbox.status` × 操作 → 遷移先・ガード・副作用)

| 状態 | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| (無し) | `sendEmail` 登録 | queued | 封筒が正・鍵あり・停止リストに無い (引けない場合を含む) | `attempts 0`、`next_attempt_at now`、Idempotency-Key 発行、`redact_after_send` = `redactAfterSend` (既定 false。true は退会の完了メール)、`user_id` = `userId`、info ログ |
| (無し) | `sendEmail` 登録 (停止リスト) | dead | suppressed・`redactAfterSend` 無し | `last_error_code suppressed`、`dead_at now`、warn |
| (無し) | `sendEmail` 登録 (停止リスト・`redactAfterSend: true`) | (無し。行を作らない) | suppressed | warn だけ。`suppressed` の失敗を返す (退会した本人の生のアドレスを残さない。R-10) |
| (無し) | `sendEmail` 登録 (INSERT の失敗) | (無し。行なし) | 封筒が正・鍵あり・停止リストに無い (引けない場合を含む)・INSERT が `{ error }` / 行が返らない / 例外 (`getSupabaseAdmin` の例外を含む) | error ログ (`error_code outbox_failed`・宛先はマスク・`error.details` は載せない)、`ok:false / skipped:false / outbox_failed / retryable true` を返す (例外は投げない。R-01)。呼び出し元の扱いは §7.1 の対応表と §8.3 |
| queued | `claim_email_outbox` | queued (リース中) | `next_attempt_at <= now` かつリース切れ、SKIP LOCKED | `lease_expires_at = now + 120 秒`、`worker_id` |
| queued (リース中) | `complete_email_outbox` | sent | `worker_id` 一致 | `attempts + 1`、`sent_at`、`resend_message_id`、`redact_after_send` なら伏せる、リース解除 |
| queued (リース中) | `fail_email_outbox` (retryable・回数内) | queued | `worker_id` 一致 | `attempts + 1`、`next_attempt_at = now + 待ち`、`last_error_*`、リース解除、warn。`redact_after_send` でも伏せない (次の試行で送るため) |
| queued (リース中) | `fail_email_outbox` (非 retryable または回数切れ) | dead | `worker_id` 一致 | `attempts + 1`、`dead_at`、`last_error_*`、リース解除、`redact_after_send` なら伏せる (`to_email` を伏せ字・件名と本文を `[redacted]`・`html_body` NULL)、error ログ、印 (`dead_alerted_at`) は NULL のまま = 次の通知の対象 (suppressed / recipient_deleted / ops_ を除く) |
| queued (リース中) | worker の期限判定 (`created_at` が 7 日超) → `fail_email_outbox` (`expired`・非 retryable) | dead | `worker_id` 一致 | Resend を呼ばない、`attempts + 1`、`dead_at`、`last_error_code expired`、リース解除、`redact_after_send` なら伏せる、error ログ、印は NULL のまま = 次の通知の対象 |
| queued (リース中) | worker の停止リスト判定 (suppressed) → `fail_email_outbox` (`suppressed`・非 retryable) | dead | `worker_id` 一致 | Resend を呼ばない、`attempts + 1`、`dead_at`、`last_error_code suppressed`、リース解除、`redact_after_send` なら伏せる、error ログ、`dead_counts` の対象外 |
| queued (リース中) | リース切れ (worker の停止) | queued | 時間の経過だけ | 次の `claim` が取り直す。同じ Idempotency-Key |
| queued (リース無し・リース中とも) | `prepare_account_deletion` (1b) | dead | 本人の行 (`user_id` が本人、または宛先が本人のアドレス) | 伏せる、`last_error_code recipient_deleted`、`dead_at`、リース解除 (`worker_id` / `lease_expires_at` を NULL) |
| queued (リース無し・リース中とも) | `prepare_account_deletion` (1c) | queued (リースはそのまま) | 他人宛 (`to_email` が伏せ字でない) で、件名・本文・HTML・返信先のどれかに本人のアドレス (大文字小文字を問わない) | その部分だけを `redacted@redacted.invalid` に、`updated_at`。`status`・`attempts`・`next_attempt_at`・`worker_id`・`lease_expires_at`・`idempotency_key`・`to_email` は変えない。リース中なら元の worker の complete / fail はそのまま効き、送っている途中の要求は伏せる前の本文のまま届く (行の本文は伏せたまま。§5.3) |
| sent / dead | `prepare_account_deletion` (1c) | 同じ状態 | 同上 | その部分だけを伏せ字に、`updated_at`。dead の行は `to_email` が伏せ字でないので再送できる (伏せた本文で送る) |
| queued / sent / dead | `prepare_account_deletion` | 同じ状態 (変えない) | 他人宛で本人のアドレスをどの列にも含まない、または `to_email` が伏せ字 | – (`updated_at` も変えない) |
| dead (`recipient_deleted`。リース中に退会した行) | 退会前に取っていた worker の `complete_email_outbox` / `fail_email_outbox` | dead | `worker_id` 不一致・`status <> 'queued'` で 0 行 | complete は false・fail は 'ignored'。worker は sent / dead に数えず warn。Resend が受け付けていても行は dead・伏せ字のまま。`dead_counts` の対象外 |
| sent / dead | `prepare_account_deletion` (1b) | 同じ状態 | 本人の行 | 伏せる (`to_email`・件名・本文) |
| dead (印の有無を問わない) | `requeue_email_outbox` | queued | `to_email` が伏せ字でない | `attempts 0`、`requeue_count + 1`、`requeued_at`、`dead_at NULL`、`dead_alerted_at NULL` (もう一度 dead になれば、また知らせる)、監査ログ |
| dead (伏せ字。退会で伏せた行・届けられなかった退会の完了メール) | `requeue_email_outbox` | dead | – | 'redacted' を返す (409) |
| queued / sent | `requeue_email_outbox` | 同じ状態 | – | 'not_dead' を返す (409) |
| dead (印なし: `dead_alerted_at` NULL・数える対象) | app-log-alerts の回で `email_outbox_dead_counts` (数えるだけ) | dead (印なし のまま) | – | 件数を返すだけ。権利が取れない回 (抑止の間) は何も書かず deduped。次の回でもう一度数える (窓で区切らないので、抑止の間・cron の遅れの間の行も残る。R-13) |
| dead (印なし・数える対象) | `mark_email_outbox_dead_alerted(T)` (app-log-alerts が権利を取った時刻 T で) | dead (印 T) | `dead_alerted_at IS NULL`・suppressed / recipient_deleted でない・template が `ops_` で始まらない | `dead_alerted_at = T`、`updated_at`。印を付けた行の template ごとの件数を返し、その件数で運用メールを作る |
| dead (印なし・数える対象外: suppressed / recipient_deleted / `ops_`) | `email_outbox_dead_counts` / `mark_email_outbox_dead_alerted` | 同じ (印なし のまま) | WHERE に当たらない | – (どの通知にも入らない。画面には出る) |
| dead (印 T) | `email_outbox_dead_counts` / `mark_email_outbox_dead_alerted` (後の回) | 同じ (印 T のまま) | `dead_alerted_at IS NULL` に当たらない | – (同じ行を 2 回知らせない) |
| dead (印 T) | `unmark_email_outbox_dead_alerted(T)` (運用メールを送れず権利を返すとき。§8.3) | dead (印なし) | `dead_alerted_at = T` (別の時刻の印は外さない) | `dead_alerted_at NULL`、`updated_at`。次の回で数え直して知らせる |
| sent | `cleanup_email_outbox` | (削除) | `sent_at < now − 7 日` | – |
| dead | `cleanup_email_outbox` | (削除) | `dead_at < now − 30 日` | – |
| queued | `cleanup_email_outbox` | queued | 触らない | – |

表に無い遷移 (sent → queued、dead → sent、queued → sent を worker 以外が行う) はどのコードにも作らない。`dead_alerted_at` を書くのは `mark_email_outbox_dead_alerted` (付ける)・`unmark_email_outbox_dead_alerted` (外す)・`requeue_email_outbox` (NULL に戻す) の 3 本だけで、dead 以外の行には付かない (CHECK `email_outbox_dead_alerted_only_dead`)。

## 8. アラート: 既存の急増通知に 3 つ目の種類を足す

### 8.1 決めたこと

| 項目 | 内容 |
|---|---|
| 種類 | `AppLogAlertScope` を `'server' \| 'client' \| 'email_dead_letter'` にする。エラー急増の 2 種類だけを指す型 `AppLogErrorSpikeScope = 'server' \| 'client'` を新設し、急増の文面 (`src/lib/emails/ops/app-log-error-spike.ts`) はこちらを使う (§8.2)。判定の順は server → client → email_dead_letter (後ろの失敗は前の通知を止めない)。server / client は現行の `checkScope`、email_dead_letter は新設の `checkEmailDeadLetters` (§8.2。数える RPC と、印を付ける・外す段があるので別の関数にする) |
| 数え方 | RPC `email_outbox_dead_counts(上位 10)` (§5.2 (5))。**窓は無く**、まだ知らせていない (`dead_alerted_at` が NULL の) dead を数える。suppressed・recipient_deleted・`ops_` の template は数えない |
| 知らせた印 | 権利 (`claim_ops_alert`) を取れた回だけ、`mark_email_outbox_dead_alerted(取った時刻, 上位 10)` (§5.2 (7)) で、まだ印の無い dead のすべてに `dead_alerted_at = 取った時刻` を付け、**印を付けた行の件数で**文面を作る (数えてから印を付けるまでに dead になった行も、その通知に入る)。権利が取れない回 (抑止の間) は印を付けないので、その間に dead になった行は抑止が明けた最初の回で数えて知らせる。運用メールを送れずに権利を返すときは、`unmark_email_outbox_dead_alerted(取った時刻)` (§5.2 (8)) で印も外し、次の回に持ち越す (§8.3)。再送 (`requeue_email_outbox`) は印を NULL に戻す |
| 窓で数えない理由 | 15 分の窓で数えると、(1) 抑止 (60 分) の間に dead になった行は、権利が取れない回 (deduped) にしか数えられず、抑止が明けた回では窓の外になる。(2) Vercel Cron の発火が遅れて回の間が 15 分より空くと、その隙間に dead になった行はどの窓にも入らない。どちらも「1 件から知らせる」の取りこぼしになる。窓を「抑止 + 15 分」に広げる案は、前の通知の行を数え直し、発火の遅れの隙間も残るので採らない。`ops_alert_state.last_sent_at` より後の dead を数える案は、権利を返すと (`release_ops_alert` が行を消す) 前の通知の時刻が失われ、数えてから権利を取るまでの間の行も漏れるので採らない |
| しきい値 | `EMAIL_DEAD_LETTER_ALERT_THRESHOLD = 0` (= 1 件から。`exceedsErrorThreshold(total, 0)`)。環境変数で変えない (届かなかったメールは件数に関わらず知るべきもの) |
| キー / クールダウン | `ops_alert_state.alert_key = 'email_dead_letter'`。クールダウンは `OPS_ALERT_COOLDOWN_MINUTES` (既定 60 分。3 種類で同じ値・抑止は別々) (`cron_secret_rotation` だけは `OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES`) (#1125 の B の 4 つ目 `cron_failure`・5 つ目 `pg_cron_stalled`、#1560 の 6 つ目 `cron_secret_drift`・7 つ目 `cron_secret_rotation` を含めて 7 種類。operator/11 §4〜§6・operator/12 §7〜§8) |
| 宛先 | `OPS_ALERT_EMAIL` (未設定なら 3 種類とも何もしない。現行どおり) (#1125 の B の 4 つ目 `cron_failure`・5 つ目 `pg_cron_stalled`、#1560 の 6 つ目 `cron_secret_drift`・7 つ目 `cron_secret_rotation` を含めて 7 種類。operator/11 §4〜§6・operator/12 §7〜§8) |
| 文面 | 新設 `src/lib/emails/ops/email-dead-letter.ts` の `renderEmailDeadLetterEmail` (template `'ops_email_dead_letter'`。正典は §8.2)。件名「【ほめゴハン運用】届けられなかったメールがあります (N 件)」。本文: 前回の通知のあとに届けられなかった (まだ知らせていない) 件数・template ごとの件数 (多い順・最大 10・残りは合計)・`/super-admin/email-outbox` への絶対 URL・確認した時刻 (JST)・「再送は画面から。宛先停止・退会で送らなかったものは数えていない」・抑止の分数。宛先・件名・本文・ユーザー ID は載せない |
| 応答 | `{ …server, window_minutes, client: {…}, email_dead_letter: { status, total, threshold } }` |

### 8.2 コードの変更 (`src/lib/ops-alerts/app-log-error-spike.ts` と route)

```ts
// tsc:skip — 既存ファイルへの追記 (名前と値が正典)
/** エラー急増の通知の種類 (app_logs を数える 2 つ)。急増の文面 renderAppLogErrorSpikeEmail が扱うのはこの 2 つだけ */
export type AppLogErrorSpikeScope = 'server' | 'client';
/** 運用アラートの種類。email_dead_letter は email_outbox の dead を数える (文面は renderEmailDeadLetterEmail) */
export type AppLogAlertScope = AppLogErrorSpikeScope | 'email_dead_letter';
export const EMAIL_DEAD_LETTER_ALERT_KEY = 'email_dead_letter';
/** 届けられなかったメールは 1 件から知らせる (この件数を「超えたら」= 0)。環境変数では変えない */
export const EMAIL_DEAD_LETTER_ALERT_THRESHOLD = 0;
/**
 * 通知の種類ごとの、数える DB の関数の名前。as const で値をリテラルの型のまま持つ
 * (route の checkScope では APP_LOG_ALERT_COUNT_RPC[scope] (scope は AppLogErrorSpikeScope) が急増の 2 つの関数名だけになり、
 * checkEmailDeadLetters では .email_dead_letter が 'email_outbox_dead_counts' 1 つになる。supabase.rpc の引数の型が 1 つに決まる)
 */
export const APP_LOG_ALERT_COUNT_RPC = {
  server: 'app_log_error_counts', client: 'app_log_client_error_counts', email_dead_letter: 'email_outbox_dead_counts',
} as const satisfies Readonly<Record<AppLogAlertScope, string>>;
export const APP_LOG_ALERT_KEYS: Readonly<Record<AppLogAlertScope, string>> = {
  server: APP_LOG_ALERT_KEY, client: APP_LOG_CLIENT_ALERT_KEY, email_dead_letter: EMAIL_DEAD_LETTER_ALERT_KEY,
};
/** email_outbox_dead_counts / mark_email_outbox_dead_alerted の行 (template / dead_count / total_count) を ErrorCountRow の形にそろえてから parseErrorCountRows に渡す */
export function normalizeDeadCountRows(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((row) => (row && typeof row === 'object'
    ? { function_name: (row as Record<string, unknown>).template ?? null, error_count: (row as Record<string, unknown>).dead_count, total_count: (row as Record<string, unknown>).total_count }
    : row));
}
```

急増の文面 `src/lib/emails/ops/app-log-error-spike.ts` (既存) の変更は型の 2 か所だけ (文面・値は変えない): import を `import { sanitizeFunctionNameForAlert, type AppLogErrorSpikeScope } from '@/lib/ops-alerts/app-log-error-spike';` に、`AppLogErrorSpikeEmailVars.scope` を `scope: AppLogErrorSpikeScope;` に、`SCOPE_WORDING` の型を `Readonly<Record<AppLogErrorSpikeScope, { readonly subject: string; readonly counted: string; readonly note: string }>>` にする (`server` / `client` の 2 キーのまま。`email_dead_letter` の文言を足さない: その種類の文面は別の関数)。`AppLogAlertScope` のまま 3 値に広げると `SCOPE_WORDING` が `Property 'email_dead_letter' is missing` で型エラーになるため。

route (`src/app/api/cron/app-log-alerts/route.ts`) の変更:

- 既存の `checkScope` は server / client 専用のまま残し、引数 `scope` の型だけを `AppLogErrorSpikeScope` にする (`renderAppLogErrorSpikeEmail({ scope, … })` がそのまま型に合う。キャストしない)。中身は §8.3 の 2 か所 (権利を返す条件・ログのキー `outbox_id`) だけを変える。
- 届けられなかったメールは、新設の関数 `checkEmailDeadLetters` (下の正典) で判定する。`checkScope` に混ぜないのは、数える RPC の引数 (窓を渡さない)、権利を取ったあとの「印を付ける」段、送れなかったときの「印を外す」段が違うため。
- `checkAppLogErrors` は server → client のあとに `checkEmailDeadLetters` を呼び (`'response' in` なら、その 500 を返す)、応答に `email_dead_letter: deadLetter.result` を足す (下の正典)。
- ファイル冒頭のコメントに 3 つ目の種類 (まだ知らせていない dead を数え、知らせた行に印。権利を返すときは印も外す) と、応答の `email_dead_letter` を足す。`maxDuration` のコメント (「メールの再試行を含めても数秒で終わる」) は「送信待ちに登録するだけなので数秒で終わる」に直す。

```ts
// tsc:skip — route.ts の断片。同じファイルの既存の AdminClient / Logger / SpikeOutcome / SendEmailResult / ROUTE_NAME / releaseClaim と、
// §8.3 の NON_RELEASING_SEND_ERROR_CODES を使う。名前・順序・RPC の引数・応答とログのキーが正典。足す import は次のとおり:
//   '@/lib/ops-alerts/app-log-error-spike' の import に EMAIL_DEAD_LETTER_ALERT_THRESHOLD・normalizeDeadCountRows・
//     type AppLogErrorSpikeScope・type ErrorSummary を足す (既存の名前はそのまま)
//   import { renderEmailDeadLetterEmail } from '@/lib/emails/ops/email-dead-letter';
//   import { SUPER_ADMIN_EMAIL_OUTBOX_PATH } from '@/lib/emails/outbox';

/** ログの文の言い方。server は #1157 のときの文のまま */
const SCOPE_LOG_LABEL: Readonly<Record<AppLogAlertScope, string>> = {
  server: 'エラー急増',
  client: 'ブラウザ・端末のエラー急増',
  email_dead_letter: '届けられなかったメール',
};

/** 届けられなかったメールの通知に使う DB の関数 (§5.2 (5)(7)(8))。数える関数は種類ごとの表から取る (値の型は 'email_outbox_dead_counts') */
const DEAD_LETTER_COUNT_RPC = APP_LOG_ALERT_COUNT_RPC.email_dead_letter;
const DEAD_LETTER_MARK_RPC = 'mark_email_outbox_dead_alerted';
const DEAD_LETTER_UNMARK_RPC = 'unmark_email_outbox_dead_alerted';

/**
 * 運用メールを送れなかったときに、mark_email_outbox_dead_alerted で付けた印 (dead_alerted_at = 権利の時刻) を外し、次の回に持ち越す。
 * 失敗しても例外にしない (releaseClaim と同じ)。外せなかった行は通知の対象から外れたまま (送信待ちの画面には残る)。
 */
async function unmarkDeadLetters(supabase: AdminClient, alertedAt: string, logger: Logger): Promise<void> {
  const message = '届けられなかったメールの「知らせた」印を外せませんでした。該当の行は次の通知に入りません (送信待ちの画面には残ります)';
  try {
    const { error } = await supabase.rpc(DEAD_LETTER_UNMARK_RPC, { p_alerted_at: alertedAt });
    if (error) {
      logger.warn(message, { scope: 'email_dead_letter', pg_code: error.code });
    }
  } catch (err) {
    logger.warn(message, { scope: 'email_dead_letter', error_name: err instanceof Error ? err.name : typeof err });
  }
}

/** 権利を取ったあとの段 (印を付ける → 文面を作って送る) の結果 */
type DeadLetterNotice =
  | { readonly kind: 'notified'; readonly result: SendEmailResult; readonly summary: ErrorSummary }
  | { readonly kind: 'nothing_marked' }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * 届けられなかったメール (email_outbox の dead) について: まだ知らせていない行を数える → 1 件から → 権利を取る → 印を付ける → 印を付けた件数で送る。
 * 窓は持たない。抑止の間 (権利が取れない回) と cron の発火の遅れの間に dead になった行も、印が付くまで毎回数える (R-13)。
 * 送れずに権利を返すときは、印も外す (§8.3)。
 */
async function checkEmailDeadLetters(
  supabase: AdminClient,
  recipient: string,
  settings: AppLogAlertSettings,
  requestId: string,
  logger: Logger,
): Promise<SpikeOutcome> {
  const scope = 'email_dead_letter' as const;
  const threshold = EMAIL_DEAD_LETTER_ALERT_THRESHOLD;

  // 1. まだ知らせていない dead を template ごとに数える (template と件数だけ。宛先・件名・本文は読まない)
  const counted = await supabase.rpc(DEAD_LETTER_COUNT_RPC, { p_limit: APP_LOG_ALERT_MAX_FUNCTIONS });
  if (counted.error) {
    return { response: internalError(ROUTE_NAME, counted.error, { requestId, scope, rpc: DEAD_LETTER_COUNT_RPC }) };
  }
  const pending = summarizeErrorCounts(parseErrorCountRows(normalizeDeadCountRows(counted.data), DEAD_LETTER_COUNT_RPC));
  if (!exceedsErrorThreshold(pending.total, threshold)) {
    return { result: { status: 'below_threshold', total: pending.total, threshold } };
  }

  // 2. 送る権利を取る。抑止の間なら NULL で、送らない。印も付けないので、その行は抑止が明けた最初の回でもう一度数えられる
  const claimed = await supabase.rpc('claim_ops_alert', {
    p_alert_key: APP_LOG_ALERT_KEYS[scope],
    p_cooldown_minutes: settings.cooldownMinutes,
  });
  if (claimed.error) {
    return { response: internalError(ROUTE_NAME, claimed.error, { requestId, scope, rpc: 'claim_ops_alert' }) };
  }
  const claimedAt = typeof claimed.data === 'string' && claimed.data ? claimed.data : null;
  if (!claimedAt) {
    return { result: { status: 'deduped', total: pending.total, threshold } };
  }

  // 3. 印を付け (dead_alerted_at = 権利の時刻)、印を付けた行の件数で文面を作って送る (数えたあとに dead になった行も、印が付けばこの通知に入る)。
  //    権利を取ったあとの RPC の失敗・応答の形の誤り・例外はここで受け、印と権利を返してから扱う
  let notice: DeadLetterNotice;
  try {
    const marked = await supabase.rpc(DEAD_LETTER_MARK_RPC, { p_alerted_at: claimedAt, p_limit: APP_LOG_ALERT_MAX_FUNCTIONS });
    if (marked.error) {
      notice = { kind: 'failed', error: marked.error };
    } else {
      const summary = summarizeErrorCounts(parseErrorCountRows(normalizeDeadCountRows(marked.data), DEAD_LETTER_MARK_RPC));
      if (summary.total === 0) {
        notice = { kind: 'nothing_marked' };
      } else {
        const envelope = renderEmailDeadLetterEmail({
          to_email: recipient,
          total: summary.total,
          cooldown_minutes: settings.cooldownMinutes,
          templates: summary.functions,
          other_count: summary.otherCount,
          outbox_url: `${getSiteUrl()}${SUPER_ADMIN_EMAIL_OUTBOX_PATH}`,
          detected_at: new Date(),
        });
        notice = { kind: 'notified', result: await sendEmail(envelope), summary };
      }
    }
  } catch (thrown) {
    notice = { kind: 'failed', error: thrown };
  }

  if (notice.kind === 'failed') {
    // 印の RPC がエラーを返しても、DB では付いていることがある (応答だけが失われた) ので、外す操作は必ず呼ぶ (付いていなければ 0 行)
    await unmarkDeadLetters(supabase, claimedAt, logger);
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
    return { response: internalError(ROUTE_NAME, notice.error, { requestId, scope, stage: 'mark_or_send' }) };
  }
  if (notice.kind === 'nothing_marked') {
    // 数えてから印を付けるまでに、行が再送 (queued) や掃除で dead でなくなった。知らせるものが無いので権利を返す
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
    return { result: { status: 'below_threshold', total: 0, threshold } };
  }

  const { result, summary } = notice;
  const counts = { total: summary.total, threshold };
  // ログには件数と文面の名前 (template) だけを残す。メールが届かなくても、ここから何が起きていたか分かる
  const alertMeta = { scope, ...counts, other_count: summary.otherCount, templates: summary.functions };
  const label = SCOPE_LOG_LABEL[scope];
  if (result.ok) {
    logger.info(`${label}を運用メールに知らせました`, { ...alertMeta, outbox_id: result.id });
    return { result: { status: 'sent', ...counts } };
  }
  // 送れなかった、または送らなかった (§8.3)。宛先停止・文面の不備は送り直しても同じなので、印も権利も返さない (抑止が効き、行は画面に残る)。
  // それ以外 (送信の設定が未完了・送信待ちへの登録の失敗など) は印と権利を返し、15 分後の次の回で同じ行をもう一度知らせる
  if (!NON_RELEASING_SEND_ERROR_CODES.has(result.error.code)) {
    await unmarkDeadLetters(supabase, claimedAt, logger);
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
  }
  logger.warn(
    result.skipped
      ? `${label}を検知しましたが、メールの送信設定が未完了のため通知を送っていません`
      : `${label}を検知しましたが、通知メールを送れませんでした`,
    { ...alertMeta, error_code: result.error.code },
  );
  return { result: { status: result.skipped ? 'send_skipped' : 'send_failed', ...counts } };
}

// checkAppLogErrors の try の中 (client の判定のあと):
//     // 届けられなかったメール (#1193)。server / client とは独立に判定する (ここが失敗しても、前の 2 つの通知は済んでいる)
//     const deadLetter = await checkEmailDeadLetters(supabase, recipient.data, settings, requestId, logger);
//     if ('response' in deadLetter) return deadLetter.response;
//
//     return NextResponse.json({
//       ...server.result,
//       window_minutes: APP_LOG_ALERT_WINDOW_MINUTES,
//       client: client.result,
//       email_dead_letter: deadLetter.result,
//     });
```

`window_minutes` は急増の 2 種類の窓 (15 分) のまま返す (届けられなかったメールは窓を持たないので、`email_dead_letter` には窓を付けない)。

#### `src/lib/emails/ops/email-dead-letter.ts` (新設・型検査の対象)

```ts
/**
 * 届けられなかったメール (email_outbox の dead) を、運用のメールアドレス (OPS_ALERT_EMAIL) へ知らせる文面 (#1193)。
 * 判定と送信は GET /api/cron/app-log-alerts (src/app/api/cron/app-log-alerts/route.ts の checkEmailDeadLetters)。ここは文面を作るだけ。
 * 載せるのは件数・文面の名前 (template)・送信待ちの画面へのリンクだけ。宛先・件名・本文・ユーザー ID は載せない
 * (送信先の Resend は米国の事業者。急増の通知 src/lib/emails/ops/app-log-error-spike.ts と同じ考え方)。利用者向けではないので署名は付けない。
 */
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { getEmailFrom } from '@/lib/site-config';
import { sanitizeFunctionNameForAlert } from '@/lib/ops-alerts/app-log-error-spike';

export interface EmailDeadLetterEmailVars {
  /** 宛先 (環境変数 OPS_ALERT_EMAIL) */
  to_email: string;
  /** この通知で知らせる (印を付けた) dead の件数 */
  total: number;
  /** 同じ通知を送り直さない時間 (分) */
  cooldown_minutes: number;
  /** 文面の名前 (template) ごとの件数 (多い順。summarizeErrorCounts の functions) */
  templates: ReadonlyArray<{ name: string; count: number }>;
  /** templates に載せなかった件数 (0 なら行を出さない) */
  other_count: number;
  /** 送信待ちの画面 (/super-admin/email-outbox) の絶対 URL */
  outbox_url: string;
  /** 確認した時刻 (日本時間で表示する) */
  detected_at: Date;
}

const JST_MINUTE_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 一覧の番号の幅 (載せるのは最大 10 件なので 2 桁にそろえる) */
const LIST_NUMBER_WIDTH = 2;

/** 1,234 のように桁区切りにする (実行環境のロケールに左右されないよう ja-JP を指定) */
function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

/** subject: 「【ほめゴハン運用】届けられなかったメールがあります (3 件)」 */
export function renderEmailDeadLetterEmail(vars: EmailDeadLetterEmailVars): EmailEnvelope {
  const templateLines = vars.templates.map(
    (t, index) => `${String(index + 1).padStart(LIST_NUMBER_WIDTH, ' ')}. ${sanitizeFunctionNameForAlert(t.name)} … ${formatCount(t.count)} 件`,
  );
  if (vars.other_count > 0) {
    templateLines.push(`    ほかの文面: 合計 ${formatCount(vars.other_count)} 件`);
  }
  return {
    template: 'ops_email_dead_letter',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン運用】届けられなかったメールがあります (${formatCount(vars.total)} 件)`,
    text: [
      'ほめゴハンの運用アラートです。',
      '',
      `アプリが送ろうとしたメールのうち、届けられなかったもの (送信待ち email_outbox の dead) が ${formatCount(vars.total)} 件あります。`,
      '前回のこの通知のあとに届けられなかったもので、まだ知らせていないものだけを数えています (同じメールを 2 回は数えません)。',
      '宛先停止リスト・退会で送らなかったものと、運用メール自身は数えていません。',
      '',
      '▼ 文面の名前 (template) ごとの件数 (多い順)',
      ...templateLines,
      '',
      '▼ 確認と再送',
      '送信待ちの画面 (super_admin のみ)',
      vars.outbox_url,
      '状態を「届けられなかった」にすると、失敗の理由を確認できます。原因 (送信元ドメインの検証・API キーなど) を直してから、1 行ずつ「再送」してください。',
      '',
      `確認した時刻: ${JST_MINUTE_FORMAT.format(vars.detected_at)} (日本時間)`,
      '',
      `このメールは自動で送られています。同じ通知は ${vars.cooldown_minutes} 分以内には送り直しません (その間に届けられなかったメールは、次の通知で知らせます)。`,
      'このメールに、宛先・件名・本文・利用者の情報は含めていません。',
      '',
    ].join('\n'),
  };
}
```

### 8.3 権利を返す条件の変更 (#1577 の 8)

`sendEmail` の結果が `ok: false` のとき、`releaseClaim` を**呼ばない**のは **`result.error.code` が `'suppressed'` (宛先が停止リスト) か `'invalid_envelope'` (文面の不備) のときだけ**で、それ以外の `ok: false` (`skipped` の `not_configured`・登録の失敗 `outbox_failed`・そのほかのコード) は現行どおり権利を返す。返さないときも warn を残して `send_failed` を返す (送り直しても結果は同じで、15 分ごとの繰り返しになるため。60 分の抑止が効き、suppressed は dead の行が画面に残る)。「返さないコード」は `src/lib/ops-alerts/send-release.ts` の `export const NON_RELEASING_SEND_ERROR_CODES: ReadonlySet<string> = new Set(['suppressed', 'invalid_envelope']);` (根拠のコメント付き。backup-freshness の cron (cross/17 §7.3) と共有する) にまとめ、route はそれを import して `if (!NON_RELEASING_SEND_ERROR_CODES.has(result.error.code)) await releaseClaim(…)` と書く (除外を列挙するのは、既存のテストが使う Resend 由来のコード (`validation_error` など) の失敗で権利を返す現行の振る舞いを保つため)。`ok: true` は「送信待ちに登録した」の意味で、ログの `email_id` は `outbox_id` に改名する。この規則は `checkScope` (server / client) と `checkEmailDeadLetters` (§8.2) の両方に同じ形で入れる。

届けられなかったメール (`checkEmailDeadLetters`) では、権利を返すときに印も外す (`unmark_email_outbox_dead_alerted(取った時刻)` → `release_ops_alert` の順。§8.2 の正典)。外した行は次の回で数え直して知らせる (R-13 の持ち越し)。権利を返す場面は 3 つ: (1) 送れなかった (`NON_RELEASING_SEND_ERROR_CODES` 以外の `ok: false`。`skipped` を含む)、(2) 印を付ける RPC の失敗・応答の形の誤り・文面を作る処理や `sendEmail` の例外 (500 を返す前)、(3) 印を付けた行が 0 件 (数えてから印を付けるまでに再送・掃除で dead でなくなった。印が無いので外す操作は呼ばず、`below_threshold` を返す)。持ち越さない例外 (R-13 の「例外は §8.3」): (a) 返さないコード (`suppressed` / `invalid_envelope`) のときは印も外さない (送り直しても同じ結果で、15 分ごとの繰り返しになるため。その行は抑止が明けても知らせ直さず、送信待ちの画面に残る)、(b) 印を外す RPC 自体が失敗したとき (warn を残す。その行は通知の対象から外れたまま画面に残る)、(c) 印を付けたあと、送る前に関数ごと止められたとき (時間切れ・デプロイの切り替え。現行の急増通知の「権利を返せない」と同じまれな場合。印と権利が残り、その行は知らせ直さない。印を付ける前に止められたときは印が無いので、抑止が明けた回で知らせる)。運用メールが送信待ちに登録されたあとで届けられなかった場合 (`ops_email_dead_letter` が dead) も、印は付いたまま (自己参照の切り方と同じ扱い)。

自己参照の切り方: 運用メールが dead になっても `template` が `ops_` で始まるので `email_outbox_dead_counts` は数えず、`mark_email_outbox_dead_alerted` も印を付けない (§5.2 (5)(7))。

## 9. API と画面

### 9.1 ログ閲覧の追加: 本文の検索 `q` (`GET /api/super-admin/logs`)

| 項目 | 内容 |
|---|---|
| パラメータ | `q` (任意。前後の空白を除いて 1〜100 文字。制御文字 (U+0000〜U+001F・U+007F) を含めば 400)。他の絞り込みと AND |
| 意味 | `message` または `error_message` に部分一致 (大文字小文字を区別しない。PostgREST の `or=(message.ilike."%…%",error_message.ilike."%…%")`) |
| 索引 | 無し (順に調べる)。`request_id` と同じ扱いで、時間切れは現行の 504 `QUERY_TIMEOUT` (期間を絞るよう促す) |
| 画面 | 絞り込みの欄に「本文 (部分一致)」を足す。`buildQuery` が `q` を付ける。詳細の「この値で絞り込む」は付けない |

`src/lib/super-admin/app-logs.ts` に足すもの (型検査の対象):

```ts
import { z } from 'zod';

/** 本文の検索語の長さの上限。長い語は索引の無い検索を重くするだけなので短く切る */
export const APP_LOGS_SEARCH_MAX_CHARS = 100;
// 制御文字 (改行・NUL など) は PostgREST の絞り込み文字列に入れない
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const AppLogsSearchSchema = z.string().trim().min(1).max(APP_LOGS_SEARCH_MAX_CHARS).refine((v) => !CONTROL_CHARS.test(v), '検索語に制御文字は使えません');

/**
 * PostgREST の .or() に渡す、message / error_message の部分一致の条件を作る。
 * 値は二重引用符で囲み (カンマ・括弧・ピリオドが条件の区切りにならない)、引用符と \ をエスケープし、
 * ILIKE のワイルドカード (% と _) もエスケープしてから % で挟む (利用者の入力を文字どおりに探す)。
 */
export function buildMessageSearchFilter(q: string): string {
  const literal = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const quoted = `"%${literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}%"`;
  return `message.ilike.${quoted},error_message.ilike.${quoted}`;
}
```

`AppLogsFilterSchema` に `q: AppLogsSearchSchema.optional()` を足し、`FILTER_KEYS` に `'q'` を足す。route は `if (q) query = query.or(buildMessageSearchFilter(q));` を `request_id` の次に置く。`AppLogsQuery` に `q?: string`。

### 9.2 送信待ちの一覧と再送

#### GET `/api/super-admin/email-outbox`

| 項目 | 内容 |
|---|---|
| 権限 | `requireRole(['super_admin'])` (admin も不可)。表は service_role でしか読めないので、認可の後に `getSupabaseAdmin()` |
| クエリ | `status` (`queued` / `sent` / `dead`。既定 `dead`)、`template` (任意・完全一致・100 文字まで)、`cursor`、`limit` (既定 50・最大 200。`clampIntParam`) |
| 並び | `created_at` の新しい順・同時刻は `id` の大きい順 (`.order('created_at', { ascending: false }).order('id', { ascending: false })`)。カーソルは `app-logs.ts` の `encodeAppLogCursor` / `decodeAppLogCursor` / `olderThanCursorFilter` をそのまま使い (列名が同じ)、logs の route と同じく `if (cursor) query = query.lte('created_at', cursor.created_at).or(olderThanCursorFilter(cursor));` と書く (`tests/jst-today-source-scan.test.ts` の規則 G で 1 件: §15.1)。`has_more` は `limit + 1` 件を取って判定する (logs の route と同じ) |
| 応答 | `{ data: EmailOutboxListItem[], meta: { limit, has_more, next_cursor } }`。`Cache-Control: no-store` |
| 返す列 | `id, created_at, updated_at, status, template, recipient (マスク済み), user_id, attempts, requeue_count, next_attempt_at, lease_expires_at, last_error_code, last_error_message, last_status_code, sent_at, dead_at, requeued_at, redacted (to_email が伏せ字か)`。**`to_email`・`subject`・`text_body`・`html_body`・`idempotency_key`・`resend_message_id` は返さない** |
| 監査 | 記録しない (宛先はマスク済みで、本文を返さない。再送は記録する) |
| 失敗 | 400 `VALIDATION_ERROR` (nested + details)、401 / 403、504 `QUERY_TIMEOUT`、500 `INTERNAL_ERROR` (logs route と同じ形) |

#### POST `/api/super-admin/email-outbox/[id]/requeue`

handler の形は `src/app/api/super-admin/coupons/[id]/apply/route.ts` と同じ: `type RouteContext = { params: Promise<{ id: string }> };` → `export async function POST(request: NextRequest, props: RouteContext)` → `const { id } = await props.params;` (params は Promise の型で受けて await する。`createClient()` も await の直下で呼ぶ。`tests/next15-async-request-api-scan.test.ts` の規則 1・2)。本文を読まない (`request.json()` を呼ばない)。順: `requireRole(['super_admin'])` → `isUuid(id)` でなければ 400 → service role で `select('id, template, user_id, status')` を 1 件 (無ければ 404) → `rpc('requeue_email_outbox', { p_id })` → `'requeued'` なら `recordAdminAudit({ supabase: await createClient(), actorId: user.id, actionType: 'super_admin.email_outbox.requeue', targetId: row.user_id ?? row.id, targetType: row.user_id ? 'user' : 'email_outbox', details: { outbox_id: row.id, template: row.template, previous_status: row.status }, request, routeName })` (fail-open。記録の失敗は app_logs に残る) → 200 `{ data: { id, status: 'queued' } }`。`'not_dead'` / `'redacted'` は 409 `OP_EMAIL_OUTBOX_NOT_REQUEUEABLE` (details.reason にその語)、`'not_found'` は 404 `OP_EMAIL_OUTBOX_NOT_FOUND`。RPC の失敗は 500 (`internalError(..., { shape: 'nested' })`)。

#### `src/lib/super-admin/email-outbox.ts` (新設・型検査の対象)

```ts
import { z } from 'zod';
import { clampIntParam } from '@/lib/http-params';
import { decodeAppLogCursor, type AppLogCursor } from '@/lib/super-admin/app-logs';
import { maskEmailAddress } from '@/lib/emails/send';

export const EMAIL_OUTBOX_LIST_STATUSES = ['queued', 'sent', 'dead'] as const;
export type EmailOutboxListStatus = (typeof EMAIL_OUTBOX_LIST_STATUSES)[number];
export const EMAIL_OUTBOX_DEFAULT_LIMIT = 50;
export const EMAIL_OUTBOX_MAX_LIMIT = 200;
/** prepare_account_deletion / complete_email_outbox / fail_email_outbox が入れる伏せ字 (SQL の c_masked_email と同じ値。tests/email-outbox-migration-contract.test.ts が突き合わせる) */
export const EMAIL_OUTBOX_REDACTED_EMAIL = 'redacted@redacted.invalid';
/** API が返す last_error_message の上限 (DB は 500 文字。画面の 1 行に収める) */
export const EMAIL_OUTBOX_ERROR_MESSAGE_MAX_CHARS = 200;

/** route が select する列 (本文・宛先の生の値・Idempotency-Key・Resend の ID は選ばない) */
export const EMAIL_OUTBOX_LIST_COLUMNS =
  'id, created_at, updated_at, status, template, to_email, user_id, attempts, requeue_count, next_attempt_at, lease_expires_at, last_error_code, last_error_message, last_status_code, sent_at, dead_at, requeued_at';

export const EmailOutboxApiRowSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  status: z.enum(EMAIL_OUTBOX_LIST_STATUSES),
  template: z.string(),
  to_email: z.string(),
  user_id: z.string().uuid().nullable(),
  attempts: z.number().int(),
  requeue_count: z.number().int(),
  next_attempt_at: z.string(),
  lease_expires_at: z.string().nullable(),
  last_error_code: z.string().nullable(),
  last_error_message: z.string().nullable(),
  last_status_code: z.number().int().nullable(),
  sent_at: z.string().nullable(),
  dead_at: z.string().nullable(),
  requeued_at: z.string().nullable(),
});
export type EmailOutboxApiRow = z.infer<typeof EmailOutboxApiRowSchema>;

export interface EmailOutboxListItem extends Omit<EmailOutboxApiRow, 'to_email'> {
  /** マスクした宛先 (t***@example.com)。伏せ字の行は '[redacted]' */
  recipient: string;
  redacted: boolean;
}
export interface EmailOutboxListResponse {
  data: EmailOutboxListItem[];
  meta: { limit: number; has_more: boolean; next_cursor: string | null };
}
export function toEmailOutboxListItem(row: EmailOutboxApiRow): EmailOutboxListItem {
  const { to_email, ...rest } = row;
  const redacted = to_email === EMAIL_OUTBOX_REDACTED_EMAIL;
  return {
    ...rest,
    last_error_message: rest.last_error_message?.slice(0, EMAIL_OUTBOX_ERROR_MESSAGE_MAX_CHARS) ?? null,
    recipient: redacted ? '[redacted]' : maskEmailAddress(to_email),
    redacted,
  };
}

const EmailOutboxFilterSchema = z.object({
  status: z.enum(EMAIL_OUTBOX_LIST_STATUSES).default('dead'),
  template: z.string().max(100).optional(),
  cursor: z.string().max(512).refine((v) => decodeAppLogCursor(v) !== null, 'cursor が不正です').optional(),
});
export interface EmailOutboxQuery {
  status: EmailOutboxListStatus;
  template?: string;
  cursor?: AppLogCursor;
  limit: number;
}
export type ParseEmailOutboxQueryResult =
  | { ok: true; query: EmailOutboxQuery }
  | { ok: false; details: { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> } };
/** 空文字・空白だけは「指定なし」。知らないパラメータは無視。limit は 400 にせず範囲内に直す (app-logs と同じ) */
export function parseEmailOutboxQuery(searchParams: URLSearchParams): ParseEmailOutboxQueryResult {
  const raw: Record<string, string> = {};
  for (const key of ['status', 'template', 'cursor'] as const) {
    const value = searchParams.get(key)?.trim();
    if (value) raw[key] = value;
  }
  const parsed = EmailOutboxFilterSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, details: parsed.error.flatten() };
  const { cursor: rawCursor, ...filters } = parsed.data;
  const cursor = rawCursor === undefined ? undefined : (decodeAppLogCursor(rawCursor) ?? undefined);
  const limit = clampIntParam(searchParams.get('limit'), { min: 1, max: EMAIL_OUTBOX_MAX_LIMIT, default: EMAIL_OUTBOX_DEFAULT_LIMIT });
  return { ok: true, query: { ...filters, cursor, limit } };
}
```

#### 画面 `/super-admin/email-outbox` (`src/app/super-admin/email-outbox/page.tsx`。`'use client'`)

`logs/page.tsx` と同じ作り (型だけを `@/lib/super-admin/email-outbox` から import・`fetch(..., { cache: 'no-store' })`・JST 表示・要求の番号で古い応答を捨てる・`describeFailure`)。

| 要素 | 内容 |
|---|---|
| 見出し | 「メール送信」。説明「アプリが送るメールの送信待ち・送信済み・届けられなかったもの (email_outbox)。宛先は伏せて表示します」 |
| 絞り込み | 状態 (ラジオ: 届けられなかった (既定) / 送信待ち / 送信済み)、文面の名前 (text・完全一致・候補は表示中の行から datalist) |
| 表の列 | 日時 (作成・JST)、状態、文面の名前、宛先 (マスク)、試行 (attempts / 再送 requeue_count)、次の試行 or 送信日時 or 失敗日時、失敗 (last_error_code・status_code・message の 200 文字)、操作 |
| 操作 | dead の行だけ「再送」ボタン (`redacted` の行は無効化し「宛先を伏せた行は再送できません」)。押すと `window.confirm` なしで POST → 成功したら行を queued に描き替えて `role="status"` で「再送を受け付けました」。409 / 404 は API の `error.message` を表示 |
| 空のとき | 「条件に合うメールはありません」。続きは「さらに読み込む」(カーソル) |
| 導線 | `layout.tsx` の `superAdminOperationsNavItems` に `{ href: '/super-admin/email-outbox', label: 'メール送信', icon: '✉️' }` を足す (アプリログの次) |

## 10. 監査ログ (admin_audit_logs) に足す操作

| action_type | いつ | target | details | 記録の規則 |
|---|---|---|---|---|
| `super_admin.app_logs.list` | `GET /api/super-admin/logs` が 1 行以上返したとき (1 回の GET = 1 行。「さらに読み込む」も 1 行) | `target_id null`・`target_type 'app_log'` | `buildListViewDetails({ level, source, function_name, user_id, request_id, from, to, q, has_cursor }, page.length, null)` | 07 §4.1.1 の一覧の規則。0 件・401 / 403 / 400 / 500 は記録しない。fail-open。user-scoped `createClient()` で INSERT (RLS `audit_logs_insert_admins`) |
| `super_admin.email_outbox.requeue` | `requeue_email_outbox` が `'requeued'` を返したとき | `row.user_id` があれば `'user'`、無ければ `row.id` を `'email_outbox'` | `{ outbox_id, template, previous_status: 'dead' }` | 失敗の分岐 (404 / 409 / 500) は記録しない。fail-open (記録の失敗は app_logs の error) |

どちらも `recordAdminAudit` を通す (`tests/admin-view-audit-1326.test.ts` (b): 直接 INSERT と `x-forwarded-for` の直読みは 0 件)。どちらの呼び出しも、引数はオブジェクトのリテラルで書き、その中に `request` を渡す (`tests/admin-mutation-audit-coverage-1571.test.ts` (b)。変数に入れたオブジェクトを渡すと見えない)。requeue の `recordAdminAudit` は route ファイル (`src/app/api/super-admin/email-outbox/[id]/requeue/route.ts`) の `POST` の本体 (または同じファイルの関数) で直接呼ぶ (別ファイルの関数の中で呼ぶと、同テスト (a) が `audited` と判定できない)。同テスト (a) の表 `EXPECTED` に 1 行足す (§15.1)。

## 11. エラー表

| 場所 | コード | HTTP / 戻り値 | 意味・扱い |
|---|---|---|---|
| `sendEmail` | `invalid_envelope` | `ok:false` | 現行。登録しない |
| `sendEmail` | `not_configured` | `ok:false / skipped:true` | 現行。登録しない |
| `sendEmail` | `suppressed` | `ok:false` | 現行 + dead の行 (`redactAfterSend` の登録は行を作らない)。cron は権利を返さない |
| `sendEmail` | `outbox_failed` (新) | `ok:false / retryable:true` | INSERT の失敗 (`{ error }`・行が返らない・例外。`sendEmail` は例外を投げない)。呼び出し元は現行の失敗の分岐 (記録のみ)。cron は権利を返す |
| worker (行) | `expired` / `suppressed` / `network_error` / `invalid_response` / Resend の `name` | `last_error_code` | §7.1 のとおり dead か再試行 |
| worker (route) | – | 401 / 503 (cron 認証)、200、500 `INTERNAL_ERROR` (RPC の失敗・応答の形の誤り) | 500 の本文は汎用。原因は app_logs |
| app-log-alerts (`email_dead_letter`。§8.2) | 数える RPC (`email_outbox_dead_counts`)・`claim_ops_alert` の失敗、数えた応答の形の誤り | 500 `INTERNAL_ERROR` | 急増通知の 2 種類と同じ。印も権利も触らない (server / client の通知はその前に済んでいる) |
| app-log-alerts (`email_dead_letter`) | 印を付ける RPC (`mark_email_outbox_dead_alerted`) の失敗・応答の形の誤り・文面を作る処理と `sendEmail` の例外 | 500 `INTERNAL_ERROR` | 印を外し (`unmark_email_outbox_dead_alerted`)、権利を返してから 500 (§8.3)。行は次の回で数え直す |
| app-log-alerts (`email_dead_letter`) | 印を外す RPC・権利を返す RPC の失敗 (エラー・例外) | warn (応答は変えない) | 例外にしない。印が外れなければ、その行は通知の対象から外れたまま画面に残る (§8.3 の (b)) |
| RPC | `22023` | 例外 | 引数が範囲外 (呼び出し側の誤り。`mark_email_outbox_dead_alerted` / `unmark_email_outbox_dead_alerted` の `p_alerted_at` が NULL を含む) |
| `requeue_email_outbox` | `'not_found'` / `'not_dead'` / `'redacted'` | text | API が 404 / 409 / 409 にする |
| GET email-outbox / logs | `VALIDATION_ERROR` | 400 (nested + details) | クエリの誤り |
| GET email-outbox / logs | `UNAUTHORIZED` / `FORBIDDEN` | 401 / 403 | 認証・権限 |
| GET email-outbox / logs | `QUERY_TIMEOUT` | 504 | `57014`。期間や条件を絞る |
| POST requeue | `VALIDATION_ERROR` | 400 | id が UUID でない (`INVALID_ID_PARAM_MESSAGE`) |
| POST requeue | `OP_EMAIL_OUTBOX_NOT_FOUND` (新) | 404 | 行が無い |
| POST requeue | `OP_EMAIL_OUTBOX_NOT_REQUEUEABLE` (新) | 409 | dead でない (`details.reason = 'not_dead'`)、または宛先を伏せた行 (`'redacted'`) |
| 共通 | `INTERNAL_ERROR` | 500 | `internalError(..., { shape: 'nested' })` |

新しいコード 2 つは `cross/04-api-conventions.md` §4.2 OP 系に `[NEW]` で追記する (追随表)。

## 12. テスト一覧 (it 名。新設・改定)

新しいテストのファイルが route を読み込むときは、ファイルの一番外側 (字下げしない行) で 1 回だけ `const { GET } = await import('@/app/api/…/route');` の形で読む。テスト・フックの中 (字下げした行) で route を読み込むと、`tests/heavy-unit-test-timeout.test.ts` の「同じ型のファイル」に当たり、時間切れの延長 (`HEAVY_UNIT_TEST_FILES` への登録など) が無ければ赤になる (§15.1)。`R-16` の `maxDuration` などの export を確かめる it も、一番外側で読んだモジュールを使う。

| ファイル | it 名 (要約) |
|---|---|
| `src/__tests__/lib/emails/outbox.test.ts` (新) | `resolveEmailOutboxSettings: 未設定は既定 (6 回・20 件)` / `整数でない・範囲外は既定に戻し変数名だけを ignored に` / `retryDelaySeconds: 1→60, 2→300, 3→900, 4→3600, 5→14400, 6 以上→14400` / `parseClaimedRows: 形が違えば例外 (黙って 0 件にしない)` / `isRetryableResendError: true = 429 rate_limit_exceeded・500 internal_server_error・502/503/504 application_error・statusCode null の application_error (通信エラー)・409 concurrent_idempotent_requests (同じキーの送信が処理中) / false = 400・403・422 validation_error・401 invalid_api_key・403 restricted_api_key・404 not_found・409 invalid_idempotent_request・429 daily_quota_exceeded / monthly_quota_exceeded・statusCode 無しの validation_error・statusCode null の missing_required_field` (send.test.ts の「再試行する失敗」「再試行しない失敗」の it.each の行をそのまま移す) / `createResendTransport: 受け付けたら ok と id、error は code/statusCode/retryable、ID 無しは invalid_response、例外は network_error で retryable、Idempotency-Key を付ける` / `processEmailOutbox: 取った行を順に送り complete する` / `送信の間隔を空ける (2 通目の前に sleep)` / `retryable の失敗は fail(queued) で requeued に数える` / `非 retryable は dead に数え error ログ (宛先はマスク)` / `7 日より古い行は Resend を呼ばず expired で dead` / `停止リストに載った宛先は Resend を呼ばず suppressed で dead` / `停止リストを引けなければ warn して送る` / `transport が例外を投げても network_error として fail し、次の行へ進む` / `complete が false (取り直された・退会で伏せられた) なら sent に数えず warn` / `時間の予算を超えたら残りを送らず stopped_early` / `claim が 0 件なら何もしない` / `maskEmailAddress / redactEmailAddresses (send.test.ts から移す)` |
| `src/__tests__/lib/emails/send.test.ts` (改) | ハーネス: いまは `resend`・`@/lib/emails/suppression`・`@/lib/db-logger` だけをモックしている。`vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }))` を足し、既定は `from('email_outbox')` の `insert(row)` を `mocks.outboxInserts` に積み、`.select('id').single()` が `{ data: { id: OUTBOX_ID }, error: null }`、`select` を付けない `insert` が `{ error: null }` を返す偽物にする (無いと `getSupabaseAdmin` が環境変数の不足で例外 → すべて `outbox_failed`)。`maskEmailAddress` の節は outbox.test.ts へ移し、ここには `maskEmailAddress は @/lib/emails/send から再エクスポートされ、outbox のものと同じ関数` を 1 件だけ残す。残す: `EmailEnvelopeSchema` の節、`文面 (封筒) が不正`、`RESEND_API_KEY が未設定` (登録しないことを足す)、`宛先停止リスト` (dead の行を INSERT することを足す)、`送信元 (#1194)` のうち parse の検査。消す: 再試行・Idempotency-Key・Resend の呼び出しの節 (outbox.test.ts へ)。足す: `登録: queued の行を INSERT し ok:true / id=行の id / attempts 0 を返す。Resend は呼ばない` / `登録に失敗したら ok:false outbox_failed (retryable) で error ログ` / `getSupabaseAdmin や insert が例外を投げても、例外にせず ok:false outbox_failed を返す (エラー文の中のアドレスはマスク)` / `idempotencyKey / userId / redactAfterSend を行に入れる` / `redactAfterSend の登録で宛先が停止リストに載っていれば、行を作らずに suppressed を返す (R-10)` / `停止リストで dead の行を残す INSERT が { error } でも例外でも、結果は suppressed のまま` / `template が無い封筒は unknown で登録` / `ログに宛先・件名・本文を残さない` |
| `src/__tests__/lib/emails/outbox-store.test.ts` (新) | `claim: RPC の引数と応答の検証` / `complete: true/false` / `fail: 'queued' / 'dead' / それ以外は 'ignored'` / `RPC の error は例外 (DB の文は message に入れない)` |
| `src/__tests__/api/cron/email-outbox.test.ts` (新) | `A-1〜A-6 認証 (app-log-alerts と同じ)` / `鍵が無ければ not_configured で claim しない` / `環境変数の不正は既定に戻し warn` / `claim の失敗は 500 (汎用)` / `処理の要約を応答とログに (宛先なし)` / `GET だけ公開` / `vercel.json に毎分で登録` / `fetchCache force-no-store` / `R-16: runtime nodejs・maxDuration = 60 を export し、EMAIL_OUTBOX_RUN_BUDGET_MS < maxDuration × 1000 ≤ EMAIL_OUTBOX_LEASE_SECONDS × 1000` / `応答のあと延命する` |
| `src/__tests__/api/cron/app-log-alerts.test.ts` (改) | ハーネス: `Scenario` に `deadCounts: RpcResult` (既定 `{ data: [], error: null }`) と `deadClaim: RpcResult` (既定 `{ data: DEAD_CLAIMED_AT, error: null }`。`const DEAD_CLAIMED_AT = '2026-10-09T01:15:00.789012+00:00';` を `CLIENT_CLAIMED_AT` の隣に足す) と `deadMark: RpcResult` (既定 `{ data: DEAD_ROWS, error: null }`) と `deadUnmark: RpcResult` (既定 `{ data: 0, error: null }`) を足し (`const DEAD_ROWS = [{ template: 'family_invite', dead_count: 2, total_count: 3 }, { template: 'support_ticket_reply', dead_count: 1, total_count: 3 }];` を `SURGE_ROWS` の隣に足す)、`beforeEach` の rpc のモックに `if (fn === 'email_outbox_dead_counts') return scenario.deadCounts;`・`if (fn === 'mark_email_outbox_dead_alerted') return scenario.deadMark;`・`if (fn === 'unmark_email_outbox_dead_alerted') return scenario.deadUnmark;` と、`claim_ops_alert` の `p_alert_key === 'email_dead_letter'` なら `scenario.deadClaim` を足す (足さないと未知の RPC で例外 → 全 it が 500。既定の `deadCounts` は 0 件なので、ほかの it では mark / unmark は呼ばれない)。`const DEAD_LETTER_QUIET = { status: 'below_threshold', total: 0, threshold: 0 } as const;` を足す。改 (応答の形): 応答を `toEqual` で比べて `client` キーを持つ期待値 (origin/main で 18 か所: `client: CLIENT_QUIET` の 12 か所 = H-2・H-3・H-4・D-2・E-1 (2 か所)・E-2・E-4・E-5・E-6・M-6・F-1 と、`client: { … }` を直書きした 6 か所 = K-1・K-2 (`over` の方。`atThreshold` は `toMatchObject` なので変えない)・K-3・K-4・K-5・K-6。実装時に `grep -n 'client:' src/__tests__/api/cron/app-log-alerts.test.ts` で `toEqual` の中のものをすべて拾う) に `email_dead_letter: DEAD_LETTER_QUIET` を足す (既定の `deadCounts` は 0 件なので、ほかの値は変わらない)。改 (そのほか): `O-1` (名前を「DB への入口は 5 つの RPC だけ」に、期待の集合に `email_outbox_dead_counts` を足す)、`M-6` と `K-2` の `email_id: 'email-id-1'` を `outbox_id: 'email-id-1'` に。改 (it の中で rpc のモックを差し替える 3 つ。`beforeEach` のハーネスを通らないので、足さないと赤): `D-3` (l.413 のモックは未知の RPC に `scenario.release` = `{ data: true }` を返す → `email_outbox_dead_counts` の応答が配列でなく `parseErrorCountRows` が例外 → 毎回 500 で `statuses` が `['sent','deduped',…]` にならない) と `D-4` (l.434 のモック。同じく 500 になるうえ、`order` に `email_outbox_dead_counts` が末尾に積まれ `toEqual` が外れる) と `F-6` (l.772 のモックは未知の RPC で `throw new Error('network down')` → `email_outbox_dead_counts` も例外 → 500 で、期待の `200 send_failed` が外れる) の 3 つのモックに、`if (fn === 'email_outbox_dead_counts') return scenario.deadCounts;` を未知の RPC の分岐より前に足す。`D-4` は期待の順を `['app_log_error_counts', 'claim_ops_alert', 'sendEmail', 'app_log_client_error_counts', 'email_outbox_dead_counts']` にする (it 名に「最後に届けられなかったメールを数える」を足す)。変えない: `F-1`・`F-3`・`F-5`・`E-7`・`K-8` (`failedResult` は `validation_error` で、§8.3 の規則では権利を返すまま。`F-6` も同じ理由で権利を返すが、上のモックの追記は要る)、`F-2` (skipped は返す)。足す (T-1〜T-9 は server を静かにするため `counts: { data: [], error: null }` にし、届けられなかったメールがある回は `deadCounts: { data: DEAD_ROWS, error: null }` にする。`sendEmail` のモックは 3 種類で共有なので、server / client が送らない形で確かめる): `T-1: まだ知らせていない dead が 1 件でもあれば知らせる。email_outbox_dead_counts を { p_limit: 10 } (窓を渡さない) で呼び、claim_ops_alert をキー email_dead_letter・クールダウン 60 で呼び、mark_email_outbox_dead_alerted を { p_alerted_at: DEAD_CLAIMED_AT, p_limit: 10 } で呼び、印を付けた行 (deadMark) の件数で文面を作る (sendEmail の封筒の template が ops_email_dead_letter・件名に 3 件・本文に family_invite 2 件と support_ticket_reply 1 件と /super-admin/email-outbox の絶対 URL)。応答の email_dead_letter は { status: 'sent', total: 3, threshold: 0 }。info ログのキーは outbox_id` / `T-2: まだ知らせていない dead が 0 件なら below_threshold (claim_ops_alert をキー email_dead_letter で呼ばず、mark も呼ばない)` / `T-3: server / client の通知を送ってから email_dead_letter を数える (rpc と sendEmail の呼び出しの順の末尾が email_outbox_dead_counts → claim_ops_alert → mark_email_outbox_dead_alerted → sendEmail)。email_outbox_dead_counts の失敗は 500 で、server の通知 (counts を SURGE_ROWS にした回) はその前に済んでいる` / `T-4: sendEmail が suppressed (宛先が停止リスト) なら、権利も印も返さない (release_ops_alert も unmark_email_outbox_dead_alerted も呼ばない) で send_failed。invalid_envelope も同じ` / `T-5: sendEmail が outbox_failed、または skipped (not_configured) なら、unmark_email_outbox_dead_alerted を { p_alerted_at: DEAD_CLAIMED_AT } で呼んで印を外し、そのあと release_ops_alert で権利を返す (この順)。応答は send_failed / send_skipped` / `T-6: 抑止の間に dead になった行を取りこぼさない (R-13・S-18)。rpc のモックの claim_ops_alert (キー email_dead_letter) を 1 回目は DEAD_CLAIMED_AT・2 回目は null・3 回目は別の時刻にして 3 回呼ぶ: 1 回目は mark を呼んで sent、2 回目は deduped で mark を呼ばない、3 回目は mark を 3 回目の時刻で呼び、その回の deadMark の件数 (support_ticket_reply 1 件) で 2 通目を送る。数える RPC の引数は 3 回とも { p_limit: 10 } (窓が無い)` / `T-7: 印を付ける RPC が { error } を返す・例外を投げる・配列でない応答を返すなら、unmark_email_outbox_dead_alerted と release_ops_alert を呼んでから 500 (汎用メッセージ)。sendEmail (届けられなかったメールの文面) は呼ばない` / `T-8: 印を付けた行が 0 件 (deadMark が []。数えたあとに再送・掃除で減った) なら、メールを送らず release_ops_alert で権利を返して below_threshold (total 0)。unmark は呼ばない` / `T-9: 印を外す RPC が { error } を返しても例外を投げても、応答は send_failed のまま。warn (「印を外せませんでした」) を残す` |
| `src/__tests__/lib/emails/ops/email-dead-letter.test.ts` (新) | `EmailEnvelopeSchema で valid な封筒を返し、template は ops_email_dead_letter・to は渡した宛先・from は getEmailFrom` / `件名は「【ほめゴハン運用】届けられなかったメールがあります (N 件)」で、件数は桁区切り (1,234)` / `本文に template ごとの件数 (多い順・番号付き)・ほかの文面の合計 (other_count > 0 のときだけ)・送信待ちの画面の URL (単独の行)・確認した時刻 (JST)・抑止の分数・「まだ知らせていないものだけを数えている」の一文` / `宛先・件名・本文・ユーザー ID を載せない (渡した template の名前に入ったメールアドレス・UUID はマスクされる)` |
| `src/__tests__/lib/admin/send-ticket-reply-email.test.ts` (改) | モックを替える: いまは `resend` だけをモックして本物の `sendEmail` を通しているが、`sendEmail` は Resend を呼ばず `email_outbox` に INSERT するようになるので、`vi.mock('@/lib/emails/send', () => ({ sendEmail: mockSendEmail }))` に替える (`ticket-messages.test.ts` と同じ形。`sendEmail` そのものは send.test.ts が受け持つ)。既定は `mockSendEmail.mockResolvedValue({ ok: true, id: 'outbox-id-1', attempts: 0, skipped: false, error: null })`。封筒を見る it (`…宛に、返信の本文を載せて送り、sent を返す`・`お問い合わせフォームの URL…`・`NEXT_PUBLIC_APP_URL が未設定なら…`・`SUPPORT_REPLY_TO 未設定`・`SUPPORT_REPLY_TO 設定`・`SUPPORT_REPLY_TO がメールアドレスの形式でなくても…`) は `mockEmailsSend.mock.calls[0][0]` (Resend の形: `replyTo`) を `mockSendEmail.mock.calls[0][0]` (EmailEnvelope の形: `to` / `text` / `reply_to`) に読み替える。`RESEND_API_KEY 未設定` は `mockSendEmail` が skipped (`not_configured`) を返す形に、`Resend がエラーを返す` は `mockSendEmail` が `ok:false` (`error = new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED: …', null, 0, true)`) を返す形に替え、it 名を「送信待ちに登録できない (outbox_failed) なら failed / send_failed」にする (§7.1 の対応表)。消す: `Resend の呼び出しが例外になる…3 回再試行しても`・`一時的な失敗 (503) は再試行して…`・`再試行しても直らない失敗 (403…)` (再試行は worker: outbox.test.ts)、`email_delivery_logs に実在する列だけで 1 行残す`、節 `送信ログの書き込みに失敗した場合` の 2 件。足す: `sendEmail の 2 つ目の引数は { userId: ticket.user_id }` / `email_delivery_logs には書かない (送信の記録は email_outbox)` / `sendEmail が ok:true (送信待ちに受け付けた) なら sent を返す (登録したあとの送信の失敗はここでは分からない: R-24)` |
| `src/__tests__/api/contact.test.ts` (改。段 B) | ハーネス: `const mockSendEmail = vi.hoisted(() => vi.fn());` と `vi.mock('@/lib/emails/send', () => ({ sendEmail: mockSendEmail }))` を足し、`beforeEach` で `mockSendEmail.mockResolvedValue({ ok: true, id: 'outbox-id-1', attempts: 0, skipped: false, error: null })`。describe `POST /api/contact: 管理者への通知メールの送信元 (#1194)` の `fetchSpy`・`vi.stubGlobal('fetch', …)`・`vi.stubEnv('RESEND_API_KEY', …)` を消し (`ADMIN_NOTIFICATION_EMAIL` の stub は残す)、`sentBody()` を `const sentEnvelope = () => mockSendEmail.mock.calls[0][0] as EmailEnvelope;` (`import type { EmailEnvelope } from '@/lib/emails/envelope'`) に替える。改: `EMAIL_FROM があれば、それを送信元にする` (`mockSendEmail` が 1 回・`sentEnvelope().from` が EMAIL_FROM・`sentEnvelope().to` が `'admin@example.com'`。`api.resend.com` の期待は消す) / `EMAIL_FROM が未設定なら、従来と同じ既定の送信元 (DEFAULT_EMAIL_FROM)` (`sentEnvelope().from`) / `Resend が送信を断っても…` → `送信待ちへの登録が失敗しても (sendEmail が ok:false の outbox_failed)、問い合わせの受け付けは成功のまま。warn を残す` (200・`success: true`・`mockInsert` が 1 回・`vi.spyOn(console, 'warn')` の呼び出しのどれかの第 1 引数が「お問い合わせの通知メールを送信待ちに登録できませんでした」を含む)。足す: `通知は template contact_admin_notification で、本文の送信者はマスクする (user@example.com を含まず u***@example.com を含む)。サポートの画面の URL (/support/inquiries) が単独の行` / `ADMIN_NOTIFICATION_EMAIL が未設定なら sendEmail を呼ばずに 200` / `Resend の API (fetch) を直接呼ばない` (`vi.stubGlobal('fetch', spy)` の spy の呼び出しのどの第 1 引数にも `api.resend.com` を含まない) |
| `src/__tests__/api/contact-rate-limit.test.ts` (改。段 B) | `const fetchSpy = vi.fn();` と `beforeEach` の `vi.stubEnv('RESEND_API_KEY', …)`・`fetchSpy.mockResolvedValue(…)`・`vi.stubGlobal('fetch', fetchSpy)` を消し、`const mockSendEmail = vi.hoisted(() => vi.fn());`・`vi.mock('@/lib/emails/send', () => ({ sendEmail: mockSendEmail }))` を足して `beforeEach` で `ok: true` を返す。`expect(fetchSpy)` の 3 か所 (`toHaveBeenCalledTimes(10)` の 2 つ・`not.toHaveBeenCalled()`) を `mockSendEmail` に替える (it 名と意味は変えない: 429・fail-closed では保存も通知もしない)。`beforeEach` の上のコメント「管理者通知メール (Resend) を有効にして」を「管理者通知メール (送信待ちへの登録) を有効にして」に |
| `src/__tests__/lib/emails/support/contact-admin-notification.test.ts` (新) | `EmailEnvelopeSchema で valid な封筒を返す` / `template は contact_admin_notification` / `to は運営の宛先、from は getEmailFrom (EMAIL_FROM が無ければ DEFAULT_EMAIL_FROM)` / `件名は [お問い合わせ] + 件名。100 文字の件名でも 100 文字以内に収まり、サロゲートペアの途中で切らない` / `件名の改行・連続する空白を 1 行にそろえ、空白だけなら (件名なし)` / `本文に ID・種別・マスクした送信者・件名・内容があり、サポートの画面の URL が単独の行` |
| `src/__tests__/lib/emails/template-names.test.ts` (改。段 B) | 改: it 名 `サポートの返信メールは、送信記録 (email_delivery_logs.template) と同じ support_ticket_reply` を `サポートの返信メールは、送信待ちの記録 (email_outbox.template) と同じ support_ticket_reply` に (§6.6 で `email_delivery_logs` に書かなくなるため。期待 `['support_ticket_reply']` は変えない)。ほかの it は変えずに緑 (新しい文面 `ops/email-dead-letter.ts`・`support/contact-admin-notification.ts` は `template:` の行を 1 つずつ持ち、名前が重ならない。`renderers.length` は 2 つ増える) |
| `tests/email-resend-boundary-scan.test.ts` (新・静的。段 B) | 走査: `src/` の `.ts` / `.tsx` (`__tests__`・`*.test.*`・`*.spec.*`・`.d.ts` を除く) を TypeScript の構文木で読み、Resend を直接使う書き方 = (1) `import … from 'resend'` (`import type` は除く) (2) `import('resend')` (3) `new Resend(…)` (4) `'api.resend.com'` を含む文字列リテラル・テンプレート、を数える (コメントの中は数えない)。許可 = `{ 'src/lib/emails/outbox.ts': 'worker の送信 (createResendTransport)。Resend を呼ぶのはここだけ (#1193)' }`。it: `Resend を直接使うのは src/lib/emails/outbox.ts だけ (ほかのファイルが使えば赤。sendEmail で送信待ちに登録する)` / `走査が機能している: src/lib/emails/outbox.ts を検出し、走査したファイルが 100 を超える` / `許可の一覧が古くない (許可のファイルが実在し、今も Resend を直接使う)` / `検出力: 合成ソースで 4 つの書き方を拾い、コメント・import type・'resend' を含む別のモジュール名 ('resend-webhook-event') は拾わない` |
| `tests/lib-raw-error-message-scan.test.ts` (改。段 B) | 表 `ALLOWED` の `'src/lib/emails/send.ts'` の項 (`count: 2`) を消し、同じ位置 (`'src/lib/admin/not-supported.ts'` の次) に `'src/lib/emails/outbox.ts': { count: 3, reason: 'Resend の送信の失敗の文面 (createResendTransport の応答のエラーと例外・processEmailOutbox の transport の例外。宛先のアドレスは redactEmailAddresses でマスク済み) を EmailTransportFailure.message に入れる。値は email_outbox.last_error_message に入り、super_admin の画面に 200 文字までだけ出る。DB のエラー文ではない (DB の失敗は outbox-store.ts が固定の文の例外にする)' }` を足す。3 件 = §6.2 の `message: redactEmailAddresses(response.error.message \|\| code)` と、`message: redactEmailAddresses(err instanceof Error ? err.message : String(err))` の 2 か所 (createResendTransport の catch・processEmailOutbox の catch)。§6.3 のあとの send.ts は 0 件 (`.message` を読むのはログと `new Error` / `new EmailSendError` の中だけ) なので、項を残すと it `許可リストの件数が実際と一致する` が赤 (2 ≠ 0)、outbox.ts を足さないと it `許可リストにないファイルは、結果 (オブジェクトのプロパティ) にエラーの文面を入れていない` が赤。段 B のほかの新しい src/lib のファイル (outbox-store.ts・ops/email-dead-letter.ts・support/contact-admin-notification.ts) と段 C の src/lib/super-admin/email-outbox.ts は 0 件 (エラーらしい名前の値の `.message` をオブジェクトのプロパティに入れない) |
| `src/__tests__/api/admin/support/ticket-messages.test.ts` (改) | 改: `送信ログ (email_delivery_logs) を実在する列で service role から残す` (274 行付近) を `送信ログ (email_delivery_logs) は書かない。sendEmail に userId (チケットの user_id) を渡す` に替える (`mockAdminInsert` が `email_delivery_logs` で呼ばれないこと・`mockSendEmail.mock.calls[0][1]` が `{ userId: CUSTOMER_ID }`)。消す: `送信ログの INSERT が失敗しても (supabase-js は { error } を返す) 201 + email.status=sent。失敗を記録する` (413 行付近。INSERT が無くなる)。ほかの it は `mockAdminInsert).not.toHaveBeenCalled()` のままで緑 |
| `src/__tests__/api/webhooks/resend.test.ts` (改) | 偽物の `fakeAdmin().from` は `email_blacklist` 以外で例外を投げるので、`email_outbox` の `insert(row)` を受ける形を足す (行を `mocks.outboxRows` に積み、`insert(...).select('id').single()` は `{ data: { id: '<固定の uuid>' }, error: null }`、`select` を付けない `insert` は `{ error: null }` を返す)。改: `ハードバウンスの宛先へは sendEmail が Resend を呼ばず suppressed を返す。ほかの宛先へは送る` → `…suppressed を返し (dead の行を 1 行残す)。ほかの宛先は送信待ちに登録する (ok: true・Resend は呼ばない・queued の行が 1 行)` (`mocks.emailsSend` は 2 回とも呼ばれない。送るのは worker) |
| `tests/account-deletion-email.test.ts` (改) | 足す: `完了メールは redactAfterSend: true で登録する (sendEmail の 2 つ目の引数。userId は渡さない)` |
| `src/__tests__/lib/env.test.ts` (改。段 B) | 改 (it `値を読む場所が決まっている変数 (…) は、check:env のために一覧にあるが、getOptionalEnv では読めない`): (1) it 名の括弧の中の一覧の `CRON_SECRET_PREVIOUS・` の直後に `EMAIL_OUTBOX_*・` を足す。(2) `sealed.map(...).sort()` を `toEqual` で比べる期待の配列 (完全一致) に、`['CRON_SECRET_PREVIOUS', 'src/lib/cron-auth.ts'],` の直後・`// #1148 …` の前に次の 3 行を足す (`.sort()` は `'名前,ファイル'` の文字列の順なので、`CRON_…` < `EMAIL_OUTBOX_BATCH_SIZE` < `EMAIL_OUTBOX_MAX_ATTEMPTS` < `FEATURE_…`): `// #1193 メールの送信待ちの試行の上限と 1 回の件数。不正な値の扱い (既定値に戻して warn) を送信待ちの cron の route 1 か所に置く` / `['EMAIL_OUTBOX_BATCH_SIZE', 'src/app/api/cron/email-outbox/route.ts'],` / `['EMAIL_OUTBOX_MAX_ATTEMPTS', 'src/app/api/cron/email-outbox/route.ts'],`。(3) 同じ it の `typeOnly` の中の `getOptionalEnv('RESEND_API_KEY');` の行の前に 4 行を足す: `// @ts-expect-error EMAIL_OUTBOX_MAX_ATTEMPTS の値を読むのは送信待ちの cron の route (src/app/api/cron/email-outbox/route.ts) だけ (#1193)` / `getOptionalEnv('EMAIL_OUTBOX_MAX_ATTEMPTS');` / `// @ts-expect-error EMAIL_OUTBOX_BATCH_SIZE も同じ` / `getOptionalEnv('EMAIL_OUTBOX_BATCH_SIZE');`。同じ it の `for (const entry of sealed)` の検査 (`required` が false・`whenMissing` が空でない・`readOnlyBy` のファイルが実在) は §6.1 の 2 項目と段 B の route で満たす (直さない) |
| `tests/ai-usage-contract.test.ts` (改。段 B) | 改 (§6 定期実行の `CRON_ENTRYPOINTS`): `'vercel:/api/cron/app-log-alerts': …,` の行の直後に、注記 `// #1193 メールの送信待ちを毎分送る。import は cron の認証・ログ・Supabase・Resend・宛先停止リストだけ` と行 `'vercel:/api/cron/email-outbox': 'メールの送信待ちを送る (AI を使わない)',` を足す (足さないと it `定期実行の入口の全数は CRON_ENTRYPOINTS の一覧どおり…` の `expect(scanCronEntrypoints()).toEqual(Object.keys(CRON_ENTRYPOINTS).sort())` が赤)。足したことで、it `定期実行は記録しない…` (route の実在・`consumeAiUsage` の呼び出し 0 件) と it `Vercel Cron の route のうち、AI の入口の一覧 … に無いものは、AI へ送るコードに届かない` (`reachesAi` が false) の対象にもなる。§6.5 の route と §6.2・§6.4 の import 先は AI の印 (`tests/helpers/ai-reach.ts` の `AI_LEAF_PATTERN`。`RESEND_API_KEY` は当たらない) を含まないので、この 2 つは直さずに緑。pg_cron の `cleanup-email-outbox` は `SELECT public.cleanup_email_outbox();` で `functions/v1/` を含まないので `scanCronEntrypoints` に現れない (`pg_cron:` の行は足さない) |
| `tests/super-admin-logs-route.test.ts` (改) | 足す: `q: message / error_message の部分一致 (or の文字列。% _ \ " を文字どおりに)` / `q が 100 文字超・制御文字は 400` / `1 行以上返したら admin_audit_logs に super_admin.app_logs.list を 1 行 (条件と件数だけ)` / `0 件・400・403 は記録しない` / `記録に失敗しても 200 (fail-open)`。改: `createClient` のモックが `admin_audit_logs` の insert を受ける |
| `tests/super-admin-logs-page.test.tsx` (改) | 足す: `本文の欄に入力して絞り込むと q を付ける` |
| `tests/super-admin-app-logs-query.test.ts` (改。段 C) | 改: it `知らないパラメータは無視する` の `params('page=2&per_page=10&sort=asc&q=x')` を `params('page=2&per_page=10&sort=asc&foo=x')` に替える (`q` は §9.1 で `FILTER_KEYS` に入る既知の絞り込みになり、残すと結果が `{ ok: true, query: { q: 'x', limit: 50, cursor: undefined } }` になって `toEqual` が赤)。ほかの it (すべての絞り込みを指定した it・前後の空白の it など) は `q` を渡さないので変えない。足す (describe `parseAppLogsQuery` の中): `q: 前後の空白を除いて検索語にする (q=%20timeout%20 → 'timeout')。空文字・空白だけは指定なし (結果に q が無い)` / `q: 100 文字は通り、101 文字は ok:false で fieldErrors に q` / `q: 制御文字 (改行 %0A・NUL %00・DEL %7F) を中に含めば ok:false で fieldErrors に q` / `q はほかの絞り込みと一緒に返る (level=error&q=x → { level: 'error', q: 'x', limit: 50, cursor: undefined })`。足す (新しい describe `buildMessageSearchFilter`): `message と error_message の ilike を , でつないだ or の条件を返す ('timeout' → message.ilike."%timeout%",error_message.ilike."%timeout%")` / `% と _ と \ はワイルドカードにならないようにエスケープし、" はエスケープして引用符の中に閉じる (カンマ・括弧・ピリオドを含む語でも条件が分かれない)` |
| `tests/super-admin-email-outbox-route.test.ts` (新) | `認可: super_admin だけ 200、admin 403、未ログイン 401 (service role を作らない)` / `既定は dead を新しい順、宛先はマスク、本文・Idempotency-Key・Resend の ID を返さない` / `伏せ字の行は recipient '[redacted]' と redacted true` / `status / template / cursor / limit` / `カーソルで全行が 1 回ずつ` / `不正な値は 400` / `57014 は 504` / `no-store` |
| `tests/super-admin-email-outbox-requeue-route.test.ts` (新) | `super_admin だけ` / `id が UUID でなければ 400` / `行が無ければ 404` / `requeued なら 200 と監査ログ 1 行 (target は user_id か行の id)` / `not_dead / redacted は 409 で記録しない` / `RPC の失敗は 500 (汎用) で記録しない` / `本文を読まない` |
| `tests/admin-mutation-audit-coverage-1571.test.ts` (改。段 C) | 改 (表 `EXPECTED`): `'src/app/api/super-admin/coupons/route.ts POST': 'audited',` の直後・`'src/app/api/super-admin/embeddings/regenerate/route.ts POST': 'audited',` の前 (キーの文字の順。`coupons/…` < `email-outbox/…` < `embeddings/…`) に `'src/app/api/super-admin/email-outbox/[id]/requeue/route.ts POST': 'audited',` を足す (足さないと it `変更系の handler の一覧が表 (EXPECTED) と一致し、「audited」はすべて recordAdminAudit に届く` の `expect(Object.keys(actual).sort()).toEqual(Object.keys(EXPECTED).sort())` が赤)。`GET /api/super-admin/email-outbox` と `GET /api/super-admin/logs` は変更系でないので (a) の表に足さない。(b) (`recordAdminAudit` の呼び出しはすべて `request` を渡す) は §10 の書き方で満たす (直さない) |
| `tests/super-admin-email-outbox-page.test.tsx` (新) | `初回は dead を 50 件` / `状態の切り替え` / `dead の行にだけ再送、伏せ字の行は無効` / `再送の成功で行が queued に・status で知らせる` / `409 の説明を出す` / `さらに読み込む` |
| `tests/email-outbox-migration-contract.test.ts` (新・静的) | `migration と rollback が対` / `complete_email_outbox と fail_email_outbox の伏せ字 (c_masked_email) が EMAIL_OUTBOX_REDACTED_EMAIL と同じ値` / `fail_email_outbox は dead にするときだけ redact_after_send の行の to_email・subject・text_body・html_body を伏せ、p_retryable の NULL を 22023 で断る` / `表の列 (27 列)・CHECK (email_outbox_status_times と email_outbox_dead_alerted_only_dead)・索引 5 本・RLS と完全形の REVOKE/GRANT` / `RPC 8 本が SECURITY INVOKER・search_path ''・service_role だけ (REVOKE / GRANT の引数の型が関数の定義と同じ)` / `claim が SKIP LOCKED` / `email_outbox_dead_counts は窓を持たず (引数は p_limit だけ。make_interval を使わない)、status = 'dead' と dead_alerted_at IS NULL で数え、suppressed / recipient_deleted / ops_ を除く` / `mark_email_outbox_dead_alerted の UPDATE の WHERE は email_outbox_dead_counts の WHERE と同じ 5 つの条件で、SET は dead_alerted_at = p_alerted_at と updated_at だけ。unmark_email_outbox_dead_alerted は dead_alerted_at = p_alerted_at の行だけを NULL に戻す` / `requeue_email_outbox は dead_alerted_at = NULL を SET する` / `pg_cron cleanup-email-outbox が 20 18 * * *` / `prepare_account_deletion が 20261010000100 の本体を含み email_outbox の段 (1b・1c) を足している` / `prepare_account_deletion の 1c: 件名・本文・HTML・返信先を regexp_replace(…, 'gi') で伏せ、照合の正規表現は本人のアドレスの英数字以外を \ でエスケープして \| でつなぐ。1c の UPDATE は status・attempts・next_attempt_at・worker_id・lease_expires_at・idempotency_key・to_email を SET しない` / `08-cron-batches.md と vercel.json の数が合う` / `アプリの定数 (6 回・20 件・RPC 名・キー) と migration の上限が合う` |
| `tests/integration/rls/email-outbox.test.ts` (新・実 DB) | `anon / authenticated は表も RPC も 42501` / `claim: next_attempt_at とリースを見て取る。同時に呼んでも同じ行は 1 本だけ` / `complete: worker_id が違えば false。redact_after_send で伏せる` / `fail: retryable で回数内は queued と次の時刻、回数切れ・非 retryable は dead` / `fail: redact_after_send の行は、queued に戻すときは伏せず、dead にするとき (非 retryable・回数切れ) は宛先・件名・本文を伏せる。伏せた dead の requeue は 'redacted'` / `fail: p_retryable が NULL なら 22023` / `requeue: dead だけ。伏せ字は 'redacted'` / `dead_counts: 窓が無く、まだ印の無い dead だけを template ごとに数える (1 日前に dead になった行も数える。印の付いた行・suppressed・recipient_deleted・template が ops_ の行は数えない)` / `mark: まだ印の無い dead (数える条件と同じ) に p_alerted_at の印を付け、印を付けた行だけを template ごとに数えて返す。同じ行に 2 回目の mark は 0 行。数える条件に当たらない行 (suppressed など) には付けない` / `unmark: p_alerted_at と同じ印の行だけを NULL に戻して行数を返す (別の時刻の印は残る)。戻した行は次の dead_counts に入る` / `mark / unmark: p_alerted_at が NULL なら 22023` / `requeue: 印のある dead を queued に戻すと dead_alerted_at が NULL になり、もう一度 fail で dead になれば dead_counts に入る` / `CHECK: queued / sent の行に dead_alerted_at を入れる UPDATE は 23514` / `cleanup: sent 7 日・dead 30 日。queued は残る` / `prepare_account_deletion が本人の行を伏せ、queued を dead にする` / `リース中の queued を prepare_account_deletion が dead にしたあと、元の worker の complete は false・fail は 'ignored' で、行は dead (recipient_deleted)・伏せ字のまま` / `prepare_account_deletion (1c): 他人宛の行 (queued・リース中の queued・sent・dead) の件名・本文・HTML・返信先にある本人のアドレスを、大文字小文字を問わずすべて redacted@redacted.invalid にし、status・attempts・next_attempt_at・worker_id・lease_expires_at・idempotency_key・to_email は変えない。戻り値の email_outbox は 1b と 1c の行数の和` / `prepare_account_deletion (1c): アドレスの . や + を任意の文字・繰り返しとして扱わない (本人が del.user+x@example.com のとき、本文の delXuser+x@example.com と del.userrx@example.com は残る)。本人のアドレスを含まない他人宛の行は updated_at も変わらない` / `prepare_account_deletion (1c) で本文を伏せたリース中の queued の行は、元の worker の complete_email_outbox が true で sent になり、本文は伏せたまま` / `cron.job に cleanup-email-outbox` |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` (改) | H の `EMAIL_COLUMNS` に 2 行 (`a.attname ~* 'mail'` に当たる列は `to_email` と `from_email` の 2 つ。`reply_to` は当たらない): `'email_outbox.to_email': '伏せる (送信待ち。queued は dead にする。退会の完了メールは送れたあと・届けられなかったあとに伏せる)'` を「prepare_account_deletion が伏せる」の組に、`'email_outbox.from_email': '伏せない。送信元はアプリのアドレス (EMAIL_FROM・運用メールも同じ) で、利用者のものではない'` を「伏せない (理由つき)」の組に。あわせて D の `EXPECTED_ACTIONS` に `'email_outbox.user_id': 'SET NULL'` を 1 行 (#1714 の D0 が、auth.users を指す外部キーと `EXPECTED_ACTIONS` のキーの集合の一致を確かめるので、足さないと赤になる) |
| `tests/integration/security/account-deletion.test.ts` (改。段 A) | 改: describe `#1175 prepare_account_deletion: 戻り値と冪等` の `REPORT_KEYS` (ソート済みの配列。`Object.keys(first.data).sort()` と `toEqual` で完全一致) の `'email_delivery_logs'` の直後に `'email_outbox'` を、`ALL_ZERO` に `email_outbox: 0` を足す (足さないと 3 つの it が `toEqual` で赤)。足す: `本人宛の email_outbox の行を伏せ、queued は dead (recipient_deleted) にし、件数を email_outbox に返す` / `他人宛の email_outbox の行の本文に本人のアドレスがあれば、その部分だけを伏せて状態は変えず (運営の強制譲渡の新オーナー宛の通知: S-17)、件数を email_outbox に足す` |

## 13. 段分け (同じ WF・同じ worktree。段ごとに 2 枚のレビュー)

| 段 | 内容 | 触るファイル |
|---|---|---|
| A: DB | migration + down (§5)、`database.types.ts` の作り直し (2 か所)、`src/lib/account-export-tables.ts` の `ACCOUNT_EXPORT_EXCLUDED` に `email_outbox` (理由: 送信待ちの運用の記録。招待リンクなどの本文を含み、本人のデータの写しではない)、契約テスト・RLS テスト、`08-cron-batches.md` の pg_cron の数と名前 (§3.0 と §3.1 の注記。9 → 10 つ・`cleanup-email-outbox`。§15.2 の逐語) と `01-data-model.md` の表の一覧 (32. email_outbox → 本書 §5。31 は origin/main で `operator_mfa_backup_codes` (#1176) が使った。マージ時に一覧の末尾の番号が変わっていれば、その番号 + 1)、`docs/design/operator/CLAUDE.md` のファイル一覧に本書の行 (§15.2)、FK テスト H の 2 行 (`to_email`・`from_email`) と D の 1 行 (`email_outbox.user_id`)、退会テストの改 | `supabase/migrations/*`、`supabase/rollbacks/*`、`src/types/database.types.ts`、`packages/shared/src/database.types.ts`、`src/lib/account-export-tables.ts`、`tests/email-outbox-migration-contract.test.ts`、`tests/integration/rls/email-outbox.test.ts`、`tests/integration/security/auth-users-fk-on-delete.test.ts`、`tests/integration/security/account-deletion.test.ts`、`docs/design/operator/08-cron-batches.md`、`docs/design/operator/01-data-model.md`、`docs/design/operator/CLAUDE.md` |
| B: 送信経路・worker・アラート | §6 (outbox.ts・outbox-store.ts・send.ts・route・vercel.json・env.ts・.env.example・ENV_SETUP.md)、`src/__tests__/lib/env.test.ts` の sealed の一覧と `@ts-expect-error` (§12)、`tests/ai-usage-contract.test.ts` の `CRON_ENTRYPOINTS` に 1 行 (§12)、`tests/lib-raw-error-message-scan.test.ts` の `ALLOWED` (§12)、§6.6 (既存の呼び出し元 3 か所・`support-reply-email-status.ts` の JSDoc・お問い合わせの route と文面 `support/contact-admin-notification.ts`)、新しい見張り `tests/email-resend-boundary-scan.test.ts`、§8 (急増の文面の型の絞り込みを含む)、文面 `ops/email-dead-letter.ts`、テスト (§12 の該当)、`08-cron-batches.md` の Vercel Cron の数と名前 (§3.0・§3.2 の注記・§5 の注記。2 → 3 本・`email-outbox`。§15.2 の逐語)、`07-audit-monitoring.md` §8.3 (3 つ目の種類)、`02-api-spec.md` の 732 行付近と 730 行付近の置き換えと §22 の 1 節 (§15.2 の逐語)、`membership/04-email-templates.md` §8 (ラッパの説明を outbox に) と §12.1 (お問い合わせの文面の場所)、`cross/08-legal-compliance.md` §16.2 手順 6 (email_outbox の伏せ方) | `src/lib/emails/{outbox,outbox-store,send}.ts`、`src/lib/emails/send-result.ts` (JSDoc だけ。§6.3)、`src/lib/emails/ops/email-dead-letter.ts`、`src/lib/emails/ops/app-log-error-spike.ts` (型だけ: `scope` と `SCOPE_WORDING` を `AppLogErrorSpikeScope` に。§8.2)、`src/lib/ops-alerts/app-log-error-spike.ts`、`src/app/api/cron/{email-outbox,app-log-alerts}/route.ts`、`src/lib/admin/send-ticket-reply-email.ts`、`src/lib/admin/support-reply-email-status.ts` (JSDoc だけ。§6.6)、`src/app/api/contact/route.ts`、`src/lib/emails/support/contact-admin-notification.ts`、`src/lib/account-deletion-notification.ts`、`vercel.json`、`src/lib/env.ts`、`.env.example`、`ENV_SETUP.md`、`docs/operations/email-domain.md`、`CLAUDE.md` (「メール送信の結果と失敗の記録」の節。§15.2)、テスト (`src/__tests__/lib/emails/{outbox,outbox-store,send}.test.ts`・`src/__tests__/lib/emails/ops/email-dead-letter.test.ts`・`src/__tests__/api/cron/{email-outbox,app-log-alerts}.test.ts`・`src/__tests__/lib/admin/send-ticket-reply-email.test.ts`・`src/__tests__/api/admin/support/ticket-messages.test.ts`・`src/__tests__/api/webhooks/resend.test.ts`・`tests/account-deletion-email.test.ts`・`tests/app-log-error-counts-split-contract.test.ts`・`src/__tests__/lib/env.test.ts`・`tests/ai-usage-contract.test.ts`・`src/__tests__/api/contact.test.ts`・`src/__tests__/api/contact-rate-limit.test.ts`・`src/__tests__/lib/emails/support/contact-admin-notification.test.ts`・`tests/email-resend-boundary-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts`・`src/__tests__/lib/emails/template-names.test.ts`)、設計書 5 冊 (`docs/design/operator/08-cron-batches.md` の Vercel Cron の数と名前・`docs/design/operator/07-audit-monitoring.md` の §8.3・`docs/design/operator/02-api-spec.md` の 730・732 行付近と §22・`docs/design/membership/04-email-templates.md`・`docs/design/cross/08-legal-compliance.md`) |
| C: 画面・API・ログ閲覧 | §9・§10・§11 (email-outbox の lib・route 2 本・page・layout のナビ、logs の `q` と監査)、`07-audit-monitoring.md` §4.1.1 と §8.2 と §16、`02-api-spec.md` の super_admin の 2 節、`03-ui-spec.md`、`cross/04-api-conventions.md`、`09-runbook.md`、テスト (§12 の該当)、`tests/jst-today-source-scan.test.ts` の許可リスト、`tests/admin-mutation-audit-coverage-1571.test.ts` の表 `EXPECTED` に requeue の 1 行、`tests/super-admin-app-logs-query.test.ts` の未知のパラメータの it と `q` の it (§12) | `src/lib/super-admin/{email-outbox,app-logs}.ts`、`src/app/api/super-admin/email-outbox/route.ts`、`src/app/api/super-admin/email-outbox/[id]/requeue/route.ts`、`src/app/api/super-admin/logs/route.ts`、`src/app/super-admin/email-outbox/page.tsx`、`src/app/super-admin/logs/page.tsx`、`src/app/super-admin/layout.tsx`、テスト (`tests/super-admin-logs-route.test.ts`・`tests/super-admin-logs-page.test.tsx`・`tests/super-admin-app-logs-query.test.ts`・`tests/super-admin-email-outbox-route.test.ts`・`tests/super-admin-email-outbox-requeue-route.test.ts`・`tests/super-admin-email-outbox-page.test.tsx`・`tests/integration/security/super-admin-logs.test.ts`・`tests/jst-today-source-scan.test.ts`・`tests/admin-mutation-audit-coverage-1571.test.ts`)、設計書 5 冊 (`docs/design/operator/07-audit-monitoring.md` の §4.1.1・§8.2・§16、`docs/design/operator/02-api-spec.md` の super_admin の 2 節、`docs/design/operator/03-ui-spec.md`、`docs/design/operator/09-runbook.md`、`docs/design/cross/04-api-conventions.md`) |

「触るファイル」に入れない番兵 (中身は変えず、段の終わりに流して緑を確かめる。§15.1 の行のとおり、直すのは番兵が見ている側のファイル):

| 段 | 変えずに流す番兵 |
|---|---|
| A | `tests/account-deletion.test.ts` (`prepare_account_deletion` を偽物で返す。§15.1)、`tests/database-types-migrations-contract.test.ts` (型の作り直しで緑)、`tests/account-export-tables.test.ts` (`ACCOUNT_EXPORT_EXCLUDED` への追加で緑)、`tests/log-cleanup-dau-snapshot-contract.test.ts` (`08-cron-batches.md` の pg_cron の数と名前で緑)、`tests/migration-cron-job-names.test.ts` (§5.4 はジョブ名を文字列の直書きで登録するので「解けない呼び出し」にならない)、`tests/account-deletion-migration-contract.test.ts` (`20261010000100` のファイルとそのロールバックだけを読む。新しい migration の `prepare_account_deletion` は同じ `SECURITY DEFINER`・`SET search_path = ''`・service_role だけの形で写す)、`tests/integration/security/account-delete-route.test.ts` (結合。`email_delivery_logs` に行を仕込んで退会の route を通すが、見るのは応答の本文と `email_delivery_logs` の伏せ字・件数だけで、`prepare_account_deletion` の戻り値のキーも `email_outbox` も見ない。§15.1) |
| B | `tests/log-cleanup-dau-snapshot-contract.test.ts` (Vercel Cron の数と名前)、`tests/cron-secret-contract.test.ts`、`tests/env-source-scan.test.ts`、`tests/email-send-throttle-contract.test.ts` (contact の route は `sendEmail` を呼ぶので送る側のまま。除外の理由も変わらない)、`tests/supabase-service-role-client-scan.test.ts`、`tests/api-raw-error-message-scan.test.ts`、`tests/heavy-unit-test-timeout.test.ts` (§12 の冒頭の読み込み方)、`src/__tests__/lib/membership/exit-notification.test.ts` (§6.6 で `exit-notification.ts` を変えない)、`src/__tests__/lib/admin/support-reply-email-status.test.ts` (JSDoc だけの変更)、`src/__tests__/lib/emails/send-result.test.ts` (`send-result.ts` は JSDoc だけの変更。§15.1)、`src/__tests__/lib/emails/ops/app-log-error-spike.test.ts` と `src/__tests__/lib/ops-alerts/app-log-error-spike.test.ts` (渡す scope は server / client のまま)、`src/__tests__/lib/emails/membership/{family-invite,family-promote,member-left,member-removed}.test.ts` と `src/__tests__/lib/emails/support/ticket-reply.test.ts` (`resend` をモックし、`@/lib/emails/send` からは `EmailEnvelopeSchema` だけを使う)、`src/__tests__/api/null-character-routes.test.ts`・`tests/api-security-cluster.test.ts`・`tests/rate-limit-single-implementation.test.ts` (contact の route を読むが、本文の NULL 文字・レート制限・`@upstash/ratelimit` の import だけを見る)、`tests/ai-consent-provider-inventory.test.ts` (`api.resend.com` が走査に現れなくなるが、陳腐化は見ない。§15.1)、`tests/admin-mutation-audit-1571.test.ts`・`src/__tests__/api/account/delete-missing-env.test.ts` (`sendEmail` を偽物にしている。§15.1)、`vi.mock('@/lib/emails/send', () => ({ … }))` で `sendEmail` を丸ごと偽物にしている (`importOriginal` を使わない) 既存の呼び出し元のテスト 17 本 = `src/__tests__/api/family/{invites/create,leave,members/promote,members/remove,representative-transfer/accept,representative-transfer/propose}.test.ts`・`src/__tests__/api/operator/membership/{family-dissolve,family-transfer,org-dissolve,org-transfer}.test.ts`・`src/__tests__/api/org/{invites/create,leave,members/create,members/remove,owner-transfer/accept,owner-transfer/propose}.test.ts`・`src/__tests__/lib/membership/org-invite.test.ts` (R-19 で呼び出し元のコードを変えず、偽物の `sendEmail` は §6.3 の登録に届かない。§15.1)、`tests/auth/no-login-lockout.test.ts` (ログインの route から import をたどってメールを送るコードに届かない。§15.1)、`tests/ai-consent-enforcement.test.ts` (it `Vercel の cron は、判定を呼ぶ route か、AI へ送らない route だけ`。§15.1)、`tests/integration/rls/ops-alert-state.test.ts` (結合。新しいキー `email_dead_letter` で反応しない。§15.1)。`src/app/api/webhooks/resend/route.ts` は `maskEmailAddress` を `@/lib/emails/send` から読むまま変えない (再エクスポート。§15.1) |
| C | `src/__tests__/api/null-character-routes.test.ts`、`tests/admin-view-audit-1326.test.ts`、`tests/next15-async-request-api-scan.test.ts`、`tests/supabase-service-role-client-scan.test.ts`、`tests/api-raw-error-message-scan.test.ts`、`tests/lib-raw-error-message-scan.test.ts` (段 B で直した `ALLOWED` のまま。段 C の src/lib のファイルは 0 件)、`tests/heavy-unit-test-timeout.test.ts` (§12 の冒頭の読み込み方)、`tests/admin-console-links.test.ts` (ナビの `/super-admin/email-outbox` は段 C の page.tsx で実在する) |

§15.1 が「反応しない見込み。反応したら…」と書く 2 つ (`tests/email-send-throttle-contract.test.ts` の `EXEMPT_EMAIL_SENDERS`・`tests/helpers/ai-consent-enforced-paths.ts` の `noAi`) だけは、反応したときにその行の直し方で直し、そのファイルをその段の「触るファイル」に足す。

段 B が入るまで (段 A だけが本番に入った状態) は、表と関数があるだけで何も使われない (安全)。段 B は migration (段 A) の本番適用の**後**にデプロイする (先にデプロイすると `sendEmail` の INSERT が失敗し、メールが outbox_failed で止まる)。段 C は段 B の後。

## 14. 新設一覧

| 種類 | 名前 |
|---|---|
| テーブル | `public.email_outbox` (列: §5.1 の 27 列。通知の印 `dead_alerted_at` を含む)、CHECK `email_outbox_status_times` / `email_outbox_dead_alerted_only_dead`、索引 `idx_email_outbox_claim` / `idx_email_outbox_status_created` / `idx_email_outbox_dead_at` / `idx_email_outbox_sent_at` / `idx_email_outbox_user_id`、ポリシー `email_outbox_deny_client_access` |
| RPC / 関数 | `claim_email_outbox(TEXT, INTEGER, INTEGER)`、`complete_email_outbox(UUID, TEXT, TEXT)`、`fail_email_outbox(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, INTEGER)`、`requeue_email_outbox(UUID)`、`email_outbox_dead_counts(INTEGER)`、`cleanup_email_outbox()`、`mark_email_outbox_dead_alerted(TIMESTAMPTZ, INTEGER)`、`unmark_email_outbox_dead_alerted(TIMESTAMPTZ)`。改: `prepare_account_deletion(uuid)` (`email_outbox` の段 1b・1c と、その変数 `v_outbox`・`v_outbox_mentions`・`v_email_pattern`。戻り値のキー `email_outbox`。§5.3) |
| pg_cron | `cleanup-email-outbox` (`20 18 * * *`) |
| Vercel Cron / route | `GET /api/cron/email-outbox` (`*/1 * * * *`)、`GET /api/super-admin/email-outbox`、`POST /api/super-admin/email-outbox/[id]/requeue` |
| 画面 | `/super-admin/email-outbox`、ナビ「メール送信」 |
| ファイル (新) | `src/lib/emails/outbox.ts`、`src/lib/emails/outbox-store.ts`、`src/lib/emails/ops/email-dead-letter.ts`、`src/lib/super-admin/email-outbox.ts`、`src/app/api/cron/email-outbox/route.ts`、`src/app/api/super-admin/email-outbox/route.ts`、`src/app/api/super-admin/email-outbox/[id]/requeue/route.ts`、`src/app/super-admin/email-outbox/page.tsx`、`src/lib/emails/support/contact-admin-notification.ts`、migration と down、§12 の新しいテスト 11 本 (`(新)` の行) |
| 関数 (TS) | `resolveEmailOutboxSettings`、`retryDelaySeconds`、`parseClaimedRows`、`isRetryableResendError` (移設)、`createResendTransport`、`processEmailOutbox`、`createOutboxStore`、`normalizeDeadCountRows`、`renderEmailDeadLetterEmail`、`checkEmailDeadLetters` と `unmarkDeadLetters` (app-log-alerts の route 内・export しない)、`renderContactAdminNotificationEmail`、`buildMessageSearchFilter`、`parseEmailOutboxQuery`、`toEmailOutboxListItem`。移設: `maskEmailAddress`、`redactEmailAddresses` (send.ts → outbox.ts。send.ts から再エクスポート) |
| 定数 | `EMAIL_OUTBOX_TABLE`、`EMAIL_OUTBOX_STATUSES`、`EMAIL_OUTBOX_MAX_ATTEMPTS` (+ `_MIN` / `_MAX`)、`EMAIL_OUTBOX_RETRY_DELAYS_SECONDS`、`EMAIL_OUTBOX_BATCH_SIZE` (+ `_MIN` / `_MAX`)、`EMAIL_OUTBOX_LEASE_SECONDS`、`EMAIL_OUTBOX_SEND_INTERVAL_MS`、`EMAIL_OUTBOX_RUN_BUDGET_MS`、`EMAIL_OUTBOX_QUEUED_MAX_AGE_MS`、`SUPER_ADMIN_EMAIL_OUTBOX_PATH`、`OPS_EMAIL_TEMPLATE_PREFIX`、`UNKNOWN_EMAIL_TEMPLATE`、`EMAIL_OUTBOX_ERROR_CODES`、`NON_RELEASING_SEND_ERROR_CODES` (`src/lib/ops-alerts/send-release.ts`。app-log-alerts と backup-freshness の route が import する。#1577 の 8)、`DEAD_LETTER_COUNT_RPC`・`DEAD_LETTER_MARK_RPC`・`DEAD_LETTER_UNMARK_RPC` (app-log-alerts の route 内・export しない)、`SUPPORT_INQUIRIES_PATH` (contact の route 内・export しない)、`EMAIL_DEAD_LETTER_ALERT_KEY`、`EMAIL_DEAD_LETTER_ALERT_THRESHOLD`、`APP_LOGS_SEARCH_MAX_CHARS`、`EMAIL_OUTBOX_LIST_STATUSES`、`EMAIL_OUTBOX_DEFAULT_LIMIT`、`EMAIL_OUTBOX_MAX_LIMIT`、`EMAIL_OUTBOX_REDACTED_EMAIL`、`EMAIL_OUTBOX_ERROR_MESSAGE_MAX_CHARS`、`EMAIL_OUTBOX_LIST_COLUMNS`。改: `APP_LOG_ALERT_COUNT_RPC`・`APP_LOG_ALERT_KEYS` (`src/lib/ops-alerts/app-log-error-spike.ts`。2 キー → 3 キー (`email_dead_letter` を足す)・`APP_LOG_ALERT_COUNT_RPC` は型の注記をやめて `as const satisfies Readonly<Record<AppLogAlertScope, string>>` にし、値をリテラルの型で持つ。§8.2)、`SCOPE_LOG_LABEL` (`src/app/api/cron/app-log-alerts/route.ts` の中・export しない。2 キー → 3 キー (`email_dead_letter: '届けられなかったメール'`)。§8.2) |
| 型 / Zod | `EmailOutboxStatus`、`EmailOutboxSettingEnvName`、`EmailOutboxSettingSources`、`EmailOutboxSettings`、`EmailOutboxClaimedRowSchema` / `EmailOutboxClaimedRow`、`EmailTransportFailure`、`EmailTransportOutcome`、`EmailTransport`、`OutboxFailOutcome`、`OutboxStore`、`OutboxLogger`、`EmailOutboxWorkerDeps`、`EmailOutboxRunOptions`、`EmailOutboxRunSummary`、`AppLogErrorSpikeScope`、`AppLogsSearchSchema`、`EmailOutboxApiRowSchema` / `EmailOutboxApiRow`、`EmailOutboxListItem`、`EmailOutboxListResponse`、`EmailOutboxQuery`、`ParseEmailOutboxQueryResult`、`ContactAdminNotificationVars`、`EmailDeadLetterEmailVars`、`DeadLetterNotice` (app-log-alerts の route 内・export しない)。改: `SendEmailOptions` (+ `userId` / `redactAfterSend`)、`AppLogAlertScope` (3 値)、`AppLogErrorSpikeEmailVars.scope` (`AppLogErrorSpikeScope` に)、`AppLogsQuery` (+ `q`)。意味だけの改 (型・関数・クラスの形は変えず JSDoc だけを直す。`src/lib/emails/send-result.ts`。§6.3): `SendEmailSent` (Resend が受け付けた → 送信待ちに登録した。`id` は Resend のメール ID → `email_outbox.id`・`attempts` は常に 0)、`SendEmailFailed` (「再試行を使い切った」→ 登録の失敗 `outbox_failed`)、`EmailSendError.code` の列挙 (+ `outbox_failed`。`expired` / `recipient_deleted` は行の `last_error_code` だけで `sendEmail` の結果には出ないので足さない)・`EmailSendError.attempts` (`sendEmail` の中で Resend へ送った回数 = 常に 0) |
| 環境変数 | `EMAIL_OUTBOX_MAX_ATTEMPTS`、`EMAIL_OUTBOX_BATCH_SIZE` |
| エラーコード | 新: `outbox_failed` (SendEmailResult)、`expired` / `recipient_deleted` (行の `last_error_code`)、`OP_EMAIL_OUTBOX_NOT_FOUND`、`OP_EMAIL_OUTBOX_NOT_REQUEUEABLE`。既存のコードを新しい定数 `EMAIL_OUTBOX_ERROR_CODES` に集め、行の `last_error_code` にも入れるもの: `suppressed` / `network_error` / `invalid_response` (SendEmailResult のコードとしては origin/main の `src/lib/emails/send.ts` に既にある)。ほかに行の `last_error_code` には Resend のエラーの `name` が入る (§11) |
| 監査の action_type | `super_admin.app_logs.list`、`super_admin.email_outbox.requeue` |
| 運用アラートのキー | `email_dead_letter` |
| 文面の template (render*Email) | `ops_email_dead_letter` (`renderEmailDeadLetterEmail`)、`contact_admin_notification` (`renderContactAdminNotificationEmail`) |

## 15. 追随表 (既存の番兵と他の文書)

### 15.1 既存の番兵 (契約テスト・走査テスト)

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/database-types-migrations-contract.test.ts` | `email_outbox` `claim_email_outbox` `complete_email_outbox` `fail_email_outbox` `requeue_email_outbox` `email_outbox_dead_counts` `cleanup_email_outbox` `mark_email_outbox_dead_alerted` `unmark_email_outbox_dead_alerted` | 新しい表・関数が型に無いと赤 | `database.types.ts` を 2 か所で作り直す | A |
| `tests/account-export-tables.test.ts` | `email_outbox` (`user_id` を持つ) | 分類が無いと赤 | `ACCOUNT_EXPORT_EXCLUDED` に理由つきで足す | A |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` D・H | D: `email_outbox.user_id` (SET NULL。auth.users を指す) / H: `to_email` `from_email` (列名に `mail` を含む列。`reply_to` は当たらない) | D: `EXPECTED_ACTIONS` に無いと赤 (#1714 の D0) / H: 一覧に無いと赤 (2 列とも) | D の `EXPECTED_ACTIONS` に `'email_outbox.user_id': 'SET NULL'` を 1 行、`EMAIL_COLUMNS` に 2 行 (`email_outbox.to_email` = 伏せる、`email_outbox.from_email` = 伏せない理由つき。文言は §12) | A |
| `tests/integration/security/account-deletion.test.ts` (describe `#1175 prepare_account_deletion: 戻り値と冪等`) | `REPORT_KEYS` / `ALL_ZERO` | 戻り値のキーを `Object.keys(…).sort()` と `toEqual` で完全一致比較するので、`email_outbox` が増えると 3 つの it が赤 | `REPORT_KEYS` の `'email_delivery_logs'` の直後に `'email_outbox'`、`ALL_ZERO` に `email_outbox: 0` (§12) | A |
| `tests/log-cleanup-dau-snapshot-contract.test.ts` (`#1125 設計書の「いま」の記述が、木の実物と合っている` の 3 つの it) | migration の `cron.schedule` のジョブ名 / `vercel.json` の `crons` の path の最後 | pg_cron: `08-cron-batches.md` の §3.0 と §3.1 の注記が全部の名前を挙げ、「ジョブは N つ」(§3.0)・「…の N つ」(§3.1 の注記) が実数と同じでないと赤。Vercel Cron: §3.0・§3.2 の注記・§5 の注記が全部の名前を挙げ、「Vercel Cron は…の N 本」(§3.0・§3.2 の注記) が実数と同じでないと赤 | §15.2 の `08-cron-batches.md` の行の逐語どおりに直す。pg_cron は 9 → 10 つ (段 A。「10 つ」は番兵の正規表現 `(\d+) つ` に合わせた書き方)、Vercel Cron は 2 → 3 本 (段 B)。マージ時に origin/main の数が変わっていれば、その数 + 1。§3.2 の表には行を足さない (「この表のほかの 11 本」は変わらない) | A / B |
| `tests/cron-secret-contract.test.ts` 規則 4 | `src/app/api/cron/email-outbox/route.ts` | `requireCronAuth` を await しないと赤 | §6.5 のとおり | B |
| `tests/ai-usage-contract.test.ts` (§6 定期実行。it `定期実行の入口の全数は CRON_ENTRYPOINTS の一覧どおり…`・`定期実行は記録しない…`・`Vercel Cron の route のうち、AI の入口の一覧 … に無いものは、AI へ送るコードに届かない`) | `vercel.json` の `crons` の `path` (`scanCronEntrypoints` が `vercel:<path>` で全部拾う) / `CRON_ENTRYPOINTS` | `vercel.json` に `/api/cron/email-outbox` を足すと、`expect(scanCronEntrypoints()).toEqual(Object.keys(CRON_ENTRYPOINTS).sort())` (完全一致) が赤。足したあとは、route の実在・`consumeAiUsage` 0 件・`reachesAi` が false の検査の対象になる | `CRON_ENTRYPOINTS` に `'vercel:/api/cron/email-outbox': 'メールの送信待ちを送る (AI を使わない)'` を 1 行 (逐語と置き場所は §12)。route と import 先は AI の印を含まないので、残りの 2 つの it は直さずに緑。pg_cron の `cleanup-email-outbox` は `functions/v1/` を呼ばないので行を足さない | B |
| `tests/env-source-scan.test.ts` 4・6・8 | `EMAIL_OUTBOX_MAX_ATTEMPTS` `EMAIL_OUTBOX_BATCH_SIZE` `RESEND_API_KEY` | 一覧・`.env.example`・readOnlyBy に無いと赤 | `env.ts` に 2 つ足す (readOnlyBy = `src/app/api/cron/email-outbox/route.ts`。読み手はこの 1 ファイルだけ: 解釈の `resolveEmailOutboxSettings` は引数で受け取り `process.env` を読まない)。`RESEND_API_KEY` は**変えない** (確定): origin/main の `env.ts` の一覧に `readOnlyBy` 無しで既にあり、読み手は `src/lib/emails/send.ts` と新しい worker の route の 2 つになる (`src/app/api/contact/route.ts` は §6.6 で読まなくなる)。規則 6 の readOnlyBy の検査 (`readers` が 1 ファイルと一致) は readOnlyBy を持つ変数だけが対象なので反応せず、「名前が一覧にある」の検査も通る。worker の route は send.ts と同じ `process.env.RESEND_API_KEY` で読み、規則 5 に合わせて変数名は `logger.warn` にだけ書き、応答 (`{ status: 'not_configured' }`) と例外の文には書かない。readOnlyBy を足さない (足すと読み手が 2 つで赤)。`ADMIN_NOTIFICATION_EMAIL` は contact の route が読むまま (readOnlyBy 無し。変えない)。contact の route の warn は変数名をログにだけ書く (規則 5) | B |
| `src/__tests__/lib/env.test.ts` (it `値を読む場所が決まっている変数 (…) は、check:env のために一覧にあるが、getOptionalEnv では読めない`) | `readOnlyBy` を持つ `ENV_VARS` の `[名前, readOnlyBy]` / `@ts-expect-error getOptionalEnv(…)` / `whenMissing` | `readOnlyBy` を持つ変数の一覧を `toEqual` で完全一致比較するので、`EMAIL_OUTBOX_MAX_ATTEMPTS`・`EMAIL_OUTBOX_BATCH_SIZE` を足すと赤。`whenMissing` が空でも赤。`@ts-expect-error` の行は足さなくても赤にはならないが、2 つが `getOptionalEnv` に渡せないことの型の検査が欠ける | 期待の配列に 2 行 (`EMAIL_OUTBOX_BATCH_SIZE` → `EMAIL_OUTBOX_MAX_ATTEMPTS` の順で `CRON_SECRET_PREVIOUS` の直後)、`typeOnly` に `@ts-expect-error` の 2 組、it 名の一覧に `EMAIL_OUTBOX_*` (逐語は §12)。`whenMissing` は §6.1 の 2 項目の逐語で満たす | B |
| `tests/email-send-throttle-contract.test.ts` | `@/lib/emails/send` の `sendEmail` の呼び出し / `resend` の import・`.emails.send(`・`new Resend(`・`api.resend.com` | worker の route は `send` も `resend` も import せず `src/lib/emails/outbox` 経由で送る (`src/lib/emails` は走査の除外ディレクトリ) ので「送るファイル」に数えられない。contact の route は `api.resend.com` の代わりに `sendEmail` を呼ぶので「送るファイル」のまま (it `走査が機能している` の一覧と、`EXEMPT_EMAIL_SENDERS` の理由「宛先は ADMIN_NOTIFICATION_EMAIL の固定アドレスだけ…」はそのまま成り立つ) | 反応しない見込み。worker の route が反応したら `EXEMPT_EMAIL_SENDERS` に「cron だけが呼ぶ。宛先は表の行」で足す | B |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient` (`@supabase/supabase-js`) | 新しいファイルで直接作らない (`getSupabaseAdmin` だけ) | 反応しない | B / C |
| `tests/app-log-error-counts-split-contract.test.ts` | `APP_LOG_ALERT_COUNT_RPC` `APP_LOG_ALERT_KEYS` (`toEqual` で 2 キー) | 3 つ目の種類で赤 | A-1・A-2 の期待値に `email_dead_letter` (`'email_outbox_dead_counts'`・`EMAIL_DEAD_LETTER_ALERT_KEY`) を足す。A-1 の「migration に定義がある」のループは、新しい migration の `CREATE OR REPLACE FUNCTION public.email_outbox_dead_counts(` で緑 (`as const satisfies` にしても値は同じなので `toEqual` は型に左右されない) | B |
| `src/__tests__/api/cron/app-log-alerts.test.ts` (ハーネスと、応答・RPC・ログのキーを比べる it) | rpc のモックの `想定外の RPC` / 応答の `toEqual` の `client:` / `email_id` / O-1 の RPC の集合 | 3 つ目の種類が `email_outbox_dead_counts` を呼ぶと、モックが例外を投げて全 it が 500。応答に `email_dead_letter` が足されて `toEqual` の 18 か所が赤。O-1 (RPC は 5 つ)・M-6 と K-2 (`outbox_id`) も赤。it の中で rpc のモックを差し替える D-3 (l.413)・D-4 (l.434)・F-6 (l.772) は `beforeEach` のハーネスを通らず、未知の RPC に `scenario.release` を返す (D-3・D-4) か例外を投げる (F-6) ので 500 になって赤。D-4 は `order` の `toEqual` も外れる | §12 のとおり (ハーネスに `deadCounts` / `deadClaim` / `deadMark` / `deadUnmark` と `DEAD_ROWS`、`DEAD_LETTER_QUIET` を 18 か所に、O-1・M-6・K-2 を改。D-3・D-4・F-6 のモックに `email_outbox_dead_counts` の分岐を足し、D-4 の期待の順の末尾に `email_outbox_dead_counts`)。`failedResult` (`validation_error`) で権利を返す F-1・F-3・F-5・E-7・K-8 は §8.3 の規則で緑のまま | B |
| `npx tsc --noEmit` (型検査) | `SCOPE_WORDING: Record<AppLogAlertScope, …>` (`src/lib/emails/ops/app-log-error-spike.ts:55`)・`SCOPE_LOG_LABEL: Record<AppLogAlertScope, string>` (`app-log-alerts/route.ts:104`) | `AppLogAlertScope` が 3 値になると、2 キーの `Record` が `Property 'email_dead_letter' is missing` | 文面は `AppLogErrorSpikeScope` に絞る (§8.2)。route の `SCOPE_LOG_LABEL` は 3 キーにする | B |
| `src/__tests__/lib/emails/template-names.test.ts` | `render\w+Email(` / `template: '…'` | 新しい文面の template が無い・2 つある・名前が重なると赤 | `renderEmailDeadLetterEmail` に `template: 'ops_email_dead_letter',`、`renderContactAdminNotificationEmail` に `template: 'contact_admin_notification',` の行を 1 つずつそのまま書く (§6.6 の正典)。it 名の `email_delivery_logs.template` を `email_outbox.template` に直す (§12) | B |
| `src/__tests__/lib/admin/send-ticket-reply-email.test.ts`・`src/__tests__/api/admin/support/ticket-messages.test.ts` | `email_delivery_logs` | INSERT をやめると赤 | 該当の it を §12 のとおり改 | B |
| `src/__tests__/api/webhooks/resend.test.ts` (`受けた宛先へは送らない (Webhook → sendEmail の通し)`) | 偽物の `fakeAdmin().from` (`email_blacklist` 以外は例外) / `mocks.emailsSend` | `sendEmail` が `email_outbox` に INSERT すると `unexpected table email_outbox`。ほかの宛先で Resend が呼ばれる期待 (`toHaveBeenCalledTimes(1)`) も外れる | §12 のとおり (偽物に `email_outbox` の insert を足し、期待を「送信待ちに登録・Resend は呼ばない」に) | B |
| `tests/api-raw-error-message-scan.test.ts` | `src/app/api` の route の応答の本文 (`NextResponse.json(body)` など) に入る、エラーらしい名前の値の `.message` / `.details` / `.hint`・`String(エラー)`・catch の変数そのもの | 新しい route (worker・email-outbox の 2 本) や contact の route が生のエラー文を本文に入れると赤 | §11 のとおり固定の文だけ。worker は `summary` だけを返し、失敗は `internalError`。contact の route は本文を変えない | 反応しない (B / C) |
| `tests/lib-raw-error-message-scan.test.ts` | `src/lib` のオブジェクトリテラルのプロパティの値に入る、エラーらしい名前の値の `.message` / `.details` / `.hint` (ログの呼び出し・`new XxxError(…)`・`throw` の中は数えない)。許可リスト `ALLOWED` は件数で固定 | 段 B で赤が 2 つ: send.ts の 2 件 (現行の `attemptSend` の `message:`) が outbox.ts へ移り、send.ts は 0 件 (`ALLOWED` の `count: 2` と食い違う)・outbox.ts は 3 件 (許可リストに無い) | §12 のとおり `ALLOWED` の send.ts の項を消し、outbox.ts を `count: 3` と理由で足す。段 C の src/lib のファイルは 0 件 (変えずに流す) | B |
| `src/__tests__/api/null-character-routes.test.ts` | 本文を読む handler | requeue は本文を読まない。contact の `POST` は表に載っていて、本文の読み方を変えない | 反応しない。requeue を本文を読む書き方にしたら表に載せる | B / C |
| `tests/jst-today-source-scan.test.ts` 規則 G | 列の名前をリテラルで書いた `.gte` / `.gt` / `.lte` / `.lt` (`.or(` の中は見ない) | email-outbox の route のカーソルの `.lte('created_at', cursor.created_at)` が 1 件で赤。logs の route の `q` は `.or(` なので数えない (logs の route の `count: 3` は変わらない) | 許可リストに `{ file: 'src/app/api/super-admin/email-outbox/route.ts', rule: 'G', count: 1, reason: 'カーソル (前のページの最後の行の created_at)。暦日ではない' }` を足す | C |
| `tests/admin-view-audit-1326.test.ts` (b) | `admin_audit_logs` `x-forwarded-for` | 直接 INSERT で赤 | `recordAdminAudit` だけを使う | C |
| `tests/admin-mutation-audit-coverage-1571.test.ts` (a)・(b) | `SCANNED_DIRS` (`src/app/api/super-admin` を含む) の route の変更系 (POST / PUT / PATCH / DELETE) の handler / `recordAdminAudit({ … request … })` | (a) 新しい `src/app/api/super-admin/email-outbox/[id]/requeue/route.ts` の `POST` が表 `EXPECTED` に無いと、`expect(Object.keys(actual).sort()).toEqual(Object.keys(EXPECTED).sort())` (完全一致) が赤。`audited` は route ファイルの中で `recordAdminAudit` を呼ばないと赤。(b) `recordAdminAudit` の引数のオブジェクトのリテラルに `request` が無いと赤 | `EXPECTED` に `'src/app/api/super-admin/email-outbox/[id]/requeue/route.ts POST': 'audited'` を 1 行 (置き場所は §12)。requeue と logs の `recordAdminAudit` は §10 のとおり route ファイルの中で、リテラルに `request` を入れて呼ぶ。GET 2 本は変更系でないので (a) の表に足さない | C |
| `tests/next15-async-request-api-scan.test.ts` 規則 1・2 | `createClient(` (`@/lib/supabase/server`) が await の直下か / `src/app` の route.ts の handler の第 2 引数の `params` が `Promise<...>` の型か | requeue の route (`[id]`) で `params` を同期の型で受けるか、`createClient()` を await しないと赤 | §9.2 の handler の形 (`RouteContext = { params: Promise<{ id: string }> }`・`await props.params`・`await createClient()`)。GET 2 本と logs の route も `createClient()` を await の直下で呼ぶ | C |
| `tests/super-admin-logs-route.test.ts`・`tests/integration/security/super-admin-logs.test.ts` | `createClient` のモック (`user_profiles` 以外は失敗) | 監査の INSERT で赤 | `admin_audit_logs` の insert をモックに足す | C |
| `tests/helpers/ai-consent-enforced-paths.ts` | 新しい route | AI に届かず `@/lib/env` も import しない | 反応しない見込み。反応したら `noAi` で載せる | B / C |
| `tests/super-admin-app-logs-query.test.ts` (it `知らないパラメータは無視する`) | `parseAppLogsQuery(params('page=2&per_page=10&sort=asc&q=x'))` の `toEqual({ ok: true, query: { limit: 50, cursor: undefined } })` | §9.1 で `q` が `FILTER_KEYS` の既知の絞り込みになると、結果が `{ q: 'x', limit: 50, cursor: undefined }` になって赤 | §12 のとおり未知のパラメータを `foo=x` に替え、`q` の it と `buildMessageSearchFilter` の it を足す | C |
| `tests/heavy-unit-test-timeout.test.ts` (it `同じ型のファイルは、どれも時間切れを延ばしている…`) | 単体テストのファイルの、字下げした行 (テスト・フックの中) での route の読み込み (`await import('…/route')`) | 新しいテストのファイルが it / フックの中で route を読み込み、時間切れを延ばしていないと赤 | §12 の冒頭のとおり、route はファイルの一番外側で 1 回だけ読み込む (延ばす一覧に足さない) | 反応しない (B / C) |
| `src/__tests__/api/contact.test.ts`・`src/__tests__/api/contact-rate-limit.test.ts` | `vi.stubGlobal('fetch', fetchSpy)` と `fetchSpy` の呼び出し (`api.resend.com` への通知) | contact の通知が `sendEmail` になると `fetchSpy` が呼ばれず、`toHaveBeenCalledTimes(1)`・`(10)` と送信元の期待 (`sentBody()`) が赤 | §12 のとおり `sendEmail` をモックし、期待を `mockSendEmail` と封筒に読み替える | B |
| `src/__tests__/lib/admin/support-reply-email-status.test.ts` | `describeReplyEmailOutcome` の文面と分岐 | `support-reply-email-status.ts` は JSDoc だけを直す (§6.6) | 反応しない (変えずに流す) | B |
| `src/__tests__/lib/emails/send-result.test.ts` | `EmailSendError` の 5 つの引数と持つ値・`isEmailFailure` (`ok: false && !skipped`)・`emailFailureReasons` | `send-result.ts` は JSDoc だけを直し (§6.3)、型・関数・クラスの形も判定も変えない。`outbox_failed` は `ok: false / skipped: false` なので `isEmailFailure` は true のまま | 反応しない (変えずに流す) | B |
| `tests/integration/operator/admin-support-ticket-detail.test.ts` (結合) | 顧客向けの返信の `email.status` が `sent` / `skipped` / `failed` のどれか・後始末の `email_delivery_logs` の削除 | `sent` の意味が「送信待ちに受け付けた」になるだけで値の集合は同じ。後始末の削除は 0 行になるだけ (`email_outbox.user_id` は `ON DELETE SET NULL` で、後始末の `deleteUser` を止めない) | 反応しない (変えずに流す) | B |
| `tests/ai-consent-provider-inventory.test.ts` (it `すべての送信先は、同意を取る AI 事業者か、AI 事業者ではない理由つきの送信先のどれか`) | コード (`src`・`supabase/functions` など。テストを除く) の `https://<host>` / `NON_AI_HOSTS` の `'api.resend.com': 'メールの送信 (Resend)'` (l.43) | §6.6 で `src/app/api/contact/route.ts` の `fetch('https://api.resend.com/emails')` が無くなり、`src/lib/emails/outbox.ts` は SDK (`new Resend`) で送って `https://api.resend.com` を書かないので、走査で `api.resend.com` が見つからなくなる。この番兵は「見つかった送信先が一覧にあるか」だけを見て、一覧の項目が使われているか (陳腐化) は見ないので赤にならない | 反応しない (変えずに流す)。`NON_AI_HOSTS` の `api.resend.com` の項は**消さない** (Resend は SDK 経由で引き続き送信先であり、将来 URL を直書きしたときに理由つきで通るため。陳腐化の検査を足すかは本書の範囲外) | B |
| `src/app/api/webhooks/resend/route.ts` (番兵ではなく `maskEmailAddress` の消費者。`npx tsc --noEmit`) | `import { maskEmailAddress } from '@/lib/emails/send'` (l.21)・`action.addresses.map(maskEmailAddress)` (l.95) | §6.3 で `maskEmailAddress` の本体は `outbox.ts` へ移るが、`send.ts` が `export { maskEmailAddress } from './outbox'` で再エクスポートするので import 先も振る舞いも変わらない (同じ関数) | 反応しない (変えない)。同じく `@/lib/emails/send` から `maskEmailAddress` を読む `src/lib/account-deletion-notification.ts` (l.20) は段 B の触るファイル (`redactAfterSend` の追加) で、import は変えない | B |
| `tests/account-deletion.test.ts` (it `成功のログには user_id もメールアドレスも載せず…、掃除の件数だけを載せる`) | rpc のモックの `prepare_account_deletion: { data: { email_delivery_logs: 1 } }` (l.50)・`expect(serialized).toContain('"email_delivery_logs":1')` (l.216) | `prepare_account_deletion` を偽物で返すので、§5.3 で戻り値に `email_outbox` のキーが増えても、このテストの応答は変わらない | 反応しない (変えずに流す)。戻り値のキーの完全一致は結合テスト `tests/integration/security/account-deletion.test.ts` が見る (上の行・§12) | A |
| `tests/admin-mutation-audit-1571.test.ts`・`src/__tests__/api/account/delete-missing-env.test.ts` | `vi.mock('@/lib/emails/send', …)` (前者 l.69: `sendEmail` を `{ ok: true }` を返す偽物に。後者 l.59: `importOriginal` の本物に `sendEmail` だけを偽物で重ねる) | `sendEmail` を偽物にしているので、§6.3 の登録 (`email_outbox` への INSERT) に届かない。後者は本物の `send.ts` を読み込み、`./outbox` と `@/lib/supabase/server` (このファイルは `importOriginal` の上に重ねてモック済み) を import するが、読み込みだけでは DB に触らない | 反応しない (変えずに流す) | B |
| `tests/auth/no-login-lockout.test.ts` (it `ログインの route から import をたどっても、メールを送るコードに届かない`) | `MAIL_LEAF_PATTERN` (l.162: `from 'resend'`・`api.resend.com`・`process.env.RESEND_API_KEY`) を、`src/app/api/auth/login/route.ts` から import (相対パスと `@/`。`tests/helpers/ai-reach.ts` の `resolveImport` で `src` → ルートの順) をたどって届くファイルに当てる (l.165-176・l.188-189) | 新しい worker の route (`process.env.RESEND_API_KEY`)・`outbox.ts` (`from 'resend'`)・`send.ts` (`process.env.RESEND_API_KEY`。現行から) は印に当たるが、ログインの route からは届かない。origin/main `bffe1b6f` で届くファイルは 14 本 (`src/lib/admin/{audit,client-ip}.ts`・`src/lib/api/errors.ts`・`src/lib/auth/{guarded-login,login-failures,turnstile,turnstile-verify}.ts`・`src/lib/db-logger.ts`・`src/lib/env.ts`・`src/lib/env-required.ts`・`src/lib/rate-limit.ts`・`lib/supabase/server.ts`・`supabase/functions/_shared/log-sanitizer.ts` と route 自身)。このうち本書が変えるのは `src/lib/env.ts` だけで、足すのは §6.1 の 2 項目 (文字列の `description` などで、印の 3 つのどれも書かない)。本書はこの 14 本に import を足さない | 反応しない (変えずに流す)。`src/lib/env.ts` に `process.env.RESEND_API_KEY` を書いたり、届く 14 本から `@/lib/emails/send` / `@/lib/emails/outbox` を import したりすると赤になるので、しない | B |
| `tests/ai-consent-enforcement.test.ts` (it `Vercel の cron は、判定を呼ぶ route か、AI へ送らない route だけ`。l.226-232) | `vercel.json` の `crons` の `path` ごとの `src/app<path>/route.ts` が `reaching` (AI の印 `AI_LEAF_PATTERN` に import をたどって届く route) に入るなら、`ENFORCED_ROUTES` に載っていること | §6.5 で `vercel.json` に `/api/cron/email-outbox` が足され、検査の対象になる。worker の route と、import で届く先 (直接と間接。`@/lib/cron-auth`・`@/lib/api/errors`・`@/lib/db-logger`・`@/lib/emails/suppression`・`@/lib/emails/outbox`・`@/lib/emails/outbox-store`・`@/lib/supabase/server`・`@vercel/functions`・`resend`) は AI の印を含まないので `reaching` に入らず、`ENFORCED_ROUTES` の検査に進まない (`tests/ai-usage-contract.test.ts` の `reachesAi` が false の行と同じ根拠) | 反応しない (変えずに流す)。worker の route が AI の印に届くようにしたら赤 (しない) | B |
| `tests/integration/security/account-delete-route.test.ts` (結合。it `C: ON DELETE の指定が無かった表に行がある利用者でも 200 { success: true } で退会でき…`) | `email_delivery_logs` に行を仕込み (l.127)、`POST /api/account/delete` を通して、応答の本文 (`{ success: true }`)・`email_delivery_logs` の行の `user_id` / `email` の伏せ字と件数 (l.199-202) を見る | §5.3 の `prepare_account_deletion` は `email_delivery_logs` の段を逐語で写すので、この表の伏せ方は変わらない。戻り値のキー (`email_outbox` が増える) も `email_outbox` の行も見ない。サーバーに `RESEND_API_KEY` があれば完了メールが `email_outbox` に 1 行 (`redactAfterSend`) 入るが、この it はその表を数えない | 反応しない (変えずに流す)。戻り値のキーの完全一致は `tests/integration/security/account-deletion.test.ts` が見る (上の行) | A / B |
| `tests/integration/rls/ops-alert-state.test.ts` (結合) | `ops_alert_state` の表と `claim_ops_alert` / `release_ops_alert` / `app_log_error_counts` / `app_log_client_error_counts` の権限 (A-4 は `p.proname IN (…)` の 4 本だけを `toEqual`)・テストのキーは `rls-1157-ops-alert-` で始まる | `alert_key` は `TEXT PRIMARY KEY` で CHECK も列挙の制約も無い (`20261010123500_ops_alert_state.sql` l.50) ので、§8 の新しいキー `email_dead_letter` は表の定義に触らない。本書は 4 本の関数を作り直さない (足すのは別名の `email_outbox_dead_counts`・`mark_email_outbox_dead_alerted`・`unmark_email_outbox_dead_alerted` で、A-4 の `IN (…)` に入らない。`ops_alert_state` の行の消し方 (`release_ops_alert`) も変えない) | 反応しない (変えずに流す) | B |
| 既存の呼び出し元のテスト 17 本 (`vi.mock('@/lib/emails/send', () => ({ … }))` で `sendEmail` を丸ごと偽物にし、`importOriginal` を使わないもの): `src/__tests__/api/family/{invites/create,leave,members/promote,members/remove,representative-transfer/accept,representative-transfer/propose}.test.ts`・`src/__tests__/api/operator/membership/{family-dissolve,family-transfer,org-dissolve,org-transfer}.test.ts`・`src/__tests__/api/org/{invites/create,leave,members/create,members/remove,owner-transfer/accept,owner-transfer/propose}.test.ts`・`src/__tests__/lib/membership/org-invite.test.ts` | `git grep -l "vi.mock('@/lib/emails/send'" origin/main -- src tests` の 24 件から、本書が別の行で扱う 6 本 (`ticket-messages`・`app-log-alerts`・`exit-notification`・`delete-missing-env`・`tests/account-deletion-email.test.ts`・`tests/admin-mutation-audit-1571.test.ts`) とコメントの 1 件 (`src/lib/emails/send-result.ts`) を除いたもの | R-19 で呼び出し元のコードを変えず、`sendEmail` の結果の型の形も変えない (§6.3)。偽物の `sendEmail` は §6.3 の登録 (`email_outbox` への INSERT) に届かない | 反応しない (変えずに流す) | B |

### 15.2 他の文書への追随

| 文書 | 直すこと | 段 |
|---|---|---|
| `docs/design/operator/CLAUDE.md` | ファイル一覧に `10-logs-and-mail-retry.md` の行 (担当: email_outbox / worker / dead の通知 / ログ閲覧の検索と監査。要件 03 §5.3 §22.9 §15) | A |
| `docs/design/operator/01-data-model.md` | §3 の一覧の末尾に `32. email_outbox (正本は 10-logs-and-mail-retry.md §5)` (31 は origin/main で `operator_mfa_backup_codes` (#1176) が使った。マージ時に一覧の末尾の番号が変わっていれば、その番号 + 1)。§3.19 に「新しい書き込みは email_outbox。email_delivery_logs は残すが書かない (#1193)」 | A |
| `docs/design/operator/08-cron-batches.md` | 数は origin/main の実数 (pg_cron 9 つ・Vercel Cron 2 本) に 1 を足した値。実数は origin/main `36c926ad` (2026-10-16 01:02 JST) で数えた: pg_cron は `git grep -n "cron.schedule(" origin/main -- supabase/migrations` の登録の呼び出しが 9 つ (`calculate-segment-stats` (`20261009100000`)・`cleanup-old-app-logs` と `snapshot-daily-active-users` (`20261010150000`)・`cleanup-stale-login-failures-and-grant-claims` (`20261011070000`)・`calculate-segment-stats-finalize-retry` (`20261011120000`)・`update-org-challenge-progress` (`20261014100100`)・`requeue-stale-meal-image-jobs` と `process-pending-meal-image-jobs` (`20261015180000`)・`purge-hidden-content` (`20261016100000`))、Vercel Cron は `vercel.json` の `crons` の `path` が 2 つ (`process-menu-queue`・`app-log-alerts`)。いまの `08-cron-batches.md` §3.0 (「9 つ」・「残りの 7 つ」) と §3.1 の注記 (9 つの名前) とも一致する。段 A の着手前と、段 A・段 B のマージ直前に、同じ方法で origin/main を数え直し、増えていれば、その実数 + 1 (`tests/log-cleanup-dau-snapshot-contract.test.ts` が突き合わせる)。**段 A (pg_cron)**: §3.0 の本文「いま、このリポジトリの migration が pg_cron に登録しているジョブは 9 つある。」を「10 つある。」に、続く「残りの 7 つ `calculate-segment-stats`・…・`process-pending-meal-image-jobs`・`purge-hidden-content` は」を「残りの 8 つ `calculate-segment-stats`・…・`purge-hidden-content`・`cleanup-email-outbox` は」に。§3.0 の「そのほか」の箇条書きの `purge-hidden-content` の行の後ろに 1 行「そのほか、migration `<番号>_email_outbox.sql` (#1193) が、ジョブ `cleanup-email-outbox` を毎日 03:20 JST (`20 18 * * *` UTC) に登録している。`SELECT public.cleanup_email_outbox();` を呼び、`email_outbox` の sent を 7 日・dead を 30 日で消す (queued は消さない)。関数の `EXECUTE` は `service_role` だけ。ロールバックは `supabase/rollbacks/<番号>_email_outbox.down.sql`。詳しくは `10-logs-and-mail-retry.md` §5」(`<番号>` はマージ時に確定した値)。§3.1 の注記「…`process-pending-meal-image-jobs`・`purge-hidden-content` の 9 つ (§3.0)。」を「…`process-pending-meal-image-jobs`・`purge-hidden-content`・`cleanup-email-outbox` の 10 つ (§3.0)。」に。§3.0.3 の確認の SQL の `jobname IN (…)` に `'cleanup-email-outbox'` を足す (任意)。**段 B (Vercel Cron)**: §3.0 の本文「`vercel.json` に登録されている Vercel Cron は `process-menu-queue` と `app-log-alerts` (§3.2 の `app_log_alerts`。#1157) の 2 本である。」を「`vercel.json` に登録されている Vercel Cron は `process-menu-queue`・`app-log-alerts` (§3.2 の `app_log_alerts`。#1157)・`email-outbox` (毎分。メールの送信待ちを送る worker。#1193・`10-logs-and-mail-retry.md` §6.5) の 3 本である。」に。§3.2 の注記「`vercel.json` に登録されている Vercel Cron は `process-menu-queue` と `app-log-alerts` (この表の `app_log_alerts`。#1157) の 2 本。」を「…`process-menu-queue`・`app-log-alerts` (この表の `app_log_alerts`。#1157)・`email-outbox` (この表に無い。#1193) の 3 本。」に (「この表のほかの 11 本」は変えない。表に行を足さない)。§5 の注記「`vercel.json` にあるのは `process-menu-queue` と `app-log-alerts` だけで」を「`vercel.json` にあるのは `process-menu-queue`・`app-log-alerts`・`email-outbox` だけで」に | A / B |
| `docs/design/operator/07-audit-monitoring.md` | **段 B**: §8.3 に 3 つ目の種類 (窓を持たず、まだ知らせていない dead を数え、知らせた行に印 `dead_alerted_at`。送れずに権利を返すときは印も外す) と「権利を返す条件」。**段 C**: §4.1.1 に 2 つの action_type、§8.2 に `q` と監査、§16 の #1157 の行を現在形に | B / C |
| `docs/design/operator/02-api-spec.md` | **段 B**: `POST /api/support/tickets/{id}/messages` の節の 730 行付近 (origin/main `36c926ad`。行番号は目安で、置き換えは引用した文で探す)の 1 文「`email.status` は `sent` (送信済み) / `skipped` (メール送信の設定が無く未送信) / `failed` (宛先を取得できない、または送信エラー)。」を「`email.status` は `sent` (送信待ちに受け付けた。送るのは worker) / `skipped` (メール送信の設定が無く未送信) / `failed` (宛先を取得できない、または送信待ちに登録できない・宛先停止リスト・文面の不備)。登録したあとの送信の失敗は `email` に出ず、届けられなければ dead の通知と `/super-admin/email-outbox` で運営が扱う (`10-logs-and-mail-retry.md` §6.6・§7.2)。」に (続く `email.reason` の文はそのまま)。732 行付近の「宛先は `auth.admin.getUserById(ticket.user_id)` で取得し、送信できたら `email_delivery_logs` (`template = 'support_ticket_reply'`) に残す。」を「宛先は `auth.admin.getUserById(ticket.user_id)` で取得し、`sendEmail` で送信待ち (`email_outbox`・`template = 'support_ticket_reply'`) に登録する (`email_delivery_logs` には書かない。#1193)。」に (続く返信先の文はそのまま)。§22 Cron API の末尾に節 `### GET /api/cron/email-outbox` (本文: 「メールの送信待ちを送る worker (毎分。Vercel Cron。#1193)。処理・応答・環境変数は `10-logs-and-mail-retry.md` §6.5。**認証**: `CRON_SECRET` ヘッダー」)。**段 C**: super_admin の API の節の並びに `### GET /api/super-admin/email-outbox` と `### POST /api/super-admin/email-outbox/{id}/requeue` の 2 節 (本文: 「super_admin だけ。I/O・エラー・監査は `10-logs-and-mail-retry.md` §9.2・§10・§11」)。`POST /api/webhooks/resend` の節の `email_delivery_logs 更新` は #1577 の 5 の扱い (本書は触れない) | B / C |
| `docs/design/operator/03-ui-spec.md` | super_admin 専用のナビに「メール送信」(`/super-admin/email-outbox`) | C |
| `docs/design/operator/09-runbook.md` | §5 に「届けられなかったメールの再送 (画面 → 再送。伏せ字の行は招待などを出し直す)」 | C |
| `docs/design/cross/04-api-conventions.md` | §4.2 OP 系に `OP_EMAIL_OUTBOX_NOT_FOUND` (404)・`OP_EMAIL_OUTBOX_NOT_REQUEUEABLE` (409) を `[NEW]` で | C |
| `docs/design/cross/08-legal-compliance.md` | §16.2 手順 4 に `email_outbox` の伏せ字 (本人の行は宛先・件名・本文を伏せ、queued は dead。他人宛の行は件名・本文・返信先の中の本人のアドレスの部分だけを伏せ、状態は変えない。本書 §5.3 の 1b・1c)、手順 6 に「完了メールは `email_outbox` に `redact_after_send` で登録し、送れたとき (sent)・届けられなかったとき (dead) に宛先・件名・本文を伏せる。宛先が停止リストに載っていれば行を作らない」。§16.3 の表に `email_outbox.to_email` (伏せる) と `email_outbox.from_email` (伏せない。アプリの送信元) の行 | B |
| `docs/design/membership/04-email-templates.md` §8・§12.1 | §8: 「Resend 送信ラッパ」の説明を「送信待ちへの登録 (送るのは worker)」に。再試行の記述を本書 §6.1 へのリンクに。見本の JSDoc の結果の一覧 (「送れた: `{ ok: true, id, attempts, … }`」「送れなかった: …再試行を使い切った…」) を「送信待ちに登録した: `{ ok: true, id (= email_outbox.id), attempts: 0, … }`」「送れなかった: 文面の不備 `invalid_envelope`・宛先停止リスト `suppressed`・登録の失敗 `outbox_failed`」に。§12.1 の表の行「お問い合わせの受付、サポートチケットへの返信」の場所に `src/lib/emails/support/contact-admin-notification.ts` (お問い合わせの管理者通知の文面。本書 §6.6) を足す | B |
| `src/lib/emails/send-result.ts` の JSDoc (結果の型の説明。形は変えない) | `SendEmailSent` の説明「Resend が受け付けた」を「送信待ち (`email_outbox`) に登録した (送るのは worker)」に・`id` の「Resend のメール ID」を「`email_outbox.id` (受け付けの ID)」に・`attempts` を「`sendEmail` の中で Resend へ送った回数 (常に 0)」に。`EmailSendError.code` の列挙に `outbox_failed` (送信待ちへの登録の失敗) を足す・`EmailSendError.attempts` も同じく常に 0。`SendEmailFailed` の説明の「再試行を使い切った」を「送信待ちに登録できなかった (`outbox_failed`)」に。`isEmailFailure` / `emailFailureReasons` の説明は変えない (本書 §6.3) | B |
| `CLAUDE.md` 「メール送信の結果と失敗の記録」 | 1 行目の「メールは … `sendEmail(envelope)` で送る」を「`sendEmail(envelope)` は送信待ち (`email_outbox`) に登録し、送るのは worker (`/api/cron/email-outbox`)」に。「失敗 (再試行を使い切った・400/403 など) …残すのは…Resend のエラーコード・送った回数」を「登録の時点の失敗 (文面の不備・宛先停止リスト・登録の失敗 `outbox_failed`) と `RESEND_API_KEY` 未設定は `sendEmail` が記録し、送信の失敗は worker が行 (`last_error_code`) と app_logs に残す」に。「429 / 5xx / 通信エラーだけ、500ms・1s・2s の指数バックオフで最大 3 回再試行…」を本書 §6.1 の回数と間隔 (worker の再試行・`EMAIL_OUTBOX_MAX_ATTEMPTS`) と、dead の通知・`/super-admin/email-outbox` の再送への案内に。`isEmailFailure` と `skipped` の扱い・`template` の決まり・モックの段落はそのまま | B |
| `ENV_SETUP.md`・`.env.example`・`docs/operations/email-domain.md` | `EMAIL_OUTBOX_MAX_ATTEMPTS` / `EMAIL_OUTBOX_BATCH_SIZE` の行。`OPS_ALERT_EMAIL` の節に「届けられなかったメールの通知」と `/super-admin/email-outbox`。`email-domain.md` の本番の確認の行 (204 行付近「本番のお問い合わせフォームから送ると、`ADMIN_NOTIFICATION_EMAIL` に通知が届く…」) の後ろに「通知も送信待ち (`email_outbox`) を通り、1 分ほどで届く。届かなければ `/super-admin/email-outbox` の届けられなかった行を見る」を足す | B |
| Issue #1577 | 7 (suppressed を warn に) は本書の範囲外のまま。8 は §8.3 で解消したことをオーケストレーターが記す | – |

## 16. 未解決事項

- Resend の Webhook (`email.delivered` / `email.bounced`) で `email_outbox.resend_message_id` の行に配信の結果を書くか (本書は書かない。#1577 の 5 で要件書・`02-api-spec.md` の記述を実装に合わせ、配信の結果の記録は「実装しない (将来の検討)」と明記した)。
- `OPS_ALERT_EMAIL` 未設定の本番で dead が溜まったとき、設定するまでの間に気づく手段は画面だけ。オーナー作業 (#1157 のコメント) が済むまでの間の扱い。(設定したあとは、未設定の間に dead になった行 (保持の 30 日以内) も印が無いので、最初の回の 1 通にまとめて入る。)
- `exit-notification.ts` 等の「変えない」12 か所に `userId` を渡すか (本書では渡さない: §6.6。伏せ字は宛先の一致 (1b) と本文などの照合 (1c) で足りる。渡すと `user_id` でも引け、画面の監査の `target_type` が `user` になる。必要になったら別の Issue で)。
- dead の一括再送 (「表示中の全部を再送」) は作らない。必要になったら API に `POST /api/super-admin/email-outbox/requeue` (id の配列) を足す。
- サポートのチケットの画面に、返信メールの送信待ちの状態 (届けられなかった dead) を出すか (本書は出さない: §6.6・R-24。出すなら `email_outbox` にチケットとの紐づけ (列) と、support / admin ロールが自分のチケットの行の状態だけを読む経路が要る)。
- お問い合わせの管理者通知に、問い合わせた人のアドレスの全体を戻すか (本書はマスクする: §6.6・R-23。アカウントのアドレスで問い合わせた分は 1c が本文から伏せるが、ログインした人が別の連絡先アドレスで問い合わせた分は引けない。戻すなら、その行を問い合わせた人の `user_id` でも引ける形 (例: `userId` を渡して 1b の照合に当てる。ただし 1b は宛先 (運営のアドレス) ごと伏せ、queued を dead にする) を決める必要がある)。
- 送信済み (sent) の行の件名・本文を、送れた時点で消すか (本書は 7 日残す: §5.2 (6))。sent の本文は画面も API も返さず、Resend 側にも記録があるので、`complete_email_outbox` で全行の件名・本文を伏せれば、退会の 1c が引く対象は queued / dead だけになる。本書では、伏せ字の判定 (`to_email` が伏せ字か) と画面の表示を変えないため見送る。
