create extension if not exists pg_trgm with schema extensions;

alter table public.planned_meals
  add column if not exists catalog_product_id uuid references public.catalog_products(id) on delete set null;

create index if not exists idx_planned_meals_catalog_product_id
  on public.planned_meals (catalog_product_id);

create index if not exists idx_catalog_products_name_norm_trgm
  on public.catalog_products using gin (name_norm extensions.gin_trgm_ops);
