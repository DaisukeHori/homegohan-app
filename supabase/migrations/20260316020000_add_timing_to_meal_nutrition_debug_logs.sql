ALTER TABLE meal_nutrition_debug_logs
  ADD COLUMN IF NOT EXISTS dish_timing_ms JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS slot_timing_ms JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN meal_nutrition_debug_logs.dish_timing_ms IS
  '1皿単位の計測時間。食材マッチ、参照検証、料理JSON組み立てなどの詳細ms';

COMMENT ON COLUMN meal_nutrition_debug_logs.slot_timing_ms IS
  '1食単位の計測時間。daily_meal upsert、planned_meal write、debug log insert などの詳細ms';
