-- rollback: 20261008110000_planned_meals_value_checks.sql
-- ⚠️ DB 側の検査が外れる: 戻すと #1205 の状態に戻る。planned_meals の calories_kcal / protein_g / fat_g / carbs_g に
--    負の値・NaN・桁外れの値、meal_type に想定外の文字列を、DB が再び受け付ける (モバイルの直接 INSERT や Edge Function の書き込みも止まらなくなる)。
--    API 側の確認 (src/lib/planned-meal-validation.ts) はそのまま残る。緊急時の切り戻し専用。
--
-- 内容: この migration が足したトリガーと関数を外す。データには触れない。
--   trg_planned_meals_validate_values (トリガー) を外してから、validate_planned_meal_values() (関数) を外す。
--   あわせて、この PR の最初の版 (NOT VALID の CHECK 制約 5 本。main にはマージされておらず、本番にも無い) を
--   ローカルなどで当てた DB に残っていた場合に備えて、その 5 本も外す。無ければ何もしない。
--     planned_meals_calories_kcal_range / planned_meals_protein_g_range / planned_meals_fat_g_range /
--     planned_meals_carbs_g_range / planned_meals_meal_type_check
--   (planned_meals_meal_type_check は #221 の名前だが、本番のスナップショットには無い)
-- 冪等: DROP ... IF EXISTS。2 回続けて流してもエラーにならない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS "trg_planned_meals_validate_values" ON "public"."planned_meals";
DROP FUNCTION IF EXISTS "public"."validate_planned_meal_values"();

ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_calories_kcal_range";
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_protein_g_range";
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_fat_g_range";
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_carbs_g_range";
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_meal_type_check";
