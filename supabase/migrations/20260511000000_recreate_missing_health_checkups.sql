-- Recreate health_checkups + dependents (lost during 20260111000000 apply).
-- Original migration was recorded in supabase_migrations.schema_migrations
-- but DDL did not actually run in prod. This file is fully idempotent
-- (IF NOT EXISTS / DROP IF EXISTS) and safe to re-run.

-- ============================================
-- 1. health_checkups テーブル
--    (20260111000000 のカラム + 20260112000000 の OCR カラムを一括定義)
-- ============================================

CREATE TABLE IF NOT EXISTS health_checkups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  checkup_date DATE NOT NULL,

  -- 基本情報
  facility_name TEXT,                    -- 医療機関名
  checkup_type TEXT,                     -- 定期健診/人間ドック等

  -- 身体測定
  height NUMERIC,                        -- 身長 cm
  weight NUMERIC,                        -- 体重 kg
  bmi NUMERIC,                           -- BMI
  waist_circumference NUMERIC,           -- 腹囲 cm

  -- 血圧
  blood_pressure_systolic INTEGER,       -- 収縮期血圧
  blood_pressure_diastolic INTEGER,      -- 拡張期血圧

  -- 血液検査
  hemoglobin NUMERIC,                    -- ヘモグロビン g/dL
  hba1c NUMERIC,                         -- HbA1c %
  fasting_glucose INTEGER,               -- 空腹時血糖 mg/dL

  -- 脂質
  total_cholesterol INTEGER,             -- 総コレステロール mg/dL
  ldl_cholesterol INTEGER,               -- LDLコレステロール mg/dL
  hdl_cholesterol INTEGER,               -- HDLコレステロール mg/dL
  triglycerides INTEGER,                 -- 中性脂肪 mg/dL

  -- 肝機能
  ast INTEGER,                           -- AST(GOT) U/L
  alt INTEGER,                           -- ALT(GPT) U/L
  gamma_gtp INTEGER,                     -- γ-GTP U/L

  -- 腎機能
  creatinine NUMERIC,                    -- クレアチニン mg/dL
  egfr NUMERIC,                          -- eGFR mL/min/1.73m²
  uric_acid NUMERIC,                     -- 尿酸 mg/dL

  -- 画像
  image_url TEXT,                        -- 健診結果画像URL

  -- AIレビュー
  individual_review JSONB,               -- 個別レビュー
  -- { summary, concerns[], positives[], recommendations[], riskLevel }

  -- OCR カラム (20260112000000_photo_system.sql より)
  ocr_extracted_data JSONB,             -- AI抽出の生データ（写真からの解析結果）
  ocr_extraction_timestamp TIMESTAMPTZ, -- 写真解析実行日時
  ocr_model_used TEXT,                  -- 使用したAIモデル名

  -- メタデータ
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN health_checkups.ocr_extracted_data IS 'AI抽出の生データ（写真からの解析結果）';
COMMENT ON COLUMN health_checkups.ocr_extraction_timestamp IS '写真解析実行日時';
COMMENT ON COLUMN health_checkups.ocr_model_used IS '使用したAIモデル名';

-- インデックス
CREATE INDEX IF NOT EXISTS idx_health_checkups_user_date
  ON health_checkups(user_id, checkup_date DESC);

-- RLS
ALTER TABLE health_checkups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own checkups" ON health_checkups;
CREATE POLICY "Users can view own checkups"
  ON health_checkups FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own checkups" ON health_checkups;
CREATE POLICY "Users can insert own checkups"
  ON health_checkups FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own checkups" ON health_checkups;
CREATE POLICY "Users can update own checkups"
  ON health_checkups FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own checkups" ON health_checkups;
CREATE POLICY "Users can delete own checkups"
  ON health_checkups FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================
-- 2. health_checkup_longitudinal_reviews テーブル
-- ============================================

CREATE TABLE IF NOT EXISTS health_checkup_longitudinal_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  -- レビュー内容
  review_date DATE DEFAULT CURRENT_DATE,
  checkup_ids UUID[] NOT NULL,           -- 対象となった健診ID群

  -- GPT-5.2 経年レビュー
  trend_analysis JSONB,                  -- 傾向分析
  -- {
  --   overallAssessment: "...",
  --   improvingMetrics: [...],
  --   worseningMetrics: [...],
  --   stableMetrics: [...],
  --   priorityActions: [...],
  -- }

  nutrition_guidance JSONB,              -- 栄養指針
  -- {
  --   generalDirection: "...",
  --   avoidanceHints: [...],
  --   emphasisHints: [...],
  --   specialNotes: "..."
  -- }

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ユーザーごとに最新1件のみ保持（upsertで上書き）
CREATE UNIQUE INDEX IF NOT EXISTS idx_longitudinal_review_user
  ON health_checkup_longitudinal_reviews(user_id);

-- RLS
ALTER TABLE health_checkup_longitudinal_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own longitudinal reviews" ON health_checkup_longitudinal_reviews;
CREATE POLICY "Users can view own longitudinal reviews"
  ON health_checkup_longitudinal_reviews FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own longitudinal reviews" ON health_checkup_longitudinal_reviews;
CREATE POLICY "Users can insert own longitudinal reviews"
  ON health_checkup_longitudinal_reviews FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own longitudinal reviews" ON health_checkup_longitudinal_reviews;
CREATE POLICY "Users can update own longitudinal reviews"
  ON health_checkup_longitudinal_reviews FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 3. user_profiles 拡張
-- ============================================

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS
  health_checkup_guidance JSONB;
  -- 最新の経年レビューから導出された栄養指針（献立生成で参照）

-- ============================================
-- 4. Storage バケット
-- ============================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'health-checkups',
  'health-checkups',
  false,  -- プライベート
  10485760,  -- 10MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: ユーザーは自分のフォルダのみアクセス可能
-- パス形式: {user_id}/{filename}

DROP POLICY IF EXISTS "Users can upload own checkup images" ON storage.objects;
CREATE POLICY "Users can upload own checkup images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'health-checkups'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can view own checkup images" ON storage.objects;
CREATE POLICY "Users can view own checkup images"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'health-checkups'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can delete own checkup images" ON storage.objects;
CREATE POLICY "Users can delete own checkup images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'health-checkups'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================
-- 5. updated_at トリガー
-- ============================================

CREATE OR REPLACE FUNCTION update_health_checkups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_health_checkups_updated_at ON health_checkups;
CREATE TRIGGER trigger_health_checkups_updated_at
  BEFORE UPDATE ON health_checkups
  FOR EACH ROW
  EXECUTE FUNCTION update_health_checkups_updated_at();

-- ============================================
-- 6. UNIQUE 制約 (user_id, checkup_date)
--    (20260430190000_health_checkups_unique.sql より)
--    ADD CONSTRAINT IF NOT EXISTS は PG 非対応のため DO $$ で冪等化
-- ============================================

DO $$
BEGIN
  ALTER TABLE health_checkups
    ADD CONSTRAINT health_checkups_user_date_unique
    UNIQUE (user_id, checkup_date);
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;
