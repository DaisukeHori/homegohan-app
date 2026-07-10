-- #1020 [Crit][security] SECURITY DEFINER RPC の REVOKE FROM PUBLIC 漏れ是正
--
-- 背景: Supabase は
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS
--   TO anon, authenticated, service_role;
-- を既定で設定しているため、新規関数は明示的に REVOKE しない限り anon/authenticated から
-- PostgREST 経由で直接叩ける（実 DB dump で invoke_catalog_import / claim_menu_request が
-- anon・authenticated に GRANT ALL 済みであることを確認済み）。
-- 単に `REVOKE ... FROM PUBLIC` するだけでは anon/authenticated 個別の GRANT は残るため、
-- 本 migration では対象ロールを明示的に列挙して REVOKE する。
--
-- 対象:
--   1. invoke_catalog_import  … p_function_name の許可リスト化 + service_role 限定
--   2. claim_menu_request     … service_role 限定 + search_path 是正(F5-09)
--   3. upsert_daily_meal_slot … service_role 限定を明示的に締める(既存 GRANT は維持)
--   4. increment_recipe_view_count … authenticated 限定 + search_path 是正(F5-09)
--   5. increment_recipe_like_count / decrement_recipe_like_count … 現行コードから未使用のため PUBLIC/anon/authenticated を剥奪し再GRANTしない + search_path 是正(F5-09)
--   6. sync_recipe_like_count(trigger) … トリガー専用のため PUBLIC/anon/authenticated を剥奪 + search_path 是正(F5-09)
--
-- 冪等性:
--   1-2 は CREATE OR REPLACE FUNCTION(既存本番に実在確認済み)のため常に安全に再実行可能。
--   3-6 は本番の実スキーマ dump 上に現存が確認できなかったため、CREATE OR REPLACE で新規に
--   作り出すことは行わず、pg_proc 存在チェックで囲った DO ブロックで「存在すれば締める」
--   形にする(存在しない環境では安全な no-op)。REVOKE/GRANT 自体はどの環境でも再実行してエラー0。

-- ────────────────────────────────────────────────────────────
-- 1. invoke_catalog_import: p_function_name を許可リスト化 + search_path 維持 + service_role 限定
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invoke_catalog_import(p_function_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_headers jsonb;
  v_request_id bigint;
  v_secret text;
BEGIN
  -- #1020: p_function_name の無検証 URL 連結による SSRF/confused deputy を防ぐため許可リスト化
  IF p_function_name NOT IN (
    'import-seven-eleven-catalog',
    'import-familymart-catalog',
    'import-lawson-catalog',
    'import-natural-lawson-catalog',
    'import-ministop-catalog'
  ) THEN
    RAISE EXCEPTION 'invoke_catalog_import: function name not allowed: %', p_function_name;
  END IF;

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
$$;

REVOKE EXECUTE ON FUNCTION public.invoke_catalog_import(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_catalog_import(text) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 2. claim_menu_request: search_path 是正(F5-09) + service_role 限定
--    (attempt_count 上限ロジック自体は変更しない)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_menu_request(p_worker_id TEXT)
RETURNS weekly_menu_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

REVOKE EXECUTE ON FUNCTION public.claim_menu_request(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_menu_request(text) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 3〜6. 本番スキーマ dump (scratchpad/verify/prod_public_for_test.sql, phase0/prod_functions.txt)
--       上に現存が確認できなかった関数群。存在する環境(ローカル検証等)でのみ権限を締める。
-- ────────────────────────────────────────────────────────────

-- 3. upsert_daily_meal_slot: service_role 限定を明示的に締める
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'upsert_daily_meal_slot'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.upsert_daily_meal_slot(uuid, date, text, jsonb) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.upsert_daily_meal_slot(uuid, date, text, jsonb) TO service_role';
  END IF;
END $$;

-- 4. increment_recipe_view_count: authenticated 限定 + search_path 是正(F5-09)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'increment_recipe_view_count'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.increment_recipe_view_count(uuid) SET search_path = public';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.increment_recipe_view_count(uuid) FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.increment_recipe_view_count(uuid) TO authenticated';
  END IF;
END $$;

-- 5. increment_recipe_like_count / decrement_recipe_like_count:
--    現行コード(src/app/api/recipes/[id]/like/route.ts)は直接 UPDATE + トリガーに置換済みで
--    この RPC は未使用。anon/authenticated への再公開は不要なため PUBLIC 剥奪のみ行い GRANT しない。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'increment_recipe_like_count'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.increment_recipe_like_count(text, uuid) SET search_path = public';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.increment_recipe_like_count(text, uuid) FROM PUBLIC, anon, authenticated';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'decrement_recipe_like_count'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.decrement_recipe_like_count(text, uuid) SET search_path = public';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.decrement_recipe_like_count(text, uuid) FROM PUBLIC, anon, authenticated';
  END IF;
END $$;

-- 6. sync_recipe_like_count: recipe_likes の AFTER INSERT/DELETE トリガー専用関数。
--    トリガー発火は呼び出しロールの EXECUTE 権限チェック対象外のため、PUBLIC/anon/authenticated
--    から剥奪してもトリガー動作に影響しない。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'sync_recipe_like_count'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.sync_recipe_like_count() SET search_path = public';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.sync_recipe_like_count() FROM PUBLIC, anon, authenticated';
  END IF;
END $$;
