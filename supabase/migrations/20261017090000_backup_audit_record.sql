-- migration: 20261017090000_backup_audit_record.sql
-- 戻し方: supabase/rollbacks/20261017090000_backup_audit_record.down.sql
-- #1129 バックアップの取得 (GitHub Actions) が admin_audit_logs に結果を 1 行残すための関数。
-- 呼ぶのは所有者 postgres (Actions が SUPABASE_DB_PASSWORD で繋ぐロール) だけ。anon / authenticated / service_role からは外す。
-- postgres は admin_audit_logs の所有者で rolbypassrls なので、INSERT の RLS (actor_id = auth.uid()) に当たらない
-- (pg_cron の handson_tour_sandbox_cleanup と同じ「利用者のいない操作」。actor_id・ip_address は NULL のまま)。
CREATE OR REPLACE FUNCTION public.record_backup_audit(p_action_type text, p_details jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_severity text;
  -- details の上限 (bytes)。scripts/lib/backup-db.mjs の AUDIT_DETAILS_MAX_BYTES と同じ値
  c_details_max_bytes CONSTANT integer := 8192;
BEGIN
  IF p_action_type IS NULL OR p_action_type NOT IN (
    'backup.daily.completed', 'backup.daily.failed',
    'backup.weekly.completed', 'backup.weekly.failed',
    'backup.annual.completed', 'backup.annual.failed'
  ) THEN
    RAISE EXCEPTION 'record_backup_audit: invalid action_type' USING ERRCODE = '22023';
  END IF;
  IF p_details IS NULL OR pg_catalog.jsonb_typeof(p_details) <> 'object' THEN
    RAISE EXCEPTION 'record_backup_audit: details must be an object' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.pg_column_size(p_details) > c_details_max_bytes THEN
    RAISE EXCEPTION 'record_backup_audit: details too large' USING ERRCODE = '22023';
  END IF;
  v_severity := CASE WHEN p_action_type LIKE '%.failed' THEN 'warn' ELSE 'info' END;

  INSERT INTO public.admin_audit_logs (actor_id, action_type, target_type, details, severity)
  VALUES (NULL, p_action_type, 'database_backup', p_details, v_severity)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.record_backup_audit(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- GRANT は付けない。所有者 (postgres) だけが呼べる (20261015180000 の invoke_process_meal_image_jobs と同じ形)

COMMENT ON FUNCTION public.record_backup_audit(text, jsonb) IS
  '#1129: DB バックアップの取得 (GitHub Actions) の結果を admin_audit_logs に 1 行残す。action_type は backup.<daily|weekly|annual>.<completed|failed>、target_type は database_backup、actor_id は NULL (利用者のいない操作)。所有者 postgres のみ';
