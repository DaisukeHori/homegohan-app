# billing/04 ストアの購読の定期の取り直し (reconcile) — 期限を過ぎたストアの行を RevenueCat から取り直して権利の表に写す

| | |
|---|---|
| 版 | v1.5 (2026-10-22) |
| Status | 設計ゲート審査中 (A 型。周 5 の網羅性の反映版) |
| Issue | #1912 (有料プランの販売を始める: 価格・有料と無料の線引き・アプリ内課金)。本冊はその配線の残りの冊のうち「日次の reconcile」(billing/03 §0.5 Q-11・§5.2 の縁の発生源 (2)・§18 の 4) に当たる。関連: billing/03 の整合ゲートの候補 (Webhook が落ちたまま期限を過ぎた購読が有料の権利を持ち続ける) |
| 範囲の正本 | Issue #1912 の本文。本冊の §0.4 に、前提とする Issue の記述を逐語で写す。本冊が決める範囲は §0.2 |
| 土台 | origin/main `0fb02e52` (#1931。billing/03 の段 D のマージ)。本冊の「現行」はこの版の事実 (§2.2) と、本番の読み取り (2026-10-22。§2.2 の F19)。2026-10-22 に origin/main `d950a7b1` (#1933) で再確認し、本冊が参照するファイル (`src/lib/billing/**`・`src/app/api/cron/**`・`supabase/migrations/**`・`vercel.json`・`src/lib/env.ts`・§14.1 の番兵) に差分は無い。§14.2 の行の番号は `d950a7b1` で取り直した (billing/03 §18 の 4 が `:5190` → `:5206` に動いていた)。続けて origin/main `c1ecc93b` (#1934) で再確認し、同じファイルと §14.2 の文書に差分は無い (#1934 が変えたのは運営の画面の AI の上限の 10 ファイルだけ)。さらに origin/main `7532a77c` (#1935) で再確認した。#1935 が変えたのは `apps/mobile` の 7 ファイルと billing/03 の §8.10 (モバイルの正典コード)・§10.6 (モバイルの購入の画面) だけで、本冊が参照するサーバのファイル・番兵・§12.3 が参照する結合テストと `vitest.integration.config.ts` に差分は無い。billing/03 の行は §8.10 の伸びで §18 の 4 が `:5206` → `:5250` に動いた (§14.2 を直した。`:86`・`:270`・`:380` は動いていない) |
| 前提の冊 | `docs/design/billing/03-paid-plans-and-iap.md` (親。RevenueCat の口 = §8.1 `iap-core.ts`・§8.3 `revenuecat-gateway.ts` / `iap-repository.ts`・§8.4 `iap-service.ts`・§6.4 の写像 `billing_apply_store_subscription`・§7.3 の状態遷移表)・`01-billing-core.md` (核。§12 の「reconcile は写像を呼んで直す」の型)・`02-manual-plan-grant.md` (手動付与の日次の失効 = pg_cron の先例)・`docs/design/operator/08-cron-batches.md`・`11-ops-batches-non-billing.md` (cron の台帳と失敗の監視)。本冊は親の契約 (写しの入口は `billing_apply_store_subscription` の 1 つ・`p_fetched_at` で単調・TS の入口は `syncStoreSubscriber`) を壊さず、その上に定期の処理を 1 本足す |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする |

---

## 0. 分冊判定・範囲・読み方・前提・確認事項

### 0.1 分冊判定 (相 1 で実施)

| 目安 | 本冊 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (正典コード・SQL・表 3 点・トレース・追随表を 1 冊に持つため) | 該当 |
| 消費先レーン 3 以上 | DB (候補の関数・印を書く関数・印の表・索引)・サーバ (cron の route と facade) の 2 | 非該当 |
| 共有面 2 つ以上 | `vercel.json` (Vercel Cron の一覧。4 冊の設計書と 3 本のテストが本数を見張る)・`src/lib/env.ts` の一覧・AI の入口の一覧 (`tests/helpers/ai-consent-enforced-paths.ts`)・定期実行の入口の一覧 (`tests/ai-usage-contract.test.ts`)・`personal_subscriptions` (索引を 1 本足すだけ。列は足さない)・利用者に紐づく表の分類 (`src/lib/account-export-tables.ts`・`tests/legal-text-1901.test.ts` の T-34・`auth.users` の外部キーの一覧。新しい表 `iap_reconcile_attempts` を 1 行ずつ足す) | 該当 |

判定: **設計は 1 冊 (本書)。実装は 2 段 (A: DB 層 / B: サーバ層。§13.1) に分け、段ごとに 2 枚レビューを挟む**。理由: 核 (DB の候補の関数) と配線 (cron の route) は、候補の関数の引数と戻り値 (§6.2) を挟んで表裏で、冊を分けると配線の冊が未マージの関数を参照する指摘を自分で作る。書き込みの経路は親の `billing_apply_store_subscription` と `syncStoreSubscriber` をそのまま使い、本冊は新しい写像を作らない (§5.3)。段 A は単独でマージできる (表 1 つ・関数 2 本・索引 1 本の新設と、その表の分類の 3 か所だけ。既存の行は変えない。段 A のテストは段 B のファイルを import しない)。

### 0.2 本冊の範囲と、対象外

| 本冊 | 対象外 (別の冊・別の Issue) |
|---|---|
| 期限 (`current_period_end`) を過ぎたままの live なストアの行 (`iap_store IS NOT NULL`) を、定期に RevenueCat から取り直して `personal_subscriptions` に写す処理 (Vercel Cron の route `GET /api/cron/iap-reconcile`。§8・§9) | Stripe (Web) の契約の reconcile (`stripe_integrity_check`。billing/01 §12・operator/08 §3.2 の未作成の行。本冊は触れない) |
| 候補の選び方 (status・期限・最後の同期の時刻) と順番 (最後に試した時刻の古い順。取り直せない利用者が後ろの利用者を止めない) を、読むだけの DB の関数 1 本 (`billing_iap_reconcile_candidates`)・試した利用者に回の終わりに時刻を書く関数 1 本 (`billing_iap_reconcile_mark_attempted`)・印の表 `iap_reconcile_attempts` で確定し (§6.2)、1 回の件数の上限と RevenueCat への間隔を定数と環境変数で持つ (§8.1) | 手動付与 (M 行) の失効 (billing/02 の `expire-manual-plan-grants`)・Webhook の受け口と同期の API と遅延の再同期そのもの (billing/03。本冊は変えない) |
| 鍵が無いときの止め方・RevenueCat の失敗 (回全体の失敗と、利用者 1 人の失敗を分ける)・率の制限 (429) のときの止め方と、失敗の監視 (既存の `app-log-alerts` の `cron_failure`) への乗せ方 (§8.3・§11) | 新しい運用アラートの種類 (取り直せない行の滞留の通知)。§16 の 3 |
| 期限の後も取り直せないときに有料を止める「猶予」の扱い (Q-2。推奨は「猶予を置かず、取り直せるまで権利を続ける」) | 権利の判定 (`get_effective_plan`・`consume_ai_usage_at`) の変更 (§5.1 の案 E で退ける) |
| 既存の番兵 (cron の本数・入口の一覧・環境変数の一覧) の追随 (§14) | 運営の画面 (Finance 画面での一覧) |

### 0.3 読み方

- §3 要件行列・§3.2 シナリオ → §4 構想とトレース → §5 構造裁定 → §6 以降が仕上げ (実装者は §6〜§14 だけ読めば手を止めない)。
- 正典の TS は §8 の ```ts ブロック。`import` が zod だけのブロック (§8.1 `iap-reconcile-core.ts`) は単独で型検査できる。1 行目に `// tsc:skip place=<パス>` / `insert=<パス>` の印があるブロックは、既存のモジュール (`@/lib/...`) を import するので単独の検査から外し、billing/01 §8.0 の手順 (印の付いたブロックを置き場所に置き、`npx tsc --noEmit` をリポジトリ全体に当てる) で検査する。印の無い `// tsc:skip` のブロックは説明用の断片だけ。SQL は §6。
- 既存の設計書との食い違いは本冊が正。親 (billing/03) の Q-11・§5.2 の縁の発生源 (2)・§18 の 4 の「日次の reconcile は配線の残りの冊」は、本冊が「毎時の取り直し (`GET /api/cron/iap-reconcile`)」として確定する (§14.2 で親に追随の行を書く)。
- main にマージ済みの事実 (billing/03 の実装 `src/lib/billing/iap-*.ts`・migration `20261021100000_billing_paid_plans_iap.sql`) が本冊の記述と食い違ったら、main が正で本冊が従う。

### 0.4 前提 (Issue #1912 の本文の逐語と、着手の前に origin/main で確かめた事実)

Issue #1912 の本文の「オーナーの選択」の表の行 (逐語): 「アプリ内課金 | RevenueCat を使う (App Store と Google Play の購入・更新・解約を 1 つの仕組みでまとめ、Web の Stripe と同じ権利の表に寄せる)」。本冊は、この「同じ権利の表に寄せる」が Webhook の再送が尽きたあとも保たれるように、定期の取り直しを足す。

着手の前に origin/main `0fb02e52` で確かめた問題 (事実。§2.2 の F 番号):

1. ストアの購読の状態は RevenueCat の Webhook で写る (F5)。再送は 5 回・約 80 分で止まる (billing/03 §2.3 P4・Q-11)。再送が尽きた更新・失効は、アプリの同期の API (F4) か `GET /api/billing/subscription` の遅延の再同期 (F3) が走るまで写らない。
2. 権利の判定 `get_effective_plan` は `status IN ('trialing','active','grace','past_due')` だけを見て `current_period_end` を見ない (F8)。`consume_ai_usage_at` はこれを呼ぶ (F8)。そのため、Webhook が落ちたまま期限を過ぎた購読は、利用者がアプリも課金の画面も開かない間、有料の上限と機能を持ち続ける。
3. 手動付与の期限切れの処理 (`billing_expire_manual_subscriptions`) は `iap_store IS NULL` の行だけを扱い、ストアの行を扱わない (F9)。
4. Stripe の reconcile (`stripe_integrity_check`) は設計だけで実装が無い (F17)。型として使えるのは billing/01 §12 の「写像を呼んで直す」の規則だけ。

### 0.5 発注者への確認事項 (Q-n。推奨つき。本冊は推奨の値で実装し、選択で変わる値は §8.1 の定数と `vercel.json` の予定だけ)

| # | 項目 | 推奨 | 根拠・代替案 |
|---|---|---|---|
| Q-1 | 取り直しの間隔 (Vercel Cron の予定) | **毎時 (`41 * * * *`)** | 親の Q-11 は「日次」と書いたが、期限を過ぎてから権利が止まるまでの窓は間隔そのもの (日次なら最長 24 時間、毎時なら最長 1 時間)。候補が 0 の回は DB の関数 1 回で終わり (RevenueCat は呼ばない)、Vercel Pro は毎分まで予定できる (§2.3 P2)。代替案: 日次 (`41 4 * * *` = JST 13:41) にすると `vercel.json` の 1 行と `IAP_RECONCILE_SCHEDULE_UTC`・`IAP_RECONCILE_CRON_INTERVAL_MINUTES` の 2 つの定数が変わるだけで、ほかは同じ。ただし 1 回に試せるのは予算 ÷ 間隔 = 40 人まで (§8.1 `IAP_RECONCILE_BATCH_SIZE_MAX`。環境変数 `IAP_RECONCILE_BATCH_SIZE` は 40 より上に上げられない。下げる向きだけ) なので、日次では 1 日に 40 人しか取り直せない。増やすには RevenueCat への間隔を詰める (§2.3 P1 の案内 (1 秒に 1 回) から外れる) か、予算と `maxDuration` を延ばす (定数の変更) ことになる |
| Q-2 | 取り直しも失敗し続けるとき、期限の後どれだけで有料を止めるか (猶予) | **猶予を置かない (取り直せるまで権利を続ける)。失敗は毎時の回ごとに 500 で失敗の監視 (運用メール) に乗せる** | 取り直せない原因は (a) 鍵の誤り・失効 (401) (b) RevenueCat の障害 (c) 当社の cron の停止 (d) その利用者だけの失敗 (応答の形が当社の Zod と合わない・写像の想定外の DB の失敗)、のどれかで、(d) はほかの利用者の取り直しを止めず (§4.1 の 5)、(a)(b)(d) は毎時の 500 が `app-log-alerts` の `cron_failure` (1 件から・抑止つき) で運用メールになる (§2.2 F15)。期限の後 N 日で `expired` に書く案 (代替案 1) は、`expired` の行は候補から外れる (§6.2 の述語) ので、RevenueCat が戻っても本人の同期か Webhook が来るまで戻らず、支払っている利用者を切ったまま戻せない。権利の判定に期限を見せる案 (代替案 2) は核の関数 (`get_effective_plan`) と `plan_key_cached` の読み手 (運営の画面・機能フラグ) の食い違いを生む (§5.1 の案 E)。代替案 1 を採るなら、強制で終わらせた行を候補に戻す印 (列) が要り、本冊の範囲を超える (§16 の 2) |
| Q-3 | 「期限が近い」行 (期限の前) も取り直すか | **取り直さない (期限を過ぎた行だけ)** | 期限の前に取り直しても、更新 (RENEWAL) はストアが期限の時点で決めるので、見えるのは「まだ更新されていない」姿だけで、権利は変わらない。期限の後の最初の回 (≤ 1 時間) で更新か失効が見える。代替案: 期限の 24 時間前から候補にする (`p_now + interval '24 hours'` を述語に足す) と、1 つの更新につき取り直しが 2 回になる |

---

## 1. 目的・スコープ

- 解決すること: Webhook の再送 (5 回・約 80 分) が尽きて写らなかったストアの購読の失効・更新を、本人の操作が無くても、期限の後 1 時間以内に `personal_subscriptions` に写し、権利 (`plan_key_cached`・`get_effective_plan`・家族グループのプラン) を正しくする。
- やり方: 既存の写しの入口 (`syncStoreSubscriber` → `billing_apply_store_subscription`) を、期限を過ぎた live なストアの行の利用者について、Vercel Cron の route から 1 人ずつ呼ぶ。候補は最後に試した時刻の古い順に選び (印の表 `iap_reconcile_attempts`。印を書くのは、その回に実際に取り直しを試した利用者だけ)、取り直せない利用者が毎回先頭に来て後ろの利用者を止めることを無くす。新しい写像・`personal_subscriptions` の新しい列・新しい状態は作らない。
- 対象外: §0.2。

## 2. 関連要件と現行の事実

### 2.1 関連要件・既存設計

| 文書 | 本冊との関係 |
|---|---|
| billing/03 §0.5 Q-11・§3.2 S12・§5.2 の縁の発生源 (2)・§18 の 4 | 「日次の reconcile は配線の残りの冊」。本冊がその冊。RevenueCat の全契約の列挙は API に無い (P5) ので、`personal_subscriptions` のストアの live 行を 1 人ずつ取り直す、と仮置きされている (§18 の 4)。本冊もその形 |
| billing/03 §8.4 `syncStoreSubscriber` / `lazyResyncStoreSubscription`・§8.1 `needsLazyResync` | 写しの入口と、遅延の再同期の判定 (期限を過ぎた行・5 分より古い取り直し)。本冊は入口をそのまま呼び、遅延の再同期は変えない (§7.2) |
| billing/03 §6.4 `billing_apply_store_subscription` | `p_fetched_at` で単調・advisory lock `billing-user:<uuid>` と `iap-subscription:<store>:<product>` で直列。Webhook・同期・遅延の再同期・本冊の取り直しが同時でも、新しい取り直しだけが写る (§4.2 S5・S6) |
| billing/03 §7.3 | ストアの行の状態遷移。本冊の取り直しは「取り直しの合図」の 1 つで、遷移先は取り直した姿 (`deriveStoreStatus`) で決まる (§7.3 (a)) |
| billing/03 §13.3・S15 | `BILL_LIVE_ROW_CONFLICT` (§13.3 の運営の処置の表)・`BILL_IAP_UNKNOWN_PRODUCT` (S15。運営が `plan_store_products` に行を足す) のときの運営の処置。本冊はこの 2 つだけを `rejected` に数えて飛ばし、次の回も試す (§8.3)。§13.3 のほかの写像の業務エラー (`BILL_UNKNOWN_PLAN` = 行の `plan_key` が `subscription_plans` から消えた・`BILL_UNKNOWN_IAP_STATUS` = TS の不具合) は親の扱いが失敗 (Webhook `failed`) なので、本冊でも `failed['internal']` (500) |
| billing/01 §12 | reconcile は写像を呼んで直す (自動修復 = 写像)。operator/08 §9 の「自動修復しない」は billing/01 が置き換えた。本冊も同じ型 |
| billing/02 §6.4 | 手動付与の日次の失効 (pg_cron の `CALL`)。SQL だけで済む処理の先例。本冊は RevenueCat を呼ぶので Vercel Cron (§5.1) |
| operator/08 §3.0・§3.2・§5・§6.2・§9、operator/11 §4 | cron の台帳と、失敗の監視 (`cron_failure`: Vercel Cron の route の 500 = `internalError` の行を 1 件から通知)。本冊の route はこの型に乗る |
| operator/12 §0.5・§8.2・§14、operator/10 §2.1 | Vercel Cron の本数 (いま 6 本) を書いた行。本冊で 7 本になる (§14.2) |
| cross/04 | エラーコードの体系。本冊は利用者向けのコードを足さない (cron の応答は固定の語。§11) |

### 2.2 現行の事実 (origin/main `0fb02e52` と本番の読み取り。2026-10-22)

| # | 事実 | 場所 |
|---|---|---|
| F1 | 遅延の再同期の判定 `needsLazyResync(row, nowMs)`: 行あり・`iap_store` あり・`current_period_end` ≤ now・`iap_synced_at` が null か `IAP_LAZY_RESYNC_MIN_INTERVAL_MS` (5 分) 以上前。期限の前の行は取り直さない | `src/lib/billing/iap-core.ts:43-44`・`:478-488` |
| F2 | `syncStoreSubscriber(deps, userId, source)`: `now` を GET の前に取る → `gateway.getSubscriber` → `listStoreProducts` → `selectStoreSubscriptions` → `listStoreSubscriptions` → 1 つでも `reject` なら何も書かず `BILL_IAP_UNKNOWN_PRODUCT` → 取り直しに無い live 行を `expired` の snapshot で終わらせる → 1 件ずつ `applyStoreSubscription({ snapshot, fetchedAt: now, source })`。戻り値 `StoreSyncOutcome { user_id, applied, stale, no_subscription, ended, skipped_unknown }`。`BILL_LIVE_ROW_CONFLICT` (`BillingRpcError`) はそのまま投げる。`deps` は `IapDeps { gateway, repository, now? }` | `src/lib/billing/iap-service.ts:28-33`・`:55-98` |
| F3 | `GET /api/billing/subscription`: `findLiveSubscription` → `needsLazyResync` → 鍵があれば `lazyResyncStoreSubscription` (`source = 'iap_lazy_resync'`。失敗は `logger.warn` で飲み込む)。`findLiveSubscription` は live (`LIVE_SUBSCRIPTION_STATUSES` = trialing / active / paused / past_due / grace) の行のうち `created_at` が新しい 1 件だけ | `src/app/api/billing/subscription/route.ts:27-40`・`src/lib/billing/iap-service.ts:128-140`・`src/lib/billing/repository.ts:73-84`・`src/lib/billing/core.ts:97` |
| F4 | `POST /api/billing/iap/sync`: `requireUser` → `checkRateLimit('billing')` (10 回 / 分) → `syncStoreSubscriber(deps, user.id, 'iap_sync')`。`BILL_LIVE_ROW_CONFLICT` は 409 `BILL_IAP_SYNC_CONFLICT` | `src/app/api/billing/iap/sync/route.ts:21-41`・`src/lib/rate-limit.ts:142` |
| F5 | `POST /api/webhooks/revenuecat`: 大きさ → 署名 → 外形 → 鍵 (無ければ 503) → claim (`billing_claim_revenuecat_event`。`completed` は 200 duplicate・`in_progress` は 409) → `handleRevenueCatEvent` (`source = 'revenuecat:<event.id>'`) → finish。処理の失敗は 500 で RevenueCat が再送する | `src/app/api/webhooks/revenuecat/route.ts:46-125` |
| F6 | RevenueCat の gateway: `GET https://api.revenuecat.com/v1/subscribers/{app_user_id}`・`Authorization: Bearer <REVENUECAT_SECRET_API_KEY>`・`AbortSignal.timeout(REVENUECAT_REQUEST_TIMEOUT_MS = 10_000)`。失敗はどれも `RevenueCatApiError({ status })` で、`status` は 3 通り: 時間切れ・接続の失敗は `null`、2xx 以外は応答の status、2xx でも応答が `RevenueCatCustomerInfoSchema` に合わない (形の違い) ときは応答の status (2xx) と `rawMessage: 'unexpected response shape'`。`RevenueCatCustomerInfoSchema` は `subscriptions` の全項目に `purchase_date`・`period_type` を求めるので、形の違いはその利用者の応答だけに起きうる。再試行と率の制限の扱いは無い。鍵が無ければ `createRevenueCatGateway` が `RevenueCatNotConfiguredError` | `src/lib/billing/revenuecat-gateway.ts:18-54` (形の違い `:45-49`)・`src/lib/billing/iap-core.ts:40`・`:146-166`・`:198-226` (`purchase_date` `:200`・`period_type` `:202`) |
| F7 | 写像 `billing_apply_store_subscription(p_snapshot, p_fetched_at, p_source)`: advisory lock 2 本 (`billing-user:<uuid>`・`iap-subscription:<store>:<product>`) → 既存の行の `iap_synced_at >= p_fetched_at` なら `skipped: 'stale'` → 別の live 行があれば `BILL_LIVE_ROW_CONFLICT` → upsert (UPDATE で `iap_synced_at = p_fetched_at`) → `family_groups` と `plan_key_cached` → 状態が変わったときだけ監査 (`details.source = p_source`)。`p_source` は NOT NULL の text で、値の検査は無い | `supabase/migrations/20261021100000_billing_paid_plans_iap.sql:211-381` (ロック `:255-256`・stale `:267`・衝突 `:287-297`・UPDATE `:334`・監査 `:363-372`) |
| F8 | 権利の判定 `get_effective_plan`: `personal_subscriptions` で `status IN ('trialing','active','grace','past_due')` の行の `plan_key` を返す。`current_period_end` は見ない。`consume_ai_usage_at` はこれで `ai_daily_limits`・`ai_plan_feature_caps` を引く | `supabase/migrations/20261010140000_ai_usage_foundation.sql:94-125`・`20261021100000_billing_paid_plans_iap.sql` (`consume_ai_usage_at` の `v_plan := public.get_effective_plan(p_user_id)`) |
| F9 | 手動付与の日次の失効: プロシージャ `billing_expire_manual_subscriptions` (pg_cron `expire-manual-plan-grants`・毎日 15:11 UTC) は `stripe_subscription_id IS NULL AND iap_store IS NULL` の live 行だけを `expired` にする (billing/03 §6.7 の置き換え)。ストアの行は扱わない | `supabase/migrations/20261021100000_billing_paid_plans_iap.sql` (§6.7 の 3 関数)・`20261017230000_billing_manual_plan_grant.sql:261-315` |
| F10 | ストアの行の一意性と列: `idx_personal_subscriptions_iap_product (user_id, iap_store, iap_product_id) WHERE iap_store IS NOT NULL`・`iap_synced_at timestamptz` (NULL 可)・ストアの行の status は trialing / active / past_due / cancelled / expired の 5 値、live は前の 3 つ (`LIVE_STORE_SUBSCRIPTION_STATUSES`)。核の CHECK (`personal_subscriptions_status_check`) は `incomplete`・`paused`・`grace` も許すが、ストアの行を書く唯一の入口の写像は 5 値以外を `BILL_UNKNOWN_IAP_STATUS` で拒む。`paused`・`grace` を書くのは Stripe の写像 (`stripe_subscription_id` の行) だけ | `20261021100000_billing_paid_plans_iap.sql:171-188`・`:250-251`・`src/lib/billing/iap-core.ts:265-267`・`20261016210000_billing_core.sql:39`・`:291-300` |
| F11 | Vercel Cron の既存の 6 本: `process-menu-queue` (`*/1`)・`app-log-alerts` (`*/15`)・`email-outbox` (`*/1`)・`push-outbox` (`*/1`)・`backup-freshness` (`37 5 * * *`)・`login-alerts` (`*/1`)。`/api/cron/stripe-reconcile` は無い | `vercel.json`・`git ls-tree origin/main src/app/api/cron/` |
| F12 | cron の認証: `requireCronAuth(req)` (`Authorization: Bearer <CRON_SECRET>`。`CRON_SECRET_PREVIOUS` も受理。未設定は 503 `cron_disabled`・不一致は 401)。`await` が必須。`tests/cron-secret-contract.test.ts` の CC-4 が `src/app/api/cron/**/route.ts` の全部を走査する | `src/lib/cron-auth.ts:29-52` |
| F13 | cron の route の型 (push-outbox): `runtime = 'nodejs'`・`dynamic = 'force-dynamic'`・`fetchCache = 'force-no-store'`・`maxDuration = 60`・`ROUTE_NAME = 'cron/push-outbox'`・`requireCronAuth` → `isMaintenanceFlagOn()` なら `{ status: 'maintenance' }` → 鍵が無ければ warn + `{ status: 'not_configured', … }` → 環境変数の値の解釈 (`resolvePushOutboxSettings`。範囲外は既定に戻し `ignored` を warn) → 本体 (予算 `PUSH_OUTBOX_RUN_BUDGET_MS = 40_000` で打ち切り) → `{ status: 'idle' \| 'processed', ...summary }`。例外は `internalError(ROUTE_NAME, err, { requestId })` で 500 | `src/app/api/cron/push-outbox/route.ts:33-109`・`src/lib/push/outbox.ts:19-28`・`:181-198` |
| F14 | cron の予定の定数と `vercel.json` の一致の型 (backup-freshness): `BACKUP_FRESHNESS_CRON_PATH`・`BACKUP_FRESHNESS_SCHEDULE_UTC` を `src/lib/backups/core.ts` に持ち、テスト O-1 が `vercel.json` の行と一致することを見る | `src/lib/backups/core.ts:29-31`・`src/__tests__/api/cron/backup-freshness.test.ts:659` |
| F15 | 失敗の監視: `GET /api/cron/app-log-alerts` (15 分おき) の `checkCronFailures` が、pg_cron の失敗と Vercel Cron の route の 500 (`internalError` が `app_logs` に書く `level = 'error'` の固定の文の行) を 1 件から数え、`OPS_ALERT_EMAIL` へ通知する (抑止 `OPS_ALERT_COOLDOWN_MINUTES`)。数えるのは `function_name` が `cron/%` か `% /api/cron/%` の行 | `src/app/api/cron/app-log-alerts/route.ts:456-520`・operator/11 §4・§2.1 |
| F16 | メンテナンス中: `isMaintenanceExemptPath` は `/api/cron` を通す (cron は動く)。push-outbox は自分で `isMaintenanceFlagOn()` を見て何もしない | `src/lib/maintenance-mode.ts:87-110`・`src/__tests__/lib/maintenance-mode.test.ts:111` (`/api/cronx` は止める = `/api/cron` は通す) |
| F17 | Stripe の reconcile: billing/01 §12 の契約 (`syncSubscription(…, 'wiring:reconcile')` を 1 件ずつ呼ぶ = 写像で直す) だけで、`src/app/api/cron/stripe-reconcile` は無い。operator/08 §9 は「不一致検出 → 自動修復しない」と書く (billing/01 §12 が置き換え済み) | `docs/design/billing/01-billing-core.md:3431`・`docs/design/operator/08-cron-batches.md:168`・`:651` |
| F18 | 環境変数の一覧: `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET` は `required: false`。値を読む場所が 1 つの変数は `readOnlyBy` を書き、`src/__tests__/lib/env.test.ts` の `sealed` の一覧 (`toEqual`) と `typeOnly` の `@ts-expect-error` に行を持つ。cron の route が `process.env.X` を名前で読む先例: `PUSH_OUTBOX_*` (`readOnlyBy: 'src/app/api/cron/push-outbox/route.ts'`) | `src/lib/env.ts:248-258`・`src/__tests__/lib/env.test.ts:419-470`・`:479-520` |
| F19 | 本番 (2026-10-22 の読み取り): `personal_subscriptions` に `iap_store IS NOT NULL` の行は 0 件 (販売開始前)。`cron.job` は 20 本 (migration の 14 本 + ベースラインの `catalog-import-*` 5 本 + `handson-tour-sandbox-cleanup`) | Supabase の読み取り (SELECT のみ) |
| F20 | 本冊の新しい route・環境変数・migration に反応する既存の番兵 (行と直し方は §14.1): `tests/ai-usage-contract.test.ts:312-333` (`CRON_ENTRYPOINTS`。`vercel.json` の crons の全数を `toEqual`)・`tests/ai-consent-enforcement.test.ts:226-232` と `tests/helpers/ai-consent-enforced-paths.ts:207`・`:305-317` (`EXEMPT_ROUTES`。`@/lib/env` に届く route)・`tests/cron-failure-monitoring-contract.test.ts:236`・`:281` (it 名の「6 本」と既知の 6 本)・`tests/design-doc-vercel-cron-count.test.ts` (設計書 4 冊 + テスト 1 本の「6 本」の文 9 か所を `vercel.json` の数と突き合わせる)・`tests/env-setup-cron-secret-crons.test.ts` (`ENV_SETUP.md:94` の `CRON_SECRET` の行の path の集合)・`tests/log-cleanup-dau-snapshot-contract.test.ts:313-325` (operator/08 §3.0・§3.2 の注記・§5 の注記)・`tests/database-types-migrations-contract.test.ts` (migration の関数が両方の `database.types.ts` にある)・新しい表 `iap_reconcile_attempts` の分類 3 か所 (F24) | 各ファイル |
| F21 | `src/lib/billing/iap-service.ts` は `revenuecat-gateway`・`iap-repository`・`@/lib/env` を import しない (route が作って deps で渡す)。`iap-core.ts` は zod だけを import し `tests/billing-iap-core.test.ts` が見張る。本冊の新しいモジュールも同じ規則 (§8.0) | `src/lib/billing/iap-service.ts:1-3`・`iap-core.ts:1-5`・`tests/billing-iap-core.test.ts:64-74` |
| F22 | `tests/billing-iap-service.test.ts` の偽物は `IapRepository` の型で作る (`makeRepository(overrides: Partial<IapRepository>)`)。`IapRepository` にメソッドを足すと偽物が赤になる。本冊は `IapRepository` を変えず、候補の読み取りは別のポート (`IapReconcileRepository`。§8.1) にする | `tests/billing-iap-service.test.ts:75-94` |
| F23 | `createIapRepository().applyStoreSubscription` は、写像の P0001 のうち `BILL_UNKNOWN_PLAN`・`BILL_UNKNOWN_IAP_STATUS`・`BILL_LIVE_ROW_CONFLICT` だけを `BillingRpcError` にし、それ以外の `PostgrestError` (その利用者の snapshot に固有の制約違反など) はそのまま投げる。`listStoreProducts`・`listStoreSubscriptions` の失敗も `PostgrestError` をそのまま投げる | `src/lib/billing/iap-repository.ts:55-67`・`:29`・`:38` |
| F24 | 利用者に紐づく表の分類: `user_id` (auth.users 参照) を持つ表は `src/lib/account-export-tables.ts` の `ACCOUNT_EXPORT_TABLES` か `ACCOUNT_EXPORT_EXCLUDED` (理由つき) に入れる (`tests/account-export-tables.test.ts:275`)。その集合は `tests/legal-text-1901.test.ts` の T-34 で `PRIVACY_DATA_TABLES` (プライバシーポリシー第 3 条の行) と `PRIVACY_DATA_EXCLUDED` の和と一致する (`:867-891`)。`auth.users` を指す外部キーは `tests/integration/security/auth-users-fk-on-delete.test.ts:123` の `EXPECTED_ACTIONS` と過不足なく一致する。先例: billing/01 の `billing_customers` (3 か所すべてに行) | 各ファイル |

### 2.3 一次情報 (RevenueCat・Vercel。2026-10-22 取得)

| # | 事実 | 出どころ |
|---|---|---|
| P1 | RevenueCat の REST v1 の率の制限は公式の数値が無い。RevenueCat のスタッフの回答 (2024-08-15): v2 は負荷で変わるがおよそ 60 回 / 分、v1 は「v2 より少し緩い」変動の制限で、**v1 は 1 秒に 1 回程度を勧める**。超えると 429 で、「止めて再試行」を勧める。v1 の応答に残りの枠のヘッダーは無い | RevenueCat Community「What are the current rate limits on the REST API」(community.revenuecat.com/general-questions-7/…-4946)。公式の API v1 のページ (revenuecat.com/docs/api-v1) には率の記述が無い |
| P2 | Vercel Cron: どのプランも 1 プロジェクト 100 本まで。Pro は最小の間隔 1 分・分の精度。Hobby は 1 日 1 回まで (`0 * * * *` はデプロイで失敗) で、時刻の精度は時間 (±59 分)。cron は Functions として動き、Functions の制限 (実行時間) が当たる | vercel.com/docs/cron-jobs/usage-and-pricing (last_updated 2026-07-15)。当社は `*/1` の cron を 4 本持つので Pro (F11) |
| P3 | RevenueCat の Webhook の再送は約 2.5 / 5 / 10 / 20 / 40 分で最大 5 回・約 80 分で止まる | billing/03 §2.3 P4 (本冊で再確認はしない) |

---

## 3. 相 1 外形固定

### 3.1 要件行列

| ID | 要件 | 出どころ | 本冊の答え |
|---|---|---|---|
| R1 | 期限を過ぎた live なストアの行を、本人の操作が無くても定期に RevenueCat から取り直して写す | #1912 (§0.4 の 1・2)・billing/03 Q-11 | Vercel Cron `GET /api/cron/iap-reconcile` (毎時 41 分) が候補の利用者を 1 人ずつ `syncStoreSubscriber(deps, userId, 'iap_reconcile')` で取り直す (§8.3・§9) |
| R2 | 定期の処理の置き場は既存の cron の型に合わせる | §0.4 | RevenueCat を呼ぶ TS の処理なので Vercel Cron (push-outbox・login-alerts と同じ型。§5.1)。認証は `requireCronAuth`、ログは `createLogger('cron/iap-reconcile')`、500 は `internalError` (失敗の監視に乗る。F15) |
| R3 | 対象の選び方 (status・期限・最後の同期の時刻) を確定する | §0.4 | 読むだけの DB の関数 `billing_iap_reconcile_candidates(p_now, p_recheck_after, p_limit)` (§6.2): `iap_store IS NOT NULL` ∧ `status IN ('trialing','active','past_due')` ∧ `current_period_end <= p_now` ∧ (`iap_synced_at IS NULL` ∨ `iap_synced_at < current_period_end` ∨ `iap_synced_at <= p_now - p_recheck_after`)。利用者ごとに 1 行、最後に試した時刻 (`iap_reconcile_attempts.attempted_at`。無ければ先頭) の古い順 → `current_period_end` の早い順、`p_limit` 件。回の終わりに、その回に `syncStoreSubscriber` を呼んだ利用者だけの `attempted_at` を回の開始の時刻にする (`billing_iap_reconcile_mark_attempted`。1 回の RPC)。試した利用者は次の回で後ろに回り、選んだのに試さなかった利用者 (予算・429・回全体の失敗の後ろ) は印が進まず先に来る |
| R4 | 1 回の件数の上限と RevenueCat の率の制限 | §0.4・P1 | 1 回 `IAP_RECONCILE_BATCH_SIZE` (既定 40 人 = 1 回に試せる上限 = 予算 ÷ 間隔。環境変数 `IAP_RECONCILE_BATCH_SIZE` で 1〜40 に下げられる)・取り直しの開始の間隔 `IAP_RECONCILE_REQUEST_INTERVAL_MS` (1 秒)・予算 `IAP_RECONCILE_RUN_BUDGET_MS` (40 秒) で打ち切り・429 はその回を止めて次の回 (§8.1・§8.3) |
| R5 | 取り直した結果の写し方は Webhook・同期と同じ関数を通し、書き込みの経路を 1 つにする | §0.4・billing/03 §0 | TS は `syncStoreSubscriber` (billing/03 §8.4)、DB は `billing_apply_store_subscription` (§6.4) だけ。本冊は新しい写像を作らない。`p_source = 'iap_reconcile'` で監査の `details.source` に残る |
| R6 | 同時に Webhook (同期・遅延の再同期) が来たときの順序 | §0.4 | 写像の advisory lock (`billing-user:<uuid>`) で直列、`p_fetched_at` (GET の前の時刻) の新しい方だけが写り、古い方は `stale` (F7)。取り直しの回が並行しても同じ (§4.2 S5・S6・S14) |
| R7 | 鍵が未設定のときに安全に止まる | §0.4 | `createRevenueCatGateway()` が投げる `RevenueCatNotConfiguredError` を受けて、DB に触れず 200 `{ status: 'not_configured' }` + warn 1 行 (push-outbox の R-12 と同じ型)。鍵の誤り (401 / 403) は失敗として 500 (§11) |
| R8 | 取り直しも失敗したときの猶予 | §0.4 | 猶予を置かない (Q-2)。回全体の失敗 (RevenueCat に届かない・401 / 403・5xx) はその回を止めて 500、利用者 1 人の失敗 (応答の形の違い・そのほかの 4xx・写像などの想定外の失敗) は数えて次の利用者へ進み、最後に 500 (§8.3)。どちらも失敗の監視に乗る。候補は残り、次の回 (1 時間後) に再び取り直す (試した利用者は後ろに回り、試さなかった利用者が先に来る) |
| R9 | ログ・失敗時の運営アラートは既存の型 | §0.4 | ログは `app_logs` (`createLogger`)。500 は `internalError` の固定の文 → `app-log-alerts` の `cron_failure` (F15)。新しいアラートの種類は足さない (§16 の 3) |
| R10 | Stripe の側は触れない | §0.4 | 候補の述語は `iap_store IS NOT NULL`。Stripe の行 (`stripe_subscription_id`) と手動付与の行は本冊の処理に入らない |
| R11 | 新しい状態・権利の表の列・利用者向けのエラーコードを作らない | billing/03 §7.3 (遷移表に無い遷移は作らない) | 遷移は billing/03 §7.3 の「取り直しの合図」の行のとおり。本冊が足す DB のものは、印の表 1 つ (`iap_reconcile_attempts`。利用者 ID と最後に試した時刻だけ。権利の判定は読まない)・関数 2 本 (候補を読む・印を書く)・索引 1 本 (§6)。利用者向けの API は無い |
| R12 | migration の番号はマージ時に確定・`.down.sql` を対で | 設計の規約 | §6.1 |
| R13 | as any 禁止・マジックナンバー禁止・運用で変えうる値は環境変数で上書き | 設計の規約 | §8.1 の定数に根拠。上限と再確認の間隔は `IAP_RECONCILE_BATCH_SIZE`・`IAP_RECONCILE_RECHECK_HOURS` で上書き (範囲外は既定に戻して warn) |
| R14 | 監査ログ必須 | `docs/design/CLAUDE.md` | 状態の変化は写像が `admin_audit_logs` に書く (`system.billing.subscription_status_changed`・`details.source = 'iap_reconcile'`)。回の要約はログ (個人の情報を載せない) |
| R15 | 既存の番兵の追随と、共有面の台帳 | 設計の規約 | §14 |
| R16 | メンテナンス中は書かない | push-outbox の R-14 (operator/11) | `isMaintenanceFlagOn()` なら `{ status: 'maintenance' }` で何もしない (§8.4) |
| R17 | 本番の書き込み・外部の設定の変更はしない (設計) | #1912 の守ること | 本冊は読み取りだけ。環境変数の設定の手順は §15 |

### 3.2 ユーザーシナリオ (18 本)

| ID | シナリオ |
|---|---|
| S1 | 失効が届かない: App Store の購読 (個人 Pro) の自動更新を切った利用者の期限が来て、RevenueCat の `EXPIRATION` が当社の 500 (障害) で 5 回とも届かなかった。本人はアプリも Web も開かない。期限の次の毎時の回が取り直し、行は `expired`、`plan_key_cached` は NULL、AI の上限は無料の 3 回、究極モードの錠がかかる。期限から権利が止まるまで最長 1 時間 |
| S2 | 更新が届かない: 更新 (`RENEWAL`) が届かないまま期限を過ぎた (実はストアで更新済み)。取り直しで `current_period_end` が次の期限に進み、状態は `active` のまま (監査なし)。利用者は何も気づかない |
| S3 | ストアの猶予期間: 請求の失敗 (`BILLING_ISSUE`) で `past_due` の行が期限を過ぎた。取り直しは `grace_period_expires_date` が先なので `past_due` のまま (権利は続く。billing/03 P13)。行は期限を過ぎた live のままなので、6 時間ごと (`IAP_RECONCILE_RECHECK_HOURS`) に取り直し、猶予が尽きた取り直しで `expired` |
| S4 | 期限の直前に本人が同期した: 期限の 10 分前にアプリの「プランとお支払い」を開いて同期 (`iap_synced_at` が新しい) → 期限を過ぎた最初の回で取り直す (`iap_synced_at < current_period_end` = 期限の後の姿をまだ見ていない)。遅延の再同期の 5 分の規則とは独立 |
| S5 | 遅延の再同期と同時: 本人が Web の `/account/billing` を開き `GET /api/billing/subscription` の遅延の再同期が走るのと同じ分に、毎時の回も同じ利用者を取り直す。写像の advisory lock で直列になり、`p_fetched_at` の古い方は `stale`。結果は同じ姿 |
| S6 | Webhook と同時: 取り直しの GET の直後に `RENEWAL` の Webhook が届いて先に写した。本冊の `p_fetched_at` の方が古いので `stale` (何も壊さない)。逆の順なら Webhook の方が `stale` |
| S7 | 鍵が無い (販売開始前・本番に `REVENUECAT_SECRET_API_KEY` を入れる前): 回は DB に触れず 200 `{ status: 'not_configured' }`、warn ログ 1 行 (変数名はログにだけ)。失敗の監視には乗らない |
| S8 | RevenueCat が落ちている・鍵が無効 (401): 1 人目の取り直しが `RevenueCatApiError` (`status` が `null` / 401 / 403 / 5xx = 回全体の失敗) → その回を止めて 500 → `app_logs` の error → `app-log-alerts` の `cron_failure` が運用メール。次の回 (1 時間後) に再び取り直す。候補の行はそのまま (権利は続く。Q-2) |
| S9 | 429 (率の制限): 途中の利用者で 429 → その回を止めて 200 `{ status: 'processed', stopped_early: 'rate_limited', … }` (warn)。残りは次の回 (試さなかった残りは印が進まないので、次の回で先に選ばれる)。失敗の監視には乗らない |
| S10 | 候補が上限を超える: Webhook が丸 1 日止まり、期限を過ぎた行が 120 人分ある。回ごとに、まだ試していない利用者を `current_period_end` の古い順に 40 人 (1 秒に 1 人) 取り直し、`stopped_early: null` で 40 人、残り 80 人は次の 2 回で終わる。回の予算 (40 秒) を超えたら `stopped_early: 'budget'` |
| S11 | 運営の処置が要る行: 別の live 行 (Stripe) がある利用者 (billing/03 S13) と、`plan_store_products` に無い商品の利用者 (S15) が候補にいる。それぞれ `BILL_LIVE_ROW_CONFLICT`・`BILL_IAP_UNKNOWN_PRODUCT` で写せないので、warn (利用者 ID とコード) を残して飛ばし、次の利用者へ。候補に残るので毎回の回で試み (試した利用者は次の回で後ろに回る)、運営の処置 (billing/03 §13.3・S15) で解消する。`rejected` はこの 2 つのコードだけ (`IAP_RECONCILE_REJECTED_CODES`) |
| S12 | メンテナンス中: `maintenance_mode` のフラグが ON の回は 200 `{ status: 'maintenance' }` で何もしない (DB に書かない) |
| S13 | 対象外の行: 手動付与 (M 行)・Stripe (S 行)・`expired` / `cancelled` のストアの行・期限 (`current_period_end`) が NULL のストアの行・期限の前の行は候補に出ない |
| S14 | 回の二重 (手動の再実行と毎時の回が重なった): 候補を選ぶ関数は何も書かないので、2 つの回は同じ利用者を選びうる。各利用者の写像は advisory lock で直列になり、後の方は `stale` か同じ姿で、結果は変わらない。RevenueCat への回数は最大で 2 倍になる (1 秒に 1 回の間隔はそれぞれが守る。合わせて超えて 429 になった回は 200 で止まる)。印は新しい方の時刻が残る (`GREATEST`) |
| S15 | 退会: 候補の利用者が取り直しの最中に退会した。行は CASCADE で消え (印の表の行も)、写像は `skipped: 'user_deleted'` を返し、`StoreSyncOutcome` は何も数えない (`synced` には数える)。次の回の候補には出ない |
| S16 | 利用者 1 人だけ取り直せない: 候補の先頭の利用者 A の RevenueCat の応答が当社の Zod に合わない (形の違い。2xx) か、A の写像が運営の処置の 2 つ (S11) 以外の失敗 (`BILL_UNKNOWN_PLAN`・`BILL_UNKNOWN_IAP_STATUS`・P0001 以外の DB の失敗) になる。A を `failed` に数えて warn (利用者 ID と種類) を残し、後ろの B〜E は取り直して写す。回の終わりに 500 (失敗の監視の運用メール)。次の回は B〜E が候補から外れ、A だけが残る (直すのは当社のコードかデータ。§15 の 4) |
| S17 | 取り直せない利用者が上限より多い: 写せない利用者 (S11・S16) が 50 人たまり、ほかに期限を過ぎた利用者 C が 1 人いる。回 1 は 50 人のうち 40 人を試す。回 2 はまだ試していない 10 人と C を先に選ぶ (試した 40 人は後ろ)。C は遅くとも 2 回目で取り直される |
| S18 | 選んだ利用者を 1 回で試しきれない: 候補 40 人 (どれも試したことが無い) のうち期限の古い 30 人が写せない利用者 (S11) で、RevenueCat の GET と写像の往復に 1 人あたり 2 秒かかり、約 20 人を試したところで予算 (40 秒) を超えて止まった (`stopped_early: 'budget'`)。回の終わりに、試した約 20 人にだけ印を書く。選んだのに試さなかった約 20 人 (失効が届かなかった S1 の利用者を含む) は印が進まないので、次の回はこの約 20 人が試した利用者より先に選ばれ、取り直される。429 (S9)・回全体の失敗 (S8) で止めた回も同じ (止めた利用者までが試した利用者) |

---

## 4. 相 2 構想

### 4.1 構造 (発明相の結論)

```
Vercel Cron (毎時 41 分)
  └ GET /api/cron/iap-reconcile ── requireCronAuth ── isMaintenanceFlagOn ── createRevenueCatGateway (無ければ not_configured)
        └ reconcileStoreSubscriptions(deps, settings)            ← 本冊の facade (src/lib/billing/iap-reconcile-service.ts)
              ├ reconcileRepository.listReconcileCandidates()    ← DB 関数 billing_iap_reconcile_candidates (候補の規則と順番の唯一の置き場。読むだけ)
              ├ 利用者ごとに (1 秒に 1 人・予算 40 秒・上限 40 人)
              │     syncStoreSubscriber(deps, userId, 'iap_reconcile')   ← billing/03 §8.4 (写しの唯一の TS の入口。変えない)
              │           └ gateway.getSubscriber → billing_apply_store_subscription (billing/03 §6.4。変えない)
              └ reconcileRepository.markReconcileAttempted()     ← DB 関数 billing_iap_reconcile_mark_attempted (試した利用者だけに印。回の終わりに 1 回)
```

1. **候補の規則と順番は DB の関数 1 本に置く** (`billing_iap_reconcile_candidates`。読むだけ)。列と列の比較 (`iap_synced_at < current_period_end`) は PostgREST のフィルタで書けず、TS で絞ると `LIMIT` の後の絞り込みになって、絞られた行の裏で待つ行が永久に取り直されない。SQL なら 1 文で「利用者ごとに 1 行・順番・上限」まで閉じる。順番は「最後に試した時刻の古い順 (試したことが無い利用者が先) → 期限の古い順」。時刻の印 (`iap_reconcile_attempts`) は、facade がループの後に、その回に `syncStoreSubscriber` を呼んだ利用者の ID だけを 1 回の RPC (`billing_iap_reconcile_mark_attempted`) で書く。写せない利用者 (S11)・取り直せない利用者 (S16) は `iap_synced_at` が進まず候補に残り続けるが、試すたびに後ろへ回るので、後ろの利用者を止めない (S17)。選んだのに予算・429・回全体の失敗で試さなかった利用者は印が進まず、次の回で試した利用者より先に来る (S18)。
2. **書き込みは親の入口をそのまま使う**。本冊は `syncStoreSubscriber` を `source = 'iap_reconcile'` で呼ぶだけで、snapshot も写像も作らない。順序・冪等・同時の規則は親の `p_fetched_at` と advisory lock がそのまま効く (R5・R6)。
3. **候補の述語**: `iap_store IS NOT NULL` ∧ live (trialing / active / past_due) ∧ `current_period_end <= p_now` ∧ (`iap_synced_at IS NULL` ∨ `iap_synced_at < current_period_end` ∨ `iap_synced_at <= p_now - p_recheck_after`)。読み方: 「期限の後の姿をまだ取り直していない行」(2 つ目) は何度でも候補、「期限の後に取り直しても live のままの行」(ストアの猶予期間) は `p_recheck_after` (6 時間) ごとに候補。取り直して `expired` / `cancelled` になれば live でなくなって候補から外れ、更新されていれば `current_period_end` が進んで外れる。取り直せた利用者は候補から外れ、取り直せない利用者は残るが試すたびに後ろに回る (1 の順番)。
4. **率と予算**: 1 回の処理は利用者を 1 人ずつ直列に、取り直しの開始の間隔を 1 秒空け (P1 の案内)、予算 40 秒で打ち切る (`maxDuration` 60 秒の中に最後の取り直しの時間切れ 10 秒 + RPC + 応答が収まる)。上限は既定 40 人 (= 40 秒 ÷ 1 秒 = 1 回に試せる上限。環境変数は下げる向きだけ)。429 はその回を止める (止めて再試行 = 次の回)。
5. **失敗の扱い** (§8.1 `classifyReconcileFailure`): 鍵が無い = 止まる (200 `not_configured`)。運営の処置が要る利用者 (`BillingRpcError` の `BILL_LIVE_ROW_CONFLICT`・`IapError` の `BILL_IAP_UNKNOWN_PRODUCT`。billing/03 §13.3・S15 で運営の処置が決まっている 2 つだけ = `IAP_RECONCILE_REJECTED_CODES`) = `rejected` に数えて次へ (warn。200)。**回全体の失敗** (RevenueCat に届かない `status: null`・401 / 403・5xx) = `failed` に数えてその回を止め、500。**利用者 1 人の失敗** (RevenueCat の応答の形の違い (2xx)・そのほかの 4xx・`RevenueCatApiError` 以外 (写像の `BILL_UNKNOWN_PLAN`・`BILL_UNKNOWN_IAP_STATUS` (billing/03 §13.3 の扱いは失敗)・P0001 以外の `PostgrestError` など)) = `failed` に数えて次の利用者へ進み、回の終わりに 500。500 はどちらも失敗の監視に乗る (R9)。候補を選ぶ RPC の失敗は、誰も取り直していないのでそのまま投げて 500。
6. **新しいものは最小**: DB の印の表 1 つ・関数 2 本 (候補を読む・印を書く)・部分索引 1 本、TS のモジュール 3 本 (純・repository・facade) と route 1 本、環境変数 2 つ、`vercel.json` の 1 行。`personal_subscriptions` の列・状態・利用者向けのエラーコード・監査の action_type は足さない。

```mermaid
sequenceDiagram
  participant V as Vercel Cron (毎時 41 分)
  participant R as GET /api/cron/iap-reconcile
  participant S as reconcileStoreSubscriptions
  participant DB as Supabase (service_role)
  participant RC as RevenueCat REST v1
  V->>R: Authorization: Bearer CRON_SECRET
  R->>R: requireCronAuth (401 / 503) → isMaintenanceFlagOn (maintenance) → createRevenueCatGateway (not_configured)
  R->>S: deps { gateway, repository, reconcileRepository }, settings { batchSize, recheckHours }
  S->>DB: billing_iap_reconcile_candidates(p_now, '6 hours', 40)
  DB-->>S: [{ user_id, period_end, synced_at }] (最後に試した時刻の古い順 → 期限の古い順・利用者ごとに 1 行。何も書かない)
  loop 候補ごと (1 秒に 1 人・予算 40 秒)
    S->>RC: GET /v1/subscribers/{user_id} (syncStoreSubscriber の中)
    RC-->>S: customer info
    S->>DB: billing_apply_store_subscription(snapshot, p_fetched_at, 'iap_reconcile') × 行
    DB-->>S: applied / stale / user_deleted (衝突は BILL_LIVE_ROW_CONFLICT)
  end
  S->>DB: billing_iap_reconcile_mark_attempted(試した利用者の ID, p_now) (1 人以上試したときだけ)
  S-->>R: IapReconcileSummary (failed が 0) / IapReconcileFailedError (failed が 1 以上)
  R-->>V: 200 { status: idle | processed, ...summary } / 500 (internalError → app-log-alerts の cron_failure)
```

### 4.2 シナリオのトレース (上の構造で手で走らせたもの)

| ID | トレース |
|---|---|
| S1 | 期限 T に `EXPIRATION` が届かない → 行は `active`・`current_period_end = T`・`iap_synced_at` = 購入時の取り直し (< T) → T の次の 41 分の回: `billing_iap_reconcile_candidates` の述語 (`current_period_end <= p_now` ∧ `iap_synced_at < current_period_end`) に当たり、返される → `syncStoreSubscriber(deps, user, 'iap_reconcile')`: GET → `deriveStoreStatus` が `expires_date ≤ now`・猶予なし → `expired` の snapshot → 写像の UPDATE (`status = 'expired'`・`iap_synced_at = p_fetched_at`) → `plan_key_cached` の再計算 (live 行が無く NULL)・家族グループは個人 Pro なので変わらない・監査 `system.billing.subscription_status_changed` (`from: 'active', to: 'expired', source: 'iap_reconcile'`) → 要約 `applied: 1` → 回の終わりに `billing_iap_reconcile_mark_attempted` がこの利用者の `attempted_at = p_now` を書く → 以後 `get_effective_plan` は free → `consume_ai_usage_at` の上限 3 回・究極モードは `plan_locked`。窓は T から次の回まで ≤ 60 分 + 回の中の順番 |
| S2 | `RENEWAL` が届かない → T の次の回で候補 → GET の `expires_date` は T + 1 か月 → `deriveStoreStatus` = `active` → 写像の UPDATE (`current_period_end` が進む・`status` は同じなので監査なし) → `applied: 1`。次の回は `current_period_end > p_now` なので候補に出ない |
| S3 | `BILLING_ISSUE` → `past_due` (billing/03 §7.3)。期限 T を過ぎた最初の回: 候補 (2 つ目の条件) → GET: `expires_date ≤ now` かつ `grace_period_expires_date > now` → `past_due` のまま → UPDATE (`iap_synced_at = now`。状態は同じで監査なし) → 次の回: `iap_synced_at > current_period_end` なので 2 つ目は偽、3 つ目 (`iap_synced_at <= p_now - 6 時間`) も偽 → 候補に出ない → 6 時間後の回で候補 → 猶予が尽きたあとの回の取り直しで `expired` (billing/03 §7.3 の `EXPIRATION` の行と同じ遷移) |
| S4 | T − 10 分の同期で `iap_synced_at = T − 10 分` → T の次の回: `iap_synced_at < current_period_end` → 候補 → 取り直し (S1 か S2 の姿) |
| S5 | 同じ分に、遅延の再同期 (`p_fetched_at = t1`) と本冊の回 (`p_fetched_at = t2`) が同じ利用者を取り直す → 写像は `billing-user:<uuid>` の advisory lock で直列 → 先に入った方が UPDATE し `iap_synced_at` を自分の `p_fetched_at` に → 後の方は `iap_synced_at >= p_fetched_at` なら `stale`、そうでなければ同じ姿で UPDATE (監査は状態が変わったときだけ) → どちらの順でも最終の行は新しい方の姿。本冊の要約は `applied` か `stale` |
| S6 | 本冊の GET が t2 に始まり、`RENEWAL` の Webhook が t3 (> t2) に GET して先に写した → 本冊の写像は `iap_synced_at (= t3) >= p_fetched_at (= t2)` で `stale` → `stale: 1`。逆の順なら Webhook が `stale` (Webhook は 200 で終わる) |
| S7 | `createRevenueCatGateway()` が `RevenueCatNotConfiguredError` → route は `logger.warn('REVENUECAT_SECRET_API_KEY が未設定のため、ストアの購読の取り直しを行いません')` → 200 `{ status: 'not_configured' }`。`reconcileRepository` も作らず DB に触れない。500 ではないので `cron_failure` に乗らない |
| S8 | 1 人目の `gateway.getSubscriber` が `RevenueCatApiError({ status: 401 })` (鍵の誤り) か `{ status: null }` (届かない) → `classifyReconcileFailure` = `run`・種類 `revenuecat_unauthorized` / `revenuecat_unreachable` → `failed[種類] = 1`・`stopped_early = 'revenuecat_unavailable'` → ループを抜け、warn (要約) を残して `IapReconcileFailedError` を投げる → route の `internalError('cron/iap-reconcile', err, { requestId, summary })` → `app_logs` に `level = 'error'`・固定の文 → 15 分おきの `app-log-alerts` の `checkCronFailures` が `cron/iap-reconcile` を 1 件から数え、運用メール → 次の回で再試行 (候補は残る。印を書くのは試した 1 人目だけなので、選んだのに試さなかった 2 人目から後ろは次の回で 1 人目より先に選ばれる。1 人目の GET だけが毎回時間切れになる場合も、1 人目は後ろに回るので回が毎回同じ利用者で止まらない) |
| S9 | k 人目で `RevenueCatApiError({ status: 429 })` → `classifyReconcileFailure` = `rate_limited` → `summary.stopped_early = 'rate_limited'` → ループを抜けて要約を返す (warn) → 200 `{ status: 'processed', synced: k − 1, stopped_early: 'rate_limited', … }`。回の終わりの印は 1〜k 人目だけ (k 人目は `syncStoreSubscriber` を呼んだので試した利用者)。k + 1 人目から後ろは印が進まず、次の回で 1〜k 人目より先に選ばれる |
| S10 | 候補 120 人 (どれも試したことが無い) → `p_limit = 40` で期限の古い 40 人 (関数は何も書かない) → 1 人ずつ: 間隔 1 秒 (前の取り直しの開始から 1 秒未満なら `sleep`) → 40 人で約 40 秒 → 予算を超えたら残りを置いて `stopped_early: 'budget'` (超えなければ `null`) → 回の終わりに試した利用者に印 → 次の回はまだ試していない利用者 (80 人。予算で止めた回なら、選んで試さなかった利用者もここに入る) のうち期限の古い 40 人。3 回 (3 時間) で全員 |
| S11 | 候補 A (Stripe の live 行あり) → `syncStoreSubscriber` の写像が `BILL_LIVE_ROW_CONFLICT` (`BillingRpcError`) → `rejected['BILL_LIVE_ROW_CONFLICT'] += 1`・warn (`user_id`・`code`) → 次の候補 B (対応の無い live な商品) → `syncStoreSubscriber` が書く前に `IapError('BILL_IAP_UNKNOWN_PRODUCT')` → `rejected['BILL_IAP_UNKNOWN_PRODUCT'] += 1` → 次へ。回は 200 (`rejected` は失敗の監視に乗せない。billing/03 §13.3・S15 の運営の処置の対象)。A・B は `iap_synced_at` が進まないので次の回も候補 (毎時 warn 1 行ずつ。順番は後ろ)。運営が billing/03 §13.3 の処置をすると、次の回で写る |
| S12 | `isMaintenanceFlagOn()` が true → 200 `{ status: 'maintenance' }`。gateway も候補も作らない |
| S13 | 述語: M 行・S 行は `iap_store IS NULL` で外れる。`expired` / `cancelled` は `status IN (...)` で外れる。`current_period_end IS NULL` は `IS NOT NULL` で外れる。期限の前は `<= p_now` で外れる |
| S14 | 回 X (開始 t1) と回 Y (開始 t2 > t1) が、どちらも印を書く前に候補を選ぶ → 候補の関数は読むだけなので、同じ順番の同じ利用者を選ぶ → 各利用者の写像は advisory lock (`billing-user:<uuid>`) で直列、後の方は `stale` か同じ姿 → 行は同じ。RevenueCat への回数は最大で 2 倍 (各回は 1 秒に 1 回を守る。合わせた率で 429 になった回は `stopped_early: 'rate_limited'` の 200) → 回の終わりに X と Y がそれぞれ試した利用者に印を書く → 同じ利用者の印は `GREATEST` で t2 が残る (どちらが先に書いても同じ) |
| S15 | 取り直しの GET の間に退会 → 行は `auth.users` の CASCADE で消える (`personal_subscriptions` も `iap_reconcile_attempts` も) → 写像は `auth.users` に無いので `{ applied: false, skipped: 'user_deleted' }` → `StoreSyncOutcome` は `applied` も `stale` も増えない → 要約は `synced + 1` だけ → 回の終わりの印の関数は `auth.users` に無い利用者を飛ばす (外部キーの違反にしない) → 次の回は行が無いので候補に出ない |
| S16 | 候補 A・B・C (A が先頭) → A の `getSubscriber` が `RevenueCatApiError({ status: 200, rawMessage: 'unexpected response shape' })` → `classifyReconcileFailure` = `user`・種類 `revenuecat_unexpected_response` → `failed['revenuecat_unexpected_response'] = 1`・warn (`user_id`・`kind`) → B・C は取り直して写す (`synced: 2`) → ループの後、`failed` が 1 以上なので warn (要約) を残して `IapReconcileFailedError` を投げる → 500 → `cron_failure`。A の写像が `BillingRpcError` (`BILL_UNKNOWN_PLAN` / `BILL_UNKNOWN_IAP_STATUS`。`IAP_RECONCILE_REJECTED_CODES` に無い) か `PostgrestError` (P0001 の業務コード以外) でも、種類が `internal` (warn の `error_name`・`error_code` に例外の名前とコード) になるだけで同じ。次の回: B・C は候補から外れ、A だけが選ばれて同じ失敗 → 直すまで毎時 500 (運用メールは `OPS_ALERT_COOLDOWN_MINUTES` で抑止) |
| S17 | 写せない利用者 50 人 (`attempted_at` が NULL) と利用者 C (NULL・期限は 50 人より新しい) → 回 1: 期限の古い 40 人を選び、40 人とも試して `rejected` か `failed` → 回の終わりに 40 人の `attempted_at = 回 1` → 回 2: NULL の 11 人 (残り 10 人と C) が先、続けて回 1 の 40 人から 29 人 → C を取り直して写す。以後は回ごとに「試した時刻の古い 40 人」が回る |
| S18 | 候補 40 人 (NULL・期限の古い 30 人が写せない利用者・残り 10 人に S1 の利用者 D) → 回 1: 40 人を選ぶ → 1 人 2 秒で 1〜20 人目を試し、21 人目の前で `isReconcileBudgetExhausted` が真 → `stopped_early: 'budget'` → 回の終わりに `billing_iap_reconcile_mark_attempted([1〜20 人目], 回 1)` → 回 2: 印の無い 20 人 (写せない 10 人と D を含む 10 人) が先 (期限の古い順)、続けて回 1 の 20 人 → 20 人を試したところで予算 → D は回 2 で取り直されて `expired` (期限から ≤ 2 時間) → 回 3 からは試した時刻の古い順に回る |

---

## 5. 相 3 構造裁定 (1 回だけ)

### 5.1 代替案の比較

| 案 | 構造 | 利点 | 欠点 | 裁定 |
|---|---|---|---|---|
| A (採用) | Vercel Cron の route → 本冊の facade → 親の `syncStoreSubscriber` → 親の写像。候補は DB の関数 | 書き込みの経路が親の 1 本のまま (R5)。TS の gateway・snapshot・`selectStoreSubscriptions` をそのまま使う。cron の認証・ログ・失敗の監視が既存の型に乗る (R2・R9)。実装は印の表 1 つ + 関数 2 本 + TS 4 ファイル | `vercel.json` の本数を見張る番兵 (4 冊 + 3 本) の追随が要る (§14)。Vercel の Functions の実行時間 (60 秒) の中で 1 回の件数が決まる (1 時間に 40 人) | 採用 |
| B | pg_cron → Edge Function (Deno) が RevenueCat を呼んで写像を呼ぶ | 当社の cron の数は増えない。pg_cron の失敗の監視に乗る | RevenueCat の取り直し (gateway・Zod・`selectStoreSubscriptions`・`projectStoreSubscription`) を Deno に写す = 書き込みの経路が 2 つになり、親の契約 (`iap-core.ts` の純関数が唯一) を破る。Vault の秘密と `verify_jwt = false` の設定も要る | 退ける (R5 に反する) |
| C | pg_cron → pg_net → Vercel の route を HTTP で呼ぶ | 時刻は DB が決める | pg_net から Vercel の route を呼ぶ先例が無く、`CRON_SECRET` を Vault にも置くことになる (ENV_SETUP の 3 か所の規則が 4 か所に)。得るものが無い | 退ける |
| D | 既存の `app-log-alerts` (15 分おき) の回に取り直しを相乗りさせる | cron を足さない | 運用アラートの route が課金の書き込みを持つ (関心の混在)。`app-log-alerts` の 500 が課金の失敗か通知の失敗か分からなくなる | 退ける |
| E | 権利の判定 (`get_effective_plan`) にストアの行の `current_period_end` を見せ、期限 + 猶予で権利を止める (取り直しはしない) | RevenueCat を呼ばない | 更新 (`RENEWAL`) が届かなかった支払い済みの利用者を止めてしまう。`plan_key_cached` (運営の画面・機能フラグの読み手) と判定が食い違う。核の関数の変更 = 共有面。親が「権利判定は変えない」(billing/03 R8) と決めている | 退ける (Q-2 の代替案 2 として記録) |

### 5.2 「縁の発生源を消すより単純な構造は無いか」

- 候補の規則を TS と SQL の 2 か所に持たない: TS に `needsStoreReconcile` のような純関数を作ると、SQL と二重になり、`LIMIT` の前後の違いで答えがずれる。規則は SQL の 1 か所 (§6.2) に置き、TS は結果を Zod で読むだけ (§8.1)。
- 「期限が近い」行を入れない (Q-3): 入れると 1 つの更新に取り直しが 2 回になり、述語に先読みの幅という新しい定数が増える。期限の後だけなら、取り直せた利用者は候補から外れる (期限が進むか live でなくなる)。
- 強制の失効 (猶予 N 日で `expired` に書く) を入れない (Q-2): 入れると「取り直さずに書いた行」を候補に戻す印 (列) が要り、親の写像に「取り直した姿でない snapshot」を通すことになる。入れなければ、本冊が書くのは親の写像が取り直した姿だけ。
- `IapRepository` を広げない (F22): 候補の読み取りは別のポート `IapReconcileRepository` にし、親のポートと偽物を変えない。
- 回の中の並列を入れない: 直列 + 1 秒の間隔で率の制限 (P1) を守り、429 と予算は「止めて次の回」の 1 規則で受ける。
- 取り直せない利用者が先頭に居座る縁 (S16・S17・S18) は、失敗の種類を分けるだけでは消えない (写せない利用者が上限の 40 人以上たまると、毎回その 40 人で枠が尽きる)。発生源 = 「順番が期限だけで決まり、試しても順番が変わらない」を消すため、試した利用者に試した時刻を書き、順番をその時刻の古い順にする (印の表 `iap_reconcile_attempts`。§6.2)。印を書くのは「試した」利用者 (その回に `syncStoreSubscriber` を呼んだ利用者) だけで、書く時点は回の終わり (facade がループの後に試した利用者の ID の配列で 1 回の RPC)。候補を選ぶ関数は読むだけにする (2 つの回が重なっても、印は `GREATEST` で新しい方の時刻が残るだけ。S14)。退けた代わり: (i) `personal_subscriptions` に列を足す = 親の写像の外から権利の表に書く経路ができる (R5 の「書き込みの経路を 1 つ」を崩す)。(ii) 時刻ごとに並びを混ぜる (hash の回転) = 状態は要らないが、取り直される時期が確率でしか決まらず、テストで確かめられない。(iii) 失敗の利用者を TS で後ろに回す = 回をまたいで覚える場所が無い。(iv) 選んだ時点で印を書く (v1.1〜v1.2 の形) = 1 回に試せる数を超えて選んだ回 (遅い応答・429・回全体の失敗) で、試さなかった利用者まで同じ時刻で後ろに回り、その中の並びが期限の順に戻るので、期限の古い同じ利用者が毎回先に試され、後ろが永久に試されない (S18)。(v) 1 回に選ぶ数を試せる数 (予算 ÷ 間隔) に切り詰めるだけ = 遅い応答 (1 人 1 秒を超える) の回を防げない (切り詰めは印の書き方と併せて行う。§8.1 `IAP_RECONCILE_BATCH_SIZE_MAX`)。(vi) 試すたびに利用者ごとの RPC で書く = RPC が倍になる (回の終わりの 1 回で足りる。予算で `maxDuration` の前に止まるので、回の終わりに届かないことは起きない想定。§16 の 9)。
- 失敗を回全体と利用者 1 人に分ける (S8・S16): 回全体の失敗で止めないと 40 人ぶん同じ失敗を繰り返し (時間切れなら 4 人で予算が尽きる)、利用者 1 人の失敗で止めると後ろが取り直されない。分け方は `RevenueCatApiError.status` だけで決める純関数 1 つ (§8.1 `classifyReconcileFailure`)。

### 5.3 確定した構造

- 置き場: `src/lib/billing/iap-reconcile-core.ts` (純。定数・Zod・型・ポート・失敗の分け方)・`iap-reconcile-repository.ts` (RPC)・`iap-reconcile-service.ts` (facade)・`src/app/api/cron/iap-reconcile/route.ts`。DB は印の表 `iap_reconcile_attempts`・候補を読む関数 `billing_iap_reconcile_candidates`・印を書く関数 `billing_iap_reconcile_mark_attempted`・部分索引 `idx_personal_subscriptions_iap_reconcile`。
- 補正 (v1.1。設計ゲート R1 の指摘による): 叩き台 (v1.0) の構造は「候補を期限の順に読むだけの関数」と「429 以外の失敗で回を止める」だったが、利用者 1 人の失敗で後ろの全員が永久に取り直されない欠陥があり、上の 2 つ (順番の印・失敗の分け方) を足した。書き込みの経路・cron の置き場・候補の述語は変えていない。
- 補正 (v1.3。設計ゲート R3 の指摘による): v1.1 の印は「選んだとき」に書いていたため、1 回に試せる数を超えて選んだ回で、試さなかった利用者が永久に試されない欠陥が残った (S18)。印を書く時点を「回の終わりに、試した利用者だけ」に移し (`billing_iap_reconcile_mark_attempted`)、候補の関数を読むだけ (`billing_iap_reconcile_candidates`。v1.0 の名前に戻す) にした。あわせて環境変数 `IAP_RECONCILE_BATCH_SIZE` の上限を 1 回に試せる数 (40) にした。書き込みの経路・cron の置き場・候補の述語・順番の規則は変えていない。
- 変えないもの: `iap-core.ts`・`iap-service.ts`・`revenuecat-gateway.ts`・`iap-repository.ts`・`billing_apply_store_subscription`・`get_effective_plan`・遅延の再同期・同期の API・Webhook。
- 以後の蒸し返しを禁じる: 仕上げ (§6〜§14) の中で構造の疑義が出たら、blocking ではなく「裁定への差し戻し事由」として別に扱う。

---

## 6. データモデル (migration)

### 6.1 ファイル

| ファイル | 内容 |
|---|---|
| `supabase/migrations/<番号はマージ時に確定>_billing_iap_reconcile.sql` | 印の表 1 つ・部分索引 1 本・関数 2 本 (§6.2)。番号はマージ直前に origin/main の `supabase/migrations` の最大 (2026-10-22 時点 `20261021110000_org_plan_ai_daily_limits.sql`) より大きい値で確定する。1 行目は `-- migration: <ファイル名>`、最初の文は `SET LOCAL lock_timeout = '10s';` (billing/03 段 A と同じ) |
| `supabase/rollbacks/<番号>_billing_iap_reconcile.down.sql` | §6.3。1 行目は `-- rollback: <ファイル名>` |

migration は `cron.schedule` を呼ばない (Vercel Cron は `vercel.json`。§8.5)。既存の表の列・CHECK・ポリシー・トリガーの変更と、既存の行の UPDATE / DELETE は無い。`CREATE OR REPLACE` する既存の関数も無い。

### 6.2 印の表 `iap_reconcile_attempts`・候補を読む関数 `billing_iap_reconcile_candidates`・印を書く関数 `billing_iap_reconcile_mark_attempted`・索引

```sql
-- migration: <番号はマージ時に確定>_billing_iap_reconcile.sql
-- billing/04 (Issue #1912 の配線の残りの冊): ストアの購読の定期の取り直しの候補を読む関数と、試した時刻の印の表と、印を書く関数と、索引。
-- 候補 = live (trialing / active / past_due) なストアの行 (iap_store IS NOT NULL) のうち、期限 (current_period_end) を過ぎていて、
--        期限の後の姿をまだ取り直していない (iap_synced_at が NULL か期限より前) か、取り直しても live のまま p_recheck_after より古いもの。
-- 利用者ごとに 1 行 (取り直しは利用者単位。billing/03 §8.4 syncStoreSubscriber)。順番は最後に試した時刻 (無ければ先頭) の古い順 → 期限の早い順、p_limit 件。
-- 候補を読む関数は何も書かない。印 (attempted_at) は、その回に実際に取り直しを試した利用者だけに、回の終わりに印を書く関数で書く
-- (取り直せない利用者が毎回先頭に来て後ろを止めないため。選んだのに試さなかった利用者は印が進まず、次の回で先に選ばれる)。
-- personal_subscriptions には書かない (写しの入口は billing_apply_store_subscription の 1 つだけ。billing/03 §6.4)。
-- 呼ぶのは GET /api/cron/iap-reconcile (service_role) だけ。
SET LOCAL lock_timeout = '10s';

-- (1) 取り直しを試した時刻の印 (利用者ごとに 1 行。候補の順番を回すためだけに使い、権利の判定は読まない)
CREATE TABLE IF NOT EXISTS public.iap_reconcile_attempts (
  user_id      uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL
);
COMMENT ON TABLE public.iap_reconcile_attempts IS
  'billing/04 §6.2: ストアの購読の定期の取り直しで、利用者に最後に取り直しを試した時刻 (候補の順番を回す印)。書くのは billing_iap_reconcile_mark_attempted だけ。service_role は読むだけ';
ALTER TABLE public.iap_reconcile_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iap_reconcile_attempts_no_access ON public.iap_reconcile_attempts;
CREATE POLICY iap_reconcile_attempts_no_access ON public.iap_reconcile_attempts USING (false) WITH CHECK (false);
REVOKE ALL ON public.iap_reconcile_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.iap_reconcile_attempts TO service_role;

-- (2) 候補を選ぶ部分索引 (live なストアの行だけ。期限の順に読む)
CREATE INDEX IF NOT EXISTS idx_personal_subscriptions_iap_reconcile
  ON public.personal_subscriptions (current_period_end)
  WHERE iap_store IS NOT NULL AND status IN ('trialing', 'active', 'past_due');
COMMENT ON INDEX public.idx_personal_subscriptions_iap_reconcile IS
  'billing/04 §6.2: 定期の取り直しの候補 (live なストアの行を current_period_end の順に読む)';

-- (3) 候補を読む関数。何も書かないので STABLE。SECURITY DEFINER で service_role だけが呼ぶ
CREATE OR REPLACE FUNCTION public.billing_iap_reconcile_candidates(
  p_now           timestamptz,
  p_recheck_after interval,
  p_limit         integer
) RETURNS TABLE (user_id uuid, period_end timestamptz, synced_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  -- 1 回の呼び出しで扱う利用者の数の安全の上限 (誤った引数で大量の行を返さない)。TS の IAP_RECONCILE_BATCH_SIZE_MAX (40。billing/04 §8.1) はこれ以下
  -- (tests/billing-iap-reconcile-core.test.ts のテスト 10 が migration の文面を読んで見る。段 B)
  c_max_users CONSTANT integer := 200;
BEGIN
  IF p_now IS NULL OR p_recheck_after IS NULL OR p_limit IS NULL THEN
    RAISE EXCEPTION 'billing_iap_reconcile_candidates: p_now / p_recheck_after / p_limit are required' USING ERRCODE = '22023';
  END IF;
  IF p_recheck_after <= interval '0' THEN
    RAISE EXCEPTION 'billing_iap_reconcile_candidates: p_recheck_after must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > c_max_users THEN
    RAISE EXCEPTION 'billing_iap_reconcile_candidates: p_limit must be between 1 and %', c_max_users USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT DISTINCT ON (s.user_id)
             s.user_id            AS due_user_id,
             s.current_period_end AS due_period_end,
             s.iap_synced_at      AS due_synced_at
        FROM public.personal_subscriptions AS s
       WHERE s.iap_store IS NOT NULL
         AND s.status IN ('trialing', 'active', 'past_due')
         AND s.current_period_end IS NOT NULL
         AND s.current_period_end <= p_now
         AND (s.iap_synced_at IS NULL
              OR s.iap_synced_at < s.current_period_end
              OR s.iap_synced_at <= p_now - p_recheck_after)
       ORDER BY s.user_id, s.current_period_end
    )
    SELECT d.due_user_id, d.due_period_end, d.due_synced_at
      FROM due AS d
      LEFT JOIN public.iap_reconcile_attempts AS a ON a.user_id = d.due_user_id
     ORDER BY a.attempted_at ASC NULLS FIRST, d.due_period_end, d.due_user_id
     LIMIT p_limit;
END
$$;
REVOKE ALL ON FUNCTION public.billing_iap_reconcile_candidates(timestamptz, interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_iap_reconcile_candidates(timestamptz, interval, integer) TO service_role;
COMMENT ON FUNCTION public.billing_iap_reconcile_candidates(timestamptz, interval, integer) IS
  'billing/04 §6.2: 定期の取り直しの候補 (期限を過ぎた live なストアの行の利用者。期限の後の姿をまだ取り直していないか、取り直しても live のまま p_recheck_after より古い)。利用者ごとに 1 行・最後に試した時刻の古い順 (無ければ先頭) → 期限の早い順・p_limit 件。何も書かない。service_role だけ';

-- (4) 印を書く関数。その回に取り直しを試した利用者の ID を、回の終わりに 1 回で渡す。SECURITY DEFINER で service_role だけが呼ぶ
CREATE OR REPLACE FUNCTION public.billing_iap_reconcile_mark_attempted(
  p_user_ids     uuid[],
  p_attempted_at timestamptz
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 1 回の呼び出しで扱う利用者の数の安全の上限 (候補を読む関数の c_max_users と同じ値。TS の IAP_RECONCILE_BATCH_SIZE_MAX はこれ以下。テスト 10)
  c_max_users CONSTANT integer := 200;
BEGIN
  IF p_user_ids IS NULL OR p_attempted_at IS NULL THEN
    RAISE EXCEPTION 'billing_iap_reconcile_mark_attempted: p_user_ids / p_attempted_at are required' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_user_ids) > c_max_users THEN
    RAISE EXCEPTION 'billing_iap_reconcile_mark_attempted: p_user_ids must have at most % ids', c_max_users USING ERRCODE = '22023';
  END IF;
  -- auth.users にある利用者だけを書く (取り直しの最中に退会した利用者は外部キーの違反にせず飛ばす。billing/04 S15)。
  -- 同じ ID が配列に 2 度あっても auth.users の 1 行で 1 回だけ書く。既にある印は新しい方の時刻を残す (2 つの回が重なったとき。S14)
  INSERT INTO public.iap_reconcile_attempts AS t (user_id, attempted_at)
  SELECT u.id, p_attempted_at
    FROM auth.users AS u
   WHERE u.id = ANY (p_user_ids)
  ON CONFLICT ON CONSTRAINT iap_reconcile_attempts_pkey
  DO UPDATE SET attempted_at = GREATEST(t.attempted_at, EXCLUDED.attempted_at);
END
$$;
REVOKE ALL ON FUNCTION public.billing_iap_reconcile_mark_attempted(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_iap_reconcile_mark_attempted(uuid[], timestamptz) TO service_role;
COMMENT ON FUNCTION public.billing_iap_reconcile_mark_attempted(uuid[], timestamptz) IS
  'billing/04 §6.2: 定期の取り直しで、その回に取り直しを試した利用者の iap_reconcile_attempts.attempted_at を p_attempted_at にする (既にある印は新しい方を残す。auth.users に無い利用者は飛ばす)。回の終わりに 1 回だけ呼ぶ。personal_subscriptions には書かない。service_role だけ';
```

述語と順番と印の読み方 (§7.1 の表と同じ):

| 条件 | 意味 |
|---|---|
| `iap_store IS NOT NULL` | ストアの行だけ (Stripe・手動付与は対象外。R10) |
| `status IN ('trialing', 'active', 'past_due')` | live なストアの行 (`LIVE_STORE_SUBSCRIPTION_STATUSES`)。`expired` / `cancelled` は権利が無いので取り直さない (本人の同期か Webhook で戻る。billing/03 §7.3) |
| `current_period_end IS NOT NULL AND current_period_end <= p_now` | 期限を過ぎた行 (期限の無い行と期限の前の行は対象外。Q-3) |
| `iap_synced_at IS NULL OR iap_synced_at < current_period_end` | 期限の後の姿をまだ取り直していない (何度でも候補) |
| `iap_synced_at <= p_now - p_recheck_after` | 期限の後に取り直しても live のまま (ストアの猶予期間など) の行を、間隔を空けて再び取り直す |
| `DISTINCT ON (user_id)` … `ORDER BY s.user_id, s.current_period_end` | 利用者ごとに 1 行 (その利用者の最も早い期限) |
| `ORDER BY a.attempted_at ASC NULLS FIRST, period_end, user_id LIMIT p_limit` | 試したことが無い利用者 (印の行が無い) が先、続けて最後に試した時刻の古い順。同じ時刻は期限の古い順、同じ期限は `user_id` で安定。候補を読む関数は何も書かない (`STABLE`) |
| `billing_iap_reconcile_mark_attempted(p_user_ids, p_attempted_at)` | 回の終わりに 1 回。その回に `syncStoreSubscriber` を呼んだ利用者 (結果を問わない。429・回全体の失敗で止めた利用者を含む) の `attempted_at` を回の開始の時刻 (= 候補の `p_now`) に。選んだのに試さなかった利用者 (予算・429・回全体の失敗の後ろ) は渡さないので印が進まず、次の回で試した利用者より先に選ばれる (S18)。`auth.users` に無い利用者は飛ばす (S15)。既にある印は `GREATEST` で新しい方を残す (S14) |

### 6.3 ロールバック (`<番号>_billing_iap_reconcile.down.sql`)

```sql
-- rollback: <番号はマージ時に確定>_billing_iap_reconcile.sql
-- 先に vercel.json から /api/cron/iap-reconcile の行を外して Web のデプロイを戻すこと (新しい Web の cron の route はこの 2 つの関数を呼ぶ。
-- 関数だけ消すと GET /api/cron/iap-reconcile が毎時 500 になり、失敗の監視の通知が出続ける)。
-- 消えるもの: 関数 2 本・索引 1 本・印の表 iap_reconcile_attempts (候補の順番の印だけ。権利の行 personal_subscriptions は消さない・変えない)。
-- 戻したあとは、Webhook が届かなかった期限切れの購読が、本人の同期か遅延の再同期まで写らない (billing/03 Q-11 の状態に戻る)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として supabase/migrations に追加し、PR → main マージ → CI で適用する。
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.billing_iap_reconcile_mark_attempted(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.billing_iap_reconcile_candidates(timestamptz, interval, integer);
DROP INDEX IF EXISTS public.idx_personal_subscriptions_iap_reconcile;
DROP TABLE IF EXISTS public.iap_reconcile_attempts;
```

### 6.4 migration が触らないもの

`personal_subscriptions` の列・CHECK・既存の索引・RLS・行、`billing_apply_store_subscription`、`get_effective_plan`、`billing_expire_manual_subscriptions`、`revenuecat_webhook_events`、pg_cron のジョブ。`database.types.ts` (2 本) は再生成する (段 A。§13.1)。印の表は利用者に紐づく表なので、分類の 3 か所 (F24) に同じ段 A で行を足す (§8.5・§14.1)。

---

## 7. 表 3 点

### 7.1 全パターン表 (行の由来 (ストア `iap_store` を含む) × 状態 × 期限 × 最後の取り直し → 候補か・取り直しの結果)

| 行の由来 | status | `current_period_end` | `iap_synced_at` | 候補 | 取り直しの結果 (`syncStoreSubscriber` → 写像) | 根拠 |
|---|---|---|---|---|---|---|
| S (Stripe) / M (手動付与) | 任意 | 任意 | — (`iap_synced_at` は NULL) | 出ない | — | `iap_store IS NULL`。R10・S13 |
| I (ストア) | `expired` / `cancelled` | 任意 | 任意 | 出ない | — (本人の同期・Webhook で戻る。billing/03 §7.3) | live でない。S13 |
| I | `paused` / `grace` / `incomplete` (核の CHECK `personal_subscriptions_status_check` が許す 8 値のうち、ストアの行の 5 値に無い 3 つ) | 任意 | 任意 | 出ない (`status IN ('trialing','active','past_due')` で外れる) | — (起きない。ストアの行を書くのは写像 `billing_apply_store_subscription` だけで、5 値以外は `BILL_UNKNOWN_IAP_STATUS` で拒む。`paused`・`grace` を書くのは Stripe の写像だけで、その行は `stripe_subscription_id` を持つのでストアの行と排他 (`personal_subscriptions_iap_pair_check`)。`LIVE_SUBSCRIPTION_STATUSES` (`core.ts:97`) は `paused`・`grace` を live に含むが、ストアの行の live は `LIVE_STORE_SUBSCRIPTION_STATUSES` の 3 つ) | F10。`20261016210000_billing_core.sql:39`・`:291-300`・`20261021100000_billing_paid_plans_iap.sql:250-251` |
| I | live | NULL | 任意 | 出ない | — | 期限なし。S13 |
| I | live | > now | 任意 | 出ない | — | 期限の前。Q-3 |
| I | live | ≤ now | NULL | 出る | 取り直した姿 (§7.3 (a)) | 取り直したことが無い行 (写像は `iap_synced_at = p_fetched_at` を必ず書くので実際には起きないが、述語は NULL を候補にする) |
| I | live | ≤ now | < `current_period_end` | 出る (毎回) | 取り直した姿: `expired` (S1) / `active` で期限が進む (S2) / `past_due` のまま (S3) / `cancelled` (返金) | 期限の後の姿をまだ見ていない。S1・S2・S4 |
| I | live | ≤ now | ≥ `current_period_end` かつ > now − 6 時間 | 出ない | — | 期限の後に取り直し済みで新しい (ストアの猶予期間の `past_due`)。S3 |
| I | live | ≤ now | ≥ `current_period_end` かつ ≤ now − 6 時間 | 出る | 取り直した姿 (猶予が尽きていれば `expired`) | S3 |
| I (`iap_store` = `app_store` / `play_store`。ストアの軸) | live | ≤ now | 候補の条件 | 出る (ストアで変わらない。述語は `iap_store IS NOT NULL` だけを見る。§6.2) | 利用者ごとに 1 回取り直し、取り直しの `subscriptions` の両方のストアの購読を `selectStoreSubscriptions` が写す順に並べる (行の `iap_store` で取り直しの API は分かれない) | §6.2・billing/03 §8.1 |
| I (`app_store`) | live | ≤ now | 候補の条件 | 出る | 取り直しに App Store の商品が 2 つ以上 live (同じグループの中の変更、または別の Apple ID の二重購読) → 古い方 `expired` (`p_source` = `iap_reconcile:superseded`)・新しい方は取り直した姿 (§7.3 (a)) | billing/03 S36・S25・`SUPERSEDE_WITHIN_GROUP_STORES` = `['app_store']` |
| I (`play_store`) / ストアをまたぐ | live | ≤ now | 候補の条件 | 出る | 取り直しに Google Play の商品が 2 つ以上 live、または App Store と Google Play の商品が両方 live → 置き換えにしない (二重購読)。後に写す live が写像の 5. で `BILL_LIVE_ROW_CONFLICT` → `rejected` (下の行。候補に残る) | billing/03 S25・`SUPERSEDE_WITHIN_GROUP_STORES` に `play_store` は無い |
| I (候補) | live | ≤ now | 候補の条件 | 出る | 別の live 行あり → `BILL_LIVE_ROW_CONFLICT` (飛ばす。`rejected`) | S11・billing/03 §13.3 |
| I (候補) | live | ≤ now | 候補の条件 | 出る | live な商品が `plan_store_products` に無く利用者の行も無い → `BILL_IAP_UNKNOWN_PRODUCT` (何も書かずに飛ばす) | S11・billing/03 S15 |
| I (候補) | live | ≤ now | 候補の条件 | 出る | 取り直しに当社の商品が無い (`no_subscription`) → 行は `projectMissingSubscription` で `expired` (`ended`) | billing/03 §8.4 の 3 (TRANSFER で移った行) |
| I (候補) | live | ≤ now | 候補の条件 | 出る | 退会済み → `user_deleted` (何も書かない) | S15 |
| I (候補) | live | ≤ now | 候補の条件 | 出る | ほかの取り直しが先に写した → `stale` | S5・S6・S14 |
| I (候補) | live | ≤ now | 候補の条件 | 出る | RevenueCat の応答の形の違い (2xx) → `failed['revenuecat_unexpected_response']`・そのほかの 4xx (400・404 など。401 / 403 / 429 を除く) → `failed['revenuecat_client_error']`。何も書かずに次の利用者へ。回の終わりに 500 | S16・F6 |
| I (候補) | live | ≤ now | 候補の条件 | 出る | 写像が `BILL_UNKNOWN_PLAN` (行の `plan_key` が `subscription_plans` から消えた) / `BILL_UNKNOWN_IAP_STATUS` (TS の不具合) → `failed['internal']` (`rejected` にしない。billing/03 §13.3 の扱いは失敗で、運営の処置の表が無い)。warn の `error_code` にコード。次の利用者へ。回の終わりに 500 (同じ利用者の先に写した行は写ったまま) | S16・F23・billing/03 §13.3 |
| I (候補) | live | ≤ now | 候補の条件 | 出る | `RevenueCatApiError` 以外の想定外 (P0001 の業務コード以外の `PostgrestError`・行の読み取りの失敗など) → `failed['internal']`。次の利用者へ。回の終わりに 500 (同じ利用者の先に写した行は写ったまま) | S16・F23 |
| I (候補) | live | ≤ now | 候補の条件 | 出る | RevenueCat に届かない (`status: null`)・401 / 403・5xx → `failed['revenuecat_unreachable' / 'revenuecat_unauthorized' / 'revenuecat_server_error']`・その回を止める (`stopped_early: 'revenuecat_unavailable'`) → 500 | S8 |
| I (候補) | live | ≤ now | 候補の条件 | 出る | RevenueCat の 429 → その回を止める (200 `stopped_early: 'rate_limited'`) | S9 |
| 候補の順番 (`iap_reconcile_attempts`) | — | — | — | 印の行が無い (試したことが無い) 利用者が先、続けて `attempted_at` の古い順 (同じなら期限の古い順)。回の終わりに、この回に `syncStoreSubscriber` を呼んだ利用者だけが `attempted_at` = 回の開始 (取り直しの成否・429・回全体の失敗を問わない)。選んだのに試さなかった利用者 (予算・429・回全体の失敗の後ろ) は印が進まず、次の回で先に選ばれる | — | S10・S11・S16・S17・S18 |
| 消費経路 (読む側) | | | | | | |
| `iap_reconcile_attempts` | — | — | — | — | 書くのは `billing_iap_reconcile_mark_attempted` だけ。読むのは `billing_iap_reconcile_candidates` (service_role の SELECT は結合テストの確認用)。退会で CASCADE。本人のデータの書き出しには出さない (`ACCOUNT_EXPORT_EXCLUDED`)。プライバシーポリシー第 3 条は「有料プラン」の行 (`PRIVACY_DATA_TABLES`) | §6.2・F24 |
| `GET /api/billing/subscription` の遅延の再同期 | — | — | — | — | 変えない (`needsLazyResync` の 5 分の規則はそのまま。本冊の取り直しで `iap_synced_at` が進むと、その後 5 分は遅延の再同期も取り直さない) | F1・F3 |
| `POST /api/billing/iap/sync` | — | — | — | — | 変えない | F4 |
| `get_effective_plan` / `consume_ai_usage_at` / `plan_key_cached` / `family_groups` | — | — | — | — | 変えない。本冊の取り直しが写像を通すので、`expired` になった時点で free に戻る | F7・F8 |
| 監査 `admin_audit_logs` | — | — | — | — | 写像が状態の変化のときだけ書く (`details.source = 'iap_reconcile'`)。本冊は直接書かない | F7 |
| `app_logs` | — | — | — | — | route: `cron/iap-reconcile` の info (回の要約)・warn (鍵なし・環境変数)・error (`internalError`。失敗の回は要約つき)。service: `billing/iap-reconcile-service` の warn (飛ばした利用者・取り直せない利用者・429・失敗の回の要約) | §8.3・§8.4・§11.3 |

### 7.2 状態比較表 (現行 vs 設計後)

| 面 | 現行 (origin/main `0fb02e52`) | 設計後 |
|---|---|---|
| Webhook の再送が尽きた失効 (本人が開かない) | `active` のまま有料の権利が続く (期限を見ない判定。F8) | 期限の後 ≤ 1 時間 (毎時の回) で `expired` に写り、権利が free に戻る (S1) |
| Webhook の再送が尽きた更新 | `current_period_end` が古いまま。本人が開いたときに遅延の再同期で進む | 期限の後 ≤ 1 時間で `current_period_end` が進む (S2)。本人が開いたときの遅延の再同期も変わらず動く |
| ストアの猶予期間の `past_due` | 本人が開くたび 5 分おきに取り直す (F1) | 本人が開かなくても 6 時間ごとに取り直す (S3)。開けば遅延の再同期も変わらず動く |
| 取り直しの入口 | Webhook (`revenuecat:<id>`)・同期 (`iap_sync`)・遅延の再同期 (`iap_lazy_resync`) の 3 つ | + 定期の取り直し (`iap_reconcile`)。4 つとも `syncStoreSubscriber` → `billing_apply_store_subscription` |
| RevenueCat の取り直しの失敗の見え方 | 同期の API は 502、Webhook は 500 (再送)、遅延の再同期は warn で飲み込む (billing/03 S30) | + 定期の取り直しは 500 → `cron_failure` の運用メール。回全体の失敗はその回を止め (S8)、利用者 1 人の失敗は後ろの利用者を取り直してから 500 (S16)。429 は 200 で次の回 (S9) |
| 取り直せない利用者がいるときの後ろの利用者 | (定期の取り直しが無い) | 止まらない。試した利用者は次の回で後ろに回り、選んだのに試さなかった利用者は次の回で先に来る (S16・S17・S18) |
| Vercel Cron | 6 本 (F11) | 7 本 (`/api/cron/iap-reconcile`・`41 * * * *`) |
| `src/lib/env.ts` の一覧 | `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET` | + `IAP_RECONCILE_BATCH_SIZE`・`IAP_RECONCILE_RECHECK_HOURS` (`readOnlyBy` = route) |
| DB | `personal_subscriptions` のストアの列と写像 (billing/03) | + 印の表 `iap_reconcile_attempts`・関数 `billing_iap_reconcile_candidates` (読むだけ)・`billing_iap_reconcile_mark_attempted` (印を書く)・部分索引 `idx_personal_subscriptions_iap_reconcile` (`personal_subscriptions` の列・状態は増えない) |
| 利用者に紐づく表の分類 (F24) | `billing_customers` ほか | + `iap_reconcile_attempts` (書き出しは除外・第 3 条は「有料プラン」・退会で CASCADE) |
| 権利の判定 (`get_effective_plan`) | status だけ | 変えない (R11・案 E を退ける) |
| ストアの行の `paused` / `grace` / `incomplete` | 起きない (写像が 5 値以外を拒む。F10)。`get_effective_plan` は `grace` を権利に数え `paused` を数えない (`20261010140000_ai_usage_foundation.sql:115`) が、ストアの行には関係しない | 変えない (候補の述語も 3 値だけを見る。§7.1) |
| 手動付与の失効 (`expire-manual-plan-grants`) | ストアの行を扱わない | 変えない (ストアの行は本冊の cron) |
| operator/08 の台帳・operator/10・11・12 の本数の記述・`ENV_SETUP.md` の `CRON_SECRET` の行 | 6 本 | 7 本 (§14.2) |

### 7.3 状態遷移表

(a) 候補の行 × 取り直した姿 → 遷移先 (遷移の規則は billing/03 §7.3 の「取り直しの合図」の行と同じ。本冊は合図を足すだけで、遷移を足さない)

「現在」は候補の述語に入る `trialing` / `active` / `past_due` の 3 つだけ。ストアの行は `paused` / `grace` / `incomplete` を取らない (写像が拒む。§7.1・F10) ので、その行は無い。遷移先も写像の 5 値の中だけ。

| 現在 (候補の行) | 取り直した姿 (`deriveStoreStatus` / `selectStoreSubscriptions`) | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `trialing` / `active` / `past_due` (期限 ≤ now) | `expires_date` ≤ now・猶予が無いか尽きた・`refunded_at` なし | `expired` | 取り直しが新しい (`iap_synced_at < p_fetched_at`)・`plan_store_products` の行か利用者の行がある | UPDATE・`plan_key_cached` 再計算 (NULL)・家族グループ `free` / 4 (家族プランのとき)・監査 `subscription_status_changed` (info・`source: 'iap_reconcile'`) |
| 同上 | `expires_date` > now (更新済み) | `active` (`trialing` からは `active`。`period_type` が trial のままなら `trialing`) | 同上 | UPDATE (`current_period_end` が進む)。状態が同じなら監査なし |
| 同上 | `expires_date` ≤ now かつ `grace_period_expires_date` > now | `past_due` | 同上 | UPDATE (`past_due_since` は保つ)。`active` → `past_due` のときだけ監査 (warn) |
| 同上 | `refunded_at` あり | `cancelled` | 同上 | `cancelled_at = refunded_at`・`plan_key_cached`・家族グループ・監査 |
| 同上 | 取り直しに当社の商品が無い | `expired` (`projectMissingSubscription`) | 同上 | `ended + 1`。`plan_key_cached`・家族グループ・監査 |
| 同上 | 同じ App Store のグループに 2 つ以上 live | 古い方 `expired` (`:superseded`)・新しい方は上の行 | billing/03 §7.3 S36。ストアが `app_store` のときだけ (`SUPERSEDE_WITHIN_GROUP_STORES`。Google Play とストアをまたぐ 2 つの live は下の「別の live 行あり」) | 親の規則のとおり |
| 同上 | 別の live 行あり (Stripe の行・Google Play の 2 つの live・App Store と Google Play の両方の live。billing/03 S13・S25) | 同じ | — | `BILL_LIVE_ROW_CONFLICT` → `rejected` に数えて飛ばす (warn)。候補に残る |
| 同上 | live な商品が `plan_store_products` に無く利用者の行も無い | 同じ | — | `BILL_IAP_UNKNOWN_PRODUCT` → `rejected` に数えて飛ばす (何も書かない) |
| 同上 | 取り直しが古い (`iap_synced_at >= p_fetched_at`) | 同じ | — | `stale + 1` |
| 同上 | 退会済み | 行なし | — | `user_deleted` (数えない) |
| 同上 | RevenueCat の応答の形の違い (2xx)・そのほかの 4xx | 同じ | — | `failed[種類] += 1`・warn (`user_id`・`kind`)・次の利用者へ → 回の終わりに 500 (S16) |
| 同上 | 写像が `BILL_UNKNOWN_PLAN` / `BILL_UNKNOWN_IAP_STATUS` (billing/03 §13.3。扱いは失敗) | 失敗した写像の 1 件は戻る (同じ利用者の先に写した行は写ったまま) | — | `failed['internal'] += 1`・warn (`user_id`・`kind`・`error_name = 'BillingRpcError'`・`error_code` = コード)・次の利用者へ → 回の終わりに 500 (S16)。`rejected` にしない |
| 同上 | `RevenueCatApiError` 以外の想定外 (P0001 の業務コード以外の DB の失敗など) | 失敗した写像の 1 件は戻る (同じ利用者の先に写した行は写ったまま。どちらも取り直した姿なので矛盾しない) | — | `failed['internal'] += 1`・warn・次の利用者へ → 回の終わりに 500 (S16) |
| 同上 | RevenueCat に届かない (`status: null`)・401 / 403・5xx | 同じ | — | `failed[種類] += 1`・その回を止める (`stopped_early: 'revenuecat_unavailable'`) → 500 (S8) |
| 同上 | RevenueCat の 429 | 同じ | — | その回を止める → 200 `stopped_early: 'rate_limited'` (S9。それまでに `failed` があれば 500) |

(b) 1 回の処理 (route) の状態機械

| 状態 | 出来事 | 次 | 応答 / 副作用 |
|---|---|---|---|
| 開始 | `requireCronAuth` が 401 / 503 | 終わり | 401 `{ error: 'unauthorized' }` / 503 `{ error: 'cron_disabled' }` (既存の型。DB に触れない) |
| 認証済み | `isMaintenanceFlagOn()` = true | 終わり | 200 `{ status: 'maintenance' }` |
| 認証済み | `createRevenueCatGateway()` が `RevenueCatNotConfiguredError` | 終わり | 200 `{ status: 'not_configured' }`・warn 1 行 (変数名はログにだけ) |
| 設定の解釈 | `IAP_RECONCILE_*` が範囲外・整数でない | 処理へ | warn `{ ignored_env }`・既定値 |
| 候補 | 候補の RPC (`billing_iap_reconcile_candidates`) の失敗・想定外の形 | 終わり | service はそのまま投げる (誰も取り直していない。印の RPC も呼ばない) → route が `internalError` → 500 |
| 処理 | 候補 0 | 終わり | 200 `{ status: 'idle', candidates: 0, …, failed: {}, stopped_early: null, oldest_period_end: null }` (印の RPC を呼ばない) |
| 処理 | 予算の内で次の利用者の取り直しを始める (`syncStoreSubscriber` を呼ぶ) | 処理 | その利用者を「試した利用者」に加える (結果を問わない。下の 4 つの行のどれになっても) |
| 処理 | 運営の処置が要る利用者 (`isIapReconcileRejectedCode`: `BillingRpcError` の `BILL_LIVE_ROW_CONFLICT`・`IapError` の `BILL_IAP_UNKNOWN_PRODUCT`) | 処理 (次の利用者) | `rejected[code] += 1`・warn (`user_id`・`code`) |
| 処理 | 利用者 1 人の失敗 (`classifyReconcileFailure` = `user`: 応答の形の違い・そのほかの 4xx・`RevenueCatApiError` 以外 (`BILL_UNKNOWN_PLAN`・`BILL_UNKNOWN_IAP_STATUS` の `BillingRpcError` を含む)) | 処理 (次の利用者) | `failed[kind] += 1`・warn (`user_id`・`kind`) |
| 処理 | 回全体の失敗 (`run`: `status: null`・401 / 403・5xx) | 印 | `failed[kind] += 1`・`stopped_early = 'revenuecat_unavailable'` (この利用者は試した利用者。後ろは試さない) |
| 処理 | 予算 (40 秒) を超えた (次の利用者を始める前に判定) | 印 | `stopped_early = 'budget'` (この利用者から後ろは試さない) |
| 処理 | 429 (`rate_limited`) | 印 | `stopped_early = 'rate_limited'`・warn (この利用者は試した利用者。後ろは試さない) |
| 処理 | 候補を全部試した | 印 | — |
| 印 | 試した利用者が 0 (候補の RPC が予算を使い切り、1 人目の前に止まった回だけ) | 締め | 印の RPC を呼ばない |
| 印 | 試した利用者が 1 以上 | 締め | `markReconcileAttempted({ userIds: 試した利用者, attemptedAt: 回の開始 })` (1 回の RPC = `billing_iap_reconcile_mark_attempted`)。選んだのに試さなかった利用者は渡さない (印が進まず、次の回で先に選ばれる) |
| 印 | 印の RPC の失敗 | 終わり | service はそのまま投げる (取り直しと写しは済んでいる) → route が `internalError` → 500 (要約は残らない。試した利用者の印が進まないので、次の回も同じ利用者が先に来る) |
| 締め | `failed` が 0 | 終わり | 200 `{ status: 'processed', …, failed: {}, stopped_early }`・info 1 行 (要約) |
| 締め | `failed` が 1 以上 | 終わり | service が warn (要約) → `IapReconcileFailedError` → route が `internalError(…, { requestId, summary })` → 500 固定の本文・`app_logs` error (要約つき) → `cron_failure` |

---

## 8. 正典コード

### 8.0 置き場所と型検査

| ブロック | 置き場所 | 検査 |
|---|---|---|
| §8.1 `iap-reconcile-core.ts` | `src/lib/billing/iap-reconcile-core.ts` (新設) | 単独 (import は zod だけ。テスト 1 が見張る) |
| §8.2 `iap-reconcile-repository.ts` | `src/lib/billing/iap-reconcile-repository.ts` (新設) | `place=` |
| §8.3 `iap-reconcile-service.ts` | `src/lib/billing/iap-reconcile-service.ts` (新設) | `place=` |
| §8.4 route | `src/app/api/cron/iap-reconcile/route.ts` (新設) | `place=` |
| §8.5 既存ファイルの差分 | 段 A: `src/lib/account-export-tables.ts` (`insert=`)。段 B: `src/lib/env.ts` (`insert=`)・`.env.example`・`vercel.json`・`ENV_SETUP.md` | `insert=` / 文面 |

手順は billing/01 §8.0 (印の付いたブロックを置き場所に置き、`npx tsc --noEmit` をリポジトリ全体に当てる)。段 B は段 A のマージ後 (`database.types.ts` に `billing_iap_reconcile_candidates`・`billing_iap_reconcile_mark_attempted` がある状態) に型検査する。

規則 (billing/03 §8.0 と同じ): `iap-reconcile-core.ts` は zod 以外を import しない。`iap-reconcile-service.ts` は `revenuecat-gateway`・`iap-repository`・`iap-reconcile-repository`・`@/lib/env` を import しない (route が作って deps で渡す)。親の `iap-core.ts`・`iap-service.ts`・`revenuecat-gateway.ts`・`iap-repository.ts` は変えない。

### 8.1 `src/lib/billing/iap-reconcile-core.ts` (正典。純)

```ts
/**
 * ストアの購読の定期の取り直し (billing/04) の定数・Zod・型・ポート・純関数。I/O を持たない (fetch / DB / env を読まない)。
 * import してよいのは zod だけ (tests/billing-iap-reconcile-core.test.ts のテスト 1 が見張る)。
 * 取り直しそのもの (RevenueCat の GET と写像) は billing/03 の iap-core.ts / iap-service.ts にあり、ここでは触らない。
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数 (根拠つき)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 写像 billing_apply_store_subscription の p_source。監査 (system.billing.subscription_status_changed) の details.source で、
 * 定期の取り直しによる変化を見分ける (billing/03 の 'iap_sync' / 'iap_lazy_resync' / 'revenuecat:<event.id>' と並ぶ 4 つ目の出どころ)
 */
export const IAP_RECONCILE_SOURCE = 'iap_reconcile';

/**
 * Vercel Cron の path と予定 (vercel.json と同じ値。一致はテスト 29)。毎時 41 分 (UTC。JST も毎時 41 分)。
 * ほかの cron の分 (app-log-alerts の 0 / 15 / 30 / 45 分・backup-freshness の 37 分) と重ねない。毎分の cron とは関係ない
 */
export const IAP_RECONCILE_CRON_PATH = '/api/cron/iap-reconcile';
export const IAP_RECONCILE_SCHEDULE_UTC = '41 * * * *';
/** 回の間隔 (分)。予定が毎時なので 60。期限を過ぎてから権利が止まるまでの窓の上限 (billing/04 Q-1) */
export const IAP_RECONCILE_CRON_INTERVAL_MINUTES = 60;
/** route の最長実行時間 (秒。Vercel Pro の既定の上限の中)。route には同じ値をリテラルで書く (route segment config はリテラルだけ。一致はテスト 28) */
export const IAP_RECONCILE_MAX_DURATION_SECONDS = 60;
/**
 * 1 回の処理の予算 (ms)。maxDuration (60 秒) の中に、最後の 1 人の取り直しの時間切れ (REVENUECAT_REQUEST_TIMEOUT_MS = 10 秒) +
 * 写像の RPC + 応答が収まる値 (push-outbox の PUSH_OUTBOX_RUN_BUDGET_MS と同じ 40 秒)。超えたら残りを次の回に回す
 */
export const IAP_RECONCILE_RUN_BUDGET_MS = 40_000;
/** 取り直しの開始の間隔 (ms)。RevenueCat の案内 (REST v1 は 1 秒に 1 回程度。billing/04 §2.3 P1) に合わせる */
export const IAP_RECONCILE_REQUEST_INTERVAL_MS = 1_000;
/**
 * 1 回の処理で試せる利用者の数の上限 = 予算 ÷ 間隔 (= 40)。これより多く選んでも予算の中で試せない (試さなかった利用者は印が進まず次の回に回るだけ)
 * ので、環境変数 IAP_RECONCILE_BATCH_SIZE はこれより上に上げられない (下げる向きだけ)。DB 関数の c_max_users (200) 以下 (テスト 10 が migration の文面を読んで見る)
 */
export const IAP_RECONCILE_BATCH_SIZE_MAX = Math.floor(IAP_RECONCILE_RUN_BUDGET_MS / IAP_RECONCILE_REQUEST_INTERVAL_MS);
/** 1 回の処理で選ぶ利用者の数 (既定) = 試せる数の上限。環境変数 IAP_RECONCILE_BATCH_SIZE で 1〜上限に下げられる (RevenueCat への回数を減らす) */
export const IAP_RECONCILE_BATCH_SIZE = IAP_RECONCILE_BATCH_SIZE_MAX;
export const IAP_RECONCILE_BATCH_SIZE_MIN = 1;
/**
 * 期限の後に取り直しても live のままの行 (ストアの猶予期間の past_due など) を、次に取り直すまでの間隔 (時間。既定)。
 * 猶予期間は日の単位で続くので毎時は無駄が多く、6 時間なら 1 日 4 回。環境変数 IAP_RECONCILE_RECHECK_HOURS で上書きできる
 */
export const IAP_RECONCILE_RECHECK_HOURS = 6;
/** 下限は回の間隔 (1 時間)。上限は 7 日 (ストアの猶予期間より長くしない) */
export const IAP_RECONCILE_RECHECK_HOURS_MIN = 1;
const HOURS_PER_DAY = 24;
const IAP_RECONCILE_RECHECK_MAX_DAYS = 7;
export const IAP_RECONCILE_RECHECK_HOURS_MAX = IAP_RECONCILE_RECHECK_MAX_DAYS * HOURS_PER_DAY;
/** RevenueCat の率の制限の応答 (その回を止めて次の回に回す) */
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
/** 鍵の誤り・失効・権限の不足 (どの利用者でも同じ結果になる = 回全体の失敗) */
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const HTTP_STATUS_FORBIDDEN = 403;
/** 4xx の下限 (401 / 403 / 429 以外の 4xx は、その利用者の要求だけの失敗) */
export const HTTP_STATUS_CLIENT_ERROR_MIN = 400;
/** 5xx の下限 (RevenueCat の障害 = 回全体の失敗) */
export const HTTP_STATUS_SERVER_ERROR_MIN = 500;

// ─────────────────────────────────────────────────────────────────────────────
// 環境変数の解釈 (値を読むのは route。ここは文字列を受けて解釈するだけ)
// ─────────────────────────────────────────────────────────────────────────────

export type IapReconcileSettingEnvName = 'IAP_RECONCILE_BATCH_SIZE' | 'IAP_RECONCILE_RECHECK_HOURS';
export interface IapReconcileSettingSources {
  batchSize: string | undefined;
  recheckHours: string | undefined;
}
export interface IapReconcileSettings {
  batchSize: number;
  recheckHours: number;
  /** 範囲外・整数でない値を既定に戻した変数の名前 (route が warn に書く。値は書かない) */
  ignored: IapReconcileSettingEnvName[];
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): { value: number; ignored: boolean } {
  if (raw === undefined || raw.trim() === '') return { value: fallback, ignored: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return { value: fallback, ignored: true };
  return { value: n, ignored: false };
}

/** 環境変数の値を解釈する。空は既定、範囲外・整数でない値は既定に戻して名前を ignored に入れる (push-outbox の resolvePushOutboxSettings と同じ規則) */
export function resolveIapReconcileSettings(sources: IapReconcileSettingSources): IapReconcileSettings {
  const batch = boundedInt(sources.batchSize, IAP_RECONCILE_BATCH_SIZE, IAP_RECONCILE_BATCH_SIZE_MIN, IAP_RECONCILE_BATCH_SIZE_MAX);
  const recheck = boundedInt(sources.recheckHours, IAP_RECONCILE_RECHECK_HOURS, IAP_RECONCILE_RECHECK_HOURS_MIN, IAP_RECONCILE_RECHECK_HOURS_MAX);
  const ignored: IapReconcileSettingEnvName[] = [];
  if (batch.ignored) ignored.push('IAP_RECONCILE_BATCH_SIZE');
  if (recheck.ignored) ignored.push('IAP_RECONCILE_RECHECK_HOURS');
  return { batchSize: batch.value, recheckHours: recheck.value, ignored };
}

// ─────────────────────────────────────────────────────────────────────────────
// 候補 (DB 関数 billing_iap_reconcile_candidates の行)・試した利用者の印とポート
// ─────────────────────────────────────────────────────────────────────────────

/** RETURNS TABLE (user_id uuid, period_end timestamptz, synced_at timestamptz) の 1 行 (PostgREST は timestamptz を ISO の文字列で返す) */
export const IapReconcileCandidateSchema = z.object({
  user_id: z.uuid(),
  period_end: z.string().min(1),
  synced_at: z.string().min(1).nullable(),
});
export type IapReconcileCandidate = z.infer<typeof IapReconcileCandidateSchema>;
export const IapReconcileCandidatesSchema = z.array(IapReconcileCandidateSchema);

export interface IapReconcileCandidateQuery {
  /** p_now (候補の判定の「いま」。取り直しの p_fetched_at とは別に、処理の開始に 1 回取る) */
  now: Date;
  /** p_recheck_after (時間) */
  recheckHours: number;
  /** p_limit (1〜IAP_RECONCILE_BATCH_SIZE_MAX) */
  limit: number;
}

/** 回の終わりに書く印 (DB 関数 billing_iap_reconcile_mark_attempted の引数) */
export interface IapReconcileAttemptMark {
  /** p_user_ids: この回に syncStoreSubscriber を呼んだ利用者 (結果を問わない。1〜IAP_RECONCILE_BATCH_SIZE_MAX 人・重複なし)。選んだのに試さなかった利用者は入れない */
  userIds: string[];
  /** p_attempted_at: 回の開始 (候補の判定の now と同じ時刻) */
  attemptedAt: Date;
}

/**
 * 候補を読み、試した利用者に印を書く (実装は iap-reconcile-repository.ts。テストは偽物を渡す)。
 * listReconcileCandidates は何も書かない。markReconcileAttempted は回の終わりに 1 回だけ呼ぶ (試した利用者は次の回で後ろに回る)。
 * billing/03 の IapRepository は変えない (別のポート)
 */
export interface IapReconcileRepository {
  listReconcileCandidates(query: IapReconcileCandidateQuery): Promise<IapReconcileCandidate[]>;
  markReconcileAttempted(mark: IapReconcileAttemptMark): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 取り直しの失敗の分け方 (billing/04 §4.1 の 5)
// ─────────────────────────────────────────────────────────────────────────────

/** 失敗の種類 (要約の failed のキー。固定の語で、RevenueCat の生の文・利用者 ID は入れない) */
export const IAP_RECONCILE_FAILURE_KINDS = [
  'revenuecat_unreachable',
  'revenuecat_unauthorized',
  'revenuecat_server_error',
  'revenuecat_client_error',
  'revenuecat_unexpected_response',
  'internal',
] as const;
export type IapReconcileFailureKind = (typeof IAP_RECONCILE_FAILURE_KINDS)[number];

/**
 * 運営の処置で解消するので、失敗にせず rejected に数える業務エラーのコード (billing/03 §13.3 の BILL_LIVE_ROW_CONFLICT・S15 の
 * BILL_IAP_UNKNOWN_PRODUCT)。写像のほかの業務エラー (BILL_UNKNOWN_PLAN・BILL_UNKNOWN_IAP_STATUS) は親の扱いが失敗なので入れない
 * (classifyReconcileFailure の other → internal → 500。入れると期限を過ぎた live の行が運用メール無しで残り続ける)
 */
export const IAP_RECONCILE_REJECTED_CODES = ['BILL_LIVE_ROW_CONFLICT', 'BILL_IAP_UNKNOWN_PRODUCT'] as const;
export type IapReconcileRejectedCode = (typeof IAP_RECONCILE_REJECTED_CODES)[number];

/** 業務エラーのコードが rejected に数えるもの (IAP_RECONCILE_REJECTED_CODES) か */
export function isIapReconcileRejectedCode(code: string): code is IapReconcileRejectedCode {
  return IAP_RECONCILE_REJECTED_CODES.some((rejected) => rejected === code);
}

/** 失敗の出どころ。RevenueCatApiError なら status (null = 時間切れ・接続の失敗)、それ以外の例外は other */
export type IapReconcileFailureInput = { source: 'revenuecat'; status: number | null } | { source: 'other' };

/**
 * run = 回全体の失敗 (どの利用者でも同じになる。その回を止める)。user = その利用者だけの失敗 (数えて次の利用者へ)。
 * rate_limited = 429 (その回を止めて 200)
 */
export type IapReconcileFailureClass =
  | { scope: 'rate_limited' }
  | { scope: 'run' | 'user'; kind: IapReconcileFailureKind };

/**
 * 取り直しの失敗を分ける。運営の処置が要る 2 つ (isIapReconcileRejectedCode) はここに来ない (service が先に rejected に数える)。
 *   - RevenueCat に届かない (null)・401 / 403・5xx → run
 *   - 429 → rate_limited
 *   - そのほかの 4xx → user (revenuecat_client_error)
 *   - 2xx など (応答の形が RevenueCatCustomerInfoSchema に合わない) → user (revenuecat_unexpected_response)
 *   - RevenueCatApiError 以外 (写像の BILL_UNKNOWN_PLAN / BILL_UNKNOWN_IAP_STATUS (billing/03 §13.3 の扱いは失敗)・P0001 以外の PostgrestError・
 *     行の読み取りの失敗など) → user (internal)
 */
export function classifyReconcileFailure(input: IapReconcileFailureInput): IapReconcileFailureClass {
  if (input.source === 'other') return { scope: 'user', kind: 'internal' };
  const { status } = input;
  if (status === null) return { scope: 'run', kind: 'revenuecat_unreachable' };
  if (status === HTTP_STATUS_TOO_MANY_REQUESTS) return { scope: 'rate_limited' };
  if (status === HTTP_STATUS_UNAUTHORIZED || status === HTTP_STATUS_FORBIDDEN) return { scope: 'run', kind: 'revenuecat_unauthorized' };
  if (status >= HTTP_STATUS_SERVER_ERROR_MIN) return { scope: 'run', kind: 'revenuecat_server_error' };
  if (status >= HTTP_STATUS_CLIENT_ERROR_MIN) return { scope: 'user', kind: 'revenuecat_client_error' };
  return { scope: 'user', kind: 'revenuecat_unexpected_response' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 回の処理の要約と、回の中の純関数
// ─────────────────────────────────────────────────────────────────────────────

/** 途中で止めた理由 (push-outbox の budget / rate_limited に、回全体の失敗の revenuecat_unavailable を足した 3 値) */
export const IAP_RECONCILE_STOP_REASONS = ['budget', 'rate_limited', 'revenuecat_unavailable'] as const;
export type IapReconcileStopReason = (typeof IAP_RECONCILE_STOP_REASONS)[number];

/** route の応答の status */
export const IAP_RECONCILE_RUN_STATUSES = ['maintenance', 'not_configured', 'idle', 'processed'] as const;
export type IapReconcileRunStatus = (typeof IAP_RECONCILE_RUN_STATUSES)[number];

/** 1 回の処理の要約 (件数だけ。利用者 ID・RevenueCat の生の文は入れない)。応答とログにそのまま載せる */
export interface IapReconcileSummary {
  /** 取り出した候補の数 (≤ batchSize) */
  candidates: number;
  /** 取り直しが終わった利用者の数 (結果が applied / stale / ended / no_subscription / user_deleted のどれでも) */
  synced: number;
  /** StoreSyncOutcome の合計 (billing/03 §8.1) */
  applied: number;
  stale: number;
  ended: number;
  no_subscription: number;
  skipped_unknown: number;
  /** 運営の処置が要る業務エラー (IAP_RECONCILE_REJECTED_CODES。billing/03 §13.3・S15) で写せず飛ばした利用者の数 (コード別)。回は失敗にしない */
  rejected: Partial<Record<IapReconcileRejectedCode, number>>;
  /** 取り直せなかった利用者の数 (種類別。classifyReconcileFailure)。1 以上なら回は失敗 (IapReconcileFailedError → 500) */
  failed: Partial<Record<IapReconcileFailureKind, number>>;
  stopped_early: IapReconcileStopReason | null;
  /** 最も古い候補の期限 (ISO)。候補が無ければ null。遅れの大きさを運営が見るため */
  oldest_period_end: string | null;
  /** 処理の開始から要約までの時間 (ms) */
  elapsed_ms: number;
}

export function emptyIapReconcileSummary(candidates: readonly IapReconcileCandidate[]): IapReconcileSummary {
  return {
    candidates: candidates.length,
    synced: 0,
    applied: 0,
    stale: 0,
    ended: 0,
    no_subscription: 0,
    skipped_unknown: 0,
    rejected: {},
    failed: {},
    stopped_early: null,
    oldest_period_end: oldestPeriodEnd(candidates),
    elapsed_ms: 0,
  };
}

/** 候補のうち最も古い期限 (候補は試した時刻の順に並ぶので、先頭とは限らない)。ISO の文字列を Date で比べる */
function oldestPeriodEnd(candidates: readonly IapReconcileCandidate[]): string | null {
  let oldest: IapReconcileCandidate | null = null;
  for (const candidate of candidates) {
    if (oldest === null || Date.parse(candidate.period_end) < Date.parse(oldest.period_end)) oldest = candidate;
  }
  return oldest?.period_end ?? null;
}

/** 要約の failed の合計 (1 以上なら回は失敗) */
export function countReconcileFailures(summary: Pick<IapReconcileSummary, 'failed'>): number {
  let total = 0;
  for (const kind of IAP_RECONCILE_FAILURE_KINDS) total += summary.failed[kind] ?? 0;
  return total;
}

/**
 * 取り直せなかった利用者が 1 人以上いた回 (route が 500 にし、要約を app_logs の error の metadata に残す)。
 * message は固定の語 (利用者 ID・RevenueCat の生の文を入れない)
 */
export class IapReconcileFailedError extends Error {
  readonly summary: IapReconcileSummary;
  constructor(summary: IapReconcileSummary) {
    super('ストアの購読を取り直せなかった利用者がいます');
    this.name = 'IapReconcileFailedError';
    this.summary = summary;
  }
}

/** 次の取り直しを始めるまでに待つ時間 (ms)。最初の 1 人は待たない。前の取り直しの開始から間隔がたっていれば 0 */
export function reconcileFetchDelayMs(lastFetchStartedAtMs: number | null, nowMs: number): number {
  if (lastFetchStartedAtMs === null) return 0;
  return Math.max(0, lastFetchStartedAtMs + IAP_RECONCILE_REQUEST_INTERVAL_MS - nowMs);
}

/** 処理の開始から予算を超えたか (ちょうど予算は超えていない。push-outbox の判定と同じ向き) */
export function isReconcileBudgetExhausted(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs > IAP_RECONCILE_RUN_BUDGET_MS;
}
```

### 8.2 `src/lib/billing/iap-reconcile-repository.ts` (`IapReconcileRepository` の実装)

```ts
// tsc:skip place=src/lib/billing/iap-reconcile-repository.ts
/**
 * IapReconcileRepository の実装 (billing/04 §8.2)。service_role の client で候補を読む RPC と印を書く RPC を呼ぶ (書くのは順番の印の表
 * iap_reconcile_attempts だけ。権利の表への書き込みは billing/03 の iap-repository.ts の applyStoreSubscription が唯一)。
 * 呼ぶ側は必ず cron の認証 (requireCronAuth) のあと
 */
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { IapReconcileCandidatesSchema, type IapReconcileRepository } from '@/lib/billing/iap-reconcile-core';

type Admin = ReturnType<typeof getSupabaseAdmin>;

/** PostgreSQL の interval の入力 ('6 hours')。p_recheck_after に渡す */
const hoursInterval = (hours: number): string => `${hours} hours`;

export function createIapReconcileRepository(admin: Admin = getSupabaseAdmin()): IapReconcileRepository {
  return {
    async listReconcileCandidates({ now, recheckHours, limit }) {
      const { data, error } = await admin.rpc('billing_iap_reconcile_candidates', {
        p_now: now.toISOString(),
        p_recheck_after: hoursInterval(recheckHours),
        p_limit: limit,
      });
      if (error) throw error;
      const parsed = IapReconcileCandidatesSchema.safeParse(data);
      if (!parsed.success) throw new Error('billing_iap_reconcile_candidates が想定外の結果を返しました');
      return parsed.data;
    },
    async markReconcileAttempted({ userIds, attemptedAt }) {
      const { error } = await admin.rpc('billing_iap_reconcile_mark_attempted', {
        p_user_ids: userIds,
        p_attempted_at: attemptedAt.toISOString(),
      });
      if (error) throw error;
    },
  };
}
```

### 8.3 `src/lib/billing/iap-reconcile-service.ts` (facade。route はこれだけを呼ぶ)

```ts
// tsc:skip place=src/lib/billing/iap-reconcile-service.ts
/**
 * ストアの購読の定期の取り直し (billing/04 §8.3)。候補の利用者を 1 人ずつ syncStoreSubscriber (billing/03 §8.4。写しの唯一の TS の入口) で
 * 取り直す。revenuecat-gateway・iap-repository・iap-reconcile-repository・@/lib/env を import しない (実装は route が作って deps で渡す)。
 *   - 1 人ずつ直列。取り直しの開始の間隔は IAP_RECONCILE_REQUEST_INTERVAL_MS (1 秒)。予算 IAP_RECONCILE_RUN_BUDGET_MS (40 秒) で打ち切る
 *   - 運営の処置が要る利用者 (BillingRpcError の BILL_LIVE_ROW_CONFLICT・IapError の BILL_IAP_UNKNOWN_PRODUCT = IAP_RECONCILE_REJECTED_CODES) は
 *     rejected に数えて次へ (warn。候補に残り、次の回は後ろに回る)。ほかの業務エラー (BILL_UNKNOWN_PLAN・BILL_UNKNOWN_IAP_STATUS) は下の user (internal)
 *   - それ以外の失敗は classifyReconcileFailure で分ける:
 *       rate_limited (429)  → その回を止める (stopped_early = 'rate_limited'。残りは次の回)
 *       run (届かない・401 / 403・5xx) → failed に数えてその回を止める (stopped_early = 'revenuecat_unavailable')
 *       user (応答の形の違い・そのほかの 4xx・RevenueCatApiError 以外 (上の 2 つ以外の業務エラーを含む)) → failed に数えて次の利用者へ
 *   - ループの後、この回に syncStoreSubscriber を呼んだ利用者 (結果を問わない) にだけ、1 回の RPC で印を書く (markReconcileAttempted)。
 *     選んだのに予算・429・回全体の失敗で試さなかった利用者は渡さない (印が進まず、次の回で試した利用者より先に選ばれる。billing/04 S18)
 *   - 回の終わりに failed が 1 以上なら IapReconcileFailedError を投げる (route が 500 → 失敗の監視)
 *   - 候補を読む RPC・印を書く RPC の失敗はそのまま投げる (route が 500)
 */
import { createLogger } from '@/lib/db-logger';
import { BillingRpcError } from '@/lib/billing/repository';
import { IapError, RevenueCatApiError } from '@/lib/billing/iap-core';
import { syncStoreSubscriber, type IapDeps } from '@/lib/billing/iap-service';
import {
  IAP_RECONCILE_SOURCE,
  IapReconcileFailedError,
  classifyReconcileFailure,
  countReconcileFailures,
  emptyIapReconcileSummary,
  isIapReconcileRejectedCode,
  isReconcileBudgetExhausted,
  reconcileFetchDelayMs,
  type IapReconcileRejectedCode,
  type IapReconcileRepository,
  type IapReconcileSettings,
  type IapReconcileSummary,
} from '@/lib/billing/iap-reconcile-core';

const logger = createLogger('billing/iap-reconcile-service');

export interface IapReconcileDeps extends IapDeps {
  reconcileRepository: IapReconcileRepository;
  /** テストで差し替える (待ち)。既定は setTimeout */
  sleep?: (ms: number) => Promise<void>;
}
export type IapReconcileRunSettings = Pick<IapReconcileSettings, 'batchSize' | 'recheckHours'>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** ログに残す例外の名前とコード (文面は残さない。PostgrestError の code = SQLSTATE など) */
function errorFingerprint(error: unknown): { error_name: string | null; error_code: string | null } {
  const name = error instanceof Error ? error.name : null;
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
  return { error_name: name, error_code: code };
}

/** 運営の処置が要る業務エラー (IAP_RECONCILE_REJECTED_CODES) ならそのコード、それ以外 (BILL_UNKNOWN_PLAN などを含む) は null */
function rejectedCodeOf(error: unknown): IapReconcileRejectedCode | null {
  if (!(error instanceof BillingRpcError) && !(error instanceof IapError)) return null;
  const { code } = error;
  return isIapReconcileRejectedCode(code) ? code : null;
}

/**
 * 1 回の処理。候補を読む → 1 人ずつ取り直す → 試した利用者に印を書く → 要約を返す (取り直せなかった利用者がいれば IapReconcileFailedError を投げる)。
 * 取り直しの p_fetched_at は syncStoreSubscriber が GET の前に取る (ここでは取らない)。候補の判定の p_now と印の時刻は、処理の開始に 1 回取る
 */
export async function reconcileStoreSubscriptions(deps: IapReconcileDeps, settings: IapReconcileRunSettings): Promise<IapReconcileSummary> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const startedAtMs = now().getTime();
  const startedAt = new Date(startedAtMs);
  const candidates = await deps.reconcileRepository.listReconcileCandidates({
    now: startedAt,
    recheckHours: settings.recheckHours,
    limit: settings.batchSize,
  });
  const summary = emptyIapReconcileSummary(candidates);
  /** この回に syncStoreSubscriber を呼んだ利用者 (結果を問わない)。ループの後に印を書く。選んだのに試さなかった利用者は入れない */
  const attemptedUserIds: string[] = [];
  let lastFetchStartedAtMs: number | null = null;
  for (const candidate of candidates) {
    if (isReconcileBudgetExhausted(startedAtMs, now().getTime())) {
      summary.stopped_early = 'budget';
      break;
    }
    const delay = reconcileFetchDelayMs(lastFetchStartedAtMs, now().getTime());
    if (delay > 0) await sleep(delay);
    lastFetchStartedAtMs = now().getTime();
    attemptedUserIds.push(candidate.user_id);
    try {
      const outcome = await syncStoreSubscriber(deps, candidate.user_id, IAP_RECONCILE_SOURCE);
      summary.synced += 1;
      summary.applied += outcome.applied;
      summary.stale += outcome.stale;
      summary.ended += outcome.ended;
      summary.skipped_unknown += outcome.skipped_unknown;
      if (outcome.no_subscription) summary.no_subscription += 1;
    } catch (error) {
      const rejectedCode = rejectedCodeOf(error);
      if (rejectedCode !== null) {
        // 別の live 行との衝突・対応の無い商品 (billing/03 §13.3・S15 の運営の処置)。この利用者は飛ばす (候補に残り、印で次の回は後ろに回る)
        summary.rejected[rejectedCode] = (summary.rejected[rejectedCode] ?? 0) + 1;
        logger.warn('ストアの購読の取り直しを写せませんでした (運営の処置が要ります)', { user_id: candidate.user_id, code: rejectedCode });
        continue;
      }
      // BILL_UNKNOWN_PLAN・BILL_UNKNOWN_IAP_STATUS の BillingRpcError は source other → user (internal)。warn の error_code にコードが残る
      const failure = classifyReconcileFailure(
        error instanceof RevenueCatApiError ? { source: 'revenuecat', status: error.status } : { source: 'other' },
      );
      if (failure.scope === 'rate_limited') {
        // 率の制限。止めて次の回に回す (RevenueCat の案内「止めて再試行」。billing/04 §2.3 P1)。この利用者は試した利用者 (印を書く)、後ろは試さない
        summary.stopped_early = 'rate_limited';
        logger.warn('RevenueCat の率の制限 (429) のため、この回の取り直しを止めました (残りは次の回)', {
          candidates: summary.candidates,
          synced: summary.synced,
        });
        break;
      }
      summary.failed[failure.kind] = (summary.failed[failure.kind] ?? 0) + 1;
      logger.warn('ストアの購読を取り直せませんでした', {
        user_id: candidate.user_id,
        kind: failure.kind,
        scope: failure.scope,
        ...errorFingerprint(error),
      });
      if (failure.scope === 'run') {
        // 回全体の失敗 (届かない・鍵の誤り・5xx): 次の利用者でも同じになるので、この回を止める (この利用者は印で後ろに回る。毎回同じ利用者で止まらない)
        summary.stopped_early = 'revenuecat_unavailable';
        break;
      }
      // 利用者 1 人の失敗: 後ろの利用者を止めない (この利用者は候補に残り、印で次の回は後ろに回る)
    }
  }
  if (attemptedUserIds.length > 0) {
    // 試した利用者にだけ印を書く (1 回の RPC)。失敗はそのまま投げる (取り直しと写しは済んでいる。route が 500)
    await deps.reconcileRepository.markReconcileAttempted({ userIds: attemptedUserIds, attemptedAt: startedAt });
  }
  summary.elapsed_ms = now().getTime() - startedAtMs;
  if (countReconcileFailures(summary) > 0) {
    // 取り直せなかった利用者がいる回は失敗として終える (route が 500 → 失敗の監視)。件数は warn と route の error の両方に残る
    logger.warn('取り直せなかった利用者がいるため、この回を失敗として終えます', { ...summary });
    throw new IapReconcileFailedError(summary);
  }
  return summary;
}
```

### 8.4 route `src/app/api/cron/iap-reconcile/route.ts`

```ts
// tsc:skip place=src/app/api/cron/iap-reconcile/route.ts
/**
 * GET /api/cron/iap-reconcile — 期限を過ぎた live なストアの購読の行を RevenueCat から取り直して写す (Vercel Cron。毎時 41 分。billing/04 §9)
 *
 * Webhook の再送 (5 回・約 80 分) が尽きて写らなかった失効・更新を、本人の操作が無くても期限の後 1 時間以内に personal_subscriptions に写す。
 * 本体は src/lib/billing/iap-reconcile-service.ts の reconcileStoreSubscriptions、候補と試した利用者の印は DB の関数 billing_iap_reconcile_candidates /
 * billing_iap_reconcile_mark_attempted (src/lib/billing/iap-reconcile-repository.ts)、取り直しと写像は billing/03 の syncStoreSubscriber → billing_apply_store_subscription。
 *
 * - 認証: Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` (src/lib/cron-auth.ts の requireCronAuth)。
 * - メンテナンス中は何もせず次の回に回す (push-outbox と同じ)。
 * - REVENUECAT_SECRET_API_KEY が未設定なら何もしない (DB にも触れない。変数名は warn のログにだけ書き、応答には出さない)。
 * - IAP_RECONCILE_BATCH_SIZE / IAP_RECONCILE_RECHECK_HOURS で 1 回の件数と再確認の間隔を上書きできる (不正な値は既定値に戻して warn)。
 * - 応答 (JSON): { status: 'maintenance' } / { status: 'not_configured' } / { status: 'idle' | 'processed', ...summary }
 *   (件数だけ。利用者 ID・RevenueCat の生の文は出さない)。取り直せなかった利用者がいる回 (IapReconcileFailedError)・候補の RPC と印の RPC の失敗は
 *   500 (本文は汎用。要約と詳細は app_logs)。
 * - AI を使わない (AI の SDK・Edge Function を import しない。tests/ai-usage-contract.test.ts の CRON_ENTRYPOINTS)。
 */
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isMaintenanceFlagOn } from '@/lib/maintenance-mode';
import { RevenueCatNotConfiguredError, type RevenueCatGateway } from '@/lib/billing/iap-core';
import { createRevenueCatGateway } from '@/lib/billing/revenuecat-gateway';
import { createIapRepository } from '@/lib/billing/iap-repository';
import { createIapReconcileRepository } from '@/lib/billing/iap-reconcile-repository';
import { reconcileStoreSubscriptions } from '@/lib/billing/iap-reconcile-service';
import { IapReconcileFailedError, resolveIapReconcileSettings } from '@/lib/billing/iap-reconcile-core';

// fetch (RevenueCat) と supabase-js を使うので Node.js ランタイムで動かす
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// supabase-js の RPC (POST) と RevenueCat への fetch を、同じ内容でも毎回送る (app-log-alerts の route と同じ理由で明示する)
export const fetchCache = 'force-no-store';
// 根拠は IAP_RECONCILE_MAX_DURATION_SECONDS (src/lib/billing/iap-reconcile-core.ts)。route segment config はリテラルだけ (一致はテスト 28)
export const maxDuration = 60;

/** 構造化ログ (app_logs.function_name) の名前。cron/push-outbox と同じ付け方 (失敗の監視の候補の LIKE 'cron/%' に当たる) */
const ROUTE_NAME = 'cron/iap-reconcile';

export async function GET(req: Request) {
  // 1. 認証 (401 / 503)
  const authError = await requireCronAuth(req);
  if (authError) return authError;
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);
  // 2. メンテナンス中は何もせず次の回へ (operator/11 の R-14 と同じ)
  if (await isMaintenanceFlagOn()) {
    return NextResponse.json({ status: 'maintenance' });
  }
  // 3. 鍵が無ければ何もしない (DB にも触れない。変数名は warn にだけ書く)
  let gateway: RevenueCatGateway;
  try {
    gateway = createRevenueCatGateway();
  } catch (error) {
    if (error instanceof RevenueCatNotConfiguredError) {
      logger.warn('REVENUECAT_SECRET_API_KEY が未設定のため、ストアの購読の取り直しを行いません');
      return NextResponse.json({ status: 'not_configured' });
    }
    return internalError(ROUTE_NAME, error, { requestId });
  }
  // 4. 環境変数の値の解釈 (不正な値は既定に戻して warn。値そのものは書かない)
  const settings = resolveIapReconcileSettings({
    batchSize: process.env.IAP_RECONCILE_BATCH_SIZE,
    recheckHours: process.env.IAP_RECONCILE_RECHECK_HOURS,
  });
  if (settings.ignored.length > 0) {
    logger.warn('ストアの購読の取り直しの環境変数の値が正しくないため、既定値を使います', { ignored_env: settings.ignored });
  }
  // 5. 候補を選ぶ → 1 人ずつ取り直す
  try {
    const summary = await reconcileStoreSubscriptions(
      { gateway, repository: createIapRepository(), reconcileRepository: createIapReconcileRepository() },
      settings,
    );
    if (summary.candidates > 0) {
      logger.info('ストアの購読の取り直しを処理しました', { ...summary });
    }
    // ログの保存 (回の要約。待たずに進む) は、createLogger が 1 行ごとに保存が終わるまで関数を止めさせない (#1909)。route では延命しない
    return NextResponse.json({ status: summary.candidates === 0 ? 'idle' : 'processed', ...summary });
  } catch (err) {
    // 6. 取り直せなかった利用者がいる回・候補の RPC と印の RPC の失敗・想定外は 500 (本文は汎用。app_logs の error → app-log-alerts の cron_failure)。
    //    取り直せなかった回は要約 (件数と種類だけ) を error の metadata に残す
    if (err instanceof IapReconcileFailedError) {
      return internalError(ROUTE_NAME, err, { requestId, summary: err.summary });
    }
    return internalError(ROUTE_NAME, err, { requestId });
  }
}
```

### 8.5 既存ファイルの差分

段 A: `src/lib/account-export-tables.ts` の `ACCOUNT_EXPORT_EXCLUDED` の「運営・内部の記録」の `billing_customers` の項の直後に足す 2 行 (逐語。F24。足さないと段 A の migration で `tests/account-export-tables.test.ts` の「分類されていない表が無い」が赤になる):

```ts
// tsc:skip insert=src/lib/account-export-tables.ts
  iap_reconcile_attempts:
    'ストアの購読の定期の取り直しで、利用者を最後に候補に選んだ時刻 (候補の順番を回す内部の印。billing/04 §6.2)。本人が入力したデータではなく、本人が読める RLS ポリシーも無い。service_role だけが読み、退会で消える',
```

以下は段 B。`src/lib/env.ts` の `SERVER_ENV_VARS` に、`REVENUECAT_WEBHOOK_SECRET` の項の直後に足す 2 項 (逐語):

```ts
// tsc:skip insert=src/lib/env.ts
  IAP_RECONCILE_BATCH_SIZE: {
    required: false,
    description:
      'ストアの購読の定期の取り直し (GET /api/cron/iap-reconcile。毎時) で、1 回に選ぶ利用者の数 (1〜40 の整数。既定の 40 人より下げる向きだけ。billing/04 §8.1)',
    whenMissing: '既定の 40 人 (予算 40 秒 ÷ RevenueCat への間隔 1 秒 = 1 回に試せる上限)。範囲外・整数でない値も既定に戻る (warn ログに変数名だけが残る)',
    readOnlyBy: 'src/app/api/cron/iap-reconcile/route.ts',
  },
  IAP_RECONCILE_RECHECK_HOURS: {
    required: false,
    description:
      'ストアの購読の定期の取り直しで、期限の後に取り直しても live のままの行 (ストアの猶予期間など) を次に取り直すまでの間隔 (1〜168 の整数。時間。billing/04 §8.1)',
    whenMissing: '既定の 6 時間。範囲外・整数でない値も既定に戻る (warn ログに変数名だけが残る)',
    readOnlyBy: 'src/app/api/cron/iap-reconcile/route.ts',
  },
```

`.env.example` の `REVENUECAT_WEBHOOK_SECRET=` の行の直後に足す 5 行 (逐語):

```text
# ストアの購読の定期の取り直し (GET /api/cron/iap-reconcile。毎時 41 分。billing/04)。どちらも任意。
# 1 回に選ぶ利用者の数 (1〜40。空なら 40 人。下げる向きだけ) と、期限の後に取り直しても live のままの行を次に取り直すまでの間隔 (1〜168 時間。空なら 6 時間)。
# 整数だけ。範囲外・整数でない値は既定値に戻る (warn ログに変数名だけが残る)。
IAP_RECONCILE_BATCH_SIZE=
IAP_RECONCILE_RECHECK_HOURS=
```

`vercel.json` の `crons` の末尾 (`login-alerts` の行の後) に足す 1 本 (逐語。`IAP_RECONCILE_CRON_PATH`・`IAP_RECONCILE_SCHEDULE_UTC` と同じ値):

```json
    {
      "path": "/api/cron/iap-reconcile",
      "schedule": "41 * * * *"
    }
```

`ENV_SETUP.md`: (1) 「3 つの保管場所」の表の `Vercel の環境変数 | CRON_SECRET` の行 (`:94`) の path の列挙 `…・`/api/cron/login-alerts`（どれも `vercel.json` の `crons`）` を `…・`/api/cron/login-alerts`・`/api/cron/iap-reconcile`（どれも `vercel.json` の `crons`）` にする (`tests/env-setup-cron-secret-crons.test.ts` が集合の一致を見る)。(2) Push 通知の環境変数の表 (`:423` の `PUSH_OUTBOX_BATCH_SIZE` の行がある表) の後に、同じ列の形で「ストアの購読の定期の取り直し（`GET /api/cron/iap-reconcile`。毎時 41 分。billing/04）」の小節を足し、`IAP_RECONCILE_BATCH_SIZE`（任意。1〜40。既定 40。下げる向きだけ）と `IAP_RECONCILE_RECHECK_HOURS`（任意。1〜168。既定 6）の 2 行と、「`REVENUECAT_SECRET_API_KEY` が無い間は何もしない（200 `not_configured`）」の 1 文を書く。

---

## 9. API 仕様

### 9.1 `GET /api/cron/iap-reconcile` — ストアの購読の定期の取り直し

| 項目 | 内容 |
|---|---|
| 呼ぶ側 | Vercel Cron (`vercel.json`。`41 * * * *` = 毎時 41 分)。運営の手動の実行は operator/09 §5.3 と同じ (`curl -H "Authorization: Bearer $CRON_SECRET" https://<サイト>/api/cron/iap-reconcile`) |
| 認証 | `requireCronAuth` (`Authorization: Bearer <CRON_SECRET>`。`CRON_SECRET_PREVIOUS` も受理)。無い・不一致は 401 `{ error: 'unauthorized' }`、未設定は 503 `{ error: 'cron_disabled' }` (既存の型。DB に触れない) |
| 本文 | 読まない (GET。クエリも読まない) |
| 流れ | 認証 → `isMaintenanceFlagOn()` (ON なら `maintenance`) → `createRevenueCatGateway()` (鍵が無ければ `not_configured`) → `resolveIapReconcileSettings` (環境変数。不正な値は既定 + warn) → `reconcileStoreSubscriptions(deps, settings)` (§8.3。候補を読む → 1 人ずつ取り直す → 試した利用者に印を書く) → 応答 |
| 応答 200 | `{ status: 'maintenance' }` / `{ status: 'not_configured' }` / `{ status: 'idle' \| 'processed', candidates, synced, applied, stale, ended, no_subscription, skipped_unknown, rejected: { [code]: n } (code は `IAP_RECONCILE_REJECTED_CODES` の 2 値), failed: {}, stopped_early: 'budget' \| 'rate_limited' \| null, oldest_period_end: string \| null, elapsed_ms }` (`idle` = 候補 0。200 の `failed` はいつも空。1 以上なら 500)。件数だけで、利用者 ID・RevenueCat の生の文・環境変数の値は載せない |
| 応答 500 | `internalError` の固定の本文 (`{ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }`。`src/lib/api/errors.ts` の既存の形)。取り直せなかった利用者がいた回 (`IapReconcileFailedError`: 回全体の失敗 = 届かない・401 / 403・5xx でその回を止めた、か、利用者 1 人の失敗 = 応答の形の違い・そのほかの 4xx・運営の処置の 2 つ以外の写像の失敗 (`BILL_UNKNOWN_PLAN`・`BILL_UNKNOWN_IAP_STATUS` を含む) で、後ろの利用者を取り直したあと)・候補を読む RPC と印を書く RPC の失敗・想定外。`app_logs` に `function_name = 'cron/iap-reconcile'`・`level = 'error'` の固定の文 (`IapReconcileFailedError` なら metadata に要約) が残り、`app-log-alerts` の `cron_failure` が運用メールにする |
| キャッシュ | `dynamic = 'force-dynamic'`・`fetchCache = 'force-no-store'` |
| 実行時間 | `maxDuration = 60`。処理の予算は 40 秒 (`IAP_RECONCILE_RUN_BUDGET_MS`) |
| レート制限 | 当社側 (`checkRateLimit`) は使わない (cron の認証で足りる。既存の cron と同じ)。RevenueCat 側は 1 秒に 1 人の間隔と 429 で止める規則 (§8.3) |
| メンテナンス | `/api/cron` は middleware が通す (F16) ので、route が自分で `isMaintenanceFlagOn()` を見て何もしない |
| 凍結・同意 | 関係ない (利用者の操作ではない。写像は凍結を見ない。billing/03 §7.3) |

### 9.2 既存の API の差分

無し。`POST /api/webhooks/revenuecat`・`POST /api/billing/iap/sync`・`GET /api/billing/subscription` (遅延の再同期) は変えない。本冊の取り直しで `iap_synced_at` が進むと、その後 5 分は遅延の再同期も取り直さない (`needsLazyResync` の既存の規則)。

## 10. 画面

無し (Web・モバイルの画面は変えない。取り直しの結果は既存の画面 (`/account/billing`・アプリの「プランとお支払い」) が `GET /api/billing/subscription` で読む)。

---

## 11. エラー表

### 11.1 route の応答 (cron 向け。本文は固定の語)

| HTTP | 本文 | 意味 |
|---|---|---|
| 200 | `{ status: 'maintenance' }` | メンテナンス中。何もしない |
| 200 | `{ status: 'not_configured' }` | `REVENUECAT_SECRET_API_KEY` が無い。何もしない (DB にも触れない)。warn 1 行 |
| 200 | `{ status: 'idle', candidates: 0, ... }` | 候補なし |
| 200 | `{ status: 'processed', ..., stopped_early: null }` | 候補を全部取り直した |
| 200 | `{ status: 'processed', ..., stopped_early: 'budget' }` | 予算 (40 秒) で打ち切った。残りは次の回 |
| 200 | `{ status: 'processed', ..., stopped_early: 'rate_limited' }` | RevenueCat の 429 で止めた。残りは次の回 |
| 401 | `{ error: 'unauthorized' }` | `CRON_SECRET` が合わない・無い (`requireCronAuth`) |
| 503 | `{ error: 'cron_disabled' }` | `CRON_SECRET` が未設定 (`requireCronAuth`) |
| 500 | `internalError` の固定の本文 | 取り直せなかった利用者がいた回 (`IapReconcileFailedError`)・候補を読む RPC と印を書く RPC の失敗・想定外。失敗の監視に乗る |

利用者向けのエラーコード (cross/04) は足さない。

### 11.2 処理の中の例外の扱い (`reconcileStoreSubscriptions`)

| 例外 | 出どころ | 扱い |
|---|---|---|
| `BillingRpcError` (`BILL_LIVE_ROW_CONFLICT`) | 写像 (billing/03 §13.3。運営の処置の表あり) | `isIapReconcileRejectedCode` が真。その利用者を飛ばして次へ。`rejected[code] += 1`・warn (`user_id`・`code`)。候補に残る |
| `IapError` (`BILL_IAP_UNKNOWN_PRODUCT`) | `syncStoreSubscriber` (書く前。billing/03 S15) | 同上 |
| `BillingRpcError` (`BILL_UNKNOWN_PLAN` / `BILL_UNKNOWN_IAP_STATUS`) | 写像 (billing/03 §13.3。扱いは失敗) | `isIapReconcileRejectedCode` が偽 → `classifyReconcileFailure({ source: 'other' })` = `user`。`failed['internal'] += 1`・warn (`user_id`・`kind`・`error_name = 'BillingRpcError'`・`error_code` = コード)・次の利用者へ → 回の終わりに 500 |
| `RevenueCatApiError` (`status === 429`) | gateway | `classifyReconcileFailure` = `rate_limited`。その回を止める (`stopped_early: 'rate_limited'`)。warn。`failed` が 0 なら 200 |
| `RevenueCatApiError` (`status: null` = 時間切れ・接続の失敗 / 401 / 403 / 5xx) | gateway | `run` (回全体の失敗)。`failed[revenuecat_unreachable / revenuecat_unauthorized / revenuecat_server_error] += 1`・warn (`user_id`・`kind`)・その回を止める (`stopped_early: 'revenuecat_unavailable'`) → 回の終わりに `IapReconcileFailedError` → 500 |
| `RevenueCatApiError` (そのほかの 4xx = 400・404 など) | gateway | `user` (利用者 1 人の失敗)。`failed['revenuecat_client_error'] += 1`・warn・次の利用者へ → 回の終わりに 500 |
| `RevenueCatApiError` (2xx = 応答の形が `RevenueCatCustomerInfoSchema` に合わない。F6) | gateway | `user`。`failed['revenuecat_unexpected_response'] += 1`・warn・次の利用者へ → 回の終わりに 500 |
| `RevenueCatApiError` 以外 (P0001 の業務コード以外の `PostgrestError`・`listStoreProducts` / `listStoreSubscriptions` の失敗・想定外。F23) | `syncStoreSubscriber` の中 | `user`。`failed['internal'] += 1`・warn (`user_id`・`kind`・`error_name`・`error_code`)・次の利用者へ → 回の終わりに 500 |
| 候補の RPC の失敗 (`PostgrestError`)・想定外の形 (`Error`) | `listReconcileCandidates` | 誰も取り直していないので、そのまま投げる (印の RPC も呼ばない) → 500 |
| 印の RPC の失敗 (`PostgrestError`。DB の障害・退会と同時になった外部キーの違反 23503 など) | `markReconcileAttempted` (ループの後) | 取り直しと写しは済んでいる。そのまま投げる → 500 (`IapReconcileFailedError` より先に投げるので、要約は app_logs に残らない。各利用者の warn は残る)。試した利用者の印が進まないので、次の回も同じ利用者が先に来る |
| `RevenueCatNotConfiguredError` | `createRevenueCatGateway` (route) | ここには来ない (route が先に `not_configured` を返す) |

### 11.3 ログ (`app_logs`)

| level | `function_name` | 文 (固定) | metadata |
|---|---|---|---|
| warn | `cron/iap-reconcile` | `REVENUECAT_SECRET_API_KEY が未設定のため、ストアの購読の取り直しを行いません` | なし |
| warn | `cron/iap-reconcile` | `ストアの購読の取り直しの環境変数の値が正しくないため、既定値を使います` | `{ ignored_env }` (名前だけ) |
| info | `cron/iap-reconcile` | `ストアの購読の取り直しを処理しました` | 要約 (件数だけ)。候補 0 の回は書かない |
| error | `cron/iap-reconcile` | `internalError` の固定の文 | 既存の形 (`error_code`・`requestId`)。`IapReconcileFailedError` なら `summary` (件数と種類だけ) |
| warn | `billing/iap-reconcile-service` | `ストアの購読の取り直しを写せませんでした (運営の処置が要ります)` | `{ user_id, code }` |
| warn | `billing/iap-reconcile-service` | `RevenueCat の率の制限 (429) のため、この回の取り直しを止めました (残りは次の回)` | `{ candidates, synced }` |
| warn | `billing/iap-reconcile-service` | `ストアの購読を取り直せませんでした` | `{ user_id, kind, scope, error_name, error_code }` (例外の文面は書かない) |
| warn | `billing/iap-reconcile-service` | `取り直せなかった利用者がいるため、この回を失敗として終えます` | 要約 |
| (写像) | — | 監査 `admin_audit_logs` の `system.billing.subscription_status_changed` (`details.source = 'iap_reconcile'`) は DB の関数が書く | — |

文は未完成や予定を示す語 (準備中・近日・予定・まだ・これから) を使わない (`tests/no-pending-wording-1911.test.ts` が `src/lib`・`src/app` の文の定数を走査する)。

---

## 12. テスト一覧 (it 名)

### 12.1 単体 (`npm test`。DB も RevenueCat も使わない。段 B)

`tests/billing-iap-reconcile-core.test.ts` (`iap-reconcile-core.ts` を本物で読む。1 は `tests/billing-iap-core.test.ts` の同名の検査と同じ作り):

1. `it('iap-reconcile-core imports only zod (no I/O, no @/lib)')`
2. `it('IAP_RECONCILE_BATCH_SIZE_MAX and IAP_RECONCILE_BATCH_SIZE both equal Math.floor(IAP_RECONCILE_RUN_BUDGET_MS / IAP_RECONCILE_REQUEST_INTERVAL_MS) (= 40) with MIN 1, IAP_RECONCILE_RECHECK_HOURS (6) is within [MIN 1, MAX 168], and IAP_RECONCILE_RUN_BUDGET_MS + REVENUECAT_REQUEST_TIMEOUT_MS is below IAP_RECONCILE_MAX_DURATION_SECONDS * 1000')`
3. `it('IAP_RECONCILE_SOURCE is iap_reconcile, differs from IAP_SYNC_SOURCE and IAP_LAZY_RESYNC_SOURCE, and does not end with IAP_SUPERSEDED_SOURCE_SUFFIX')`
4. `it('resolveIapReconcileSettings returns the defaults for undefined / blank, keeps in-range integers, and falls back with the variable name in ignored for out-of-range (0, 41 / 0, 169), non-integer (1.5) and non-numeric values')`
5. `it('IapReconcileCandidatesSchema accepts RPC rows (uuid user_id, period_end, nullable synced_at) and rejects a non-uuid user_id, a missing period_end and a non-array')`
6. `it('reconcileFetchDelayMs is 0 before the first fetch, IAP_RECONCILE_REQUEST_INTERVAL_MS minus the elapsed time after a fetch started, and 0 once the interval has passed; isReconcileBudgetExhausted is false at exactly the budget and true 1 ms after')`
7. `it('emptyIapReconcileSummary sets candidates to the length, every count to 0, rejected and failed to {}, stopped_early to null, oldest_period_end to the earliest period_end among the candidates even when it is not the first (null for none) and elapsed_ms to 0; countReconcileFailures sums failed over every kind')`
8. `it('classifyReconcileFailure maps RevenueCat status null / 401 / 403 / 500 / 503 to run with revenuecat_unreachable / revenuecat_unauthorized / revenuecat_server_error, 429 to rate_limited, 400 / 404 to user with revenuecat_client_error, 200 to user with revenuecat_unexpected_response, and source other to user with internal; every kind is in IAP_RECONCILE_FAILURE_KINDS; IAP_RECONCILE_REJECTED_CODES is exactly [BILL_LIVE_ROW_CONFLICT, BILL_IAP_UNKNOWN_PRODUCT] and isIapReconcileRejectedCode is true for those two and false for BILL_UNKNOWN_PLAN / BILL_UNKNOWN_IAP_STATUS / BILL_IAP_SYNC_CONFLICT')`
9. `it('IapReconcileFailedError keeps the summary, has the name IapReconcileFailedError and a fixed message that contains no user id')`
10. `it('IAP_RECONCILE_BATCH_SIZE_MAX is at most the c_max_users constant, declared with the same value in both billing_iap_reconcile_candidates and billing_iap_reconcile_mark_attempted, in the one migration ending with _billing_iap_reconcile.sql')`

`tests/billing-iap-reconcile-service.test.ts` (`reconcileStoreSubscriptions` を本物で動かす。gateway・`IapRepository`・`IapReconcileRepository` (`listReconcileCandidates`・`markReconcileAttempted` の呼び出しを記録する)・`sleep`・`now` は偽物。`@/lib/db-logger` は `vi.mock`。`syncStoreSubscriber` は本物を通す (`tests/billing-iap-service.test.ts` の `makeRepository` と同じ偽物の作り)):

11. `it('reconcileStoreSubscriptions lists candidates with now / recheckHours / limit = batchSize, syncs each user in the returned order with source iap_reconcile through the given gateway and repository, sums the outcomes (synced / applied / stale / ended / no_subscription / skipped_unknown), and after the loop calls markReconcileAttempted once with every synced user id in order and attemptedAt equal to the listing now')`
12. `it('reconcileStoreSubscriptions does not sleep before the first fetch and sleeps IAP_RECONCILE_REQUEST_INTERVAL_MS minus the elapsed time between the starts of consecutive fetches (a fetch slower than the interval gets no sleep)')`
13. `it('reconcileStoreSubscriptions stops with stopped_early = budget once now() minus the start exceeds IAP_RECONCILE_RUN_BUDGET_MS, leaving the remaining candidates untouched (not synced and not passed to markReconcileAttempted, which receives only the users tried before the stop), and sets elapsed_ms; when the budget is already exceeded before the first user, markReconcileAttempted is not called')`
14. `it('reconcileStoreSubscriptions skips a user whose sync throws BillingRpcError (BILL_LIVE_ROW_CONFLICT) or IapError (BILL_IAP_UNKNOWN_PRODUCT), counts it in rejected by code, logs a warn with user_id and code, continues with the next user, passes the skipped user to markReconcileAttempted, and returns without throwing')`
15. `it('reconcileStoreSubscriptions stops with stopped_early = rate_limited and returns the summary without throwing on RevenueCatApiError status 429, logging a warn; markReconcileAttempted receives the users up to and including the one that got 429, not the later ones')`
16. `it('reconcileStoreSubscriptions on RevenueCatApiError status null / 401 / 403 / 503 for the first user counts failed by kind, sets stopped_early = revenuecat_unavailable, does not fetch the next user, marks only the first user, and throws IapReconcileFailedError carrying the summary')`
17. `it('reconcileStoreSubscriptions on a per-user failure of the first user (RevenueCatApiError status 200 unexpected shape, status 404, a BillingRpcError BILL_UNKNOWN_PLAN or BILL_UNKNOWN_IAP_STATUS from applyStoreSubscription (kind internal, error_code = the code, rejected stays {}), or a non-business PostgrestError from applyStoreSubscription) counts failed by kind, logs a warn with user_id / kind / error_code, still syncs every later user, marks every user including the failed one, and then throws IapReconcileFailedError whose summary has the later users in synced')`
18. `it('reconcileStoreSubscriptions throws IapReconcileFailedError when a 429 stops a run that already has a per-user failure, rethrows the original error without syncing or marking anyone when listReconcileCandidates fails, and rethrows a markReconcileAttempted failure after the users were synced')`
19. `it('reconcileStoreSubscriptions with no candidates calls neither the gateway, sleep nor markReconcileAttempted and returns candidates 0 / failed {} / stopped_early null / oldest_period_end null')`
20. `it('reconcileStoreSubscriptions counts a user_deleted outcome only in synced (applied / stale unchanged)')`

`tests/api/cron-iap-reconcile-route.test.ts` (route を本物で動かす。`@/lib/billing/iap-reconcile-service`・`@/lib/billing/revenuecat-gateway`・`@/lib/billing/iap-repository`・`@/lib/billing/iap-reconcile-repository`・`@/lib/maintenance-mode`・`@/lib/db-logger` は `vi.mock`。`requireCronAuth` は本物。route はファイルの一番外側で 1 回だけ読む (`tests/api/cron-login-alerts-route.test.ts` と同じ形。テスト・フックの中で import しない)。`CRON_SECRET` のダミーは `dummy-cron-secret-0123456789abcdef` (login-alerts・backup-freshness と同じ値。`.gitleaks.toml` の除外に載っている)):

21. `it('A-1: 401 without Authorization or with a wrong secret and 503 { error: cron_disabled } when CRON_SECRET is unset; the maintenance flag, the gateway, the repositories and the service are not touched')`
22. `it('M-1: returns 200 { status: maintenance } without creating the gateway, reading IAP_RECONCILE_* or calling the service while isMaintenanceFlagOn is true')`
23. `it('K-1: returns 200 { status: not_configured } with one warn (no RPC, no repository, no service) when createRevenueCatGateway throws RevenueCatNotConfiguredError')`
24. `it('E-1: passes valid IAP_RECONCILE_BATCH_SIZE / IAP_RECONCILE_RECHECK_HOURS to the service as batchSize / recheckHours and, for an invalid value, uses the default with a warn whose ignored_env names the variable (the value is not logged)')`
25. `it('R-1: returns 200 { status: idle, ...summary } with no info log for candidates 0, and { status: processed, ...summary } with an info log otherwise; the body has exactly the summary keys and no user ids')`
26. `it('R-2: returns 500 with the fixed internalError body and an app_logs error when the service throws IapReconcileFailedError (the summary is in the error metadata, not in the body) or a PostgrestError; no user id or raw RevenueCat text is in the body')`
27. `it('R-3: builds deps from createRevenueCatGateway / createIapRepository / createIapReconcileRepository and passes them to reconcileStoreSubscriptions (no direct Supabase client)')`
28. `it('C-1: maxDuration literal equals IAP_RECONCILE_MAX_DURATION_SECONDS')`
29. `it('C-2: vercel.json has exactly one cron with path IAP_RECONCILE_CRON_PATH and schedule IAP_RECONCILE_SCHEDULE_UTC, and the 6 existing crons (process-menu-queue / app-log-alerts / email-outbox / push-outbox / backup-freshness / login-alerts) remain')`
30. `it('C-3: requireCronAuth is awaited before isMaintenanceFlagOn (an unauthenticated request never reads the flag)')`

### 12.2 契約 (DB を使わない。migration の文面。段 A。`src/lib/billing/iap-reconcile-*` を import しない)

`tests/billing-iap-reconcile-migration-contract.test.ts` (`tests/billing-manual-plan-grant-migration-contract.test.ts` と同じ作り):

31. `it('exactly one migration ends with _billing_iap_reconcile.sql, the same-numbered rollback exists, and the headers name each other (-- migration: / -- rollback:)')`
32. `it('the migration starts with SET LOCAL lock_timeout; its statements are only CREATE TABLE IF NOT EXISTS iap_reconcile_attempts (user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE, attempted_at timestamptz NOT NULL) with ENABLE ROW LEVEL SECURITY / DROP POLICY IF EXISTS + CREATE POLICY / REVOKE / GRANT / COMMENT on it, CREATE INDEX IF NOT EXISTS idx_personal_subscriptions_iap_reconcile with its COMMENT, and CREATE OR REPLACE FUNCTION billing_iap_reconcile_candidates and billing_iap_reconcile_mark_attempted, each with REVOKE / GRANT / COMMENT; no ALTER TABLE on other tables, no TRIGGER, no cron.schedule, no INSERT / UPDATE / DELETE outside the body of billing_iap_reconcile_mark_attempted, and none inside the body of billing_iap_reconcile_candidates')`
33. `it('iap_reconcile_attempts has RLS enabled with a USING (false) WITH CHECK (false) policy, revokes PUBLIC / anon / authenticated / service_role and grants only SELECT to service_role; billing_iap_reconcile_candidates is STABLE SECURITY DEFINER with SET search_path = empty and #variable_conflict use_column, billing_iap_reconcile_mark_attempted is VOLATILE SECURITY DEFINER with SET search_path = empty, both reference tables as public.* / auth.users, have no dynamic SQL, revoke PUBLIC / anon / authenticated and grant EXECUTE to service_role only')`
34. `it('both functions declare c_max_users as a positive integer CONSTANT; the 22023 guards of billing_iap_reconcile_candidates cover NULL arguments, a non-positive p_recheck_after and p_limit outside 1..c_max_users, and those of billing_iap_reconcile_mark_attempted cover NULL arguments and more than c_max_users ids')`
35. `it('the candidate predicate is verbatim (iap_store IS NOT NULL / status IN trialing, active, past_due / current_period_end IS NOT NULL / current_period_end <= p_now / iap_synced_at IS NULL OR iap_synced_at < current_period_end OR iap_synced_at <= p_now - p_recheck_after) with DISTINCT ON (user_id), the order is ORDER BY a.attempted_at ASC NULLS FIRST, d.due_period_end, d.due_user_id with LIMIT p_limit, billing_iap_reconcile_mark_attempted inserts SELECT u.id, p_attempted_at FROM auth.users AS u WHERE u.id = ANY (p_user_ids) ON CONFLICT ON CONSTRAINT iap_reconcile_attempts_pkey DO UPDATE SET attempted_at = GREATEST(t.attempted_at, EXCLUDED.attempted_at), and the index predicate is iap_store IS NOT NULL AND status IN the same 3 values')`
36. `it('rollback drops both functions with the same signatures, the index and the table iap_reconcile_attempts, and contains no DELETE / UPDATE / TRUNCATE')`
37. `it('migration and rollback comments do not attribute decisions')`

### 12.3 結合 (ローカル Supabase。`tests/integration/rls` に置く。段 A)

`tests/integration/rls/billing-iap-reconcile-candidates-rpc.test.ts`。前提 (ローカル Supabase・`client` の作り・`createUser` (`retryIdempotentSetup` で `user_profiles` を upsert)) は `tests/integration/rls/billing-apply-store-subscription-rpc.test.ts` と同じ。行は `service_role` で `personal_subscriptions` に INSERT する (ストアの行は `iap_store = 'app_store'`・`iap_product_id` = `it.iap-reconcile.${RUN}.pro.month`・`plan_key = 'pro'`・`billing_interval = 'month'`。同じ利用者に 2 本目のストアの行を置く 41 だけ、2 本目は `it.iap-reconcile.${RUN}.pro.year`・`billing_interval = 'year'` (同じ利用者・ストア・商品は 1 行の一意の索引があるため)。43 は写像 `billing_apply_store_subscription` を同じ `user_id`・`iap_store`・`iap_product_id` の snapshot で呼ぶ)。

候補を読む関数は `personal_subscriptions` の全体を読み、38〜41・43・44 は返った配列を丸ごと期待と比べる (自分の利用者に絞らない。期待はその it の利用者だけで組む)。そこで「候補に出るのは、いま走っている it が作った利用者だけ」を次の 3 つで保つ (時刻と片付けの型は `tests/integration/rls/org-challenge-diff-privacy.test.ts` の ① afterEach の片付け・③ 過去の年の時刻と同じ):

1. **時刻は固定の過去の年**: このファイルの時刻 (`p_now`・`current_period_start`・`current_period_end`・`iap_synced_at`・`p_fetched_at`・`expires_date`・`p_attempted_at`) は、どれも下の `at(hours)` で書く。`p_now` と `p_attempted_at` に渡すのは `at(-P_NOW_SPREAD_HOURS)`〜`at(P_NOW_SPREAD_HOURS)` の値だけ。`p_now` の既定は `at(0)` で、ほかの値を渡すのは 39 だけ (行は期限 `at(-RECHECK_HOURS - 2)`・`iap_synced_at = at(-1)`。`p_now = at(0)` では間隔の中なので出ず、`p_now = at(RECHECK_HOURS - 1)` で `iap_synced_at <= p_now - p_recheck_after` の等号に当たって出る)。期限を過ぎた行の期限は `at(-1)` 以前。ほかの結合テストのファイルが作る行の期限は `Date.now()` からの相対 (数日前〜1 年後) なので、どれもこのファイルの `p_now` より後で、候補に出ない (そのファイルの片付けが失敗して残った行も同じ)。結合テストは 1 本ずつ走る (`vitest.integration.config.ts` の `maxWorkers: 1`)。
2. **it ごとの片付け (`afterEach`)**: その it が作った利用者を、下の `deleteTestUsers` で消す。印の表 `iap_reconcile_attempts` は `service_role` が SELECT しかできない (§6.2) ので、印の行は `auth.users` を消した ON DELETE CASCADE で消す (`personal_subscriptions` も CASCADE だが、`billing-apply-store-subscription-rpc.test.ts` の片付けと同じく先に明示で消す。`user_profiles` は CASCADE に任せる)。消したあとに 2 つの表を読み直し、行が残っていれば throw する (片付けの失敗を、次の it の順番の検査の赤に化けさせない)。期限が 2000 年の行を残さないので、ほかのファイルの `now()` で期限を見る処理 (手動付与の日次の失効 `billing_expire_manual_subscriptions` など) にも当たらない。`afterAll` は、`afterEach` が途中で止まって残った利用者を同じ関数で消す安全網。
3. **it ごとに新しい利用者**: どの it も自分で利用者を作る。`describe` の `beforeAll` で利用者を共有しない (42 の `authenticated` の検査も、その it の中でサインインした利用者を使う)。

これで 44 の 2 回目と 3 回目の呼び出しの候補は A・B・C の 3 人だけになり、期待 (〔B, C, A〕 → 〔A, B, C〕) がそのまま成り立つ。ほかの it も、返る配列をその it の利用者だけの期待と丸ごと比べられる。時刻と片付けの形 (説明用の断片。`srAdmin`・`RUN`・`createUser` の残りは参照先と同じ作り):

```ts
// tsc:skip
import { afterAll, afterEach } from 'vitest';

/** 候補の判定の「いま」の起点。ほかの結合テストのファイルの行の期限 (Date.now() からの相対) より十分に前の、固定の過去の時刻 */
const RECONCILE_NOW_MS = Date.parse('2000-01-01T00:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
/** p_now・p_attempted_at に渡す値の、起点からの幅 (時間)。この中なら、ほかのファイルの行の期限は必ず p_now より後 */
const P_NOW_SPREAD_HOURS = 24;
/** 39 などで渡す p_recheck_after (時間)。述語の検査に使うだけの値 (段 A のテストなので、段 B の IAP_RECONCILE_RECHECK_HOURS を import しない) */
const RECHECK_HOURS = 6;
const at = (hours: number): string => new Date(RECONCILE_NOW_MS + hours * HOUR_MS).toISOString();

/** 作った利用者の全部 (afterAll の安全網) と、いま走っている it の分。createUser が両方に積む */
const createdUserIds: string[] = [];
const currentTestUserIds: string[] = [];

async function deleteTestUsers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const audits = await srAdmin.from('admin_audit_logs').delete().in('target_id', ids); // 43 の写像が監査を書く
  if (audits.error) throw new Error(`admin_audit_logs: ${audits.error.message}`);
  const subscriptions = await srAdmin.from('personal_subscriptions').delete().in('user_id', ids);
  if (subscriptions.error) throw new Error(`personal_subscriptions: ${subscriptions.error.message}`);
  for (const id of ids) {
    // iap_reconcile_attempts と user_profiles は auth.users の ON DELETE CASCADE で消える
    const { error } = await srAdmin.auth.admin.deleteUser(id);
    if (error) throw new Error(`deleteUser: ${error.message}`);
    const index = createdUserIds.indexOf(id);
    if (index >= 0) createdUserIds.splice(index, 1);
  }
  for (const table of ['personal_subscriptions', 'iap_reconcile_attempts'] as const) {
    const left = await srAdmin.from(table).select('user_id').in('user_id', ids);
    if (left.error) throw new Error(`${table}: ${left.error.message}`);
    if ((left.data ?? []).length > 0) throw new Error(`${table} にこの it の利用者の行が残った`);
  }
}

afterEach(async () => {
  await deleteTestUsers(currentTestUserIds.splice(0));
});

afterAll(async () => {
  await deleteTestUsers([...createdUserIds]);
});
```

38. `it('returns one row per user for live store rows past current_period_end whose iap_synced_at is null or earlier than current_period_end, ordered by period_end then user_id among never-attempted users, limited by p_limit')`
39. `it('excludes a row synced after its current_period_end within p_recheck_after and includes it once iap_synced_at <= p_now - p_recheck_after')`
40. `it('excludes Stripe rows, manual rows, expired / cancelled store rows, rows with current_period_end NULL and rows whose period has not ended')`
41. `it('a user with an expired store row and a live store row past its end appears once with the live row period_end')`
42. `it('billing_iap_reconcile_candidates raises 22023 for p_limit 0 and 201, for a zero or negative p_recheck_after and for NULL arguments; anon and authenticated cannot execute it or select iap_reconcile_attempts (42501)')`
43. `it('after billing_apply_store_subscription writes an expired snapshot with p_fetched_at after current_period_end, the user is no longer returned; after a renewed snapshot (expires_date in the future) it is no longer returned either')`
44. `it('billing_iap_reconcile_candidates writes no iap_reconcile_attempts row; with due users A, B, C (A oldest) and p_limit 3, after billing_iap_reconcile_mark_attempted marks only A (B and C returned but not tried), the next call returns B and C before A; after marking B and C later than A, the next call returns A first again (a user that stays due is not returned first every time)')`
45. `it('billing_iap_reconcile_mark_attempted sets attempted_at = p_attempted_at, keeps the later time when called again with an earlier one (GREATEST), writes a duplicated id once, skips ids that are not in auth.users without error, raises 22023 for NULL arguments and for 201 ids, and anon and authenticated cannot execute it (42501)')`

### 12.4 受け入れ (整合ゲート。実機)

46. 本番で `curl -H "Authorization: Bearer $CRON_SECRET" https://<サイト>/api/cron/iap-reconcile` が 200 を返し、`REVENUECAT_SECRET_API_KEY` の有無に応じて `not_configured` か `idle` であること。Vercel の Cron Jobs の画面に `/api/cron/iap-reconcile` が毎時の予定で載り、直近の実行が 200 であること。`app_logs` に `cron/iap-reconcile` の error が無いこと。

### 12.5 シナリオ ⇄ テスト

並行 (S5・S6・S14) の扱い: 写像の直列 (`billing-user:<uuid>` の advisory lock) と `p_fetched_at` の単調は billing/03 の写像 `billing_apply_store_subscription` の性質で、本冊はその関数を変えないので、同時の書き込みの検査は billing/03 の結合テスト 67 (`is monotonic by p_fetched_at (older fetch is stale) and idempotent for the same snapshot`) が受け持つ。本冊のテストが見るのは、写像が返した `stale` を要約に数えること (11) と、候補を読む関数が何も書かないこと (32 の文面・44)、印を書く関数が新しい方の時刻を残すこと (35 の文面・45 の `GREATEST`) まで。2 つの回を本当に同時に走らせる検査は置かない (重なりを時刻で作る検査は揺れるため。重なっても、候補の関数は読むだけ・写像は billing/03 の鍵で直列・印は `GREATEST` で、どの順でも結果が同じことを上の 3 つで見る)。

| シナリオ | テスト |
|---|---|
| S1 失効が届かない | 11・35・38・43 (遷移は billing/03 の結合テスト「transitions active → expired …」が担う) |
| S2 更新が届かない | 11・43 |
| S3 ストアの猶予期間 | 39・35 |
| S4 期限の直前の同期 | 38・35 |
| S5 遅延の再同期と同時 / S6 Webhook と同時 | 11 (写像が返した `stale` を要約の `stale` に数える)・billing/03 の結合テスト 67「is monotonic by p_fetched_at …」(写像の直列と単調。上の注) |
| S7 鍵が無い | 23 |
| S8 RevenueCat の失敗・鍵の誤り (回全体) | 8・16 (印は 1 人目だけ)・26 |
| S9 429 | 8・15 (印は 429 の利用者まで)・18・25 |
| S10 候補が上限を超える | 2 (上限 = 予算 ÷ 間隔)・4 (環境変数は 40 まで)・12・13・38 (p_limit)・44 |
| S11 運営の処置が要る行 | 8・14・25・44 |
| S12 メンテナンス中 | 22 |
| S13 対象外の行 | 40・35 |
| S14 回の二重 | 32・44 (候補の関数は何も書かない)・35・45 (印は `GREATEST`)・11 (`stale` の数え方)・billing/03 の結合テスト 67 (monotonic) |
| S15 退会 | 20・32 (ON DELETE CASCADE)・45 (`auth.users` に無い利用者の印は飛ばす)・`auth-users-fk-on-delete` の `EXPECTED_ACTIONS` (§14.1) |
| S16 利用者 1 人だけ取り直せない | 8・17 (失敗した利用者にも印)・26 |
| S17 取り直せない利用者が上限より多い | 14・17 (試した利用者に印)・44 |
| S18 選んだ利用者を 1 回で試しきれない | 13 (予算で止めた後ろには印を書かない)・15・16・44 (印の無い利用者が次の回で先) |

---

## 13. 段分け・触るファイルの母集合・新設一覧

### 13.1 段分け (1 つの B 型 WF の中で段ごとに 2 枚レビュー。段 A は単独でマージしてよい)

| 段 | 内容 | ファイル | テスト |
|---|---|---|---|
| A: DB 層 | migration + rollback (§6)・`database.types.ts` の再生成 (2 本)・契約テスト・結合テスト・印の表の分類 3 か所 (F24。新しい表が migration と同時に見張りに当たるため) | §6・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・`tests/billing-iap-reconcile-migration-contract.test.ts`・`tests/integration/rls/billing-iap-reconcile-candidates-rpc.test.ts`・`src/lib/account-export-tables.ts` (§8.5)・`tests/legal-text-1901.test.ts`・`tests/integration/security/auth-users-fk-on-delete.test.ts` (§14.1) | 31〜45 と §14.1 の段 A の行。どれも段 B の `src/lib/billing/iap-reconcile-*` を import しない |
| B: サーバ層 | `iap-reconcile-core.ts`・`iap-reconcile-repository.ts`・`iap-reconcile-service.ts`・route・`env.ts`・`.env.example`・`ENV_SETUP.md`・`vercel.json`・単体テスト・既存の番兵の追随 (§14.1)・設計書の本数の追随 (§14.2 の「段 B と同じ PR」の行。オーケストレーターの専権 PATCH を段 B の PR に合流させる) | §8・§14 | 1〜30 と §14.1 の段 B の行 |

段 B は段 A のマージ後 (型の再生成済み。`admin.rpc('billing_iap_reconcile_candidates', …)`・`admin.rpc('billing_iap_reconcile_mark_attempted', …)` が型で通り、テスト 10 が読む migration がある)。段 A の本番の適用 (追加だけの migration) はマージの前に行う (関数が無いまま新しい Web が出ると route が毎時 500 になるため。段 A のマージ → 本番の適用 → 段 B のマージの順)。段 A は 2 ファイル + 型 2 本 + テスト 2 本 + 分類 3 か所の 9 ファイルで 15 以内。段 B は 4 ファイル + 既存 4 ファイル + テスト 3 本 + 番兵 5 本 (§13.2) + 設計書 5 冊の 21 ファイルで 15 を超えるので、段 B のレビューは分割パネル (サーバ層 8 本・テストと番兵 8 本・設計書 5 冊の各担当 + 横断整合) で行う。

### 13.2 触るファイルの母集合 (閉じた一覧。これ以外を触ったら blocking。例外は §14.1 冒頭の「母集合の作り方」で新たに出た、同じ型の行がそのまま当てはまるファイルだけ)

新設:
- `supabase/migrations/<番号>_billing_iap_reconcile.sql`・`supabase/rollbacks/<番号>_billing_iap_reconcile.down.sql`
- `src/lib/billing/iap-reconcile-core.ts`・`iap-reconcile-repository.ts`・`iap-reconcile-service.ts`
- `src/app/api/cron/iap-reconcile/route.ts`
- テスト: `tests/billing-iap-reconcile-core.test.ts`・`tests/billing-iap-reconcile-service.test.ts`・`tests/api/cron-iap-reconcile-route.test.ts`・`tests/billing-iap-reconcile-migration-contract.test.ts`・`tests/integration/rls/billing-iap-reconcile-candidates-rpc.test.ts`

変更:
- `src/lib/env.ts`・`.env.example`・`ENV_SETUP.md`・`vercel.json`
- `src/types/database.types.ts`・`packages/shared/src/database.types.ts` (再生成)
- 印の表の分類 (段 A。F24): `src/lib/account-export-tables.ts` (`ACCOUNT_EXPORT_EXCLUDED`。§8.5)・`tests/legal-text-1901.test.ts` (`PRIVACY_DATA_TABLES`)・`tests/integration/security/auth-users-fk-on-delete.test.ts` (`EXPECTED_ACTIONS`)・`tests/jst-today-source-scan.test.ts` (`TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX` に `period_end`。候補を読む関数の戻りの列。段 A の実装で見つかった行)
- 既存の番兵 (§14.1): `tests/ai-usage-contract.test.ts` (`CRON_ENTRYPOINTS`)・`tests/helpers/ai-consent-enforced-paths.ts` (`EXEMPT_ROUTES`)・`tests/ai-consent-enforcement.test.ts` (Vercel の cron の it。`EXEMPT_ROUTES` も見る形に)・`tests/cron-failure-monitoring-contract.test.ts` (it 名と既知の一覧)・`src/__tests__/lib/env.test.ts` (`sealed` と `typeOnly`)
- docs (§14.2。段 B と同じ PR): `docs/design/operator/08-cron-batches.md`・`10-logs-and-mail-retry.md`・`11-ops-batches-non-billing.md`・`12-cron-secret-drift-monitor.md`・`docs/design/billing/04-iap-reconcile.md` (本書)。別の docs PR: `docs/design/billing/03-paid-plans-and-iap.md`・`docs/design/CLAUDE.md`・`docs/design/operator/09-runbook.md`

触らない (凍結): `src/lib/billing/iap-core.ts`・`iap-service.ts`・`revenuecat-gateway.ts`・`iap-repository.ts`・`repository.ts`・`service.ts`・`http.ts`・`core.ts`・`src/app/api/webhooks/revenuecat/route.ts`・`src/app/api/billing/**`・`src/lib/cron-auth.ts`・`src/lib/maintenance-mode.ts`・`src/lib/api/errors.ts`・`src/lib/ops-alerts/**`・`src/app/api/cron/app-log-alerts/route.ts`・既存の migration (`20261021100000_billing_paid_plans_iap.sql` ほか)・`supabase/baseline/**`・`tests/billing-iap-core.test.ts`・`tests/billing-iap-service.test.ts`・`tests/api/billing-iap-routes.test.ts`・`tests/webhooks-revenuecat-route.test.ts`・`tests/design-doc-vercel-cron-count.test.ts`・`tests/env-setup-cron-secret-crons.test.ts`・`tests/log-cleanup-dau-snapshot-contract.test.ts`・`src/__tests__/api/cron/cron-log-keepalive-1909.test.ts`・`tests/cron-secret-contract.test.ts`・pg_cron のジョブ。

### 13.3 新設一覧 (識別子)

| 種別 | 名前 |
|---|---|
| 表 | `iap_reconcile_attempts` (`user_id uuid` PK・`auth.users` へ ON DELETE CASCADE / `attempted_at timestamptz NOT NULL`。RLS 有効・ポリシー `iap_reconcile_attempts_no_access` (USING false)・service_role は SELECT だけ。書くのは `billing_iap_reconcile_mark_attempted` だけ) |
| DB 関数 | `billing_iap_reconcile_candidates(timestamptz, interval, integer)` (候補を読む。STABLE・SECURITY DEFINER・EXECUTE は service_role だけ。定数 `c_max_users`)・`billing_iap_reconcile_mark_attempted(uuid[], timestamptz)` (試した利用者に印を書く。RETURNS void・VOLATILE・SECURITY DEFINER・EXECUTE は service_role だけ。定数 `c_max_users`) |
| 索引 | `idx_personal_subscriptions_iap_reconcile` (部分索引。`(current_period_end) WHERE iap_store IS NOT NULL AND status IN ('trialing','active','past_due')`) |
| 既存の表の列・トリガー・状態・DB の業務エラー・監査 action_type | 無し |
| 写像の `p_source` の値 | `iap_reconcile` |
| route | `GET /api/cron/iap-reconcile` (Vercel Cron `41 * * * *`) |
| TS モジュール | `src/lib/billing/{iap-reconcile-core,iap-reconcile-repository,iap-reconcile-service}.ts`・`src/app/api/cron/iap-reconcile/route.ts` |
| TS の export (`iap-reconcile-core`) | `IAP_RECONCILE_SOURCE`・`IAP_RECONCILE_CRON_PATH`・`IAP_RECONCILE_SCHEDULE_UTC`・`IAP_RECONCILE_CRON_INTERVAL_MINUTES`・`IAP_RECONCILE_MAX_DURATION_SECONDS`・`IAP_RECONCILE_RUN_BUDGET_MS`・`IAP_RECONCILE_REQUEST_INTERVAL_MS`・`IAP_RECONCILE_BATCH_SIZE_MAX`・`IAP_RECONCILE_BATCH_SIZE`・`IAP_RECONCILE_BATCH_SIZE_MIN`・`IAP_RECONCILE_RECHECK_HOURS`・`IAP_RECONCILE_RECHECK_HOURS_MIN`・`IAP_RECONCILE_RECHECK_HOURS_MAX`・`HTTP_STATUS_TOO_MANY_REQUESTS`・`HTTP_STATUS_UNAUTHORIZED`・`HTTP_STATUS_FORBIDDEN`・`HTTP_STATUS_CLIENT_ERROR_MIN`・`HTTP_STATUS_SERVER_ERROR_MIN`・`IapReconcileSettingEnvName`・`IapReconcileSettingSources`・`IapReconcileSettings`・`resolveIapReconcileSettings`・`IapReconcileCandidateSchema`・`IapReconcileCandidate`・`IapReconcileCandidatesSchema`・`IapReconcileCandidateQuery`・`IapReconcileAttemptMark`・`IapReconcileRepository`・`IAP_RECONCILE_FAILURE_KINDS`・`IapReconcileFailureKind`・`IAP_RECONCILE_REJECTED_CODES`・`IapReconcileRejectedCode`・`isIapReconcileRejectedCode`・`IapReconcileFailureInput`・`IapReconcileFailureClass`・`classifyReconcileFailure`・`IAP_RECONCILE_STOP_REASONS`・`IapReconcileStopReason`・`IAP_RECONCILE_RUN_STATUSES`・`IapReconcileRunStatus`・`IapReconcileSummary`・`emptyIapReconcileSummary`・`countReconcileFailures`・`IapReconcileFailedError`・`reconcileFetchDelayMs`・`isReconcileBudgetExhausted` (46) |
| TS の export (ほか) | `iap-reconcile-repository.ts`: `createIapReconcileRepository` / `iap-reconcile-service.ts`: `IapReconcileDeps`・`IapReconcileRunSettings`・`reconcileStoreSubscriptions` / route: `runtime`・`dynamic`・`fetchCache`・`maxDuration`・`GET` |
| 環境変数 | `IAP_RECONCILE_BATCH_SIZE`・`IAP_RECONCILE_RECHECK_HOURS` (どちらも任意。`readOnlyBy` = route) |
| ログの `function_name` | `cron/iap-reconcile`・`billing/iap-reconcile-service` |
| 応答の `status` の値 | `maintenance`・`not_configured`・`idle`・`processed` / `stopped_early` の値 `budget`・`rate_limited`・`revenuecat_unavailable` (最後の値は 500 の回の要約にだけ出る) / `failed` のキー = `IAP_RECONCILE_FAILURE_KINDS` の 6 値 / `rejected` のキー = `IAP_RECONCILE_REJECTED_CODES` の 2 値 |
| 定期実行の入口の名前 (`CRON_ENTRYPOINTS`) | `vercel:/api/cron/iap-reconcile` |

---

## 14. 追随表

### 14.1 既存の番兵 (契約テスト・走査テスト) の追随

grep の語 = 本冊が足す・変える名前: `api/cron`・`vercel.json`・`crons`・`CRON_ENTRYPOINTS`・`EXEMPT_ROUTES`・`readOnlyBy`・`IAP_RECONCILE`・`iap-reconcile`・`iap_reconcile`・`billing_iap_reconcile_candidates`・`billing_iap_reconcile_mark_attempted`・`iap_reconcile_attempts`・`personal_subscriptions`・`ACCOUNT_EXPORT_EXCLUDED`・`PRIVACY_DATA_TABLES`・`EXPECTED_ACTIONS`・`cron.schedule`・`6 本`・`REVENUECAT_SECRET_API_KEY`・`iap_synced_at`・`getSupabaseAdmin`・`requireCronAuth`・`internalError`・`createLogger`。

**母集合の作り方** (実装の各段の最初に origin/main で流し直す。表に無いファイルが出たら、同じ型の行の「直し方」がそのまま当てはまるときに限り直してよい。当てはまらなければ報告する):
1. `vercel.json` の crons の数・名前を読むテスト: `git grep -l "vercel.json" origin/main -- tests src scripts`。2026-10-22 の origin/main `0fb02e52` では 17 本 (テスト 13 本・コード 4 本。どれも下の行にある。全部の crons を読むのは 7 本、自分の path だけを絞るのは 4 本、残り 2 本とコード 4 本はコメントか別の値で触れるだけ)。
2. `src/app/api/cron/` の route を走査するテスト: `git grep -l "api/cron" origin/main -- tests src/__tests__`。43 本 (どれも下の行にある)。route 自体を読み込む固定の一覧 (`cron-log-keepalive-1909`) と、ディレクトリを `readdirSync` で走査するもの (`cron-failure-monitoring-contract`・`cron-secret-contract` と、`src` を走査する 6 本) と、特定の route の名前を書くだけのものを分けて下の行に。
3. 環境変数の一覧を読むテスト: `git grep -n "readOnlyBy" origin/main -- tests src/__tests__`。2026-10-22 の origin/main `d950a7b1` では 5 本: 一覧の全数を見るのは `src/__tests__/lib/env.test.ts` と `tests/env-source-scan.test.ts` の 2 本。`src/__tests__/lib/plan/entitlements.test.ts` (`:251`・`:277`) と `tests/org-challenges-lib.test.ts` (`:309`) は自分の変数の項だけを名指しで読み、`tests/cron-secret-contract.test.ts` (`:33`) はコメントで触れるだけ (どれも下の行にある)。
4. migration の関数の名前を型と突き合わせるテスト: `tests/database-types-migrations-contract.test.ts`。
5. `@/lib/env` に届く route の一覧: `tests/helpers/ai-consent-enforced-paths.ts` と、それを読む `tests/ai-consent-enforcement.test.ts`・`tests/ai-usage-contract.test.ts`。本冊の route は `revenuecat-gateway.ts` を import するので届く (billing/03 §16.1 の母集合の作り方 1 と同じ)。
6. 設計書の「いま」の本数を読むテスト: `tests/design-doc-vercel-cron-count.test.ts`・`tests/log-cleanup-dau-snapshot-contract.test.ts`・`tests/env-setup-cron-secret-crons.test.ts` (直すのはテストでなく文書。§14.2)。
7. 新しい表 (`user_id` が `auth.users` を指す) を分類するテスト: `git grep -ln "billing_customers" origin/main -- tests src` で先例の表が載る一覧を出す (F24)。分類を持つのは `src/lib/account-export-tables.ts` (`tests/account-export-tables.test.ts` が見る)・`tests/legal-text-1901.test.ts` (T-34)・`tests/integration/security/auth-users-fk-on-delete.test.ts` (`EXPECTED_ACTIONS`) の 3 つ。2026-10-22 の origin/main `67cfec4e` では 13 本で、全部を次のとおり分ける。表の一覧を持つ 4 本 = `src/lib/account-export-tables.ts`・`tests/account-export-tables.test.ts`・`tests/legal-text-1901.test.ts`・`tests/integration/security/auth-users-fk-on-delete.test.ts` (どれも下の行)。生成物 1 本 = `src/types/database.types.ts` (下の `database-types-migrations-contract` の行で再生成)。自分の migration だけを見る 1 本 = `tests/billing-migration-contract.test.ts` (下の行)。`billing_customers` を名指しで読み書きするか、コメントで触れるだけの 7 本 = `src/lib/account-deletion.ts` (`:403` のコメント。退会は `auth.admin.deleteUser` と外部キーの CASCADE に任せ、表の一覧を持たない)・`src/lib/billing/repository.ts` (`:117-130`)・`src/app/api/billing/checkout/route.ts` (`:3` のコメント)・`tests/integration/rls/billing-apply-store-subscription-rpc.test.ts`・`tests/integration/rls/billing-apply-subscription-rpc.test.ts`・`tests/integration/rls/billing-manual-grant-rpc.test.ts`・`tests/integration/security/billing-personal-subscriptions-rls.test.ts` (下の「母集合 7 の残り 7 本」の行)。

| テスト | 反応する語・理由 | 直し方 | 段 |
|---|---|---|---|
| `tests/ai-usage-contract.test.ts` (`:312-333` の `CRON_ENTRYPOINTS`。`scanCronEntrypoints()` が `vercel.json` の crons と migration の `functions/v1/` を集めて `toEqual`。`:412-420` は一覧に無い cron が AI に届かないことを見る) | `vercel:/api/cron/iap-reconcile` が増える。route は `revenuecat-gateway.ts` → `@/lib/env` に届く (`reachesAi` が真) ので、`EXEMPT_ROUTES` (次の行) に載せて `ALL_ROUTES` に入れる | `CRON_ENTRYPOINTS` の `'vercel:/api/cron/login-alerts'` の行の後に足す (逐語): `// #1912 billing/04 期限を過ぎたストアの購読の行を RevenueCat から取り直して写す。import は cron の認証・ログ・Supabase・RevenueCat への fetch だけ` / `'vercel:/api/cron/iap-reconcile': 'ストアの購読の期限切れ・更新を RevenueCat から取り直して写す (AI を使わない)',` | B |
| `tests/helpers/ai-consent-enforced-paths.ts` (`:207` の `EXEMPT_ROUTES`。`:305-317` に billing/03 の 3 行)・`tests/ai-consent-enforcement.test.ts` (`:164` の棚卸しと `:226-232` の「Vercel の cron は、判定を呼ぶ route か、AI へ送らない route だけ」。`reaching` に入る cron は `ENFORCED_ROUTES` に無いと赤) | 新しい route が `@/lib/env` に届く | `EXEMPT_ROUTES` の `'src/app/api/billing/subscription/route.ts'` の項の後に足す (逐語): `'src/app/api/cron/iap-reconcile/route.ts': { consent: 'cron: 期限を過ぎたストアの購読の行を RevenueCat から取り直して写す。AI へは送らない (鍵を読む env.ts の一覧に届くだけ)', handlers: { GET: { noAi: 'RevenueCat から契約を取り直して DB に写すだけ。送る先は RevenueCat と DB' } } },`。`:226-232` の it は `reaching` に入る cron を `ENFORCED_ROUTES` に求める形なので、`EXEMPT_ROUTES` に載せたうえで、この it が `ALL_ROUTES` (= `ENFORCED_ROUTES` と `EXEMPT_ROUTES`) を見る形に改める: `expect(ENFORCED_ROUTES, file).toHaveProperty([file])` を `expect({ ...ENFORCED_ROUTES, ...EXEMPT_ROUTES }, file).toHaveProperty([file])` にし、it 名を `'Vercel の cron は、判定を呼ぶ route か、理由つきで除外した route か、AI へ送らない route だけ'` にする (`EXEMPT_ROUTES` は `:21` で import 済み。import は変えない)。`tests/ai-usage-contract.test.ts:412-420` は `ALL_ROUTES` で見るので変更なし | B |
| `tests/cron-failure-monitoring-contract.test.ts` (`:236` の it 名「vercel.json の crons の 6 本 (backup-freshness・login-alerts を含む)」と `:281` の既知の 6 本の配列。`readdirSync` で全 route を走査し、`createLogger` / `internalError` の名前が `cron/<dir>` で終わることを見る) | 7 本になる。本冊の route は `ROUTE_NAME = 'cron/iap-reconcile'` を `createLogger` と `internalError` に渡す (走査に通る) | it 名を `'src/app/api/cron/*/route.ts が createLogger / internalError に渡す名前は cron/<名前> か <METHOD> /api/cron/<名前> の形 (候補の LIKE と一致する)。vercel.json の crons の 7 本 (backup-freshness・login-alerts・iap-reconcile を含む) のどれもこの走査に入る'` に、`:281` の配列に `'iap-reconcile'` を足す。operator/11 §11.1 (`:1407`) の同じ文も同時に直す (§14.2。`tests/design-doc-vercel-cron-count.test.ts` が両方を `vercel.json` の数と突き合わせる) | B |
| `tests/design-doc-vercel-cron-count.test.ts` (設計書 3 冊 (operator/10 の 1 か所・11 の 4 か所・12 の 3 か所) と上のテストの it 名 1 か所の「6 本」の文、計 9 か所を `vercel.json` の crons の数と突き合わせ、operator/10 §2.1 の行が全部の名前を挙げることを見る) | `vercel.json` が 7 本になる | テストは変えない。文書 8 か所を §14.2 のとおり同じ PR で直す (it 名の 1 か所は上の行) (文の形 (正規表現) を保つ) | B (文書) |
| `tests/env-setup-cron-secret-crons.test.ts` (`ENV_SETUP.md:94` の `CRON_SECRET` の行の `/api/cron/*` の集合 = `vercel.json` の path の集合) | 同上 | `ENV_SETUP.md:94` に `/api/cron/iap-reconcile` を足す (§8.5) | B |
| `tests/log-cleanup-dau-snapshot-contract.test.ts` (`:313-325`: operator/08 §3.0・§3.2 の注記・§5 の注記が `vercel.json` の名前を全部挙げ、§3.0・§3.2 の「の N 本」が実数と同じ。`:327-335`: §3.2 の「この表のほかの N 本」= 表の行数 − 実装済みの行。pg_cron: migration の `cron.schedule` の名前と §3.0・§3.1 の注記) | `vercel.json` が 7 本になる。本冊の migration は `cron.schedule` を呼ばないので pg_cron の数は変わらない | テストは変えない。operator/08 の §3.0・§3.2 の表と注記・§5 の注記を §14.2 のとおり同じ PR で直す | B (文書) |
| `tests/cron-secret-contract.test.ts` (CC-4: `src/app/api/cron/**/route.ts` の全部が `requireCronAuth` を `await` している) | 新しい route | 変更なし (route は `await requireCronAuth(req)` で始まる。走査が自動で拾う) | — |
| `tests/cron-secret-drift-monitor-contract.test.ts` (`readdirSync` は `supabase/migrations` だけ。cron の route は `:587` の `app-log-alerts/route.ts` を名指しで読むだけ)・`scripts/lib/cron-secret-drift.mjs` (`/api/cron/*` は所見の文 `:746` の中だけ。保管場所ごとの `CRON_SECRET` の一致を見て、route を走査しない) | 新しい route | 変更なし (どちらも route の一覧を持たない。本冊は `CRON_SECRET` の保管場所を増やさない) | — |
| `tests/integration/security/cron-failure-monitoring.test.ts` (結合。`app_logs` に試験用の名前 `cron/${TAG}-…` の行を入れて候補の関数を見る)・`src/__tests__/lib/ops-alerts/cron-failure.test.ts` (候補の行の写し方の単体。固定の名前) | 本冊の route の 500 が `cron/iap-reconcile` の名前で候補に入る | 変更なし (どちらも route の一覧を持たない。名前の形 `cron/<名前>` は `cron-failure-monitoring-contract` の走査が見る) | — |
| `src` を `readdirSync` で走査する 6 本: `tests/email-send-throttle-contract.test.ts` (メールを送るファイルに判定か理由つきの除外を求める。`:49-55` は除外の cron の route 2 本)・`tests/email-resend-boundary-scan.test.ts`・`tests/email-suppressed-log-level-scan.test.ts`・`src/__tests__/lib/ops-alerts/send-release.test.ts` (`claim_ops_alert` と `release_ops_alert` を呼ぶ route の固定の 2 本)・`tests/ai-queue-writes-contract.test.ts`・`tests/next16-proxy-convention.test.ts` | 新しい route と `src/lib/billing/iap-reconcile-*.ts` | 変更なし (本冊はメールを送らず (失敗の運用メールは `app-log-alerts` が送る)、`claim_ops_alert` を呼ばず、AI のキューに書かず、proxy / middleware を足さない) | — |
| `vercel.json` の `crons` を自分の path で絞るテスト 4 本: `src/__tests__/api/cron/app-log-alerts.test.ts` (`:1029-1040`)・`src/__tests__/api/cron/backup-freshness.test.ts` (`:659-672`)・`src/__tests__/api/cron/email-outbox.test.ts` (`:323-328`)・`tests/api/cron-login-alerts-route.test.ts` (`:118-124`) | `vercel.json` に 1 本増える | 変更なし (自分の path の行を `toEqual` するか、既存の path が残ることを見るだけで、全数を見ない) | — |
| `vercel.json` にコメントか別の値で触れるだけのもの: `tests/feature-flag-cache-ttl-wiring.test.ts` (`:67-68`。`vercel.json` に `FEATURE_FLAG_CACHE_TTL_MS` が無い)・`tests/e2e/.exploration/weekly-explore.spec.ts` (`:437`)・`scripts/lib/backup-db.mjs` (`:37`)・`src/lib/backups/core.ts` (`:29`)・`src/lib/ops-alerts/app-log-error-spike.ts` (`:8`・`:124-126`・`:402`)・`src/app/api/cron/app-log-alerts/route.ts` (`:49`) | `vercel.json` に 1 本増える | 変更なし (本冊は `vercel.json` に `crons` の 1 行だけを足し、環境変数の行を足さない。コードの 4 本は触らない) | — |
| 母集合 2 の残り 17 本 (既存の route を名指しするか、別のディレクトリを走査するだけ): `src/__tests__/api/cron/process-menu-queue.test.ts`・`push-outbox.test.ts`・`src/__tests__/api/webhooks/resend.test.ts`・`src/__tests__/lib/cron-auth.test.ts`・`src/__tests__/lib/emails/ops/cron-failure.test.ts`・`src/__tests__/lib/ops-alerts/app-log-error-spike.test.ts`・`src/__tests__/lib/ops-alerts/cron-secret-drift.test.ts`・`tests/ai-consent-enforcement-routes.test.ts`・`tests/cron-process-menu-queue-ai-consent.test.ts`・`tests/cron-secret-probe-edge.test.ts`・`tests/e2e/w5-3-menu-gen-adversarial.spec.ts`・`tests/email-suppression-log-docs-1577.test.ts`・`tests/health-middleware-exemption.test.ts`・`tests/integration/rls/ops-alert-state.test.ts`・`tests/legal-claims-1901.ts`・`tests/edge-function-cors.test.ts` (走査は `supabase/functions`)・`tests/security-workflow.test.ts` (走査は `.github/workflows`) | `api/cron` の語 | 変更なし (本冊の route を一覧に求めない) | — |
| `src/__tests__/lib/env.test.ts` (`:419-470` の `sealed` の一覧 (`toEqual`)・`:479-520` の `typeOnly`) | `IAP_RECONCILE_BATCH_SIZE`・`IAP_RECONCILE_RECHECK_HOURS` に `readOnlyBy` | `sealed` の `['FEATURE_FLAG_CACHE_TTL_MS', …]` の行の後 (並びは `.sort()` なので `F` と `L` の間) に 2 行 (逐語): `// #1912 billing/04 ストアの購読の定期の取り直しの 1 回の件数と再確認の間隔。不正な値の扱い (既定値に戻して warn) を cron の route 1 か所に置く` / `['IAP_RECONCILE_BATCH_SIZE', 'src/app/api/cron/iap-reconcile/route.ts'],` / `['IAP_RECONCILE_RECHECK_HOURS', 'src/app/api/cron/iap-reconcile/route.ts'],`。`typeOnly` に 2 行: `// @ts-expect-error IAP_RECONCILE_BATCH_SIZE の値を読むのは cron の route (src/app/api/cron/iap-reconcile/route.ts) だけ (#1912 billing/04)` / `getOptionalEnv('IAP_RECONCILE_BATCH_SIZE');` / `// @ts-expect-error IAP_RECONCILE_RECHECK_HOURS も同じ` / `getOptionalEnv('IAP_RECONCILE_RECHECK_HOURS');`。`:419` の it 名の列挙に `IAP_RECONCILE_*` を足す (`FEATURE_FLAG_CACHE_TTL_MS・` の後) | B |
| `tests/env-source-scan.test.ts` (一覧の全変数が `.env.example` にある・本番コードで値を読むのは `readOnlyBy` のファイルだけ・`process.env.X!` を書かない・`:614-640` の毎分の cron (`process-menu-queue`) が `env.ts` に届かない) | 2 つの環境変数・route が `process.env.IAP_RECONCILE_*` を名前で読む・route は `revenuecat-gateway.ts` 経由で `env.ts` に届く | 変更なし (`.env.example` に 2 行 (§8.5)、読むのは `readOnlyBy` の route だけ、`!` を使わない。`ENTRIES` は `process-menu-queue` だけで、毎時の route は対象外。billing/03 の Webhook の route と同じ) | — |
| `src/__tests__/lib/plan/entitlements.test.ts` (`:251`・`:277`。`aiFeatureDailyCap` が尋ねる変数の `readOnlyBy` が `src/lib/plan/entitlements.ts`)・`tests/org-challenges-lib.test.ts` (`:309`。`SERVER_ENV_VARS.ORG_CHALLENGE_SHOW_NAMES.readOnlyBy`)・`tests/cron-secret-contract.test.ts` (`:33`。コメントだけ) | `readOnlyBy` の語 | 変更なし (どれも自分の変数の項を名前で引くだけで一覧の全数を見ない。本冊の 2 つの変数はどの項でもない) | — |
| `tests/database-types-migrations-contract.test.ts` (migration の `CREATE FUNCTION` の名前が両方の `database.types.ts` の `Functions` にある) | `billing_iap_reconcile_candidates`・`billing_iap_reconcile_mark_attempted` (表 `iap_reconcile_attempts` も型の `Tables` に入る) | 両方の `database.types.ts` を再生成する (operator/09 §3.3 の 5 の手順。270k / 256 で) | A |
| `tests/account-export-tables.test.ts` (`:275` 「分類されていない表が無い」・`:321` 「除外リストの表は、実際にユーザー識別列を持つ」。migration の `CREATE TABLE` を重ねて読む) | 新しい表 `iap_reconcile_attempts` (`user_id`) | テストは変えない。`src/lib/account-export-tables.ts` の `ACCOUNT_EXPORT_EXCLUDED` に 1 項を足す (§8.5 の逐語) | A |
| `tests/legal-text-1901.test.ts` (T-34 `:867-891`: 書き出しの分類の表の集合 = `PRIVACY_DATA_TABLES` と `PRIVACY_DATA_EXCLUDED` の和) | `ACCOUNT_EXPORT_EXCLUDED` に `iap_reconcile_attempts` が増える | `PRIVACY_DATA_TABLES` (`:128`) の `coupon_redemptions: '有料プラン',` の行の後に 1 行 (逐語): `iap_reconcile_attempts: '有料プラン',`。`PRIVACY_DATA_EXCLUDED` の `no_writer` には入れない (関数が INSERT するので、同じ it の「書くコード・INSERT する migration が無い」で赤になる)。第 3 条の「有料プラン」の行は既にあるので文面は変えない | A |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` (D: `auth.users` を指す外部キーの「表.列」の集合 = `EXPECTED_ACTIONS` のキー。`:123`) | 新しい外部キー `iap_reconcile_attempts.user_id` (ON DELETE CASCADE) | `EXPECTED_ACTIONS` の名前の順の並びで `'health_streaks.user_id': 'CASCADE',` (`:191`) の行の後に 1 行 (逐語): `'iap_reconcile_attempts.user_id': 'CASCADE',` | A |
| `tests/jst-today-source-scan.test.ts` (規則 G・H の `TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX` が `supabase/migrations` の timestamptz の宣言のうち名前が `_at` で終わらず `p_` / `v_` / `_` で始まらないものと一致する。`:896-900`) | 候補を読む関数の `RETURNS TABLE (… period_end timestamptz …)` が新しい名前 `period_end` を足す (`synced_at` は `_at` で終わるので増えない) | `TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX` の `'paused_until',` の行の後に 1 行 (逐語): `'period_end',` | A |
| 母集合 7 の残り 7 本 (`billing_customers` を名指しで使うだけ): `src/lib/account-deletion.ts`・`src/lib/billing/repository.ts`・`src/app/api/billing/checkout/route.ts`・`tests/integration/rls/billing-apply-store-subscription-rpc.test.ts`・`tests/integration/rls/billing-apply-subscription-rpc.test.ts`・`tests/integration/rls/billing-manual-grant-rpc.test.ts`・`tests/integration/security/billing-personal-subscriptions-rls.test.ts` | `billing_customers` の語 (先例の表の名前) | 変更なし (どれも利用者に紐づく表の一覧を持たない。新しい表 `iap_reconcile_attempts` は退会で外部キーの CASCADE が消すので、`account-deletion.ts` の手順は変わらない) | — |
| `src/__tests__/lib/maintenance-mode.test.ts` (`:111` の `/api/cronx` は止める = `/api/cron` は通す) | 新しい cron の route | 変更なし (`/api/cron` の prefix で通る。route が自分で `isMaintenanceFlagOn()` を見る。push-outbox と同じ) | — |
| `src/__tests__/api/null-character-routes.test.ts` (本文を読む POST / PUT / PATCH / DELETE の handler の一覧) | GET・本文を読まない | 変更なし | — |
| `tests/supabase-service-role-client-scan.test.ts` (`createClient` を自前で呼ぶファイルの一覧・`:378` の cron の route) | 新しい route と repository | 変更なし (`getSupabaseAdmin` 経由。`createClient` を呼ばない) | — |
| `tests/role-check-source-scan.test.ts`・`tests/api-raw-error-message-scan.test.ts` (`src/app/api` の全 route を走査) | 新しい route | 変更なし (ロールの手書きの判定なし。応答は固定の語と `internalError` だけ。`RevenueCatApiError.rawMessage` を本文に入れない) | — |
| `tests/heavy-unit-test-timeout.test.ts` (テスト・フックの中で route を読み込むファイルは時間切れを延ばす) | 新しい route のテスト | 変更なし (テスト 21〜30 は route をファイルの一番外側で 1 回読む (`tests/api/cron-login-alerts-route.test.ts` と同じ形) ので同じ型にならない) | — |
| `src/__tests__/api/cron/cron-log-keepalive-1909.test.ts` (`:69-74` の固定の 4 本。全数は求めない) | 新しい route | 変更なし (route は自分で延命しない (#1909 の規則)。一覧は固定で、足すのは任意) | — |
| `tests/no-pending-wording-1911.test.ts` (`src/lib`・`src/app` の文の定数に禁止の語が無い) | 新しいログの文 | 変更なし (§11.3 の文は禁止の語を使わない) | — |
| `tests/billing-iap-core.test.ts`・`tests/billing-iap-service.test.ts`・`tests/api/billing-iap-routes.test.ts`・`tests/webhooks-revenuecat-route.test.ts`・`tests/billing-revenuecat-gateway.test.ts` | 親のファイルは変えない | 変更なし | — |
| `tests/billing-paid-plans-migration-contract.test.ts`・`tests/billing-manual-plan-grant-migration-contract.test.ts`・`tests/billing-migration-contract.test.ts` (それぞれ自分の migration だけを見る) | 別ファイルの migration | 変更なし | — |
| `tests/cron-failure-monitoring-contract.test.ts` の 8 (`:213`。migration に 1 時間以内の間隔の pg_cron がある) | 本冊は pg_cron を足さない | 変更なし | — |
| `tests/admin-audit-logs-insert-policy-migration-contract.test.ts` (`admin_audit_logs` に直接 INSERT するファイルの一覧) | 本冊は監査を直接書かない | 変更なし | — |
| `tests/ai-consent-provider-inventory.test.ts` (`NON_AI_HOSTS`) | 新しい外部の host は無い (RevenueCat は billing/03 で登録済み) | 変更なし | — |
| `tests/design-doc-followup-owned-edits.test.ts` (`OWNED_EDITS` に載せた追随の行だけを見る) | 本冊の追随は本数と名前の追加で、`design-doc-vercel-cron-count`・`log-cleanup-dau-snapshot-contract`・`env-setup-cron-secret-crons` が機械で見張る | 変更なし (`OWNED_EDITS` に載せるかはオーケストレーターの docs PR の判断。載せなくても上の 3 本が同じ行を見張る) | — |

### 14.2 他の文書への追随 (専権 PATCH。「段 B と同じ PR」の行は `vercel.json` を変えた瞬間に番兵が赤になるので、段 B の PR に合流させる。ほかは設計ゲート PASS 後の docs PR)

行の番号は origin/main `d950a7b1` での目安で、直す箇所は「」で引いた文で探す (行の番号では探さない。間のマージで行は動く)。

| 文書 | 行 (origin/main `d950a7b1`) | 直し方 | 期日 |
|---|---|---|---|
| `docs/design/operator/08-cron-batches.md` §3.0 | `:17` 「…`login-alerts` (毎分。新しい端末・地域からのログインを本人にメールで知らせる worker。#1190・`cross/16-auth-history-sessions.md` §14.8) の 6 本である。」 | 「…§14.8)・`iap-reconcile` (毎時 41 分。期限を過ぎたストアの購読の行を RevenueCat から取り直して写す。#1912・`billing/04-iap-reconcile.md` §9) の 7 本である。」(`log-cleanup-dau-snapshot-contract` の正規表現「`vercel.json` に登録されている Vercel Cron は…の N 本」を保つ) | 段 B と同じ PR |
| 同 §3.2 の表 | `:178` の `login_alerts` の行の後 | 行を足す: `\| \`iap_reconcile\` (実装済み: #1912・billing/04) \| 毎時 41 分 \| 期限を過ぎたストアの購読の行を RevenueCat から取り直して写す (\`/api/cron/iap-reconcile\`。設計は billing/04 §9) \|` (「実装済み」を含めるので「この表のほかの 10 本」は変わらない) | 段 B と同じ PR |
| 同 §3.2 の注記 | `:180` 「…`login-alerts` (この表の `login_alerts`。#1190) の 6 本。この表のほかの 10 本は…」 | 「…(この表の `login_alerts`。#1190)・`iap-reconcile` (この表の `iap_reconcile`。#1912・billing/04) の 7 本。この表のほかの 10 本は…」 | 段 B と同じ PR |
| 同 §5 の注記 | `:332` 「…`login-alerts` (#1190・cross/16 §14.8) だけで、」 | 「…`login-alerts` (#1190・cross/16 §14.8)・`iap-reconcile` (#1912・billing/04 §9) だけで、」 | 段 B と同じ PR |
| 同 §6.2 | `:549` 「`vercel.json` の 6 本 (`backup-freshness`・`login-alerts` を含む) と `app-log-alerts` 自身の 500 が対象になる。」 | 「`vercel.json` の 7 本 (`backup-freshness`・`login-alerts`・`iap-reconcile` を含む) と `app-log-alerts` 自身の 500 が対象になる。」(この文はどの番兵も見張らない (`design-doc-vercel-cron-count` は operator/10・11・12、`log-cleanup-dau-snapshot-contract` は operator/08 の §3.0・§3.2・§5 だけを見る) ので、段 B の PR の作業者が手で直す) | 段 B と同じ PR |
| 同 §9 の表 | `:651` の `stripe_integrity_check` の行の後 | 行を足す: `\| \`iap_reconcile\` \| RevenueCat の失敗 (429 以外)・RPC の失敗 → route が 500 → \`app-log-alerts\` の \`cron_failure\` (上の Vercel Cron 全般の行)。429 と予算は 200 で止めて次の回 (billing/04 §11) \|` | docs PR |
| `docs/design/operator/10-logs-and-mail-retry.md` §2.1 | `:59` 「  - Vercel Cron: `vercel.json` に …・`login-alerts` (毎分。#1190・#1720 段 B・cross/16 §14.8) の 6 本。」 | 「  - Vercel Cron: `vercel.json` に …・`login-alerts` (毎分。#1190・#1720 段 B・cross/16 §14.8)・`iap-reconcile` (毎時。#1912・billing/04 §9) の 7 本。」(行頭の 2 スペースと末尾の「の 7 本。」の形を保つ) | 段 B と同じ PR |
| `docs/design/operator/11-ops-batches-non-billing.md` §2.1 | `:97` 「いまは #1720 段 B の `cron/login-alerts` (`ROUTE_NAME`) を足した 6 本で、どれも 1 対 1」 | 「いまは #1720 段 B の `cron/login-alerts` (`ROUTE_NAME`) と #1912 billing/04 の `cron/iap-reconcile` (`ROUTE_NAME`) を足した 7 本で、どれも 1 対 1」 | 段 B と同じ PR |
| 同 §4.1 | `:188` 「V[Vercel Cron の route 6 本]」 | 「V[Vercel Cron の route 7 本]」 | 段 B と同じ PR |
| 同 §4.2 | `:223` 「既存の 6 本 (`backup-freshness`・`login-alerts` を含む) はどれも」 | 「既存の 7 本 (`backup-freshness`・`login-alerts`・`iap-reconcile` を含む) はどれも」 | 段 B と同じ PR |
| 同 §11.1 | `:1407` 「vercel.json の crons の 6 本 (backup-freshness・login-alerts を含む) のどれもこの走査に入る」 | 「vercel.json の crons の 7 本 (backup-freshness・login-alerts・iap-reconcile を含む) のどれもこの走査に入る」(テストの it 名と同じ文。行の末尾の閉じの引用符・括弧・バッククォートはそのまま残す) | 段 B と同じ PR |
| `docs/design/operator/12-cron-secret-drift-monitor.md` §0.5 | `:63` 「いまの `vercel.json` の `crons` は 6 本 (上の 5 本と `login-alerts`)。」 | 「いまの `vercel.json` の `crons` は 7 本 (上の 5 本と `login-alerts`・`iap-reconcile` (#1912 billing/04))。」 | 段 B と同じ PR |
| 同 §8.2 | `:1411` 「\| `vercel.json` \| 6 本 \| 6 本 (変えない) \|」 | 「\| `vercel.json` \| 7 本 \| 7 本 (変えない) \|」(operator/12 は変えない、の意味はそのまま) | 段 B と同じ PR |
| `docs/design/operator/12-cron-secret-drift-monitor.md` §14 (§14.1 の番兵の追随表の `tests/cron-failure-monitoring-contract.test.ts` 9 (と 8) の行) | `:1747` 「`vercel.json` の crons の 6 本 (`backup-freshness`・`login-alerts` を含む) が走査に入ることも見る」 | 「`vercel.json` の crons の 7 本 (`backup-freshness`・`login-alerts`・`iap-reconcile` を含む) が走査に入ることも見る」 | 段 B と同じ PR |
| `ENV_SETUP.md` | `:94` と Push 通知の環境変数の表の後 | §8.5 のとおり | 段 B と同じ PR |
| `docs/design/billing/03-paid-plans-and-iap.md` §0.5 Q-11 | `:86` 「…日次の reconcile は配線の残りの冊**」 | 「…定期の取り直し (毎時) は `04-iap-reconcile.md`**」 | docs PR |
| 同 §3.2 S12 | `:270` 「…のどちらかで写る (Q-11)」 | 「…のどちらかで写る (Q-11)。本人が開かない契約は、`04-iap-reconcile.md` の毎時の取り直しが期限の後 1 時間以内に写す」 | docs PR |
| 同 §5.2 の縁の発生源 (2) | `:380` 「…本人の操作からの同期 (3) と遅延の再同期 (§8.4) で受ける。日次の reconcile は配線の残りの冊 (Q-11)。」 | 「…本人の操作からの同期 (3) と遅延の再同期 (§8.4) で受け、本人が開かない契約は `04-iap-reconcile.md` の定期の取り直し (毎時) で受ける (Q-11)。」 | docs PR |
| 同 §18 の 4 | `:5250` 「日次の reconcile (…) は配線の残りの冊」 | 「定期の取り直し (`personal_subscriptions` の期限を過ぎた live なストアの行の利用者を毎時 1 人ずつ取り直す) は `04-iap-reconcile.md` で確定」 | docs PR |
| `docs/design/CLAUDE.md` | `:16` 「…`02-manual-plan-grant.md` (運営者の手動のプラン付与) と、配線の残りの冊 (運用バッチ・運営の Finance 画面ほか。未作成))」 | 「…`02-manual-plan-grant.md` (運営者の手動のプラン付与)・`03-paid-plans-and-iap.md` (有料プランの販売とアプリ内課金)・`04-iap-reconcile.md` (ストアの購読の定期の取り直し) と、配線の残りの冊 (運営の Finance 画面ほか。未作成))」 | docs PR |
| `docs/design/operator/09-runbook.md` §5.3 | `:204-210` (Vercel Cron の手動実行) | 例に `/api/cron/iap-reconcile` を足し、応答の `status`・`stopped_early`・`oldest_period_end` の読み方 (§9.1) を 1 段落で書く (任意) | docs PR |

### 14.3 共有面の台帳 (2 つ以上の PR が触る面)

| 面 | 本冊の PR | 同時に触りうる PR | 直列化 |
|---|---|---|---|
| `vercel.json` の `crons` | 段 B で 1 本足す | ほかの cron を足す案件 (operator/08 §3.2 の未実装の行) | `vercel.json` に触る PR は 1 本ずつ。本数の文 (operator/08・10・11・12・テスト 2 本) も同じ PR で直す |
| `src/lib/env.ts` の `SERVER_ENV_VARS`・`.env.example`・`ENV_SETUP.md`・`src/__tests__/lib/env.test.ts` の `sealed` | 段 B で 2 つ足す | 環境変数を足す案件 | 並行できる (項の追加だけ)。衝突したら main を正に rebase |
| `tests/helpers/ai-consent-enforced-paths.ts` の `EXEMPT_ROUTES`・`tests/ai-usage-contract.test.ts` の `CRON_ENTRYPOINTS` | 段 B で 1 行ずつ | route を足す案件 | 同上 |
| `src/types/database.types.ts`・`packages/shared/src/database.types.ts` | 段 A で再生成 | migration を足す案件 | migration の番号はマージ直前に確定し、型は main の最新の migration の上で再生成する |
| `personal_subscriptions` | 段 A で部分索引 1 本 (列・CHECK・RLS は変えない) | billing/03 の整合の是正・手動付与 | 索引の追加だけなので並行できる |
| 利用者に紐づく表の分類 (`src/lib/account-export-tables.ts`・`tests/legal-text-1901.test.ts`・`tests/integration/security/auth-users-fk-on-delete.test.ts`) | 段 A で 1 行ずつ | 表を足す案件 | 並行できる (項の追加だけ)。衝突したら main を正に rebase |
| `docs/design/operator/08-cron-batches.md` の §3.0・§3.2・§5 | 段 B と同じ PR で本数と名前 | pg_cron / Vercel Cron を足す案件 | 本数の文を直す PR は 1 本ずつ |

---

## 15. 本番の準備と運用 (秘密の値は発注者の作業)

1. 段 A のマージ → 本番への migration の適用 (追加だけ。印の表・関数 2 本・索引) → 段 B のマージ (Vercel のデプロイで `vercel.json` の cron が登録される)。順を逆にしない (route が関数を呼べず毎時 500 になる)。
2. Vercel の環境変数: `CRON_SECRET` (既存)・`REVENUECAT_SECRET_API_KEY` (billing/03 §17.3。無い間は `not_configured` で何もしない)。`IAP_RECONCILE_BATCH_SIZE`・`IAP_RECONCILE_RECHECK_HOURS` は未設定でよい (既定 40 人・6 時間)。
3. 受け入れ (整合ゲート): §12.4 の 46。販売開始の後は、`app_logs` の `cron/iap-reconcile` の info の要約 (`candidates`・`synced`・`oldest_period_end`・`stopped_early`) を週に 1 回見る。`candidates` が毎回上限 (40 人) に届いて `oldest_period_end` が古くなっていくか、`stopped_early: 'budget'` (1 人あたりの取り直しが間隔の 1 秒より遅く、選んだ利用者を試しきれない回。試さなかった利用者は印が進まず次の回で先に来る) が続くなら、1 時間に試せる数 (40 人) が足りないので、予定を 30 分おきにする (`vercel.json` と `IAP_RECONCILE_SCHEDULE_UTC`・`IAP_RECONCILE_CRON_INTERVAL_MINUTES` を同時に変える)。`IAP_RECONCILE_BATCH_SIZE` は 40 より上げられない (1 回に試せる数は予算 ÷ 間隔で決まる。§8.1)。`stopped_early: 'rate_limited'` が続くなら、`IAP_RECONCILE_BATCH_SIZE` を下げて 1 回に RevenueCat を呼ぶ数を減らす (同期・遅延の再同期・Webhook の処理と RevenueCat の枠を分け合うため) か、`IAP_RECONCILE_REQUEST_INTERVAL_MS` を上げる (定数。§16 の 4)。
4. 運営の処置が要る行 (`rejected` が続く利用者) は、`app_logs` の warn (`billing/iap-reconcile-service`。`user_id`・`code`) から billing/03 §13.3 (`BILL_LIVE_ROW_CONFLICT`)・S15 (`BILL_IAP_UNKNOWN_PRODUCT`) の手順へ。取り直せない利用者 (`cron/iap-reconcile` の error の `summary.failed`) は、warn `ストアの購読を取り直せませんでした` の `user_id`・`kind`・`error_code` から原因を見る: `revenuecat_unexpected_response` = 当社の Zod (`RevenueCatCustomerInfoSchema`) が RevenueCat の応答に合わない (コードの直し)、`revenuecat_client_error` = その利用者の要求を RevenueCat が拒んだ、`internal` = 写像・行の読み取りの失敗 (`error_code` が `BILL_UNKNOWN_PLAN` なら行の `plan_key` が `subscription_plans` から消えた (データの直し)・`BILL_UNKNOWN_IAP_STATUS` なら TS の不具合 (コードの直し)・それ以外は SQLSTATE)。直すまでその利用者のぶんだけ毎時 500 になる (運用メールは抑止つき)。ほかの利用者の取り直しは止まらない。
5. 戻すとき: `vercel.json` から行を外して Web を戻す → §6.3 のロールバックを新しい migration として適用 (順を守る)。

---

## 16. 未解決事項 (openQuestions)

| # | 項目 | 本冊の仮置き |
|---|---|---|
| 1 | Q-1 (間隔)・Q-2 (猶予)・Q-3 (期限の前の行) (§0.5) | 推奨の値 (毎時・猶予なし・期限の後だけ) で実装する。選択で変わるのは `vercel.json` の 1 行と §8.1 の定数だけ |
| 2 | 取り直せないまま期限から N 日たった行を強制で `expired` にする仕組み (Q-2 の代替案 1) | 作らない。作るなら、強制で終わらせた行を候補に戻す印 (`personal_subscriptions` の列) と、親の写像に「取り直した姿でない snapshot」を通す規則が要り、別の冊 |
| 3 | 取り直せない行の滞留 (`oldest_period_end` が古いまま) を運用メールで知らせる種類 | 足さない。RevenueCat の失敗は毎時の 500 で `cron_failure` に乗る。鍵が無い間 (`not_configured`) は販売開始前の正常な状態なので知らせない。滞留だけを知らせたくなったら operator/11 の型 (`claim_ops_alert` のキーを 1 つ足す) で別の冊 |
| 4 | RevenueCat の REST v1 の率の制限の公式の数値 | 無い (§2.3 P1 はスタッフの案内)。1 秒に 1 回の間隔と 429 で止める規則で受ける。本番で 429 が続いたら `IAP_RECONCILE_REQUEST_INTERVAL_MS` を上げる (定数) |
| 5 | operator/08 §9 の「`stripe_integrity_check` は自動修復しない」と billing/01 §12 の「写像で直す」の食い違い | 本冊は billing/01 に従う (写像が正本からの写しである以上、写すことが修復)。operator/08 §9 の Stripe の行の直しは Stripe の reconcile の冊の仕事で、本冊は §14.2 で自分の行を足すだけ |
| 6 | 遅延の再同期の 5 分 (`IAP_LAZY_RESYNC_MIN_INTERVAL_MS`) と本冊の 6 時間 (`IAP_RECONCILE_RECHECK_HOURS`) は別の定数 | 別のままにする (本人の操作に応える頻度と、定期の裏の頻度は目的が違う) |
| 7 | 本番のストアの行が 0 件 (F19) なので、1 回の件数の上限 (40 人) と間隔 (毎時) の妥当性は実測できない | 販売開始の後、§15 の 3 で見直す。更新は月額が月 1 回・年額が年 1 回なので、候補は 1 日に契約数の 1/30 程度 + 猶予期間の行。契約 1,000 件でも 1 日 ≈ 35 人で毎時 40 人の上限に届かない |
| 8 | Vercel の Cron の起動の精度 (Pro は分の精度。P2)。41 分ちょうどに動かない回があっても、候補は次の回に残る | 受け入れる。`IAP_RECONCILE_RECHECK_HOURS_MIN` = 1 時間は、回のぶれで 6 時間ちょうどの回が候補を取りこぼしても次の回で拾える |
| 9 | 印 (`attempted_at`) を書くのは、その回に `syncStoreSubscriber` を呼んだ利用者だけ (結果を問わない。429・回全体の失敗で止めた利用者を含む)。書く時点は回の終わりの 1 回の RPC (`billing_iap_reconcile_mark_attempted`)。時刻は回の開始 | 受け入れる。選んだのに試さなかった利用者 (予算・429・回全体の失敗の後ろ) は印が進まず、次の回で試した利用者より先に選ばれる (S18)。止めた利用者にも印を書くのは、その利用者だけの GET が毎回時間切れになる (`status: null` = 回全体の失敗に分ける) 場合に、毎回その利用者で回が止まらないため。選んだ時点で書く形 (v1.1〜v1.2) は、試しきれない回で同じ利用者が毎回先に試され、後ろが永久に試されない欠陥があった (§5.2 の (iv))。試すたびに利用者ごとの RPC で書く形は RPC が倍になる。回の終わりに届かない (関数が `maxDuration` で殺される) と印が書かれず、その回に試した利用者が次の回も先に来るが、予算 (40 秒) + 最後の 1 人の時間切れ (10 秒) は `maxDuration` (60 秒) より 10 秒短く (テスト 2)、写像と印の RPC はその余りに収まるので、起きない想定。取り直しが写った利用者は候補から外れるので、起きても同じ利用者を写し直すだけ |
| 10 | 回の途中で DB が落ちたとき、残りの利用者は `internal` (利用者 1 人の失敗) に数えられ、RevenueCat への GET を上限まで続けてから 500 になる (最後の印の RPC も失敗すれば、その失敗で 500。§16 の 11) | 受け入れる (無駄な GET は 1 回に最大 40 件で、1 秒に 1 回の間隔は守る)。DB の失敗を回全体の失敗に数えると、ある利用者の行だけの制約違反で毎回止まる (S16 の欠陥に戻る)。候補を読む RPC の失敗 (DB が初めから落ちている) は、誰も取り直さずに 500 |
| 11 | 印の RPC が失敗した回 (DB の障害・取り直しの最中の退会と印の書き込みが重なった外部キーの違反 23503) | 受け入れる。その回は 500 で失敗の監視に乗る (取り直しと写しは済んでいる。要約は残らず、各利用者の warn は残る)。印が進まないので、その回に試した利用者が次の回も先に来る。退会との重なりは次の回で消える (退会した利用者は `auth.users` に無いので印の関数が飛ばす)。DB の障害が続けば毎時 500 で運用メール |

---

## 改定履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-22 | 新設 (設計ゲート R1 の叩き台。4 相: 外形固定 §3 → 構想 §4 → 構造裁定 §5 → 仕上げ §6〜§15。Issue #1912 の配線の残りの冊「日次の reconcile」を、毎時の Vercel Cron `GET /api/cron/iap-reconcile` と DB の候補の関数 `billing_iap_reconcile_candidates` で確定) |
| v1.1 | 2026-10-22 | 設計ゲート R1 の指摘 3 件を反映。(1)(2) 利用者 1 人の失敗 (応答の形の違い・そのほかの 4xx・写像の想定外) で回が止まり、その利用者が毎回先頭に来て後ろの全員が取り直されない欠陥: 失敗を回全体 / 利用者 1 人に分け (`classifyReconcileFailure`・`IapReconcileFailedError`・要約の `failed`)、候補の順番を「最後に試した時刻の古い順」にする印の表 `iap_reconcile_attempts` と、選んだ利用者に時刻を書く関数 `billing_iap_reconcile_claim_candidates` (旧 `billing_iap_reconcile_candidates`) に改めた (§4.1・§5.2・§6.2・§8・§11)。表の分類 3 か所を段 A に足した (F24)。(3) 段 A のテストが段 B の定数を import していた点: `c_max_limit` と `IAP_RECONCILE_BATCH_SIZE_MAX` の一致の検査を段 B の単体テスト 10 へ移した。テストを 45 本に振り直した (§12)。シナリオ S16・S17 を足した。周 2 の網羅性の反映: §14.2 に operator/08 §6.2 (`:549`。番兵の見張りの外) の行を足し、operator/12 §14 の行の文書名を明記、行の番号を `d950a7b1` で取り直し (operator/08 §3.2 `:178`・`:180`、billing/03 §18 `:5206`)、§14.1 の `design-doc-vercel-cron-count` の行の数え方 (設計書 3 冊の 8 か所 + it 名 1 か所) を直した |
| v1.2 | 2026-10-22 | 設計ゲート R2 の指摘 1 件を反映。写像の `BILL_UNKNOWN_PLAN`・`BILL_UNKNOWN_IAP_STATUS` を `rejected` (200・運用メールなし) に入れていた点: billing/03 §13.3 の扱いは失敗で運営の処置の表が無いので、`rejected` は運営の処置が決まっている `BILL_LIVE_ROW_CONFLICT` (§13.3)・`BILL_IAP_UNKNOWN_PRODUCT` (S15) の 2 つだけにし、定数 `IAP_RECONCILE_REJECTED_CODES`・型 `IapReconcileRejectedCode`・`isIapReconcileRejectedCode` (§8.1) で 1 か所に閉じた。ほかの業務エラーは `classifyReconcileFailure` の `other` → `failed['internal']` (500 → `cron_failure`)。§2.1・§3.2・§4.1・§4.2・§7.1・§7.3 (a)(b)・§8.1・§8.3・§9.1・§11.2・§12 (テスト 8・14・17)・§12.5・§13.3 (export 42 → 45)・§15 を揃えた。周 3 の網羅性の反映: §14.2 に billing/03 §5.2 の縁の発生源 (2) (`:380`) の行を足し、§0.3・§2.1 の参照に加えた。§7.1 にストア (`iap_store`) の軸の 3 行を足し、§7.3 (a) の置き換えの行と「別の live 行あり」の行にストアの条件を書いた。§14.1 の母集合 3 を 5 本に直し、名指しで読むだけの 3 本の行を足した。§12.5 の S5・S6・S14 の対応をテスト 20 (退会) から 11 (`stale` の数え方) に直し、並行の検査の受け持ち (billing/03 の結合テスト 67) を注に書いた |
| v1.3 | 2026-10-22 | 設計ゲート R3 の指摘 2 件を反映。(1) §14.2 の operator/11 §11.1 の行で、引用の末尾のバッククォートがセルの間の `|` をコードの span に飲み込み、`tests/docs-table-column-count.test.ts` が赤になる点: 引用から末尾の閉じの記号を外した (本書の表の列の食い違いは 0)。(2) 候補の印を「選んだとき」に書いていたため、1 回に試せる数を超えて選んだ回 (環境変数で上限を上げた・遅い応答・429・回全体の失敗) で、試さなかった利用者まで後ろに回り、期限の古い同じ利用者が毎回先に試されて後ろが永久に試されない欠陥: 候補の関数を読むだけの `billing_iap_reconcile_candidates` (STABLE。advisory lock を外す) に戻し、印はループの後に、その回に `syncStoreSubscriber` を呼んだ利用者だけに 1 回の RPC `billing_iap_reconcile_mark_attempted(uuid[], timestamptz)` (`GREATEST`・`auth.users` に無い利用者は飛ばす) で書く形にした。ポートを `listReconcileCandidates`・`markReconcileAttempted` (`IapReconcileAttemptMark`) にした。あわせて `IAP_RECONCILE_BATCH_SIZE_MAX` を 1 回に試せる数 (予算 ÷ 間隔 = 40) にし (環境変数は下げる向きだけ)、DB の上限は `c_max_users` (200。TS の上限以下をテスト 10 が見る) にした。シナリオ S18 を足し、§0.2・§0.5 Q-1・§1・§3.1 R3・R4・§4・§5.2 (退けた代わり (iv)〜(vi))・§5.3・§6・§7・§8・§9.1・§11・§12 (テスト 2・4・10・11・13〜19・32〜36・42・44 と新しい 45。受け入れは 46)・§12.5・§13・§14.1・§15 の 3・§16 の 9 と 11 を揃えた。土台を origin/main `c1ecc93b` で再確認した |
| v1.4 | 2026-10-22 | 設計ゲート R4 の指摘 1 件を反映。§12.3 の結合テストが「固定の過去の `p_now` を 1 つ」と afterAll だけの片付けを指定していたため、前の it が残した期限切れ・印なしの利用者がテスト 44 の候補で A より前に並び、`p_limit` 3 の結果から A が抜けて必ず赤になる点: 時刻を固定の過去の年 (`RECONCILE_NOW_MS` = 2000-01-01Z、`p_now` はその前後 24 時間の中) に置き、it ごとの片付け (`afterEach` で利用者を消し、`service_role` が消せない印の行は `auth.users` の ON DELETE CASCADE で消して、残っていないことを読み直す) と it ごとの新しい利用者を逐語で決めた (`tests/integration/rls/org-challenge-diff-privacy.test.ts` と同じ型)。38〜41・43・44 は返る配列をその it の利用者だけの期待と丸ごと比べる。行の作り方 (ストアの行の列と、41 の 2 本目の商品 ID) と、39 の行と `p_now` の組を具体の値で書いた。土台を origin/main `7532a77c` (#1935) で再確認し、§14.2 の billing/03 §18 の 4 の行の番号を `:5206` → `:5250` に直した |
| v1.5 | 2026-10-22 | 周 5 の網羅性の反映。(1) §7.1 に、核の CHECK が許すがストアの行の 5 値に無い `paused` / `grace` / `incomplete` の行を足した (候補に出ない。写像 `billing_apply_store_subscription` が 5 値以外を拒むので起きない)。F10 に根拠の行 (`20261021100000:250-251`・`20261016210000:39`・`:291-300`) を足し、§7.2 に同じ面の行、§7.3 (a) に「現在」が 3 値だけである注を足した。(2) §0.4 の 2 の `get_effective_plan` の集合 (`trialing`・`active`・`grace`・`past_due`) は `20261010140000_ai_usage_foundation.sql:115` の逐語で正しく、変えない (`20261021100000:292`・`:356` の `paused` を含む集合は写像の中の「別の live 行」と家族グループの判定で、権利の判定ではない)。(3) §14.1 の母集合 7 の `billing_customers` の 13 本を全部分け (表の一覧を持つ 4 本・生成物 1 本・自分の migration 1 本・名指しで使うだけの 7 本)、7 本の行を表に足した |
