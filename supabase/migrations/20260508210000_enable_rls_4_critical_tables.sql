-- ================================================================
-- Migration: enable_rls_4_critical_tables
-- Supabase advisory rls_disabled (critical) 対応
--
-- 対象テーブル:
--   1. public.moderation_flags  — 違反コンテンツ flag
--   2. public.organizations     — 組織マスタ
--   3. public.sport_presets     — スポーツプリセット定義（読取専用マスタ）
--   4. public.experiment_assignments — A/Bテスト割当
--
-- 注意: migration の apply は人間レビュー後 MCP で行う（自動 apply 禁止）
-- ================================================================

-- ================================================================
-- 1. moderation_flags
--    アクセスパターン:
--      - account/delete route でのみ service_role 経由で操作
--      - 一般ユーザーからの直接アクセスなし
--      - admin / super_admin が管理 UI から閲覧・操作する想定
-- ================================================================

ALTER TABLE moderation_flags ENABLE ROW LEVEL SECURITY;

-- admin / super_admin のみ全操作可
DROP POLICY IF EXISTS "moderation_flags_admin_all" ON moderation_flags;
CREATE POLICY "moderation_flags_admin_all" ON moderation_flags
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['admin', 'super_admin']::TEXT[] && roles
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['admin', 'super_admin']::TEXT[] && roles
    )
  );

-- service_role は RLS をバイパスするため個別ポリシー不要
-- （auth.role() = 'service_role' は Supabase Auth v2 では service_role key 使用時に自動バイパス）

-- ================================================================
-- 2. organizations
--    アクセスパターン:
--      - (org)/layout.tsx: クライアントサイドから認証ユーザーが
--        user_profiles の join 経由で自組織名を読む
--        → SELECT: org_admin ロールを持ち organization_id が一致するユーザー
--      - super-admin API 等から service_role 経由で全件操作
--      - admin / super_admin は全件 SELECT / 書き込み可
--
--    注意: schema_org.sql の既存 policy "Org admins can view own organization" は
--      `user_profiles.roles ? 'org_admin'` (JSONB 演算子) を使用しているが、
--      roles は TEXT[] 型のため `'org_admin' = ANY(roles)` に修正する。
--      既存 policy が prod に適用済みの場合 DROP IF EXISTS で置き換える。
-- ================================================================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- 既存 policy（schema_org.sql から手動適用された可能性あり）を DROP して冪等化
DROP POLICY IF EXISTS "Org admins can view own organization" ON organizations;
DROP POLICY IF EXISTS "organizations_select_org_admin" ON organizations;
DROP POLICY IF EXISTS "organizations_select_admin" ON organizations;
DROP POLICY IF EXISTS "organizations_mutate_admin" ON organizations;

-- org_admin は自分の組織のみ SELECT
CREATE POLICY "organizations_select_org_admin" ON organizations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND 'org_admin' = ANY(roles)
        AND organization_id = organizations.id
    )
  );

-- admin / super_admin は全件 SELECT
CREATE POLICY "organizations_select_admin" ON organizations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['admin', 'super_admin']::TEXT[] && roles
    )
  );

-- admin / super_admin のみ INSERT / UPDATE / DELETE
CREATE POLICY "organizations_mutate_admin" ON organizations
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['admin', 'super_admin']::TEXT[] && roles
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['admin', 'super_admin']::TEXT[] && roles
    )
  );

-- ================================================================
-- 3. sport_presets
--    アクセスパターン:
--      - 93 行の読取専用マスタデータ
--      - 認証ユーザーが performance_profile 設定時に SELECT
--      - 書き込みは seed 時のみ (service_role)
--
--    注意: 20260430160000_db_audit_fixes.sql (#219) に同一内容が記述済み。
--      advisory が prod で未適用であることを示しているため、
--      DROP IF EXISTS + CREATE で冪等に再設定する。
-- ================================================================

ALTER TABLE sport_presets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "all can read sport_presets" ON sport_presets;
DROP POLICY IF EXISTS "service_role can write sport_presets" ON sport_presets;
DROP POLICY IF EXISTS "sport_presets_select_authenticated" ON sport_presets;
DROP POLICY IF EXISTS "sport_presets_mutate_super_admin" ON sport_presets;

-- 全認証ユーザー + 匿名が SELECT 可（マスタデータ）
CREATE POLICY "sport_presets_select_all" ON sport_presets
  FOR SELECT
  USING (true);

-- super_admin のみ書き込み可（seed / メンテナンス）
CREATE POLICY "sport_presets_mutate_super_admin" ON sport_presets
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND 'super_admin' = ANY(roles)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND 'super_admin' = ANY(roles)
    )
  );

-- ================================================================
-- 4. experiment_assignments
--    アクセスパターン:
--      - /api/super-admin/experiments/[id]/results : super_admin が SELECT
--      - /api/super-admin/experiments/[id] DELETE  : super_admin が DELETE
--      - 上記 2 エンドポイントは requireRole(['super_admin']) 必須
--      - 一般ユーザーからの直接アクセスは現状なし（将来的に自分の割当参照の可能性あり）
--      - INSERT は A/Bテスト割当処理（service_role 経由）が行う
-- ================================================================

ALTER TABLE experiment_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "experiment_assignments_select_super_admin" ON experiment_assignments;
DROP POLICY IF EXISTS "experiment_assignments_delete_super_admin" ON experiment_assignments;

-- super_admin は全件 SELECT / DELETE
CREATE POLICY "experiment_assignments_select_super_admin" ON experiment_assignments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND 'super_admin' = ANY(roles)
    )
  );

CREATE POLICY "experiment_assignments_delete_super_admin" ON experiment_assignments
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND 'super_admin' = ANY(roles)
    )
  );

-- INSERT は service_role 経由（RLS バイパス）のみ想定
-- 将来的にユーザーが自分の割当を参照する機能を追加する場合は下記を有効化:
-- CREATE POLICY "experiment_assignments_select_own" ON experiment_assignments
--   FOR SELECT
--   USING (auth.uid() = user_id);
