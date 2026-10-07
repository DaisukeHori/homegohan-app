-- migration: 20261007022126_org_role_tenant_scoped_org_admin.sql
-- Issue #1235 (第1段): 組織テーブルの管理者判定を org_role に一本化する
--
-- 背景:
--   組織のメンバーシップは 2026-05-11 に user_profiles.org_role (owner / admin / member) へ移行したが、
--   組織テーブル 5 つの管理用ポリシーは旧 roles 配列の 'org_admin' で管理者を判定したままだった。
--   'org_admin' はどの組織で付与されたかを区別せず、remove_org_member / leave_org でも消えないため、
--   別組織で管理者だったユーザーが無関係な組織に一般メンバーとして加入しただけで、
--   その組織の部署・チャレンジ・招待 (admin 招待の発行を含む)・レポート・統計を操作できた。
--   このユーザーが発行した admin 招待を共犯 (または自分の別アカウント) で承諾すると、
--   accept_org_invite が org_role = invited_role を設定するため、正規の org_role = admin にもなれた。
--
-- 変更:
--   組織の管理者 = 同じ組織に所属し、org_role が owner / admin のユーザー。
--   roles の 'org_admin' は組織の管理者判定に使わない (アプリ側 src/lib/auth/org-admin.ts と同じ判定)。
--   運営のグローバルロール (roles の admin / super_admin) が自組織のテーブルを操作できる点は
--   本番の現状どおり残す (扱いは第2段で決める)。
--
--   対象ポリシー (名前・コマンド・対象ロールは本番と同じ。条件だけを差し替える):
--     departments             "Org admins can manage departments"  ALL
--     organization_challenges "Org admins can manage challenges"   ALL
--     organization_invites    "Org admins can manage invites"      ALL (招待の取り消し DELETE はこのポリシーだけが許可する)
--     organization_reports    "Org admins can manage reports"      ALL
--     org_daily_stats         "Org admins can view own stats"      SELECT
--   あわせて admin_audit_logs の "Admins can create audit logs" (INSERT) から 'org_admin' を外す
--   (組織の管理者が運営の監査ログを書き込めていた。他の許可ロールは本番どおり)。
--
-- 本番との関係 (docs/operations/rls-drift-20261006.md): 対象 6 ポリシーは本番と migration
-- (20260511000137) で定義が一致し、本番にしか無い追加ポリシーも無い。
-- 冪等: DROP POLICY IF EXISTS + CREATE POLICY。
-- ロールバック: supabase/rollbacks/20261007022126_org_role_tenant_scoped_org_admin.down.sql

-- ---------------------------------------------------------------
-- 組織テーブル 5 つ
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Org admins can manage departments" ON public.departments;
CREATE POLICY "Org admins can manage departments" ON public.departments
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = departments.organization_id
        AND (
          up.org_role IN ('owner', 'admin')
          OR up.roles && ARRAY['admin', 'super_admin']::TEXT[]
        )
    )
  );

DROP POLICY IF EXISTS "Org admins can manage challenges" ON public.organization_challenges;
CREATE POLICY "Org admins can manage challenges" ON public.organization_challenges
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_challenges.organization_id
        AND (
          up.org_role IN ('owner', 'admin')
          OR up.roles && ARRAY['admin', 'super_admin']::TEXT[]
        )
    )
  );

DROP POLICY IF EXISTS "Org admins can manage invites" ON public.organization_invites;
CREATE POLICY "Org admins can manage invites" ON public.organization_invites
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_invites.organization_id
        AND (
          up.org_role IN ('owner', 'admin')
          OR up.roles && ARRAY['admin', 'super_admin']::TEXT[]
        )
    )
  );

DROP POLICY IF EXISTS "Org admins can manage reports" ON public.organization_reports;
CREATE POLICY "Org admins can manage reports" ON public.organization_reports
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_reports.organization_id
        AND (
          up.org_role IN ('owner', 'admin')
          OR up.roles && ARRAY['admin', 'super_admin']::TEXT[]
        )
    )
  );

DROP POLICY IF EXISTS "Org admins can view own stats" ON public.org_daily_stats;
CREATE POLICY "Org admins can view own stats" ON public.org_daily_stats
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = org_daily_stats.organization_id
        AND (
          up.org_role IN ('owner', 'admin')
          OR up.roles && ARRAY['admin', 'super_admin']::TEXT[]
        )
    )
  );

-- ---------------------------------------------------------------
-- admin_audit_logs: 'org_admin' を許可ロールから外す
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can create audit logs" ON public.admin_audit_logs;
CREATE POLICY "Admins can create audit logs" ON public.admin_audit_logs
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.roles && ARRAY['admin', 'super_admin', 'support']::TEXT[]
    )
  );
