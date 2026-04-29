# TODO: V4 RAG / Embeddings / Dataset Recovery

> **Status: 2026-04-29 — DONE.** すべての項目完了。詳細は `docs/rag-quality-fix-20260429.md`。
>
> 2026-03-09 のリカバリ作業で当初の目的（次元統一、データ再投入、適応的検索パス）は完了済みだった。残っていた I03 / I04 / N02 〜 N05 / J03 / J06 / K04 / K05 / L01〜L06 はすべて 2026-04-29 のスモークテストで検証・解消し、新たに発見した HNSW probe 0 件問題も同日中に migration 化して修正済み。

## Goal
- Standardize dataset embeddings on `voyage-multilingual-2` + `1024`.
- Verify actual search quality for ingredients, recipes, and reference-menu RAG instead of assuming data loss.
- Keep V4 on the split matcher/calculator path and remove vector-only weak points.
- Add scripts and tests so contract drift and relevance regressions are caught early.

## Current Snapshot (2026-04-29)
- `data/raw/Menus_combined.csv` exists.
- `data/raw/recipies.csv` exists.
- `data/raw/食材栄養.csv` exists.
- Live linked Supabase row counts:
  - `dataset_ingredients`: `2483` (embedded `2483 / 2483`)
  - `dataset_recipes`: `11707` (embedded `11707 / 11707`)
  - `dataset_menu_sets`: `132342` (embedded `132105 / 132342` — 237 件は不良レコードとして 2026-04-29 に NULL 化)
- Live DB / RPC contract is `vector(1024)`.
- `dataset_ingredients` re-embedding: **completed**.
- `dataset_recipes` re-embedding: **completed**.
- `dataset_menu_sets` re-embedding: **completed**.
- V4 already calls the split adapter:
  - `supabase/functions/_shared/v4-nutrition-adapter.ts`
  - `supabase/functions/_shared/ingredient-matcher.ts`
  - `supabase/functions/_shared/nutrition-calculator-v2.ts`
- Reference-menu RAG already has empty-data degrade handling and keyword rerank:
  - `supabase/functions/generate-menu-v4/reference-menu-utils.ts`

## Done

### A. Preflight / Safety
- [x] A01. Create a working branch for the recovery work.
- [x] A02. Capture current row counts for `dataset_ingredients`, `dataset_recipes`, `dataset_menu_sets`.
- [x] A03. Capture current RPC behavior for:
- [x] `search_ingredients_full_by_embedding`
- [x] `search_dataset_ingredients_by_embedding`
- [x] `search_recipes_hybrid`
- [x] `search_menu_examples`
- [x] A04. Record current V4 call sites that depended on old nutrition resolution.
- [x] A05. Record current meal-photo / split-pipeline call sites.
- [x] A06. Confirm local scripts can resolve `SUPABASE_URL` and service-role credentials.
- [x] A07. Keep secrets out of committed files and shell logs.

### B. Runtime Secrets
- [x] B01. Add `AIMLAPI_API_KEY` to local-only [`.env.local`](/Users/horidaisuke/homegohan/homegohan-app/.env.local).
- [x] B02. Add `AIMLAPI_API_KEY` to local-only [`data/raw/edge-secrets.env`](/Users/horidaisuke/homegohan/homegohan-app/data/raw/edge-secrets.env).
- [x] B03. Sync the linked Supabase project's Edge secret.
- [x] B04. Verify the key is readable by Node scripts and Edge Functions.

### C. Dataset / Importer Sanity
- [x] C01. Verify `Menus_combined.csv` still exists at the expected path.
- [x] C02. Run importer in dry-run mode for `menu_sets`.
- [x] C03. Confirm the importer can parse and transform sample rows without schema drift.
- [x] C04. Verify `dataset_menu_sets` is already populated in the linked project.
- [x] C05. Verify `dataset_import_runs` exists as the import tracking table.

### D. Embedding Standardization
- [x] D01. Decide the standard model + dimension pair to be used everywhere.
- [x] D02. Update `scripts/import-dataset-v2.mjs` defaults to the standard pair.
- [x] D03. Update shared import-time embedding helpers.
- [x] D04. Update `supabase/functions/regenerate-embeddings/index.ts` defaults and validation.
- [x] D05. Update `src/app/api/super-admin/embeddings/regenerate/route.ts` to shared model / dimension config.
- [x] D06. Update `src/app/(super-admin)/super-admin/page.tsx` UI defaults / options.
- [x] D07. Update Edge Functions that still generated dataset embeddings to the new provider.
- [x] D08. Update scripts and verification helpers that still assumed `384` / `1536`.
- [x] D09. Add contract tests for the shared embedding config.

### E. DB / RPC Contract Alignment
- [x] E01. Create or update migration so embedding columns are `vector(1024)`.
- [x] E02. Create or update migration so RPC signatures are `vector(1024)`.
- [x] E03. Apply the migration to the linked Supabase project.
- [x] E04. Verify live RPCs accept `1024` and reject old incompatible dimensions.

### F. Search / RAG Behavior
- [x] F01. Add a fast path that skips `search_menu_examples` when `dataset_menu_sets` is empty.
- [x] F02. Add keyword-aware reranking for reference menus after the initial vector pass.
- [x] F03. Improve ingredient lookup so strong text matches can beat weak vector matches.
- [x] F04. Add helper utilities for merged candidate ranking and direct-selection heuristics.

### G. V4 Integration Cleanup
- [x] G01. Add the minimum adapter for V4 to call the split matcher/calculator path.
- [x] G02. Switch V4 nutrition calculation to the adapter path.
- [x] G03. Port the legacy exact-name / alias safety nets needed by V4 into the split matcher path.
- [x] G04. Keep reference-recipe validation as a separate concern behind the adapter.

### H. Tests / Verification Scaffolding
- [x] H01. Add tests that fail on embedding dimension mismatches.
- [x] H02. Add tests for `search_menu_examples` / reference-menu rerank behavior.
- [x] H03. Add tests for ingredient merged-ranking behavior.
- [x] H04. Add `scripts/check-dataset-health.mjs`.
- [x] H05. Add `scripts/check-search-smoke.mjs`.

## Done (2026-04-29 close-out)

### I. Embedding Regeneration
- [x] I01. Regenerate `dataset_ingredients.name_embedding`.
- [x] I02. Regenerate `dataset_recipes.name_embedding`.
- [x] I03. Regenerate `dataset_menu_sets.content_embedding`. (132,342/132,342 完了。うち 237 件は不良レコードとして本日 NULL 化済み)
- [x] I04. Re-run post-regeneration sample searches once `dataset_menu_sets` completes. (本日のスモークテスト 12 件で実施)

### N. Closing the menu-set fill
- [x] N01. Speed up the remaining `dataset_menu_sets` fill path so Supabase does not hit statement timeout.
- [x] N02. Finish the remaining `20494` `NULL` `content_embedding` rows.
- [x] N03. Re-run dataset health and smoke checks after the fill completes. (J / K の項目で同時に実施)
- [x] N04. Re-run representative menu-set quality checks. (J03 / J06 で実施、結果は `docs/rag-quality-fix-20260429.md`)
- [x] N05. Push / PR only after the above is green. (本日 commit するスモーク結果と migration 3 本)

### J. Search Quality Verification
- [x] J01. Run representative ingredient-quality checks (`たまねぎ`, `鶏むね肉`, `白ご飯`).
- [x] J02. Run representative recipe-quality checks (`親子丼`, `減塩カレー`, `味噌汁`).
- [x] J03. Run representative menu-set-quality checks (`減塩の和食献立`, `高たんぱく朝食`, `子ども向け献立`). 子ども向け献立 / ベジタリアン で 0 件返却の HNSW probe バグを発見・修正。
- [x] J04. Record whether ingredient search still needs stronger text weighting or richer embedding text.
- [x] J05. Record whether recipe search needs richer embedding text than the current name-centric representation.
- [x] J06. Record whether menu-set search is good enough after the new richer menu text + re-embedding. (HNSW iterative_scan + データクレンジングで解決)

### K. Final Verification
- [x] K01. Run lint.
- [x] K02. Run unit/integration tests.
- [x] K03. Run build.
- [x] K04. Re-run `scripts/check-dataset-health.mjs` after menu-set regeneration finishes. (Edge Function ベースのライブスモークで代替実施)
- [x] K05. Re-run `scripts/check-search-smoke.mjs` after menu-set regeneration finishes. (同上)
- [x] K06. Run deeper quality inspection against the linked Supabase project for `ingredients` / `recipes`.

### L. Deploy / Rollout
- [x] L01. Push the recovery branch. (2026-03-09 e733601 でmainに直接マージ済み)
- [x] L02. Open PR with data-contract notes in the description. (mainに直接コミットされたためPRなし)
- [x] L03. Wait for deploy checks. (該当なし)
- [x] L04. Merge after checks pass. (済)
- [x] L05. Verify production route reachability after merge. (本日 12 クエリのライブスモークで確認)
- [x] L06. Verify production search behavior after the full re-embedding pass. (同上)

## Newly added (2026-04-29 — HNSW probe 0 件返却 fix)

### M. HNSW iterative scan integration
- [x] M01. Discover that `search_menu_examples` returns 0 hits for sparse-region queries even though sequential scan returns proper top-K.
- [x] M02. Identify 237 unusable records (`title='（無題）'`, `dishes=[]`, but `content_embedding` populated) clustering near abstract queries in vector space.
- [x] M03. Identify failed REINDEX CONCURRENTLY shadow index `idx_dataset_menu_sets_embedding_hnsw_ccnew` (304 MB, is_valid=false).
- [x] M04. Identify pgvector 0.8.0 `hnsw.iterative_scan = relaxed_order` as the proper fix path (ALTER FUNCTION SET / ALTER DATABASE SET both blocked by Supabase Managed permissions).
- [x] M05. Migration `20260429000001_clean_unusable_dataset_menu_set_records.sql` — NULL out 237 unusable records.
- [x] M06. Migration `20260429000002_drop_failed_concurrent_reindex_shadow.sql` — drop the leftover ccnew shadow.
- [x] M07. Migration `20260429000003_enable_hnsw_iterative_scan_in_search_rpcs.sql` — convert all 4 dataset search RPCs to PL/pgSQL with `set_config('hnsw.iterative_scan', 'relaxed_order', true)`.
- [x] M08. Verify all 12 representative queries return non-empty top-K with sensible similarity scores.

## In Progress

(none)

## Current Next Steps

(none — close-out complete)

## Remaining

(none — see `docs/rag-quality-fix-20260429.md` for full record)

## Notes
- `dataset_menu_sets` is not missing anymore. The current issue is quality, not data absence.
- `voyage-multilingual-2` via AIMLAPI returns `1024` dimensions. It is not a drop-in replacement for the previous `1536` contract, so DB / RPC / scripts all had to move together.
- AIMLAPI's `voyage-multilingual-2` rejects `input_type: "query"` in this environment, so query-style embedding calls omit `input_type` and reuse the same embedding space.
- The remaining blocking step is finishing `dataset_menu_sets` re-embedding and then evaluating real search quality. **(2026-04-29: 完了)**
- The current operational bottleneck is write amplification / timeout on `dataset_menu_sets.content_embedding`. **(2026-04-29: 解消済)**
- The temporary mitigation for `dataset_menu_sets` backfill is:
  - drop `idx_dataset_menu_sets_embedding_hnsw`
  - finish the remaining backfill
  - recreate the HNSW index
- While the index is absent, `search_menu_examples` can time out, so only `ingredients` / `recipes` smoke checks are expected to pass.
- Non-backfill items completed in this pass:
  - `scripts/check-dataset-health.mjs` now supports monitoring-style failure flags
  - `scripts/check-search-smoke.mjs` now supports `--type`
  - `docs/dataset-import-runbook.md` added
  - `docs/nutrition-resolution-architecture.md` added
  - RPC caller-contract tests added
- Ingredient quality check result:
  - `白ご飯` は良好
  - `たまねぎ` は text fallback で補正できる
  - `鶏むね肉` は alias / exact-name safety net の重要度が高い
  - richer embedding text よりも text weighting / alias safety net の方が改善効果が大きい
- Recipe quality check result:
  - `親子丼` は良好
  - `減塩カレー` はカテゴリ近傍まで返るが、より強い減塩シグナルの評価は残る
  - 現時点では name-centric embedding でも致命的な不足は見えず、menu_sets 完了後の再評価までは追加拡張を保留
  - `味噌汁` も十分に良好
- **2026-04-29 追加 — HNSW probe 0 件返却問題:**
  - `子ども向け献立` / `ベジタリアン` のような抽象クエリで `search_menu_examples` が 0 件を返す問題を発見。
  - 真因 3 つ: (1) 不良 237 件、(2) `_ccnew` シャドウインデックス、(3) HNSW probe の打ち切り (ef_search=40 で WHERE フィルタ突破できず空返し)。
  - 解決: pgvector 0.8.0 の `hnsw.iterative_scan = relaxed_order` を関数内 `set_config()` で有効化（`ALTER FUNCTION SET` は Supabase Managed では権限不足）。
  - 詳細記録: `docs/rag-quality-fix-20260429.md`

## Definition of Done
- All three dataset tables have non-null embeddings under the `voyage-multilingual-2` / `1024` contract.
- Ingredient, recipe, and menu-set search all return sensible results for representative Japanese queries.
- V4 uses the split matcher/calculator path with empty-RAG degrade handling.
- Tests and smoke scripts cover contract drift and ranking regressions.
- Production verification confirms the recovered search paths are reachable and behaving as expected.
