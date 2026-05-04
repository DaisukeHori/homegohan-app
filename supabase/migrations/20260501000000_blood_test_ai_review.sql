-- 血液検査 AIレビュー・経年分析対応
-- 1. blood_test_results に ai_review カラムを追加
-- 2. blood_test_longitudinal_reviews テーブルを新規作成

-- ============================================
-- 1. blood_test_results に ai_review を追加
-- ============================================

ALTER TABLE blood_test_results
  ADD COLUMN IF NOT EXISTS ai_review JSONB;
-- { summary, concerns[], positives[], recommendations[], riskLevel }

-- ============================================
-- 2. blood_test_longitudinal_reviews テーブル
-- ============================================

CREATE TABLE IF NOT EXISTS blood_test_longitudinal_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  review_date DATE DEFAULT CURRENT_DATE,
  blood_test_ids UUID[] NOT NULL,        -- 対象となった検査ID群

  trend_analysis JSONB,
  -- {
  --   overallAssessment: "...",
  --   improvingMetrics: [{ metric, detail }],
  --   worseningMetrics: [{ metric, detail, severity }],
  --   stableMetrics: [...],
  --   priorityActions: [...],
  -- }

  nutrition_guidance JSONB,
  -- {
  --   generalDirection: "...",
  --   avoidanceHints: [...],
  --   emphasisHints: [...],
  --   specialNotes: "..."
  -- }

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ユーザーごとに最新1件のみ保持（upsertで上書き）
CREATE UNIQUE INDEX IF NOT EXISTS idx_blood_test_longitudinal_review_user
  ON blood_test_longitudinal_reviews(user_id);

-- RLS
ALTER TABLE blood_test_longitudinal_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own blood test longitudinal reviews"
  ON blood_test_longitudinal_reviews FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own blood test longitudinal reviews"
  ON blood_test_longitudinal_reviews FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own blood test longitudinal reviews"
  ON blood_test_longitudinal_reviews FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
