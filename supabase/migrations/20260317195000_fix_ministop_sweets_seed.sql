with ministop_source as (
  select id
  from public.catalog_sources
  where code = 'ministop_jp'
)
update public.catalog_source_categories c
set
  list_url = 'https://www.ministop.co.jp/syohin/nutrition/results.html?search_category%5B%5D=%E3%82%B3%E3%83%BC%E3%83%AB%E3%83%89%E3%82%B9%E3%82%A4%E3%83%BC%E3%83%84',
  metadata_json = coalesce(c.metadata_json, '{}'::jsonb) || jsonb_build_object(
    'seed_type', 'strong_category_seed',
    'source_code', 'ministop_jp',
    'seed_variant', 'nutrition_results',
    'seed_label', 'コールドスイーツ栄養検索結果'
  ),
  updated_at = now()
from ministop_source s
where c.source_id = s.id
  and c.category_code = 'sweets';
