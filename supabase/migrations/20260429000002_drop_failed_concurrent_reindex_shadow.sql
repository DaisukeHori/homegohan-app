-- Drop leftover _ccnew shadow index from a failed REINDEX CONCURRENTLY
--
-- BACKGROUND
--   On 2026-04-29 the dataset_menu_sets HNSW index showed a sibling index
--   `idx_dataset_menu_sets_embedding_hnsw_ccnew` with relpages=0, size=304MB,
--   is_valid=false, is_ready=false, is_live=true. This is the residue of a
--   REINDEX CONCURRENTLY that never finished cleaning up.
--
-- WHY IT MATTERS
--   PostgreSQL marks invalid indexes as "live" until they are dropped, which
--   confuses some tooling and consumes disk. While the planner correctly
--   skips is_valid=false indexes, it is still bad hygiene to leave 304 MB
--   of dead index pages behind.
--
-- IDEMPOTENT
--   Uses IF EXISTS so re-running is a no-op.

SET search_path TO public, extensions;

DROP INDEX IF EXISTS public.idx_dataset_menu_sets_embedding_hnsw_ccnew;
