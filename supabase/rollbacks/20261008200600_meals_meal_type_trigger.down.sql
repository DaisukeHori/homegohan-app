-- rollback: 20261008200600_meals_meal_type_trigger.sql
-- ⚠️ DB 側の検査が外れる: 戻すと、meals.meal_type にどんな文字列でも DB が再び受け付ける
--    (この migration の前の状態。ログインした本人が PostgREST から直接書く場合も止まらない)。
--    planned_meals の検査 (20261008110000 の trg_planned_meals_validate_values) はそのまま残る。緊急時の切り戻し専用。
--
-- 内容: この migration が足したトリガーと関数を外す。データには触れない。
--   trg_meals_validate_meal_type (トリガー) を外してから、validate_meals_meal_type() (関数) を外す。
-- 冪等: DROP ... IF EXISTS。2 回続けて流してもエラーにならない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS "trg_meals_validate_meal_type" ON "public"."meals";
DROP FUNCTION IF EXISTS "public"."validate_meals_meal_type"();
