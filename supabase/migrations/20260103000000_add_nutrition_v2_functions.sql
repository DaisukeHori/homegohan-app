-- 食事写真分析v2用DB関数
-- 材料マッチング（ベクトル検索）とレシピ検証用

-- ============================================
-- 1. 材料マッチング用関数（全栄養素を返す）
-- ============================================
CREATE OR REPLACE FUNCTION search_ingredients_full_by_embedding(
  query_embedding vector(1536),
  match_count integer DEFAULT 5
) RETURNS TABLE (
  id uuid,
  name text,
  name_norm text,
  -- 基本栄養素
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  fiber_g numeric,
  -- ミネラル
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
  -- コレステロール
  cholesterol_mg numeric,
  -- ビタミン
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
  -- その他
  salt_eq_g numeric,
  water_g numeric,
  alcohol_g numeric,
  discard_rate_percent numeric,
  -- 類似度
  similarity double precision
) LANGUAGE sql STABLE AS $$
  SELECT
    i.id,
    i.name,
    i.name_norm,
    -- 基本栄養素
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.fiber_g,
    -- ミネラル
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
    -- コレステロール
    i.cholesterol_mg,
    -- ビタミン
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
    -- その他
    i.salt_eq_g,
    i.water_g,
    i.alcohol_g,
    i.discard_rate_percent,
    -- 類似度（1 - コサイン距離）
    1 - (i.name_embedding <=> query_embedding) as similarity
  FROM dataset_ingredients i
  WHERE i.name_embedding IS NOT NULL
  ORDER BY i.name_embedding <=> query_embedding ASC
  LIMIT match_count;
$$;

-- ============================================
-- 2. レシピ検証用関数（栄養素付き）
-- ============================================
CREATE OR REPLACE FUNCTION search_recipes_with_nutrition(
  query_name text,
  similarity_threshold numeric DEFAULT 0.3,
  result_limit integer DEFAULT 5
) RETURNS TABLE (
  id uuid,
  name text,
  name_norm text,
  source_url text,
  ingredients_text text,
  -- 基本栄養素
  calories_kcal integer,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  fiber_g numeric,
  -- ミネラル
  sodium_g numeric,
  potassium_mg numeric,
  calcium_mg numeric,
  phosphorus_mg numeric,
  iron_mg numeric,
  zinc_mg numeric,
  iodine_ug numeric,
  cholesterol_mg numeric,
  -- ビタミン
  vitamin_a_ug numeric,
  vitamin_d_ug numeric,
  vitamin_e_mg numeric,
  vitamin_k_ug numeric,
  vitamin_b1_mg numeric,
  vitamin_b2_mg numeric,
  vitamin_b6_mg numeric,
  vitamin_b12_ug numeric,
  folic_acid_ug numeric,
  vitamin_c_mg numeric,
  -- 脂肪酸
  saturated_fat_g numeric,
  monounsaturated_fat_g numeric,
  polyunsaturated_fat_g numeric,
  -- 類似度
  similarity numeric
) LANGUAGE sql STABLE AS $$
  SELECT
    r.id,
    r.name,
    r.name_norm,
    r.source_url,
    r.ingredients_text,
    -- 基本栄養素
    r.calories_kcal,
    r.protein_g,
    r.fat_g,
    r.carbs_g,
    r.fiber_g,
    -- ミネラル
    r.sodium_g,
    r.potassium_mg,
    r.calcium_mg,
    r.phosphorus_mg,
    r.iron_mg,
    r.zinc_mg,
    r.iodine_ug,
    r.cholesterol_mg,
    -- ビタミン
    r.vitamin_a_ug,
    r.vitamin_d_ug,
    r.vitamin_e_mg,
    r.vitamin_k_ug,
    r.vitamin_b1_mg,
    r.vitamin_b2_mg,
    r.vitamin_b6_mg,
    r.vitamin_b12_ug,
    r.folic_acid_ug,
    r.vitamin_c_mg,
    -- 脂肪酸
    r.saturated_fat_g,
    r.monounsaturated_fat_g,
    r.polyunsaturated_fat_g,
    -- 類似度（pg_trgm）
    similarity(r.name_norm, public.normalize_dish_name(query_name)) as similarity
  FROM dataset_recipes r
  WHERE similarity(r.name_norm, public.normalize_dish_name(query_name)) >= similarity_threshold
  ORDER BY similarity DESC
  LIMIT result_limit;
$$;

-- ============================================
-- 3. テキスト類似度検索（フォールバック用）
-- ============================================
CREATE OR REPLACE FUNCTION search_ingredients_by_text_similarity(
  query_name text,
  similarity_threshold numeric DEFAULT 0.3,
  result_limit integer DEFAULT 5
) RETURNS TABLE (
  id uuid,
  name text,
  name_norm text,
  -- 基本栄養素
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  fiber_g numeric,
  -- ミネラル
  sodium_mg numeric,
  potassium_mg numeric,
  calcium_mg numeric,
  magnesium_mg numeric,
  phosphorus_mg numeric,
  iron_mg numeric,
  zinc_mg numeric,
  iodine_ug numeric,
  cholesterol_mg numeric,
  -- ビタミン
  vitamin_a_ug numeric,
  vitamin_d_ug numeric,
  vitamin_e_alpha_mg numeric,
  vitamin_k_ug numeric,
  vitamin_b1_mg numeric,
  vitamin_b2_mg numeric,
  vitamin_b6_mg numeric,
  vitamin_b12_ug numeric,
  folic_acid_ug numeric,
  vitamin_c_mg numeric,
  -- その他
  salt_eq_g numeric,
  discard_rate_percent numeric,
  -- 類似度
  similarity numeric
) LANGUAGE sql STABLE AS $$
  SELECT
    i.id,
    i.name,
    i.name_norm,
    -- 基本栄養素
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.fiber_g,
    -- ミネラル
    i.sodium_mg,
    i.potassium_mg,
    i.calcium_mg,
    i.magnesium_mg,
    i.phosphorus_mg,
    i.iron_mg,
    i.zinc_mg,
    i.iodine_ug,
    i.cholesterol_mg,
    -- ビタミン
    i.vitamin_a_ug,
    i.vitamin_d_ug,
    i.vitamin_e_alpha_mg,
    i.vitamin_k_ug,
    i.vitamin_b1_mg,
    i.vitamin_b2_mg,
    i.vitamin_b6_mg,
    i.vitamin_b12_ug,
    i.folic_acid_ug,
    i.vitamin_c_mg,
    -- その他
    i.salt_eq_g,
    i.discard_rate_percent,
    -- 類似度（pg_trgm）
    similarity(i.name_norm, query_name) as similarity
  FROM dataset_ingredients i
  WHERE similarity(i.name_norm, query_name) >= similarity_threshold
  ORDER BY similarity DESC
  LIMIT result_limit;
$$;

-- コメント追加
COMMENT ON FUNCTION search_ingredients_full_by_embedding IS '材料名のベクトル検索（全栄養素を返す）- 食事写真分析v2用';
COMMENT ON FUNCTION search_recipes_with_nutrition IS 'レシピ名のテキスト類似度検索（栄養素付き）- エビデンス検証用';
COMMENT ON FUNCTION search_ingredients_by_text_similarity IS '材料名のテキスト類似度検索（フォールバック用）';
