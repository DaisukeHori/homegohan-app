-- migration: 20260710210014_organizations_update_admin_owner_id_guard.sql
-- Issue #1014 [Crit][security]: organizations_update_admin に WITH CHECK が無く、
-- owner/admin が UPDATE 経由で owner_id を書き換えられる。
-- admin が owner_id を自分に書き換え → organizations_delete_owner
-- (owner_id = auth.uid() のみ判定) を悪用して組織を無断削除できてしまう
-- (propose_org_owner_transfer / accept_org_owner_transfer の2段階承認・監査を迂回)。
--
-- 修正: organizations_update_admin に WITH CHECK を追加し、UPDATE 前後で
-- owner_id が不変であることを強制する。owner_id の正規の変更経路は
-- accept_org_owner_transfer / operator_force_owner_transfer 等の
-- SECURITY DEFINER RPC のみ(これらは postgres ロールで実行され RLS をバイパスするため
-- 本 WITH CHECK の影響を受けない)。
--
-- NULL 安全のため `=` ではなく IS NOT DISTINCT FROM で比較する
-- (owner_id は NOT NULL 制約が無く、既存データに NULL の可能性があるため
--  `=` だと NULL 同士の比較が NULL 評価になり通常更新まで全滅する事故を防ぐ)。
--
-- ★ 実装上の注意 (ローカル PG16 実測で確定): WITH CHECK 内で直接
--   `(SELECT owner_id FROM organizations WHERE id = organizations.id)` と
--   自テーブルを再帰的に SELECT すると、そのサブクエリにも RLS が適用され、
--   `infinite recursion detected in policy for relation "organizations"` で
--   UPDATE 自体が失敗する(admin の正規更新も含め全滅)。
--   これを避けるため、旧 owner_id 取得を SECURITY DEFINER 関数に切り出し、
--   関数内部の SELECT は RLS をバイパスさせる(postgres 所有・table owner は
--   RLS の対象外のため recursion しない)。

CREATE OR REPLACE FUNCTION public.organizations_owner_id_unchanged(p_org_id UUID, p_new_owner_id UUID)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_new_owner_id IS NOT DISTINCT FROM (
    SELECT o.owner_id FROM organizations o WHERE o.id = p_org_id
  );
$$;
REVOKE ALL ON FUNCTION public.organizations_owner_id_unchanged(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organizations_owner_id_unchanged(UUID, UUID) TO authenticated;

DROP POLICY IF EXISTS organizations_update_admin ON organizations;
CREATE POLICY organizations_update_admin ON organizations
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organizations.id
        AND up.org_role IN ('owner','admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organizations.id
        AND up.org_role IN ('owner','admin')
    )
    AND public.organizations_owner_id_unchanged(organizations.id, organizations.owner_id)
  );
