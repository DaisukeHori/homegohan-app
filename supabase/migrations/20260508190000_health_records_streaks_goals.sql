-- health 系テーブル作成
-- 1. health_records  — 日次健康記録
-- 2. health_streaks  — 連続記録管理
-- 3. health_goals    — 健康目標

-- ============================================
-- 1. health_records テーブル
-- ============================================

CREATE TABLE IF NOT EXISTS health_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  record_date DATE NOT NULL,

  -- 体組成
  weight NUMERIC,                         -- 体重 kg
  body_fat_percentage NUMERIC,            -- 体脂肪率 %
  muscle_mass NUMERIC,                    -- 筋肉量 kg

  -- バイタル
  systolic_bp INTEGER,                    -- 収縮期血圧 mmHg
  diastolic_bp INTEGER,                   -- 拡張期血圧 mmHg
  heart_rate INTEGER,                     -- 心拍数 bpm
  body_temp NUMERIC,                      -- 体温 °C

  -- 睡眠
  sleep_hours NUMERIC,                    -- 睡眠時間 h
  sleep_quality INTEGER,                  -- 睡眠の質 1-10

  -- 気分・コンディション
  mood_score INTEGER,                     -- 気分スコア 1-10
  stress_level INTEGER,                   -- ストレスレベル 1-10
  overall_condition INTEGER,              -- 全体的な体調 1-10
  energy_level INTEGER,                   -- エネルギーレベル 1-10

  -- 活動
  water_intake INTEGER,                   -- 水分摂取量 mL
  step_count INTEGER,                     -- 歩数
  bowel_movement INTEGER,                 -- 排便回数

  -- テキスト
  daily_note TEXT,                        -- 日記メモ
  data_source TEXT,                       -- 'quick' | 'photo' | 'manual' 等

  -- メタデータ
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (user_id, record_date)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_health_records_user_date
  ON health_records(user_id, record_date DESC);

-- RLS
ALTER TABLE health_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own health records"
  ON health_records FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own health records"
  ON health_records FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own health records"
  ON health_records FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own health records"
  ON health_records FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- updated_at トリガー
CREATE OR REPLACE FUNCTION update_health_records_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_health_records_updated_at ON health_records;
CREATE TRIGGER trigger_health_records_updated_at
  BEFORE UPDATE ON health_records
  FOR EACH ROW
  EXECUTE FUNCTION update_health_records_updated_at();

-- ============================================
-- 2. health_streaks テーブル
-- ============================================

CREATE TABLE IF NOT EXISTS health_streaks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  streak_type TEXT NOT NULL,              -- 'daily_record' | 'meal_record' | 'health_record' | 'exercise_record'

  current_streak INTEGER DEFAULT 0,      -- 現在の連続日数
  longest_streak INTEGER DEFAULT 0,      -- 最長連続日数
  total_records INTEGER DEFAULT 0,       -- 総記録数
  last_activity_date DATE,               -- 最終記録日
  streak_start_date DATE,                -- 現在の連続開始日
  achieved_badges TEXT[] DEFAULT '{}',   -- 達成バッジコード配列

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (user_id, streak_type)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_health_streaks_user_type
  ON health_streaks(user_id, streak_type);

-- RLS
ALTER TABLE health_streaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own health streaks"
  ON health_streaks FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own health streaks"
  ON health_streaks FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own health streaks"
  ON health_streaks FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own health streaks"
  ON health_streaks FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- updated_at トリガー
CREATE OR REPLACE FUNCTION update_health_streaks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_health_streaks_updated_at ON health_streaks;
CREATE TRIGGER trigger_health_streaks_updated_at
  BEFORE UPDATE ON health_streaks
  FOR EACH ROW
  EXECUTE FUNCTION update_health_streaks_updated_at();

-- ============================================
-- 3. health_goals テーブル
-- ============================================

CREATE TABLE IF NOT EXISTS health_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  goal_type TEXT NOT NULL,               -- 'weight' | 'body_fat' | 'muscle_mass' 等

  -- 目標値
  target_value NUMERIC NOT NULL,         -- 目標値
  target_unit TEXT NOT NULL,             -- 単位 (kg, %, 等)
  target_date DATE,                      -- 目標達成日

  -- 進捗
  start_value NUMERIC,                   -- 開始時点の値
  current_value NUMERIC,                 -- 現在の値
  progress_percentage NUMERIC DEFAULT 0, -- 進捗率 0-100

  -- マイルストーン (JSONB array: [{value, achieved_at}])
  milestones JSONB DEFAULT '[]',

  -- ステータス
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'achieved' | 'cancelled'
  achieved_at TIMESTAMPTZ,              -- 達成日時

  -- メモ
  note TEXT,

  -- メタデータ
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_health_goals_user_status
  ON health_goals(user_id, status);

CREATE INDEX IF NOT EXISTS idx_health_goals_user_type
  ON health_goals(user_id, goal_type);

-- RLS
ALTER TABLE health_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own health goals"
  ON health_goals FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own health goals"
  ON health_goals FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own health goals"
  ON health_goals FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own health goals"
  ON health_goals FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- updated_at トリガー
CREATE OR REPLACE FUNCTION update_health_goals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_health_goals_updated_at ON health_goals;
CREATE TRIGGER trigger_health_goals_updated_at
  BEFORE UPDATE ON health_goals
  FOR EACH ROW
  EXECUTE FUNCTION update_health_goals_updated_at();
