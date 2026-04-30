-- #115: claim_menu_request に attempt_count 上限を追加
-- 3回以上試みたリクエストは自動的に failed に遷移させる

-- 上限超過リクエストを自動 failed 化する部分インデックス（モニタリング用）
CREATE INDEX IF NOT EXISTS idx_weekly_menu_requests_exceeded_attempts
  ON weekly_menu_requests (updated_at)
  WHERE status = 'queued' AND attempt_count >= 3;

-- claim_menu_request を再定義: attempt_count < 3 のみ対象、上限超過は failed に遷移
CREATE OR REPLACE FUNCTION claim_menu_request(p_worker_id TEXT)
RETURNS weekly_menu_requests AS $$
DECLARE
  v_row weekly_menu_requests;
BEGIN
  -- まず attempt_count >= 3 かつ status='queued' のレコードを failed に遷移
  UPDATE weekly_menu_requests
  SET status = 'failed',
      error_message = 'attempt_limit_exceeded',
      updated_at = now()
  WHERE status = 'queued'
    AND attempt_count >= 3;

  -- 通常の claim: attempt_count < 3 のみ対象
  UPDATE weekly_menu_requests
  SET status = 'processing',
      worker_id = p_worker_id,
      worker_acquired_at = now(),
      attempt_count = attempt_count + 1
  WHERE id = (
    SELECT id FROM weekly_menu_requests
    WHERE (
      (status = 'queued' AND attempt_count < 3)
      OR (status = 'processing' AND worker_acquired_at < now() - interval '5 minutes' AND attempt_count < 3)
    )
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION claim_menu_request(TEXT) TO service_role;
