-- migration: 20261017080000_operator_mfa_end_sessions.sql
-- 運営ロールの MFA (二段階認証): 別の super_admin による解除 (段 C) が、対象の全セッションを終えるための関数
-- (#1707・#1176。docs/design/cross/12-operator-mfa.md §11.5・§14.7)
--
-- GoTrue の管理 API (/auth/v1/admin/*) には「利用者 ID で全セッションを終える」経路が無い (2026-10-16 の supabase/auth の api.go の実読。
-- admin.signOut(jwt, scope) は対象の JWT が要る)。本人の /logout?scope=global の実体は models.Logout = DELETE FROM auth.sessions WHERE user_id = ?
-- の 1 文なので、同じ 1 文を service_role だけが呼べる SECURITY DEFINER の関数にする。auth.refresh_tokens と auth.mfa_amr_claims は
-- session_id の外部キー (ON DELETE CASCADE) で一緒に消える。行の無い session_id の JWT は GoTrue が session_not_found で断る (getUser / refresh が失敗)。
-- auth.sessions の所有者は supabase_auth_admin。postgres (この関数の所有者) は DELETE でき、service_role と authenticated は直接は触れない
-- (2026-10-16 の本番の has_table_privilege)。
-- cross/16 (#1720) の AFTER DELETE のトリガー on_auth_session_deleted が入っていれば、消した行ごとに user_sessions_metadata の revoked_at と
-- ended_reason = 'signed_out' を刻む (本関数は ended_reason を書かない。GoTrue のログアウトと同じ扱い)。
-- 誰を終えてよいかの判定 (super_admin・自分でない・対象の存在) は route が済ませる。関数は判定を持たない。
-- 冪等: CREATE OR REPLACE / REVOKE / GRANT は何度流しても同じ。
-- 確かめるテスト: tests/operator-mfa-end-sessions-migration-contract.test.ts (文面)・tests/integration/security/operator-mfa.test.ts の M-5・M-15・M-16 (実 DB)・
--   tests/integration/security/anon-definer-execute.test.ts (EXECUTE の権限)
-- ロールバック: supabase/rollbacks/20261017080000_operator_mfa_end_sessions.down.sql

CREATE OR REPLACE FUNCTION public.operator_mfa_end_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'operator_mfa_end_sessions: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  -- GoTrue の /logout?scope=global (models.Logout) と同じ 1 文。refresh_tokens・mfa_amr_claims は外部キーの ON DELETE CASCADE で消える
  DELETE FROM auth.sessions s WHERE s.user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_mfa_end_sessions(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.operator_mfa_end_sessions(uuid) TO service_role;

COMMENT ON FUNCTION public.operator_mfa_end_sessions(uuid) IS
  '運営ロールの MFA の解除 (別の super_admin による) が、対象の全セッション (auth.sessions の user_id の行) を消す。消した行数を返す。service_role 専用。docs/design/cross/12-operator-mfa.md §11.5';
