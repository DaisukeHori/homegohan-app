-- Enable pgvector 0.8.0 HNSW iterative scan inside the dataset search RPCs
--
-- BACKGROUND
--   Live RAG smoke testing on 2026-04-29 confirmed that pgvector's default
--   HNSW probe (ef_search=40) silently returns zero rows when the query
--   embedding lands in a sparse region of vector space and the candidate
--   budget is exhausted before any tuple satisfies the function's WHERE
--   clause. Affected example queries against dataset_menu_sets:
--     * "子ども向け献立" → 0 hits (HNSW)  / 10 hits (sequential scan)
--     * "ベジタリアン"   → 0 hits (HNSW)  / 10 hits (sequential scan)
--
-- FIX
--   pgvector 0.8.0 ships an `hnsw.iterative_scan` GUC that, when set, keeps
--   walking the graph until LIMIT rows have actually been returned (rather
--   than stopping at ef_search candidates). Live verification with
--   `SET LOCAL hnsw.iterative_scan = relaxed_order; SET LOCAL
--   hnsw.max_scan_tuples = 20000;` brought the failing queries back to 10
--   hits with sim=0.524 / sim=0.417 respectively, matching exact sequential
--   scan top-1.
--
-- WHY relaxed_order vs strict_order
--   * strict_order: preserves exact distance ordering but cuts off when the
--     candidate list is exhausted. Still under-returns for sparse queries.
--   * relaxed_order: keeps walking and may briefly emit out-of-order tuples,
--     which we then re-sort in the caller via ORDER BY. Smoke runs showed
--     identical top-K to seq scan, which is what we want.
--
-- WHY PL/pgSQL instead of SQL
--   `SET LOCAL` and `set_config(name, value, true)` only take effect inside
--   PL/pgSQL function bodies. The original SQL-language functions could not
--   call set_config, and `ALTER FUNCTION ... SET hnsw.iterative_scan` is
--   blocked by Supabase managed permissions. Wrapping the SELECT in a
--   PL/pgSQL function with PERFORM set_config(...) is the only path.
--
-- SCOPE
--   All four embedding-using RPCs are converted: search_menu_examples,
--   search_dataset_ingredients_by_embedding, search_ingredients_full_by_embedding,
--   and search_recipes_hybrid. Only menu_examples actually exhibits the
--   reproducible HNSW underrun today, but the smaller datasets will hit the
--   same class of bug as they grow, so the fix is applied uniformly.

SET search_path TO public, extensions;
SET statement_timeout TO 0;

-- ============================================================================
-- search_menu_examples
-- ============================================================================
DROP FUNCTION IF EXISTS public.search_menu_examples(vector, integer, text, numeric, text[]);

CREATE OR REPLACE FUNCTION public.search_menu_examples(
  query_embedding vector,
  match_count integer DEFAULT 10,
  filter_meal_type_hint text DEFAULT NULL::text,
  filter_max_sodium numeric DEFAULT NULL::numeric,
  filter_theme_tags text[] DEFAULT NULL::text[]
)
RETURNS TABLE (
  id uuid,
  external_id text,
  title text,
  theme_tags text[],
  meal_type_hint text,
  dishes jsonb,
  calories_kcal integer,
  sodium_g numeric,
  similarity double precision
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  PERFORM set_config('hnsw.max_scan_tuples', '20000', true);

  RETURN QUERY
  SELECT
    m.id,
    m.external_id,
    m.title,
    m.theme_tags,
    m.meal_type_hint,
    m.dishes,
    m.calories_kcal,
    m.sodium_g,
    (1 - (m.content_embedding <=> query_embedding))::double precision AS similarity
  FROM dataset_menu_sets m
  WHERE m.content_embedding IS NOT NULL
    AND COALESCE(NULLIF(btrim(m.title), ''), '') NOT IN ('', '（無題）', '無題')
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(m.dishes, '[]'::jsonb)) AS dish
      WHERE NULLIF(btrim(COALESCE(dish->>'name', '')), '') IS NOT NULL
    )
    AND (filter_meal_type_hint IS NULL OR m.meal_type_hint = filter_meal_type_hint)
    AND (filter_max_sodium IS NULL OR m.sodium_g <= filter_max_sodium)
    AND (filter_theme_tags IS NULL OR m.theme_tags @> filter_theme_tags)
  ORDER BY m.content_embedding <=> query_embedding ASC
  LIMIT match_count;
END;
$function$;

COMMENT ON FUNCTION public.search_menu_examples(vector, integer, text, numeric, text[]) IS
  'menu_set 例検索 (voyage-multilingual-2 / 1024 次元、HNSW iterative_scan=relaxed_order を関数内で有効化)';

-- ============================================================================
-- search_dataset_ingredients_by_embedding
-- ============================================================================
DROP FUNCTION IF EXISTS public.search_dataset_ingredients_by_embedding(vector, integer);

CREATE OR REPLACE FUNCTION public.search_dataset_ingredients_by_embedding(
  query_embedding vector,
  match_count integer DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  name text,
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  salt_eq_g numeric,
  similarity double precision
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  PERFORM set_config('hnsw.max_scan_tuples', '20000', true);

  RETURN QUERY
  SELECT
    i.id,
    i.name,
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.salt_eq_g,
    (1 - (i.name_embedding <=> query_embedding))::double precision AS similarity
  FROM dataset_ingredients i
  WHERE i.name_embedding IS NOT NULL
  ORDER BY i.name_embedding <=> query_embedding ASC
  LIMIT match_count;
END;
$function$;

-- ============================================================================
-- search_ingredients_full_by_embedding
-- ============================================================================
DROP FUNCTION IF EXISTS public.search_ingredients_full_by_embedding(vector, integer);

CREATE OR REPLACE FUNCTION public.search_ingredients_full_by_embedding(
  query_embedding vector,
  match_count integer DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  name text,
  name_norm text,
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  fiber_g numeric,
  sodium_mg numeric,
  potassium_mg numeric,
  calcium_mg numeric,
  magnesium_mg numeric,
  phosphorus_mg numeric,
  iron_mg numeric,
  zinc_mg numeric,
  copper_mg numeric,
  manganese_mg numeric,
  iodine_ug numeric,
  selenium_ug numeric,
  chromium_ug numeric,
  molybdenum_ug numeric,
  cholesterol_mg numeric,
  vitamin_a_ug numeric,
  vitamin_d_ug numeric,
  vitamin_e_alpha_mg numeric,
  vitamin_k_ug numeric,
  vitamin_b1_mg numeric,
  vitamin_b2_mg numeric,
  niacin_mg numeric,
  vitamin_b6_mg numeric,
  vitamin_b12_ug numeric,
  folic_acid_ug numeric,
  pantothenic_acid_mg numeric,
  biotin_ug numeric,
  vitamin_c_mg numeric,
  salt_eq_g numeric,
  water_g numeric,
  alcohol_g numeric,
  discard_rate_percent numeric,
  similarity double precision
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  PERFORM set_config('hnsw.max_scan_tuples', '20000', true);

  RETURN QUERY
  SELECT
    i.id,
    i.name,
    i.name_norm,
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.fiber_g,
    i.sodium_mg,
    i.potassium_mg,
    i.calcium_mg,
    i.magnesium_mg,
    i.phosphorus_mg,
    i.iron_mg,
    i.zinc_mg,
    i.copper_mg,
    i.manganese_mg,
    i.iodine_ug,
    i.selenium_ug,
    i.chromium_ug,
    i.molybdenum_ug,
    i.cholesterol_mg,
    i.vitamin_a_ug,
    i.vitamin_d_ug,
    i.vitamin_e_alpha_mg,
    i.vitamin_k_ug,
    i.vitamin_b1_mg,
    i.vitamin_b2_mg,
    i.niacin_mg,
    i.vitamin_b6_mg,
    i.vitamin_b12_ug,
    i.folic_acid_ug,
    i.pantothenic_acid_mg,
    i.biotin_ug,
    i.vitamin_c_mg,
    i.salt_eq_g,
    i.water_g,
    i.alcohol_g,
    i.discard_rate_percent,
    (1 - (i.name_embedding <=> query_embedding))::double precision AS similarity
  FROM dataset_ingredients i
  WHERE i.name_embedding IS NOT NULL
  ORDER BY i.name_embedding <=> query_embedding ASC
  LIMIT match_count;
END;
$function$;

COMMENT ON FUNCTION public.search_ingredients_full_by_embedding(vector, integer) IS
  '材料名のベクトル検索（voyage-multilingual-2 / 1024 次元、HNSW iterative_scan=relaxed_order を関数内で有効化、全栄養素を返す）';

-- ============================================================================
-- search_recipes_hybrid
-- ============================================================================
DROP FUNCTION IF EXISTS public.search_recipes_hybrid(text, vector, integer, numeric);

CREATE OR REPLACE FUNCTION public.search_recipes_hybrid(
  query_text text,
  query_embedding vector DEFAULT NULL::vector,
  match_count integer DEFAULT 5,
  similarity_threshold numeric DEFAULT 0.15
)
RETURNS TABLE (
  id uuid,
  external_id text,
  name text,
  calories_kcal integer,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  sodium_g numeric,
  fiber_g numeric,
  ingredients_text text,
  instructions_text text,
  combined_score numeric
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  PERFORM set_config('hnsw.max_scan_tuples', '20000', true);

  RETURN QUERY
  SELECT
    r.id,
    r.external_id,
    r.name,
    r.calories_kcal,
    r.protein_g,
    r.fat_g,
    r.carbs_g,
    r.sodium_g,
    r.fiber_g,
    r.ingredients_text,
    r.instructions_text,
    (
      COALESCE(similarity(r.name_norm, normalize_dish_name(query_text)), 0) * 0.4
      +
      CASE
        WHEN query_embedding IS NOT NULL AND r.name_embedding IS NOT NULL
        THEN (1 - (r.name_embedding <=> query_embedding)) * 0.6
        ELSE 0
      END
    )::numeric AS combined_score
  FROM dataset_recipes r
  WHERE
    similarity(r.name_norm, normalize_dish_name(query_text)) >= similarity_threshold
    OR (
      query_embedding IS NOT NULL
      AND r.name_embedding IS NOT NULL
      AND (r.name_embedding <=> query_embedding) < 0.7
    )
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$function$;

COMMENT ON FUNCTION public.search_recipes_hybrid(text, vector, integer, numeric) IS
  'レシピ名のハイブリッド検索（trigram + voyage-multilingual-2、HNSW iterative_scan=relaxed_order を関数内で有効化）';
