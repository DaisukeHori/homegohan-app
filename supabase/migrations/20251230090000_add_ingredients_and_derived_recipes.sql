-- ============================================================
-- v2+: 食材栄養（食材DB） + 派生レシピ永続化
--
-- 目的:
-- - 派生/Creative レシピでも「根拠はDB」に寄せるため、
--   食材ごとの栄養（100gあたり想定）をDBに取り込み、表記揺れに強い検索を提供する。
-- - AIが提案した派生レシピを永続化して後で再利用/評価できるようにする。
--
-- 対象CSV:
-- - data/raw/食材栄養.csv
--   55列（ヘッダに改行を含む列があるので、ETL側で安全にパースすること）
-- ============================================================

-- ============================================================
-- 0. Extensions (念のため)
-- ============================================================
create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;

-- ============================================================
-- 1. dataset_import_runs 拡張（食材取り込み数を記録）
-- ============================================================
alter table dataset_import_runs add column if not exists ingredients_total int default 0;
alter table dataset_import_runs add column if not exists ingredients_inserted int default 0;

-- ============================================================
-- 2. dataset_ingredients（食材栄養）
-- ============================================================
create table if not exists dataset_ingredients (
  id uuid primary key default gen_random_uuid(),

  -- 元データ
  name text not null,
  name_norm text not null,
  discard_rate_percent numeric,
  notes text,

  -- 栄養（原則: 100gあたり想定。ETLで前提を揃える）
  calories_kcal numeric,
  water_g numeric,
  protein_aa_g numeric,
  protein_g numeric,
  fat_fa_tg_g numeric,
  cholesterol_mg numeric,
  fat_g numeric,
  available_carbs_mono_eq_g numeric,
  available_carbs_mass_g numeric,
  available_carbs_diff_g numeric,
  fiber_g numeric,
  sugar_alcohol_g numeric,
  carbs_g numeric,
  organic_acid_g numeric,
  ash_g numeric,
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

  vitamin_a_retinol_ug numeric,
  vitamin_a_alpha_carotene_ug numeric,
  vitamin_a_beta_carotene_ug numeric,
  vitamin_a_beta_cryptoxanthin_ug numeric,
  vitamin_a_beta_carotene_eq_ug numeric,
  vitamin_a_ug numeric, -- レチノール活性当量(μg)

  vitamin_d_ug numeric,

  vitamin_e_alpha_mg numeric,
  vitamin_e_beta_mg numeric,
  vitamin_e_gamma_mg numeric,
  vitamin_e_delta_mg numeric,

  vitamin_k_ug numeric,
  vitamin_b1_mg numeric,
  vitamin_b2_mg numeric,
  niacin_mg numeric,
  niacin_eq_mg numeric,
  vitamin_b6_mg numeric,
  vitamin_b12_ug numeric,
  folic_acid_ug numeric,
  pantothenic_acid_mg numeric,
  biotin_ug numeric,
  vitamin_c_mg numeric,
  alcohol_g numeric,

  -- 塩分（食塩相当量）
  salt_eq_g numeric,

  -- ベクトル（食材名）
  name_embedding vector(384),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_dataset_ingredients_name_norm on dataset_ingredients (name_norm);
create index if not exists idx_dataset_ingredients_name_trgm on dataset_ingredients using gin (name_norm gin_trgm_ops);
create index if not exists idx_dataset_ingredients_name_embedding_hnsw on dataset_ingredients using hnsw (name_embedding vector_cosine_ops);

alter table dataset_ingredients enable row level security;

-- ============================================================
-- 3. 派生レシピ永続化（DB原型 + 差分を保存）
-- ============================================================
create table if not exists derived_recipes (
  id uuid primary key default gen_random_uuid(),

  -- 表示名/検索用
  name text not null,
  name_norm text not null,

  -- 必ずDB原型を持つ（根拠）
  base_dataset_recipe_id uuid not null references dataset_recipes(id) on delete restrict,
  base_dataset_recipe_external_id text,

  -- 生成のトレーサビリティ
  created_by_user_id uuid references auth.users(id) on delete set null,
  source_dataset_version text, -- 生成時の active dataset_version（planned_meals.source_dataset_version と合わせる）
  derived_from_menu_set_external_id text,
  generator text not null default 'ai',
  generation_metadata jsonb,

  servings int not null default 1,

  -- 材料/手順（構造化を優先）
  -- ingredients: [{name, amount_g, note, matched_ingredient_id, similarity, ...}, ...]
  ingredients jsonb not null default '[]'::jsonb,
  instructions text[] null,

  -- 推定/計算された栄養（1食分/servings=1想定）
  calories_kcal integer,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  sodium_g numeric, -- 食塩相当量(g)として利用（planned_meals と一致）
  sugar_g numeric,
  fiber_g numeric,
  fiber_soluble_g numeric,
  fiber_insoluble_g numeric,
  potassium_mg numeric,
  calcium_mg numeric,
  phosphorus_mg numeric,
  iron_mg numeric,
  zinc_mg numeric,
  iodine_ug numeric,
  cholesterol_mg numeric,
  vitamin_b1_mg numeric,
  vitamin_b2_mg numeric,
  vitamin_c_mg numeric,
  vitamin_b6_mg numeric,
  vitamin_b12_ug numeric,
  folic_acid_ug numeric,
  vitamin_a_ug numeric,
  vitamin_d_ug numeric,
  vitamin_k_ug numeric,
  vitamin_e_mg numeric,
  saturated_fat_g numeric,
  monounsaturated_fat_g numeric,
  polyunsaturated_fat_g numeric,

  -- ベクトル（派生レシピ名）
  name_embedding vector(384),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_derived_recipes_name_norm on derived_recipes (name_norm);
create index if not exists idx_derived_recipes_base_dataset_recipe_id on derived_recipes (base_dataset_recipe_id);
create index if not exists idx_derived_recipes_name_embedding_hnsw on derived_recipes using hnsw (name_embedding vector_cosine_ops);

alter table derived_recipes enable row level security;

-- ============================================================
-- 4. Search helper functions
-- ============================================================

-- 食材名の類似検索（pg_trgm）
create or replace function search_similar_dataset_ingredients(
  query_name text,
  similarity_threshold numeric default 0.3,
  result_limit int default 5
)
returns table (
  id uuid,
  name text,
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  salt_eq_g numeric,
  similarity numeric
)
language sql
stable
as $$
  select
    i.id,
    i.name,
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.salt_eq_g,
    similarity(i.name_norm, public.normalize_dish_name(query_name)) as similarity
  from dataset_ingredients i
  where similarity(i.name_norm, public.normalize_dish_name(query_name)) >= similarity_threshold
  order by similarity desc
  limit result_limit;
$$;

-- 食材名の類似検索（ベクトル）
create or replace function search_dataset_ingredients_by_embedding(
  query_embedding vector(384),
  match_count int default 10
)
returns table (
  id uuid,
  name text,
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  salt_eq_g numeric,
  similarity float
)
language sql
stable
as $$
  select
    i.id,
    i.name,
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.salt_eq_g,
    1 - (i.name_embedding <=> query_embedding) as similarity
  from dataset_ingredients i
  where i.name_embedding is not null
  order by i.name_embedding <=> query_embedding asc
  limit match_count;
$$;

-- ============================================================
-- 5. updated_at 自動更新（既存がある場合は再利用）
-- ============================================================
create or replace function update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trigger_dataset_ingredients_updated_at on dataset_ingredients;
create trigger trigger_dataset_ingredients_updated_at
  before update on dataset_ingredients
  for each row
  execute function update_updated_at_column();

drop trigger if exists trigger_derived_recipes_updated_at on derived_recipes;
create trigger trigger_derived_recipes_updated_at
  before update on derived_recipes
  for each row
  execute function update_updated_at_column();


