-- 献立表（Meal Planner）用テーブル群

-- 1. 献立計画（親テーブル）
CREATE TABLE IF NOT EXISTS meal_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '週間献立',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, active, completed, archived
  is_active BOOLEAN DEFAULT false, -- 現在進行中の献立かどうか
  source_request_id UUID REFERENCES weekly_menu_requests(id) ON DELETE SET NULL, -- AI生成元のリクエストID
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 献立の1日
CREATE TABLE IF NOT EXISTS meal_plan_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_id UUID NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  day_date DATE NOT NULL,
  day_of_week TEXT, -- 'Monday', 'Tuesday', etc.
  theme TEXT, -- '和食の日', '時短メニュー' etc.
  nutritional_focus TEXT, -- '高タンパク', '低糖質' etc.
  is_cheat_day BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(meal_plan_id, day_date)
);

-- 3. 計画された食事（朝・昼・夕・間食）
CREATE TABLE IF NOT EXISTS planned_meals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_day_id UUID NOT NULL REFERENCES meal_plan_days(id) ON DELETE CASCADE,
  meal_type TEXT NOT NULL, -- 'breakfast', 'lunch', 'dinner', 'snack'
  dish_name TEXT NOT NULL,
  recipe_url TEXT,
  image_url TEXT, -- AI生成画像や参照画像のURL
  description TEXT,
  ingredients TEXT[], -- 簡易的な材料リスト
  calories_kcal INTEGER,
  protein_g NUMERIC,
  fat_g NUMERIC,
  carbs_g NUMERIC,
  is_completed BOOLEAN DEFAULT false, -- 実際に食べたかどうか
  completed_at TIMESTAMPTZ, -- 食べた日時
  actual_meal_id UUID REFERENCES meals(id) ON DELETE SET NULL, -- 実績テーブルとのリンク
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 買い物リスト項目
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_id UUID NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'その他', -- '野菜', '肉・魚', '調味料' etc.
  item_name TEXT NOT NULL,
  quantity TEXT, -- '2個', '300g' etc.
  is_checked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_meal_plans_user_id ON meal_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_meal_plans_status ON meal_plans(status);
CREATE INDEX IF NOT EXISTS idx_meal_plans_dates ON meal_plans(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_meal_plan_days_plan_id ON meal_plan_days(meal_plan_id);
CREATE INDEX IF NOT EXISTS idx_planned_meals_day_id ON planned_meals(meal_plan_day_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_plan_id ON shopping_list_items(meal_plan_id);

-- RLSポリシー
ALTER TABLE meal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_plan_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE planned_meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_items ENABLE ROW LEVEL SECURITY;

-- meal_plans: 自分の計画のみ操作可能
CREATE POLICY "Users can manage own meal plans" ON meal_plans
  FOR ALL USING (auth.uid() = user_id);

-- meal_plan_days: 親のmeal_planにアクセスできれば操作可能（間接的に所有者チェック）
CREATE POLICY "Users can manage own meal plan days" ON meal_plan_days
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM meal_plans
      WHERE meal_plans.id = meal_plan_days.meal_plan_id
      AND meal_plans.user_id = auth.uid()
    )
  );

-- planned_meals: 親のmeal_plan_day -> meal_plan経由でチェック
CREATE POLICY "Users can manage own planned meals" ON planned_meals
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM meal_plan_days
      JOIN meal_plans ON meal_plans.id = meal_plan_days.meal_plan_id
      WHERE meal_plan_days.id = planned_meals.meal_plan_day_id
      AND meal_plans.user_id = auth.uid()
    )
  );

-- shopping_list_items: 親のmeal_plan経由でチェック
CREATE POLICY "Users can manage own shopping list" ON shopping_list_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM meal_plans
      WHERE meal_plans.id = shopping_list_items.meal_plan_id
      AND meal_plans.user_id = auth.uid()
    )
  );



