-- Clean unusable dataset_menu_sets records (HNSW pollution fix)
--
-- BACKGROUND
--   Live RAG smoke testing on 2026-04-29 found that abstract menu-set queries
--   (e.g. "子ども向け献立", "ベジタリアン") returned 0 results from
--   search_menu_examples even though sequential-scan exact search returned
--   correct top hits. EXPLAIN ANALYZE showed the HNSW probe terminating
--   with rows=0 after touching only ~293 buffer pages.
--
-- ROOT CAUSE
--   237 records (0.18% of dataset_menu_sets) had:
--     * title = '（無題）' or empty
--     * dishes = '[]' (no named dish)
--     * BUT they still had content_embedding populated
--   These records clustered tightly in vector space (similarity 0.486-0.488 to
--   each other), so HNSW's local probe filled its candidate budget with these
--   unusable rows. The function-level WHERE clause then rejected all of them,
--   leaving zero results.
--
-- FIX
--   Set content_embedding = NULL for any record that the function-level
--   WHERE filter would reject anyway. Once these are NULL the HNSW index
--   stops indexing them and the probe escapes the unusable cluster.
--
-- IDEMPOTENT
--   Re-running this migration is safe; the WHERE clause already filters by
--   IS NOT NULL so a no-op UPDATE does no harm.

SET search_path TO public, extensions;
SET statement_timeout TO 0;

UPDATE dataset_menu_sets
SET content_embedding = NULL
WHERE content_embedding IS NOT NULL
  AND (
    COALESCE(NULLIF(btrim(title), ''), '') IN ('', '無題', '（無題）')
    OR jsonb_array_length(COALESCE(dishes, '[]'::jsonb)) = 0
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(dishes, '[]'::jsonb)) AS dish
      WHERE NULLIF(btrim(COALESCE(dish->>'name', '')), '') IS NOT NULL
    )
  );

-- Operational note (NOT executed here — run manually after migration):
--
--   REINDEX INDEX CONCURRENTLY public.idx_dataset_menu_sets_embedding_hnsw;
--
-- The HNSW index does not physically remove tuples on UPDATE; it just marks
-- them deleted. The probe still walks through them, which is precisely the
-- bug we are working around. A manual REINDEX after this migration is
-- strongly recommended for full performance recovery. Keep an eye on
-- pg_stat_activity — the rebuild can take ~1-2 min on 132K rows / 1 GB index.
