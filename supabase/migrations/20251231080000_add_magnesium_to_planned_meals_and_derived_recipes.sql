-- ============================================================
-- Add magnesium_mg to planned_meals / derived_recipes
--
-- Background:
-- - dataset_menu_sets has magnesium_mg populated (micronutrient detail exists in dataset)
-- - planned_meals lacked magnesium_mg, so v2 could not persist it
-- - derived_recipes also benefits from magnesium_mg (computed from dataset_ingredients)
-- ============================================================

alter table public.planned_meals
  add column if not exists magnesium_mg numeric;

alter table public.derived_recipes
  add column if not exists magnesium_mg numeric;

-- Backfill: for existing dataset-generated planned_meals, copy magnesium from dataset_menu_sets
update public.planned_meals pm
set magnesium_mg = dms.magnesium_mg
from public.dataset_menu_sets dms
where pm.magnesium_mg is null
  and pm.source_type = 'dataset'
  and pm.source_menu_set_external_id is not null
  and dms.external_id = pm.source_menu_set_external_id;


