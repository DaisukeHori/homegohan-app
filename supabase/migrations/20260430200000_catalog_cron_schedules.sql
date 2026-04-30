-- #290: pg_cron + pg_net 拡張を有効化し、カタログ自動取り込みスケジュールを登録する
-- 注意: pg_cron / pg_net は Supabase Dashboard → Database → Extensions で
--       事前に「Enabled」状態にしてから、この migration を apply してください。

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- helper function: Edge Function を呼び出す共通ラッパー
-- app.cron_secret は Supabase Dashboard → Settings → Database → Parameters で
-- ALTER DATABASE postgres SET "app.cron_secret" = '<your-secret>' を実行して設定する
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoke_catalog_import(p_function_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url      text;
  v_headers  jsonb;
  v_request_id bigint;
BEGIN
  v_url := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/' || p_function_name;
  v_headers := jsonb_build_object(
    'Authorization', 'Bearer ' || current_setting('app.cron_secret', true),
    'Content-Type',  'application/json'
  );

  SELECT net.http_post(
    url     := v_url,
    headers := v_headers,
    body    := '{}'::jsonb
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- cron schedules — 毎日 3:00–4:00 UTC (JST 12:00–13:00)
-- 既存の同名スケジュールがあれば unschedule してから再登録する
-- ---------------------------------------------------------------------------

SELECT cron.unschedule('catalog-import-seven')          WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catalog-import-seven');
SELECT cron.unschedule('catalog-import-familymart')      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catalog-import-familymart');
SELECT cron.unschedule('catalog-import-lawson')          WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catalog-import-lawson');
SELECT cron.unschedule('catalog-import-natural-lawson')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catalog-import-natural-lawson');
SELECT cron.unschedule('catalog-import-ministop')        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catalog-import-ministop');

SELECT cron.schedule(
  'catalog-import-seven',
  '0 3 * * *',
  $$ SELECT public.invoke_catalog_import('import-seven-eleven-catalog') $$
);

SELECT cron.schedule(
  'catalog-import-familymart',
  '15 3 * * *',
  $$ SELECT public.invoke_catalog_import('import-familymart-catalog') $$
);

SELECT cron.schedule(
  'catalog-import-lawson',
  '30 3 * * *',
  $$ SELECT public.invoke_catalog_import('import-lawson-catalog') $$
);

SELECT cron.schedule(
  'catalog-import-natural-lawson',
  '45 3 * * *',
  $$ SELECT public.invoke_catalog_import('import-natural-lawson-catalog') $$
);

SELECT cron.schedule(
  'catalog-import-ministop',
  '0 4 * * *',
  $$ SELECT public.invoke_catalog_import('import-ministop-catalog') $$
);
