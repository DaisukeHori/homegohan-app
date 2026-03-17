insert into public.catalog_sources (
  code,
  brand_name,
  country_code,
  base_url,
  is_active,
  crawl_interval_minutes,
  rate_limit_per_minute,
  metadata_json
)
values
  (
    'seven_eleven_jp',
    'セブン-イレブン',
    'JP',
    'https://www.sej.co.jp',
    true,
    720,
    12,
    jsonb_build_object(
      'strategy', 'catalog_tree',
      'root_url', 'https://www.sej.co.jp/products/',
      'supports_full_nutrition', true
    )
  ),
  (
    'familymart_jp',
    'ファミリーマート',
    'JP',
    'https://www.family.co.jp',
    true,
    720,
    12,
    jsonb_build_object('strategy', 'catalog_tree', 'root_url', 'https://www.family.co.jp/goods.html', 'supports_full_nutrition', true)
  ),
  (
    'lawson_jp',
    'ローソン',
    'JP',
    'https://www.lawson.co.jp',
    true,
    720,
    12,
    jsonb_build_object('strategy', 'catalog_tree', 'root_url', 'https://www.lawson.co.jp/recommend/original/', 'supports_full_nutrition', true)
  ),
  (
    'lawson_store100_jp',
    'ローソンストア100',
    'JP',
    'https://store100.lawson.co.jp',
    true,
    720,
    12,
    jsonb_build_object('strategy', 'partial_nutrition_catalog', 'root_url', 'https://store100.lawson.co.jp/product/', 'supports_full_nutrition', false)
  ),
  (
    'natural_lawson_jp',
    'ナチュラルローソン',
    'JP',
    'https://natural.lawson.co.jp',
    true,
    720,
    12,
    jsonb_build_object('strategy', 'catalog_tree_shared_parent', 'root_url', 'https://natural.lawson.co.jp/recommend/', 'parent_source_code', 'lawson_jp', 'supports_full_nutrition', true)
  ),
  (
    'ministop_jp',
    'ミニストップ',
    'JP',
    'https://www.ministop.co.jp',
    true,
    720,
    12,
    jsonb_build_object('strategy', 'catalog_tree', 'root_url', 'https://www.ministop.co.jp/syohin/', 'supports_full_nutrition', true)
  ),
  (
    'daily_yamazaki_jp',
    'デイリーヤマザキ',
    'JP',
    'https://www.daily-yamazaki.jp',
    true,
    720,
    8,
    jsonb_build_object('strategy', 'partial_nutrition_catalog', 'root_url', 'https://www.daily-yamazaki.jp/new/', 'supports_full_nutrition', false)
  ),
  (
    'seicomart_jp',
    'セイコーマート',
    'JP',
    'https://www.seicomart.co.jp',
    false,
    720,
    8,
    jsonb_build_object('strategy', 'news_feed_catalog', 'root_url', 'https://www.seicomart.co.jp/instore/new.html', 'supports_full_nutrition', false)
  ),
  (
    'sakura_mikura_jp',
    'さくらみくら',
    'JP',
    'https://www.sakura-mikura.jp',
    false,
    720,
    6,
    jsonb_build_object('strategy', 'weak_catalog', 'root_url', 'https://www.sakura-mikura.jp/', 'supports_full_nutrition', false)
  ),
  (
    'poplar_group_jp',
    'ポプラグループ',
    'JP',
    'https://www.poplar-cvs.co.jp',
    false,
    720,
    6,
    jsonb_build_object('strategy', 'weak_catalog', 'root_url', 'https://www.poplar-cvs.co.jp/', 'supports_full_nutrition', false)
  ),
  (
    'cisca_jp',
    'cisca',
    'JP',
    'https://www.cisca.jp',
    false,
    720,
    6,
    jsonb_build_object('strategy', 'weak_catalog', 'root_url', 'https://www.cisca.jp/', 'supports_full_nutrition', false)
  ),
  (
    'newdays_jp',
    'JR東日本クロスステーション / NewDays',
    'JP',
    'https://retail.jr-cross.co.jp',
    true,
    720,
    8,
    jsonb_build_object('strategy', 'partial_nutrition_catalog', 'root_url', 'https://retail.jr-cross.co.jp/newdays/product/', 'supports_full_nutrition', false)
  ),
  (
    'shikoku_kiosk_jp',
    '四国キヨスク',
    'JP',
    'https://www.s-kiosk.jp',
    false,
    720,
    6,
    jsonb_build_object('strategy', 'weak_catalog', 'root_url', 'https://www.s-kiosk.jp/', 'supports_full_nutrition', false)
  ),
  (
    'orebo_jp',
    '大津屋 / オレボ',
    'JP',
    'https://www.orebo.jp',
    false,
    720,
    6,
    jsonb_build_object('strategy', 'news_feed_catalog', 'root_url', 'https://www.orebo.jp/news/', 'supports_full_nutrition', false)
  )
on conflict (code) do update
set
  brand_name = excluded.brand_name,
  base_url = excluded.base_url,
  is_active = excluded.is_active,
  crawl_interval_minutes = excluded.crawl_interval_minutes,
  rate_limit_per_minute = excluded.rate_limit_per_minute,
  metadata_json = excluded.metadata_json,
  updated_at = now();

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
  id,
  'entry',
  'Root Entry',
  metadata_json->>'root_url',
  is_active,
  10,
  jsonb_build_object(
    'seed_type', 'multibrand_root',
    'strategy', metadata_json->>'strategy'
  )
from public.catalog_sources
where code in (
  'seven_eleven_jp',
  'familymart_jp',
  'lawson_jp',
  'lawson_store100_jp',
  'natural_lawson_jp',
  'ministop_jp',
  'daily_yamazaki_jp',
  'seicomart_jp',
  'sakura_mikura_jp',
  'poplar_group_jp',
  'cisca_jp',
  'newdays_jp',
  'shikoku_kiosk_jp',
  'orebo_jp'
)
and metadata_json ? 'root_url'
on conflict (source_id, category_code) do update
set
  category_name = excluded.category_name,
  list_url = excluded.list_url,
  is_active = excluded.is_active,
  crawl_priority = excluded.crawl_priority,
  metadata_json = excluded.metadata_json,
  updated_at = now();
