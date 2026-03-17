with source_category_seed as (
  select *
  from (
    values
      ('familymart_jp', 'onigiri', 'おむすび', 'https://www.family.co.jp/goods/omusubi.html', 10),
      ('familymart_jp', 'bento', '弁当', 'https://www.family.co.jp/goods/obento.html', 20),
      ('familymart_jp', 'sandwich', 'サンドイッチ', 'https://www.family.co.jp/goods/sandwich.html', 30),
      ('familymart_jp', 'men', '麺類', 'https://www.family.co.jp/goods/noodle.html', 40),
      ('lawson_jp', 'onigiri', 'おにぎり', 'https://www.lawson.co.jp/recommend/original/rice/', 10),
      ('lawson_jp', 'bento', '弁当', 'https://www.lawson.co.jp/recommend/original/bento/', 20),
      ('lawson_jp', 'sandwich', 'サンドイッチ', 'https://www.lawson.co.jp/recommend/original/sandwich/', 30),
      ('lawson_jp', 'men', '麺類', 'https://www.lawson.co.jp/recommend/original/noodle/', 40),
      ('natural_lawson_jp', 'commodity', '商品一覧', 'https://natural.lawson.co.jp/recommend/commodity/index.html', 10),
      ('natural_lawson_jp', 'new', '新商品', 'https://natural.lawson.co.jp/recommend/new/index.html', 20),
      ('ministop_jp', 'onigiri', 'おにぎり', 'https://www.ministop.co.jp/syohin/itsumonoonigiri/', 10),
      ('ministop_jp', 'bento', '弁当', 'https://www.ministop.co.jp/syohin/obento/', 20),
      ('ministop_jp', 'men', '麺類', 'https://www.ministop.co.jp/syohin/noodles/', 30),
      ('ministop_jp', 'sweets', 'スイーツ', 'https://www.ministop.co.jp/syohin/sweets/', 40)
  ) as t(source_code, category_code, category_name, list_url, crawl_priority)
)
insert into public.catalog_source_categories (
  source_id,
  category_code,
  category_name,
  list_url,
  is_active,
  crawl_priority,
  metadata_json
)
select
  s.id,
  seed.category_code,
  seed.category_name,
  seed.list_url,
  true,
  seed.crawl_priority,
  jsonb_build_object(
    'seed_type', 'strong_category_seed',
    'source_code', seed.source_code
  )
from source_category_seed seed
join public.catalog_sources s
  on s.code = seed.source_code
on conflict (source_id, category_code) do update
set
  category_name = excluded.category_name,
  list_url = excluded.list_url,
  is_active = excluded.is_active,
  crawl_priority = excluded.crawl_priority,
  metadata_json = excluded.metadata_json,
  updated_at = now();
