-- ほめごはん データベーススキーマ
-- Supabase (PostgreSQL) 用

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

-- AIフィードバック
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

-- モデレーションフラグ
CREATE TABLE IF NOT EXISTS moderation_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id UUID REFERENCES meals(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_meals_user_id ON meals(user_id);
CREATE INDEX IF NOT EXISTS idx_meals_eaten_at ON meals(eaten_at);
CREATE INDEX IF NOT EXISTS idx_meal_nutrition_estimates_meal_id ON meal_nutrition_estimates(meal_id);
CREATE INDEX IF NOT EXISTS idx_meal_ai_feedbacks_meal_id ON meal_ai_feedbacks(meal_id);
CREATE INDEX IF NOT EXISTS idx_recipe_requests_user_id ON recipe_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_recipe_requests_status ON recipe_requests(status);
CREATE INDEX IF NOT EXISTS idx_weekly_menu_requests_user_id ON weekly_menu_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_menu_requests_status ON weekly_menu_requests(status);
CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_moderation_flags_meal_id ON moderation_flags(meal_id);
CREATE INDEX IF NOT EXISTS idx_moderation_flags_status ON moderation_flags(status);

-- Row Level Security (RLS) ポリシー例
-- 注: 実際の実装では、より詳細なポリシーが必要です

-- user_profiles: 自分のプロファイルのみ閲覧・更新可能
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON user_profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- meals: 自分の食事記録のみ閲覧・更新可能
ALTER TABLE meals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own meals" ON meals
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own meals" ON meals
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own meals" ON meals
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own meals" ON meals
  FOR DELETE USING (auth.uid() = user_id);

-- meal_nutrition_estimates: 自分の食事の栄養推定のみ閲覧可能
ALTER TABLE meal_nutrition_estimates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own nutrition estimates" ON meal_nutrition_estimates
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM meals
      WHERE meals.id = meal_nutrition_estimates.meal_id
      AND meals.user_id = auth.uid()
    )
  );

-- meal_ai_feedbacks: 自分の食事のフィードバックのみ閲覧可能
ALTER TABLE meal_ai_feedbacks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own feedbacks" ON meal_ai_feedbacks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM meals
      WHERE meals.id = meal_ai_feedbacks.meal_id
      AND meals.user_id = auth.uid()
    )
  );

-- recipe_requests: 自分のリクエストのみ閲覧・更新可能
ALTER TABLE recipe_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own recipe requests" ON recipe_requests
  FOR ALL USING (auth.uid() = user_id);

-- weekly_menu_requests: 自分のリクエストのみ閲覧・更新可能
ALTER TABLE weekly_menu_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own weekly menu requests" ON weekly_menu_requests
  FOR ALL USING (auth.uid() = user_id);

-- user_badges: 自分のバッジのみ閲覧可能
ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own badges" ON user_badges
  FOR SELECT USING (auth.uid() = user_id);

-- badges: 全員が閲覧可能
ALTER TABLE badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view badges" ON badges
  FOR SELECT USING (true);

