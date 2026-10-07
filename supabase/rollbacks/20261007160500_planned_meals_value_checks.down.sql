-- rollback: 20261007160500_planned_meals_value_checks.sql
-- ⚠️ 制約が外れる: 戻すと #1205 の状態に戻る。planned_meals の calories_kcal / protein_g / fat_g / carbs_g に負の値・NaN・桁外れの値、
--    meal_type に想定外の文字列を、DB が再び受け付ける (モバイルの直接 INSERT や Edge Function の書き込みも止まらなくなる)。
--    緊急時の切り戻し専用 (例: 想定外の既存データで、is_completed の切り替えなどの UPDATE が check_violation になる場合)。
--
-- 内容: この migration が追加した 5 本の CHECK 制約を外す。制約を外すだけで、データには触れない。
--   planned_meals_calories_kcal_range / planned_meals_protein_g_range / planned_meals_fat_g_range /
--   planned_meals_carbs_g_range / planned_meals_meal_type_check
--   (本番にはもともとどれも存在しなかった。planned_meals_meal_type_check は #221 の名前だが、本番のスナップショットには無い)
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SET LOCAL lock_timeout = '10s';

ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_calories_kcal_range";
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_protein_g_range";
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_fat_g_range";
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_carbs_g_range";
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_meal_type_check";
