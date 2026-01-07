-- ============================================
-- 日付ベースモデルへの移行マイグレーション
-- 週ベースの meal_plans/meal_plan_days を廃止し
-- 日付ベースの user_daily_meals へ一本化
-- 買い物リストは shopping_lists で独立管理
-- ============================================

-- ============================================
-- PART 1: 新テーブル作成
-- ============================================

-- 1.1 user_daily_meals テーブル（日付ベースの献立管理）
CREATE TABLE IF NOT EXISTS user_daily_meals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day_date DATE NOT NULL,
  theme TEXT,
  nutritional_focus TEXT,
  is_cheat_day BOOLEAN DEFAULT false,
  source_request_id UUID REFERENCES weekly_menu_requests(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, day_date)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_user_daily_meals_user_date ON user_daily_meals(user_id, day_date);
CREATE INDEX IF NOT EXISTS idx_user_daily_meals_day_date ON user_daily_meals(day_date);

-- RLS
ALTER TABLE user_daily_meals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own daily meals" ON user_daily_meals;
CREATE POLICY "Users can manage own daily meals" ON user_daily_meals
  FOR ALL USING (auth.uid() = user_id);

COMMENT ON TABLE user_daily_meals IS '日付ベースの献立管理テーブル。meal_plan_days の置き換え。';
COMMENT ON COLUMN user_daily_meals.day_date IS '献立の日付（YYYY-MM-DD）';
COMMENT ON COLUMN user_daily_meals.theme IS 'その日のテーマ（和食の日、時短メニュー等）';
COMMENT ON COLUMN user_daily_meals.is_cheat_day IS 'チートデーかどうか';

-- 1.2 shopping_lists テーブル（買い物リストの親テーブル）
CREATE TABLE IF NOT EXISTS shopping_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT DEFAULT 'active', -- 'active', 'archived'
  servings_config JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_shopping_lists_user_status ON shopping_lists(user_id, status);
CREATE INDEX IF NOT EXISTS idx_shopping_lists_dates ON shopping_lists(start_date, end_date);

-- 部分ユニーク: ユーザーごとに active は1件のみ
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopping_lists_active_unique 
  ON shopping_lists(user_id) WHERE status = 'active';

-- RLS
ALTER TABLE shopping_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own shopping lists" ON shopping_lists;
CREATE POLICY "Users can manage own shopping lists" ON shopping_lists
  FOR ALL USING (auth.uid() = user_id);

COMMENT ON TABLE shopping_lists IS '買い物リストの親テーブル。任意の日付範囲で生成可能。';
COMMENT ON COLUMN shopping_lists.status IS 'active=現在使用中, archived=過去のリスト';
COMMENT ON COLUMN shopping_lists.servings_config IS '生成時に使用した人数設定';

-- 1.3 shopping_list_requests テーブル（買い物リスト生成の非同期リクエスト管理）
CREATE TABLE IF NOT EXISTS shopping_list_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shopping_list_id UUID REFERENCES shopping_lists(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  progress JSONB, -- {phase, message, percentage}
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_shopping_list_requests_user ON shopping_list_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list_requests_status ON shopping_list_requests(status);
CREATE INDEX IF NOT EXISTS idx_shopping_list_requests_created ON shopping_list_requests(created_at DESC);

-- RLS
ALTER TABLE shopping_list_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own shopping list requests" ON shopping_list_requests;
CREATE POLICY "Users can manage own shopping list requests" ON shopping_list_requests
  FOR ALL USING (auth.uid() = user_id);

COMMENT ON TABLE shopping_list_requests IS '買い物リスト生成の非同期リクエスト管理';
COMMENT ON COLUMN shopping_list_requests.progress IS '進捗状況 {phase, message, percentage}';

-- ============================================
-- PART 2: user_profiles 拡張
-- ============================================

-- 週の開始曜日設定
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS week_start_day TEXT DEFAULT 'monday';
-- 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'

-- 人数設定（既存コードが参照している）
-- 既存の場合はスキップ、存在しない場合のみ追加
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'servings_config'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN servings_config JSONB DEFAULT '{"default": 2, "byDayMeal": {}}'::jsonb;
  END IF;
END $$;

COMMENT ON COLUMN user_profiles.week_start_day IS '週の開始曜日（UIのカレンダー表示用）。monday, sunday 等。';

-- ============================================
-- PART 3: planned_meals のFK置換
-- ============================================

-- 新しいFK列を追加
ALTER TABLE planned_meals 
ADD COLUMN IF NOT EXISTS daily_meal_id UUID;

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_planned_meals_daily_meal ON planned_meals(daily_meal_id);

-- FK制約を追加（遅延して別途追加、データ移行がないので即適用可能）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'planned_meals_daily_meal_id_fkey'
  ) THEN
    ALTER TABLE planned_meals 
    ADD CONSTRAINT planned_meals_daily_meal_id_fkey 
    FOREIGN KEY (daily_meal_id) REFERENCES user_daily_meals(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 旧FK/カラム削除（meal_plan_day_id）
ALTER TABLE planned_meals DROP CONSTRAINT IF EXISTS planned_meals_meal_plan_day_id_fkey;
DROP INDEX IF EXISTS idx_planned_meals_day_id;
ALTER TABLE planned_meals DROP COLUMN IF EXISTS meal_plan_day_id;

-- RLS更新
DROP POLICY IF EXISTS "Users can manage own planned meals" ON planned_meals;
CREATE POLICY "Users can manage own planned meals" ON planned_meals
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_daily_meals
      WHERE user_daily_meals.id = planned_meals.daily_meal_id
      AND user_daily_meals.user_id = auth.uid()
    )
  );

-- ============================================
-- PART 4: shopping_list_items のFK置換
-- ============================================

-- 新しいFK列を追加
ALTER TABLE shopping_list_items
ADD COLUMN IF NOT EXISTS shopping_list_id UUID;

-- FK制約を追加
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'shopping_list_items_shopping_list_id_fkey'
  ) THEN
    ALTER TABLE shopping_list_items 
    ADD CONSTRAINT shopping_list_items_shopping_list_id_fkey 
    FOREIGN KEY (shopping_list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE;
  END IF;
END $$;

-- インデックス置換
DROP INDEX IF EXISTS idx_shopping_list_items_plan_id;
DROP INDEX IF EXISTS idx_shopping_list_items_source;
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_list ON shopping_list_items(shopping_list_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_source_new ON shopping_list_items(shopping_list_id, source);

-- 旧FK/カラム削除（meal_plan_id）
ALTER TABLE shopping_list_items DROP CONSTRAINT IF EXISTS shopping_list_items_meal_plan_id_fkey;
ALTER TABLE shopping_list_items DROP COLUMN IF EXISTS meal_plan_id;

-- RLS更新
DROP POLICY IF EXISTS "Users can manage own shopping list" ON shopping_list_items;
CREATE POLICY "Users can manage own shopping list" ON shopping_list_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM shopping_lists
      WHERE shopping_lists.id = shopping_list_items.shopping_list_id
      AND shopping_lists.user_id = auth.uid()
    )
  );

-- ============================================
-- PART 5: 旧テーブル削除
-- ============================================

-- FK解除済みのため安全に削除可能
DROP TABLE IF EXISTS meal_plan_days CASCADE;
DROP TABLE IF EXISTS meal_plans CASCADE;

-- ============================================
-- PART 6: Realtime 有効化
-- ============================================

-- shopping_list_requests の進捗をリアルタイムで監視するため
ALTER PUBLICATION supabase_realtime ADD TABLE shopping_list_requests;

-- ============================================
-- 完了
-- ============================================
