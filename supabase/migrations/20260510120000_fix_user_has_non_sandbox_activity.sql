-- user_has_non_sandbox_activity を引数なし + SECURITY INVOKER + authenticated GRANT に書き換え
-- 旧シグネチャ (uuid 引数版) は drop して新シグネチャに置き換え

DROP FUNCTION IF EXISTS user_has_non_sandbox_activity(uuid);

CREATE OR REPLACE FUNCTION user_has_non_sandbox_activity()
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM meals WHERE user_id = auth.uid() AND is_sandbox = false LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM user_daily_meals WHERE user_id = auth.uid() AND is_sandbox = false LIMIT 1
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION user_has_non_sandbox_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_has_non_sandbox_activity() TO authenticated;
GRANT EXECUTE ON FUNCTION user_has_non_sandbox_activity() TO service_role;

COMMENT ON FUNCTION user_has_non_sandbox_activity() IS
  '自分のユーザーが non-sandbox の meal/user_daily_meal を持っているか判定。auth.uid() を内部で使うため引数無し、他人の情報漏洩なし。';
