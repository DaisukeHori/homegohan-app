-- ============================================================
-- Convenience / Retail catalog tables
-- Firecrawl + LLM で取得した中食・市販商品カタログを保持する
-- ============================================================

create table if not exists public.catalog_sources (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  brand_name text not null,
  country_code text not null default 'JP',
  base_url text,
  is_active boolean not null default true,
  crawl_interval_minutes integer not null default 720,
  rate_limit_per_minute integer not null default 12,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.catalog_source_categories (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.catalog_sources(id) on delete cascade,
  category_code text not null,
  category_name text not null,
  list_url text not null,
  is_active boolean not null default true,
  crawl_priority integer not null default 100,
  metadata_json jsonb not null default '{}'::jsonb,
  last_crawled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, category_code)
);

create table if not exists public.catalog_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.catalog_sources(id) on delete cascade,
  trigger_type text not null default 'manual'
    check (trigger_type in ('manual', 'scheduled', 'backfill')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'partial')),
  source_code text not null,
  category_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  categories_total integer not null default 0,
  pages_total integer not null default 0,
  products_seen integer not null default 0,
  products_inserted integer not null default 0,
  products_updated integer not null default 0,
  products_unchanged integer not null default 0,
  products_discontinued integer not null default 0,
  notes text,
  metadata_json jsonb not null default '{}'::jsonb,
  error_log text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.catalog_products (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.catalog_sources(id) on delete cascade,
  external_id text not null,
  canonical_url text not null,
  name text not null,
  name_norm text not null,
  brand_name text not null,
  category_code text,
  subcategory_code text,
  description text,
  price_yen numeric,
  sales_region text,
  availability_status text not null default 'unknown'
    check (availability_status in ('active', 'limited', 'discontinued', 'unknown')),
  main_image_url text,
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  fiber_g numeric,
  sodium_g numeric,
  sugar_g numeric,
  nutrition_json jsonb not null default '{}'::jsonb,
  allergens_json jsonb not null default '[]'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  discontinued_at timestamptz,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_id)
);

create table if not exists public.catalog_product_snapshots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.catalog_products(id) on delete cascade,
  import_run_id uuid references public.catalog_import_runs(id) on delete set null,
  snapshot_hash text not null,
  name text not null,
  price_yen numeric,
  main_image_url text,
  availability_status text,
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  fiber_g numeric,
  sodium_g numeric,
  sugar_g numeric,
  nutrition_json jsonb not null default '{}'::jsonb,
  allergens_json jsonb not null default '[]'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  unique (product_id, snapshot_hash)
);

create table if not exists public.catalog_raw_documents (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.catalog_sources(id) on delete cascade,
  import_run_id uuid references public.catalog_import_runs(id) on delete set null,
  category_code text,
  document_type text not null
    check (document_type in ('list', 'detail')),
  url text not null,
  http_status integer,
  content_sha256 text not null,
  payload jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now()
);

create index if not exists idx_catalog_source_categories_source_active
  on public.catalog_source_categories(source_id, is_active, crawl_priority, category_code);
create index if not exists idx_catalog_import_runs_source_started_at
  on public.catalog_import_runs(source_id, started_at desc);
create index if not exists idx_catalog_import_runs_status
  on public.catalog_import_runs(status, started_at desc);
create index if not exists idx_catalog_products_source_category_status
  on public.catalog_products(source_id, category_code, availability_status);
create index if not exists idx_catalog_products_name_norm
  on public.catalog_products(name_norm);
create index if not exists idx_catalog_products_last_seen_at
  on public.catalog_products(last_seen_at desc);
create index if not exists idx_catalog_product_snapshots_product_captured_at
  on public.catalog_product_snapshots(product_id, captured_at desc);
create index if not exists idx_catalog_raw_documents_import_run
  on public.catalog_raw_documents(import_run_id, fetched_at desc);

alter table public.catalog_sources enable row level security;
alter table public.catalog_source_categories enable row level security;
alter table public.catalog_import_runs enable row level security;
alter table public.catalog_products enable row level security;
alter table public.catalog_product_snapshots enable row level security;
alter table public.catalog_raw_documents enable row level security;

drop policy if exists "catalog_sources_select_all" on public.catalog_sources;
create policy "catalog_sources_select_all"
  on public.catalog_sources
  for select
  to anon, authenticated
  using (true);

drop policy if exists "catalog_source_categories_select_all" on public.catalog_source_categories;
create policy "catalog_source_categories_select_all"
  on public.catalog_source_categories
  for select
  to anon, authenticated
  using (true);

drop policy if exists "catalog_products_select_all" on public.catalog_products;
create policy "catalog_products_select_all"
  on public.catalog_products
  for select
  to anon, authenticated
  using (true);

drop policy if exists "catalog_product_snapshots_service_role_all" on public.catalog_product_snapshots;
create policy "catalog_product_snapshots_service_role_all"
  on public.catalog_product_snapshots
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "catalog_import_runs_service_role_all" on public.catalog_import_runs;
create policy "catalog_import_runs_service_role_all"
  on public.catalog_import_runs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "catalog_raw_documents_service_role_all" on public.catalog_raw_documents;
create policy "catalog_raw_documents_service_role_all"
  on public.catalog_raw_documents
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trigger_catalog_sources_updated_at on public.catalog_sources;
create trigger trigger_catalog_sources_updated_at
  before update on public.catalog_sources
  for each row
  execute function public.update_updated_at_column();

drop trigger if exists trigger_catalog_source_categories_updated_at on public.catalog_source_categories;
create trigger trigger_catalog_source_categories_updated_at
  before update on public.catalog_source_categories
  for each row
  execute function public.update_updated_at_column();

drop trigger if exists trigger_catalog_import_runs_updated_at on public.catalog_import_runs;
create trigger trigger_catalog_import_runs_updated_at
  before update on public.catalog_import_runs
  for each row
  execute function public.update_updated_at_column();

drop trigger if exists trigger_catalog_products_updated_at on public.catalog_products;
create trigger trigger_catalog_products_updated_at
  before update on public.catalog_products
  for each row
  execute function public.update_updated_at_column();

insert into public.catalog_sources (
  code,
  brand_name,
  country_code,
  base_url,
  crawl_interval_minutes,
  rate_limit_per_minute,
  metadata_json
)
values (
  'seven_eleven_jp',
  'セブンイレブン',
  'JP',
  'https://www.sej.co.jp',
  720,
  12,
  jsonb_build_object(
    'provider', 'firecrawl',
    'notes', 'Firecrawl + LLM normalization import'
  )
)
on conflict (code) do update
set
  brand_name = excluded.brand_name,
  country_code = excluded.country_code,
  base_url = excluded.base_url,
  crawl_interval_minutes = excluded.crawl_interval_minutes,
  rate_limit_per_minute = excluded.rate_limit_per_minute,
  metadata_json = excluded.metadata_json,
  is_active = true;

insert into public.catalog_source_categories (
  source_id,
  category_code,
  category_name,
  list_url,
  crawl_priority,
  metadata_json
)
select
  s.id,
  v.category_code,
  v.category_name,
  v.list_url,
  v.crawl_priority,
  '{}'::jsonb
from public.catalog_sources s
cross join (
  values
    ('onigiri', 'おにぎり', 'https://www.sej.co.jp/products/a/onigiri/', 10),
    ('bento', 'お弁当', 'https://www.sej.co.jp/products/a/bento/', 20),
    ('men', '麺類', 'https://www.sej.co.jp/products/a/men/', 30),
    ('sandwich', 'サンドイッチ・ロールパン', 'https://www.sej.co.jp/products/a/sandwich/', 40)
) as v(category_code, category_name, list_url, crawl_priority)
where s.code = 'seven_eleven_jp'
on conflict (source_id, category_code) do update
set
  category_name = excluded.category_name,
  list_url = excluded.list_url,
  crawl_priority = excluded.crawl_priority,
  is_active = true;

comment on table public.catalog_sources is 'コンビニ・市販商品カタログの取得元マスタ';
comment on table public.catalog_source_categories is '取得元ごとのカテゴリ一覧';
comment on table public.catalog_import_runs is 'Firecrawl + LLM 正規化の取り込み実行履歴';
comment on table public.catalog_products is '市販商品の正本テーブル（現行状態）';
comment on table public.catalog_product_snapshots is '商品内容の差分履歴';
comment on table public.catalog_raw_documents is 'Firecrawl取得結果の生データ保存';
