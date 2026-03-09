SET search_path TO public, extensions;
SET statement_timeout TO 0;

-- Temporary operational migration:
-- drop the menu-set vector index so the remaining 1024-dim backfill can finish
-- without per-row HNSW maintenance causing statement timeouts.
DROP INDEX IF EXISTS idx_dataset_menu_sets_embedding_hnsw;
