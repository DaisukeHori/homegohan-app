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
-- NULL 安全のため `=` ではなく IS NOT DISTINCT FROM で比較する。
-- (注: owner_id は 20260511000100_membership_org_extensions.sql で既に
--  `ALTER COLUMN owner_id SET NOT NULL` 済みであり、既存データに NULL は
--  存在しない。それでも `=` ではなく IS NOT DISTINCT FROM を使うのは、
--  p_org_id に対応する行が万一存在しない等のエッジケースでサブクエリが NULL を
--  返した場合に `=` だと NULL 評価(=WITH CHECK 全体が NULL→ポリシー的には拒否だが
--  意図が読み取りづらい)になるのを避け、常に明示的な boolean を返して
--  fail-closed の意図を読みやすくするための防御的記述)。
--
-- ★ 実装上の注意 (ローカル PG16 実測で確定): WITH CHECK 内で直接
--   `(SELECT owner_id FROM organizations WHERE id = organizations.id)` と
--   自テーブルを再帰的に SELECT すると、そのサブクエリにも RLS が適用され、
--   `infinite recursion detected in policy for relation "organizations"` で
--   UPDATE 自体が失敗する(admin の正規更新も含め全滅)。
--   これを避けるため、旧 owner_id 取得を SECURITY DEFINER 関数に切り出し、
--   関数内部の SELECT は RLS をバイパスさせる(postgres 所有・table owner は
--   RLS の対象外のため recursion しない)。
--
-- ★ round-2 修正 (Sonnet レビューで検出): この関数は public スキーマ + authenticated
--   への GRANT EXECUTE により PostgREST 経由 (POST /rest/v1/rpc/...) で誰でも直接
--   呼び出せてしまう。SECURITY DEFINER で RLS をバイパスするため、呼び出し元の
--   org メンバーシップを関数内で確認しないと「(org_id, 推測 owner_id) が正しい
--   組み合わせか」を返す oracle になり、organizations_select_member の非公開境界を
--   迂回した情報漏洩になる。そのため呼び出し元 (auth.uid()) が p_org_id の
--   owner/admin メンバーであることを関数内でも確認し、非メンバーには常に false を
--   返す(ポリシー本体の USING/WITH CHECK 側で既に同じ判定をしているため、
--   正規のポリシー経由の呼び出しには影響しない)。
--
-- なお本 Issue (#1014: admin による owner_id 書換え → 組織無断削除) 自体は、
-- 本 migration のベースブランチに既に存在する 20260511000136_rls_guard_privileged_columns.sql
-- の `trg_guard_organizations_privileged` (BEFORE UPDATE トリガー, #1013/#1014/#1015 対象)
-- で独立に修正済みであることをローカル検証で確認している。本 WITH CHECK は
-- そのトリガーとは独立の多層防御(RLS 層単体でも同じ攻撃を防ぐ)として追加する。

CREATE OR REPLACE FUNCTION public.organizations_owner_id_unchanged(p_org_id UUID, p_new_owner_id UUID)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = p_org_id
        AND up.org_role IN ('owner','admin')
    )
    THEN p_new_owner_id IS NOT DISTINCT FROM (
      SELECT o.owner_id FROM organizations o WHERE o.id = p_org_id
    )
    ELSE false
  END;
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
