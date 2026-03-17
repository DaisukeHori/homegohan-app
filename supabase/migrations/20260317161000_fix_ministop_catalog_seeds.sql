with ministop_source as (
  select id
  from public.catalog_sources
  where code = 'ministop_jp'
)
update public.catalog_source_categories c
set
  list_url = case c.category_code
    when 'onigiri' then 'https://www.ministop.co.jp/syohin/tennai-tezukuri/'
    when 'bento' then 'https://www.ministop.co.jp/syohin/tennai-tezukuri/'
    else c.list_url
  end,
  metadata_json = coalesce(c.metadata_json, '{}'::jsonb) || jsonb_build_object(
    'seed_type', 'strong_category_seed',
    'source_code', 'ministop_jp',
    'legacy_category_blocked', c.category_code in ('onigiri', 'bento'),
    'fallback_seed_url', 'https://www.ministop.co.jp/syohin/tennai-tezukuri/',
    'requires_inline_catalog_parser', c.category_code in ('onigiri', 'bento')
  ),
  updated_at = now()
from ministop_source s
where c.source_id = s.id
  and c.category_code in ('onigiri', 'bento');
