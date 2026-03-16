CREATE TABLE IF NOT EXISTS meal_nutrition_debug_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id UUID REFERENCES weekly_menu_requests(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  daily_meal_id UUID REFERENCES user_daily_meals(id) ON DELETE SET NULL,
  planned_meal_id UUID REFERENCES planned_meals(id) ON DELETE SET NULL,
  target_date DATE NOT NULL,
  meal_type TEXT NOT NULL,
  dish_name TEXT NOT NULL,
  dish_role TEXT,
  source_function TEXT NOT NULL DEFAULT 'generate-menu-v4',
  source_kind TEXT NOT NULL DEFAULT 'ingredient_match',
  input_ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
  normalized_ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
  ingredient_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
  calculated_nutrition JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_nutrition JSONB NOT NULL DEFAULT '{}'::jsonb,
  issue_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_meal_nutrition_debug_logs_created_at
  ON meal_nutrition_debug_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meal_nutrition_debug_logs_request_id
  ON meal_nutrition_debug_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_meal_nutrition_debug_logs_user_id_created_at
  ON meal_nutrition_debug_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meal_nutrition_debug_logs_planned_meal_id
  ON meal_nutrition_debug_logs(planned_meal_id);
CREATE INDEX IF NOT EXISTS idx_meal_nutrition_debug_logs_target_date_meal_type
  ON meal_nutrition_debug_logs(target_date, meal_type);
CREATE INDEX IF NOT EXISTS idx_meal_nutrition_debug_logs_dish_name
  ON meal_nutrition_debug_logs(dish_name);
CREATE INDEX IF NOT EXISTS idx_meal_nutrition_debug_logs_issue_flags
  ON meal_nutrition_debug_logs USING GIN(issue_flags);

ALTER TABLE meal_nutrition_debug_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can do everything on meal_nutrition_debug_logs"
  ON meal_nutrition_debug_logs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view own meal_nutrition_debug_logs"
  ON meal_nutrition_debug_logs
  FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE meal_nutrition_debug_logs IS
  '献立栄養デバッグログ。材料入力、正規化、食材マッチ、参照補正、最終保存値を1皿単位で保存する';
