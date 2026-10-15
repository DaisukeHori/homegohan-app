# billing/01 課金の核 — Stripe Checkout・Webhook・サブスクリプションの状態

| | |
|---|---|
| 版 | v1.0 (2026-10-15) |
| Status | 設計ゲート審査中 |
| Issue | #1151 (購入の入口)・#1125 (Webhook の受け口) の「核」。配線の冊は `docs/design/billing/02-billing-wiring.md` (未作成) |
| 範囲の正本 | `/Users/horidaisuke/claude-work/scratch/homegohan/specs/spec-d-billing-core.md` |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする |

ローンチまでに作る (オーナーの選択 2026-10-15・選択式)。課金は大きいので分冊する: この冊は「核」= 利用者が有料プランを買い、その状態が DB に正しく反映され、取り消し・失敗・更新が追随するところまで。運用バッチ 20 本 (ライセンス失効・凍結猶予・収益スナップショットなど) と運営の Finance 画面への配線は「配線」の冊で、この冊の後に別に設計する (この冊では、配線の冊が読む表と関数の契約だけを確定させる)。

---

## 0. 分冊判定・範囲・読み方

### 0.1 分冊判定 (相 1 で実施)

| 目安 | 本冊 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (正典コード・表 3 点・トレースを 1 冊に持つため) | 該当 |
| 消費先レーン 3 以上 | API 7 本・画面 3 つ・退会・モバイル = 4 以上 | 該当 |
| 共有面 2 つ以上 | `personal_subscriptions` (family / org / AI 上限が読む)・`user_profiles.plan_key_cached` (機能フラグが読む)・`family_groups.plan_key`・`src/lib/env.ts` の一覧・`cross/04` のエラー表・退会 (`src/lib/account-deletion.ts`) | 該当 |

判定: **設計は 1 冊 (本書) のまま、実装を 3 段 (A: DB 層 / B: サーバ層 / C: 画面層。§15) に分け、段ごとに 2 枚レビューを挟む**。理由: Stripe の状態の写像 (SQL 関数) と、それを呼ぶ Webhook・API (TS) は 1 つの契約 (§8.1 のスナップショット) を挟んで表裏になっており、冊を分けると「未マージの核を参照する配線」の指摘 (2026-09-11 の分冊判定の根拠と同型) を自分で作ることになる。段 A は単独でマージでき (列の追加・RLS の是正・関数の新設だけ。既存の挙動は変えない)、段 B・C はそれぞれ段 A のマージ済みの実コードを参照する。

さらに分ける案 (採らない): 「Webhook の受け口」と「Checkout の入口」を別冊にする案は、どちらも §8.1 の写像関数を呼ぶだけで独自の表を持たないため、分けても行数がほぼ減らない。

### 0.2 本冊の範囲 (核) と、配線の冊に残すもの

| 核 (本冊) | 配線 (02 の冊。本冊は契約 §12 だけを確定) |
|---|---|
| 顧客 (Stripe Customer) の作り方と利用者との対応表 `billing_customers` | 運営の Finance 画面 (`/admin/finance/*`) の実データ化 |
| Checkout Session の作り方 (プラン・月額/年額・試用・クーポン・家族プラン) | 運営者による手動のプラン付与 (`stripe_subscription_id IS NULL` の行) の画面と API |
| 特商法の最終確認画面と、戻り画面 (`/account/billing`) | 支払失敗の 7 日後 `grace`・30 日後の解約の日次ジョブ (`grace_period_check`)・`revenue_snapshot`・`stripe_integrity_check` (reconcile)・`stripe_event_stuck_check` ほか 20 本 |
| Webhook の受け口 (署名・冪等・順序の入れ替わり・再送・失敗の再処理) | ブランドのメール (支払失敗・試用終了の案内)。核では Stripe の顧客向けメール (Dashboard 設定) に任せる (§5.3) |
| サブスクリプションの状態の正本と遷移表 (`billing_apply_stripe_subscription`) | チャージバック (`charge.dispute.created`) の運営対応・自動 BAN なし |
| 権利判定の入口 (= 既存 `get_effective_plan` / `getEffectivePlan`。変えない) と `plan_key_cached`・`family_groups.plan_key` の同期 | `grace` での有料機能の制限 (402) の各入口への配線 |
| Billing Portal (カードの変更・請求書の履歴)・解約の予約と取り消し | 組織ライセンス受領による一時停止 (`paused`) |
| 退会での Stripe の解約と顧客の匿名化 (#1562) | 請求書番号 (`T` + 13 桁)・Stripe Invoice の設定 |
| モバイル (アプリ内課金をしない) の導線の規則 | モバイル画面での契約状態の表示 |
| 本番の準備手順 (§17。秘密の値は #1113 のオーナー作業で入る前提) | |

### 0.3 読み方

- §3 要件行列・§3.2 シナリオ → §4 構想とトレース → §5 構造裁定 → §6 以降が仕上げ (実装者は §6〜§16 だけ読めば手を止めない)。
- 正典の TS は §8 の ```ts ブロック (型検査を通る形。`// tsc:skip` のブロックは説明用で、新設モジュール同士の import を含むため検査から外している)。SQL は §6。
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
| F2 | `src/app/pricing/page.tsx:23-24,114` は有料プランを「準備中」(`PAID_PLAN_PENDING`) と表示。`tests/public-claims-guard.test.ts` が「準備中」の表示を固定 | 同ファイル |
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

---

## 3. 相 1 外形固定

### 3.1 要件行列

| ID | 要件 | 出どころ | 本冊の答え |
|---|---|---|---|
| R1 | 利用者が有料プランを自分で買える | #1151 | `POST /api/billing/checkout` → Stripe Checkout (§9.1) |
| R2 | 決済完了後に `personal_subscriptions` が作られ、以後の更新が追随する | #1151・#1125 | 写像関数 `billing_apply_stripe_subscription` を Webhook と戻り画面の両方から呼ぶ (§4.2・§6.4) |
| R3 | Webhook は署名を確かめ、冪等で、順序の入れ替わりと再送に耐え、失敗したイベントが再処理できる | spec・`cross/04` §10・F19 | 署名 (§8.3)・`billing_claim_stripe_event` (§6.4)・「イベントの中身を信じず Stripe から取り直す + 取り直した時刻で単調に写す」(§4.1) |
| R4 | 状態の正本と遷移表 (trialing / active / past_due / canceled / incomplete など × イベント) | spec | §7.3 (`incomplete` を CHECK に足す) |
| R5 | 権利判定の入口 | spec | 既存 `get_effective_plan` / `getEffectivePlan` を変えない。`plan_key_cached`・`family_groups.plan_key` を写像の中で同期 (§6.4) |
| R6 | 顧客 (Customer) の作り方と利用者との対応 | spec | `billing_customers` (§6.3)。1 利用者 = 1 顧客。顧客は Checkout の前に作る |
| R7 | クーポン | spec | Checkout は Stripe のプロモーションコード (`allow_promotion_codes`)。当社 `coupons` は運営の遡及適用 (`apply_coupon`) のまま、Checkout とは結ばない (§5.3) |
| R8 | 家族プラン | spec | 代表者が買う。写像が代表者の active な家族グループの `plan_key` / `member_limit` を同期 (§6.4) |
| R9 | Billing Portal | spec | `POST /api/billing/portal` (§9.4)。カードの変更・請求書の履歴。プランの切替は Portal で許さない (§17) |
| R10 | 失敗の扱い | spec | Stripe の Smart Retries + 顧客向けメール (Dashboard 設定) + DB `past_due` の写像 + 監査ログ `system.payment.failed`。`grace` 以降は配線 (§12) |
| R11 | モバイル (アプリ内課金をしない) | spec | アプリ内に購入・価格・外部決済への誘導を出さない。WebView で開いた `/pricing` `/account/billing` は購入導線を描かない (§10.4) |
| R12 | 本番の秘密の値 | spec・#1113 | `STRIPE_SECRET_KEY` (既存の一覧) と `STRIPE_WEBHOOK_SECRET` (一覧に足す)。無ければ 503 / 準備中 (§9・§10.1) |
| R13 | 退会で Stripe を即時解約し、顧客を匿名化して残す | spec (#1562) | `deleteAccount` に段階 `billing` を足す (§11) |
| R14 | 利用者本人が契約の行を直接書けない | F6・`docs/design/CLAUDE.md` RLS 厳格化 | INSERT / UPDATE ポリシーから `user_id = auth.uid()` を外す (§6.2) |
| R15 | 特商法の最終確認画面 | `cross/08` §3 | `/account/billing/checkout` (§10.2) |
| R16 | 解約が `/account/billing` から 1 タップ | `cross/08` §3.1 | `POST /api/billing/subscription/cancel` (期間末で解約。取り消し可) (§9.5) |
| R17 | 監査ログ必須 (課金的操作) | `docs/design/CLAUDE.md` | 状態の変化は写像関数が `admin_audit_logs` に書く。利用者の操作は route が service_role で書く (§8.6) |
| R18 | migration の番号はマージ時に確定、`.down.sql` を対で設計 | spec | §6.1 |
| R19 | as any 禁止・マジックナンバー禁止 | spec | §8.1 の定数に根拠。Stripe の型は Zod で自前に定義 (SDK を入れない) |
| R20 | 2 PR 以上が触る共有面の台帳 | `docs/design/CLAUDE.md` | §16.2 |

### 3.2 ユーザーシナリオ (17 本)

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
| S10 | 退会: 契約中の利用者が退会する。Stripe のサブスクリプションは即時解約、顧客は氏名・メールを消して残る。退会後に届く Webhook は何もせず 200 |
| S11 | 秘密が未設定: `STRIPE_SECRET_KEY` が無いと購入 API は 503、`/pricing` は準備中のまま。`STRIPE_WEBHOOK_SECRET` が無いと Webhook は 503 |
| S12 | 二重契約の防止: 契約中 (または手動付与中) の利用者が買おうとすると 409 |
| S13 | 運営が Stripe Dashboard で直接作った契約 (metadata 無し): price から plan_key を解決して写す。解決できなければイベントは `failed` で残り、監査に出る |
| S14 | モバイルの WebView から `/pricing` と `/account/billing` を開く: 購入ボタン・価格・Portal・解約は出ない。契約の状態だけ出る |
| S15 | プロモーションコード: Checkout 画面で Stripe のコードを入れて割引で買う。当社の `coupons` は関係しない |
| S16 | テストモードのイベントが本番に届く: `livemode` が鍵のモードと違うので何もせず 200 |
| S17 | Checkout を途中でやめる: `cancel_url` に戻る。何も作られず、契約は無い |

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
3. **冪等キーは Stripe の `event.id`。** 受け口は `billing_claim_stripe_event` で「自分が処理する権利」を取ってから処理し、完了 / 失敗を記録する。失敗 (または 15 分以上 `processing` のまま) のイベントは再送で再び権利が取れる (= 再処理される)。

**写像の規則 (`stripe_status` → `status`)**: `incomplete → incomplete` / `incomplete_expired → expired` / `trialing → trialing` / `active → active` / `past_due → past_due` / `unpaid → past_due` / `canceled → cancelled` / `paused → expired`。保持の規則が 2 つ: DB が `grace` のとき Stripe が `past_due / unpaid` なら `grace` を保つ (grace は配線のジョブが past_due を段階的に進めたもの)。DB が `paused` (組織ライセンスの一時停止。配線) で Stripe が `active` かつ `pause_collection` 付きなら `paused` を保つ。

### 4.2 シナリオのトレース (上の構造で手で走らせたもの)

記法: `→` は処理の順、`[DB]` は `personal_subscriptions` の該当行、`t` は `fetched_at`。

| ID | トレース |
|---|---|
| S1 | `/pricing` (プランは `stripe_price_id` を持つ public な行だけ描く) → `/account/billing/checkout?plan_key=pro&interval=month` (確認・チェック) → `POST /api/billing/checkout` → `findLiveSubscription` 無し → `hasUsedTrial(pro)` false → trial 7 日 → `billing_customers` 無し → Stripe `POST /customers` (Idempotency-Key `billing-customer:<user_id>`) → `saveCustomer` → Stripe `POST /checkout/sessions` (`subscription_data[trial_period_days]=7`・`metadata[user_id,plan_key,interval]`・`client_reference_id=<user_id>`・`allow_promotion_codes=true`) → 監査 `user.billing.checkout_started` (actor = 本人・`details: {plan_key, interval, trial_days: 7, checkout_session_id}`。§8.6 `startCheckout`) → 200 `{ data: { url, session_id } }` → 画面が `url` へ移動 (§9.1) → 利用者が決済 → Stripe が `customer.subscription.created` (status `trialing`) と `checkout.session.completed` を送る → 受け口: 署名 OK → `claim` = claimed → `retrieveSubscription` (t1) → snapshot → RPC: 利用者 = metadata.user_id → ロック → 既存行無し → plan `pro` → status `trialing` (live) → 他の live 行無し → INSERT (`trial_started_at`・`trial_ends_at`・`stripe_synced_at = t1`・`trial_source='checkout'`) → `plan_key_cached='pro'` → 監査 `system.billing.subscription_created` → `completed`。7 日後: Stripe が請求 → 成功 → `customer.subscription.updated` (`active`) → 取り直し (t2 > t1) → UPDATE `status='active'`・`current_period_*` → 監査 `status_changed trialing→active` |
| S2 | `POST /api/billing/checkout` → `hasUsedTrial(pro)` = `personal_subscriptions` に `user_id` 一致・`plan_key='pro'`・`trial_started_at IS NOT NULL` の行あり (cancelled の履歴) → trial 0 日 → `subscription_data[trial_period_days]` を付けない → 監査 `user.billing.checkout_started` (`trial_days: 0`) → 決済で即時課金 → `created` (`active`) → INSERT `active`。確認画面は「試用はお済みのため、お申し込み後すぐに課金が始まります」を表示 (`trial_days: 0` を事前計算 API `GET /api/billing/checkout/preview` で返す。§9.1) |
| S3 | 同 S1 で `plan_key=family_basic`・`interval=year` → `stripe_yearly_price_id` を使う → `created` (`trialing`) → RPC: `subscription_plans.plan_type='family'` → `UPDATE family_groups SET plan_key='family_basic', member_limit=4 WHERE representative_id=<user> AND status='active'` → `get_effective_plan` は代表者には個人契約の `family_basic`、メンバーには家族の `family_basic` を返す。後に `cancelled` になれば `plan_key='free', member_limit=4` に戻す (この契約の plan_key を持つグループだけ) |
| S4 | 更新日に `invoice.payment_failed` → 受け口: `audit_payment_failed_and_sync` → 監査 `system.payment.failed` (warn, `details: {invoice_id, attempt_count, amount_due}`) → `invoiceSubscriptionId` → 取り直し (`past_due`) → UPDATE `status='past_due'`・`past_due_since=now()` → 監査 `status_changed active→past_due` (warn)。同時に Stripe の顧客向けメール (Dashboard で ON) が利用者に届く。3 日後 Smart Retry 成功 → `invoice.paid` + `customer.subscription.updated` (どちらが先でも) → 取り直し (`active`) → UPDATE `status='active'`・`past_due_since=NULL` |
| S5 | S4 の後 7 日: 配線の `grace_period_check` が `status='past_due' AND past_due_since <= now()-7d` を `grace` (`grace_started_at=now()`) に進める (§12 の契約: 直接 UPDATE。写像は呼ばない)。その後 Stripe の再試行イベントで取り直し → Stripe は `past_due` → 保持の規則で `grace` のまま。30 日目: 配線が Stripe `DELETE /subscriptions/{id}` → Stripe が `customer.subscription.deleted` → 取り直し (`canceled`) → `cancelled`・`cancelled_at = ended_at`・`grace_started_at=NULL`・`past_due_since=NULL` → `plan_key_cached=NULL` → 監査 |
| S6 | `/account/billing` →「解約する」(確認ダイアログ) → `POST /api/billing/subscription/cancel` → live かつ Stripe-backed の行あり → t0 を取る → Stripe `POST /subscriptions/{id}` (`cancel_at_period_end=true`) → 返ってきたオブジェクトを snapshot → RPC (`fetched_at=t0`) → UPDATE `cancel_at_period_end=true`・`cancel_at=current_period_end` (status は `active` のまま。遷移ではないので監査は route が `user.billing.cancel_scheduled` を書く) → 画面「<日付> まで利用できます」。Webhook の `updated` も届くが同じ内容 (t1 > t0 で適用。変化なし)。「解約を取り消す」→ `POST /api/billing/subscription/resume` → `cancel_at_period_end=false` → 同様。取り消さなければ期間末に Stripe が `deleted` → `cancelled`。**Portal から予約 / 取り消しした場合** (§17.1 項 3 で解約 ON): route を通らず、Stripe が `customer.subscription.updated` (`cancel_at_period_end=true` / `false`) を送る → 受け口が取り直して写像 (`webhook:<event.id>`) → UPDATE `cancel_at_period_end`・`cancel_at` (status は同じなので監査は書かない。記録は `stripe_webhook_events.payload` のイベント全体) → 画面は `can_resume` / `can_cancel` で次の操作を出す (§7.3) |
| S7 | Portal でカード更新 → `customer.updated` / `payment_method.attached` が届く → `classifyStripeEvent` = `ignore` → 200 `{received: true, ignored: true}`。契約の行は変わらない |
| S8 | (a) `updated` (active) が `created` より先: 先に届いた方で取り直し → Stripe の最新 (active) → INSERT `active` (t1)。後から `created` → 取り直し → 同じ最新 → t2 > t1 で適用、変化なし (監査なし)。(b) 同じ `event.id` が 2 回: 2 回目は `claim` = duplicate → 200。(c) 処理に失敗 (DB 障害) → `finish(ok=false)` で `failed` → 500 → Stripe が再送 → `claim` が `failed` 行を `processing` に戻して claimed → 再処理。(d) 2 つの Lambda が同時に同じ契約を処理: A が t1 で取り直し、B が t2 > t1 で取り直し、B が先に commit → A の RPC は `stripe_synced_at (t2) >= t1` で `skipped: 'stale'` → 200 |
| S9 | 決済完了 → `success_url` = `/account/billing?checkout=success&session_id=cs_…` → 画面が `POST /api/billing/checkout/sync {session_id}` → Stripe `GET /checkout/sessions/{id}` → `client_reference_id` が本人か確認 → `status='complete'` かつ `subscription` あり → `syncSubscription` (取り直し t0・RPC) → 契約が表示される。数秒後に Webhook が同じ契約を写す (t1 > t0・変化なし) |
| S10 | `POST /api/account/delete` → `deleteAccount`: `check_blockers` → **`billing`**: `billing_customers` あり → 行 (`stripe_subscription_id` あり・status が cancelled / expired 以外) を列挙 → 各 `GET /subscriptions/{id}` → `canceled` でなければ `DELETE /subscriptions/{id}` → `POST /customers/{cus}` (`name=''`, `email=''`, `phone=''`, `description=''`, `address=''`, `shipping=''`, `metadata[user_id]=''`, `metadata[anonymized_at]=<ISO>`) → `billing_customers.anonymized_at=now()` → 以降は既存の段階 (`prepare` → … → `deleteUser`)。`deleteUser` で `personal_subscriptions` は CASCADE で消え、`billing_customers.user_id` は SET NULL。その後に届く `customer.subscription.deleted` → RPC: metadata.user_id は `auth.users` に無い → `skipped: 'user_deleted'` → 200 |
| S11 | `STRIPE_SECRET_KEY` 無し → `StripeGateway` の生成で `StripeNotConfiguredError` → `POST /api/billing/checkout` は 503 `EXT_STRIPE_NOT_CONFIGURED`。`/pricing` はプラン行に `stripe_price_id` が無い限り準備中 (鍵の有無とは独立)。`STRIPE_WEBHOOK_SECRET` 無し → 503 `webhook_not_configured` (Stripe は 2xx 以外を再送するので、設定後に届き直す) |
| S12 | `POST /api/billing/checkout` → `findLiveSubscription` あり (Stripe-backed でも手動でも) → 409 `OP_SUBSCRIPTION_ALREADY_ACTIVE`。同時に 2 本来た場合は両方通り得る (check-then-act)。2 本目の契約の写像は RPC の `BILL_LIVE_ROW_CONFLICT` で失敗し、イベントが `failed` で残る (運営が Stripe で 2 本目を返金・解約する。§13) |
| S13 | Dashboard で作られた契約の `created` → 取り直し → `metadata.plan_key` 無し → `findPlanKeyByPriceId(items[0].price.id)` で `subscription_plans.stripe_price_id / stripe_yearly_price_id` を引く → 当たれば写す。当たらなければ snapshot の `plan_key=null` → RPC `BILL_UNKNOWN_PLAN` → `failed` + 500 (Stripe が再送し続け、3 日で止まる) + 監査 `system.stripe.event_failed` (warn) |
| S14 | WebView (Cookie `is_native_app=1`) で `/pricing` → サーバー側で Cookie を読み `isNativeApp=true` → 有料プランのカードと CTA を描かない。`/account/billing` → 契約の状態 (プラン・次回更新日・解約予約) だけ描き、Portal・解約・購入のボタンは描かない。API 自体は WebView からも呼べる (認可は同じ) |
| S15 | Checkout 画面で Stripe のプロモーションコードを入れる (`allow_promotion_codes=true`) → 割引は Stripe の Subscription に付く → 当社の `coupons` / `coupon_redemptions` には何も書かれない。運営の遡及適用 (`apply_coupon`) は従来どおり `personal_subscriptions.id` 宛てに使える (Stripe には反映されない。05 §6 の「subscriptions.update (discount)」は配線の冊の課題) |
| S16 | `event.livemode=false` が本番 (鍵 `sk_live_`) に届く → 署名は通る (エンドポイントの秘密は同じ) → `livemode` と鍵のモードの不一致 → 200 `{received: true, ignored: true}` + warn ログ。DB には何も書かない |
| S17 | Checkout で「戻る」→ `cancel_url` = `/account/billing?checkout=cancelled` → 画面「お申し込みは完了していません」。Stripe にも DB にも契約は無い (顧客 `cus_` だけ残る。次回の購入で再利用) |

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
- **カスタム API 版のハンドラ**: イベントの payload から読むのは `id / type / created / livemode / data.object.id` と、`invoice` の `subscription` (acacia) か `parent.subscription_details.subscription` (basil) だけ。あとは取り直す。
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

番号はマージ直前に `origin/main` の `supabase/migrations` の最大 (2026-10-15 時点 `20261015110000_paste_meal_reject_missing_source.sql`) より大きい値で確定する。適用後に `src/types/database.types.ts` と `packages/shared/src/database.types.ts` を作り直す (`tests/database-types-migrations-contract.test.ts` の冒頭の手順。段 A)。

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
  '利用者と Stripe Customer (cus_) の対応。service_role だけが読み書きする (RLS は全部拒否)。退会で user_id は NULL になり、anonymized_at が入る';
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
```

### 6.4 DB 関数 (3 本。EXECUTE は service_role だけ)

```sql
-- migration: <番号はマージ時に確定>_billing_core.sql (後半)

-- (7) Webhook の冪等キー (event.id) で処理の権利を取る。
--     戻り値: 'claimed' (この呼び出しが処理する) / 'duplicate' (completed、または他が processing 中で p_stuck_after 以内)。
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
  v_id text;
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
  RETURN CASE WHEN v_id IS NULL THEN 'duplicate' ELSE 'claimed' END;
END
$$;
REVOKE ALL ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) TO service_role;
COMMENT ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) IS
  'billing/01 §6.4: Stripe Webhook の event.id で処理の権利を取る (claimed / duplicate)。failed と古い processing は再処理できる';

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
--     戻り値 (jsonb): { applied: boolean, skipped?: 'stale' | 'user_deleted', subscription_id?: uuid, user_id?: uuid,
--                      status_from?: text, status_to?: text, plan_key?: text }
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
BEGIN
  IF v_sub_id IS NULL OR v_customer_id IS NULL OR v_stripe_status IS NULL OR p_fetched_at IS NULL OR p_source IS NULL THEN
    RAISE EXCEPTION 'billing_apply_stripe_subscription: snapshot / p_fetched_at / p_source are required' USING ERRCODE = '22023';
  END IF;

  -- 1. 利用者の解決: snapshot の user_id (Checkout の metadata) → 顧客の対応表 → 既存の行
  IF v_user_id IS NULL THEN
    SELECT c.user_id INTO v_user_id FROM public.billing_customers AS c WHERE c.stripe_customer_id = v_customer_id;
  END IF;
  IF v_user_id IS NULL THEN
    SELECT s.user_id INTO v_user_id FROM public.personal_subscriptions AS s WHERE s.stripe_subscription_id = v_sub_id;
  END IF;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_USER' USING ERRCODE = 'P0001', DETAIL = v_sub_id;
  END IF;
  -- 退会済み (auth.users に無い) なら何もしない。契約の行は CASCADE で消えている
  IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = v_user_id) THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'user_deleted');
  END IF;

  -- 2. ロック (利用者 → サブスクリプションの順。cross/02 §6.2 の命名)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || v_user_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('stripe-subscription:' || v_sub_id));

  -- 3. 既存の行と鮮度
  SELECT s.* INTO v_existing FROM public.personal_subscriptions AS s WHERE s.stripe_subscription_id = v_sub_id;
  IF v_existing.id IS NOT NULL AND v_existing.stripe_synced_at IS NOT NULL AND v_existing.stripe_synced_at >= p_fetched_at THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'stale', 'subscription_id', v_existing.id, 'user_id', v_user_id);
  END IF;

  -- 4. プラン (snapshot の plan_key → 既存の行の plan_key)
  IF v_plan_key IS NULL AND v_existing.id IS NOT NULL THEN
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

  -- 8. upsert (stripe_subscription_id で 1 行)
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

  -- 10. 個人契約のキャッシュ (live な行が無ければ NULL = free) と、家族プランのグループへの反映
  UPDATE public.user_profiles AS p
     SET plan_key_cached = (
       SELECT s.plan_key FROM public.personal_subscriptions AS s
        WHERE s.user_id = v_user_id AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
        ORDER BY s.created_at DESC, s.id LIMIT 1)
   WHERE p.id = v_user_id;
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
```

### 6.5 migration が触らないもの

`get_effective_plan`・`apply_coupon`・`subscription_plans`・`coupon_redemptions`・`idx_personal_subscriptions_active_per_user` (`incomplete` は述語に入らないので変えない)・`personal_subscriptions_select` / `_no_delete` ポリシー・`stripe_webhook_no_access_rls`。

### 6.6 ロールバック

```sql
-- supabase/rollbacks/<番号はマージ時に確定>_billing_core.down.sql
-- 先に Web のデプロイを戻すこと (新しい Web はこの関数と列を呼ぶ)。
-- 消えるもの: billing_customers の全行、追加した列の値 (stripe_synced_at / stripe_status / cancel_at_period_end / billing_interval /
--             processing_started_at / attempt_count)。status が incomplete の行は expired にしてから CHECK を戻す。
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.billing_apply_stripe_subscription(jsonb, timestamptz, text);
DROP FUNCTION IF EXISTS public.billing_finish_stripe_event(text, boolean, text);
DROP FUNCTION IF EXISTS public.billing_claim_stripe_event(text, text, jsonb, interval);

DROP TABLE IF EXISTS public.billing_customers;

ALTER TABLE public.stripe_webhook_events
  DROP COLUMN IF EXISTS processing_started_at,
  DROP COLUMN IF EXISTS attempt_count;

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

行の由来: **S** = Stripe-backed (`stripe_subscription_id IS NOT NULL`。写像が書く) / **M** = 手動付与 (`stripe_subscription_id IS NULL`。配線の画面・運営が書く。写像は触らない) / **–** = 行が無い。

| status | live (部分 UNIQUE の述語) | 権利あり (`get_effective_plan`) | `plan_key_cached` | 新規購入できる (`POST /checkout`) | 解約の予約 (`/cancel`) | Portal | 写像が書く | S5 の配線ジョブが読む |
|---|---|---|---|---|---|---|---|---|
| – (行なし) | – | free (家族 / 組織があればそれ) | NULL | ○ | 409 | 顧客があれば ○ | INSERT で作る | – |
| `incomplete` (S のみ) | × | × | NULL | ○ (live でないため。Stripe 側で完了すると 2 本目になり得る → §13 の `BILL_LIVE_ROW_CONFLICT` の説明) | 409 | ○ | ○ | – |
| `trialing` | ○ | ○ | plan_key | 409 | ○ (S) / 409 (M) | ○ | ○ | – |
| `active` | ○ | ○ | plan_key | 409 | ○ (S) / 409 (M) | ○ | ○ | – |
| `past_due` | ○ | ○ | plan_key | 409 | ○ (S) | ○ | ○ | `past_due_since <= now()-7d` → `grace` |
| `grace` | ○ | ○ (有料機能の制限は配線) | plan_key | 409 | ○ (S) | ○ | 保持 (Stripe が past_due/unpaid の間) | `grace_started_at <= now()-23d` → Stripe を解約 |
| `paused` (配線の組織ライセンス) | ○ | × (`get_effective_plan` の対象外) | plan_key | 409 | ○ (S) | ○ | 保持 (Stripe が active + pause_collection の間) | – |
| `cancelled` | × | × | NULL | ○ | 409 | ○ | ○ (履歴として残る) | – |
| `expired` | × | × | NULL | ○ | 409 | ○ | ○ | – |

消費経路 (既存コード。origin/main で `personal_subscriptions` を名指しする `src/` の全ファイル) と本冊の影響。「読 / 書」= その経路が行を読むか書くか:

| 消費経路 | 読 / 書 | 列 / 条件 | 本冊での変化 |
|---|---|---|---|
| `get_effective_plan` (`20261010140000_ai_usage_foundation.sql:108-115`) | 読 | `status IN ('trialing','active','grace','past_due')` | 変えない。`incomplete` は対象外のまま |
| `src/lib/super-admin/plan-subscribers.ts:10,80` | 読 | live 5 値で数える | 変えない (`incomplete` は数えない) |
| `src/app/api/admin/users/[id]/route.ts:93-100` (運営のユーザー詳細) | 読 | session client (運営ロールの SELECT ポリシー) で `user_id = <id>` かつ `status IN ('active','trialing','paused','past_due','grace')` の最新 1 行の `plan_key, status, current_period_end` | 変えない。SELECT ポリシーは保つ (§6.2)。`incomplete` は live でないので出ない |
| `src/app/api/admin/finance/dashboard/route.ts:45-56` | 読 | 直接集計 (配線で実データ化) | 変えない |
| `src/app/api/admin/finance/reconciliation/route.ts:68` | 読 | `status IN ('active','trialing','past_due','grace')` | 変えない |
| `src/app/api/admin/finance/exports/route.ts:131-142` (`export_type='subscriptions'` の CSV。説明の文は `src/app/admin/finance/exports/page.tsx:30`「PII: user_id のみ」) | 読 | 明示の 9 列 `id, user_id, plan_key, status, starts_at, current_period_start, current_period_end, cancelled_at, created_at` (= 列の許可リスト)。status では絞らない。期間は `created_at` | 変えない。新しい 4 列 (`stripe_synced_at` / `stripe_status` / `cancel_at_period_end` / `billing_interval`) は許可リストに**足さない** (CSV に出ない。足すかは Finance の実データ化 = 配線の冊)。PII は従来どおり `user_id` だけ。`incomplete` と `cancelled_at = ended_at` の行は status / 日時の値のまま出る |
| `src/app/api/admin/finance/invoices/[id]/route.ts:45-54` (請求書の詳細) | 読 | `stripe_webhook_events.payload.data.object.subscription` (acacia の形) を `stripe_subscription_id` に当てて `user_id, plan_key` を `.single()` で引く | 変えない。写像は 1 契約 1 行 (`stripe_subscription_id` UNIQUE。§2.2 F5) なので `.single()` が成り立つ。`payload` はイベント全体を残す (§9.6)。Webhook のエンドポイントの API 版を acacia に固定する (§17.1 項 2) ので top-level の `subscription` が読める (basil に上げると null になる。そのときは `invoiceSubscriptionId` (§8.1) の形に直すのが配線の冊の課題) |
| `src/lib/account-export-tables.ts:237-242` / `tests/account-export*.test.ts` (本人のデータの書き出し) | 読 | `self('user_id')`・**`omit` 方式** (取得は全列、`omit` の列を出力前に消す。いまの `omit` = `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`, `notes`) | `omit` に `stripe_status`・`stripe_synced_at` を足す (Stripe との同期の内部の記録。`tests/account-export-tables.test.ts` の `SENSITIVE_NAME` (`stripe_`) の見張りが、足さないと段 A の migration で赤になる)。`cancel_at_period_end`・`billing_interval` は本人の契約の内容なので書き出す (`status`・`current_period_end` と同じ扱い)。段 A (§15.1・追随表 §16.1・テスト 75) |
| 機能フラグの段階公開 (`src/lib/feature-flags.ts`。`plan_key_cached`) | 読 | 空なら free | 写像が同期するので、購入後は plan で段階公開できる |
| `family_groups.plan_key` (family ドメイン) | 書 (写像) | FK | 代表者の個人契約 (`plan_type='family'`) から写像が同期 |
| DB 関数 `apply_coupon` (`20261007160700_apply_coupon_rpc.sql:147-152, 260-265`) | 読・書 | 契約行を `FOR NO KEY UPDATE` でロックして `user_id, plan_key` を読み、`active_coupon_redemption_id` **だけ**を UPDATE | 変えない (Stripe には反映されない。§4.2 S15)。写像の UPDATE (§6.4 の 8.) は `active_coupon_redemption_id` に触れないので互いの列を上書きしない。ロックの順は apply_coupon = `coupons` 行 → 契約行、写像 = advisory 2 本 → 契約行で、写像は `coupons` を取らないので循環しない |
| `src/lib/plan/coupon.ts:129-135` (`applyCoupon`) ← `src/app/api/super-admin/coupons/[id]/apply/route.ts:34-40` (super_admin・`getSupabaseAdmin()`) | 書 (RPC 経由) | `apply_coupon` を service_role で呼ぶだけ。直接の `.from('personal_subscriptions')` は無い | 変えない。RLS の是正 (§6.2) は service_role に当たらない。手動付与の行 (M) にも Stripe-backed の行 (S) にも従来どおり適用できる |
| `src/app/api/super-admin/plans/[id]/price-impact/route.ts:8` | — | コメントだけ (集計しない。#1102) | 変えない |

### 7.2 状態比較表 (現行 vs 設計後)

| 項目 | 現行 (origin/main) | 設計後 |
|---|---|---|
| 購入の入口 | 無い (`/pricing` の CTA は `/signup`・準備中) | `/pricing` → `/account/billing/checkout` → `POST /api/billing/checkout` → Stripe Checkout |
| 顧客の作成 | 無い | `billing_customers` に 1 利用者 1 顧客。Checkout の前に作る |
| `personal_subscriptions` への書き込み | アプリコードに無い。RLS は本人が書ける (F6) | 写像関数だけが書く (service_role)。本人は書けない。admin/super_admin の直接書き込みは従来どおり |
| `status` の値 | 7 値 | 8 値 (`incomplete` を足す) |
| Webhook の受け口 | 無い | `POST /api/webhooks/stripe` (署名・冪等・取り直し・単調) |
| 失敗したイベント | (05 の設計) `failed` のまま再処理されない | 再送で `claim` が取れて再処理される |
| 順序の入れ替わり | (05 の設計) 考慮なし | 常に最新を取り直し、`fetched_at` で単調 |
| 試用 | (04 の設計) SetupIntent + 日次ジョブで終了 | Checkout の `trial_period_days` + `payment_method_collection=always`。同じプランの再試用なし (0 日) |
| 支払失敗 | (05 の設計) アプリがメール送信 | Stripe の顧客向けメール。アプリは `past_due` の写像 + 監査 |
| 解約 | 無い | `/account/billing` から期間末の解約を予約・取り消し。即時解約は退会のとき |
| Billing Portal | 無い | `POST /api/billing/portal` |
| 退会 | Stripe は未処理 | 段階 `billing` で即時解約 + 顧客の匿名化 |
| `plan_key_cached` | 誰も同期しない | 写像が同期 |
| `family_groups.plan_key` / `member_limit` | 誰も書かない | 代表者の家族プラン契約から写像が同期 |
| `updated_at` | トリガー無し | `update_updated_at_column` のトリガー |
| 環境変数 | `STRIPE_SECRET_KEY` のみ一覧 | `STRIPE_WEBHOOK_SECRET` を一覧に足す。`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` は `.env.example` から消す (読む場所が無い) |
| モバイル | 課金の記述なし | アプリ内に購入導線を出さない規則。WebView のページも購入導線を描かない |

### 7.3 状態遷移表 (status × 操作・イベント → 遷移先・ガード・副作用)

「写像」= `billing_apply_stripe_subscription`。「—」= その状態では起きない / 何もしない。Stripe-backed の行 (S) についての表。手動付与 (M) の行は配線の冊。

| 現在 | 操作 / イベント (入口) | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| – | Checkout 完了 → `customer.subscription.created` / `checkout.session.completed` / 戻り画面の sync (写像) | `trialing` (試用あり) / `active` / `incomplete` (Stripe が incomplete のとき) | 利用者が解決できる・プランが解決できる・他に live 行が無い | INSERT・`billing_customers` 補完・`plan_key_cached`・家族の同期 (family)・監査 `subscription_created` |
| `incomplete` | `customer.subscription.updated` (支払完了) (写像) | `active` / `trialing` | 鮮度 | UPDATE・監査 `status_changed` |
| `incomplete` | `customer.subscription.updated/deleted` (`incomplete_expired`) (写像) | `expired` | 鮮度 | UPDATE・監査 |
| `trialing` | 試用終了の請求成功 → `invoice.paid` + `updated` (写像) | `active` | 鮮度 | `current_period_*` 更新・監査 |
| `trialing` | 試用終了の請求失敗 → `invoice.payment_failed` + `updated` (写像) | `past_due` | 鮮度 | `past_due_since=now()`・監査 `system.payment.failed` (warn) + `status_changed` (warn) |
| `trialing` / `active` / `past_due` / `grace` | 利用者の解約予約 `POST /api/billing/subscription/cancel` | 同じ status (`cancel_at_period_end=true`, `cancel_at=current_period_end`) | live かつ S | Stripe `POST /subscriptions/{id}`・写像 (`api:cancel`)・監査 `user.billing.cancel_scheduled` (actor = 本人) |
| 同上 (予約中) | 解約の取り消し `POST /api/billing/subscription/resume` | 同じ status (`cancel_at_period_end=false`, `cancel_at=NULL`) | live かつ S かつ `cancel_at_period_end` | Stripe 更新・写像 (`api:resume`)・監査 `user.billing.cancel_revoked` |
| `trialing` / `active` / `past_due` / `grace` | **Portal** で解約を予約 → `customer.subscription.updated` (`cancel_at_period_end=true`) (写像 `webhook:<event.id>`。route を通らない) | 同じ status (`cancel_at_period_end=true`, `cancel_at` = Stripe の値) | 鮮度 (`grace` は保持の規則で `grace` のまま) | UPDATE `cancel_at_period_end`・`cancel_at` のみ。**監査は書かない** (写像は status が変わったときだけ監査する。§6.4 の 11.。利用者の操作の記録は `stripe_webhook_events.payload` のイベント全体と Stripe の履歴に残る。§18 の 11)。`/account/billing` は `can_resume` になる |
| 同上 (予約中) | **Portal** で予約を取り消す → `customer.subscription.updated` (`cancel_at_period_end=false`) (写像 `webhook:<event.id>`) | 同じ status (`cancel_at_period_end=false`, `cancel_at=NULL`) | 鮮度 | 同上 (監査なし)。`/account/billing` は `can_cancel` になる |
| `active` | 更新日の請求成功 → `invoice.paid` + `updated` (写像) | `active` | 鮮度 | `current_period_*` 更新 (監査なし) |
| `active` | 更新日の請求失敗 → `invoice.payment_failed` + `updated` (写像) | `past_due` | 鮮度 | `past_due_since=now()`・監査 (warn) |
| `past_due` | Smart Retry 成功 → `invoice.paid` + `updated` (写像) | `active` | 鮮度 | `past_due_since=NULL`・監査 |
| `past_due` | 再試行失敗 → `invoice.payment_failed` (写像) | `past_due` | 鮮度 | 監査 `system.payment.failed` (warn) のみ |
| `past_due` | 配線 `grace_period_check` (直接 UPDATE。§12) | `grace` | `past_due_since <= now() - 7 日` | `grace_started_at=now()` (配線が書く) |
| `grace` | Stripe の再試行イベント (写像) | `grace` (保持) | Stripe が `past_due` / `unpaid` | 変化なし |
| `grace` | 支払回復 → `invoice.paid` + `updated` (写像) | `active` | 鮮度 | `past_due_since=NULL`・`grace_started_at=NULL`・監査 |
| `grace` | 配線が 30 日で Stripe を解約 → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`plan_key_cached` 再計算・家族を free に・監査 |
| `active` (予約中) | 期間末に Stripe が解約 → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | 同上 |
| `trialing` | 試用中の解約 → `customer.subscription.deleted` (予約 (API / Portal) が試用の終わりに効いたもの、または運営が Stripe の Dashboard で即時に解約したもの) (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`trial_started_at` / `trial_ends_at` は保つ (§6.4 の 8. の COALESCE。同じプランの再購入で試用を付けない判定 `hasUsedTrial` に使う。§4.2 S2)・`plan_key_cached` 再計算・家族を free に (family)・監査 `status_changed trialing→cancelled` (info) |
| `active` (予約なし) | Stripe 側での即時解約 (運営が Dashboard / API で解約) → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`plan_key_cached` 再計算・家族を free に・監査 `status_changed active→cancelled` (info)。返金は運営が Stripe で行う (核は返金を扱わない) |
| `past_due` | Stripe の再試行が尽きて解約 (§17.1 項 5 の設定が「キャンセルする」になっていた場合)、または運営が Dashboard で解約 → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`past_due_since=NULL`・`plan_key_cached` 再計算・家族を free に・監査 `status_changed past_due→cancelled` (info)。§17.1 項 5 の設定どおりなら起きず、`past_due → grace → cancelled` (配線) の道になる |
| `paused` (配線) | Stripe 側の解約 → `customer.subscription.deleted` (写像) | `cancelled` | 鮮度 | `cancelled_at=ended_at`・`plan_key_cached` 再計算・家族を free に・監査 `status_changed paused→cancelled` (info)。`paused` に戻すかどうか (組織ライセンスとの関係) は配線の冊 |
| `incomplete` | 運営が Stripe で未完了の契約を解約 → `customer.subscription.deleted` (Stripe の status `canceled`) (写像) | `cancelled` | 鮮度 | UPDATE・監査 `status_changed incomplete→cancelled` (info)。`plan_key_cached` は live な行から再計算するので変わらない。家族は、同じプランの live な行が別にあれば戻さない (§6.4 の 10. の `NOT EXISTS`。2 本目の Checkout が live になったあとで 1 本目の未完了が終わる場合) |
| `paused` (配線) | `updated` (Stripe `active` + `pause_collection`) (写像) | `paused` (保持) | — | 変化なし |
| `paused` (配線) | 配線が `pause_collection` を外す → `updated` (写像) | `active` | 鮮度 | 監査 |
| live (S) | 退会 (`deleteAccount` 段階 `billing`) | 行は `deleteUser` の CASCADE で消える | 顧客あり | Stripe `DELETE /subscriptions/{id}`・顧客の匿名化・`billing_customers.anonymized_at`・監査 `system.billing.account_deletion_stripe_cancelled` |
| `cancelled` / `expired` | Stripe の再送イベント (写像) | 同じ | 鮮度 | 変化なし |
| `cancelled` / `expired` | 新規購入 | 新しい行が `trialing` / `active` (古い行は履歴) | 他に live 行が無い | S1 と同じ |
| 任意 | 同じ `event.id` の再配信 | — | `claim` = duplicate | 200 |
| 任意 | 鮮度の古い取り直し (`fetched_at <= stripe_synced_at`) | — | — | `skipped: 'stale'` |
| 任意 | 利用者が退会済み | — | `auth.users` に無い | `skipped: 'user_deleted'` |

表に無い遷移を作るコードは blocking。`past_due → grace` と `grace → cancelled` の時間による遷移は配線の冊の所有 (本冊はガードの値 7 日 / 23 日を `05` §9 のとおり引き継ぐ。`04` §5.3 の「7 日後に cancelled」は誤りとして追随表に載せる)。

---

## 8. 正典コード

モジュールの置き方 (モジュラーモノリス。`src/lib/billing/` が課金モジュール、route と画面はその facade だけを呼ぶ):

| ファイル | 役割 | import してよいもの |
|---|---|---|
| `src/lib/billing/core.ts` | 定数・Zod・型・純関数・ポート (interface)・エラー型。**I/O を持たない** | `zod` だけ |
| `src/lib/billing/stripe-gateway.ts` | `StripeGateway` の実装 (fetch。REST + form-encode) | `core`・`@/lib/env`・`@/lib/db-logger` |
| `src/lib/billing/repository.ts` | `BillingRepository` の実装 (service_role の RPC と SELECT) | `core`・`@/lib/supabase/server`・`@/types/database.types` |
| `src/lib/billing/service.ts` | ユースケース (facade)。route はこれだけを呼ぶ | `core`・`stripe-gateway`・`repository`・`@/lib/site-config`・`@/lib/plan/entitlements` |
| `src/lib/billing/http.ts` | `BillingError` / `StripeApiError` / `AuthError` → `NextResponse` の対応と 400 の本文 | `core`・`next/server`・`@/lib/api/errors`・`@/lib/auth/errors` |
| `src/lib/billing/public-plans.ts` | `/pricing` が読む「買えるプラン」の一覧 (RLS を通る client) | `core`・`@/lib/supabase/server` |
| `src/lib/billing/account-deletion.ts` | 退会の段階 `billing` (§11) | `core`・`stripe-gateway`・`repository` |
| `src/lib/webhook/verify.ts` | Stripe の署名の確認を足す (§8.3) | 既存のまま + `@/lib/env` |

### 8.1 `src/lib/billing/core.ts` (正典。型検査済みの形)

```ts
// src/lib/billing/core.ts — 課金の核の定数・Zod・型・純関数・ポート。I/O を持たない (fetch / DB / env を読まない)。
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
/** Webhook の route の最長実行時間 (秒)。Stripe の取り直し 1 回 + RPC 1 回で足りる値 (Vercel の既定 10 秒だと Stripe が遅いときに切れる) */
export const STRIPE_WEBHOOK_MAX_DURATION_SECONDS = 30;
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
] as const;
export type BillingAuditAction = (typeof BILLING_AUDIT_ACTIONS)[number];
export type BillingAuditSeverity = 'info' | 'warn' | 'critical';
export interface BillingAuditEntry {
  actor_id: string | null;
  action_type: BillingAuditAction;
  /** 利用者の id (target_type は常に 'user') */
  target_id: string;
  severity: BillingAuditSeverity;
  /** 個人情報 (メール・氏名・カード) と秘密を入れない */
  details: Record<string, unknown>;
}

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
  EXT_STRIPE_NOT_CONFIGURED: 'お支払いの受付は準備中です',
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

/** イベントの外形。中身 (data.object) は id と object 以外を信じない (必ず取り直す。§4.1) */
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

export interface SubscriptionSnapshot {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  /** Checkout の metadata.user_id。無ければ null (SQL が顧客の対応表・既存の行で解決する) */
  user_id: string | null;
  /** metadata.plan_key → Price からの解決。どちらも無ければ null (SQL が既存の行で解決し、無ければ BILL_UNKNOWN_PLAN) */
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
}

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
// ポート (service.ts が使う。実装は stripe-gateway.ts / repository.ts。テストは偽物を渡す)
// ─────────────────────────────────────────────────────────────────────────────

export interface StripeGateway {
  readonly mode: StripeKeyMode | null;
  createCustomer(input: { userId: string; email: string | null }): Promise<StripeCustomer>;
  createCheckoutSession(params: StripeFormParams): Promise<StripeCheckoutSession>;
  retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscription>;
  updateCancelAtPeriodEnd(subscriptionId: string, cancelAtPeriodEnd: boolean): Promise<StripeSubscription>;
  cancelSubscriptionNow(subscriptionId: string): Promise<StripeSubscription>;
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
  | { applied: false; skipped: 'stale' | 'user_deleted'; subscription_id?: string; user_id?: string };

export type StripeEventClaim = 'claimed' | 'duplicate';

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
  /** 退会で解約する対象 (stripe_subscription_id があり、cancelled / expired 以外) */
  listStripeBackedSubscriptions(userId: string): Promise<Array<{ stripe_subscription_id: string; status: string }>>;
  applyStripeSubscription(input: { snapshot: SubscriptionSnapshot; fetchedAt: Date; source: string }): Promise<ApplySubscriptionResult>;
  claimStripeEvent(event: StripeEventEnvelope): Promise<StripeEventClaim>;
  finishStripeEvent(eventId: string, outcome: { ok: true } | { ok: false; errorCode: string }): Promise<void>;
  recordAudit(entry: BillingAuditEntry): Promise<void>;
}
```

### 8.2 設計上の約束 (core.ts に対して)

- `core.ts` は I/O を持たない。`fetch` / `process.env` / Supabase を import したら blocking。
- `STRIPE_TO_DB_STATUS` は §6.4 の `CASE` と 1 対 1 (`tests/billing-core.test.ts` と `tests/integration/rls/billing-apply-subscription-rpc.test.ts` の両方が同じ 8 行を期待値に持つ)。
- イベントの `data.object` から読むのは `id` と (invoice のとき) `subscription` の参照だけ。それ以外の値を DB に書いたら blocking (§4.1 の原理 2)。

### 8.3 `src/lib/webhook/verify.ts` に足す Stripe の署名の確認 (純粋な部分。型検査済み)

Stripe の署名: ヘッダー `Stripe-Signature: t=<UNIX 秒>,v1=<hex>[,v1=<hex>…][,v0=…]`。署名の入力は `"<t>.<受け取った本文そのまま>"`、鍵は署名の秘密 (`whsec_…`) の文字列そのもの (Svix と違い base64 に戻さない)。許容は前後 5 分 (`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` と同じ値)。

```ts
// src/lib/webhook/verify.ts に追記する部分。実装では同じファイルに置くので、下の import は要らない (既存の定数と型をそのまま使う)
import crypto from 'node:crypto';
import { WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS, type WebhookVerification } from '@/lib/webhook/verify';

/** Stripe-Signature の要素 (t=…, v1=…)。Stripe の仕様 */
const STRIPE_SIGNATURE_TIMESTAMP_KEY = 't';
const STRIPE_SIGNATURE_SCHEME = 'v1';
const MS_PER_SECOND = 1000;

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
// tsc:skip — 同じ verify.ts に足す、環境変数を読む側。STRIPE_WEBHOOK_SECRET を src/lib/env.ts の一覧に足すまで型が通らない (§8.7)
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
// tsc:skip — 新設モジュール core を import するため検査から外す。シグネチャは §8.1 の StripeGateway と一致させる
import { getOptionalEnv } from '@/lib/env';
import { createLogger } from '@/lib/db-logger';
import {
  STRIPE_API_BASE_URL,
  STRIPE_API_VERSION,
  CUSTOMER_IDEMPOTENCY_KEY_PREFIX,
  STRIPE_LOCALE,
  StripeApiError,
  StripeNotConfiguredError,
  StripeApiErrorBodySchema,
  StripeBillingPortalSessionSchema,
  StripeCheckoutSessionSchema,
  StripeCustomerSchema,
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
    if (request.method !== 'GET') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = toFormBody(request.params ?? {});
      if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
    }
    const response = await fetchImpl(`${STRIPE_API_BASE_URL}${request.path}`, init);
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
    updateCancelAtPeriodEnd: (subscriptionId, cancelAtPeriodEnd) =>
      call(
        { method: 'POST', path: `/subscriptions/${encodeURIComponent(subscriptionId)}`, params: { cancel_at_period_end: cancelAtPeriodEnd } },
        StripeSubscriptionSchema,
      ),
    cancelSubscriptionNow: (subscriptionId) =>
      // 即時解約。日割りの返金はしない (prorate=false)。請求中の invoice はそのまま (invoice_now=false)
      call({ method: 'DELETE', path: `/subscriptions/${encodeURIComponent(subscriptionId)}`, params: { prorate: false, invoice_now: false } }, StripeSubscriptionSchema),
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
- `createStripeGateway` は route の中で、認証 (`requireUser`) のあとに呼ぶ (鍵の有無の警告ログが未認証の連打で増えないように)。

### 8.5 `src/lib/billing/repository.ts` (BillingRepository の実装。service_role)

```ts
// tsc:skip — 新設モジュール core と、再生成前の database.types を使うため検査から外す
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { Database } from '@/types/database.types';
import {
  STRIPE_EVENT_STUCK_MINUTES,
  LIVE_SUBSCRIPTION_STATUSES,
  type ApplySubscriptionResult,
  type BillingAuditEntry,
  type BillingCustomerRow,
  type BillingRepository,
  type PurchasablePlan,
  type StripeEventClaim,
  type StripeEventEnvelope,
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
        .not('status', 'in', '("cancelled","expired")');
      if (error) throw error;
      return (data ?? []) as Array<{ stripe_subscription_id: string; status: string }>;
    },
    async applyStripeSubscription({ snapshot, fetchedAt, source }) {
      const { data, error } = await admin.rpc('billing_apply_stripe_subscription', {
        p_snapshot: snapshot as unknown as Database['public']['Functions']['billing_apply_stripe_subscription']['Args']['p_snapshot'],
        p_fetched_at: fetchedAt.toISOString(),
        p_source: source,
      });
      if (error) throw toBillingRpcError(error) ?? error;
      return data as ApplySubscriptionResult;
    },
    async claimStripeEvent(event) {
      const { data, error } = await admin.rpc('billing_claim_stripe_event', {
        p_event_id: event.id,
        p_event_type: event.type,
        p_payload: event as unknown as Database['public']['Functions']['billing_claim_stripe_event']['Args']['p_payload'],
        p_stuck_after: `${STRIPE_EVENT_STUCK_MINUTES} minutes`,
      });
      if (error) throw error;
      if (data !== 'claimed' && data !== 'duplicate') throw new Error('billing_claim_stripe_event が想定外の結果を返しました');
      return data as StripeEventClaim;
    },
    async finishStripeEvent(eventId, outcome) {
      const { error } = await admin.rpc('billing_finish_stripe_event', {
        p_event_id: eventId,
        p_ok: outcome.ok,
        p_error: outcome.ok ? null : outcome.errorCode,
      });
      if (error) throw error;
    },
    async recordAudit(entry) {
      // service_role なので RLS (actor_id = auth.uid()) を通らない。呼ぶ側は必ず認証のあと (route) か Webhook の署名のあと
      const { error } = await admin.from('admin_audit_logs').insert({
        actor_id: entry.actor_id,
        action_type: entry.action_type,
        target_id: entry.target_id,
        target_type: 'user',
        severity: entry.severity,
        details: entry.details,
      });
      if (error) throw error;
    },
  };
}
```

- `snapshot as unknown as …['p_snapshot']` は生成された型 (`Json`) に合わせるための変換で `as any` ではない (`SubscriptionSnapshot` は JSON にできる平らな型)。
- `recordAudit` の失敗は呼ぶ側 (service) が catch してログに残し、本体の操作は止めない (閲覧ログ `recordAdminAudit` と同じ fail-open)。ただし状態の変化の監査は RPC の中 (同じトランザクション) で書くので失敗しない。

### 8.6 `src/lib/billing/service.ts` (facade。route はこれだけを呼ぶ)

```ts
// tsc:skip — 新設モジュール同士を import するため検査から外す
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
  priceIdFor,
  projectSubscription,
  resolvePlanKey,
  summarizeSubscription,
  trialDaysFor,
  type BillingAuditEntry,
  type BillingRepository,
  type BillingSummary,
  type BillingInterval,
  type StripeEventEnvelope,
  type StripeGateway,
} from '@/lib/billing/core';

const logger = createLogger('billing/service');

export interface BillingDeps {
  gateway: StripeGateway;
  repository: BillingRepository;
  /** テストで差し替える (いま)。既定は () => new Date() */
  now?: () => Date;
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

/** 特商法の確認画面に出す内容 (GET /api/billing/checkout/preview)。Stripe は呼ばない */
export async function previewCheckout(deps: BillingDeps, userId: string, planKey: string, interval: BillingInterval): Promise<CheckoutPreview> {
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
    actor_id: user.id, action_type: 'user.billing.checkout_started', target_id: user.id, severity: 'info',
    details: { plan_key: planKey, interval, trial_days: trialDays, checkout_session_id: session.id },
  });
  return { url: session.url, session_id: session.id };
}

/** Stripe から最新の Subscription を取り直して写す (すべての写しの入口) */
export async function syncSubscription(deps: BillingDeps, subscriptionId: string, source: string) {
  const fetchedAt = (deps.now ?? (() => new Date()))();
  const sub = await deps.gateway.retrieveSubscription(subscriptionId);
  const { priceId } = projectSubscription(sub, null).stripe_price_id !== null ? { priceId: projectSubscription(sub, null).stripe_price_id } : { priceId: null };
  const planKeyByPrice = priceId !== null && !sub.metadata?.plan_key ? await deps.repository.findPlanKeyByPriceId(priceId) : null;
  const snapshot = projectSubscription(sub, resolvePlanKey(sub, planKeyByPrice));
  return deps.repository.applyStripeSubscription({ snapshot, fetchedAt, source });
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

export async function getBillingSummary(deps: BillingDeps, userId: string): Promise<BillingSummary> {
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
      actor_id: userId, action_type: 'user.billing.cancel_scheduled', target_id: userId, severity: 'info',
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
    actor_id: userId, action_type: 'user.billing.cancel_revoked', target_id: userId, severity: 'info',
    details: { stripe_subscription_id: row.stripe_subscription_id, plan_key: row.plan_key },
  });
  return getBillingSummary(deps, userId);
}

export type StripeEventOutcome = { action: 'synced' | 'ignored' | 'skipped'; detail: string };

/**
 * 署名と claim を通ったイベントを処理する (POST /api/webhooks/stripe)。例外は route が finish(ok=false) + 500 にする。
 * data.object からは id と (invoice の) subscription の参照だけを読む (§4.1)。
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
      if (action === 'audit_payment_failed_and_sync' && result.applied) {
        await audit(deps.repository, {
          actor_id: null, action_type: 'system.payment.failed', target_id: result.user_id, severity: 'warn',
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

実装の注意: `syncSubscription` の `priceId` の取り出しは `primaryPrice(sub).priceId` に書き換えてよい (上は説明のため冗長)。`findPlanKeyByPriceId` を呼ぶのは `metadata.plan_key` が無いときだけ (Dashboard で作られた契約。S13)。

### 8.7 既存ファイルへの差分 (env / rate-limit / http)

```ts
// tsc:skip — src/lib/env.ts の SERVER_ENV_VARS に足す 1 項目 (STRIPE_SECRET_KEY の直後)
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
// tsc:skip — src/lib/rate-limit.ts: RateLimitCategory に 'billing' を足し、CATEGORY_RULES に 1 行足す
  // 課金の操作 (Checkout の作成・Portal・解約の予約と取り消し・戻り画面の同期)。利用者ごと。
  // Stripe の API を 1〜2 回呼ぶ操作なので、連打で Stripe 側のレート制限や顧客の重複を起こさない値
  billing: [{ name: 'billing', max: 10, windowSec: MINUTE_SEC }],
```

```ts
// tsc:skip — src/lib/billing/http.ts (route 共通の応答)
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

`ForbiddenError` の `code` は `AUTH_ACCOUNT_FROZEN` (凍結中。`requireUser` が投げる)。文は固定 (`error.message` を本文に入れない。`tests/api-raw-error-message-scan.test.ts` の規則)。
---

## 9. API 仕様

共通: 認証は `requireUser()` (`src/lib/auth/helpers.ts`。凍結中は 403 `AUTH_ACCOUNT_FROZEN`)。本文は JSON。応答は `{ data: … }` / `{ error: { code, message } }` (`cross/04` §5)。すべて `Cache-Control: no-store`。POST はレート制限 `billing` (10 回 / 分 / 利用者。超過は `rateLimitExceededResponse` の 429)。500 は `billingErrorResponse` → `internalError` (nested)。route は `src/lib/billing/service.ts` だけを呼び、`core.ts` の Zod で入力を検証する。`export const dynamic = 'force-dynamic'`。

route の骨格 (全 route 共通。`// tsc:skip`):

```ts
// tsc:skip — src/app/api/billing/checkout/route.ts (骨格。ほかの route も同じ形)
import { NextResponse } from 'next/server';
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
| 副作用 | 無し (Stripe を呼ばない。レート制限も掛けない) |

### 9.3 `POST /api/billing/checkout/sync` — 戻り画面からの同期

| | |
|---|---|
| 入力 | `{ session_id: string }` (`CheckoutSyncRequestSchema`。`cs_` で始まる) |
| 200 | `{ data: BillingSummary }`。Session が `complete` でなければ写さずに要約だけ返す (画面は「処理中」を出し、数秒後に `GET /api/billing/subscription` を読み直す) |
| 403 | `BILL_CHECKOUT_SESSION_MISMATCH` (`client_reference_id` が本人でない) |
| 502 / 503 / 429 / 400 / 401 | 9.1 と同じ |

### 9.4 `GET /api/billing/subscription` — 契約の要約 / `POST /api/billing/portal` — Billing Portal

| | GET subscription | POST portal |
|---|---|---|
| 200 | `{ data: BillingSummary }` | `{ data: { url } }` |
| 404 | — | `BILL_CUSTOMER_NOT_FOUND` (まだ一度も購入していない) |
| 副作用 | 無し | Stripe に Portal Session を作る (`return_url` = `/account/billing`) |
| モバイル | WebView からも呼べる (表示だけに使う) | 画面が呼ばない (§10.4) |

### 9.5 `POST /api/billing/subscription/cancel` / `POST /api/billing/subscription/resume`

| | cancel | resume |
|---|---|---|
| 入力 | 無し | 無し |
| 200 | `{ data: BillingSummary }` (予約済みなら何もせず同じ) | `{ data: BillingSummary }` |
| 409 | `BILL_NO_LIVE_SUBSCRIPTION` (live かつ Stripe-backed の行が無い。手動付与は解約できない = 配線の画面) | `BILL_NO_LIVE_SUBSCRIPTION` / `BILL_CANCEL_NOT_SCHEDULED` |
| Stripe | `POST /v1/subscriptions/{id}` `cancel_at_period_end=true` | 同 `false` |
| 副作用 | 写像 (`api:cancel`)・監査 `user.billing.cancel_scheduled` | 写像 (`api:resume`)・監査 `user.billing.cancel_revoked` |

### 9.6 `POST /api/webhooks/stripe` — Webhook の受け口

認証はログインのセッションではなく署名 (`cross/04` §10)。`export const runtime = 'nodejs'`・`export const dynamic = 'force-dynamic'`・`export const maxDuration = STRIPE_WEBHOOK_MAX_DURATION_SECONDS` (30)。

| 順 | 処理 | 応答 |
|---|---|---|
| 1 | `content-length` と本文の実バイト数が `STRIPE_WEBHOOK_MAX_BODY_BYTES` (1 MiB) を超える | 413 `{ error: 'payload_too_large' }` |
| 2 | `payload = await request.text()` (JSON として読む前の文字列) → `verifyStripeWebhook(payload, request.headers.get('stripe-signature'))` | 秘密が無い (`WebhookSecretMissingError`) → 503 `{ error: 'webhook_not_configured' }` (error ログ。変数名は本文に出さない) / 合わない → 401 `{ error: 'unauthorized' }` (warn ログに reason) |
| 3 | `JSON.parse` → `StripeEventEnvelopeSchema.safeParse` | 読めない・形が違う → 400 `{ error: 'invalid_payload' }` |
| 4 | `createStripeGateway()` (鍵が無ければ `StripeNotConfiguredError`) | 503 `{ error: 'stripe_not_configured' }` |
| 5 | `event.livemode` と `gateway.mode` の不一致 (`mode` が null のときは不一致扱いにしない) | 200 `{ received: true, ignored: true }` + warn ログ。DB に書かない |
| 6 | `repository.claimStripeEvent(event)` = `duplicate` | 200 `{ received: true, duplicate: true }` |
| 7 | `handleStripeEvent(deps, event)` → `finishStripeEvent(id, { ok: true })` | 200 `{ received: true, action, detail }` |
| 8 | 7 で例外 → `finishStripeEvent(id, { ok: false, errorCode })` (`errorCode` = `BillingRpcError.code` / `StripeApiError` なら `EXT_STRIPE_API_FAILED` / それ以外 `SYS_INTERNAL_ERROR`) → 監査 `system.stripe.event_failed` (warn, `details: { event_id, event_type, error_code }`。fail-open) | `internalError(ROUTE_NAME, error, { event_id, event_type })` = 500 (Stripe が再送する) |

- `finishStripeEvent` 自体が失敗したら、その失敗も `internalError` に渡して 500 (行は `processing` のまま残り、15 分後の再送で再び権利が取れる)。
- 本文に Stripe の生のエラー文・イベントの中身を入れない。`stripe_webhook_events.payload` にはイベントの JSON 全体を残す (service_role だけが読める。掃除は配線の冊)。

### 9.7 ログ (app_logs) の規則

`createLogger('<ROUTE_NAME>')`。利用者の操作は `withUser(user.id)`。残すのは `plan_key` / `interval` / `stripe_subscription_id` / `checkout_session_id` / `event_id` / `event_type` / `status_from` / `status_to` / `request_id` だけ。メールアドレス・氏名・カード・秘密鍵・署名の値は残さない (db-logger のマスクに頼らず渡さない)。
---

## 10. 画面・モバイル

### 10.1 `/pricing` (公開ページ) — データ駆動で「買えるプランだけ」を描く

- `src/app/pricing/page.tsx` を **async の Server Component** にする。`listPurchasablePlans()` (`src/lib/billing/public-plans.ts`) で `subscription_plans` から `status='public' AND plan_type IN ('personal','family') AND plan_key <> 'free' AND stripe_price_id IS NOT NULL` を `display_order` 順に読み (RLS `subscription_plans_select_public` を通る `createClient()`。未ログインでも読める)、`cookies().get('is_native_app')?.value === '1'` を `isNativeApp` として、描画を `src/app/pricing/PricingPageView.tsx` (`"use client"`。いまの見た目を移す) に渡す。
- `PricingPageView` の規則: 買えるプランが 0 件 → いまと同じ「準備中」の表示 (`PAID_PLAN_PENDING` と FAQ はそのまま)。1 件以上 → プランごとにカード (表示名・月額/年額 (税込)・`trial_days > 0` なら「X 日間無料」・CTA「このプランで始める」)。CTA は `/account/billing/checkout?plan_key=<key>&interval=<month|year>` への Link (未ログインなら `(main)` の既存のガードでログインへ回る)。`isNativeApp` なら有料プランのカードと CTA を描かず、フリーの説明だけ描く (§10.4)。
- 価格の表示は `monthly_price_jpy` / `yearly_price_jpy` をそのまま (DB の値が正)。
- `tests/public-claims-guard.test.ts` は `@/lib/billing/public-plans` をモックして「0 件 → 準備中」(いまの期待値) と「1 件 → 価格と CTA」(新しい期待値) の両方を持つ (§16.1)。

```ts
// tsc:skip — src/lib/billing/public-plans.ts
import { createClient } from '@/lib/supabase/server';
import { FREE_PLAN_KEY, PURCHASABLE_PLAN_TYPES, type PurchasablePlan } from '@/lib/billing/core';

const PLAN_COLUMNS = 'plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id';

/** /pricing に出す「買えるプラン」。月額の Price があるものだけ (年額は任意)。失敗したら空 (ページは準備中になる。ログに残す) */
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
  if (error) throw error;
  return (data ?? []) as PurchasablePlan[];
}
```

### 10.2 `/account/billing/checkout?plan_key=&interval=` — 特商法の最終確認 (`cross/08` §3)

- `src/app/(main)/account/billing/checkout/page.tsx` (`"use client"`)。`GET /api/billing/checkout/preview` で内容を取り、`src/components/billing/checkout-confirmation.tsx` (`cross/08` §3.2 の形を踏襲) に渡す。
- 必須の表示: プラン名 / 料金 (月額 or 年額、税込) / 自動更新であること・解約しない限り課金が続くこと / 解約方法 (`/account/billing` から) / 解約予告期間 (いつでも。次回更新日まで利用可) / 最低契約期間 (なし) / 利用規約・プライバシーポリシーへのリンク (`/terms` `/privacy`) / `trial_days > 0` なら「X 日間の無料期間のあと課金」、0 なら「お申し込み後すぐに課金」/ `can_purchase` が false なら「すでに有効な契約があります」で CTA を無効。
- チェックボックス「上記内容を確認しました」が ON で「申し込む」が活性 → `POST /api/billing/checkout` → `data.url` へ移動。422 / 409 / 503 は固定の文 (`BILLING_ERROR_MESSAGES`) を表示。
- `isNativeApp` (`useNativeAppMode`) なら、このページは「この操作はアプリでは行えません」とだけ描く (§10.4)。

### 10.3 `/account/billing` — 契約の管理

- `src/app/(main)/account/billing/page.tsx` (`"use client"`)。`GET /api/billing/subscription` を読む。
- クエリ `checkout=success&session_id=` で開いたら、先に `POST /api/billing/checkout/sync` を呼ぶ (S9)。`status` がまだ無ければ「お申し込みを処理しています」を出し、`CHECKOUT_SYNC_RETRY_MS` (3 秒) ごとに `GET` を最大 `CHECKOUT_SYNC_MAX_RETRIES` (10 回) 読み直す。`checkout=cancelled` なら「お申し込みは完了していません」。
- 表示: 現在のプラン (`effective_plan_key` が `plan_key` と違うときは「家族 / 組織のプランが適用中」も添える)・状態 (`trialing`「無料期間中 (X まで)」/ `active`・`past_due`「お支払いに問題があります。お支払い方法をご確認ください」/ `grace`「お支払いが確認できないため一部の機能を制限しています」/ `cancel_at_period_end`「X に解約されます」)・次回更新日・支払い周期。
- ボタン: `has_customer` → 「お支払い方法・請求書 (Stripe)」= `POST /api/billing/portal` → `url` へ。`can_cancel` → 「解約する」(確認ダイアログ) = `POST …/cancel`。`can_resume` → 「解約を取り消す」= `POST …/resume`。`can_purchase` → 「プランを見る」= `/pricing`。
- `isNativeApp` なら表示だけ (ボタンは描かない)。
- 設定画面 (`src/app/(main)/settings/page.tsx`) に「プランとお支払い」の行を足し `/account/billing` へ (Web だけ。`isNativeApp` では描かない)。

### 10.4 モバイル (アプリ内課金をしない)

- `apps/mobile` には本冊で変更を入れない。
- 規則 (ストアの規約に触れない形): アプリ内 (ネイティブ画面と、アプリが開く WebView のページの両方) に、有料プランの価格・購入ボタン・Web での購入への誘導 (リンク・文言) を出さない。既存の契約の状態 (プラン名・次回更新日・解約予約) を読み取り専用で出すのは可 (本冊では Web の `/account/billing` の WebView 表示がその形。ネイティブ画面での表示は配線の冊)。
- 実装の仕組み: Web の 3 ページ (`/pricing` `/account/billing` `/account/billing/checkout`) が `is_native_app` Cookie (`useNativeAppMode` / `cookies()`) で購入導線を描かない。API 自体には制限を付けない (認可は同じ。制限は表示の規則)。
- 未確認: App Store / Google Play の規約の最新の文面と、審査での判断。openQuestions に残す (§18)。

---

## 11. 退会との結合 (#1562)

`src/lib/account-deletion.ts` の `deleteAccount` に段階 `'billing'` を足す。位置は `check_blockers` の直後・`prepare` の前 (Stripe の失敗で止まったとき、まだ何も変えていないのでやり直せる)。

```ts
// tsc:skip — src/lib/account-deletion.ts の差分 (抜粋)
export type AccountDeletionStep =
  | 'init'
  | 'check_blockers'
  | 'billing'            // 追加: Stripe の解約と顧客の匿名化 (billing/01 §11)
  | 'prepare'
  | 'release_membership'
  | 'storage'
  | 'delete_user';

export interface AccountDeletionBilling {
  /** 契約を即時解約し、顧客を匿名化する。顧客が無ければ何もしない。失敗は例外 (段階 'billing' で止める) */
  cancelForAccountDeletion(userId: string, log: AccountDeletionLogger): Promise<{ cancelled_subscriptions: number; customer: 'anonymized' | 'none' }>;
}

export interface DeleteAccountParams {
  // … 既存 …
  /** テストで差し替える。既定は src/lib/billing/account-deletion.ts の実装 */
  billing?: AccountDeletionBilling;
}

// deleteAccount の中 (completionEmailTo を控えたあと、prepare の前):
    step = 'billing';
    const billing = params.billing ?? defaultAccountDeletionBilling;
    const billingReport = await billing.cancelForAccountDeletion(userId, userLog);
    // … 既存の prepare 以降 …
    // 最後の 'account deleted' のログに billing: billingReport を足す
```

```ts
// tsc:skip — src/lib/billing/account-deletion.ts
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { createBillingRepository } from '@/lib/billing/repository';
import type { AccountDeletionBilling, AccountDeletionLogger } from '@/lib/account-deletion';

export const defaultAccountDeletionBilling: AccountDeletionBilling = {
  async cancelForAccountDeletion(userId: string, log: AccountDeletionLogger) {
    const repository = createBillingRepository();
    const customer = await repository.findCustomer(userId);
    if (customer === null) return { cancelled_subscriptions: 0, customer: 'none' };
    // 顧客があるのに鍵が無ければ、解約の義務を果たせないので止める (StripeNotConfiguredError → 段階 'billing' の 500)
    const gateway = createStripeGateway();
    let cancelled = 0;
    for (const row of await repository.listStripeBackedSubscriptions(userId)) {
      const current = await gateway.retrieveSubscription(row.stripe_subscription_id);
      if (current.status !== 'canceled') {
        await gateway.cancelSubscriptionNow(row.stripe_subscription_id);
        cancelled += 1;
      }
    }
    const anonymizedAt = new Date().toISOString();
    await gateway.anonymizeCustomer(customer.stripe_customer_id, anonymizedAt);
    await repository.markCustomerAnonymized(customer.stripe_customer_id, anonymizedAt);
    await repository.recordAudit({
      actor_id: userId, action_type: 'system.billing.account_deletion_stripe_cancelled', target_id: userId, severity: 'info',
      details: { cancelled_subscriptions: cancelled, stripe_customer_id: customer.stripe_customer_id },
    });
    log.info('account deletion: stripe subscriptions cancelled and customer anonymized', { cancelled_subscriptions: cancelled });
    return { cancelled_subscriptions: cancelled, customer: 'anonymized' };
  },
};
```

- 解約は即時 (`DELETE /v1/subscriptions/{id}`、日割りの返金なし)。顧客は `name / email / phone / description / address / shipping` を消し、`metadata.user_id` を消し `metadata.anonymized_at` を入れて残す (請求書・支払いの記録は Stripe に残る。確定済みの請求書に印字された氏名は Stripe の仕様で変わらない)。
- `billing_customers` は `deleteUser` で `user_id` が SET NULL になり、`anonymized_at` の入った行が残る。
- 退会後に届く Webhook は RPC が `skipped: 'user_deleted'` を返す (S10)。
- `cross/08` §16.3 の「Stripe の顧客・サブスクリプション: 行っていない」の行と §19 の TODO は、本冊を指すように直す (§16.2)。
- `docs/design/cross/08` §16.2 の退会の手順の一覧に「2'. Stripe の解約と顧客の匿名化」を足す。

---

## 12. 配線の冊が読む契約 (本冊で確定)

| 契約 | 内容 | 配線での使い方 |
|---|---|---|
| 写像の入口 | `billing_apply_stripe_subscription(p_snapshot, p_fetched_at, p_source)` (§6.4) / TS では `syncSubscription(deps, subscriptionId, source)` (§8.6) | reconcile (`stripe_integrity_check`) は Stripe の全契約を列挙して 1 件ずつ `syncSubscription(…, 'wiring:reconcile')` を呼ぶ (自動修復 = 写像。05 §8 の「自動修復しない」は、写像が正本からの写しである以上、写すこと自体が修復になるので本冊で置き換える) |
| `past_due → grace` | 配線の日次ジョブが `UPDATE personal_subscriptions SET status='grace', grace_started_at=now() WHERE status='past_due' AND past_due_since <= now() - interval '7 days' AND stripe_subscription_id IS NOT NULL` を直接行う (写像は呼ばない)。写像は Stripe が `past_due / unpaid` の間 `grace` を保つ | `grace_period_check` (09:30 JST) |
| `grace → cancelled` | 配線のジョブが `grace_started_at <= now() - interval '23 days'` の行の Stripe を `cancelSubscriptionNow` し、届く `deleted` の写像で `cancelled` になる (DB を直接 `cancelled` にしない) | 同上 |
| 手動付与 | `stripe_subscription_id IS NULL` の行。配線の画面が admin の RLS (`personal_subscriptions_insert_admin` / `_update_admin`) で書く。写像は触らない。`get_effective_plan` は区別しない | 運営の手動付与の画面・API |
| 一時停止 (`paused`) | 配線が Stripe `pause_collection` を付け DB を `paused` (`paused_until` 必須) にする。写像は `active + pause_collection` の間 `paused` を保つ。`pause_collection` を外せば `active` に戻る | 組織ライセンス受領 (04 §5.4) |
| 顧客の対応表 | `billing_customers (stripe_customer_id PK, user_id UNIQUE NULL 可, anonymized_at)` | Finance 画面の deep link (`getStripeLinks`) |
| Webhook のイベント | `stripe_webhook_events` に全イベントの JSON。`processing_status` / `processing_started_at` / `attempt_count` / `error_message` (固定のコード) | `stripe_event_stuck_check` は不要になる (claim が代替)。残すなら `processing_started_at` を見る。`failed` の一覧を Finance 画面に出す |
| イベントの追加 | `STRIPE_EVENT_ACTIONS` に 1 行 (`charge.dispute.created` など) + `service.ts` の `switch` に 1 分岐 + Dashboard の登録 | チャージバック・メール |
| 監査 | `admin_audit_logs` の `action_type` (§8.1 `BILLING_AUDIT_ACTIONS`)。`system.*` は `actor_id NULL` | Finance 画面の履歴 |
| 要約 | `GET /api/billing/subscription` (`BillingSummary`) | モバイルの表示 |
| `grace` の機能制限 | `get_effective_plan` は `grace` を含めたまま。制限は各入口 (AI など) が `status='grace'` を見て 402 にする (05 §9) | 配線 |
| 環境変数 | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (一覧)。鍵の有無は `createStripeGateway` が判定 | Vercel Cron の route も同じ gateway を使う |

---

## 13. エラー表

### 13.1 API (利用者向け。本文は固定の文)

| コード | HTTP | 出どころ | 文 (`BILLING_ERROR_MESSAGES`) |
|---|---|---|---|
| `BILL_INVALID_INPUT` [NEW] | 400 | Zod | 最初の issue の文 (details に全件) |
| `AUTH_UNAUTHENTICATED` | 401 | `requireUser` | 認証が必要です |
| `AUTH_ACCOUNT_FROZEN` | 403 | `requireUser` | 権限がありません |
| `BILL_CHECKOUT_SESSION_MISMATCH` [NEW] | 403 | sync | このお申し込みは確認できません |
| `BILL_CUSTOMER_NOT_FOUND` [NEW] | 404 | portal | お支払い情報がまだありません |
| `OP_SUBSCRIPTION_ALREADY_ACTIVE` | 409 | checkout | すでに有効な契約があります |
| `BILL_NO_LIVE_SUBSCRIPTION` [NEW] | 409 | cancel / resume | 有効な契約がありません |
| `BILL_CANCEL_NOT_SCHEDULED` [NEW] | 409 | resume | 解約は予約されていません |
| `BILL_PLAN_NOT_PURCHASABLE` [NEW] | 422 | checkout / preview | このプランは現在お申し込みできません |
| `RATE_LIMITED` | 429 | `rateLimitExceededResponse` | 既存の文 |
| `INTERNAL_ERROR` | 500 | `internalError` (nested) | 処理中にエラーが発生しました |
| `EXT_STRIPE_API_FAILED` [NEW] | 502 | gateway | 決済サービスとの通信に失敗しました。しばらくしてからお試しください |
| `EXT_STRIPE_NOT_CONFIGURED` [NEW] | 503 | gateway | お支払いの受付は準備中です |

[NEW] は `cross/04` §4.2 に追記する (`BILL_` の接頭辞の行を §4.1 の表に足す。§16.2)。

### 13.2 Webhook (Stripe 向け。本文は固定の語)

| HTTP | 本文 | 意味 |
|---|---|---|
| 200 | `{ received: true, action, detail }` / `{ received: true, duplicate: true }` / `{ received: true, ignored: true }` | 処理した / 既に処理済み / 対象外・モード不一致 |
| 400 | `{ error: 'invalid_payload' }` | JSON でない・外形が違う |
| 401 | `{ error: 'unauthorized' }` | 署名が無い・合わない・時刻が古い |
| 413 | `{ error: 'payload_too_large' }` | 1 MiB 超 |
| 500 | `internalError` の本文 | 処理の失敗 (Stripe が再送する) |
| 503 | `{ error: 'webhook_not_configured' }` / `{ error: 'stripe_not_configured' }` | 署名の秘密が無い / 鍵が無い |

### 13.3 DB 関数の業務エラー (`P0001`。TS では `BillingRpcError`)

| コード | DETAIL | 意味 | 扱い |
|---|---|---|---|
| `BILL_UNKNOWN_USER` | subscription id | metadata にも対応表にも既存の行にも利用者が無い | イベント `failed`・500・監査 `system.stripe.event_failed`。運営が Stripe の顧客に `metadata.user_id` を付けるか、契約を解約する |
| `BILL_UNKNOWN_PLAN` | subscription id / plan_key | plan_key を解決できない、または `subscription_plans` に無い | 同上。運営が Price を `subscription_plans` に登録する |
| `BILL_UNKNOWN_STRIPE_STATUS` | status | Stripe が未知の status を返した (API 版の変更) | 同上。`STRIPE_API_VERSION` と Zod を見直す |
| `BILL_LIVE_ROW_CONFLICT` | 既存の live 行の id | 同じ利用者に別の live 行 (別の Stripe 契約、または手動付与) がある | 同上。運営が Stripe で 2 本目を解約・返金する (S12) |
---

## 14. テスト一覧 (it 名)

### 14.1 単体 (`npm test`。DB も Stripe も使わない)

`tests/billing-core.test.ts` (`src/lib/billing/core.ts`):
1. `it('STRIPE_TO_DB_STATUS maps all 8 Stripe statuses and matches §6.4')`
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
14. `it('summarizeSubscription: no row → free/can_purchase, live row → can_cancel, scheduled → can_resume, manual row → no cancel')`
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
31. `it('scheduleCancellation is idempotent and audits once; revokeCancellation 409 when not scheduled')`
32. `it('handleStripeEvent: ignore / sync_subscription / invoice with and without subscription / payment_failed audits')`
33. `it('handleStripeEvent reads nothing from data.object except id and the invoice subscription ref')`

`tests/api/billing-routes.test.ts` (route。`@/lib/billing/service` をモック):
34. `it('POST /api/billing/checkout: 401 unauthenticated, 403 frozen, 429 rate limited, 400 invalid body, 200 url')`
35. `it('every billing route maps BillingError/StripeApiError/StripeNotConfiguredError to the table and returns fixed messages')`
36. `it('GET /api/billing/subscription returns the summary with Cache-Control: no-store')`

`tests/webhooks-stripe-route.test.ts`:
37. `it('413 for oversized body before verifying the signature')`
38. `it('503 webhook_not_configured when the secret is missing; 401 on bad signature; 400 on bad JSON')`
39. `it('200 ignored on livemode mismatch without touching the repository')`
40. `it('200 duplicate when claim returns duplicate; 200 synced when handled; 500 and finish(ok=false) on failure')`
41. `it('response bodies never contain the event payload or raw error text')`

`tests/account-deletion.test.ts` (追加):
42. `it('runs the billing step after check_blockers and before prepare; a billing failure stops with step billing and does not call prepare/deleteUser')`
43. `it('skips Stripe when the user has no billing customer')`

`tests/billing-migration-contract.test.ts` (SQL の文面。DB は使わない):
44. `it('migration adds incomplete to the status CHECK and keeps the other 7 values')`
45. `it('migration drops the user_id = auth.uid() branch from INSERT/UPDATE policies and keeps SELECT/DELETE policies')`
46. `it('billing functions are SECURITY DEFINER with search_path = "" and EXECUTE only for service_role')`
47. `it('rollback restores the baseline policies verbatim and drops everything the migration added')`
48. `it('migration contains no UPDATE/DELETE of existing rows outside function bodies')`
49. `it('migration comment does not attribute decisions (no "オーナー判断")')`

`tests/public-claims-guard.test.ts` (更新):
50. `it('pricing page shows 準備中 when there is no purchasable plan')` (既存の期待値を保つ)
51. `it('pricing page shows plan cards and CTA when a purchasable plan exists, and hides them in native app mode')`

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

`tests/env-source-scan.test.ts` / `tests/check-env-script.test.ts`: 変更なし (一覧と `.env.example` を合わせれば緑)。

### 14.2 結合 (ローカル Supabase。`tests/integration/rls` と `security` に置き、CI の指定に当たる)

`tests/integration/rls/billing-apply-subscription-rpc.test.ts`:
52. `it('inserts a trialing row from a snapshot with metadata.user_id and sets plan_key_cached')`
53. `it('maps all 8 Stripe statuses as in STRIPE_TO_DB_STATUS')`
54. `it('keeps grace while Stripe says past_due/unpaid and clears it on active')`
55. `it('keeps paused while Stripe is active with pause_collection')`
56. `it('skips stale snapshots (fetched_at <= stripe_synced_at) and applies newer ones')`
57. `it('raises BILL_LIVE_ROW_CONFLICT when another live row (manual) exists for the user')`
58. `it('raises BILL_UNKNOWN_PLAN when neither metadata nor existing row gives a plan')`
59. `it('resolves the user from billing_customers when metadata.user_id is missing and inserts the mapping when missing')`
60. `it('returns skipped user_deleted for a user that no longer exists')`
61. `it('syncs family_groups.plan_key and member_limit for the representative on live and resets to free on cancel')`
62. `it('writes one admin_audit_logs row per status change with actor_id NULL')`
63. `it('is not executable by anon/authenticated (42501)')`
64. `it('serializes concurrent applies for the same subscription (advisory lock)')`
80. `it('does not reset the family group to free when a non-live row ends while another live row of the same plan exists')` (§6.4 の 10. の `NOT EXISTS`)

`tests/integration/rls/billing-webhook-events-claim-rpc.test.ts`:
65. `it('claims a new event, reports duplicate for completed and in-progress, re-claims failed and stuck processing')`
66. `it('finish sets completed/processed_at or failed/error_message (truncated)')`

`tests/integration/security/billing-personal-subscriptions-rls.test.ts`:
67. `it('authenticated user cannot INSERT or UPDATE own personal_subscriptions row (RLS) but can SELECT it')`
68. `it('admin can still INSERT/UPDATE; anon has no INSERT/UPDATE/DELETE privilege')`
69. `it('billing_customers is invisible to anon/authenticated and readable/writable by service_role')`
70. `it('updated_at advances on UPDATE of personal_subscriptions')`

`tests/integration/security/auth-users-fk-on-delete.test.ts` (既存): `billing_customers.user_id` の FK が SET NULL で NULL 可であることを A・C が自動で確かめる (期待の本数 D を 1 本足す。§16.1)。

`tests/integration/security/account-export-scope.test.ts` (既存の「出力しない列」の it を延長): `personal_subscriptions` の `not.toHaveProperty` の一覧 (いま 4 列) に `stripe_status`・`stripe_synced_at` を足す (§7.1・§16.1)。

### 14.3 E2E (Playwright。Stripe のテストモードが要るので `tests/e2e/.manual/` に置き CI では流さない)
71. `it('E2E: buy pro monthly with test card 4242, land on /account/billing, see trialing')` (手順書 §17.3)

---

## 15. 段分け・触るファイルの母集合・新設一覧

### 15.1 段分け (1 つの B 型 WF の中で段ごとに 2 枚レビュー。段 A は単独でマージしてよい)

| 段 | 内容 | ファイル | テスト |
|---|---|---|---|
| A: DB 層 | migration + rollback、`database.types.ts` の再生成 (2 本)、SQL 文面の契約テスト、結合テスト、本人の書き出しの `omit` (新しい列が migration と同時に見張りに当たるため) | §6・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・`src/lib/account-export-tables.ts` | 44〜49, 52〜70, 75, 80 (+ `account-export-scope` の延長) |
| B: サーバ層 | `src/lib/billing/*`、`verify.ts`、`env.ts`、`rate-limit.ts`、`.env.example`、API 7 本、Webhook、退会 | §8・§9・§11 | 1〜43, 72〜74 |
| C: 画面層 | `/pricing` のデータ駆動化、`/account/billing`、`/account/billing/checkout`、設定画面の行、public-claims の更新 | §10 | 50〜51, 76〜79 (+ 手動 71) |

段 B は段 A のマージ後 (型の再生成済み) に始める。段 C は段 B のマージ後。

### 15.2 触るファイルの母集合 (閉じた一覧。これ以外を触ったら blocking)

新設:
- `supabase/migrations/<番号>_billing_core.sql`・`supabase/rollbacks/<番号>_billing_core.down.sql`
- `src/lib/billing/core.ts`・`stripe-gateway.ts`・`repository.ts`・`service.ts`・`http.ts`・`public-plans.ts`・`account-deletion.ts`
- `src/app/api/billing/checkout/route.ts`・`checkout/preview/route.ts`・`checkout/sync/route.ts`・`subscription/route.ts`・`subscription/cancel/route.ts`・`subscription/resume/route.ts`・`portal/route.ts`
- `src/app/api/webhooks/stripe/route.ts`
- `src/app/pricing/PricingPageView.tsx`・`src/app/(main)/account/billing/page.tsx`・`src/app/(main)/account/billing/checkout/page.tsx`・`src/components/billing/checkout-confirmation.tsx`
- テスト: `tests/billing-core.test.ts`・`tests/billing-stripe-gateway.test.ts`・`tests/billing-service.test.ts`・`tests/api/billing-routes.test.ts`・`tests/webhooks-stripe-route.test.ts`・`tests/billing-migration-contract.test.ts`・`tests/integration/rls/billing-apply-subscription-rpc.test.ts`・`tests/integration/rls/billing-webhook-events-claim-rpc.test.ts`・`tests/integration/security/billing-personal-subscriptions-rls.test.ts`・`src/__tests__/app/account/billing-pages.test.ts`・`src/__tests__/app/settings/billing-link.test.ts`

変更:
- `src/lib/webhook/verify.ts`・`src/__tests__/lib/webhook/verify.test.ts`
- `src/lib/env.ts`・`.env.example`
- `src/lib/rate-limit.ts`・`src/__tests__/lib/rate-limit.test.ts` (テスト 74)
- `src/lib/account-deletion.ts`・`tests/account-deletion.test.ts`
- `src/app/pricing/page.tsx`・`tests/public-claims-guard.test.ts`
- `src/app/(main)/settings/page.tsx` (行を 1 つ足す。テスト 79)
- `src/types/database.types.ts`・`packages/shared/src/database.types.ts` (再生成)
- `tests/integration/security/auth-users-fk-on-delete.test.ts` (期待の本数)
- `src/lib/account-export-tables.ts` (`personal_subscriptions` の `omit` に `stripe_status`・`stripe_synced_at` を足すだけ。§7.1)・`tests/account-export-tables.test.ts` (テスト 75)・`tests/integration/security/account-export-scope.test.ts` (「出力しない列」の一覧に 2 列を足す。§14.2)
- docs: `docs/design/billing/01-billing-core.md` (本書。設計ゲート PASS 後は実装中の小修正のみ)。他の設計書は §16.2 の行だけ (専権 PATCH)

### 15.3 新設一覧 (識別子)

| 種別 | 名前 |
|---|---|
| テーブル | `public.billing_customers` |
| 列 | `personal_subscriptions.stripe_synced_at` / `.stripe_status` / `.cancel_at_period_end` / `.billing_interval`、`stripe_webhook_events.processing_started_at` / `.attempt_count` |
| 制約 | `personal_subscriptions_billing_interval_check`、`personal_subscriptions_status_check` (置き換え: `incomplete` を追加) |
| トリガー | `personal_subscriptions_set_updated_at`、`billing_customers_set_updated_at` |
| RLS ポリシー | `personal_subscriptions_insert_admin`、`personal_subscriptions_update_admin`、`billing_customers_no_access` (削除: `personal_subscriptions_insert`、`personal_subscriptions_update`) |
| DB 関数 | `billing_claim_stripe_event(text, text, jsonb, interval)`、`billing_finish_stripe_event(text, boolean, text)`、`billing_apply_stripe_subscription(jsonb, timestamptz, text)` |
| status の値 | `incomplete` |
| 監査 action_type | §8.1 `BILLING_AUDIT_ACTIONS` の 8 つ |
| route | `POST /api/billing/checkout`、`GET /api/billing/checkout/preview`、`POST /api/billing/checkout/sync`、`GET /api/billing/subscription`、`POST /api/billing/subscription/cancel`、`POST /api/billing/subscription/resume`、`POST /api/billing/portal`、`POST /api/webhooks/stripe` |
| ページ | `/account/billing`、`/account/billing/checkout` |
| TS モジュール | `src/lib/billing/{core,stripe-gateway,repository,service,http,public-plans,account-deletion}.ts`、`src/app/pricing/PricingPageView.tsx`、`src/components/billing/checkout-confirmation.tsx` |
| TS の export (core) | §8.1 の `export` のとおり (数は §8.1 が正。ここに写して二重に数えない) |
| TS の export (verify) | `parseStripeSignatureHeader`、`verifyStripeSignature`、`verifyStripeWebhook`、`StripeSignatureHeader` |
| TS の export (ほか) | `createStripeGateway`、`createBillingRepository`、`BillingRpcError`、`previewCheckout`、`startCheckout`、`syncSubscription`、`syncCheckoutSession`、`getBillingSummary`、`createPortalSession`、`scheduleCancellation`、`revokeCancellation`、`handleStripeEvent`、`billingInvalidInputResponse`、`billingErrorResponse`、`listPurchasablePlans`、`defaultAccountDeletionBilling`、`AccountDeletionBilling` |
| 環境変数 | `STRIPE_WEBHOOK_SECRET` (一覧に追加。削除: `.env.example` の `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) |
| レート制限 | カテゴリ `billing` |
| 退会の段階 | `billing` |
| エラーコード | §13.1 の [NEW] 8 つ |
| 画面の定数 | `CHECKOUT_SYNC_RETRY_MS = 3000`、`CHECKOUT_SYNC_MAX_RETRIES = 10` (`/account/billing` の page に置く。根拠: Webhook の到着は通常 1〜5 秒、30 秒で諦めて「時間をおいて再読み込み」を出す) |
---

## 16. 追随表

### 16.1 既存の番兵 (契約テスト・走査テスト) の追随

grep の語 = 本冊が足す・変える名前。段 = §15.1。

| 番兵 | 反応する理由 (grep の語) | 直し方 | 段 |
|---|---|---|---|
| `tests/env-source-scan.test.ts` | `STRIPE_WEBHOOK_SECRET` を `getOptionalEnv` で読む (一覧に無い名前は型で通らない)・`.env.example` との突き合わせ | `SERVER_ENV_VARS` に足す (§8.7)。`.env.example` の行はそのまま。`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` の行を消す | B |
| `tests/check-env-script.test.ts` | 一覧の読み込み | 変更なし (一覧の追加で緑) | B |
| `tests/database-types-migrations-contract.test.ts` | `billing_customers`・`billing_claim_stripe_event`・`billing_finish_stripe_event`・`billing_apply_stripe_subscription` | 両方の `database.types.ts` を再生成する (冒頭の手順。270k / 256 で) | A |
| `tests/schema-checked-supabase.test.ts` / `tests/schema-checked-db.test.ts` | `.from('billing_customers')` | 型の再生成で緑 | A → B |
| `tests/api-raw-error-message-scan.test.ts` | `src/app/api/billing/**`・`src/app/api/webhooks/stripe` の本文 | 固定の文だけ (`billingErrorResponse`)。`err.message` を本文に入れない | B |
| `tests/lib-raw-error-message-scan.test.ts` | `src/lib/billing/*` の戻り値の `{ error: … }` | 結果のオブジェクトにエラーの `.message` を入れない (`StripeApiError.rawMessage` はログ専用) | B |
| `tests/api-internal-error-routes-stage2.test.ts` | 新 route は対象外 | 変更なし | B |
| `tests/role-check-source-scan.test.ts` | `src/app/api/billing/**` の handler | `requireUser` だけを使う。`roles` の手書き判定を書かない | B |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient` の import | `repository.ts` は `getSupabaseAdmin` だけ。`@supabase/supabase-js` を import しない | B |
| `tests/next15-async-request-api-scan.test.ts` | `createClient()`・`cookies()`・route の `params` | `await` を付ける。`pricing/page.tsx` は `await cookies()` | B・C |
| `tests/site-config-guard.test.ts` | `success_url` / `return_url` | `getSiteUrl()` から作る (ドメインを書かない) | B |
| `tests/email-send-throttle-contract.test.ts` | `@/lib/emails/send` | 核はメールを送らないので反応しない | — |
| `tests/public-claims-guard.test.ts` | `src/app/pricing/page.tsx` の描画・「準備中」 | `@/lib/billing/public-plans` をモック。0 件 → 準備中 (既存)、1 件 → 価格と CTA (新規)。禁止文字列の一覧から、載せてよくなった価格の表現を外す | C |
| `tests/account-deletion.test.ts`・`tests/account-deletion-email.test.ts`・`tests/account-delete-route.test.ts` | `AccountDeletionStep` に `billing`・`DeleteAccountParams.billing` | 偽の `billing` を渡す (既定は Stripe を呼ぶので、既存のテストには `{ cancelForAccountDeletion: async () => ({ cancelled_subscriptions: 0, customer: 'none' }) }` を渡す)。順序の期待に `billing` を足す | B |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` | `billing_customers_user_id_fkey` (SET NULL) | 検査 D の本数 (32 → 33) と、SET NULL の一覧に 1 行 | A |
| `tests/account-export-tables.test.ts` / `src/lib/account-export-tables.ts` | `personal_subscriptions` は `omit` 方式 (全列を取って `omit` を消す)。`loadSchemaModel` が migration から列を読むので、段 A の migration で `stripe_status`・`stripe_synced_at` が `SENSITIVE_NAME` (`stripe_`) の見張り「出力する列に、秘密・他人を指す列が残っていない」に当たる | `omit` に `stripe_status`・`stripe_synced_at` を足す (同じ段 A の PR)。`cancel_at_period_end`・`billing_interval` は書き出す (本人の契約の内容)。テスト 75 を足す。`STORED_FAILURE_COLUMN` の見張りには当たらない (どの新しい列も名前が `error` / `failure` / `result` でない) | A |
| `tests/rls-canonical-coupon-experiment-recipe-flags.test.ts` | 対象 3 表のみ | 変更なし | — |
| `tests/integration-ci-coverage.test.ts` | 新しい結合テストのパス | `tests/integration/rls/` と `tests/integration/security/` に置く (ワークフローの指定に当たる) | A |
| `tests/e2e-api-paths.test.ts` | e2e spec が叩くパス | 新しい spec を `SPEC_FILES` に足さない限り反応しない | — |
| `tests/cron-secret-contract.test.ts` | `/api/cron/*` | 核に cron は無い | — |
| `tests/edge-function-dep-pinning.test.ts` | `supabase/functions` | Edge Function を足さない | — |
| `tests/zod-single-copy-1444.test.ts` | 依存 | 依存を足さない (`stripe` を入れない) | — |
| `tests/admin-view-audit-1326.test.ts` | admin / super-admin の route の `admin_audit_logs` 直接 INSERT。請求書の詳細 (`/api/admin/finance/invoices/[id]`) の偽の `personal_subscriptions` (`{ user_id, plan_key }`) | `/api/billing/*` は対象外。`repository.recordAudit` は `src/lib`。請求書の詳細の route は変えない (§7.1) | — |
| `src/__tests__/lib/webhook/verify.test.ts` | `verifyStripeSignature` 等 | 17〜20 を足す | B |
| `src/__tests__/lib/feature-flags.test.ts` / `src/__tests__/api/feature-flags.test.ts` | `plan_key_cached` | 意味は変えない (空 = free)。変更なし | — |
| `tests/integration/rls/ai-usage-rpc.test.ts`・`ai-daily-limit-rpc.test.ts`・`coupon-apply-rpc.test.ts`・`tests/integration/security/plan-deprecate-subscribers.test.ts`・`account-export-scope.test.ts`・`tests/integration/operator/super-admin-plans-id.test.ts` | `personal_subscriptions` への INSERT/UPDATE | どれも service_role (`srAdmin` / `supabaseAdmin`) で書いているので RLS の変更に当たらない (origin/main で確認: `account-export-scope.test.ts:205` の `insert()` は `:67-68` の `srAdmin.from(table).insert(row)`)。`account-export-scope.test.ts:505-507` の「出力しない列」の一覧に `stripe_status`・`stripe_synced_at` を足す (§14.2) | A |
| `tests/integration/rls/subscription-plans-yearly-price-id.test.ts` | コメントだけ (契約の行を作らない) | 変更なし | — |
| `tests/account-export.test.ts` | 偽の DB の `personal_subscriptions` の行 (新しい列を持たない) と、`omit` の 4 列が出ないこと | 変更なし (`omit` を足しても、偽の行に無い列は結果を変えない) | — |
| `tests/admin-finance-exports-route.test.ts` | `subscriptions` の CSV の見出し 9 列・`created_at` の期間 | 変更なし (route の `select` は明示の 9 列のまま。§7.1) | — |
| `tests/admin-users-email.test.ts`・`tests/admin-pii-view-audit.test.ts` | `/api/admin/users/[id]` の session client の `personal_subscriptions` (偽の結果) | 変更なし (route を変えない。運営ロールの SELECT ポリシーは保つ) | — |
| `tests/plan-subscribers.test.ts`・`tests/helpers/fake-plan-subscribers-db.ts`・`tests/plan-deprecate-subscribers-route.test.ts`・`tests/plan-detail-page-deprecate.test.tsx` | live 5 値で数える・その件数の応答の形 | 変更なし (`incomplete` は数えない。§7.1) | — |
| `tests/price-impact-applies-to.test.ts` | `personal_subscriptions` に触らないことの見張り | 変更なし (route を変えない) | — |
| `tests/log-cleanup-dau-snapshot-contract.test.ts` | `/revenue_snapshots\|stripe\|personal_subscriptions\|…/` の不在を見るのは `20261010150000_schedule_log_cleanup_and_dau_snapshot.sql` の本文だけ。全 migration を走査するのは `cron.schedule` の名前だけ | 変更なし (本冊の migration は別ファイルで、`cron.schedule` を書かない) | — |

| `tests/account-deletion-migration-contract.test.ts` | #1175 の migration だけを見る | 変更なし | — |
| `tests/log-sanitizer.test.ts` | ロガーの配線 | 変更なし (`createLogger` を使う) | — |

### 16.2 他の文書への追随 (専権 PATCH。本冊の設計ゲート PASS 後、実装のマージと同じ PR か直後)

| 文書 | 箇所 | 直し方 | 期日 |
|---|---|---|---|
| `docs/design/cross/04-api-conventions.md` | §4.1 プレフィックス表 | `BILL_` (課金の自己サービス) 400/403/404/409/422 の行を足す | 段 B と同じ PR |
| 同 | §4.2 エラーコード一覧 | §13.1 の [NEW] 8 つ (`BILL_INVALID_INPUT` / `BILL_PLAN_NOT_PURCHASABLE` / `BILL_CUSTOMER_NOT_FOUND` / `BILL_NO_LIVE_SUBSCRIPTION` / `BILL_CANCEL_NOT_SCHEDULED` / `BILL_CHECKOUT_SESSION_MISMATCH` / `EXT_STRIPE_NOT_CONFIGURED` / `EXT_STRIPE_API_FAILED`) | 同上 |
| 同 | §10.1 の注と見本 | 「未実装なのは Stripe の側だけ」を消し、Stripe の形 (`t=`/`v1=`。秘密は文字列のまま鍵。503 = 秘密なし・401 = 不一致) を本冊 §8.3 へのリンクに置き換える。§10.2 の `processed_stripe_events` を `stripe_webhook_events` + `billing_claim_stripe_event` に直す。§16 の TODO 行を閉じる | 同上 |
| `docs/design/cross/02-rls-patterns.md` | §6.2 ロックキーの表 | `billing-user:{uuid}`・`stripe-subscription:{sub_id}` の 2 行を足す (「Stripe webhook 二重処理防止 `stripe:event_id`」は claim に置き換えたと注記) | 段 A と同じ PR |
| `docs/design/cross/08-legal-compliance.md` | §3.2 の見本・§9 の `handlePaymentFailed`・§10 | 見本の `/api/v1/webhooks/stripe` → `/api/webhooks/stripe`、`handlePaymentFailed` のメール送信は Stripe の顧客向けメール、`check_grace_period` の pg_cron は配線の冊、§10 は配線 | 段 B と同じ PR |
| 同 | §16.2 手順・§16.3 表「Stripe の顧客・サブスクリプション」・§18・§19 | 段階 `billing` を足す。表の現行実装を「実装済み (billing/01 §11)」に。§19 の TODO 行「退会時の Stripe …」を閉じる | 段 B と同じ PR |
| `docs/design/operator/05-stripe-integration.md` | §4 全体・§6.1・§8・§9・§12・§13・§15 | §4 を「受け口の正本は billing/01 §9.6・§4.1。`as any` の見本と失敗イベントの扱いは廃止」に置き換える。§6.1 に `billing_customers` を足す。§8 の reconcile は「写像を呼ぶ」に (§12)。§15 の API 版は本冊 `STRIPE_API_VERSION` を正に | 段 B と同じ PR |
| `docs/design/operator/04-plan-management.md` | §5.1 図・§5.2・§5.3 | 図に `incomplete` と「解約予約 (cancel_at_period_end)」を足す。§5.2 の SetupIntent + 日次ジョブを Checkout の `trial_period_days` に置き換える。§5.3 の「7 日後 cancelled」を「7 日後 grace・30 日後 cancelled」(05 §9 と同じ) に直す。§7 の `OP_TRIAL_ALREADY_USED` は「使わない (試用なしで購入できる)」と注記 | 段 B と同じ PR |
| `docs/design/operator/01-data-model.md` | §3.7 DDL・§3.18・§3.9.1・§4 ER 図 | 新しい列・`incomplete`・ポリシーの置き換え・`billing_customers`・`plan_key_cached` の同期元 (写像) を書く | 段 A と同じ PR |
| `docs/design/operator/08-cron-batches.md` | §3.1 `stripe_event_stuck_check` の行・§3.2 の課金系の行 | `stripe_event_stuck_check` は不要 (claim が代替) と注記。`grace_period_check` / `stripe_integrity_check` は本冊 §12 の契約で作ると注記 | 配線の冊と同時 |
| `docs/design/operator/CLAUDE.md` | 主要シーケンス「Stripe Webhook idempotency」 | claim 方式へ書き換え、`billing/01` へのリンク | 段 B と同じ PR |
| `docs/design/CLAUDE.md` | ドメイン構成の表 | `billing/` の行 (課金の核と配線) を足す | 段 A と同じ PR |
| `docs/design/family/01-data-model.md` ほか family | `family_groups.plan_key` / `member_limit` の書き手 | 「代表者の個人契約 (`plan_type='family'`) から billing/01 の写像が同期する」と注記。グループ作成時に代表者の live な家族プランを引き継ぐかは family の課題 (§18) | 段 A と同じ PR |
| `docs/design/mobile/01-architecture.md` | 課金 | §10.4 の規則 (アプリ内に購入導線を出さない) を 1 節足す | 段 C と同じ PR |
| `.env.example` | 84〜89 行 | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=` を消す。`STRIPE_SECRET_KEY` の説明に Checkout / Portal を足す | 段 B |
| `ENV_SETUP.md` (あれば) | Stripe の節 | §17 の手順への参照 | 段 B |

---

## 17. 本番の準備手順 (運用。秘密の値は #1113 のオーナー作業)

### 17.1 Stripe の Dashboard

1. **Products / Prices**: `pro`・`family_basic`・`family_pro` の Product を作り、`PATCH /api/super-admin/plans/[id]` で `stripe_product_id` を入れる → `POST /api/super-admin/plans/[id]/price-change` で月額・年額を同期する (既存の機構 F16。Edge Function の secrets にも `STRIPE_SECRET_KEY` が要る)。`subscription_plans.stripe_price_id` が入った時点で `/pricing` に出る (§10.1)。
2. **Webhook のエンドポイント**: `https://<サイトの URL>/api/webhooks/stripe`。API 版は `STRIPE_API_VERSION` (`2024-12-18.acacia`)。イベントは `STRIPE_SUBSCRIBED_EVENT_TYPES` の 12 種だけ。署名の秘密 (`whsec_…`) を `STRIPE_WEBHOOK_SECRET` に入れる。
3. **Customer portal** (Settings → Billing → Customer portal): 支払い方法の更新 ON・請求書の履歴 ON・解約 ON (期間末)・**プランの変更 OFF**・顧客情報の更新 (メール) OFF。
4. **Customer emails** (Settings → Emails): 支払い失敗 ON・試用終了前 ON・領収書 ON (核はアプリのメールを送らない。§5.2)。
5. **Subscriptions → Manage failed payments**: Smart Retries ON。すべての再試行が失敗したあとの扱いは「契約を past_due のままにする (キャンセルしない)」(grace → 30 日の解約は配線のジョブが行う。§12)。
6. **Checkout の設定**: 日本語・JPY。税の自動計算は使わない (表示は税込の固定額)。

### 17.2 Vercel / Supabase

- Vercel の環境変数: `STRIPE_SECRET_KEY` (`sk_live_…`)・`STRIPE_WEBHOOK_SECRET`。Preview / 開発は `sk_test_…` と test の Webhook (Stripe CLI の `stripe listen --forward-to localhost:3000/api/webhooks/stripe`)。
- migration の適用 (段 A のマージ後。追加だけ = index / 列 / 表 / 関数の新設と RLS の是正)。

### 17.3 受け入れの確認 (整合ゲートで読み取り)

- テストカード `4242 4242 4242 4242` で `pro` 月額を買い、`/account/billing` に `trialing` が出る。`personal_subscriptions` に 1 行・`billing_customers` に 1 行・`stripe_webhook_events` に `completed` が 2〜3 行・`admin_audit_logs` に `system.billing.subscription_created` が 1 行。
- 解約の予約 → `cancel_at_period_end=true`。取り消し → `false`。
- `stripe trigger invoice.payment_failed` → `past_due` と `system.payment.failed`。
- 退会 → Stripe の契約が `canceled`、顧客の氏名・メールが空、`billing_customers.anonymized_at` が入り `user_id` が NULL。

---

## 18. 未解決事項 (openQuestions)

| # | 項目 | 本冊の仮置き |
|---|---|---|
| 1 | `/pricing` に出す価格 (DB の `pro` 980 / 9,800 円など) と販売開始の時期は業務判断。Stripe の Price を `subscription_plans` に入れた時点で自動的に公開される | 価格は DB の値をそのまま出す。公開の合図 = `stripe_price_id` の登録 |
| 2 | App Store / Google Play の規約 (Web 課金への誘導の可否) の最新の文面と審査の判断は未確認 | アプリ内に購入導線・価格・誘導を出さない (§10.4) |
| 3 | 当社の `coupons` を Checkout でも使えるようにするか (Stripe の Coupon / Promotion Code との同期が要る) | Checkout は Stripe のプロモーションコードだけ。`coupons` は運営の遡及適用のまま |
| 4 | ブランドのメール (支払失敗・試用終了) を自前で送るか | Stripe の顧客向けメールに任せる (配線で足せる) |
| 5 | 家族グループを後から作った代表者に、live な家族プランを引き継ぐか (family ドメイン) | 写像は「いまある active なグループ」だけ同期する |
| 6 | `grace` で制限する有料機能の範囲 (05 §9 は AI 解析・家族共有・産業医) | 核は制限しない (`get_effective_plan` のまま)。配線の冊 |
| 7 | `stripe_webhook_events.payload` (個人情報を含む JSON) の保存期間 | 配線の掃除のジョブで決める |
| 8 | Checkout で住所の収集・税の自動計算 (インボイス制度の適格請求書) | 収集しない。請求書番号は配線の冊 |
| 9 | `account-export-scope.test.ts:205` の `insert()` がどの client か (本人なら RLS の変更で落ちる) | 解決済み: origin/main で service_role (`srAdmin`。同ファイル 67-68 行) と確認。替える必要は無い (§16.1) |
| 10 | 同時に 2 本の Checkout が完了したときの 2 本目 (`BILL_LIVE_ROW_CONFLICT`) を運営がどう処理するか | Finance 画面 (配線) に `failed` イベントを出し、運営が Stripe で解約・返金 |
| 11 | Billing Portal での解約の予約 / 取り消し (route を通らない) を `admin_audit_logs` に残すか | 残さない (写像は status の変化だけを監査する。記録は `stripe_webhook_events.payload` のイベント全体と Stripe の履歴。§7.3)。要るなら写像に「`cancel_at_period_end` が変わったら `system.billing.cancel_changed` を書く」を足す (`BILLING_AUDIT_ACTIONS` が 1 つ増える) |

---

## 改定履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-15 | 新設 (設計ゲート R1 の叩き台。4 相: 外形固定 §3 → 構想 §4 → 構造裁定 §5 → 仕上げ §6〜§17) |

