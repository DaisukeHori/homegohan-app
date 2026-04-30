-- ============================================================
-- DB Audit Fix: Wave 2 / F16
-- Issues: #212 #214 #217 #218 #219 #220 #221 #222 #224
-- ============================================================

-- ============================================================
-- #218: core テーブル 8 件を migration に登録
--   (docs/schema.sql の DDL を CREATE TABLE IF NOT EXISTS で転記)
--   既に Supabase 上に存在する場合はスキップされる
-- ============================================================

-- ユーザープロファイル
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  age_group TEXT NOT NULL,
  gender TEXT NOT NULL,
  goal_text TEXT,
  perf_modes TEXT[],
  lifestyle JSONB,
  diet_flags JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 食事記録
CREATE TABLE IF NOT EXISTS meals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  eaten_at TIMESTAMPTZ NOT NULL,
  meal_type TEXT NOT NULL,
  photo_url TEXT,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 食事栄養推定
CREATE TABLE IF NOT EXISTS meal_nutrition_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id UUID NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  energy_kcal NUMERIC,
  protein_g NUMERIC,
  fat_g NUMERIC,
  carbs_g NUMERIC,
  veg_score INTEGER,
  quality_tags TEXT[],
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI フィードバック
CREATE TABLE IF NOT EXISTS meal_ai_feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id UUID NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  feedback_text TEXT NOT NULL,
  advice_text TEXT,
  model_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- レシピリクエスト
CREATE TABLE IF NOT EXISTS recipe_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  base_meal_id UUID REFERENCES meals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  prompt TEXT,
  result_text TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 週間献立リクエスト
CREATE TABLE IF NOT EXISTS weekly_menu_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  prompt TEXT,
  result_json JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- バッジ定義
CREATE TABLE IF NOT EXISTS badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  condition_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ユーザーバッジ
CREATE TABLE IF NOT EXISTS user_badges (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_id UUID NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  obtained_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, badge_id)
);

-- インデックス（IF NOT EXISTS で安全に）
CREATE INDEX IF NOT EXISTS idx_meals_user_id ON meals(user_id);
CREATE INDEX IF NOT EXISTS idx_meals_eaten_at ON meals(eaten_at);
CREATE INDEX IF NOT EXISTS idx_meal_nutrition_estimates_meal_id ON meal_nutrition_estimates(meal_id);
CREATE INDEX IF NOT EXISTS idx_meal_ai_feedbacks_meal_id ON meal_ai_feedbacks(meal_id);
CREATE INDEX IF NOT EXISTS idx_recipe_requests_user_id ON recipe_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_recipe_requests_status ON recipe_requests(status);
CREATE INDEX IF NOT EXISTS idx_weekly_menu_requests_user_id ON weekly_menu_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_menu_requests_status ON weekly_menu_requests(status);
CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges(user_id);

-- RLS 有効化
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_nutrition_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_ai_feedbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_menu_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;

-- user_profiles ポリシー（既存なら skip）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_profiles' AND policyname = 'Users can view own profile'
  ) THEN
    CREATE POLICY "Users can view own profile" ON user_profiles
      FOR SELECT USING (auth.uid() = id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_profiles' AND policyname = 'Users can update own profile'
  ) THEN
    CREATE POLICY "Users can update own profile" ON user_profiles
      FOR UPDATE USING (auth.uid() = id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_profiles' AND policyname = 'Users can insert own profile'
  ) THEN
    CREATE POLICY "Users can insert own profile" ON user_profiles
      FOR INSERT WITH CHECK (auth.uid() = id);
  END IF;
END $$;

-- meals ポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'meals' AND policyname = 'Users can view own meals'
  ) THEN
    CREATE POLICY "Users can view own meals" ON meals
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'meals' AND policyname = 'Users can insert own meals'
  ) THEN
    CREATE POLICY "Users can insert own meals" ON meals
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'meals' AND policyname = 'Users can update own meals'
  ) THEN
    CREATE POLICY "Users can update own meals" ON meals
      FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'meals' AND policyname = 'Users can delete own meals'
  ) THEN
    CREATE POLICY "Users can delete own meals" ON meals
      FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- meal_nutrition_estimates ポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'meal_nutrition_estimates' AND policyname = 'Users can view own nutrition estimates'
  ) THEN
    CREATE POLICY "Users can view own nutrition estimates" ON meal_nutrition_estimates
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM meals
          WHERE meals.id = meal_nutrition_estimates.meal_id
            AND meals.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- meal_ai_feedbacks ポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'meal_ai_feedbacks' AND policyname = 'Users can view own feedbacks'
  ) THEN
    CREATE POLICY "Users can view own feedbacks" ON meal_ai_feedbacks
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM meals
          WHERE meals.id = meal_ai_feedbacks.meal_id
            AND meals.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- recipe_requests ポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'recipe_requests' AND policyname = 'Users can manage own recipe requests'
  ) THEN
    CREATE POLICY "Users can manage own recipe requests" ON recipe_requests
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

-- weekly_menu_requests ポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'weekly_menu_requests' AND policyname = 'Users can manage own weekly menu requests'
  ) THEN
    CREATE POLICY "Users can manage own weekly menu requests" ON weekly_menu_requests
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

-- badges ポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'badges' AND policyname = 'Anyone can view badges'
  ) THEN
    CREATE POLICY "Anyone can view badges" ON badges
      FOR SELECT USING (true);
  END IF;
END $$;

-- user_badges ポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_badges' AND policyname = 'Users can view own badges'
  ) THEN
    CREATE POLICY "Users can view own badges" ON user_badges
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================
-- #212: dataset_import_runs RLS ポリシー未定義
--   ETL 専用テーブル。ユーザー READ 不要。service_role のみ管理。
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'dataset_import_runs' AND policyname = 'service_role can manage dataset_import_runs'
  ) THEN
    CREATE POLICY "service_role can manage dataset_import_runs" ON dataset_import_runs
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ============================================================
-- #214: derived_recipes ユーザー向け READ ポリシー未定義
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'derived_recipes' AND policyname = 'user can read own derived_recipes'
  ) THEN
    CREATE POLICY "user can read own derived_recipes" ON derived_recipes
      FOR SELECT
      USING (auth.uid() = created_by_user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'derived_recipes' AND policyname = 'service_role can write derived_recipes'
  ) THEN
    CREATE POLICY "service_role can write derived_recipes" ON derived_recipes
      FOR INSERT
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ============================================================
-- #217: meal_image_jobs FK 無し + service_role bypass + DELETE ポリシー欠如
-- ============================================================

-- user_id に FK を追加（既に存在する場合はスキップ）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'meal_image_jobs_user_id_fkey'
      AND table_name = 'meal_image_jobs'
  ) THEN
    ALTER TABLE meal_image_jobs
      ADD CONSTRAINT meal_image_jobs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- service_role が全操作できるポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'meal_image_jobs' AND policyname = 'service_role can manage meal_image_jobs'
  ) THEN
    CREATE POLICY "service_role can manage meal_image_jobs" ON meal_image_jobs
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ユーザーが自分のジョブを DELETE できるポリシー
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'meal_image_jobs' AND policyname = 'user can delete own meal_image_jobs'
  ) THEN
    CREATE POLICY "user can delete own meal_image_jobs" ON meal_image_jobs
      FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================
-- #219: sport_presets RLS 未設定
-- ============================================================

ALTER TABLE sport_presets ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'sport_presets' AND policyname = 'all can read sport_presets'
  ) THEN
    CREATE POLICY "all can read sport_presets" ON sport_presets
      FOR SELECT
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'sport_presets' AND policyname = 'service_role can write sport_presets'
  ) THEN
    CREATE POLICY "service_role can write sport_presets" ON sport_presets
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ============================================================
-- #220: updated_at trigger 未設定 (7 テーブル)
--   meal_plans / meal_plan_days / planned_meals / shopping_list_items
--   pantry_items / recipes / sport_presets
-- ============================================================

-- update_updated_at_column() 関数（既存の場合は上書き）
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- meal_plans
DROP TRIGGER IF EXISTS trg_meal_plans_updated_at ON meal_plans;
CREATE TRIGGER trg_meal_plans_updated_at
  BEFORE UPDATE ON meal_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- meal_plan_days
DROP TRIGGER IF EXISTS trg_meal_plan_days_updated_at ON meal_plan_days;
CREATE TRIGGER trg_meal_plan_days_updated_at
  BEFORE UPDATE ON meal_plan_days
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- planned_meals
DROP TRIGGER IF EXISTS trg_planned_meals_updated_at ON planned_meals;
CREATE TRIGGER trg_planned_meals_updated_at
  BEFORE UPDATE ON planned_meals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- shopping_list_items
DROP TRIGGER IF EXISTS trg_shopping_list_items_updated_at ON shopping_list_items;
CREATE TRIGGER trg_shopping_list_items_updated_at
  BEFORE UPDATE ON shopping_list_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- pantry_items
DROP TRIGGER IF EXISTS trg_pantry_items_updated_at ON pantry_items;
CREATE TRIGGER trg_pantry_items_updated_at
  BEFORE UPDATE ON pantry_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- recipes
DROP TRIGGER IF EXISTS trg_recipes_updated_at ON recipes;
CREATE TRIGGER trg_recipes_updated_at
  BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- sport_presets
DROP TRIGGER IF EXISTS trg_sport_presets_updated_at ON sport_presets;
CREATE TRIGGER trg_sport_presets_updated_at
  BEFORE UPDATE ON sport_presets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- #221: meal_type 等 CHECK 制約なし (6 テーブル)
--   planned_meals.meal_type / meals.meal_type
--   recipe_requests.status / weekly_menu_requests.status
--   meal_plans.status / pantry_items.category
-- ============================================================

-- planned_meals.meal_type
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'planned_meals_meal_type_check'
      AND table_name = 'planned_meals'
  ) THEN
    ALTER TABLE planned_meals
      ADD CONSTRAINT planned_meals_meal_type_check
      CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack'));
  END IF;
END $$;

-- meals.meal_type
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'meals_meal_type_check'
      AND table_name = 'meals'
  ) THEN
    ALTER TABLE meals
      ADD CONSTRAINT meals_meal_type_check
      CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack'));
  END IF;
END $$;

-- recipe_requests.status
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'recipe_requests_status_check'
      AND table_name = 'recipe_requests'
  ) THEN
    ALTER TABLE recipe_requests
      ADD CONSTRAINT recipe_requests_status_check
      CHECK (status IN ('pending', 'processing', 'completed', 'failed'));
  END IF;
END $$;

-- weekly_menu_requests.status
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'weekly_menu_requests_status_check'
      AND table_name = 'weekly_menu_requests'
  ) THEN
    ALTER TABLE weekly_menu_requests
      ADD CONSTRAINT weekly_menu_requests_status_check
      CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'failed'));
  END IF;
END $$;

-- meal_plans.status
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'meal_plans_status_check'
      AND table_name = 'meal_plans'
  ) THEN
    ALTER TABLE meal_plans
      ADD CONSTRAINT meal_plans_status_check
      CHECK (status IN ('draft', 'active', 'completed', 'archived'));
  END IF;
END $$;

-- pantry_items.category
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'pantry_items_category_check'
      AND table_name = 'pantry_items'
  ) THEN
    ALTER TABLE pantry_items
      ADD CONSTRAINT pantry_items_category_check
      CHECK (category IN ('meat', 'vegetable', 'fish', 'dairy', 'other'));
  END IF;
END $$;

-- ============================================================
-- #222: fridge_snapshots UPDATE ポリシー未定義
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'fridge_snapshots' AND policyname = 'Users can update own fridge snapshots'
  ) THEN
    CREATE POLICY "Users can update own fridge snapshots" ON fridge_snapshots
      FOR UPDATE
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================
-- #224: recipes FOR ALL に WITH CHECK なし
--   既存の "Users can manage own recipes" (FOR ALL, USING のみ) を
--   WITH CHECK 付きに差し替える
-- ============================================================

DROP POLICY IF EXISTS "Users can manage own recipes" ON recipes;

CREATE POLICY "Users can manage own recipes" ON recipes
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
