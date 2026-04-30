# Convenience Catalog Architecture

## Purpose
Homegohan にセブンイレブンの商品データを定期取り込みし、将来的に全コンビニへ拡張できる共通基盤を定義する。

既存の Supabase Edge Functions と `dataset_import_runs` の流れは再利用するが、`dataset_recipes` とは別ドメインとして扱う。

実装タスクは以下に分離する。
- [`docs/convenience-catalog-task-plan.md`](/Users/horidaisuke/homegohan/homegohan-app/docs/convenience-catalog-task-plan.md)
- [`docs/convenience-catalog-source-structure-audit.md`](/Users/horidaisuke/homegohan/homegohan-app/docs/convenience-catalog-source-structure-audit.md)

## Scope
- 対象データ
  - おにぎり
  - 弁当
  - 麺類
  - サンドイッチ
  - 将来は惣菜、パン、スイーツ、飲料も追加可能
- 取得項目
  - 商品名
  - 商品画像
  - 商品URL
  - コンビニブランド
  - カテゴリ
  - 栄養成分
  - アレルゲン、価格、販売地域など取得できる範囲の付帯情報
- 非目標
  - まずは発注・EC連携はしない
  - まずは OCR 前提の画像抽出には寄せない
  - まずは `recipes` テーブルへ直接混ぜない

## Why Separate Domain
`dataset_recipes` は「調理レシピ」、今回必要なのは「市販完成品カタログ」なので、更新特性が違う。

違い:
- レシピは比較的静的だが、コンビニ商品は入れ替わりが速い
- レシピは調理手順が主、商品は SKU と販売状態が主
- 同名でも容量・地域・リニューアルで別商品になる
- 画像・価格・販売終了の管理が必要

そのため、新規に `catalog_*` ドメインを作る。

## Chosen Runtime
実装は `Supabase Edge Functions + Firecrawl scrape + deterministic normalization + OpenAI fallback` を前提にする。

役割分担:
- Supabase `pg_cron`: 定期起動
- Edge Function: 実行管理、差分判定、DB保存
- Firecrawl: 商品一覧と詳細ページの取得、一次構造化
- deterministic normalization: URL正規化、ID生成、カテゴリや栄養の基本正規化
- OpenAI: Firecrawl JSON が壊れたとき、または欠損が大きいときの救済

Firecrawl は Cloud 固定ではない。
`/scrape` と `json + markdown` が使えればよいので、self-host Firecrawl に切り替え可能な設計にする。
そのため Edge Function 側は `FIRECRAWL_BASE_URL` を環境変数で受け、認証も optional にする。
ただし self-host で `json` extraction を使う場合、Firecrawl 側に LLM provider の設定が必要。

## Multi-source Principle
scraper は source ごとに分ける。

ただし source adapter を書く前に、人間が root / category / detail HTML を直接見て、
URL tree と nutrition 露出位置を確定する。
Firecrawl は `構造が分かった後の取得器` として使う。

ただし実装は毎回ゼロから作り直さず、以下の 2 層に分ける。

- shared runner
  - crawl queue
  - Firecrawl `/scrape` 呼び出し
  - deterministic normalization
  - OpenAI fallback
  - diff / upsert
- source adapter
  - root URL
  - discovery prompt
  - detail prompt
  - URL pattern
  - external ID の決め方
  - `strategy` (`catalog_tree`, `catalog_tree_shared_parent`, `partial_nutrition_catalog`, `news_feed_catalog`, `weak_catalog` など)

つまり「function は別」「コアは共有」にする。

## Proposed Architecture
1. `scheduler`
   - Supabase `pg_cron` が Edge Function を定期起動する
2. `discovery`
   - Firecrawl がカテゴリトップ、地域ページ、ラインナップページから商品URL候補を返す
3. `detail extraction`
   - Firecrawl `/scrape` が商品詳細ページから商品データを JSON で返す
4. `normalize`
   - コードで URL、ID、カテゴリ、栄養などを正規化する
5. `LLM fallback`
   - Firecrawl の JSON が崩れたときだけ markdown から救済抽出する
6. `diff`
   - 数値単位やカテゴリを正規化し、前回スナップショットとの差分を比較する
7. `upsert`
   - 変更があるときだけ商品本体・履歴・Raw document を更新する
8. `publish`
   - Homegohan 側の検索API、食事登録、AI参照へ公開する

## Data Model

### 1. Source master
`catalog_sources`

用途:
- どのブランドのどのスクレイパーかを定義する

主要カラム:
- `id`
- `code` (`seven_eleven_jp`)
- `brand_name` (`セブンイレブン`)
- `country_code` (`JP`)
- `base_url`
- `is_active`
- `crawl_interval_minutes`
- `rate_limit_per_minute`
- `created_at`
- `updated_at`

### 2. Crawl targets
`catalog_source_categories`

用途:
- ブランドごとのカテゴリURLを管理する

主要カラム:
- `id`
- `source_id`
- `category_code` (`onigiri`, `bento`, `noodles`, `sandwich`)
- `category_name`
- `list_url`
- `is_active`
- `crawl_priority`
- `last_crawled_at`

### 3. Import runs
`catalog_import_runs`

用途:
- `dataset_import_runs` と同じ役割。ジョブの可視化と再実行管理

主要カラム:
- `id`
- `source_id`
- `trigger_type` (`scheduled`, `manual`, `backfill`)
- `status` (`running`, `completed`, `failed`, `partial`)
- `started_at`
- `completed_at`
- `categories_total`
- `pages_total`
- `products_seen`
- `products_inserted`
- `products_updated`
- `products_unchanged`
- `products_discontinued`
- `error_log`

### 4. Canonical products
`catalog_products`

用途:
- 現在有効な商品の正本

主要カラム:
- `id`
- `source_id`
- `external_id`
  - 原則はサイト上の安定ID
  - セブンでは `/products/a/item/{itemId}/` の `itemId` を使う
  - 地域suffix付きURLは canonical 化して同一商品として扱う
  - 取れない場合は `source_id + canonical_url` を擬似IDにする
- `canonical_url`
- `name`
- `name_norm`
- `brand_name`
- `category_code`
- `subcategory_code`
- `description`
- `price_yen`
- `sales_region`
- `availability_status` (`active`, `limited`, `discontinued`, `unknown`)
- `main_image_url`
- `nutrition_json`
- `allergens_json`
- `metadata_json`
- `first_seen_at`
- `last_seen_at`
- `discontinued_at`
- `content_hash`
- `created_at`
- `updated_at`

制約:
- unique(`source_id`, `external_id`)
- index(`source_id`, `category_code`, `availability_status`)
- index(`name_norm`)

### 5. History snapshots
`catalog_product_snapshots`

用途:
- 商品のリニューアル履歴を残す
- 「新しくなってなければ更新しない」を DB 上で保証する

主要カラム:
- `id`
- `product_id`
- `import_run_id`
- `snapshot_hash`
- `name`
- `price_yen`
- `main_image_url`
- `nutrition_json`
- `allergens_json`
- `metadata_json`
- `captured_at`

ルール:
- `snapshot_hash` が直近と同じなら snapshot を作らない
- 異なるときだけ `catalog_products` を更新し snapshot を追加する

### 6. Raw page archive
`catalog_raw_documents`

用途:
- パーサ変更時の再解析、障害調査

主要カラム:
- `id`
- `source_id`
- `import_run_id`
- `document_type` (`list`, `detail`)
- `url`
- `http_status`
- `fetched_at`
- `content_sha256`
- `payload`

保持方針:
- 直近 N 日 or 直近 N 回のみ保持
- 全文永続化が重い場合は object storage へ逃がす

## Change Detection
更新判定は `updated_at` ではなく `snapshot_hash` 基準にする。

`snapshot_hash` の対象:
- 商品名
- 価格
- 正規化済み栄養
- アレルゲン
- 説明文
- 画像URL
- 販売地域
- カテゴリ

更新しないもの:
- 巡回時刻
- 一時的な HTML ノイズ
- トラッキングクエリ付きURLの揺れ

これで「毎日見に行くが、変わっていなければ DB 更新しない」が実現できる。

## Nutrition Model
今の `dataset_recipes` と栄養項目を極力揃える。

推奨:
- `nutrition_json` に原本を保持
- よく使う主要項目は列でも持つ

推奨列:
- `calories_kcal`
- `protein_g`
- `fat_g`
- `carbs_g`
- `fiber_g`
- `sodium_g`
- `sugar_g`

理由:
- 一覧表示や絞り込みが速い
- 既存の栄養UIに繋ぎ込みやすい
- 詳細なビタミン・ミネラルは JSON で段階的対応できる

## Scraper Design

### Source strategies
source ごとに同じアルゴリズムを当てない。

- `catalog_tree`
  - root -> category -> subcategory -> detail
- `catalog_tree_shared_parent`
  - 親ブランドの detail 構造を流用
- `partial_nutrition_catalog`
  - 商品一覧と detail はあるが、full nutrition が detail に揃わない
- `news_feed_catalog`
  - weekly / new item archive -> article/detail
- `weak_catalog`
  - 監査完了まで `disabled`

運用上のバッチサイズ:
- `dryRun` の既定値は `maxCategories=4`, `maxProductsPerCategory=10`
- `live import` の既定値は timeout 回避のため `maxCategories=1`, `maxProductsPerCategory=3`
- full import は `categoryCode` 指定で source ごとに分割実行する
- discovery は `maxProductsPerCategory` に達した時点で打ち切り、不要な category tree の深掘りを避ける

Phase 1 で full nutrition source として有効化するのは以下に限る。
- Seven-Eleven
- FamilyMart
- Lawson
- Natural Lawson
- Ministop
  - ただし `2026-03-17` 時点では `men / sweets` のみ active
  - `onigiri / bento` は `tennai-tezukuri` の inline lineup しか公開されず、栄養 detail 導線が無いため `disabled pending custom parser`

以下は Phase 1 では `partial` または `disabled` に止める。
- Lawson Store 100
- Daily Yamazaki
- NewDays
- Seicomart
- Poplar Group
- cisca
- Shikoku Kiosk
- OrebO

### Actual page structure observed on Seven-Eleven
Firecrawl で実サイトを確認すると、セブンの商品導線は単純な1階層ではない。

ページ種別:
- カテゴリトップ
  - 例: `/products/a/onigiri/`
  - 商品URL、地域URL、ラインナップURLが混在する
- 地域ページ
  - 例: `/products/a/onigiri/kanto/`
  - 地域付きの商品URLと地域付きラインナップURLが出る
- ラインナップページ
  - 例: `/products/a/cat/010010010000000/`
  - 商品URLを追加で列挙する
- 商品詳細ページ
  - 例: `/products/a/item/042164/`
  - 名前、画像、価格、栄養、販売地域を取得できる

重要な観測:
- カテゴリトップだけでは全商品を取り切れない
- 地域ページを辿る必要がある
- ラインナップページも補完的に辿る必要がある
- セブンの商品URLは `/item/042271/` と `/item/042271/kanto/` のように複数入口がある
- そのため `external_id` は URL 全体ではなく商品番号基準へ正規化する
- `canonical_url` も地域suffixを外した商品URLへ寄せる

### Firecrawl extraction
ブランド固有ロジックは source adapter に寄せる。

巡回順:
1. カテゴリトップを取得する
2. `categoryUrls` と `itemUrls` を抽出する
3. `categoryUrls` を再帰的に辿る
4. 各 list page でランダム 3 商品以上を監査する
5. 商品詳細ページを取得する

補足:
- この「random 3 商品監査」は adapter 実装前の manual audit 手順
- production crawler 自体は全 item を取る

発見ページの schema:
- `itemUrls`
- `categoryUrls`

詳細ページ:
- Firecrawl `scrape`
- schema 付き JSON 抽出
- 商品名、画像、価格、アレルゲン、栄養など

接続設定:
- Cloud: `FIRECRAWL_BASE_URL` 未指定、`FIRECRAWL_API_KEY` を設定
- self-host: `FIRECRAWL_BASE_URL` を self-host URL に向ける
- self-host が Bearer 以外の認証を要求する場合は `FIRECRAWL_AUTH_HEADER` と `FIRECRAWL_AUTH_SCHEME` で吸収する
- self-host が認証なしなら auth env は不要

### Deterministic normalization
通常系では Firecrawl の出力をコードで正規化する。

- `categoryCode`
- `availabilityStatus`
- URL 正規化
- `external_id` 生成
- placeholder 画像の除去
- 主要栄養の数値化

### OpenAI fallback
OpenAI は常用しない。以下の場合のみ fallback として使う。

- Firecrawl JSON の schema parse に失敗した
- discovery の URL 抽出結果が空になった
- 商品詳細の必須項目が欠損しすぎている

fallback の入力:
- Firecrawl の markdown
- Firecrawl の元 JSON
- deterministic cleanup の結果

OpenAI に任せないもの:
- `canonical_url`
- `external_id`
- 差分判定
- DB 更新条件

### Execution pattern
初期実装から Supabase Edge Function に載せる。

候補:
- `supabase/functions/import-convenience-catalog/index.ts`
- `supabase/functions/import-seven-eleven-catalog/index.ts`
- `supabase/functions/import-familymart-catalog/index.ts`
- `supabase/functions/import-lawson-catalog/index.ts`
- `supabase/functions/_shared/firecrawl-client.ts`
- `supabase/functions/_shared/catalog-llm.ts`
- `supabase/functions/_shared/catalog-utils.ts`
- `supabase/functions/_shared/catalog/source-registry.ts`
- `supabase/functions/_shared/catalog/types.ts`

理由:
- Supabase 側で cron と DB を閉じられる
- Firecrawl が HTML パースを吸収する
- Homegohan からの再実行も Function 経由で統一できる

### Scheduling
最初の推奨:
- 1日 2 回
- 深夜 3:00
- 午前 11:00

将来:
- カテゴリ優先度で頻度を変える
  - 弁当・おにぎりは高頻度
  - 定番カテゴリは低頻度

実行基盤:
- Supabase `pg_cron` から Edge Function を起動する
- 1回の呼び出しで全件を処理しきらず、カテゴリ単位・件数上限つきで分割する

## Failure Strategy
- カテゴリ単位で失敗を分離する
- 1商品の解析失敗で全runを落とさない
- `catalog_import_runs.status = partial` を許容する
- HTML構造変更時に raw document を残して再解析できるようにする
- 発見ページと詳細ページを分けて raw document を残す

## Product Lifecycle
### New product
- 初見の `external_id` が来たら insert
- snapshot も作る

### Unchanged product
- `snapshot_hash` 一致なら商品本体は更新しない
- 必要なら run 単位の観測情報だけ別テーブルか raw document で持つ

### Renewed product
- 同じ `external_id` で hash 差分ありなら update
- snapshot 追加

### Discontinued product
- 一定回数連続で取得不能なら即削除しない
- `availability_status = discontinued`
- `discontinued_at` をセット

推奨ルール:
- 3 回連続未検出で discontinued 扱い

## Integration With Homegohan

### 1. Search
新APIを追加する。

候補:
- `src/app/api/catalog/products/route.ts`
- `src/app/api/catalog/products/[id]/route.ts`

用途:
- カテゴリ一覧
- キーワード検索
- ブランド絞り込み
- 栄養上限で絞り込み

### 2. Meal planning
`planned_meals.source_type` に新値を追加する。

追加候補:
- `catalog_product`

追加カラム候補:
- `source_catalog_product_id`
- `source_catalog_snapshot_id`

こうすると:
- 「昼はセブンの鮭おにぎり」
- 「夜はファミマのサラダチキン」

のような実商品参照を献立に持てる。

### 3. AI / recommendation
将来的に AI の候補母集団へ入れられる。

例:
- 自炊できない日の代替候補
- 塩分控えめなコンビニ昼食提案
- たんぱく質が足りない日に高タンパク商品を提案

ただし初期は `dataset_recipes` と混ぜず、別検索ツールにする方が安全。

### 4. Nutrition analysis
商品が確定している場合は推定計算ではなく商品栄養を優先できる。

具体例:
- 食事記録で「買う/中食」を選んだとき、商品検索から紐づける
- `planned_meals` や実績 `meals` に `catalog_product_id` を持たせる

## Implementation Phases

### Phase 1: Foundation
- `catalog_*` テーブル追加
- `import-convenience-catalog` Edge Function 追加
- Firecrawl client 追加
- LLM cleanup 追加
- 差分更新と snapshot 作成
- full nutrition source は `Seven / FamilyMart / Lawson / Natural Lawson / Ministop` に限定

### Phase 2: Read APIs
- 商品一覧API
- 商品詳細API
- 管理用 run status API

### Phase 3: App integration
- 商品検索UI
- 献立への商品追加
- 栄養表示との接続

### Phase 4: Multi-brand
- FamilyMart adapter
- Lawson adapter
- ブランド横断検索

### Phase 5: Partial Sources
- Lawson Store 100 partial adapter
- Daily Yamazaki partial adapter
- NewDays JSON adapter

## Suggested File Layout
- `supabase/functions/import-convenience-catalog/index.ts`
- `supabase/functions/import-seven-eleven-catalog/index.ts`
- `supabase/functions/import-familymart-catalog/index.ts`
- `supabase/functions/import-lawson-catalog/index.ts`
- `supabase/functions/import-lawson-store100-catalog/index.ts`
- `supabase/functions/import-natural-lawson-catalog/index.ts`
- `supabase/functions/import-ministop-catalog/index.ts`
- `supabase/functions/import-daily-yamazaki-catalog/index.ts`
- `supabase/functions/import-seicomart-catalog/index.ts`
- `supabase/functions/import-sakura-mikura-catalog/index.ts`
- `supabase/functions/import-poplar-group-catalog/index.ts`
- `supabase/functions/import-cisca-catalog/index.ts`
- `supabase/functions/import-newdays-catalog/index.ts`
- `supabase/functions/import-shikoku-kiosk-catalog/index.ts`
- `supabase/functions/import-orebo-catalog/index.ts`
- `supabase/functions/_shared/firecrawl-client.ts`
- `supabase/functions/_shared/catalog-llm.ts`
- `supabase/functions/_shared/catalog-utils.ts`
- `supabase/functions/_shared/catalog/source-registry.ts`
- `supabase/functions/_shared/catalog/types.ts`
- `src/app/api/catalog/products/route.ts`
- `src/app/api/catalog/products/[id]/route.ts`
- `supabase/migrations/<timestamp>_create_catalog_tables.sql`

## Current Cron Schedules

以下のスケジュールが `supabase/migrations/20260430200000_catalog_cron_schedules.sql` で登録される。
実行基盤は `pg_cron` + `pg_net` + `public.invoke_catalog_import()` ヘルパー関数。
secret の取得方法は `20260430210000_catalog_cron_use_vault.sql` で Vault 経由に変更済み。

| ジョブ名 | Edge Function | スケジュール (UTC) | JST 換算 |
|---|---|---|---|
| `catalog-import-seven` | `import-seven-eleven-catalog` | 毎日 03:00 | 毎日 12:00 |
| `catalog-import-familymart` | `import-familymart-catalog` | 毎日 03:15 | 毎日 12:15 |
| `catalog-import-lawson` | `import-lawson-catalog` | 毎日 03:30 | 毎日 12:30 |
| `catalog-import-natural-lawson` | `import-natural-lawson-catalog` | 毎日 03:45 | 毎日 12:45 |
| `catalog-import-ministop` | `import-ministop-catalog` | 毎日 04:00 | 毎日 13:00 |

### 手動 trigger API

管理者は以下の API エンドポイントから任意のタイミングで取り込みを実行できる。

```
POST /api/admin/catalog/import
Content-Type: application/json

{ "sourceCode": "seven_eleven_jp" }
```

有効な `sourceCode` 値: `seven_eleven_jp`, `familymart_jp`, `lawson_jp`, `natural_lawson_jp`, `ministop_jp`

実装: `src/app/api/admin/catalog/import/route.ts`

### 前提: Dashboard 操作

migration 適用前に Supabase Dashboard → Database → Extensions で以下を有効化する必要がある:
- `pg_cron`
- `pg_net`

また `app_cron_secret` を Supabase Vault に登録する（`ENV_SETUP.md` 参照）。

## Operational Risks
- robots.txt / 利用規約の確認が必要
- 画像URL直参照が不安定なら storage へ保存する必要がある
- HTML構造変更で parser が壊れる
- 地域限定商品は同名重複しやすい
- 地域suffix付きURLをそのままIDにすると同一商品を重複保存しやすい
- 商品IDが公開されていないサイトでは URL ベースID設計が必要

## Recommended Decisions
初手で決めるべきこと:
1. `recipes` には混ぜず `catalog_products` を新設する
2. 差分判定は `snapshot_hash` / `content_hash` でやる
3. まずはセブンイレブンだけ 4 カテゴリで出す
4. 実行は Supabase `pg_cron` + Edge Function に寄せる
5. OpenAI は fallback 専用にし、通常系は Firecrawl + コード正規化で通す
6. `planned_meals.source_type` に `catalog_product` を追加して接続する

## Minimum Viable Delivery
最短で価値が出る範囲は以下。

- セブンイレブンの4カテゴリを定期巡回
- 商品名、画像、URL、主要栄養を保存
- 差分がなければ更新しない
- 商品一覧APIで参照可能
- 献立や食事記録から商品を選べる下地を作る

## Next Step
設計を実装へ落とす順番はこれが安全。

1. migration で `catalog_*` テーブルを作る
2. `import-convenience-catalog` Edge Function を作る
3. Firecrawl + LLM cleanup を繋ぐ
4. run 結果を確認する管理APIを作る
5. 商品検索UIと `planned_meals` 接続を追加する
