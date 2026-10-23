-- migration: 20261023110000_admin_set_user_roles_previous_roles.sql
-- 戻し方: supabase/rollbacks/20261023110000_admin_set_user_roles_previous_roles.down.sql
-- #1917 の続き: 利用者のロールの変更 (PATCH / PUT /api/admin/users/{id}/role) の監査 admin.user.role_change の
-- details.previous_roles が、同時の変更で実際の直前の値と食い違いうる既存の欠陥を直す。
--
-- 背景:
--   route (src/app/api/admin/users/[id]/role/route.ts) は、ロックを取らずに user_profiles.roles を読み、そのあとで
--   admin_set_user_roles を呼び、読んだ値を previous_roles として監査に残していた。最新の定義
--   (20261017130000_operator_mfa_db_gate.sql) は直前の roles を読まずに UPDATE し、変える前の値を返さない。
--   super_admin 2 人がほぼ同時に同じ利用者のロールを変えると、後の UPDATE の直前の値は先の UPDATE の値なのに、
--   後の監査には route が先に読んだ古い値が残る (権限の結果は後勝ちで正しい。食い違うのは監査の記録だけ)。
--
-- 変更:
--   admin_set_user_roles の戻り値に、変える前の roles (previous_roles) を足す。関数の中で対象の行を
--   FOR NO KEY UPDATE でロックしてから roles を読み、同じ行を UPDATE する。同時の変更は行のロックで並び、
--   後から来た呼び出しはロックの後に (先の変更が commit した後の) 値を読むので、previous_roles は常に
--   その UPDATE の直前の値になる。route はこの値を監査に残す。
--   - ロックの強さは FOR NO KEY UPDATE (UPDATE が roles (キーでない列) を書くときに取るロックと同じ)。
--     FOR UPDATE にすると、user_profiles を参照する外部キーの確認 (FOR KEY SHARE) と待ち合う (CLAUDE.md のロック順の節と同じ理由)。
--     この関数がロックするのは対象の user_profiles の 1 行だけで、ほかの行・表をロックしないので、ロックの順は変わらない
--     (元の定義の UPDATE も同じ行に同じロックを取っていた。取る時刻が UPDATE の手前に早まるだけ)。
--   - 行が無いときの USER_NOT_FOUND は、ロックの読み取りの NOT FOUND で判定する (元の NOT EXISTS の判定と同じ条件・同じエラー)。
--   - 役割の判定 (FORBIDDEN)・MFA の判定 (OPERATOR_MFA_REQUIRED)・自分の id の判定 (CANNOT_MODIFY_OWN_ROLES) とその順は変えない。
--     どれも対象の行のロックより前で、判定で止まると何もロックしない。
--   - 戻り値の型 (RETURNS TABLE の列) が変わるので、CREATE OR REPLACE ではなく DROP してから作る。DROP で権限が消えるので、
--     本番の権限 (supabase/baseline/prod_function_acl.sql:22-24: PUBLIC / anon から外し、authenticated と service_role に EXECUTE) を付け直す。
--     関数の所有者は migration を流すロール (postgres) になる (ベースラインの ALTER FUNCTION ... OWNER TO "postgres" と同じ)。
--   - 呼ぶのは route の 1 か所だけ (src の .rpc('admin_set_user_roles' は 1 件)。元の route は戻り値を読まないので、
--     この migration を先に当てても今のアプリは動く。
-- 冪等: DROP FUNCTION IF EXISTS → CREATE OR REPLACE → REVOKE / GRANT は何度流しても同じ。既存のデータを書き換える文は無い。
-- 確かめるテスト: tests/admin-set-user-roles-previous-roles-migration-contract.test.ts (文面)・
--   tests/integration/security/admin-set-user-roles-previous-roles.test.ts (実 DB)・
--   tests/admin-user-role-previous-roles-route.test.ts (route が戻り値の previous_roles を監査に残す)

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.admin_set_user_roles(uuid, text[]);

CREATE OR REPLACE FUNCTION "public"."admin_set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) RETURNS TABLE("id" "uuid", "roles" "text"[], "previous_roles" "text"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_new_roles TEXT[];
  v_previous_roles TEXT[];
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

  -- #1917: 対象の行をロックしてから変える前の roles を読む (同時の変更はここで並び、後の呼び出しは先の変更の後の値を読む)
  SELECT up.roles INTO v_previous_roles FROM user_profiles up WHERE up.id = p_user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_new_roles := COALESCE(p_roles, ARRAY[]::TEXT[]);

  UPDATE user_profiles up SET roles = v_new_roles WHERE up.id = p_user_id;

  RETURN QUERY SELECT p_user_id, v_new_roles, v_previous_roles;
END $$;

REVOKE ALL ON FUNCTION public.admin_set_user_roles(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_user_roles(uuid, text[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_set_user_roles(uuid, text[]) IS
  '利用者のロールを置き換える (super_admin だけ・自分は不可)。戻り値は id・新しい roles・変える前の roles (previous_roles。対象の行を FOR NO KEY UPDATE でロックして読んだ値で、同時の変更があってもこの UPDATE の直前の値)。#1917';
