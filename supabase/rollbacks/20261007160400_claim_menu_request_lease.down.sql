-- rollback: 20261007160400_claim_menu_request_lease.sql
-- ⚠️ 戻すと #1202 の問題が復活する: 生成が 5 分を超えると、動いているワーカーの行を cron が取り直して 2 本目を起動し、
--    同じ request に 2 本のチェーンが並走する (planned_meals の保存結果を互いに消し合う・LLM の呼び出しが二重になる)。
--    緊急時の切り戻し専用。
--
-- 内容: 2026-10-07 時点の本番の定義 (supabase/baseline/prod_schema.sql の claim_menu_request) へ戻す。
--   processing の行は worker_acquired_at < now() - interval '5 minutes' だけで取り直す。
--   署名・戻り値・SECURITY DEFINER・search_path・実行権限 (service_role のみ) は変わらない。
-- アプリ側 (cron の _continue と generate-menu-v5 の最終書き込みの CAS) は、DB が古い条件でも安全に動くので、同時に戻す必要は無い。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。
--
-- 何度流しても同じ結果になる (冪等)。

CREATE OR REPLACE FUNCTION "public"."claim_menu_request"("p_worker_id" "text") RETURNS "public"."weekly_menu_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;

REVOKE ALL ON FUNCTION public.claim_menu_request(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_menu_request(text) TO service_role;
