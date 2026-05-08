-- #llm-usage: llm_usage_logs テーブル新規追加
--
-- 背景:
--   supabase/functions/_shared/llm-usage.ts (l.378) が llm_usage_logs テーブルへ
--   INSERT しているが、migration が存在しないため super-admin/llm/usage API が
--   500 エラーを返していた。
--
-- カラム名の対応:
--   Edge Function (_shared/llm-usage.ts) が INSERT するカラム名と
--   API Route (super-admin/llm/usage/route.ts) が SELECT するカラム名が
--   一部異なるため、generated column でエイリアスを設ける。
--
--   Edge Function INSERT: input_tokens, output_tokens, estimated_cost_usd
--   API Route SELECT:     prompt_tokens, completion_tokens, cost_usd
--   → prompt_tokens / completion_tokens / cost_usd を GENERATED ALWAYS AS で定義

CREATE TABLE IF NOT EXISTS llm_usage_logs (
  -- 主キー
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 実行コンテキスト
  function_name       TEXT          NOT NULL,
  execution_id        UUID          NOT NULL,
  request_id          UUID,
  user_id             UUID          REFERENCES user_profiles(id) ON DELETE SET NULL,

  -- LLM プロバイダ情報
  provider            TEXT          NOT NULL,          -- 'openai' | 'xai' | 'mixed'
  endpoint            TEXT          NOT NULL,          -- API パス (e.g. /v1/chat/completions)
  model               TEXT          NOT NULL DEFAULT 'unknown',
  call_type           TEXT,                            -- 'chat' | 'response' | 'embedding' | 'summary' | 'unknown'

  -- トークン数 (Edge Function が INSERT するカラム名)
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  total_tokens        INTEGER,

  -- トークン数エイリアス (API Route が SELECT するカラム名)
  prompt_tokens       INTEGER GENERATED ALWAYS AS (input_tokens) STORED,
  completion_tokens   INTEGER GENERATED ALWAYS AS (output_tokens) STORED,

  -- コスト (Edge Function は estimated_cost_usd で INSERT)
  estimated_cost_usd  NUMERIC(12, 6),

  -- コストエイリアス (API Route は cost_usd で SELECT)
  cost_usd            NUMERIC(12, 6) GENERATED ALWAYS AS (estimated_cost_usd) STORED,

  -- パフォーマンス
  duration_ms         INTEGER       NOT NULL DEFAULT 0,

  -- 成否
  success             BOOLEAN       NOT NULL DEFAULT TRUE,
  status_code         INTEGER,
  error_message       TEXT,

  -- OpenAI トレーサビリティ
  openai_response_id  TEXT,
  openai_request_id   TEXT,

  -- サマリ行フラグ (同一 execution_id の集計行)
  is_summary          BOOLEAN       NOT NULL DEFAULT FALSE,

  -- 追加メタデータ (JSON)
  metadata            JSONB,

  -- タイムスタンプ
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- コメント
COMMENT ON TABLE llm_usage_logs IS 'LLM API 呼び出しのトークン使用量・コストを記録するログテーブル。Edge Function の withOpenAIUsageContext() が INSERT する。';
COMMENT ON COLUMN llm_usage_logs.function_name IS 'Edge Function 名 (例: generate-menu-v4)';
COMMENT ON COLUMN llm_usage_logs.execution_id IS '1回の Edge Function 実行単位 UUID';
COMMENT ON COLUMN llm_usage_logs.is_summary IS 'TRUE の場合、同一 execution_id の全 call を集約したサマリ行';
COMMENT ON COLUMN llm_usage_logs.prompt_tokens IS 'input_tokens の generated alias (super-admin API 互換)';
COMMENT ON COLUMN llm_usage_logs.completion_tokens IS 'output_tokens の generated alias (super-admin API 互換)';
COMMENT ON COLUMN llm_usage_logs.cost_usd IS 'estimated_cost_usd の generated alias (super-admin API 互換)';

-- インデックス
CREATE INDEX IF NOT EXISTS llm_usage_logs_user_id_created_at_idx
  ON llm_usage_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_logs_model_created_at_idx
  ON llm_usage_logs (model, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_logs_created_at_idx
  ON llm_usage_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_logs_function_name_created_at_idx
  ON llm_usage_logs (function_name, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_logs_execution_id_idx
  ON llm_usage_logs (execution_id);

-- RLS 有効化
ALTER TABLE llm_usage_logs ENABLE ROW LEVEL SECURITY;

-- super_admin: 全件参照可
CREATE POLICY "llm_usage_logs_select_super_admin"
  ON llm_usage_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND 'super_admin' = ANY(roles)
    )
  );

-- 一般ユーザー: 自分の行のみ参照可
CREATE POLICY "llm_usage_logs_select_own"
  ON llm_usage_logs
  FOR SELECT
  USING (user_id = auth.uid());

-- INSERT: service_role (Edge Function) のみ許可
-- (service_role は RLS をバイパスするため policy 不要だが明示的に定義)
-- 一般ユーザー・anon からの直接 INSERT は禁止 (policy なし = 拒否)

-- UPDATE / DELETE: 禁止 (immutable ログ)
-- policy なし = 全員拒否
