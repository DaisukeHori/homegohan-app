-- rollback: 20261023110000_admin_set_user_roles_previous_roles.sql
-- #1917 で戻り値に previous_roles を足した admin_set_user_roles を、本冊の直前の定義 (20261017130000_operator_mfa_db_gate.sql の
-- admin_set_user_roles。戻り値は id・roles の 2 列で、対象の行をロックせずに NOT EXISTS で存在を確かめてから UPDATE する) に戻す。
-- 本文は 20261017130000_operator_mfa_db_gate.sql の定義の逐語 (MFA の判定の 4 行を含む)。権限は本番と同じ
-- (supabase/baseline/prod_function_acl.sql:22-24: PUBLIC / anon から外し、authenticated と service_role に EXECUTE)。
-- (tests/admin-set-user-roles-previous-roles-migration-contract.test.ts が、本文が 20261017130000 の定義と同じこと・権限を見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと戻り値に previous_roles が無くなる。route (src/app/api/admin/users/[id]/role/route.ts) は戻り値に previous_roles が
--     無いと、先に読んだ roles を監査に残す (#1917 の前の動き。同時の変更で直前の値と食い違いうる)。ロールの変更そのものは動く。
--
-- 何度流しても同じ結果になる (冪等: DROP FUNCTION IF EXISTS → CREATE OR REPLACE → REVOKE / GRANT)。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.admin_set_user_roles(uuid, text[]);

CREATE OR REPLACE FUNCTION "public"."admin_set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) RETURNS TABLE("id" "uuid", "roles" "text"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_new_roles TEXT[];
BEGIN
  SELECT up.roles INTO v_caller_roles FROM user_profiles up WHERE up.id = auth.uid();
  IF v_caller_roles IS NULL OR NOT (v_caller_roles && ARRAY['super_admin']) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  -- #1176 (docs/design/cross/12-operator-mfa.md §11.4): TOTP を登録済みの必須ロールの呼び出し元は、aal2 のセッションでなければ止める
  IF NOT public.operator_mfa_satisfied() THEN
    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_OWN_ROLES' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_new_roles := COALESCE(p_roles, ARRAY[]::TEXT[]);

  UPDATE user_profiles up SET roles = v_new_roles WHERE up.id = p_user_id;

  RETURN QUERY SELECT p_user_id, v_new_roles;
END $$;

REVOKE ALL ON FUNCTION public.admin_set_user_roles(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_user_roles(uuid, text[]) TO authenticated, service_role;
