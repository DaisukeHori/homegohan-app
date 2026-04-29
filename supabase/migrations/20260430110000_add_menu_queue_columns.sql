-- weekly_menu_requests を queue として運用するための補助カラム
ALTER TABLE weekly_menu_requests
  ADD COLUMN IF NOT EXISTS worker_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS worker_acquired_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

-- queued 行を高速 pick するための部分インデックス
CREATE INDEX IF NOT EXISTS idx_weekly_menu_requests_queued
  ON weekly_menu_requests (created_at)
  WHERE status = 'queued';

-- atomic claim 関数
CREATE OR REPLACE FUNCTION claim_menu_request(p_worker_id TEXT)
RETURNS weekly_menu_requests AS $$
DECLARE
  v_row weekly_menu_requests;
BEGIN
  UPDATE weekly_menu_requests
  SET status = 'processing',
      worker_id = p_worker_id,
      worker_acquired_at = now(),
      attempt_count = attempt_count + 1
  WHERE id = (
    SELECT id FROM weekly_menu_requests
    WHERE status = 'queued'
       OR (status = 'processing' AND worker_acquired_at < now() - interval '5 minutes')
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION claim_menu_request(TEXT) TO service_role;
