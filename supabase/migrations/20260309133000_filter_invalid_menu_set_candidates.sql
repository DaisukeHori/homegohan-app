SET search_path TO public, extensions;
SET statement_timeout TO 0;

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
$$;
