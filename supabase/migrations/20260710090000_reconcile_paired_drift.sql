-- reconcile: 台帳上 applied 扱いだが本番に実在しない DDL の再適用 (全て冪等)

-- ※このファイルは db push で本番に実行される



-- ============================================================
-- recipe like RPCs (source: 20260430140000)
-- ============================================================


CREATE OR REPLACE FUNCTION increment_recipe_like_count(p_recipe_id TEXT DEFAULT NULL, p_recipe_uuid UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_recipe_uuid IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_uuid = p_recipe_uuid;
    UPDATE recipes SET like_count = v_count WHERE id = p_recipe_uuid;
  ELSIF p_recipe_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_id = p_recipe_id;
  ELSE
    RAISE EXCEPTION 'Either p_recipe_id or p_recipe_uuid must be provided';
  END IF;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION decrement_recipe_like_count(p_recipe_id TEXT DEFAULT NULL, p_recipe_uuid UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_recipe_uuid IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_uuid = p_recipe_uuid;
    UPDATE recipes SET like_count = v_count WHERE id = p_recipe_uuid;
  ELSIF p_recipe_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_id = p_recipe_id;
  ELSE
    RAISE EXCEPTION 'Either p_recipe_id or p_recipe_uuid must be provided';
  END IF;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION sync_recipe_like_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_recipe_uuid UUID;
  v_count INTEGER;
BEGIN
  -- INSERT または DELETE のターゲット行から recipe_uuid を取得
  IF TG_OP = 'DELETE' THEN
    v_recipe_uuid := OLD.recipe_uuid;
  ELSE
    v_recipe_uuid := NEW.recipe_uuid;
  END IF;

  -- recipe_uuid が null の場合（TEXT-only 旧行）はスキップ
  IF v_recipe_uuid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- atomic カウント更新
  SELECT COUNT(*) INTO v_count
  FROM recipe_likes
  WHERE recipe_uuid = v_recipe_uuid;

  UPDATE recipes
  SET like_count = v_count
  WHERE id = v_recipe_uuid;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_recipe_like_count ON recipe_likes;

CREATE TRIGGER trg_sync_recipe_like_count
AFTER INSERT OR DELETE ON recipe_likes
FOR EACH ROW EXECUTE FUNCTION sync_recipe_like_count();

-- ============================================================
-- upsert_daily_meal_slot (source: 20260430145000)
-- ============================================================


CREATE OR REPLACE FUNCTION public.upsert_daily_meal_slot(
  p_user_id        UUID,
  p_day_date       DATE,
  p_meal_type      TEXT,
  p_planned_data   JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_daily_meal_id  UUID;
  v_planned_meal_id UUID;
  v_existing_id    UUID;
BEGIN
  -- 1. user_daily_meals を upsert
  INSERT INTO user_daily_meals (user_id, day_date, updated_at)
  VALUES (p_user_id, p_day_date, NOW())
  ON CONFLICT (user_id, day_date)
  DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_daily_meal_id;

  -- 2. 既存 planned_meal を確認
  SELECT id INTO v_existing_id
  FROM planned_meals
  WHERE daily_meal_id = v_daily_meal_id
    AND meal_type = p_meal_type
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- 既存レコードを更新
    UPDATE planned_meals
    SET
      dish_name        = p_planned_data->>'dish_name',
      ingredients      = (p_planned_data->'ingredients'),
      recipe_steps     = (p_planned_data->'recipe_steps'),
      dishes           = (p_planned_data->'dishes'),
      mode             = COALESCE(p_planned_data->>'mode', 'ai_creative'),
      is_simple        = COALESCE((p_planned_data->>'is_simple')::BOOLEAN, FALSE),
      display_order    = COALESCE((p_planned_data->>'display_order')::INT, 0),
      is_generating    = FALSE,
      calories_kcal    = (p_planned_data->>'calories_kcal')::NUMERIC,
      protein_g        = (p_planned_data->>'protein_g')::NUMERIC,
      fat_g            = (p_planned_data->>'fat_g')::NUMERIC,
      carbs_g          = (p_planned_data->>'carbs_g')::NUMERIC,
      sodium_g         = (p_planned_data->>'sodium_g')::NUMERIC,
      fiber_g          = (p_planned_data->>'fiber_g')::NUMERIC,
      image_url        = p_planned_data->>'image_url',
      updated_at       = NOW()
    WHERE id = v_existing_id
    RETURNING id INTO v_planned_meal_id;
  ELSE
    -- 新規挿入
    INSERT INTO planned_meals (
      daily_meal_id, meal_type, dish_name, ingredients, recipe_steps, dishes,
      mode, is_simple, display_order, is_generating, is_completed,
      calories_kcal, protein_g, fat_g, carbs_g, sodium_g, fiber_g,
      image_url, updated_at
    ) VALUES (
      v_daily_meal_id,
      p_meal_type,
      p_planned_data->>'dish_name',
      (p_planned_data->'ingredients'),
      (p_planned_data->'recipe_steps'),
      (p_planned_data->'dishes'),
      COALESCE(p_planned_data->>'mode', 'ai_creative'),
      COALESCE((p_planned_data->>'is_simple')::BOOLEAN, FALSE),
      COALESCE((p_planned_data->>'display_order')::INT, 0),
      FALSE,
      FALSE,
      (p_planned_data->>'calories_kcal')::NUMERIC,
      (p_planned_data->>'protein_g')::NUMERIC,
      (p_planned_data->>'fat_g')::NUMERIC,
      (p_planned_data->>'carbs_g')::NUMERIC,
      (p_planned_data->>'sodium_g')::NUMERIC,
      (p_planned_data->>'fiber_g')::NUMERIC,
      p_planned_data->>'image_url',
      NOW()
    )
    RETURNING id INTO v_planned_meal_id;
  END IF;

  RETURN jsonb_build_object(
    'daily_meal_id',  v_daily_meal_id,
    'planned_meal_id', v_planned_meal_id,
    'outcome',        CASE WHEN v_existing_id IS NOT NULL THEN 'updated' ELSE 'inserted' END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_daily_meal_slot(UUID, DATE, TEXT, JSONB) TO service_role;

-- ============================================================
-- increment_recipe_view_count (source: 20260430180000)
-- ============================================================


CREATE OR REPLACE FUNCTION increment_recipe_view_count(recipe_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE recipes
  SET view_count = COALESCE(view_count, 0) + 1
  WHERE id = recipe_id;
$$;

-- ============================================================
-- health_* updated_at trigger fns + triggers (source: 20260508190000)
-- ============================================================


CREATE OR REPLACE FUNCTION update_health_records_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_health_streaks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_health_goals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_health_records_updated_at ON health_records;
CREATE TRIGGER trigger_health_records_updated_at
  BEFORE UPDATE ON health_records
  FOR EACH ROW EXECUTE FUNCTION update_health_records_updated_at();

DROP TRIGGER IF EXISTS trigger_health_streaks_updated_at ON health_streaks;
CREATE TRIGGER trigger_health_streaks_updated_at
  BEFORE UPDATE ON health_streaks
  FOR EACH ROW EXECUTE FUNCTION update_health_streaks_updated_at();

DROP TRIGGER IF EXISTS trigger_health_goals_updated_at ON health_goals;
CREATE TRIGGER trigger_health_goals_updated_at
  BEFORE UPDATE ON health_goals
  FOR EACH ROW EXECUTE FUNCTION update_health_goals_updated_at();

-- ============================================================
-- updated_at triggers on existing tables (source: 20260430160000; meal_plans/meal_plan_days は除外=本番に無い)
-- ============================================================


DROP TRIGGER IF EXISTS trg_planned_meals_updated_at ON planned_meals;
CREATE TRIGGER trg_planned_meals_updated_at
  BEFORE UPDATE ON planned_meals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_shopping_list_items_updated_at ON shopping_list_items;
CREATE TRIGGER trg_shopping_list_items_updated_at
  BEFORE UPDATE ON shopping_list_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_pantry_items_updated_at ON pantry_items;
CREATE TRIGGER trg_pantry_items_updated_at
  BEFORE UPDATE ON pantry_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_recipes_updated_at ON recipes;
CREATE TRIGGER trg_recipes_updated_at
  BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_sport_presets_updated_at ON sport_presets;
CREATE TRIGGER trg_sport_presets_updated_at
  BEFORE UPDATE ON sport_presets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- missing indexes (columns verified in prod dump)
-- ============================================================


CREATE INDEX IF NOT EXISTS llm_usage_logs_user_id_created_at_idx ON llm_usage_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_logs_model_created_at_idx ON llm_usage_logs (model, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_logs_created_at_idx ON llm_usage_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_logs_function_name_created_at_idx ON llm_usage_logs (function_name, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_logs_execution_id_idx ON llm_usage_logs (execution_id);
CREATE INDEX IF NOT EXISTS idx_health_streaks_user_type ON health_streaks (user_id, streak_type);
CREATE INDEX IF NOT EXISTS idx_health_goals_user_status ON health_goals (user_id, status);
CREATE INDEX IF NOT EXISTS idx_health_goals_user_type ON health_goals (user_id, goal_type);
CREATE INDEX IF NOT EXISTS idx_recipes_difficulty ON recipes (difficulty);
CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id ON user_push_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_menu_requests_exceeded_attempts
  ON weekly_menu_requests (updated_at)
  WHERE status = 'queued' AND attempt_count >= 3;

-- ============================================================
-- user_push_tokens: repo 定義との整合 (source: 20260430170000)
-- ============================================================


ALTER TABLE user_push_tokens ADD COLUMN IF NOT EXISTS device_name text;
ALTER TABLE user_push_tokens ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
DROP POLICY IF EXISTS "user can manage own" ON user_push_tokens;
CREATE POLICY "user can manage own" ON user_push_tokens
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "service_role can read" ON user_push_tokens;
CREATE POLICY "service_role can read" ON user_push_tokens
  FOR SELECT USING (auth.role() = 'service_role');

-- ============================================================
-- missing policies (source: 20260508180000 / 20260508190000 / 20260430160000)
-- ============================================================


DROP POLICY IF EXISTS "llm_usage_logs_select_super_admin" ON llm_usage_logs;
CREATE POLICY "llm_usage_logs_select_super_admin" ON llm_usage_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND 'super_admin' = ANY(roles))
  );
DROP POLICY IF EXISTS "llm_usage_logs_select_own" ON llm_usage_logs;
CREATE POLICY "llm_usage_logs_select_own" ON llm_usage_logs
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can delete own health streaks" ON health_streaks;
CREATE POLICY "Users can delete own health streaks" ON health_streaks
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "service_role can manage dataset_import_runs" ON dataset_import_runs;
CREATE POLICY "service_role can manage dataset_import_runs" ON dataset_import_runs
  FOR ALL USING (auth.role() = 'service_role');
DROP POLICY IF EXISTS "user can read own derived_recipes" ON derived_recipes;
CREATE POLICY "user can read own derived_recipes" ON derived_recipes
  FOR SELECT USING (auth.uid() = created_by_user_id);
DROP POLICY IF EXISTS "service_role can write derived_recipes" ON derived_recipes;
CREATE POLICY "service_role can write derived_recipes" ON derived_recipes
  FOR INSERT WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS "service_role can manage meal_image_jobs" ON meal_image_jobs;
CREATE POLICY "service_role can manage meal_image_jobs" ON meal_image_jobs
  FOR ALL USING (auth.role() = 'service_role');
DROP POLICY IF EXISTS "user can delete own meal_image_jobs" ON meal_image_jobs;
CREATE POLICY "user can delete own meal_image_jobs" ON meal_image_jobs
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- fridge_snapshots: 本番では out-of-band で削除済み → repo 側も追随 (本番では no-op)
-- ============================================================


DROP TABLE IF EXISTS fridge_snapshots CASCADE;
