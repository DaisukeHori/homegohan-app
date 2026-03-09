# Dataset Import Runbook

## Current Standard
- Embedding provider: `AIMLAPI`
- Embedding model: `voyage-multilingual-2`
- Embedding dimensions: `1024`
- Current CSV defaults:
  - `data/raw/Menus_combined.csv`
  - `data/raw/recipies.csv`
  - `data/raw/食材栄養.csv`

## Required Secrets
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AIMLAPI_API_KEY` when `--with-embeddings` is used

Local execution can resolve these from:
- [`.env.local`](/Users/horidaisuke/homegohan/homegohan-app/.env.local)
- [`data/raw/edge-secrets.env`](/Users/horidaisuke/homegohan/homegohan-app/data/raw/edge-secrets.env)

## Dry Run First
Use dry-run before touching the linked Supabase project.

```bash
node scripts/import-dataset-v2.mjs --dry-run --import menu_sets --limit 3
node scripts/import-dataset-v2.mjs --dry-run --import recipes --limit 3
node scripts/import-dataset-v2.mjs --dry-run --import ingredients --limit 3
```

## Real Import
Run imports by target to keep failures localized.

```bash
node scripts/import-dataset-v2.mjs --import ingredients
node scripts/import-dataset-v2.mjs --import recipes
node scripts/import-dataset-v2.mjs --import menu_sets
```

If embeddings should be generated during import:

```bash
node scripts/import-dataset-v2.mjs --import ingredients --with-embeddings
node scripts/import-dataset-v2.mjs --import recipes --with-embeddings
node scripts/import-dataset-v2.mjs --import menu_sets --with-embeddings
```

## Tracking Import Runs
The importer writes one row to `dataset_import_runs` at start and updates it at finish.

Expected fields:
- `status`
- `dataset_version`
- `menu_sets_total`
- `recipes_total`
- `ingredients_total`
- `menu_sets_inserted`
- `recipes_inserted`
- `ingredients_inserted`
- `completed_at`
- `error_log` on failure

Current linked project check:
- `dataset_import_runs` exists
- existing rows observed: `4`

## Post-Import Verification
Count and embedding checks:

```bash
node scripts/check-dataset-health.mjs --fail-on-zero dataset_ingredients,dataset_recipes,dataset_menu_sets
node scripts/check-dataset-health.mjs --fail-on-missing dataset_ingredients,dataset_recipes
```

Search smoke:

```bash
node scripts/check-search-smoke.mjs --type ingredients
node scripts/check-search-smoke.mjs --type recipes
node scripts/check-search-smoke.mjs --type menu_sets
```

Quality inspection:

```bash
node scripts/check-search-quality.mjs --type ingredients --limit 5
node scripts/check-search-quality.mjs --type recipes --limit 5
node scripts/check-search-quality.mjs --type menu_sets --limit 5
```

## Current Operational Note
- `dataset_menu_sets` already exists in the linked project.
- The only unfinished data task is `dataset_menu_sets.content_embedding` backfill.
- While `idx_dataset_menu_sets_embedding_hnsw` is temporarily dropped for backfill, `search_menu_examples` can time out.
- This affects search speed, not row integrity.
