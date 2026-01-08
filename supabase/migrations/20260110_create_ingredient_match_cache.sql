-- 食材マッチングキャッシュテーブル
-- LLMで選択した食材マッチング結果をキャッシュし、2回目以降の処理を高速化

CREATE TABLE IF NOT EXISTS ingredient_match_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  input_name text NOT NULL,
  matched_ingredient_id uuid REFERENCES dataset_ingredients(id) ON DELETE CASCADE,
  match_method text NOT NULL DEFAULT 'llm', -- 'llm', 'exact', 'alias' など
  similarity numeric(5, 4), -- ベクトル類似度（0.0000 - 1.0000）
  created_at timestamptz DEFAULT now(),
  UNIQUE(input_name)
);

-- 高速検索用インデックス
CREATE INDEX IF NOT EXISTS idx_ingredient_match_cache_input_name
ON ingredient_match_cache(input_name);

-- RLSは不要（全ユーザー共通のキャッシュ）
ALTER TABLE ingredient_match_cache ENABLE ROW LEVEL SECURITY;

-- Supabase Functionsからのアクセスを許可
CREATE POLICY "Allow service role access" ON ingredient_match_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
