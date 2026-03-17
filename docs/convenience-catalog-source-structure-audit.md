# Convenience Catalog Source Structure Audit

## Purpose
対象ブランドごとの Web 構造を監査し、`別々の scraper` をどう設計するかを決める。

監査は `自動化前に人間が HTML / URL tree を直接確認する` ことを前提にする。
Firecrawl や audit script はその後の再確認に使う。

本ドキュメントは以下を残す。
- 入口 URL
- URL ツリーの構造
- カテゴリ / サブカテゴリ / 商品詳細の分離可否
- 栄養情報の露出場所
- scraper strategy

## Audit Rule
有効化前の確認ルールは固定する。

1. root page を確認する
2. category / subcategory page を確認する
3. 各 category / subcategory ごとにランダム 3 商品以上を確認する
4. `name / image / price / nutrition / allergy / sales region` の露出位置を記録する
5. structure が混在する場合は category 単位で scraper を分割する

## Strategy Types
- `catalog_tree`
  - root -> category -> detail の構造がある
- `catalog_tree_shared_parent`
  - 独立ブランドだが親ブランドの商品構造を共有する
- `partial_nutrition_catalog`
  - 商品 tree はあるが `name / image / price / full nutrition` が detail に揃わない
- `news_feed_catalog`
  - 新商品 / おすすめ商品 / ニュース記事が主で、安定した detail tree が弱い
- `weak_catalog`
  - 商品一覧はあるが SKU detail や栄養の構造が弱い
- `unsupported`
  - 現時点では全商品栄養の漏れない取得が難しい

## Sources

| source_code | brand | root_url | current_strategy | current_findings |
| --- | --- | --- | --- | --- |
| `seven_eleven_jp` | セブン-イレブン | `https://www.sej.co.jp/products/` | `catalog_tree` | `products/a/<category>/` -> region/listup -> `item/<id>/`; detail に栄養とアレルゲンあり |
| `familymart_jp` | ファミリーマート | `https://www.family.co.jp/goods.html` | `catalog_tree` | `goods/<category>.html` -> `goods/<category>/<id>.html`; detail に栄養導線あり |
| `lawson_jp` | ローソン | `https://www.lawson.co.jp/recommend/original/` | `catalog_tree` | `recommend/original/<category>/` -> `detail/<id>.html`; detail に `nutritionFacts_table` とアレルギー情報あり |
| `lawson_store100_jp` | ローソンストア100 | `https://store100.lawson.co.jp/product/` | `partial_nutrition_catalog` | `product/<line>/detail/<id>.html`; detail に価格・画像・販売地域はあるが、監査した 3 商品で栄養欄を確認できず |
| `natural_lawson_jp` | ナチュラルローソン | `https://natural.lawson.co.jp/recommend/` | `catalog_tree_shared_parent` | `recommend/new` と `commodity` 系。Lawson shared catalog の可能性が高いので親構造前提で監査する |
| `ministop_jp` | ミニストップ | `https://www.ministop.co.jp/syohin/` | `catalog_tree` | `noodles` は `syohin/<category>/` -> `syohin/products/detail<6digit>.html`。`sweets` は `nutrition/results.html?search_category[]=コールドスイーツ` の結果 table を入口にした方が安定する。一方 `onigiri` / `obento` の旧 public category は 403 で、`tennai-tezukuri` は inline lineup 形式のため `disabled pending custom parser` |
| `daily_yamazaki_jp` | デイリーヤマザキ | `https://www.daily-yamazaki.jp/new/` | `partial_nutrition_catalog` | `new/` に商品モーダルが埋め込まれており `熱量` と `アレルゲン` は取れる。現時点では 5大栄養の全文は見えていない |
| `seicomart_jp` | セイコーマート | `https://www.seicomart.co.jp/instore/new.html` | `news_feed_catalog` | `instore/new.html` は週次新商品一覧を 1 ページに持つ。価格と説明はあるが栄養欄は未確認 |
| `sakura_mikura_jp` | さくらみくら | `https://www.sakura-mikura.jp/` | `weak_catalog` | root 確認のみ。商品 tree と栄養 detail の有無を追加監査する |
| `poplar_group_jp` | ポプラグループ | `https://www.poplar-cvs.co.jp/` | `weak_catalog` | campaign / IR は確認。商品 SKU tree は未確認。生活彩家 / くらしハウス / スリーエイト含め要精査 |
| `cisca_jp` | cisca | `https://www.cisca.jp/` | `weak_catalog` | root 確認のみ。一般公開の商品栄養カタログは未確認 |
| `newdays_jp` | JR東日本クロスステーション / NewDays | `https://retail.jr-cross.co.jp/newdays/product/` | `partial_nutrition_catalog` | root は JS が `data_allproductlist.json` を fetch する。`name / price / image / detail URL` は JSON から取れるが、detail に栄養欄は未確認 |
| `shikoku_kiosk_jp` | 四国キヨスク | `https://www.s-kiosk.jp/` | `weak_catalog` | root は確認。7-Eleven / kiosk 混在で独立した商品栄養カタログは未確認 |
| `orebo_jp` | 大津屋 / オレボ | `https://www.orebo.jp/news/` | `news_feed_catalog` | `news/` 形式。商品 SKU tree は未確認。記事単位 scrape の検討が必要 |

## Confirmed URL Patterns

### Seven-Eleven
- category: `/products/a/<category>/`
- region list: `/products/a/<category>/<region>/`
- lineup: `/products/a/cat/<id>/`
- detail: `/products/a/item/<itemId>/`

### FamilyMart
- root: `/goods.html`
- category: `/goods/<category>.html`
- detail: `/goods/<category>/<id>.html`
- detail markers:
  - `.item_nutritional_info`
  - `.item_allergen`

### Lawson
- root: `/recommend/original/`
- category: `/recommend/original/<category>/`
- detail: `/recommend/original/detail/<id>.html`
- detail markers:
  - `nutritionFacts_table`
  - `アレルギー情報`

### Lawson Store 100
- root: `/product/`
- line page: `/product/<line>/`
- detail: `/product/<line>/detail/<id>.html`
- audited detail findings:
  - name / description / image / price / maker / content amount / sales region はある
  - `熱量 / たんぱく質 / 脂質 / 炭水化物 / 食塩相当量` は監査した 3 detail で未確認

### Ministop
- root: `/syohin/`
- category: `/syohin/<category>/`
- detail: `/syohin/products/detail<6digit>.html`
- detail markers:
  - `アレルゲン情報`
  - `栄養成分情報`
- current exceptions:
  - `/syohin/onigiri/` と `/syohin/obento/` は `2026-03-17` 時点で `403`
  - `/syohin/sweets/` 自体は紹介ページで、商品 pretty URL とキャンペーン導線が混在する。full nutrition を取るには `nutrition/results.html?search_category[]=コールドスイーツ` を入口に使う方がよい
  - `/syohin/tennai-tezukuri/` は live だが inline lineup 形式で、generic detail scraper にそのままは乗らない
  - `/syohin/nutrition/` は `ソフトクリーム / コールドスイーツ / ホットスナック / 店内加工ドリンク` しか検索対象がなく、`手づくりおにぎり / 手づくり弁当` の栄養導線は公開されていない
  - Firecrawl はこの inline lineup から `detail1.html` のような偽 URL を返すことがあるため、6 桁 detail 以外を除外する

### Daily Yamazaki
- root: `/new/`
- `new/` 本体に商品 modal HTML が埋め込まれている
- confirmed markers:
  - `熱量：xxxkcal`
  - `アレルゲン`
- full nutrition table is not yet confirmed

### Seicomart
- root: `/instore/new.html`
- weekly list page is confirmed
- current page does not expose full nutrition markers in sampled blocks

### NewDays
- root candidate: `/newdays/product/`
- page JS fetches `/newdays/lib/js/mt_generate/product/data_allproductlist.json`
- JSON contains:
  - `category`
  - `subCategory`
  - `itemList[].name`
  - `itemList[].linkUrl`
  - `itemList[].imgPath`
  - `itemList[].price`
- detail page currently shows name / category / price / description / sales area / image
- full nutrition table is not confirmed

## Manual Audit Findings (2026-03-17)

### Seven-Eleven
- root から `/products/a/<category>/` を直接列挙できる
- `onigiri` category でランダム 3 商品を確認
  - `/products/a/item/041910/`
  - `/products/a/item/042269/`
  - `/products/a/item/041891/`
- 3 件とも以下が同じ構造で存在
  - `<th>本製品に含まれるアレルギー物質</th>`
  - `<th>栄養成分</th>`
  - `熱量 / たんぱく質 / 脂質 / 炭水化物 / 食塩相当量`

### FamilyMart
- root から `/goods/<category>.html` を直接列挙できる
- `omusubi` と `noodle` の detail をそれぞれランダム 3 件確認
- 代表 detail で以下の構造を確認
  - `.item_nutritional_info`
  - `.item_allergen`
  - `<td class="con_nut">` に数値が並ぶ
- 結論として `category ごとの差は今のところ小さく、同一 parser で対応可能`

### Lawson
- root から `/recommend/original/<category>/` を直接列挙できる
- `rice` category の random 3 detail で以下を確認
  - `.nutritionFacts_table`
  - `アレルギー情報`
  - 地域注記 `※熱量表示は関東地域のものを掲載`
- detail parser は `栄養表 + アレルギー表 + 地域注記` を取る前提で設計する

### Natural Lawson
- `/recommend/commodity/detail/<id>_<code>.html` で detail を確認
- Lawson 系に近い detail 構造で、`熱量 / たんぱく質 / 脂質 / 炭水化物 / 食塩相当量 / アレルギー情報` を確認
- discovery だけ分けて、detail parser は Lawson 系共通化でよい

### Ministop
- `detail043225.html` で `アレルゲン情報` と `栄養成分情報` を確認
- 栄養値は `<dl><dt>...</dt><dd>...</dd></dl>` 形式
- detail parser は table ではなく definition list を前提にする
- `onigiri` / `bento` の旧 category page は anti-bot で 403
- `tennai-tezukuri` page は商品名と価格は inline で見えるが、generic detail URL は存在せず `detail1.html` 系の偽 URL が混入しうる
- `2026-03-17` の E2E dry-run では `men` / `sweets` は green、`onigiri` は anti-bot retry limit、`bento` は 0 products だった
- そのため `onigiri` / `bento` は active category から外し、公開栄養ソースが確認できるまで `disabled pending custom parser` とする

### Lawson Store 100
- `1519547_5066.html`, `1519421_5066.html`, `1519606_5066.html` を確認
- 3 件とも name / description / price / region / image はある
- 3 件とも栄養欄を確認できず、full nutrition source にはならない

### Daily Yamazaki
- `new/` は商品 modal を大量に内包する single page
- product block に以下はある
  - name
  - image
  - price
  - description
  - `熱量`
  - `アレルゲン`
- `たんぱく質 / 脂質 / 炭水化物 / 食塩相当量` は未確認

### NewDays
- `product` root は JS + JSON
- `data_allproductlist.json` が category / subCategory / itemList を持つ
- detail `/newdays/menu/detail/<id>.html` は name / category / price / description / sales area / image を持つ
- full nutrition is not confirmed

### Seicomart / Poplar / cisca / Shikoku Kiosk / OrebO
- ここまでの手監査では、`全商品の full nutrition を安定取得できる公開構造` は未確認
- 実装 Phase 1 の対象から外す

## Initial Design Decision
実装は `source strategy` ごとに分ける。

- `catalog_tree`
  - Seven-Eleven
  - FamilyMart
  - Lawson
  - Ministop
- `catalog_tree_shared_parent`
  - Natural Lawson
- `partial_nutrition_catalog`
  - Lawson Store 100
  - Daily Yamazaki
  - NewDays
- `news_feed_catalog`
  - Seicomart
  - OrebO
- `weak_catalog`
  - Sakura Mikura
  - Poplar Group
  - cisca
  - Shikoku Kiosk

## Scraper Design Implication
- `catalog_tree` は `root -> category -> subcategory -> detail` 再帰で取る
- `partial_nutrition_catalog` は `name / image / price / partial nutrition` のみ保持し、full nutrition source には使わない
- `news_feed_catalog` は `weekly/new item archive -> article/detail` で取る
- `weak_catalog` は無理に本実装へ入れず、監査完了まで `disabled` にする
- `catalog_tree_shared_parent` は親ブランドの parser を継承しつつ filter を追加する

## Next Audit Work
以下をまだやる必要がある。

- Seven-Eleven: `onigiri` 以外の 2 category 以上で 3 detail samples
- FamilyMart: `omusubi/noodle` 以外の 2 category 以上で 3 detail samples
- Lawson: `rice` 以外の 2 category 以上で 3 detail samples
- Ministop: `obento` / `sweets` / `noodles` で 3 detail samples
- Daily Yamazaki: `new/` 内 block を category ごとに 3 samples
- Seicomart: weekly list 3 samples以上 + goods site 連携確認
- NewDays: JSON から category ごとに 3 detail samples + 栄養有無確認
- Sakura Mikura / Poplar / cisca / Shikoku Kiosk / OrebO: root から detail tree を確認
