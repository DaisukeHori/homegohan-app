-- rollback: 20261007094000_revoke_is_inactive_user_from_authenticated
-- is_inactive_user(uuid) の EXECUTE 権限を、本番の現行 (2026-10-06 のスナップショット supabase/baseline/prod_function_acl.sql) に戻す。
--   PUBLIC・anon: なし / authenticated: EXECUTE / service_role: EXECUTE
-- 注意: 戻すと、ログインユーザーが任意 UUID の実在・休眠を調べられる状態 (#1239) に戻る。

DO $$
BEGIN
  IF to_regprocedure('public.is_inactive_user(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.is_inactive_user(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.is_inactive_user(uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.is_inactive_user(uuid) TO service_role;
  END IF;
END $$;
