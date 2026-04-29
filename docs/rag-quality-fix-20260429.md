# RAG Quality Fix — 2026-04-29

## TL;DR

`dataset_menu_sets` の HNSW ベクトル検索が一部の抽象クエリ（例: "子ども向け献立", "ベジタリアン"）で 0 件を返していた症状を、3 つの独立した不具合として切り分け、3 本の migration として修正した。次元不整合（旧 384/1536 → 新 1024）はすでに正しく揃っており、原因ではない。

## Symptom

`search_menu_examples` を経由する RAG 検索で、本来ならレシピが返るはずのクエリで 0 件が返る:

| Query | RPC count | Sequential scan top-1 |
|---|---|---|
| 子ども向け献立 | 0 | 「子供もパクパク 鮭の甘辛ゴマ絡め…」 sim=0.524 |
| ベジタリアン | 0 | 「ネバネバ丼 / 豆腐とねぎの味噌汁」 sim=0.417 |

シーケンシャルスキャン（HNSW を無効化）では正しく上位が返るので、データそのものは健全。HNSW probe 側の問題と判明。

## Root causes (3 つの独立した不具合)

### 1. dataset_menu_sets に 237 件の不良レコード混入

| 状況 | |
|---|---|
| 件数 | 237 / 132,342 (0.18%) |
| 中身 | `title='（無題）'`, `dishes=[]`, ただし `content_embedding` あり |
| なぜ問題か | これらが embedding 空間で密に固まり、抽象クエリの近傍に配置されてしまう。HNSW が ef_search 内でこの不良クラスタを総なめし、関数内 WHERE で全件弾かれて結果ゼロになる。 |

importer 側で「本文ゼロでも embedding は生成する」フローが原因。

### 2. 失敗した REINDEX CONCURRENTLY のシャドウインデックス残存

`pg_indexes` に `idx_dataset_menu_sets_embedding_hnsw_ccnew`（is_valid=false / is_ready=false / is_live=true / 304 MB）が残っていた。プランナは正しく無視するため**直接の品質バグではない**が、衛生上削除した。

### 3. HNSW probe の打ち切り（pgvector 0.8.0 の iterative_scan 不使用）

pgvector の HNSW は デフォルト ef_search=40。embedding 空間で疎な領域に着地するクエリでは候補リストを使い切っても WHERE を満たすタプルが見つからず**そのままゼロ件で打ち切る**仕様。

EXPLAIN ANALYZE が決定的だった:

```
Index Scan using idx_dataset_menu_sets_embedding_hnsw on dataset_menu_sets
  (actual time=0.622..0.622 rows=0 loops=1)
  Buffers: shared hit=293
```

293 ページだけ触って打ち切り。ef_search を上げる手も試したが、Supabase Managed では `ALTER FUNCTION ... SET hnsw.ef_search` および `ALTER DATABASE ... SET hnsw.ef_search` は権限不足で実行不能。代わりに **pgvector 0.8.0 で導入された `hnsw.iterative_scan = relaxed_order`** を関数内 `set_config()` で有効化する手で完全解消。

## Fix (本番 DB に適用済み + migration commit 済み)

### Migration 1 — `20260429000001_clean_unusable_dataset_menu_set_records.sql`

237 件の不良レコードの `content_embedding` を NULL 化。

### Migration 2 — `20260429000002_drop_failed_concurrent_reindex_shadow.sql`

`idx_dataset_menu_sets_embedding_hnsw_ccnew` を `DROP INDEX IF EXISTS`。

### Migration 3 — `20260429000003_enable_hnsw_iterative_scan_in_search_rpcs.sql`

4 つの埋め込み検索 RPC を `LANGUAGE sql` → `LANGUAGE plpgsql` に変換。先頭で

```sql
PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
PERFORM set_config('hnsw.max_scan_tuples', '20000', true);
```

を実行する。対象は `search_menu_examples`, `search_dataset_ingredients_by_embedding`, `search_ingredients_full_by_embedding`, `search_recipes_hybrid` の 4 本。

### 手動オペレーション (migration には含めない)

```bash
# HNSW index は UPDATE で物理削除されないので、Migration 1 の後に手動 REINDEX を推奨。
# 132K 行 / 1 GB で約 1〜2 分。
psql ... -c "REINDEX INDEX CONCURRENTLY public.idx_dataset_menu_sets_embedding_hnsw;"
```

## Verification

修正後の 12 クエリ全てが正常な top-K を返す:

| Query | cnt | sim top-1 | top-1 title |
|---|---|---|---|
| 減塩の和食献立 | 10 | 0.593 | 塩鮭のみりん漬け / 納豆のほうれん草あえ / … |
| 高たんぱく朝食 | 10 | 0.505 | 朝ごはんは雑穀焼きおむすび |
| **子ども向け献立** | **10** | **0.524** | **子供もパクパク 鮭の甘辛ゴマ絡め / かぶときのこの秋うすくず煮 / 彩りお味噌汁 / ご飯（白米）** |
| 離乳食 | 10 | 0.374 | 豚にらもやしだんご |
| 妊婦さん向け | 10 | 0.341 | 爽やか 梅納豆 |
| 夏バテ | 10 | 0.372 | 夏バテにも 新しょうがと豚肉の炊き込みご飯 / … |
| 糖尿病食 | 10 | 0.567 | 鮭とキャベツのチャーハン / ほうれん草と豆腐の中華スープ |
| 高血圧献立 | 10 | 0.447 | おせち 筑前煮 |
| **ベジタリアン** | **10** | **0.417** | **ネバネバ丼 / 豆腐とねぎの味噌汁** |
| 時短料理 | 10 | 0.490 | 煮込まず時短 ポークビーンズ |
| 親子丼 (recipes_hybrid) | 5 | 1.000 | 親子丼 |
| 味噌汁 (recipes_hybrid) | 5 | 0.638 | とろろ味噌汁 |

## End-to-End verification

`generate-menu-v5` Edge Function を実際に呼び出して、修正後 RPC が本物のパイプラインで動くことを確認した。

**手順:**
1. テストユーザーを `auth.users` + `user_profiles` で作成
2. `weekly_menu_requests` に「減塩の和食、子どもも食べられる夕食」のリクエストを INSERT (`mode=single_meal`, `target_meal_type=dinner`)
3. `POST /functions/v1/generate-menu-v5` を SR_KEY で呼び出し → 202 processing
4. 15 秒後にステータス確認 → `status=completed`, `current_step=3`, `error_message=null`
5. `planned_meals` と `generated_data` を検証
6. テストデータ全削除 (planned_meals 1件、user_daily_meals 1件、weekly_menu_requests 1件、user_profiles、auth.users)

**結果:**

- RAG が **24 件**の `dataset_menu_sets` を取得し、`referenceSummary` に主菜/副菜/汁物/主食/その他で分類して LLM へ渡された
- 候補に「フライパン一つで揚げない鯖の甘酢あんかけ」「揚げない パンプキンコロッケ」「塩分控えめ かれいの煮付け」など、**減塩×子ども向けに即した献立**が並んだ
- LLM が候補を参考に最終献立を組み上げた:
  - **主菜**: フライパン一つで揚げない鯖の南蛮漬け
  - **副菜**: 小松菜と油揚げの胡麻和え
  - **副菜**: かぼちゃとひじきの煮物
  - **AI解説**: 「減塩仕様で甘酸っぱい主菜と胡麻の風味豊かな副菜で子どもも喜ぶ献立です」
  - 栄養: 911 kcal, 塩分 3.2 g
- `planned_meals` テーブルに 1 件の dinner レコードが正しく保存された

これは `search_menu_examples` 修正前なら 0 件返却で V5 がコンテキスト無しで生成するか即エラーで止まる可能性があったケースだが、**修正後は完全な生成パイプラインが 15 秒で完走**することを確認した。修正の RPC 戻り値型 (`vector(1024)`, `numeric→string`) が V5 / `reference-menu-utils.ts` / `template-catalog.ts` の `DatasetMenuSetRaw` 型契約と完全に一致していることも実走で証明された。

## Performance impact

iterative scan を有効化しても実測レイテンシは ef=40 と同等（ネットワーク往復が支配的、HNSW probe 自体は数 ms オーダー）。`max_scan_tuples=20000` は最悪ケースの上限値で、通常クエリではここまで到達しない。

## Why dimension mismatch was NOT the cause

ユーザーから「次元が合っていない」記憶が出たため再検証したが、現状すべて 1024 次元で揃っており不整合はない:

| Table | Column | Type | Populated |
|---|---|---|---|
| dataset_ingredients | name_embedding | vector(1024) | 2,483 / 2,483 |
| dataset_recipes | name_embedding | vector(1024) | 11,707 / 11,707 |
| dataset_menu_sets | content_embedding | vector(1024) | 132,105 / 132,342 ※237 件は本 fix で NULL 化 |
| derived_recipes | name_embedding | vector(1024) | 0（未投入） |
| HNSW indexes | — | vector(1024) | 全テーブル |

`20260308120000_standardize_dataset_embeddings_to_1536.sql` という紛らわしいファイル名が残っているが、中身を読むと実際は **384/1536 → 1024 への標準化**。ファイル名と内容の乖離は今回の調査で確認した。「次元不整合」記憶は、おそらくこの 1536 → 1024 への移行作業中に観測された一時的な不整合の残像。

## Related TODO

`docs/TODO-v4-rag-recovery.md` の以下の項目を本日完了:

- I03 / I04 / N02 / N03 / J03 / J06 / K04 / K05 / L01〜L06

(I02 / I01 / J01 / J02 などは前段でクローズ済み)
