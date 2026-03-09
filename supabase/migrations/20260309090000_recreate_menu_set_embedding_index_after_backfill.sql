SET search_path TO public, extensions;
SET statement_timeout TO 0;

-- Recreate the menu-set HNSW index after the 1024-dim backfill finishes.
CREATE INDEX IF NOT EXISTS idx_dataset_menu_sets_embedding_hnsw
  ON dataset_menu_sets USING hnsw (content_embedding vector_cosine_ops);
