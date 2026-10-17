# operator/ 運営が隠したコンテンツを戻す操作 (#1538 の項目 4) — 画面と API の設計

版: v1.0 (2026-10-18)
Status: 設計ゲート審査中 (実装着手前)

要件の正本は Issue #1538 の本文 (項目 4「戻す操作: hidden_* を戻す運営の画面と API」) と、同 Issue の 2026-10-17 のコメント。オーナーの選択 (2026-10-17) は次の 1 文で、本書はこれを要件の外形として言い換えずに使う。

> 戻す操作を「今作る」。

本書の前提:
- 隠す側の仕組み (migration `20261009000500_hide_moderated_content.sql` の `hidden_at` / `hidden_by` / `hidden_reason`・RLS・ガードのトリガー・`paste_meal_to_family` の `MEAL_HIDDEN`) と、完全削除のジョブ `purge-hidden-content` (migration `20261016100000_purge_hidden_content.sql`・`supabase/functions/_shared/hidden-content-purge.ts`・90 日 = オーナーの選択 2026-10-15) は変えない。本書は、その上に「戻す」だけを足す。
- 新しい migration は無い (列・ポリシー・トリガー・関数を足さない・変えない。§5)。
- 本番には触らない。本番の隠した行の件数は読んでいない (§2.2)。
- 権限は隠す操作と同じ (`requireRole(['admin', 'super_admin', 'content_moderator'])`。§0.1 D-10)。
- 規約は `docs/design/CLAUDE.md` と `operator/CLAUDE.md`。関連の正本 (02 API・07 監査・cross/04 エラーコード) の改定は §17 の追随表で指定する。

---

## 0. 位置づけ・前提・分冊判定 (相 1)

### 0.1 決めること (要約)

| # | 決めること | 本書の決定 (要約) | 詳細 |
|---|---|---|---|
| D-1 | 戻す操作の API | **`POST /api/admin/moderation/{type}/{id}/restore`** を新設する (`{id}` は通報 `moderation_flags` / `recipe_flags` の id。隠す操作と同じ入口の形)。本文は `{ restore_note }` だけ。判定の順は「通報を読む → コンテンツの行を読む → 戻せるか判定 → 同じ操作で隠した行を集める → 通報を `approved` に → 行の `hidden_*` を NULL に → 監査ログ」 | §4 §6 §8 |
| D-2 | 戻せる行の条件 | **隠されていて (`hidden_at IS NOT NULL`)、隠してから 89 日 (`HIDDEN_CONTENT_RESTORE_WINDOW_DAYS` = 保管期間 90 日 − 1 日) 以内の行だけ**。行が無い (持ち主が消した・完全削除された) → 410、隠れていない → 409、89 日を過ぎた → 409 | §6.1 §11 |
| D-3 | `hidden_*` の戻し方 | **3 列とも NULL に戻す** (隠れていない状態の正規形は「3 列とも NULL」。migration 20261009000500 の 1.)。履歴の列・表は足さない。隠していたときの値 (`hidden_at` / `hidden_by` / `hidden_reason`) は監査ログの `details` に残す | §5 §6.2 |
| D-4 | 戻す理由 | **必須** (`restore_note`。1〜5000 字・前後の空白を除く)。モデレーションの判定を覆す操作なので、理由の無い実行を許さない。食事は `moderation_flags.resolution_note` にも書く (レシピの `recipe_flags` には列が無いので監査ログだけ) | §7.1 |
| D-5 | 同じ操作で隠した複製 (食事) | **通報された行と同じ `paste_group_id` で、`hidden_at` が同じ行をまとめて戻す** (隠す操作は 1 回の UPDATE で同じ `hidden_at` を書く。写真とメモが同じ複製 = 同じ操作で隠した行)。別の操作 (別の時刻) で隠した行は戻さない。隠したあとで持ち主が中身を書き換えた複製も、同じ操作で隠した行なので戻す | §4.1 §6.3 |
| D-6 | 通報 (`moderation_flags` / `recipe_flags`) の扱い | **戻す行を指す通報のうち `rejected` のものを、すべて `approved` にする** (コンテンツが見える状態に戻った以上、「却下 (削除)」の判定は残せない)。`resolved_by` / `resolved_at` (レシピは `reviewed_by` / `reviewed_at`) は戻した運営と時刻。`pending` / `escalated` / `approved` の通報は触らない。新しい状態は足さない | §4.1 §10.3 |
| D-7 | 書く順 | **通報 → 行** (隠す操作の「行 → 通報」の逆)。通報の更新に失敗したら何も変えず 500。通報を `approved` にしたあとで行の更新に失敗したら 500 `OP_CONTENT_RESTORE_FAILED`。行は隠れたままなので画面に「非表示の解除」の欄が出続け、同じ操作をやり直せば行が戻る (通報の更新は 0 行で素通り)。逆の順にすると「行は見えるのに通報は却下のまま」になり、画面から直す手段が無くなる | §4.2 §4.3 (S-14・S-15) |
| D-8 | 監査ログ | `admin.moderation.restore` (operator/07 §4.1 に足す)。`target_id` = 通報の id・`target_type` = `moderation_item:<type>`。`details` に通報・コンテンツ・持ち主・理由・隠していたときの 3 列の値・対象の行・戻した行・`approved` にした通報・各段の成否。成功は severity `info`、失敗は `warn`。本人の権限の client (`createClient()`) で `recordAdminAudit()` を通す (fail-open) | §8 |
| D-9 | 投稿者への通知 | **知らせない**。戻した行は本人にはもともと見えていた (隠しても本人には見える)。本人向けの表示・通知の経路は足さない | §1.2 |
| D-10 | 権限 | 隠す操作と同じ `requireRole(['admin', 'super_admin', 'content_moderator'])` (既定の assurance = `aal2`。`MFA_REQUIRED_ROLES` の admin / super_admin は AAL2 が要り、content_moderator は cross/12 の方針どおり MFA の対象外)。`delete_and_perm_ban` のような super_admin 限定は設けない (戻す操作は BAN を解かない: D-11) | §8 §18 |
| D-11 | BAN との関係 | **戻す操作は BAN (`user_profiles.frozen_at`) に触らない**。BAN の解除は既存の `DELETE /api/admin/users/{id}/freeze` | §1.2 |
| D-12 | 画面 | 詳細 `/admin/moderation/{type}/{id}` に「非表示の解除」の欄 (理由の入力 + ボタン。隠れている間だけ出る。89 日を過ぎたら案内だけ)。一覧 `/admin/moderation` のステータスの列に「非表示中」のバッジ。API (`GET /queue`・`GET /{type}/{id}`) が `hidden_at` を返すようにする | §9 |
| D-13 | 完全削除のジョブとの競合 | 戻せる期間を保管期間より 1 日短くする (D-2)。ジョブは「実行を始めた時刻の 90 日前」より前の行を消し、戻す操作は「要求の時刻の 89 日前」以後の行だけを戻す。2 つの期限は別の時刻で決まるが、1 日の幅はジョブの 1 回の実行 (300 秒) より十分長いので、同じ行が同時に両方の対象になることは無い。戻した行は `hidden_at` が NULL になるので、以後のジョブの対象から外れ、画像も「使っている行がある」として残る | §4.2 §6.1 §19 |

### 0.2 分冊判定

目安 3 つのうち「800 行超」に当たるが、**1 冊にする**。新しい migration が無く、触る共有面は運営のモデレーションの部品 (`moderation-schemas.ts`・`moderation-backend.ts`) だけで、消費先は運営の画面 1 つ。作るものは 1 つの機構 (判定 → 通報 → 行 → 監査) で、分けると判定の正本 (§10) が散る。実装は §14 の 2 段 (A: 部品と API / B: 画面) に分け、段ごとに 2 枚のレビューを閉じる。

### 0.3 用語

| 語 | 意味 |
|---|---|
| 隠す (hide) | `delete_*` の判定で `hidden_at` / `hidden_by` / `hidden_reason` を書くこと (`hideModeratedContent`)。本人以外に見えなくなる (RLS) |
| 戻す (restore) | 本書の操作。3 列を NULL に戻し、本人以外にも再び見えるようにする |
| 通報 (flag) | `moderation_flags` (食事) / `recipe_flags` (レシピ) の 1 行。API の `{id}` はこの id |
| コンテンツの行 | 通報が指す `meals` / `recipes` の 1 行 (`content_id`)。戻す対象の起点 |
| 同じ操作で隠した行 | コンテンツの行と同じ `paste_group_id` で、`hidden_at` が同じ `meals` の行 (D-5)。レシピはコンテンツの行だけ |
| 戻せる期間 (restore window) | 隠してから `HIDDEN_CONTENT_RESTORE_WINDOW_DAYS` (89 日) 以内 (D-2・D-13) |
| 保管期間 (retention) | 隠してから 90 日 (`HIDDEN_CONTENT_RETENTION_DAYS`。オーナーの選択 2026-10-15)。過ぎた行をジョブが消す |

### 0.4 決まったこと (オーナーの選択 2026-10-17)

| # | 決まったこと | 本書での形 |
|---|---|---|
| 1 | 戻す操作を「今作る」。 | 本書の全体 (画面 + API) |

### 0.5 Issue 本文・コメントとの食い違い (本書を正とする)

- Issue #1538 の 2026-10-17 の最後のコメントは、残りを「項目 4: 戻す操作 (必要になったら作る)」と書く。本書は §0.4 のオーナーの選択 (2026-10-17) に従い、今作る (§18 の 1 に記録)。
- Issue #1538 の本文の項目 4 は「hidden_* を戻す運営の画面と API」とだけ書く。戻せる期間・理由の要否・通報の扱い・複製の扱いは本書 §0.1 で決めた。
- migration `20261016100000_purge_hidden_content.sql` の冒頭のコメント (「隠した行を元に戻す操作 (必要なときは service_role で hidden_* を NULL に戻す)」) と `20261009000500` の「運営が隠した行を元に戻す画面・API は作らない」は、適用済みの migration の、その時点の事実としてそのまま残す (書き換えない)。コード側の説明 (`operator/02-api-spec.md` §5 の「隠した行を元に戻す操作は、まだ無い」) は §17 の追随表で現在形にする。

---

## 1. 目的・スコープ

### 1.1 解決すること

- 運営が `delete_*` で隠した食事・レシピを、運営の画面から安全に元に戻せるようにする (誤判定・申し立てへの対応)。いまは service_role で SQL を打つしか無い (migration 20261016100000 の注記)。
- 戻したコンテンツが、完全削除のジョブに消されないことを構造で保証する (D-13)。
- 戻したことを、誰が・いつ・何を・なぜ、の形で監査ログに残す (D-8)。
- 通報の状態とコンテンツの見え方を食い違わせない (D-6・D-7)。

### 1.2 対象外 (本書では決めない・変えない)

- 隠す操作そのもの (`hideModeratedContent`・`POST / PUT /api/admin/moderation/{type}/{id}`・判定の順「隠す → 判定の保存 → BAN」)。本書は `GET` の応答に `hidden_at` を足すだけ (§7.2)。
- 完全削除のジョブ (`purge-hidden-content`・保管期間 90 日・画像の削除の規則・pg_cron の登録)。
- RLS・ガードのトリガー・索引・`paste_meal_to_family`・`count_meals_per_user`・`calculate-segment-stats` の `hidden_at IS NULL` の条件。戻した行は `hidden_at` が NULL になるので、どれも隠す前の扱いに自然に戻る。
- BAN の解除 (D-11)。投稿者への通知 (D-9)。本人のアカウント出力 (`src/lib/account-export-tables.ts`。戻せば `hidden_at` / `hidden_reason` が null で出るだけ)。
- `ai_content` (バックエンドの表が無い。既存どおり 501)。
- 隠した行の一覧の専用画面 (一覧は既存の `/admin/moderation?status=rejected` に「非表示中」のバッジを足すことで足りる。D-12)。
- 90 日を過ぎて戻せなくなった行の救済 (保管期間の変更はオーナーの判断。§19)。

---

## 2. 関連要件と現行の事実 (相 1 の「いまの事実」)

### 2.1 根拠

- 要件: Issue #1538 の本文 (項目 4) と 2026-10-17 のコメント (オーナーの選択 (2026-10-17))。要件定義 `docs/requirements/03-operator-admin.md` §5.3 (モデレーション)・§15.8 (監査)。
- 現行 (origin/main `9dd73f23`・2026-10-17):
  - 列: `meals` / `recipes` の `hidden_at timestamptz` / `hidden_by uuid REFERENCES auth.users ON DELETE SET NULL` / `hidden_reason text`。どれも NULL 可・既定値なし。NULL = 隠れていない (migration `20261009000500` の 1.)。
  - ガード: `guard_hidden_content_columns()` (`BEFORE INSERT OR UPDATE OF hidden_at, hidden_by, hidden_reason`) は `current_user` が `authenticated` / `anon` のときだけ `42501 CANNOT_MODIFY_PRIVILEGED_COLUMN`。service_role と DEFINER 関数は止まらない (同 3.)。**戻す操作は service_role (`getSupabaseAdmin()`) で書けば、DB の変更なしに通る**。
  - RLS: `meals_select_owner_or_family` = `(hidden_at IS NULL OR user_id = auth.uid()) AND can_view_user_meals(user_id)`、`recipes."Users can view public recipes"` = `(hidden_at IS NULL OR auth.uid() = user_id) AND (user_id IS NULL OR is_public OR auth.uid() = user_id)` (同 4.)。`hidden_at` を NULL に戻せば、本人以外にも再び見える。
  - 貼り付け: `paste_meal_to_family` は `v_source.hidden_at IS NOT NULL` で `MEAL_HIDDEN` (同 5.)。戻せば通る。
  - 隠す側: `hideModeratedContent` (`src/lib/admin/moderation-backend.ts`) は、食事なら通報された行の `paste_group_id` / `photo_url` / `memo` を読み、同じ `paste_group_id` でまだ隠れていない行のうち中身が同じものを `targetIds` にし、**1 回の `.update({ hidden_at: new Date().toISOString(), hidden_by, hidden_reason: 'moderation:<action>' }).in('id', targetIds).is('hidden_at', null)`** で隠す (すでに隠れている行は上書きしない)。したがって同じ操作で隠した行は `hidden_at` / `hidden_by` / `hidden_reason` がすべて同じ値になる (D-5 の根拠)。
  - 判定の route (`src/app/api/admin/moderation/[type]/[id]/route.ts`): `rejectNullCharacterBody` → `requireRole(['admin', 'super_admin', 'content_moderator'])` → `MODERATION_TYPES` の検査 (400) → `isModerationBacked` (501) → 本文 → `fetchModerationSingle` (service_role) → 隠す → `resolveModerationItem` (status: approve = `approved` / escalate = `escalated` / それ以外 = `rejected`) → BAN → `recordAdminAudit` (`admin.moderation.<action>`・`details` に `content_id` / `hidden` / `hidden_ids` / `status_saved` ほか)。`delete_and_perm_ban` だけ super_admin 限定。
  - 一覧・詳細の API: `fetchModerationList` / `fetchModerationSingle` は `select('*, meals(user_id, photo_url)')` / `select('*, recipes(user_id, image_url)')` で、正規化した `NormalizedModerationItem` に `hidden_at` は無い (画面は隠れているかを知る手段が無い)。
  - 通報の表: `moderation_flags (id, meal_id, user_id, reason, status, created_at, updated_at, flag_type, resolved_by, resolved_at, resolution_note)`・`recipe_flags (id, recipe_id, reporter_id, flag_type, reason, status, reviewed_by, reviewed_at, created_at)`。`status` は `text` (CHECK 制約なし)。アプリが使う値は `pending` / `approved` / `rejected` / `escalated` (`ModerationQueueSearchSchema`)。`moderation_flags.meal_id` / `recipe_flags.recipe_id` はコンテンツの行に CASCADE。
  - 完全削除 (`purgeExpiredHiddenContent`): `cutoff = now − 90 日`。表ごとに `.lt('hidden_at', cutoff)` で古い順に 100 行読み、画像を Storage API で消してから `.delete().in('id', ids).lt('hidden_at', cutoff)` で消す (消す直前にも期限を確かめ直す)。1 回 300 秒まで。読んだ行が 1 行も消えなかったら止める (「同時に別の処理が消した・戻した」の注記あり)。画像は `hidden_content_purge_referenced_needles(p_needles, p_cutoff)` が「`hidden_at IS NULL` または `hidden_at >= p_cutoff` の行が使っている」と答えたものを消さない。
  - pg_cron のジョブ `purge-hidden-content` は毎日 03:25 JST (`25 18 * * *` UTC)。
  - 監査ログ: `admin_audit_logs` の `severity` は `info` / `warn` / `critical` (CHECK)。`target_type` は varchar(30) (`moderation_item:recipe` = 22 字で収まる)。`recordAdminAudit()` は fail-open で `{ ok }` を返す。変更系の route は `recordAdminAudit` を通し、`request` を渡す (`tests/admin-mutation-audit-coverage-1571.test.ts`)。
  - MFA: `MFA_REQUIRED_ROLES = ['super_admin', 'admin', 'finance', 'org_industrial_doctor']` (`src/lib/auth/mfa/policy.ts`)。`requireRole` の既定 (`assurance: 'aal2'`) は、この 4 つを持つ人に AAL2 を求める。content_moderator は対象外。
  - 画面: 一覧 `src/app/admin/moderation/page.tsx` (status の絞り込み `pending` / `approved` / `rejected` / `escalated`・`GET /api/admin/moderation/queue` 経由)。詳細 `src/app/admin/moderation/[type]/[id]/page.tsx` (`GET /api/admin/moderation/{type}/{id}` 経由・`ModerationReviewForm` は `status === 'pending'` のときだけ入力欄を出し、それ以外は「このアイテムは既に審査済みです」)。
  - 本人の出力: `src/lib/account-export-tables.ts` は `meals` / `recipes` の `hidden_by` だけ省き、`hidden_at` / `hidden_reason` は出す。
  - テスト基盤: 単体は `tests/helpers/fake-supabase.ts` (`select` / `eq` / `is` / `in` / `update` / `insert` / `delete` / `single` / `maybeSingle`。**`gte` は無い**)、結合は ローカル Supabase (PostgREST を直接: `tests/integration/rls/hidden-content-visibility.test.ts`) と Next の開発サーバー (`tests/integration/operator/admin-moderation-detail.test.ts`。`apiCall` / `dataOf` / `expectError` / `latestAuditLog`)。
  - `tests/jst-today-source-scan.test.ts` の規則 G: timestamptz の列を `.gte` / `.lt` などで絞る箇所は、暦日でない理由を許可リストに書く (`hidden-content-purge.ts` は count 2 で登録済み)。

### 2.2 本番の読み取り

本番 (Supabase) は読んでいない。本番の隠した行の件数・完全削除の実績は、本書の構造に影響しない (件数が 0 でも 1,000 でも同じ道を通る)。実装後の整合ゲートで、隠した行が 0 件でないなら 1 件を戻して確かめる (§13.4)。

---

## 3. 相 1: 外形固定 — 要件行列とユーザーシナリオ

### 3.1 要件行列 (全 20 行)

| # | 要件 | 根拠 | 本書の節 |
|---|---|---|---|
| R-01 | 運営の画面から、隠した食事・レシピを元に戻せる (API `POST /api/admin/moderation/{type}/{id}/restore` + 詳細画面の欄) | オーナーの選択 (2026-10-17)・Issue 本文の項目 4 | §8 §9 |
| R-02 | 戻せるのは、隠されていて、まだ完全に消えていない行だけ。行が無ければ 410、隠れていなければ 409 | Issue 本文の項目 4・D-2 | §6.1 §11 |
| R-03 | 隠してから 89 日を過ぎた行は戻さない (409)。保管期間 90 日の完全削除と同じ行を同時に扱わない | D-13 | §6.1 §4.2 |
| R-04 | 戻した行は、以後の完全削除の対象にならず、画像も消されない | D-13・`hidden-content-purge.ts` の `.lt('hidden_at')`・`hidden_content_purge_referenced_needles` の `hidden_at IS NULL` | §13.3 (I-5) |
| R-05 | `hidden_at` / `hidden_by` / `hidden_reason` を 3 列とも NULL に戻す。履歴は監査ログ | D-3 | §6.4 |
| R-06 | 食事は、同じ操作で隠した複製 (同じ `paste_group_id`・同じ `hidden_at`) をまとめて戻す。別の操作で隠した行は戻さない。レシピはその行だけ | D-5 | §6.3 |
| R-07 | 戻す理由 (`restore_note`) は必須 (1〜5000 字・前後の空白を除く)。NULL 文字は 400 `INVALID_CHARACTER` | D-4・#1657 | §7.1 §8 |
| R-08 | 戻す行を指す `rejected` の通報を `approved` にし、`resolved_by` / `resolved_at` (レシピは `reviewed_by` / `reviewed_at`) を戻した運営と時刻に、食事は `resolution_note` を理由にする。ほかの状態の通報は触らない | D-6 | §6.5 §10.3 |
| R-09 | 書く順は通報 → 行。どの失敗でも成功を装わない (500)。行が隠れたままなら、同じ操作をやり直して戻せる | D-7 | §8 §4.3 |
| R-10 | 監査ログ `admin.moderation.restore` を、成功でも失敗でも 1 行残す (本人の client・`recordAdminAudit`・`request` を渡す)。`details` に理由・隠していたときの 3 列の値・対象と戻した行・`approved` にした通報・各段の成否 | D-8・07 §4・#1571 | §8 |
| R-11 | 権限は隠す操作と同じ 3 ロール。未認証 401・ロール不足 403 は既存の文面とコード | D-10・route の `requireRole` | §8 |
| R-12 | `ai_content` は本文の検証より前に 501 `OP_NOT_SUPPORTED` | #1128 | §8 |
| R-13 | 一覧 (`GET /queue`) と詳細 (`GET /{type}/{id}`) の応答に `hidden_at` (ISO 文字列 / null) を足す。既存の項目は変えない | D-12 | §7.2 |
| R-14 | 詳細画面は、隠れている間だけ「非表示の解除」の欄を出す。89 日を過ぎていたら理由の欄とボタンを出さず案内だけ。審査待ち (pending) の通報でも、隠れていれば出す | D-12 | §9.1 §9.2 |
| R-15 | 一覧画面は、隠れている行に「非表示中」のバッジを出す (status の絞り込みは変えない) | D-12 | §9.3 |
| R-16 | 戻す操作は BAN を解かない・投稿者に知らせない | D-9・D-11 | §1.2 |
| R-17 | DB の変更なし (migration・RLS・トリガー・関数・索引・型ファイルを変えない)。環境変数を足さない | D-3・§5 | §5 §12 |
| R-18 | 新しい route は既存の番兵 (NULL 文字・監査の網羅・MFA の入口・JST の走査・生のエラー文の走査) に追随する | §2.1 のテスト基盤 | §16 |
| R-19 | 保管期間の値は Edge Function の `HIDDEN_CONTENT_RETENTION_DAYS` が正本。src 側の写しとの一致を契約テストで固定する | §6.1 の注記 | §13.1 (CT-1) |
| R-20 | 同じコンテンツを 2 人の運営が同時に戻しても、片方は 200、もう片方は 409 (成功を 2 回数えない) | D-7 の 0 行更新の扱い | §8 §4.3 (S-16) |

### 3.2 ユーザーシナリオ (23 本)

時刻は JST。「運営」は admin / super_admin / content_moderator のどれか。

| # | シナリオ | 期待する結果 |
|---|---|---|
| S-01 | 運営が食事の通報 F1 を `delete_only` で判定 (行 M1 を隠す。複製なし)。本人から申し立てがあり、3 日後に別の運営が F1 の詳細画面で理由「申し立てを確認。規約違反ではなかった」を入れて「表示に戻す」を押す | 200。M1 の 3 列が NULL・F1 が `approved` (`resolved_by` = 戻した運営・`resolution_note` = 理由)。家族に再び見える。監査ログ `admin.moderation.restore` (info) に `content_id` = M1・`restored_ids` = [M1]・`approved_flag_ids` = [F1]・`hidden_at_before` ほか。画面は「表示に戻しました (1 行)」のあと、状態が `approved`・「表示中」に更新される |
| S-02 | S-01 と同じだが、M1 は家族へ貼り付け済みで、複製 M2・M3 (写真とメモが同じ) も同じ操作で隠れている (同じ `hidden_at`) | 200。M1・M2・M3 がまとめて戻る (`restored_ids` = 3 つ)。M2・M3 の持ち主の家族にも再び見える |
| S-03 | S-02 で、隠されたあとに M2 の持ち主がメモを書き換えていた | M2 も戻る (同じ操作で隠した行は、中身が変わっていても戻す: D-5)。`restored_ids` に M2 を含む |
| S-04 | S-02 の貼り付けグループに、別の通報 F9 で別の時刻に隠された複製 M4 (中身を書き換えたあとで通報されたもの) がある | M4 は戻らない (`hidden_at` が違う)。F9 は `rejected` のまま。M4 の詳細画面を開けば、別に戻せる |
| S-05 | 運営が公開レシピ R1 の通報 F2 を `delete_and_warn` で判定 (R1 を隠す)。翌日戻す | 200。R1 の 3 列が NULL。未ログインの `GET /api/recipes` に再び出る。`recipe_flags` F2 は `approved`・`reviewed_by` = 戻した運営 (`resolution_note` の列は無いので理由は監査ログだけ) |
| S-06 | M1 に 2 件の通報 F1・F3 があり、両方 `delete_only` で `rejected` (2 件目は隠す対象がすでに隠れていたので上書きなし)。運営が F3 の画面から戻す | 200。M1 が戻り、F1 と F3 の両方が `approved` (`approved_flag_ids` = [F1, F3])。F1 の画面を開いても「表示中」で解除の欄は出ない |
| S-07 | S-01 のあと、別の運営が (古い画面のまま) もう一度「表示に戻す」を押す | 409 `OP_CONTENT_NOT_HIDDEN`「このコンテンツはすでに表示されています」。何も変えず、監査ログも残さない。画面は文面を出して状態を読み直す (`router.refresh()`) |
| S-08 | 隠してから 92 日たった行 (03:25 のジョブがまだ消していない・または消し残し) を戻そうとする | 409 `OP_CONTENT_RESTORE_WINDOW_EXPIRED`「隠してから 89 日を過ぎたため戻せません (保管期間 90 日で完全に削除されます)」。詳細画面は理由の欄とボタンを出さず、この案内だけを出す |
| S-09 | 持ち主が自分で M1 を消した (または完全削除のジョブが消した) あとで、F1 の画面から戻そうとする (通報は CASCADE で消えているので F1 も無い) | 404 `NOT_FOUND` (通報が無い)。持ち主が消したのに通報だけ残る形 (`meal_id` が NULL) なら 410 `OP_CONTENT_GONE`「コンテンツはすでに削除されています」 |
| S-10 | 通報にコンテンツが紐づいていない (`content_id` が null) 通報で戻そうとする | 410 `OP_CONTENT_GONE`。何も変えない |
| S-11 | 理由を空 (空白だけ) で送る / 5001 字で送る / 本文が JSON でない / 本文に NULL 文字 | 400 `VALIDATION_ERROR` / 400 `VALIDATION_ERROR` / 400 `INVALID_JSON` / 400 `INVALID_CHARACTER` (認証・DB より前)。画面は空と 5000 字超を送らずに知らせる |
| S-12 | content_moderator が戻す / support が戻す / 未ログインで呼ぶ | 200 (隠す操作と同じ 3 ロール) / 403 `OP_PERMISSION_DENIED` / 401 `AUTH_UNAUTHENTICATED` |
| S-13 | S-01 の翌日 03:25 に完全削除のジョブが動く | M1 は `hidden_at` が NULL なので対象外。M1 の写真は `hidden_content_purge_referenced_needles` が「使っている行がある」と答えるので、同じ写真を指す別の期限切れの行があっても消えない |
| S-14 | S-01 で、通報の更新 (`moderation_flags` の UPDATE) が DB のエラーになった | 500 `INTERNAL_ERROR`「通報の状態を更新できませんでした。コンテンツはまだ非表示のままです。もう一度同じ操作を実行してください」。行は触っていない。監査ログ (warn) に `status_saved: false` / `status_error` / `restored: false`。画面は欄を閉じず、もう一度押せる |
| S-15 | S-01 で、通報は `approved` にできたが、行の UPDATE が DB のエラーになった | 500 `OP_CONTENT_RESTORE_FAILED`「コンテンツを表示に戻せませんでした。通報の状態は承認済みにしました。もう一度同じ操作を実行してください」。監査ログ (warn) に `status_saved: true` / `approved_flag_ids` / `restored: false` / `restore_error`。行は隠れたままなので、画面を開き直しても解除の欄が出る。やり直すと通報は 0 行更新で素通りし、行が戻って 200 |
| S-16 | 2 人の運営がほぼ同時に M1 を戻す | 先の人は 200。後の人は、行の UPDATE が 0 行 (すでに NULL) → 読み直して `not_hidden` → 409 `OP_CONTENT_NOT_HIDDEN`。通報の更新は後の人では 0 行で素通り。監査ログは先の人の 1 行だけ |
| S-17 | `delete_and_temp_ban` で隠され、持ち主が BAN 中の行を戻す | 200。行は戻るが BAN はそのまま (`frozen_at` に触らない)。画面の結果に「BAN の解除は利用者の画面から」の 1 文を添える |
| S-18 | M1 が隠れている状態で、3 件目の通報 F5 が `pending` のまま残っている。運営が F5 の画面を開く | 審査の欄 (pending なので出る) と、非表示の解除の欄の両方が出る。解除すると M1 が戻り、F5 は `pending` のまま (触らない)。あとで F5 を `delete_only` で判定すると、M1 は新しい `hidden_at` で隠れ、保管期間はそこから数え直し |
| S-19 | `type = ai_content` で呼ぶ | 501 `OP_NOT_SUPPORTED` (本文の検証より前)。未認証・ロール不足はそれより前に 401 / 403 |
| S-20 | S-01 のあと、本人が M1 を家族に貼り付ける | 通る (`paste_meal_to_family` の `MEAL_HIDDEN` は `hidden_at IS NOT NULL` のときだけ) |
| S-21 | S-01 のあと、本人がアカウントの出力を取る | `meals` の `hidden_at` / `hidden_reason` が null で出る (`hidden_by` はもともと出さない)。コードの変更なし |
| S-22 | 運営が一覧を `status=rejected` で開く | 隠れている行の通報にはステータスの横に「非表示中」のバッジ。戻した行の通報は `approved` の一覧に移り、バッジは出ない。`pending` の通報でも、コンテンツがすでに隠れていればバッジが出る (S-18 の F5) |
| S-23 | 公開レシピ R2 を隠したあとで持ち主が退会し、`recipes.user_id` が NULL になった (外部キー `recipes_user_id_fkey` は `ON DELETE SET NULL`。migration `20251126124224`。退会で残るのは公開レシピだけ: migration `20261010000100`)。運営が R2 の通報の画面から戻す | 200。R2 の 3 列が NULL になり、RLS `"Users can view public recipes"` の `user_id IS NULL` の項で全員に再び見える (隠れている間は `hidden_at IS NULL OR auth.uid() = user_id` が誰にも真にならず、誰にも見えない)。判定は `user_id` を見ないので S-05 と同じ道を通る。監査ログの `content_user_id` は null。隠した運営が退会して `hidden_by` が NULL の行も、判定は `hidden_at` だけを見るので同じ道 (`hidden_by_before` が null) |

---

## 4. 相 2・相 3: 構造とその裁定

### 4.1 構造 (確定)

```mermaid
flowchart LR
  UI[詳細画面<br/>ModerationRestoreForm] -->|POST restore_note| RT[POST /api/admin/moderation/type/id/restore]
  RT -->|1 requireRole 3 ロール| RT
  RT -->|2 fetchModerationSingle 通報| FL[(moderation_flags / recipe_flags)]
  RT -->|3 restoreModeratedContent| LIB[[src/lib/admin/hidden-content-restore.ts]]
  LIB -->|a readHiddenContentRow| CT[(meals / recipes)]
  LIB -->|b judgeHiddenContentRestorability<br/>gone / not_hidden / window_expired / restorable| LIB
  LIB -->|c listRowsHiddenTogether 同じ paste_group_id・同じ hidden_at| CT
  LIB -->|d approveRejectedFlagsOfContent rejected → approved| FL
  LIB -->|e restoreHiddenContentRows 3 列を NULL・hidden_at = 読んだ値・>= 89 日前| CT
  RT -->|4 recordAdminAudit admin.moderation.restore| AL[(admin_audit_logs)]
  CT -.->|hidden_at NULL → 対象外| PG[purge-hidden-content 03:25 JST]
```

- 判定と読み書きは新設の 1 モジュール `src/lib/admin/hidden-content-restore.ts` (§6) に置く。route (§8) は HTTP への写像 (認可・本文・応答・監査ログ) だけ。隠す側 (`moderation-backend.ts`) は `hidden_at` を返す変更だけ (§7.2)。
- 「同じ操作で隠した行」は `hidden_at` の等値で決める (D-5)。隠す側が 1 回の UPDATE で同じ値を書くので、新しい列 (操作の id) を足さずに操作の単位を復元できる。
- 行の UPDATE は `in('id', targetIds)` + `eq('hidden_at', 読んだ値)` + `gte('hidden_at', now − 89 日)` で絞る。`eq` は「判定したのと同じ隠し操作」を、`gte` は戻せる期間を、それぞれ書く瞬間にもう一度確かめる (読んでから書くまでに別の操作が戻した・隠し直した・期限を過ぎた行は 0 行になる)。
- 0 行更新のときは行を読み直して理由を決める (`gone` → 410 / `not_hidden` → 409 / `window_expired` → 409 / それ以外 = 別の時刻で隠し直されている → 409 `CONFLICT_STALE_DATA`)。

### 4.2 代替案と裁定 (相 3・1 回だけ)

| 案 | 中身 | 退ける / 採る理由 |
|---|---|---|
| **A (採用)**: アプリ側で 2 文 (通報 → 行) + 判定の純関数 | 新しいモジュール 1 つ。DB は変えない。失敗は段ごとに 500 で明示し、行が隠れたままならやり直せる | 隠す側と同じ形 (アプリ側で「隠す → 判定の保存」の 2 文。部分失敗は監査ログとやり直しで受ける) なので、運営の操作の失敗の見え方が揃う。migration・型ファイル・EXECUTE の権限・down.sql が要らず、番兵の追随が最小。残る縁 (S-14・S-15・S-16) は、書く順 (D-7) と 0 行更新の読み直しで、どれも「やり直せば直る」状態に閉じる |
| B: DB の関数 `restore_moderated_content(...)` で 1 トランザクション | migration で plpgsql の関数を足し、通報と行を同じトランザクションで更新。`FOR UPDATE` で行を固定し、`now()` で期限を決める | 部分失敗と競合が構造的に消えるが、migration (番号の確定・本番への適用の順・down.sql)・`database.types.ts` 2 か所・EXECUTE の REVOKE / GRANT・SQL の契約テスト・結合テストが増える。隠す側がアプリ側の 2 文なのに戻す側だけ DB 関数にすると、2 つの操作の失敗の見え方が食い違う。ローンチ前・利用者ゼロで、同時に同じ行を戻す運営が 2 人いる場面は実際には起きにくい。A の縁がやり直しで閉じることを確かめた上で、A を採る |
| C: 履歴の表 (`moderation_content_hides`) + 通報の新しい状態 `restored` | 隠す・戻すを 1 行ずつ記録し、通報の状態に `restored` を足す | 履歴は監査ログ (7 年) がすでに持つ (`hidden_ids`・本書の `restored_ids` と隠していたときの値)。新しい状態は Zod・画面の絞り込み・バッジ・既存テストの `status` の列挙に波及し、`approved` で表せる意味 (この通報の判定は「問題なし」で決着) に名前を増やすだけ。退ける |
| D: 戻す対象を通報でなくコンテンツの id で指定する (`POST /api/admin/moderation/content/{type}/{contentId}/restore`) | 通報が消えていても戻せる | 通報が消えるのはコンテンツが消えたとき (CASCADE) だけなので、通報を起点にして困る場面が無い。運営の画面は通報を単位にしているので、入口を揃える。退ける |

縁の発生源を消すより単純な構造は無いか: 2 文のあいだの失敗 (S-15) と競合 (S-16) は A の構造が生む縁だが、B で消すと別の縁 (migration と型の同期・権限) が生まれ、隠す側との非対称も生む。A の縁は「行が隠れたままならやり直せる」の 1 つの性質で全部閉じるので、A のまま確定する。以後、本書の中で構造を蒸し返さない。

### 4.3 トレース (全シナリオを §4.1 の構造で手で走らせる)

| # | 道 (§4.1 の番号) | 結果の確認 |
|---|---|---|
| S-01 | 1 → 2 (F1・`content_id` = M1) → 3a (M1: `hidden_at` = t1) → 3b restorable → 3c (`paste_group_id` null → [M1]) → 3d (F1 rejected → approved) → 3e (1 行) → 4 (info) → 200 | `restored_ids` = [M1]・`approved_flag_ids` = [F1]。RLS: `hidden_at IS NULL` で家族に見える |
| S-02 | 3c が `eq('paste_group_id', g).eq('hidden_at', t1)` で [M1, M2, M3] → 3d (`meal_id IN (M1,M2,M3) AND status = rejected` → F1) → 3e (3 行) | `restored_ids` = 3 つ |
| S-03 | 3c は中身を見ない (`hidden_at` の等値だけ) → M2 を含む | D-5 のとおり |
| S-04 | M4 は `hidden_at` = t9 ≠ t1 → 3c に入らない → 3d の `meal_id IN` にも入らず F9 は rejected のまま | M4 の画面から別に戻せる (S-01 と同じ道) |
| S-05 | 2 (F2・`content_id` = R1) → 3a (recipes) → 3c ([R1]) → 3d (`recipe_flags` の `recipe_id IN (R1)`・`reviewed_by` / `reviewed_at`) → 3e → 200 | 未ログインの `GET /api/recipes` は RLS `"Users can view public recipes"` で再び返す |
| S-06 | 3d の UPDATE は `meal_id IN (M1) AND status = rejected` なので F1・F3 の両方 → `approved_flag_ids` = [F1, F3] | F1 の画面: `hidden_at` null → 欄なし |
| S-07 | 3a (`hidden_at` null) → 3b not_hidden → 409。3c〜3e・4 に進まない | 監査ログなし (状態を変えていない) |
| S-08 | 3a (`hidden_at` = 92 日前) → 3b window_expired (< now − 89 日) → 409 | 画面は `isWithinHiddenContentRestoreWindow` が false で案内だけ |
| S-09 | 2 で通報なし → 404 / 通報はあるが `content_id` null → 3 に入らず 410 | — |
| S-10 | 2 (`content_id` null) → 410 | — |
| S-11 | 0 (NULL 文字 400) / 本文 400 / Zod 400 — どれも 2 より前 | 画面は送らずに知らせる (F-2) |
| S-12 | 1 で 401 / 403。content_moderator は通る | `requireRole` の既存の挙動 |
| S-13 | ジョブの `.lt('hidden_at', cutoff)` に `hidden_at` NULL の M1 は入らない。needles の関数は `m.hidden_at IS NULL` で M1 の URL を数える | I-5 |
| S-14 | 3d が例外 → `HiddenContentRestoreStepError('flags')` → 4 (warn・`status_saved: false`) → 500 `INTERNAL_ERROR` | 3e に進まない。行は隠れたまま |
| S-15 | 3d 成功 → 3e が例外 → `HiddenContentRestoreStepError('rows'・approvedFlagIds)` → 4 (warn・`status_saved: true`・`restored: false`) → 500 `OP_CONTENT_RESTORE_FAILED` | やり直し: 3d は 0 行 (もう approved)・3e で戻る → 200 |
| S-16 | 後の人: 先の人が書いたあとに 3a で読めば 3b not_hidden → 409。先の人より前に 3a で読んでいれば 3a〜3d (3d は 0 行) → 3e の UPDATE は先の人の行ロックを待ち、READ COMMITTED で `eq('hidden_at', t1)` を評価し直して 0 行 → 読み直し not_hidden → 409 | どちらの順でも先の人の 200・後の人の 409 と監査ログ 1 行だけ (結合 A-9) |
| S-17 | 3 は `user_profiles` に触らない → BAN はそのまま | 画面の 1 文 (F-1) |
| S-18 | F5 は pending なので 3d の `status = rejected` に合わず触らない。M1 は戻る | その後の delete_* は `hideModeratedContent` の `.is('hidden_at', null)` に合うので新しい `hidden_at` で隠す |
| S-19 | 1 → type の検査 → `isModerationBacked` false → 501 (本文を読む前) | 既存の route と同じ順 |
| S-20 | DB の関数の `v_source.hidden_at IS NOT NULL` が偽 | 既存 F3 と同じ道 |
| S-21 | `account-export-tables.ts` は列をそのまま出す | 変更なし |
| S-22 | `fetchModerationList` の embed に `hidden_at` を足し、正規化で `hidden_at` を返す → 一覧がバッジを出す | §7.2 §9.3 |
| S-23 | 1 → 2 (通報・`content_id` = R2・`item.user_id` = null) → 3a (recipes: `user_id` null・`hidden_at` = t2) → 3b restorable (`user_id` を見ない) → 3c ([R2]) → 3d (`recipe_flags`) → 3e (1 行) → 4 (info・`content_user_id: null`) → 200 | RLS: `hidden_at IS NULL` かつ `user_id IS NULL` で全員に見える (隠す前と同じ) |

---

## 5. データモデル

**変更なし。** 本書は新しい表・列・ポリシー・トリガー・関数・索引・migration を足さず、既存のものも変えない。理由:
- 隠れていない状態の正規形は「`hidden_at` / `hidden_by` / `hidden_reason` がすべて NULL」(migration 20261009000500 の 1. と、ガードの INSERT の条件)。戻す = その正規形に戻す UPDATE で、service_role ならガードに止められない (同 3.)。
- 「同じ操作で隠した行」は `hidden_at` の等値で復元できる (§2.1 の隠す側の事実)。操作の id の列は要らない。
- 履歴は `admin_audit_logs` (7 年・UPDATE / DELETE 不可) が持つ。隠したとき (`hidden_ids`) と戻したとき (本書の `details`) の両方が残る。
- 通報の `status` は `text` で CHECK 制約が無く、既存の値 `approved` を使う (D-6)。

読み書きする既存の表と列 (service_role):

| 表 | 読む | 書く |
|---|---|---|
| `meals` | `id, user_id, hidden_at, hidden_by, hidden_reason, paste_group_id` (`photo_url` / `memo` は読まない: D-5) | `hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL` |
| `recipes` | `id, user_id, hidden_at, hidden_by, hidden_reason` | 同上 |
| `moderation_flags` | (`fetchModerationSingle` で 1 行) | `status = 'approved', resolved_by, resolved_at, resolution_note` (`meal_id IN 対象 AND status = 'rejected'`) |
| `recipe_flags` | 同上 | `status = 'approved', reviewed_by, reviewed_at` (`recipe_id IN 対象 AND status = 'rejected'`) |
| `admin_audit_logs` | — | INSERT 1 行 (`recordAdminAudit`。本人の client) |

---

## 6. `src/lib/admin/hidden-content-restore.ts` (新設・型検査の対象)

判定の純関数と、service_role での読み書きを 1 つのファイルに置く (import は型 2 つだけ。DB・HTTP・環境変数に触れる型は持たない)。

```ts
/**
 * 運営が隠したコンテンツ (#1101) を戻す (#1538 の項目 4) — 判定の純関数と、service_role での読み書き。
 * 呼ぶのは POST /api/admin/moderation/{type}/{id}/restore (設計 docs/design/operator/13-hidden-content-restore.md)。
 *
 * 隠すのは src/lib/admin/moderation-backend.ts の hideModeratedContent (1 回の UPDATE で、同じ操作で隠した行に同じ hidden_at を書く)。
 * 完全削除は pg_cron のジョブ purge-hidden-content (supabase/functions/_shared/hidden-content-purge.ts。隠してから 90 日を過ぎた行と画像を消す)。
 * 戻した行は hidden_at が NULL になるので、完全削除の対象から外れ、画像も「使っている行がある」として残る。
 *
 * - 戻せるのは、隠されていて (hidden_at IS NOT NULL)、隠してから HIDDEN_CONTENT_RESTORE_WINDOW_DAYS (89 日) 以内の行だけ
 * - 食事は、通報された行と同じ paste_group_id で hidden_at が同じ行 (= 同じ操作で隠した複製) をまとめて戻す。レシピはその行だけ
 * - 書く順は「通報 (rejected → approved) → 行 (hidden_* を NULL)」。行が隠れたままなら、同じ操作をやり直して戻せる
 * - hidden_* を書き換えられるのは service_role だけ (DB のトリガー guard_hidden_content_columns) なので、admin には
 *   認可 (requireRole) を通したあとの getSupabaseAdmin() を渡すこと
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModerationBackedType } from '@/lib/admin/moderation-backend';

/**
 * 隠してから完全に消すまでの日数の写し。正本は supabase/functions/_shared/hidden-content-purge.ts の HIDDEN_CONTENT_RETENTION_DAYS
 * (オーナーの選択 2026-10-15: 90 日)。Edge Function のモジュールは Deno の書き方 (拡張子つきの import) で、src から型検査を通して
 * import できないので、ここに写す。一致は契約テスト (tests/hidden-content-restore-contract.test.ts CT-1) が確かめる
 */
export const HIDDEN_CONTENT_RETENTION_DAYS = 90;

/**
 * 戻せる期間を保管期間より短くする幅 (日)。完全削除のジョブは「実行を始めた時刻の 90 日前」より前の行を消し、戻す操作は
 * 「要求の時刻の 89 日前」以後の行だけを戻す。2 つの期限は別の時刻で決まるので、同じ行が両方の対象になる余地を、
 * ジョブの 1 回の実行時間 (300 秒。HIDDEN_CONTENT_PURGE_MAX_DURATION_MS) より十分長い 1 日の幅で消す。
 * これが無いと、ジョブが画像を消したあと行を消す前に戻す操作が割り込み、画像の無い行が残ることがある
 */
export const HIDDEN_CONTENT_RESTORE_MARGIN_DAYS = 1;

/** 戻せる期間 (隠してからの日数)。この日数を過ぎた行は戻さない (完全削除を待つ) */
export const HIDDEN_CONTENT_RESTORE_WINDOW_DAYS = HIDDEN_CONTENT_RETENTION_DAYS - HIDDEN_CONTENT_RESTORE_MARGIN_DAYS;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 通報の状態 (moderation_flags.status / recipe_flags.status) のうち、戻す操作が読む値と書く値 */
export const FLAG_STATUS_REJECTED = 'rejected';
export const FLAG_STATUS_APPROVED = 'approved';

/** 通報されたコンテンツ本体の表 (hideModeratedContent の contentTable と同じ対応) */
export const HIDDEN_CONTENT_TABLE_OF = {
  food: 'meals',
  recipe: 'recipes',
} as const satisfies Record<ModerationBackedType, 'meals' | 'recipes'>;

/** 通報の表 */
export const MODERATION_FLAG_TABLE_OF = {
  food: 'moderation_flags',
  recipe: 'recipe_flags',
} as const satisfies Record<ModerationBackedType, 'moderation_flags' | 'recipe_flags'>;

/** 通報の表の、コンテンツ本体を指す列 */
export const MODERATION_FLAG_CONTENT_COLUMN_OF = {
  food: 'meal_id',
  recipe: 'recipe_id',
} as const satisfies Record<ModerationBackedType, 'meal_id' | 'recipe_id'>;

/** コンテンツの行から読む列。paste_group_id は meals にしか無い */
const HIDDEN_CONTENT_COLUMNS_OF = {
  food: 'id, user_id, hidden_at, hidden_by, hidden_reason, paste_group_id',
  recipe: 'id, user_id, hidden_at, hidden_by, hidden_reason',
} as const satisfies Record<ModerationBackedType, string>;

/** 戻す操作に使う client。認可 (requireRole) を通したあとの service_role の client を渡す */
export type HiddenContentRestoreAdmin = Pick<SupabaseClient, 'from'>;

/** 通報が指すコンテンツ本体の行の、戻す操作に関わる列 */
export interface HiddenContentRow {
  id: string;
  /** 持ち主。退会で外れた公開レシピは null (外部キーは ON DELETE SET NULL)。戻せるかの判定には使わない (S-23) */
  user_id: string | null;
  hidden_at: string | null;
  hidden_by: string | null;
  hidden_reason: string | null;
  /** 家族への貼り付けのまとまり (meals だけ)。recipes は常に null */
  paste_group_id: string | null;
}

/** 隠れている行 (hidden_at が入っている) */
export interface HiddenContentRowHidden extends HiddenContentRow {
  hidden_at: string;
}

/** 戻せるかの判定 (読んだ行と「今」だけで決まる純関数の結果) */
export type HiddenContentRestorability =
  | { kind: 'restorable'; row: HiddenContentRowHidden }
  | { kind: 'not_hidden'; row: HiddenContentRow }
  | { kind: 'window_expired'; row: HiddenContentRowHidden }
  | { kind: 'gone' };

/** 戻せる期間の下限 = now の 89 日前。hidden_at がこれ以後の行だけを戻す */
export function hiddenContentRestoreCutoff(now: Date): Date {
  return new Date(now.getTime() - HIDDEN_CONTENT_RESTORE_WINDOW_DAYS * MS_PER_DAY);
}

/**
 * 隠した日時が戻せる期間の中か (hidden_at >= now − 89 日)。画面 (欄を出すか) と判定 (judgeHiddenContentRestorability) の両方が使う。
 * hidden_at が日時として読めないときは例外 (DB の timestamptz の列なので、起きるのはプログラムの誤り)
 */
export function isWithinHiddenContentRestoreWindow(hiddenAt: string, now: Date): boolean {
  const hiddenAtMs = Date.parse(hiddenAt);
  if (Number.isNaN(hiddenAtMs)) {
    throw new Error('isWithinHiddenContentRestoreWindow: hidden_at is not a valid timestamp');
  }
  return hiddenAtMs >= hiddenContentRestoreCutoff(now).getTime();
}

/** 読んだ行から、戻せるかを決める (§10.1.1 の判定表 P-9〜P-11 の正本) */
export function judgeHiddenContentRestorability(row: HiddenContentRow | null, now: Date): HiddenContentRestorability {
  if (row === null) return { kind: 'gone' };
  if (row.hidden_at === null) return { kind: 'not_hidden', row };
  const hidden: HiddenContentRowHidden = { ...row, hidden_at: row.hidden_at };
  return isWithinHiddenContentRestoreWindow(hidden.hidden_at, now)
    ? { kind: 'restorable', row: hidden }
    : { kind: 'window_expired', row: hidden };
}

/** PostgREST が返す行 (列を文字列で組み立てた select なので、形の分からない値として受けて列ごとに確かめる) */
interface RawHiddenContentRow {
  id: string;
  user_id?: string | null;
  hidden_at?: string | null;
  hidden_by?: string | null;
  hidden_reason?: string | null;
  paste_group_id?: string | null;
}

/** 通報が指すコンテンツ本体の行を読む。無ければ null。DB エラーは例外 */
export async function readHiddenContentRow(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  contentId: string,
): Promise<HiddenContentRow | null> {
  const { data, error } = await admin
    .from(HIDDEN_CONTENT_TABLE_OF[type])
    .select(HIDDEN_CONTENT_COLUMNS_OF[type])
    .eq('id', contentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const raw = data as RawHiddenContentRow;
  return {
    id: raw.id,
    user_id: raw.user_id ?? null,
    hidden_at: raw.hidden_at ?? null,
    hidden_by: raw.hidden_by ?? null,
    hidden_reason: raw.hidden_reason ?? null,
    paste_group_id: raw.paste_group_id ?? null,
  };
}

/**
 * 同じ操作で隠した行 (戻す対象) の ID。食事は、通報された行と同じ paste_group_id で hidden_at が同じ行
 * (= hideModeratedContent の 1 回の UPDATE で隠した行。写真とメモが同じだった複製) をまとめて戻す。
 * 隠したあとで持ち主が中身を書き換えた複製も、同じ操作で隠した行なので戻す。別の操作 (別の時刻) で隠した行は戻さない。
 * レシピには複製の仕組みが無いので、通報された行だけ。通報された行は必ず含める
 */
export async function listRowsHiddenTogether(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  row: HiddenContentRowHidden,
): Promise<string[]> {
  if (type !== 'food' || row.paste_group_id === null) return [row.id];
  const { data, error } = await admin
    .from(HIDDEN_CONTENT_TABLE_OF.food)
    .select('id')
    .eq('paste_group_id', row.paste_group_id)
    .eq('hidden_at', row.hidden_at);
  if (error) throw error;
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  return ids.includes(row.id) ? ids : [row.id, ...ids];
}

export interface ApproveRejectedFlagsParams {
  /** 戻した運営 (resolved_by / reviewed_by) */
  resolvedBy: string;
  /** 戻す理由。moderation_flags.resolution_note に書く (recipe_flags には列が無い) */
  resolutionNote: string;
  now: Date;
}

/**
 * 戻す行を指す通報のうち rejected のものを approved にする (D-6)。pending / escalated / approved は触らない。
 * 戻り値は状態を変えた通報の ID (0 件も正常: やり直し・別の運営が先に戻した)。DB エラーは例外
 */
export async function approveRejectedFlagsOfContent(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  contentIds: readonly string[],
  params: ApproveRejectedFlagsParams,
): Promise<string[]> {
  const nowIso = params.now.toISOString();
  const patch =
    type === 'food'
      ? {
          status: FLAG_STATUS_APPROVED,
          resolved_by: params.resolvedBy,
          resolved_at: nowIso,
          resolution_note: params.resolutionNote,
        }
      : { status: FLAG_STATUS_APPROVED, reviewed_by: params.resolvedBy, reviewed_at: nowIso };
  const { data, error } = await admin
    .from(MODERATION_FLAG_TABLE_OF[type])
    .update(patch)
    .in(MODERATION_FLAG_CONTENT_COLUMN_OF[type], [...contentIds])
    .eq('status', FLAG_STATUS_REJECTED)
    .select('id');
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * 行の hidden_at / hidden_by / hidden_reason を NULL に戻す (D-3)。
 * - eq('hidden_at', hiddenAt): 判定したのと同じ隠し操作の行だけ (読んでから書くまでに戻されて隠し直された行は 0 行になる)
 * - gte('hidden_at', 期限): 戻せる期間 (89 日) を書く瞬間にもう一度確かめる (完全削除のジョブと同じ行を扱わない: D-13)
 * 戻り値は戻した行の ID。0 件は「読んでから書くまでに状態が変わった」の合図 (restoreModeratedContent が読み直す)。DB エラーは例外
 */
export async function restoreHiddenContentRows(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  contentIds: readonly string[],
  hiddenAt: string,
  now: Date,
): Promise<string[]> {
  const cutoffIso = hiddenContentRestoreCutoff(now).toISOString();
  const { data, error } = await admin
    .from(HIDDEN_CONTENT_TABLE_OF[type])
    .update({ hidden_at: null, hidden_by: null, hidden_reason: null })
    .in('id', [...contentIds])
    .eq('hidden_at', hiddenAt)
    .gte('hidden_at', cutoffIso)
    .select('id');
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/** restoreModeratedContent の段 (失敗したときに、どこまで進んだかを route が監査ログに残す) */
export type HiddenContentRestoreStep = 'read' | 'flags' | 'rows' | 'reread';

/** 段の DB の失敗。route は step で応答のコードを決め、approvedFlagIds / before を監査ログに残す */
export class HiddenContentRestoreStepError extends Error {
  readonly step: HiddenContentRestoreStep;
  /** 元のエラー (supabase-js のエラーは Error とは限らない)。応答の本文には出さない */
  readonly reason: unknown;
  /** 判定の時点で読んだ行 (読めなかったときは null) */
  readonly before: HiddenContentRowHidden | null;
  /** 失敗の前に approved にできた通報 (flags の段より前の失敗なら空) */
  readonly approvedFlagIds: readonly string[];

  constructor(
    step: HiddenContentRestoreStep,
    reason: unknown,
    before: HiddenContentRowHidden | null,
    approvedFlagIds: readonly string[],
  ) {
    super(`restoreModeratedContent: ${step} failed`);
    this.name = 'HiddenContentRestoreStepError';
    this.step = step;
    this.reason = reason;
    this.before = before;
    this.approvedFlagIds = approvedFlagIds;
  }
}

export interface RestoreModeratedContentParams {
  /** 戻した運営 */
  restoredBy: string;
  /** 戻す理由 (検証済み。1〜5000 字) */
  restoreNote: string;
  now: Date;
}

/** restoreModeratedContent の結果 (§10.1 の判定表の正本) */
export type HiddenContentRestoreOutcome =
  | Exclude<HiddenContentRestorability, { kind: 'restorable' }>
  | {
      kind: 'restored';
      /** 判定の時点の行 (隠していたときの 3 列の値。監査ログに残す) */
      before: HiddenContentRowHidden;
      /** 同じ操作で隠した行 (戻す対象) */
      targetIds: string[];
      /** 実際に戻した行 */
      restoredIds: string[];
      /** approved にした通報 */
      approvedFlagIds: string[];
    }
  | {
      /** 行の UPDATE が 0 行で、読み直すと別の時刻で隠し直されていた (別の運営の操作と交差した) */
      kind: 'stale';
      before: HiddenContentRowHidden;
      approvedFlagIds: string[];
    };

/**
 * 通報が指すコンテンツを戻す。順は「行を読む → 判定 → 同じ操作で隠した行 → 通報を approved に → 行を NULL に」。
 * 判定で戻せないときは何も書かずにその理由を返す。DB の失敗は HiddenContentRestoreStepError (どの段かと、済んだことを持つ)
 */
export async function restoreModeratedContent(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  contentId: string,
  params: RestoreModeratedContentParams,
): Promise<HiddenContentRestoreOutcome> {
  let row: HiddenContentRow | null;
  try {
    row = await readHiddenContentRow(admin, type, contentId);
  } catch (reason) {
    throw new HiddenContentRestoreStepError('read', reason, null, []);
  }
  const judged = judgeHiddenContentRestorability(row, params.now);
  if (judged.kind !== 'restorable') return judged;
  const before = judged.row;

  let targetIds: string[];
  try {
    targetIds = await listRowsHiddenTogether(admin, type, before);
  } catch (reason) {
    throw new HiddenContentRestoreStepError('read', reason, before, []);
  }

  let approvedFlagIds: string[];
  try {
    approvedFlagIds = await approveRejectedFlagsOfContent(admin, type, targetIds, {
      resolvedBy: params.restoredBy,
      resolutionNote: params.restoreNote,
      now: params.now,
    });
  } catch (reason) {
    throw new HiddenContentRestoreStepError('flags', reason, before, []);
  }

  let restoredIds: string[];
  try {
    restoredIds = await restoreHiddenContentRows(admin, type, targetIds, before.hidden_at, params.now);
  } catch (reason) {
    throw new HiddenContentRestoreStepError('rows', reason, before, approvedFlagIds);
  }
  if (restoredIds.length > 0) return { kind: 'restored', before, targetIds, restoredIds, approvedFlagIds };

  // 0 行: 読んでから書くまでに、別の操作が戻した・消した・隠し直した。読み直して理由を返す
  let again: HiddenContentRow | null;
  try {
    again = await readHiddenContentRow(admin, type, contentId);
  } catch (reason) {
    throw new HiddenContentRestoreStepError('reread', reason, before, approvedFlagIds);
  }
  const judgedAgain = judgeHiddenContentRestorability(again, params.now);
  if (judgedAgain.kind === 'restorable') return { kind: 'stale', before, approvedFlagIds };
  return judgedAgain;
}
```

### 6.1 戻せる期間の根拠 (D-2・D-13)

- 完全削除のジョブは 03:25 JST に始まり、`cutoff_p = T_p − 90 日` より前の行を、画像を消してから `DELETE … AND hidden_at < cutoff_p` で消す (1 回 300 秒まで)。
- 戻す操作は `cutoff_r = T_r − 89 日` 以後の行だけを戻す。`T_r` と `T_p` の差がどうであれ、`cutoff_r − cutoff_p = (T_r − T_p) + 1 日` で、`T_r` が `T_p` の 300 秒以上前でない限り正。したがって「ジョブが読んだ行 (`hidden_at < cutoff_p`)」と「戻す操作が書く行 (`hidden_at >= cutoff_r`)」は交わらない。
- 代償: 隠してから 89 日〜90 日 (+ 次の 03:25 まで) のあいだは、行がまだあるのに戻せない (S-08)。最長で 2 日弱。保管期間 90 日の運用の中では許容し、§19 に書く。

### 6.2 戻し方 (D-3)

3 列を NULL にする 1 回の UPDATE。`hidden_by` を残して「誰が隠したか」を行に持たせる案は、ガードの INSERT の条件 (3 列のどれかが非 NULL なら拒否) と「隠れていない = 3 列とも NULL」の正規形を崩すので採らない。隠していたときの値は監査ログの `details` (`hidden_at_before` / `hidden_by_before` / `hidden_reason_before`) に残す。

### 6.3 同じ操作で隠した行 (D-5)

`hideModeratedContent` は `new Date().toISOString()` (ミリ秒) を 1 回作って 1 回の UPDATE に使うので、同じ操作で隠した行の `hidden_at` は DB でも同じ値 (timestamptz はマイクロ秒まで持つが、書いた値はミリ秒で切れている)。PostgREST が返す文字列 (`2026-10-18T01:02:03.456+00:00`) を `eq('hidden_at', …)` に戻すと、同じ値に解決される (結合テスト I-2 で確かめる)。別の操作が同じミリ秒に同じまとまりを隠すことは実際には起きない (起きても、どちらも運営の隠す操作なので、まとめて戻って困らない)。

### 6.4 書く順 (D-7)

| 順 | 失敗したとき | 画面から直せるか |
|---|---|---|
| **通報 → 行 (採用)** | 通報だけ approved で行は隠れたまま (S-15) | 直せる: 行が隠れているので「非表示の解除」の欄が出続け、やり直すと通報は 0 行で素通りし行が戻る |
| 行 → 通報 | 行は見えるのに通報は rejected のまま | 直せない: 行が見えているので欄が出ず、通報の状態を変える入口が無い (審査の欄は pending にしか出ない) |

### 6.5 通報の扱い (D-6)

戻す行 (`targetIds`) を指す通報のうち `status = 'rejected'` のものを `approved` にする。`pending` (まだ判定していない) と `escalated` (上位の判断待ち) は、その判定がまだ生きているので触らない。すでに `approved` のものはそのまま。`approved` にする通報の `resolved_by` / `resolved_at` (レシピは `reviewed_by` / `reviewed_at`) は戻した運営と時刻で上書きする (通報の行は「最後の判定」を表し、前の判定は監査ログに残る)。

---

## 7. 既存ファイルへの追記

### 7.1 `src/lib/admin/moderation-schemas.ts` (型検査の対象。既存の定義の末尾に足す)

```ts
import { z } from 'zod';

// ─── 隠したコンテンツを戻す (#1538 の項目 4) ─────────────────────────────────

/** 解決メモ (resolution_note) と戻す理由 (restore_note) の長さ。既存の ModerationResolveBodySchema の resolution_note と同じ上限 */
export const MODERATION_NOTE_MIN_LENGTH = 1;
export const MODERATION_NOTE_MAX_LENGTH = 5000;

/**
 * POST /api/admin/moderation/{type}/{id}/restore の本文。戻す理由は必須 (モデレーションの判定を覆す操作に、理由の無い実行を許さない)。
 * 前後の空白を除いてから長さを見る (空白だけは 400)
 */
export const ModerationRestoreBodySchema = z.object({
  restore_note: z.string().trim().min(MODERATION_NOTE_MIN_LENGTH).max(MODERATION_NOTE_MAX_LENGTH),
});

export type ModerationRestoreBody = z.infer<typeof ModerationRestoreBodySchema>;

/** 戻す操作の監査ログの action_type (docs/design/operator/07-audit-monitoring.md §4.1) */
export const MODERATION_RESTORE_AUDIT_ACTION = 'admin.moderation.restore';
```

`ModerationItemSchema` (応答の形) には `hidden_at: z.string().nullable()` を 1 行足す (`resolved_at` の次)。

### 7.2 `src/lib/admin/moderation-backend.ts` (隠れているかを返す)

```ts
// tsc:skip — 既存ファイルの差分の断片 (NormalizedModerationItem・normalizeFoodRow・normalizeRecipeRow・fetchModerationList・fetchModerationSingle は同じファイルの既存の名前)

// NormalizedModerationItem に 1 項目足す (resolved_at の次)
  /**
   * 通報されたコンテンツ本体が運営に隠されている (#1101) なら、その日時 (ISO)。隠れていない・コンテンツが無いときは null (#1538)。
   * 画面はこれで「非表示中」のバッジと「非表示の解除」の欄を出す
   */
  hidden_at: string | null;

// normalizeFoodRow: embed の型と戻り値に足す
  const meal = (row.meals as { user_id?: string | null; photo_url?: string | null; hidden_at?: string | null } | null) ?? null;
  // ... 既存の項目のあとに
    hidden_at: meal?.hidden_at ?? null,

// normalizeRecipeRow: 同じく
  const recipe = (row.recipes as { user_id?: string | null; image_url?: string | null; hidden_at?: string | null } | null) ?? null;
    hidden_at: recipe?.hidden_at ?? null,

// fetchModerationList / fetchModerationSingle の select (4 か所) に hidden_at を足す
      .select('*, meals(user_id, photo_url, hidden_at)')
      .select('*, recipes(user_id, image_url, hidden_at)')
```

冒頭の説明の「隠した行を元に戻す」に関する注記は無いので足す: 「戻すのは `src/lib/admin/hidden-content-restore.ts` (`POST /api/admin/moderation/{type}/{id}/restore`。#1538)。戻した行は完全削除のジョブ `purge-hidden-content` の対象から外れる」。`hideModeratedContent` の `.select('id')` の注記「運営が戻すときの手がかりにする」はそのまま。

---

## 8. route `src/app/api/admin/moderation/[type]/[id]/restore/route.ts` (新設)

```ts
// tsc:skip — 新設のモジュール (§6・§7.1) からの import を含むため、独立の検査では解決できない。実装はこの形をそのまま使う
/**
 * POST /api/admin/moderation/{type}/{id}/restore — 運営が隠したコンテンツを戻す (#1538 の項目 4)
 * 設計: docs/design/operator/13-hidden-content-restore.md
 * 権限: admin, super_admin, content_moderator (隠す操作 POST / PUT /api/admin/moderation/{type}/{id} と同じ)
 *
 * - {id} は通報 (moderation_flags / recipe_flags) の id。通報が指すコンテンツ本体 (meals / recipes) の hidden_at / hidden_by /
 *   hidden_reason を NULL に戻し、本人以外にも再び見えるようにする。食事は、同じ操作で隠した複製 (同じ paste_group_id・同じ hidden_at)
 *   もまとめて戻す。戻した行は、完全削除のジョブ purge-hidden-content (隠してから 90 日) の対象から外れる
 * - 戻せるのは、隠されていて、隠してから 89 日 (HIDDEN_CONTENT_RESTORE_WINDOW_DAYS) 以内の行だけ。行が無い (持ち主が消した・完全削除された)
 *   → 410 OP_CONTENT_GONE、隠れていない → 409 OP_CONTENT_NOT_HIDDEN、89 日を過ぎた → 409 OP_CONTENT_RESTORE_WINDOW_EXPIRED
 * - 順は「通報 (rejected → approved) → 行 (hidden_* を NULL)」。通報の更新に失敗したら何も変えず 500 INTERNAL_ERROR。通報を approved に
 *   したあとで行の更新に失敗したら 500 OP_CONTENT_RESTORE_FAILED (行は隠れたまま。画面の「非表示の解除」の欄からやり直せる)
 * - 行の更新が 0 行 (読んでから書くまでに別の操作が戻した・消した・隠し直した) なら、読み直して 409 / 410 を返す
 * - 戻す理由 (restore_note) は必須。監査ログ admin.moderation.restore (本人の権限の client・fail-open) に、通報・コンテンツ・持ち主・理由・
 *   隠していたときの 3 列の値・対象と戻した行・approved にした通報・各段の成否を残す (成功 info・失敗 warn)
 * - BAN (user_profiles.frozen_at) には触らない (解除は DELETE /api/admin/users/{id}/freeze)
 * - 本文の NULL 文字は、認証・DB に触れる前に 400 INVALID_CHARACTER (#1657。src/__tests__/api/null-character-routes.test.ts)
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import {
  MODERATION_RESTORE_AUDIT_ACTION,
  MODERATION_TYPES,
  ModerationRestoreBodySchema,
  type ModerationType,
} from '@/lib/admin/moderation-schemas';
import {
  AI_CONTENT_NOT_SUPPORTED_MESSAGE,
  fetchModerationSingle,
  isModerationBacked,
} from '@/lib/admin/moderation-backend';
import {
  HIDDEN_CONTENT_RESTORE_WINDOW_DAYS,
  HIDDEN_CONTENT_RETENTION_DAYS,
  HiddenContentRestoreStepError,
  restoreModeratedContent,
  type HiddenContentRowHidden,
} from '@/lib/admin/hidden-content-restore';
import { notSupportedResponse } from '@/lib/admin/not-supported';
import { recordAdminAudit, type AdminAuditSeverity } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ type: string; id: string }> };

const ROUTE_NAME = 'api/admin/moderation/[type]/[id]/restore POST';

/** 監査ログ用にエラーを文字列にする (supabase-js のエラーは Error とは限らない) */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message ? message : String(err);
}

function errorResponse(status: number, code: string, message: string, data?: Record<string, unknown>) {
  return NextResponse.json(data === undefined ? { error: { code, message } } : { error: { code, message }, data }, { status });
}

export async function POST(request: Request, props: Params) {
  // 本文の NULL 文字は、認証・DB に触れる前に 400 で断る (#1657)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;

  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError) {
      return errorResponse(401, 'AUTH_UNAUTHENTICATED', '認証が必要です');
    }
    if (err instanceof ForbiddenError) {
      return errorResponse(403, 'OP_PERMISSION_DENIED', '権限がありません');
    }
    throw err;
  }

  const { type, id } = params;
  if (!MODERATION_TYPES.includes(type as ModerationType)) {
    return errorResponse(400, 'VALIDATION_ERROR', `type は ${MODERATION_TYPES.join(', ')} のいずれかである必要があります`);
  }
  const moderationType = type as ModerationType;
  // ai_content は準備中 (未対応)。本文の検証より前に 501 (#1128)
  if (!isModerationBacked(moderationType)) {
    return notSupportedResponse(AI_CONTENT_NOT_SUPPORTED_MESSAGE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'リクエストボディが不正です');
  }
  const parseResult = ModerationRestoreBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }
  const { restore_note } = parseResult.data;

  // 通報の読み取り・通報と行の更新は service_role (hidden_* を書けるのは service_role だけ: guard_hidden_content_columns)。
  // 監査ログだけ本人の権限の client (RLS audit_logs_insert_admins)
  const supabaseAdmin = getSupabaseAdmin();
  const supabase = await createClient();

  let item;
  try {
    item = await fetchModerationSingle(supabaseAdmin, moderationType, id);
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]/restore] fetch error:', describeError(err));
    return errorResponse(500, 'INTERNAL_ERROR', '内部エラーが発生しました');
  }
  if (!item) {
    return errorResponse(404, 'NOT_FOUND', 'モデレーションアイテムが見つかりません');
  }
  const contentId = item.content_id;
  if (contentId === null) {
    // 通報にコンテンツが紐づいていない (持ち主が先に消した等)。戻す対象が無い
    return errorResponse(410, 'OP_CONTENT_GONE', 'コンテンツはすでに削除されています');
  }

  /** 監査ログ (admin_audit_logs) に 1 行入れる。失敗で返すときも、成功で返すときも、同じ形で残す */
  const insertAuditLog = async (outcome: {
    before: HiddenContentRowHidden | null;
    targetIds: string[];
    restoredIds: string[];
    approvedFlagIds: readonly string[];
    /** 通報の状態 (rejected → approved) を更新できたか */
    statusSaved: boolean;
    statusError: string | null;
    /** 行を戻せたか */
    restored: boolean;
    restoreError: string | null;
    severity: AdminAuditSeverity;
  }) => {
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: MODERATION_RESTORE_AUDIT_ACTION,
      targetId: id,
      targetType: `moderation_item:${type}`,
      details: {
        moderation_type: type,
        flag_id: id,
        content_id: contentId,
        content_user_id: item.user_id,
        restore_note,
        // 隠していたときの値 (3 列とも NULL に戻すので、行には残らない)
        hidden_at_before: outcome.before?.hidden_at ?? null,
        hidden_by_before: outcome.before?.hidden_by ?? null,
        hidden_reason_before: outcome.before?.hidden_reason ?? null,
        // 同じ操作で隠した行 (戻す対象) と、実際に戻した行
        target_ids: outcome.targetIds,
        restored_ids: outcome.restoredIds,
        restored: outcome.restored,
        restore_error: outcome.restoreError,
        // approved にした通報と、通報の更新の成否
        approved_flag_ids: [...outcome.approvedFlagIds],
        status_saved: outcome.statusSaved,
        status_error: outcome.statusError,
        restore_window_days: HIDDEN_CONTENT_RESTORE_WINDOW_DAYS,
      },
      severity: outcome.severity,
      request,
      routeName: ROUTE_NAME,
    });
  };

  const now = new Date();
  let outcome;
  try {
    outcome = await restoreModeratedContent(supabaseAdmin, moderationType, contentId, {
      restoredBy: actor.id,
      restoreNote: restore_note,
      now,
    });
  } catch (err) {
    if (!(err instanceof HiddenContentRestoreStepError)) {
      console.error('[api/admin/moderation/[type]/[id]/restore] unexpected error:', describeError(err));
      return errorResponse(500, 'INTERNAL_ERROR', '内部エラーが発生しました');
    }
    // 元のエラー文は構造化ログと監査ログにだけ残し、応答には固定の文を返す (#1172)
    const reasonText = describeError(err.reason);
    createLogger(ROUTE_NAME, generateRequestId())
      .withUser(actor.id)
      .error('隠したコンテンツを戻せませんでした', err.reason, {
        moderation_type: type,
        flag_id: id,
        content_id: contentId,
        step: err.step,
      });
    if (err.step === 'rows' || err.step === 'reread') {
      // 通報は approved にできた (または 0 行)。行は隠れたまま。画面の「非表示の解除」の欄からやり直せる
      await insertAuditLog({
        before: err.before,
        targetIds: [],
        restoredIds: [],
        approvedFlagIds: err.approvedFlagIds,
        statusSaved: true,
        statusError: null,
        restored: false,
        restoreError: reasonText,
        severity: 'warn',
      });
      return errorResponse(
        500,
        'OP_CONTENT_RESTORE_FAILED',
        'コンテンツを表示に戻せませんでした。通報の状態は承認済みにしました。もう一度同じ操作を実行してください。',
        { content_hidden: true, approved_flag_ids: [...err.approvedFlagIds] },
      );
    }
    // read / flags: 何も変えていない
    await insertAuditLog({
      before: err.before,
      targetIds: [],
      restoredIds: [],
      approvedFlagIds: [],
      statusSaved: false,
      statusError: err.step === 'flags' ? reasonText : null,
      restored: false,
      restoreError: err.step === 'read' ? reasonText : null,
      severity: 'warn',
    });
    // 読み取りの段 (read) の失敗では、隠れているかどうかも分からないので data を付けない
    return errorResponse(
      500,
      'INTERNAL_ERROR',
      err.step === 'flags'
        ? '通報の状態を更新できませんでした。コンテンツはまだ非表示のままです。もう一度同じ操作を実行してください。'
        : 'コンテンツの状態を読み取れませんでした。もう一度同じ操作を実行してください。',
      err.step === 'flags' ? { content_hidden: true } : undefined,
    );
  }

  // 判定で戻せない (何も書いていない。監査ログは残さない: 状態を変えていない)
  switch (outcome.kind) {
    case 'gone':
      return errorResponse(410, 'OP_CONTENT_GONE', 'コンテンツはすでに削除されています');
    case 'not_hidden':
      return errorResponse(409, 'OP_CONTENT_NOT_HIDDEN', 'このコンテンツはすでに表示されています', { content_hidden: false });
    case 'window_expired':
      return errorResponse(
        409,
        'OP_CONTENT_RESTORE_WINDOW_EXPIRED',
        `隠してから ${HIDDEN_CONTENT_RESTORE_WINDOW_DAYS} 日を過ぎたため戻せません (保管期間 ${HIDDEN_CONTENT_RETENTION_DAYS} 日で完全に削除されます)`,
        { content_hidden: true, hidden_at: outcome.row.hidden_at },
      );
    case 'stale':
      // 読んでから書くまでに、別の運営の操作で戻され、別の時刻で隠し直された。通報は approved にしてあるが行は隠れている。
      // 画面を開き直せば「非表示の解除」の欄が出て、やり直せる
      await insertAuditLog({
        before: outcome.before,
        targetIds: [],
        restoredIds: [],
        approvedFlagIds: outcome.approvedFlagIds,
        statusSaved: true,
        statusError: null,
        restored: false,
        restoreError: 'stale: the content was hidden again by another operation',
        severity: 'warn',
      });
      return errorResponse(409, 'CONFLICT_STALE_DATA', 'コンテンツの状態が変わりました。画面を開き直して、もう一度確認してください', {
        content_hidden: true,
      });
    case 'restored':
      break;
  }

  await insertAuditLog({
    before: outcome.before,
    targetIds: outcome.targetIds,
    restoredIds: outcome.restoredIds,
    approvedFlagIds: outcome.approvedFlagIds,
    statusSaved: true,
    statusError: null,
    restored: true,
    restoreError: null,
    severity: 'info',
  });

  return NextResponse.json({
    data: {
      success: true,
      content_hidden: false,
      restored_ids: outcome.restoredIds,
      approved_flag_ids: outcome.approvedFlagIds,
    },
  });
}
```

応答の形 (成功): `{ data: { success: true, content_hidden: false, restored_ids: string[], approved_flag_ids: string[] } }`。失敗は既存の運営 API と同じ `{ error: { code, message }, data? }`。

---

## 9. 画面 (段 B)

### 9.1 詳細 `src/app/admin/moderation/[type]/[id]/page.tsx` の変更

- `ModerationItem` に `hidden_at: string | null` を足す。
- 「コンテンツ情報」の `dl` に 1 項目足す (「投稿日時」の次): `dt` = 「表示」、`dd` = 隠れていれば `非表示中 (隠した日時: <JST>)`、隠れていなければ `表示中`。JST は `new Date(hidden_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })`。
- 右の列 (「審査アクション」のカード) の下に、`resolvedItem.hidden_at` が非 null のときだけ「非表示の解除」のカードを足し、`ModerationRestoreForm` を描く。`restorable` はサーバー側で `isWithinHiddenContentRestoreWindow(resolvedItem.hidden_at, new Date())` (§6) で決めて渡す。審査の欄 (pending のときだけ入力欄が出る) とは独立に出す (S-18)。

```tsx
// tsc:skip — page.tsx への追記の断片 (resolvedItem・type・id は同じファイルの既存の名前)
import ModerationRestoreForm from '@/components/operator/moderation/ModerationRestoreForm';
import { HIDDEN_CONTENT_RESTORE_WINDOW_DAYS, HIDDEN_CONTENT_RETENTION_DAYS, isWithinHiddenContentRestoreWindow } from '@/lib/admin/hidden-content-restore';

// 「投稿日時」の次の項目
            <div>
              <dt className="text-gray-500">表示</dt>
              <dd className="text-gray-700">
                {resolvedItem.hidden_at
                  ? `非表示中 (隠した日時: ${new Date(resolvedItem.hidden_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`
                  : '表示中'}
              </dd>
            </div>

// 「審査アクション」のカードの次 (同じ右の列の中)
          {resolvedItem.hidden_at && (
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-800 mb-4">非表示の解除</h2>
              <ModerationRestoreForm
                key={`restore:${type}:${id}`}
                type={type}
                id={id}
                hiddenAt={resolvedItem.hidden_at}
                restorable={isWithinHiddenContentRestoreWindow(resolvedItem.hidden_at, new Date())}
                restoreWindowDays={HIDDEN_CONTENT_RESTORE_WINDOW_DAYS}
                retentionDays={HIDDEN_CONTENT_RETENTION_DAYS}
              />
            </div>
          )}
```

右の列は `grid-cols-1 lg:grid-cols-2` の 2 列目なので、2 つのカードを縦に並べるために 2 列目を `<div className="space-y-6">` で包む (既存の「審査アクション」のカードはその中へ移す。見た目はそのまま)。

### 9.2 `src/components/operator/moderation/ModerationRestoreForm.tsx` (新設・client)

```tsx
'use client';

/**
 * 個別審査画面 (/admin/moderation/{type}/{id}) の「非表示の解除」欄 (#1538 の項目 4)
 * 設計: docs/design/operator/13-hidden-content-restore.md §9.2
 *
 * - 隠れている (hidden_at がある) ときだけ親が描く。戻せる期間 (89 日) を過ぎていたら (restorable = false)、理由の欄とボタンを出さず案内だけ
 * - 送る本文は { restore_note } (前後の空白を除く。空・5000 字超は送らずに画面で知らせる)
 * - 成功 (200) したら結果を表示して router.refresh() (左側の「表示」とステータスを更新する)
 * - 409 / 410 (すでに表示されている・削除された・期限切れ・状態が変わった) は API の文面を出し、router.refresh() で状態を読み直す
 * - 500 は API の文面を出し、欄を閉じない (もう一度押せる)。401 はログインし直す案内
 * - 送信中は二重に送れない
 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export type ModerationRestoreFormProps = {
  /** モデレーション対象のタイプ (food / recipe) */
  type: string;
  /** 通報 (moderation_flags / recipe_flags) の ID */
  id: string;
  /** 隠した日時 (ISO)。表示にだけ使う */
  hiddenAt: string;
  /** 戻せる期間の中か (サーバーが isWithinHiddenContentRestoreWindow で決める) */
  restorable: boolean;
  /** 戻せる期間 (日)。案内の文に使う */
  restoreWindowDays: number;
  /** 保管期間 (日)。案内の文に使う */
  retentionDays: number;
};

/** 戻す理由の長さ (src/lib/admin/moderation-schemas.ts の MODERATION_NOTE_MIN_LENGTH / MODERATION_NOTE_MAX_LENGTH と同じ値。client には schemas を読み込まない) */
const NOTE_MIN_LENGTH = 1;
const NOTE_MAX_LENGTH = 5000;

/** API が「状態が変わった」と答えるコード (画面を読み直す) */
const REFRESH_STATUSES: ReadonlySet<number> = new Set([409, 410]);

type ApiErrorBody = { error?: { code?: unknown; message?: unknown } };
type ApiSuccessBody = { data?: { restored_ids?: unknown; approved_flag_ids?: unknown } };

const SUBMIT_LABEL = '表示に戻す';

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

export default function ModerationRestoreForm({
  type,
  id,
  hiddenAt,
  restorable,
  restoreWindowDays,
  retentionDays,
}: ModerationRestoreFormProps) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 戻せたときの結果。入っている間は「戻した」の表示にする */
  const [done, setDone] = useState<{ restoredCount: number } | null>(null);

  if (done) {
    return (
      <div className="space-y-2">
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          表示に戻しました ({done.restoredCount} 行)。投稿者本人以外にも再び見えます。
        </p>
        <p className="text-xs text-gray-500">投稿者を BAN している場合、BAN はこの操作では解除されません (利用者の画面から解除します)。</p>
      </div>
    );
  }

  if (!restorable) {
    return (
      <div className="space-y-2 text-sm text-gray-700">
        <p>隠した日時: {formatJst(hiddenAt)}</p>
        <p role="status" className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          隠してから {restoreWindowDays} 日を過ぎたため戻せません。保管期間 ({retentionDays} 日) を過ぎると、定期のジョブが完全に削除します。
        </p>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = note.trim();
    if (trimmed.length < NOTE_MIN_LENGTH) {
      setError('戻す理由を入力してください');
      return;
    }
    if (trimmed.length > NOTE_MAX_LENGTH) {
      setError(`戻す理由は ${NOTE_MAX_LENGTH} 文字以内で入力してください`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/moderation/${encodeURIComponent(type)}/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restore_note: trimmed }),
      });
      const json = (await res.json().catch(() => null)) as (ApiErrorBody & ApiSuccessBody) | null;

      if (res.ok) {
        const restoredIds = json?.data?.restored_ids;
        setDone({ restoredCount: Array.isArray(restoredIds) ? restoredIds.length : 1 });
        router.refresh();
        return;
      }
      if (res.status === 401) {
        setError('ログインの有効期限が切れました。ログインし直してください');
        return;
      }
      const message = json?.error?.message;
      setError(
        typeof message === 'string' && message
          ? message
          : `表示に戻せませんでした (HTTP ${res.status})。もう一度お試しください`,
      );
      if (REFRESH_STATUSES.has(res.status)) {
        // すでに表示されている・削除された・期限切れ・状態が変わった: 左側の表示を読み直す
        router.refresh();
      }
    } catch {
      setError('通信に失敗しました。もう一度お試しください (戻せたか分からないときは、ページを開き直して状態を確認してください)');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <p className="text-sm text-gray-700">隠した日時: {formatJst(hiddenAt)}</p>
      <p className="text-xs text-gray-500">
        戻すと、このコンテンツは投稿者本人以外 (家族を含む) にも再び見えます。
        {type === 'food' && '同じ操作で見えなくなった、家族への貼り付けの複製も一緒に戻ります。'}
        却下 (削除) にした通報は「承認」に変わります。
      </p>
      <div>
        <label htmlFor="restore_note" className="block text-sm font-medium text-gray-700 mb-1">
          戻す理由 <span className="text-red-500">*</span>
        </label>
        <textarea
          id="restore_note"
          name="restore_note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={submitting}
          placeholder="戻す理由を入力してください (監査ログに残ります)"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
      </div>
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
        <p className="text-xs text-yellow-700">この操作は admin_audit_logs に記録されます。</p>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2 rounded-lg border border-orange-500 text-orange-600 text-sm font-medium hover:bg-orange-50 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? '戻しています…' : SUBMIT_LABEL}
      </button>
    </form>
  );
}
```

### 9.3 一覧 `src/app/admin/moderation/page.tsx` の変更

- `ModerationItem` に `hidden_at: string | null` を足す。
- ステータスの `td` で、既存のバッジの次に `{item.hidden_at && (<span className="ml-1 inline-block bg-gray-100 text-gray-700 text-xs px-2 py-0.5 rounded font-medium">非表示中</span>)}` を足す。絞り込み (status の `select`) は変えない。

### 9.4 `operator/03-ui-spec.md` との関係

03 には `/admin/moderation` の節が無い (一覧の page.tsx の「§5 モデレーション画面準拠」の §5 は `/admin/users` の節)。本書 §9 を運営のモデレーション画面の「非表示の解除」と「非表示中」のバッジの正本とし、03 には §17 の行で参照を足す。

---

## 10. 表 3 点

### 10.1 ①全パターン表

#### 10.1.1 判定表 (通報 × コンテンツの行 × 期限 × 書き込みの結果 → 応答)。`restoreModeratedContent` と route の正本

| # | 入力 | 書くもの | 応答 | 監査ログ |
|---|---|---|---|---|
| P-1 | 本文に NULL 文字 | — | 400 `INVALID_CHARACTER` | なし |
| P-2 | 未認証 / 3 ロールのどれも無い・凍結中・AAL 不足 | — | 401 `AUTH_UNAUTHENTICATED` / 403 `OP_PERMISSION_DENIED` (`AUTH_ACCOUNT_FROZEN` / `AUTH_2FA_*` は `requireRole` の既存の形) | なし |
| P-3 | `type` が `food` / `recipe` / `ai_content` 以外 | — | 400 `VALIDATION_ERROR` | なし |
| P-4 | `type = ai_content` | — | 501 `OP_NOT_SUPPORTED` (本文を読まない) | なし |
| P-5 | 本文が JSON でない / `restore_note` が無い・空白だけ・5000 字超 | — | 400 `INVALID_JSON` / 400 `VALIDATION_ERROR` (`details` に Zod の flatten) | なし |
| P-6 | 通報が無い / 通報の読み取りが DB エラー | — | 404 `NOT_FOUND` / 500 `INTERNAL_ERROR` | なし |
| P-7 | 通報の `content_id` が null | — | 410 `OP_CONTENT_GONE` | なし |
| P-8 | 行の読み取りが DB エラー | — | 500 `INTERNAL_ERROR` (「読み取れませんでした」) | warn (`status_saved: false`・`restore_error`) |
| P-9 | 行が無い (`gone`) | — | 410 `OP_CONTENT_GONE` | なし |
| P-10 | `hidden_at` が NULL (`not_hidden`) | — | 409 `OP_CONTENT_NOT_HIDDEN` | なし |
| P-11 | `hidden_at < now − 89 日` (`window_expired`) | — | 409 `OP_CONTENT_RESTORE_WINDOW_EXPIRED` (`data.hidden_at`) | なし |
| P-12 | 戻せる・食事・`paste_group_id` NULL | 対象 = [行] | (P-15 以降へ) | — |
| P-13 | 戻せる・食事・`paste_group_id` あり | 対象 = 同じまとまりで `hidden_at` が同じ行 (通報された行を含む) | (P-15 以降へ) | — |
| P-14 | 戻せる・レシピ (持ち主 `user_id` が null の公開レシピも同じ: S-23) | 対象 = [行] | (P-15 以降へ) | — |
| P-15 | 同じまとまりの読み取りが DB エラー | — | 500 `INTERNAL_ERROR` | warn (`restore_error`) |
| P-16 | 通報の UPDATE (rejected → approved) が DB エラー | — | 500 `INTERNAL_ERROR` (「通報の状態を更新できませんでした」) | warn (`status_saved: false`・`status_error`) |
| P-17 | 通報の UPDATE 成功 (0 行も可)・行の UPDATE が DB エラー | 通報 approved | 500 `OP_CONTENT_RESTORE_FAILED` (`data.approved_flag_ids`) | warn (`status_saved: true`・`restored: false`・`restore_error`) |
| P-18 | 行の UPDATE が 0 行・読み直すと行なし | 通報 approved | 410 `OP_CONTENT_GONE` | なし |
| P-19 | 行の UPDATE が 0 行・読み直すと `hidden_at` NULL (別の運営が先に戻した) | 通報 approved (0 行) | 409 `OP_CONTENT_NOT_HIDDEN` | なし |
| P-20 | 行の UPDATE が 0 行・読み直すと期限切れ (読んでから書くまでに 89 日の境を越えた) | 通報 approved | 409 `OP_CONTENT_RESTORE_WINDOW_EXPIRED` | なし |
| P-21 | 行の UPDATE が 0 行・読み直すと戻せる (別の時刻で隠し直されている: `stale`) | 通報 approved | 409 `CONFLICT_STALE_DATA` | warn (`status_saved: true`・`restored: false`) |
| P-22 | 読み直しが DB エラー | 通報 approved | 500 `OP_CONTENT_RESTORE_FAILED` | warn |
| P-23 | 行の UPDATE が 1 行以上 | 通報 approved・行の 3 列 NULL | 200 `{ success: true, content_hidden: false, restored_ids, approved_flag_ids }` | info |
| P-24 | P-23 で監査ログの INSERT に失敗 | 同上 | 200 (fail-open。失敗は `app_logs`) | なし (失敗) |

**評価の順**: P-1 → P-2 → P-3 → P-4 → P-5 → P-6 → P-7 → P-8 → (P-9 / P-10 / P-11 の判定) → (P-12 / P-13 / P-14 の対象) → P-15 → P-16 → P-17 → (0 行なら P-18〜P-22、1 行以上なら P-23) → P-24。上から見て最初に当たった行だけ。

#### 10.1.2 消費経路表 (`hidden_at` の値が効く場所 × 戻したあと)

| 経路 | 隠れている間 | 戻したあと | 本書の変更 |
|---|---|---|---|
| RLS `meals_select_owner_or_family` / `recipes."Users can view public recipes"` | 本人だけ (持ち主が退会して `user_id` が null のレシピは誰にも見えない) | 隠す前と同じ (家族・公開。`user_id` が null のレシピは全員: S-23) | なし |
| `paste_meal_to_family` | `MEAL_HIDDEN` | 通る | なし |
| `count_meals_per_user` / `calculate-segment-stats` の `hidden_at IS NULL` | 数えない | 数える | なし |
| 完全削除のジョブ `.lt('hidden_at', cutoff)` | 90 日で消す | 対象外 | なし (D-13 の 89 日で交差を消す) |
| `hidden_content_purge_referenced_needles` | `hidden_at >= cutoff` の行だけ数える | `hidden_at IS NULL` で数える (画像を消さない) | なし |
| 本人のアカウント出力 (`account-export-tables.ts`) | `hidden_at` / `hidden_reason` を出す | null で出す | なし |
| `GET /api/recipes` / `GET /api/recipes/{id}` (本人以外) | 出ない / 404 | 出る / 200 | なし |
| 運営 `GET /api/admin/moderation/queue` / `GET /{type}/{id}` | (いまは分からない) → `hidden_at` を返す | `hidden_at: null` | §7.2 |
| 運営の一覧画面のバッジ / 詳細画面の欄 | 「非表示中」/ 解除の欄 | 無し / 「表示中」 | §9 |
| 隠す操作 `hideModeratedContent` (`.is('hidden_at', null)`) | 上書きしない | 新しい `hidden_at` で隠せる (保管期間は数え直し) | なし |
| 監査ログ | `admin.moderation.<action>` の `hidden_ids` | + `admin.moderation.restore` の `restored_ids` と `*_before` | §8 |

### 10.2 ②状態比較表 (現行 vs 設計後)

| 項目 | 現行 (origin/main `9dd73f23`・2026-10-17) | 設計後 |
|---|---|---|
| 隠した行を戻す手段 | service_role で SQL を打つ (migration 20261016100000 の注記)。画面・API は無い | `POST /api/admin/moderation/{type}/{id}/restore` + 詳細画面の「非表示の解除」の欄 |
| 戻せる条件 | (SQL なら何でも) | 隠れている・89 日以内・行がある |
| 戻したときの通報 | (SQL では触らない) | `rejected` → `approved` (戻す行を指すものすべて) |
| 戻したときの記録 | 無し | `admin.moderation.restore` (理由・隠していたときの値・対象・戻した行・approved にした通報) |
| 完全削除との関係 | (SQL で戻した行は `hidden_at` NULL で対象外) | 同じ。加えて 89 日の窓で、ジョブの実行中に同じ行を扱わない |
| 運営の API の応答 (`queue` / `{type}/{id}`) | `hidden_at` 無し | `hidden_at: string / null` を追加 (既存の項目は不変) |
| 一覧画面 | status のバッジだけ | + 「非表示中」のバッジ |
| 詳細画面 | 審査の欄 (pending だけ) | + 「表示」の項目・「非表示の解除」の欄 (隠れている間) |
| `moderation-schemas.ts` | `ModerationResolveBodySchema` ほか | + `ModerationRestoreBodySchema`・`MODERATION_NOTE_*`・`MODERATION_RESTORE_AUDIT_ACTION`・`ModerationItemSchema.hidden_at` |
| `moderation-backend.ts` | `NormalizedModerationItem` に `hidden_at` 無し・embed 2 列 | `hidden_at` あり・embed 3 列 (4 か所) |
| 新設のモジュール | — | `src/lib/admin/hidden-content-restore.ts` (§6)・`ModerationRestoreForm.tsx` (§9.2)・route (§8) |
| DB (表・列・RLS・トリガー・関数・索引・migration) | — | 変えない |
| 環境変数 | — | 足さない |
| 監査の action の一覧 (07 §4.1) | `admin.moderation.<action>` の 6 つ + `admin.moderation.view` | + `admin.moderation.restore` |
| エラーコード (cross/04 OP 系) | `OP_CONTENT_HIDE_FAILED` は実コードにあるが表に無い | + `OP_CONTENT_NOT_HIDDEN` / `OP_CONTENT_GONE` / `OP_CONTENT_RESTORE_WINDOW_EXPIRED` / `OP_CONTENT_RESTORE_FAILED` (と `OP_CONTENT_HIDE_FAILED` の行を §17 で足す) |
| BAN | `delete_and_*_ban` で `frozen_at`、解除は `DELETE …/freeze` | 変えない (戻す操作は触らない) |

### 10.3 ③状態遷移表

コンテンツの行 (`meals` / `recipes`)。状態 = `hidden_at` と行の有無:

| 状態 | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| 表示中 (`hidden_at` NULL) | `delete_*` の判定 (`hideModeratedContent`) | 非表示 (`hidden_at` = t) | `.is('hidden_at', null)` | 同じまとまりの同じ中身の複製も同じ t で非表示。通報 `rejected` |
| 表示中 | 戻す | 表示中 | 判定 `not_hidden` | 409 `OP_CONTENT_NOT_HIDDEN`。何も書かない |
| 非表示 (t) | 戻す (t >= now − 89 日) | 表示中 | `eq('hidden_at', t)` + `gte('hidden_at', 期限)` | 同じまとまりで `hidden_at` = t の行も表示中に。戻す行を指す `rejected` の通報 → `approved`。監査ログ info |
| 非表示 (t) | 戻す (t < now − 89 日) | 非表示 (t) | 判定 `window_expired` | 409。何も書かない |
| 非表示 (t) | `delete_*` の判定 (2 件目の通報) | 非表示 (t。不変) | `.is('hidden_at', null)` に合わない | 通報 `rejected`。監査ログの `hidden_ids` は空 |
| 非表示 (t) | 持ち主が行を消す | 消滅 | 本人の DELETE (RLS) | 通報は CASCADE で消える |
| 非表示 (t) | 完全削除のジョブ (t < T_p − 90 日) | 消滅 | `.lt('hidden_at', cutoff_p)` (読むときと消すとき) | 画像 (持ち主のもので、ほかが使っていないもの) も消える。通報は CASCADE |
| 非表示 (t) | 戻す操作の途中で行の UPDATE が失敗 | 非表示 (t) | — | 通報は `approved` 済み。500 `OP_CONTENT_RESTORE_FAILED`。やり直せる |
| 消滅 | 戻す | 消滅 | 判定 `gone` (通報が残っていれば) | 410 / 通報も無ければ 404 |
| 表示中 (戻したあと) | `delete_*` の判定 (別の通報) | 非表示 (t'。新しい起点) | `.is('hidden_at', null)` | 保管期間は t' から数え直し |

通報の行 (`moderation_flags` / `recipe_flags`)。状態 = `status`:

| 状態 | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `pending` | `approve` / `escalate` / `delete_*` | `approved` / `escalated` / `rejected` | (既存の route) | `delete_*` はコンテンツを非表示に |
| `rejected` | 戻す (この通報が指す行が対象に入る) | `approved` | `status = 'rejected'` AND `meal_id` (`recipe_id`) IN 対象 | `resolved_by` / `resolved_at` (`reviewed_*`) = 戻した運営と時刻。食事は `resolution_note` = 理由 |
| `rejected` | 戻す (この通報が指す行が対象に入らない: 別の時刻で隠した複製) | `rejected` | 上のガードに合わない | — |
| `pending` / `escalated` / `approved` | 戻す | 同じ | `status = 'rejected'` に合わない | — (S-18) |
| 任意 | コンテンツの行の消滅 (持ち主の削除・完全削除) | 消滅 | 外部キー CASCADE | — |
| `approved` (戻したあと) | 戻す (もう一度) | `approved` | 行が表示中なので判定 `not_hidden` | 409 |

---

## 11. エラー表

| 場面 | 誰が | コード | HTTP | 本文の文 (固定) | 扱い |
|---|---|---|---|---|---|
| 本文に NULL 文字 | route (`rejectNullCharacterBody`) | `INVALID_CHARACTER` | 400 | `src/lib/api/null-character.ts` の `NULL_CHARACTER_ERROR_MESSAGE` | 認証・DB より前 |
| 未認証 | `requireRole` | `AUTH_UNAUTHENTICATED` | 401 | 認証が必要です | 既存と同じ |
| ロール不足・凍結・AAL 不足 | `requireRole` | `OP_PERMISSION_DENIED` (`ForbiddenError` 全般) | 403 | 権限がありません | 既存と同じ (`AUTH_ACCOUNT_FROZEN` / `AUTH_2FA_*` も `ForbiddenError` なので同じ文) |
| `type` が不正 | route | `VALIDATION_ERROR` | 400 | type は food, recipe, ai_content のいずれかである必要があります | 既存と同じ |
| `type = ai_content` | route (`notSupportedResponse`) | `OP_NOT_SUPPORTED` | 501 | `AI_CONTENT_NOT_SUPPORTED_MESSAGE` | 本文の検証より前 |
| 本文が JSON でない | route | `INVALID_JSON` | 400 | リクエストボディが不正です | |
| `restore_note` が無い・空白だけ・5000 字超 | route (Zod) | `VALIDATION_ERROR` | 400 | バリデーションエラー (+ `details`) | 画面は送らずに知らせる |
| 通報が無い | route | `NOT_FOUND` | 404 | モデレーションアイテムが見つかりません | 既存と同じ文 |
| 通報の読み取り・行の読み取り・同じまとまりの読み取りが DB エラー | route | `INTERNAL_ERROR` | 500 | 内部エラーが発生しました / コンテンツの状態を読み取れませんでした。もう一度同じ操作を実行してください。 | 行・通報は変えていない。読み取りの段 (`read`) は監査ログ warn |
| 通報の `content_id` が null / 行が無い (完全削除・持ち主が消した) | route | **[NEW]** `OP_CONTENT_GONE` | 410 | コンテンツはすでに削除されています | 何も書かない。cross/04 の OP 系に足す (§17) |
| 行が隠れていない | route | **[NEW]** `OP_CONTENT_NOT_HIDDEN` | 409 | このコンテンツはすでに表示されています | 何も書かない (2 人目の運営・やり直し) |
| 隠してから 89 日を過ぎた | route | **[NEW]** `OP_CONTENT_RESTORE_WINDOW_EXPIRED` | 409 | 隠してから 89 日を過ぎたため戻せません (保管期間 90 日で完全に削除されます) | 何も書かない。`data.hidden_at` |
| 通報の UPDATE が DB エラー | route | `INTERNAL_ERROR` | 500 | 通報の状態を更新できませんでした。コンテンツはまだ非表示のままです。もう一度同じ操作を実行してください。 | 監査ログ warn (`status_saved: false`) |
| 行の UPDATE が DB エラー・読み直しが DB エラー | route | **[NEW]** `OP_CONTENT_RESTORE_FAILED` | 500 | コンテンツを表示に戻せませんでした。通報の状態は承認済みにしました。もう一度同じ操作を実行してください。 | 監査ログ warn (`status_saved: true`・`restored: false`)。`data.approved_flag_ids` |
| 行の UPDATE が 0 行で、読み直すと別の時刻で隠し直されている | route | `CONFLICT_STALE_DATA` (cross/04 の既存のコード「WHERE 条件不一致 (0 行更新)」) | 409 | コンテンツの状態が変わりました。画面を開き直して、もう一度確認してください | 監査ログ warn。画面を開き直せばやり直せる |
| 監査ログの INSERT に失敗 | `recordAdminAudit` | — | (応答は変えない) | — | fail-open。`app_logs` に error |
| `hidden_at` が日時として読めない | `isWithinHiddenContentRestoreWindow` が例外 | `INTERNAL_ERROR` | 500 | 内部エラーが発生しました | 起きない (DB の timestamptz)。`restoreModeratedContent` の外で投げるので route の `instanceof` に合わず汎用の 500 |
| 本人の client で `restoreHiddenContentRows` を呼ぶ (プログラムの誤り) | DB (`guard_hidden_content_columns`) | `42501` | — | — | 例外 → `HiddenContentRestoreStepError('rows')` → 500。結合 I-4 で確かめる |

新しいエラーコード 4 つ (`OP_CONTENT_GONE`・`OP_CONTENT_NOT_HIDDEN`・`OP_CONTENT_RESTORE_WINDOW_EXPIRED`・`OP_CONTENT_RESTORE_FAILED`) は cross/04 の OP 系に足す (§17 の行 3)。`CONFLICT_STALE_DATA` は既存。

---

## 12. 定数と環境変数

### 12.1 定数

| 名前 | 値 | 根拠 | 置き場所 |
|---|---|---|---|
| `HIDDEN_CONTENT_RETENTION_DAYS` (写し) | 90 | オーナーの選択 (2026-10-15)。正本は Edge の `hidden-content-purge.ts`。一致は CT-1 | `hidden-content-restore.ts` |
| `HIDDEN_CONTENT_RESTORE_MARGIN_DAYS` | 1 | ジョブの 1 回の実行 (300 秒) より十分長く、保管期間の運用を損なわない最小の単位 (日) | 同上 |
| `HIDDEN_CONTENT_RESTORE_WINDOW_DAYS` | 89 (= 90 − 1) | D-2・D-13 | 同上 |
| `FLAG_STATUS_REJECTED` / `FLAG_STATUS_APPROVED` | `'rejected'` / `'approved'` | 既存の通報の状態 (`ModerationQueueSearchSchema`) | 同上 |
| `HIDDEN_CONTENT_TABLE_OF` / `MODERATION_FLAG_TABLE_OF` / `MODERATION_FLAG_CONTENT_COLUMN_OF` | 表 §5 | 既存の表 | 同上 |
| `MODERATION_NOTE_MIN_LENGTH` / `MODERATION_NOTE_MAX_LENGTH` | 1 / 5000 | 既存の `resolution_note` の上限と同じ | `moderation-schemas.ts` |
| `MODERATION_RESTORE_AUDIT_ACTION` | `'admin.moderation.restore'` | 07 §4.1 の規則 `admin.<対象>.<操作>` | 同上 |
| `NOTE_MIN_LENGTH` / `NOTE_MAX_LENGTH` (client) | 1 / 5000 | schemas の写し (client に schemas を読み込まない。既存の `ModerationReviewForm` の `NOTE_MAX_LENGTH` と同じ扱い)。一致は F-2 と CT-3 | `ModerationRestoreForm.tsx` |
| `REFRESH_STATUSES` (client) | {409, 410} | §9.2 | 同上 |

### 12.2 環境変数

**足さない。** 戻せる期間は保管期間 (オーナーの選択で決まる値で、コードの定数) から導くので、運用で独立に変える値ではない。保管期間を変えるときは Edge の正本と写しを同時に直す (CT-1 が食い違いを止める)。

---

## 13. テスト一覧

### 13.1 契約 (DB を使わない)

`tests/hidden-content-restore-contract.test.ts` (新設・段 A):
- `it('CT-1: src の写し HIDDEN_CONTENT_RETENTION_DAYS は、Edge の正本 (supabase/functions/_shared/hidden-content-purge.ts) と同じ 90')`
- `it('CT-2: 戻せる期間 = 保管期間 − 1 日 (89) で、1 日 (ms) は完全削除の 1 回の実行の上限 HIDDEN_CONTENT_PURGE_MAX_DURATION_MS より長い')`
- `it('CT-3: 画面の NOTE_MIN_LENGTH / NOTE_MAX_LENGTH (ModerationRestoreForm.tsx のソース) は schemas の MODERATION_NOTE_MIN_LENGTH / MODERATION_NOTE_MAX_LENGTH と同じ')` (段 B で足す)
- `it('CT-4: restore の route の requireRole のロールは、隠す route (POST / PUT /api/admin/moderation/[type]/[id]) と同じ 3 つ (ソースの文字列で突き合わせ)')`
- `it('CT-5: restore の route は recordAdminAudit に request を渡し、admin_audit_logs へ直接 INSERT しない (actionType は MODERATION_RESTORE_AUDIT_ACTION)')`
- `it('CT-6: hidden-content-restore.ts は hidden_at を書く UPDATE を 1 つだけ持ち、hidden_at / hidden_by / hidden_reason を null にする (別の値を書かない)')`
- `it('CT-7: hidden-content-restore.ts・route・ModerationRestoreForm.tsx に、ジョブが無かったころの言い回し (tests/purge-hidden-content-migration-contract.test.ts の STALE_PHRASES) が無く、ジョブの名前 purge-hidden-content を挙げる')`
- `it('CT-8: hidden-content-restore.ts と restore の route は process.env を読まない (環境変数を足さない: R-17)')` (段 B で、同じ it の対象に `ModerationRestoreForm.tsx` を足す)

### 13.2 単体 (`tests`)

`tests/hidden-content-restore.test.ts` (新設・段 A。`tests/helpers/fake-supabase.ts` を使う。§16 の `gte` の追加が前提):
- `it('U-1: hiddenContentRestoreCutoff は now のちょうど 89 日前')`
- `it('U-2: isWithinHiddenContentRestoreWindow: 89 日ちょうどは true、89 日 + 1 ms は false、1 分前は true')`
- `it('U-3: isWithinHiddenContentRestoreWindow: 日時として読めない hidden_at は例外')`
- `it('U-4: judgeHiddenContentRestorability: null → gone / hidden_at null → not_hidden (row を返す) / 89 日以内 → restorable (row.hidden_at が string) / 89 日超 → window_expired')`
- `it('U-5: readHiddenContentRow: food は paste_group_id を含む列で、recipe は含まない列で読む。無ければ null。足りない列は null に。user_id が null の行 (退会で外れた公開レシピ: S-23) は user_id を null のまま返す。DB エラーは例外')`
- `it('U-6: listRowsHiddenTogether: recipe は [id] だけ (読まない)。food で paste_group_id が null も [id] だけ。food で paste_group_id があれば meals を eq(paste_group_id)・eq(hidden_at) で読み、通報された行を必ず含める。DB エラーは例外')`
- `it('U-7: approveRejectedFlagsOfContent: food は moderation_flags を status approved / resolved_by / resolved_at / resolution_note で、in(meal_id, 対象)・eq(status, rejected) で更新し、id を返す。recipe は recipe_flags を reviewed_by / reviewed_at で (resolution_note を書かない)。0 行は空配列。DB エラーは例外')`
- `it('U-8: restoreHiddenContentRows: update は { hidden_at: null, hidden_by: null, hidden_reason: null } で、in(id, 対象)・eq(hidden_at, 読んだ値)・gte(hidden_at, now − 89 日)・select(id)。戻した id を返す。DB エラーは例外')`
- `it('U-9: restoreModeratedContent: 行の読み取りの失敗は HiddenContentRestoreStepError(read, before null)。通報の更新の失敗は (flags, approvedFlagIds 空)。行の更新の失敗は (rows, approvedFlagIds あり)。読み直しの失敗は (reread)')`
- `it('U-10: restoreModeratedContent: 判定で戻せない (gone / not_hidden / window_expired) ときは通報も行も触らずにその結果を返す')`
- `it('U-11: restoreModeratedContent: 戻せたら { restored, before, targetIds, restoredIds, approvedFlagIds }。呼ぶ順は 行を読む → まとまりを読む → 通報を更新 → 行を更新 (fake の from の呼び出し順で)')`
- `it('U-12: restoreModeratedContent: 行の更新が 0 行なら読み直し、gone / not_hidden / window_expired はその結果、戻せる (別の時刻で隠し直されている) なら stale (approvedFlagIds つき)')`

`tests/moderation-backend.test.ts` (既存に足す・段 A):
- `it('#1538 food: meals.hidden_at を hidden_at として返す (無ければ null)。select は meals(user_id, photo_url, hidden_at)')`
- `it('#1538 recipe: recipes.hidden_at を hidden_at として返す。select は recipes(user_id, image_url, hidden_at)')`

`tests/moderation-restore-route-contracts.test.ts` (新設・段 A。`tests/moderation-route-contracts.test.ts` と同じ mock の形):
- `it('RT-1: 401 未認証 / 403 ロール不足 / 400 type が不正 / 501 ai_content (本文の検証より前・本文が不正でも) / 400 INVALID_JSON / 400 VALIDATION_ERROR (restore_note 無し・空白だけ・5001 字) / 400 INVALID_CHARACTER (NULL 文字。Supabase の client を作らない)')`
- `it('RT-2: 通報が無ければ 404。通報の読み取りが失敗したら 500 (404 に丸めない)。どちらも何も更新せず監査ログも残さない')`
- `it('RT-3: 通報の content_id が null なら 410 OP_CONTENT_GONE。行が無ければ 410。何も更新せず監査ログも残さない')`
- `it('RT-4: 行が隠れていなければ 409 OP_CONTENT_NOT_HIDDEN。隠してから 90 日なら 409 OP_CONTENT_RESTORE_WINDOW_EXPIRED (data.hidden_at)。何も更新せず監査ログも残さない')`
- `it('RT-5: food (複製なし): 通報 → 行の順で更新し、200 { success, content_hidden: false, restored_ids: [meal], approved_flag_ids: [flag] }。監査ログは admin.moderation.restore・info・target_type moderation_item:food・details に restore_note / hidden_*_before / target_ids / restored_ids / approved_flag_ids / status_saved true / restored true。本人の client (createClient) で書き、request を渡す')`
- `it('RT-6: food (複製あり): 同じ paste_group_id・同じ hidden_at の行を eq で読み、まとめて更新する。approved_flag_ids に複製の通報も入る')`
- `it('RT-7: recipe: recipe_flags は reviewed_by / reviewed_at で approved (resolution_note を書かない)。meals には触らない')`
- `it('RT-8: 通報の更新が失敗したら 500 INTERNAL_ERROR (固定の文)。行は更新しない。監査ログは warn・status_saved false・status_error に元のエラー文。応答の本文に生のエラー文を出さない')`
- `it('RT-9: 行の更新が失敗したら 500 OP_CONTENT_RESTORE_FAILED (固定の文・data.approved_flag_ids)。監査ログは warn・status_saved true・restored false・restore_error。構造化ログに step: rows')`
- `it('RT-10: 行の更新が 0 行なら読み直し: 無ければ 410 / hidden_at null なら 409 OP_CONTENT_NOT_HIDDEN / 期限切れなら 409 WINDOW_EXPIRED / 戻せるなら 409 CONFLICT_STALE_DATA (監査ログ warn)')`
- `it('RT-11: 監査ログの INSERT に失敗しても 200 (fail-open)')`
- `it('RT-12: content_moderator でも 200 (隠す操作と同じ 3 ロール)。super_admin 限定の分岐は無い')`
- `it('RT-13: user_profiles (BAN) には触らない')`
- `it('RT-14: 行の読み取りが失敗したら (P-8) 500 INTERNAL_ERROR「コンテンツの状態を読み取れませんでした。…」(data を付けない)。通報も行も更新しない。監査ログは warn・status_saved false・status_error null・restored false・restore_error に元のエラー文・hidden_at_before null。構造化ログに step: read。応答の本文に生のエラー文を出さない')`
- `it('RT-15: food (複製あり) で同じまとまりの読み取りが失敗したら (P-15) 500 INTERNAL_ERROR (RT-14 と同じ文・data なし)。通報も行も更新しない。監査ログは warn・status_saved false・restore_error・hidden_at_before は読んだ行の値。構造化ログに step: read')`
- `it('RT-16: 行の更新が 0 行で、読み直しが失敗したら (P-22) 500 OP_CONTENT_RESTORE_FAILED (固定の文・data.approved_flag_ids)。監査ログは warn・status_saved true・restored false・restore_error。構造化ログに step: reread')`
- `it('RT-17: recipe で持ち主 (recipes.user_id) が null の行 (S-23) も 200。recipe_flags は approved。監査ログの content_user_id は null')`

`tests/moderation-route-contracts.test.ts` (既存に足す・段 A):
- `it('#1538 GET /{type}/{id}: meals.hidden_at を hidden_at として返す (隠れていなければ null)')`
- `it('#1538 GET /queue: 各項目に hidden_at がある')`

`tests/admin-moderation-restore-form.test.tsx` (新設・段 B。`tests/admin-moderation-review-form.test.tsx` と同じ描画の方法):
- `it('F-1: 理由を入れて「表示に戻す」を押すと、JSON で POST /api/admin/moderation/{type}/{id}/restore に { restore_note } (前後の空白を除く) を送る。成功したら「表示に戻しました (n 行)」と BAN の 1 文を出し、router.refresh() を呼ぶ')`
- `it('F-2: 理由が空・空白だけ・5000 字超は送らずに画面で知らせる')`
- `it('F-3: 409 / 410 は API の文面を出して router.refresh()。500 は文面を出して欄を残し refresh しない。401 はログインし直す案内。本文が JSON でない失敗は HTTP ステータスを添えた案内。通信の失敗は案内')`
- `it('F-4: 送信中は二重に送れない (ボタンが無効・fetch は 1 回)')`
- `it('F-5: restorable が false なら理由の欄とボタンを出さず、89 日と 90 日を含む案内だけ')`
- `it('F-6: 隠した日時を JST (Asia/Tokyo) で表示する。food では複製も一緒に戻る説明、recipe では出さない。type と id は URL に安全に埋め込む')`

`tests/admin-moderation-hidden-pages.test.tsx` (新設・段 B。`tests/admin-user-login-history-page.test.tsx` と同じ形: `@/lib/auth/page-guard` の `requireRoleForPage` と `@/lib/admin/fetch` の `adminFetch` を mock し、`next/navigation` の mock に `useRouter` を入れ、async の Server Component を `renderToStaticMarkup` で HTML にして確かめる。「今」は `vi.setSystemTime` で固定する):
- `it('PG-1: 一覧: hidden_at がある項目 (status rejected と pending) のステータスの欄に「非表示中」のバッジ。hidden_at が null の項目には出ない。status の絞り込みの選択肢 (pending / approved / rejected / escalated) は変わらない (S-22・R-15)')`
- `it('PG-2: 詳細: 「コンテンツ情報」の「表示」の項目は、hidden_at があれば「非表示中 (隠した日時: <JST>)」(JST は toLocaleString ja-JP・Asia/Tokyo と同じ文字列)、null なら「表示中」(§9.1)')`
- `it('PG-3: 詳細: status pending で hidden_at がある (89 日以内) と、審査の欄 (ModerationReviewForm の入力) と「非表示の解除」のカード (textarea#restore_note と「表示に戻す」) の両方が出る (S-18)。status rejected なら「このアイテムは既に審査済みです」と解除のカード。hidden_at が null なら解除のカードが無い (R-14)')`
- `it('PG-4: 詳細: hidden_at が 90 日前なら「非表示の解除」のカードはあるが、textarea#restore_note とボタンが無く、89 日を過ぎた案内だけ (S-08・R-14)')`

### 13.3 結合 (ローカル Supabase)

`tests/integration/rls/hidden-content-restore.test.ts` (新設・段 A。PostgREST を直接。`hidden-content-visibility.test.ts` と同じ seed の形。`restoreModeratedContent` ほかを service_role の client で直接呼ぶ):
- `it('I-1: 隠した食事を戻すと、3 列が NULL になり、家族のメンバーに再び見える。本人には隠れている間もあとも見える')`
- `it('I-2: 貼り付けの元と複製 (同じ中身) をまとめて隠したあと戻すと、まとめて戻る (PostgREST が返す hidden_at の文字列を eq に戻して同じ行に当たる)。別の時刻に隠した複製 (中身を書き換えてから通報したもの) は残る')`
- `it('I-3: 隠した公開レシピを戻すと、未ログイン (anon) とほかのログインユーザーに再び見える')`
- `it('I-4: 本人の client で restoreHiddenContentRows を呼ぶと 42501 で例外になり、隠れたまま (ガードのトリガー)')`
- `it('I-5: 戻した行は purgeExpiredHiddenContent (now = 隠した日時 + 91 日) の対象にならず、画像も hidden_content_purge_referenced_needles が「使っている」と答えて残る')`
- `it('I-6: 戻したあと paste_meal_to_family が通る (MEAL_HIDDEN にならない)')`
- `it('I-7: hidden_at を 90 日前にした行は restoreHiddenContentRows で 0 行 (期限の gte が効く)。89 日前の行は戻る')`
- `it('I-8: 戻すと、その行を指す rejected の通報は approved に、pending の通報はそのまま')`
- `it('I-9: user_id が NULL の公開レシピ (退会で外れたもの: S-23) を service_role で隠すと、未ログイン (anon) にもほかのログインユーザーにも見えない。restoreModeratedContent で戻すと、両方に再び見える')`

`tests/integration/operator/admin-moderation-restore.test.ts` (新設・段 A。Next の開発サーバー。`admin-moderation-detail.test.ts` と同じ `apiCall` / `dataOf` / `expectError` / `latestAuditLog`):
- `it('A-1: admin: delete_only で隠した公開レシピを restore で戻すと 200。未ログインの GET /api/recipes に再び出る。recipe_flags は approved (reviewed_by = admin)。監査ログ admin.moderation.restore (info) に restore_note と restored_ids')`
- `it('A-2: content_moderator は 200。support と一般ユーザーは 403 (何も変わらない)。未認証は 401')`
- `it('A-3: 2 回目は 409 OP_CONTENT_NOT_HIDDEN (何も変わらない・監査ログは増えない)')`
- `it('A-4: hidden_at を 90 日前に書き換えた行は 409 OP_CONTENT_RESTORE_WINDOW_EXPIRED (hidden_at はそのまま)')`
- `it('A-5: 行を消した通報 (meal_id が NULL) は 410 OP_CONTENT_GONE')`
- `it('A-6: 同じ食事に rejected の通報が 2 件あるとき、片方から戻すと両方 approved (approved_flag_ids に 2 つ)')`
- `it('A-7: GET /queue と GET /{type}/{id} が hidden_at を返す (隠す前は null・隠したあとは ISO・戻したあと null)')`
- `it('A-8: restore_note が空白だけなら 400 VALIDATION_ERROR。NULL 文字は 400 INVALID_CHARACTER')`
- `it('A-9: admin と content_moderator が同じ通報を同時に (Promise.all) restore すると、応答は 200 と 409 OP_CONTENT_NOT_HIDDEN が 1 つずつ。行の 3 列は NULL。その通報を target_id とする admin.moderation.restore の監査ログは 1 行だけ増える (S-16・R-20)')`

### 13.4 整合ゲート (実装後・本番)

- 本番の `meals` / `recipes` で `hidden_at IS NOT NULL` の行の件数を読む (読み取りだけ)。0 件なら、捨て伝票 (運営のテスト用のレシピ) を通報 → `delete_only` → restore で 1 往復し、戻ったこと・監査ログ 2 行・翌日のジョブが消していないことを確かめて、捨て伝票を消す。
- 一覧の「非表示中」のバッジと詳細の「非表示の解除」の欄が、隠れている間だけ出ることを画面で確かめる。
- 段 A・段 B の PR の差分 (`git diff --name-only origin/main...<枝>`) に、`supabase/**`・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・`src/lib/env.ts`・`.env.example`・`ENV_SETUP.md` が無いことを確かめる (R-17。DB と環境変数を変えない。環境変数を読まないことは CT-8 が見る)。

### 13.5 表の行・シナリオとテストの対応

| 判定表 | it | 判定表 | it |
|---|---|---|---|
| P-1 | RT-1・A-8 | P-13 | U-6・U-11・RT-6・RT-15・I-2 |
| P-2 | RT-1・RT-12・A-2 | P-14 | U-6・RT-7・RT-17・A-1・I-9 |
| P-3 | RT-1 | P-15 | U-9 (read)・RT-15 |
| P-4 | RT-1 | P-16 | U-9・RT-8 |
| P-5 | RT-1・F-2・A-8 | P-17 | U-9・RT-9 |
| P-6 | RT-2 | P-18 | U-12・RT-10 |
| P-7 | RT-3・A-5 | P-19 | U-12・RT-10・A-3 の形 |
| P-8 | U-9 (read)・RT-14 | P-20 | U-12・RT-10 |
| P-9 | U-4・U-10・RT-3 | P-21 | U-12・RT-10 |
| P-10 | U-4・U-10・RT-4・A-3 | P-22 | U-9 (reread)・RT-16 |
| P-11 | U-2・U-4・U-10・RT-4・I-7・A-4 | P-23 | U-11・RT-5・I-1・A-1 |
| P-12 | U-6・RT-5 | P-24 | RT-11 |

| シナリオ | it | シナリオ | it |
|---|---|---|---|
| S-01 | RT-5・I-1・A-1 | S-12 | RT-1・RT-12・A-2 |
| S-02 | RT-6・I-2 | S-13 | I-5 |
| S-03 | U-6 (中身を見ない)・I-2 | S-14 | RT-8 |
| S-04 | I-2 (別の時刻の複製) | S-15 | RT-9 |
| S-05 | RT-7・I-3・A-1 | S-16 | U-12・RT-10・A-9 |
| S-06 | U-7・A-6 | S-17 | RT-13・F-1 |
| S-07 | RT-4・A-3 | S-18 | I-8・PG-3 |
| S-08 | RT-4・F-5・PG-4・A-4 | S-19 | RT-1 |
| S-09 | RT-2・RT-3・A-5 | S-20 | I-6 |
| S-10 | RT-3 | S-21 | (既存 `tests/integration/security/account-export-scope.test.ts` の形。変更なし) |
| S-11 | RT-1・F-2・A-8 | S-22 | PG-1・A-7・§13.4 |
| S-23 | U-5・RT-17・I-9 | — | — |

| 要件 | it | 要件 | it |
|---|---|---|---|
| R-01 | RT-5・A-1・F-1・PG-3 | R-11 | RT-1・RT-12・CT-4・A-2 |
| R-02 | RT-3・RT-4・A-3・A-5 | R-12 | RT-1 |
| R-03 | U-2・CT-2・RT-4・I-7・A-4 | R-13 | `moderation-backend.test.ts` と `moderation-route-contracts.test.ts` の #1538 の it (各 2)・A-7 |
| R-04 | I-5 | R-14 | PG-3・PG-4・F-5 |
| R-05 | U-8・CT-6・I-1 | R-15 | PG-1 |
| R-06 | U-6・RT-6・I-2 | R-16 | RT-13・F-1 |
| R-07 | RT-1・F-2・A-8 | R-17 | CT-8・§13.4 (差分の確認) |
| R-08 | U-7・RT-5・RT-7・I-8・A-6 | R-18 | §16 の番兵 (`null-character-routes`・`admin-mutation-audit-coverage-1571`・`operator-mfa-entry-points-scan`・`jst-today-source-scan`・`api-raw-error-message-scan`) |
| R-09 | RT-8・RT-9・RT-14・RT-15・RT-16 | R-19 | CT-1 |
| R-10 | CT-5・RT-5・RT-8・RT-9・A-1 | R-20 | U-12・RT-10・A-9 |

---

## 14. 段分け

| 段 | 中身 | §17 の行 (他の文書の追随) | 前提 | マージの単位 |
|---|---|---|---|---|
| A: 部品と API | `src/lib/admin/hidden-content-restore.ts` (§6)・`moderation-schemas.ts` の追記 (§7.1)・`moderation-backend.ts` の `hidden_at` (§7.2)・route (§8)・テスト (CT-1〜CT-8 (CT-3 を除く)・U-1〜U-12・RT-1〜RT-17・`moderation-backend.test.ts` と `moderation-route-contracts.test.ts` の追記・I-1〜I-9・A-1〜A-9)・番兵の追随 (§16 の段 A の行) | 行 1・2・3・4・5 (オーケストレーターの docs PR。同日) | 無し | 単独でマージしてよい (画面はまだ呼ばないが、API は使える) |
| B: 画面 | `ModerationRestoreForm.tsx` (§9.2)・詳細 `page.tsx` (§9.1)・一覧 `page.tsx` (§9.3)・テスト (F-1〜F-6・PG-1〜PG-4・CT-3・CT-8 の対象に `ModerationRestoreForm.tsx` を足す) | 行 6 | 段 A のマージ (API と `hidden_at`) | 段 A の後 |

段の順を守る理由: 段 B が先に出ると、詳細画面が `hidden_at` を受け取れず (常に null) 欄が出ない (壊れはしない)。段 A が先なら、API だけが先に使える。

---

## 15. 新設一覧

| 種類 | 名前 | 段 |
|---|---|---|
| ファイル (lib) | `src/lib/admin/hidden-content-restore.ts` | A |
| 定数 (新設ファイル・export 8) | `HIDDEN_CONTENT_RETENTION_DAYS` (写し)・`HIDDEN_CONTENT_RESTORE_MARGIN_DAYS`・`HIDDEN_CONTENT_RESTORE_WINDOW_DAYS`・`FLAG_STATUS_REJECTED`・`FLAG_STATUS_APPROVED`・`HIDDEN_CONTENT_TABLE_OF`・`MODERATION_FLAG_TABLE_OF`・`MODERATION_FLAG_CONTENT_COLUMN_OF` | A |
| 関数 (新設ファイル・export 8) | `hiddenContentRestoreCutoff`・`isWithinHiddenContentRestoreWindow`・`judgeHiddenContentRestorability`・`readHiddenContentRow`・`listRowsHiddenTogether`・`approveRejectedFlagsOfContent`・`restoreHiddenContentRows`・`restoreModeratedContent` | A |
| クラス (新設ファイル) | `HiddenContentRestoreStepError` | A |
| 型 (新設ファイル・export 8) | `HiddenContentRestoreAdmin`・`HiddenContentRow`・`HiddenContentRowHidden`・`HiddenContentRestorability`・`ApproveRejectedFlagsParams`・`HiddenContentRestoreStep`・`RestoreModeratedContentParams`・`HiddenContentRestoreOutcome` | A |
| 内部の名前 (新設ファイル・export しない) | `MS_PER_DAY`・`HIDDEN_CONTENT_COLUMNS_OF`・`RawHiddenContentRow` | A |
| 定数 (既存ファイル `moderation-schemas.ts`) | `MODERATION_NOTE_MIN_LENGTH`・`MODERATION_NOTE_MAX_LENGTH`・`ModerationRestoreBodySchema`・型 `ModerationRestoreBody`・`MODERATION_RESTORE_AUDIT_ACTION`。`ModerationItemSchema.hidden_at` | A |
| 項目 (既存ファイル `moderation-backend.ts`) | `NormalizedModerationItem.hidden_at`。embed の `hidden_at` (4 か所) | A |
| route | `src/app/api/admin/moderation/[type]/[id]/restore/route.ts` (`POST`)。内部の `ROUTE_NAME`・`describeError`・`errorResponse`・`insertAuditLog` | A |
| 監査の action | `admin.moderation.restore` | A |
| エラーコード | `OP_CONTENT_GONE` (410)・`OP_CONTENT_NOT_HIDDEN` (409)・`OP_CONTENT_RESTORE_WINDOW_EXPIRED` (409)・`OP_CONTENT_RESTORE_FAILED` (500) | A |
| 応答の項目 | `GET /queue`・`GET /{type}/{id}` の `hidden_at`。`POST …/restore` の `data.success` / `content_hidden` / `restored_ids` / `approved_flag_ids` | A |
| コンポーネント | `src/components/operator/moderation/ModerationRestoreForm.tsx` (default export・型 `ModerationRestoreFormProps`。内部の `NOTE_MIN_LENGTH`・`NOTE_MAX_LENGTH`・`REFRESH_STATUSES`・`SUBMIT_LABEL`・`formatJst`) | B |
| 画面の項目 | 詳細の「表示」の項目と「非表示の解除」のカード。一覧の「非表示中」のバッジ | B |
| テスト | 契約 1: `tests/hidden-content-restore-contract.test.ts` / 単体 4: `tests/hidden-content-restore.test.ts`・`tests/moderation-restore-route-contracts.test.ts` (A)・`tests/admin-moderation-restore-form.test.tsx`・`tests/admin-moderation-hidden-pages.test.tsx` (B) / 結合 2: `tests/integration/rls/hidden-content-restore.test.ts`・`tests/integration/operator/admin-moderation-restore.test.ts` (A) | A / B |

変えるもの (既存): `src/lib/admin/moderation-schemas.ts`・`src/lib/admin/moderation-backend.ts` (A)、`src/app/admin/moderation/[type]/[id]/page.tsx`・`src/app/admin/moderation/page.tsx` (B)。既存のテスト・helper (§13.2 の追記と §16 の「直し方」で編集するもの。全 7 ファイル・すべて段 A): `tests/moderation-backend.test.ts`・`tests/moderation-route-contracts.test.ts`・`tests/helpers/fake-supabase.ts`・`tests/admin-mutation-audit-coverage-1571.test.ts`・`src/__tests__/api/null-character-routes.test.ts`・`tests/jst-today-source-scan.test.ts`・`tests/purge-hidden-content-migration-contract.test.ts`。設計書 (§17 のとおり): `operator/02-api-spec.md`・`operator/07-audit-monitoring.md`・`cross/04-api-conventions.md`・`operator/03-ui-spec.md`・`operator/CLAUDE.md`・`tests/design-doc-followup-owned-edits.test.ts` (オーケストレーターの docs PR)。**変えない**: `supabase/**` (migration・rollbacks・functions・baseline)・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・`src/lib/admin/user-ban.ts`・`src/lib/admin/audit.ts`・`src/components/operator/moderation/ModerationReviewForm.tsx`・`src/app/api/admin/moderation/[type]/[id]/route.ts`・`src/app/api/admin/moderation/queue/route.ts`・`src/app/api/admin/moderation/route.ts`・`src/lib/account-export-tables.ts`・環境変数の一覧 (`src/lib/env.ts`・`.env.example`・`ENV_SETUP.md`)。

---

## 16. 既存の番兵 (契約テスト・走査テスト) の追随表

grep の語で見つかる既存のテストと、その直し方。直さずに通る (反応しない) ものも、grep で当たるなら行として記録する。段は §14。

| 番兵 | grep の語 | 反応する理由 | 直し方 | 段 |
|---|---|---|---|---|
| `src/__tests__/api/null-character-routes.test.ts` (`ENTRIES`・洗い漏れの検出) | `admin/moderation/[type]/[id]/route.ts`・`rejectNullCharacterBody` | 本文を読む handler は表か `EXCLUDED` にちょうど 1 回載る。新しい route は本文を読むので、表に無いと赤 | `ENTRIES` の `admin/moderation/[type]/[id]/route.ts` の 2 行 (POST・PUT) の前後 (一覧の並びはファイル名の順) に `{ file: 'admin/moderation/[type]/[id]/restore/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/moderation/[type]/[id]/restore/route')).POST },` を足す。route は handler の最初で `rejectNullCharacterBody` を呼ぶ (§8) | A |
| `tests/admin-mutation-audit-coverage-1571.test.ts` (`EXPECTED`・(b) request) | `moderation/[type]/[id]/route.ts PUT`・`recordAdminAudit` | 変更系の handler は `EXPECTED` に 1 行。`recordAdminAudit` の呼び出しはオブジェクトのリテラルで `request` を渡す | `EXPECTED` の `'src/app/api/admin/moderation/[type]/[id]/route.ts PUT': 'audited',` の次に `'src/app/api/admin/moderation/[type]/[id]/restore/route.ts POST': 'audited',` を足す。route の `insertAuditLog` は同じファイルの関数で `recordAdminAudit({ …, request, … })` をリテラルで呼ぶ (§8) ので「audited」と判定される | A |
| `tests/jst-today-source-scan.test.ts` (規則 G の許可リスト) | `hidden-content-purge.ts`・`rule: 'G'`・`.gte(` | timestamptz の列 (`hidden_at`) を `.gte` で絞る箇所は、暦日でない理由を許可リストに書く (件数はちょうど) | 許可リストの `supabase/functions/_shared/hidden-content-purge.ts` の項の次に `{ file: 'src/lib/admin/hidden-content-restore.ts', rule: 'G', count: 1, reason: '運営が隠したコンテンツを戻す (#1538) の戻せる期限 (hidden_at)。要求の時刻のちょうど 89 日前 (今からの相対時刻) で、行を戻す UPDATE を絞る。完全削除のジョブの期限 (90 日前) と同じ行を扱わないための幅で、暦日ではない' }` を足す。`eq('hidden_at', …)` は規則 G の対象外 (`.gte` / `.gt` / `.lte` / `.lt` だけ) | A |
| `tests/helpers/fake-supabase.ts` (`createQueryBuilder`) | `is: vi.fn`・`in: vi.fn` | 単体テストの fake に `gte` が無い。`restoreHiddenContentRows` の `.gte` で `TypeError` | `in: vi.fn(() => builder),` の次に `gte: vi.fn(() => builder),` を足す (helper の変更。既存のテストは `gte` を呼ばないので影響なし) | A |
| `tests/purge-hidden-content-migration-contract.test.ts` 5. (`STALE_PHRASES`・`HIDE_DESCRIBERS`) | `STALE_PHRASES`・`purge-hidden-content` | src・tests のどこにも古い言い回し (「削除ジョブは別の作業」など 3 つ) が無いこと。隠す側の 3 ファイルがジョブの名前を挙げること | 新しいファイル (§6・§8・§9.2) に 3 つの言い回しを書かない (書いていない)。`HIDE_DESCRIBERS` に `'src/lib/admin/hidden-content-restore.ts',` を足す (§6 の冒頭はジョブの名前を挙げる。戻す側もジョブに追随していることを見張らせる) | A |
| `tests/moderation-route-contracts.test.ts` (GET の `toBe` / `toMatchObject`) | `fetchModerationSingle`・`meals: { user_id` | 応答の項目を個別に見ている (全体の `toEqual` は無い) ので、`hidden_at` が増えても赤にならない | 反応しない。§13.2 の 2 つの it を足す | A |
| `tests/moderation-backend.test.ts` (`toMatchObject`) | `fetchModerationList`・`photo_url: 'https://example.com/meal.jpg'` | `toMatchObject` なので `hidden_at` が増えても赤にならない | 反応しない。§13.2 の 2 つの it を足す | A |
| `tests/integration/operator/admin-moderation-detail.test.ts` (`QueueItem`・`toMatchObject`) | `api/admin/moderation` | 応答は `toMatchObject` / `dataOf(res)` の `toEqual` は POST の `{ success, status, ban_applied }` (変えない) | 反応しない (`QueueItem` の interface は vitest の実行では型を見ない)。新しい結合テストは別ファイル (§13.3) | A |
| `tests/operator-mfa-entry-points-scan.test.ts` ① | `src/app/api/admin`・`requireRole` | 運営の route の全 handler が入口の関数 (`requireRole` ほか) を呼ぶこと | 反応しない (route は `requireRole(['admin', 'super_admin', 'content_moderator'])` を既定の assurance で呼ぶ。`{ assurance: 'session' }` を渡さない) | A |
| `tests/admin-view-audit-1326.test.ts` (b) | `admin_audit_logs`・`x-forwarded-for` | `src/app/api/admin` の route が監査ログを直接 INSERT せず、`x-forwarded-for` を直読みしない | 反応しない (`recordAdminAudit` だけ) | A |
| `tests/api-raw-error-message-scan.test.ts` (#1172) | `src/app/api`・`NextResponse.json` | `src/app/api` 配下の全ファイルを readdir で走査し、`NextResponse.json(body)` の本文にエラー由来の値 (エラーらしい名前の値の `.message` / `.details` / `.hint`・catch の変数そのもの・それを入れた変数) があれば赤。新しい route (§8) は走査の対象になる | 直さずに通る (反応しない)。§8 の本文は固定の文と、`errorResponse` の引数 (`code` / `message` / `data`。どれも固定の文と ID の配列) と、`parseResult.error.flatten()` (同期の検証の結果) だけ。元のエラー文 (`describeError(err)`・`reasonText`) は `console.error`・構造化ログ・監査ログにだけ渡す。実装で元のエラー文を本文に入れると、この番兵と RT-8・RT-14 が赤になる | A |
| `tests/lib-raw-error-message-scan.test.ts` (#1172) | `src/lib`・`RAW_TEXT_PROPERTIES` | `src/lib` のヘルパーの結果 (オブジェクトリテラル) にエラーの `.message` / `.details` / `.hint` を入れていないか。新しい `hidden-content-restore.ts` (§6) は走査の対象になる | 反応しない (§6 は DB のエラーを `throw` し、`HiddenContentRestoreStepError` の `reason` に代入で持つだけで、結果のオブジェクトにエラーの文面を入れない) | A |
| `tests/operator-page-guard-wiring.test.ts` (#1176・`EXPECTED_PAGE_GUARDS`) | `src/app/admin/moderation/page.tsx`・`requireRoleForPage` | 運営の page の `requireRoleForPage` の roles・next を表で持ち、素の `requireRole(` と `redirect('/login')` が残っていないことを見る。§9 は表に載っている 2 つの page (一覧と詳細) を変える | 反応しない (§9 は両 page の `requireRoleForPage` の呼び出し (roles・next) を変えず、素の `requireRole(` も `redirect('/login')` も足さない。足すのは `ModerationRestoreForm` の描画・`isWithinHiddenContentRestoreWindow` の呼び出し・「表示」の項目・バッジだけ) | B |
| `tests/admin-preparing-pages.test.tsx` (#1125 #1128) | `@/app/admin/moderation/page`・`AdminModerationDetailPage` | 一覧と詳細の page を描画する (一覧は `hidden_at` の無い項目、詳細は `ai_content` と未知の type だけ) | 反応しない (一覧の項目に `hidden_at` が無ければ `undefined` でバッジを出さない。詳細は `ai_content` で早く返すので `ModerationRestoreForm` (`useRouter` を使う) を描かない。このファイルの `next/navigation` の mock には `useRouter` が無いので、隠れている項目の描画は新しいファイル `tests/admin-moderation-hidden-pages.test.tsx` (§13.2) に置く) | B |
| `tests/integration/operator/auth-boundary.test.ts` (`endpoints`) | `/api/admin`・`401 for no auth` | 主な運営の endpoint の一覧に、未認証 401・一般ユーザー 403 を当てる。一覧にモデレーションの endpoint は既存のものも無い | 反応しない・足さない (一覧は主な endpoint の抜き出しで網羅の番兵ではない。新しい endpoint の 401 / 403 は A-2 と RT-1 が見る) | A |
| `tests/e2e-api-paths.test.ts` | `api/admin/moderation` | e2e spec が叩く `/api/...` のパスが実在する route に対応する | 反応しない (e2e spec は新しいパスを叩かない。route が増えるだけ) | — |
| `tests/signed-photo-display-scan.test.ts` | `src/app/admin/moderation` | 保存された写真の URL を `img` に直接渡さない | 反応しない (`ModerationRestoreForm` と足す項目は画像を描かない。既存の `img` は変えない) | B |
| `tests/moderation-photo-signing.test.ts` | `withSignedModerationContentUrls`・`detailGET` / `queueGET` | `content_url` の署名 | 反応しない (`hidden_at` は署名の対象外。generic の `T` にそのまま通る) | A |
| `tests/admin-moderation-review-form.test.tsx` | `ModerationReviewForm` | 審査の欄の振る舞い | 反応しない (`ModerationReviewForm.tsx` を変えない。新しい欄は別のコンポーネント) | B |
| `tests/integration/rls/hidden-content-visibility.test.ts` (C8 ほか) | `hidden_at`・`hideModeratedContent` | RLS・ガード・`hideModeratedContent` の振る舞い | 反応しない (隠す側・DB を変えない。C8「運営 (service_role) は、隠す・戻すことができる」が本書の前提の DB の事実)。戻す側の結合は新しいファイル (§13.3) | A |
| `tests/hidden-content-purge.test.ts`・`tests/integration/security/purge-hidden-content.test.ts` | `HIDDEN_CONTENT_RETENTION_DAYS`・`purgeExpiredHiddenContent` | 完全削除の振る舞い | 反応しない (Edge のモジュールを変えない)。写しの一致は CT-1 | A |
| `tests/billing-audit-action-lists-doc.test.ts` | `07-audit-monitoring.md`・`AUDIT_NAME_LINE` | 07 §4 の網羅リストの `*.billing.*` の名前とコードの一覧の突き合わせ | 反応しない (`admin.moderation.restore` の行を §4.1 に足しても、課金の名前ではない) | docs |
| `tests/docs-table-column-count.test.ts` | `docs/` の表 | 表の各行のセルの数が見出しと同じ | 本書の表は列の数を揃えてある (セルの中に `|` を書かない)。反応しない | docs |
| `tests/design-doc-followup-owned-edits.test.ts` (`OWNED_EDITS`) | `OWNED_EDITS`・`02-api-spec.md` | 追随表の逐語の書き換えの行は、対象の文書に前か後の文のどちらかが残る | §17.1 の行 (02 §5 の「隠した行を元に戻す操作は、まだ無い …」→ 新しい文) を `OWNED_EDITS` に足す: `{ owner: 'docs/design/operator/13-hidden-content-restore.md', target: 'docs/design/operator/02-api-spec.md', pattern: /「(`approve` \/ `escalate` は何も隠さない[^」]*)」→「([^」]*)」/ }` (直前にコメント `// operator/13 §17.1: 02 §5 の delete_* の説明の 1 行。オーケストレーターの docs PR が持つ`)。⚠ `OWNED_EDITS` の既存の cross/19 の行も `02-api-spec.md` を target にしているが、`rowsOf` は owner ごとに読むので衝突しない。本書の中で 1 列目が `` `docs/design/operator/02-api-spec.md` `` で始まる行は §17.1 の 1 行だけ | docs |
| `tests/admin-mutation-audit-1571.test.ts`・`tests/admin-pii-view-audit.test.ts`・`tests/admin-audit-client-ip-1571.test.ts` | `recordAdminAudit` | 個別の route の監査の振る舞い・IP の取り出し | 反応しない (新しい route は走査の対象でなく、`recordAdminAudit` を変えない) | — |
| `tests/e2e/operator/01-admin-flow.spec.ts`・`tests/e2e/w5-12-admin-adversarial.spec.ts` | `api/admin/moderation` | e2e (vitest の全件には入らない) | 反応しない (キューの応答に項目が増えるだけ。`toEqual` で全体を固定していない) | — |

### 16.1 `tests/helpers/fake-supabase.ts` の追記 (段 A・逐語)

```ts
// tsc:skip — helper への追記の断片 (builder は同じ関数の既存の名前)
    in: vi.fn(() => builder),
    gte: vi.fn(() => builder), // #1538 戻す操作の期限 (hidden_at >= now − 89 日) の絞り込み
```

---

## 17. 他の文書への追随表

| # | 文書 | 直すこと | 段 |
|---|---|---|---|
| 1 | `operator/02-api-spec.md` §5 (364 行〜「PUT /api/admin/moderation/{type}/{id}」の箇条書き) | 「`approve` / `escalate` は何も隠さない。隠した行を元に戻す操作は、まだ無い (必要なときは service_role で `hidden_*` を NULL に戻す)」の行を §17.1 の逐語のとおりに書き換える。同じ節の末尾に「### POST /api/admin/moderation/{type}/{id}/restore」の小節を足す: 本文 `{ "restore_note": "…" }` (必須・1〜5000 字)・戻せる条件 (隠れている・89 日以内・行がある)・同じ操作で隠した複製をまとめて戻す・通報 `rejected` → `approved`・順 (通報 → 行)・応答 `{ data: { success, content_hidden, restored_ids, approved_flag_ids } }`・エラー (§11 の 409 / 410 / 500 の 4 つと `CONFLICT_STALE_DATA`)・監査ログ `admin.moderation.restore`・BAN に触れない・正本は本書 §8。`GET /api/admin/moderation/{type}` のレスポンスの例に `"hidden_at": null` を足す | A (オーケストレーターの docs PR・同日) |
| 2 | `operator/07-audit-monitoring.md` §4.1 (コードのフェンスの `admin.moderation.<action>` の行の次) | `admin.moderation.restore               - 隠したコンテンツを戻す (POST /api/admin/moderation/{type}/{id}/restore) (#1538)` の行と、続く注記の行「(対象は通報 (target_type = 'moderation_item:<type>')。details: moderation_type / flag_id / content_id / content_user_id / restore_note / hidden_at_before / hidden_by_before / hidden_reason_before / target_ids / restored_ids / restored / restore_error / approved_flag_ids / status_saved / status_error / restore_window_days。成功 info・失敗 warn。判定で戻せない 409 / 410 は記録しない)」を足す。`AUDIT_NAME_LINE` の形 (`名前  - 説明`) を守る | A (同上) |
| 3 | `cross/04-api-conventions.md` 「OP 系」の表 | `OP_EMAIL_OUTBOX_NOT_REQUEUEABLE` の行の次に 5 行: `OP_CONTENT_HIDE_FAILED` (**[NEW]** 通報されたコンテンツを隠せなかった。判定を保存せず BAN もしない (`POST` / `PUT /api/admin/moderation/{type}/{id}`。`operator/02-api-spec.md` §5)・500)・`OP_CONTENT_GONE` (**[NEW]** 戻す対象のコンテンツが無い (通報に紐づかない・持ち主が消した・完全削除された) (`POST /api/admin/moderation/{type}/{id}/restore`。`operator/13-hidden-content-restore.md` §11)・410)・`OP_CONTENT_NOT_HIDDEN` (**[NEW]** 戻す対象がすでに表示されている・409)・`OP_CONTENT_RESTORE_WINDOW_EXPIRED` (**[NEW]** 隠してから 89 日を過ぎて戻せない (保管期間 90 日の完全削除を待つ)・409)・`OP_CONTENT_RESTORE_FAILED` (**[NEW]** 通報は承認済みにしたが行を戻せなかった。やり直せる・500)。`OP_` の接頭辞の表 (83 行) の HTTP に 409・410・500 が加わるので「400, 422」を「400, 403, 404, 409, 410, 422, 500」にする (既存の `OP_PLAN_NOT_FOUND` 404・`OP_SELF_MODIFY` 403 も実際にはある) | A (同上) |
| 4 | `operator/CLAUDE.md` のファイル一覧 | `13-hidden-content-restore.md | 運営が隠したコンテンツ (#1101) を戻す操作 (API + 詳細画面の欄 + 一覧のバッジ。戻せる期間 89 日・通報を approved に・監査ログ) | 03 §5.3` の行を足す (origin/main の一覧は 10 までで、`11-ops-batches-non-billing.md`・`12-cron-secret-drift-monitor.md` の行も無い。同じ PR で 11・12 の行も足してよい) | A (同上) |
| 5 | `operator/08-cron-batches.md` §3.0 の `purge-hidden-content` の箇条書き (38 行) | 末尾に「運営が戻した行 (`hidden_at` が NULL に戻った行。`POST /api/admin/moderation/{type}/{id}/restore`。operator/13) は対象から外れ、画像も「使っている行がある」として残る。戻せるのは隠してから 89 日以内 (ジョブの期限 90 日と同じ行を扱わない幅)」を 1 文足す | A (同上) |
| 6 | `operator/03-ui-spec.md` §3.2 の次 (または末尾の §38 既存実装との関連) | 「`/admin/moderation` と `/admin/moderation/{type}/{id}` の画面の仕様は、本書に節が無い。隠したコンテンツを戻す欄・『非表示中』のバッジは `operator/13-hidden-content-restore.md` §9 が正本」の 1 文を足す | B (同上) |

`#1538` を含む行に、帰属の文言を新しく書かない (本書の冒頭の 1 文の引用だけ)。

### 17.1 逐語の書き換え (`tests/design-doc-followup-owned-edits.test.ts` の `OWNED_EDITS` が見る行)

1 列目は対象の文書のリポジトリの根からのパス、2 列目は「前の文」→「後の文」の 1 組だけ。前の文は、origin/main の対象の文書に逐語である (02 §5 の `PUT` の箇条書きの 1 行)。本書の中で 1 列目がこのパスで始まる行は、この 1 行だけにする。

| 文書 | 書き換え | 箇所 | 段 |
|---|---|---|---|
| `docs/design/operator/02-api-spec.md` §5 の箇条書き | 「`approve` / `escalate` は何も隠さない。隠した行を元に戻す操作は、まだ無い (必要なときは service_role で `hidden_*` を NULL に戻す)」→「`approve` / `escalate` は何も隠さない。隠した行を元に戻すのは `POST /api/admin/moderation/{type}/{id}/restore` (隠してから 89 日以内。`operator/13-hidden-content-restore.md`)」 | `PUT /api/admin/moderation/{type}/{id}` の箇条書きの 1 行 | A (§17 の行 1) |

---

## 18. 未解決事項

1. **Issue #1538 の最後のコメント (2026-10-17) は「項目 4: 戻す操作 (必要になったら作る)」と書き、本書の前提 (オーナーの選択 (2026-10-17): 戻す操作を「今作る」。) と食い違う。** 本書はオーナーの選択に従う。Issue のコメントの現在形化は、Issue 化のときにオーケストレーターが行う。
2. **権限の細部**: 本書は「隠す操作と同じロール」として `content_moderator` を含めた (D-10)。content_moderator は `MFA_REQUIRED_ROLES` に無いので、admin / super_admin と違い AAL2 を求めない (cross/12 の方針どおり)。戻す操作を admin / super_admin だけに絞る (content_moderator は隠せるが戻せない) か、現状のまま (隠す側と同じ) かは、オーナーの判断があれば従う。本書の既定は現状のまま。
3. **戻せる期間の代償** (§6.1): 隠してから 89 日〜次の 03:25 のあいだ (最長 2 日弱) は、行がまだあるのに戻せない。許容する前提で設計した。
4. **本番の隠した行の件数** は読んでいない (§2.2)。0 件なら整合ゲートは捨て伝票で確かめる (§13.4)。
5. **`OP_CONTENT_HIDE_FAILED` が cross/04 の表に無い** (実コードと 02 §5 にはある)。§17 の行 3 で本書の 4 つと一緒に足す (本書の範囲の外の既存の抜け)。

---

## 19. 限界 (知っておくこと)

- **89 日を過ぎた行は戻せない** (D-2・D-13)。保管期間 90 日の運用の中で、ジョブと同じ行を扱わないための幅。期間を変えるときは、Edge の正本と src の写しを同時に直す (CT-1)。
- **同じ操作で隠した行の判定は `hidden_at` の等値** (D-5)。隠す側が 1 回の UPDATE で書く限り正しい。隠す側を 2 回の UPDATE に変える改修があれば、本書の D-5 も見直す (隠す側は本書の範囲の外)。
- **戻す操作と、別の通報の `delete_*` が同じ行でミリ秒単位で交差したとき** (読んでから書くまでに戻され、隠し直された: P-21)、通報の `rejected` → `approved` の更新が、新しい隠し操作の通報まで `approved` にすることがある (行は隠れたまま)。画面を開き直すと「非表示の解除」の欄が出て、もう一度戻せば行と通報がそろう。ローンチ前・利用者ゼロでは実際に起きないが、§4.2 の案 B (DB の関数) に移れば構造的に消える。
- **`pending` / `escalated` の通報は戻しても変わらない** (D-6)。その通報を後で `delete_*` にすると、同じ行が新しい `hidden_at` で隠れる (保管期間は数え直し。S-18)。
- **BAN は戻さない** (D-11)。戻した画面に 1 文で案内するだけ。
- **投稿者には知らせない** (D-9)。
- **`ai_content` は対象外** (既存どおり 501)。
