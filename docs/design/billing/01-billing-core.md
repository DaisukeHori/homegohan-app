# billing/01 課金の核 — Stripe Checkout・Webhook・サブスクリプションの状態

| | |
|---|---|
| 版 | v1.12 (2026-10-19) |
| Status | 設計ゲート通過。段 A (PR #1711)・段 B (PR #1726)・段 C (画面層。PR #1738) は main に実装済み。#1911 (#1916 4b1e1abe・2026-10-19) が「準備中」の表示を取り除いた後の画面と文に合わせた (v1.12) |
| Issue | #1151 (購入の入口)・#1125 (Webhook の受け口) の「核」。配線の冊は `02-manual-plan-grant.md` (手動付与。段 A〜D 実装済み) と、配線の残りの冊 (§0.2 右列のうち手動付与以外: 運用バッチ・Finance 画面ほか。未作成) に分かれる。本文の『配線の冊』は、手動付与については 02、それ以外は配線の残りの冊を指す |
| 範囲の正本 | Issue #1151・#1125 の本文とコメント (オーナーの選択 2026-10-15 は #1701 と本書 §0 に記録) |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする |

ローンチまでに作る (オーナーの選択 2026-10-15・選択式)。課金は大きいので分冊する: この冊は「核」= 利用者が有料プランを買い、その状態が DB に正しく反映され、取り消し・失敗・更新が追随するところまで。運用バッチ 20 本 (ライセンス失効・凍結猶予・収益スナップショットなど) と運営の Finance 画面への配線は「配線」の冊で、この冊の後に別に設計する (この冊では、配線の冊が読む表と関数の契約だけを確定させる)。

---

## 0. 分冊判定・範囲・読み方

### 0.1 分冊判定 (相 1 で実施)

| 目安 | 本冊 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (正典コード・表 3 点・トレースを 1 冊に持つため) | 該当 |
| 消費先レーン 3 以上 | API 8 本 (課金の route 7 + Webhook 1。§9・§15.3)・画面 4 つ (`/pricing`・`/account/billing`・`/account/billing/checkout`・凍結中の解約の `/frozen/billing`。§10)・退会・モバイル = 4 以上 | 該当 |
| 共有面 2 つ以上 | `personal_subscriptions` (family / org / AI 上限が読む)・`user_profiles.plan_key_cached` (機能フラグが読む。特権列ガード 2 本を置き換える)・`family_groups.plan_key` (トリガーを足す)・`src/lib/env.ts` の一覧・`cross/04` のエラー表・退会 (`src/lib/account-deletion.ts`)・本人のデータの書き出しの分類 (`src/lib/account-export-tables.ts`)・凍結中も通す API の一覧 (`src/lib/auth/frozen.ts` の `FROZEN_ALLOWED_API_PATHS`。§9.8) | 該当 |

判定: **設計は 1 冊 (本書) のまま、実装を 3 段 (A: DB 層 / B: サーバ層 / C: 画面層。§15) に分け、段ごとに 2 枚レビューを挟む**。理由: Stripe の状態の写像 (SQL 関数) と、それを呼ぶ Webhook・API (TS) は 1 つの契約 (§8.1 のスナップショット) を挟んで表裏になっており、冊を分けると「未マージの核を参照する配線」の指摘 (2026-09-11 の分冊判定の根拠と同型) を自分で作ることになる。段 A は単独でマージでき (列の追加・RLS の是正・関数とトリガーの新設・特権列ガードへの 1 列の追加。既存の挙動で変わるのは、利用者が自分で書けていた権利の値 (契約の行・`plan_key_cached`・家族グループを作るときのプラン) を書けなくすることだけ)、段 B・C はそれぞれ段 A のマージ済みの実コードを参照する。

さらに分ける案 (採らない): 「Webhook の受け口」と「Checkout の入口」を別冊にする案は、どちらも §8.1 の写像関数を呼ぶだけで独自の表を持たないため、分けても行数がほぼ減らない。

### 0.2 本冊の範囲 (核) と、配線の冊に残すもの

| 核 (本冊) | 配線 (02 の冊。本冊は契約 §12 だけを確定) |
|---|---|
| 顧客 (Stripe Customer) の作り方と利用者との対応表 `billing_customers` | 運営の Finance 画面 (`/admin/finance/*`) の実データ化 |
| Checkout Session の作り方 (プラン・月額/年額・試用・クーポン・家族プラン) | 運営者による手動のプラン付与 (`stripe_subscription_id IS NULL` の行) の画面と API → `02-manual-plan-grant.md` |
| 特商法の最終確認画面と、戻り画面 (`/account/billing`) | 支払失敗の 7 日後 `grace`・30 日後の解約の日次ジョブ (`grace_period_check`)・`revenue_snapshot`・`stripe_integrity_check` (reconcile)・`stripe_event_stuck_check` ほか 20 本 |
| Webhook の受け口 (署名・冪等・順序の入れ替わり・再送・失敗の再処理) | ブランドのメール (支払失敗・試用終了の案内)。核では Stripe の顧客向けメール (Dashboard 設定) に任せる (§5.3) |
| サブスクリプションの状態の正本と遷移表 (`billing_apply_stripe_subscription`) | チャージバック (`charge.dispute.created`) の運営対応・自動 BAN なし |
| 権利判定の入口 (= 既存 `get_effective_plan` / `getEffectivePlan`。変えない) と `plan_key_cached`・`family_groups.plan_key` の同期 | `grace` での有料機能の制限 (402) の各入口への配線 |
| Billing Portal (カードの変更・請求書の履歴)・解約の予約と取り消し (凍結 (BAN) 中の利用者も解約の予約と Portal はできる。§9.8) | 組織ライセンス受領による一時停止 (`paused`) |
| 退会での Stripe の解約と顧客の匿名化 (#1562) | 請求書番号 (`T` + 13 桁)・Stripe Invoice の設定 |
| モバイルの導線の規則 (アプリ内課金 (App Store / Google Play。RevenueCat) は billing/03。Web の購入のページへ誘導しない規則は本冊) | モバイル画面での契約状態の表示 |
| 本番の準備手順 (§17。秘密の値は #1113 のオーナー作業で入る前提) | |

### 0.3 読み方

- §3 要件行列・§3.2 シナリオ → §4 構想とトレース → §5 構造裁定 → §6 以降が仕上げ (実装者は §6〜§16 だけ読めば手を止めない)。
- 正典の TS は §8・§9・§10・§11 の ```ts ブロック。どれも型検査を通る形で書く。1 行目に `place=<パス>` (そのパスの新しいファイルの全文)・`append=<パス>` (既存のファイルの末尾に足す)・`insert=<パス>` (既存のファイルの決まった位置に差し込む) の印があるブロックは、新設モジュール同士の import や再生成後の DB の型に頼るので単独の検査 (`// tsc:skip`) から外し、§8.0 の手順で置き場所に置いてリポジトリ全体と一緒に検査する。印の無い `// tsc:skip` のブロックは説明用の断片 (差分の抜粋・テストの道具の一覧の行) だけ。SQL は §6。
- 既存の設計書との食い違いは本冊が正。追随の行は §16.2。

---

## 1. 目的・スコープ

- 利用者が `/pricing` から有料プラン (`pro` / `family_basic` / `family_pro`) を Stripe Checkout で買い、その契約が `personal_subscriptions` に正しく写り、支払失敗・更新・解約・退会に追随する。
- 対象外 (配線の冊): §0.2 右列。対象外 (別の冊): 組織 (`org_*`) の課金 (請求書払い・Quote)、`family_addon`、価格変更 (`operator/04` §3.3・`05` §5 のとおり新規契約のみ)。

---

## 2. 関連要件と現行の事実

### 2.1 関連要件・既存設計

| 文書 | 使う箇所 |
|---|---|
| `docs/design/operator/05-stripe-integration.md` | §4 Webhook (本冊で置き換える)・§6.1 対応表・§9 猶予・§15 API 版 |
| `docs/design/operator/04-plan-management.md` | §5.1 状態遷移図・§5.2 試用・§5.4 一時停止 |
| `docs/design/operator/01-data-model.md` | §3.2 / §3.7 / §3.18 DDL |
| `docs/design/operator/08-cron-batches.md` | §3.1 / §3.2 (配線の冊の対象。本冊は §12 の契約だけ) |
| `docs/design/cross/04-api-conventions.md` | §4 エラーコード・§5 応答の形・§10 Webhook 規約 |
| `docs/design/cross/02-rls-patterns.md` | §6.2 ロックキーの命名 |
| `docs/design/cross/08-legal-compliance.md` | §3 特商法の最終確認画面・§16 退会・§19 未解決 |
| `docs/design/CLAUDE.md` | RLS 必須・service_role は限定・監査ログ必須・snake_case |

### 2.2 現行の事実 (origin/main `e62b5d5f` と本番の読み取り、2026-10-15)

| # | 事実 | 出どころ |
|---|---|---|
| F1 | Checkout / Billing Portal / `constructEvent` の実装は 0 件。`stripe` npm 依存は無い。Stripe は REST (fetch) で扱う方針 | `git grep` 0 件・`package.json`・`supabase/functions/stripe-price-sync/index.ts` 冒頭のコメント |
| F2 | `src/app/pricing/page.tsx:23-24,114` は有料プランを「準備中」(`PAID_PLAN_PENDING`) と表示。`tests/public-claims-guard.test.ts` が「準備中」の表示を固定 (本冊の時点。#1911 (#1916) で取り除き、いまは買えるプランが 0 件のとき `src/app/pricing/PricingPageView.tsx` はフリーのカードと案内の段落・FAQ だけを出す。`tests/public-claims-guard.test.ts` は「準備中」「販売開始前」が無いことを固定する) | 同ファイル |
| F3 | `src/lib/webhook/verify.ts` は Resend (Svix 形式) だけ。`WebhookSecretMissingError`・`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`・`WebhookVerification` がある | 同ファイル :21-65 |
| F4 | `STRIPE_SECRET_KEY` は `src/lib/env.ts:186` の一覧にある。`STRIPE_WEBHOOK_SECRET` は `.env.example:88` だけで一覧に無い。`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`.env.example:89`) は読む場所が無い | 同ファイル |
| F5 | `personal_subscriptions` の DDL: `status` CHECK 7 値 (`trialing / active / paused / cancelled / expired / past_due / grace`)、`stripe_subscription_id` UNIQUE、部分 UNIQUE `idx_personal_subscriptions_active_per_user` (`trialing / active / paused / past_due / grace` は利用者ごとに 1 行)、`user_id` FK は `ON DELETE CASCADE`、`plan_key` FK は `ON UPDATE CASCADE ON DELETE RESTRICT`、`updated_at` のトリガーは無い | baseline migration 5787-5816・8146・9218・9223、本番 `pg_trigger` 0 件 |
| F6 | **RLS の穴**: `personal_subscriptions_insert` (WITH CHECK `user_id = auth.uid() OR admin/super_admin`) と `personal_subscriptions_update` (USING 同) により、利用者本人が PostgREST から自分の行の `status` / `plan_key` / `stripe_*` を書ける。列の権限も `authenticated` に INSERT / UPDATE が全 24 列付いている | 本番 `pg_policies`・`information_schema.column_privileges` |
| F7 | `stripe_webhook_events`: `id` PK・`processing_status` CHECK (`pending / processing / completed / failed`)・RLS `USING (false)` (service_role だけ)。本番 0 行 | baseline 6418-6432・10905 |
| F8 | `subscription_plans` (本番): `free` 0 円 / `pro` 980・9,800 円 試用 7 日 / `family_basic` 1,480・14,800 円 試用 7 日 `max_members` 4 / `family_pro` 2,480・24,800 円 試用 7 日 `max_members` 8 / `family_addon` private 280 円 / `org_*`。**全行の `stripe_product_id` / `stripe_price_id` / `stripe_yearly_price_id` が NULL** | 本番 SELECT |
| F9 | `personal_subscriptions`・`coupon_redemptions` は本番 0 行 | 本番 SELECT |
| F10 | プランの解決順は DB 関数 `get_effective_plan(p_user_id)`: 個人契約 (`trialing / active / grace / past_due`) → 家族 (active なメンバー・active な家族の `family_groups.plan_key`) → 組織 → `free`。TS の入口は `getEffectivePlan` (`src/lib/plan/entitlements.ts:370`)。AI の 1 日の上限は `ai_daily_limits` (プランごと) | `supabase/migrations/20261010140000_ai_usage_foundation.sql:95-160` |
| F11 | `user_profiles.plan_key_cached` は「個人契約の plan_key のキャッシュ (Edge Function が同期)」とコメントされ、同期する処理は無い。読むのは機能フラグの段階公開 (`src/__tests__/lib/feature-flags.test.ts:341` のとおり空なら free) | `operator/01` §3.9.1・grep |
| F12 | `family_groups`: `representative_id`・`plan_key` (既定 `'free'`、FK → `subscription_plans`)・`member_limit` (CHECK 1〜20、既定 4)・`status` (`active / dissolved`)。`plan_key` を書くアプリコードは無い | baseline 327-340・8878・grep |
| F13 | `cross/02` §6.3 の `acquire_advisory_lock` / `acquire_family_group_lock` は本番に無い (`pg_proc` に無い)。既存 RPC は関数内で `pg_advisory_xact_lock` を直接呼ぶか `FOR UPDATE` を使う (`apply_coupon`) | 本番 `pg_proc`・`20261007160700_apply_coupon_rpc.sql` |
| F14 | `admin_audit_logs.actor_id` は NULL 可で `auth.users` を `ON DELETE SET NULL` で参照。`'00000000-…'` の system ユーザーは存在せず、既存 migration もその値を使っていない。INSERT ポリシーは `actor_id = auth.uid()` (SECURITY DEFINER の関数と service_role は RLS を通らない) | baseline 3738-3754・8643・10127 |
| F15 | 退会は `src/lib/account-deletion.ts` の `deleteAccount` (段階: `init / check_blockers / prepare / release_membership / storage / delete_user`)。Stripe の扱いは未実装 (`cross/08` §16.3・§19)。#1562 のコメント (記録) では「退会では Stripe のサブスクリプションを解約し、顧客は氏名とメールを消す匿名化をして残す」 | 同ファイル :34-40・:213-280 |
| F16 | 既存の Stripe の価格 ID の入れ方: `PATCH /api/super-admin/plans/[id]` が `stripe_product_id` を受け (`src/lib/super-admin/plans-schemas.ts:123`)、`POST /api/super-admin/plans/[id]/price-change` が Edge Function `stripe-price-sync` で Price を作って `stripe_price_id` / `stripe_yearly_price_id` に書く | 同ファイル群 |
| F17 | ネイティブアプリの WebView は Cookie `is_native_app=1` で見分ける (`src/app/(main)/layout.tsx:15-16`、client は `useNativeAppMode` (`src/hooks/useNativeAppMode.ts:27`)) | 同ファイル |
| F18 | route の規約: 500 は `internalError` (`src/lib/api/errors.ts:101`)、service_role は `getSupabaseAdmin` (`lib/supabase/server.ts:19`) だけ、`createClient` は `await`、400 は `{ error: { code, message, details } }` (`src/lib/super-admin/validation-errors.ts`)、レート制限は `checkRateLimit(key, category)` + `rateLimitExceededResponse` (`src/lib/rate-limit.ts:311,342`) | 各ファイル |
| F19 | `05` §4.2 の `invoice.paid` の見本は `(invoice.lines.data[0] as any)` を使う (規約違反)。`05` §4.1 は失敗したイベントを `failed` にしたまま再送を 23505 で 200 にするため再処理されない。イベントの順序の入れ替わりの扱いは書かれていない | `05` :78-94・:126 |
| F20 | 猶予の定義: `04` §5.1 / `05` §9 / `cross/08` §9 は past_due → 7 日で grace → 30 日で cancelled。`04` §5.3 だけ「7 日後に cancelled」で食い違う | 各ファイル |
| F21 | 特権列ガード `guard_user_profiles_privileged` (BEFORE UPDATE) と `_on_insert` (BEFORE INSERT) の最新の定義は `20261008200700_legal_documents_acceptance.sql:77-129`。守る列は `roles` ほか 14 列で、`plan_key_cached` は入っていない。本番では `user_profiles` に本人の UPDATE ポリシー (`auth.uid() = id`) があり、`authenticated` が `plan_key_cached` に UPDATE の列権限を持つ。`plan_key_cached` を読むのは機能フラグ (`src/lib/feature-flags.ts:217-229`・`src/app/api/feature-flags/route.ts:45-56`)・運営のユーザー一覧と詳細 (`src/app/api/admin/users/route.ts:177`・`[id]/route.ts:139`)・`src/lib/super-admin/flag-active-users.ts:73`。書くアプリコードは無い | 同ファイル・本番 `information_schema.column_privileges`・grep |
| F22 | 家族の代表者を変えるのは DB 関数 2 本: `operator_force_representative_transfer` (`UPDATE family_groups SET representative_id = p_new_rep_id`) と `accept_family_representative_transfer` (`… = auth.uid()`)。最新の定義は `20261008090100_family_lock_order.sql:224-339`。どちらも SECURITY DEFINER で、`family_groups` の行を `FOR NO KEY UPDATE` で先にロックする。`family_groups` には BEFORE UPDATE の `trg_guard_family_groups_privileged` (`authenticated` / `anon` が `representative_id` / `plan_key` / `member_limit` を変えたら 42501) がある。家族の代表者は退会できない (`deleteAccount` の段階 1 が 409) | 同ファイル・baseline 1779-1791・8514・`src/lib/account-deletion.ts:9` |
| F23 | **家族のプランを本人が選べる穴**: `create_family_group(p_name, p_plan_key DEFAULT 'free')` (SECURITY DEFINER・`authenticated` に EXECUTE) は `p_plan_key` をそのまま `family_groups.plan_key` に入れる。`POST /api/family/groups` は `CreateFamilyGroupBodySchema` (`plan_key: z.string().default('free')`) の値を渡す。このため利用者は課金なしで `family_pro` のグループを作れ、`get_effective_plan` (F10) が自分とメンバーに `family_pro` を返す (いまは本冊のトリガーが `p_plan_key` を置き換え (S20)、route は `create_family_group` を `p_name` だけで呼ぶ: billing/02 の段 D・#1820)。`family_groups` に直接 INSERT するアプリコードは無い。結合テストで家族のグループを `free` 以外のプランで作るのは 2 本だけ: `tests/integration/rls/ai-usage-rpc.test.ts:152-160,400` (`create_family_group` の `p_plan_key`) と `tests/integration/security/plan-deprecate-subscribers.test.ts:86-93` (`addFamily` が service_role で `family_groups` に `plan_key` を付けて直接 INSERT)。ほかは `p_plan_key: 'free'` か、`plan_key` を入れない直接の INSERT (既定の `free`) | baseline 1199-1228・11780-11782・`src/app/api/family/groups/route.ts:45-52`・`src/schemas/membership/family-group.ts:8-11`・grep (§16.1 冒頭の母集合の作り方) |
| F24 | AI の入口の棚卸し: `tests/ai-consent-enforcement.test.ts:164-167` は、`src/app` の route のうち import をたどって AI の印 (`tests/helpers/ai-reach.ts` の `AI_LEAF_PATTERN`) に届くものが、すべて `ENFORCED_ROUTES` か `EXEMPT_ROUTES` (`tests/helpers/ai-consent-enforced-paths.ts:206-271`) に載ることを求め、`:175-184` は載せたファイルが実際に届くことを求める。`src/lib/env.ts` は印に届く (ログインと Resend の Webhook は env.ts を通ってだけ届き、理由つきで `EXEMPT_ROUTES` に載る。同 `:261-270`)。route 以外 (ページ・レイアウト) は 1 つも届いてはいけない (`NON_ROUTE_FILES_REACHING_AI = {}`。`tests/ai-consent-enforcement.test.ts:156,192-201`)。本冊が使う既存の部品のうち印に届くのは `src/lib/env.ts` と、それを import する `src/lib/webhook/verify.ts` だけ (`src/lib/db-logger.ts`・`lib/supabase/server.ts`・`src/lib/plan/entitlements.ts`・`src/lib/site-config.ts`・`src/lib/rate-limit.ts`・`src/lib/api/errors.ts`・`src/lib/auth/helpers.ts`・`src/lib/account-deletion.ts`・`src/app/api/account/delete/route.ts` は届かない) | `reachesAi` を origin/main のファイルに当てて確認 |
| F25 | `stripe_webhook_events.payload` を読むのは運営の Finance の route 2 本: `src/app/api/admin/finance/invoices/route.ts:57-77` (一覧) と `invoices/[id]/route.ts:38-83` (詳細)。読む項目は `data.object` の `id`・`customer`・`subscription`・`amount_paid`・`amount_due`・`currency`・`number`・`invoice_pdf`・`period_start`・`period_end`。どちらもログインのセッションの client で読むので、RLS (`USING (false)`) で行が見えない既知の不具合がある (`tests/integration/operator/admin-finance-detail.test.ts:20-22`)。書き出し (`exports/route.ts:123-133`) は `payload` を読まない。`stripe_webhook_events` は利用者を指す列を持たない | 同ファイル群 |
| F26 | 凍結 (BAN。#1030 / #1445): 運営の BAN (`src/lib/admin/user-ban.ts:114-122`) は `user_profiles` の `frozen_at`・`frozen_reason`・`frozen_by`・`unban_at` だけを書く (`personal_subscriptions` に触れない)。middleware (`lib/supabase/middleware.ts:182-226`) は凍結中 (`isAccountFrozen`) の利用者の `/api/*` を、`FROZEN_ALLOWED_API_PATHS` (`src/lib/auth/frozen.ts:49-52`。退会 `POST /api/account/delete` と書き出し `GET /api/account/export` の 2 本・完全一致) を除いて 403 `AUTH_ACCOUNT_FROZEN` にし、画面は `/frozen` に回す (`/frozen` と `/contact` の前方一致・規約・認証の画面を除く。`:326-359`)。`requireUser` (`src/lib/auth/helpers.ts:83-88`) も凍結中は `ForbiddenError('AUTH_ACCOUNT_FROZEN')`。退会と書き出しの route は `requireUser` を使わず `supabase.auth.getUser()` で認証する。凍結中の画面は `/frozen` と `/frozen/account` (退会と書き出し) だけ。一覧は `lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts:64-68` が `toEqual` で固定 | 同ファイル群 |

---

## 3. 相 1 外形固定

### 3.1 要件行列

| ID | 要件 | 出どころ | 本冊の答え |
|---|---|---|---|
| R1 | 利用者が有料プランを自分で買える | #1151 | `POST /api/billing/checkout` → Stripe Checkout (§9.1) |
| R2 | 決済完了後に `personal_subscriptions` が作られ、以後の更新が追随する | #1151・#1125 | 写像関数 `billing_apply_stripe_subscription` を Webhook と戻り画面の両方から呼ぶ (§4.2・§6.4) |
| R3 | Webhook は署名を確かめ、冪等で、順序の入れ替わりと再送に耐え、失敗したイベントが再処理できる | spec・`cross/04` §10・F19 | 署名 (§8.3)・`billing_claim_stripe_event` (§6.4。`completed` だけを 200 で止め、処理中 (`in_progress`) は 409 で Stripe に再送させる)・「イベントの中身を信じず Stripe から取り直す + 取り直した時刻で単調に写す」(§4.1) |
| R4 | 状態の正本と遷移表 (trialing / active / past_due / canceled / incomplete など × イベント) | spec | §7.3 (`incomplete` を CHECK に足す) |
| R5 | 権利判定の入口 | spec | 既存 `get_effective_plan` / `getEffectivePlan` を変えない。`plan_key_cached`・`family_groups.plan_key` を写像の中で同期し、`plan_key_cached` は特権列ガードに足して本人が書けないようにする (§6.4 (11)) |
| R6 | 顧客 (Customer) の作り方と利用者との対応 | spec | `billing_customers` (§6.3)。1 利用者 = 1 顧客。顧客は Checkout の前に作る |
| R7 | クーポン | spec | Checkout は Stripe のプロモーションコード (`allow_promotion_codes`)。当社 `coupons` は運営の遡及適用 (`apply_coupon`) のまま、Checkout とは結ばない (§5.3) |
| R8 | 家族プラン | spec | 代表者が買う。写像が代表者の active な家族グループの `plan_key` / `member_limit` を同期 (§6.4)。グループを作ったとき・代表者が交代したときは、グループのプランを代表者の契約に合わせる (トリガー。§6.4 (10)) |
| R9 | Billing Portal | spec | `POST /api/billing/portal` (§9.4)。カードの変更・請求書の履歴。プランの切替は Portal で許さない (§17) |
| R10 | 失敗の扱い | spec | Stripe の Smart Retries + 顧客向けメール (Dashboard 設定) + DB `past_due` の写像 + 監査ログ `system.payment.failed`。`grace` 以降は配線 (§12) |
| R11 | モバイル (アプリ内課金は billing/03。アプリの中に Web の購入のページへの誘導を出さない規則は保つ) | spec | アプリ内課金 (App Store / Google Play) の購入の画面は billing/03 §10.6。アプリ内に Web の購入のページ・Web の価格・外部決済への誘導を出さない。WebView で開いた `/pricing` `/account/billing` は購入導線を描かない。いまアプリにある料金の画面 (`apps/mobile/app/(public)/pricing.tsx`。Web の `/pricing` を外部のブラウザで開く) は消す (§10.4) |
| R12 | 本番の秘密の値 | spec・#1113 | `STRIPE_SECRET_KEY` (既存の一覧) と `STRIPE_WEBHOOK_SECRET` (一覧に足す)。鍵が無ければ Stripe を呼ぶ API は 503、Stripe を呼ばない GET の 2 本 (要約・確認) は 200 (§9・S11)。`/pricing` は鍵を見ない: 買えるプラン (`stripe_price_id` のある行) が無い限り有料プランのカードを出さない (鍵の有無とは独立。§10.1・S11)。本番は鍵を入れてから Price を登録する順で準備し、「`/pricing` に出ているのに購入が 503」の時間を作らない (§17) |
| R13 | 退会で Stripe を即時解約し、顧客を匿名化して残す | spec (#1562) | `deleteAccount` に段階 `billing` (`prepare` の前) と `billing_recheck` (`deleteUser` の直前) を足す。どちらも顧客の開いたままの Checkout Session を閉じ (`expire`)、解約する契約を Stripe 側の一覧 (顧客の全契約) と DB の行の和で列挙して即時解約する (DB に写っていない契約・段階 `billing` のあとに完了した Checkout の契約も解約する。§11)。`deleteUser` のあとに Stripe に残った契約 (`billing_recheck` の列挙のあと `deleteUser` までの一瞬に完了した Checkout など) は、写像が「退会済み」(`customer_closed`) を返し、`syncSubscription` が即時解約する (§8.6・§7.3)。当社の DB にも氏名・メールを残さない: Webhook のイベントの記録は最小化した写しだけを保存する (§8.1 `minimizeStripeEventPayload`・§9.6) |
| R14 | 利用者本人が契約の行と、その写し (`plan_key_cached`・`family_groups.plan_key`) を直接書けない | F6・F21・F23・`docs/design/CLAUDE.md` RLS 厳格化 | INSERT / UPDATE ポリシーから `user_id = auth.uid()` を外す (§6.2)。特権列ガード 2 本に `plan_key_cached` を足す (§6.4 (11))。家族グループを作るときのプランは代表者の契約から決め、`create_family_group` の `p_plan_key` を使わない (§6.4 (10)) |
| R15 | 特商法の最終確認画面 | `cross/08` §3 | `/account/billing/checkout` (§10.2) |
| R16 | 解約が `/account/billing` から 1 タップ | `cross/08` §3.1 | `POST /api/billing/subscription/cancel` (期間末で解約。取り消し可) (§9.5)。凍結 (BAN) 中の利用者は `/account/billing` を開けない (middleware が画面を `/frozen` へ回す) ので、凍結の画面から `/frozen/billing` を開いて 1 タップで解約を予約する。凍結中も契約の要約・解約の予約・Billing Portal の 3 本の API を通す (§9.8・§10.5・S21)。凍結は契約も Stripe の課金も止めないので、止めると凍結中の利用者は退会のほかに課金を止められず、確認画面 (§10.2) の「解約予告期間 (いつでも)」に反する |
| R17 | 監査ログ必須 (課金的操作) | `docs/design/CLAUDE.md` | 状態の変化は写像関数が `admin_audit_logs` に書く。利用者の操作は route が service_role で書く (§8.6) |
| R18 | migration の番号はマージ時に確定、`.down.sql` を対で設計 | spec | §6.1 |
| R19 | as any 禁止・マジックナンバー禁止 | spec | §8.1 の定数に根拠。Stripe の型は Zod で自前に定義 (SDK を入れない) |
| R20 | 2 PR 以上が触る共有面の台帳 | `docs/design/CLAUDE.md`「並行開発時の conflict 注意」(同時編集が起きやすい箇所 = `cross/04` のエラーコード一覧・`00-architecture.md`・migration の順序) | §16.3 (リポジトリに台帳のファイルは無い (origin/main に `docs/shared-state-surfaces.md` は 0 件) ので、本冊が触る共有面を本冊の中で台帳にする)。他の文書の追随は §16.2 |

### 3.2 ユーザーシナリオ (21 本)

| ID | シナリオ |
|---|---|
| S1 | 新規購入: `pro` 月額を初めて買う。試用 7 日が付き、7 日後に自動で課金が始まる |
| S2 | 試用済みの再購入: 以前 `pro` を試用して解約した利用者がもう一度 `pro` を買う。試用は付かず、すぐ課金 |
| S3 | 家族プランの購入: 家族グループの代表者が `family_basic` 年額を買う。グループの `plan_key` と `member_limit` が変わる |
| S4 | 支払失敗からの回復: 更新日の決済が失敗し `past_due` になる。Smart Retries で 3 日後に成功し `active` に戻る |
| S5 | 支払失敗が続く: 7 日後に (配線の日次ジョブで) `grace`、30 日後に Stripe 側で解約され `customer.subscription.deleted` が届き `cancelled` |
| S6 | 解約の予約と取り消し: 利用者が `/account/billing` で「解約する」。期間末まで使え、途中で「解約を取り消す」。取り消さなければ期間末に `cancelled` |
| S7 | Billing Portal でカードを更新する。契約の状態は変わらない |
| S8 | Webhook の順序の入れ替わり・重複・失敗の再送: `customer.subscription.updated` が `created` より先に届く / 同じイベントが 2 回届く / 処理に失敗して Stripe が再送する |
| S9 | 戻り画面が Webhook より先: 決済完了の直後に `/account/billing?checkout=success` が開き、Webhook より先に契約が表示される |
| S10 | 退会: 契約中の利用者が退会する。Stripe のサブスクリプションは即時解約、顧客は氏名・メールを消して残る。退会後に届く Webhook は何も書かず 200。退会の前に開いた購入の画面 (Checkout) は閉じられて完了できず、退会の途中や直前に完了した購入の契約も即時解約される (退会した利用者に課金が続かない) |
| S11 | 秘密が未設定: `STRIPE_SECRET_KEY` が無いと Stripe を呼ぶ API (購入・同期・Portal・解約の予約と取り消し) は 503。`/pricing` は鍵を見ない (Price を登録していない間は有料プランのカードを出さないまま。鍵より先に Price を登録しない順で準備する。§17)。契約の要約と確認画面の内容 (GET の 2 本) は 200 のままで、設定画面からの `/account/billing` は開ける。`STRIPE_WEBHOOK_SECRET` が無いと Webhook は 503 |
| S12 | 二重契約の防止: 契約中 (または手動付与中) の利用者が買おうとすると 409 |
| S13 | 運営が Stripe Dashboard で直接作った契約 (metadata 無し): price から plan_key を解決して写す。解決できなければイベントは `failed` で残り、監査に出る |
| S14 | モバイルの WebView から `/pricing` と `/account/billing` を開く: 購入ボタン・価格・Portal・解約は出ない。契約の状態だけ出る |
| S15 | プロモーションコード: Checkout 画面で Stripe のコードを入れて割引で買う。当社の `coupons` は関係しない |
| S16 | テストモードのイベントが本番に届く: `livemode` が鍵のモードと違うので何もせず 200 |
| S17 | Checkout を途中でやめる: `cancel_url` に戻る。何も作られず、契約は無い |
| S18 | 家族プランの代表者の交代: `family_basic` を契約中の代表者 A が B に代表者を譲る (承諾、または運営の強制)。グループのプランは B の契約に従う (B に家族プランの契約が無ければ free に戻る)。A の契約はそのまま A のもの |
| S19 | Stripe の一時停止と再開: Dashboard で作られた試用つきの契約が、支払い方法なしで試用を終えて Stripe の `paused` になる。後で支払い方法が付いて再開 (`resumed`) する |
| S20 | 家族グループの作成: (a) `family_basic` を契約中の利用者が家族グループを作る → グループは `family_basic`。(b) 契約の無い利用者が `POST /api/family/groups` に `plan_key: 'family_pro'` を付けて作る → グループは `free` (課金なしで家族プランを名乗れない) |
| S21 | 凍結中の解約: `pro` を契約中 (`active`) の利用者が凍結 (BAN) される。ログインすると凍結の画面 (`/frozen`) に回され、「有料プランの解約・お支払い」から `/frozen/billing` を開いて「解約する」で期間末の解約を予約する (次の更新で課金されない)。Billing Portal でカード・請求書も見られる。解約の取り消し・新規購入は凍結中はできない |

---

## 4. 相 2 構想

### 4.1 構造 (発明相の結論)

```
                      ┌──────────────────────────────────────────────┐
  /pricing ──────────▶│ /account/billing/checkout (特商法の確認)      │
                      └───────────────┬──────────────────────────────┘
                                      │ POST /api/billing/checkout
                                      ▼
   ┌──────────────┐   StripeGateway   ┌──────────────────────┐
   │ Stripe (REST)│◀─────────────────▶│ src/lib/billing/     │  service.ts = ユースケース
   │  Checkout    │  retrieve/update  │   core.ts (純関数)    │  repository.ts = DB (service_role RPC)
   │  Portal      │                   │   service.ts         │  stripe-gateway.ts = fetch
   │  Subscription│   Webhook (署名)  │   repository.ts      │
   └──────┬───────┘──────────────────▶│                      │
          │                           └──────────┬───────────┘
          │  いつでも「いまの Subscription を取り直す」           │ billing_apply_stripe_subscription(snapshot, fetched_at)
          │                                                  ▼
          │                           ┌────────────────────────────────────────┐
          │                           │ DB: personal_subscriptions (写し)        │
          │                           │     billing_customers / stripe_webhook_events│
          │                           │     user_profiles.plan_key_cached・family_groups│
          │                           └────────────────────────────────────────┘
          │                                                  ▲
          └────────── 配線の冊: grace / 解約 / reconcile ──────┘ (同じ写像関数を呼ぶ)
```

**原理 (3 つ)**:

1. **Stripe-backed な行の正本は Stripe の Subscription オブジェクト。DB はその写し (projection)。** 写しを書く入口は DB 関数 `billing_apply_stripe_subscription` の 1 つだけ。Webhook・戻り画面・解約 API・配線のジョブ・reconcile のどれもこの関数を呼ぶ。
2. **イベントの中身 (`data.object`) を信じない。イベントは「何かが変わった合図」として扱い、必ず Stripe から最新の Subscription を取り直してから写す。** 取り直した時刻 (`fetched_at`) を `stripe_synced_at` に残し、それより古い取り直しの結果は捨てる (単調)。順序の入れ替わり・再送・重複・同時処理のすべてが同じ 1 つの規則で片付く。
3. **冪等キーは Stripe の `event.id`。** 受け口は `billing_claim_stripe_event` で「自分が処理する権利」を取ってから処理し、完了 / 失敗を記録する。2xx を返すのは処理が終わったとき (`completed`) だけ。ほかが処理中 (`in_progress`) なら 409 を返して Stripe に再送させる (Stripe は 2xx を受けるまで再送を続ける)。失敗 (または 15 分以上 `processing` のまま) のイベントは、その再送で再び権利が取れる (= 再処理される)。

**写像の規則 (`stripe_status` → `status`)**: `incomplete → incomplete` / `incomplete_expired → expired` / `trialing → trialing` / `active → active` / `past_due → past_due` / `unpaid → past_due` / `canceled → cancelled` / `paused → expired`。Stripe の `canceled` と `incomplete_expired` は終端 (Stripe はそこから別の status に戻さない) なので、`cancelled` と `stripe_status='incomplete_expired'` の `expired` はそれ以上動かない。Stripe の `paused` (試用が支払い方法なしで終わった契約) は再開 (`resumed`) し得るので、`stripe_status='paused'` の `expired` は `trialing / active` に戻り得る (§7.3)。保持の規則が 2 つ: DB が `grace` のとき Stripe が `past_due / unpaid` なら `grace` を保つ (grace は配線のジョブが past_due を段階的に進めたもの)。DB が `paused` (組織ライセンスの一時停止。配線) で Stripe が `active` かつ `pause_collection` 付きなら `paused` を保つ。

### 4.2 シナリオのトレース (上の構造で手で走らせたもの)

記法: `→` は処理の順、`[DB]` は `personal_subscriptions` の該当行、`t` は `fetched_at`。

| ID | トレース |
|---|---|
| S1 | `/pricing` (プランは `stripe_price_id` を持つ public な行だけ描き、カードには買える間隔 (`isPurchasable(plan, interval)` が真) ごとに金額と CTA。§10.1) → `pro` のカードの「月額で始める」→ `/account/billing/checkout?plan_key=pro&interval=month` (確認・チェック) → `POST /api/billing/checkout` → `findLiveSubscription` 無し → `hasUsedTrial(pro)` false → trial 7 日 → `billing_customers` 無し → Stripe `POST /customers` (Idempotency-Key `billing-customer:<user_id>`) → `saveCustomer` → Stripe `POST /checkout/sessions` (`subscription_data[trial_period_days]=7`・`metadata[user_id,plan_key,interval]`・`client_reference_id=<user_id>`・`allow_promotion_codes=true`) → 監査 `user.billing.checkout_started` (actor = 本人・`details: {plan_key, interval, trial_days: 7, checkout_session_id}`。§8.6 `startCheckout`) → 200 `{ data: { url, session_id } }` → 画面が `url` へ移動 (§9.1) → 利用者が決済 → Stripe が `customer.subscription.created` (status `trialing`) と `checkout.session.completed` を送る → 受け口: 署名 OK → `claim` = claimed → `retrieveSubscription` (t1) → snapshot → RPC: 利用者 = metadata.user_id → ロック → 既存行無し → plan `pro` → status `trialing` (live) → 他の live 行無し → INSERT (`trial_started_at`・`trial_ends_at`・`stripe_synced_at = t1`・`trial_source='checkout'`) → `plan_key_cached='pro'` → 監査 `system.billing.subscription_created` → `completed`。試用の終わりの 3 日前: Stripe が `customer.subscription.trial_will_end` → 取り直し (`trialing` のまま) → UPDATE は同じ値・監査なし (利用者への知らせは Stripe の顧客向けメール)。7 日後: Stripe が請求 → 成功 → `customer.subscription.updated` (`active`) → 取り直し (t2 > t1) → UPDATE `status='active'`・`current_period_*` → 監査 `status_changed trialing→active` |
| S2 | `POST /api/billing/checkout` → `hasUsedTrial(pro)` = `personal_subscriptions` に `user_id` 一致・`plan_key='pro'`・`trial_started_at IS NOT NULL` の行あり (cancelled の履歴) → trial 0 日 → `subscription_data[trial_period_days]` を付けない → 監査 `user.billing.checkout_started` (`trial_days: 0`) → 決済で即時課金 → `created` (`active`) → INSERT `active`。確認画面は「試用はお済みのため、お申し込み後すぐに課金が始まります」を表示 (`trial_days: 0` を事前計算 API `GET /api/billing/checkout/preview` で返す。§9.1) |
| S3 | `/pricing` の `family_basic` のカードの「年額で始める」(年額の Price `stripe_yearly_price_id` が登録されているときだけ出る。無ければカードは月額の行だけで、年額は買えない。§10.1) → `/account/billing/checkout?plan_key=family_basic&interval=year` → 以下 S1 と同じ流れで `stripe_yearly_price_id` を使う → `created` (`trialing`) → RPC: `subscription_plans.plan_type='family'` → `UPDATE family_groups SET plan_key='family_basic', member_limit=4 WHERE representative_id=<user> AND status='active'` → `get_effective_plan` は代表者には個人契約の `family_basic`、メンバーには家族の `family_basic` を返す。後に `cancelled` になれば `plan_key='free', member_limit=4` に戻す (この契約の plan_key を持つグループだけ)。代表者が交代したときは S18 |
| S4 | 更新日に `invoice.payment_failed` → 受け口: `audit_payment_failed_and_sync` → `invoiceSubscriptionId` → 取り直し (`past_due`) → 写像: UPDATE `status='past_due'`・`past_due_since=now()` → 監査 `status_changed active→past_due` (warn。RPC の中) → 写像の結果が `applied` か `stale` なので監査 `system.payment.failed` (warn, `details: {invoice_id, attempt_count, amount_due}`。§8.6。同時に届いた `customer.subscription.updated` の新しい取り直しが先に写して、こちらが `stale` になっても書く。退会済み (`user_deleted`) だけ書かない)。同時に Stripe の顧客向けメール (Dashboard で ON) が利用者に届く。3 日後 Smart Retry 成功 → `invoice.paid` + `customer.subscription.updated` (どちらが先でも) → 取り直し (`active`) → UPDATE `status='active'`・`past_due_since=NULL`。更新日の請求が認証 (3D セキュア) を要したときは `invoice.payment_action_required` → `sync_invoice_subscription` → 取り直し (Stripe が `past_due` なら上と同じ `past_due` と `status_changed`) → `system.payment.failed` は書かない (§7.3) |
| S5 | S4 の後 7 日: 配線の `grace_period_check` が `status='past_due' AND past_due_since <= now()-7d` を `grace` (`grace_started_at=now()`) に進める (§12 の契約: 1 文の直接 UPDATE。写像は呼ばない)。その後 Stripe の再試行イベントで取り直し → Stripe は `past_due` → 保持の規則で `grace` のまま。配線の UPDATE と写像が同時に走っても、写像は契約の行を `FOR NO KEY UPDATE` でロックしてから読むので、先に commit した `grace` (`grace_started_at` つき) を読んで保つ。写像が先なら、配線の UPDATE が写像の書いた行で `WHERE status='past_due'` を評価し直す (§6.4 (9) の 3.)。30 日目: 配線が Stripe `DELETE /subscriptions/{id}` → Stripe が `customer.subscription.deleted` → 取り直し (`canceled`) → `cancelled`・`cancelled_at = ended_at`・`grace_started_at=NULL`・`past_due_since=NULL` → `plan_key_cached=NULL` → 監査 |
| S6 | `/account/billing` →「解約する」(確認ダイアログ) → `POST /api/billing/subscription/cancel` → live かつ Stripe-backed の行あり → t0 を取る → Stripe `POST /subscriptions/{id}` (`cancel_at_period_end=true`) → 返ってきたオブジェクトを snapshot → RPC (`fetched_at=t0`) → UPDATE `cancel_at_period_end=true`・`cancel_at=current_period_end` (status は `active` のまま。遷移ではないので監査は route が `user.billing.cancel_scheduled` を書く) → 画面「<日付> まで利用できます」。Webhook の `updated` も届くが同じ内容 (t1 > t0 で適用。変化なし)。「解約を取り消す」→ `POST /api/billing/subscription/resume` → `cancel_at_period_end=false` → 同様。取り消さなければ期間末に Stripe が `deleted` → `cancelled`。**Portal から予約 / 取り消しした場合** (§17.1 項 3 で解約 ON): route を通らず、Stripe が `customer.subscription.updated` (`cancel_at_period_end=true` / `false`) を送る → 受け口が取り直して写像 (`webhook:<event.id>`) → UPDATE `cancel_at_period_end`・`cancel_at` (status は同じなので監査は書かない。記録は `stripe_webhook_events.payload` の最小化した写し (`status`・`cancel_at_period_end`・`cancel_at` を残す。§8.1) と Stripe の履歴) → 画面は `can_resume` / `can_cancel` で次の操作を出す (§7.3) |
| S7 | Portal でカード更新 → `customer.updated` / `payment_method.attached` が届く → `classifyStripeEvent` = `ignore` → 200 `{received: true, ignored: true}`。契約の行は変わらない |
| S8 | (a) `updated` (active) が `created` より先: 先に届いた方で取り直し → Stripe の最新 (active) → INSERT `active` (t1)。後から `created` → 取り直し → 同じ最新 → t2 > t1 で適用、変化なし (監査なし)。(b) 同じ `event.id` が 2 回: 1 回目が終わっていれば 2 回目は `claim` = `completed` → 200。1 回目がまだ処理中なら `in_progress` → 409 → Stripe が後で再送 → そのときは `completed` → 200。(c) 処理に失敗 (DB 障害) → `finish(ok=false)` で `failed` → 500 → Stripe が再送 → `claim` が `failed` 行を `processing` に戻して claimed → 再処理。(d) 1 回目が `finish` まで届かずに死ぬ (関数の時間切れ・プロセス落ち・`finish` 自体の失敗) → 行は `processing` のまま → 15 分以内の再送は `in_progress` → 409 (Stripe は再送を続ける) → 15 分を過ぎた再送で `claim` が古い `processing` を取り直して claimed → 再処理。(e) 2 つの Lambda が同時に同じ契約を処理: A が t1 で取り直し、B が t2 > t1 で取り直し、B が先に commit → A の RPC は `stripe_synced_at (t2) >= t1` で `skipped: 'stale'` (`user_id` つき) → 200。A が `invoice.payment_failed` なら、監査 `system.payment.failed` は stale でも書く (§8.6。S4) |
| S9 | 決済完了 → `success_url` = `/account/billing?checkout=success&session_id=cs_…` → 画面が `POST /api/billing/checkout/sync {session_id}` → Stripe `GET /checkout/sessions/{id}` → `client_reference_id` が本人か確認 → `status='complete'` かつ `subscription` あり → `syncSubscription` (取り直し t0・RPC) → 契約が表示される。数秒後に Webhook が同じ契約を写す (t1 > t0・変化なし) |
| S10 | `POST /api/account/delete` → `deleteAccount`: `check_blockers` → **`billing`**: 解約の対象を 2 つの和で集める = (1) `billing_customers` の顧客の全契約を Stripe から列挙 (`GET /subscriptions?customer=<cus>&status=all`。DB に行が無い契約 = Webhook が着く前・S12 の 2 本目・S13 で写せなかった契約も入る) と (2) DB の行 (`stripe_subscription_id` あり・status が `cancelled` 以外。`expired` は Stripe の `paused` のことがあるので含める) のうち (1) に無いもの (`GET /subscriptions/{id}` で取る。別の顧客で作られた契約) → (その前に) 顧客の開いたままの Checkout Session を `GET /checkout/sessions?customer=<cus>&status=open` で列挙して `POST /checkout/sessions/{id}/expire` で閉じる (退会の前に開いた購入の画面は、もう完了できない。列挙してから閉じるまでの間に完了した Session は閉じられないので取り直して飛ばし、その契約は次の列挙で解約する) → status が終端 (`canceled` / `incomplete_expired`) でないものを `DELETE /subscriptions/{id}` → `POST /customers/{cus}` (`name=''`, `email=''`, `phone=''`, `description=''`, `address=''`, `shipping=''`, `metadata[user_id]=''`, `metadata[anonymized_at]=<ISO>`) → `billing_customers.anonymized_at=now()` → 監査 `system.billing.account_deletion_stripe_cancelled` (`phase: 'billing'`) → 以降は既存の段階 (`prepare` → `release_membership` → `storage`) → **`billing_recheck`**: 同じ処理をもう一度 (その間に別のタブで完了した Checkout の契約・その間に作られた顧客を閉じる。匿名化済みの顧客は匿名化を繰り返さない。閉じた・解約したものがあったときだけ監査) → `deleteUser`。`deleteUser` で `personal_subscriptions` は CASCADE で消え、`billing_customers.user_id` は SET NULL。その後に届く `customer.subscription.deleted` → RPC: metadata.user_id は `auth.users` に無い → `skipped: 'user_deleted'` (`customer_closed: true`) → Stripe の status は終端なので何もしない → 200。`billing_recheck` の列挙のあと `deleteUser` までの一瞬に完了した契約は、届いた `customer.subscription.created` などの取り直しで Stripe の status が `trialing` / `active` → RPC が `user_deleted` (`customer_closed: true`。対応表の行の `user_id` が NULL) → `syncSubscription` が `DELETE /subscriptions/{id}` で即時解約し、監査 `system.billing.orphan_subscription_cancelled` (warn) → 200 (解約に失敗したら `failed`・500 で Stripe が再送し、取り直しでやり直す)。metadata.user_id を持たない契約 (Dashboard で作った契約。S13) は、顧客の対応表の行が `user_id IS NULL AND anonymized_at IS NOT NULL` (退会で匿名化済み) なので、同じく `skipped: 'user_deleted'` → 200 (§6.4 (9) の 1.。`BILL_UNKNOWN_USER` の 500 にしない) |
| S11 | `STRIPE_SECRET_KEY` 無し → Stripe を呼ぶ POST の 5 本は `StripeGateway` の生成で `StripeNotConfiguredError` → 503 `EXT_STRIPE_NOT_CONFIGURED`。GET の 2 本 (`/api/billing/subscription`・`/api/billing/checkout/preview`) は gateway を作らない (`BillingReadDeps`。§9) ので 200: 設定画面 → `/account/billing` は要約 (契約なしなら free・`can_purchase`。`has_customer` が false なので Portal のボタンも出ない) を描く (手動付与の利用者もその契約を見られる)。`/pricing` はプラン行に `stripe_price_id` が無い限り有料プランのカードを出さない (鍵の有無とは独立)。`STRIPE_WEBHOOK_SECRET` 無し → 503 `webhook_not_configured` (Stripe は 2xx 以外を再送するので、設定後に届き直す) |
| S12 | `POST /api/billing/checkout` → `findLiveSubscription` あり (Stripe-backed でも手動でも) → 409 `OP_SUBSCRIPTION_ALREADY_ACTIVE`。同時に 2 本来た場合は両方通り得る (check-then-act)。2 本目の契約の写像は RPC の `BILL_LIVE_ROW_CONFLICT` で失敗し、イベントが `failed` で残る (運営が Stripe で 2 本目を返金・解約する。§13)。運営が解約すると `customer.subscription.deleted` → 取り直し (`canceled`) → 2 本目の行は無いので `cancelled` の行を INSERT する (live でないので衝突の検査は無い。家族は同じプランの live な 1 本目があれば戻さない。監査 `subscription_created` (to=`cancelled`)。§7.3 の「– → cancelled / expired」の行) |
| S13 | Dashboard で作られた契約の `created` → 取り直し → `metadata.plan_key` 無し → `findPlanKeyByPriceId(items[0].price.id)` で `subscription_plans.stripe_price_id / stripe_yearly_price_id` を引く → 当たれば写す。当たらなければ snapshot の `plan_key=null` → RPC `BILL_UNKNOWN_PLAN` → `failed` + 500 (Stripe が再送し続け、3 日で止まる) + 監査 `system.stripe.event_failed` (warn)。後で Price を登録してから写ったとき、Stripe の status が `past_due` なら `past_due`、終端 (`canceled` / `incomplete_expired`) や `paused` なら `cancelled` / `expired` の行を INSERT する (§7.3 の「–」の 3 行) |
| S14 | WebView (Cookie `is_native_app=1`) で `/pricing` → サーバー側で Cookie を読み `isNativeApp=true` → 有料プランのカードと CTA を描かない。`/account/billing` → 契約の状態 (プラン・次回更新日・解約予約) だけ描き、Portal・解約・購入のボタンは描かない。API 自体は WebView からも呼べる (認可は同じ) |
| S15 | Checkout 画面で Stripe のプロモーションコードを入れる (`allow_promotion_codes=true`) → 割引は Stripe の Subscription に付く → 当社の `coupons` / `coupon_redemptions` には何も書かれない。運営の遡及適用 (`apply_coupon`) は従来どおり `personal_subscriptions.id` 宛てに使える (Stripe には反映されない。05 §6 の「subscriptions.update (discount)」は配線の冊の課題) |
| S16 | `event.livemode=false` が本番 (鍵 `sk_live_`) に届く → 署名は通る (エンドポイントの秘密は同じ) → `livemode` と鍵のモードの不一致 → 200 `{received: true, ignored: true}` + warn ログ。DB には何も書かない |
| S17 | Checkout で「戻る」→ `cancel_url` = `/account/billing?checkout=cancelled` → 画面「お申し込みは完了していません」。Stripe にも DB にも契約は無い (顧客 `cus_` だけ残る。次回の購入で再利用) |
| S18 | S3 の後、A (代表者・`family_basic` が `active`) が B に代表者を譲る → `accept_family_representative_transfer` (または `operator_force_representative_transfer`) が `UPDATE family_groups SET representative_id = B` → BEFORE UPDATE のトリガー `billing_family_plan_follow_representative` (§6.4 (10)。B の写像と advisory `billing-user:B` で直列): B に live な家族プランの契約が無い → 旧代表者 A に `plan_key='family_basic'` の live な行がある (= グループのプランは A の契約から来た) → `NEW.plan_key='free'`, `NEW.member_limit=4` → `get_effective_plan` は B とメンバーに `free`、A には個人契約の `family_basic` を返す。後で A が解約 → 写像の戻しは `representative_id = A` のグループ 0 行 (すでに free)。B が後で `family_pro` を買えば、写像が B のグループを `family_pro` にする。B が先に `family_pro` を契約していた場合は、交代の時点でトリガーが `family_pro`・上限 8 にする |
| S19 | Dashboard で作られた試用つきの契約が試用終了 (支払い方法なし) で Stripe の `paused` → `customer.subscription.paused` → 取り直し (`paused`) → `expired` (`stripe_status='paused'`) → `plan_key_cached` は live な行から再計算 (NULL)・家族は free へ・監査 `status_changed trialing→expired`。後で支払い方法が付いて再開 → `customer.subscription.resumed` → 取り直し (`active`) → 他に live 行が無ければ `active` (監査 `status_changed expired→active`・家族の同期)。その間に利用者が別の契約を買っていたら `BILL_LIVE_ROW_CONFLICT` (S12 と同じ扱い) |
| S20 | (a) `POST /api/family/groups` → `create_family_group` → `INSERT INTO family_groups (…, plan_key) VALUES (…, p_plan_key)` → BEFORE INSERT のトリガー (§6.4 (10)。代表者の写像と advisory `billing-user:<代表者>` で直列): 代表者に live な `family_basic` の行がある → `NEW.plan_key='family_basic'`・`NEW.member_limit=4` → メンバーは家族の `family_basic`。(b) 同じ流れで代表者に契約が無い → `NEW.plan_key='free'` (`p_plan_key='family_pro'` は使わない)・`member_limit` は既定の 4 → `get_effective_plan` は `free`。route は `create_family_group` を `p_name` だけで呼び、`CreateFamilyGroupBodySchema` は `plan_key` を持たない (billing/02 の段 D・#1820。§16.2)。DB 関数の `p_plan_key DEFAULT 'free'` は残るので、RPC を直接呼んで `p_plan_key` を渡しても (b) のとおりトリガーが置き換える |
| S21 | 運営が `user_profiles.frozen_at` を入れる (契約の行も Stripe の契約も変わらない。凍結は課金を止めない。§12) → 利用者がログイン → middleware が画面を `/frozen` に回す → 「有料プランの解約・お支払い」→ `/frozen/billing` (`/frozen/` の下は凍結の差し戻しの対象外) → 画面が `GET /api/billing/subscription` → middleware: 凍結中だが `isFrozenAllowedApiPath` が真なので通す → route: `requireUserAllowingFrozen` (凍結を見ない。§9.8) → `getBillingSummary` → 要約 (`status: 'active'`・`can_cancel: true`・`has_customer: true`) → 画面は `billingStatusLines` の「ご利用中」と「解約する」「お支払い方法・請求書 (Stripe)」 →「解約する」→ 確認 → `POST /api/billing/subscription/cancel` (同じく通す) → `scheduleCancellation` (S6 と同じ: Stripe `cancel_at_period_end=true` → 写像 `api:cancel` → 監査 `user.billing.cancel_scheduled` (actor = 本人)) → 200 の要約で「ご利用中」「<日付>に解約されます」→ 期間末に Stripe が `customer.subscription.deleted` → `cancelled` (S6 と同じ)。「お支払い方法・請求書 (Stripe)」→ `POST /api/billing/portal` (通す) → Portal → 戻り先 `/account/billing` は middleware が `/frozen` へ回す。凍結中に `POST /api/billing/subscription/resume`・`/api/billing/checkout`・`/api/billing/checkout/sync`・`GET /api/billing/checkout/preview` を呼ぶと middleware が 403 `AUTH_ACCOUNT_FROZEN` (route に届いても `requireUser` が 403)。凍結が解ければ (一時 BAN の期限・運営の解除) `/account/billing` で取り消せる (期間末より前なら) |

---

## 5. 相 3 構造裁定 (1 回だけ)

### 5.1 代替案の比較

| 案 | 内容 | 利点 | 欠点 | 判定 |
|---|---|---|---|---|
| A (採用) | イベントを合図として扱い、Stripe から取り直して `fetched_at` で単調に写す。写像は DB 関数 1 本 | 順序・再送・重複・同時処理が 1 規則で閉じる。Checkout 戻り・解約 API・配線のジョブ・reconcile が同じ関数を使う。イベントの payload の形 (API 版) に依存しない | イベント 1 件につき Stripe API 1 回 (数百 ms)。Stripe が落ちていると処理が失敗して再送待ちになる (それでも DB は壊れない) | 採用 |
| B | `05` §4.2 のとおりイベントごとにハンドラを書き、`data.object` の値で列を更新する | API 呼び出しが要らない | `invoice.paid` と `subscription.updated` の順序で結果が変わる。`event.created` は秒精度で同秒の順序が決められない。ハンドラごとの列の責任が重なり (period は invoice から、status は subscription から)、表が閉じない。payload の形が API 版 (acacia / basil) で変わる | 不採用 |
| C | Stripe SDK (`stripe` npm) を入れ `constructEventAsync` と型を使う | 署名検証と型が手に入る | 依存を 1 つ増やす。既存は REST (fetch) 方針 (F1)。SDK の型は API 版と結び付き、版の固定を SDK の更新が壊す。設計書の正典コードが型検査できなくなる (リポジトリに無いモジュール) | 不採用。署名検証は Svix と同じ 20 行 (§8.3)、API は fetch + form-encode (§8.4) |
| D | `personal_subscriptions` を Stripe の写しにせず、DB を正本にして Stripe へ push する | 05 の「DB が source of truth」に文面どおり | 課金の実行 (再試行・期間・解約の実行) は Stripe が持つ以上、DB が先に動くと二重の真実になる。解約予約・支払失敗は Stripe でしか起きない | 不採用。「DB が正本」は手動付与 (`stripe_subscription_id IS NULL`) の行にだけ当てはめる |

### 5.2 「縁の発生源を消すより単純な構造は無いか」

- **メール**: 支払失敗・試用終了・領収書の案内は Stripe の顧客向けメール (Dashboard の Customer emails) に任せ、核はアプリのメールを 1 通も送らない。送ると `tests/email-send-throttle-contract.test.ts` の除外・テンプレート・宛先停止リストとの整合が増える。ブランドのメールが要るなら配線で足す。
- **試用の終了処理**: `04` §5.2 の日次ジョブ (試用終了 → `subscription.create`) は要らない。Checkout の `trial_period_days` と `payment_method_collection=always` で、Stripe が試用終了時に請求し `updated` を送る。
- **Checkout の記録表**: `billing_checkout_sessions` は作らない。所有の確認は `client_reference_id`、プランは `metadata` で足りる。
- **カスタム API 版のハンドラ**: 写し (`personal_subscriptions` ほか) を決めるためにイベントの payload から使うのは `id / type / created / livemode / data.object.id` と、`invoice` の `subscription` (acacia) か `parent.subscription_details.subscription` (basil) だけ。あとは取り直す。ほかに使うのは、`invoice.payment_failed` の監査 `system.payment.failed` の `details` に入れる請求の `id`・`attempt_count`・`amount_due` (写しには書かない。§8.2・§8.6) と、DB に残すイベントの記録の許可リストの項目 (下の最小化した写し) だけ。DB に残すイベントの記録も同じ考えで最小化した写しだけにする (`minimizeStripeEventPayload`。氏名・メールを DB に持たないので、退会で伏せる処理が要らない)。
- **楽観的ロック (`If-Unmodified-Since`)**: 解約・取り消しの API には付けない。行は写しで、正本は Stripe。API は冪等 (すでに予約済みなら同じ結果を返す) で、DB 側は advisory lock で直列化する。`cross/02` §6.2 の表にロックキーの行を足す (§16.2)。
- **SYSTEM ユーザー**: `'00000000-…'` の actor は作らない。system の監査行は `actor_id = NULL` (F14)。

### 5.3 確定した構造

§4.1 の構造を確定する。以後、構造への疑義は「裁定への差し戻し事由」として扱い、仕上げの指摘 (blocking) とは分ける。

- 決めたこと: Stripe は REST (fetch) / 写像は DB 関数 1 本 / 鮮度は `fetched_at` / 冪等は `event.id` の claim / クーポンは Stripe のプロモーションコード / メールは Stripe の顧客向けメール / 家族プランは代表者が買い写像が同期 / 退会は Stripe を解約して顧客を匿名化 / 権利判定の入口は既存のまま。
- 配線へ渡す境界 (§12): `grace` への進行・30 日の解約・reconcile・手動付与・Finance 画面・メール・チャージバック・`paused`。

---

## 6. データモデル (migration)

### 6.1 ファイル

| ファイル | 内容 |
|---|---|
| `supabase/migrations/<番号はマージ時に確定>_billing_core.sql` | §6.2〜§6.5 の全部 (1 本) |
| `supabase/rollbacks/<番号はマージ時に確定>_billing_core.down.sql` | §6.6 |

番号はマージ直前に `origin/main` の `supabase/migrations` の最大 (2026-10-15 時点 `20261015170000_accept_copies_profile_name.sql`) より大きい値で確定する。適用後に `src/types/database.types.ts` と `packages/shared/src/database.types.ts` を作り直す (`tests/database-types-migrations-contract.test.ts` の冒頭の手順。段 A)。

migration の冒頭コメントには、#1175 の migration と同じく「帰属の記載 (『オーナー判断』など) を書かない」。方針は「billing/01 で定めた」とだけ書く。

### 6.2 `personal_subscriptions` の変更

```sql
-- migration: <番号はマージ時に確定>_billing_core.sql (前半)
-- billing/01 (課金の核): personal_subscriptions を Stripe の Subscription の写しとして使えるようにする。
-- 本番の personal_subscriptions は 0 行 (2026-10-15 読み取り)。既存の行の書き換え (UPDATE / DELETE) は無い。

SET LOCAL lock_timeout = '10s';

-- (1) 列を足す (すべて NULL 可か既定値つき。行の書き換えは起きない)
ALTER TABLE public.personal_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_synced_at       timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_status          varchar(30),
  ADD COLUMN IF NOT EXISTS cancel_at_period_end   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_interval       varchar(10);

COMMENT ON COLUMN public.personal_subscriptions.stripe_synced_at IS
  'Stripe から Subscription を取り直した時刻 (billing_apply_stripe_subscription の p_fetched_at)。これより古い取り直しの結果は適用しない (単調)。手動付与の行は NULL';
COMMENT ON COLUMN public.personal_subscriptions.stripe_status IS
  'Stripe の Subscription.status の素の値 (incomplete / incomplete_expired / trialing / active / past_due / canceled / unpaid / paused)。status はこれを写像したもの';
COMMENT ON COLUMN public.personal_subscriptions.cancel_at_period_end IS
  'Stripe の cancel_at_period_end。true なら current_period_end で解約される (status は変わらない)';
COMMENT ON COLUMN public.personal_subscriptions.billing_interval IS
  'month / year。items[0].price.recurring.interval';

ALTER TABLE public.personal_subscriptions
  DROP CONSTRAINT IF EXISTS personal_subscriptions_billing_interval_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_billing_interval_check
  CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year'));

-- (2) status に incomplete を足す (Stripe の incomplete。live ではない)。
--     本番は 0 行なので違反する行は無い。既存の値はそのまま。
ALTER TABLE public.personal_subscriptions
  DROP CONSTRAINT IF EXISTS personal_subscriptions_status_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_status_check
  CHECK (status IN ('incomplete', 'trialing', 'active', 'paused', 'cancelled', 'expired', 'past_due', 'grace'));

-- (3) updated_at を自動で進める (本番にトリガーが無い。関数 update_updated_at_column は baseline にある)
DROP TRIGGER IF EXISTS personal_subscriptions_set_updated_at ON public.personal_subscriptions;
CREATE TRIGGER personal_subscriptions_set_updated_at
  BEFORE UPDATE ON public.personal_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- (4) RLS: 利用者本人の INSERT / UPDATE を外す (F6)。SELECT (本人 + admin/super_admin/finance/support) と DELETE 禁止はそのまま。
--     admin / super_admin の直接の書き込みは従来どおり残す (手動付与の画面は配線の冊)。
DROP POLICY IF EXISTS personal_subscriptions_insert ON public.personal_subscriptions;
DROP POLICY IF EXISTS personal_subscriptions_update ON public.personal_subscriptions;
CREATE POLICY personal_subscriptions_insert_admin ON public.personal_subscriptions
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles));
CREATE POLICY personal_subscriptions_update_admin ON public.personal_subscriptions
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles));
-- anon は読む必要も書く必要も無い (baseline は GRANT ALL を anon にも付けていた)
REVOKE INSERT, UPDATE, DELETE ON public.personal_subscriptions FROM anon;
```

### 6.3 `billing_customers` (新設) と `stripe_webhook_events` の変更

```sql
-- migration: <番号はマージ時に確定>_billing_core.sql (中盤)

-- (5) 利用者と Stripe Customer の対応表。1 利用者 = 1 顧客。退会では user_id が SET NULL になり、anonymized_at が入った行が残る
--     (Stripe 側の顧客も氏名・メールを消して残す。billing/01 §11)。auth.users を指す外部キーは NO ACTION にしない
--     (tests/integration/security/auth-users-fk-on-delete.test.ts A)。
CREATE TABLE IF NOT EXISTS public.billing_customers (
  stripe_customer_id  varchar(255) PRIMARY KEY,
  user_id             uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  anonymized_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.billing_customers IS
  '利用者と Stripe Customer (cus_) の対応。service_role だけが読み書きする (RLS は全部拒否)。退会で user_id は NULL になり、anonymized_at が入る。本人のデータの書き出しには出さない (src/lib/account-export-tables.ts の ACCOUNT_EXPORT_EXCLUDED)';
DROP TRIGGER IF EXISTS billing_customers_set_updated_at ON public.billing_customers;
CREATE TRIGGER billing_customers_set_updated_at
  BEFORE UPDATE ON public.billing_customers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_customers_no_access ON public.billing_customers;
CREATE POLICY billing_customers_no_access ON public.billing_customers USING (false) WITH CHECK (false);
REVOKE ALL ON public.billing_customers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.billing_customers TO service_role;

-- (6) stripe_webhook_events: 権利を取った時刻と回数 (billing_claim_stripe_event が使う)
ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count         integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.stripe_webhook_events.processing_started_at IS
  '最後に処理の権利を取った時刻。processing のままこれが古い行は、次の再送で再び権利を取れる (billing_claim_stripe_event の p_stuck_after)';
COMMENT ON COLUMN public.stripe_webhook_events.attempt_count IS '権利を取った回数 (初回 1)';
-- payload に残すのはイベントの最小化した写しだけ (TS の minimizeStripeEventPayload。billing/01 §8.1・§9.6)。
-- 氏名・メールアドレス・住所 (customer_email / customer_name / customer_details など) を DB に残さない (退会の匿名化 #1562 と同じ扱い)。
-- 本番は 0 行 (2026-10-15 読み取り。§2.2 F7) なので、既存の行の書き換えは無い
COMMENT ON COLUMN public.stripe_webhook_events.payload IS
  'Stripe のイベントの最小化した写し (id / type / created / livemode と data.object の許可リストの項目だけ。billing/01 §8.1 minimizeStripeEventPayload)。氏名・メールアドレス・住所を持たない';
```

### 6.4 DB 関数 (3 本。EXECUTE は service_role だけ)・家族のトリガー・特権列ガード

```sql
-- migration: <番号はマージ時に確定>_billing_core.sql (後半)

-- (7) Webhook の冪等キー (event.id) で処理の権利を取る。
--     戻り値: 'claimed' (この呼び出しが処理する) / 'completed' (処理済み。受け口は 200) /
--             'in_progress' (ほかが processing 中で p_stuck_after 以内。受け口は 409 を返し、Stripe に再送させる)。
--     pending / failed の行、または processing のまま p_stuck_after より古い行は、再び権利を取れる (= 再処理)。
--     p_stuck_after の既定 15 分は Vercel の関数の最長 (maxDuration) を十分に超える値 (operator/05 §8.3 と同じ値)。
CREATE OR REPLACE FUNCTION public.billing_claim_stripe_event(
  p_event_id    text,
  p_event_type  text,
  p_payload     jsonb,
  p_stuck_after interval DEFAULT interval '15 minutes'
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id     text;
  v_status text;
BEGIN
  IF p_event_id IS NULL OR p_event_id = '' OR p_event_type IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'billing_claim_stripe_event: p_event_id / p_event_type / p_payload are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.stripe_webhook_events (id, event_type, payload, processing_status, processing_started_at, attempt_count)
  VALUES (p_event_id, p_event_type, p_payload, 'processing', now(), 1)
  ON CONFLICT (id) DO UPDATE
     SET processing_status      = 'processing',
         processing_started_at  = now(),
         error_message          = NULL,
         attempt_count          = public.stripe_webhook_events.attempt_count + 1
   WHERE public.stripe_webhook_events.processing_status IN ('pending', 'failed')
      OR (public.stripe_webhook_events.processing_status = 'processing'
          AND COALESCE(public.stripe_webhook_events.processing_started_at, public.stripe_webhook_events.received_at)
              < now() - p_stuck_after)
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN 'claimed';
  END IF;
  -- 権利を取れなかった: 処理済みか、ほかが処理中か (ON CONFLICT DO UPDATE は WHERE が偽でも行をロックしているので、いまの値が読める)
  SELECT e.processing_status INTO v_status FROM public.stripe_webhook_events AS e WHERE e.id = p_event_id;
  RETURN CASE WHEN v_status = 'completed' THEN 'completed' ELSE 'in_progress' END;
END
$$;
REVOKE ALL ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) TO service_role;
COMMENT ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) IS
  'billing/01 §6.4: Stripe Webhook の event.id で処理の権利を取る (claimed / completed / in_progress)。failed と古い processing は再処理できる';

-- (8) 処理の結果を記録する。p_error には固定のコード (BILL_… / EXT_…) だけを渡す (生のエラー文・秘密は渡さない)。
CREATE OR REPLACE FUNCTION public.billing_finish_stripe_event(
  p_event_id text,
  p_ok       boolean,
  p_error    text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stripe_webhook_events
     SET processing_status = CASE WHEN p_ok THEN 'completed' ELSE 'failed' END,
         processed_at      = CASE WHEN p_ok THEN now() ELSE processed_at END,
         error_message     = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
   WHERE id = p_event_id;
END
$$;
REVOKE ALL ON FUNCTION public.billing_finish_stripe_event(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_finish_stripe_event(text, boolean, text) TO service_role;
COMMENT ON FUNCTION public.billing_finish_stripe_event(text, boolean, text) IS
  'billing/01 §6.4: Stripe Webhook の処理の結果 (completed / failed) を記録する';

-- (9) Stripe の Subscription の写像 (本冊の中心)。
--     p_snapshot は billing/01 §8.1 の SubscriptionSnapshot (TS が Stripe の最新のオブジェクトから作る)。
--     p_fetched_at は Stripe から取り直した時刻。既存の行の stripe_synced_at がこれ以上なら何もしない (stale)。
--     p_source は 'webhook:<event.id>' / 'checkout_sync' / 'api:cancel' / 'api:resume' / 'wiring:<job>' のような出どころ (監査の details に残す)。
--     戻り値 (jsonb): applied のとき { applied: true, subscription_id, user_id, status_from, status_to, plan_key } /
--                     古い取り直しのとき { applied: false, skipped: 'stale', subscription_id, user_id } (user_id は必ず入る。
--                     invoice.payment_failed の監査が使う。billing/01 §8.6) /
--                     退会済みのとき { applied: false, skipped: 'user_deleted', customer_closed } (customer_closed = この契約の顧客の
--                     対応表の行が「利用者が消えた」(user_id IS NULL) か。true なら TS が Stripe の契約を即時解約する。billing/01 §8.6 syncSubscription・§11)
--     既存の行は「3.」で FOR NO KEY UPDATE でロックしてから読む。配線の直接の UPDATE (past_due → grace・paused。§12) と
--     行ロックで直列になり、commit 済みの grace / paused を読んで保持の規則に掛ける (ロックせずに読むと、その UPDATE を巻き戻す)。
--     ロックの順 (billing/01 §7.1): advisory 2 本 → 契約の行 → family_groups の行 → user_profiles の行。family_groups → user_profiles は
--     家族の関数の LOCK-ORDER (#1310。リポジトリの CLAUDE.md「家族 (family_*) を変える関数のロック順」) と同じ向き。
--     逆 (user_profiles → family_groups) にすると、運営の強制解散・代表者の家族の削除 (family_groups → user_profiles) とデッドロックする。
--     業務エラー (RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001', DETAIL = <補足>): BILL_UNKNOWN_USER / BILL_UNKNOWN_PLAN /
--     BILL_UNKNOWN_STRIPE_STATUS / BILL_LIVE_ROW_CONFLICT。引数の不足は 22023。
CREATE OR REPLACE FUNCTION public.billing_apply_stripe_subscription(
  p_snapshot   jsonb,
  p_fetched_at timestamptz,
  p_source     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub_id           text := p_snapshot->>'stripe_subscription_id';
  v_customer_id      text := p_snapshot->>'stripe_customer_id';
  v_user_id          uuid := NULLIF(p_snapshot->>'user_id', '')::uuid;
  v_plan_key         text := NULLIF(p_snapshot->>'plan_key', '');
  v_stripe_status    text := p_snapshot->>'stripe_status';
  v_pause            boolean := COALESCE((p_snapshot->>'pause_collection')::boolean, false);
  v_existing         public.personal_subscriptions%ROWTYPE;
  v_plan             public.subscription_plans%ROWTYPE;
  v_status           text;
  v_live             boolean;
  v_row_id           uuid;
  v_status_from      text;
  v_other_live       uuid;
  v_cancelled_at     timestamptz;
  v_past_due_since   timestamptz;
  v_grace_started_at timestamptz;
  v_member_limit     integer;
  v_customer_anonymized_at timestamptz;
BEGIN
  IF v_sub_id IS NULL OR v_customer_id IS NULL OR v_stripe_status IS NULL OR p_fetched_at IS NULL OR p_source IS NULL THEN
    RAISE EXCEPTION 'billing_apply_stripe_subscription: snapshot / p_fetched_at / p_source are required' USING ERRCODE = '22023';
  END IF;

  -- 1. 利用者の解決: snapshot の user_id (Checkout の metadata) → 顧客の対応表 → 既存の行
  IF v_user_id IS NULL THEN
    SELECT c.user_id, c.anonymized_at INTO v_user_id, v_customer_anonymized_at
      FROM public.billing_customers AS c WHERE c.stripe_customer_id = v_customer_id;
    -- 退会で匿名化した顧客 (退会の段階 billing が anonymized_at を入れ、deleteUser の SET NULL で user_id が NULL)。
    -- metadata.user_id を持たない契約 (Dashboard で作った契約。S13) の退会後のイベントも、退会済みとして何もしない
    -- (契約の行は CASCADE で消えているので、ここで返さないと BILL_UNKNOWN_USER の 500 になり Stripe が 3 日再送する。S10)。
    -- user_id が NULL でも anonymized_at が無い行 (退会の手順を通らずに auth.users が消えた) は下の BILL_UNKNOWN_USER のまま (運営が拾う。§13.3)
    IF v_user_id IS NULL AND v_customer_anonymized_at IS NOT NULL THEN
      -- 対応表の行の user_id が NULL (利用者が消えた) なので customer_closed は true
      RETURN jsonb_build_object('applied', false, 'skipped', 'user_deleted', 'customer_closed', true);
    END IF;
  END IF;
  IF v_user_id IS NULL THEN
    SELECT s.user_id INTO v_user_id FROM public.personal_subscriptions AS s WHERE s.stripe_subscription_id = v_sub_id;
  END IF;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_USER' USING ERRCODE = 'P0001', DETAIL = v_sub_id;
  END IF;
  -- 退会済み (auth.users に無い) なら何も書かない。契約の行は CASCADE で消えている。
  -- customer_closed: この契約の顧客が当社の対応表にあり、その利用者が消えた (deleteUser の SET NULL で user_id IS NULL) か。
  -- true なら退会した利用者の顧客に残った契約 (退会の段階 billing_recheck のあと deleteUser までに完了した Checkout の契約など) なので、TS が Stripe で即時解約する
  -- (billing/01 §8.6 syncSubscription)。対応表に無い顧客 (同じ Stripe のテスト用アカウントを使う別の環境が作った契約など) は false で、何もしない
  IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = v_user_id) THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'user_deleted',
                              'customer_closed', EXISTS (
                                SELECT 1 FROM public.billing_customers AS c
                                 WHERE c.stripe_customer_id = v_customer_id AND c.user_id IS NULL));
  END IF;

  -- 2. ロック (利用者 → サブスクリプションの順。cross/02 §6.2 の命名)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || v_user_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('stripe-subscription:' || v_sub_id));

  -- 3. 既存の行と鮮度。行は FOR NO KEY UPDATE でロックしてから読む (apply_coupon と同じロックの強さ)。
  --    advisory lock は写像どうしを直列にするだけで、配線の直接の UPDATE (§12 の past_due → grace・paused) とは直列にならない。
  --    行ロックで待つので、相手が commit した grace / paused を読み、5. の保持の規則がそれを保つ (相手が後なら、相手の
  --    UPDATE の WHERE が写像の書いた行で評価し直される)。ロックの順は advisory 2 本 → 契約の行 → (10. で) family_groups の行 →
  --    user_profiles の行 (§7.1 の消費経路の行。family_groups を user_profiles より先に取る。冒頭の注)
  SELECT s.* INTO v_existing FROM public.personal_subscriptions AS s WHERE s.stripe_subscription_id = v_sub_id
     FOR NO KEY UPDATE;
  IF v_existing.id IS NOT NULL AND v_existing.stripe_synced_at IS NOT NULL AND v_existing.stripe_synced_at >= p_fetched_at THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'stale', 'subscription_id', v_existing.id, 'user_id', v_user_id);
  END IF;

  -- 4. プラン (既存の行の plan_key → snapshot の plan_key)。行の plan_key は行を作ったときに決まり、以後変わらない
  --    (既存の契約の Price を Stripe の Dashboard で付け替えても、プラン・plan_key_cached・家族のグループは変えない。
  --    付け替え先の Price が別のプラン (家族 ↔ 個人) でも、家族のグループの戻しが取り残されない。billing/01 §7.3)
  IF v_existing.id IS NOT NULL THEN
    v_plan_key := v_existing.plan_key;
  END IF;
  IF v_plan_key IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_PLAN' USING ERRCODE = 'P0001', DETAIL = v_sub_id;
  END IF;
  SELECT p.* INTO v_plan FROM public.subscription_plans AS p WHERE p.plan_key = v_plan_key;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_PLAN' USING ERRCODE = 'P0001', DETAIL = v_plan_key;
  END IF;

  -- 5. 状態の写像 (billing/01 §7.2 の表) と保持の規則
  v_status := CASE v_stripe_status
    WHEN 'incomplete'         THEN 'incomplete'
    WHEN 'incomplete_expired' THEN 'expired'
    WHEN 'trialing'           THEN 'trialing'
    WHEN 'active'             THEN 'active'
    WHEN 'past_due'           THEN 'past_due'
    WHEN 'unpaid'             THEN 'past_due'
    WHEN 'canceled'           THEN 'cancelled'
    WHEN 'paused'             THEN 'expired'
  END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_STRIPE_STATUS' USING ERRCODE = 'P0001', DETAIL = v_stripe_status;
  END IF;
  IF v_existing.id IS NOT NULL AND v_status = 'past_due' AND v_existing.status = 'grace' THEN
    v_status := 'grace';          -- grace は配線のジョブが past_due を進めたもの。Stripe が past_due/unpaid の間は保つ
  END IF;
  IF v_existing.id IS NOT NULL AND v_status = 'active' AND v_pause AND v_existing.status = 'paused' THEN
    v_status := 'paused';         -- 組織ライセンスの一時停止 (配線) は Stripe の pause_collection と対で保つ
  END IF;
  v_live := v_status IN ('trialing', 'active', 'paused', 'past_due', 'grace');

  -- 6. 同じ利用者の別の live 行 (別の Stripe の契約、または手動付与) があれば失敗させる (部分 UNIQUE の違反を先に名指しする)
  IF v_live THEN
    SELECT s.id INTO v_other_live
      FROM public.personal_subscriptions AS s
     WHERE s.user_id = v_user_id
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
       AND s.stripe_subscription_id IS DISTINCT FROM v_sub_id
     LIMIT 1;
    IF v_other_live IS NOT NULL THEN
      RAISE EXCEPTION 'BILL_LIVE_ROW_CONFLICT' USING ERRCODE = 'P0001', DETAIL = v_other_live::text;
    END IF;
  END IF;

  -- 7. 時刻の列の規則 (billing/01 §7.3)
  v_past_due_since   := CASE WHEN v_status IN ('past_due', 'grace') THEN COALESCE(v_existing.past_due_since, now()) ELSE NULL END;
  v_grace_started_at := CASE WHEN v_status = 'grace' THEN v_existing.grace_started_at ELSE NULL END;
  v_cancelled_at     := CASE WHEN v_status = 'cancelled'
                             THEN COALESCE((p_snapshot->>'ended_at')::timestamptz, (p_snapshot->>'canceled_at')::timestamptz,
                                           v_existing.cancelled_at, now())
                             ELSE NULL END;

  -- 8. upsert (stripe_subscription_id で 1 行)。行が無ければ status に関わらず INSERT する: 最初の写像が終端・非 live
  --    (cancelled / expired) でも履歴の行を作る (§7.3 の「– → cancelled / expired (INSERT)」の行。例: S12 の 2 本目を運営が解約した)
  IF v_existing.id IS NULL THEN
    INSERT INTO public.personal_subscriptions (
      user_id, plan_key, status, stripe_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, billing_interval,
      starts_at, current_period_start, current_period_end,
      trial_started_at, trial_ends_at, trial_source,
      cancel_at, cancel_at_period_end, cancelled_at, past_due_since, grace_started_at, stripe_synced_at
    ) VALUES (
      v_user_id, v_plan_key, v_status, v_stripe_status, v_customer_id, v_sub_id,
      NULLIF(p_snapshot->>'stripe_price_id', ''), NULLIF(p_snapshot->>'billing_interval', ''),
      COALESCE((p_snapshot->>'start_date')::timestamptz, now()),
      (p_snapshot->>'current_period_start')::timestamptz, (p_snapshot->>'current_period_end')::timestamptz,
      (p_snapshot->>'trial_start')::timestamptz, (p_snapshot->>'trial_end')::timestamptz,
      CASE WHEN p_snapshot->>'trial_start' IS NOT NULL THEN 'checkout' ELSE NULL END,
      (p_snapshot->>'cancel_at')::timestamptz, COALESCE((p_snapshot->>'cancel_at_period_end')::boolean, false),
      v_cancelled_at, v_past_due_since, v_grace_started_at, p_fetched_at
    ) RETURNING id INTO v_row_id;
    v_status_from := NULL;
  ELSE
    UPDATE public.personal_subscriptions
       SET plan_key             = v_plan_key,
           status               = v_status,
           stripe_status        = v_stripe_status,
           stripe_customer_id   = v_customer_id,
           stripe_price_id      = NULLIF(p_snapshot->>'stripe_price_id', ''),
           billing_interval     = NULLIF(p_snapshot->>'billing_interval', ''),
           current_period_start = (p_snapshot->>'current_period_start')::timestamptz,
           current_period_end   = (p_snapshot->>'current_period_end')::timestamptz,
           trial_started_at     = COALESCE((p_snapshot->>'trial_start')::timestamptz, trial_started_at),
           trial_ends_at        = COALESCE((p_snapshot->>'trial_end')::timestamptz, trial_ends_at),
           cancel_at            = (p_snapshot->>'cancel_at')::timestamptz,
           cancel_at_period_end = COALESCE((p_snapshot->>'cancel_at_period_end')::boolean, false),
           cancelled_at         = v_cancelled_at,
           past_due_since       = v_past_due_since,
           grace_started_at     = v_grace_started_at,
           stripe_synced_at     = p_fetched_at
     WHERE id = v_existing.id;
    v_row_id := v_existing.id;
    v_status_from := v_existing.status;
  END IF;

  -- 9. 顧客の対応表 (Dashboard で作られた契約など、まだ無ければ足す。どちらかの UNIQUE に当たれば何もしない)
  INSERT INTO public.billing_customers (stripe_customer_id, user_id) VALUES (v_customer_id, v_user_id)
  ON CONFLICT DO NOTHING;

  -- 10. 家族プランのグループへの反映と、個人契約のキャッシュ (live な行が無ければ NULL = free)。
  --     **family_groups の UPDATE を user_profiles の UPDATE より先に流す** (ロックの順 = family_groups の行 → user_profiles の行。
  --     家族の関数の LOCK-ORDER #1310 と同じ向き)。逆の順だと、写像が user_profiles (代表者) を持ったまま family_groups を待ち、
  --     運営の強制解散 (operator_force_dissolve_family: family_groups → user_profiles WHERE family_id) や代表者の家族の削除
  --     (DELETE family_groups → user_profiles.family_id の ON DELETE SET NULL) が family_groups を持ったまま user_profiles (代表者) を
  --     待って 40P01 になる (§7.1 の family の関数の行・テスト 106)。
  --     グループはいまの代表者 = v_user_id のものだけ。代表者が交代したときの付け替えは (10) のトリガーが受け持つ。
  --     WHERE に当たらない (プランと上限が同じ・グループが無い・代表者でない) ときは family_groups の行をロックしない
  IF v_plan.plan_type = 'family' THEN
    -- member_limit の CHECK は 1〜20 (family_groups_member_limit_check)。max_members が無いプランは既定の 4 (DDL の既定値と同じ)
    v_member_limit := LEAST(COALESCE(v_plan.max_members, 4), 20);
    IF v_live THEN
      UPDATE public.family_groups AS g
         SET plan_key = v_plan_key, member_limit = v_member_limit
       WHERE g.representative_id = v_user_id AND g.status = 'active'
         AND (g.plan_key IS DISTINCT FROM v_plan_key OR g.member_limit IS DISTINCT FROM v_member_limit);
    ELSE
      -- 同じ利用者に同じプランの live な行が残っている (例: 未完了 (incomplete) の 1 本目が期限切れになったが、2 本目が live) なら戻さない
      UPDATE public.family_groups AS g
         SET plan_key = 'free', member_limit = 4
       WHERE g.representative_id = v_user_id AND g.status = 'active' AND g.plan_key = v_plan_key
         AND NOT EXISTS (
           SELECT 1 FROM public.personal_subscriptions AS s
            WHERE s.user_id = v_user_id AND s.plan_key = v_plan_key
              AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'));
    END IF;
  END IF;
  UPDATE public.user_profiles AS p
     SET plan_key_cached = (
       SELECT s.plan_key FROM public.personal_subscriptions AS s
        WHERE s.user_id = v_user_id AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
        ORDER BY s.created_at DESC, s.id LIMIT 1)
   WHERE p.id = v_user_id;

  -- 11. 監査 (状態が変わったときだけ。actor_id は NULL = system。target は利用者)
  IF v_status_from IS DISTINCT FROM v_status THEN
    INSERT INTO public.admin_audit_logs (actor_id, action_type, target_id, target_type, severity, details)
    VALUES (
      NULL,
      CASE WHEN v_status_from IS NULL THEN 'system.billing.subscription_created' ELSE 'system.billing.subscription_status_changed' END,
      v_user_id, 'user',
      CASE WHEN v_status IN ('past_due', 'grace') THEN 'warn' ELSE 'info' END,
      jsonb_build_object('stripe_subscription_id', v_sub_id, 'plan_key', v_plan_key, 'from', v_status_from, 'to', v_status,
                         'stripe_status', v_stripe_status, 'source', p_source)
    );
  END IF;

  RETURN jsonb_build_object('applied', true, 'subscription_id', v_row_id, 'user_id', v_user_id,
                            'status_from', v_status_from, 'status_to', v_status, 'plan_key', v_plan_key);
END
$$;
REVOKE ALL ON FUNCTION public.billing_apply_stripe_subscription(jsonb, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_apply_stripe_subscription(jsonb, timestamptz, text) TO service_role;
COMMENT ON FUNCTION public.billing_apply_stripe_subscription(jsonb, timestamptz, text) IS
  'billing/01 §6.4: Stripe の Subscription の最新の姿 (snapshot) を personal_subscriptions に写す唯一の入口。p_fetched_at で単調。plan_key_cached と family_groups.plan_key も同期する';

-- (10) 家族グループを作ったとき・代表者が変わったときに、グループのプランを代表者の契約に合わせる (billing/01 §7.3・S18・S20)。
--      不変条件: active なグループの plan_key は「いまの代表者の live な家族プラン (plan_type='family') の契約」のプラン。
--      代表者を変えるのは family の DB 関数 2 本 (operator_force_representative_transfer / accept_family_representative_transfer)、
--      グループを作るのは create_family_group。どの関数も変えず、family_groups の BEFORE INSERT / BEFORE UPDATE OF representative_id で
--      合わせる (今後ほかの経路が増えても同じ規則になる)。
--      - 代表者に live な家族プランの契約がある → そのプランと上限。
--      - INSERT で契約が無い → plan_key = 'free' (create_family_group の p_plan_key は使わない。利用者が課金なしで家族プランを
--        名乗れる穴 (F23) を閉じる)。member_limit は呼び出し側の値 (既定 4) のまま。INSERT は呼び出し元を問わない
--        (service_role の直接の INSERT も同じ)。契約なしで家族プランのグループが要るとき (運営の手動・結合テスト) は、
--        INSERT のあとに service_role で plan_key を UPDATE する (UPDATE OF plan_key はこのトリガーに当たらない。§16.1)。
--      - UPDATE で契約が無い → グループのプランが旧代表者の契約から来たもの (旧代表者に同じ plan_key の live な行がある) のときだけ
--        free / 4 に戻す (ほかの経路 = service_role の直接の UPDATE で入ったプランは触らない)。
--      名前は trg_guard_family_groups_privileged より前に並ぶ (同じ BEFORE UPDATE は名前の順に動く)。authenticated / anon が
--      representative_id を直接変えた UPDATE は、そのあとのガードが 42501 で止めるので、ここで NEW を変えても書かれない。
CREATE OR REPLACE FUNCTION public.billing_family_plan_follow_representative() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_plan     public.subscription_plans%ROWTYPE;
  v_old_is_owner boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.representative_id IS NOT DISTINCT FROM OLD.representative_id THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  -- 新しい代表者の写像 (9) と直列にする (写像と同じ鍵 billing-user:<uuid>)。取らないと、代表者の購入・解約の写像が commit する前の
  -- 契約を読み、写像の側の family_groups の UPDATE (WHERE representative_id = 新しい代表者) は交代・作成の commit 前の行に当たらず、
  -- グループのプランが契約と食い違ったまま残る。旧代表者の鍵は取らない (旧代表者の写像は WHERE representative_id = 旧代表者 で
  -- この行のロックを待つので、ここで旧代表者の鍵を待つと循環する)。旧代表者の契約は下でロックなしで読む (§7.1 の family の行)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || NEW.representative_id::text));
  SELECT p.* INTO v_new_plan
    FROM public.personal_subscriptions AS s
    JOIN public.subscription_plans AS p ON p.plan_key = s.plan_key
   WHERE s.user_id = NEW.representative_id
     AND p.plan_type = 'family'
     AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
   ORDER BY s.created_at DESC, s.id
   LIMIT 1;
  IF v_new_plan.id IS NOT NULL THEN
    NEW.plan_key     := v_new_plan.plan_key;
    -- 写像 (9) の 10. と同じ: member_limit の CHECK は 1〜20。max_members が無いプランは DDL の既定値 4
    NEW.member_limit := LEAST(COALESCE(v_new_plan.max_members, 4), 20);
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.plan_key := 'free';
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.personal_subscriptions AS s
     WHERE s.user_id = OLD.representative_id AND s.plan_key = OLD.plan_key
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
  ) INTO v_old_is_owner;
  IF v_old_is_owner THEN
    NEW.plan_key     := 'free';
    NEW.member_limit := 4;   -- family_groups.member_limit の DDL の既定値 (写像 (9) の 10. の戻しと同じ)
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.billing_family_plan_follow_representative() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.billing_family_plan_follow_representative() IS
  'billing/01 §6.4 (10): family_groups の作成と代表者の交代で、plan_key / member_limit を代表者の live な家族プランの契約に合わせる (作成で契約が無ければ free)';
DROP TRIGGER IF EXISTS family_groups_billing_plan_follow_representative ON public.family_groups;
CREATE TRIGGER family_groups_billing_plan_follow_representative
  BEFORE INSERT OR UPDATE OF representative_id ON public.family_groups
  FOR EACH ROW EXECUTE FUNCTION public.billing_family_plan_follow_representative();

-- (11) 特権列ガード 2 本に plan_key_cached を足す (本人が自分の契約の写しを書けないように。F21)。
--      土台は 20261008200700_legal_documents_acceptance.sql の定義 (最新)。足すのは plan_key_cached の 1 行ずつだけで、ほかは逐語。
--      写像 (9) は SECURITY DEFINER (所有者 postgres) なので current_user が authenticated / anon にならず、ガードに当たらない。
CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.roles            IS DISTINCT FROM OLD.roles
       OR NEW.org_role         IS DISTINCT FROM OLD.org_role
       OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
       OR NEW.family_id        IS DISTINCT FROM OLD.family_id
       OR NEW.is_active_in_org IS DISTINCT FROM OLD.is_active_in_org
       OR NEW.joined_org_at    IS DISTINCT FROM OLD.joined_org_at
       OR NEW.frozen_at        IS DISTINCT FROM OLD.frozen_at
       OR NEW.frozen_by        IS DISTINCT FROM OLD.frozen_by
       OR NEW.frozen_reason    IS DISTINCT FROM OLD.frozen_reason
       OR NEW.unban_at         IS DISTINCT FROM OLD.unban_at
       OR NEW.department_id    IS DISTINCT FROM OLD.department_id
       OR NEW.terms_version_accepted   IS DISTINCT FROM OLD.terms_version_accepted
       OR NEW.privacy_version_accepted IS DISTINCT FROM OLD.privacy_version_accepted
       OR NEW.legal_accepted_at        IS DISTINCT FROM OLD.legal_accepted_at
       OR NEW.plan_key_cached          IS DISTINCT FROM OLD.plan_key_cached THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF (NEW.roles IS NOT NULL AND NEW.roles IS DISTINCT FROM ARRAY['user']::text[])
       OR NEW.org_role         IS NOT NULL
       OR NEW.organization_id  IS NOT NULL
       OR NEW.family_id        IS NOT NULL
       OR NEW.is_active_in_org IS DISTINCT FROM false
       OR NEW.joined_org_at    IS NOT NULL
       OR NEW.frozen_at        IS NOT NULL
       OR NEW.frozen_by        IS NOT NULL
       OR NEW.frozen_reason    IS NOT NULL
       OR NEW.unban_at         IS NOT NULL
       OR NEW.department_id    IS NOT NULL
       OR NEW.terms_version_accepted   IS NOT NULL
       OR NEW.privacy_version_accepted IS NOT NULL
       OR NEW.legal_accepted_at        IS NOT NULL
       OR NEW.plan_key_cached          IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON COLUMN public.user_profiles.plan_key_cached IS
  '個人契約の plan_key の写し (live な行が無ければ NULL = free)。billing_apply_stripe_subscription だけが書く。本人は直接変更できない (guard_user_profiles_privileged)。billing/01';
```

### 6.5 migration が触らないもの

`get_effective_plan`・`apply_coupon`・`subscription_plans`・`coupon_redemptions`・`idx_personal_subscriptions_active_per_user` (`incomplete` は述語に入らないので変えない)・`personal_subscriptions_select` / `_no_delete` ポリシー・`stripe_webhook_no_access_rls`・family の DB 関数 (`create_family_group`・`operator_force_representative_transfer` / `accept_family_representative_transfer` ほか。グループの作成と代表者の交代は (10) のトリガーが受ける)・`guard_family_groups_privileged`・`user_profiles` の RLS ポリシーと列の権限 (`plan_key_cached` は (11) のガードで守る)。

触る既存の定義は 2 つだけ: `guard_user_profiles_privileged` と `guard_user_profiles_privileged_on_insert` を `20261008200700` の定義を土台に CREATE OR REPLACE する ((11)。`plan_key_cached` を 1 行ずつ足すだけ)。

**`supabase/baseline/` は凍結 (本冊では触らない)。** origin/main の `supabase/baseline/` は本番の読み取り専用のスナップショット (`manifest.json` の `captured_at` 2026-10-07・`ledger_max_version` `20261007112200`・各ファイルの sha256) で、本冊が消すポリシー `personal_subscriptions_insert` / `_update` (`catalog/catalog_policies.csv`)・置き換える `guard_user_profiles_privileged(_on_insert)` (`catalog/catalog_functions.csv`・`prod_function_acl.sql`)・課金の表の DDL (`prod_schema.sql`) を取得時点の本番のまま持つ。これを本冊の migration に合わせて書き換えない。理由:
- ローカル / CI の DB は「ベースライン + `ledger_max_version` より新しい migration」で組み立てる (`scripts/supabase-local.sh` の `baseline_version` と 1) 2) の手順・`tests/helpers/schema-snapshot.ts:221-228`)。本冊の migration は番号が `20261007112200` より大きいので必ずベースラインの上に積まれ、消すポリシー・置き換える関数はベースライン (と `20261008200700`) が作った実物に当たる (`DROP POLICY IF EXISTS`・`CREATE OR REPLACE`)。ベースラインの側を先に直す必要は無い。
- ベースラインは本番の写しで、`README.md` の「取り直し方」(`refresh-request.txt` → `prod-schema-snapshot.yml` → `build_baseline.py` → `verify`) でしか作らない。手で直すと `manifest.json` の sha256 と `verify` (本番カタログとの比較) が合わなくなる。
- 本番に本冊の migration を適用した後のベースラインの取り直しは本冊の段に入れない (取り直すまでは本冊の migration がローカルで「新しい migration」として積まれ続け、結果は同じ。`README.md`)。
- `.github/workflows/e2e-local.yml` は `supabase/migrations/**` を paths に持つので、段 A の PR はベースラインを触らなくても e2e-local が走り、ベースライン + 本冊の migration でローカルの Supabase が起動する (`e2e-local.yml:29-30, 60`)。§14.2 の結合テストも同じ組み立ての DB で動く。

### 6.6 ロールバック

```sql
-- supabase/rollbacks/<番号はマージ時に確定>_billing_core.down.sql
-- 先に Web のデプロイを戻すこと (新しい Web はこの関数と列を呼ぶ)。
-- 消えるもの: billing_customers の全行、追加した列の値 (stripe_synced_at / stripe_status / cancel_at_period_end / billing_interval /
--             processing_started_at / attempt_count)。status が incomplete の行は expired にしてから CHECK を戻す。
-- 戻すもの: 特権列ガード 2 本を 20261008200700_legal_documents_acceptance.sql の定義に (plan_key_cached を外す)・
--           plan_key_cached の列コメントを baseline の文に・stripe_webhook_events.payload の列コメントを外す (baseline に無い)。
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS family_groups_billing_plan_follow_representative ON public.family_groups;
DROP FUNCTION IF EXISTS public.billing_family_plan_follow_representative();

-- 20261008200700_legal_documents_acceptance.sql:77-129 の定義をそのまま戻す
CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.roles            IS DISTINCT FROM OLD.roles
       OR NEW.org_role         IS DISTINCT FROM OLD.org_role
       OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
       OR NEW.family_id        IS DISTINCT FROM OLD.family_id
       OR NEW.is_active_in_org IS DISTINCT FROM OLD.is_active_in_org
       OR NEW.joined_org_at    IS DISTINCT FROM OLD.joined_org_at
       OR NEW.frozen_at        IS DISTINCT FROM OLD.frozen_at
       OR NEW.frozen_by        IS DISTINCT FROM OLD.frozen_by
       OR NEW.frozen_reason    IS DISTINCT FROM OLD.frozen_reason
       OR NEW.unban_at         IS DISTINCT FROM OLD.unban_at
       OR NEW.department_id    IS DISTINCT FROM OLD.department_id
       OR NEW.terms_version_accepted   IS DISTINCT FROM OLD.terms_version_accepted
       OR NEW.privacy_version_accepted IS DISTINCT FROM OLD.privacy_version_accepted
       OR NEW.legal_accepted_at        IS DISTINCT FROM OLD.legal_accepted_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF (NEW.roles IS NOT NULL AND NEW.roles IS DISTINCT FROM ARRAY['user']::text[])
       OR NEW.org_role         IS NOT NULL
       OR NEW.organization_id  IS NOT NULL
       OR NEW.family_id        IS NOT NULL
       OR NEW.is_active_in_org IS DISTINCT FROM false
       OR NEW.joined_org_at    IS NOT NULL
       OR NEW.frozen_at        IS NOT NULL
       OR NEW.frozen_by        IS NOT NULL
       OR NEW.frozen_reason    IS NOT NULL
       OR NEW.unban_at         IS NOT NULL
       OR NEW.department_id    IS NOT NULL
       OR NEW.terms_version_accepted   IS NOT NULL
       OR NEW.privacy_version_accepted IS NOT NULL
       OR NEW.legal_accepted_at        IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- baseline (20251126124224) の文
COMMENT ON COLUMN public.user_profiles.plan_key_cached IS 'personal_subscriptions の現在有効な plan_key キャッシュ (Edge Function が同期、常に最新とは限らない)';

DROP FUNCTION IF EXISTS public.billing_apply_stripe_subscription(jsonb, timestamptz, text);
DROP FUNCTION IF EXISTS public.billing_finish_stripe_event(text, boolean, text);
DROP FUNCTION IF EXISTS public.billing_claim_stripe_event(text, text, jsonb, interval);

DROP TABLE IF EXISTS public.billing_customers;

ALTER TABLE public.stripe_webhook_events
  DROP COLUMN IF EXISTS processing_started_at,
  DROP COLUMN IF EXISTS attempt_count;
-- baseline (20251126124224) では payload に列コメントが無い
COMMENT ON COLUMN public.stripe_webhook_events.payload IS NULL;

DROP POLICY IF EXISTS personal_subscriptions_insert_admin ON public.personal_subscriptions;
DROP POLICY IF EXISTS personal_subscriptions_update_admin ON public.personal_subscriptions;
-- baseline (20251126124224) のポリシーをそのまま戻す
CREATE POLICY personal_subscriptions_insert ON public.personal_subscriptions
  FOR INSERT WITH CHECK ((user_id = auth.uid()) OR (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)));
CREATE POLICY personal_subscriptions_update ON public.personal_subscriptions
  FOR UPDATE USING ((user_id = auth.uid()) OR (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)));
GRANT INSERT, UPDATE, DELETE ON public.personal_subscriptions TO anon;

DROP TRIGGER IF EXISTS personal_subscriptions_set_updated_at ON public.personal_subscriptions;

UPDATE public.personal_subscriptions SET status = 'expired' WHERE status = 'incomplete';
ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_status_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_status_check
  CHECK (status IN ('trialing', 'active', 'paused', 'cancelled', 'expired', 'past_due', 'grace'));

ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_billing_interval_check;
ALTER TABLE public.personal_subscriptions
  DROP COLUMN IF EXISTS stripe_synced_at,
  DROP COLUMN IF EXISTS stripe_status,
  DROP COLUMN IF EXISTS cancel_at_period_end,
  DROP COLUMN IF EXISTS billing_interval;
```

---

## 7. 表 3 点

### 7.1 全パターン表 (行の由来 × status × 消費経路)

行の由来: **S** = Stripe-backed (`stripe_subscription_id IS NOT NULL`。写像が書く) / **M** = 手動付与 (`stripe_subscription_id IS NULL`。`02-manual-plan-grant.md` の DB 関数 (service_role だけ) が書く。写像は触らない) / **–** = 行が無い。

| status | live (部分 UNIQUE の述語) | 権利あり (`get_effective_plan`) | `plan_key_cached` | 新規購入できる (`POST /checkout`) | 解約の予約 (`/cancel`) | Portal | 写像が書く | S5 の配線ジョブが読む |
|---|---|---|---|---|---|---|---|---|
| – (行なし) | – | free (家族 / 組織があればそれ) | NULL | ○ | 409 | 顧客があれば ○ | INSERT で作る (最初の写像の status のまま。`trialing` / `active` / `past_due` / `incomplete` に加え、終端・非 live の `cancelled` / `expired` も履歴の行として作る。§7.3 の「–」の行) | – |
| `incomplete` (S のみ) | × | × | NULL | ○ (live でないため。Stripe 側で完了すると 2 本目になり得る → §13 の `BILL_LIVE_ROW_CONFLICT` の説明) | 409 | ○ (開けるだけ = 支払い方法の更新。§7.3 の Portal の解約の予約の行は live 5 値だけで、`incomplete` の行は「Stripe が `incomplete` のままの `updated`」の行が受け持つ) | ○ | – |
| `trialing` | ○ | ○ | plan_key | 409 | ○ (S) / 409 (M) | ○ | ○ | – |
| `active` | ○ | ○ | plan_key | 409 | ○ (S) / 409 (M) | ○ | ○ | – |
| `past_due` | ○ | ○ | plan_key | 409 | ○ (S) / 409 (M) | ○ | ○ | `past_due_since <= now()-7d` → `grace` |
| `grace` | ○ | ○ (有料機能の制限は配線) | plan_key | 409 | ○ (S) / 409 (M) | ○ | 保持 (Stripe が past_due/unpaid の間) | `grace_started_at <= now()-23d` → Stripe を解約 |
| `paused` (配線の組織ライセンス) | ○ | × (`get_effective_plan` の対象外) | plan_key | 409 | ○ (S) / 409 (M) (`findLiveSubscription` は live 5 値を引くので `paused` も入る。予約しても status は `paused` のまま。§7.3) | ○ | 保持 (Stripe が active + pause_collection の間) | – |
| `cancelled` | × | × | NULL | ○ | 409 | ○ | ○ (履歴として残る) | – |
| `expired` | × | × | NULL | ○ (`stripe_status='paused'` の行は Stripe で再開し得る。再開したときに別の live 行があれば §13.3 `BILL_LIVE_ROW_CONFLICT`。S19) | 409 | ○ | ○ (`stripe_status='paused'` なら再開で `trialing` / `active` に戻る。`incomplete_expired` は終端) | – |

凍結 (BAN) 中の利用者 (`user_profiles.frozen_at` があり一時 BAN の解除前 = `isAccountFrozen` が真) は、上の表の列のうち「解約の予約 (`/cancel`)」「Portal」と契約の要約 (`GET /api/billing/subscription`) が凍結していないときと同じ値になる (middleware と route が凍結中も通す 3 本。§9.8)。「新規購入できる」は凍結中は全行で 403 `AUTH_ACCOUNT_FROZEN` (確認の `preview`・戻り画面の `checkout/sync` も)、解約の取り消し (`/resume`) も 403。凍結は status・`plan_key_cached`・家族の同期・写像を変えない (列「権利あり」「写像が書く」は凍結と関係なく同じ。§7.3 の凍結の行)。

消費経路 (既存コード。origin/main で `personal_subscriptions` を名指しする `src/` の全ファイルと、本冊が書き換える写し (`user_profiles.plan_key_cached`・`family_groups.plan_key` / `member_limit`) を読む `src/`・`supabase/functions/`・DB 関数 (最新の定義) の全部) と本冊の影響。「読 / 書」= その経路が行を読むか書くか:

| 消費経路 | 読 / 書 | 列 / 条件 | 本冊での変化 |
|---|---|---|---|
| `get_effective_plan` (`20261010140000_ai_usage_foundation.sql:108-115`) | 読 | `status IN ('trialing','active','grace','past_due')` | 変えない。`incomplete` は対象外のまま |
| 同 `get_effective_plan` の b. 家族 (`20261010140000_ai_usage_foundation.sql:122-134`) | 読 | active なメンバーとして属する active な家族の `family_groups.plan_key` | 変えない。`family_groups.plan_key` を写像とトリガー (§6.4 (9) の 10.・(10)) が代表者の家族プランの契約に合わせるので、メンバーの権利が代表者の契約に従う (S3・S18・S20) |
| `src/lib/super-admin/plan-subscribers.ts:10-13,78-94` (`countPlanSubscribers`。プランの廃止の前の確認で、1 件でもあれば `PATCH /api/super-admin/plans/[id]` が廃止を止める) | 読 | `personal_subscriptions`: `plan_key` 一致かつ live 5 値 / `family_groups`: `plan_key` 一致かつ `status='active'` / `organizations`: `plan` 一致かつ `status='active'` | 変えない (`incomplete` は数えない)。`family_groups.plan_key` を写像とトリガー (§6.4 (9) の 10.・(10)) が書くようになるので、グループの数は「代表者に live な家族プランの契約があるグループ」の数になる: 契約が終われば `free` に戻って数から外れ、グループの作成で `p_plan_key` に入れた家族プランは効かない (S20) ので、作っただけのグループが廃止を止めることはなくなる。本冊より前に `create_family_group` で入った家族プランのグループ (F23) は、代表者の写像かトリガーが動くまで数に残る |
| `src/app/api/admin/users/[id]/route.ts:93-100` (運営のユーザー詳細) | 読 | session client (運営ロールの SELECT ポリシー) で `user_id = <id>` かつ `status IN ('active','trialing','paused','past_due','grace')` の最新 1 行の `plan_key, status, current_period_end` | 変えない。SELECT ポリシーは保つ (§6.2)。`incomplete` は live でないので出ない |
| `src/app/api/admin/finance/dashboard/route.ts:45-56` | 読 | 直接集計 (配線で実データ化) | 変えない |
| `src/app/api/admin/finance/reconciliation/route.ts:68` | 読 | `status IN ('active','trialing','past_due','grace')` | 変えない |
| `src/app/api/admin/finance/exports/route.ts:131-142` (`export_type='subscriptions'` の CSV。説明の文は `src/app/admin/finance/exports/page.tsx:30`「PII: user_id のみ」) | 読 | 明示の 9 列 `id, user_id, plan_key, status, starts_at, current_period_start, current_period_end, cancelled_at, created_at` (= 列の許可リスト)。status では絞らない。期間は `created_at` | 変えない。新しい 4 列 (`stripe_synced_at` / `stripe_status` / `cancel_at_period_end` / `billing_interval`) は許可リストに**足さない** (CSV に出ない。足すかは Finance の実データ化 = 配線の冊)。PII は従来どおり `user_id` だけ。`incomplete` と `cancelled_at = ended_at` の行は status / 日時の値のまま出る |
| `src/app/api/admin/finance/invoices/[id]/route.ts:45-54` (請求書の詳細) | 読 | `stripe_webhook_events.payload.data.object.subscription` (acacia の形) を `stripe_subscription_id` に当てて `user_id, plan_key` を `.single()` で引く | 変えない。写像は 1 契約 1 行 (`stripe_subscription_id` UNIQUE。§2.2 F5) なので `.single()` が成り立つ。`payload` は最小化した写し (`minimizeStripeEventPayload`。§8.1・§9.6) で、`data.object.subscription` は acacia (最上位) / basil (`parent.subscription_details`) / 展開済みのどの形でも**文字列の id に正規化して最上位に**残すので、この route の `.subscription` の読みは API 版に関係なく当たる |
| 同 `invoices/[id]/route.ts:38-83`・`invoices/route.ts:57-77` (請求書の詳細と一覧が `payload.data.object` から読む表示の項目。§2.2 F25) | 読 | `id`・`customer`・`amount_paid`・`amount_due`・`currency`・`number`・`invoice_pdf`・`period_start`・`period_end` | route は変えない。最小化した写しに残すのは、このうち個人を指さない項目 (`id`・`customer` (`cus_` の id。展開されていれば id に正規化)・金額・通貨・請求書番号・期間)。`invoice_pdf` (請求先の氏名・メールが印字された PDF の URL) は残さないので、この 2 本では `null` になる (請求書は `stripe_links.invoice` の Stripe Dashboard の URL で開ける)。どちらもセッションの client で読むため RLS で行が見えない既知の不具合 (F25) があり、実データ化は配線の冊。書き出し (`exports` の `invoices`) は `payload` を読まないので変わらない |
| `src/lib/account-export-tables.ts:237-242` / `tests/account-export*.test.ts` (本人のデータの書き出し) | 読 | `self('user_id')`・**`omit` 方式** (取得は全列、`omit` の列を出力前に消す。いまの `omit` = `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`, `notes`) | `omit` に `stripe_status`・`stripe_synced_at` を足す (Stripe との同期の内部の記録。`tests/account-export-tables.test.ts` の `SENSITIVE_NAME` (`stripe_`) の見張りが、足さないと段 A の migration で赤になる)。`cancel_at_period_end`・`billing_interval` は本人の契約の内容なので書き出す (`status`・`current_period_end` と同じ扱い)。段 A (§15.1・追随表 §16.1・テスト 75) |
| 同 `ACCOUNT_EXPORT_EXCLUDED` (`src/lib/account-export-tables.ts:269-`) と `tests/account-export-tables.test.ts:275` (「分類されていない表が無い」) | 読 (migration の表の一覧) | `user_id` (auth.users 参照) を持つ表は、出力するか除外 (理由つき) に分類する | 新設の `billing_customers` を `ACCOUNT_EXPORT_EXCLUDED` に足す (理由: Stripe の顧客 ID と利用者の対応表で、決済の内部の識別子。本人が読める RLS ポリシーが無く、service_role だけが読み書きする)。足さないと段 A の migration で赤になる。段 A (テスト 85) |
| 機能フラグの段階公開 (`src/lib/feature-flags.ts:217-229`・`src/app/api/feature-flags/route.ts:45-56`・`src/lib/super-admin/flag-active-users.ts:73`。`plan_key_cached`) | 読 | 空なら free | 写像が同期するので、購入後は plan で段階公開できる。本人は書けない (§6.4 (11) の特権列ガード) |
| Edge Function の AI 相談の緊急停止スイッチ (`supabase/functions/_shared/ai-chat-flag.ts:52,98-108`。`isAiChatEnabledForUser` が service_role で `user_profiles.plan_key_cached` を読み、`?? 'free'` を `FlagUserContext.planKey` にしてフラグ `ai_chat_enabled` の条件を判定) | 読 | 空なら free | コードは変えない (`supabase/functions/` は §15.2 で触らない)。写像が同期するので、`ai_chat_enabled` にプランの条件があれば、購入後は契約のプランで判定される (いまは誰も同期しないので全員 `free` として判定)。本人は書けない (§6.4 (11))。上の行の `src/lib/feature-flags.ts` と同じ規則 (空なら free) なので、Web と Edge Function で判定が分かれない |
| 運営のユーザー一覧・詳細 (`src/app/api/admin/users/route.ts:177`・`[id]/route.ts:139`。`plan_key_cached ?? 'free'`) | 読 | プランの表示 | 変えない。写像が同期し、本人は書けないので、表示が契約と合う |
| `user_profiles` の本人の UPDATE / INSERT (PostgREST。ポリシー `Users can update own profile` など) | 書 (本人) | 本人の行の全列 (列の権限あり) | `plan_key_cached` を変える UPDATE と、NULL 以外を入れる INSERT は特権列ガードが 42501 (`CANNOT_MODIFY_PRIVILEGED_COLUMN`) で止める。ほかの列の書き込みは変わらない (値を変えない送り直しは通る) |
| `family_groups.plan_key` (family ドメイン) | 書 (写像) | FK | 代表者の個人契約 (`plan_type='family'`) から写像が同期 |
| family の DB 関数 `create_family_group` (baseline 1199-1228) ← `POST /api/family/groups` (`src/app/api/family/groups/route.ts`。`p_name` だけで呼ぶ) ← 画面 `src/app/(main)/family/setup/page.tsx` (名前だけを送る。プランの選択欄は無い) | 書 (`family_groups` の INSERT。`plan_key = p_plan_key`。route からは既定の `'free'`) | グループの作成。`p_plan_key` は RPC を直接呼ぶときだけ利用者の入力になる (F23) | 関数は変えない。BEFORE INSERT のトリガー (§6.4 (10)) が `plan_key` を代表者の live な家族プランの契約 (無ければ `free`) に置き換える。`p_plan_key` は効かない (S20)。route の入力 `plan_key` と画面の選択欄は billing/02 の段 D (#1820) で外した (§16.2・§18 の 5) |
| family の DB 関数 `operator_force_representative_transfer` / `accept_family_representative_transfer` (`20261008090100_family_lock_order.sql:224-339`) | 書 (`family_groups.representative_id`) | 代表者の交代 | 関数は変えない。`family_groups` の BEFORE UPDATE OF `representative_id` のトリガー (§6.4 (10)) が `plan_key` / `member_limit` を新しい代表者の契約に付け替える (S18)。ロックの順: 関数は `family_groups` 行 → (トリガーの中で) advisory `billing-user:<新しい代表者>` → `personal_subscriptions` をロックなしで読む (交代の 2 本は `user_profiles` を触らない)。写像は advisory 2 本 (`billing-user:<利用者>` が先) → 契約行 → `family_groups` 行 → `user_profiles` 行 (§6.4 (9) の 10.。`family_groups` → `user_profiles` は #1310 の LOCK-ORDER と同じ向き。下の解散・削除の行)。トリガーが新しい代表者の鍵を取るので、新しい代表者の写像とは直列になる (写像が先ならトリガーは commit 済みの契約を読み、トリガーが先なら写像は交代・作成の commit のあとで WHERE `representative_id = 新しい代表者` に当てる)。循環しない理由: 新しい代表者の写像の `family_groups` の UPDATE は、交代中の行 (見えている代表者は旧代表者) の WHERE に当たらないので行のロックを待たない。行のロックを待つのは旧代表者の写像だけで、トリガーは旧代表者の鍵を取らず、交代の関数は `user_profiles` も契約行も取らない。グループの作成 (`create_family_group`) は INSERT (トリガーで鍵) → `family_members` → `user_profiles` の順で、写像の鍵 → `user_profiles` と同じ向き (作成中のグループは commit まで写像の WHERE に見えない) |
| family の DB 関数のうち `family_groups` の行を先にロックしてから `user_profiles` を書くもの (#1310 の LOCK-ORDER。リポジトリの `CLAUDE.md`「家族 (family_*) を変える関数のロック順」): `operator_force_dissolve_family` (`20261008090100_family_lock_order.sql:200-207`。`family_groups` を `FOR NO KEY UPDATE` → `UPDATE user_profiles SET family_id = NULL WHERE family_id = <家族>` で代表者の行も書く)・代表者による家族の削除 (`DELETE FROM family_groups` が家族の行を取り、`user_profiles.family_id` の `ON DELETE SET NULL` (`supabase/baseline/prod_schema.sql:9437`) が代表者の行を書く)・`leave_family` (`20261008090100_family_lock_order.sql:360,376`)・`remove_family_member` (同 `:399,422`)・`accept_family_invite` と `accept_child_promotion` (最新の定義は `20261015170000_accept_copies_profile_name.sql:73,131` と `:183,267`。家族の行 → 招待 / メンバー → `user_profiles`) | 書 (`user_profiles.family_id`) | 家族の行 → `user_profiles` の行 | 関数は変えない。写像も `family_groups` の行 → `user_profiles` の行の順 (§6.4 (9) の 10. を `family_groups` の UPDATE が先になるように並べた) なので向きがそろい、循環しない: 解散・削除が家族の行を持っていれば、写像は `user_profiles` を持たずに家族の行を待ち (解散・削除が commit したあと、写像の UPDATE は `status='dissolved'` / 行なしを読んで当たらない)、写像が家族の行を持っていれば、解散・削除は家族の行で待つ。写像が家族の行に当たらない (代表者でない・プランが同じ) ときは `user_profiles` だけを最後に持ち、家族の行は待たない。テスト 106 (解散と同じ順にロックを取る接続を開いたまま写像を流す・写像を開いたまま本物の解散と削除を流す) |
| family の DB 関数の人数の上限の確認 (最新の定義: `accept_family_invite` = `20261015170000_accept_copies_profile_name.sql:73` (`FOR NO KEY UPDATE`)・`add_family_child` = `20261007160000_family_member_limit_row_lock.sql:146` (`FOR UPDATE`)・`create_family_invite` = `20261008100000_membership_daily_send_cap.sql:275` (ロックなし)。`20261007150200_invite_accept_creates_missing_profile.sql:67`・`20261007160000_family_member_limit_row_lock.sql:93`・`20261008090100_family_lock_order.sql:123` の `accept_family_invite` は同じ引数の `20261015170000` (#1584。ロックの順は `20261008090100` のまま) で置き換え済み) | 読 | `family_groups.member_limit` と active なメンバーの数を比べ、`v_count >= v_limit` で `MEMBER_LIMIT_EXCEEDED` | 関数は変えない。写像とトリガー (§6.4 (9) の 10.・(10)) が `member_limit` を書き換えるので、上限はその時点の値で効く (`family_basic` 4・`family_pro` 8・`free` 4。F8)。承諾と子供の追加は家族の行をロックしてから読むので、写像の `family_groups` の UPDATE と同時でも commit 済みの値で数える (承諾は家族の行 → 招待 → メンバー → `user_profiles`、子供の追加は家族の行 → メンバー、写像は家族の行 → `user_profiles` の順で、どれも家族の行を先に取るので循環しない。上の行)。上限が下がったとき (`family_pro` の終了・代表者の交代で 8 → 4) に、すでに上限を超えているメンバーは外さない (新しい招待の作成・承諾・子供の追加だけが `MEMBER_LIMIT_EXCEEDED` で止まる)。超えた分の扱いは §18 の 15 |
| family の画面 (`src/app/(main)/family/dashboard/page.tsx:56,132`・`src/app/(main)/family/members/page.tsx:60,191`) | 読 | `family_groups.member_limit` を読み「`<人数>/<上限>` 人」を表示 | 画面は変えない。上限の表示が契約に合わせて変わる (4 / 8)。上限が下がって超えている間は `6/4 人` のように人数が上限を上回って表示される (§18 の 15) |
| DB 関数 `apply_coupon` (`20261007160700_apply_coupon_rpc.sql:147-152, 260-265`) | 読・書 | 契約行を `FOR NO KEY UPDATE` でロックして `user_id, plan_key` を読み、`active_coupon_redemption_id` **だけ**を UPDATE | 変えない (Stripe には反映されない。§4.2 S15)。写像の UPDATE (§6.4 の 8.) は `active_coupon_redemption_id` に触れないので互いの列を上書きしない。ロックの順は apply_coupon = `coupons` 行 → 契約行、写像 = advisory 2 本 → 契約行 (どちらも契約行は `FOR NO KEY UPDATE`。写像は §6.4 (9) の 3.) で、写像は `coupons` を取らないので循環しない |
| `src/lib/plan/coupon.ts:129-135` (`applyCoupon`) ← `src/app/api/super-admin/coupons/[id]/apply/route.ts:34-40` (super_admin・`getSupabaseAdmin()`) | 書 (RPC 経由) | `apply_coupon` を service_role で呼ぶだけ。直接の `.from('personal_subscriptions')` は無い | 変えない。RLS の是正 (§6.2) は service_role に当たらない。手動付与の行 (M) にも Stripe-backed の行 (S) にも従来どおり適用できる |
| `src/app/api/super-admin/plans/[id]/price-impact/route.ts:8` | — | コメントだけ (集計しない。#1102) | 変えない |

### 7.2 状態比較表 (現行 vs 設計後)

| 項目 | 現行 (origin/main) | 設計後 |
|---|---|---|
| 購入の入口 | 無い (`/pricing` の CTA は `/signup`。有料プランは「準備中」と出していた (#1911 で取り除いた)) | `/pricing` (買えるプランのカードに、買える間隔ごとの金額と CTA「月額で始める」/「年額で始める」。買えない間隔は出さない。切替のトグルは無い。§10.1) → `/account/billing/checkout?plan_key=&interval=` → `POST /api/billing/checkout` → Stripe Checkout |
| 顧客の作成 | 無い | `billing_customers` に 1 利用者 1 顧客。Checkout の前に作る |
| `personal_subscriptions` への書き込み | アプリコードに無い。RLS は本人が書ける (F6) | 写像関数だけが書く (service_role)。本人は書けない。admin/super_admin の直接書き込みは従来どおり |
| `status` の値 | 7 値 | 8 値 (`incomplete` を足す) |
| Webhook の受け口 | 無い | `POST /api/webhooks/stripe` (署名・冪等・取り直し・単調) |
| イベントの記録 (`stripe_webhook_events.payload`) | (05 の設計) イベントの JSON 全体 (氏名・メールを含む) | 最小化した写し (`minimizeStripeEventPayload`。氏名・メールアドレス・住所・`invoice_pdf` を持たない) |
| 失敗したイベント | (05 の設計) `failed` のまま再処理されない | 再送で `claim` が取れて再処理される |
| 処理中のイベントの再送 | (05 の設計) 23505 で 200 | 409 (Stripe が再送を続ける)。15 分を過ぎた `processing` は再送で取り直す。200 を返すのは `completed` だけ |
| 順序の入れ替わり | (05 の設計) 考慮なし | 常に最新を取り直し、`fetched_at` で単調 |
| 試用 | (04 の設計) SetupIntent + 日次ジョブで終了 | Checkout の `trial_period_days` + `payment_method_collection=always`。同じプランの再試用なし (0 日) |
| 支払失敗 | (05 の設計) アプリがメール送信 | Stripe の顧客向けメール。アプリは `past_due` の写像 + 監査 |
| 解約 | 無い | `/account/billing` から期間末の解約を予約・取り消し。即時解約は退会のとき |
| 凍結 (BAN) 中の利用者の課金 | (課金が無い。凍結中は `/api/*` を退会と書き出しの 2 本を除いて 403・画面は `/frozen` へ) | 凍結は契約も Stripe の課金も止めない。`/frozen/billing` (§10.5) から解約の予約と Billing Portal ができる (`FROZEN_ALLOWED_API_PATHS` に契約の要約・解約の予約・Portal の 3 本を足し、3 本の route は `requireUserAllowingFrozen` で凍結を見ない。§9.8)。解約の取り消し・購入・同期・確認の内容は凍結中は 403 |
| Billing Portal | 無い | `POST /api/billing/portal` |
| 鍵 (`STRIPE_SECRET_KEY`) が無いときの `/account/billing` | (ページが無い) | 契約の要約 (`GET /api/billing/subscription`) と確認画面の内容 (`GET /api/billing/checkout/preview`) は 200 (Stripe を呼ばないので gateway を作らない)。Stripe を呼ぶ操作 (購入・同期・Portal・解約の予約と取り消し) だけが 503 |
| 退会 | Stripe は未処理 | 段階 `billing` と `billing_recheck` (`deleteUser` の直前) で、開いた Checkout を閉じ、即時解約 (Stripe 側の顧客の全契約 + DB の行の和) + 顧客の匿名化。退会のあとに Stripe に生まれた契約は写像の入口 (`syncSubscription`) が即時解約 |
| 本人のデータの書き出しの分類 | `billing_customers` は無い | `billing_customers` を除外 (`ACCOUNT_EXPORT_EXCLUDED`) |
| `plan_key_cached` | 誰も同期しない。本人が PostgREST から書ける (特権列ガードの対象外。F21) | 写像が同期。本人は書けない (特権列ガード 2 本に追加) |
| `family_groups.plan_key` / `member_limit` | 作成のときだけ `create_family_group` が利用者の入力 (`p_plan_key`) を入れる (F23)。以後は誰も書かない | 代表者の家族プラン契約から写像が同期。グループの作成と代表者の交代ではトリガーが代表者の契約に合わせる (作成で契約が無ければ `free`) |
| 契約の行の `plan_key` | 書き手が無い (運営の手動付与だけ) | 行を作ったときに決まり、以後変わらない (写像は既存の行の `plan_key` を使う。Stripe 側で Price を付け替えても変えない。§6.4 (9) の 4.・§7.3) |
| `updated_at` | トリガー無し | `update_updated_at_column` のトリガー |
| 環境変数 | `STRIPE_SECRET_KEY` のみ一覧 | `STRIPE_WEBHOOK_SECRET` を一覧に足す。`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` は `.env.example` から消す (読む場所が無い) |
| 特定商取引法の表記 (`/legal`)・`/faq`・トップの FAQ | 販売価格ほか 5 行と FAQ が「有料プランは準備中です（販売開始前）」 | 本冊の段では変えなかった。#1911 (#1916) で、`/legal` の販売の 5 行を項目ごと取り除き、`/faq`・トップの FAQ から「有料プランは準備中です（販売開始前）」を取り除いた (「準備中」とも書かない)。販売開始 (§17.3) の前提として、有料プランの販売 (#1912) が販売の内容の項目を足す (文面は業務・法務の判断。§18 の 14) |
| モバイル | 課金の記述なし。料金の画面 (`app/(public)/pricing.tsx`) が「Web版を開く」で Web の `/pricing` を外部のブラウザで開く (買えるプランが無い間は Web にも有料プランのカードが無いので購入には届かない) | アプリ内に購入導線を出さない規則。WebView のページも購入導線を描かない。料金の画面と入口の画面の「料金」のリンクを消す (§10.4) |

### 7.3 状態遷移表 (status × 操作・イベント → 遷移先・ガード・副作用)

「写像」= `billing_apply_stripe_subscription`。「—」= その状態では起きない / 何もしない。Stripe-backed の行 (S) についての表。M 行の遷移は `02-manual-plan-grant.md` §7.3。

| 現在 | 操作 / イベント (入口) | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| – | 契約が初めて写る: Checkout 完了 → `customer.subscription.created` / `checkout.session.completed` / 戻り画面の sync、または行の無い契約に届いたほかのイベントの取り直し (S8(a)・S13 の Price の登録後) (写像) | `trialing` (試用あり) / `active` / `past_due` (Stripe の `past_due` / `unpaid`。`past_due_since=now()`) / `incomplete` (Stripe が incomplete のとき) | 利用者が解決できる・プランが解決できる・live に写るとき (`incomplete` 以外) は他に live 行が無い | INSERT・`billing_customers` 補完・`plan_key_cached`・家族の同期 (family)・監査 `subscription_created` (`past_due` なら warn) |
| – | 上と同じで、ガードを満たさない (同じ利用者に別の live 行がある / プランか利用者を解決できない) (写像) | – (行を作らない。Stripe の契約は生きたまま。その後 Stripe で解約・期限切れ・一時停止になれば、次の行のとおり `cancelled` / `expired` の行ができる) | — | `BILL_LIVE_ROW_CONFLICT` / `BILL_UNKNOWN_PLAN` / `BILL_UNKNOWN_USER` → イベント `failed`・500・監査 `system.stripe.event_failed` (target は `stripe_event`。§9.6)。この契約は退会のとき Stripe の一覧から解約される (下の退会の行) |
| – | 行の無い契約に、終端か非 live の状態で初めて届いたイベントの取り直し (写像)。例: S12 の 2 本目 (`BILL_LIVE_ROW_CONFLICT` で写せなかった) を運営が Stripe で解約した `customer.subscription.deleted`・S13 で写せなかった契約が Price の登録後に `canceled` / `incomplete_expired` / `paused` で写る・Webhook が着く前に Stripe 側で終わった契約 | `cancelled` (Stripe `canceled`。`cancelled_at = ended_at`) / `expired` (Stripe `incomplete_expired` / `paused`) (INSERT) | 利用者とプランが解決できる (できなければ上の行と同じ `BILL_UNKNOWN_*`)。live でないので衝突の検査はしない (部分 UNIQUE に当たらない) | INSERT (履歴の行。`trial_start` があれば `trial_started_at` も入り、同じプランの再購入の試用の判定 `hasUsedTrial` に数える)・`billing_customers` 補完・`plan_key_cached` は live な行から再計算 (変わらない)・家族の戻しを評価 (代表者のグループの `plan_key` がこのプランで、同じ利用者に同じプランの live な行が無いときだけ free / 4。§6.4 (9) の 10.。S12 で同じプランの 1 本目が live なら戻さない)・監査 `subscription_created` (`from` NULL・`to` `cancelled` / `expired`・info) |
| `incomplete` | `customer.subscription.updated` (支払完了) (写像) | `active` / `trialing` | 鮮度・同じ利用者に別の live 行が無い (`incomplete` は live でないので、その間に別の契約を買えている。あれば `BILL_LIVE_ROW_CONFLICT`・イベント `failed`・行は `incomplete` のまま。§7.1 の `incomplete` の行・§13.3) | UPDATE・`plan_key_cached`・家族の同期 (family)・監査 `status_changed` |
| `incomplete` | `customer.subscription.updated/deleted` (`incomplete_expired`) (写像) | `expired` | 鮮度 | UPDATE・監査 |
| `incomplete` | `customer.subscription.updated` で Stripe の status が `incomplete` のまま (初回の請求の支払い待ち・認証 (3D セキュア) 待ち・支払い方法の付け替え・Portal で解約の予約が付いた / 外れた など) と、初回の請求の `invoice.payment_failed` / `invoice.payment_action_required` (認証 (3D セキュア) が要る。`sync_invoice_subscription`) (写像) | `incomplete` (同じ) | 鮮度 | UPDATE (`current_period_*`・`cancel_at_period_end`・`cancel_at`・`stripe_synced_at` を Stripe の値に)。status が変わらないので監査 `status_changed` は書かない。`plan_key_cached` は live な行から再計算 (変わらない)。家族は live でないので戻しの評価だけ (§6.4 (9) の 10. の else。同じプランの live な行があれば何もしない)。`invoice.payment_failed` なら監査 `system.payment.failed` (warn) は書く (§8.6 は status で絞らない。`applied` か `stale` のとき)。`/account/billing` は live でないので `can_cancel` / `can_resume` のどちらも出さず、`can_purchase` (§8.1 `summarizeSubscription`) |
| `trialing` | 試用終了の請求成功 → `invoice.paid` + `updated` (写像) | `active` | 鮮度 | `current_period_*` 更新・監査 |
| `trialing` | 試用終了の請求失敗 → `invoice.payment_failed` + `updated` (写像) | `past_due` | 鮮度 | `past_due_since=now()`・監査 `status_changed` (warn。写像) + `system.payment.failed` (warn) (invoice.payment_failed の処理が写像の結果 `applied` か `stale` のとき書く。stale = 同時に届いた `updated` の新しい取り直しが先に写した場合でも書く。退会済み (`user_deleted`) だけ書かない。§8.6) |
| `trialing` / `active` / `past_due` / `grace` / `paused` | 利用者の解約予約 `POST /api/billing/subscription/cancel` | 同じ status (`cancel_at_period_end=true`, `cancel_at=current_period_end`) | live かつ S (`findLiveSubscription` の live 5 値。`paused` は写像の保持の規則で `paused` のまま = Stripe が `active` + `pause_collection` の間。予約が期間末に効くと下の「`paused` (配線) Stripe 側の解約」の行) | Stripe `POST /subscriptions/{id}`・写像 (`api:cancel`)・監査 `user.billing.cancel_scheduled` (actor = 本人) |
| 同上 (予約中) | 解約の取り消し `POST /api/billing/subscription/resume` | 同じ status (`cancel_at_period_end=false`, `cancel_at=NULL`) | live かつ S かつ `cancel_at_period_end` | Stripe 更新・写像 (`api:resume`)・監査 `user.billing.cancel_revoked` |
| `trialing` / `active` / `past_due` / `grace` / `paused` | **Portal** で解約を予約 → `customer.subscription.updated` (`cancel_at_period_end=true`) (写像 `webhook:<event.id>`。route を通らない) | 同じ status (`cancel_at_period_end=true`, `cancel_at` = Stripe の値) | 鮮度 (`grace` / `paused` は保持の規則で `grace` / `paused` のまま) | UPDATE `cancel_at_period_end`・`cancel_at` のみ。**監査は書かない** (写像は status が変わったときだけ監査する。§6.4 の 11.。利用者の操作の記録は `stripe_webhook_events.payload` の最小化した写し (`status`・`cancel_at_period_end`・`cancel_at` を残す。§8.1) と Stripe の履歴に残る。§18 の 11)。`/account/billing` は `can_resume` になる (DB の側はテスト 103・要約の側はテスト 111) |
| 同上 (予約中) | **Portal** で予約を取り消す → `customer.subscription.updated` (`cancel_at_period_end=false`) (写像 `webhook:<event.id>`) | 同じ status (`cancel_at_period_end=false`, `cancel_at=NULL`) | 鮮度 | 同上 (監査なし)。`/account/billing` は `can_cancel` になる (テスト 103・111) |
| `trialing` / `active` / `past_due` / `grace` / `paused` で、利用者が凍結 (BAN) 中 (`isAccountFrozen` が真。§9.8) | 凍結中の解約予約 `POST /api/billing/subscription/cancel` (`/frozen/billing` の「解約する」。§10.5) | 同じ status (`cancel_at_period_end=true`, `cancel_at=current_period_end`) | live かつ S かつ予約なし (`can_cancel`)。凍結では止めない: middleware は `isFrozenAllowedApiPath` で通し、route は `requireUserAllowingFrozen` で凍結を見ない (§9.8) | 上の「利用者の解約予約」の行と同じ (Stripe `POST /subscriptions/{id}`・写像 `api:cancel`・監査 `user.billing.cancel_scheduled` (actor = 本人))。予約済みなら何もせず同じ要約 (冪等)。期間末の `deleted` は下の `cancelled` の行。S21 |
| 同上 (凍結中。予約の有無を問わない) | 凍結中の Billing Portal `POST /api/billing/portal` (`/frozen/billing` の「お支払い方法・請求書 (Stripe)」) | 同じ (Portal を開くだけ。Portal の中で解約を予約 / 取り消せば、上の Portal の 2 行のとおり写る。写像は凍結を見ない) | 顧客がある (`has_customer`)。凍結では止めない (§9.8) | Stripe に Portal Session を作る。戻り先 `/account/billing` は、凍結中は middleware が `/frozen` へ回す (§10.5) |
| 同上 (凍結中・予約中) | 凍結中の解約の取り消し `POST /api/billing/subscription/resume` | — (変わらない。予約は残り、期間末に `cancelled`) | 凍結中は通さない (`FROZEN_ALLOWED_API_PATHS` に無い) | middleware が 403 `AUTH_ACCOUNT_FROZEN` (route に届いても `requireUser` が 403)。`/frozen/billing` は「解約を取り消す」を描かない |
| 任意 (行なし・live・live でない) で、利用者が凍結中 | 凍結中の新規購入 `POST /api/billing/checkout`・確認の内容 `GET /api/billing/checkout/preview`・戻り画面の同期 `POST /api/billing/checkout/sync` | — | 凍結中は通さない (`FROZEN_ALLOWED_API_PATHS` に無い) | middleware が 403 `AUTH_ACCOUNT_FROZEN` (route も `requireUser`)。顧客も Checkout Session も作らない。画面 (`/pricing`・`/account/billing`・`/account/billing/checkout`) も凍結中は `/frozen` へ回る。凍結の前に開いた Checkout を凍結中に完了した契約は、Webhook の写像で写る (写像は凍結を見ない。次の行)。その契約も `/frozen/billing` から解約を予約できる |
| 任意 | 凍結 (運営が `frozen_at` を入れる)・凍結の解除 (`frozen_at` を外す・一時 BAN の `unban_at` を過ぎる) | 同じ (凍結は契約の行を変えない) | — | 何もしない。核は凍結で Stripe の課金を止めない (課金を止めるのは、利用者の解約の予約 (上の行)・運営の Stripe での解約・退会。§12・§18 の 20)。Webhook の受け口と写像は利用者の凍結を見ないので、凍結中も Stripe の変化 (更新・支払失敗・期間末の解約) はそのまま写る |
| live (S) / `incomplete` | 既存の契約の Price (`items`) を運営が Stripe の Dashboard で付け替えた → `customer.subscription.updated` (写像)。核の画面と API は付け替えをしない (価格変更は新規契約のみ。`operator/04` §3.3・§0 の対象外。Portal のプランの変更は OFF。§17.1 の 3.) | 同じ status (Stripe の status の写像どおり) | 鮮度 | UPDATE `stripe_price_id`・`billing_interval` を Stripe の値に。`plan_key` は変えない (§6.4 (9) の 4.: 既存の行があればその `plan_key`。`metadata.plan_key` の有無・付け替え先の Price がどのプランかに関わらない) ので、`plan_key_cached`・家族のグループ (`plan_key` / `member_limit`) も変わらない。status が変わらなければ監査なし。別のプランに移す業務は新しい契約で行う (§18 の 16) |
| `trialing` | 試用の終わりの前の通知 `customer.subscription.trial_will_end` (Stripe が試用の終わりの 3 日前に送る。`sync_subscription` = 契約を取り直して写す) (写像) | `trialing` (同じ)。取り直した Stripe の status が `trialing` でなければ (通知の処理より先に試用が終わった・解約された)、その status の行と同じ遷移 | 鮮度 | UPDATE (取り直した値。変わらない)。status が変わらないので監査は書かない。利用者への知らせは Stripe の顧客向けメール「試用終了前」(§17.1 の 4.) で、核はメールも監査も足さない。行が無ければ上の「–」の行 (契約が初めて写る)、退会済みなら下の `user_deleted` の 2 行。テスト 110 |
| live (S) / `incomplete` | 保留中の付け替えの支払いが済んだ `customer.subscription.pending_update_applied` (`sync_subscription`) (写像)。核は保留つきの更新 (`payment_behavior=pending_if_incomplete`) を作らない (核が Stripe の契約に送る更新は解約の予約と取り消しの `cancel_at_period_end` だけ。§8.4) ので、運営が Stripe の Dashboard / API で付け替えたときだけ届く | 同じ status (Stripe の status の写像どおり) | 鮮度 | 上の「Price を付け替えた」の行と同じ: UPDATE `stripe_price_id`・`billing_interval` を Stripe の値に。`plan_key`・`plan_key_cached`・家族のグループは変えない。status が変わらなければ監査なし。テスト 110 (振り分け)・105 (写像) |
| live (S) / `incomplete` | 保留中の付け替えが期限切れで捨てられた `customer.subscription.pending_update_expired` (`sync_subscription`。上の行と同じく運営の付け替えのときだけ届く) (写像) | 同じ status | 鮮度 | Stripe の `items` は付け替え前のままなので、取り直した値は行と同じ (UPDATE は同じ値を書くだけ・監査なし)。テスト 110 |
| `trialing` / `active` / `past_due` / `grace` | 更新日・試用の終わりの請求の支払いに認証 (3D セキュア) が要る `invoice.payment_action_required` (`sync_invoice_subscription` = 請求の `subscription` の契約を取り直して写す) (写像) | 取り直した Stripe の status の写像どおり: Stripe が `past_due` なら `trialing` / `active` → `past_due`、`past_due` / `grace` は保持 (上の請求失敗・`grace` の行と同じ)。Stripe の status がまだ変わっていなければ同じ status | 鮮度 | `past_due` に遷移したときは上の「請求失敗 → `past_due`」の行と同じ UPDATE (`past_due_since=now()`) と監査 `status_changed <from>→past_due` (warn。写像)。**`system.payment.failed` は書かない** (書くのは `invoice.payment_failed` の処理 `audit_payment_failed_and_sync` だけ。§8.6。同じ請求で Stripe が `invoice.payment_failed` も送れば、そのイベントの行のとおり書く)。請求に `subscription` が無ければ `skipped: 'invoice_without_subscription'` (何も書かない)。テスト 110 |
| `active` | 更新日の請求成功 → `invoice.paid` + `updated` (写像) | `active` | 鮮度 | `current_period_*` 更新 (監査なし) |
| `active` | 更新日の請求失敗 → `invoice.payment_failed` + `updated` (写像) | `past_due` | 鮮度 | `past_due_since=now()`・監査 `status_changed` (warn。写像) + `system.payment.failed` (warn) (invoice.payment_failed の処理が写像の結果 `applied` か `stale` のとき書く。stale = 同時に届いた `updated` の新しい取り直しが先に写した場合でも書く。退会済み (`user_deleted`) だけ書かない。§8.6) |
| `past_due` | Smart Retry 成功 → `invoice.paid` + `updated` (写像) | `active` | 鮮度 | `past_due_since=NULL`・監査 |
| `past_due` | 再試行失敗 → `invoice.payment_failed` (写像) | `past_due` | 鮮度 (stale でも下の監査は書く) | 監査 `system.payment.failed` (warn) のみ (invoice.payment_failed の処理が写像の結果 `applied` か `stale` のとき書く。stale = 同時に届いた `updated` の新しい取り直しが先に写した場合でも書く。退会済み (`user_deleted`) だけ書かない。§8.6) |
| `trialing` / `active` | Stripe が `unpaid` (§17.1 項 5 が「未払いにする」になっていた場合、または `past_due` の間の取り直しが遅れて `unpaid` を読んだ) (写像) | `past_due` | 鮮度 | `past_due_since=now()`・`stripe_status='unpaid'`・監査 `status_changed <from>→past_due` (warn) |
| `past_due` | Stripe が `past_due` → `unpaid` (写像) | `past_due` | 鮮度 | `stripe_status='unpaid'` だけ更新 (status は同じなので監査なし)。`past_due_since` は保つ |
| `past_due` | 配線 `grace_period_check` (1 文の直接 UPDATE。§12) | `grace` | `status='past_due'` かつ `past_due_since <= now() - 7 日` (UPDATE の WHERE。写像が行ロックを持っていれば待ち、写像の書いた行で評価し直す) | `grace_started_at=now()` (配線が書く)。写像はこの UPDATE と契約の行のロック (`FOR NO KEY UPDATE`。§6.4 (9) の 3.) で直列になり、commit 済みの `grace` を巻き戻さない |
| `grace` | Stripe の再試行イベント (写像) | `grace` (保持。`grace_started_at`・`past_due_since` も保つ) | Stripe が `past_due` / `unpaid` (写像は契約の行をロックしてから読むので、配線の UPDATE と同時でも commit 済みの `grace` を読む) | 変化なし。再試行イベントが `invoice.payment_failed` なら監査 `system.payment.failed` (warn) は書く (§8.6) |
| `grace` | 支払回復 → `invoice.paid` + `updated` (写像) | `active` | 鮮度 | `past_due_since=NULL`・`grace_started_at=NULL`・監査 |
| `grace` | 配線が 30 日で Stripe を解約 → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`plan_key_cached` 再計算・家族を free に・監査 |
| `active` (予約中) | 期間末に Stripe が解約 → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | 同上 |
| `trialing` | 試用中の解約 → `customer.subscription.deleted` (予約 (API / Portal) が試用の終わりに効いたもの、または運営が Stripe の Dashboard で即時に解約したもの) (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`trial_started_at` / `trial_ends_at` は保つ (§6.4 の 8. の COALESCE。同じプランの再購入で試用を付けない判定 `hasUsedTrial` に使う。§4.2 S2)・`plan_key_cached` 再計算・家族を free に (family)・監査 `status_changed trialing→cancelled` (info) |
| `active` (予約なし) | Stripe 側での即時解約 (運営が Dashboard / API で解約) → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`plan_key_cached` 再計算・家族を free に・監査 `status_changed active→cancelled` (info)。返金は運営が Stripe で行う (核は返金を扱わない) |
| `past_due` | Stripe の再試行が尽きて解約 (§17.1 項 5 の設定が「キャンセルする」になっていた場合)、または運営が Dashboard で解約 → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`past_due_since=NULL`・`plan_key_cached` 再計算・家族を free に・監査 `status_changed past_due→cancelled` (info)。§17.1 項 5 の設定どおりなら起きず、`past_due → grace → cancelled` (配線) の道になる |
| `paused` (配線) | Stripe 側の解約 (API / Portal の予約が期間末に効いたものを含む) → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`plan_key_cached` 再計算・家族を free に・監査 `status_changed paused→cancelled` (info)。`paused` に戻すかどうか (組織ライセンスとの関係) は配線の冊 |
| `incomplete` | 運営が Stripe で未完了の契約を解約 → `customer.subscription.deleted` (Stripe の status `canceled`) (写像) | `cancelled` | 鮮度 | UPDATE・監査 `status_changed incomplete→cancelled` (info)。`plan_key_cached` は live な行から再計算するので変わらない。家族は、同じプランの live な行が別にあれば戻さない (§6.4 の 10. の `NOT EXISTS`。2 本目の Checkout が live になったあとで 1 本目の未完了が終わる場合) |
| `paused` (配線) | `updated` (Stripe `active` + `pause_collection`) (写像) | `paused` (保持) | 写像は契約の行をロックしてから読むので、配線の UPDATE と同時でも commit 済みの `paused` を読む (§6.4 (9) の 3.・§12) | 変化なし |
| `paused` (配線) | 配線が `pause_collection` を外す → `updated` (写像) | `active` | 鮮度 | 監査 |
| live (S) / `incomplete` / `expired` (`stripe_status='paused'`) | 退会 (`deleteAccount` 段階 `billing`、と `billing_recheck`) | 行は `deleteUser` の CASCADE で消える | 顧客がある、または DB に行がある | 先に顧客の開いたままの Checkout Session を閉じる (`expire`)・Stripe の status が終端でなければ `DELETE /subscriptions/{id}`・顧客の匿名化 (まだなら)・`billing_customers.anonymized_at`・監査 `system.billing.account_deletion_stripe_cancelled` (`billing` は必ず・`billing_recheck` は閉じた / 解約したものがあったときだけ)。後から届く `deleted` は `skipped: 'user_deleted'` (終端なので何もしない) |
| – (DB に行が無い Stripe の契約: Webhook が着く前の契約・上の「ガードを満たさない」で写せなかった契約・段階 `billing` のあとに完了した Checkout の契約) | 退会 (`deleteAccount` 段階 `billing`、と `billing_recheck`) | – (行は作らない) | 顧客 (`billing_customers`) の契約として Stripe の一覧 (`listCustomerSubscriptions`) に出る | Stripe の status が終端でなければ `DELETE /subscriptions/{id}` (数に入る)・以降は上と同じ。S10 |
| – (グループが無い) | 家族グループの作成 (`create_family_group` の INSERT) | グループの `plan_key` = 代表者の live な家族プランの契約のプラン (上限もそのプラン)。契約が無ければ `free` (上限は呼び出し側の値 = 既定 4) | 新しいグループが active | トリガー §6.4 (10)。`p_plan_key` は使わない (F23)。S20 |
| live な家族プランの契約 (S。代表者 A) | 代表者の交代 (family の DB 関数 2 本の `UPDATE family_groups SET representative_id`) | 契約の行は変わらない (A の契約のまま) | グループが active・`representative_id` が変わった | トリガー §6.4 (10) (新しい代表者の写像と advisory `billing-user:<新しい代表者>` で直列): 新しい代表者に live な家族プランの契約があれば `plan_key` / `member_limit` をそれに。無ければ、旧代表者 A に同じ `plan_key` の live な行があるとき `free` / 4 に戻す。監査は family 側の `membership_audit` (既存) だけ。以後 A の契約の写像はグループに当たらない (`representative_id = A` が 0 行)。S18 |
| live (S) (`trialing` / `active` / `past_due` / `grace` / `paused`) | Stripe の一時停止 (試用が支払い方法なしで終わった。§4.1) → `customer.subscription.paused` / `updated` (Stripe `paused`) (写像) | `expired` (`stripe_status='paused'`) | 鮮度 (保持の規則は効かない: `grace` を保つのは Stripe が `past_due` / `unpaid` のとき、`paused` を保つのは Stripe が `active` + `pause_collection` のときだけ) | UPDATE・`plan_key_cached` 再計算・家族を free に (family)・監査 `status_changed <from>→expired` (info)。S19 |
| `expired` (`stripe_status='paused'`) | Stripe の再開 → `customer.subscription.resumed` / `updated` (Stripe `active` / `trialing`) (写像) | `active` / `trialing` | 鮮度・同じ利用者に別の live 行が無い (あれば `BILL_LIVE_ROW_CONFLICT`・イベント `failed`・行は `expired` のまま) | UPDATE・`plan_key_cached`・家族の同期 (family)・監査 `status_changed expired→active` (info)。S19 |
| `expired` (`stripe_status='paused'`) | Stripe 側の解約 → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・監査 `status_changed expired→cancelled` (info) |
| `cancelled` / `expired` (`stripe_status` が `canceled` / `incomplete_expired`) | Stripe の再送イベント・取り直し (写像) | 同じ | 鮮度 | 変化なし (Stripe ではこの 2 つは終端で、取り直しても同じ status が返る。UPDATE は同じ値を書くだけで監査も書かない) |
| `trialing` / `active` / `past_due` / `grace` / `paused` (S でも M でも) | 新規購入 `POST /api/billing/checkout` | — (行は変わらない。顧客も Checkout Session も作らない) | `findLiveSubscription` が行を返す (`LIVE_SUBSCRIPTION_STATUSES` の live 5 値。§8.6 `startCheckout` はプランの検査 (422 `BILL_PLAN_NOT_PURCHASABLE`) のあとにこれを見る) | 409 `OP_SUBSCRIPTION_ALREADY_ACTIVE` (§9.1・§13.1)。監査は書かない (`user.billing.checkout_started` は Session を作ったときだけ)。確認の内容 `GET /api/billing/checkout/preview` は `can_purchase: false` を返し、確認画面は CTA を無効にする (§10.2)。同時に 2 本の購入が来て両方この検査を通ったときは、2 本目の契約の写像が上の「–」の 2 行目 (`BILL_LIVE_ROW_CONFLICT`) になる。S12・テスト 26 |
| `incomplete` (S) | 新規購入 `POST /api/billing/checkout` | `incomplete` の行は同じ。新しい Checkout が完了すると、その契約は上の「–」の 1 行目 (契約が初めて写る) で別の行として INSERT される (`trialing` / `active` / `past_due` / `incomplete`) | `findLiveSubscription` が null (`incomplete` は `LIVE_SUBSCRIPTION_STATUSES` に無い。§7.1 の `incomplete` の行)・プランが買える | 顧客 (無ければ作る)・Checkout Session・監査 `user.billing.checkout_started` (§9.1。S1 と同じ)。2 本目が live になったあとで 1 本目の `incomplete` が終われば上の `incomplete → expired` / `incomplete → cancelled` の行 (live でないので衝突しない・家族は同じプランの live な行があれば戻さない)。1 本目が後から支払完了したら上の `incomplete → active / trialing` の行のガードで `BILL_LIVE_ROW_CONFLICT` (§13.3) |
| `incomplete` / `cancelled` / `expired` / 行なし (live な行が無い)、または live な行が M (`stripe_subscription_id IS NULL`) | 解約の予約 `POST /api/billing/subscription/cancel`・解約の取り消し `POST /api/billing/subscription/resume` | — (行は変わらない) | `findLiveSubscription` が null、または返した行の `stripe_subscription_id` が NULL (§8.6 `scheduleCancellation` / `revokeCancellation`) | 409 `BILL_NO_LIVE_SUBSCRIPTION` (§9.5・§13.1)。Stripe を呼ばない・写像も監査もしない。手動付与の行の解約は配線の画面。凍結中の `resume` はこの検査より前に middleware が 403 (上の凍結の行)。テスト 31 |
| `trialing` / `active` / `past_due` / `grace` / `paused` (S・予約なし) | 解約の取り消し `POST /api/billing/subscription/resume` | — (変わらない) | live かつ S で `cancel_at_period_end` が false | 409 `BILL_CANCEL_NOT_SCHEDULED` (§9.5・§13.1)。Stripe を呼ばない・写像も監査もしない。テスト 31 |
| `trialing` / `active` / `past_due` / `grace` / `paused` (S・予約中) | 解約の予約 `POST /api/billing/subscription/cancel` (2 回目) | — (変わらない) | live かつ S で `cancel_at_period_end` が true | 何もしない (Stripe を呼ばない・写像も監査もしない)。200 で同じ要約を返す (冪等。§9.5)。テスト 31 |
| `cancelled` / `expired` | 新規購入 | 新しい行が `trialing` / `active` (古い行は履歴) | 他に live 行が無い | S1 と同じ |
| 任意 | 同じ `event.id` の再配信 (処理済み) | — | `claim` = `completed` | 200 `{ received: true, duplicate: true }` |
| 任意 | 同じ `event.id` の再配信 (ほかが処理中で 15 分以内) | — | `claim` = `in_progress` | 409 `{ error: 'event_in_progress' }` (Stripe が後で再送する) |
| 任意 | 同じ `event.id` の再配信 (`failed`、または 15 分を過ぎた `processing`) | 写像の結果どおり | `claim` = `claimed` | 再処理 (`attempt_count` +1) |
| 任意 | 鮮度の古い取り直し (`fetched_at <= stripe_synced_at`) | — | — | `skipped: 'stale'` |
| 任意 | 利用者が退会済みで、Stripe の status が終端 (`canceled` / `incomplete_expired`) (退会で解約した契約の `deleted` など) (写像) | — | 解決した利用者が `auth.users` に無い、または metadata.user_id の無い契約で、顧客の対応表の行が退会で匿名化済み (`user_id IS NULL AND anonymized_at IS NOT NULL`。§6.4 (9) の 1.) | `skipped: 'user_deleted'` (何も書かない。`invoice.payment_failed` の監査も書かない)。対応表の行が `user_id IS NULL` で `anonymized_at` が無い (退会の手順を通らずに利用者が消えた) metadata の無い契約は `BILL_UNKNOWN_USER` (§13.3) |
| – (退会のあとで Stripe に残った終端でない契約: `billing_recheck` の列挙のあと `deleteUser` までの一瞬に完了した Checkout の契約) | 退会済みの利用者の契約のイベントの取り直し (写像の入口 `syncSubscription`。Webhook・配線の reconcile) で、Stripe の status が終端でない | – (行は作らない) | 上の行と同じく `skipped: 'user_deleted'` で、`customer_closed` = true (契約の顧客の対応表の行の `user_id` が NULL = この環境で退会した利用者の顧客。§6.4 (9) の 1.) | `syncSubscription` が Stripe で即時解約 (`DELETE /subscriptions/{id}`。返金なし)・監査 `system.billing.orphan_subscription_cancelled` (warn・`target_type: 'stripe_subscription'`・`target_id: NULL`・`details: { stripe_subscription_id, stripe_status, source }`)・200。続く `deleted` は上の行 (終端) で何もしない。解約が失敗したら例外 → `failed`・500 → Stripe の再送の取り直しでやり直す。`customer_closed` が false (対応表に無い顧客 = 同じ Stripe のテスト用アカウントを使う別の環境の契約、または運営が metadata の `user_id` を書き間違えた契約) は解約せず上の行と同じ (§18 の 17)。S10 |

§8.1 `STRIPE_EVENT_ACTIONS` の 12 種のイベントはどれも「取り直しの合図」で、写像はイベントの種類を見ない (§4.1 の 2.)。遷移先は取り直した Stripe の status と行の現在の status で決まり、上の行のどれかに当たる (イベントの名を挙げた行は、そのイベントで起きる典型を書いたもの)。イベントの種類で振る舞いが変わるのは、`invoice.payment_failed` の監査 `system.payment.failed` と、請求に `subscription` が無い請求のイベントの `skipped` だけ (§8.6)。

表に無い遷移を作るコードは blocking。`past_due → grace` と `grace → cancelled` の時間による遷移は配線の冊の所有 (本冊はガードの値 7 日 / 23 日を `05` §9 のとおり引き継ぐ。`04` §5.3 の「7 日後に cancelled」は誤りとして追随表に載せる)。

---

## 8. 正典コード

モジュールの置き方 (モジュラーモノリス。`src/lib/billing/` が課金モジュール、route と画面はその facade だけを呼ぶ):

| ファイル | 役割 | import してよいもの |
|---|---|---|
| `src/lib/billing/core.ts` | 定数・Zod・型・純関数・ポート (interface)・エラー型。**I/O を持たない** | `zod` だけ |
| `src/lib/billing/stripe-gateway.ts` | `StripeGateway` の実装 (fetch。REST + form-encode) | `core`・`@/lib/env`・`@/lib/db-logger` |
| `src/lib/billing/repository.ts` | `BillingRepository` の実装 (service_role の RPC と SELECT) | `core`・`@/lib/supabase/server`・`@/types/database.types` |
| `src/lib/billing/service.ts` | ユースケース (facade)。route はこれだけを呼ぶ | `core`・`@/lib/db-logger`・`@/lib/site-config`・`@/lib/plan/entitlements` だけ。**`stripe-gateway`・`repository`・`@/lib/env` を import しない** (実装は route が作って `deps` で渡す。service が `stripe-gateway` を import すると、`@/lib/env` を通って Stripe を呼ばない GET の route まで AI の入口の棚卸し (§2.2 F24) に載る) |
| `src/lib/billing/http.ts` | `BillingError` / `StripeApiError` / `AuthError` → `NextResponse` の対応と 400 の本文 | `core`・`next/server`・`@/lib/api/errors`・`@/lib/auth/errors` |
| `src/lib/billing/auth.ts` | 凍結 (BAN) 中も通す 3 本の route の認証 `requireUserAllowingFrozen` (§9.8) | `@/lib/supabase/server`・`@/lib/auth/errors` だけ (`@/lib/env` に届くものを import しない。Stripe を呼ばない GET の route も使うため。F24) |
| `src/lib/billing/public-plans.ts` | `/pricing` が読む「買えるプラン」の一覧 (RLS を通る client) | `core`・`@/lib/supabase/server`・`@/lib/db-logger` (`@/lib/env` に届くものを import しない。`/pricing` はページなので AI の印に届いてはいけない。F24) |
| `src/lib/billing/account-deletion.ts` | 退会の段階 `billing` / `billing_recheck` (§11) | `core`・`stripe-gateway`・`repository`・`@/lib/account-deletion` (型だけ) |
| `src/lib/webhook/verify.ts` | Stripe の署名の確認を足す (§8.3) | 既存のまま + `@/lib/env` |

### 8.0 正典の TS の型検査の手順 (設計ゲート用。実装者は読まなくてよい)

印 (`place=` / `append=` / `insert=`) の付いたブロックを、実装と同じ置き場所に置き・足し・差し込み、段 A の再生成で出る DB の型の形 (下の `DB_TYPES`。§6 の表・列・関数から、`supabase gen types` の規則 = 既定値のある引数は省略可で `null` を受けない・`void` は `undefined`・`interval` は `unknown`・`jsonb` は `Json` で書いたもの) を `src/types/database.types.ts` に足して、リポジトリ全体を `tsc --noEmit` で検査する。§11 の差分の抜粋 (印の無い `tsc:skip`) は、同じ差分を下の `editAccountDeletion` が差し込む。書き換えたファイルは終わったら元に戻す (同じ作業場所で流し直しても結果が同じになる)。

流し方: offload の行き先 (リポジトリの根) で、下の js ブロックの中身を `node -e` で流す (例: 手元で `awk '/^\/\/ design-module-check/{f=1} f&&/^```$/{exit} f' docs/design/billing/01-billing-core.md` で取り出し、`offload --host auto -e TZ=UTC -- node -e "<取り出した中身>"`)。合格は `DESIGN_MODULE_TSC rc=0 errors_total=0`。ブランチの根が `origin/main` より古いと、根に無い既存のモジュール (例: `src/lib/api/reject-null-character.ts` (#1657)) で落ちるので、そのときは行き先で `origin/main` の木 (公開のリポジトリから `git fetch` → `git archive` で一時の場所に展開し、`node_modules` をつなぎ、本書を写す) の上で同じ js を流す (`main にマージ済みのものが正`)。M2 では流さない。

```js
// design-module-check — billing/01 §8.0。印の付いた ts ブロックを置き場所に置いて、リポジトリ全体を tsc で検査する
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const DOC = 'docs/design/billing/01-billing-core.md';
const DBT = 'src/types/database.types.ts';
const AD = 'src/lib/account-deletion.ts';
const originals = new Map(); // 書き換えたファイル → 元の中身 (新しく作ったファイルは null)
const createdDirs = [];
const fail = (message) => { throw new Error('DESIGN_MODULE_CHECK_PATCH_FAILED ' + message); };
const read = (file) => fs.readFileSync(file, 'utf8');
function write(file, text) {
  if (!originals.has(file)) originals.set(file, fs.existsSync(file) ? read(file) : null);
  const created = fs.mkdirSync(path.dirname(file), { recursive: true });
  if (created) createdDirs.push(created);
  fs.writeFileSync(file, text);
}
function replaceOnce(file, from, to) {
  const text = read(file);
  if (text.split(from).length !== 2) fail(file + ' ' + JSON.stringify(from.slice(0, 80)));
  write(file, text.replace(from, () => to));
}
function insertAfter(file, anchor, addition) { replaceOnce(file, anchor, anchor + addition); }
const EXISTING_LINES = /^[ \t]*\/\/ ▼ 既存[\s\S]*?^[ \t]*\/\/ ▲ 既存[^\n]*\n/m;
function placeBlocks() {
  const doc = read(DOC);
  const re = /^```ts[^\n]*\n([\s\S]*?)^```/gm;
  let match;
  let count = 0;
  while ((match = re.exec(doc))) {
    const body = match[1];
    const first = body.slice(0, body.indexOf('\n'));
    const place = /\bplace=(\S+)/.exec(first);
    const append = /\bappend=(\S+)/.exec(first);
    const insert = /\binsert=(\S+)/.exec(first);
    if (place) write(place[1], body);
    else if (append) write(append[1], read(append[1]) + '\n' + body.replace(EXISTING_LINES, ''));
    else if (insert && insert[1] === 'src/lib/env.ts') {
      const text = read(insert[1]);
      const entry = text.indexOf('\n  STRIPE_SECRET_KEY: {');
      const close = entry < 0 ? -1 : text.indexOf('\n  },\n', entry);
      if (close < 0) fail('env.ts の STRIPE_SECRET_KEY の項目');
      const at = close + '\n  },\n'.length;
      write(insert[1], text.slice(0, at) + body + text.slice(at));
    } else if (insert && insert[1] === 'src/lib/rate-limit.ts') {
      replaceOnce(insert[1], "  | 'client-log';", "  | 'client-log'\n  | 'billing';");
      insertAfter(insert[1], 'const CATEGORY_RULES: Record<RateLimitCategory, readonly RateRule[]> = {\n', body);
    } else if (insert) fail('知らない insert= ' + insert[1]);
    else continue;
    count += 1;
  }
  return count;
}
function editAccountDeletion() {
  // §11 の差分の抜粋と同じ差分 (段階 2 つ・params.billing・import・2 回の呼び出し・最後のログ)
  replaceOnce(AD, "  | 'check_blockers'\n  | 'prepare'", "  | 'check_blockers'\n  | 'billing'\n  | 'prepare'");
  replaceOnce(AD, "  | 'storage'\n  | 'delete_user';", "  | 'storage'\n  | 'billing_recheck'\n  | 'delete_user';");
  replaceOnce(AD, '  now?: () => Date;\n}', '  now?: () => Date;\n  billing?: AccountDeletionBilling;\n}');
  insertAfter(AD, "import { notifyAccountDeleted, readAccountDeletionEmail } from '@/lib/account-deletion-notification';\n",
    "import { defaultAccountDeletionBilling } from '@/lib/billing/account-deletion';\n");
  insertAfter(AD, '    completionEmailTo = await readAccountDeletionEmail(admin, userId, { log, requestId });\n',
    "\n    step = 'billing';\n    const billing = params.billing ?? defaultAccountDeletionBilling;\n" +
    "    const billingReport = await billing.cancelForAccountDeletion(userId, userLog, 'billing');\n");
  replaceOnce(AD, "    step = 'delete_user';\n",
    "    step = 'billing_recheck';\n    const billingRecheckReport = await billing.cancelForAccountDeletion(userId, userLog, 'billing_recheck');\n\n" +
    "    step = 'delete_user';\n");
  replaceOnce(AD, 'prepare: prepareReport ?? null, storage });',
    'prepare: prepareReport ?? null, storage, billing: billingReport, billing_recheck: billingRecheckReport });');
}
const DB_TYPES = {
  tables:
    '      billing_customers: {\n' +
    '        Row: { anonymized_at: string | null; created_at: string; stripe_customer_id: string; updated_at: string; user_id: string | null }\n' +
    '        Insert: { anonymized_at?: string | null; created_at?: string; stripe_customer_id: string; updated_at?: string; user_id?: string | null }\n' +
    '        Update: { anonymized_at?: string | null; created_at?: string; stripe_customer_id?: string; updated_at?: string; user_id?: string | null }\n' +
    '        Relationships: []\n' +
    '      }\n',
  functions:
    '      billing_apply_stripe_subscription: { Args: { p_fetched_at: string; p_snapshot: Json; p_source: string }; Returns: Json }\n' +
    '      billing_claim_stripe_event: {\n' +
    '        Args: { p_event_id: string; p_event_type: string; p_payload: Json; p_stuck_after?: unknown }\n' +
    '        Returns: string\n' +
    '      }\n' +
    '      billing_finish_stripe_event: { Args: { p_error?: string; p_event_id: string; p_ok: boolean }; Returns: undefined }\n',
  columns: {
    personal_subscriptions: [
      ['billing_interval', 'string | null'], ['cancel_at_period_end', 'boolean'], ['stripe_status', 'string | null'], ['stripe_synced_at', 'string | null'],
    ],
    stripe_webhook_events: [['attempt_count', 'number'], ['processing_started_at', 'string | null']],
  },
};
function addDbTypes() {
  insertAfter(DBT, '  public: {\n    Tables: {\n', DB_TYPES.tables);
  insertAfter(DBT, '    Functions: {\n', DB_TYPES.functions);
  for (const [table, columns] of Object.entries(DB_TYPES.columns)) {
    let text = read(DBT);
    let pos = text.indexOf('\n      ' + table + ': {\n');
    if (pos < 0) fail('database.types の ' + table);
    for (const part of ['Row', 'Insert', 'Update']) {
      const head = '\n        ' + part + ': {\n';
      const at = text.indexOf(head, pos);
      if (at < 0) fail(table + '.' + part);
      const lines = columns.map(([name, type]) => '          ' + name + (part === 'Row' ? ': ' : '?: ') + type + '\n').join('');
      pos = at + head.length;
      text = text.slice(0, pos) + lines + text.slice(pos);
    }
    write(DBT, text);
  }
}
let exitCode = 1;
try {
  const placed = placeBlocks();
  editAccountDeletion();
  addDbTypes();
  console.log('DESIGN_MODULE_BLOCKS placed=' + placed + ' files=' + [...originals.keys()].sort().join(','));
  let out = '';
  let tscStatus = 0;
  try {
    out = cp.execSync('npx tsc --noEmit --incremental false -p tsconfig.json --pretty false', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    tscStatus = typeof error.status === 'number' ? error.status : 1;
    out = String(error.stdout || '') + String(error.stderr || '');
  }
  const errors = out.split('\n').filter((line) => /error TS\d+/.test(line));
  const inDesign = errors.filter((line) => [...originals.keys()].some((file) => line.startsWith(file + '(')));
  if (errors.length > 0) console.log(errors.join('\n'));
  else if (tscStatus !== 0) console.log(out.slice(-2000)); // tsc が型の誤り以外で落ちた (起動できない等)。合格にしない
  console.log('DESIGN_MODULE_TSC rc=' + tscStatus + ' errors_total=' + errors.length + ' errors_in_design_files=' + inDesign.length);
  exitCode = tscStatus === 0 && errors.length === 0 ? 0 : 1;
} catch (error) {
  console.log(String(error && error.message ? error.message : error));
  exitCode = 2;
} finally {
  for (const [file, text] of originals) {
    if (text === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, text);
  }
  for (const dir of createdDirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
```

### 8.1 `src/lib/billing/core.ts` (正典。型検査済みの形)

```ts
// place=src/lib/billing/core.ts — 課金の核の定数・Zod・型・純関数・ポート。I/O を持たない (fetch / DB / env を読まない)。
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数 (根拠つき。運用で変える値は無い — すべて Stripe の仕様か本冊の契約に固定される)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stripe API の版。すべての REST 呼び出しに `Stripe-Version` ヘッダーで付ける (アカウントの既定の版に依存しない)。
 * この版では Subscription の current_period_start / current_period_end が最上位にあり、Invoice の subscription が最上位の文字列
 * (2025-03-31.basil 以降は SubscriptionItem / invoice.parent に移る)。版を上げるときは §8.1 の Zod と §6.4 の snapshot を一緒に見直す。
 * operator/05 §15 が名指しした版と同じ。
 */
export const STRIPE_API_VERSION = '2024-12-18.acacia';
export const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
/** Stripe が署名を載せるヘッダー (小文字で読む。Headers.get は大文字小文字を区別しない) */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/**
 * Webhook の本文の上限 (バイト)。Stripe のイベントは数十 KB (invoice は lines を含む) で、1 MiB を超えるものは届かない。
 * 署名を確かめる前に巨大な本文で HMAC・JSON の処理をさせないための上限 (Resend の受け口の 256 KiB と同じ考え方。Stripe の方が大きい)
 */
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
/** processing のままこの時間を過ぎたイベントは、再送で再び処理の権利を取れる (billing_claim_stripe_event の p_stuck_after。関数の最長実行時間 maxDuration を十分に超える値) */
export const STRIPE_EVENT_STUCK_MINUTES = 15;
/**
 * Webhook の route の最長実行時間 (秒)。Stripe の取り直し 1 回 + RPC 1 回で足りる値 (Vercel の既定 10 秒だと Stripe が遅いときに切れる)。
 * route の `export const maxDuration` は Next の route segment config で、静的解析できるリテラルしか書けない (import した定数は解析されない)。
 * そのため route には同じ値を数値リテラルで書き、この定数と一致することを tests/webhooks-stripe-route.test.ts (テスト 86) が見張る。
 */
export const STRIPE_WEBHOOK_MAX_DURATION_SECONDS = 30;
/** Stripe の list API の 1 ページの件数の上限 (Stripe の仕様の最大値)。退会で顧客の契約を列挙するときに使う */
export const STRIPE_LIST_PAGE_LIMIT = 100;
/** stripe_webhook_events.error_message に残す長さ (固定のコードだけを入れるので十分) */
export const STRIPE_EVENT_ERROR_MAX_CHARS = 500;
/** Checkout / Portal の表示言語 */
export const STRIPE_LOCALE = 'ja';
/** サブスクリプションの数量は常に 1 (座席課金はしない) */
export const CHECKOUT_LINE_ITEM_QUANTITY = 1;
/** Stripe が success_url の中で Checkout Session の id に置き換える文字列 (Stripe の仕様) */
export const CHECKOUT_SESSION_ID_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';
export const BILLING_PAGE_PATH = '/account/billing';
export const BILLING_CHECKOUT_PAGE_PATH = '/account/billing/checkout';
export const CHECKOUT_RESULT_QUERY = 'checkout';
export const CHECKOUT_RESULT_SUCCESS = 'success';
export const CHECKOUT_RESULT_CANCELLED = 'cancelled';
export const CHECKOUT_SESSION_QUERY = 'session_id';
/** Stripe の Idempotency-Key (顧客の作成)。同じ利用者の同時の 2 本が同じ顧客を返すようにする。Stripe はキーを 24 時間覚える */
export const CUSTOMER_IDEMPOTENCY_KEY_PREFIX = 'billing-customer:';
/** 無料プランの plan_key (docs/design/CLAUDE.md 横断ルール A で許された唯一のハードコード) */
export const FREE_PLAN_KEY = 'free';
/** 試用の出どころ (personal_subscriptions.trial_source) */
export const TRIAL_SOURCE_CHECKOUT = 'checkout';
/** 1 秒のミリ秒 */
export const MS_PER_SECOND = 1000;
/** アドバイザリロックの接頭辞 (cross/02 §6.2 の命名。SQL 側 §6.4 と同じ文字列) */
export const BILLING_LOCK_PREFIX_USER = 'billing-user:';
export const BILLING_LOCK_PREFIX_SUBSCRIPTION = 'stripe-subscription:';

export const PURCHASABLE_PLAN_TYPES = ['personal', 'family'] as const;
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** Stripe の Subscription.status の全 8 値 (Stripe の仕様) */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];
/** Stripe がそこから別の status に戻さない終端の値 (Stripe の仕様)。退会の解約はこれ以外を解約する */
export const STRIPE_TERMINAL_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired'] as const satisfies readonly StripeSubscriptionStatus[];
export function isTerminalStripeStatus(value: StripeSubscriptionStatus): boolean {
  return (STRIPE_TERMINAL_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/** personal_subscriptions.status の全 8 値 (§6.2 の CHECK と同じ) */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'trialing',
  'active',
  'paused',
  'cancelled',
  'expired',
  'past_due',
  'grace',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
/** 利用者ごとに 1 行だけ持てる「終わっていない」状態 (部分 UNIQUE idx_personal_subscriptions_active_per_user の述語と同じ) */
export const LIVE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'paused', 'past_due', 'grace'] as const satisfies readonly SubscriptionStatus[];
/** 権利が効く状態 (DB の get_effective_plan と同じ。paused は対象外) */
export const ENTITLED_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'grace', 'past_due'] as const satisfies readonly SubscriptionStatus[];

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}
export function isLiveStatus(value: string): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}
export function isBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}

/**
 * Stripe の status → DB の status の写像 (正本は §6.4 の SQL。ここは画面の表示とテストの期待値のための同じ表)。
 * 保持の規則 (grace / paused を保つ) は現在の行を見る必要があるので SQL だけが持つ。
 */
export const STRIPE_TO_DB_STATUS: Readonly<Record<StripeSubscriptionStatus, SubscriptionStatus>> = {
  incomplete: 'incomplete',
  incomplete_expired: 'expired',
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',
  paused: 'expired',
};

// ─────────────────────────────────────────────────────────────────────────────
// イベントの振り分け (受け取るイベントは Stripe の Dashboard でこの一覧だけを登録する。§17)
// ─────────────────────────────────────────────────────────────────────────────

export const STRIPE_EVENT_ACTIONS = {
  'checkout.session.completed': 'sync_checkout_session',
  'customer.subscription.created': 'sync_subscription',
  'customer.subscription.updated': 'sync_subscription',
  'customer.subscription.deleted': 'sync_subscription',
  'customer.subscription.paused': 'sync_subscription',
  'customer.subscription.resumed': 'sync_subscription',
  // 次の 3 つと invoice.payment_action_required も、ほかと同じ「取り直しの合図」(写像はイベントの種類を見ない)。
  // 遷移は §7.3 の trial_will_end / pending_update_applied / pending_update_expired / payment_action_required の行
  'customer.subscription.trial_will_end': 'sync_subscription',
  'customer.subscription.pending_update_applied': 'sync_subscription',
  'customer.subscription.pending_update_expired': 'sync_subscription',
  'invoice.paid': 'sync_invoice_subscription',
  'invoice.payment_action_required': 'sync_invoice_subscription',
  'invoice.payment_failed': 'audit_payment_failed_and_sync',
} as const;
export type StripeEventAction = (typeof STRIPE_EVENT_ACTIONS)[keyof typeof STRIPE_EVENT_ACTIONS] | 'ignore';
/** Dashboard に登録するイベントの一覧 (順序は固定。§17 の手順と tests/billing-core.test.ts が突き合わせる) */
export const STRIPE_SUBSCRIBED_EVENT_TYPES = Object.keys(STRIPE_EVENT_ACTIONS) as ReadonlyArray<keyof typeof STRIPE_EVENT_ACTIONS>;

export function classifyStripeEvent(eventType: string): StripeEventAction {
  const table: Readonly<Record<string, StripeEventAction>> = STRIPE_EVENT_ACTIONS;
  return Object.hasOwn(table, eventType) ? table[eventType] : 'ignore';
}

// ─────────────────────────────────────────────────────────────────────────────
// 監査 (admin_audit_logs.action_type)。system.* は actor_id = NULL、user.* は actor_id = 本人
// ─────────────────────────────────────────────────────────────────────────────

export const BILLING_AUDIT_ACTIONS = [
  'user.billing.checkout_started',
  'user.billing.cancel_scheduled',
  'user.billing.cancel_revoked',
  'system.billing.subscription_created',
  'system.billing.subscription_status_changed',
  'system.payment.failed',
  'system.stripe.event_failed',
  'system.billing.account_deletion_stripe_cancelled',
  'system.billing.orphan_subscription_cancelled',
] as const;
export type BillingAuditAction = (typeof BILLING_AUDIT_ACTIONS)[number];
export type BillingAuditSeverity = 'info' | 'warn' | 'critical';
/**
 * admin_audit_logs.target_type (varchar(30)・NULL 可) に入れる値。
 * 'user' = target_id は利用者の id。'stripe_event' = 利用者を解決できない Webhook の失敗 (system.stripe.event_failed)。
 * 'stripe_subscription' = 退会した利用者の顧客に残った契約を解約した (system.billing.orphan_subscription_cancelled。利用者はもういない)。
 * 後の 2 つは target_id を NULL にし、Stripe の id は details に入れる (target_id は uuid 型なので evt_… / sub_… は入らない)
 */
export const BILLING_AUDIT_TARGET_TYPES = ['user', 'stripe_event', 'stripe_subscription'] as const;
export type BillingAuditTargetType = (typeof BILLING_AUDIT_TARGET_TYPES)[number];
/**
 * 監査の details の値。admin_audit_logs.details は jsonb (生成された型は Json) なので、JSON にそのまま入る値だけにする
 * (unknown を許すと repository.ts の insert で Json に代入できない)
 */
export type BillingAuditDetailValue = string | number | boolean | null;
export type BillingAuditEntry =
  | {
      actor_id: string | null;
      action_type: Exclude<BillingAuditAction, 'system.stripe.event_failed' | 'system.billing.orphan_subscription_cancelled'>;
      target_type: 'user';
      /** 利用者の id */
      target_id: string;
      severity: BillingAuditSeverity;
      /** 個人情報 (メール・氏名・カード) と秘密を入れない */
      details: Record<string, BillingAuditDetailValue>;
    }
  | {
      actor_id: null;
      action_type: 'system.stripe.event_failed';
      target_type: 'stripe_event';
      target_id: null;
      severity: BillingAuditSeverity;
      /** { event_id, event_type, error_code } だけ */
      details: { event_id: string; event_type: string; error_code: string };
    }
  | {
      actor_id: null;
      action_type: 'system.billing.orphan_subscription_cancelled';
      target_type: 'stripe_subscription';
      target_id: null;
      severity: BillingAuditSeverity;
      /** { stripe_subscription_id, stripe_status (解約する前の Stripe の status), source (写像の p_source と同じ) } だけ */
      details: { stripe_subscription_id: string; stripe_status: StripeSubscriptionStatus; source: string };
    };

// ─────────────────────────────────────────────────────────────────────────────
// エラー (応答の本文は固定の文。生のエラー文は入れない)
// ─────────────────────────────────────────────────────────────────────────────

/** 本冊のエラーコードと HTTP ステータス。[NEW] の行は cross/04 §4.2 に追記する (§16.2) */
export const BILLING_ERROR_HTTP_STATUS = {
  BILL_INVALID_INPUT: 400,
  BILL_PLAN_NOT_PURCHASABLE: 422,
  BILL_CUSTOMER_NOT_FOUND: 404,
  BILL_NO_LIVE_SUBSCRIPTION: 409,
  BILL_CANCEL_NOT_SCHEDULED: 409,
  BILL_CHECKOUT_SESSION_MISMATCH: 403,
  OP_SUBSCRIPTION_ALREADY_ACTIVE: 409,
  EXT_STRIPE_NOT_CONFIGURED: 503,
  EXT_STRIPE_API_FAILED: 502,
} as const;
export type BillingErrorCode = keyof typeof BILLING_ERROR_HTTP_STATUS;

export const BILLING_ERROR_MESSAGES: Readonly<Record<BillingErrorCode, string>> = {
  BILL_INVALID_INPUT: '入力値が不正です',
  BILL_PLAN_NOT_PURCHASABLE: 'このプランは現在お申し込みできません',
  BILL_CUSTOMER_NOT_FOUND: 'お支払い情報がまだありません',
  BILL_NO_LIVE_SUBSCRIPTION: '有効な契約がありません',
  BILL_CANCEL_NOT_SCHEDULED: '解約は予約されていません',
  BILL_CHECKOUT_SESSION_MISMATCH: 'このお申し込みは確認できません',
  OP_SUBSCRIPTION_ALREADY_ACTIVE: 'すでに有効な契約があります',
  EXT_STRIPE_NOT_CONFIGURED: 'お支払いを受け付けていません',
  EXT_STRIPE_API_FAILED: '決済サービスとの通信に失敗しました。しばらくしてからお試しください',
};

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  constructor(code: BillingErrorCode) {
    super(BILLING_ERROR_MESSAGES[code]);
    this.name = 'BillingError';
    this.code = code;
  }
}

/** STRIPE_SECRET_KEY が無い (503)。message に変数名を入れない (#1182・#1434) */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super('決済サービスの設定がありません');
    this.name = 'StripeNotConfiguredError';
  }
}

/** Stripe の REST が 2xx 以外を返した (502)。生の文面は rawMessage に持ち、ログにだけ残す (応答の本文には出さない) */
export class StripeApiError extends Error {
  readonly status: number;
  readonly stripeType: string | null;
  readonly stripeCode: string | null;
  readonly requestId: string | null;
  readonly rawMessage: string | null;
  constructor(input: { status: number; stripeType?: string | null; stripeCode?: string | null; requestId?: string | null; rawMessage?: string | null }) {
    super('Stripe API の呼び出しに失敗しました');
    this.name = 'StripeApiError';
    this.status = input.status;
    this.stripeType = input.stripeType ?? null;
    this.stripeCode = input.stripeCode ?? null;
    this.requestId = input.requestId ?? null;
    this.rawMessage = input.rawMessage ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe のオブジェクト (本冊が読む項目だけ。looseObject = 知らない項目は捨てずに通す)
// ─────────────────────────────────────────────────────────────────────────────

const UnixSeconds = z.number().int();
const StripeMetadata = z.record(z.string(), z.string());

export const StripePriceSchema = z.looseObject({
  id: z.string(),
  recurring: z.looseObject({ interval: z.string() }).nullable().optional(),
});
export const StripeSubscriptionItemSchema = z.looseObject({
  id: z.string(),
  price: StripePriceSchema,
});
export const StripeSubscriptionSchema = z.looseObject({
  id: z.string(),
  object: z.literal('subscription'),
  customer: z.string(),
  status: z.enum(STRIPE_SUBSCRIPTION_STATUSES),
  metadata: StripeMetadata.nullable().optional(),
  items: z.looseObject({ data: z.array(StripeSubscriptionItemSchema) }),
  start_date: UnixSeconds,
  current_period_start: UnixSeconds.nullable().optional(),
  current_period_end: UnixSeconds.nullable().optional(),
  trial_start: UnixSeconds.nullable().optional(),
  trial_end: UnixSeconds.nullable().optional(),
  cancel_at: UnixSeconds.nullable().optional(),
  cancel_at_period_end: z.boolean(),
  canceled_at: UnixSeconds.nullable().optional(),
  ended_at: UnixSeconds.nullable().optional(),
  pause_collection: z.looseObject({ behavior: z.string() }).nullable().optional(),
  livemode: z.boolean().optional(),
});
export type StripeSubscription = z.infer<typeof StripeSubscriptionSchema>;

export const StripeCheckoutSessionSchema = z.looseObject({
  id: z.string(),
  object: z.literal('checkout.session'),
  mode: z.string(),
  status: z.enum(['open', 'complete', 'expired']).nullable().optional(),
  url: z.string().nullable().optional(),
  client_reference_id: z.string().nullable().optional(),
  customer: z.string().nullable().optional(),
  subscription: z.string().nullable().optional(),
  metadata: StripeMetadata.nullable().optional(),
});
export type StripeCheckoutSession = z.infer<typeof StripeCheckoutSessionSchema>;

/** GET /v1/checkout/sessions?customer=…&status=open の 1 ページ (Stripe の list オブジェクト)。退会で開いたままの Session を閉じるときに使う */
export const StripeCheckoutSessionListSchema = z.looseObject({
  object: z.literal('list'),
  data: z.array(StripeCheckoutSessionSchema),
  has_more: z.boolean(),
});
export type StripeCheckoutSessionList = z.infer<typeof StripeCheckoutSessionListSchema>;

/** GET /v1/subscriptions?customer=… の 1 ページ (Stripe の list オブジェクト) */
export const StripeSubscriptionListSchema = z.looseObject({
  object: z.literal('list'),
  data: z.array(StripeSubscriptionSchema),
  has_more: z.boolean(),
});
export type StripeSubscriptionList = z.infer<typeof StripeSubscriptionListSchema>;

export const StripeCustomerSchema = z.looseObject({
  id: z.string(),
  object: z.literal('customer'),
});
export type StripeCustomer = z.infer<typeof StripeCustomerSchema>;

export const StripeBillingPortalSessionSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
});

/** invoice の subscription は acacia では最上位、basil では parent.subscription_details にある。展開されていれば { id } の形 */
const SubscriptionRef = z.union([z.string(), z.looseObject({ id: z.string() })]);
export const StripeInvoiceRefSchema = z.looseObject({
  id: z.string(),
  object: z.literal('invoice'),
  subscription: SubscriptionRef.nullable().optional(),
  parent: z
    .looseObject({
      subscription_details: z.looseObject({ subscription: SubscriptionRef.nullable().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  amount_due: z.number().int().optional(),
  attempt_count: z.number().int().optional(),
});
export type StripeInvoiceRef = z.infer<typeof StripeInvoiceRefSchema>;

/** イベントの外形。中身 (data.object) は、写しを決めるのに id と object 以外を信じない (必ず取り直す。§4.1)。支払失敗の監査の details だけは請求の値を読む (§8.6) */
export const StripeEventEnvelopeSchema = z.looseObject({
  id: z.string().startsWith('evt_'),
  object: z.literal('event'),
  type: z.string(),
  created: UnixSeconds,
  livemode: z.boolean(),
  data: z.looseObject({
    object: z.looseObject({ id: z.string().optional(), object: z.string().optional() }),
  }),
});
export type StripeEventEnvelope = z.infer<typeof StripeEventEnvelopeSchema>;

export const StripeApiErrorBodySchema = z.looseObject({
  error: z.looseObject({
    type: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    param: z.string().optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// API の入力
// ─────────────────────────────────────────────────────────────────────────────

export const CheckoutRequestSchema = z.object({
  plan_key: z.string().min(1).max(100),
  interval: z.enum(BILLING_INTERVALS),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const CheckoutSyncRequestSchema = z.object({
  session_id: z.string().startsWith('cs_').max(255),
});
export type CheckoutSyncRequest = z.infer<typeof CheckoutSyncRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// プラン
// ─────────────────────────────────────────────────────────────────────────────

/** subscription_plans の本冊が読む列 */
export interface PurchasablePlan {
  plan_key: string;
  display_name: string;
  plan_type: string;
  status: string;
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
  trial_days: number;
  stripe_price_id: string | null;
  stripe_yearly_price_id: string | null;
}

export function priceIdFor(plan: PurchasablePlan, interval: BillingInterval): string | null {
  return interval === 'month' ? plan.stripe_price_id : plan.stripe_yearly_price_id;
}
export function amountJpyFor(plan: PurchasablePlan, interval: BillingInterval): number | null {
  return interval === 'month' ? plan.monthly_price_jpy : plan.yearly_price_jpy;
}
/** 買える = public・個人/家族・free でない・その interval の Stripe Price がある・金額が正 */
export function isPurchasable(plan: PurchasablePlan, interval: BillingInterval): boolean {
  const amount = amountJpyFor(plan, interval);
  return (
    plan.status === 'public' &&
    (PURCHASABLE_PLAN_TYPES as readonly string[]).includes(plan.plan_type) &&
    plan.plan_key !== FREE_PLAN_KEY &&
    priceIdFor(plan, interval) !== null &&
    amount !== null &&
    amount > 0
  );
}
/** 同じプランの試用は 1 回だけ (operator/04 §5.2)。2 回目以降は試用なしで買える */
export function trialDaysFor(planTrialDays: number, trialAlreadyUsed: boolean): number {
  return trialAlreadyUsed ? 0 : Math.max(0, planTrialDays);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe の Subscription → snapshot (billing_apply_stripe_subscription の p_snapshot)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * interface ではなく type にする: type のオブジェクト型は暗黙の index signature を持つので、生成された型 Json
 * (RPC の p_snapshot) にそのまま代入できる (as unknown as を書かない)。StoredStripeEventPayload も同じ
 */
export type SubscriptionSnapshot = {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  /** Checkout の metadata.user_id。無ければ null (SQL が顧客の対応表・既存の行で解決する) */
  user_id: string | null;
  /** metadata.plan_key → Price からの解決。どちらも無ければ null。SQL は既存の行があればその plan_key を使い (行を作ったときに決まり、以後変わらない。§7.3)、行が無くて null なら BILL_UNKNOWN_PLAN */
  plan_key: string | null;
  stripe_price_id: string | null;
  billing_interval: BillingInterval | null;
  stripe_status: StripeSubscriptionStatus;
  pause_collection: boolean;
  start_date: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_start: string | null;
  trial_end: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  ended_at: string | null;
};

export function unixToIso(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' ? new Date(seconds * MS_PER_SECOND).toISOString() : null;
}

export function primaryPrice(sub: StripeSubscription): { priceId: string | null; interval: BillingInterval | null } {
  const item = sub.items.data[0];
  if (!item) return { priceId: null, interval: null };
  const interval = item.price.recurring?.interval ?? null;
  return { priceId: item.price.id, interval: interval !== null && isBillingInterval(interval) ? interval : null };
}

/** plan_key の解決: Checkout で付けた metadata.plan_key が最優先。無ければ Price から引いた値 (Dashboard で作られた契約) */
export function resolvePlanKey(sub: StripeSubscription, planKeyByPriceId: string | null): string | null {
  const fromMetadata = sub.metadata?.plan_key;
  if (fromMetadata && fromMetadata.length > 0) return fromMetadata;
  return planKeyByPriceId;
}

export function projectSubscription(sub: StripeSubscription, planKey: string | null): SubscriptionSnapshot {
  const { priceId, interval } = primaryPrice(sub);
  const userId = sub.metadata?.user_id;
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer,
    user_id: userId && userId.length > 0 ? userId : null,
    plan_key: planKey,
    stripe_price_id: priceId,
    billing_interval: interval,
    stripe_status: sub.status,
    pause_collection: sub.pause_collection != null,
    start_date: unixToIso(sub.start_date) ?? new Date(0).toISOString(),
    current_period_start: unixToIso(sub.current_period_start),
    current_period_end: unixToIso(sub.current_period_end),
    trial_start: unixToIso(sub.trial_start),
    trial_end: unixToIso(sub.trial_end),
    cancel_at: unixToIso(sub.cancel_at),
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: unixToIso(sub.canceled_at),
    ended_at: unixToIso(sub.ended_at),
  };
}

/** invoice から subscription の id を取り出す (acacia / basil のどちらの形でも) */
export function invoiceSubscriptionId(invoice: StripeInvoiceRef): string | null {
  const ref = invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null;
  if (ref === null) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// stripe_webhook_events.payload に残すイベントの写し (最小化。氏名・メールアドレス・住所を DB に残さない。§9.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * data.object から残す項目 (許可リスト)。値が文字列・数値・真偽・null のときだけ残す (入れ子のオブジェクトは残さない)。
 * 選んだ根拠: 処理 (§4.1) が読む id / object、既存の Finance の route (src/app/api/admin/finance/invoices/route.ts・[id]/route.ts。
 * §2.2 F25) が読む項目のうち個人を指さないもの (金額・通貨・請求書番号・期間)、Portal での解約の予約の記録 (§7.3) に要る
 * status / cancel_at_period_end / cancel_at、Checkout Session の mode。customer と subscription は別に、文字列の id に正規化して残す。
 * 残さないもの: customer_email / customer_name / customer_address / customer_phone / customer_shipping / customer_details /
 * invoice_pdf / hosted_invoice_url / lines / metadata ほか、ここに無い項目すべて
 */
export const STORED_STRIPE_EVENT_OBJECT_FIELDS = [
  'id',
  'object',
  'status',
  'mode',
  'created',
  'currency',
  'amount_due',
  'amount_paid',
  'attempt_count',
  'number',
  'period_start',
  'period_end',
  'cancel_at_period_end',
  'cancel_at',
] as const;
export type StoredStripeScalar = string | number | boolean | null;

/** billing_claim_stripe_event の p_payload に渡す写し。data.object の値は平らな値だけ (イベントそのものは型で渡せない)。type にする理由は SubscriptionSnapshot と同じ */
export type StoredStripeEventPayload = {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, StoredStripeScalar> };
};

function isStoredStripeScalar(value: unknown): value is StoredStripeScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** 文字列の id か、展開された { id } から id を取り出す (customer / subscription の参照) */
function stripeRefId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') return value.id;
  return null;
}

/**
 * イベントを DB に残す形に縮める。subscription は invoice なら acacia / basil のどちらの形からも取り
 * (invoiceSubscriptionId)、それ以外 (Checkout Session) は data.object.subscription から取って、文字列の id で最上位に置く
 */
export function minimizeStripeEventPayload(event: StripeEventEnvelope): StoredStripeEventPayload {
  const source: Readonly<Record<string, unknown>> = event.data.object;
  const object: Record<string, StoredStripeScalar> = {};
  for (const field of STORED_STRIPE_EVENT_OBJECT_FIELDS) {
    const value = source[field];
    if (isStoredStripeScalar(value)) object[field] = value;
  }
  const customer = stripeRefId(source['customer']);
  if (customer !== null) object['customer'] = customer;
  const invoice = StripeInvoiceRefSchema.safeParse(source);
  const subscription = invoice.success ? invoiceSubscriptionId(invoice.data) : stripeRefId(source['subscription']);
  if (subscription !== null) object['subscription'] = subscription;
  return { id: event.id, object: 'event', type: event.type, created: event.created, livemode: event.livemode, data: { object } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkout のパラメータ (Stripe の form-encode) と鍵のモード
// ─────────────────────────────────────────────────────────────────────────────

export type StripeFormValue = string | number | boolean | StripeFormParams | StripeFormValue[];
export interface StripeFormParams {
  [key: string]: StripeFormValue | null | undefined;
}

/** Stripe の REST は application/x-www-form-urlencoded。入れ子は a[b][0][c]=v の形。null / undefined は送らない */
export function toFormBody(params: StripeFormParams): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: StripeFormValue | null | undefined): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(prefix === '' ? key : `${prefix}[${key}]`, child);
      return;
    }
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  walk('', params);
  return pairs.join('&');
}

export interface CheckoutSessionInput {
  customerId: string;
  userId: string;
  planKey: string;
  interval: BillingInterval;
  priceId: string;
  trialDays: number;
  /** getSiteUrl() の値 (末尾の / なし) */
  siteUrl: string;
}

export function checkoutReturnUrls(siteUrl: string): { successUrl: string; cancelUrl: string } {
  const base = `${siteUrl}${BILLING_PAGE_PATH}?${CHECKOUT_RESULT_QUERY}=`;
  return {
    successUrl: `${base}${CHECKOUT_RESULT_SUCCESS}&${CHECKOUT_SESSION_QUERY}=${CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    cancelUrl: `${base}${CHECKOUT_RESULT_CANCELLED}`,
  };
}

/** POST /v1/checkout/sessions の本文 (form-encode 前)。metadata は SQL が利用者とプランを解決するのに使う */
export function buildCheckoutSessionParams(input: CheckoutSessionInput): StripeFormParams {
  const { successUrl, cancelUrl } = checkoutReturnUrls(input.siteUrl);
  const metadata: StripeFormParams = { user_id: input.userId, plan_key: input.planKey, interval: input.interval };
  const subscriptionData: StripeFormParams = { metadata };
  if (input.trialDays > 0) subscriptionData.trial_period_days = input.trialDays;
  return {
    mode: 'subscription',
    customer: input.customerId,
    client_reference_id: input.userId,
    line_items: [{ price: input.priceId, quantity: CHECKOUT_LINE_ITEM_QUANTITY }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    locale: STRIPE_LOCALE,
    allow_promotion_codes: true,
    payment_method_collection: 'always',
    metadata,
    subscription_data: subscriptionData,
  };
}

/** POST /v1/customers/{id} の本文 (退会の匿名化。'' は Stripe で「消す」の意味) */
export function buildCustomerAnonymizeParams(anonymizedAtIso: string): StripeFormParams {
  return {
    name: '',
    email: '',
    phone: '',
    description: '',
    address: '',
    shipping: '',
    metadata: { user_id: '', anonymized_at: anonymizedAtIso },
  };
}

export type StripeKeyMode = 'live' | 'test';
/** 秘密鍵の接頭辞からモードを読む。Webhook の event.livemode と突き合わせる (テストのイベントを本番で処理しない) */
export function stripeKeyMode(secretKey: string): StripeKeyMode | null {
  if (/^(sk|rk)_live_/.test(secretKey)) return 'live';
  if (/^(sk|rk)_test_/.test(secretKey)) return 'test';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 画面に返す契約の要約 (GET /api/billing/subscription)
// ─────────────────────────────────────────────────────────────────────────────

/** personal_subscriptions の本冊が読む列 (DB の型そのまま。status は string で受けて検証する) */
export interface SubscriptionRowView {
  id: string;
  plan_key: string;
  status: string;
  stripe_subscription_id: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
}

export interface BillingSummary {
  /** 個人契約の plan_key (live な行が無ければ free) */
  plan_key: string;
  /** いま効いているプラン (get_effective_plan。家族・組織を含む) */
  effective_plan_key: string;
  status: SubscriptionStatus | null;
  source: 'stripe' | 'manual' | null;
  billing_interval: BillingInterval | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  /** Billing Portal を開ける (顧客がある) */
  has_customer: boolean;
  can_purchase: boolean;
  can_cancel: boolean;
  can_resume: boolean;
}

export function summarizeSubscription(row: SubscriptionRowView | null, hasCustomer: boolean, effectivePlanKey: string): BillingSummary {
  const status = row !== null && isSubscriptionStatus(row.status) ? row.status : null;
  const live = status !== null && isLiveStatus(status);
  const stripeBacked = row !== null && row.stripe_subscription_id !== null;
  const interval = row !== null && row.billing_interval !== null && isBillingInterval(row.billing_interval) ? row.billing_interval : null;
  return {
    plan_key: live && row !== null ? row.plan_key : FREE_PLAN_KEY,
    effective_plan_key: effectivePlanKey,
    status,
    source: row === null ? null : stripeBacked ? 'stripe' : 'manual',
    billing_interval: interval,
    current_period_end: row?.current_period_end ?? null,
    trial_ends_at: row?.trial_ends_at ?? null,
    cancel_at_period_end: row?.cancel_at_period_end ?? false,
    cancel_at: row?.cancel_at ?? null,
    has_customer: hasCustomer,
    can_purchase: !live,
    can_cancel: live && stripeBacked && row !== null && !row.cancel_at_period_end,
    can_resume: live && stripeBacked && row !== null && row.cancel_at_period_end,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 契約の状態の表示文 (/account/billing と /frozen/billing が同じ文を出す。§10.3 の表)
// ─────────────────────────────────────────────────────────────────────────────

/** live な 5 値 (LIVE_SUBSCRIPTION_STATUSES) */
export type LiveSubscriptionStatus = (typeof LIVE_SUBSCRIPTION_STATUSES)[number];

/**
 * status ごとの 1 行目の文 (§10.3 の表)。active は正常なので「ご利用中」だけを出す (お支払いの問題の文を付けない)。
 * trialing は billingStatusLines が試用の終わりの日付「（X まで）」(全角の括弧。X は日付で、「まで」との間に空白を入れない) を続ける
 */
export const BILLING_STATUS_TEXT: Readonly<Record<LiveSubscriptionStatus, string>> = {
  trialing: '無料期間中',
  active: 'ご利用中',
  past_due: 'お支払いに問題があります。お支払い方法をご確認ください',
  grace: 'お支払いが確認できないため一部の機能を制限しています',
  paused: '一時停止中',
};
/** 解約の予約中の 2 行目で、日付が無いとき (cancel_at も current_period_end も NULL。Stripe の予約では起きない) の文 */
export const BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT = '期間の終わりに解約されます';
/** 画面の日付の書き方の言語 (Intl.DateTimeFormat の locales。日本語の「2026年10月21日」) */
export const BILLING_DISPLAY_LOCALE = 'ja-JP';
/**
 * 画面の日付の時間帯 (IANA の名前)。Stripe の日時は UTC の ISO で写る (§6.4) ので、利用者 (日本) の暦の日付に直す
 * (UTC のまま切ると、日本時間の 0〜9 時の終わりが前の日に見える)
 */
export const BILLING_DISPLAY_TIME_ZONE = 'Asia/Tokyo';
const BILLING_DATE_FORMAT = new Intl.DateTimeFormat(BILLING_DISPLAY_LOCALE, {
  timeZone: BILLING_DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/** ISO の日時を日本時間の日付「2026年10月21日」にする。null・日時として読めない値は null */
export function formatBillingDate(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : BILLING_DATE_FORMAT.format(time);
}

/**
 * 契約の状態の表示 (§10.3 の表)。1 行目 = status の文 (trialing は「無料期間中（2026年10月21日まで）」。日付 = trial_ends_at)、
 * 2 行目 = 解約の予約中 (cancel_at_period_end) なら「2026年11月21日に解約されます」(日付 = cancel_at、無ければ current_period_end)。
 * status が null (live な行が無い) か live でないときは空の配列 (画面は状態の文を出さない)。/account/billing と /frozen/billing が使う
 */
export function billingStatusLines(
  summary: Pick<BillingSummary, 'status' | 'trial_ends_at' | 'current_period_end' | 'cancel_at_period_end' | 'cancel_at'>,
): string[] {
  const status = LIVE_SUBSCRIPTION_STATUSES.find((value) => value === summary.status);
  if (status === undefined) return [];
  const trialEnd = status === 'trialing' ? formatBillingDate(summary.trial_ends_at) : null;
  const lines = [trialEnd === null ? BILLING_STATUS_TEXT[status] : `${BILLING_STATUS_TEXT[status]}（${trialEnd}まで）`];
  if (summary.cancel_at_period_end) {
    const cancelDate = formatBillingDate(summary.cancel_at ?? summary.current_period_end);
    lines.push(cancelDate === null ? BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT : `${cancelDate}に解約されます`);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// ポート (service.ts が使う。実装は stripe-gateway.ts / repository.ts。テストは偽物を渡す)
// ─────────────────────────────────────────────────────────────────────────────

export interface StripeGateway {
  readonly mode: StripeKeyMode | null;
  createCustomer(input: { userId: string; email: string | null }): Promise<StripeCustomer>;
  createCheckoutSession(params: StripeFormParams): Promise<StripeCheckoutSession>;
  retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscription>;
  /** 顧客の全契約 (status=all。終端の契約も含む)。has_more の間は starting_after でページを進めて全部返す */
  listCustomerSubscriptions(customerId: string): Promise<StripeSubscription[]>;
  updateCancelAtPeriodEnd(subscriptionId: string, cancelAtPeriodEnd: boolean): Promise<StripeSubscription>;
  cancelSubscriptionNow(subscriptionId: string): Promise<StripeSubscription>;
  /** 顧客の開いたままの Checkout Session (status=open)。has_more の間はページを進めて全部返す (退会。§11) */
  listOpenCheckoutSessions(customerId: string): Promise<StripeCheckoutSession[]>;
  /** Checkout Session を閉じる (POST /v1/checkout/sessions/{id}/expire)。閉じたあとは完了できない。open でない Session は Stripe が 4xx を返す */
  expireCheckoutSession(sessionId: string): Promise<StripeCheckoutSession>;
  anonymizeCustomer(customerId: string, anonymizedAtIso: string): Promise<void>;
  createBillingPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

export interface BillingCustomerRow {
  stripe_customer_id: string;
  user_id: string | null;
  anonymized_at: string | null;
}

export type ApplySubscriptionResult =
  | {
      applied: true;
      subscription_id: string;
      user_id: string;
      status_from: SubscriptionStatus | null;
      status_to: SubscriptionStatus;
      plan_key: string;
    }
  /** 古い取り直し。SQL は利用者を解決したあとで判定するので user_id は必ず入る (invoice.payment_failed の監査が使う。§8.6) */
  | { applied: false; skipped: 'stale'; subscription_id: string; user_id: string }
  /**
   * 退会済み (auth.users に無い、または metadata の無い契約で顧客の対応表が退会で匿名化済み。§6.4 (9) の 1.)。
   * customer_closed = 契約の顧客が当社の対応表にあり、その利用者が消えた (user_id IS NULL)。true で Stripe の status が終端でなければ、
   * syncSubscription が Stripe で即時解約する (§8.6・§7.3 の退会済みの行)
   */
  | { applied: false; skipped: 'user_deleted'; customer_closed: boolean };

/** billing_claim_stripe_event の戻り値。claimed = 処理する / completed = 処理済み (200) / in_progress = ほかが処理中 (409 で再送させる) */
export type StripeEventClaim = 'claimed' | 'completed' | 'in_progress';
export const STRIPE_EVENT_CLAIMS = ['claimed', 'completed', 'in_progress'] as const satisfies readonly StripeEventClaim[];
export function isStripeEventClaim(value: unknown): value is StripeEventClaim {
  return typeof value === 'string' && (STRIPE_EVENT_CLAIMS as readonly string[]).includes(value);
}

export interface BillingRepository {
  findPlan(planKey: string): Promise<PurchasablePlan | null>;
  findPlanKeyByPriceId(priceId: string): Promise<string | null>;
  /** live な行 (Stripe-backed でも手動でも) */
  findLiveSubscription(userId: string): Promise<SubscriptionRowView | null>;
  /** 同じ plan_key で trial_started_at が入った行がある (cancelled / expired の履歴を含む) */
  hasUsedTrial(userId: string, planKey: string): Promise<boolean>;
  findCustomer(userId: string): Promise<BillingCustomerRow | null>;
  /** INSERT … ON CONFLICT (user_id) DO NOTHING のあと SELECT。同時の 2 本は同じ行を返す */
  saveCustomer(userId: string, stripeCustomerId: string): Promise<BillingCustomerRow>;
  markCustomerAnonymized(stripeCustomerId: string, anonymizedAtIso: string): Promise<void>;
  /** 退会で解約する対象のうち DB が知っているもの (stripe_subscription_id があり、status が cancelled 以外。expired は Stripe の paused のことがある)。Stripe の顧客の一覧と和を取り、Stripe の終端を除いて使う (§11) */
  listStripeBackedSubscriptions(userId: string): Promise<Array<{ stripe_subscription_id: string; status: string }>>;
  applyStripeSubscription(input: { snapshot: SubscriptionSnapshot; fetchedAt: Date; source: string }): Promise<ApplySubscriptionResult>;
  /** 処理の権利を取る。DB の payload に残すのは最小化した写しだけ (route は minimizeStripeEventPayload(event) を渡す。§9.6) */
  claimStripeEvent(payload: StoredStripeEventPayload): Promise<StripeEventClaim>;
  finishStripeEvent(eventId: string, outcome: { ok: true } | { ok: false; errorCode: string }): Promise<void>;
  recordAudit(entry: BillingAuditEntry): Promise<void>;
}
```

### 8.2 設計上の約束 (core.ts に対して)

- `core.ts` は I/O を持たない。`fetch` / `process.env` / Supabase を import したら blocking。
- `STRIPE_TO_DB_STATUS` は §6.4 の `CASE` と 1 対 1 (`tests/billing-core.test.ts` (段 B。テスト 1) と `tests/integration/rls/billing-apply-subscription-rpc.test.ts` (段 A。テスト 53) の両方が、同じ 8 組をそれぞれのファイルに**リテラル**で書いて期待値に持つ。段 A のテストは core.ts を import しない。§14.2)。
- `handleStripeEvent` がイベントの `data.object` から使う (gateway・repository に渡す) 値は、写し (`personal_subscriptions`・`plan_key_cached`・`family_groups`) を決めるための `id` と (invoice のとき) `subscription` の参照と、`invoice.payment_failed` の監査 `system.payment.failed` の `details` に入れる請求の `id`・`attempt_count`・`amount_due` だけ (この 3 つは監査の記録で、写しには書かない。§8.6・S4)。それ以外の値を使う・`data.object` の値を写しに書いたら blocking (§4.1 の原理 2。テスト 33 が見る)。`StripeInvoiceRefSchema.safeParse` (`looseObject`) が知らない項目まで読むのは構わない (使わない値は捨てる)。DB に残すイベントの記録 (`minimizeStripeEventPayload`) は下の項目の許可リストで別に決める。
- `stripe_webhook_events.payload` に書いてよいのは `minimizeStripeEventPayload(event)` の戻り値だけ (`BillingRepository.claimStripeEvent` の引数の型 `StoredStripeEventPayload` で強制する)。許可リスト `STORED_STRIPE_EVENT_OBJECT_FIELDS` に氏名・メールアドレス・住所・電話・`invoice_pdf` / `hosted_invoice_url` を足したら blocking。

### 8.3 `src/lib/webhook/verify.ts` に足す Stripe の署名の確認 (純粋な部分。型検査済み)

Stripe の署名: ヘッダー `Stripe-Signature: t=<UNIX 秒>,v1=<hex>[,v1=<hex>…][,v0=…]`。署名の入力は `"<t>.<受け取った本文そのまま>"`、鍵は署名の秘密 (`whsec_…`) の文字列そのもの (Svix と違い base64 に戻さない)。許容は前後 5 分 (`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` と同じ値)。

```ts
// append=src/lib/webhook/verify.ts — verify.ts の末尾に足す部分 (下の「▼ 既存」と「▲ 既存」の印の間の import 2 行と定数 1 行は貼らない)
// ▼ 既存: verify.ts にもうある import と定数 (このブロックを単独で型検査するためだけに書く。貼らない。MS_PER_SECOND は verify.ts:39 の既存の定数をそのまま使い、
//   同じ名前を足すと TS2451 (再宣言) になる)
import crypto from 'node:crypto';
import { WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS, type WebhookVerification } from '@/lib/webhook/verify';
const MS_PER_SECOND = 1000;
// ▲ 既存: ここまで。ここから下を verify.ts の末尾に足す

/** Stripe-Signature の要素 (t=…, v1=…)。Stripe の仕様 */
const STRIPE_SIGNATURE_TIMESTAMP_KEY = 't';
const STRIPE_SIGNATURE_SCHEME = 'v1';

export interface StripeSignatureHeader {
  timestamp: string | null;
  /** v1 の署名 (hex)。秘密の入れ替えの間は 2 つ以上並ぶ */
  signatures: string[];
}

/** "t=123,v1=abc,v1=def,v0=…" を分解する。知らない要素は無視する */
export function parseStripeSignatureHeader(header: string | null): StripeSignatureHeader {
  const parsed: StripeSignatureHeader = { timestamp: null, signatures: [] };
  if (!header) return parsed;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === STRIPE_SIGNATURE_TIMESTAMP_KEY) parsed.timestamp = value;
    else if (key === STRIPE_SIGNATURE_SCHEME && value.length > 0) parsed.signatures.push(value);
  }
  return parsed;
}

/**
 * Stripe の Webhook の署名を確かめる (秘密は引数で渡す。純粋な関数)。
 * @param payload 受け取った本文そのまま (JSON として読み直したものではない)
 * @param header  Stripe-Signature ヘッダーの値 (無ければ null)
 * @param secret  署名の秘密 (whsec_…。文字列のまま鍵にする)
 * @param nowMs   いまの時刻 (テストで差し替える)
 */
export function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs: number = Date.now(),
): WebhookVerification {
  const { timestamp, signatures } = parseStripeSignatureHeader(header);
  if (!timestamp || signatures.length === 0) return { ok: false, reason: 'missing_headers' };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  const sentAtSeconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / MS_PER_SECOND);
  if (Math.abs(nowSeconds - sentAtSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  // 空の秘密では誰でも同じ署名を作れる。合わないものとして扱う
  if (secret.length === 0) return { ok: false, reason: 'signature_mismatch' };
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest();
  for (const given of signatures) {
    const bytes = Buffer.from(given, 'hex');
    // timingSafeEqual は長さが違うと例外を投げるので、先に長さをそろえて比べる
    if (bytes.length === expected.length && crypto.timingSafeEqual(bytes, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}
```

```ts
// tsc:skip append=src/lib/webhook/verify.ts — 同じ verify.ts に足す、環境変数を読む側。STRIPE_WEBHOOK_SECRET を src/lib/env.ts の一覧に足すまで型が通らない (§8.7。§8.0 の手順で一覧に足した形で検査する)
/**
 * Stripe の Webhook の署名を、環境変数 STRIPE_WEBHOOK_SECRET の秘密で確かめる。
 * 秘密が無ければ確かめられないので、受け付けずに WebhookSecretMissingError を投げる (fail-closed。route は 503)。
 */
export function verifyStripeWebhook(payload: string, header: string | null, nowMs: number = Date.now()): WebhookVerification {
  const secret = getOptionalEnv('STRIPE_WEBHOOK_SECRET');
  if (!secret || secret.trim().length === 0) throw new WebhookSecretMissingError();
  return verifyStripeSignature(payload, header, secret.trim(), nowMs);
}
```

ファイル冒頭のコメント「いまあるのは Resend の分だけ (Stripe の Webhook は未実装)」は、実装で「Resend (Svix の形) と Stripe (t/v1 の形)」に書き換える。

### 8.4 `src/lib/billing/stripe-gateway.ts` (StripeGateway の実装。fetch + form-encode)

```ts
// tsc:skip place=src/lib/billing/stripe-gateway.ts — 新設モジュール core を import するので単独の検査から外す (§8.0 の手順で、置き場所に置いて検査する)。シグネチャは §8.1 の StripeGateway と一致させる
import { getOptionalEnv } from '@/lib/env';
import { createLogger } from '@/lib/db-logger';
import {
  STRIPE_API_BASE_URL,
  STRIPE_API_VERSION,
  CUSTOMER_IDEMPOTENCY_KEY_PREFIX,
  STRIPE_LIST_PAGE_LIMIT,
  STRIPE_LOCALE,
  StripeApiError,
  StripeNotConfiguredError,
  StripeApiErrorBodySchema,
  StripeBillingPortalSessionSchema,
  StripeCheckoutSessionListSchema,
  StripeCheckoutSessionSchema,
  StripeCustomerSchema,
  StripeSubscriptionListSchema,
  StripeSubscriptionSchema,
  buildCustomerAnonymizeParams,
  stripeKeyMode,
  toFormBody,
  type StripeFormParams,
  type StripeGateway,
} from '@/lib/billing/core';
import type { z } from 'zod';

const logger = createLogger('billing/stripe-gateway');

/** 1 回の Stripe API 呼び出しの上限 (ms)。Webhook の route の maxDuration (30 秒) の中に取り直し + RPC が収まる値 */
const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

interface StripeRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** GET はクエリ文字列に、POST / DELETE は本文に form-encode する */
  params?: StripeFormParams;
  idempotencyKey?: string;
}

/**
 * STRIPE_SECRET_KEY を読んで gateway を作る。鍵が無ければ StripeNotConfiguredError (route は 503)。
 * 鍵は一覧 (src/lib/env.ts) の任意の変数なので getOptionalEnv で読む (process.env.X! とは書かない)。
 */
export function createStripeGateway(fetchImpl: typeof fetch = fetch): StripeGateway {
  const secretKey = getOptionalEnv('STRIPE_SECRET_KEY');
  if (!secretKey || secretKey.trim().length === 0) throw new StripeNotConfiguredError();
  const key = secretKey.trim();

  async function call<T>(request: StripeRequest, schema: z.ZodType<T>): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
    const init: RequestInit = { method: request.method, headers, signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS) };
    let url = `${STRIPE_API_BASE_URL}${request.path}`;
    if (request.method === 'GET') {
      const query = toFormBody(request.params ?? {});
      if (query.length > 0) url = `${url}?${query}`;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = toFormBody(request.params ?? {});
      if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
    }
    const response = await fetchImpl(url, init);
    const requestId = response.headers.get('request-id');
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsedError = StripeApiErrorBodySchema.safeParse(json);
      const error = new StripeApiError({
        status: response.status,
        stripeType: parsedError.success ? (parsedError.data.error.type ?? null) : null,
        stripeCode: parsedError.success ? (parsedError.data.error.code ?? null) : null,
        requestId,
        rawMessage: parsedError.success ? (parsedError.data.error.message ?? null) : null,
      });
      // 生の文面はここ (app_logs) にだけ残す。鍵・本文は残さない
      logger.error('Stripe API が 2xx 以外を返しました', error, {
        path: request.path, method: request.method, status: response.status,
        stripe_type: error.stripeType, stripe_code: error.stripeCode, request_id: requestId, raw_message: error.rawMessage,
      });
      throw error;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const error = new StripeApiError({ status: response.status, requestId, rawMessage: 'unexpected response shape' });
      logger.error('Stripe API の応答の形が想定と違いました', error, { path: request.path, issues: parsed.error.issues.map((i) => i.path.join('.')) });
      throw error;
    }
    return parsed.data;
  }

  /** Stripe の list API を has_more の間 starting_after で進めて全部返す (1 ページ STRIPE_LIST_PAGE_LIMIT 件) */
  async function listAll<T extends { id: string }>(
    path: string,
    params: StripeFormParams,
    schema: z.ZodType<{ data: T[]; has_more: boolean }>,
  ): Promise<T[]> {
    const all: T[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const page = await call({ method: 'GET', path, params: { ...params, limit: STRIPE_LIST_PAGE_LIMIT, starting_after: startingAfter } }, schema);
      all.push(...page.data);
      const last = page.data[page.data.length - 1];
      if (!page.has_more || last === undefined) return all;
      startingAfter = last.id;
    }
  }

  return {
    mode: stripeKeyMode(key),
    createCustomer: ({ userId, email }) =>
      call(
        {
          method: 'POST',
          path: '/customers',
          params: { email, metadata: { user_id: userId }, preferred_locales: [STRIPE_LOCALE] },
          idempotencyKey: `${CUSTOMER_IDEMPOTENCY_KEY_PREFIX}${userId}`,
        },
        StripeCustomerSchema,
      ),
    createCheckoutSession: (params) =>
      call({ method: 'POST', path: '/checkout/sessions', params, idempotencyKey: crypto.randomUUID() }, StripeCheckoutSessionSchema),
    retrieveCheckoutSession: (sessionId) =>
      call({ method: 'GET', path: `/checkout/sessions/${encodeURIComponent(sessionId)}` }, StripeCheckoutSessionSchema),
    retrieveSubscription: (subscriptionId) =>
      call({ method: 'GET', path: `/subscriptions/${encodeURIComponent(subscriptionId)}` }, StripeSubscriptionSchema),
    // status=all: 既定の一覧は canceled を含まないので、終端も含めて全部取り、呼ぶ側が終端を除く (§11)
    listCustomerSubscriptions: (customerId) =>
      listAll('/subscriptions', { customer: customerId, status: 'all' }, StripeSubscriptionListSchema),
    updateCancelAtPeriodEnd: (subscriptionId, cancelAtPeriodEnd) =>
      call(
        { method: 'POST', path: `/subscriptions/${encodeURIComponent(subscriptionId)}`, params: { cancel_at_period_end: cancelAtPeriodEnd } },
        StripeSubscriptionSchema,
      ),
    cancelSubscriptionNow: (subscriptionId) =>
      // 即時解約。日割りの返金はしない (prorate=false)。請求中の invoice はそのまま (invoice_now=false)
      call({ method: 'DELETE', path: `/subscriptions/${encodeURIComponent(subscriptionId)}`, params: { prorate: false, invoice_now: false } }, StripeSubscriptionSchema),
    // 退会: 開いたままの Checkout Session を列挙して閉じる (§11。閉じた Session は完了できない)
    listOpenCheckoutSessions: (customerId) =>
      listAll('/checkout/sessions', { customer: customerId, status: 'open' }, StripeCheckoutSessionListSchema),
    expireCheckoutSession: (sessionId) =>
      call({ method: 'POST', path: `/checkout/sessions/${encodeURIComponent(sessionId)}/expire` }, StripeCheckoutSessionSchema),
    anonymizeCustomer: async (customerId, anonymizedAtIso) => {
      await call({ method: 'POST', path: `/customers/${encodeURIComponent(customerId)}`, params: buildCustomerAnonymizeParams(anonymizedAtIso) }, StripeCustomerSchema);
    },
    createBillingPortalSession: ({ customerId, returnUrl }) =>
      call(
        { method: 'POST', path: '/billing_portal/sessions', params: { customer: customerId, return_url: returnUrl, locale: STRIPE_LOCALE } },
        StripeBillingPortalSessionSchema,
      ),
  };
}
```

- `DELETE /v1/subscriptions/{id}` の本文に `prorate=false` を付けるため、DELETE でも form-encode の本文を送る (Stripe は DELETE の本文を受け付ける)。
- `fetchImpl` はテストで差し替える (`tests/billing-stripe-gateway.test.ts`)。
- `createStripeGateway` は route の中で、認証 (`requireUser`。凍結中も通す 2 本 (`portal`・`subscription/cancel`) は `requireUserAllowingFrozen`。§9.8) のあとに呼ぶ (鍵の有無の警告ログが未認証の連打で増えないように)。

### 8.5 `src/lib/billing/repository.ts` (BillingRepository の実装。service_role)

```ts
// tsc:skip place=src/lib/billing/repository.ts — 新設モジュール core と再生成後の database.types を使うので単独の検査から外す (§8.0 の手順で、再生成後の型の形を足して置き場所で検査する)
import { getSupabaseAdmin } from '@/lib/supabase/server';
import {
  STRIPE_EVENT_STUCK_MINUTES,
  LIVE_SUBSCRIPTION_STATUSES,
  isStripeEventClaim,
  type ApplySubscriptionResult,
  type BillingAuditEntry,
  type BillingCustomerRow,
  type BillingRepository,
  type PurchasablePlan,
  type StoredStripeEventPayload,
  type StripeEventClaim,
  type SubscriptionRowView,
  type SubscriptionSnapshot,
} from '@/lib/billing/core';

/** DB の RPC が RAISE EXCEPTION '<コード>' USING ERRCODE='P0001' で返す業務エラー (apply_coupon と同じ流儀) */
export class BillingRpcError extends Error {
  readonly code: 'BILL_UNKNOWN_USER' | 'BILL_UNKNOWN_PLAN' | 'BILL_UNKNOWN_STRIPE_STATUS' | 'BILL_LIVE_ROW_CONFLICT';
  readonly detail: string | null;
  constructor(code: BillingRpcError['code'], detail: string | null) {
    super(code);
    this.name = 'BillingRpcError';
    this.code = code;
    this.detail = detail;
  }
}
const BILLING_RPC_ERROR_CODES = new Set(['BILL_UNKNOWN_USER', 'BILL_UNKNOWN_PLAN', 'BILL_UNKNOWN_STRIPE_STATUS', 'BILL_LIVE_ROW_CONFLICT']);
function toBillingRpcError(error: { code?: string; message?: string; details?: string | null }): BillingRpcError | null {
  if (error.code !== 'P0001' || typeof error.message !== 'string' || !BILLING_RPC_ERROR_CODES.has(error.message)) return null;
  return new BillingRpcError(error.message as BillingRpcError['code'], typeof error.details === 'string' ? error.details : null);
}

const PLAN_COLUMNS = 'plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id';
const SUBSCRIPTION_VIEW_COLUMNS = 'id, plan_key, status, stripe_subscription_id, billing_interval, current_period_end, trial_ends_at, cancel_at_period_end, cancel_at';

type Admin = ReturnType<typeof getSupabaseAdmin>;

export function createBillingRepository(admin: Admin = getSupabaseAdmin()): BillingRepository {
  return {
    async findPlan(planKey) {
      const { data, error } = await admin.from('subscription_plans').select(PLAN_COLUMNS).eq('plan_key', planKey).maybeSingle();
      if (error) throw error;
      return (data as PurchasablePlan | null) ?? null;
    },
    async findPlanKeyByPriceId(priceId) {
      const { data, error } = await admin
        .from('subscription_plans')
        .select('plan_key')
        .or(`stripe_price_id.eq.${priceId},stripe_yearly_price_id.eq.${priceId}`)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.plan_key ?? null;
    },
    async findLiveSubscription(userId) {
      const { data, error } = await admin
        .from('personal_subscriptions')
        .select(SUBSCRIPTION_VIEW_COLUMNS)
        .eq('user_id', userId)
        .in('status', [...LIVE_SUBSCRIPTION_STATUSES])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as SubscriptionRowView | null) ?? null;
    },
    async hasUsedTrial(userId, planKey) {
      const { count, error } = await admin
        .from('personal_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('plan_key', planKey)
        .not('trial_started_at', 'is', null);
      if (error) throw error;
      return (count ?? 0) > 0;
    },
    async findCustomer(userId) {
      const { data, error } = await admin.from('billing_customers').select('stripe_customer_id, user_id, anonymized_at').eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return (data as BillingCustomerRow | null) ?? null;
    },
    async saveCustomer(userId, stripeCustomerId) {
      // 同時の 2 本: 負けた側は何も入らず、勝った側の行を読む (Stripe の Idempotency-Key で顧客も同じものになっている)
      const { error: insertError } = await admin.from('billing_customers').insert({ user_id: userId, stripe_customer_id: stripeCustomerId });
      if (insertError && insertError.code !== '23505') throw insertError;
      const { data, error } = await admin.from('billing_customers').select('stripe_customer_id, user_id, anonymized_at').eq('user_id', userId).single();
      if (error) throw error;
      return data as BillingCustomerRow;
    },
    async markCustomerAnonymized(stripeCustomerId, anonymizedAtIso) {
      const { error } = await admin.from('billing_customers').update({ anonymized_at: anonymizedAtIso }).eq('stripe_customer_id', stripeCustomerId);
      if (error) throw error;
    },
    async listStripeBackedSubscriptions(userId) {
      const { data, error } = await admin
        .from('personal_subscriptions')
        .select('stripe_subscription_id, status')
        .eq('user_id', userId)
        .not('stripe_subscription_id', 'is', null)
        .neq('status', 'cancelled');
      if (error) throw error;
      return (data ?? []) as Array<{ stripe_subscription_id: string; status: string }>;
    },
    async applyStripeSubscription({ snapshot, fetchedAt, source }) {
      const { data, error } = await admin.rpc('billing_apply_stripe_subscription', {
        // SubscriptionSnapshot は type のオブジェクト型 (§8.1) なので、生成された型 Json にそのまま代入できる
        p_snapshot: snapshot,
        p_fetched_at: fetchedAt.toISOString(),
        p_source: source,
      });
      if (error) throw toBillingRpcError(error) ?? error;
      return data as ApplySubscriptionResult;
    },
    async claimStripeEvent(payload: StoredStripeEventPayload) {
      // payload は minimizeStripeEventPayload の写し (§8.1)。イベントの JSON 全体は受け取らない
      const { data, error } = await admin.rpc('billing_claim_stripe_event', {
        p_event_id: payload.id,
        p_event_type: payload.type,
        p_payload: payload,
        p_stuck_after: `${STRIPE_EVENT_STUCK_MINUTES} minutes`,
      });
      if (error) throw error;
      if (!isStripeEventClaim(data)) throw new Error('billing_claim_stripe_event が想定外の結果を返しました');
      return data satisfies StripeEventClaim;
    },
    async finishStripeEvent(eventId, outcome) {
      // p_error は既定値 (NULL) のある引数で、生成された型は省略可の string (null を受けない。§8.0)。成功のときは渡さない
      const args = outcome.ok
        ? { p_event_id: eventId, p_ok: true }
        : { p_event_id: eventId, p_ok: false, p_error: outcome.errorCode };
      const { error } = await admin.rpc('billing_finish_stripe_event', args);
      if (error) throw error;
    },
    async recordAudit(entry) {
      // service_role なので RLS (actor_id = auth.uid()) を通らない。呼ぶ側は必ず認証のあと (route) か Webhook の署名のあと。
      // details の型は §8.1 の 3 通り (どれも JSON の値だけ) なので、生成された型 Json にそのまま入る
      const { error } = await admin.from('admin_audit_logs').insert({
        actor_id: entry.actor_id,
        action_type: entry.action_type,
        target_id: entry.target_id,
        target_type: entry.target_type,
        severity: entry.severity,
        details: entry.details,
      });
      if (error) throw error;
    },
  };
}
```

- RPC の引数と監査の `details` は型の変換を書かない: `SubscriptionSnapshot`・`StoredStripeEventPayload` は `type` のオブジェクト型 (暗黙の index signature を持つ)、`BillingAuditEntry.details` は JSON の値だけ (`BillingAuditDetailValue`) なので、生成された型 `Json` にそのまま代入できる (§8.1)。`interface` に戻すと `Json` に代入できず、`as unknown as` が要る形になるので戻さない。
- 生成された型の規則 (段 A の再生成で出る形。§8.0): 既定値のある引数 (`p_error text DEFAULT NULL`・`p_stuck_after interval DEFAULT …`) は省略可で `null` を受けない (`p_error?: string`・`p_stuck_after?: unknown`)、`RETURNS void` は `Returns: undefined`、`jsonb` は `Json`。
- `recordAudit` の失敗は呼ぶ側 (service) が catch してログに残し、本体の操作は止めない (閲覧ログ `recordAdminAudit` と同じ fail-open)。ただし状態の変化の監査は RPC の中 (同じトランザクション) で書くので失敗しない。

### 8.6 `src/lib/billing/service.ts` (facade。route はこれだけを呼ぶ)

```ts
// tsc:skip place=src/lib/billing/service.ts — 新設モジュール同士を import するので単独の検査から外す (§8.0 の手順で、置き場所に置いて検査する)
import { createLogger } from '@/lib/db-logger';
import { getSiteUrl } from '@/lib/site-config';
import { getEffectivePlan } from '@/lib/plan/entitlements';
import {
  BILLING_PAGE_PATH,
  BillingError,
  StripeInvoiceRefSchema,
  buildCheckoutSessionParams,
  classifyStripeEvent,
  invoiceSubscriptionId,
  isPurchasable,
  isTerminalStripeStatus,
  priceIdFor,
  primaryPrice,
  projectSubscription,
  resolvePlanKey,
  summarizeSubscription,
  trialDaysFor,
  type ApplySubscriptionResult,
  type BillingAuditEntry,
  type BillingRepository,
  type BillingSummary,
  type BillingInterval,
  type StripeEventEnvelope,
  type StripeGateway,
} from '@/lib/billing/core';

const logger = createLogger('billing/service');

/**
 * Stripe を呼ばないユースケース (確認画面の内容・契約の要約) の依存。gateway を持たないので、route は createStripeGateway を
 * 呼ばず (= import せず)、鍵 (STRIPE_SECRET_KEY) が無くても 200 を返す (S11)
 */
export interface BillingReadDeps {
  repository: BillingRepository;
  /** テストで差し替える (いま)。既定は () => new Date() */
  now?: () => Date;
}

/** Stripe を呼ぶユースケースの依存 (route が createStripeGateway() で作る。鍵が無ければ StripeNotConfiguredError → 503) */
export interface BillingDeps extends BillingReadDeps {
  gateway: StripeGateway;
}

export interface CheckoutPreview {
  plan_key: string;
  display_name: string;
  interval: BillingInterval;
  amount_jpy: number;
  trial_days: number;
  can_purchase: boolean;
}

/** 監査は fail-open (閲覧ログと同じ)。失敗はログに残し、本体の操作は止めない */
async function audit(repository: BillingRepository, entry: BillingAuditEntry): Promise<void> {
  try {
    await repository.recordAudit(entry);
  } catch (error) {
    logger.error('課金の監査ログの記録に失敗しました', error, { action_type: entry.action_type });
  }
}

/** 特商法の確認画面に出す内容 (GET /api/billing/checkout/preview)。Stripe は呼ばない (gateway を受け取らない) */
export async function previewCheckout(deps: BillingReadDeps, userId: string, planKey: string, interval: BillingInterval): Promise<CheckoutPreview> {
  const plan = await deps.repository.findPlan(planKey);
  if (!plan || !isPurchasable(plan, interval)) throw new BillingError('BILL_PLAN_NOT_PURCHASABLE');
  const live = await deps.repository.findLiveSubscription(userId);
  const trialUsed = await deps.repository.hasUsedTrial(userId, planKey);
  const amount = interval === 'month' ? plan.monthly_price_jpy : plan.yearly_price_jpy;
  return {
    plan_key: plan.plan_key,
    display_name: plan.display_name,
    interval,
    amount_jpy: amount ?? 0,
    trial_days: trialDaysFor(plan.trial_days, trialUsed),
    can_purchase: live === null,
  };
}

/** Checkout Session を作り、その URL を返す (POST /api/billing/checkout) */
export async function startCheckout(
  deps: BillingDeps,
  user: { id: string; email: string | null },
  planKey: string,
  interval: BillingInterval,
): Promise<{ url: string; session_id: string }> {
  const plan = await deps.repository.findPlan(planKey);
  if (!plan || !isPurchasable(plan, interval)) throw new BillingError('BILL_PLAN_NOT_PURCHASABLE');
  const priceId = priceIdFor(plan, interval);
  if (priceId === null) throw new BillingError('BILL_PLAN_NOT_PURCHASABLE');
  if ((await deps.repository.findLiveSubscription(user.id)) !== null) throw new BillingError('OP_SUBSCRIPTION_ALREADY_ACTIVE');
  const trialDays = trialDaysFor(plan.trial_days, await deps.repository.hasUsedTrial(user.id, planKey));

  let customer = await deps.repository.findCustomer(user.id);
  if (customer === null) {
    const created = await deps.gateway.createCustomer({ userId: user.id, email: user.email });
    customer = await deps.repository.saveCustomer(user.id, created.id);
  }

  const session = await deps.gateway.createCheckoutSession(
    buildCheckoutSessionParams({ customerId: customer.stripe_customer_id, userId: user.id, planKey, interval, priceId, trialDays, siteUrl: getSiteUrl() }),
  );
  if (!session.url) throw new BillingError('EXT_STRIPE_API_FAILED');
  await audit(deps.repository, {
    actor_id: user.id, action_type: 'user.billing.checkout_started', target_type: 'user', target_id: user.id, severity: 'info',
    details: { plan_key: planKey, interval, trial_days: trialDays, checkout_session_id: session.id },
  });
  return { url: session.url, session_id: session.id };
}

/**
 * Stripe から最新の Subscription を取り直して写す (すべての写しの入口。Webhook・戻り画面・解約 API・配線の reconcile)。
 * 写像が「退会済み」で、契約の顧客が退会した利用者のもの (customer_closed) なのに Stripe の契約が終端でなければ、Stripe で即時解約する
 * (退会の段階 billing_recheck のあと deleteUser までに完了した Checkout の契約など。退会の前に開いた Checkout は退会の段階が閉じる。§7.3 の退会済みの行・§11)。
 * 解約に失敗したら例外 (Webhook は failed・500 で Stripe が再送し、取り直しで同じ判定をやり直す)。解約のあとに届く deleted は終端なので何もしない
 */
export async function syncSubscription(deps: BillingDeps, subscriptionId: string, source: string): Promise<ApplySubscriptionResult> {
  const fetchedAt = (deps.now ?? (() => new Date()))();
  const sub = await deps.gateway.retrieveSubscription(subscriptionId);
  // findPlanKeyByPriceId を呼ぶのは metadata.plan_key が無いときだけ (Dashboard で作られた契約。S13)
  const { priceId } = primaryPrice(sub);
  const planKeyByPrice = priceId !== null && !sub.metadata?.plan_key ? await deps.repository.findPlanKeyByPriceId(priceId) : null;
  const snapshot = projectSubscription(sub, resolvePlanKey(sub, planKeyByPrice));
  const result = await deps.repository.applyStripeSubscription({ snapshot, fetchedAt, source });
  if (!result.applied && result.skipped === 'user_deleted' && result.customer_closed && !isTerminalStripeStatus(sub.status)) {
    await deps.gateway.cancelSubscriptionNow(sub.id);
    await audit(deps.repository, {
      actor_id: null, action_type: 'system.billing.orphan_subscription_cancelled', target_type: 'stripe_subscription', target_id: null,
      severity: 'warn', details: { stripe_subscription_id: sub.id, stripe_status: sub.status, source },
    });
  }
  return result;
}

/** 戻り画面からの同期 (POST /api/billing/checkout/sync)。Session の持ち主が本人でなければ 403 */
export async function syncCheckoutSession(deps: BillingDeps, userId: string, sessionId: string): Promise<BillingSummary> {
  const session = await deps.gateway.retrieveCheckoutSession(sessionId);
  if (session.client_reference_id !== userId) throw new BillingError('BILL_CHECKOUT_SESSION_MISMATCH');
  if (session.status === 'complete' && session.subscription) {
    await syncSubscription(deps, session.subscription, 'checkout_sync');
  }
  return getBillingSummary(deps, userId);
}

/** 契約の要約 (GET /api/billing/subscription と、ほかのユースケースの戻り値)。Stripe は呼ばない (gateway を受け取らない) */
export async function getBillingSummary(deps: BillingReadDeps, userId: string): Promise<BillingSummary> {
  const [row, customer, effectivePlanKey] = await Promise.all([
    deps.repository.findLiveSubscription(userId),
    deps.repository.findCustomer(userId),
    getEffectivePlan(userId),
  ]);
  return summarizeSubscription(row, customer !== null, effectivePlanKey);
}

export async function createPortalSession(deps: BillingDeps, userId: string): Promise<{ url: string }> {
  const customer = await deps.repository.findCustomer(userId);
  if (customer === null) throw new BillingError('BILL_CUSTOMER_NOT_FOUND');
  return deps.gateway.createBillingPortalSession({ customerId: customer.stripe_customer_id, returnUrl: `${getSiteUrl()}${BILLING_PAGE_PATH}` });
}

/** 期間末での解約を予約する (冪等: 予約済みならそのまま要約を返す) */
export async function scheduleCancellation(deps: BillingDeps, userId: string): Promise<BillingSummary> {
  const row = await deps.repository.findLiveSubscription(userId);
  if (row === null || row.stripe_subscription_id === null) throw new BillingError('BILL_NO_LIVE_SUBSCRIPTION');
  if (!row.cancel_at_period_end) {
    const fetchedAt = (deps.now ?? (() => new Date()))();
    const sub = await deps.gateway.updateCancelAtPeriodEnd(row.stripe_subscription_id, true);
    await deps.repository.applyStripeSubscription({ snapshot: projectSubscription(sub, row.plan_key), fetchedAt, source: 'api:cancel' });
    await audit(deps.repository, {
      actor_id: userId, action_type: 'user.billing.cancel_scheduled', target_type: 'user', target_id: userId, severity: 'info',
      details: { stripe_subscription_id: row.stripe_subscription_id, plan_key: row.plan_key },
    });
  }
  return getBillingSummary(deps, userId);
}

/** 解約の予約を取り消す (予約が無ければ 409) */
export async function revokeCancellation(deps: BillingDeps, userId: string): Promise<BillingSummary> {
  const row = await deps.repository.findLiveSubscription(userId);
  if (row === null || row.stripe_subscription_id === null) throw new BillingError('BILL_NO_LIVE_SUBSCRIPTION');
  if (!row.cancel_at_period_end) throw new BillingError('BILL_CANCEL_NOT_SCHEDULED');
  const fetchedAt = (deps.now ?? (() => new Date()))();
  const sub = await deps.gateway.updateCancelAtPeriodEnd(row.stripe_subscription_id, false);
  await deps.repository.applyStripeSubscription({ snapshot: projectSubscription(sub, row.plan_key), fetchedAt, source: 'api:resume' });
  await audit(deps.repository, {
    actor_id: userId, action_type: 'user.billing.cancel_revoked', target_type: 'user', target_id: userId, severity: 'info',
    details: { stripe_subscription_id: row.stripe_subscription_id, plan_key: row.plan_key },
  });
  return getBillingSummary(deps, userId);
}

export type StripeEventOutcome = { action: 'synced' | 'ignored' | 'skipped'; detail: string };

/**
 * 処理に失敗したイベントを記録する (POST /api/webhooks/stripe の catch。§9.6 の 8)。
 * finish(ok=false) の失敗は投げる (route が 500。行は processing のまま残り、15 分後の再送で取り直す)。
 * 監査は利用者を解決できないことがあるので target は stripe_event (target_id = NULL)。fail-open
 */
export async function recordStripeEventFailure(deps: BillingDeps, event: StripeEventEnvelope, errorCode: string): Promise<void> {
  await deps.repository.finishStripeEvent(event.id, { ok: false, errorCode });
  await audit(deps.repository, {
    actor_id: null, action_type: 'system.stripe.event_failed', target_type: 'stripe_event', target_id: null, severity: 'warn',
    details: { event_id: event.id, event_type: event.type, error_code: errorCode },
  });
}

/**
 * 署名と claim を通ったイベントを処理する (POST /api/webhooks/stripe)。例外は route が finish(ok=false) + 500 にする。
 * data.object から使うのは、写しを決めるための id と (invoice の) subscription の参照 (§4.1) と、invoice.payment_failed の
 * 監査 system.payment.failed の details に入れる請求の id・attempt_count・amount_due だけ (この 3 つは写しには書かない。§8.2・テスト 33)。
 */
export async function handleStripeEvent(deps: BillingDeps, event: StripeEventEnvelope): Promise<StripeEventOutcome> {
  const source = `webhook:${event.id}`;
  const action = classifyStripeEvent(event.type);
  const objectId = event.data.object.id ?? null;
  switch (action) {
    case 'ignore':
      return { action: 'ignored', detail: event.type };
    case 'sync_checkout_session': {
      if (objectId === null) return { action: 'skipped', detail: 'no_object_id' };
      const session = await deps.gateway.retrieveCheckoutSession(objectId);
      if (session.mode !== 'subscription' || !session.subscription) return { action: 'skipped', detail: 'not_subscription_session' };
      const result = await syncSubscription(deps, session.subscription, source);
      return { action: result.applied ? 'synced' : 'skipped', detail: result.applied ? result.status_to : result.skipped };
    }
    case 'sync_subscription': {
      if (objectId === null) return { action: 'skipped', detail: 'no_object_id' };
      const result = await syncSubscription(deps, objectId, source);
      return { action: result.applied ? 'synced' : 'skipped', detail: result.applied ? result.status_to : result.skipped };
    }
    case 'sync_invoice_subscription':
    case 'audit_payment_failed_and_sync': {
      const invoice = StripeInvoiceRefSchema.safeParse(event.data.object);
      const subscriptionId = invoice.success ? invoiceSubscriptionId(invoice.data) : null;
      if (subscriptionId === null) return { action: 'skipped', detail: 'invoice_without_subscription' };
      const result = await syncSubscription(deps, subscriptionId, source);
      // 支払失敗の監査は、写像が古い取り直しで stale になっても書く (invoice.payment_failed と customer.subscription.updated は
      // ほぼ同時に届き、updated 側の新しい取り直しが先に commit すると、こちらは stale になる。S8(e))。書かないのは退会済みだけ。
      // 写像のあとに書く (先に書くと、写像の失敗の再処理で同じ監査が 2 行になる)
      const auditUserId = result.applied || result.skipped === 'stale' ? result.user_id : null;
      if (action === 'audit_payment_failed_and_sync' && auditUserId !== null) {
        await audit(deps.repository, {
          actor_id: null, action_type: 'system.payment.failed', target_type: 'user', target_id: auditUserId, severity: 'warn',
          details: {
            stripe_subscription_id: subscriptionId, invoice_id: invoice.success ? invoice.data.id : null,
            attempt_count: invoice.success ? (invoice.data.attempt_count ?? null) : null,
            amount_due: invoice.success ? (invoice.data.amount_due ?? null) : null, event_id: event.id,
          },
        });
      }
      return { action: result.applied ? 'synced' : 'skipped', detail: result.applied ? result.status_to : result.skipped };
    }
  }
}
```

- `syncSubscription` の解約 (`customer_closed`) は Stripe の status が終端でないときだけ。`customer_closed` が false の「退会済み」(当社の対応表に無い顧客の契約 = 同じ Stripe のテスト用アカウントを使う別の環境が作った契約、metadata の `user_id` を運営が書き間違えた契約) は解約しない (当社の利用者のものと言えないため。§18 の 17)。返金はしない (核は返金を扱わない。最初の請求が済んでいれば運営が監査 `system.billing.orphan_subscription_cancelled` (warn) から拾って Stripe で返金する。§18 の 17)。

### 8.7 既存ファイルへの差分 (env / rate-limit / http)

```ts
// tsc:skip insert=src/lib/env.ts — SERVER_ENV_VARS に足す 1 項目 (STRIPE_SECRET_KEY の項目の直後。オブジェクトの一部なので単独では検査できない。§8.0 の手順で差し込んで検査する)
  STRIPE_WEBHOOK_SECRET: {
    required: false,
    description:
      'Stripe の Webhook の署名の秘密 (whsec_ で始まる値。Stripe の Dashboard で Webhook のエンドポイントを登録すると出る)。' +
      'POST /api/webhooks/stripe が、届いたイベントの署名をこれで確かめる (billing/01 §8.3)',
    whenMissing: 'Stripe の Webhook を受け付けない (503)。購入・更新・解約が personal_subscriptions に写らない',
  },
```

`.env.example`: `STRIPE_WEBHOOK_SECRET=` はある (88 行)。`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=` (89 行) は読む場所が無いので消す (Checkout は Stripe がホストするページへ 302 するだけで、公開鍵を使わない)。`STRIPE_SECRET_KEY` の説明行「無いと Stripe との照合・価格の同期が動かない」に「購入・Billing Portal も 503」を足す。

```ts
// tsc:skip insert=src/lib/rate-limit.ts — RateLimitCategory の末尾に | 'billing' を足し、CATEGORY_RULES の先頭にこの行を足す (§8.0 の手順で差し込んで検査する)
  // 課金の操作 (Checkout の作成・Portal・解約の予約と取り消し・戻り画面の同期)。利用者ごと。
  // Stripe の API を 1〜2 回呼ぶ操作なので、連打で Stripe 側のレート制限や顧客の重複を起こさない値
  billing: [{ name: 'billing', max: 10, windowSec: MINUTE_SEC }],
```

```ts
// tsc:skip place=src/lib/billing/http.ts — route 共通の応答 (新設モジュール core を import する。§8.0 の手順で置き場所に置いて検査する)
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { internalError } from '@/lib/api/errors';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { BILLING_ERROR_HTTP_STATUS, BILLING_ERROR_MESSAGES, BillingError, StripeApiError, StripeNotConfiguredError } from '@/lib/billing/core';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** 400 の本文 (super-admin の validation-errors と同じ形: message は最初の issue の文、details は issues の全件) */
export function billingInvalidInputResponse(issues: readonly z.core.$ZodIssue[]): NextResponse {
  return NextResponse.json(
    { error: { code: 'BILL_INVALID_INPUT', message: issues[0]?.message ?? BILLING_ERROR_MESSAGES.BILL_INVALID_INPUT, details: issues } },
    { status: BILLING_ERROR_HTTP_STATUS.BILL_INVALID_INPUT, headers: NO_STORE },
  );
}

/**
 * route の catch で使う。固定の文だけを本文にする (生のエラー文は internalError が app_logs にだけ残す)。
 * AuthError → 401、ForbiddenError (凍結など) → 403 (code はそのまま)、BillingError → 表のステータス、
 * StripeNotConfiguredError → 503、StripeApiError → 502、それ以外 → internalError (500, nested)
 */
export function billingErrorResponse(routeName: string, error: unknown, ctx: { userId?: string } = {}): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401, headers: NO_STORE });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: { code: error.code, message: '権限がありません' } }, { status: 403, headers: NO_STORE });
  }
  if (error instanceof BillingError) {
    return NextResponse.json({ error: { code: error.code, message: BILLING_ERROR_MESSAGES[error.code] } }, { status: BILLING_ERROR_HTTP_STATUS[error.code], headers: NO_STORE });
  }
  if (error instanceof StripeNotConfiguredError) {
    return NextResponse.json(
      { error: { code: 'EXT_STRIPE_NOT_CONFIGURED', message: BILLING_ERROR_MESSAGES.EXT_STRIPE_NOT_CONFIGURED } },
      { status: BILLING_ERROR_HTTP_STATUS.EXT_STRIPE_NOT_CONFIGURED, headers: NO_STORE },
    );
  }
  if (error instanceof StripeApiError) {
    return NextResponse.json(
      { error: { code: 'EXT_STRIPE_API_FAILED', message: BILLING_ERROR_MESSAGES.EXT_STRIPE_API_FAILED } },
      { status: BILLING_ERROR_HTTP_STATUS.EXT_STRIPE_API_FAILED, headers: NO_STORE },
    );
  }
  return internalError(routeName, error, ctx, { shape: 'nested' });
}
```

`ForbiddenError` の `code` は `AUTH_ACCOUNT_FROZEN` (凍結中。`requireUser` が投げる。凍結中も通す 3 本 (§9.8) は `requireUserAllowingFrozen` を使うので投げない)。文は固定 (`error.message` を本文に入れない。`tests/api-raw-error-message-scan.test.ts` の規則)。

---

## 9. API 仕様

共通: 認証は `requireUser()` (`src/lib/auth/helpers.ts`。凍結中は 403 `AUTH_ACCOUNT_FROZEN`)。ただし凍結 (BAN) 中も通す 3 本 (`GET /api/billing/subscription`・`POST /api/billing/subscription/cancel`・`POST /api/billing/portal`) は `requireUserAllowingFrozen()` (`src/lib/billing/auth.ts`。凍結を見ない。§9.8)。本文は JSON。応答は `{ data: … }` / `{ error: { code, message } }` (`cross/04` §5)。すべて `Cache-Control: no-store`。POST はレート制限 `billing` (10 回 / 分 / 利用者。超過は `rateLimitExceededResponse` の 429)。500 は `billingErrorResponse` → `internalError` (nested)。route は `src/lib/billing/service.ts` だけを呼び、`core.ts` の Zod で入力を検証する。`export const dynamic = 'force-dynamic'`。

本文の NULL 文字 (#1657): 本文を読む handler は `POST /api/billing/checkout` と `POST /api/billing/checkout/sync` の 2 つだけで、どちらも handler の最初の 2 行で `rejectNullCharacterBody(request)` を呼ぶ (400 `{ error, code: 'INVALID_CHARACTER' }` は既存の共通の形のまま。`plan_key` は `z.string()` なので、NULL 文字が `findPlan` の `.eq('plan_key', …)` まで届くと DB が拒んで 500 になる)。`cancel`・`resume`・`portal` は本文を読まず (`request.json()` を書かない)、この 2 行も置かない。Webhook (§9.6) は署名の確認より前に本文を JSON として読まないので置かず、`null-character-routes` の `EXCLUDED` に理由を書く (§16.1)。

route の骨格 (全 route 共通。本文を読まない route は NULL 文字の 2 行と `request.json()` を除く。`// tsc:skip`):

- **Stripe を呼ぶ route** (POST の 5 本: `checkout`・`checkout/sync`・`portal`・`subscription/cancel`・`subscription/resume`) は下の骨格のとおり `deps = { gateway: createStripeGateway(), repository: createBillingRepository() }` (`BillingDeps`)。鍵が無ければ `createStripeGateway` が `StripeNotConfiguredError` を投げ、`billingErrorResponse` が 503 `EXT_STRIPE_NOT_CONFIGURED` にする。
- **Stripe を呼ばない route** (GET の 2 本: `checkout/preview`・`subscription`) は `deps = { repository: createBillingRepository() }` (`BillingReadDeps`) だけを作り、**`@/lib/billing/stripe-gateway` を import しない**。鍵が無くても 200 (S11)。レート制限・NULL 文字の 2 行・`request.json()` も無い (クエリだけ読む)。stripe-gateway を import すると `@/lib/env` を通って AI の入口の棚卸し (§2.2 F24) に載り、`EXEMPT_ROUTES` の「載せたファイルは届く」の検査と食い違う (§16.1)。

```ts
// tsc:skip place=src/app/api/billing/checkout/route.ts — 骨格 (ほかの route も同じ形)。新設モジュールを import する (§8.0 の手順で置き場所に置いて検査する)
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { requireUser } from '@/lib/auth/helpers';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { CheckoutRequestSchema } from '@/lib/billing/core';
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { createBillingRepository } from '@/lib/billing/repository';
import { startCheckout } from '@/lib/billing/service';
import { billingErrorResponse, billingInvalidInputResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'POST /api/billing/checkout';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: Request): Promise<NextResponse> {
  // 本文の NULL 文字 (U+0000) は認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)。
  // null-character-routes は handler の最初の 2 行がこの形であることを見る (本文を読む checkout と sync だけに置く)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  let userId: string | undefined;
  try {
    const user = await requireUser();
    userId = user.id;
    const limit = await checkRateLimit(user.id, 'billing');
    if (!limit.success) return rateLimitExceededResponse(limit);
    const body: unknown = await request.json().catch(() => null);
    const parsed = CheckoutRequestSchema.safeParse(body);
    if (!parsed.success) return billingInvalidInputResponse(parsed.error.issues);
    const deps = { gateway: createStripeGateway(), repository: createBillingRepository() };
    const result = await startCheckout(deps, { id: user.id, email: user.email ?? null }, parsed.data.plan_key, parsed.data.interval);
    return NextResponse.json({ data: result }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
```

### 9.1 `POST /api/billing/checkout` — Checkout Session を作る

| | |
|---|---|
| 入力 | `{ plan_key: string, interval: 'month' \| 'year' }` (`CheckoutRequestSchema`) |
| 200 | `{ data: { url: string, session_id: string } }`。画面は `url` へ `window.location.assign` |
| 400 | `BILL_INVALID_INPUT` |
| 401 / 403 | `AUTH_UNAUTHENTICATED` / `AUTH_ACCOUNT_FROZEN` |
| 409 | `OP_SUBSCRIPTION_ALREADY_ACTIVE` (live な行がある。手動付与も含む) |
| 422 | `BILL_PLAN_NOT_PURCHASABLE` (無い・public でない・個人/家族でない・free・その interval の Price が無い・金額 0) |
| 429 | `RATE_LIMITED` |
| 502 / 503 | `EXT_STRIPE_API_FAILED` / `EXT_STRIPE_NOT_CONFIGURED` |
| 副作用 | 顧客が無ければ作る (`billing_customers`)。監査 `user.billing.checkout_started` |

### 9.2 `GET /api/billing/checkout/preview?plan_key=&interval=` — 確認画面の内容

| | |
|---|---|
| 入力 | クエリ (`CheckoutRequestSchema` で検証) |
| 200 | `{ data: CheckoutPreview }` = `{ plan_key, display_name, interval, amount_jpy, trial_days, can_purchase }` |
| 400 / 401 / 403 / 422 | 9.1 と同じ |
| 502 / 503 / 429 | 返さない (Stripe を呼ばず gateway も作らないので、鍵が無くても 200。レート制限も掛けない) |
| 副作用 | 無し |

### 9.3 `POST /api/billing/checkout/sync` — 戻り画面からの同期

| | |
|---|---|
| 入力 | `{ session_id: string }` (`CheckoutSyncRequestSchema`。`cs_` で始まる) |
| 200 | `{ data: BillingSummary }`。Session が `complete` でなければ写さずに要約だけ返す (画面は「処理中」を出し、数秒後に `GET /api/billing/subscription` を読み直す) |
| 403 | `BILL_CHECKOUT_SESSION_MISMATCH` (`client_reference_id` が本人でない)。凍結は `AUTH_ACCOUNT_FROZEN` (9.1 と同じ) |
| 502 / 503 / 429 / 400 / 401 | 9.1 と同じ |

### 9.4 `GET /api/billing/subscription` — 契約の要約 / `POST /api/billing/portal` — Billing Portal

| | GET subscription | POST portal |
|---|---|---|
| 200 | `{ data: BillingSummary }` (鍵が無くても 200。gateway を作らない) | `{ data: { url } }` |
| 401 / 403 | `AUTH_UNAUTHENTICATED`。凍結中も通す (403 `AUTH_ACCOUNT_FROZEN` は返さない。§9.8) | 同じ |
| 404 | — | `BILL_CUSTOMER_NOT_FOUND` (まだ一度も購入していない) |
| 429 | 返さない (レート制限を掛けない) | `RATE_LIMITED` |
| 502 / 503 | 返さない (Stripe を呼ばない) | `EXT_STRIPE_API_FAILED` / `EXT_STRIPE_NOT_CONFIGURED` |
| 副作用 | 無し | Stripe に Portal Session を作る (`return_url` = `/account/billing`) |
| モバイル | WebView からも呼べる (表示だけに使う) | 画面が呼ばない (§10.4) |

### 9.5 `POST /api/billing/subscription/cancel` / `POST /api/billing/subscription/resume`

| | cancel | resume |
|---|---|---|
| 入力 | 無し | 無し |
| 200 | `{ data: BillingSummary }` (予約済みなら何もせず同じ) | `{ data: BillingSummary }` |
| 401 / 429 / 502 / 503 | 9.1 と同じ | 9.1 と同じ |
| 403 | 返さない (凍結中も通す。§9.8) | `AUTH_ACCOUNT_FROZEN` (凍結中。9.1 と同じ) |
| 409 | `BILL_NO_LIVE_SUBSCRIPTION` (live かつ Stripe-backed の行が無い。手動付与は解約できない = 配線の画面) | `BILL_NO_LIVE_SUBSCRIPTION` / `BILL_CANCEL_NOT_SCHEDULED` |
| Stripe | `POST /v1/subscriptions/{id}` `cancel_at_period_end=true` | 同 `false` |
| 副作用 | 写像 (`api:cancel`)・監査 `user.billing.cancel_scheduled` | 写像 (`api:resume`)・監査 `user.billing.cancel_revoked` |

### 9.6 `POST /api/webhooks/stripe` — Webhook の受け口

認証はログインのセッションではなく署名 (`cross/04` §10)。route segment config は次の 3 行 (Next は静的解析できるリテラルしか読まないので、`maxDuration` は import した定数でなく数値リテラルで書く。既存の route と同じ書き方。値は `STRIPE_WEBHOOK_MAX_DURATION_SECONDS` と同じで、一致はテスト 86 が見張る):

```ts
// tsc:skip place=src/app/api/webhooks/stripe/route.ts — 先頭 (route segment config) だけ。§8.0 の手順ではこの 3 行だけのファイルとして検査する
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 根拠は STRIPE_WEBHOOK_MAX_DURATION_SECONDS (src/lib/billing/core.ts): Stripe の取り直し 1 回 + RPC 1 回が収まる秒数。
// route segment config は静的解析できるリテラルに限られるので、定数を import せず同じ値をここに書く (一致はテスト 86)
export const maxDuration = 30;
```

| 順 | 処理 | 応答 |
|---|---|---|
| 1 | `content-length` と本文の実バイト数が `STRIPE_WEBHOOK_MAX_BODY_BYTES` (1 MiB) を超える | 413 `{ error: 'payload_too_large' }` |
| 2 | `payload = await request.text()` (JSON として読む前の文字列) → `verifyStripeWebhook(payload, request.headers.get('stripe-signature'))` | 秘密が無い (`WebhookSecretMissingError`) → 503 `{ error: 'webhook_not_configured' }` (error ログ。変数名は本文に出さない) / 合わない → 401 `{ error: 'unauthorized' }` (warn ログに reason) |
| 3 | `JSON.parse` → `StripeEventEnvelopeSchema.safeParse` | 読めない・形が違う → 400 `{ error: 'invalid_payload' }` |
| 4 | `createStripeGateway()` (鍵が無ければ `StripeNotConfiguredError`) | 503 `{ error: 'stripe_not_configured' }` |
| 5 | `event.livemode` と `gateway.mode` の不一致 (`mode` が null のときは不一致扱いにしない) | 200 `{ received: true, ignored: true }` + warn ログ。DB に書かない |
| 6 | `repository.claimStripeEvent(minimizeStripeEventPayload(event))` = `completed` (DB に残すのは最小化した写し。下の注) | 200 `{ received: true, duplicate: true }` (処理済み。Stripe は再送をやめてよい) |
| 6' | 同 = `in_progress` (ほかが処理中で 15 分以内) | 409 `{ error: 'event_in_progress' }` + info ログ。2xx を返さないので Stripe は後で再送する。そのときには `completed` (200) か、15 分を過ぎた `processing` を取り直して処理する |
| 7 | 同 = `claimed` → `handleStripeEvent(deps, event)` → `finishStripeEvent(id, { ok: true })` | 200 `{ received: true, action, detail }` |
| 8 | 7 で例外 → `recordStripeEventFailure(deps, event, errorCode)` (§8.6。`finishStripeEvent(id, { ok: false, errorCode })` + 監査 `system.stripe.event_failed` (warn・`target_type: 'stripe_event'`・`target_id: null`・`details: { event_id, event_type, error_code }`。監査は fail-open))。`errorCode` = `BillingRpcError.code` / `StripeApiError` なら `EXT_STRIPE_API_FAILED` / それ以外 `SYS_INTERNAL_ERROR` | `internalError(ROUTE_NAME, error, { event_id, event_type })` = 500 (Stripe が再送する) |

- `finishStripeEvent` 自体が失敗したら (7 の `ok: true` でも 8 の `ok: false` でも)、その失敗も `internalError` に渡して 500。行は `processing` のまま残る。15 分以内の再送は 6' の 409 で返し (Stripe は再送を続ける)、15 分を過ぎた再送で 7 から再処理する。関数の時間切れ・プロセス落ちで 7 の途中で止まった場合も同じ道になる。
- メンテナンスモード (#1148。`src/lib/maintenance-mode.ts`) の間は、ミドルウェアが route に届く前に `/api/webhooks/stripe` にも 503 (`MAINTENANCE_MODE`) を返す (`isMaintenanceExemptPath` に載せない)。2xx でないので Stripe が再送し、メンテナンスのあとに処理される。`/api/billing/*` も同じく 503。
- 409 と 500 のどちらも Stripe の再送の対象 (Stripe は 2xx 以外を、間隔を広げながら最長 3 日まで再送する)。3 日で再送が尽きたイベントは `failed` / `processing` のまま残る。その後の整合は reconcile (配線。§12) が写像で直す。
- 本文に Stripe の生のエラー文・イベントの中身を入れない。`stripe_webhook_events.payload` には**イベントの JSON 全体を残さず**、`minimizeStripeEventPayload(event)` (§8.1) の写しだけを渡す (6 の `claimStripeEvent` の引数。型 `StoredStripeEventPayload` は入れ子のオブジェクトを持てないので、イベントそのものは渡せない)。残るのは `id / object / type / created / livemode` と `data.object` の許可リスト (`STORED_STRIPE_EVENT_OBJECT_FIELDS` の項目と、文字列の id に正規化した `customer` / `subscription`) だけで、氏名・メールアドレス・住所 (`checkout.session.completed` の `customer_details`、`invoice.*` の `customer_email` / `customer_name` / `customer_address` など) と `invoice_pdf` は DB に残らない。このため退会 (§11) で `stripe_webhook_events` を伏せる処理は要らない (利用者を指す列も無い。§2.2 F25)。行の掃除 (保存期間) は配線の冊。

### 9.7 ログ (app_logs) の規則

`createLogger('<ROUTE_NAME>')`。利用者の操作は `withUser(user.id)`。残すのは `plan_key` / `interval` / `stripe_subscription_id` / `checkout_session_id` / `event_id` / `event_type` / `status_from` / `status_to` / `request_id` だけ。メールアドレス・氏名・カード・秘密鍵・署名の値は残さない (db-logger のマスクに頼らず渡さない)。

### 9.8 凍結 (BAN) 中の利用者が使える課金の API (3 本)

理由: 凍結 (`user_profiles.frozen_at`。#1030) は契約も Stripe の課金も止めない (§12・§7.3 の凍結の行)。origin/main の middleware (`lib/supabase/middleware.ts:182-226`) は、凍結中の利用者の `/api/*` を、退会と書き出しの 2 本 (`src/lib/auth/frozen.ts` の `FROZEN_ALLOWED_API_PATHS`。#1445) を除いて 403 `AUTH_ACCOUNT_FROZEN` にし、画面は `/frozen` (`/frozen/` の下と `/contact` などを除く) に回す。そのままだと凍結中の利用者は `/account/billing` を開けず、解約の API も 403 で、退会のほかに課金を止める手段が無い。確認画面 (§10.2) は「解約予告期間 (いつでも。次回更新日まで利用可)」と表示し、R16 は 1 タップの解約を求めるので、凍結中も次の 3 本を通す。

| API | 凍結中に通す理由 | 認証 |
|---|---|---|
| `GET /api/billing/subscription` (§9.4) | `/frozen/billing` (§10.5) が、解約できる契約か (`can_cancel`)・Portal を開けるか (`has_customer`)・状態と解約の予約の日付 (`billingStatusLines`) を読む。読み取りだけで、本人の契約だけを返す | `requireUserAllowingFrozen` |
| `POST /api/billing/subscription/cancel` (§9.5) | 解約の予約 (期間末。次の更新から課金されない) | `requireUserAllowingFrozen` |
| `POST /api/billing/portal` (§9.4) | 支払い方法の更新・請求書の履歴・Portal での解約 (§17.1 の 3.) | `requireUserAllowingFrozen` |

通さないもの (凍結中は middleware が 403 `AUTH_ACCOUNT_FROZEN`。route に届いても `requireUser` が 403): `POST /api/billing/subscription/resume` (解約の取り消し = 利用を続ける操作)・`POST /api/billing/checkout`・`GET /api/billing/checkout/preview`・`POST /api/billing/checkout/sync` (購入 = 利用を始める操作)。`src/lib/auth/frozen.ts` の JSDoc の規則「足すのは本人がサービスから離れるための操作だけ」のとおり、離れる操作 (解約の予約) とその前提 (要約・Portal) だけを足す。Portal の中で予約を取り消すこと (Stripe の Portal の機能) は止めない (§18 の 21)。

変えるもの:

1. `src/lib/auth/frozen.ts`: 下の差分 (定数 3 つと、一覧の 3 行と、JSDoc の段落)。完全一致の判定 `isFrozenAllowedApiPath` はそのまま。middleware は一覧を読むだけなのでコードは変えない (コメント 2 か所だけ。§15.2)。
2. 3 本の route: 骨格 (§9 の冒頭) の `import { requireUser } from '@/lib/auth/helpers';` を `import { requireUserAllowingFrozen } from '@/lib/billing/auth';` に、`const user = await requireUser();` を `const user = await requireUserAllowingFrozen();` に替える。ほかは骨格のまま (`billingErrorResponse` が `AuthError` を 401 にする。レート制限 `billing` は POST の 2 本にそのまま掛かる)。ほかの 4 本 (`checkout`・`checkout/preview`・`checkout/sync`・`subscription/resume`) は `requireUser` のまま (middleware がプロフィールを読めずに通したとき (fail-open) も、route が凍結を 403 にする)。どの route がどちらを呼ぶかは、テスト 115 が route のソースと `FROZEN_ALLOWED_API_PATHS` を突き合わせて見張る。
3. `src/lib/billing/auth.ts` (新設): 下の `requireUserAllowingFrozen`。
4. 画面: `/frozen/billing` (新設) と、凍結の画面 `/frozen` のリンク (§10.5)。

```ts
// tsc:skip — src/lib/auth/frozen.ts の差分の抜粋 (印の無い説明用の断片)。(1) ACCOUNT_EXPORT_API_PATH の定義の直後に 3 つの定数を足す。(2) FROZEN_ALLOWED_API_PATHS の JSDoc の末尾 (「一覧は tests (…) で固定している。」の行の後) に段落を 1 つ足す。(3) 配列の末尾に 3 行を足す。ほかの行 (isAccountFrozen・isFrozenAllowedApiPath・既存の JSDoc の文) は変えない
/** 有料プランの契約の要約 (GET)。凍結中でも呼べる (billing/01 §9.8: /frozen/billing が、解約できる契約か・解約の予約の日付を読む) */
export const BILLING_SUBSCRIPTION_API_PATH = '/api/billing/subscription';
/** 有料プランの解約の予約 (POST。期間末に解約)。凍結中でも呼べる (billing/01 §9.8) */
export const BILLING_CANCEL_API_PATH = '/api/billing/subscription/cancel';
/** Stripe の Billing Portal を開く (POST。支払い方法の更新・請求書の履歴・Portal での解約)。凍結中でも呼べる (billing/01 §9.8) */
export const BILLING_PORTAL_API_PATH = '/api/billing/portal';

/*
 * (FROZEN_ALLOWED_API_PATHS の JSDoc の末尾に足す段落)
 *
 * billing/01 §9.8: 有料プランの解約の予約と、その前提の 2 つ (契約の要約の読み取り・Billing Portal) も足す。
 * 凍結は契約も Stripe の課金も止めないので、ここで止めると凍結中の利用者は退会のほかに課金を止められない
 * (特定商取引法の最終確認画面の「解約予告期間 (いつでも)」に反する)。解約の取り消し (resume)・購入 (checkout・checkout/preview・checkout/sync) は
 * 足さない (サービスの利用を続ける・始める操作のため)。どの route が凍結を見ない認証 (requireUserAllowingFrozen) を使うかは tests/api/billing-routes.test.ts が見張る
 */
export const FROZEN_ALLOWED_API_PATHS: readonly string[] = Object.freeze([
  ACCOUNT_DELETE_API_PATH,
  ACCOUNT_EXPORT_API_PATH,
  BILLING_SUBSCRIPTION_API_PATH,
  BILLING_CANCEL_API_PATH,
  BILLING_PORTAL_API_PATH,
]);
```

```ts
// tsc:skip place=src/lib/billing/auth.ts — 既存のモジュール (@/lib/supabase/server・@/lib/auth/errors) を import するので単独の検査から外す (§8.0 の手順で置き場所に置いて検査する)
import { AuthError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';

/** 凍結中も通す課金の route が受け取る利用者 (route は id だけを使う) */
export interface BillingRouteUser {
  id: string;
  email: string | null;
}

/**
 * 凍結 (BAN) 中の利用者も通す課金の route の認証 (billing/01 §9.8)。使うのは GET /api/billing/subscription・
 * POST /api/billing/subscription/cancel・POST /api/billing/portal の 3 本だけ (src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS に載る課金のパス。
 * どの route が使うかはテスト 115 が見張る)。ログインのセッションだけを確かめ、凍結 (user_profiles.frozen_at) は見ない。
 * requireUser() (src/lib/auth/helpers.ts) は凍結中に ForbiddenError('AUTH_ACCOUNT_FROZEN') を投げるので、この 3 本では使わない
 */
export async function requireUserAllowingFrozen(): Promise<BillingRouteUser> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new AuthError('AUTH_UNAUTHENTICATED');
  return { id: user.id, email: user.email ?? null };
}
```

- 一時 BAN (`unban_at` が未来) の継続中も同じ (`isAccountFrozen` が真の間)。凍結が解ければ、ほかの route も通常どおり通る。
- メンテナンスモードの間は、凍結と関係なく 503 (§9.6 の注と同じ。`/api/billing/*` は `isMaintenanceExemptPath` に載せない)。
- 同意のゲート (`cross/13a` の API の同意の許可リスト。設計中) は「`FROZEN_ALLOWED_API_PATHS` を含む」と決めているので、本冊の 3 本も未同意で通る側に入る (解約は利用規約の新しい版に同意しなくてもできる)。`cross/13a` の「2 本」の記述は §16.2 で直す。

---

## 10. 画面・モバイル

### 10.1 `/pricing` (公開ページ) — データ駆動で「買えるプランだけ」を描く

- 現在形: 読み取りの関数は `listPublicPlans()` (`src/lib/billing/public-plans.ts:17`。billing/03 §8.6 で `listPurchasablePlans` を置き換えた。`stripe_price_id` の有無では絞らず、月額の金額が正のプランを返し、買えるかは `isPurchasable` で間隔ごとに見る)。下の絞り込みと正典コードは段 C の時点の記録で、いまの全文は billing/03 §8.6。
- `src/app/pricing/page.tsx` を **async の Server Component** にする。`listPublicPlans()` (段 C の時点の名前は `listPurchasablePlans`。`src/lib/billing/public-plans.ts`) で `subscription_plans` から `status='public' AND plan_type IN ('personal','family') AND plan_key <> 'free' AND stripe_price_id IS NOT NULL` を `display_order` 順に読み (RLS `subscription_plans_select_public` を通る `createClient()`。未ログインでも読める)、`(await cookies()).get('is_native_app')?.value === '1'` (`next/headers`。Next 15 の `cookies()` は Promise) を `isNativeApp` として、描画を `src/app/pricing/PricingPageView.tsx` (`"use client"`。いまの見た目を移す) に渡す。
- `PricingPageView` は default export で、props は `{ plans: PurchasablePlan[]; isNativeApp: boolean }` (page.tsx が渡す。`PricingPageView` は Supabase も Cookie も読まない)。
- `PricingPageView` の規則: プランごとの「買える間隔」= `BILLING_INTERVALS.filter((interval) => isPurchasable(plan, interval))` (どれも `@/lib/billing/core` の export。並びは `BILLING_INTERVALS` のとおり月額 → 年額)。「買えるプラン」= `plans` のうち買える間隔が 1 つ以上あるもの (段 C の時点の `listPurchasablePlans` は月額の Price のある行だけを返したが、金額が NULL か 0 の間隔は買えないので、ここで外す)。買えるプランが 0 件 → フリーのカードと、タイトルの下の段落 (「現在は無料でご利用いただけます。」)・FAQ (「現在、料金はかかりますか？」) だけを描き、有料プランのカードは描かない (#1911 で `PAID_PLAN_PENDING`・「有料プラン (準備中)」のカード・FAQ の「有料プランはありますか？」を取り除いた。「準備中」とも書かない)。1 件以上 → 買えるプランごとにカードを 1 枚 (`plans` の順。表示名 `display_name`・`trial_days > 0` なら「X 日間無料」)。カードの中は**買える間隔ごとに 1 行**ずつ、金額と CTA を出す (下の表)。買えない間隔 (`isPurchasable(plan, interval)` が偽 = 年額の Price `stripe_yearly_price_id` が NULL・その間隔の金額が NULL か 0) は、DB に金額があっても**金額も CTA も出さない** (押すと確認画面の `GET /api/billing/checkout/preview` が 422 `BILL_PLAN_NOT_PURCHASABLE` になる CTA を作らない。§9.2)。間隔の切替 (トグル・タブ) は置かない (カードに買える間隔の行を並べるだけ。`PricingPageView` は状態を持たない。`tests/public-claims-guard.test.ts` の describe `#1151 料金ページ (/pricing)` がソースに `billingPeriod` が無いことを見ているので、その名前も使わない)。カードの枠・色はフリーのカードと同じ見た目、並べ方はいまの `grid md:grid-cols-2` のまま (カードが増えれば行が増える)。CTA は Next の `Link` (未ログインなら `(main)` の既存のガードでログインへ回る)。1 件以上ではタイトルの下の段落 (「現在は無料でご利用いただけます。」)・FAQ (「現在、料金はかかりますか？」) を描かない (0 件のときだけ描く。新しい文は足さない)。フリーのカードと末尾の「無料で始める」はどちらの場合も描く。`isNativeApp` なら有料プランのカードと CTA を描かず、フリーの説明だけ描く (§10.4)。

  | 買える間隔 | 金額の表示 (`amount = amountJpyFor(plan, interval)`。`isPurchasable` が真なら正の数) | CTA の文 | CTA の行き先 (`href`) |
  |---|---|---|---|
  | `month` | `¥${amount.toLocaleString('ja-JP')}` と、続けて `/ 月（税込）` | 月額で始める | `/account/billing/checkout?plan_key=${encodeURIComponent(plan.plan_key)}&interval=month` |
  | `year` | `¥${amount.toLocaleString('ja-JP')}` と、続けて `/ 年（税込）` | 年額で始める | `/account/billing/checkout?plan_key=${encodeURIComponent(plan.plan_key)}&interval=year` |

  カードの全パターン (月額・年額の買える / 買えない): 両方買える → 2 行 (月額 → 年額)。月額だけ → 月額の 1 行 (年額の金額・「年額で始める」・`interval=year` の Link は無い)。年額だけ (月額の金額が NULL か 0) → 年額の 1 行。どちらも買えない → カードを描かない (ほかに買えるプランが無ければ 0 件 = 有料プランのカードは無い)。
- `/pricing` は鍵 (`STRIPE_SECRET_KEY`) を見ない (`@/lib/env` に届くものを import しない。§8 の表・F24)。出すか出さないかは `stripe_price_id` の登録だけで決まる。鍵が無い間に Price が登録されていると、`/pricing` と確認画面は出たまま「申し込む」が 503 (「お支払いを受け付けていません」) になる。本番はこの状態を作らない順 (鍵 → Price) で準備する (§17)。
- 価格の表示は `monthly_price_jpy` / `yearly_price_jpy` をそのまま (DB の値が正。上の表の `amountJpyFor`)。
- `tests/public-claims-guard.test.ts` は `@/lib/billing/public-plans` と `next/headers` をモックして「買えるプランが 0 件 → フリーのカードと FAQ だけ (「準備中」のカードも販売開始前の文も無い)」(テスト 50。#1911 で期待値を改めた) と「買えるプランがある → 買える間隔だけ金額と CTA・0 件のときの段落と FAQ は無い」(テスト 51) の両方を持つ (書き方は §16.1 の行)。

```ts
// tsc:skip place=src/lib/billing/public-plans.ts — 新設モジュール core を import する (§8.0 の手順で置き場所に置いて検査する)
import { createLogger } from '@/lib/db-logger';
import { createClient } from '@/lib/supabase/server';
import { FREE_PLAN_KEY, PURCHASABLE_PLAN_TYPES, type PurchasablePlan } from '@/lib/billing/core';

const logger = createLogger('billing/public-plans');

const PLAN_COLUMNS = 'plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id';

/**
 * /pricing に出す「買えるプラン」。月額の Price があるものだけ (年額は任意)。
 * 読み取りに失敗したら例外を投げずに空を返す (公開ページをエラーにせず、買えるプランが無いときと同じ表示を描く)。失敗は error ログに残す
 */
export async function listPurchasablePlans(): Promise<PurchasablePlan[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('subscription_plans')
    .select(PLAN_COLUMNS)
    .eq('status', 'public')
    .in('plan_type', [...PURCHASABLE_PLAN_TYPES])
    .neq('plan_key', FREE_PLAN_KEY)
    .not('stripe_price_id', 'is', null)
    .order('display_order', { ascending: true });
  if (error) {
    // 生のエラーは app_logs にだけ残す (ページには出さない)
    logger.error('公開のプランの一覧を読めませんでした (/pricing は買えるプランが無いときの表示を描く)', error);
    return [];
  }
  return (data ?? []) as PurchasablePlan[];
}
```

- 失敗の扱いは「空を返す」が正 (投げない)。`/pricing` は 0 件と同じ表示 (フリーのカードだけ) を描き、エラーページにしない。テスト 97。

### 10.2 `/account/billing/checkout?plan_key=&interval=` — 特商法の最終確認 (`cross/08` §3)

- `src/app/(main)/account/billing/checkout/page.tsx` (`"use client"`)。`GET /api/billing/checkout/preview` で内容を取り、`src/components/billing/checkout-confirmation.tsx` (`cross/08` §3.2 の形を踏襲) に渡す。
- 必須の表示: プラン名 / 料金 (月額 or 年額、税込) / 自動更新であること・解約しない限り課金が続くこと / 解約方法 (`/account/billing` から) / 解約予告期間 (いつでも。次回更新日まで利用可) / 最低契約期間 (なし) / 利用規約・プライバシーポリシーへのリンク (`/terms` `/privacy`) / `trial_days > 0` なら「X 日間の無料期間のあと課金」、0 なら「お申し込み後すぐに課金」/ `can_purchase` が false なら「すでに有効な契約があります」で CTA を無効。
- チェックボックス「上記内容を確認しました」が ON で「申し込む」が活性 → `POST /api/billing/checkout` → `data.url` へ移動。422 / 409 / 503 は固定の文 (`BILLING_ERROR_MESSAGES`) を表示。
- `isNativeApp` (`useNativeAppMode`) なら、このページは「この操作はアプリでは行えません」とだけ描く (§10.4)。

### 10.3 `/account/billing` — 契約の管理

- `src/app/(main)/account/billing/page.tsx` (`"use client"`)。`GET /api/billing/subscription` を読む。
- クエリ `checkout=success&session_id=` で開いたら、先に `POST /api/billing/checkout/sync` を呼ぶ (S9)。`status` がまだ無ければ「お申し込みを処理しています」を出し、`CHECKOUT_SYNC_RETRY_MS` (3 秒) ごとに `GET` を最大 `CHECKOUT_SYNC_MAX_RETRIES` (10 回) 読み直す。`checkout=cancelled` なら「お申し込みは完了していません」。
- 表示: 現在のプラン (モバイルの購入の画面 (billing/03 §10.6 の 2) と同じ分岐。`@homegohan/shared` の `currentPlanDisplay(summary)` (billing/03 §8.9) で、自分の契約が live ならその `plan_key` の名前 (`planDisplayName`)、live でなければ `effective_plan_key` で `free` →「無料プラン」/ 組織のプランの値 (`isOrgPlanKey`) →「組織のプラン」(`ORG_PLAN_DISPLAY_NAME`) / `PLAN_CATALOG` の key (家族のプラン) →「`<名前>` (ご家族のプラン)」(`FAMILY_PLAN_STATUS_SUFFIX`) / それ以外 →「有料プラン」(`PAID_PLAN_GENERIC_DISPLAY_NAME`)。#1912。出どころが組織・家族・汎用 (自分の契約ではないプランが効いている) のときは、添え書き「ご自身の契約ではないため、このプランの解約やお支払い方法の変更はこの画面では行えません。」(`NOT_OWN_PLAN_NOTE`。旧「家族 / 組織のプランが適用中」を言い換えたもの) を出す。自分のプランの申し込みは `can_purchase` の「プランを見る」からできるので、添え書きに購入できないとは書かない)・状態 (下の表。`billingStatusLines(summary)` (§8.1) の戻り値を 1 行ずつ `<p>` で出す。画面に文を書かない)・次回更新日・支払い周期。

  状態の表示文 (`status` × `cancel_at_period_end`。`summary` は `GET /api/billing/subscription` の `BillingSummary`。日付は `formatBillingDate` = 日本時間の「2026年10月21日」):

  | `status` | 1 行目 (`BILLING_STATUS_TEXT`) | `cancel_at_period_end = false` | `cancel_at_period_end = true` (解約の予約中) |
  |---|---|---|---|
  | `trialing` | 無料期間中（Xまで）。X = `trial_ends_at` の日付 (全角の括弧・空白なし。例「無料期間中（2026年10月21日まで）」。NULL なら「無料期間中」だけ) | 1 行目だけ | 1 行目 + 2 行目「Yに解約されます」(空白なし。例「2026年11月21日に解約されます」)。Y = `cancel_at` の日付 (NULL なら `current_period_end` の日付。どちらも NULL なら「期間の終わりに解約されます」) |
  | `active` | ご利用中 (お支払いの問題の文は出さない) | 1 行目だけ | 1 行目 + 2 行目 (同上) |
  | `past_due` | お支払いに問題があります。お支払い方法をご確認ください | 1 行目だけ | 1 行目 + 2 行目 (同上) |
  | `grace` | お支払いが確認できないため一部の機能を制限しています | 1 行目だけ | 1 行目 + 2 行目 (同上) |
  | `paused` | 一時停止中 | 1 行目だけ | 1 行目 + 2 行目 (同上) |
  | `null` (live な行が無い。`getBillingSummary` は `findLiveSubscription` を読むので、`incomplete` / `cancelled` / `expired` の行しか無いときも `null`。`billingStatusLines` は live でない status を受けても空を返す) | 文なし (空の配列) | — | — |

  `cancel_at_period_end` は status と同時に成り立つ (§7.3 の予約の行は live 5 値のどれにも付く) ので、2 行目は 1 行目に足す (1 行目を置き換えない)。表はテスト 112 (関数) とテスト 113 (画面) が全組で見張る。
- ボタン: `has_customer` → 「お支払い方法・請求書 (Stripe)」= `POST /api/billing/portal` → `url` へ。`can_cancel` → 「解約する」(確認ダイアログ) = `POST …/cancel`。`can_resume` → 「解約を取り消す」= `POST …/resume`。`can_purchase` → 「プランを見る」= `/pricing`。
- `isNativeApp` なら表示だけ (ボタンは描かない)。
- ボタンの POST (Portal・解約・取り消し) が 4xx / 5xx を返したら、`BILLING_ERROR_MESSAGES` の固定の文を出す (鍵が無いときの 503 `EXT_STRIPE_NOT_CONFIGURED` は「お支払いを受け付けていません」)。要約の GET は鍵が無くても 200 なので、ページそのものは開ける (§9・S11)。
- 設定画面 (`src/app/(main)/settings/page.tsx`) に「プランとお支払い」の行を足し `/account/billing` へ (Web だけ。`isNativeApp` では描かない)。

### 10.4 モバイル (billing/03 §10.6 に置き換え。Web の購入のページへ誘導しない規則だけ残す)

- 現在形: アプリ内課金 (App Store / Google Play。RevenueCat) の購入の画面は billing/03 §10.6 (`apps/mobile/app/settings/plan.tsx`)。本節のうち残る規則は「アプリの中に Web の購入のページ (`/pricing`・`/account/billing`) への誘導を出さない」(見張り テスト 101) だけで、下の段 C の記述は当時の記録。

- `apps/mobile` で変えるのは **料金の画面を消すこと** だけ (段 C。触るファイルは下の箇条の 5 つと新設のテスト 1 つ。§15.2)。origin/main の `apps/mobile/app/(public)/pricing.tsx` は `<PublicPage title="料金" webPath="/pricing">` で「プラン・料金体系はWeb版にて最新情報をご確認ください。」と「Web版を開く」(`PublicPage` が `Linking.openURL(webPageUrl('/pricing'))` で外部のブラウザを開く) を出し、入口の画面 `apps/mobile/app/index.tsx:70` の `{ href: "/pricing", label: "料金" }` からリンクされている。外部のブラウザには `is_native_app` の Cookie が無いので、本冊のあとの Web の `/pricing` は価格と「月額で始める」「年額で始める」の CTA を描く (§10.1) = アプリから Web での購入への誘導になり、下の規則と R11 に反する。直し方 (#1598 で公開の画面を消したときと同じ形):
  - `apps/mobile/app/(public)/pricing.tsx` を消す。`apps/mobile/app/index.tsx` の一覧から `{ href: "/pricing", label: "料金" }` の 1 行を外す (ほかの 3 つ「アプリについて」「利用規約」「プライバシー」は残す。どれも Web の購入のページを開かない)。
  - `apps/mobile/__tests__/components/PublicPage.test.tsx`: 「画面を拾えている」の期待の一覧から `'pricing.tsx'` を外す (`about.tsx`・`privacy.tsx`・`terms.tsx` の 3 つ)。「EXPO_PUBLIC_WEB_URL が無ければ既定の Web を開く」の it の例のパス `'/pricing'` を `'/about'` にする (`PublicPage` の URL の組み立ての検査で、どのパスでも同じ。期待値は `${DEFAULT_WEB_URL}/about`)。
  - `apps/mobile/__tests__/app/route-targets-exist.test.ts`: 「#1598 / #1610 で消した届かない画面のファイルは無い」の `removedScreens` の `(public)` の一覧に `'pricing'` を足す (コメント「billing/01 §10.4: アプリから Web の購入のページへ誘導しないため消した」)。入口の画面のリンクを外すので、行き先の実在の検査はそのまま緑。
  - `apps/mobile/env.example` の公開ページの説明のコメント「(料金・よくある質問など。src/components/PublicPage.tsx)」を「(このアプリについて・利用規約など。src/components/PublicPage.tsx)」にする (コメントだけ。`env-example.test.ts` は変数の名前だけを見る)。
  - 見張り: テスト 101 (`apps/mobile` の `app/` と `src/` に `/pricing`・`/account/billing` を開くコードが無い)。
  - ほかの公開ページ (`about` / `terms` / `privacy`) の「Web版を開く」は購入のページを開かないので残す。その先の Web のページからサイトの中を辿ると `/pricing` に行ける (トップ `/` のフッターなど) が、アプリが直接に開くのは購入のページではない。これをどう見るかはストアの規約の確認 (§18 の 2) に含める。
- 上のほか、ネイティブの画面は本冊で変えない (契約の状態の表示は配線の冊)。
- 規則 (ストアの規約に触れない形): アプリ内 (ネイティブ画面と、アプリが開く WebView のページの両方) に、有料プランの価格・購入ボタン・Web での購入への誘導 (リンク・文言) を出さない。既存の契約の状態 (プラン名・次回更新日・解約予約) を読み取り専用で出すのは可 (本冊では Web の `/account/billing` の WebView 表示がその形。ネイティブ画面での表示は配線の冊)。
- 実装の仕組み: Web の 3 ページ (`/pricing` `/account/billing` `/account/billing/checkout`) が `is_native_app` Cookie (`useNativeAppMode` / `cookies()`) で購入導線を描かない。凍結中の `/frozen/billing` (§10.5) は購入導線を持たず、解約と Portal のボタンをアプリの WebView (`isInNativeWebView()`) では描かない (`/account/billing` と同じく表示だけ)。API 自体には制限を付けない (認可は同じ。制限は表示の規則)。
- 未確認: App Store / Google Play の規約の最新の文面と、審査での判断。openQuestions に残す (§18)。
- 配布の順: 料金の画面を消した版のアプリを配布してから、Web で販売を始める (Price の登録。§17.3)。すでに配布した古い版 (料金の画面を持つ) が手元に残る利用者の扱いは §18 の 2。

### 10.5 `/frozen/billing` — 凍結 (BAN) 中の解約とお支払い (§9.8)

- `src/app/frozen/billing/page.tsx` (`"use client"`。default export `FrozenBillingPage`)。`/frozen/` の下なので、凍結中でも middleware が `/frozen` へ差し戻さない (`lib/supabase/middleware.ts:339-352` の `frozenExemptPaths` の前方一致)。同意のゲートも `/frozen` の下を対象外にしている (`lib/legal-consent.ts` の `EXEMPT_PREFIXES`)。
- 呼ぶ API は `FROZEN_ALLOWED_API_PATHS` の課金の 3 本だけ (`src/lib/auth/frozen.ts` の `BILLING_SUBSCRIPTION_API_PATH`・`BILLING_CANCEL_API_PATH`・`BILLING_PORTAL_API_PATH` を import して使う。パスを文字列で書かない)。`/frozen/account` の画面 (退会と書き出し) と同じく、凍結中に 403 になる API を呼ばない。
- 読み込み: マウント時に `setIsNativeApp(isInNativeWebView())` (`@/lib/native-auth-bridge`。同じ `/frozen/` の下の `/frozen/account` と同じ判定にそろえる。`useNativeAppMode` は `useSearchParams` を使い、使うなら Suspense の境界が要るので、このページでは使わない) のあと `fetch(BILLING_SUBSCRIPTION_API_PATH, { method: 'GET' })`。200 → 本文 `{ data: BillingSummary }` の `data` を状態に置く。401 → `router.push('/login')`。それ以外 → `role="alert"` で「契約の状態を読み込めませんでした。時間をおいて再度お試しください。」。読み込み中は「読み込んでいます…」。
- 表示 (上から): 見出し「有料プランの解約・お支払い」/ 説明「アカウントが凍結されている間も、有料プランの解約の予約と、お支払い方法・請求書の確認はできます。」/ 状態: `summary.status` が `null` なら「有料プランの契約はありません。」、そうでなければ `billingStatusLines(summary)` (§10.3 の表) を 1 行ずつ `<p>` で出す / ボタン (下) / リンク「凍結のお知らせに戻る」(`/frozen`)・「サポートに問い合わせる」(`/contact`)。
- ボタン (`isNativeApp` が偽のときだけ描く。アプリの WebView では状態の文だけ。§10.4・S14 と同じ規則):
  - `summary.can_cancel` → 「解約する」。押すと `` window.confirm(`有料プランの解約を予約します。${d ?? '次回の更新日'}以降は請求されません。よろしいですか？`) `` (`d = formatBillingDate(summary.current_period_end)`)。OK なら `fetch(BILLING_CANCEL_API_PATH, { method: 'POST' })` → 200 の `data` (`BillingSummary`) で状態を置き換え (2 行目「Yに解約されます」が出て、`can_cancel` が偽なのでボタンが消える)、`role="status"` で「解約を予約しました。」。押している間はボタンを無効にする。
  - `summary.has_customer` → 「お支払い方法・請求書 (Stripe)」。押すと `fetch(BILLING_PORTAL_API_PATH, { method: 'POST' })` → 200 の `data.url` へ `window.location.assign`。Portal の戻り先は `/account/billing` (§8.6 `createPortalSession`) で、凍結中は middleware が `/frozen` へ回す (`/frozen` から再びこの画面へ来られる)。
  - 描かないもの: 「解約を取り消す」(`can_resume` が真でも描かない。取り消しの API は凍結中は 403。§9.8)・「プランを見る」・`/pricing` へのリンク (購入は凍結中はできない)。
  - POST が 2xx 以外: 401 → `router.push('/login')`。それ以外は本文の `error.code` が `BILLING_ERROR_MESSAGES` (§8.1) のキーならその文、キーでなければ (429 の `RATE_LIMITED`・500 など)「処理中にエラーが発生しました。時間をおいて再度お試しください。」を `role="alert"` で出す。
- 凍結の画面 `src/app/frozen/page.tsx`: 「退会・データの書き出し」のリンクの下に、同じ見た目のリンク「有料プランの解約・お支払い」(`href` = 定数 `FROZEN_BILLING_PATH = "/frozen/billing"`。`FROZEN_ACCOUNT_PATH` と同じくファイルの先頭に置き、JSDoc に「凍結中の利用者が有料プランの解約の予約と Billing Portal を使う画面 (billing/01 §10.5)」)。説明の段落の最後の文「凍結中でも、データの書き出しと退会はできます。」を「凍結中でも、データの書き出しと退会、有料プランの解約はできます。」にする。ファイル冒頭の JSDoc に「billing/01 §10.5: 凍結中でも、有料プランの解約の画面 (/frozen/billing) へ行ける。」の 1 行を足す。ほかは変えない (ログアウトの順番・リンクの並び・文言)。
- テスト: 116・117 (`src/__tests__/app/frozen-billing-page.test.tsx`)・118 (`src/__tests__/app/frozen-account-page.test.tsx` の `/frozen` の describe)。

---

## 11. 退会との結合 (#1562)

`src/lib/account-deletion.ts` の `deleteAccount` に段階を 2 つ足す。どちらも同じ `cancelForAccountDeletion` を呼ぶ (`phase` だけが違う):

- **`billing`**: `check_blockers` の直後・`prepare` の前。Stripe の失敗で止まったとき、まだ何も変えていないのでやり直せる。
- **`billing_recheck`**: `storage` のあと・`delete_user` の直前 (#1562 の削除の実行記録の段階 `record` (`begin_account_deletion_record`) がある main では `storage` → `record` → `billing_recheck` → `delete_user` の順。`record` は同じ利用者の記録を使い直すので、`billing_recheck` の失敗のあとのやり直しで記録は増えない)。段階 `billing` から `deleteUser` までの間 (`storage` は最長 45 秒。`src/lib/account-deletion-storage.ts` の既定) も本人のセッションは有効なので、その間に完了した Checkout (退会の画面とは別のタブで買った、など) の契約と、その間に作られた顧客を、`deleteUser` の前にもう一度閉じる。`deleteUser` のあとは行が CASCADE で消え、写像は「退会済み」になるので、ここで閉じないと Stripe の契約が残る。失敗したら `delete_user` に進まない (アカウントは残り、もう一度の退会で片付く。`delete_user` の失敗と同じ扱い)。

`cancelForAccountDeletion` の中身は 3 つ: (1) 顧客の開いたままの Checkout Session を閉じる (`expire`。閉じた Session は完了できない。先に閉じるのは、契約を列挙したあとで完了されて取りこぼすのを防ぐため)・(2) 顧客の全契約と DB の行の和のうち終端でないものを即時解約する・(3) 顧客を匿名化する (まだなら)。`deleteUser` のあとに届く Webhook (`billing_recheck` の列挙のあと `deleteUser` までの一瞬に完了した契約) は、写像が `user_deleted` (`customer_closed` = true) を返し、`syncSubscription` が終端でない契約を即時解約する (§8.6・§7.3)。

```ts
// tsc:skip append=src/lib/account-deletion.ts — 足す型 (ファイルの末尾に足す。既存の AccountDeletionStep を使うので単独では検査できない。§8.0 の手順で末尾に足して検査する)
/** 退会で Stripe を扱う 2 つの段階 (billing/01 §11) */
export type AccountDeletionBillingPhase = Extract<AccountDeletionStep, 'billing' | 'billing_recheck'>;

/**
 * 段階 billing / billing_recheck のロガー (createLogger(...).withUser(...) が返すものの一部)。
 * AccountDeletionLogger (= ReturnType<typeof createLogger>) は使わない: deleteAccount が渡す userLog = log.withUser(userId) の戻り値は
 * withUser を持たず、AccountDeletionLogger には代入できない (account-deletion-storage.ts の AccountStorageLogger と同じ形にする)
 */
export interface AccountDeletionBillingLogger {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface AccountDeletionBillingReport {
  /** 即時解約した契約の数 */
  cancelled_subscriptions: number;
  /** 閉じた (expire) Checkout Session の数 */
  expired_checkout_sessions: number;
  /** 顧客 (billing_customers) があれば anonymized (この呼び出しで匿名化した、または匿名化済み)。無ければ none */
  customer: 'anonymized' | 'none';
}

export interface AccountDeletionBilling {
  /**
   * 開いたままの Checkout Session を閉じ、契約を即時解約し、顧客を匿名化する。顧客も Stripe-backed の行も無ければ何もしない。
   * 失敗は例外 (その段階で止める)。同じ利用者に何度呼んでも同じ結果になる (2 回目は、閉じる Session・解約する契約が無ければ何もしない)
   */
  cancelForAccountDeletion(
    userId: string,
    log: AccountDeletionBillingLogger,
    phase: AccountDeletionBillingPhase,
  ): Promise<AccountDeletionBillingReport>;
}
```

```ts
// tsc:skip — src/lib/account-deletion.ts の差分の抜粋 (説明。§8.0 の手順は同じ差分を差し込んで検査する)
export type AccountDeletionStep =
  | 'init'
  | 'check_blockers'
  | 'billing'            // 追加: 開いた Checkout を閉じ、Stripe の契約を即時解約し、顧客を匿名化する (billing/01 §11)
  | 'prepare'
  | 'release_membership'
  | 'storage'
  | 'billing_recheck'    // 追加: deleteUser の直前にもう一度 (段階 billing のあとに生まれた Checkout の完了・契約・顧客を閉じる。billing/01 §11)
  | 'delete_user';

export interface DeleteAccountParams {
  // … 既存 …
  /** テストで差し替える。既定は src/lib/billing/account-deletion.ts の実装 */
  billing?: AccountDeletionBilling;
}

// import に足す: import { defaultAccountDeletionBilling } from '@/lib/billing/account-deletion';
// (billing/account-deletion.ts は account-deletion.ts から型だけを import するので、実行時の循環は無い)

// deleteAccount の中 (completionEmailTo を控えたあと、prepare の前):
    step = 'billing';
    const billing = params.billing ?? defaultAccountDeletionBilling;
    const billingReport = await billing.cancelForAccountDeletion(userId, userLog, 'billing');
    // … 既存の prepare・release_membership・storage …

// storage のあと、step = 'delete_user' の前:
    step = 'billing_recheck';
    const billingRecheckReport = await billing.cancelForAccountDeletion(userId, userLog, 'billing_recheck');
    // … 既存の delete_user …
    // 最後の 'account deleted' のログに billing: billingReport, billing_recheck: billingRecheckReport を足す
```

```ts
// tsc:skip place=src/lib/billing/account-deletion.ts — 新設モジュール同士と、足した型 (上のブロック) を import するので単独の検査から外す (§8.0 の手順で置き場所に置いて検査する)
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { createBillingRepository } from '@/lib/billing/repository';
import { isTerminalStripeStatus, type StripeGateway, type StripeSubscription } from '@/lib/billing/core';
import type {
  AccountDeletionBilling,
  AccountDeletionBillingLogger,
  AccountDeletionBillingPhase,
  AccountDeletionBillingReport,
} from '@/lib/account-deletion';

/**
 * 退会で解約する契約を集める。DB の行だけでは足りない (Webhook が着く前の契約・写像が BILL_LIVE_ROW_CONFLICT /
 * BILL_UNKNOWN_PLAN で失敗した契約は行が無い) ので、(1) 顧客の全契約を Stripe から列挙し、(2) DB の行のうち (1) に無いもの
 * (別の顧客で作られた契約) を Stripe から取り直して足す。終端 (canceled / incomplete_expired) は除く。
 */
export async function collectSubscriptionsToCancel(
  gateway: StripeGateway,
  customerId: string | null,
  knownSubscriptionIds: readonly string[],
): Promise<StripeSubscription[]> {
  const byId = new Map<string, StripeSubscription>();
  if (customerId !== null) {
    for (const sub of await gateway.listCustomerSubscriptions(customerId)) byId.set(sub.id, sub);
  }
  for (const id of knownSubscriptionIds) {
    if (!byId.has(id)) byId.set(id, await gateway.retrieveSubscription(id));
  }
  return [...byId.values()].filter((sub) => !isTerminalStripeStatus(sub.status));
}

/**
 * 顧客の開いたままの Checkout Session を全部閉じ、閉じた数を返す。契約の列挙より先に呼ぶ (閉じたあとは、その Session から契約が生まれない)。
 * 列挙してから閉じるまでの間に完了 (または期限切れ) になった Session は閉じられない (Stripe が 4xx)。そのときは Session を取り直し、
 * もう open でなければ飛ばす (完了した Session の契約は、このあとの契約の列挙 (2) に出て解約される)。open のままなら投げる (その段階で止める)
 */
export async function expireOpenCheckoutSessions(gateway: StripeGateway, customerId: string): Promise<number> {
  let expired = 0;
  for (const session of await gateway.listOpenCheckoutSessions(customerId)) {
    try {
      await gateway.expireCheckoutSession(session.id);
      expired += 1;
    } catch (error) {
      const current = await gateway.retrieveCheckoutSession(session.id);
      if (current.status === 'open') throw error;
    }
  }
  return expired;
}

export const defaultAccountDeletionBilling: AccountDeletionBilling = {
  async cancelForAccountDeletion(
    userId: string,
    log: AccountDeletionBillingLogger,
    phase: AccountDeletionBillingPhase,
  ): Promise<AccountDeletionBillingReport> {
    const repository = createBillingRepository();
    const customer = await repository.findCustomer(userId);
    const knownRows = await repository.listStripeBackedSubscriptions(userId);
    if (customer === null && knownRows.length === 0) return { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' };
    // 顧客か契約があるのに鍵が無ければ、解約の義務を果たせないので止める (StripeNotConfiguredError → その段階の 500)
    const gateway = createStripeGateway();
    // (1) 開いたままの Checkout を先に閉じる
    const expired = customer === null ? 0 : await expireOpenCheckoutSessions(gateway, customer.stripe_customer_id);
    // (2) 終端でない契約を即時解約する
    let cancelled = 0;
    const knownIds = knownRows.map((row) => row.stripe_subscription_id);
    for (const sub of await collectSubscriptionsToCancel(gateway, customer?.stripe_customer_id ?? null, knownIds)) {
      await gateway.cancelSubscriptionNow(sub.id);
      cancelled += 1;
    }
    if (customer === null) {
      log.info('account deletion: stripe subscriptions cancelled (no billing customer row)', { phase, cancelled_subscriptions: cancelled });
      return { cancelled_subscriptions: cancelled, expired_checkout_sessions: 0, customer: 'none' };
    }
    // (3) 顧客を匿名化する。匿名化済み (1 回目の段階 billing・前の退会の試み) なら Stripe も DB もそのまま (anonymized_at は最初の時刻を保つ)。
    //     段階 billing のあとで作られた顧客 (1 回目は顧客が無かった) は、2 回目 (billing_recheck) でここを通る
    if (customer.anonymized_at === null) {
      const anonymizedAt = new Date().toISOString();
      await gateway.anonymizeCustomer(customer.stripe_customer_id, anonymizedAt);
      await repository.markCustomerAnonymized(customer.stripe_customer_id, anonymizedAt);
    }
    // 監査: 1 回目 (billing) は必ず書く。2 回目 (billing_recheck) は閉じた Session・解約した契約があったときだけ書く (無ければ行を増やさない)
    if (phase === 'billing' || cancelled + expired > 0) {
      await repository.recordAudit({
        // system.* なので actor_id は NULL (§8.1 の規則。退会の操作そのものの記録は deleteAccount のログにある)
        actor_id: null, action_type: 'system.billing.account_deletion_stripe_cancelled', target_type: 'user', target_id: userId, severity: 'info',
        details: { phase, cancelled_subscriptions: cancelled, expired_checkout_sessions: expired, stripe_customer_id: customer.stripe_customer_id },
      });
    }
    log.info('account deletion: checkout sessions expired, stripe subscriptions cancelled and customer anonymized', {
      phase, cancelled_subscriptions: cancelled, expired_checkout_sessions: expired,
    });
    return { cancelled_subscriptions: cancelled, expired_checkout_sessions: expired, customer: 'anonymized' };
  },
};
```

- 解約する契約の母集合は `collectSubscriptionsToCancel` の和 (Stripe の顧客の全契約 ∪ DB の行)。DB の行だけで列挙すると、Webhook が着く前に退会した契約・§13.3 の業務エラーで写せなかった契約 (S12 の 2 本目・S13 の未知のプラン) が解約されずに課金が続く。両方に無い契約 (別の顧客で作られ、写像も失敗した契約) は見つけられない (§18 の 12)。
- 解約は即時 (`DELETE /v1/subscriptions/{id}`、日割りの返金なし)。顧客は `name / email / phone / description / address / shipping` を消し、`metadata.user_id` を消し `metadata.anonymized_at` を入れて残す (請求書・支払いの記録は Stripe に残る。確定済みの請求書に印字された氏名は Stripe の仕様で変わらない)。
- `billing_customers` は `deleteUser` で `user_id` が SET NULL になり、`anonymized_at` の入った行が残る。
- `stripe_webhook_events` は退会で触らない: 利用者を指す列が無く、`payload` は最小化した写しで氏名・メールアドレス・住所を持たない (§8.1 `minimizeStripeEventPayload`・§9.6)。退会の既存の規則 (`prepare_account_deletion` が DB に残る生のメールアドレスを伏せる。`20261010000100_auth_users_fk_on_delete.sql`) に当たる値がこの表には入らない。残るのは Stripe の id (`cus_` / `sub_` / `in_`)・金額・期間だけで、`cus_` の顧客は上で匿名化済み。
- 退会後に届く Webhook は RPC が `skipped: 'user_deleted'` を返す (S10)。metadata.user_id の無い契約 (Dashboard で作った契約) も、この段階が入れた `billing_customers.anonymized_at` と `deleteUser` の SET NULL で、対応表の行が `user_id IS NULL AND anonymized_at IS NOT NULL` になるので同じく `user_deleted` (§6.4 (9) の 1.)。このため `markCustomerAnonymized` は `deleteUser` より前 (この 2 つの段階の中) に必ず通す。
- 退会後に Stripe の契約が終端でないまま届いたとき (`billing_recheck` の列挙のあと `deleteUser` までの一瞬に完了した Checkout など) は、`user_deleted` の `customer_closed` (対応表の行の `user_id` が NULL = この環境で退会した利用者の顧客) が true なので、`syncSubscription` がその場で Stripe の契約を即時解約し、監査 `system.billing.orphan_subscription_cancelled` (warn) を書く (§8.6)。解約のあとに届く `customer.subscription.deleted` は終端なので何もしない。
- 退会の段階 `billing` が終わったあと退会が途中で失敗し、利用者がそのまま使い続けた場合: 顧客は匿名化済み (`anonymized_at` あり) だが `user_id` は残るので `customer_closed` は false で、そのあとの購入はふつうに写る (自動で解約しない)。次の購入の Checkout は匿名化済みの顧客を使い回す (氏名・メールの無い顧客。Checkout の画面で支払い情報を入れ直す)。
- `cross/08` §16.3 の「Stripe の顧客・サブスクリプション: 行っていない」の行と §19 の TODO は、本冊を指すように直す (§16.2)。
- `docs/design/cross/08` §16.2 の退会の手順の一覧に「2'. Stripe の Checkout を閉じ、契約を解約し、顧客を匿名化 (`billing`)」と「4'. もう一度 (`billing_recheck`。`deleteUser` の直前)」を足す。

---

## 12. 配線の冊が読む契約 (本冊で確定)

| 契約 | 内容 | 配線での使い方 |
|---|---|---|
| 写像の入口 | `billing_apply_stripe_subscription(p_snapshot, p_fetched_at, p_source)` (§6.4) / TS では `syncSubscription(deps, subscriptionId, source)` (§8.6) | reconcile (`stripe_integrity_check`) は Stripe の全契約を列挙して 1 件ずつ `syncSubscription(…, 'wiring:reconcile')` を呼ぶ (自動修復 = 写像。05 §8 の「自動修復しない」は、写像が正本からの写しである以上、写すこと自体が修復になるので本冊で置き換える)。`syncSubscription` は、退会した利用者の顧客 (`customer_closed`) に残った終端でない契約を Stripe で即時解約する (§8.6) ので、reconcile もそれを拾う |
| `past_due → grace` | 配線の日次ジョブが `UPDATE personal_subscriptions SET status='grace', grace_started_at=now() WHERE status='past_due' AND past_due_since <= now() - interval '7 days' AND stripe_subscription_id IS NOT NULL` を直接行う (写像は呼ばない)。**1 文の UPDATE で書く** (先に SELECT してから id で UPDATE しない): 写像は契約の行を `FOR NO KEY UPDATE` でロックしてから読む (§6.4 (9) の 3.) ので、この UPDATE とは行ロックで直列になる。写像が先ならこの UPDATE は待ってから写像の書いた行で WHERE を評価し直し (回復して `active` になった行は進めない)、この UPDATE が先なら写像は commit 済みの `grace` を読む。advisory lock は取らなくてよい。写像は Stripe が `past_due / unpaid` の間 `grace` (と `grace_started_at`) を保つ | `grace_period_check` (09:30 JST) |
| `grace → cancelled` | 配線のジョブが `grace_started_at <= now() - interval '23 days'` の行の Stripe を `cancelSubscriptionNow` し、届く `deleted` の写像で `cancelled` になる (DB を直接 `cancelled` にしない) | 同上 |
| 手動付与 | `stripe_subscription_id IS NULL` の行。`02-manual-plan-grant.md` の DB 関数 `billing_grant_manual_subscription` / `billing_revoke_manual_subscription` / `billing_expire_manual_subscription_for_user` (service_role だけ。期限切れは日次のプロシージャ `billing_expire_manual_subscriptions` が利用者ごとに呼ぶ) で書く (admin の JWT の直接の INSERT では `plan_key_cached` と `family_groups` を同期できない: 特権列ガード)。写像は触らない。`get_effective_plan` は区別しない | 運営の手動付与の画面・API |
| 家族グループのプラン | 不変条件「active なグループの `plan_key` = いまの代表者の live な家族プランの契約のプラン (無ければ free)」を、写像 (購入・終了) とトリガー (グループの作成・代表者の交代。§6.4 (10)) が保つ。例外は service_role の直接の UPDATE (運営の手動) だけ | family の画面・運営の手動付与 (手動付与は代表者の個人契約 (M 行) で入れれば、次のグループ作成・交代でトリガーが拾う。付与・取り消し・期限切れの関数が写像と同じ式で反映する (02 §6)) |
| 一時停止 (`paused`) | 配線が Stripe `pause_collection` を付け DB を `paused` (`paused_until` 必須) にする。**順は Stripe が先**: `pause_collection` を付けた応答を受けてから、1 文の UPDATE (WHERE に元の status の条件を入れる。どの status から止めるかは配線の冊) で DB を `paused` にする (逆順だと、その間に届いた写像が Stripe の `active` (pause_collection なし) を読んで `active` に戻す)。写像とは契約の行のロックで直列になる (上の `past_due → grace` と同じ)。写像は `active + pause_collection` の間 `paused` を保つ。`pause_collection` を外せば `active` に戻る | 組織ライセンス受領 (04 §5.4) |
| 顧客の対応表 | `billing_customers (stripe_customer_id PK, user_id UNIQUE NULL 可, anonymized_at)` | Finance 画面の deep link (`getStripeLinks`) |
| Webhook のイベント | `stripe_webhook_events` に全イベントの最小化した写し (`payload` = `StoredStripeEventPayload`。§8.1。氏名・メールアドレス・住所を持たない。配線が足す処理も `minimizeStripeEventPayload` を通して書く)。`processing_status` / `processing_started_at` / `attempt_count` / `error_message` (固定のコード) | 再処理は Stripe の再送が運ぶ (処理済みでないイベントには 2xx を返さないので、Stripe は最長 3 日まで再送し、`failed` と 15 分を過ぎた `processing` は再送で取り直される)。`stripe_event_stuck_check` は再処理のためには要らない。3 日の再送が尽きて残った `failed` / `processing` (`processing_started_at` が古い行) は、reconcile が写像で整合させ、Finance 画面に一覧を出す |
| イベントの追加 | `STRIPE_EVENT_ACTIONS` に 1 行 (`charge.dispute.created` など) + `service.ts` の `switch` に 1 分岐 + Dashboard の登録 | チャージバック・メール |
| 監査 | `admin_audit_logs` の `action_type` (§8.1 `BILLING_AUDIT_ACTIONS` の 9 つ)。`system.*` は `actor_id NULL`。`target_type` は `user` / `stripe_event` / `stripe_subscription` (§8.1 `BILLING_AUDIT_TARGET_TYPES`) | Finance 画面の履歴 (`system.billing.orphan_subscription_cancelled` (warn) は、退会した利用者の顧客に残った契約を解約したもの。最初の請求が済んでいれば運営が Stripe で返金する。§18 の 17) |
| 要約 | `GET /api/billing/subscription` (`BillingSummary`)。状態の文は `billingStatusLines` (§8.1・§10.3 の表) | モバイルの表示 |
| 凍結 (BAN) と課金 | 凍結 (`user_profiles.frozen_at`) は契約の行も Stripe の課金も変えない。写像と Webhook は利用者の凍結を見ない。凍結中の利用者は `/frozen/billing` から解約の予約と Billing Portal ができる (`FROZEN_ALLOWED_API_PATHS` に足す課金の 3 本と `requireUserAllowingFrozen`。§9.8・§10.5)。核に、凍結で Stripe の契約を止める (解約・一時停止) 処理は無い (§18 の 20) | 配線の冊も凍結を見ない (grace・reconcile は凍結と関係なく同じ)。運営が凍結にあわせて契約を解約・返金するときは Stripe で行い、届く `deleted` を写像が写す |
| `grace` の機能制限 | `get_effective_plan` は `grace` を含めたまま。制限は各入口 (AI など) が `status='grace'` を見て 402 にする (05 §9) | 配線 |
| 環境変数 | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (一覧)。鍵の有無は `createStripeGateway` が判定 | Vercel Cron の route も同じ gateway を使う |

---

## 13. エラー表

### 13.1 API (利用者向け。本文は固定の文)

| コード | HTTP | 出どころ | 文 (`BILLING_ERROR_MESSAGES`) |
|---|---|---|---|
| `BILL_INVALID_INPUT` [NEW] | 400 | Zod | 最初の issue の文 (details に全件) |
| `AUTH_UNAUTHENTICATED` | 401 | `requireUser` | 認証が必要です |
| `AUTH_ACCOUNT_FROZEN` | 403 | middleware (凍結中の `/api/*`。`code` は同じで文は「アカウントが凍結されています」)・`requireUser` | 権限がありません。凍結中も通す 3 本 (`GET /api/billing/subscription`・`POST /api/billing/subscription/cancel`・`POST /api/billing/portal`。§9.8) は返さない |
| `BILL_CHECKOUT_SESSION_MISMATCH` [NEW] | 403 | sync | このお申し込みは確認できません |
| `BILL_CUSTOMER_NOT_FOUND` [NEW] | 404 | portal | お支払い情報がまだありません |
| `OP_SUBSCRIPTION_ALREADY_ACTIVE` | 409 | checkout | すでに有効な契約があります |
| `BILL_NO_LIVE_SUBSCRIPTION` [NEW] | 409 | cancel / resume | 有効な契約がありません |
| `BILL_CANCEL_NOT_SCHEDULED` [NEW] | 409 | resume | 解約は予約されていません |
| `BILL_PLAN_NOT_PURCHASABLE` [NEW] | 422 | checkout / preview | このプランは現在お申し込みできません |
| `RATE_LIMITED` | 429 | `rateLimitExceededResponse` | 既存の文 |
| `INTERNAL_ERROR` | 500 | `internalError` (nested) | 処理中にエラーが発生しました |
| `EXT_STRIPE_API_FAILED` [NEW] | 502 | gateway | 決済サービスとの通信に失敗しました。しばらくしてからお試しください |
| `EXT_STRIPE_NOT_CONFIGURED` [NEW] | 503 | gateway | お支払いを受け付けていません |

[NEW] は `cross/04` §4.2 に追記する (`BILL_` の接頭辞の行を §4.1 の表に足す。§16.2)。

### 13.2 Webhook (Stripe 向け。本文は固定の語)

| HTTP | 本文 | 意味 |
|---|---|---|
| 200 | `{ received: true, action, detail }` / `{ received: true, duplicate: true }` / `{ received: true, ignored: true }` | 処理した / 既に処理済み (`completed`) / 対象外・モード不一致 |
| 409 | `{ error: 'event_in_progress' }` | 同じ `event.id` をほかが処理中 (15 分以内)。Stripe が後で再送する |
| 400 | `{ error: 'invalid_payload' }` | JSON でない・外形が違う |
| 401 | `{ error: 'unauthorized' }` | 署名が無い・合わない・時刻が古い |
| 413 | `{ error: 'payload_too_large' }` | 1 MiB 超 |
| 500 | `internalError` の本文 | 処理の失敗 (Stripe が再送する) |
| 503 | `{ error: 'webhook_not_configured' }` / `{ error: 'stripe_not_configured' }` | 署名の秘密が無い / 鍵が無い |

### 13.3 DB 関数の業務エラー (`P0001`。TS では `BillingRpcError`)

| コード | DETAIL | 意味 | 扱い |
|---|---|---|---|
| `BILL_UNKNOWN_USER` | subscription id | metadata にも対応表にも既存の行にも利用者が無い (対応表の行が退会で匿名化済み = `user_id IS NULL AND anonymized_at IS NOT NULL` のときは、このエラーにせず `skipped: 'user_deleted'`。§6.4 (9) の 1.・S10) | イベント `failed`・500・監査 `system.stripe.event_failed`。運営が Stripe の顧客に `metadata.user_id` を付けるか、契約を解約する。対応表の行が `user_id IS NULL` で `anonymized_at` が無いとき (退会の手順 (§11) を通らずに利用者が消え、Stripe の契約が解約されていないかもしれない) もこのエラーで、運営が Stripe で契約を確かめて解約する |
| `BILL_UNKNOWN_PLAN` | subscription id / plan_key | plan_key を解決できない、または `subscription_plans` に無い | 同上。運営が Price を `subscription_plans` に登録する |
| `BILL_UNKNOWN_STRIPE_STATUS` | status | Stripe が未知の status を返した (API 版の変更) | 同上。`STRIPE_API_VERSION` と Zod を見直す |
| `BILL_LIVE_ROW_CONFLICT` | 既存の live 行の id | 同じ利用者に別の live 行 (別の Stripe 契約、または手動付与) がある。S12 の 2 本目、S19 で一時停止中に別の契約を買ってから再開した場合、`incomplete` の 1 本目が別の契約を買ったあとで完了した場合 (§7.3) | 同上。運営が Stripe で 2 本目を解約・返金する (S12)。解約すると届く `deleted` の写像が 2 本目の `cancelled` の行を INSERT する (§7.3 の「– → cancelled / expired」の行)。行が無いままでも、退会のときは Stripe の顧客の一覧から解約される (§11) |

---

## 14. テスト一覧 (it 名)

### 14.1 単体 (`npm test`。DB も Stripe も使わない)

`tests/billing-core.test.ts` (`src/lib/billing/core.ts`):
1. `it('STRIPE_TO_DB_STATUS maps all 8 Stripe statuses and matches §6.4')` (期待値はテスト 53 と同じ 8 組をリテラルで書く。§8.2)
2. `it('classifyStripeEvent returns ignore for unknown types and the table for subscribed types')`
3. `it('STRIPE_SUBSCRIBED_EVENT_TYPES lists exactly the keys of STRIPE_EVENT_ACTIONS')`
4. `it('projectSubscription converts unix seconds to ISO and reads price/interval/metadata')`
5. `it('projectSubscription leaves user_id/plan_key null when metadata is empty')`
6. `it('resolvePlanKey prefers metadata.plan_key over the price lookup')`
7. `it('invoiceSubscriptionId reads acacia (top-level) and basil (parent) shapes and expanded objects')`
8. `it('isPurchasable rejects free, draft, org, missing price, zero amount')`
9. `it('trialDaysFor returns 0 when the trial was already used')`
10. `it('buildCheckoutSessionParams omits trial_period_days when trialDays is 0')`
11. `it('checkoutReturnUrls keeps the {CHECKOUT_SESSION_ID} placeholder')`
12. `it('toFormBody encodes nested objects and arrays in Stripe form style and skips null/undefined')`
13. `it('stripeKeyMode reads sk_/rk_ live and test prefixes')`
14. `it('summarizeSubscription: no row → free/can_purchase, live row (paused included) → can_cancel, scheduled → can_resume, manual row → no cancel')`
15. `it('StripeEventEnvelopeSchema rejects ids that do not start with evt_')`
16. `it('core.ts imports nothing but zod')` (ソース走査: `import` 行が `zod` だけ)

`src/__tests__/lib/webhook/verify.test.ts` (追加):
17. `it('verifyStripeSignature accepts a valid t/v1 signature over "t.payload" with the raw secret')`
18. `it('verifyStripeSignature accepts when one of several v1 signatures matches (secret rotation)')`
19. `it('verifyStripeSignature rejects missing header, non-numeric t, out-of-tolerance t, mismatched v1, empty secret')`
20. `it('verifyStripeWebhook throws WebhookSecretMissingError when STRIPE_WEBHOOK_SECRET is unset or blank')`

`tests/billing-stripe-gateway.test.ts` (fetch を偽物に):
21. `it('sends Stripe-Version, Bearer key, form-encoded body and Idempotency-Key for customers')`
22. `it('maps non-2xx to StripeApiError with status/type/code/request-id and never exposes the raw message in .message')`
23. `it('throws StripeNotConfiguredError when STRIPE_SECRET_KEY is unset')`
24. `it('cancelSubscriptionNow sends DELETE with prorate=false&invoice_now=false')`
25. `it('anonymizeCustomer clears name/email/phone/description/address/shipping/metadata.user_id')`

`tests/billing-service.test.ts` (gateway と repository を偽物に):
26. `it('startCheckout: 409 when a live row exists (stripe-backed or manual)')`
27. `it('startCheckout: 422 when plan is not purchasable for the interval')`
28. `it('startCheckout: creates the customer once and reuses it; trial 0 when already used')`
29. `it('syncSubscription: retrieves from Stripe, resolves plan via metadata then price, applies with fetchedAt')`
30. `it('syncCheckoutSession: 403 when client_reference_id is not the user; no apply when session is not complete')`
31. `it('scheduleCancellation is idempotent and audits once (a Stripe-backed paused row can be scheduled too); revokeCancellation 409 when not scheduled; both throw BILL_NO_LIVE_SUBSCRIPTION without calling Stripe when there is no live row or the live row is manual (stripe_subscription_id null)')` (§7.3 の解約の予約・取り消しの 3 行 = 409 の 2 行と、予約済みの 2 回目の予約の行)
32. `it('handleStripeEvent: ignore / sync_subscription / invoice with and without subscription / payment_failed audits')`
33. `it('handleStripeEvent uses nothing from data.object except id, the invoice subscription ref, and the invoice id / attempt_count / amount_due in the system.payment.failed audit details, and the apply snapshot comes only from the re-fetched subscription')` (§8.2。`customer.subscription.updated`・`invoice.paid`・`invoice.payment_failed` の 3 つのイベントで、`data.object` のほかの項目 (`customer_email`・`customer_name`・`amount_paid`・`status`・`metadata`・`lines` など) に目印の文字列・数値を入れて流す。偽の gateway と repository が受け取った引数を `JSON.stringify` してどこにも目印が出ないこと、`invoice.payment_failed` の監査の `details` のキーがちょうど `stripe_subscription_id`・`invoice_id`・`attempt_count`・`amount_due`・`event_id` の 5 つで値がイベントのものであること、`applyStripeSubscription` の snapshot が偽の `retrieveSubscription` の返した Subscription から作られる (請求の `attempt_count`・`amount_due` を持たない) ことを見る。`data.object` を Proxy で包んで「読んだキー」を数える書き方は、`StripeInvoiceRefSchema` (`looseObject`) が知らない項目まで読むので使わない)

`tests/api/billing-routes.test.ts` (route。`@/lib/billing/service` をモック。認証は `@/lib/auth/helpers` の `requireUser` と、凍結中も通す 3 本 (`subscription`・`subscription/cancel`・`portal`) が使う `@/lib/billing/auth` の `requireUserAllowingFrozen` の両方をモックする。§9.8):
34. `it('POST /api/billing/checkout: 401 unauthenticated, 403 frozen, 429 rate limited, 400 invalid body, 200 url')`
35. `it('every billing route maps BillingError/StripeApiError/StripeNotConfiguredError to the table and returns fixed messages')`
36. `it('GET /api/billing/subscription returns the summary with Cache-Control: no-store')`

`tests/webhooks-stripe-route.test.ts`:
37. `it('413 for oversized body before verifying the signature')`
38. `it('503 webhook_not_configured when the secret is missing; 401 on bad signature; 400 on bad JSON')`
39. `it('200 ignored on livemode mismatch without touching the repository')`
40. `it('200 duplicate when claim returns completed; 409 event_in_progress when claim returns in_progress; 200 synced when handled; 500 and finish(ok=false) on failure')`
41. `it('response bodies never contain the event payload or raw error text')`

`tests/account-deletion.test.ts` (追加):
42. `it('runs the billing step after check_blockers and before prepare, and the billing_recheck step after storage and right before deleteUser; a failure in billing stops with step billing without prepare/deleteUser, and a failure in billing_recheck stops with step billing_recheck without deleteUser')` (§11。偽の `billing` に渡る `phase` と呼ばれた順を見る)
43. `it('skips Stripe in both billing passes when the user has neither a billing customer nor a stripe-backed row')`

`tests/billing-migration-contract.test.ts` (SQL の文面。DB は使わない):
44. `it('migration adds incomplete to the status CHECK and keeps the other 7 values')`
45. `it('migration drops the user_id = auth.uid() branch from INSERT/UPDATE policies and keeps SELECT/DELETE policies')`
46. `it('billing RPC functions are SECURITY DEFINER with search_path = "" and EXECUTE only for service_role; the trigger function billing_family_plan_follow_representative is SECURITY DEFINER with search_path = "" and revoked from PUBLIC/anon/authenticated')`
47. `it('rollback restores the baseline policies and the 20261008200700 guard definitions verbatim and drops everything the migration added')`
48. `it('migration contains no UPDATE/DELETE of existing rows outside function bodies')`
49. `it('migration comment does not attribute decisions (no "オーナー判断")')`

`tests/public-claims-guard.test.ts` (更新):
50. `it('pricing page shows only the free card and the free FAQ (no 準備中 card, no pre-sale wording) when there is no purchasable plan: no rows, or the only row has no interval for which isPurchasable is true')` (#1911 で it の名前と期待値を改めた。2 つ目のモックは `stripe_price_id` はあるが `monthly_price_jpy: 0`・`stripe_yearly_price_id: null` の 1 件で、有料プランのカードも CTA も出ず、フリーのカードだけになる。§10.1 の「どちらも買えない → カードを描かない」)
51. `it('pricing page shows one card per purchasable plan with an amount and a CTA only for the intervals where isPurchasable is true (both Prices: 月額で始める → interval=month and 年額で始める → interval=year; no stripe_yearly_price_id: only the monthly amount and 月額で始める, no yearly amount and no interval=year link), without the 準備中 notice and the pre-sale FAQ, and hides the cards and CTA in native app mode')` (§10.1。page.tsx は `@/lib/billing/public-plans` と `next/headers` の `cookies` をモックし `renderToStaticMarkup(await PricingPage())` で描く。§16.1 の `public-claims-guard` の行。モックは 2 件: A = `plan_type: 'personal'`・月額 1,234・年額 12,340・`stripe_price_id` と `stripe_yearly_price_id` の両方あり、B = `plan_type: 'family'`・月額 2,345・年額 23,450・`stripe_yearly_price_id: null` (どちらも `status: 'public'`。金額は `FORBIDDEN` に無い値)。期待: A の `¥1,234`・`¥12,340`・`plan_key=<A>&amp;interval=month`・`plan_key=<A>&amp;interval=year`、B の `¥2,345`・`plan_key=<B>&amp;interval=month` があり、`¥23,450` と `plan_key=<B>&amp;interval=year` が無い (`renderToStaticMarkup` は `href` の `&` を `&amp;` で出す)。「年額で始める」はちょうど 1 回 (A の分) だけ出る)

追加 (番号は 72〜79。段は §15.1):

`tests/billing-core.test.ts` (追加):
72. `it('buildCheckoutSessionParams sets allow_promotion_codes=true and cancel_url to <site>/account/billing?checkout=cancelled')` (S15・S17)

`tests/billing-stripe-gateway.test.ts` (追加):
73. `it('createCheckoutSession sends allow_promotion_codes=true, client_reference_id and metadata[user_id] in the form body')` (S15。`toFormBody` を通した実際の本文で見る)

`src/__tests__/lib/rate-limit.test.ts` (追加。既存の contact の書き方に合わせる):
74. `it('billing カテゴリ: 同じ key で 10 回まで通り 11 回目は止まる (1 分の枠)')`

`tests/account-export-tables.test.ts` (追加):
75. `it('personal_subscriptions omits stripe_status and stripe_synced_at and exports cancel_at_period_end and billing_interval (billing/01 §7.1)')` (`loadSchemaModel` の列に対して `omit` を引いた出力の列で見る)

`src/__tests__/app/account/billing-pages.test.ts` (新設。設定画面の既存テストと同じく `.ts` + `React.createElement`、`@/hooks/useNativeAppMode` と `fetch` をモック):
76. `it('/account/billing?checkout=cancelled shows お申し込みは完了していません and does not call /api/billing/checkout/sync')` (S17)
77. `it('/account/billing in native app mode shows plan and status only: no Portal / cancel / resume / purchase buttons')` (S14)
78. `it('/account/billing/checkout in native app mode renders この操作はアプリでは行えません only and never calls /api/billing/checkout')` (S14・§10.2)

`src/__tests__/app/settings/billing-link.test.ts` (新設。`support-link.test.ts` と同じ形):
79. `it('settings shows プランとお支払い linking to /account/billing on web and hides it in native app mode')` (§10.3)

追加 (R1 の指摘への対応。番号は 81〜91。段は §15.1):

`tests/billing-stripe-gateway.test.ts` (追加):
81. `it('listCustomerSubscriptions sends GET /subscriptions?customer=<cus>&status=all&limit=100 with no body and follows has_more with starting_after')`
107. `it('listOpenCheckoutSessions sends GET /checkout/sessions?customer=<cus>&status=open&limit=100 and follows has_more; expireCheckoutSession sends POST /checkout/sessions/<id>/expire with no params')` (§11・§8.4)

`tests/billing-account-deletion.test.ts` (新設。`src/lib/billing/account-deletion.ts`。gateway と repository を偽物に):
82. `it('collectSubscriptionsToCancel unions the Stripe customer list with DB rows, retrieves DB-only ones, and drops canceled / incomplete_expired')`
83. `it('cancelForAccountDeletion cancels a Stripe subscription that has no DB row (webhook not yet arrived / BILL_LIVE_ROW_CONFLICT) and anonymizes the customer')` (S10・§7.3 の退会の 2 行目)
108. `it('cancelForAccountDeletion expires open Checkout Sessions before listing and cancelling subscriptions (a session that completed between the list and the expire is skipped when re-retrieved as complete, and rethrown when still open); the billing_recheck pass cancels a subscription completed after the billing pass, anonymizes a customer created after it, does not re-anonymize an already anonymized customer, and audits only when it expired or cancelled something')` (S10・§11。偽の gateway に呼ばれた順を記録して、`expireCheckoutSession` が `listCustomerSubscriptions` より先であることを見る)

`tests/account-export-tables.test.ts` (追加):
85. `it('billing_customers is in ACCOUNT_EXPORT_EXCLUDED with a reason (billing/01 §6.3)')`

`tests/webhooks-stripe-route.test.ts` (追加):
86. `it('maxDuration is a numeric literal in the route source and equals STRIPE_WEBHOOK_MAX_DURATION_SECONDS')` (route を import して `maxDuration` の値を比べ、route のソースが `/^export const maxDuration = \d+;/m` に当たることを見る。§9.6)

`tests/billing-core.test.ts` (追加):
89. `it('isTerminalStripeStatus is true only for canceled and incomplete_expired; isStripeEventClaim accepts only claimed / completed / in_progress')`

`tests/billing-service.test.ts` (追加):
90. `it('recordStripeEventFailure finishes the event as failed and audits system.stripe.event_failed with target_type stripe_event and target_id null, and still resolves when the audit fails')`
100. `it('handleStripeEvent audits system.payment.failed for invoice.payment_failed when the apply is applied or skipped as stale (target_id = the user_id returned with stale), and does not audit when skipped as user_deleted')` (S4・S8(e)・§8.6)
109. `it('syncSubscription cancels the Stripe subscription immediately and audits system.billing.orphan_subscription_cancelled (target_type stripe_subscription, target_id null, warn) when the apply returns user_deleted with customer_closed and the Stripe status is not terminal; it does not cancel when the status is canceled / incomplete_expired or customer_closed is false; a failed cancel throws')` (S10・§7.3 の退会のあとに生まれた契約の行・§8.6)

追加 (R2 の指摘への対応。番号は 93〜97。段は §15.1):

`tests/api/billing-routes.test.ts` (追加):
93. `it('GET /api/billing/subscription and GET /api/billing/checkout/preview return 200 without STRIPE_SECRET_KEY: they pass only the repository to the service and never call createStripeGateway')` (S11・§9。`@/lib/billing/stripe-gateway` をモックして呼ばれないことを見る)
94. `it('AI reach inventory: the 5 Stripe-calling billing routes, the Stripe webhook route and account/delete reach the AI markers only through src/lib/env.ts, and the 2 GET billing routes do not reach them')` (`tests/helpers/ai-reach.ts` の `reachesAi` を、`src/lib/env.ts` を `seen` に入れた場合と入れない場合で当てる。§16.1 の `EXEMPT_ROUTES` の 7 行の理由「env.ts の一覧に届くだけ」の裏付け。既存のログインの it と同じ形)

`tests/billing-core.test.ts` (追加):
95. `it('minimizeStripeEventPayload keeps only the allowlisted scalar fields, normalizes customer and subscription refs (acacia, basil, expanded) to string ids, and drops customer_email / customer_name / customer_details / customer_address / invoice_pdf / hosted_invoice_url / lines / metadata')`

`tests/webhooks-stripe-route.test.ts` (追加):
96. `it('claims the event with the minimized payload: the repository receives minimizeStripeEventPayload(event) and never customer_email / customer_name / customer_details')` (偽の repository の `claimStripeEvent` の引数を見る。§9.6 の 6)

`tests/billing-public-plans.test.ts` (新設。`@/lib/supabase/server` の `createClient` と `@/lib/db-logger` をモック):
97. `it('listPurchasablePlans returns [] and logs an error when the query fails (the page shows 準備中 instead of an error page), and returns the rows on success')` (§10.1)

追加 (R3 の指摘への対応。番号は 98〜102。98・99・102 は §14.2、100 は上の `tests/billing-service.test.ts`。段は §15.1):

`apps/mobile/__tests__/app/no-web-purchase-links.test.ts` (新設。mobile の jest。`apps/mobile` で `npm test`。CI は `.github/workflows/mobile-test.yml`):
101. `it('no screen or module under apps/mobile/app and apps/mobile/src opens the Web purchase pages (/pricing, /account/billing) and the pricing screen app/(public)/pricing.tsx does not exist')` (§10.4・R11。`app/` と `src/` の `.ts` / `.tsx` を走査し、`/pricing` と `/account/billing` の文字列 (`webPath="/pricing"`・`href: "/pricing"`・`webPageUrl('/pricing')` の形を含む) が 0 件であることと、`app/(public)/pricing.tsx` が無いことを見る。拾い方が壊れて 0 件で通らないよう、同じ走査で `app/(public)/about.tsx` の `webPath="/about"` は拾えることも見る)

追加 (網羅性 周 5 への対応。番号は 110。段 B):

`tests/billing-service.test.ts` (追加):
110. `it('handleStripeEvent re-fetches and applies the subscription for customer.subscription.trial_will_end / pending_update_applied / pending_update_expired (syncSubscription with the object id) and for the subscription of invoice.payment_action_required (skipped as invoice_without_subscription when the invoice has none), and writes no system.payment.failed audit for any of them')` (§7.3 の 4 イベントの行・§8.6)

追加 (R5 の指摘への対応。番号は 111。段 B):

`tests/billing-core.test.ts` (追加):
111. `it('summarizeSubscription on rows shaped like the read-back after a Portal reservation and its revocation: a stripe-backed row with status active / trialing / past_due / grace and cancel_at_period_end true with cancel_at set gives can_resume true and can_cancel false; the same row with cancel_at_period_end false and cancel_at null gives can_cancel true and can_resume false')` (§7.3 の Portal の予約と取り消しの行の、画面の要約の側。行は `SubscriptionRowView` の形 (§8.5 `SUBSCRIPTION_VIEW_COLUMNS` の 9 列) をテストの中で組む。DB の側 (写像が `cancel_at_period_end`・`cancel_at` だけを変え、status を保ち、監査を書かない) はテスト 103 (段 A))

追加 (R6 の指摘への対応。番号は 112〜119。段は §15.1):

`tests/billing-core.test.ts` (追加。段 B):
112. `it('billingStatusLines gives one status line per live status (trialing 無料期間中（Xまで） / active ご利用中 / past_due お支払いに問題があります。お支払い方法をご確認ください / grace お支払いが確認できないため一部の機能を制限しています / paused 一時停止中), adds Yに解約されます as a second line when cancel_at_period_end (Y = cancel_at, else current_period_end, else 期間の終わりに解約されます), returns [] for a null or non-live status, and formatBillingDate cuts the date in Asia/Tokyo')` (§10.3 の表の全組 = live 5 値 × 予約の有無の 10 組と、`null`・`cancelled` の 2 組を、期待値の文字列のリテラルで書く (`BILLING_STATUS_TEXT` から組み立てない)。日付は `'2026-10-20T15:30:00Z'` (日本時間で 21 日) を使い「2026年10月21日」になることを見る。`trialing` で `trial_ends_at` が NULL のときは「無料期間中」だけ・`formatBillingDate('not-a-date')` は null)

`src/__tests__/app/account/billing-pages.test.ts` (追加。段 C):
113. `it('/account/billing shows the §10.3 status lines for every live status with and without a scheduled cancellation: active shows ご利用中 and never お支払いに問題があります, paused shows 一時停止中, and a scheduled cancellation adds …に解約されます under the status line')` (偽の `fetch` が `GET /api/billing/subscription` に 10 組の要約を返し、描いた文をテスト 112 と同じリテラルで見る)

`tests/api/billing-routes.test.ts` (追加。段 B):
114. `it('GET /api/billing/subscription, POST /api/billing/subscription/cancel and POST /api/billing/portal authenticate with requireUserAllowingFrozen and return 200 for a frozen user without calling requireUser; POST checkout / checkout/sync / subscription/resume and GET checkout/preview call requireUser and return 403 AUTH_ACCOUNT_FROZEN when it throws ForbiddenError')` (`@/lib/billing/auth` の `requireUserAllowingFrozen` と `@/lib/auth/helpers` の `requireUser` をモックする。§9.8)
115. `it('the billing routes whose URL path is in FROZEN_ALLOWED_API_PATHS call requireUserAllowingFrozen and not requireUser, and every other billing route calls requireUser and not requireUserAllowingFrozen')` (ソース走査: `src/app/api/billing/**/route.ts` を列挙し、ファイルのパスから URL (`/api/billing/…`) を作って `FROZEN_ALLOWED_API_PATHS` と突き合わせ、呼び出し (`requireUser(` / `requireUserAllowingFrozen(`) をコメントを除いたソースで見る。列挙が 7 本でなければ失敗 (走査の道が変わって 0 本で緑にならないように)。`FROZEN_ALLOWED_API_PATHS` の `/api/billing/` で始まる行がちょうど 3 本で、どれも列挙した route に当たることも見る。§9.8)

`tests/billing-auth.test.ts` (新設。`src/lib/billing/auth.ts`。`@/lib/supabase/server` の `createClient` をモック。段 B):
119. `it('requireUserAllowingFrozen returns the session user id and email without reading user_profiles, and throws AuthError AUTH_UNAUTHENTICATED when getUser returns no user or an error')` (偽の client の `from` は呼ばれたら失敗にする = 凍結の列を読まない)

`src/__tests__/app/frozen-billing-page.test.tsx` (新設。`frozen-account-page.test.tsx` と同じく `react-dom/client` + `act` で描く。`next/navigation` の `useRouter`・`@/lib/native-auth-bridge` の `isInNativeWebView`・`fetch`・`window.confirm`・`window.location.assign` をモック。段 C。§10.5):
116. `it('/frozen/billing reads GET /api/billing/subscription and shows the status lines; for a cancellable Stripe contract it confirms, calls POST /api/billing/subscription/cancel and shows the returned summary with …に解約されます and no cancel button; the Portal button calls POST /api/billing/portal and moves to its url; it never shows 解約を取り消す or a link to /pricing, and every fetched path is in FROZEN_ALLOWED_API_PATHS')`
117. `it('/frozen/billing shows 有料プランの契約はありません without buttons when status is null, no cancel button for a manual contract, only the status lines in the app WebView, the fixed message for a 409 / 429 / 500 from cancel, and goes to /login on 401')`

`src/__tests__/app/frozen-account-page.test.tsx` (追加。describe `凍結の画面 (/frozen)`。段 C):
118. `it('有料プランの解約の画面 (/frozen/billing) へのリンクがある')` (リンクの文「有料プランの解約・お支払い」・`href` = `/frozen/billing`。§10.5)

`tests/env-source-scan.test.ts` / `tests/check-env-script.test.ts`: 変更なし (一覧と `.env.example` を合わせれば緑)。

### 14.2 結合 (ローカル Supabase。`tests/integration/rls` と `security` に置き、CI の指定に当たる)

この節の 3 ファイル (と §16.1 で段 A に直す既存の結合テスト) は段 A のテストなので、段 B で作る `src/lib/billing/*` を import しない (段 A は単独でマージする。§15.1)。写像に渡す `p_snapshot` は、§6.4 の関数の本体が `p_snapshot->>'…'` で読むキーの JSON をテストの中で組み、期待値 (status の写像の 8 組など) はリテラルで書く。

`tests/integration/rls/billing-apply-subscription-rpc.test.ts`:
52. `it('inserts a trialing row from a snapshot with metadata.user_id and sets plan_key_cached')`
53. `it('maps all 8 Stripe statuses to the DB status: incomplete→incomplete, incomplete_expired→expired, trialing→trialing, active→active, past_due→past_due, unpaid→past_due, canceled→cancelled, paused→expired')` (期待値の 8 組はこのファイルにリテラルで書く (core.ts の `STRIPE_TO_DB_STATUS` は段 B なので import しない。§8.2)。8 組それぞれ別の利用者・行の無い契約の最初の写像で見る (live の衝突と保持の規則に当てないため))
54. `it('keeps grace while Stripe says past_due/unpaid and clears it on active')`
55. `it('keeps paused while Stripe is active with pause_collection, also when cancel_at_period_end is set or cleared (API / Portal reservation on a paused row)')` (§7.3 の予約の行の `paused`)
56. `it('skips stale snapshots (fetched_at <= stripe_synced_at) and applies newer ones')`
57. `it('raises BILL_LIVE_ROW_CONFLICT when another live row (manual) exists for the user')`
58. `it('raises BILL_UNKNOWN_PLAN when neither metadata nor existing row gives a plan')`
59. `it('resolves the user from billing_customers when metadata.user_id is missing and inserts the mapping when missing')`
60. `it('returns skipped user_deleted for a user that no longer exists, and for a subscription without metadata.user_id whose billing_customers row was anonymized by account deletion (user_id NULL, anonymized_at set); a customer row with user_id NULL and no anonymized_at still raises BILL_UNKNOWN_USER; customer_closed is true only when the subscription customer has a billing_customers row with user_id NULL (false for a customer unknown to this database)')` (S10・§6.4 (9) の 1.。顧客の対応表の行を作ってから利用者を消し (`user_id` が SET NULL)、`anonymized_at` を入れた場合と入れない場合の 2 通り。`customer_closed` は、metadata.user_id が消えた利用者で顧客の行あり (true) / 対応表に無い顧客 (false) / 匿名化済みの metadata の無い契約 (true) の 3 通り)
61. `it('syncs family_groups.plan_key and member_limit for the representative on live and resets to free on cancel')`
62. `it('writes one admin_audit_logs row per status change with actor_id NULL')`
63. `it('is not executable by anon/authenticated (42501)')`
64. `it('serializes concurrent applies for the same subscription (advisory lock)')`
80. `it('does not reset the family group to free when a non-live row ends while another live row of the same plan exists')` (§6.4 の 10. の `NOT EXISTS`)
84. `it('moves a live row to expired on Stripe paused and back to active on resumed, auditing both; a resumed row raises BILL_LIVE_ROW_CONFLICT when another live row exists')` (S19・§7.3)
87. `it('follows the representative on family_groups.representative_id change: new representative with a live family contract → that plan and limit; otherwise free/4 only when the old representative owned the plan; untouched otherwise')` (S18・§6.4 (10)。service_role で `UPDATE family_groups SET representative_id` を直接流してトリガーを動かす。family の RPC は認証 (`auth.uid()`) が要るので使わない)
92. `it('create_family_group ignores p_plan_key: the new group gets the representative live family plan and limit, or free without a contract')` (S20・F23。代表者の JWT で `create_family_group` を呼ぶ)
102. `it('a representative change or group creation that runs while the new representative apply is in progress waits on the billing-user advisory lock and follows the committed contract')` (§6.4 (10) の advisory。テスト 98 と同じく postgres-meta の接続で写像の側を `pg_sleep` で開いたままにし、service_role の `UPDATE family_groups SET representative_id` (テスト 87 と同じ形) が待ちに入ったのを `pg_stat_activity` で確かめてから写像を commit する。グループの `plan_key` / `member_limit` が新しい代表者の契約と一致する)
91. `it('active → Stripe unpaid becomes past_due with past_due_since set; past_due → unpaid keeps past_due_since and writes no audit')` (§7.3)
98. `it('an apply that runs while a direct UPDATE (past_due → grace, or active → paused) holds the row waits for it and keeps grace with grace_started_at / paused; a direct UPDATE that waits for an apply re-evaluates its WHERE on the applied row')` (§6.4 (9) の 3. の `FOR NO KEY UPDATE`・§12。`family-lock-order-race.test.ts` と同じく postgres-meta (`/pg/query`) の接続で「UPDATE のあと `pg_sleep` でトランザクションを開いたまま」にし、`pg_stat_activity` で待ちに入ったのを確かめてから RPC を呼ぶ。逆の順 (RPC を先に開いたまま、配線の UPDATE を後から) も 1 本)
99. `it('the first apply of a subscription with no row inserts a cancelled / expired row without the live-row conflict check, keeps plan_key_cached, resets the family group only when no live row of the same plan remains, and audits subscription_created with to = cancelled')` (§7.3 の「– → cancelled / expired」の行・S12。同じ利用者に live な 1 本目がある状態で、2 本目の snapshot を `canceled` で写す)

追加 (網羅性 周 4 への対応。番号は 103〜105。どれも上の `tests/integration/rls/billing-apply-subscription-rpc.test.ts`。段 A):
103. `it('a Portal-style updated snapshot that only sets / clears cancel_at_period_end on an active (also trialing / past_due / grace) row updates cancel_at_period_end and cancel_at, keeps the status, writes no admin_audit_logs row, and the read-back row has cancel_at_period_end true with cancel_at set, then false with cancel_at null')` (§7.3 の Portal の予約と取り消しの行の、DB の側。`p_source = 'webhook:evt_…'`。読み戻しは `personal_subscriptions` を service_role で SELECT して列の値を見る。画面の要約 (`summarizeSubscription` の `can_resume` / `can_cancel`) の側は段 B のテスト 111)
104. `it('an updated snapshot that keeps Stripe incomplete leaves the row incomplete, updates cancel_at_period_end / current_period_*, writes no status_changed audit and leaves plan_key_cached NULL')` (§7.3 の「`incomplete` のまま」の行)
105. `it('keeps plan_key of an existing row when a later snapshot carries another plan (price swapped in the Dashboard, with and without metadata.plan_key): stripe_price_id / billing_interval follow Stripe, plan_key / plan_key_cached / family_groups.plan_key and member_limit stay, no audit')` (§6.4 (9) の 4.・§7.3 の Price の付け替えの行。`family_basic` の代表者の行に `pro` の Price の snapshot を当てる)

追加 (R4 の指摘への対応。番号は 106〜109。106 は上の `tests/integration/rls/billing-apply-subscription-rpc.test.ts` で段 A、107〜109 は §14.1 の各ファイルで段 B):
106. `it('the apply for a family-plan representative locks family_groups before user_profiles: with a connection that holds the family row (FOR NO KEY UPDATE) and then updates user_profiles by family_id like operator_force_dissolve_family, and with operator_force_dissolve_family / the representative DELETE of the group running while the apply transaction is held open, nothing fails with 40P01 and the group ends dissolved / deleted with plan_key_cached synced')` (§6.4 (9) の 10.・§7.1 の family の関数の行。`family-lock-order-race.test.ts` の `startHolder` と同じ形: (a) postgres として `SELECT 1 FROM family_groups WHERE id = <G> FOR NO KEY UPDATE` のあと `pg_sleep`、続けて `UPDATE family_members SET status='left' …`・`UPDATE user_profiles SET family_id = NULL WHERE family_id = <G>`・`UPDATE family_groups SET status='dissolved' …` を流す接続を開き、`pg_stat_activity` で sleep に入ったのを確かめてから、代表者の `family_basic` の snapshot を service_role で写す (旧い順 = `user_profiles` が先だとここで 40P01)。(b) 写像の呼び出しのあと `pg_sleep` する接続を開いたまま、super_admin の JWT で `operator_force_dissolve_family` を、別の家族で代表者の JWT で `DELETE FROM family_groups` を呼ぶ。どれも `expectNoDeadlock` と同じ判定)

`tests/integration/rls/billing-webhook-events-claim-rpc.test.ts`:
65. `it('claims a new event, returns completed for a completed event and in_progress for a fresh processing one, re-claims failed and stuck processing')`
66. `it('finish sets completed/processed_at or failed/error_message (truncated)')`

`tests/integration/security/billing-personal-subscriptions-rls.test.ts`:
67. `it('authenticated user cannot INSERT or UPDATE own personal_subscriptions row (RLS) but can SELECT it')`
68. `it('admin can still INSERT/UPDATE; anon has no INSERT/UPDATE/DELETE privilege')`
69. `it('billing_customers is invisible to anon/authenticated and readable/writable by service_role')`
70. `it('updated_at advances on UPDATE of personal_subscriptions')`
88. `it('authenticated user cannot change own user_profiles.plan_key_cached by UPDATE nor set it on INSERT (CANNOT_MODIFY_PRIVILEGED_COLUMN), while service_role can')` (F21・§6.4 (11))

`tests/integration/security/auth-users-fk-on-delete.test.ts` (既存): `billing_customers.user_id` の FK が SET NULL で NULL 可であることを A・C が自動で確かめる (D の `EXPECTED_ACTIONS` に `'billing_customers.user_id': 'SET NULL'` を 1 行足す。§16.1)。

`tests/integration/security/account-export-scope.test.ts` (既存の「出力しない列」の it を延長): `personal_subscriptions` の `not.toHaveProperty` の一覧 (いま 4 列) に `stripe_status`・`stripe_synced_at` を足す (§7.1・§16.1)。

### 14.3 E2E (Playwright。Stripe のテストモードが要るので `tests/e2e/.manual/` に置き CI では流さない)
71. `it('E2E: buy pro monthly with test card 4242, land on /account/billing, see trialing')` (手順書 §17.4)。ファイルは `tests/e2e/.manual/billing-checkout.spec.ts` (§15.2 の新設)。PR の CI は流さない (origin/main の `.github/workflows/e2e-local.yml` は spec を名指しで並べ、`e2e.yml` の PR の実行は MVP スイートだけ)。`playwright.config.ts` の `testDir` は `./tests/e2e` で、手動の `full_suite` (`npx playwright test`) からは外れないので、spec の冒頭で `process.env.E2E_STRIPE_TEST_MODE !== '1'` なら `test.skip` する (Stripe のテストモードで動かすときだけ付ける。`auth-turnstile.spec.ts` の、前提が無ければ全部スキップする形と同じ)。ログインは共通の `authedPage` (`tests/e2e/fixtures/auth.ts`) を使い、パスワードのログインやアカウントの値を spec に書かない (§16.1 の `e2e-test-session`・`no-committed-credentials` の行)

---

## 15. 段分け・触るファイルの母集合・新設一覧

### 15.1 段分け (1 つの B 型 WF の中で段ごとに 2 枚レビュー。段 A は単独でマージしてよい)

| 段 | 内容 | ファイル | テスト |
|---|---|---|---|
| A: DB 層 | migration + rollback (家族のトリガー・特権列ガードを含む)、`database.types.ts` の再生成 (2 本)、SQL 文面の契約テスト、結合テスト、本人の書き出しの `omit` と `billing_customers` の除外 (新しい列と表が migration と同時に見張りに当たるため)、`ai-usage-rpc.test.ts` と `plan-deprecate-subscribers.test.ts` の家族の作り方 (作成のトリガーで、INSERT で入れた家族プランが `free` に置き換わるため) | §6・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・`src/lib/account-export-tables.ts`・`tests/integration/rls/ai-usage-rpc.test.ts`・`tests/integration/security/plan-deprecate-subscribers.test.ts` | 44〜49, 52〜70, 75, 80, 84, 85, 87, 88, 91, 92, 98, 99, 102〜106 (+ `account-export-scope` の延長・`ai-usage-rpc` と `plan-deprecate-subscribers` の追随)。どれも段 B の `src/lib/billing/*` を import しない (§14.2 の冒頭) |
| B: サーバ層 | `src/lib/billing/*` (`public-plans.ts` を除く)、`verify.ts`、`env.ts`、`rate-limit.ts`、`.env.example`、`ENV_SETUP.md`、API 7 本、Webhook、退会 (退会の既存テスト 3 本の追随を含む。§16.1)、AI の入口の一覧 `tests/helpers/ai-consent-enforced-paths.ts` の `EXEMPT_ROUTES` に 7 行 (§16.1。新しい route と退会の route が `@/lib/env` に届くため)、凍結中も通す 3 本 (`src/lib/auth/frozen.ts` の一覧と JSDoc・`src/lib/billing/auth.ts`・3 本の route の認証・middleware の見張り `middleware-frozen-allowed-api.test.ts` の追随・`lib/supabase/middleware.ts` のコメント 2 か所。§9.8。一覧の route が実在することを見張りが見るので、route と同じ段) | §8・§9・§11 | 1〜43, 72〜74, 81〜83, 86, 89, 90, 93〜96, 100, 107〜112, 114, 115, 119 (+ `middleware-frozen-allowed-api.test.ts` の追随) |
| C: 画面層 | `/pricing` のデータ駆動化 (`src/lib/billing/public-plans.ts` を含む)、`/account/billing`、`/account/billing/checkout`、設定画面の行、public-claims の更新、手動の E2E の spec (`tests/e2e/.manual/billing-checkout.spec.ts`)、モバイルの料金の画面を消す (`apps/mobile`。§10.4。mobile の jest は `apps/mobile` で `npm test`)、凍結中の解約の画面 `/frozen/billing` と凍結の画面 `/frozen` のリンク (§10.5。`/frozen/account` の画面とテストはコメントだけ) | §10・§14.3 | 50〜51, 76〜79, 97, 101, 113, 116〜118 (+ 手動 71・mobile の `PublicPage.test.tsx` と `route-targets-exist.test.ts` の追随) |

段 B は段 A のマージ後 (型の再生成済み) に始める。段 C は段 B のマージ後。

### 15.2 触るファイルの母集合 (閉じた一覧。これ以外を触ったら blocking。例外は §16.1 冒頭の「母集合の作り方」で新たに出た、同じ型の行がそのまま当てはまるファイルだけ)

新設:
- `supabase/migrations/<番号>_billing_core.sql`・`supabase/rollbacks/<番号>_billing_core.down.sql`
- `src/lib/billing/core.ts`・`stripe-gateway.ts`・`repository.ts`・`service.ts`・`http.ts`・`public-plans.ts`・`account-deletion.ts`・`auth.ts` (§9.8)
- `src/app/api/billing/checkout/route.ts`・`checkout/preview/route.ts`・`checkout/sync/route.ts`・`subscription/route.ts`・`subscription/cancel/route.ts`・`subscription/resume/route.ts`・`portal/route.ts`
- `src/app/api/webhooks/stripe/route.ts`
- `src/app/pricing/PricingPageView.tsx`・`src/app/(main)/account/billing/page.tsx`・`src/app/(main)/account/billing/checkout/page.tsx`・`src/components/billing/checkout-confirmation.tsx`・`src/app/frozen/billing/page.tsx` (§10.5)
- E2E (手動): `tests/e2e/.manual/billing-checkout.spec.ts` (テスト 71。§14.3)
- mobile のテスト: `apps/mobile/__tests__/app/no-web-purchase-links.test.ts` (テスト 101。§10.4)
- テスト: `tests/billing-core.test.ts`・`tests/billing-stripe-gateway.test.ts`・`tests/billing-service.test.ts`・`tests/billing-account-deletion.test.ts`・`tests/api/billing-routes.test.ts`・`tests/webhooks-stripe-route.test.ts`・`tests/billing-migration-contract.test.ts`・`tests/integration/rls/billing-apply-subscription-rpc.test.ts`・`tests/integration/rls/billing-webhook-events-claim-rpc.test.ts`・`tests/integration/security/billing-personal-subscriptions-rls.test.ts`・`src/__tests__/app/account/billing-pages.test.ts`・`src/__tests__/app/settings/billing-link.test.ts`・`tests/billing-public-plans.test.ts` (テスト 97)・`tests/billing-auth.test.ts` (テスト 119)・`src/__tests__/app/frozen-billing-page.test.tsx` (テスト 116・117)

変更:
- `src/lib/webhook/verify.ts`・`src/__tests__/lib/webhook/verify.test.ts`
- `src/lib/env.ts`・`.env.example`・`ENV_SETUP.md` (§16.2 の行。origin/main に在る)
- `src/lib/rate-limit.ts`・`src/__tests__/lib/rate-limit.test.ts` (テスト 74)
- `src/lib/account-deletion.ts`・`tests/account-deletion.test.ts`・`tests/account-deletion-email.test.ts`・`src/__tests__/api/account/delete-missing-env.test.ts` (§16.1 の退会の行。`tests/account-delete-route.test.ts` は変えない)
- `src/__tests__/api/null-character-routes.test.ts` (`ENTRIES` 2 行と `EXCLUDED` 1 行。§16.1)
- `src/app/pricing/page.tsx`・`tests/public-claims-guard.test.ts`
- `src/app/(main)/settings/page.tsx` (行を 1 つ足す。テスト 79)
- `src/lib/auth/frozen.ts` (定数 3 つ・`FROZEN_ALLOWED_API_PATHS` の 3 行・JSDoc の段落。§9.8)・`lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts` (§16.1 の行)・`lib/supabase/middleware.ts` (コメント 2 か所だけ: `:193` と `:218-219` の「退会と個人データの書き出し (の API) だけ」を「凍結中も呼べる API (`FROZEN_ALLOWED_API_PATHS`。退会・書き出しと、有料プランの解約の 3 本。billing/01 §9.8)」に。コードは変えない) (段 B)
- 同意のゲート (#1442。`cross/13a` §6.4) の許可リスト `packages/shared/src/legal-consent-api.ts` の `LEGAL_CONSENT_EXEMPT_API_PATHS` に 3 行 (§9.8 の 3 本・`leave_service`) と、それを固定する `lib/supabase/__tests__/middleware-legal-consent-api.test.ts` のスナップショット・`packages/shared/src/legal-consent-api.test.ts` の例・`lib/supabase/__tests__/middleware-push-token-claim-exemption.test.ts` (#1636。凍結中に通る route の一覧) (段 B。§16.3 の `cross/13a` の行の「後の方が相手の行を取り込む」)
- `src/app/frozen/page.tsx` (リンク 1 つ・定数 `FROZEN_BILLING_PATH`・説明の文 1 つ・冒頭の JSDoc 1 行。§10.5)・`src/__tests__/app/frozen-account-page.test.tsx` (テスト 118 と、冒頭のコメント `:10` の「凍結中でも止めない 2 つの API (FROZEN_ALLOWED_API_PATHS) 以外を呼ばない」を「凍結中でも止めない API (FROZEN_ALLOWED_API_PATHS) のうち退会と書き出しの 2 つ以外を呼ばない」に)・`src/app/frozen/account/page.tsx` (冒頭の JSDoc `:8` の「凍結中でも止めない 2 つ (…) だけ」を「凍結中でも止めない API (…) のうち退会と書き出しの 2 つだけ」にするコメントだけ。画面は変えない) (段 C)
- `src/types/database.types.ts`・`packages/shared/src/database.types.ts` (再生成)
- `tests/integration/security/auth-users-fk-on-delete.test.ts` (D の `EXPECTED_ACTIONS` に 1 行)
- `tests/integration/rls/ai-usage-rpc.test.ts` (`createFamily` の家族のプランの入れ方だけ。§16.1)
- `tests/integration/security/plan-deprecate-subscribers.test.ts` (`addFamily` の家族のプランの入れ方だけ。§16.1)
- `tests/helpers/ai-consent-enforced-paths.ts` (`EXEMPT_ROUTES` に 7 行を足すだけ。§16.1。`tests/ai-consent-enforcement.test.ts` と `tests/ai-usage-contract.test.ts` は変えない)
- `src/lib/account-export-tables.ts` (`personal_subscriptions` の `omit` に `stripe_status`・`stripe_synced_at` を足すことと、`ACCOUNT_EXPORT_EXCLUDED` に `billing_customers` (理由つき) を足すことの 2 つだけ。§7.1)・`tests/account-export-tables.test.ts` (テスト 75・85)・`tests/integration/security/account-export-scope.test.ts` (「出力しない列」の一覧に 2 列を足す。§14.2)
- `apps/mobile/app/index.tsx` (入口の画面の「料金」のリンクの 1 行を外す)・`apps/mobile/__tests__/components/PublicPage.test.tsx` (画面の一覧から `pricing.tsx`・例のパスを `/about` に)・`apps/mobile/__tests__/app/route-targets-exist.test.ts` (`removedScreens` に `pricing`)・`apps/mobile/env.example` (コメントの 1 行) (§10.4。段 C)
- docs: `docs/design/billing/01-billing-core.md` (本書。設計ゲート PASS 後は実装中の小修正のみ)。他の文書 (他の設計書・リポジトリの根の `CLAUDE.md`) は §16.2 の行だけ (専権 PATCH)

削除:
- `apps/mobile/app/(public)/pricing.tsx` (アプリの料金の画面。§10.4。段 C)

触らない (本冊の段の外。§17.3 の前提・§18 の 14): `src/app/legal/page.tsx` (特定商取引法に基づく表記の「販売価格」ほか 5 行)・`src/app/faq/page.tsx` と `src/app/page.tsx` の FAQ・それを見張る `tests/public-claims-guard.test.ts` の describe `#1155 特定商取引法ページ (/legal)` と `#1155 FAQ (/faq とトップページの FAQ)` の it (同じファイルの料金のページの部分は §16.1 のとおり直す) と `tests/e2e/b10-unexplored-areas.spec.ts` の 4-1 / 4-3。本冊の段の後に #1911 (#1916) が、販売の 5 行を項目ごと取り除き、FAQ の「有料プランは準備中です（販売開始前）」を取り除いて、見張りのテストを「準備中」「販売開始前」が無いことの検査に改めた。販売の内容の項目は有料プランの販売 (#1912) が足す

触らない (凍結。上の一覧の外なので、触ったら blocking。理由は §6.5):
- `supabase/baseline/**` (`prod_schema.sql`・`prod_function_acl.sql`・`prod_table_acl.sql`・`catalog/*.csv`・`manifest.json`・`refresh-request.txt` ほか)。本番のスナップショットで、本冊の migration の前の本番の状態 (`personal_subscriptions_insert` / `_update`・旧 `guard_user_profiles_privileged(_on_insert)`) を持ったままでよい

### 15.3 新設一覧 (識別子)

| 種別 | 名前 |
|---|---|
| テーブル | `public.billing_customers` |
| 列 | `personal_subscriptions.stripe_synced_at` / `.stripe_status` / `.cancel_at_period_end` / `.billing_interval`、`stripe_webhook_events.processing_started_at` / `.attempt_count` |
| 制約 | `personal_subscriptions_billing_interval_check`、`personal_subscriptions_status_check` (置き換え: `incomplete` を追加) |
| トリガー | `personal_subscriptions_set_updated_at`、`billing_customers_set_updated_at`、`family_groups_billing_plan_follow_representative` (`family_groups` の BEFORE INSERT OR UPDATE OF `representative_id`。§6.4 (10)) |
| RLS ポリシー | `personal_subscriptions_insert_admin`、`personal_subscriptions_update_admin`、`billing_customers_no_access` (削除: `personal_subscriptions_insert`、`personal_subscriptions_update`) |
| DB 関数 | `billing_claim_stripe_event(text, text, jsonb, interval)` (戻り値 `claimed` / `completed` / `in_progress`)、`billing_finish_stripe_event(text, boolean, text)`、`billing_apply_stripe_subscription(jsonb, timestamptz, text)`、トリガー関数 `billing_family_plan_follow_representative()` |
| 既存の関数の置き換え | `guard_user_profiles_privileged()`・`guard_user_profiles_privileged_on_insert()` (`20261008200700` の定義に `plan_key_cached` を 1 行ずつ足す) |
| 列コメントの置き換え | `user_profiles.plan_key_cached` (同期元を写像に)、`stripe_webhook_events.payload` (新規。最小化した写しであること。§6.3) |
| status の値 | `incomplete` |
| 監査 action_type | §8.1 `BILLING_AUDIT_ACTIONS` の 9 つ (`system.billing.orphan_subscription_cancelled` を含む)。`target_type` の値 `stripe_subscription` |
| route | `POST /api/billing/checkout`、`GET /api/billing/checkout/preview`、`POST /api/billing/checkout/sync`、`GET /api/billing/subscription`、`POST /api/billing/subscription/cancel`、`POST /api/billing/subscription/resume`、`POST /api/billing/portal`、`POST /api/webhooks/stripe` |
| ページ | `/account/billing`、`/account/billing/checkout`、`/frozen/billing` (凍結中の解約とお支払い。§10.5) |
| TS モジュール | `src/lib/billing/{core,stripe-gateway,repository,service,http,public-plans,account-deletion,auth}.ts`、`src/app/pricing/PricingPageView.tsx`、`src/components/billing/checkout-confirmation.tsx`、`src/app/frozen/billing/page.tsx` |
| TS の export (core) | §8.1 の `export` のとおり (数は §8.1 が正。ここに写して二重に数えない) |
| TS の export (verify) | `parseStripeSignatureHeader`、`verifyStripeSignature`、`verifyStripeWebhook`、`StripeSignatureHeader` |
| ポートのメソッド (§8.1。数は §8.1 が正) | `StripeGateway` の `listOpenCheckoutSessions`・`expireCheckoutSession` (退会で開いた Checkout を閉じる。§11) ほか、`BillingRepository` の各メソッド |
| 写像の戻り値の項目 | `user_deleted` のときの `customer_closed` (§6.4 (9)・§8.1 `ApplySubscriptionResult`) |
| 設計ゲートの検査の道具 (実装しない) | §8.0 の `design-module-check` (js。ブロックの 1 行目の印 `place=` / `append=` / `insert=` を読む) |
| TS の export (ほか) | `createStripeGateway`、`createBillingRepository`、`BillingRpcError`、`BillingReadDeps`、`BillingDeps`、`CheckoutPreview`、`previewCheckout`、`startCheckout`、`syncSubscription`、`syncCheckoutSession`、`getBillingSummary`、`createPortalSession`、`scheduleCancellation`、`revokeCancellation`、`handleStripeEvent`、`recordStripeEventFailure`、`StripeEventOutcome`、`billingInvalidInputResponse`、`billingErrorResponse`、`listPurchasablePlans`、`collectSubscriptionsToCancel`、`expireOpenCheckoutSessions`、`defaultAccountDeletionBilling`、`AccountDeletionBilling`、`AccountDeletionBillingLogger`、`AccountDeletionBillingPhase`、`AccountDeletionBillingReport` (この 4 つは `src/lib/account-deletion.ts`)、`requireUserAllowingFrozen`・`BillingRouteUser` (`src/lib/billing/auth.ts`。§9.8)、`BILLING_SUBSCRIPTION_API_PATH`・`BILLING_CANCEL_API_PATH`・`BILLING_PORTAL_API_PATH` (`src/lib/auth/frozen.ts`。§9.8) |
| 環境変数 | `STRIPE_WEBHOOK_SECRET` (一覧に追加。削除: `.env.example` の `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) |
| レート制限 | カテゴリ `billing` |
| 凍結中も通す API の一覧 | `FROZEN_ALLOWED_API_PATHS` (`src/lib/auth/frozen.ts`) に 3 行 (`/api/billing/subscription`・`/api/billing/subscription/cancel`・`/api/billing/portal`。§9.8) |
| 退会の段階 | `billing` (`prepare` の前)・`billing_recheck` (`delete_user` の直前) |
| Webhook の応答 | 409 `{ error: 'event_in_progress' }` (§9.6 の 6'・§13.2) |
| 本人のデータの書き出しの除外 | `ACCOUNT_EXPORT_EXCLUDED.billing_customers` |
| 消す画面 (アプリ) | `apps/mobile/app/(public)/pricing.tsx` と入口の画面の「料金」のリンク (§10.4) |
| AI の入口の一覧 (テストの道具) | `EXEMPT_ROUTES` の 7 行 (§16.1。`src/app/api/billing/{checkout,checkout/sync,portal,subscription/cancel,subscription/resume}/route.ts`・`src/app/api/webhooks/stripe/route.ts`・`src/app/api/account/delete/route.ts`) |
| エラーコード | §13.1 の [NEW] 8 つ |
| 画面の定数 | `CHECKOUT_SYNC_RETRY_MS = 3000`、`CHECKOUT_SYNC_MAX_RETRIES = 10` (`/account/billing` の page に置く。根拠: Webhook の到着は通常 1〜5 秒、30 秒で諦めて「時間をおいて再読み込み」を出す)、`FROZEN_BILLING_PATH = "/frozen/billing"` (`src/app/frozen/page.tsx`。§10.5) |

---

## 16. 追随表

### 16.1 既存の番兵 (契約テスト・走査テスト) の追随

grep の語 = 本冊が足す・変える名前。段 = §15.1。

**母集合の作り方** (この表の行は次の 6 つの問い合わせの結果から作った。実装の各段の最初に同じ問い合わせを origin/main で流し直す。表に無いファイルが出たら、それは本冊の漏れで、この表の同じ型の行の「直し方」がそのまま当てはまるときに限り直してよい (§15.2 の閉じた一覧の唯一の例外。deviations にファイル名と当てはめた行を書く)。当てはまらないときは直さずに報告する):

1. 本冊が足す import の先が既存の走査テストの印に当たるか: AI の入口の棚卸し (`tests/helpers/ai-reach.ts` の `reachesAi`) を、新設・変更する route とページに当てる (§2.2 F24。印に届くのは `@/lib/env` を import するものだけ = `stripe-gateway.ts`・`verify.ts` を import する route と、`account-deletion.ts` を通る退会の route)。
2. トリガーを足す表への書き込みの全数: `git grep -n -A3 -E "from\(['\"]family_groups['\"]\)" origin/main -- tests src supabase scripts | grep -E "insert\(|upsert\("` と `git grep -n -i "insert into (public\.)?family_groups" origin/main` と `git grep -n create_family_group origin/main -- tests`。`plan_key` に `free` 以外を入れるものだけが行になる (§2.2 F23)。
3. RLS を変える表への書き込みの全数: `git grep -n "personal_subscriptions" origin/main -- tests src` のうち `insert(` / `update(` / `upsert(` の client が service_role でないもの (0 件。下の行)。
4. 本冊が変える既存の関数・型 (`AccountDeletionStep`・`deleteAccount`・`SERVER_ENV_VARS`・`RateLimitCategory`・特権列ガード・凍結中も通す API の一覧 `FROZEN_ALLOWED_API_PATHS` / `isFrozenAllowedApiPath` と同じファイルの定数 (§9.8)) と、本冊が同期元を変える列 `plan_key_cached` (§6.4 (9)・(11)) を名指しするテスト: `git grep -n <名前> origin/main -- tests src/__tests__ lib/supabase/__tests__`。凍結の画面は `git grep -n -E "['\"]/frozen" origin/main -- src tests lib apps` も流す (§10.5)。
5. 本冊が振る舞いを変える公開の面 (URL `/pricing`・`/account/billing`・`/account/billing/checkout`、`/pricing` の表示の文「有料プランは準備中です（販売開始前）」) を名指しするコードとテストを、Web だけでなくアプリ・共有のパッケージまで全域で: `git grep -n -E "['\"]/pricing['\"]|/pricing\b|/account/billing|有料プランは準備中" origin/main -- src apps packages tests ':!**/node_modules/**'`。出たファイルごとに「本冊のあとも正しいか」を決めて表に載せる (直す・変更なし・本冊の段の外 (§15.2 の「触らない」) のどれか)。
6. 本冊が触る表の列の一覧を持つ偽の client (存在しない列を select したら失敗を返す test double): `git grep -n -E "SCHEMA_COLUMNS|KNOWN_COLUMNS|ALLOWED_COLUMNS" origin/main -- tests src` (origin/main で 1 本 = `src/__tests__/app/transfer-accept-fake-client.ts`)。本冊が列を足す表 (`personal_subscriptions`・`stripe_webhook_events`) と新設の `billing_customers` を一覧に持つものが行になる。それ以外は「変更なし」の行。

| 番兵 | 反応する理由 (grep の語) | 直し方 | 段 |
|---|---|---|---|
| `tests/env-source-scan.test.ts` | `STRIPE_WEBHOOK_SECRET` を `getOptionalEnv` で読む (一覧に無い名前は型で通らない)・`.env.example` との突き合わせ | `SERVER_ENV_VARS` に足す (§8.7)。`.env.example` の行はそのまま。`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` の行を消す。同じファイルの `ENV_SETUP.md` の検査 (「必須の環境変数」の節が `required: true` とちょうど一致・「機能ごとに要る環境変数」の節の番号が 1 から飛ばない) は、`STRIPE_WEBHOOK_SECRET` を任意 (`required: false`) にし、§16.2 の `ENV_SETUP.md` の項目を `4.` で足せば緑のまま | B |
| `tests/check-env-script.test.ts` | 一覧の読み込み | 変更なし (一覧の追加で緑) | B |
| `tests/database-types-migrations-contract.test.ts` | `billing_customers`・`billing_claim_stripe_event`・`billing_finish_stripe_event`・`billing_apply_stripe_subscription` | 両方の `database.types.ts` を再生成する (冒頭の手順。270k / 256 で) | A |
| `supabase/baseline/**` (`catalog/catalog_policies.csv` の `personal_subscriptions_insert` / `_update`・`catalog/catalog_functions.csv` と `prod_function_acl.sql` の `guard_user_profiles_privileged(_on_insert)`・`prod_schema.sql` の課金の表) と、それを読む `tests/helpers/schema-snapshot.ts` (ベースライン + `ledger_max_version` より新しい migration で表の列を組む)・`scripts/supabase-local.sh` (同じ組み立てで DB を起動)・`.github/workflows/e2e-local.yml` (paths に `supabase/baseline/**` と `supabase/migrations/**`) | 本冊が消すポリシー・置き換える関数・足す列と表の名前 | 変更なし (凍結。§6.5)。ベースラインは書き換えず、本冊の migration がその上に積まれて新しい列・表・ポリシー・関数の定義になる。段 A の各テストはこの組み立ての DB / スキーマで緑になることを見る。本番に適用した後のベースラインの取り直し (`README.md` の手順) は本冊の段に入れない | A |
| `tests/schema-checked-supabase.test.ts` / `tests/schema-checked-db.test.ts` | `.from('billing_customers')` | 型の再生成で緑 | A → B |
| `tests/api-raw-error-message-scan.test.ts` | `src/app/api/billing/**`・`src/app/api/webhooks/stripe` の本文 | 固定の文だけ (`billingErrorResponse`)。`err.message` を本文に入れない | B |
| `tests/lib-raw-error-message-scan.test.ts` | `src/lib/billing/*` の戻り値の `{ error: … }` | 結果のオブジェクトにエラーの `.message` を入れない (`StripeApiError.rawMessage` はログ専用) | B |
| `tests/api-internal-error-routes-stage2.test.ts` | 新 route は対象外 | 変更なし | B |
| `tests/role-check-source-scan.test.ts` | `src/app/api/billing/**` の handler | `requireUser` (凍結中も通す 3 本は `requireUserAllowingFrozen`。§9.8・テスト 115) だけを使う。`roles` の手書き判定を書かない (このテストは `roles` の手書きの判定と組織・サポートの route だけを見るので、変更なしで緑) | B |
| `lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts` (#1445。`FROZEN_ALLOWED_API_PATHS` を `toEqual` で固定・完全一致・凍結中に通すパスと 403 のままのパス・一覧の route の実在) | `FROZEN_ALLOWED_API_PATHS` に 3 行を足す (§9.8) | (1) 冒頭のコメントに「billing/01 §9.8: 有料プランの解約の予約と、その前提の 2 つ (契約の要約・Billing Portal) も止めない」を足す。(2) it「退会と書き出しの 2 つだけ (…)」の名前を「退会・書き出しと、有料プランの解約の 3 本 (契約の要約・解約の予約・Billing Portal) の 5 つだけ (足すときは、本人がサービスから離れるための操作かを確かめてから、このテストも直す)」にし、期待値を `['/api/account/delete', '/api/account/export', '/api/billing/subscription', '/api/billing/subscription/cancel', '/api/billing/portal']` に、`BILLING_SUBSCRIPTION_API_PATH`・`BILLING_CANCEL_API_PATH`・`BILLING_PORTAL_API_PATH` の値も `toBe` で見る。(3) 完全一致の it に、真になる 3 つと、偽になる `/api/billing`・`/api/billing/subscription/`・`/api/billing/subscription/resume`・`/api/billing/subscription/cancel/`・`/api/billing/checkout`・`/api/billing/checkout/sync`・`/api/billing/checkout/preview`・`/api/billing/portal/` を足す。(4) 凍結中に通す 2 つの `it.each` (Cookie と Bearer) に `['GET', '/api/billing/subscription']`・`['POST', '/api/billing/subscription/cancel']`・`['POST', '/api/billing/portal']` を足す。(5) 403 のままの `it.each` に `/api/billing/subscription/resume`・`/api/billing/checkout`・`/api/billing/checkout/sync`・`/api/billing/checkout/preview` を足す。「一覧のパスには、実際の route がある」は変えない (段 B で route ができるので緑) | B |
| `src/__tests__/app/frozen-account-page.test.tsx` (`/frozen` のリンク・`/frozen/account` が `FROZEN_ALLOWED_API_PATHS` 以外を呼ばない) | `/frozen` にリンクを足す・一覧が 5 本になる | テスト 118 を足す。冒頭のコメント `:10` を直す (§15.2)。ほかの it は変えない (`/frozen/account` は課金の API を呼ばない。「以外を呼ばない」は `toContain` で見るので一覧が増えても緑。モックの `next/navigation` は `useRouter` だけで、`/frozen` は `useSearchParams` を使わないまま) | C |
| `src/__tests__/app/frozen-page-logout.test.tsx` (`/frozen` のログアウトの順番) | `/frozen` の画面 | 変更なし (ボタン「ログアウト」を文で探す。リンクが 1 つ増えても変わらない) | — |
| `tests/integration/security/frozen-account-self-service.test.ts` (#1445。凍結中の `/api` を本物の認証で) | 凍結中の `/api` | 変更なし (403 を見るのは `/api/pantry`・`/api/export/meals`。課金の 3 本を呼ばない) | — |
| `lib/supabase/__tests__/middleware.test.ts:285`・`middleware-legal-consent.test.ts:236,363,375`・`tests/legal-consent-gate.test.ts:62,103` (`/frozen` の画面と前方一致) | `/frozen/billing` を足す | 変更なし (`/frozen/billing` は `/frozen` の前方一致で、凍結の差し戻しと同意のゲートの対象外のまま。§10.5) | — |
| `tests/account-deletion-blocked-message.test.ts`・`src/lib/account-self-service.ts` (`ACCOUNT_DELETE_API_PATH` / `ACCOUNT_EXPORT_API_PATH` を import) | `src/lib/auth/frozen.ts` に定数を足す | 変更なし (2 つの定数の値と一覧の先頭 2 行は変えない) | — |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient` の import | `repository.ts` は `getSupabaseAdmin` だけ。`@supabase/supabase-js` を import しない | B |
| `tests/next15-async-request-api-scan.test.ts` | `createClient()`・`cookies()`・route の `params` | `await` を付ける。`pricing/page.tsx` は `await cookies()` | B・C |
| `tests/site-config-guard.test.ts` | `success_url` / `return_url` | `getSiteUrl()` から作る (ドメインを書かない) | B |
| `tests/email-send-throttle-contract.test.ts` | `@/lib/emails/send` | 核はメールを送らないので反応しない | — |
| `tests/public-claims-guard.test.ts` | `src/app/pricing/page.tsx` の描画・「準備中」。page.tsx は async の Server Component になり、いまの `renderToStaticMarkup(createElement(Page))` では描けない | (1) `PUBLIC_PAGES` の料金の行を `{ file: 'src/app/pricing/PricingPageView.tsx', Page: () => createElement(PricingPageView, { plans: [], isNativeApp: false }) }` にする (見える文は `PricingPageView` に移るので、ソースの走査もこのファイル)。`#1151 料金ページ (/pricing)` の describe の `text` も同じ 0 件の描画、`source` は `PricingPageView.tsx` (3 つの it の期待値は変えない。1 つ目の it はソースに `billingPeriod` が無いことを見るが、§10.1 は間隔の切替を置かないので緑のまま)。(2) page.tsx そのものはテスト 50・51 で見る: ファイルの先頭で `vi.mock('@/lib/billing/public-plans', …)` (`listPurchasablePlans` を it ごとに、0 件 / 買える間隔の無い 1 件 (テスト 50) / 年額の Price のあるプランと無いプランの 2 件 (テスト 51)) と `vi.mock('next/headers', …)` (`cookies` は `{ get: (name) => … }` を resolve する Promise を返す async 関数。`is_native_app` の値を it ごとに変える) をして、`renderToStaticMarkup(await PricingPage())` で描く。モックの価格は `FORBIDDEN` に無い値にする (値はテスト 51 の注のとおり)。(3) `FORBIDDEN` (`¥980`・`980円` ほか) は**変えない** (価格は DB の値でソースに無い。`/legal`・FAQ の見張りは販売開始の PR まで要る。「依頼で名指しされた文字列…をすべて検査している」の it も `¥980` を要る)。describe `#1155 特定商取引法ページ (/legal)`・`#1155 FAQ (/faq とトップページの FAQ)` の it は変えない (§15.2 の「触らない」) | C |
| `tests/e2e/b10-unexplored-areas.spec.ts` (本冊の時点は 4-1: `/pricing` に「有料プランは準備中です（販売開始前）」が出て `¥980`・`年払い` が出ない / 4-3: `/legal` の同じ文。#1911 (#1916) で、4-1 は「現在は無料でご利用いただけます。」が出て「準備中」「販売開始前」が無いこと、4-3 は販売の項目 (「販売価格」「支払方法」) と「準備中」「販売開始前」が無いことに改めた) | `/pricing` のデータ駆動化 | 本冊の段では変更なし (ローカルの DB の `subscription_plans` は `stripe_price_id` が全部 NULL (migration `20251126124224` の INSERT) なので 0 件 = 有料プランのカードは出ない。`/legal` は変えない)。本番に向ける手動の `full_suite` (`e2e.yml`) では、販売開始 (§17.3 の Price の登録) のあと 4-1 が赤になる (0 件のときだけの段落が消える) ので、4-1 / 4-3 は §17.3 の前提の、販売の内容を足す PR (#1912) で直す | — |
| `src/lib/maintenance-mode.ts`・`src/__tests__/lib/maintenance-mode.test.ts` (`/pricing` はメンテナンス中は止める側) | `/pricing` の作り直し・新しい route (`/api/billing/*`・`/api/webhooks/stripe`) | 変更なし (`/pricing` はメンテナンス中は止めたまま。新しい route も止める側で、Webhook は Stripe が再送する。§9.6) | — |
| `src/app/contact/page.tsx:308` (「料金プランについて」→ `/pricing`)・`src/components/marketing/landing-copy.ts` のフッターの `料金プラン` → `/pricing` (トップの紹介ページのフッター。#1867 でトップの画面の本体を `src/components/marketing/` に作り直した。`docs/design/marketing/01-landing-site.md` §4.20)・`tests/legal-consent-gate.test.ts:89` (ゲートの対象のパスの一覧に `/pricing`)・`tests/e2e/.exploration/auth-explore.spec.ts:510`・`nutrition-badges-misc-explore.spec.ts:534` (未ログインで `/pricing` が開ける) | `/pricing` | 変更なし (`/pricing` は同じパスで未ログインでも開ける公開のページのまま。ゲートの対象外にもしない。WebView で開いたときの購入導線は Cookie で描かない。§10.4) | — |
| `apps/mobile/__tests__/components/PublicPage.test.tsx` (「画面を拾えている」が `(public)` の画面を `about` / `pricing` / `privacy` / `terms` の 4 つと期待・各画面が `webPath="/…"` を渡す・例のパス `/pricing`)・`apps/mobile/__tests__/app/route-targets-exist.test.ts` (行き先の実在・`removedScreens`) | 料金の画面 `app/(public)/pricing.tsx` を消し、入口の画面のリンクを外す (§10.4) | §10.4 の箇条のとおり (一覧から `pricing.tsx` を外す・例のパスを `/about` に・`removedScreens` に `pricing`) | C |
| `tests/design-doc-removed-mobile-screens.test.ts` (#1659。`docs/design/` の `.md` が、#1673 と #1598 の続きで消したモバイルの画面 `REMOVED_MOBILE_SCREENS` を名指しする行は、同じ行に「削除」か「消した」を書く) | 本冊は `docs/design/` に置かれて走査される。段 C が `app/(public)/pricing.tsx` を消す | 変更なし。本冊は一覧の画面のどれも名指ししない (origin/main `56189b63` で同じ正規表現を本冊に当てて 0 行。#1598 の続きで一覧が 60 画面になった後も 0 行)。一覧は #1673 と #1598 の続きで消した画面の一覧で、段 C の料金の画面は足さない (消したことと入口のリンクが無いことはテスト 101 と `route-targets-exist.test.ts` の `removedScreens` が見る。足す場合は本冊で `app/(public)/pricing.tsx` を名指しする行のすべてに同じ行で「削除」を書く必要がある。§18 の 19) | C |
| `tests/account-deletion.test.ts`・`tests/account-deletion-email.test.ts` (`deleteAccount` を偽の `admin` で直接呼ぶ) | `AccountDeletionStep` に `billing`・`billing_recheck`・`DeleteAccountParams.billing` | 偽の `billing` を渡す (既定の `defaultAccountDeletionBilling` は `createBillingRepository()` → `getSupabaseAdmin()` を呼び、単体テストでは環境変数が無く段階 `billing` で 500 になるので、既存のテストには `{ cancelForAccountDeletion: async () => ({ cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' }) }` を渡す。`account-deletion-email` は `run()` の `deleteAccount` の引数に足す)。順序の期待に `billing` (`prepare` の前) と `billing_recheck` (`deleteUser` の前) を足す | B |
| `src/__tests__/api/account/delete-missing-env.test.ts` (route を本物の `deleteAccount` ごと動かし、`getSupabaseAdmin` も本物。`@supabase/supabase-js` の `createClient` を差し替え、成功の it で `mockCreateAdminClient` が 1 回だけ呼ばれることを見る) | 既定の `defaultAccountDeletionBilling` が `createBillingRepository()` で 2 つ目の service_role のクライアントを作り (`getSupabaseAdmin` は呼ぶたびに作る。`lib/supabase/server.ts:19`)、`findCustomer` の `.maybeSingle()` が偽のクエリ (`emptyQuery`) に無いので段階 `billing` の 500 になる | `vi.mock('@/lib/billing/account-deletion', …)` で `defaultAccountDeletionBilling` を `{ cancelForAccountDeletion: vi.fn(async () => ({ cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' })) }` に差し替える (route は `billing` を渡さないので、差し替えはモジュールの単位)。`mockCreateAdminClient` の 1 回の期待は変えない。成功の it に「差し替えた `cancelForAccountDeletion` が `USER_ID` で 2 回 (`phase` が `billing`、`billing_recheck` の順) 呼ばれた」を足す | B |
| `tests/account-delete-route.test.ts` | `@/lib/account-deletion` を読み込む | 変更なし (`deleteAccount` をモックし、route は `billing` を渡さないので `toHaveBeenCalledWith({ userId, admin, requestId })` は同じ。読み込みだけでは Stripe も DB も呼ばない) | — |
| `src/__tests__/api/null-character-routes.test.ts` (本文を読む handler は `ENTRIES` か `EXCLUDED` にちょうど 1 回載る・`ENTRIES` の handler は最初の 2 行が `rejectNullCharacterBody`。`BODY_READ_PATTERN` = `request.json()` / `.text()` / `.formData()` / `readJsonBody(`) | 新しい `billing/checkout/route.ts` の POST・`billing/checkout/sync/route.ts` の POST (`request.json()`)・`webhooks/stripe/route.ts` の POST (`request.text()`)。既存の `account/delete` の行は `deleteAccount` に届く前 (NULL 文字の 400 か、偽の `createClient` が投げる認証) で止まるので変わらない | `ENTRIES` に `billing/checkout/route.ts` と `billing/checkout/sync/route.ts` の POST を足す (§9 の骨格の 2 行)。`EXCLUDED` に `'POST webhooks/stripe/route.ts': '本文は Stripe が署名して送るもので、利用者は書けない。大きさの上限と署名の確認より前に本文を JSON として読まない作り (billing/01 §9.6)'` を足す (既存の `webhooks/resend` と同じ理由)。`cancel`・`resume`・`portal` は本文を読まないので載せない | B |
| `tests/integration/security/account-deletion.test.ts` (本物の `deleteAccount` をローカルの Supabase で) | 既定の `defaultAccountDeletionBilling` が動く | 変更なし (結合テストの環境には `NEXT_PUBLIC_SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY` があり、利用者に `billing_customers` の行も Stripe の契約の行も無いので `findCustomer` / `listStripeBackedSubscriptions` が空で、段階 `billing` と `billing_recheck` のどちらも `{ cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' }` を返し、Stripe を呼ばない。段 A の migration 適用後に流す) | — |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` | `billing_customers_user_id_fkey` (SET NULL) | 検査 D の `EXPECTED_ACTIONS` (SET NULL の一覧) に 1 行 | A |
| `tests/account-export-tables.test.ts` / `src/lib/account-export-tables.ts` | `personal_subscriptions` は `omit` 方式 (全列を取って `omit` を消す)。`loadSchemaModel` が migration から列を読むので、段 A の migration で `stripe_status`・`stripe_synced_at` が `SENSITIVE_NAME` (`stripe_`) の見張り「出力する列に、秘密・他人を指す列が残っていない」に当たる | `omit` に `stripe_status`・`stripe_synced_at` を足す (同じ段 A の PR)。`cancel_at_period_end`・`billing_interval` は書き出す (本人の契約の内容)。テスト 75 を足す。`STORED_FAILURE_COLUMN` の見張りには当たらない (どの新しい列も名前が `error` / `failure` / `result` でない) | A |
| `tests/account-export-tables.test.ts:275` (「分類されていない表が無い」)・`:321` (「除外リストの表は、実際にユーザー識別列を持つ」)・`:311` (「表がスキーマに実在する」) / `src/lib/account-export-tables.ts` の `ACCOUNT_EXPORT_EXCLUDED` | 新設の `billing_customers` が `user_id` (auth.users 参照) を持つので、`requiredTables` が分類を求める | `ACCOUNT_EXPORT_EXCLUDED` に `billing_customers: 'Stripe の顧客 ID (cus_) と利用者の対応表 (決済の内部の識別子。本人が読める RLS ポリシーが無く、service_role だけが読み書きする)'` を足す (同じ段 A の PR)。`:311` と `:321` は、表が migration にあり `user_id` を持つので緑のまま。テスト 85 を足す | A |
| `tests/integration/security/legal-documents-acceptance.test.ts:555-583` (ガード関数 2 本に保護列が全部入っている) | `guard_user_profiles_privileged` / `_on_insert` の置き換え (§6.4 (11)) | 変更なし (14 列を `toContain` で見るので、`plan_key_cached` を足しても緑)。`plan_key_cached` の見張りはテスト 88 | A |
| `tests/integration/rls/user-profiles-insert-guard.test.ts`・`tests/integration/security/family-member-status-guard.test.ts`・`invite-accept-missing-profile.test.ts` | 特権列ガードの挙動 | 変更なし (どれも `plan_key_cached` を入れない。値を変えない送り直しはガードを通る) | — |
| `tests/integration/security/family-lock-order-race.test.ts`・`membership-transfer-accept.test.ts`・`family-child-promotion-consent.test.ts`・`family-invite-create.test.ts`・`family-member-limit-race.test.ts`・`membership-daily-cap.test.ts`・`invite-email-throttle.test.ts`・`family-promote-legacy-overload.test.ts`・`invite-accept-missing-profile.test.ts`・`family-member-status-guard.test.ts`・`family-accept-display-name.test.ts` (#1584)・`tests/integration/rls/user-profiles-insert-guard.test.ts` (`create_family_group` を `p_plan_key: 'free'` で呼ぶ・代表者の交代を本物の RPC で流す。origin/main (`c100ca9d`) の `git grep create_family_group -- tests` で `ai-usage-rpc.test.ts` (別の行) を除く 12 本がこれで全部) | `family_groups` の BEFORE INSERT / UPDATE OF `representative_id` に新しいトリガー・写像の `family_groups` → `user_profiles` の順 | 変更なし (どれも家族プランの契約を作らず `'free'` で作るので、トリガーの結果は `free` で同じ。`member_limit` は INSERT では触らず、`family-lock-order-race` が後から service_role で入れる上限もそのまま。トリガーが新しい代表者の advisory `billing-user:<uuid>` を取るが、family の関数は billing の鍵をほかに取らないので、family の関数どうしの待ちの順 (`family_groups` → `family_members` ほか) は変わらず、新しい待ちは同じ新しい代表者への作成・交代の直列化だけ。写像は家族の関数と同じ `family_groups` → `user_profiles` の順でロックする (§7.1・テスト 106) ので、#1310 の順を崩さない) | — |
| `tests/integration/rls/ai-usage-rpc.test.ts:152-160,400` (`createFamily(user, 'family_basic')` で `p_plan_key` に家族プランを入れ、`get_effective_plan` が `family_basic` を返すことを見る) | 作成のトリガーが `p_plan_key` を `free` に置き換える (F23 の穴を閉じる) | `createFamily` を「`create_family_group` を `p_plan_key` なしで呼び、`planKey` が `free` でなければ service_role で `family_groups.plan_key` を UPDATE する」に直す (service_role の直接の UPDATE は `plan_key` を変えてもトリガーに当たらない。§6.4 (10))。期待値は変えない | A |
| `tests/integration/security/anon-definer-execute.test.ts` (A1: 許可リストに無い SECURITY DEFINER 関数に anon の EXECUTE が無い) | 新しい SECURITY DEFINER 関数 4 本 (RPC 3 本 + トリガー関数) | 変更なし (どれも `REVOKE ALL … FROM PUBLIC, anon, authenticated`) | — |
| `tests/rls-canonical-coupon-experiment-recipe-flags.test.ts` | 対象 3 表のみ | 変更なし | — |
| `tests/integration-ci-coverage.test.ts` | 新しい結合テストのパス | `tests/integration/rls/` と `tests/integration/security/` に置く (ワークフローの指定に当たる) | A |
| `tests/e2e-api-paths.test.ts` | e2e spec が叩くパス | 新しい spec を `SPEC_FILES` に足さない限り反応しない | — |
| `tests/e2e-test-session.test.ts` (「テストの道具が、パスワードのログインを呼ばない」。`tests/e2e` の下のコードを `.auth` / `.output` / `.report` 以外すべて走査する) | 新しい `tests/e2e/.manual/billing-checkout.spec.ts` | `authedPage` を使い、`signInWithPassword` / `grant_type=password` を書かない (§14.3) | C |
| `tests/no-committed-credentials.test.ts` (git で管理するファイルに、特定のアカウントの資格情報が無い) | 新しい spec | テストカードの番号 (Stripe の公開のテスト用の値) のほかに、アカウントのメールアドレス・パスワードを書かない (§14.3) | C |
| `src/__tests__/app/transfer-accept-fake-client.ts:15-30` (`SCHEMA_COLUMNS`。`family_groups` の列 `plan_key`・`member_limit` を含む一覧で、譲渡の承諾ページ (家族 / 組織) の単体テスト `src/__tests__/app/family/transfer-accept-page.test.ts`・`src/__tests__/app/org/transfer-accept-page.test.ts` が使う) | `family_groups` (トリガーを足す表。上の問い合わせ 6) | 変更なし (本冊は `family_groups` の列を足さない・消さない。トリガーは `plan_key` / `member_limit` の値を決めるだけで、偽の client はトリガーに届かない。`personal_subscriptions`・`stripe_webhook_events`・`billing_customers` は一覧に無い) | — |
| `src/__tests__/api/family/groups.test.ts` (`POST /api/family/groups` の単体。RPC は偽の結果) | `create_family_group` が `p_name` だけで呼ばれ、本文の `plan_key` を読まないことを見る (billing/02 の段 D・#1820) | 本冊では変更なし (DB のトリガーは単体テストに届かない。§16.2) | — |
| `tests/cron-secret-contract.test.ts` | `/api/cron/*` | 核に cron は無い | — |
| `tests/edge-function-dep-pinning.test.ts` | `supabase/functions` | Edge Function を足さない | — |
| `tests/zod-single-copy-1444.test.ts` | 依存 | 依存を足さない (`stripe` を入れない) | — |
| `tests/admin-view-audit-1326.test.ts` | admin / super-admin の route の `admin_audit_logs` 直接 INSERT。請求書の詳細 (`/api/admin/finance/invoices/[id]`) の偽の `personal_subscriptions` (`{ user_id, plan_key }`) | `/api/billing/*` は対象外。`repository.recordAudit` は `src/lib`。請求書の詳細の route は変えない (§7.1) | — |
| `src/__tests__/lib/webhook/verify.test.ts` | `verifyStripeSignature` 等 | 17〜20 を足す | B |
| `src/__tests__/lib/feature-flags.test.ts` / `src/__tests__/api/feature-flags.test.ts` | `plan_key_cached` | 意味は変えない (空 = free)。変更なし | — |
| `tests/ai-chat-flag-edge.test.ts:154-169`・`tests/super-admin-flags-route.test.ts:9,159,220-225,313`・`src/__tests__/lib/super-admin/flag-active-users.test.ts:20,29` | `plan_key_cached` (機能フラグのプランの条件。空 = free) | 変更なし (どれも偽の DB の `user_profiles` の行に値を置いて読むだけで、DB の同期元 (写像) にも特権列ガードにも触れない。列の意味と型は変えない) | — |
| `tests/integration/rls/ai-usage-rpc.test.ts`・`ai-daily-limit-rpc.test.ts`・`coupon-apply-rpc.test.ts`・`tests/integration/security/plan-deprecate-subscribers.test.ts`・`account-export-scope.test.ts`・`tests/integration/operator/super-admin-plans-id.test.ts` | `personal_subscriptions` への INSERT/UPDATE | どれも service_role (`srAdmin` / `supabaseAdmin`) で書いているので RLS の変更に当たらない (`ai-usage-rpc.test.ts` と `plan-deprecate-subscribers.test.ts` は、家族のグループの作り方だけを別の行 (上の `ai-usage-rpc` の行と、下の `plan-deprecate-subscribers` の行) で直す。作成のトリガーに当たるため) (origin/main で確認: `account-export-scope.test.ts:205` の `insert()` は `:67-68` の `srAdmin.from(table).insert(row)`)。`account-export-scope.test.ts:505-507` の「出力しない列」の一覧に `stripe_status`・`stripe_synced_at` を足す (§14.2) | A |
| `tests/integration/security/plan-deprecate-subscribers.test.ts:86-93` (`addFamily(planKey, status)` が service_role で `family_groups` に `plan_key: planKey` を付けて直接 INSERT し、F-1 (`:182-192`) が 409 `OP_PLAN_HAS_SUBSCRIBERS` と `counts.family_groups: 1` を期待する。後始末 `:134` は `delete().eq('plan_key', planKey)` で消し、`:139` で利用者を消す (`representative_id` は RESTRICT)) | 作成のトリガー (§6.4 (10)) は INSERT の呼び出し元を問わず、`subscriber` に家族プランの契約が無いので active のグループの `plan_key` を `free` に置き換える。そのままだと F-1 が 0 件で赤、後始末がグループを消せずに利用者の削除も失敗する (`dissolved` のグループはトリガーが触らないので F-2 は変わらない) | `addFamily` を「INSERT (`.select('id').single()` で id を受ける) のあと、service_role で `family_groups.plan_key` を `planKey` に UPDATE する」に直す (`ai-usage-rpc` の `createFamily` と同じ形。UPDATE OF `plan_key` はトリガーに当たらない)。コメントに「billing/01 §6.4 (10): active なグループの INSERT はトリガーが代表者の契約から plan_key を決めるので、プランの付いたグループは INSERT のあと service_role の UPDATE で作る」と書く。期待値・後始末は変えない | A |
| service_role で `family_groups` に `plan_key` を入れずに直接 INSERT する結合テスト: `tests/integration/rls/family-member-names-scope.test.ts:125-130`・`family-rls-recursion.test.ts:101-106`・`hidden-content-visibility.test.ts:162`・`meals-meal-type-trigger.test.ts:565`・`membership-audit-select.test.ts:155`・`paste-meal-errors.test.ts:148`・`paste-meal-sandbox.test.ts:150`・`tests/integration/security/anon-definer-execute.test.ts:362`・`invite-rpc-token.test.ts:109`・`account-deletion.test.ts:266,733` (SQL の `insert into public.family_groups`) | 作成のトリガー (§6.4 (10)) | 変更なし (`plan_key` は既定の `free` で、代表者に家族プランの契約も無いので、トリガーの結果も `free` で同じ。`member_limit` は INSERT で触らない) | — |
| `tests/ai-consent-enforcement.test.ts:164-167` (「AI へ送るコードに届く route は、すべて判定を呼ぶか、理由つきで除外されている」)・`:175-184` (「載せたファイルが実在し、届く」)・`:192-201` (「route 以外のファイルは届かない」)・`tests/ai-usage-contract.test.ts:185-187` (「公開ハンドラの全数 = 一覧の handlers」) / 一覧 `tests/helpers/ai-consent-enforced-paths.ts` の `EXEMPT_ROUTES` | `@/lib/env` (AI の印に届く。§2.2 F24) を import する `stripe-gateway.ts`・`verify.ts` に届く route: 新設の POST の 5 本 (`checkout`・`checkout/sync`・`portal`・`subscription/cancel`・`subscription/resume`)・`webhooks/stripe`・既存の `account/delete` (`account-deletion.ts` → `billing/account-deletion.ts` → `stripe-gateway.ts` → `env.ts`。§11) の 7 本 | `EXEMPT_ROUTES` の末尾 (既存の `webhooks/resend` の後) に下の 7 行を逐語で足す (段 B。退会の行も段 B の `account-deletion.ts` の変更と同じ PR)。**GET の 2 本 (`checkout/preview`・`subscription`) は載せない** (`stripe-gateway` を import しないので届かない。載せると `:175-184` が「届かない。一覧から外すこと」で赤。§9)。ページ (`/pricing`・`/account/billing`・`/account/billing/checkout`・設定画面・`/frozen/billing`) は `stripe-gateway` / `service` / `@/lib/env` を import しないので `:192-201` は緑のまま (`/pricing` が読む `public-plans.ts` は `db-logger` と `supabase/server` だけ。`/frozen/billing` が読むのは `@/lib/billing/core`・`@/lib/auth/frozen`・`@/lib/native-auth-bridge` だけ。§8 の表・§10.5)。GET の `subscription` が import する `@/lib/billing/auth` (§9.8) も `supabase/server` と `auth/errors` だけで、届かない。`ai-consent-enforcement.test.ts`・`ai-usage-contract.test.ts` は変えない (`noAi` のハンドラは記録の検査の対象外)。届き方の裏付けはテスト 94 | B |
| `tests/account-export.test.ts` | 偽の DB の `personal_subscriptions` の行 (新しい列を持たない) と、`omit` の 4 列が出ないこと | 変更なし (`omit` を足しても、偽の行に無い列は結果を変えない) | — |
| `tests/admin-finance-exports-route.test.ts` | `subscriptions` の CSV の見出し 9 列・`created_at` の期間 | 変更なし (route の `select` は明示の 9 列のまま。§7.1) | — |
| `tests/admin-users-email.test.ts`・`tests/admin-pii-view-audit.test.ts` | `/api/admin/users/[id]` の session client の `personal_subscriptions` (偽の結果) | 変更なし (route を変えない。運営ロールの SELECT ポリシーは保つ) | — |
| `tests/plan-subscribers.test.ts`・`tests/helpers/fake-plan-subscribers-db.ts`・`tests/plan-deprecate-subscribers-route.test.ts`・`tests/plan-detail-page-deprecate.test.tsx` | live 5 値で数える・その件数の応答の形 | 変更なし (`incomplete` は数えない。§7.1) | — |
| `tests/price-impact-applies-to.test.ts` | `personal_subscriptions` に触らないことの見張り | 変更なし (route を変えない) | — |
| `tests/log-cleanup-dau-snapshot-contract.test.ts` | `/revenue_snapshots\|stripe\|personal_subscriptions\|…/` の不在を見るのは `20261010150000_schedule_log_cleanup_and_dau_snapshot.sql` の本文だけ。全 migration を走査するのは `cron.schedule` の名前だけ | 変更なし (本冊の migration は別ファイルで、`cron.schedule` を書かない) | — |
| `tests/account-deletion-migration-contract.test.ts` | #1175 の migration だけを見る | 変更なし | — |
| `tests/log-sanitizer.test.ts` | ロガーの配線 | 変更なし (`createLogger` を使う) | — |

`tests/helpers/ai-consent-enforced-paths.ts` の `EXEMPT_ROUTES` に足す 7 行 (逐語。型は既存の `AiRouteEntry`。`handlers` は各ファイルが公開するハンドラの全数 = どれも `POST` だけ):

```ts
// tsc:skip — tests/helpers/ai-consent-enforced-paths.ts の EXEMPT_ROUTES の末尾 ('src/app/api/webhooks/resend/route.ts' の行の後) に足す
  // billing/01 (課金の核)。Stripe の鍵 (STRIPE_SECRET_KEY) と Webhook の署名の秘密を getOptionalEnv で読むため、import を辿ると
  // 環境変数の一覧 (src/lib/env.ts) に届くだけで、送る先は Stripe と DB だけ。利用者のデータを AI へ送らない。
  // Stripe を呼ばない GET の 2 本 (checkout/preview・subscription) は stripe-gateway を import しないので、ここに載せない
  'src/app/api/billing/checkout/route.ts': {
    consent: '有料プランの購入 (Stripe Checkout の作成)。AI へは送らない (env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'Stripe に顧客と Checkout Session を作るだけ。送る先は Stripe' } },
  },
  'src/app/api/billing/checkout/sync/route.ts': {
    consent: '購入の戻り画面からの同期。AI へは送らない (env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'Stripe から Checkout Session と契約を取り直して DB に写すだけ' } },
  },
  'src/app/api/billing/portal/route.ts': {
    consent: 'Stripe の Billing Portal を開く。AI へは送らない (env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'Stripe に Billing Portal の Session を作るだけ' } },
  },
  'src/app/api/billing/subscription/cancel/route.ts': {
    consent: '解約の予約。AI へは送らない (env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'Stripe の契約に期間末の解約を予約し、DB に写すだけ' } },
  },
  'src/app/api/billing/subscription/resume/route.ts': {
    consent: '解約の予約の取り消し。AI へは送らない (env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'Stripe の契約の解約の予約を外し、DB に写すだけ' } },
  },
  'src/app/api/webhooks/stripe/route.ts': {
    consent: 'Stripe からの契約の知らせ。AI へは送らない (署名の秘密と鍵を読む env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'Stripe から契約を取り直して DB に写すだけ。送る先は Stripe' } },
  },
  // #1562 退会。段階 billing (billing/01 §11) が Stripe の鍵を読むため、account-deletion.ts → billing/account-deletion.ts →
  // stripe-gateway.ts を辿って env.ts に届くだけ
  'src/app/api/account/delete/route.ts': {
    consent: '退会。AI へは送らない (退会の段階 billing が Stripe の鍵を読む env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: '退会 (Stripe の契約の解約と顧客の匿名化・本人のデータの削除)。送る先は Stripe と Supabase だけ' } },
  },
```

### 16.2 他の文書への追随 (専権 PATCH。本冊の設計ゲート PASS 後、実装のマージと同じ PR か直後)

**母集合の作り方**: `git grep -c -i -E "stripe|personal_subscriptions|plan_key_cached" origin/main -- docs '*.md' ':!docs/design/billing/**'` で出たファイル (origin/main `61c59321`・2026-10-15 で 44 本) を 1 本ずつ見て、本冊のあとも正しいかを決めた。凍結中も通す API (§9.8) の分は `git grep -l -E "FROZEN_ALLOWED_API_PATHS|isFrozenAllowedApiPath|/frozen/account" origin/main -- docs '*.md' ':!docs/design/billing/**'` (2 本: `cross/08`・`cross/13a`) を同じく見た。どのファイルも下の表のどれかの行に入る (直す行・「変更なし」の行・「対象外」の行)。`docs/design/membership/*` は 0 件。実装の段 B の最初に同じ問い合わせを origin/main で流し直し、表に無いファイルが出たら報告する (他の文書は専権 PATCH なので、レーンは直さない)。

| 文書 | 箇所 | 直し方 | 期日 |
|---|---|---|---|
| `docs/design/cross/04-api-conventions.md` | §4.1 プレフィックス表 | `BILL_` (課金の自己サービス) 400/403/404/409/422 の行を足す | 段 B と同じ PR |
| 同 | §4.2 エラーコード一覧 | §13.1 の [NEW] 8 つ (`BILL_INVALID_INPUT` / `BILL_PLAN_NOT_PURCHASABLE` / `BILL_CUSTOMER_NOT_FOUND` / `BILL_NO_LIVE_SUBSCRIPTION` / `BILL_CANCEL_NOT_SCHEDULED` / `BILL_CHECKOUT_SESSION_MISMATCH` / `EXT_STRIPE_NOT_CONFIGURED` / `EXT_STRIPE_API_FAILED`) | 同上 |
| 同 | §10.1 の注と見本 | 「未実装なのは Stripe の側だけ」を消し、Stripe の形 (`t=`/`v1=`。秘密は文字列のまま鍵。503 = 秘密なし・401 = 不一致) を本冊 §8.3 へのリンクに置き換える。§10.2 の `processed_stripe_events` を `stripe_webhook_events` + `billing_claim_stripe_event` に直し、「2xx は処理済み (`completed`) のときだけ。ほかが処理中なら 409 で再送させる」を足す (本冊 §9.6)。§16 の TODO 行を閉じる | 同上 |
| `docs/design/cross/02-rls-patterns.md` | §6.2 ロックキーの表 | `billing-user:{uuid}` (写像と、`family_groups` の作成・代表者の交代のトリガー)・`stripe-subscription:{sub_id}` の 2 行を足す (「Stripe webhook 二重処理防止 `stripe:event_id`」は claim に置き換えたと注記) | 段 A と同じ PR |
| `docs/design/cross/08-legal-compliance.md` | §3.2 の見本・§9 の `handlePaymentFailed`・§10 | 見本の `/api/v1/webhooks/stripe` → `/api/webhooks/stripe`、`handlePaymentFailed` のメール送信は Stripe の顧客向けメール、`check_grace_period` の pg_cron は配線の冊、§10 は配線 | 段 B と同じ PR |
| 同 | §16.2 手順・§16.3 表「Stripe の顧客・サブスクリプション」・§18・§19 | 段階 `billing` (`prepare` の前。開いた Checkout を閉じ・即時解約・顧客の匿名化) と `billing_recheck` (`deleteUser` の直前に同じ処理をもう一度) を足す。退会のあとに Stripe に生まれた契約は写像の入口が即時解約する (billing/01 §8.6) と書く。表の現行実装を「実装済み (billing/01 §11)」に。§19 の TODO 行「退会時の Stripe …」を閉じる | 段 B と同じ PR |
| 同 (`cross/08`) | §16.2 削除フローの 1. と 2. (:791-797。凍結中の利用者は「退会 (POST /api/account/delete) と書き出し (GET /api/account/export) だけは止めない」) | 「だけは止めない」を「と、有料プランの解約の 3 本 (契約の要約・解約の予約・Billing Portal。billing/01 §9.8) は止めない」に | 段 B と同じ PR |
| `docs/design/cross/13a-legal-consent-api-server.md` (設計中の冊。API の同意のゲート) | §6.2 の表の「許可リスト (凍結)」(:235「`FROZEN_ALLOWED_API_PATHS` 2 本」)・見張りの 4. (:934「2 本を含む」)・T-M14 (:989)・追随表 (:1083「確認のみ (一覧は変えない)」) | 「2 本」を「`FROZEN_ALLOWED_API_PATHS` の全部 (billing/01 §9.8 のあとは 5 本。数を書かずに一覧を参照する)」に。同意の許可リストが一覧を含むので、本冊の 3 本も未同意で通る (解約の予約は新しい版への同意を求めない。§9.8 の注)。13a の許可リストのスナップショット (見張りの 3.) に 3 本が入る | 13a の実装と本冊の段 B のうち、後にマージする方の PR (§16.3) |
| `docs/design/operator/05-stripe-integration.md` | §4 全体・§6.1・§8・§9・§12・§13・§15 | §4 を「受け口の正本は billing/01 §9.6・§4.1。`as any` の見本と失敗イベントの扱いは廃止」に置き換える。§6.1 に `billing_customers` を足す。§8 の reconcile は「写像を呼ぶ」に (§12)。§15 の API 版は本冊 `STRIPE_API_VERSION` を正に | 段 B と同じ PR |
| `docs/design/operator/04-plan-management.md` | §5.1 図・§5.2・§5.3 | 図に `incomplete` と「解約予約 (cancel_at_period_end)」を足す。§5.2 の SetupIntent + 日次ジョブを Checkout の `trial_period_days` に置き換える。§5.3 の「7 日後 cancelled」を「7 日後 grace・30 日後 cancelled」(05 §9 と同じ) に直す。§7 の `OP_TRIAL_ALREADY_USED` は「使わない (試用なしで購入できる)」と注記 | 段 B と同じ PR |
| `docs/design/operator/01-data-model.md` | §3.7 DDL・§3.18・§3.9.1・§4 ER 図 | 新しい列・`incomplete`・ポリシーの置き換え・`billing_customers`・`plan_key_cached` の同期元 (写像)・`stripe_webhook_events.payload` は最小化した写し (氏名・メールアドレス・住所を持たない。本冊 §8.1・§9.6) を書く | 段 A と同じ PR |
| `docs/design/operator/08-cron-batches.md` | §3.1 `stripe_event_stuck_check` の行・§3.2 の課金系の行 | `stripe_event_stuck_check` は再処理のためには不要 (処理済みでないイベントに 2xx を返さず Stripe の再送で取り直す。§9.6) で、残るのは 3 日の再送が尽きたイベントの整合 (reconcile) と一覧だけ、と注記。`grace_period_check` / `stripe_integrity_check` は本冊 §12 の契約で作ると注記 | 02 (手動付与) の段 A と同じ PR (#1797) |
| `docs/design/operator/CLAUDE.md` | 主要シーケンス「Stripe Webhook idempotency」(:46-56)・設計原則「2. Stripe との同期」(:73-76) | 主要シーケンスは claim 方式へ書き換え、`billing/01` へのリンク。:74「DB が source of truth、Stripe が課金実行」を「Stripe-backed な契約の正本は Stripe の Subscription。DB はその写しで、写す入口は `billing_apply_stripe_subscription` だけ (billing/01 §4.1 の 1.)」に、:75 の reconcile は「写像を呼ぶ (配線の冊。billing/01 §12)」に、:76 は「`stripe_webhook_events` の claim (`billing_claim_stripe_event`)」に直す | 段 B と同じ PR |
| `docs/design/CLAUDE.md` | ドメイン構成の表 | `billing/` の行 (課金の核と配線) を足す | 段 A と同じ PR |
| `CLAUDE.md` (リポジトリの根) | 「家族 (family_*) を変える関数のロック順 (DB)」 | 家族の行を書く関数の一覧に、課金の写像 `billing_apply_stripe_subscription` (家族プランの同期は `family_groups` の行 → `user_profiles` の行の順。billing/01 §6.4 (9) の 10.) と、`family_groups` のトリガー `billing_family_plan_follow_representative` (家族の行のあとで advisory `billing-user:<新しい代表者>` を取る。§6.4 (10)) を足し、「課金の写像を変えるときも家族の行を `user_profiles` より先に取る」と 1 行書く。回帰テストに `tests/integration/rls/billing-apply-subscription-rpc.test.ts` のテスト 106 を足す | 段 A と同じ PR |
| `docs/design/family/01-data-model.md` ほか family | `family_groups.plan_key` / `member_limit` の書き手・グループの作成と代表者の交代の節 | 「代表者の個人契約 (`plan_type='family'`) から billing/01 の写像が同期する。グループの作成と代表者の交代では `family_groups` のトリガー `family_groups_billing_plan_follow_representative` が代表者の契約に合わせる (新しい代表者の advisory `billing-user:<uuid>` を取り、写像と直列) (作成で契約が無ければ free。`create_family_group` の `p_plan_key` は効かない。旧代表者の契約は旧代表者のまま)」と注記。live な家族プランの間は交代を止めるかは family の課題 (§18 の 13) | 段 A と同じ PR |
| family の冊 (`POST /api/family/groups`・`src/schemas/membership/family-group.ts`・`src/app/(main)/family/setup/page.tsx`) | `CreateFamilyGroupBodySchema.plan_key`・`create_family_group` の `p_plan_key`・作成の画面のプランの選択欄 (`page.tsx:15,33,95-105`) | 入力と選択欄から外す (DB が使わなくなったため。選択欄は選んでも効かない。F23・S20)。本冊の段では触らない (受けても無害) | 済: billing/02 の段 D (#1820) |
| family の冊 (`docs/design/family/` の人数の上限の節) | `member_limit` が下がったときに、すでに上限を超えているメンバーの扱い (§7.1 の人数の上限の確認の行・§18 の 15) | 本冊は外さない (新しい招待・承諾・子供の追加だけが止まる)。外す・通知するなどを決めるなら family の冊で | 済: billing/02 §16 の 6 で「外さない」に確定し、`family/02` §5.2 の注記は billing/02 の段 D (#1820) で足した |
| `docs/design/mobile/01-architecture.md` | 課金 | §10.4 の規則 (アプリ内に購入導線を出さない) を 1 節足す | 段 C と同じ PR |
| `.env.example` | 84〜89 行 | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=` を消す。`STRIPE_SECRET_KEY` の説明に Checkout / Portal を足す | 段 B |
| `ENV_SETUP.md` | 表「必須 / 任意」の「任意」の行 (課金 `STRIPE_SECRET_KEY`)・節「機能ごとに要る環境変数（`check:env` では任意）」 | 「任意」の行の課金に `STRIPE_WEBHOOK_SECRET` を足す。節に `4. **Stripe (課金) 関連**` を足し、`STRIPE_SECRET_KEY` (Checkout・Billing Portal・退会の解約) と `STRIPE_WEBHOOK_SECRET` (`/api/webhooks/stripe` の署名の確認。無ければ 503) を書き、本冊 §17 の手順を指す (番号は 1〜3 に続けて 4。`tests/env-source-scan.test.ts` が番号の飛びを見る) | 段 B |
| `docs/design/operator/02-api-spec.md` | §9 冒頭の注 (:570-573「課金 (Stripe の Webhook 受信…) は未開始」)・§21 `POST /api/webhooks/stripe` (:1411-1433)・§24 のテスト 1・2 (:1534-1535) と見本 (:1545-1627)・§25 (:1632) | §9 の注を「Webhook の受け口と契約の写しは billing/01 で入った。収益スナップショットなどの集計バッチと、請求書・収益推移・整合チェックの画面の実データ化は配線の冊 (それまで画面は出さない。#1911 (#1916) で、3 画面は 404 にし、売上・経理のクイックリンクからも外した。本冊 §18 の 20)」に直す。§21 の処理フローを「正本は billing/01 §9.6 (署名 → claim → Stripe から取り直し → 写像。冪等は `billing_claim_stripe_event`。処理中は 409・失敗は 500 で Stripe に再送させる)」へのリンクに置き換え、`stripe.webhooks.constructEvent`・INSERT の衝突での早期 return・イベントごとの直接の UPDATE・`trial_will_end` のリマインダーと `charge.dispute.created` の soft-suspend (どちらも配線) を消す。§24 の 1・2 は billing/01 §14 のテストを指す。見本 (`import Stripe from 'stripe'`・`@/lib/operator/stripe-webhook` の `validateStripeSignature`) は SDK を入れない (§5.1 C) ので、`src/lib/webhook/verify.ts` の `verifyStripeWebhook` (§8.3) と `src/__tests__/lib/webhook/verify.test.ts` を指す形に置き換える。§25 の行は「実装は billing/01」に。§1 (:5) の対象の一覧は変更なし (URL は同じ) | 段 B と同じ PR |
| 同 | §22 `POST /api/cron/stripe-reconcile` (:1453-1460。「自動修復禁止」) | 「不一致は写像を呼んで直す (Stripe が正本。billing/01 §12)」に (05 §8 の行と同じ)。時刻・認証は配線の冊が決める | 配線の残りの冊 (`stripe_integrity_check` を作るとき) と同時 |
| `docs/design/operator/03-ui-spec.md` | §13 冒頭の注 (:274-275「課金が未開始で元データが無いため」) | 「請求書・収益推移・整合チェックの元データ (集計バッチ・reconcile) は配線の冊で作るため、それまで」に直す。画面の案内 (`src/components/operator/finance/BillingNotStartedNotice.tsx` の「課金は未開始のため準備中」) は #1911 (#1916) で部品ごと取り除き、3 画面は 404 にした。画面を実データで出すのは配線の冊 (本冊 §18 の 20) | 段 B と同じ PR |
| 同 | §26 `/super-admin/integrations/stripe` の設定フォーム (:564「Publishable Key」) | 行を外す (本冊は公開鍵を使わない: Checkout と Portal はサーバが作った Stripe のページの URL へ移るだけ。`.env.example` の `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` も消す (上の `.env.example` の行))。:566-567 の Webhook の秘密と受け口の URL は本冊と同じ (変更なし) | 段 B と同じ PR |
| `docs/design/operator/07-audit-monitoring.md` | §4 監査対象操作の網羅リスト (§4.5 システム自動操作 :307-316。利用者の操作の節は無い) | 本冊 §8.1 `BILLING_AUDIT_ACTIONS` の 9 つのうち一覧に無い 8 つを足す: 利用者の課金の操作の節を 1 つ足して `user.billing.checkout_started`・`user.billing.cancel_scheduled`・`user.billing.cancel_revoked`、§4.5 に `system.billing.subscription_created`・`system.billing.subscription_status_changed`・`system.stripe.event_failed`・`system.billing.account_deletion_stripe_cancelled`・`system.billing.orphan_subscription_cancelled` (`system.payment.failed` はすでにある)。`target_type` の値 `stripe_subscription` を書く (§8.1 `BILLING_AUDIT_TARGET_TYPES`) | 段 B と同じ PR |
| `docs/design/operator/09-runbook.md` | §3.2 適用順序の図 (:32 `personal_subscriptions`) | 下に `billing_customers` (billing/01 §6.3) を足す | 段 A と同じ PR |
| 同 | §4 Stripe ↔ DB Reconciliation (:118-159) | §4.1 は配線の冊の reconcile (`stripe_integrity_check`。写像を呼ぶ = 不一致を写して直す。billing/01 §12) に合わせて書き直す (時刻は配線の冊が決める)。§4.2 の Step 3 a) の SQL Editor での `UPDATE personal_subscriptions SET status = …` をやめ、「写像の入口 (`syncSubscription(…, 'wiring:<job>')`) を呼ぶ」に置き換える (直接の UPDATE は `plan_key_cached`・家族のプランの同期と監査を通らない。billing/01 §4.1 の 1.) | 配線の残りの冊 (`stripe_integrity_check` を作るとき) と同時 |
| 同 | §9.1 退会の「まだ無いもの」(:392-393「Stripe の顧客/サブスクリプションの後始末」)・§13 退会のシーケンスの注 (:736「Stripe の後始末は今後追加 (#1447)」) | 段階 `billing` (`prepare` の前) と `billing_recheck` (`deleteUser` の直前) を手順とシーケンスに足し、「まだ無いもの」と注を「Stripe の後始末は billing/01 §11 (開いた Checkout を閉じ・即時解約・顧客の匿名化)」に直す | 段 B と同じ PR |
| 同 | §12.2 影響範囲特定クエリ (:664-672) | 変更なし (`processing_status = 'failed'` と `status = 'past_due'` は本冊でも同じ値。処理中のまま止まった行は配線の冊の一覧で見る。§12) | — |
| `docs/design/cross/06-perf-cache.md` | §4.2 キャッシュ戦略一覧表 (:84 `getUserActivePlan()` の結果・:85 Stripe customer 情報)・§4.3 `CACHE_TTL.STRIPE_CUSTOMER` (:137)・§12 未解決事項 (:562) | :85 と :137 を消す (本冊は Stripe の顧客の情報をキャッシュしない。利用者と顧客の対応は DB の `billing_customers`。§6.3)。:84 と :562 の「プラン変更 webhook 受信時に DEL / 即時 invalidate」には、本冊の Webhook はキャッシュを消さないこと (プランのキャッシュは実装に無い: 権利判定の入口 `getEffectivePlan` は毎回 `get_effective_plan` を呼ぶ。`src/lib/plan/entitlements.ts:370-372`) を注記する | 段 B と同じ PR |
| 同 | §5.1 確定値一覧 (:205 `POST /api/v1/webhooks/stripe`) | `POST /api/webhooks/stripe` に直す (署名の確認だけ・レート制限なしは同じ。billing/01 §9.6)。本冊の `/api/billing/*` の POST (レート制限 `billing`。§8.7・§9) の行を足す | 段 B と同じ PR |
| 同 | §4.4 `getUserActivePlan` の見本 (:146-175。`personal_subscriptions` を `.eq('status', 'active')` で読む)・§9 のシーケンス (:517) | 変更なし (本冊は権利判定を変えない。R5。見本は `get_effective_plan` (個人契約は `trialing / active / grace / past_due`。F10) と本冊の前から食い違うが、本冊で増える `incomplete` はどちらでも権利に入らないので、食い違いは増えない) | — |
| `docs/design/00-architecture.md` | ディレクトリ構成の `src/lib/` (:214 `stripe/ # Stripe SDK ラッパー (新規)`) | `billing/ # 課金の核 (billing/01。core / stripe-gateway / repository / service / http / public-plans / account-deletion。Stripe は REST (fetch + form-encode) で、SDK を入れない)` に置き換える (F1・§5.1 C)。:83・:147・:198 の受け口の URL `/api/webhooks/stripe` は本冊と同じ (変更なし)。:146-149 (組織のライセンス購入) は下の組織の行 | 段 B と同じ PR |
| `docs/design/org/04-license-management.md` | :517「重複請求防止」(`personal_subscriptions.paused_until` をセットし Stripe Subscription を pause・失効時に自動 resume) | 「配線の冊が Stripe の `pause_collection` (請求の一時停止。Stripe の status は `active` のまま) を付けてから DB を `paused` (`paused_until` 必須) にする。外せば写像で `active` に戻る (billing/01 §12 の一時停止の行)」に直す。Stripe の status `paused` (試用が支払い方法なしで終わったとき) は本冊の写像で `expired` に写る別のもの (§4.1 の写像の規則・S19) で、組織ライセンスの一時停止には使えないことを書く | 配線の残りの冊 (組織ライセンス受領による一時停止を作るとき) と同時 |
| 同 | :461-467・:500 (`getUserActivePlan` の見本の `personal_subscriptions` の読み)・:522 のキャッシュ | 変更なし (cross/06 の見本の行と同じ理由) | — |
| `docs/requirements/02-organization-management.md` | :763-764 (一時停止中の個人プランの `paused_until`・Stripe Subscription の resume)・:1809 | org/04 :517 の行と同じ直し方 (`pause_collection` を付け外しする。Stripe の status `paused` は使わない) | 配線の残りの冊 (組織ライセンス受領による一時停止を作るとき) と同時 |
| 同 | ほか (:83・:316・:400・:603・:660 §5.9.2・:1042-1095・:1531・:1727・:1794・:1842) | 変更なし (組織の課金は本冊の範囲外。§1。:400 の個人プランへの移行は下の `migrate-to-personal` の行) | — |
| `docs/requirements/03-operator-admin.md` | §5.15.6 の試用の流れ (:998-999。Setup Intent でカードを登録し、押したときに `trialing` の行を作る)・:1994 | 「Checkout の `trial_period_days` で試用つきの契約を作り、行は写像が作る (Checkout の完了の Webhook と戻り画面の同期)」に直す (operator/04 §5.2 の行と同じ) | 段 B と同じ PR |
| 同 | §7.2.12 `personal_subscriptions` の DDL (:1493-1535) と RLS (:1538-1542) | DDL に本冊 §6.2 の列 (`stripe_synced_at`・`stripe_status`・`cancel_at_period_end`・`billing_interval`) と status `incomplete` を足す。RLS の INSERT / UPDATE から「本人」を外す (admin のポリシーと service_role だけ。§6.2・R14) | 段 A と同じ PR |
| 同 | §9.4.10.3 (:1865「Stripe Publishable Key / Secret Key 設定」) | Publishable Key を外す (operator/03 §26 の行と同じ) | 段 B と同じ PR |
| 同 | §15.1 日次 reconciliation (:2134-2144。「自動修復は禁止」) | 「不一致は写像を呼んで直す (Stripe が正本)」に (05 §8・operator/02 §22 の行と同じ。billing/01 §12)。時刻 (ここの 04:00 JST と operator/02 §22・09 §4.1 の 12:00 JST が食い違う) は配線の冊で決める | 配線の残りの冊 (`stripe_integrity_check` を作るとき) と同時 |
| 同 | ほか (§4.19 クーポンの重複 :508・試用の quota :679・:2312・:1009-1013・運営の個人課金の詳細の画面 :1836-1860・:1866 の受け口の URL・価格変更 :1872-1886・§15.12 手数料 :2314-2322・最終確認画面 :2722・§18.7 グレース :2799) | 変更なし (本冊の仕組みと食い違わない。§18.7 は本冊 §12 と同じ・最終確認画面は §10.2。:2322 の 100% OFF の扱いは、運営が Stripe でプロモーションコード (R7) を作るときの決まりとして残る。本冊は割引率を見ない) | — |
| `docs/requirements/01-family-management.md`・`docs/requirements/100-scenarios.md` | 01 :385・:1207・:1768・:1894、100 の A5・B14・D2・F2・F7・F10・F15・G2 | 変更なし (01 :385 の `/account/billing` は本冊の契約の管理の画面 (§10.3)。:1207 は下の family/08 と同じ RLS の見本。100 の A5・B14 は本冊の Checkout (S1・S3)、D2 は組織の Checkout (`docs/requirements/02` §5.9.2。範囲外。§1)、G2 は claim (§9.6)、F 系は運営 (配線)) | — |
| `docs/design/family/02-api-spec.md` §4.7 (:255-281)・`docs/design/family/07-lifecycle.md` (:397-418)・`docs/design/org/05-offboarding-flow.md` (:55-58・§7.1 :232-239・§7.2 :248-249・見本のテスト :430-433)・`docs/design/org/04-license-management.md` :293 (「個人プランへ移行」の行) | `migrate-to-personal` (凍結した家族グループを個人の家族プランへ移す。`stripe_payment_method_id` を受けて API が Stripe の契約を作る / 決済完了の Webhook で `personal_subscriptions` を INSERT し `family_groups` を UPDATE する) | origin/main に実装は無い (route 0 件)。実装するときは、購入を本冊の Checkout (`POST /api/billing/checkout`。支払い方法は受けない) に寄せ、`personal_subscriptions` の行は写像だけが作り (API・Webhook の処理が直接 INSERT しない)、`family_groups.plan_key` / `member_limit` は写像とトリガーが決める (API が直接 UPDATE しない) と書き換える。凍結の解除 (`status` を `active` に戻す) では写像もトリガーも `plan_key` を合わせない (写像は `status = 'active'` のグループだけを同期し、トリガーは作成と代表者の交代 (`BEFORE INSERT OR UPDATE OF representative_id`) だけで動く。§6.4 (9)・(10)) ので、解除する側でどう合わせるかをその冊で決める (本冊 §18 の 21) | family / org の冊 (`migrate-to-personal` を実装するとき) |
| `docs/design/family/03-ui-spec.md` | グループ作成の画面の「プラン選択」と「Stripe Checkout で支払い手続きへ」(:105-110) | プランの選択と支払いのボタンを外し、「家族プランは代表者が `/pricing` から買う。グループのプランは代表者の契約に合わせて決まる (billing/01 §6.4 (10)・S20)」と書く (上の family の冊の行の画面の選択欄 (`page.tsx`) と同時に) | 済: billing/02 の段 D (#1820) |
| `docs/design/family/08-rls-policies.md` | :50-60 (`family_groups_insert` ポリシーの見本が `personal_subscriptions` の `active` / `trialing` を見る)・:1005-1011 (service_role で `personal_subscriptions` に直接 INSERT する見本のテスト) | 変更なし (そのポリシーは origin/main の migration に無い。グループは `create_family_group` (SECURITY DEFINER) で作る。F23。見本のテストは service_role なので本冊の RLS の変更 (§6.2) に当たらない) | — |
| 組織の課金の文書: `docs/design/org/02-api-spec.md` (§11 課金 :730-・ライセンス購入 :804-・シーケンス :983-991・:1032・:1189)・`docs/design/org/CLAUDE.md` (:37・:48-49・:107)・`docs/design/org/01-data-model.md`・`org/03-ui-spec.md`・`org/09-rls-policies.md` の組織の契約の列とポリシー・`org/04-license-management.md` :233 (Standard → Pro の切り替え)・:531 (`pool_purchased`)・`00-architecture.md` :146-149 | 組織の契約の Stripe Checkout と Webhook | 変更なし (組織の課金は本冊の範囲外。§1)。組織の課金を設計するときに、その冊で次を書く: 受け口は 1 本 (`/api/webhooks/stripe`) で、いまの受け口は届いた契約を利用者の個人の契約として写す (利用者は契約の `metadata.user_id`・`billing_customers`・既存の行から引く。§6.4 (9))。このため組織の契約のイベントは、利用者が引けなければ `BILL_UNKNOWN_USER` で `failed` になり (§13.3)、組織の Checkout が契約に `metadata.user_id` を付けると個人の契約として写る。組織の契約を受け口で見分けて写像に渡さない分岐を足す (§12「イベントの追加」の型)。org/02 :1189 の Price ID と `plan_key` の対応は、個人の契約については本冊の `findPlanKeyByPriceId` (S13) | 組織の課金の冊 |
| `docs/design/cross/07-dr-backup.md` | 鍵の rotate の手順 (:323-327) | Stripe の行に Webhook の署名の秘密 (Dashboard の Webhook の宛先で作り直し、Vercel の `STRIPE_WEBHOOK_SECRET` を入れ替える。本冊 §17.2) を足す。:187 (Credit Note) は変更なし | 段 B と同じ PR |
| `docs/design/cross/09-testing.md` | §11.1 Stripe (:171-173)・:200・:375-376 | :172 の `tests/mocks/stripe.ts` (`vi.fn()` のモック) は作らない、と直す: 本冊のテストは `createStripeGateway(fetchImpl)` に偽の fetch を、service に `StripeGateway` / `BillingRepository` の偽物を渡す (§8.4・§8.6・§14.1)。:173 の E2E は手動 (`tests/e2e/.manual/`。CI では流さない。§14.3) と書き足す。:14 (モック戦略の見出し)・:200 (重複送信は claim のテスト)・:375-376 (環境変数の名前)・:391 (operator/02 §24 への参照) は変更なし | 段 B と同じ PR |
| `docs/design/CLAUDE.md` :99・`docs/design/cross/01-auth-session.md` :8・`cross/03-design-system.md` :357・`operator/06-ai-llm.md` :432・`SECURITY.md` :37・`docs/operations/posthog-dashboard.md` :16 (`plan_key_cached`)・`supabase/functions/README.md` (`stripe-price-sync`) | Stripe・`personal_subscriptions`・`plan_key_cached` の名指し | 変更なし (FK の規則・署名検証の参照先・プラン変更の UI の色・`stripe-price-sync` は本冊が変えない。`plan_key_cached` は同期元が写像になるだけで意味と型は同じ) | — |
| `docs/handover/2026-05-08.md`・`docs/handover/bug-fix-report-2026-04.md`・`docs/bug-fix-report-2026-04.md` | その時点の記録 | 対象外 (過去の記録は直さない) | — |

### 16.3 共有面の台帳 (2 つ以上の PR が触る面。R20)

リポジトリに台帳のファイルは無い (origin/main に `docs/shared-state-surfaces.md` は 0 件)。本冊が触る面のうち、ほかの PR・冊も触るものをここに書く。実装の各段は、マージの直前に origin/main を取り込み、下の「衝突の避け方」をもう一度確かめる。

| 共有面 | 本冊の段 | ほかに触るもの | 衝突の避け方 |
|---|---|---|---|
| `supabase/migrations/` の番号・`supabase/rollbacks/` | A | ほかの migration の PR すべて (`docs/design/CLAUDE.md`「同時編集が起きやすい箇所」の 3.) | 番号はマージの直前に origin/main の最大より大きい番号で決める (§6.1)。`.down.sql` も同じ番号 |
| `src/types/database.types.ts`・`packages/shared/src/database.types.ts` | A | ほかの migration の PR すべて (再生成) | マージの直前の main に本冊の migration を積んで再生成し直す (§16.1 の `database-types-migrations-contract` の行) |
| 既存の関数の置き換え `guard_user_profiles_privileged()`・`guard_user_profiles_privileged_on_insert()` | A | `user_profiles` の特権列を変える PR | origin/main の最新の定義 (いまは `20261008200700_legal_documents_acceptance.sql`) を土台に `plan_key_cached` を 1 行ずつ足す (§6.4 (11))。マージの直前に `git grep -l -E "FUNCTION (public\.)?guard_user_profiles_privileged" origin/main -- supabase/migrations` でそれより新しい定義が無いかを確かめ、あればそれを土台に作り直す |
| `family_groups` のトリガーと、家族の DB 関数のロックの順 | A | family / membership の DB 関数を変える PR | リポジトリの根の `CLAUDE.md` のロックの順 (§16.2 の行) に従う。同じ関数・同じ表のトリガーを触る PR とは直列にマージする |
| `personal_subscriptions` の CHECK・RLS・列 | A | 配線の冊 (grace / paused の直接の UPDATE・手動付与) | 配線の冊は本冊のマージ後に設計し、§12 の契約だけを使う |
| `src/lib/account-export-tables.ts` | A | 表・列を足す PR | `omit` と `ACCOUNT_EXPORT_EXCLUDED` への行の追加だけ (§15.2) |
| `docs/design/cross/04-api-conventions.md` §4.2 エラーコード一覧 | B | エラーコードを足す PR すべて (同 1.) | 本冊は §13.1 に `[NEW]` で置き、cross/04 には専権 PATCH (§16.2) で集める (`docs/design/CLAUDE.md` の「解決方法」) |
| `docs/design/00-architecture.md` | B | — (同 2.。滅多に変えない) | 本冊は :214 の 1 行だけ (§16.2) |
| `src/lib/env.ts` の `SERVER_ENV_VARS`・`.env.example`・`ENV_SETUP.md` の節の番号 | B | 環境変数を足す PR | `ENV_SETUP.md` の節の番号は、マージの直前の main の最後の番号に続ける (`tests/env-source-scan.test.ts` が飛びを見る。§16.1) |
| `src/lib/rate-limit.ts` の `RateLimitCategory`・`CATEGORY_RULES` | B | カテゴリを足す PR | 行の追加だけ (§8.7) |
| `src/lib/account-deletion.ts` の段階 (`AccountDeletionStep`) | B | 退会を変える PR | 段階の並び (§11) は本冊が正。同時に段階を変える PR とは直列にマージする |
| `tests/helpers/ai-consent-enforced-paths.ts` の `EXEMPT_ROUTES`・`src/__tests__/api/null-character-routes.test.ts` | B | route を足す PR すべて | 行の追加だけ (§16.1) |
| `src/lib/auth/frozen.ts` の `FROZEN_ALLOWED_API_PATHS` と、それを固定する `lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts` | B | 凍結中に通す API を変える PR・API の同意のゲート (`cross/13a`。許可リストがこの一覧を含み、スナップショットで固定する) | 行の追加だけ (§9.8)。`cross/13a` の実装と本冊の段 B は直列にマージし、後の方が相手の行を取り込んで両方の見張り (`middleware-frozen-allowed-api.test.ts` の `toEqual` と 13a のスナップショット) を直す (§16.2 の行) |
| 受け口 `/api/webhooks/stripe`・`stripe_webhook_events`・`STRIPE_EVENT_ACTIONS` | B | 配線の冊・組織の課金の冊 | イベントの追加は §12「イベントの追加」の型。組織の契約は §16.2 の組織の行 |
| `src/app/(main)/settings/page.tsx`・`src/app/pricing/page.tsx`・`apps/mobile/app/index.tsx` | C | 画面を変える PR | 行の追加・1 行の削除・`/pricing` の置き換えだけ (§15.2) |

---

## 17. 本番の準備手順 (運用。秘密の値は #1113 のオーナー作業)

順序: §17.1 (Stripe の設定) と §17.2 (鍵・秘密・migration) を済ませてから、最後に §17.3 で Price を登録する。Price の登録 (`subscription_plans.stripe_price_id`) がそのまま `/pricing` の公開の合図なので (§10.1)、鍵より先に登録すると「`/pricing` と確認画面は出ているのに『申し込む』が 503 (お支払いを受け付けていません)」の時間ができる (R12・S11)。

### 17.1 Stripe の Dashboard (Price の登録より前)

1. **Products / Prices**: ここでは作らない。販売開始の合図なので最後に行う (§17.3)。
2. **Webhook のエンドポイント**: `https://<サイトの URL>/api/webhooks/stripe`。API 版は `STRIPE_API_VERSION` (`2024-12-18.acacia`)。イベントは `STRIPE_SUBSCRIBED_EVENT_TYPES` の 12 種だけ。署名の秘密 (`whsec_…`) を `STRIPE_WEBHOOK_SECRET` に入れる (§17.2)。
3. **Customer portal** (Settings → Billing → Customer portal): 支払い方法の更新 ON・請求書の履歴 ON・解約 ON (期間末)・**プランの変更 OFF**・顧客情報の更新 (メール) OFF。
4. **Customer emails** (Settings → Emails): 支払い失敗 ON・試用終了前 ON・領収書 ON (核はアプリのメールを送らない。§5.2)。
5. **Subscriptions → Manage failed payments**: Smart Retries ON。すべての再試行が失敗したあとの扱いは「契約を past_due のままにする (キャンセルしない)」(grace → 30 日の解約は配線のジョブが行う。§12)。
6. **Checkout の設定**: 日本語・JPY。税の自動計算は使わない (表示は税込の固定額)。

### 17.2 Vercel / Supabase

- Vercel の環境変数: `STRIPE_SECRET_KEY` (`sk_live_…`)・`STRIPE_WEBHOOK_SECRET`。入れたあと本番を再デプロイして効かせる。Preview / 開発は `sk_test_…` と test の Webhook (Stripe CLI の `stripe listen --forward-to localhost:3000/api/webhooks/stripe`)。
- migration の適用 (段 A のマージ後。追加だけ = index / 列 / 表 / 関数の新設と RLS の是正)。

### 17.3 販売開始 (最後に行う。Price の登録)

前提 (すべて済んでから):
- §17.1 の 2〜6 と §17.2 (本番に鍵と Webhook の秘密が入り、デプロイ済み・migration 適用済み)。
- 段 A〜C のマージと、モバイルの料金の画面を消した版のアプリの配布 (§10.4。配布済みの古い版の扱いは §18 の 2)。
- 特定商取引法に基づく表記 (`/legal`) に販売の内容の項目 (「販売価格」「支払方法」「支払時期」「サービス提供時期」「解約について」ほか) を足し、`/faq`・トップ (`/`) の FAQ に有料プランの答えを足す PR (有料プランの販売 #1912) のマージ (文面は業務・法務の判断で、本冊の段の外。#1911 (#1916) がこれらの項目と「有料プランは準備中です（販売開始前）」を取り除いたので、いまは項目ごと無い。それを見張る `tests/public-claims-guard.test.ts` の describe `#1155 特定商取引法ページ (/legal)`・`#1155 FAQ (/faq とトップページの FAQ)` の it と、`tests/e2e/b10-unexplored-areas.spec.ts` の 4-1 (`/pricing` の 0 件のときの段落) と 4-3 (`/legal` の販売の項目が無い) も同じ PR で直す。§15.2・§18 の 14)。販売を始めたのに、特定商取引法に基づく表記に販売の項目が無いままにならないようにするため。

手順:
1. `pro`・`family_basic`・`family_pro` の Product を作り、`PATCH /api/super-admin/plans/[id]` で `stripe_product_id` を入れる → `POST /api/super-admin/plans/[id]/price-change` で月額・年額を同期する (既存の機構 F16。Edge Function の secrets にも `STRIPE_SECRET_KEY` が要る)。`subscription_plans.stripe_price_id` が入った時点で `/pricing` に出る (§10.1)。
- あとで鍵を外した (ローテーションの失敗など) 間は、`/pricing` と確認画面は出たまま「申し込む」が 503 (`EXT_STRIPE_NOT_CONFIGURED`・「お支払いを受け付けていません」) になる。gateway の生成で止まるので、Stripe にも DB にも何も作られない (顧客も作らない)。鍵を戻せば解ける。

### 17.4 受け入れの確認 (整合ゲートで読み取り)

- テストカード `4242 4242 4242 4242` で `pro` 月額を買い、`/account/billing` に `trialing` が出る。`personal_subscriptions` に 1 行・`billing_customers` に 1 行・`stripe_webhook_events` に `completed` が 2〜3 行 (どの行の `payload` にも `customer_email` / `customer_name` / `customer_details` / `invoice_pdf` が無い。§9.6)・`admin_audit_logs` に `system.billing.subscription_created` が 1 行。
- 解約の予約 → `cancel_at_period_end=true`。取り消し → `false`。
- `stripe trigger invoice.payment_failed` → `past_due` と `system.payment.failed`。
- 退会 → Stripe の契約が `canceled`、顧客の氏名・メールが空、`billing_customers.anonymized_at` が入り `user_id` が NULL。退会の前に開いておいた Checkout の画面 (別のタブ) は `expired` で完了できない。
- テストモードで、退会のあとに同じ顧客で作った契約 (`stripe` CLI で顧客 `cus_` に契約を作る) → Webhook の取り直しで即時解約され、`admin_audit_logs` に `system.billing.orphan_subscription_cancelled` が 1 行。
- 凍結中の解約 (テストモード。テスト用の利用者で `pro` を買い、`user_profiles.frozen_at` を入れる) → ログインで `/frozen` に回り、「有料プランの解約・お支払い」から `/frozen/billing` →「解約する」で `cancel_at_period_end=true`・監査 `user.billing.cancel_scheduled` が 1 行。同じ利用者の `POST /api/billing/subscription/resume`・`POST /api/billing/checkout` は 403 `AUTH_ACCOUNT_FROZEN`。

---

## 18. 未解決事項 (openQuestions)

| # | 項目 | 本冊の仮置き |
|---|---|---|
| 1 | `/pricing` に出す価格 (DB の `pro` 980 / 9,800 円など) と販売開始の時期は業務判断。Stripe の Price を `subscription_plans` に入れた時点で自動的に公開される | 価格は DB の値をそのまま出す。公開の合図 = `stripe_price_id` の登録。登録は §17.3 の前提 (鍵・秘密・モバイルの版・表記の文面) のあと |
| 2 | App Store / Google Play の規約 (Web 課金への誘導の可否) の最新の文面と審査の判断は未確認。あわせて (a) すでに配布した版のアプリ (料金の画面から Web の `/pricing` を外部のブラウザで開く) が販売開始のあとに手元に残る扱い、(b) アプリが「Web版を開く」で開く購入でないページ (`/about` など) から、サイトの中を辿って `/pricing` に行けることの扱い | アプリ内に購入導線・価格・誘導を出さない (§10.4)。料金の画面は消す。(a) は販売開始の前に料金の画面の無い版を配布する (§17.3。ローンチ前で配布済みの版が無ければ当たらない)。(b) はアプリが直接に開くのは購入のページではないので変えない |
| 3 | 当社の `coupons` を Checkout でも使えるようにするか (Stripe の Coupon / Promotion Code との同期が要る) | Checkout は Stripe のプロモーションコードだけ。`coupons` は運営の遡及適用のまま |
| 4 | ブランドのメール (支払失敗・試用終了) を自前で送るか | Stripe の顧客向けメールに任せる (配線で足せる) |
| 5 | 家族グループを後から作った代表者に、live な家族プランを引き継ぐか (family ドメイン) | 引き継ぐ (作成のトリガー。S20 (a))。作成時の `p_plan_key` は使わない (F23 の穴を閉じるため)。`POST /api/family/groups` の入力 `plan_key` と、作成の画面 (`src/app/(main)/family/setup/page.tsx`) のプランの選択欄は billing/02 の段 D (#1820) で外した (§16.2) |
| 6 | `grace` で制限する有料機能の範囲 (05 §9 は AI 解析・家族共有・産業医) | 核は制限しない (`get_effective_plan` のまま)。配線の冊 |
| 7 | `stripe_webhook_events` の行の保存期間 | 配線の掃除のジョブで決める。`payload` は最小化した写しで氏名・メールアドレス・住所を持たない (§8.1・§9.6) ので、退会の匿名化 (#1562) のために消す必要は無い |
| 8 | Checkout で住所の収集・税の自動計算 (インボイス制度の適格請求書) | 収集しない。請求書番号は配線の冊 |
| 9 | `account-export-scope.test.ts:205` の `insert()` がどの client か (本人なら RLS の変更で落ちる) | 解決済み: origin/main で service_role (`srAdmin`。同ファイル 67-68 行) と確認。替える必要は無い (§16.1) |
| 10 | 同時に 2 本の Checkout が完了したときの 2 本目 (`BILL_LIVE_ROW_CONFLICT`) を運営がどう処理するか | Finance 画面 (配線) に `failed` イベントを出し、運営が Stripe で解約・返金 |
| 11 | Billing Portal での解約の予約 / 取り消し (route を通らない) を `admin_audit_logs` に残すか | 残さない (写像は status の変化だけを監査する。記録は `stripe_webhook_events.payload` の最小化した写し (`cancel_at_period_end` / `cancel_at` を残す) と Stripe の履歴。§7.3)。要るなら写像に「`cancel_at_period_end` が変わったら `system.billing.cancel_changed` を書く」を足す (`BILLING_AUDIT_ACTIONS` が 1 つ増える) |
| 12 | 退会で見つけられない契約: 別の顧客 (`billing_customers` に無い `cus_`) で作られ、写像も失敗して DB に行が無い契約 (Dashboard で手作業した場合だけ) | 解約されない。運営が Finance 画面 (配線) の `failed` イベントから拾って Stripe で解約する |
| 13 | 家族プランを契約中の代表者が代表者を譲ったとき、契約 (支払い) は旧代表者に残り、グループは新しい代表者の契約に従う (無ければ free)。交代を止める・契約を移すなどの業務の扱い (family ドメイン) | 交代は止めない。グループのプランはいまの代表者の契約に従う (S18・§6.4 (10))。旧代表者の契約はそのまま旧代表者の個人の権利になる (解約は本人が `/account/billing` から) |
| 14 | 特定商取引法に基づく表記 (`/legal`) の「販売価格」「支払方法」「支払時期」「サービス提供時期」「解約について」と、`/faq`・トップの FAQ の文面 (#1911 (#1916) で「有料プランは準備中です（販売開始前）」と販売の 5 行を取り除き、いまは項目ごと無い)。販売を始めるときに何と書くか (本冊の仕組みでは、支払方法 = Stripe の Checkout が受け付ける方法 (Dashboard の設定による。`payment_method_types` は指定しない)・支払時期 = 申し込み時 (無料期間のあるプランは無料期間の終わり) と以後の更新日・提供時期 = 決済の完了後すぐ・解約 = `/account/billing` からいつでも、次回更新日の前日まで使え、日割りの返金なし) は業務・法務の判断 | 本冊の段では変えない。販売開始 (§17.3 の Price の登録) の前提として、有料プランの販売 (#1912) の PR で足す (`tests/public-claims-guard.test.ts` の `/legal`・FAQ の describe の it と `b10` の E2E 4-1 / 4-3 も同じ PR) |
| 15 | 家族のグループの人数の上限 (`member_limit`) が下がったとき (`family_pro` 8 の契約の終了・代表者の交代で 4 に) に、すでに上限を超えているメンバーをどうするか (family ドメイン) | 外さない。新しい招待の作成・承諾・子供の追加だけが既存の `MEMBER_LIMIT_EXCEEDED` で止まり、画面は `6/4 人` のように表示する (§7.1)。外す・通知するなどは family の冊 (§16.2) |
| 16 | 契約中のプランを別のプランに移す (例: `pro` → `family_basic`) 業務の扱い | 核では扱わない。Portal のプランの変更は OFF (§17.1 の 3.)・核の API に無い。運営が Stripe の Dashboard で Price を付け替えても、行の `plan_key` は変えない (§7.3)。移すときは解約 (期間末) のあと新しく購入する |
| 17 | 退会のあとに Stripe に生まれた・残った契約 (`syncSubscription` が即時解約する。§8.6・§7.3) の最初の請求の返金と、解約しない場合の扱い | 自動で返金しない (核は返金を扱わない)。試用つきの最初の購入は試用中に解約されるので請求は起きない。試用の無い購入で最初の請求が済んでいれば、運営が監査 `system.billing.orphan_subscription_cancelled` (warn) から拾って Stripe で返金する。`customer_closed` が false の「退会済み」(当社の対応表に無い顧客の契約 = 同じ Stripe のテスト用アカウントを使う別の環境の契約、または運営が metadata の `user_id` を書き間違えた契約) は解約しない (当社の利用者のものと言えないため。運営が Finance 画面 (配線) で拾う) |
| 18 | 退会の段階 `billing_recheck` と `deleteUser` の間の一瞬に完了した契約で、Webhook が `deleteUser` より前に着いて写ったもの (行は CASCADE で消える) | 次に届くイベント (同じ購入で続けて届く `invoice.paid` / `customer.subscription.updated`・試用の終わりの前の `trial_will_end`) の取り直しで `customer_closed` が true になり、即時解約される (§7.3)。間が数百ミリ秒しかないので起きにくい。配線の reconcile (`syncSubscription` を全契約に当てる) が最後の網になる (§12) |
| 19 | 段 C で消す料金の画面 `app/(public)/pricing.tsx` を、#1659 の番兵 `tests/design-doc-removed-mobile-screens.test.ts` の一覧 `REMOVED_MOBILE_SCREENS` (#1673 で消した画面) に足すか | 足さない (§16.1 の行)。消したことはテスト 101 と `route-targets-exist.test.ts` の `removedScreens` が見る。足すなら、本冊で `app/(public)/pricing.tsx` を名指しする行のすべてに同じ行で「削除」を書く (段 C の PR で本冊の追随が要る) |
| 20 | 凍結 (BAN) した利用者の有料の契約の課金を、凍結で自動的に止めるか (Stripe の解約・一時停止・返金) | 止めない (核に凍結を契機にした処理は無い。§12)。凍結中も利用者が `/frozen/billing` から解約を予約できるようにする (§9.8・§10.5)。運営が止めるときは Stripe で解約・返金し、届く `deleted` を写像が写す。業務の細部の判断なので、異議があれば戻す |
| 21 | 凍結中の利用者が Billing Portal の中で解約の予約を取り消せる (Stripe の Portal の機能。核の取り消しの API `POST /api/billing/subscription/resume` は凍結中は 403) | 止めない (Portal は Stripe の画面で、核は Portal の中の操作を選ばない。取り消すと課金が続くのは利用者自身の操作の結果)。止めるなら §17.1 の 3. の Portal の構成を見直す (解約の取り消しは凍結していない利用者にも出なくなる) |

---

## 改定履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-15 | 新設 (設計ゲート R1 の叩き台。4 相: 外形固定 §3 → 構想 §4 → 構造裁定 §5 → 仕上げ §6〜§17) |
| v1.2 | 2026-10-15 | 設計ゲート R2 の指摘を反映: 新しい route と退会の route を AI の入口の一覧 `EXEMPT_ROUTES` に (§16.1・F24)・Webhook のイベントの記録を最小化 (`minimizeStripeEventPayload`。§8.1・§9.6・§11)・Stripe を呼ばない GET の 2 本は gateway を作らない (`BillingReadDeps`。§8.6・§9・S11)・`listPurchasablePlans` は失敗で空を返す (§10.1)・`plan-deprecate-subscribers` の家族の作り方 (§16.1・F23)・§16.1 に母集合の作り方 |
| v1.3 | 2026-10-15 | 網羅性 周 3 を反映: `paused` (Stripe-backed) の解約の予約・取り消し (API と Portal) を §7.3 の行に足して §7.1 と揃える (テスト 31・55)・`supabase/baseline/` は凍結 (§6.5・§15.2・§16.1) |
| v1.4 | 2026-10-15 | 設計ゲート R3 の指摘を反映: 写像は契約の行を `FOR NO KEY UPDATE` でロックしてから読み、配線の直接の UPDATE (grace / paused) を巻き戻さない (§6.4 (9)・§7.3・§12。テスト 98)・`invoice.payment_failed` の監査は写像が stale でも書く (`ApplySubscriptionResult` の stale は `user_id` 必須。§8.1・§8.6・S4。テスト 100)・行の無い契約の最初の写像が終端・非 live なら `cancelled` / `expired` の行を INSERT する遷移を §7.3 に (テスト 99)・退会で匿名化した顧客の metadata の無い契約は `user_deleted` (§6.4 (9) の 1.。テスト 60)・アプリの料金の画面を消す (§10.4。テスト 101)・R12 の `/pricing` は鍵と独立・§17 を「鍵 → Price」の順に (§17.3 に販売開始の前提)・`/pricing` の 1 件以上の描き方と `public-claims-guard` の直し方・§16.1 の母集合の作り方に 5 つ目の問い合わせ (公開の面)・家族のトリガーが新しい代表者の advisory `billing-user` を取り写像と直列に (§6.4 (10)。テスト 102)・メンテナンス中の Webhook (§9.6) |
| v1.5 | 2026-10-15 | 網羅性 周 4 を反映: §7.1 の消費経路に `get_effective_plan` の家族・Edge Function の AI 相談のスイッチ (`plan_key_cached`)・`countPlanSubscribers` の家族の数・family の人数の上限の確認 (DB 関数 3 本の最新の定義) と画面 2 つ・家族の作成の画面のプランの選択欄を足す。§7.3 に「`incomplete` のままの `updated`」と「既存の契約の Price の付け替え」の行を足し、写像の 4. を既存の行の `plan_key` 優先に (行の `plan_key` は作成時に固定)。テスト 103〜105。§18 の 15・16 |
| v1.6 | 2026-10-15 | 設計ゲート R4 の指摘を反映: 写像の 10. を `family_groups` → `user_profiles` の順に並べ替え、家族の関数の LOCK-ORDER (#1310) とそろえる (運営の強制解散・代表者の家族の削除とのデッドロック。§6.4 (9)・§7.1 に家族の関数の行。テスト 106・§16.2 にリポジトリの `CLAUDE.md` の行)・退会のあとに完了した Checkout の契約が残る穴を閉じる (退会の段階 `billing` で開いた Checkout を `expire`、`deleteUser` の直前に `billing_recheck`、写像の `user_deleted` に `customer_closed` を足し `syncSubscription` が終端でない契約を即時解約。監査 `system.billing.orphan_subscription_cancelled`。§3.1 R13・S10・§7.3・§8.1・§8.4・§8.6・§11。テスト 107〜109・60 / 42 / 43 の更新・§18 の 17・18)・正典の TS の型の誤り 3 件 (監査の `details` は JSON の値だけ・`p_error` は成功のとき渡さない・退会の段階のロガーは `AccountDeletionBillingLogger`・verify.ts の `MS_PER_SECOND` は既存を使う)・印 (`place=` / `append=` / `insert=`) の付いたブロックを置き場所に置いてリポジトリ全体を型検査する手順 §8.0 (`origin/main` `c100ca9d` の木で 0 件を確認)・`SubscriptionSnapshot` / `StoredStripeEventPayload` を `type` にして `as unknown as` を消す |
| v1.7 | 2026-10-15 | 網羅性 周 5 を反映: §8.1 `STRIPE_EVENT_ACTIONS` の `customer.subscription.trial_will_end`・`pending_update_applied`・`pending_update_expired`・`invoice.payment_action_required` の行を §7.3 に足し、12 種のイベントはどれも取り直しの合図で遷移は取り直した status で決まることを表の下に書く・`incomplete` のままの行に初回の請求の `payment_action_required` を足す・S1 / S4 のトレース・テスト 110 (§15.1 の段 B) |
| v1.8 | 2026-10-15 | 設計ゲート R5 の指摘を反映: `/pricing` のカードは買える間隔 (`isPurchasable(plan, interval)` が真) ごとに金額と CTA「月額で始める」/「年額で始める」を出し、買えない間隔は金額も CTA も出さない・切替のトグルは置かない (§10.1 の表とカードの全パターン・§7.2・S1 / S3 のトレース・§10.4・テスト 50 / 51・§16.1 の `public-claims-guard` の行)・段 A の結合テストは段 B の `src/lib/billing/*` を import しない (§14.2 の冒頭・§15.1): テスト 103 から要約の検査を外して段 B のテスト 111 (`summarizeSubscription`) に移し、テスト 53 と 1 は status の写像の 8 組をリテラルで持つ (§8.2)・origin/main `56189b63` の新しい番兵 `tests/design-doc-removed-mobile-screens.test.ts` (#1659) を §16.1 に「変更なし」で載せ、料金の画面を一覧に足すかを §18 の 19 に |
| v1.9 | 2026-10-15 | 網羅性 周 6 を反映: §16.2 に母集合の作り方 (`stripe|personal_subscriptions|plan_key_cached` を docs と `*.md` で grep した 44 本を 1 本ずつ判定) と、漏れていた文書の行 (operator/02 §9 の注・§21・§22・§24・§25、operator/03 §13・§26、operator/07 §4、operator/09 §3.2・§4・§9.1・§13・§12.2、cross/06 §4.2・§4.3・§4.4・§5.1・§9・§12、`00-architecture.md` :214 (SDK ラッパー → `billing/`)、org/04 :517 と requirements/02 :763-764 (一時停止は `pause_collection`)、requirements/03 の試用・DDL / RLS・reconcile、family / org の `migrate-to-personal`・family/03・family/08・組織の課金の文書、cross/07・cross/09、変更なしの文書と過去の記録) を足す・operator/CLAUDE.md の行に設計原則「2. Stripe との同期」を足す・R20 の指し先を新設の §16.3 (共有面の台帳。リポジトリに台帳のファイルは無い) に・§16.1 の母集合の問い 4. に `plan_key_cached` を足し、偽の DB で読むだけのテスト 3 本を「変更なし」の行に |
| v1.10 | 2026-10-15 | 設計ゲート R6 の指摘を反映: (1) `/account/billing` の状態の表示文を `status` × `cancel_at_period_end` の表にし (`active` は「ご利用中」・`paused` は「一時停止中」・解約の予約は 2 行目に足す)、`billingStatusLines` / `formatBillingDate` を core に (§8.1・§10.3。テスト 112・113)。(2) 凍結 (BAN) 中の利用者も解約の予約・契約の要約・Billing Portal ができるように、`FROZEN_ALLOWED_API_PATHS` に 3 本を足し、3 本の route は `requireUserAllowingFrozen` で凍結を見ない (§9.8)。凍結中の解約の画面 `/frozen/billing` と `/frozen` のリンク (§10.5)・§7.1〜§7.3 の凍結の行・S21・§12 の凍結と課金の契約・§16 の追随 (テスト 114〜119)。(3) `handleStripeEvent` が `data.object` から使う値に、`invoice.payment_failed` の監査の `details` の請求の `id`・`attempt_count`・`amount_due` を足して §8.2・JSDoc・§5.2・テスト 33 の文をそろえる |
| v1.11 | 2026-10-15 | 網羅性 周 7 (続きの走行の周 1) を反映: §7.3 に新規購入の 2 行 (live (S / M) → 409 `OP_SUBSCRIPTION_ALREADY_ACTIVE`・`incomplete` → 新しい Checkout で別の行) と、解約の予約・取り消しの 409 / 冪等の 3 行 (live な S の行が無い → `BILL_NO_LIVE_SUBSCRIPTION`・予約なしの取り消し → `BILL_CANCEL_NOT_SCHEDULED`・予約済みの 2 回目の予約 → 何もせず 200) を足す (§7.1 の新規購入・解約の列と対にする)・テスト 31 に `BILL_NO_LIVE_SUBSCRIPTION` の場合を足す・§16.1 の母集合の問い合わせに 6. (列の一覧を持つ偽の client) と `transfer-accept-fake-client.ts` の変更なしの行を足す |
| v1.12 | 2026-10-19 | #1911 (#1916) の後の現在形化 (製品の挙動は変えない): 「準備中」の表示を前提にした記述 (F2・R12・S11 とトレース・§7 の状態の表・§10.1 の `PricingPageView` の規則・`listPurchasablePlans` のコメント・`EXT_STRIPE_NOT_CONFIGURED` の文「お支払いを受け付けていません」・テスト 50 の it の名前・§15.2・§16 の E2E の行・§17.3 の前提・§18 の 14・operator/02・03 の追随の行) を、買えるプランが無い間は有料プランのカードを出さず、`/legal` の販売の項目は項目ごと無い今の状態に合わせた |
| v1.1 | 2026-10-15 | 設計ゲート R1 の指摘を反映: 退会の解約を Stripe の顧客の一覧から列挙 (§11)・家族のプランを代表者に従わせるトリガー (作成と交代。§6.4 (10))・`plan_key_cached` を特権列ガードに (§6.4 (11))・Stripe の一時停止 / 再開 / unpaid の遷移 (§7.3)・`billing_customers` を書き出しから除外・処理中のイベントの再送は 409 (§6.4 (7)・§9.6)・`maxDuration` はリテラル (§9.6)・監査の `target_type` (§8.1) |

