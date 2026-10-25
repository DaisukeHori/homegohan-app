-- rollback: 20261026010000_planned_meals_score_columns_server_only.sql
-- #2025 (2/2) で外した planned_meals の利用者の INSERT / UPDATE の権限を元に戻す。
-- 列ごとの権限 (authenticated の 56 列) を外し、表ごとの INSERT / UPDATE を anon と authenticated に付け直す
-- (本番のベースライン 20251126124224_create_meal_planner_tables.sql:13798-13799 の形。SELECT・DELETE・REFERENCES・TRIGGER・
-- MAINTAIN は本冊が触れていないので付け直さない)。
-- TRUNCATE は付け直さない: 本冊の適用の直前の時点で、20261022190000_db_privilege_hardening.sql が anon / authenticated から
-- 外してある (本冊は TRUNCATE に触れていない)。
-- (tests/planned-meals-score-integrity-migration-contract.test.ts が、流した後の状態が本冊の直前の状態と同じことを見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、利用者が PostgREST から自分の行の veg_score / is_completed / completed_at を直接書けるようになり、
--     比較ランキングと組織のチャレンジの指標に任意の値を入れられる穴が再び開く。
--   - アプリ (完了は RPC、野菜スコアは service_role で書く) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: REVOKE / GRANT は何度流しても同じ)。

SET LOCAL lock_timeout = '10s';

REVOKE INSERT (
  id, meal_type, dish_name, recipe_url, image_url, description, ingredients,
  calories_kcal, protein_g, fat_g, carbs_g, actual_meal_id, created_at, updated_at,
  mode, dishes, is_simple, cooking_time_minutes, memo, quality_tags, display_order,
  sodium_g, sugar_g, fiber_g, fiber_soluble_g, fiber_insoluble_g, potassium_mg, calcium_mg,
  phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg,
  vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug,
  vitamin_k_ug, vitamin_e_mg, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g,
  amino_acid_g, recipe_steps, is_generating, source_type, source_dataset_version,
  source_menu_set_external_id, generation_metadata, magnesium_mg, daily_meal_id, catalog_product_id
), UPDATE (
  id, meal_type, dish_name, recipe_url, image_url, description, ingredients,
  calories_kcal, protein_g, fat_g, carbs_g, actual_meal_id, created_at, updated_at,
  mode, dishes, is_simple, cooking_time_minutes, memo, quality_tags, display_order,
  sodium_g, sugar_g, fiber_g, fiber_soluble_g, fiber_insoluble_g, potassium_mg, calcium_mg,
  phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg,
  vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug,
  vitamin_k_ug, vitamin_e_mg, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g,
  amino_acid_g, recipe_steps, is_generating, source_type, source_dataset_version,
  source_menu_set_external_id, generation_metadata, magnesium_mg, daily_meal_id, catalog_product_id
) ON TABLE public.planned_meals FROM authenticated;

GRANT INSERT, UPDATE ON TABLE public.planned_meals TO anon, authenticated;
