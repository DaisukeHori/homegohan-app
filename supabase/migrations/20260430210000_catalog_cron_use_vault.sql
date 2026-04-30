-- ──────────────────────────────────────────────────────────────────
-- catalog cron 実行用の secret を Vault 経由で取得するよう修正
-- 前提: Supabase Dashboard SQL Editor で以下を 1 度だけ実行しておくこと
--   SELECT vault.create_secret('YOUR_CRON_SECRET', 'app_cron_secret', 'CRON_SECRET for catalog import');
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.invoke_catalog_import(p_function_name text)
RETURNS bigint AS $$
DECLARE
  v_url text;
  v_headers jsonb;
  v_request_id bigint;
  v_secret text;
BEGIN
  -- Vault から secret 取得
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'app_cron_secret'
  LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'app_cron_secret not found in Vault. Run: SELECT vault.create_secret(...) once.';
  END IF;

  v_url := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/' || p_function_name;
  v_headers := jsonb_build_object(
    'Authorization', 'Bearer ' || v_secret,
    'Content-Type', 'application/json'
  );
  SELECT net.http_post(url := v_url, headers := v_headers, body := '{}'::jsonb)
    INTO v_request_id;
  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
