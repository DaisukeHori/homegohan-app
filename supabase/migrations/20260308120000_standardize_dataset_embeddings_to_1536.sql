SET search_path TO public, extensions;
SET statement_timeout TO 0;

-- Standardize dataset-related embeddings on voyage-multilingual-2 / 1024 dimensions.
-- Existing vectors are cleared first so the column type can be altered safely.

UPDATE dataset_ingredients SET name_embedding = NULL WHERE name_embedding IS NOT NULL;
UPDATE dataset_recipes SET name_embedding = NULL WHERE name_embedding IS NOT NULL;
UPDATE dataset_menu_sets SET content_embedding = NULL WHERE content_embedding IS NOT NULL;
UPDATE derived_recipes SET name_embedding = NULL WHERE name_embedding IS NOT NULL;

ALTER TABLE dataset_ingredients
  ALTER COLUMN name_embedding TYPE vector(1024);

ALTER TABLE dataset_recipes
  ALTER COLUMN name_embedding TYPE vector(1024);

ALTER TABLE dataset_menu_sets
  ALTER COLUMN content_embedding TYPE vector(1024);

ALTER TABLE derived_recipes
  ALTER COLUMN name_embedding TYPE vector(1024);

DROP INDEX IF EXISTS idx_dataset_ingredients_name_embedding_hnsw;
DROP INDEX IF EXISTS idx_dataset_recipes_name_embedding_hnsw;
DROP INDEX IF EXISTS idx_dataset_menu_sets_embedding_hnsw;
DROP INDEX IF EXISTS idx_derived_recipes_name_embedding_hnsw;

CREATE INDEX IF NOT EXISTS idx_dataset_ingredients_name_embedding_hnsw
  ON dataset_ingredients USING hnsw (name_embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_dataset_recipes_name_embedding_hnsw
  ON dataset_recipes USING hnsw (name_embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_dataset_menu_sets_embedding_hnsw
  ON dataset_menu_sets USING hnsw (content_embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_derived_recipes_name_embedding_hnsw
  ON derived_recipes USING hnsw (name_embedding vector_cosine_ops);

DROP FUNCTION IF EXISTS search_dataset_ingredients_by_embedding(vector(384), integer);
DROP FUNCTION IF EXISTS search_dataset_ingredients_by_embedding(vector(1536), integer);
DROP FUNCTION IF EXISTS search_dataset_ingredients_by_embedding(vector(1024), integer);
CREATE OR REPLACE FUNCTION search_dataset_ingredients_by_embedding(
  query_embedding vector(1024),
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  name text,
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  salt_eq_g numeric,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    i.id,
    i.name,
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.salt_eq_g,
    1 - (i.name_embedding <=> query_embedding) as similarity
  FROM dataset_ingredients i
  WHERE i.name_embedding IS NOT NULL
  ORDER BY i.name_embedding <=> query_embedding ASC
  LIMIT match_count;
$$;

DROP FUNCTION IF EXISTS search_ingredients_full_by_embedding(vector(384), integer);
DROP FUNCTION IF EXISTS search_ingredients_full_by_embedding(vector(1536), integer);
DROP FUNCTION IF EXISTS search_ingredients_full_by_embedding(vector(1024), integer);
CREATE OR REPLACE FUNCTION search_ingredients_full_by_embedding(
  query_embedding vector(1024),
  match_count integer DEFAULT 5
) RETURNS TABLE (
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
) LANGUAGE sql STABLE AS $$
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
    1 - (i.name_embedding <=> query_embedding) as similarity
  FROM dataset_ingredients i
  WHERE i.name_embedding IS NOT NULL
  ORDER BY i.name_embedding <=> query_embedding ASC
  LIMIT match_count;
$$;

DROP FUNCTION IF EXISTS search_menu_examples(vector(384), integer, text, numeric, text[]);
DROP FUNCTION IF EXISTS search_menu_examples(vector(1536), integer, text, numeric, text[]);
DROP FUNCTION IF EXISTS search_menu_examples(vector(1024), integer, text, numeric, text[]);
CREATE OR REPLACE FUNCTION search_menu_examples(
  query_embedding vector(1024),
  match_count int DEFAULT 10,
  filter_meal_type_hint text DEFAULT NULL,
  filter_max_sodium numeric DEFAULT NULL,
  filter_theme_tags text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  external_id text,
  title text,
  theme_tags text[],
  meal_type_hint text,
  dishes jsonb,
  calories_kcal int,
  sodium_g numeric,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id,
    m.external_id,
    m.title,
    m.theme_tags,
    m.meal_type_hint,
    m.dishes,
    m.calories_kcal,
    m.sodium_g,
    1 - (m.content_embedding <=> query_embedding) as similarity
  FROM dataset_menu_sets m
  WHERE m.content_embedding IS NOT NULL
    AND (filter_meal_type_hint IS NULL OR m.meal_type_hint = filter_meal_type_hint)
    AND (filter_max_sodium IS NULL OR m.sodium_g <= filter_max_sodium)
    AND (filter_theme_tags IS NULL OR m.theme_tags @> filter_theme_tags)
  ORDER BY m.content_embedding <=> query_embedding ASC
  LIMIT match_count;
$$;

DROP FUNCTION IF EXISTS search_recipes_hybrid(text, vector(384), int, numeric);
DROP FUNCTION IF EXISTS search_recipes_hybrid(text, vector(1536), int, numeric);
DROP FUNCTION IF EXISTS search_recipes_hybrid(text, vector(1024), int, numeric);
CREATE OR REPLACE FUNCTION search_recipes_hybrid(
  query_text text,
  query_embedding vector(1024) DEFAULT NULL,
  match_count int DEFAULT 5,
  similarity_threshold numeric DEFAULT 0.15
)
RETURNS TABLE (
  id uuid,
  external_id text,
  name text,
  calories_kcal int,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  sodium_g numeric,
  fiber_g numeric,
  ingredients_text text,
  instructions_text text,
  combined_score numeric
)
LANGUAGE sql
STABLE
AS $$
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
      COALESCE(similarity(r.name_norm, normalize_dish_name(query_text)), 0) * 0.4 +
      CASE
        WHEN query_embedding IS NOT NULL AND r.name_embedding IS NOT NULL
        THEN (1 - (r.name_embedding <=> query_embedding)) * 0.6
        ELSE 0
      END
    ) AS combined_score
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
$$;
