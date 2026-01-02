-- アプリケーションログテーブル
-- Edge Functions、API Routes、クライアントからのログを保存

CREATE TABLE IF NOT EXISTS app_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- ログレベル: debug, info, warn, error
  level TEXT NOT NULL DEFAULT 'info',
  
  -- ログソース: edge-function, api-route, client
  source TEXT NOT NULL,
  
  -- 関数名/ルート名
  function_name TEXT,
  
  -- ユーザーID（オプション）
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- ログメッセージ
  message TEXT NOT NULL,
  
  -- 追加データ（JSON）
  metadata JSONB DEFAULT '{}'::jsonb,
  
  -- エラー情報
  error_message TEXT,
  error_stack TEXT,
  
  -- リクエスト情報
  request_id TEXT
);

-- インデックス
CREATE INDEX idx_app_logs_created_at ON app_logs(created_at DESC);
CREATE INDEX idx_app_logs_level ON app_logs(level);
CREATE INDEX idx_app_logs_source ON app_logs(source);
CREATE INDEX idx_app_logs_function_name ON app_logs(function_name);
CREATE INDEX idx_app_logs_user_id ON app_logs(user_id);

-- 古いログを自動削除（30日以上前）
-- Supabaseのpg_cronで定期実行する想定
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM app_logs WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- RLSポリシー（service_roleのみアクセス可能）
ALTER TABLE app_logs ENABLE ROW LEVEL SECURITY;

-- service_roleは全アクセス可能
CREATE POLICY "Service role can do everything" ON app_logs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 認証済みユーザーは自分のログのみ閲覧可能
CREATE POLICY "Users can view own logs" ON app_logs
  FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE app_logs IS 'アプリケーションログ - Edge Functions、API Routes、クライアントからのログを保存';
