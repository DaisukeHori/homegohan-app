# Convenience Catalog Task Plan

## Goal
対象ブランドごとに別 scraper を持つ形で、Homegohan に商品カタログを取り込み、差分更新できる状態まで持っていく。

参照設計:
- [`docs/convenience-catalog-architecture.md`](/Users/horidaisuke/homegohan/homegohan-app/docs/convenience-catalog-architecture.md)
- [`docs/convenience-catalog-source-structure-audit.md`](/Users/horidaisuke/homegohan/homegohan-app/docs/convenience-catalog-source-structure-audit.md)

## Delivery Strategy
最初の multi-source 対象は以下。

- full nutrition 先行対象
- `seven_eleven_jp`
- `familymart_jp`
- `lawson_jp`
- `natural_lawson_jp`
- `ministop_jp`
- partial nutrition 後続対象
- `lawson_store100_jp`
- `daily_yamazaki_jp`
- `newdays_jp`
- monitor / additional audit 対象
- `seicomart_jp`
- `sakura_mikura_jp`
- `poplar_group_jp`
- `cisca_jp`
- `shikoku_kiosk_jp`
- `orebo_jp`
- 取得対象は `商品名 / 商品URL / 画像 / 価格 / 販売地域 / 主要栄養 / アレルゲン`
- 実行基盤は `Supabase pg_cron + Edge Function`
- 取得は `Firecrawl`
- 正規化は `deterministic cleanup`
- `OpenAI` は fallback 専用
- adapter 実装前に manual HTML audit を必ず入れる

## Milestones
1. source audit を完了する
2. shared runner と source registry を固める
3. source ごとの wrapper function を deploy する
4. 商品検索 API を公開できる
5. Homegohan の meal flow に商品を接続できる

## Task List

### Phase 0: Validation

- [x] `T0-1` source audit script を用意する
  - 対象: `scripts/catalog/audit-source-structure.mjs`
  - 完了条件: source ごとに `root -> category/subcategory -> random 3 items` の JSON report を出せる

- [ ] `T0-2` 各 source の structure audit
  - 内容: source ごとに人間が HTML を直接確認し、その後 category/subcategory あたり 3 商品以上ランダム sample して structure 差分を確認する
  - 完了条件: `docs/convenience-catalog-source-structure-audit.md` に source ごとの strategy と URL tree が反映されている
  - 現状:
    - Seven-Eleven / FamilyMart / Lawson / Natural Lawson / Ministop は strong structure を確認済み
    - Lawson Store 100 / Daily Yamazaki / NewDays は partial nutrition を確認済み
    - Seicomart / Poplar / cisca / Shikoku Kiosk / OrebO は追加監査が必要

### Phase 1: Foundation

- [x] `T1-1` `catalog_*` migration 追加
  - 対象: [`supabase/migrations/20260316030000_create_catalog_tables.sql`](/Users/horidaisuke/homegohan/homegohan-app/supabase/migrations/20260316030000_create_catalog_tables.sql)
  - 完了条件: `catalog_sources`, `catalog_source_categories`, `catalog_import_runs`, `catalog_products`, `catalog_product_snapshots`, `catalog_raw_documents` が作成される

- [x] `T1-2` Firecrawl client と cleanup utility 追加
  - 対象:
    - [`supabase/functions/_shared/firecrawl-client.ts`](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/firecrawl-client.ts)
    - [`supabase/functions/_shared/catalog-utils.ts`](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/catalog-utils.ts)
    - [`supabase/functions/_shared/catalog-llm.ts`](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/catalog-llm.ts)
  - 完了条件: Firecrawl 応答を正規化し、`content_hash` を計算できる
  - 注記: OpenAI は fallback のみ

- [x] `T1-3` `import-convenience-catalog` function 追加
  - 対象: [`supabase/functions/import-convenience-catalog/index.ts`](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/import-convenience-catalog/index.ts)
  - 完了条件: dry-run と本実行の両方で category 単位に import を回せる
  - 注記: live import の既定 batch は `maxCategories=1`, `maxProductsPerCategory=3`。source root を全部一度に回すのではなく category 単位に分割する

- [x] `T1-4` source registry と strategy type 追加
  - 対象:
    - `supabase/functions/_shared/catalog/types.ts`
    - `supabase/functions/_shared/catalog/source-registry.ts`
  - 完了条件: source ごとの strategy と root URL をコードで参照できる

- [x] `T1-5` shared runner を multi-source 対応へ変更
  - 内容: `categoryUrls` 再帰、strategy 分岐、source config 参照を入れる
  - 完了条件: Seven 以外も同じ core で回せる
  - 依存: `T0-2`, `T1-4`

- [x] `T1-6` source seed migration
  - 内容: multi-source の `catalog_sources` / `catalog_source_categories` seed を追加する
  - 完了条件: source registry と DB seed が一致している

- [ ] `T1-7` import function の dry-run smoke test
  - 内容: source ごとに `dryRun=true` で root import を確認する
  - 完了条件: supported source で `stats.pagesTotal > 0` と `stats.productsSeen > 0`
  - 依存: `T1-5`, `T1-6`
  - 現状:
    - `seven_eleven_jp`: `onigiri / bento / sandwich / men` で green
    - `familymart_jp`: `onigiri / bento / sandwich / men` で green
    - `lawson_jp`: `onigiri / bento / sandwich / men` で green
    - `natural_lawson_jp`: `commodity / new` で green
    - `ministop_jp`: `men / sweets` で green。`onigiri / bento` は公開栄養ソース未確認のため active category から外す

### Phase 2: Source Functions

- [x] `T2-1` source wrapper functions を追加
  - 内容: strong source ごとに Edge Function wrapper を用意する
  - 完了条件: Seven / FamilyMart / Lawson / Natural Lawson / Ministop を source 単位 invoke できる

- [x] `T2-2` supported source adapters 実装
  - 対象:
    - Seven-Eleven
    - FamilyMart
    - Lawson
    - Natural Lawson
    - Ministop
  - 完了条件: source ごとの discovery / detail prompt と URL filter が固まる
  - 注記: `ministop_jp` は現時点で `men / sweets` のみ supported。`onigiri / bento` は custom parser 前提

- [ ] `T2-3` partial nutrition source adapters 実装
  - 対象:
    - Lawson Store 100
    - Daily Yamazaki
    - NewDays
  - 完了条件: `name / image / price / available nutrition` まで取れ、`full_nutrition = false` を付けて保存できる

- [ ] `T2-4` weak source の disable ルール
  - 対象:
    - Sakura Mikura
    - Poplar Group
    - cisca
    - Shikoku Kiosk
    - Seicomart
    - OrebO
  - 完了条件: unsupported ではなく `disabled pending audit` として DB / code に残す

### Phase 3: Scheduling And Ops

- [x] `T3-1` migration 適用と function deploy
  - 内容:
    - `supabase db push`
    - source wrapper functions を deploy
  - 完了条件: linked Supabase project で source ごとの invoke が可能
  - 依存: `T2-1`, `T2-2`

- [ ] `T3-2` Supabase secret の固定化
  - 内容: `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, `CONVENIENCE_CATALOG_LLM_MODEL` の利用方針を整理する
  - 完了条件: 本番で必要な secret 一覧と fallback 動作が確定している

- [ ] `T3-3` `pg_cron` 定期実行 SQL を追加
  - 内容: source ごとに invoke SQL を migration か runbook に追加する
  - 完了条件: supported source の scheduled run が設定される
  - 依存: `T3-1`

- [ ] `T3-4` import run の運用 runbook 作成
  - 内容: invoke 方法、失敗時確認ポイント、再実行手順を文書化する
  - 完了条件: 失敗時に `catalog_import_runs` と `catalog_raw_documents` を辿る手順が明文化される

- [ ] `T3-5` discontinued 判定ロジック追加
  - 内容: 3 回連続未検出で `availability_status = discontinued` とする処理を入れる
  - 完了条件: 未検出カウントの保存先と更新条件が確定している
  - 依存: `T3-1`

### Phase 4: Read APIs

- [ ] `T4-1` 商品一覧 API
  - 対象: `src/app/api/catalog/products/route.ts`
  - 機能: `q`, `category`, `brand`, `limit`, `cursor`, `maxCalories` など
  - 完了条件: active 商品の一覧・検索が返る

- [ ] `T4-2` 商品詳細 API
  - 対象: `src/app/api/catalog/products/[id]/route.ts`
  - 機能: 商品本体、最新栄養、最新 snapshot、metadata を返す
  - 完了条件: 1 商品詳細が安定して取得できる

- [ ] `T4-3` import run 管理 API
  - 対象候補: `src/app/api/catalog/import-runs/route.ts`
  - 機能: 最新 run 状態と error summary を返す
  - 完了条件: 運用画面やデバッグから run を追える

### Phase 5: App Integration

- [ ] `T5-1` `planned_meals` へ `catalog_product` 接続
  - 内容: `source_type` 拡張と参照カラム追加
  - 完了条件: meal planning で商品を参照できる

- [ ] `T5-2` 商品検索 UI
  - 対象候補: meals / planning flow の商品追加導線
  - 完了条件: セブン商品を検索して献立に入れられる

- [ ] `T5-3` 栄養表示との接続
  - 内容: `catalog_product` が選ばれた場合は推定栄養ではなく商品栄養を優先表示する
  - 完了条件: 食事登録画面と詳細画面の両方で一貫している

### Phase 6: Quality

- [ ] `T6-1` E2E import smoke test
  - 内容: 1カテゴリ 3商品程度で import 実行し、DB 反映まで確認する
  - 完了条件: `catalog_products` と `catalog_product_snapshots` に期待件数が入る

- [ ] `T6-2` 差分更新 test
  - 内容: 同一商品を再投入して `unchanged` になることを確認する
  - 完了条件: `products_unchanged` が増え、snapshot が重複生成されない

- [ ] `T6-3` 失敗系 test
  - 内容: Firecrawl エラー、欠損 JSON、detail 404 を想定した挙動確認
  - 完了条件: run が `partial` で終わり、他商品は継続する

## Immediate Next Tasks
今すぐ着手する順番はこれ。

1. `T1-7` strong source の dry-run smoke test
2. `T6-1` active categories の live import smoke test
3. `T2-3` partial nutrition source adapters 実装
4. `T3-3` `pg_cron` 定期実行 SQL

## Definition Of Done
MVP 完了条件は以下。

- セブン4カテゴリを scheduled import できる
- full nutrition source を source ごとに scheduled import できる
- partial source は `partial_nutrition` として別扱いで保存できる
- 変更がない商品は update しない
- 商品一覧 API で参照できる
- meal planning から `catalog_product` を選べる
