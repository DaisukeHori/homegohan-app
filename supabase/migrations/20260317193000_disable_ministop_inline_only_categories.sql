with ministop_source as (
  select id
  from public.catalog_sources
  where code = 'ministop_jp'
)
update public.catalog_source_categories c
set
  is_active = false,
  metadata_json = coalesce(c.metadata_json, '{}'::jsonb) || jsonb_build_object(
    'disabled_reason', 'inline_catalog_without_public_nutrition_source',
    'disabled_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
  ),
  updated_at = now()
from ministop_source s
where c.source_id = s.id
  and c.category_code in ('onigiri', 'bento');
