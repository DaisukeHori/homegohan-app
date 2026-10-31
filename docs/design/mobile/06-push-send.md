# mobile/ サーバーからの Push 通知の送信 — 送信待ち (push_outbox)・worker・receipt (#1136)

版: v1.4 (2026-10-16 #1598 に合わせた通知の行き先の改定)
改定履歴: v1.0 2026-10-16 新設 / v1.1 2026-10-16 発火元の書き手を全数で列挙し、積む行を「2 日以上の AI の生成」に絞った (§3.2.1)。鍵が無い環境でも掃除 (24 時間で expired) を回す (R-12) / v1.2 2026-10-16 形の違う token・別の Expo プロジェクトの token が同じ要求のほかの行を巻き込まない (R-24)。失敗の通知の本文は理由を約束しない (§3.2)。番兵の追随 (§13.1) を実際の挙動に合わせた / v1.3 2026-10-16 エラー表 (§9) に時間切れと receipt の error (DeviceNotRegistered / ほか) の行を足し、receipt の `InvalidCredentials` を dead と書いていた箇所 (§1.2・§13.2・§14) を記録に直した。§1.2 のアプリのファイルの所在を `apps/mobile/src/…` に直した / v1.4 2026-10-16 #1598 でネイティブの週の画面を削除したので、献立の通知の行き先を `/menus/weekly` から献立のタブの `/menus` (`MENUS_TAB_PATH`) に改め、`resolveNotificationHref` が同じ値に解決することを番兵の行 (§13.1) に書いた (§3.2・§3.3・§4.2・§6.2・§12・§13.1・§14)。削除した画面を名指しする行に削除の注記を足した (§2・§3.2.1)

## 0. 位置づけと分冊判定

要件の正本は Issue #1136 の本文とコメント (コメントは閉じたときの記録の 1 件で、要件を足していない)。前提は、ローンチ前で利用者ゼロ (正しい形で作る) であることと、本番の DB に触らずに設計すること。本書は、クライアントが集めて `user_push_tokens` に保存している Expo の push token に対して、**サーバーから通知を送る経路が無い** (Issue の「片肺」) を解消する。決めるのは次の 6 点で、Sonnet 5.5 の実装者が手を止めずに実装できる粒度まで展開する。

| 決めること | 本書の決定 (要約) | 詳細 |
|---|---|---|
| 何を Push で送るか (種類の全列挙・発火元・文面・遷移先・受け取り設定・夜間) | 種類 (kind) の一覧を `packages/shared` の定数にし、**最初に出すのは献立の生成の結果 2 種** (`weekly_menu_completed` / `weekly_menu_failed`。発火元は `weekly_menu_requests.status` が completed / failed になったときの DB トリガー。積むのは `target_slots` が 2 日以上にまたがる AI の生成だけで、利用者の中止・止まった行の掃除・1 食 / 1 日の生成・手動の追加には積まない。書き手の全数は §3.2.1)。`03-push-notification.md` §3.4 の 7 種・お知らせ・メンバーシップの通知は**後回し** (発火元の機能が未実装、またはアプリに行き先の画面が無い) | §3.2 §6.2 |
| 送信の経路 (Expo Push API を呼ぶ場所・送信待ちの表・再試行・receipt・レート) | **メールの送信待ち (`operator/10-logs-and-mail-retry.md`) と同じ形**: 表 `push_outbox` (1 行 = 1 端末 (token) × 1 通知) に積み、**Vercel Cron が毎分呼ぶ `GET /api/cron/push-outbox`** (Node) が Expo Push API を `fetch` で呼ぶ。Edge Function `notify-push` は作らない。一時的な失敗は 1 分 → 5 分 → 15 分で最大 3 回。形の違う token は送る前に弾き、Expo が要求ごと拒んだ塊は 1 件ずつ送り直す (1 行の失敗でほかの利用者の行を巻き込まない)。Expo の ticket と **receipt (15 分後に確認)** を行に記録し、`DeviceNotRegistered` ならその端末の `user_push_tokens` の行を消す (送信待ちの行は FK の CASCADE で消える) | §4 §5 §6 |
| 秘密 (Expo のアクセストークン) の置き場と未設定時の動き | Vercel の環境変数 `EXPO_ACCESS_TOKEN` (値を読むのは worker の route 1 か所)。Expo の「Enhanced push security」を ON にしてトークンを必須にする (ON はオーナー作業)。**未設定なら worker は送らず warn を残し、掃除だけをする** (24 時間を超えた queued を `expired` の dead にし、sent / dead を期限で消す。行は増え続けない) | §5.2 (8) §6.1 §6.6 |
| 同意 (#1442 / 13a)・退会・凍結・メンテナンス中 | 送る直前に worker が判定する: 凍結中 (`isAccountFrozen`) は送らない (`account_frozen`)、`LEGAL_CONSENT_ENFORCE=on` で現行の規約に未同意なら送らない (`consent_outdated`)、退会は `user_id` の FK (CASCADE) で行ごと消える、メンテナンス中 (`maintenance_mode`) は worker が何も送らず次の回に回す | §6.3 §7.1 |
| 監査とログ・運営からの一斉送信 | `app_logs` (`createLogger('cron/push-outbox')`) に回ごとの件数と、送れなかった行の理由 (kind・利用者 ID・token の末尾 4 文字) を残す。文面・token の全体は残さない。**運営からの一斉送信 (お知らせの Push を含む) は本書の範囲外** (作らない。運営の操作が無いので `admin_audit_logs` にも書かない) | §8 |
| テスト | Expo の API は `fetch` のモック (単体)・結合は実 DB で RPC とトリガー・機械検査 = 既存の番兵の追随 + 新しい見張り 2 本 (Expo を呼ぶのは 1 ファイルだけ / 種類の行き先がアプリの画面にある) | §10 §13 |

**分冊判定 (相 1 で実施)**: 目安 3 つのうち、本書 ≈ 1,500 行 (800 行超) と、共有面 2 つ以上 (`user_push_tokens` (claim / release / アプリのログアウトと共有)・`vercel.json` と `src/lib/env.ts` (cron と環境変数の一覧)) に当たる。消費先は 1 つ (`weekly_menu_requests` のトリガー)。それでも **1 冊にする**。理由: (a) 核 (表・RPC・worker) と配線 (発火元) は `enqueue_push_notification` の 1 本の RPC で結ばれ、第 1 段の発火元は DB トリガー 1 つで、配線を別冊にしても参照する契約は本書の RPC と同じになる。(b) 後回しの種類は、本書の種類の定数 (`PUSH_NOTIFICATION_KINDS`) に 1 行足して文面と発火元を足すだけで、冊を分ける大きさにならない。(c) 実装は §11 の 3 段 (A: DB / B: worker と環境変数 / C: 他の設計書の追随) に分け、段ごとに 2 枚のレビューを通す。

規約: `docs/design/CLAUDE.md` (章構成・snake_case・RLS 厳格化・監査ログ必須) と `docs/design/mobile/CLAUDE.md` に従う。メールの送信待ちの設計 (`operator/10-logs-and-mail-retry.md`) と形をそろえる (表の列・RPC の名前・権限・worker の骨格)。

## 1. 目的・スコープ

### 1.1 解決すること

- サーバーから Push 通知を送る経路が無い (#1136): アプリ (`apps/mobile/src/lib/pushNotifications.ts` の `registerAndSaveExpoPushToken`) は token を `user_push_tokens` に保存し、claim (#1599 / #1636) と release で行の所有を守っているが、**その token に送るコードが 0 件** (`exp.host` / `sendPushNotifications` / `notify-push` のどれも実コードに無い。`supabase/functions` に `notify-push` も `notify-email` も無い)。
- 設計書の食い違い: `03-push-notification.md` §3.9・`00-architecture.md`・`family/04-meal-request-flow.md` §6.2・`operator/06-ai-llm.md` §8 の表・`mobile/05-auth-session.md` は Edge Function `notify-push` を前提に書いている。本書で経路を確定し、追随表 (§13.2) で直す。

### 1.2 対象外 (本書では決めない・変えない)

- **運営からの一斉送信** (お知らせ `announcements` の Push を含む) は作らない。作るときは、運営の操作として `admin_audit_logs` と、送る相手の数え方 (全利用者 × 端末) を別の設計で決める。
- **種類ごとの受け取り設定** (`03` §3.6 の `notification_preferences.preferences` JSONB・`PATCH /api/notification-preferences` の拡張・アプリの設定画面 `app/settings/notifications.tsx`) は作らない。本書は既存の全体の on/off (`notification_preferences.notifications_enabled`) だけを見る (健康記録の設定画面の「通知」= `enabled` は見ない。§14)。種類ごとの設定を足すときは §6.3 の `decideEligibility` に 1 つの判定を足す。
- **バッジ** (`03` §3.5 のサーバー側の計算) は付けない (ペイロードに `badge` を入れない)。未読の数え方の元 (`family_meal_requests` / `user_notifications`) が実装に無い。
- `user_push_tokens` の列の追加 (`03` §3.2 の `organization_id` / `device_model` / `os_version` / `app_version`) はしない (本書の送信に要らない)。
- `03` §4 の表 `pending_push_notifications` は**作らない** (Quiet Hours の延期は `push_outbox.next_attempt_at` で表す。§6.3)。Edge Function `supabase/functions/notify-push` も作らない。
- Android の FCM の資格情報 (EAS の FCM V1 サービスアカウント) の登録はオーナー作業で、本書の外 (§14)。未登録の間は Android の端末へは届かず (Expo の `InvalidCredentials`。receipt で返れば行は sent のまま `receipt_status = 'error'` の記録と warn、ticket で返れば dead)、iOS には届く。
- モバイルアプリのコードは変えない (通知の受け取りと行き先の解決は `apps/mobile/src/components/NotificationRouter.tsx` と `apps/mobile/src/lib/notificationRoute.ts` (#1049 F7-11) がすでにある)。
- 届けられなかった Push を運用メールで知らせる仕組み (`app-log-alerts` の 4 つ目の種類) は作らない (§14)。
- メールの送信待ち (`email_outbox`) の表・RPC・worker には触れない (別の設計。実装の前後は問わない)。

### 1.3 用語

| 語 | 意味 |
|---|---|
| 種類 (kind) | 通知の種類。`PUSH_NOTIFICATION_KINDS` の値 (`weekly_menu_completed` など)。文面・行き先・夜間の扱いは種類ごとに決まる |
| 送信待ち (queued) | `push_outbox.status = 'queued'`。worker がまだ Expo に渡していない、または再試行・延期を待っている |
| 送信済み (sent) | Expo が ticket `ok` で受け付けた (`receipt_id` あり)。端末に届いたかどうかは receipt で分かる |
| 届けられなかった (dead) | 再試行を使い切った、直らない失敗、または送る条件を満たさなかった (凍結・未同意・設定 off・期限切れ) 行 |
| ticket | Expo Push API の送信の応答。メッセージごとに `ok` (receipt の ID) か `error` |
| receipt | Expo が APNs / FCM に渡した結果。送信の約 15 分後から取れ、24 時間で消える |
| worker | `GET /api/cron/push-outbox` (Vercel Cron が 1 分おきに呼ぶ) |
| 端末の行 | `user_push_tokens` の 1 行 (利用者 × token)。送信待ちの行は `push_token_id` でこれを指す |

## 2. 関連要件と現行の事実

- 要件: `docs/requirements/01-family-management.md` §15.3 / §15.4 / §15.7。Issue #1136 (本件)・#1038 (token の保存と削除)・#1599 / #1636 (claim の所有の証明・release)・#1442 (同意ゲート)・#1193 (メールの送信待ち。形の手本)。
- 現行 (origin/main 2026-10-16):
  - `user_push_tokens`: `id` / `user_id` (FK auth.users ON DELETE CASCADE) / `expo_push_token` / `platform` / `device_name` / `install_secret_hash` / `created_at` / `updated_at` (`packages/shared/src/database.types.ts`。初版 `20251126124224_create_meal_planner_tables.sql`、`20261016163600_user_push_tokens_install_secret.sql` が列と索引 `idx_user_push_tokens_expo_push_token` を追加)。UNIQUE (user_id, expo_push_token) はアプリの upsert (`onConflict: 'user_id,expo_push_token'`) が前提にする。RLS は本人の行だけ (`select_own_push_tokens`・`insert_own_push_tokens`・`user can manage own` など) と `service_role can read`。`expo_push_token` に形・長さの CHECK は無く、アプリ (`apps/mobile/src/lib/pushNotifications.ts` の upsert) が直接書くので、認証済みの利用者は自分の行に任意の文字列や別の Expo プロジェクトの token を書ける。形の判定 `isExpoPushToken` (`src/lib/push-tokens.ts`。上限 `MAX_EXPO_PUSH_TOKEN_LENGTH` = 256 文字) は claim / release の API だけが使う。本番の行数は 0 (2026-10-16 読み取り)。
  - 行を消す経路 (既存): アプリのログアウト (`apps/mobile/src/lib/signOut.ts`)、`POST /api/push-tokens/claim` (同じ端末の前の利用者の行)、`POST /api/push-tokens/release` (セッション無し)、退会 (FK の CASCADE)。本書は 5 つ目 (`DeviceNotRegistered`) を足す。退会の API が 401 を返したときのログアウトで行が残りうる件 (#1706) は、#1710 で直った (`signOut.ts` の `unregisterPushTokenOrRecordRelease`: 行の削除が失敗・0 件なら、端末の値を消す前に release の宛先を控え、あとの `SIGNED_OUT` の release が行を消す)。本書はこの経路を変えない。
  - `notification_preferences`: `notifications_enabled` (NOT NULL・既定 true。`GET/PATCH /api/notification-preferences` が読み書きし、アプリの設定タブと Web の設定画面が見せる)・`quiet_hours_start` / `quiet_hours_end` (time・既定 22:00 / 07:00) と `enabled`・`morning_reminder_*`・`evening_reminder_*`・`vacation_mode` (健康記録の通知設定。`GET/PUT /api/health/notifications/preferences` が読み書きし、健康記録の設定画面 (Web の `src/app/(main)/health/settings/page.tsx`。モバイルのネイティブの `apps/mobile/app/health/settings.tsx` は、通常の操作で届かない画面として 2026-10-16 に削除した。#1598) が「通知」・夜間の時刻・朝夕のリマインダーとして見せる。どれも送るコードは無い)。`preferences` JSONB は無い (本番も同じ)。`user_profiles` に `timezone` 列は無い。
  - 献立の生成: `weekly_menu_requests` (`status` 既定 `pending`。本番の実績の値は `completed` / `failed`)。この表は献立の生成の依頼のほか、1 食・1 日の生成と作り直し・栄養分析からの 1 食の変更・手動の 1 件追加 (AI を通らない) にも使われ、`completed` / `failed` を書く経路は 8 つある (全数は §3.2.1)。`mode` は作る route が `'v4'` / `'v5'` (エンジン名) で上書きするので、依頼の種類を見分ける列にならない。見分けられるのは `target_slots` (`[{ date, meal_type 又は mealType, … }]`。作る経路のすべてが `date` を入れる) の日数と、こちらで書いた `error_message` の定型の文 (`supabase/functions/_shared/stored-failure-messages.ts`)。書き手は service_role と、SECURITY DEFINER の `claim_menu_request` (`20261007160400_claim_menu_request_lease.sql`)。
  - 同意: `user_profiles.terms_version_accepted` / `privacy_version_accepted` と `hasAcceptedCurrentLegalDocuments` (`packages/shared/src/legal-versions.ts`)。強制の判定は `lib/legal-consent.ts` の `isLegalConsentEnforced()` (環境変数 `LEGAL_CONSENT_ENFORCE` を読むのはこのファイルだけ)。凍結: `user_profiles.frozen_at` / `unban_at` と `isAccountFrozen` (`src/lib/auth/frozen.ts`)。
  - cron の骨格: `src/app/api/cron/app-log-alerts/route.ts` (`requireCronAuth`・`runtime = 'nodejs'`・`fetchCache = 'force-no-store'`・`maxDuration = 60`。以前あった `waitUntil` の延命は #1922 48fc47bf で外した。ログの保存の完了は db-logger が待つ (#1913))。`vercel.json` の `crons` は `process-menu-queue` (毎分) と `app-log-alerts` (15 分おき) の 2 本。メンテナンス中も `/api/cron` は通る (`src/lib/maintenance-mode.ts` の `isMaintenanceExemptPath`)。同意ゲートの許可リストにも `/api/cron` (prefix) がある (`packages/shared/src/legal-consent-api.ts`)。
  - 環境変数の一覧: `src/lib/env.ts` の `SERVER_ENV_VARS` (`readOnlyBy` を持つ変数は `whenMissing` 必須)。Expo に関する変数は無い。`expo-server-sdk` は `package.json` に無い。
  - Expo Push API (公式 docs `docs.expo.dev/push-notifications/sending-notifications`。2026-10-16 取得): 送信は `POST https://exp.host/--/api/v2/push/send` (1 要求に最大 100 件。応答の `data` はメッセージと同じ順の ticket)。receipt は `POST https://exp.host/--/api/v2/push/getReceipts` (`{ ids }`。最大 1000 件。約 15 分後から取れ、24 時間で消える。まだ無い ID は応答に出ない)。アクセストークンは `Authorization: Bearer` (Enhanced push security を ON にしたときだけ必須)。上限は 1 プロジェクト 600 通/秒 (`TOO_MANY_REQUESTS`)。ticket の error は `DeviceNotRegistered` (送るのをやめる)、receipt の error は `DeviceNotRegistered` / `MessageTooBig` (4 KiB) / `MessageRateExceeded` / `MismatchSenderId` / `InvalidCredentials`。429 / 5xx / 通信エラーは指数バックオフで再試行、ほかの 4xx は再試行しない。要求単位のエラー (応答の `errors`。HTTP 4xx / 5xx) は要求の全体に掛かり、`PUSH_TOO_MANY_EXPERIENCE_IDS` (宛先の token が複数の Expo プロジェクトにまたがる。`details` にプロジェクト → token の対応) もその 1 つ。
  - `src/modules/` は無い。モジュール境界は `src/lib/<領域>/`。本書は `src/lib/push/` を「Push 送信モジュール」とし、Expo を呼ぶのは `src/lib/push/expo-transport.ts` だけにする (見張り `tests/push-expo-boundary-scan.test.ts`。§10)。

## 3. 相 1: 外形固定 — 要件行列・種類の一覧・ユーザーシナリオ

### 3.1 要件行列 (全 24 行)

| # | 要件 | 根拠 | 本書の節 |
|---|---|---|---|
| R-01 | 送る通知は 1 端末 × 1 通知 = 1 行で DB に記録され、送る前に失われない (fire-and-forget にしない) | #1136・メールの送信待ちと同じ考え方 | §5 §6 |
| R-02 | 発火元 (献立の結果) は本体の処理を巻き込まない。登録は DB のトリガーで行い、失敗しても `weekly_menu_requests` の更新は成功する | 献立の生成を Push の都合で止めない | §5.3 |
| R-03 | 送る種類は定数の一覧 (`PUSH_NOTIFICATION_KINDS`) で閉じ、文面・行き先・夜間の扱い・ttl は種類ごとに決まる。一覧に無い種類の行は dead | 「種類の全列挙」 | §3.2 §6.2 |
| R-04 | 行き先 (`data.path`) はアプリの `NOTIFICATION_ROUTES` にある画面だけ。機械検査で突き合わせる | `notificationRoute.ts` の規律 | §6.2 §10 |
| R-05 | 全体の受け取り設定 (`notifications_enabled = false`) の利用者には送らない | 要件 §15.4・`03` §3.6 の AND の規則 | §6.3 |
| R-06 | 夜間 (既定 22:00〜07:00 JST。`quiet_hours_start/end` があればその値) は、種類の方針が `defer` なら夜の終わりまで延期し、`send` なら送る。第 1 段の 2 種は `send` | `03` §3.7 (緊急は即送信) を種類ごとの方針に一般化 | §3.2 §6.3 |
| R-07 | 一時的な失敗 (429 / 5xx / 通信エラー) は時間をおいて再試行する。回数と間隔は定数で、回数は環境変数で変えられる | CLAUDE.md マジックナンバー禁止・Expo 公式の推奨 | §6.1 |
| R-08 | Expo の ticket が `DeviceNotRegistered` なら、その端末の行を `user_push_tokens` から消す。receipt の `DeviceNotRegistered` も同じ | `03` §6 の行・Expo 公式 | §6.3 §6.4 |
| R-09 | 送信の約 15 分後に receipt を確認し、結果を行に残す。24 時間たっても receipt が無ければ `missing` として確認を終える | Expo 公式 (15 分・24 時間) | §5.2 §6.3 |
| R-10 | 同じ出来事 (同じ献立の依頼) で同じ端末に 2 通送らない (トリガーの二重発火・CAS の競合でも) | #1202 の CAS の背景 | §5.1 (`dedupe_key`) §5.3 |
| R-11 | worker の二重起動 (Vercel Cron が同じ分を 2 回呼ぶ) で同じ行を 2 本が送らない | `ops_alert_state` の背景 | §5.2 (SKIP LOCKED・リース) |
| R-12 | `EXPO_ACCESS_TOKEN` が無い環境では送らず warn を残す (行は queued のまま記録に残る)。掃除は鍵が無くても毎回する: 24 時間を超えた queued は `expired` の dead、sent / dead は期限で消える | 仕様「未設定時の動き (送らずに記録)」・行が増え続けない | §5.2 (8) §6.1 §6.6 |
| R-13 | 凍結中の利用者・`LEGAL_CONSENT_ENFORCE=on` で未同意の利用者には送らない。退会した利用者の行は残らない | 仕様「同意と退会・凍結」・#1442 | §6.3 §5.1 |
| R-14 | メンテナンス中は送らない (次の回に回す) | 仕様「メンテナンス中」 | §6.6 |
| R-15 | 文面・token の全体・利用者のメールアドレスは `app_logs`・応答に出さない。残すのは種類・利用者 ID・token の末尾 4 文字・件数・エラーコード | cross/08 §16.2 の考え方・`send.ts` の規約 | §8 |
| R-16 | 表は service_role だけが読み書きできる (RLS + GRANT の完全形)。RPC は SECURITY INVOKER・`search_path = ''`・EXECUTE は service_role だけ。トリガー関数だけ SECURITY DEFINER (書き手の権限に依らず登録する) で、EXECUTE は誰にも付けない | `ops_alert_state` の権限の考え方・`anon-definer-execute` の番兵 | §5 |
| R-17 | 送信済み・dead の行は期限で消える (sent 7 日・dead 30 日)。消すのは worker の毎回の掃除 (鍵が無い回も。pg_cron は足さない) | app_logs の 30 日と同じ考え方 | §5.2 (8) |
| R-18 | worker は `requireCronAuth` を通し、`/api/cron` の既存の書き方 (Node・`force-no-store`・`maxDuration = 60`) に合わせ、1 回の実行を 60 秒に収める | `tests/cron-secret-contract.test.ts`・Vercel Pro の上限 | §6.6 |
| R-19 | Expo を呼ぶのは `src/lib/push/expo-transport.ts` だけ。SDK (`expo-server-sdk`) は足さず `fetch` で呼ぶ | 依存を増やさない・`ai-consent-provider-inventory` の送信先の棚卸し | §4.3 §6.4 |
| R-20 | 新しい表・RPC は `database.types.ts` (2 か所) に反映し、migration と対の down.sql を書く | `tests/database-types-migrations-contract.test.ts` | §5 §11 |
| R-21 | 新しい環境変数は `src/lib/env.ts` の一覧・`.env.example`・`ENV_SETUP.md` にそろえ、値を読むのは route 1 ファイル | `tests/env-source-scan.test.ts` | §6.1 |
| R-22 | 新しい Vercel Cron は `08-cron-batches.md` §3.0 と数・名前が一致する | `tests/log-cleanup-dau-snapshot-contract.test.ts` | §13.2 |
| R-23 | 献立の結果を積むのは、`target_slots` が 2 日以上にまたがる依頼の最終の status だけ。利用者の中止 (`中止しました`)・画面を開いたときの止まった行の掃除 (`stale_request_timeout`)・1 食 / 1 日の生成と作り直し・手動の追加 (`target_slots` が無い) には積まない | 頼まれていない場面で送らない・アプリは前面でも通知を出す (`NotificationRouter.tsx` の `shouldShowBanner: true`) | §3.2.1 §5.3 |
| R-24 | 1 つの行の失敗 (形の違う token・別の Expo プロジェクトの token・長すぎる token) が、同じ要求・同じ登録のほかの行を巻き込まない。形の違う token は送る前に `invalid_token` の dead、要求ごと拒まれた (HTTP 4xx。429 を除く) 2 件以上の塊は 1 件ずつ送り直す、長さが 1..256 を外れる端末の行は登録で飛ばす | token はクライアントが書く列で DB に CHECK が無い (§2)・R-01 | §4.3 §5.2 (1) §6.3 |

### 3.2 通知の種類 (全列挙。最初に出す種類と後回しの種類)

**最初に出す (第 1 段。`PUSH_NOTIFICATION_KINDS`)**

| kind | 発火元 | 文面 (title / body) | 行き先 `data.path` | 受け取り設定 | 夜間 | ttl |
|---|---|---|---|---|---|---|
| `weekly_menu_completed` | `weekly_menu_requests.status` が `completed` になり、§3.2.1 の「積む」の条件を満たす (トリガー §5.3) | 「献立ができました」/「{M}月{D}日からの献立ができました。開いて確認しましょう」(`start_date` から) | `/menus` (献立のタブ。タブの WebView が Web の `/menus/weekly` を出す) | `notifications_enabled` | `send` (自分で頼んだ結果。待っている間に届くことに意味がある) | 24 時間 |
| `weekly_menu_failed` | 同じく `failed` になり、§3.2.1 の「積む」の条件を満たす | 「献立を作れませんでした」/「{M}月{D}日からの献立を作れませんでした」(`start_date` から。理由 (同意・1 日の上限・生成の失敗など) は書かず、理由の確認も約束しない: 通知から開く献立のタブの WebView (Web の週の画面 `src/app/(main)/menus/weekly/page.tsx`) が `error_message` を出すのは追跡中の依頼の失敗だけで、起動時の `GET /api/ai/menu/weekly/pending` は queued / pending / processing の行しか返さないので、通知から開いても理由は出ない (§14)。上限のときは「もう一度」も当たらない) | `/menus` | 同上 | `send` | 24 時間 |

payload (トリガーが入れる・`render.ts` の Zod `WeeklyMenuResultPayloadSchema` が検証): `{ request_id: uuid, start_date: 'YYYY-MM-DD', mode: string | null }`。`data` (アプリに届く): `{ kind, path: '/menus', request_id }`。`/menus` は献立のタブで、タブの WebView が Web の `/menus/weekly` を今の週で出す (ネイティブの週の画面 `apps/mobile/app/menus/weekly/index.tsx` は、通常の操作で届かない画面として 2026-10-16 に削除した。#1598。`/menus/weekly` を送っても、アプリの `resolveNotificationHref` は一番近い上位の `/menus` を開く)。

#### 3.2.1 発火元の書き手の全数と、積むかどうか (origin/main a6455673)

`weekly_menu_requests` を `completed` / `failed` にする経路は次の 8 つ (`git grep` で `weekly_menu_requests` を更新する箇所と、`status` を書く関数を全部当たった)。トリガー (§5.3) は書き手を見分けず、**行の列だけ**で積むかどうかを決める: (a) `failed` で `error_message` が中止 (`中止しました`) か止まった行の印 (`stale_request_timeout`) なら積まない、(b) `target_slots` の異なる `date` がトリガーの定数 `c_min_days` (2) 日未満なら積まない (`target_slots` が NULL・配列でない行を含む)、(c) それ以外は `completed` → `weekly_menu_completed`、`failed` → `weekly_menu_failed`。

| # | 書き手 (経路) | 書く値・`error_message` | その行を作った経路と `target_slots` の日数 | 積むか |
|---|---|---|---|---|
| W-1 | `supabase/functions/generate-menu-v5/index.ts` の `finalizeMenuRequest` (CAS #1202) | `completed` / `failed` (定型の文・同意の文・上限の文) | 1 週間の依頼 (`POST /api/ai/menu/weekly/request`・7 日)・範囲の生成 (`POST /api/ai/menu/v4/generate` / `v5/generate`・1〜N 日)・AI 相談の `generate_week_menu` (7 日) / `generate_day_menu` (1 日) / `generate_single_meal` (1 食)・`POST /api/ai/menu/day/regenerate` (1 日)・`meal/generate` / `meal/regenerate` / `POST /api/ai/nutrition-analysis` (1 食) | 2 日以上の行だけ積む (文面は §3.2) |
| W-2 | `supabase/functions/generate-menu-v4/index.ts` (最終の `finalSummary.status` と失敗の書き込み) | 同上 | 同上 (エンジンが v4 の行) | 同上 |
| W-3 | `src/lib/generate-menu-v4-retry.ts` の `markWeeklyMenuRequestFailed` (Edge Function の呼び出しが失敗した route が呼ぶ: weekly/request・v4/generate・day/regenerate・meal/generate・meal/regenerate・nutrition-analysis・AI 相談の 3 か所) | `failed` (定型の文・同意の文) | 呼んだ route の行 (上と同じ) | 2 日以上の行だけ積む |
| W-4 | `src/app/api/cron/process-menu-queue/route.ts` (同意が無い・Edge Function の呼び出しの失敗) | `failed` (同意の文・定型の文) | キューの行 (`v5/generate` が `queued` で積む・1〜N 日) | 2 日以上の行だけ積む (S-02) |
| W-5 | DB の `claim_menu_request` (取り直しの回数を使い切った `queued`) | `failed` (`attempt_limit_exceeded`) | キューの行 | 2 日以上の行だけ積む (利用者が画面を離れている間の失敗) |
| W-6 | `src/lib/weekly-menu-request-stale.ts` の `markWeeklyMenuRequestStaleIfUnchanged` (呼ぶのは `GET /api/ai/menu/weekly/status`・`GET …/weekly/pending`・`GET …/meal/pending`・`POST …/weekly/cleanup`) | `failed` (`stale_request_timeout`) | どの行も | **積まない** (書くのは利用者が開いている週の画面 (アプリ・Web) が呼ぶ API だけで、利用者はそのときアプリを見ている。追跡中の画面は失敗の文を出し、開き直したモバイルの画面は生成中の表示を消す。S-22) |
| W-7 | `POST /api/ai/menu/weekly/status` (利用者の中止。UX2-11) | `failed` (`中止しました`) | どの行も | **積まない** (自分で止めた。S-19) |
| W-8 | `POST /api/menu-plans/add` (手動の 1 件追加。AI を通らない同期の処理。体験ツアーからも呼ばれる) | `pending` → `completed`、失敗の補償は `failed` | この route が `target_slots` 無しで作る | **積まない** (`target_slots` が NULL。S-21) |

`mode` (`'single'` / `'regenerate'` / `'weekly'`) は作った直後に route がエンジン名で上書きする (`meal/generate`・`weekly/request` など) ので、条件に使わない。`target_slots` は `weekly/request` が作成の直後の更新で入れる (最終の status より前)。1 日分の範囲の生成 (究極モードを含む) も積まない (画面で待つ操作と区別できる列が無いため。§14)。

**後回し (本書では送らない。worker は一覧に無い種類を `unknown_kind` で dead にする)**。母集合 (2026-10-16 の origin/main): `03` §3.4 の 7 種・`announcements`・`src/lib/emails/` の全テンプレ・`notification_preferences` の列・`src/lib/local-notification.ts`。利用者宛ての通知を溜める表 (`user_notifications` / `family_meal_requests`) は無い。

| 種類 | 後回しの理由 | 足すときに要るもの |
|---|---|---|
| `family_meal_request` / `family_meal_proposed` (`03` §3.4) | 発火元の `family_meal_requests` が実装に無い。アプリに家族の画面が無く、行き先が決まらない (`notificationRoute.ts` の注) | 機能の実装 + WebView で Web の画面を開く行き先の決め方 |
| `family_freeze_warning` / `family_frozen` (`03` §3.4) | 発火元の pg_cron (`family_freeze_grace_batch`) が未実装 (`08` §3.0) | バッチの実装 (`family_frozen` は `defer` にしない) |
| `plan_deprecated` / `trial_ending` / `license_renewal` (`03` §3.4) | 課金のバッチはオーナーの選択「課金は無料のまま計測」で足していない (`08` §3.2) | バッチの実装 |
| お知らせ (`announcements`) | 運営からの一斉送信 (§1.2 の対象外) | 運営の操作の設計 (監査ログ・送る相手の数え方) |
| メールだけで知らせている利用者宛ての出来事 (`src/lib/emails/membership/`: 家族・組織の招待 / 家族の代表者・組織のオーナーの譲渡の提案と完了 / 家族の昇格 / 脱退・除名 / 運営による強制解散・強制譲渡。`support/ticket-reply`: サポートの返信) | 行き先が `NOTIFICATION_ROUTES` に無い (家族・組織・サポートの画面はアプリに無い。ネイティブの組織・サポートの画面は、通常の操作で届かない画面として 2026-10-16 に削除した。#1598)。本書はモバイルのコードを変えない | 行き先の決め方 (WebView か `NOTIFICATION_ROUTES` への追加) |
| 健康記録のリマインダー (朝・夕。`morning_reminder_*` / `evening_reminder_*` / `vacation_mode`) | 設定画面はあるが、時刻に送るバッチ (pg_cron / Vercel Cron) が無い | 時刻ごとに積むバッチ。行き先は `/health/record` |
| Push にしないもの: 退会の完了 (`account/account-deleted`。退会後は端末の行が無い)・運用の警報 (`ops/app-log-error-spike`。運営宛て)・Web のフォアグラウンド通知 (`local-notification.ts`。ブラウザの中だけ) | Push の宛先が無い / 利用者宛てでない | – |

### 3.3 ユーザーシナリオ (24 本)

| # | シナリオ | 期待する結果 |
|---|---|---|
| S-01 | アプリで 1 週間の献立を頼み、ホーム画面に戻ってアプリを閉じる。3 分後に生成が終わる | 1 分以内に「献立ができました」が届く。タップすると献立のタブ (`/menus`。WebView が Web の `/menus/weekly` を出す) が開く |
| S-02 | キューに積んだ 3 日分の献立の生成が失敗する (順番を待つ間に AI の事業者への提供の同意を取り下げていた)。利用者はアプリを閉じている | 「{M}月{D}日からの献立を作れませんでした」が届く。タップすると献立のタブ (`/menus`) が今の週で開く (失敗の理由は出ない。通知も理由を約束しない: §3.2・§14) |
| S-03 | Web だけを使う利用者 (端末の行が無い) の献立が完成する | `push_outbox` に行は作られない (0 件)。何も送らない |
| S-04 | iPhone と iPad の 2 台でログインしている利用者の献立が完成する | 2 行が作られ、2 台に届く。receipt も 2 行に残る |
| S-05 | 通知を OFF (`notifications_enabled = false`) にしている利用者の献立が完成する | 行は作られるが、worker が送らず dead (`notifications_disabled`) にする |
| S-06 | 23:30 に献立が完成する | `weekly_menu_completed` は `send` なので、そのまま届く。(方針が `defer` の種類なら `next_attempt_at` が翌 07:00 JST になり、その回で送る) |
| S-07 | 本番で `EXPO_ACCESS_TOKEN` が未設定のまま献立が完成する | worker は送らず `not_configured` を返し (warn)、掃除だけをする。行は queued のまま残り、24 時間を超えた回の掃除で `expired` の dead になる (30 日後に消える)。設定したあとは 24 時間以内の行と新しい行が届く |
| S-08 | Expo が 503 を返す (一時障害)。5 分後に復旧 | 1 回目は失敗 → queued のまま 1 分後に 2 回目 → 失敗 → 5 分後の 3 回目で sent。利用者は何もしなくてよい |
| S-09 | アプリを削除した端末 (token が無効) に送る | ticket が `DeviceNotRegistered` → 行は dead (`DeviceNotRegistered`) にしたうえで端末の行を消す (送信待ちの行も CASCADE で消える)。以後、その利用者の献立では行が作られない |
| S-10 | ticket は `ok` だったが、15 分後の receipt が `DeviceNotRegistered` | receipt を記録してから端末の行を消す (CASCADE で送信待ちの行も消える) |
| S-11 | 献立が完成した直後 (worker が送る前) にログアウトする | アプリが端末の行を消す → 送信待ちの行も CASCADE で消える → ログアウトした端末には届かない |
| S-12 | 利用者が退会する | `user_push_tokens` も `push_outbox` も `user_id` の CASCADE で消える。`prepare_account_deletion` は変えない |
| S-13 | 運営が利用者を凍結する。その後に (凍結前に頼んだ) 献立が完成する | worker が送らず dead (`account_frozen`) |
| S-14 | 規約の版が上がり、まだ同意していない利用者の献立が完成する (本番 `LEGAL_CONSENT_ENFORCE=on`) | 送らず dead (`consent_outdated`)。`off` の環境 (ローカル) では送る |
| S-15 | メンテナンスモード ON の間に献立が完成する | worker は `maintenance` で何もしない。OFF になった次の回で送る (24 時間以内なら) |
| S-16 | Vercel Cron が同じ分の worker を 2 回呼ぶ | `FOR UPDATE SKIP LOCKED` で同じ行を 2 本が取らない。各行は 1 本だけが送る |
| S-17 | 生成の再開 (#1202) で 2 本のチェーンが同じ依頼を終えようとする | CAS で最終の書き込みは 1 回だけ → トリガーは 1 回。万一 2 回更新が通っても `dedupe_key` (依頼 ID × token) で行は 1 つ |
| S-18 | Expo が 429 (`TOO_MANY_REQUESTS`) を返す | その塊の行は retryable で queued に戻し、この回の送信をやめる (`stopped_early: 'rate_limited'`)。次の回 (1 分後) に続きを送る |
| S-19 | 1 週間の献立の生成中に、利用者が画面の「中止」を押す | 行は `failed` (`中止しました`) になるが、Push は届かない (`push_outbox` に行は作られない) |
| S-20 | 週の献立の画面で 1 食だけ作り直す (または 1 日分を作り直す・AI 相談で 1 日分を作る) | 結果は画面に出る。Push は届かない (`target_slots` が 1 日) |
| S-21 | 献立を手動で 1 件追加する (体験ツアーを含む) | 行は `pending` → `completed` になるが、Push は届かない (`target_slots` が無い) |
| S-22 | 1 週間の生成が途中で止まり、20 分後に利用者が週の画面を開いて、状態の確認 (または掃除) が行を `failed` (`stale_request_timeout`) にする。別の利用者の 3 日分のキューの行は、取り直しの回数を使い切って `failed` (`attempt_limit_exceeded`) になる | 前者は Push が届かない (利用者は週の画面を開いている。週の画面 (アプリでは献立のタブの WebView が出す Web の画面) は、追跡中なら失敗の文を出し、開き直したときは生成中の表示を消す)。後者 (画面を離れている間の失敗) には「{M}月{D}日からの献立を作れませんでした」が届く |
| S-23 | 利用者がアプリの外から自分の `user_push_tokens` の行に形の違う文字列 (`ExponentPushToken[…]` の形でない) を書き、その利用者とほかの 99 人の献立が同じ分に完成する | 形の違う行は Expo に渡さずに dead (`invalid_token`)。ほかの 99 人の行は同じ回に 1 つの要求で送られ、届く。端末の行は消さない |
| S-24 | 形は正しいが別の Expo プロジェクトの token (利用者が書いた値、または別のプロジェクトで作った古いビルドの token) の行が、ほかの 99 人の行と同じ塊に入る | Expo が要求ごと 400 (`PUSH_TOO_MANY_EXPERIENCE_IDS`) を返す → worker は塊を 1 件ずつの要求に分けて送り直す → 99 人の行は sent。原因の行だけが自分の 1 件の要求の結果 (4xx なら dead (`errors[0].code`)) になる |

## 4. 相 2・相 3: 構造とその裁定

### 4.1 構造 (確定)

```mermaid
flowchart LR
  G[書き手 8 経路 §3.2.1<br/>weekly_menu_requests.status → completed / failed] -->|トリガー weekly_menu_requests_enqueue_push (関数 enqueue_weekly_menu_result_push): 2 日以上・中止 / 止まりでない行だけ| E[enqueue_push_notification<br/>端末の行ごとに 1 行 INSERT]
  E --> T[(push_outbox)]
  W[GET /api/cron/push-outbox<br/>Vercel Cron 毎分] -->|claim_push_outbox| T
  W -->|user_profiles / notification_preferences を読む<br/>凍結・同意・設定・夜間| P[(user_profiles / notification_preferences)]
  W -->|POST /--/api/v2/push/send ≤ 100 件| X[Expo Push API]
  W -->|complete / fail / defer| T
  W -->|claim_push_receipts → POST getReceipts ≤ 1000 件 → record_push_receipt| T
  W -->|DeviceNotRegistered: user_push_tokens の行を消す| K[(user_push_tokens)]
  K -. ON DELETE CASCADE .-> T
  W -->|cleanup_push_outbox| T
```

部品と責務:

| 部品 | 場所 | 責務 |
|---|---|---|
| 送信待ちの表 | `push_outbox` (migration §5.1) | 1 端末 × 1 通知 = 1 行。状態 queued / sent / dead。種類・payload・token・試行回数・次の試行時刻・リース・最後の失敗・ticket の ID・receipt の結果 |
| 登録 (enqueue) | RPC `enqueue_push_notification` (§5.2 (1)) + トリガー `weekly_menu_requests_enqueue_push` (関数 `enqueue_weekly_menu_result_push`) (§5.3) | トリガーが §3.2.1 の条件で積むかを決め、RPC が利用者の端末の行ごとに 1 行入れる。端末が無ければ 0 行。`dedupe_key` で二重登録を防ぐ。文面は入れない (worker が種類と payload から作る) |
| 種類の一覧 | `packages/shared/src/push-notification-kinds.ts` (§6.2) | kind の値・行き先・夜間の方針・ttl・priority。サーバーとアプリで同じ値 |
| 文面 | `src/lib/push/render.ts` (§6.2) | kind と payload から title / body / data を作る (payload は Zod で検証) |
| 送信 (worker) | `src/lib/push/outbox.ts` (純粋な処理。§6.3) + `src/lib/push/outbox-store.ts` (DB。§6.5) + `src/lib/push/expo-transport.ts` (Expo。§6.4) + `src/app/api/cron/push-outbox/route.ts` (glue。§6.6) | 取る → 送る条件 (token の形を含む) → 夜間 → 文面 → Expo (100 件ずつ。要求ごと拒まれた塊は 1 件ずつ送り直す) → complete / fail / defer → receipt の確認 → 掃除。1 回の実行は 60 秒に収める |
| DB の判断 | RPC 8 本 (§5.2) | 取り合い (SKIP LOCKED)・リース・回数と次の時刻・dead の判定・receipt の記録・掃除を DB で原子的に |
| 端末の行の削除 | worker (`store.deleteToken`) | `DeviceNotRegistered` のときだけ。送信待ちの行は FK の CASCADE で一緒に消える |

### 4.2 トレース (24 本を上の構造で手で走らせる)

| # | 走らせた経路 | 結果 (期待と一致) |
|---|---|---|
| S-01 | `weekly/request` が `target_slots` (7 日 × 3 食) を入れた行 → Edge Function が `buildActiveRequestUpdate` で `status = 'completed'` → トリガー (AFTER UPDATE OF status・WHEN 新旧が違い新が completed/failed) → 関数: 中止・止まりの文でない・異なる `date` が 7 ≥ 2 → `enqueue_push_notification(user_id, 'weekly_menu_completed', { request_id, start_date, mode }, 'weekly_menu_result:<id>')` → `user_push_tokens` の 1 行 → INSERT 1 行 (queued・next_attempt_at = now)。worker (≤ 60 秒後): `claim_push_outbox` → `loadEligibility` → 凍結なし・同意済み・enabled → kind `send` → `render` → `transport.send([1 件])` → ticket ok → `complete_push_outbox(id, worker, receipt_id)` → sent。15 分後の回: `claim_push_receipts` → `getReceipts` → ok → `record_push_receipt('ok')`。端末: `NotificationRouter` が `data.path = '/menus'` を `resolveNotificationHref` で同じ `/menus` に解決 → 献立のタブを開く (WebView が Web の `/menus/weekly`) | 一致 |
| S-02 | `v5/generate` が 3 日分の `target_slots` で `queued` に積んだ行 → `process-menu-queue` が同意の文で `status = 'failed'` (W-4) → トリガー: 中止・止まりの文でない・3 日 ≥ 2 → kind `weekly_menu_failed` → 同じ経路で `render` が「{M}月{D}日からの献立を作れませんでした」(`start_date` から) → タップ: 献立のタブ (`/menus`) の WebView が Web の `/menus/weekly` を今の週で開く → Web の週の画面の `checkPendingRequests`・`fetchPlan` の `GET …/weekly/pending` は failed の行を返さない (queued / pending / processing だけ) → 理由は出ない。本文は理由を約束していないので食い違わない | 一致 |
| S-03 | トリガー → `enqueue_push_notification` → `user_push_tokens` に行が無い → INSERT 0 行 → 0 を返す。トリガーは戻り値を見ない | 一致 |
| S-04 | 端末の行 2 つ → INSERT 2 行 (`dedupe_key` は `…:<token>` で別) → 1 要求に 2 件 → ticket 2 つを順に対応 → 2 行 sent → receipt 2 行 | 一致 |
| S-05 | claim → `loadEligibility` の `notificationsEnabled = false` → `decideEligibility` が `notifications_disabled` → `fail_push_outbox(retryable = false)` → dead。Expo は呼ばない | 一致 (R-05) |
| S-06 | `localMinutesOfDay(now, 540)` = 23:30 → `isWithinQuietHours(1410, 1320, 420)` = true → kind の `quietHours` が `send` → 延期しない → 送る。`defer` の種類なら `quietHoursEndMs` = 翌 07:00 JST → `defer_push_outbox(id, worker, until)` → queued のまま `next_attempt_at` = until・attempts は増えない | 一致 (R-06) |
| S-07 | route: メンテナンスでない → `process.env.EXPO_ACCESS_TOKEN` が無い → warn → `store.cleanup()` だけ (claim も receipt もしない) → `{ status: 'not_configured', cleaned_expired, cleaned_sent, cleaned_dead }`。行は queued のまま。`created_at` から 24 時間 (`c_queued_max_age` = `PUSH_OUTBOX_QUEUED_MAX_AGE_MS`) を超えた回の `cleanup_push_outbox` が、リースの無い queued を `expired` の dead にする → 30 日後の掃除で消える。設定した回からは通常の経路 (24 時間以内の行は送る。超えた行は claim しても `decideEligibility` が `expired`) | 一致 (R-12) |
| S-08 | `transport.send` → HTTP 503 → `{ ok: false, failure: { retryable: true, statusCode: 503 } }` → 塊の全行に `fail_push_outbox(retryable = true, max = 3, retry_after = 60)` → attempts 1・queued・next = +60 秒。2 回目: 503 → attempts 2・next = +300 秒。3 回目: 200 → sent | 一致 (間隔の表 §6.1) |
| S-09 | ticket `{ status: 'error', details: { error: 'DeviceNotRegistered' } }` → `fail_push_outbox('DeviceNotRegistered', retryable = false)` → dead → `store.deleteToken(push_token_id)` → `user_push_tokens` の行が消える → CASCADE で dead の行も消える (記録は app_logs の warn)。次の献立: `enqueue` が端末の行を見つけない → 0 行 | 一致 (R-08) |
| S-10 | `claim_push_receipts` (sent_at ≤ now − 900 秒・receipt_checked_at NULL) → `getReceipts([receipt_id])` → `{ status: 'error', details: { error: 'DeviceNotRegistered' } }` → `record_push_receipt('error', 'DeviceNotRegistered')` → `deleteToken` → CASCADE | 一致 |
| S-11 | アプリのログアウトが `user_push_tokens` の行を消す (既存) → `push_outbox.push_token_id` の FK ON DELETE CASCADE で queued の行が消える → worker は取らない | 一致 |
| S-12 | `auth.admin.deleteUser` → `user_push_tokens` (既存の CASCADE) と `push_outbox.user_id` (CASCADE) が消える。`prepare_account_deletion` には push の段を足さない (生のアドレス・文面を持たない表) | 一致 (R-13) |
| S-13 | `loadEligibility` の `frozenAt` あり・`unbanAt` NULL → `isAccountFrozen` true → dead (`account_frozen`) | 一致 |
| S-14 | route が `isLegalConsentEnforced()` を `legalConsentEnforced` として渡す → true かつ `hasAcceptedCurrentLegalDocuments({ terms_version_accepted, privacy_version_accepted })` が false → dead (`consent_outdated`)。false (off) なら判定を飛ばして送る | 一致 |
| S-15 | route が `isMaintenanceFlagOn()` を見る → true → `{ status: 'maintenance' }` (claim も receipt も掃除もしない)。OFF の回で通常どおり | 一致 (R-14) |
| S-16 | 2 本の `claim_push_outbox` が同時: `FOR UPDATE SKIP LOCKED` で行の集合が重ならない。complete / fail / defer は `worker_id` と `status = 'queued'` の一致を条件にするので、もう片方の更新は 0 行 (`ignored`) | 一致 (R-11) |
| S-17 | CAS が 2 本目の最終の書き込みを 0 行にする → トリガーは発火しない。2 回更新が通った場合も `dedupe_key = 'weekly_menu_result:<id>:<token>'` の部分一意索引に当たり `ON CONFLICT DO NOTHING` → 行は 1 つ | 一致 (R-10) |
| S-18 | HTTP 429 → `retryable: true` → 塊の全行を `fail(retryable)` → `stopped_early = 'rate_limited'` で送信をやめ、receipt の確認と掃除はする。次の回で続き | 一致 |
| S-19 | `POST /api/ai/menu/weekly/status` が `status = 'failed'`・`error_message = '中止しました'` (W-7) → トリガー (WHEN は通る) → 関数: `failed` かつ `c_cancelled_message` に一致 → `RETURN NEW` (enqueue を呼ばない) → `push_outbox` 0 行 | 一致 (R-23) |
| S-20 | `meal/regenerate` (1 食) / `day/regenerate` (1 日 3 食) / AI 相談の `generate_day_menu` の行が `completed` (W-1 / W-2) → 関数: 異なる `date` が 1 < `c_min_days` (2) → `RETURN NEW` → 0 行 | 一致 (R-23) |
| S-21 | `menu-plans/add` が `target_slots` 無しで `pending` の行を作り `completed` に更新 (W-8) → WHEN は通る → 関数: `target_slots` が NULL → `RETURN NEW` → 0 行 | 一致 (R-23) |
| S-22 | 前者: `GET /api/ai/menu/weekly/status` (追跡中の画面) か `GET …/weekly/pending` (開き直した画面。`hasPending: false` を返す) の `markWeeklyMenuRequestStaleIfUnchanged` が `failed`・`stale_request_timeout` (W-6) → 関数: `c_stale_message` に一致 → 0 行。後者: `claim_menu_request` が `failed`・`attempt_limit_exceeded` (W-5。SECURITY DEFINER の関数の中の UPDATE でもトリガーは発火する) → 中止・止まりの文でない・`v5/generate` の行が 2 日以上 → `weekly_menu_failed` が積まれる | 一致 (R-23) |
| S-23 | `enqueue_push_notification`: 形の違う文字列も長さが 1..256 なら行になる (長さを外れる行は飛ばす: §5.2 (1)) → claim (100 行) → `decideEligibility`: プロフィールあり・24 時間以内 → `isExpoPushToken(row.expo_push_token)` が false → `invalid_token` → `fail_push_outbox(retryable = false)` → dead (Expo は呼ばない。`deleteToken` も呼ばない)。残りの 99 行は `pending` に入り、`sendBatch` の 1 要求 → ticket 99 個 → 99 行 sent | 一致 (R-24) |
| S-24 | 100 行が `isExpoPushToken` を通る → `sendBatch([100 件])` → `transport.send` が HTTP 400・`errors[0].code = 'PUSH_TOO_MANY_EXPERIENCE_IDS'` → `httpFailure` が `{ statusCode: 400, retryable: false }` → `isRequestLevelRejection` が true・塊は 2 件以上 → warn を 1 行 → 100 行を 1 件ずつ `sendBatch([1 件])` (各回の前に時間切れを確かめる) → 99 行は ticket ok で sent。原因の行は 1 件の要求の結果だけで決まる (4xx なら `recordFailure` で dead (`errors[0].code`)。1 件の塊は分けない) | 一致 (R-24) |

### 4.3 構造裁定 (1 回だけ)

| 案 | 内容 | 退けた理由 / 採った理由 |
|---|---|---|
| A. Edge Function `notify-push` を同期で呼ぶ (`03` §3.9 の形) | 発火元が `supabase.functions.invoke('notify-push', { user_ids, … })` を呼び、関数の中で token を引いて Expo に送る | 送る前に落ちた分 (関数の停止・応答の喪失) が記録されず、再試行は呼び出し元ごとに書くことになる。receipt の確認 (15 分後) は別の仕組みが要る。発火元が Edge Function (Deno) と Next (Node) と DB (将来の pg_cron) に散るのに、呼び方を 3 通り書くことになる |
| B. `email_outbox` に相乗りする (`channel` 列で分ける) | メールの送信待ちの表と worker に Push の行も入れる | 列の半分 (宛先・件名・本文・Idempotency-Key・停止リスト) が Push に無意味で、Push にだけ要るもの (token の FK・receipt) が増える。worker の判断 (再試行の種類・receipt) が分岐だらけになる。別の設計 (未実装) に依存して着手できない |
| **C. `push_outbox` + Vercel Cron の worker (採用)** | 登録は DB の RPC (発火元は何からでも 1 行呼ぶだけ)。送るのは worker だけ。形はメールの送信待ちと同じ | 送る側が 1 つで、二重送信の防止 (リース + SKIP LOCKED + dedupe_key) が 1 か所に閉じる。receipt の確認が同じ worker の 2 つ目の段で済む。発火元は Edge Function でも Next でも DB でも、RPC 1 本 (またはトリガー) で同じ |

細かい裁定 (構造の中で決めたもの):

| 問い | 決定 | 理由 |
|---|---|---|
| Expo を呼ぶ部品 | `fetch` (SDK `expo-server-sdk` を足さない) | 必要な API は 2 本 (send / getReceipts) で、塊の分割 (100 / 1000) と再試行の判定は数行。SDK は 6 並列や gzip の面倒を見るが、1 回の実行で送るのは最大 500 件で要らない。送信先 `exp.host` は `NON_AI_HOSTS` に理由つきで載せる (§13.1) |
| 発火元の形 | DB のトリガー (TS から `enqueue_push_notification` を呼ぶのではなく) | 最終の書き込みの書き手が 8 経路 (Edge Function (Deno) 2 本・Next の route と lib 5 つ・DB の関数 1 つ。§3.2.1) ある。トリガーなら書き手を変えずに済み、将来の書き手も漏れない。トリガーは SECURITY DEFINER (書き手の権限に依らず INSERT できる) |
| 積む行の見分け方 | 行の列だけで決める: 異なる `date` が 2 日以上の `target_slots` と、`failed` の `error_message` が中止・止まりの印でないこと (§3.2.1) | `mode` は route がエンジン名で上書きするので使えない。「通知する」の列を足して作る側で立てる形は、行を作る経路 (route 8 本と AI 相談の 3 か所) をすべて変えることになり、漏れた経路は黙って通知しない。日数と定型の文は今の行にすでにあり、書き手を変えずに済む。定型の文の値はトリガーの定数と `stored-failure-messages.ts` を契約テストで突き合わせる |
| 行の単位 | 1 端末 (token) × 1 通知 = 1 行 (利用者 × 通知 = 1 行で送るときに端末へ広げる、ではなく) | ticket と receipt は端末ごとに返る。行 = 端末なら、状態機械が行の中で閉じ、`DeviceNotRegistered` の対応先も行から分かる |
| 端末の行との結び | `push_token_id` の FK ON DELETE CASCADE | ログアウト・claim・release・退会・`DeviceNotRegistered` のどれで端末の行が消えても、その端末宛ての送信待ちが一緒に消える (ログアウトした端末に送らない)。消えた行の記録は app_logs に残す |
| 送る条件の判定の場所 | worker (送る直前) に 1 か所。登録 (トリガー) では、通知する出来事か (§3.2.1) と端末の有無だけ見る | 凍結・同意・設定は送る時点の値で判定したい。登録時に判定すると、同じ判定を発火元の数だけ書くことになる |
| 1 行の失敗を他の行に広げない (R-24) | (a) token の形は worker の `decideEligibility` が `isExpoPushToken` (claim / release と同じ判定) で見て、違えば `invalid_token` の dead (端末の行は消さない)。(b) 要求ごと拒まれた (HTTP 4xx。429 を除く) 2 件以上の塊は、1 件ずつの要求に分けて同じ回で送り直す (code を問わない)。(c) `enqueue_push_notification` は長さが 1..256 (`push_outbox` の CHECK) を外れる端末の行を飛ばす | token はクライアントが書く列で DB に CHECK が無い。要求単位のエラーは塊の全行に掛かるので、そのままでは 1 行が他人の行 (最大 99 件) を dead にする。`details` の形 (プロジェクト → token) に依らず、1 件ずつなら原因の行だけが失敗する (401 のように全行が同じ理由で拒まれるときは、要求が塊の数だけ増えるが、どの行も 1 回で dead になり次の回に持ち越さない)。429 / 5xx / 通信エラーは分けない (待てば直る)。応答の形の誤り (`invalid_response`) も分けない (Expo が受け付けたあとかもしれず、送り直すと 2 通届く)。(c) が無いと 1 行の CHECK 違反で INSERT 全体が失敗し、同じ利用者のほかの端末にも積まれない。`user_push_tokens` に CHECK を足すのは既存の表とアプリの登録の変更で、本書の範囲 (§1.2) の外 |
| 夜間の時計 | JST 固定 (`PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES = 540`。`user_profiles.timezone` は無い) | 日本向けのアプリで、Asia/Tokyo に夏時間が無い。利用者ごとの時刻帯を足すときは、この定数を利用者の値に置き換える 1 か所だけ |
| 掃除 | worker の毎回の最後に `cleanup_push_outbox()` を呼ぶ。鍵が無い回は掃除だけを呼ぶ (pg_cron を足さない) | 部分索引で消す対象が無ければ一瞬。pg_cron を足すと `08-cron-batches.md` の数と番兵の追随が増える |

「縁の発生源を消すより単純な構造は無いか」: 送信の同期経路そのものを持たず、発火元を「RPC 1 本 (トリガー)」に閉じたのが C。残る縁は (1) `EXPO_ACCESS_TOKEN` が無い環境 (送らず warn・掃除だけ: R-12)、(2) receipt が来ない (24 時間で `missing` にして確認を終える: R-09)、(3) 端末の行が消える競合 (CASCADE で行ごと消え、complete / fail は 0 行 = `ignored`)。以後、構造の疑義は裁定への差し戻し事由として扱い、仕上げ相では蒸し返さない。

## 5. データモデル (migration。正典)

ファイル: `supabase/migrations/<番号はマージ時に確定>_push_outbox.sql` と対の `supabase/rollbacks/<同じ番号>_push_outbox.down.sql`。番号はマージ直前に origin/main の `supabase/migrations` の最大 (2026-10-16 時点 (cd4d4f17) `20261016220000_data_subject_requests.sql`。並行して足されるので、この値は目安) より大きい値にする。適用後に `database.types.ts` を 2 か所 (`src/types/` と `packages/shared/src/`) で作り直す (`tests/database-types-migrations-contract.test.ts` の手順)。

### 5.1 表 `push_outbox`

```sql
-- migration: <番号>_push_outbox.sql
-- #1136: Push 通知の送信待ち (push_outbox)。1 端末 (user_push_tokens の行) × 1 通知 = 1 行。
-- 登録は enqueue_push_notification (weekly_menu_requests のトリガーが呼ぶ)。送るのは GET /api/cron/push-outbox (Vercel Cron・毎分) だけ。
-- 再試行は最大 PUSH_OUTBOX_MAX_ATTEMPTS 回 (既定 3)、使い切ったら dead。Expo の receipt は送信の 15 分後から worker が確認し、行に残す。
-- 権限の考え方は 20261010123500_ops_alert_state.sql と同じ (表は service_role だけ。RPC は SECURITY INVOKER・search_path ''・EXECUTE は service_role だけ)。
-- トリガー関数だけ SECURITY DEFINER (weekly_menu_requests の書き手の権限に依らず登録する)。EXECUTE は誰にも付けない。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS / CREATE INDEX IF NOT EXISTS / DROP TRIGGER IF EXISTS。
-- 既存の行・表には触れない (user_push_tokens は参照するだけ。weekly_menu_requests にはトリガーを足すだけ)。
-- 確認: tests/integration/rls/push-outbox.test.ts / ロールバック: supabase/rollbacks/<番号>_push_outbox.down.sql

CREATE TABLE IF NOT EXISTS public.push_outbox (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'dead')),
  -- 通知の種類 (packages/shared/src/push-notification-kinds.ts の PUSH_NOTIFICATION_KINDS)。worker が文面を作る
  kind               TEXT        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  user_id            UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- 端末の行。ログアウト・claim・release・DeviceNotRegistered で端末の行が消えたら、この行も消える
  push_token_id      UUID        NOT NULL REFERENCES public.user_push_tokens (id) ON DELETE CASCADE,
  expo_push_token    TEXT        NOT NULL CHECK (char_length(expo_push_token) BETWEEN 1 AND 256),
  -- 文面の材料 (ID と日付だけ。個人を特定する文字列は入れない)。Expo の上限 4 KiB の半分に抑える
  payload            JSONB       NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 2048),
  -- 同じ出来事で同じ端末に 2 行作らないための鍵 ('<出来事>:<端末の token>')。NULL なら重複を見ない
  dedupe_key         TEXT        CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 512),
  attempts           INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at   TIMESTAMPTZ,
  worker_id          TEXT,
  last_error_code    TEXT,
  last_error_message TEXT,
  last_status_code   INTEGER,
  sent_at            TIMESTAMPTZ,
  -- Expo の ticket の id (= receipt の id)。sent のときだけ
  receipt_id         TEXT,
  receipt_checked_at TIMESTAMPTZ,
  receipt_status     TEXT        CHECK (receipt_status IS NULL OR receipt_status IN ('ok', 'error', 'missing')),
  receipt_error      TEXT,
  dead_at            TIMESTAMPTZ,
  CONSTRAINT push_outbox_status_times CHECK (
       (status = 'queued' AND sent_at IS NULL AND dead_at IS NULL AND receipt_id IS NULL)
    OR (status = 'sent'   AND sent_at IS NOT NULL AND dead_at IS NULL AND receipt_id IS NOT NULL)
    OR (status = 'dead'   AND dead_at IS NOT NULL AND sent_at IS NULL)
  ),
  CONSTRAINT push_outbox_receipt_consistency CHECK (
    (receipt_checked_at IS NULL AND receipt_status IS NULL) OR (receipt_checked_at IS NOT NULL AND receipt_status IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_push_outbox_claim
  ON public.push_outbox (next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_push_outbox_receipt_pending
  ON public.push_outbox (sent_at) WHERE status = 'sent' AND receipt_checked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_push_outbox_sent_at
  ON public.push_outbox (sent_at) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_push_outbox_dead_at ON public.push_outbox (dead_at) WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS idx_push_outbox_user_id ON public.push_outbox (user_id);
CREATE INDEX IF NOT EXISTS idx_push_outbox_push_token_id ON public.push_outbox (push_token_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_outbox_dedupe_key
  ON public.push_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_outbox FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_outbox TO service_role;
DROP POLICY IF EXISTS push_outbox_deny_client_access ON public.push_outbox;
CREATE POLICY push_outbox_deny_client_access ON public.push_outbox
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.push_outbox IS
  '#1136: Push 通知の送信待ち。1 端末 × 1 通知 = 1 行。queued → sent / dead。service_role のみ。文面は持たず、worker が kind と payload から作る。';
```

### 5.2 RPC 8 本 (すべて SECURITY INVOKER・`SET search_path = ''`・EXECUTE は service_role だけ)

引数の範囲外は SQLSTATE `22023` で拒む (`app_log_error_counts` と同じ)。`attempts` は worker がその行を処理した回数 (Expo を呼ばずに dead にした回も 1 回と数える)。

```sql
-- (1) 登録: 利用者の端末の行ごとに 1 行。端末が無ければ 0。dedupe_key は '<出来事>:<token>' にして同じ端末の重複を防ぐ
--     token の長さが push_outbox の CHECK を外れる端末の行は飛ばす (user_push_tokens はクライアントが書き、長さの CHECK が無い。
--     1 行の CHECK 違反で INSERT 全体を失敗させ、同じ利用者のほかの端末まで積めなくしない。R-24)。形の判定は worker (invalid_token)
CREATE OR REPLACE FUNCTION public.enqueue_push_notification(p_user_id uuid, p_kind text, p_payload jsonb, p_dedupe_key text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  -- push_outbox.expo_push_token の CHECK の上限と同じ (src/lib/push-tokens.ts の MAX_EXPO_PUSH_TOKEN_LENGTH。契約テストが突き合わせる)
  c_max_token_chars CONSTANT integer := 256;
  v_count integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = '22023'; END IF;
  IF p_kind IS NULL OR p_kind !~ '^[a-z][a-z0-9_]{0,63}$' THEN RAISE EXCEPTION 'p_kind must match ^[a-z][a-z0-9_]{0,63}$' USING ERRCODE = '22023'; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 2048 THEN RAISE EXCEPTION 'p_payload must be a JSON object of at most 2048 bytes' USING ERRCODE = '22023'; END IF;
  IF p_dedupe_key IS NOT NULL AND char_length(p_dedupe_key) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'p_dedupe_key must be 1..255 chars' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.push_outbox (user_id, push_token_id, expo_push_token, kind, payload, dedupe_key)
  SELECT t.user_id, t.id, t.expo_push_token, p_kind, p_payload,
         CASE WHEN p_dedupe_key IS NULL THEN NULL ELSE p_dedupe_key || ':' || t.expo_push_token END
  FROM public.user_push_tokens t
  WHERE t.user_id = p_user_id
    AND char_length(t.expo_push_token) BETWEEN 1 AND c_max_token_chars
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- (2) 取る: 送る時刻が来た queued をリースつきで取る。同時に何本来ても同じ行は 1 本だけ (SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_push_outbox(p_worker_id text, p_limit integer, p_lease_seconds integer)
RETURNS SETOF public.push_outbox LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF p_worker_id IS NULL OR char_length(p_worker_id) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'p_worker_id must be 1..128 chars' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN RAISE EXCEPTION 'p_limit must be 1..500' USING ERRCODE = '22023'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'p_lease_seconds must be 1..3600' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
    FROM public.push_outbox o
    WHERE o.status = 'queued'
      AND o.next_attempt_at <= now()
      AND (o.lease_expires_at IS NULL OR o.lease_expires_at < now())
    ORDER BY o.next_attempt_at, o.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.push_outbox o
  SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      worker_id        = p_worker_id,
      updated_at       = now()
  FROM picked
  WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

-- (3) 送れた (ticket ok): sent にして receipt の id を残す。取った worker の行で queued のときだけ (それ以外は false = ignored)
CREATE OR REPLACE FUNCTION public.complete_push_outbox(p_id uuid, p_worker_id text, p_receipt_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_receipt_id IS NULL OR char_length(p_receipt_id) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'p_receipt_id must be 1..256 chars' USING ERRCODE = '22023'; END IF;
  UPDATE public.push_outbox
  SET status = 'sent', sent_at = now(), receipt_id = p_receipt_id, attempts = attempts + 1,
      lease_expires_at = NULL, worker_id = NULL,
      last_error_code = NULL, last_error_message = NULL, last_status_code = NULL, updated_at = now()
  WHERE id = p_id AND worker_id = p_worker_id AND status = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- (4) 送れなかった: retryable かつ回数が残っていれば queued に戻して次の時刻を決める。そうでなければ dead。
--     戻り値 'requeued' / 'dead' / 'ignored' (取った worker の queued の行でない)
CREATE OR REPLACE FUNCTION public.fail_push_outbox(p_id uuid, p_worker_id text, p_error_code text, p_error_message text, p_status_code integer, p_retryable boolean, p_max_attempts integer, p_retry_after_seconds integer)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_attempts integer;
  v_dead     boolean;
BEGIN
  IF p_error_code IS NULL OR char_length(p_error_code) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'p_error_code must be 1..64 chars' USING ERRCODE = '22023'; END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 10 THEN RAISE EXCEPTION 'p_max_attempts must be 1..10' USING ERRCODE = '22023'; END IF;
  IF p_retry_after_seconds IS NULL OR p_retry_after_seconds < 0 OR p_retry_after_seconds > 86400 THEN RAISE EXCEPTION 'p_retry_after_seconds must be 0..86400' USING ERRCODE = '22023'; END IF;
  SELECT attempts + 1 INTO v_attempts
  FROM public.push_outbox
  WHERE id = p_id AND worker_id = p_worker_id AND status = 'queued'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'ignored'; END IF;
  v_dead := (NOT COALESCE(p_retryable, false)) OR v_attempts >= p_max_attempts;
  UPDATE public.push_outbox
  SET attempts = v_attempts,
      last_error_code = p_error_code,
      last_error_message = left(p_error_message, 500),
      last_status_code = p_status_code,
      lease_expires_at = NULL, worker_id = NULL, updated_at = now(),
      status = CASE WHEN v_dead THEN 'dead' ELSE 'queued' END,
      dead_at = CASE WHEN v_dead THEN now() ELSE NULL END,
      next_attempt_at = CASE WHEN v_dead THEN next_attempt_at ELSE now() + make_interval(secs => p_retry_after_seconds) END
  WHERE id = p_id;
  RETURN CASE WHEN v_dead THEN 'dead' ELSE 'requeued' END;
END;
$$;

-- (5) 延期 (夜間): queued のまま次の時刻だけを動かす。attempts は増えない。p_until は今より後・2 日以内
CREATE OR REPLACE FUNCTION public.defer_push_outbox(p_id uuid, p_worker_id text, p_until timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_until IS NULL OR p_until <= now() OR p_until > now() + interval '2 days' THEN RAISE EXCEPTION 'p_until must be in the future and within 2 days' USING ERRCODE = '22023'; END IF;
  UPDATE public.push_outbox
  SET next_attempt_at = p_until, lease_expires_at = NULL, worker_id = NULL, updated_at = now()
  WHERE id = p_id AND worker_id = p_worker_id AND status = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- (6) receipt を確かめる行を取る: sent で、まだ確かめておらず、送ってから p_min_age_seconds 以上たった行。リースつき (SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_push_receipts(p_worker_id text, p_limit integer, p_min_age_seconds integer, p_lease_seconds integer)
RETURNS SETOF public.push_outbox LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF p_worker_id IS NULL OR char_length(p_worker_id) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'p_worker_id must be 1..128 chars' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000' USING ERRCODE = '22023'; END IF;
  IF p_min_age_seconds IS NULL OR p_min_age_seconds < 0 OR p_min_age_seconds > 86400 THEN RAISE EXCEPTION 'p_min_age_seconds must be 0..86400' USING ERRCODE = '22023'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'p_lease_seconds must be 1..3600' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
    FROM public.push_outbox o
    WHERE o.status = 'sent'
      AND o.receipt_checked_at IS NULL
      AND o.sent_at <= now() - make_interval(secs => p_min_age_seconds)
      AND (o.lease_expires_at IS NULL OR o.lease_expires_at < now())
    ORDER BY o.sent_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.push_outbox o
  SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      worker_id        = p_worker_id,
      updated_at       = now()
  FROM picked
  WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

-- (7) receipt の結果を残す。p_status が NULL なら「まだ無い」(リースだけ外し、次の回でまた確かめる)
CREATE OR REPLACE FUNCTION public.record_push_receipt(p_id uuid, p_worker_id text, p_status text, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('ok', 'error', 'missing') THEN RAISE EXCEPTION 'p_status must be ok / error / missing / NULL' USING ERRCODE = '22023'; END IF;
  UPDATE public.push_outbox
  SET receipt_checked_at = CASE WHEN p_status IS NULL THEN NULL ELSE now() END,
      receipt_status = p_status,
      receipt_error = CASE WHEN p_status IS NULL THEN NULL ELSE left(p_error, 128) END,
      lease_expires_at = NULL, worker_id = NULL, updated_at = now()
  WHERE id = p_id AND worker_id = p_worker_id AND status = 'sent' AND receipt_checked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- (8) 掃除: 24 時間を超えた queued (リースの無い行) を expired の dead にし、sent は 7 日・dead は 30 日で消す。
--     worker は EXPO_ACCESS_TOKEN が無い回もこれだけは呼ぶ (R-12。鍵の無い環境で行が増え続けない)
CREATE OR REPLACE FUNCTION public.cleanup_push_outbox()
RETURNS TABLE (expired integer, sent_deleted integer, dead_deleted integer) LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  c_queued_max_age CONSTANT interval := interval '24 hours'; -- PUSH_OUTBOX_QUEUED_MAX_AGE_MS と同じ (1 日たった通知は届けても意味が薄い。契約テストが突き合わせる)
  c_sent_retention CONSTANT interval := interval '7 days';   -- receipt の確認 (24 時間) を終えた後も、数日は結果を見られるように
  c_dead_retention CONSTANT interval := interval '30 days';  -- app_logs の保持 (30 日) と同じ
  v_expired integer;
  v_sent integer;
  v_dead integer;
BEGIN
  -- リース中の行 (worker が送っている最中) には触らない。その行は worker の decideEligibility が expired にする
  UPDATE public.push_outbox
  SET status = 'dead', dead_at = now(), last_error_code = 'expired', last_error_message = 'expired',
      lease_expires_at = NULL, worker_id = NULL, updated_at = now()
  WHERE status = 'queued'
    AND created_at < now() - c_queued_max_age
    AND (lease_expires_at IS NULL OR lease_expires_at < now());
  GET DIAGNOSTICS v_expired = ROW_COUNT;
  DELETE FROM public.push_outbox WHERE status = 'sent' AND sent_at < now() - c_sent_retention;
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  DELETE FROM public.push_outbox WHERE status = 'dead' AND dead_at < now() - c_dead_retention;
  GET DIAGNOSTICS v_dead = ROW_COUNT;
  RETURN QUERY SELECT v_expired, v_sent, v_dead;
END;
$$;

-- 権限 (8 本とも同じ書き方。20261010123500_ops_alert_state.sql と同じ理由で完全形の REVOKE)
REVOKE ALL ON FUNCTION public.enqueue_push_notification(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_push_notification(uuid, text, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.claim_push_outbox(text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_push_outbox(text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.complete_push_outbox(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_push_outbox(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.fail_push_outbox(uuid, text, text, text, integer, boolean, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_push_outbox(uuid, text, text, text, integer, boolean, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.defer_push_outbox(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.defer_push_outbox(uuid, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.claim_push_receipts(text, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_push_receipts(text, integer, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.record_push_receipt(uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_push_receipt(uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_push_outbox() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_push_outbox() TO service_role;
```

### 5.3 トリガー: `weekly_menu_requests` の最終の status → 登録 (同じ migration の続き)

```sql
-- 献立の依頼の最終の status (completed / failed) で、その利用者の端末に通知を積む (#1136 第 1 段の発火元)。
-- 書き手は 8 経路 (設計書 mobile/06-push-send.md §3.2.1: Edge Function generate-menu-v4 / v5・markWeeklyMenuRequestFailed・
-- process-menu-queue・claim_menu_request・止まった行の掃除・利用者の中止・手動の追加)。書き手は見分けず、行の列だけで決める:
--   積まない = failed で error_message が中止 / 止まった行の印、または target_slots の異なる date が c_min_days 日未満 (NULL を含む)。
-- 書き手の権限に依らず登録できるよう SECURITY DEFINER にする (所有者 = migration を流す postgres)。
-- 登録の失敗で献立の最終の書き込みを止めない (R-02): 例外は WARNING にして NEW を返す。
-- トリガー関数は呼び出しの権限を見ないので、EXECUTE は誰にも付けない (anon-definer-execute の番兵の対象)。
CREATE OR REPLACE FUNCTION public.enqueue_weekly_menu_result_push()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  -- 通知するのは 2 日以上にまたがる生成だけ (1 食・1 日の生成と作り直しは画面で結果を待つ操作。R-23)
  c_min_days CONSTANT integer := 2;
  -- supabase/functions/_shared/stored-failure-messages.ts の MENU_REQUEST_CANCELLED_MESSAGE / MENU_REQUEST_STALE_MESSAGE と同じ値
  -- (tests/push-outbox-migration-contract.test.ts が突き合わせる)。中止は本人の操作、止まった行の印は画面を開いたときにだけ書かれる
  c_cancelled_message CONSTANT text := '中止しました';
  c_stale_message CONSTANT text := 'stale_request_timeout';
  v_days integer;
BEGIN
  -- WHEN 句で絞ってあるが、関数だけでも同じ条件を守る
  IF NEW.status NOT IN ('completed', 'failed') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'failed' AND NEW.error_message IN (c_cancelled_message, c_stale_message) THEN RETURN NEW; END IF;
  IF NEW.target_slots IS NULL OR jsonb_typeof(NEW.target_slots) <> 'array' THEN RETURN NEW; END IF;
  SELECT count(DISTINCT s.slot ->> 'date') INTO v_days
  FROM jsonb_array_elements(NEW.target_slots) AS s(slot)
  WHERE jsonb_typeof(s.slot) = 'object';
  IF v_days < c_min_days THEN RETURN NEW; END IF;
  PERFORM public.enqueue_push_notification(
    NEW.user_id,
    CASE WHEN NEW.status = 'completed' THEN 'weekly_menu_completed' ELSE 'weekly_menu_failed' END,
    jsonb_build_object('request_id', NEW.id, 'start_date', NEW.start_date, 'mode', NEW.mode),
    'weekly_menu_result:' || NEW.id::text
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'enqueue_weekly_menu_result_push: % (request %)', SQLERRM, NEW.id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_weekly_menu_result_push() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS weekly_menu_requests_enqueue_push ON public.weekly_menu_requests;
CREATE TRIGGER weekly_menu_requests_enqueue_push
  AFTER UPDATE OF status ON public.weekly_menu_requests FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'failed'))
  EXECUTE FUNCTION public.enqueue_weekly_menu_result_push();
```

`dedupe_key` は `'weekly_menu_result:<依頼 ID>'` (端末ごとに `:<token>` が付く) なので、同じ依頼が completed のあと failed に書き換わっても 2 通目は作られない (1 つの依頼に通知は 1 回。R-10)。WHEN 句は status だけを見る (サブクエリを書けないため)。積むかどうかの残りの条件 (中止・止まりの印・日数) は関数の中の 3 つの `IF` が受け持つ (§7.1 の 2 つ目の表)。`count(DISTINCT …)` は `date` が NULL の要素を数えないので、`date` の無い要素だけの配列は 0 日になる。

### 5.4 ロールバック `<番号>_push_outbox.down.sql`

```sql
-- 先に worker の route (GET /api/cron/push-outbox) と vercel.json の行を戻すこと。表が無いと route の claim が失敗して 500 になる。
DROP TRIGGER IF EXISTS weekly_menu_requests_enqueue_push ON public.weekly_menu_requests;
DROP FUNCTION IF EXISTS public.enqueue_weekly_menu_result_push();
DROP FUNCTION IF EXISTS public.cleanup_push_outbox();
DROP FUNCTION IF EXISTS public.record_push_receipt(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.claim_push_receipts(text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.defer_push_outbox(uuid, text, timestamptz);
DROP FUNCTION IF EXISTS public.fail_push_outbox(uuid, text, text, text, integer, boolean, integer, integer);
DROP FUNCTION IF EXISTS public.complete_push_outbox(uuid, text, text);
DROP FUNCTION IF EXISTS public.claim_push_outbox(text, integer, integer);
DROP FUNCTION IF EXISTS public.enqueue_push_notification(uuid, text, jsonb, text);
DROP TABLE IF EXISTS public.push_outbox;
-- 送信待ち・送信済みの記録は戻らない。user_push_tokens・weekly_menu_requests の行は変えていないので、そのまま
```

## 6. 送信経路 (正典コード)

### 6.1 定数と環境変数

| 名前 | 値 | 根拠 | 変え方 |
|---|---|---|---|
| `PUSH_OUTBOX_MAX_ATTEMPTS` (定数 3) | worker がその行を処理する回数の上限。3 回目の失敗で dead | 間隔の表と合わせて約 21 分。Push は時間が大事で、それ以上待って届けても意味が薄い | 環境変数 `PUSH_OUTBOX_MAX_ATTEMPTS` (1〜10。`fail_push_outbox` の上限) |
| `PUSH_OUTBOX_RETRY_DELAYS_SECONDS` | `[60, 300, 900]` (n 回目の失敗のあとの待ち。表より多い回は最後の値) | 1 分・5 分・15 分 (Expo 公式の「指数バックオフ」) | 定数 (変えるときは本書) |
| `PUSH_OUTBOX_BATCH_SIZE` (定数 100) | 1 回の worker が取る行数 | Expo の 1 要求 (100 件) にちょうど収まる。500 でも 5 要求 (≈ 数秒) | 環境変数 `PUSH_OUTBOX_BATCH_SIZE` (1〜500。`claim_push_outbox` の上限) |
| `EXPO_PUSH_SEND_CHUNK_SIZE` / `EXPO_PUSH_RECEIPT_CHUNK_SIZE` | 100 / 1000 | Expo の 1 要求の上限 (`PUSH_TOO_MANY_NOTIFICATIONS` / `PUSH_TOO_MANY_RECEIPTS`) | 変えない (Expo の仕様) |
| `PUSH_OUTBOX_LEASE_SECONDS` | 120 | 1 回の実行 (最長 60 秒) の 2 倍。切れた行は次の回が取り直す | 定数 |
| `PUSH_OUTBOX_RUN_BUDGET_MS` | 40,000 | 応答を返す余裕を残して打ち切る (残りは次の回へ) | 定数 |
| `PUSH_OUTBOX_QUEUED_MAX_AGE_MS` | 24 時間 | 1 日たった「献立ができました」は届けても意味が薄い。超えた queued は `expired` で dead (claim した行は `decideEligibility`、取られない行は `cleanup_push_outbox` の `c_queued_max_age`。2 つの値は契約テストが突き合わせる) | 定数 (SQL と一緒に変える) |
| 献立の結果を積む最小の日数 | 2 (トリガーの `c_min_days`) | 1 食・1 日の生成と作り直しは画面で結果を待つ操作 (R-23) | 定数 (SQL) |
| `PUSH_RECEIPT_CHECK_DELAY_SECONDS` / `PUSH_RECEIPT_MAX_AGE_SECONDS` | 900 / 86,400 | Expo 公式: receipt は約 15 分後から取れ、24 時間で消える | 定数 |
| `PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES` | 540 (JST) | `user_profiles` に時刻帯が無く、Asia/Tokyo に夏時間が無い | 定数 (利用者ごとの時刻帯を足すときの差し替え点) |
| `PUSH_QUIET_HOURS_DEFAULT_START_MINUTES` / `_END_MINUTES` | 22:00 / 07:00 | `notification_preferences.quiet_hours_start/end` の既定と同じ (列が NULL のときに使う) | 定数 |
| token の長さの上限 | 256 文字 (`push_outbox.expo_push_token` の CHECK・`enqueue_push_notification` の `c_max_token_chars`) | 既存の `MAX_EXPO_PUSH_TOKEN_LENGTH` (`src/lib/push-tokens.ts`。worker の `isExpoPushToken` もこの値で見る) と同じ。3 つの値は契約テストが突き合わせる | 定数 (SQL と `push-tokens.ts` を一緒に変える) |
| payload の上限 | 2,048 バイト (`push_outbox.payload` の CHECK と RPC) | Expo の全体の上限 4 KiB の半分 (title / body / data の残りを確保) | 定数 (SQL) |
| sent / dead の保持 | 7 日 / 30 日 (`cleanup_push_outbox` の定数) | §5.2 (8) | 定数 (SQL) |
| `EXPO_ACCESS_TOKEN` | Expo のアクセストークン (`expo.dev/settings/access-tokens`) | Enhanced push security を ON にした Expo プロジェクトは、無い要求を `UNAUTHORIZED` で拒む。無ければ送らず掃除だけ (R-12) | Vercel の環境変数 (production / preview)。ローカルは `.env.local` |

環境変数 3 つは `src/lib/env.ts` の `SERVER_ENV_VARS` に `required: false`・`readOnlyBy: 'src/app/api/cron/push-outbox/route.ts'` で足し、`.env.example` と `ENV_SETUP.md` に書く (§11 段 B・§13.2 の `ENV_SETUP.md`・`.env.example` の行)。値を読むのは route だけで、解釈 (`resolvePushOutboxSettings`) は純粋な関数。不正な値は既定に戻し、変数名だけを warn に残す (`resolveAppLogAlertSettings` と同じ)。

`SERVER_ENV_VARS` に足す 3 項目 (逐語。置き場所は `OPS_ALERT_COOLDOWN_MINUTES` の項目の直後。`readOnlyBy` を持つ任意の変数には `whenMissing` が必須: `src/__tests__/lib/env.test.ts`):

```ts
// tsc:skip — src/lib/env.ts の SERVER_ENV_VARS のオブジェクトリテラルに挿す 3 項目 (断片)
  EXPO_ACCESS_TOKEN: {
    required: false,
    description:
      'Expo Push Service のアクセストークン (#1136)。GET /api/cron/push-outbox が Expo に通知を送るときに Authorization: Bearer で付ける。' +
      'Expo プロジェクトの Enhanced push security を ON にしたうえで、expo.dev/settings/access-tokens で作る',
    whenMissing: 'Push 通知を送らない (cron は warn ログを 1 行残し、掃除だけをする: 24 時間を超えた送信待ちの行を expired にし、送信済みは 7 日・届けられなかった行は 30 日で消す)',
    // 未設定の扱い (warn のログと応答の status) を、送信待ちの cron の route 1 か所に置いている
    readOnlyBy: 'src/app/api/cron/push-outbox/route.ts',
  },
  PUSH_OUTBOX_MAX_ATTEMPTS: {
    required: false,
    description: 'Push 通知の送信待ち (push_outbox) の試行の上限 (#1136)。これだけ失敗したら届けられなかった (dead) にする。1〜10 の整数',
    whenMissing: '既定の 3 回を使う (不正な値のときも既定値に戻し、warn ログを残す)',
    readOnlyBy: 'src/app/api/cron/push-outbox/route.ts',
  },
  PUSH_OUTBOX_BATCH_SIZE: {
    required: false,
    description: 'Push 通知の送信待ち (push_outbox) を 1 回の cron (毎分) で取り出して送る件数の上限 (#1136)。1〜500 の整数',
    whenMissing: '既定の 100 件を使う (不正な値のときも既定値に戻し、warn ログを残す)',
    readOnlyBy: 'src/app/api/cron/push-outbox/route.ts',
  },
```

### 6.2 種類の一覧と文面

#### `packages/shared/src/push-notification-kinds.ts` (新設・型検査の対象。`packages/shared/src/index.ts` に `export * from './push-notification-kinds';` を足す)

```ts
/**
 * サーバーから送る Push 通知の種類 (kind) と、種類ごとの方針 (#1136)。
 * サーバー (src/lib/push)・モバイル (将来の種類ごとの受け取り設定)・テストで同じ値を使うための、純粋な定数だけのファイル。
 * 文面 (title / body) はサーバーの src/lib/push/render.ts にあり、ここには置かない。
 * 種類を足すときは、ここに 1 行、render.ts に文面、発火元 (RPC enqueue_push_notification を呼ぶトリガーかコード) を足す
 * (docs/design/mobile/06-push-send.md §3.2)。行き先 path は apps/mobile/src/lib/notificationRoute.ts の NOTIFICATION_ROUTES にある画面だけ
 * (tests/push-kinds-routes-contract.test.ts が突き合わせる)。
 */

/** 最初に出す種類 (第 1 段)。後回しの種類は設計書 §3.2 */
export const PUSH_NOTIFICATION_KINDS = ['weekly_menu_completed', 'weekly_menu_failed'] as const;
export type PushNotificationKind = (typeof PUSH_NOTIFICATION_KINDS)[number];

/** Quiet Hours (夜間) の扱い。send = 夜でも送る / defer = 夜の終わりまで待つ */
export type PushQuietHoursPolicy = 'send' | 'defer';

export interface PushNotificationKindSpec {
  readonly kind: PushNotificationKind;
  /** 設定画面などに出す日本語の名前 */
  readonly label: string;
  /** 通知をタップしたときに開くアプリ内のパス (NOTIFICATION_ROUTES にある画面だけ) */
  readonly path: string;
  readonly quietHours: PushQuietHoursPolicy;
  /** Expo に渡す ttl (秒)。届かないまま過ぎたら捨てられる */
  readonly ttlSeconds: number;
  readonly priority: 'default' | 'high';
}

/** 献立の結果の通知の ttl。利用者が自分で頼んだ献立の結果は、翌日まで届けば十分 */
const MENU_RESULT_TTL_SECONDS = 24 * 60 * 60;
/** 献立のタブ (apps/mobile/app/(tabs)/menus.tsx。タブの WebView が Web の /menus/weekly を出す) */
const MENUS_TAB_PATH = '/menus';

export const PUSH_NOTIFICATION_KIND_SPECS: Readonly<Record<PushNotificationKind, PushNotificationKindSpec>> = {
  weekly_menu_completed: {
    kind: 'weekly_menu_completed',
    label: '献立ができたとき',
    path: MENUS_TAB_PATH,
    // 利用者が自分で頼んだ結果で、待っている間に届くことに意味がある (夜に頼んだ人は夜に受け取る)
    quietHours: 'send',
    ttlSeconds: MENU_RESULT_TTL_SECONDS,
    priority: 'default',
  },
  weekly_menu_failed: {
    kind: 'weekly_menu_failed',
    label: '献立を作れなかったとき',
    path: MENUS_TAB_PATH,
    quietHours: 'send',
    ttlSeconds: MENU_RESULT_TTL_SECONDS,
    priority: 'default',
  },
};

export function isPushNotificationKind(value: unknown): value is PushNotificationKind {
  return typeof value === 'string' && (PUSH_NOTIFICATION_KINDS as readonly string[]).includes(value);
}
```

#### `src/lib/push/render.ts` (新設。型 `RenderedPushMessage` は §6.3 の `outbox.ts` から import する)

種類ごとの文面。payload は Zod で検証し、形が違えば null (worker が `invalid_payload` で dead にする)。文面に利用者の名前・メールアドレスは入れない (入れるのは日付と依頼 ID だけ)。

```ts
// tsc:skip — 型 RenderedPushMessage を ./outbox (新設。この型の正) から import するので、木に入ってから型が付く
/**
 * Push 通知の文面 (#1136)。種類 (kind) と payload (push_outbox.payload) から title / body / data を作る。
 * 行き先 path は呼び出し側 (worker) が種類の方針 (packages/shared の PUSH_NOTIFICATION_KIND_SPECS) から渡す。
 * 文面は固定の日本語で、個人を特定する文字列 (名前・メールアドレス) は入れない。
 */
import { z } from 'zod';
import type { RenderedPushMessage } from './outbox';

/** 献立の結果 (weekly_menu_completed / weekly_menu_failed) の payload。トリガー weekly_menu_requests_enqueue_push (関数 enqueue_weekly_menu_result_push) が入れる */
export const WeeklyMenuResultPayloadSchema = z.object({
  request_id: z.uuid(),
  start_date: z.iso.date(),
  mode: z.string().max(32).nullable().optional(),
});
export type WeeklyMenuResultPayload = z.infer<typeof WeeklyMenuResultPayloadSchema>;

const WEEKLY_MENU_COMPLETED_TITLE = '献立ができました';
/**
 * 失敗の本文は日付だけで、理由 (同意・1 日の上限・生成の失敗など) も理由の確認も書かない。
 * 通知から開く献立のタブの WebView (Web の週の画面 src/app/(main)/menus/weekly/page.tsx) が error_message を出すのは追跡中の依頼の失敗だけで、
 * 起動時の GET /api/ai/menu/weekly/pending は failed の行を返さないため、開いても理由は出ない (設計書 §3.2・§14)
 */
const WEEKLY_MENU_FAILED_TITLE = '献立を作れませんでした';

/** 'YYYY-MM-DD' → 'M月D日' (JST の暦日をそのまま読む。時刻帯の変換はしない) */
export function formatMonthDay(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return `${month}月${day}日`;
}

/**
 * 種類と payload から文面を作る。知らない種類・形の違う payload は null。
 * @param kind push_outbox.kind
 * @param payload push_outbox.payload
 * @param path 種類の方針の path (worker が渡す)
 */
export function renderPushMessage(kind: string, payload: Record<string, unknown>, path: string): RenderedPushMessage | null {
  switch (kind) {
    case 'weekly_menu_completed': {
      const parsed = WeeklyMenuResultPayloadSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        title: WEEKLY_MENU_COMPLETED_TITLE,
        body: `${formatMonthDay(parsed.data.start_date)}からの献立ができました。開いて確認しましょう`,
        data: { kind, path, request_id: parsed.data.request_id },
      };
    }
    case 'weekly_menu_failed': {
      const parsed = WeeklyMenuResultPayloadSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        title: WEEKLY_MENU_FAILED_TITLE,
        body: `${formatMonthDay(parsed.data.start_date)}からの献立を作れませんでした`,
        data: { kind, path, request_id: parsed.data.request_id },
      };
    }
    default:
      return null;
  }
}
```

`tests/push-kinds-routes-contract.test.ts` (§10) が、`PUSH_NOTIFICATION_KINDS` の全部について (a) `renderPushMessage` が null でない文面を返す (正しい payload で)、(b) `PUSH_NOTIFICATION_KIND_SPECS[kind].path` が `resolveNotificationHref({ path })` で同じ値に解決される (= `NOTIFICATION_ROUTES` にある) ことを確かめる。

### 6.3 `src/lib/push/outbox.ts` (新設・純粋な処理。型検査の対象)

DB (`store`)・Expo (`transport`)・種類の方針 (`kinds`)・文面 (`render`)・時計 (`now`)・ログ (`log`) は引数で受け取る。`process.env` も `fetch` も読まない。送る条件 (§6.3 の `decideEligibility`) と夜間の判定はここに 1 か所だけ。

```ts
/**
 * Push 通知の送信待ち (push_outbox) — 定数・型・Zod・worker の本体 (#1136)。DB と Expo は引数で受け取る (純粋)。
 * 登録は DB (enqueue_push_notification。トリガーが呼ぶ)、worker の起動は src/app/api/cron/push-outbox/route.ts、
 * DB の読み書きは src/lib/push/outbox-store.ts、Expo への HTTP は src/lib/push/expo-transport.ts、文面は src/lib/push/render.ts。
 */
import { z } from 'zod';
import { isAccountFrozen } from '@/lib/auth/frozen';
import { isExpoPushToken } from '@/lib/push-tokens';
import { hasAcceptedCurrentLegalDocuments } from '@homegohan/shared';

// ── 定数 (§6.1) ────────────────────────────────────────────────────────────
/** worker がその行を処理する回数の上限 (既定)。PUSH_OUTBOX_MAX_ATTEMPTS で上書き。DB の fail_push_outbox が決める */
export const PUSH_OUTBOX_MAX_ATTEMPTS = 3;
export const PUSH_OUTBOX_MAX_ATTEMPTS_MIN = 1;
export const PUSH_OUTBOX_MAX_ATTEMPTS_MAX = 10;
/** n 回目の失敗のあと、次の試行まで待つ秒数 (1 分・5 分・15 分)。表より多い回は最後の値 */
export const PUSH_OUTBOX_RETRY_DELAYS_SECONDS: readonly number[] = [60, 300, 900];
/** 1 回の worker が取る行数 (既定)。PUSH_OUTBOX_BATCH_SIZE で上書き。claim_push_outbox の上限は 500 */
export const PUSH_OUTBOX_BATCH_SIZE = 100;
export const PUSH_OUTBOX_BATCH_SIZE_MIN = 1;
export const PUSH_OUTBOX_BATCH_SIZE_MAX = 500;
/** Expo の 1 要求の上限 (送信 100 件・receipt 1000 件) */
export const EXPO_PUSH_SEND_CHUNK_SIZE = 100;
export const EXPO_PUSH_RECEIPT_CHUNK_SIZE = 1000;
/** 取った行のリース (秒)。1 回の実行 (最長 60 秒) の 2 倍。切れた行は次の回が取り直す */
export const PUSH_OUTBOX_LEASE_SECONDS = 120;
/** 1 回の実行で送るのに使う時間の上限 (ミリ秒)。超えたら残りを次の回に回す (maxDuration 60 秒に収める) */
export const PUSH_OUTBOX_RUN_BUDGET_MS = 40_000;
/** これより古い queued は送らず expired で dead にする (1 日たった「献立ができました」は届けても意味が薄い) */
export const PUSH_OUTBOX_QUEUED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** receipt を確かめ始めるまでの時間と、諦めるまでの時間 (Expo 公式: 約 15 分後から取れ、24 時間で消える) */
export const PUSH_RECEIPT_CHECK_DELAY_SECONDS = 15 * 60;
export const PUSH_RECEIPT_MAX_AGE_SECONDS = 24 * 60 * 60;
/** 夜間の判定の時計。JST (UTC+9) 固定。利用者ごとの時刻帯を足すときはここを利用者の値に置き換える */
export const PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES = 9 * 60;
/** notification_preferences.quiet_hours_start/end が NULL のときの既定 (列の既定と同じ 22:00 / 07:00) */
export const PUSH_QUIET_HOURS_DEFAULT_START_MINUTES = 22 * 60;
export const PUSH_QUIET_HOURS_DEFAULT_END_MINUTES = 7 * 60;
/** Android の通知チャンネル。アプリが登録時に作る "default" (apps/mobile/src/lib/pushNotifications.ts) */
export const EXPO_DEFAULT_ANDROID_CHANNEL_ID = 'default';
/** Expo の ticket / receipt の error のうち、端末の行を消すもの */
export const EXPO_DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';
/** 429: この回の送信をやめて次の回に回す (Expo 公式の上限 600 通/秒) */
export const HTTP_TOO_MANY_REQUESTS = 429;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
/** ログに出す token の末尾の文字数 (全体は出さない) */
const PUSH_TOKEN_SUFFIX_CHARS = 4;

/** 行の last_error_code に入る、こちらで決めた値 (Expo の error はその名前のまま入る: DeviceNotRegistered など) */
export const PUSH_OUTBOX_ERROR_CODES = {
  ACCOUNT_FROZEN: 'account_frozen',
  CONSENT_OUTDATED: 'consent_outdated',
  NOTIFICATIONS_DISABLED: 'notifications_disabled',
  PROFILE_MISSING: 'profile_missing',
  EXPIRED: 'expired',
  /** token が Expo の push token の形でない (isExpoPushToken が false)。Expo に渡さない (同じ要求のほかの行を巻き込まない。R-24) */
  INVALID_TOKEN: 'invalid_token',
  UNKNOWN_KIND: 'unknown_kind',
  INVALID_PAYLOAD: 'invalid_payload',
  NETWORK_ERROR: 'network_error',
  INVALID_RESPONSE: 'invalid_response',
  HTTP_ERROR: 'expo_http_error',
  TICKET_ERROR: 'expo_ticket_error',
} as const;

// ── 型・Zod ────────────────────────────────────────────────────────────────
export type PushPriority = 'default' | 'normal' | 'high';
/** Expo に渡す 1 件 (docs.expo.dev/push-notifications/sending-notifications の message) */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  channelId: string;
  priority: PushPriority;
  ttl: number;
}
const ExpoErrorDetailsSchema = z.object({ error: z.string().optional() }).optional();
export const ExpoPushTicketSchema = z.union([
  z.object({ status: z.literal('ok'), id: z.string().min(1) }),
  z.object({ status: z.literal('error'), message: z.string().optional(), details: ExpoErrorDetailsSchema }),
]);
export type ExpoPushTicket = z.infer<typeof ExpoPushTicketSchema>;
export const ExpoPushReceiptSchema = z.union([
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), message: z.string().optional(), details: ExpoErrorDetailsSchema }),
]);
export type ExpoPushReceipt = z.infer<typeof ExpoPushReceiptSchema>;
export interface PushTransportFailure { code: string; message: string; statusCode: number | null; retryable: boolean }
export type PushSendOutcome = { ok: true; tickets: ExpoPushTicket[] } | { ok: false; failure: PushTransportFailure };
export type PushReceiptsOutcome = { ok: true; receipts: Record<string, ExpoPushReceipt> } | { ok: false; failure: PushTransportFailure };
export interface PushTransport {
  send(messages: readonly PushMessage[]): Promise<PushSendOutcome>;
  getReceipts(receiptIds: readonly string[]): Promise<PushReceiptsOutcome>;
}

export const PushOutboxClaimedRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  push_token_id: z.uuid(),
  expo_push_token: z.string().min(1),
  kind: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  attempts: z.number().int().nonnegative(),
  created_at: z.string().min(1),
});
export type PushOutboxClaimedRow = z.infer<typeof PushOutboxClaimedRowSchema>;
export const PushOutboxReceiptRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  push_token_id: z.uuid(),
  expo_push_token: z.string().min(1),
  receipt_id: z.string().min(1),
  sent_at: z.string().min(1),
});
export type PushOutboxReceiptRow = z.infer<typeof PushOutboxReceiptRowSchema>;
/** RPC の戻り (SETOF push_outbox) から、worker が使う列だけを検証して取り出す。形が違えば throw (route が 500 にする) */
export function parseClaimedRows(rows: unknown): PushOutboxClaimedRow[] {
  return z.array(PushOutboxClaimedRowSchema).parse(rows);
}
export function parseReceiptRows(rows: unknown): PushOutboxReceiptRow[] {
  return z.array(PushOutboxReceiptRowSchema).parse(rows);
}

/** 送る条件の材料 (user_profiles + notification_preferences。行が無ければ prefs は既定) */
export interface PushUserEligibility {
  frozenAt: string | null;
  unbanAt: string | null;
  termsVersionAccepted: string | null;
  privacyVersionAccepted: string | null;
  notificationsEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}
/** 種類の方針のうち worker が使う部分 (packages/shared の PushNotificationKindSpec がこれを満たす) */
export interface PushKindPolicy { path: string; quietHours: 'send' | 'defer'; ttlSeconds: number; priority: 'default' | 'high' }
/** 文面 (この型の正はここ。render.ts は import する)。data はアプリに届き、path を NotificationRouter が行き先に使う */
export interface RenderedPushMessage { title: string; body: string; data: Record<string, unknown> }
export type PushOutboxFailOutcome = 'requeued' | 'dead' | 'ignored';
export interface PushOutboxFailInput {
  id: string; workerId: string; errorCode: string; errorMessage: string | null; statusCode: number | null;
  retryable: boolean; maxAttempts: number; retryAfterSeconds: number;
}
export interface PushOutboxStore {
  claimQueued(workerId: string, limit: number, leaseSeconds: number): Promise<PushOutboxClaimedRow[]>;
  loadEligibility(userIds: readonly string[]): Promise<ReadonlyMap<string, PushUserEligibility>>;
  complete(id: string, workerId: string, receiptId: string): Promise<boolean>;
  fail(input: PushOutboxFailInput): Promise<PushOutboxFailOutcome>;
  defer(id: string, workerId: string, untilIso: string): Promise<boolean>;
  claimReceipts(workerId: string, limit: number, minAgeSeconds: number, leaseSeconds: number): Promise<PushOutboxReceiptRow[]>;
  recordReceipt(id: string, workerId: string, status: 'ok' | 'error' | 'missing' | null, error: string | null): Promise<boolean>;
  /** user_push_tokens の行を消す (push_outbox の行は FK の CASCADE で消える)。消せたら true */
  deleteToken(pushTokenId: string): Promise<boolean>;
  /** cleanup_push_outbox: 24 時間を超えた queued を expired に・sent / dead を期限で消す。鍵が無い回も route が呼ぶ (R-12) */
  cleanup(): Promise<PushOutboxCleanupResult>;
}
export interface PushOutboxCleanupResult { expired: number; sent: number; dead: number }
export interface PushOutboxLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}
export interface PushOutboxWorkerDeps {
  store: PushOutboxStore;
  transport: PushTransport;
  kinds: Readonly<Record<string, PushKindPolicy | undefined>>;
  render: (kind: string, payload: Record<string, unknown>, path: string) => RenderedPushMessage | null;
  now: () => number;
  log: PushOutboxLogger;
}
export interface PushOutboxRunOptions { workerId: string; maxAttempts: number; batchSize: number; legalConsentEnforced: boolean }
export interface PushOutboxRunSummary {
  claimed: number; sent: number; requeued: number; deferred: number; dead: number; dead_codes: Record<string, number>;
  receipts_claimed: number; receipts_ok: number; receipts_error: number; receipts_missing: number; receipts_pending: number;
  tokens_removed: number; cleaned_expired: number; cleaned_sent: number; cleaned_dead: number; stopped_early: 'budget' | 'rate_limited' | null;
}

// ── 設定・小さな純粋関数 ──────────────────────────────────────────────────
export type PushOutboxSettingEnvName = 'PUSH_OUTBOX_MAX_ATTEMPTS' | 'PUSH_OUTBOX_BATCH_SIZE';
export interface PushOutboxSettingSources { maxAttempts: string | undefined; batchSize: string | undefined }
export interface PushOutboxSettings { maxAttempts: number; batchSize: number; ignored: PushOutboxSettingEnvName[] }
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): { value: number; ignored: boolean } {
  if (raw === undefined || raw.trim() === '') return { value: fallback, ignored: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return { value: fallback, ignored: true };
  return { value: n, ignored: false };
}
/** 環境変数の値を解釈する。範囲外・整数でない値は既定に戻し、名前を ignored に入れる (route が warn に書く) */
export function resolvePushOutboxSettings(sources: PushOutboxSettingSources): PushOutboxSettings {
  const attempts = boundedInt(sources.maxAttempts, PUSH_OUTBOX_MAX_ATTEMPTS, PUSH_OUTBOX_MAX_ATTEMPTS_MIN, PUSH_OUTBOX_MAX_ATTEMPTS_MAX);
  const batch = boundedInt(sources.batchSize, PUSH_OUTBOX_BATCH_SIZE, PUSH_OUTBOX_BATCH_SIZE_MIN, PUSH_OUTBOX_BATCH_SIZE_MAX);
  const ignored: PushOutboxSettingEnvName[] = [];
  if (attempts.ignored) ignored.push('PUSH_OUTBOX_MAX_ATTEMPTS');
  if (batch.ignored) ignored.push('PUSH_OUTBOX_BATCH_SIZE');
  return { maxAttempts: attempts.value, batchSize: batch.value, ignored };
}
/** n 回目 (1 始まり) の失敗のあとに待つ秒数 */
export function retryDelaySeconds(failedAttempts: number): number {
  const index = Math.min(Math.max(failedAttempts, 1), PUSH_OUTBOX_RETRY_DELAYS_SECONDS.length) - 1;
  return PUSH_OUTBOX_RETRY_DELAYS_SECONDS[index] ?? 0;
}
/** ログに出す token: 'ExponentPushToken[…abcd]' (末尾 4 文字だけ) */
export function maskPushToken(token: string): string {
  const open = token.indexOf('[');
  const inner = open > 0 && token.endsWith(']') ? token.slice(open + 1, -1) : token;
  const suffix = inner.slice(-PUSH_TOKEN_SUFFIX_CHARS);
  return open > 0 ? `${token.slice(0, open)}[…${suffix}]` : `…${suffix}`;
}
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const CLOCK_PATTERN = /^(\d{2}):(\d{2})/;
/** 'HH:MM:SS' (time 列の文字列) → その日の分。形が違えば fallback */
export function parseClockMinutes(value: string | null | undefined, fallback: number): number {
  const match = value ? CLOCK_PATTERN.exec(value) : null;
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}
/** 時刻帯のずれ (分) を足した、その日の分 (0〜1439) */
export function localMinutesOfDay(nowMs: number, offsetMinutes: number): number {
  const total = Math.floor(nowMs / MS_PER_MINUTE) + offsetMinutes;
  return ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}
/** 夜間か。start = end は「夜間なし」。日付をまたぐ (22:00〜07:00) 形にも対応 */
export function isWithinQuietHours(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes;
}
/** 夜間の終わり (次の endMinutes) の時刻 (ms)。分の切り捨てから数える */
export function quietHoursEndMs(nowMs: number, nowMinutes: number, endMinutes: number): number {
  const delta = (((endMinutes - nowMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return Math.floor(nowMs / MS_PER_MINUTE) * MS_PER_MINUTE + delta * MS_PER_MINUTE;
}
export type PushEligibility = { ok: true } | { ok: false; code: string };
/** 送る条件 (§7.1 の行)。順に、プロフィール無し → 期限切れ → token の形 → 凍結 → 未同意 (強制のときだけ) → 設定 off */
export function decideEligibility(
  row: PushOutboxClaimedRow,
  user: PushUserEligibility | undefined,
  options: { nowMs: number; legalConsentEnforced: boolean },
): PushEligibility {
  if (!user) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.PROFILE_MISSING };
  if (options.nowMs - Date.parse(row.created_at) > PUSH_OUTBOX_QUEUED_MAX_AGE_MS) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.EXPIRED };
  if (!isExpoPushToken(row.expo_push_token)) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.INVALID_TOKEN };
  if (isAccountFrozen({ frozenAt: user.frozenAt, unbanAt: user.unbanAt })) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.ACCOUNT_FROZEN };
  if (
    options.legalConsentEnforced &&
    !hasAcceptedCurrentLegalDocuments({ terms_version_accepted: user.termsVersionAccepted, privacy_version_accepted: user.privacyVersionAccepted })
  ) {
    return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.CONSENT_OUTDATED };
  }
  if (!user.notificationsEnabled) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.NOTIFICATIONS_DISABLED };
  return { ok: true };
}
/**
 * Expo が要求ごと拒んだ (HTTP 4xx。429 を除く) か。拒まれた要求は 1 件も送られていないので、分けて送り直しても 2 通は届かない。
 * 429・5xx・通信エラー (retryable) と、応答の形の誤り (statusCode null。Expo が受け付けたあとかもしれない) は false
 */
export function isRequestLevelRejection(failure: PushTransportFailure): boolean {
  return !failure.retryable && failure.statusCode !== null;
}

// ── worker の本体 ──────────────────────────────────────────────────────────
type Pending = { row: PushOutboxClaimedRow; message: PushMessage };
type RowRef = Pick<PushOutboxClaimedRow, 'id' | 'user_id' | 'push_token_id' | 'expo_push_token' | 'kind' | 'attempts'>;

async function recordFailure(
  deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions, summary: PushOutboxRunSummary, row: RowRef, failure: PushTransportFailure,
): Promise<void> {
  const outcome = await deps.store.fail({
    id: row.id, workerId: options.workerId, errorCode: failure.code, errorMessage: failure.message, statusCode: failure.statusCode,
    retryable: failure.retryable, maxAttempts: options.maxAttempts, retryAfterSeconds: retryDelaySeconds(row.attempts + 1),
  });
  if (outcome === 'requeued') summary.requeued += 1;
  if (outcome === 'dead') {
    summary.dead += 1;
    summary.dead_codes[failure.code] = (summary.dead_codes[failure.code] ?? 0) + 1;
    deps.log.warn('Push 通知を届けられませんでした', {
      kind: row.kind, user_id: row.user_id, token: maskPushToken(row.expo_push_token),
      error_code: failure.code, status_code: failure.statusCode, attempts: row.attempts + 1,
    });
  }
}
function notSent(code: string): PushTransportFailure {
  return { code, message: code, statusCode: null, retryable: false };
}
async function removeToken(deps: PushOutboxWorkerDeps, summary: PushOutboxRunSummary, row: RowRef): Promise<void> {
  if (await deps.store.deleteToken(row.push_token_id)) {
    summary.tokens_removed += 1;
    deps.log.warn('端末の行を消しました (DeviceNotRegistered)', { user_id: row.user_id, token: maskPushToken(row.expo_push_token) });
  }
}

async function sendQueued(deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions, summary: PushOutboxRunSummary, startedAt: number): Promise<void> {
  const rows = await deps.store.claimQueued(options.workerId, options.batchSize, PUSH_OUTBOX_LEASE_SECONDS);
  summary.claimed = rows.length;
  if (rows.length === 0) return;
  const users = await deps.store.loadEligibility(Array.from(new Set(rows.map((row) => row.user_id))));
  const pending: Pending[] = [];
  for (const row of rows) {
    const nowMs = deps.now();
    const user = users.get(row.user_id);
    const eligibility = decideEligibility(row, user, { nowMs, legalConsentEnforced: options.legalConsentEnforced });
    if (!eligibility.ok) { await recordFailure(deps, options, summary, row, notSent(eligibility.code)); continue; }
    const policy = deps.kinds[row.kind];
    if (!policy) { await recordFailure(deps, options, summary, row, notSent(PUSH_OUTBOX_ERROR_CODES.UNKNOWN_KIND)); continue; }
    if (policy.quietHours === 'defer' && user) {
      const nowMinutes = localMinutesOfDay(nowMs, PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES);
      const start = parseClockMinutes(user.quietHoursStart, PUSH_QUIET_HOURS_DEFAULT_START_MINUTES);
      const end = parseClockMinutes(user.quietHoursEnd, PUSH_QUIET_HOURS_DEFAULT_END_MINUTES);
      if (isWithinQuietHours(nowMinutes, start, end)) {
        const until = new Date(quietHoursEndMs(nowMs, nowMinutes, end)).toISOString();
        if (await deps.store.defer(row.id, options.workerId, until)) summary.deferred += 1;
        continue;
      }
    }
    const rendered = deps.render(row.kind, row.payload, policy.path);
    if (!rendered) { await recordFailure(deps, options, summary, row, notSent(PUSH_OUTBOX_ERROR_CODES.INVALID_PAYLOAD)); continue; }
    pending.push({ row, message: {
      to: row.expo_push_token, title: rendered.title, body: rendered.body, data: rendered.data,
      sound: 'default', channelId: EXPO_DEFAULT_ANDROID_CHANNEL_ID, priority: policy.priority, ttl: policy.ttlSeconds,
    } });
  }
  for (const batch of chunk(pending, EXPO_PUSH_SEND_CHUNK_SIZE)) {
    if ((await sendBatch(deps, options, summary, batch, startedAt)) === 'stop') return;
  }
}

/**
 * 1 つの要求で送り、ticket を同じ順の行に対応させる。'stop' = この回の送信をやめる (時間切れ・429)。残りの行はリースのまま。
 * 要求ごと拒まれた 2 件以上の塊は、どの 1 件が原因か分からない (別の Expo プロジェクトの token が混ざった
 * PUSH_TOO_MANY_EXPERIENCE_IDS など) ので、1 件ずつの要求に分けて送り直し、失敗を原因の 1 件だけに留める (R-24)
 */
async function sendBatch(
  deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions, summary: PushOutboxRunSummary, batch: readonly Pending[], startedAt: number,
): Promise<'continue' | 'stop'> {
  // 時間切れ: 残りはリースが切れたあとの回が取り直す (attempts は増えない)
  if (deps.now() - startedAt > PUSH_OUTBOX_RUN_BUDGET_MS) { summary.stopped_early = 'budget'; return 'stop'; }
  const outcome = await deps.transport.send(batch.map((item) => item.message));
  if (!outcome.ok) {
    if (batch.length > 1 && isRequestLevelRejection(outcome.failure)) {
      deps.log.warn('Expo が要求ごと拒んだため、1 件ずつ送り直します', {
        error_code: outcome.failure.code, status_code: outcome.failure.statusCode, count: batch.length,
      });
      for (const item of batch) {
        if ((await sendBatch(deps, options, summary, [item], startedAt)) === 'stop') return 'stop';
      }
      return 'continue';
    }
    for (const item of batch) await recordFailure(deps, options, summary, item.row, outcome.failure);
    if (outcome.failure.statusCode === HTTP_TOO_MANY_REQUESTS) { summary.stopped_early = 'rate_limited'; return 'stop'; }
    return 'continue';
  }
  for (let index = 0; index < batch.length; index += 1) {
    const row = batch[index]!.row;
    const ticket = outcome.tickets[index];
    if (!ticket) { await recordFailure(deps, options, summary, row, notSent(PUSH_OUTBOX_ERROR_CODES.INVALID_RESPONSE)); continue; }
    if (ticket.status === 'ok') {
      if (await deps.store.complete(row.id, options.workerId, ticket.id)) summary.sent += 1;
      continue;
    }
    const code = ticket.details?.error ?? PUSH_OUTBOX_ERROR_CODES.TICKET_ERROR;
    await recordFailure(deps, options, summary, row, { code, message: ticket.message ?? code, statusCode: null, retryable: false });
    if (code === EXPO_DEVICE_NOT_REGISTERED) await removeToken(deps, summary, row);
  }
  return 'continue';
}

async function checkReceipts(deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions, summary: PushOutboxRunSummary): Promise<void> {
  const rows = await deps.store.claimReceipts(options.workerId, EXPO_PUSH_RECEIPT_CHUNK_SIZE, PUSH_RECEIPT_CHECK_DELAY_SECONDS, PUSH_OUTBOX_LEASE_SECONDS);
  summary.receipts_claimed = rows.length;
  if (rows.length === 0) return;
  const outcome = await deps.transport.getReceipts(rows.map((row) => row.receipt_id));
  if (!outcome.ok) {
    deps.log.warn('Expo の receipt を取れませんでした (次の回で確かめ直します)', { error_code: outcome.failure.code, status_code: outcome.failure.statusCode, count: rows.length });
    for (const row of rows) await deps.store.recordReceipt(row.id, options.workerId, null, null);
    summary.receipts_pending += rows.length;
    return;
  }
  const nowMs = deps.now();
  for (const row of rows) {
    const receipt = outcome.receipts[row.receipt_id];
    if (!receipt) {
      const gaveUp = nowMs - Date.parse(row.sent_at) > PUSH_RECEIPT_MAX_AGE_SECONDS * MS_PER_SECOND;
      await deps.store.recordReceipt(row.id, options.workerId, gaveUp ? 'missing' : null, null);
      if (gaveUp) summary.receipts_missing += 1; else summary.receipts_pending += 1;
      continue;
    }
    if (receipt.status === 'ok') { await deps.store.recordReceipt(row.id, options.workerId, 'ok', null); summary.receipts_ok += 1; continue; }
    const code = receipt.details?.error ?? PUSH_OUTBOX_ERROR_CODES.TICKET_ERROR;
    await deps.store.recordReceipt(row.id, options.workerId, 'error', code);
    summary.receipts_error += 1;
    deps.log.warn('Push 通知の receipt がエラーでした', { receipt_error: code, user_id: row.user_id, token: maskPushToken(row.expo_push_token) });
    if (code === EXPO_DEVICE_NOT_REGISTERED) await removeToken(deps, summary, { ...row, kind: '', attempts: 0 });
  }
}

/** 1 回の実行: 送る → receipt を確かめる → 掃除。例外は投げたまま (route が 500 にする) */
export async function processPushOutbox(deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions): Promise<PushOutboxRunSummary> {
  const startedAt = deps.now();
  const summary: PushOutboxRunSummary = {
    claimed: 0, sent: 0, requeued: 0, deferred: 0, dead: 0, dead_codes: {},
    receipts_claimed: 0, receipts_ok: 0, receipts_error: 0, receipts_missing: 0, receipts_pending: 0,
    tokens_removed: 0, cleaned_expired: 0, cleaned_sent: 0, cleaned_dead: 0, stopped_early: null,
  };
  await sendQueued(deps, options, summary, startedAt);
  await checkReceipts(deps, options, summary);
  const cleaned = await deps.store.cleanup();
  summary.cleaned_expired = cleaned.expired;
  summary.cleaned_sent = cleaned.sent;
  summary.cleaned_dead = cleaned.dead;
  return summary;
}
```

### 6.4 `src/lib/push/expo-transport.ts` (新設。Expo を呼ぶ唯一のファイル)

`fetch` で 2 つの API を呼ぶ。応答は §6.3 の Zod (`ExpoPushTicketSchema` / `ExpoPushReceiptSchema`) で検証する。再試行の判定: 通信エラー・429・5xx → `retryable: true`、それ以外の 4xx・応答の形の誤り → `retryable: false` (Expo 公式)。要求単位のエラーの `details` (`PUSH_TOO_MANY_EXPERIENCE_IDS` のプロジェクト → token の対応など) は読まない。4xx (429 以外) を 2 件以上の塊で受けたときに 1 件ずつ送り直すのは worker (§6.3 `sendBatch`) で、transport は 1 回の要求の結果を返すだけ。

```ts
// tsc:skip — ./outbox (新設) の型を import するので、木に入ってから型が付く。送信先の URL は NON_AI_HOSTS に理由つきで載せる (§13.1)
import { z } from 'zod';
import {
  ExpoPushReceiptSchema, ExpoPushTicketSchema, HTTP_TOO_MANY_REQUESTS, PUSH_OUTBOX_ERROR_CODES,
  type PushMessage, type PushReceiptsOutcome, type PushSendOutcome, type PushTransport, type PushTransportFailure,
} from './outbox';

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** 429 (HTTP_TOO_MANY_REQUESTS。正は ./outbox) と 5xx は待てば直る (Expo 公式)。それ以外の 4xx は直らない */
const HTTP_SERVER_ERROR_MIN = 500;
const SendResponseSchema = z.object({ data: z.array(ExpoPushTicketSchema) });
const ReceiptsResponseSchema = z.object({ data: z.record(z.string(), ExpoPushReceiptSchema) });
const ErrorResponseSchema = z.object({ errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional() })) });

function httpFailure(status: number, body: unknown): PushTransportFailure {
  const parsed = ErrorResponseSchema.safeParse(body);
  const code = parsed.success ? (parsed.data.errors[0]?.code ?? PUSH_OUTBOX_ERROR_CODES.HTTP_ERROR) : PUSH_OUTBOX_ERROR_CODES.HTTP_ERROR;
  const message = parsed.success ? (parsed.data.errors[0]?.message ?? code) : code;
  return { code, message, statusCode: status, retryable: status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN };
}
async function post(url: string, accessToken: string, body: unknown, fetchImpl: typeof fetch): Promise<{ ok: true; json: unknown } | { ok: false; failure: PushTransportFailure }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, failure: { code: PUSH_OUTBOX_ERROR_CODES.NETWORK_ERROR, message: error instanceof Error ? error.message : String(error), statusCode: null, retryable: true } };
  }
  let json: unknown = null;
  try { json = await response.json(); } catch { json = null; }
  if (!response.ok) return { ok: false, failure: httpFailure(response.status, json) };
  return { ok: true, json };
}
/** accessToken は route が EXPO_ACCESS_TOKEN から渡す。fetchImpl はテストが差し替える */
export function createExpoTransport(accessToken: string, fetchImpl: typeof fetch = fetch): PushTransport {
  return {
    async send(messages: readonly PushMessage[]): Promise<PushSendOutcome> {
      const result = await post(EXPO_PUSH_SEND_URL, accessToken, messages, fetchImpl);
      if (!result.ok) return result;
      const parsed = SendResponseSchema.safeParse(result.json);
      if (!parsed.success || parsed.data.data.length !== messages.length) {
        return { ok: false, failure: { code: PUSH_OUTBOX_ERROR_CODES.INVALID_RESPONSE, message: 'Expo の応答が ticket の配列ではありません', statusCode: null, retryable: false } };
      }
      return { ok: true, tickets: parsed.data.data };
    },
    async getReceipts(receiptIds: readonly string[]): Promise<PushReceiptsOutcome> {
      const result = await post(EXPO_PUSH_RECEIPTS_URL, accessToken, { ids: receiptIds }, fetchImpl);
      if (!result.ok) return result;
      const parsed = ReceiptsResponseSchema.safeParse(result.json);
      if (!parsed.success) return { ok: false, failure: { code: PUSH_OUTBOX_ERROR_CODES.INVALID_RESPONSE, message: 'Expo の応答が receipt の表ではありません', statusCode: null, retryable: false } };
      return { ok: true, receipts: parsed.data.data };
    },
  };
}
```

### 6.5 `src/lib/push/outbox-store.ts` (新設・DB の読み書き。`database.types.ts` の作り直し後に型が付く)

`getSupabaseAdmin()` (service_role) だけを使う。RPC の名前と引数は §5.2 の逐語。`createOutboxStore(): PushOutboxStore`:

| メソッド | 実装 |
|---|---|
| `claimQueued(w, limit, lease)` | `rpc('claim_push_outbox', { p_worker_id: w, p_limit: limit, p_lease_seconds: lease })` → `parseClaimedRows(data)`。error は throw |
| `loadEligibility(userIds)` | `from('user_profiles').select('id, frozen_at, unban_at, terms_version_accepted, privacy_version_accepted').in('id', userIds)` と `from('notification_preferences').select('user_id, notifications_enabled, quiet_hours_start, quiet_hours_end').in('user_id', userIds)`。プロフィールの行がある利用者だけ Map に入れる (prefs の行が無ければ `notificationsEnabled: true`・quiet は null) |
| `complete(id, w, receiptId)` | `rpc('complete_push_outbox', { p_id, p_worker_id, p_receipt_id })` → boolean |
| `fail(input)` | `rpc('fail_push_outbox', { p_id, p_worker_id, p_error_code, p_error_message, p_status_code, p_retryable, p_max_attempts, p_retry_after_seconds })` → `'requeued' / 'dead' / 'ignored'` (それ以外は throw) |
| `defer(id, w, untilIso)` | `rpc('defer_push_outbox', { p_id, p_worker_id, p_until: untilIso })` → boolean |
| `claimReceipts(w, limit, minAge, lease)` | `rpc('claim_push_receipts', { p_worker_id, p_limit, p_min_age_seconds, p_lease_seconds })` → `parseReceiptRows(data)` |
| `recordReceipt(id, w, status, error)` | `rpc('record_push_receipt', { p_id, p_worker_id, p_status: status, p_error: error })` → boolean |
| `deleteToken(pushTokenId)` | `from('user_push_tokens').delete({ count: 'exact' }).eq('id', pushTokenId)` → `count > 0` |
| `cleanup()` | `rpc('cleanup_push_outbox')` → 1 行目を `{ expired: row.expired, sent: row.sent_deleted, dead: row.dead_deleted }` (行が無い・error は throw) |

### 6.6 `src/app/api/cron/push-outbox/route.ts` (新設・glue)

`app-log-alerts/route.ts` と同じ骨格: `export const runtime = 'nodejs'; dynamic = 'force-dynamic'; fetchCache = 'force-no-store'; maxDuration = 60;` `ROUTE_NAME = 'cron/push-outbox'`。応答のあとの延命 (以前の `LOG_FLUSH_GRACE_MS = 1000` と `waitUntil`) は持たない (#1922 48fc47bf で外した。ログの保存の完了は db-logger が待つ。#1913)。`GET` だけを公開する。

```ts
// tsc:skip — 新設モジュール (outbox / outbox-store / expo-transport / render / @homegohan/shared の kinds) が木に入ってから型が付く。順序と応答の形が正典
export async function GET(req: Request) {
  const authError = await requireCronAuth(req);                       // 1. 認証 (401 / 503)
  if (authError) return authError;
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);
  if (await isMaintenanceFlagOn()) { return NextResponse.json({ status: 'maintenance' }); }   // 2. メンテナンス中は何もせず次の回へ (R-14)
  try {
    const store = createOutboxStore();
    const accessToken = process.env.EXPO_ACCESS_TOKEN;                 // 3. 鍵が無ければ送らず、掃除だけ (R-12。変数名は warn にだけ書く)
    if (!accessToken) {
      const cleaned = await store.cleanup();
      logger.warn('EXPO_ACCESS_TOKEN が未設定のため、Push 通知を送りません (掃除だけをしました)', { ...cleaned });
      return NextResponse.json({ status: 'not_configured', cleaned_expired: cleaned.expired, cleaned_sent: cleaned.sent, cleaned_dead: cleaned.dead });
    }
    const settings = resolvePushOutboxSettings({ maxAttempts: process.env.PUSH_OUTBOX_MAX_ATTEMPTS, batchSize: process.env.PUSH_OUTBOX_BATCH_SIZE });
    if (settings.ignored.length > 0) logger.warn('Push の送信待ちの環境変数の値が正しくないため、既定値を使います', { ignored_env: settings.ignored });
    const summary = await processPushOutbox(                           // 4. 送る → receipt → 掃除
      { store, transport: createExpoTransport(accessToken), kinds: PUSH_NOTIFICATION_KIND_SPECS, render: renderPushMessage, now: Date.now, log: logger },
      { workerId: randomUUID(), maxAttempts: settings.maxAttempts, batchSize: settings.batchSize, legalConsentEnforced: isLegalConsentEnforced() },
    );
    if (summary.claimed > 0 || summary.receipts_claimed > 0 || summary.cleaned_expired > 0) logger.info('Push の送信待ちを処理しました', { ...summary });
    return NextResponse.json({ status: summary.claimed === 0 && summary.receipts_claimed === 0 ? 'idle' : 'processed', ...summary });
  } catch (err) {
    return internalError(ROUTE_NAME, err, { requestId });              // 5. RPC の失敗・応答の形の誤りは 500 (本文は汎用)
  }
}
```

import: `randomUUID` (`crypto`)・`NextResponse`・`requireCronAuth` (`@/lib/cron-auth`)・`internalError` (`@/lib/api/errors`)・`createLogger, generateRequestId` (`@/lib/db-logger`)・`isMaintenanceFlagOn` (`@/lib/maintenance-mode`)・`isLegalConsentEnforced` (`@/lib/legal-consent`)・`PUSH_NOTIFICATION_KIND_SPECS` (`@homegohan/shared`)・`processPushOutbox, resolvePushOutboxSettings` (`@/lib/push/outbox`)・`createOutboxStore` (`@/lib/push/outbox-store`)・`createExpoTransport` (`@/lib/push/expo-transport`)・`renderPushMessage` (`@/lib/push/render`)。応答 (JSON): `{ status: 'maintenance' }` / `{ status: 'not_configured', cleaned_expired, cleaned_sent, cleaned_dead }` / `{ status: 'idle' | 'processed', ...summary }` (`idle` = claim も receipt も 0 件。掃除の件数は summary に入る)。`vercel.json` の `crons` に `{ "path": "/api/cron/push-outbox", "schedule": "*/1 * * * *" }` を足す。

## 7. 表 3 点

### 7.1 全パターン表 (1 つ目 = claim した 1 行の入力 → 結果。判定は左の列から順 = §6.3 `sendQueued` の順: `decideEligibility` (プロフィール → 期限 → token の形 → 凍結 → 同意 → 設定) → 種類 → 夜間 → 文面 (payload) → Expo (`sendBatch`)。2 つ目 = 登録のトリガー)

| プロフィール | created_at | token の形 | 凍結 | 同意 (ENFORCE on) | notifications_enabled | 種類 | 夜間 × 方針 | payload | Expo の結果 | 行の結果 (`last_error_code`) |
|---|---|---|---|---|---|---|---|---|---|---|
| 無い | – | – | – | – | – | – | – | – | 呼ばない | dead (`profile_missing`) |
| ある | 24 時間より前 | – | – | – | – | – | – | – | 呼ばない | dead (`expired`) |
| ある | 以内 | 違う (`isExpoPushToken` が false) | – | – | – | – | – | – | 呼ばない | dead (`invalid_token`)。端末の行は消さない。同じ回のほかの行は送る (S-23) |
| ある | 以内 | 正しい | 凍結中 | – | – | – | – | – | 呼ばない | dead (`account_frozen`) |
| ある | 以内 | 正しい | なし | 未同意 (on) | – | – | – | – | 呼ばない | dead (`consent_outdated`)。off なら次の行へ |
| ある | 以内 | 正しい | なし | 同意済み | false | – | – | – | 呼ばない | dead (`notifications_disabled`) |
| ある | 以内 | 正しい | なし | 同意済み | true | 一覧に無い | – | – | 呼ばない | dead (`unknown_kind`) |
| ある | 以内 | 正しい | なし | 同意済み | true | ある | 夜間 × `defer` | – (まだ見ない) | 呼ばない | queued (`next_attempt_at` = 夜の終わり。attempts 不変)。payload は夜明けの回で見る (形が違えばその回で `invalid_payload`) |
| ある | 以内 | 正しい | なし | 同意済み | `notification_preferences` の行が無い (= true として扱う) | ある | 夜間は既定 22:00〜07:00 (quiet は null) で判定 | 〃 | 〃 | true の行と同じ: 夜間 × `defer` は 07:00 JST まで queued、それ以外は下の payload 以降の行 (既定を入れるのは §6.5 `loadEligibility`) |
| ある | 以内 | 正しい | なし | 同意済み | true・`quiet_hours_start/end` が NULL (または `HH:MM` で始まらない) | ある | 夜間は既定 22:00〜07:00 で判定 (`parseClockMinutes` の fallback) | 〃 | 〃 | 同上 |
| ある | 以内 | 正しい | なし | 同意済み | true | ある | 昼 × `send` / `defer`、夜間 × `send` | 形が違う | 呼ばない | dead (`invalid_payload`) |
| 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 正しい | ticket ok | sent (`receipt_id`)。15 分後に receipt → `receipt_status` ok / error / missing |
| 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 正しい | ticket `DeviceNotRegistered` | dead → 端末の行を消す → CASCADE で行も消える |
| 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 正しい | ticket のほかの error | dead (error の名前。例 `MessageTooBig`) |
| 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 正しい | HTTP 429 / 5xx / 通信エラー (塊でも 1 件でも) | queued (attempts + 1・次は 1 分 → 5 分 → 15 分)。3 回目で dead。429 はこの回を打ち切る (1 件ずつの送り直しの途中でも) |
| 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 正しい | 呼ばない (その要求 (塊、または 1 件ずつの送り直しの 1 件) の前で時間切れ `PUSH_OUTBOX_RUN_BUDGET_MS`、または前の要求が 429 で打ち切り。`stopped_early` = `budget` / `rate_limited`) | queued のまま (リースのまま残し、`PUSH_OUTBOX_LEASE_SECONDS` = 120 秒が切れたあとの回が取り直す。attempts・`last_error_*` は変えない) |
| 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 正しい | HTTP 4xx (429 以外) を 2 件以上の塊で受けた (要求ごとの拒否。例 `PUSH_TOO_MANY_EXPERIENCE_IDS`・`UNAUTHORIZED`) | まだ決まらない: 塊を 1 件ずつの要求に分けて同じ回で送り直す (warn 1 行)。この行は自分の 1 件の要求の結果 (この表の ticket ok / ticket の error / 429・5xx・通信エラー / 時間切れ / 下の 1 件の 4xx の行) で決まる (S-24) |
| 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 正しい | HTTP 4xx (429 以外) を 1 件の要求で受けた | dead (`errors[0].code`。無ければ `expo_http_error`) |
| 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 〃 | 正しい | 応答の形の誤り (ticket の配列でない・数が合わない) | dead (`invalid_response`)。分けて送り直さない (Expo が受け付けたあとかもしれず、送り直すと 2 通届く) |

登録 (トリガー §5.3) の入力の組み合わせ → 結果 (判定は左の列から順。書き手の対応は §3.2.1):

| status の変化 | `error_message` (failed のとき) | `target_slots` の異なる `date` | 例 (書き手) | 結果 |
|---|---|---|---|---|
| 変わらない・新が completed / failed でない | – | – | 進捗の書き込み・`pending` → `processing` | WHEN で発火しない |
| → failed | `中止しました` | – | W-7 | 積まない (S-19) |
| → failed | `stale_request_timeout` | – | W-6 | 積まない (S-22 前者) |
| → completed / failed | ほか (NULL を含む) | NULL・配列でない | W-8 (`menu-plans/add`) | 積まない (S-21) |
| 〃 | 〃 | 0〜1 日 | 1 食・1 日の生成と作り直し・栄養分析・AI 相談の 1 日 / 1 食 (W-1〜W-3) | 積まない (S-20) |
| → completed | 〃 | 2 日以上 | 1 週間の依頼・2 日以上の範囲の生成 (W-1・W-2) | `weekly_menu_completed` を端末の行ごとに 1 行 (S-01・S-04)。端末が無ければ 0 行 (S-03)。token の長さが 1..256 を外れる端末の行は飛ばし、ほかの端末には積む (R-24。形の違う token は積み、worker が `invalid_token` にする: S-23) |
| → failed | ほか (同意・上限・定型の文・`attempt_limit_exceeded`・NULL) | 2 日以上 | W-1〜W-5 | `weekly_menu_failed` (S-02・S-22 後者) |
| 2 回目の最終の書き込み (completed → failed など) | 〃 | 2 日以上 | CAS をすり抜けた更新 | `dedupe_key` で 0 行 (R-10) |
| (積む行で) `enqueue_push_notification` が例外 | – | 2 日以上 | payload が 2,048 バイト超など | WARNING を残し、`weekly_menu_requests` の更新は成功 (R-02) |

### 7.2 状態比較表 (現行 vs 設計後)

| 面 | 現行 (origin/main) | 設計後 |
|---|---|---|
| サーバーからの送信 | 無い (token を集めるだけ) | `push_outbox` + `GET /api/cron/push-outbox` (毎分) が Expo に送る |
| 送る種類 | 無い | `weekly_menu_completed` / `weekly_menu_failed` (DB トリガー)。後回しは §3.2 |
| `weekly_menu_requests` の最終の status (8 経路) | 画面 (ポーリング・Realtime) が読むだけ | + トリガーが 2 日以上の依頼の結果だけを積む。中止・止まった行の掃除・1 食 / 1 日・手動の追加は今と同じ (Push なし)。書き手の route・関数は変えない |
| `notifications_enabled` | API が読み書きするが、読んで判断するコードは無い | worker が送る直前に見る (false は dead) |
| `quiet_hours_start/end` | 健康記録の設定画面が読み書きする (それで判断するコードは無い) | 方針が `defer` の種類で使う (第 1 段は `send` のみ) |
| 端末の行を消す経路 | ログアウト・claim・release・退会 | + `DeviceNotRegistered` (ticket / receipt)。送信待ちは CASCADE で一緒に消える |
| `user_push_tokens.expo_push_token` の形の判定 | claim / release の API だけ (`isExpoPushToken`) | + worker が送る前に同じ関数で見る (違えば `invalid_token` の dead。行は消さない)。登録 (`enqueue_push_notification`) は長さ 1..256 を外れる行を飛ばす。表の CHECK は足さない |
| Expo のアクセストークン | 無い | `EXPO_ACCESS_TOKEN` (無ければ送らず warn・掃除だけ) |
| 設計書の `notify-push` Edge Function・`pending_push_notifications` | 設計のみ | 作らない (§13.2 で現在形に) |
| 記録 | 無い | `push_outbox` の行 (7 日 / 30 日) と `app_logs` |

### 7.3 状態遷移表 (`push_outbox.status` × 操作 → 遷移先・ガード・副作用)

| 状態 | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| (無) | トリガー `weekly_menu_requests_enqueue_push` (関数 `enqueue_weekly_menu_result_push`) (§7.1 の 2 つ目の表の「積まない」行) | (無) | 中止・止まりの印・`target_slots` が 2 日未満 | 何もしない (`weekly_menu_requests` の更新はそのまま) |
| (無) | `enqueue_push_notification` (トリガーの「積む」行から) | queued | 利用者の端末の行があること。token の長さが 1..256 (外れる端末の行は飛ばす)。`dedupe_key` が重ならないこと | 端末の行ごとに 1 行 |
| queued | `claim_push_outbox` | queued (リース) | `next_attempt_at <= now`・リース無し / 切れ | `lease_expires_at` / `worker_id` |
| queued (リース) | `complete_push_outbox` | sent | 同じ worker | `sent_at`・`receipt_id`・attempts + 1 |
| queued (リース) | `fail_push_outbox` (retryable・回数内) | queued | 同じ worker | attempts + 1・`next_attempt_at` = now + 間隔・last_error_* |
| queued (リース) | `fail_push_outbox` (非 retryable / 回数切れ) | dead | 同じ worker | `dead_at`・last_error_*。`DeviceNotRegistered` なら worker が端末の行を消す → 行は CASCADE で消える (`invalid_token` では消さない) |
| queued (リース) | Expo が要求ごと拒んだ (HTTP 4xx。429 を除く) 2 件以上の塊の 1 行 | queued (リース) のまま | 同じ回・塊が 2 件以上 | 1 件ずつの要求で送り直し、この表の complete / fail / リース切れのどれかに進む (attempts は 1 件の要求の結果でだけ動く) |
| queued (リース) | `defer_push_outbox` | queued | 同じ worker・`p_until` は今より後 2 日以内 | `next_attempt_at` = 夜の終わり (attempts 不変) |
| queued (リース) | リース切れ (worker の停止・時間切れ / 429 の打ち切りで Expo に渡さずに残した行) | queued | – | 次の回が取り直す (attempts 不変) |
| queued (リース無し / 切れ) | `cleanup_push_outbox` (鍵が無い回も) | dead | `created_at < now − 24 時間` | `dead_at`・`last_error_code = 'expired'` (attempts 不変)。リース中の行には触らない |
| sent | `claim_push_receipts` | sent (リース) | `receipt_checked_at` NULL・`sent_at <= now − 15 分` | リース |
| sent (リース) | `record_push_receipt` (ok / error / missing) | sent | 同じ worker | `receipt_checked_at`・`receipt_status`・`receipt_error`。error が `DeviceNotRegistered` なら端末の行を消す → CASCADE |
| sent (リース) | `record_push_receipt` (NULL = まだ無い) | sent | 同じ worker | リースを外すだけ |
| sent (リース) | リース切れ (worker の停止) | sent | – | 次の回の `claim_push_receipts` が取り直す |
| queued / sent (別の worker のリース・状態が違う・確認済み) | `complete` / `fail` / `defer` / `record_push_receipt` | 変わらない | `worker_id` 不一致・行が消えた (CASCADE)・queued (receipt は sent かつ `receipt_checked_at` NULL) でない | 戻り値 false / `'ignored'`。worker は要約に数えない (S-16・端末の行の削除との競合) |
| sent / dead | `cleanup_push_outbox` | (消える) | sent 7 日・dead 30 日 | – |
| 任意 | 端末の行の削除・退会 | (消える) | FK CASCADE | – |

## 8. 監査とログ (app_logs)

- `createLogger('cron/push-outbox', requestId)`。回の要約 (`claimed` など全件数) は claim・receipt・掃除の expired のどれかがあったときだけ info (掃除で expired にした行は件数だけで、行ごとの warn は出さない)。dead は 1 行ごとに warn (`kind` / `user_id` / `token` の末尾 4 文字 / `error_code` / `status_code` / `attempts`。`invalid_token` も同じ)。receipt のエラーと端末の行の削除も warn。Expo が要求ごと拒んで 1 件ずつ送り直した塊は、塊ごとに warn 1 行 (`error_code` / `status_code` / `count`。token・利用者 ID は出さない)。`EXPO_ACCESS_TOKEN` 未設定は掃除の件数つきの warn (変数名はログにだけ)。
- 出さないもの: 文面 (title / body)・token の全体・メールアドレス・payload。応答にも出さない (`summary` の件数だけ)。`admin_audit_logs` には書かない (運営の操作が無い: 一斉送信は範囲外)。

## 9. エラー表

| 場面 | 判定 | 行 / 応答 |
|---|---|---|
| Expo 通信エラー・HTTP 429・5xx | retryable | `fail` → queued (1 分 → 5 分 → 15 分) → 3 回目で dead。429 はその回を打ち切る (`stopped_early: 'rate_limited'`) |
| Expo HTTP 4xx (429 以外。400 `PUSH_TOO_MANY_EXPERIENCE_IDS`・401 `UNAUTHORIZED` を含む) を 2 件以上の塊で受けた | 分けて送り直す | 同じ回に 1 件ずつの要求で送り直し (warn 1 行)、各行は自分の 1 件の要求の結果だけで決まる (R-24・S-24) |
| Expo HTTP 4xx (429 以外) を 1 件の要求で受けた | 非 retryable | dead (`errors[0].code`。無ければ `expo_http_error`) |
| 応答の形の誤り・ticket の数が合わない | 非 retryable | dead (`invalid_response`)。分けて送り直さない (Expo が受け付けたあとかもしれず、送り直すと 2 通届く) |
| 送信の途中で時間切れ (回の開始から `PUSH_OUTBOX_RUN_BUDGET_MS` = 40 秒を超えて次の要求 (塊、または 1 件ずつの送り直しの 1 件) に進もうとした) | 次の回 | その要求と残りの行は Expo に渡さず queued (リース) のまま (attempts・`last_error_*` は変えない)。`stopped_early: 'budget'`。`PUSH_OUTBOX_LEASE_SECONDS` = 120 秒のリースが切れたあとの回が取り直す。この回の receipt の確認と掃除はする (§6.3 `sendBatch`・§7.1 の 1 つ目の表の「呼ばない (時間切れ…)」の行) |
| ticket error (`DeviceNotRegistered` / `MessageTooBig` / ほか) | 非 retryable | dead (error の名前)。`DeviceNotRegistered` は端末の行を消す |
| 送る条件を満たさない (§7.1 の 1 つ目の表で Expo を呼ばずに dead になる 8 行。`expired` は掃除 `cleanup_push_outbox` も付ける) | 非 retryable | dead (`profile_missing` / `expired` / `invalid_token` / `account_frozen` / `consent_outdated` / `notifications_disabled` / `unknown_kind` / `invalid_payload`) |
| 端末の行の token の長さが 1..256 を外れる | 登録しない | `enqueue_push_notification` がその端末の行を飛ばす (同じ利用者のほかの端末には積む。R-24) |
| receipt が取れない (通信・429・5xx・形の誤り) | 次の回 | `record_push_receipt(NULL)` でリースを外すだけ。24 時間を超えたら `missing` |
| receipt が `DeviceNotRegistered` の error | 記録 + 端末の行を消す | `record_push_receipt('error', 'DeviceNotRegistered')` (`receipt_status = 'error'`) と warn → 端末の行を消す → CASCADE で送信待ちの行も消える (S-10) |
| receipt がほかの error (`MessageTooBig` / `MessageRateExceeded` / `MismatchSenderId` / `InvalidCredentials` / details の無い error は `expo_ticket_error`) | 記録だけ (再試行しない) | `record_push_receipt('error', <error の名前>)`。行は sent のまま (`receipt_status = 'error'`・`receipt_error` に名前。dead にしない) と warn (`receipt_error` / `user_id` / token の末尾 4 文字)。端末の行は消さない。sent の 7 日の掃除で消える (`MessageRateExceeded` の再試行は §14) |
| RPC の失敗・claim の行の形の誤り | 500 | `internalError` (本文は汎用。詳細は app_logs) |
| `CRON_SECRET` 不一致 / 未設定 | 401 / 503 | `requireCronAuth` |
| メンテナンス中 | 200 | `{ status: 'maintenance' }` (何もしない。掃除もしない) |
| `EXPO_ACCESS_TOKEN` 未設定 | 200 | 送らず掃除だけ: `{ status: 'not_configured', cleaned_expired, cleaned_sent, cleaned_dead }` (掃除の RPC の失敗は 500) |

## 10. テスト一覧 (it 名。すべて新設)

worker の単体テストの行の token は `ExponentPushToken[…]` の形にする (形が違う行は `decideEligibility` が `invalid_token` にし、Expo に渡らない)。形の違う行を使うのは S-23 の it だけ。

| ファイル | it |
|---|---|
| `src/__tests__/lib/push/outbox.test.ts` | `送る条件: プロフィール無し / 24 時間超 / token の形が違う / 凍結 / 未同意 (on だけ) / 設定 off の順で dead のコードが決まる`・`token の形が違う行 (isExpoPushToken が false) は Expo に渡さず invalid_token で dead にし、端末の行を消さず、同じ回のほかの行は送る (S-23)`・`要求ごと 4xx (429 以外) で拒まれた 2 件以上の塊は 1 件ずつ送り直し、原因の 1 件だけが dead でほかは sent (S-24)`・`1 件ずつの送り直しの途中の 429 でその回をやめ、残りの行は Expo に渡さず fail も呼ばない`・`応答の形の誤り (invalid_response) の塊は分けて送り直さず全行を dead にする`・`isRequestLevelRejection は 4xx (429 以外) だけ true で、429・5xx・通信エラー・invalid_response は false`・`夜間: 22:00〜07:00 をまたぐ判定と、次の 07:00 JST の時刻`・`quiet_hours_start/end が null・形が違えば既定 22:00〜07:00 で夜間を判定する (parseClockMinutes の fallback)`・`defer の種類だけ延期し、send の種類は夜でも送る`・`100 件ずつ Expo に渡し、ticket を同じ順の行に対応させる`・`ticket error の DeviceNotRegistered で端末の行を消す`・`HTTP 429 で塊を requeue してその回を打ち切り、後続の塊は Expo に渡さず fail も呼ばない`・`時間切れで残りを次の回に回す (attempts は増えない)`・`receipt: ok / error / まだ無い / 24 時間超の missing`・`receipt の DeviceNotRegistered で端末の行を消す (S-10)`・`24 時間を超えた queued は Expo を呼ばずに expired で dead (claim した行)`・`processPushOutbox は cleanup の expired / sent / dead を要約の cleaned_* に入れる`・`PUSH_OUTBOX_QUEUED_MAX_AGE_MS と PUSH_OUTBOX_ERROR_CODES.EXPIRED が migration の cleanup_push_outbox の c_queued_max_age (24 hours)・'expired' と同じ (supabase/migrations/*_push_outbox.sql を読む)`・`retryDelaySeconds は 1 回目 60・2 回目 300・3 回目以上 900 秒で、5xx の fail にその間隔を渡す (S-08)`・`ログの meta に文面 (title / body)・token の全体・payload を出さない (R-15)`・`resolvePushOutboxSettings: 範囲外は既定に戻し ignored に名前`・`maskPushToken は末尾 4 文字だけ` |
| `src/__tests__/lib/push/expo-transport.test.ts` | `Authorization: Bearer と content-type を付けて send の URL に POST する`・`429 / 5xx / 通信エラーは retryable、4xx は非 retryable で errors[0].code を使う`・`ticket の数がメッセージと違えば invalid_response`・`要求ごとの 400 (PUSH_TOO_MANY_EXPERIENCE_IDS) は code にその名前・statusCode 400・retryable false を返す`・`getReceipts は ids を送り、data の表を返す` |
| `src/__tests__/lib/push/render.test.ts` | `weekly_menu_completed は日付入りの本文と data.path を返す`・`weekly_menu_failed は日付入りの本文 ({M}月{D}日からの献立を作れませんでした) で、理由の確認を約束しない`・`payload の形が違えば null`・`知らない kind は null` |
| `src/__tests__/api/cron/push-outbox.test.ts` (route は一番外側で 1 回だけ import) | `CRON_SECRET が合わなければ 401`・`EXPO_ACCESS_TOKEN が無ければ claim も Expo もせず cleanup_push_outbox だけを呼び、not_configured と掃除の件数を返す (S-07・R-12)`・`メンテナンス中は鍵の有無に依らず DB に触れず maintenance を返す (S-15)`・`要約を返し、変数名・文面・token の全体を応答に出さない (R-15)`・`RPC の失敗は 500 の汎用の本文` |
| `tests/push-kinds-routes-contract.test.ts` | `PUSH_NOTIFICATION_KINDS の全部に文面がある`・`全部の path が NOTIFICATION_ROUTES の画面に解決される` |
| `tests/push-expo-boundary-scan.test.ts` | `exp.host を書くのは src/lib/push/expo-transport.ts だけ (src・supabase/functions・apps/mobile/src を走査)` |
| `tests/push-outbox-migration-contract.test.ts` | `表・索引・ポリシー・RPC 8 本・トリガーが migration にある`・`RPC は SECURITY INVOKER・search_path ''・EXECUTE は service_role だけ`・`トリガー関数は SECURITY DEFINER で EXECUTE を誰にも付けない`・`down.sql が全部を消す`・`トリガーの c_cancelled_message / c_stale_message が stored-failure-messages.ts の MENU_REQUEST_CANCELLED_MESSAGE / MENU_REQUEST_STALE_MESSAGE と同じ値`・`enqueue の c_max_token_chars と push_outbox.expo_push_token の CHECK の上限 (256) が src/lib/push-tokens.ts の MAX_EXPO_PUSH_TOKEN_LENGTH と同じ` |
| `tests/integration/rls/push-outbox.test.ts` (実 DB) | `anon / authenticated は表も RPC も 42501`・`enqueue は端末の行ごとに 1 行、dedupe_key で 2 回目は 0`・`端末の行が無い利用者の enqueue は 0 行 (S-03)`・`enqueue は token の長さが 1..256 を外れる端末の行を飛ばし、同じ利用者のほかの端末には積む (R-24)`・`claim は SKIP LOCKED で 2 本が同じ行を取らない`・`fail は retryable と回数で requeued / dead`・`defer は attempts を増やさない`・`complete / fail / defer / record は別の worker_id では false / ignored`・`receipt の claim と record`・(段 B で足す) `createOutboxStore().loadEligibility は notification_preferences の行が無い利用者を notificationsEnabled true・quiet null で返し、行のある利用者は列の値を返す`・`端末の行の削除 (ログアウト・claim・release と同じ操作) で queued の行が消える (S-11)`・`auth.users の削除 (退会) で push_outbox の行が消える (S-12)`・`2 日以上の target_slots の行を completed にするとトリガーが 1 行積む (failed も。pending → processing では積まない。S-01)`・`中止 (中止しました) と止まった行の印 (stale_request_timeout) の failed では積まない (S-19・S-22)`・`attempt_limit_exceeded の failed (claim_menu_request) では積む (S-22)`・`target_slots が 1 日 (1 食・1 日 3 食) / NULL の completed では積まない (S-20・S-21)`・`completed のあと failed に書き換えても 2 行目は作られない (R-10)`・`enqueue が失敗しても weekly_menu_requests の更新は成功し行は 0 (2 日以上の target_slots の行の mode に 2,048 バイトを超える文字列を入れて payload の上限で失敗させる。R-02)`・`cleanup は期限の行だけ消す`・`cleanup は 24 時間を超えたリースの無い queued を expired の dead にし、リース中の行と 24 時間以内の行は触らない (S-07)` |

## 11. 段分け (同じ WF・同じ worktree。段ごとに 2 枚のレビュー)

| 段 | 内容 | 触るファイル |
|---|---|---|
| A: DB | migration + down (§5)、`database.types.ts` の作り直し (2 か所)、`ACCOUNT_EXPORT_EXCLUDED` に `push_outbox`、契約テスト・RLS テスト。変えずに緑を確かめる番兵: `tests/integration/security/anon-definer-execute.test.ts` (A1 は SECURITY DEFINER の全関数を走査し、anon が呼べる許可リスト 2 本と比べる。§5.3 の REVOKE で緑のまま)・`account-deletion.test.ts` (§13.1)。変える番兵: `tests/integration/security/auth-users-fk-on-delete.test.ts` (D の `EXPECTED_ACTIONS` に `'push_outbox.user_id': 'CASCADE'` を 1 行。§13.1) | `supabase/migrations/*`、`supabase/rollbacks/*`、`src/types/database.types.ts`、`packages/shared/src/database.types.ts`、`src/lib/account-export-tables.ts`、`tests/push-outbox-migration-contract.test.ts`、`tests/integration/rls/push-outbox.test.ts`、`tests/integration/security/auth-users-fk-on-delete.test.ts` |
| B: worker | §6 (shared の kinds + barrel・`src/lib/push/{outbox,outbox-store,expo-transport,render}.ts`・route・`vercel.json`・`env.ts`・`.env.example`・`ENV_SETUP.md`)、§13.1 の番兵の追随、§10 のテスト | `packages/shared/src/{push-notification-kinds,index}.ts`、`src/lib/push/*`、`src/app/api/cron/push-outbox/route.ts`、`vercel.json`、`src/lib/env.ts`、`.env.example`、`ENV_SETUP.md`、`src/__tests__/lib/env.test.ts`、`tests/ai-usage-contract.test.ts`、`tests/ai-consent-provider-inventory.test.ts`、`tests/lib-raw-error-message-scan.test.ts`、`docs/design/operator/08-cron-batches.md`、§10 のテスト |
| C: 設計書の追随 | §13.2 の段 C の行 (docs のみ) | §13.2 の段 C の行の文書 |

段 A だけが本番に入った状態では、トリガーが行を積むだけで何も送らない (安全。端末の行は本番に 0)。段 B は段 A の本番適用の**後**にデプロイする。`EXPO_ACCESS_TOKEN` の投入と Expo の Enhanced push security の ON はオーナー作業 (§14)。

## 12. 新設一覧

| 種類 | 名前 |
|---|---|
| テーブル | `public.push_outbox` (§5.1 の 23 列)、CHECK `push_outbox_status_times` / `push_outbox_receipt_consistency`、索引 `idx_push_outbox_claim` / `_receipt_pending` / `_sent_at` / `_dead_at` / `_user_id` / `_push_token_id` / `_dedupe_key`、ポリシー `push_outbox_deny_client_access` |
| RPC / 関数 | `enqueue_push_notification(uuid, text, jsonb, text)`、`claim_push_outbox(text, integer, integer)`、`complete_push_outbox(uuid, text, text)`、`fail_push_outbox(uuid, text, text, text, integer, boolean, integer, integer)`、`defer_push_outbox(uuid, text, timestamptz)`、`claim_push_receipts(text, integer, integer, integer)`、`record_push_receipt(uuid, text, text, text)`、`cleanup_push_outbox()`、トリガー関数 `enqueue_weekly_menu_result_push()` (定数 `c_min_days` / `c_cancelled_message` / `c_stale_message`) とトリガー `weekly_menu_requests_enqueue_push`。`enqueue_push_notification` の定数 `c_max_token_chars`。`cleanup_push_outbox` の戻りの列 `expired` / `sent_deleted` / `dead_deleted` と定数 `c_queued_max_age` |
| Vercel Cron / route | `GET /api/cron/push-outbox` (`*/1 * * * *`) |
| ファイル (新) | `packages/shared/src/push-notification-kinds.ts`、`src/lib/push/{outbox,outbox-store,expo-transport,render}.ts`、`src/app/api/cron/push-outbox/route.ts`、migration と down、§10 のテスト 8 本 |
| 関数 (TS) | `isPushNotificationKind`、`renderPushMessage`、`formatMonthDay`、`resolvePushOutboxSettings`、`retryDelaySeconds`、`maskPushToken`、`chunk`、`parseClockMinutes`、`localMinutesOfDay`、`isWithinQuietHours`、`quietHoursEndMs`、`decideEligibility`、`isRequestLevelRejection`、`parseClaimedRows`、`parseReceiptRows`、`processPushOutbox`、`createExpoTransport`、`createOutboxStore` |
| 定数 | `outbox.ts` (§6.3): `PUSH_OUTBOX_MAX_ATTEMPTS` (+ `_MIN` / `_MAX`)・`PUSH_OUTBOX_RETRY_DELAYS_SECONDS`・`PUSH_OUTBOX_BATCH_SIZE` (+ `_MIN` / `_MAX`)・`EXPO_PUSH_SEND_CHUNK_SIZE`・`EXPO_PUSH_RECEIPT_CHUNK_SIZE`・`PUSH_OUTBOX_LEASE_SECONDS`・`PUSH_OUTBOX_RUN_BUDGET_MS`・`PUSH_OUTBOX_QUEUED_MAX_AGE_MS`・`PUSH_RECEIPT_CHECK_DELAY_SECONDS`・`PUSH_RECEIPT_MAX_AGE_SECONDS`・`PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES`・`PUSH_QUIET_HOURS_DEFAULT_START_MINUTES` / `_END_MINUTES`・`EXPO_DEFAULT_ANDROID_CHANNEL_ID`・`EXPO_DEVICE_NOT_REGISTERED`、`PUSH_NOTIFICATION_KINDS`、`PUSH_NOTIFICATION_KIND_SPECS`、`PUSH_OUTBOX_ERROR_CODES`、`HTTP_TOO_MANY_REQUESTS` (正は `outbox.ts`。`expo-transport.ts` は import する)、`EXPO_PUSH_SEND_URL` / `EXPO_PUSH_RECEIPTS_URL` (`expo-transport.ts`) |
| 型 / Zod | `PushNotificationKind`、`PushQuietHoursPolicy`、`PushNotificationKindSpec`、`RenderedPushMessage` (正は `outbox.ts`。`render.ts` は import する)、`WeeklyMenuResultPayloadSchema` / `WeeklyMenuResultPayload`、`PushPriority`、`PushMessage`、`ExpoPushTicketSchema` / `ExpoPushTicket`、`ExpoPushReceiptSchema` / `ExpoPushReceipt`、`PushTransportFailure`、`PushSendOutcome`、`PushReceiptsOutcome`、`PushTransport`、`PushOutboxClaimedRowSchema` / `PushOutboxClaimedRow`、`PushOutboxReceiptRowSchema` / `PushOutboxReceiptRow`、`PushUserEligibility`、`PushKindPolicy`、`PushEligibility`、`PushOutboxFailInput`、`PushOutboxFailOutcome`、`PushOutboxStore`、`PushOutboxCleanupResult`、`PushOutboxLogger`、`PushOutboxWorkerDeps`、`PushOutboxRunOptions`、`PushOutboxRunSummary`、`PushOutboxSettingEnvName`、`PushOutboxSettingSources`、`PushOutboxSettings` |
| export しない (ファイルの中だけ) | `render.ts`: `WEEKLY_MENU_COMPLETED_TITLE`・`WEEKLY_MENU_FAILED_TITLE` (本文は日付から作るので定数にしない)。`push-notification-kinds.ts`: `MENU_RESULT_TTL_SECONDS`・`MENUS_TAB_PATH`。`outbox.ts`: `MINUTES_PER_DAY`・`MS_PER_MINUTE`・`MS_PER_SECOND`・`PUSH_TOKEN_SUFFIX_CHARS`・`CLOCK_PATTERN`・`ExpoErrorDetailsSchema`・`boundedInt`・`recordFailure`・`notSent`・`removeToken`・`sendQueued`・`sendBatch`・`checkReceipts`・型 `Pending` / `RowRef`。`expo-transport.ts`: `HTTP_SERVER_ERROR_MIN`・`SendResponseSchema`・`ReceiptsResponseSchema`・`ErrorResponseSchema`・`httpFailure`・`post`。route: `ROUTE_NAME` (`LOG_FLUSH_GRACE_MS` は #1922 48fc47bf で外した) |
| 環境変数 | `EXPO_ACCESS_TOKEN`、`PUSH_OUTBOX_MAX_ATTEMPTS`、`PUSH_OUTBOX_BATCH_SIZE` |
| エラーコード (行の `last_error_code`) | `account_frozen` / `consent_outdated` / `notifications_disabled` / `profile_missing` / `expired` / `invalid_token` / `unknown_kind` / `invalid_payload` / `network_error` / `invalid_response` / `expo_http_error` / `expo_ticket_error`、Expo の名前そのまま (`DeviceNotRegistered` など) |

## 13. 追随表 (既存の番兵と他の文書)

### 13.1 既存の番兵 (契約テスト・走査テスト)

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/database-types-migrations-contract.test.ts` | `push_outbox` と RPC 8 本の名前 (トリガー関数は `RETURNS trigger` で除外) | 型に無いと赤 | `database.types.ts` を 2 か所で作り直す | A |
| `tests/account-export-tables.test.ts` | `push_outbox` (`user_id` を持つ) | 分類が無いと赤 | `ACCOUNT_EXPORT_EXCLUDED` に `push_outbox: 'Push 通知の送信待ちの運用の記録 (端末の token と依頼 ID)。本人のデータの写しではない'` | A |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` A〜E・H | `push_outbox.user_id` (CASCADE。auth.users を指す)・`push_outbox.push_token_id` (CASCADE。`user_push_tokens` を指す) / 列名に `mail` を含む列 | D が反応する (`push_outbox.user_id` が一覧に無いと赤)。D は、auth.users を指す外部キー (RESTRICT / NO ACTION の許可リストのものを除く) の「表.列」の集合と、決めた動作の一覧 `EXPECTED_ACTIONS` のキーの集合が一致することを確かめる (#1714 の D0。既存の `user_push_tokens.user_id` (CASCADE) も一覧に載っている)。A は NO ACTION・B は RESTRICT・C は SET NULL の外部キーだけを見るので反応しない。E は退会で消える表を指す NO ACTION / RESTRICT と、NOT NULL の SET NULL だけを見る (`push_token_id` は CASCADE) ので反応しない。H は `mail` を含む列が無い | D の `EXPECTED_ACTIONS` に `'push_outbox.user_id': 'CASCADE'` を 1 行足す (#1714 の D0 が、auth.users を指す外部キーの集合と `EXPECTED_ACTIONS` のキーの集合の一致を確かめるので、足さないと赤になる。CASCADE は S-12 のとおり)。A〜C・E・H は何もしない | A |
| `tests/integration/security/anon-definer-execute.test.ts` | `SECURITY DEFINER` (`enqueue_weekly_menu_result_push`) | anon に EXECUTE が付いていれば赤 | §5.3 の REVOKE (完全形) で緑 | A |
| `tests/integration/security/account-deletion.test.ts` (`REPORT_KEYS`) | `prepare_account_deletion` の戻り値 | 変えないので反応しない | – | A |
| `tests/log-cleanup-dau-snapshot-contract.test.ts` (Vercel Cron の 3 つの it) | `vercel.json` の `crons` の path の最後 | §3.0・§3.2 の注記・§5 の注記が全部の名前を挙げ、「…の N 本」が実数と同じでないと赤 | §13.2 の `08-cron-batches.md` の行。マージ時の origin/main の実数 + 1 (`email-outbox` が先に着地していれば 3 → 4 本、していなければ 2 → 3 本) | B |
| `tests/ai-usage-contract.test.ts` (`CRON_ENTRYPOINTS`) | `vercel.json` の `path` | 完全一致の比較が赤 | `'vercel:/api/cron/push-outbox': 'Push 通知の送信待ちを Expo に送る (AI を使わない)'` を 1 行 (`app-log-alerts` の行の直後) | B |
| `tests/ai-consent-enforcement.test.ts` (Vercel の cron の it) | route から import で届く AI の印 | route と import 先 (§6.6) は AI の印を含まない | 反応しない | B |
| `tests/cron-secret-contract.test.ts` | `requireCronAuth` の await | §6.6 のとおり | 反応しない | B |
| `tests/env-source-scan.test.ts` | `EXPO_ACCESS_TOKEN` `PUSH_OUTBOX_MAX_ATTEMPTS` `PUSH_OUTBOX_BATCH_SIZE` | 一覧・`.env.example`・readOnlyBy に無いと赤。応答・例外の文に変数名があると赤 | `env.ts` に §6.1 の 3 項目 (readOnlyBy = route)、`.env.example` に 3 行。変数名は warn にだけ書く | B |
| `src/__tests__/lib/env.test.ts` (readOnlyBy の一覧の it) | `readOnlyBy` を持つ変数の `[名前, ファイル]` / `@ts-expect-error` | 完全一致の比較が赤 | 期待の配列 (`.sort()` 後の `[名前, ファイル]` = `'名前,ファイル'` の文字列の順) に 3 行: `['EXPO_ACCESS_TOKEN', 'src/app/api/cron/push-outbox/route.ts']` は `D…` で始まる名前と `F…` で始まる名前のあいだ (origin/main cd4d4f17 では `DSR_RESPONSE_DUE_DAYS` の行の直後・`FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT` の前)、`PUSH_OUTBOX_BATCH_SIZE` → `PUSH_OUTBOX_MAX_ATTEMPTS` (同じファイル) は `PHOTO_SIGNED_URL_TTL_SECONDS` の行の直後 (`'PH' < 'PU'`。cd4d4f17 では配列の末尾)。マージ時に名前が増えていれば、同じ sort の規則で位置を決める。it 名の括弧の列挙にも同じ位置で `EXPO_ACCESS_TOKEN` と `PUSH_OUTBOX_*` を足す。`typeOnly` に `@ts-expect-error` の 3 組 (`ORG_CHALLENGE_SHOW_NAMES` の組の後) | B |
| `tests/ai-consent-provider-inventory.test.ts` | `https://exp.host` (`expo-transport.ts`) | `NON_AI_HOSTS` に無いと赤 | `'exp.host': 'Push 通知の送信 (Expo Push Service。#1136)。送るのは端末の token・固定の文面・画面のパス・依頼 ID だけで、利用者のデータは送らない'` | B |
| `tests/lib-raw-error-message-scan.test.ts` | `expo-transport.ts` の `message: error.message` (通信エラー) | 許可リストに無いと赤 (count 1 の見込み) | `ALLOWED` に `'src/lib/push/expo-transport.ts': { count: 1, reason: '通信エラーの文を行の last_error_message に残すだけで、応答の本文には出さない (route は summary だけを返す)' }` | B |
| `tests/api-raw-error-message-scan.test.ts` | route の応答の本文 | summary の件数だけ | 反応しない | B |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient` (`@supabase/supabase-js`) | `getSupabaseAdmin` だけ | 反応しない | B |
| `tests/heavy-unit-test-timeout.test.ts` | テストの中での route の読み込み | §10 のとおり一番外側で 1 回 | 反応しない | B |
| `src/__tests__/api/null-character-routes.test.ts` | 本文を読む handler | GET は本文を読まない | 反応しない | B |
| `lib/supabase/__tests__/middleware-push-token-claim-exemption.test.ts`・`middleware-legal-consent-api.test.ts` | `src/app/api` の全 route | `/api/cron` は prefix で両方の許可リストにある | 反応しない | B |
| `tests/jst-today-source-scan.test.ts` 規則 G | 列名リテラルの `.gte/.lt` | store は rpc と `.in` だけ | 反応しない | B |
| `tests/data-share-not-consent.test.ts` | `data_share_enabled` | 読まない (`notifications_enabled` と quiet の 3 列だけ select) | 反応しない | B |
| `apps/mobile/__tests__/lib/notification-route.test.ts` | `NOTIFICATION_ROUTES` | 変えない (`/menus` は既にある) | 反応しない | B |
| `tests/design-doc-removed-mobile-screens.test.ts`・`tests/design-doc-push-paths-resolve.test.ts`・`tests/mobile-sign-out-doc-callers.test.ts` | 本書の行 | 消した画面 (健康記録の設定・週の献立) を名指しする行は、同じ行で 2026-10-16 に削除したと書く (#1598)。通知の行き先 (`path: '/menus'`・`data.path = '/menus'`・`MENUS_TAB_PATH`) は `resolveNotificationHref` で同じ `/menus` に解決される。端末のログアウトの行に画面名を書かない | 反応しない (緑のまま) | C |

### 13.2 他の文書への追随

| 文書 | 直すこと | 段 |
|---|---|---|
| `docs/design/mobile/CLAUDE.md` | ファイル一覧に `06-push-send.md` の行 (担当: push_outbox / worker / receipt / 種類の一覧。要件 01 §15.3-4)。「このドメインから他ドメインへの提供」の行 (94 行。提供内容 `Expo Push Token`・利用先 `cross/03-design-system.md (notify-push Edge Function)`) の利用先を `mobile/06-push-send.md` (`push_outbox` の worker) に (`cross/03-design-system.md` には Push の記述が無いので、cross/03 は直さない) | C |
| `docs/design/mobile/03-push-notification.md` | §1 対象外に「サーバーからの送信 → `06-push-send.md`」。§3.3 のペイロード型を §6.3 の `PushMessage` への参照に。§3.5 の「サーバー側バッジ計算」を「付けない (06 §1.2)」に。§3.7 の Edge Function のコードと `pending_push_notifications` を「06 §6.3 (`next_attempt_at` で延期。表は作らない)」に。§3.9 を「06 §4 (Edge Function は作らない。登録は RPC `enqueue_push_notification`)」に。§4 の `pending_push_notifications` の DDL と §8 新規の `supabase/functions/notify-push/index.ts`・`create_pending_push_notifications.sql` を「作らない (06)」に。§6 の `DeviceNotRegistered` の行を「06 §6.3 (ticket と receipt の両方)」に、`Android FCM 未設定` の行 (510 行) を「06 の worker で `InvalidCredentials` になり (receipt の error の記録、ticket なら dead)、iOS には届く」に。§3.4 の注 (204 行「家族の通知を送る実装 (`notify-push`) を作るときに決める」) を「06 §3.2 の後回しの行」に。§5.1 のシーケンス図 (461・468 行の参加者 `notify-push (Edge Fn)` と `functions.invoke`) を「`enqueue_push_notification` → `push_outbox` → worker」に。§9 の pg_cron の行を解消済みに、FCM の行 (569 行「`notify-push` 実装前に必要」) を「06 の worker の本番投入の前に必要」に | C |
| `docs/requirements/01-family-management.md` §15.7 (2021 行) | 「Android: 未確認 → `notify-push` Edge Function 実装前に確認必要」の `notify-push` を `mobile/06-push-send.md` の worker に。要件文書なので、直すかどうかはオーケストレーターが決める (設計書の追随 PR に含めるか別にするか) | C |
| `docs/design/00-architecture.md` (252 行付近) | `notify-push/ # 新規 (Expo Push 一斉送信)` を「作らない。送信は Next の worker `GET /api/cron/push-outbox` (`mobile/06-push-send.md`)」に | C |
| `docs/design/operator/06-ai-llm.md` §8 の表 | `notify-push` の行を「作らない (mobile/06)」に | C |
| `docs/design/family/04-meal-request-flow.md` §6.2・`family/02-api-spec.md` §12・`family/07-lifecycle.md` | `expo.sendPushNotificationsAsync` の例と図の `notify-push` を「`enqueue_push_notification` を呼ぶ (種類は後回し。mobile/06 §3.2)」に | C |
| `docs/design/mobile/01-architecture.md` §13・`mobile/05-auth-session.md` (361 行付近) | 「`notify-push` Edge Function 実装前に」→「`mobile/06-push-send.md` の worker」。「#1136 で未実装」→「`06-push-send.md`」 | C |
| `docs/design/cross/09-testing.md` §11.3 | `expo-server-sdk` の `vi.fn()` → `fetch` のモック (`createExpoTransport(token, fetchImpl)`) | C |
| `docs/design/operator/08-cron-batches.md` | §3.0 の本文「`vercel.json` に登録されている Vercel Cron は …の N 本である。」に `push-outbox` (毎分。Push 通知の送信待ちを送る worker。#1136・`mobile/06-push-send.md` §6.6) を足し N + 1 に。§3.2 の注記「…の N 本。」も同じ (「この表のほかの 11 本」は変えない。表に行を足さない)。§5 の注記「`vercel.json` にあるのは …だけで」に `push-outbox` を足す。数はマージ時に origin/main を数え直す (`tests/log-cleanup-dau-snapshot-contract.test.ts`) | B |
| `docs/design/operator/02-api-spec.md` §22 Cron API | 節 `### GET /api/cron/push-outbox` (「Push 通知の送信待ちを Expo に送る worker (毎分。Vercel Cron。#1136)。処理・応答・環境変数は `mobile/06-push-send.md` §6.6。**認証**: `CRON_SECRET` ヘッダー」) | C |
| `ENV_SETUP.md`・`.env.example` | `EXPO_ACCESS_TOKEN` / `PUSH_OUTBOX_MAX_ATTEMPTS` / `PUSH_OUTBOX_BATCH_SIZE` の行と、Expo の Enhanced push security を ON にする手順 (`expo.dev/settings/access-tokens`) | B |

## 14. 未解決事項

- Expo の Enhanced push security を ON にし、`EXPO_ACCESS_TOKEN` を Vercel に入れる作業 (オーナー)。ON にするまでは、token を知る第三者も送れる (いまと同じ)。
- Android の FCM V1 の資格情報を EAS に登録する作業 (オーナー。`03` §9・`mobile/01` §13 の既存の未解決)。未登録の間は Android の端末だけ `InvalidCredentials` で届かない (receipt の error として記録と warn。ticket で返れば dead)。
- 届けられなかった Push を運用メールで知らせるか (本書は知らせない。`app-log-alerts` に 4 つ目の種類を足すなら、メールの送信待ちの `email_dead_letter` と同じ形)。
- 後回しの種類 (§3.2) の着手順と、家族・組織の通知の行き先 (WebView で Web の画面を開く形) の決め方。
- 種類ごとの受け取り設定 (`03` §3.6) を足すときの `decideEligibility` の判定と、アプリの設定画面。
- 通知から開く週の画面は今の週を開き、依頼の週や失敗の理由へは案内しない。通知から開く献立のタブの WebView (Web の週の画面 `src/app/(main)/menus/weekly/page.tsx`。ネイティブの週の画面 `apps/mobile/app/menus/weekly/index.tsx` は 2026-10-16 に削除した。#1598) が `error_message` を出すのは追跡中の依頼の失敗だけで、起動時の `GET /api/ai/menu/weekly/pending` は queued / pending / processing の行しか返さない。そのため失敗の通知 (§3.2) は理由を約束しない。理由を出すなら、行き先 (`data.path` に依頼の ID か週を載せる) と画面の変更が要り、本書の範囲 (モバイルのコードを変えない: §1.2) の外。
- `MessageRateExceeded` (receipt) を再試行するか (本書は記録だけ。1 回の献立で同じ端末に 1 通なので起きにくい)。
- 1 日分以下の生成 (AI アシスタントの 1 日の範囲・究極モードを含む) は通知しない (§3.2.1)。画面で待つ操作と長く待つ操作を、今の行の列では見分けられない。見分けるなら、行を作る route が「通知する」を記録する列を足す (作る経路は route 8 本と AI 相談の 3 か所)。
- 健康記録の設定画面の「通知」(`notification_preferences.enabled`) を切った利用者にも、献立の結果は届く (本書は `notifications_enabled` だけを見る)。`enabled` を健康記録のリマインダーだけの切り替えとするか、Push 全体の切り替えとするか。
