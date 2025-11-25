-- Organizations テーブル
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  plan TEXT DEFAULT 'standard', -- standard, premium, enterprise
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User Profiles に組織IDを追加
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

-- 既存の role チェック制約があれば更新が必要だが、今回はTEXT型なのでそのまま 'org_admin' を使用可能
-- role の想定: 'user', 'admin', 'org_admin'

-- RLS Policies for Organizations

-- 1. 法人管理者は自分の組織のデータを参照できる
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org admins can view own organization" ON organizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'org_admin'
      AND user_profiles.organization_id = organizations.id
    )
  );

-- RLS Policies for User Profiles (Member visibility)

-- 2. 法人管理者は同じ組織のメンバーのプロファイルを参照できる
CREATE POLICY "Org admins can view org members" ON user_profiles
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles AS viewer
      WHERE viewer.id = auth.uid()
      AND viewer.role = 'org_admin'
      AND viewer.organization_id = user_profiles.organization_id
    )
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_profiles_org_id ON user_profiles(organization_id);

