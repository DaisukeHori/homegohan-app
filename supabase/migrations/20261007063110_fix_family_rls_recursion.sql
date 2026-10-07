-- migration: 20261007063110_fix_family_rls_recursion.sql
-- Issue #1257: family_members の SELECT ポリシーの自己参照による無限再帰 (42P17) を直す
--
-- 背景:
--   20260511000114_membership_family_rls.sql の family_members_select_self_or_family /
--   family_members_update_self_or_adult は、条件の中で family_members 自身を参照していた。
--   ポリシー内の副問い合わせにも RLS が掛かるため、ログインユーザーのセッションで family_members を読むと
--   `42P17 infinite recursion detected in policy for relation "family_members"` になる。
--   family_groups / family_invites のポリシーも family_members を参照するため、同じエラーになる。
--   家族の画面 (src/app/(main)/family/**) はこれらをブラウザから直接読んでいる。
--
-- 変更:
--   同じテーブルの参照を SECURITY DEFINER のヘルパー関数に移し、7 本のポリシーをその関数で書き直す
--   (Supabase のトラブルシューティング「RLS policy causes infinite recursion」の推奨どおり)。
--   関数の所有者 (postgres) は BYPASSRLS を持ち、対象テーブルは FORCE ROW LEVEL SECURITY ではないため、
--   関数内の family_members の読み込みには RLS が掛からず、再帰しない。
--   関数が返すのは「ログイン中のユーザー本人が、その家族の active なメンバー (または代表者・大人) か」だけ。
--
--   ポリシーの意味 (誰が何をできるか) は変えない。名前・コマンドも同じ。
--   対象ロールは TO authenticated にする (anon は auth.uid() が NULL でどの条件にも一致しないため、
--   結果は同じ。ヘルパー関数の EXECUTE を anon に与えずに済む)。
--
--   対象ポリシー:
--     family_members  family_members_select_self_or_family  SELECT
--     family_members  family_members_update_self_or_adult   UPDATE
--     family_groups   family_groups_select_member           SELECT
--     family_groups   family_groups_update_adult            UPDATE
--     family_invites  family_invites_select_adult           SELECT
--     family_invites  family_invites_insert_adult           INSERT
--     family_invites  family_invites_update_adult           UPDATE
--   family_groups_delete_representative (representative_id = auth.uid()) は family_members を参照しないため変更しない。
--
-- 本番との関係 (docs/operations/rls-drift-20261006.md): 対象 7 本は本番と migration (20260511000114) で定義が一致し、
--   対象テーブルに本番にしか無いポリシーも無い。
-- 冪等: CREATE OR REPLACE FUNCTION + DROP POLICY IF EXISTS + CREATE POLICY。
-- ロールバック: supabase/rollbacks/20261007063110_fix_family_rls_recursion.down.sql

-- ---------------------------------------------------------------
-- ヘルパー関数
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_active_family_member(p_family_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = p_family_id
      AND fm.user_id = auth.uid()
      AND fm.status = 'active'
  );
$$;

COMMENT ON FUNCTION public.is_active_family_member(uuid) IS
  'RLS 用: ログイン中のユーザーが、その家族の active なメンバーか。family_members のポリシーの自己参照による無限再帰を避けるため SECURITY DEFINER (#1257)。';

CREATE OR REPLACE FUNCTION public.is_active_family_adult(p_family_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = p_family_id
      AND fm.user_id = auth.uid()
      AND fm.role IN ('representative', 'adult')
      AND fm.status = 'active'
  );
$$;

COMMENT ON FUNCTION public.is_active_family_adult(uuid) IS
  'RLS 用: ログイン中のユーザーが、その家族の active な代表者・大人か。family_members のポリシーの自己参照による無限再帰を避けるため SECURITY DEFINER (#1257)。';

REVOKE ALL ON FUNCTION public.is_active_family_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_active_family_adult(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_family_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_family_adult(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- family_members
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS family_members_select_self_or_family ON public.family_members;
CREATE POLICY family_members_select_self_or_family ON public.family_members
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_active_family_member(family_id)
  );

DROP POLICY IF EXISTS family_members_update_self_or_adult ON public.family_members;
CREATE POLICY family_members_update_self_or_adult ON public.family_members
  FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()  -- 自身の share_* / display_name 等の更新
    OR public.is_active_family_adult(family_id)
  );

-- ---------------------------------------------------------------
-- family_groups
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS family_groups_select_member ON public.family_groups;
CREATE POLICY family_groups_select_member ON public.family_groups
  FOR SELECT
  TO authenticated
  USING (public.is_active_family_member(id));

DROP POLICY IF EXISTS family_groups_update_adult ON public.family_groups;
CREATE POLICY family_groups_update_adult ON public.family_groups
  FOR UPDATE
  TO authenticated
  USING (public.is_active_family_adult(id));

-- ---------------------------------------------------------------
-- family_invites
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS family_invites_select_adult ON public.family_invites;
CREATE POLICY family_invites_select_adult ON public.family_invites
  FOR SELECT
  TO authenticated
  USING (public.is_active_family_adult(family_id));

DROP POLICY IF EXISTS family_invites_insert_adult ON public.family_invites;
CREATE POLICY family_invites_insert_adult ON public.family_invites
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_active_family_adult(family_id));

DROP POLICY IF EXISTS family_invites_update_adult ON public.family_invites;
CREATE POLICY family_invites_update_adult ON public.family_invites
  FOR UPDATE
  TO authenticated
  USING (public.is_active_family_adult(family_id));
