-- 埋め込み再生成ジョブの進捗を保存するテーブル

CREATE TABLE IF NOT EXISTS embedding_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- ジョブ情報
  status TEXT NOT NULL DEFAULT 'idle', -- 'idle', 'running', 'completed', 'error'
  table_name TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  
  -- 進捗情報
  start_offset INTEGER DEFAULT 0,
  current_offset INTEGER DEFAULT 0,
  total_processed INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  percentage NUMERIC(5, 2) DEFAULT 0,
  
  -- 時間情報
  start_time TIMESTAMPTZ,
  elapsed_minutes NUMERIC(10, 1),
  completed_at TIMESTAMPTZ,
  
  -- エラー情報
  error_message TEXT,
  
  -- メタデータ
  metadata JSONB DEFAULT '{}'::jsonb
);

-- インデックス
CREATE INDEX idx_embedding_jobs_job_id ON embedding_jobs(job_id);
CREATE INDEX idx_embedding_jobs_status ON embedding_jobs(status);
CREATE INDEX idx_embedding_jobs_created_at ON embedding_jobs(created_at DESC);

-- updated_atを自動更新
CREATE OR REPLACE FUNCTION update_embedding_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_embedding_jobs_updated_at
  BEFORE UPDATE ON embedding_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_embedding_jobs_updated_at();

-- RLSポリシー（service_roleのみアクセス可能）
ALTER TABLE embedding_jobs ENABLE ROW LEVEL SECURITY;

-- service_roleは全アクセス可能
CREATE POLICY "Service role can do everything" ON embedding_jobs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Super Adminは閲覧可能
CREATE POLICY "Super admin can view" ON embedding_jobs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND 'super_admin' = ANY(roles)
    )
  );

COMMENT ON TABLE embedding_jobs IS '埋め込み再生成ジョブの進捗を保存';
