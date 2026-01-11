-- ============================================================
-- レシピDB検索用ハイブリッド検索関数
-- trigram + vector の組み合わせで高精度な検索を実現
-- ============================================================

CREATE OR REPLACE FUNCTION search_recipes_hybrid(
  query_text text,
  query_embedding vector(384) DEFAULT NULL,
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
      -- trigram similarity (40%)
      COALESCE(similarity(r.name_norm, normalize_dish_name(query_text)), 0) * 0.4 +
      -- vector similarity (60%)
      CASE
        WHEN query_embedding IS NOT NULL AND r.name_embedding IS NOT NULL
        THEN (1 - (r.name_embedding <=> query_embedding)) * 0.6
        ELSE 0
      END
    ) AS combined_score
  FROM dataset_recipes r
  WHERE
    -- trigram match
    similarity(r.name_norm, normalize_dish_name(query_text)) >= similarity_threshold
    OR (
      -- vector match
      query_embedding IS NOT NULL
      AND r.name_embedding IS NOT NULL
      AND (r.name_embedding <=> query_embedding) < 0.7
    )
  ORDER BY combined_score DESC
  LIMIT match_count;
$$;

-- コメント追加
COMMENT ON FUNCTION search_recipes_hybrid IS 'レシピDBのハイブリッド検索（trigram + vector）。AIアドバイザーから呼び出される。';
