-- ============================================================
-- Auto-fill magnesium_mg
--
-- Why:
-- - Ensure magnesium_mg is persisted even if application code forgets to set it.
-- - planned_meals: copy from dataset_menu_sets when source_type='dataset'
-- - derived_recipes: compute from ingredients[].matched_ingredient_id + amount_g using dataset_ingredients
-- ============================================================

-- ------------------------------------------------------------
-- planned_meals.magnesium_mg (dataset copy)
-- ------------------------------------------------------------
create or replace function public.fill_planned_meals_magnesium_mg()
returns trigger
language plpgsql
as $$
begin
  if new.magnesium_mg is null
     and new.source_type = 'dataset'
     and new.source_menu_set_external_id is not null then
    select dms.magnesium_mg
      into new.magnesium_mg
    from public.dataset_menu_sets dms
    where dms.external_id = new.source_menu_set_external_id
    limit 1;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_fill_planned_meals_magnesium_mg on public.planned_meals;
create trigger trg_fill_planned_meals_magnesium_mg
before insert or update
on public.planned_meals
for each row
execute function public.fill_planned_meals_magnesium_mg();

-- ------------------------------------------------------------
-- derived_recipes.magnesium_mg (ingredient sum)
-- ------------------------------------------------------------
create or replace function public.fill_derived_recipes_magnesium_mg()
returns trigger
language plpgsql
as $$
declare
  elem jsonb;
  ing_id uuid;
  amount_g numeric;
  mg_per_100g numeric;
  total numeric := 0;
begin
  if new.magnesium_mg is not null then
    return new;
  end if;

  if new.ingredients is null then
    return new;
  end if;

  for elem in
    select * from jsonb_array_elements(new.ingredients)
  loop
    ing_id := (elem->>'matched_ingredient_id')::uuid;
    amount_g := (elem->>'amount_g')::numeric;

    if ing_id is null or amount_g is null then
      continue;
    end if;

    select i.magnesium_mg
      into mg_per_100g
    from public.dataset_ingredients i
    where i.id = ing_id;

    if mg_per_100g is null then
      continue;
    end if;

    total := total + mg_per_100g * (amount_g / 100.0);
  end loop;

  new.magnesium_mg := total;
  return new;
end;
$$;

drop trigger if exists trg_fill_derived_recipes_magnesium_mg on public.derived_recipes;
create trigger trg_fill_derived_recipes_magnesium_mg
before insert or update
on public.derived_recipes
for each row
execute function public.fill_derived_recipes_magnesium_mg();

-- Backfill existing derived_recipes rows (will invoke trigger and compute)
update public.derived_recipes
set magnesium_mg = null
where magnesium_mg is null;


