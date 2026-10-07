-- migration: 20261007062143_codify_membership_audit_select_admin.sql
-- 本番ドリフト D-13 (docs/operations/rls-drift-20261006.md / #1243) の解消:
--   membership_audit "membership_audit_select_admin" を本番の定義 (組織スコープだけ) で明文化する
--
-- 背景:
--   20260511000104_membership_audit.sql は、組織スコープ (その組織の owner / admin) に加えて
--   家族スコープ (active な representative / adult) の行も読める定義だった。
--   2026-10-06 の本番スナップショットでは、本番の定義は組織スコープだけだった。
--   2026-10-07 のオーナー判断で、本番どおり組織スコープだけとする (家族向けの画面を作るときに広げる)。
--   なお 000104 の家族スコープの条件は family_members を参照しており、family_members の SELECT ポリシーが
--   自分自身を参照しているため、そのまま適用すると membership_audit の SELECT が全員 42P17
--   (infinite recursion detected in policy for relation "family_members") になる (ローカルで確認)。
--
-- 変更:
--   membership_audit_select_admin を、本番と同じ定義で作り直す。本番での挙動は変わらない。
--   membership_audit_select_operator (super_admin) と membership_audit_select_self (操作者・対象者本人) は
--   本番と migration (20260511000131 など) で一致しており、変更しない。
--   tests/integration/rls/membership-audit-select.test.ts (9 件) が、本番の定義のままでも
--   この migration の後でも同じ結果になることを確かめている。
--
-- 冪等: DROP POLICY IF EXISTS + CREATE POLICY。
-- ロールバック: supabase/rollbacks/20261007062143_codify_membership_audit_select_admin.down.sql

DROP POLICY IF EXISTS membership_audit_select_admin ON public.membership_audit;
CREATE POLICY membership_audit_select_admin ON public.membership_audit
  FOR SELECT USING (
    scope = 'organization'
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.organization_id = membership_audit.scope_id
        AND user_profiles.org_role IN ('owner', 'admin')
    )
  );
