-- #349: /api/onboarding/progress の DB 保存ロジック修正
-- user_profiles に onboarding 関連カラムおよびプロフィール詳細カラムを追加
-- progress/route.ts および complete/route.ts が参照するが未定義だったカラムをすべて追加する

ALTER TABLE user_profiles
  -- オンボーディング進捗
  ADD COLUMN IF NOT EXISTS onboarding_progress         JSONB,
  ADD COLUMN IF NOT EXISTS onboarding_started_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at     TIMESTAMPTZ,
  -- 基本プロフィール
  ADD COLUMN IF NOT EXISTS age                         INTEGER,
  ADD COLUMN IF NOT EXISTS occupation                  TEXT,
  ADD COLUMN IF NOT EXISTS height                      NUMERIC,
  ADD COLUMN IF NOT EXISTS weight                      NUMERIC,
  -- 目標
  ADD COLUMN IF NOT EXISTS nutrition_goal              TEXT,
  ADD COLUMN IF NOT EXISTS target_weight               NUMERIC,
  ADD COLUMN IF NOT EXISTS target_date                 DATE,
  ADD COLUMN IF NOT EXISTS weight_change_rate          TEXT,
  ADD COLUMN IF NOT EXISTS fitness_goals               TEXT[],
  ADD COLUMN IF NOT EXISTS weekly_exercise_minutes     INTEGER,
  -- 運動習慣
  ADD COLUMN IF NOT EXISTS exercise_types              TEXT[],
  ADD COLUMN IF NOT EXISTS exercise_frequency          INTEGER,
  ADD COLUMN IF NOT EXISTS exercise_intensity          TEXT,
  ADD COLUMN IF NOT EXISTS exercise_duration_per_session INTEGER,
  -- ライフスタイル
  ADD COLUMN IF NOT EXISTS work_style                  TEXT,
  ADD COLUMN IF NOT EXISTS health_conditions           TEXT[],
  ADD COLUMN IF NOT EXISTS cold_sensitivity            BOOLEAN,
  ADD COLUMN IF NOT EXISTS swelling_prone              BOOLEAN,
  ADD COLUMN IF NOT EXISTS sleep_quality               TEXT,
  ADD COLUMN IF NOT EXISTS stress_level                TEXT,
  ADD COLUMN IF NOT EXISTS pregnancy_status            TEXT,
  ADD COLUMN IF NOT EXISTS medications                 TEXT[],
  -- 食事嗜好
  ADD COLUMN IF NOT EXISTS favorite_ingredients        TEXT[],
  ADD COLUMN IF NOT EXISTS diet_style                  TEXT,
  -- 調理情報
  ADD COLUMN IF NOT EXISTS cooking_experience          TEXT,
  ADD COLUMN IF NOT EXISTS weekday_cooking_minutes     INTEGER,
  ADD COLUMN IF NOT EXISTS cuisine_preferences         JSONB,
  ADD COLUMN IF NOT EXISTS family_size                 INTEGER,
  ADD COLUMN IF NOT EXISTS shopping_frequency          TEXT,
  ADD COLUMN IF NOT EXISTS weekly_food_budget          INTEGER,
  ADD COLUMN IF NOT EXISTS kitchen_appliances          TEXT[],
  -- その他
  ADD COLUMN IF NOT EXISTS hobbies                     TEXT[];
