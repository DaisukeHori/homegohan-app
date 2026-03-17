# Catalog User Integration Plan

## Goal

`catalog_products` を importer 専用テーブルで終わらせず、ユーザー体験の中核に接続する。

今回の第一段階では次を実現する。

1. 献立の手動入力で市販品を検索して選べる
2. 写真解析後に公開商品候補を提示し、公開栄養値へ寄せられる
3. `planned_meals` に catalog 参照を保持できる

将来はコンビニ以外も同じ土台に載せる。

- スーパーマーケットの惣菜・弁当
- ファミレスや牛丼チェーンの公開メニュー
- カフェ、ベーカリー、ドラッグストア惣菜

## Domain Rule

`catalog_products` は「コンビニ商品」専用ではなく、`公開栄養情報を持つ市販品・外食メニュー` の共通ドメインとする。

- `catalog_sources` がブランドや配信元を表す
- `catalog_products` が公開商品・メニューの現行正本
- `catalog_product_snapshots` が差分履歴
- `planned_meals` は `catalog_product_id` を持って参照する

この形にしておけば、将来の追加は `source adapter` を足すだけで済む。

## User-Facing Flows

### 1. Manual Entry

対象: [weekly/page.tsx](/Users/horidaisuke/homegohan/homegohan-app/src/app/(main)/menus/weekly/page.tsx)

- 手動編集モーダルで商品名検索
- 検索結果から商品を選択
- `planned_meals` へ `catalog_product_id` と `source_type='catalog_product'` を保存
- 栄養値は `catalog_products` の公開値をそのまま採用

### 2. Photo Recognition Assist

対象: [analyze-meal-photo/route.ts](/Users/horidaisuke/homegohan/homegohan-app/src/app/api/ai/analyze-meal-photo/route.ts), [meals/new/page.tsx](/Users/horidaisuke/homegohan/homegohan-app/src/app/(main)/meals/new/page.tsx)

- 画像解析で得た dish 名を catalog 検索にかける
- 公開商品候補を UI に出す
- ユーザーが exact product を選んだら、その公開栄養値を保存に使う

これは「AI が完璧に当てる」よりも、「AI が候補を出し、ユーザーが 1 tap で exact product に修正できる」方を優先する。

## Persistence Design

`planned_meals` の追加列:

- `catalog_product_id uuid null`

既存列との使い分け:

- `source_type='catalog_product'`
- `generation_metadata.catalog_selection`
  - `productId`
  - `sourceCode`
  - `brandName`
  - `name`
  - `selectedFrom`
  - `selectedAt`

`generation_metadata` に summary を残すのは、一覧 API が join なしでも表示情報を出せるようにするため。

## Current Implementation Scope

今回入れたもの:

- [20260317223000_add_catalog_user_integration.sql](/Users/horidaisuke/homegohan/homegohan-app/supabase/migrations/20260317223000_add_catalog_user_integration.sql)
- [catalog-products.ts](/Users/horidaisuke/homegohan/homegohan-app/lib/catalog-products.ts)
- [products/route.ts](/Users/horidaisuke/homegohan/homegohan-app/src/app/api/catalog/products/route.ts)
- [weekly/page.tsx](/Users/horidaisuke/homegohan/homegohan-app/src/app/(main)/menus/weekly/page.tsx)
- [meals/new/page.tsx](/Users/horidaisuke/homegohan/homegohan-app/src/app/(main)/meals/new/page.tsx)

## Next Phases

### Phase 2

- `catalog_products` 詳細 API
- meal detail 画面でブランド・公開栄養・商品URL を表示
- `buy/out` の新規追加モーダルに catalog search を直接組み込む

### Phase 3

- スーパー惣菜 source adapter
- 外食チェーン menu adapter
- source metadata に `channel_type = convenience | supermarket | restaurant` を追加

### Phase 4

- meal-photo 解析 prompt に catalog candidate を逆注入
- 画像だけでなく OCR/レシート/バーコードとの統合
- 履歴ベースでユーザーの購入傾向から候補を優先表示
