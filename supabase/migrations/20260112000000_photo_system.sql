-- 写真認識システム拡張
-- 1. health_checkups に OCR カラム追加
-- 2. fridge_snapshots テーブル作成（冷蔵庫写真解析履歴）

-- ============================================
-- 1. health_checkups に OCR カラム追加
-- ============================================

ALTER TABLE health_checkups
  ADD COLUMN IF NOT EXISTS ocr_extracted_data JSONB,
  ADD COLUMN IF NOT EXISTS ocr_extraction_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ocr_model_used TEXT;

COMMENT ON COLUMN health_checkups.ocr_extracted_data IS 'AI抽出の生データ（写真からの解析結果）';
COMMENT ON COLUMN health_checkups.ocr_extraction_timestamp IS '写真解析実行日時';
COMMENT ON COLUMN health_checkups.ocr_model_used IS '使用したAIモデル名';

-- ============================================
-- 2. fridge_snapshots テーブル作成
-- ============================================

CREATE TABLE IF NOT EXISTS fridge_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 写真
  image_url TEXT,

  -- 解析結果
  extracted_ingredients JSONB,
  -- [{ name, amount, category, expiration_estimate }]

  -- メタデータ
  snapshot_date TIMESTAMPTZ DEFAULT NOW(),
  model_used TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_fridge_snapshots_user_date
  ON fridge_snapshots(user_id, snapshot_date DESC);

-- RLS
ALTER TABLE fridge_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own fridge snapshots"
  ON fridge_snapshots FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own fridge snapshots"
  ON fridge_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own fridge snapshots"
  ON fridge_snapshots FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
