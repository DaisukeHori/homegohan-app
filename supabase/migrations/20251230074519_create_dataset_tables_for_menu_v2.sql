-- ============================================================
-- v2: データセット駆動の献立生成（CSV実態対応版）
--
-- Supabase migrations:
-- - 20251230074519_create_dataset_tables_for_menu_v2 (remote)
--
-- 対象CSV:
-- - Menus_combined.csv: 献立セット（料理1〜5 + 合計栄養 + テーマ）
--   ※ 注意: 「料理2カロリー(kcal)」は壊れているため、ETLで
--      料理2kcal = 全エネルギー - (料理1 + 料理3 + 料理4 + 料理5)
--      として復元する。
-- - recipies.csv: レシピ（料理名 + 栄養 + 材料 + 作り方）
--   ※ amino_acid(g) は実質「たんぱく質(g)」として整合するため、protein_g に格納する。
--
-- Embedding:
-- - OpenAI text-embedding-3-small を dimensions=384 で生成し、vector(384) に格納する想定。
-- ============================================================

-- ============================================================
-- 0. Extensions
-- ============================================================
create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;

-- ============================================================
-- 1. Import runs (ETLの実行履歴)
-- ============================================================
create table if not exists dataset_import_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_version text not null,            -- 例: 'oishi-kenko-2025-12-30'
  source text,                              -- 例: 'oishi-kenko'
  started_at timestamptz default now(),
  completed_at timestamptz,
  status text not null default 'running',   -- 'running' | 'completed' | 'failed'

  menu_sets_total int default 0,
  recipes_total int default 0,
  menu_sets_inserted int default 0,
  recipes_inserted int default 0,

  notes text,
  error_log text
);

alter table dataset_import_runs enable row level security;

-- ============================================================
-- 2. Recipes (recipies.csv)
-- ============================================================
create table if not exists dataset_recipes (
  id uuid primary key default gen_random_uuid(),
  external_id text unique not null,         -- web-scraper-order
  source_url text,                          -- web-scraper-start-url

  name text not null,
  name_norm text not null,                  -- 料理名正規化（ETLで付与）

  -- テキスト（現状は生テキストを保持。必要なら後でJSON化）
  target_audience_raw text,                 -- こんな病気・お悩み...
  tag_raw text,                             -- Tag（区切りが不明確なのでrawで保持）
  ingredients_text text,                    -- 材料 1 人
  instructions_text text,                   -- 作り方

  -- 栄養（1人前相当）
  calories_kcal integer,
  sodium_g numeric,                         -- 食塩相当量(g)
  protein_g numeric,                        -- recipies.csv の amino_acid(g) を格納
  fat_g numeric,
  carbs_g numeric,                          -- sugar_g + fiber_g を基本としてETLで計算
  sugar_g numeric,                          -- 糖質(g)
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

  -- ベクトル（料理名）
  name_embedding vector(384),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_dataset_recipes_name_norm on dataset_recipes (name_norm);
create index if not exists idx_dataset_recipes_name_trgm on dataset_recipes using gin (name_norm gin_trgm_ops);
create index if not exists idx_dataset_recipes_name_embedding_hnsw on dataset_recipes using hnsw (name_embedding vector_cosine_ops);

alter table dataset_recipes enable row level security;

-- ============================================================
-- 3. Menu sets (Menus_combined.csv)
-- ============================================================
create table if not exists dataset_menu_sets (
  id uuid primary key default gen_random_uuid(),
  external_id text unique not null,         -- web-scraper-order
  source_url text,                          -- web-scraper-start-url

  title text not null,                      -- ETLで生成（料理名を連結）
  theme_raw text,                           -- 対象献立（例: "食事のテーマ：高血圧 糖尿病（2型）"）
  theme_tags text[],                        -- ETLで正規化（例: ['高血圧','糖尿病（2型）']）

  meal_type_hint text,                      -- 'breakfast'|'lunch'|'dinner'|'snack' など（ETL/後段で推定、NULL可）

  dish_count integer not null default 0,
  dishes jsonb not null default '[]'::jsonb,

  -- 栄養（セット全体の合計、確定値）
  calories_kcal integer,
  sodium_g numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  sugar_g numeric,
  fiber_g numeric,
  fiber_soluble_g numeric,
  potassium_mg numeric,
  calcium_mg numeric,                       -- CSVヘッダは(g)だが値はmg相当のためmgとして格納
  magnesium_mg numeric,
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

  -- ベクトル（献立例）
  content_embedding vector(384),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_dataset_menu_sets_theme_tags on dataset_menu_sets using gin (theme_tags);
create index if not exists idx_dataset_menu_sets_meal_type_hint on dataset_menu_sets (meal_type_hint);
create index if not exists idx_dataset_menu_sets_embedding_hnsw on dataset_menu_sets using hnsw (content_embedding vector_cosine_ops);

alter table dataset_menu_sets enable row level security;

-- ============================================================
-- 4. planned_meals のトレーサビリティ拡張（将来のv2生成で使用）
-- ============================================================
alter table planned_meals add column if not exists source_type text default 'legacy' not null;
alter table planned_meals add column if not exists source_dataset_version text;
alter table planned_meals add column if not exists source_menu_set_external_id text;
alter table planned_meals add column if not exists generation_metadata jsonb;

create index if not exists idx_planned_meals_source_type on planned_meals (source_type);
create index if not exists idx_planned_meals_source_menu_set_external_id on planned_meals (source_menu_set_external_id);

-- ============================================================
-- 5. Helper functions
-- ============================================================

create or replace function normalize_dish_name(name text)
returns text
language plpgsql
immutable
as $$
begin
  return lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(name, ''), '[\\s　]+', '', 'g'),
          '（[^）]*）', '', 'g'
        ),
        '\\([^)]*\\)', '', 'g'
      ),
      '[・･]', '', 'g'
    )
  );
end;
$$;

create or replace function search_similar_dataset_recipes(
  query_name text,
  similarity_threshold numeric default 0.3,
  result_limit int default 5
)
returns table (
  id uuid,
  external_id text,
  name text,
  similarity numeric
)
language sql
stable
as $$
  select
    r.id,
    r.external_id,
    r.name,
    similarity(r.name_norm, normalize_dish_name(query_name)) as similarity
  from dataset_recipes r
  where similarity(r.name_norm, normalize_dish_name(query_name)) >= similarity_threshold
  order by similarity desc
  limit result_limit;
$$;

create or replace function search_menu_examples(
  query_embedding vector(384),
  match_count int default 10,
  filter_meal_type_hint text default null,
  filter_max_sodium numeric default null,
  filter_theme_tags text[] default null
)
returns table (
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
language sql
stable
as $$
  select
    m.id,
    m.external_id,
    m.title,
    m.theme_tags,
    m.meal_type_hint,
    m.dishes,
    m.calories_kcal,
    m.sodium_g,
    1 - (m.content_embedding <=> query_embedding) as similarity
  from dataset_menu_sets m
  where m.content_embedding is not null
    and (filter_meal_type_hint is null or m.meal_type_hint = filter_meal_type_hint)
    and (filter_max_sodium is null or m.sodium_g <= filter_max_sodium)
    and (filter_theme_tags is null or m.theme_tags @> filter_theme_tags)
  order by m.content_embedding <=> query_embedding asc
  limit match_count;
$$;

-- ============================================================
-- 6. updated_at 自動更新
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

drop trigger if exists trigger_dataset_menu_sets_updated_at on dataset_menu_sets;
create trigger trigger_dataset_menu_sets_updated_at
  before update on dataset_menu_sets
  for each row
  execute function update_updated_at_column();

drop trigger if exists trigger_dataset_recipes_updated_at on dataset_recipes;
create trigger trigger_dataset_recipes_updated_at
  before update on dataset_recipes
  for each row
  execute function update_updated_at_column();


