-- 食材ベクトル検索の次元を384に修正
-- 元のRPC関数は1536次元を期待していたが、実際のデータは384次元

-- search_pathにextensionsを追加してvector型を認識させる
SET search_path TO public, extensions;

-- 既存関数を削除（1536次元版）
DROP FUNCTION IF EXISTS search_ingredients_full_by_embedding(vector(1536), integer);

-- 384次元で再作成
CREATE OR REPLACE FUNCTION search_ingredients_full_by_embedding(
  query_embedding vector(384),
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
    -- 類似度
    1 - (i.name_embedding <=> query_embedding) as similarity
  FROM dataset_ingredients i
  WHERE i.name_embedding IS NOT NULL
  ORDER BY i.name_embedding <=> query_embedding ASC
  LIMIT match_count;
$$;

COMMENT ON FUNCTION search_ingredients_full_by_embedding(vector(384), integer) IS '材料名のベクトル検索（384次元、全栄養素を返す）- 食事写真分析v2用';
