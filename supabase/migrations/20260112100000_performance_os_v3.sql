-- ============================================
-- Performance OS v3 - データモデル
--
-- コンセプト: 競技・学業・仕事のパフォーマンス最大化を支援
-- - PerformanceProfile（静的）: 競技/ロール/期分け/成長判定
-- - PerformanceState（動的）: 日次チェックイン
-- - PerformancePlan（方針）: 観測→調整の履歴
-- ============================================

-- ============================================
-- PART 1: user_profiles.performance_profile カラム追加
-- ============================================

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS performance_profile JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN user_profiles.performance_profile IS
'パフォーマンスプロファイル (静的設定)
{
  "sport": {
    "id": "tennis",                    -- スポーツID or "custom"
    "name": "テニス",                   -- 表示名（自由入力の場合）
    "role": "baseline",                -- ロール（プレースタイル）
    "experience": "intermediate",      -- beginner/intermediate/advanced
    "phase": "training",               -- training/competition/cut/recovery
    "demandVector": {                  -- 要求特性（0-1）
      "endurance": 0.7,
      "power": 0.5,
      "strength": 0.4,
      "technique": 0.8,
      "weightClass": 0,
      "heat": 0.6,
      "altitude": 0
    }
  },
  "growth": {
    "isUnder18": false,               -- 18歳未満フラグ
    "heightChangeRecent": null,       -- 直近の身長変化（cm）
    "growthProtectionEnabled": false  -- 成長保護モードON/OFF
  },
  "cut": {
    "enabled": false,                 -- 減量モード有効
    "targetWeight": null,             -- 目標体重
    "targetDate": null,               -- 目標日（計量日など）
    "strategy": "gradual"             -- gradual/rapid
  },
  "priorities": {                     -- 優先栄養素
    "protein": "high",
    "carbs": "moderate",
    "fat": "moderate",
    "hydration": "high"
  }
}';

-- ============================================
-- PART 2: user_performance_checkins テーブル
-- ============================================

CREATE TABLE IF NOT EXISTS user_performance_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  checkin_date DATE NOT NULL,

  -- 基本項目（30秒チェックイン）
  sleep_hours NUMERIC(3,1),           -- 睡眠時間（時間）
  sleep_quality SMALLINT CHECK (sleep_quality BETWEEN 1 AND 5), -- 睡眠の質 1-5
  fatigue SMALLINT CHECK (fatigue BETWEEN 1 AND 5),             -- 疲労度 1-5
  focus SMALLINT CHECK (focus BETWEEN 1 AND 5),                 -- 集中力 1-5
  hunger SMALLINT CHECK (hunger BETWEEN 1 AND 5),               -- 空腹感 1-5

  -- トレーニング負荷
  training_load_rpe SMALLINT CHECK (training_load_rpe BETWEEN 1 AND 10), -- RPE 1-10
  training_minutes INTEGER,           -- トレーニング時間（分）

  -- 任意項目
  weight NUMERIC(5,2),                -- 体重（kg）
  body_fat_percentage NUMERIC(4,1),   -- 体脂肪率（%）
  resting_heart_rate INTEGER,         -- 安静時心拍数
  mood SMALLINT CHECK (mood BETWEEN 1 AND 5),                   -- 気分 1-5
  soreness SMALLINT CHECK (soreness BETWEEN 1 AND 5),           -- 筋肉痛 1-5

  -- 自由メモ
  note TEXT,

  -- メタデータ
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, checkin_date)
);

CREATE INDEX idx_performance_checkins_user_date
  ON user_performance_checkins(user_id, checkin_date DESC);

COMMENT ON TABLE user_performance_checkins IS
'日次パフォーマンスチェックイン（観測データ）。7日分揃うと個別最適化が有効になる。';

-- ============================================
-- PART 3: performance_plans テーブル
-- ============================================

CREATE TABLE IF NOT EXISTS performance_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 有効期間
  start_date DATE NOT NULL,
  end_date DATE,                      -- NULLなら無期限
  status TEXT NOT NULL DEFAULT 'active', -- active/superseded/archived

  -- 調整内容
  adjustment_type TEXT NOT NULL,      -- calorie_up/calorie_down/carb_timing/fat_floor/etc
  adjustment_value JSONB NOT NULL,    -- 具体的な調整値
  -- 例: {"delta_kcal": 150}, {"fat_ratio_min": 0.20}, {"carb_timing": "pre_training"}

  -- 根拠
  rationale TEXT NOT NULL,            -- 人間向けの説明
  trigger_data JSONB,                 -- 調整のトリガーとなったデータ
  -- 例: {"7d_weight_delta": -0.8, "avg_fatigue": 4.2, "checkin_count": 7}

  evidence_urls TEXT[],               -- 根拠となる参考URL

  -- メタデータ
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_performance_plans_user_status
  ON performance_plans(user_id, status, start_date DESC);

COMMENT ON TABLE performance_plans IS
'パフォーマンス調整計画（方針スナップショット）。観測→調整ループの履歴を保持。';

-- ============================================
-- PART 4: RLSポリシー
-- ============================================

ALTER TABLE user_performance_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_plans ENABLE ROW LEVEL SECURITY;

-- user_performance_checkins: 自分のデータのみ
CREATE POLICY "Users can manage own performance checkins"
  ON user_performance_checkins
  FOR ALL USING (auth.uid() = user_id);

-- performance_plans: 自分のデータのみ
CREATE POLICY "Users can manage own performance plans"
  ON performance_plans
  FOR ALL USING (auth.uid() = user_id);

-- ============================================
-- PART 5: 更新トリガー
-- ============================================

-- チェックイン更新時のタイムスタンプ
CREATE OR REPLACE FUNCTION update_performance_checkin_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_performance_checkin_timestamp
  BEFORE UPDATE ON user_performance_checkins
  FOR EACH ROW EXECUTE FUNCTION update_performance_checkin_timestamp();

-- プラン更新時のタイムスタンプ
CREATE TRIGGER trg_update_performance_plan_timestamp
  BEFORE UPDATE ON performance_plans
  FOR EACH ROW EXECUTE FUNCTION update_performance_checkin_timestamp();

-- ============================================
-- PART 6: 便利関数
-- ============================================

-- 7日移動平均を取得
CREATE OR REPLACE FUNCTION get_7d_checkin_averages(p_user_id UUID, p_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
  avg_sleep_hours NUMERIC,
  avg_sleep_quality NUMERIC,
  avg_fatigue NUMERIC,
  avg_focus NUMERIC,
  avg_hunger NUMERIC,
  avg_training_rpe NUMERIC,
  total_training_minutes INTEGER,
  weight_start NUMERIC,
  weight_end NUMERIC,
  weight_delta NUMERIC,
  checkin_count INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH recent_checkins AS (
    SELECT *
    FROM user_performance_checkins
    WHERE user_id = p_user_id
      AND checkin_date BETWEEN (p_date - INTERVAL '6 days')::DATE AND p_date
    ORDER BY checkin_date
  ),
  weight_data AS (
    SELECT
      (SELECT weight FROM recent_checkins WHERE weight IS NOT NULL ORDER BY checkin_date LIMIT 1) as first_weight,
      (SELECT weight FROM recent_checkins WHERE weight IS NOT NULL ORDER BY checkin_date DESC LIMIT 1) as last_weight
  )
  SELECT
    ROUND(AVG(sleep_hours)::NUMERIC, 1),
    ROUND(AVG(sleep_quality)::NUMERIC, 1),
    ROUND(AVG(fatigue)::NUMERIC, 1),
    ROUND(AVG(focus)::NUMERIC, 1),
    ROUND(AVG(hunger)::NUMERIC, 1),
    ROUND(AVG(training_load_rpe)::NUMERIC, 1),
    COALESCE(SUM(training_minutes), 0)::INTEGER,
    wd.first_weight,
    wd.last_weight,
    ROUND((wd.last_weight - wd.first_weight)::NUMERIC, 2),
    COUNT(*)::INTEGER
  FROM recent_checkins rc
  CROSS JOIN weight_data wd
  GROUP BY wd.first_weight, wd.last_weight;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_7d_checkin_averages IS
'過去7日間のチェックインデータの移動平均を取得。個別最適化の判定に使用。';

-- ============================================
-- PART 7: スポーツライブラリテーブル（プリセット用）
-- ============================================

CREATE TABLE IF NOT EXISTS sport_presets (
  id TEXT PRIMARY KEY,                -- 'tennis', 'road_cycling', etc.
  name_ja TEXT NOT NULL,              -- 日本語名
  name_en TEXT NOT NULL,              -- 英語名
  category TEXT NOT NULL,             -- ball/cycling/combat/running/swimming/etc

  -- ロール定義
  roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 例: [{"id": "baseline", "name_ja": "ベースライナー", "name_en": "Baseliner"}, ...]

  -- 要求特性ベクトル（デフォルト値）
  demand_vector JSONB NOT NULL,
  -- 例: {"endurance": 0.7, "power": 0.5, "strength": 0.4, ...}

  -- 期分けの説明
  phase_descriptions JSONB,
  -- 例: {"training": "オフシーズン/基礎体力期", "competition": "シーズン中", ...}

  -- メタ
  is_weight_class BOOLEAN DEFAULT false,  -- 体重階級制
  is_team_sport BOOLEAN DEFAULT false,    -- チーム競技
  typical_competition_duration TEXT,      -- "2-3 hours", "90 minutes", etc

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE sport_presets IS
'スポーツプリセット100種目。roles/experience/phases/demand_vectorを定義。';

-- ============================================
-- 完了
-- ============================================
